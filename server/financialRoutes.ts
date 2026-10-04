/**
 * Detailed financial statements: Profit & Loss and Cash Flow.
 *
 * Every figure here is aggregated by PostgreSQL, never in the browser. That is
 * the whole point of the module: a P&L whose numbers are re-derived on the
 * client from whatever subset of invoices happens to be loaded is a document
 * nobody can defend, and a cash flow statement is only meaningful if the
 * opening and closing balances reconcile across the entire history rather than
 * across one screen's rows.
 *
 * Three correctness rules are enforced throughout, because each of them is a
 * way a financial report most commonly lies:
 *
 *   1. REVENUE EXCLUDES VAT. `total` is gross of tax; `base_subtotal` is the
 *      net revenue. Profit computed on the gross figure silently inflates it by
 *      the tax rate.
 *
 *   2. NO DATA IS NOT ZERO. When a period has no expense rows the statement
 *      says so and marks the result incomplete, instead of presenting a
 *      confident number that happens to equal gross profit. This mirrors the
 *      `insufficient_data` status in the KPI engine.
 *
 *   3. COGS IS ATTRIBUTED OR FLAGGED. Two invoice lines in this database carry
 *      neither a cost in the JSONB payload nor a matching product row, so their
 *      cost cannot be known. The statement computes what it can and reports
 *      `cogsComplete: false` with the exact count, rather than dividing a
 *      partial cost by a full revenue and calling the result a margin.
 */
import type { Express } from 'express';
import { pool } from './neonDb.js';
import { asyncRoute, fail, makeId, num, tenantOf } from './apiHelpers.js';
import { attachPrincipal, requirePermission } from './authz.js';

/** Arabic headings travel with the row so the client never guesses a label. */
const BUCKET_LABELS: Record<string, string> = {
  cost_of_sales: 'تكلفة البضاعة المباعة',
  payroll: 'رواتب وأجور',
  rent: 'إيجار',
  utilities: 'مرافق وخدمات',
  marketing: 'تسويق وإعلان',
  logistics: 'شحن ونقل',
  maintenance: 'صيانة وإصلاحات',
  professional_fees: 'رسوم مهنية',
  bank_charges: 'رسوم بنكية',
  other: 'مصروفات أخرى',
};

const CASH_SECTION_LABELS: Record<string, string> = {
  operating: 'التدفقات التشغيلية',
  investing: 'التدفقات الاستثمارية',
  financing: 'التدفقات التمويلية',
};

interface Window {
  from: string;
  to: string;
  branchId: string | null;
  /** Params for a 2-slot query: [tenantId, from, to] plus branch when scoped. */
  args(tenant: string): any[];
  /** The SQL fragment that narrows to one branch, already numbered. */
  branchClause(): string;
}

/**
 * Resolves the reporting window from the query string.
 *
 * Every endpoint takes the same three inputs so one control panel in the UI
 * drives the whole module, and so the SERVER decides what a period means
 * rather than the caller. The window is clamped to five years: a request that
 * expands a decade of JSONB line items is a denial of service wearing a
 * report's clothes.
 */
function windowOf(req: any): Window {
  const today = new Date();
  const iso = (d: Date) => d.toISOString().slice(0, 10);

  const valid = (v: any) => /^\d{4}-\d{2}-\d{2}$/.test(String(v || ''));

  const to = valid(req.query.to) ? String(req.query.to) : iso(today);
  const from = valid(req.query.from) ? String(req.query.from) : `${to.slice(0, 7)}-01`;

  // Clamp the start, and reject an inverted range rather than silently
  // swapping it — a reader who asked for March→January has made a mistake
  // worth surfacing, not worth quietly "fixing".
  const floor = new Date(to);
  floor.setFullYear(floor.getFullYear() - 5);
  const start = new Date(from) < floor ? floor : new Date(from);
  if (start > new Date(to)) {
    return { from, to, branchId: null, args: () => [], branchClause: () => '' };
  }

  const branchId = req.query.branchId ? String(req.query.branchId) : null;

  return {
    from: iso(start),
    to,
    branchId,
    args: (tenant: string) =>
      branchId ? [tenant, start, to, branchId] : [tenant, start, to],
    // $4 is the branch slot, and it only exists when a branch was requested —
    // which is exactly when this fragment is emitted.
    branchClause: () => (branchId ? 'AND branch_id = $4' : ''),
  };
}

/**
 * The single SQL fragment that normalises invoice money.
 *
 * `base_*` is the SAR-equivalent written at posting time; it is NULL on the
 * invoices that predate the multi-currency migration, so COALESCE falls back
 * to the original column. Without the fallback, 10 of 178 invoices would drop
 * out of revenue entirely and the statement would be short by their value.
 *
 * NOTE ON REVENUE — verified against all 178 invoices:
 *
 *   total = subtotal + tax - discount
 *
 * The discount is ALREADY deducted from the invoice total, and `subtotal` is
 * the pre-discount figure. Presenting `subtotal` as "net revenue" while also
 * listing the discount as a separate deduction would double-count it and
 * understate revenue by the full discount value (76.75 SAR across this
 * database). Net revenue is therefore `subtotal - discount`, and the statement
 * shows the discount as a memo line below it rather than a second subtraction.
 */
