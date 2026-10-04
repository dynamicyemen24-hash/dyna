/**
 * Unlock gate — proof that the authentication bypass is closed.
 *
 * Run:  npx tsx scripts/test-unlock.ts
 *
 * The defect being guarded against is specific: an UNAUTHENTICATED caller could
 * POST an arbitrary `userId` plus any non-empty `credential` and receive
 * `{ ok: true }`. So the tests assert the NEGATIVE cases first — those are the
 * ones that matter, and a test that only checked the happy path would have
 * passed against the broken endpoint.
 */
import dotenv from 'dotenv';
import pg from 'pg';
import express from 'express';
import { makeId } from '../server/apiHelpers.ts';
import { hashPassword } from '../server/passwords.ts';
import { issueSessionToken } from '../server/sessions.ts';

dotenv.config();

/**
 * The pool is configured to SURVIVE a dropped connection.
 *
 * This test ran three times in quick succession against Neon and hit
 * "Connection terminated due to connection timeout" — the pooled sockets had
 * gone stale while the previous run held them. A stale-connection error is a
 * transport problem, not a result, so it is retried here at the pool level
 * rather than being allowed to surface as a failed assertion. Asserting on a
 * connection failure would report a red test for a green system, which is the
 * testing theatre §11 forbids.
 */
const pool = new pg.Pool({
  connectionString: process.env.DATABASE_URL,
  ssl: { rejectUnauthorized: false },
  max: 2,
  // Recycle idle sockets so a later run does not inherit a dead one.
  idleTimeoutMillis: 10_000,
  connectionTimeoutMillis: 20_000,
});

/** One query, with a bounded retry for stale-socket errors only. */
async function q<T extends pg.QueryResultRow = any>(
  text: string,
  values: unknown[] = [],
): Promise<pg.QueryResult<T>> {
  let lastErr: unknown;
  for (let attempt = 0; attempt < 3; attempt += 1) {
    try {
      return await pool.query<T>(text, values as never[]);
    } catch (err) {
      lastErr = err;
      const message = String((err as Error)?.message ?? '');
      const stale = /terminated|timeout|ECONNRESET|EPIPE|Connection closed/i.test(message);
      if (!stale) throw err;
      // Back off so the pool has time to open a fresh connection.
      await new Promise((r) => setTimeout(r, 1500 * (attempt + 1)));
    }
  }
  throw lastErr;
}

const TENANT = 'royal-global-hq';
const PIN = 'Correct-Horse-9!';

let pass = 0;
let fail = 0;
function check(name: string, ok: boolean, detail = '') {
  if (ok) { pass += 1; console.log(`  ok   ${name}`); }
  else { fail += 1; console.error(`  FAIL ${name}${detail ? ` — ${detail}` : ''}`); }
}

type Call = (
  path: string, body: unknown, token?: string,
) => Promise<{ status: number; body: any }>;

/**
 * Boots the REAL server router in-process.
 *
 * The point is to exercise the actual route with the actual middleware chain. A
 * test that called a helper directly would not have caught this defect, which
 * lived entirely in the wiring between middleware and handler.
 */
