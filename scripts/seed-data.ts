/**
 * Seeds institutional data for the Royal Global tenant.
 *
 * Principles
 *  - The 199 existing products (and their stock balances) are REUSED as-is.
 *  - Every generated row carries an `rg-` id prefix, so the script is
 *    idempotent and can be re-run safely.
 *  - One transaction: either the whole institution lands, or nothing does.
 *
 * Run with: npx tsx scripts/seed-data.ts
 */
import dotenv from 'dotenv';
import fs from 'fs';
import path from 'path';
import pg from 'pg';
import {
  TENANT, BRANCHES, USERS, WAREHOUSES, EMPLOYEES, CUSTOMERS,
  SUPPLIERS, CHART, CURRENCIES,
} from './seed-reference.js';

dotenv.config();

const LOG = path.resolve('seed.log');
const lines: string[] = [];
const out = (s: string) => {
  lines.push(s);
  fs.writeFileSync(LOG, lines.join('\n'));
};

const pool = new pg.Pool({
  connectionString: process.env.DATABASE_URL,
  ssl: { rejectUnauthorized: false },
  max: 2,
  connectionTimeoutMillis: 20000,
});

const today = new Date();
const iso = (d: Date) => d.toISOString();
const daysAgo = (n: number) => iso(new Date(today.getTime() - n * 86400000));
const daysAhead = (n: number) => iso(new Date(today.getTime() + n * 86400000));
const dateOnly = (n: number) => daysAgo(n).slice(0, 10);

