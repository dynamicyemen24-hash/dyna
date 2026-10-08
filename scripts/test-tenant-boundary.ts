/**
 * The boundary between system-level bootstrap and tenant-scoped data.
 *
 * Run:  npm run test:tenant-boundary
 *
 * ══ THE DEFECT THIS GUARDS ════════════════════════════════════════════════
 * `initDatabaseSchema()` seeded restaurant areas:
 *
 *   INSERT INTO dypos.restaurant_areas (id, branch_id, name)
 *   VALUES ('a1','rg-branch-hq','صالة العائلات'), …
 *
 * Two failures, and only the first is the one that gets reported:
 *
 *   1. It names no tenant, so where `tenant_id` is NOT NULL — which migration
 *      v143 sets — PostgreSQL raises 23502 and the bootstrap aborts on every
 *      start. That is the symptom.
 *
 *   2. It names a BRANCH, and a branch belongs to a tenant. `rg-branch-hq` is
 *      one merchant's branch id, so the bootstrap asserted that every deployment
 *      of this product is that merchant. "Look the tenant up from the branch"
 *      would have stopped the error while silently handing the same restaurant
 *      floor to every tenant on the deployment.
 *
 * The statement is syntactically valid; it fails only against a live schema
 * carrying the constraint, which is why it shipped.
 *
 * ══ WHY A SOURCE SCAN AND NOT A RUNTIME TEST ══════════════════════════════
 * The property is WHICH FUNCTION a statement lives in. A runtime test would
 * also pass once the row was merely tolerated — which is exactly the
 * "make it stop erroring" fix that must not be allowed to stand.
 */
import fs from 'node:fs';

let pass = 0;
let fail = 0;

function check(name: string, cond: boolean, detail = ''): void {
  if (cond) { pass += 1; console.log(`  ok   ${name}`); }
  else { fail += 1; console.error(`  FAIL ${name}${detail ? ` — ${detail}` : ''}`); }
}

const read = (rel: string): string => fs.readFileSync(rel, 'utf8');

/** Strips comments, so a table named in prose is not read as a statement. */
function stripComments(text: string): string {
  return text.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '');
}

/**
 * The body of `initDatabaseSchema` — the SYSTEM-LEVEL half only.
 *
 * The slice is taken up to the first tenant-scoped function, not to a fixed
 * name. `provisionTenantData()` is declared between the two today, and slicing
 * to `runProductionMigrations` swallowed it — so the suite reported its very
 * own correct code as a violation of the rule.
 *
 * That is the failure mode of a hardcoded boundary: it is right until someone
 * inserts a function, and then it fails in the direction that looks like a
 * product defect rather than a stale assertion.
 */
function bootstrapBody(): string {
  const src = stripComments(read('server/neonDb.ts'));
  const start = src.indexOf('export async function initDatabaseSchema');
  if (start < 0) throw new Error('initDatabaseSchema not found in server/neonDb.ts');

  // Cut at whichever tenant-scoped or migration helper comes first.
  const boundaries = [
    src.indexOf('\nasync function runProductionMigrations', start),
    src.indexOf('\nexport async function provisionTenantData', start),
    src.indexOf('\nasync function provisionTenantData', start),
  ].filter((i) => i > start);

  const end = boundaries.length ? Math.min(...boundaries) : undefined;
  return src.slice(start, end);
}

/**
 * Tables that carry `tenant_id NOT NULL`, i.e. rows owned by one merchant.
 *
 * Discovered from the bootstrap's own CREATE statements rather than listed here
 * — a hardcoded list goes stale exactly when a table is added, which is when
 * this matters most.
 */
function tenantScopedTables(body: string): string[] {
  const found = new Set<string>();
  for (const m of body.matchAll(
    /CREATE TABLE IF NOT EXISTS dypos\.(\w+)\s*\(([^;]*?)\n\s*\);/g,
  )) {
    if (/tenant_id\s+VARCHAR\(\d+\)\s+NOT NULL/.test(m[2])) found.add(m[1]);
  }
  return [...found];
}

const body = bootstrapBody();

// ── 1. No tenant-scoped INSERT in the system bootstrap ────────────────────
console.log('\n=== the system bootstrap creates no tenant data ===');
const inserts = [...body.matchAll(/INSERT\s+INTO\s+dypos\.(\w+)/gi)]
  .map((m) => m[1].toLowerCase());
const scoped = tenantScopedTables(body);
check('the bootstrap defines tenant-scoped tables to reason about',
  scoped.length > 0, `found ${scoped.join(', ')}`);

const offenders = [...new Set(inserts.filter((t) => scoped.includes(t)))];
check('no INSERT into a tenant-scoped table', offenders.length === 0,
  offenders.join(', '));

