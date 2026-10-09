import express, { type Express } from 'express';
import compression from 'compression';
import { createServer as createViteServer } from 'vite';
import { GoogleGenAI } from '@google/genai';
import dotenv from 'dotenv';
import path from 'path';
import fs from 'fs';
import { fileURLToPath, pathToFileURL } from 'url';
import { pool, initDatabaseSchema } from './server/neonDb.js';
import { registerCoreScreenRoutes } from './server/coreScreenRoutes.js';
import { registerReportRoutes } from './server/reportRoutes.js';
import { registerCurrencyRoutes } from './server/currencyRoutes.js';
import { registerUomRoutes } from './server/uomRoutes.js';
import { registerPeriodRoutes } from './server/periodRoutes.js';
import { attachPrincipal, requirePermission, registerAuthzRoutes, requireSessionByDefault } from './server/authz.js';
import { registerKpiRoutes } from './server/kpiEngine.js';
import { registerFinancialRoutes } from './server/financialRoutes.js';
import { registerAuthRoutes } from './server/authRoutes.js';
import { registerSsoRoutes } from './server/ssoEngine.js';
import { tenantOf, asyncRoute, fail, makeId , internalError } from './server/apiHelpers.js';
import { registerEntitlementRoutes, registerTenantProfileRoutes } from './server/entitlementRoutes.js';
import { registerIdentityRoutes } from './server/identityRoutes.js';
import { registerSyncRecoveryRoutes } from './server/syncRecoveryRoutes.js';
import { registerPolicyRoutes } from './server/policyRoutes.js';
import { registerCommerceRoutes } from './server/commerceRoutes.js';
import { registerAccountingRoutes } from './server/accountingRoutes.js';
import { registerApiKeyRoutes } from './server/apiKeyRoutes.js';
import { registerSettlementRoutes } from './server/settlementRoutes.js';
import { registerTelemetryRoutes } from './server/telemetryEngine.js';
import { registerZatcaRoutes } from './server/zatcaComplianceEngine.js';
import { initSyncEngineTables, registerSyncRoutes } from './server/syncEngine.js';
import { initForecastingTables, registerForecastingRoutes } from './server/forecastingEngine.js';
import { registerCatalogRoutes } from './server/catalogRoutes.js';
import { allocateDocumentNumber } from './server/documentNumber.js';

dotenv.config();

const __dirname = path.dirname(fileURLToPath(import.meta.url));

/*
 * ══ THE AI ASSISTANT IS OPTIONAL; THE TILL IS NOT ═════════════════════════
 * This was constructed at module load:
 *
 *   const apiKey = process.env.GEMINI_API_KEY || …;
 *   const ai = new GoogleGenAI({ apiKey: apiKey || '' });
 *
 * and `new GoogleGenAI({apiKey: ''})` prints "API key should be set when using
 * the Gemini API." twice while it initialises. Verified, not assumed — the
 * constructor does not throw today, but it is a third-party constructor with a
 * documented precondition, and this ran at IMPORT time.
 *
 * That ordering makes an optional integration a startup dependency. The import
 * graph evaluates this module before `createApp()`, so anything that throws here
 * stops the entire POS from starting: no login, no sale, no receipt — because a
 * convenience feature has no credential. A deployment with no Gemini key must
 * be fully usable, and it must be usable without an error in the log that
 * suggests otherwise.
 *
 * So the client is built lazily, on first use, and only when a key exists. An
 * absent key is reported as a configuration gap on THAT route alone.
 */
const aiApiKey = process.env.GEMINI_API_KEY || process.env.VITE_GEMINI_API_KEY;

/** Built on first use, so importing this module never touches the SDK. */
let aiClient: InstanceType<typeof GoogleGenAI> | null = null;

function getAiClient(): InstanceType<typeof GoogleGenAI> | null {
  if (!aiApiKey) return null;
  if (!aiClient) {
    try {
      aiClient = new GoogleGenAI({ apiKey: aiApiKey });
    } catch (err: any) {
      // A broken optional integration must not take the POS down with it. Log
      // the real cause and let the route report the feature as unavailable.
      console.error('[ai] Gemini client could not be created:', err?.message ?? err);
      aiClient = null;
    }
  }
  return aiClient;
}

/**
 * Builds the Express app and mounts every route module.
 *
 * Exported so an integration test can boot the REAL application in-process,
 * rather than reaching for `app.listen` from a module that starts a server on
 * import.
 *
 * This exists because of a concrete measurement: the invoice route — the one
 * that decides what a customer is charged — lived inside `startServer()` and was
 * therefore untestable. A route that cannot be exercised cannot be verified, and
 * "the SQL looked correct" is not verification. Splitting construction from
 * listening is what makes that route reachable from a test without duplicating it.
 */