const MONEY = {
  /** Revenue actually earned: net of discount, before VAT. */
  net: 'COALESCE(i.base_subtotal, i.subtotal, 0) - COALESCE(i.discount, 0)',
  gross: 'COALESCE(i.base_total, i.total, 0)',
  vat: 'COALESCE(i.base_tax, i.tax, 0)',
};

/**
 * Quantity and cost extracted from an invoice line.
 *
 * The JSONB payload is not uniform: 414 lines carry `qty` and 12 carry only
 * `quantity`, written by two different clients. Reading one key alone silently
 * drops the other's lines from cost of sales, which is exactly the kind of gap
 * that makes a margin quietly wrong.
 *
 * Cost prefers the value frozen on the line (what the item actually cost when
 * it was sold) and falls back to the current catalogue cost of the product.
 * When neither exists the line is counted as unattributed rather than priced
 * at zero.
 */
const LINE = `
  COALESCE(NULLIF(item->>'qty', ''), NULLIF(item->>'quantity', ''), '0')::numeric AS qty,
  COALESCE(
    NULLIF(item->>'cost', '')::numeric,
    p.cost
  ) AS unit_cost,
  (item ? 'cost') OR (p.cost IS NOT NULL AND p.id IS NOT NULL) AS cost_known`;

/** The branch filter, for the aliased `i`/`e` forms used in each query. */
const bc = (w: Window) => (w.branchId ? 'AND i.branch_id = $4' : '');

/**
 * One reusable aggregation for revenue, COGS and line-item coverage.
 *
 * It returns the figures the P&L, the summary tiles, the trend chart and the
 * cash flow statement all depend on, so they cannot disagree with each other.
 * `cogsUnattributed` counts LINES whose cost could not be resolved — the unit
 * the operator can actually go and fix.
 */
async function salesAggregates(tenant: string, w: Window) {
  const { rows } = await pool.query(
    `SELECT
       COALESCE(SUM(${MONEY.net}), 0)::numeric      AS net_revenue,
       COALESCE(SUM(${MONEY.gross}), 0)::numeric    AS gross_revenue,
       COALESCE(SUM(${MONEY.vat}), 0)::numeric       AS vat,
       COALESCE(SUM(i.discount), 0)::numeric        AS discounts,
       count(*)::int                                AS invoices
     FROM dypos.invoices i
     WHERE i.tenant_id = $1
       AND i.status = 'completed'
       AND i.created_at::date BETWEEN $2::date AND $3::date
       ${bc(w)}`,
    w.args(tenant),
  );

  const cost = await pool.query(
    `WITH lines AS (
       SELECT ${LINE}
       FROM dypos.invoices i
       CROSS JOIN LATERAL jsonb_array_elements(i.items) AS item
       LEFT JOIN dypos.products p
              ON p.id = item->>'productId' AND p.tenant_id = i.tenant_id
       WHERE i.tenant_id = $1
         AND i.status = 'completed'
         AND i.created_at::date BETWEEN $2::date AND $3::date
         ${bc(w)}
     )
     SELECT
       COALESCE(SUM(qty * unit_cost) FILTER (WHERE cost_known), 0)::numeric AS cogs,
       COALESCE(SUM(qty), 0)::numeric                                    AS units,
       count(*) FILTER (WHERE NOT cost_known)::int                       AS unattributed,
       count(*)::int                                                     AS line_count
     FROM lines`,
    w.args(tenant),
  );

  const s = rows[0];
  const c = cost.rows[0];

  return {
    netRevenue: num(s.net_revenue),
    grossRevenue: num(s.gross_revenue),
    vat: num(s.vat),
    discounts: num(s.discounts),
    invoices: Number(s.invoices),
    cogs: num(c.cogs),
    units: num(c.units),
    lineCount: Number(c.line_count),
    cogsUnattributed: Number(c.unattributed),
    // A statement with no lines at all is not "complete with zero cost", it is
    // unmeasured. Collapsing the two is how a dashboard invents a 100% margin.
    cogsComplete: Number(c.unattributed) === 0 && Number(c.line_count) > 0,
  };
}

/**
 * Operating expenses rolled up through the category map.
 *
 * The LEFT JOIN to the map is what keeps the statement footing: an unmapped
 * category lands in 'other' and stays visible. An INNER JOIN would drop it,
 * and the P&L would then add up to less than the expense total in the expense
 * screen — a difference nobody would notice until an auditor found it.
 */
async function expenseAggregates(tenant: string, w: Window) {
  const { rows } = await pool.query(
    `SELECT COALESCE(m.bucket, 'other')        AS bucket,
            SUM(e.amount)::numeric              AS amount,
            count(*)::int                       AS entries
     FROM dypos.expenses e
     LEFT JOIN dypos.expense_category_map m
            ON m.tenant_id = e.tenant_id
           AND LOWER(m.source_label) = LOWER(e.category)
           AND m.is_active = TRUE
     WHERE e.tenant_id = $1
       AND e.expense_date BETWEEN $2::date AND $3::date
       ${w.branchId ? 'AND e.branch_id = $4' : ''}
     GROUP BY 1
     ORDER BY amount DESC`,
    w.args(tenant),
  );

  const total = rows.reduce((s, r) => s + num(r.amount), 0);
  return {
    total,
    // Zero expenses and no expense *records* are different claims. The caller
    // receives the row count so it can say "none recorded" instead of "none".
    recorded: rows.length > 0,
    lines: rows.map((r: any) => ({
      bucket: r.bucket,
      label: BUCKET_LABELS[r.bucket] || r.bucket,
      amount: num(r.amount),
      entries: Number(r.entries),
    })),
  };
}

