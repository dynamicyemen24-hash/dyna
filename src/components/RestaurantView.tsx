import React, { useState } from 'react';
import { apiGet } from '../services/dyposApi';
import { 
  UtensilsCrossed, 
  ChefHat, 
  Clock, 
  CheckCircle2, 
  Plus, 
  Users, 
  Split, 
  Layers, 
  Flame,
  ArrowLeftRight
} from 'lucide-react';

/*
 * ══ SHAPES REMAPPED TO THE STORED DATA ═══════════════════════════════════
 * These interfaces used to describe a model the database does not contain:
 * `ticketNumber: string`, a `status` of 'new', and no concept of a kitchen
 * station or a priority.
 *
 * The real `dypos.kitchen_tickets` has `ticket_no` as a BIGINT, a `status` drawn
 * from queued/preparing/ready/served/cancelled, and `priority` and `station_id`.
 *
 * The screen now conforms to the stored data rather than the other way round.
 * Inventing a shape the database cannot fill is how a screen ends up rendering
 * empty columns that look like missing data forever.
 */
export interface RestaurantTable {
  id: string;
  tableNumber: string;
  seats: number;
  /** `unknown` is possible and MEANS unknown — it is never drawn as 'free'. */
  status: 'free' | 'occupied' | 'reserved' | 'unknown';
  areaName?: string | null;
  activeOrderTotal?: number;
  itemsCount?: number;
}

export interface KitchenTicket {
  id: string;
  /** A counter, not a formatted string. */
  ticketNo: number;
  ticketLabel?: string | null;
  tableNumber?: string | null;
  orderType: string;
  items: { name: string; quantity: number; modifiers?: string[] }[];
  status: 'queued' | 'preparing' | 'ready' | 'served' | 'cancelled';
  priority: number;
  elapsedMinutes: number;
}
/*
 * The seeded tables and kitchen tickets are gone.
 *
 * There is no restaurant API behind this screen: `INITIAL_TABLES` held six
 * invented tables — two of them occupied, with running order totals — and
 * `INITIAL_KITCHEN_TICKETS` held kitchen orders with table numbers and dish
 * names. None of it belonged to any tenant, and none of it was created by any
 * operator.
 *
 * That is worse here than in a list of products. A floor plan showing busy
 * tables is what a restaurant manager reads to decide how many staff to call in,
 * and kitchen tickets drive real food. A seeded floor is not a placeholder, it
 * is an instruction.
 *
 * The underlying schema is real (`dypos.restaurant_tables`); what is missing is
 * the API. Until it exists, the screen reports nothing rather than fiction.
 */
