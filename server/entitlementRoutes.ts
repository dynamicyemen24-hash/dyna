import type { Express } from 'express';
import { pool } from './neonDb.js';
import { asyncRoute, fail } from './apiHelpers.js';
import { attachPrincipal, requirePermission } from './authz.js';
import {
  ALL_SCREEN_IDS, capabilitiesForProfile, resolveScreenEntitlement,
  isTabAllowed, getProfileById, industryProfiles,
} from '../src/config/industryProfiles.js';

/**
 * Entitlement resolution — the server side of the four-level licence check.
 *
 * THE FOUR LEVELS, RESOLVED IN ORDER
 * ----------------------------------
 *   1. SECTOR      dypos.tenants.industry_profile — what the subscriber
 *                  onboarded as.
 *   2. SUBSCRIPTION dypos.tenant_capabilities — the capability grants the
 *                  subscriber is entitled to, which is what a plan sells.
 *   3. BRANCH      dypos.branches × dypos.user_branch_access — *scope*, not
 *                  entitlement: it narrows which rows an allowed screen may
 *                  return and which branch the till may open.
 *   4. USER        dypos.roles → dypos.role_permissions — the effective grant
 *                  set after allow/deny resolution.
 *
 * The decision itself is made by `resolveScreenEntitlement`, which the client
 * and the Worker import from the same file. The API returns the *answer* (a
 * screen list) rather than the raw inputs, so the shell cannot render a screen
 * the server would refuse to serve.
 */
export function registerEntitlementRoutes(app: Express) {
  /**
   * The licence fact sheet for the signed-in user's organisation.
   *
   * Returns licensed screens (sector ∩ subscription) and allowed screens (∩
   * user permissions), plus an explanation for every withheld screen — so a
   * user who expected a module can see *why* it is absent instead of guessing.
   */
  app.get(
    '/api/erp/entitlements',
    attachPrincipal,
    asyncRoute(async (req, res) => {
      const p = req.principal!;
      const tenantId = p.tenantId;

      const [tenantRes, capsRes, catalogueRes, branchesRes] = await Promise.all([
        pool.query(
          `SELECT id, name, owner_company, brand_name, plan, is_active,
                  industry_profile, base_currency, country_code,
                  commercial_reg, tax_number
           FROM dypos.tenants WHERE id = $1`,
          [tenantId],
        ),
        pool.query(
          `SELECT tc.capability_id, tc.is_enabled, c.name_ar, c.name_en, c.category
           FROM dypos.tenant_capabilities tc
           LEFT JOIN dypos.capabilities c ON c.id = tc.capability_id
           WHERE tc.tenant_id = $1 AND tc.is_enabled = TRUE
           ORDER BY tc.capability_id`,
          [tenantId],
        ),
        pool.query(
          `SELECT id, name_ar, name_en, category FROM dypos.capabilities
           WHERE is_active = TRUE ORDER BY category, id`,
        ),
        pool.query(
          `SELECT id, name, city, phone, location AS address, '' AS manager
           FROM dypos.branches
           WHERE tenant_id = $1 AND is_active = TRUE
           ORDER BY name ASC`,
          [tenantId],
        ),
      ]);

      const tenant = tenantRes.rows[0];
      if (!tenant) return fail(res, 404, 'المؤسسة غير موجودة أو غير مفعّلة');

      const profileId = tenant.industry_profile || 'retail';

      // A tenant with no grant rows is NOT a denial — it simply was never
      // provisioned. Treating the empty set as authoritative is what once hid
      // every capability-gated screen, so the sector defaults are the fallback
      // and the answer says which path was taken.
      const grantsFromDatabase = capsRes.rows.length > 0;
      const capabilities = grantsFromDatabase
        ? capsRes.rows.map((r: any) => r.capability_id)
        : capabilitiesForProfile(profileId);

      const permissions = p.isSuperuser ? null : [...p.permissions];

      const entitlement = resolveScreenEntitlement({
        available: ALL_SCREEN_IDS,
        profileId,
        capabilities,
        permissions,
        isSuperuser: p.isSuperuser,
        grantsFromDatabase,
      });

      const branches = branchesRes.rows.map((b: any) => ({
        ...b,
        // An empty branch list on the user means tenant-wide, matching
        // `assertBranchAccess`.
        allowed: p.branchIds.length === 0 || p.branchIds.includes(b.id),
      }));

      res.json({
        authority: 'server',
        computedAt: new Date().toISOString(),

        tenant: {
          id: tenant.id,
          name: tenant.name,
          ownerCompany: tenant.owner_company,
          brandName: tenant.brand_name,
          plan: tenant.plan,
          isActive: tenant.is_active,
          baseCurrency: tenant.base_currency,
          countryCode: tenant.country_code,
          commercialReg: tenant.commercial_reg,
          taxNumber: tenant.tax_number,
        },

        sector: {
          id: profileId,
          nameAr: getProfileById(profileId).name_ar,
          nameEn: getProfileById(profileId).name_en,
          isProvisioned: Boolean(tenant.industry_profile),
        },

        capabilities,
        grantsFromDatabase,
        capabilityCatalogue: catalogueRes.rows,

        user: {
          username: p.username,
          name: p.name,
          roles: p.roles,
          isSuperuser: p.isSuperuser,
          permissions,
          branchIds: p.branchIds,
        },

        branches,

        screens: entitlement.allowed,
        licensedScreens: entitlement.licensed,
        inSectorScreens: entitlement.inSector,
        blockedScreens: entitlement.blocked,
      });
    }),
  );
}

