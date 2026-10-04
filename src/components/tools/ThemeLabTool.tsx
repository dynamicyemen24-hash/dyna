/**
 * THEME LAB
 *
 * Three views of the same truth, in the order a designer needs them:
 *   1. WHICH themes exist, and does each one actually resolve its own
 *      variables (or does it silently render as the default)?
 *   2. What each theme's tokens resolve to, by hex value.
 *   3. Whether those values pass WCAG — measured, not assumed.
 *
 * The whole point of the tool is that the audit is computed from the live
 * cascade, so a theme whose CSS rule was never written shows up as
 * "unresolved" instead of looking finished in a stylesheet review.
 */

import React, { useEffect, useMemo, useState } from 'react';
import { Check, Palette, AlertTriangle, Info } from 'lucide-react';
import { ToolShell, useTools } from '../../contexts/ToolsContext';
import {
  inspectAllThemes, applyTheme, type ThemeInspection,
} from '../../services/themeInspector';
import { THEME_CONFIGS, type ThemeMode } from '../../services/themeService';

export const ThemeLabTool: React.FC = () => {
  const { close } = useTools();
  const [active, setActive] = useState<ThemeMode>(() => {
    const applied = document.documentElement.getAttribute('data-theme');
    return (applied as ThemeMode) || 'light';
  });

  const inspections = useMemo(() => inspectAllThemes(), []);
  const current = inspections.find((i) => i.mode === active) ?? inspections[0];

  // Announce the applied theme: the change is global and instant, so a
  // screen-reader user would otherwise get no confirmation at all.
  const [announced, setAnnounced] = useState('');
  useEffect(() => {
    if (announced) {
      const t = setTimeout(() => setAnnounced(''), 2500);
      return () => clearTimeout(t);
    }
  }, [announced]);

  const choose = (mode: ThemeMode) => {
    applyTheme(mode);
    setActive(mode);
    setAnnounced(`تم تطبيق سمة ${THEME_CONFIGS[mode].name}`);
  };

  return (
    <ToolShell tool="theme" onClose={close}>
      <div className="p-4 sm:p-5 space-y-4">
        {/* ── the six themes ──────────────────────────────────────── */}
        <section aria-labelledby="themes-h">
          <h3 id="themes-h" className="text-sm font-semibold text-ink mb-2.5 flex items-center gap-2">
            <Palette size={15} className="text-brand" aria-hidden="true" />
            السِمات المتاحة
          </h3>
          <div className="grid grid-cols-2 lg:grid-cols-3 gap-2.5">
            {inspections.map((ins) => {
              const cfg = THEME_CONFIGS[ins.mode];
              const on = ins.mode === active;
              return (
                <button
                  key={ins.mode}
                  type="button"
                  onClick={() => choose(ins.mode)}
                  aria-pressed={on}
                  className={`text-right rounded-xl border p-3 transition-all ${
                    on ? 'border-brand ring-1 ring-brand' : 'border-hairline hover:border-brand/40'
                  } bg-surface`}
                >
                  <span className="flex items-center justify-between gap-2 mb-2">
                    {/* Live swatch built from the resolved tokens — not from
                        the `previewColor` constant, which is what the code
                        has always trusted and is not what renders. */}
                    <span className="flex gap-1" aria-hidden="true">
                      <span className="w-4 h-4 rounded border border-hairline" style={{ background: ins.tokens.canvas }} />
                      <span className="w-4 h-4 rounded border border-hairline" style={{ background: ins.tokens.surface }} />
                      <span className="w-4 h-4 rounded" style={{ background: ins.tokens.brand }} />
                      <span className="w-4 h-4 rounded" style={{ background: ins.tokens.ink }} />
                    </span>
                    {on && <Check size={14} className="text-brand shrink-0" aria-hidden="true" />}
                  </span>
                  <span className="block text-xs font-bold text-ink leading-snug">{cfg.name}</span>
                  <span className="block text-2xs text-muted mt-1 leading-relaxed">{cfg.description}</span>
                  <span className="flex items-center gap-1.5 mt-2">
                    {!ins.resolved && (
                      <span className="inline-flex items-center gap-1 px-1.5 py-0.5 rounded bg-rose-50 text-rose-700 border border-rose-200 text-2xs font-bold">
                        <AlertTriangle size={10} aria-hidden="true" /> غير معرّفة
                      </span>
                    )}
                    {ins.resolved && ins.failures === 0 && (
                      <span className="inline-flex items-center gap-1 px-1.5 py-0.5 rounded bg-brand-50 text-brand-700 border border-brand-200 text-2xs font-bold">
                        <Check size={10} aria-hidden="true" /> مطابق
                      </span>
                    )}
                    {ins.resolved && ins.failures > 0 && (
                      <span className="inline-flex items-center gap-1 px-1.5 py-0.5 rounded bg-amber-50 text-amber-800 border border-amber-200 text-2xs font-bold">
                        <AlertTriangle size={10} aria-hidden="true" /> {ins.failures} تباين ضعيف
                      </span>
                    )}
                  </span>
                </button>
              );
            })}
          </div>
          <p role="status" aria-live="polite" className="sr-only">{announced}</p>
        </section>
        {current && <TokenTable ins={current} />}
        {current && <ContrastTable ins={current} />}
      </div>
    </ToolShell>
  );
};
/** The resolved custom properties, as the browser actually computed them. */
const TOKEN_LABELS: Record<string, { ar: string; use: string }> = {
  canvas: { ar: 'الخلفية', use: 'خلفية الصفحة' },
  surface: { ar: 'البطاقة', use: 'سطح البطاقات واللوحات' },
  subtle: { ar: 'الخلفية الثانوية', use: 'تظليل خفيف' },
  hairline: { ar: 'الحد الفاصل', use: 'الحدود بين العناصر' },
  ink: { ar: 'النص', use: 'النص الأساسي' },
  muted: { ar: 'النص الثانوي', use: 'الوصف والبيانات المساعدة' },
  faint: { ar: 'النص الخافت', use: 'التسميات الصغيرة' },
  brand: { ar: 'العلامة', use: 'الأزرار والإجراءات' },
  'brand-strong': { ar: 'العلامة القوية', use: 'حالات التأكيد' },
  'brand-soft': { ar: 'خلفية العلامة', use: 'الشارات والأشرطة' },
};

