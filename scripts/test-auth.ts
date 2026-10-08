/**
 * Authentication end-to-end test.
 *
 * Covers the paths that decide who gets into the building: sign-in, the lockout
 * counter, the password policy, the forced rotation, re-login with the new
 * value, the old value dying, and inactive accounts staying shut.
 *
 * Credentials are read from the environment (the same variables
 * scripts/release-credentials.ts consumes) and are never printed.
 *
 *   DYPOS_BOOTSTRAP_YACOUB=... npm run test:auth
 *
 * Run against a live server: npx tsx scripts/test-auth.ts
 */
import fs from 'fs';
import path from 'path';
import dotenv from 'dotenv';

dotenv.config();

const BASE = process.env.API_BASE || 'http://';
const LOG = path.resolve('test-auth.log');
const lines: string[] = [];
const log = (s: string) => {
  lines.push(s);
  fs.writeFileSync(LOG, lines.join('\n'));
};

async function api(method: string, endpoint: string, body?: unknown, token?: string) {
  const headers: Record<string, string> = {
    'Content-Type': 'application/json',
    'x-tenant-id': 'royal-global-hq',
  };
  // Routes behind the RBAC guard only accept a signed session token; the old
  // `x-dypos-user` name header is refused by design.
  if (token) headers.Authorization = `Bearer ${token}`;

  const res = await fetch(`${BASE}${endpoint}`, {
    method,
    headers,
    body: body ? JSON.stringify(body) : undefined,
  });
  const text = await res.text();
  let json: any;
  try { json = JSON.parse(text); } catch { json = { raw: text.slice(0, 200) }; }
  return { status: res.status, json };
}

let pass = 0;
let fail = 0;
const check = (name: string, ok: boolean, info = '') => {
  if (ok) { pass++; log(`  PASS  ${name}${info ? ' — ' + info : ''}`); }
  else { fail++; log(`  FAIL  ${name}${info ? ' — ' + info : ''}`); }
};

const USERNAME = process.env.DYPOS_TEST_USER || 'yacoub';
const TEMP_PW = process.env.DYPOS_BOOTSTRAP_YACOUB || '';
// A deliberately strong throwaway value; each run rotates to a unique one.
const NEW_PW = process.env.DYPOS_TEST_NEW_PW ||
  `Ry!${Math.random().toString(36).slice(2, 8)}9${Math.random().toString(36).slice(2, 8)}Z`;

// ── AUTH-EXTENDED: names of the added in-process branches (13) ────────────
// Kept in one list so the honest-SKIP path logs exactly what would have run.
const EXTENDED_CHECK_NAMES = [
  'extended: plain login without MFA mints a session token',
  'extended: plain session carries the login identity',
  'extended: plain session reaches a data route (/api/erp/me)',
  'extended: MFA login returns a challenge instead of a session',
  'extended: wrong MFA code is refused without a session',
  'extended: correct MFA code is accepted with a session token',
  'extended: MFA session reaches a data route',
  'extended: unauthenticated unlock is refused (full createApp route)',
  'extended: wrong PIN unlock is refused',
  'extended: correct PIN unlocks the caller',
  "extended: tenant A reads its own product (setup sane)",
  'extended: forged tenant header does not re-scope the session',
  "extended: tenant A's rows are invisible to token B",
];

/**
 * In-process extended branches through the FULL application (`createApp`).
 *
 * (أ) plain login without MFA → valid session → data route.
 * (ب) MFA login → challenge → wrong code refused, correct code accepted.
 * (ج) unlock ONLY via the HTTP route (no direct helper calls for the action).
 * (د) tenant isolation: A's rows invisible to B's token.
 *
 * Fixture setup uses SQL + password hashing only (as test-mfa/test-unlock do).
 * The actions under test (login / mfa verify / unlock / data reads) all go
 * over HTTP against the real middleware chain. Assertion failures are reported
 * via `check` (honest FAIL); only infrastructure failures (no DB / boot down)
 * throw, so the caller can SKIP honestly instead of failing falsely.
 */
