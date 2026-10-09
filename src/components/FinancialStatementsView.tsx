import React, { useCallback, useEffect, useMemo, useState } from 'react';
import {
  Scale, TrendingUp, TrendingDown, Wallet, Download, RefreshCw,
  AlertTriangle, CheckCircle2, HelpCircle, ArrowLeftRight, Landmark, PiggyBank,
} from 'lucide-react';
import { apiGet, apiPost, sar } from '../services/dyposApi';
import { useAuthz } from '../contexts/AuthzContext';
import {
  AreaChart, Area, BarChart, Bar, ComposedChart, Line, PieChart, Pie, Cell,
  XAxis, YAxis, CartesianGrid, Tooltip, ResponsiveContainer, Legend, ReferenceLine,
} from 'recharts';

/* =========================================================================
 * Types — the shapes the server actually returns.
 * ====================================================================== */

interface PnlLine {
  code: string;
  label: string;
  amount: number;
  pctOfRevenue: number;
  emphasis: boolean;
  indent: boolean;
  kind: string;
}

interface Completeness {
  cogsComplete: boolean;
  cogsUnattributed: number;
  expensesRecorded: boolean;
  notes: string[];
}

interface Summary {
  window: { from: string; to: string; branchId: string | null };
  comparisonWindow: { from: string; to: string };
  revenue: number;
  grossRevenue: number;
  vat: number;
  cogs: number;
  grossProfit: number;
  grossMarginPct: number | null;
  operatingExpenses: number;
  operatingProfit: number;
  netProfit: number;
  netMarginPct: number | null;
  invoices: number;
  unitsSold: number;
  cash: { opening: number; netChange: number; closing: number };
  change: {
    revenue: number | null;
    grossProfit: number | null;
    netProfit: number | null;
    expenses: number | null;
  };
  completeness: Completeness;
}

interface Pnl {
  lines: PnlLine[];
  completeness: Completeness;
  grossMarginPct: number | null;
  netMarginPct: number | null;
}

interface CashSection {
  section: string;
  label: string;
  inflow: number;
  outflow: number;
  net: number;
  detail: Record<string, number>;
}

interface CashFlow {
  sections: CashSection[];
  openingCash: number;
  netChange: number;
  closingCash: number;
  totalInflow: number;
  totalOutflow: number;
  investingRecorded: boolean;
  financingRecorded: boolean;
  basis: string;
}

interface TrendPoint {
  month: string;
  label: string;
  revenue: number;
  cogs: number;
  grossProfit: number;
  expenses: number;
  netProfit: number;
  invoices: number;
  grossMarginPct: number | null;
  netMarginPct: number | null;
}

interface ExpenseMix {
  bucket: string;
  label: string;
  amount: number;
  entries: number;
}

/* =========================================================================
 * Presentation constants.
 * ====================================================================== */

const PIE_COLORS = ['#10b981', '#3b82f6', '#f59e0b', '#8b5cf6', '#ef4444',
  '#14b8a6', '#ec4899', '#6366f1'];

const money = (v: number) => `${v.toLocaleString('ar-SA', { maximumFractionDigits: 0 })} ر.س`;
const compact = (v: number) => `${v.toLocaleString('ar-SA', { maximumFractionDigits: 1 })}K`;

/**
 * A change that could not be computed renders as an em-dash, never as 0%.
 *
 * "0%" and "no previous period" are different facts, and a tile that shows
 * both as zero is a tile that lies about the business being flat.
 */
const Delta: React.FC<{ value: number | null; label: string; invert?: boolean }> = ({
  value, label, invert = false,
}) => {
  if (value === null || !Number.isFinite(value)) {
    return (
      <span className="text-[11px] text-muted flex items-center gap-1">
        <HelpCircle className="w-3 h-3" /> لا توجد فترة سابقة للمقارنة
      </span>
    );
  }
  // `invert`: for costs, a rise is bad — the arrow colour follows the
  // arithmetic, not the direction of travel.
  const good = invert ? value <= 0 : value >= 0;
  const Icon = value >= 0 ? TrendingUp : TrendingDown;
  return (
    <span className={`text-[11px] flex items-center gap-1 ${good ? 'text-brand' : 'text-err-strong'}`}>
      <Icon className="w-3 h-3" />
      {value >= 0 ? '+' : ''}{value}% {label}
    </span>
  );
};