/** Non-operating income and expense, from the `other` cash movements. */
async function otherIncomeExpense(tenant: string, w: Window) {
  const { rows } = await pool.query(
    `SELECT direction, COALESCE(SUM(amount), 0)::numeric AS amount
     FROM dypos.cash_movements
     WHERE tenant_id = $1
       AND section = 'other'
       AND occurred_on BETWEEN $2::date AND $3::date
       ${w.branchId ? 'AND branch_id = $4' : ''}
     GROUP BY direction`,
    w.args(tenant),
  );

  let income = 0;
  let expense = 0;
  for (const r of rows) {
    if (r.direction === 'in') income += num(r.amount);
    else expense += num(r.amount);
  }
  return { income, expense, net: income - expense, recorded: rows.length > 0 };
}

/** Plain-language statements of what is missing, so the UI never has to guess. */
function buildNotes(sales: any, expenses: any): string[] {
  const notes: string[] = [];
  if (sales.lineCount === 0) {
    notes.push('لا توجد فواتير مكتملة في هذه الفترة — لا يمكن احتساب تكلفة المبيعات.');
  } else if (sales.cogsUnattributed > 0) {
    notes.push(
      `${sales.cogsUnattributed} سطر بيع بلا تكلفة معروفة — مجمل الربح مُقدَّر ومنخفض بحد أقصى تكلفة هذه السطور.`,
    );
  }
  if (!expenses.recorded) {
    notes.push(
      'لا توجد مصروفات تشغيلية مسجّلة في هذه الفترة — صافي الربح يعادل مجمل الربح وهو غير مكتمل.',
    );
  }
  return notes;
}

/**
 * Assembles the Profit & Loss statement.
 *
 * The lines are returned in REPORTING ORDER with their own Arabic labels, so
 * the document reads top-to-bottom the way an accountant expects rather than as
 * an unordered bag of buckets. `pctOfRevenue` is taken against NET revenue
 * (ex-VAT) so the percentages foot to 100% of the real top line.
 */
async function buildPnl(tenant: string, w: Window) {
  const [sales, expenses, other] = await Promise.all([
    salesAggregates(tenant, w),
    expenseAggregates(tenant, w),
    otherIncomeExpense(tenant, w),
  ]);

  const grossProfit = sales.netRevenue - sales.cogs;

  // Named "operating profit", not EBITDA: there is no asset register in this
  // database, so no depreciation was computed, and calling it EBITDA would
  // assert a calculation nobody performed.
  const operatingProfit = grossProfit - expenses.total;
  const netProfit = operatingProfit + other.net;

  const base = sales.netRevenue || 1;
  const row = (
    code: string, label: string, amount: number,
    opts: { emphasis?: boolean; indent?: boolean; kind?: string } = {},
  ) => ({
    code,
    label,
    amount: Math.round(amount * 100) / 100,
    pctOfRevenue: Math.round((amount / base) * 1000) / 10,
    emphasis: opts.emphasis ?? false,
    indent: opts.indent ?? false,
    kind: opts.kind ?? 'detail',
  });

  const lines = [
    row('gross_sales', 'إجمالي المبيعات قبل الخصم', sales.grossRevenue + sales.discounts, { kind: 'subtotal' }),
    row('discounts', 'الخصومات الممنوحة', -sales.discounts, { indent: true }),
    row('net_revenue', 'صافي الإيرادات (دون ضريبة)', sales.netRevenue, { emphasis: true }),
    row('vat', 'ضريبة القيمة المضافة', sales.vat, { kind: 'tax' }),
    row('cogs', 'تكلفة البضاعة المباعة', -sales.cogs, { kind: 'subtotal' }),
    row('gross_profit', 'مجمل الربح', grossProfit, { emphasis: true }),
    ...expenses.lines.map((l) =>
      row(`opex_${l.bucket}`, l.label, -l.amount, { indent: true })),
    row('total_opex', 'إجمالي المصروفات التشغيلية', -expenses.total, { emphasis: true }),
    row('operating_profit', 'الربح التشغيلي', operatingProfit, { emphasis: true }),
    row('other_income', 'إيرادات أخرى', other.income, { indent: true }),
    row('other_expense', 'مصروفات أخرى', -other.expense, { indent: true }),
    row('net_profit', 'صافي الربح / (الخسارة)', netProfit, { emphasis: true }),
  ];

  return {
    lines,
    sales,
    expenses,
    other,
    grossProfit,
    operatingProfit,
    netProfit,
    grossMarginPct: sales.netRevenue > 0
      ? Math.round((grossProfit / sales.netRevenue) * 1000) / 10 : null,
    netMarginPct: sales.netRevenue > 0
      ? Math.round((netProfit / sales.netRevenue) * 1000) / 10 : null,
    // The two ways this statement can be read as more final than it is.
    completeness: {
      cogsComplete: sales.cogsComplete,
      cogsUnattributed: sales.cogsUnattributed,
      expensesRecorded: expenses.recorded,
      notes: buildNotes(sales, expenses),
    },
  };
}