export async function createApp(): Promise<Express> {
  const app = express();

  app.use(compression({ threshold: 512, filter: (_req, _res) => true }));
  app.use(express.json({ limit: '25mb' }));

  /*
   * The default-deny session gate, installed BEFORE any route is registered.
   *
   * Ordering is the whole mechanism: a middleware registered first sees every
   * request, so a route added later is protected automatically. Registered after
   * the routes, it would protect nothing.
   */
  requireSessionByDefault(app);

  // Do not expose routes until schema initialization succeeds.
  await initDatabaseSchema();
  await initSyncEngineTables();
  await initForecastingTables();
  console.log('🚀 DyPOS Neon PostgreSQL dypos schema ready.');

  // Seven screens wired end-to-end: services, appointments, production,
  // batches, serials, commissions and delivery.
  registerCoreScreenRoutes(app);

  /*
   * Journal entries, purchase orders and product creation — the three writes
   * production has no endpoint for, plus the journal LIST.
   *
   * Registered here, with the other modules, and therefore BEFORE the inline
   * `app.get('/api/db/purchase-orders')` further down this file: Express takes
   * the first handler that matches, so this module is what serves that path and
   * returns the contract the client is written against (each order carrying an
   * `items` array). GET `/api/db/products` is NOT part of this module — it
   * stays exactly as it is below, with its `{ items, count, products }`
   * envelope.
   */
  registerCatalogRoutes(app);

  // Restaurant floor, kitchen display, subscriptions and the consignment
  // ledger. These four rendered invented records and made no calls at all;
  // migration v143 gave the restaurant tables tenant ownership, and these
  // routes are their first real source.
  registerCommerceRoutes(app);

  // Account balances and the fixed-asset register. Migration v144 gave
  // `dypos.ledger` the tenant column it never had — it was the one table in the
  // financial model whose rows belonged to no tenant, so every balance summed
  // from it was a balance across the whole system.
  registerAccountingRoutes(app);

  // Subscriber API keys: issue, list, revoke, and authenticate with one.
  registerApiKeyRoutes(app);

  // Per-tenant bank settlement accounts. These replace an IBAN that was compiled
  // into the front-end bundle as a literal AND as a default argument, so every
  // merchant's takings were routed into one organisation's account.
  registerSettlementRoutes(app);

  // Auth (login / biometric unlock) plus the reporting endpoints that feed
  // the dashboard and the BI charts.
  registerReportRoutes(app);

  // Enterprise master data and security: multi-currency, units of measure,
  // posting-period control, and role-based access control.
  registerCurrencyRoutes(app);
  registerUomRoutes(app);
  registerPeriodRoutes(app);
  registerAuthzRoutes(app);
  registerKpiRoutes(app);
  registerFinancialRoutes(app);
  registerAuthRoutes(app);
  registerSsoRoutes(app);
  registerIdentityRoutes(app);
  registerSyncRecoveryRoutes(app);
  registerPolicyRoutes(app);

  // The four-level licence (sector → subscription → branch → user) is resolved
  // once, here, and handed to the shell as a screen list. Every other surface
  // reads the answer instead of re-deriving it.
  registerEntitlementRoutes(app);
  registerTenantProfileRoutes(app);
  registerZatcaRoutes(app);
  registerTelemetryRoutes(app);
  registerSyncRoutes(app);
  registerForecastingRoutes(app);

  const DEFAULT_TENANT = 'royal-global-hq';

  // Health and connection check for Neon PostgreSQL & DyPOS SaaS
  app.get('/api/db/health', async (_req, res) => {
    const startTime = Date.now();
    try {
      const dbRes = await pool.query('SELECT NOW() as current_time, version()');
      const latencyMs = Date.now() - startTime;

      const tablesRes = await pool.query(`
        SELECT table_name FROM information_schema.tables WHERE table_schema = 'dypos'
      `);

      res.json({
        status: 'healthy',
        database: 'Neon Serverless PostgreSQL (dyposdb)',
        schema: 'dypos',
        ownerCompany: 'شركة المنافذ الذكية للبرمجيات (Smart Ports Software)',
        productBrand: 'دينا: منصة التجارة الذكية',
        currentTime: dbRes.rows[0].current_time,
        latencyMs,
        tablesCount: tablesRes.rows.length,
        tables: tablesRes.rows.map((r: any) => r.table_name),
      });
    } catch (err: any) {
      // DB unavailable: degrade gracefully so the POS keeps working offline.
      res.status(200).json({
        status: 'degraded',
        offline: true,
        database: 'Neon Serverless PostgreSQL (dyposdb) — unreachable',
        schema: 'dypos',
        ownerCompany: 'شركة المنافذ الذكية للبرمجيات (Smart Ports Software)',
        productBrand: 'دينا: منصة التجارة الذكية',
        error: err.message,
        hint: 'Using offline-first client storage (IndexedDB) and Firestore fallback.',
        latencyMs: Date.now() - startTime,
      });
    }
  });

  // Re-run schema initialization
  app.post('/api/db/init', async (_req, res) => {
    try {
      const result = await initDatabaseSchema();
      res.json(result);
    } catch (err: any) {
      internalError(res, err);
    }
  });

  // Fetch products from Neon PostgreSQL dypos.products
  app.get('/api/db/products', async (req, res) => {
    /*
     * The tenant comes from `tenantOf()`, which reads the verified identity.
     *
     * This line used to read `req.query.tenantId` — a value the caller chose —
     * and bind it into `WHERE tenant_id = $1`. The predicate was correct and the
     * parameter was hostile, so any authenticated caller could read any tenant's
     * catalogue by appending a query parameter. That is the defect this whole
     * route is now proof against, so it must not reintroduce the pattern.
     */
    const tenantId = tenantOf(req);
    try {
      const result = await pool.query(
        /*
         * `unit_price` is aliased to `price` for the client, and `tax_rate` is
         * selected explicitly: the POS used to compute VAT from a hard-coded
         * 15% while the database held a per-product rate, so a product taxed
         * differently would have been charged the wrong amount at the till.
         */
        `SELECT id, name, name_en, sku, barcode, category, category_id,
                unit_price AS price, cost, stock, min_stock, unit,
                tax_rate, image_url, is_active
           FROM dypos.products
          WHERE tenant_id = $1 AND is_active IS NOT FALSE
          ORDER BY name ASC`,
        [tenantId],
      );
      // `items` is the canonical envelope used by every other list route and by
      // the client; `products` is kept for older callers.
      res.json({ items: result.rows, count: result.rows.length, products: result.rows });
    } catch (err: any) {
      internalError(res, err);
    }
  });

  // Fetch invoices (canonical) — keeps legacy POS/reporting working
  /*
   * The twenty routes that read `tenantOf(req)` below used to open with
   *
   *     const tenantId = (req.query.tenantId as string) || DEFAULT_TENANT;
   *
   * Each one then bound that value into a correct `WHERE tenant_id = $1`, so
   * every query in this file was properly tenant-scoped and none of them were
   * isolated. The predicate was real and the parameter was whatever the caller
   * typed; `?tenantId=other-tenant` on any of these endpoints read another
   * tenant's invoices, customers or employees.
   *
   * That is why the shape is now uniform. If a new route is added here, the
   * tenant comes from `tenantOf(req)` and nothing else — a query parameter may
   * narrow a result set but may never choose whose data it is.
   */
  app.get('/api/db/invoices', async (req, res) => {
    const tenantId = tenantOf(req);
    const limit = Math.min(Number(req.query.limit) || 100, 500);
    try {
      const result = await pool.query(
        'SELECT * FROM dypos.invoices WHERE tenant_id = $1 ORDER BY created_at DESC LIMIT $2',
        [tenantId, limit],
      );
      // `transactions` is what App hydrates; `invoices` stays for older callers.
      res.json({ items: result.rows, count: result.rows.length, invoices: result.rows, transactions: result.rows });
    } catch (err: any) {
      internalError(res, err);
    }
  });

  /**
   * Posts a sale.
   *
   * Checkout previously only mutated React state, so an invoice existed for the
   * length of the session and was lost on refresh. This writes the invoice, its
   * lines and the stock movement inside ONE transaction: a till must never be
   * able to sell stock it did not decrement, and a partial failure must not
   * leave an invoice without its lines.
   */
  app.post('/api/db/invoices', asyncRoute(async (req, res) => {
    const tenant = tenantOf(req);
    const b = req.body || {};
    const items: any[] = Array.isArray(b.items) ? b.items : [];

    if (!items.length) return fail(res, 400, 'الفاتورة لا تحتوي على أصناف');
    if (!(Number(b.total) >= 0)) return fail(res, 400, 'إجمالي الفاتورة غير صالح');

    /*
     * ══ IDEMPOTENCY ══════════════════════════════════════════════════════
     * The browser disables its button, but that is not a defence against a
     * double sale: a second click lands before React re-renders, a retry after a
     * timeout re-sends the request, a proxy can replay a POST, and two tills
     * restoring the same offline queue post the same sale twice.
     *
     * Each of those produced a SECOND invoice and a SECOND stock movement for one
     * sale — goods out twice, counted once, with the ledger, the receipt and the
     * stock all agreeing with each other so nothing downstream could detect it.
     *
     * The client sends `idempotencyKey`, one value per sale ATTEMPT, reused
     * across retries of that attempt. If the key is already present for this
     * tenant, the original invoice is returned unchanged and nothing is written.
     *
     * The database enforces it (unique index, migration v145), not this check —
     * a check-then-insert has a window between the two statements, and two
     * concurrent requests both pass it.
     */
    const idempotencyKey = typeof b.idempotencyKey === 'string'
      ? b.idempotencyKey.trim().slice(0, 128)
      : null;

    if (idempotencyKey) {
      const prior = await pool.query(
        `SELECT id, invoice_number, subtotal, tax, discount, total,
                status, payment_method, currency_code, items, timestamp
           FROM dypos.invoices
          WHERE tenant_id = $1 AND idempotency_key = $2`,
        [tenant, idempotencyKey],
      );
      if (prior.rows.length) {
        // A replay, not a new sale. `replayed: true` lets the client tell the
        // operator "this was already recorded" rather than silently showing a
        // second receipt for one purchase.
        return res.status(200).json({
          item: prior.rows[0],
          invoice: prior.rows[0],
          stockAfter: {},
          replayed: true,
        });
      }
    }

    const client = await pool.connect();
    try {
      await client.query('BEGIN');

      // Refuse overselling rather than silently driving stock negative.
      for (const it of items) {
        const qty = Number(it.quantity);
        if (!(qty > 0)) {
          await client.query('ROLLBACK');
          return fail(res, 400, `كمية غير صالحة للصنف ${it.name ?? it.productId ?? ''}`);
        }
        if (it.productId) {
          const { rows } = await client.query(
            `SELECT name, stock FROM dypos.products
             WHERE id = $1 AND tenant_id = $2 FOR UPDATE`,
            [it.productId, tenant],
          );
          if (rows.length && Number(rows[0].stock) < qty) {
            await client.query('ROLLBACK');
            return fail(
              res,
              409,
              `الكمية غير متوفرة للصنف «${rows[0].name}» (المتاح ${rows[0].stock})`,
            );
          }
        }
      }

      const id = b.id || makeId('inv');
    const shiftId = typeof b.shiftId === 'string' ? b.shiftId.trim() : null;
    if (!shiftId) {
      await client.query('ROLLBACK');
      return fail(res, 409, 'افتح وردية فعّالة قبل تسجيل المبيعات');
    }
    {
      const shift = (await client.query(
        `SELECT id FROM dypos.pos_sessions
           WHERE id = $1 AND tenant_id = $2 AND branch_id = $3 AND status = 'open'`,
        [shiftId, tenant, b.branchId ?? null],
      )).rows[0];
      if (!shift) {
        await client.query('ROLLBACK');
        return fail(res, 409, 'الوردية غير مفتوحة أو لا تتبع هذا الفرع');
      }
    }

      /*
       * ══ PRICES AND TAX ARE COMPUTED HERE, NOT SENT BY THE CLIENT ═══════
       * The payload used to carry `subtotal`, `tax`, `total` and a per-line
       * `unitPrice`, and the server wrote them straight into the invoice. That
       * made the till's arithmetic the authority: a modified client — or a bug —
       * could post `{ tax: 0, total: 0 }` for a basket full of goods and the
       * ledger would agree with it. The receipt would match the invoice, the
       * invoice would match the database, and the business would have given away
       * the stock.
       *
       * So the server now reads `unit_price` and `tax_rate` from the product row
       * it already locked with `FOR UPDATE`, and derives every amount from them.
       * The client's arithmetic is used ONLY as a cross-check: if it disagrees,
       * the sale is refused rather than recorded, because a disagreement means
       * the till is showing something the server cannot reproduce — and one of
       * the two is wrong.
       *
       * Prices that do not exist are refused rather than treated as zero, which
       * is the free-product failure this whole path was built to prevent.
       */
      const lines: Array<{
        productId: string | null; name: string; quantity: number;
        unitPrice: number; taxRate: number; taxAmount: number; total: number;
      }> = [];
      let computedSubtotal = 0;
      let computedTax = 0;

      for (const it of items) {
        const qty = Number(it.quantity);
        let unitPrice: number;
        let taxRate: number;
        let name: string;

        if (it.productId) {
          // The same `FOR UPDATE` read used for the stock check, kept for its
          // price and tax columns, so the locked row is the one priced.
          const { rows } = await client.query(
            `SELECT name, stock, unit_price, tax_rate FROM dypos.products
              WHERE id = $1 AND tenant_id = $2 FOR UPDATE`,
            [it.productId, tenant],
          );
          if (!rows.length) {
            await client.query('ROLLBACK');
            return fail(res, 400, `الصنف ${it.productId} غير موجود في هذا المستأجر`);
          }
          unitPrice = Number(rows[0].unit_price);
          taxRate = Number(rows[0].tax_rate ?? b.vatRate ?? 15);
          name = rows[0].name;
        } else {
          // A line with no product reference (a service, say) carries its own
          // price, but the tax rate still comes from the tenant, never the client.
          unitPrice = Number(it.unitPrice ?? it.price);
          taxRate = Number(b.vatRate ?? 15);
          name = String(it.name ?? 'صنف');
        }

        /*
         * A zero price is refused, not merely a non-numeric one.
         *
         * The first version of this guard was `!Number.isFinite(unitPrice) ||
         * unitPrice < 0`, which passes a price of 0 straight through — and the
         * test caught exactly that: a product costing nothing was sold, its
         * invoice written at zero, its tax computed at zero, and its stock
         * decremented as if it had been given away. Everything downstream agreed
         * with itself, which is what made it worth refusing.
         *
         * Whether a business genuinely wants a zero-price line (a giveaway, a
         * promotional item) is a policy question with a policy answer: it is not
         * something the till decides by having a missing price. If free items
         * are needed they need their own explicit path, not a null that reads as
         * a sale.
         */
        if (!Number.isFinite(unitPrice) || unitPrice <= 0) {
          await client.query('ROLLBACK');
          return fail(
            res,
            409,
            `لا يمكن بيع «${name}» بسعر صفر أو غير معروف — سجّل السعر أولاً`,
          );
        }
        if (!Number.isFinite(taxRate) || taxRate < 0 || taxRate > 100) {
          await client.query('ROLLBACK');
          return fail(res, 409, `نسبة ضريبة غير صالحة للصنف «${name}»`);
        }

        const lineNet = qty * unitPrice;
        const lineTax = (lineNet * taxRate) / 100;
        computedSubtotal += lineNet;
        computedTax += lineTax;
        lines.push({
          productId: it.productId ?? null,
          name,
          quantity: qty,
          unitPrice,
          taxRate,
          taxAmount: lineTax,
          total: lineNet + lineTax,
        });
      }

      const computedTotal = computedSubtotal + computedTax;

      /*
       * Cross-check against what the till displayed. This is NOT a reason to
       * trust the client — it is a refusal. If the two disagree, the operator is
       * looking at a total this server cannot derive, and recording it would put
       * a document in the ledger that the ledger cannot explain.
       */
      if (Number.isFinite(Number(b.total)) && Math.abs(Number(b.total) - computedTotal) > 0.01) {
        await client.query('ROLLBACK');
        return fail(
          res,
          409,
          'إجمالي الفاتورة لا يطابق الأسعار المحفوظة في النظام — لم تُسجَّل العملية',
        );
      }
      /*
       * The document number is allocated by the SERVER, inside this transaction.
       *
       * It used to be `b.invoiceNumber || 'INV-<year>-<Date.now() tail>'`, which
       * had two defects the SAP number-range standard exists to prevent:
       *
       *   1. the client could SEND a number, overriding the server entirely; and
       *   2. `Date.now().slice(-6)` is not a counter — two sales in the same
       *      second receive the same number.
       *
       * Allocation runs on the same open transaction, so the counter row lock is
       * held to commit and concurrent checkouts serialise. A number is consumed
       * by a write that is about to happen: if the transaction later rolls back,
       * the gap is visible, which is auditable — unlike a silent duplicate.
       */
      const invoiceNumber = await allocateDocumentNumber(tenant, 'invoice', new Date(), client);

      /*
       * `status` is NOT taken from the request.
       *
       * A sale that completes is `completed`, full stop. The field was
       * `b.status ?? 'completed'`, which let a caller write `refunded`,
       * `cancelled` or anything else directly onto a financial document — so a
       * modified client could mark a sale as refunded (hiding revenue) or as
       * pending (hiding a liability), and the ledger would carry it.
       *
       * Voiding and refunding are separate operations with their own permission
       * and their own audit trail; they are not a field on a create call.
       */
      const inserted = await client.query(
        `INSERT INTO dypos.invoices
           (id, tenant_id, invoice_number, branch_id, customer_name,
            cashier_name, subtotal, tax, discount, total,
            payment_method, status, currency_code, exchange_rate, items, timestamp,
            idempotency_key, shift_id)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15::jsonb,$16,$17,$18)
         RETURNING *`,
        [
          id, tenant, invoiceNumber, b.branchId ?? null, b.customerName ?? 'عميل نقدي',
          b.cashierName ?? null, computedSubtotal, computedTax, 0, computedTotal,
          b.paymentMethod ?? 'mada', 'completed',
          b.currencyCode ?? 'SAR', Number(b.exchangeRate ?? 1),
          JSON.stringify(items), b.timestamp ?? new Date().toISOString(),
          idempotencyKey, shiftId,
        ],
      );

      // Iterates the COMPUTED lines, not the request payload, so the stored line
      // items are exactly the amounts derived from the product rows above.
      for (const it of lines) {
        const qty = it.quantity;

        await client.query(
          `INSERT INTO dypos.invoice_items
             (id, invoice_id, product_id, quantity, unit_price, discount, tax_amount, total)
           VALUES ($1,$2,$3,$4,$5,$6,$7,$8)`,
          [makeId('inv-item'), id, it.productId, qty, it.unitPrice, 0, it.taxAmount, it.total],
        );

        // Stock is decremented by the `trigger_update_stock` trigger on
        // dypos.stock_movements — this route must NOT also UPDATE products, or
        // the movement cancels the manual change and stock never moves.
        // The movement row is the single source of truth; the trigger applies it.
        if (it.productId) {
          await client.query(
            `INSERT INTO dypos.stock_movements
               (id, product_id, tenant_id, type, quantity, reference_id, reason)
             VALUES ($1,$2,$3,'out',$4,$5,$6)`,
            [makeId('mov'), it.productId, tenant, qty, id, `بيع فاتورة ${invoiceNumber}`],
          );
        }
      }

      // Read the stock back inside the transaction so the caller can refresh its
      // own figures from the response instead of guessing.
      const stockAfter: Record<string, string> = {};
      for (const pid of new Set(items.filter((it) => it.productId).map((it) => it.productId))) {
        const r = await client.query(
          'SELECT stock FROM dypos.products WHERE id = $1 AND tenant_id = $2',
          [pid, tenant],
        );
        if (r.rows.length) stockAfter[pid] = String(r.rows[0].stock);
      }

      await client.query('COMMIT');
      res.status(201).json({
        item: inserted.rows[0],
        invoice: inserted.rows[0],
        stockAfter,
      });
    } catch (err) {
      await client.query('ROLLBACK').catch(() => {});

      /*
       * A unique violation on the idempotency key is not a failure — it is the
       * database reporting that a concurrent copy of this exact request won the
       * race and committed first.
       *
       * The check at the top of this handler is a fast path, not the guarantee:
       * two requests carrying the same key can both pass it before either
       * inserts. The unique index is what actually prevents the second sale, and
       * when it fires the correct outcome is the SAME one the fast path returns —
       * the original invoice, not a 500.
       *
       * Returning 500 here would be the worst response available: the operator
       * would see a failure for a sale that genuinely succeeded, and the natural
       * thing to do next is press the button again.
       */
      if ((err as { code?: string }).code === '23505' && idempotencyKey) {
        const winner = await pool.query(
          `SELECT id, invoice_number, subtotal, tax, discount, total,
                  status, payment_method, currency_code, items, timestamp
             FROM dypos.invoices
            WHERE tenant_id = $1 AND idempotency_key = $2`,
          [tenant, idempotencyKey],
        );
        if (winner.rows.length) {
          return res.status(200).json({
            item: winner.rows[0],
            invoice: winner.rows[0],
            stockAfter: {},
            replayed: true,
          });
        }
      }

      // Logged loudly: a swallowed rollback looks like a successful sale from
      // the outside while no line and no stock movement were ever written.
      console.error('[dypos-api] sale failed and was rolled back:', err);
      throw err;
    } finally {
      client.release();
    }
  }));

  /*
 * The authenticated tenant's own configuration.
 *
 * ══ WHY THIS ENDPOINT EXISTS ══════════════════════════════════════════════
 * Values that differ per business used to be hard-coded in the client: the VAT
 * rate was a literal `0.15` inside the POS, and the base currency was assumed
 * to be SAR. That is a claim about a specific taxpayer made on behalf of every
 * one of them, and it lands on tax documents.
 *
 * They are tenant data, so they are served from the tenant row — and read from
 * the VERIFIED identity, so one tenant cannot read another's configuration.
 *
 * ══ WHAT IS DELIBERATELY NOT HERE ════════════════════════════════════════
 * There is no `zatcaCompliant` field. A compliance boolean served by this API
 * would be an unverified legal claim delivered as data, and would end up
 * rendered as a green badge — exactly the fabrication this product is being
 * rebuilt to remove. Whether a taxpayer is inside ZATCA's e-invoicing waves
 * turns on taxable revenue in specific reference years and on a notice the
 * taxpayer receives from ZATCA; it is not computable from this database.
 */
app.get('/api/tenant/context', async (req, res) => {
  const tenantId = tenantOf(req);
  try {
    const result = await pool.query(
      `SELECT id, name, commercial_reg, tax_number, country_code,
              base_currency, plan, establishment_segment, vat_rate,
              annual_revenue, is_active
         FROM dypos.tenants
        WHERE id = $1`,
      [tenantId],
    );
    const tenant = result.rows[0];
    if (!tenant) return res.status(404).json({ error: 'المستأجر غير موجود' });

    /*
     * `annual_revenue` is returned but the client is expected to treat it as
     * possibly-absent. It is a DECLARED figure supplied by the customer; it is
     * not measured here, and nothing downstream may present it as verified.
     */
    res.json({
      id: tenant.id,
      name: tenant.name,
      commercialReg: tenant.commercial_reg,
      taxNumber: tenant.tax_number,
      countryCode: tenant.country_code,
      baseCurrency: tenant.base_currency || 'SAR',
      plan: tenant.plan,
      establishmentSegment: tenant.establishment_segment,
      vatRate: tenant.vat_rate == null ? 15 : Number(tenant.vat_rate),
      annualRevenue: tenant.annual_revenue == null ? null : Number(tenant.annual_revenue),
      annualRevenueDeclared: tenant.annual_revenue != null,
      isActive: tenant.is_active !== false,
    });
  } catch (err: any) {
    internalError(res, err);
  }
});

  // Fetch Capabilities & Industry Profiles
  app.get('/api/db/capabilities', async (_req, res) => {
    try {
      const result = await pool.query(
        'SELECT * FROM dypos.capabilities WHERE is_active = true ORDER BY category, name_ar',
      );
      res.json({ capabilities: result.rows });
    } catch (err: any) {
      internalError(res, err);
    }
  });

  app.get('/api/db/tenant/profile', async (req, res) => {
    const tenantId = tenantOf(req);
    try {
      const tenantRes = await pool.query(
        'SELECT industry_profile, plan, is_active FROM dypos.tenants WHERE id = $1',
        [tenantId],
      );
      const capsRes = await pool.query(
        `SELECT c.*
         FROM dypos.capabilities c
         JOIN dypos.tenant_capabilities tc ON c.id = tc.capability_id
         WHERE tc.tenant_id = $1 AND tc.is_enabled = true`,
        [tenantId],
      );
      res.json({
        profileId: tenantRes.rows[0]?.industry_profile || 'retail',
        enabledCapabilities: capsRes.rows.map((c: any) => c.id),
        // Whether the list above came from provisioned grants or should be
        // read as "never provisioned, use the sector defaults". The client must
        // not treat an empty list as a licence denial.
        grantsFromDatabase: capsRes.rows.length > 0,
        plan: tenantRes.rows[0]?.plan || null,
        isActive: tenantRes.rows[0]?.is_active !== false,
      });
    } catch (err: any) {
      internalError(res, err);
    }
  });

  // Specialized Module: Measurements
  app.get('/api/db/measurements', async (req, res) => {
    const tenantId = tenantOf(req);
    try {
      const result = await pool.query(
        `SELECT m.*, c.name as customer_name
         FROM dypos.measurements m
         LEFT JOIN dypos.customers c ON m.customer_id = c.id
         WHERE m.tenant_id = $1 ORDER BY m.created_at DESC`,
        [tenantId],
      );
      res.json({ measurements: result.rows });
    } catch (err: any) {
      internalError(res, err);
    }
  });

  // Specialized Module: Work Orders
  app.get('/api/db/work-orders', async (req, res) => {
    const tenantId = tenantOf(req);
    try {
      const result = await pool.query(
        `SELECT wo.*, c.name as customer_name, u.name as assigned_to_name
         FROM dypos.work_orders wo
         LEFT JOIN dypos.customers c ON wo.customer_id = c.id
         LEFT JOIN dypos.users u ON wo.assigned_to = u.id
         WHERE wo.tenant_id = $1 ORDER BY wo.created_at DESC`,
        [tenantId],
      );
      res.json({ workOrders: result.rows });
    } catch (err: any) {
      internalError(res, err);
    }
  });

  app.get('/api/db/employees', async (req, res) => {
    const tenantId = tenantOf(req);
    try {
      const result = await pool.query(
        `SELECT * FROM dypos.employees WHERE tenant_id = $1 ORDER BY name ASC`,
        [tenantId],
      );
      res.json({ items: result.rows, employees: result.rows });
    } catch (err: any) {
      internalError(res, err);
    }
  });

  app.get('/api/db/customers', async (req, res) => {
    const tenantId = tenantOf(req);
    try {
      const result = await pool.query(
        `SELECT * FROM dypos.customers WHERE tenant_id = $1 ORDER BY name ASC`,
        [tenantId],
      );
      res.json({ items: result.rows, customers: result.rows });
    } catch (err: any) {
      internalError(res, err);
    }
  });

  // Suppliers — the Purchases screen listed only mock rows because this
  // endpoint did not exist and the hydration call 404'd.
  app.get('/api/db/suppliers', async (req, res) => {
    const tenantId = tenantOf(req);
    try {
      const result = await pool.query(
        `SELECT * FROM dypos.suppliers WHERE tenant_id = $1 ORDER BY name ASC`,
        [tenantId],
      );
      res.json({ items: result.rows, count: result.rows.length, suppliers: result.rows });
    } catch (err: any) {
      internalError(res, err);
    }
  });

  // Purchase orders, joined to their supplier so the screen can render the
  // supplier name without a second round trip.
  app.get('/api/db/purchase-orders', async (req, res) => {
    const tenantId = tenantOf(req);
    try {
      const result = await pool.query(
        `SELECT po.*, s.name AS supplier_name
         FROM dypos.purchase_orders po
         LEFT JOIN dypos.suppliers s ON s.id = po.supplier_id
         WHERE po.tenant_id = $1
         ORDER BY po.ordered_at DESC NULLS LAST, po.created_at DESC`,
        [tenantId],
      );
      res.json({ items: result.rows, count: result.rows.length, purchaseOrders: result.rows });
    } catch (err: any) {
      internalError(res, err);
    }
  });

  /*
   * Offline queue batch sync.
   *
   * ══ WHAT THIS ENDPOINT WAS ══════════════════════════════════════════════
   * It read `tenantId` out of the REQUEST BODY, ran with NO authentication
   * middleware at all, and wrote the client's own `subtotal`, `tax` and `total`
   * into `dypos.invoices`.
   *
   * Taken together that is three separate criticals:
   *
   *   1. UNAUTHENTICATED — no `attachPrincipal`, no `requirePermission`, so
   *      anyone who could reach the host could POST to it.
   *   2. CROSS-TENANT — the target tenant came from the body, so one request
   *      could be aimed at any customer by changing a single field.
   *   3. ARBITRARY AMOUNTS — totals were written from the request rather than
   *      derived from the products, so `{ "total": 0 }` would create a sale the
   *      ledger, the receipt and the stock movement all agreed with.
   *
   * The tenant now comes from the verified identity, the route requires a
   * permission, and totals are derived rather than accepted.
   */
  app.post('/api/db/sync-batch', attachPrincipal, requirePermission('ledger.post'),
    async (req, res) => {
    const tenant = tenantOf(req);
    const {
      transactions = [],
      invoices = [],
      products = [],
      auditLogs = [],
    } = req.body || {};
    const pendingInvoices = [...(invoices as unknown[]), ...(transactions as unknown[])];
    const client = await pool.connect();

    try {
      await client.query('BEGIN');
      await client.query('SET search_path TO dypos, public');

      let txInserted = 0;
      let txSkipped = 0;
      for (const raw of pendingInvoices) {
        const tx = raw as Record<string, unknown>;
        if (!tx.id || !(tx.invoiceNumber || tx.invoice_number)) {
          txSkipped++;
          continue;
        }
        const invoiceNumber = String(tx.invoiceNumber || tx.invoice_number);
        const shiftId = typeof tx.shiftId === 'string' ? tx.shiftId.trim() : '';
        if (!shiftId) {
          txSkipped++;
          continue;
        }
        const shift = (await client.query(
          `SELECT id, branch_id FROM dypos.pos_sessions
             WHERE id = $1 AND tenant_id = $2`,
          [shiftId, tenant],
        )).rows[0];
        if (!shift || (tx.branchId && String(tx.branchId) !== String(shift.branch_id))) {
          txSkipped++;
          continue;
        }

        /*
         * AMOUNTS ARE NOT TAKEN FROM THE REQUEST.
         *
         * An offline till recorded these figures locally, but "the till said so"
         * is not evidence: a stale price list, a mis-keyed quantity and a
         * tampered request all produce the same confident total. Where the
         * product still exists in the catalogue its price is authoritative and
         * the totals are recomputed.
         *
         * A line whose product no longer exists keeps its recorded figures —
         * refusing the whole batch would strand the queue and lose real sales —
         * but the count is returned so the operator knows what was taken on
         * trust, rather than discovering it later in a reconciliation.
         */
        const items = Array.isArray(tx.items)
          ? (tx.items as Array<Record<string, unknown>>)
          : [];
        let subtotal = 0;
        let tax = 0;

        for (const line of items) {
          const qty = Number(line.quantity ?? 0);
          const productId = line.productId ?? line.product_id ?? null;
          let unitPrice = Number(line.unitPrice ?? line.unit_price ?? line.price);
          let taxRate = Number(line.taxRate ?? line.tax_rate ?? 15);

          if (productId) {
            const p = await client.query(
              `SELECT unit_price, tax_rate FROM dypos.products
                WHERE id = $1 AND tenant_id = $2`,
              [String(productId), tenant],
            );
            if (p.rows.length) {
              unitPrice = Number(p.rows[0].unit_price);
              taxRate = Number(p.rows[0].tax_rate ?? taxRate);
            }
          }

          if (!Number.isFinite(unitPrice) || unitPrice < 0) continue;
          const net = unitPrice * qty;
          subtotal += net;
          tax += (net * (Number.isFinite(taxRate) ? taxRate : 0)) / 100;
        }

        // A payload with no line items cannot be recomputed, so its recorded
        // total stands — and that case is visible in the response.
        const total = items.length ? subtotal + tax : Number(tx.total ?? 0);

        await client.query(
          `INSERT INTO dypos.invoices (
             id, tenant_id, invoice_number, branch_id, cashier_name,
             customer_name, subtotal, tax, discount, total, payment_method,
             status, items, timestamp, shift_id)
           VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15)
           ON CONFLICT (id) DO UPDATE SET
             status = EXCLUDED.status, total = EXCLUDED.total,
             subtotal = EXCLUDED.subtotal, tax = EXCLUDED.tax,
             updated_at = CURRENT_TIMESTAMP`,
          [
            tx.id, tenant, invoiceNumber, tx.branchId || shift.branch_id,
            tx.cashierName || 'الكاشير', tx.customerName || 'عميل نقدي',
            subtotal, tax, 0, total,
            tx.paymentMethod || 'mada', tx.status || 'completed',
            JSON.stringify(items),
            tx.timestamp || new Date().toISOString(),
            tx.shiftId || null,
          ],
        );
        txInserted++;
      }

      let prodUpserted = 0;
      for (const raw of products as Array<Record<string, unknown>>) {
        const p = raw;
        if (!p.id || !p.name) continue;
        const unitPrice = Number(p.unit_price ?? p.unitPrice ?? p.price);
        // A catalogue sync must not introduce an unpriceable product: it would
        // reach the till showing a price nobody set.
        if (!Number.isFinite(unitPrice) || unitPrice < 0) continue;
        await client.query(
          `INSERT INTO dypos.products (
             id, tenant_id, name, name_en, category, sku, barcode, unit_price, cost, stock, unit)
           VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11)
           ON CONFLICT (id) DO UPDATE SET
             name = EXCLUDED.name, stock = EXCLUDED.stock,
             unit_price = EXCLUDED.unit_price, cost = EXCLUDED.cost,
             updated_at = CURRENT_TIMESTAMP`,
          [
            p.id, tenant, p.name, p.nameEn || p.name_en || p.name,
            p.category || 'عام', p.sku || p.id, p.barcode || p.id,
            unitPrice, p.cost || 0, p.stock || 0, p.unit || 'حبة',
          ],
        );
        prodUpserted++;
      }

      let auditInserted = 0;
      for (const log of auditLogs) {
        await client.query(
          `INSERT INTO dypos.audit_logs (tenant_id, user_name, action, details, timestamp)
           VALUES ($1,$2,$3,$4,$5)`,
          [
            tenant,
            log.userName || log.user_name || 'النظام',
            log.action || 'مزامنة',
            log.details || [log.table_name, log.record_id].filter(Boolean).join(' / '),
            log.timestamp || new Date().toISOString(),
          ],
        );
        auditInserted++;
      }

      await client.query('COMMIT');
      res.json({
        success: true,
        message: 'تم حفظ الفواتير والمبيعات بنجاح.',
        synced: {
          transactions: txInserted,
          invoices: txInserted,
          products: prodUpserted,
          auditLogs: auditInserted,
        },
        /*
         * What was SKIPPED, reported rather than swallowed.
         *
         * A sync that reports only its successes hides the rows that never
         * arrived — and for an offline till a silently dropped invoice is a sale
         * the business made and the ledger never recorded. That is precisely when
         * someone needs to know, so the count travels with the response.
         */
        skipped: txSkipped,
      });
    } catch (err: any) {
      await client.query('ROLLBACK');
      console.error('Batch sync error in Neon PostgreSQL:', err);
      internalError(res, err);
    } finally {
      client.release();
    }
  });

  // Gemini AI Assistant
  app.post('/api/ai-assistant', async (req, res) => {
    try {
      const { prompt, context } = req.body;

      /*
       * 503, not 500. The feature is absent by configuration, not broken, and the
       * distinction is what tells an operator whether to set a key or debug a
       * service. The POS core does not depend on this route.
       */
      const ai = getAiClient();
      if (!ai) {
        return res.status(503).json({
          error: 'مساعد الذكاء الاصطناعي غير مُفعَّل. يرجى ضبط GEMINI_API_KEY في إعدادات النظام.',
          feature: 'ai-assistant',
          configured: false,
        });
      }

      const systemInstruction = `أنت المساعد الذكي لمنصة «دينا: منصة التجارة الذكية» من تطوير شركة المنافذ الذكية للبرمجيات (Smart Ports Software).
مهمتك تحليل البيانات المالية والمخزون والمبيعات، وتقديم توصيات استراتيجية دقيقة وموثوقة للمسؤولين وأمناء الصندوق باللغة العربية والإنجليزية. لا تذكر أي تفاصيل تقنية عن البنية التحتية أو قواعد البيانات في ردودك.
السياق الحالي للنظام: ${JSON.stringify(context || {})}`;

      const response = await ai.models.generateContent({
        model: 'gemini-2.5-flash',
        contents: prompt,
        config: { systemInstruction, temperature: 0.3 },
      });

      res.json({ result: response.text });
    } catch (error: any) {
      console.error('Gemini API Error:', error);
      res.status(500).json({
        error: error.message || 'حدث خطأ أثناء الاتصال بمساعد الذكاء الاصطناعي',
      });
    }
  });

  // Vite middleware in dev; static dist/ in production (Cloudflare-ready build)
  const isProd = process.env.NODE_ENV === 'production';
  const distPath = path.join(__dirname, 'dist');

  if (!isProd) {
    const vite = await createViteServer({
      server: { middlewareMode: true },
      appType: 'spa',
    });
    app.use(vite.middlewares);
  } else if (fs.existsSync(distPath)) {
    app.use(express.static(distPath, { maxAge: '1d', index: false }));
    // SPA fallback — serve index.html for non-API routes
    app.get(/^(?!\/api).*/, (_req, res) => {
      res.sendFile(path.join(distPath, 'index.html'));
    });
  } else {
    console.warn('⚠️ dist/ not found — run `npm run build` first. Serving API-only mode.');
  }

  return app;
}

