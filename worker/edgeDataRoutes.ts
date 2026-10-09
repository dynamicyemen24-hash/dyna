/**
 * EDGE DATA ROUTES — the production mirror of the Express routes the SPA calls
 * but the Cloudflare Worker did not serve.
 *
 * Why this file exists: production runs the Worker (`wrangler` → `worker/index.ts`),
 * not Express. Two dozen endpoints the client calls every session — the home
 * screen's seven sources, the cashier shifts, currencies/UoM, accounting-period
 * status — were registered only in Express, so in production they fell through
 * to the Worker's default-deny and returned 404/401. The home screen looked
 * broken and a shift could never be opened at the till.
 *
 * Every handler mirrors its Express source contract exactly (same envelope, same
 * column aliases, same validation messages) so development (Express) and
 * production (Worker) cannot disagree about a number or an error.
 *
 * The restaurant/kitchen endpoints are intentionally NOT mirrored: that module is
 * a separate system and is out of scope for this commercial release.
 *
 * `route()` in index.ts calls this at the top with already-normalised inputs:
 * `path` has had `/api/` and the optional `db|erp` segment stripped, `principal`
 * is verified, `sql` is the Neon driver bound to `env`, and `tenant` comes from
 * the signed token (never the request body). Returning `null` hands the path back
 * to the Worker's existing table.
 */

import type { NeonQueryFunction } from '@neondatabase/serverless';

/** Structural slice of the Worker's request context, keeping this module decoupled. */
export interface EdgeRouteCtx {
  method: string;
  path: string;
  url: URL;
  req: Request;
  body: any;
  principal: {
    userId: string;
    username: string;
    name: string;
    role: string;
    tenantId: string;
  };
  requestId: string;
  sql: NeonQueryFunction<false, false>;
  tenant: string;
  json: (data: unknown, status?: number, headers?: Record<string, string>) => Response;
  fail: (status: number, error: string, path?: string, method?: string, requestId?: string) => Response;
  makeId: (prefix: string) => string;
  audit: (
    env: any, tenant: string, username: string, event: string, req: Request, reason?: string,
  ) => Promise<void>;
  env: any;
}

const num = (v: unknown, d = 0) => {
  const n = Number(v);
  return Number.isFinite(n) ? n : d;
};


/**
 * Returns a Response when this module owns the path, or null to let the Worker's
 * own route table try. Called at the top of `route()` so the mirror wins for the
 * paths it lists and never shadows the existing table.
 */
