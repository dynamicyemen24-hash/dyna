import { pool } from './neonDb.js';
import { makeId } from './apiHelpers.js';
import { hashPassword } from './passwords.js';
import { resolveIdentityIntent, type IdentityResolutionInput } from './identityEngine.js';

export interface EnrollmentInput {
  tenantName: string;
  tenantCode?: string;
  /**
   * Enroll the owner into this EXISTING tenant instead of minting a new one.
   *
   * WHY: a single-tenant deployment pins every login to one tenant
   * (`DEFAULT_TENANT`). Registering an owner into a fresh random tenant there
   * would create an account login can never find — login searches only the
   * pinned tenant — so the account could be created and be permanently unable
   * to sign in. Passing the pinned tenant here makes the new owner loginnable.
   */
  targetTenantId?: string;
  ownerName: string;
  username: string;
  email?: string;
  phone?: string;
  password?: string;
  branchName?: string;
  deviceFingerprint?: string;
  idempotencyKey?: string;
}

export interface EnrollmentResult {
  state: 'NEW_TENANT' | 'VERIFIED_EXISTING_TENANT' | 'PENDING_VERIFICATION' | 'EXISTING_TENANT_NO_BRANCH' | 'EXISTING_USER_NO_ACCESS' | 'AMBIGUOUS_IDENTITY';
  tenantId?: string;
  userId?: string;
  branchId?: string;
  reason: string;
  proofRequired?: string[];
  confidence?: number;
  idempotencyKey?: string;
}

const normalize = (v?: string) => (v ?? '').trim().toLowerCase().replace(/\s+/g, ' ').normalize('NFKC');

const mapTenantRow = (row: any): import('./identityEngine.js').CanonicalTenantRef => ({
  tenantId: row.id,
  tenantName: row.name,
  normalizedName: normalize(row.name),
  status: row.is_active === false ? 'disabled' : 'active',
  enrollmentCode: row.enrollment_code || row.id,
  branchCount: Number(row.branch_count || 0),
});

const mapUserRow = (row: any): import('./identityEngine.js').CanonicalUserRef => ({
  userId: row.id,
  tenantId: row.tenant_id,
  username: row.username,
  normalizedUsername: normalize(row.username),
  email: row.email || undefined,
  normalizedEmail: normalize(row.email || undefined),
  phone: row.phone || undefined,
  normalizedPhone: normalize(row.phone || undefined),
  status: row.is_active === false ? 'disabled' : (row.locked_until ? 'locked' : 'active'),
});

const mapBranchRow = (row: any): import('./identityEngine.js').CanonicalBranchRef => ({
  branchId: row.id,
  tenantId: row.tenant_id,
  name: row.name,
  normalizedName: normalize(row.name),
  status: row.is_active === false ? 'disabled' : 'active',
});

export async function resolveExistingIdentity(input: Partial<EnrollmentInput>) {
  const tenantName = input.tenantName ?? '';
  const email = input.email ?? '';
  const phone = input.phone ?? '';
  const username = input.username ?? '';
  const branchName = input.branchName ?? '';

  const [tenantRows, userRows, branchRows] = await Promise.all([
    pool.query(`SELECT t.id, t.name, t.is_active, COALESCE((SELECT COUNT(*) FROM dypos.branches b WHERE b.tenant_id = t.id), 0) AS branch_count, t.id AS enrollment_code FROM dypos.tenants t WHERE t.is_active IS NOT FALSE`),
    pool.query(`SELECT id, tenant_id, username, email, phone, is_active, locked_until FROM dypos.users WHERE is_active IS NOT FALSE`),
    pool.query(`SELECT id, tenant_id, name, is_active FROM dypos.branches WHERE is_active IS NOT FALSE`),
  ]);

  const identityInput: IdentityResolutionInput = {
    tenantName,
    tenantCode: input.tenantCode,
    email,
    phone,
    username,
    branchName,
    deviceFingerprint: input.deviceFingerprint,
    existingTenants: tenantRows.rows.map(mapTenantRow),
    existingUsers: userRows.rows.map(mapUserRow),
    existingBranches: branchRows.rows.map(mapBranchRow),
    deviceTrust: [],
  };

  return resolveIdentityIntent(identityInput);
}

