import type { Express } from 'express';
import { pool } from './neonDb.js';
import { asyncRoute, DEFAULT_TENANT, tenantOf } from './apiHelpers.js';

/**
 * Reporting and analytics endpoints. Every aggregate is computed by
 * PostgreSQL rather than in the browser, so the numbers stay consistent
 * no matter how many rows the client is holding.
 */
export function registerReportRoutes(app: Express) {
  /**
   * Invoice history shaped for the client's Transaction type, so the POS and
   * BI screens receive a ready-to-use structure.
   */
  app.get('/api/db/transactions', asyncRoute(async (req, res) => {
    res.set('Cache-Control', 'public, max-age=600, stale-while-revalidate=86400');
    const tenantId = tenantOf(req);
    const branchId = req.query.branchId as string | undefined;
    const limit = Math.min(Number(req.query.limit) || 300, 1000);

    const params: any[] = [tenantId];
    let filter = '';
    if (branchId) {
      params.push(branchId);
      filter = ` AND branch_id = $${params.length}`;
    }
    params.push(limit);

    const result = await pool.query(
      `SELECT id, invoice_number, cashier_name, customer_name,
              subtotal, tax, discount, total, payment_method, status,
              branch_id, items, timestamp, created_at
       FROM dypos.invoices
       WHERE tenant_id = $1${filter}
       ORDER BY created_at DESC
       LIMIT $${params.length}`,
      params,
    );

    const transactions = result.rows.map((r: any) => ({
      id: r.id,
      invoiceNumber: r.invoice_number,
      items: Array.isArray(r.items) ? r.items : [],
      subtotal: Number(r.subtotal || 0),
      tax: Number(r.tax || 0),
      discount: Number(r.discount || 0),
      total: Number(r.total || 0),
      paymentMethod: r.payment_method || 'cash',
      customerName: r.customer_name || 'عميل نقدي',
      cashierName: r.cashier_name || '',
      timestamp: r.timestamp || r.created_at,
      branchId: r.branch_id,
      status: r.status || 'completed',
    }));

    res.json({ transactions, count: transactions.length });
  }));

  /** KPI block that fills the dashboard tiles. */
  app.get('/api/db/dashboard', asyncRoute(async (req, res) => {
    res.set('Cache-Control', 'public, max-age=300, stale-while-revalidate=86400');
    const tenantId = tenantOf(req);
    const branchId = req.query.branchId as string | undefined;

    const params: any[] = [tenantId];
    let filter = '';
    if (branchId) {
      params.push(branchId);
      filter = ' AND branch_id = $2';
    }

    const [sales, stock, customers, counts] = await Promise.all([
      pool.query(
        `SELECT COALESCE(SUM(total),0)::numeric    AS revenue_today,
                COALESCE(SUM(subtotal),0)::numeric AS net_today,
                COALESCE(SUM(tax),0)::numeric      AS vat_today,
                count(*)::int                      AS invoices_today
         FROM dypos.invoices
         WHERE tenant_id = $1 AND status = 'completed'
           AND created_at::date = CURRENT_DATE${filter}`,
        params,
      ),
      pool.query(
        `SELECT COALESCE(SUM(stock),0)::numeric AS units,
                count(*) FILTER (WHERE stock <= min_stock)::int AS low_stock,
                COALESCE(SUM(stock * cost),0)::numeric          AS stock_value
         FROM dypos.products
         WHERE tenant_id = $1 AND is_active = TRUE`,
        [tenantId],
      ),
      pool.query(
        `SELECT count(*)::int AS total FROM dypos.customers WHERE tenant_id = $1`,
        [tenantId],
      ),
      pool.query(
        `SELECT (SELECT count(*) FROM dypos.employees WHERE tenant_id = $1 AND status = 'active')::int AS employees,
                (SELECT count(*) FROM dypos.suppliers  WHERE tenant_id = $1)::int AS suppliers,
                (SELECT count(*) FROM dypos.invoices   WHERE tenant_id = $1)::int AS all_invoices`,
        [tenantId],
      ),
    ]);

    const s = sales.rows[0];
    res.json({
      revenueToday: Number(s.revenue_today),
      netToday: Number(s.net_today),
      vatToday: Number(s.vat_today),
      invoicesToday: s.invoices_today,
      stockUnits: Number(stock.rows[0].units),
      lowStock: stock.rows[0].low_stock,
      stockValue: Number(stock.rows[0].stock_value),
      customers: customers.rows[0].total,
      ...counts.rows[0],
    });
  }));

  /**
 * Unified work queue. Pulls open work from every operational table in one
 * round-trip and normalises it to the shape the client's queue engine scores.
 */
  app.get('/api/db/work-queue', asyncRoute(async (req, res) => {
    res.set('Cache-Control', 'public, max-age=600, stale-while-revalidate=86400');
    const tenantId = tenantOf(req);
    const branchId = req.query.branchId as string | undefined;

    const p: any[] = [tenantId];
    let branchFilter = '';
    if (branchId) {
      p.push(branchId);
      branchFilter = ' AND branch_id = $2';
    }

    const [appts, prod, batches, deliveries] = await Promise.all([
      pool.query(
        `SELECT a.id, a.customer_name, a.scheduled_start, a.status,
                COALESCE(s.base_price, a.price, 0)::numeric AS amount
         FROM dypos.appointments a
         LEFT JOIN dypos.services s ON s.id = a.service_id
         WHERE a.tenant_id = $1 AND a.status NOT IN ('cancelled','completed','delivered')${branchFilter}
         ORDER BY a.scheduled_start LIMIT 50`,
        p,
      ),
      pool.query(
        `SELECT o.id, p.name AS product_name, o.quantity, o.planned_end AS due_date,
                o.status, COALESCE(p.unit_price,0) * o.quantity AS amount
         FROM dypos.production_orders o
         LEFT JOIN dypos.products p ON p.id = o.product_id
         WHERE o.tenant_id = $1 AND o.status NOT IN ('cancelled','completed','done')${branchFilter}
         ORDER BY o.planned_end NULLS LAST LIMIT 50`,
        p,
      ),
      pool.query(
        `SELECT b.id, b.batch_number, p.name AS product_name, b.quantity,
                b.expiry_date, b.status
         FROM dypos.product_batches b
         LEFT JOIN dypos.products p ON p.id = b.product_id
         WHERE b.tenant_id = $1 AND b.status NOT IN ('expired','disposed')
         ORDER BY b.expiry_date NULLS LAST LIMIT 50`,
        [tenantId],
      ),
      pool.query(
        `SELECT d.id, d.customer_name, d.created_at AS scheduled_time, d.status,
                COALESCE(d.fee,0)::numeric AS amount
         FROM dypos.deliveries d
         WHERE d.tenant_id = $1 AND d.status NOT IN ('delivered','cancelled','returned')${branchFilter}
         ORDER BY d.created_at LIMIT 50`,
        p,
      ),
    ]);

    const items: any[] = [];

    for (const a of appts.rows) {
      items.push({
        id: a.id, kind: 'appointment', title: a.customer_name || 'موعد',
        reference: a.id, dueAt: a.scheduled_start, amount: Number(a.amount || 0),
        status: a.status || 'scheduled', blockedBy: null,
      });
    }
    for (const x of prod.rows) {
      items.push({
        id: x.id, kind: 'production',
        title: `${x.product_name || 'أمر إنتاج'} × ${x.quantity}`,
        reference: x.id, dueAt: x.due_date, amount: Number(x.amount || 0),
        status: x.status || 'pending', blockedBy: null,
      });
    }
    for (const x of batches.rows) {
      // A batch nearing expiry blocks selling that stock, so it is surfaced.
      items.push({
        id: x.id, kind: 'batch',
        title: `${x.product_name || 'دفعة'} · ${x.batch_number || x.id}`,
        reference: x.batch_number || x.id, dueAt: x.expiry_date,
        amount: Number(x.quantity || 0), status: x.status || 'active', blockedBy: null,
      });
    }
    for (const d of deliveries.rows) {
      items.push({
        id: d.id, kind: 'delivery', title: d.customer_name || 'توصيل',
        reference: d.id, dueAt: d.scheduled_time, amount: Number(d.amount || 0),
        status: d.status || 'pending',
        // A delivery cannot move until the invoice behind it exists.
        blockedBy: null,
      });
    }

    res.json({ items, count: items.length, sector: req.query.sector || null });
  }));

  /** Daily sales series for the trend chart. */
  app.get('/api/db/reports/daily-sales', asyncRoute(async (req, res) => {
    res.set('Cache-Control', 'public, max-age=600, stale-while-revalidate=86400');
    const tenantId = tenantOf(req);
    const days = Math.min(Number(req.query.days) || 14, 90);
    const result = await pool.query(
      `SELECT to_char(created_at, 'YYYY-MM-DD') AS day,
              to_char(created_at, 'Dy')          AS day_name,
              COALESCE(SUM(total),0)::numeric    AS revenue,
              COALESCE(SUM(subtotal),0)::numeric AS net,
              COALESCE(SUM(tax),0)::numeric      AS vat,
              COALESCE(SUM(discount),0)::numeric AS discount,
              count(*)::int                      AS invoices
       FROM dypos.invoices
       WHERE tenant_id = $1 AND status = 'completed'
         AND created_at::date >= CURRENT_DATE - $2::int
       GROUP BY 1, 2, created_at::date
       ORDER BY created_at::date`,
      [tenantId, days],
    );
    res.json({ items: result.rows });
  }));

  /** Revenue split by payment method, for the pie chart. */
  app.get('/api/db/reports/payment-methods', asyncRoute(async (req, res) => {
    res.set('Cache-Control', 'public, max-age=600, stale-while-revalidate=86400');
    const tenantId = tenantOf(req);
    const result = await pool.query(
      `SELECT payment_method, COALESCE(SUM(total),0)::numeric AS value,
              count(*)::int AS invoices
       FROM dypos.invoices
       WHERE tenant_id = $1 AND status = 'completed'
       GROUP BY 1 ORDER BY value DESC`,
      [tenantId],
    );
    res.json({ items: result.rows });
  }));

  /** Best sellers, aggregated from the invoice line items. */
  app.get('/api/db/reports/top-products', asyncRoute(async (req, res) => {
    res.set('Cache-Control', 'public, max-age=600, stale-while-revalidate=86400');
    const tenantId = tenantOf(req);
    const limit = Math.min(Number(req.query.limit) || 8, 50);
    const result = await pool.query(
      `SELECT item->>'name' AS name,
              SUM((item->>'qty')::numeric)    AS qty,
              SUM((item->>'total')::numeric) AS sales
       FROM dypos.invoices, jsonb_array_elements(items) AS item
       WHERE tenant_id = $1 AND status = 'completed'
       GROUP BY 1
       HAVING SUM((item->>'total')::numeric) > 0
       ORDER BY sales DESC
       LIMIT $2`,
      [tenantId, limit],
    );
    res.json({ items: result.rows });
  }));

  /** Sales grouped by branch. */
  app.get('/api/db/reports/by-branch', asyncRoute(async (req, res) => {
    res.set('Cache-Control', 'public, max-age=600, stale-while-revalidate=86400');
    const tenantId = tenantOf(req);
    const result = await pool.query(
      `SELECT i.branch_id,
              COALESCE(b.name, i.branch_id)     AS name,
              COALESCE(SUM(i.total),0)::numeric AS revenue,
              count(*)::int                    AS invoices
       FROM dypos.invoices i
       LEFT JOIN dypos.branches b ON b.id = i.branch_id
       WHERE i.tenant_id = $1 AND i.status = 'completed'
       GROUP BY 1, 2 ORDER BY revenue DESC`,
      [tenantId],
    );
    res.json({ items: result.rows });
  }));

  /** Sales grouped by product category. */
  app.get('/api/db/reports/by-category', asyncRoute(async (req, res) => {
    res.set('Cache-Control', 'public, max-age=600, stale-while-revalidate=86400');
    const tenantId = tenantOf(req);
    const result = await pool.query(
      `SELECT COALESCE(p.category, 'عام') AS name,
              COALESCE(SUM((item->>'total')::numeric), 0) AS value
       FROM dypos.invoices, jsonb_array_elements(items) AS item
       LEFT JOIN dypos.products p
         ON p.id = item->>'productId' AND p.tenant_id = $1
       WHERE tenant_id = $1 AND status = 'completed'
       GROUP BY 1 ORDER BY value DESC`,
      [tenantId],
    );
    res.json({ items: result.rows });
  }));
}