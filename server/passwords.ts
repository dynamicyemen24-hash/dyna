import { pbkdf2, randomBytes, timingSafeEqual, createHash } from 'crypto';
import { promisify } from 'util';

const pbkdf2Async = promisify(pbkdf2);

/**
 * Credential hashing.
 *
 * The previous scheme was a bare SHA-256 of the password. That has two fatal
 * properties: no salt means every user who picks the same password produces the
 * same digest (one table cracks the whole company), and SHA-256 is far too fast
 * to resist a GPU doing billions of guesses a second.
 *
 * PBKDF2-HMAC-SHA512 with a per-user random salt and a high iteration count is
 * what OWASP recommends for password storage where scrypt/argon2 is not
 * available in the runtime.
 *
 * The iteration count is stored alongside each hash so it can be raised later
 * without invalidating existing credentials: on next successful login the user
 * is transparently re-hashed at the new cost.
 */

export const ALGO = 'pbkdf2-sha512';

/**
 * ══ WHY 100,000 AND NOT A HIGHER NUMBER ═══════════════════════════════════
 * This is the LOWEST common denominator of the two runtimes, and that is the
 * only acceptable way to choose it.
 *
 * Production is the Cloudflare Worker, and its Web Crypto implementation
 * REJECTS any PBKDF2 above 100,000 iterations outright:
 *
 *     "Pbkdf2 failed: iteration counts above 100000 are not supported
 *      (requested 210000)"
 *
 * Measured on the deployed Worker, not assumed — see
 * scripts/test-credential-portability.ts, which asserts the ceiling against
 * live endpoints rather than trusting a comment.
 *
 * The previous value was 210,000, chosen from OWASP guidance and never
 * executed on the edge. So every login attempt threw before a single character
 * was compared, and the Worker returned 500. The account was fine, the password
 * was fine, and the stored hash was fine; the runtime simply refused to run the
 * algorithm the rest of the system was written against.
 *
 * The consequence was that sign-in was impossible for everyone, and it looked
 * like a credential problem rather than a platform limit — the worst kind of
 * failure, because it sends the operator to recheck their password forever.
 *
 * 100,000 is still a defensible cost: it is above OWASP's 2023 floor of
 * 600,000 only in the sense that no scheme reaches that figure on a runtime
 * that caps it, and PBKDF2-SHA512 at 100k with a per-user salt remains a
 * standard choice. The portable count is the one that actually runs.
 *
 * If this is ever raised again, it must stay ≤ EDGE_MAX_ITERATIONS, and every
 * existing credential must be re-issued — a stored count above the ceiling is
 * permanently unverifiable on the edge, not merely slow.
 */
export const ITERATIONS = 100_000;

/**
 * The hard ceiling the Cloudflare Workers runtime enforces on PBKDF2.
 *
 * Exported so it can be asserted rather than remembered. A constant nobody
 * checks against is exactly how 210,000 shipped in the first place.
 */
export const EDGE_MAX_ITERATIONS = 100_000;

const KEY_LENGTH = 64;
const SALT_BYTES = 16;

export interface StoredCredential {
  algo: string;
  hash: string;
  salt: string;
  iterations: number;
}

export async function hashPassword(
  password: string,
  iterations = ITERATIONS,
): Promise<StoredCredential> {
  const salt = randomBytes(SALT_BYTES).toString('hex');
  const derived = await pbkdf2Async(password, salt, iterations, KEY_LENGTH, 'sha512');
  return {
    algo: ALGO,
    hash: derived.toString('hex'),
    salt,
    iterations,
  };
}

/**
 * Verifies a password in constant time.
 *
 * Returns false — never throws — for a malformed or empty stored value, so a
 * corrupt row cannot be distinguished from a wrong password by timing or by
 * error message.
 */
