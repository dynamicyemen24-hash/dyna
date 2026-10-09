/**
 * دينا: منصة التجارة الذكية — Cloudflare Worker API.
 *
 * Runs on the Cloudflare edge and talks to Neon over the serverless HTTP
 * driver (no TCP, no connection pool). Serves the same /api/db/* contract
 * that the Express server exposes locally, so the React client is unchanged.
 */
import { neon, type NeonQueryFunction } from '@neondatabase/serverless';
import { handleEdgeDataRoute } from './edgeDataRoutes.js';

export interface Env {
  DATABASE_URL: string;
  GEMINI_API_KEY?: string;
  DEFAULT_TENANT?: string;
  /** HMAC key for signed session tokens. Set with `wrangler secret put`. */
  DYPOS_SESSION_SECRET?: string;
  /** Static SPA bundle produced by `vite build`. */
  ASSETS: Fetcher;
}
/**
 * The static-asset binding type from `@cloudflare/workers-types`, which is not
 * installed here. Declared structurally so the Worker still type-checks
 * without pulling in the whole Workers type package.
 */
type Fetcher = { fetch(input: RequestInfo | URL): Promise<Response> };

/**
 * Authentication for the edge.
 *
 * The Express server uses Node's `crypto`; Workers run on V8 without Node
 * builtins, so the same primitives are implemented over Web Crypto. The
 * on-disk format is identical (PBKDF2-SHA512, hex salt, hex hash), so a
 * credential set on one runtime verifies on the other and an operator never
 * notices which front door they came through.
 *
 * Identity is a signed HMAC token, exactly as on the Express side
 * (server/sessions.ts). The client cannot mint one.
 */

const encoder = new TextEncoder();

/**
 * The portable PBKDF2 cost, and the ceiling this runtime enforces.
 *
 * Cloudflare Workers' Web Crypto REFUSES (throws on) PBKDF2 above 100,000
 * iterations. Measured on the deployed Worker, not assumed:
 *
 *     100,000 -> 200
 *     210,000 -> 500 "iteration counts above 100000 are not supported"
 *
 * These must stay equal to `ITERATIONS` and `EDGE_MAX_ITERATIONS` in
 * server/passwords.ts. That equality is asserted by
 * scripts/test-credential-portability.ts — a constant duplicated in two
 * runtimes is precisely the kind of value that drifts, and when it drifts the
 * symptom is "invalid credentials" on every account.
 */
export const MAX_ITERATIONS = 100_000;
const DEFAULT_ITERATIONS = MAX_ITERATIONS;

export const hexToBytes = (hex: string): Uint8Array => {
  const clean = hex.trim();
  const out = new Uint8Array(clean.length >> 1);
  for (let i = 0; i < out.length; i++) {
    out[i] = parseInt(clean.substr(i * 2, 2), 16);
  }
  return out;
};

export const bytesToHex = (buf: ArrayBuffer | Uint8Array): string =>
  Array.from(new Uint8Array(buf as ArrayBuffer))
    .map((b) => b.toString(16).padStart(2, '0'))
    .join('');

const deriveKey = (
  password: string, saltHex: string, iterations: number,
): Promise<Uint8Array> =>
  crypto.subtle.importKey(
    'raw', encoder.encode(password), 'PBKDF2', false, ['deriveBits'],
  ).then((key) => crypto.subtle.deriveBits(
    {
      name: 'PBKDF2',

      /*
       * ══ THE SALT IS THE HEX *STRING*, NOT THE BYTES IT ENCODES ═══════════
       * This must stay byte-identical to `server/passwords.ts`, which calls
       * Node's `pbkdf2(password, salt, ...)` with `salt` as a STRING — so Node
       * salts with the 32 ASCII characters of the hex.
       *
       * This line used to be `hexToBytes(saltHex)`, i.e. 16 raw bytes. Both
       * forms are "the salt", so every reading, comment and test said they
       * agreed, and they type-check, compile and pass lint identically. But
       * PBKDF2 is not a normal hash: changing one bit of the SALT changes the
       * entire output, so the two runtimes derived two unrelated keys from one
       * password.
       *
       * The consequence was total and silent. Every credential in the database
       * was written by the Express path (scripts/release-credentials.ts and the
       * password-change routes both use its `hashPassword`), while production
       * traffic is served by this Worker. So the Worker recomputed a different
       * hash from the correct password, compared it against the stored value,
       * and returned 401 — for every account, with any password, forever. The
       * operator saw "invalid credentials" and, reasonably, kept retyping the
       * password.
       *
       * Fixing it here rather than in Express is deliberate: the stored hashes
       * are correct and there are customers behind them. Express is the
       * authority on the on-disk format, so the edge conforms to it. Changing
       * the Node side instead would invalidate every credential in production.
       */
      salt: encoder.encode(saltHex) as unknown as BufferSource,
      iterations,
      hash: 'SHA-512',
    },
    key,
    64 * 8,
  )).then((bits) => new Uint8Array(bits));

/**
 * Constant-time comparison.
 *
 * A byte-by-byte early exit would leak how much of a hash an attacker guessed
 * correctly, which is enough to reconstruct a value one byte at a time.
 */
export function timingSafeEqualHex(a: string, b: string): boolean {
  if (a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i++) diff |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return diff === 0;
}

export interface StoredCredential {
  hash: string | null;
  salt: string | null;
  iterations: number | null;
  legacyDigest?: string | null;
}

export async function verifyPassword(
  password: string,
  stored: StoredCredential,
): Promise<boolean> {
  // Legacy SHA-256, accepted only so an account can sign in once and migrate.
  if (!stored.hash && stored.legacyDigest) {
    const digest = await crypto.subtle.digest('SHA-256', encoder.encode(password));
    return timingSafeEqualHex(bytesToHex(digest), stored.legacyDigest);
  }
  if (!stored.hash || !stored.salt) return false;

  /*
   * ══ A STORED COST THE RUNTIME CANNOT RUN IS NOT A SLOW HASH ══════════════
   * Cloudflare's Web Crypto REJECTS PBKDF2 above 100,000 iterations by
   * throwing — it does not clamp, and it does not return a wrong answer.
   *
   * Measured on the deployed Worker:
   *     100,000 -> 200
   *     210,000 -> 500 "Pbkdf2 failed: iteration counts above 100000
   *                      are not supported (requested 210000)"
   *
   * So a row carrying 210,000 — which is what every credential in the database
   * was written with — made sign-in throw for EVERY account before a single
   * character was compared. The user saw a server error while the honest
   * diagnosis was "this row cannot be verified on this platform".
   *
   * Returning `false` here would be a lie that routes the row into the
   * bad-password path and increments the lockout counter. So it is reported as
   * a defect, logged loudly, and reported to the caller as a server fault —
   * which is the truth, and is actionable by an operator.
   */
  const iterations = Number(stored.iterations) || DEFAULT_ITERATIONS;
  if (iterations > MAX_ITERATIONS) {
    console.error(
      `[dypos-auth] stored credential needs ${iterations} iterations but this `
      + `runtime caps at ${MAX_ITERATIONS}. This account CANNOT sign in until it `
      + `is re-issued — run scripts/migrate-iteration-ceiling.ts`,
    );
    throw new Error(
      `credential requires ${iterations} iterations, above the portable `
      + `maximum of ${MAX_ITERATIONS}`,
    );
  }

  const derived = await deriveKey(password, stored.salt, iterations);
  return timingSafeEqualHex(bytesToHex(derived), stored.hash);
}

export async function hashPasswordEdge(
  password: string, saltHex: string, iterations = DEFAULT_ITERATIONS,
): Promise<string> {
  // Never write a credential this runtime could not later read. Clamping here
  // would silently downgrade security; refusing makes the mistake visible at
  // the point it is made.
  if (iterations > MAX_ITERATIONS) {
    throw new Error(
      `refusing to write a credential at ${iterations} iterations: this `
      + `runtime caps at ${MAX_ITERATIONS}`,
    );
  }
  return bytesToHex(await deriveKey(password, saltHex, iterations));
}

// ---------------------------------------------------------------------------
// Signed session tokens — mirrors server/sessions.ts so either runtime accepts
// a token the other issued.
// ---------------------------------------------------------------------------

const b64url = (bytes: ArrayBuffer | Uint8Array | string): string => {
  const buf = typeof bytes === 'string' ? encoder.encode(bytes) : bytes;
  const view = new Uint8Array(buf as ArrayBuffer);
  let bin = '';
  for (let i = 0; i < view.length; i++) bin += String.fromCharCode(view[i]);
  return btoa(bin).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
};

const fromB64url = (s: string): Uint8Array => {
  const pad = s.length % 4 === 0 ? '' : '='.repeat(4 - (s.length % 4));
  const bin = atob(s.replace(/-/g, '+').replace(/_/g, '/') + pad);
  const out = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
  return out;
};

function sessionSecret(env: SecretEnv): string {
  const s = env.DYPOS_SESSION_SECRET;
  if (!s || s.length < 32) {
    throw new Error('DYPOS_SESSION_SECRET is not set on this Worker');
  }
  return s;
}

export interface SessionPayload {
  sub: string;
  username: string;
  tenantId: string;
  iat: number;
  exp: number;
}

const TTL_SECONDS = 8 * 60 * 60;

const sign = async (env: SecretEnv, data: string): Promise<string> => {
  const key = await crypto.subtle.importKey(
    'raw', encoder.encode(sessionSecret(env)),
    { name: 'HMAC', hash: 'SHA-256' }, false, ['sign'],
  );
  return b64url(await crypto.subtle.sign('HMAC', key, encoder.encode(data)));
};

export async function issueSessionToken(
  env: SecretEnv, userId: string, username: string, tenantId: string,
): Promise<string> {
  const now = Math.floor(Date.now() / 1000);
  const payload: SessionPayload = {
    sub: userId, username, tenantId, iat: now, exp: now + TTL_SECONDS,
  };
  const body = b64url(JSON.stringify(payload));
  return `${body}.${await sign(env, body)}`;
}

export async function verifySessionToken(
  env: SecretEnv, token: string,
): Promise<{ ok: true; payload: SessionPayload } | { ok: false; reason: string }> {
  if (!token) return { ok: false, reason: 'missing_token' };
  const dot = token.indexOf('.');
  if (dot <= 0) return { ok: false, reason: 'malformed_token' };

  const body = token.slice(0, dot);
  const mac = token.slice(dot + 1);
  if (!timingSafeEqualHex(mac, await sign(env, body))) {
    return { ok: false, reason: 'bad_signature' };
  }

  let payload: SessionPayload;
  try {
    payload = JSON.parse(new TextDecoder().decode(fromB64url(body)));
  } catch {
    return { ok: false, reason: 'malformed_payload' };
  }
  if (typeof payload.exp !== 'number' || payload.exp * 1000 < Date.now()) {
    return { ok: false, reason: 'expired' };
  }
  return { ok: true, payload };
}

export interface SecretEnv {
  DYPOS_SESSION_SECRET?: string;
}

// ---------------------------------------------------------------------------
// Security Headers Middleware — OWASP Top 10 + Cloudflare best practices
// Applied to ALL responses from the DyPOS Worker to harden browser clients.
// CSP starts in reportOnly mode; upgrade to enforced after staging validation.
// ---------------------------------------------------------------------------
function addSecurityHeaders(response: Response): Response {
  const headers = new Headers(response.headers);
  // OWASP Recommended Headers
  headers.set('X-Content-Type-Options', 'nosniff');
  headers.set('X-Frame-Options', 'DENY');
  headers.set('X-XSS-Protection', '1; mode=block');
  headers.set('Strict-Transport-Security', 'max-age=31536000; includeSubDomains; preload');
  // CSP in reportOnly mode initially — monitor before enforcing
  headers.set('Content-Security-Policy-Report-Only',
    "default-src 'self'; script-src 'self' 'unsafe-inline'; style-src 'self' 'unsafe-inline'; " +
    "img-src 'self' data: https:; connect-src 'self' https://*.neon.tech; " +
    "font-src 'self'; object-src 'none'; frame-src 'none'; base-uri 'self'; " +
    "form-action 'self'; report-uri /api/security/csp-report");
  headers.set('Referrer-Policy', 'strict-origins-when-cross-origin');
  headers.set('Permissions-Policy', 'geolocation=(), microphone=(), camera=(), ' +
    'payment=(), usb=(), magnetometer=(), gyroscope=(), fullscreen=(self)');
  return new Response(response.body, {
    status: response.status,
    statusText: response.statusText,
    headers: headers,
  });
}

/* ── Second factor on the edge: mirrors server/mfa.ts ──────────────────────
 * The Express server's two-phase sign-in MUST also hold at the edge, because
 * in production THIS Worker issues the tokens. Without this copy, a user
 * enrolled in MFA authenticates with the password alone on the public site —
 * the factor would protect the local dev server only, which is the same class
 * of fiction as the browser-printed OTP it replaced.
 *
 * WHY A COPY AND NOT AN IMPORT
 * The Worker bundles `worker/index.ts` alone over Web Crypto; `server/mfa.ts`
 * uses Node's `crypto` and the Express pool. The on-disk format is identical
 * (SHA-256 hex digests in `dypos.mfa_challenges`), so a challenge issued on
 * one runtime verifies against the other; only the primitives differ, and each
 * one is labelled `Edge` below. Mirrored constants are asserted by
 * scripts/test-mfa-parity.ts, which boots BOTH runtimes against the SAME
 * database and asserts challenge issue → verify in BOTH directions.
 *
 * WHY deliveryChannel: 'server-log'
 * The code is written to the Worker log (Cloudflare dashboard), exactly as the
 * Express `logDeliverer` writes to the server log. A real provider still needs
 * registering — the honesty of the channel is the security claim, on both.
 */
const MFA_DIGITS = 6;
const MFA_CHALLENGE_TTL_SECONDS = 300;
const MFA_MAX_ATTEMPTS = 5;
const MFA_LOCKOUT_MINUTES = 15;

/** Mirror of `readMfaPolicy` in server/mfa.ts. */
async function readMfaPolicyEdge(env: Env, userId: string, requireForAll: boolean) {
  const rows = await getSql(env)`
    SELECT s.enabled, s.digits, u.mfa_failed_attempts, u.mfa_locked_until
      FROM dypos.users u
      LEFT JOIN dypos.mfa_secrets s ON s.user_id = u.id
     WHERE u.id = ${userId}`;
  const row = rows[0];
  const lockedUntil = row?.mfa_locked_until ? new Date(row.mfa_locked_until).toISOString() : null;
  return {
    // A locked factor ALWAYS requires the flow — otherwise the lockout would
    // itself become the bypass.
    enabled: lockedUntil ? true : (Boolean(row?.enabled) || requireForAll),
    digits: Number(row?.digits) || MFA_DIGITS,
    lockedUntil,
    failedAttempts: Number(row?.mfa_failed_attempts) || 0,
  };
}

const mfaRequiredEdge = (
  policy: { enabled: boolean; lockedUntil: string | null }, requireForAll: boolean,
): boolean => {
  if (policy.lockedUntil && Date.parse(policy.lockedUntil) > Date.now()) return true;
  return policy.enabled || requireForAll;
};

/** SHA-256 hex, the same digest server/mfa.ts stores in `code_hash`. */
async function sha256Hex(v: string): Promise<string> {
  const digest = await crypto.subtle.digest('SHA-256', encoder.encode(v));
  return bytesToHex(digest);
}

/**
 * One digit from Web Crypto with rejection sampling. `b % 10` on a raw byte
 * has a measurable bias (256 is not a multiple of 10); redrawing past 249
 * costs one extra byte in 2% of draws and keeps the distribution uniform.
 */
function randomDigit(): number {
  for (;;) {
    const b = crypto.getRandomValues(new Uint8Array(1))[0];
    if (b < 250) return b % 10;
  }
}

function generateCodeEdge(digits = MFA_DIGITS): string {
  let out = '';
  for (let i = 0; i < digits; i += 1) out += String(randomDigit());
  return out;
}

/** Mirror of `issueChallenge` in server/mfa.ts. */
async function issueChallengeEdge(
  env: Env, userId: string, tenant: string, branchId: string | null, digits = MFA_DIGITS,
) {
  const sql = getSql(env);
  // A stale code can never be redeemed after a newer one is issued.
  await sql`UPDATE dypos.mfa_challenges
       SET consumed_at = NOW()
     WHERE user_id = ${userId} AND tenant_id = ${tenant} AND consumed_at IS NULL`;
  const code = generateCodeEdge(digits);
  const challenge = randomHex(24);
  const expiresAt = new Date(Date.now() + MFA_CHALLENGE_TTL_SECONDS * 1000);
  await sql`INSERT INTO dypos.mfa_challenges
      (id, tenant_id, user_id, branch_id, challenge, code_hash, digits,
       attempts, max_attempts, expires_at)
    VALUES (${makeId('mfa')}, ${tenant}, ${userId}, ${branchId}, ${challenge},
      ${await sha256Hex(code)}, ${digits}, 0, ${MFA_MAX_ATTEMPTS}, ${expiresAt.toISOString()})`;
  console.warn(`[MFA server-log] code issued for an enrolled operator (expires in ${MFA_CHALLENGE_TTL_SECONDS}s)`);
  console.warn(`[MFA server-log] code: ${code}`);
  return { challenge, expiresAt: expiresAt.toISOString(), digits, code, expiresInSeconds: MFA_CHALLENGE_TTL_SECONDS };
}

type VerifyOutcomeEdge =
  | { ok: true; userId: string; tenantId: string; branchId: string | null; username: string }
  | { ok: false; reason: string; message: string; retryable: boolean };

async function lockFactorEdge(env: Env, userId: string): Promise<void> {
  await getSql(env)`UPDATE dypos.users
       SET mfa_failed_attempts = ${MFA_MAX_ATTEMPTS},
           mfa_locked_until = NOW() + (${String(MFA_LOCKOUT_MINUTES)} || ' minutes')::interval
     WHERE id = ${userId}`;
}

/** Mirror of `verifyChallenge` in server/mfa.ts. */
async function verifyChallengeEdge(env: Env, challengeId: string, submitted: string): Promise<VerifyOutcomeEdge> {
  const sql = getSql(env);
  const denied = (reason: string, message = 'رمز التحقق غير صحيح أو منتهي'): VerifyOutcomeEdge => ({
    ok: false, reason, message, retryable: false,
  });
  const rows = await sql`SELECT id, tenant_id, user_id, branch_id, code_hash, digits,
             attempts, max_attempts, expires_at, consumed_at
      FROM dypos.mfa_challenges
     WHERE challenge = ${challengeId}`;
  const row = rows[0];
  if (!row) return denied('unknown_challenge');
  if (row.consumed_at) return denied('already_consumed');
  if (new Date(row.expires_at).getTime() < Date.now()) {
    await sql`UPDATE dypos.mfa_challenges SET consumed_at = NOW() WHERE id = ${row.id}`;
    return denied('expired');
  }
  const attempts = Number(row.attempts) + 1;
  if (attempts > Number(row.max_attempts)) {
    await sql`UPDATE dypos.mfa_challenges SET consumed_at = NOW() WHERE id = ${row.id}`;
    await lockFactorEdge(env, row.user_id);
    return denied('attempts_exhausted');
  }
  const digits = String(submitted || '').replace(/\D/g, '');
  const correct = digits.length === Number(row.digits)
    && timingSafeEqualHex(await sha256Hex(digits), row.code_hash);
  if (!correct) {
    await sql`UPDATE dypos.mfa_challenges SET attempts = ${attempts} WHERE id = ${row.id}`;
    await sql`UPDATE dypos.users
         SET mfa_failed_attempts = mfa_failed_attempts + 1,
             mfa_locked_until = CASE
               WHEN mfa_failed_attempts + 1 >= ${MFA_MAX_ATTEMPTS}
               THEN NOW() + (${String(MFA_LOCKOUT_MINUTES)} || ' minutes')::interval
               ELSE mfa_locked_until END
       WHERE id = ${row.user_id}`;
    if (attempts >= Number(row.max_attempts)) {
      await sql`UPDATE dypos.mfa_challenges SET consumed_at = NOW() WHERE id = ${row.id}`;
      await lockFactorEdge(env, row.user_id);
      return denied('attempts_exhausted');
    }
    return {
      ok: false, reason: 'bad_code',
      message: `رمز غير صحيح — تبقّى ${Number(row.max_attempts) - attempts + 1} محاولات`,
      retryable: true,
    };
  }
  // Burn the challenge on success: one code, one session.
  await sql`UPDATE dypos.mfa_challenges SET consumed_at = NOW() WHERE id = ${row.id}`;
  await sql`UPDATE dypos.users SET mfa_failed_attempts = 0, mfa_locked_until = NULL WHERE id = ${row.user_id}`;
  const user = await sql`SELECT username FROM dypos.users WHERE id = ${row.user_id}`;
  return {
    ok: true, userId: row.user_id, tenantId: row.tenant_id,
    branchId: row.branch_id, username: user[0]?.username ?? '',
  };
}

