/**
 * Design-token guard — no fixed palette colour may enter shipped screens.
 *
 * Run:  npx tsx scripts/test-design-tokens.ts
 *
 * ══ THE DEFECT THIS GUARDS ════════════════════════════════════════════════
 * The design system speaks in semantic tokens (surface/ink/hairline/muted +
 * ok/warn/err/info/brand). Every `bg-slate-900`, `text-white`, `rose-50` or
 * `amber-500/10` compiled into a screen is a pixel the six themes cannot
 * reach: the theme switcher moves and the screen stays dark — or, after the
 * roots moved to `bg-canvas`, a `text-rose-300` label becomes invisible on
 * the white light-theme canvas. The defect is invisible to tsc and to the
 * build: a valid class that renders the wrong contract.
 *
 * ══ ALIGNMENT WITH THE CODEMOD ═══════════════════════════════════════════
 * Every exemption here mirrors `scripts/migrate-theme-tokens.ts` exactly —
 * same saturation rule, same block locks (options, receipt, night mode, QR
 * plate, LoginView diagnostics panel, ScaleHALWidget). A guard stricter than
 * the codemod cries wolf and gets silenced; looser than the codemod lets the
 * debt grow back. Comments are blanked WITH their newlines preserved, so
 * reported line numbers stay truthful.
 */
import fs from 'node:fs';
import path from 'node:path';

let pass = 0;
let fail = 0;

function check(name: string, cond: boolean, detail = ''): void {
  if (cond) { pass += 1; console.log(`  ok   ${name}`); }
  else { fail += 1; console.error(`  FAIL ${name}${detail ? ` — ${detail}` : ''}`); }
}

const ROOT = process.cwd();
const SRC = path.join(ROOT, 'src', 'components');

/** Saturated identity/status fills: white ink on them is correct in every
 * theme. `(?:-\d|\b)` covers both `bg-brand-600` and the semantic `bg-brand`
 * — white on the theme azure is the primary-button contract. Mirrors the
 * codemod's pattern exactly (asserted below). */
const SATURATED =
  /(?:bg|from|to)-(?:brand|violet|emerald|green|rose|amber|yellow|sky|teal|cyan|blue|red|orange|purple|pink|indigo|lime)(?:-\d|\b)/;

/** Fixed-palette literals that bypass the theme contract. */
const BANNED: ReadonlyArray<readonly [RegExp, string]> = [
  [/text-white\b/, 'fixed white ink → text-ink (saturated fills exempt below)'],
  [/bg-slate-950(?!\/)/, 'fixed dark canvas → bg-surface'],
  [/bg-slate-900(?!\/)/, 'fixed dark fill → bg-surface / surface-card'],
  [/\bbg-slate-800\b/, 'fixed dark chip → bg-hairline/40'],
  [/\bbg-slate-(?:50|100)\b/, 'fixed light wash → bg-subtle'],
  [/\bborder-slate-(?:100|200|700|800)\b/, 'fixed border → border-hairline'],
  [/\bdivide-slate-(?:100|800)\b/, 'fixed divider → divide-hairline'],
  [/text-slate-(?:100|200|300|400|500|600|700|800|900)\b/, 'fixed slate ink → ink/muted/faint tokens'],
  [/text-gray-(?:400|500|600|700)\b/, 'fixed grey ink → text-muted'],
  [/bg-gray-100\b/, 'fixed light wash → bg-subtle'],
  [/border-gray-200\b/, 'fixed light border → border-hairline'],
  [/bg-white(?!\/)/, 'fixed white surface → bg-surface (QR/print exempt)'],
  [/bg-rose-50\b/, 'fixed error wash → bg-err-soft'],
  [/bg-amber-50\b/, 'fixed warning wash → bg-warn-soft'],
  [/bg-(?:emerald|green)-50\b/, 'fixed success wash → bg-ok-soft'],
  [/bg-rose-500\/10\b/, 'fixed error wash → bg-err-soft'],
  [/bg-amber-500\/10\b/, 'fixed warning wash → bg-warn-soft'],
  [/text-rose-(?:300|400|600|700|800)\b/, 'fixed error ink → text-err-strong'],
  [/text-amber-(?:300|400|600|700|800|900)\b/, 'fixed warning ink → text-warn-strong'],
  [/text-(?:emerald|green)-(?:300|400|600|700|800)\b/, 'fixed success ink → text-ok-strong'],
  [/text-(?:sky|cyan|blue)-(?:300|400|600|700|800)\b/, 'fixed info ink → text-info-strong'],
  [/placeholder-slate-\d+\b/, 'fixed placeholder → placeholder-faint'],
];

/**
 * Lines exempt from the scan — mirrored from the codemod, with the reason.
 */
