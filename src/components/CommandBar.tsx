import React, { useEffect, useState } from 'react';
import { useAuthz } from '../contexts/AuthzContext';
import { useData } from '../contexts/DataContext';
import { useEntitlement } from '../contexts/EntitlementContext';
import { apiGet, apiPost } from '../services/dyposApi';
import { CURRENCY_SYMBOLS } from '../erp/money';
import {
  ShieldCheck, ChevronDown, Coins, Ruler, CalendarClock, RefreshCw, Lock,
  GitBranch, LogOut, Loader2,
} from 'lucide-react';

/**
 * Command bar — the ERP work surface.
 *
 * Modelled on the three systems that set the standard:
 *  - **SAP Fiori**: a page header carrying the object context (organisation,
 *    branch, date, currency, posting period) above the content, because those
 *    values govern what every action on the page is allowed to do. Every value
 *    is read from the session or the API — nothing on this bar is a constant,
 *    so two tenants never see each other's name.
 *  - **Dynamics 365**: an action ribbon where each command declares the
 *    permission it needs, is absent when the user lacks it, and *navigates*
 *    to the screen that performs it. A command that does nothing is worse than
 *    no command: it teaches the operator that the bar is decoration.
 *  - **Oracle Fusion**: functional responsibility is displayed, so an operator
 *    can see *why* they see what they see.
 */

interface PeriodState {
  period: string;
  status: 'open' | 'closing' | 'closed';
  exists: boolean;
}

export interface CommandBarProps {
  /** Clears the session and returns to the sign-in screen. */
  onSignOut?: () => void;
  /** Deep-links a ribbon command to the screen that owns it. */
  onNavigate?: (tab: string) => void;
}

