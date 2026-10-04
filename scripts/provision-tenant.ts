/**
 * Tenant provisioning for medium commercial establishments.
 *
 * Run:  npx tsx scripts/provision-tenant.ts <tenantId> <name> [vatRate]
 *
 * ══ WHY THIS IS A SCRIPT AND NOT A SCREEN ════════════════════════════════
 * Creating a tenant by hand with SQL produced a row that could not sign in: the
 * user insert failed on the global username constraint, and no branch existed,
 * so even a successful login had nothing to open. Multi-tenancy existed in the
 * schema but had no working way to add a customer.
 *
 * A provisioning screen is the eventual home for this; until then the procedure
 * is executable and repeatable rather than remembered.
 *
 * ══ WHY THE SEGMENT PROVISIONS ANYTHING ═══════════════════════════════════
 * The establishment segment is only meaningful if it changes behaviour. A
 * 'medium' band granting the same screens as a 'micro' band would be a label,
 * and a label is exactly what this system stopped shipping.
 */
import dotenv from 'dotenv';
import pg from 'pg';

dotenv.config();

const pool = new pg.Pool({
  connectionString: process.env.DATABASE_URL,
  ssl: { rejectUnauthorized: false },
  max: 2,
});

/**
 * What each band gets.
 *
 * Medium is the product's target segment and is provisioned with the full
 * branch-and-catalogue set: the screens a medium establishment actually needs
 * to operate. Smaller bands are provisioned narrower deliberately — a tenant
 * shown screens for operations it does not run is the same class of fabrication
 * as a screen showing invented data.
 *
 * Every code below is verified against `dypos.capabilities` at provisioning
 * time and a missing one is reported rather than silently recorded, because a
 * capability that grants nothing is a promise the system cannot keep — and it
 * would appear on a customer contract.
 */
const PROFILES = {
  micro: {
    segment: 'micro',
    branches: 1,
    capabilities: ['product', 'customer', 'ledger'],
    note: 'single outlet: catalogue, customers, ledger',
  },
  small: {
    segment: 'small',
    branches: 1,
    capabilities: ['product', 'service', 'customer', 'workflow', 'ledger'],
    note: 'single outlet with services and workflow',
  },
  medium: {
    segment: 'medium',
    branches: 2,
    capabilities: [
      'product', 'service', 'customer', 'work_order', 'production',
      'commission', 'delivery', 'workflow', 'ledger', 'appointment',
    ],
    note: 'multiple branches, purchasing, work orders, delivery and financial reporting',
  },
  large: {
    segment: 'large',
    branches: 3,
    capabilities: [
      'product', 'service', 'customer', 'work_order', 'production',
      'commission', 'delivery', 'subscription', 'workflow', 'ledger',
      'appointment', 'batch_expiry', 'serial_imei', 'weighing',
    ],
    note: 'multi-branch with batch/serial tracking and weigh-integration',
  },
} as const;

async function main() {
  const [id, name, vatRaw] = process.argv.slice(2);
  if (!id || !name) {
    console.error('usage: npx tsx scripts/provision-tenant.ts <tenantId> <name> [vatRate]');
    process.exit(2);
  }
  const vatRate = vatRaw == null ? 15 : Number(vatRaw);
  // Refused rather than clamped: a rate outside 0-100 cannot be reconciled
  // against any tax return, so silently "fixing" it would hide the mistake.
  if (!Number.isFinite(vatRate) || vatRate < 0 || vatRate > 100) {
    console.error(`refusing an impossible VAT rate: ${vatRaw}`);
    process.exit(2);
  }

  const profile = PROFILES.medium;
  console.log(`provisioning ${id} — ${name} (${profile.segment})`);
  console.log(`  ${profile.note}`);

  const client = await pool.connect();
  try {
    await client.query('BEGIN');

    // Idempotence guard: never silently re-provision an existing tenant, and
    // never half-modify one.
    const existing = await client.query(
      `SELECT id FROM dypos.tenants WHERE id = $1`, [id],
    );
    if (existing.rows[0]) {
      console.error(`tenant ${id} already exists — nothing was changed`);
      await client.query('ROLLBACK');
      process.exit(1);
    }

    await client.query(
      `INSERT INTO dypos.tenants (id, name, base_currency, plan, establishment_segment, vat_rate)
       VALUES ($1, $2, 'SAR', 'enterprise', $3, $4)`,
      [id, name, profile.segment, vatRate],
    );

    /*
     * Branches. One is created unconditionally so the tenant can open a
     * register: logins resolve branch scope from `user_branch_access`, so a
     * tenant with no branch has a session that cannot open a till.
     */
    for (let i = 1; i <= profile.branches; i += 1) {
      await client.query(
        `INSERT INTO dypos.branches (id, tenant_id, name, city) VALUES ($1,$2,$3,$4)`,
        [`br-${id}-${i}`, id, i === 1 ? 'الفرع الرئيسي' : `فرع ${i}`, ''],
      );
    }

    /*
     * Capabilities are granted ONLY where the capability already exists.
     *
     * The insert is driven from `dypos.capabilities` rather than from the list
     * above directly, so a code that does not exist is reported rather than
     * silently recorded. A capability row that grants nothing is the
     * placeholder-record failure again, one level up: the tenant's licence would
     * name a screen the system cannot open.
     */
    const known = await client.query(`SELECT id FROM dypos.capabilities`);
    const knownIds = new Set(known.rows.map((r: { id: string }) => r.id));
    const missing = profile.capabilities.filter((c) => !knownIds.has(c));

    const granted = await client.query(
      `INSERT INTO dypos.tenant_capabilities (tenant_id, capability_id, is_enabled)
       SELECT $1, c.id, TRUE FROM dypos.capabilities c
        WHERE c.id = ANY($2)
       ON CONFLICT (tenant_id, capability_id) DO UPDATE SET is_enabled = TRUE
       RETURNING capability_id`,
      [id, profile.capabilities],
    );

    await client.query('COMMIT');

    const grantedIds = granted.rows.map((r: { capability_id: string }) => r.capability_id);
    console.log(`\n  tenant    ${id}`);
    console.log(`  segment   ${profile.segment}`);
    console.log(`  vat rate  ${vatRate}%`);
    console.log(`  branches  ${profile.branches}`);
    console.log(`  granted   ${grantedIds.join(', ') || '(none)'}`);

    if (missing.length) {
      console.log(`\n  WARNING — not granted, no such capability exists: ${missing.join(', ')}`);
      console.log('  Add them to dypos.capabilities, or remove them from the profile.');
      console.log('  Do not ignore this: a capability that grants nothing is a promise');
      console.log('  the system cannot keep, and it appears on a customer contract.');
    }

    console.log(`\nNext — create an admin for this tenant (password set separately):`);
    console.log(`  INSERT INTO dypos.users (id, tenant_id, username, name, role, branch_id, is_active)`);
    console.log(`  VALUES ('u-${id}-admin', '${id}', 'admin', 'مدير ${name}', 'admin', 'br-${id}-1', TRUE);`);
  } catch (err) {
    // A partial tenant — branches but no capabilities, or a tenant with no
    // branch — is worse than none: it looks provisioned and is not usable.
    await client.query('ROLLBACK').catch(() => {});
    console.error('provisioning failed and was rolled back:', (err as Error).message);
    process.exit(1);
  } finally {
    client.release();
    await pool.end();
  }
}

main();