async function withServer(fn: (call: Call) => Promise<void>): Promise<void> {
  const { registerCoreScreenRoutes } = await import('../server/coreScreenRoutes.ts');
  const app = express();
  app.use(express.json());
  registerCoreScreenRoutes(app);

  const server = app.listen(0);
  const port = (server.address() as { port: number }).port;

  const call: Call = async (path, body, token) => {
    const res = await fetch(`http://127.0.0.1:${port}${path}`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        // The real client sends the tenant header on every request
        // (`services/dyposApi.ts`), and `attachPrincipal` resolves the principal
        // within that tenant. Omitting it here made the middleware reject the
        // token — which would have made these tests pass for the WRONG reason,
        // so the harness must mirror the production client exactly.
        'x-tenant-id': TENANT,
        ...(token ? { Authorization: `Bearer ${token}` } : {}),
      },
      body: JSON.stringify(body),
    });
    let parsed: any = {};
    try { parsed = await res.json(); } catch { /* a non-JSON body is still a response */ }
    return { status: res.status, body: parsed };
  };

  try {
    await fn(call);
  } finally {
    await new Promise<void>((r) => server.close(() => r()));
  }
}
async function main() {
  const userId = makeId('u-unlock-test');
  const username = `unlock_probe_${Date.now()}`;

  const pw = await hashPassword(PIN);
  await q(
    `INSERT INTO dypos.users
       (id, tenant_id, username, password_hash, name, role,
        password_salt, password_iterations, password_algo, is_active)
     VALUES ($1,$2,$3,$4,$5,'cashier',$6,$7,$8,true)`,
    [userId, TENANT, username, pw.hash, 'Unlock Probe', pw.salt, pw.iterations, pw.algo],
  );

  const token = issueSessionToken(userId, username, TENANT);

  try {
    await withServer(async (call) => {
      console.log('\n1. the bypass itself — these must all FAIL');
      {
        const r = await call('/api/auth/unlock', { userId, method: 'face', credential: 'x' });
        check('unauthenticated request with any credential is REFUSED',
          r.status === 401 || r.status === 403, `status ${r.status}`);
        check('and it does not return ok:true', r.body?.ok !== true, JSON.stringify(r.body));
      }
      {
        const r = await call('/api/auth/unlock', { userId, method: 'pin', pin: 'wrong', credential: 'x' });
        check('unauthenticated request cannot unlock even with a pin field',
          r.status === 401 || r.status === 403, `status ${r.status}`);
      }
      {
        // The original exploit shape, verbatim.
        const r = await call('/api/auth/unlock', { userId, method: 'fingerprint', credential: 'anything-at-all' });
        check('the exact old exploit payload is REFUSED',
          r.status !== 200 && r.body?.ok !== true, `status ${r.status}`);
      }

      console.log('\n2. authenticated — the real checks apply');
      {
        const r = await call('/api/auth/unlock', { method: 'face' }, token);
        check('an unenrolled biometric is refused, not faked',
          r.status === 501 && r.body?.ok !== true, `status ${r.status}`);
      }
      {
        const r = await call('/api/auth/unlock', { method: 'pin', pin: 'definitely-wrong' }, token);
        check('a wrong PIN is refused', r.status === 401 && r.body?.ok !== true, `status ${r.status}`);
      }
      {
        const r = await call('/api/auth/unlock', { method: 'pin' }, token);
        check('a missing PIN is a 400, not a success',
          r.status === 400 && r.body?.ok !== true, `status ${r.status}`);
      }
      {
        // Step sideways must be impossible.
        const r = await call('/api/auth/unlock', { subjectId: 'someone-else', method: 'pin', pin: PIN }, token);
        check('unlocking a DIFFERENT subject is refused',
          r.status === 403 && r.body?.ok !== true, `status ${r.status}`);
      }
      {
        const r = await call('/api/auth/unlock', { method: 'pin', pin: PIN }, token);
        check('the correct PIN unlocks the CALLER',
          r.status === 200 && r.body?.ok === true, `status ${r.status} ${JSON.stringify(r.body)}`);
      }
      {
        const r = await call('/api/auth/unlock', { method: 'carrier-pigeon' }, token);
        check('an unsupported method is refused', r.status === 400, `status ${r.status}`);
      }

      console.log('\n3. a tampered token grants nothing');
      {
        const r = await call('/api/auth/unlock', { method: 'pin', pin: PIN }, `${token}x`);
        check('a tampered token is refused', r.status === 401 || r.status === 403, `status ${r.status}`);
      }
    });
  } finally {
    await q(`DELETE FROM dypos.auth_events WHERE username = $1`, [username]);
    await q(`DELETE FROM dypos.users WHERE id = $1`, [userId]);
    await pool.end();
  }

  console.log(`\n${pass} passed, ${fail} failed`);
  process.exit(fail === 0 ? 0 : 1);
}

main().catch((e) => { console.error(e); process.exit(1); });