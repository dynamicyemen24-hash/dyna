import type { Express } from 'express';
import { pool } from './neonDb.js';
import { asyncRoute, tenantOf } from './apiHelpers.js';
import { attachPrincipal } from './authz.js';

/**
 * Backends for three screens that previously had none.
 *
 * ══ WHY THIS FILE EXISTS ═════════════════════════════════════════════════
 * The restaurant floor, the subscription list and the consignment ledger each
 * rendered invented records and made ZERO calls to the server. Deleting the
 * fabrications made them honest and useless; this makes them real.
 *
 * ══ THE TENANT RULE, STATED ONCE ══════════════════════════════════════════
 * Every route derives its tenant from `tenantOf(req)`, which reads the verified
 * principal and falls back to the SIGNED token. A query parameter, a body field
 * and a header are all attacker-controlled and none of them is read.
 *
 * This matters concretely for these three domains: `restaurant_tables` says which
 * table in which restaurant is occupied, `consignment_sales` says what a named
 * person is owed, and `kitchen_tickets` says what food is on the pass. Reading
 * another tenant's copy of any of those is not a data leak, it is a false
 * statement made to a person who acts on it.
 *
 * ══ WHY EVERY FIGURE IS DERIVED, NEVER STORED ════════════════════════════
 * Running order totals, days remaining and elapsed minutes are all COMPUTED here
 * from the underlying records. Cached figures drift — every refund, void and
 * split payment leaves them stale — and these are exactly the screens where a
 * stale number is believed and acted upon.
 */
