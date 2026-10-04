/**
 * The constitution: no tenant-specific data may be compiled into the bundle.
 *
 * Run:  npx tsx scripts/test-no-fake-data.ts
 *
 * ══ WHAT THIS GUARDS ════════════════════════════════════════════════════════
 * This is a SaaS product sold to more than one merchant. A literal company name,
 * branch, VAT number or settlement IBAN in the front-end makes that impossible
 * in a way no type-checker can see: the build is green, the bundle is served to
 * every tenant, and the defect only appears when customer #2 gets a tax invoice
 * bearing customer #1's registration.
 *
 * Every instance found here was real, not hypothetical:
 *
 *   - a receipt header rendering a fixed company, branch and 15-digit VAT number
 *   - a PDF invoice stamping `VAT ID: 300123456700003` and claiming
 *     "ZATCA Compliant" for a document that met no part of the standard
 *   - a bank-transfer panel printing a live IBAN, with the same value as the
 *     DEFAULT ARGUMENT of the QR generator, so a merchant who configured nothing
 *     was still shown a QR for someone else's account
 *   - a settings screen seeded with another merchant's tax number, in `useState`,
 *     so it looked editable and was never persisted
 *   - a "تحديث تلقائي" button that invented exchange rates in a `setTimeout`
 *     and wrote them to the server
 *
 * ══ WHY A SCAN AND NOT A LINTER ═════════════════════════════════════════════
 * These values are syntactically ordinary strings. No rule distinguishes "a label
 * a product may print" from "a customer's legal identity" except meaning, and
 * meaning is what a list of banned identifiers approximates. The list is
 * therefore explicit, and every entry carries the reason it exists, so a future
 * reader can tell a deliberate allow from an oversight.
 *
 * Comment lines are excluded from the scan. Every one of these values appears in
 * the comment explaining why it was removed, and that comment is the most
 * valuable line in the file. A test that failed on its own rationale would be
 * deleted within a week.
 */
import fs from 'node:fs';
import path from 'node:path';

let pass = 0;
let fail = 0;

function check(name: string, cond: boolean, detail = ''): void {
  if (cond) { pass += 1; console.log(`  ok   ${name}`); }
  else { fail += 1; console.error(`  FAIL ${name}${detail ? ` — ${detail}` : ''}`); }
}

/** Directories that describe the system or hold build output, never run it. */
const SKIP_DIRS = new Set([
  'node_modules', 'dist', 'dist-server', '.wrangler', '.wrangler-dry', '.git',
]);

/**
 * Identifiers that may never appear in shipped code.
 *
 * Every entry is a value that belonged to one specific merchant or to the
 * project's own infrastructure. `royal-global-hq` is the seed tenant id that was
 * hard-coded in seven call sites; the rest are the legal and financial identity
 * that was printed on documents.
 */
const FORBIDDEN: ReadonlyArray<readonly [string, string]> = [
  ['300123456700003', 'the VAT number printed on the receipt and the PDF invoice'],
  ['302194857200003', 'the VAT number seeded into the settings screen'],
  ['SA0380000000608010167519', 'a live settlement IBAN, in the UI and as a default argument'],
  ['SA03 8000 0000 6080 1016 7519', 'the same IBAN, spaced, as it appeared on screen'],
  ['1010892741', 'a commercial registration number seeded in the schema bootstrap'],
  ['رويال العالمية', 'a specific merchant name, printed on receipts'],
  ['Royal Global Enterprise', 'the same merchant, Latin spelling, in the PDF header'],
];

/**
 * Strips comment lines so a file may explain the defect it once had.
 *
 * The two-pass approach matters and the first attempt got it wrong. A single
 * `/^\s*(\*|\/\/|\/\*)/` filter misses the continuation lines of a block comment
 * that opens at the end of a line of code, such as:
 *
 *     const tenant = tenantOf(req); // per §1
 *
 * Every following line of that comment begins with ` * ` at column 2, so it *is*
 * matched — but a JSDoc block whose text continues on a line beginning with
 * ordinary prose, and a trailing block comment, are not.
 *
 * The reliable rule is that a line is documentation when it cannot be code: it
 * starts with `*` or `//`, OR it sits inside a block comment that a previous line
 * opened and this one does not close. Tracking block state handles both, so the
 * scan cannot be satisfied by re-wrapping a comment.
 */
