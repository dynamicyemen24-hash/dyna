/**
 * Cross-tenant isolation — proof that a caller-chosen tenant is not honoured.
 *
 * Run:  npx tsx scripts/test-tenant-isolation.ts
 *
 * ══ THE DEFECT THIS GUARDS ═════════════════════════════════════════════════
 * `tenantOf()` used to resolve the tenant in this order:
 *
 *     1. the `x-tenant-id` request header
 *     2. `?tenantId=`
 *     3. `body.tenantId`
 *     4. `DEFAULT_TENANT`
 *
 * Every route bound that value into a correct `WHERE tenant_id = $1`. The
 * predicate was real; the parameter was whatever the caller typed. So the SQL
 * looked properly tenant-scoped at every call site while performing no isolation
 * whatsoever — a distinction that code review and static analysis both miss,
 * because they check for the PRESENCE of the predicate, not the provenance of
 * its parameter. O2 could see `tenant_id = $1` on all 73 findings and still not
 * notice, because it does not — and cannot — know where `$1` came from.
 *
 * The attack needs no credential at all: `curl -H 'x-tenant-id: victim'`.
 *
 * ══ WHY THE HAPPY PATH PROVES NOTHING ════════════════════════════════════
 * A test showing "tenant A reads tenant A's rows" passes against the broken
 * code, because that path genuinely worked. So most of what follows asserts the
 * NEGATIVE: a real, correctly-scoped, validly-signed user asking for someone
 * else's tenant and receiving NOTHING.
 */
import dotenv from 'dotenv';
import pg from 'pg';
import express from 'express';
import { tenantOf, assertTenantClaim, makeId, asyncRoute } from '../server/apiHelpers.ts';
import { attachPrincipal } from '../server/authz.ts';
import { issueSessionToken } from '../server/sessions.ts';
import { hashPassword } from '../server/passwords.ts';

dotenv.config();

const TENANT_A = 'iso-tenant-a';
const TENANT_B = 'iso-tenant-b';
/** Mirrors `DEFAULT_TENANT` — what an unauthenticated caller resolves to. */
const FALLBACK = 'royal-global-hq';

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
  connectionTimeoutMillis: 20_000,
});

async function call(
  url: string,
  opts: { headers?: Record<string, string>; method?: string; body?: unknown } = {},
): Promise<{ status: number; data: any }> {
  const res = await fetch(url, {
    method: opts.method || 'GET',
    headers: { 'content-type': 'application/json', ...(opts.headers || {}) },
    body: opts.body ? JSON.stringify(opts.body) : undefined,
  });
  let data: any = {};
  try { data = await res.json(); } catch { /* a non-JSON body is still a response */ }
  return { status: res.status, data };
}

