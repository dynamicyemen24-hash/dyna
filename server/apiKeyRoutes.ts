import type { Express } from 'express';
import { asyncRoute, tenantOf, fail, internalError } from './apiHelpers.js';
import { attachPrincipal, requirePermission, readActor } from './authz.js';
import { createKey, listKeys, revokeKey, verifyKey, type ApiKeyScope } from './apiKeys.js';

/**
 * Subscriber self-service: issue, list and revoke API keys, and authenticate
 * with one.
 *
 * ══ WHO MAY DO WHAT ═══════════════════════════════════════════════════════
 * Issuing a credential is a privileged act, so it needs a permission. Revoking
 * one is deliberately allowed to a different holder than issuance would imply —
 * a manager must be able to cut off a key they did not create, which is the
 * action an incident actually requires.
 *
 * ══ WHAT THE USER IS TOLD ════════════════════════════════════════════════
 * Key-shaped things are exactly where a careless implementation leaks. Nothing
 * here ever returns a hash, and the only time the plaintext exists is the
 * response to the create call — which is also the only moment it can be
 * delivered. The response says so explicitly, because "show me my key again" is
 * a request that can never be satisfied and the error should not imply a
 * configuration problem.
 */
export function registerApiKeyRoutes(app: Express) {
  app.get('/api/keys', attachPrincipal, requirePermission('ledger.view'),
    asyncRoute(async (req, res) => {
      const tenant = tenantOf(req);
      try {
        res.json({ items: await listKeys(tenant) });
      } catch (err) {
        internalError(res, err);
      }
    }));

  app.post('/api/keys', attachPrincipal, requirePermission('ledger.post'),
    asyncRoute(async (req, res) => {
      const tenant = tenantOf(req);
      const b = (req.body || {}) as { label?: string; scopes?: ApiKeyScope[] };
      const label = typeof b.label === 'string' ? b.label.trim() : '';

      if (!label) return fail(res, 400, 'يلزم اسم للمفتاح — يوضّح أين يُستخدم');
      if (label.length > 128) return fail(res, 400, 'اسم المفتاح طويل جداً');

      /*
       * Scopes are intersected with the permitted set rather than trusted.
       * A caller cannot widen its own authority by asking for `write` when the
       * product only offers `read`.
       */
      const requested = Array.isArray(b.scopes) ? b.scopes : ['read'];
      const scopes = requested.filter(
        (s): s is ApiKeyScope => s === 'read' || s === 'write',
      );
      if (scopes.length === 0) return fail(res, 400, 'صلاحيات المفتاح غير صالحة');

      try {
        const issued = await createKey(tenant, label, scopes, readActor(req));
        res.status(201).json({
          item: issued,
          /*
           * Said plainly because it is the single most important fact about this
           * screen: this key cannot be shown again.
           */
          notice: 'انسخ المفتاح الآن — لن يُعرض مرة أخرى، ولا يمكن استرجاعه.',
        });
      } catch (err) {
        internalError(res, err);
      }
    }));

  app.delete('/api/keys/:id', attachPrincipal, requirePermission('ledger.post'),
    asyncRoute(async (req, res) => {
      const tenant = tenantOf(req);
      try {
        const revoked = await revokeKey(tenant, req.params.id, readActor(req));
        if (!revoked) {
          // Either it does not exist, belongs to another tenant, or was already
          // revoked. All three answer the same way, so this endpoint cannot be
          // used to discover which key ids exist.
          return fail(res, 404, 'المفتاح غير موجود أو مفعّل مسبقاً');
        }
        res.json({ ok: true });
      } catch (err) {
        internalError(res, err);
      }
    }));

  /*
   * ══ AUTHENTICATING WITH A KEY ═══════════════════════════════════════════
   * `GET /api/keys/whoami` proves a key works and reports what it is bound to.
   *
   * It exists because a key owner has no other way to find out whether the key
   * they were issued is the key their integration is sending, or whether it was
   * revoked. Diagnosing that blind is the failure mode this endpoint removes.
   *
   * A key identifies a TENANT, not a person. It therefore cannot carry a
   * principal, and it grants no human permissions — `scopes` bound what the
   * integration may do, and every business route still applies its own rules.
   */
  app.get('/api/keys/whoami', asyncRoute(async (req, res) => {
    const header = req.header('authorization') || '';
    const bearer = /^Bearer\s+(.+)$/i.exec(header)?.[1] ?? '';
    const presented = bearer.startsWith('dypos_') ? bearer : '';

    if (!presented) {
      return fail(res, 401, 'يلزم مفتاح واجهة برمجية');
    }

    try {
      const resolved = await verifyKey(presented);
      // Unknown, revoked and inactive are one answer. Distinguishing them would
      // tell a caller whether a key they once held is merely revoked or was
      // never valid — which is enumeration, not an error message.
      if (!resolved) return fail(res, 401, 'المفتاح غير صالح أو مفعّل');
      res.json({
        tenantId: resolved.tenantId,
        keyId: resolved.keyId,
        scopes: resolved.scopes,
        // No tenant NAME and no plan here. A key proves which tenant; it is not
        // a licence to read that tenant's commercial details.
      });
    } catch (err) {
      internalError(res, err);
    }
  }));
}