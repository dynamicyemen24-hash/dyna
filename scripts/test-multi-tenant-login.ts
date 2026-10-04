/**
 * Multi-tenant login — proof that identity is per-tenant, not global.
 *
 * Run:  npx tsx scripts/test-multi-tenant-login.ts
 *
 * ══ THE DEFECT THIS GUARDS ═════════════════════════════════════════════════
 * Two independent limits kept this product single-tenant, and only one was in
 * the code:
 *
 *   1. `dypos.users.username` carried a GLOBAL `UNIQUE` constraint, so two
 *      tenants could not both own an `admin`. That lived in the DATABASE, so no
 *      application change could route around it. Migration v140 moved
 *      uniqueness down to `(tenant_id, username)`.
 *
 *   2. Every login path was pinned to a hard-coded `DEFAULT_TENANT`, and the
 *      session token was minted with that same constant — so even a valid user
 *      of a second tenant received a session scoped to the FIRST tenant.
 *
 * The second matters more, because tenant isolation in the API was, until
 * recently, decorative. Isolation protecting data that no second tenant can
 * hold is not isolation.
 *
 * ══ THE ASSERTION THAT MATTERS MOST ═══════════════════════════════════════
 * Not "a second tenant can log in" — that is a feature. The important one is
 * that the SAME username in two tenants yields two INDEPENDENT sessions
 * resolving to two DIFFERENT tenants. If both resolved to one tenant then
 * `username` would still be a global identity, and the constraint change would
 * have bought nothing at all.
 */
import dotenv from 'dotenv';
import pg from 'pg';
import express from 'express';
import { registerAuthRoutes } from '../server/authRoutes.ts';
import { hashPassword, ALGO } from '../server/passwords.ts';
import { verifySessionToken } from '../server/sessions.ts';
import { tenantOf } from '../server/apiHelpers.ts';

dotenv.config();

const TA = 'mt-a';
const TB = 'mt-b';
const UNAME = 'admin';
const PW = 'Multi-Tenant-Probe-9!';

let pass = 0;
let fail = 0;
function check(name: string, ok: boolean, detail = ''): void {
  if (ok) { pass += 1; console.log(`  ok   ${name}`); }
  else { fail += 1; console.error(`  FAIL ${name}${detail ? ` — ${detail}` : ''}`); }
}

const pool = new pg.Pool({
  connectionString: process.env.DATABASE_URL,
  ssl: { rejectUnauthorized: false },
  max: 4,
  idleTimeoutMillis: 10_000,
});

type Call = (path: string, body: unknown) => Promise<{ status: number; body: any }>;

