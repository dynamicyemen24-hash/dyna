import React, { useEffect, useMemo, useState } from 'react';
import {
  BarChart3, BrainCircuit, PieChart, ShieldCheck, TrendingDown,
  TrendingUp, AlertTriangle,
} from 'lucide-react';
import { apiGet, sar } from '../services/dyposApi';

/**
 * EXECUTIVE INTELLIGENCE — real figures, or an admission that there are none.
 *
 * ── What this screen used to be ──────────────────────────────────────────────
 * Every number on it was typed in by hand:
 *
 *   - "45,200.00 ر.س · +18%" · "128,400.00 ر.س · −2%" · "12,500.00 ر.س · −15%"
 *   - a bar chart of `[65, 45, 85, 30, 95, 70, 50, 80, 40, 60, 90, 55]`
 *   - a category split of `45% / 30% / 15% / 10%`
 *   - an "AI Generated" recommendation naming real branches — "فرع الرياض
 *     الرئيسي يتفوق بهوامش 12%… نوصي بنقل 15% من مخزون جدة" — produced by a
 *     `setTimeout(2000)` with no model and no data behind it.
 *   - a `fetch('/api/db/health')` against an endpoint that does not exist, with
 *     the failure swallowed into `console.error`.
 *
 * An executive dashboard that invents its own numbers is worse than none: a
 * decision gets made on it, and the decision is unfounded. So the screen reads
 * the real reports, and where a figure cannot be read it shows an em-dash and
 * names the source that failed.
 *
 * ── Sources (all real, all already in use elsewhere in this app) ─────────────
 *   `/api/db/reports/daily-sales?days=30` → the trend and the KPI strip
 *   `/api/db/reports/by-branch`           → branch performance
 *   `/api/db/reports/by-category`         → category mix
 *
 * No new endpoint, no new table, and no second definition of any of these
 * numbers — `useWorkCenter` already reads two of them for the home screen.
 */

interface TrendPoint {
  day: string;
  revenue: number;
  invoices: number;
}

interface BranchRow {
  branch_id: string;
  name: string;
  revenue: number;
  invoices: number;
}

interface CategoryRow {
  name: string;
  value: number;
}

const DASH = '—';
const num = (v: unknown): number => {
  const n = Number(v);
  return Number.isFinite(n) ? n : 0;
};

/**
 * Category colours, assigned by position.
 *
 * A fixed category→colour map would silently mis-colour the first category the
 * tenant has that the map does not know about, so the palette is positional and
 * always matches the number of rows actually returned.
 */
const SERIES = [
  'bg-indigo-500', 'bg-brand-500', 'bg-amber-500', 'bg-sky-500',
  'bg-rose-500', 'bg-violet-500', 'bg-teal-500',
];

/** A KPI tile. `change` is null when it cannot be computed — never a guess. */
const MetricCard: React.FC<{
  label: string;
  value: string;
  change: number | null;
  sub: string;
}> = ({ label, value, change, sub }) => (
  <div className="bg-slate-900/50 border border-slate-800 p-6 rounded-3xl">
    <p className="text-slate-500 text-sm font-bold mb-2">{label}</p>
    <div className="flex items-baseline gap-3 mb-1">
      <h3 className="text-2xl font-black text-numeric">{value}</h3>
      {change !== null && (
        <span className={`text-xs font-bold flex items-center ${change >= 0 ? 'text-brand-400' : 'text-rose-400'}`}>
          {change >= 0 ? <TrendingUp size={14} /> : <TrendingDown size={14} />}
          {Math.abs(change)}%
        </span>
      )}
    </div>
    <p className="text-xs text-slate-500">{sub}</p>
  </div>
);
export const IntelligenceCenter: React.FC = () => {
  const [trend, setTrend] = useState<TrendPoint[]>([]);
  const [branches, setBranches] = useState<BranchRow[]>([]);
  const [categories, setCategories] = useState<CategoryRow[]>([]);
  const [failed, setFailed] = useState<string[]>([]);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    let alive = true;

    /**
     * One reader for all three sources, and it NAMES its failures.
     *
     * A `catch` that resolves to `null` without recording anything is what let a
     * dead endpoint look like an empty dashboard. `failed` is what the screen
     * renders, so a missing source is visible rather than inferred.
     */
    const safe = async <T,>(label: string, path: string): Promise<T | null> => {
      try {
        return await apiGet<T>(path);
      } catch {
        if (alive) setFailed((prev) => (prev.includes(label) ? prev : [...prev, label]));
        return null;
      }
    };

    (async () => {
      const [t, b, c] = await Promise.all([
        safe<{ items: TrendPoint[] }>('اتجاه المبيعات', '/api/db/reports/daily-sales?days=30'),
        safe<{ items: BranchRow[] }>('أداء الفروع', '/api/db/reports/by-branch'),
        safe<{ items: CategoryRow[] }>('توزيع الفئات', '/api/db/reports/by-category'),
      ]);
      if (!alive) return;
      setTrend((t?.items ?? []).map((p) => ({
        day: p.day, revenue: num(p.revenue), invoices: num(p.invoices),
      })));
      setBranches((b?.items ?? []).map((r) => ({
        branch_id: r.branch_id, name: r.name,
        revenue: num(r.revenue), invoices: num(r.invoices),
      })));
      setCategories((c?.items ?? []).map((r) => ({ name: r.name, value: num(r.value) })));
      setLoading(false);
    })();

    return () => { alive = false; };
  }, []);

  const totals = useMemo(() => {
    const revenue = trend.reduce((s, p) => s + p.revenue, 0);
    const invoices = trend.reduce((s, p) => s + p.invoices, 0);
    const max = trend.reduce((m, p) => Math.max(m, p.revenue), 0);

    // Split at the midpoint: two genuinely comparable halves, so the change
    // between them is a measurement rather than a decorative arrow.
    const half = Math.floor(trend.length / 2);
    const older = trend.slice(0, half).reduce((s, p) => s + p.revenue, 0);
    const recent = trend.slice(half).reduce((s, p) => s + p.revenue, 0);

    return {
      revenue,
      invoices,
      max,
      changePct: older > 0 ? Math.round(((recent - older) / older) * 100) : null,
      average: invoices > 0 ? revenue / invoices : 0,
    };
  }, [trend]);

  const categoryTotal = useMemo(
    () => categories.reduce((s, c) => s + c.value, 0),
    [categories],
  );

  const hasData = trend.length > 0 || branches.length > 0 || categories.length > 0;