// ── 2. No hard-coded tenant or branch id in the bootstrap ─────────────────
// A literal branch id is how one merchant's data reaches every deployment. The
// seed row is gone, but the pattern can return in any statement.
console.log('\n=== no hard-coded tenant identity in the bootstrap ===');
const literalBranch = /'(rg-branch|br-)[A-Za-z0-9-]*'/i.exec(body);
check('no literal branch id in any statement', !literalBranch, literalBranch?.[0]);
check('no INSERT into dypos.tenants', !inserts.includes('tenants'),
  'a tenant must come from the operator, never from a bootstrap');

// ── 3. The bootstrap agrees with the migration ────────────────────────────
// The original cause was two sources of truth: the CREATE here knew nothing
// about tenancy, and v143 added it. A future table must not repeat that.
console.log('\n=== the schema and its tenant rules agree ===');
for (const table of scoped) {
  check(`${table}.tenant_id is NOT NULL in the bootstrap CREATE`,
    new RegExp(
      `CREATE TABLE IF NOT EXISTS dypos\\.${table}\\s*\\([\\s\\S]*?`
      + `tenant_id\\s+VARCHAR\\(\\d+\\)\\s+NOT NULL[\\s\\S]*?\\n\\s*\\);`,
    ).test(body));
}

// ── 4. Tenant data has a home that demands a tenant ────────────────────────
console.log('\n=== tenant data is created only inside a tenant context ===');
const code = stripComments(read('server/neonDb.ts'));
check('a tenant-scoped provisioning function is exported',
  /export async function provisionTenantData/.test(code));

const fnStart = code.indexOf('export async function provisionTenantData');
const fnBody = code.slice(fnStart, fnStart + 6000);
check('it refuses an empty tenant id rather than defaulting',
  /if\s*\(!tenant\)\s*\{[\s\S]{0,400}?throw new Error/.test(fnBody),
  'a default tenant here would be a silent cross-tenant write');
check('it verifies the tenant exists',
  /FROM dypos\.tenants WHERE id = \$1/.test(fnBody));
check('every id it writes is derived from the tenant',
  /\$\{tenant\}-area-/.test(fnBody) && /\$\{tenant\}-t-/.test(fnBody),
  'a global id collides across tenants and one silently loses its rows');

// ── 5. Nothing quietly drops the constraint ────────────────────────────────
console.log('\n=== tenant_id is never relaxed ===');
const migrations = fs.readdirSync('server/migrations')
  .filter((f) => f.endsWith('.sql'))
  .map((f) => ({ f, sql: read(`server/migrations/${f}`) }));

const relax = migrations.filter((m) =>
  /ALTER\s+COLUMN\s+tenant_id\s+DROP\s+NOT\s+NULL/i.test(m.sql));
check('no migration drops NOT NULL on tenant_id', relax.length === 0,
  relax.map((m) => m.f).join(', '));

// RLS must not be switched off to make a write succeed.
const rlsOff = migrations.filter((m) =>
  /DISABLE\s+ROW\s+LEVEL\s+SECURITY/i.test(m.sql));
check('no migration disables row-level security', rlsOff.length === 0,
  rlsOff.map((m) => m.f).join(', '));
check('the runtime never disables RLS either',
  !/DISABLE\s+ROW\s+LEVEL\s+SECURITY/i.test(code));

// ── 6. Connection security ────────────────────────────────────────────────
// `rejectUnauthorized: false` is what people reach for when a certificate error
// appears, and it makes the error go away by allowing a machine in the middle
// to present a certificate it generated itself.
console.log('\n=== the database connection verifies its certificate ===');
check('server/neonDb.ts does not disable certificate verification',
  !/rejectUnauthorized:\s*false/i.test(code));

for (const f of fs.readdirSync('scripts').filter((x) => x.endsWith('.ts'))) {
  // The guard itself documents the forbidden pattern in prose and in its own
  // regex literal — scanning it would always fail. Strip comments so prose
  // never counts as code, and skip the guard file whose literal is the check.
  if (f === 'test-tenant-boundary.ts') continue;
  check(`scripts/${f} does not disable certificate verification`,
    !/rejectUnauthorized:\s*false/i.test(stripComments(read(`scripts/${f}`))),
    'a provisioning script must not connect less safely than the server');
}

// ── 7. The optional AI dependency cannot stop the POS ──────────────────────
console.log('\n=== a missing Gemini key cannot block startup ===');
const serverCode = stripComments(read('server.ts'));
check('no GoogleGenAI is constructed at module scope',
  !/^const\s+\w+\s*=\s*new GoogleGenAI/m.test(serverCode),
  'constructed at import time it is a startup dependency for an optional feature');
check('the client is built lazily, behind a key check',
  /function getAiClient\(\)/.test(serverCode)
  && /if\s*\(!aiApiKey\)\s*return null/.test(serverCode));
check('an unconfigured assistant reports 503, not a server fault',
  /status\(503\)/.test(serverCode),
  'absent by configuration is not the same as broken');

console.log(`\n${fail === 0 ? '✔' : '✘'} ${pass} passed, ${fail} failed`);
process.exit(fail === 0 ? 0 : 1);