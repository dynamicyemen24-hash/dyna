import React, { useMemo } from 'react';
import {
  AlertTriangle, ArrowLeft, CheckCircle2, CloudOff, Info, Loader2, RefreshCw,
  Wifi, WifiOff, XCircle,
} from 'lucide-react';
import { useWorkCenter, type Situation, type SituationSeverity } from '../hooks/useWorkCenter';
import { useEntitlement } from '../contexts/EntitlementContext';
import { useData } from '../contexts/DataContext';
import { labelOf } from '../config/navigation';
import { sar } from '../services/dyposApi';

/**
 * WORK CENTRE — the home screen.
 *
 * ── Why this file exists ───────────────────────────────────────────────────
 * The application is already built around three pieces, all present in this tree:
 *
 *   1. `hooks/useWorkCenter` — ONE data engine. Every figure, ranking and
 *      exception here is computed there, from one `Promise.all`, with failures
 *      *named* in `degraded` instead of silently defaulted.
 *   2. `config/navigation` — ONE catalogue of screens, so a deep link always
 *      resolves to a real destination (`navItemById`).
 *   3. `contexts/Authz` + `contexts/Entitlement` — ONE authority model, so a
 *      situation the user cannot act on is filtered out upstream.
 *
 * This component is the missing **presentation** layer for those three, and is
 * deliberately presentation-only:
 *
 *   - It issues **no API call of its own.** Fetching here is what produces the
 *     classic "confident zero": one request fails, another renders a default,
 *     and the operator reads a lie. All data arrives from `useWorkCenter`.
 *   - It computes **no business figure.** The only arithmetic here is
 *     presentational (a chart's maximum, a share-of-total bar), derived from
 *     numbers the server produced.
 *   - It never polls. It refreshes when the branch or sector changes (inside the
 *     hook) and when the operator asks — nothing else.
 *
 * ── An empty list is not a measurement ──────────────────────────────────────
 * `kpis` stays `null` until the server answers, and stays `null` if the request
 * fails. Both print an em-dash, never a `0`. A dashboard that says
 * "Stock Value 0.00" because it could not read the database is worse than one
 * that admits ignorance.
 */

export interface DashboardProps {
  /** Deep-links to a screen id from the shared catalogue. */
  onNavigate: (tab: string) => void;
}

/* -------------------------------------------------------------------------- */
/* Presentation-only helpers                                                    */
/* -------------------------------------------------------------------------- */

/** "—" is the honest answer for "not read yet" *and* for "could not read". */
const DASH = '—';

const int = (n: number) => n.toLocaleString('ar-SA', { maximumFractionDigits: 0 });

/** `YYYY-MM-DD` → a compact Arabic day label. */
const dayLabel = (iso: string): string => {
  const d = new Date(`${iso}T00:00:00`);
  if (Number.isNaN(d.getTime())) return iso;
  return d.toLocaleDateString('ar-SA', { day: 'numeric', month: 'short' });
};

const SEVERITY: Record<
  SituationSeverity,
  { row: string; chip: string; Icon: React.ElementType; word: string }
> = {
  critical: {
    row: 'border-s-rose-400',
    chip: 'bg-rose-50 text-rose-700 border-rose-200',
    Icon: XCircle,
    word: 'حرج',
  },
  warning: {
    row: 'border-s-amber-400',
    chip: 'bg-amber-50 text-amber-700 border-amber-200',
    Icon: AlertTriangle,
    word: 'تحذير',
  },
  info: {
    row: 'border-s-sky-400',
    chip: 'bg-sky-50 text-sky-700 border-sky-200',
    Icon: Info,
    word: 'متابعة',
  },
};

/** A single KPI. `value` is decided by the caller — never derived here. */
const Kpi: React.FC<{ label: string; value: string; hint?: string }> = ({ label, value, hint }) => (
  <div className="surface-card p-3.5">
    <dt className="mb-1 text-2xs font-bold text-muted">{label}</dt>
    <dd className="text-numeric text-lg font-semibold text-ink">{value}</dd>
    {hint && <p className="mt-0.5 text-2xs text-amber-600">{hint}</p>}
  </div>
);

/** Truth about the network, read from the same service the status bar shows. */
const ConnectionChip: React.FC<{ offline: boolean; pending: number }> = ({ offline, pending }) => (
  <span
    className={`inline-flex items-center gap-1.5 rounded-xl border px-3 py-2 text-xs font-semibold ${
      offline
        ? 'border-rose-200 bg-rose-50 text-rose-700'
        : pending > 0
          ? 'border-amber-200 bg-amber-50 text-amber-700'
          : 'border-hairline bg-subtle text-muted'
    }`}
  >
    {offline ? (
      <WifiOff size={13} aria-hidden="true" />
    ) : pending > 0 ? (
      <CloudOff size={13} aria-hidden="true" />
    ) : (
      <Wifi size={13} aria-hidden="true" />
    )}
    {offline
      ? `دون اتصال${pending > 0 ? ` · ${int(pending)} معلّقة` : ''}`
      : pending > 0
        ? `${int(pending)} بانتظار المزامنة`
        : 'متصل'}
  </span>
);
/* -------------------------------------------------------------------------- */
/* Sub-views                                                                    */
/* -------------------------------------------------------------------------- */