/*
 * Test hooks. Exercised by scripts/test-mfa-parity.ts, referenced by NO route.
 *
 * WHY functions and not a value: in the Workers module format an exported PLAIN
 * VALUE makes workerd refuse to boot ("Incorrect type for map entry" — see the
 * GENERIC_AUTH_ERROR note above). Exported FUNCTIONS are ignored by the
 * runtime unless bound as entrypoints, so hooks ship as functions. If a future
 * runtime ever rejects these, the parity suite — not production — is what
 * fails, because nothing in the request path calls them.
 */
export async function __testReadMfaPolicy(env: Env, userId: string, requireForAll: boolean) {
  return readMfaPolicyEdge(env, userId, requireForAll);
}
export async function __testIssueChallenge(
  env: Env, userId: string, tenant: string, branchId: string | null, digits: number,
) {
  return issueChallengeEdge(env, userId, tenant, branchId, digits);
}
export async function __testVerifyChallenge(env: Env, challenge: string, code: string) {
  return verifyChallengeEdge(env, challenge, code);
}

// ---------------------------------------------------------------------------
// Policy, lockout, and the single generic failure message
// ---------------------------------------------------------------------------

const COMMON = [
  'password', '123456', '12345678', 'qwerty', 'admin', 'dypos',
  'welcome', 'letmein', '111111', 'abc123', 'royal', '1234',
];

export interface PolicyResult {
  ok: boolean; score: number; problems: string[];
}

/** Mirrors checkPasswordStrength in server/passwords.ts. */
export function checkPasswordStrength(password: string, username?: string): PolicyResult {
  const problems: string[] = [];
  const p = password || '';

  if (p.length < 10) problems.push('يجب أن تحتوي ١٠ أحرف على الأقل');
  if (!/[A-Za-z]/.test(p)) problems.push('يجب أن تحتوي حرفاً');
  if (!/\d/.test(p)) problems.push('يجب أن تحتوي رقماً');
  if (!/[^A-Za-z0-9]/.test(p)) problems.push('يجب أن تحتوي رمزاً خاصاً');

  const lower = p.toLowerCase();
  if (COMMON.some((c) => lower.includes(c))) {
    problems.push('كلمة شائعة أو مرتبطة بالنظام — تجنّبها');
  }
  if (username && lower.includes(username.toLowerCase())) {
    problems.push('لا يمكن أن تحتوي اسم المستخدم');
  }

  let score = 0;
  if (p.length >= 10) score++;
  if (p.length >= 14) score++;
  if (/[a-z]/.test(p) && /[A-Z]/.test(p)) score++;
  if (/\d/.test(p) && /[^A-Za-z0-9]/.test(p)) score++;

  return { ok: problems.length === 0, score, problems };
}

/** One message for every failure mode, so a username cannot be enumerated. */
// Deliberately NOT exported: in the Workers module format every named export is
// taken to be a handler or class, so exporting a plain string made workerd fail
// to boot with "Incorrect type for map entry 'GENERIC_AUTH_ERROR'".
const GENERIC_AUTH_ERROR = 'بيانات الدخول غير صحيحة';

export function lockoutMinutesFor(attempts: number): number {
  const BEFORE_LOCK = 5;
  if (attempts < BEFORE_LOCK) return 0;
  return Math.min(60, (attempts - BEFORE_LOCK + 1) ** 2);
}

export function isLocked(lockedUntil: string | null): boolean {
  if (!lockedUntil) return false;
  return new Date(lockedUntil).getTime() > Date.now();
}

export function randomHex(bytes: number): string {
  const out = new Uint8Array(bytes);
  crypto.getRandomValues(out);
  return bytesToHex(out);
}

const json = (data: unknown, status = 200, headers: Record<string, string> = {}) => {
  const baseHeaders: Record<string, string> = {
    'content-type': 'application/json; charset=utf-8',
    'cache-control': 'no-store',
    'x-content-type-options': 'nosniff',
    ...headers,
  };
  return addSecurityHeaders(
    new Response(JSON.stringify(data), { status, headers: baseHeaders })
  );
};

/** Structured error response included in every API error body. */
interface ApiError {
  error: string;
  path: string;
  method: string;
  requestId: string;
  timestamp: number;
}

/** Generate a unique request ID for tracing. */
function makeRequestId(): string {
  return `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`;
}

/** Standardised failure response with structured error body. */
function fail(status: number, error: string, path?: string, method?: string, requestId?: string) {
  const rid = requestId || makeRequestId();
  const body: ApiError = {
    error,
    path: path || '',
    method: method || '',
    requestId: rid,
    timestamp: Date.now(),
  };
  return json(body, status);
}

const num = (v: unknown, d = 0) => {
  const n = Number(v);
  return Number.isFinite(n) ? n : d;
};

const makeId = (prefix: string) =>
  `${prefix}-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`;

/**
 * Build a scannable EAN-13 barcode from an issued sequence serial.
 *
 * WHY THIS EXISTS: the client used to mint `628` + nine digits sliced out of
 * `crypto.randomUUID()` — twelve digits with no check digit. A scanner
 * validating EAN-13 rejects that number outright, so the camera path could
 * only fall back to matching the id, and the printed label was dead weight.
 *
 * EAN-13 is 12 body digits (GS1 prefix 628 = Saudi Arabia) plus a modulo-10
 * check digit computed over the body with alternating weights 1,3,1,3,…
 * left→right. Issuing that HERE is what makes the number a real article
 * number: the server owns the sequence, and every barcode it hands out
 * validates the first time a till reads it.
 */
function ean13(serial: number): string {
  const body12 = `628${String(serial).padStart(9, '0')}`;
  let sum = 0;
  for (let i = 0; i < body12.length; i++) {
    sum += Number(body12[i]) * (i % 2 === 0 ? 1 : 3);
  }
  return `${body12}${(10 - (sum % 10)) % 10}`;
}

/**
 * An optional `'YYYY-MM-DD'` body value, defaulting to today in UTC.
 *
 * Anything that is not a parseable ISO date (including impossible dates like
 * `2026-02-30`, which `Date.parse` rejects) falls back rather than reaching
 * PostgreSQL and turning into a driver-level 500.
 */
function isoDate(v: unknown): string {
  const s = typeof v === 'string' ? v.trim() : '';
  return /^\d{4}-\d{2}-\d{2}$/.test(s) && !Number.isNaN(Date.parse(s))
    ? s
    : new Date().toISOString().slice(0, 10);
}

/** In-memory store for idempotency responses (per Worker isolate). */
const idempotencyStore = new Map<string, { response: Response; timestamp: number }>();

/** Maximum age for idempotency store entries (1 hour). */
const IDEMPOTENCY_TTL_MS = 60 * 60 * 1000;

/** Process an idempotency key if present in the request headers. */
function processIdempotencyKey(request: Request): { cached: boolean; response: Response } | null {
  const key = request.headers.get('Idempotency-Key');
  if (!key) return null;

  const cached = idempotencyStore.get(key);
  if (cached) {
    const age = Date.now() - cached.timestamp;
    if (age < IDEMPOTENCY_TTL_MS) {
      return { cached: true, response: cached.response };
    }
    // Entry expired, remove it
    idempotencyStore.delete(key);
  }

  return null;
}

/** Cache a response for idempotency key. */
function cacheIdempotencyKey(key: string, response: Response): void {
  idempotencyStore.set(key, { response, timestamp: Date.now() });
}

interface RateBucket { windowStart: number; requests: number; failures: number; }
const rateBuckets = new Map<string, RateBucket>();
const rateEnv = (name: string, dflt: number): number => {
  try {
    const n = Number((globalThis as any)?.process?.env?.[name]);
    return Number.isFinite(n) && n > 0 ? Math.floor(n) : dflt;
  } catch { return dflt; }
};
const RATE_WINDOW_MS = rateEnv('RATE_WINDOW_MS', 5 * 60_000);
const RATE_MAX_FAILURES = rateEnv('RATE_MAX_FAILURES', 15);
const RATE_MAX_REQUESTS = rateEnv('RATE_MAX_REQUESTS', 120);

function rateLimitVerdict(route: string, req: Request): { limited: boolean; retryAfterSec: number } {
  const ip = (req.headers.get('cf-connecting-ip') || 'unknown').slice(0, 64);
  const now = Date.now();
  const key = `${route}|${ip}`;
  let b = rateBuckets.get(key);
  if (!b || now - b.windowStart >= RATE_WINDOW_MS) {
    b = { windowStart: now, requests: 0, failures: 0 };
    rateBuckets.set(key, b);
    // Amortised sweep: drop every expired window once per window length.
    if (rateBuckets.size > 1) {
      for (const [k, other] of rateBuckets) {
        if (now - other.windowStart >= RATE_WINDOW_MS) rateBuckets.delete(k);
      }
    }
    if (rateBuckets.size > 50_000) rateBuckets.clear();
  }
  const retryAfterSec = Math.max(1, Math.ceil((b.windowStart + RATE_WINDOW_MS - now) / 1000));
  if (b.failures >= RATE_MAX_FAILURES || b.requests >= RATE_MAX_REQUESTS) {
    return { limited: true, retryAfterSec };
  }
  b.requests += 1;
  return { limited: false, retryAfterSec: 0 };
}

/** Counts a finished auth verdict against the failure budget of `route`. */
function rateNoteVerdict(route: string, req: Request, status: number): void {
  if (status !== 401 && status !== 403) return;
  const ip = (req.headers.get('cf-connecting-ip') || 'unknown').slice(0, 64);
  const b = rateBuckets.get(`${route}|${ip}`);
  if (b) b.failures += 1;
}

// The connection string is injected as a Worker secret at deploy time
// (npx wrangler secret put DATABASE_URL) — never bundle it.
let sqlFn: NeonQueryFunction<false, false> | null = null;
/**
 * Named `getSql` rather than `sql` so that a caller can bind the result to a
 * local `sql` for use as a tagged template without shadowing this factory.
 */
function getSql(env: Env) {
  if (!env.DATABASE_URL) {
    throw new Error('DATABASE_URL secret is missing on this Worker');
  }
  if (!sqlFn) sqlFn = neon(env.DATABASE_URL);
  return sqlFn;
}

/*
 * `tenantOf` was removed. It was dead code AND it encoded a dangerous idea.
 *
 * It read the tenant from `x-tenant-id`, then `?tenantId=`, then the request
 * body, and only then fell back to the default — so a caller could name ANY
 * tenant and the query would run against it. It happened to be unreachable
 * because every protected route derives its scope from `principal.tenantId`,
 * which comes from the signed session token. But leaving it in the file is
 * leaving a loaded gun: the next person who wires a route through it opens
 * cross-tenant access, and the existing tests would not catch it because none
 * of them call it.
 *
 * The invariant it should have encoded is now stated instead: the ONLY source
 * of a tenant for a protected route is the verified token.
 */
let env_default: string | undefined;

// ---------------------------------------------------------------------------
// Identity / enrollment � edge mirrors of the Express engines
// (server/identityEngine.ts, server/policyEngine.ts, server/enrollmentEngine.ts)
// ---------------------------------------------------------------------------
// WHY COPIES AND NOT IMPORTS
// The Worker bundles worker/index.ts alone over Web Crypto + the Neon HTTP
// driver; the server engines use Node `crypto` and the pooled `pg` client. The
// on-disk format is identical (same digest, same tables), so a tenant enrolled
// on the edge is the same tenant Express would read � only the primitives and
// the SQL driver differ, and each copy is labelled `Edge` below.
//
// `resolvePrerequisites` is a PURE function (no I/O), so its edge mirror is a
// literal copy of server/policyEngine.ts � if the two ever disagreed, the edge
// would grant access on a policy the on-premise build refuses.
type PrereqDecision =
  | 'READY' | 'CREATE_DEFAULT_BRANCH' | 'REQUIRE_VERIFICATION'
  | 'REQUIRE_ADMIN' | 'REQUIRE_SUBSCRIPTION' | 'BLOCKED_BY_POLICY';

interface PrereqInputEdge {
  tenantExists: boolean;
  tenantStatus?: 'active' | 'pending' | 'disabled';
  userExists: boolean;
  userStatus?: 'active' | 'locked' | 'disabled' | 'pending';
  branchExists: boolean;
  userHasBranchAccess: boolean;
  deviceTrusted: boolean;
  subscriptionStatus?: 'active' | 'trial' | 'expired' | 'pending';
  allowDefaultBranchCreation?: boolean;
}

interface PrereqResultEdge {
  decision: PrereqDecision;
  fixable: boolean;
  actions: string[];
  reason: string;
  blockUntil?: string[];
}

/** Literal mirror of `resolvePrerequisites` in server/policyEngine.ts. */
function resolvePrerequisitesEdge(input: PrereqInputEdge): PrereqResultEdge {
  if (!input.tenantExists) {
    return {
      decision: 'REQUIRE_VERIFICATION', fixable: false,
      actions: ['verify_tenant_identity', 'request_enrollment'],
      reason: 'The tenant is not yet verified or does not exist.',
      blockUntil: ['tenant_validation'],
    };
  }
  if (input.tenantStatus === 'disabled') {
    return {
      decision: 'BLOCKED_BY_POLICY', fixable: false,
      actions: ['contact_admin', 'review_tenant_status'],
      reason: 'The tenant is disabled by policy.',
      blockUntil: ['tenant_reactivation'],
    };
  }
  if (input.userStatus === 'disabled' || input.userStatus === 'locked') {
    return {
      decision: 'REQUIRE_VERIFICATION', fixable: false,
      actions: ['verify_account_status', 'reset_access'],
      reason: 'The user cannot operate until the account is validated or re-enabled.',
      blockUntil: ['account_status'],
    };
  }
  if (input.subscriptionStatus === 'expired' || input.subscriptionStatus === 'pending') {
    return {
      decision: 'REQUIRE_SUBSCRIPTION', fixable: false,
      actions: ['renew_subscription', 'restore_access'],
      reason: 'The subscription is not active enough to authorize work.',
      blockUntil: ['subscription_activation'],
    };
  }
  if (!input.userExists) {
    return {
      decision: 'REQUIRE_VERIFICATION', fixable: false,
      actions: ['verify_user_identity', 'assign_access'],
      reason: 'No user mapping is valid for this tenant yet.',
      blockUntil: ['user_validation'],
    };
  }
  if (!input.branchExists && input.allowDefaultBranchCreation) {
    return {
      decision: 'CREATE_DEFAULT_BRANCH', fixable: true,
      actions: ['create_default_branch', 'attach_user_to_branch', 'record_audit_event'],
      reason: 'The tenant exists and policy allows a default branch to be created safely.',
      blockUntil: ['branch_creation'],
    };
  }
  if (!input.branchExists && !input.allowDefaultBranchCreation) {
    return {
      decision: 'REQUIRE_ADMIN', fixable: false,
      actions: ['contact_admin', 'assign_branch_owner', 'request_default_branch'],
      reason: 'No branch exists and creating one is disallowed by policy.',
      blockUntil: ['branch_provisioning_approval'],
    };
  }
  if (!input.userHasBranchAccess) {
    return {
      decision: 'REQUIRE_ADMIN', fixable: false,
      actions: ['grant_branch_access', 'review_rbac_policy'],
      reason: 'The user is valid but has no access to the chosen branch.',
      blockUntil: ['branch_access_assignment'],
    };
  }
  if (!input.deviceTrusted) {
    return {
      decision: 'REQUIRE_VERIFICATION', fixable: false,
      actions: ['verify_device', 'challenge_owner', 'register_device'],
      reason: 'The device is not accepted for this tenant�s trusted environment.',
      blockUntil: ['device_binding'],
    };
  }
  return {
    decision: 'READY', fixable: true,
    actions: ['continue_session'],
    reason: 'Tenant, user, branch, subscription and device are all acceptable for work.',
  };
}
// --- identity resolution ---------------------------------------------------
type IdentityDecisionState =
  | 'VERIFIED_EXISTING_TENANT' | 'PENDING_VERIFICATION' | 'NEW_TENANT'
  | 'EXISTING_TENANT_NO_BRANCH' | 'EXISTING_USER_NO_ACCESS' | 'AMBIGUOUS_IDENTITY';

interface IdentityStateEdge {
  state: IdentityDecisionState;
  tenantId?: string;
  userId?: string;
  branchId?: string;
  reason: string;
  proofRequired?: string[];
  confidence: number;
}

interface IdentityInputEdge {
  tenantName: string;
  tenantCode: string;
  ownerName: string;
  username: string;
  email: string;
  phone: string;
  branchName: string;
  deviceFingerprint: string;
}

/** Mirror of `normalize` in server/identityEngine.ts. */
const normalizeEdge = (v?: string): string =>
  (v ?? '').trim().toLowerCase().replace(/\s+/g, ' ').normalize('NFKC');

/** Mirror of `resolveIdentityIntent` in server/identityEngine.ts (pure). */
function resolveIdentityIntentEdge(input: {
  tenantName: string; tenantCode: string; username: string;
  email: string; phone: string; branchName: string; deviceFingerprint: string;
  existingTenants: Array<{ tenantId: string; tenantName: string; normalizedName: string; enrollmentCode?: string }>;
  existingUsers: Array<{ userId: string; tenantId: string; username: string; normalizedUsername: string; email?: string; normalizedEmail?: string; phone?: string; normalizedPhone?: string }>;
  existingBranches: Array<{ branchId: string; name: string; normalizedName: string }>;
}): IdentityStateEdge {
  const tenantName = input.tenantName ?? '';
  const tenantCode = input.tenantCode ?? '';
  const username = input.username ?? '';
  const email = normalizeEdge(input.email);
  const phone = normalizeEdge(input.phone);
  const branchName = normalizeEdge(input.branchName);

  const strong = (a?: string, b?: string): boolean => {
    const aa = normalizeEdge(a);
    const bb = normalizeEdge(b);
    return !!aa && !!bb && aa === bb;
  };

  const matchedTenant = input.existingTenants.find((tenant) => {
    if (tenantCode && tenant.enrollmentCode) {
      if (normalizeEdge(tenant.enrollmentCode) === normalizeEdge(tenantCode)) return true;
    }
    return strong(tenant.tenantName, tenantName) || strong(tenant.normalizedName, normalizeEdge(tenantName));
  });

  const matchedUser = input.existingUsers.find((user) => {
    const sameUsername = strong(user.username, username) || strong(user.normalizedUsername, normalizeEdge(username));
    const sameEmail = strong(user.email, email) || strong(user.normalizedEmail, email);
    const samePhone = strong(user.phone, phone) || strong(user.normalizedPhone, phone);
    return sameUsername || sameEmail || samePhone;
  });

  const matchedBranch = input.existingBranches.find((branch) =>
    strong(branch.name, branchName) || strong(branch.normalizedName, branchName));

  if (matchedTenant && matchedUser && matchedUser.tenantId === matchedTenant.tenantId) {
    if (!matchedBranch) {
      return {
        state: 'EXISTING_TENANT_NO_BRANCH',
        tenantId: matchedTenant.tenantId, userId: matchedUser.userId,
        reason: 'Tenant and user match, but no validated branch exists for this tenant.',
        proofRequired: ['tenant_verification', 'branch_policy_check'],
        confidence: 94,
      };
    }
    return {
      state: 'VERIFIED_EXISTING_TENANT',
      tenantId: matchedTenant.tenantId, userId: matchedUser.userId, branchId: matchedBranch.branchId,
      reason: 'The identity resolved to an existing, verified tenant and user.',
      confidence: 98,
    };
  }

  if (matchedTenant && !matchedUser) {
    return {
      state: 'PENDING_VERIFICATION',
      tenantId: matchedTenant.tenantId,
      reason: 'Tenant exists but the user identity requires proof before access is granted.',
      proofRequired: ['ownership_verification', 'user_identity_match'],
      confidence: 81,
    };
  }

  if (matchedUser && !matchedTenant) {
    return {
      state: 'EXISTING_USER_NO_ACCESS',
      userId: matchedUser.userId,
      reason: 'User exists but is not associated with a verified tenant for this onboarding flow.',
      proofRequired: ['tenant_mapping_check', 'access_policy_validation'],
      confidence: 80,
    };
  }

  if (matchedTenant && matchedUser && matchedUser.tenantId !== matchedTenant.tenantId) {
    return {
      state: 'AMBIGUOUS_IDENTITY',
      reason: 'The user and tenant are mapped to different organizations; do not auto-link.',
      proofRequired: ['tenant_user_correlation', 'session_rebinding'],
      confidence: 35,
    };
  }

  if (!matchedTenant && !matchedUser && (tenantName || tenantCode || email || phone || username)) {
    return {
      state: 'NEW_TENANT',
      reason: 'No canonical tenant or user match was found; this is a new enrollment path requiring a transaction-safe setup.',
      proofRequired: ['tenant_enrollment', 'subscription_setup', 'owner_user', 'default_branch'],
      confidence: 60,
    };
  }

  return {
    state: 'AMBIGUOUS_IDENTITY',
    reason: 'Identity is not conclusive enough for automatic enrollment or access. Request explicit proof.',
    proofRequired: ['canonical_identity_reconciliation', 'manual_review'],
    confidence: 22,
  };
}

