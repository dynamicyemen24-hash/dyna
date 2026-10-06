/**
 * Rate limiting on the pre-authentication surface.
 *
 * Run:  npx tsx scripts/test-rate-limit.ts
 *
 * ══ THE DEFECT THIS GUARDS ════════════════════════════════════════════════
 * `/api/auth/login` runs PBKDF2 at 100,000 iterations BEFORE it can refuse a
 * password, and the per-account lockout in `passwords.ts` only bounds guessing
 * against ONE user. Nothing bounded one IP rotating hundreds of usernames,
 * or the raw CPU cost of a flood of logins that all fail.
 *
 * Both are now two independent budgets per IP per route: 401/403 verdicts
 * consume the failure budget, every request consumes the request budget.
 *
 * ══ WHY IT BOOTS THE REAL APP ═══════════════════════════════════════════════
 * A limiter that exists but is registered in the wrong place protects nothing
 * while still passing a unit test of its own helper. This constructs the real
 * application through `createApp()` and calls the real routes over HTTP —
 * the standard `test:session-gate` applies to the session gate, and for the
 * same reason: registration order is the whole claim.
 *
 * ══ HOW A SINGLE IP IS SIMULATED ══════════════════════════════════════════
 * The limiter keys on `cf-connecting-ip` first (what Cloudflare puts in front
 * of the real client address in production). Setting that header per request
 * is therefore not a test trick — it is the production keying, exercised.
 */
process.env.NODE_ENV = 'production';
/*
 * Window and budgets are set here, and `server/rateLimit.ts` re-reads them per
 * request, so these govern every assertion.
 *
 * WHY THE WINDOW IS 8s AND NOT 1.5s
 * A login for an unknown username runs ~6 queries against Neon over the wire
 * (tenant resolve, user lookup, the identity engine's three scans, the audit
 * insert) — measured at roughly 1-1.5s per attempt end to end. With a 1.5s
 * window the bucket expired BETWEEN attempts and the counter silently reset,
 * so the refusal under test never accumulated: the first run of this file
 * asserted 429 and got 401 on every try. The window must outlive the time it
 * takes to spend the budget it protects, which is a property of the DATABASE
 * latency, not of the limiter.
 */
process.env.DYPOS_AUTH_RATE_WINDOW_MS = '8000';
process.env.DYPOS_AUTH_RATE_MAX_FAILURES = '3';
process.env.DYPOS_AUTH_RATE_MAX_REQUESTS = '10000';