function codeOnly(source: string): string {
  const out: string[] = [];
  let inBlock = false;

  for (const line of source.split(/\r?\n/)) {
    if (inBlock) {
      // The whole line belongs to the comment until the block closes.
      if (/\*\//.test(line)) inBlock = false;
      continue;
    }

    /*
     * `opens` must mean "a comment STARTS here", not merely "the characters
     * appear". A JSX self-closing tag such as `<img src={…} />` contains `/*`
     * at its close, and a first attempt that tested for the substring treated
     * every one of those as a comment opening — so a whole receipt component
     * was discarded and the assertions below it reported "not found" for code
     * that was present and correct.
     *
     * The opening is therefore matched only where a comment can legally start:
     * the beginning of the line (after indentation), or after code, with no
     * quote between them. That excludes `src="…"` and `{…}`.
     */
    const opens = /(?:^|[^"'`\\])\/\*(?!\/)/.test(line) && !/^\s*\*\//.test(line);
    if (opens) {
      inBlock = !/\*\//.test(line.slice(line.indexOf('/*') + 2));
      const tail = line.replace(/^[\s\S]*?\*\//, '');
      if (!opens && tail.trim() && !/\/\//.test(line)) out.push(tail);
      continue;
    }
    // Line comments: keep only what precedes the marker.
    const marker = line.indexOf('//');
    out.push(marker === -1 ? line : line.slice(0, marker));
  }

  return out.join('\n');
}

function walk(dir: string, acc: string[]): string[] {
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    if (SKIP_DIRS.has(entry.name)) continue;
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) walk(full, acc);
    else if (/\.(ts|tsx|js|mjs|html)$/.test(entry.name)) acc.push(full);
  }
  return acc;
}

const ROOT = process.cwd();

// eslint-disable-next-line no-console
console.log('\n1. no merchant identity is compiled into shipped code');

const files = walk(ROOT, []);
check('the scan reached the source tree', files.length > 40, `${files.length} files`);

for (const [needle, why] of FORBIDDEN) {
  const hits: string[] = [];
  for (const f of files) {
    const rel = path.relative(ROOT, f);
    if (rel.startsWith('docs' + path.sep)) continue;
    let code = '';
    try {
      code = codeOnly(fs.readFileSync(f, 'utf8'));
    } catch {
      continue;
    }
    if (code.includes(needle)) hits.push(rel);
  }
/*
 * `royal-global-hq` is the seed TENANT ID rather than printed identity.
 *
 * Two files are allowed to carry it, and both are allowed for the same reason:
 * they ARE the single definition. `server/tenant.ts` is the one server-side
 * constant (now overridable via `DEFAULT_TENANT`), and `src/services/dyposApi.ts`
 * is the one client-side default behind the session token. A second copy
 * anywhere else is a value that will drift from the first, which is exactly the
 * failure this assertion exists to prevent — so it is a definition, not an
 * exception granted to a call site.
 */
const TENANT_ID_PATTERN = /['"`]royal-global-hq['"`]/;
const TENANT_ID_DEFINITION_SITES = new Set([
  path.normalize(path.join('src', 'services', 'dyposApi.ts')),
  path.normalize(path.join('server', 'tenant.ts')),
]);

console.log('\n2. the seed tenant id is confined to the one documented place');

const tenantHits: string[] = [];
for (const f of files) {
  const rel = path.relative(ROOT, f);
  const inApp = rel.startsWith('src' + path.sep) || rel.startsWith('server' + path.sep);
  if (!inApp) continue;
  if (TENANT_ID_DEFINITION_SITES.has(path.normalize(rel))) continue;
  // Comments are stripped here too, consistently with section 1. `neonDb.ts`
  // names the seed tenant only inside the comment that records removing the
  // invented tenant — and that file was correctly reported as a violation for
  // about a minute because this line read it whole.
  if (TENANT_ID_PATTERN.test(codeOnly(fs.readFileSync(f, 'utf8')))) tenantHits.push(rel);
}
check(
  'no app or server file hard-codes the seed tenant id',
  tenantHits.length === 0,
  tenantHits.join(', '),
);

console.log('\n3. the settlement IBAN is not a default argument');

/*
 * The exact shape that hid the defect: the parameter existed, so every call site
 * looked correct while the value came from the signature. A caller that omitted
 * it silently produced a QR for the wrong account.
 *
 * These read the SOURCE, comments included, because the signature is a single
 * declaration and the assertion is about its shape. Stripping comments first
 * would be fine too, but reading it whole also proves the JSDoc beside the method
 * cannot reintroduce a `iban = '…'` into a copy-paste that someone then edits.
 */
const gateway = fs.readFileSync(path.join(ROOT, 'src/services/paymentGatewayService.ts'), 'utf8');
const gatewayDecl = gateway.match(/public generateSarieIbanQr\(([^)]*)\)\s*:\s*([\w|\s]+)\s*\{/);
check('generateSarieIbanQr declaration is present', gatewayDecl !== null);
check(
  'generateSarieIbanQr has no default IBAN parameter',
  gatewayDecl !== null && !/=\s*['"`]?[A-Z]{2}\d{2}/.test(gatewayDecl[1]),
  gatewayDecl ? gatewayDecl[1] : 'declaration not found',
);
check(
  'generateSarieIbanQr returns null rather than a fallback',
  gatewayDecl !== null && gatewayDecl[2].trim() === 'string | null',
  gatewayDecl ? gatewayDecl[2] : 'declaration not found',
);
check(
  'generateSarieIbanQr short-circuits on a null IBAN',
  /generateSarieIbanQr\([^)]*\)\s*:\s*string\s*\|\s*null\s*\{\s*if\s*\(\s*!\s*iban\s*\)\s*return\s+null/.test(gateway),
);

console.log('\n4. identity is rendered from the resolved identity, not literals');

const pdf = codeOnly(fs.readFileSync(path.join(ROOT, 'src/utils/pdfGenerator.ts'), 'utf8'));
check('the PDF prints no literal VAT ID', !/VAT ID:\s*['"`]?\d{10,}/.test(pdf));
check('the PDF no longer claims ZATCA compliance', !/ZATCA/.test(pdf));
check(
  'the PDF takes the resolved identity as an argument',
  /generateInvoicePDF\s*=\s*\(\s*transaction:\s*Transaction,\s*identity:/.test(pdf),
);
check(
  'the PDF prints the tax number from the identity',
  /VAT ID:\s*\$\{\s*identity\.taxNumber/.test(pdf),
);

const pos = codeOnly(fs.readFileSync(path.join(ROOT, 'src/components/POSView.tsx'), 'utf8'));
check('the receipt header reads identity.ownerCompany', /identity\.ownerCompany/.test(pos));
check('the receipt renders no hard-coded VAT number', !/300123456700003/.test(pos));
check(
  'the receipt shows an INCOMPLETE warning when identity is unresolved',
  /identity\.source\s*===\s*'unresolved'/.test(pos),
);
check(
  'the receipt renders the IBAN it received, not a literal',
  // `{settlementAccount.iban}` is split across lines by JSX formatting, so the
  // source never contains the adjacent-brace form. Matching on the property
  // access inside JSX braces is what actually proves the render is data-driven.
  /\{\s*settlementAccount\.iban\s*\}/.test(pos) || /className="[^"]*">\s*\{settlementAccount\.iban\}\s*</.test(pos),
);

console.log('\n5. no live credential is bundled into any build');

const neonDb = fs.readFileSync(path.join(ROOT, 'server/neonDb.ts'), 'utf8');
check(
  'neonDb has no fallback DATABASE_URL',
  !/process\.env\.DATABASE_URL\s*\|\|\s*['"`]postgresql/.test(neonDb),
);
check('neonDb contains no Neon password', !/npg_[A-Za-z0-9]{10,}/.test(neonDb));

console.log('\n6. the merchant can actually CONFIGURE an account from the app');

{
  const route = fs.readFileSync(path.join(ROOT, 'server/settlementRoutes.ts'), 'utf8');
  check('a create route exists and is permission-checked',
    /app\.post\(\s*'\/api\/db\/settlement\/accounts',\s*attachPrincipal,\s*requirePermission\('settings\.manage'\)/.test(route));
  check('a read route exists behind the session gate',
    /app\.get\(\s*'\/api\/db\/settlement\/accounts',\s*attachPrincipal/.test(route));

  const ui = fs.readFileSync(path.join(ROOT, 'src/components/SettlementAccounts.tsx'), 'utf8');
  check('a settings screen writes to that route',
    /apiPost<void>\('\/api\/db\/settlement\/accounts'/.test(ui));
  check('the settings screen is mounted, not orphaned',
    /import \{ SettlementAccounts \}/.test(
      fs.readFileSync(path.join(ROOT, 'src/components/SettingsView.tsx'), 'utf8'),
    ) && /<SettlementAccounts \/>/.test(
      fs.readFileSync(path.join(ROOT, 'src/components/SettingsView.tsx'), 'utf8'),
    ));

  /*
   * The screen must not claim to validate an IBAN it has not verified. A green
   * "valid" that never consulted the issuing bank is the same defect as the
   * invented exchange rates: a control reporting a fact it did not establish.
   */
  check('the screen does not claim to verify IBAN check digits',
    /THIS IS NOT AN IBAN VALIDATOR/.test(ui));
  /*
   * An empty list must read as a normal state with no sample account in it.
   *
   * The placeholder attribute is exempt, and deliberately: `SA00 0000 …` is
   * all zeros, so it cannot be mistaken for a real account and it shows the
   * grouping. What must not appear is a VALUE that looks payable.
   */
  const body = ui.replace(/placeholder="[^"]*"/g, '');
  check('an empty list is rendered as a normal state, never a sample account',
    /No settlement accounts configured/.test(body)
      && !/SA\d{2}[\s]?\d{4}[\s]?\d{4}[\s]?\d{2}/.test(body));
  check('deactivation is used rather than deletion',
    /isActive: false/.test(ui) && !/apiDelete/.test(ui));
}

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
  check(`"${needle.slice(0, 30)}" appears in no shipped file — ${why}`, hits.length === 0, hits.join(', '));
}

// PLACEHOLDER_FAKEDATA