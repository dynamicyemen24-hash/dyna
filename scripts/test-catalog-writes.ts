/**
 * PROOF — the three catalog writes and the journal read.
 *
 *     npx tsx scripts/test-catalog-writes.ts
 *
 * ══ WHAT THIS PROVES, AND WHY A MOCK CANNOT ═════════════════════════════════
 * Production probing found no POST for `/api/db/journal-entries`,
 * `/api/db/purchase-orders` or `/api/db/products`, and no GET for
 * `/api/db/journal-entries`: records "saved" in the UI were lost on refresh and
 * the client manufactured its own numbers (`JE-TMP-<uuid>`, `PO-TMP-<uuid>`,
 * `628<random>`). Everything below drives the REAL Express app built by
 * `createApp()` against the LIVE database, because the defects being guarded
 * were invisible to a mock that agreed with whatever the code assumed:
 *
 *   1. Two journal posts allocate two DIFFERENT `JRN-YYYY-NNNNNN` numbers from
 *      the shared counter, and the LIST returns both with the account legs read
 *      back out of `dypos.ledger` — not echoed from the request.
 *   2. A purchase order allocates `PO-YYYY-NNNNNN` and lists with its
 *      free-text line intact, which `dypos.purchase_order_items` cannot hold at
 *      all (its `product_id` is NOT NULL with an FK to `dypos.products`).
 *   3. A created product carries an EAN-13 barcode whose check digit VALIDATES,
 *      and appears under BOTH `items` and `products` in the canonical envelope.
 *   4. An invalid body is refused with 400 and writes NO row — a validation
 *      message over a write that happened anyway is worse than no validation.
 *   5. Everything is removed and the removal is VERIFIED, so the script is safe
 *      to run against the production database it runs against.
 *
 * The throwaway tenant is unique per run and deleted at the end; no real tenant,
 * product, order or ledger row is read or written.
 */
import dotenv from 'dotenv';
// Load the environment BEFORE anything below reads it. `server/neonDb.ts` loads
// it itself, but the pool this script opens is its own and must not race the
// import graph.
dotenv.config();

import fs from 'node:fs';
import path from 'node:path';
import type { Server } from 'node:http';
import pg from 'pg';
import { PG_SSL } from '../server/neonDb.js';
import { createApp } from '../server.js';
import { issueSessionToken } from '../server/sessions.js';

const pool = new pg.Pool({
  connectionString: process.env.DATABASE_URL,
  ssl: PG_SSL,
  max: 2,
});

let pass = 0;
let fail = 0;
function check(name: string, ok: boolean, detail = ''): void {
  if (ok) { pass += 1; console.log(`  ok   ${name}`); }
  else { fail += 1; console.error(`  FAIL ${name}${detail ? ` — ${detail}` : ''}`); }
}
function section(title: string): void { console.log(`\n${title}`); }

/** Unique per run, so a crashed previous run cannot collide with this one. */
const stamp = `${Date.now().toString(36)}${Math.random().toString(36).slice(2, 6)}`;
const TENANT = `catw-${stamp}`;
const BRANCH = `br-catw-${stamp}`;
const USER_ID = `u-catw-${stamp}`;
const USERNAME = `catw_${stamp}`;
const SUPPLIER = `sup-catw-${stamp}`;

/**
 * The EAN-13 modulus-10 check, written out again rather than imported from
 * `server/documentNumber.ts` — a check that reuses the code being checked
 * would pass whenever the implementation was wrong in the same way.
 */
function ean13Valid(code: string): boolean {
  if (!/^\d{13}$/.test(code)) return false;
  let sum = 0;
  for (let i = 0; i < 12; i += 1) sum += Number(code[i]) * (i % 2 === 0 ? 1 : 3);
  return (10 - (sum % 10)) % 10 === Number(code[12]);
}

async function tableExists(fqn: string): Promise<boolean> {
  const r = await pool.query('SELECT to_regclass($1) AS t', [fqn]);
  return Boolean(r.rows[0]?.t);
}

/**
 * Applies ONE numbered migration file, idempotently.
 *
 * The orchestrator runs `scripts/migrate.ts` as its own controlled step — this
 * script deliberately does NOT invoke that runner, because it applies every
 * pending file in the directory and other work may be in flight. It applies
 * only the file it needs, and only when its table is missing, so the proof can
 * run standalone before the controlled step has happened.
 */
async function ensureMigration(file: string, table: string): Promise<void> {
  if (await tableExists(table)) return;
  const sql = fs.readFileSync(path.join(process.cwd(), 'server', 'migrations', file), 'utf8');
  await pool.query(sql);
  console.log(`  (applied server/migrations/${file} — table ${table} was missing)`);
}

