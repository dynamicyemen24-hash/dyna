/**
 * Theme codemod v2 — migrates fixed-palette literals to design tokens.
 *
 * Run (dry):   npx tsx scripts/migrate-theme-tokens.ts
 * Run (apply): npx tsx scripts/migrate-theme-tokens.ts --apply
 *
 * ══ METHOD (SAP Fiori Migration Tooling pattern) ═════════════════════════
 * Rule-based, idempotent, reviewable. v2 replaces v1's line-lock with three
 * surgical mechanisms, because a line lock could not express a ternary that
 * mixes a coloured ACTIVE state with a neutral INACTIVE state:
 *
 *   1. SATURATION RULE — `text-white → text-ink` is skipped on any line that
 *      carries a saturated fill (bg/from/to + brand/status hue), so
 *      `bg-amber-600 text-white` keeps its white while the SAME line's
 *      `bg-slate-800` inactive half still migrates.
 *   2. INK-BUTTON STAGE — a neutral dark fill paired with white text and
 *      control padding is a dark primary button (`bg-ink text-surface`), NOT
 *      `bg-surface text-ink` (which would render an invisible button on a
 *      light card). Form controls are excluded: they take field treatment.
 *   3. BLOCK LOCK — only true fixed surfaces stay locked: comments, native
 *      <option>s, the print receipt, night mode, the QR white plate (scanning
 *      needs white in every theme), the LoginView diagnostics panel (dark by
 *      design in all six themes) and ScaleHALWidget (rendered only inside it).
 *
 * v2 also migrates status washes (`bg-rose-500/10 text-rose-300`) onto the
 * semantic status tokens: after the screen roots moved to `bg-canvas`, a
 * light-pink `text-rose-300` on a white light-theme canvas is invisible —
 * that family is a functional contrast defect, not cosmetic debt.
 *
 * Order matters: washes before bare forms (`bg-slate-950/80` must be consumed
 * by its own rule before `\\bbg-slate-950\\b` can touch it), card shell before
 * generic fills, conditionals evaluated against the ORIGINAL line.
 */
import fs from 'node:fs';
import path from 'node:path';

const APPLY = process.argv.includes('--apply');
const ROOT = process.cwd();
const SRC = path.join(ROOT, 'src');

/** Saturated identity/status fills: white ink on them is correct in every
 * theme. `(?:-\d|\b)` covers both `bg-brand-600` and the semantic `bg-brand`
 * — white on the theme azure is the primary-button contract. */
const SATURATED =
  /(?:bg|from|to)-(?:brand|violet|emerald|green|rose|amber|yellow|sky|teal|cyan|blue|red|orange|purple|pink|indigo|lime)(?:-\d|\b)/;

/** The one rule with a per-line condition — reference-compared in the runner. */
const TEXT_WHITE_RULE: readonly [RegExp, string, string] =
  [/\btext-white\b/g, 'text-ink', 'fixed white ink → ink (saturated-fill lines skip)'];