/**
 * One exception, with the single screen that resolves it.
 *
 * The list reaching here is already permission- and licence-filtered by the
 * hook, so rendering an action is a promise the system can keep — the same rule
 * the command ribbon follows.
 */
const SituationRow: React.FC<{
  s: Situation;
  onNavigate: DashboardProps['onNavigate'];
}> = ({ s, onNavigate }) => {
  const meta = SEVERITY[s.severity];
  const exposure =
    s.exposure === null
      ? null
      : s.exposureUnit === 'currency'
        ? sar(s.exposure)
        : s.exposureUnit === 'units'
          ? `${int(s.exposure)} وحدة`
          : String(s.exposure);

  return (
    <li className={`surface-card border-s-4 ${meta.row} p-4`}>
      <div className="flex items-start gap-3">
        <span className={`mt-0.5 shrink-0 rounded-md border p-1 ${meta.chip}`}>
          <meta.Icon size={13} aria-hidden="true" />
        </span>

        <div className="min-w-0 flex-1">
          <div className="flex flex-wrap items-center gap-2">
            <h3 className="text-sm font-semibold text-ink">{s.title}</h3>
            <span className={`rounded-full border px-1.5 py-0.5 text-2xs font-semibold ${meta.chip}`}>
              {meta.word}
            </span>
          </div>
          <p className="mt-1 text-xs leading-relaxed text-muted">{s.detail}</p>
        </div>

        <div className="shrink-0 text-end">
          {exposure && (
            <p className="text-numeric text-base font-semibold text-ink">{exposure}</p>
          )}
          <button
            type="button"
            onClick={() => onNavigate(s.target)}
            className="mt-1.5 inline-flex items-center gap-1 rounded-md border border-hairline bg-subtle px-2 py-1 text-2xs font-semibold text-ink transition-colors hover:bg-hairline/60"
          >
            {s.actionLabel}
            <ArrowLeft size={11} aria-hidden="true" />
            <span className="sr-only">— {labelOf(s.target)}</span>
          </button>
        </div>
      </div>
    </li>
  );
};
/* -------------------------------------------------------------------------- */
/* The screen                                                                   */
/* -------------------------------------------------------------------------- */

