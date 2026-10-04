/**
 * Server-enforced second factor.
 *
 * ── Why this module exists ──────────────────────────────────────────────────
 * The sign-in flow ran a "2FA" step entirely in the browser: it compared the
 * typed digits against `DEFAULT_OTP`, a constant compiled into the shipped
 * JavaScript, and the break-glass path compared against three hard-coded
 * passcodes. The server had no MFA code at all.
 *
 * That is not a weak second factor, it is *no* second factor. The bundle is
 * public; anyone could read the code out of it and log in. Worse, break-glass
 * skipped the password check entirely, so a six-character string in a text file
 * was a universal admin backdoor.
 *
 * ── The rule this module enforces ───────────────────────────────────────────
 * **The client is untrusted.** So:
 *
 *   1. The server decides whether a factor is required. The client cannot
 *      declare itself verified.
 *   2. `/api/auth/login` returns NO session token while a factor is pending. It
 *      returns a `challenge` instead, which names a database row and carries no
 *      authority by itself.
 *   3. The token is issued by `/api/auth/mfa/verify`, and only after the code is
 *      checked here. A correct password alone yields nothing spendable.
 *
 * ── Why the codes are hashed ────────────────────────────────────────────────
 * A dump of `mfa_challenges` must not be usable. Storing a SHA-256 of the
 * delivered code proves "this code was issued" without turning the table into a
 * list of valid codes. Comparison is constant-time.
 *
 * ── Why the budget is per-challenge AND per-user ────────────────────────────
 * Per-challenge alone is evaded by re-requesting; per-user alone does not stop
 * grinding one challenge fast. Together, a stolen valid password buys 5 guesses
 * and then a lockout — not 10^6.
 *
 * Delivery is deliberately not faked. `MfaDeliverer` is the seam: a deployment
 * plugs in its provider, and the delivered code is a real random code.
 */
import crypto from 'crypto';
import { pool } from './neonDb.js';
import { makeId } from './apiHelpers.js';

/** Digits in a delivered code. Six is the industry default (Google, Microsoft). */
export const MFA_DIGITS = 6;

/** How long a pending challenge stays usable. Codes expire; challenges do too. */
export const MFA_CHALLENGE_TTL_SECONDS = 300;

/** Independent budget for the second factor, separate from the password's. */
export const MFA_MAX_ATTEMPTS = 5;

/** Lockout applied once the factor's budget is spent. */
export const MFA_LOCKOUT_MINUTES = 15;

const sha256 = (v: string) => crypto.createHash('sha256').update(v, 'utf8').digest('hex');

/** Constant-time compare, so a code cannot be discovered byte by byte. */
function safeEqual(a: string, b: string): boolean {
  const ab = Buffer.from(a, 'utf8');
  const bb = Buffer.from(b, 'utf8');
  if (ab.length !== bb.length) return false;
  return crypto.timingSafeEqual(ab, bb);
}

/** Cryptographically random numeric code. `randomInt`, never `Math.random`. */
function generateCode(digits = MFA_DIGITS): string {
  let out = '';
  for (let i = 0; i < digits; i += 1) out += String(crypto.randomInt(0, 10));
  return out;
}

export interface MfaPolicy {
  enabled: boolean;
  digits: number;
  lockedUntil: string | null;
  failedAttempts: number;
}

export interface IssuedChallenge {
  /** Opaque handle echoed back to `/api/auth/mfa/verify`. */
  challenge: string;
  expiresAt: string;
  digits: number;
  /**
   * The code, for the DELIVERY layer only.
   *
   * Returned in-process so a deliverer can send it. Never persisted in the
   * clear, and never returned by any HTTP route.
   */
  code: string;
  expiresInSeconds: number;
}
/**
 * Reads the effective policy for a user.
 *
 * A user with no row is simply not enrolled — which must NOT mean "skip the
 * factor" when the tenant requires it org-wide, hence `requireForAll`.
 */
export async function readMfaPolicy(
  userId: string,
  opts: { requireForAll?: boolean } = {},
): Promise<MfaPolicy> {
  const { rows } = await pool.query(
    `SELECT s.enabled, s.digits, u.mfa_failed_attempts, u.mfa_locked_until
       FROM dypos.users u
       LEFT JOIN dypos.mfa_secrets s ON s.user_id = u.id
      WHERE u.id = $1`,
    [userId],
  );
  const row = rows[0];

  const lockedUntil = row?.mfa_locked_until
    ? new Date(row.mfa_locked_until).toISOString()
    : null;

  return {
    enabled: Boolean(row?.enabled) || Boolean(opts.requireForAll),
    digits: Number(row?.digits) || MFA_DIGITS,
    lockedUntil,
    failedAttempts: Number(row?.mfa_failed_attempts) || 0,
  };
}

/**
 * True when a factor must be satisfied before a session may be issued.
 *
 * A locked factor ALWAYS requires the flow — otherwise the lockout would itself
 * become the bypass.
 */