const Stat: React.FC<{
  label: string;
  value: number | null;
  hint?: React.ReactNode;
  icon: any;
  tone?: 'positive' | 'sky' | 'amber' | 'violet' | 'rose';
  isCurrency?: boolean;
}> = ({ label, value, hint, icon: Icon, tone = 'positive', isCurrency = true }) => {
  const tones: Record<string, string> = {
    positive: 'bg-brand-soft text-brand',
    sky: 'bg-info-soft text-info-strong',
    amber: 'bg-warn-soft text-warn-strong',
    violet: 'bg-violet-500/10 text-violet-400',
    rose: 'bg-err-soft text-err-strong',
  };
  return (
    <div className="surface-card rounded-2xl p-5 shadow-sm">
      <div className="flex items-center justify-between mb-3">
        <span className="text-xs text-faint">{label}</span>
        <div className={`w-9 h-9 rounded-xl flex items-center justify-center ${tones[tone]}`}>
          <Icon className="w-5 h-5" />
        </div>
      </div>
      <p className="text-2xl font-black text-ink font-mono">
        {value === null ? '—' : isCurrency ? money(value) : value.toLocaleString('ar-SA')}
      </p>
      {hint && <div className="mt-1">{hint}</div>}
    </div>
  );
};

/** The first and last day of the current month, for the default window. */
const monthToDate = () => {
  const now = new Date();
  const first = new Date(now.getFullYear(), now.getMonth(), 1);
  const iso = (d: Date) => d.toISOString().slice(0, 10);
  return { from: iso(first), to: iso(now) };
};

/**
 * The waterfall bridge from revenue to net profit.
 *
 * Recharts has no waterfall series, so it is built from a transparent "base"
 * bar plus a visible "delta" bar: each step floats on the running total it
 * starts from. Without the base the bars would all start at zero and the chart
 * would say nothing that the line items do not already say.
 */
function buildWaterfall(lines: PnlLine[]) {
  const bridge = new Set(['net_revenue', 'cogs', 'gross_profit', 'total_opex',
    'operating_profit', 'net_profit']);
  const steps = lines.filter((l) => bridge.has(l.code) || l.code.startsWith('opex_'));

  let running = 0;
  const out: Array<{ name: string; base: number; delta: number; isTotal: boolean }> = [];

  for (const step of steps) {
    if (step.code === 'net_revenue') {
      out.push({ name: step.label, base: 0, delta: step.amount, isTotal: true });
      running = step.amount;
      continue;
    }
    if (bridge.has(step.code)) {
      // A subtotal replaces the running value rather than adding to it.
      out.push({ name: step.label, base: 0, delta: step.amount, isTotal: true });
      running = step.amount;
      continue;
    }
    const delta = step.amount;
    const base = delta >= 0 ? running : running + delta;
    out.push({ name: step.label, base, delta, isTotal: false });
    running += delta;
  }
  return out;
}