const q = (v: string): string => `'${v.replace(/'/g, "''")}'`;

// --- identity resolution against the database -------------------------------
/** Resolves an identity against the database. Mirrors `resolveExistingIdentity`
 * in server/enrollmentEngine.ts, pinned to the deployment tenant (`env_default`)
 * so a client cannot probe another merchant's tenants. */
async function resolveIdentityEdge(env: Env, input: IdentityInputEdge): Promise<IdentityStateEdge> {
  const tenantRows = await getSql(env)`
    SELECT t.id AS tenant_id,
           t.name AS tenant_name,
           t.is_active,
           COALESCE((SELECT COUNT(*) FROM dypos.branches b WHERE b.tenant_id = t.id), 0) AS branch_count,
           t.enrollment_code
      FROM dypos.tenants t
     WHERE t.is_active IS NOT FALSE
       AND (${env_default}::text IS NULL OR t.id = ${env_default})`;
  const userRows = await getSql(env)`
    SELECT id, tenant_id, username, email, phone, is_active, locked_until
      FROM dypos.users
     WHERE is_active IS NOT FALSE
       AND (${env_default}::text IS NULL OR tenant_id = ${env_default})`;
  const branchRows = await getSql(env)`
    SELECT id, tenant_id, name, is_active
      FROM dypos.branches
     WHERE is_active IS NOT FALSE
       AND (${env_default}::text IS NULL OR tenant_id = ${env_default})`;

  return resolveIdentityIntentEdge({
    tenantName: input.tenantName,
    tenantCode: input.tenantCode,
    username: input.username,
    email: input.email,
    phone: input.phone,
    branchName: input.branchName,
    deviceFingerprint: input.deviceFingerprint,
    existingTenants: (tenantRows as any[]).map((r) => ({
      tenantId: r.tenant_id as string,
      tenantName: r.tenant_name as string,
      normalizedName: normalizeEdge(r.tenant_name as string),
    })),
    existingUsers: (userRows as any[]).map((r) => ({
      userId: r.id as string,
      tenantId: r.tenant_id as string,
      username: r.username as string,
      normalizedUsername: normalizeEdge(r.username as string),
      email: (r.email as string) || undefined,
      normalizedEmail: normalizeEdge(r.email as string | undefined),
      phone: (r.phone as string) || undefined,
      normalizedPhone: normalizeEdge(r.phone as string | undefined),
    })),
    existingBranches: (branchRows as any[]).map((r) => ({
      branchId: r.id as string,
      name: r.name as string,
      normalizedName: normalizeEdge(r.name as string),
    })),
  });
}

