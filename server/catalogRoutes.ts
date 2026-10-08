/**
 * Catalog & ledger write routes — journal entries, purchase orders, products.
 *
 * ── Why this module exists ─────────────────────────────────────────────────
 * Live probing of production found NO POST for `/api/db/journal-entries`,
 * `/api/db/purchase-orders` or `/api/db/products`, and no GET for
 * `/api/db/journal-entries` at all. The screens' save buttons therefore mutated
 * React state and lost the record on refresh, while the client manufactured its
 * own document numbers — `JE-TMP-<uuid>`, `PO-TMP-<uuid>`, `628<random>` — which
 * is precisely the failure `server/documentNumber.ts` exists to prevent: a
 * number built from client state can be produced twice and cannot be reconciled
 * later. Numbers are allocated here, server-side, from the shared counter.
 *
 * ── The contract ───────────────────────────────────────────────────────────
 * The response shapes below are a CONTRACT shared with the Cloudflare Worker
 * implementation and the client. A field renamed here breaks both, so the
 * shapes are written out explicitly rather than derived from SQL aliases.
 *
 * ── The rules every route here follows ─────────────────────────────────────
 *   · `attachPrincipal` resolves the verified identity (same as the other
 *     `/api/db/*` routes in this repo);
 *   · the tenant ALWAYS comes from `tenantOf(req)` — never from the query
 *     string and never from the body;
 *   · parameterised SQL only: `pool.query(sql, [...])`.
 *
 * GET `/api/db/products` is deliberately NOT here: it already exists in
 * `server.ts` and returns the canonical `{ items, count, products }` envelope,
 * which is left untouched.
 */
import type { Express } from 'express';
import { pool } from './neonDb.js';
import { asyncRoute, fail, makeId, num, tenantOf } from './apiHelpers.js';
import { attachPrincipal } from './authz.js';
import { allocateBarcode, allocateDocumentNumber } from './documentNumber.js';

type Row = Record<string, any>;

/** A query surface shared by `pool` and an open transaction client. */
interface Queryable {
  query: (sql: string, values?: unknown[]) => Promise<unknown>;
}

const DATE_PREFIX = /^\d{4}-\d{2}-\d{2}/;

/**
 * Normalises anything the client (or pg) sent as a date to `YYYY-MM-DD`.
 *
 * pg returns a `date` column as a JS `Date` at LOCAL midnight, so
 * `toISOString().slice(0, 10)` is wrong in any negative UTC offset: the 1st of
 * the month is rendered as the last day of the previous one. The local parts
 * are used instead. A value that is not a date at all falls back, so a bad
 * input can never become `Invalid Date` in the ledger.
 */
function ymd(value: unknown, fallback: string): string {
  if (value instanceof Date && !Number.isNaN(value.getTime())) {
    const y = value.getFullYear();
    const m = String(value.getMonth() + 1).padStart(2, '0');
    const d = String(value.getDate()).padStart(2, '0');
    return `${y}-${m}-${d}`;
  }
  if (typeof value === 'string' && DATE_PREFIX.test(value)) return value.slice(0, 10);
  return fallback;
}

function today(): string {
  return ymd(new Date(), '');
}

/** `الصندوق (1010)` — the exact string the client renders for a ledger leg. */
function legLabel(name: unknown, code: unknown): string {
  const n = name == null ? '' : String(name).trim();
  const c = code == null ? '' : String(code).trim();
  if (!c) return '';
  return n ? `${n} (${c})` : `(${c})`;
}

const LEG_RE = /\(([^)]+)\)/;

/**
 * Parses one side of a double entry, e.g. `الصندوق (1010)`.
 *
 * Returns `null` when there is no parsable account code — the caller SKIPS
 * that leg rather than failing the request or inventing a code: refusing the
 * posting would lose a real entry because of how the operator typed free text,
 * and inventing the code would put the entry in accounts nobody chose.
 */
function parseLeg(raw: unknown): { name: string; code: string } | null {
  const text = String(raw ?? '').trim();
  if (!text) return null;
  const m = LEG_RE.exec(text);
  if (!m) return null;
  const code = m[1].trim();
  if (!code) return null;
  const name = (text.slice(0, m.index) + text.slice(m.index + m[0].length)).trim();
  return { name, code };
}