/** [pattern, replacement, reason] — order is load-bearing. */
const RULES: ReadonlyArray<readonly [RegExp, string, string]> = [
  // ── card shell first (contiguous match) ─────────────────────────────────
  [/bg-slate-900 border border-slate-800/g, 'surface-card', 'card shell → token'],
  // ── opacity washes before their bare forms ──────────────────────────────
  [/\bbg-slate-950\/\d+\b/g, 'bg-subtle', 'dark wash band → subtle (thead/panel)'],
  [/\bbg-slate-900\/\d+\b/g, 'bg-subtle', 'dark wash inset → subtle'],
  // ── status washes → semantic status tokens (light-theme contrast fix) ───
  [/\bbg-rose-500\/10\b/g, 'bg-err-soft', 'error wash → status token'],
  [/\bbg-rose-50\b/g, 'bg-err-soft', 'error wash → status token'],
  [/\bborder-rose-500\/30\b/g, 'border-err/30', 'error border → status token'],
  [/\bborder-rose-300\b/g, 'border-err/30', 'error border → status token'],
  [/\bborder-rose-200\b/g, 'border-err/30', 'error border → status token'],
  [/\btext-rose-(?:300|400|600|700|800)\b/g, 'text-err-strong', 'rose ink → error ink'],
  [/\bbg-amber-500\/10\b/g, 'bg-warn-soft', 'warning wash → status token'],
  [/\bbg-amber-50\b/g, 'bg-warn-soft', 'warning wash → status token'],
  [/\bborder-amber-500\/30\b/g, 'border-warn/30', 'warning border → status token'],
  [/\bborder-amber-300\b/g, 'border-warn/30', 'warning border → status token'],
  [/\bborder-amber-200\b/g, 'border-warn/30', 'warning border → status token'],
  [/\btext-amber-(?:300|400|600|700|800|900)\b/g, 'text-warn-strong', 'amber ink → warning ink'],
  [/\bbg-(?:emerald|green)-500\/10\b/g, 'bg-ok-soft', 'success wash → status token'],
  [/\bbg-(?:emerald|green)-50\b/g, 'bg-ok-soft', 'success wash → status token'],
  [/\bborder-(?:emerald|green)-500\/30\b/g, 'border-ok/30', 'success border → status token'],
  [/\bborder-(?:emerald|green)-200\b/g, 'border-ok/30', 'success border → status token'],
  [/\btext-(?:emerald|green)-(?:300|400|600|700|800)\b/g, 'text-ok-strong', 'green ink → success ink'],
  [/\bbg-(?:sky|cyan|blue)-500\/10\b/g, 'bg-info-soft', 'info wash → status token'],
  [/\bbg-(?:sky|cyan|blue)-50\b/g, 'bg-info-soft', 'info wash → status token'],
  [/\bborder-(?:sky|cyan|blue)-500\/30\b/g, 'border-info/30', 'info border → status token'],
  [/\btext-(?:sky|cyan|blue)-(?:300|400|600|700|800)\b/g, 'text-info-strong', 'sky/blue ink → info ink'],
  [/\bbg-brand-500\/10\b/g, 'bg-brand-soft', 'brand wash → brand token'],
  [/\bbg-brand-950\/10\b/g, 'bg-brand-soft', 'brand wash → brand token'],
  [/\bbg-brand-50\b/g, 'bg-brand-soft', 'brand wash → brand token'],
  [/\btext-brand-(?:700|800)\b/g, 'text-brand-strong', 'brand step → strong'],
  [/\btext-brand-600\b/g, 'text-brand', 'brand step → semantic'],
  [/\bborder-brand-200\b/g, 'border-brand/30', 'brand tint border → token alpha'],
  // ── dark neutral surfaces (bare) ────────────────────────────────────────
  [/\bbg-slate-950\b/g, 'bg-surface', 'fixed dark canvas → theme surface'],
  [/\bbg-slate-900\b/g, 'bg-surface', 'fixed dark fill → theme surface'],
  [/\bhover:bg-slate-800\b/g, 'hover:bg-hairline/60', 'fixed hover → hairline wash'],
  [/\bhover:bg-slate-700\b/g, 'hover:bg-hairline', 'fixed hover → hairline'],
  [/\bbg-slate-800\b/g, 'bg-hairline/40', 'fixed dark chip → hairline wash'],
  // ── light-theme literals (KpiBoard family) ──────────────────────────────
  [/\bbg-slate-50\b/g, 'bg-subtle', 'fixed light wash → subtle'],
  [/\bbg-slate-100\b/g, 'bg-subtle', 'fixed light wash → subtle'],
  [/\bbg-white\b/g, 'bg-surface', 'fixed white → surface (bg-white/80 → surface/80)'],
  [/\bbg-gray-100\b/g, 'bg-subtle', 'fixed light wash → subtle'],
  [/\bborder-gray-200\b/g, 'border-hairline', 'fixed light border → hairline'],
  [/\bborder-slate-800\b/g, 'border-hairline', 'fixed dark border → hairline'],
  [/\bborder-slate-700\b/g, 'border-hairline', 'fixed mid border → hairline'],
  [/\bborder-slate-200\b/g, 'border-hairline', 'fixed light border → hairline'],
  [/\bborder-slate-100\b/g, 'border-hairline', 'fixed light border → hairline'],
  [/\bdivide-slate-800\/80\b/g, 'divide-hairline/80', 'row divider → hairline'],
  [/\bdivide-slate-800\/70\b/g, 'divide-hairline/70', 'row divider → hairline'],
  [/\bdivide-slate-800\b/g, 'divide-hairline', 'row divider → hairline'],
  [/\bdivide-slate-100\b/g, 'divide-hairline', 'row divider → hairline'],
  // ── inks ────────────────────────────────────────────────────────────────
  [/\btext-slate-900\b/g, 'text-ink', 'dark ink → ink token'],
  [/\btext-slate-800\b/g, 'text-ink', 'dark ink → ink token'],
  [/\btext-slate-700\b/g, 'text-ink', 'dark ink → ink token'],
  [/\btext-slate-600\b/g, 'text-muted', 'grey ink → muted token'],
  [/\btext-slate-500\b/g, 'text-muted', 'grey ink → muted token'],
  [/\btext-slate-400\b/g, 'text-faint', 'faint grey → faint token'],
  [/\btext-slate-300\b/g, 'text-muted', 'light grey ink → muted token'],
  [/\btext-slate-200\b/g, 'text-ink', 'light grey ink → ink token'],
  [/\btext-slate-100\b/g, 'text-ink', 'light ink → ink token'],
  [/\btext-gray-(?:400|500|600|700)\b/g, 'text-muted', 'grey ink → muted token'],
  [/\bhover:text-white\b/g, 'hover:text-ink', 'hover ink → theme ink'],
  [/\bplaceholder-slate-\d+\b/g, 'placeholder-faint', 'placeholder → faint token'],
  TEXT_WHITE_RULE,
  // ── brand edges and focus ───────────────────────────────────────────────
  [/focus:border-brand-500/g, 'focus:border-brand', 'focus ring → brand token'],
  [/\bborder-brand-500\/30\b/g, 'border-brand/30', 'brand alpha → token alpha'],
  [/\bborder-brand-500\/20\b/g, 'border-brand/20', 'brand alpha → token alpha'],
  [/\bborder-brand-500\/40\b/g, 'border-brand/40', 'brand alpha → token alpha'],
  [/\bborder-brand-500\/50\b/g, 'border-brand/50', 'brand alpha → token alpha'],
  [/\btext-brand-400\b/g, 'text-brand', 'brand step → semantic brand'],
  [/\btext-brand-300\b/g, 'text-brand-strong', 'brand step → strong'],
  [/\bborder-brand-500\b/g, 'border-brand', 'brand border → semantic brand'],
];

