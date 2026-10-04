import type { Express } from 'express';
import { pool } from './neonDb.js';
import { asyncRoute, DEFAULT_TENANT, makeId, fail } from './apiHelpers.js';
import { attachPrincipal, requirePermission } from './authz.js';

/**
 * Multi-currency endpoints following the SAP three-currency model:
 * transaction currency, local currency, and a group/reporting currency.
 * Rates are effective-dated, so a posted document never revalues itself.
 */
export function registerCurrencyRoutes(app: Express) {
  /** Active currencies with the base flagged for consolidation reporting. */
  app.get('/api/erp/currencies', asyncRoute(async (_req, res) => {
    /*
     * Scoped by tenant.
     *
     * `dypos.currencies` DOES carry `tenant_id` — each tenant nominates its own
     * base currency (`is_base`). Reading it unscoped returned every tenant's
     * rate table merged together, and `rows.find(r => r.is_base)` then picked a
     * base currency belonging to whichever row happened to sort first.
     *
     * That is not a cosmetic leak: the base currency decides how the whole
     * group's figures are consolidated, so a reporting currency chosen from
     * another company's row is a wrong number presented as authoritative.
     */
    const { rows } = await pool.query(
      `SELECT code, name, symbol, decimals, is_base, exchange_rate, country_code, updated_at
       FROM dypos.currencies WHERE tenant_id = $1 AND is_active = TRUE
       ORDER BY is_base DESC, code`,
      [DEFAULT_TENANT],
    );
    res.json({
      items: rows,
      base: (rows.find((r: any) => r.is_base) || { code: 'SAR' }).code,
    });
  }));

  /**
   * Resolves an exchange rate as of a date by walking the rate history.
   * Tries the direct pair, then the inverse, then the reference table — which
   * is how a real treasury function behaves when a feed is incomplete.
   */
  app.get('/api/erp/currency/rate', asyncRoute(async (req, res) => {
    const from = String(req.query.from || 'SAR').toUpperCase();
    const to = String(req.query.to || 'SAR').toUpperCase();
    const asOf = req.query.asOf ? String(req.query.asOf) : null;

    if (from === to) return res.json({ from, to, rate: 1, source: 'identity' });

    const direct = await pool.query(
      `SELECT id, rate, rate_type, valid_from
       FROM dypos.currency_rates
       WHERE tenant_id = $1 AND from_currency = $2 AND to_currency = $3
         AND valid_from <= COALESCE($4::timestamptz, NOW())
         AND (valid_to IS NULL OR valid_to > COALESCE($4::timestamptz, NOW()))
       ORDER BY valid_from DESC LIMIT 1`,
      [DEFAULT_TENANT, from, to, asOf],
    );
    if (direct.rows.length) {
      const r = direct.rows[0];
      return res.json({
        from, to, rate: Number(r.rate),
        source: r.rate_type, rateId: r.id, validFrom: r.valid_from,
      });
    }

    const inverse = await pool.query(
      `SELECT id, rate, rate_type, valid_from
       FROM dypos.currency_rates
       WHERE tenant_id = $1 AND from_currency = $2 AND to_currency = $3
         AND valid_from <= COALESCE($4::timestamptz, NOW())
       ORDER BY valid_from DESC LIMIT 1`,
      [DEFAULT_TENANT, to, from, asOf],
    );
    if (inverse.rows.length) {
      const r = inverse.rows[0];
      return res.json({
        from, to, rate: Number(1 / Number(r.rate)),
        source: `${r.rate_type}:inverse`, rateId: r.id,
      });
    }

    const ref = await pool.query(
      `SELECT code, exchange_rate FROM dypos.currencies
       WHERE tenant_id = $1 AND code = ANY($2) AND is_active = TRUE`,
      [DEFAULT_TENANT, [from, to]],
    );
    const map = Object.fromEntries(ref.rows.map((r: any) => [r.code, Number(r.exchange_rate)]));
    if (map[from] && map[to]) {
      return res.json({ from, to, rate: map[from] / map[to], source: 'reference-table' });
    }
    res.status(404).json({ error: `لا يوجد سعر صرف معروف ${from} → ${to}` });
  }));

  /** Records a new dated rate, closing the previous validity window. */
  app.post(
    '/api/erp/currency/rate',
    attachPrincipal,
    requirePermission('currency.rate.manage'),
    asyncRoute(async (req, res) => {
      const { from, to, rate, rateType, source, asOf } = req.body || {};
      if (!from || !to || !rate) {
        return fail(res, 400, 'العملة المصدر والهدف والسعر مطلوبة');
      }
      if (String(from).toUpperCase() === String(to).toUpperCase()) {
        return fail(res, 400, 'لا يمكن تسجيل سعر صرف بين عملتين متطابقتين');
      }
      if (!(Number(rate) > 0)) {
        return fail(res, 400, 'سعر الصرف يجب أن يكون أكبر من صفر');
      }

      const id = makeId('fx');
      const inserted = await pool.query(
        `INSERT INTO dypos.currency_rates
           (id, tenant_id, from_currency, to_currency, rate, rate_type, valid_from, source, created_by)
         VALUES ($1,$2,$3,$4,$5,$6,COALESCE($7::timestamptz, NOW()),$8,$9)
         RETURNING id, from_currency, to_currency, rate, rate_type, valid_from`,
        [id, DEFAULT_TENANT, String(from).toUpperCase(), String(to).toUpperCase(),
          Number(rate), rateType || 'manual', asOf ?? null,
          source ?? null, req.principal!.username],
      );

      // Close the prior window so the history stays contiguous.
      await pool.query(
        `UPDATE dypos.currency_rates SET valid_to = COALESCE($5::timestamptz, NOW())
         WHERE tenant_id = $1 AND from_currency = $2 AND to_currency = $3
           AND id <> $4 AND valid_to IS NULL`,
        [DEFAULT_TENANT, String(from).toUpperCase(), String(to).toUpperCase(), id, asOf ?? null],
      );

      res.status(201).json({ item: inserted.rows[0] });
    }),
  );

  /** Rate history for an audit trail on a revaluation. */
  app.get('/api/erp/currency/history', asyncRoute(async (req, res) => {
    const from = String(req.query.from || '').toUpperCase();
    const to = String(req.query.to || '').toUpperCase();
    const { rows } = await pool.query(
      `SELECT from_currency, to_currency, rate, rate_type, valid_from, valid_to, source, created_by
       FROM dypos.currency_rates
       WHERE tenant_id = $1 AND from_currency = $2 AND to_currency = $3
       ORDER BY valid_from DESC LIMIT 50`,
      [DEFAULT_TENANT, from, to],
    );
    res.json({ items: rows });
  }));
}