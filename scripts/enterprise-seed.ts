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

const TENANT = 'royal-global-hq';
const uid = (p: string, n: string) => `${p}-${n}`;

async function main() {
  // ---- Apply the schema -------------------------------------------------
  const sql = fs.readFileSync(
    path.join(process.cwd(), 'server', 'migrations', 'v132_enterprise_core.sql'),
    'utf8',
  );
  await pool.query(sql);
  console.log('✔ v132 schema applied');

  // ---- Reference data ---------------------------------------------------
  await pool.query(
    `UPDATE dypos.currencies SET is_base = (code = 'SAR'), country_code = 'SA', decimals = 2
     WHERE code IN ('SAR','USD','EUR','AED')`,
  );

  // Units of measure. Base unit of each dimension first, so conversions
  // always point at a stable reference.
  const uoms = [
    { code: 'EA',  name: 'قطعة',     dim: 'COUNT',  prec: 0 },
    { code: 'BOX', name: 'كرتون',    dim: 'COUNT',  prec: 0 },
    { code: 'PLT', name: 'منصة',     dim: 'COUNT',  prec: 0 },
    { code: 'KG',  name: 'كيلوجرام', dim: 'WEIGHT', prec: 3 },
    { code: 'GRM', name: 'جرام',     dim: 'WEIGHT', prec: 1 },
    { code: 'TON', name: 'طن',       dim: 'WEIGHT', prec: 3 },
    { code: 'L',   name: 'لتر',      dim: 'VOLUME', prec: 2 },
    { code: 'ML',  name: 'ملليلتر',  dim: 'VOLUME', prec: 1 },
    { code: 'M3',  name: 'متر مكعب', dim: 'VOLUME', prec: 3 },
    { code: 'M',   name: 'متر',      dim: 'LENGTH', prec: 2 },
    { code: 'CM',  name: 'سنتيمتر',  dim: 'LENGTH', prec: 1 },
  ];

  for (const u of uoms) {
    await pool.query(
      `INSERT INTO dypos.units_of_measure (id, tenant_id, code, name, dimension, precision, rounding, is_active)
       VALUES ($1,$2,$3,$4,$5,$6,$7,TRUE)
       ON CONFLICT (tenant_id, code) DO UPDATE
         SET name = EXCLUDED.name, dimension = EXCLUDED.dimension, precision = EXCLUDED.precision`,
      [uid('uom', u.code), TENANT, u.code, u.name, u.dim, u.prec, u.prec],
    );
  }

  const baseOf: Record<string, string> = { COUNT: 'EA', WEIGHT: 'KG', VOLUME: 'L', LENGTH: 'M' };
  for (const [dim, baseCode] of Object.entries(baseOf)) {
    await pool.query(
      `UPDATE dypos.units_of_measure u SET base_unit_id = b.id
       FROM dypos.units_of_measure b
       WHERE u.tenant_id = $1 AND u.dimension = $2 AND b.tenant_id = u.tenant_id AND b.code = $3`,
      [TENANT, dim, baseCode],
    );
  }
  console.log(`✔ ${uoms.length} units of measure`);

  // Conversions stored symmetrically so a lookup succeeds either direction.
  const conv: Array<[string, string, number, number]> = [
    ['BOX', 'EA', 24, 1],
    ['PLT', 'EA', 1200, 1],
    ['PLT', 'BOX', 50, 1],
    ['GRM', 'KG', 1, 1000],
    ['TON', 'KG', 1000, 1],
    ['ML', 'L', 1, 1000],
    ['M3', 'L', 1000, 1],
    ['CM', 'M', 1, 100],
  ];
  const writeConv = async (from: string, to: string, num: number, den: number) => {
    await pool.query(
      `INSERT INTO dypos.uom_conversions (id, tenant_id, from_unit_id, to_unit_id, numerator, denominator)
       SELECT $1, $2::varchar, f.id, t.id, $3::numeric, $4::numeric
       FROM dypos.units_of_measure f, dypos.units_of_measure t
       WHERE f.tenant_id = $2::varchar AND f.code = $5::varchar
         AND t.tenant_id = $2::varchar AND t.code = $6::varchar
       ON CONFLICT (tenant_id, from_unit_id, to_unit_id)
         DO UPDATE SET numerator = EXCLUDED.numerator, denominator = EXCLUDED.denominator`,
      [uid('uconv', `${from}_${to}`), TENANT, num, den, from, to],
    );
  };
  for (const [from, to, num, den] of conv) {
    await writeConv(from, to, num, den);
    await writeConv(to, from, den, num);
  }
  console.log(`✔ ${conv.length} conversion pairs (both directions)`);

  // Give every product a base UoM so stock totals stay meaningful.
  await pool.query(
    `UPDATE dypos.products p SET base_uom_id = u.id, purchase_uom_id = u.id, sales_uom_id = u.id
     FROM dypos.units_of_measure u
     WHERE u.tenant_id = p.tenant_id AND u.code = 'EA' AND p.base_uom_id IS NULL`,
  );

  await seedRoles();
  await seedAssignments();
  await seedPeriods();

  await pool.query(
    `UPDATE dypos.invoices SET base_total = total, base_subtotal = subtotal, base_tax = tax
     WHERE tenant_id = $1 AND base_total IS NULL`,
    [TENANT],
  );

  const v = await pool.query(
    `SELECT
       (SELECT count(*) FROM dypos.units_of_measure  WHERE tenant_id = $1) AS uoms,
       (SELECT count(*) FROM dypos.uom_conversions   WHERE tenant_id = $1) AS conversions,
       (SELECT count(*) FROM dypos.roles              WHERE tenant_id = $1) AS roles,
       (SELECT count(*) FROM dypos.role_permissions)                       AS grants,
       (SELECT count(*) FROM dypos.user_roles)                              AS user_roles,
       (SELECT count(*) FROM dypos.accounting_periods WHERE tenant_id = $1) AS periods,
       (SELECT count(*) FROM dypos.invoices WHERE tenant_id = $1 AND base_total IS NOT NULL) AS priced`,
    [TENANT],
  );
  console.table(v.rows[0]);
  await pool.end();
}