export const CommandBar: React.FC<CommandBarProps> = ({ onSignOut, onNavigate }) => {
  const { can } = useAuthz();
  const { reload, selectedBranch } = useData();
  const { tenant, plan, branches } = useEntitlement();

  const [currencies, setCurrencies] = useState<any[]>([]);
  const [base, setBase] = useState('SAR');
  const [currency, setCurrency] = useState('SAR');
  const [baseUnit, setBaseUnit] = useState<string | null>(null);
  const [period, setPeriod] = useState<PeriodState | null>(null);
  const [roleMenu, setRoleMenu] = useState(false);
  const [busy, setBusy] = useState(false);
  const [notice, setNotice] = useState<{ tone: 'ok' | 'error'; text: string } | null>(null);

  const currentPeriod = new Date().toISOString().slice(0, 7);

  useEffect(() => {
    let alive = true;
    (async () => {
      try {
        const c = await apiGet<{ items: any[]; base: string }>('/api/erp/currencies');
        if (alive) { setCurrencies(c.items || []); setBase(c.base || 'SAR'); }
      } catch { /* the bar degrades to the base currency only */ }

      try {
        const p = await apiGet<PeriodState>(`/api/erp/periods/${currentPeriod}/status`);
        if (alive) setPeriod(p);
      } catch { /* an unknown period defaults to open server-side */ }

      // The displayed "base unit" is whatever the tenant actually configured,
      // not the string EA every screen used to print.
      try {
        const u = await apiGet<{ items: any[] }>('/api/erp/uom');
        const root = (u.items || []).find((x: any) => !x.base_unit_id && x.dimension === 'COUNT')
          || (u.items || [])[0];
        if (alive) setBaseUnit(root ? String(root.code) : null);
      } catch { /* leave it blank rather than inventing a unit */ }
    })();
    return () => { alive = false; };
  }, [currentPeriod]);

  const periodClosed = period?.status === 'closed';
  const rate = currencies.find((c) => c.code === currency)?.exchange_rate ?? 1;

  /** Closing a posting period is irreversible for the data — so it must report. */
  const closePeriod = async () => {
    if (busy || periodClosed) return;
    setBusy(true);
    setNotice(null);
    try {
      await apiPost(`/api/erp/periods/${currentPeriod}/close`, {});
      setPeriod({ period: currentPeriod, status: 'closed', exists: true });
      setNotice({ tone: 'ok', text: `أُغلقت الفترة ${currentPeriod} ولن تقبل ترحيل` });
    } catch (e: any) {
      setNotice({ tone: 'error', text: e?.message || 'تعذّر إغلاق الفترة' });
    } finally {
      setBusy(false);
    }
  };

  /** Re-reads every collection the shell holds. Never a full page reload. */
  const refresh = async () => {
    setBusy(true);
    setNotice(null);
    try {
      await reload();
      const p = await apiGet<PeriodState>(`/api/erp/periods/${currentPeriod}/status`);
      setPeriod(p);
      setNotice({ tone: 'ok', text: 'أُعيد قراءة البيانات من الخادم' });
    } catch (e: any) {
      setNotice({ tone: 'error', text: e?.message || 'تعذّر التحديث' });
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="sticky top-0 z-30 bg-surface/95 backdrop-blur-sm border-b border-hairline">
      {/* Context strip — the values that govern the whole page */}
      <div className="px-6 h-14 flex items-center justify-between gap-4">
        <div className="flex items-center gap-4 min-w-0 overflow-hidden">
          <div className="flex items-center gap-2 shrink-0">
            <span className="w-6 h-6 rounded bg-slate-900 text-white grid place-items-center text-[11px] font-bold">
              D
            </span>
            <div className="leading-tight min-w-0">
              <p className="text-xs font-semibold text-ink truncate">
                {tenant?.name || '—'}
              </p>
              <p className="text-2xs text-faint truncate">
                {tenant?.commercialReg
                  ? `السجل التجاري ${tenant.commercialReg}`
                  : plan ? `الاشتراك: ${plan}` : 'لم يُقرأ اشتراك المؤسسة'}
              </p>
            </div>
          </div>

          <span className="h-6 w-px bg-hairline shrink-0" />

          {/* Branch scope — which rows this terminal may touch */}
          <div className="flex items-center gap-1.5 shrink-0" title="نطاق الفروع المصرّح لهذا المستخدم">
            <GitBranch size={13} className="text-faint" />
            <span className="text-2xs text-faint">الفرع</span>
            <span className="px-1.5 py-1 rounded-md bg-subtle border border-hairline text-[11.5px] font-medium text-ink">
              {selectedBranch?.name || 'غير محدد'}
            </span>
          </div>

          <span className="h-6 w-px bg-hairline shrink-0" />

          {/* Reporting currency + live FX */}
          <label className="flex items-center gap-1.5 shrink-0">
            <Coins size={13} className="text-faint" />
            <span className="text-2xs text-faint">عملة العرض</span>
            <select
              value={currency}
              onChange={(e) => setCurrency(e.target.value)}
              className="bg-subtle border border-hairline rounded-md px-1.5 py-1 text-[11.5px] font-medium text-ink outline-none cursor-pointer focus:border-brand"
              title={`العملة الأساسية للتوحيد: ${base}`}
            >
              {currencies.length === 0 && <option value={base}>{base}</option>}
              {currencies.map((c) => (
                <option key={c.code} value={c.code}>
                  {c.code}{CURRENCY_SYMBOLS[c.code] ? ` · ${CURRENCY_SYMBOLS[c.code]}` : ''}
                </option>
              ))}
            </select>
            {currency !== base && (
              <span className="text-2xs text-amber-600 text-numeric">
                1 {currency} = {Number(rate).toFixed(4)} {base}
              </span>
            )}
          </label>

          <div className="flex items-center gap-1.5 shrink-0">
            <Ruler size={13} className="text-faint" />
            <span className="text-2xs text-faint">الوحدة الأساسية</span>
            <span className="px-1.5 py-1 rounded-md bg-subtle border border-hairline text-[11.5px] font-medium text-ink text-numeric">
              {baseUnit ?? '—'}
            </span>
          </div>

          {/* Posting period with its lock state */}
          <div
            className={`flex items-center gap-1.5 shrink-0 px-2 py-1 rounded-md border ${
              periodClosed
                ? 'border-rose-200 bg-rose-50 text-rose-700'
                : 'border-brand-200 bg-brand-50 text-brand-700'
            }`}
            title={periodClosed ? 'الفترة مغلقة — لا يمكن الترحيل' : 'الفترة مفتوحة للترحيل'}
          >
            {periodClosed ? <Lock size={11} /> : <CalendarClock size={11} />}
            <span className="text-2xs font-medium">
              {currentPeriod} · {periodClosed ? 'مغلقة' : 'مفتوحة'}
            </span>
            {can('period.close') && !periodClosed && (
              <button
                onClick={closePeriod}
                disabled={busy}
                className="text-2xs underline underline-offset-2 hover:no-underline disabled:opacity-50"
              >
                {busy ? '…' : 'إغلاق'}
              </button>
            )}
          </div>

          {notice && (
            <span
              role={notice.tone === 'error' ? 'alert' : 'status'}
              className={`shrink-0 px-2 py-1 rounded-md border text-2xs ${
                notice.tone === 'error'
                  ? 'border-rose-200 bg-rose-50 text-rose-700'
                  : 'border-brand-200 bg-brand-50 text-brand-700'
              }`}
            >
              {notice.text}
            </span>
          )}
        </div>

        <div className="flex items-center gap-2 shrink-0">
          <button
            onClick={refresh}
            disabled={busy}
            title="إعادة قراءة البيانات من الخادم"
            className="inline-flex items-center gap-1.5 px-2 py-1.5 rounded-md border border-hairline text-2xs text-muted hover:text-ink transition-colors disabled:opacity-50"
          >
            {busy ? <Loader2 size={12} className="animate-spin" /> : <RefreshCw size={12} />}
            تحديث
          </button>

          <IdentityMenu
            open={roleMenu}
            setOpen={setRoleMenu}
            onSignOut={onSignOut}
            branchCount={branches.filter((b) => b.allowed).length}
          />
        </div>
      </div>

      <Ribbon periodClosed={periodClosed} onNavigate={onNavigate} />
    </div>
  );
};

const Sep = () => <span className="w-px h-5 bg-hairline mx-1.5 shrink-0" />;

/**
 * Action ribbon.
 *
 * Every command carries a destination. A ribbon whose buttons only *look*
 * active teaches the operator that the shell is theatre — the reason a
 * "traditional" dashboard is useless is that nothing on it does anything.
 * Commands the user may not run are absent rather than greyed, so an auditor
 * scanning the bar sees only what can actually be executed.
 */
const Ribbon: React.FC<{
  periodClosed: boolean;
  onNavigate?: (tab: string) => void;
}> = ({ periodClosed, onNavigate }) => (
  <div className="px-6 h-11 flex items-center gap-1.5 border-t border-hairline bg-subtle/60 overflow-x-auto scrollbar-thin">
    <RibbonAction label="فاتورة بيع" permission="sales.create" primary
      onClick={() => onNavigate?.('pos')} />
    <RibbonAction label="إرجاع" permission="sales.return"
      onClick={() => onNavigate?.('pos')} />
    <RibbonAction label="خصم" permission="sales.discount"
      onClick={() => onNavigate?.('pos')} />
    <RibbonAction label="فتح وردية" permission="cash.open_shift"
      onClick={() => onNavigate?.('branches')} />
    <RibbonAction label="إقفال وردية" permission="cash.close_shift"
      onClick={() => onNavigate?.('branches')} />

    <Sep />

    <RibbonAction label="قيد يومية" permission="ledger.post"
      onClick={() => onNavigate?.('ledger')} />
    <RibbonAction label="ترحيل" permission="ledger.post" disabled={periodClosed}
      onClick={() => onNavigate?.('ledger')} />
    <RibbonAction label="عكس قيد" permission="ledger.reverse"
      onClick={() => onNavigate?.('ledger')} />

    <Sep />

    <RibbonAction label="تسوية مخزون" permission="inventory.adjust"
      onClick={() => onNavigate?.('inventory')} />
    <RibbonAction label="أمر شراء" permission="purchase.create"
      onClick={() => onNavigate?.('purchases')} />
    <RibbonAction label="اعتماد شراء" permission="purchase.approve"
      onClick={() => onNavigate?.('purchases')} />

    <Sep />

    <RibbonAction label="سعر صرف" permission="currency.rate.manage"
      onClick={() => onNavigate?.('settings')} />
    <RibbonAction label="إغلاق فترة" permission="period.close" disabled={periodClosed}
      onClick={() => onNavigate?.('financials')} />
  </div>
);

/**
 * A ribbon command: a real button with a real destination.
 *
 * Absent rather than greyed out when the permission is missing — a disabled
 * control still reads as an available action to an auditor scanning the bar.
 */
const RibbonAction: React.FC<{
  label: string;
  permission: string;
  primary?: boolean;
  disabled?: boolean;
  onClick?: () => void;
}> = ({ label, permission, primary, disabled, onClick }) => {
  const { can } = useAuthz();
  if (!can(permission)) return null;

  return (
    <button
      type="button"
      onClick={onClick}
      disabled={disabled}
      title={disabled ? 'غير متاح — الفترة مغلقة' : `${label} — الشاشة التي تنفّذ العملية`}
      className={`px-2.5 py-1 rounded-md text-[11.5px] font-medium transition-colors shrink-0 disabled:opacity-40 disabled:cursor-not-allowed ${
        primary
          ? 'bg-slate-900 text-white hover:bg-slate-800'
          : 'text-ink hover:bg-subtle'
      }`}
    >
      {label}
    </button>
  );
};



/**
 * Identity chip showing the signed-in operator and their functional roles.
 *
 * Everything in the panel is read from the session: who you are, which roles
 * you hold, whether they collide on segregation of duties, how many grants are
 * active, and which branches you may touch. That is the Oracle Fusion idea of
 * making responsibility visible rather than buried.
 */
const IdentityMenu: React.FC<{
  open: boolean;
  setOpen: (v: boolean) => void;
  onSignOut?: () => void;
  branchCount?: number;
}> = ({ open, setOpen, onSignOut, branchCount = 0 }) => {
  const { principal, isAdmin, loading } = useAuthz();
  if (!principal) return null;

  const roleName = principal.roles.map((r) => r.name).join(' · ') || 'بلا أدوار';

  return (
    <div className="relative shrink-0">
      <button
        onClick={() => setOpen(!open)}
        aria-expanded={open}
        aria-haspopup="menu"
        className="flex items-center gap-2 px-2 py-1.5 rounded-md hover:bg-subtle transition-colors"
      >
        <span className="w-6 h-6 rounded-full bg-slate-900 text-white grid place-items-center text-2xs font-semibold">
          {principal.name.trim()[0]}
        </span>
        <div className="text-right leading-tight hidden sm:block">
          <p className="text-2xs font-medium text-ink">{principal.name}</p>
          <p className="text-faint truncate max-w-[140px]">
            {loading ? 'جارٍ التحميل…' : roleName}
          </p>
        </div>
        <ChevronDown size={12} className="text-faint" />
      </button>

      {open && (
        <div className="absolute left-0 top-full mt-1 w-72 surface-card elev-2 z-50 overflow-hidden">
          <div className="px-4 py-3 border-b border-hairline">
            <p className="text-xs font-semibold text-ink">
              {principal.name} · {principal.username}
            </p>
            <p className="text-2xs text-muted mt-0.5">
              {principal.isSuperuser
                ? 'صلاحية كاملة (مدير النظام)'
                : `${principal.permissions.length} صلاحية فعّالة`}
            </p>
          </div>

          <div className="px-4 py-3 border-b border-hairline space-y-1.5">
            <p className="text-eyebrow mb-1">الأدوار والمسؤوليات</p>
            {principal.roles.length === 0 && (
              <p className="text-2xs text-muted">لا يوجد دور مُسنَد — الشاشات مقصورة على افتراضات القطاع.</p>
            )}
            {principal.roles.map((r) => (
              <div key={r.id} className="flex items-center justify-between gap-2">
                <span className="text-2xs text-ink">{r.name}</span>
                {r.sodGroup && (
                  <span className="text-[9px] px-1.5 py-px rounded bg-amber-50 text-amber-700 border border-amber-200">
                    فصل مهام: {r.sodGroup}
                  </span>
                )}
              </div>
            ))}
          </div>

          {!principal.isSuperuser && principal.permissions.length > 0 && (
            <div className="px-4 py-3 border-b border-hairline max-h-40 overflow-y-auto">
              <p className="text-eyebrow mb-1.5">الصلاحيات</p>
              <div className="flex flex-wrap gap-1">
                {principal.permissions.slice(0, 30).map((p) => (
                  <span key={p} className="px-1.5 py-px rounded bg-subtle text-faint text-[9.5px] font-mono">
                    {p}
                  </span>
                ))}
                {principal.permissions.length > 30 && (
                  <span className="px-1.5 py-px rounded bg-subtle text-faint text-[9.5px]">
                    +{principal.permissions.length - 30}
                  </span>
                )}
              </div>
            </div>
          )}

          <div className="px-4 py-2.5 border-b border-hairline flex items-center justify-between">
            <span className="text-2xs text-muted flex items-center gap-1">
              <ShieldCheck size={11} className={isAdmin ? 'text-brand-500' : 'text-faint'} />
              {branchCount === 0 ? 'كل الفروع' : `${branchCount} فرع مصرّح`}
            </span>
          </div>

          <div className="px-3 py-2.5 flex items-center gap-2">
            <button
              onClick={onSignOut}
              disabled={!onSignOut}
              className="flex-1 inline-flex items-center justify-center gap-1.5 px-2 py-1.5 rounded-md border border-hairline text-2xs text-rose-600 hover:bg-rose-50 disabled:opacity-50 transition-colors"
              title="إنهاء الجلسة والعودة لشاشة الدخول"
            >
              <LogOut size={12} />
              تسجيل الخروج
            </button>
            <button
              onClick={() => setOpen(false)}
              className="px-2 py-1.5 text-2xs text-muted hover:text-ink"
            >
              إغلاق
            </button>
          </div>
        </div>
      )}
    </div>
  );
};

export default CommandBar;