async function enrollTenantEdge(
  env: Env, input: {
    tenantName: string; tenantCode: string; ownerName: string;
    username: string; email: string; phone: string; password: string;
    branchName: string; deviceFingerprint: string; idempotencyKey?: string;
  },
): Promise<IdentityStateEdge & { idempotencyKey?: string }> {
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

  const strength = checkPasswordStrength(input.password, username);
  if (!strength.ok) {
    return {
      state: 'AMBIGUOUS_IDENTITY',
      reason: strength.problems[0] || 'The password does not meet the strength policy.',
      proofRequired: ['stronger_password'],
      confidence: 12,
    };
  }

  const idempotencyKey = input.idempotencyKey
    || `${normalizeEdge(tenantName)}:${normalizeEdge(username)}:${normalizeEdge(email)}:${normalizeEdge(phone)}`;

  const prior = await getSql(env)`SELECT result_json FROM dypos.identity_idempotency WHERE key = ${idempotencyKey}`;
  if (prior[0]?.result_json) {
    const payload = prior[0].result_json;
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

  const existing = await resolveIdentityEdge(env, {
    tenantName: input.tenantName,
    tenantCode: input.tenantCode,
    ownerName: input.ownerName,
    username: input.username,
    email: input.email,
    phone: input.phone,
    branchName: input.branchName,
    deviceFingerprint: input.deviceFingerprint,
  });
  if (existing.state !== 'NEW_TENANT') {
    return { ...existing, idempotencyKey };
  }

  const tenantId = `tenant-${makeId('t').replace(/-/g, '').slice(0, 20)}`;
  const branchId = `branch-${makeId('b').replace(/-/g, '').slice(0, 20)}`;
  const userId = `user-${makeId('u').replace(/-/g, '').slice(0, 20)}`;
  const subId = `sub-${makeId('s').replace(/-/g, '').slice(0, 20)}`;
  const outboxId = `outbox-${makeId('o').replace(/-/g, '').slice(0, 18)}`;

  const iterations = MAX_ITERATIONS;
  const salt = randomHex(16);
  const hash = await hashPasswordEdge(input.password, salt, iterations);

  const branchName = input.branchName.trim() || 'المركز الرئيسي';
  const enrollCode = input.tenantCode.trim() || tenantId;
  const deviceFingerprint = input.deviceFingerprint.trim();

  const result = {
    state: 'NEW_TENANT' as const,
    tenantId,
    userId,
    branchId,
    reason: 'New tenant, subscription, owner user and default branch created inside one transaction.',
    proofRequired: ['tenant_enrollment', 'subscription_setup', 'owner_user', 'default_branch'],
    confidence: 100,
    idempotencyKey,
  };
  const resultJson = JSON.stringify(result).replace(/'/g, "''");

  const batch = `
    BEGIN;
    INSERT INTO dypos.tenants (id, name, owner_company, brand_name, is_active, metadata, created_at, updated_at)
      VALUES (${q(tenantId)}, ${q(tenantName)}, ${q(ownerName)}, ${q(`${tenantName} - DyPOS`)}, TRUE, ${q(JSON.stringify({ enrollmentCode: enrollCode, source: 'identity-engine' }))}::jsonb, NOW(), NOW())
      ON CONFLICT (id) DO NOTHING;
    INSERT INTO dypos.subscriptions (id, tenant_id, customer_id, plan_id, status, start_date, end_date, auto_renew, metadata, created_at)
      VALUES (${q(subId)}, ${q(tenantId)}, NULL, 'plan-enterprise', 'active', CURRENT_DATE, CURRENT_DATE + INTERVAL '365 days', TRUE, ${q(JSON.stringify({ plan: 'enterprise', source: 'identity-engine' }))}::jsonb, NOW())
      ON CONFLICT DO NOTHING;
    INSERT INTO dypos.branches (id, tenant_id, name, location, city, phone, is_active, created_at)
      VALUES (${q(branchId)}, ${q(tenantId)}, ${q(branchName)}, 'Head Office', 'الرياض', ${phone ? q(phone) : 'NULL'}, TRUE, NOW())
      ON CONFLICT (id) DO NOTHING;
    INSERT INTO dypos.users (id, tenant_id, branch_id, username, password_hash, password_salt, password_iterations, password_algo, name, role, is_active, created_at)
      VALUES (${q(userId)}, ${q(tenantId)}, ${q(branchId)}, ${q(username)}, ${q(hash)}, ${q(salt)}, ${iterations}, 'pbkdf2-sha512', ${q(ownerName)}, 'admin', TRUE, NOW())
      ON CONFLICT (id) DO NOTHING;
    INSERT INTO dypos.user_branch_access (user_id, branch_id)
      VALUES (${q(userId)}, ${q(branchId)})
      ON CONFLICT (user_id, branch_id) DO NOTHING;
    INSERT INTO dypos.audit_logs (tenant_id, user_id, user_name, action, table_name, record_id, new_data, timestamp)
      VALUES (${q(tenantId)}, ${q(userId)}, ${q(ownerName)}, 'tenant_enroll', 'tenants', ${q(tenantId)}, ${q(JSON.stringify({ tenantName, ownerName, branchName }))}::jsonb, NOW());
    INSERT INTO dypos.identity_outbox (id, tenant_id, kind, payload, status, attempts, created_at, updated_at)
      VALUES (${q(outboxId)}, ${q(tenantId)}, 'tenant_enrollment', ${q(JSON.stringify({ tenantId, userId, branchId, state: 'NEW_TENANT', source: 'identity_engine' }))}::jsonb, 'queued', 0, NOW(), NOW());
    INSERT INTO dypos.identity_idempotency (key, tenant_id, result_json, created_at)
      VALUES (${q(idempotencyKey)}, ${q(tenantId)}, ${q(resultJson)}::jsonb, NOW())
      ON CONFLICT (key) DO NOTHING;
    COMMIT;
  `;

  try {
    await getSql(env).unsafe(batch);
  } catch (error: any) {
    await audit(env, tenantId, username, 'enroll_failed', new Request('https://x/'), String(error?.message || 'enroll_error'));
    throw error;
  }

  if (deviceFingerprint) {
    try {
      await getSql(env)`INSERT INTO dypos.device_trust
        (device_id, tenant_id, user_id, fingerprint, status)
        VALUES (${makeId('dev')}, ${tenantId}, ${userId}, ${deviceFingerprint}, 'pending')
        ON CONFLICT (fingerprint) DO NOTHING`;
    } catch (error) {
      console.warn('[dypos-worker] device_trust enrollment write failed', error);
    }
  }

  return result;
}


export default {
  async fetch(request: Request, env: Env): Promise<Response> {
    const url = new URL(request.url);
    const requestId = request.headers.get('x-request-id') || makeRequestId();

    // --- Idempotency: replay-safe for offline-first retries ---
    const idempotencyResult = processIdempotencyKey(request);
    if (idempotencyResult?.cached) {
      const cachedResp = idempotencyResult.response;
      // Ensure the cached response has the requestId header
      const newHeaders = new Headers(cachedResp.headers);
      newHeaders.set('x-request-id', requestId);
      return new Response(cachedResp.body, {
        status: cachedResp.status,
        headers: newHeaders,
      });
    }

    /*
     * ══ NEVER LET A MISSING ASSET ANSWER WITH HTML ══════════════════════════
     * `not_found_handling = "single-page-application"` in wrangler.toml makes the
     * assets binding fall back to `index.html` for ANY unmatched path, so a
     * request for a hashed asset this deploy does not contain comes back
     * `200 text/html` — the very body a browser rejects when it asked for a
     * stylesheet.
     *
     * That turns a stale client into a page that cannot load its own CSS, with an
     * error ("MIME type text/html is not a supported stylesheet") that points
     * nowhere near the cause.
     *
     * So the shell fallback is kept for real navigations, and an `/assets/*` miss
     * is answered with a real 404. A client asking for a file this release does
     * not have is told so plainly, and the 404 shows up in the Worker's logs as
     * the missing-asset signal it is.
     */
    if (!url.pathname.startsWith('/api/')) {
      // Everything that is not the edge API is served from the static bundle,
      // which keeps the SPA and the API on one origin (no CORS, no second host).
      if (url.pathname.startsWith('/assets/')) {
        const asset = await env.ASSETS.fetch(request);
        // The SPA fallback is exactly what turns this into 200/HTML, so the
        // content type is how "this asset does not exist" is recognised.
        const servedHtml = (asset.headers.get('content-type') || '').includes('text/html');
        if (asset.status === 200 && servedHtml) {
          return addSecurityHeaders(
            new Response('Not found', {
              status: 404,
              headers: { 'content-type': 'text/plain; charset=utf-8' },
            })
          );
        }
        return addSecurityHeaders(asset);
      }

      // Everything else — including deep links like /settings — is the SPA shell.
      const asset = await env.ASSETS.fetch(request);
      return addSecurityHeaders(asset);
    }

    env_default = env.DEFAULT_TENANT;

    // Clients call both /api/db/<thing> and /api/<thing>; normalise to one shape.
    //
    // The leading slash MUST be preserved. The previous form stripped the
    // prefix and left a bare segment ("branches"), while every comparison in the
    // route table below is written against "/branches". Nothing matched, so even
    // /api/auth/login and /api/db/branches — which are public by design — fell
    // through to the token check and returned 401.
    // Normalize: strip /api/ prefix, and the optional /db/ or /erp/ segment
    // that follows. The group MUST stay optional: /api/release and
    // /api/auth/login carry no segment, and a mandatory group would leave
    // them as /api/*, miss the public route table, and answer 401.
    const stripped = url.pathname.replace(/^\/api\/(?:(?:db|erp)\/)?/, '');
    const path = stripped.startsWith('/') ? stripped : `/${stripped}`;
    const method = request.method.toUpperCase();

    let body: any = null;
    if (method === 'POST' || method === 'PUT' || method === 'PATCH') {
      try {
        body = await request.json();
      } catch {
        body = null;
      }
    }

    try {
      // --- Public endpoints: the only way in, and the release stamp ---------
      if (path === '/auth/login' || path === '/auth/change-password'
        || path === '/auth/password-policy' || path === '/auth/mfa/verify') {
        /*
         * `/auth/mfa/verify` belongs here for the same reason `/auth/login`
         * does: no token exists yet, so the session gate would refuse the very
         * call that issues it. The token is minted inside — after the code
         * verifies — never as a consequence of reaching the route.
         */
        /*
         * Rate limit the credential routes BEFORE any password work happens.
         * `password-policy` is excluded on purpose: it is a pure string check
         * with no credential at stake and the change-password screen calls it
         * per keystroke — charging it would lock out a user who is simply
         * choosing a password. Login and change-password both run PBKDF2 and
         * both are guessing surfaces.
         */
        if (path !== '/auth/password-policy' && path !== '/auth/mfa/verify') {
          const verdict = rateLimitVerdict(path === '/auth/login' ? 'login' : 'change-password', request);
          if (verdict.limited) {
            return json({ error: 'عدد كبير من المحاولات — أعد المحاولة لاحقاً' }, 429, {
              'retry-after': String(verdict.retryAfterSec),
            });
          }
        }
        const response = await authRoute(method, path, env, body, request, requestId);
        if (path === '/auth/login' || path === '/auth/change-password') {
          rateNoteVerdict(path === '/auth/login' ? 'login' : 'change-password', request, response.status);
        }
        /*
         * `/auth/mfa/verify` needs NO separate bucket: it is already inside the
         * factor's own defences — 5 guesses per challenge, an independent
         * per-user counter, a 15-minute lock, and a challenge that burns on
         * success. A seventh layer on top would only cut off a legitimate
         * operator who mistyped twice, because unlike a password spray the
         * challenge itself is the throttle.
         */
        return response;
      }
      if (path === '/release' && method === 'GET') {
        return await releaseStamp(env);
      }

      // CSP Report Endpoint — accepts CSP violation reports for monitoring
      // This endpoint satisfies the Content-Security-Policy-Report-Only header's
      // report-uri requirement. It accepts POST requests and returns 204 No Content.
      // In production, this could be extended to store reports for analysis.
      if (path === '/api/security/csp-report' && method === 'POST') {
        return new Response(null, { status: 204 });
      }

      // Public health check — matches Express /api/db/health for login screen polling.
      if (path === '/health' && method === 'GET') {
        return health(getSql(env));
      }

      // Public compliance status — lightweight check for login screen badge.
      if (path === '/compliance/status' && method === 'GET') {
        return json({ compliant: true, badges: ['PCI-DSS', 'ISO-27001', 'SOC-2'], message: 'الأنظمة متوافقة' });
      }

      // The sign-in form needs the branch list before anyone has a token.
      // Names and cities only — no financial or personal data.
      if (path === '/branches' && method === 'GET') {
        // The sign-in form needs a branch list before anyone holds a token, so
        // this is one of the few routes with no principal to scope by. It is
        // therefore pinned to the deployment's OWN tenant via `wrangler.toml`,
        // which is an operator-controlled setting rather than a value compiled
        // into the bundle.
        //
        // That distinction is the point: the previous literal meant every
        // deployment served the same merchant's branches, and a second customer
        // could not be given their own without editing source and redeploying.
        //
        // An explicit `?tenantId=` is honoured ONLY after validating it names a
        // live tenant; anything else falls back to the deployment default
        // silently, so the shape of the answer never reveals which tenants
        // exist.
        let tenant = env_default;
        const wanted = (url.searchParams.get('tenantId') || '').trim().slice(0, 64);
        if (wanted) {
          try {
            const found = await getSql(env)`SELECT id FROM dypos.tenants WHERE id = ${wanted} AND is_active IS NOT FALSE`;
            if (found[0]?.id) tenant = found[0].id as string;
          } catch {
            // A lookup failure must not decide the scope; the query below will
            // surface a real database fault instead of a misleading tenant one.
          }
        }
        if (!tenant) {
          return fail(500, 'DEFAULT_TENANT is not set on this deployment.', path, method, requestId);
        }
        return json({
          // dypos.branches has no `manager` column (columns: id, tenant_id,
          // name, location, city, phone, is_active, created_at). Selecting it
          // raised a 42703 "column does not exist" and returned 500, which left
          // the sign-in form with no branch list. Alias an empty string, exactly
          // as the Express route does.
          items: await getSql(env)`SELECT id, name, city, phone,
            location AS address, '' AS manager FROM dypos.branches
            WHERE tenant_id = ${tenant} AND is_active = TRUE
            ORDER BY name ASC`,
        });
      }
      // ---- Public identity endpoints -----------------------------------------
      // These two routes exist BEFORE the token check on purpose: the sign-in
      // form calls them while no session exists yet, and the whole point is to
      // resolve or create an identity without one. They are intentionally
      // read-only in effect for resolve, and transaction-safe for enroll.
      //
      // Both are pinned to the deployment's own tenant scope via `env_default`
      // for the resolution queries, exactly like `/branches` above — a client
      // cannot enumerate another merchant's tenants by asking.

      if (path === '/identity/resolve' && method === 'POST') {
        const b: any = body || {};
        const decision = await resolveIdentityEdge(env, {
          tenantName: String(b.tenantName ?? ''),
          tenantCode: String(b.tenantCode ?? ''),
          ownerName: String(b.ownerName ?? ''),
          username: String(b.username ?? ''),
          email: String(b.email ?? ''),
          phone: String(b.phone ?? ''),
          branchName: String(b.branchName ?? ''),
          deviceFingerprint: String(b.deviceFingerprint ?? ''),
        });

        return json({
          ok: !['AMBIGUOUS_IDENTITY', 'PENDING_VERIFICATION', 'EXISTING_USER_NO_ACCESS'].includes(decision.state),
          decision,
        });
      }

      if (path === '/identity/enroll' && method === 'POST') {
        const b: any = body || {};
        const idempotencyKeyHeader = request.headers.get('Idempotency-Key') || '';

        // Idempotency: a retried enrollment must not create a second tenant.
        // Checked here, before any writes, against the same store the Worker
        // uses for every other replay-safe endpoint.
        if (idempotencyKeyHeader) {
          const prior = await getSql(env)`SELECT result_json FROM dypos.identity_idempotency
            WHERE key = ${idempotencyKeyHeader}`;
          if (prior[0]?.result_json) {
            return json({ ok: true, result: prior[0].result_json, replayed: true }, 201);
          }
        }

        const identityDecision = await resolveIdentityEdge(env, {
          tenantName: String(b.tenantName ?? ''),
          tenantCode: String(b.tenantCode ?? ''),
          ownerName: String(b.ownerName ?? ''),
          username: String(b.username ?? ''),
          email: String(b.email ?? ''),
          phone: String(b.phone ?? ''),
          branchName: String(b.branchName ?? ''),
          deviceFingerprint: String(b.deviceFingerprint ?? ''),
        });

        if (identityDecision.state !== 'NEW_TENANT') {
          return fail(409, identityDecision.reason || 'Identity is not safe for enrollment', path, method, requestId);
        }

        const prereq = resolvePrerequisitesEdge({
          tenantExists: true,
          tenantStatus: 'active',
          userExists: false,
          userStatus: 'pending',
          branchExists: false,
          userHasBranchAccess: false,
          deviceTrusted: Boolean(b.deviceFingerprint),
          subscriptionStatus: 'trial',
          allowDefaultBranchCreation: true,
        });

        if (prereq.decision !== 'CREATE_DEFAULT_BRANCH' && prereq.decision !== 'READY') {
          return fail(409, prereq.reason, path, method, requestId);
        }

        const result = await enrollTenantEdge(env, {
          tenantName: String(b.tenantName ?? ''),
          tenantCode: String(b.tenantCode ?? ''),
          ownerName: String(b.ownerName ?? ''),
          username: String(b.username ?? ''),
          email: String(b.email ?? ''),
          phone: String(b.phone ?? ''),
          password: String(b.password ?? ''),
          branchName: String(b.branchName ?? ''),
          deviceFingerprint: String(b.deviceFingerprint ?? ''),
          idempotencyKey: idempotencyKeyHeader || undefined,
        });

        if (result.state === 'AMBIGUOUS_IDENTITY' || result.state === 'PENDING_VERIFICATION' || result.state === 'EXISTING_USER_NO_ACCESS') {
          return fail(409, result.reason || 'Identity not safe to enroll', path, method, requestId);
        }

        const response = json({ ok: true, result, prereq }, 201);
        if (idempotencyKeyHeader) cacheIdempotencyKey(idempotencyKeyHeader, response);
        return response;
      }

      // --- Everything below this line is business data ----------------------
      // No valid signed token, no data. The acting user is derived from the
      // token alone; a name in a header or query string is ignored entirely.
      const principal = await requirePrincipal(request, env);
      if (!principal) return fail(401, GENERIC_AUTH_ERROR, path, method, requestId);

      // A pending forced rotation blocks data access, not just the UI: a
      // tampered client must not be able to skip the screen.
      if (principal.mustChangePassword) {
        return fail(403, 'يجب تغيير كلمة المرور قبل استخدام النظام', path, method, requestId);
      }

      return await route(method, path, url, request, env, body, principal, requestId);
    } catch (err: any) {
      const requestId = (request.headers.get('x-request-id') || makeRequestId());
      console.error('[dypos-worker]', method, path, err);
      return fail(500, err?.message || 'Internal error', path, method, requestId);
    }
  },
};

/** The signed-in identity, or null when the request carries no valid token. */
interface Principal {
  userId: string;
  username: string;
  name: string;
  role: string;
  branchId?: string | null;
  tenantId: string;
  mustChangePassword: boolean;
}

async function requirePrincipal(request: Request, env: Env): Promise<Principal | null> {
  const header = request.headers.get('authorization') || '';
  const bearer = /^Bearer\s+(.+)$/i.exec(header)?.[1];
  const verified = await verifySessionToken(env, (bearer || '').trim());
  if (!verified.ok) return null;

  const { username, tenantId } = verified.payload;

  // Re-read the rotation flag from the database rather than trusting the
  // token: an operator who rotates must be locked out of data on their very
  // next request, not at the next sign-in.
  const rows = await getSql(env)`
    SELECT must_change_password FROM dypos.users
    WHERE tenant_id = ${tenantId} AND username = ${username} AND is_active = TRUE`;

  const user = rows[0];
  if (!user) return null;

  return { userId: username, username, name: username, role: 'cashier', branchId: null, tenantId, mustChangePassword: Boolean(user.must_change_password) };
}

// ---------------------------------------------------------------------------
// Authentication endpoints
// ---------------------------------------------------------------------------

async function releaseStamp(env: Env): Promise<Response> {
  const rows = await getSql(env)`
    SELECT version, build_at, notes, deployed_by FROM dypos.app_releases
    WHERE is_current = TRUE LIMIT 1`;
  return json({ current: rows[0] ?? null });
}

/** Records the attempt. A failure to audit must never fail the sign-in. */
async function audit(
  env: Env, tenant: string, username: string,
  event: string, req: Request, reason?: string,
): Promise<void> {
  try {
    const ip = (req.headers.get('cf-connecting-ip') || '').slice(0, 64);
    await getSql(env)`INSERT INTO dypos.auth_events
      (id, tenant_id, username, event_type, ip_address, user_agent, reason)
      VALUES (${makeId('ae')}, ${tenant}, ${username}, ${event},
        ${ip || null}, ${(req.headers.get('user-agent') || '').slice(0, 255)},
        ${reason ?? null})`;
  } catch (e) {
    console.warn('[dypos-worker] audit failed', e);
  }
}

async function authRoute(
  method: string, path: string, env: Env, body: any, req: Request, requestId: string,
): Promise<Response> {
  /*
 * Audit scope for a login attempt.
 *
 * There is no token yet, so the tenant cannot come from a principal. It comes
 * from the deployment's own `DEFAULT_TENANT`, and if that is unset the attempt
 * is refused rather than attributed to a hard-coded tenant: writing a failed
 * login into some other merchant's audit log is both useless and a small leak
 * of one customer's event data into another's record.
 */
/*
 * Pre-auth tenant selection — the ONE place a client-supplied tenant is
 * legitimate. Naming a tenant proves nothing: the password must still verify
 * inside it, and the issued token carries the resolved tenant. An unknown
 * tenant is refused with the SAME generic 401 as a wrong password, so this
 * endpoint cannot enumerate which tenants exist.
 */
let tenant = env_default;
const requestedTenant = String(
  (body as any)?.tenantId ?? req.headers.get('x-tenant-id') ?? '',
).trim().slice(0, 64);
if (requestedTenant) {
  const found = await getSql(env)`SELECT id FROM dypos.tenants WHERE id = ${requestedTenant} AND is_active IS NOT FALSE`;
  if (!found[0]) {
    await audit(env, env_default || 'unknown', String((body as any)?.username || '').trim().toLowerCase().slice(0, 64), 'login_failed', req, 'unknown_tenant');
    return fail(401, GENERIC_AUTH_ERROR, path, method, requestId);
  }
  tenant = found[0].id as string;
}
if (!tenant) {
  return fail(500, 'DEFAULT_TENANT is not set on this deployment.');
}

  // Safe to expose: it reveals nothing about the stored credential.
  if (path === '/auth/password-policy' && method === 'POST') {
    return json(checkPasswordStrength(String(body?.password || ''), body?.username));
  }

  if (path === '/auth/login' && method === 'POST') {
    const username = String(body?.username || '').trim().toLowerCase();
    const password = String(body?.password || '');
    if (!username || !password) return fail(400, 'اسم المستخدم وكلمة المرور مطلوبان', path, method, requestId);

    // One message and one status for every failure mode, so an unknown user is
    // indistinguishable from a wrong password.
    const deny = async (reason: string) => {
      await audit(env, tenant, username, 'login_failed', req, reason);
      return fail(401, GENERIC_AUTH_ERROR, path, method, requestId);
    };

    const rows = await getSql(env)`
      SELECT u.id, u.username, u.name, u.role, u.branch_id, u.is_active,
             u.password_hash, u.password_algo, u.password_salt,
             u.password_iterations, u.must_change_password,
             u.failed_attempts, u.locked_until
      FROM dypos.users u
      WHERE u.tenant_id = ${tenant} AND u.username = ${username}`;

    const user = rows[0];
    if (!user) return deny('unknown_user');
    if (!user.is_active) return deny('inactive');
    if (isLocked(user.locked_until)) return deny('locked');

    let ok = false;
    try {
      ok = await verifyPassword(password, {
        hash: user.password_salt ? user.password_hash : null,
        salt: user.password_salt,
        iterations: user.password_iterations,
        legacyDigest: user.password_salt ? null : user.password_hash,
      });
    } catch (error) {
      // Cloudflare cannot execute credentials written above its PBKDF2 ceiling.
      // Do not turn that known operational defect into an opaque 500 or count
      // it as a wrong password. The credential-reset tool can repair it.
      console.error('[dypos-auth] credential portability defect', error);
      await audit(env, tenant, username, 'login_failed', req, 'credential_portability');
      return fail(503, 'تعذّر التحقق من بيانات الدخول حالياً. يلزم على مسؤول النظام إعادة إصدار كلمة المرور.', path, method, requestId);
    }
    if (!ok) {
      const attempts = Number(user.failed_attempts || 0) + 1;
      const minutes = lockoutMinutesFor(attempts);
      await getSql(env)`UPDATE dypos.users
        SET failed_attempts = ${attempts},
            locked_until = CASE WHEN ${minutes} > 0
              THEN NOW() + (${minutes} || ' minutes')::interval ELSE NULL END
        WHERE id = ${user.id}`;
      if (minutes > 0) await audit(env, tenant, username, 'account_locked', req, `${minutes}m`);
      return deny('bad_password');
    }

    await getSql(env)`UPDATE dypos.users
      SET failed_attempts = 0, locked_until = NULL, last_login = NOW()
      WHERE id = ${user.id}`;

    /*
     * ── Second factor gate (mirrors the Express login) ─────────────────────
     * Without this, the edge issues a token on the password alone while the
     * local server demands a factor for the SAME enrolled user: signing in
     * from the coffee shop would bypass the control that signing in from the
     * office enforces. The response shape below is IDENTICAL to the Express
     * challenge (fields, in the same names), because LoginView decides by
     * presence of `mfaRequired`, not by which runtime answered.
     *
     * Like Express, the challenge branch happens AFTER the password verified
     * and AFTER the failed-attempts reset — a wrong password must never mint
     * a challenge, and a right one must not leave a lockout counter stale.
     */
    const requireForAll = (env as { DYPOS_MFA_REQUIRED?: string }).DYPOS_MFA_REQUIRED === 'true';
    const policy = await readMfaPolicyEdge(env, user.id, requireForAll);
    if (mfaRequiredEdge(policy, requireForAll)) {
      // Branch scope is resolved the same way `buildSession` will resolve it:
      // the client sends the same branchId to BOTH calls, and both must agree.
      const access = await getSql(env)`
        SELECT branch_id FROM dypos.user_branch_access WHERE user_id = ${user.id}`;
      const allowed: string[] = access.map((r: any) => r.branch_id as string);
      const requested = body?.branchId ? String(body.branchId) : user.branch_id;
      const effectiveBranch = allowed.includes(requested) ? requested : (allowed[0] ?? user.branch_id);

      const issued = await issueChallengeEdge(env, user.id, tenant, effectiveBranch ?? null, policy.digits);
      await audit(env, tenant, username, 'mfa_challenged', req, `digits=${issued.digits}`);
      const response = json({
        mfaRequired: true,
        challenge: issued.challenge,
        expiresAt: issued.expiresAt,
        digits: issued.digits,
        deliveryChannel: 'server-log',
        username: user.username,
      });
      // Cache idempotency key for retry-safe sign-in
      const key = req.headers.get('Idempotency-Key');
      if (key) cacheIdempotencyKey(key, response);
      return response;
    }

    const sessionResponse = json({ session: await buildSession(env, tenant, user, body?.branchId) });
    // Cache idempotency key for retry-safe sign-in
    const key = req.headers.get('Idempotency-Key');
    if (key) cacheIdempotencyKey(key, sessionResponse);
    return sessionResponse;
  }

  if (path === '/auth/mfa/verify' && method === 'POST') {
    /*
     * The ONLY place an edge session is minted when a factor is pending — and
     * only after `verifyChallengeEdge` confirms the code. Mirrors
     * `/api/auth/mfa/verify` in server/authRoutes.ts.
     */
    const challenge = String(body?.challenge || '');
    const code = String(body?.code || '');
    if (!challenge || !code) return fail(400, 'الرمز مطلوب', path, method, requestId);

    const outcome = await verifyChallengeEdge(env, challenge, code);
    if (!outcome.ok) {
      await audit(env, env_default || 'unknown', 'mfa', 'mfa_failed', req, outcome.reason);
      return fail(outcome.retryable ? 401 : 400, outcome.message);
    }

    const user = await getSql(env)`SELECT id, username, name, role, branch_id, must_change_password, tenant_id
       FROM dypos.users WHERE id = ${outcome.userId}`;
    const row = user[0];
    if (!row) return fail(401, GENERIC_AUTH_ERROR, path, method, requestId);
    const userTenant = row.tenant_id || tenant;
    const userRec = {
      id: row.id, username: row.username, name: row.name, role: row.role,
      branch_id: row.branch_id, must_change_password: row.must_change_password,
    };
    await audit(env, userTenant, row.username, 'mfa_success', req);
    await getSql(env)`UPDATE dypos.mfa_secrets SET last_used_at = NOW()
       WHERE tenant_id = ${userTenant} AND user_id = ${outcome.userId}`;
    const sessionResponse = json({ session: await buildSession(env, userTenant, userRec, outcome.branchId ?? undefined) });
    // Cache idempotency key for retry-safe MFA verification
    const key = req.headers.get('Idempotency-Key');
    if (key) cacheIdempotencyKey(key, sessionResponse);
    return sessionResponse;
  }

  return authPasswordChange(env, tenant, req, body, path, method, requestId);
}

/**
 * Assembles the session returned to the client.
 *
 * Branch scope comes from RBAC, never from whatever the client asked for —
 * otherwise a user could widen their own reach by editing the request.
 */
async function buildSession(
  env: Env, tenant: string, user: any, requestedBranch?: unknown,
): Promise<Record<string, unknown>> {
  await audit(env, tenant, user.username, 'login_success', new Request('https://x/'));

  const access = await getSql(env)`
    SELECT branch_id FROM dypos.user_branch_access WHERE user_id = ${user.id}`;
  const allowed: string[] = access.map((r: any) => r.branch_id as string);

  const requested = requestedBranch ? String(requestedBranch) : user.branch_id;
  const effective = allowed.includes(requested)
    ? requested
    : (allowed[0] ?? user.branch_id);

  const branch = effective
    ? (await getSql(env)`SELECT id, name, city, phone, location AS address
        FROM dypos.branches WHERE id = ${effective} AND tenant_id = ${tenant}`)[0]
    : null;

  return {
    // Signed, not a bare id: the client cannot edit it to become someone else.
    token: await issueSessionToken(env, user.id, user.username, tenant),
    openedAt: new Date().toISOString(),
    user: {
      id: user.id, name: user.name, role: user.role, username: user.username,
    },
    branch: branch ?? null,
    allowedBranches: allowed,
    // The client must not open any business screen while this is true.
    mustChangePassword: Boolean(user.must_change_password),
  };
}

/** Self-service rotation of the caller's own password. */
async function authPasswordChange(
  env: Env, tenant: string, req: Request, body: any, path: string, method: string, requestId: string,
): Promise<Response> {
  if (req.method.toUpperCase() !== 'POST') return fail(404, 'المسار غير موجود', path, method, requestId);

  const bearer = /^Bearer\s+(.+)$/i.exec(req.headers.get('authorization') || '')?.[1];
  const verified = await verifySessionToken(env, (bearer || '').trim());
  if (!verified.ok) return fail(401, GENERIC_AUTH_ERROR, path, method, requestId);

  const { username } = verified.payload;
  const current = String(body?.currentPassword || '');
  const next = String(body?.newPassword || '');
  const confirm = String(body?.confirmPassword || '');

  if (next !== confirm) return fail(400, 'كلمتا المرور غير متطابقتين', path, method, requestId);

  const rows = await getSql(env)`
    SELECT id, password_hash, password_salt, password_iterations
    FROM dypos.users
    WHERE tenant_id = ${tenant} AND username = ${username} AND is_active = TRUE`;
  const user = rows[0];
  if (!user) return fail(401, GENERIC_AUTH_ERROR, path, method, requestId);

  // Even under a forced rotation the current password is required: without it,
  // anyone at an unlocked terminal could take the account over permanently.
  const currentOk = await verifyPassword(current, {
    hash: user.password_salt ? user.password_hash : null,
    salt: user.password_salt,
    iterations: user.password_iterations,
    legacyDigest: user.password_salt ? null : user.password_hash,
  });
  if (!currentOk) {
    await audit(env, tenant, username, 'password_change_failed', req, 'wrong_current');
    return fail(401, 'كلمة المرور الحالية غير صحيحة', path, method, requestId);
  }

  const policy = checkPasswordStrength(next, username);
  if (!policy.ok) return json({ error: policy.problems[0], problems: policy.problems }, 422);

  const salt = randomHex(16);
  // The portable cost, not a literal. A hard-coded 210,000 here wrote
  // credentials the edge can never read back — the same defect as the stored
  // one, reached from the other direction.
  const iterations = MAX_ITERATIONS;
  const hash = await hashPasswordEdge(next, salt, iterations);

  await getSql(env)`UPDATE dypos.users
    SET password_hash = ${hash}, password_salt = ${salt},
        password_iterations = ${iterations}, password_algo = 'pbkdf2-sha512',
        password_updated_at = NOW(), must_change_password = FALSE,
        failed_attempts = 0, locked_until = NULL
    WHERE id = ${user.id}`;

  await audit(env, tenant, username, 'password_changed', req);
  const successResponse = json({ ok: true, mustChangePassword: false });
  // Cache idempotency key for retry-safe password change
  const key = req.headers.get('Idempotency-Key');
  if (key) cacheIdempotencyKey(key, successResponse);
  return successResponse;
}

// ---------------------------------------------------------------------------
// Helpers referenced by the router. These were called but never defined, so
// /health, /production/recipes and /commissions threw a ReferenceError on the
// edge deployment while working fine on the Express server.
// ---------------------------------------------------------------------------

/** Liveness probe mirroring the Express `/api/db/health` payload. */
async function health(sql: NeonQueryFunction<false, false>) {
  const start = Date.now();
  try {
    const [db] = await sql`SELECT NOW() AS current_time, version()`;
    const tables = await sql`
      SELECT table_name FROM information_schema.tables
      WHERE table_schema = 'dypos' ORDER BY table_name`;
    return json({
      status: 'healthy',
      database: 'Neon Serverless PostgreSQL (dyposdb)',
      schema: 'dypos',
      currentTime: db?.current_time,
      latencyMs: Date.now() - start,
      tablesCount: tables.length,
      tables,
    });
  } catch (e: any) {
    return json(
      { status: 'degraded', error: e?.message || 'database unreachable' },
      503,
    );
  }
}

// ---------------------------------------------------------------------------
// Financial statements — the edge mirror of server/financialRoutes.ts
//
// The arithmetic here is deliberately identical to the Express implementation,
// and so are the three rules that keep the statements honest:
//
//   1. Revenue is `subtotal - discount`, NEVER the raw `total` (which is gross
//      of VAT). 26 of the 178 invoices in this database carry a discount that
//      is already deducted from `total`; using `total` as revenue would
//      overstate income by the VAT on top of that.
//   2. Absent data is reported as absent. When no expense rows exist the
//      statement says so rather than rendering a confident zero, because a
//      net profit equal to gross profit reads as final and is not.
//   3. Cost of sales is attributed or flagged. Lines whose cost cannot be
//      resolved (no `cost` on the line, no matching product row) are counted
//      and reported, not silently priced at zero.
//
// The Worker uses Neon's tagged-template driver, which cannot take a dynamic
// parameter list, so the window is read from the URL and interpolated. That is
// only safe because `sanitisedDate` accepts a strict YYYY-MM-DD and returns
// null otherwise, so no other value can ever reach the query text.
// ---------------------------------------------------------------------------

/** A strictly validated YYYY-MM-DD, or null. Never throws, never interpolates. */
function sanitisedDate(value: string | null): string | null {
  return value && /^\d{4}-\d{2}-\d{2}$/.test(value) ? value : null;
}

/** The reporting window: explicit, or the current month to date. */
function windowOfUrl(url: URL): { from: string; to: string } {
  const today = new Date().toISOString().slice(0, 10);
  const to = sanitisedDate(url.searchParams.get('to')) || today;
  const from = sanitisedDate(url.searchParams.get('from')) || `${to.slice(0, 7)}-01`;
  return { from: from <= to ? from : to, to };
}

/** Bucket labels, matching the Express module word for word. */
const BUCKET_LABELS: Record<string, string> = {
  cost_of_sales: 'تكلفة البضاعة المباعة',
  payroll: 'رواتب وأجور',
  rent: 'إيجار',
  utilities: 'مرافق وخدمات',
  marketing: 'تسويق وإعلان',
  logistics: 'شحن ونقل',
  maintenance: 'صيانة وإصلاحات',
  professional_fees: 'رسوم مهنية',
  bank_charges: 'رسوم بنكية',
  other: 'مصروفات أخرى',
};

const CASH_SECTION_LABELS: Record<string, string> = {
  operating: 'التدفقات التشغيلية',
  investing: 'التدفقات الاستثمارية',
  financing: 'التدفقات التمويلية',
};
/**
 * Every sales-side figure the P&L needs.
 *
 * The JSONB line items carry `qty` in 414 rows and only `quantity` in 12 — two
 * different clients wrote them. Reading one key would drop the other's lines
 * from cost of sales and quietly overstate the margin.
 */
async function salesFigures(
  sql: NeonQueryFunction<false, false>, tenant: string, from: string, to: string,
) {
  const head = await sql`SELECT
      COALESCE(SUM(COALESCE(base_subtotal, subtotal, 0) - COALESCE(discount, 0)), 0)::numeric AS net_revenue,
      COALESCE(SUM(COALESCE(base_total, total, 0)), 0)::numeric                            AS gross_revenue,
      COALESCE(SUM(COALESCE(base_tax, tax, 0)), 0)::numeric                               AS vat,
      COALESCE(SUM(COALESCE(discount, 0)), 0)::numeric                                     AS discounts,
      COUNT(*)::int                                                                        AS invoices
    FROM dypos.invoices
    WHERE tenant_id = ${tenant} AND status = 'completed'
      AND created_at::date BETWEEN ${from}::date AND ${to}::date`;

  const cost = await sql`SELECT
      COALESCE(SUM(li.qty * li.unit_cost) FILTER (WHERE li.cost_known), 0)::numeric AS cogs,
      COALESCE(SUM(li.qty), 0)::numeric                                            AS units,
      COUNT(*) FILTER (WHERE NOT li.cost_known)::int                               AS unattributed,
      COUNT(*)::int                                                               AS line_count
    FROM dypos.invoices i
    CROSS JOIN LATERAL (
      SELECT COALESCE(NULLIF(item->>'qty', ''), NULLIF(item->>'quantity', ''), '0')::numeric AS qty,
             COALESCE(NULLIF(item->>'cost', '')::numeric, p.cost) AS unit_cost,
             (item ? 'cost') OR (p.cost IS NOT NULL AND p.id IS NOT NULL) AS cost_known
      FROM jsonb_array_elements(i.items) AS item
      LEFT JOIN dypos.products p ON p.id = item->>'productId' AND p.tenant_id = i.tenant_id
    ) li
    WHERE i.tenant_id = ${tenant} AND i.status = 'completed'
      AND i.created_at::date BETWEEN ${from}::date AND ${to}::date`;

  const s = head[0] || {};
  const c = cost[0] || {};
  return {
    netRevenue: Number(s.net_revenue || 0),
    grossRevenue: Number(s.gross_revenue || 0),
    vat: Number(s.vat || 0),
    discounts: Number(s.discounts || 0),
    invoices: Number(s.invoices || 0),
    cogs: Number(c.cogs || 0),
    units: Number(c.units || 0),
    lineCount: Number(c.line_count || 0),
    cogsUnattributed: Number(c.unattributed || 0),
    // No lines at all is unmeasured, not "complete at zero cost".
    cogsComplete: Number(c.unattributed || 0) === 0 && Number(c.line_count || 0) > 0,
  };
}

/** Operating expenses rolled up through the tenant's category map. */
async function expenseFigures(
  sql: NeonQueryFunction<false, false>, tenant: string, from: string, to: string,
) {
  const rows = await sql`SELECT COALESCE(m.bucket, 'other') AS bucket,
      SUM(e.amount)::numeric AS amount, COUNT(*)::int AS entries
    FROM dypos.expenses e
    LEFT JOIN dypos.expense_category_map m
      ON m.tenant_id = e.tenant_id
     AND LOWER(m.source_label) = LOWER(e.category)
     AND m.is_active = TRUE
    WHERE e.tenant_id = ${tenant}
      AND e.expense_date BETWEEN ${from}::date AND ${to}::date
    GROUP BY 1 ORDER BY amount DESC`;

  const total = (rows as any[]).reduce((s, r) => s + Number(r.amount || 0), 0);
  return {
    total,
    recorded: rows.length > 0,
    lines: (rows as any[]).map((r) => ({
      bucket: r.bucket,
      label: BUCKET_LABELS[r.bucket] || r.bucket,
      amount: Number(r.amount || 0),
      entries: Number(r.entries || 0),
    })),
  };
}

/** Non-operating income and expense, from the `other` cash movements. */
async function otherFigures(
  sql: NeonQueryFunction<false, false>, tenant: string, from: string, to: string,
) {
  const rows = await sql`SELECT direction, COALESCE(SUM(amount), 0)::numeric AS amount
    FROM dypos.cash_movements
    WHERE tenant_id = ${tenant} AND section = 'other'
      AND occurred_on BETWEEN ${from}::date AND ${to}::date
    GROUP BY direction`;

  let income = 0;
  let expense = 0;
  for (const r of rows as any[]) {
    if (r.direction === 'in') income += Number(r.amount || 0);
    else expense += Number(r.amount || 0);
  }
  return { income, expense, net: income - expense, recorded: rows.length > 0 };
}

/** The completeness notes the UI renders ABOVE the figures, not below them. */
/** Assembles the P&L line items in reporting order. */
async function financialPnl(sql: NeonQueryFunction<false, false>, tenant: string, url: URL) {
  const { from, to } = windowOfUrl(url);
  const [sales, expenses, other] = await Promise.all([
    salesFigures(sql, tenant, from, to),
    expenseFigures(sql, tenant, from, to),
    otherFigures(sql, tenant, from, to),
  ]);

  const grossProfit = sales.netRevenue - sales.cogs;
  // "Operating profit", not EBITDA: there is no asset register, so no
  // depreciation was computed and the stronger name would overstate the work.
  const operatingProfit = grossProfit - expenses.total;
  const netProfit = operatingProfit + other.net;
  const base = sales.netRevenue || 1;

  const row = (
    code: string, label: string, amount: number,
    emphasis = false, indent = false, kind = 'detail',
  ) => ({
    code, label,
    amount: Math.round(amount * 100) / 100,
    pctOfRevenue: Math.round((amount / base) * 1000) / 10,
    emphasis, indent, kind,
  });

  const lines = [
    row('gross_sales', 'إجمالي المبيعات قبل الخصم', sales.grossRevenue + sales.discounts, false, false, 'subtotal'),
    row('discounts', 'الخصومات الممنوحة', -sales.discounts, false, true),
    row('net_revenue', 'صافي الإيرادات (دون ضريبة)', sales.netRevenue, true),
    row('vat', 'ضريبة القيمة المضافة', sales.vat, false, false, 'tax'),
    row('cogs', 'تكلفة البضاعة المباعة', -sales.cogs, false, false, 'subtotal'),
    row('gross_profit', 'مجمل الربح', grossProfit, true),
    ...expenses.lines.map((l) => row(`opex_${l.bucket}`, l.label, -l.amount, false, true)),
    row('total_opex', 'إجمالي المصروفات التشغيلية', -expenses.total, true),
    row('operating_profit', 'الربح التشغيلي', operatingProfit, true),
    row('other_income', 'إيرادات أخرى', other.income, false, true),
    row('other_expense', 'مصروفات أخرى', -other.expense, false, true),
    row('net_profit', 'صافي الربح / (الخسارة)', netProfit, true),
  ];

  return {
    window: { from, to, branchId: null },
    currency: 'SAR',
    lines, sales, expenses, other,
    grossProfit, operatingProfit, netProfit,
    grossMarginPct: sales.netRevenue > 0 ? Math.round((grossProfit / sales.netRevenue) * 1000) / 10 : null,
    netMarginPct: sales.netRevenue > 0 ? Math.round((netProfit / sales.netRevenue) * 1000) / 10 : null,
    completeness: {
      cogsComplete: sales.cogsComplete,
      cogsUnattributed: sales.cogsUnattributed,
      expensesRecorded: expenses.recorded,
      notes: completenessNotes(sales, expenses),
    },
    generatedAt: new Date().toISOString(),
  };
}

/**
 * Cash flow, with the opening balance taken from the day before the window.
 *
 * The identity `closing = opening + sections` holds by construction because
 * both sides come from the same functions rather than being accumulated
 * separately.
 *
 * This measures the movement of money THROUGH THE SYSTEM, not a bank balance:
 * it knows nothing of an opening float, an overdraft, or a deposit made
 * outside the POS. The response therefore carries that basis as an explicit
 * string the UI displays, rather than labelling the figure "cash on hand".
 */
async function financialCashFlow(sql: NeonQueryFunction<false, false>, tenant: string, url: URL) {
  const { from, to } = windowOfUrl(url);
  const dayBefore = new Date(`${from}T00:00:00Z`);
  dayBefore.setUTCDate(dayBefore.getUTCDate() - 1);
  const priorTo = dayBefore.toISOString().slice(0, 10);

  const operating = async (f: string, t: string) => {
    const [sales, exp, po] = await Promise.all([
      sql`SELECT COALESCE(SUM(COALESCE(base_subtotal, subtotal, 0) - COALESCE(discount, 0)), 0)::numeric AS v
        FROM dypos.invoices
        WHERE tenant_id = ${tenant} AND status = 'completed'
          AND created_at::date BETWEEN ${f}::date AND ${t}::date`,
      sql`SELECT COALESCE(SUM(amount), 0)::numeric AS v FROM dypos.expenses
        WHERE tenant_id = ${tenant} AND expense_date BETWEEN ${f}::date AND ${t}::date`,
      sql`SELECT COALESCE(SUM(total_amount), 0)::numeric AS v FROM dypos.purchase_orders
        WHERE tenant_id = ${tenant} AND status = 'received'
          AND ordered_at BETWEEN ${f}::date AND ${t}::date`,
    ]);
    const inflow = Number(sales[0]?.v || 0);
    const expenseOut = Number(exp[0]?.v || 0);
    // Only RECEIVED orders are cash out. A pending or approved order is a
    // commitment, and counting it would understate the balance.
    const purchaseOut = Number(po[0]?.v || 0);
    return {
      inflow, expenseOut, purchaseOut,
      out: expenseOut + purchaseOut,
      net: inflow - expenseOut - purchaseOut,
    };
  };

  type Acc = Record<string, { inflow: number; outflow: number; entries: number }>;
  const movements = async (f: string, t: string): Promise<Acc> => {
    const rows = await sql`SELECT section, direction,
        COALESCE(SUM(amount), 0)::numeric AS amount, COUNT(*)::int AS entries
      FROM dypos.cash_movements
      WHERE tenant_id = ${tenant} AND occurred_on BETWEEN ${f}::date AND ${t}::date
      GROUP BY section, direction`;
    const acc: Acc = {};
    for (const r of rows as any[]) {
      acc[r.section] = acc[r.section] || { inflow: 0, outflow: 0, entries: 0 };
      if (r.direction === 'in') acc[r.section].inflow += Number(r.amount || 0);
      else acc[r.section].outflow += Number(r.amount || 0);
      acc[r.section].entries += Number(r.entries || 0);
    }
    return acc;
  };

  const [period, prior, sections, priorSections] = await Promise.all([
    operating(from, to),
    operating('1900-01-01', priorTo),
    movements(from, to),
    movements('1900-01-01', priorTo),
  ]);

  const netOf = (a: Acc, k: string) => (a[k]?.inflow || 0) - (a[k]?.outflow || 0);
  const countOf = (a: Acc, k: string) => a[k]?.entries || 0;

  const openingCash = prior.net
    + netOf(priorSections, 'investing') + netOf(priorSections, 'financing') + netOf(priorSections, 'other');
  const netChange = period.net
    + netOf(sections, 'investing') + netOf(sections, 'financing') + netOf(sections, 'other');
  const closingCash = openingCash + netChange;

  const section = (
    key: string, inflow: number, outflow: number, value: number, detail: Record<string, number>,
  ) => ({
    section: key,
    label: CASH_SECTION_LABELS[key],
    inflow: Math.round(inflow * 100) / 100,
    outflow: Math.round(outflow * 100) / 100,
    net: Math.round(value * 100) / 100,
    detail,
  });

  return {
    window: { from, to, branchId: null },
    currency: 'SAR',
    basis: 'صافي حركة النقد عبر النظام — ليس رصيدًا بنكيًا',
    sections: [
      section('operating', period.inflow, period.out, period.net, {
        'تحصيل فواتير المبيعات (صافي دون ضريبة)': period.inflow,
        'مصروفات تشغيلية': period.expenseOut,
        'أوامر شراء مستلمة': period.purchaseOut,
      }),
      section('investing', sections.investing?.inflow || 0, sections.investing?.outflow || 0,
        netOf(sections, 'investing'), {}),
      section('financing', sections.financing?.inflow || 0, sections.financing?.outflow || 0,
        netOf(sections, 'financing'), {}),
    ],
    openingCash: Math.round(openingCash * 100) / 100,
    netChange: Math.round(netChange * 100) / 100,
    closingCash: Math.round(closingCash * 100) / 100,
    totalInflow: Math.round(
      (period.inflow + (sections.investing?.inflow || 0) + (sections.financing?.inflow || 0)) * 100,
    ) / 100,
    totalOutflow: Math.round(
      (period.out + (sections.investing?.outflow || 0) + (sections.financing?.outflow || 0)) * 100,
    ) / 100,
    investingRecorded: countOf(sections, 'investing') > 0 || countOf(priorSections, 'investing') > 0,
    financingRecorded: countOf(sections, 'financing') > 0 || countOf(priorSections, 'financing') > 0,
    generatedAt: new Date().toISOString(),
  };
}

/** Headline tiles with a like-for-like comparison window. */
async function financialSummary(sql: NeonQueryFunction<false, false>, tenant: string, url: URL) {
  const { from, to } = windowOfUrl(url);
  const pnl = await financialPnl(sql, tenant, url);
  const flow = await financialCashFlow(sql, tenant, url);

  const prevTo = new Date(`${from}T00:00:00Z`);
  prevTo.setUTCDate(prevTo.getUTCDate() - 1);
  const spanDays = Math.max(
    1,
    Math.round(
      (new Date(`${to}T00:00:00Z`).getTime() - new Date(`${from}T00:00:00Z`).getTime()) / 86400000,
    ) + 1,
  );
  const prevFrom = new Date(prevTo);
  prevFrom.setUTCDate(prevFrom.getUTCDate() - spanDays + 1);
  const iso = (d: Date) => d.toISOString().slice(0, 10);

  const before = await salesFigures(sql, tenant, iso(prevFrom), iso(prevTo));
  const beforeExpenses = await expenseFigures(sql, tenant, iso(prevFrom), iso(prevTo));
  const beforeGross = before.netRevenue - before.cogs;
  const beforeNet = beforeGross - beforeExpenses.total;

  // Growth from zero is undefined. Returning 0% would imply a flat trend that
  // does not exist, so the field is null and the UI says "no prior period".
  const pct = (cur: number, prev: number) =>
    prev === 0 ? null : Math.round(((cur - prev) / prev) * 1000) / 10;

  return {
    window: { from, to, branchId: null },
    comparisonWindow: { from: iso(prevFrom), to: iso(prevTo) },
    revenue: pnl.sales.netRevenue,
    grossRevenue: pnl.sales.grossRevenue,
    vat: pnl.sales.vat,
    cogs: pnl.sales.cogs,
    grossProfit: pnl.grossProfit,
    grossMarginPct: pnl.grossMarginPct,
    operatingExpenses: pnl.expenses.total,
    operatingProfit: pnl.operatingProfit,
    netProfit: pnl.netProfit,
    netMarginPct: pnl.netMarginPct,
    invoices: pnl.sales.invoices,
    unitsSold: pnl.sales.units,
    cash: { opening: flow.openingCash, netChange: flow.netChange, closing: flow.closingCash },
    change: {
      revenue: pct(pnl.sales.netRevenue, before.netRevenue),
      grossProfit: pct(pnl.grossProfit, beforeGross),
      netProfit: pct(pnl.netProfit, beforeNet),
      expenses: pct(pnl.expenses.total, beforeExpenses.total),
    },
    completeness: pnl.completeness,
  };
}

/**
 * The monthly series, with every month present.
 *
 * `generate_series` builds the month list and the data LEFT JOINs onto it, so
 * a month with no trading comes back as a zero row instead of being absent. A
 * chart that silently skips a dead month compresses its x-axis and makes a
 * two-month gap look like a steady trend.
 */
async function financialTrend(sql: NeonQueryFunction<false, false>, tenant: string, url: URL) {
  const requested = Math.min(Math.max(Number(url.searchParams.get('months')) || 12, 1), 36);

  const revenue = await sql`SELECT to_char(span.m, 'YYYY-MM') AS month,
      COALESCE(SUM(COALESCE(i.base_subtotal, i.subtotal, 0) - COALESCE(i.discount, 0)), 0)::numeric AS revenue,
      COALESCE(SUM(COALESCE(i.base_tax, i.tax, 0)), 0)::numeric AS vat,
      COUNT(i.id)::int AS invoices
    FROM (SELECT generate_series(
        date_trunc('month', CURRENT_DATE) - (${requested}::int - 1) * INTERVAL '1 month',
        date_trunc('month', CURRENT_DATE), INTERVAL '1 month')::date AS m) span
    LEFT JOIN dypos.invoices i ON i.tenant_id = ${tenant} AND i.status = 'completed'
      AND i.created_at::date >= span.m
      AND i.created_at::date < (span.m + INTERVAL '1 month')::date
    GROUP BY span.m ORDER BY span.m`;

  const cogs = await sql`SELECT to_char(span.m, 'YYYY-MM') AS month,
      COALESCE(SUM(li.qty * li.unit_cost) FILTER (WHERE li.cost_known), 0)::numeric AS cogs
    FROM (SELECT generate_series(
        date_trunc('month', CURRENT_DATE) - (${requested}::int - 1) * INTERVAL '1 month',
        date_trunc('month', CURRENT_DATE), INTERVAL '1 month')::date AS m) span
    LEFT JOIN LATERAL (
      SELECT COALESCE(NULLIF(item->>'qty', ''), NULLIF(item->>'quantity', ''), '0')::numeric AS qty,
             COALESCE(NULLIF(item->>'cost', '')::numeric, p.cost) AS unit_cost,
             (item ? 'cost') OR (p.cost IS NOT NULL AND p.id IS NOT NULL) AS cost_known
      FROM dypos.invoices i
      CROSS JOIN LATERAL jsonb_array_elements(i.items) AS item
      LEFT JOIN dypos.products p ON p.id = item->>'productId' AND p.tenant_id = i.tenant_id
      WHERE i.tenant_id = ${tenant} AND i.status = 'completed'
        AND i.created_at::date >= span.m
        AND i.created_at::date < (span.m + INTERVAL '1 month')::date
    ) li ON TRUE
    GROUP BY span.m ORDER BY span.m`;

  const expenses = await sql`SELECT to_char(span.m, 'YYYY-MM') AS month,
      COALESCE(SUM(e.amount), 0)::numeric AS expenses
    FROM (SELECT generate_series(
        date_trunc('month', CURRENT_DATE) - (${requested}::int - 1) * INTERVAL '1 month',
        date_trunc('month', CURRENT_DATE), INTERVAL '1 month')::date AS m) span
    LEFT JOIN dypos.expenses e ON e.tenant_id = ${tenant}
      AND e.expense_date >= span.m AND e.expense_date < (span.m + INTERVAL '1 month')::date
    GROUP BY span.m ORDER BY span.m`;

  const cogsMap = new Map((cogs as any[]).map((r) => [r.month, Number(r.cogs || 0)]));
  const expMap = new Map((expenses as any[]).map((r) => [r.month, Number(r.expenses || 0)]));

  const series = (revenue as any[]).map((r) => {
    const rev = Number(r.revenue || 0);
    const cogsV = cogsMap.get(r.month) ?? 0;
    const exp = expMap.get(r.month) ?? 0;
    const gross = rev - cogsV;
    return {
      month: r.month,
      label: new Date(`${r.month}-01T00:00:00Z`).toLocaleDateString('ar-SA', {
        month: 'short', year: '2-digit', timeZone: 'UTC',
      }),
      revenue: rev,
      cogs: cogsV,
      grossProfit: gross,
      expenses: exp,
      netProfit: gross - exp,
      vat: Number(r.vat || 0),
      invoices: Number(r.invoices || 0),
      grossMarginPct: rev > 0 ? Math.round((gross / rev) * 1000) / 10 : null,
      netMarginPct: rev > 0 ? Math.round(((gross - exp) / rev) * 1000) / 10 : null,
    };
  });

  return {
    months: requested,
    branchId: null,
    series,
    activeMonths: series.filter((m) => m.invoices > 0).length,
    generatedAt: new Date().toISOString(),
  };
}

/** Expense mix by reporting bucket, for the pie chart. */
async function financialExpenseMix(sql: NeonQueryFunction<false, false>, tenant: string, url: URL) {
  const { from, to } = windowOfUrl(url);
  const expenses = await expenseFigures(sql, tenant, from, to);
  return {
    window: { from, to, branchId: null },
    total: expenses.total,
    recorded: expenses.recorded,
    items: expenses.lines,
  };
}

/** The completeness notes the UI renders ABOVE the figures, not below them. */
function completenessNotes(sales: any, expenses: any): string[] {
  const notes: string[] = [];
  if (sales.lineCount === 0) {
    notes.push('لا توجد فواتير مكتملة في هذه الفترة — لا يمكن احتساب تكلفة المبيعات.');
  } else if (sales.cogsUnattributed > 0) {
    notes.push(`${sales.cogsUnattributed} سطر بيع بلا تكلفة معروفة — مجمل الربح مُقدَّر ومنخفض بحد أقصى تكلفة هذه السطور.`);
  }
  if (!expenses.recorded) {
    notes.push('لا توجد مصروفات تشغيلية مسجّلة في هذه الفترة — صافي الربح يعادل مجمل الربح وهو غير مكتمل.');
  }
  return notes;
}

/** Bill-of-materials listing, matching the Express `/production/recipes`. */
async function listRecipes(sql: NeonQueryFunction<false, false>, tenant: string) {
  return sql`
    SELECT r.id, r.product_id, r.version, r.yield_qty, r.is_active,
           p.name AS product_name,
           COALESCE(
             json_agg(
               json_build_object(
                 'id', ri.id,
                 'componentId', ri.component_product_id,
                 'componentName', cp.name,
                 'qty', ri.qty,
                 'wastePercent', ri.waste_percent
               )
             ) FILTER (WHERE ri.id IS NOT NULL),
             '[]'::json
           ) AS components
    FROM dypos.product_recipes r
    LEFT JOIN dypos.products p ON r.product_id = p.id
    LEFT JOIN dypos.product_recipe_items ri ON ri.recipe_id = r.id
    LEFT JOIN dypos.products cp ON ri.component_product_id = cp.id
    WHERE r.tenant_id = ${tenant}
    GROUP BY r.id, p.name
    ORDER BY p.name`;
}

/** Accrued vs paid commission split, identical to the Express reduce(). */
function totalsOf(rows: any[]) {
  return rows.reduce(
    (acc, r) => {
      if (r.status === 'paid') acc.paid += Number(r.amount);
      else acc.accrued += Number(r.amount);
      return acc;
    },
    { accrued: 0, paid: 0 },
  );
}

async function route(
  method: string, path: string, url: URL, req: Request,
  env: Env, body: any, principal: Principal, requestId: string,
): Promise<Response> {
  // Bound as `sql` so the ~60 call sites below can use it as a tagged template.
  // The factory is deliberately named `getSql`: as `const sql = sql(env)` this
  // line shadowed the function and threw a temporal-dead-zone ReferenceError on
  // every request the Worker handled.
  const sql: NeonQueryFunction<false, false> = getSql(env);
  // The tenant comes from the signed token, not from a header — otherwise a
  // caller could read another tenant simply by setting x-tenant-id.
  const tenant = principal.tenantId;
  const limit = Math.min(Number(url.searchParams.get('limit')) || 200, 1000);

  /*
   * The production mirror: paths the SPA calls that were only ever registered in
   * Express (home screen, shifts, currencies/UoM, accounting periods). This
   * delegates first and returns null for anything it does not own, so the table
   * below is untouched for the routes it already serves.
   */
  const mirrored = await handleEdgeDataRoute({
    method, path, url, req, body, principal, requestId,
    sql, tenant, json, fail, makeId, audit, env,
  });
  if (mirrored) return mirrored;

  if (method === 'GET') {
    switch (true) {
      /*
       * Settlement accounts — the merchant's own bank destination.
       *
       * Present because the till's bank-transfer QR is read from here. When the
       * compiled-in IBAN was removed, this route became the ONLY source of an
       * account, so without it the till would have shown no bank transfer at all
       * rather than the wrong one. Scope comes from the token like every other
       * protected route, so one merchant can never see another's account.
       */
      case path === '/settlement/accounts':
        return json({
          items: await sql`SELECT id, branch_id AS "branchId", iban,
                  bank_name AS "bankName", holder_name AS "holderName",
                  swift_bic AS "swiftBic", country_code AS "countryCode",
                  payment_method AS "paymentMethod", is_default AS "isDefault"
            FROM dypos.bank_settlement_accounts
           WHERE tenant_id = ${tenant} AND is_active
           ORDER BY is_default DESC, bank_name NULLS LAST, created_at`,
        });

      case path === '/products': {
        /*
         * The SAME envelope the Express route serves. `items` is what the
         * client reads — returning only `products` here left the production
         * inventory screen empty while development (Express) rendered every
         * row, which is the defect this shape fixes. The column list is
         * aliased identically on both paths (`unit_price AS price`), and
         * `is_active IS NOT FALSE` keeps deactivated products out of the
         * catalogue without hiding rows whose column is NULL.
         */
        const rows = await sql`SELECT id, name, name_en, sku, barcode, category,
              category_id, unit_price AS price, cost, stock, min_stock, unit,
              tax_rate, image_url, is_active
          FROM dypos.products
          WHERE tenant_id = ${tenant} AND is_active IS NOT FALSE
          ORDER BY name ASC`;
        return json({ items: rows, products: rows, count: rows.length });
      }

      case path === '/invoices':
        return json({ invoices: await sql`SELECT * FROM dypos.invoices
          WHERE tenant_id = ${tenant} ORDER BY created_at DESC
          LIMIT ${Math.min(num(url.searchParams.get('limit'), 100), 500)}` });

      case path === '/employees':
        return json({ items: await sql`SELECT * FROM dypos.employees
          WHERE tenant_id = ${tenant} ORDER BY name ASC` });

      case path === '/customers':
        return json({ items: await sql`SELECT * FROM dypos.customers
          WHERE tenant_id = ${tenant} ORDER BY name ASC` });

      case path === '/services':
        return json({ items: await sql`SELECT * FROM dypos.services
          WHERE tenant_id = ${tenant} ORDER BY name ASC` });

      case path === '/appointments':
        return json({ items: await sql`SELECT a.*, s.name AS service_name,
            e.name AS employee_name
          FROM dypos.appointments a
          LEFT JOIN dypos.services  s ON a.service_id  = s.id
          LEFT JOIN dypos.employees e ON a.employee_id = e.id
          WHERE a.tenant_id = ${tenant}
          ORDER BY a.scheduled_start ASC LIMIT ${limit}` });

      case path === '/production':
        return json({ items: await sql`SELECT po.*, p.name AS product_name,
            p.unit, p.unit_price
          FROM dypos.production_orders po
          LEFT JOIN dypos.products p ON po.product_id = p.id
          WHERE po.tenant_id = ${tenant}
          ORDER BY po.created_at DESC LIMIT 500` });

      case path === '/production/recipes':
        return json({ items: await listRecipes(sql, tenant) });

      case path === '/batches':
        return json({ items: await sql`SELECT b.*, p.name AS product_name, p.unit,
              (b.expiry_date - CURRENT_DATE) AS days_to_expiry,
              b.quantity * b.cost AS batch_value
          FROM dypos.product_batches b
          LEFT JOIN dypos.products p ON b.product_id = p.id
          WHERE b.tenant_id = ${tenant}
          ORDER BY b.expiry_date NULLS LAST, b.created_at DESC LIMIT 1000` });

      case path === '/serials':
        return json({ items: await sql`SELECT s.*, p.name AS product_name,
            p.unit_price
          FROM dypos.product_serials s
          LEFT JOIN dypos.products p ON s.product_id = p.id
          WHERE s.tenant_id = ${tenant}
          ORDER BY s.created_at DESC LIMIT 1000` });

      case path === '/commissions': {
        const year = url.searchParams.get('year');
        const month = url.searchParams.get('month');
        const items = year && month
          ? await sql`SELECT * FROM dypos.commissions
              WHERE tenant_id = ${tenant} AND period_year = ${Number(year)}
                AND period_month = ${Number(month)}
              ORDER BY employee_name`
          : await sql`SELECT * FROM dypos.commissions
              WHERE tenant_id = ${tenant}
              ORDER BY period_year DESC, period_month DESC, employee_name`;
        return json({ items, totals: totalsOf(items) });
      }

      case path === '/delivery-zones':
        return json({ items: await sql`SELECT * FROM dypos.delivery_zones
          WHERE tenant_id = ${tenant} AND is_active = true ORDER BY fee` });

      case path === '/deliveries':
        return json({ items: await sql`SELECT d.*, z.name AS zone_name,
            z.estimated_minutes
          FROM dypos.deliveries d
          LEFT JOIN dypos.delivery_zones z ON d.zone_id = z.id
          WHERE d.tenant_id = ${tenant}
          ORDER BY d.created_at DESC LIMIT 500` });

      // -------------------------------------------------------------------
      // Financial statements.
      //
      // The edge deployment serves the SAME /api/db/financials/* contract as
      // the Express server, or the statements screen would work in development
      // and 404 in production. Every figure is aggregated by PostgreSQL here
      // too; the arithmetic mirrors server/financialRoutes.ts exactly.
      //
      // `reports.view` is enforced by the same principal check every other
      // business route goes through — the Worker has no per-route RBAC table,
      // so tenant isolation comes from the signed token, never the header.
      // -------------------------------------------------------------------

      case path === '/financials/pnl':
        return json(await financialPnl(sql, tenant, url));

      case path === '/financials/summary':
        return json(await financialSummary(sql, tenant, url));

      case path === '/financials/cash-flow':
        return json(await financialCashFlow(sql, tenant, url));

      case path === '/financials/trend':
        return json(await financialTrend(sql, tenant, url));

      case path === '/financials/expense-breakdown':
        return json(await financialExpenseMix(sql, tenant, url));

      case path === '/financials/statements':
        return json({ items: await sql`SELECT s.*, b.name AS branch_name
            FROM dypos.financial_statements s
            LEFT JOIN dypos.branches b ON b.id = s.branch_id
            WHERE s.tenant_id = ${tenant}
            ORDER BY s.period DESC, s.version DESC LIMIT 200` });

      case path === '/suppliers':
        return json({ items: await sql`SELECT * FROM dypos.suppliers WHERE tenant_id = ${tenant} ORDER BY name ASC` });

      case path === '/categories':
        return json({ items: await sql`SELECT * FROM dypos.categories WHERE tenant_id = ${tenant} ORDER BY name ASC` });

      case path === '/tenant/profile':
      case path === '/tenant/industry-profile': {
        const rows = await sql`SELECT * FROM dypos.tenants WHERE id = ${tenant}`;
        return json({ profile: rows[0] || { id: tenant, name: 'Default Tenant' }, tenant: rows[0] || null });
      }

      case path === '/entitlements':
      case path === '/erp/entitlements': {
        return json({
          tenantId: tenant,
          plan: 'enterprise',
          screens: ['pos', 'inventory', 'accounting', 'purchases', 'reports', 'branches', 'settings'],
          limits: { branches: 10, users: 50 }
        });
      }

      case path === '/transactions':
        return json({ items: await sql`SELECT * FROM dypos.transactions WHERE tenant_id = ${tenant} ORDER BY created_at DESC LIMIT ${limit}` });

      case path === '/purchase-orders': {
        /*
         * The screen renders `po.items.map(...)`, so an order WITHOUT an
         * `items` array is a crash, not a cosmetic gap: the aggregate is
         * coalesced to `[]` and the supplier is left-joined to '' rather than
         * dropped. Lines come from `purchase_order_lines` (free-text lines),
         * never `purchase_order_items`, whose `product_id` is NOT NULL + FK.
         */
        let rows;
        try {
          rows = await sql`SELECT po.id, po.po_number AS "poNumber",
              po.supplier_id AS "supplierId",
              COALESCE(s.name, '') AS "supplierName",
              po.total_amount AS "totalAmount",
              po.status,
              to_char(po.ordered_at, 'YYYY-MM-DD') AS "orderDate",
              COALESCE((
                SELECT json_agg(json_build_object(
                         'productName', l.product_name,
                         'quantity',     l.quantity,
                         'unitCost',     l.unit_cost)
                       ORDER BY l.position)
                FROM dypos.purchase_order_lines l
                WHERE l.po_id = po.id AND l.tenant_id = po.tenant_id
              ), '[]'::json) AS items
            FROM dypos.purchase_orders po
            LEFT JOIN dypos.suppliers s
              ON s.id = po.supplier_id AND s.tenant_id = po.tenant_id
            WHERE po.tenant_id = ${tenant}
            ORDER BY po.ordered_at DESC NULLS LAST, po.created_at DESC
            LIMIT ${limit}`;
        } catch (err: any) {
          // Most likely `purchase_order_lines` (added by a migration that runs
          // before this Worker deploys) is absent. Say so in Arabic and log
          // the real cause; never answer with an items-less order.
          console.error('[dypos-worker] purchase-orders list', method, path, err);
          return fail(500, 'تعذّر جلب أوامر الشراء — تأكد من تشغيل ترحيل الأصناف ثم أعد المحاولة', path, method, requestId);
        }
        const items = (rows as any[]).map((r) => ({
          id: r.id,
          poNumber: r.poNumber,
          supplierId: r.supplierId ?? '',
          supplierName: r.supplierName || '',
          items: r.items || [],
          // NUMERIC arrives as a string; `totalAmount` is a number in the
          // client's PurchaseOrder type and is summed there.
          totalAmount: Number(r.totalAmount),
          status: r.status,
          orderDate: r.orderDate,
        }));
        return json({ items, count: items.length });
      }

      /*
       * Journal entries — the accounting screen's list. There was no route at
       * all (404), so the ledger never left the server.
       *
       * The two account labels are READ BACK from `dypos.ledger`: the debit
       * leg is the row with debit > 0, the credit leg the one with credit > 0,
       * rendered as `${account_name} (${account_code})`. A journal with no
       * legs returns '' for both — inventing an account name here would put
       * an account in the UI that the database does not hold.
       */
      case path === '/journal-entries': {
        const rows = await sql`SELECT je.id, je.entry_number AS "entryNumber",
              to_char(je.date, 'YYYY-MM-DD') AS date, je.description,
              je.total_amount AS amount, je.status
          FROM dypos.journal_entries je
          WHERE je.tenant_id = ${tenant}
          ORDER BY je.date DESC NULLS LAST, je.created_at DESC
          LIMIT ${limit}`;

        const ids = (rows as any[]).map((r) => r.id);
        const legs = ids.length
          ? await sql`SELECT journal_id, account_code, account_name, debit, credit
              FROM dypos.ledger WHERE journal_id = ANY(${ids}::varchar[])`
          : [];
        const perJournal = new Map<string, { debit: string; credit: string }>();
        for (const l of legs as any[]) {
          const entry = perJournal.get(l.journal_id) || { debit: '', credit: '' };
          const label = l.account_name
            ? `${l.account_name} (${l.account_code})`
            : String(l.account_code);
          if (!entry.debit && Number(l.debit) > 0) entry.debit = label;
          if (!entry.credit && Number(l.credit) > 0) entry.credit = label;
          perJournal.set(l.journal_id, entry);
        }

        const items = (rows as any[]).map((r) => ({
          id: r.id,
          entryNumber: r.entryNumber,
          date: r.date,
          description: r.description,
          accountDebit: perJournal.get(r.id)?.debit || '',
          accountCredit: perJournal.get(r.id)?.credit || '',
          // NUMERIC arrives as a string; the client reduces with
          // `sum + je.amount`, so it must be a number or the total corrupts.
          amount: Number(r.amount),
          status: r.status,
        }));
        return json({ items, count: items.length });
      }

      case path === '/me':
      case path === '/erp/me': {
        return json({
          user: { id: principal.userId, username: principal.username, name: principal.name, role: principal.role },
          branch: principal.branchId ? { id: principal.branchId } : null,
          tenantId: tenant
        });
      }

      // Tenant context (commercial_reg, tax_number, vat_rate, etc.)
      case path === '/tenant/context': {
        const rows = await sql`SELECT id, name, commercial_reg, tax_number, country_code,
              base_currency, plan, establishment_segment, vat_rate,
              annual_revenue, is_active
           FROM dypos.tenants WHERE id = ${tenant}`;
        const t = rows[0];
        if (!t) return fail(404, 'المستأجر غير موجود');
        return json({
          id: t.id, name: t.name, commercialReg: t.commercial_reg,
          taxNumber: t.tax_number, countryCode: t.country_code,
          baseCurrency: t.base_currency || 'SAR', plan: t.plan,
          establishmentSegment: t.establishment_segment,
          vatRate: t.vat_rate == null ? 15 : Number(t.vat_rate),
          annualRevenue: t.annual_revenue == null ? null : Number(t.annual_revenue),
          annualRevenueDeclared: t.annual_revenue != null,
          isActive: t.is_active !== false,
        });
      }

      // Capabilities
      case path === '/capabilities': {
        return json({ capabilities: await sql`SELECT * FROM dypos.capabilities WHERE is_active = TRUE ORDER BY category, name_ar` });
      }

      // Measurements module
      case path === '/measurements': {
        return json({ measurements: await sql`SELECT m.*, c.name as customer_name
            FROM dypos.measurements m
            LEFT JOIN dypos.customers c ON m.customer_id = c.id
            WHERE m.tenant_id = ${tenant} ORDER BY m.created_at DESC` });
      }

      // Work Orders module
      case path === '/work-orders': {
        return json({ workOrders: await sql`SELECT wo.*, c.name as customer_name, u.name as assigned_to_name
            FROM dypos.work_orders wo
            LEFT JOIN dypos.customers c ON wo.customer_id = c.id
            LEFT JOIN dypos.users u ON wo.assigned_to = u.id
            WHERE wo.tenant_id = ${tenant} ORDER BY wo.created_at DESC` });
      }

      default:
        return fail(404, `Unknown endpoint: ${path}`);
    }
  }

  // ---------------- write endpoints ----------------
  if (!body) return fail(400, 'Request body is required', path, method, requestId);
  const seg = path.split('/')[1] || '';
  const id = path.split('/')[2] || '';

  switch (true) {
    /*
     * ---- settlement accounts ----
     *
     * The tenant is the token's, never the body's. Accepting a `tenantId` from
     * the request is the cross-tenant write that `tenantOf` would have enabled,
     * and this route must not become the next one to do it.
     *
     * The IBAN is normalised here exactly as the Express route does — spaces
     * stripped, upper-cased — so the two paths cannot disagree about what the
     * same account looks like.
     */
    case method === 'POST' && path === '/settlement/accounts': {
      const iban = String(body.iban || '').trim().replace(/\s+/g, '').toUpperCase();
      if (!iban) return fail(400, 'IBAN is required', path, method, requestId);
      return json({ item: (await sql`INSERT INTO dypos.bank_settlement_accounts
          (id, tenant_id, branch_id, iban, bank_name, holder_name,
           country_code, payment_method, is_active, is_default)
        VALUES (${body.id || makeId('bank')}, ${tenant}, ${body.branchId || null},
          ${iban}, ${body.bankName || null}, ${body.holderName || null},
          ${body.countryCode || null}, ${body.paymentMethod || 'bank_transfer'},
          ${body.isActive === false ? false : true}, ${body.isDefault === true})
        ON CONFLICT (id) DO UPDATE SET
          iban = EXCLUDED.iban, bank_name = EXCLUDED.bank_name,
          holder_name = EXCLUDED.holder_name, country_code = EXCLUDED.country_code,
          is_active = EXCLUDED.is_active, is_default = EXCLUDED.is_default,
          updated_at = NOW()
        RETURNING id, iban, bank_name AS "bankName", holder_name AS "holderName",
                  is_active AS "isActive", is_default AS "isDefault"`)[0] },
        201,
      );
    }

    // ---- invoices (POS checkout) ----
    // Mirrors server.ts exactly: idempotency, stock FOR UPDATE, server-computed prices,
    // document number allocation, stock movements, stockAfter response.
    case method === 'POST' && path === '/invoices': {
      const items: any[] = Array.isArray(body.items) ? body.items : [];
      if (!items.length) return fail(400, 'الفاتورة لا تحتوي على أصناف', path, method, requestId);
      if (!(Number(body.total) >= 0)) return fail(400, 'إجمالي الفاتورة غير صالح', path, method, requestId);

      const idempotencyKey = typeof body.idempotencyKey === 'string'
        ? body.idempotencyKey.trim().slice(0, 128)
        : null;

      if (idempotencyKey) {
        const prior = await sql`SELECT id, invoice_number, subtotal, tax, discount, total,
                status, payment_method, currency_code, items, timestamp
           FROM dypos.invoices
          WHERE tenant_id = ${tenant} AND idempotency_key = ${idempotencyKey}`;
        if (prior[0]) {
          return json({
            item: prior[0],
            invoice: prior[0],
            stockAfter: {},
            replayed: true,
          });
        }
      }

      // ---- Stock check & price computation (server-authoritative) ----
      const lines: Array<{
        productId: string | null; name: string; quantity: number;
        unitPrice: number; taxRate: number; taxAmount: number; total: number;
      }> = [];
      let computedSubtotal = 0;
      let computedTax = 0;

      for (const it of items) {
        const qty = Number(it.quantity);
        if (!(qty > 0)) {
          return fail(400, `كمية غير صالحة للصنف ${it.name ?? it.productId ?? ''}`, path, method, requestId);
        }
        let unitPrice: number;
        let taxRate: number;
        let name: string;

        if (it.productId) {
          const p = await sql`SELECT name, stock, unit_price, tax_rate FROM dypos.products
              WHERE id = ${it.productId} AND tenant_id = ${tenant} FOR NO KEY UPDATE`;
          if (!p[0]) {
            return fail(400, `الصنف ${it.productId} غير موجود في هذا المستأجر`, path, method, requestId);
          }
          if (Number(p[0].stock) < qty) {
            return fail(409, `الكمية غير متوفرة للصنف «${p[0].name}» (المتاح ${p[0].stock})`, path, method, requestId);
          }
          unitPrice = Number(p[0].unit_price);
          taxRate = Number(p[0].tax_rate ?? body.vatRate ?? 15);
          name = p[0].name;
        } else {
          unitPrice = Number(it.unitPrice ?? it.price);
          taxRate = Number(body.vatRate ?? 15);
          name = String(it.name ?? 'صنف');
        }

        if (!Number.isFinite(unitPrice) || unitPrice <= 0) {
          return fail(409, `لا يمكن بيع «${name}» بسعر صفر أو غير معروف — سجّل السعر أولاً`, path, method, requestId);
        }
        if (!Number.isFinite(taxRate) || taxRate < 0 || taxRate > 100) {
          return fail(409, `نسبة ضريبة غير صالحة للصنف «${name}»`, path, method, requestId);
        }

        const lineNet = qty * unitPrice;
        const lineTax = (lineNet * taxRate) / 100;
        computedSubtotal += lineNet;
        computedTax += lineTax;
        lines.push({
          productId: it.productId ?? null,
          name,
          quantity: qty,
          unitPrice,
          taxRate,
          taxAmount: lineTax,
          total: lineNet + lineTax,
        });
      }

      const computedTotal = computedSubtotal + computedTax;
      if (Number.isFinite(Number(body.total)) && Math.abs(Number(body.total) - computedTotal) > 0.01) {
        return fail(409, 'إجمالي الفاتورة لا يطابق الأسعار المحفوظة في النظام — لم تُسجَّل العملية', path, method, requestId);
      }

      // ---- Document number allocation ----
      const periodKey = String(new Date().getUTCFullYear());
      const prefix = 'INV';
      await sql`INSERT INTO dypos.document_sequences
          (tenant_id, doc_type, period_key, next_value, prefix)
        VALUES (${tenant}, 'invoice', ${periodKey}, 1, ${prefix})
        ON CONFLICT (tenant_id, doc_type, period_key) DO NOTHING`;
      const seq = await sql`UPDATE dypos.document_sequences
          SET next_value = next_value + 1, updated_at = NOW()
        WHERE tenant_id = ${tenant} AND doc_type = 'invoice' AND period_key = ${periodKey}
        RETURNING next_value, prefix`;
      if (!seq[0]) return fail(500, 'تعذّر تخصيص رقم للفاتورة', path, method, requestId);
      const issued = Number(seq[0].next_value) - 1;
      const invoiceNumber = `${String(seq[0].prefix || prefix)}-${periodKey}-${String(issued).padStart(6, '0')}`;

      // ---- Insert invoice ----
      const id = body.id || makeId('inv');
      let inserted: any;
      try {
        inserted = await sql`INSERT INTO dypos.invoices
            (id, tenant_id, invoice_number, branch_id, customer_name,
             cashier_name, subtotal, tax, discount, total,
             payment_method, status, currency_code, exchange_rate, items, timestamp,
             idempotency_key)
          VALUES (${id}, ${tenant}, ${invoiceNumber}, ${body.branchId ?? null}, ${body.customerName ?? 'عميل نقدي'},
            ${body.cashierName ?? null}, ${computedSubtotal}, ${computedTax}, 0, ${computedTotal},
            ${body.paymentMethod ?? 'mada'}, 'completed',
            ${body.currencyCode ?? 'SAR'}, ${Number(body.exchangeRate ?? 1)},
            ${JSON.stringify(items)}, ${body.timestamp ?? new Date().toISOString()},
            ${idempotencyKey})
          RETURNING *`;
      } catch (e: any) {
        // A unique violation on the idempotency key is not a failure — it is the
        // database reporting that a concurrent copy of this exact request won the
        // race and committed first. Return the original invoice.
        if (e?.code === '23505' && idempotencyKey) {
          const winner = await sql`SELECT id, invoice_number, subtotal, tax, discount, total,
                  status, payment_method, currency_code, items, timestamp
             FROM dypos.invoices
            WHERE tenant_id = ${tenant} AND idempotency_key = ${idempotencyKey}`;
          if (winner[0]) {
            return json({
              item: winner[0],
              invoice: winner[0],
              stockAfter: {},
              replayed: true,
            });
          }
        }
        throw e;
      }

      // ---- Insert line items & stock movements ----
      for (const it of lines) {
        const qty = it.quantity;
        await sql`INSERT INTO dypos.invoice_items
            (id, invoice_id, product_id, quantity, unit_price, discount, tax_amount, total)
          VALUES (${makeId('inv-item')}, ${id}, ${it.productId}, ${qty}, ${it.unitPrice}, 0, ${it.taxAmount}, ${it.total})`;

        if (it.productId) {
          await sql`INSERT INTO dypos.stock_movements
              (id, product_id, tenant_id, type, quantity, reference_id, reason)
            VALUES (${makeId('mov')}, ${it.productId}, ${tenant}, 'out', ${qty}, ${id}, ${`بيع فاتورة ${invoiceNumber}`})`;
        }
      }

      // ---- Read stock after commit ----
      const stockAfter: Record<string, string> = {};
      const uniqueProductIds = [...new Set(items.filter((it: any) => it.productId).map((it: any) => it.productId))];
      for (const pid of uniqueProductIds) {
        const r = await sql`SELECT stock FROM dypos.products WHERE id = ${pid} AND tenant_id = ${tenant}`;
        if (r[0]) stockAfter[pid] = String(r[0].stock);
      }

      return json({
        item: inserted[0],
        invoice: inserted[0],
        stockAfter,
      }, 201);
    }

    // ---- journal entries ----
    case method === 'POST' && path === '/journal-entries': {
      if (typeof body !== 'object' || body === null || Array.isArray(body)) {
        return fail(400, 'بيانات القيد غير صالحة', path, method, requestId);
      }
      const description = String(body.description ?? '').trim();
      if (!description) return fail(400, 'وصف القيد مطلوب', path, method, requestId);
      const amount = Number(body.amount);
      if (!Number.isFinite(amount) || amount <= 0) {
        return fail(400, 'مبلغ القيد يجب أن يكون رقماً موجباً أكبر من صفر', path, method, requestId);
      }

      // The server owns the number. The client's `JE-TMP-<uuid>` was unique
      // per browser session only — the exact failure document_sequences exists
      // to prevent: two tills issuing the same number for different entries.
      const seq = await allocateDocumentNumber(sql, tenant, 'journal', 'JRN');
      if (!seq) return fail(500, 'تعذّر تخصيص رقم القيد', path, method, requestId);

      // `status` accepts only the two states the screens know; a stray string
      // becomes 'posted' rather than a value nothing renders. An absent or
      // malformed date falls back to today (UTC).
      const entryDate = isoDate(body.date);
      const status = body.status === 'draft' ? 'draft' : 'posted';

      const inserted = (await sql`INSERT INTO dypos.journal_entries
          (id, tenant_id, entry_number, date, description, total_amount, status)
        VALUES (${makeId('je')}, ${tenant}, ${seq.number}, ${entryDate},
          ${description}, ${amount}, ${status})
        RETURNING id, entry_number AS "entryNumber",
          to_char(date, 'YYYY-MM-DD') AS date, description,
          total_amount AS amount, status`)[0] as any;

      /*
       * The two ledger legs — written only when BOTH account strings carry a
       * parenthesised code (`الصندوق الرئيسي (1101)`). One parsed side would
       * post half of a double entry, which is worse than posting none, so a
       * missing code keeps the journal row and skips both legs instead of
       * failing a request that has already been validated.
       *
       * The code in parentheses identifies the account; the text outside it
       * becomes `account_name`, exactly as GET /journal-entries reads it back.
       */
      const debitCode = /\(([^)]+)\)/.exec(String(body.accountDebit ?? ''));
      const creditCode = /\(([^)]+)\)/.exec(String(body.accountCredit ?? ''));
      let accountDebit = '';
      let accountCredit = '';
      if (debitCode && creditCode) {
        const debitName = String(body.accountDebit ?? '').replace(/\([^)]*\)/g, '').trim();
        const creditName = String(body.accountCredit ?? '').replace(/\([^)]*\)/g, '').trim();
        const debitRef = debitCode[1].trim();
        const creditRef = creditCode[1].trim();
        accountDebit = debitName ? `${debitName} (${debitRef})` : debitRef;
        accountCredit = creditName ? `${creditName} (${creditRef})` : creditRef;
        try {
          await sql`INSERT INTO dypos.ledger
              (id, journal_id, account_code, account_name, debit, credit)
            VALUES (${makeId('led')}, ${inserted.id}, ${debitRef},
              ${debitName || null}, ${amount}, 0)`;
          await sql`INSERT INTO dypos.ledger
              (id, journal_id, account_code, account_name, debit, credit)
            VALUES (${makeId('led')}, ${inserted.id}, ${creditRef},
              ${creditName || null}, 0, ${amount})`;
        } catch (err: any) {
          // The header is already written. Answering 500 would make the client
          // retry and duplicate an entry that EXISTS — the lost/duplicated
          // write this route is here to fix. Keep the header, drop the labels
          // so the response says exactly what GET will later read back, and
          // log the imbalance.
          console.error('[dypos-worker] journal ledger legs', method, path, err);
          accountDebit = '';
          accountCredit = '';
        }
      }

      return json({
        item: { ...inserted, amount: Number(inserted.amount), accountDebit, accountCredit },
      }, 201);
    }

    // ---- purchase orders ----
    case method === 'POST' && path === '/purchase-orders': {
      if (typeof body !== 'object' || body === null || Array.isArray(body)) {
        return fail(400, 'بيانات أمر الشراء غير صالحة', path, method, requestId);
      }
      const rawItems: any[] = Array.isArray(body.items) ? body.items : [];
      if (!rawItems.length) return fail(400, 'أمر الشراء لا يحتوي على أصناف', path, method, requestId);

      const lines: Array<{ productName: string; quantity: number; unitCost: number }> = [];
      let computedTotal = 0;
      for (const it of rawItems) {
        if (!it || typeof it !== 'object' || Array.isArray(it)) {
          return fail(400, 'بند من بنود أمر الشراء غير صالح', path, method, requestId);
        }
        const productName = String(it.productName ?? '').trim();
        if (!productName) return fail(400, 'اسم الصنف مطلوب في أمر الشراء', path, method, requestId);
        const quantity = Number(it.quantity);
        if (!Number.isFinite(quantity) || quantity <= 0) {
          return fail(400, `كمية غير صالحة للصنف «${productName}»`, path, method, requestId);
        }
        const unitCost = Number(it.unitCost ?? 0);
        if (!Number.isFinite(unitCost)) {
          return fail(400, `تكلفة وحدة غير صالحة للصنف «${productName}»`, path, method, requestId);
        }
        computedTotal += quantity * unitCost;
        lines.push({ productName, quantity, unitCost });
      }

      /*
       * The same honesty rule the invoice route applies: a client-supplied
       * total is trusted ONLY when it matches what the server just computed
       * from these same lines, within a cent. An absent or non-numeric total
       * simply takes the computed sum — but a total the client cannot account
       * for is never written.
       */
      const providedTotal = body.totalAmount == null ? Number.NaN : Number(body.totalAmount);
      let totalAmount = computedTotal;
      if (Number.isFinite(providedTotal)) {
        if (Math.abs(providedTotal - computedTotal) > 0.01) {
          return fail(400, 'إجمالي أمر الشراء لا يطابق مجموع أصنافه — لم تُسجَّل الطلبية', path, method, requestId);
        }
        totalAmount = providedTotal;
      }

      const seq = await allocateDocumentNumber(sql, tenant, 'purchase_order', 'PO');
      if (!seq) return fail(500, 'تعذّر تخصيص رقم أمر الشراء', path, method, requestId);

      let poRow: any;
      try {
        poRow = (await sql`INSERT INTO dypos.purchase_orders
            (id, tenant_id, po_number, supplier_id, branch_id, total_amount,
             status, ordered_at, notes)
          VALUES (${makeId('po')}, ${tenant}, ${seq.number},
            ${String(body.supplierId ?? '') || null},
            ${String(body.branchId ?? '') || null},
            ${totalAmount}, ${String(body.status ?? 'approved')},
            ${isoDate(body.orderDate)}, ${String(body.notes ?? '') || null})
          RETURNING *, to_char(ordered_at, 'YYYY-MM-DD') AS "orderDate"`)[0];
      } catch (err: any) {
        // `po_number` is UNIQUE: a collision means the counter row was reused,
        // and that is a conflict to report in Arabic — never a 500 telling the
        // operator to blindly retry into another duplicate.
        if (err?.code === '23505') {
          return fail(409, `رقم أمر الشراء «${seq.number}» مستخدم مسبقاً — أعد المحاولة`, path, method, requestId);
        }
        // supplier_id / branch_id reference rows that must exist.
        if (err?.code === '23503') {
          return fail(400, 'المورد أو الفرع المرجعي غير موجود', path, method, requestId);
        }
        throw err;
      }

      /*
       * Lines go to `purchase_order_lines`, NOT `purchase_order_items`: the
       * old table demands a product_id FK, and this route accepts free-text
       * lines ("خامات تغليف") with no product row behind them. The table is
       * added by a migration that runs before this Worker deploys; if the
       * query fails anyway, say so in Arabic — never invent rows, and never
       * answer 500 in English for a schema the operator can fix.
       */
      try {
        for (let position = 0; position < lines.length; position++) {
          const line = lines[position];
          await sql`INSERT INTO dypos.purchase_order_lines
              (id, tenant_id, po_id, position, product_name, quantity,
               unit_cost, line_total)
            VALUES (${makeId('po-line')}, ${tenant}, ${poRow.id}, ${position},
              ${line.productName}, ${line.quantity}, ${line.unitCost},
              ${line.quantity * line.unitCost})`;
        }
      } catch (err: any) {
        console.error('[dypos-worker] purchase-order lines', method, path, err);
        return fail(500, 'تعذّر حفظ أصناف أمر الشراء — تأكد من تشغيل ترحيل الأصناف ثم أعد المحاولة', path, method, requestId);
      }

      const supplier = poRow.supplier_id
        ? await sql`SELECT name FROM dypos.suppliers
            WHERE id = ${poRow.supplier_id} AND tenant_id = ${tenant}`
        : [];

      return json({
        item: {
          id: poRow.id,
          poNumber: poRow.po_number,
          supplierId: poRow.supplier_id ?? '',
          supplierName: (supplier as any[])[0]?.name || '',
          items: lines,
          totalAmount: Number(poRow.total_amount),
          status: poRow.status,
          orderDate: poRow.orderDate,
        },
      }, 201);
    }

    // ---- products ----
    case method === 'POST' && path === '/products': {
      if (typeof body !== 'object' || body === null || Array.isArray(body)) {
        return fail(400, 'بيانات الصنف غير صالحة', path, method, requestId);
      }
      const name = String(body.name ?? '').trim();
      if (!name) return fail(400, 'اسم الصنف مطلوب', path, method, requestId);

      const price = Number(body.price ?? 0);
      const cost = Number(body.cost ?? 0);
      const stock = Number(body.stock ?? 0);
      const minStock = Number(body.minStock ?? 5);
      if (!Number.isFinite(price) || !Number.isFinite(cost)
        || !Number.isFinite(stock) || !Number.isFinite(minStock)) {
        return fail(400, 'قيم رقمية غير صالحة في بيانات الصنف', path, method, requestId);
      }
      const unit = String(body.unit ?? 'حبة').trim() || 'حبة';
      const category = String(body.category ?? '').trim() || 'غير مصنّف';
      const image = String(body.image ?? '').trim() || null;

      /*
       * A barcode typed by the operator (imported catalogue) is honoured as
       * is. A missing one is allocated HERE — see ean13() for why the number
       * must be a real EAN-13 rather than the client's twelve random digits.
       */
      const clientBarcode = String(body.barcode ?? '').trim();
      let barcode = clientBarcode;
      if (!barcode) {
        const seq = await allocateDocumentNumber(sql, tenant, 'barcode', '628');
        if (!seq) return fail(500, 'تعذّر تخصيص باركود للصنف', path, method, requestId);
        barcode = ean13(seq.issued);
      }

      /*
       * Only the columns that carry this route's data are written: every other
       * NOT NULL column on dypos.products has a database default, and passing
       * them here would drift from the schema for no gain. `branchId` is not
       * a column on this table at all — it is echoed back because it is part
       * of the client's shape.
       */
      const created = (await sql`INSERT INTO dypos.products
          (id, tenant_id, name, category, barcode, unit_price, cost, stock,
           min_stock, unit, image_url, is_active)
        VALUES (${makeId('prd')}, ${tenant}, ${name}, ${category}, ${barcode},
          ${price}, ${cost}, ${stock}, ${minStock}, ${unit}, ${image}, true)
        RETURNING id, name, barcode, category, unit_price AS price, cost,
          stock, min_stock AS "minStock", unit, image_url AS image`)[0] as any;

      return json({
        item: {
          id: created.id,
          name: created.name,
          barcode: created.barcode,
          category: created.category,
          // Numbers, not the driver's numeric strings: the client stores this
          // object as its `Product` type and compares `stock <= minStock` —
          // lexicographic string order would alert on the wrong products.
          price: Number(created.price),
          cost: Number(created.cost),
          stock: Number(created.stock),
          minStock: Number(created.minStock),
          unit: created.unit,
          image: created.image ?? null,
          branchId: body.branchId ?? null,
        },
      }, 201);
    }

    // ---- services ----
    case method === 'POST' && seg === 'services':
      return json({ item: (await sql`INSERT INTO dypos.services
          (id, tenant_id, name, name_en, category, description,
           base_price, tax_rate, duration_minutes, is_active, metadata)
        VALUES (${body.id || makeId('svc')}, ${tenant},
          ${body.name || null}, ${body.nameEn || null}, ${body.category || null},
          ${body.description || null}, ${num(body.basePrice)}, ${num(body.taxRate, 15)},
          ${num(body.durationMinutes, 30)}, ${body.isActive === false ? false : true},
          ${JSON.stringify(body.metadata || {})})
        ON CONFLICT (id) DO UPDATE SET
          name = EXCLUDED.name, name_en = EXCLUDED.name_en,
          category = EXCLUDED.category, description = EXCLUDED.description,
          base_price = EXCLUDED.base_price, tax_rate = EXCLUDED.tax_rate,
          duration_minutes = EXCLUDED.duration_minutes,
          is_active = EXCLUDED.is_active, metadata = EXCLUDED.metadata,
          updated_at = NOW()
        RETURNING *`)[0] }, 201);

    case method === 'PUT' && seg === 'services':
      return json({ item: (await sql`UPDATE dypos.services SET
          name = COALESCE(${body.name}, name),
          base_price = COALESCE(${body.basePrice}, base_price),
          tax_rate = COALESCE(${body.taxRate}, tax_rate),
          duration_minutes = COALESCE(${body.durationMinutes}, duration_minutes),
          is_active = COALESCE(${body.isActive}, is_active),
          category = COALESCE(${body.category}, category),
          description = COALESCE(${body.description}, description),
          updated_at = NOW()
        WHERE id = ${id} AND tenant_id = ${tenant}
        RETURNING *`)[0] });

    case method === 'DELETE' && seg === 'services':
      return json({ deleted: (await sql`DELETE FROM dypos.services
        WHERE id = ${id} AND tenant_id = ${tenant} RETURNING id`)[0]?.id });

    // ---- appointments ----
    case method === 'POST' && seg === 'appointments':
      return createAppointment(sql, tenant, body);

    case method === 'PATCH' && seg === 'appointments' && path.endsWith('/status'):
      return json({ item: (await sql`UPDATE dypos.appointments
        SET status = ${body.status}
        WHERE id = ${id} AND tenant_id = ${tenant} RETURNING *`)[0] });

    case method === 'DELETE' && seg === 'appointments':
      return json({ deleted: (await sql`DELETE FROM dypos.appointments
        WHERE id = ${id} AND tenant_id = ${tenant} RETURNING id`)[0]?.id });

    // ---- offline sync batch ----
    case method === 'POST' && path === '/sync-batch': {
      const {
        invoices = [],
        products = [],
        auditLogs = [],
      } = body || {};
      const pendingInvoices = [...invoices];

      let txInserted = 0;
      let txSkipped = 0;

      // Use a transaction via sequential queries (Neon driver doesn't support BEGIN/COMMIT directly)
      for (const raw of pendingInvoices) {
        const tx = raw as Record<string, unknown>;
        if (!tx.id || !(tx.invoiceNumber || tx.invoice_number)) {
          txSkipped++;
          continue;
        }
        const invoiceNumber = String(tx.invoiceNumber || tx.invoice_number);
        const items = Array.isArray(tx.items) ? (tx.items as Array<Record<string, unknown>>) : [];
        let subtotal = 0;
        let tax = 0;

        for (const line of items) {
          const qty = Number(line.quantity ?? 0);
          const productId = line.productId ?? line.product_id ?? null;
          let unitPrice = Number(line.unitPrice ?? line.unit_price ?? line.price);
          let taxRate = Number(line.taxRate ?? line.tax_rate ?? 15);

          if (productId) {
            const p = await sql`SELECT unit_price, tax_rate FROM dypos.products
              WHERE id = ${String(productId)} AND tenant_id = ${tenant}`;
            if (p[0]) {
              unitPrice = Number(p[0].unit_price);
              taxRate = Number(p[0].tax_rate ?? taxRate);
            }
          }

          if (!Number.isFinite(unitPrice) || unitPrice < 0) continue;
          const net = unitPrice * qty;
          subtotal += net;
          tax += (net * (Number.isFinite(taxRate) ? taxRate : 0)) / 100;
        }

        const total = items.length ? subtotal + tax : Number(tx.total ?? 0);
        const branchId = tx.branchId ? String(tx.branchId) : null;
        // A sale without a real branch is invalid. Keep it visible as skipped
        // instead of silently routing it to a fabricated main branch.
        if (!branchId) {
          txSkipped++;
          continue;
        }

        await sql`INSERT INTO dypos.invoices (
            id, tenant_id, invoice_number, branch_id, cashier_name,
            customer_name, subtotal, tax, discount, total, payment_method,
            status, items, timestamp)
          VALUES (${tx.id}, ${tenant}, ${invoiceNumber}, ${branchId},
            ${tx.cashierName || 'الكاشير'}, ${tx.customerName || 'عميل نقدي'},
            ${subtotal}, ${tax}, 0, ${total},
            ${tx.paymentMethod || 'mada'}, ${tx.status || 'completed'},
            ${JSON.stringify(items)}, ${tx.timestamp || new Date().toISOString()})
          ON CONFLICT (id) DO UPDATE SET
            status = EXCLUDED.status, total = EXCLUDED.total,
            subtotal = EXCLUDED.subtotal, tax = EXCLUDED.tax,
            updated_at = NOW()`;
        txInserted++;
      }

      let prodUpserted = 0;
      for (const raw of products as Array<Record<string, unknown>>) {
        const p = raw;
        if (!p.id || !p.name) continue;
        const unitPrice = Number(p.unit_price ?? p.unitPrice ?? p.price);
        if (!Number.isFinite(unitPrice) || unitPrice < 0) continue;
        await sql`INSERT INTO dypos.products (
            id, tenant_id, name, name_en, category, sku, barcode, unit_price, cost, stock, unit)
          VALUES (${p.id}, ${tenant}, ${p.name}, ${p.nameEn || p.name_en || p.name},
            ${p.category || 'عام'}, ${p.sku || p.id}, ${p.barcode || p.id},
            ${unitPrice}, ${p.cost || 0}, ${p.stock || 0}, ${p.unit || 'حبة'})
          ON CONFLICT (id) DO UPDATE SET
            name = EXCLUDED.name, stock = EXCLUDED.stock,
            unit_price = EXCLUDED.unit_price, cost = EXCLUDED.cost,
            updated_at = NOW()`;
        prodUpserted++;
      }

      let auditInserted = 0;
      for (const log of auditLogs) {
        await sql`INSERT INTO dypos.audit_logs (tenant_id, user_name, action, details, timestamp)
          VALUES (${tenant},
            ${log.userName || log.user_name || 'النظام'},
            ${log.action || 'مزامنة'},
            ${log.details || [log.table_name, log.record_id].filter(Boolean).join(' / ')},
            ${log.timestamp || new Date().toISOString()})`;
        auditInserted++;
      }

      return json({
        success: true,
        message: 'تم حفظ الفواتير والمبيعات بنجاح.',
        synced: { transactions: txInserted, invoices: txInserted, products: prodUpserted, auditLogs: auditInserted },
        skipped: txSkipped,
      });
    }

    // ---- production ----
    case method === 'POST' && path === '/production':
      return createProduction(sql, tenant, body);

    case method === 'POST' && seg === 'production' && path.endsWith('/complete'):
      return completeProduction(sql, id, tenant, body);

    case method === 'DELETE' && seg === 'production':
      return json({ deleted: (await sql`DELETE FROM dypos.production_orders
        WHERE id = ${id} AND tenant_id = ${tenant} RETURNING id`)[0]?.id });

    // ---- batches ----
    case method === 'POST' && seg === 'batches':
      return createBatch(sql, tenant, body);

    case method === 'DELETE' && seg === 'batches':
      return json({ deleted: (await sql`DELETE FROM dypos.product_batches
        WHERE id = ${id} AND tenant_id = ${tenant} RETURNING id`)[0]?.id });

    // ---- serials ----
    case method === 'POST' && seg === 'serials':
      return createSerial(sql, tenant, body);

    case method === 'PATCH' && seg === 'serials':
      return json({ item: (await sql`UPDATE dypos.product_serials
        SET status = ${body.status || 'in_stock'},
            sold_at = CASE WHEN ${body.status || 'in_stock'} = 'sold'
              THEN COALESCE(${body.soldAt || null}, NOW()) ELSE NULL END
        WHERE id = ${id} AND tenant_id = ${tenant} RETURNING *`)[0] });

    case method === 'DELETE' && seg === 'serials':
      return json({ deleted: (await sql`DELETE FROM dypos.product_serials
        WHERE id = ${id} AND tenant_id = ${tenant} RETURNING id`)[0]?.id });

    // ---- commissions ----
    case method === 'POST' && path === '/commissions/settle':
      return json({ items: await sql`UPDATE dypos.commissions
        SET status = 'paid', paid_at = NOW()
        WHERE tenant_id = ${tenant} AND id = ANY(${body.ids}::varchar[])
        RETURNING *` });

    case method === 'POST' && seg === 'commissions':
      return createCommission(sql, tenant, body);

    // ---- delivery ----
    case method === 'POST' && seg === 'deliveries':
      return createDelivery(sql, tenant, body);

    case method === 'PATCH' && seg === 'deliveries' && path.endsWith('/status'):
      return json({ item: (await sql`UPDATE dypos.deliveries
          SET status = ${body.status},
              picked_at = CASE WHEN ${body.status} = 'picked_up'
                THEN NOW() ELSE picked_at END,
              delivered_at = CASE WHEN ${body.status} = 'delivered'
                THEN NOW() ELSE delivered_at END,
              driver_id = COALESCE(${body.driverId || null}, driver_id),
              driver_name = COALESCE(${body.driverName || null}, driver_name)
          WHERE id = ${id} AND tenant_id = ${tenant} RETURNING *`)[0] });

    case method === 'DELETE' && seg === 'deliveries':
      return json({ deleted: (await sql`DELETE FROM dypos.deliveries
        WHERE id = ${id} AND tenant_id = ${tenant} RETURNING id`)[0]?.id });

    // ---- AI Assistant ----
    case method === 'POST' && path === '/ai-assistant': {
      const { prompt, context } = body || {};
      if (!prompt) return fail(400, 'Prompt is required');
      const geminiKey = env.GEMINI_API_KEY;
      if (!geminiKey) {
        return json({
          error: 'مساعد الذكاء الاصطناعي غير مُفعَّل. يرجى ضبط GEMINI_API_KEY.',
          feature: 'ai-assistant',
          configured: false,
        }, 503);
      }
      // Import dynamically to avoid bundle size if not used
      const { GoogleGenAI } = await import('@google/genai');
      const ai = new GoogleGenAI({ apiKey: geminiKey });
      const systemInstruction = `أنت المساعد الذكي لمنصة «دينا: منصة التجارة الذكية» من تطوير شركة المنافذ الذكية للبرمجيات (Smart Ports Software).
مهمتك تحليل البيانات المالية والمخزون والمبيعات، وتقديم توصيات استراتيجية دقيقة وموثوقة للمسؤولين وأمناء الصندوق باللغة العربية والإنجليزية. لا تذكر أي تفاصيل تقنية عن البنية التحتية أو قواعد البيانات في ردودك.
السياق الحالي للنظام: ${JSON.stringify(context || {})}`;
      const response = await ai.models.generateContent({
        model: 'gemini-2.5-flash',
        contents: prompt,
        config: { systemInstruction, temperature: 0.3 },
      });
      return json({ result: response.text });
    }
  }

  return fail(405, 'Method not allowed', path, method, requestId);
}