export const FinancialStatementsView: React.FC = () => {
  const { can } = useAuthz();
  const [range, setRange] = useState(monthToDate);
  const [months, setMonths] = useState(12);
  const [summary, setSummary] = useState<Summary | null>(null);
  const [pnl, setPnl] = useState<Pnl | null>(null);
  const [flow, setFlow] = useState<CashFlow | null>(null);
  const [trend, setTrend] = useState<TrendPoint[]>([]);
  const [activeMonths, setActiveMonths] = useState(0);
  const [mix, setMix] = useState<ExpenseMix[]>([]);
  const [mixRecorded, setMixRecorded] = useState(false);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');

  const win = `from=${range.from}&to=${range.to}`;

  const load = useCallback(async () => {
    setLoading(true);
    setError('');
    try {
      // One request each, in parallel — the server aggregates everything, so
      // the client never re-derives a figure the database already computed.
      const [s, p, f, t, m] = await Promise.all([
        apiGet<Summary>(`/api/db/financials/summary?${win}`),
        apiGet<Pnl>(`/api/db/financials/pnl?${win}`),
        apiGet<CashFlow>(`/api/db/financials/cash-flow?${win}`),
        apiGet<{ series: TrendPoint[]; activeMonths: number }>(
          `/api/db/financials/trend?months=${months}`,
        ),
        apiGet<{ items: ExpenseMix[]; recorded: boolean }>(
          `/api/db/financials/expense-breakdown?${win}`,
        ),
      ]);
      setSummary(s);
      setPnl(p);
      setFlow(f);
      setTrend(t.series || []);
      setActiveMonths(t.activeMonths ?? 0);
      setMix(m.items || []);
      setMixRecorded(Boolean(m.recorded));
    } catch (e: any) {
      setError(e.message || 'تعذّر تحميل القوائم المالية');
    } finally {
      setLoading(false);
    }
  }, [win, months]);

  useEffect(() => { void load(); }, [load]);

  /**
   * Publishing freezes the current figures as a versioned, immutable record.
   *
   * The button is gated on `reports.manage` purely for usability — the server
   * re-checks the permission on the route, so hiding it here is not a control.
   */
  const [publishing, setPublishing] = useState(false);
  const canPublish = can('reports.manage');

  const publish = async () => {
    if (!canPublish) return;
    setPublishing(true);
    try {
      await apiPost('/api/db/financials/statements', {
        statementType: 'pnl',
        period: range.to.slice(0, 7),
      });
      await load();
    } catch (e: any) {
      setError(e.message || 'تعذّر حفظ القائمة');
    } finally {
      setPublishing(false);
    }
  };

  const waterfall = useMemo(() => (pnl ? buildWaterfall(pnl.lines) : []), [pnl]);
  const activeSeries = useMemo(() => trend.filter((t) => t.invoices > 0), [trend]);

  // A period with no trading is a fact to state, not an empty canvas to render.
  const hasActivity = (summary?.invoices ?? 0) > 0;
  const caveats = summary?.completeness.notes ?? [];

  if (error) {
    return (
      <div className="flex-1 flex items-center justify-center p-6 bg-surface">
        <div role="alert" className="max-w-md text-center bg-surface border border-err/30 rounded-2xl p-8">
          <AlertTriangle className="w-8 h-8 text-err-strong mx-auto mb-3" />
          <h3 className="text-sm font-bold text-ink mb-1">تعذّر تحميل القوائم المالية</h3>
          <p className="text-xs text-faint">{error}</p>
          <button onClick={() => void load()}
            className="mt-4 px-4 py-2 rounded-xl bg-subtle hover:bg-hairline text-ink text-xs font-semibold">
            إعادة المحاولة
          </button>
        </div>
      </div>
    );
  }

  return (
    <div className="flex-1 flex flex-col p-6 overflow-y-auto bg-canvas text-ink font-['Cairo',sans-serif]">
      {/* ---------- Header and period controls ---------- */}
      <div className="mb-6 flex flex-col lg:flex-row lg:items-center justify-between gap-4">
        <div>
          <h2 className="text-xl font-black text-ink flex items-center gap-2">
            <Scale className="w-6 h-6 text-brand" />
            القوائم المالية التفصيلية
          </h2>
          <p className="text-xs text-faint mt-0.5">
            قائمة الدخل والتدفقات النقدية — محسوبة في قاعدة البيانات من الفواتير والتكاليف المسجّلة
          </p>
        </div>

        <div className="flex flex-wrap items-center gap-2">
          <label className="sr-only" htmlFor="fin-from">من تاريخ</label>
          <input id="fin-from" type="date" value={range.from}
            onChange={(e) => setRange((r) => ({ ...r, from: e.target.value }))}
            className="surface-card rounded-xl px-3 py-2 text-xs text-ink focus:border-brand outline-none" />
          <span className="text-muted text-xs">إلى</span>
          <label className="sr-only" htmlFor="fin-to">إلى تاريخ</label>
          <input id="fin-to" type="date" value={range.to}
            onChange={(e) => setRange((r) => ({ ...r, to: e.target.value }))}
            className="surface-card rounded-xl px-3 py-2 text-xs text-ink focus:border-brand outline-none" />

          <select value={months} onChange={(e) => setMonths(Number(e.target.value))}
            aria-label="عدد الأشهر في الاتجاه"
            className="surface-card rounded-xl px-3 py-2 text-xs text-ink focus:border-brand outline-none">
            <option value={6}>آخر 6 أشهر</option>
            <option value={12}>آخر 12 شهرًا</option>
            <option value={24}>آخر 24 شهرًا</option>
          </select>

          <button onClick={() => void load()} disabled={loading}
            className="px-3 py-2 rounded-xl bg-subtle hover:bg-hairline text-ink text-xs font-semibold flex items-center gap-1.5 disabled:opacity-50">
            <RefreshCw className={`w-3.5 h-3.5 ${loading ? 'animate-spin' : ''}`} />
            تحديث
          </button>

          {canPublish && (
            <button onClick={() => void publish()} disabled={publishing}
              title="يُنشئ نسخة مؤرشفة غير قابلة للتعديل من أرقام الفترة الحالية"
              className="px-3 py-2 rounded-xl bg-brand-600 hover:bg-brand-500 text-white text-xs font-semibold flex items-center gap-1.5 disabled:opacity-50">
              <Download className="w-3.5 h-3.5" />
              {publishing ? 'جارٍ الحفظ…' : 'اعتماد قائمة الدخل'}
            </button>
          )}
        </div>
      </div>
{/* ---------- What this statement cannot tell you ----------
          Rendered ABOVE the numbers, not as a footnote. A reader who takes the
          net profit figure without seeing this caveat is the exact failure
          this module exists to prevent. */}
      {caveats.length > 0 && (
        <div className="mb-5 rounded-2xl border border-warn/30 bg-amber-500/5 p-4">
          <div className="flex items-start gap-2.5">
            <AlertTriangle className="w-4 h-4 text-warn-strong mt-0.5 shrink-0" />
            <div className="space-y-1">
              <p className="text-xs font-bold text-warn-strong">
                القائمة غير مكتملة — اقرأ هذه الملاحظات قبل الاستشهاد بالأرقام
              </p>
              <ul className="space-y-0.5">
                {caveats.map((n, i) => (
                  <li key={i} className="text-[11.5px] text-amber-200/80 leading-relaxed">• {n}</li>
                ))}
              </ul>
            </div>
          </div>
        </div>
      )}

      {loading && !summary && (
        <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-4 gap-4 mb-6">
          {[0, 1, 2, 3].map((i) => (
            <div key={i} className="h-[118px] surface-card rounded-2xl animate-pulse" />
          ))}
        </div>
      )}

      {summary && (
        <>
          {/* ---------- Headline tiles ---------- */}
          <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-4 gap-4 mb-6">
            <Stat label="صافي الإيرادات" value={summary.revenue} icon={TrendingUp} tone="positive"
              hint={<Delta value={summary.change.revenue} label="عن الفترة السابقة" />} />
            <Stat label="مجمل الربح" value={summary.grossProfit} icon={Wallet} tone="sky"
              hint={<span className="text-[11px] text-faint">
                الهامش {summary.grossMarginPct === null ? '—' : `${summary.grossMarginPct}%`}
              </span>} />
            <Stat label="المصروفات التشغيلية" value={summary.operatingExpenses} icon={ArrowLeftRight} tone="amber"
              hint={summary.completeness.expensesRecorded
                ? <Delta value={summary.change.expenses} label="عن الفترة السابقة" invert />
                : <span className="text-[11px] text-warn-strong flex items-center gap-1">
                    <HelpCircle className="w-3 h-3" /> لا توجد مصروفات مسجّلة
                  </span>} />
            <Stat label="صافي الربح / (الخسارة)" value={summary.netProfit} icon={Scale}
              tone={summary.netProfit >= 0 ? 'positive' : 'rose'}
              hint={<span className={`text-[11px] ${summary.netProfit >= 0 ? 'text-brand' : 'text-err-strong'}`}>
                الهامش {summary.netMarginPct === null ? '—' : `${summary.netMarginPct}%`}
                {summary.completeness.cogsComplete
                  ? <CheckCircle2 className="w-3 h-3 inline mr-1" />
                  : <HelpCircle className="w-3 h-3 inline mr-1" />}
              </span>} />
          </div>

          {/* ---------- Cash position ---------- */}
          <div className="grid grid-cols-1 md:grid-cols-3 gap-4 mb-6">
            <Stat label="صافي النقد في الفترة" value={summary.cash.netChange} icon={Landmark}
              tone={summary.cash.netChange >= 0 ? 'positive' : 'rose'} />
            <Stat label="الرصيد التراكمي الختامي" value={summary.cash.closing} icon={PiggyBank} tone="violet" />
            <Stat label="عدد الفواتير" value={summary.invoices} icon={Wallet} tone="sky"
              isCurrency={false}
              hint={<span className="text-[11px] text-faint">
                {summary.unitsSold.toLocaleString('ar-SA')} قطعة مباعة
              </span>} />
          </div>

          {/* ---------- Monthly trend ----------
              Only months that actually traded are plotted. A twelve-point line
              through eleven empty months would flatter the trend by hiding the
              gaps — the empty months are stated in the caption instead. */}
          <div className="surface-card rounded-2xl p-5 mb-6">
            <div className="flex items-center justify-between mb-4 pb-3 border-b border-hairline/80">
              <h3 className="text-sm font-bold text-ink flex items-center gap-2">
                <TrendingUp className="w-4 h-4 text-brand" />
                الاتجاه الشهري — الإيراد مقابل الربح
              </h3>
              <span className="text-[11px] text-faint bg-surface px-2.5 py-1 rounded-full border border-hairline">
                {activeMonths} من {trend.length} شهرًا فيه حركة
              </span>
            </div>

            {activeSeries.length === 0 ? (
              <div className="h-64 grid place-items-center text-center px-6">
                <div>
                  <HelpCircle className="w-7 h-7 text-muted mx-auto mb-2" />
                  <p className="text-xs text-faint">لا توجد مبيعات مسجّلة في الأشهر المطلوبة</p>
                  <p className="text-[11px] text-muted mt-1">
                    لا نعرض أصفارًا مكان غياب البيانات — نفترض أن هذه أشهر خاملة
                  </p>
                </div>
              </div>
            ) : (
              <div className="h-72">
                <ResponsiveContainer width="100%" height="100%">
                  <ComposedChart data={activeSeries} margin={{ top: 10, right: 12, left: 0, bottom: 0 }}>
                    <defs>
                      <linearGradient id="finRevenue" x1="0" y1="0" x2="0" y2="1">
                        <stop offset="5%" stopColor="#10b981" stopOpacity={0.35} />
                        <stop offset="95%" stopColor="#10b981" stopOpacity={0} />
                      </linearGradient>
                    </defs>
                    <CartesianGrid strokeDasharray="3 3" stroke="#1e293b" />
                    <XAxis dataKey="label" stroke="#64748b" fontSize={11} />
                    <YAxis yAxisId="l" stroke="#64748b" fontSize={11}
                      tickFormatter={(v) => compact(Number(v))} />
                    <Tooltip
                      contentStyle={{ backgroundColor: '#0f172a', borderColor: '#334155', borderRadius: 12, fontSize: 12 }}
                      labelStyle={{ color: '#10b981', fontWeight: 'bold' }}
                      formatter={(v: any, name: any) => [money(Number(v)), String(name)]}
                    />
                    <Legend wrapperStyle={{ fontSize: 11 }} />
                    <Bar yAxisId="l" dataKey="revenue" name="صافي الإيراد" fill="#10b981" radius={[6, 6, 0, 0]} barSize={22} />
                    <Bar yAxisId="l" dataKey="cogs" name="تكلفة المبيعات" fill="#f43f5e" radius={[6, 6, 0, 0]} barSize={22} />
                    <Line yAxisId="l" type="monotone" dataKey="grossProfit" name="مجمل الربح"
                      stroke="#38bdf8" strokeWidth={3} dot={{ r: 3 }} />
                  </ComposedChart>
                </ResponsiveContainer>
              </div>
            )}
          </div>

          {/* ---------- The waterfall bridge ---------- */}
          <div className="lg:col-span-2 surface-card rounded-2xl p-5 mb-6">
            <div className="flex items-center justify-between mb-4 pb-3 border-b border-hairline/80">
              <h3 className="text-sm font-bold text-ink flex items-center gap-2">
                <Scale className="w-4 h-4 text-violet-400" />
                من الإيراد إلى صافي الربح
              </h3>
              <span className="text-[11px] text-faint bg-surface px-2.5 py-1 rounded-full border border-hairline">
                جسر قائمة الدخل
              </span>
            </div>

            {waterfall.length === 0 ? (
              <div className="h-64 grid place-items-center text-xs text-muted">
                لا توجد بنود لاحتساب الجسر في هذه الفترة
              </div>
            ) : (
              <div className="h-72">
                <ResponsiveContainer width="100%" height="100%">
                  <BarChart data={waterfall} margin={{ top: 10, right: 12, left: 0, bottom: 0 }}>
                    <CartesianGrid strokeDasharray="3 3" stroke="#1e293b" />
                    <XAxis dataKey="name" stroke="#64748b" fontSize={10}
                      angle={-18} textAnchor="end" interval={0} height={62} />
                    <YAxis stroke="#64748b" fontSize={11} tickFormatter={(v) => compact(Number(v))} />
                    <Tooltip
                      contentStyle={{ backgroundColor: '#0f172a', borderColor: '#334155', borderRadius: 12, fontSize: 12 }}
                      formatter={(v: any, name: any, p: any) => [
                        `${money(p.payload.delta)} — ${p.payload.isTotal ? 'إجمالي' : 'حركة'}`,
                        String(name),
                      ]}
                    />
                    {/* The invisible base floats each step on the running total
                        it starts from; without it every bar starts at zero.
                        Recharts 3 types `fill` as a plain colour, so the
                        positive/negative split is applied per data point via
                        Cell rather than through a callback. */}
                    <Bar dataKey="base" fill="transparent" stackId="w" />
                    <Bar dataKey="delta" stackId="w" radius={[4, 4, 4, 4]}>
                      {waterfall.map((w, i) => (
                        <Cell key={i} fill={w.base + w.delta < 0 ? '#f43f5e' : '#10b981'} />
                      ))}
                    </Bar>
                    <ReferenceLine y={0} stroke="#475569" />
                  </BarChart>
                </ResponsiveContainer>
              </div>
            )}
          </div>

          {/* ---------- Expense mix ---------- */}
          <div className="surface-card rounded-2xl p-5 mb-6">
            <div className="flex items-center justify-between mb-4 pb-3 border-b border-hairline/80">
              <h3 className="text-sm font-bold text-ink flex items-center gap-2">
                <ArrowLeftRight className="w-4 h-4 text-warn-strong" />
                توزيع المصروفات التشغيلية
              </h3>
              <span className="text-[11px] text-faint bg-surface px-2.5 py-1 rounded-full border border-hairline">
                {mixRecorded ? money(mix.reduce((s, m) => s + m.amount, 0)) : 'لا توجد مصروفات'}
              </span>
            </div>

            {!mixRecorded || mix.length === 0 ? (
              <div className="h-64 grid place-items-center text-center px-6">
                <div>
                  <HelpCircle className="w-7 h-7 text-muted mx-auto mb-2" />
                  <p className="text-xs text-faint">لم تُسجَّل أي مصروفات تشغيلية في هذه الفترة</p>
                  <p className="text-[11px] text-muted mt-1">
                    لهذا السبب يعرض صافي الربح رقمًا غير مكتمل — مسجّل المصروفات هو من يعالجه
                  </p>
                </div>
              </div>
            ) : (
              <div className="h-64">
                <ResponsiveContainer width="100%" height="100%">
                  <PieChart>
                    <Pie data={mix} dataKey="amount" nameKey="label"
                      cx="50%" cy="50%" innerRadius={52} outerRadius={88} paddingAngle={2}>
                      {mix.map((m, i) => <Cell key={m.bucket} fill={PIE_COLORS[i % PIE_COLORS.length]} />)}
                    </Pie>
                    <Tooltip
                      contentStyle={{ backgroundColor: '#0f172a', borderColor: '#334155', borderRadius: 12, fontSize: 12 }}
                      formatter={(v: any, name: any) => [money(Number(v)), String(name)]}
                    />
                    <Legend wrapperStyle={{ fontSize: 11 }} />
                  </PieChart>
                </ResponsiveContainer>
              </div>
            )}
          </div>

          {/* ---------- The P&L itself ---------- */}
          <div className="surface-card rounded-2xl overflow-hidden mb-6">
            <div className="p-4 border-b border-hairline flex items-center justify-between flex-wrap gap-2">
              <h3 className="text-sm font-bold text-ink">قائمة الدخل — الفترة المحددة</h3>
              <span className="text-[11px] text-faint">
                {range.from} — {range.to} · الريال السعودي
              </span>
            </div>
            <div className="overflow-x-auto">
              <table className="w-full text-right text-xs">
                <thead className="bg-subtle text-faint border-b border-hairline">
                  <tr>
                    <th className="p-3.5">البند</th>
                    <th className="p-3.5 text-left">المبلغ (ر.س)</th>
                    <th className="p-3.5 text-left w-32">من الإيراد</th>
                  </tr>
                </thead>
                <tbody className="divide-y divide-hairline/70">
                  {pnl?.lines.map((l) => (
                    <tr key={l.code}
                      className={`hover:bg-hairline/40 transition-colors ${l.emphasis ? 'bg-subtle/25' : ''}`}>
                      <td className={`p-3.5 ${l.indent ? 'pr-9 text-muted' : 'font-bold text-ink'}`}>
                        {l.label}
                        {l.emphasis && l.code === 'net_profit' && summary?.completeness.expensesRecorded === false && (
                          <HelpCircle className="w-3 h-3 text-warn-strong inline mr-1.5" />
                        )}
                      </td>
                      <td className={`p-3.5 text-left font-mono font-bold ${
                        l.code === 'net_profit'
                          ? (l.amount >= 0 ? 'text-brand' : 'text-err-strong')
                          : l.amount < 0 ? 'text-faint' : 'text-ink'}`}>
                        {l.amount.toLocaleString('ar-SA', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}
                      </td>
                      <td className="p-3.5 text-left text-faint font-mono">
                        {l.pctOfRevenue.toFixed(1)}%
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          </div>

          {/* ---------- Cash flow ---------- */}
          <div className="grid grid-cols-1 lg:grid-cols-2 gap-6">
            <div className="surface-card rounded-2xl p-5">
              <div className="flex items-center justify-between mb-4 pb-3 border-b border-hairline/80">
                <h3 className="text-sm font-bold text-ink flex items-center gap-2">
                  <Landmark className="w-4 h-4 text-info-strong" />
                  التدفقات النقدية
                </h3>
                <span className="text-[11px] text-faint bg-surface px-2.5 py-1 rounded-full border border-hairline">
                  دخول مقابل خروج
                </span>
              </div>

              {flow && flow.sections.some((s) => s.inflow > 0 || s.outflow > 0) ? (
                <div className="h-64">
                  <ResponsiveContainer width="100%" height="100%">
                    <BarChart data={flow.sections} margin={{ top: 10, right: 12, left: 0, bottom: 0 }}>
                      <CartesianGrid strokeDasharray="3 3" stroke="#1e293b" />
                      <XAxis dataKey="label" stroke="#64748b" fontSize={10} />
                      <YAxis stroke="#64748b" fontSize={11} tickFormatter={(v) => compact(Number(v))} />
                      <Tooltip
                        contentStyle={{ backgroundColor: '#0f172a', borderColor: '#334155', borderRadius: 12, fontSize: 12 }}
                        formatter={(v: any, name: any) => [money(Number(v)), String(name)]}
                      />
                      <Legend wrapperStyle={{ fontSize: 11 }} />
                      <Bar dataKey="inflow" name="نقد داخل" fill="#10b981" radius={[5, 5, 0, 0]} barSize={20} />
                      <Bar dataKey="outflow" name="نقد خارج" fill="#f43f5e" radius={[5, 5, 0, 0]} barSize={20} />
                      <ReferenceLine y={0} stroke="#475569" />
                    </BarChart>
                  </ResponsiveContainer>
                </div>
              ) : (
                <div className="h-64 grid place-items-center text-center px-6">
                  <div>
                    <HelpCircle className="w-7 h-7 text-muted mx-auto mb-2" />
                    <p className="text-xs text-faint">لا توجد حركة نقدية مسجّلة في هذه الفترة</p>
                  </div>
                </div>
              )}

              {flow && (
                <>
                  <table className="w-full text-right text-[11.5px] mt-4">
                    <tbody className="divide-y divide-hairline/70">
                      {([
                        ['الرصيد النقدي عند بداية الفترة', flow.openingCash],
                        ['إجمالي النقد الداخل', flow.totalInflow],
                        ['إجمالي النقد الخارج', -flow.totalOutflow],
                        ['صافي التغير في النقد', flow.netChange],
                        ['الرصيد النقدي الختامي', flow.closingCash],
                      ] as Array<[string, number]>).map(([label, value], i) => {
                        const isTotal = i === 4;
                        return (
                          <tr key={label} className={isTotal ? 'bg-hairline/40 font-bold' : ''}>
                            <td className="py-2 pl-2 text-muted">{label}</td>
                            <td className={`py-2 text-left font-mono ${value < 0 ? 'text-err-strong' : 'text-ink'}`}>
                              {value.toLocaleString('ar-SA', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}
                            </td>
                          </tr>
                        );
                      })}
                    </tbody>
                  </table>

                  {/* Stated rather than implied: these sections are empty
                      because nothing has been recorded, which is a different
                      fact from "the business spent nothing". */}
                  {(!flow.investingRecorded || !flow.financingRecorded) && (
                    <p className="mt-3 text-[10.5px] text-warn-strong/80 leading-relaxed">
                      <HelpCircle className="w-3 h-3 inline mr-1" />
                      {!flow.investingRecorded && 'لا توجد حركات استثمارية مسجّلة. '}
                      {!flow.financingRecorded && 'لا توجد حركات تمويلية مسجّلة. '}
                      قسم التدفق النقدي غير مكتمل ما دام ذلك.
                    </p>
                  )}
                  <p className="mt-2 text-[10.5px] text-muted">{flow.basis}</p>
                </>
              )}
            </div>

            {/* ---------- Margin trend — the number that decides whether the business works */}
            <div className="surface-card rounded-2xl p-5">
              <div className="flex items-center justify-between mb-4 pb-3 border-b border-hairline/80">
                <h3 className="text-sm font-bold text-ink flex items-center gap-2">
                  <Wallet className="w-4 h-4 text-violet-400" />
                  مسار الهوامش
                </h3>
              </div>
              {activeSeries.length === 0 ? (
                <div className="h-64 grid place-items-center text-xs text-muted">
                  لا توجد شهور بها مبيعات لعرض الهوامش
                </div>
              ) : (
                <div className="h-64">
                  <ResponsiveContainer width="100%" height="100%">
                    <AreaChart data={activeSeries} margin={{ top: 10, right: 12, left: 0, bottom: 0 }}>
                      <defs>
                        <linearGradient id="finMargin" x1="0" y1="0" x2="0" y2="1">
                          <stop offset="5%" stopColor="#8b5cf6" stopOpacity={0.35} />
                          <stop offset="95%" stopColor="#8b5cf6" stopOpacity={0} />
                        </linearGradient>
                      </defs>
                      <CartesianGrid strokeDasharray="3 3" stroke="#1e293b" />
                      <XAxis dataKey="label" stroke="#64748b" fontSize={11} />
                      <YAxis stroke="#64748b" fontSize={11} tickFormatter={(v) => `${v}%`} />
                      <Tooltip
                        contentStyle={{ backgroundColor: '#0f172a', borderColor: '#334155', borderRadius: 12, fontSize: 12 }}
                        formatter={(v: any, name: any) => [`${v}%`, String(name)]}
                      />
                      <Legend wrapperStyle={{ fontSize: 11 }} />
                      <Area type="monotone" dataKey="grossMarginPct" name="هامش مجمل الربح"
                        stroke="#8b5cf6" strokeWidth={2.5} fill="url(#finMargin)" />
                      <Area type="monotone" dataKey="netMarginPct" name="هامش صافي الربح"
                        stroke="#10b981" strokeWidth={2.5} fill="none" />
                      <ReferenceLine y={0} stroke="#475569" />
                    </AreaChart>
                  </ResponsiveContainer>
                </div>
              )}
            </div>
          </div>
          </>
      )}
    </div>
  );
};