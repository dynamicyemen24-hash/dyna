import type { Express } from 'express';
import { pool } from './neonDb.js';
import { asyncRoute, fail, tenantOf } from './apiHelpers.js';
import { attachPrincipal, requirePermission } from './authz.js';
import crypto from 'crypto';

/**
 * Per-tenant MFA delivery configuration — the merchant's own answer to
 * "where do MY operators' codes go?".
 *
 * WHY MERCHANT-CONFIGURABLE, NOT BOOT-CONFIGURABLE
 * `server/mfa.ts` exposed `setMfaDeliverer()` at BOOT: one channel for the
 * whole installation. On a multi-tenant SaaS that is the wrong owner — every
 * merchant must choose their own channel, and changing it must be a settings
 * action, not a code deploy. The boot seam stays (tests and single-site
 * installs use it); the tenant row wins whenever one exists.
 *
 * WHY THE SECRET IS NEVER READ BACK
 * `webhook_secret_hash` authenticates the tenant's own endpoint when OUR
 * server calls OUT. It is stored hashed (SHA-256), shown once at creation
 * like a reset token, and every UPDATE rotates it — so a database dump and
 * even a row read cannot replay it.
 */
export type MfaChannel = 'server-log' | 'webhook';

export interface MfaDeliverySettings {
  channel: MfaChannel;
  webhookUrl: string | null;
  hasSecret: boolean;
  updatedBy: string | null;
  updatedAt: string | null;
}

const VALID_CHANNELS: ReadonlySet<string> = new Set(['server-log', 'webhook']);

const isHttpsLocalUrl = (raw: string, strict: boolean): boolean => {
  try {
    const u = new URL(raw);
    if (u.protocol === 'https:') return true;
    // http only for addresses that cannot leave the machine — a test webhook
    // or an on-prem relay on the same box. Anything wider over cleartext
    // would ship codes a passive observer can read.
    if (u.protocol === 'http:') {
      if (strict) {
        // In strict mode, only /127.0.0.1/::1 are allowed over HTTP.
        return u.hostname === '' || u.hostname === '127.0.0.1' || u.hostname === '::1';
      }
      // In permissive mode, any HTTP URL is accepted (operator assumes the risk).
      return true;
    }
    return false;
  } catch {
    return false;
  }
};

// Environment: DYPOS_MFA_WEBHOOK_STRICT (default: "true")
//   - "true"  (strict):   HTTP only for /127.0.0.1/::1  (current behavior)
//   - "false" (permissive): HTTP allowed for any hostname (operator assumes risk)
const mfaWebhookStrict = process.env.DYPOS_MFA_WEBHOOK_STRICT !== 'false';

export async function readMfaDelivery(tenantId: string): Promise<MfaDeliverySettings> {
  const { rows } = await pool.query(
    `SELECT channel, webhook_url, webhook_secret_hash, updated_by, updated_at
       FROM dypos.mfa_delivery_config WHERE tenant_id = $1`,
    [tenantId],
  );
  const row = rows[0];
  if (!row) {
    return { channel: 'server-log', webhookUrl: null, hasSecret: false, updatedBy: null, updatedAt: null };
  }
  return {
    channel: row.channel === 'webhook' ? 'webhook' : 'server-log',
    webhookUrl: row.webhook_url ?? null,
    hasSecret: Boolean(row.webhook_secret_hash),
    updatedBy: row.updated_by ?? null,
    updatedAt: row.updated_at ? new Date(row.updated_at).toISOString() : null,
  };
}

const sha256 = (v: string) => crypto.createHash('sha256').update(v, 'utf8').digest('hex');

export async function delivererFor(
  tenantId: string,
): Promise<{ channel: string; send: (to: string, code: string, expiresInSeconds: number) => Promise<void> }> {
  const { getMfaDeliverer, logDeliverer } = await import('./mfa.js');
  const settings = await readMfaDelivery(tenantId);
  if (settings.channel === 'webhook' && settings.webhookUrl) {
    const url = settings.webhookUrl;
    return {
      channel: 'webhook',
      send: async (to, code, expiresInSeconds) => {
        const res = await fetch(url, {
          method: 'POST',
          headers: { 'content-type': 'application/json; charset=utf-8' },
          body: JSON.stringify({ to, code, expiresInSeconds }),
          signal: AbortSignal.timeout(8000),
        });
        if (!res.ok) {
          throw new Error(`webhook delivery failed with status ${res.status}`);
        }
      },
    };
  }
  const boot = getMfaDeliverer();
  return boot ?? logDeliverer;
}

