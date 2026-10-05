/**
 * Typography delivery — the typeface must not depend on a third party.
 *
 * Run:  npm run test:typography
 *
 * ══ THE DEFECT THIS GUARDS ════════════════════════════════════════════════
 * The whole design system is built around IBM Plex Sans Arabic: every spacing,
 * column width and line break in the product was tuned against its metrics.
 *
 * `index.html` loaded it from `fonts.googleapis.com`. That made the foundation
 * of the design a network request to somebody else's server, and the failure
 * mode is invisible: nothing throws, no test fails, the console stays clean.
 * The browser simply falls back down the stack to whatever Arabic font the
 * device has — different metrics, so the layout stops matching itself, and
 * `font-display: swap` shows that wrong font first and then reflows the page
 * underneath the operator.
 *
 * On a till in Yemen this is the ordinary case, not the edge case, and it was
 * reported as "the design does not look like itself and the text is wrong".
 * Nothing in the build, the type-checker or any existing suite can see it,
 * because a working `@font-face` and a missing one are equally valid CSS.
 *
 * ══ WHAT IS ASSERTED ═════════════════════════════════════════════════════
 * The properties that make the font deliverable, checked on the SOURCE rather
 * than on a network request, so this runs offline and in CI:
 *
 *   1. no third-party font host is referenced anywhere;
 *   2. every weight the design system uses has a real face;
 *   3. every referenced face exists on disk as a valid WOFF2;
 *   4. each face declares `unicode-range`, so a Latin screen does not download
 *      the Arabic subset;
 *   5. the service worker pre-caches them, so an offline till still renders in
 *      the real typeface.
 */
import fs from 'node:fs';
import path from 'node:path';

let pass = 0;
let fail = 0;

function check(name: string, cond: boolean, detail = ''): void {
  if (cond) { pass += 1; console.log(`  ok   ${name}`); }
  else { fail += 1; console.error(`  FAIL ${name}${detail ? ` — ${detail}` : ''}`); }
}

const read = (rel: string): string => fs.readFileSync(rel, 'utf8');

const FONT_DIR = path.join('public', 'fonts');
const css = read(path.join('src', 'index.css'));
const html = read('index.html');
const sw = read(path.join('public', 'sw.js'));

const onDisk = fs.existsSync(FONT_DIR)
  ? fs.readdirSync(FONT_DIR).filter((f) => f.endsWith('.woff2'))
  : [];

/**
 * Strips comments, leaving only code.
 *
 * Load-bearing, and it was caught by this very suite: the block comment
 * explaining WHY the Google Fonts link was removed necessarily names
 * `fonts.googleapis.com`, so a naive scan reported the fix as a regression.
 *
 * A scan that cannot tell a mention from a dependency is a scan that gets
 * silenced rather than fixed the first time it cries wolf — and then it never
 * catches the real thing.
 */
function stripComments(text: string): string {
  return text.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '');
}

const cssCode = stripComments(css);
const htmlCode = stripComments(html);
const swCode = stripComments(sw);

