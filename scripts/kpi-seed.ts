import dotenv from 'dotenv';
import fs from 'fs';
import path from 'path';
import pg from 'pg';
import { DEFS } from './kpiData.js';

dotenv.config();

const pool = new pg.Pool({
  connectionString: process.env.DATABASE_URL,
  ssl: { rejectUnauthorized: false },
  max: 1,
});

const TENANT = 'royal-global-hq';

async function main() {
  // Idempotent: re-running keeps the script self-sufficient.
  const sql = fs.readFileSync(
    path.join(process.cwd(), 'server', 'migrations', 'v134_kpi_store.sql'),
    'utf8',
  );
  await pool.query(sql);
  console.log('✔ v134 schema applied');

  for (const [code, name, nameEn, cat, pol, unit, formula, bench, warn, crit, action, sort] of DEFS) {
    await pool.query(
      `INSERT INTO dypos.kpi_definitions
         (code, name, name_en, category, polarity, unit, formula,
          benchmark, warn_threshold, critical_threshold, action, sort_order)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12)
       ON CONFLICT (code) DO UPDATE SET
         name = EXCLUDED.name, name_en = EXCLUDED.name_en,
         category = EXCLUDED.category, polarity = EXCLUDED.polarity,
         unit = EXCLUDED.unit, formula = EXCLUDED.formula,
         benchmark = EXCLUDED.benchmark, warn_threshold = EXCLUDED.warn_threshold,
         critical_threshold = EXCLUDED.critical_threshold,
         action = EXCLUDED.action, sort_order = EXCLUDED.sort_order`,
      [code, name, nameEn, cat, pol, unit, formula, bench, warn, crit, action, sort],
    );
  }
  console.log(`✔ ${DEFS.length} KPI definitions`);

  await buildCohorts();
  await buildPriceRealisation();
  await report();
  await pool.end();
}

/**
 * Customer cohorts from the real invoice history: first-purchase month, order
 * count, and value at 30/60/90 days. Retention cannot be measured without
 * this — a snapshot of "active customers" says nothing about loyalty.
 */
async function buildCohorts() {
  const { rows } = await pool.query(
    `WITH line_items AS (
       SELECT i.id AS invoice_id, i.customer_id, i.created_at, i.base_total
       FROM dypos.invoices i
       WHERE i.tenant_id = $1 AND i.status = 'completed' AND i.customer_id IS NOT NULL
     ),
     firsts AS (
       SELECT customer_id, MIN(created_at) AS first_at
       FROM line_items GROUP BY customer_id
     )
     SELECT li.customer_id,
            to_char(f.first_at, 'YYYY-MM') AS cohort_month,
            (SELECT x.base_total FROM line_items x
              WHERE x.customer_id = li.customer_id
              ORDER BY x.created_at LIMIT 1)               AS first_value,
            COUNT(DISTINCT li.invoice_id)::int             AS order_count,
            SUM(li.base_total)                            AS lifetime_value,
            MAX(li.created_at)::date                      AS last_order_at,
            COALESCE(SUM(li.base_total) FILTER (
              WHERE li.created_at <= f.first_at + INTERVAL '30 days'), 0) AS v30,
            COALESCE(SUM(li.base_total) FILTER (
              WHERE li.created_at <= f.first_at + INTERVAL '60 days'), 0) AS v60,
            COALESCE(SUM(li.base_total) FILTER (
              WHERE li.created_at <= f.first_at + INTERVAL '90 days'), 0) AS v90
     FROM line_items li
     JOIN firsts f ON f.customer_id = li.customer_id
     GROUP BY li.customer_id, f.first_at`,
    [TENANT],
  );

  for (const r of rows) {
    await pool.query(
      `INSERT INTO dypos.customer_cohorts
         (id, tenant_id, customer_id, cohort_month, first_value, order_count,
          lifetime_value, last_order_at, repeat_indicator, value_30d, value_60d, value_90d)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12)
       ON CONFLICT (tenant_id, customer_id) DO UPDATE SET
         cohort_month = EXCLUDED.cohort_month, first_value = EXCLUDED.first_value,
         order_count = EXCLUDED.order_count, lifetime_value = EXCLUDED.lifetime_value,
         last_order_at = EXCLUDED.last_order_at,
         repeat_indicator = EXCLUDED.repeat_indicator,
         value_30d = EXCLUDED.value_30d, value_60d = EXCLUDED.value_60d,
         value_90d = EXCLUDED.value_90d, updated_at = NOW()`,
      [`coh-${r.customer_id}`, TENANT, r.customer_id, r.cohort_month,
        Number(r.first_value || 0), r.order_count, Number(r.lifetime_value || 0),
        r.last_order_at, r.order_count > 1,
        Number(r.v30 || 0), Number(r.v60 || 0), Number(r.v90 || 0)],
    );
  }
  console.log(`✔ ${rows.length} customer cohorts`);
}

