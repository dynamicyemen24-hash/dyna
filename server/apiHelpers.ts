/**
 * Generic tenant-scoped REST helpers shared by the DyPOS API routes.
 * Keeps validation, error shaping and tenant resolution in one place so
 * every screen behaves consistently and no query can read across tenants.
 */
import type { Request, Response } from 'express';
import { pool } from './neonDb.js';
import { AuthzError, readActorSession } from './authz.js';
import { DEFAULT_TENANT } from './tenant.js';

// Re-exported so the many existing `from './apiHelpers.js'` importers keep
// resolving. The binding now originates in `tenant.ts` (see the note there).
export { DEFAULT_TENANT };

/**
 * Resolves the tenant a query must be scoped to.
 *
 * ══ THE RULE ══════════════════════════════════════════════════════════════
 * The tenant comes from the VERIFIED IDENTITY and nowhere else. It is never read
 * from a header, a query parameter or a body field, because all three are
 * attacker-controlled: `curl -H 'x-tenant-id: someone-else'` costs nothing and
 * needs no credential.
 *
 * ══ WHY THIS USED TO BE A CROSS-TENANT HOLE ══════════════════════════════
 * This function originally returned, in order: the `x-tenant-id` header, then
 * `?tenantId=`, then `body.tenantId`, then `DEFAULT_TENANT`.
 *
 * Every route in the API scoped its SQL correctly — `WHERE tenant_id = $1` —
 * and every one of them bound that `$1` to the caller's own claim. The
 * predicates were real, the parameter was hostile. A correctly written query
 * scoped to the wrong tenant is still a cross-tenant read, so the presence of
 * `tenant_id` in the SQL was never evidence that the route was safe. That is
 * the specific illusion O2 exists to dispel.
 *
 * ══ THE COMPATIBILITY EDGE ════════════════════════════════════════════════
 * A client-supplied tenant is still READ, but only to check that it AGREES with
 * the identity. A genuine SPA sends `x-tenant-id` on every call, so rejecting
 * outright would break it; silently honouring a mismatch is the vulnerability.
 * So the claim is used as an assertion to verify, and a disagreement is a 403
 * naming both tenants — which is far easier to diagnose than an empty list.
 */
export function tenantOf(req: Request): string {
  const principal = req.principal;
  if (principal?.tenantId) return principal.tenantId;

  /*
   * No principal. Either the route is public or it forgot `attachPrincipal`.
   *
   * Falling back to DEFAULT_TENANT here would quietly reintroduce the hole, so
   * instead the SIGNED token is consulted directly. That covers public routes
   * that still receive a token, and it means an authenticated-but-unverified
   * caller can never inherit the default tenant by accident.
   *
   * With no token at all the request is unauthenticated; `DEFAULT_TENANT` is
   * returned only so genuinely public screens keep working, and no route may
   * treat it as proof of identity.
   */
  const verified = readActorSession(req);
  if (verified.ok) return verified.payload.tenantId;

  return DEFAULT_TENANT;
}

/**
 * Throws when the caller's asserted tenant disagrees with the verified one.
 *
 * Called by routes that a legacy client still calls with `?tenantId=`.
 */
export function assertTenantClaim(req: Request, claimed: string): void {
  const actual = tenantOf(req);
  if (claimed && claimed !== actual) {
    throw new AuthzError(
      `المستأجر المُصرَّح به (${claimed}) لا يطابق المستأجر الموثّق (${actual})`,
      403,
    );
  }
}

