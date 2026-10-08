/**
 * Design-token guard — no fixed palette colour may enter shipped screens.
 *
 * Run:  npx tsx scripts/test-design-tokens.ts
 *
 * ══ THE DEFECT THIS GUARDS ════════════════════════════════════════════════
 * The design system speaks in semantic tokens (surface/ink/hairline/muted +
 * ok/warn/err/info/brand). Every `bg-slate-900`, `text-white`, `rose-50` or
 * `amber-500/10` compiled into a screen is a pixel the six themes cannot
 * reach: the theme switcher moves and the screen stays dark. The defect is
 * invisible to tsc and to the build — a valid class that renders the wrong
 * contract.
 *
 * ══ WHY A SCAN AND NOT A LINTER ═════════════════════════════════════════════
 * The banned values are syntactically ordinary Tailwind classes. Only meaning
 * distinguishes "a token the theme owns" from "a literal the theme cannot
 * move". Comment lines are excluded: the rationale comments naming the old
 * values are the most valuable lines in the file.
 *
 * ══ SCOPE ═════════════════════════════════════════════════════════════════
 * Guarded: src/components + src/App.tsx (shipped screens).
 * Exempt:  print-only receipt (white paper is a physical fact), POS night
 *           mode branch (operator-chosen amber-on-black), <option> elements
 *           (native dropdowns ignore page CSS), diagnostics side panel
 *           (documented intentional-dark monitoring surface).
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

/** Fixed-palette literals that bypass the theme contract. */
const BANNED: ReadonlyArray<readonly [RegExp, string]> = [
  [/bg-slate-950(?!\/)/, 'fixed dark canvas — use bg-canvas'],
  [/bg-slate-900(?!\/)/, 'fixed dark card — use bg-surface / surface-card'],
  [/text-slate-100\b/, 'fixed light ink — use text-ink'],
  [/text-white\b/, 'fixed white ink — use text-ink (exempt: on-brand fills, night mode, print)'],
  [/border-slate-800\b/, 'fixed dark border — use border-hairline'],
  [/bg-rose-50\b/, 'fixed light error wash — use bg-err-soft'],
  [/bg-amber-50\b/, 'fixed light warning wash — use bg-warn-soft'],
  [/text-rose-600\b/, 'fixed light error ink — use text-err-strong'],
  [/text-slate-500\b/, 'fixed grey ink — use text-muted'],
  [/text-slate-400\b/, 'fixed faint grey — use text-faint'],
  [/bg-white(?!\/)/, 'fixed white surface — use bg-surface (exempt: print receipt)'],
  [/border-gray-200\b/, 'fixed light border — use border-hairline'],
];

/** Lines that are intentionally fixed — matched with surrounding context. */
function isExempt(file: string, line: string, idx: number, lines: string[]): boolean {
  const t = line.trimStart();
  if (t.startsWith('*') || t.startsWith('/*') || t.startsWith('//')) return true;
  if (/<option\b/.test(line)) return true; // native dropdowns ignore page CSS
  if (/thermal-receipt-printable/.test(line)) return true; // 80mm paper is white
  if (/nightMode/.test(line)) return true; // operator-chosen night branch
  // The documented intentional-dark diagnostics panel in LoginView:
  if (file.endsWith('LoginView.tsx')) {
    for (let k = Math.max(0, idx - 12); k <= idx; k++) {
      if (/Intentionally dark/.test(lines[k] ?? '')) return true;
    }
  }
  return false;
}

function stripComments(text: string): string {
  return text.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '');
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

let violations: string[] = [];
for (const f of files) {
  const raw = fs.readFileSync(f, 'utf8');
  const lines = raw.split('\n');
  const code = stripComments(raw).split('\n');
  for (const [re, why] of BANNED) {
    code.forEach((ln, i) => {
      if (re.test(ln) && !isExempt(f, lines[i], i, lines)) {
        violations.push(`${path.relative(ROOT, f)}:${i + 1} ${why} :: ${ln.trim().slice(0, 90)}`);
      }
    });
  }
}

console.log('\n=== fixed-palette scan ===');
check('no fixed-palette literal in shipped screens', violations.length === 0,
  violations.length ? `\n    ${violations.slice(0, 25).join('\n    ')}${violations.length > 25 ? `\n    … and ${violations.length - 25} more` : ''}` : '');

console.log(`\n${fail === 0 ? '✔' : '✘'} ${pass} passed, ${fail} failed`);
process.exit(fail === 0 ? 0 : 1);