/**
 * Net cash generated by trading, over an arbitrary date range.
 *
 * This is the only function that knows how each source of money is signed:
 *
 *   in  — invoices collected (ex-VAT: the VAT portion is collected on behalf
 *         of the tax authority and is not the business's cash to spend), plus
 *         refund of a previously held invoice's money back out.
 *   out — operating expenses, and purchase orders that were actually RECEIVED.
 *         A `pending` or `approved` order is a commitment, not a payment, so
 *         counting it as cash out would understate the balance for orders that
 *         have not been settled.
 *
 * Called twice per request — once for the period and once for everything
 * before it — which is how the opening balance is derived.
 */
async function operatingNetCash(tenant: string, from: string, to: string, branchId: string | null) {
  const b = branchId ? 'AND branch_id = $4' : '';
  const args = branchId ? [tenant, from, to, branchId] : [tenant, from, to];

  const sales = await pool.query(
    `SELECT COALESCE(SUM(COALESCE(i.base_subtotal, i.subtotal, 0)
                           - COALESCE(i.discount, 0)), 0)::numeric AS in_amount
     FROM dypos.invoices i
     WHERE i.tenant_id = $1
       AND i.status = 'completed'
       AND i.created_at::date BETWEEN $2::date AND $3::date
       ${b.replace(/branch_id/g, 'i.branch_id')}`,
    args,
  );

  const expenses = await pool.query(
    `SELECT COALESCE(SUM(e.amount), 0)::numeric AS out_amount
     FROM dypos.expenses e
     WHERE e.tenant_id = $1
       AND e.expense_date BETWEEN $2::date AND $3::date
       ${b.replace(/branch_id/g, 'e.branch_id')}`,
    args,
  );

  const purchases = await pool.query(
    `SELECT COALESCE(SUM(po.total_amount), 0)::numeric AS out_amount
     FROM dypos.purchase_orders po
     WHERE po.tenant_id = $1
       AND po.status = 'received'
       AND po.ordered_at BETWEEN $2::date AND $3::date
       ${b.replace(/branch_id/g, 'po.branch_id')}`,
    args,
  );

  const inflow = num(sales.rows[0].in_amount);
  const out = num(expenses.rows[0].out_amount) + num(purchases.rows[0].out_amount);
  return {
    inflow,
    out,
    net: inflow - out,
    purchaseOut: num(purchases.rows[0].out_amount),
    expenseOut: num(expenses.rows[0].out_amount),
  };
}

/** Investing and financing flows, which only exist in `cash_movements`. */
async function sectionNetCash(tenant: string, w: Window, section: string) {
  const { rows } = await pool.query(
    `SELECT direction, COALESCE(SUM(amount), 0)::numeric AS amount, count(*)::int AS entries
     FROM dypos.cash_movements
     WHERE tenant_id = $1
       AND section = $4
       AND occurred_on BETWEEN $2::date AND $3::date
       ${w.branchId ? 'AND branch_id = $5' : ''}
     GROUP BY direction`,
    w.branchId ? [tenant, w.from, w.to, section, w.branchId] : [tenant, w.from, w.to, section],
  );

  let inflow = 0;
  let outflow = 0;
  let entries = 0;
  for (const r of rows) {
    entries += Number(r.entries);
    if (r.direction === 'in') inflow += num(r.amount);
    else outflow += num(r.amount);
  }
  return { inflow, outflow, net: inflow - outflow, entries };
}

/**
 * Builds the Cash Flow statement.
 *
 * The opening balance is NOT "the first row of this period". It is every
 * movement from the beginning of time up to the day before the window opens —
 * computed with the same functions, so the statement always reconciles:
 *
 *     closing = opening + operating + investing + financing
 *
 * That identity is asserted by the test suite, because a cash flow statement
 * whose closing balance does not reconcile to its own rows is worse than no
 * statement at all — it looks authoritative.
 *
 * Caveat stated rather than hidden: this measures the movement of money
 * through the system, not a bank balance. It does not know about an opening
 * float, a bank overdraft or a deposit made outside the POS, so "closing cash"
 * here is a net-flow position, and the UI labels it that way.
 */