const TokenTable: React.FC<{ ins: ThemeInspection }> = ({ ins }) => (
  <section aria-labelledby="tokens-h" className="surface-card p-4">
    <h3 id="tokens-h" className="text-sm font-semibold text-ink mb-0.5">
      قيم السمة: {ins.name}
    </h3>
    <p className="text-2xs text-muted mb-3">
      مقروءة من الصفحة الحيّة بعد تطبيق السمة، لا من ملف التنسيق.
    </p>
    <div className="grid grid-cols-2 lg:grid-cols-5 gap-2">
      {Object.entries(ins.tokens).map(([key, value]) => {
        const meta = TOKEN_LABELS[key];
        return (
          <div key={key} className="rounded-lg border border-hairline overflow-hidden">
            <div className="h-11 w-full" style={{ background: value }} aria-hidden="true" />
            <div className="p-2">
              <p className="text-2xs font-bold text-ink">{meta?.ar ?? key}</p>
              <p className="text-2xs text-faint mt-0.5 font-mono" dir="auto">{value}</p>
              <p className="text-2xs text-faint mt-1 leading-snug">{meta?.use}</p>
            </div>
          </div>
        );
      })}
    </div>
    {!ins.resolved && (
      <p className="text-2xs text-rose-700 mt-3 flex items-start gap-1.5 leading-relaxed">
        <AlertTriangle size={12} className="mt-0.5 shrink-0" aria-hidden="true" />
        بعض المتغيرات غير معرّفة — تُعرض السمة كأنها الافتراضية.
      </p>
    )}
  </section>
);

/**
 * The measured contrast pairs.
 *
 * Ratios are printed as numbers, not only as pass/fail badges: the number
 * tells a designer whether to adjust the hue or the weight, and "فشل"
 * alone leaves them guessing.
 */
const ContrastTable: React.FC<{ ins: ThemeInspection }> = ({ ins }) => (
  <section aria-labelledby="contrast-h" className="surface-card p-4">
    <h3 id="contrast-h" className="text-sm font-semibold text-ink mb-0.5">
      التباين مقابل معايير WCAG
    </h3>
    <p className="text-2xs text-muted mb-3 flex items-center gap-1.5">
      <Info size={12} aria-hidden="true" />
      AA للنص العادي (4.5:1)، وAAA ‏(7:1)، وAA للنص الكبير والحدود (3:1).
    </p>
    <div className="overflow-x-auto -mx-4 px-4 sm:mx-0 sm:px-0">
      <table className="w-full text-right text-xs min-w-[420px]">
        <thead>
          <tr className="text-faint text-2xs border-b border-hairline">
            <th scope="col" className="py-2 pl-2 font-semibold">الزوج اللوني</th>
            <th scope="col" className="py-2 pl-2 font-semibold">عيّنة</th>
            <th scope="col" className="py-2 pl-2 font-semibold">النسبة</th>
            <th scope="col" className="py-2 font-semibold">النتيجة</th>
          </tr>
        </thead>
        <tbody className="divide-y divide-hairline">
          {ins.pairs.map((p) => {
            const isBorder = p.label.includes('الحد الفاصل');
            const ok = isBorder ? p.largeAa : p.aa;
            return (
              <tr key={p.label}>
                <td className="py-2.5 pl-2 text-ink">{p.label}</td>
                <td className="py-2.5 pl-2">
                  <span
                    className="inline-flex items-center px-2 py-1 rounded text-2xs font-bold"
                    style={{ background: p.bg, color: p.fg }}
                    aria-hidden="true"
                  >
                    Aa نص
                  </span>
                </td>
                <td className="py-2.5 pl-2 font-mono text-numeric text-ink">{p.ratio.toFixed(2)}</td>
                <td className="py-2.5">
                  <span className={`inline-flex items-center gap-1 px-2 py-0.5 rounded-full border text-2xs font-bold ${
                    ok
                      ? 'bg-brand-50 text-brand-700 border-brand-200'
                      : 'bg-rose-50 text-rose-700 border-rose-200'
                  }`}>
                    {ok ? <Check size={11} aria-hidden="true" /> : <AlertTriangle size={11} aria-hidden="true" />}
                    {ok ? (p.aaa ? 'AAA' : 'AA') : 'دون الحد'}
                  </span>
                </td>
              </tr>
            );
          })}
        </tbody>
      </table>
    </div>
  </section>
);

export default ThemeLabTool;