async function insertLedgerLeg(
  client: Queryable,
  journalId: string,
  leg: { name: string; code: string },
  debit: number,
  credit: number,
): Promise<void> {
  // `dypos.ledger` has NO tenant_id: a leg belongs to a journal, and the journal
  // is tenant-scoped, so `journal_id` is the only tenant boundary that exists
  // for this table. Scope it there and nowhere else.
  await client.query(
    `INSERT INTO dypos.ledger (id, journal_id, account_code, account_name, debit, credit)
     VALUES ($1, $2, $3, $4, $5, $6)`,
    [makeId('led'), journalId, leg.code, leg.name || null, debit, credit],
  );
}

export function registerCatalogRoutes(app: Express) {
  /*
   * ══ 1. JOURNAL ENTRIES — LIST ═════════════════════════════════════════════
   * `{ items, count }` where each item carries the two account legs as the
   * strings the accounting screen renders: `account_name (account_code)`.
   *
   * The legs come from `dypos.ledger` — TWO rows per journal, the debit leg
   * (`debit > 0`) and the credit leg (`credit > 0`). A journal with no legs
   * yields `''` on that side: the value is READ from the ledger, never
   * fabricated, because a plausible-looking account string with nothing behind
   * it is worse than an empty one.
   *
   * `dypos.ledger` has no tenant column, so legs are fetched only for the
   * journal ids this tenant's own query returned — that is the entire tenant
   * boundary available on that table, and it holds because the journal ids
   * were already scoped by `tenant_id = $1`.
   */
  app.get('/api/db/journal-entries', attachPrincipal, asyncRoute(async (req, res) => {
    const tenant = tenantOf(req);
    const limit = Math.min(Number(req.query.limit) || 500, 1000);

    const { rows } = await pool.query(
      `SELECT id, entry_number, date, description, total_amount, status
         FROM dypos.journal_entries
        WHERE tenant_id = $1
        ORDER BY created_at DESC, id DESC
        LIMIT $2`,
      [tenant, limit],
    );
    if (!rows.length) return res.json({ items: [], count: 0 });

    const legs = await pool.query(
      `SELECT journal_id, account_code, account_name, debit, credit
         FROM dypos.ledger
        WHERE journal_id = ANY($1)`,
      [rows.map((r: Row) => r.id)],
    );

    const legsByJournal = new Map<string, Row[]>();
    for (const leg of legs.rows as Row[]) {
      const key = String(leg.journal_id);
      const list = legsByJournal.get(key);
      if (list) list.push(leg);
      else legsByJournal.set(key, [leg]);
    }

    const items = rows.map((r: Row) => {
      const legsForEntry = legsByJournal.get(String(r.id)) || [];
      const debitLeg = legsForEntry.find((l) => num(l.debit) > 0);
      const creditLeg = legsForEntry.find((l) => num(l.credit) > 0);
      return {
        id: String(r.id),
        entryNumber: String(r.entry_number),
        date: ymd(r.date, ''),
        description: r.description == null ? '' : String(r.description),
        accountDebit: debitLeg ? legLabel(debitLeg.account_name, debitLeg.account_code) : '',
        accountCredit: creditLeg ? legLabel(creditLeg.account_name, creditLeg.account_code) : '',
        amount: num(r.total_amount),
        status: r.status == null ? '' : String(r.status),
      };
    });

    res.json({ items, count: items.length });
  }));

  /*
   * ══ 2. JOURNAL ENTRIES — CREATE ═══════════════════════════════════════════
   * Allocates `JRN-2026-000001` from the shared counter INSIDE the same
   * transaction as the write, so the counter's row lock is held to commit and
   * two concurrent posts cannot receive the same number. The number is consumed
   * by a document that is about to exist; a rollback leaves a visible, auditable
   * gap rather than a silent duplicate.
   */
  app.post('/api/db/journal-entries', attachPrincipal, asyncRoute(async (req, res) => {
    const tenant = tenantOf(req);
    const b = req.body || {};

    const description = String(b.description ?? '').trim();
    const amount = Number(b.amount);
    if (!description) return fail(res, 400, 'بيان القيد مطلوب');
    if (!Number.isFinite(amount) || amount <= 0) {
      return fail(res, 400, 'مبلغ القيد يجب أن يكون رقماً موجباً صالحاً');
    }

    const debit = parseLeg(b.accountDebit);
    const credit = parseLeg(b.accountCredit);
    const date = ymd(b.date, today());
    const status = typeof b.status === 'string' && b.status.trim() ? b.status.trim() : 'posted';
    const id = makeId('je');
    let entryNumber = '';

    const client = await pool.connect();
    try {
      await client.query('BEGIN');
      entryNumber = await allocateDocumentNumber(tenant, 'journal', new Date(), client);

      await client.query(
        `INSERT INTO dypos.journal_entries
           (id, tenant_id, entry_number, date, description, total_amount, status)
         VALUES ($1, $2, $3, $4::date, $5, $6, $7)`,
        [id, tenant, entryNumber, date, description, amount, status],
      );

      // A leg whose side carries no `(code)` is skipped silently — see
      // `parseLeg`. The entry itself is still written: a real posting must not
      // be lost because one side was typed as free text.
      if (debit) await insertLedgerLeg(client, id, debit, amount, 0);
      if (credit) await insertLedgerLeg(client, id, credit, 0, amount);

      await client.query('COMMIT');
    } catch (err) {
      await client.query('ROLLBACK').catch(() => {});
      throw err;
    } finally {
      client.release();
    }

    res.status(201).json({
      item: {
        id,
        entryNumber,
        date,
        description,
        accountDebit: legLabel(debit?.name, debit?.code),
        accountCredit: legLabel(credit?.name, credit?.code),
        amount,
        status,
      },
    });
  }));

  /*
   * ══ 3. PURCHASE ORDERS — LIST ═════════════════════════════════════════════
   * `items` on each order is ALWAYS an array — the client calls
   * `po.items.map(...)`, and `undefined.map` is a blank screen. It is read from
   * `dypos.purchase_order_lines` (v151), never synthesised.
   *
   * The supplier comes from a LEFT JOIN so an order whose supplier was removed
   * still lists, with an empty name rather than no row.
   */
  app.get('/api/db/purchase-orders', attachPrincipal, asyncRoute(async (req, res) => {
    const tenant = tenantOf(req);
    const limit = Math.min(Number(req.query.limit) || 500, 1000);

    const { rows } = await pool.query(
      `SELECT po.id, po.po_number, po.supplier_id, po.total_amount, po.status,
              po.ordered_at, s.name AS supplier_name
         FROM dypos.purchase_orders po
         LEFT JOIN dypos.suppliers s ON s.id = po.supplier_id
        WHERE po.tenant_id = $1
        ORDER BY po.ordered_at DESC NULLS LAST, po.created_at DESC
        LIMIT $2`,
      [tenant, limit],
    );
    if (!rows.length) return res.json({ items: [], count: 0 });

    const lines = await pool.query(
      `SELECT po_id, product_name, quantity, unit_cost
         FROM dypos.purchase_order_lines
        WHERE po_id = ANY($1)
        ORDER BY position`,
      [rows.map((r: Row) => r.id)],
    );

    const linesByOrder = new Map<string, Array<{ productName: string; quantity: number; unitCost: number }>>();
    for (const l of lines.rows as Row[]) {
      const key = String(l.po_id);
      const entry = { productName: String(l.product_name), quantity: num(l.quantity), unitCost: num(l.unit_cost) };
      const list = linesByOrder.get(key);
      if (list) list.push(entry);
      else linesByOrder.set(key, [entry]);
    }

    const items = rows.map((r: Row) => ({
      id: String(r.id),
      poNumber: String(r.po_number),
      supplierId: r.supplier_id == null ? null : String(r.supplier_id),
      supplierName: r.supplier_name == null ? '' : String(r.supplier_name),
      items: linesByOrder.get(String(r.id)) || [],
      totalAmount: num(r.total_amount),
      status: r.status == null ? 'pending' : String(r.status),
      orderDate: ymd(r.ordered_at, ''),
    }));

    res.json({ items, count: items.length });
  }));

  /*
   * ══ 4. PURCHASE ORDERS — CREATE ═══════════════════════════════════════════
   * The total is CHECKED, not trusted: `computed` is derived from the lines and
   * a supplied `totalAmount` that disagrees by more than a halalas is refused —
   * the same honesty rule the invoice route applies. A document whose total the
   * server cannot derive from its own lines is a document the ledger cannot
   * explain later.
   *
   * Lines are written to `dypos.purchase_order_lines`, NOT to
   * `dypos.purchase_order_items`: that table's `product_id` is NOT NULL with an
   * FK to `dypos.products(id)`, so a free-text line for a part not yet in the
   * catalogue could never be inserted there (migration v151).
   */
  app.post('/api/db/purchase-orders', attachPrincipal, asyncRoute(async (req, res) => {
    const tenant = tenantOf(req);
    const b = req.body || {};

    const rawItems = Array.isArray(b.items) ? b.items : [];
    if (!rawItems.length) return fail(res, 400, 'أمر الشراء لا يحتوي على أصناف');

    const items: Array<{ productName: string; quantity: number; unitCost: number }> = [];
    let computed = 0;
    for (const raw of rawItems) {
      const it: Row = raw || {};
      const productName = String(it.productName ?? '').trim();
      const quantity = Number(it.quantity);
      if (!productName) return fail(res, 400, 'اسم الصنف مطلوب في بند أمر الشراء');
      if (!Number.isFinite(quantity) || quantity <= 0) {
        return fail(res, 400, 'كمية الصنف يجب أن تكون رقماً موجباً صالحاً');
      }
      // Absent or non-numeric cost is a zero-cost line, not a crash: the
      // `totalAmount` cross-check below is what refuses a total that does not
      // add up, so garbage here cannot smuggle a number into the document.
      const unitCost = Number.isFinite(Number(it.unitCost)) ? Number(it.unitCost) : 0;
      items.push({ productName, quantity, unitCost });
      computed += quantity * unitCost;
    }

    if (b.totalAmount !== undefined && b.totalAmount !== null && b.totalAmount !== '') {
      const supplied = Number(b.totalAmount);
      if (!Number.isFinite(supplied) || Math.abs(supplied - computed) > 0.01) {
        return fail(res, 400, 'إجمالي أمر الشراء لا يطابق مجموع الأصناف — لم يُسجَّل الأمر');
      }
    }
    const totalAmount = computed;

    const status = typeof b.status === 'string' && b.status.trim() ? b.status.trim() : 'approved';
    const orderDate = ymd(b.orderDate, today());
    const supplierId = b.supplierId ? String(b.supplierId) : null;
    const branchId = b.branchId ? String(b.branchId) : null;
    const notes = typeof b.notes === 'string' && b.notes.trim() ? b.notes.trim() : null;
    const id = makeId('po');

    /*
     * The supplier name is read BEFORE the transaction opens, not after it
     * commits: a failure on a read-back would report a 500 for an order that
     * genuinely exists, which is the worst possible answer — the natural
     * reaction is to press save again.
     */
    let supplierName = '';
    if (supplierId) {
      const s = await pool.query(
        `SELECT name FROM dypos.suppliers WHERE id = $1 AND tenant_id = $2`,
        [supplierId, tenant],
      );
      if (!s.rows.length) {
        // Scoped by tenant as well as id: a supplier id belonging to another
        // merchant is "not found" here, never "adopted".
        return fail(res, 400, 'المورد غير موجود');
      }
      supplierName = String(s.rows[0].name);
    }

    const client = await pool.connect();
    let poNumber = '';
    try {
      await client.query('BEGIN');
      poNumber = await allocateDocumentNumber(tenant, 'purchase_order', new Date(), client);

      await client.query(
        `INSERT INTO dypos.purchase_orders
           (id, tenant_id, po_number, supplier_id, branch_id, total_amount, status, ordered_at, notes)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8::date, $9)`,
        [id, tenant, poNumber, supplierId, branchId, totalAmount, status, orderDate, notes],
      );

      for (let i = 0; i < items.length; i += 1) {
        const it = items[i];
        await client.query(
          `INSERT INTO dypos.purchase_order_lines
             (id, tenant_id, po_id, position, product_name, quantity, unit_cost, line_total)
           VALUES ($1, $2, $3, $4, $5, $6, $7, $8)`,
          [makeId('pol'), tenant, id, i, it.productName, it.quantity, it.unitCost, it.quantity * it.unitCost],
        );
      }

      await client.query('COMMIT');
    } catch (err) {
      await client.query('ROLLBACK').catch(() => {});

      /*
       * `dypos.purchase_orders.po_number` is UNIQUE. The counter makes a
       * collision vanishingly unlikely, but "vanishingly" is not "never" — and
       * a unique violation surfacing as a 500 tells the operator nothing while
       * the number is the one thing they can quote. 409 with an Arabic message
       * is the honest answer to a number that is already taken.
       */
      if ((err as { code?: string }).code === '23505') {
        return fail(res, 409, 'رقم أمر الشراء مستخدم مسبقاً — أعد المحاولة');
      }
      /*
       * The remaining realistic FK on this insert is `branch_id`. A branch id
       * that does not exist is a client-side error, and a database FK violation
       * surfacing as an anonymous 500 would tell the operator nothing — so it
       * is answered as the validation failure it is.
       */
      if ((err as { code?: string }).code === '23503') {
        return fail(res, 400, 'بيانات أمر الشراء تحوي معرّفاً غير موجود — الفرع');
      }
      throw err;
    } finally {
      client.release();
    }

    res.status(201).json({
      item: {
        id,
        poNumber,
        supplierId,
        supplierName,
        items,
        totalAmount,
        status,
        orderDate,
      },
    });
  }));

  /*
   * ══ 6. PRODUCTS — CREATE ══════════════════════════════════════════════════
   * GET `/api/db/products` lives in `server.ts` and is untouched; this is the
   * missing write side.
   *
   * `barcode` is ALLOCATED when the client did not supply one: the client used
   * to emit `628` + 12 random digits, which do not satisfy the EAN-13 check
   * digit and therefore do not scan. `allocateBarcode` draws the serial from
   * the same counter as every other document number and computes the check
   * digit from the digits actually issued.
   *
   * Defaults mirror what the form already showed: an unpriced new product is
   * still a product, and an unclassified one is filed rather than rejected.
   */
  app.post('/api/db/products', attachPrincipal, asyncRoute(async (req, res) => {
    const tenant = tenantOf(req);
    const b = req.body || {};

    const name = String(b.name ?? '').trim();
    if (!name) return fail(res, 400, 'اسم المنتج مطلوب');

    /**
     * `null` marks "present but not a number" so it can be refused below.
     * An absent or empty field means "use the default" — a form that submits
     * an empty price box is the common case, not an attack.
     */
    const pick = (value: unknown, dflt: number): number | null => {
      if (value === undefined || value === null || value === '') return dflt;
      const n = Number(value);
      return Number.isFinite(n) ? n : null;
    };

    const price = pick(b.price, 0);
    const cost = pick(b.cost, 0);
    const stock = pick(b.stock, 0);
    const minStock = pick(b.minStock, 5);
    if (price === null || cost === null || stock === null || minStock === null) {
      return fail(res, 400, 'قيم رقمية غير صالحة في بيانات المنتج');
    }
    // `dypos.products` carries CHECK (unit_price >= 0) and CHECK (cost >= 0);
    // a negative value would surface as a 500 from the database instead of a
    // message the operator can act on, so it is refused here.
    if (price < 0 || cost < 0) return fail(res, 400, 'السعر والتكلفة لا يقبلان قيمة سالبة');

    const category = String(b.category ?? '').trim() || 'غير مصنّف';
    const unit = String(b.unit ?? '').trim() || 'حبة';
    const image = b.image === undefined || b.image === null || b.image === '' ? null : String(b.image);
    const branchId = b.branchId === undefined || b.branchId === null || b.branchId === ''
      ? null
      : String(b.branchId);

    // Client-supplied when non-empty, otherwise allocated from the shared
    // counter as an EAN-13. The client never invents one.
    let barcode = typeof b.barcode === 'string' ? b.barcode.trim() : '';
    if (!barcode) barcode = await allocateBarcode(tenant);

    const id = makeId('prd');
    await pool.query(
      `INSERT INTO dypos.products
         (id, tenant_id, name, category, barcode, unit_price, cost, stock, min_stock,
          unit, image_url, is_active)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, TRUE)`,
      [id, tenant, name, category, barcode, price, cost, stock, minStock, unit, image],
    );

    /*
     * The CLIENT shape, camelCase — the same shape GET `/api/db/products`
     * returns for these fields (its `unit_price AS price` alias). `branchId` is
     * echoed rather than stored: `dypos.products` has no branch column, and
     * inventing one would claim a scoping the table does not have.
     */
    res.status(201).json({
      item: {
        id,
        name,
        barcode,
        category,
        price,
        cost,
        stock,
        minStock,
        unit,
        image,
        branchId,
      },
    });
  }));
}