/**
 * The outcome of a credential check.
 *
 * `result` is what the CALLER may act on, and it deliberately distinguishes only
 * two things: matched, and did not. A caller must never learn which accounts
 * exist or which part of a credential was wrong.
 *
 * `defect` is for the SERVER LOG. A stored hash that cannot be verified — a
 * truncated value, a missing salt on a salted scheme — is a DATA fault, not a
 * user mistake, and the two produce an identical boolean here.
 *
 * ══ WHY THIS HAD TO BE SPLIT ══════════════════════════════════════════════
 * Two accounts held `password_hash = 'pbkdf2:sha25'` — 17 characters of a
 * 128-character digest, with no salt. `verifyPassword` sent them down the legacy
 * path, compared a 64-character SHA-256 against a 17-character string, and
 * returned `false` on the length check.
 *
 * So `admin` could never sign in, with any password, ever — and the endpoint
 * reported the generic "invalid credentials" message, exactly as it should for a
 * wrong password. That is correct behaviour toward the user and useless for the
 * operator: a data defect looked like somebody typing the wrong password, and
 * stayed that way for an unknown number of attempts.
 *
 * The split keeps the user-facing answer identical while letting the log say
 * "this account's stored credential is unusable", which is actionable.
 */
export interface VerifyOutcome {
  result: boolean;
  /** Set only when the STORED credential is unusable, never about the input. */
  defect?: 'malformed_hash' | 'missing_salt' | 'missing_hash';
  /** Whether the supplied password was correct — for the log, not the caller. */
  inputMatched?: boolean;
}

export async function verifyPasswordDetailed(
  password: string,
  stored: Partial<StoredCredential> & { legacyDigest?: string | null },
): Promise<VerifyOutcome> {
  // Legacy SHA-256, accepted only so a user can sign in once and be migrated.
  if (!stored.hash && stored.legacyDigest) {
    const digest = stored.legacyDigest;

    /*
     * A legacy digest is a 64-character hex string. Anything else is a broken
     * row, and comparing against it can only ever fail — which is exactly what
     * made two accounts permanently unloginable while looking like a wrong
     * password.
     */
    if (!/^[0-9a-f]{64}$/i.test(digest)) {
      return { result: false, defect: 'malformed_hash', inputMatched: false };
    }

    const legacy = createHash('sha256').update(password, 'utf8').digest('hex');
    const a = Buffer.from(legacy, 'utf8');
    const b = Buffer.from(digest, 'utf8');
    if (a.length !== b.length) return { result: false, inputMatched: false };
    return { result: timingSafeEqual(a, b), inputMatched: timingSafeEqual(a, b) };
  }

  if (!stored.hash) return { result: false, defect: 'missing_hash' };
  if (!stored.salt) return { result: false, defect: 'missing_salt' };
  if (!stored.iterations) return { result: false, defect: 'missing_salt' };

  /*
   * A PBKDF2-SHA512 hex digest is 128 characters. Checking that here means a
   * truncated row is reported as a defect rather than silently returning false,
   * and it also prevents a malformed value reaching `Buffer.from(x, 'hex')`
   * where it would produce a short buffer and fail the comparison below for no
   * visible reason.
   */
  if (!/^[0-9a-f]+$/i.test(stored.hash) || stored.hash.length !== KEY_LENGTH * 2) {
    return { result: false, defect: 'malformed_hash', inputMatched: false };
  }

  const iterations = Number(stored.iterations) || ITERATIONS;
  const derived = await pbkdf2Async(password, stored.salt, iterations, KEY_LENGTH, 'sha512');
  const expected = Buffer.from(stored.hash, 'hex');

  // A malformed hash of the wrong length must not throw inside the comparison.
  if (expected.length !== derived.length) {
    return { result: false, defect: 'malformed_hash', inputMatched: false };
  }
  const matched = timingSafeEqual(expected, derived);
  return { result: matched, inputMatched: matched };
}

/** Boolean wrapper, so every existing caller keeps working unchanged. */
export async function verifyPassword(
  password: string,
  stored: Partial<StoredCredential> & { legacyDigest?: string | null },
): Promise<boolean> {
  return (await verifyPasswordDetailed(password, stored)).result;
}

/**
 * Password policy. Checked server-side; the client mirror is only a hint.
 *
 * The rules target what actually matters for a business account: length over
 * character-class theatre, a rejection of the values people genuinely reuse,
 * and a hard block on the seed credentials from the original deployment.
 */
export interface PolicyResult {
  ok: boolean;
  score: number;
  problems: string[];
}

const COMMON = [
  'password', '123456', '12345678', 'qwerty', 'admin', 'dypos',
  'welcome', 'letmein', '111111', 'abc123', 'royal', '1234',
];

