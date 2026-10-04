/**
 * Screen catalogue — the single source of truth for the work centre.
 *
 * WHY THIS FILE EXISTS
 * --------------------
 * Three surfaces need to agree on the same list of screens:
 *   1. the shell's navigation (MainLayout),
 *   2. the command ribbon (CommandBar),
 *   3. the work centre's deep links and quick actions (Dashboard).
 *
 * Before this file the list lived inside MainLayout and every other surface
 * either imported it (creating a cycle) or hard-coded its own strings. The
 * result was buttons that looked like SAP transactions but navigated nowhere —
 * chrome with no destination. A screen id now has exactly one definition, and
 * `navItemById` is what a deep link resolves through.
 *
 * Ordering, iconography and labels follow SAP Fiori's launchpad grouping: work
 * is grouped by the *job* it belongs to (sell, supply, finance, govern) rather
 * than by module type, because an operator looks for "where do I receive
 * stock", not "the inventory table".
 */
import type { ComponentType } from 'react';
import { ALL_SCREEN_IDS } from './industryProfiles';
import {
  LayoutDashboard, BrainCircuit, Sparkles, ShoppingCart, Package, Warehouse,
  ShoppingBag, Users, Ruler, Calendar, ClipboardList, UtensilsCrossed, Factory,
  Clock, Hash, Percent, Truck, Repeat, Book, Settings,
  BarChart3, Scale, GitBranch, ShieldCheck, Scissors, Handshake,
} from 'lucide-react';

/** A lucide icon component. Typed structurally so no type import is needed. */
export type NavIcon = ComponentType<{ size?: number | string; className?: string }>;

/** Functional area — the launchpad group a screen belongs to. */
export type NavArea = 'overview' | 'sell' | 'supply' | 'finance' | 'govern';

export interface NavAreaMeta {
  id: NavArea;
  label: string;
  labelEn: string;
}

export const NAV_AREAS: NavAreaMeta[] = [
  { id: 'overview', label: 'نظرة عامة', labelEn: 'Overview' },
  { id: 'sell', label: 'البيع والخدمة', labelEn: 'Sell & Serve' },
  { id: 'supply', label: 'التوريد والتشغيل', labelEn: 'Supply & Operate' },
  { id: 'finance', label: 'المالية والتقارير', labelEn: 'Finance & Report' },
  { id: 'govern', label: 'الحوكمة والإعدادات', labelEn: 'Govern & Configure' },
];

export interface NavItem {
  id: string;
  label: string;
  labelEn: string;
  icon: NavIcon;
  area: NavArea;
}

/**
 * Every screen id must exist in `ALL_SCREEN_IDS` (the licence resolver's
 * universe) and vice versa.
 *
 * This runs at module load because the failure it prevents is invisible in
 * development: a screen missing from the resolver's list is simply never
 * licensed, so it works on a desk with a permissive fallback path and
 * disappears on a provisioned tenant. A loud console error at boot is cheaper
 * than that hunt.
 */
export function assertCatalogParity(): string[] {
  const navIds = NAV_ITEMS.map((i) => i.id);
  const missingFromResolver = navIds.filter((id) => !ALL_SCREEN_IDS.includes(id));
  const missingFromNav = ALL_SCREEN_IDS.filter((id) => !navIds.includes(id));
  if (missingFromResolver.length || missingFromNav.length) {
    // eslint-disable-next-line no-console
    console.error(
      '[dypos] screen catalogue drift —',
      missingFromResolver.length ? `not licensable: ${missingFromResolver.join(', ')}` : '',
      missingFromNav.length ? `not in navigation: ${missingFromNav.join(', ')}` : '',
    );
  }
  return [...missingFromResolver, ...missingFromNav];
}