export const Dashboard: React.FC<DashboardProps> = ({ onNavigate }) => {
  const wc = useWorkCenter();
  const { tenant, sectorName } = useEntitlement();
  const { selectedBranch } = useData();

  const { kpis, degraded, loading, busy, offline, pendingSync, refresh } = wc;

  /**
   * The chart's scale. Presentational only — the server already decided what
   * each day's revenue *is*; this only decides how tall to draw it.
   */
  const trendMax = useMemo(
    () => wc.trend.reduce((m, t) => Math.max(m, t.revenue), 0),
    [wc.trend],
  );

  const payTotal = useMemo(
    () => wc.paymentMix.reduce((s, p) => s + p.value, 0),
    [wc.paymentMix],
  );

  const k = kpis;
  const scope = [
    tenant?.name,
    sectorName,
    selectedBranch?.name ?? 'كل الفروع المصرّحة',
  ]
    .filter(Boolean)
    .join(' · ');

  return (
    <div className="mx-auto max-w-7xl space-y-5 pb-4" dir="rtl">
      {/* ---------------- Header: who, where, is this data trustworthy ------- */}
      <header className="flex flex-wrap items-start justify-between gap-4">
        <div className="min-w-0">
          <h1 className="flex items-center gap-2.5 text-xl font-semibold tracking-tight text-ink">
            <span className="grid h-9 w-9 place-items-center rounded-xl bg-brand-soft text-brand">
              <CheckCircle2 size={18} aria-hidden="true" />
            </span>
            مركز العمل
          </h1>
          <p className="mt-1.5 text-xs text-muted">{scope}</p>
        </div>

        <div className="flex items-center gap-2">
          <ConnectionChip offline={offline} pending={pendingSync} />
          <button
            type="button"
            onClick={() => void refresh()}
            disabled={busy}
            className="inline-flex items-center gap-1.5 rounded-xl border border-hairline bg-subtle px-3 py-2 text-xs font-bold text-ink transition-colors hover:bg-hairline/60 disabled:opacity-50"
          >
            {busy ? (
              <Loader2 size={13} className="animate-spin" aria-hidden="true" />
            ) : (
              <RefreshCw size={13} aria-hidden="true" />
            )}
            تحديث
          </button>
        </div>
      </header>

      {/* ---------------- Degradation is stated, never hidden ---------------- */}
      {/*
        `degraded` is the hook's list of sources it could NOT read. Rendering it
        is the whole point: without it a partial failure renders as a plausible
        screen with fewer rows, and the operator cannot tell "nothing happened"
        from "we could not look".
      */}
      {degraded.length > 0 && (
        <div
          role="alert"
          aria-live="polite"
          className="rounded-xl border border-amber-200 bg-amber-50 p-4"
        >
          <div className="flex items-start gap-3">
            <AlertTriangle size={16} className="mt-0.5 shrink-0 text-amber-600" aria-hidden="true" />
            <div className="min-w-0">
              <p className="text-sm font-semibold text-amber-800">
                تعذّر قراءة {degraded.length === 1 ? 'مصدر واحد' : `${degraded.length} مصادر`} —
                الأرقام أدناه ناقصة وليست صفرية
              </p>
              <ul className="mt-1.5 space-y-0.5">
                {degraded.map((d) => (
                  <li key={d.source} className="text-xs text-amber-800/90">
                    <span className="font-semibold">{d.source}</span> — {d.reason}
                  </li>
                ))}
              </ul>
            </div>
          </div>
        </div>
      )}
{/* ---------------- KPI strip ------------------------------------------- */}
      <section aria-labelledby="wc-kpi" className="space-y-2.5">
        <h2 id="wc-kpi" className="text-eyebrow">مؤشرات اليوم</h2>

        {loading && !k ? (
          <div
            role="status"
            className="surface-card flex items-center justify-center gap-2.5 py-12 text-muted"
          >
            <Loader2 size={18} className="animate-spin" aria-hidden="true" />
            <span className="text-sm">جارٍ قراءة المؤشرات…</span>
          </div>
        ) : (
          <dl className="grid grid-cols-2 gap-3 sm:grid-cols-3 lg:grid-cols-6">
            <Kpi label="إيراد اليوم" value={k ? sar(k.revenueToday) : DASH} />
            <Kpi label="صافي اليوم" value={k ? sar(k.netToday) : DASH} />
            <Kpi label="ضريبة القيمة المضافة" value={k ? sar(k.vatToday) : DASH} />
            <Kpi label="الفواتير" value={k ? int(k.invoicesToday) : DASH} />
            <Kpi
              label="قيمة المخزون"
              value={k ? sar(k.stockValue) : DASH}
              hint={k && k.lowStock > 0 ? `${int(k.lowStock)} دون حد الأمان` : undefined}
            />
            <Kpi label="العملاء" value={k ? int(k.customers) : DASH} />
          </dl>
        )}
      </section>

      {/* ---------------- Exceptions — the reason this screen exists ---------- */}
      <section aria-labelledby="wc-situations" className="space-y-2.5">
        <div className="flex items-baseline justify-between gap-3">
          <h2 id="wc-situations" className="text-eyebrow">يحتاج تدخلاً الآن</h2>
          {wc.situations.length > 0 && (
            <span className="text-2xs font-semibold text-muted">
              {wc.situations.length} حالة · مرتّبة بالخطورة ثم قيمة التعرّض
            </span>
          )}
        </div>

        {wc.situations.length === 0 ? (
          /*
            A genuine all-clear, and deliberately worded as one: "nothing needs
            you" is a claim the hook actually verified. A failed fetch is listed
            in `degraded` above, so this cannot hide a broken reading.
          */
          <div className="surface-card flex items-center gap-3 p-5">
            <CheckCircle2 size={18} className="shrink-0 text-brand" aria-hidden="true" />
            <p className="text-sm text-muted">
              لا توجد حالة تتطلب تدخّلاً الآن — الوردية والمخزون والقيود ضمن الحدود.
            </p>
          </div>
        ) : (
          <ul className="space-y-2.5">
            {wc.situations.map((s) => (
              <SituationRow key={s.id} s={s} onNavigate={onNavigate} />
            ))}
          </ul>
        )}
      </section>

      {/* ---------------- Work cards: where to go next ------------------------- */}
      <section aria-labelledby="wc-cards" className="space-y-2.5">
        <h2 id="wc-cards" className="text-eyebrow">لوحات العمل</h2>
        <ul className="grid grid-cols-1 gap-3 sm:grid-cols-2 xl:grid-cols-4">
          {wc.cards.map((c) => (
            <li key={c.key}>
              <button
                type="button"
                onClick={() => onNavigate(c.target)}
                className="surface-card elev-1 flex h-full w-full flex-col items-start gap-1 p-4 text-start transition-opacity hover:opacity-85"
              >
                <span className="text-xs font-bold text-ink">{c.title}</span>
                <span className="text-2xs leading-relaxed text-muted">{c.subtitle}</span>
                <span className="mt-1.5 text-2xs text-faint">{c.metricLabel}</span>
                <span className="text-numeric text-lg font-semibold text-ink">{c.metric}</span>
                <span className="mt-2 inline-flex items-center gap-1 text-2xs font-semibold text-brand">
                  {c.actionLabel}
                  <ArrowLeft size={11} aria-hidden="true" />
                </span>
              </button>
            </li>
          ))}
        </ul>
      </section>
{/* ---------------- Trend + commercial breakdown ------------------------ */}
      <div className="grid grid-cols-1 gap-4 lg:grid-cols-3">
        <section aria-labelledby="wc-trend" className="surface-card p-5 lg:col-span-2">
          <div className="mb-4 flex items-baseline justify-between gap-3">
            <h2 id="wc-trend" className="text-eyebrow">إيراد آخر 14 يوماً</h2>
            {trendMax > 0 && (
              <span className="text-2xs text-muted">أعلى يوم {sar(trendMax)}</span>
            )}
          </div>

          {wc.trend.length === 0 ? (
            /*
              Empty here is a *result*: the server answered with no completed
              invoices in the window. That is different from "not read", which is
              an em-dash above. Both are stated; neither is invented.
            */
            <p className="py-10 text-center text-sm text-faint">
              لا توجد فواتير مكتملة خلال آخر 14 يوماً.
            </p>
          ) : (
            <ul className="flex h-40 items-end gap-1.5" role="list">
              {wc.trend.map((t) => {
                const h = trendMax > 0 ? (t.revenue / trendMax) * 100 : 0;
                return (
                  <li key={t.day} className="group flex flex-1 flex-col items-center gap-1.5">
                    <span className="text-2xs text-faint opacity-0 transition-opacity group-hover:opacity-100">
                      {sar(t.revenue)}
                    </span>
                    <div
                      className="w-full rounded-t bg-brand/25 transition-colors group-hover:bg-brand"
                      style={{ height: `${Math.max(h, 2)}%` }}
                      role="img"
                      aria-label={`${dayLabel(t.day)}: ${sar(t.revenue)} · ${t.invoices} فاتورة`}
                    />
                    <span className="text-2xs text-faint">{dayLabel(t.day)}</span>
                  </li>
                );
              })}
            </ul>
          )}
        </section>

        <section aria-labelledby="wc-pay" className="surface-card p-5">
          <h2 id="wc-pay" className="mb-4 text-eyebrow">توزيع طرق الدفع</h2>

          {wc.paymentMix.length === 0 ? (
            <p className="py-10 text-center text-sm text-faint">لا توجد مدفوعات مسجّلة بعد.</p>
          ) : (
            <ul className="space-y-3">
              {wc.paymentMix.map((p) => {
                const share = payTotal > 0 ? (p.value / payTotal) * 100 : 0;
                return (
                  <li key={p.payment_method}>
                    <div className="flex items-baseline justify-between gap-2">
                      <span className="text-xs font-semibold text-ink">{p.payment_method}</span>
                      <span className="text-numeric text-xs text-muted">
                        {sar(p.value)} · {Math.round(share)}%
                      </span>
                    </div>
                    <div className="mt-1 h-1.5 overflow-hidden rounded-full bg-subtle">
                      <div
                        className="h-full rounded-full bg-brand"
                        style={{ width: `${Math.max(share, 1)}%` }}
                      />
                    </div>
                    <p className="mt-0.5 text-2xs text-faint">{int(p.invoices)} فاتورة</p>
                  </li>
                );
              })}
            </ul>
          )}
        </section>
      </div>

      {/* ---------------- Best sellers ---------------------------------------- */}
      {wc.topProducts.length > 0 && (
        <section aria-labelledby="wc-top" className="surface-card overflow-hidden">
          <h2 id="wc-top" className="border-b border-hairline px-5 py-2.5 text-eyebrow">
            الأصناف الأعلى مبيعاً
          </h2>
          <ul className="divide-y divide-hairline">
            {wc.topProducts.map((p) => (
              <li key={p.name} className="flex items-center justify-between gap-4 px-5 py-3">
                <span className="min-w-0 truncate text-xs font-medium text-ink">{p.name}</span>
                <span className="flex shrink-0 items-center gap-4 text-2xs text-muted">
                  <span className="text-numeric">{int(p.qty)} وحدة</span>
                  <span className="text-numeric font-semibold text-ink">{sar(p.sales)}</span>
                </span>
              </li>
            ))}
          </ul>
        </section>
      )}
    </div>
  );
};

export default Dashboard;