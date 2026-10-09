/**
 * TOOLS PROVIDER — device & theme inspection as independent surfaces
 * ══════════════════════════════════════════════════════════════════════════
 *
 * WHY A PROVIDER AND NOT A SCREEN
 * --------------------------------
 * These checks are needed in two places that share no layout: the sign-in
 * door, and the working shell. As a screen it would need a nav entry, a
 * licence grant and a route back — for a tool that is reachable precisely
 * when the app is misbehaving.
 *
 * So the tools are a portal mounted once, here, opened by `useTools()` from
 * anywhere. LoginView calls it, MainLayout calls it, nothing else has to
 * know: no nav entry, no licence, no route, no deep link to forget. It
 * survives a theme change and a branch switch because it lives above them.
 *
 * The panels are lazy: the login screen is the first paint a cashier sees,
 * and neither the diagnostics bundle nor the WCAG maths belongs in it.
 */

import React, {
  createContext, lazy, Suspense, useContext, useEffect, useMemo, useRef, useState,
} from 'react';

const DiagnosticsTool = lazy(() => import('../components/tools/DiagnosticsTool')
  .then((module) => ({ default: module.DiagnosticsTool })));
const ThemeLabTool = lazy(() => import('../components/tools/ThemeLabTool')
  .then((module) => ({ default: module.ThemeLabTool })));

/** The two independent tools, addressed by id so a deep link is possible. */
export type ToolId = 'devices' | 'theme';

export const TOOL_META: Record<ToolId, { title: string; subtitle: string }> = {
  devices: {
    title: 'فحص الأجهزة والبيئة',
    subtitle: 'ما يدعمه هذا الجهاز فعلاً — متصفح، تخزين، شبكة، أجهزة طرفية',
  },
  theme: {
    title: 'مختبر السِمات',
    subtitle: 'قيم السمة الفعلية ونِسب التباين مقابل معايير WCAG',
  },
};

interface ToolsApi {
  /** Opens a tool. Safe to call from anywhere. */
  open: (id: ToolId) => void;
  close: () => void;
  /** The open tool, or null when the portal is closed. */
  current: ToolId | null;
  isOpen: boolean;
}

const ToolsContext = createContext<ToolsApi | null>(null);

/**
 * Accessor that throws rather than returning null.
 *
 * A silently-null context would render a button that does nothing — the
 * exact class of dead control this tool exists to eliminate.
 */
export const useTools = (): ToolsApi => {
  const ctx = useContext(ToolsContext);
  if (!ctx) throw new Error('useTools must be used inside <ToolsProvider>');
  return ctx;
};
/**
 * Focusable descendants, in DOM order.
 *
 * Queried live on every Tab press rather than cached: the panels mount
 * their rows asynchronously, and a cached list would let focus walk out of
 * the dialog and into the page behind it.
 */
const focusablesIn = (root: HTMLElement): HTMLElement[] =>
  Array.from(
    root.querySelectorAll<HTMLElement>(
      'a[href], button:not([disabled]), input:not([disabled]), ' +
      'select:not([disabled]), textarea:not([disabled]), ' +
      '[tabindex]:not([tabindex="-1"])',
    ),
  ).filter((el) => el.offsetParent !== null || el.getClientRects().length > 0);

/**
 * The modal shell every tool renders inside.
 *
 * A11Y CONTRACT — what makes these tools usable rather than merely visible:
 *   - Escape closes, and focus returns to whatever opened it.
 *   - Tab is trapped between the first and last control. Without this, a
 *     keyboard user tabs straight out of the dialog and into the POS behind
 *     it, losing their place entirely.
 *   - Background scroll is locked, or the page scrolls under a dialog that
 *     looks stationary.
 *   - `role="dialog"` + `aria-modal` + a labelled title, so a screen reader
 *     announces what opened instead of reading a wall of numbers.
 */
