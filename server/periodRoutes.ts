import type { Express } from 'express';
import { pool } from './neonDb.js';
import { asyncRoute, DEFAULT_TENANT, fail } from './apiHelpers.js';
import { attachPrincipal, requirePermission, assertBranchAccess } from './authz.js';

/**
 * Posting-period control, mirroring the SAP FI period lock. A closed period is
 * the single most important control in a ledger: it is what makes a financial
 * year immutable once reported.
 */
export function registerPeriodRoutes(app: Express) {
  app.get('/api/erp/periods', asyncRoute(async (_req, res) => {
    const { rows } = await pool.query(
      `SELECT id, period, status, closed_at, closed_by
       FROM dypos.accounting_periods WHERE tenant_id = $1 ORDER BY period DESC`,
      [DEFAULT_TENANT],
    );
    res.json({ items: rows });
  }));

  /**
   * Whether a period still accepts postings. An unknown period defaults to
   * open, so a missing configuration row never silently blocks business.
   */
  app.get('/api/erp/periods/:period/status', asyncRoute(async (req, res) => {
    const { rows } = await pool.query(
      `SELECT period, status FROM dypos.accounting_periods
       WHERE tenant_id = $1 AND period = $2`,
      [DEFAULT_TENANT, req.params.period],
    );
    if (!rows.length) {
      return res.json({ period: req.params.period, status: 'open', exists: false });
    }
    res.json({ period: rows[0].period, status: rows[0].status, exists: true });
  }));

  app.post(
    '/api/erp/periods/:period/close',
    attachPrincipal,
    requirePermission('period.close'),
    asyncRoute(async (req, res) => {
      const { rows } = await pool.query(
        `UPDATE dypos.accounting_periods
         SET status = 'closed', closed_at = NOW(), closed_by = $3
         WHERE tenant_id = $1 AND period = $2
         RETURNING id, period, status, closed_at, closed_by`,
        [DEFAULT_TENANT, req.params.period, req.principal!.username],
      );
      if (!rows.length) return fail(res, 404, 'الفترة المحاسبية غير موجودة');
      res.json({ item: rows[0] });
    }),
  );

  app.post(
    '/api/erp/periods/:period/reopen',
    attachPrincipal,
    requirePermission('period.reopen'),
    asyncRoute(async (req, res) => {
      const { rows } = await pool.query(
        `UPDATE dypos.accounting_periods
         SET status = 'open', closed_at = NULL, closed_by = NULL
         WHERE tenant_id = $1 AND period = $2
         RETURNING id, period, status`,
        [DEFAULT_TENANT, req.params.period],
      );
      if (!rows.length) return fail(res, 404, 'الفترة المحاسبية غير موجودة');
      res.json({ item: rows[0] });
    }),
  );

  /** Reports the caller's branch scope; optionally verifies one branch. */
  app.get('/api/erp/branch-scope', attachPrincipal, asyncRoute(async (req, res) => {
    assertBranchAccess(req.principal, req.query.branchId ? String(req.query.branchId) : null);
    res.json({
      branchIds: req.principal!.branchIds,
      isSuperuser: req.principal!.isSuperuser,
    });
  }));
}