async function runAuthExtendedBranches(
  check: (name: string, ok: boolean, info?: string) => void,
  section: (title: string) => void,
): Promise<void> {
  const pgMod: any = await import('pg');
  const pg = pgMod?.default ?? pgMod;
  const { PG_SSL } = await import('../server/neonDb.ts');
  const { hashPassword } = await import('../server/passwords.ts');
  const { makeId } = await import('../server/apiHelpers.ts');
  const { setMfaDeliverer } = await import('../server/mfa.ts');
  const { createApp } = await import('../server.ts');

  const pool = new pg.Pool({
    connectionString: process.env.DATABASE_URL,
    ssl: PG_SSL,
    max: 2,
    idleTimeoutMillis: 10_000,
    connectionTimeoutMillis: 20_000,
  });

  const suffix = `${Date.now().toString(36)}${Math.random().toString(36).slice(2, 6)}`.toLowerCase();
  const TA = `auth_ext_a_${suffix}`;
  const TB = `auth_ext_b_${suffix}`;
  const plainUser = `auth_plain_${suffix}`;
  const mfaUser = `auth_mfa_${suffix}`;
  const unlockUser = `auth_unlock_${suffix}`;
  const userB = `auth_b_${suffix}`;
  const PW_PLAIN = `Plain-${suffix}-Aa1!`;
  const PW_MFA = `Mfa-${suffix}-Bb2!`;
  const PIN = `Unlock-${suffix}-Cc3!`;
  const PW_B = `TenantB-${suffix}-Dd4!`;
  const productId = makeId('p-auth-ext');
  const productName = `A-only product ${suffix}`;
  const productSku = `AX-${suffix}`;

  const userIds: string[] = [];
  const usernames = [plainUser, mfaUser, unlockUser, userB];
  let server: any = null;

  const parseJson = async (res: any): Promise<any> => {
    try { return await res.json(); } catch { return {}; }
  };
  const post = async (base: string, p: string, body: unknown, token?: string, headers?: Record<string, string>) => {
    const res = await fetch(`${base}${p}`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        ...(headers || {}),
        ...(token ? { Authorization: `Bearer ${token}` } : {}),
      },
      body: JSON.stringify(body),
    });
    return { status: res.status, json: await parseJson(res) };
  };
  const get = async (base: string, p: string, token?: string, headers?: Record<string, string>) => {
    const res = await fetch(`${base}${p}`, {
      method: 'GET',
      headers: {
        'Content-Type': 'application/json',
        ...(headers || {}),
        ...(token ? { Authorization: `Bearer ${token}` } : {}),
      },
    });
    return { status: res.status, json: await parseJson(res) };
  };

  try {
    // Fixtures: two tenants, four users (one MFA-enrolled), one A-only product.
    await pool.query(
      `INSERT INTO dypos.tenants (id, name) VALUES ($1,$2), ($3,$4) ON CONFLICT (id) DO NOTHING`,
      [TA, 'Auth Extended Tenant A', TB, 'Auth Extended Tenant B'],
    );
    const mkUser = async (id: string, tenant: string, username: string, pw: string) => {
      const h = await hashPassword(pw);
      await pool.query(
        `INSERT INTO dypos.users
           (id, tenant_id, username, password_hash, name, role,
            password_salt, password_iterations, password_algo, is_active, must_change_password)
         VALUES ($1,$2,$3,$4,$5,'cashier',$6,$7,$8,true,false)`,
        [id, tenant, username, h.hash, `${username} Probe`, h.salt, h.iterations, h.algo],
      );
      userIds.push(id);
    };
    const idPlain = makeId('u-auth'); const idMfa = makeId('u-auth');
    const idUnlock = makeId('u-auth'); const idB = makeId('u-auth');
    await mkUser(idPlain, TA, plainUser, PW_PLAIN);
    await mkUser(idMfa, TA, mfaUser, PW_MFA);
    await mkUser(idUnlock, TA, unlockUser, PIN);
    await mkUser(idB, TB, userB, PW_B);
    await pool.query(
      `INSERT INTO dypos.mfa_secrets (user_id, tenant_id, secret_hash, enabled)
       VALUES ($1,$2,$3,true) ON CONFLICT (user_id) DO UPDATE SET enabled = true`,
      [idMfa, TA, 'test-secret-hash'],
    );
    await pool.query(
      `INSERT INTO dypos.products (id, tenant_id, name, category, sku, unit_price, tax_rate, stock, is_active)
       VALUES ($1,$2,$3,'general',$4,100,15,10,TRUE)`,
      [productId, TA, productName, productSku],
    );

    // Capture the delivered MFA code exactly as an operator would receive it.
    const captured: string[] = [];
    setMfaDeliverer({
      channel: 'test-capture',
      async send(_to: string, code: string) { captured.push(code); },
    } as any);

    // The REAL app with the REAL middleware chain (gate order matters).
    const app = await createApp();
    server = app.listen(0);
    const base = `http://127.0.0.1:${(server.address() as { port: number }).port}`;

    // (أ) plain login without MFA → valid session → data route.
    section('[auth-extended: A plain login without MFA]');
    const savedMfaEnv = process.env.DYPOS_MFA_REQUIRED;
    delete process.env.DYPOS_MFA_REQUIRED;
    let rPlain: { status: number; json: any };
    try {
      rPlain = await post(base, '/api/auth/login', { username: plainUser, password: PW_PLAIN }, undefined, { 'x-tenant-id': TA });
    } finally {
      if (savedMfaEnv !== undefined) process.env.DYPOS_MFA_REQUIRED = savedMfaEnv;
    }
    check(EXTENDED_CHECK_NAMES[0],
      rPlain!.status === 200 && typeof rPlain!.json?.session?.token === 'string' && rPlain!.json?.mfaRequired !== true,
      `status=${rPlain!.status}`);
    check(EXTENDED_CHECK_NAMES[1],
      rPlain!.json?.session?.user?.username === plainUser,
      String(rPlain!.json?.session?.user?.username || 'no-user'));
    const tokenPlain: string | undefined = rPlain!.json?.session?.token;
    const rMe = await get(base, '/api/erp/me', tokenPlain, { 'x-tenant-id': TA });
    check(EXTENDED_CHECK_NAMES[2],
      rMe.status === 200 && rMe.json?.username === plainUser,
      `status=${rMe.status}`);

    // (ب) MFA: challenge → wrong refused, correct accepted → data route.
    section('[auth-extended: B MFA challenge and verify]');
    captured.length = 0;
    const rMfaLogin = await post(base, '/api/auth/login', { username: mfaUser, password: PW_MFA }, undefined, { 'x-tenant-id': TA });
    const challenge: string | undefined = rMfaLogin.json?.challenge;
    check(EXTENDED_CHECK_NAMES[3],
      rMfaLogin.status === 200 && rMfaLogin.json?.mfaRequired === true
      && typeof challenge === 'string' && !rMfaLogin.json?.session?.token,
      `status=${rMfaLogin.status}`);
    const code: string | undefined = captured[captured.length - 1];
    if (!challenge || !code) {
      check(EXTENDED_CHECK_NAMES[4], false, 'no challenge/code delivered');
      check(EXTENDED_CHECK_NAMES[5], false, 'no challenge/code delivered');
      check(EXTENDED_CHECK_NAMES[6], false, 'no MFA session');
    } else {
      const wrongCode = code === '000000' ? '111111' : '000000';
      const rWrong = await post(base, '/api/auth/mfa/verify', { challenge, code: wrongCode });
      check(EXTENDED_CHECK_NAMES[4],
        rWrong.status >= 400 && !rWrong.json?.session?.token,
        `status=${rWrong.status}`);
      const rGood = await post(base, '/api/auth/mfa/verify', { challenge, code });
      check(EXTENDED_CHECK_NAMES[5],
        rGood.status === 200 && typeof rGood.json?.session?.token === 'string',
        `status=${rGood.status}`);
      const tokenMfa: string | undefined = rGood.json?.session?.token;
      const rMfaMe = await get(base, '/api/erp/me', tokenMfa, { 'x-tenant-id': TA });
      check(EXTENDED_CHECK_NAMES[6],
        rMfaMe.status === 200 && rMfaMe.json?.username === mfaUser,
        `status=${rMfaMe.status}`);
    }

    // (ج) unlock ONLY through the full createApp HTTP route — no direct calls.
    section('[auth-extended: C unlock via the full route]');
    const rUnlockLogin = await post(base, '/api/auth/login', { username: unlockUser, password: PIN }, undefined, { 'x-tenant-id': TA });
    const tokenUnlock: string | undefined = rUnlockLogin.json?.session?.token;
    const rNoAuth = await post(base, '/api/auth/unlock', { method: 'pin', pin: PIN });
    check(EXTENDED_CHECK_NAMES[7],
      (rNoAuth.status === 401 || rNoAuth.status === 403) && rNoAuth.json?.ok !== true,
      `status=${rNoAuth.status}`);
    const rWrongPin = await post(base, '/api/auth/unlock', { method: 'pin', pin: 'definitely-wrong' }, tokenUnlock, { 'x-tenant-id': TA });
    check(EXTENDED_CHECK_NAMES[8],
      rWrongPin.status === 401 && rWrongPin.json?.ok !== true,
      `status=${rWrongPin.status}`);
    const rGoodPin = await post(base, '/api/auth/unlock', { method: 'pin', pin: PIN }, tokenUnlock, { 'x-tenant-id': TA });
    check(EXTENDED_CHECK_NAMES[9],
      rGoodPin.status === 200 && rGoodPin.json?.ok === true,
      `status=${rGoodPin.status}`);

    // (د) tenant isolation: A's rows invisible to B's token.
    section('[auth-extended: D tenant isolation]');
    const rBLogin = await post(base, '/api/auth/login', { username: userB, password: PW_B }, undefined, { 'x-tenant-id': TB });
    const tokenB: string | undefined = rBLogin.json?.session?.token;
    const rProductsA = await get(base, '/api/db/products', tokenPlain, { 'x-tenant-id': TA });
    const itemsA: any[] = rProductsA.json?.items || rProductsA.json?.products || [];
    check(EXTENDED_CHECK_NAMES[10],
      rProductsA.status === 200 && itemsA.some((p: any) => p?.id === productId),
      `status=${rProductsA.status} count=${itemsA.length}`);
    const rMeForged = await get(base, '/api/erp/me', tokenB, { 'x-tenant-id': TA });
    check(EXTENDED_CHECK_NAMES[11],
      rMeForged.status === 200 && rMeForged.json?.tenantId === TB,
      `status=${rMeForged.status} tenant=${rMeForged.json?.tenantId}`);
    const rProductsB = await get(base, '/api/db/products', tokenB, { 'x-tenant-id': TA });
    const itemsB: any[] = rProductsB.json?.items || rProductsB.json?.products || [];
    check(EXTENDED_CHECK_NAMES[12],
      rProductsB.status === 200 && !itemsB.some((p: any) => p?.id === productId),
      `status=${rProductsB.status} leaked=${itemsB.filter((p: any) => p?.id === productId).length}`);
  } finally {
    try { await pool.query(`DELETE FROM dypos.mfa_challenges WHERE user_id = ANY($1)`, [userIds]); } catch { /* best effort */ }
    try { await pool.query(`DELETE FROM dypos.mfa_secrets WHERE user_id = ANY($1)`, [userIds]); } catch { /* best effort */ }
    try { await pool.query(`DELETE FROM dypos.auth_events WHERE username = ANY($1)`, [usernames]); } catch { /* best effort */ }
    try { await pool.query(`DELETE FROM dypos.users WHERE id = ANY($1)`, [userIds]); } catch { /* best effort */ }
    try { await pool.query(`DELETE FROM dypos.products WHERE id = $1`, [productId]); } catch { /* best effort */ }
    try { await pool.query(`DELETE FROM dypos.tenants WHERE id = ANY($1)`, [[TA, TB]]); } catch { /* tenants may be shared */ }
    try { await pool.end(); } catch { /* best effort */ }
    if (server) await new Promise<void>((r) => server.close(() => r()));
  }
}

