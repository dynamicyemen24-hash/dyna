import type { Express } from 'express';
import { pool } from './neonDb.js';
import { asyncRoute, DEFAULT_TENANT, makeId, fail } from './apiHelpers.js';
import { attachPrincipal, requirePermission } from './authz.js';

/**
 * Unit-of-measure endpoints (Oracle Fusion / ISO 80000 style).
 * Conversions are explicit configured factors — never inferred from names —
 * and cross-dimension conversion is refused by design.
 */
export function registerUomRoutes(app: Express) {
  /** UoM catalogue grouped by dimension. */
  app.get('/api/erp/uom', asyncRoute(async (_req, res) => {
    const { rows } = await pool.query(
      `SELECT u.id, u.code, u.name, u.dimension, u.precision, u.is_active,
              u.base_unit_id, b.code AS base_unit_code,
              -- A unit is the base of its dimension when it points at itself.
              (u.base_unit_id IS NULL OR u.base_unit_id = u.id) AS is_base
       FROM dypos.units_of_measure u
       LEFT JOIN dypos.units_of_measure b ON b.id = u.base_unit_id
       WHERE u.tenant_id = $1 AND u.is_active = TRUE
       ORDER BY u.dimension, is_base DESC, u.code`,
      [DEFAULT_TENANT],
    );
    const grouped = rows.reduce<Record<string, any[]>>((acc, r: any) => {
      (acc[r.dimension] ||= []).push(r);
      return acc;
    }, {});
    res.json({ items: rows, dimensions: grouped });
  }));

  /** Full conversion factor matrix. */
  app.get('/api/erp/uom/conversions', asyncRoute(async (_req, res) => {
    const { rows } = await pool.query(
      `SELECT cv.id, cf.code AS from_code, ct.code AS to_code,
              cv.numerator, cv.denominator,
              (cv.numerator::numeric / NULLIF(cv.denominator,0)) AS factor
       FROM dypos.uom_conversions cv
       JOIN dypos.units_of_measure cf ON cf.id = cv.from_unit_id
       JOIN dypos.units_of_measure ct ON ct.id = cv.to_unit_id
       WHERE cv.tenant_id = $1
       ORDER BY cf.dimension, cf.code, ct.code`,
      [DEFAULT_TENANT],
    );
    res.json({ items: rows });
  }));

  /**
   * Server-side conversion. The client previews locally for responsiveness,
   * but the server value is the one written to stock.
   */
  app.get('/api/erp/uom/convert', asyncRoute(async (req, res) => {
    const from = String(req.query.from || '').toUpperCase();
    const to = String(req.query.to || '').toUpperCase();
    const qty = Number(req.query.qty);
    if (!from || !to || !Number.isFinite(qty)) {
      return fail(res, 400, 'from و to و qty مطلوبة');
    }

    const { rows } = await pool.query(
      `SELECT cf.dimension AS from_dim, ct.dimension AS to_dim,
              cv.numerator, cv.denominator, ct.precision AS to_prec
       FROM dypos.units_of_measure cf
       JOIN dypos.units_of_measure ct ON ct.tenant_id = cf.tenant_id
       LEFT JOIN dypos.uom_conversions cv
              ON cv.from_unit_id = cf.id AND cv.to_unit_id = ct.id
       WHERE cf.tenant_id = $1 AND cf.code = $2 AND ct.code = $3`,
      [DEFAULT_TENANT, from, to],
    );
    const row = rows[0];
    if (!row) return fail(res, 404, 'وحدة القياس غير معرّفة');
    if (row.from_dim !== row.to_dim) {
      return fail(
        res, 422,
        `لا يمكن التحويل بين بُعدين مختلفين: ${row.from_dim} → ${row.to_dim}`,
      );
    }
    if (!row.numerator) {
      return fail(res, 422, `لا يوجد معامل تحويل من ${from} إلى ${to}`);
    }

    res.json({
      from, to, input: qty,
      output: Number(((qty * Number(row.numerator)) / Number(row.denominator)).toFixed(row.to_prec)),
      factor: Number(row.numerator) / Number(row.denominator),
      dimension: row.from_dim,
    });
  }));

  /** Defines or updates a conversion factor, mirroring the reverse direction. */
  app.post(
    '/api/erp/uom/conversions',
    attachPrincipal,
    requirePermission('product.manage'),
    asyncRoute(async (req, res) => {
      const { from, to, numerator, denominator } = req.body || {};
      if (!from || !to) return fail(res, 400, 'الوحدتان مطلوبتان');
      if (String(from).toUpperCase() === String(to).toUpperCase()) {
        return fail(res, 400, 'لا يمكن تعريف تحويل إلى نفس الوحدة');
      }
      if (!(Number(numerator) > 0) || !(Number(denominator) > 0)) {
        return fail(res, 400, 'البسط والمقام يجب أن يكونا أكبر من صفر');
      }

      const up = await pool.query(
        `INSERT INTO dypos.uom_conversions (id, tenant_id, from_unit_id, to_unit_id, numerator, denominator)
         SELECT $1,$2::varchar,f.id,t.id,$3::numeric,$4::numeric
         FROM dypos.units_of_measure f, dypos.units_of_measure t
         WHERE f.tenant_id=$2::varchar AND f.code=$5::varchar
           AND t.tenant_id=$2::varchar AND t.code=$6::varchar
         ON CONFLICT (tenant_id, from_unit_id, to_unit_id)
           DO UPDATE SET numerator = EXCLUDED.numerator, denominator = EXCLUDED.denominator
         RETURNING id, numerator, denominator`,
        [makeId('uconv'), DEFAULT_TENANT, Number(numerator), Number(denominator),
          String(from).toUpperCase(), String(to).toUpperCase()],
      );
      if (!up.rows.length) return fail(res, 404, 'وحدة قياس غير معرّفة');

      // Keep the reverse direction consistent.
      await pool.query(
        `INSERT INTO dypos.uom_conversions (id, tenant_id, from_unit_id, to_unit_id, numerator, denominator)
         SELECT $1,$2::varchar,f.id,t.id,$3::numeric,$4::numeric
         FROM dypos.units_of_measure f, dypos.units_of_measure t
         WHERE f.tenant_id=$2::varchar AND f.code=$5::varchar
           AND t.tenant_id=$2::varchar AND t.code=$6::varchar
         ON CONFLICT (tenant_id, from_unit_id, to_unit_id) DO NOTHING`,
        [makeId('uconv'), DEFAULT_TENANT, Number(denominator), Number(numerator),
          String(to).toUpperCase(), String(from).toUpperCase()],
      );

      res.status(201).json({ item: up.rows[0] });
    }),
  );
}