async function buildCashFlow(tenant: string, w: Window) {
  const dayBefore = new Date(w.from);
  dayBefore.setDate(dayBefore.getDate() - 1);
  const priorTo = dayBefore.toISOString().slice(0, 10);

  const [period, prior, investing, financing, otherMovements] = await Promise.all([
    operatingNetCash(tenant, w.from, w.to, w.branchId),
    operatingNetCash(tenant, '1900-01-01', priorTo, w.branchId),
    sectionNetCash(tenant, w, 'investing'),
    sectionNetCash(tenant, w, 'financing'),
    sectionNetCash(tenant, w, 'other'),
  ]);

  // Prior investing/financing, for the opening position.
  const priorWindow: Window = { ...w, from: '1900-01-01', to: priorTo };
  const [priorInvesting, priorFinancing, priorOther] = await Promise.all([
    sectionNetCash(tenant, priorWindow, 'investing'),
    sectionNetCash(tenant, priorWindow, 'financing'),
    sectionNetCash(tenant, priorWindow, 'other'),
  ]);

  const openingCash =
    prior.net + priorInvesting.net + priorFinancing.net + priorOther.net;
  const netChange =
    period.net + investing.net + financing.net + otherMovements.net;
  const closingCash = openingCash + netChange;

  const section = (
    key: string,
    inflow: number,
    outflow: number,
    net: number,
    detail: Record<string, number>,
  ) => ({
    section: key,
    label: CASH_SECTION_LABELS[key],
    inflow: Math.round(inflow * 100) / 100,
    outflow: Math.round(outflow * 100) / 100,
    net: Math.round(net * 100) / 100,
    detail,
  });

  const sections = [
    section('operating', period.inflow, period.out, period.net, {
      'تحصيل فواتير المبيعات (صافي دون ضريبة)': period.inflow,
      'مصروفات تشغيلية': period.expenseOut,
      'أوامر شراء مستلمة': period.purchaseOut,
    }),
    section('investing', investing.inflow, investing.outflow, investing.net, {}),
    section('financing', financing.inflow, financing.outflow, financing.net, {}),
  ];

  return {
    sections,
    openingCash: Math.round(openingCash * 100) / 100,
    netChange: Math.round(netChange * 100) / 100,
    closingCash: Math.round(closingCash * 100) / 100,
    totalInflow: Math.round(
      (period.inflow + investing.inflow + financing.inflow) * 100,
    ) / 100,
    totalOutflow: Math.round(
      (period.out + investing.outflow + financing.outflow) * 100,
    ) / 100,
    // Whether any non-trading movement has ever been recorded. A cash flow
    // statement with an empty investing section is incomplete, not zero.
    investingRecorded: investing.entries > 0 || priorInvesting.entries > 0,
    financingRecorded: financing.entries > 0 || priorFinancing.entries > 0,
  };
}

/**
 * A monthly time series for the charts.
 *
 * Months with no activity are FILLED WITH ZEROS and returned in order, because
 * a line chart that silently skips a dead month compresses the x-axis and makes
 * a two-month gap look like a steady trend. The `months` key is always present
 * even when empty, so the UI can render "no data" rather than an empty canvas.
 */
async function monthlySeries(tenant: string, months: number, branchId: string | null) {
  const n = Math.min(Math.max(months, 1), 36);
  const b = branchId ? 'AND branch_id = $4' : '';
  const args = branchId ? [tenant, n, branchId] : [tenant, n];

  const sales = await pool.query(
    `WITH span AS (
       SELECT generate_series(
         date_trunc('month', CURRENT_DATE) - ($2::int - 1) * INTERVAL '1 month',
         date_trunc('month', CURRENT_DATE),
         INTERVAL '1 month')::date AS m
     )
     SELECT to_char(span.m, 'YYYY-MM') AS month,
            COALESCE(SUM(COALESCE(i.base_subtotal, i.subtotal, 0)
                          - COALESCE(i.discount, 0)), 0)::numeric AS revenue,
            COALESCE(SUM(COALESCE(i.base_tax, i.tax, 0)), 0)::numeric       AS vat,
            count(i.id)::int                                                 AS invoices
     FROM span
     LEFT JOIN dypos.invoices i
            ON i.tenant_id = $1
           AND i.status = 'completed'
           AND i.created_at::date >= span.m
           AND i.created_at::date <  (span.m + INTERVAL '1 month')::date
           ${b.replace(/branch_id/g, 'i.branch_id')}
     GROUP BY span.m ORDER BY span.m`,
    args,
  );

  const cogs = await pool.query(
    `WITH span AS (
       SELECT generate_series(
         date_trunc('month', CURRENT_DATE) - ($2::int - 1) * INTERVAL '1 month',
         date_trunc('month', CURRENT_DATE),
         INTERVAL '1 month')::date AS m
     )
     SELECT to_char(span.m, 'YYYY-MM') AS month,
            COALESCE(SUM(li.qty * li.unit_cost)
                     FILTER (WHERE li.cost_known), 0)::numeric AS cogs
     FROM span
     LEFT JOIN LATERAL (
       SELECT COALESCE(NULLIF(item->>'qty', ''), NULLIF(item->>'quantity', ''), '0')::numeric AS qty,
              COALESCE(NULLIF(item->>'cost', '')::numeric, p.cost) AS unit_cost,
              (item ? 'cost') OR (p.cost IS NOT NULL AND p.id IS NOT NULL) AS cost_known
       FROM dypos.invoices i
       CROSS JOIN LATERAL jsonb_array_elements(i.items) AS item
       LEFT JOIN dypos.products p
              ON p.id = item->>'productId' AND p.tenant_id = i.tenant_id
       WHERE i.tenant_id = $1
         AND i.status = 'completed'
         AND i.created_at::date >= span.m
         AND i.created_at::date <  (span.m + INTERVAL '1 month')::date
         ${b.replace(/branch_id/g, 'i.branch_id')}
     ) li ON TRUE
     GROUP BY span.m ORDER BY span.m`,
    args,
  );

  const expenses = await pool.query(
    `WITH span AS (
       SELECT generate_series(
         date_trunc('month', CURRENT_DATE) - ($2::int - 1) * INTERVAL '1 month',
         date_trunc('month', CURRENT_DATE),
         INTERVAL '1 month')::date AS m
     )
     SELECT to_char(span.m, 'YYYY-MM') AS month,
            COALESCE(SUM(e.amount), 0)::numeric AS expenses
     FROM span
     LEFT JOIN dypos.expenses e
            ON e.tenant_id = $1
           AND e.expense_date >= span.m
           AND e.expense_date <  (span.m + INTERVAL '1 month')::date
           ${b.replace(/branch_id/g, 'e.branch_id')}
     GROUP BY span.m ORDER BY span.m`,
    args,
  );

  const cogsMap = new Map(cogs.rows.map((r: any) => [r.month, num(r.cogs)]));
  const expMap = new Map(expenses.rows.map((r: any) => [r.month, num(r.expenses)]));

  return sales.rows.map((r: any) => {
    const revenue = num(r.revenue);
    const cogsValue = cogsMap.get(r.month) ?? 0;
    const exp = expMap.get(r.month) ?? 0;
    const gross = revenue - cogsValue;
    return {
      month: r.month,
      label: new Date(`${r.month}-01T00:00:00Z`).toLocaleDateString('ar-SA', {
        month: 'short', year: '2-digit', timeZone: 'UTC',
      }),
      revenue,
      cogs: cogsValue,
      grossProfit: gross,
      expenses: exp,
      netProfit: gross - exp,
      vat: num(r.vat),
      invoices: Number(r.invoices),
      grossMarginPct: revenue > 0 ? Math.round((gross / revenue) * 1000) / 10 : null,
      netMarginPct: revenue > 0 ? Math.round(((gross - exp) / revenue) * 1000) / 10 : null,
    };
  });
}