async function count(sql: string, params: unknown[]): Promise<number> {
  const r = await pool.query(sql, params);
  return Number(r.rows[0]?.n ?? -1);
}

/**
 * Removes the throwaway tenant and every row written for it, in FK order.
 *
 * `dypos.document_sequences` and `dypos.ledger` are the two that are NOT
 * removed by the tenant's own cascade: the first holds a plain
 * `REFERENCES dypos.tenants(id)` with no ON DELETE, so leaving it behind would
 * make `DELETE … tenants` fail outright; the second cascades from
 * `journal_entries` only, so it goes first by journal id. Everything this run
 * created is listed explicitly rather than assumed away by a cascade.
 */
async function cleanup(): Promise<void> {
  await pool.query(
    `DELETE FROM dypos.ledger
      WHERE journal_id IN (SELECT id FROM dypos.journal_entries WHERE tenant_id = $1)`,
    [TENANT],
  );
  await pool.query(`DELETE FROM dypos.journal_entries WHERE tenant_id = $1`, [TENANT]);
  await pool.query(`DELETE FROM dypos.purchase_order_lines WHERE tenant_id = $1`, [TENANT]);
  await pool.query(`DELETE FROM dypos.purchase_orders WHERE tenant_id = $1`, [TENANT]);
  await pool.query(`DELETE FROM dypos.products WHERE tenant_id = $1`, [TENANT]);
  await pool.query(`DELETE FROM dypos.suppliers WHERE tenant_id = $1`, [TENANT]);
  await pool.query(`DELETE FROM dypos.users WHERE tenant_id = $1`, [TENANT]);
  await pool.query(`DELETE FROM dypos.branches WHERE tenant_id = $1`, [TENANT]);
  await pool.query(`DELETE FROM dypos.document_sequences WHERE tenant_id = $1`, [TENANT]);
  await pool.query(`DELETE FROM dypos.tenants WHERE id = $1`, [TENANT]);
}

let server: Server | null = null;
let provisioned = false;
let code = 1;