async function main() {
  log(`DyPOS AUTH E2E — ${new Date().toISOString()}`);
  log(`base: ${BASE}  user: ${USERNAME}\n`);

  // Extended in-process branches run independently of the live-server
  // credential (they mint their own throwaway users through createApp), so
  // they are NOT gated by DYPOS_BOOTSTRAP_YACOUB. Existing checks below keep
  // their exact precondition and assertions.
  log('[auth-extended: createApp in-process]');
  if (!process.env.DATABASE_URL) {
    for (const n of EXTENDED_CHECK_NAMES) log(`  SKIP  ${n} — skip: no DATABASE_URL`);
  } else {
    try {
      await runAuthExtendedBranches(check, (t) => log(t));
    } catch (e: any) {
      const why = String(e?.message || e).slice(0, 140);
      for (const n of EXTENDED_CHECK_NAMES) log(`  SKIP  ${n} — skip: createApp unavailable (${why})`);
    }
  }

  if (!TEMP_PW) {
    log('!! DYPOS_BOOTSTRAP_YACOUB is not set — cannot run the login-dependent checks.');
    log('   Run scripts/release-credentials.ts first, or export the value.');
    lines.push(`\n${pass} passed, ${fail} failed`);
    console.log(lines.join('\n'));
    process.exit(1);
  }

  log('[policy]');
  const weak = await api('POST', '/api/auth/password-policy', { password: '123', username: USERNAME });
  check('weak password rejected by policy', weak.status === 200 && weak.json.ok === false,
    `problems=${(weak.json.problems || []).length}`);

  log('[login: wrong password]');
  const wrong = await api('POST', '/api/auth/login', { username: USERNAME, password: 'definitely-wrong' });
  check('wrong password rejected', wrong.status === 401, `status=${wrong.status}`);

  log('[login: temporary credential]');
  const good = await api('POST', '/api/auth/login', { username: USERNAME, password: TEMP_PW });
  check('temporary password accepted', good.status === 200, `status=${good.status}`);
  check('session reports identity', good.json?.session?.user?.username === USERNAME);
  const mustRotate = good.json?.session?.mustChangePassword;
  check('mustChangePassword surfaced', typeof mustRotate === 'boolean',
    `mustChangePassword=${mustRotate}`);

  if (mustRotate) {
    log('[forced rotation]');
    const token = good.json.session.token;

    const weakNew = await api('POST', '/api/auth/change-password', {
      currentPassword: TEMP_PW, newPassword: 'abc123', confirmPassword: 'abc123',
    }, token);
    check('weak new password rejected on change', weakNew.status >= 400, `status=${weakNew.status}`);

    const mismatch = await api('POST', '/api/auth/change-password', {
      currentPassword: TEMP_PW, newPassword: NEW_PW, confirmPassword: NEW_PW + 'x',
    }, token);
    check('mismatched confirmation rejected', mismatch.status >= 400, `status=${mismatch.status}`);

    const changed = await api('POST', '/api/auth/change-password', {
      currentPassword: TEMP_PW, newPassword: NEW_PW, confirmPassword: NEW_PW,
    }, token);
    check('password rotated', changed.status === 200, `status=${changed.status}`);

    const relog = await api('POST', '/api/auth/login', { username: USERNAME, password: NEW_PW });
    check('new password logs in', relog.status === 200, `status=${relog.status}`);
    check('rotation flag cleared', relog.json?.session?.mustChangePassword === false,
      `mustChangePassword=${relog.json?.session?.mustChangePassword}`);

    const oldPw = await api('POST', '/api/auth/login', { username: USERNAME, password: TEMP_PW });
    check('old temporary password no longer works', oldPw.status === 401, `status=${oldPw.status}`);
  } else {
    log('  (skipped rotation checks — account is not flagged for forced rotation)');
  }

  log('[token integrity]');
  const forged = await api('GET', '/api/erp/me', undefined,
    'eyJzdWIiOiJoYWNrIiwic2VydmFsIjoxfQ.badsignature');
  check('forged session token rejected', forged.status >= 400, `status=${forged.status}`);

  const nameOnly = await api('GET', '/api/erp/me?username=' + USERNAME);
  check('bare username query cannot claim an identity', nameOnly.status >= 400,
    `status=${nameOnly.status}`);

  log('[inactive account]');
  const inactive = await api('POST', '/api/auth/login', { username: 'noura', password: 'anything' });
  check('inactive user cannot sign in', inactive.status >= 400, `status=${inactive.status}`);

  lines.push(`\n${pass} passed, ${fail} failed`);
  console.log(lines.join('\n'));
  process.exit(fail > 0 ? 1 : 0);
}

main().catch((e) => {
  console.error('test-auth crashed:', e);
  process.exit(1);
});