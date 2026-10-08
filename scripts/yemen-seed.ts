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

const ZONES = [
  { code: 'SANAA', name: 'صنعاء — المنطقة الشمالية', issuer: 'CBY', vat: 5.0 },
  { code: 'ADEN', name: 'عدن — المنطقة الجنوبية', issuer: 'CBA', vat: 5.0 },
];

const ISSUER_CURRENCIES = [
  { issuer: 'CBY', code: 'YER', name: 'ريال يمني — البنك المركزي', symbol: 'ر.ي', dec: 0, usd: 250, parity: 0 },
  { issuer: 'CBY', code: 'SAR', name: 'ريال سعودي', symbol: 'ر.س', dec: 2, usd: 3.75, parity: 0 },
  { issuer: 'CBY', code: 'USD', name: 'دولار أمريكي', symbol: '$', dec: 2, usd: 1, parity: 0 },
  // The southern issuer's rial has traded at a discount to the northern one.
  { issuer: 'CBA', code: 'YER', name: 'ريال جنوبي', symbol: 'ر.ي(ع)', dec: 0, usd: 247.5, parity: -1.2 },
  { issuer: 'CBA', code: 'SAR', name: 'ريال سعودي', symbol: 'ر.س', dec: 2, usd: 3.75, parity: 0 },
  { issuer: 'CBA', code: 'USD', name: 'دولار أمريكي', symbol: '$', dec: 2, usd: 1, parity: 0 },
  // Pre-unification southern dinar, retained for historical documents.
  { issuer: 'CBY-PRE2014', code: 'YDD', name: 'دينار جنوبي يمني (تاريخي)', symbol: 'د.ي', dec: 3, usd: 8.3333, parity: 0 },
];

async function main() {
  const sql = fs.readFileSync(
    path.join(process.cwd(), 'server', 'migrations', 'v133_yemen_accounting.sql'),
    'utf8',
  );
  await pool.query(sql);
  console.log('✔ v133 schema applied');

  await seedZones();
  await seedIssuerCurrencies();
  await seedZoneRates();
  await seedZoneAccounts();
  await seedCommissionPlans();
  await seedBonusPlans();
  await seedOfferRules();
  await seedPermissions();

  const v = await pool.query(
    `SELECT
       (SELECT count(*) FROM dypos.zones             WHERE tenant_id = $1) AS zones,
       (SELECT count(*) FROM dypos.issuer_currencies WHERE tenant_id = $1) AS issuer_currencies,
       (SELECT count(*) FROM dypos.zone_accounts     WHERE tenant_id = $1) AS zone_accounts,
       (SELECT count(*) FROM dypos.commission_plans  WHERE tenant_id = $1) AS comm_plans,
       (SELECT count(*) FROM dypos.commission_tiers)                     AS comm_tiers,
       (SELECT count(*) FROM dypos.bonus_plans       WHERE tenant_id = $1) AS bonus_plans,
       (SELECT count(*) FROM dypos.offer_rules       WHERE tenant_id = $1) AS offers`,
    [TENANT],
  );
  console.table(v.rows[0]);
  await pool.end();
}

async function seedZones() {
  for (const z of ZONES) {
    await pool.query(
      `INSERT INTO dypos.zones (id, tenant_id, code, name, country_code, issuer, vat_rate)
       VALUES ($1,$2,$3,$4,'YE',$5,$6)
       ON CONFLICT (tenant_id, code) DO UPDATE
         SET name = EXCLUDED.name, issuer = EXCLUDED.issuer, vat_rate = EXCLUDED.vat_rate`,
      [uid('zone', z.code), TENANT, z.code, z.name, z.issuer, z.vat],
    );
  }
  console.log(`✔ ${ZONES.length} monetary zones`);
}

