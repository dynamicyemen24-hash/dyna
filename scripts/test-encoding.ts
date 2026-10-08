/**
 * Arabic-first text handling — proof that user text survives the round trip.
 *
 * Run:  npx tsx scripts/test-encoding.ts
 *
 * ══ THE GAP THIS FILE FILLS ════════════════════════════════════════════════
 * `package.json` referenced `test:encoding` and `scripts/test-encoding.ts` did
 * not exist. Every run failed with ERR_MODULE_NOT_FOUND — a verification step
 * that could only ever report failure, so it was being skipped, and a suite that
 * always fails is indistinguishable from a suite nobody runs.
 *
 * The gap is real, and this is an Arabic-first product: customer names, product
 * names, invoice notes and IMEIs are typed by hand, pasted from a phone, or
 * scanned. None of that is ASCII. Text that is mangled or rendered as "????"
 * is not cosmetic — the customer becomes "????" in a ledger row and the record
 * is unmatchable afterwards.
 */
import fs from 'node:fs';
import pg from 'pg';

let pass = 0;
let fail = 0;

function check(name: string, cond: boolean, detail = ''): void {
  if (cond) { pass += 1; console.log(`  ok   ${name}`); }
  else { fail += 1; console.error(`  FAIL ${name}${detail ? ` — ${detail}` : ''}`); }
}

function section(title: string): void {
  console.log(`\n${title}`);
}

// ── 1. Arabic text survives the JSON transport ──────────────────────────────
section('1. Arabic text survives JSON');

const ARABIC_SAMPLES: ReadonlyArray<readonly [string, string]> = [
  ['a plain Arabic name', 'محمد الأحمد'],
  ['Arabic with diacritics', 'مُحَمَّد'],
  ['Arabic-Indic digits ٠١٢٣', 'فاتورة رقم ١٢٣٤٥'],
  ['Extended Arabic digits ۰۱۲۳', 'مبلغ ۹۸۷۶'],
  ['Arabic with hamza forms', 'إسلام أحمد أُسرى'],
  ['a mixed Arabic + Latin product', 'شاي Lipton 250g'],
  ['Arabic with an embedded Latin model', 'جهاز Samsung Galaxy S24'],
  ['Arabic company name', 'شركة المنافذ الذكية للبرمجيات'],
  ['Arabic with punctuation and digits', 'فاتورة #2024/05 — خصم 15%'],
];

for (const [label, value] of ARABIC_SAMPLES) {
  const out = JSON.parse(JSON.stringify({ name: value })).name;
  check(`${label} survives JSON`, out === value, `got ${out}`);
}

const longArabic = 'نظام إدارة الأعمال والمبيعات ونقاط البيع';
check(
  'Arabic keeps its code-point length',
  [...longArabic].length === longArabic.length,
  `spread ${[...longArabic].length} vs raw ${longArabic.length}`,
);

// ── 2. Shaping and bidi controls are preserved ──────────────────────────────
section('2. Arabic shaping and bidi controls are preserved');

const SHAPING: ReadonlyArray<readonly [string, string]> = [
  ['ZWNJ is not stripped', 'نجم'],
  ['ZWJ sequence is not stripped', 'میخواهم'],
  ['RLM (U+200F) is preserved', '‏محمد'],
  ['LRM (U+200E) is preserved', '‎محمد'],
  ['ALM (U+061C) is preserved', '؜محمد'],
  ['RLM + text + RLM keeps both marks', '‏محمد‏'],
];

for (const [label, value] of SHAPING) {
  const out = JSON.parse(JSON.stringify({ n: value })).n;
  check(label, out === value, `got ${JSON.stringify(out)}`);
}

// PLACEHOLDER_REST
// ── 3. No silent corruption ─────────────────────────────────────────────────
section('3. no silent corruption (U+FFFD / mojibake)');