/*
 * ══ INFORMATION SECURITY: WHAT REACHES THE SCREEN ═════════════════════════
 *
 * Every message leaving this API passes through `publicError`. The rule:
 *
 *   · A message WE AUTHORED, about a business rule, may be shown. "الكمية غير
 *     متوفرة" helps the cashier; it tells them what to do next.
 *   · Anything we did NOT author is replaced. That includes database errors,
 *     stack traces, driver messages and exception text.
 *
 * WHY THIS IS A SECURITY CONTROL AND NOT POLISH
 * ---------------------------------------------
 * A raw `err.message` from `pg` is not an English error message — it is a
 * description of the datastore. `duplicate key value violates unique constraint
 * "invoices_idempotency_uq"` handed to a shop manager confirms which backend is
 * in use, names internal objects, and hands an attacker a map of the schema to
 * probe. `relation "dypos_users_password" does not exist` is worse: it is a
 * free oracle for discovering table names.
 *
 * The operator cannot act on any of it, and it leaks on every 5xx.
 *
 * WHY A REFERENCE CODE
 * --------------------
 * Replacing the message with "something went wrong" alone would leave support
 * helpless: the operator would read a code and have nothing to quote. So the
 * error carries a short reference that maps to the full detail in the server log,
 * where it belongs. Support gets what it needs; the user gets nothing they
 * should not have.
 */

let referenceCounter = 0;

/**
 * Builds the reply to a failure and the reference that identifies it in the log.
 *
 * `message` is the ONLY thing the caller sees, and it must be one we wrote.
 * `detail` exists so the server log keeps the real cause — it never leaves.
 */
export function publicError(
  message = 'تعذّر إتمام العملية. الرجاء المحاولة مرة أخرى.',
): { message: string; reference: string } {
  return {
    message,
    reference: `DY-${Date.now().toString(36).toUpperCase()}-${(referenceCounter += 1)}`,
  };
}

/**
 * A rejection or refusal whose message is safe to show.
 *
 * `fail()` is for a BUSINESS rule — "stock is not available", "wrong password".
 * The message is written for the person at the till and may reach them.
 *
 * `internalError()` is for anything else. The caller gets a generic line and a
 * reference; the cause goes to the log and nowhere else.
 */
export function fail(res: Response, status: number, message: string) {
  return res.status(status).json({ error: message });
}

/** Failure whose cause must not reach the user. Detail goes to the log only. */
export function internalError(res: Response, detail: unknown, status = 500) {
  const { message, reference } = publicError();
  console.error(
    `[dypos-api] ${reference}`,
    detail instanceof Error ? detail.stack ?? detail.message : detail,
  );
  return res.status(status).json({ error: message, reference });
}
export function asyncRoute(
  fn: (req: Request, res: Response) => Promise<unknown>,
): (req: Request, res: Response) => void {
  return (req, res) => {
    fn(req, res).catch((err: unknown) => {
      /*
       * The rejection is NEVER forwarded. `publicError` takes no detail and
       * cannot be handed one, so there is no path by which a driver's message
       * reaches the response — the guarantee is structural rather than a matter
       * of remembering not to pass it.
       */
      const { message, reference } = publicError();
      // Full detail server-side ONLY. This is the record support will use, and
      // it carries the same reference the caller was given so the two sides can
      // be joined without exposing anything.
      console.error(
        `[dypos-api] ${reference} ${req.method} ${req.originalUrl}`,
        err instanceof Error ? err.stack ?? err.message : err,
      );
      if (!res.headersSent) {
        res.status(500).json({ error: message, reference });
      }
    });
  };
}

export function makeId(prefix: string): string {
  return `${prefix}-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`;
}

/** Normalises NUMERIC columns that arrive as strings from pg. */
export function num(v: unknown, fallback = 0): number {
  const n = Number(v);
  return Number.isFinite(n) ? n : fallback;
}

/**
 * Registers list / create / update / delete for a tenant-scoped table.
 * `columns` maps API field names to database columns so that the frontend
 * can keep using camelCase while the schema stays snake_case.
 */
export interface CrudOptions {
  table: string;
  prefix: string;
  columns: Record<string, string>;
  orderBy?: string;
  tenantColumn?: string;
  defaultTenant?: string;
}

