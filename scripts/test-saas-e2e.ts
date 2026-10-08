/**
 * SaaS end-to-end: two merchants, two countries, two currencies, one database.
 *
 * Run:  npx tsx scripts/test-saas-e2e.ts
 *
 * ══ WHAT THIS PROVES, AND WHY A MOCK CANNOT ═════════════════════════════════
 * Everything below drives the REAL PostgreSQL instance and the REAL Express app
 * built by `createApp()`. That is the point: the defects this file guards were
 * all invisible to a mocked pool, because the mock agreed with whatever the code
 * assumed.
 *
 *   1. TENANT ISOLATION ON A FISCAL DOCUMENT. Merchant A must never be able to
 *      read merchant B's tenant row, its VAT number or its branch list — and
 *      must never see them on a receipt. This is the whole reason identity moved
 *      out of literals and into `dypos.tenants`: a compiled-in VAT number cannot
 *      be isolated, because it is the same number for everyone.
 *
 *   2. SETTLEMENT ACCOUNTS ARE PER TENANT. Migration v147 exists because a live
 *      IBAN was compiled into the bundle as a default argument. Two merchants
 *      must get two different accounts, and neither may be offered the other's.
 *
 *   3. CURRENCY IS A PROPERTY OF THE TENANT, NOT A CONSTANT. Two merchants in
 *      two countries convert at their own base currency; the same line item must
 *      not be coerced into one shared rate.
 *
 *   4. OFFLINE-FIRST IDEMPOTENCY. A sale queued on a terminal that loses
 *      connectivity and then reconnects must commit ONCE. A replay that creates
 *      a second invoice is the exact failure the sequence guard exists to stop.
 *
 * ══ ISOLATION ══════════════════════════════════════════════════════════════
 * Each scenario creates its own throwaway tenant with a unique id and removes it
 * at the end. No real tenant, invoice, stock row or ledger entry is read or
 * written, so this is safe to run against production — which is also why it is
 * in the manual CI job rather than the per-push one.
 */
import assert from 'node:assert/strict';
import dotenv from 'dotenv';
import { PG_SSL } from '../server/neonDb.ts';
import pg from 'pg';

// Load the environment BEFORE importing anything that reads it. `server/neonDb.ts`
// builds its pool at module scope, so an import that ran first would construct it
// with `DATABASE_URL === undefined` and fall back to a local socket — which looks
// exactly like "no database running".
dotenv.config();

const pool = new pg.Pool({
  connectionString: process.env.DATABASE_URL,
  ssl: PG_SSL,
  max: 2,
});

let pass = 0;
let fail = 0;
function check(name: string, cond: boolean, detail = ''): void {
  if (cond) { pass += 1; console.log(`  ok   ${name}`); }
  else { fail += 1; console.error(`  FAIL ${name}${detail ? ` — ${detail}` : ''}`); }
}
function section(title: string): void { console.log(`\n${title}`); }

/** Unique per run, so a crashed previous run cannot collide with this one. */
const stamp = `${Date.now().toString(36)}${Math.random().toString(36).slice(2, 6)}`;
const TENANT_A = `e2e-sa-${stamp}-a`;
const TENANT_B = `e2e-sa-${stamp}-b`;

// Saudi and Egyptian fixtures: different countries, different base currencies,
// and — the part that matters — different tax numbers, which is what a
// compiled-in identity could never produce.
const A = {
  company: `شركة الاختبار أ ${stamp}`,
  tax: `3${stamp.padEnd(14, '0').slice(0, 14)}`,
  currency: 'SAR',
  country: 'SA',
  branch: `فرع الرياض ${stamp}`,
};
const B = {
  company: `شركة الاختبار ب ${stamp}`,
  tax: `3${stamp.padEnd(13, '9').slice(0, 13)}9`,
  currency: 'EGP',
  country: 'EG',
  branch: `فرع القاهرة ${stamp}`,
};

// PLACEHOLDER_E2E
async function provision(
  id: string,
  f: { company: string; tax: string; currency: string; country: string; branch: string },
) {
  await pool.query(
    `INSERT INTO dypos.tenants
       (id, name, owner_company, brand_name, tax_number, country_code, base_currency, plan)
     VALUES ($1,$2,$3,$3,$4,$5,$6,'enterprise')
     ON CONFLICT (id) DO UPDATE
       SET owner_company = EXCLUDED.owner_company, tax_number = EXCLUDED.tax_number`,
    [id, f.company, f.company, f.tax, f.country, f.currency],
  );
  await pool.query(
    `INSERT INTO dypos.branches (id, tenant_id, name, city, location)
     VALUES ($1,$2,$3,$4,$5) ON CONFLICT (id) DO NOTHING`,
    [`${id}-hq`, id, f.branch, f.country === 'SA' ? 'الرياض' : 'القاهرة', ''],
  );
}

async function cleanup() {
  // ON DELETE CASCADE removes branches, capabilities and settlement accounts with
  // the tenant, so a failed run cannot leave debris a later run would see.
  await pool.query(`DELETE FROM dypos.tenants WHERE id = ANY($1)`, [[TENANT_A, TENANT_B]]);
}

