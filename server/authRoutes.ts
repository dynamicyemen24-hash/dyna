import type { Express } from 'express';
import { pool } from './neonDb.js';
import { asyncRoute, DEFAULT_TENANT, makeId, fail } from './apiHelpers.js';
import { attachPrincipal, requirePermission, readActor } from './authz.js';
import { issueSessionToken } from './sessions.js';
import {
  hashPassword, verifyPassword, verifyPasswordDetailed, checkPasswordStrength, ALGO, ITERATIONS,
  issueResetToken, hashResetToken, isResetTokenValid,
  lockoutMinutesFor, isLocked, GENERIC_AUTH_ERROR,
} from './passwords.js';

import {
  readMfaPolicy, mfaRequired, issueChallenge, verifyChallenge,
  getMfaDeliverer, redeemBreakGlass, issueBreakGlassGrant,
} from './mfa.js';
import { resolveExistingIdentity, enrollTenantSafely } from './enrollmentEngine.js';
import { authRateLimit } from './rateLimit.js';

/**
 * Tenant-wide MFA policy.
 *
 * Off by default so an existing installation is not locked out by a migration,
 * but a single environment variable turns it on org-wide. Enrolment is per user
 * either way (`mfa_secrets.enabled`).
 */
const mfaRequiredForAll = (): boolean =>
  process.env.DYPOS_MFA_REQUIRED === 'true';

const clientIp = (req: any) =>
  (req.headers['cf-connecting-ip'] || req.ip || '').toString().slice(0, 64);

/**
 * Resolves which tenant a login attempt targets.
 *
 * ══ WHY THE CALLER MAY NAME A TENANT HERE, AND NOWHERE ELSE ═══════════════
 * This is the one place a client-supplied tenant is legitimate, and the reason
 * is that naming a tenant proves nothing on its own — it only SAYS which
 * account to try. The password still has to verify against a user row inside
 * that tenant, and the session token that results carries the tenant that was
 * actually resolved from the database, not the one requested. Everywhere after
 * this point the tenant comes from the signed token alone.
 *
 * So the worst a caller can do by guessing is spend password guesses against
 * the tenant they guessed, which the lockout policy already bounds.
 *
 * ══ WHY THE TENANT MUST BE VALIDATED, NOT JUST PASSED THROUGH ════════════
 * Binding it into the query without checking existence would make a login for
 * an unknown tenant indistinguishable from a wrong password only by accident.
 * It is validated explicitly below, and the failure is reported with the SAME
 * message and status as a bad password, so this endpoint cannot be used to
 * enumerate which tenants exist — a thing that is itself information worth
 * keeping private (it tells a competitor who uses this product).
 */
async function resolveLoginTenant(raw: unknown): Promise<{ tenantId: string } | null> {
  const requested = String(raw ?? '').trim().slice(0, 64);

  // No tenant named: keep the historical single-tenant behaviour. This is what
  // an existing client sends, and it must keep working unchanged.
  // DEFAULT_TENANT kept: pre-auth bootstrap — no signed identity exists yet to
  // derive a tenant from; the password must still verify inside this tenant.
  if (!requested) return { tenantId: DEFAULT_TENANT };

  const { rows } = await pool.query(
    `SELECT id FROM dypos.tenants WHERE id = $1 AND is_active IS NOT FALSE`,
    [requested],
  );
  return rows[0] ? { tenantId: rows[0].id } : null;
}

/**
 * Records the attempt. The reason is for the log, never for the response.
 *
 * AUDIT MUST NEVER FAIL THE SIGN-IN. A raised INSERT here becomes a 500 on
 * `/api/auth/login`, and a 500 on the unknown-user branch is not just a broken
 * sign-in — it is an enumeration oracle that distinguishes a nonexistent user
 * from a wrong password (the exact thing `GENERIC_AUTH_ERROR` exists to hide).
 * That class has now bitten twice: first the missing `email`/`phone` columns
 * (DECISION_MAP P7b), then an `event_type` outside the CHECK constraint. Both
 * were audit writes, both surfaced as 500s on the front door.
 *
 * So the edge contract — `worker/index.ts` wraps its audit the same way and
 * documents it as "a failure to audit must never fail the sign-in" — is the
 * contract here too: the row is written, any failure is logged loudly for the
 * operator, and the caller still gets its honest 401/409/403. The evidence that
 * survives is the response the user saw plus the server log; the alternative
 * is losing the response entirely.
 *
 * `reason` is sliced to the column width for the same reason `username` and
 * `user_agent` are: a 200-character engine reason would otherwise be a 22003
 * on the same path.
 */
async function audit(
  tenantId: string, username: string, type: string,
  req: any, reason?: string,
) {
  try {
    await pool.query(
      `INSERT INTO dypos.auth_events
         (id, tenant_id, username, event_type, ip_address, user_agent, reason)
       VALUES ($1,$2,$3,$4,$5,$6,$7)`,
      [makeId('ae'), tenantId, String(username).slice(0, 64), type,
        clientIp(req) || null,
        (req.headers['user-agent'] || '').toString().slice(0, 255),
        reason ? String(reason).slice(0, 128) : null],
    );
  } catch (e) {
    console.error(
      '[dypos] auth_events audit failed (sign-in continues)',
      { tenantId, username, type, error: e instanceof Error ? e.message : e },
    );
  }
}

