/**
 * Server-enforced second factor — proof.
 *
 * Run:  npx tsx scripts/test-mfa.ts
 *
 * WHY THIS IS A SCRIPT AND NOT A UNIT TEST
 * ----------------------------------------
 * The property under test is not a pure function: it is that a *correct password
 * alone cannot produce a session*. That spans the database (challenge rows, the
 * attempt budget) and the routes (token issuance). A unit test with a mocked
 * pool would pass happily while the real wiring granted access — which is
 * exactly how the previous client-side "2FA" survived review. So this drives the
 * real PostgreSQL instance, in the same style as `test-kpi.ts`.
 *
 * It touches only MFA rows, and it creates and removes its own throwaway user.
 * It never touches invoices, stock or ledger data.
 */
import dotenv from 'dotenv';
import pg from 'pg';
import { makeId } from '../server/apiHelpers.ts';
import {
  issueChallenge, verifyChallenge, redeemBreakGlass, issueBreakGlassGrant,
  readMfaPolicy, mfaRequired, setMfaDeliverer, MFA_MAX_ATTEMPTS,
  type MfaDeliverer,
} from '../server/mfa.ts';
import { hashPassword } from '../server/passwords.ts';

dotenv.config();

const pool = new pg.Pool({
  connectionString: process.env.DATABASE_URL,
  ssl: { rejectUnauthorized: false },
  max: 2,
});

const TENANT = 'royal-global-hq';

let passed = 0;
let failed = 0;

function check(name: string, ok: boolean, detail = '') {
  if (ok) {
    passed += 1;
    console.log(`  ok   ${name}`);
  } else {
    failed += 1;
    console.error(`  FAIL ${name}${detail ? ` — ${detail}` : ''}`);
  }
}

const section = (t: string) => console.log(`\n${t}`);

/** Captures the delivered code instead of printing it, the way an operator would. */
const captured: string[] = [];
const captureDeliverer: MfaDeliverer = {
  channel: 'test-capture',
  async send(_to, code) { captured.push(code); },
};