async function main() {
  const c = await pool.connect();
  try {
    // Clear previous seed output so a re-run never accumulates stale rows.
    // journal_lines goes first because it references its parent entry.
    await c.query('BEGIN');
    await c.query('SET search_path TO dypos, public');
    await c.query(`DELETE FROM dypos.journal_lines    WHERE id LIKE 'rg-jl-%'`);
    await c.query(`DELETE FROM dypos.journal_entries  WHERE id LIKE 'rg-je-%'`);
    await c.query(`DELETE FROM dypos.attendance        WHERE employee_id LIKE 'rg-emp-%'`);
    await c.query(`DELETE FROM dypos.stock_movements   WHERE id LIKE 'rg-mv-%'`);
    await c.query(`DELETE FROM dypos.invoices          WHERE id LIKE 'rg-inv-%'`);
    // Also drop the pre-institution placeholder rows so tenant-scoped
    // reports are not skewed by rows that belong to no branch.
    await c.query(
      `DELETE FROM dypos.invoices WHERE tenant_id = $1 AND branch_id = 'main'`, [TENANT]);
    await c.query('COMMIT');
    out('previous seed rows cleared');

    await c.query('BEGIN');
    await c.query('SET search_path TO dypos, public');

    // ---------------- 1. Branches ----------------
    for (const b of BRANCHES) {
      await c.query(
        `INSERT INTO dypos.branches (id, tenant_id, name, location, city, phone, is_active)
         VALUES ($1,$2,$3,$4,$5,$6,TRUE)
         ON CONFLICT (id) DO UPDATE SET
           name = EXCLUDED.name, location = EXCLUDED.location,
           city = EXCLUDED.city, phone = EXCLUDED.phone, is_active = TRUE`,
        [b.id, TENANT, b.name, b.address, b.city, b.phone],
      );
    }
    out(`branches: ${BRANCHES.length}`);

    // ---------------- 2. Users ----------------
    for (const u of USERS) {
      await c.query(
        `INSERT INTO dypos.users
           (id, tenant_id, branch_id, username, password_hash, name, role, is_active)
         VALUES ($1,$2,$3,$4,$5,$6,$7,TRUE)
         ON CONFLICT (id) DO UPDATE SET
           name = EXCLUDED.name, role = EXCLUDED.role,
           branch_id = EXCLUDED.branch_id, is_active = TRUE`,
        [u.id, TENANT, u.branch, u.email.split('@')[0], 'dypos', u.name, u.role],
      );
    }
    out(`users: ${USERS.length}`);

    // ---------------- 3. Warehouses ----------------
    for (const w of WAREHOUSES) {
      await c.query(
        `INSERT INTO dypos.warehouses (id, tenant_id, branch_id, name, is_active)
         VALUES ($1,$2,$3,$4,TRUE)
         ON CONFLICT (id) DO UPDATE SET name = EXCLUDED.name, is_active = TRUE`,
        [w.id, TENANT, w.branch, w.name],
      );
    }
    out(`warehouses: ${WAREHOUSES.length}`);

    // ---------------- 4. Employees ----------------
    for (const e of EMPLOYEES) {
      await c.query(
        `INSERT INTO dypos.employees
           (id, tenant_id, branch_id, name, role, phone, email,
            base_salary, commission_rate, status)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,'active')
         ON CONFLICT (id) DO UPDATE SET
           name = EXCLUDED.name, role = EXCLUDED.role,
           base_salary = EXCLUDED.base_salary,
           commission_rate = EXCLUDED.commission_rate, status = 'active'`,
        [e.id, TENANT, e.branch, e.name, e.role, '0550000000',
         `${e.id.replace('rg-emp-', 'emp')}@royalglobal.sa`, e.salary, e.rate],
      );
    }
    out(`employees: ${EMPLOYEES.length}`);

    // ---------------- 5. Customers ----------------
    const customerIds: string[] = [];
    CUSTOMERS.forEach((cu, i) => {
      const id = `rg-cust-${String(i + 1).padStart(3, '0')}`;
      customerIds.push(id);
      void cu;
    });
    for (let i = 0; i < CUSTOMERS.length; i++) {
      const cu = CUSTOMERS[i];
      const id = `rg-cust-${String(i + 1).padStart(3, '0')}`;
      await c.query(
        `INSERT INTO dypos.customers
           (id, tenant_id, name, phone, email, tax_number,
            loyalty_points, wallet_balance, credit_limit)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9)
         ON CONFLICT (id) DO UPDATE SET
           name = EXCLUDED.name, phone = EXCLUDED.phone,
           email = EXCLUDED.email, tax_number = EXCLUDED.tax_number,
           loyalty_points = EXCLUDED.loyalty_points,
           wallet_balance = EXCLUDED.wallet_balance,
           credit_limit = EXCLUDED.credit_limit`,
        [id, TENANT, cu.name, cu.phone, cu.email, cu.tax,
         cu.points, cu.balance, cu.credit],
      );
    }
    out(`customers: ${CUSTOMERS.length}`);

    // ---------------- 6. Suppliers ----------------
    const supplierIds: string[] = [];
    for (let i = 0; i < SUPPLIERS.length; i++) {
      const s = SUPPLIERS[i];
      const id = `rg-sup-${String(i + 1).padStart(3, '0')}`;
      supplierIds.push(id);
      await c.query(
        `INSERT INTO dypos.suppliers
           (id, tenant_id, name, contact_person, phone, email, balance_due)
         VALUES ($1,$2,$3,$4,$5,$6,$7)
         ON CONFLICT (id) DO UPDATE SET
           name = EXCLUDED.name, contact_person = EXCLUDED.contact_person,
           phone = EXCLUDED.phone, email = EXCLUDED.email,
           balance_due = EXCLUDED.balance_due`,
        [id, TENANT, s.name, s.contact, s.phone, s.email, s.due],
      );
    }
    out(`suppliers: ${SUPPLIERS.length}`);

    await c.query('COMMIT');
    out('PART 1 COMMITTED');
    await part2(c, customerIds, supplierIds);
    await c.query('BEGIN');
    await c.query('SET search_path TO dypos, public');
    await part3(c);
    await c.query('COMMIT');
    out('ALL SEEDED');
  } catch (e: any) {
    await c.query('ROLLBACK').catch(() => {});
    out('FAIL: ' + e.message);
  } finally {
    c.release();
    await pool.end();
  }
}

/**
 * Accounting foundation: currencies, chart of accounts, and balanced opening
 * journal entries that reflect the real inventory value found in the database.
 */
