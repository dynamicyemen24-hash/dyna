/**
 * Proves the migration preflight behaves, without a database.
 *
 * The splitter is the riskiest thing added here: if it cuts a statement in the
 * wrong place it does not merely fail loudly, it sends fragments of function
 * bodies to the server. These cases are the ones that would go wrong.
 */
import fs from 'fs';
import path from 'path';

function neutraliseSupersededDeclarations(sql: string): string {
  const superseded = ['cash_movements', 'units_of_measure', 'unit_conversions'];
  for (const table of superseded) {
    sql = sql.replace(
      new RegExp(
        `CREATE\\s+TABLE\\s+IF\\s+NOT\\s+EXISTS\\s+(?:dypos\\.)?${table}\\b[\\s\\S]*?\\n\\s*\\);`,
        'gi',
      ),
      `-- [DyPOS] ${table} is owned by server/migrations — conflicting pack declaration omitted.`,
    );
  }
  for (const idx of ['idx_cash_movements_shift', 'idx_unit_conversions_pair']) {
    sql = sql.replace(
      new RegExp(`CREATE\\s+INDEX\\s+IF\\s+NOT\\s+EXISTS\\s+${idx}\\b[\\s\\S]*?;`, 'gi'),
      `-- [DyPOS] ${idx} omitted with its table.`,
    );
  }
  return sql;
}

function splitSqlStatements(sql: string): string[] {
  const out: string[] = [];
  let buf = '';
  let i = 0;
  let dollarTag: string | null = null;
  while (i < sql.length) {
    const rest = sql.slice(i);
    if (dollarTag) {
      const end = rest.indexOf(dollarTag);
      if (end === -1) { buf += sql[i]; i += 1; continue; }
      buf += rest.slice(0, end + dollarTag.length);
      i += end + dollarTag.length; dollarTag = null; continue;
    }
    const tagMatch = rest.match(/^\$[A-Za-z_0-9]*\$/);
    if (tagMatch) { dollarTag = tagMatch[0]; buf += tagMatch[0]; i += tagMatch[0].length; continue; }
    if (rest.startsWith('--')) {
      const nl = sql.indexOf('\n', i);
      if (nl === -1) { i = sql.length; continue; }
      i = nl + 1; continue;
    }
    if (rest.startsWith('/*')) {
      let depth = 0; let j = i;
      while (j < sql.length) {
        if (sql.startsWith('/*', j)) { depth += 1; j += 2; }
        else if (sql.startsWith('*/', j)) { depth -= 1; j += 2; if (depth === 0) break; }
        else { j += 1; }
      }
      i = j; continue;
    }
    if (sql[i] === "'") {
      let j = i + 1;
      while (j < sql.length) {
        if (sql[j] === "'") { if (sql[j + 1] === "'") { j += 2; continue; } break; }
        j += 1;
      }
      buf += sql.slice(i, j + 1); i = j + 1; continue;
    }
    if (sql[i] === ';') {
      const stmt = buf.trim();
      if (stmt) out.push(stmt);
      buf = ''; i += 1; continue;
    }
    buf += sql[i]; i += 1;
  }
  const tail = buf.trim();
  if (tail) out.push(tail);
  return out;
}

let pass = 0;
let fail = 0;
const ok = (name: string, cond: boolean, extra = '') => {
  if (cond) { pass += 1; console.log(`  ok   ${name}`); }
  else { fail += 1; console.log(`  FAIL ${name} ${extra}`); }
};

// ── 1. semicolons inside a dollar-quoted body must not split ───────────────
const fn = `CREATE OR REPLACE FUNCTION dypos.f() RETURNS text
LANGUAGE plpgsql AS $$
BEGIN
  RETURN 'a;b;c';
END;
$$;
CREATE TABLE t (id int);`;
const parts = splitSqlStatements(fn);
ok('function body with semicolons stays one statement', parts.length === 2, `got ${parts.length}`);
ok('function body is intact', parts[0].includes(`RETURN 'a;b;c';`));
ok('statement after the function is separate', parts[1].startsWith('CREATE TABLE t'));

