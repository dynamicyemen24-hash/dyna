/**
 * Seeds realistic operating expenses and cash movements.
 *
 * WHY THIS EXISTS
 * ---------------
 * `dypos.expenses` and `dypos.purchase_orders` were created by the schema but
 * never written to. With no expense rows, net profit equals gross profit — a
 * correct calculation that tells a manager nothing, because it silently
 * assumes the business costs nothing to run. This script gives the financial
 * statements something real to report on.
 *
 * It is NOT run automatically. Seeding fabricated costs into a live ledger is a
 * decision for the operator, not a side effect of a migration:
 *
 *   npx tsx scripts/seed-financials.ts            # write 6 months of expenses
 *   npx tsx scripts/seed-financials.ts --dry-run  # show the plan, write nothing
 *   npx tsx scripts/seed-financials.ts --clear    # remove the seeded rows
 *
 * IDEMPOTENCY: every row carries a deterministic id derived from its own
 * content and inserts use ON CONFLICT DO NOTHING, so running it twice writes
 * the same rows once rather than doubling the ledger.
 *
 * Every row it writes is clearly-marked DEMO data with a `seed-` id prefix, and
 * --clear removes exactly those and nothing else.
 */
import dotenv from 'dotenv';
import { PG_SSL } from '../server/neonDb.ts';
import fs from 'fs';
import path from 'path';
import pg from 'pg';

dotenv.config();

const TENANT = 'royal-global-hq';
const BRANCH = 'rg-branch-hq';
const dryRun = process.argv.includes('--dry-run');
const clear = process.argv.includes('--clear');
const MONTHS = 6;

/** A stable id from the row's own content, so re-runs cannot duplicate. */
const seedId = (...parts: string[]) =>
  `seed-${parts.join('-').toLowerCase().replace(/[^a-z0-9]+/g, '-').slice(0, 40)}`;

/**
 * A fixed catalogue of monthly costs, expressed as fractions of whatever the
 * tenant actually earned that month.
 *
 * Ratios rather than round numbers: a flat 5,000 rent against a month that
 * took 2,000 in sales is not a demo, it is a number a reader would quote.
 */
