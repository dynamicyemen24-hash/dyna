/**
 * DEVICE DIAGNOSTICS TOOL
 *
 * A support screen, not a settings screen.
 *
 * The output is organised the way a support call is actually run: the
 * blockers first, then the sections in the order that explains them, then a
 * one-click copy of everything for the ticket.
 *
 * ACCESSIBILITY
 *  - Status is never carried by colour alone. Every badge has a glyph and a
 *    word, because "green means fine" excludes the readers with a colour
 *    vision deficiency — disproportionately the technicians reading this on
 *    a sunlit warehouse screen.
 *  - The summary is an `aria-live` region, so a re-run announces itself
 *    without stealing focus from whatever the operator was reading.
 */

import React, { useCallback, useEffect, useMemo, useState } from 'react';
import {
  RefreshCw, Copy, Check, AlertTriangle, XCircle, HelpCircle,
  ShieldCheck, ChevronDown, Zap, Wrench,
} from 'lucide-react';
import {
  runDeviceDiagnostics, formatReport, copyText,
  type DiagnosticReport, type DiagnosticCheck, type CheckStatus,
} from '../../services/deviceDiagnostics';
import { fetchHardwareAnomalies, executeSelfHealing, type HardwareAnomaly } from '../../services/telemetryClient';
import { ToolShell, useTools } from '../../contexts/ToolsContext';

const STATUS_META: Record<CheckStatus, {
  label: string; icon: React.ElementType; glyph: string; chip: string; bar: string;
}> = {
  pass: {
    label: 'سليم', icon: ShieldCheck, glyph: '✓',
    chip: 'bg-brand-soft text-brand-strong border-brand/30', bar: 'bg-brand-500',
  },
  warn: {
    label: 'تحذير', icon: AlertTriangle, glyph: '!',
    chip: 'bg-warn-soft text-warn-strong border-warn/30', bar: 'bg-amber-500',
  },
  fail: {
    label: 'تعطل', icon: XCircle, glyph: '✗',
    chip: 'bg-err-soft text-err-strong border-err/30', bar: 'bg-rose-500',
  },
  unknown: {
    label: 'غير محسوم', icon: HelpCircle, glyph: '?',
    chip: 'bg-subtle text-muted border-hairline', bar: 'bg-faint',
  },
};

const ALL_STATUSES: CheckStatus[] = ['pass', 'warn', 'fail', 'unknown'];

