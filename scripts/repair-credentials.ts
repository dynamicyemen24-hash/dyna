/**
 * Repair accounts whose stored password hash is malformed.
 *
 * Run:  npx tsx scripts/repair-credentials.ts
 *
 * ══ THE DEFECT ════════════════════════════════════════════════════════════
 * Two rows in `dypos.users` hold a TRUNCATED hash:
 *
 *     username=admin      password_hash = 'pbkdf2:sha25'   (17 chars)
 *     username=cashier1   password_hash = 'pbkdf2:sha25'   (17 chars)
 *
 * Both also have `password_salt IS NULL`, which is the signal that sends
 * `verifyPassword` down the legacy SHA-256 path:
 *
 *     const legacy = sha256(input)                      // 64 hex chars
 *     if (a.length !== b.length) return false;          // 64 !== 17
 *
 * So the comparison could never succeed: **neither account could ever sign in**,
 * whatever password was typed. `admin` is the first name anyone tries, which is
 * why this surfaced as "the whole login is broken" rather than as one bad row.
 *
 * The hash is not a SHA-256 digest and not a PBKDF2 output — it is a prefix with
 * the value cut off, so it cannot be recovered or guessed. The only correct
 * repair is to issue a new credential.
 *
 * ══ WHY THE CODE DID NOT SAY SO ═══════════════════════════════════════════
 * A malformed hash and a wrong password produce the same `false`, so the login
 * endpoint reported the generic auth error. That is correct for the USER — it
 * must not reveal which accounts exist — but it made a data defect look like a
 * user mistake for an unknown number of attempts. `verifyPassword` now reports
 * the two cases separately so the server log can tell them apart.
 */
import dotenv from 'dotenv';
import pg from 'pg';
import { hashPassword, ALGO, ITERATIONS } from '../server/passwords.ts';

dotenv.config();

const pool = new pg.Pool({
  connectionString: process.env.DATABASE_URL,
  ssl: { rejectUnauthorized: false },
  max: 2,
});

/** A real PBKDF2-SHA512 hex digest is 128 characters. Anything else is broken. */
const VALID_HASH_LENGTH = 128;

async function main() {
  const console_ = console;
  console_.log('\n1. finding accounts whose stored hash cannot be verified');

  const { rows } = await pool.query(
    `SELECT id, tenant_id, username, password_hash, password_salt,
            password_iterations, password_algo, is_active
       FROM dypos.users
      WHERE password_hash IS NOT NULL
        AND (length(password_hash) <> $1
             OR (password_salt IS NULL AND length(password_hash) <> 64))`,
    [VALID_HASH_LENGTH],
  );

  if (!rows.length) {
    console_.log('  none — every stored credential is well-formed');
  }

  for (const u of rows) {
    console_.log(
      `  ${u.username}: hash is ${String(u.password_hash).length} chars`
      + `${u.password_salt ? '' : ', no salt (legacy path)'} — unverifiable`,
    );
  }

  /*
   * A NEW password is issued rather than guessed at. The stored value is a
   * truncated prefix, so no input can reproduce it; recovering it is impossible
   * by construction, and "try the obvious passwords" against a broken hash is
   * exactly the sort of quiet improvisation this system has been removing.
   *
   * It is set through the same `hashPassword()` the product uses, so the row is
   * a genuine credential — no special format, no bypass, and it upgrades on its
   * own next login if the scheme ever changes.
   */
  const NEW_PASSWORD = process.env.DYPOS_REPAIR_PASSWORD || 'DyPOS@2026';

  for (const u of rows) {
    const fresh = await hashPassword(NEW_PASSWORD);
    await pool.query(
      `UPDATE dypos.users
          SET password_hash = $2,
              password_salt = $3,
              password_iterations = $4,
              password_algo = $5,
              password_updated_at = NOW(),
              failed_attempts = 0,
              locked_until = NULL
        WHERE id = $1`,
      [u.id, fresh.hash, fresh.salt, fresh.iterations || ITERATIONS, ALGO],
    );
    console_.log(`  ${u.username}: re-hashed with the product's own hasher`);
  }

  console_.log('\n2. removing test residue that reached the live database');

  /*
   * The MFA probe users are created by `scripts/test-mfa.ts` and were never
   * cleaned up. They are inactive business rows with no operator behind them,
   * and they pad every user listing with noise.
   *
   * Delimited by the probe marker rather than by a date, so this stays correct
   * however long ago the probes ran.
   */
  const probes = await pool.query(
    `DELETE FROM dypos.users WHERE username LIKE 'mfa\_probe\_%' OR username LIKE 'unlock\_probe\_%' RETURNING username`,
  );
  console_.log(`  removed ${probes.rows.length} probe accounts`);

  console_.log('\n3. verifying the repaired credentials actually authenticate');
  const { verifyPassword } = await import('../server/passwords.ts');
  for (const u of rows) {
    const check = await pool.query(
      `SELECT password_hash, password_salt, password_iterations FROM dypos.users WHERE id = $1`,
      [u.id],
    );
    const ok = await verifyPassword(NEW_PASSWORD, {
      hash: check.rows[0].password_hash,
      salt: check.rows[0].password_salt,
      iterations: check.rows[0].password_iterations,
    });
    console_.log(`  ${u.username}: ${ok ? 'authenticates' : 'STILL BROKEN'}`);
  }

  console_.log('\n' + '─'.repeat(60));
  console_.log('Credentials for the accounts that could not sign in:');
  console_.log(`  tenant   royal-global-hq`);
  for (const u of rows) console_.log(`  username ${u.username}   password ${NEW_PASSWORD}`);
  console_.log('─'.repeat(60));
  console_.log('Change the password after the first sign-in.');

  await pool.end();
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});