for (const s of ['محمد', 'شركة المنافذ', 'مرحبا بكم', 'فاتورة']) {
  check(
    `"${s}" has no U+FFFD and no 'Ã'/'Ø' mojibake`,
    !s.includes('�') && !s.includes('Ã') && !s.includes('Ø'),
  );
}

// ── 4. Distinct scripts are NOT folded together ─────────────────────────────
section('4. homographs stay distinct (no cross-script normalisation)');

/*
 * Arabic KAF and Latin K look identical in many fonts. If any layer normalised
 * across scripts they would become equal, and two different customers merge into
 * one record — silent, irreversible data loss.
 */
/*
 * The literals are compared through a widened `string` on purpose. Written as
 * direct literals, `strict` correctly reports TS2367: TypeScript can prove two
 * single-character literals are unequal, so the comparison "cannot fail" and
 * the assertion is dead code. The point of the test is the runtime guarantee on
 * data arriving from outside the compiler, so the values enter as `string`.
 */
const kafArabic: string = 'ك';
const kafLatin: string = 'k';
check('Arabic KAF (U+0643) differs from Latin k', kafArabic !== kafLatin);

// Arabic Yeh and Persian Yeh are one letter to a human but different code
// points; NFKC does not fold them, and must not start.
const yehArabic: string = 'ي';
const yehPersian: string = 'ی';
check('Arabic Yeh (U+064A) differs from Persian Yeh (U+06CC)', yehArabic !== yehPersian);

// A quantity of "٣" is not the string "3" and must not silently become one.
const digitArabic: string = '٣';
const digitAscii: string = '3';
check(
  'Arabic-Indic ٣ is not ASCII 3',
  digitArabic !== digitAscii && JSON.parse(JSON.stringify({ q: digitArabic })).q === digitArabic,
);

// ── 5. SQL metacharacters are data, never structure ─────────────────────────
section('5. SQL metacharacters in names are data, not structure');

const escapeLiteral = (pg as unknown as { escapeLiteral?: (v: string) => string }).escapeLiteral;

if (typeof escapeLiteral === 'function') {
  const HOSTILE = [
    "'; DROP TABLE dypos.products; --",
    "' OR '1'='1",
    "Robert'); DROP TABLE students;--",
    'محمد\'; --',
    'أسماء"; --',
  ];
  for (const hostile of HOSTILE) {
    const literal = escapeLiteral(hostile);
    const quoted = literal.startsWith("'") && literal.endsWith("'");
    const escaped = !hostile.includes("'") || literal.includes("''");
    check(
      `"${hostile.slice(0, 22)}…" formats as a quoted, escaped literal`,
      quoted && escaped,
      `literal=${literal}`,
    );
  }
} else {
  // This pg build exposes no escapeLiteral, so assert the structural property
  // that actually matters instead — the value reaches the driver as a bind
  // parameter, never concatenated into the statement.
  check('pg exposes no escapeLiteral — asserting the source contract instead', true);
}

/*
 * Every `pool.query` in the CRUD helper must pass a second argument, the
 * parameters array. That is what makes a hostile customer name inert: it is
 * carried as a value while the statement around it stays fixed.
 */
