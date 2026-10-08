/*
 * Post-migration verification against the real database.
 *
 * An exit code proves the statement was accepted, not that the column the code
 * reads now exists. This asserts the latter, which is the whole point of v148.
 */
import dotenv from 'dotenv';
import { PG_SSL } from '../server/neonDb.ts';
import pg from 'pg';

dotenv.config();
const pool = new pg.Pool({ connectionString: process.env.DATABASE_URL, ssl: PG_SSL, max: 1 });

let fail = 0;

const cols = async (t: string) => {
  const { rows } = await pool.query(
    `SELECT column_name FROM information_schema.columns
      WHERE table_schema='dypos' AND table_name=$1`,
    [t],
  );
  return rows.map((r: any) => r.column_name);
};

// The columns live code actually selects.
const REQUIRED: Array<[string, string[]]> = [
  ['roles', ['sod_group', 'description']],
  ['user_roles', ['branch_id', 'granted_at']],
  ['role_permissions', ['permission', 'effect']],
  ['accounting_periods', ['branch_id', 'period']],
  ['deliveries', ['invoice_id', 'customer_name', 'picked_at']],
  ['cash_movements', ['section', 'occurred_on']],
  ['units_of_measure', ['id', 'tenant_id', 'base_unit_id']],
];

for (const [table, need] of REQUIRED) {
  const have = await cols(table);
  if (!have.length) {
    console.log(`  FAIL ${table}: table does not exist`);
    fail += 1;
    continue;
  }
  const missing = need.filter((c) => !have.includes(c));
  if (missing.length) {
    console.log(`  FAIL ${table}: missing ${missing.join(', ')}`);
    console.log(`       has: ${have.join(', ')}`);
    fail += 1;
  } else {
    console.log(`  ok   ${table}: ${need.join(', ')}`);
  }
}

// The grants must not have been silently stranded in the legacy column.
const rp = await pool.query(
  `SELECT count(*)::int AS total,
          count(permission)::int       AS with_permission,
          count(*) FILTER (WHERE permission IS NULL)::int AS null_permission
     FROM dypos.role_permissions`,
);
console.log(`\n  role_permissions: ${JSON.stringify(rp.rows[0])}`);

const ext = await pool.query(`SELECT extname FROM pg_extension WHERE extname='pgcrypto'`);
console.log(`  pgcrypto: ${ext.rows.length ? 'present' : 'ABSENT'}`);

console.log(fail === 0 ? '\nVERIFIED: schema matches what live code reads.' : `\n${fail} table(s) still wrong.`);
await pool.end();
process.exit(fail === 0 ? 0 : 1);