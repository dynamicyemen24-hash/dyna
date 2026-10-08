/*
 * Post-boot fact-check: which optional pack objects exist in the live database,
 * and does the failing-statement set target anything real?
 *
 * Every failing statement in the boot log is an index or a view over a table or
 * column that does not exist. That is only harmless if the target is genuinely
 * unused — which is a claim about the CODE, so this reads the database and says
 * which of those objects are real.
 */
import dotenv from 'dotenv';
import { PG_SSL } from '../server/neonDb.ts';
import pg from 'pg';

dotenv.config();
const pool = new pg.Pool({ connectionString: process.env.DATABASE_URL, ssl: PG_SSL, max: 1 });

const NAMES = [
  'payments', 'sync_log', 'webhook_outbox', 'integration_runs', 'schema_version',
  'unit_conversions', 'uom_conversions', 'v_general_ledger',
  'mv_daily_accounting_summary', 'schema_migrations',
];

const { rows } = await pool.query(
  `SELECT n AS name, to_regclass('dypos.' || n) IS NOT NULL AS present
     FROM unnest($1::text[]) AS n`,
  [NAMES],
);

for (const r of rows) {
  console.log(`  ${r.present ? 'EXISTS ' : 'MISSING'}  ${r.name}`);
}

const cols = await pool.query(
  `SELECT column_name FROM information_schema.columns
    WHERE table_schema='dypos' AND table_name='journal_entries'
    ORDER BY ordinal_position`,
);
console.log(`\n  journal_entries: ${cols.rows.map((r: any) => r.column_name).join(', ')}`);

const idx = await pool.query(
  `SELECT indexname FROM pg_indexes
    WHERE schemaname='dypos' AND (indexname LIKE 'idx_journal%' OR indexname LIKE 'idx_promotions%')
    ORDER BY indexname`,
);
console.log(`  existing indexes: ${idx.rows.map((r: any) => r.indexname).join(', ') || '(none)'}`);

await pool.end();