/**
 * Price realisation per product: the ratio between the price actually charged
 * and the catalogue price. Falling realisation on steady volume is margin
 * leakage that no sales report surfaces.
 */
async function buildPriceRealisation() {
  const { rows } = await pool.query(
    `WITH sold AS (
       SELECT i.branch_id,
              i.created_at::date AS scope_date,
              (item->>'productId') AS product_id,
              SUM((item->>'qty')::numeric) AS units,
              -- Weighted by quantity so one-unit sales do not distort the mean.
              SUM((item->>'price')::numeric * (item->>'qty')::numeric)
                / NULLIF(SUM((item->>'qty')::numeric), 0) AS avg_realised
       FROM dypos.invoices i, jsonb_array_elements(i.items) AS item
       WHERE i.tenant_id = $1 AND i.status = 'completed'
       GROUP BY 1, 2, 3
     )
     SELECT s.branch_id, s.scope_date, s.product_id, s.units, s.avg_realised,
            p.unit_price,
            CASE WHEN p.unit_price > 0
                 THEN LEAST(1, s.avg_realised / p.unit_price) END  AS realisation,
            CASE WHEN p.unit_price > 0 AND s.avg_realised > 0
                 THEN ((s.avg_realised - p.unit_price) / p.unit_price) * 100 END AS margin_pct
     FROM sold s
     JOIN dypos.products p ON p.id = s.product_id AND p.tenant_id = $1
     WHERE p.unit_price > 0
     ORDER BY realisation NULLS LAST
     LIMIT 500`,
    [TENANT],
  );

  for (const r of rows) {
    await pool.query(
      `INSERT INTO dypos.price_realisation
         (id, tenant_id, branch_id, product_id, scope_date, list_price,
          avg_realised, units_sold, discount_gap, margin_pct)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10)
       ON CONFLICT (tenant_id, branch_id, product_id, scope_date) DO UPDATE SET
         list_price = EXCLUDED.list_price, avg_realised = EXCLUDED.avg_realised,
         units_sold = EXCLUDED.units_sold, discount_gap = EXCLUDED.discount_gap,
         margin_pct = EXCLUDED.margin_pct`,
      // A product can sell on the same day in two branches, so the key has to
      // include the branch — otherwise the second branch collides on the PK.
      [`pr-${r.branch_id || 'all'}-${r.product_id}-${r.scope_date}`, TENANT,
        r.branch_id, r.product_id, r.scope_date, Number(r.unit_price),
        Number(r.avg_realised), Number(r.units || 0),
        Number(1 - (r.realisation ?? 1)), Number(r.margin_pct || 0)],
    );
  }

  // The weighted aggregate is what the KPI reports, not a plain average of
  // rows: a one-unit sale must not count as much as a hundred-unit sale.
  const agg = await pool.query(
    `SELECT ROUND(AVG(discount_gap) * 100, 2) AS gap_pct
     FROM dypos.price_realisation WHERE tenant_id = $1`,
    [TENANT],
  );
  console.log(`✔ ${rows.length} price realisation rows · avg discount gap ${agg.rows[0].gap_pct}%`);
}

async function report() {
  const v = await pool.query(
    `SELECT
       (SELECT count(*) FROM dypos.kpi_definitions)                     AS definitions,
       (SELECT count(*) FROM dypos.customer_cohorts WHERE tenant_id=$1)  AS cohorts,
       (SELECT count(*) FROM dypos.customer_cohorts
         WHERE tenant_id=$1 AND repeat_indicator)                       AS repeat_customers,
       (SELECT COALESCE(sum(lifetime_value),0)::numeric
         FROM dypos.customer_cohorts WHERE tenant_id=$1)                AS cohort_lifetime`,
    [TENANT],
  );
  console.table(v.rows[0]);
}

main().catch(async (e) => {
  console.error('FAILED:', e.message);
  await pool.end();
  process.exit(1);
});