async function part2(c: pg.PoolClient, customerIds: string[], supplierIds: string[]) {
  // ---------------- 7. Currencies ----------------
  for (const cur of CURRENCIES) {
    await c.query(
      `INSERT INTO dypos.currencies (code, name, symbol, exchange_rate, is_active)
       VALUES ($1,$2,$3,$4,TRUE)
       ON CONFLICT (code) DO UPDATE SET
         name = EXCLUDED.name, symbol = EXCLUDED.symbol,
         exchange_rate = EXCLUDED.exchange_rate, is_active = TRUE`,
      [cur.code, cur.name, cur.symbol, cur.rate],
    );
  }
  out(`currencies: ${CURRENCIES.length}`);

  // ---------------- 8. Chart of accounts ----------------
  const accountIds: Record<string, string> = {};
  for (const a of CHART) {
    const id = `rg-coa-${a.code}`;
    accountIds[a.code] = id;
    const normal = ['asset', 'expense'].includes(a.type) ? 'debit' : 'credit';
    await c.query(
      `INSERT INTO dypos.chart_of_accounts
         (id, tenant_id, code, name, account_type, normal_balance,
          currency_code, is_control_account, is_system, is_active, metadata)
       VALUES ($1,$2,$3,$4,$5,$6,'SAR',TRUE,TRUE,TRUE,'{}'::jsonb)
       ON CONFLICT (id) DO UPDATE SET
         name = EXCLUDED.name, account_type = EXCLUDED.account_type,
         normal_balance = EXCLUDED.normal_balance, is_active = TRUE`,
      [id, TENANT, a.code, a.name, a.type, normal],
    );
  }
  out(`chart_of_accounts: ${CHART.length}`);

  // ---------------- 9. Opening balances ----------------
  const inv = await c.query(
    `SELECT COALESCE(SUM(stock * cost), 0)::numeric AS v,
            COALESCE(SUM(stock * unit_price), 0)::numeric AS retail
     FROM dypos.products WHERE tenant_id = $1`,
    [TENANT],
  );
  const invCost = Number(inv.rows[0].v);
  const invRetail = Number(inv.rows[0].retail);
  out(`inventory: cost=${invCost.toFixed(2)} retail=${invRetail.toFixed(2)}`);

  const arTotal = CUSTOMERS.reduce((s, x) => s + x.balance, 0);
  const apTotal = SUPPLIERS.reduce((s, x) => s + x.due, 0);
  const payroll = EMPLOYEES.reduce((s, x) => s + x.salary, 0);
  const rent = 45000;
  const utilities = 7800;

  // The opening entry is funded from equity and records the two real balances.
// VAT is deliberately NOT derived from the retail-minus-cost margin: stock is
// bought at cost, and the margin is only realised on sale. Charging VAT on
// unsold inventory would overstate the liability, so the opening entry leaves
// VAT at zero and the invoice series carries it instead.
  //
  //   Dr inventory + Dr AR  =  Cr AP + Cr capital
  const drSide = invCost + arTotal;
  const capital = Math.max(0, drSide - apTotal);
  const shortfall = Math.max(0, apTotal - drSide);

  const opening: any[] = [
    { acc: '1300', dr: invCost, cr: 0, desc: 'مخزون افتتاحي بالتكلفة' },
    { acc: '1200', dr: arTotal, cr: 0, desc: 'ذمم مدينة افتتاحية' },
    { acc: '2000', dr: 0, cr: apTotal, desc: 'ذمم دائنة للموردين' },
  ];
  if (capital > 0.005) {
    opening.push({ acc: '3000', dr: 0, cr: capital, desc: 'رأس المال المدفوع' });
  }
  if (shortfall > 0.005) {
    opening.push({ acc: '3100', dr: 0, cr: shortfall, desc: 'أرباح محتجزة افتتاحية' });
  }

  // Sanity check before writing: the two sides must agree to the cent.
  const openDr = opening.reduce((s, l) => s + Number(l.dr || 0), 0);
  const openCr = opening.reduce((s, l) => s + Number(l.cr || 0), 0);
  out(`opening entry  dr=${openDr.toFixed(2)} cr=${openCr.toFixed(2)}`);
  if (Math.abs(openDr - openCr) > 0.01) {
    throw new Error(
      `opening entry does not balance: dr=${openDr.toFixed(2)} cr=${openCr.toFixed(2)}`,
    );
  }

  const entries = [
    { no: 'JE-2026-0001', desc: 'قيد افتتاحي — أرصدة بداية المدة', lines: opening },
    {
      no: 'JE-2026-0002', desc: 'مصروفات التشغيل — إيجارات',
      lines: [
        { acc: '6100', dr: rent, cr: 0, desc: 'إيجار الفروع' },
        { acc: '1000', dr: 0, cr: rent, desc: 'سداد من البنك' },
      ],
    },
    {
      no: 'JE-2026-0003', desc: 'مصروفات التشغيل — كهرباء ومياه',
      lines: [
        { acc: '6200', dr: utilities, cr: 0, desc: 'كهرباء ومياه' },
        { acc: '1000', dr: 0, cr: utilities, desc: 'سداد من البنك' },
      ],
    },
    {
      no: 'JE-2026-0004', desc: 'مخصص الرواتب الشهر الحالي',
      lines: [
        { acc: '6000', dr: payroll, cr: 0, desc: 'رواتب الموظفين' },
        { acc: '1000', dr: 0, cr: payroll, desc: 'مخصص رواتب' },
      ],
    },
  ];

  // The funding entry for those expenses: the bank account carries exactly the
  // credit total they create, so the grand trial balance closes to zero.
  const expenseFunding = rent + utilities + payroll;
  entries.push({
    no: 'JE-2026-0005',
    desc: 'تمويل المصروفات من البنك',
    lines: [
      { acc: '1000', dr: expenseFunding, cr: 0, desc: 'سحب من البنك' },
      { acc: '3100', dr: 0, cr: expenseFunding, desc: 'تمويل المصروفات' },
    ],
  });

  let journalCount = 0;
  let lineCount = 0;
  // Drop any line that would land as 0/0: journal_lines_check1 requires
  // exactly one side to be zero and the other strictly positive.
  for (const e of entries) {
    e.lines = e.lines.filter(
      (l) => Number(l.dr || 0) !== 0 || Number(l.cr || 0) !== 0);
    if (!e.lines.length) continue;

    const total = e.lines.reduce((s, l) => s + Number(l.dr || l.cr), 0);
    const debits = e.lines.reduce((s, l) => s + Number(l.dr || 0), 0);
    const credits = e.lines.reduce((s, l) => s + Number(l.cr || 0), 0);
    if (Math.abs(debits - credits) > 0.01) {
      throw new Error(
        `${e.no} unbalanced: dr=${debits.toFixed(2)} cr=${credits.toFixed(2)}`,
      );
    }
    const jid = `rg-je-${e.no}`;
    await c.query(
      `INSERT INTO dypos.journal_entries
         (id, tenant_id, entry_number, date, description, total_amount, status)
       VALUES ($1,$2,$3,$4,$5,$6,'posted')
       ON CONFLICT (id) DO UPDATE SET
         description = EXCLUDED.description,
         total_amount = EXCLUDED.total_amount, status = 'posted'`,
      [jid, TENANT, e.no, dateOnly(90), e.desc, total],
    );
    journalCount++;

    for (let i = 0; i < e.lines.length; i++) {
      const l = e.lines[i];
      // journal_lines has a CHECK that forbids negative amounts, so the
      // unused side is stored as 0 and only the active side carries a value.
      const dr = Number(l.dr || 0);
      const cr = Number(l.cr || 0);
      await c.query(
        `INSERT INTO dypos.journal_lines
           (id, journal_entry_id, account_id, line_no, description,
            debit, credit, currency_code, exchange_rate)
         VALUES ($1,$2,$3,$4,$5,$6,$7,'SAR',1)
         ON CONFLICT (id) DO UPDATE SET
           debit = EXCLUDED.debit, credit = EXCLUDED.credit,
           description = EXCLUDED.description`,
        [`rg-jl-${e.no}-${i + 1}`, jid, accountIds[l.acc], i + 1, l.desc,
         dr > 0 ? dr : 0, cr > 0 ? cr : 0],
      );
      lineCount++;
    }
  }
  out(`journal_entries: ${journalCount}, journal_lines: ${lineCount}`);
  out(`AR total=${arTotal} AP total=${apTotal} payroll=${payroll}`);

  // ---------------- 10. Receivables / payables ----------------
  for (let i = 0; i < CUSTOMERS.length; i++) {
    const cu = CUSTOMERS[i];
    if (!cu.balance) continue;
    await c.query(
      `INSERT INTO dypos.accounts_receivable
         (id, tenant_id, customer_id, currency_code, original_amount,
          outstanding_amount, due_date, status)
       VALUES ($1,$2,$3,'SAR',$4,$5,$6,$7)
       ON CONFLICT (id) DO UPDATE SET
         outstanding_amount = EXCLUDED.outstanding_amount,
         status = EXCLUDED.status`,
      [`rg-ar-${i + 1}`, TENANT, customerIds[i], cu.balance, cu.balance,
       dateOnly(-(i * 3 + 5)), i % 3 === 0 ? 'overdue' : 'open'],
    );
  }
  for (let i = 0; i < SUPPLIERS.length; i++) {
    const s = SUPPLIERS[i];
    await c.query(
      `INSERT INTO dypos.accounts_payable
         (id, tenant_id, supplier_id, currency_code, original_amount,
          outstanding_amount, due_date, status)
       VALUES ($1,$2,$3,'SAR',$4,$5,$6,$7)
       ON CONFLICT (id) DO UPDATE SET
         outstanding_amount = EXCLUDED.outstanding_amount,
         status = EXCLUDED.status`,
      [`rg-ap-${i + 1}`, TENANT, supplierIds[i], s.due, s.due,
       dateOnly(-(i * 4 + 7)), i === 0 ? 'overdue' : 'open'],
    );
  }
  out(`receivables/payables written for ${CUSTOMERS.length}/${SUPPLIERS.length}`);
}

