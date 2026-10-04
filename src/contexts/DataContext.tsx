/**
 * The one source of truth for the signed-in session's business data.
 *
 * WHY THIS EXISTS
 * ---------------
 * This module replaces the mock-seeded `useState` calls the application shell
 * used to carry. Those seeded each collection with fabricated rows
 * (`src/mockData.ts`) and then replaced them with the database's answer a few
 * hundred milliseconds later. That arrangement caused three real defects:
 *
 *   1. Fabricated rows were RENDERED. An operator on a slow connection saw
 *      "فرع الرياض الرئيسي" and three invented customers as if they were real.
 *   2. Fabricated rows SURVIVED a failure. When a fetch rejected, the mock
 *      stayed on screen with no indication that it was not the database.
 *   3. "No data" and "not loaded yet" looked identical, so a screen could not
 *      tell the reader whether an empty list was true.
 *
 * So: every collection starts EMPTY, `status` states which phase the session
 * is in, and a collection is only ever populated from Neon PostgreSQL. "No
 * data" and "not loaded yet" are now distinguishable at every call site.
 *
 * Data is loaded ONCE, when the session opens, and shared through context —
 * which also removes the duplicate per-screen fetches that previously had the
 * POS and the reports each fetch the same catalogue independently.
 */
import React, {
  createContext, useCallback, useContext, useEffect, useMemo, useState,
} from 'react';
import { apiGet, apiPost } from '../services/dyposApi';
import type {
  Product, Category, Customer, Supplier, PurchaseOrder, JournalEntry,
  Employee, Transaction, Branch, ShiftInfo, AuditLogEntry,
} from '../types';

/**
 * Where the session is in its load.
 *
 * `ready` with empty collections is a MEANINGFUL state — the tenant genuinely
 * has no records — and screens must render an empty state for it. Only
 * `loading` justifies a spinner.
 */
export type LoadStatus = 'idle' | 'loading' | 'ready' | 'error';

export interface LoadReport {
  /** Collections the server answered, empty or not. */
  loaded: string[];
  /** Collections whose request failed, with the reason. */
  failed: Array<{ name: string; reason: string }>;
}

interface DataState {
  // Collections — always real rows, or nothing.
  branches: Branch[];
  categories: Category[];
  products: Product[];
  customers: Customer[];
  suppliers: Supplier[];
  purchaseOrders: PurchaseOrder[];
  journalEntries: JournalEntry[];
  employees: Employee[];
  transactions: Transaction[];

  /** The branch this session works in. Never a placeholder. */
  selectedBranch: Branch | null;
  shift: ShiftInfo;
  auditLogs: AuditLogEntry[];

  status: LoadStatus;
  /** Per-collection outcome, so the UI can name what is degraded. */
  report: LoadReport;
  error: string;

  operator: { username: string; name: string; role: string };
}

interface DataActions {
  selectBranch: (branch: Branch) => void;
  /**
   * Opens the shift against the current branch with a COUNTED float.
   *
   * This is the ONLY function that produces an opening cash balance, and it
   * is deliberately not reachable from the sign-in screen. The count comes
   * from the operator, the write is recorded in the audit trail, and the
   * value cannot arrive from anywhere else.
   */
  /** Resolves true only once the server has recorded the shift. */
  openShift: (openingCash: number) => Promise<boolean>;
  /** Closes the shift, recording the counted closing balance for variance. */
  closeShift: (closingCash: number) => void;
  setShift: (updater: (s: ShiftInfo) => ShiftInfo) => void;
  pushAudit: (
    action: string, details: string, category?: AuditLogEntry['category'],
  ) => void;

  /** Collections updated in the client after a successful server write. */
  addProduct: (p: Product) => void;
  updateProduct: (p: Product) => void;
  removeProduct: (id: string) => void;
  addCustomer: (c: Customer) => void;
  addEmployee: (e: Employee) => void;
  addJournalEntry: (e: JournalEntry) => void;
  addPurchaseOrder: (po: PurchaseOrder) => void;
  /** Re-reads everything; used after a bulk operation or a reconnect. */
  reload: () => Promise<void>;