let pass = 0;
let fail = 0;
function check(name: string, ok: boolean, detail = ''): void {
  if (ok) { pass += 1; console.log(`  ok   ${name}`); }
  else { fail += 1; console.error(`  FAIL ${name}${detail ? ` — ${detail}` : ''}`); }
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

async function main() {
  const { createApp } = await import('../server.ts');
  const app = await createApp();
  const server = app.listen(0);
  const port = (server.address() as { port: number }).port;
  const base = `http://127.0.0.1:${port}`;

  const post = async (path: string, body: unknown, ip: string) => {
    const r = await fetch(`${base}${path}`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'cf-connecting-ip': ip },
      body: JSON.stringify(body),
    });
    return { status: r.status, retryAfter: r.headers.get('retry-after'), json: await r.json().catch(() => null) };
  };

  try {
    console.log('\n1. a wrong password is still a 401 — the limiter does not answer first');
    const first = await post('/api/auth/login', { username: 'rate_probe_none', password: 'wrong-password-1' }, '198.51.100.1');
    check('the first guess is refused by AUTHENTICATION, not by the limiter',
      first.status === 401, `status=${first.status}`);

    console.log('\n2. malformed requests (400) do not consume the FAILURE budget');
    /*
     * If 400s counted, the third malformed call would trip a budget of 3 and
     * a later legitimate 401 would come back 429 — proving the wrong thing.
     */
    let bad400s = 0;
    for (let i = 0; i < 5; i++) {
      const r = await post('/api/auth/login', {}, '198.51.100.2');
      if (r.status === 400) bad400s += 1;
      check(`malformed attempt ${i + 1} is a 400, never a 429`, r.status === 400, `status=${r.status}`);
    }
    check('all five malformed requests reached the handler', bad400s === 5);

    console.log('\n3. after the failure budget, the SAME IP is throttled with 429');
    for (let i = 0; i < 3; i++) {
      const r = await post('/api/auth/login', { username: `rate_probe_${i}`, password: 'wrong-password-1' }, '198.51.100.3');
      check(`guess ${i + 1} of 3 is a 401 (budget not yet spent)`, r.status === 401, `status=${r.status}`);
    }
    const limited = await post('/api/auth/login', { username: 'rate_probe_x', password: 'wrong-password-1' }, '198.51.100.3');
    check('the 4th attempt is refused with 429, not 401', limited.status === 429, `status=${limited.status}`);
    check('the 429 carries retry-after', Number(limited.retryAfter) >= 1, `retry-after=${limited.retryAfter}`);
    check('the 429 body is the Arabic message, not a stack trace',
      typeof limited.json?.error === 'string' && limited.json.error.includes('أعد المحاولة'),
      JSON.stringify(limited.json));

    console.log('\n4. a different IP is unaffected — the budget is per IP');
    const otherIp = await post('/api/auth/login', { username: 'rate_probe_other', password: 'wrong-password-1' }, '198.51.100.4');
    check('IP D still gets the normal 401 while IP C is throttled',
      otherIp.status === 401, `status=${otherIp.status}`);

    console.log('\n5. budgets are per ROUTE — a throttled login does not throttle password-policy');
    const policy = await post('/api/auth/password-policy', { password: '123', username: 'someone' }, '198.51.100.3');
    check('password-policy answers 200 from the throttled IP',
      policy.status === 200, `status=${policy.status}`);

    console.log('\n6. non-authentication verdicts leave the failure budget untouched');
    /*
     * Section 2 proved a 400 does not charge the counter: five 400s from IP B,
     * then a normal 401 on the sixth call. Had any non-401 status been
     * incrementing `failures`, that sixth call would have been a 429.
     */
    const after400s = await post('/api/auth/login', { username: 'rate_probe_b', password: 'wrong-password-1' }, '198.51.100.2');
    check('IP B: five 400s earlier still leave room for a 401',
      after400s.status === 401, `status=${after400s.status}`);

    console.log('\n7. the window reopens — a throttle is not a lockout');
    // Must exceed DYPOS_AUTH_RATE_WINDOW_MS (8000) — see the header note: the
    // window is sized against database latency, so the wait is sized to it.
    await sleep(8500);
    const reopened = await post('/api/auth/login', { username: 'rate_probe_late', password: 'wrong-password-1' }, '198.51.100.3');
    check('after the window, IP C is judged by authentication again (401)',
      reopened.status === 401, `status=${reopened.status}`);

    console.log('\n8. the escape hatch: DYPOS_AUTH_RATE_LIMIT=off');
    process.env.DYPOS_AUTH_RATE_LIMIT = 'off';
    const off = await post('/api/auth/login', { username: 'rate_probe_off', password: 'wrong-password-1' }, '198.51.100.3');
    check('with the limiter off, an exhausted IP gets the normal 401',
      off.status === 401, `status=${off.status}`);
    delete process.env.DYPOS_AUTH_RATE_LIMIT;

    console.log('\n9. source contract — every pre-auth guessing route is wired');
    /*
     * Route coverage is checked from source because a NEW auth route added
     * later must be limited WITHOUT someone remembering this file. The check
     * fails on an unwired route the same way `test:no-fake-data` fails on a
     * seeded figure: by scanning the declaration, not by trusting the habit.
     */
    const { readFileSync } = await import('node:fs');
    const authSrc = readFileSync('server/authRoutes.ts', 'utf8');
    const coreSrc = readFileSync('server/coreScreenRoutes.ts', 'utf8');
    const workerSrc = readFileSync('worker/index.ts', 'utf8');

    const mustBeLimited = [
      "'/api/auth/login'",
      "'/api/auth/mfa/verify'",
      "'/api/auth/break-glass'",
      "'/api/auth/reset-password'",
      "'/api/auth/change-password'",
    ];
    for (const route of mustBeLimited) {
      const line = authSrc.split('\n').find((l) => l.includes(`app.post(${route}`)) ?? '';
      check(`${route} is registered WITH authRateLimit`, line.includes('authRateLimit('), line.trim());
    }
    const unlockLine = coreSrc.split('\n').find((l) => l.includes("app.post('/api/auth/unlock'")) ?? '';
    check("'/api/auth/unlock' is registered WITH authRateLimit", unlockLine.includes('authRateLimit('), unlockLine.trim());

    check('the production edge carries the same limiter (rateLimitVerdict exists)',
      workerSrc.includes('function rateLimitVerdict'));
    check('the edge applies the limiter on the login path',
      workerSrc.includes('rateLimitVerdict('));
    check('the edge counts verdicts back into the failure budget',
      workerSrc.includes('rateNoteVerdict('));
  } finally {
    server.close();
    // A macrotask before exit: on Windows, `process.exit` from inside the
    // close window trips libuv's UV_HANDLE_CLOSURING assertion, which ABORTS
    // with a non-zero code even when every check passed — breaking the `&&`
    // chain in `ci:db`. Same fix as test-session-gate.ts.
    await new Promise((r) => setTimeout(r, 50));
  }

  console.log(`\n${pass} passed, ${fail} failed`);
  process.exit(fail ? 1 : 0);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});

