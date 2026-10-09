import React, { useEffect, useMemo, useState } from 'react';
import {
  TrendingDown, TrendingUp, AlertTriangle, CheckCircle2, HelpCircle,
  RefreshCw, Loader2, Bell,
} from 'lucide-react';
import { apiGet, apiPost, sar } from '../services/dyposApi';

interface KpiRow {
  code: string;
  name: string;
  name_en: string;
  category: string;
  polarity: 'higher' | 'lower' | 'target';
  unit: 'currency' | 'percent' | 'days' | 'ratio' | 'count';
  formula: string;
  benchmark: number | null;
  action: string;
  value: number | null;
  sampleSize: number;
  status: 'ok' | 'warn' | 'critical' | 'insufficient_data';
  narrative: string;
}

interface KpiBoard {
  items: KpiRow[];
  summary: { total: number; critical: number; warn: number; ok: number; insufficient: number };
  computedAt: string;
}

const CATEGORY_ORDER = [
  'sales', 'margin', 'inventory', 'receivable', 'payable', 'cash', 'fx', 'hr', 'compliance',
];

const CATEGORY_LABELS: Record<string, string> = {
  sales: 'المبيعات',
  margin: 'الهامش والتسعير',
  inventory: 'المخزون',
  receivable: 'الذمم المدينة',
  payable: 'الذمم الدائنة',
  cash: 'النقد والسيولة',
  fx: 'العملات والفروق',
  hr: 'الموارد البشرية',
  compliance: 'الامتثال',
};

const format = (v: number | null, unit: KpiRow['unit']) => {
  if (v === null) return '—';
  if (unit === 'percent') return `${v.toFixed(1)}%`;
  if (unit === 'currency') return sar(v);
  if (unit === 'days') return `${v.toFixed(0)} يوم`;
  if (unit === 'ratio') return v.toFixed(2);
  return String(Math.round(v));
};

/**
 * The arrow reflects whether higher is GOOD, not merely which way the number
 * moved — a rising days-inventory arrow is a red one.
 */
const directionIcon = (row: KpiRow) => {
  if (row.value === null || row.benchmark === null) return null;
  const above = row.value >= row.benchmark;
  const good = row.polarity === 'lower' ? !above : above;
  const Icon = above ? TrendingUp : TrendingDown;
  return <Icon size={11} className={good ? 'text-brand-500' : 'text-err-strong'} />;
};

const STATUS_STYLE: Record<string, { chip: string; icon: any; label: string }> = {
  critical: { chip: 'bg-err-soft text-err-strong border-err/30', icon: AlertTriangle, label: 'حرج' },
  warn: { chip: 'bg-warn-soft text-warn-strong border-warn/30', icon: AlertTriangle, label: 'تحذير' },
  ok: { chip: 'bg-brand-soft text-brand-strong border-brand/30', icon: CheckCircle2, label: 'مطابق' },
  insufficient_data: { chip: 'bg-subtle text-muted border-hairline', icon: HelpCircle, label: 'بلا بيانات' },
};

/**
 * Decision board.
 *
 * Every row states its value, the benchmark it is judged against, and the
 * action to take. A metric with no underlying rows reads "no data" rather than
 * zero — a confident zero is the most expensive lie a dashboard can tell.
 */