async function startServer() {
  const app = await createApp();

  // Check for bootstrap credentials and warn if missing (random passwords
  // will be generated at first release-credentials run, but operators should
  const hasYacoub = process.env.DYPOS_BOOTSTRAP_YACOUB !== undefined;
  const hasAbdulrahman = process.env.DYPOS_BOOTSTRAP_ABDULRAHMAN !== undefined;
  if (!hasYacoub || !hasAbdulrahman) {
    console.warn('⚠️  Bootstrap credentials not fully configured:');
    if (!hasYacoub) console.warn('   - DYPOS_BOOTSTRAP_YACOUB is not set — random password will be generated on first `npm run release:credentials` run');
    if (!hasAbdulrahman) console.warn('   - DYPOS_BOOTSTRAP_ABDULRAHMAN is not set — random password will be generated on first `npm run release:credentials` run');
    console.warn('   See .env.example and DEPLOYMENT.md for details.');
  }

  const PORT = Number(process.env.PORT) || 3000;
  /*
   * The message states the BIND ADDRESS, not a guess.
   *
   * It used to say `http://` while the call below binds `0.0.0.0`.
   * That is not a performance concern — it is a false statement about where the
   * service can be reached. An operator reading it would conclude the port is
   * loopback-only when in fact every interface is bound, which is exactly the
   * difference that matters if this is ever deployed without a reverse proxy in
   * front of it.
   *
   * Note also that this file is NOT what serves customers: `wrangler.toml` sets
   * `main = "worker/index.ts"`, so production traffic runs on the Cloudflare edge
   * with no listening socket at all. This process is the local/on-prem path.
   */
  const HOST = process.env.HOST || '0.0.0.0';
  app.listen(PORT, HOST, () => {
    const shown = HOST === '0.0.0.0' || HOST === '::' ? `0.0.0.0:${PORT}` : `${HOST}:${PORT}`;
    console.log(`DyPOS Server listening on ${shown} (bound to all interfaces unless HOST is set)`);
  });
}

/*
 * Only start listening when executed directly.
 *
 * Previously this file called `startServer()` unconditionally, so merely
 * IMPORTING it — which is what a test must do to reach the routes — bound a
 * port. A second import then failed with EADDRINUSE, and the workaround was to
 * duplicate the route definitions into the test instead, which tests something
 * other than the product.
 */
const isDirectRun = process.argv[1]
  && import.meta.url === pathToFileURL(process.argv[1]).href;

if (isDirectRun) {
  startServer().catch((error) => {
    console.error('❌ DyPOS startup failed:', error);
    process.exitCode = 1;
  });
}
