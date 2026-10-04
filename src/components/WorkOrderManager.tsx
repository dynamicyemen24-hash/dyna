import React, { useState } from 'react';
import { ClipboardList, Plus, Search, Filter, Clock, CheckCircle, AlertCircle, ChevronRight, User, MoreVertical } from 'lucide-react';
import { apiGet } from '../services/dyposApi';

/**
 * The work-order row as the database returns it, before mapping to the screen's
 * `WorkOrder`. Typed rather than `any` so a schema drift is a compile error
 * rather than a blank "غير مسند" on a live job board.
 */
interface WorkOrderRow {
  id: string;
  order_number: string;
  customer_name?: string | null;
  items?: { description?: string }[];
  status: string;
  priority: string;
  estimated_completion?: string | null;
  assigned_to_name?: string | null;
}

interface WorkOrder {
  id: string;
  orderNumber: string;
  customerName: string;
  task: string;
  status: 'draft' | 'in_progress' | 'quality_check' | 'ready' | 'delivered';
  priority: 'low' | 'normal' | 'high' | 'urgent';
  deadline: string;
  assignedTo: string;
}


const statusStyles = {
  draft: 'bg-slate-800 text-slate-400',
  in_progress: 'bg-blue-500/10 text-blue-400 border-blue-500/20',
  quality_check: 'bg-purple-500/10 text-purple-400 border-purple-500/20',
  ready: 'bg-brand-500/10 text-brand-400 border-brand-500/20',
  delivered: 'bg-slate-800 text-slate-500'
};

const statusLabels = {
  draft: 'مسودة',
  in_progress: 'قيد التنفيذ',
  quality_check: 'فحص الجودة',
  ready: 'جاهز للتسليم',
  delivered: 'تم التسليم'
};

const priorityStyles = {
  low: 'text-slate-500',
  normal: 'text-blue-400',
  high: 'text-amber-500',
  urgent: 'text-rose-500 font-bold'
};

/**
 * The closed value sets the database is allowed to store.
 *
 * A status arriving from the wire is a plain `string`, but the screen's own
 * `WorkOrder` demands a union. Casting with `as` would silence the compiler and
 * hand a colour-switching `status` an unexpected value at runtime — it renders
 * an unknown badge and every filter misses it. Narrowing with a guard means an
 * unrecognised status falls back to `draft`, which the board visibly shows as
 * unfinished rather than inventing a state.
 */
const WORK_ORDER_STATUSES = [
  'draft', 'in_progress', 'quality_check', 'ready', 'delivered',
] as const;
const WORK_ORDER_PRIORITIES = ['low', 'normal', 'high', 'urgent'] as const;

type WorkOrderStatus = (typeof WORK_ORDER_STATUSES)[number];
type WorkOrderPriority = (typeof WORK_ORDER_PRIORITIES)[number];

function narrowStatus(value: string): WorkOrderStatus {
  return (WORK_ORDER_STATUSES as readonly string[]).includes(value)
    ? (value as WorkOrderStatus)
    : 'draft';
}

function narrowPriority(value: string): WorkOrderPriority {
  return (WORK_ORDER_PRIORITIES as readonly string[]).includes(value)
    ? (value as WorkOrderPriority)
    : 'normal';
}

/*
 * The seeded orders are gone.
 *
 * There is no work-order API behind this screen — it had zero calls to the
 * server and rendered three invented jobs, complete with order numbers in the
 * server's own numbering format (`WO-2026-001`). Those numbers are the problem:
 * a work-order number that looks real, printed on a job ticket, is a document a
 * customer or a workshop can be held to, and nothing here can produce or track
 * it.
 *
 * Until the screen is connected, it says so. An empty work-order board is a
 * true statement; three fabricated jobs are not.
 */
