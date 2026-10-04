import { pool } from './neonDb.js';

export interface Measured {
  code: string;
  value: number | null;
  /** Rows behind the figure — used to refuse to judge a metric with no data. */
  sampleSize: number;
  note?: string;
}

type Def = {
  polarity: 'higher' | 'lower' | 'target';
  unit: string;
  benchmark: number | null;
  warn_threshold: number | null;
  critical_threshold: number | null;
  action: string;
  name: string;
};

const n = (v: any): number => (v === null || v === undefined ? Number.NaN : Number(v));

/** True when a measurement is arithmetically meaningful. */
const usable = (v: number | null): v is number =>
  v !== null && Number.isFinite(v);

/**
 * Classifies against thresholds, respecting polarity.
 *
 * The subtlety: for a lower-is-better metric, "warn" and "critical" are NOT
 * simply "further from the benchmark" — a value between warn and critical is
 * worse news than one sitting exactly on the benchmark. Naive threshold logic
 * calls those fine, which is how a deteriorating number slips through for
 * months.
 */
export function statusOf(def: Def, m: Measured): string {
  if (!usable(m.value) || m.sampleSize <= 0) return 'insufficient_data';
  const { benchmark: b, warn_threshold: w, critical_threshold: c } = def;

  // No benchmark configured: report the value but never judge it.
  if (b === null || w === null || c === null) return 'ok';

  if (def.polarity === 'higher') {
    if (m.value <= c) return 'critical';
    if (m.value <= w) return 'warn';
    return 'ok';
  }
  if (def.polarity === 'lower') {
    if (m.value >= c) return 'critical';
    if (m.value >= w) return 'warn';
    return 'ok';
  }
  // 'target' — a band around the benchmark rather than a one-sided limit.
  const dev = Math.abs(m.value - b);
  if (dev >= Math.abs(c - b)) return 'critical';
  if (dev >= Math.abs(w - b)) return 'warn';
  return 'ok';
}

/** Builds the sentence the operator actually reads. */
export function narrate(def: Def, m: Measured): string {
  if (!usable(m.value)) {
    return m.note || 'لا توجد بيانات كافية — لا يُعامل الصفر كنتائج';
  }
  const v = m.value;
  const f =
    def.unit === 'percent' ? `${v.toFixed(1)}%`
    : def.unit === 'currency' ? v.toLocaleString('en-US', { maximumFractionDigits: 2 })
    : def.unit === 'days' ? `${v.toFixed(0)} يوم`
    : def.unit === 'ratio' ? v.toFixed(2)
    : String(v);

  const st = statusOf(def, m);
  if (st === 'ok') {
    return def.benchmark === null
      ? `${f} — يُعرض للمقارنة دون معيار محدد`
      : `${f} — مطابق للمعيار (${def.benchmark})`;
  }
  if (st === 'insufficient_data') return m.note || 'لا توجد بيانات كافية';
  return `${f} — ${def.action}`;
}

/**
 * Computes every KPI from the transactional tables.
 *
 * Each query returns a `sampleSize` alongside the value. That is deliberate:
 * a metric computed from zero rows must be reported as "no data", not as a
 * confident zero — otherwise a month with no stock count silently reads as
 * "0% shrinkage", which is the most dangerous kind of dashboard lie.
 */
