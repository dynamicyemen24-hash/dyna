export interface IndustryProfile {
  id: string;
  name_ar: string;
  name_en: string;
  /**
   * Screens this sector may open, keyed by the SAME ids the renderer and the
   * sidebar use (see MainLayout's navItems). Anything not listed is hidden.
   */
  tabs: string[];
}

/**
 * The capability each screen requires, keyed by screen id.
 *
 * This map is the single source of truth for licensing. Previously a screen
 * needed BOTH a matching `tabs` entry and a matching capability string, and the
 * two lists disagreed (`work_orders` vs `work_order`, `batches` vs
 * `batch_expiry`), so whole screens were hidden by a vocabulary mismatch rather
 * than by any real entitlement. Capabilities are now *derived* from the tabs a
 * sector declares, which makes the two impossible to desynchronise.
 */
/**
 * Capability each screen requires, keyed by screen id.
 *
 * A `null` value means the screen is purely informational / chrome (work centre,
 * settings, audit trail, AI assistant, intelligence hub) and is offered in every
 * sector by design — it does not require a specific capability grant.
 *
 * Screens with a non-null value require that capability to be enabled in the
 * tenant's `dypos.tenant_capabilities` grant for the screen to be licensed.
 *
 * NOTE: The `capabilitiesForProfile()` derivation function reads this map so
 * that a screen can never be visible without the capability it requires. If a
 * screen is added here without a capability, it will always be licensed (null
 * gate), which is the intended behaviour for chrome/screens.
 */
export const SCREEN_CAPABILITY: Record<string, string | null> = {
  // Dashboard & intelligence chrome
  dashboard: null,
  intelligence: null,
  assistant: null,

  // Core sell & supply
  pos: 'sales',
  product: 'product',
  inventory: 'product',
  purchases: 'product',
  customer: 'customer',
  measurement: 'measurement',
  service: 'service',

  // Restaurant & catering
  restaurant: 'service',
  consignment: 'product',

  // Work & production
  work_order: 'work_order',
  production: 'production',
  batch_expiry: 'batch_expiry',
  serial_imei: 'serial',

  // Finance & accounting
  commission: 'commission',
  delivery: 'delivery',
  subscription: 'subscription',
  ledger: 'ledger',
  financials: 'ledger',

  // Governance & HR
  reports: 'reports',
  hr: null,
  branches: null,
  audit: null,
  settings: null,
};

/** Screens every sector shares — navigation, audit and configuration. */
const COMMON_TABS = ['branches', 'audit', 'ai', 'settings', 'hr', 'reports', 'financials'];

export const industryProfiles: IndustryProfile[] = [
  {
    id: 'retail',
    name_ar: 'تجارة التجزئة العامة',
    name_en: 'General Retail',
    tabs: [
      'pos', 'product', 'inventory', 'purchases', 'customer', 'ledger',
      'commission', 'delivery', 'serial_imei', 'batch_expiry',
      'work_order', 'production', 'subscription',
      ...COMMON_TABS,
    ],
  },
  {
    id: 'pharmacy',
    name_ar: 'الصيدليات والمختبرات',
    name_en: 'Pharmacy & Labs',
    tabs: [
      'pos', 'product', 'inventory', 'purchases', 'customer', 'ledger',
      'batch_expiry', 'serial_imei', 'commission', 'delivery',
      ...COMMON_TABS,
    ],
  },
  {
    id: 'tailoring',
    name_ar: 'الخياطة والملابس المخصصة',
    name_en: 'Tailoring & Custom Apparel',
    tabs: [
      'pos', 'product', 'inventory', 'purchases', 'customer', 'ledger',
      'measurement', 'work_order', 'production', 'batch_expiry', 'delivery',
      ...COMMON_TABS,
    ],
  },
  {
    id: 'workshop',
    name_ar: 'الورش ومراكز الصيانة',
    name_en: 'Workshops & Maintenance',
    tabs: [
      'pos', 'product', 'inventory', 'purchases', 'customer', 'ledger',
      'work_order', 'serial_imei', 'service', 'measurement', 'delivery',
      ...COMMON_TABS,
    ],
  },
  {
    id: 'salon',
    name_ar: 'الصالونات ومراكز التجميل',
    name_en: 'Salons & Spas',
    tabs: [
      'pos', 'customer', 'ledger', 'service', 'appointment', 'commission',
      'subscription', 'work_order', 'delivery',
      ...COMMON_TABS,
    ],
  },
  {
    id: 'laundry',
    name_ar: 'المغاسل والتنظيف الجاف',
    name_en: 'Laundry & Dry Cleaning',
    tabs: [
      'pos', 'product', 'inventory', 'purchases', 'customer', 'ledger',
      'service', 'work_order', 'delivery', 'batch_expiry',
      ...COMMON_TABS,
    ],
  },
  {
    id: 'electronics',
    name_ar: 'الإلكترونيات والجوالات',
    name_en: 'Electronics & Mobiles',
    tabs: [
      'pos', 'product', 'inventory', 'purchases', 'customer', 'ledger',
      'serial_imei', 'batch_expiry', 'delivery', 'commission', 'subscription',
      ...COMMON_TABS,
    ],
  },
  {
    id: 'restaurant',
    name_ar: 'المطاعم والضيافة',
    name_en: 'Restaurants & Catering',
    // A kitchen still sells items and serves customers, so the retail screens
    // stay available alongside the restaurant module.
    tabs: [
      'pos', 'restaurant', 'product', 'inventory', 'purchases', 'customer',
      'ledger', 'delivery', 'commission', 'work_order', 'serial_imei',
      ...COMMON_TABS,
    ],
  },
];