return (
    <div className="max-w-7xl mx-auto space-y-8" dir="rtl">
      {/* ---- Header ------------------------------------------------------- */}
      <header className="flex flex-wrap items-start justify-between gap-4">
        <div className="flex items-center gap-4">
          <div className="p-3 bg-indigo-500/10 rounded-2xl text-indigo-400">
            <BrainCircuit size={24} />
          </div>
          <div>
            <h1 className="text-2xl font-black text-white">مركز الذكاء التنفيذي</h1>
            <p className="text-sm text-slate-500">
              تحليل مباشر لسجلات الفواتير — بلا تقديرات
            </p>
          </div>
        </div>
      </header>

      {/* ---- Sources that could not be read ------------------------------- */}
      {/*
        Stated BEFORE the numbers, not after them. A failed source means the
        figures below are INCOMPLETE, and an executive reading a partial board as
        a whole one is the failure this screen used to cause with invented data.
      */}
      {failed.length > 0 && (
        <div role="alert" className="rounded-2xl border border-amber-500/30 bg-amber-500/10 p-4">
          <div className="flex items-start gap-3">
            <AlertTriangle size={18} className="mt-0.5 shrink-0 text-amber-400" />
            <div>
              <p className="text-sm font-bold text-amber-200">
                تعذّر قراءة {failed.length === 1 ? 'مصدر واحد' : `${failed.length} مصادر`} —
                الأرقام أدناه ناقصة وليست صفرية
              </p>
              <p className="mt-1 text-xs text-amber-200/80">{failed.join('، ')}</p>
            </div>
          </div>
        </div>
      )}

      {loading ? (
        <div role="status" className="py-20 text-center text-slate-400 text-sm">
          جارٍ قراءة التقارير…
        </div>
      ) : !hasData ? (
        <div className="rounded-2xl border border-slate-800 p-10 text-center">
          <BarChart3 size={32} className="mx-auto mb-3 text-slate-600" />
          <p className="text-sm text-slate-400">لا توجد فواتير مكتملة لعرضها بعد.</p>
        </div>
      ) : (
        <>
          {/* ---- KPI strip, all measured ---------------------------------- */}
          <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-4 gap-6">
            <MetricCard
              label="إيراد الفترة"
              value={totals.revenue > 0 ? sar(totals.revenue) : DASH}
              change={totals.changePct}
              sub="آخر 30 يوماً · مقارنة بالنصف الأول"
            />
            <MetricCard
              label="عدد الفواتير"
              value={totals.invoices > 0 ? String(totals.invoices) : DASH}
              change={null}
              sub="فواتير مكتملة في الفترة"
            />
            <MetricCard
              label="متوسط الفاتورة"
              value={totals.average > 0 ? sar(totals.average) : DASH}
              change={null}
              sub="الإيراد ÷ عدد الفواتير"
            />
            <MetricCard
              label="الفروع المبيع منها"
              value={branches.length > 0 ? String(branches.length) : DASH}
              change={null}
              sub="فروع سجّلت فواتير مكتملة"
            />
          </div>
{/* ---- Revenue trend, from the daily series -------------------- */}
          <section className="bg-slate-900 border border-slate-800 rounded-[2rem] p-8">
            <div className="flex items-center gap-4 mb-6">
              <div className="p-3 bg-brand-500/10 rounded-2xl text-brand-400">
                <BarChart3 size={24} />
              </div>
              <div>
                <h3 className="text-xl font-black text-white">إيراد آخر 30 يوماً</h3>
                <p className="text-sm text-slate-500">يومياً، من فواتير الحالة المكتملة</p>
              </div>
            </div>

            {totals.max > 0 ? (
              <ul className="flex h-48 items-end gap-1" role="list">
                {trend.map((p) => {
                  const h = (p.revenue / totals.max) * 100;
                  const d = new Date(`${p.day}T00:00:00`);
                  const label = Number.isNaN(d.getTime())
                    ? p.day
                    : d.toLocaleDateString('ar-SA', { day: 'numeric', month: 'short' });
                  return (
                    <li key={p.day} className="group flex flex-1 flex-col items-center gap-1">
                      <span className="text-2xs text-slate-400 opacity-0 group-hover:opacity-100">
                        {sar(p.revenue)}
                      </span>
                      <div
                        className="w-full rounded-t bg-brand-500/30 group-hover:bg-brand-500 transition-colors"
                        style={{ height: `${Math.max(h, 1)}%` }}
                        role="img"
                        aria-label={`${label}: ${sar(p.revenue)} · ${p.invoices} فاتورة`}
                      />
                      <span className="text-2xs text-slate-500">{label}</span>
                    </li>
                  );
                })}
              </ul>
            ) : (
              <p className="py-10 text-center text-sm text-slate-500">
                لا توجد فواتير مكتملة في آخر 30 يوماً.
              </p>
            )}
          </section>

          <div className="grid grid-cols-1 lg:grid-cols-2 gap-8">
            {/* ---- Branch performance, from the server -------------------- */}
            <section className="bg-slate-900 border border-slate-800 rounded-[2rem] p-8">
              <h3 className="text-xl font-black text-white mb-6">أداء الفروع</h3>
              {branches.length === 0 ? (
                <p className="py-8 text-center text-sm text-slate-500">
                  لا توجد مبيعات مسجّلة لأي فرع.
                </p>
              ) : (
                <ul className="space-y-4">
                  {branches.slice(0, 8).map((b) => (
                    <li key={b.branch_id}>
                      <div className="flex items-baseline justify-between gap-3">
                        <span className="text-xs font-bold text-slate-200">{b.name}</span>
                        <span className="text-xs text-numeric text-slate-400">
                          {sar(b.revenue)} · {b.invoices} فاتورة
                        </span>
                      </div>
                      <div className="mt-1.5 h-1.5 overflow-hidden rounded-full bg-slate-800">
                        <div
                          className="h-full rounded-full bg-brand-500"
                          style={{
                            width: `${totals.revenue > 0
                              ? Math.max((b.revenue / totals.revenue) * 100, 1)
                              : 1}%`,
                          }}
                        />
                      </div>
                    </li>
                  ))}
                </ul>
              )}
            </section>
{/* ---- Category mix, from the server -------------------------- */}
            <section className="bg-slate-900 border border-slate-800 rounded-[2rem] p-8">
              <h3 className="text-xl font-black text-white mb-6 flex items-center gap-2">
                <PieChart size={20} className="text-blue-400" />
                توزيع المبيعات حسب الفئة
              </h3>
              {categories.length === 0 || categoryTotal <= 0 ? (
                <p className="py-8 text-center text-sm text-slate-500">
                  لا توجد مبيعات مصنّفة بعد.
                </p>
              ) : (
                <ul className="space-y-4">
                  {categories.slice(0, 8).map((c, i) => (
                    <li key={c.name}>
                      <div className="flex items-baseline justify-between gap-3">
                        <span className="text-xs font-bold text-slate-200">{c.name}</span>
                        <span className="text-xs text-numeric text-slate-400">
                          {sar(c.value)} · {Math.round((c.value / categoryTotal) * 100)}%
                        </span>
                      </div>
                      <div className="mt-1.5 h-1.5 overflow-hidden rounded-full bg-slate-800">
                        <div
                          className={`h-full rounded-full ${SERIES[i % SERIES.length]}`}
                          style={{ width: `${Math.max((c.value / categoryTotal) * 100, 1)}%` }}
                        />
                      </div>
                    </li>
                  ))}
                </ul>
              )}
            </section>
          </div>

          {/* ---- Provenance ---------------------------------------------- */}
          {/*
            The source line this screen used to hide. An executive reading a board
            should be able to see it came from the invoice ledger and where to
            check it — the difference between a figure and a claim.
          */}
          <footer className="flex items-start gap-3 rounded-2xl border border-slate-800 p-4">
            <ShieldCheck size={16} className="mt-0.5 shrink-0 text-brand-400" />
            <p className="text-xs leading-relaxed text-slate-400">
              كل الأرقام أعلاه مقروءة مباشرة من سجل الفواتير (الحالة = مكتملة) عبر
              <code className="text-slate-300"> /api/db/reports</code>.
              لا توجد قيم تقديرية في هذه الشاشة.
            </p>
          </footer>
        </>
      )}
    </div>
  );
};

export default IntelligenceCenter;