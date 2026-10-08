// check-leftovers.ts — verify the throwaway probe users were cleaned up.
import pg from 'pg';
import dotenv from 'dotenv';
dotenv.config();

const pool = new pg.Pool({
  connectionString: process.env.DATABASE_URL,
  ssl: { rejectUnauthorized: false },
  max: 1,
});

async function main() {
  const { rows } = await pool.query(
    "SELECT id, username FROM dypos.users WHERE username LIKE 'edge500%'"
  );
  console.log('LEFTOVER_ROWS: ' + rows.length);
  for (const u of rows) console.log('  ' + u.id + ' | ' + u.username);
  await pool.end();
  process.exit(rows.length === 0 ? 0 : 1);
}

main().catch((e) => {
  console.log('FATAL: ' + (e.message ?? e));
  process.exit(1);
});