async function seedIssuerCurrencies() {
  for (const c of ISSUER_CURRENCIES) {
    await pool.query(
      `INSERT INTO dypos.issuer_currencies
         (id, tenant_id, issuer, code, name, symbol, decimals, usd_rate, parity_pct)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9)
       ON CONFLICT (tenant_id, issuer, code) DO UPDATE
         SET name = EXCLUDED.name, symbol = EXCLUDED.symbol,
             decimals = EXCLUDED.decimals, usd_rate = EXCLUDED.usd_rate,
             parity_pct = EXCLUDED.parity_pct`,
      [uid('cur', `${c.issuer}_${c.code}`), TENANT, c.issuer, c.code,
        c.name, c.symbol, c.dec, c.usd, c.parity],
    );
  }
  console.log(`✔ ${ISSUER_CURRENCIES.length} issuer currencies`);
}

/**
 * Cross-zone rates come from the USD legs so the two-zone book stays internally
 * consistent: CBY YER -> CBA YER = 250 / 247.5 = 1.0101.
 */
async function seedZoneRates() {
  const pairs: Array<[string, string, string, string, string]> = [
    ['CBY', 'CBA', 'YER', 'YER', 'market'],
    ['CBA', 'CBY', 'YER', 'YER', 'market'],
    ['CBY', 'CBA', 'YER', 'SAR', 'derived'],
    ['CBA', 'CBY', 'SAR', 'YER', 'derived'],
    ['CBY', 'CBY-PRE2014', 'YER', 'YDD', 'official'],
  ];

  const usd = new Map(ISSUER_CURRENCIES.map((c) => [`${c.issuer}:${c.code}`, c.usd]));

  for (const [fi, ti, fc, tc, type] of pairs) {
    const fromUsd = usd.get(`${fi}:${fc}`);
    const toUsd = usd.get(`${ti}:${tc}`);
    if (!fromUsd || !toUsd) continue;

    // "How many units of TO does 1 unit of FROM buy?" Both legs are quoted in
    // USD, so dividing the two USD rates is the correct derivation.
    const rate = fromUsd / toUsd;

    await pool.query(
      `INSERT INTO dypos.zone_rates
         (id, tenant_id, from_issuer, to_issuer, rate, rate_type, spread_bps, source)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8)
       ON CONFLICT DO NOTHING`,
      [uid('zrate', `${fi}_${ti}_${fc}_${tc}`), TENANT, fi, ti,
        Number(rate.toFixed(10)), type, type === 'market' ? 150 : 50, 'seed'],
    );
  }
  console.log(`✔ ${pairs.length} cross-zone rates`);
}

async function seedZoneAccounts() {
  for (const z of ZONES) {
    const zoneId = uid('zone', z.code);
    const accounts: Array<[string, string, string, string]> = [
      ['1101', `${z.name} — الصندوق`, 'cash', 'YER'],
      ['1111', `${z.name} — البنك`, 'bank', 'YER'],
      ['1121', `${z.name} — محفظة إلكترونية`, 'wallet', 'SAR'],
      ['1201', `${z.name} — ذمم مدينة`, 'receivable', 'YER'],
      ['2101', `${z.name} — ذمم دائنة`, 'payable', 'YER'],
    ];
    for (const [code, name, type, cur] of accounts) {
      await pool.query(
        `INSERT INTO dypos.zone_accounts
           (id, tenant_id, zone_id, account_code, account_name, account_type, currency_code, issuer)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8)
         ON CONFLICT (tenant_id, zone_id, account_type, currency_code) DO UPDATE
           SET account_name = EXCLUDED.account_name`,
        [uid('zacc', `${z.code}_${type}_${cur}`), TENANT, zoneId,
          code, name, type, cur, z.issuer],
      );
    }
  }
  console.log(`✔ ${ZONES.length * 5} zone settlement accounts`);
}

/**
 * Progressive commission tiers. A flat rate on the whole amount would pay a
 * salesperson for the portion of the target they never reached, so each band
 * is paid at its own rate.
 */
