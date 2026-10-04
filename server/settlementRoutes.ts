import type { Express } from 'express';
import { asyncRoute, tenantOf, fail, makeId } from './apiHelpers.js';
import { attachPrincipal, requirePermission } from './authz.js';
import { pool } from './neonDb.js';

/**
 * Bank settlement accounts — where a tenant's money is actually instructed to go.
 *
 * ══ WHY THIS ROUTE EXISTS ═══════════════════════════════════════════════════
 * The bank-transfer panel on the till printed a real IBAN from a JavaScript
 * literal, and `generateSarieIbanQr` carried the same value as a DEFAULT
 * PARAMETER ARGUMENT. Two defects in one line:
 *
 *   1. Every merchant's takings were routed to one account belonging to one
 *      organisation. The cashier reads the IBAN aloud and the customer transfers.
 *   2. The default argument made it invisible to review — the signature looked
 *      correct and the IBAN was not even a parameter.
 *
 * Migration v147 gives each tenant its own accounts. This module is the only
 * place they are read or written, so "which account does this tenant settle to"
 * has exactly one answer in the system.
 *
 * ══ READS vs WRITES ════════════════════════════════════════════════════════
 * A till READS an account to show a QR; it must never be able to WRITE one. An
 * account is where money goes, so creating or changing it is a
 * `settings.manage` act — the same permission that governs the tax identity on
 * a receipt, for the same reason.
 *
 * Reads require only a session. That is deliberate and is not a leak: the route
 * is scoped by `tenantOf(req)`, which the server derives from the signed token,
 * so a caller can only ever reach their own tenant's account. A tenant reading
 * their own IBAN is the feature, not the vulnerability.
 */
export function registerSettlementRoutes(app: Express) {
  /**
   * The accounts this tenant may offer at the till.
   *
   * `paymentMethod` narrows to one channel, and an inactive account never
   * appears — a deactivated account must stop being *displayed*, not merely stop
   * being *preferred*, or a merchant who disabled one would keep collecting
   * money into it.
   */
  app.get('/api/db/settlement/accounts', attachPrincipal,
    asyncRoute(async (req, res) => {
      const tenant = tenantOf(req);
      const paymentMethod = typeof req.query.paymentMethod === 'string'
        ? req.query.paymentMethod
        : null;

      const { rows } = await pool.query(
        `SELECT id, branch_id AS "branchId", iban, bank_name AS "bankName",
                holder_name AS "holderName", swift_bic AS "swiftBic",
                country_code AS "countryCode", payment_method AS "paymentMethod",
                is_default AS "isDefault"
           FROM dypos.bank_settlement_accounts
          WHERE tenant_id = $1
            AND is_active
            AND ($2::text IS NULL OR payment_method = $2)
          ORDER BY is_default DESC, bank_name NULLS LAST, created_at`,
        [tenant, paymentMethod],
      );

      /*
       * An empty list is the honest answer when nothing is configured, and the
       * till treats it as "do not offer bank transfer" rather than falling back
       * to an account it once shipped. That is the whole point of this route.
       */
      res.json({ items: rows, count: rows.length });
    }),
  );

  /** Creates a settlement account for the caller's tenant. */
  app.post('/api/db/settlement/accounts', attachPrincipal, requirePermission('settings.manage'),
    asyncRoute(async (req, res) => {
      const tenant = tenantOf(req);
      const b = req.body ?? {};

      // Spaces are stripped because operators paste IBANs as "SA03 8000 …".
      // Upper-cased because the format is defined in upper case and a lower-case
      // variant would otherwise be stored as a different-looking account.
      const iban = String(b.iban ?? '').trim().replace(/\s+/g, '').toUpperCase();
      if (!iban) return fail(res, 400, 'الرقم الآيبان مطلوب');

      const id = b.id || makeId('bank');
      const { rows } = await pool.query(
        `INSERT INTO dypos.bank_settlement_accounts
           (id, tenant_id, branch_id, iban, bank_name, holder_name,
            swift_bic, country_code, payment_method, is_active, is_default)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11)
         ON CONFLICT (id) DO UPDATE SET
           iban = EXCLUDED.iban,
           bank_name = EXCLUDED.bank_name,
           holder_name = EXCLUDED.holder_name,
           swift_bic = EXCLUDED.swift_bic,
           country_code = EXCLUDED.country_code,
           payment_method = EXCLUDED.payment_method,
           is_active = EXCLUDED.is_active,
           is_default = EXCLUDED.is_default,
           updated_at = NOW()
         RETURNING id, iban, bank_name AS "bankName", holder_name AS "holderName",
                   payment_method AS "paymentMethod", is_active AS "isActive",
                   is_default AS "isDefault"`,
        [
          id, tenant,
          b.branchId ?? null, iban,
          b.bankName ?? null, b.holderName ?? null,
          b.swiftBic ?? null, b.countryCode ?? null,
          b.paymentMethod ?? 'bank_transfer',
          b.isActive !== false, Boolean(b.isDefault),
        ],
      );
      res.status(201).json({ item: rows[0] });
    }),
  );

  /**
   * Updates an account.
   *
   * Deactivation is `is_active = FALSE`, never `DELETE`: an account that received
   * settlements must stay resolvable, or historical transfers can no longer be
   * traced back to a destination. Soft-disable is also what stops the till
   * offering it.
   */
  app.put('/api/db/settlement/accounts/:id', attachPrincipal, requirePermission('settings.manage'),
    asyncRoute(async (req, res) => {
      const tenant = tenantOf(req);
      const b = req.body ?? {};

      const { rows } = await pool.query(
        `UPDATE dypos.bank_settlement_accounts
            SET is_active = COALESCE($3, is_active),
                is_default = COALESCE($4, is_default),
                bank_name = COALESCE($5, bank_name),
                holder_name = COALESCE($6, holder_name),
                updated_at = NOW()
          WHERE id = $1 AND tenant_id = $2
          RETURNING id, iban, bank_name AS "bankName", is_active AS "isActive",
                    is_default AS "isDefault"`,
        [req.params.id, tenant, b.isActive ?? null, b.isDefault ?? null,
         b.bankName ?? null, b.holderName ?? null],
      );

      // Scoped by `tenant_id` as well as `id`, so another tenant's id returns
      // 404 rather than confirming that the id exists.
      if (!rows.length) return fail(res, 404, 'الحساب البنكي غير موجود');
      res.json({ item: rows[0] });
    }),
  );
}