export const DiagnosticsTool: React.FC = () => {
  const { close } = useTools();
  const [report, setReport] = useState<DiagnosticReport | null>(null);
  const [anomalies, setAnomalies] = useState<HardwareAnomaly[]>([]);
  const [running, setRunning] = useState(true);
  const [healingId, setHealingId] = useState<string | null>(null);
  const [copied, setCopied] = useState(false);
  const [onlyProblems, setOnlyProblems] = useState(false);
  const [expanded, setExpanded] = useState<Record<string, boolean>>({});

  const run = useCallback(async () => {
    setRunning(true);
    const [rep, anom] = await Promise.all([
      runDeviceDiagnostics().catch(() => null),
      fetchHardwareAnomalies().catch(() => []),
    ]);
    setReport(rep);
    setAnomalies(anom);
    setRunning(false);
  }, []);

  const handleHeal = async (anom: HardwareAnomaly) => {
    setHealingId(anom.id);
    const actionType =
      anom.component === 'memory' ? 'clear_cache' :
      anom.component === 'storage' ? 'optimize_storage' :
      anom.component === 'network' ? 'flush_offline_queue' : 'reset_serial_bridge';
    await executeSelfHealing(anom.id, actionType, anom.component).catch(() => {});
    const updated = await fetchHardwareAnomalies().catch(() => []);
    setAnomalies(updated);
    setHealingId(null);
  };

  useEffect(() => { void run(); }, [run]);

  const onCopy = async () => {
    if (!report) return;
    if (await copyText(formatReport(report))) {
      setCopied(true);
      setTimeout(() => setCopied(false), 2200);
    }
  };

  const sections = useMemo(() => {
    if (!report) return [];
    if (!onlyProblems) return report.sections;
    // Sections with nothing to report drop out entirely under this filter;
    // an empty section would read as missing data rather than as clean.
    return report.sections
      .map((s) => ({ ...s, checks: s.checks.filter((c) => c.status !== 'pass') }))
      .filter((s) => s.checks.length > 0);
  }, [report, onlyProblems]);

  const summary = report?.summary;
  return (
    <ToolShell tool="devices" onClose={close}>
      <div className="p-4 sm:p-5 space-y-4">
        <div className="surface-card p-4">
          <div className="flex flex-wrap items-center justify-between gap-3 mb-3">
            <div className="min-w-0">
              <h3 className="text-base font-semibold text-ink">حالة هذا الجهاز</h3>
              <p className="text-xs text-muted mt-0.5">
                {running
                  ? 'جارٍ الفحص…'
                  : report
                    ? `تم فحص ${report.summary.total} عنصراً · ${report.generatedAt.slice(11, 19)}`
                    : 'تعذّر إكمال الفحص.'}
              </p>
            </div>
            <div className="flex items-center gap-2">
              <button
                type="button"
                onClick={() => setOnlyProblems((v) => !v)}
                aria-pressed={onlyProblems}
                className={`px-3 py-2 rounded-lg border text-xs font-bold transition-colors ${
                  onlyProblems
                    ? 'bg-warn-soft text-warn-strong border-warn/30'
                    : 'bg-surface text-muted border-hairline hover:text-ink'
                }`}
              >
                {onlyProblems ? 'عرض الكل' : 'المشاكل فقط'}
              </button>
              <button
                type="button"
                onClick={onCopy}
                disabled={!report}
                className="px-3 py-2 rounded-lg border border-hairline bg-surface text-ink text-xs font-bold hover:bg-subtle disabled:opacity-50 transition-colors inline-flex items-center gap-1.5"
              >
                {copied ? <Check size={14} className="text-brand" /> : <Copy size={14} />}
                {copied ? 'تم النسخ' : 'نسخ التقرير'}
              </button>
              <button
                type="button"
                onClick={() => void run()}
                disabled={running}
                className="px-3 py-2 rounded-lg bg-brand text-white text-xs font-bold hover:opacity-90 disabled:opacity-60 transition-opacity inline-flex items-center gap-1.5"
              >
                <RefreshCw size={14} className={running ? 'animate-spin' : ''} />
                إعادة الفحص
              </button>
            </div>
          </div>

          {/* Announced, not merely shown: a re-run must be perceivable
              without watching the refresh button. */}
          <p role="status" aria-live="polite" className="sr-only">
            {running ? 'جارٍ فحص الجهاز'
              : summary
                ? `اكتمل الفحص: ${summary.pass} سليم، ${summary.warn} تحذير، ${summary.fail} تعطل`
                : 'تعذّر الفحص'}
          </p>

          {summary && (
            <div>
              {/* Proportional bar: the shape of the problem at a glance. */}
              <div className="flex h-2 rounded-full overflow-hidden bg-subtle" aria-hidden="true">
                {ALL_STATUSES.map((k) => {
                  const n = summary[k];
                  if (!n) return null;
                  return (
                    <div
                      key={k}
                      className={STATUS_META[k].bar}
                      style={{ width: `${(n / summary.total) * 100}%` }}
                    />
                  );
                })}
              </div>
              <div className="flex flex-wrap gap-x-4 gap-y-1.5 mt-2.5">
                {ALL_STATUSES.map((k) => {
                  const meta = STATUS_META[k];
                  const Icon = meta.icon;
                  return (
                    <span
                      key={k}
                      className={`inline-flex items-center gap-1.5 px-2 py-1 rounded-full border text-2xs font-bold ${meta.chip}`}
                    >
                      <Icon size={12} aria-hidden="true" />
                      <span aria-hidden="true">{meta.glyph}</span>
                      {meta.label}
                      <span className="font-mono">{summary[k]}</span>
                    </span>
                  );
                })}
              </div>
            </div>
          )}
        </div>
        {/* Blockers first — the only question the first call actually asks. */}
        {report && report.blockers.length > 0 && (
          <section aria-labelledby="blockers-h" className="surface-card border-err/30 p-4">
            <h4 id="blockers-h" className="text-sm font-bold text-err-strong flex items-center gap-2 mb-2">
              <XCircle size={16} aria-hidden="true" />
              ما يمنع العمل ({report.blockers.length})
            </h4>
            <ul className="space-y-2">
              {report.blockers.map((c) => (
                <li key={c.id} className="text-xs leading-relaxed">
                  <span className="font-bold text-ink">{c.label}</span>
                  <span className="text-muted"> — {c.value}</span>
                  {c.fix && <span className="block text-muted mt-0.5">الحل: {c.fix}</span>}
                </li>
              ))}
            </ul>
          </section>
        )}

        {/* Predictive Self-Healing Anomaly Alerts */}
        {anomalies.length > 0 && (
          <section aria-labelledby="healing-h" className="surface-card border-warn/30 p-4 bg-warn-soft/40">
            <h4 id="healing-h" className="text-sm font-bold text-warn-strong flex items-center gap-2 mb-2">
              <Zap size={16} className="text-warn-strong" aria-hidden="true" />
              التنبؤ بالأعطال والإصلاح الذاتي ({anomalies.length})
            </h4>
            <p className="text-xs text-muted mb-3">
              رصدت محرك التنبؤ الآلي استباقياً بعض المخاطر أو التعطلات المحتملة. انقر على "إصلاح ذاتي" للمعالجة الفورية.
            </p>
            <ul className="space-y-2.5">
              {anomalies.map((anom) => (
                <li key={anom.id} className="bg-surface p-3 rounded-lg border border-warn/30 flex flex-wrap items-center justify-between gap-3">
                  <div className="min-w-0 flex-1">
                    <div className="flex items-center gap-2 flex-wrap">
                      <span className="px-2 py-0.5 rounded-full bg-amber-100 text-warn-strong text-2xs font-bold uppercase">
                        {anom.component} · {anom.severity}
                      </span>
                      <span className="text-xs font-bold text-ink">{anom.anomaly_type}</span>
                      <span className="text-2xs text-muted font-mono">الثقة: {Math.round(anom.confidence_score * 100)}%</span>
                    </div>
                    <p className="text-xs text-muted mt-1 leading-relaxed">{anom.description}</p>
                  </div>
                  <button
                    type="button"
                    onClick={() => void handleHeal(anom)}
                    disabled={healingId === anom.id}
                    className="px-3 py-1.5 rounded-lg bg-brand text-white text-xs font-bold hover:opacity-90 disabled:opacity-50 transition-opacity inline-flex items-center gap-1.5 shrink-0"
                  >
                    <Wrench size={13} className={healingId === anom.id ? 'animate-spin' : ''} />
                    {healingId === anom.id ? 'جاري الإصلاح…' : 'إصلاح ذاتي'}
                  </button>
                </li>
              ))}
            </ul>
          </section>
        )}

        {running && !report && (
          <p className="text-sm text-muted py-8 text-center">جارٍ فحص الجهاز…</p>
        )}

        {sections.map((s) => {
          const isOpen = expanded[s.id] ?? true;
          const bad = s.checks.filter((c) => c.status !== 'pass').length;
          return (
            <section key={s.id} className="surface-card overflow-hidden">
              <h4>
                <button
                  type="button"
                  onClick={() => setExpanded((p) => ({ ...p, [s.id]: !isOpen }))}
                  aria-expanded={isOpen}
                  className="w-full flex items-center justify-between gap-3 px-4 py-3 text-right hover:bg-subtle transition-colors"
                >
                  <span className="min-w-0">
                    <span className="block text-sm font-semibold text-ink">{s.title}</span>
                    <span className="block text-2xs text-muted mt-0.5">{s.hint}</span>
                  </span>
                  <span className="flex items-center gap-2 shrink-0">
                    {bad > 0 ? (
                      <span className="px-2 py-0.5 rounded-full bg-warn-soft text-warn-strong border border-warn/30 text-2xs font-bold">
                        {bad} يحتاج انتباهاً
                      </span>
                    ) : (
                      <span className="px-2 py-0.5 rounded-full bg-brand-soft text-brand-strong border border-brand/30 text-2xs font-bold">
                        سليم
                      </span>
                    )}
                    <ChevronDown
                      size={16}
                      className={`text-faint transition-transform ${isOpen ? 'rotate-180' : ''}`}
                      aria-hidden="true"
                    />
                  </span>
                </button>
              </h4>
              {isOpen && (
                <ul className="border-t border-hairline divide-y divide-hairline">
                  {s.checks.map((c) => <CheckRow key={c.id} check={c} />)}
                </ul>
              )}
            </section>
          );
        })}

        {onlyProblems && sections.length === 0 && report && (
          <p className="text-sm text-muted py-10 text-center">
            لا توجد مشاكل. كل الفحوصات سليمة على هذا الجهاز.
          </p>
        )}
      </div>
    </ToolShell>
  );
};