export const KpiBoardView: React.FC<{ branchId?: string }> = ({ branchId }) => {
  const [board, setBoard] = useState<KpiBoard | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');
  const [running, setRunning] = useState(false);
  const [onlyProblems, setOnlyProblems] = useState(true);

  const load = async () => {
    try {
      setLoading(true);
      const qs = branchId ? `?branchId=${branchId}` : '';
      setBoard(await apiGet<KpiBoard>(`/api/erp/kpi${qs}`));
      setError('');
    } catch (e: any) {
      setError(e.message || 'تعذّر تحميل المؤشرات');
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => { load(); /* eslint-disable-next-line */ }, [branchId]);

  const runNow = async () => {
    setRunning(true);
    try {
      await apiPost('/api/erp/kpi/run', { branchId: branchId ?? null });
      await load();
    } catch (e: any) {
      setError(e.message);
    } finally {
      setRunning(false);
    }
  };

  const groups = useMemo(() => {
    if (!board) return [];
    const rows = onlyProblems
      ? board.items.filter((r) => r.status !== 'ok')
      : board.items;
    return CATEGORY_ORDER
      .map((c) => ({ key: c, label: CATEGORY_LABELS[c], rows: rows.filter((r) => r.category === c) }))
      .filter((g) => g.rows.length > 0);
  }, [board, onlyProblems]);

  if (loading && !board) {
    return (
      <div className="flex items-center justify-center gap-2 py-16 text-[12px] text-faint">
        <Loader2 size={14} className="animate-spin" /> جارٍ حساب المؤشرات من Neon…
      </div>
    );
  }

return (
    <section className="space-y-4">
      <header className="flex flex-wrap items-center justify-between gap-3">
        <div className="flex items-center gap-2.5">
          <h2 className="text-[14px] font-semibold text-ink">لوحة المؤشرات القرارية</h2>
          {board && (
            <div className="flex items-center gap-1.5">
              {board.summary.critical > 0 && (
                <span className="px-1.5 py-0.5 rounded-full border border-err/30 bg-err-soft text-[10px] font-semibold text-err-strong">
                  {board.summary.critical} حرج
                </span>
              )}
              {board.summary.warn > 0 && (
                <span className="px-1.5 py-0.5 rounded-full border border-warn/30 bg-warn-soft text-[10px] font-semibold text-warn-strong">
                  {board.summary.warn} تحذير
                </span>
              )}
              {board.summary.insufficient > 0 && (
                <span className="px-1.5 py-0.5 rounded-full border border-hairline bg-subtle text-[10px] font-semibold text-muted">
                  {board.summary.insufficient} بلا بيانات
                </span>
              )}
            </div>
          )}
        </div>

        <div className="flex items-center gap-2">
          <label className="flex items-center gap-1.5 text-[11.5px] text-muted">
            <input
              type="checkbox"
              checked={onlyProblems}
              onChange={(e) => setOnlyProblems(e.target.checked)}
              className="accent-slate-900 w-3.5 h-3.5"
            />
            عرض المتجاوزات فقط
          </label>
          <button
            onClick={runNow}
            disabled={running}
            className="flex items-center gap-1.5 px-2.5 py-1.5 rounded-md bg-surface text-ink text-[11.5px] font-medium hover:bg-hairline/60 disabled:opacity-50"
          >
            {running ? <Loader2 size={12} className="animate-spin" /> : <RefreshCw size={12} />}
            احسب الآن
          </button>
        </div>
      </header>

      {error && (
        <div className="surface-muted border-err/30 bg-err-soft px-4 py-3 text-[12px] text-err-strong">
          {error}
        </div>
      )}

      {board && board.summary.ok > 0 && !onlyProblems && (
        <p className="text-[11.5px] text-faint flex items-center gap-1.5">
          <CheckCircle2 size={12} className="text-brand-500" />
          {board.summary.ok} مؤشر مطابق للمعيار
        </p>
      )}

      {groups.map((g) => (
        <div key={g.key} className="surface-card overflow-hidden">
          <div className="px-5 py-2.5 border-b border-hairline flex items-center justify-between">
            <h3 className="text-[11.5px] font-semibold text-ink">{g.label}</h3>
            <span className="text-[10px] text-faint">{g.rows.length} مؤشر</span>
          </div>
          <ul className="divide-y divide-hairline">
            {g.rows.map((r) => {
              const st = STATUS_STYLE[r.status];
              const Icon = st.icon;
              return (
                <li key={r.code} className="px-5 py-3 hover:bg-subtle/70 transition-colors">
                  <div className="flex items-start justify-between gap-4">
                    <div className="min-w-0">
                      <div className="flex items-center gap-2">
                        <span className="text-[12.5px] font-medium text-ink">{r.name}</span>
                        <span className={`inline-flex items-center gap-1 px-1.5 py-0.5 rounded-full border text-[10px] font-semibold ${st.chip}`}>
                          <Icon size={9} /> {st.label}
                        </span>
                      </div>
                      <p className="text-[11px] text-muted mt-1 leading-relaxed">{r.narrative}</p>
                      {r.status === 'critical' || r.status === 'warn' ? (
                        <p className="text-[11px] text-ink font-medium mt-1 flex items-start gap-1">
                          <Bell size={10} className="mt-0.5 shrink-0 text-faint" />
                          {r.action}
                        </p>
                      ) : null}
                    </div>

                    <div className="text-left shrink-0">
                      <p className="text-[15px] font-semibold text-ink text-numeric flex items-center gap-1">
                        {directionIcon(r)}
                        {format(r.value, r.unit)}
                      </p>
                      {r.benchmark !== null && (
                        <p className="text-[10px] text-faint text-numeric mt-0.5">
                          المعيار {format(r.benchmark, r.unit)}
                        </p>
                      )}
                    </div>
                  </div>
                </li>
              );
            })}
          </ul>
        </div>
      ))}
    </section>
  );
};

export default KpiBoardView;