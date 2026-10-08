import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { apiGet, sar } from '../services/dyposApi';
import { useData } from '../contexts/DataContext';
import { useAuthz } from '../contexts/AuthzContext';
import { useEntitlement } from '../contexts/EntitlementContext';
import { offlineSyncService, type OfflineSyncState } from '../services/offlineSyncService';
import { buildWorkQueue, type WorkItem } from '../services/workQueue';
import { navItemById } from '../config/navigation';

/**
 * WORK CENTRE DATA ENGINE
 *
 * One hook owns every number and every exception on the home screen, because a
 * home screen assembled from seven independent `useEffect` blocks is how a
 * "confident zero" appears: one fetch fails, another renders a default, and
 * the operator reads a lie. Here every fetch lands in one place, failures are
 * named in `degraded`, and nothing renders a default.
 *
 * Two invariants:
 *
 *  1. **The server computes; the client explains.** Revenue, stock value,
 *     KPI status and benchmarks come from PostgreSQL. The hook only derives
 *     *rankings* (which exception is worst) and *explanations* (why it is
 *     worst), never new figures.
 *  2. **No action is shown that cannot be executed.** Every situation carries
 *     the screen that resolves it, and the list is filtered through the same
 *     four-level licence the shell enforces — an exception you cannot act on
 *     is noise, not information.
 */

export interface OperationalKpis {
  revenueToday: number;
  netToday: number;
  vatToday: number;
  invoicesToday: number;
  stockUnits: number;
  lowStock: number;
  stockValue: number;
  customers: number;
  employees: number;
  suppliers: number;
  all_invoices: number;
}

export interface KpiBreach {
  code: string;
  name: string;
  category: string;
  unit: string;
  value: number | null;
  benchmark: number | null;
  status: 'ok' | 'warn' | 'critical' | 'insufficient_data';
  narrative: string;
  action: string;
}

export type SituationSeverity = 'critical' | 'warning' | 'info';

export interface Situation {
  id: string;
  severity: SituationSeverity;
  title: string;
  detail: string;
  count: number;
  exposure: number | null;
  exposureUnit: 'currency' | 'units' | 'count';
  actionLabel: string;
  target: string;
  /** Permission needed to act. Hidden from users who lack it. */
  permissions?: string[];
}

export interface WorkCard {
  key: string;
  title: string;
  subtitle: string;
  metric: string;
  metricLabel: string;
  actionLabel: string;
  target: string;
  permissions?: string[];
}

export interface DegradedSource {
  source: string;
  reason: string;
}

export interface TrendPoint {
  day: string;
  revenue: number;
  invoices: number;
}

export interface TopProduct {
  name: string;
  qty: number;
  sales: number;
}

export interface PaymentMix {
  payment_method: string;
  value: number;
  invoices: number;
}

export interface WorkCenter {
  loading: boolean;
  busy: boolean;
  degraded: DegradedSource[];
  kpis: OperationalKpis | null;
  breaches: KpiBreach[];
  situations: Situation[];
  cards: WorkCard[];
  trend: TrendPoint[];
  topProducts: TopProduct[];
  paymentMix: PaymentMix[];
  overdueWork: number;
  overdueValue: number;
  periodClosed: boolean;
  pendingSync: number;
  offline: boolean;
  branchId?: string;
  refresh: () => Promise<void>;
}

const EMPTY_KPIS: OperationalKpis = {
  revenueToday: 0, netToday: 0, vatToday: 0, invoicesToday: 0,
  stockUnits: 0, lowStock: 0, stockValue: 0,
  customers: 0, employees: 0, suppliers: 0, all_invoices: 0,
};

const num = (v: unknown): number => {
  const n = Number(v);
  return Number.isFinite(n) ? n : 0;
};

const SEVERITY_RANK: Record<SituationSeverity, number> = {
  critical: 0, warning: 1, info: 2,
};