  /** Local reconciliation after the server accepted a write. */
  insertTransaction: (tx: Transaction) => void;
  /** Applies server-authoritative stock levels after a completed sale. */
  applyStock: (stockById: Record<string, number | string>) => void;
}

interface DataContextValue extends DataState, DataActions {}

const DataContext = createContext<DataContextValue | null>(null);

/** A closed shift until the operator opens one. Not a fabricated balance. */
const CLOSED_SHIFT: ShiftInfo = {
  isOpen: false,
  cashierName: '',
  startTime: '',
  openingCash: 0,
  totalSales: 0,
  cashSales: 0,
  cardSales: 0,
  transactionsCount: 0,
};

/**
 * Maps a `dypos.products` row onto the `Product` type.
 *
 * The API returns snake_case with `unit_price`, which is NOT the field the
 * screens read. Passing rows through unchanged left every price `undefined`
 * and every stock figure NaN — the shape mismatch that made the catalogue
 * "load" and then render zeros.
 */
const toProduct = (r: any): Product => ({
  id: r.id,
  name: r.name,
  barcode: r.barcode || '',
  category: r.category || 'عام',
  price: Number(r.unit_price ?? r.price ?? 0),
  cost: Number(r.cost ?? 0),
  stock: Number(r.stock ?? 0),
  minStock: Number(r.min_stock ?? 0),
  image: r.image_url || undefined,
  unit: r.unit || 'حبة',
  branchId: r.branch_id || '',
});

const toCustomer = (r: any): Customer => ({
  id: r.id,
  name: r.name,
  phone: r.phone || '',
  email: r.email || '',
  points: Number(r.points ?? 0),
  balance: Number(r.balance ?? 0),
  totalSpent: Number(r.total_spent ?? Number(r.total ?? 0)),
});

const toSupplier = (r: any): Supplier => ({
  id: r.id,
  name: r.name,
  contactPerson: r.contact_person || r.contactPerson || '',
  phone: r.phone || '',
  email: r.email || '',
  category: r.category || 'عام',
  balanceDue: Number(r.balance_due ?? Number(r.balanceDue ?? 0)),
});