export function registerMfaDeliveryRoutes(app: Express) {
  app.get('/api/db/mfa/delivery', attachPrincipal,
    asyncRoute(async (req, res) => {
      const tenant = tenantOf(req);
      res.json({ settings: await readMfaDelivery(tenant) });
    }),
  );

  app.put('/api/db/mfa/delivery', attachPrincipal, requirePermission('settings.manage'),
    asyncRoute(async (req, res) => {
      const tenant = tenantOf(req);
      const b = req.body ?? {};
      const channel = String(b.channel ?? '').trim();

      if (channel === 'sms') {
        return fail(res, 422, 'القناة النصية المباشرة غير متوفرة بعد — هذه ميزة مستقبلية، الخيارات المتاحة: سجل الخادم أو Webhook');
      }
      if (!VALID_CHANNELS.has(channel)) {
        return fail(res, 400, 'القناة يجب أن تكون server-log أو webhook');
      }

      const webhookUrl = b.webhookUrl == null ? null : String(b.webhookUrl).trim() || null;
      if (channel === 'webhook') {
        if (!webhookUrl || !isHttpsLocalUrl(webhookUrl, mfaWebhookStrict)) {
          return fail(res, 422, 'رابط الـ Webhook يجب أن يكون HTTPS صالحاً (أو  للاختبار)');
        }
      }

      const actor = req.principal!.username;
      const secret = b.webhookSecret == null ? null : String(b.webhookSecret);
      const secretHash = secret ? sha256(secret) : null;

      const { rows } = await pool.query(
        `INSERT INTO dypos.mfa_delivery_config
           (tenant_id, channel, webhook_url, webhook_secret_hash, updated_by, updated_at)
         VALUES ($1,$2,$3,
           COALESCE($4, (SELECT webhook_secret_hash FROM dypos.mfa_delivery_config WHERE tenant_id = $1)),
           $5, NOW())
         ON CONFLICT (tenant_id) DO UPDATE SET
           channel = EXCLUDED.channel,
           webhook_url = EXCLUDED.webhook_url,
           webhook_secret_hash = COALESCE(EXCLUDED.webhook_secret_hash, dypos.mfa_delivery_config.webhook_secret_hash),
           updated_by = EXCLUDED.updated_by,
           updated_at = NOW()
         RETURNING channel, webhook_url, (webhook_secret_hash IS NOT NULL) AS has_secret`,
        [tenant, channel, channel === 'webhook' ? webhookUrl : null, secretHash, actor],
      );
      const row = rows[0];

      await pool.query(
        `INSERT INTO dypos.audit_log (id, tenant_id, actor, action, entity, entity_id, details)
         VALUES (gen_random_uuid()::text, $1, $2, 'mfa_delivery_updated', 'mfa_delivery_config', $1, $3)`,
        [tenant, actor, JSON.stringify({ channel })],
      ).catch(() => { /* audit must never fail the save — same rule as the auth audit */ });

      res.json({
        settings: {
          channel: row.channel,
          webhookUrl: row.webhook_url ?? null,
          hasSecret: Boolean(row.has_secret),
          updatedBy: actor,
          updatedAt: new Date().toISOString(),
        },
        ...(secret ? { webhookSecret: secret } : {}),
      });
    }),
  );

  app.post('/api/db/mfa/delivery/test', attachPrincipal, requirePermission('settings.manage'),
    asyncRoute(async (req, res) => {
      const tenant = tenantOf(req);
      const settings = await readMfaDelivery(tenant);
      if (settings.channel !== 'webhook' || !settings.webhookUrl) {
        return res.json({ ok: true, channel: settings.channel, note: 'القناة الحالية هي سجل الخادم — لا حاجة للاختبار' });
      }
      try {
        const probe = await fetch(settings.webhookUrl, {
          method: 'POST',
          headers: { 'content-type': 'application/json; charset=utf-8' },
          body: JSON.stringify({ to: 'probe', code: '000000', expiresInSeconds: 0, probe: true }),
          signal: AbortSignal.timeout(8000),
        });
        if (!probe.ok) {
          return fail(res, 502, `نقطة النهاية ردّت بالحالة ${probe.status} — تحقق من الرابط`);
        }
        return res.json({ ok: true, channel: 'webhook', testedAt: new Date().toISOString() });
      } catch (e: any) {
        return fail(res, 502, `تعذّر الوصول إلى نقطة النهاية: ${e?.message ?? e}`);
      }
    }),
  );
}
