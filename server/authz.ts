import type { Express, NextFunction, Request, Response } from 'express';
import { verifySessionToken, type VerifyResult } from './sessions.js';
import { pool } from './neonDb.js';
import { DEFAULT_TENANT } from './tenant.js';
import { internalError } from './apiHelpers.js';

/**
 * The routes that may be reached WITHOUT a session.
 *
 * ══ WHY THIS LIST IS SO SHORT, AND WHY IT IS AN ALLOWLIST ═════════════════
 * Every other `/api/**` route requires a session. The gate is default-DENY: a
 * route is open because it was named here, not because nobody remembered to
 * lock it.
 *
 * A per-route `attachPrincipal` on each handler is the pattern this replaces,
 * and it fails in the worst possible direction. It depends on every developer
 * remembering, on every one of ~40 routes, forever. One omission is a
 * cross-tenant read or an unauthenticated write, and it looks exactly like every
 * other route in the file — so neither review nor a scan can see it.
 *
 * Thirty-eight routes had no such middleware. Production happened to be safe
 * because the Cloudflare Worker checks the token before proxying — but the SAME
 * Express app is what `npm start` runs, which is the on-premise and local
 * deployment path. There, all thirty-eight were open. That gap between "the
 * front door has a guard" and "the rooms are locked" is precisely the class of
 * defect that survives review.
 *
 * An allowlist makes the safe state the default one. Adding an endpoint to this
 * file is a deliberate, visible act; forgetting a guard is no longer possible.
 *
 * WHY THESE SPECIFIC ROUTES
 * ------------------------
 *   · login / mfa verify / break-glass / reset-password / password-policy —
 *     the credential-issuing endpoints. Requiring a session to obtain one is
 *     circular.
 *   · unlock — a session-holder proving they can re-open their own terminal.
 *
 * `change-password` is deliberately NOT here: it already carries its own
 * `attachPrincipal`, and it is a credential change — the case where a session is
 * the very thing being protected.
 */
const PUBLIC_API_ROUTES = new Set<string>([
  '/api/auth/login',
  '/api/auth/mfa/verify',
  '/api/auth/break-glass',
  '/api/auth/reset-password',
  '/api/auth/password-policy',
  '/api/auth/unlock',
]);

/**
 * Installs the default-deny gate. MUST be called before any route is
 * registered, since it terminates the request when it applies.
 *
 * `attachPrincipal` is deliberately NOT reused here. That helper resolves a
 * full principal — roles, permissions, branches — and every business route needs
 * it. This gate only needs to answer one question: is there a session? A route
 * that wants permissions adds `requirePermission` on itself.
 */
export function requireSessionByDefault(app: Express): void {
  app.use((req: Request, res: Response, next: NextFunction) => {
    if (!req.path.startsWith('/api/')) return next();
    if (PUBLIC_API_ROUTES.has(req.path)) return next();

    const header = req.header('authorization') || '';
    const bearer = /^Bearer\s+(.+)$/i.exec(header)?.[1];
    const verified = verifySessionToken((bearer || '').trim());

    if (!verified.ok) {
      /*
       * One message and one status for every failure — no token, malformed,
       * bad signature, expired. Distinguishing them would tell a caller which
       * keys are worth trying, and none of it helps a legitimate operator whose
       * session simply ended.
       */
      return res.status(401).json({ error: 'بيانات الدخول غير صحيحة' });
    }
    next();
  });
}

/**
 * Role-based access control resolved the way Microsoft Dynamics does it:
 * a user holds one or more roles, each granting permissions, and the grants
 * are unioned. An explicit `deny` always beats an `allow`, so a senior role
 * can carve an exception out of a junior one without revoking it globally.
 */

export interface Principal {
  userId: string;
  username: string;
  name: string;
  /**
   * The tenant this identity belongs to, taken from the SIGNED session token.
   *
   * This field did not exist, and its absence is why `tenantOf()` had to read a
   * tenant out of a request header. Without a tenant on the identity, the only
   * tenant a route could scope its query to was one the caller named — so any
   * authenticated user could read any tenant's data by sending a different
   * `x-tenant-id`. Every `WHERE tenant_id = $1` in the codebase was, in that
   * state, decorative: it scoped correctly to whatever the caller asked for.
   */
  tenantId: string;
  roles: Array<{ id: string; code: string; name: string; sodGroup: string | null }>;
  /** Effective permission set after allow/deny resolution. */
  permissions: Set<string>;
  /** Branch ids the user may read. Empty means tenant-wide. */
  branchIds: string[];
  isSuperuser: boolean;
}

/**
 * `attachPrincipal` stores the resolved identity on the request, but Express
 * types `Request` with no such field, so every route that read `req.principal`
 * failed to type-check. Declaring the augmentation here keeps the property
 * typed everywhere instead of scattering casts through the route files.
 */