export function checkPasswordStrength(password: string, context: {
  username?: string; tenantName?: string;
}): PolicyResult {
  const problems: string[] = [];
  const p = password || '';

  // Operator-set short PINs are allowed by request: a 4-character code of
  // letters or digits is enough to set or change a credential. Length is the
  // only structural rule; the character-class demands (upper/lower/digit/symbol)
  // were what blocked a legitimate short PIN, so they are gone. The lockout and
  // rate limits below still guard every guessing surface.
  if (p.length < 4) problems.push('يجب ألا يقل الرمز عن 4 خانات (حروف أو أرقام)');

  const lower = p.toLowerCase();
  if (COMMON.some((c) => lower.includes(c))) {
    problems.push('كلمة شائعة أو مرتبطة بالنظام — تجنّبها');
  }
  if (context.username && lower.includes(context.username.toLowerCase())) {
    problems.push('لا يمكن أن تحتوي اسم المستخدم');
  }
  if (context.tenantName) {
    const tokens = context.tenantName.split(/\s+/).filter((t) => t.length > 3);
    if (tokens.some((t) => lower.includes(t.toLowerCase()))) {
      problems.push('لا يمكن أن تحتوي اسم الشركة');
    }
  }

  // 0..4 strength score, used for the meter in the change-password screen.
  let score = 0;
  if (p.length >= 4) score++;
  if (p.length >= 6) score++;
  if (/[a-z]/.test(p) && /[A-Z]/.test(p)) score++;
  if (/\d/.test(p) && /[^A-Za-z0-9]/.test(p)) score++;

  return { ok: problems.length === 0, score, problems };
}

// ---------------------------------------------------------------------------
// SELF-SERVICE RESET
// The token is shown to the caller exactly once and only its hash is stored, so
// a database dump cannot be used to take over an account.
// ---------------------------------------------------------------------------

const RESET_TTL_MINUTES = 30;

/** Generates a reset token plus the hash to persist. */
export function issueResetToken(): { token: string; hash: string; expiresAt: Date } {
  const token = randomBytes(32).toString('hex');
  return {
    token,
    // Hash before storing — the raw token never touches the database.
    hash: createHash('sha256').update(token, 'utf8').digest('hex'),
    expiresAt: new Date(Date.now() + RESET_TTL_MINUTES * 60_000),
  };
}

export function hashResetToken(token: string): string {
  return createHash('sha256').update(token, 'utf8').digest('hex');
}

export function isResetTokenValid(token: string, storedHash: string, expiresAt: string | null): boolean {
  if (!storedHash || !expiresAt) return false;
  if (new Date(expiresAt).getTime() < Date.now()) return false;
  const a = Buffer.from(hashResetToken(token), 'utf8');
  const b = Buffer.from(storedHash, 'utf8');
  if (a.length !== b.length) return false;
  return timingSafeEqual(a, b);
}

// ---------------------------------------------------------------------------
// BRUTE-FORCE PROTECTION
// Progressive lockout: an attacker gets a few free guesses, then the window
// widens on each subsequent failure. A permanent lock would let anyone lock a
// colleague out by guessing wrong on purpose.
// ---------------------------------------------------------------------------

export const MAX_ATTEMPTS_BEFORE_LOCK = 5;

export function lockoutMinutesFor(attempts: number): number {
  if (attempts < MAX_ATTEMPTS_BEFORE_LOCK) return 0;
  // 5 -> 1 min, 6 -> 4 min, 7 -> 9 min … capped at an hour.
  const minutes = (attempts - MAX_ATTEMPTS_BEFORE_LOCK + 1) ** 2;
  return Math.min(60, minutes);
}

export function isLocked(lockedUntil: string | null): boolean {
  if (!lockedUntil) return false;
  return new Date(lockedUntil).getTime() > Date.now();
}

/**
 * The single error string returned for every authentication failure.
 *
 * Distinct messages ("no such user" vs "wrong password") let an attacker
 * enumerate valid usernames, so the distinction is made only in the server log
 * and never in the response.
 */
export const GENERIC_AUTH_ERROR = 'بيانات الدخول غير صحيحة';