/**
 * Applies the numbered SQL migrations in `server/migrations` in order.
 *
 * Every file is written to be idempotent (CREATE ... IF NOT EXISTS, ADD COLUMN
 * IF NOT EXISTS) and each one is recorded in `dypos.applied_migrations`, so
 * running this repeatedly is safe and an interrupted run can be resumed.
 *
 *   npx tsx scripts/migrate.ts            # apply everything pending
 *   npx tsx scripts/migrate.ts --status   # list what is applied
 */
import dotenv from 'dotenv';
import { PG_SSL } from '../server/neonDb.ts';
import fs from 'fs';
import path from 'path';
import pg from 'pg';

dotenv.config();

const pool = new pg.Pool({
  connectionString: process.env.DATABASE_URL,
  ssl: PG_SSL,
  max: 1,
});

const MIGRATIONS_DIR = path.join(process.cwd(), 'server', 'migrations');

async function ensureLedger() {
  await pool.query(`
    CREATE TABLE IF NOT EXISTS dypos.applied_migrations (
      version    TEXT PRIMARY KEY,
      applied_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
    )`);
}

async function applied(): Promise<Set<string>> {
  const { rows } = await pool.query('SELECT version FROM dypos.applied_migrations');
  return new Set(rows.map((r) => r.version));
}

async function main() {
  await ensureLedger();

  const files = fs
    .readdirSync(MIGRATIONS_DIR)
    .filter((f) => f.endsWith('.sql'))
    .sort(); // v131_… < v132_… < v136_… lexicographically

  const done = await applied();
  const statusOnly = process.argv.includes('--status');

  console.log(`\nmigrations found: ${files.length}`);
  for (const f of files) {
    const state = done.has(f) ? 'applied' : 'PENDING';
    console.log(`  ${state.padEnd(8)} ${f}`);
  }
  if (statusOnly) {
    await pool.end();
    return;
  }

  let appliedCount = 0;
  for (const f of files) {
    if (done.has(f)) continue;
    const sql = fs.readFileSync(path.join(MIGRATIONS_DIR, f), 'utf8');
    try {
      await pool.query(sql);
      await pool.query(
        'INSERT INTO dypos.applied_migrations(version) VALUES ($1) ON CONFLICT DO NOTHING',
        [f],
      );
      console.log(`  ✔ applied ${f}`);
      appliedCount++;
    } catch (err: any) {
      console.error(`  ✖ FAILED ${f}: ${err.message}`);
      process.exitCode = 1;
      break; // stop so a broken migration is not papered over by later ones
    }
  }

  console.log(`\napplied ${appliedCount} migration(s)\n`);
  await pool.end();
}

main().catch(async (e) => {
  console.error(e);
  await pool.end().catch(() => {});
  process.exit(1);
});