/**
 * One check.
 *
 * The remedy is always visible whenever the row is not a `pass` — a red row
 * with no action is an escalation to the IT department, not a tool.
 */
const CheckRow: React.FC<{ check: DiagnosticCheck }> = ({ check }) => {
  const meta = STATUS_META[check.status];
  const Icon = meta.icon;
  return (
    <li className="px-4 py-3 flex items-start gap-3">
      <span className={`shrink-0 w-6 h-6 rounded-lg grid place-items-center border ${meta.chip}`}>
        <Icon size={13} aria-hidden="true" />
        <span className="sr-only">{meta.label}:</span>
      </span>
      <div className="min-w-0 flex-1">
        <div className="flex items-baseline justify-between gap-3 flex-wrap">
          <span className="text-xs font-bold text-ink">{check.label}</span>
          <span className="font-mono text-2xs text-muted" dir="auto">{check.value}</span>
        </div>
        <p className="text-2xs text-muted mt-0.5 leading-relaxed">{check.detail}</p>
        {check.fix && check.status !== 'pass' && (
          <p className="text-2xs text-ink mt-1.5 leading-relaxed">
            <span className="font-bold">الحل: </span>{check.fix}
          </p>
        )}
      </div>
    </li>
  );
};

export default DiagnosticsTool;