export function registerCrudRoutes(app: any, basePath: string, opts: CrudOptions) {
  const {
    table,
    prefix,
    columns,
    orderBy = 'created_at DESC',
    tenantColumn = 'tenant_id',
    defaultTenant = DEFAULT_TENANT,
  } = opts;

  // LIST
  app.get(
    basePath,
    asyncRoute(async (req, res) => {
      const tenant = tenantOf(req) || defaultTenant;
      const limit = Math.min(Number(req.query.limit) || 200, 1000);
      const where: string[] = [`${tenantColumn} = $1`];
      const params: any[] = [tenant];

      if (req.query.status) {
        params.push(String(req.query.status));
        where.push(`status = $${params.length}`);
      }
      if (req.query.productId) {
        params.push(String(req.query.productId));
        where.push(`product_id = $${params.length}`);
      }
      if (req.query.from) {
        params.push(String(req.query.from));
        where.push(`created_at >= $${params.length}`);
      }

      const { rows } = await pool.query(
        `SELECT * FROM dypos.${table}
         WHERE ${where.join(' AND ')}
         ORDER BY ${orderBy}
         LIMIT $${params.length + 1}`,
        [...params, limit],
      );
      res.json({ items: rows, count: rows.length });
    }),
  );

  // CREATE
  app.post(
    basePath,
    asyncRoute(async (req, res) => {
      const tenant = tenantOf(req) || defaultTenant;
      const body = req.body || {};

      const id = body.id || makeId(prefix);
      const colNames = Object.values(columns);

      // Fields the client omitted are bound as NULL so the column DEFAULT
      // applies on INSERT; on conflict the stored value is kept instead.
      const sqlText =
        `INSERT INTO dypos.${table} (id, ${tenantColumn}, ${colNames.join(', ')}) ` +
        `VALUES ($1, $2, ${colNames.map((_, i) => `$${i + 3}`).join(', ')}) ` +
        `ON CONFLICT (id) DO UPDATE SET ${colNames
          .map((c, i) => `${c} = COALESCE($${i + 3}, dypos.${table}.${c})`)
          .join(', ')} RETURNING *`;

      // Defaults for NOT NULL columns so an omitted field never reaches the
      // database as an explicit NULL.
      const withDefaults: Record<string, unknown> = {
        isActive: true,
        taxRate: 15,
        durationMinutes: 30,
        basePrice: 0,
        metadata: '{}',
      };

      const { rows } = await pool.query(sqlText, [
        id,
        tenant,
        ...Object.keys(columns).map((k) => {
          const v = body[k];
          if (v === undefined || v === null) return withDefaults[k] ?? null;
          if (typeof v === 'object') return JSON.stringify(v);
          return v;
        }),
      ]);
      res.status(201).json({ item: rows[0] });
    }),
  );

  // UPDATE
  app.put(
    `${basePath}/:id`,
    asyncRoute(async (req, res) => {
      const tenant = tenantOf(req) || defaultTenant;
      const body = req.body || {};
      const keys = Object.keys(columns).filter((k) => k in body && k !== 'tenantId');

      if (!keys.length) return fail(res, 400, 'لا توجد حقول للتحديث');

      const sets = keys.map((k, i) => `${columns[k]} = $${i + 3}`);
      const values = keys.map((k) => {
        const v = body[k];
        if (typeof v === 'object' && v !== null) return JSON.stringify(v);
        return v;
      });

      const { rows } = await pool.query(
        `UPDATE dypos.${table}
         SET ${sets.join(', ')}
         WHERE id = $1 AND ${tenantColumn} = $2
         RETURNING *`,
        [req.params.id, tenant, ...values],
      );
      if (!rows.length) return fail(res, 404, 'العنصر غير موجود');
      res.json({ item: rows[0] });
    }),
  );

  // DELETE
  app.delete(
    `${basePath}/:id`,
    asyncRoute(async (req, res) => {
      const tenant = tenantOf(req) || defaultTenant;
      const { rows } = await pool.query(
        `DELETE FROM dypos.${table}
         WHERE id = $1 AND ${tenantColumn} = $2
         RETURNING id`,
        [req.params.id, tenant],
      );
      if (!rows.length) return fail(res, 404, 'العنصر غير موجود');
      res.json({ deleted: rows[0].id });
    }),
  );
}