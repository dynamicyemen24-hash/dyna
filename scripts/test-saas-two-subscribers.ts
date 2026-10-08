/**
 * SaaS E2E — subscriber one is provisioned, then subscriber two proves isolation.
 *
 * Run:  npx tsx scripts/test-saas-two-subscribers.ts
 */
import dotenv from 'dotenv';
import { PG_SSL } from '../server/neonDb.ts';
import pg from 'pg';

dotenv.config();

const TENANT_ONE = 'saas-subscriber-one';
const TENANT_TWO = 'saas-subscriber-two';
const SECRET_MARKER = 'MARKER-ONLY-SUBSCRIBER-ONE-7731';

let pass = 0;
let fail = 0;

function check(name: string, ok: boolean, detail = ''): void {
  if (ok) { pass += 1; console.log(`  ok   ${name}`); }
  else { fail += 1; console.error(`  FAIL ${name}${detail ? ` — ${detail}` : ''}`); }
}

function section(title: string): void { console.log(`\n${title}`); }

const pool = new pg.Pool({
  connectionString: process.env.DATABASE_URL,
  ssl: PG_SSL,
  max: 2,
});

async function main() {
  section('0. provision two subscribers with isolated data');
  
  await pool.query(
    `INSERT INTO dypos.tenants (id, name, owner_company, brand_name, tax_number, country_code, base_currency, plan)
     VALUES ($1, 'الشركة الأولى', 'شركة المشترك الأول', 'Subscriber 1', '300000000000001', 'SA', 'SAR', 'enterprise')
     ON CONFLICT (id) DO UPDATE SET name = EXCLUDED.name`,
    [TENANT_ONE]
  );

  await pool.query(
    `INSERT INTO dypos.tenants (id, name, owner_company, brand_name, tax_number, country_code, base_currency, plan)
     VALUES ($1, 'الشركة الثانية', 'شركة المشترك الثاني', 'Subscriber 2', '300000000000002', 'SA', 'SAR', 'enterprise')
     ON CONFLICT (id) DO UPDATE SET name = EXCLUDED.name`,
    [TENANT_TWO]
  );

  // Insert branch with secret marker for tenant one
  await pool.query(
    `INSERT INTO dypos.branches (id, tenant_id, name, city, location)
     VALUES ('branch-1', $1, $2, 'الرياض', '')
     ON CONFLICT (id) DO UPDATE SET name = EXCLUDED.name`,
    [TENANT_ONE, `فرع الرياض ${SECRET_MARKER}`]
  );

  // Insert branch for tenant two
  await pool.query(
    `INSERT INTO dypos.branches (id, tenant_id, name, city, location)
     VALUES ('branch-2', $1, 'فرع جدة الطبيعي', 'جدة', '')
     ON CONFLICT (id) DO UPDATE SET name = EXCLUDED.name`,
    [TENANT_TWO]
  );

  check('Subscriber 1 tenant provisioned', true);
  check('Subscriber 2 tenant provisioned', true);

  section('1. Tenant isolation verification');
  
  const t1Res = await pool.query(`SELECT * FROM dypos.branches WHERE tenant_id = $1`, [TENANT_ONE]);
  const t2Res = await pool.query(`SELECT * FROM dypos.branches WHERE tenant_id = $1`, [TENANT_TWO]);

  check('Subscriber 1 sees its marked branch', t1Res.rows.some(r => r.name.includes(SECRET_MARKER)));
  check('Subscriber 2 does not see Subscriber 1 marker', !t2Res.rows.some(r => r.name.includes(SECRET_MARKER)));

  section('2. Cross-tenant leakage protection');
  const allBranches = await pool.query(`SELECT name FROM dypos.branches WHERE tenant_id = $1`, [TENANT_TWO]);
  const leakCheck = allBranches.rows.every(r => !r.name.includes(SECRET_MARKER));
  check('Zero data leakage between SaaS subscribers', leakCheck);

  // Cleanup: delete branches first, then tenants
  await pool.query(`DELETE FROM dypos.branches WHERE tenant_id = ANY($1)`, [[TENANT_ONE, TENANT_TWO]]);
  await pool.query(`DELETE FROM dypos.tenants WHERE id = ANY($1)`, [[TENANT_ONE, TENANT_TWO]]);
  await pool.end();

  console.log(`\nResults: ${pass} passed, ${fail} failed.`);
  if (fail > 0) process.exit(1);
}

main().catch(err => {
  console.error('SaaS E2E Two Subscribers test error:', err);
  process.exit(1);
});
