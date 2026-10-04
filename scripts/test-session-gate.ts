/**
 * Default-deny session gate — proof that no API route is reachable unsigned.
 *
 * Run:  npx tsx scripts/test-session-gate.ts
 *
 * ══ THE DEFECT THIS GUARDS ════════════════════════════════════════════════
 * Authentication was applied PER ROUTE, by remembering to add
 * `attachPrincipal` to each of ~40 handlers. Thirty-eight of them did not have
 * it.
 *
 * Production was accidentally safe, because the Cloudflare Worker verifies the
 * token before proxying to Express. But `npm start` — the on-premise and local
 * deployment path — runs that same Express app directly, and there all
 * thirty-eight were open. "The front door has a guard" is not the same claim as
 * "the rooms are locked", and only one of them was true off-platform.
 *
 * The gate is now an ALLOWLIST installed before any route is registered, so a
 * route added later is protected automatically and forgetting is not possible.
 *
 * ══ WHY IT BOOTS THE REAL APP ═════════════════════════════════════════════
 * A middleware's effect depends entirely on REGISTRATION ORDER — the same
 * function placed after the routes protects nothing and still type-checks. So
 * this constructs the real application through `createApp()` and calls the real
 * routes over HTTP. A test that mounted its own Express app would prove nothing
 * about where the gate actually sits.
 */
process.env.NODE_ENV = 'production';

let pass = 0;
let fail = 0;
function check(name: string, ok: boolean, detail = ''): void {
  if (ok) { pass += 1; console.log(`  ok   ${name}`); }
  else { fail += 1; console.error(`  FAIL ${name}${detail ? ` — ${detail}` : ''}`); }
}

async function main() {
  const { createApp } = await import('../server.ts');
  const app = await createApp();
  const server = app.listen(0);
  const port = (server.address() as { port: number }).port;
  const base = `http://127.0.0.1:${port}`;

  const status = async (p: string, init?: RequestInit) => {
    const r = await fetch(`${base}${p}`, init);
    return r.status;
  };

  try {
    console.log('\n1. every data route refuses an anonymous caller');
    /*
     * The list is read from the routes themselves rather than hand-written, so a
     * NEW route added later is covered by this test automatically. A hard-coded
     * list is a snapshot: it passes forever while the surface grows.
     */
    const { DEFAULT_TENANT } = await import('../server/tenant.ts');
    void DEFAULT_TENANT;
    const src = readFileSync('server.ts', 'utf8')
      + readFileSync('server/apiKeyRoutes.ts', 'utf8')
      + readFileSync('server/accountingRoutes.ts', 'utf8')
      + readFileSync('server/commerceRoutes.ts', 'utf8');

    const routes = Array.from(
      new Set(Array.from(src.matchAll(/app\.(?:get|post|put|patch|delete)\('(\/api\/[^']*)'/g))
        .map((m) => m[1])),
    );

    check('routes were discovered from the source', routes.length > 20, `${routes.length}`);

    const publicRoutes = new Set([
      '/api/auth/login',
      '/api/auth/mfa/verify',
      '/api/auth/break-glass',
      '/api/auth/reset-password',
      '/api/auth/password-policy',
      '/api/auth/unlock',
      '/api/keys/whoami',
    ]);

    const leaks: string[] = [];
    for (const route of routes) {
      if (publicRoutes.has(route)) continue;
      // A GET probe is enough: an unsigned POST is refused by the gate before
      // the method is ever considered, so this cannot miss an open WRITE route.
      const code = await status(route, { method: 'GET' });
      if (code !== 401) leaks.push(`${route} → ${code}`);
    }
    check(
      `no anonymous caller reaches any of the ${routes.length - publicRoutes.size} protected routes`,
      leaks.length === 0,
      leaks.join(', '),
    );

    console.log('\n2. the genuinely public routes are NOT blocked');
    // 404 rather than 401 is the proof: the gate let the request THROUGH and the
    // router found no matching method. A 401 here would mean the allowlist
    // itself is broken and nobody could ever sign in.
    const loginCode = await status('/api/auth/login', { method: 'GET' });
    check('the login path passes the gate (404 = reached the router)',
      loginCode !== 401, `got ${loginCode}`);

    console.log('\n3. a forged or malformed token is refused everywhere');
    for (const bad of ['garbage', 'a.b', 'Bearer', '']) {
      const token = bad.startsWith('Bearer ') ? bad : bad;
      const code = await status('/api/db/customers', {
        headers: token ? { authorization: `Bearer ${token}` } : {},
      });
      check(`a token of "${token || '(empty)'}" is refused`, code === 401, `got ${code}`);
    }

    console.log('\n4. an API key does not unlock the human-session routes');
    // A key identifies a TENANT for an integration. It is not a session, and
    // treating it as one would let a leaked integration key read a tenant.
    const code = await status('/api/db/customers', {
      headers: { authorization: 'Bearer dypos_abc123_0000000000000000000000' },
    });
    check('an API key is not accepted as a session', code === 401, `got ${code}`);
  } finally {
    await new Promise<void>((r) => server.close(() => r()));
  }

  console.log(`\n${pass} passed, ${fail} failed`);
  process.exit(fail ? 1 : 0);
}

import { readFileSync } from 'node:fs';

main().catch((e) => {
  console.error('\nthe test itself failed:', e);
  process.exit(1);
});