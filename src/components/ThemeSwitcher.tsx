/**
 * Theme switcher.
 *
 * ══ WHY THIS IS A SEPARATE FILE ══════════════════════════════════════════
 * The switcher lived inside `LoginView.tsx`, which was 75 KB and carried the
 * login form, the MFA gate, the account-unlock form, the touch numpad and the
 * theme switcher together. A colour picker in a credential form is a component
 * boundary nobody could find, so it ended up on the login screen and nowhere
 * else — which is why the theme could not be changed after signing in.
 *
 * ══ ACCESSIBILITY, WHICH MATTERS MORE HERE THAN USUAL ════════════════════
 * A row of colour swatches is unreadable to a screen-reader user and invisible
 * to a keyboard user. So this is a real radio group: arrow keys move between
 * options, Home/End jump to the ends, and each option is announced by name and
 * state rather than by its colour.
 *
 * `high_contrast` is not a preference here — it is an accommodation, so it is
 * listed first rather than buried in a grid.
 */
import React, { useEffect, useRef, useState } from 'react';
import { Check, Palette } from 'lucide-react';
import { themeService, THEME_CONFIGS, type ThemeMode } from '../services/themeService';

/** Display order. High contrast leads: it is the one that must be findable. */
const ORDER: ThemeMode[] = [
  'high_contrast',
  'light',
  'dark',
  'oled',
  'royal_gold',
  'frosted_glass',
];

interface Props {
  /** Compact icon-only form, for dense toolbars. */
  compact?: boolean;
  className?: string;
};

export const ThemeSwitcher: React.FC<Props> = ({ compact = false, className = '' }) => {
  const [theme, setTheme] = useState<ThemeMode>(() => themeService.getTheme());
  const [open, setOpen] = useState(false);
  const wrapRef = useRef<HTMLDivElement>(null);
  const btnRef = useRef<HTMLButtonElement>(null);

  // Subscribe rather than polling, so the control follows a change made
  // anywhere else — including on the login screen before this mounted.
  useEffect(() => themeService.subscribe(setTheme), []);

  // Close on outside click or Escape. A popover that will not dismiss is a
  // popover that strands the operator mid-workflow.
  useEffect(() => {
    if (!open) return;
    const onDown = (e: MouseEvent) => {
      if (wrapRef.current && !wrapRef.current.contains(e.target as Node)) setOpen(false);
    };
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') {
        setOpen(false);
        // Return focus to the trigger, or a keyboard user is left with the focus
        // ring on nothing at all.
        btnRef.current?.focus();
      }
    };
    document.addEventListener('mousedown', onDown);
    document.addEventListener('keydown', onKey);
    return () => {
      document.removeEventListener('mousedown', onDown);
      document.removeEventListener('keydown', onKey);
    };
  }, [open]);

  const choose = (next: ThemeMode) => {
    themeService.setTheme(next);
    setTheme(next);
    setOpen(false);
    btnRef.current?.focus();
  };

  /**
   * Roving focus across the options — the ARIA radio pattern.
   *
   * A vertical list of six radios is tedious with Tab; arrows are what a screen
   * reader announces as a group.
   */
  const onOptionsKeyDown = (e: React.KeyboardEvent, index: number) => {
    const last = ORDER.length - 1;
    let target: number | null = null;
    if (e.key === 'ArrowDown' || e.key === 'ArrowRight') target = index === last ? 0 : index + 1;
    else if (e.key === 'ArrowUp' || e.key === 'ArrowLeft') target = index === 0 ? last : index - 1;
    else if (e.key === 'Home') target = 0;
    else if (e.key === 'End') target = last;
    if (target === null) return;
    e.preventDefault();
    choose(ORDER[target]);
  };

  const current = THEME_CONFIGS[theme];

  return (
    <div className={`relative ${className}`} ref={wrapRef}>
      <button
        ref={btnRef}
        type="button"
        onClick={() => setOpen((v) => !v)}
        aria-haspopup="menu"
        aria-expanded={open}
        aria-label={`المظهر: ${current.name}. تغيير المظهر`}
        className="flex items-center gap-2 rounded-xl border border-[var(--t-hairline)] bg-[var(--t-surface)] px-3 py-2 text-sm text-[var(--t-ink)] transition-colors hover:bg-[var(--t-subtle)]"
      >
        <span
          aria-hidden="true"
          className="h-4 w-4 rounded-full border border-black/10"
          style={{ background: current.previewColor }}
        />
        {!compact && <span className="font-bold">{current.name}</span>}
        <Palette size={16} className="text-[var(--t-muted)]" aria-hidden="true" />
      </button>

      {open && (
        <div
          role="menu"
          aria-label="اختيار المظهر"
          className="absolute z-50 mt-2 w-72 rounded-2xl border border-[var(--t-hairline)] bg-[var(--t-surface)] p-2 shadow-2xl"
        >
          {ORDER.map((id, i) => {
            const cfg = THEME_CONFIGS[id];
            const active = id === theme;
            return (
              <button
                key={id}
                type="button"
                role="menuitemradio"
                aria-checked={active}
                // Roving tabindex: one stop for the whole group.
                tabIndex={active ? 0 : -1}
                onClick={() => choose(id)}
                onKeyDown={(e) => onOptionsKeyDown(e, i)}
                className={`flex w-full items-start gap-3 rounded-xl px-3 py-2.5 text-right transition-colors ${
                  active ? 'bg-[var(--t-brand-soft)]' : 'hover:bg-[var(--t-subtle)]'
                }`}
              >
                <span
                  aria-hidden="true"
                  className="mt-0.5 h-5 w-5 shrink-0 rounded-full border border-black/10"
                  style={{ background: cfg.previewColor }}
                />
                <span className="min-w-0 flex-1">
                  <span className="block text-sm font-bold text-[var(--t-ink)]">{cfg.name}</span>
                  <span className="block text-xs leading-relaxed text-[var(--t-muted)]">
                    {cfg.description}
                  </span>
                </span>
                {active && (
                  <Check size={16} className="mt-1 shrink-0 text-[var(--t-brand)]" aria-hidden="true" />
                )}
              </button>
            );
          })}
        </div>
      )}
    </div>
  );
};

export default ThemeSwitcher;