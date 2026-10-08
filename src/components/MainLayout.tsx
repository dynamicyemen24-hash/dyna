import React from 'react';
import { useIndustry } from '../contexts/IndustryContext';
import { useEntitlement } from '../contexts/EntitlementContext';
import { useAuthz } from '../contexts/AuthzContext';
import { useData } from '../contexts/DataContext';
import { CommandBar } from './CommandBar';
import { BottomStatusBar } from './BottomStatusBar';
import { offlineSyncService, type OfflineSyncState } from '../services/offlineSyncService';
import { ThemeSwitcher } from './ThemeSwitcher';
import { ToolLauncher } from '../contexts/ToolsContext';
import {
  NAV_AREAS, NAV_ITEMS, navItemById, DEFAULT_TAB, type NavItem,
} from '../config/navigation';
import {
  Menu, X, Search, Star, HelpCircle, LogOut, AlertTriangle, ChevronDown,
  Monitor, Palette,
} from 'lucide-react';
import { ErrorBoundary } from './ErrorBoundary';

/**
 * WORK CENTRE SHELL
 *
 * Modelled on the three systems that set the standard for enterprise work
 * surfaces — and deliberately not a launchpad clone:
 *
 *  - **SAP Fiori** — navigation is grouped by job, not by module, and every
 *    entry is licensed before it is rendered. The licence is resolved once
 *    (sector → subscription → branch → user) and handed to the shell; the
 *    shell never invents a screen.
 *  - **Oracle Fusion** — identity, role and organisation sit on the surface,
 *    so "why do I see this?" is answerable without opening settings.
 *  - **Dynamics 365** — pinned and recently-used entries come first, so an
 *    operator doing the same three things all day stops scrolling past
 *    accounting.
 *
 * Nothing here is decorative: the search box, the pin toggles, the
 * authorization explanation and the sign-out control are wired to real state
 * and real endpoints.
 */

const PINNED_KEY = 'dypos_nav_pinned';
const RECENT_KEY = 'dypos_nav_recent';
const SIDEBAR_KEY = 'dypos_sidebar_open';

const readList = (key: string): string[] => {
  try {
    const raw = JSON.parse(localStorage.getItem(key) || '[]');
    return Array.isArray(raw) ? raw.filter((v) => typeof v === 'string') : [];
  } catch {
    return [];
  }
};

interface MainLayoutProps {
  children: React.ReactNode;
  activeTab: string;
  setActiveTab: (tab: string) => void;
  /** Clears the session and returns to the sign-in screen. */
  onSignOut?: () => void;
}