export async function enrollTenantSafely(input: EnrollmentInput): Promise<EnrollmentResult> {
  const tenantName = (input.tenantName || '').trim();
  const ownerName = (input.ownerName || '').trim();
  const username = (input.username || '').trim();
  const email = (input.email || '').trim();
  const phone = (input.phone || '').trim();

  if (!tenantName || !ownerName || !username || !input.password) {
    return {
      state: 'AMBIGUOUS_IDENTITY',
      reason: 'Tenant name, owner name, username and password are required before any enrollment attempt.',
      proofRequired: ['tenant_name', 'owner_name', 'username', 'password'],
      confidence: 10,
    };
  }

  const idempotencyKey = input.idempotencyKey || `${normalize(tenantName)}:${normalize(username)}:${normalize(email)}:${normalize(phone)}`;

  const existingIdempotency = await pool.query(
    `SELECT * FROM dypos.identity_idempotency WHERE key = $1`,
    [idempotencyKey],
  );

  if (existingIdempotency.rows[0]) {
    const payload = existingIdempotency.rows[0].result_json || {};
    return {
      state: payload.state,
      tenantId: payload.tenantId,
      userId: payload.userId,
      branchId: payload.branchId,
      reason: payload.reason || 'Existing idempotent enrollment result was restored.',
      proofRequired: payload.proofRequired || [],
      confidence: payload.confidence || 100,
      idempotencyKey,
    };
  }

  // ── PINNED-TENANT ENROLLMENT ──────────────────────────────────────────────
  // When a caller names an existing tenant (the single-tenant deployment pins
  // every login to `DEFAULT_TENANT`), the owner must be created INSIDE that
  // tenant — not in a fresh random one login will never search. Reuse an
  // existing active branch if the tenant has one, otherwise create the default.
  if (input.targetTenantId) {
    const targetTenantId = String(input.targetTenantId).trim();
    const tenantCheck = await pool.query(
      `SELECT id, name FROM dypos.tenants WHERE id = $1 AND is_active IS NOT FALSE`,
      [targetTenantId],
    );
    if (!tenantCheck.rows[0]) {
      return {
        state: 'AMBIGUOUS_IDENTITY',
        reason: 'Tenant not found or inactive.',
        proofRequired: ['valid_target_tenant'],
        confidence: 20,
      };
    }

    const branchRes = await pool.query(
      `SELECT id FROM dypos.branches WHERE tenant_id = $1 AND is_active IS NOT FALSE
         ORDER BY created_at ASC LIMIT 1`,
      [targetTenantId],
    );
    const branchId = branchRes.rows[0]?.id || `branch-${makeId('b').replace(/-/g, '').slice(0, 20)}`;
    const userId = `user-${makeId('u').replace(/-/g, '').slice(0, 20)}`;
    const credential = await hashPassword(input.password as string);

    const client = await pool.connect();
    try {
      await client.query('BEGIN');
      if (!branchRes.rows[0]) {
        await client.query(
          `INSERT INTO dypos.branches (id, tenant_id, name, location, city, phone, is_active, created_at)
           VALUES ($1, $2, COALESCE($3, 'المركز الرئيسي'), 'Head Office', 'الرياض', $4, TRUE, NOW())
           ON CONFLICT (id) DO NOTHING`,
          [branchId, targetTenantId, input.branchName || 'المركز الرئيسي', phone || null],
        );
      }
      await client.query(
        `INSERT INTO dypos.users (
           id, tenant_id, branch_id, username, password_hash, password_salt,
           password_iterations, password_algo, name, role, is_active, created_at
         ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, 'admin', TRUE, NOW())
         ON CONFLICT (id) DO NOTHING`,
        [userId, targetTenantId, branchId, username, credential.hash, credential.salt,
         credential.iterations, credential.algo, ownerName],
      );
      await client.query(
        `INSERT INTO dypos.user_branch_access (user_id, branch_id)
         VALUES ($1, $2)
         ON CONFLICT (user_id, branch_id) DO NOTHING`,
        [userId, branchId],
      );
      await client.query(
        `INSERT INTO dypos.audit_logs (tenant_id, user_id, user_name, action, table_name, record_id, new_data, timestamp)
         VALUES ($1, $2, $3, 'tenant_enroll', 'tenants', $4, $5, NOW())`,
        [targetTenantId, userId, ownerName, targetTenantId, { tenantName, ownerName, username, pinned: true }],
      );
      const result: EnrollmentResult = {
        state: 'VERIFIED_EXISTING_TENANT',
        tenantId: targetTenantId,
        userId,
        branchId,
        reason: 'Owner user created inside the pinned tenant that login searches.',
        proofRequired: ['owner_user', 'branch_access'],
        confidence: 100,
        idempotencyKey,
      };
      await client.query(
        `INSERT INTO dypos.identity_idempotency (key, tenant_id, result_json, created_at)
         VALUES ($1, $2, $3, NOW())
         ON CONFLICT (key) DO NOTHING`,
        [idempotencyKey, targetTenantId, result],
      );
      await client.query('COMMIT');
      return result;
    } catch (error) {
      await client.query('ROLLBACK');
      throw error;
    } finally {
      client.release();
    }
  }

  const existingIdentity = await resolveExistingIdentity(input);
  if (existingIdentity.state !== 'NEW_TENANT') {
    return {
      state: existingIdentity.state,
      tenantId: existingIdentity.tenantId,
      userId: existingIdentity.userId,
      branchId: existingIdentity.branchId,
      reason: existingIdentity.reason,
      proofRequired: existingIdentity.proofRequired,
      confidence: existingIdentity.confidence,
      idempotencyKey,
    };
  }

  const tenantId = `tenant-${makeId('t').replace(/-/g, '').slice(0, 20)}`;
  const branchId = `branch-${makeId('b').replace(/-/g, '').slice(0, 20)}`;
  const userId = `user-${makeId('u').replace(/-/g, '').slice(0, 20)}`;
  const credential = await hashPassword(input.password);

  const client = await pool.connect();
  try {
    await client.query('BEGIN');

    await client.query(
      `INSERT INTO dypos.tenants (id, name, owner_company, brand_name, is_active, metadata, created_at, updated_at)
       VALUES ($1, $2, $3, $4, TRUE, $5, NOW(), NOW())
       ON CONFLICT (id) DO NOTHING`,
      [tenantId, tenantName, ownerName, `${tenantName} - DyPOS`, { enrollmentCode: input.tenantCode || tenantId, source: 'identity-engine' }],
    );

    await client.query(
      `INSERT INTO dypos.subscriptions (id, tenant_id, customer_id, plan_id, status, start_date, end_date, auto_renew, metadata, created_at)
       VALUES ($1, $2, NULL, 'plan-enterprise', 'active', CURRENT_DATE, CURRENT_DATE + INTERVAL '365 days', TRUE, $3, NOW())
       ON CONFLICT DO NOTHING`,
      [`sub-${makeId('s').replace(/-/g, '').slice(0, 20)}`, tenantId, { plan: 'enterprise', source: 'identity-engine' }],
    );

    await client.query(
      `INSERT INTO dypos.branches (id, tenant_id, name, location, city, phone, is_active, created_at)
       VALUES ($1, $2, COALESCE($3, 'المركز الرئيسي'), 'Head Office', 'الرياض', $4, TRUE, NOW())
       ON CONFLICT (id) DO NOTHING`,
      [branchId, tenantId, input.branchName || 'المركز الرئيسي', phone || null],
    );

    await client.query(
      `INSERT INTO dypos.users (
         id, tenant_id, branch_id, username, password_hash, password_salt,
         password_iterations, password_algo, name, role, is_active, created_at
       ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, 'admin', TRUE, NOW())
       ON CONFLICT (id) DO NOTHING`,
      [
        userId,
        tenantId,
        branchId,
        username,
        credential.hash,
        credential.salt,
        credential.iterations,
        credential.algo,
        ownerName,
      ],
    );

    await client.query(
      `INSERT INTO dypos.user_branch_access (user_id, branch_id)
       VALUES ($1, $2)
       ON CONFLICT (user_id, branch_id) DO NOTHING`,
      [userId, branchId],
    );

    await client.query(
      `INSERT INTO dypos.audit_logs (tenant_id, user_id, user_name, action, table_name, record_id, new_data, timestamp)
       VALUES ($1, $2, $3, 'tenant_enroll', 'tenants', $4, $5, NOW())`,
      [tenantId, userId, ownerName, tenantId, { tenantName, ownerName, branchName: input.branchName || 'المركز الرئيسي' }],
    );

    await client.query(
      `INSERT INTO dypos.identity_outbox (id, tenant_id, kind, payload, status, attempts, created_at, updated_at)
       VALUES ($1, $2, 'tenant_enrollment', $3, 'queued', 0, NOW(), NOW())`,
      [`outbox-${makeId('o').replace(/-/g, '').slice(0, 18)}`, tenantId, { tenantId, userId, branchId, state: 'NEW_TENANT', source: 'identity_engine' }],
    );

    const result: EnrollmentResult = {
      state: 'NEW_TENANT',
      tenantId,
      userId,
      branchId,
      reason: 'New tenant, subscription, owner user and default branch created inside one transaction.',
      proofRequired: ['tenant_enrollment', 'subscription_setup', 'owner_user', 'default_branch'],
      confidence: 100,
      idempotencyKey,
    };

    await client.query(
      `INSERT INTO dypos.identity_idempotency (key, tenant_id, result_json, created_at)
       VALUES ($1, $2, $3, NOW())
       ON CONFLICT (key) DO NOTHING`,
      [idempotencyKey, tenantId, result],
    );

    await client.query('COMMIT');
    return result;
  } catch (error) {
    await client.query('ROLLBACK');
    throw error;
  } finally {
    client.release();
  }
}