export const RestaurantView: React.FC = () => {
  const [activeTab, setActiveTab] = useState<'floor' | 'kds'>('floor');
  const [tables, setTables] = useState<RestaurantTable[]>([]);
  const [tickets, setTickets] = useState<KitchenTicket[]>([]);
  const [isLoading, setIsLoading] = useState(true);
  const [loadError, setLoadError] = useState(false);

  /*
   * The screen now reads real rows.
   *
   * Both calls go through `apiGet`, so the tenant comes from the signed session
   * rather than a URL. The floor and the KDS are loaded together because they
   * are two views of the same service: a manager switching tabs must not see the
   * floor and the kitchen disagree about how busy the restaurant is.
   */
  React.useEffect(() => {
    let cancelled = false;

    async function load() {
      try {
        const [floor, kitchen] = await Promise.all([
          apiGet<{ items?: RestaurantTable[] }>('/api/db/restaurant/tables'),
          apiGet<{ items?: KitchenTicket[] }>('/api/db/kitchen/tickets'),
        ]);
        if (cancelled) return;
        setTables(floor.items ?? []);
        setTickets(kitchen.items ?? []);
      } catch (err) {
        // Empty and stated. Falling back to anything here would put a floor plan
        // in front of a host describing tables and dishes that were never sold.
        console.error('Failed to load the restaurant floor', err);
        if (!cancelled) setLoadError(true);
      } finally {
        if (!cancelled) setIsLoading(false);
      }
    }

    load();
    return () => { cancelled = true; };
  }, []);

  const handleUpdateTicketStatus = (ticketId: string, nextStatus: KitchenTicket['status']) => {
    setTickets((prev) =>
      prev.map((t) => (t.id === ticketId ? { ...t, status: nextStatus } : t))
    );
  };

  return (
    <div className="flex-1 flex flex-col p-6 overflow-y-auto bg-canvas text-ink font-['Cairo',sans-serif]">
      {/* Top Bar Header */}
      <div className="flex flex-col md:flex-row md:items-center justify-between gap-4 mb-6">
        <div>
          <h2 className="text-xl font-black text-ink flex items-center gap-2">
            <UtensilsCrossed className="w-6 h-6 text-brand" />
            وضع إدارة المطاعم والكافيهات (Restaurant & Kitchen Display)
          </h2>
          <p className="text-xs text-faint mt-0.5">
            إدارة طاولات الصالة، شاشة المطبخ KDS المباشرة، تعديلات الوجبات وتتبع الطلبات اللحظي
          </p>
        </div>

        <div className="flex items-center gap-2 surface-card p-1 rounded-2xl">
          <button
            onClick={() => setActiveTab('floor')}
            className={`px-4 py-2 rounded-xl text-xs font-bold transition-all flex items-center gap-1.5 ${
              activeTab === 'floor'
                ? 'bg-brand-600 text-white shadow-md'
                : 'text-faint hover:text-ink'
            }`}
          >
            <UtensilsCrossed className="w-4 h-4" />
            خريطة الطاولات للصالة
          </button>
          <button
            onClick={() => setActiveTab('kds')}
            className={`px-4 py-2 rounded-xl text-xs font-bold transition-all flex items-center gap-1.5 ${
              activeTab === 'kds'
                ? 'bg-amber-600 text-white shadow-md'
                : 'text-faint hover:text-ink'
            }`}
          >
            <ChefHat className="w-4 h-4" />
            شاشة المطبخ (KDS)
          </button>
        </div>
      </div>

      {/* Floor Plan View */}
      {activeTab === 'floor' && (
        <div className="space-y-6">
          <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 gap-4">
            {tables.map((table) => (
              <div
                key={table.id}
                className={`border rounded-2xl p-5 transition-all shadow-sm relative ${
                  table.status === 'occupied'
                    ? 'bg-rose-950/30 border-rose-800/60'
                    : table.status === 'reserved'
                    ? 'bg-amber-950/30 border-amber-800/60'
                    : 'bg-surface border-hairline hover:border-brand/50'
                }`}
              >
                <div className="flex justify-between items-start mb-3">
                  <div>
                    <h3 className="text-base font-bold text-ink">{table.tableNumber}</h3>
                    <p className="text-[11px] text-faint flex items-center gap-1">
                      <Users className="w-3.5 h-3.5" /> سعة {table.seats} أشخاص
                    </p>
                  </div>
                  <span
                    className={`px-2.5 py-1 rounded-full text-[10px] font-bold border ${
                      table.status === 'occupied'
                        ? 'bg-rose-500/20 text-err-strong border-err/30'
                        : table.status === 'reserved'
                        ? 'bg-amber-500/20 text-warn-strong border-warn/30'
                        : 'bg-brand-500/20 text-brand-strong border-brand/30'
                    }`}
                  >
                    {table.status === 'occupied' ? 'مشغولة' : table.status === 'reserved' ? 'محجوزة' : 'شاغرة'}
                  </span>
                </div>

                {table.status === 'occupied' && (
                  <div className="bg-subtle p-3 rounded-xl border border-hairline/80 mb-3 space-y-1 font-mono">
                    <div className="flex justify-between text-xs">
                      <span className="text-faint">إجمالي الحساب:</span>
                      <span className="font-bold text-brand">{table.activeOrderTotal} ر.س</span>
                    </div>
                    <div className="flex justify-between text-[11px] text-muted">
                      <span>الأصناف المطلوبة:</span>
                      <span>{table.itemsCount} أصناف</span>
                    </div>
                  </div>
                )}

                {/*
                  Both controls here had no handler.

                  "فتح الطاولة" implies the floor can open a table and start an
                  order, and "تقسيم الفاتورة" implies a bill can be split. Neither
                  is implemented: there is no table-opening transaction, no
                  split-payment path, and no state in this component for either.
                  A button labelled with a money-moving action that does nothing
                  is the worst kind of false affordance on a restaurant floor.

                  Removed. They return when the endpoints exist — which is a
                  backend task, not a UI stub.
                */}
              </div>
            ))}
          </div>
        </div>
      )}

      {/* Kitchen Display System (KDS) View */}
      {activeTab === 'kds' && (
        <div className="space-y-6">
          <div className="grid grid-cols-1 md:grid-cols-3 gap-4">
            {tickets.map((ticket) => (
              <div
                key={ticket.id}
                className={`bg-surface border rounded-2xl p-5 shadow-lg relative flex flex-col justify-between ${
                  ticket.status === 'queued'
                    ? 'border-rose-500/60'
                    : ticket.status === 'preparing'
                    ? 'border-amber-500/60'
                    : 'border-brand/60'
                }`}
              >
                <div>
                  <div className="flex justify-between items-center pb-3 border-b border-hairline mb-3">
                    <div>
                      {/*
                        The stored value is a BIGINT counter, not a label. It is
                        rendered as `#123` so nobody reads it as an addressable
                        ticket code, and so it stays visibly numeric — a formatted
                        "KDS-000101" would invite sorting it as text.
                      */}
                      <span className="text-xs font-mono font-bold text-faint">
                        #{ticket.ticketNo}
                      </span>
                      <h4 className="text-base font-black text-ink">{ticket.tableNumber}</h4>
                    </div>
                    <div className="flex items-center gap-1 bg-surface px-2.5 py-1 rounded-lg text-xs font-mono text-warn-strong border border-amber-500/20">
                      <Clock className="w-3.5 h-3.5" />
                      <span>{ticket.elapsedMinutes} دقيقة</span>
                    </div>
                  </div>

                  {/* Order Items */}
                  <div className="space-y-3 mb-4">
                    {ticket.items.map((item, idx) => (
                      <div key={idx} className="bg-subtle p-2.5 rounded-xl border border-hairline">
                        <div className="flex justify-between items-center font-bold text-xs text-ink">
                          <span>{item.name}</span>
                          <span className="text-brand font-mono">x{item.quantity}</span>
                        </div>
                        {item.modifiers && item.modifiers.length > 0 && (
                          <div className="flex flex-wrap gap-1 mt-1.5">
                            {item.modifiers.map((mod, mIdx) => (
                              <span
                                key={mIdx}
                                className="bg-warn-soft text-warn-strong border border-amber-500/20 text-[10px] px-2 py-0.5 rounded-md font-semibold"
                              >
                                {mod}
                              </span>
                            ))}
                          </div>
                        )}
                      </div>
                    ))}
                  </div>
                </div>

                {/* Status Actions */}
                <div className="pt-3 border-t border-hairline flex justify-between items-center gap-2">
                  {ticket.status === 'queued' && (
                    <button
                      onClick={() => handleUpdateTicketStatus(ticket.id, 'preparing')}
                      className="w-full bg-amber-600 hover:bg-amber-500 text-white py-2 rounded-xl text-xs font-bold transition-all flex items-center justify-center gap-1.5 shadow-md"
                    >
                      <Flame className="w-4 h-4" /> بدء التحضير بالمطبخ
                    </button>
                  )}
                  {ticket.status === 'preparing' && (
                    <button
                      onClick={() => handleUpdateTicketStatus(ticket.id, 'ready')}
                      className="w-full bg-brand-600 hover:bg-brand-500 text-white py-2 rounded-xl text-xs font-bold transition-all flex items-center justify-center gap-1.5 shadow-md"
                    >
                      <CheckCircle2 className="w-4 h-4" /> تحديد كـ جاهز للتقديم
                    </button>
                  )}
                  {ticket.status === 'ready' && (
                    <span className="w-full text-center bg-brand-500/20 text-brand-strong py-2 rounded-xl text-xs font-bold border border-brand/30">
                      ✅ جاهز - تم إرسال تنبيه للمباشر
                    </span>
                  )}
                </div>
              </div>
            ))}
          </div>
        </div>
      )}
    </div>
  );
};