/**
 * Rotation gate: a session whose password is still temporary may ONLY rotate
 * it (`POST /api/auth/change-password`). Every other privileged auth-module
 * operation (shift open, grant issue, resets by admins, credential/event reads)
 * answers 403 until the rotation lands.
 *
 * WHY NOT A NARROWER TOKEN: `issueSessionToken` (server/sessions.ts) signs a
 * fixed payload and every data route trusts that signature via the global gate
 * (server/authz.ts) — both files are outside this change's scope, so the token
 * shape cannot carry a "password-change-only" claim yet. Until it does, this
 * per-route guard plus the client gate in `App.tsx` (forced ChangePasswordView)
 * is the smallest change that keeps a pre-rotation token out of anything but
 * the rotation itself. Full enforcement on data routes needs the claim above.
 */
async function requireRotatedPassword(req: any, res: any, next: any) {
  try {
    const userId = req.principal?.userId;
    if (!userId) return next();
    const { rows } = await pool.query(
      `SELECT must_change_password FROM dypos.users WHERE id = $1`,
      [userId],
    );
    if (rows[0]?.must_change_password) {
      return res.status(403).json({
        error: 'يجب تغيير كلمة المرور المؤقتة قبل استخدام هذه العملية',
        mustChangePassword: true,
      });
    }
    next();
  } catch (e) {
    next(e);
  }
}

/**
 * Authentication routes.
 *
 * A login returns a session only after the password is verified with PBKDF2,
 * and it reports `mustChangePassword` so the client can force rotation before
 * any business screen becomes reachable.
 */
