/**
 * Server-side price and tax authority — proof the till cannot set its own price.
 *
 * Run:  npx tsx scripts/test-price-authority.ts
 *
 * ══ THE DEFECT THIS GUARDS ═════════════════════════════════════════════════
 * `POST /api/db/invoices` read `subtotal`, `tax`, `total` and each line's
 * `unitPrice` out of the request body and wrote them into the invoice.
 *
 * That made the BROWSER the authority on price. `{ tax: 0, total: 0 }` for a
 * full basket produced an invoice the ledger agreed with, a receipt matching the
 * invoice, and stock that left the building for nothing. Nothing downstream
 * could detect it: every record was internally consistent, which is exactly why
 * it was dangerous.
 *
 * The server now re-reads `unit_price` and `tax_rate` from the product row it has
 * already locked with `FOR UPDATE`, and derives every amount itself.
 *
 * ══ WHY THE CLIENT TOTAL IS STILL CHECKED ══════════════════════════════════
 * As a REFUSAL, not as a value. If the till's total disagrees with what the
 * server can derive, one of them is wrong and nothing is recorded — a receipt
 * that cannot be reconciled against the catalogue is worse than a refused sale.
 *
 * This boots the REAL application via `createApp()`. Testing a copy of the route
 * would prove nothing about the route that runs.
 */
import dotenv from 'dotenv';
import { PG_SSL } from '../server/neonDb.ts';
import pg from 'pg';
import { createApp } from '../server.ts';
import { issueSessionToken } from '../server/sessions.ts';
import { hashPassword, ALGO } from '../server/passwords.ts';
import { makeId } from '../server/apiHelpers.ts';

dotenv.config();

const TENANT = 'price-auth-tenant';

let pass = 0;
let fail = 0;
function check(name: string, ok: boolean, detail = ''): void {
  if (ok) { pass += 1; console.log(`  ok   ${name}`); }
  else { fail += 1; console.error(`  FAIL ${name}${detail ? ` — ${detail}` : ''}`); }
}

const pool = new pg.Pool({
  connectionString: process.env.DATABASE_URL,
  ssl: PG_SSL,
  max: 4,
  idleTimeoutMillis: 10_000,
});