declare global {
  // eslint-disable-next-line @typescript-eslint/no-namespace
  namespace Express {
    interface Request {
      principal?: Principal;
    }
  }
}

export class AuthzError extends Error {
  status: number;
  constructor(message: string, status = 403) {
    super(message);
    this.status = status;
    this.name = 'AuthzError';
  }
}

/** Resolves the caller's roles, permissions and branch scope. */
export async function resolvePrincipal(
  username: string,
  tenantId = DEFAULT_TENANT,
): Promise<Principal> {
  const { rows } = await pool.query(
    `WITH grants AS (
       SELECT ur.user_id,
              json_agg(rp.permission ORDER BY rp.permission) FILTER (WHERE rp.effect = 'allow')  AS allows,
              json_agg(rp.permission ORDER BY rp.permission) FILTER (WHERE rp.effect = 'deny')   AS denies
       FROM dypos.user_roles ur
       JOIN dypos.role_permissions rp ON rp.role_id = ur.role_id
       GROUP BY ur.user_id
     )
     SELECT u.id, u.username, u.name,
            COALESCE(
              (SELECT json_agg(json_build_object(
                        'id', r.id, 'code', r.code, 'name', r.name, 'sodGroup', r.sod_group)
                       ORDER BY r.code)
                 FROM dypos.user_roles ur2
                 JOIN dypos.roles r ON r.id = ur2.role_id
                WHERE ur2.user_id = u.id),
              '[]') AS roles,
            COALESCE(g.allows, '[]') AS allow_list,
            COALESCE(g.denies, '[]') AS deny_list,
            COALESCE(
              (SELECT json_agg(uba.branch_id) FROM dypos.user_branch_access uba
                WHERE uba.user_id = u.id),
              '[]') AS branch_ids
     FROM dypos.users u
     LEFT JOIN grants g ON g.user_id = u.id
     WHERE u.tenant_id = $1 AND u.username = $2 AND u.is_active = TRUE`,
    [tenantId, username],
  );

  const row = rows[0];
  if (!row) throw new AuthzError('المستخدم غير مصرح له أو غير نشط', 401);

  const allows: string[] = row.allow_list || [];
  const denies: string[] = row.deny_list || [];

  // A wildcard grant means the role covers the entire permission surface.
  const isSuperuser = allows.includes('*');

  return {
    userId: row.id,
    username: row.username,
    name: row.name,
    tenantId,
    roles: row.roles || [],
    permissions: new Set(allows.filter((p) => p !== '*' && !denies.includes(p))),
    branchIds: row.branch_ids || [],
    isSuperuser,
  };
}

/**
 * Reads the acting user.
 *
 * The identity comes from a signed session token, never from a name the caller
 * chose. `Authorization: Bearer <token>` is the only accepted channel. A plain
 * username — in a header, the body, or the query string — is refused, because
 * that is exactly the shape an attacker would send to borrow someone else's
 * role.
 */
export function readActor(req: Request): string {
  const verified = readActorSession(req);
  return verified.ok ? verified.payload.username : '';
}

/**
 * The verified session for this request, or a refusal.
 *
 * Kept separate from `readActor` because the TENANT has to come from the signed
 * payload too. Returning only the username — as this function used to — forced
 * callers to source the tenant from somewhere unverified.
 */
export function readActorSession(req: Request): VerifyResult {
  const header = req.header('authorization') || '';
  const bearer = /^Bearer\s+(.+)$/i.exec(header)?.[1];
  return verifySessionToken((bearer || '').trim());
}

export async function attachPrincipal(req: Request, _res: Response, next: NextFunction) {
  try {
    const verified = readActorSession(req);
    if (!verified.ok) throw new AuthzError('مطلوب تحديد المستخدم المنفّذ', 401);

    /*
     * The tenant is taken from the SIGNED payload and is passed into the lookup,
     * so the user row must actually belong to that tenant. A token minted for
     * tenant A therefore cannot resolve a principal in tenant B even if the
     * username matches — the pairing is verified in SQL, not assumed.
     */
    req.principal = await resolvePrincipal(verified.payload.username, verified.payload.tenantId);
    next();
  } catch (e) {
    next(e);
  }
}

/** True when the principal holds the permission, or is a superuser. */
export function can(p: Principal | undefined, permission: string): boolean {
  if (!p) return false;
  return p.isSuperuser || p.permissions.has(permission);
}

/**
 * Route guard. `permission` may be a single code or several, where holding any
 * one of them is sufficient.
 */
