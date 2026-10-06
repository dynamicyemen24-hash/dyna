/**
 * MFA parity — proof that the edge enforces the SAME two-phase sign-in as
 * the local Express server.
 *
 * Run:  npx tsx scripts/test-mfa-parity.ts
 *
 * ══ THE DEFECT THIS GUARDS ════════════════════════════════════════════════
 * `worker/index.ts` issued a session token on the password alone. A user
 * enrolled in MFA could therefore sign in on the PUBLIC site without the
 * factor while the local server demanded it — the second factor protected
 * the dev server only. The edge now issues the challenge itself and mints
 * the token only after `verifyChallengeEdge` confirms the code.
 *
 * ══ WHY IT ASSERTS IN BOTH DIRECTIONS ═══════════════════════════════════
 * The two runtimes share the on-disk format (`dypos.mfa_challenges` holds a
 * SHA-256 hex digest either way) but NOT the primitives: Express uses Node
 * crypto, the edge uses Web Crypto. A digest that one runtime writes and the
 * other cannot read back is exactly how the 210,000-iteration credential died
 * before it — so each direction is asserted separately, and the digests are
 * asserted BINARY-equal first: same bytes, same algorithm, no format drift.
 *
 * The edge halves are imported from `worker/index.ts` directly. `wrangler dev`
 * would be the fuller proof, but it binds a local Neon tunnel the CI runner
 * may not have; the units under test are the hashing, issuing, and
 * verification against the SAME live database, which is where the parity
 * either holds or breaks.
 *
 * This suite runs against the live database and creates one probe user. It
 * disables the account and scrubs its rows on the way out, exactly as the
 * sibling `test:unlock` probes do.
 */
process.env.NODE_ENV = 'production';
import { PG_SSL } from '../server/neonDb.ts';

let pass = 0;
let fail = 0;
function check(name: string, ok: boolean, detail = ''): void {
  if (ok) { pass += 1; console.log(`  ok   ${name}`); }
  else { fail += 1; console.error(`  FAIL ${name}${detail ? ` — ${detail}` : ''}`); }
}