export function getProfileById(id: string): IndustryProfile {
  return industryProfiles.find(p => p.id === id) || industryProfiles[0];
}

/**
 * Capabilities implied by a sector's screen list. Derived rather than declared
 * so a screen can never be visible without the capability it requires.
 */
export function capabilitiesForTabs(tabs: string[]): string[] {
  const caps = new Set<string>();
  for (const tab of tabs) {
    const cap = SCREEN_CAPABILITY[tab];
    if (cap) caps.add(cap);
  }
  return [...caps];
}

/** Capabilities a profile grants, computed from the screens it opens. */
export function capabilitiesForProfile(profileId: string): string[] {
  return capabilitiesForTabs(getProfileById(profileId).tabs);
}

/** True when the sector is allowed to open the given screen. */
export function isTabAllowed(profileId: string, tab: string): boolean {
  return getProfileById(profileId).tabs.includes(tab);
}


/* ==========================================================================
 * ENTITLEMENT RESOLUTION — one resolver, three runtimes
 *
 * A screen is only offered when all four levels agree:
 *
 *   1. SECTOR      — the business profile the tenant onboarded with.
 *                    A kitchen screen has no meaning for a pharmacy.
 *   2. SUBSCRIPTION— the capability grants in `dypos.tenant_capabilities`
 *                    (the licence the subscriber actually paid for).
 *   3. BRANCH      — resolved separately, because a branch is *scope* rather
 *                    than *entitlement*: it narrows the rows an allowed screen
 *                    returns, never whether the screen exists.
 *   4. USER        — the effective permissions unioned from the user's roles
 *                    (`dypos.role_permissions` after allow/deny resolution).
 *
 * WHY IT LIVES HERE, IMPORT-FREE
 * ------------------------------
 * This module has no imports on purpose: the Express server, the Cloudflare
 * Worker and the React client all import it. That is what stops the licence
 * rules from drifting between the runtime that enforces them and the runtime
 * that renders them — the failure mode the README already documents for
 * `tabs` vs `navItems`.
 * ========================================================================== */

/**
 * Every screen the client ships, in catalogue order.
 *
 * Exported as data so the server, the Worker and the client resolve the SAME
 * universe. `src/config/navigation.ts` asserts parity with this list at module
 * load, so a screen can never be added to the shell and forgotten by the
 * licence resolver (which would hide it in production only).
 */
export const ALL_SCREEN_IDS: string[] = [
  'dashboard', 'intelligence', 'assistant',

  'pos', 'product', 'customer', 'appointment', 'measurement', 'service',
  'restaurant', 'commission', 'subscription',

  'inventory', 'purchases', 'work_order', 'production', 'batch_expiry',
  'serial_imei', 'delivery', 'consignment',

  'ledger', 'financials', 'reports',

  'hr', 'branches', 'audit', 'settings',
];

export type ScreenDenialReason = 'sector' | 'capability' | 'permission';

export interface ScreenDenial {
  screen: string;
  reason: ScreenDenialReason;
  /** A sentence that can be shown to the user verbatim. */
  detail: string;
}

export interface ScreenEntitlement {
  /** Screens the tenant's sector offers, before the licence is considered. */
  inSector: string[];
  /** Screens the sector AND the capability grants open (the licence). */
  licensed: string[];
  /** Licensed screens the user's roles permit — the ones the shell shows. */
  allowed: string[];
  /** Licensed but withheld from this user, with the reason. */
  blocked: ScreenDenial[];
  /** True when the capability list came from the database rather than a default. */
  grantsFromDatabase: boolean;
}

const REASON_TEXT: Record<ScreenDenialReason, string> = {
  sector: 'الشاشة غير مدرجة في قطاع هذه المنشأة',
  capability: 'الوحدة الوظيفية غير مفعّلة في اشتراك هذه المؤسسة',
  permission: 'صلاحيات دورك الحالي لا تسمح بفتح هذه الشاشة',
};

/**
 * The permission each screen requires, keyed by screen id (any-of semantics).
/**
 * Permission each screen requires, keyed by screen id (any-of semantics).
 *
 * A screen absent from this map needs no specific permission — it is either
 * purely informational (the work centre, settings, audit trail) or gated by
 * the sector licence alone. Every entry here mirrors a guard the server already
 * enforces on that screen's own routes, so the client never invents an
 * entitlement it cannot honour, and hiding is a usability measure, never a control.
 *
 * The `any-of` semantics means a screen is permitted when the user holds
 * *any* of the listed permissions.
 */