export function mfaRequired(policy: MfaPolicy, opts: { requireForAll?: boolean } = {}): boolean {
  if (policy.lockedUntil && Date.parse(policy.lockedUntil) > Date.now()) return true;
  return policy.enabled || Boolean(opts.requireForAll);
}

/**
 * Creates a pending challenge and returns the code for delivery.
 *
 * Any previous unconsumed challenge for the user is invalidated first, so a
 * stale code can never be redeemed after a newer one is issued.
 */
export async function issueChallenge(
  userId: string,
  tenantId: string,
  branchId: string | null,
  digits = MFA_DIGITS,
): Promise<IssuedChallenge> {
  await pool.query(
    `UPDATE dypos.mfa_challenges
        SET consumed_at = NOW()
      WHERE user_id = $1 AND tenant_id = $2 AND consumed_at IS NULL`,
    [userId, tenantId],
  );

  const code = generateCode(digits);
  const challenge = crypto.randomBytes(24).toString('base64url');
  const expiresAt = new Date(Date.now() + MFA_CHALLENGE_TTL_SECONDS * 1000);

  await pool.query(
    `INSERT INTO dypos.mfa_challenges
       (id, tenant_id, user_id, branch_id, challenge, code_hash, digits,
        attempts, max_attempts, expires_at)
     VALUES ($1,$2,$3,$4,$5,$6,$7,0,$8,$9)`,
    [
      makeId('mfa'), tenantId, userId, branchId, challenge, sha256(code),
      digits, MFA_MAX_ATTEMPTS, expiresAt.toISOString(),
    ],
  );

  return {
    challenge,
    expiresAt: expiresAt.toISOString(),
    digits,
    code,
    expiresInSeconds: MFA_CHALLENGE_TTL_SECONDS,
  };
}
export type VerifyOutcome =
  | { ok: true; userId: string; tenantId: string; branchId: string | null; username: string }
  | { ok: false; reason: string; message: string; retryable: boolean };

/**
 * Verifies a submitted code against a pending challenge.
 *
 * Outcomes are deliberately distinguishable to the CALLER, so the audit log
 * records what actually happened — while the HTTP layer returns one generic
 * message, so an attacker cannot tell "no such challenge" from "wrong code".
 */
export async function verifyChallenge(
  challengeId: string,
  submitted: string,
): Promise<VerifyOutcome> {
  const { rows } = await pool.query(
    `SELECT id, tenant_id, user_id, branch_id, code_hash, digits,
            attempts, max_attempts, expires_at, consumed_at
       FROM dypos.mfa_challenges
      WHERE challenge = $1`,
    [challengeId],
  );
  const row = rows[0];

  const denied = (reason: string, message = 'رمز التحقق غير صحيح أو منتهي'): VerifyOutcome => ({
    ok: false, reason, message, retryable: false,
  });

  if (!row) return denied('unknown_challenge');
  if (row.consumed_at) return denied('already_consumed');

  if (new Date(row.expires_at).getTime() < Date.now()) {
    await pool.query(`UPDATE dypos.mfa_challenges SET consumed_at = NOW() WHERE id = $1`, [row.id]);
    return denied('expired');
  }

  const attempts = Number(row.attempts) + 1;
  if (attempts > Number(row.max_attempts)) {
    await pool.query(`UPDATE dypos.mfa_challenges SET consumed_at = NOW() WHERE id = $1`, [row.id]);
    await lockFactor(row.user_id);
    return denied('attempts_exhausted');
  }

  const digits = String(submitted || '').replace(/\D/g, '');
  const correct = digits.length === Number(row.digits) && safeEqual(sha256(digits), row.code_hash);

  if (!correct) {
    await pool.query(
      `UPDATE dypos.mfa_challenges SET attempts = $2 WHERE id = $1`,
      [row.id, attempts],
    );
    await pool.query(
      `UPDATE dypos.users
          SET mfa_failed_attempts = mfa_failed_attempts + 1,
              mfa_locked_until = CASE
                WHEN mfa_failed_attempts + 1 >= $2
                THEN NOW() + ($3 || ' minutes')::interval
                ELSE mfa_locked_until END
        WHERE id = $1`,
      [row.user_id, MFA_MAX_ATTEMPTS, String(MFA_LOCKOUT_MINUTES)],
    );

    if (attempts >= Number(row.max_attempts)) {
      await pool.query(`UPDATE dypos.mfa_challenges SET consumed_at = NOW() WHERE id = $1`, [row.id]);
      await lockFactor(row.user_id);
      return denied('attempts_exhausted');
    }

    return {
      ok: false,
      reason: 'bad_code',
      message: `رمز غير صحيح — تبقّى ${Number(row.max_attempts) - attempts + 1} محاولات`,
      retryable: true,
    };
  }

  // Burn the challenge on success: one code, one session.
  await pool.query(`UPDATE dypos.mfa_challenges SET consumed_at = NOW() WHERE id = $1`, [row.id]);
  await pool.query(
    `UPDATE dypos.users SET mfa_failed_attempts = 0, mfa_locked_until = NULL WHERE id = $1`,
    [row.user_id],
  );

  const user = await pool.query(`SELECT username FROM dypos.users WHERE id = $1`, [row.user_id]);

  return {
    ok: true,
    userId: row.user_id,
    tenantId: row.tenant_id,
    branchId: row.branch_id,
    username: user.rows[0]?.username ?? '',
  };
}

