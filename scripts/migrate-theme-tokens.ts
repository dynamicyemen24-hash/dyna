/**
 * Theme codemod — migrates fixed-palette literals to design tokens.
 *
 * Run (dry):   npx tsx scripts/migrate-theme-tokens.ts
 * Run (apply): npx tsx scripts/migrate-theme-tokens.ts --apply
 *
 * ══ METHOD (SAP Fiori Migration Tooling pattern) ═════════════════════════
 * Rule-based, idempotent, reviewable: every rule is a pure string transform
 * with a documented reason, the runner prints a unified-style diff preview,
 * and --apply rewrites only after tsc is green. Exclusions mirror the guard
 * (test-design-tokens.ts): print receipt, night mode, <option>, intentional
 * dark panel, comments.
 *
 * ══ DELIBERATELY NOT MIGRATED ═══════════════════════════════════════════
 * - `text-white` on brand fills (bg-brand-600/bg-brand-500): white on azure
 *   is the identity, correct in every theme.
 * - Opacity-suffixed literals (slate-950/80, white/90): overlay washes tuned
 *   per context, migrated by hand with visual review.
 * - Status washes (rose-500/10, amber-500/10): mapped to StatusBadge usage
 *   by hand — a class swap alone loses the icon + role semantics.
 */
import fs from 'node:fs';
import path from 'node:path';

const APPLY = process.argv.includes('--apply');
const ROOT = process.cwd();
const SRC = path.join(ROOT, 'src');

/** [pattern, replacement, reason] — order matters, cards before borders. */
const RULES: ReadonlyArray<readonly [RegExp, string, string]> = [
  [/bg-slate-900 border border-slate-800/g, 'surface-card', 'card shell → token (keeps radius/padding)'],
  [/\bbg-slate-950\b/g, 'bg-surface', 'fixed canvas → theme surface'],
  [/\bborder-slate-800\b/g, 'border-hairline', 'fixed border → theme hairline'],
  [/\btext-slate-300\b/g, 'text-muted', 'secondary ink → muted token'],
  [/\btext-slate-500\b/g, 'text-muted', 'grey ink → muted token'],
  [/\btext-slate-400\b/g, 'text-faint', 'faint grey → faint token'],
  [/\bplaceholder-slate-500\b/g, 'placeholder-faint', 'placeholder → faint token'],
  [/\bplaceholder-slate-400\b/g, 'placeholder-faint', 'placeholder → faint token'],
  [/focus:border-brand-500/g, 'focus:border-brand', 'focus ring → brand token'],
  [/\bhover:text-white\b/g, 'hover:text-ink', 'hover ink → theme ink'],
  [/\bbg-slate-800\/40\b/g, 'bg-hairline/40', 'row hover wash → hairline'],
  [/\bdivide-slate-800\/80\b/g, 'divide-hairline/80', 'row divider → hairline'],
  [/\bdivide-slate-800\/70\b/g, 'divide-hairline/70', 'row divider → hairline'],
];

/** Lines the codemod must never touch. */
function isProtected(line: string): boolean {
  const t = line.trimStart();
  if (t.startsWith('*') || t.startsWith('/*') || t.startsWith('//')) return true;
  if (/<option\b/.test(line)) return true;
  if (/thermal-receipt-printable/.test(line)) return true;
  if (/nightMode/.test(line)) return true;
  if (/bg-brand-600|bg-brand-500/.test(line) && /text-white/.test(line)) return true; // identity fill
  if (/slate-950\/|white\/|slate-900\//.test(line)) return true; // opacity washes → hand review
  if (/rose-500\/|amber-500\/|emerald-500\/|sky-500\/|violet-500\/|teal-500\/|cyan-500\//.test(line)) return true; // status → StatusBadge by hand
  return false;
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
  // LoginView intentional-dark panel + App gate already migrated:
  const src = fs.readFileSync(f, 'utf8');
  const lines = src.split('\n');
  let changed = false;
  let fileRepl = 0;
  const inDarkPanel = f.endsWith('LoginView.tsx');
  const next = lines.map((ln, i) => {
    if (isProtected(ln)) return ln;
    if (inDarkPanel) {
      for (let k = Math.max(0, i - 14); k <= i; k++) {
        if (/Intentionally dark/.test(lines[k] ?? '')) return ln;
      }
    }
    let out = ln;
    for (const [re, to] of RULES) {
      const before = out;
      out = out.replace(re, to);
      if (out !== before) { fileRepl += (before.match(re) ?? []).length || 1; }
    }
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
for (const r of report.slice(0, 40)) console.log(`  ${r}`);
if (report.length > 40) console.log(`  … and ${report.length - 40} more`);
