import type { Express } from 'express';
import { pool } from './neonDb.js';
import { asyncRoute, DEFAULT_TENANT, fail, tenantOf } from './apiHelpers.js';
import { attachPrincipal, requirePermission } from './authz.js';
import { computeAll, statusOf, narrate, runAndPersist } from './kpiCompute.js';

export { computeAll };

/**
 * KPI engine.
 *
 * Every metric is computed in SQL from the transactional tables — never from a
 * client-side aggregate and never from a cached constant. That is what makes
 * the figures arguable in a management meeting.
 *
 * The engine also separates "zero" from "not enough data", because the gap
 * between "shrinkage was 0%" and "no count has been run" is the difference
 * between a clean report and a dangerous one.
 */
export function registerKpiRoutes(app: Express) {
  /** Live KPI board: value, status and the recommended action per metric. */
  app.get('/api/erp/kpi', asyncRoute(async (req, res) => {
    const tenantId = tenantOf(req);
    const branchId = req.query.branchId ? String(req.query.branchId) : null;

    const [defs, values] = await Promise.all([
      pool.query(
        `SELECT code, name, name_en, category, polarity, unit, formula,
                benchmark, warn_threshold, critical_threshold, action, sort_order
         FROM dypos.kpi_definitions WHERE is_active = TRUE
         ORDER BY category, sort_order`,
      ),
      computeAll(tenantId, branchId),
    ]);

    const defMap = new Map(values.map((v) => [v.code, v]));
    const items = defs.rows.map((d: any) => {
      const measured = defMap.get(d.code);
      return {
        ...d,
        value: measured?.value ?? null,
        sampleSize: measured?.sampleSize ?? 0,
        status: measured ? statusOf(d, measured) : 'insufficient_data',
        narrative: measured ? narrate(d, measured) : 'لا توجد بيانات كافية لحساب هذا المؤشر',
      };
    });

    // Rank by urgency so the reader sees the problems first, not the pleasant.
    const rank: Record<string, number> = { critical: 0, warn: 1, insufficient_data: 2, ok: 3 };
    items.sort((a: any, b: any) =>
      (rank[a.status] ?? 9) - (rank[b.status] ?? 9) || a.sort_order - b.sort_order);

    res.json({
      items,
      summary: {
        total: items.length,
        critical: items.filter((i: any) => i.status === 'critical').length,
        warn: items.filter((i: any) => i.status === 'warn').length,
        ok: items.filter((i: any) => i.status === 'ok').length,
        insufficient: items.filter((i: any) => i.status === 'insufficient_data').length,
      },
      computedAt: new Date().toISOString(),
    });
  }));

  /** Historical series for one KPI, so drift is visible rather than guessed. */
  app.get('/api/erp/kpi/:code/history', asyncRoute(async (req, res) => {
    const tenantId = tenantOf(req);
    const { rows } = await pool.query(
      `SELECT s.scope_date, s.value, s.status, s.benchmark
       FROM dypos.kpi_snapshots s
       WHERE s.tenant_id = $1 AND s.kpi_code = $2
       ORDER BY s.scope_date DESC LIMIT 90`,
      [tenantId, req.params.code],
    );
    res.json({ code: req.params.code, items: rows.reverse() });
  }));

  /** Open alerts, most severe first. */
  app.get('/api/erp/kpi/alerts', asyncRoute(async (req, res) => {
    const tenantId = tenantOf(req);
    const { rows } = await pool.query(
      `SELECT a.*, d.name, d.unit, d.category
       FROM dypos.kpi_alerts a
       JOIN dypos.kpi_definitions d ON d.code = a.kpi_code
       WHERE a.tenant_id = $1 AND a.status IN ('open','acknowledged')
       ORDER BY CASE a.severity WHEN 'critical' THEN 0 ELSE 1 END, a.scope_date DESC
       LIMIT 100`,
      [tenantId],
    );
    res.json({ items: rows });
  }));

  /** Persists today's board and raises alerts for anything that breached. */
  app.post(
    '/api/erp/kpi/run',
    attachPrincipal,
    requirePermission('reports.view'),
    asyncRoute(async (req, res) => {
      const tenantId = tenantOf(req);
      res.json(await runAndPersist(tenantId, req.body?.branchId ?? null, req.principal!.username));
    }),
  );

  /** Acknowledging an alert records who accepted responsibility for it. */
  app.post(
    '/api/erp/kpi/alerts/:id/acknowledge',
    attachPrincipal,
    asyncRoute(async (req, res) => {
      const { rows } = await pool.query(
        `UPDATE dypos.kpi_alerts
         SET status = 'acknowledged', acknowledged_by = $2, acknowledged_at = NOW()
         WHERE id = $1 AND tenant_id = $3
         RETURNING id, status, acknowledged_by`,
        [req.params.id, req.principal!.username, DEFAULT_TENANT],
      );
      if (!rows.length) return fail(res, 404, 'التنبيه غير موجود');
      res.json({ item: rows[0] });
    }),
  );

  /** Closing a breach so it stops counting against the operator. */
  app.post(
    '/api/erp/kpi/alerts/:id/resolve',
    attachPrincipal,
    asyncRoute(async (req, res) => {
      const { rows } = await pool.query(
        `UPDATE dypos.kpi_alerts
         SET status = 'resolved', resolved_by = $2, resolved_at = NOW()
         WHERE id = $1 AND tenant_id = $3
         RETURNING id, status, resolved_by`,
        [req.params.id, req.principal!.username, DEFAULT_TENANT],
      );
      if (!rows.length) return fail(res, 404, 'التنبيه غير موجود');
      res.json({ item: rows[0] });
    }),
  );

  /** Revenue, COGS and gross profit per day, for trend and margin checks. */
  app.get('/api/erp/kpi/sales-trend', asyncRoute(async (req, res) => {
    const tenantId = tenantOf(req);
    const days = Math.min(Number(req.query.days) || 90, 365);
    const { rows } = await pool.query(
      `WITH sold AS (
         SELECT i.created_at::date AS d,
                i.base_subtotal,
                (SELECT COALESCE(SUM((item->>'qty')::numeric * (item->>'cost')::numeric), 0)
                   FROM jsonb_array_elements(i.items) AS item) AS cogs
         FROM dypos.invoices i
         WHERE i.tenant_id = $1 AND i.status = 'completed'
           AND i.created_at::date >= CURRENT_DATE - $2::int
       )
       SELECT to_char(d, 'YYYY-MM-DD')                       AS day,
              COALESCE(SUM(base_subtotal), 0)::numeric        AS net,
              COALESCE(SUM(cogs), 0)::numeric                AS cogs,
              COALESCE(SUM(base_subtotal - cogs), 0)::numeric AS gross_profit,
              count(*)::int                                  AS invoices
       FROM sold GROUP BY 1, d ORDER BY d`,
      [tenantId, days],
    );
    res.json({ items: rows });
  }));

  /**
   * Worst performers, not just totals. A "top 5" list tells the manager what
   * already works; a "bottom 5" list tells them what to fix.
   */
  app.get('/api/erp/kpi/dead-stock', asyncRoute(async (req, res) => {
    const tenantId = tenantOf(req);
    const limit = Math.min(Number(req.query.limit) || 20, 100);
    const { rows } = await pool.query(
      `SELECT p.id, p.name, p.category, p.sku, p.stock,
              (p.cost * p.stock)::numeric AS tied_value,
              (SELECT MAX(i.created_at)::date
                 FROM dypos.invoices i, jsonb_array_elements(i.items) AS item
                WHERE i.tenant_id = p.tenant_id AND i.status = 'completed'
                  AND (item->>'productId') = p.id) AS last_sold,
              COALESCE(EXTRACT(DAY FROM (CURRENT_DATE -
                (SELECT MAX(i.created_at)::date
                   FROM dypos.invoices i2, jsonb_array_elements(i2.items) AS it2
                  WHERE i2.tenant_id = p.tenant_id AND i2.status = 'completed'
                    AND (it2->>'productId') = p.id))), 999) AS days_idle
       FROM dypos.products p
       WHERE p.tenant_id = $1 AND p.is_active = TRUE AND p.stock > 0
         AND NOT EXISTS (
           SELECT 1 FROM dypos.invoices i, jsonb_array_elements(i.items) AS item
           WHERE i.tenant_id = p.tenant_id AND i.status = 'completed'
             AND (item->>'productId') = p.id
             AND i.created_at::date >= CURRENT_DATE - 90
         )
       ORDER BY tied_value DESC
       LIMIT $2`,
      [tenantId, limit],
    );
    res.json({ items: rows });
  }));
}