/** Applies the factor lockout on its own (challenge exhaustion, break-glass). */
async function lockFactor(userId: string): Promise<void> {
  await pool.query(
    `UPDATE dypos.users
        SET mfa_failed_attempts = $2,
            mfa_locked_until = NOW() + ($3 || ' minutes')::interval
      WHERE id = $1`,
    [userId, MFA_MAX_ATTEMPTS, String(MFA_LOCKOUT_MINUTES)],
  );
}
/* -------------------------------------------------------------------------- */
/* Delivery — the seam a real provider plugs into                            */
/* -------------------------------------------------------------------------- */

/**
 * How a delivered code reaches the operator.
 *
 * An implementation must send the code over a channel the SERVER already
 * trusts (an enrolled phone, a corporate mail relay). Nothing here may echo the
 * code back to the caller of the HTTP API.
 */
export interface MfaDeliverer {
  readonly channel: string;
  send(to: string, code: string, expiresInSeconds: number): Promise<void>;
}

/**
 * Onsite delivery over the server's own log.
 *
 * This delivers a REAL random code — not a constant, and not bypassable. It is
 * the default because it needs no third-party credentials, and it is honest
 * about what it is: a channel for a single-site deployment. Production registers
 * an SMS/e-mail deliverer at boot with `setMfaDeliverer`.
 */
export const logDeliverer: MfaDeliverer = {
  channel: 'server-log',
  async send(to, code, expiresInSeconds) {
    // eslint-disable-next-line no-console
    console.warn(
      `[MFA ${this.channel}] code for ${to}: ${code} (expires in ${expiresInSeconds}s)`,
    );
  },
};

/** The deliverer the routes use. Replace at boot to plug in a real channel. */
let deliverer: MfaDeliverer = logDeliverer;

export function setMfaDeliverer(next: MfaDeliverer): void {
  deliverer = next;
}

export function getMfaDeliverer(): MfaDeliverer {
  return deliverer;
}


/* -------------------------------------------------------------------------- */
/* Break-glass: emergency access as an issued, expiring, audited object        */
/* -------------------------------------------------------------------------- */

export interface BreakGlassResult {
  ok: boolean;
  reason?: string;
  message?: string;
}

/**
 * Redeems a break-glass code.
 *
 * This REPLACES the old client-side check that accepted three hard-coded
 * strings and skipped password verification entirely. A grant is now an issued
 * row: single use, expiring, attributable to the issuer, and recorded.
 */
export async function redeemBreakGlass(
  code: string,
  usedBy: string,
  tenantId: string,
): Promise<BreakGlassResult> {
  const normalised = String(code || '').trim();
  if (!normalised) return { ok: false, reason: 'empty', message: 'الرمز مطلوب' };

  const hash = sha256(normalised);

  // Only live grants: unexpired and not yet redeemed. `used_at IS NULL` is part
  // of the predicate, so two concurrent redemptions cannot both match.
  //
  // Scoped by tenant as well as by the code hash. `code_hash` is a unique
  // opaque digest, so this was not exploitable as written — but a break-glass
  // grant is the one credential in the system that bypasses MFA on purpose, and
  // the row must not be redeemable from a session belonging to another tenant
  // even if the digest were ever leaked or replayed. The tenant predicate makes
  // that a property of the query instead of a property of the digest's secrecy.
  const { rows } = await pool.query(
    `UPDATE dypos.break_glass_grants
        SET used_at = NOW(), used_by = $3
      WHERE tenant_id = $2 AND code_hash = $1 AND used_at IS NULL AND expires_at > NOW()
      RETURNING id`,
    [hash, tenantId, usedBy],
  );

  if (rows.length === 0) {
    return {
      ok: false,
      reason: 'invalid_or_expired',
      message: 'رمز الطوارئ غير صالح أو منتهي',
    };
  }

  return { ok: true };
}

/**
 * Issues a break-glass grant. Requires the caller's permission to be checked by
 * the route — this function assumes an authorised supervisor.
 */
export async function issueBreakGlassGrant(
  tenantId: string,
  issuedBy: string,
  reason: string,
  ttlMinutes = 15,
): Promise<{ id: string; code: string; expiresAt: string }> {
  const code = crypto.randomBytes(9).toString('base64url');
  const expiresAt = new Date(Date.now() + ttlMinutes * 60 * 1000);
  const id = makeId('bg');

  await pool.query(
    `INSERT INTO dypos.break_glass_grants
       (id, tenant_id, code_hash, issued_by, reason, expires_at)
     VALUES ($1,$2,$3,$4,$5,$6)`,
    [id, tenantId, sha256(code), issuedBy, String(reason || '').slice(0, 500), expiresAt.toISOString()],
  );

  return { id, code, expiresAt: expiresAt.toISOString() };
}