export function useWorkCenter(): WorkCenter {
  const data = useData();
  const { can } = useAuthz();
  const { allowsScreen, sector } = useEntitlement();

  const [kpis, setKpis] = useState<OperationalKpis | null>(null);
  const [breaches, setBreaches] = useState<KpiBreach[]>([]);
  const [trend, setTrend] = useState<TrendPoint[]>([]);
  const [topProducts, setTopProducts] = useState<TopProduct[]>([]);
  const [paymentMix, setPaymentMix] = useState<PaymentMix[]>([]);
  const [queue, setQueue] = useState<WorkItem[]>([]);
  const [periodClosed, setPeriodClosed] = useState(false);
  const [sync, setSync] = useState<OfflineSyncState>(() => offlineSyncService.getState());
  const [degraded, setDegraded] = useState<DegradedSource[]>([]);
  const [loading, setLoading] = useState(true);
  const [busy, setBusy] = useState(false);

  const branchId = data.selectedBranch?.id;

  useEffect(() => offlineSyncService.subscribe(setSync), []);

  const cancelled = useRef(false);
  const refreshInFlight = useRef(false);
  useEffect(() => {
    cancelled.current = false;
    return () => { cancelled.current = true; };
  }, []);

  const refresh = useCallback(async () => {
    if (refreshInFlight.current) return;
    refreshInFlight.current = true;
    setBusy(true);
    setLoading(true);
    const problems: DegradedSource[] = [];
    const safe = async <T>(source: string, run: () => Promise<T>): Promise<T | null> => {
      try {
        return await run();
      } catch (e: any) {
        problems.push({ source, reason: e?.message || 'تعذّر القراءة' });
        return null;
      }
    };

    try {
      const branch = branchId ? `?branchId=${branchId}` : '';
      const [dash, kpi, trnd, top, pay, q, period] = await Promise.all([
        safe('حركة اليوم', () => apiGet<OperationalKpis>(`/api/db/dashboard${branch}`)),
        safe('المؤشرات', () => apiGet<{ items: KpiBreach[] }>(`/api/erp/kpi${branch}`)),
        safe('اتجاه المبيعات', () => apiGet<{ items: TrendPoint[] }>('/api/db/reports/daily-sales?days=14')),
        safe('الأصناف الأعلى', () => apiGet<{ items: TopProduct[] }>('/api/db/reports/top-products?limit=5')),
        safe('طرق الدفع', () => apiGet<{ items: PaymentMix[] }>('/api/db/reports/payment-methods')),
        safe('طابور العمل', () =>
          apiGet<{ items: WorkItem[] }>(`/api/db/work-queue?sector=${sector}${branchId ? `&branchId=${branchId}` : ''}`)),
        safe('حالة الفترة', () =>
          apiGet<{ status: string }>(`/api/erp/periods/${new Date().toISOString().slice(0, 7)}/status`)),
      ]);

      if (cancelled.current) return;

      if (dash) setKpis({ ...EMPTY_KPIS, ...dash });
      if (kpi) {
        setBreaches(
          (kpi.items || [])
            .filter((i) => i.status === 'critical' || i.status === 'warn')
            .slice(0, 5),
        );
      }
      if (trnd) {
        setTrend((trnd.items || []).map((t) => ({
          day: t.day, revenue: num(t.revenue), invoices: num(t.invoices),
        })));
      }
      if (top) {
        setTopProducts((top.items || []).map((t) => ({
          name: t.name, qty: num(t.qty), sales: num(t.sales),
        })));
      }
      if (pay) {
        setPaymentMix((pay.items || []).map((p) => ({
          payment_method: p.payment_method, value: num(p.value), invoices: num(p.invoices),
        })));
      }
      if (q) setQueue(q.items || []);
      if (period) setPeriodClosed(period.status === 'closed');

      setDegraded(problems);
    } finally {
      if (!cancelled.current) {
        setBusy(false);
        setLoading(false);
      }
      refreshInFlight.current = false;
    }
    // `sector` and `branchId` are the only inputs that change what is fetched;
    // everything else is read at use time.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [sector, branchId]);

  useEffect(() => {
    void refresh();
  }, [refresh]);

  useEffect(() => {
    const onVisible = () => {
      if (document.visibilityState === 'visible' && navigator.onLine) {
        void refresh();
      }
    };
    document.addEventListener('visibilitychange', onVisible);
    return () => document.removeEventListener('visibilitychange', onVisible);
  }, [refresh]);

  const scored = useMemo(() => buildWorkQueue(queue), [queue]);

  const overdue = useMemo(() => {
    const now = Date.now();
    const items = scored.filter((i) => i.dueAt && new Date(i.dueAt).getTime() < now);
    return {
      items,
      count: items.length,
      value: Math.round(items.reduce((s, i) => s + (num(i.amount) || 0), 0)),
    };
  }, [scored]);


  const situations = useMemo(() => {
    const out: Situation[] = [];

    // ---- Licence and integrity first: nothing below means anything if the
    //      source of truth could not be read.
    if (data.report.failed.length > 0) {
      out.push({
        id: 'data-failed',
        severity: 'critical',
        title: 'مصادر بيانات غير قابلة للقراءة',
        detail: data.report.failed.map((f) => f.name).join('، '),
        count: data.report.failed.length,
        exposure: null,
        exposureUnit: 'count',
        actionLabel: 'إعادة التحميل',
        target: 'dashboard',
      });
    }

    const pending = sync.queue.filter((q) => !q.synced).length;
    if (!sync.isOnline) {
      out.push({
        id: 'offline',
        severity: pending > 0 ? 'critical' : 'warning',
        title: 'الجهاز يعمل دون اتصال',
        detail: pending > 0
          ? `${pending} عملية محفوظة محلياً فقط وتنتظر العودة للشبكة`
          : 'البيع مستمر محلياً — لا توجد عمليات معلّقة',
        count: pending,
        exposure: null,
        exposureUnit: 'count',
        actionLabel: 'فتح المزامنة',
        target: 'settings',
      });
    } else if (pending > 0) {
      out.push({
        id: 'pending-sync',
        severity: 'warning',
        title: 'عمليات بانتظار المزامنة',
        detail: `${pending} عملية لم تصل للخادم بعد — الرصيد المركزي أقدم من الواقع المحلي`,
        count: pending,
        exposure: null,
        exposureUnit: 'count',
        actionLabel: 'مزامنة الآن',
        target: 'settings',
      });
    }

    if (periodClosed) {
      out.push({
        id: 'period-closed',
        severity: 'warning',
        title: 'الفترة المحاسبية مغلقة',
        detail: 'القيود الجديدة لن تُرحَّل حتى تُفتح فترة — تحقق قبل أي تسوية',
        count: 1,
        exposure: null,
        exposureUnit: 'count',
        actionLabel: 'القوائم المالية',
        target: 'financials',
        permissions: ['period.reopen', 'ledger.post'],
      });
    }

    // ---- Money: receivables, payables, unposted journals.
    const receivable = data.customers.filter((c) => num(c.balance) > 0);
    const receivableTotal = Math.round(receivable.reduce((s, c) => s + num(c.balance), 0));
    if (receivable.length > 0) {
      out.push({
        id: 'receivable',
        severity: receivableTotal > 0 ? 'warning' : 'info',
        title: 'ذمم مدينة معلّقة',
        detail: `${receivable.length} عميل بأرصدة مدينة غير محصّلة`,
        count: receivable.length,
        exposure: receivableTotal,
        exposureUnit: 'currency',
        actionLabel: 'تحصيل وتسوية',
        target: 'customer',
        permissions: ['customer.view'],
      });
    }

    const payable = data.suppliers.filter((s) => num((s as any).balanceDue) > 0);
    const payableTotal = Math.round(payable.reduce((s, x) => s + num((x as any).balanceDue), 0));
    if (payable.length > 0) {
      out.push({
        id: 'payable',
        severity: 'info',
        title: 'التزامات للموردين',
        detail: `${payable.length} مورد بمستحقات واجبة أو قريبة`,
        count: payable.length,
        exposure: payableTotal,
        exposureUnit: 'currency',
        actionLabel: 'مراجعة المشتريات',
        target: 'purchases',
        permissions: ['purchase.view'],
      });
    }

    const drafts = data.journalEntries.filter((j) => j.status === 'draft');
    const draftTotal = Math.round(drafts.reduce((s, j) => s + num((j as any).amount), 0));
    if (drafts.length > 0) {
      out.push({
        id: 'unposted',
        severity: periodClosed ? 'critical' : 'warning',
        title: 'قيود غير مرحّلة',
        detail: `${drafts.length} قيد مسودة لا تظهر في الأستاذ — الدفاتر أقدم من الواقع`,
        count: drafts.length,
        exposure: draftTotal > 0 ? draftTotal : null,
        exposureUnit: 'currency',
        actionLabel: 'الترحيل والمراجعة',
        target: 'ledger',
        permissions: ['ledger.post'],
      });
    }


    // ---- Stock: out of stock, under the reorder level, near-expiry batches.
    const zero = data.products.filter((p) => num(p.stock) <= 0);
    if (zero.length > 0) {
      out.push({
        id: 'out-of-stock',
        severity: 'critical',
        title: 'أصناف نفد مخزونها',
        detail: 'بيعها الآن يعني فاتورة بلا تسليم أو رفض بيع عند الكاشير',
        count: zero.length,
        exposure: zero.length,
        exposureUnit: 'units',
        actionLabel: 'إعادة الطلب',
        target: 'inventory',
        permissions: ['inventory.adjust', 'inventory.view'],
      });
    }

    const low = data.products.filter((p) => num(p.stock) > 0 && num(p.stock) <= num(p.minStock));
    if (low.length > 0) {
      const refill = Math.round(
        low.reduce((s, p) => s + Math.max(0, num(p.minStock) - num(p.stock)) * num(p.cost), 0),
      );
      out.push({
        id: 'low-stock',
        severity: 'warning',
        title: 'مخزون دون حد الأمان',
        detail: `${low.length} صنفاً يقترب من النفاد`,
        count: low.length,
        exposure: refill > 0 ? refill : null,
        exposureUnit: 'currency',
        actionLabel: 'اعتماد أمر شراء',
        target: 'inventory',
        permissions: ['inventory.adjust', 'inventory.view'],
      });
    }

    const month = 30 * 24 * 3600 * 1000;
    const expiring = scored.filter((i) =>
      i.kind === 'batch' && i.dueAt && new Date(i.dueAt).getTime() - Date.now() < month);
    if (expiring.length > 0) {
      out.push({
        id: 'expiry',
        severity: 'warning',
        title: 'دفعات على وشك الانتهاء',
        detail: `${expiring.length} دفعة تنتهي خلال 30 يوماً — بيعها أولاً أو خسارتها`,
        count: expiring.length,
        exposure: Math.round(expiring.reduce((s, i) => s + num(i.amount), 0)),
        exposureUnit: 'units',
        actionLabel: 'مراجعة الدفعات',
        target: 'batch_expiry',
        permissions: ['batch.view'],
      });
    }

    // ---- Time: overdue operational work.
    if (overdue.count > 0) {
      out.push({
        id: 'overdue-work',
        severity: 'critical',
        title: 'أعمال تجاوزت موعدها',
        detail: `التزامات للعملاء تجاوزت التسليم — ${overdue.value > 0 ? `بقيمة ${overdue.value.toLocaleString('ar-SA')} ر.س` : 'راجع الأولويات'}`,
        count: overdue.count,
        exposure: overdue.value > 0 ? overdue.value : null,
        exposureUnit: 'currency',
        actionLabel: 'إعادة الجدولة',
        target: 'work_order',
      });
    }

    // ---- KPI breaches, ranked by the server's own severity.
    for (const b of breaches) {
      out.push({
        id: `kpi-${b.code}`,
        severity: b.status === 'critical' ? 'critical' : 'warning',
        title: b.name,
        detail: b.narrative,
        count: 1,
        exposure: b.unit === 'currency' && b.value !== null ? Math.round(b.value) : null,
        exposureUnit: b.unit === 'currency' ? 'currency' : 'count',
        actionLabel: b.action || 'عرض التقارير',
        target: 'reports',
        permissions: ['reports.view'],
      });
    }


    // Most severe first, then the largest exposure. Two operators looking at
    // this list always agree on what is next.
    const ranked = out.sort((a, b) =>
      SEVERITY_RANK[a.severity] - SEVERITY_RANK[b.severity]
      || (b.exposure ?? 0) - (a.exposure ?? 0));

    // An exception you cannot act on is noise: keep only situations whose
    // resolving screen is licensed and whose action you may run.
    return ranked.filter((s) => {
      if (!navItemById(s.target)) return false;
      if (!allowsScreen(s.target)) return false;
      if (s.permissions && s.permissions.length > 0 && !can(...s.permissions)) return false;
      return true;
    });
  }, [data, breaches, scored, overdue, sync, periodClosed, allowsScreen, can]);

  const cards = useMemo(() => {
    const list: WorkCard[] = [];
    const k = kpis ?? EMPTY_KPIS;

    const draftPOs = data.purchaseOrders.filter(
      (po) => po.status === 'draft' || po.status === 'approved').length;
    const zeroCount = data.products.filter((p) => num(p.stock) <= 0).length;
    const lowCount = k.lowStock;
    const unposted = data.journalEntries.filter((j) => j.status === 'draft').length;

    list.push({
      key: 'sell',
      title: 'بيع اليوم',
      subtitle: `${k.invoicesToday} فاتورة منجزة`,
      metric: sar(k.revenueToday),
      metricLabel: 'إيراد اليوم',
      actionLabel: 'المبيعات',
      target: 'pos',
      permissions: ['sales.create'],
    });

    list.push({
      key: 'shift',
      title: data.shift.isOpen ? 'وردية مفتوحة' : 'لا وردية مفتوحة',
      subtitle: data.shift.isOpen
        ? `الكاشير ${data.shift.cashierName || '—'} · ${data.shift.transactionsCount} حركة`
        : 'افتح وردية من شاشة الفروع قبل البيع',
      metric: data.shift.isOpen ? 'مفتوحة' : 'مغلقة',
      metricLabel: 'حالة الوردية',
      actionLabel: 'الفروع والورديات',
      target: 'branches',
    });

    list.push({
      key: 'stock',
      title: 'المخزون الحي',
      subtitle: zeroCount > 0 ? `${zeroCount} صنفاً نافداً` : 'بلا أصناف نافدة',
      metric: lowCount > 0 ? `${lowCount} دون الأمان` : 'سليم',
      metricLabel: 'حدود الأمان',
      actionLabel: 'إدارة المخزون',
      target: 'inventory',
      permissions: ['inventory.view', 'inventory.adjust'],
    });

    list.push({
      key: 'supply',
      title: 'التوريد',
      subtitle: draftPOs > 0 ? `${draftPOs} طلباً بانتظار الاعتماد` : 'لا طلبات معلّقة',
      metric: `${data.suppliers.length} مورد`,
      metricLabel: 'قاعدة الموردين',
      actionLabel: 'المشتريات',
      target: 'purchases',
      permissions: ['purchase.view'],
    });

    list.push({
      key: 'ledger',
      title: 'دفتر اليوم',
      subtitle: unposted > 0 ? `${unposted} قيداً بانتظار الترحيل` : 'كل القيود مرحّلة',
      metric: `${data.journalEntries.length} قيد`,
      metricLabel: 'قيود الفترة',
      actionLabel: 'المحاسبة',
      target: 'ledger',
      permissions: ['ledger.view', 'ledger.post'],
    });


    list.push({
      key: 'receivable',
      title: 'التحصيل',
      subtitle: `${k.customers} عميلاً في الدليل`,
      metric: sar(data.customers.reduce((s, c) => s + Math.max(0, num(c.balance)), 0)),
      metricLabel: 'ذمم مستحقة',
      actionLabel: 'ملف العملاء',
      target: 'customer',
      permissions: ['customer.view'],
    });

    list.push({
      key: 'reports',
      title: 'القرار',
      subtitle: breaches.length > 0
        ? `${breaches.length} مؤشر يحتاج تدخلاً`
        : 'كل المؤشرات ضمن المعيار',
      metric: `${data.transactions.length} حركة`,
      metricLabel: 'حركات محمّلة',
      actionLabel: 'التقارير والتحليلات',
      target: 'reports',
      permissions: ['reports.view'],
    });

    list.push({
      key: 'operations',
      title: 'العمليات المفتوحة',
      subtitle: overdue.count > 0
        ? `${overdue.count} عملاً تجاوز موعده`
        : `${scored.length} عملاً في الطابور`,
      metric: scored.some((i) => i.priority === 'critical') ? 'حرج' : 'مستقر',
      metricLabel: 'أولوية الطابور',
      actionLabel: 'أوامر العمل',
      target: 'work_order',
    });

    return list.filter((c) => {
      if (!navItemById(c.target)) return false;
      if (!allowsScreen(c.target)) return false;
      if (c.permissions && c.permissions.length > 0 && !can(...c.permissions)) return false;
      return true;
    });
  }, [kpis, data, breaches, overdue, scored, allowsScreen, can]);

  return {
    loading,
    busy,
    degraded,
    kpis,
    breaches,
    situations,
    cards,
    trend,
    topProducts,
    paymentMix,
    overdueWork: overdue.count,
    overdueValue: overdue.value,
    periodClosed,
    pendingSync: sync.queue.filter((q) => !q.synced).length,
    offline: !sync.isOnline,
    branchId,
    refresh,
  };
}

export default useWorkCenter;