/**
 * Standard ERP job functions. `sod` records the segregation-of-duties group:
 * two roles in the same group may not be held by one user at the same time,
 * because together they would allow self-approval.
 */
async function seedRoles() {
  const roles = [
    { code: 'SYSTEM_ADMIN', name: 'مدير النظام', sod: null,
      desc: 'صلاحية كاملة على الإعدادات والأمان دون حواجز المحاسبة.',
      perms: ['*'] },
    { code: 'GENERAL_MANAGER', name: 'المدير العام', sod: 'APPROVAL',
      desc: 'اعتماد كامل للعمليات والتقارير وإغلاق الفترات.',
      perms: ['*'] },
    { code: 'ACCOUNTANT', name: 'محاسب', sod: 'FINANCE',
      desc: 'القيود والميزان والتقارير المالية — دون تعديل المخزون.',
      perms: ['ledger.view', 'ledger.post', 'ledger.reverse', 'period.close', 'period.reopen',
        'reports.view', 'currency.rate.manage', 'chart.accounts.manage',
        'purchase.view', 'purchase.approve', 'customer.view', 'supplier.view'] },
    { code: 'CASHIER', name: 'كاشير', sod: 'CASH',
      desc: 'بيع وإيراد يومي مع صلاحية خصم محدودة.',
      perms: ['sales.create', 'sales.discount', 'sales.return', 'customer.view',
        'customer.create', 'product.view', 'inventory.view',
        'cash.open_shift', 'cash.close_shift', 'reports.view'] },
    { code: 'INVENTORY_MANAGER', name: 'أمين المخزون', sod: 'STOCK',
      desc: 'الحركات المخزنية والتحويلات ودفعات الصلاحية.',
      perms: ['inventory.view', 'inventory.adjust', 'inventory.transfer', 'batch.view',
        'batch.manage', 'serial.view', 'product.view', 'product.manage',
        'purchase.create', 'supplier.view', 'reports.view'] },
    { code: 'SALES_MANAGER', name: 'مدير المبيعات', sod: 'APPROVAL',
      desc: 'التسعير والعروض والخصومات والمواعيد.',
      perms: ['sales.create', 'sales.void', 'sales.discount', 'sales.return',
        'customer.view', 'customer.create', 'customer.manage', 'price.list.manage',
        'promotion.manage', 'appointment.manage', 'reports.view', 'product.view'] },
  ];

  for (const r of roles) {
    const id = uid('role', r.code);
    await pool.query(
      `INSERT INTO dypos.roles (id, tenant_id, code, name, description, is_system, sod_group, is_active)
       VALUES ($1,$2,$3,$4,$5,TRUE,$6,TRUE)
       ON CONFLICT (tenant_id, code) DO UPDATE
         SET name = EXCLUDED.name, description = EXCLUDED.description, sod_group = EXCLUDED.sod_group`,
      [id, TENANT, r.code, r.name, r.desc, r.sod],
    );
    for (const p of r.perms) {
      await pool.query(
        `INSERT INTO dypos.role_permissions (role_id, permission, effect)
         VALUES ($1,$2,'allow') ON CONFLICT DO NOTHING`,
        [id, p],
      );
    }
  }
  console.log(`✔ ${roles.length} system roles`);
}

async function seedAssignments() {
  const map: Array<[string, string]> = [
    ['yacoub', 'SYSTEM_ADMIN'],
    ['yacoub', 'GENERAL_MANAGER'],
    ['yacoub', 'ACCOUNTANT'],
    ['abdulrahman', 'CASHIER'],
    ['abdulrahman', 'INVENTORY_MANAGER'],
    ['abdulrahman', 'SALES_MANAGER'],
  ];
  for (const [user, roleCode] of map) {
    await pool.query(
      `INSERT INTO dypos.user_roles (user_id, role_id)
       SELECT u.id, r.id FROM dypos.users u, dypos.roles r
       WHERE u.tenant_id = $1 AND u.username = $2 AND r.tenant_id = $1 AND r.code = $3
       ON CONFLICT DO NOTHING`,
      [TENANT, user, roleCode],
    );
    await pool.query(
      `INSERT INTO dypos.user_branch_access (user_id, branch_id)
       SELECT u.id, b.id FROM dypos.users u, dypos.branches b
       WHERE u.tenant_id = $1 AND u.username = $2 AND b.tenant_id = $1
       ON CONFLICT DO NOTHING`,
      [TENANT, user],
    );
  }
  console.log('✔ role + branch assignments');
}

async function seedPeriods() {
  for (let i = 0; i < 24; i++) {
    const d = new Date();
    d.setMonth(d.getMonth() - i);
    const period = `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}`;
    await pool.query(
      `INSERT INTO dypos.accounting_periods (id, tenant_id, branch_id, period, status)
       VALUES ($1,$2,NULL,$3,$4) ON CONFLICT DO NOTHING`,
      [uid('per', period), TENANT, period, i === 0 ? 'open' : 'closed'],
    );
  }
  console.log('✔ 24 accounting periods (current open, rest closed)');
}

main().catch(async (e) => {
  console.error('FAILED:', e.message);
  await pool.end();
  process.exit(1);
});