/**
 * API routes backing the seven end-to-end screens:
 *   services, appointments, production, batches, serials,
 *   commissions, delivery.
 */
import type { Express } from 'express';
import { pool } from './neonDb.js';
import {
  asyncRoute,
  fail,
  makeId,
  num,
  registerCrudRoutes,
  tenantOf,
  DEFAULT_TENANT,
} from './apiHelpers.js';
// The unlock gate reuses the SAME authority model and the SAME password
// verification as the login path. Importing them here (rather than
// re-implementing a second check) is what keeps the two paths from drifting —
// and drift between them is how an endpoint ends up weaker than the login it
// sits beside.
import { attachPrincipal } from './authz.js';
import { authRateLimit } from './rateLimit.js';
import { verifySessionToken } from './sessions.js';
import {
  verifyPassword, isLocked, lockoutMinutesFor, GENERIC_AUTH_ERROR,
} from './passwords.js';

export function registerCoreScreenRoutes(app: Express) {
  /** Branch list for the login screen — public within the tenant. */
  app.get('/api/db/branches', asyncRoute(async (_req, res) => {
    const { rows } = await pool.query(
      `SELECT id, name, city, phone, location AS address, '' AS manager
       FROM dypos.branches WHERE tenant_id = $1 AND is_active = TRUE
       ORDER BY name`,
      [DEFAULT_TENANT],
    );
    res.json({ items: rows, branches: rows, count: rows.length });
  }));

  /**
 * Biometric / re-authentication gate.
 *
 * ── What this endpoint used to be ───────────────────────────────────────────
 * It read `userId` from the request body, checked the row existed and was
 * active, verified that `credential` was merely *non-empty*, and returned
 * `{ ok: true }`.
 *
 * That is not a weak biometric check, it is none. `POST /api/auth/unlock
 * { userId, method: 'face', credential: 'x' }` succeeded for ANY active user,
 * from an UNAUTHENTICATED caller — and `AuthContext.biometricUnlock` reported
 * true on that basis. The caller chose both the identity being unlocked and the
 * "proof".
 *
 * ── What it is now ──────────────────────────────────────────────────────────
 * Three requirements, each of which must hold:
 *
 *   1. A valid signed session token. The identity comes from the TOKEN, never
 *      from the request body — the same rule every other route follows.
 *   2. The unlocked subject is the CALLER, so a session cannot be used to step
 *      sideways into another account.
 *   3. A REAL second check. There is no WebAuthn implementation in this server,
 *      and inventing one would repeat the original defect — so the honest
 *      answers are:
 *        - `pin` → verified against the user's real PBKDF2 hash, under the same
 *                  lockout the login path already enforces.
 *        - `face` / `fingerprint` → rejected as unimplemented, and says so.
 *
 * A biometric assertion is deliberately NOT accepted: honouring an unverified
 * boolean from the client is exactly what made this endpoint worthless.
 */
app.post('/api/auth/unlock', attachPrincipal, authRateLimit('unlock'), asyncRoute(async (req, res) => {
  const principal = req.principal;
  if (!principal) return fail(res, 401, 'جلسة غير موثقة');

  const { subjectId, method, pin } = req.body || {};

  /*
   * The tenant comes from the verified TOKEN, not from a header and never from
   * the body. `Principal` deliberately does not carry a tenant field — it is
   * resolved per request — so the token payload is the authority here, exactly
   * as it is on every other route. Reading the tenant from the body would let a
   * caller scope the unlock to a tenant of their choosing.
   */
  const verified = verifySessionToken(req.header('authorization')?.replace(/^Bearer\s+/i, '') ?? '');
  if (!verified.ok) return fail(res, 401, 'جلسة غير موثقة');
  const tenantId = verified.payload.tenantId;

  /*
   * Requirement 2 — the subject must be the caller.
   *
   * Absent a subject the caller is unlocking themselves, which is the only
   * legitimate use. A different subject is refused outright rather than silently
   * rewritten, so a caller can never believe they unlocked someone else.
   */
  if (subjectId && subjectId !== principal.userId) {
    await pool.query(
      `INSERT INTO dypos.auth_events
         (id, tenant_id, username, event_type, reason)
       VALUES ($1,$2,$3,'login_failed','unlock_subject_mismatch')`,
      [makeId('ae'), tenantId, principal.username],
    );
    return fail(res, 403, 'لا يمكن فتح جلسة مستخدم آخر');
  }

  const u = await pool.query(
    `SELECT id, is_active, password_hash, password_salt, password_iterations,
            failed_attempts, locked_until
       FROM dypos.users
      WHERE id = $1 AND tenant_id = $2`,
    [principal.userId, tenantId],
  );
  const user = u.rows[0];
  if (!user || !user.is_active) return fail(res, 401, 'المستخدم غير مصرح له');

  if (method === 'pin') {
    if (!pin) return fail(res, 400, 'الرمز مطلوب');
    if (isLocked(user.locked_until)) {
      return fail(res, 423, 'الحساب مقفل مؤقتاً بعد محاولات فاشلة');
    }

    const ok = await verifyPassword(String(pin), {
      hash: user.password_salt ? user.password_hash : null,
      salt: user.password_salt || undefined,
      iterations: user.password_iterations || undefined,
      legacyDigest: user.password_salt ? null : user.password_hash,
    });

    if (!ok) {
      // The same budget the login path enforces, so a PIN cannot be ground here
      // under a limit the login path would have stopped.
      const attempts = Number(user.failed_attempts || 0) + 1;
      const minutes = lockoutMinutesFor(attempts);
      await pool.query(
        `UPDATE dypos.users
            SET failed_attempts = $2,
                locked_until = CASE WHEN $3::int > 0
                  THEN NOW() + ($3 || ' minutes')::interval ELSE NULL END
          WHERE id = $1`,
        [user.id, attempts, String(minutes)],
      );
      return fail(res, 401, GENERIC_AUTH_ERROR);
    }

    await pool.query(
      `UPDATE dypos.users SET failed_attempts = 0, locked_until = NULL WHERE id = $1`,
      [user.id],
    );
    return res.json({ ok: true, method: 'pin', userId: user.id });
  }

  if (method === 'face' || method === 'fingerprint') {
    /*
     * Not implemented, and not simulated.
     *
     * Returning `{ ok: true }` here would restore precisely the defect this route
     * had: a success that proves nothing. The truthful answer is that no
     * authenticator is enrolled, so the client falls back to a PIN or to a full
     * sign-in.
     */
    return fail(
      res, 501,
      'لم يتم تسجيل أي مصادقة حيوية على هذا الحساب — استخدم الرمز أو سجّل الدخول',
    );
  }

  return fail(res, 400, 'طريقة تحقق غير مدعومة');
}));

  // ------------------------------------------------------------------
  // 1) SERVICES — كتالوج الخدمات
  // ------------------------------------------------------------------
  registerCrudRoutes(app, '/api/db/services', {
    table: 'services',
    prefix: 'svc',
    orderBy: 'name ASC',
    columns: {
      name: 'name',
      nameEn: 'name_en',
      category: 'category',
      description: 'description',
      basePrice: 'base_price',
      taxRate: 'tax_rate',
      durationMinutes: 'duration_minutes',
      isActive: 'is_active',
      metadata: 'metadata',
    },
  });

  // ------------------------------------------------------------------
  // 2) APPOINTMENTS — نظام المواعيد
  // ------------------------------------------------------------------
  app.get(
    '/api/db/appointments',
    asyncRoute(async (req, res) => {
      const tenant = tenantOf(req);
      const limit = Math.min(Number(req.query.limit) || 200, 1000);
      const { rows } = await pool.query(
        `SELECT a.*, s.name AS service_name, e.name AS employee_name
         FROM dypos.appointments a
         LEFT JOIN dypos.services   s ON a.service_id  = s.id
         LEFT JOIN dypos.employees  e ON a.employee_id = e.id
         WHERE a.tenant_id = $1
         ORDER BY a.scheduled_start ASC
         LIMIT $2`,
        [tenant, limit],
      );
      res.json({ items: rows, count: rows.length });
    }),
  );

  app.post(
    '/api/db/appointments',
    asyncRoute(async (req, res) => {
      const tenant = tenantOf(req);
      const b = req.body || {};
      if (!b.scheduledStart) return fail(res, 400, 'وقت البدء مطلوب');

      // Derive the end time: use the supplied value, else the service duration,
      // else a 60-minute default so scheduled_end is never null.
      let end: string | null = b.scheduledEnd || null;
      if (!end && b.serviceId) {
        const svc = await pool.query(
          `SELECT duration_minutes FROM dypos.services WHERE id = $1 AND tenant_id = $2`,
          [b.serviceId, tenant],
        );
        if (svc.rows.length) {
          end = new Date(
            new Date(b.scheduledStart).getTime() + Number(svc.rows[0].duration_minutes) * 60000,
          ).toISOString();
        }
      }
      if (!end) {
        end = new Date(new Date(b.scheduledStart).getTime() + 60 * 60000).toISOString();
      }

      const { rows } = await pool.query(
        `INSERT INTO dypos.appointments
           (id, tenant_id, branch_id, service_id, customer_id, customer_name,
            customer_phone, employee_id, scheduled_start, scheduled_end,
            status, price, notes)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13)
         ON CONFLICT (id) DO UPDATE SET
           service_id = EXCLUDED.service_id,
           customer_name = EXCLUDED.customer_name,
           customer_phone = EXCLUDED.customer_phone,
           employee_id = EXCLUDED.employee_id,
           scheduled_start = EXCLUDED.scheduled_start,
           scheduled_end = EXCLUDED.scheduled_end,
           status = EXCLUDED.status,
           notes = EXCLUDED.notes
         RETURNING *`,
        [
          makeId('apt'), tenant, b.branchId ?? null, b.serviceId ?? null,
          b.customerId ?? null, b.customerName ?? 'عميل', b.customerPhone ?? null,
          b.employeeId ?? null, b.scheduledStart, end,
          b.status ?? 'scheduled', num(b.price), b.notes ?? null,
        ],
      );
      res.status(201).json({ item: rows[0] });
    }),
  );

  // PATCH — status transitions (تأكيد / بدء / إنهاء / إلغاء)
  app.patch(
    '/api/db/appointments/:id/status',
    asyncRoute(async (req, res) => {
      const tenant = tenantOf(req);
      const status = String(req.body?.status || '');
      const allowed = [
        'scheduled', 'confirmed', 'in_progress', 'completed', 'cancelled', 'no_show',
      ];
      if (!allowed.includes(status)) return fail(res, 400, `حالة غير صالحة: ${status}`);

      const { rows } = await pool.query(
        `UPDATE dypos.appointments SET status = $3
         WHERE id = $1 AND tenant_id = $2 RETURNING *`,
        [req.params.id, tenant, status],
      );
      if (!rows.length) return fail(res, 404, 'الموعد غير موجود');
      res.json({ item: rows[0] });
    }),
  );

  app.delete(
    '/api/db/appointments/:id',
    asyncRoute(async (req, res) => {
      const tenant = tenantOf(req);
      const { rows } = await pool.query(
        `DELETE FROM dypos.appointments WHERE id = $1 AND tenant_id = $2 RETURNING id`,
        [req.params.id, tenant],
      );
      if (!rows.length) return fail(res, 404, 'الموعد غير موجود');
      res.json({ deleted: rows[0].id });
    }),
  );

  // ------------------------------------------------------------------
  // 3) PRODUCTION — محرك الإنتاج + BOM
  // ------------------------------------------------------------------
  app.get(
    '/api/db/production',
    asyncRoute(async (req, res) => {
      const tenant = tenantOf(req);
      const { rows } = await pool.query(
        `SELECT po.*, p.name AS product_name, p.unit, p.unit_price
         FROM dypos.production_orders po
         LEFT JOIN dypos.products p ON po.product_id = p.id
         WHERE po.tenant_id = $1
         ORDER BY po.created_at DESC
         LIMIT 500`,
        [tenant],
      );
      res.json({ items: rows, count: rows.length });
    }),
  );

  app.get(
    '/api/db/production/recipes',
    asyncRoute(async (req, res) => {
      const tenant = tenantOf(req);
      const { rows } = await pool.query(
        `SELECT r.id, r.product_id, r.version, r.yield_qty, r.is_active,
                p.name AS product_name,
                COALESCE(
                  json_agg(
                    json_build_object(
                      'id', ri.id,
                      'componentId', ri.component_product_id,
                      'componentName', cp.name,
                      'qty', ri.qty,
                      'wastePercent', ri.waste_percent
                    )
                  ) FILTER (WHERE ri.id IS NOT NULL),
                  '[]'::json
                ) AS components
         FROM dypos.product_recipes r
         LEFT JOIN dypos.products p ON r.product_id = p.id
         LEFT JOIN dypos.product_recipe_items ri ON ri.recipe_id = r.id
         LEFT JOIN dypos.products cp ON ri.component_product_id = cp.id
         WHERE r.tenant_id = $1
         GROUP BY r.id, p.name
         ORDER BY p.name`,
        [tenant],
      );
      res.json({ items: rows, count: rows.length });
    }),
  );

  app.post(
    '/api/db/production',
    asyncRoute(async (req, res) => {
      const tenant = tenantOf(req);
      const b = req.body || {};
      if (!b.productId) return fail(res, 400, 'المنتج مطلوب');
      if (num(b.quantity) <= 0) return fail(res, 400, 'الكمية يجب أن تكون أكبر من صفر');

      const { rows } = await pool.query(
        `INSERT INTO dypos.production_orders
           (id, tenant_id, branch_id, recipe_id, product_id, quantity, status,
            planned_start, planned_end, completed_qty, notes)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11)
         RETURNING *`,
        [
          makeId('prd'), tenant, b.branchId ?? null, b.recipeId ?? null,
          b.productId, num(b.quantity), b.status ?? 'draft',
          b.plannedStart ?? null, b.plannedEnd ?? null,
          num(b.completedQty), b.notes ?? null,
        ],
      );
      res.status(201).json({ item: rows[0] });
    }),
  );

  /**
   * Completes production inside a transaction: consumes component stock
   * following FEFO, receives the finished goods and records the movements.
   */
  app.post(
    '/api/db/production/:id/complete',
    asyncRoute(async (req, res) => {
      const tenant = tenantOf(req);
      const client = await pool.connect();
      try {
        await client.query('BEGIN');
        await client.query('SET search_path TO dypos, public');

        const order = await client.query(
          `SELECT * FROM dypos.production_orders
           WHERE id = $1 AND tenant_id = $2 FOR UPDATE`,
          [req.params.id, tenant],
        );
        if (!order.rows.length) {
          await client.query('ROLLBACK');
          return fail(res, 404, 'أمر الإنتاج غير موجود');
        }
        const ord = order.rows[0];
        const doneQty = num(req.body?.completedQty ?? ord.quantity);

        const comps = await client.query(
          `SELECT ri.component_product_id, ri.qty AS per_unit,
                  ri.waste_percent, p.name
           FROM dypos.product_recipe_items ri
           LEFT JOIN dypos.products p ON ri.component_product_id = p.id
           WHERE ri.tenant_id = $1 AND ri.recipe_id = $2`,
          [DEFAULT_TENANT, ord.recipe_id],
        );

        const consumed: any[] = [];
        for (const c of comps.rows) {
          const need = num(c.per_unit) * doneQty * (1 + num(c.waste_percent) / 100);

          // FEFO: soonest expiry first, then oldest first.
          const batches = await client.query(
            `SELECT id, batch_number, quantity FROM dypos.product_batches
             WHERE tenant_id = $1 AND product_id = $2
               AND quantity > 0 AND status = 'active'
             ORDER BY expiry_date NULLS LAST, created_at ASC`,
            [tenant, c.component_product_id],
          );
          let remaining = need;
          for (const bRow of batches.rows) {
            if (remaining <= 0) break;
            const take = Math.min(num(bRow.quantity), remaining);
            await client.query(
              `UPDATE dypos.product_batches SET quantity = quantity - $2 WHERE id = $1`,
              [bRow.id, take],
            );
            remaining -= take;
          }

          await client.query(
            `UPDATE dypos.products SET stock = stock - $3, updated_at = NOW()
             WHERE id = $1 AND tenant_id = $2`,
            [c.component_product_id, tenant, need],
          );
          await client.query(
            `INSERT INTO dypos.stock_movements
               (id, tenant_id, product_id, type, quantity, reference_id, reason)
             VALUES ($1,$2,$3,'production_out',$4,$5,$6)`,
            [makeId('mv'), tenant, c.component_product_id, -need, ord.id,
             `${c.name ?? ''} — استهلاك إنتاج`.trim()],
          );
          consumed.push({
            componentId: c.component_product_id,
            name: c.name,
            needed: need,
          });
        }

        await client.query(
          `UPDATE dypos.products SET stock = stock + $3, updated_at = NOW()
           WHERE id = $1 AND tenant_id = $2`,
          [ord.product_id, tenant, doneQty],
        );
        await client.query(
          `INSERT INTO dypos.stock_movements
             (id, tenant_id, product_id, type, quantity, reference_id, reason)
           VALUES ($1,$2,$3,'production_in',$4,$5,$6)`,
          [makeId('mv'), tenant, ord.product_id, doneQty, ord.id, 'إنتاج تام'],
        );

        const upd = await client.query(
          `UPDATE dypos.production_orders
           SET status = 'completed', completed_qty = $3, updated_at = NOW()
           WHERE id = $1 AND tenant_id = $2 RETURNING *`,
          [ord.id, tenant, doneQty],
        );

        await client.query('COMMIT');
        res.json({ item: upd.rows[0], consumed });
      } catch (e: any) {
        await client.query('ROLLBACK').catch(() => {});
        throw e;
      } finally {
        client.release();
      }
    }),
  );

  app.delete(
    '/api/db/production/:id',
    asyncRoute(async (req, res) => {
      const tenant = tenantOf(req);
      const { rows } = await pool.query(
        `DELETE FROM dypos.production_orders WHERE id = $1 AND tenant_id = $2 RETURNING id`,
        [req.params.id, tenant],
      );
      if (!rows.length) return fail(res, 404, 'أمر الإنتاج غير موجود');
      res.json({ deleted: rows[0].id });
    }),
  );

  // ------------------------------------------------------------------
  // 4) BATCHES & EXPIRY — FEFO
  // ------------------------------------------------------------------
  app.get(
    '/api/db/batches',
    asyncRoute(async (req, res) => {
      const tenant = tenantOf(req);
      const { rows } = await pool.query(
        `SELECT b.*, p.name AS product_name, p.unit,
                (b.expiry_date - CURRENT_DATE) AS days_to_expiry,
                b.quantity * b.cost AS batch_value
         FROM dypos.product_batches b
         LEFT JOIN dypos.products p ON b.product_id = p.id
         WHERE b.tenant_id = $1
         ORDER BY b.expiry_date NULLS LAST, b.created_at DESC
         LIMIT 1000`,
        [tenant],
      );
      res.json({ items: rows, count: rows.length });
    }),
  );

  app.post(
    '/api/db/batches',
    asyncRoute(async (req, res) => {
      const tenant = tenantOf(req);
      const b = req.body || {};
      if (!b.productId) return fail(res, 400, 'المنتج مطلوب');
      if (!b.batchNumber) return fail(res, 400, 'رقم التشغيلة مطلوب');

      const { rows } = await pool.query(
        `INSERT INTO dypos.product_batches
           (id, tenant_id, branch_id, product_id, batch_number, quantity,
            cost, expiry_date, production_date, supplier_id, status)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11)
         ON CONFLICT (tenant_id, product_id, batch_number) DO UPDATE SET
           quantity = EXCLUDED.quantity,
           cost = EXCLUDED.cost,
           expiry_date = EXCLUDED.expiry_date
         RETURNING *`,
        [
          makeId('bat'), tenant, b.branchId ?? null, b.productId,
          b.batchNumber, num(b.quantity), num(b.cost),
          b.expiryDate ?? null, b.productionDate ?? null,
          b.supplierId ?? null, b.status ?? 'active',
        ],
      );
      res.status(201).json({ item: rows[0] });
    }),
  );

  app.delete(
    '/api/db/batches/:id',
    asyncRoute(async (req, res) => {
      const tenant = tenantOf(req);
      const { rows } = await pool.query(
        `DELETE FROM dypos.product_batches WHERE id = $1 AND tenant_id = $2 RETURNING id`,
        [req.params.id, tenant],
      );
      if (!rows.length) return fail(res, 404, 'التشغيلة غير موجودة');
      res.json({ deleted: rows[0].id });
    }),
  );

  // ------------------------------------------------------------------
  // 5) SERIALS / IMEI
  // ------------------------------------------------------------------
  app.get(
    '/api/db/serials',
    asyncRoute(async (req, res) => {
      const tenant = tenantOf(req);
      const { rows } = await pool.query(
        `SELECT s.*, p.name AS product_name, p.unit_price
         FROM dypos.product_serials s
         LEFT JOIN dypos.products p ON s.product_id = p.id
         WHERE s.tenant_id = $1
         ORDER BY s.created_at DESC
         LIMIT 1000`,
        [tenant],
      );
      res.json({ items: rows, count: rows.length });
    }),
  );

  app.post(
    '/api/db/serials',
    asyncRoute(async (req, res) => {
      const tenant = tenantOf(req);
      const b = req.body || {};
      if (!b.productId) return fail(res, 400, 'المنتج مطلوب');
      if (!b.serialNumber) return fail(res, 400, 'الرقم التسلسلي مطلوب');

      const { rows } = await pool.query(
        `INSERT INTO dypos.product_serials
           (id, tenant_id, branch_id, product_id, serial_number, imei,
            status, warranty_end, sold_invoice_id, purchased_at)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,COALESCE($10, NOW()))
         ON CONFLICT (tenant_id, product_id, serial_number) DO UPDATE SET
           imei = EXCLUDED.imei,
           status = EXCLUDED.status,
           warranty_end = EXCLUDED.warranty_end
         RETURNING *`,
        [
          makeId('ser'), tenant, b.branchId ?? null, b.productId,
          b.serialNumber, b.imei ?? null, b.status ?? 'in_stock',
          b.warrantyEnd ?? null, b.soldInvoiceId ?? null, b.purchasedAt ?? null,
        ],
      );
      res.status(201).json({ item: rows[0] });
    }),
  );

  app.patch(
    '/api/db/serials/:id',
    asyncRoute(async (req, res) => {
      const tenant = tenantOf(req);
      const b = req.body || {};
      const { rows } = await pool.query(
        `UPDATE dypos.product_serials
         SET status = $3, sold_at = $4
         WHERE id = $1 AND tenant_id = $2 RETURNING *`,
        [
          req.params.id, tenant, b.status ?? 'in_stock',
          b.status === 'sold' ? b.soldAt ?? new Date().toISOString() : null,
        ],
      );
      if (!rows.length) return fail(res, 404, 'الرقم التسلسلي غير موجود');
      res.json({ item: rows[0] });
    }),
  );

  app.delete(
    '/api/db/serials/:id',
    asyncRoute(async (req, res) => {
      const tenant = tenantOf(req);
      const { rows } = await pool.query(
        `DELETE FROM dypos.product_serials WHERE id = $1 AND tenant_id = $2 RETURNING id`,
        [req.params.id, tenant],
      );
      if (!rows.length) return fail(res, 404, 'الرقم التسلسلي غير موجود');
      res.json({ deleted: rows[0].id });
    }),
  );

  // ------------------------------------------------------------------
  // 6) COMMISSIONS — العمولات
  // ------------------------------------------------------------------
  app.get(
    '/api/db/commissions',
    asyncRoute(async (req, res) => {
      const tenant = tenantOf(req);
      const params: any[] = [tenant];
      let extra = '';
      if (req.query.year) {
        params.push(Number(req.query.year));
        extra += ` AND period_year = $${params.length}`;
      }
      if (req.query.month) {
        params.push(Number(req.query.month));
        extra += ` AND period_month = $${params.length}`;
      }

      const { rows } = await pool.query(
        `SELECT * FROM dypos.commissions
         WHERE tenant_id = $1${extra}
         ORDER BY period_year DESC, period_month DESC, employee_name`,
        params,
      );
      const totals = rows.reduce(
        (acc: any, r: any) => {
          if (r.status === 'paid') acc.paid += Number(r.amount);
          else acc.accrued += Number(r.amount);
          return acc;
        },
        { accrued: 0, paid: 0 },
      );
      res.json({ items: rows, count: rows.length, totals });
    }),
  );

  app.post(
    '/api/db/commissions',
    asyncRoute(async (req, res) => {
      const tenant = tenantOf(req);
      const b = req.body || {};
      if (!b.employeeId) return fail(res, 400, 'الموظف مطلوب');

      const rate = num(b.rate);
      const base = num(b.baseAmount);
      const amount = b.amount !== undefined ? num(b.amount) : (base * rate) / 100;
      const now = new Date();

      const { rows } = await pool.query(
        `INSERT INTO dypos.commissions
           (id, tenant_id, employee_id, employee_name, period_year, period_month,
            base_amount, rate, amount, status, notes)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11)
         ON CONFLICT (tenant_id, employee_id, period_year, period_month)
           DO UPDATE SET base_amount = EXCLUDED.base_amount,
                         rate = EXCLUDED.rate,
                         amount = EXCLUDED.amount,
                         status = EXCLUDED.status
         RETURNING *`,
        [
          makeId('cm'), tenant, b.employeeId, b.employeeName ?? null,
          Number(b.periodYear ?? now.getFullYear()),
          Number(b.periodMonth ?? now.getMonth() + 1),
          base, rate, amount, b.status ?? 'accrued', b.notes ?? null,
        ],
      );
      res.status(201).json({ item: rows[0] });
    }),
  );

  /** Marks one or more commissions as paid. */
  app.post(
    '/api/db/commissions/settle',
    asyncRoute(async (req, res) => {
      const tenant = tenantOf(req);
      const ids: string[] = Array.isArray(req.body?.ids) ? req.body.ids : [];
      if (!ids.length) return fail(res, 400, 'مطلوب معرّفات العمولات');

      const { rows } = await pool.query(
        `UPDATE dypos.commissions
         SET status = 'paid', paid_at = NOW()
         WHERE tenant_id = $1 AND id = ANY($2::varchar[])
         RETURNING *`,
        [tenant, ids],
      );
      res.json({ items: rows, count: rows.length });
    }),
  );

  // ------------------------------------------------------------------
  // 7) DELIVERY — إدارة التوصيل
  // ------------------------------------------------------------------
  app.get(
    '/api/db/delivery-zones',
    asyncRoute(async (req, res) => {
      const tenant = tenantOf(req);
      const { rows } = await pool.query(
        `SELECT * FROM dypos.delivery_zones
         WHERE tenant_id = $1 AND is_active = true
         ORDER BY fee`,
        [tenant],
      );
      res.json({ items: rows, count: rows.length });
    }),
  );

  app.get(
    '/api/db/deliveries',
    asyncRoute(async (req, res) => {
      const tenant = tenantOf(req);
      const params: any[] = [tenant];
      let extra = '';
      if (req.query.status) {
        params.push(String(req.query.status));
        extra += ` AND d.status = $${params.length}`;
      }
      const { rows } = await pool.query(
        `SELECT d.*, z.name AS zone_name, z.estimated_minutes
         FROM dypos.deliveries d
         LEFT JOIN dypos.delivery_zones z ON d.zone_id = z.id
         WHERE d.tenant_id = $1${extra}
         ORDER BY d.created_at DESC
         LIMIT 500`,
        params,
      );
      res.json({ items: rows, count: rows.length });
    }),
  );

  app.post(
    '/api/db/deliveries',
    asyncRoute(async (req, res) => {
      const tenant = tenantOf(req);
      const b = req.body || {};
      if (!b.customerName) return fail(res, 400, 'اسم العميل مطلوب');
      if (!b.address) return fail(res, 400, 'العنوان مطلوب');

      // Resolve the zone fee and enforce its minimum order value.
      let fee = num(b.fee);
      if (b.zoneId && fee === 0) {
        const z = await pool.query(
          `SELECT fee, minimum_order_amount FROM dypos.delivery_zones
           WHERE id = $1 AND tenant_id = $2`,
          [b.zoneId, tenant],
        );
        if (z.rows.length) {
          fee = num(z.rows[0].fee);
          const min = num(z.rows[0].minimum_order_amount);
          if (num(b.amountDue) < min) {
            return fail(res, 400, `الحد الأدنى لطلب التوصيل في هذه المنطقة ${min} ر.س`);
          }
        }
      }

      const { rows } = await pool.query(
        `INSERT INTO dypos.deliveries
           (id, tenant_id, branch_id, invoice_id, zone_id, customer_name,
            customer_phone, address, driver_id, driver_name, status, fee,
            amount_due, distance_km, notes)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15)
         RETURNING *`,
        [
          makeId('dlv'), tenant, b.branchId ?? null, b.invoiceId ?? null,
          b.zoneId ?? null, b.customerName, b.customerPhone ?? null,
          b.address, b.driverId ?? null, b.driverName ?? null,
          b.status ?? 'pending', fee, num(b.amountDue),
          b.distanceKm ?? null, b.notes ?? null,
        ],
      );
      res.status(201).json({ item: rows[0] });
    }),
  );

  app.patch(
    '/api/db/deliveries/:id/status',
    asyncRoute(async (req, res) => {
      const tenant = tenantOf(req);
      const status = String(req.body?.status || '');
      const allowed = ['pending', 'assigned', 'picked_up', 'on_the_way', 'delivered', 'cancelled'];
      if (!allowed.includes(status)) return fail(res, 400, `حالة غير صالحة: ${status}`);

      const { rows } = await pool.query(
        `UPDATE dypos.deliveries
         SET status = $3::varchar,
             picked_at    = CASE WHEN $3::varchar = 'picked_up' THEN NOW() ELSE picked_at END,
             delivered_at = CASE WHEN $3::varchar = 'delivered' THEN NOW() ELSE delivered_at END,
             driver_id    = COALESCE($4, driver_id),
             driver_name  = COALESCE($5, driver_name)
         WHERE id = $1 AND tenant_id = $2
         RETURNING *`,
        [
          req.params.id, tenant, status,
          req.body?.driverId ?? null, req.body?.driverName ?? null,
        ],
      );
      if (!rows.length) return fail(res, 404, 'طلب التوصيل غير موجود');
      res.json({ item: rows[0] });
    }),
  );

  app.delete(
    '/api/db/deliveries/:id',
    asyncRoute(async (req, res) => {
      const tenant = tenantOf(req);
      const { rows } = await pool.query(
        `DELETE FROM dypos.deliveries WHERE id = $1 AND tenant_id = $2 RETURNING id`,
        [req.params.id, tenant],
      );
      if (!rows.length) return fail(res, 404, 'طلب التوصيل غير موجود');
      res.json({ deleted: rows[0].id });
    }),
  );
}
