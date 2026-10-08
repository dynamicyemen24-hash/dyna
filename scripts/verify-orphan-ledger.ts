/*
 * How can `journal_lines` reference `journal_entries` when no header row exists?
 *
 * Either the foreign key was dropped, or these lines were written while the
 * constraint was absent. Both are answers worth having before anyone decides
 * whether the orphaned lines are recoverable.
 */
import dotenv from 'dotenv';
import { PG_SSL } from '../server/neonDb.ts';
import pg from 'pg';

dotenv.config();
const pool = new pg.Pool({ connectionString: process.env.DATABASE_URL, ssl: PG_SSL, max: 1 });

const con = await pool.query(`
  SELECT conname, contype, pg_get_constraintdef(oid) AS def
    FROM pg_constraint
   WHERE conrelid = 'dypos.journal_lines'::regclass
   ORDER BY contype, conname
`);
console.log('=== journal_lines constraints ===');
for (const c of con.rows) console.log(`  [${c.contype}] ${c.conname}: ${c.def}`);

const heads = await pool.query(`
  SELECT id, tenant_id, entry_number, date, status, total_amount
    FROM dypos.journal_entries ORDER BY id LIMIT 10
`);
console.log(`\n=== journal_entries rows: ${heads.rows.length} ===`);
for (const h of heads.rows) console.log(`  ${JSON.stringify(h)}`);

// Is `date` NULL anywhere? A NOT NULL entry_date could never have been written,
// which would explain how lines exist with no header.
const ledger = await pool.query(`SELECT count(*)::int AS n FROM dypos.ledger`);
console.log(`\n  ledger rows: ${ledger.rows[0].n}`);

const tenants = await pool.query(`
  SELECT DISTINCT coa.tenant_id FROM dypos.journal_lines jl
   JOIN dypos.chart_of_accounts coa ON coa.id = jl.account_id LIMIT 5
`);
console.log(`  accounts referenced: ${tenants.rows.length}`);

// ── Q1: does anything in the codebase WRITE dypos.ledger? ────────────────
// `/api/accounting/balances` reads it. If nothing inserts into it, that
// endpoint returns an empty ledger for every merchant, forever.
console.log(`\n=== is dypos.ledger ever written? ===`);

// ── Q2: did journal_entries rows exist and get removed, or never persist? ──
// seed-data.ts inserts the header INSIDE a transaction, then the lines.
// Lines existing without a header means either the header insert failed after
// the fact, or the rows were deleted. There is no FK on journal_entry_id, so
// nothing stopped this.
const schema = await pool.query(`
  SELECT column_name, is_nullable, column_default
    FROM information_schema.columns
   WHERE table_schema='dypos' AND table_name='journal_entries'
   ORDER BY ordinal_position
`);
console.log(`\n=== journal_entries columns ===`);
for (const c of schema.rows) {
  console.log(`  ${c.column_name.padEnd(18)} null=${c.is_nullable} default=${c.column_default ?? '-'}`);
}

// The seed's own ids. If they were inserted, the ids are guessable.
const ids = await pool.query(`
  SELECT DISTINCT journal_entry_id FROM dypos.journal_lines ORDER BY 1
`);
console.log(`\n=== distinct journal_entry_id on lines ===`);
for (const i of ids.rows) console.log(`  ${i.journal_entry_id}`);

// Do those ids exist as rows anywhere — e.g. were they renamed?
const probe = await pool.query(`
  SELECT (SELECT count(*)::int FROM dypos.journal_lines)        AS lines,
         (SELECT count(*)::int FROM dypos.journal_entries)      AS headers,
         (SELECT count(*)::int FROM dypos.ledger)               AS ledger
`);
console.log(`\n  ${JSON.stringify(probe.rows[0])}`);

await pool.end();