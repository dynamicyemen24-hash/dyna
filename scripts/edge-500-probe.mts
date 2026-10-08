// edge-500-probe.mts — proves or disproves the production 500 on
// /api/auth/login by creating two THROWAWAY users against the LIVE Neon
// database (same DB the Cloudflare Worker reads) and signing in through the
// LIVE public URL:
//
//   user A: password_iterations = 210000  (above the Workers PBKDF2 ceiling)
//   user B: password_iterations = 100000  (the portable cost)
//
// If A yields 500 and B yields 401/200, the 500 is the iteration ceiling and
// the affected production accounts are exactly those stored above 100000.
// Both rows are deleted afterwards — verified.
//
// Usage: npx tsx scripts/edge-500-probe.mts
import crypto from 'crypto';
import pg from 'pg';
import dotenv from 'dotenv';
import { hashPassword } from '../server/passwords.js';

dotenv.config();

const LIVE = process.env.DYPOS_PROBE_URL || 'https://dyposcloud.smartportssoft.com';

const pool = new pg.Pool({
  connectionString: process.env.DATABASE_URL,
  ssl: { rejectUnauthorized: false },
  max: 2,
  connectionTimeoutMillis: 20000,
});

async function postJson(url: string, body: unknown): Promise<{ status: number; text: string }> {
  const res = await fetch(url, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });
  const text = await res.text();
  return { status: res.status, text: text.slice(0, 300) };
}

async function main() {
  const stamp = Date.now().toString(36);
  const created: string[] = [];
  try {
    const branch = await pool.query(
      "SELECT id FROM dypos.branches WHERE tenant_id='royal-global-hq' AND is_active=TRUE LIMIT 1"
    );
    const branchId = branch.rows[0]?.id ?? null;

    const mk = async (suffix: string, iterations: number): Promise<{ uname: string; pw: string }> => {
      const uname = `edge500_${suffix}_${stamp}`;
      const pw = 'Edge500-' + crypto.randomBytes(5).toString('hex') + '-Aa1!';
      const h = await hashPassword(pw, iterations);
      const id = 'u-edge500-' + suffix + '-' + stamp;
      await pool.query(
        `INSERT INTO dypos.users (id, tenant_id, branch_id, username, password_hash, name, role,
           password_salt, password_iterations, password_algo, is_active, must_change_password)
         VALUES ($1,'royal-global-hq',$2,$3,$4,'edge 500 probe','cashier',$5,$6,$7,true,false)`,
        [id, branchId, uname, h.hash, h.salt, h.iterations, h.algo]
      );
      created.push(id);
      return { uname, pw };
    };

    const a = await mk('a', 210000);
    const b = await mk('b', 100000);
    console.log('created throwaway users: ' + a.uname + ' (210k), ' + b.uname + ' (100k)');

    const ra = await postJson(LIVE + '/api/auth/login', { username: a.uname, password: a.pw, branchId });
    console.log('A 210k -> HTTP ' + ra.status + ' :: ' + ra.text);
    const rb = await postJson(LIVE + '/api/auth/login', { username: b.uname, password: b.pw, branchId });
    console.log('B 100k -> HTTP ' + rb.status + ' :: ' + rb.text);

    const verdict =
      ra.status === 500 && (rb.status === 200 || rb.status === 401)
        ? 'CONFIRMED: the 500 is the Workers PBKDF2 iteration ceiling (>100000).'
        : 'NOT the ceiling — inspect the response bodies above.';
    console.log('VERDICT: ' + verdict);
  } finally {
    if (created.length) {
      await pool.query('DELETE FROM dypos.users WHERE id = ANY($1)', [created]);
      const left = await pool.query('SELECT 1 FROM dypos.users WHERE id = ANY($1)', [created]);
      console.log('cleanup: ' + (left.rows.length === 0 ? 'throwaway rows removed' : 'STILL PRESENT!'));
    }
    await pool.end();
  }
}

main().catch((e) => {
  console.log('FATAL: ' + (e?.message ?? e));
  process.exit(1);
});