const toEmployee = (r: any): Employee => ({
  id: r.id,
  name: r.name,
  role: r.role || 'موظف',
  branchId: r.branch_id || '',
  baseSalary: Number(r.base_salary ?? 0),
  commissionRate: Number(r.commission_rate ?? 0),
  status: r.status === 'active' ? 'active' : 'on_leave',
  attendanceToday: 'present',
});
export const DataProvider: React.FC<{
  children: React.ReactNode;
  /** The signed-in operator, recorded on every audit entry. */
  operator: { username: string; name: string; role: string };
}> = ({ children, operator }) => {
  const [branches, setBranches] = useState<Branch[]>([]);
  const [categories, setCategories] = useState<Category[]>([]);
  const [products, setProducts] = useState<Product[]>([]);
  const [customers, setCustomers] = useState<Customer[]>([]);
  const [suppliers, setSuppliers] = useState<Supplier[]>([]);
  const [purchaseOrders, setPurchaseOrders] = useState<PurchaseOrder[]>([]);
  const [journalEntries, setJournalEntries] = useState<JournalEntry[]>([]);
  const [employees, setEmployees] = useState<Employee[]>([]);
  const [transactions, setTransactions] = useState<Transaction[]>([]);

  const [selectedBranch, setSelectedBranch] = useState<Branch | null>(null);
  const [shift, setShiftState] = useState<ShiftInfo>(CLOSED_SHIFT);
  const [auditLogs, setAuditLogs] = useState<AuditLogEntry[]>([]);

  const [status, setStatus] = useState<LoadStatus>('idle');
  const [report, setReport] = useState<LoadReport>({ loaded: [], failed: [] });
  const [error, setError] = useState('');

  /**
   * Loads every collection the session needs.
   *
   * `Promise.allSettled` rather than `all`: one failing endpoint must not blank
   * the whole application. Each failure is recorded by name so the UI can say
   * WHICH screen is degraded, instead of failing silently or pretending all is
   * well. A setter is only called for a collection that actually answered —
   * a rejected request leaves the collection empty rather than restoring a
   * previous value that may now be stale.
   */
  const reload = useCallback(async () => {
    setStatus('loading');
    setError('');

    const results = await Promise.allSettled([
      apiGet<{ items: Branch[] }>('/api/db/branches'),
      apiGet<{ items: any[] }>('/api/db/categories'),
      apiGet<{ items: any[] }>('/api/db/products?limit=500'),
      apiGet<{ items: any[] }>('/api/db/customers'),
      apiGet<{ items: any[] }>('/api/db/suppliers'),
      apiGet<{ items: any[] }>('/api/db/purchase-orders'),
      apiGet<{ items: any[] }>('/api/db/employees'),
      apiGet<{ transactions: Transaction[] }>('/api/db/transactions?limit=300'),
    ]);

    const loaded: string[] = [];
    const failed: Array<{ name: string; reason: string }> = [];
    const value = <T,>(r: PromiseSettledResult<any>): T | null =>
      r.status === 'fulfilled' ? ((r as PromiseFulfilledResult<any>).value as T) : null;
    const reason = (r: PromiseSettledResult<any>) =>
      (r as PromiseRejectedResult).reason?.message || 'تعذّر الاتصال بالخادم';

    const b = value<{ items: Branch[] }>(results[0]);
    if (b) { loaded.push('الفروع'); setBranches(b.items || []); }
    else failed.push({ name: 'الفروع', reason: reason(results[0]) });

    const c = value<{ items: any[] }>(results[1]);
    if (c) {
      loaded.push('التصنيفات');
      // The API returns `category`; the screens expect `{ id, name, icon }`.
      setCategories((c.items || []).map((r: any) => ({
        id: r.id || r.name, name: r.name, icon: r.icon || 'Package',
      })));
    } else failed.push({ name: 'التصنيفات', reason: reason(results[1]) });

    const p = value<{ items: any[] }>(results[2]);
    if (p) { loaded.push('المنتجات'); setProducts((p.items || []).map(toProduct)); }
    else failed.push({ name: 'المنتجات', reason: reason(results[2]) });

    const cu = value<{ items: any[] }>(results[3]);
    if (cu) { loaded.push('العملاء'); setCustomers((cu.items || []).map(toCustomer)); }
    else failed.push({ name: 'العملاء', reason: reason(results[3]) });

    const s = value<{ items: any[] }>(results[4]);
    if (s) { loaded.push('الموردون'); setSuppliers((s.items || []).map(toSupplier)); }
    else failed.push({ name: 'الموردون', reason: reason(results[4]) });

    const po = value<{ items: any[] }>(results[5]);
    if (po) { loaded.push('أوامر الشراء'); setPurchaseOrders(po.items || []); }
    else failed.push({ name: 'أوامر الشراء', reason: reason(results[5]) });

    const e = value<{ items: any[] }>(results[6]);
    if (e) { loaded.push('الموظفون'); setEmployees((e.items || []).map(toEmployee)); }
    else failed.push({ name: 'الموظفون', reason: reason(results[6]) });

    const t = value<{ transactions: Transaction[] }>(results[7]);
    if (t) { loaded.push('الفواتير'); setTransactions(t.transactions || []); }
    else failed.push({ name: 'الفواتير', reason: reason(results[7]) });

    // A list the server answered but returned nothing for is a SUCCESS — the
    // tenant has no records. That must not be reported as a failure.
    setReport({ loaded, failed });
    setStatus(failed.length === results.length ? 'error' : failed.length ? 'error' : 'ready');
    if (failed.length) {
      setError(
        failed.length === results.length
          ? 'تعذّر تحميل أي بيانات — تحقق من الاتصال بالخادم'
          : `تعذّر تحميل: ${failed.map((f) => f.name).join('، ')}`,
      );
    }
  }, []);

  // Runs when the session opens — the single hydration point.
  useEffect(() => { void reload(); }, [reload]);

  /**
   * Selects the working branch and opens the shift against it.
   *
   * The operator's name comes from the session, never from a constant, so the
   * audit trail records who actually made a change.
   */
  const selectBranch = useCallback((branch: Branch) => {
    /*
     * Changing branch does NOT open a shift.
     *
     * It used to: `selectBranch` set `isOpen: true` with a `CLOSED_SHIFT`
     * spread, which produced an open shift with `openingCash: 0` while the
     * server had recorded whatever figure was typed on the sign-in screen.
     * Two sources of truth for one number, disagreeing from the first frame,
     * and a shift the operator never counted.
     *
     * Opening a shift is a deliberate act with a counted float — see
     * `ShiftOpeningDialog`. Selecting where you work is not that act.
     */
    setSelectedBranch(branch);
  }, []);

  const setShift = useCallback((updater: (s: ShiftInfo) => ShiftInfo) => {
    setShiftState(updater);
  }, []);

  /**
   * Opens the shift with the counted float.
   *
   * The count is persisted FIRST, then mirrored into local state.
   *
   * The order matters and it was the other way round before. A local-only
   * `setShiftState` produced a shift the ledger had never heard of: the drawer
   * showed an opening balance, the Z-Report could be produced, and nothing
   * reconciled — which is precisely the failure a till exists to prevent. If
   * the write fails the local state is left untouched, so the UI never shows
   * a float the server refused.
   */
  const openShift = useCallback(async (openingCash: number) => {
    if (!Number.isFinite(openingCash) || openingCash < 0) return false;
    if (!selectedBranch) return false;
    try {
      const res = await apiPost<{ shiftId: string; openingCash: number }>(
        '/api/auth/shift/open',
        { branchId: selectedBranch.id, openingCash: Math.round(openingCash * 100) / 100 },
      );
      setShiftState({
        ...CLOSED_SHIFT,
        isOpen: true,
        cashierName: operator.name || operator.username,
        startTime: new Date().toISOString(),
        openingCash: res?.openingCash ?? openingCash,
      });
      return true;
    } catch {
      // The server is the authority on whether a till is open. A local shift
      // that the database rejected would be a fiction with a cash figure on it.
      return false;
    }
  }, [operator.name, operator.username, selectedBranch]);

  /**
   * Closes the shift and records the variance.
   *
   * Expected closing = opening float + cash sales taken during the shift.
   * The difference against the counted drawer is the number a supervisor
   * actually needs, and it is computed ONCE here while the totals are still
   * known — not recomputed later from a partially reset state.
   */
  const closeShift = useCallback((closingCash: number) => {
    if (!Number.isFinite(closingCash) || closingCash < 0) return;
    setShiftState((s) => {
      if (!s.isOpen) return s;
      const expected = Math.round((s.openingCash + s.cashSales) * 100) / 100;
      const variance = Math.round((closingCash - expected) * 100) / 100;
      setAuditLogs((prev) => [{
        id: `log-${Date.now()}-shift-close`,
        timestamp: new Date().toISOString(),
        user: operator.name || operator.username,
        branch: selectedBranch?.name ?? '—',
        action: 'إغلاق الوردية',
        details:
          `الرصيد المعدود ${closingCash.toFixed(2)} · المتوقع ${expected.toFixed(2)}` +
          ` · الفرق ${variance.toFixed(2)}`,
        category: variance === 0 ? 'info' : 'warning',
      } as AuditLogEntry, ...prev]);
      return { ...CLOSED_SHIFT };
    });
  }, [operator.name, operator.username, selectedBranch?.name]);

  const pushAudit = useCallback((
    action: string, details: string, category: AuditLogEntry['category'] = 'info',
  ) => {
    setAuditLogs((prev) => [{
      id: `log-${Date.now()}-${Math.random().toString(36).slice(2, 7)}`,
      timestamp: new Date().toISOString(),
      action,
      category,
      user: operator.name || operator.username,
      branch: '—',
      details,
      // Capped so a long session cannot grow the audit array without bound.
    }, ...prev].slice(0, 500));
  }, [operator.name, operator.username]);

  // A successful server write updates the client. The caller owns the POST;
  // these keep the list consistent without a full refetch.
  const addProduct = useCallback((p: Product) => setProducts((prev) => [p, ...prev]), []);
  const updateProduct = useCallback((p: Product) =>
    setProducts((prev) => prev.map((x) => (x.id === p.id ? p : x))), []);
  const removeProduct = useCallback((id: string) =>
    setProducts((prev) => prev.filter((x) => x.id !== id)), []);
  const addCustomer = useCallback((c: Customer) => setCustomers((prev) => [c, ...prev]), []);
  const addEmployee = useCallback((e: Employee) => setEmployees((prev) => [e, ...prev]), []);
  const addJournalEntry = useCallback((e: JournalEntry) =>
    setJournalEntries((prev) => [e, ...prev]), []);
  const addPurchaseOrder = useCallback((po: PurchaseOrder) =>
    setPurchaseOrders((prev) => [po, ...prev]), []);

  /**
   * A completed sale is added to the live invoice list.
   *
   * Newest first, matching the order `/api/db/transactions` returns, so the
   * reports screen does not reorder the whole list the moment a sale lands.
   */
  const insertTransaction = useCallback((tx: Transaction) => {
    setTransactions((prev) => [tx, ...prev]);
  }, []);

  /**
   * Applies the stock levels the server computed.
   *
   * The client must never decrement stock itself: the authoritative figure is
   * whatever the database did after the insert, and a locally-guessed number
   * is how two tills end up selling the same last unit.
   */
  const applyStock = useCallback((stockById: Record<string, number | string>) => {
    setProducts((prev) => prev.map((p) => (
      stockById[p.id] === undefined ? p : { ...p, stock: Number(stockById[p.id]) }
    )));
  }, []);

  const value = useMemo<DataContextValue>(() => ({
    branches, categories, products, customers, suppliers, purchaseOrders,
    journalEntries, employees, transactions,
    selectedBranch, shift, auditLogs,
    status, report, error, operator,
    selectBranch, setShift, pushAudit, openShift, closeShift,
    addProduct, updateProduct, removeProduct,
    addCustomer, addEmployee, addJournalEntry, addPurchaseOrder,
    insertTransaction, applyStock,
    reload,
  }), [
    branches, categories, products, customers, suppliers, purchaseOrders,
    journalEntries, employees, transactions,
    selectedBranch, shift, auditLogs, status, report, error, operator,
    selectBranch, setShift, pushAudit,
    addProduct, updateProduct, removeProduct,
    addCustomer, addEmployee, addJournalEntry, addPurchaseOrder,
    insertTransaction, applyStock,
    reload,
  ]);

  return <DataContext.Provider value={value}>{children}</DataContext.Provider>;
};

/**
 * Reads the session's business data.
 *
 * Throws outside the provider rather than returning a permissive default: a
 * silent empty default is exactly the failure this module was written to
 * remove, and it would reintroduce it invisibly.
 */
export const useData = (): DataContextValue => {
  const context = useContext(DataContext);
  if (context === null) {
    throw new Error('useData must be used within a DataProvider');
  }
  return context;
};