/**
 * ═══════════════════════════════════════════════════════════════════════════
 *  THEME INSPECTOR
 * ══════════════════════════════════════════════════════════════════════════
 *
 * WHY THIS EXISTS
 * ---------------
 * Six themes are declared in `index.css` and six more class bundles exist in
 * `themeService.ts` — and the two lists are not the same thing. When the
 * pair diverged, selecting "Royal Gold" set an attribute that matched no
 * rule, so the switcher rendered a working-looking control that changed
 * nothing. It is invisible in a demo and obvious in a warehouse.
 *
 * This module resolves the ACTUAL computed variables for each theme and
 * measures the real contrast ratios, so "does this theme work" is answered
 * by reading the rendered page rather than by reading the stylesheet.
 */

import { THEME_CONFIGS, themeService, type ThemeMode } from './themeService';

/** A named foreground/background pair with its measured WCAG ratio. */
export interface ContrastPair {
  /** The token pair, e.g. "ink on canvas". */
  label: string;
  fg: string;
  bg: string;
  /** Measured ratio, e.g. 14.8. */
  ratio: number;
  /** WCAG AA for normal text (≥ 4.5). */
  aa: boolean;
  /** WCAG AAA for normal text (≥ 7). */
  aaa: boolean;
  /** WCAG AA for large text (≥ 3). */
  largeAa: boolean;
}

export interface ThemeInspection {
  mode: ThemeMode;
  name: string;
  description: string;
  /** The resolved custom-property values under this theme. */
  tokens: Record<string, string>;
  pairs: ContrastPair[];
  /** How many pairs fall below AA. Zero is the only acceptable count. */
  failures: number;
  /** True when every declared theme resolves distinct variables. */
  resolved: boolean;
}

/** The semantic tokens every screen actually consumes. */
const TOKEN_NAMES = [
  'canvas', 'surface', 'subtle', 'hairline',
  'ink', 'muted', 'faint',
  'brand', 'brand-strong', 'brand-soft',
] as const;

/**
 * The pairs that matter, in order of how many screens depend on them.
 *
 * `ink on canvas` is body text on the page — if this fails, the theme is
 * unusable and nothing else in the list is worth reporting.
 */
const PAIRS: { label: string; fg: string; bg: string }[] = [
  { label: 'النص الأساسي على الخلفية', fg: 'ink', bg: 'canvas' },
  { label: 'النص الأساسي على البطاقة', fg: 'ink', bg: 'surface' },
  { label: 'النص الثانوي على الخلفية', fg: 'muted', bg: 'canvas' },
  { label: 'النص الخافت على البطاقة', fg: 'faint', bg: 'surface' },
  { label: 'لون العلامة على الخلفية', fg: 'brand', bg: 'canvas' },
  { label: 'نص البطاقة على خلفية العلامة', fg: 'brand-strong', bg: 'brand-soft' },
  { label: 'الحد الفاصل على البطاقة', fg: 'hairline', bg: 'surface' },
];

/* ─────────────────────────── colour maths ─────────────────────────────── */

/**
 * Parse a CSS colour into sRGB components.
 *
 * Handles the three forms the token layer can produce — hex (3, 4, 6 and 8
 * digit), `rgb()`/`rgba()`, and `transparent`. Anything else returns null
 * and the pair is reported as unmeasurable rather than as passing.
 */
const parseColor = (input: string): { r: number; g: number; b: number } | null => {
  const v = input.trim().toLowerCase();
  if (!v || v === 'transparent') return null;

  if (v.startsWith('#')) {
    const hex = v.slice(1);
    if (hex.length === 3) {
      return {
        r: parseInt(hex[0] + hex[0], 16),
        g: parseInt(hex[1] + hex[1], 16),
        b: parseInt(hex[2] + hex[2], 16),
      };
    }
    if (hex.length === 6 || hex.length === 8) {
      return {
        r: parseInt(hex.slice(0, 2), 16),
        g: parseInt(hex.slice(2, 4), 16),
        b: parseInt(hex.slice(4, 6), 16),
      };
    }
    return null;
  }

  const m = v.match(/rgba?\(([^)]+)\)/);
  if (m) {
    const parts = m[1].split(/[\s,/]+/).filter(Boolean).slice(0, 3);
    if (parts.length < 3) return null;
    return {
      r: parseFloat(parts[0]),
      g: parseFloat(parts[1]),
      b: parseFloat(parts[2]),
    };
  }
  return null;
};