// ── 1. No third-party font host ───────────────────────────────────────────
// Checked across every file that can put a font on the screen: the shell, the
// stylesheet and the service worker. A `<link>` in index.html alone was the
// original defect, but a CSS `@import` or a fetch in sw.js would reintroduce it
// just as silently.
console.log('\n=== no third-party font host ===');
for (const [label, text] of [
  ['index.html', htmlCode], ['index.css', cssCode], ['sw.js', swCode],
] as const) {
  const hosts = [...text.matchAll(/fonts\.(googleapis|gstatic|bunny|adobe|fontawesome)\.com/g)]
    .map((m) => m[0]);
  check(`${label} references no external font host`, hosts.length === 0,
    [...new Set(hosts)].join(', '));
}
check('index.html declares no <link> to any external stylesheet',
  !/<link[^>]+href=["']https?:\/\//i.test(htmlCode));
check('the stylesheet @imports nothing from a URL',
  !/@import\s+(?:url\()?["']?https?:/i.test(cssCode));

// ── 3. Every referenced face exists and is a real WOFF2 ──────────────────
// A `@font-face` pointing at a missing file fails silently at runtime, exactly
// like the CDN case. And a truncated download is worse than a missing one,
// because the bytes are still served.
console.log('\n=== every referenced file exists and is a valid WOFF2 ===');
const referenced = [...new Set(
  [...css.matchAll(/url\(['"]?(\/fonts\/[^'")]+)['"]?\)/g)].map((m) => m[1]),
)];
check('the stylesheet references at least one face', referenced.length > 0);

for (const url of referenced) {
  const file = path.join('public', url.replace(/^\//, ''));
  if (!fs.existsSync(file)) {
    check(`${url} exists`, false, 'referenced by CSS but not on disk');
    continue;
  }
  const bytes = fs.readFileSync(file);
  // The WOFF2 signature is the ASCII "wOF2". Checking it catches an HTML error
  // page saved under a .woff2 name, which a size check would pass.
  const magic = bytes.subarray(0, 4).toString('ascii');
  check(`${url} is a valid WOFF2 (${bytes.length} bytes)`,
    magic === 'wOF2' && bytes.length > 4096, `magic=${magic}`);
}

// Nothing on disk that the CSS does not use: an orphan face is a weight that
// costs pre-cache space on every till and renders nothing.
console.log('\n=== nothing unreferenced left in public/fonts ===');
for (const f of onDisk) {
  check(`${f} is referenced by the stylesheet`, css.includes(`/fonts/${f}`));
}

// ── 4. unicode-range keeps Latin screens small ────────────────────────────
// Without it the browser must assume a face may contain any glyph, so an
// English-only screen downloads the 43 KB Arabic subset just to draw digits.
/*
 * Counted per FAMILY × weight × subset, not as a total.
 *
 * The original assertion was "eight faces", which silently encoded one family.
 * Adding the second family then reported a failure that read like a defect
 * when it was the assertion that was stale — and an assertion phrased as a
 * magic number is one that has to be edited by hand every time the design
 * system gains a tier.
 *
 * So the property is stated instead: each declared family must have a face for
 * every weight it declares, in both subsets.
 */
console.log('\n=== each family is complete ===');
const faces = [...css.matchAll(/@font-face\s*\{[^}]*\}/g)].map((m) => m[0]);

const families = new Map<string, { weights: Set<string>; subsets: Set<string> }>();
for (const face of faces) {
  const family = /font-family:\s*'([^']+)'/.exec(face)?.[1];
  const weight = /font-weight:\s*(\d+)/.exec(face)?.[1];
  const subset = /\/fonts\/[a-z]*-?(arabic|latin)-/.exec(face)?.[1];
  if (!family || !weight || !subset) continue;
  const entry = families.get(family) ?? { weights: new Set(), subsets: new Set() };
  entry.weights.add(weight);
  entry.subsets.add(subset);
  families.set(family, entry);
}

check('both families are declared', families.size === 2,
  [...families.keys()].join(', '));

/**
 * The weights each family actually ships, as a subset of what the design
 * system asks for.
 *
 * Tajawal is issued in 400/500/700 only — there is no 600 cut. A `@font-face`
 * for 600 would not be wrong, the browser would simply SYNTHESIS it by
 * smearing the neighbours, and a synthesised Arabic weight is visibly wrong in
 * a way no test reports: it is the "font looks bad" complaint with no cause.
 *
 * So the expected set is per family, and the assertion is that each declared
 * weight is one this family really has. `headings` resolve to 700, which Tajawal
 * does ship, so the heading tier is unaffected.
 */
const FAMILY_WEIGHTS: Record<string, number[]> = {
  'IBM Plex Sans Arabic': [400, 500, 600, 700],
  'Tajawal': [400, 500, 700],
};

for (const [family, { weights, subsets }] of families) {
  check(`${family} declares an Arabic and a Latin subset`,
    subsets.has('arabic') && subsets.has('latin'),
    [...subsets].join(', '));

  const expected = FAMILY_WEIGHTS[family];
  if (!expected) {
    check(`${family} is a known family`, false, 'add it to FAMILY_WEIGHTS');
    continue;
  }

  // No synthesised weights: every declared face must be a real cut.
  for (const w of weights) {
    check(`${family} declares only shipped weights (${w})`,
      expected.includes(Number(w)), `expected one of ${expected.join(', ')}`);
  }

  // And no missing ones, or the browser synthesises in the other direction.
  for (const w of expected) {
    check(`${family} declares weight ${w}`, weights.has(String(w)),
      `declares ${[...weights].sort().join(', ')}`);
  }
}

for (const face of faces) {
  const w = /font-weight:\s*(\d+)/.exec(face)?.[1];
  const family = /font-family:\s*'([^']+)'/.exec(face)?.[1];
  const subset = /\/fonts\/[a-z]*-?(arabic|latin)-/.exec(face)?.[1];
  check(`${family} ${w} ${subset} declares unicode-range`, /unicode-range:/.test(face));
}

check('an Arabic face covers the Arabic block (U+0600-06FF)',
  faces.some((f) => /arabic-/.test(f) && /unicode-range:[^;]*U\+0600-06FF/.test(f)));
check('a Latin face covers ASCII (U+0000-00FF)',
  faces.some((f) => /latin-/.test(f) && /unicode-range:[^;]*U\+0000-00FF/.test(f)));

// ── 5. The offline till keeps its typeface ────────────────────────────────
// This product is offline-first; a font that only exists on first paint is a
// font that is wrong on exactly the screen where the merchant needs it most.
console.log('\n=== the service worker pre-caches the faces ===');
for (const f of onDisk) {
  check(`sw.js pre-caches ${f}`, sw.includes(`/fonts/${f}`));
}
check('sw.js cache name is versioned',
  /const CACHE_NAME = 'dypos-offline-v[\d.]+'/.test(sw));

// ── 6. The families are actually applied ─────────────────────────────────
// Self-hosting the files proves nothing if no rule selects them.
//
// The heading tier is asserted as an ELEMENT rule rather than a per-component
// class: ~40 screens each opting in separately is a design that stays
// consistent only until someone writes the next one. An element selector is
// what makes the pairing hold on a screen nobody has opened yet.
console.log('\n=== the families are applied ===');
const bodyRule = /body\s*\{[^}]*\}/.exec(css)?.[0] ?? '';
check('body resolves the sans token', /font-family:\s*var\(--font-sans\)/.test(bodyRule));
check('a fallback stack is still declared for a missing file',
  /font-family:[^;]*,\s*[^;]*,/.test(css));

const headingRule = /h1,\s*h2,\s*h3,\s*h4,\s*h5,\s*h6\s*\{[^}]*\}/.exec(css)?.[0] ?? '';
check('headings resolve the display token (Tajawal)',
  /font-family:\s*var\(--font-display\)/.test(headingRule));