export const NAV_ITEMS: NavItem[] = [
  { id: 'dashboard', label: 'مركز العمل', labelEn: 'Work Centre', icon: LayoutDashboard, area: 'overview' },
  { id: 'intelligence', label: 'مركز الذكاء', labelEn: 'Intelligence', icon: BrainCircuit, area: 'overview' },
  { id: 'assistant', label: 'المساعد الذكي', labelEn: 'AI Assistant', icon: Sparkles, area: 'overview' },

  { id: 'pos', label: 'نقطة البيع', labelEn: 'Point of Sale', icon: ShoppingCart, area: 'sell' },
  { id: 'product', label: 'البيع السريع', labelEn: 'Quick Sale', icon: Package, area: 'sell' },
  { id: 'customer', label: 'العملاء', labelEn: 'Customers', icon: Users, area: 'sell' },
  { id: 'appointment', label: 'المواعيد', labelEn: 'Appointments', icon: Calendar, area: 'sell' },
  { id: 'measurement', label: 'المقاسات', labelEn: 'Measurements', icon: Ruler, area: 'sell' },
  { id: 'service', label: 'الخدمات', labelEn: 'Services', icon: Scissors, area: 'sell' },
  { id: 'restaurant', label: 'المطعم والمطبخ', labelEn: 'Restaurant & KDS', icon: UtensilsCrossed, area: 'sell' },
  { id: 'commission', label: 'العمولات', labelEn: 'Commissions', icon: Percent, area: 'sell' },
  { id: 'subscription', label: 'الاشتراكات', labelEn: 'Subscriptions', icon: Repeat, area: 'sell' },

  { id: 'inventory', label: 'المخزون', labelEn: 'Inventory', icon: Warehouse, area: 'supply' },
  { id: 'purchases', label: 'المشتريات', labelEn: 'Purchasing', icon: ShoppingBag, area: 'supply' },
  { id: 'work_order', label: 'أوامر العمل', labelEn: 'Work Orders', icon: ClipboardList, area: 'supply' },
  { id: 'production', label: 'الإنتاج', labelEn: 'Production', icon: Factory, area: 'supply' },
  { id: 'batch_expiry', label: 'الصلاحية', labelEn: 'Batches & Expiry', icon: Clock, area: 'supply' },
  { id: 'serial_imei', label: 'السيريال', labelEn: 'Serials / IMEI', icon: Hash, area: 'supply' },
  { id: 'delivery', label: 'التوصيل', labelEn: 'Delivery', icon: Truck, area: 'supply' },
  { id: 'consignment', label: 'بيع الغير', labelEn: 'Consignment', icon: Handshake, area: 'supply' },

  { id: 'ledger', label: 'المحاسبة', labelEn: 'General Ledger', icon: Book, area: 'finance' },
  { id: 'financials', label: 'القوائم المالية', labelEn: 'Financial Statements', icon: Scale, area: 'finance' },
  { id: 'reports', label: 'التقارير', labelEn: 'Reports & BI', icon: BarChart3, area: 'finance' },

  { id: 'hr', label: 'الموارد البشرية', labelEn: 'Human Resources', icon: Users, area: 'govern' },
  { id: 'branches', label: 'الفروع والورديات', labelEn: 'Branches & Shifts', icon: GitBranch, area: 'govern' },
  { id: 'audit', label: 'سجل التدقيق', labelEn: 'Audit Trail', icon: ShieldCheck, area: 'govern' },
  { id: 'settings', label: 'الإعدادات', labelEn: 'Settings', icon: Settings, area: 'govern' },
];

assertCatalogParity();

/** Resolves a screen id to its catalogue entry. Used by every deep link. */
export function navItemById(id: string): NavItem | undefined {
  return NAV_ITEMS.find((i) => i.id === id);
}

/** The Arabic label for a screen id — falls back to the id itself. */
export function labelOf(id: string): string {
  if (id === 'ai') return 'المساعد الذكي';
  return navItemById(id)?.label ?? id;
}

/** The screen the shell opens when the session starts. */
export const DEFAULT_TAB = 'dashboard';