function isExempt(file: string, line: string, idx: number, lines: string[]): boolean {
  const t = line.trimStart();
  if (t.startsWith('*') || t.startsWith('/*') || t.startsWith('//')) return true;
  if (/<option\b/.test(line)) return true;               // native dropdowns ignore page CSS
  if (/thermal-receipt-printable/.test(line)) return true; // 80mm paper is white
  if (/nightMode/.test(line)) return true;               // operator-chosen night branch
  if (file.endsWith('ScaleHALWidget.tsx')) return true;  // lives on the dark panel only
  // White on a saturated fill is the identity/status contract — same line,
  // or a fill within the three lines above (multi-line classNames and
  // icons nested in badges). Mirrors the codemod's window rule exactly.
  if (/\btext-white\b/.test(line) && SATURATED.test(line)) return true;
  if (/\btext-white\b/.test(line)) {
    const window = lines.slice(Math.max(0, idx - 3), idx + 1).join('\n');
    if (SATURATED.test(window)) return true;
  }
  // The QR plate must stay white for scanners, in every theme.
  for (let k = Math.max(0, idx - 4); k <= Math.min(lines.length - 1, idx + 4); k++) {
    if (/\bQR\b|امسح كود/.test(lines[k] ?? '')) return true;
  }
  // The documented intentional-dark diagnostics panel in LoginView.
  if (file.endsWith('LoginView.tsx')) {
    const start = lines.findIndex((l) => l.includes('Intentionally dark'));
    if (start >= 0 && idx >= start && idx <= start + 62) return true;
  }
  return false;
}

/** Blanks comments but preserves every newline, so line numbers stay true. */
function stripComments(text: string): string {
  return text
    .replace(/\/\*[\s\S]*?\*\//g, (m) => m.replace(/[^\n]/g, ' '))
    // `[^\S\n]*` not `\s*`: a plain `\s*` after `^` crosses blank lines into
    // the next comment, and deleting that match eats the blank line's newline
    // — the stripped text ends up shorter than the source and every line
    // number after the first blank-before-comment shifts, which silently
    // disabled every line-indexed exemption below it.
    .replace(/^[^\S\n]*\/\/.*$/gm, '');
}

function collectFiles(dir: string, out: string[] = []): string[] {
  for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
    const p = path.join(dir, e.name);
    if (e.isDirectory()) collectFiles(p, out);
    else if (e.name.endsWith('.tsx')) out.push(p);
  }
  return out;
}

const files = [...collectFiles(SRC), path.join(ROOT, 'src', 'App.tsx')];
check('screen inventory is non-empty', files.length > 20, `${files.length} files`);

const violations: string[] = [];
for (const f of files) {
  const raw = fs.readFileSync(f, 'utf8');
  const lines = raw.split('\n');
  const codeLines = stripComments(raw).split('\n');
  for (const [re, why] of BANNED) {
    codeLines.forEach((ln, i) => {
      if (re.test(ln) && !isExempt(f, lines[i], i, lines)) {
        violations.push(`${path.relative(ROOT, f)}:${i + 1} ${why} :: ${ln.trim().slice(0, 90)}`);
      }
    });
  }
}

console.log('\n=== fixed-palette scan ===');
check('no fixed-palette literal in shipped screens', violations.length === 0,
  violations.length
    ? `\n    ${violations.slice(0, 25).join('\n    ')}${violations.length > 25 ? `\n    … and ${violations.length - 25} more` : ''}`
    : '');

/*
 * The codemod and the guard are one contract split across two files: if a
 * rule exists here that the codemod cannot satisfy, the pipeline is stuck
 * red forever and someone will delete the gate. Assert they agree on the
 * exemption vocabulary — the same saturation pattern must appear in both.
 */
console.log('\n=== guard and codemod agree ===');
const codemod = fs.readFileSync(path.join(ROOT, 'scripts', 'migrate-theme-tokens.ts'), 'utf8');
check('codemod defines the same SATURATED pattern',
  codemod.includes('(?:bg|from|to)-(?:brand|violet|emerald'));
check('codemod locks the same QR plate',
  codemod.includes('امسح كود'));
check('codemod locks the same LoginView panel',
  codemod.includes('Intentionally dark'));
check('codemod locks the same ScaleHALWidget file',
  codemod.includes("endsWith('ScaleHALWidget.tsx')"));

console.log(`\n${fail === 0 ? '✔' : '✘'} ${pass} passed, ${fail} failed`);
/*
 * Zero assertions means the scan executed nothing — a suite that passes by
 * running no checks is the same failure as one that never runs.
 */
if (pass === 0) {
  console.error('ERROR: no assertions executed.');
  process.exit(1);
}
process.exit(fail === 0 ? 0 : 1);