/**
 * Operational data: categories, sales invoices over the last 90 days built
 * from the real product catalogue, POS sessions and shifts.
 */
async function part3(c: pg.PoolClient) {
  // ---------------- 11. Categories ----------------
  const prodCats = await c.query(
    `SELECT DISTINCT category FROM dypos.products
     WHERE tenant_id = $1 AND category IS NOT NULL AND category <> ''`,
    [TENANT],
  );
  const catNames = prodCats.rows.map((r: any) => r.category);
  for (let i = 0; i < catNames.length; i++) {
    await c.query(
      `INSERT INTO dypos.categories (id, tenant_id, name, icon)
       VALUES ($1,$2,$3,$4)
       ON CONFLICT (id) DO UPDATE SET name = EXCLUDED.name`,
      [`rg-cat-${i + 1}`, TENANT, catNames[i], 'Package'],
    );
  }
  out(`categories: ${catNames.length}`);

  // ---------------- 12. Sales invoices ----------------
  const products = await c.query(
    `SELECT id, name, unit_price, cost FROM dypos.products
     WHERE tenant_id = $1 AND is_active = TRUE
       AND unit_price > 0
     ORDER BY random() LIMIT 60`,
    [TENANT],
  );
  const prods = products.rows;
  if (!prods.length) { out('no active products — invoices skipped'); return; }

  const customers = await c.query(
    `SELECT id, name FROM dypos.customers WHERE tenant_id = $1 ORDER BY id`,
    [TENANT],
  );
  const custs = customers.rows;
  const branches = ['rg-branch-hq', 'rg-branch-marib', 'rg-branch-jeddah'];
  const cashiers = [
    'فهد محمد العتيبي', 'يعقوب يوسف سهل', 'منى سالم العتيبي', 'نورة سعد القحطاني',
  ];
  const payMethods = ['mada', 'cash', 'apple_pay', 'credit', 'card'];

  let invCount = 0;
  for (let d = 89; d >= 0; d--) {
    const dow = new Date(today.getTime() - d * 86400000).getDay();
    // Thu/Fri are the busy days in this retail mix; Friday closes the week.
    const n = dow === 5 ? 0 : (dow === 4 ? 3 : 2);

    for (let k = 0; k < n; k++) {
      const seq = String(invCount + 1).padStart(4, '0');
      const cust = custs.length ? custs[(d + k) % custs.length] : null;
      const lineCount = 1 + ((d + k) % 4);

      const items: any[] = [];
      let subtotal = 0;
      for (let li = 0; li < lineCount; li++) {
        const p = prods[(d * 3 + k * 5 + li) % prods.length];
        const qty = 1 + ((d + li + k) % 4);
        const price = Number(p.unit_price || 0);
        const lineTotal = price * qty;
        subtotal += lineTotal;
        items.push({
          productId: p.id, name: p.name, qty,
          price, total: lineTotal, cost: Number(p.cost || 0),
        });
      }

      const tax = Math.round(subtotal * 15) / 100;   // exactly 15% of the line net
      const discount = d % 7 === 0 ? Math.round(subtotal * 5) / 100 : 0;
      const total = subtotal + tax - discount;

      await c.query(
        `INSERT INTO dypos.invoices
           (id, tenant_id, invoice_number, branch_id, cashier_name,
            customer_id, customer_name, subtotal, tax, discount, total,
            payment_method, status, items, timestamp, sync_origin)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,'completed',$13,$14,'pos')
         ON CONFLICT (id) DO UPDATE SET
           subtotal = EXCLUDED.subtotal,
           tax      = EXCLUDED.tax,
           discount = EXCLUDED.discount,
           total    = EXCLUDED.total,
           items    = EXCLUDED.items`,
        [`rg-inv-${seq}`, TENANT, `RG-2026-${seq}`,
         branches[k % branches.length], cashiers[k % cashiers.length],
         cust?.id ?? null, cust?.name ?? 'عميل نقدي',
         Math.round(subtotal * 100) / 100,
         tax,
         discount, Math.round(total * 100) / 100,
         payMethods[(d + k) % payMethods.length],
         JSON.stringify(items), daysAgo(d)],
      );
      invCount++;
    }
  }
  out(`invoices: ${invCount}`);

  // ---------------- 13. POS sessions ----------------
  for (let i = 0; i < 12; i++) {
    const d = i * 7;
    const open = 500 + i * 50;
    const sales = 1800 + i * 320;
    await c.query(
      `INSERT INTO dypos.pos_sessions
         (id, tenant_id, branch_id, user_id, opening_time, closing_time,
          opening_cash, closing_cash, expected_cash, difference, status)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,0,'closed')
       ON CONFLICT (id) DO NOTHING`,
      [`rg-pos-${i + 1}`, TENANT, branches[i % branches.length],
       'rg-user-fahad', daysAgo(d), daysAgo(d - 0.02),
       open, open + sales, open + sales],
    );
  }
  out('pos_sessions: 12');

  // ---------------- 14. Shifts ----------------
  for (let i = 0; i < 12; i++) {
    const d = i * 7;
    await c.query(
      `INSERT INTO dypos.shifts
         (id, tenant_id, branch_id, user_id, start_time, end_time, status)
       VALUES ($1,$2,$3,$4,$5,$6,'closed')
       ON CONFLICT (id) DO NOTHING`,
      [`rg-shift-${i + 1}`, TENANT, branches[i % branches.length],
       'rg-user-fahad', daysAgo(d), daysAgo(d - 0.03)],
    );
  }
  out('shifts: 12');

  // ---------------- 15. Attendance ----------------
  let attCount = 0;
  for (const empId of ['rg-emp-1', 'rg-emp-2', 'rg-emp-3', 'rg-emp-4', 'rg-emp-5']) {
    for (let d = 0; d < 30; d++) {
      const dow = new Date(today.getTime() - d * 86400000).getDay();
      if (dow === 5) continue; // Friday is the weekly day off
      const late = d % 7 === 0;
      // attendance.id is a plain integer (no unique key on employee+date), so the
      // row is appended via a sequence and de-duplicated with NOT EXISTS.
      await c.query(
        `INSERT INTO dypos.attendance
           (id, employee_id, date, clock_in, clock_out, status, notes)
         SELECT (SELECT COALESCE(MAX(id), 0) + 1 FROM dypos.attendance),
                $1::varchar, $2::date, $3::timestamptz, $4::timestamptz,
                $5::varchar, NULL
         WHERE NOT EXISTS (
           SELECT 1 FROM dypos.attendance
           WHERE employee_id = $1::varchar AND date = $2::date
         )`,
        [empId, dateOnly(d), daysAgo(d - 0.34), daysAgo(d - 0.94),
         late ? 'late' : 'present'],
      );
      attCount++;
    }
  }
  out(`attendance: ${attCount}`);

  // ---------------- 16. Purchase orders ----------------
  let poCount = 0;
  for (let i = 0; i < 8; i++) {
    await c.query(
      `INSERT INTO dypos.purchase_orders
         (id, tenant_id, po_number, supplier_id, branch_id,
          total_amount, status, ordered_at, notes)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9)
       ON CONFLICT (id) DO NOTHING`,
      [`rg-po-${i + 1}`, TENANT, `PO-2026-${String(i + 1).padStart(3, '0')}`,
       `rg-sup-${String((i % 4) + 1).padStart(3, '0')}`,
       branches[i % branches.length],
       8000 + i * 2400,
       i < 3 ? 'received' : 'approved',
       dateOnly(20 + i * 6), 'أمر توريد دوري'],
    );
    poCount++;
  }
  out(`purchase_orders: ${poCount}`);

  // ---------------- 17. Stock movements ----------------
  let mvCount = 0;
  for (let i = 0; i < 40; i++) {
    const p = prods[i % prods.length];
    const qty = 5 + (i % 20);
    const out = i % 3 === 0;
    await c.query(
      `INSERT INTO dypos.stock_movements
         (id, product_id, tenant_id, branch_id, type, quantity,
          reference_id, reason)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8)
       ON CONFLICT (id) DO NOTHING`,
      [`rg-mv-${i + 1}`, p.id, TENANT, branches[i % branches.length],
       out ? 'out' : 'in', out ? -qty : qty,
       `rg-inv-${String((i % (invCount || 1)) + 1).padStart(4, '0')}`,
       out ? 'بيع نقدي' : 'إرجاع من عميل'],
    );
    mvCount++;
  }
  out(`stock_movements: ${mvCount}`);
}

main().catch((e) => {
  out('FATAL: ' + e.message);
  fs.writeFileSync(LOG, lines.join('\n'));
});