export function registerAuthRoutes(app: Express) {
  /*
   * Every pre-auth route below carries `authRateLimit`. The budget is per IP
   * per route and counts 401/403 verdicts separately from raw traffic — see
   * server/rateLimit.ts for why both numbers exist. A route in this file
   * WITHOUT the limiter is a route an attacker can grind for free.
   */
  app.post('/api/auth/login', authRateLimit('login'), asyncRoute(async (req, res) => {
    const { username, password, branchId } = req.body || {};
    if (!username || !password) {
      return fail(res, 400, 'اسم المستخدم وكلمة المرور مطلوبان');
    }
    const uname = String(username).trim().toLowerCase();

    /*
     * The tenant is taken from the request here — the ONE place that is
     * legitimate — and then treated as fixed for the rest of the handler. Every
     * statement below binds `loginTenant`, never a re-read of the request, so a
     * handler cannot drift into auditing one tenant while acting on another.
     */
    const resolved = await resolveLoginTenant(
      (req.body || {}).tenantId || req.header('x-tenant-id'),
    );

    // An unknown tenant is refused exactly like a wrong password: same status,
    // same message. Anything more specific would turn this endpoint into a way
    // of discovering which customers use the product.
    if (!resolved) {
      // DEFAULT_TENANT kept: the tenant is unknown, so no session/principal
      // exists to derive one from; the audit row needs a non-null tenant.
      await audit(DEFAULT_TENANT, uname, 'login_failed', req, 'unknown_tenant');
      return fail(res, 401, GENERIC_AUTH_ERROR);
    }
    const loginTenant = resolved.tenantId;

    const { rows } = await pool.query(
      `SELECT u.id, u.tenant_id, u.username, u.name, u.role, u.branch_id, u.is_active,
              u.password_hash, u.password_algo, u.password_salt,
              u.password_iterations, u.must_change_password,
              u.failed_attempts, u.locked_until
       FROM dypos.users u
       WHERE u.tenant_id = $1 AND u.username = $2`,
      [loginTenant, uname],
    );
    let user = rows[0];

    // One message and one status for every failure mode, so an unknown user is
    // not distinguishable from a wrong password.
    const deny = async (reason: string) => {
      await audit(loginTenant, uname, 'login_failed', req, reason);
      return fail(res, 401, GENERIC_AUTH_ERROR);
    };

    if (!user) {
      const identityState = await resolveExistingIdentity({
        tenantName: String((req.body || {}).tenantName || ''),
        tenantCode: String((req.body || {}).tenantCode || ''),
        username: uname,
        email: String((req.body || {}).email || ''),
        phone: String((req.body || {}).phone || ''),
        branchName: String((req.body || {}).branchName || ''),
        deviceFingerprint: String((req.body || {}).deviceFingerprint || ''),
      });

      if (identityState.state === 'EXISTING_USER_NO_ACCESS' || identityState.state === 'AMBIGUOUS_IDENTITY') {
        await audit(loginTenant, uname, 'identity_conflict', req, identityState.reason);
        return fail(res, 409, 'هوية المستخدم غير مؤكدة؛ يُرجى التحقق من بيانات المؤسسة أو التواصل مع المسؤول');
      }

      if (identityState.state === 'PENDING_VERIFICATION' || identityState.state === 'EXISTING_TENANT_NO_BRANCH') {
        await audit(loginTenant, uname, 'identity_pending_verification', req, identityState.reason);
        return fail(res, 403, 'الهوية تحتاج إلى تحقق إضافي قبل السماح بالدخول');
      }

      if (identityState.state === 'NEW_TENANT') {
        const provisionResult = await enrollTenantSafely({
          tenantName: String((req.body || {}).tenantName || DEFAULT_TENANT),
          ownerName: String((req.body || {}).ownerName || ''),
          username: uname,
          email: String((req.body || {}).email || ''),
          password: String(password || ''),
          phone: String((req.body || {}).phone || ''),
          branchName: String((req.body || {}).branchName || ''),
          deviceFingerprint: String((req.body || {}).deviceFingerprint || ''),
        });
        if (provisionResult.state !== 'NEW_TENANT') {
          await audit(loginTenant, uname, 'provision_failed', req, provisionResult.reason || 'provision failed');
          return deny('provision_failed');
        }
        // Re-read user from DB after provisioning
        const { rows } = await pool.query(
          `SELECT u.id, u.tenant_id, u.username, u.name, u.role, u.branch_id, u.is_active,
                  u.password_hash, u.password_algo, u.password_salt,
                  u.password_iterations, u.must_change_password,
                  u.failed_attempts, u.locked_until
           FROM dypos.users u
           WHERE u.tenant_id = $1 AND u.username = $2`,
          [provisionResult.tenantId, uname],
        );
        user = rows[0];
        if (!user) {
          await audit(loginTenant, uname, 'provision_failed', req, 'user_not_after_provision');
          return deny('provision_failed');
        }
      }

      if (!user) return deny('unknown_user');
    }
    if (!user.is_active) return deny('inactive');
    if (isLocked(user.locked_until)) return deny('locked');

        /*
     * `verifyPasswordDetailed` distinguishes "wrong password" from "this account's
     * STORED credential is unusable". The user still receives the same generic
     * message — which is correct, and must stay: revealing that an account
     * exists would be a disclosure.
     *
     * But the LOG says which it was. Two accounts held a truncated hash and were
     * permanently unloginable while the server reported "invalid credentials",
     * so an operator saw what looked like somebody mistyping their password for
     * an unknown number of attempts. The defect is now visible where it can be
     * acted on, and invisible where it would be exploited.
     */
    const outcome = await verifyPasswordDetailed(String(password), {
      hash: user.password_salt ? user.password_hash : null,
      salt: user.password_salt || undefined,
      iterations: user.password_iterations || undefined,
      legacyDigest: user.password_salt ? null : user.password_hash,
    });
    if (outcome.defect) {
      console.error(
        `[dypos-auth] UNUSABLE STORED CREDENTIAL for "${uname}": ${outcome.defect} `
        + `(hash length ${String(user.password_hash ?? '').length}). `
        + 'This account cannot sign in with ANY password until it is re-issued — '
        + 'run scripts/repair-credentials.ts',
      );
    }
    if (!outcome.result) {
      const attempts = Number(user.failed_attempts || 0) + 1;
      const minutes = lockoutMinutesFor(attempts);
      await pool.query(
        `UPDATE dypos.users
         SET failed_attempts = $2,
             locked_until = CASE WHEN $3::int > 0
               THEN NOW() + ($3 || ' minutes')::interval ELSE NULL END
         WHERE id = $1`,
        [user.id, attempts, String(minutes)],
      );
      if (minutes > 0) {
        await audit(loginTenant, uname, 'account_locked', req,
          `locked ${minutes}m after ${attempts} attempts`);
      }
      return deny('bad_password');
    }

    await pool.query(
      `UPDATE dypos.users SET failed_attempts = 0, locked_until = NULL,
              last_login = NOW() WHERE id = $1`,
      [user.id],
    );

    // Transparent upgrade: a legacy SHA-256 digest is re-hashed at login, so the
    // weak scheme disappears without asking the user to do anything.
    if (!user.password_salt || Number(user.password_iterations) < ITERATIONS) {
      const c = await hashPassword(String(password));
      await pool.query(
        `UPDATE dypos.users
         SET password_hash = $2, password_salt = $3, password_iterations = $4,
             password_algo = $5, password_updated_at = NOW()
         WHERE id = $1`,
        [user.id, c.hash, c.salt, c.iterations, ALGO],
      );
    }

    // Branch scope comes from RBAC, not from whatever the client asked for.
    const access = await pool.query(
      `SELECT branch_id FROM dypos.user_branch_access WHERE user_id = $1`, [user.id],
    );
    const allowed = access.rows.map((r: any) => r.branch_id as string);
    const requested = branchId ? String(branchId) : user.branch_id;
    const effectiveBranch = allowed.includes(requested)
      ? requested
      : (allowed[0] ?? user.branch_id);

    const branch = effectiveBranch
      ? (await pool.query(
          `SELECT id, name, city, phone, location AS address
           FROM dypos.branches WHERE id = $1 AND tenant_id = $2`,
          [effectiveBranch, loginTenant],
        )).rows[0]
      : null;

    await audit(loginTenant, uname, 'login_success', req);

    /*
     * ── Second factor gate ────────────────────────────────────────────────
     * The password is only HALF the credential. When the tenant requires a
     * factor, this response deliberately carries NO session token: it returns a
     * `challenge` instead, and the token is minted by /api/auth/mfa/verify only
     * after the code is verified server-side.
     *
     * Previously the token was issued here and the "2FA" step lived in the
     * browser, comparing against a constant in the shipped bundle. The session
     * was therefore already fully usable before — and regardless of — the code
     * the operator typed.
     *
     * The gate applies during forced rotation too (`must_change_password` does
     * NOT skip it): a temporary password is the weakest credential in the
     * system, so exempting exactly those accounts from the second factor would
     * turn every forced rotation into an MFA bypass. The client already handles
     * the challenge-then-rotate order (LoginView → 2FA → ChangePasswordView).
     */
    const policy = await readMfaPolicy(user.id, { requireForAll: mfaRequiredForAll() });
    const needsFactor = mfaRequired(policy, { requireForAll: mfaRequiredForAll() });

    if (needsFactor) {
      const issued = await issueChallenge(
        user.id, loginTenant, effectiveBranch ?? null, policy.digits,
      );
      /*
       * Delivery resolves per TENANT, not per boot: the merchant's own
       * configured channel (settings → MFA delivery) wins over the boot
       * deliverer. A delivery FAILURE must not block sign-in either — the
       * challenge already exists server-side and a resend is always possible,
       * so a dead webhook returns the honest fallback (log) instead of
       * stranding an operator outside their own till.
       */
      const { delivererFor } = await import('./mfaDeliveryRoutes.js');
      let deliverer = getMfaDeliverer();
      try {
        deliverer = await delivererFor(loginTenant);
      } catch (e) {
        console.error('[dypos-auth] tenant delivery lookup failed, using boot deliverer', e);
      }
      try {
        await deliverer.send(uname, issued.code, issued.expiresInSeconds);
      } catch (e) {
        console.error('[dypos-auth] configured delivery failed, falling back to server log', e);
        await getMfaDeliverer().send(uname, issued.code, issued.expiresInSeconds);
        deliverer = getMfaDeliverer();
      }
      await audit(loginTenant, uname, 'mfa_challenged', req, `digits=${issued.digits}`);

      return res.json({
        mfaRequired: true,
        challenge: issued.challenge,
        expiresAt: issued.expiresAt,
        digits: issued.digits,
        deliveryChannel: deliverer.channel,
        username: user.username,
      });
    }

    /*
     * Signing in does NOT open a till.
     *
     * This used to INSERT a `pos_sessions` row on every successful login,
     * taking the opening cash straight from the request body. Three problems
     * followed from that:
     *
     *   - AUTHENTICATION BECAME A FINANCIAL EVENT. Every sign-in produced a
     *     money record, so the shift history was a history of logins rather
     *     than of shifts actually worked.
     *   - THE AMOUNT WAS NEVER COUNTED. It was whatever a pre-authentication
     *     screen held, and the client shipped a default of 500. A default
     *     that reaches the ledger unexamined is an invented balance.
     *   - IT WAS TRUSTED FROM THE CLIENT. `Number(req.body.openingCash) || 0`
     *     accepted any value, so the opening balance of a shift was decided
     *     by whoever called the endpoint.
     *
     * The session is now minted and nothing else. A till is opened by
     * POST /api/auth/shift/open, after the operator is authenticated and has
     * physically counted the drawer.
     */

    res.json({
      session: {
        // Signed, not a bare id: the client cannot edit it to become someone else.
        // The tenant inside the token is the one the user row belongs to. It is
        // not the one the client asked for: `tenantOf()` trusts this token over
        // every header, so a mismatch here would hand the session a scope the
        // password never proved.
        token: issueSessionToken(user.id, user.username, user.tenant_id || loginTenant, user.must_change_password),
        openedAt: new Date().toISOString(),
        user: { id: user.id, name: user.name, role: user.role, username: user.username },
        branch: branch ? {
          id: branch.id, name: branch.name, city: branch.city,
          phone: branch.phone, address: branch.address,
        } : null,
        allowedBranches: allowed,
        // The client must not open any business screen while this is true.
        mustChangePassword: Boolean(user.must_change_password),
      },
    });
  }));

/**
   * Completes sign-in by verifying the second factor.
   *
   * This is the ONLY place a session token is minted when MFA is in force, and it
   * mints one only after `verifyChallenge` confirms the code. The password check
   * already happened in /api/auth/login; this step proves the second factor.
   *
   * The response never echoes the code, and a wrong code never yields a token.
   */
  app.post('/api/auth/mfa/verify', authRateLimit('mfa-verify'), asyncRoute(async (req, res) => {
    const { challenge, code } = req.body || {};
    if (!challenge || !code) {
      return fail(res, 400, 'الرمز مطلوب');
    }

    const outcome = await verifyChallenge(String(challenge), String(code));

    if (!outcome.ok) {
      // The USERNAME is deliberately not logged here: the challenge is anonymous
      // by design, and writing the attempted code into the username column would
      // turn the audit ledger into a list of (partly correct) codes. The reason
      // is recorded; the code never is.
      // DEFAULT_TENANT kept: a failed challenge carries no verified identity,
      // so there is no principal tenant to audit under (see mfa.ts — the row's
      // tenant is only exposed on successful verification).
      await audit(DEFAULT_TENANT, 'mfa', 'mfa_failed', req, outcome.reason);
      // One message for every failure: an attacker must not be able to tell an
      // unknown challenge from a wrong code, nor learn how many tries remain.
      return fail(res, outcome.retryable ? 401 : 400, outcome.message);
    }

    /*
     * `tenant_id` is read off the row rather than assumed.
     *
     * The token minted below now CARRIES a tenant, and `tenantOf()` trusts that
     * token over any header the client sends. So the value written into the token
     * has to be the tenant the user actually belongs to — if it were merely the
     * default, a user of a second tenant could be issued a token for the first
     * and then read the first tenant's data. The lookup is therefore keyed on the
     * MFA-verified user id AND returns the tenant that owns that row.
     */
    const user = await pool.query(
      `SELECT id, username, name, role, must_change_password, tenant_id
         FROM dypos.users WHERE id = $1`,
      [outcome.userId],
    );
    const row = user.rows[0];
    if (!row) return fail(res, 401, GENERIC_AUTH_ERROR);
    // DEFAULT_TENANT kept: defensive fallback only — the tenant is read off the
    // MFA-verified user row above; a null here fails closed downstream (the
    // token would resolve no principal), it never widens scope.
    const userTenant = row.tenant_id || DEFAULT_TENANT;

    // Branch scope is re-read from RBAC, exactly as on the password step.
    const access = await pool.query(
      `SELECT branch_id FROM dypos.user_branch_access WHERE user_id = $1`,
      [outcome.userId],
    );
    const allowed = access.rows.map((r: any) => r.branch_id as string);
    const effectiveBranch = outcome.branchId ?? allowed[0] ?? null;

    // Scoped to the tenant that owns the user row, not the default.
    const branch = effectiveBranch
      ? (await pool.query(
          `SELECT id, name, city, phone, location AS address
             FROM dypos.branches WHERE id = $1 AND tenant_id = $2`,
          [effectiveBranch, userTenant],
        )).rows[0]
      : null;

    // Same rule as the password path: authenticating is not opening a till.
    // See the note above the `res.json` in /api/auth/login.
    await audit(userTenant, row.username, 'mfa_success', req);
    /*
     * Scoped by tenant AND user.
     *
     * `mfa_secrets.user_id` is a PRIMARY KEY, so `WHERE user_id = $1` already
     * addresses exactly one row and was not exploitable on its own. But a secret
     * row carries `tenant_id`, and the row was being touched without it — the
     * one place in the MFA flow where the tenant dimension was simply absent.
     *
     * Adding it costs one parameter and makes the invariant hold by rule rather
     * than by key uniqueness. Both are required: the tenant check is the
     * authorisation, the user check is the intent.
     */
    await pool.query(
      `UPDATE dypos.mfa_secrets SET last_used_at = NOW()
        WHERE tenant_id = $1 AND user_id = $2`,
      [userTenant, outcome.userId],
    );

    res.json({
      session: {
        token: issueSessionToken(row.id, row.username, userTenant),
        openedAt: new Date().toISOString(),
        user: { id: row.id, name: row.name, role: row.role, username: row.username },
        branch: branch ? {
          id: branch.id, name: branch.name, city: branch.city,
          phone: branch.phone, address: branch.address,
        } : null,
        allowedBranches: allowed,
        mustChangePassword: Boolean(row.must_change_password),
      },
    });
  }));

  /**
   * Opens a cashier shift with a COUNTED drawer balance.
   *
   * WHY THIS IS A SEPARATE, AUTHENTICATED ENDPOINT
   * ---------------------------------------------
   * Opening a till is not signing in. It is the second half of a cash
   * handover, and it has different preconditions:
   *
   *   - the caller must already hold a valid session, so the count is
   *     attributed to a proven identity rather than to whoever reached the
   *     sign-in screen;
   *   - the count is a MEASUREMENT, so it is range-checked and rounded to
   *     minor units rather than passed through unchecked;
   *   - the event is audited as its own action, because "signed in" and
   *     "took custody of 5,000 riyals" are different statements and the
   *     Z-Report has to be able to tell them apart.
   *
   * It refuses to open a second shift for the same branch and operator, so a
   * double-click or a retried request cannot produce two float records for
   * one handover.
   */
  app.post('/api/auth/shift/open', attachPrincipal, requireRotatedPassword, requirePermission('pos.use'), asyncRoute(async (req, res) => {
    // `attachPrincipal` has already resolved and verified the identity, so the
    // tenant and the branch scope come from a signed token — not from a header
    // or a body field the caller chose.
    const actor = req.principal!;
    const tenantId = actor.tenantId;

    const branchId = String(req.body?.branchId ?? '').trim();
    if (!branchId) return fail(res, 400, 'حدّد الفرع الذي تفتح له الوردية');

    const count = Number(req.body?.openingCash);
    if (!Number.isFinite(count) || count < 0) {
      return fail(res, 400, 'الرصيد الافتتاحي يجب أن يكون رقماً غير سالب');
    }
    // Minor units. A float with a third decimal is a typing slip, and rounding
    // it here is what keeps the closing variance arithmetic exact.
    const openingCash = Math.round(count * 100) / 100;
    if (openingCash > 10_000_000) {
      return fail(res, 400, 'الرصيد الافتتاحي خارج النطاق المعقول');
    }

    // The branch must belong to this tenant. Without this a caller could open
    // a shift against a branch id from another organisation and post its float
    // into a ledger that is not theirs.
    const branch = (await pool.query(
      `SELECT id, name FROM dypos.branches WHERE id = $1 AND tenant_id = $2`,
      [branchId, tenantId],
    )).rows[0];
    if (!branch) return fail(res, 404, 'الفرع غير موجود في هذه المؤسسة');

    // The user row, not the session's username.
    //
    // `pos_sessions.user_id` is a foreign key to `users.id`. Writing the
    // username there would either fail the constraint or — worse, on a schema
    // without one — make the shift history joinable to the wrong person. The
    // identity is resolved from the tenant-scoped row, so a renamed account
    // does not orphan its own shifts either.
    const user = (await pool.query(
      `SELECT id FROM dypos.users WHERE tenant_id = $1 AND username = $2`,
      [tenantId, actor.username],
    )).rows[0];
    if (!user) return fail(res, 403, 'الجلسة لم تعد صالحة');

    // One open shift per operator per branch.
    const already = (await pool.query(
      `SELECT id FROM dypos.pos_sessions
        WHERE tenant_id = $1 AND branch_id = $2 AND user_id = $3 AND status = 'open'
        LIMIT 1`,
      [tenantId, branch.id, user.id],
    )).rows[0];
    if (already) return fail(res, 409, 'توجد وردية مفتوحة بالفعل على هذا الفرع');

    const id = makeId('pos');
    await pool.query(
      `INSERT INTO dypos.pos_sessions
         (id, tenant_id, branch_id, user_id, opening_time, opening_cash, status)
       VALUES ($1,$2,$3,$4,NOW(),$5,'open')`,
      [id, tenantId, branch.id, user.id, openingCash],
    );

    await audit(tenantId, actor.username, 'shift_open', req,
      `الرصيد الافتتاحي ${openingCash.toFixed(2)} · الفرع ${branch.name}`);

    res.json({ shiftId: id, openingCash, branchId: branch.id, branchName: branch.name });
  }));

  /**
   * Closes a cashier shift with counted closing balance.
   *
   * Validates:
   * - Shift exists and belongs to this tenant/branch/user
   * - Shift is currently open
   * - Closing cash is counted and verified against opening + sales - payments
   * - One close per shift (idempotent)
   */
  app.get('/api/auth/shift/current', attachPrincipal, requireRotatedPassword, requirePermission('pos.use'), asyncRoute(async (req, res) => {
    const actor = req.principal!;
    const user = (await pool.query(
      `SELECT id FROM dypos.users WHERE tenant_id = $1 AND username = $2`,
      [actor.tenantId, actor.username],
    )).rows[0];
    if (!user) return fail(res, 403, 'الجلسة لم تعد صالحة');

    const row = (await pool.query(
      `SELECT id, branch_id, opening_time, opening_cash, status
         FROM dypos.pos_sessions
        WHERE tenant_id = $1 AND user_id = $2 AND status = 'open'
        ORDER BY opening_time DESC
        LIMIT 1`,
      [actor.tenantId, user.id],
    )).rows[0];

    if (!row) return res.json({ shift: null });

    const totals = (await pool.query(
      `SELECT
         COALESCE(SUM(total), 0) AS total_sales,
         COALESCE(SUM(total) FILTER (WHERE payment_method IN ('cash','mada')), 0) AS cash_sales,
         COALESCE(SUM(total) FILTER (WHERE payment_method NOT IN ('cash','mada')), 0) AS non_cash_sales,
         COUNT(*) AS transactions_count
       FROM dypos.invoices
      WHERE tenant_id = $1 AND branch_id = $2 AND shift_id = $3 AND status = 'completed'`,
      [actor.tenantId, row.branch_id, row.id],
    )).rows[0];

    res.json({
      shift: {
        id: row.id,
        branchId: row.branch_id,
        startTime: row.opening_time,
        openingCash: Number(row.opening_cash || 0),
        totalSales: Number(totals?.total_sales || 0),
        cashSales: Number(totals?.cash_sales || 0),
        cardSales: Number(totals?.non_cash_sales || 0),
        transactionsCount: Number(totals?.transactions_count || 0),
        status: row.status,
      },
    });
  }));

  app.post('/api/auth/shift/close', attachPrincipal, requireRotatedPassword, requirePermission('pos.use'), asyncRoute(async (req, res) => {
    const actor = req.principal!;
    const tenantId = actor.tenantId;

    const shiftId = String(req.body?.shiftId ?? '').trim();
    if (!shiftId) return fail(res, 400, 'حدد رقم الوردية');

    const shift = (await pool.query(
      `SELECT * FROM dypos.pos_sessions WHERE id = $1 AND tenant_id = $2`,
      [shiftId, tenantId],
    )).rows[0];
    if (!shift) return fail(res, 404, 'الوردية غير موجودة أو لا تتبع هذه المؤسسة');

    if (shift.status !== 'open') return fail(res, 400, 'الوردية غير مفتوحة');

    const closingCash = Number(req.body?.closingCash);
    if (!Number.isFinite(closingCash) || closingCash < 0) {
      return fail(res, 400, 'الرصيد الختامي يجب أن يكون رقماً غير سالب');
    }

    // Compute expected: opening + total sales - payments received
    const sales = await pool.query(
      `SELECT
         COALESCE(SUM(total), 0) AS total_sales,
         COALESCE(SUM(total) FILTER (WHERE payment_method IN ('cash','mada')), 0) AS cash_sales
       FROM dypos.invoices
      WHERE tenant_id = $1 AND branch_id = $2 AND shift_id = $3 AND status = 'completed'`,
      [tenantId, shift.branch_id, shiftId],
    );
    const totalSales = Number(sales.rows[0].total_sales);
    const cashSales = Number(sales.rows[0].cash_sales);

    const alreadyClosed = (await pool.query(
      `SELECT id FROM dypos.pos_sessions WHERE id = $1 AND status = 'closed'`,
      [shiftId],
    )).rows[0];
    if (alreadyClosed) return fail(res, 400, 'تم إغلاق هذه الوردية بالفعل');

    const expectedCash = Number(shift.opening_cash || 0) + cashSales;
    const difference = closingCash - expectedCash;

    await pool.query(
      `UPDATE dypos.pos_sessions
         SET closing_cash = $1,
             end_time = NOW(),
             status = 'closed'
       WHERE id = $2 AND tenant_id = $3 AND status = 'open'`,
      [closingCash, shiftId, tenantId],
    );

    await audit(tenantId, actor.username, 'shift_close', req,
      `الرصيد الختامي ${closingCash.toFixed(2)} · الافتتاحي ${Number(shift.opening_cash).toFixed(2)} · النقدية ${cashSales.toFixed(2)} · إجمالي المبيعات ${totalSales.toFixed(2)} · الفرق ${difference.toFixed(2)}`);

    res.json({
      shiftId,
      closingCash,
      expectedCash,
      difference,
      startTime: shift.opening_time ?? shift.start_time,
      endTime: new Date().toISOString(),
      status: 'closed',
    });
  }));

  /**
   * Redeems an emergency (break-glass) grant.
   *
   * Replaces a client-side comparison against three hard-coded passcodes that
   * bypassed password verification entirely. A grant is now issued by an
   * authorised supervisor, expires, is single-use, and is audited on both issue
   * and redemption.
   */
  app.post('/api/auth/break-glass', authRateLimit('break-glass'), asyncRoute(async (req, res) => {
    const { code } = req.body || {};
    // DEFAULT_TENANT kept: pre-auth redemption — the caller holds no session by
    // definition, so no principal tenant exists. The grant only authorises
    // escalation (never opens a session) and is tenant-scoped in SQL (mfa.ts),
    // so a foreign code simply does not match.
    const result = await redeemBreakGlass(
      String(code || ''),
      clientIp(req) || 'unknown',
      DEFAULT_TENANT,
    );
    if (!result.ok) {
      // DEFAULT_TENANT kept: same pre-auth audit as above — no verified tenant yet.
      await audit(DEFAULT_TENANT, 'break_glass', 'break_glass_denied', req, result.reason);
      return fail(res, 401, result.message || GENERIC_AUTH_ERROR);
    }
    // DEFAULT_TENANT kept: same pre-auth audit as above.
    await audit(DEFAULT_TENANT, 'break_glass', 'break_glass_redeemed', req);
    // The grant authorises escalation; it does not itself open a session, so the
    // caller must still present credentials.
    res.json({ accepted: true, requiresCredentials: true });
  }));

  /**
   * Issues a break-glass grant. Supervisor-only — this is the control that makes
   * emergency access accountable instead of a backdoor.
   */
  app.post(
    '/api/auth/break-glass/issue', attachPrincipal, requireRotatedPassword, requirePermission('auth.break_glass'),
    asyncRoute(async (req, res) => {
      const reason = String(req.body?.reason || '').trim();
      if (!reason) return fail(res, 400, 'سبب الإصدار مطلوب — يُسجَّل في سجل التدقيق');
      // Tenant from the issuer's SIGNED session, not the bootstrap default: a
      // grant redeemed anywhere else must not match, and the audit row must sit
      // in the issuing organisation's ledger.
      const issuerTenant = req.principal!.tenantId;
      const grant = await issueBreakGlassGrant(
        // `readActor` is the server's own identity reader (see authz.ts) — the
        // grant must name a real issuer, not a client-supplied string.
        issuerTenant, readActor(req), reason,
      );
      await audit(issuerTenant, 'break_glass', 'break_glass_issued', req, reason);
      res.json(grant);
    }),
  );

  /**
   * Changes the caller's own password.
   *
   * The current password must be presented even when the user just signed in
   * under a forced rotation: without it, anyone at an unlocked terminal could
   * take the account over permanently.
   */
  app.post('/api/auth/change-password', attachPrincipal, authRateLimit('change-password'), asyncRoute(async (req, res) => {
    const { currentPassword, newPassword, confirmPassword } = req.body || {};
    if (!currentPassword || !newPassword) {
      return fail(res, 400, 'كلمة المرور الحالية والجديدة مطلوبتان');
    }
    if (newPassword !== confirmPassword) {
      return fail(res, 400, 'كلمتا المرور غير متطابقتين');
    }
    if (currentPassword === newPassword) {
      return fail(res, 400, 'كلمة المرور الجديدة يجب أن تختلف عن الحالية');
    }

    // Tenant from the caller's SIGNED session (`attachPrincipal` verified it):
    // the user row must belong to the organisation the token was issued for, so
    // a session of tenant A can never rotate (or probe) a same-named account in
    // tenant B. Deliberately NOT behind `requireRotatedPassword` — this IS the
    // rotation path a pre-rotation token is allowed to reach.
    const callerTenant = req.principal!.tenantId;
    const user = req.principal!.username;
    const { rows } = await pool.query(
      `SELECT id, password_hash, password_salt, password_iterations
       FROM dypos.users WHERE tenant_id = $1 AND username = $2`,
      [callerTenant, user],
    );
    const u = rows[0];
    if (!u) return fail(res, 404, 'المستخدم غير موجود');

    const ok = await verifyPassword(String(currentPassword), {
      hash: u.password_salt ? u.password_hash : null,
      salt: u.password_salt || undefined,
      iterations: u.password_iterations || undefined,
      legacyDigest: u.password_salt ? null : u.password_hash,
    });
    if (!ok) {
      await audit(callerTenant, user, 'login_failed', req, 'change_wrong_current');
      return fail(res, 401, 'كلمة المرور الحالية غير صحيحة');
    }

    const tenant = await pool.query(
      `SELECT name FROM dypos.tenants WHERE id = $1`, [callerTenant],
    );
    const policy = checkPasswordStrength(String(newPassword), {
      username: user,
      tenantName: tenant.rows[0]?.name,
    });
    if (!policy.ok) return fail(res, 422, policy.problems.join(' · '));

    const c = await hashPassword(String(newPassword));
    // Clearing the flag is the whole point: the client unblocks on this.
    await pool.query(
      `UPDATE dypos.users
       SET password_hash = $2, password_salt = $3, password_iterations = $4,
           password_algo = $5, password_updated_at = NOW(),
           must_change_password = FALSE, password_expires_at = NULL,
           reset_token_hash = NULL, reset_token_expires = NULL,
           failed_attempts = 0, locked_until = NULL
       WHERE id = $1`,
      [u.id, c.hash, c.salt, c.iterations, ALGO],
    );
    await audit(callerTenant, user, 'password_changed', req, `strength ${policy.score}/4`);

    res.json({ ok: true, mustChangePassword: false, message: 'تم تغيير كلمة المرور بنجاح' });
  }));

  /** Strength check without storing anything — drives the live meter. */
  app.post('/api/auth/password-policy', asyncRoute(async (req, res) => {
    const { password, username } = req.body || {};
    // DEFAULT_TENANT kept: public pre-auth endpoint — no session to derive a
    // tenant from, and the tenant name is only a strength-check dictionary word,
    // never an access decision.
    const tenant = await pool.query(`SELECT name FROM dypos.tenants WHERE id = $1`, [DEFAULT_TENANT]);
    res.json(checkPasswordStrength(String(password || ''), {
      username: String(username || ''),
      tenantName: tenant.rows[0]?.name,
    }));
  }));

/** Issues a single-use reset token; the raw value is returned exactly once. */
  app.post(
    '/api/auth/forgot-password',
    attachPrincipal,
    requireRotatedPassword,
    requirePermission('user.manage'),
    asyncRoute(async (req, res) => {
      const { username } = req.body || {};
      if (!username) return fail(res, 400, 'اسم المستخدم مطلوب');
      const uname = String(username).trim().toLowerCase();

      // Tenant from the admin's SIGNED session: a reset token must be issued for
      // an account in the admin's own organisation, never by naming another one.
      const issuerTenant = req.principal!.tenantId;
      const u = await pool.query(
        `SELECT id FROM dypos.users
         WHERE tenant_id = $1 AND username = $2 AND is_active = TRUE`,
        [issuerTenant, uname],
      );
      if (!u.rows.length) return fail(res, 404, GENERIC_AUTH_ERROR);

      const t = issueResetToken();
      await pool.query(
        `UPDATE dypos.users SET reset_token_hash = $2, reset_token_expires = $3
         WHERE id = $1`,
        [u.rows[0].id, t.hash, t.expiresAt],
      );
      await audit(issuerTenant, uname, 'password_reset_requested', req);

      res.json({ ok: true, resetToken: t.token, expiresAt: t.expiresAt });
    }),
  );

  /** Redeems a reset token and sets a new password. */
  app.post('/api/auth/reset-password', authRateLimit('reset-password'), asyncRoute(async (req, res) => {
    const { token, newPassword } = req.body || {};
    if (!token || !newPassword) return fail(res, 400, 'الرمز وكلمة المرور مطلوبان');

    /*
     * No tenant predicate here by design. This step is pre-auth (no session),
     * and the reset token itself is the credential: it was issued for one user
     * row by /api/auth/forgot-password, which IS tenant-scoped to the issuing
     * admin's organisation. Filtering by DEFAULT_TENANT would strand every
     * reset issued elsewhere, so the tenant is read off the MATCHED row and
     * used for the audit below — never from client input.
     */
    const u = await pool.query(
      `SELECT id, username, tenant_id, reset_token_hash, reset_token_expires
       FROM dypos.users
       WHERE reset_token_hash IS NOT NULL`,
    );
    const match = u.rows.find((r: any) =>
      isResetTokenValid(String(token), r.reset_token_hash, r.reset_token_expires));
    if (!match) return fail(res, 401, 'الرمز غير صالح أو منتهي');

    const policy = checkPasswordStrength(String(newPassword), {
      username: match.username,
    });
    if (!policy.ok) return fail(res, 422, policy.problems.join(' · '));

    const c = await hashPassword(String(newPassword));
    await pool.query(
      `UPDATE dypos.users
       SET password_hash = $2, password_salt = $3, password_iterations = $4,
           password_algo = $5, password_updated_at = NOW(),
           must_change_password = FALSE, reset_token_hash = NULL,
           reset_token_expires = NULL, failed_attempts = 0, locked_until = NULL
       WHERE id = $1`,
      [match.id, c.hash, c.salt, c.iterations, ALGO],
    );
    await audit(match.tenant_id, match.username, 'password_reset_completed', req);

    res.json({ ok: true, message: 'تمت إعادة تعيين كلمة المرور' });
  }));

  /** Credential state for an operator — never returns the hash. */
  app.get('/api/auth/credentials/:username', attachPrincipal, requireRotatedPassword, asyncRoute(async (req, res) => {
    // Tenant from the caller's SIGNED session: credential state of another
    // organisation must never be readable by naming its users.
    const callerTenant = req.principal!.tenantId;
    const { rows } = await pool.query(
      `SELECT u.username, u.name, u.role, u.is_active, u.must_change_password,
              u.password_algo, u.password_updated_at, u.last_login,
              u.failed_attempts, u.locked_until,
              (SELECT count(*)::int FROM dypos.auth_events a
                WHERE a.username = u.username AND a.event_type = 'login_failed'
                  AND a.created_at > NOW() - INTERVAL '24 hours') AS failures_24h
       FROM dypos.users u WHERE u.tenant_id = $1 AND u.username = $2`,
      [callerTenant, String(req.params.username).toLowerCase()],
    );
    if (!rows.length) return fail(res, 404, 'المستخدم غير موجود');
    res.json({ item: rows[0] });
  }));

  /** Recent authentication activity, for the security view. */
  app.get('/api/auth/events', attachPrincipal, requireRotatedPassword, asyncRoute(async (req, res) => {
    // Tenant from the caller's SIGNED session: the audit ledger is per
    // organisation, and a header claim must never select whose log is read.
    const callerTenant = req.principal!.tenantId;
    const { rows } = await pool.query(
      `SELECT username, event_type, ip_address, reason, created_at
       FROM dypos.auth_events WHERE tenant_id = $1
       ORDER BY created_at DESC LIMIT 100`,
      [callerTenant],
    );
    res.json({ items: rows });
  }));

  /** Which build this deployment is running. */
  app.get('/api/release', asyncRoute(async (_req, res) => {
    try {
      const cur = await pool.query(
        `SELECT version, build_at, notes, deployed_by
         FROM dypos.app_releases WHERE is_current = TRUE LIMIT 1`,
      );
      res.json({ current: cur.rows[0] || null, degraded: false });
    } catch (err: any) {
      // DB unreachable: return a default value so the client can still
      // render; the release feed falls back to cached release notes.
      console.error('[authRoutes] /api/release DB error:', err?.message ?? err);
      res.json({ current: null, degraded: true });
    }
  }));
}