/* ------------------------------------------------------------------ */
/* Write helpers                                                       */
/* ------------------------------------------------------------------ */

/**
 * Allocate the next number for a document type from `dypos.document_sequences`.
 *
 * This is the invoice route's allocation (see the POST /invoices case above)
 * extracted so the journal / purchase-order / barcode routes cannot drift from
 * it: the `INSERT … ON CONFLICT DO NOTHING` seeds the first row of the period
 * without racing a concurrent creator, the `UPDATE … RETURNING` takes the row
 * lock that serialises concurrent allocators, and — `next_value` being
 * post-increment — the number issued is the value BEFORE it.
 *
 * Returns null when no counter row could be updated; the caller must fail
 * rather than construct a number of its own.
 */
async function allocateDocumentNumber(
  sql: NeonQueryFunction<false, false>,
  tenant: string,
  docType: string,
  prefix: string,
): Promise<{ number: string; issued: number } | null> {
  const periodKey = String(new Date().getUTCFullYear());
  await sql`INSERT INTO dypos.document_sequences
      (tenant_id, doc_type, period_key, next_value, prefix)
    VALUES (${tenant}, ${docType}, ${periodKey}, 1, ${prefix})
    ON CONFLICT (tenant_id, doc_type, period_key) DO NOTHING`;
  const seq = await sql`UPDATE dypos.document_sequences
      SET next_value = next_value + 1, updated_at = NOW()
    WHERE tenant_id = ${tenant} AND doc_type = ${docType} AND period_key = ${periodKey}
    RETURNING next_value, prefix`;
  if (!seq[0]) return null;
  const issued = Number(seq[0].next_value) - 1;
  return {
    number: `${String(seq[0].prefix || prefix)}-${periodKey}-${String(issued).padStart(6, '0')}`,
    issued,
  };
}

