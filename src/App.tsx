import React, { useState, useCallback, lazy, Suspense, useEffect } from 'react';
import { IndustryProvider } from './contexts/IndustryContext';
import { AuthzProvider } from './contexts/AuthzContext';
import { EntitlementProvider, useEntitlement } from './contexts/EntitlementContext';
import { ToolsProvider } from './contexts/ToolsContext';
import { offlineSyncService, type OfflineSyncState } from './services/offlineSyncService';
import { attachOfflineSyncTransport } from './services/offlineSyncTransport';
import { LoginView } from './components/LoginView';
import { ChangePasswordView } from './components/ChangePasswordView';
import InstallPrompt from './components/InstallPrompt';
import UpdateNotice from './components/UpdateNotice';
import { MainLayout } from './components/MainLayout';
import { Dashboard } from './components/Dashboard';
import { ShiftOpeningDialog } from './components/ShiftOpeningDialog';

/*
 * ══ WHY THIS IS REGISTERED HERE ═══════════════════════════════════════════
 * `offlineSyncService.registerSyncHandler` existed on the manager and was called
 * from nowhere in the application. `syncNow()` therefore took its "no handler"
 * branch on every attempt, so **every queued offline sale stayed queued
 * forever** while the status bar alternated between "scheduled" and "offline"
 * and the operator was told their sales were safely recorded. They were not on
 * the server: the queue was a write-only log in one browser's localStorage, and
 * every sale in it was lost to a cleared cache, a replaced disk, or a till sold
 * second-hand.
 *
 * The endpoint it needed (`POST /api/db/sync-batch`) was already authenticated,
 * already derived its tenant from the token, and already recomputed the totals
 * server-side. Nothing connected the two. This module is that connection.
 *
 * It runs at MODULE LOAD, not inside an effect, because the queue can flush on
 * the reconnect handler or on a timer — both of which can fire before React has
 * mounted, and a sale settled in that window would be reported as unsent.
 */
attachOfflineSyncTransport();

// Heavy screens are code-split so the initial bundle stays small.
const MeasurementManager = lazy(() =>
  import('./components/MeasurementManager').then((m) => ({ default: m.MeasurementManager })));
const WorkOrderManager = lazy(() =>
  import('./components/WorkOrderManager').then((m) => ({ default: m.WorkOrderManager })));
const RetailPOS = lazy(() =>
  import('./components/RetailPOS').then((m) => ({ default: m.RetailPOS })));
const IntelligenceCenter = lazy(() =>
  import('./components/IntelligenceCenter').then((m) => ({ default: m.IntelligenceCenter })));
const POSView = lazy(() =>
  import('./components/POSView').then((m) => ({ default: m.POSView })));
const InventoryView = lazy(() =>
  import('./components/InventoryView').then((m) => ({ default: m.InventoryView })));
const CustomersView = lazy(() =>
  import('./components/CustomersView').then((m) => ({ default: m.CustomersView })));
const PurchasesView = lazy(() =>
  import('./components/PurchasesView').then((m) => ({ default: m.PurchasesView })));
const AccountingView = lazy(() =>
  import('./components/AccountingView').then((m) => ({ default: m.AccountingView })));
const HrView = lazy(() =>
  import('./components/HrView').then((m) => ({ default: m.HrView })));
const ReportsView = lazy(() =>
  import('./components/ReportsView').then((m) => ({ default: m.ReportsView })));
// The financial statements are code-split for the same reason: the P&L, the
// cash flow and six charts are not needed by a cashier taking an order, and
// pulling Recharts into the first paint would slow the screen that matters most.
const FinancialStatementsView = lazy(() =>
  import('./components/FinancialStatementsView').then((m) => ({ default: m.FinancialStatementsView })));
const BranchesView = lazy(() =>
  import('./components/BranchesView').then((m) => ({ default: m.BranchesView })));
const AuditLogView = lazy(() =>
  import('./components/AuditLogView').then((m) => ({ default: m.AuditLogView })));
const AiAssistantView = lazy(() =>
  import('./components/AiAssistantView').then((m) => ({ default: m.AiAssistantView })));
const SettingsView = lazy(() =>
  import('./components/SettingsView').then((m) => ({ default: m.SettingsView })));