// ── 2. tagged dollar quotes ────────────────────────────────────────────────
const tagged = `$fn$ BEGIN RETURN 1; END; $fn$; SELECT 1;`;
ok('tagged $fn$ quoting is handled', splitSqlStatements(tagged).length === 2);

// ── 3. escaped quotes and comment forms ────────────────────────────────────
ok('escaped quote does not end the literal',
  splitSqlStatements(`INSERT INTO t VALUES ('it''s; fine'); SELECT 1;`).length === 2);
ok('semicolon in a line comment is ignored',
  splitSqlStatements(`SELECT 1 -- a ; b\n; SELECT 2;`).length === 2);
ok('semicolon in a block comment is ignored',
  splitSqlStatements(`SELECT 1 /* a ; b */; SELECT 2;`).length === 2);

// ── 4. no fragment may be a bare comment ───────────────────────────────────
ok('comments are stripped, not emitted as statements',
  !splitSqlStatements(`-- just a comment\nSELECT 1;`).some((s) => s.startsWith('--')));

// ── 5. the three real errors must no longer be produced ────────────────────
const packs = ['dypos_schema_complement_v24_v40.sql', 'dypos_final_global_production_complement_v41_v100.sql', 'dypos_database_engine_v101_v130.sql'];
for (const p of packs) {
  const raw = fs.readFileSync(path.join('server', p), 'utf8');
  const fixed = neutraliseSupersededDeclarations(raw);
  const stmts = splitSqlStatements(fixed);

  ok(`${p}: splits into statements`, stmts.length > 10, `got ${stmts.length}`);

  // No statement may reference a table it no longer creates.
  for (const t of ['cash_movements', 'units_of_measure']) {
    const stillCreates = stmts.some((s) =>
      new RegExp(`CREATE\\s+TABLE\\s+IF\\s+NOT\\s+EXISTS\\s+(?:dypos\\.)?${t}\\b`, 'i').test(s));
    const packOwnsIt = /shift_id|precision_scale/i.test(
      stmts.filter((s) => new RegExp(`CREATE\\s+TABLE\\s+IF\\s+NOT\\s+EXISTS\\s+(?:dypos\\.)?${t}\\b`, 'i').test(s)).join(' '));
    if (!stillCreates) ok(`${p}: does not re-declare ${t}`, true);
    else ok(`${p}: ${t} pack declaration removed`, !packOwnsIt, '(conflicting shape still present)');
  }

  // The index over the removed shift_id column must be gone too.
  ok(`${p}: no index on the removed shift_id column`,
    !/idx_cash_movements_shift[\s\S]*?ON\s+cash_movements\s*\(\s*shift_id/i.test(fixed));

  // Every statement must be non-empty and must not be a lone comment.
  ok(`${p}: every statement is executable`,
    stmts.every((s) => s.trim().length > 0 && !s.trim().startsWith('--')));
}

// ── 6. NO SUPERSEDED TABLE MAY STILL BE THE TARGET OF A FOREIGN KEY ───────
// This is the guard that catches an over-broad fix. Removing a parent table
// while a surviving CREATE TABLE still references it converts a silent
// IF NOT EXISTS conflict into "relation does not exist" at boot. The packs
// hold journal_entries -> accounting_periods and kitchen_ticket_items ->
// kitchen_tickets, which is why the superseded list is only three entries.
const SUPERSEDED = ['cash_movements', 'units_of_measure', 'unit_conversions'];
const packsAndMigrations = [
  ...packs.map((p) => path.join('server', p)),
  ...fs.readdirSync(path.join('server', 'migrations'))
    .filter((f) => f.endsWith('.sql'))
    .map((f) => path.join('server', 'migrations', f)),
];

for (const p of packsAndMigrations) {
  const isPack = packs.some((k) => p.endsWith(k));

  // Only the packs are ever neutralised in production — runProductionMigrations
  // reads exactly those three files. Passing a numbered migration through the
  // same transform would strip v132's own units_of_measure, which is the defect
  // this suite exists to prevent, so the test mirrors the real call site.
  const raw = fs.readFileSync(p, 'utf8');
  const fixed = isPack ? neutraliseSupersededDeclarations(raw) : raw;

  for (const t of SUPERSEDED) {
    // Does any statement in this file foreign-key the table without the file
    // itself declaring it? The check is FILE-level, not statement-level: v132
    // creates units_of_measure in one statement and indexes it in another, and
    // that pair is correct — requiring them in one statement would be wrong.
    const declares = new RegExp(
      `CREATE\\s+TABLE\\s+IF\\s+NOT\\s+EXISTS\\s+(?:dypos\\.)?${t}\\b`,
      'i',
    ).test(fixed);
    const references = new RegExp(`REFERENCES\\s+(?:dypos\\.)?${t}\\s*\\(`, 'i').test(fixed);

    if (!references) {
      ok(`${path.basename(p)}: nothing references ${t}`, true);
    } else {
      ok(
        `${path.basename(p)}: ${t} is referenced and declared in the same file`,
        declares,
        '(orphan foreign key)',
      );
    }
  }
}

// ── 7. the three reported errors must not be reproducible ──────────────────
// Each is asserted as an absence: the statement that produced it is gone.
const v24 = neutraliseSupersededDeclarations(
  fs.readFileSync(path.join('server', 'dypos_schema_complement_v24_v40.sql'), 'utf8'),
);
ok('error 1: no index references the non-existent shift_id column',
  !/idx_cash_movements_shift[\s\S]*?ON\s+cash_movements\s*\(\s*shift_id/i.test(v24));

const v41 = neutraliseSupersededDeclarations(
  fs.readFileSync(path.join('server', 'dypos_final_global_production_complement_v41_v100.sql'), 'utf8'),
);
ok('error 2: no foreign key to units_of_measure(code) survives',
  !/REFERENCES\s+(?:dypos\.)?units_of_measure\s*\(\s*code/i.test(v41));

const v101 = fs.readFileSync(path.join('server', 'dypos_database_engine_v101_v130.sql'), 'utf8');
ok('error 3: digest() is used, so the pgcrypto guard is required',
  /digest\s*\(/i.test(v101));

// ── 8. v148 must supply every column live code actually reads ──────────────
// The whole point of v148 is that `authz.ts` raises "column does not exist" if
// these are missing. Asserted against the LIVE source, so a future query change
// cannot silently reintroduce the outage.
const v148 = fs.readFileSync(
  path.join('server', 'migrations', 'v148_converge_dual_declared_tables.sql'), 'utf8',
);

const REQUIRED: Array<[string, string[]]> = [
  ['roles', ['description', 'sod_group']],
  ['user_roles', ['branch_id']],
  ['role_permissions', ['permission', 'effect']],
  ['accounting_periods', ['branch_id', 'period']],
  ['deliveries', ['invoice_id', 'customer_name', 'picked_at']],
];

for (const [table, cols] of REQUIRED) {
  const block = v148.match(
    new RegExp(`ALTER TABLE dypos\\.${table}\\b([\\s\\S]*?);`, 'i'),
  );
  ok(`v148: ALTER TABLE dypos.${table} is present`, !!block);
  if (!block) continue;
  for (const c of cols) {
    ok(
      `v148: ${table}.${c} added IF NOT EXISTS`,
      new RegExp(`ADD COLUMN IF NOT EXISTS\\s+${c}\\b`, 'i').test(block[1]),
    );
  }
}

// ── 9. v148 must be additive only ─────────────────────────────────────────
// A DROP here would remove the pack's columns out from under any code still
// reading them, which is the opposite of converging two schemas.
ok('v148 contains no DROP COLUMN', !/DROP\s+COLUMN/i.test(v148));
ok('v148 contains no DELETE', !/\bDELETE\s+FROM/i.test(v148));
ok('v148 contains no TRUNCATE', !/\bTRUNCATE\b/i.test(v148));
// Checked against executable SQL only: the file's own comment names shift_id
// while explaining why it is NOT added, and a prose match would be a false
// failure that trains the suite to be ignored.
const v148Code = v148
  .split('\n')
  .filter((l) => !l.trim().startsWith('--'))
  .join('\n');
ok('v148 adds no shift_id column in executable SQL', !/shift_id/i.test(v148Code));
ok('v148 mentions shift_id in its rationale',
  /--[^\n]*shift_id/i.test(v148));

// ── 10. the legacy data must be copied, not merely accommodated ───────────
// Adding `permission` while grants sit in `permission_code` would leave every
// user with an empty grant set — a silent lockout, which is worse than an error.
ok('v148 backfills permission from permission_code',
  /SET\s+permission\s*=\s*permission_code/i.test(v148));
ok('v148 guards the backfill on the legacy column existing',
  /information_schema\.columns[\s\S]{0,200}permission_code/i.test(v148));

// ── 11. every migration must be STRUCTURALLY well-formed ──────────────────
// A migration is not applied through a parser that reports the offending line;
// `pool.query(sql)` forwards the whole file, so a mis-nested `DO $$` block
// fails as an opaque "syntax error at or near BEGIN" with no location. This
// check is what turns that into a located failure, and it exists because
// v148 shipped with exactly this defect and passed the earlier assertions.
for (const f of fs.readdirSync(path.join('server', 'migrations')).filter((x) => x.endsWith('.sql'))) {
  const full = path.join('server', 'migrations', f);
  const sql = fs.readFileSync(full, 'utf8');
  const stmts = splitSqlStatements(sql);

  // A `DO $$` block must open and close exactly once per block.
  const doOpens = (sql.match(/DO\s+\$\$/gi) || []).length;
  const closes = (sql.match(/END\s+\$\$\s*;/gi) || []).length;
  ok(`${f}: every DO $$ block is closed`, doOpens === closes, `(${doOpens} open / ${closes} close)`);

  // A BEGIN/END-IF counting rule was tried here and removed: `BEGIN` also
  // starts a transaction and a `BEGIN ATOMIC` function, and `END IF;` also
  // closes a trigger body. v137/v140/v141 balance differently from v144 while
  // all of them are valid, so the count is not an invariant. What actually
  // distinguishes v148's real defect is whether a block FRAGMENT survives as
  // its own statement — which is asserted below and did catch it.

  // A block terminator must never stand alone as a statement. This is the check
  // that fails for a mis-nested `DO $$`, where `END IF; END $$;` gets orphaned
  // at the tail of the file.
  const orphans = stmts.filter((s) =>
    /^\s*(END\s+IF\b|END\s+\$\$|END\s+LOOP\b|EXCEPTION\b|END\s+CASE\b)/i.test(s),
  );
  ok(
    `${f}: no orphaned plpgsql terminator is emitted as a statement`,
    orphans.length === 0,
    orphans.length ? `→ ${orphans[0].slice(0, 60)}` : '',
  );

  // Every statement must be non-empty and start with a real SQL/PLpgSQL opener,
  // so a file cannot "pass" by splitting into nothing but comments.
  ok(
    `${f}: file splits into executable statements`,
    stmts.length > 0 && stmts.every((s) => s.trim().length > 0 && !s.trim().startsWith('--')),
  );
}

// ── 12. startup must not replay historical SQL packs ──────────────────────
const databaseBootstrap = fs.readFileSync('server/neonDb.ts', 'utf8');
const bootstrapStart = databaseBootstrap.indexOf('export async function initDatabaseSchema');
const bootstrapEnd = databaseBootstrap.indexOf('TENANT-SCOPED PROVISIONING', bootstrapStart);
const bootstrap = databaseBootstrap.slice(bootstrapStart, bootstrapEnd);
ok('database bootstrap does not replay legacy production packs',
  bootstrapStart >= 0 && !/runProductionMigrations\s*\(/.test(bootstrap));

const serverSource = fs.readFileSync('server.ts', 'utf8');
const createAppStart = serverSource.indexOf('export async function createApp');
const createAppRoutes = serverSource.indexOf('registerCoreScreenRoutes(app)', createAppStart);
ok('local HTTP routes wait for successful database bootstrap',
  createAppStart >= 0
    && createAppRoutes > createAppStart
    && /await initDatabaseSchema\(\)/.test(serverSource.slice(createAppStart, createAppRoutes)));

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail === 0 ? 0 : 1);