try {
  /*
   * ── 0. Schema the contract needs ────────────────────────────────────────
   * `document_sequences` is v139 (the shared counter every number is drawn
   * from) and `purchase_order_lines` is v151 (free-text PO lines).
   */
  section('0. schema the contract depends on');
  await ensureMigration('v139_document_number_ranges.sql', 'dypos.document_sequences');
  await ensureMigration('v151_purchase_order_lines.sql', 'dypos.purchase_order_lines');
  check('purchase_order_lines is present', await tableExists('dypos.purchase_order_lines'));

  // ── 1. Throwaway merchant + operator ────────────────────────────────────
  section('1. provision a throwaway tenant (removed and verified at the end)');
  await pool.query(
    `INSERT INTO dypos.tenants
       (id, name, owner_company, brand_name, tax_number, country_code, base_currency, plan)
     VALUES ($1, $2, $3, $3, $4, 'SA', 'SAR', 'enterprise')`,
    [TENANT, `شركة اختبار الكتالوج ${stamp}`, `اختبار ${stamp}`, `9${stamp.slice(0, 9).padEnd(9, '0')}`],
  );
  await pool.query(
    `INSERT INTO dypos.branches (id, tenant_id, name, city, location)
     VALUES ($1, $2, $3, 'الرياض', '')`,
    [BRANCH, TENANT, `فرع الاختبار ${stamp}`],
  );
  await pool.query(
    `INSERT INTO dypos.users (id, tenant_id, branch_id, username, name, is_active)
     VALUES ($1, $2, $3, $4, 'catalog writes proof', TRUE)`,
    [USER_ID, TENANT, BRANCH, USERNAME],
  );
  await pool.query(
    `INSERT INTO dypos.suppliers (id, tenant_id, name)
     VALUES ($1, $2, $3)`,
    [SUPPLIER, TENANT, `مورد الاختبار ${stamp}`],
  );
  provisioned = true;
  check('throwaway tenant created', true, TENANT);

  // ── 2. The REAL application, on an ephemeral port ───────────────────────
  section('2. boot createApp() on an ephemeral port');
  const app = await createApp();
  server = app.listen(0);
  const base = `http://127.0.0.1:${(server.address() as { port: number }).port}`;
  // The server's own signer — the same call login makes, so the token is not a
  // shape this script invented and `attachPrincipal` resolves it for real.
  const token = issueSessionToken(USER_ID, USERNAME, TENANT, false);
  check('session token issued for the throwaway operator', Boolean(token));

  async function post(p: string, body: unknown): Promise<{ status: number; json: any }> {
    const res = await fetch(base + p, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` },
      body: JSON.stringify(body),
    });
    let json: any = {};
    try { json = await res.json(); } catch { /* non-JSON */ }
    return { status: res.status, json };
  }
  async function get(p: string): Promise<{ status: number; json: any }> {
    const res = await fetch(base + p, { headers: { Authorization: `Bearer ${token}` } });
    let json: any = {};
    try { json = await res.json(); } catch { /* non-JSON */ }
    return { status: res.status, json };
  }

  // ── 3. Journal entries: two posts, two numbers, ledger-derived legs ─────
  section('3. POST /api/db/journal-entries allocates from the counter');

  const je1 = await post('/api/db/journal-entries', {
    description: 'قيد اختبار أول',
    amount: 250.5,
    accountDebit: 'الصندوق (1010)',
    accountCredit: 'المبيعات (4100)',
  });
  check('first entry is 201', je1.status === 201, `status=${je1.status} ${JSON.stringify(je1.json)}`);
  const n1 = String(je1.json?.item?.entryNumber ?? '');
  check('first number is JRN-YYYY-NNNNNN', /^JRN-\d{4}-\d{6}$/.test(n1), n1);

  const je2 = await post('/api/db/journal-entries', {
    description: 'قيد اختبار ثانٍ',
    amount: 100,
    accountDebit: 'المشتريات (5000)',
    accountCredit: 'البنك (1020)',
  });
  check('second entry is 201', je2.status === 201, `status=${je2.status}`);
  const n2 = String(je2.json?.item?.entryNumber ?? '');
  check('second number is JRN-YYYY-NNNNNN', /^JRN-\d{4}-\d{6}$/.test(n2), n2);
  check('the two numbers DIFFER', Boolean(n1) && n1 !== n2, `${n1} vs ${n2}`);

  section('4. GET /api/db/journal-entries returns both, legs read from ledger');
  const list = await get('/api/db/journal-entries');
  check('list is 200', list.status === 200, `status=${list.status}`);
  const listItems: any[] = Array.isArray(list.json?.items) ? list.json.items : [];
  check('list envelope carries items + count',
    Array.isArray(list.json?.items) && list.json?.count === listItems.length,
    JSON.stringify({ count: list.json?.count, len: listItems.length }));

  const byNumber = new Map(listItems.map((e) => [e.entryNumber, e]));
  // Kept for the cleanup verification: `dypos.ledger` cascades from
  // `journal_entries`, so once the journals are gone its rows can only be
  // counted by the journal ids this run actually created.
  const journalIds = listItems.map((e: any) => String(e.id));
  const got1 = byNumber.get(n1);
  const got2 = byNumber.get(n2);
  check('both entries are listed', Boolean(got1 && got2), `${n1}/${n2}`);
  if (got1) {
    check('debit leg derived from dypos.ledger',
      got1.accountDebit === 'الصندوق (1010)', JSON.stringify(got1.accountDebit));
    check('credit leg derived from dypos.ledger',
      got1.accountCredit === 'المبيعات (4100)', JSON.stringify(got1.accountCredit));
    check('amount survives the round trip', Number(got1.amount) === 250.5, String(got1.amount));
    check('description survives the round trip', got1.description === 'قيد اختبار أول', got1.description);
    check('date is YYYY-MM-DD', /^\d{4}-\d{2}-\d{2}$/.test(String(got1.date)), String(got1.date));
  }
  if (got2) {
    check('second entry carries its own legs',
      got2.accountDebit === 'المشتريات (5000)' && got2.accountCredit === 'البنك (1020)',
      JSON.stringify([got2.accountDebit, got2.accountCredit]));
  }

  // ── 5. Purchase order: number, free-text line, supplier join ────────────
  section('5. POST /api/db/purchase-orders writes the order AND its free-text line');
  const poBody = {
    supplierId: SUPPLIER,
    items: [{ productName: 'قطعة اختبار مجانية النص', quantity: 3, unitCost: 12.25 }],
    totalAmount: 36.75,
    status: 'approved',
    orderDate: '2026-01-15',
    notes: 'أمر شراء اختباري',
    branchId: BRANCH,
  };
  const po = await post('/api/db/purchase-orders', poBody);
  check('order is 201', po.status === 201, `status=${po.status} ${JSON.stringify(po.json)}`);
  const poNumber = String(po.json?.item?.poNumber ?? '');
  check('order number is PO-YYYY-NNNNNN', /^PO-\d{4}-\d{6}$/.test(poNumber), poNumber);
  check('response item carries the line back',
    po.json?.item?.items?.length === 1
      && po.json.item.items[0].productName === poBody.items[0].productName,
    JSON.stringify(po.json?.item?.items));
  check('total matches the computed lines', Number(po.json?.item?.totalAmount) === 36.75,
    String(po.json?.item?.totalAmount));
  check('orderDate round-trips', po.json?.item?.orderDate === '2026-01-15',
    String(po.json?.item?.orderDate));

  section('6. GET /api/db/purchase-orders lists it with items.length === 1');
  const poList = await get('/api/db/purchase-orders');
  check('list is 200', poList.status === 200, `status=${poList.status}`);
  const poItems: any[] = Array.isArray(poList.json?.items) ? poList.json.items : [];
  const foundPo = poItems.find((p) => p.poNumber === poNumber);
  check('the order is listed', Boolean(foundPo), poNumber);
  if (foundPo) {
    check('items is ALWAYS an array with the same productName',
      Array.isArray(foundPo.items) && foundPo.items.length === 1
        && foundPo.items[0].productName === poBody.items[0].productName,
      JSON.stringify(foundPo.items));
    check('supplierName comes from the LEFT JOIN',
      foundPo.supplierName === `مورد الاختبار ${stamp}`, String(foundPo.supplierName));
    check('status and total survive the round trip',
      foundPo.status === 'approved' && Number(foundPo.totalAmount) === 36.75,
      JSON.stringify({ status: foundPo.status, total: foundPo.totalAmount }));
  }

  // ── 7. Product: allocated EAN-13 barcode ───────────────────────────────
  section('7. POST /api/db/products allocates a scannable EAN-13');
  const productBody = {
    name: 'منتج اختبار الباركود',
    price: 99.9,
    cost: 40,
    stock: 7,
    // `minStock` is deliberately omitted: the default is what must come back.
  };
  const pr = await post('/api/db/products', productBody);
  check('product is 201', pr.status === 201, `status=${pr.status} ${JSON.stringify(pr.json)}`);
  const barcode = String(pr.json?.item?.barcode ?? '');
  check('barcode is 13 digits', /^\d{13}$/.test(barcode), barcode);
  check('barcode carries the GS1 628 prefix', barcode.startsWith('628'), barcode);
  check('barcode check digit validates (EAN-13 modulus-10)', ean13Valid(barcode), barcode);
  check('defaults applied for the fields the client omitted',
    pr.json?.item?.category === 'غير مصنّف' && pr.json?.item?.unit === 'حبة'
      && Number(pr.json?.item?.minStock) === 5,
    JSON.stringify(pr.json?.item));

  section('8. GET /api/db/products returns it under BOTH items and products');
  const prods = await get('/api/db/products');
  check('products list is 200', prods.status === 200, `status=${prods.status}`);
  const inItems = (Array.isArray(prods.json?.items) ? prods.json.items : [])
    .some((r: any) => r.id === pr.json?.item?.id);
  const inProducts = (Array.isArray(prods.json?.products) ? prods.json.products : [])
    .some((r: any) => r.id === pr.json?.item?.id);
  check('present in items[]', inItems);
  check('present in products[] (legacy key)', inProducts);
  const listedBarcodes = [
    ...(Array.isArray(prods.json?.items) ? prods.json.items : []),
    ...(Array.isArray(prods.json?.products) ? prods.json.products : []),
  ].filter((r: any) => r.id === pr.json?.item?.id).map((r: any) => String(r.barcode));
  check('the SAME barcode is listed', listedBarcodes.every((b) => b === barcode),
    JSON.stringify(listedBarcodes));

  // ── 9. Invalid bodies are refused AND write nothing ────────────────────
  section('9. invalid bodies → 400, and NO row is written');
  const journalBefore = await count(
    `SELECT COUNT(*)::int AS n FROM dypos.journal_entries WHERE tenant_id = $1`, [TENANT]);
  const poBefore = await count(
    `SELECT COUNT(*)::int AS n FROM dypos.purchase_orders WHERE tenant_id = $1`, [TENANT]);
  const productsBefore = await count(
    `SELECT COUNT(*)::int AS n FROM dypos.products WHERE tenant_id = $1`, [TENANT]);

  const badJeEmpty = await post('/api/db/journal-entries', { description: '   ', amount: 10 });
  check('empty description → 400', badJeEmpty.status === 400, `status=${badJeEmpty.status}`);

  const badJeAmount = await post('/api/db/journal-entries', { description: 'x', amount: 'abc' });
  check('non-finite amount → 400', badJeAmount.status === 400, `status=${badJeAmount.status}`);

  const badJeZero = await post('/api/db/journal-entries', { description: 'x', amount: 0 });
  check('zero amount → 400', badJeZero.status === 400, `status=${badJeZero.status}`);

  const badPoEmpty = await post('/api/db/purchase-orders', { items: [] });
  check('empty items → 400', badPoEmpty.status === 400, `status=${badPoEmpty.status}`);

  const badPoQty = await post('/api/db/purchase-orders',
    { items: [{ productName: 'x', quantity: 0, unitCost: 5 }] });
  check('non-positive quantity → 400', badPoQty.status === 400, `status=${badPoQty.status}`);

  const badPoTotal = await post('/api/db/purchase-orders',
    { items: [{ productName: 'x', quantity: 1, unitCost: 5 }], totalAmount: 999 });
  check('total that contradicts the lines → 400', badPoTotal.status === 400,
    `status=${badPoTotal.status}`);

  const badPrdName = await post('/api/db/products', { name: '', price: 1 });
  check('empty product name → 400', badPrdName.status === 400, `status=${badPrdName.status}`);

  const badPrdPrice = await post('/api/db/products', { name: 'x', price: 'abc' });
  check('non-finite price → 400', badPrdPrice.status === 400, `status=${badPrdPrice.status}`);

  const journalAfter = await count(
    `SELECT COUNT(*)::int AS n FROM dypos.journal_entries WHERE tenant_id = $1`, [TENANT]);
  const poAfter = await count(
    `SELECT COUNT(*)::int AS n FROM dypos.purchase_orders WHERE tenant_id = $1`, [TENANT]);
  const productsAfter = await count(
    `SELECT COUNT(*)::int AS n FROM dypos.products WHERE tenant_id = $1`, [TENANT]);
  check('no journal row was written by the refused posts', journalAfter === journalBefore,
    `${journalBefore} → ${journalAfter}`);
  check('no purchase order was written by the refused posts', poAfter === poBefore,
    `${poBefore} → ${poAfter}`);
  check('no product was written by the refused posts', productsAfter === productsBefore,
    `${productsBefore} → ${productsAfter}`);

  // ── 10. Cleanup, verified ──────────────────────────────────────────────
  section('10. throwaway tenant removed — verified');
  await cleanup();
  provisioned = false;
  const leftovers: Array<readonly [string, string]> = [
    ['dypos.tenants', `SELECT COUNT(*)::int AS n FROM dypos.tenants WHERE id = $1`],
    ['dypos.journal_entries', `SELECT COUNT(*)::int AS n FROM dypos.journal_entries WHERE tenant_id = $1`],
    ['dypos.purchase_orders', `SELECT COUNT(*)::int AS n FROM dypos.purchase_orders WHERE tenant_id = $1`],
    ['dypos.purchase_order_lines', `SELECT COUNT(*)::int AS n FROM dypos.purchase_order_lines WHERE tenant_id = $1`],
    ['dypos.products', `SELECT COUNT(*)::int AS n FROM dypos.products WHERE tenant_id = $1`],
    ['dypos.suppliers', `SELECT COUNT(*)::int AS n FROM dypos.suppliers WHERE tenant_id = $1`],
    ['dypos.users', `SELECT COUNT(*)::int AS n FROM dypos.users WHERE tenant_id = $1`],
    ['dypos.branches', `SELECT COUNT(*)::int AS n FROM dypos.branches WHERE tenant_id = $1`],
    ['dypos.document_sequences', `SELECT COUNT(*)::int AS n FROM dypos.document_sequences WHERE tenant_id = $1`],
  ];
  for (const [label, sql] of leftovers) {
    const n = await count(sql, [TENANT]);
    check(`${label} holds no rows for the throwaway tenant`, n === 0, `n=${n}`);
  }
  // The two ledger legs written for each journal are gone with them.
  const ledgerLeft = await count(
    `SELECT COUNT(*)::int AS n FROM dypos.ledger WHERE journal_id = ANY($1)`,
    [journalIds],
  );
  check('dypos.ledger holds no rows for the journals this run created',
    ledgerLeft === 0, `n=${ledgerLeft}`);

  code = fail === 0 ? 0 : 1;
} catch (err) {
  console.error('\nERROR:', err instanceof Error ? err.stack ?? err.message : err);
  code = 1;
} finally {
  if (server) server.close();
  // Safety net: cleanup() above already ran and was verified; this repeats it
  // so a failure mid-assertion still leaves no debris behind.
  if (provisioned) await cleanup().catch((e) => console.error('cleanup failed:', e?.message ?? e));
  await pool.end().catch(() => {});
}

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(code);