export const MainLayout: React.FC<MainLayoutProps> = ({
  children, activeTab, setActiveTab, onSignOut,
}) => {
  const { activeProfile } = useIndustry();
  const {
    screens, blocked, authority, verificationFailed, plan, tenant, status,
  } = useEntitlement();
  const { principal, loading: authzLoading } = useAuthz();
  const { operator, selectedBranch, shift } = useData();

  // The shell's own sync subscription — the status bar below reads the queue
  // directly instead of receiving defaulted props.
  const [sync, setSync] = React.useState<OfflineSyncState>(() => offlineSyncService.getState());
  React.useEffect(() => offlineSyncService.subscribe(setSync), []);

  const [isSidebarOpen, setIsSidebarOpen] = React.useState(
    () => localStorage.getItem(SIDEBAR_KEY) !== 'closed',
  );
  const [query, setQuery] = React.useState('');
  const [pinned, setPinned] = React.useState<string[]>(() => readList(PINNED_KEY));
  const [recent, setRecent] = React.useState<string[]>(() => readList(RECENT_KEY));
  const searchRef = React.useRef<HTMLInputElement | null>(null);

  /*
   * NOTE — declaration order below is load-bearing.
   *
   * `permitted`, `matches` and `inQuery` are declared *after* the two state
   * hooks, and the memos that consume them must follow their declarations.
   * `const` is in the temporal dead zone until its line executes, so a memo
   * placed above them dereferences an uninitialised binding and React throws
   * "Cannot access 'permitted' before initialization" on the very first render
   * — a white screen before login, not a type error.
   */

  const go = React.useCallback((id: string) => {
    if (!screens.includes(id)) return;
    setActiveTab(id);
    setRecent((prev) => {
      const next = [id, ...prev.filter((r) => r !== id)].slice(0, 6);
      localStorage.setItem(RECENT_KEY, JSON.stringify(next));
      return next;
    });
  }, [screens, setActiveTab]);

  const togglePin = React.useCallback((id: string) => {
    setPinned((prev) => {
      const next = prev.includes(id) ? prev.filter((p) => p !== id) : [id, ...prev].slice(0, 8);
      localStorage.setItem(PINNED_KEY, JSON.stringify(next));
      return next;
    });
  }, []);

  // Ctrl/Cmd+K focuses the screen search — the shortcut every enterprise shell
  // converges on, and the only practical way to reach one screen among 27.
  // When the rail is collapsed the input is unmounted, so focusing it directly
  // fails silently: open the rail first, then focus once it has rendered.
  const setSidebar = React.useCallback((open: boolean) => {
    setIsSidebarOpen(open);
    localStorage.setItem(SIDEBAR_KEY, open ? 'open' : 'closed');
  }, []);

  React.useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === 'k') {
        e.preventDefault();
        if (!isSidebarOpen) {
          setSidebar(true);
          window.setTimeout(() => {
            searchRef.current?.focus();
            searchRef.current?.select();
          }, 60);
        } else {
          searchRef.current?.focus();
          searchRef.current?.select();
        }
      }
      if (e.key === 'Escape' && document.activeElement === searchRef.current) {
        setQuery('');
        searchRef.current?.blur();
      }
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [isSidebarOpen, setSidebar]);

  // Identity, sector and scope come from the session — never from a constant.
  const identity = operator.name || operator.username;
  const roleName = principal?.roles?.map((r) => r.name).join(' · ') || operator.role;
  const scopeLabel = selectedBranch
    ? `${selectedBranch.name}${selectedBranch.city ? ` · ${selectedBranch.city}` : ''}`
    : 'بلا فرع محدد';
  const verificationChip = verificationFailed
    ? { text: 'الاشتراك لم يُتحقق', tone: 'text-amber-700 bg-amber-50 border-amber-200 dark:text-amber-200 dark:bg-amber-950 dark:border-amber-800' }
    : authority === 'server'
      ? { text: `اشتراك ${plan || 'معتمد'}`, tone: 'text-brand-700 bg-brand-50 border-brand-200 dark:text-brand-200 dark:bg-brand-950 dark:border-brand-800' }
      : { text: 'فحص محلي', tone: 'text-muted bg-subtle border-hairline' };

  const [showExplanation, setShowExplanation] = React.useState(false);
  const whyTriggerRef = React.useRef<HTMLButtonElement | null>(null);

  // Escape closes the "why" popover and returns focus to its trigger.
  const closeExplanation = React.useCallback(() => {
    setShowExplanation(false);
    whyTriggerRef.current?.focus();
  }, []);

  React.useEffect(() => {
    if (!showExplanation) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') {
        e.stopPropagation();
        closeExplanation();
      }
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [showExplanation, closeExplanation]);

  /**
   * A screen is rendered only when the four-level licence allows it. While the
   * licence is still loading, the seeded list (sector defaults from the
   * tenant's stored profile) is used, so the navigation is never blank and
   * never flashes a screen that will later be withdrawn.
   */
  const permitted = React.useMemo(
    () => NAV_ITEMS.filter((item) => screens.includes(item.id)),
    [screens],
  );

  const matches = React.useCallback((item: NavItem) => {
    const q = query.trim().toLowerCase();
    if (!q) return true;
    return item.label.toLowerCase().includes(q)
      || item.labelEn.toLowerCase().includes(q)
      || item.id.includes(q);
  }, [query]);

  const inQuery = React.useMemo(() => permitted.filter(matches), [permitted, matches]);

  /*
   * Pinned and recent rows are filtered through the SAME licence and the SAME
   * search predicate as the grouped list below. A row the operator can no longer
   * open must disappear from the pinned rail too — otherwise the rail is a
   * shortcut to a screen that renders "forbidden".
   */
  const pinnedItems = React.useMemo(
    () => pinned
      .map((id) => ({ id, item: navItemById(id) }))
      .filter((e): e is { id: string; item: NavItem } =>
        Boolean(e.item) && permitted.includes(e.item!) && matches(e.item!)),
    [pinned, permitted, matches],
  );

  const recentItems = React.useMemo(
    () => recent
      .map((id) => ({ id, item: navItemById(id) }))
      .filter((e): e is { id: string; item: NavItem } =>
        Boolean(e.item) && permitted.includes(e.item!) && !pinned.includes(e.id)
        && matches(e.item!)),
    [recent, permitted, pinned, matches],
  );

  const areaGroups = React.useMemo(
    () => NAV_AREAS
      .map((area) => ({
        area,
        items: inQuery.filter((i) =>
          i.area === area.id && !pinned.includes(i.id) && !recent.includes(i.id)),
      }))
      .filter((g) => g.items.length > 0),
    [inQuery, pinned, recent],
  );

  // The active screen may lose its entitlement when the sector or the licence
  // changes. Land on a screen the user *can* open rather than rendering a
  // forbidden one. Declared here, after `permitted`, for the same reason as the
  // memos above: an effect listed earlier runs against an uninitialised binding.
  React.useEffect(() => {
    if (status === 'loading' || permitted.length === 0) return;
    if (!permitted.some((i) => i.id === activeTab)) {
      setActiveTab(permitted.some((i) => i.id === DEFAULT_TAB) ? DEFAULT_TAB : permitted[0].id);
    }
  }, [activeTab, permitted, status, setActiveTab]);

  // Same mapping the root shell uses: only an actually-flushed queue reads as
  // synced. Anything unread stays `undefined` and the bar prints `—`.
  const shellSyncStatus: 'synced' | 'syncing' | 'offline' =
    sync.syncStatus === 'syncing'
      ? 'syncing'
      : (!sync.isOnline || sync.pendingCount > 0) ? 'offline' : 'synced';

  return (
    <div className="flex h-screen bg-canvas text-ink overflow-hidden" dir="rtl">
      {/* Keyboard users land here first: one keypress to reach the workspace. */}
      <a
        href="#dypos-workspace"
        className="sr-only focus:not-sr-only fixed top-2 right-2 z-[70] bg-brand text-white px-3 py-2 rounded-lg text-sm font-semibold"
      >
        تخطَّ إلى منطقة العمل
      </a>

      {/* ── Navigation ───────────────────────────────────────────────────── */}
      <aside
        className={`bg-surface border-l border-hairline flex flex-col shrink-0 transition-[width] duration-200 ${
          isSidebarOpen ? 'w-64' : 'w-[68px]'
        }`}
      >
        <div className="h-14 px-4 flex items-center justify-between border-b border-hairline">
          {isSidebarOpen && (
            <div className="flex items-center gap-2.5 min-w-0">
              <div className="w-7 h-7 bg-ink text-canvas rounded-md grid place-items-center text-[13px] font-bold">
                D
              </div>
              <div className="leading-tight min-w-0">
                <p className="text-sm font-semibold text-ink truncate">دينا</p>
                <p className="text-2xs text-faint truncate">{tenant?.name || activeProfile.name_ar}</p>
              </div>
            </div>
          )}
          <button
            onClick={() => setSidebar(!isSidebarOpen)}
            aria-label={isSidebarOpen ? 'طي القائمة' : 'توسيع القائمة'}
            className="p-1.5 text-muted hover:text-ink hover:bg-subtle rounded-md transition-colors ml-auto"
          >
            {isSidebarOpen ? <X size={16} /> : <Menu size={16} />}
          </button>
        </div>

        {isSidebarOpen && (
          <div className="px-3 pt-3 space-y-2.5 border-b border-hairline">
            <div className="flex items-center gap-1.5 flex-wrap">
              <span className={`inline-flex items-center gap-1 px-1.5 py-0.5 rounded border text-2xs font-semibold ${verificationChip.tone}`}>
                {verificationChip.text}
              </span>
              <span className="inline-flex items-center gap-1 px-1.5 py-0.5 rounded border border-hairline bg-subtle text-2xs text-muted">
                {activeProfile.name_ar}
              </span>
            </div>

            {verificationFailed && (
              <p className="text-2xs text-amber-700 dark:text-amber-200 leading-relaxed flex items-start gap-1">
                <AlertTriangle size={11} className="mt-px shrink-0" />
                لم يُتحقق من اشتراك المؤسسة هذه الجلسة؛ العرض مقتصر على افتراضات القطاع.
              </p>
            )}

            {/* Screen search — Ctrl/Cmd+K */}
            <div className="relative">
              <Search size={13} className="absolute right-2.5 top-1/2 -translate-y-1/2 text-faint" />
              <input
                ref={searchRef}
                value={query}
                onChange={(e) => setQuery(e.target.value)}
                placeholder="ابحث عن شاشة…  ⌘K"
                aria-label="البحث في الشاشات"
                className="w-full bg-subtle border border-hairline rounded-md py-1.5 pr-7 pl-2 text-xs text-ink placeholder:text-faint focus:outline-none focus:border-brand"
              />
            </div>
          </div>
        )}

        <nav
          aria-label="التنقل الرئيسي"
          className="flex-1 overflow-y-auto px-2 py-3 space-y-4 scrollbar-thin"
        >
          {pinnedItems.length > 0 && (
            <NavSection label="المثبّتة">
              {pinnedItems.map(({ id, item }) => (
                <NavRow
                  key={`p-${id}`}
                  item={item}
                  active={activeTab === id}
                  isSidebarOpen={isSidebarOpen}
                  pinned
                  onGo={go}
                  onTogglePin={togglePin}
                />
              ))}
            </NavSection>
          )}

          {recentItems.length > 0 && (
            <NavSection label="استُخدمت مؤخراً">
              {recentItems.map(({ id, item }) => (
                <NavRow
                  key={`r-${id}`}
                  item={item}
                  active={activeTab === id}
                  isSidebarOpen={isSidebarOpen}
                  onGo={go}
                  onTogglePin={togglePin}
                />
              ))}
            </NavSection>
          )}

          {areaGroups.map(({ area, items }) => (
            <NavSection key={area.id} label={area.label}>
              {items.map((item) => (
                <NavRow
                  key={item.id}
                  item={item}
                  active={activeTab === item.id}
                  isSidebarOpen={isSidebarOpen}
                  pinned={pinned.includes(item.id)}
                  onGo={go}
                  onTogglePin={togglePin}
                />
              ))}
            </NavSection>
          ))}

          {inQuery.length === 0 && (
            <p className="px-3 py-6 text-xs text-faint text-center leading-relaxed">
              لا توجد شاشة مطابقة، أو لا تملك صلاحية فتح أي شاشة ضمن هذا القطاع.
            </p>
          )}
        </nav>


        {/* ── Identity, scope and session ──────────────────────────────── */}
        <div className="border-t border-hairline p-3 relative">
          {showExplanation && (
            <div className="absolute bottom-full right-2 left-2 mb-2 surface-card elev-2 p-3 max-h-72 overflow-y-auto z-40 space-y-2.5">
              <div className="flex items-center justify-between">
                <p className="text-eyebrow">سبب إخفاء الشاشات</p>
                <button
                  onClick={closeExplanation}
                  aria-label="إغلاق"
                  className="text-faint hover:text-ink rounded focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-brand"
                >
                  <X size={13} />
                </button>
              </div>

              {blocked.length === 0 ? (
                <p className="text-xs text-muted leading-relaxed">
                  لا شيء مخفي — قطاع المؤسسة وصلاحياتك الحالية تفتحان كل الشاشات المعرفة.
                </p>
              ) : (
                <>
                  <div className="flex flex-wrap gap-1.5">
                    {(['sector', 'capability', 'permission'] as const).map((reason) => {
                      const n = blocked.filter((b) => b.reason === reason).length;
                      if (!n) return null;
                      const tone = reason === 'permission'
                        ? 'bg-amber-50 text-amber-700 border-amber-200 dark:bg-amber-950 dark:text-amber-200 dark:border-amber-800'
                        : 'bg-subtle text-muted border-hairline';
                      return (
                        <span key={reason} className={`px-1.5 py-0.5 rounded border text-2xs font-semibold ${tone}`}>
                          {n} — {blocked.find((b) => b.reason === reason)!.detail}
                        </span>
                      );
                    })}
                  </div>
                  <ul className="space-y-1">
                    {blocked.slice(0, 14).map((b) => (
                      <li key={b.screen} className="flex items-center justify-between gap-2 text-2xs">
                        <span className="text-muted">{navItemById(b.screen)?.label ?? b.screen}</span>
                        <span className="text-faint">{b.detail}</span>
                      </li>
                    ))}
                  </ul>
                  {blocked.length > 14 && (
                    <p className="text-2xs text-faint">+{blocked.length - 14} أخرى</p>
                  )}
                </>
              )}
            </div>
          )}

          <button
            ref={whyTriggerRef}
            onClick={() => (showExplanation ? closeExplanation() : setShowExplanation(true))}
            aria-expanded={showExplanation}
            className="w-full flex items-center justify-between gap-2 px-2 py-1.5 rounded-md bg-subtle border border-hairline text-2xs text-muted hover:text-ink transition-colors focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-brand"
          >
            <span className="flex items-center gap-1.5">
              <HelpCircle size={12} />
              سبب إظهار هذه الشاشات
            </span>
            <ChevronDown size={12} />
          </button>

          <div className="flex items-center gap-2.5 mt-2.5">
            <div className="w-8 h-8 shrink-0 bg-ink text-canvas rounded-full grid place-items-center text-[11px] font-semibold">
              {identity.trim()[0] || '؟'}
            </div>
            <div className="min-w-0 flex-1">
              <p className="text-xs font-semibold text-ink truncate">
                {authzLoading ? 'جارٍ تحميل الصلاحيات…' : identity}
              </p>
              <p className="text-2xs text-faint truncate" title={roleName}>{roleName}</p>
              <p className="text-2xs text-muted truncate flex items-center gap-1" title={scopeLabel}>
                <span className="w-1.5 h-1.5 rounded-full bg-brand shrink-0" />
                {scopeLabel}
              </p>
            </div>
          </div>

          <button
            onClick={onSignOut}
            disabled={!onSignOut}
            className="mt-2.5 w-full flex items-center justify-center gap-1.5 px-2 py-1.5 rounded-md border border-hairline text-xs text-rose-600 hover:bg-rose-50 disabled:opacity-50 transition-colors dark:text-rose-400 dark:hover:bg-rose-950 focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-brand"
            title="إنهاء الجلسة والعودة لشاشة الدخول"
          >
            <LogOut size={13} />
            تسجيل الخروج
          </button>

          {/*
            The theme control, inside the product rather than only on the login
            screen.

            It was reachable only BEFORE signing in, which meant the choice was
            made once per browser and then unreachable — an operator who picks
            high-contrast for a sunlit warehouse, or OLED for a night till, had to
            change the setting from the login page every time they wanted it.

            `high_contrast` in particular is an accommodation rather than a
            preference, so it has to be reachable from the working shell, not
            only from the door.
          */}
          <div className="mt-2">
            <ThemeSwitcher compact />
          </div>

          {/*
            The helper tools, inside the working shell.

            They were reachable only from the sign-in door, which is the wrong
            direction: the moment a till misbehaves is *during* a shift, when
            nobody is going back to the login page to find a diagnostic. Both
            launchers call the same provider, so this is the identical panel
            the door opens — an operator who learned it there sees the same
            thing here.
          */}
          <div className="mt-2 space-y-1.5">
            <ToolLauncher
              tool="devices"
              icon={Monitor}
              label="فحص الأجهزة"
              className="w-full flex items-center justify-center gap-1.5 px-2 py-2 rounded-md border border-hairline text-2xs text-muted hover:text-ink hover:bg-subtle transition-colors"
            />
            <ToolLauncher
              tool="theme"
              icon={Palette}
              label="مختبر السِمات"
              className="w-full flex items-center justify-center gap-1.5 px-2 py-2 rounded-md border border-hairline text-2xs text-muted hover:text-ink hover:bg-subtle transition-colors"
            />
          </div>
        </div>
      </aside>

      {/* ── Workspace ─────────────────────────────────────────────────────── */}
      <main className="flex-1 flex flex-col overflow-hidden min-w-0">
        <CommandBar onSignOut={onSignOut} onNavigate={go} />

        <div id="dypos-workspace" className="flex-1 overflow-y-auto px-6 py-5 scrollbar-thin">
          {/* Per-screen boundary: a failure here leaves navigation and the
              command bar intact, so the operator can move to another screen. */}
          <ErrorBoundary label={navItemById(activeTab)?.label ?? 'هذه الشاشة'}>
            {children}
          </ErrorBoundary>
        </div>

        {/*
          The terminal health line, inside the shell and fed directly from the
          session (`useData`) and the offline queue — never from defaulted
          props. Anything the shell has not actually read (branch, base
          currency, queue depth) renders as `—`, the same honesty rule the
          Dashboard follows: no `بلا فرع`, no assumed `SAR`, no `0` that claims
          a queue was measured.
        */}
        <BottomStatusBar
          shift={shift}
          syncStatus={shellSyncStatus}
          lastBackupTime={sync.lastSyncTime}
          pendingCount={sync.pendingCount}
          branchLabel={selectedBranch?.name}
          baseCurrency={tenant?.baseCurrency}
          onOpenAppInstaller={() => setActiveTab('settings')}
        />
      </main>
    </div>
  );
};