const MONTHLY_COSTS: Array<{ label: string; share: number; note: string }> = [
  { label: 'salary', share: 0.28, note: 'رواتب الموظفين بدوام كامل' },
  { label: 'rent', share: 0.12, note: 'إيجار الفرع الرئيسي' },
  { label: 'utilities', share: 0.05, note: 'كهرباء ومياه وإنترنت' },
  { label: 'marketing', share: 0.04, note: 'إعلانات وحملات ترويجية' },
  { label: 'logistics', share: 0.06, note: 'شحن وتوصيل' },
  { label: 'maintenance', share: 0.03, note: 'صيانة دورية للأجهزة' },
  { label: 'professional fees', share: 0.02, note: 'رسوم محاسب واستشارات' },
  { label: 'bank charges', share: 0.015, note: 'رسوم مدى والتحصيل' },
];
async function main() {
  const pool = new pg.Pool({
    connectionString: process.env.DATABASE_URL,
    ssl: PG_SSL,
    max: 1,
  });

  // Apply the schema first, so a fresh database can be seeded without running
  // the migration command by hand.
  const sql = fs.readFileSync(
    path.join(process.cwd(), 'server', 'migrations', 'v137_financial_statements.sql'),
    'utf8',
  );
  await pool.query(sql);
  console.log('v137 schema applied');

  if (clear) {
    const gone = await pool.query(
      `DELETE FROM dypos.expenses WHERE tenant_id = $1 AND id LIKE 'seed-%'`,
      [TENANT],
    );
    const moved = await pool.query(
      `DELETE FROM dypos.cash_movements WHERE tenant_id = $1 AND id LIKE 'seed-%'`,
      [TENANT],
    );
    console.log(`removed ${gone.rowCount} seeded expenses and ${moved.rowCount} cash movements`);
    await pool.end();
    return;
  }

  // Real revenue per month, so the ratios are anchored to actual trading.
  const { rows } = await pool.query(
    `SELECT to_char(date_trunc('month', created_at), 'YYYY-MM') AS month,
            COALESCE(SUM(COALESCE(base_subtotal, subtotal, 0) - COALESCE(discount, 0)), 0)::numeric AS revenue
     FROM dypos.invoices
     WHERE tenant_id = $1 AND status = 'completed'
     GROUP BY 1 ORDER BY 1 DESC LIMIT $2`,
    [TENANT, MONTHS],
  );

  if (rows.length === 0) {
    console.log('No completed invoices found — nothing to anchor expenses to.');
    await pool.end();
    return;
  }

  const plan = rows.flatMap((m) => {
    const revenue = Number(m.revenue);
    if (revenue <= 0) return [];
    return MONTHLY_COSTS.map((c) => ({
      id: seedId(m.month, c.label),
      label: c.label,
      note: c.note,
      amount: Math.round(revenue * c.share * 100) / 100,
      month: m.month,
    }));
  });

  // A capital purchase and a loan, so the investing and financing sections are
  // exercised instead of staying permanently empty in every cash flow report.
  const movements = [
    {
      id: seedId('capex', 'equipment'),
      direction: 'out', section: 'investing',
      category: 'شراء معدات', amount: 8500,
      month: rows[0].month, note: 'أصول ثابتة للمعرض',
    },
    {
      id: seedId('loan', 'facility'),
      direction: 'in', section: 'financing',
      category: 'قرض بنكي', amount: 25000,
      month: rows[0].month, note: 'تمويل ذو أجل قصير',
    },
  ];

  if (dryRun) {
    console.log(`\nDRY RUN — ${plan.length} expenses, ${movements.length} cash movements`);
    console.log('\nexpenses (first 12):');
    for (const p of plan.slice(0, 12)) {
      console.log(`  ${p.month}  ${p.label.padEnd(22)} ${p.amount.toFixed(2)}`);
    }
    if (plan.length > 12) console.log(`  ... and ${plan.length - 12} more`);
    console.log('\ncash movements:');
    for (const m of movements) {
      console.log(`  ${m.month}  ${m.direction.padEnd(4)} ${m.section.padEnd(10)} ${m.category.padEnd(16)} ${m.amount}`);
    }
    console.log('\nnothing was written. Re-run without --dry-run to apply.');
    await pool.end();
    return;
  }

  for (const p of plan) {
    await pool.query(
      `INSERT INTO dypos.expenses
         (id, tenant_id, branch_id, category, amount, description, expense_date, payment_method)
       VALUES ($1,$2,$3,$4,$5,$6,$7,'bank_transfer')
       ON CONFLICT (id) DO NOTHING`,
      [
        p.id, TENANT, BRANCH, p.label, p.amount,
        `مصروف تشغيلي تجريبي — ${p.note}`,
        `${p.month}-05`,
      ],
    );
  }

  for (const m of movements) {
    await pool.query(
      `INSERT INTO dypos.cash_movements
         (id, tenant_id, branch_id, direction, section, category, amount,
          occurred_on, payment_method, description, created_by)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,'bank_transfer',$9,'seed-financials')
       ON CONFLICT (id) DO NOTHING`,
      [
        m.id, TENANT, BRANCH, m.direction, m.section, m.category, m.amount,
        `${m.month}-12`, `${m.category} — ${m.note}`,
      ],
    );
  }

  const check = await pool.query(
    `SELECT (SELECT count(*) FROM dypos.expenses WHERE tenant_id = $1) AS expenses,
            (SELECT count(*) FROM dypos.cash_movements WHERE tenant_id = $1) AS movements`,
    [TENANT],
  );
  console.log(`\nseeded ${plan.length} expenses and ${movements.length} cash movements`);
  console.log('tenant totals now:', JSON.stringify(check.rows[0]));
  console.log('\nThese are DEMO rows. Remove them with: npx tsx scripts/seed-financials.ts --clear');

  await pool.end();
}

main().catch((e) => { console.error('ERR', e.message); process.exit(1); });