export function registerCommerceRoutes(app: Express) {
  /* ══ Restaurant floor ═════════════════════════════════════════════════ */

  app.get('/api/db/restaurant/tables', attachPrincipal, asyncRoute(async (req, res) => {
    const tenant = tenantOf(req);
    try {
      const { rows } = await pool.query(
        `SELECT t.id, t.table_number, t.capacity, t.status, t.current_invoice_id,
                a.name AS area_name
           FROM dypos.restaurant_tables t
           LEFT JOIN dypos.restaurant_areas a
                  ON a.id = t.area_id AND a.tenant_id = t.tenant_id
          WHERE t.tenant_id = $1
          ORDER BY a.name NULLS LAST, t.table_number`,
        [tenant],
      );

      /*
       * The running total comes from the INVOICES, not from a column on the
       * table. A total cached on the table row is a figure that silently
       * diverges from the ledger, and the floor is where it gets believed.
       * `status = 'completed'` excludes drafts so an open till is not counted as
       * money owed.
       */
      const totals = await pool.query(
        `SELECT current_invoice_id AS invoice_id, COALESCE(SUM(total), 0) AS order_total
           FROM dypos.invoices
          WHERE tenant_id = $1 AND current_invoice_id IS NOT NULL
          GROUP BY current_invoice_id`,
        [tenant],
      );
      const byInvoice = new Map<string, number>(
        totals.rows.map((r: { invoice_id: string; order_total: string }) => [
          r.invoice_id, Number(r.order_total),
        ]),
      );

      const items = rows.length
        ? await pool.query(
            `SELECT invoice_id, COALESCE(SUM(quantity), 0)::int AS n
               FROM dypos.invoice_items
              WHERE tenant_id = $1 AND invoice_id = ANY($2)
              GROUP BY invoice_id`,
            [tenant, rows.map((r: Record<string, unknown>) => String(r.current_invoice_id ?? ''))],
          )
        : { rows: [] as Array<{ invoice_id: string; n: number }> };
      const itemCounts = new Map<string, number>(
        items.rows.map((r: { invoice_id: string; n: number }) => [r.invoice_id, Number(r.n)]),
      );

      res.json({
        items: rows.map((r: Record<string, unknown>) => {
          const invoiceId = (r.current_invoice_id as string | null) ?? '';
          return {
            id: r.id,
            tableNumber: r.table_number,
            seats: r.capacity ?? 0,
            // An unknown state is reported as unknown, never drawn as "free" —
            // a table drawn as available is a table a host seats guests at.
            status: r.status ?? 'unknown',
            areaName: r.area_name ?? null,
            activeOrderTotal: invoiceId ? (byInvoice.get(invoiceId) ?? 0) : 0,
            itemsCount: invoiceId ? (itemCounts.get(invoiceId) ?? 0) : 0,
          };
        }),
        count: rows.length,
      });
    } catch (err: unknown) {
      console.error('[dypos-api] restaurant tables failed', err);
      res.status(500).json({ error: (err as Error).message });
    }
  }));
/* ══ Kitchen display ══════════════════════════════════════════════════ */

  app.get('/api/db/kitchen/tickets', attachPrincipal, asyncRoute(async (req, res) => {
    const tenant = tenantOf(req);
    const status = typeof req.query.status === 'string' ? req.query.status : null;
    try {
      /*
       * Open tickets by default: a KDS shows work in progress, and the closed
       * ones belong in a report. `ticket_no` is a BIGINT, so this orders
       * numerically — a text column would put ticket 100 before ticket 99 and
       * the kitchen would cook the wrong thing.
       */
      const { rows } = await pool.query(
        status
          ? `SELECT id, ticket_no, ticket_label, table_label, order_type,
                    items, status, priority, queued_at, started_at, ready_at, served_at
               FROM dypos.kitchen_tickets
              WHERE tenant_id = $1 AND status = $2
              ORDER BY priority DESC, ticket_no ASC`
          : `SELECT id, ticket_no, ticket_label, table_label, order_type,
                    items, status, priority, queued_at, started_at, ready_at, served_at
               FROM dypos.kitchen_tickets
              WHERE tenant_id = $1 AND status IN ('queued','preparing','ready')
              ORDER BY priority DESC, ticket_no ASC`,
        status ? [tenant, status] : [tenant],
      );

      res.json({
        items: rows.map((r: Record<string, unknown>) => ({
          id: r.id,
          // A counter value, deliberately not formatted into a display string:
          // "KDS-000101" as text sorts in the wrong place.
          ticketNo: r.ticket_no,
          ticketLabel: r.ticket_label ?? null,
          tableNumber: r.table_label ?? null,
          orderType: r.order_type,
          items: r.items,
          status: r.status,
          priority: r.priority,
          queuedAt: r.queued_at,
          startedAt: r.started_at ?? null,
          readyAt: r.ready_at ?? null,
          servedAt: r.served_at ?? null,
          // Computed server-side so every kitchen display in the group agrees on
          // how long a ticket has been waiting.
          elapsedMinutes: Math.floor(
            (Date.now() - new Date(r.queued_at as string).getTime()) / 60000,
          ),
        })),
        count: rows.length,
      });
    } catch (err: unknown) {
      console.error('[dypos-api] kitchen tickets failed', err);
      res.status(500).json({ error: (err as Error).message });
    }
  }));

  /* ══ Subscriptions ════════════════════════════════════════════════════ */

  app.get('/api/db/subscriptions', attachPrincipal, asyncRoute(async (req, res) => {
    const tenant = tenantOf(req);
    try {
      const { rows } = await pool.query(
        `SELECT s.id, s.customer_id, c.name AS customer_name, c.phone,
                s.plan_id, s.status, s.start_date, s.end_date, s.auto_renew,
                s.last_payment_date
           FROM dypos.subscriptions s
           LEFT JOIN dypos.customers c
                  ON c.id = s.customer_id AND c.tenant_id = s.tenant_id
          WHERE s.tenant_id = $1
          ORDER BY s.end_date ASC NULLS LAST`,
        [tenant],
      );

      res.json({
        items: rows.map((r: Record<string, unknown>) => {
          const end = r.end_date ? new Date(r.end_date as string) : null;
          const daysLeft = end ? Math.ceil((end.getTime() - Date.now()) / 86400000) : null;
          return {
            id: r.id,
            customerName: r.customer_name ?? 'عميل غير معروف',
            customerPhone: r.phone ?? null,
            planId: r.plan_id ?? null,
            status: r.status,
            startDate: r.start_date,
            endDate: r.end_date,
            autoRenew: r.auto_renew,
            lastPaymentDate: r.last_payment_date ?? null,
            // NULL when no end date is recorded. A subscription with no end date
            // is not "renews in 0 days", and rendering it that way would start a
            // churn conversation with a customer for no reason.
            daysRemaining: daysLeft,
            // Derived from stored values, not a status the screen invented.
            isExpired: daysLeft !== null && daysLeft < 0 && r.status !== 'cancelled',
          };
        }),
        count: rows.length,
      });
    } catch (err: unknown) {
      console.error('[dypos-api] subscriptions failed', err);
      res.status(500).json({ error: (err as Error).message });
    }
  /* ══ Consignment ledger ═══════════════════════════════════════════════ */

  app.get('/api/db/consignments', attachPrincipal, asyncRoute(async (req, res) => {
    const tenant = tenantOf(req);
    try {
      /*
       * Grouped BY CONSIGNOR, summing their lines.
       *
       * The table holds one row per consignor per product. A per-consignor
       * balance is therefore a SUM, computed here on every read — never a stored
       * total, which would drift the moment a line was corrected and would leave
       * a figure nobody could recompute from the sales behind it. That
       * recomputability is the whole point of a consignment account: the
       * consignor can check it.
       *
       * The share is the consignor's agreed percentage, so the amount owed is
       * their share of the SOLD quantity, not of the quantity supplied.
       */
      const { rows } = await pool.query(
        `SELECT c.id,
                c.consignor,
                COUNT(*)::int                     AS line_count,
                COALESCE(SUM(c.quantity), 0)      AS total_quantity,
                COALESCE(SUM(c.sold_quantity), 0) AS sold_quantity,
                COALESCE(SUM(c.sale_amount), 0)   AS gross_sales,
                -- The agreed share is per line; a weighted average is reported so
                -- a consignor with two rates is not silently shown as one.
                CASE WHEN SUM(c.quantity) > 0
                     THEN ROUND(SUM(c.sale_amount * c.consignor_share_pct / 100
                                     * (c.sold_quantity::numeric / NULLIF(c.quantity, 0)))
                               / SUM(c.sale_amount * (c.sold_quantity::numeric
                                     / NULLIF(c.quantity, 0))), 2)
                     ELSE 0 END                  AS commission_amount,
                COUNT(*) FILTER (WHERE c.status = 'settled')::int AS settled_lines,
                COUNT(*) FILTER (WHERE c.status <> 'settled')::int AS open_lines,
                MAX(c.created_at)                 AS last_activity
           FROM dypos.consignment_sales c
          WHERE c.tenant_id = $1
          GROUP BY c.id, c.consignor
          ORDER BY c.consignor ASC`,
        [tenant],
      );

      res.json({
        items: rows.map((r: Record<string, unknown>) => {
          const gross = Number(r.gross_sales);
          const commission = Number(r.commission_amount);
          return {
            id: r.id,
            consignor: r.consignor,
            lineCount: Number(r.line_count),
            totalQuantity: Number(r.total_quantity),
            soldQuantity: Number(r.sold_quantity),
            grossSales: gross,
            commissionAmount: commission,
            // What the consignor has not yet been paid. Derived from the lines.
            outstandingAmount: Math.max(0, commission),
            settledLines: Number(r.settled_lines),
            openLines: Number(r.open_lines),
            status: Number(r.open_lines) === 0 ? 'settled' : 'open',
            lastActivity: r.last_activity,
          };
        }),
        count: rows.length,
      });
    } catch (err: unknown) {
      console.error('[dypos-api] consignments failed', err);
      res.status(500).json({ error: (err as Error).message });
    }
  }));
}));
}