/** Whole-line locks: surfaces that are correct as fixed in every theme. */
function isLocked(line: string, idx: number, lines: string[]): boolean {
  const t = line.trimStart();
  if (t.startsWith('*') || t.startsWith('/*') || t.startsWith('//')) return true;
  if (/<option\b/.test(line)) return true;
  if (/thermal-receipt-printable/.test(line)) return true;
  if (/nightMode/.test(line)) return true;
  // The QR white plate: scanners need a white background in every theme.
  for (let k = Math.max(0, idx - 4); k <= Math.min(lines.length - 1, idx + 4); k++) {
    if (/\bQR\b|امسح كود/.test(lines[k] ?? '')) return true;
  }
  return false;
}

/** LoginView diagnostics panel: dark by design in all six themes (see its comment). */
function panelLock(file: string, idx: number, lines: string[]): boolean {
  if (!file.endsWith('LoginView.tsx')) return false;
  const start = lines.findIndex((l) => l.includes('Intentionally dark'));
  return start >= 0 && idx >= start && idx <= start + 62;
}

/**
 * A neutral dark fill + white text + control padding is a dark primary
 * button/box → `bg-ink text-surface`. Form controls are excluded (they take
 * field treatment: surface bg + ink text). No button marker is required:
 * any neutral-dark box paired with white text means the same thing.
 */