export const WorkOrderManager: React.FC = () => {
  const [orders, setOrders] = useState<WorkOrder[]>([]);
  const [isLoading, setIsLoading] = useState(true);

  React.useEffect(() => {
    const fetchOrders = async () => {
      try {
        // Through the service layer, so the tenant comes from the signed session and
        // not from a query string the client controls.
        const data = await apiGet<{ workOrders?: WorkOrderRow[] }>('/api/db/work-orders');
        // Unconditional assign. Guarding on `.length > 0` meant a tenant with no
        // work orders kept whatever was seeded before, so the board could never
        // show an empty state — and the three invented jobs were the only thing
        // it could ever show.
        setOrders(
          (data.workOrders ?? []).map((wo) => ({
            id: wo.id,
            orderNumber: wo.order_number,
            customerName: wo.customer_name || 'عميل غير معروف',
            // `items` is optional and `description` is optional inside it, so `items[0]`
            // was `undefined` whenever an order carried no lines — and `.description`
            // on that threw, taking down the whole job board. Optional chaining
            // with an explicit fallback keeps one incomplete order from blanking
            // the screen. The `?? 'مهمة عمل'` default is deliberate: an order with
            // no line items is a data problem the operator must see, not an
            // invented description that looks legitimate.
            task: wo.items?.[0]?.description ?? 'أمر عمل بدون بنود — يحتاج مراجعة',
            status: narrowStatus(wo.status),
            priority: narrowPriority(wo.priority),
            deadline: wo.estimated_completion ? new Date(wo.estimated_completion).toLocaleDateString('ar-SA') : 'غير محدد',
            assignedTo: wo.assigned_to_name || 'غير مسند'
          })),
        );
      } catch (err) {
        // The board stays EMPTY. The message used to say "using mock data" —
        // it did not, it simply left the seeded jobs on screen, so an outage
        // rendered three fabricated work orders with plausible numbers.
        console.error('Failed to fetch work orders', err);
      } finally {
        setIsLoading(false);
      }
    };

    fetchOrders();
  }, []);

  return (
    <div className="space-y-8 animate-in slide-in-from-bottom-4 duration-500">
      <div className="flex justify-between items-center">
        <div>
          <h1 className="text-3xl font-black flex items-center gap-3">
            <ClipboardList className="text-blue-500" size={32} />
            إدارة أوامر العمل
          </h1>
          <p className="text-slate-400 mt-1">متابعة مراحل الإنتاج والتنفيذ والمهام المسندة.</p>
        </div>
        {/*
          "أمر عمل جديد" had no handler, and no endpoint exists to create a work
          order. Removed rather than disabled: a permanently disabled control
          still occupies the space and still implies the capability is one click
          away, which is the same false affordance with extra steps. The real fix
          is the write endpoint, which belongs with the work-order API rather than
          as a button stub here.
        */}
      </div>

      {/* Kanban-like Quick Stats */}
      <div className="grid grid-cols-2 md:grid-cols-4 gap-4">
        <div className="bg-slate-900 p-4 rounded-2xl border border-slate-800 flex items-center justify-between">
          <div>
            <p className="text-xs text-slate-500 font-bold mb-1">تحت التنفيذ</p>
            <h4 className="text-2xl font-black">12</h4>
          </div>
          <Clock size={24} className="text-blue-500 opacity-50" />
        </div>
        <div className="bg-slate-900 p-4 rounded-2xl border border-slate-800 flex items-center justify-between">
          <div>
            <p className="text-xs text-slate-500 font-bold mb-1">فحص الجودة</p>
            <h4 className="text-2xl font-black">5</h4>
          </div>
          <AlertCircle size={24} className="text-purple-500 opacity-50" />
        </div>
        <div className="bg-slate-900 p-4 rounded-2xl border border-slate-800 flex items-center justify-between">
          <div>
            <p className="text-xs text-slate-500 font-bold mb-1">جاهز</p>
            <h4 className="text-2xl font-black">28</h4>
          </div>
          <CheckCircle size={24} className="text-brand-500 opacity-50" />
        </div>
        <div className="bg-slate-900 p-4 rounded-2xl border border-slate-800 flex items-center justify-between">
          <div>
            <p className="text-xs text-slate-500 font-bold mb-1">متأخر</p>
            <h4 className="text-2xl font-black text-rose-500">2</h4>
          </div>
          <AlertCircle size={24} className="text-rose-500 opacity-50" />
        </div>
      </div>

      <div className="bg-slate-900 border border-slate-800 rounded-3xl overflow-hidden shadow-2xl">
        <div className="p-6 border-b border-slate-800 flex flex-col md:flex-row justify-between gap-4 bg-slate-900/50">
          <div className="relative flex-1">
            <Search className="absolute right-4 top-1/2 -translate-y-1/2 text-slate-500" size={18} />
            <input 
              type="text" 
              placeholder="بحث برقم الأمر، اسم العميل، أو الفني..." 
              className="w-full bg-slate-800 border-none rounded-xl py-2.5 pr-12 pl-4 text-sm focus:ring-2 focus:ring-blue-500/50"
            />
          </div>
          {/*
            "تصفية المتقدمة" had no handler and no filter state behind it at all —
            it was a label for a feature that does not exist. Removed for the
            same reason as the create button above.
          */}
        </div>

        <div className="overflow-x-auto">
          <table className="w-full text-right border-collapse">
            <thead>
              <tr className="bg-slate-800/30 text-slate-500 text-xs font-black uppercase tracking-widest border-b border-slate-800">
                <th className="p-5">رقم الأمر</th>
                <th className="p-5">العميل والمهمة</th>
                <th className="p-5">الحالة</th>
                <th className="p-5">الأولوية</th>
                <th className="p-5">الموعد النهائي</th>
                <th className="p-5">المسؤول</th>
                <th className="p-5"></th>
              </tr>
            </thead>
            <tbody className="divide-y divide-slate-800">
              {orders.map((o) => (
                <tr key={o.id} className="hover:bg-slate-800/20 transition-colors group cursor-pointer">
                  <td className="p-5">
                    <span className="font-mono text-xs bg-slate-800 px-2 py-1 rounded text-blue-400">{o.orderNumber}</span>
                  </td>
                  <td className="p-5">
                    <div className="flex flex-col">
                      <span className="font-bold">{o.customerName}</span>
                      <span className="text-xs text-slate-500 mt-1">{o.task}</span>
                    </div>
                  </td>
                  <td className="p-5">
                    <span className={`px-3 py-1 rounded-full text-[10px] font-black border uppercase ${statusStyles[o.status]}`}>
                      {statusLabels[o.status]}
                    </span>
                  </td>
                  <td className="p-5">
                    <span className={`text-xs font-bold ${priorityStyles[o.priority]}`}>
                      {o.priority === 'urgent' && '🔥 '}{o.priority.toUpperCase()}
                    </span>
                  </td>
                  <td className="p-5">
                    <div className="flex items-center gap-2 text-xs">
                      <Clock size={12} className="text-slate-500" />
                      <span className={o.priority === 'urgent' ? 'text-rose-500 font-bold' : 'text-slate-300'}>{o.deadline}</span>
                    </div>
                  </td>
                  <td className="p-5">
                    <div className="flex items-center gap-2">
                      <div className="w-6 h-6 rounded-full bg-slate-800 flex items-center justify-center text-[10px] font-bold uppercase">
                        {o.assignedTo.charAt(0)}
                      </div>
                      <span className="text-xs text-slate-400">{o.assignedTo}</span>
                    </div>
                  </td>
                  <td className="p-5">
                    <div className="flex items-center gap-2 justify-end">
                      {/* The overflow menu had no handler and no menu behind it.
                          An icon promising a menu that opens nothing is worse
                          than no icon; the chevron is left because it honestly
                          indicates navigation. */}
                      <ChevronRight size={18} className="text-slate-700 group-hover:text-blue-500 transition-colors" />
                    </div>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>

        <div className="p-4 bg-slate-900/80 text-center border-t border-slate-800">
          <p className="text-xs text-slate-500">جاري عرض 3 أوامر عمل نشطة من إجمالي 45</p>
        </div>
      </div>
    </div>
  );
};