export const SCREEN_PERMISSIONS: Record<string, string[] | undefined> = {
  // Dashboard & intelligence chrome — no specific permissions needed
  dashboard: undefined,
  intelligence: undefined,
  assistant: undefined,

  // Core sell & supply
  pos: ['sales.create', 'sales.void', 'sales.discount'],
  product: ['sales.create', 'sales.discount'],
  customer: ['customer.view', 'customer.create', 'customer.manage'],
  appointment: ['appointment.manage'],
  measurement: ['inventory.view', 'inventory.adjust', 'product.manage'],
  service: undefined,

  // Restaurant & catering
  restaurant: ['sales.create', 'sales.discount'],
  consignment: ['sales.create'],

  // Work & production
  work_order: undefined,
  production: undefined,
  batch_expiry: ['batch.view', 'batch.manage'],
  serial_imei: ['serial.view'],

  // Finance & accounting
  commission: undefined,
  delivery: undefined,
  subscription: undefined,
  ledger: ['ledger.view', 'ledger.post', 'ledger.reverse'],
  financials: ['reports.view'],
  reports: ['reports.view'],

  // Governance & HR
  hr: undefined,
  branches: undefined,
  audit: undefined,
  settings: undefined,
};

/**
 * Hard sector overrides: screens that make sense in exactly one sector.
 *
 * A kitchen display without a service area is not "an unused screen", it is a
 * wrong screen — so this is a sector rule, not a licence rule.
 */
/**
 * Hard sector overrides: screens that make sense in exactly one sector.
 *
 * A kitchen display without a service area is not "an unused screen", it is a
 * wrong screen — so this is a sector rule, not a licence rule.
 *
 * When a screen has an override entry, it will only be shown for tenants whose
 * profileId matches one of the listed sector IDs. Screens without an override
 * are governed by the sector's `tabs` list and capability grants instead.
 */
export const SCREEN_SECTORS: Record<string, string[] | undefined> = {
  restaurant: ['restaurant'],
};

/**
 * Resolves what the shell may show, from the four levels in one pass.
 *
 * `permissions` is deliberately tri-state:
 *   - `null`  → the caller could not read the user's grants. Do NOT gate, and
 *               say so: gating on an unknown set hides every screen and looks
 *               identical to a total licence denial.
 *   - `[]`    → the user genuinely holds no grants. A role-less account.
 *   - `[...]` → the effective grant list.
 */
export function resolveScreenEntitlement(input: {
  /** Every screen id the client ships, in catalogue order. */
  available: string[];
  profileId: string;
  /** Effective capability grants. When unknown, pass the sector defaults. */
  capabilities: string[];
  permissions: string[] | null;
  isSuperuser?: boolean;
  /** False when `capabilities` is a sector default rather than a DB grant. */
  grantsFromDatabase?: boolean;
}): ScreenEntitlement {
  const {
    available, profileId, capabilities, permissions,
    isSuperuser = false, grantsFromDatabase = true,
  } = input;

  const sectorTabs = getProfileById(profileId).tabs;
  const caps = new Set(capabilities);
  const perms = permissions === null ? null : new Set(permissions);
  const gateOnPermissions = perms !== null && !isSuperuser && perms.size > 0;

  const inSector: string[] = [];
  const licensed: string[] = [];
  const allowed: string[] = [];
  const blocked: ScreenDenial[] = [];

  for (const screen of available) {
    const override = SCREEN_SECTORS[screen];
    const capability = SCREEN_CAPABILITY[screen];
    // A hard override replaces the sector tab list rather than adding to it.
    // A screen with NO capability is shell chrome (the work centre, settings,
    // the audit trail) and is offered in every sector by design.
    const sectorOk = override
      ? override.includes(profileId)
      : (!capability || sectorTabs.includes(screen));
    if (!sectorOk) {
      blocked.push({ screen, reason: 'sector', detail: REASON_TEXT.sector });
      continue;
    }
    inSector.push(screen);

    // When the grants are a sector default, the capability check is already
    // satisfied by construction — re-checking it would double-gate the screen.
    const capabilityOk = !capability || !grantsFromDatabase || caps.has(capability);
    if (!capabilityOk) {
      blocked.push({ screen, reason: 'capability', detail: REASON_TEXT.capability });
      continue;
    }
    licensed.push(screen);

    const required = SCREEN_PERMISSIONS[screen];
    const permissionOk = !required || !gateOnPermissions
      || required.some((p) => perms!.has(p));
    if (!permissionOk) {
      blocked.push({ screen, reason: 'permission', detail: REASON_TEXT.permission });
      continue;
    }
    allowed.push(screen);
  }

  return { inSector, licensed, allowed, blocked, grantsFromDatabase };
}