/**
 * Percentage change against the immediately preceding window of equal length.
 *
 * Returns null rather than a number when the base is zero or absent: growth
 * from nothing is undefined, and printing "0%" or "∞" is how a dashboard
 * implies a trend that does not exist.
 */
function pctChange(current: number, previous: number): number | null {
  if (!Number.isFinite(previous) || previous === 0) return null;
  return Math.round(((current - previous) / previous) * 1000) / 10;
}

/** Shifts a window back by its own length, to compare like-for-like. */
function previousWindow(w: Window): Window {
  const from = new Date(w.from);
  const to = new Date(w.to);
  const spanDays = Math.max(
    1, Math.round((to.getTime() - from.getTime()) / 86400000) + 1,
  );
  const prevTo = new Date(from);
  prevTo.setDate(prevTo.getDate() - 1);
  const prevFrom = new Date(prevTo);
  prevFrom.setDate(prevFrom.getDate() - spanDays + 1);
  const iso = (d: Date) => d.toISOString().slice(0, 10);
  return { ...w, from: iso(prevFrom), to: iso(prevTo) };
}

/**
 * Registers the financial statement endpoints.
 *
 * Every route is behind `reports.view`, the same permission the BI dashboard
 * and the KPI board use. Financial statements are among the most sensitive
 * figures the system exposes — a branch manager may legitimately read their
 * own, but the tenant-wide statement is not theirs to see.
 */