function inkBox(line: string): string | null {
  if (SATURATED.test(line)) return null;
  if (!/bg-slate-(?:800|900|950)/.test(line)) return null;
  if (!/\btext-white\b/.test(line)) return null;
  if (!/(?:px-\d|py-\d|rounded-)/.test(line)) return null;
  if (/<(?:input|select|textarea)\b/.test(line)) return null;
  if (/border border-slate-800/.test(line)) return null; // card shell, not a button
  return line
    .replace(/bg-slate-(?:800|900|950)/g, 'bg-ink')
    .replace(/\btext-white\b/g, 'text-surface')
    .replace(/hover:bg-slate-(?:700|800)/g, 'hover:opacity-85');
}

function collect(dir: string, out: string[] = []): string[] {
  for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
    const p = path.join(dir, e.name);
    if (e.isDirectory()) { if (!/node_modules|dist/.test(p)) collect(p, out); }
    else if (/\.tsx?$/.test(e.name)) out.push(p);
  }
  return out;
}

let filesTouched = 0;
let replTotal = 0;
const report: string[] = [];

for (const f of collect(SRC)) {
  const src = fs.readFileSync(f, 'utf8');
  const lines = src.split('\n');
  let changed = false;
  let fileRepl = 0;
  // ScaleHALWidget lives exclusively on the dark diagnostics panel.
  const fileLocked = f.endsWith('ScaleHALWidget.tsx');
  const next = lines.map((ln, i) => {
    if (fileLocked || isLocked(ln, i, lines) || panelLock(f, i, lines)) return ln;
    const saturated = SATURATED.test(ln);
    // Window rule (measured corpus: 6 same-line + 1 nested-badge = all the
    // white-on-fill shapes; zero unmigrated titles sit within three lines of
    // a saturated chip — probe-element-whites.ts, 2026-10-09): if a
    // saturated fill appears on this line or the three above it, white is
    // being coloured BY that fill and must survive. Titles near chips that
    // SHOULD be ink need a hand pass — a line pattern cannot tell a child
    // from a sibling without a JSX tree.
    const windowSat = SATURATED.test(lines.slice(Math.max(0, i - 3), i + 1).join('\n'));
    let out = inkBox(ln) ?? ln;
    const hadInkBox = out !== ln;
    for (const [re, to] of RULES) {
      if (re === TEXT_WHITE_RULE[0] && (saturated || windowSat)) continue;
      // An ink-box line already consumed its slate fills; generic slate rules
      // must not touch the token it just received.
      if (hadInkBox && re.source.includes('slate')) continue;
      const before = out;
      const matches = before.match(re);
      out = out.replace(re, to);
      if (out !== before) fileRepl += matches?.length ?? 1;
    }
    if (hadInkBox) fileRepl += 2;
    if (out !== ln) changed = true;
    return out;
  });
  if (changed) {
    filesTouched += 1;
    replTotal += fileRepl;
    report.push(`${path.relative(ROOT, f)} — ${fileRepl} replacements`);
    if (APPLY) fs.writeFileSync(f, next.join('\n'), 'utf8');
  }
}

console.log(APPLY ? 'APPLIED' : 'DRY-RUN (pass --apply to write)');
console.log(`files: ${filesTouched}, replacements: ${replTotal}`);
for (const r of report.slice(0, 50)) console.log(`  ${r}`);
if (report.length > 50) console.log(`  … and ${report.length - 50} more`);


