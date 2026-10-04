/**
 * Post-seed verification: row counts, ledger integrity and sales series.
 * Run with: npx tsx scripts/verify-seed.ts
 */
import dotenv from 'dotenv';
import fs from 'fs';
import path from 'path';
import pg from 'pg';

dotenv.config();

const LOG = path.resolve('verify.log');
const lines: string[] = [];
const out = (s: string) => {
  lines.push(s);
  fs.writeFileSync(LOG, lines.join('\n'));
};

const T = 'royal-global-hq';
const ok = (label: string, pass: boolean, info = '') =>
  out(`  ${pass ? 'PASS' : 'FAIL'}  ${label}${info ? ' — ' + info : ''}`);

const pool = new pg.Pool({
  connectionString: process.env.DATABASE_URL,
  ssl: { rejectUnauthorized: false },
  max: 1,
  connectionTimeoutMillis: 20000,
});

try {
  out('=== ROW COUNTS ===');
  const SCOPED = new Set([
    'branches', 'users', 'warehouses', 'employees', 'customers', 'suppliers',
    'chart_of_accounts', 'journal_entries', 'accounts_receivable',
    'accounts_payable', 'categories', 'invoices', 'pos_sessions', 'shifts',
    'purchase_orders', 'stock_movements', 'products', 'services',
    'appointments', 'delivery_zones',
  ]);
  for (const t of [...SCOPED, 'currencies', 'journal_lines']) {
    const r = SCOPED.has(t)
      ? await pool.query(
          `SELECT count(*)::int AS n FROM dypos."${t}" WHERE tenant_id = $1`, [T])
      : await pool.query(`SELECT count(*)::int AS n FROM dypos."${t}"`);
    out(`  ${String(r.rows[0].n).padStart(6)}  ${t}`);
  }

  out('\n=== LEDGER INTEGRITY ===');
  const bad = await pool.query(
    `SELECT je.entry_number,
            COALESCE(SUM(jl.debit),0)  AS d,
            COALESCE(SUM(jl.credit),0) AS cr
     FROM dypos.journal_entries je
     JOIN dypos.journal_lines jl ON jl.journal_entry_id = je.id
     WHERE je.tenant_id = $1
     GROUP BY je.id, je.entry_number
     HAVING COALESCE(SUM(jl.debit),0) <> COALESCE(SUM(jl.credit),0)`,
    [T],
  );
  ok('every journal entry balances (debit = credit)',
    bad.rows.length === 0,
    bad.rows.length ? JSON.stringify(bad.rows) : 'all entries balanced');

  const grand = await pool.query(
    `SELECT COALESCE(SUM(jl.debit),0) AS d, COALESCE(SUM(jl.credit),0) AS cr
     FROM dypos.journal_lines jl
     JOIN dypos.journal_entries je ON je.id = jl.journal_entry_id
     WHERE je.tenant_id = $1`,
    [T],
  );
  out(`  grand totals   debit=${Number(grand.rows[0].d).toFixed(2)}  credit=${Number(grand.rows[0].cr).toFixed(2)}`);

  out('\n=== TRIAL BALANCE (top accounts) ===');
  const tb = await pool.query(
    `SELECT co.code, co.name,
            COALESCE(SUM(jl.debit),0)  AS dr,
            COALESCE(SUM(jl.credit),0) AS cr
     FROM dypos.journal_lines jl
     JOIN dypos.journal_entries je ON je.id = jl.journal_entry_id
     JOIN dypos.chart_of_accounts co ON co.id = jl.account_id
     WHERE je.tenant_id = $1
     GROUP BY co.code, co.name ORDER BY co.code`,
    [T],
  );
  for (const r of tb.rows) {
    out(`  ${r.code}  ${String(r.name).padEnd(32)} dr=${Number(r.dr).toFixed(2).padStart(11)}  cr=${Number(r.cr).toFixed(2).padStart(11)}`);
  }

  out('\n=== SALES SERIES ===');
  const s = await pool.query(
    `SELECT count(*)::int AS n,
            COALESCE(SUM(total),0)    AS revenue,
            COALESCE(SUM(subtotal),0) AS net,
            COALESCE(SUM(tax),0)      AS vat,
            COALESCE(SUM(discount),0) AS disc
     FROM dypos.invoices WHERE tenant_id = $1`,
    [T],
  );
  const s0 = s.rows[0];
  out(`  invoices   : ${s0.n}`);
  out(`  net sales  : ${Number(s0.net).toFixed(2)} SAR`);
  out(`  VAT 15%    : ${Number(s0.vat).toFixed(2)} SAR`);
  out(`  discounts  : ${Number(s0.disc).toFixed(2)} SAR`);
  out(`  gross      : ${Number(s0.revenue).toFixed(2)} SAR`);
  ok('VAT is 15% of net sales',
    Math.abs(Number(s0.vat) - Number(s0.net) * 0.15) < 1.0,
    `${Number(s0.vat).toFixed(2)} vs ${(Number(s0.net) * 0.15).toFixed(2)}`);

  out('\n=== INVENTORY ===');
  const inv = await pool.query(
    `SELECT count(*)::int AS n,
            COALESCE(SUM(stock * cost),0)      AS at_cost,
            COALESCE(SUM(stock * unit_price),0) AS at_retail
     FROM dypos.products WHERE tenant_id = $1`,
    [T],
  );
  const i0 = inv.rows[0];
  out(`  products        : ${i0.n}`);
  out(`  value at cost   : ${Number(i0.at_cost).toFixed(2)} SAR`);
  out(`  value at retail : ${Number(i0.at_retail).toFixed(2)} SAR`);
  ok('original catalogue preserved', i0.n >= 199, `${i0.n} products`);

  out('\n=== TOP CUSTOMERS ===');
  const top = await pool.query(
    `SELECT customer_name, count(*)::int AS n, SUM(total)::numeric AS amt
     FROM dypos.invoices WHERE tenant_id = $1
     GROUP BY customer_name ORDER BY amt DESC LIMIT 5`,
    [T],
  );
  for (const r of top.rows) {
    out(`  ${String(r.n).padStart(3)} inv  ${Number(r.amt).toFixed(2).padStart(10)} SAR  ${r.customer_name}`);
  }
} catch (e: any) {
  out('FAIL: ' + e.message);
} finally {
  await pool.end();
}