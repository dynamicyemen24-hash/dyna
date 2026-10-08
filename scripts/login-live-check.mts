// login-live-check.mts — end-to-end login + operations smoke test against the
// REAL Express app (createApp) wired to the LIVE Neon database.
// Only READS operational state, except one throwaway cashier account that is
// created, exercised, then deleted inside the test (verified deleted).
//
// Usage: npx tsx scripts/login-live-check.mts
import express from 'express';
import crypto from 'crypto';
import pg from 'pg';
import dotenv from 'dotenv';
import { createApp } from '../server.js';
import { hashPassword } from '../server/passwords.js';

dotenv.config();

let pass = 0;
let fail = 0;
function check(name: string, ok: boolean, detail = ''): void {
  if (ok) { pass++; console.log('  ok   ' + name); }
  else { fail++; console.log('  FAIL ' + name + (detail ? ' — ' + detail : '')); }
}

const app = express();
app.use(express.json());
const full = await createApp();
app.use(full);
const server = app.listen(0);
const base = 'http://127.0.0.1:' + (server.address() as { port: number }).port;

async function post(path: string, body: unknown, token?: string): Promise<{ status: number; json: any }> {
  const res = await fetch(base + path, {
    method: 'POST',
    headers: Object.assign({ 'Content-Type': 'application/json' }, token ? { Authorization: 'Bearer ' + token } : {}),
    body: JSON.stringify(body),
  });
  let json: any = {};
  try { json = await res.json(); } catch { /* non-JSON */ }
  return { status: res.status, json };
}
async function get(path: string, token?: string): Promise<{ status: number; json: any }> {
  const res = await fetch(base + path, {
    headers: token ? { Authorization: 'Bearer ' + token } : {},
  });
  let json: any = {};
  try { json = await res.json(); } catch { /* non-JSON */ }
  return { status: res.status, json };
}

try {
  console.log('\n1. public branch directory (what the login screen fetches)');
  const br = await get('/api/db/branches');
  const items = br.json.items || br.json.branches || [];
  check('branch directory answers 200 with rows', br.status === 200 && items.length > 0, 'status=' + br.status + ' n=' + items.length);

  console.log('\n2. wrong password is refused');
  const bad = await post('/api/auth/login', { username: 'yacoub', password: 'definitely-wrong-1' });
  check('wrong password yields 401', bad.status === 401, 'status=' + bad.status);

  console.log('\n3. throwaway cashier: create, sign in, operate, remove');
  const stamp = Date.now().toString(36);
  const uname = 'livechk_' + stamp;
  const pw = 'Chk-' + crypto.randomBytes(6).toString('hex') + '-Aa1!';
  const hpw = await hashPassword(pw);
  const pool = new pg.Pool({ connectionString: process.env.DATABASE_URL, ssl: { rejectUnauthorized: false }, max: 1 });
  const brRow = await pool.query("SELECT id FROM dypos.branches WHERE tenant_id='royal-global-hq' AND is_active=TRUE LIMIT 1");
  const branchId = brRow.rows[0] && brRow.rows[0].id;
  const uid = 'u-livechk-' + stamp;
  await pool.query(
    "INSERT INTO dypos.users (id, tenant_id, branch_id, username, password_hash, name, role, password_salt, password_iterations, password_algo, is_active) VALUES ($1,'royal-global-hq',$2,$3,$4,'live check','cashier',$5,$6,$7,true)",
    [uid, branchId, uname, hpw.hash, hpw.salt, hpw.iterations, hpw.algo]
  );
  const login = await post('/api/auth/login', { username: uname, password: pw, branchId });
  check('throwaway cashier signs in', login.status === 200 && Boolean(login.json.session && login.json.session.token), 'status=' + login.status);
  const token = login.json.session && login.json.session.token;
  if (token) {
    const me = await get('/api/erp/me', token);
    check('session token reaches a gated route', me.status === 200, 'status=' + me.status);
    const prods = await get('/api/db/products?limit=5', token);
    check('products list reads through the session', prods.status === 200, 'status=' + prods.status);
  }
  await pool.query('DELETE FROM dypos.users WHERE id=$1', [uid]);
  const gone = await pool.query('SELECT 1 FROM dypos.users WHERE id=$1', [uid]);
  check('throwaway account fully removed', gone.rows.length === 0);
  await pool.end();
} finally {
  server.close();
}
console.log('\n' + pass + ' passed, ' + fail + ' failed');
process.exit(fail === 0 ? 0 : 1);