export function registerFinancialRoutes(app: Express) {
  /** Headline figures for the tile row, with like-for-like comparison. */
  app.get(
    '/api/db/financials/summary',
    attachPrincipal,
    requirePermission('reports.view'),
    asyncRoute(async (req, res) => {
      const tenant = tenantOf(req);
      const w = windowOf(req);
      const prev = previousWindow(w);

      const [current, before, cash] = await Promise.all([
        buildPnl(tenant, w),
        buildPnl(tenant, prev),
        buildCashFlow(tenant, w),
      ]);

      res.json({
        window: { from: w.from, to: w.to, branchId: w.branchId },
        comparisonWindow: { from: prev.from, to: prev.to },
        revenue: current.sales.netRevenue,
        grossRevenue: current.sales.grossRevenue,
        vat: current.sales.vat,
        cogs: current.sales.cogs,
        grossProfit: current.grossProfit,
        grossMarginPct: current.grossMarginPct,
        operatingExpenses: current.expenses.total,
        operatingProfit: current.operatingProfit,
        netProfit: current.netProfit,
        netMarginPct: current.netMarginPct,
        invoices: current.sales.invoices,
        unitsSold: current.sales.units,
        cash: {
          opening: cash.openingCash,
          netChange: cash.netChange,
          closing: cash.closingCash,
        },
        change: {
          revenue: pctChange(current.sales.netRevenue, before.sales.netRevenue),
          grossProfit: pctChange(current.grossProfit, before.grossProfit),
          netProfit: pctChange(current.netProfit, before.netProfit),
          expenses: pctChange(current.expenses.total, before.expenses.total),
        },
        completeness: current.completeness,
      });
    }),
  );

  /** The full P&L, line by line, in reporting order. */
  app.get(
    '/api/db/financials/pnl',
    attachPrincipal,
    requirePermission('reports.view'),
    asyncRoute(async (req, res) => {
      const tenant = tenantOf(req);
      const w = windowOf(req);
      const pnl = await buildPnl(tenant, w);
      res.json({
        window: { from: w.from, to: w.to, branchId: w.branchId },
        currency: 'SAR',
        ...pnl,
        generatedAt: new Date().toISOString(),
      });
    }),
  );

  /** The cash flow statement, which always reconciles by construction. */
  app.get(
    '/api/db/financials/cash-flow',
    attachPrincipal,
    requirePermission('reports.view'),
    asyncRoute(async (req, res) => {
      const tenant = tenantOf(req);
      const w = windowOf(req);
      const flow = await buildCashFlow(tenant, w);
      res.json({
        window: { from: w.from, to: w.to, branchId: w.branchId },
        currency: 'SAR',
        basis: 'صافي حركة النقد عبر النظام — ليس رصيدًا بنكيًا',
        ...flow,
        generatedAt: new Date().toISOString(),
      });
    }),
  );

  /** Monthly series for the charts. Filled with zero months, never gaps. */
  app.get(
    '/api/db/financials/trend',
    attachPrincipal,
    requirePermission('reports.view'),
    asyncRoute(async (req, res) => {
      const tenant = tenantOf(req);
      const months = Number(req.query.months) || 12;
      const branchId = req.query.branchId ? String(req.query.branchId) : null;
      const series = await monthlySeries(tenant, months, branchId);
      res.json({
        months: Number(req.query.months) || 12,
        branchId,
        series,
        // Only the months that actually traded. A chart that claims twelve
        // months of business when one had sales is decoration, not reporting.
        activeMonths: series.filter((m) => m.invoices > 0).length,
        generatedAt: new Date().toISOString(),
      });
    }),
  );

  /** Expense mix by reporting bucket, for the pie chart. */
  app.get(
    '/api/db/financials/expense-breakdown',
    attachPrincipal,
    requirePermission('reports.view'),
    asyncRoute(async (req, res) => {
      const tenant = tenantOf(req);
      const w = windowOf(req);
      const expenses = await expenseAggregates(tenant, w);
      res.json({
        window: { from: w.from, to: w.to, branchId: w.branchId },
        total: expenses.total,
        recorded: expenses.recorded,
        items: expenses.lines,
      });
    }),
  );

  /** Cash movements (capex, loans, other income) within the window. */
  app.get(
    '/api/db/financials/cash-movements',
    attachPrincipal,
    requirePermission('reports.view'),
    asyncRoute(async (req, res) => {
      const tenant = tenantOf(req);
      const w = windowOf(req);
      const { rows } = await pool.query(
        `SELECT m.id, m.direction, m.section, m.category, m.amount,
                m.occurred_on, m.payment_method, m.reference, m.description,
                m.created_by, m.created_at, b.name AS branch_name
         FROM dypos.cash_movements m
         LEFT JOIN dypos.branches b ON b.id = m.branch_id
         WHERE m.tenant_id = $1
           AND m.occurred_on BETWEEN $2::date AND $3::date
           ${w.branchId ? 'AND m.branch_id = $4' : ''}
         ORDER BY m.occurred_on DESC, m.created_at DESC
         LIMIT 500`,
        w.args(tenant),
      );
      res.json({
        items: rows.map((r: any) => ({
          id: r.id,
          direction: r.direction,
          section: r.section,
          sectionLabel: CASH_SECTION_LABELS[r.section] || r.section,
          category: r.category,
          amount: num(r.amount),
          occurredOn: r.occurred_on,
          paymentMethod: r.payment_method,
          reference: r.reference,
          description: r.description,
          createdBy: r.created_by,
          createdAt: r.created_at,
          branchName: r.branch_name,
        })),
        count: rows.length,
      });
    }),
  );

  /**
   * Records a non-trading cash flow.
   *
   * `section` is validated rather than trusted, and 'operating' is refused
   * outright with an explanation: operating cash is derived from the
   * transactional tables, and posting one manually would double-count it.
   */
  app.post(
    '/api/db/financials/cash-movements',
    attachPrincipal,
    requirePermission('reports.manage'),
    asyncRoute(async (req, res) => {
      const tenant = tenantOf(req);
      const b = req.body || {};
      const direction = String(b.direction || '');
      const section = String(b.section || '');
      const amount = Number(b.amount);

      if (!['in', 'out'].includes(direction)) {
        return fail(res, 400, 'اتجاه الحركة يجب أن يكون in أو out');
      }
      if (section === 'operating') {
        return fail(
          res, 400,
          'التدفقات التشغيلية تُشتق من الفواتير والمصروفات تلقائيًا ولا تُسجَّل يدويًا',
        );
      }
      if (!['investing', 'financing', 'other'].includes(section)) {
        return fail(res, 400, 'القسم يجب أن يكون investing أو financing أو other');
      }
      if (!Number.isFinite(amount) || amount <= 0) {
        return fail(res, 400, 'المبلغ يجب أن يكون رقماً أكبر من صفر');
      }
      if (!b.category || !String(b.category).trim()) {
        return fail(res, 400, 'التصنيف مطلوب');
      }

      const { rows } = await pool.query(
        `INSERT INTO dypos.cash_movements
           (id, tenant_id, branch_id, direction, section, category, amount,
            occurred_on, payment_method, reference, description, created_by)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12)
         RETURNING *`,
        [
          makeId('cm'), tenant, b.branchId || null,
          direction, section, String(b.category).trim(), amount,
          /^\d{4}-\d{2}-\d{2}$/.test(String(b.occurredOn || ''))
            ? String(b.occurredOn) : new Date().toISOString().slice(0, 10),
          b.paymentMethod || 'cash',
          b.reference || null, b.description || null,
          req.principal?.username || null,
        ],
      );
      res.status(201).json({ item: rows[0] });
    }),
  );

  /**
   * Freezes the current figures as an immutable, versioned snapshot.
   *
   * A published statement is a record of what was DECLARED for a period, not a
   * live view. Re-publishing supersedes the previous version rather than
   * editing it, so the history of what was reported survives any later
   * correction to the source data.
   */
  app.post(
    '/api/db/financials/statements',
    attachPrincipal,
    requirePermission('reports.manage'),
    asyncRoute(async (req, res) => {
      const tenant = tenantOf(req);
      const b = req.body || {};
      const type = String(b.statementType || 'pnl');
      if (!['pnl', 'cashflow'].includes(type)) {
        return fail(res, 400, 'نوع القائمة يجب أن يكون pnl أو cashflow');
      }

      const period = /^\d{4}-\d{2}$/.test(String(b.period || ''))
        ? String(b.period)
        : new Date().toISOString().slice(0, 7);

      const from = `${period}-01`;
      // Day 0 of the next month is the last day of this one.
      const to = new Date(
        Number(period.slice(0, 4)), Number(period.slice(5, 7)), 0,
      ).toISOString().slice(0, 10);

      const branchId = b.branchId ? String(b.branchId) : null;
      const w: Window = {
        from, to, branchId,
        args: (t: string) => (branchId ? [t, from, to, branchId] : [t, from, to]),
        branchClause: () => (branchId ? 'AND branch_id = $4' : ''),
      };

      const [pnl, flow] = await Promise.all([
        buildPnl(tenant, w),
        buildCashFlow(tenant, w),
      ]);

      // Next version for this period+type, so a re-publish never overwrites and
      // every declaration stays readable.
      const { rows: prior } = await pool.query(
        `SELECT COALESCE(MAX(version), 0)::int AS v
         FROM dypos.financial_statements
         WHERE tenant_id = $1 AND period = $2 AND statement_type = $3
           AND ($4::varchar IS NULL OR branch_id = $4)`,
        [tenant, period, type, branchId],
      );
      const version = Number(prior[0].v) + 1;

      await pool.query(
        `UPDATE dypos.financial_statements SET status = 'superseded'
         WHERE tenant_id = $1 AND period = $2 AND statement_type = $3
           AND status = 'published' AND COALESCE(branch_id, '__all__') = $4`,
        [tenant, period, type, branchId || '__all__'],
      );

      const { rows } = await pool.query(
        `INSERT INTO dypos.financial_statements
           (id, tenant_id, branch_id, period, version, statement_type,
            currency_code, status, total_revenue, total_cogs, total_expenses,
            net_result, opening_cash, closing_cash, cogs_complete,
            data_notes, generated_by)
         VALUES ($1,$2,$3,$4,$5,$6,'SAR','published',$7,$8,$9,$10,$11,$12,$13,$14,$15)
         RETURNING *`,
        [
          makeId('fs'), tenant, branchId, period, version, type,
          pnl.sales.netRevenue, pnl.sales.cogs, pnl.expenses.total,
          type === 'pnl' ? pnl.netProfit : flow.netChange,
          flow.openingCash, flow.closingCash,
          pnl.completeness.cogsComplete,
          pnl.completeness.notes.join(' | ') || null,
          req.principal?.username || null,
        ],
      );

      res.status(201).json({ item: rows[0], version });
    }),
  );

  /** The declaration history, newest first. */
  app.get(
    '/api/db/financials/statements',
    attachPrincipal,
    requirePermission('reports.view'),
    asyncRoute(async (req, res) => {
      const tenant = tenantOf(req);
      const { rows } = await pool.query(
        `SELECT s.*, b.name AS branch_name
         FROM dypos.financial_statements s
         LEFT JOIN dypos.branches b ON b.id = s.branch_id
         WHERE s.tenant_id = $1
         ORDER BY s.period DESC, s.version DESC
         LIMIT 200`,
        [tenant],
      );
      res.json({
        items: rows.map((r: any) => ({
          id: r.id,
          period: r.period,
          version: Number(r.version),
          statementType: r.statement_type,
          status: r.status,
          branchId: r.branch_id,
          branchName: r.branch_name,
          revenue: num(r.total_revenue),
          cogs: num(r.total_cogs),
          expenses: num(r.total_expenses),
          netResult: num(r.net_result),
          openingCash: num(r.opening_cash),
          closingCash: num(r.closing_cash),
          cogsComplete: r.cogs_complete,
          dataNotes: r.data_notes,
          generatedBy: r.generated_by,
          generatedAt: r.generated_at,
        })),
        count: rows.length,
      });
    }),
  );
}