export function requirePermission(...permissions: string[]) {
  return async (req: Request, _res: Response, next: NextFunction) => {
    try {
      const p = req.principal;
      if (!p) throw new AuthzError('جلسة غير موثقة', 401);
      if (!(p.isSuperuser || permissions.some((perm) => p.permissions.has(perm)))) {
        throw new AuthzError(`الصلاحية غير كافية — يتطلب: ${permissions.join(' أو ')}`, 403);
      }
      next();
    } catch (e) {
      next(e);
    }
  };
}

/**
 * Guards against a user combining two roles from the same segregation-of-duties
 * group, which together would allow self-approval.
 */
export function assertNoSodConflict(p: Principal): void {
  const groups = p.roles.map((r) => r.sodGroup).filter(Boolean) as string[];
  const dupes = groups.filter((g, i) => groups.indexOf(g) !== i);
  if (dupes.length) {
    throw new AuthzError(
      `تعارض فصل المهام: الأدوار الحالية تنتمي لمجموعة "${dupes[0]}" — يرجى مراجعة الصلاحيات`,
      409,
    );
  }
}

/** Ensures the principal may act on the given branch. */
export function assertBranchAccess(p: Principal | undefined, branchId?: string | null): void {
  if (!p || !branchId || p.branchIds.length === 0) return; // tenant-wide
  if (!p.branchIds.includes(branchId)) {
    throw new AuthzError('لا تملك صلاحية الوصول لهذا الفرع', 403);
  }
}

/** Registers the RBAC endpoints. */
export function registerAuthzRoutes(app: Express) {
  /** Effective permissions for the calling user — drives UI gating. */
  app.get('/api/erp/me', async (req, res) => {
    try {
      const p = await resolvePrincipal(readActor(req));
      res.json({
        userId: p.userId,
        username: p.username,
        name: p.name,
        roles: p.roles,
        permissions: [...p.permissions].sort(),
        isSuperuser: p.isSuperuser,
        branchIds: p.branchIds,
      });
    } catch (e: any) {
      /*
       * An `AuthzError` message is OURS — "المستخدم غير مصرح له", "الصلاحية غير
       * كافية" — and tells the operator what to do next, so it is shown.
       *
       * But the clause catches `any`, so an unexpected error can arrive here too,
       * and THAT text is a description of our internals. Previously the branch
       * sent `e.message` either way, so a database failure during a permission
       * lookup answered with the database's own words.
       */
      if (e instanceof AuthzError) {
        return res.status(e.status || 401).json({ error: e.message });
      }
      return internalError(res, e, e?.status === 403 ? 403 : 401);
    }
  });

  /** Role catalogue with member counts. */
  app.get('/api/erp/roles', async (_req, res) => {
    try {
      const { rows } = await pool.query(
        `SELECT r.id, r.code, r.name, r.description, r.is_system, r.sod_group,
                (SELECT count(*)::int FROM dypos.role_permissions rp
                  WHERE rp.role_id = r.id) AS permission_count,
                (SELECT count(DISTINCT ur.user_id)::int FROM dypos.user_roles ur
                  WHERE ur.role_id = r.id) AS member_count
         FROM dypos.roles r
         WHERE r.tenant_id = $1 AND r.is_active = TRUE
         ORDER BY r.code`,
        [DEFAULT_TENANT],
      );
      res.json({ items: rows });
    } catch (e: any) {
      internalError(res, e);
    }
  });

  /** Detailed grant matrix for one role. */
  app.get('/api/erp/roles/:id/permissions', async (req, res) => {
    try {
      const { rows } = await pool.query(
        `SELECT permission, effect FROM dypos.role_permissions
         WHERE role_id = $1 ORDER BY permission`,
        [req.params.id],
      );
      res.json({ items: rows });
    } catch (e: any) {
      internalError(res, e);
    }
  });

  /** Who holds which role — the segregation-of-duties view. */
  app.get('/api/erp/role-assignments', async (_req, res) => {
    try {
      const { rows } = await pool.query(
        `SELECT u.username, u.name AS user_name, u.is_active,
                r.code AS role_code, r.name AS role_name, r.sod_group
         FROM dypos.user_roles ur
         JOIN dypos.users u ON u.id = ur.user_id
         JOIN dypos.roles r ON r.id = ur.role_id
         WHERE u.tenant_id = $1
         ORDER BY u.username, r.code`,
        [DEFAULT_TENANT],
      );
      res.json({ items: rows });
    } catch (e: any) {
      internalError(res, e);
    }
  });

  /** Self-check endpoint used by the UI to prove a guard works. */
  app.get('/api/erp/me/can/:permission', async (req, res) => {
    try {
      const p = await resolvePrincipal(readActor(req));
      res.json({ permission: req.params.permission, allowed: can(p, req.params.permission) });
    } catch (e: any) {
      if (e instanceof AuthzError) {
        return res.status(e.status || 401).json({ error: e.message });
      }
      return internalError(res, e, e?.status === 403 ? 403 : 401);
    }
  });
}
