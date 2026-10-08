import { pool } from '../server/neonDb.ts';
import { hashPassword } from '../server/passwords.ts';

async function run() {
  const p1 = await hashPassword('admin123');
  await pool.query(
    `UPDATE dypos.users SET password_hash=$1, password_salt=$2, password_iterations=$3, password_algo=$4, is_active=true, must_change_password=false WHERE username='admin' AND tenant_id='royal-global-hq'`,
    [p1.hash, p1.salt, p1.iterations, p1.algo]
  );

  const p2 = await hashPassword('cashier123');
  await pool.query(
    `UPDATE dypos.users SET password_hash=$1, password_salt=$2, password_iterations=$3, password_algo=$4, is_active=true, must_change_password=false WHERE (username='cashier' OR username='cashier1') AND tenant_id='royal-global-hq'`,
    [p2.hash, p2.salt, p2.iterations, p2.algo]
  );

  const p3 = await hashPassword('manager123');
  await pool.query(
    `UPDATE dypos.users SET password_hash=$1, password_salt=$2, password_iterations=$3, password_algo=$4, is_active=true, must_change_password=false WHERE (username='manager' OR username='abdulrahman') AND tenant_id='royal-global-hq'`,
    [p3.hash, p3.salt, p3.iterations, p3.algo]
  );

  console.log('Successfully seeded demo users (admin, cashier, manager) with standard passwords.');
  process.exit(0);
}

run().catch(err => {
  console.error('Seed demo users error:', err);
  process.exit(1);
});