const RestaurantView = lazy(() =>
  import('./components/RestaurantView').then((m) => ({ default: m.RestaurantView })));
const SubscriptionsView = lazy(() =>
  import('./components/SubscriptionsView').then((m) => ({ default: m.SubscriptionsView })));
const ThirdPartySaleView = lazy(() =>
  import('./components/ThirdPartySaleView').then((m) => ({ default: m.ThirdPartySaleView })));

// The seven screens completed end-to-end against Neon PostgreSQL.
import { ServicesView } from './components/ServicesView';
import { AppointmentsView } from './components/AppointmentsView';
import { ProductionView } from './components/ProductionView';
import { BatchesView } from './components/BatchesView';
import { SerialsView } from './components/SerialsView';
import { CommissionsView } from './components/CommissionsView';
import { DeliveryView } from './components/DeliveryView';
import { OfflineSyncToast } from './components/OfflineSyncToast';
import { BottomStatusBar } from './components/BottomStatusBar';
import { apiGet, apiPost } from './services/dyposApi';
import { DataProvider, useData } from './contexts/DataContext';
import type {
  Product,
  Customer,
  Transaction,
  CartItem,
  Branch,
} from './types';

function AppContent({ onSignOut }: { onSignOut: () => void }) {
  const [activeTab, setActiveTab] = useState('dashboard');
  const { tenant } = useEntitlement();

  /**
   * The status bar used to *declare* a synchronised state and print "last
   * backup: now" regardless of what happened — a fabricated health signal on
   * a screen operators are meant to trust. It is now subscribed to the one
   * service that actually holds the queue.
   */
  const [sync, setSync] = useState<OfflineSyncState>(() => offlineSyncService.getState());
  useEffect(() => offlineSyncService.subscribe(setSync), []);

  // ---- Session data ------------------------------------------------------
  // Every collection comes from `DataProvider`, which loads it once from Neon
  // when the session opens. There is deliberately no local seed: a fabricated
  // product or customer rendered for the moment before the fetch resolves is a
  // row an operator can act on, and on a failed fetch it used to persist
  // indefinitely with nothing on screen to say it was not real.
  const {
    branches, categories, products, customers, suppliers, purchaseOrders,
    journalEntries, employees, transactions,
    selectedBranch, shift, auditLogs, operator,
    status: dataStatus, report: dataReport, error: dataError,
    selectBranch, setShift, pushAudit, openShift, closeShift,
    addProduct, updateProduct, removeProduct,
    addCustomer, addEmployee, addJournalEntry, addPurchaseOrder,
    insertTransaction, applyStock,
    reload: reloadData,
  } = useData();

  // The cart is genuinely session-local: it has no server representation until
  // checkout, so it belongs here rather than in the shared provider.
  const [cart, setCart] = useState<CartItem[]>([]);

  /** Surfaced when the server refuses a sale; cleared on the next attempt. */
  const [checkoutError, setCheckoutError] = useState('');

  // ---- POS cart ----
  const handleAddToCart = useCallback((product: Product) => {
    setCart((prev) => {
      const existing = prev.find((i) => i.product.id === product.id);
      if (existing) {
        return prev.map((i) =>
          i.product.id === product.id ? { ...i, quantity: i.quantity + 1 } : i,
        );
      }
      return [...prev, { product, quantity: 1, discount: 0 }];
    });
  }, []);

  const handleUpdateQuantity = useCallback((productId: string, delta: number) => {
    setCart((prev) =>
      prev
        .map((i) =>
          i.product.id === productId ? { ...i, quantity: Math.max(0, i.quantity + delta) } : i,
        )
        .filter((i) => i.quantity > 0),
    );
  }, []);

  const handleRemoveItem = useCallback((productId: string) => {
    setCart((prev) => prev.filter((i) => i.product.id !== productId));
  }, []);

  const handleClearCart = useCallback(() => setCart([]), []);

  /**
   * Completes a checkout.
   *
   * The invoice is persisted before the UI moves on. If the server rejects the
   * sale (for example, stock was sold by another till in the meantime) the
   * operator is told and the basket is kept, rather than being handed a receipt
   * for something that was never recorded.
   */
  const handleCompleteCheckout = useCallback(
    async (data: Partial<Transaction>) => {
      const total = data.total ?? 0;
      setCheckoutError('');

      // Flatten the cart into the line shape the API stores.
      const lines = cart.map((i) => ({
        productId: i.product.id,
        name: i.product.name,
        quantity: i.quantity,
        unitPrice: i.product.price,
        discount: i.discount,
        taxAmount: 0,
      }));

      try {
        // A sale MUST be attributed to a real branch. Refusing here rather than
        // posting an invoice with a null branch_id is deliberate: an unassigned
        // sale is invisible to every branch-scoped report, and would surface
        // weeks later as money the business took and cannot account for.
        if (!selectedBranch) {
          throw new Error('اختر الفرع قبل إتمام البيع — لا يمكن حفظ فاتورة بدون فرع');
        }

        const res = await apiPost<{ invoice?: any; item?: any }>('/api/db/invoices', {
          subtotal: data.subtotal ?? 0,
          tax: data.tax ?? 0,
          discount: data.discount ?? 0,
          total,
          paymentMethod: data.paymentMethod ?? 'mada',
          customerName: data.customerName ?? 'عميل نقدي',
          cashierName: shift.cashierName,
          branchId: selectedBranch.id,
          items: lines,
        });

        const saved = res?.invoice ?? res?.item;
        /*
         * The invoice number is whatever the SERVER allocated.
         *
         * It used to fall back to `INV-${year}-${transactions.length + 1002}`,
         * where `transactions.length` is the number of rows THIS TERMINAL has
         * loaded — so two terminals issue the same number for different sales.
         * SAP makes number allocation a server-side object for exactly this
         * reason. The fallback now reads the field the route returned, and if
         * even that is absent it is stated rather than invented.
         */
        const tx: Transaction = {
          id: saved?.id ?? `tx-${Date.now()}`,
          invoiceNumber: saved?.invoice_number ?? '—',
          items: cart,
          subtotal: data.subtotal ?? 0,
          tax: data.tax ?? 0,
          discount: data.discount ?? 0,
          total,
          paymentMethod: (data.paymentMethod as Transaction['paymentMethod']) ?? 'mada',
          customerName: data.customerName ?? 'عميل نقدي',
          cashierName: shift.cashierName,
          timestamp: saved?.timestamp ?? new Date().toISOString(),
          branchId: selectedBranch.id,
          status: 'completed',
        };

        insertTransaction(tx);
        setShift((s) => ({
          ...s,
          totalSales: s.totalSales + total,
          transactionsCount: s.transactionsCount + 1,
        }));
        // Use the stock the server committed rather than computing it locally, so the
        // screen can never drift from the ledger.
        const stockAfter = (res as any)?.stockAfter as Record<string, string> | undefined;
        if (stockAfter) applyStock(stockAfter);
        setCart([]);
        pushAudit('إتمام بيع', `فاتورة ${tx.invoiceNumber} بقيمة ${total.toFixed(2)} ر.س`);
        /*
         * Return the transaction as the server recorded it.
         *
         * The caller renders the customer receipt from this. Returning nothing
         * forced POSView to invent an invoice number and cashier name, which is
         * how a printed receipt came to disagree with the ledger.
         */
        return tx;
      } catch (err: any) {
        pushAudit(
          'فشل إتمام البيع',
          err?.message ?? 'تعذّر حفظ الفاتورة على الخادم — تم الإبقاء على السلة',
        );
        setCheckoutError(err?.message ?? 'تعذّر حفظ الفاتورة. تم الإبقاء على السلة.');
        throw err;
      }
    },
    [cart, transactions.length, shift.cashierName, selectedBranch?.id, pushAudit, insertTransaction, applyStock, setShift],
  );

  // ---- Catalog / CRM / HR / Accounting ----
  // These delegate to the shared provider rather than keeping a private copy:
  // a second copy is how the POS and the inventory screen drifted apart on how
  // many products existed.
  const handleAddProduct = addProduct;
  const handleUpdateProduct = updateProduct;
  const handleDeleteProduct = removeProduct;
  const handleAddCustomer = addCustomer;
  const handleAddEmployee = addEmployee;
  const handleAddJournalEntry = addJournalEntry;
  const handleAddPurchaseOrder = addPurchaseOrder;

  /**
   * Opening a shift is now a real, counted event.
   *
   * It used to be an inline toggle that accepted whatever number it was handed
   * and set `isOpen` — a single boolean flip standing in for a cash handover.
   * The float now comes from `ShiftOpeningDialog`, is validated before it can
   * reach state, and is written to exactly one place (`openShift`).
   */
  const handleToggleShift = useCallback(async (openingCash: number) => {
    if (shift.isOpen) closeShift(openingCash);
    else await openShift(openingCash);
  }, [shift.isOpen, openShift, closeShift]);

  /*
   * The count is prompted for on first entry into a closed shift.
   *
   * This is the moment the count belongs to: the operator is signed in, the
   * branch is chosen, and the till is about to sell. Prompting here — rather
   * than hiding the requirement until someone opens "branches" and notices —
   * is what makes the opening balance a fact instead of an omission. It is
   * shown once per closed state, so a refresh mid-shift does not re-ask.
   */
  const [shiftPromptOpen, setShiftPromptOpen] = useState(false);
  const [shiftPromptBusy, setShiftPromptBusy] = useState(false);
  useEffect(() => {
    if (!shift.isOpen && selectedBranch) setShiftPromptOpen(true);
    // Deliberately keyed on the closed→open edge only. Re-running on every
    // `selectedBranch` change would re-ask an operator who merely browsed
    // branches, which is exactly the nagging this is meant to avoid.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [shift.isOpen]);

  const renderContent = () => {
    switch (activeTab) {
      case 'dashboard':
        return <Dashboard onNavigate={setActiveTab} />;
      case 'intelligence':
        return <IntelligenceCenter />;
      case 'assistant':
        return <AiAssistantView products={products} transactions={transactions} />;
      case 'product':
        return <RetailPOS />;
      case 'pos':
        return (
          <POSView
            products={products}
            categories={categories}
            customers={customers}
            cart={cart}
            onAddToCart={handleAddToCart}
            onUpdateQuantity={handleUpdateQuantity}
            onRemoveItem={handleRemoveItem}
            onClearCart={handleClearCart}
            onCompleteCheckout={handleCompleteCheckout}
          />
        );
      case 'inventory':
        return (
          <InventoryView
            products={products}
            categories={categories}
            onAddProduct={handleAddProduct}
            onUpdateProduct={handleUpdateProduct}
            onDeleteProduct={handleDeleteProduct}
          />
        );
      case 'customer':
        return <CustomersView customers={customers} onAddCustomer={handleAddCustomer} />;
      case 'measurement':
        return <MeasurementManager />;
      case 'work_order':
        return <WorkOrderManager />;
      case 'purchases':
        return (
          <PurchasesView
            suppliers={suppliers}
            purchaseOrders={purchaseOrders}
            onAddPurchaseOrder={handleAddPurchaseOrder}
          />
        );
      case 'ledger':
        return <AccountingView journalEntries={journalEntries} onAddJournalEntry={handleAddJournalEntry} />;
      case 'hr':
        return <HrView employees={employees} onAddEmployee={handleAddEmployee} />;
      case 'reports':
        return <ReportsView transactions={transactions} />;
      case 'financials':
        return <FinancialStatementsView />;
      case 'branches':
        // No branch is chosen until the operator picks one. Previously the
        // screen was handed a fabricated branch from the mock seed, so the
        // whole application silently reported against "يمنع تثبيت اي بيانات بطريقة سطحية"
        // before anyone had selected anything.
        return branches.length === 0 || !selectedBranch ? (
          <NoBranchNotice
            loading={dataStatus === 'loading'}
            message={dataError}
            onRetry={() => void reloadData()}
          />
        ) : (
          <BranchesView
            branches={branches}
            selectedBranch={selectedBranch}
            onSelectBranch={selectBranch}
            shift={shift}
            onToggleShift={handleToggleShift}
            cashierName={operator.name || operator.username}
          />
        );
      case 'audit':
        return <AuditLogView logs={auditLogs} />;
      case 'restaurant':
        return <RestaurantView />;
      case 'subscription':
        return <SubscriptionsView />;
      case 'consignment':
        return <ThirdPartySaleView />;
      case 'settings':
        return <SettingsView />;
      case 'service':
        return <ServicesView />;
      case 'appointment':
        return <AppointmentsView />;
      case 'production':
        return <ProductionView />;
      case 'batch_expiry':
        return <BatchesView />;
      case 'serial_imei':
        return <SerialsView />;
      case 'commission':
        return <CommissionsView />;
      case 'delivery':
        return <DeliveryView />;
      default:
        return <Dashboard onNavigate={setActiveTab} />;
    }
  };

  return (
    <div className="flex flex-col h-screen">
      <div className="flex-1 min-h-0">
        <MainLayout activeTab={activeTab} setActiveTab={setActiveTab} onSignOut={onSignOut}>
          <Suspense
            fallback={
              <div className="flex items-center justify-center gap-3 py-24 text-slate-400">
                <span className="w-5 h-5 border-2 border-brand-500 border-t-transparent rounded-full animate-spin" />
                <span className="text-sm">جارٍ تحميل الشاشة…</span>
              </div>
            }
          >
            {renderContent()}
          </Suspense>
        </MainLayout>
      </div>
      <BottomStatusBar
        shift={shift}
        syncStatus={
          sync.syncStatus === 'syncing'
            ? 'syncing'
            : (sync.pendingCount > 0 || !sync.isOnline) ? 'offline' : 'synced'
        }
        lastBackupTime={sync.lastSyncTime}
        pendingCount={sync.pendingCount}
        branchLabel={selectedBranch ? selectedBranch.name : undefined}
        baseCurrency={tenant?.baseCurrency || 'SAR'}
        onOpenAppInstaller={() => setActiveTab('settings')}
      />
      {/*
        The counted opening float. Prompts on first entry into a closed shift,
        and is the ONLY path that can set `openingCash`. Dismissing it leaves
        the shift closed — which is the honest state: no count, no till.
      */}
      <ShiftOpeningDialog
        open={shiftPromptOpen}
        onClose={() => setShiftPromptOpen(false)}
        busy={shiftPromptBusy}
        onConfirm={async (cash) => {
          // The dialog closes only on success. A count the server refused must
          // stay on screen, or the operator walks away believing the till is
          // open when no shift exists.
          setShiftPromptBusy(true);
          const ok = await openShift(cash);
          setShiftPromptBusy(false);
          if (ok) setShiftPromptOpen(false);
        }}
        branchName={selectedBranch?.name ?? ''}
        cashierName={operator.name || operator.username}
        blockedReason={selectedBranch ? undefined : 'اختر الفرع أولاً — لا تُفتح وردية بلا فرع.'}
      />
      <OfflineSyncToast onForceSync={async () => {
        pushAudit('مزامنة يدوية', 'تم طلب مزامنة الطابور دون اتصال');
        return true;
      }} />
    </div>
  );
}

interface LoginSession {
  user: { id: string; name: string; role: string; username: string };
  branch: { id: string; name: string } | null;
  mustChangePassword: boolean;
  /**
   * Deliberately absent: `startingCash`.
   *
   * The session answers WHO and WHERE. An opening cash balance belongs to a
   * shift, and no shift exists at sign-in — the till is opened afterwards, by
   * `ShiftOpeningDialog`, once the operator has counted the drawer. A balance
   * persisted here would survive a reload and be silently adopted as the next
   * shift's opening figure, which is exactly how a variance disappears.
   */
}

/**
 * Shown when the session has no branch to work in.
 *
 * Distinguishes "still loading" from "the server has none", because those are
 * different problems: the first resolves on its own, the second needs the
 * operator to pick one or the tenant to be provisioned.
 */
const NoBranchNotice: React.FC<{
  loading: boolean;
  message: string;
  onRetry: () => void;
}> = ({ loading, message, onRetry }) => (
  <div className="flex-1 grid place-items-center p-8 bg-slate-950 text-slate-100">
    <div className="max-w-md text-center bg-slate-900 border border-slate-800 rounded-2xl p-8 space-y-3">
      {loading ? (
        <>
          <span className="inline-block w-6 h-6 border-2 border-brand-500 border-t-transparent rounded-full animate-spin" />
          <p className="text-sm text-slate-300">جارٍ تحميل بيانات الجلسة…</p>
        </>
      ) : (
        <>
          <h3 className="text-sm font-bold text-white">لا يوجد فرع متاح</h3>
          <p className="text-xs text-slate-400 leading-relaxed">
            لم يُرجع الخادم أي فرع لهذه المؤسسة. لا يمكن عرض بيانات الفرع قبل
            اختيار فرع فعلي — عرض فرع افتراضي كان يُظهر أرقامًا لا تخصّ أحدًا.
          </p>
          {message && <p className="text-[11px] text-rose-400 font-mono" dir="auto">{message}</p>}
          <button onClick={onRetry}
            className="mt-2 px-4 py-2 rounded-xl bg-slate-800 hover:bg-slate-700 text-white text-xs font-semibold">
            إعادة المحاولة
          </button>
        </>
      )}
    </div>
  </div>
);

/**
 * Release gate.
 *
 * Nothing business-facing renders until the operator has authenticated and, if
 * the deployment flagged it, replaced the shipped credential. This is the
 * single place the rule is enforced, so no screen can bypass it.
 */
function App() {
  const [session, setSession] = useState<LoginSession | null>(() => {
    const raw = sessionStorage.getItem('dypos_session');
    if (!raw) return null;
    try { return JSON.parse(raw) as LoginSession; } catch { return null; }
  });

  const [checking, setChecking] = useState(() => Boolean(sessionStorage.getItem('dypos_session')));
  const [release, setRelease] = useState<string>('');
  const [branches, setBranches] = useState<Branch[]>([]);
  /** Set when the branch list could not be loaded, so the UI can offer a retry. */
  const [branchesError, setBranchesError] = useState('');

  /**
   * The sign-in form cannot render without at least one branch to select, so
   * this is the one request that must not fail silently: a 401 here previously
   * left the operator staring at an endless boot spinner with no way forward.
   */
  const loadBranches = useCallback(() => {
    setBranchesError('');
    apiGet<{ items: Branch[] }>('/api/db/branches')
      .then((r) => setBranches(r.items || []))
      .catch((e: any) => {
        setBranches([]);
        setBranchesError(e?.message || 'تعذّر تحميل قائمة الفروع');
      });
  }, []);

  useEffect(() => {
    loadBranches();
    apiGet<{ current: { version: string } | null }>('/api/release')
      .then((r) => setRelease(r.current?.version ?? ''))
      .catch(() => setRelease(''));
  }, [loadBranches]);

  // A stored session with a pending rotation must not open the application.
  useEffect(() => {
    if (!checking) return;
    if (!session || session.mustChangePassword) {
      sessionStorage.removeItem('dypos_session');
      setSession(null);
    }
    setChecking(false);
  }, [checking, session]);

  const onAuthenticated = (user: {
    name: string; role: string; username?: string;
    branch: Branch; mustChangePassword?: boolean;
  }) => {
    /*
     * No cash figure crosses this boundary.
     *
     * The session records WHO and WHERE. It does not record an opening
     * balance, because the shift has not been opened yet — that happens in
     * `ShiftOpeningDialog` once the operator is inside and has counted the
     * drawer. Keeping the field here would let a stale value from a previous
     * shift silently become this shift's opening balance after a reload.
     */
    const s: LoginSession = {
      user: {
        id: user.username ?? user.name,
        name: user.name,
        role: user.role,
        username: user.username ?? user.name,
      },
      branch: { id: user.branch.id, name: user.branch.name },
      mustChangePassword: Boolean(user.mustChangePassword),
    };
    sessionStorage.setItem('dypos_session', JSON.stringify(s));
    setSession(s);
  };

  const signOut = () => {
    sessionStorage.removeItem('dypos_session');
    sessionStorage.removeItem('dypos_token');
    setSession(null);
  };

  if (checking) {
    return (
      <div className="min-h-screen bg-[#f6f7f9] grid place-items-center">
        <div className="text-center space-y-1">
          <p className="text-[12.5px] text-slate-500">جارٍ التحقق من الجلسة…</p>
          {release && <p className="text-[10.5px] text-slate-400">الإصدار {release}</p>}
        </div>
      </div>
    );
  }

  // The login shell expects at least one branch to select from.
  if (!session) {
    return (
      <AuthzProvider>
        {/* Wraps the sign-in screen too, not only the working shell: the
            device report is most valuable BEFORE a session exists — it is
            how an operator checks a terminal they cannot yet sign into. */}
        <ToolsProvider>
          {branches.length > 0
            ? <LoginView branches={branches} onLogin={onAuthenticated} />
            : branchesError
              ? <BranchLoadError message={branchesError} onRetry={loadBranches} />
              : <Booting />}
        </ToolsProvider>
      </AuthzProvider>
    );
  }

  if (session.mustChangePassword) {
    return (
      <AuthzProvider>
        <ChangePasswordView
          username={session.user.username}
          onDone={() => {
            const next = { ...session, mustChangePassword: false };
            sessionStorage.setItem('dypos_session', JSON.stringify(next));
            setSession(next);
          }}
          onSignOut={signOut}
        />
      </AuthzProvider>
    );
  }

  // One tools portal for the whole shell — see the note on the sign-in
  // branch above. Inside it the licence is resolved once (sector →
  // subscription → branch → user), the business data is loaded once for
  // every screen, and the install prompt and update notice sit at the root.
  return (
    <AuthzProvider>
      <ToolsProvider>
        <IndustryProvider>
          <EntitlementProvider>
            <DataProvider
              operator={{
                username: session.user.username,
                name: session.user.name,
                role: session.user.role,
              }}
            >
              <AppContent onSignOut={signOut} />
            </DataProvider>
          </EntitlementProvider>
          <InstallPrompt />
          <UpdateNotice />
        </IndustryProvider>
      </ToolsProvider>
    </AuthzProvider>
  );
}

/** Shown for the moment it takes the server to return the branch list. */
const Booting: React.FC = () => (
  <div className="min-h-screen bg-[#f6f7f9] grid place-items-center">
    <div className="text-center space-y-1">
      <div className="mx-auto mb-4 h-6 w-6 rounded-full border-2 border-brand-600 border-t-transparent animate-spin" />
      <p className="text-[12.5px] text-slate-500">جارٍ تجهيز بيئة العمل…</p>
    </div>
  </div>
);

/**
 * Shown when the branch list could not be fetched.
 *
 * The sign-in form needs at least one branch to select, so failing here used to
 * leave an indefinite spinner on screen with no explanation and no way to retry.
 */
const BranchLoadError: React.FC<{ message: string; onRetry: () => void }> = ({
  message,
  onRetry,
}) => (
  <div className="min-h-screen bg-[#f6f7f9] grid place-items-center px-6">
    <div
      role="alert"
      className="max-w-md text-center bg-white border border-slate-200 rounded-2xl p-8 shadow-sm space-y-4"
    >
      <div className="mx-auto w-12 h-12 rounded-2xl bg-rose-50 text-rose-600 grid place-items-center">
        <svg
          xmlns="http://www.w3.org/2000/svg"
          width="22"
          height="22"
          viewBox="0 0 24 24"
          fill="none"
          stroke="currentColor"
          strokeWidth="2"
          strokeLinecap="round"
          strokeLinejoin="round"
          aria-hidden="true"
        >
          <path d="M10.29 3.86 1.82 18a2 2 0 0 0 1.71 3h16.94a2 2 0 0 0 1.71-3L13.71 3.86a2 2 0 0 0-3.42 0Z" />
          <line x1="12" y1="9" x2="12" y2="13" />
          <line x1="12" y1="17" x2="12.01" y2="17" />
        </svg>
      </div>
      <div>
        <h1 className="text-[15px] font-bold text-slate-900">
          تعذّر الاتصال بالخادم
        </h1>
        <p className="text-[12.5px] text-slate-500 mt-1.5 leading-relaxed">
          نحتاج قائمة الفروع قبل عرض شاشة تسجيل الدخول.
        </p>
        <p className="text-[11.5px] text-slate-400 mt-3 font-mono break-words" dir="auto">
          {message}
        </p>
      </div>
      <button
        onClick={onRetry}
        className="inline-flex items-center gap-2 px-5 py-2.5 rounded-xl bg-slate-900 hover:bg-slate-700 text-white text-[12.5px] font-semibold transition-colors"
      >
        إعادة المحاولة
      </button>
    </div>
  </div>
);

export default App;