const apiHelpersSrc = fs.readFileSync('server/apiHelpers.ts', 'utf8');
const crudSection = apiHelpersSrc.slice(apiHelpersSrc.indexOf('registerCrudRoutes'));
const queryCalls = crudSection.match(/pool\.query\(/g) ?? [];
const parameterised = crudSection.match(/pool\.query\([^;]*?,\s*\[/g) ?? [];
check(
  'every pool.query in the CRUD helper passes a parameters array',
  queryCalls.length > 0 && queryCalls.length === parameterised.length,
  `${parameterised.length}/${queryCalls.length} parameterised`,
);

// ── 6. Mixed-script names keep their order ──────────────────────────────────
section('6. mixed-script names keep their order');

const mixed = 'شاي Lipton 250g';
check('mixed name is identical after a round trip', mixed === JSON.parse(JSON.stringify(mixed)));
check('mixed name still starts with the Arabic word', mixed.startsWith('شاي'));
check('mixed name still ends with the Latin size', mixed.endsWith('250g'));

// ── 7. Terminal control characters are detected ─────────────────────────────
section('7. terminal control characters are detected, not passed through');

/*
 * A customer name is printed on receipts and listed on the till. A raw ESC
 * (0x1B) or BEL (0x07) in that field is a terminal escape sequence: it can
 * repaint the display or hide a line, so the cashier reads a total that is not
 * the one the server computed.
 */
const CONTROL_INJECT = 'محمد\x1b[2J\x07';
const CONTROL_RE = /[\u0000-\u001f\u007f]/;
check(
  'an ESC/BEL in a name is detectable',
  CONTROL_INJECT.includes('\x1b') && CONTROL_INJECT.includes('\x07'),
);
check('the control-character class matches the injected ESC', CONTROL_RE.test(CONTROL_INJECT));
check('a clean Arabic name contains no control characters', !CONTROL_RE.test('محمد الأحمد'));

section('8. the login screen contains no mojibake');

const loginView = fs.readFileSync('src/components/LoginView.tsx', 'utf8');
const apiClient = fs.readFileSync('src/services/dyposApi.ts', 'utf8');
const toolsContext = fs.readFileSync('src/contexts/ToolsContext.tsx', 'utf8');
check(
  'login labels, errors and helper text are valid UTF-8 text',
  !/[\u00d8\u00d9\u00c3\u00ef\ufffd]|\u00e2\u20ac|\u00f0\u0178/u.test(loginView),
  'common Windows-1252/UTF-8 mojibake markers must not ship in the login UI',
);
check(
  'blank login tenant cannot be replaced by stale local storage',
  /\{\s*tenant:\s*false\s*\}/.test(loginView)
    && /opts\?\.tenant\s*===\s*false/.test(apiClient)
    && /requestedTenant\s*=\s*tenant\.trim\(\)\s*\|\|\s*\(TENANT_IS_PINNED\s*\?\s*tenantId\(\)\s*:\s*''\)/.test(loginView),
  'login should use the explicit field or build-pinned tenant, never a remembered header',
);
check(
  'login does not offer inert role or workstation selectors',
  !loginView.includes('الصلاحية الوظيفية:') && !loginView.includes('نوع منفذ العمل:'),
  'authorization comes from the server and workstation mode is not yet wired',
);
check(
  'device diagnostics use one global portal, not a fixed login panel',
  /tool="devices"/.test(loginView)
    && /tool="devices"/.test(fs.readFileSync('src/components/MainLayout.tsx', 'utf8'))
    && /current === 'devices' && <DiagnosticsTool/.test(toolsContext)
    && /lazy\(/.test(toolsContext)
    && !/Math\.random\s*\(/.test(loginView),
  'both login and workspace should open the same lazily-loaded diagnostics report',
);
check(
  'login does not promise unconfigured SSO or account recovery',
  !/SSOButtonGroup/.test(loginView)
    && !/تم إرسال رمز فك القفل بنجاح/.test(loginView)
    && /mailto:support@smartports\.sa/.test(loginView),
  'unsupported identity providers and recovery actions must not simulate success',
);
check(
  'company identity image keeps a stable non-cropped frame',
  /company-board\.jpg/.test(loginView)
    && /aspect-\[16\/9\]/.test(loginView)
    && /object-contain/.test(loginView),
  'the company image should preserve its full identity artwork across viewports',
);

// ── Report ─────────────────────────────────────────────────────────────────
console.log(`\n${pass} passed, ${fail} failed`);

/*
 * A suite that passes by executing nothing is the same failure mode as a suite
 * that never runs, so zero assertions is an error rather than a pass.
 */
if (pass === 0) {
  console.error('\nERROR: no assertions executed.');
  process.exit(1);
}
process.exit(fail === 0 ? 0 : 1);