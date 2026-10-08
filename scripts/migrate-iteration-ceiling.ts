/**
 * Re-issue credentials that the EDGE RUNTIME CANNOT RUN.
 *
 * Run:  npx tsx scripts/migrate-iteration-ceiling.ts
 *
 * ══ WHY THIS EXISTS ════════════════════════════════════════════════════════
 * Measured on the deployed Worker:
 *
 *     100,000 iterations -> 200
 *     210,000 iterations -> 500  "Pbkdf2 failed: iteration counts above
 *                                  100000 are not supported"
 *
 * Cloudflare's Web Crypto THROWS on PBKDF2 above 100,000. It does not clamp,
 * and it does not return a wrong answer — so a row stored at 210,000 is not
 * "slow to verify", it is PERMANENTLY UNVERIFIABLE in production.
 *
 * Every credential in this database was written at 210,000, which is why
 * nobody could sign in. Lowering the constant in code fixes every future
 * write; it cannot fix a stored hash, because PBKDF2 is not re-derivable
 * without the plaintext password, which the database does not hold.
 *
 * So the rows must be re-issued. That is not a migration in the usual sense —
 * nothing can be transformed — it is a credential reset, and it is the only
 * honest option.
 *
 * ══ WHAT IT DOES NOT DO ═══════════════════════════════════════════════════
 * It does not guess, and it does not weaken anything. Each affected account is
 * issued a NEW random password at the portable cost, marked
 * must_change_password = TRUE so the real one is captured at first sign-in, and
 * the generated value is printed ONCE for the operator to hand over. There is
 * no default password and no silent downgrade.
 *
 * Accounts already at a portable cost are left completely untouched.
 */
import dotenv from 'dotenv';
import { PG_SSL } from '../server/neonDb.ts';
import pg from 'pg';
import crypto from 'crypto';
import { hashPassword, ALGO, EDGE_MAX_ITERATIONS } from '../server/passwords.ts';

dotenv.config();

const pool = new pg.Pool({
  connectionString: process.env.DATABASE_URL,
  ssl: PG_SSL,
  max: 1,
  connectionTimeoutMillis: 20_000,
});

/**
 * 20 characters from an alphabet with no ambiguous glyphs.
 *
 * Ambiguity is not cosmetic here: this value is transcribed from a terminal
 * into a password manager by a person, so `l`/`1` and `O`/`0` are a real
 * source of support calls.
 */
function generatePassword(): string {
  const alphabet = 'ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz23456789';
  return Array.from(
    { length: 20 }, () => alphabet[crypto.randomInt(alphabet.length)],
  ).join('');
}

async function main() {
  const affected = await pool.query(
    `SELECT id, tenant_id, username, password_iterations, is_active
       FROM dypos.users
      WHERE password_hash IS NOT NULL
        AND password_salt IS NOT NULL
        AND password_iterations > $1
      ORDER BY tenant_id, username`,
    [EDGE_MAX_ITERATIONS],
  );

  const alreadyFine = await pool.query(
    `SELECT count(*)::int AS n FROM dypos.users
      WHERE password_hash IS NOT NULL AND password_salt IS NOT NULL
        AND password_iterations <= $1`,
    [EDGE_MAX_ITERATIONS],
  );

  console.log(`\nEdge ceiling: ${EDGE_MAX_ITERATIONS} iterations`);
  console.log(`Already portable: ${alreadyFine.rows[0].n}`);
  console.log(`Unverifiable on the edge: ${affected.rows.length}\n`);

  if (!affected.rows.length) {
    console.log('Nothing to re-issue — every stored credential runs on the edge.\n');
    await pool.end();
    return;
  }

  console.log('1. removing throwaway probe accounts that are also above the ceiling');

  const probes = await pool.query(
    `DELETE FROM dypos.users
      WHERE id IN (
        SELECT id FROM dypos.users
         WHERE password_iterations > $1
           AND (username LIKE 'mfa\_probe\_%'
                OR username LIKE 'unlock\_probe\_%'
                OR username LIKE 'probe\_%')
      )
      RETURNING username`,
    [EDGE_MAX_ITERATIONS],
  );
  if (probes.rows.length) {
    console.log(`  removed ${probes.rows.length} throwaway probe account(s) that `
      + `would otherwise be reset and handed out as real logins: `
      + probes.rows.map((p) => p.username).join(', '));
  }

  console.log('\n2. re-issuing every remaining credential the edge cannot run');
  const sheet: string[] = [];

  for (const u of affected.rows) {
    // Re-read after the probe delete: a row removed above must not be reset,
    // and a concurrent rotation must not be clobbered.
    const still = await pool.query(
      `SELECT id, username, tenant_id, password_iterations FROM dypos.users
        WHERE id = $1 AND password_iterations > $2`,
      [u.id, EDGE_MAX_ITERATIONS],
    );
    if (!still.rows.length) continue;
    const row = still.rows[0];

    const password = generatePassword();
    const fresh = await hashPassword(password, EDGE_MAX_ITERATIONS);

    await pool.query(
      `UPDATE dypos.users
          SET password_hash = $2,
              password_salt = $3,
              password_iterations = $4,
              password_algo = $5,
              password_updated_at = NOW(),
              -- The temporary value must never be a resting state.
              must_change_password = TRUE,
              failed_attempts = 0,
              locked_until = NULL,
              reset_token_hash = NULL,
              reset_token_expires = NULL
        WHERE id = $1`,
      [row.id, fresh.hash, fresh.salt, fresh.iterations, ALGO],
    );

    sheet.push(
      `  ${row.tenant_id.padEnd(18)} ${row.username.padEnd(14)} `
      + `was ${row.password_iterations} -> ${fresh.iterations}   ${password}`,
    );
    console.log(`  re-issued ${row.username} (${row.tenant_id}) at ${fresh.iterations}`);
  }

  console.log('\n3. verifying every stored cost is now runnable on the edge');
  // A migration that reports success without proving the property it exists to
  // establish is the failure mode this project keeps hitting, so this is a
  // real query against the table afterwards rather than a belief.
  const stillBad = await pool.query(
    `SELECT count(*)::int AS n FROM dypos.users
      WHERE password_hash IS NOT NULL AND password_salt IS NOT NULL
        AND password_iterations > $1`,
    [EDGE_MAX_ITERATIONS],
  );

  if (stillBad.rows[0].n !== 0) {
    console.error(`\n✘ ${stillBad.rows[0].n} credential(s) are still above the ceiling.`);
    await pool.end();
    process.exit(1);
  }

  console.log('\n✔ every stored credential is now within the edge ceiling\n');
  if (sheet.length) {
    console.log('TEMPORARY PASSWORDS — shown once, never stored:');
    console.log(sheet.join('\n'));
    console.log(
      '\nEach account must change this at first sign-in (must_change_password is on).\n',
    );
  }

  await pool.end();
}

main().catch(async (e) => {
  console.error('migration failed:', e?.message ?? e);
  await pool.end().catch(() => {});
  process.exit(1);
});