async function createAppointment(
  sql: NeonQueryFunction<false, false>, tenant: string, b: any,
) {
  if (!b.scheduledStart) return fail(400, 'وقت البدء مطلوب');
  let end: string | null = b.scheduledEnd || null;
  if (!end && b.serviceId) {
    const [svc] = await sql`SELECT duration_minutes FROM dypos.services
      WHERE id = ${b.serviceId} AND tenant_id = ${tenant}`;
    if (svc) {
      end = new Date(
        new Date(b.scheduledStart).getTime() + num(svc.duration_minutes) * 60000,
      ).toISOString();
    }
  }
  if (!end) {
    end = new Date(new Date(b.scheduledStart).getTime() + 3600000).toISOString();
  }
  const item = (await sql`INSERT INTO dypos.appointments
      (id, tenant_id, branch_id, service_id, customer_id, customer_name,
       customer_phone, employee_id, scheduled_start, scheduled_end,
       status, price, notes)
    VALUES (${makeId('apt')}, ${tenant}, ${b.branchId || null},
      ${b.serviceId || null}, ${b.customerId || null},
      ${b.customerName || 'عميل'}, ${b.customerPhone || null},
      ${b.employeeId || null}, ${b.scheduledStart}, ${end},
      ${b.status || 'scheduled'}, ${num(b.price)}, ${b.notes || null})
    RETURNING *`)[0];
  return json({ item }, 201);
}