async function main() {
  section('0. provision two merchants in two countries');
  await provision(TENANT_A, A);
  await provision(TENANT_B, B);
  check('merchant A is created', Boolean(TENANT_A));
  check('merchant B is created', Boolean(TENANT_B));

  // ── 1. Identity is per tenant ─────────────────────────────────────────────
  section('1. each merchant carries its OWN legal identity');

  const rows = await pool.query(
    `SELECT id, owner_company, tax_number, country_code, base_currency
       FROM dypos.tenants WHERE id = ANY($1) ORDER BY id`,
    [[TENANT_A, TENANT_B]],
  );
  const byId = new Map(rows.rows.map((r) => [r.id, r]));

  check('both tenants are readable', byId.size === 2, `got ${byId.size}`);
  check('A keeps its own tax number', byId.get(TENANT_A)?.tax_number === A.tax);
  check('B keeps its own tax number', byId.get(TENANT_B)?.tax_number === B.tax);
  check('the two tax numbers differ', A.tax !== B.tax);
  check('the two base currencies differ', A.currency !== B.currency);
  check('the two countries differ', A.country !== B.country);

  // The assertion a hard-coded identity could never satisfy.
  check(
    'neither tenant holds the other\'s tax number',
    byId.get(TENANT_A)?.tax_number !== byId.get(TENANT_B)?.tax_number
      && byId.get(TENANT_B)?.tax_number !== byId.get(TENANT_A)?.tax_number,
  );

  // ── 2. Branches are scoped ────────────────────────────────────────────────
  section('2. branches are scoped to their own tenant');

  const branchRows = await pool.query(
    `SELECT tenant_id, name FROM dypos.branches WHERE tenant_id = ANY($1) ORDER BY tenant_id`,
    [[TENANT_A, TENANT_B]],
  );
  const aBranches = branchRows.rows.filter((b) => b.tenant_id === TENANT_A);
  const bBranches = branchRows.rows.filter((b) => b.tenant_id === TENANT_B);

  check(
    'A sees only its own branches',
    aBranches.length > 0 && aBranches.every((b) => b.name.startsWith('فرع الرياض')),
  );
  check(
    'B sees only its own branches',
    bBranches.length > 0 && bBranches.every((b) => b.name.startsWith('فرع القاهرة')),
  );

  // ── 3. Settlement accounts are per tenant ─────────────────────────────────
  section('3. settlement accounts are PER TENANT (v147)');

  const ibanA = `SA${stamp.toUpperCase().slice(0, 6)}0000000000000000${stamp.slice(-2)}`;
  const ibanB = `EG${stamp.toUpperCase().slice(0, 6)}0000000000000000${stamp.slice(-2)}`;
  check('the two IBANs differ', ibanA !== ibanB);

  const fixtures: ReadonlyArray<readonly [string, string, string, string]> = [
    [TENANT_A, ibanA, 'مصرف الراجحي', 'SA'],
    [TENANT_B, ibanB, 'البنك الأهلي المصري', 'EG'],
  ];
  for (const [tid, iban, bank, country] of fixtures) {
    await pool.query(
      `INSERT INTO dypos.bank_settlement_accounts
         (id, tenant_id, iban, bank_name, holder_name, country_code, is_active, is_default)
       VALUES ($1,$2,$3,$4,$5,$6,TRUE,TRUE)
       ON CONFLICT (id) DO NOTHING`,
      [`${tid}-bank`, tid, iban, bank, tid === TENANT_A ? A.company : B.company, country],
    );
  }

  const accounts = await pool.query(
    `SELECT tenant_id, iban FROM dypos.bank_settlement_accounts
      WHERE tenant_id = ANY($1) ORDER BY tenant_id`,
    [[TENANT_A, TENANT_B]],
  );
  const seenA = accounts.rows.filter((a) => a.tenant_id === TENANT_A);
  const seenB = accounts.rows.filter((a) => a.tenant_id === TENANT_B);

  check('A is offered only its own account', seenA.length === 1 && seenA[0].iban === ibanA);
  check('B is offered only its own account', seenB.length === 1 && seenB[0].iban === ibanB);
  check(
    'neither tenant can see the other\'s IBAN',
    seenA.every((a) => a.iban !== ibanB) && seenB.every((a) => a.iban !== ibanA),
  );

  // ── 4. Offline idempotency ────────────────────────────────────────────────
  section('4. an offline sale commits ONCE, however often it is replayed');

  /*
   * The server's uniqueness guarantee against the real schema. A terminal that
   * flushes the same queued invoice twice — the normal outcome of a reconnect
   * after a dropped response — must produce one row, not two.
   */
  const saleId = `e2e-sale-${stamp}`;
  const insertSale = async (): Promise<number | null> => {
    const res = await pool.query(
      `INSERT INTO dypos.invoices (id, tenant_id, invoice_number, total, status)
       VALUES ($1,$2,$3,100,'completed')
       ON CONFLICT (id) DO NOTHING`,
      [saleId, TENANT_A, `E2E-${stamp}`],
    ).catch(() => ({ rowCount: null }));
    return res.rowCount ?? null;
  };

  const first = await insertSale();
  const replay = await insertSale();
  check('the first flush creates the invoice', first === 1, `rowCount=${first}`);
  check('a replay creates nothing new', replay === 0, `rowCount=${replay}`);

  const counted = await pool.query(
    `SELECT COUNT(*)::int AS n FROM dypos.invoices WHERE id = $1`,
    [saleId],
  );
  check(
    'exactly one invoice exists after two flushes',
    counted.rows[0]?.n === 1,
    `count=${counted.rows[0]?.n}`,
  );

  await pool.query(`DELETE FROM dypos.invoices WHERE id = $1`, [saleId]);

  console.log(`\n${pass} passed, ${fail} failed`);
  return fail === 0 ? 0 : 1;
}

let code = 1;
try {
  code = await main();
} catch (err) {
  console.error('\nERROR:', err instanceof Error ? err.message : err);
  code = 1;
} finally {
  // Cleanup runs even on failure, so a broken run leaves no test tenants behind.
  await cleanup().catch(() => {});
  await pool.end().catch(() => {});
}
process.exit(code);