export async function computeAll(tenantId: string, branchId: string | null = null): Promise<Measured[]> {
  const b = branchId;
  const branchClause = b ? 'AND i.branch_id = $2' : '';
  const bParam = b ? [tenantId, b] : [tenantId];

  const sales30 = await pool.query(
    `SELECT COALESCE(SUM(i.base_subtotal),0)::numeric AS net,
            count(*)::int                              AS n,
            COALESCE(SUM(i.base_total),0)::numeric     AS gross_total,
            COALESCE(SUM(i.discount),0)::numeric       AS disc,
            COALESCE(SUM(i.base_tax),0)::numeric       AS vat
     FROM dypos.invoices i
     WHERE i.tenant_id = $1 AND i.status = 'completed'
       AND i.created_at::date >= CURRENT_DATE - 30 ${branchClause}`,
    bParam,
  );

  // COGS comes from the line items, never from the invoice totals.
  const cogs30 = await pool.query(
    `SELECT COALESCE(SUM((item->>'qty')::numeric * (item->>'cost')::numeric), 0)::numeric AS cogs,
            COALESCE(SUM((item->>'qty')::numeric), 0)::numeric                            AS units,
            count(DISTINCT i.id)::int                                                   AS invoices
     FROM dypos.invoices i, jsonb_array_elements(i.items) AS item
     WHERE i.tenant_id = $1 AND i.status = 'completed'
       AND i.created_at::date >= CURRENT_DATE - 30 ${branchClause}`,
    bParam,
  );

  const months = await pool.query(
    `SELECT to_char(created_at,'YYYY-MM') AS ym,
            COALESCE(SUM(base_subtotal),0)::numeric AS net
     FROM dypos.invoices
     WHERE tenant_id = $1 AND status = 'completed'
     GROUP BY 1 ORDER BY 1 DESC LIMIT 2`,
    [tenantId],
  );

  const activeDays = await pool.query(
    `SELECT count(DISTINCT created_at::date)::int AS d
     FROM dypos.invoices
     WHERE tenant_id = $1 AND status = 'completed'
       AND created_at::date >= CURRENT_DATE - 30 ${branchClause}`,
    bParam,
  );

  const payMix = await pool.query(
    `SELECT COALESCE(SUM(total) FILTER (WHERE payment_method = 'cash'),0)::numeric AS cash,
            COALESCE(SUM(total),0)::numeric                                        AS all_total
     FROM dypos.invoices
     WHERE tenant_id = $1 AND status = 'completed'
       AND created_at::date >= CURRENT_DATE - 30 ${branchClause}`,
    bParam,
  );

  const fx = await pool.query(
    `SELECT COALESCE(SUM(ABS(base_total - total)) FILTER (
              WHERE currency_code IS NOT NULL AND currency_code <> 'SAR'),0)::numeric AS exposure,
            COALESCE(SUM(base_total),0)::numeric AS total
     FROM dypos.invoices
     WHERE tenant_id = $1 AND status = 'completed'
       AND created_at::date >= CURRENT_DATE - 30 ${branchClause}`,
    bParam,
  );

  const s = sales30.rows[0];
  const c = cogs30.rows[0];
  const net30 = Number(s.net);
  const cogsValue = Number(c.cogs);
  const invoices = Number(c.invoices);

  const thisM = months.rows[0]?.net ? Number(months.rows[0].net) : null;
  const lastM = months.rows[1]?.net ? Number(months.rows[1].net) : null;

  const out: Measured[] = [
    { code: 'net_sales_30d', value: net30, sampleSize: Number(s.n) },
    {
      code: 'sales_growth_mom',
      value: thisM !== null && lastM !== null && lastM > 0
        ? ((thisM - lastM) / lastM) * 100
        : null,
      sampleSize: months.rows.length,
      note: months.rows.length < 2 ? 'يلزم شهران كاملان لحساب النمو' : undefined,
    },
    {
      code: 'avg_basket_value',
      value: invoices > 0 ? Number(s.gross_total) / invoices : null,
      sampleSize: invoices,
    },
    {
      code: 'units_per_transaction',
      value: invoices > 0 ? Number(c.units) / invoices : null,
      sampleSize: invoices,
    },
    { code: 'selling_days', value: Number(activeDays.rows[0].d), sampleSize: Number(s.n) },
    {
      code: 'gross_margin_pct',
      value: net30 > 0 ? ((net30 - cogsValue) / net30) * 100 : null,
      sampleSize: Number(c.units),
    },
    { code: 'discount_ratio_pct', value: net30 > 0 ? (Number(s.disc) / net30) * 100 : null, sampleSize: Number(s.n) },
    {
      code: 'cash_sales_ratio_pct',
      value: Number(payMix.rows[0].all_total) > 0
        ? (Number(payMix.rows[0].cash) / Number(payMix.rows[0].all_total)) * 100
        : null,
      sampleSize: Number(s.n),
    },
    {
      code: 'fx_exposure_pct',
      value: Number(fx.rows[0].total) > 0 ? (Number(fx.rows[0].exposure) / Number(fx.rows[0].total)) * 100 : null,
      sampleSize: Number(s.n),
    },
  ];

  const inv = await pool.query(
    `SELECT COALESCE(SUM(cost * stock), 0)::numeric AS value,
            count(*) FILTER (WHERE stock <= reorder_point AND reorder_point > 0)::int AS at_risk,
            count(*)::int AS items
     FROM dypos.products
     WHERE tenant_id = $1 AND is_active = TRUE ${branchClause}`,
    bParam,
  );

  // Dead stock: items with no sale in the last 90 days, valued at cost.
  const dead = await pool.query(
    `SELECT COALESCE(SUM(p.cost * p.stock), 0)::numeric AS dead_value
     FROM dypos.products p
     WHERE p.tenant_id = $1 AND p.is_active = TRUE AND p.stock > 0
       AND NOT EXISTS (
         SELECT 1 FROM dypos.invoices i, jsonb_array_elements(i.items) AS item
         WHERE i.tenant_id = p.tenant_id AND i.status = 'completed'
           AND (item->>'productId') = p.id
           AND i.created_at::date >= CURRENT_DATE - 90
       )`,
    [tenantId],
  );

  const ar = await pool.query(
    `SELECT COALESCE(SUM(outstanding_amount), 0)::numeric AS total,
            COALESCE(SUM(outstanding_amount) FILTER (WHERE due_date < CURRENT_DATE), 0)::numeric AS overdue,
            count(*)::int AS n
     FROM dypos.accounts_receivable
     WHERE tenant_id = $1 AND outstanding_amount > 0`,
    [tenantId],
  );

  const ap = await pool.query(
    `SELECT COALESCE(SUM(outstanding_amount), 0)::numeric AS total,
            COALESCE(SUM(outstanding_amount) FILTER (WHERE due_date < CURRENT_DATE), 0)::numeric AS overdue,
            count(*)::int AS n
     FROM dypos.accounts_payable
     WHERE tenant_id = $1 AND outstanding_amount > 0`,
    [tenantId],
  );

  const credit = await pool.query(
    `SELECT COALESCE(SUM(credit_limit), 0)::numeric AS limits FROM dypos.customers WHERE tenant_id = $1`,
    [tenantId],
  );

  const cohorts = await pool.query(
    `SELECT count(*)::int AS total,
            count(*) FILTER (WHERE repeat_indicator)::int AS repeats
     FROM dypos.customer_cohorts WHERE tenant_id = $1`,
    [tenantId],
  );

  const settle = await pool.query(
    `SELECT COALESCE(SUM(ABS(l.variance_qty)), 0)::numeric AS abs_var,
            COALESCE(SUM(l.system_qty), 0)::numeric        AS sys_qty
     FROM dypos.stock_settlement_lines l
     JOIN dypos.stock_settlements s ON s.id = l.settlement_id
     WHERE s.tenant_id = $1 AND s.status = 'posted'`,
    [tenantId],
  );

  const shrink = await pool.query(
    `SELECT COALESCE(SUM(shrink_value), 0)::numeric AS shrink
     FROM dypos.stock_settlements WHERE tenant_id = $1 AND status = 'posted'`,
    [tenantId],
  );

  const cashVar = await pool.query(
    `SELECT COALESCE(SUM(ABS(cc.variance)), 0)::numeric AS v
     FROM dypos.cash_counts cc
     JOIN dypos.shifts sh ON sh.id = cc.shift_id
     WHERE sh.tenant_id = $1`,
    [tenantId],
  );

  const employees = await pool.query(
    `SELECT count(*)::int AS n FROM dypos.employees WHERE tenant_id = $1 AND status = 'active'`,
    [tenantId],
  );

  // Neither table carries tenant_id, so attendance is scoped through the
  // employee it belongs to rather than filtered directly.
  const attendance = await pool.query(
    `SELECT count(*)::int AS total,
            count(*) FILTER (WHERE a.status = 'present')::int AS present
     FROM dypos.attendance a
     JOIN dypos.employees e ON e.id = a.employee_id
     WHERE e.tenant_id = $1 AND a.date >= CURRENT_DATE - 30`,
    [tenantId],
  );

  const priceReal = await pool.query(
    `SELECT COALESCE(AVG(discount_gap), 0)::numeric AS gap, count(*)::int AS n
     FROM dypos.price_realisation WHERE tenant_id = $1`,
    [tenantId],
  );

  const invValue = Number(inv.rows[0].value);
  const totalAr = Number(ar.rows[0].total);
  const totalAp = Number(ap.rows[0].total);

  // Turnover and DIO annualise the 30-day COGS. Dividing a 30-day figure by a
  // 365-day one would understate both by an order of magnitude.
  const annualCogs = cogsValue * 12;
  const dailySales = net30 / 30;

  const dioDays = annualCogs > 0 ? (invValue / annualCogs) * 365 : null;
  const turnover = invValue > 0 ? annualCogs / invValue : null;
  const dsoDays = dailySales > 0 ? totalAr / dailySales : null;
  const dpoDays = annualCogs > 0 ? totalAp / (annualCogs / 365) : null;

out.push(
    { code: 'inventory_turnover', value: turnover, sampleSize: Number(inv.rows[0].items) },
    { code: 'dio_days', value: dioDays, sampleSize: Number(inv.rows[0].items) },
    {
      code: 'dead_stock_pct',
      value: invValue > 0 ? (Number(dead.rows[0].dead_value) / invValue) * 100 : null,
      sampleSize: Number(inv.rows[0].items),
      note: Number(inv.rows[0].items) === 0 ? 'لا توجد أصناف مُفعّلة' : undefined,
    },
    {
      code: 'stockout_risk_count',
      value: Number(inv.rows[0].at_risk),
      sampleSize: Number(inv.rows[0].items),
    },
    {
      code: 'price_realisation_pct',
      value: Number(priceReal.rows[0].n) > 0 ? (1 - Number(priceReal.rows[0].gap)) * 100 : null,
      sampleSize: Number(priceReal.rows[0].n),
      note: 'لا توجد مبيعات مسجّلة لمقارنةها بأسعار الكتالوج',
    },
    {
      code: 'inventory_accuracy_pct',
      value: Number(settle.rows[0].sys_qty) > 0
        ? (1 - Number(settle.rows[0].abs_var) / Number(settle.rows[0].sys_qty)) * 100
        : null,
      sampleSize: Number(settle.rows[0].sys_qty) > 0 ? 1 : 0,
      note: 'لم يُرحَّل أي جرد مخزني بعد — لا يمكن قياس الدقة',
    },
    {
      code: 'shrinkage_rate_pct',
      value: null,
      sampleSize: 0,
      note: Number(shrink.rows[0].shrink) > 0
        ? 'يلزم ترحيل جرد لربط قيمة الفقد بقيمة الجرد'
        : 'لم يُرحَّل أي جرد مخزني بعد',
    },
    {
      code: 'aging_stock_pct',
      value: null,
      sampleSize: 0,
      note: 'لا توجد دفعات بصلاحية مُسجّلة لهذا النشاط',
    },
    { code: 'dso_days', value: dsoDays, sampleSize: Number(ar.rows[0].n) },
    {
      code: 'overdue_ar_pct',
      value: totalAr > 0 ? (Number(ar.rows[0].overdue) / totalAr) * 100 : null,
      sampleSize: Number(ar.rows[0].n),
      note: totalAr === 0 ? 'لا توجد ذمم مدينة مفتوحة' : undefined,
    },
    {
      code: 'overdue_ap_pct',
      value: totalAp > 0 ? (Number(ap.rows[0].overdue) / totalAp) * 100 : null,
      sampleSize: Number(ap.rows[0].n),
      note: totalAp === 0 ? 'لا توجد ذمم دائنة مفتوحة' : undefined,
    },
    {
      code: 'dpo_days',
      value: dpoDays,
      sampleSize: Number(ap.rows[0].n),
      note: totalAp === 0 ? 'لا توجد مشتريات آجلة مسجّلة' : undefined,
    },
    {
      code: 'ccc_days',
      value: dioDays !== null && dsoDays !== null && dpoDays !== null
        ? dioDays + dsoDays - dpoDays
        : null,
      sampleSize: Number(ar.rows[0].n) + Number(ap.rows[0].n),
      note: 'يتطلب دورة تحصيل ومدة سداد معاً لقياسها',
    },
    {
      code: 'credit_utilisation_pct',
      value: Number(credit.rows[0].limits) > 0
        ? (totalAr / Number(credit.rows[0].limits)) * 100
        : null,
      sampleSize: Number(ar.rows[0].n),
    },
    {
      code: 'customer_retention_pct',
      value: Number(cohorts.rows[0].total) > 0
        ? (Number(cohorts.rows[0].repeats) / Number(cohorts.rows[0].total)) * 100
        : null,
      sampleSize: Number(cohorts.rows[0].total),
      note: 'يتطلب تاريخ شراء سابق لكل عميل',
    },
    {
      code: 'cash_variance_abs',
      value: null,
      sampleSize: 0,
      note: Number(cashVar.rows[0].v) > 0 ? 'قيمة مجمّعة' : 'لا توجد جردات صندوق مسجّلة',
    },
    {
      code: 'sales_per_employee',
      value: Number(employees.rows[0].n) > 0 ? net30 / Number(employees.rows[0].n) : null,
      sampleSize: Number(employees.rows[0].n),
      note: Number(employees.rows[0].n) === 0 ? 'لا يوجد موظفون نشطون' : undefined,
    },
    {
      code: 'attendance_rate_pct',
      value: Number(attendance.rows[0].total) > 0
        ? (Number(attendance.rows[0].present) / Number(attendance.rows[0].total)) * 100
        : null,
      sampleSize: Number(attendance.rows[0].total),
      note: 'لا توجد سجلات حضور في آخر 30 يوماً',
    },
  );

  return out;
}