/**
 * Switches the organisation's sector.
 *
 * Provisioning follows the sector: the capability grants are re-seeded from
 * the new profile's screen list, because a tenant licensed for a pharmacy that
 * switches to workshops must not keep selling prescriptions.
 */
export function registerTenantProfileRoutes(app: Express) {
  app.post(
    '/api/db/tenant/profile',
    attachPrincipal,
    requirePermission('settings.manage'),
    asyncRoute(async (req, res) => {
      const tenantId = req.principal!.tenantId;
      const profileId = String(req.body?.profileId || '');
      if (!industryProfiles.some((p) => p.id === profileId)) {
        return fail(res, 400, `قطاع غير معروف: ${profileId || '(فارغ)'}`);
      }

      // Optional onboarding profile (country + base currency + VAT). Each is
      // written only when supplied, so a plain sector switch from settings
      // leaves the country configuration exactly as it was.
      const rawCountry = req.body?.countryCode;
      const countryCode = rawCountry === undefined || rawCountry === null || rawCountry === ''
        ? null : String(rawCountry).trim().toUpperCase();
      if (countryCode !== null && !/^[A-Z]{2}$/.test(countryCode)) {
        return fail(res, 400, 'رمز الدولة يجب أن يكون حرفين (مثال: SA)');
      }
      const rawCurrency = req.body?.baseCurrency;
      const baseCurrency = rawCurrency === undefined || rawCurrency === null || rawCurrency === ''
        ? null : String(rawCurrency).trim().toUpperCase();
      if (baseCurrency !== null && !/^[A-Z]{3}$/.test(baseCurrency)) {
        return fail(res, 400, 'رمز العملة يجب أن يكون 3 أحرف (مثال: SAR)');
      }
      const rawVat = req.body?.vatRate;
      const vatRate = rawVat === undefined || rawVat === null || rawVat === ''
        ? null : Number(rawVat);
      if (vatRate !== null && (!Number.isFinite(vatRate) || vatRate < 0 || vatRate > 100)) {
        return fail(res, 400, 'نسبة الضريبة يجب أن تكون بين 0 و100');
      }

      const client = await pool.connect();
      try {
        await client.query('BEGIN');

        await client.query(
          `UPDATE dypos.tenants
              SET industry_profile = $2,
                  country_code = COALESCE($3, country_code),
                  base_currency = COALESCE($4, base_currency),
                  vat_rate = COALESCE($5, vat_rate),
                  updated_at = NOW()
            WHERE id = $1`,
          [tenantId, profileId, countryCode, baseCurrency, vatRate],
        );

        // Re-seed the grants from the sector's derived capability list. Only
        // the capabilities the new sector can use stay enabled; the rest are
        // explicitly disabled rather than deleted, so the record shows they
        // were deliberately withdrawn rather than lost.
        const derived = capabilitiesForProfile(profileId);
        await client.query(
          `INSERT INTO dypos.tenant_capabilities (tenant_id, capability_id, is_enabled)
           SELECT $1, c.id, (c.id = ANY($2::varchar[]))
           FROM dypos.capabilities c
           ON CONFLICT (tenant_id, capability_id)
             DO UPDATE SET is_enabled = EXCLUDED.is_enabled`,
          [tenantId, derived],
        );

        await client.query('COMMIT');
      } catch (e) {
        await client.query('ROLLBACK');
        throw e;
      } finally {
        client.release();
      }

      // Answered with the licence consequence of the switch, so the caller
      // sees what changed instead of a bare 200.
      res.json({
        profileId,
        nameAr: getProfileById(profileId).name_ar,
        enabledCapabilities: capabilitiesForProfile(profileId),
        licensedScreens: ALL_SCREEN_IDS.filter((id) => isTabAllowed(profileId, id)),
      });
    }),
  );
}