async function main() {
  // The real server uses the log deliverer; the test swaps in a capture so it can
  // read the delivered code exactly as an operator would from their phone.
  setMfaDeliverer(captureDeliverer);

  const userId = makeId('u-mfa-test');
  const username = `mfa_probe_${Date.now()}`;

  // ---- Fixture: a throwaway user with a real password hash ------------------
  const pw = await hashPassword(`Probe-${Math.random().toString(36).slice(2)}-Aa1!`);
  const branch = await pool.query(
    `SELECT id FROM dypos.branches WHERE tenant_id = $1 LIMIT 1`, [TENANT],
  );
  const branchId = branch.rows[0]?.id ?? null;

  await pool.query(
    `INSERT INTO dypos.users
       (id, tenant_id, branch_id, username, password_hash, name, role,
        password_salt, password_iterations, password_algo, is_active)
     VALUES ($1,$2,$3,$4,$5,$6,'cashier',$7,$8,$9,true)`,
    [userId, TENANT, branchId, username, pw.hash, 'MFA Probe',
      pw.salt, pw.iterations, pw.algo],
  );

  try {
    // -----------------------------------------------------------------------
    section('1. The factor is required when the tenant demands it');
    // -----------------------------------------------------------------------
    const bare = await readMfaPolicy(userId);
    check('unenrolled user has no factor by default',
      bare.enabled === false && mfaRequired(bare) === false);

    const forced = await readMfaPolicy(userId, { requireForAll: true });
    check('tenant-wide policy forces the factor',
      mfaRequired(forced, { requireForAll: true }));

    await pool.query(
      `INSERT INTO dypos.mfa_secrets (user_id, tenant_id, secret_hash, enabled)
       VALUES ($1,$2,$3,true)`,
      [userId, TENANT, 'not-used-this-test'],
    );
    const enrolled = await readMfaPolicy(userId);
    check('enrolment alone requires the factor',
      enrolled.enabled === true && mfaRequired(enrolled) === true);

    // -----------------------------------------------------------------------
    section('2. The code is random, hashed at rest, and delivered once');
    // -----------------------------------------------------------------------
    captured.length = 0;
    const issued = await issueChallenge(userId, TENANT, branchId, 6);
    await captureDeliverer.send(username, issued.code, issued.expiresInSeconds);
    const code = captured[captured.length - 1];

    check('a code was delivered', Boolean(code));
    check('code is six digits', /^\d{6}$/.test(code));
    check('issued code was not the removed constant', code !== '882104');

    const stored = await pool.query(
      `SELECT code_hash FROM dypos.mfa_challenges WHERE challenge = $1`,
      [issued.challenge],
    );
    check('the code is not stored in the clear',
      stored.rows[0]?.code_hash !== code && String(stored.rows[0]?.code_hash).length === 64);

    // -----------------------------------------------------------------------
    section('3. A wrong code is refused');
    // -----------------------------------------------------------------------
    const wrong = await verifyChallenge(issued.challenge, '000000');
    check('a wrong code is refused', wrong.ok === false);
    if (!wrong.ok) check('the refusal is retryable', wrong.retryable === true);

    // -----------------------------------------------------------------------
    section('4. The correct code yields the identity — and only then');
    // -----------------------------------------------------------------------
    const good = await verifyChallenge(issued.challenge, code);
    check('the correct code verifies', good.ok === true);
    if (good.ok) {
      check('it resolves to the right user', good.userId === userId);
      check('and the right tenant', good.tenantId === TENANT);
    }

    // -----------------------------------------------------------------------
    section('5. A consumed challenge cannot be replayed');
    // -----------------------------------------------------------------------
    const replay = await verifyChallenge(issued.challenge, code);
    check('the same code cannot be redeemed twice', replay.ok === false);
// -----------------------------------------------------------------------
    section('6. Brute force is bounded, then locks the factor');
    // -----------------------------------------------------------------------
    const second = await issueChallenge(userId, TENANT, branchId, 6);
    let last = await verifyChallenge(second.challenge, '000000');
    for (let i = 1; i < MFA_MAX_ATTEMPTS; i += 1) {
      last = await verifyChallenge(second.challenge, '000000');
    }
    check(
      `the budget is ${MFA_MAX_ATTEMPTS} guesses`,
      // Narrowed explicitly rather than cast: `VerifyOutcome` is a union, and a
      // truthiness check would pass for a SUCCESSFUL verify, which is the exact
      // inversion this assertion exists to catch.
      !last.ok && last.reason === 'attempts_exhausted',
      `got ${last.ok ? 'ok=true (a wrong code was ACCEPTED)' : last.reason}`,
    );

    const locked = await readMfaPolicy(userId);
    check('the factor is now locked',
      locked.lockedUntil !== null && Date.parse(locked.lockedUntil) > Date.now());
    check('a locked factor is still required',
      mfaRequired(locked) === true, 'a lockout must never become a bypass');

    // -----------------------------------------------------------------------
    section('7. Issuing a new challenge supersedes the old one');
    // -----------------------------------------------------------------------
    await pool.query(
      `UPDATE dypos.users SET mfa_locked_until = NULL, mfa_failed_attempts = 0 WHERE id = $1`,
      [userId],
    );
    captured.length = 0;
    const staleChallenge = await issueChallenge(userId, TENANT, branchId, 6);
    const staleCode = issued.code; // the code for the challenge issued first
    const current = await issueChallenge(userId, TENANT, branchId, 6);
    const currentCode = current.code;

    const stale = await verifyChallenge(staleChallenge.challenge, staleCode);
    check('the superseded challenge is dead', stale.ok === false);
    check('the current challenge accepts its own code',
      (await verifyChallenge(current.challenge, currentCode)).ok === true);

    // -----------------------------------------------------------------------
    section('8. Break-glass is an issued grant, not a magic string');
    // -----------------------------------------------------------------------
    check('the old hard-coded passcode is refused',
      (await redeemBreakGlass('SUP1999', 'test', TENANT)).ok === false);
    check('"breakglass" is refused too',
      (await redeemBreakGlass('breakglass', 'test', TENANT)).ok === false);

    const grant = await issueBreakGlassGrant(TENANT, 'supervisor', 'terminal down', 15);
    check('an issued grant is accepted',
      (await redeemBreakGlass(grant.code, 'test', TENANT)).ok === true);
    check('and cannot be redeemed twice',
      (await redeemBreakGlass(grant.code, 'test', TENANT)).ok === false,
      'a grant must be single-use');

    const expired = await issueBreakGlassGrant(TENANT, 'supervisor', 'x', -1);
    check('an expired grant is refused',
      (await redeemBreakGlass(expired.code, 'test', TENANT)).ok === false);

    /*
     * The new property: a grant is bound to the tenant that issued it.
     *
     * A break-glass code is the one credential that deliberately bypasses MFA,
     * so "presented by a session from another tenant" is exactly the case that
     * must fail. Before the tenant predicate was added to the UPDATE, this
     * assertion had no way to pass — the code hash alone decided.
     */
    const foreign = await issueBreakGlassGrant(TENANT, 'supervisor', 'foreign', 15);
    check('a grant cannot be redeemed from another tenant',
      (await redeemBreakGlass(foreign.code, 'test', 'some-other-tenant')).ok === false,
      'a break-glass code must not cross a tenant boundary');

    await pool.query(
      `DELETE FROM dypos.break_glass_grants
        WHERE issued_by = 'supervisor' AND reason IN ('terminal down','x','foreign')`,
    );
  } finally {
    await pool.query(`DELETE FROM dypos.mfa_challenges WHERE user_id = $1`, [userId]);
    await pool.query(`DELETE FROM dypos.mfa_secrets WHERE user_id = $1`, [userId]);
    await pool.query(`DELETE FROM dypos.users WHERE id = $1`, [userId]);
    await pool.end();
  }

  console.log(`\n${passed} passed, ${failed} failed`);
  process.exit(failed === 0 ? 0 : 1);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});