async function main() {
  const productId = makeId('p-price');
  const freeProductId = makeId('p-free');
  const userName = `price_probe_${Date.now().toString(36)}`;
  const PW = 'Price-Authority-Probe-9!';

  const price = 200;
  const taxRate = 15;
  const qty = 2;
  const expectedNet = price * qty;
  const expectedTax = (expectedNet * taxRate) / 100;
  const expectedTotal = expectedNet + expectedTax;

  console.log('\n0. fixtures — one product at 200.00, tax 15%, stock 100');
  const hash = await hashPassword(PW);
  await pool.query(
    `INSERT INTO dypos.tenants (id, name) VALUES ($1,$2) ON CONFLICT (id) DO NOTHING`,
    [TENANT, 'Price Authority Tenant'],
  );
  await pool.query(`DELETE FROM dypos.users WHERE tenant_id = $1`, [TENANT]);
  await pool.query(`DELETE FROM dypos.products WHERE tenant_id = $1`, [TENANT]);
  await pool.query(
    `INSERT INTO dypos.users (id, tenant_id, username, name, role, password_hash,
        password_salt, password_iterations, password_algo, is_active)
     VALUES ($1,$2,$3,'Probe','admin',$4,$5,$6,$7,TRUE)`,
    [makeId('u'), TENANT, userName, hash.hash, hash.salt, hash.iterations, ALGO],
  );
  await pool.query(
    // `category` is NOT NULL in the live schema (added by a later migration than
    // the CREATE TABLE this file was written against), so it is supplied here.
    `INSERT INTO dypos.products (id, tenant_id, name, category, sku, unit_price, tax_rate, stock, is_active)
     VALUES ($1,$2,'Probe Product','general','PR-1',$3,$4,100,TRUE),
            ($5,$2,'Zero Priced','general','NP-1',0,15,10,TRUE)`,
    [productId, TENANT, price, taxRate, freeProductId],
  );
  console.log(`  ok   product ${productId} @ ${price}.00`);

  // The REAL app, not a reconstruction of its routes.
  process.env.NODE_ENV = 'production';
  const app = await createApp();
  const server = app.listen(0);
  const port = (server.address() as { port: number }).port;

  const token = issueSessionToken(makeId('u'), userName, TENANT);
  const call = async (body: unknown) => {
    const res = await fetch(`http://127.0.0.1:${port}/api/db/invoices`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', authorization: `Bearer ${token}` },
      body: JSON.stringify(body),
    });
    let json: any = {};
    try { json = await res.json(); } catch { /* non-JSON is still a response */ }
    return { status: res.status, json };
  };

  try {
    console.log('\n1. a client claiming a zero total is refused');
    const zero = await call({
      items: [{ productId, quantity: qty, unitPrice: 0 }],
      subtotal: 0, tax: 0, total: 0,
    });
    check('the zero-total sale is refused', zero.status === 409, `status ${zero.status}`);

    const rows = await pool.query(
      `SELECT count(*)::int n FROM dypos.invoices WHERE tenant_id = $1`, [TENANT],
    );
    check('no invoice row was written', rows.rows[0].n === 0, `${rows.rows[0].n} rows`);

    console.log('\n2. a client under-stating the tax is refused');
    const under = await call({
      items: [{ productId, quantity: qty, unitPrice: price }],
      subtotal: expectedNet, tax: 0, total: expectedNet,
    });
    check('the under-stated total is refused', under.status === 409, `status ${under.status}`);

    console.log('\n3. the honest sale is accepted and priced by the SERVER');
    const good = await call({
      items: [{ productId, quantity: qty, unitPrice: price }],
      subtotal: expectedNet, tax: expectedTax, total: expectedTotal,
    });
    check('the honest sale succeeds', good.status === 200 || good.status === 201, `status ${good.status}`);

    const inv = good.json?.item;
    if (!inv) {
      check('an invoice came back', false, JSON.stringify(good.json).slice(0, 140));
    } else {
      check('the stored subtotal is the catalogue price',
        Number(inv.subtotal) === expectedNet, `${inv.subtotal} vs ${expectedNet}`);
      check('the stored tax is computed from tax_rate, not sent by the client',
        Math.abs(Number(inv.tax) - expectedTax) < 0.01, `${inv.tax} vs ${expectedTax}`);
      check('the stored total matches',
        Math.abs(Number(inv.total) - expectedTotal) < 0.01, `${inv.total} vs ${expectedTotal}`);
      check('the invoice number was allocated server-side',
        typeof inv.invoice_number === 'string' && /^INV-\d{4}-\d{6}$/.test(inv.invoice_number),
        String(inv.invoice_number));

      const line = await pool.query(
        `SELECT unit_price, tax_amount FROM dypos.invoice_items WHERE invoice_id = $1 LIMIT 1`,
        [inv.id],
      );
      check('the line carries the catalogue price',
        Number(line.rows[0]?.unit_price) === price, String(line.rows[0]?.unit_price));
      check('the line tax is the computed amount',
        Math.abs(Number(line.rows[0]?.tax_amount) - expectedTax) < 0.01,
        String(line.rows[0]?.tax_amount));

      const mov = await pool.query(
        `SELECT quantity FROM dypos.stock_movements
          WHERE product_id = $1 AND reference_id = $2`,
        [productId, inv.id],
      );
      check('a stock movement was recorded', Number(mov.rows[0]?.quantity) === qty,
        String(mov.rows[0]?.quantity));
    }

    console.log('\n4. overselling is refused');
    const stock = await pool.query(`SELECT stock FROM dypos.products WHERE id = $1`, [productId]);
    const available = Number(stock.rows[0].stock);
    const tooMany = available + 1;
    const over = await call({
      items: [{ productId, quantity: tooMany, unitPrice: price }],
      subtotal: price * tooMany, tax: 0, total: price * tooMany,
    });
    check('selling beyond stock is refused', over.status === 409, `status ${over.status}`);

    console.log('\n5. a zero-priced product is refused, not sold free');
    const free = await call({
      items: [{ productId: freeProductId, quantity: 1, unitPrice: 0 }],
      subtotal: 0, tax: 0, total: 0,
    });
    check('the zero-priced sale is refused', free.status === 409, `status ${free.status}`);

    console.log('\n6. another tenant\'s product cannot be sold');
    const otherTenant = 'price-auth-other';
    await pool.query(
      `INSERT INTO dypos.tenants (id, name) VALUES ($1,$2) ON CONFLICT (id) DO NOTHING`,
      [otherTenant, 'Other'],
    );
    const foreignId = makeId('p-foreign');
    await pool.query(
      `INSERT INTO dypos.products (id, tenant_id, name, category, sku, unit_price, tax_rate, stock, is_active)
       VALUES ($1,$2,'Foreign','general','F-1',999,15,100,TRUE)`,
      [foreignId, otherTenant],
    );
    const cross = await call({
      items: [{ productId: foreignId, quantity: 1, unitPrice: 999 }],
      subtotal: 999, tax: 149.85, total: 1148.85,
    });
    check('selling another tenant\'s product is refused', cross.status >= 400, `status ${cross.status}`);
    await pool.query(`DELETE FROM dypos.products WHERE id = $1`, [foreignId]);
  } finally {
    console.log('\n7. cleanup');
    await pool.query(`DELETE FROM dypos.invoices WHERE tenant_id = $1`, [TENANT]);
    await pool.query(`DELETE FROM dypos.stock_movements WHERE tenant_id = $1`, [TENANT]);
    await pool.query(`DELETE FROM dypos.products WHERE tenant_id = $1`, [TENANT]);
    await pool.query(`DELETE FROM dypos.users WHERE tenant_id = $1`, [TENANT]);
    await pool.end();
    await new Promise<void>((r) => server.close(() => r()));
    console.log('  ok   fixtures removed');
  }

  console.log(`\n${pass} passed, ${fail} failed`);
  // Drain close callbacks before exiting: exiting inside the close window on
  // Windows trips libuv's UV_HANDLE_CLOSURING assertion — a non-zero abort
  // even on a full pass, which would break the `&&` chain in `ci:db`.
  await new Promise((r) => setTimeout(r, 50));
  process.exit(fail ? 1 : 0);
}

main().catch((e) => {
  console.error('\nthe test itself failed:', e);
  process.exit(1);
});