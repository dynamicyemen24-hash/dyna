/*
 * Fact-check for the accounting column gap.
 *
 * The boot path omits the pack's ledger view and `account_balance()` because
 * `journal_entries` has no `entry_date`/`entry_no`. A comment in `neonDb.ts`
 * once claimed that made the gap "a real missing feature", because the project
 * reports a trial balance from those columns.
 *
 * It does not. `/api/accounting/balances` reads `dypos.ledger` — a different
 * table, with `account_code`/`debit`/`credit`/`created_at`. So the question is
 * settled by what actually holds data, and this asserts it rather than trusting
 * the grep.
 */
import dotenv from 'dotenv';
import { PG_SSL } from '../server/neonDb.ts';
import pg from 'pg';

dotenv.config();
const pool = new pg.Pool({ connectionString: process.env.DATABASE_URL, ssl: PG_SSL, max: 1 });

const { rows } = await pool.query(`
  SELECT
    (SELECT count(*)::int FROM dypos.ledger)                                   AS ledger_rows,
    (SELECT count(*)::int FROM dypos.journal_entries)                          AS journal_entries_rows,
    (SELECT count(*)::int FROM dypos.journal_lines)                            AS journal_lines_rows,
    (SELECT count(*)::int FROM dypos.chart_of_accounts)                         AS coa_rows,
    (SELECT to_regclass('dypos.v_general_ledger') IS NOT NULL)                AS has_ledger_view,
    (SELECT to_regclass('dypos.v_trial_balance') IS NOT NULL)                 AS has_trial_balance_view,
    (SELECT to_regproc('dypos.account_balance') IS NOT NULL)                   AS has_account_balance_fn
`);

console.log(JSON.stringify(rows[0], null, 2));

// The balancing route reads ledger. If ledger holds rows, that is the live
// source of truth and the omitted views are genuinely unused by this product.
const drift = await pool.query(`
  SELECT
    COALESCE(SUM(debit),0) AS d,
    COALESCE(SUM(credit),0) AS c
  FROM dypos.ledger
`);
console.log(`\n  ledger totals: debit=${drift.rows[0].d} credit=${drift.rows[0].c}`);
const diff = Math.abs(Number(drift.rows[0].d) - Number(drift.rows[0].c));
console.log(`  balanced: ${diff < 0.01 ? 'YES' : `NO (difference ${diff})`}`);

await pool.end();