/**
 * Persists today's board and raises an alert for every breach.
 *
 * Re-running is safe: snapshots upsert on the natural key, and the partial
 * unique index on (tenant, branch, kpi, date) means an existing open alert is
 * updated rather than duplicated. A nightly job that runs twice must not turn
 * one problem into two rows.
 */
export async function runAndPersist(
  tenantId: string,
  branchId: string | null,
  actor: string,
) {
  const [defs, values] = await Promise.all([
    pool.query(
      `SELECT code, name, polarity, unit, benchmark, warn_threshold,
              critical_threshold, action, category
       FROM dypos.kpi_definitions WHERE is_active = TRUE`,
    ),
    computeAll(tenantId, branchId),
  ]);

  const defMap = new Map(defs.rows.map((d: any) => [d.code, d]));
  const today = new Date().toISOString().slice(0, 10);
  const branchKey = branchId || 'all';

  let saved = 0;
  let alerted = 0;

  // A code can legitimately appear twice in the computed set (for example a
  // daily and a cumulative variant). Collapse on code so one KPI never writes
  // two rows under the same id.
  const unique = new Map<string, Measured>();
  for (const m of values) if (!unique.has(m.code)) unique.set(m.code, m);

  for (const m of unique.values()) {
    const def = defMap.get(m.code);
    if (!def) continue;

    const status = statusOf(def, m);

    await pool.query(
      `INSERT INTO dypos.kpi_snapshots
         (id, tenant_id, branch_id, kpi_code, scope_date, value,
          benchmark, status, notes)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9)
       ON CONFLICT (tenant_id, kpi_code, scope_date) DO UPDATE SET
         value = EXCLUDED.value, status = EXCLUDED.status,
         benchmark = EXCLUDED.benchmark, notes = EXCLUDED.notes,
         branch_id = EXCLUDED.branch_id, computed_at = NOW()`,
      [`kpi-${branchKey}-${m.code}-${today}`, tenantId, branchId, m.code, today,
        m.value ?? 0, def.benchmark, status, m.note ?? null],
    );
    saved++;

    // Only a genuine breach deserves an alert; "no data" must never page anyone.
    if (status !== 'critical' && status !== 'warn') continue;

    const existing = await pool.query(
      `SELECT id FROM dypos.kpi_alerts
       WHERE tenant_id = $1 AND kpi_code = $2 AND scope_date = $3
         AND status IN ('open','acknowledged')
       LIMIT 1`,
      [tenantId, m.code, today],
    );

    if (existing.rows.length) {
      await pool.query(
        `UPDATE dypos.kpi_alerts SET observed = $2, benchmark = $3 WHERE id = $1`,
        [existing.rows[0].id, m.value ?? 0, def.benchmark],
      );
      continue;
    }

    // A deterministic id keeps a re-run idempotent: the same KPI breaching on the
    // same day updates the existing alert instead of raising a duplicate.
    // A random id here would let a nightly job that runs twice turn one problem
    // into two rows on the dashboard.
    await pool.query(
      `INSERT INTO dypos.kpi_alerts
         (id, tenant_id, branch_id, kpi_code, severity, scope_date, observed,
          benchmark, title, detail, recommended_action)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11)
       ON CONFLICT (id) DO UPDATE SET
         observed = EXCLUDED.observed, severity = EXCLUDED.severity,
         detail = EXCLUDED.detail`,
      [`alr-${branchKey}-${m.code}-${today}`, tenantId, branchId, m.code,
        status, today, m.value ?? 0, def.benchmark,
        `${def.name} — ${status === 'critical' ? 'حرج' : 'تحذير'}`,
        narrate(def, m), def.action],
    );
    alerted++;
  }

  return { saved, alerted, actor, scopeDate: today };
}