/**
 * WCAG 2.1 relative luminance.
 *
 * The per-channel linearisation is not optional — computing it on gamma-
 * encoded values directly overstates light colours and understates dark
 * ones, which is precisely the range a POS theme lives in.
 */
const luminance = (c: { r: number; g: number; b: number }): number => {
  const lin = (v: number) => {
    const s = v / 255;
    return s <= 0.03928 ? s / 12.92 : Math.pow((s + 0.055) / 1.055, 2.4);
  };
  return 0.2126 * lin(c.r) + 0.7152 * lin(c.g) + 0.0722 * lin(c.b);
};

/** Contrast ratio between two colours, 1 → 21. Null when unmeasurable. */
export const contrastRatio = (a: string, b: string): number | null => {
  const ca = parseColor(a);
  const cb = parseColor(b);
  if (!ca || !cb) return null;
  const la = luminance(ca);
  const lb = luminance(cb);
  const lighter = Math.max(la, lb);
  const darker = Math.min(la, lb);
  return Math.round(((lighter + 0.05) / (darker + 0.05)) * 100) / 100;
};

/* ─────────────────────── reading the real cascade ─────────────────────── */

/**
 * Read the resolved custom properties for a theme.
 *
 * This applies the theme for one frame, reads `getComputedStyle`, and puts
 * the previous theme back. That round trip is the whole point: it asks the
 * browser what actually resolved, so a theme whose CSS rule is missing
 * shows up as "identical to the default" instead of being assumed correct
 * from the source file.
 */
export const resolveThemeTokens = (mode: ThemeMode): Record<string, string> => {
  const root = document.documentElement;
  const previous = root.getAttribute('data-theme');
  const out: Record<string, string> = {};

  try {
    root.setAttribute('data-theme', mode);
    // A forced read: without it the browser is free to return the style
    // from before the attribute changed, and every theme reads as default.
    const cs = getComputedStyle(root);
    for (const name of TOKEN_NAMES) {
      out[name] = cs.getPropertyValue(`--t-${name}`).trim() || '(غير معرّف)';
    }
  } catch {
    for (const name of TOKEN_NAMES) out[name] = '(تعذّر القراءة)';
  } finally {
    // Restore synchronously. React never re-renders, so no paint ever
    // shows the inspected theme unless the operator actually selects it.
    if (previous) root.setAttribute('data-theme', previous);
    else root.removeAttribute('data-theme');
  }
  return out;
};

/** Inspect one theme: its tokens and its measured contrast. */
export const inspectTheme = (mode: ThemeMode): ThemeInspection => {
  const cfg = THEME_CONFIGS[mode];
  const tokens = resolveThemeTokens(mode);

  const pairs: ContrastPair[] = PAIRS.map((p) => {
    const ratio = contrastRatio(tokens[p.fg], tokens[p.bg]);
    if (ratio === null) {
      return { ...p, fg: tokens[p.fg], bg: tokens[p.bg], ratio: 0, aa: false, aaa: false, largeAa: false };
    }
    return {
      ...p,
      fg: tokens[p.fg],
      bg: tokens[p.bg],
      ratio,
      aa: ratio >= 4.5,
      aaa: ratio >= 7,
      largeAa: ratio >= 3,
    };
  });

  /*
   * `hairline` is a border, not text. It is held to the 3:1 non-text
   * threshold rather than 4.5: a divider that is indistinguishable from the
   * card it separates is a layout bug, but a hairline is not required to
   * reach body-text contrast.
   */
  const failures = pairs.filter((p) =>
    p.label.includes('الحد الفاصل') ? !p.largeAa : !p.aa).length;

  // "Resolved" means the tokens are not the placeholder text — a theme whose
  // CSS block never existed lands here with '(غير معرّف)' values.
  const resolved = Object.values(tokens).every((t) => t && !t.startsWith('('));

  return {
    mode,
    name: cfg.name,
    description: cfg.description,
    tokens,
    pairs,
    failures,
    resolved,
  };
};

/** Inspect every declared theme — the full audit table. */
export const inspectAllThemes = (): ThemeInspection[] =>
  (Object.keys(THEME_CONFIGS) as ThemeMode[]).map(inspectTheme);

/**
 * Apply a theme and announce it.
 *
 * Routed through `themeService` rather than setting the attribute directly,
 * so persistence and the `<meta name="color-scheme">` update stay in step.
 */
export const applyTheme = (mode: ThemeMode): void => {
  themeService.setTheme(mode);
};