/**
 * DyPOS Enterprise — Cloudflare Worker API.
 *
 * Runs on the Cloudflare edge and talks to Neon over the serverless HTTP
 * driver (no TCP, no connection pool). Serves the same /api/db/* contract
 * that the Express server exposes locally, so the React client is unchanged.
 */
import { neon, type NeonQueryFunction } from '@neondatabase/serverless';

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
      salt: hexToBytes(saltHex) as unknown as BufferSource,
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

  const iterations = Number(stored.iterations) || 210_000;
  const derived = await deriveKey(password, stored.salt, iterations);
  return timingSafeEqualHex(bytesToHex(derived), stored.hash);
}

export async function hashPasswordEdge(
  password: string, saltHex: string, iterations = 210_000,
): Promise<string> {
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

const json = (data: unknown, status = 200) =>
  new Response(JSON.stringify(data), {
    status,
    headers: {
      'content-type': 'application/json; charset=utf-8',
      'cache-control': 'no-store',
      'x-content-type-options': 'nosniff',
    },
  });

const fail = (status: number, error: string) => json({ error }, status);

const num = (v: unknown, d = 0) => {
  const n = Number(v);
  return Number.isFinite(n) ? n : d;
};

const makeId = (prefix: string) =>
  `${prefix}-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`;

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

const tenantOf = (req: Request, url: URL, body?: any) =>
  req.headers.get('x-tenant-id') ||
  url.searchParams.get('tenantId') ||
  body?.tenantId ||
  env_default ||
  'royal-global-hq';

let env_default: string | undefined;

export default {
  async fetch(request: Request, env: Env): Promise<Response> {
    const url = new URL(request.url);

    // Everything that is not the edge API is served from the static bundle,
    // which keeps the SPA and the API on one origin (no CORS, no second host).
    if (!url.pathname.startsWith('/api/')) {
      return env.ASSETS.fetch(request);
    }

    env_default = env.DEFAULT_TENANT;

    // Clients call both /api/db/<thing> and /api/<thing>; normalise to one shape.
    //
    // The leading slash MUST be preserved. The previous form stripped the
    // prefix and left a bare segment ("branches"), while every comparison in the
    // route table below is written against "/branches". Nothing matched, so even
    // /api/auth/login and /api/db/branches — which are public by design — fell
    // through to the token check and returned 401.
    const stripped = url.pathname.replace(/^\/api\/(?:db\/)?/, '');
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
        || path === '/auth/password-policy') {
        return await authRoute(method, path, env, body, request);
      }
      if (path === '/release' && method === 'GET') {
        return await releaseStamp(env);
      }

      // The sign-in form needs the branch list before anyone has a token.
      // Names and cities only — no financial or personal data.
      if (path === '/branches' && method === 'GET') {
        const tenant = env.DEFAULT_TENANT || 'royal-global-hq';
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

      // --- Everything below this line is business data ----------------------
      // No valid signed token, no data. The acting user is derived from the
      // token alone; a name in a header or query string is ignored entirely.
      const principal = await requirePrincipal(request, env);
      if (!principal) return fail(401, GENERIC_AUTH_ERROR);

      // A pending forced rotation blocks data access, not just the UI: a
      // tampered client must not be able to skip the screen.
      if (principal.mustChangePassword) {
        return fail(403, 'يجب تغيير كلمة المرور قبل استخدام النظام');
      }

      return await route(method, path, url, request, env, body, principal);
    } catch (err: any) {
      console.error('[dypos-worker]', method, path, err);
      return fail(500, err?.message || 'Internal error');
    }
  },
};

/** The signed-in identity, or null when the request carries no valid token. */
interface Principal {
  username: string;
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

  return { username, tenantId, mustChangePassword: Boolean(user.must_change_password) };
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
  method: string, path: string, env: Env, body: any, req: Request,
): Promise<Response> {
  const tenant = env.DEFAULT_TENANT || 'royal-global-hq';

  // Safe to expose: it reveals nothing about the stored credential.
  if (path === '/auth/password-policy' && method === 'POST') {
    return json(checkPasswordStrength(String(body?.password || ''), body?.username));
  }

  if (path === '/auth/login' && method === 'POST') {
    const username = String(body?.username || '').trim().toLowerCase();
    const password = String(body?.password || '');
    if (!username || !password) return fail(400, 'اسم المستخدم وكلمة المرور مطلوبان');

    // One message and one status for every failure mode, so an unknown user is
    // indistinguishable from a wrong password.
    const deny = async (reason: string) => {
      await audit(env, tenant, username, 'login_failed', req, reason);
      return fail(401, GENERIC_AUTH_ERROR);
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

    const ok = await verifyPassword(password, {
      hash: user.password_salt ? user.password_hash : null,
      salt: user.password_salt,
      iterations: user.password_iterations,
      legacyDigest: user.password_salt ? null : user.password_hash,
    });
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

    return json({ session: await buildSession(env, tenant, user, body?.branchId) });
  }

  return authPasswordChange(env, tenant, req, body);
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
  env: Env, tenant: string, req: Request, body: any,
): Promise<Response> {
  if (req.method.toUpperCase() !== 'POST') return fail(404, 'المسار غير موجود');

  const bearer = /^Bearer\s+(.+)$/i.exec(req.headers.get('authorization') || '')?.[1];
  const verified = await verifySessionToken(env, (bearer || '').trim());
  if (!verified.ok) return fail(401, GENERIC_AUTH_ERROR);

  const { username } = verified.payload;
  const current = String(body?.currentPassword || '');
  const next = String(body?.newPassword || '');
  const confirm = String(body?.confirmPassword || '');

  if (next !== confirm) return fail(400, 'كلمتا المرور غير متطابقتين');

  const rows = await getSql(env)`
    SELECT id, password_hash, password_salt, password_iterations
    FROM dypos.users
    WHERE tenant_id = ${tenant} AND username = ${username} AND is_active = TRUE`;
  const user = rows[0];
  if (!user) return fail(401, GENERIC_AUTH_ERROR);

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
    return fail(401, 'كلمة المرور الحالية غير صحيحة');
  }

  const policy = checkPasswordStrength(next, username);
  if (!policy.ok) return json({ error: policy.problems[0], problems: policy.problems }, 422);

  const salt = randomHex(16);
  const iterations = 210_000;
  const hash = await hashPasswordEdge(next, salt, iterations);

  await getSql(env)`UPDATE dypos.users
    SET password_hash = ${hash}, password_salt = ${salt},
        password_iterations = ${iterations}, password_algo = 'pbkdf2-sha512',
        password_updated_at = NOW(), must_change_password = FALSE,
        failed_attempts = 0, locked_until = NULL
    WHERE id = ${user.id}`;

  await audit(env, tenant, username, 'password_changed', req);
  return json({ ok: true, mustChangePassword: false });
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
  env: Env, body: any, principal: Principal,
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

  if (method === 'GET') {
    switch (true) {
      case path === '/health':
        return health(sql);

      case path === '/products':
        return json({ products: await sql`SELECT *, unit_price AS price
          FROM dypos.products WHERE tenant_id = ${tenant} ORDER BY name ASC` });

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

      default:
        return fail(404, `Unknown endpoint: ${path}`);
    }
  }

  // ---------------- write endpoints ----------------
  if (!body) return fail(400, 'Request body is required');
  const seg = path.split('/')[1] || '';
  const id = path.split('/')[2] || '';

  switch (true) {
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
  }

  return fail(405, 'Method not allowed');
}

/* ------------------------------------------------------------------ */
/* Write helpers                                                       */
/* ------------------------------------------------------------------ */

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
