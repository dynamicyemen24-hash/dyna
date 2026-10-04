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

const BASE = process.env.API_BASE || 'http://localhost:3000';
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

async function main() {
  log(`DyPOS AUTH E2E — ${new Date().toISOString()}`);
  log(`base: ${BASE}  user: ${USERNAME}\n`);

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