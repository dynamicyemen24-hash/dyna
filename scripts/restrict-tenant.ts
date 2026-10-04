import dotenv from 'dotenv';
import { createHash } from 'crypto';
import pg from 'pg';

dotenv.config();
const pool = new pg.Pool({
  connectionString: process.env.DATABASE_URL,
  ssl: { rejectUnauthorized: false },
  max: 1,
});

const TENANT = 'royal-global-hq';
const sha = (v: string) => createHash('sha256').update(v, 'utf8').digest('hex');
const PASSWORD = sha('Royal@2026');

/**
 * Subscriber #1 only: exactly two operator accounts, every other row in the
 * dypos schema is pointed at royal-global-hq so nothing leaks across tenants.
 */
async function main() {
  await pool.query('BEGIN');

  // 1) Operator accounts — yacoub (owner) and abdulrahman (manager).
  const accounts = [
    { username: 'yacoub', name: 'يعقوب يوسف سهل', role: 'owner', branch: 'rg-branch-hq' },
    { username: 'abdulrahman', name: 'عبدالرحمن الملحاني', role: 'manager', branch: 'rg-branch-hq' },
  ];

  for (const a of accounts) {
    await pool.query(
      `INSERT INTO dypos.users (id, tenant_id, branch_id, username, password_hash, name, role, is_active)
       VALUES ($1,$2,$3,$4,$5,$6,$7,TRUE)
       ON CONFLICT (username) DO UPDATE
         SET name = EXCLUDED.name,
             role = EXCLUDED.role,
             password_hash = EXCLUDED.password_hash,
             branch_id = EXCLUDED.branch_id,
             tenant_id = EXCLUDED.tenant_id,
             is_active = TRUE`,
      [`usr-${a.username}`, TENANT, a.branch, a.username, PASSWORD, a.name, a.role],
    );
  }

  // 2) Every other account is retired so only the two operators can sign in.
  const retired = await pool.query(
    `UPDATE dypos.users SET is_active = FALSE
     WHERE tenant_id = $1 AND username <> ALL($2)
     RETURNING username`,
    [TENANT, accounts.map((a) => a.username)],
  );
  console.log('retired accounts:', retired.rows.map((r) => r.username).join(', ') || 'none');

  // 3) Collapse the stray second tenant into subscriber #1.
  for (const table of [
    'invoice_items', 'invoices', 'products', 'customers', 'suppliers',
    'branches', 'employees', 'stock_movements', 'purchase_orders',
    'accounting_entries', 'attendance', 'shifts', 'pos_sessions',
  ]) {
    try {
      await pool.query(
        `UPDATE dypos.${table} SET tenant_id = $1 WHERE tenant_id <> $1`,
        [TENANT],
      );
    } catch {
      // Table not present in this deployment — nothing to consolidate.
    }
  }
  const strays = await pool.query(
    `SELECT DISTINCT tenant_id FROM dypos.invoices
     WHERE tenant_id <> $1`,
    [TENANT],
  );
  console.log('remaining tenants in invoices:', strays.rows.length);

  await pool.query('COMMIT');

  // 4) Verification.
  const users = await pool.query(
    `SELECT username, name, role, is_active FROM dypos.users
     WHERE tenant_id = $1 ORDER BY username`,
    [TENANT],
  );
  console.table(users.rows);
  await pool.end();
}

main().catch(async (e) => {
  console.error('FAILED:', e.message);
  await pool.query('ROLLBACK').catch(() => {});
  await pool.end();
  process.exit(1);
});