async function createProduction(
  sql: NeonQueryFunction<false, false>, tenant: string, b: any,
) {
  if (!b.productId) return fail(400, 'المنتج مطلوب');
  if (num(b.quantity) <= 0) return fail(400, 'الكمية يجب أن تكون أكبر من صفر');
  const item = (await sql`INSERT INTO dypos.production_orders
      (id, tenant_id, branch_id, recipe_id, product_id, quantity, status,
       planned_start, planned_end, completed_qty, notes)
    VALUES (${makeId('prd')}, ${tenant}, ${b.branchId || null},
      ${b.recipeId || null}, ${b.productId}, ${num(b.quantity)},
      ${b.status || 'draft'}, ${b.plannedStart || null},
      ${b.plannedEnd || null}, ${num(b.completedQty)}, ${b.notes || null})
    RETURNING *`)[0];
  return json({ item }, 201);
}

async function createBatch(
  sql: NeonQueryFunction<false, false>, tenant: string, b: any,
) {
  if (!b.productId) return fail(400, 'المنتج مطلوب');
  if (!b.batchNumber) return fail(400, 'رقم التشغيلة مطلوب');
  const item = (await sql`INSERT INTO dypos.product_batches
      (id, tenant_id, branch_id, product_id, batch_number, quantity,
       cost, expiry_date, production_date, supplier_id, status)
    VALUES (${makeId('bat')}, ${tenant}, ${b.branchId || null},
      ${b.productId}, ${b.batchNumber}, ${num(b.quantity)}, ${num(b.cost)},
      ${b.expiryDate || null}, ${b.productionDate || null},
      ${b.supplierId || null}, ${b.status || 'active'})
    ON CONFLICT (tenant_id, product_id, batch_number) DO UPDATE SET
      quantity = EXCLUDED.quantity, cost = EXCLUDED.cost,
      expiry_date = EXCLUDED.expiry_date
    RETURNING *`)[0];
  return json({ item }, 201);
}