async function main() {
  const app = express();
  app.use(express.json());
  registerAuthRoutes(app);
  const server = app.listen(0);
  const port = (server.address() as { port: number }).port;

  const call: Call = async (path, body) => {
    const res = await fetch(`http://127.0.0.1:${port}${path}`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(body),
    });
    let parsed: any = {};
    try { parsed = await res.json(); } catch { /* non-JSON is still a response */ }
    return { status: res.status, body: parsed };
  };

  console.log('\n0. fixtures — the same username "admin" in two tenants');
  const hash = await hashPassword(PW);
  await pool.query(
    `INSERT INTO dypos.tenants (id, name) VALUES ($1,$2), ($3,$4)
     ON CONFLICT (id) DO NOTHING`,
    [TA, 'MT A', TB, 'MT B'],
  );
  // This INSERT is itself part of the proof: under the old GLOBAL unique
  // constraint it would have failed on the second row with a constraint
  // violation. If it runs, the schema now permits what multi-tenancy requires.
  await pool.query(`DELETE FROM dypos.users WHERE tenant_id = ANY($1)`, [[TA, TB]]);
  await pool.query(
    `INSERT INTO dypos.users
       (id, tenant_id, username, name, role, password_hash,
        password_salt, password_iterations, password_algo, is_active)
     VALUES ($1,$2,$3,'Admin A','admin',$4,$5,$6,$7,TRUE),
            ($8,$9,$3,'Admin B','admin',$4,$5,$6,$7,TRUE)`,
    ['u-mta', TA, UNAME, hash.hash, hash.salt, hash.iterations, ALGO,
     'u-mtb', TB],
  );
  check('two tenants can each own a user named "admin"', true);

  try {
    console.log('\n1. each tenant logs in independently');
    const a = await call('/api/auth/login', { username: UNAME, password: PW, tenantId: TA });
    const b = await call('/api/auth/login', { username: UNAME, password: PW, tenantId: TB });

    check('tenant A login succeeds', a.status === 200 && !!a.body?.session?.token, `status ${a.status}`);
    check('tenant B login succeeds', b.status === 200 && !!b.body?.session?.token, `status ${b.status}`);

    console.log('\n2. the token carries the tenant, not the default');
    const ta = a.body?.session?.token;
    const tb = b.body?.session?.token;
    const va = ta ? verifySessionToken(ta) : null;
    const vb = tb ? verifySessionToken(tb) : null;

    check('token A verifies', !!va?.ok);
    check('token B verifies', !!vb?.ok);
    check('token A carries tenant A', !!va?.ok && va.payload.tenantId === TA,
      va?.ok ? String(va.payload.tenantId) : 'no token');
    check('token B carries tenant B', !!vb?.ok && vb.payload.tenantId === TB,
      vb?.ok ? String(vb.payload.tenantId) : 'no token');
    check('neither token carries the default tenant',
      !!va?.ok && !!vb?.ok
      && va.payload.tenantId !== 'royal-global-hq'
      && vb.payload.tenantId !== 'royal-global-hq');

    console.log('\n3. THE ASSERTION THAT MATTERS — one name, two scopes');
    check('the same username produced two different tenants',
      !!va?.ok && !!vb?.ok && va.payload.tenantId !== vb.payload.tenantId,
      `${va?.ok ? va.payload.tenantId : '?'} vs ${vb?.ok ? vb.payload.tenantId : '?'}`);
    check('the two sessions are different tokens', !!ta && !!tb && ta !== tb);

    console.log('\n4. a password from tenant A does not work in tenant B');
    const other = await hashPassword('Some-Other-Password-9!');
    await pool.query(
      `UPDATE dypos.users
          SET password_hash = $3, password_salt = $4, password_iterations = $5, password_algo = $6
        WHERE tenant_id = $1 AND username = $2`,
      [TB, UNAME, other.hash, other.salt, other.iterations, ALGO],
    );
    const cross = await call('/api/auth/login', { username: UNAME, password: PW, tenantId: TB });
    check("tenant A's password is rejected at tenant B", cross.status === 401, `status ${cross.status}`);
    await pool.query(
      `UPDATE dypos.users
          SET password_hash = $3, password_salt = $4, password_iterations = $5, password_algo = $6
        WHERE tenant_id = $1 AND username = $2`,
      [TB, UNAME, hash.hash, hash.salt, hash.iterations, ALGO],
    );

    console.log('\n5. an unknown tenant is refused exactly like a bad password');
    const ghost = await call('/api/auth/login', {
      username: UNAME, password: PW, tenantId: 'no-such-tenant',
    });
    const wrongPw = await call('/api/auth/login', {
      username: UNAME, password: 'wrong-password', tenantId: TA,
    });
    check('unknown tenant is 401', ghost.status === 401, `status ${ghost.status}`);
    // A different message here would make this endpoint a tenant-enumeration
    // oracle: it would reveal which companies are customers of this product.
    check('unknown tenant gives the same message as a wrong password',
      ghost.body?.error === wrongPw.body?.error, `${ghost.body?.error} vs ${wrongPw.body?.error}`);
    check('unknown tenant gives the same status as a wrong password',
      ghost.status === wrongPw.status, `${ghost.status} vs ${wrongPw.status}`);

    console.log('\n6. a wrong password is still refused, with no token');
    const wrong = await call('/api/auth/login', {
      username: UNAME, password: 'definitely-wrong', tenantId: TA,
    });
    check('a wrong password is 401', wrong.status === 401, `status ${wrong.status}`);
    check('no token is issued on failure', !wrong.body?.session?.token);

    console.log('\n7. tenantOf() reads the scope from each session');
    // The end of the chain: a handler derives its tenant from the token, so the
    // two sessions address two different data scopes.
    const scopeOf = (token: string) => {
      const verified = verifySessionToken(token);
      return tenantOf({
        principal: verified.ok ? { tenantId: verified.payload.tenantId } : undefined,
      } as never);
    };
    check('session A scopes to A', !!ta && scopeOf(ta) === TA, ta ? scopeOf(ta) : '');
    check('session B scopes to B', !!tb && scopeOf(tb) === TB, tb ? scopeOf(tb) : '');

    console.log('\n8. omitting the tenant keeps legacy single-tenant behaviour');
    const legacy = await call('/api/auth/login', { username: 'no_such_user_at_all', password: PW });
    check('a login with no tenant returns the standard auth error',
      legacy.status === 401 && legacy.body?.error === wrongPw.body?.error,
      `status ${legacy.status}`);
  } finally {
    console.log('\n9. cleanup');
    await pool.query(`DELETE FROM dypos.users WHERE tenant_id = ANY($1)`, [[TA, TB]]);
    await pool.end();
    await new Promise<void>((r) => server.close(() => r()));
    console.log('  ok   fixtures removed');
  }

  console.log(`\n${pass} passed, ${fail} failed`);
  process.exit(fail ? 1 : 0);
}

main().catch((e) => {
  console.error('\nthe test itself failed:', e);
  process.exit(1);
});