async function main() {
  const suffix = Date.now().toString(36);
  const userA = `iso_a_${suffix}`;
  const branchId = makeId('br');
  const secret = `SECRET_OF_B_${suffix}`;

  console.log('\n0. fixtures — two tenants, and a row that belongs only to B');
  const pw = await hashPassword('Cross-Tenant-Probe-9!');
  // `branches.tenant_id` and `users.tenant_id` are foreign keys into `tenants`,
  // so a fake tenant id cannot simply be written — the schema itself insists a
  // tenant exists before rows can claim to belong to it. Worth noting: this
  // means these fixtures are as real as production rows.
  await pool.query(
    `INSERT INTO dypos.tenants (id, name) VALUES ($1,$2), ($3,$4)
     ON CONFLICT (id) DO NOTHING`,
    [TENANT_A, 'Isolation Tenant A', TENANT_B, 'Isolation Tenant B'],
  );
  await pool.query(`DELETE FROM dypos.users WHERE tenant_id = ANY($1)`, [[TENANT_A, TENANT_B]]);
  await pool.query(
    `INSERT INTO dypos.branches (id, tenant_id, name) VALUES ($1,$2,$3)`,
    [branchId, TENANT_B, 'B branch'],
  );
  await pool.query(
    `INSERT INTO dypos.users (id, tenant_id, username, name, password_hash, is_active)
     VALUES ($1,$2,$3,$4,$5,TRUE)`,
    [makeId('u'), TENANT_A, userA, 'A user', pw.hash],
  );
  await pool.query(
    `INSERT INTO dypos.customers (id, tenant_id, name, phone) VALUES ($1,$2,$3,$4)`,
    [makeId('cu'), TENANT_B, 'B-only customer', secret],
  );
  // The REAL server, with the REAL middleware chain. Calling `tenantOf()`
  // directly would pass even against a route that wired it up wrongly — the
  // whole defect lived in the connection between middleware and handler.
  const { registerCoreScreenRoutes } = await import('../server/coreScreenRoutes.ts');
  const app = express();
  app.use(express.json());

  app.get('/probe/tenant', attachPrincipal, (req, res) => {
    res.json({ tenant: tenantOf(req), principal: req.principal?.username });
  });

  // A route shaped exactly like the real read routes: correct predicate, with
  // the tenant supplied by the helper that used to honour the caller.
  app.get('/probe/customers', attachPrincipal, asyncRoute(async (req, res) => {
    const tenant = tenantOf(req);
    const { rows } = await pool.query(
      `SELECT name, phone FROM dypos.customers WHERE tenant_id = $1`,
      [tenant],
    );
    res.json({ tenant, customers: rows });
  }));

  app.get('/probe/assert', attachPrincipal, (req, res) => {
    try {
      assertTenantClaim(req, String(req.query.tenantId || ''));
      res.json({ ok: true });
    } catch (e) {
      res.status((e as { status?: number }).status || 403).json({ error: (e as Error).message });
    }
  });

  // No principal at all — the state a PUBLIC route is in.
  app.get('/probe/public', (req, res) => res.json({ tenant: tenantOf(req) }));

  registerCoreScreenRoutes(app);

  const server = app.listen(0);
  const base = `http://127.0.0.1:${(server.address() as { port: number }).port}`;

  try {
    console.log('\n1. a session token carries a signed tenant');
    const tokenA = issueSessionToken(makeId('u'), userA, TENANT_A);
    check('a signed token is issued', typeof tokenA === 'string' && tokenA.includes('.'));

    console.log('\n2. tenantOf() ignores a forged claim');
    // No token at all: a forged header must not decide the tenant.
    const h = await call(`${base}/probe/public`, { headers: { 'x-tenant-id': TENANT_B } });
    check('x-tenant-id:B is not honoured', h.data.tenant !== TENANT_B, `resolved ${h.data.tenant}`);
    check('it falls back to the default tenant', h.data.tenant === FALLBACK, `resolved ${h.data.tenant}`);

    console.log('\n3. THE ATTACK — a valid token for A claiming B');
    const a = await call(`${base}/probe/tenant`, { headers: { authorization: `Bearer ${tokenA}` } });
    check('tenant A resolves to itself', a.data.tenant === TENANT_A, `resolved ${a.data.tenant}`);
    /*
     * A non-expired, correctly-signed token for tenant A — with the header
     * naming tenant B. Before the fix `tenantOf()` returned B here, and the
     * query below then returned B's customers.
     */
    const attack = await call(`${base}/probe/tenant`, {
      headers: { authorization: `Bearer ${tokenA}`, 'x-tenant-id': TENANT_B },
    });
    check('a valid A-token + header B still resolves to A',
      attack.data.tenant === TENANT_A, `resolved ${attack.data.tenant} — CROSS-TENANT LEAK`);

    console.log('\n4. the decisive test — A cannot read B\'s data');
    const own = await call(`${base}/probe/customers`, { headers: { authorization: `Bearer ${tokenA}` } });
    check('A reading its own tenant sees only A (empty)', own.data.customers.length === 0,
      `returned ${own.data.customers.length}`);

    const steal = await call(`${base}/probe/customers`, {
      headers: { authorization: `Bearer ${tokenA}`, 'x-tenant-id': TENANT_B },
    });
    const leaked = (steal.data.customers || []).filter((c: { phone: string }) => c.phone === secret);
    check('A + header B receives NO row of B', leaked.length === 0, `${leaked.length} leaked`);
    check('the forged scope yields an empty result set', (steal.data.customers || []).length === 0,
      `returned ${(steal.data.customers || []).length} rows`);

    console.log('\n5. a mismatch is reported, not silently ignored');
    // The legacy header is still READ, but only to be CHECKED. Rejecting a
    // mismatch outright would break the real SPA; silently allowing it is the
    // vulnerability. So the fix reports the disagreement instead.
    const mismatch = await call(`${base}/probe/assert?tenantId=${TENANT_B}`, {
      headers: { authorization: `Bearer ${tokenA}` },
    });
    check('a mismatched tenant claim is 403', mismatch.status === 403, `status ${mismatch.status}`);
    check('the message names both tenants',
      String(mismatch.data.error).includes(TENANT_B) && String(mismatch.data.error).includes(TENANT_A),
      String(mismatch.data.error));

    const match = await call(`${base}/probe/assert?tenantId=${TENANT_A}`, {
      headers: { authorization: `Bearer ${tokenA}` },
    });
    check('a matching claim is accepted', match.status === 200, `status ${match.status}`);

    console.log('\n6. a token cannot conjure an identity');
    const ghost = issueSessionToken(makeId('u'), `ghost_${suffix}`, TENANT_A);
    const ghostRes = await call(`${base}/probe/tenant`, { headers: { authorization: `Bearer ${ghost}` } });
    check('a signed-but-nonexistent user is refused', ghostRes.status === 401 || ghostRes.status === 403,
      `status ${ghostRes.status}`);

    const tampered = `${tokenA.slice(0, -4)}AAAA`;
    const tamperedRes = await call(`${base}/probe/tenant`, { headers: { authorization: `Bearer ${tampered}` } });
    check('a tampered signature is refused', tamperedRes.status === 401 || tamperedRes.status === 403,
      `status ${tamperedRes.status}`);
  } finally {
    console.log('\n7. cleanup');
    await pool.query(`DELETE FROM dypos.users WHERE tenant_id = ANY($1)`, [[TENANT_A, TENANT_B]]);
    await pool.query(`DELETE FROM dypos.customers WHERE tenant_id = $1`, [TENANT_B]);
    await pool.query(`DELETE FROM dypos.branches WHERE id = $1`, [branchId]);
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