/** A grouped navigation section, with its heading hidden when collapsed. */
const NavSection: React.FC<{ label: string; children: React.ReactNode }> = ({
  label, children,
}) => (
  <section>
    <p className="px-3 pb-1.5 text-eyebrow">{label}</p>
    <div className="space-y-0.5">{children}</div>
  </section>
);

interface NavRowProps {
  item: NavItem;
  active: boolean;
  isSidebarOpen: boolean;
  pinned?: boolean;
  onGo: (id: string) => void;
  onTogglePin: (id: string) => void;
}

/**
 * One navigable screen.
 *
 * The pin control is a sibling button rather than a nested one — nested
 * buttons are invalid HTML and screen readers announce the row as a single
 * control.
 */
const NavRow: React.FC<NavRowProps> = ({
  item, active, isSidebarOpen, pinned = false, onGo, onTogglePin,
}) => {
  const Icon = item.icon;
  const row = (
    <button
      onClick={() => onGo(item.id)}
      title={item.label}
      aria-current={active ? 'page' : undefined}
      className={`group w-full flex items-center gap-2.5 px-2.5 py-2 rounded-lg transition-colors duration-150 focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-brand ${
        active
          ? 'bg-ink text-canvas'
          : 'text-muted hover:bg-subtle hover:text-ink'
      } ${isSidebarOpen ? '' : 'justify-center'}`}
    >
      <Icon
        size={16}
        className={`shrink-0 ${active ? '' : 'text-faint group-hover:text-ink'}`}
      />
      {isSidebarOpen && <span className="text-xs font-medium truncate">{item.label}</span>}
    </button>
  );

  if (!isSidebarOpen) return row;

  return (
    <div className="flex items-center gap-1">
      <div className="min-w-0 flex-1">{row}</div>
      <button
        onClick={() => onTogglePin(item.id)}
        aria-label={pinned ? `إلغاء تثبيت ${item.label}` : `تثبيت ${item.label}`}
        aria-pressed={pinned}
        className={`shrink-0 p-1 rounded transition-opacity ${
          pinned
            ? 'text-amber-500 opacity-100'
            : 'text-faint opacity-0 group-hover:opacity-100 focus-visible:opacity-100 hover:opacity-100'
        }`}
      >
        <Star size={12} className={pinned ? 'fill-current' : ''} />
      </button>
    </div>
  );
};

export default MainLayout;