async function seedCommissionPlans() {
  const plans = [
    {
      code: 'STD_SALES', name: 'عمولة مبيعات شهرية متدرجة', period: 'monthly',
      tiers: [
        { from: 0, to: 50000, rate: 2.0 },
        { from: 50000, to: 150000, rate: 3.5 },
        { from: 150000, to: 300000, rate: 5.0 },
        { from: 300000, to: null, rate: 6.5 },
      ],
    },
    {
      code: 'COUNTER', name: 'عمولة شباك البيع', period: 'monthly',
      tiers: [
        { from: 0, to: 30000, rate: 1.5 },
        { from: 30000, to: null, rate: 2.5 },
      ],
    },
  ];

  for (const p of plans) {
    const planId = uid('cplan', p.code);
    await pool.query(
      `INSERT INTO dypos.commission_plans (id, tenant_id, code, name, scope, period_type, currency_code)
       VALUES ($1,$2,$3,$4,'sales',$5,'YER')
       ON CONFLICT (tenant_id, code) DO UPDATE SET name = EXCLUDED.name, period_type = EXCLUDED.period_type`,
      [planId, TENANT, p.code, p.name, p.period],
    );
    for (const t of p.tiers) {
      await pool.query(
        `INSERT INTO dypos.commission_tiers (id, plan_id, from_amount, to_amount, rate_pct)
         VALUES ($1,$2,$3,$4,$5) ON CONFLICT (plan_id, from_amount)
           DO UPDATE SET to_amount = EXCLUDED.to_amount, rate_pct = EXCLUDED.rate_pct`,
        [uid('ctier', `${p.code}_${t.from}`), planId, t.from, t.to, t.rate],
      );
    }
  }
  console.log(`✔ ${plans.length} commission plans with progressive tiers`);
}

async function seedBonusPlans() {
  const plans = [
    { code: 'TARGET_MONTHLY', name: 'مكافأة تحقيق هدف شهري', metric: 'sales_target', target: 150000, type: 'fixed', value: 15000 },
    { code: 'MARGIN_Q', name: 'مكافأة هامش ربع سنوي', metric: 'margin', target: 200000, type: 'percent', value: 2.0 },
    { code: 'NEW_CUST', name: 'مكافأة كسب عملاء جدد', metric: 'new_customers', target: 10, type: 'per_unit', value: 2000 },
  ];

  for (const p of plans) {
    await pool.query(
      `INSERT INTO dypos.bonus_plans
         (id, tenant_id, code, name, metric, target_value, reward_type, reward_value, currency_code)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,'YER')
       ON CONFLICT (tenant_id, code) DO UPDATE
         SET name = EXCLUDED.name, target_value = EXCLUDED.target_value,
             reward_value = EXCLUDED.reward_value`,
      [uid('bplan', p.code), TENANT, p.code, p.name, p.metric,
        p.target, p.type, p.value],
    );
  }
  console.log(`✔ ${plans.length} bonus plans`);
}

/** Offers with real mechanics, including the classic "buy 3, get 1 free". */
async function seedOfferRules() {
  const offers = [
    { code: 'TIER_100K', name: 'فوق 100,000 خصم 15%', type: 'threshold_tier', a: 100000, b: 15, min: 100000, cap: 20000, applies: 'order', prio: 5 },
    { code: 'WEEK10', name: 'خصم 10% على السلة فوق 20,000', type: 'percent_off', a: 10, min: 20000, cap: 5000, applies: 'order', prio: 10 },
    { code: 'B3G1', name: 'اشترِ 3 ادفع 2', type: 'buy_x_get_y', a: 3, b: 1, min: 3, applies: 'line', prio: 20 },
    { code: 'FLAT5K', name: 'خصم ثابت 5,000 على الفاتورة', type: 'amount_off', a: 5000, min: 50000, cap: 5000, applies: 'order', prio: 30 },
    { code: 'BUNDLE', name: 'باقة عطور بسعر 8,000', type: 'bundle_price', a: 8000, min: 1, applies: 'category', val: 'عطور', prio: 40 },
  ];

  for (const o of offers) {
    await pool.query(
      `INSERT INTO dypos.offer_rules
         (id, tenant_id, code, name, rule_type, operand_a, operand_b, min_qty,
          min_amount, max_discount, applies_to, applies_value, priority)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13)
       ON CONFLICT (tenant_id, code) DO UPDATE
         SET name = EXCLUDED.name, operand_a = EXCLUDED.operand_a,
             operand_b = EXCLUDED.operand_b, min_amount = EXCLUDED.min_amount,
             max_discount = EXCLUDED.max_discount`,
      [uid('offer', o.code), TENANT, o.code, o.name, o.type,
        o.a ?? 0, o.b ?? 0, o.min ?? 0, o.min ?? 0,
        o.cap ?? null, o.applies, o.val ?? null, o.prio],
    );
  }
  console.log(`✔ ${offers.length} offer rules`);
}