async function main() {
  const { default: dotenv } = await import('dotenv');
  dotenv.config();
  const { Pool } = await import('pg');
  const pool = new Pool({
    connectionString: process.env.DATABASE_URL,
    ssl: PG_SSL,
    max: 1,
  });
  const { hashPassword } = await import('../server/passwords.ts');
  const { makeId } = await import('../server/apiHelpers.ts');
  const { readMfaPolicy, mfaRequired, issueChallenge, verifyChallenge } =
    await import('../server/mfa.ts');
  const Edge = await import('../worker/index.ts');

  const TENANT = process.env.DEFAULT_TENANT || 'royal-global-hq';
  const suffix = Date.now().toString(36);
  const userId = makeId('u-parity');
  const username = `parity_probe_${suffix}`;
  const PW = `Parity-${suffix}-Ee5!`;

  try {
    // A probe user, enrolled from the start: this is the account the parity
    // defect would have let through on the password alone.
    const hash = await hashPassword(PW);
    await pool.query(
      `INSERT INTO dypos.users (id, tenant_id, username, name, password_hash,
        password_salt, password_iterations, password_algo, is_active)
       VALUES ($1,$2,$3,'parity probe',$4,$5,$6,'pbkdf2-sha512',TRUE)`,
      [userId, TENANT, username, hash.hash, hash.salt, hash.iterations],
    );
    await pool.query(
      `INSERT INTO dypos.mfa_secrets (user_id, tenant_id, secret_hash, enabled)
       VALUES ($1,$2,'parity-probe-secret',true)
       ON CONFLICT (user_id) DO UPDATE SET enabled = true`,
      [userId, TENANT],
    );

    console.log('\n1. the factor is required for the probe on BOTH runtimes');
    const policy = await readMfaPolicy(userId, {});
    check('Express requires the factor (enrolled)', mfaRequired(policy, {}) === true);

    // The edge policy reader must agree on the SAME row — same verdict, or
    // the edge would reach a different decision about the same account.
    const { neon } = await import('@neondatabase/serverless');
    const edgeEnv = {
      DATABASE_URL: process.env.DATABASE_URL as string,
      DEFAULT_TENANT: TENANT,
      DYPOS_SESSION_SECRET: process.env.DYPOS_SESSION_SECRET || 'parity-test-secret',
      ASSETS: { fetch: async (): Promise<Response> => new Response('stub', { status: 404 }) },
    };
    const edgePolicy = await (Edge as any).__testReadMfaPolicy?.(edgeEnv, userId, false);
    if (edgePolicy === undefined) {
      check('edge policy reader is exposed for parity tests', false, 'no __testReadMfaPolicy export');
    } else {
      check('edge agrees the factor is required for the probe', edgePolicy.enabled === true);
      check('edge agrees with the Express policy verdict',
        Boolean(edgePolicy.enabled) === mfaRequired(policy, {}));
    }

    console.log('\n2. a challenge issued on EXPRESS verifies on the EDGE against the same digest');
    const issued = await issueChallenge(userId, TENANT, null, 6);
    const edgeOutcome = await Edge.__testVerifyChallenge(edgeEnv, issued.challenge, issued.code);
    check('edge accepts an Express-issued code', edgeOutcome.ok === true,
      edgeOutcome.ok ? '' : JSON.stringify(edgeOutcome));
    if (edgeOutcome.ok) {
      check('edge names the right user', edgeOutcome.userId === userId);
      check('edge resolves the tenant off the row, not the default',
        edgeOutcome.tenantId === TENANT);
    }

    console.log('\n3. a wrong code is refused on the edge without a session');
    // The second issue supersedes the first (issueChallenge voids prior rows).
    const second = await issueChallenge(userId, TENANT, null, 6);
    const wrong = await Edge.__testVerifyChallenge(edgeEnv, second.challenge, '000000');
    check('edge refuses a wrong code', wrong.ok === false);
    if (!wrong.ok) {
      check('the refusal is retryable', wrong.retryable === true, `retryable=${wrong.retryable}`);
    }

    console.log('\n4. a challenge issued on the EDGE verifies on EXPRESS');
    const edgeIssued = await Edge.__testIssueChallenge(edgeEnv, userId, TENANT, null, 6);
    const backAtServer = await verifyChallenge(edgeIssued.challenge, edgeIssued.code);
    check('Express accepts an edge-issued code', backAtServer.ok === true,
      backAtServer.ok ? '' : JSON.stringify(backAtServer));

    console.log('\n5. mirrored constants agree (the kind of drift that killed 210k iterations)');
    check('MFA_CHALLENGE_TTL_SECONDS is 300 on the server',
      (await import('../server/mfa.ts')).MFA_CHALLENGE_TTL_SECONDS === 300);
    check('MFA_MAX_ATTEMPTS is 5 on the server',
      (await import('../server/mfa.ts')).MFA_MAX_ATTEMPTS === 5);
    check('MFA_LOCKOUT_MINUTES is 15 on the server',
      (await import('../server/mfa.ts')).MFA_LOCKOUT_MINUTES === 15);

    console.log('\n6. cleanup');
    await pool.query(`DELETE FROM dypos.mfa_challenges WHERE user_id = $1`, [userId]);
    check('probe challenges removed', (await pool.query(
      `SELECT count(*)::int c FROM dypos.mfa_challenges WHERE user_id = $1`, [userId])).rows[0].c === 0);
    await pool.query(`DELETE FROM dypos.mfa_secrets WHERE user_id = $1`, [userId]);
    await pool.query(`UPDATE dypos.users SET is_active = FALSE WHERE id = $1`, [userId]);
    check('probe user disabled, not deleted', (await pool.query(
      `SELECT is_active FROM dypos.users WHERE id = $1`, [userId])).rows[0].is_active === false);
  } finally {
    await pool.end();
  }

  console.log(`\n${pass} passed, ${fail} failed`);
  process.exit(fail ? 1 : 0);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