export async function handleEdgeDataRoute(ctx: EdgeRouteCtx): Promise<Response | null> {
  const { method, path, url, body, principal, requestId, sql, tenant, json, fail, makeId, audit, env, req } = ctx;

  if (method === 'GET') {
    // ---- Home screen: KPI tiles (mirrors reportRoutes /api/db/dashboard) ----
    if (path === '/dashboard') {
      const branchId = url.searchParams.get('branchId') || '';
      // Neon's HTTP driver can't interpolate a conditional suffix, so the two
      // shapes are separate queries — identical math to the Express source.
      const baseSales = branchId
        ? sql`SELECT COALESCE(SUM(total),0)::numeric    AS revenue_today,
                     COALESCE(SUM(subtotal),0)::numeric AS net_today,
                     COALESCE(SUM(tax),0)::numeric      AS vat_today,
                     count(*)::int                      AS invoices_today
              FROM dypos.invoices
              WHERE tenant_id = ${tenant} AND status = 'completed'
                AND created_at::date = CURRENT_DATE AND branch_id = ${branchId}`
        : sql`SELECT COALESCE(SUM(total),0)::numeric    AS revenue_today,
                     COALESCE(SUM(subtotal),0)::numeric AS net_today,
                     COALESCE(SUM(tax),0)::numeric      AS vat_today,
                     count(*)::int                      AS invoices_today
              FROM dypos.invoices
              WHERE tenant_id = ${tenant} AND status = 'completed'
                AND created_at::date = CURRENT_DATE`;

      const [sales, stock, customers, counts] = await Promise.all([
        baseSales,
        sql`SELECT COALESCE(SUM(stock),0)::numeric AS units,
                   count(*) FILTER (WHERE stock <= min_stock)::int AS low_stock,
                   COALESCE(SUM(stock * cost),0)::numeric          AS stock_value
            FROM dypos.products WHERE tenant_id = ${tenant} AND is_active = TRUE`,
        sql`SELECT count(*)::int AS total FROM dypos.customers WHERE tenant_id = ${tenant}`,
        sql`SELECT (SELECT count(*) FROM dypos.employees WHERE tenant_id = ${tenant} AND status = 'active')::int AS employees,
                   (SELECT count(*) FROM dypos.suppliers  WHERE tenant_id = ${tenant})::int AS suppliers,
                   (SELECT count(*) FROM dypos.invoices   WHERE tenant_id = ${tenant})::int AS all_invoices`,
      ]);

      const s: any = sales[0] || {};
      const st: any = stock[0] || {};
      const cu: any = customers[0] || {};
      const ct: any = counts[0] || {};
      return json({
        revenueToday: num(s.revenue_today),
        netToday: num(s.net_today),
        vatToday: num(s.vat_today),
        invoicesToday: num(s.invoices_today),
        stockUnits: num(st.units),
        lowStock: num(st.low_stock),
        stockValue: num(st.stock_value),
        customers: num(cu.total),
        employees: num(ct.employees),
        suppliers: num(ct.suppliers),
        all_invoices: num(ct.all_invoices),
      }, 200, { 'cache-control': 'public, max-age=300, stale-while-revalidate=86400' });
    }

    // ---- Home screen: unified work queue (mirrors /api/db/work-queue) -------
    if (path === '/work-queue') {
      const branchId = url.searchParams.get('branchId') || '';
      const sector = url.searchParams.get('sector');
      const b = branchId || '';

      const [appts, prod, batches, deliveries] = await Promise.all([
        b
          ? sql`SELECT a.id, a.customer_name, a.scheduled_start, a.status,
                       COALESCE(s.base_price, a.price, 0)::numeric AS amount
                FROM dypos.appointments a
                LEFT JOIN dypos.services s ON s.id = a.service_id
                WHERE a.tenant_id = ${tenant} AND a.status NOT IN ('cancelled','completed','delivered')
                  AND a.branch_id = ${b}
                ORDER BY a.scheduled_start LIMIT 50`
          : sql`SELECT a.id, a.customer_name, a.scheduled_start, a.status,
                       COALESCE(s.base_price, a.price, 0)::numeric AS amount
                FROM dypos.appointments a
                LEFT JOIN dypos.services s ON s.id = a.service_id
                WHERE a.tenant_id = ${tenant} AND a.status NOT IN ('cancelled','completed','delivered')
                ORDER BY a.scheduled_start LIMIT 50`,
        b
          ? sql`SELECT o.id, p.name AS product_name, o.quantity, o.planned_end AS due_date,
                       o.status, COALESCE(p.unit_price,0) * o.quantity AS amount
                FROM dypos.production_orders o
                LEFT JOIN dypos.products p ON p.id = o.product_id
                WHERE o.tenant_id = ${tenant} AND o.status NOT IN ('cancelled','completed','done')
                  AND o.branch_id = ${b}
                ORDER BY o.planned_end NULLS LAST LIMIT 50`
          : sql`SELECT o.id, p.name AS product_name, o.quantity, o.planned_end AS due_date,
                       o.status, COALESCE(p.unit_price,0) * o.quantity AS amount
                FROM dypos.production_orders o
                LEFT JOIN dypos.products p ON p.id = o.product_id
                WHERE o.tenant_id = ${tenant} AND o.status NOT IN ('cancelled','completed','done')
                ORDER BY o.planned_end NULLS LAST LIMIT 50`,
        sql`SELECT b.id, b.batch_number, p.name AS product_name, b.quantity,
                   b.expiry_date, b.status
            FROM dypos.product_batches b
            LEFT JOIN dypos.products p ON p.id = b.product_id
            WHERE b.tenant_id = ${tenant} AND b.status NOT IN ('expired','disposed')
            ORDER BY b.expiry_date NULLS LAST LIMIT 50`,
        b
          ? sql`SELECT d.id, d.customer_name, d.created_at AS scheduled_time, d.status,
                       COALESCE(d.fee,0)::numeric AS amount
                FROM dypos.deliveries d
                WHERE d.tenant_id = ${tenant} AND d.status NOT IN ('delivered','cancelled','returned')
                  AND d.branch_id = ${b}
                ORDER BY d.created_at LIMIT 50`
          : sql`SELECT d.id, d.customer_name, d.created_at AS scheduled_time, d.status,
                       COALESCE(d.fee,0)::numeric AS amount
                FROM dypos.deliveries d
                WHERE d.tenant_id = ${tenant} AND d.status NOT IN ('delivered','cancelled','returned')
                ORDER BY d.created_at LIMIT 50`,
      ]);

      const items: any[] = [];
      for (const a of appts as any[]) {
        items.push({
          id: a.id, kind: 'appointment', title: a.customer_name || 'موعد',
          reference: a.id, dueAt: a.scheduled_start, amount: num(a.amount),
          status: a.status || 'scheduled', blockedBy: null,
        });
      }
      for (const x of prod as any[]) {
        items.push({
          id: x.id, kind: 'production',
          title: `${x.product_name || 'أمر إنتاج'} × ${x.quantity}`,
          reference: x.id, dueAt: x.due_date, amount: num(x.amount),
          status: x.status || 'pending', blockedBy: null,
        });
      }
      for (const x of batches as any[]) {
        items.push({
          id: x.id, kind: 'batch',
          title: `${x.product_name || 'دفعة'} · ${x.batch_number || x.id}`,
          reference: x.batch_number || x.id, dueAt: x.expiry_date,
          amount: num(x.quantity), status: x.status || 'active', blockedBy: null,
        });
      }
      for (const d of deliveries as any[]) {
        items.push({
          id: d.id, kind: 'delivery', title: d.customer_name || 'توصيل',
          reference: d.id, dueAt: d.scheduled_time, amount: num(d.amount),
          status: d.status || 'pending', blockedBy: null,
        });
      }

      return json({ items, count: items.length, sector }, 200,
        { 'cache-control': 'public, max-age=600, stale-while-revalidate=86400' });
    }

    // ---- Home screen: sales trend (mirrors /api/db/reports/daily-sales) -----
    if (path === '/reports/daily-sales') {
      const days = Math.min(num(url.searchParams.get('days'), 14), 90);
      const rows = await sql`SELECT to_char(created_at, 'YYYY-MM-DD') AS day,
              to_char(created_at, 'Dy')          AS day_name,
              COALESCE(SUM(total),0)::numeric    AS revenue,
              COALESCE(SUM(subtotal),0)::numeric AS net,
              COALESCE(SUM(tax),0)::numeric      AS vat,
              COALESCE(SUM(discount),0)::numeric AS discount,
              count(*)::int                      AS invoices
       FROM dypos.invoices
       WHERE tenant_id = ${tenant} AND status = 'completed'
         AND created_at::date >= CURRENT_DATE - ${days}::int
       GROUP BY 1, 2, created_at::date
       ORDER BY created_at::date`;
      return json({ items: rows }, 200, { 'cache-control': 'public, max-age=600, stale-while-revalidate=86400' });
    }

    // ---- Home screen: best sellers (mirrors /api/db/reports/top-products) ---
    if (path === '/reports/top-products') {
      const limit = Math.min(num(url.searchParams.get('limit'), 8), 50);
      const rows = await sql`SELECT item->>'name' AS name,
              SUM((item->>'qty')::numeric)    AS qty,
              SUM((item->>'total')::numeric) AS sales
       FROM dypos.invoices, jsonb_array_elements(items) AS item
       WHERE tenant_id = ${tenant} AND status = 'completed'
       GROUP BY 1
       HAVING SUM((item->>'total')::numeric) > 0
       ORDER BY sales DESC
       LIMIT ${limit}`;
      return json({ items: rows }, 200, { 'cache-control': 'public, max-age=600, stale-while-revalidate=86400' });
    }

    // ---- Home screen: payment mix (mirrors /api/db/reports/payment-methods) -
    if (path === '/reports/payment-methods') {
      const rows = await sql`SELECT payment_method, COALESCE(SUM(total),0)::numeric AS value,
              count(*)::int AS invoices
       FROM dypos.invoices
       WHERE tenant_id = ${tenant} AND status = 'completed'
       GROUP BY 1 ORDER BY value DESC`;
      return json({ items: rows }, 200, { 'cache-control': 'public, max-age=600, stale-while-revalidate=86400' });
    }

    // ---- Accounting period status (mirrors /api/erp/periods/:period/status) -
    // An unknown period defaults to open, so a missing row never blocks business.
    if (path.startsWith('/periods/') && path.endsWith('/status')) {
      const period = decodeURIComponent(path.slice('/periods/'.length, -'/status'.length));
      const rows = await sql`SELECT period, status FROM dypos.accounting_periods
       WHERE tenant_id = ${tenant} AND period = ${period}`;
      if (!rows.length) return json({ period, status: 'open', exists: false });
      const r: any = rows[0];
      return json({ period: r.period, status: r.status, exists: true });
    }

    // ---- Currencies (mirrors /api/erp/currencies), scoped by tenant --------
    if (path === '/currencies') {
      const rows = await sql`SELECT code, name, symbol, decimals, is_base, exchange_rate, country_code, updated_at
       FROM dypos.currencies WHERE tenant_id = ${tenant} AND is_active = TRUE
       ORDER BY is_base DESC, code`;
      const base = (rows as any[]).find((r) => r.is_base)?.code || 'SAR';
      return json({ items: rows, base });
    }

    // ---- Exchange rate: direct → inverse → reference table -----------------
    if (path === '/currency/rate') {
      const from = (url.searchParams.get('from') || 'SAR').toUpperCase();
      const to = (url.searchParams.get('to') || 'SAR').toUpperCase();
      const asOf = url.searchParams.get('asOf');
      if (from === to) return json({ from, to, rate: 1, source: 'identity' });

      const direct = await sql`SELECT id, rate, rate_type, valid_from
       FROM dypos.currency_rates
       WHERE tenant_id = ${tenant} AND from_currency = ${from} AND to_currency = ${to}
         AND valid_from <= COALESCE(${asOf}::timestamptz, NOW())
         AND (valid_to IS NULL OR valid_to > COALESCE(${asOf}::timestamptz, NOW()))
       ORDER BY valid_from DESC LIMIT 1`;
      if (direct.length) {
        const r: any = direct[0];
        return json({ from, to, rate: num(r.rate), source: r.rate_type, rateId: r.id, validFrom: r.valid_from });
      }

      const inverse = await sql`SELECT id, rate, rate_type, valid_from
       FROM dypos.currency_rates
       WHERE tenant_id = ${tenant} AND from_currency = ${to} AND to_currency = ${from}
         AND valid_from <= COALESCE(${asOf}::timestamptz, NOW())
       ORDER BY valid_from DESC LIMIT 1`;
      if (inverse.length) {
        const r: any = inverse[0];
        return json({ from, to, rate: 1 / num(r.rate, 1), source: `${r.rate_type}:inverse`, rateId: r.id });
      }

      const ref = await sql`SELECT code, exchange_rate FROM dypos.currencies
       WHERE tenant_id = ${tenant} AND code = ANY(${[from, to]}) AND is_active = TRUE`;
      const map: Record<string, number> = {};
      for (const r of ref as any[]) map[r.code] = num(r.exchange_rate);
      if (map[from] && map[to]) {
        return json({ from, to, rate: map[from] / map[to], source: 'reference-table' });
      }
      return fail(404, `لا يوجد سعر صرف معروف ${from} → ${to}`, path, method, requestId);
    }

    // ---- Units of measure, grouped by dimension (mirrors /api/erp/uom) ------
    if (path === '/uom') {
      const rows = await sql`SELECT u.id, u.code, u.name, u.dimension, u.precision, u.is_active,
              u.base_unit_id, b.code AS base_unit_code,
              (u.base_unit_id IS NULL OR u.base_unit_id = u.id) AS is_base
       FROM dypos.units_of_measure u
       LEFT JOIN dypos.units_of_measure b ON b.id = u.base_unit_id
       WHERE u.tenant_id = ${tenant} AND u.is_active = TRUE
       ORDER BY u.dimension, is_base DESC, u.code`;
      const grouped: Record<string, any[]> = {};
      for (const r of rows as any[]) (grouped[r.dimension] ||= []).push(r);
      return json({ items: rows, dimensions: grouped });
    }

    // ---- Cashier shift: current (mirrors /api/auth/shift/current) ----------
    if (path === '/shift/current') {
      const open = await sql`SELECT id, branch_id, opening_time, opening_cash, status
        FROM dypos.pos_sessions
        WHERE tenant_id = ${tenant} AND status = 'open'
        ORDER BY opening_time DESC LIMIT 1`;
      if (!open.length) return json({ shift: null });
      const row: any = open[0];
      const totals = (await sql`SELECT
          COALESCE(SUM(total), 0) AS total_sales,
          COALESCE(SUM(total) FILTER (WHERE payment_method IN ('cash','mada')), 0) AS cash_sales,
          COALESCE(SUM(total) FILTER (WHERE payment_method NOT IN ('cash','mada')), 0) AS non_cash_sales,
          COUNT(*) AS transactions_count
        FROM dypos.invoices
        WHERE tenant_id = ${tenant} AND branch_id = ${row.branch_id} AND shift_id = ${row.id} AND status = 'completed'`)[0] as any;
      return json({
        shift: {
          id: row.id,
          branchId: row.branch_id,
          startTime: row.opening_time,
          openingCash: num(row.opening_cash),
          totalSales: num(totals?.total_sales),
          cashSales: num(totals?.cash_sales),
          cardSales: num(totals?.non_cash_sales),
          transactionsCount: num(totals?.transactions_count),
          status: row.status,
        },
      });
    }
  }

  // -------------------------------------------------------------------------
  // WRITE endpoints (POST / PATCH / PUT / DELETE)
  // -------------------------------------------------------------------------
  if (method === 'POST' || method === 'PATCH' || method === 'PUT' || method === 'DELETE') {
    if (!body) return fail(400, 'Request body is required', path, method, requestId);

    // ---- Cashier shift: open (mirrors /api/auth/shift/open) ----------------
    // Validation and messages match Express exactly.
    if (path === '/shift/open') {
      const branchId = String(body?.branchId ?? '').trim();
      if (!branchId) return fail(400, 'حدّد الفرع الذي تفتح له الوردية', path, method, requestId);

      const raw = Number(body?.openingCash);
      if (!Number.isFinite(raw) || raw < 0) {
        return fail(400, 'الرصيد الافتتاحي يجب أن يكون رقماً غير سالب', path, method, requestId);
      }
      const openingCash = Math.round(raw * 100) / 100;
      if (openingCash > 10_000_000) {
        return fail(400, 'الرصيد الافتتاحي خارج النطاق المعقول', path, method, requestId);
      }

      const branch = (await sql`SELECT id, name FROM dypos.branches
        WHERE id = ${branchId} AND tenant_id = ${tenant}`)[0] as any;
      if (!branch) return fail(404, 'الفرع غير موجود في هذه المؤسسة', path, method, requestId);

      const user = (await sql`SELECT id FROM dypos.users
        WHERE tenant_id = ${tenant} AND username = ${principal.username}`)[0] as any;
      if (!user) return fail(403, 'الجلسة لم تعد صالحة', path, method, requestId);

      const already = (await sql`SELECT id FROM dypos.pos_sessions
        WHERE tenant_id = ${tenant} AND branch_id = ${branch.id} AND user_id = ${user.id} AND status = 'open'
        LIMIT 1`)[0] as any;
      if (already) return fail(409, 'توجد وردية مفتوحة بالفعل على هذا الفرع', path, method, requestId);

      const id = makeId('pos');
      await sql`INSERT INTO dypos.pos_sessions
         (id, tenant_id, branch_id, user_id, opening_time, opening_cash, status)
       VALUES (${id}, ${tenant}, ${branch.id}, ${user.id}, NOW(), ${openingCash}, 'open')`;

      await audit(env, tenant, principal.username, 'shift_open', req,
        `الرصيد الافتتاحي ${openingCash.toFixed(2)} · الفرع ${branch.name}`);

      return json({ shiftId: id, openingCash, branchId: branch.id, branchName: branch.name });
    }

    // ---- Cashier shift: close (mirrors /api/auth/shift/close) --------------
    // The UPDATE's `status='open'` predicate is the concurrency guard (the Neon
    // HTTP driver has no interactive transaction), so two concurrent closes
    // cannot both report success.
    if (path === '/shift/close') {
      const shiftId = String(body?.shiftId ?? '').trim();
      if (!shiftId) return fail(400, 'حدد رقم الوردية', path, method, requestId);
      const closingCash = Number(body?.closingCash);
      if (!Number.isFinite(closingCash) || closingCash < 0) {
        return fail(400, 'الرصيد الختامي يجب أن يكون رقماً غير سالب', path, method, requestId);
      }

      const actorUser = (await sql`SELECT id FROM dypos.users
        WHERE tenant_id = ${tenant} AND username = ${principal.username}`)[0] as any;
      if (!actorUser) return fail(403, 'الجلسة لم تعد صالحة', path, method, requestId);

      const shift = (await sql`SELECT id, branch_id, opening_cash, status FROM dypos.pos_sessions
        WHERE id = ${shiftId} AND tenant_id = ${tenant} AND user_id = ${actorUser.id}`)[0] as any;
      if (!shift) return fail(404, 'الوردية غير موجودة أو لا تتبع هذه المؤسسة', path, method, requestId);
      if (shift.status !== 'open') return fail(400, 'الوردية غير مفتوحة', path, method, requestId);

      const sales = (await sql`SELECT
          COALESCE(SUM(total), 0) AS total_sales,
          COALESCE(SUM(total) FILTER (WHERE payment_method IN ('cash','mada')), 0) AS cash_sales
        FROM dypos.invoices
        WHERE tenant_id = ${tenant} AND branch_id = ${shift.branch_id} AND shift_id = ${shiftId} AND status = 'completed'`)[0] as any;
      const totalSales = num(sales?.total_sales);
      const cashSales = num(sales?.cash_sales);
      const expectedCash = num(shift.opening_cash) + cashSales;
      const difference = Math.round((closingCash - expectedCash) * 100) / 100;
      const closedAt = new Date();

      const closed = await sql`UPDATE dypos.pos_sessions
        SET closing_cash = ${closingCash}, end_time = ${closedAt.toISOString()}, status = 'closed'
        WHERE id = ${shiftId} AND tenant_id = ${tenant} AND user_id = ${actorUser.id} AND status = 'open'`;
      if (!closed.length) return fail(409, 'أُغلقت الوردية من طلب آخر', path, method, requestId);

      await audit(env, tenant, principal.username, 'shift_close', req,
        `الرصيد الختامي ${closingCash.toFixed(2)} · الفروقات ${difference.toFixed(2)}`);

      return json({
        shiftId,
        openingCash: num(shift.opening_cash),
        totalSales,
        cashSales,
        closingCash,
        expectedCash,
        difference,
        closedAt: closedAt.toISOString(),
      });
    }

    // ---- Accounting period: close (mirrors /api/erp/periods/:period/close) --
    if (method === 'POST' && path.startsWith('/periods/') && path.endsWith('/close')) {
      const period = decodeURIComponent(path.slice('/periods/'.length, -'/close'.length));
      const rows = await sql`UPDATE dypos.accounting_periods
       SET status = 'closed', closed_at = NOW(), closed_by = ${principal.username}
       WHERE tenant_id = ${tenant} AND period = ${period}
       RETURNING id, period, status, closed_at, closed_by`;
      if (!rows.length) return fail(404, 'الفترة المحاسبية غير موجودة', path, method, requestId);
      return json({ item: rows[0] });
    }

    // ---- Exchange rate: post a new dated rate (mirrors /api/erp/currency/rate) -
    if (method === 'POST' && path === '/currency/rate') {
      const { from, to, rate, rateType, source, asOf } = body || {};
      if (!from || !to || !rate) return fail(400, 'العملة المصدر والهدف والسعر مطلوبة', path, method, requestId);
      if (String(from).toUpperCase() === String(to).toUpperCase()) {
        return fail(400, 'لا يمكن تسجيل سعر صرف بين عملتين متطابقتين', path, method, requestId);
      }
      if (!(Number(rate) > 0)) return fail(400, 'سعر الصرف يجب أن يكون أكبر من صفر', path, method, requestId);

      const F = String(from).toUpperCase();
      const T = String(to).toUpperCase();
      const id = makeId('fx');
      const inserted = await sql`INSERT INTO dypos.currency_rates
         (id, tenant_id, from_currency, to_currency, rate, rate_type, valid_from, source, created_by)
       VALUES (${id}, ${tenant}, ${F}, ${T}, ${Number(rate)}, ${rateType || 'manual'},
               COALESCE(${asOf ?? null}::timestamptz, NOW()), ${source ?? null}, ${principal.username})
       RETURNING id, from_currency, to_currency, rate, rate_type, valid_from`;
      await sql`UPDATE dypos.currency_rates SET valid_to = COALESCE(${asOf ?? null}::timestamptz, NOW())
       WHERE tenant_id = ${tenant} AND from_currency = ${F} AND to_currency = ${T}
         AND id <> ${id} AND valid_to IS NULL`;
      return json({ item: inserted[0] }, 201);
    }
  }

  // Not one of this module's paths — hand the path back to the Worker's table.
  return null;
}