/** Permissions for the accountant workbench, granted to the right roles. */
async function seedPermissions() {
  const perms: Array<[string, string, string]> = [
    ['return.create', 'إنشاء إرجاع', 'RETURNS'],
    ['return.approve', 'اعتماد إرجاع', 'RETURNS'],
    ['return.void', 'إلغاء إرجاع', 'RETURNS'],
    ['settlement.create', 'فتح جرد مخزني', 'INVENTORY'],
    ['settlement.count', 'تسجيل نتائج الجرد', 'INVENTORY'],
    ['settlement.review', 'مراجعة فروقات الجرد', 'INVENTORY'],
    ['settlement.post', 'ترحيل فروقات الجرد', 'INVENTORY'],
    ['commission.plan.manage', 'إدارة خطط العمولات', 'HR'],
    ['commission.approve', 'اعتماد العمولات', 'HR'],
    ['commission.pay', 'صرف العمولات', 'HR'],
    ['bonus.manage', 'إدارة المكافآت', 'HR'],
    ['bonus.pay', 'صرف المكافآت', 'HR'],
    ['offer.manage', 'إدارة العروض', 'SALES'],
    ['fx.differential.view', 'عرض فروق الصرف', 'TREASURY'],
    ['fx.rate.manage', 'إدارة أسعار الصرف', 'TREASURY'],
    ['user.manage', 'إدارة المستخدمين وبياناتهم', 'SECURITY'],
    ['zone.configure', 'إعداد المناطق النقدية', 'TREASURY'],
  ];

  for (const [code, name, module] of perms) {
    await pool.query(
      `INSERT INTO dypos.permissions (code, name, module) VALUES ($1,$2,$3)
       ON CONFLICT (code) DO UPDATE SET name = EXCLUDED.name, module = EXCLUDED.module`,
      [code, name, module],
    );
  }

  // Grant by role so the accountant workflow is usable, not merely modelled.
  const grants: Array<[string, string[]]> = [
    ['ACCOUNTANT', ['return.approve', 'settlement.post', 'settlement.review',
      'commission.approve', 'commission.plan.manage', 'fx.differential.view',
      'fx.rate.manage', 'offer.manage', 'user.manage']],
    ['INVENTORY_MANAGER', ['settlement.create', 'settlement.count',
      'settlement.review', 'settlement.post', 'return.create']],
    ['SALES_MANAGER', ['return.create', 'return.approve', 'commission.approve', 'offer.manage']],
    ['CASHIER', ['return.create']],
  ];
  for (const [roleCode, list] of grants) {
    await pool.query(
      `INSERT INTO dypos.role_permissions (role_id, permission, effect)
       SELECT r.id, x.permission, 'allow'
         FROM dypos.roles r
         CROSS JOIN LATERAL unnest($3::text[]) AS x(permission)
        WHERE r.tenant_id = $1 AND r.code = $2
       ON CONFLICT DO NOTHING`,
      [TENANT, roleCode, list],
    );
  }

  console.log(`✔ ${perms.length} permissions + ${grants.length} role grants`);
}

main().catch(async (e) => {
  console.error('FAILED:', e.message);
  await pool.end();
  process.exit(1);
});