check('the display token names Tajawal first',
  /--font-display:\s*'Tajawal'/.test(css));
check('the sans token names IBM Plex Sans Arabic first',
  /--font-sans:\s*'IBM Plex Sans Arabic'/.test(css));
check('a numeric token exists for figures', /--font-numeric:/.test(css));

// ── 7. Numerals are Latin even inside Arabic text ─────────────────────────
// This is a bidi property, not a preference. Under dir="rtl" a digit run can be
// reordered against its Arabic neighbours, so "من 12 إلى 5" renders with the
// ends swapped unless the number is isolated. Nothing fails when that happens —
// the number is simply wrong on screen — so it is asserted here.
console.log('\n=== numerals are Latin and bidi-safe ===');
const numericRule = /\.num,\s*\.text-numeric\s*\{[^}]*\}/.exec(css)?.[0] ?? '';
check('figures declare unicode-bidi: isolate',
  /unicode-bidi:\s*isolate/.test(numericRule));
check('figures pin direction: ltr so 1,234.50 cannot reorder',
  /direction:\s*ltr/.test(numericRule));
check('figures use tabular figures', /tabular-nums/.test(numericRule));
check('body pins lining Latin digits as the default',
  /font-variant-numeric:[^;]*lining-nums/.test(cssCode));

// The Latin subsets are what actually draw those digits, so a font without a
// Latin face would silently fall back for every number on screen.
check('the display face has a Latin subset', css.includes('/fonts/tajawal-latin-'));
check('the body face has a Latin subset', css.includes('/fonts/latin-'));

// Tajawal is preloaded at the weight headings actually use. Preloading 400
// while headings render at 700 buys nothing and costs a second round trip.
check('index.html preloads the display face at 700',
  /preload[^>]*tajawal-arabic-700/.test(htmlCode));

console.log(`\n${fail === 0 ? '✔' : '✘'} ${pass} passed, ${fail} failed`);
process.exit(fail === 0 ? 0 : 1);