export const ToolShell: React.FC<{
  tool: ToolId;
  onClose: () => void;
  children: React.ReactNode;
}> = ({ tool, onClose, children }) => {
  const panelRef = useRef<HTMLDivElement>(null);
  const restoreRef = useRef<HTMLElement | null>(null);

  // Remember the opener once, on open — not on every render, by which point
  // it may be gone and the fallback would be the body.
  useEffect(() => {
    restoreRef.current = document.activeElement as HTMLElement | null;
    // Focus the panel itself rather than its first control: the title is
    // announced first, and someone who only wanted to look does not have to
    // Tab past every row to reach the close button.
    panelRef.current?.focus();
    return () => { restoreRef.current?.focus?.(); };
  }, []);

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') {
        e.preventDefault();
        onClose();
        return;
      }
      if (e.key !== 'Tab' || !panelRef.current) return;

      const items = focusablesIn(panelRef.current);
      if (items.length === 0) return;
      const first = items[0];
      const last = items[items.length - 1];
      const active = document.activeElement;
      const inside = panelRef.current.contains(active);

      // Wrap at both ends. `!inside` covers focus having been outside the
      // dialog entirely — pull it back rather than letting it roam.
      if (!inside) {
        e.preventDefault();
        first.focus();
      } else if (e.shiftKey && active === first) {
        e.preventDefault();
        last.focus();
      } else if (!e.shiftKey && active === last) {
        e.preventDefault();
        first.focus();
      }
    };
    document.addEventListener('keydown', onKey);
    return () => document.removeEventListener('keydown', onKey);
  }, [onClose]);

  // Restored to the previous value rather than to 'auto': a host page may
  // already have been locked.
  useEffect(() => {
    const prev = document.body.style.overflow;
    document.body.style.overflow = 'hidden';
    return () => { document.body.style.overflow = prev; };
  }, []);

  const meta = TOOL_META[tool];

  return (
    <div
      className="fixed inset-0 z-[100] flex items-end sm:items-center justify-center bg-black/60 backdrop-blur-sm sm:p-6"
      onMouseDown={(e) => { if (e.target === e.currentTarget) onClose(); }}
    >
      <div
        ref={panelRef}
        role="dialog"
        aria-modal="true"
        aria-label={meta.title}
        tabIndex={-1}
        className="w-full sm:max-w-3xl h-[92vh] sm:h-auto sm:max-h-[86vh] flex flex-col bg-surface text-ink rounded-t-2xl sm:rounded-2xl border border-hairline elev-2 overflow-hidden outline-none pb-safe"
      >
        <header className="flex items-start justify-between gap-3 px-4 sm:px-5 py-3 border-b border-hairline shrink-0">
          <div className="min-w-0">
            <h2 className="text-lg font-semibold text-ink">{meta.title}</h2>
            <p className="text-xs text-muted mt-0.5 leading-relaxed">{meta.subtitle}</p>
          </div>
          <button
            type="button"
            onClick={onClose}
            aria-label="إغلاق الأداة"
            className="shrink-0 w-9 h-9 grid place-items-center rounded-lg text-faint hover:text-ink hover:bg-subtle transition-colors text-xl leading-none"
          >
            ×
          </button>
        </header>
        <div className="flex-1 overflow-y-auto scrollbar-thin overscroll-contain">
          {children}
        </div>
      </div>
    </div>
  );
};
/**
 * Mounts the provider and the portal.
 *
 * One portal for the whole application — the login door and the working
 * shell open the same instance, so a tool opened on one cannot be left
 * stranded behind the other.
 */
export const ToolsProvider: React.FC<{ children: React.ReactNode }> = ({ children }) => {
  const [current, setCurrent] = useState<ToolId | null>(null);

  const api = useMemo<ToolsApi>(() => ({
    current,
    isOpen: current !== null,
    open: setCurrent,
    close: () => setCurrent(null),
  }), [current]);

  /*
   * A deep link that works before sign-in.
   *
   * `?tool=devices` is how support asks a user to open a report without
   * walking them through a menu. Honoured once, then stripped from the URL
   * so a later reload does not re-open a stale dialog over a finished shift.
   */
  useEffect(() => {
    const apply = () => {
      const wanted = new URLSearchParams(location.search).get('tool');
      if (wanted === 'devices' || wanted === 'theme') {
        setCurrent(wanted);
        const url = new URL(location.href);
        url.searchParams.delete('tool');
        window.history.replaceState(null, '', url.toString());
      }
    };
    apply();
    window.addEventListener('popstate', apply);
    return () => window.removeEventListener('popstate', apply);
  }, []);

  const close = api.close;

  return (
    <ToolsContext.Provider value={api}>
      {children}
      <Suspense fallback={(
        <div role="status" className="fixed inset-0 z-[100] grid place-items-center bg-black/40 text-ink">
          جارٍ تحميل الأداة…
        </div>
      )}>
        {current === 'devices' && <DiagnosticsTool />}
        {current === 'theme' && <ThemeLabTool />}
      </Suspense>
    </ToolsContext.Provider>
  );
};

/**
 * A button that opens a tool.
 *
 * Used by the login header and the shell sidebar. `compact` drops the label
 * for dense toolbars — the `aria-label` carries the meaning, so the icon
 * alone is still announced.
 */
export const ToolLauncher: React.FC<{
  tool: ToolId;
  icon: React.ElementType;
  label: string;
  className?: string;
  compact?: boolean;
  /** Overrides the tooltip and the announced name when `label` is too terse. */
  title?: string;
}> = ({ tool, icon: Icon, label, className = '', compact = false, title }) => {
  const { open } = useTools();
  return (
    <button
      type="button"
      onClick={() => open(tool)}
      className={className}
      title={title ?? label}
      aria-label={title ?? label}
    >
      <Icon size={compact ? 16 : 15} aria-hidden="true" />
      {!compact && <span>{label}</span>}
    </button>
  );
};

export default ToolsProvider;