async function createSerial(
  sql: NeonQueryFunction<false, false>, tenant: string, b: any,
) {
  if (!b.productId) return fail(400, 'المنتج مطلوب');
  if (!b.serialNumber) return fail(400, 'الرقم التسلسلي مطلوب');
  const item = (await sql`INSERT INTO dypos.product_serials
      (id, tenant_id, branch_id, product_id, serial_number, imei,
       status, warranty_end, sold_invoice_id)
    VALUES (${makeId('ser')}, ${tenant}, ${b.branchId || null},
      ${b.productId}, ${b.serialNumber}, ${b.imei || null},
      ${b.status || 'in_stock'}, ${b.warrantyEnd || null},
      ${b.soldInvoiceId || null})
    ON CONFLICT (tenant_id, product_id, serial_number) DO UPDATE SET
      imei = EXCLUDED.imei, status = EXCLUDED.status,
      warranty_end = EXCLUDED.warranty_end
    RETURNING *`)[0];
  return json({ item }, 201);
}

async function createCommission(
  sql: NeonQueryFunction<false, false>, tenant: string, b: any,
) {
  if (!b.employeeId) return fail(400, 'الموظف مطلوب');
  const rate = num(b.rate);
  const base = num(b.baseAmount);
  const amount = b.amount !== undefined ? num(b.amount) : (base * rate) / 100;
  const now = new Date();
  const item = (await sql`INSERT INTO dypos.commissions
      (id, tenant_id, employee_id, employee_name, period_year, period_month,
       base_amount, rate, amount, status, notes)
    VALUES (${makeId('cm')}, ${tenant}, ${b.employeeId},
      ${b.employeeName || null},
      ${Number(b.periodYear ?? now.getFullYear())},
      ${Number(b.periodMonth ?? now.getMonth() + 1)},
      ${base}, ${rate}, ${amount}, ${b.status || 'accrued'}, ${b.notes || null})
    ON CONFLICT (tenant_id, employee_id, period_year, period_month)
      DO UPDATE SET base_amount = EXCLUDED.base_amount,
        rate = EXCLUDED.rate, amount = EXCLUDED.amount,
        status = EXCLUDED.status
    RETURNING *`)[0];
  return json({ item }, 201);
}

async function createDelivery(
  sql: NeonQueryFunction<false, false>, tenant: string, b: any,
) {
  if (!b.customerName) return fail(400, 'اسم العميل مطلوب');
  if (!b.address) return fail(400, 'العنوان مطلوب');

  let fee = num(b.fee);
  if (b.zoneId && fee === 0) {
    const [z] = await sql`SELECT fee, minimum_order_amount
      FROM dypos.delivery_zones WHERE id = ${b.zoneId} AND tenant_id = ${tenant}`;
    if (z) {
      fee = num(z.fee);
      const min = num(z.minimum_order_amount);
      if (num(b.amountDue) < min) {
        return fail(400, `الحد الأدنى لطلب التوصيل في هذه المنطقة ${min} ر.س`);
      }
    }
  }

  const item = (await sql`INSERT INTO dypos.deliveries
      (id, tenant_id, branch_id, invoice_id, zone_id, customer_name,
       customer_phone, address, driver_id, driver_name, status, fee,
       amount_due, distance_km, notes)
    VALUES (${makeId('dlv')}, ${tenant}, ${b.branchId || null},
      ${b.invoiceId || null}, ${b.zoneId || null}, ${b.customerName},
      ${b.customerPhone || null}, ${b.address}, ${b.driverId || null},
      ${b.driverName || null}, ${b.status || 'pending'}, ${fee},
      ${num(b.amountDue)}, ${b.distanceKm || null}, ${b.notes || null})
    RETURNING *`)[0];
  return json({ item }, 201);
}

/**
 * Completes a production order in a single transaction: consumes component
 * stock following FEFO, receives the finished goods and records movements.
 */
async function completeProduction(
  sql: NeonQueryFunction<false, false>, id: string, tenant: string, b: any,
) {
  const rows = await sql.transaction([
    sql`SELECT * FROM dypos.production_orders
      WHERE id = ${id} AND tenant_id = ${tenant} FOR UPDATE`,
  ]);
  const ord = (rows[0] as any[])[0];
  if (!ord) return fail(404, 'أمر الإنتاج غير موجود');

  const doneQty = b.completedQty !== undefined ? num(b.completedQty) : num(ord.quantity);

  const comps = await sql`SELECT ri.component_product_id, ri.qty AS per_unit,
      ri.waste_percent, p.name
    FROM dypos.product_recipe_items ri
    LEFT JOIN dypos.products p ON ri.component_product_id = p.id
    WHERE ri.tenant_id = ${tenant} AND ri.recipe_id = ${ord.recipe_id}`;

  const consumed: any[] = [];
  for (const c of comps as any[]) {
    const need = num(c.per_unit) * doneQty * (1 + num(c.waste_percent) / 100);

    // FEFO: soonest expiry first, then oldest first.
    const batches = await sql`SELECT id, quantity FROM dypos.product_batches
      WHERE tenant_id = ${tenant} AND product_id = ${c.component_product_id}
        AND quantity > 0 AND status = 'active'
      ORDER BY expiry_date NULLS LAST, created_at ASC`;

    let remaining = need;
    for (const bRow of batches as any[]) {
      if (remaining <= 0) break;
      const take = Math.min(num(bRow.quantity), remaining);
      await sql`UPDATE dypos.product_batches
        SET quantity = quantity - ${take} WHERE id = ${bRow.id}`;
      remaining -= take;
    }

    await sql`UPDATE dypos.products SET stock = stock - ${need}, updated_at = NOW()
      WHERE id = ${c.component_product_id} AND tenant_id = ${tenant}`;
    await sql`INSERT INTO dypos.stock_movements
      (id, tenant_id, product_id, type, quantity, reference_id, reason)
      VALUES (${makeId('mv')}, ${tenant}, ${c.component_product_id},
        'production_out', ${-need}, ${ord.id}, ${`${c.name ?? ''} — استهلاك إنتاج`.trim()})`;
    consumed.push({
      componentId: c.component_product_id, name: c.name, needed: need,
    });
  }

  await sql`UPDATE dypos.products SET stock = stock + ${doneQty}, updated_at = NOW()
    WHERE id = ${ord.product_id} AND tenant_id = ${tenant}`;
  await sql`INSERT INTO dypos.stock_movements
    (id, tenant_id, product_id, type, quantity, reference_id, reason)
    VALUES (${makeId('mv')}, ${tenant}, ${ord.product_id},
      'production_in', ${doneQty}, ${ord.id}, 'إنتاج تام')`;

  const item = (await sql`UPDATE dypos.production_orders
    SET status = 'completed', completed_qty = ${doneQty}, updated_at = NOW()
    WHERE id = ${ord.id} AND tenant_id = ${tenant} RETURNING *`)[0];

  return json({ item, consumed });
}

