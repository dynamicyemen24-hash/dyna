import React, { useMemo } from 'react';
import {
  Activity, AlertTriangle, ArrowLeft, BarChart3, Boxes, BrainCircuit, CheckCircle2,
  CalendarDays, CircleDollarSign, CloudOff, Command, Gauge, Info, Loader2, PackageCheck, ReceiptText,
  RefreshCw, ShieldCheck, ShoppingCart, Sparkles, Target, Truck, UsersRound, WalletCards,
  Wifi, WifiOff, XCircle, Zap,
} from 'lucide-react';
import { useWorkCenter, type Situation, type SituationSeverity } from '../hooks/useWorkCenter';
import { useEntitlement } from '../contexts/EntitlementContext';
import { useData } from '../contexts/DataContext';
import { labelOf } from '../config/navigation';
import { sar } from '../services/dyposApi';
import { suggestNextActions } from '../services/opsCopilot';

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

const DashboardSkeleton: React.FC = () => (
  <div className="grid gap-4 md:grid-cols-2 xl:grid-cols-4" aria-hidden="true">
    {Array.from({ length: 4 }).map((_, index) => (
      <div key={index} className="surface-card h-28 animate-pulse p-4">
        <div className="h-3 w-20 rounded bg-slate-200/80" />
        <div className="mt-4 h-7 w-28 rounded bg-slate-200/80" />
      </div>
    ))}
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

  const suggestions = useMemo(
    () => suggestNextActions({
      situations: wc.situations,
      offline: wc.offline,
      pendingSync: wc.pendingSync,
      periodClosed: wc.periodClosed,
      overdueWork: wc.overdueWork,
    }, 3),
    [wc.situations, wc.offline, wc.pendingSync, wc.periodClosed, wc.overdueWork],
  );

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
  const todayLabel = new Date().toLocaleDateString('ar-SA', {
    weekday: 'long', day: 'numeric', month: 'long', year: 'numeric',
  });
  const criticalCount = wc.situations.filter((s) => s.severity === 'critical').length;
  const topBreach = wc.breaches[0];
  const scope = [
    tenant?.name,
    sectorName,
    selectedBranch?.name ?? 'كل الفروع المصرّحة',
  ]
    .filter(Boolean)
    .join(' · ');

  const quickActions = [
    { label: 'بيع سريع', hint: 'أنشئ فاتورة الآن', target: 'pos', Icon: ShoppingCart, tone: 'bg-brand text-white' },
    { label: 'إضافة صنف', hint: 'حدّث الكتالوج', target: 'inventory', Icon: Boxes, tone: 'bg-subtle text-ink' },
    { label: 'شراء جديد', hint: 'أعد تعبئة المخزون', target: 'purchases', Icon: Truck, tone: 'bg-subtle text-ink' },
    { label: 'تحليل الأداء', hint: 'اكتشف فرص النمو', target: 'reports', Icon: BarChart3, tone: 'bg-subtle text-ink' },
  ];
  const metricCards = [
    { label: 'إيراد اليوم', value: k ? sar(k.revenueToday) : DASH, Icon: CircleDollarSign, accent: 'text-brand' },
    { label: 'صافي اليوم', value: k ? sar(k.netToday) : DASH, Icon: WalletCards, accent: 'text-emerald-600' },
    { label: 'الفواتير المكتملة', value: k ? int(k.invoicesToday) : DASH, Icon: ReceiptText, accent: 'text-violet-600' },
    { label: 'قيمة المخزون', value: k ? sar(k.stockValue) : DASH, Icon: PackageCheck, accent: 'text-amber-600', hint: k && k.lowStock > 0 ? `${int(k.lowStock)} دون حد الأمان` : undefined },
  ];

  return (
    <div className="mx-auto max-w-[1500px] space-y-5 pb-6" dir="rtl">
      <header className="relative overflow-hidden rounded-[26px] bg-[#071a2d] px-5 py-6 text-white shadow-[0_18px_50px_rgba(0,16,32,.16)] sm:px-7 lg:px-9">
        <div className="pointer-events-none absolute -left-16 -top-24 h-72 w-72 rounded-full bg-brand/30 blur-3xl" />
        <div className="pointer-events-none absolute bottom-[-90px] right-[34%] h-56 w-56 rounded-full bg-cyan-400/10 blur-3xl" />
        <div className="relative flex flex-wrap items-start justify-between gap-5">
          <div><div className="mb-3 flex items-center gap-2 text-xs font-semibold text-sky-200"><span className="grid h-7 w-7 place-items-center rounded-lg bg-white/10"><Activity size={15} /></span>مركز قيادة التجارة</div><h1 className="font-display text-2xl font-bold tracking-tight sm:text-3xl">صباح الخير، جاهز لتنمية تجارتك؟</h1><p className="mt-2 max-w-2xl text-sm text-slate-300">{scope} <span className="mx-1 text-slate-500">·</span> هذه هي الصورة التشغيلية الأهم لاتخاذ قرارك التالي.</p></div>
          <div className="flex items-center gap-2"><ConnectionChip offline={offline} pending={pendingSync} /><button type="button" onClick={() => void refresh()} disabled={busy} aria-label="تحديث البيانات" className="grid h-10 w-10 place-items-center rounded-xl border border-white/15 bg-white/10 transition hover:bg-white/20 disabled:opacity-50">{busy ? <Loader2 size={16} className="animate-spin" /> : <RefreshCw size={16} />}</button></div>
        </div>
        <div className="relative mt-7 grid gap-2 sm:grid-cols-2 lg:grid-cols-4">{quickActions.map(({ label, hint, target, Icon, tone }) => <button key={target} type="button" onClick={() => onNavigate(target)} className={`group flex items-center gap-3 rounded-2xl px-4 py-3 text-start transition hover:-translate-y-0.5 hover:shadow-lg ${tone}`}><span className="grid h-9 w-9 shrink-0 place-items-center rounded-xl bg-black/10"><Icon size={17} /></span><span><span className="block text-sm font-bold">{label}</span><span className="block text-[11px] opacity-70">{hint}</span></span><ArrowLeft size={14} className="ms-auto opacity-60 transition group-hover:-translate-x-1" /></button>)}</div>
        <div className="relative mt-5 flex flex-wrap items-center gap-x-5 gap-y-2 border-t border-white/10 pt-4 text-[11px] text-slate-300"><span className="inline-flex items-center gap-1.5"><CalendarDays size={13} className="text-sky-300" />{todayLabel}</span><span className="inline-flex items-center gap-1.5"><ShieldCheck size={13} className={offline ? 'text-rose-300' : 'text-emerald-300'} />{offline ? 'وضع العمل المحلي مفعل' : 'البيانات موثقة ومتصلة'}</span><span className="inline-flex items-center gap-1.5"><Gauge size={13} className="text-amber-300" />{criticalCount > 0 ? `${int(criticalCount)} أولوية حرجة` : 'لا توجد أولوية حرجة'}</span></div>
      </header>

      {loading && !k && <DashboardSkeleton />}
      {degraded.length > 0 && <div role="alert" className="flex items-start gap-3 rounded-2xl border border-amber-200 bg-amber-50 p-4 text-amber-900"><AlertTriangle size={17} className="mt-0.5 shrink-0 text-amber-600" /><div><p className="text-sm font-bold">الأرقام أدناه ناقصة وليست صفرية</p><p className="mt-1 text-xs">تعذّر قراءة: {degraded.map((d) => d.source).join('، ')}</p></div></div>}

      <section aria-labelledby="wc-kpi" className="space-y-3"><div className="flex items-end justify-between"><div><p className="text-eyebrow">نبض المتجر</p><h2 id="wc-kpi" className="mt-1 font-display text-lg font-bold text-ink">أرقام تستحق انتباهك اليوم</h2></div><span className="hidden items-center gap-1 text-xs text-muted sm:flex"><Zap size={13} className="text-amber-500" /> بيانات تشغيلية مباشرة</span></div><dl className="grid grid-cols-2 gap-3 lg:grid-cols-4">{metricCards.map(({ label, value, Icon, accent, hint }) => <div key={label} className="surface-card group relative overflow-hidden p-4 transition hover:-translate-y-0.5 hover:shadow-md"><div className={`mb-4 grid h-9 w-9 place-items-center rounded-xl bg-subtle ${accent}`}><Icon size={18} /></div><dt className="text-xs font-semibold text-muted">{label}</dt><dd className="mt-1 text-numeric text-xl font-bold text-ink">{value}</dd>{hint && <p className="mt-1 text-[11px] font-semibold text-amber-600">{hint}</p>}<div className={`absolute bottom-0 start-0 h-1 w-full ${accent.replace('text-', 'bg-')} opacity-25`} /></div>)}</dl></section>

      <section aria-label="إشارات ذكية" className="grid gap-3 md:grid-cols-3"><div className="surface-card flex items-start gap-3 border-brand/20 bg-brand-soft/40 p-4"><span className="grid h-9 w-9 shrink-0 place-items-center rounded-xl bg-brand text-white"><Sparkles size={16} /></span><div><p className="text-[10px] font-bold uppercase tracking-wider text-brand">إشارة النمو</p><p className="mt-1 text-sm font-bold text-ink">{topBreach ? topBreach.name : 'المتجر يعمل ضمن النطاق الطبيعي'}</p><p className="mt-1 text-xs leading-relaxed text-muted">{topBreach ? topBreach.narrative : 'لا توجد مؤشرات تستدعي قرارًا استثنائيًا حاليًا.'}</p></div></div><div className="surface-card flex items-start gap-3 p-4"><span className="grid h-9 w-9 shrink-0 place-items-center rounded-xl bg-subtle text-amber-600"><Target size={16} /></span><div><p className="text-[10px] font-bold uppercase tracking-wider text-muted">التركيز التالي</p><p className="mt-1 text-sm font-bold text-ink">{wc.situations[0]?.title || 'استمر على هذا الإيقاع'}</p><p className="mt-1 text-xs text-muted">{wc.situations[0]?.detail || 'لم يتم رصد استثناءات تشغيلية.'}</p></div></div><div className="surface-card flex items-start gap-3 p-4"><span className="grid h-9 w-9 shrink-0 place-items-center rounded-xl bg-subtle text-violet-600"><Gauge size={16} /></span><div><p className="text-[10px] font-bold uppercase tracking-wider text-muted">انضباط التشغيل</p><p className="mt-1 text-sm font-bold text-ink">{wc.overdueWork > 0 ? `${int(wc.overdueWork)} أعمال متأخرة` : 'لا أعمال متأخرة'}</p><p className="mt-1 text-xs text-muted">مبني على طابور العمل الحالي والصلاحيات المتاحة.</p></div></div></section>

      <div className="grid gap-5 xl:grid-cols-[1.35fr_.65fr]"><section aria-labelledby="wc-next" className="surface-card overflow-hidden p-5 sm:p-6"><div className="mb-5 flex items-start justify-between gap-3"><div className="flex items-start gap-3"><span className="grid h-10 w-10 place-items-center rounded-xl bg-brand-soft text-brand"><BrainCircuit size={20} /></span><div><p className="text-eyebrow">مساعد القرار</p><h2 id="wc-next" className="mt-1 font-display text-lg font-bold text-ink">ما الخطوة الأكثر تأثيراً الآن؟</h2></div></div><span className="hidden rounded-full bg-brand-soft px-2.5 py-1 text-[10px] font-bold text-brand sm:block">محلي · دون إرسال بيانات</span></div>{suggestions.length === 0 ? <div className="rounded-2xl bg-subtle p-5 text-sm text-muted"><CheckCircle2 className="mb-2 text-brand" size={20} />لا إجراءات عاجلة — كل المؤشرات ضمن المعيار.</div> : <ul className="grid gap-3 md:grid-cols-3">{suggestions.map((s) => <li key={s.situationId} className="flex flex-col rounded-2xl border border-hairline bg-canvas p-4"><div className="flex items-center justify-between text-[10px] font-bold text-muted"><span className="rounded-full bg-subtle px-2 py-1">أولوية {s.rank}</span><span>{Math.round(s.confidence * 100)}% ثقة</span></div><p className="mt-4 text-sm font-bold text-ink">{s.title}</p><p className="mt-2 text-xs leading-relaxed text-muted">{s.why}</p><button type="button" onClick={() => onNavigate(s.target)} className="mt-4 inline-flex items-center gap-1 self-start text-xs font-bold text-brand">{s.actionLabel}<ArrowLeft size={13} /></button></li>)}</ul>}</section><section aria-labelledby="wc-situations" className="rounded-2xl bg-brand p-5 text-white shadow-lg shadow-brand/15 sm:p-6"><div className="flex items-start justify-between gap-3"><div><p className="text-xs font-bold text-sky-100">رادار المخاطر</p><h2 id="wc-situations" className="mt-1 font-display text-lg font-bold">يحتاج تدخلاً الآن</h2></div><span className="grid h-9 w-9 place-items-center rounded-xl bg-white/15"><Target size={18} /></span></div><div className="mt-6 flex items-end gap-2"><strong className="text-4xl font-bold">{wc.situations.length}</strong><span className="pb-1 text-xs text-sky-100">حالة فعالة</span></div><div className="mt-5 space-y-2">{wc.situations.slice(0, 3).map((s) => <button key={s.id} type="button" onClick={() => onNavigate(s.target)} className="flex w-full items-center gap-3 rounded-xl bg-white/10 p-3 text-start transition hover:bg-white/20"><span className={`h-2 w-2 rounded-full ${s.severity === 'critical' ? 'bg-rose-300' : s.severity === 'warning' ? 'bg-amber-300' : 'bg-sky-200'}`} /><span className="min-w-0 flex-1 truncate text-xs font-semibold">{s.title}</span><ArrowLeft size={13} className="shrink-0 text-sky-100" /></button>)}{wc.situations.length === 0 && <p className="rounded-xl bg-white/10 p-3 text-xs text-sky-100">لا توجد حالات تتطلب تدخلاً الآن.</p>}</div></section></div>

      <section aria-labelledby="wc-cards" className="space-y-3"><div className="flex items-center justify-between"><div><p className="text-eyebrow">مساحات العمل</p><h2 id="wc-cards" className="mt-1 font-display text-lg font-bold text-ink">انتقل مباشرة إلى المهمة</h2></div><Command size={18} className="text-muted" /></div><ul className="grid grid-cols-1 gap-3 sm:grid-cols-2 xl:grid-cols-4">{wc.cards.map((c) => <li key={c.key}><button type="button" onClick={() => onNavigate(c.target)} className="surface-card flex h-full w-full items-start gap-3 p-4 text-start transition hover:-translate-y-0.5 hover:border-brand/40 hover:shadow-md"><span className="grid h-10 w-10 shrink-0 place-items-center rounded-xl bg-subtle text-brand"><Sparkles size={17} /></span><span className="min-w-0"><span className="block text-sm font-bold text-ink">{c.title}</span><span className="mt-1 block text-xs leading-relaxed text-muted">{c.subtitle}</span><span className="mt-3 block text-numeric text-base font-bold text-ink">{c.metric}</span><span className="mt-1 inline-flex items-center gap-1 text-[11px] font-bold text-brand">{c.actionLabel}<ArrowLeft size={12} /></span></span></button></li>)}</ul></section>

      <div className="grid grid-cols-1 gap-5 lg:grid-cols-3"><section aria-labelledby="wc-trend" className="surface-card p-5 lg:col-span-2"><div className="mb-5 flex items-start justify-between"><div><p className="text-eyebrow">اتجاه المبيعات</p><h2 id="wc-trend" className="mt-1 font-display text-lg font-bold text-ink">إيراد آخر 14 يوماً</h2></div>{trendMax > 0 && <span className="rounded-full bg-subtle px-2.5 py-1 text-[10px] font-bold text-muted">القمة {sar(trendMax)}</span>}</div>{wc.trend.length === 0 ? <p className="py-10 text-center text-sm text-faint">لا توجد فواتير مكتملة خلال آخر 14 يوماً.</p> : <ul className="flex h-44 items-end gap-1.5" role="list">{wc.trend.map((t) => { const h = trendMax > 0 ? (t.revenue / trendMax) * 100 : 0; return <li key={t.day} className="group flex flex-1 flex-col items-center gap-1.5"><span className="text-[10px] text-faint opacity-0 transition group-hover:opacity-100">{sar(t.revenue)}</span><div className="w-full rounded-t-lg bg-gradient-to-t from-brand to-cyan-400/70 transition group-hover:from-brand-strong" style={{ height: `${Math.max(h, 3)}%` }} role="img" aria-label={`${dayLabel(t.day)}: ${sar(t.revenue)} · ${t.invoices} فاتورة`} /><span className="text-[10px] text-faint">{dayLabel(t.day)}</span></li>; })}</ul>}</section><section aria-labelledby="wc-pay" className="surface-card p-5"><div className="mb-5 flex items-start justify-between"><div><p className="text-eyebrow">مزيج التحصيل</p><h2 id="wc-pay" className="mt-1 font-display text-lg font-bold text-ink">طرق الدفع</h2></div><WalletCards size={19} className="text-brand" /></div>{wc.paymentMix.length === 0 ? <p className="py-10 text-center text-sm text-faint">لا توجد مدفوعات مسجّلة بعد.</p> : <ul className="space-y-4">{wc.paymentMix.map((p) => { const share = payTotal > 0 ? (p.value / payTotal) * 100 : 0; return <li key={p.payment_method}><div className="flex items-baseline justify-between gap-2"><span className="text-xs font-bold text-ink">{p.payment_method}</span><span className="text-numeric text-xs text-muted">{Math.round(share)}%</span></div><div className="mt-2 h-2 overflow-hidden rounded-full bg-subtle"><div className="h-full rounded-full bg-brand" style={{ width: `${Math.max(share, 1)}%` }} /></div><p className="mt-1 text-[11px] text-faint">{sar(p.value)} · {int(p.invoices)} فاتورة</p></li>; })}</ul>}</section></div>

      {wc.topProducts.length > 0 && <section aria-labelledby="wc-top" className="surface-card overflow-hidden"><div className="flex items-center justify-between border-b border-hairline px-5 py-4"><div><p className="text-eyebrow">محرك الطلب</p><h2 id="wc-top" className="mt-1 font-display text-lg font-bold text-ink">الأصناف الأعلى مبيعاً</h2></div><UsersRound size={18} className="text-muted" /></div><ul className="grid divide-y divide-hairline sm:grid-cols-2 sm:divide-x sm:divide-y-0 xl:grid-cols-5">{wc.topProducts.map((p, index) => <li key={p.name} className="flex items-center gap-3 px-5 py-4"><span className="grid h-8 w-8 shrink-0 place-items-center rounded-lg bg-subtle text-xs font-bold text-brand">{String(index + 1).padStart(2, '0')}</span><span className="min-w-0 flex-1"><span className="block truncate text-xs font-bold text-ink">{p.name}</span><span className="mt-1 block text-[11px] text-muted">{int(p.qty)} وحدة</span></span><span className="text-numeric text-xs font-bold text-ink">{sar(p.sales)}</span></li>)}</ul></section>}
    </div>
  );
};

export default Dashboard;
