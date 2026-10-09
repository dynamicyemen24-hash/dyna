import React, { useEffect, useMemo, useState } from 'react';
import {
  Calendar, Factory, Package, Truck, ListOrdered, Sparkles, Loader2, ArrowLeft,
} from 'lucide-react';
import { apiGet } from '../services/dyposApi';
import {
  buildWorkQueue, groupBySectorPhase, PRIORITY_META,
  type ScoredWork, type WorkItem, type Priority,
} from '../services/workQueue';

const KIND_META: Record<string, { label: string; icon: any; tone: string }> = {
  appointment: { label: 'موعد', icon: Calendar, tone: 'bg-info-soft text-info-strong' },
  production: { label: 'إنتاج', icon: Factory, tone: 'bg-violet-50 text-violet-600' },
  batch: { label: 'دفعة', icon: Package, tone: 'bg-warn-soft text-warn-strong' },
  delivery: { label: 'توصيل', icon: Truck, tone: 'bg-brand-soft text-brand' },
  service: { label: 'خدمة', icon: Sparkles, tone: 'bg-err-soft text-err-strong' },
  purchase: { label: 'شراء', icon: ListOrdered, tone: 'bg-subtle text-muted' },
};

interface SmartQueueProps {
  /** Active sector, used to group the queue into the correct work phases. */
  sector: string;
  branchId?: string;
}

export const SmartQueue: React.FC<SmartQueueProps> = ({ sector, branchId }) => {
  const [items, setItems] = useState<WorkItem[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');

  useEffect(() => {
    let alive = true;
    (async () => {
      try {
        setLoading(true);
        const qs = new URLSearchParams({ sector });
        if (branchId) qs.set('branchId', branchId);
        const res = await apiGet<{ items: WorkItem[] }>(`/api/db/work-queue?${qs}`);
        if (alive) { setItems(res.items || []); setError(''); }
      } catch (e: any) {
        if (alive) setError(e.message || 'تعذّر تحميل طابور العمل');
      } finally {
        if (alive) setLoading(false);
      }
    })();
    return () => { alive = false; };
  }, [sector, branchId]);

  // Score, classify, explain, then split into sector-correct phases.
  const phases = useMemo(
    () => groupBySectorPhase(buildWorkQueue(items), sector),
    [items, sector],
  );

  const counts = useMemo(() => {
    const c: Record<Priority, number> = { critical: 0, high: 0, normal: 0, low: 0 };
    buildWorkQueue(items).forEach((i) => { c[i.priority] += 1; });
    return c;
  }, [items]);

  return (
    <section className="surface-card overflow-hidden">
      <header className="flex items-center justify-between px-5 py-4 border-b border-hairline">
        <div className="flex items-center gap-2">
          <Sparkles size={15} className="text-brand" />
          <h3 className="text-[13px] font-semibold text-ink">طابور العمل الذكي</h3>
        </div>
        <div className="flex items-center gap-1.5">
          {(Object.keys(PRIORITY_META) as Priority[]).map((p) =>
            counts[p] > 0 ? (
              <span
                key={p}
                className={`inline-flex items-center gap-1 px-2 py-0.5 rounded-full border text-[10px] font-semibold ${PRIORITY_META[p].chip}`}
              >
                <span className={`w-1.5 h-1.5 rounded-full ${PRIORITY_META[p].dot}`} />
                {PRIORITY_META[p].label} {counts[p]}
              </span>
            ) : null,
          )}
        </div>
      </header>

      {loading ? (
        <div className="flex items-center justify-center gap-2 py-10 text-[12px] text-faint">
          <Loader2 size={14} className="animate-spin" /> جارٍ ترتيب الأعمال…
        </div>
      ) : error ? (
        <p className="px-5 py-6 text-[12px] text-err-strong">{error}</p>
      ) : items.length === 0 ? (
        <p className="px-5 py-10 text-center text-[12px] text-faint">
          لا توجد أعمال مفتوحة — كل شيء منجز.
        </p>
      ) : (
        <div className="divide-y divide-hairline">
          {phases.map((phase, pi) => (
            <div key={pi}>
              <p className="px-5 pt-4 pb-1.5 text-eyebrow">
                المرحلة {pi + 1} · {phase[0] ? KIND_META[phase[0].kind]?.label : ''}
              </p>
              <ul>
                {phase.map((item) => (
                  <QueueRow key={item.id} item={item} />
                ))}
              </ul>
            </div>
          ))}
        </div>
      )}
    </section>
  );
};

const QueueRow: React.FC<{ item: ScoredWork }> = ({ item }) => {
  const meta = KIND_META[item.kind] ?? { label: item.kind, icon: ListOrdered, tone: 'bg-subtle text-muted' };
  const Icon = meta.icon;
  const p = PRIORITY_META[item.priority];

  return (
    <li className="flex items-center gap-3 px-5 py-2.5 hover:bg-subtle transition-colors duration-150">
      <span className={`w-7 h-7 shrink-0 rounded-md grid place-items-center ${meta.tone}`}>
        <Icon size={13} />
      </span>

      <div className="min-w-0 flex-1">
        <p className="text-[12.5px] font-medium text-ink truncate">{item.title}</p>
        <p className="text-[10.5px] text-faint truncate">{item.reason}</p>
      </div>

      <span className={`hidden sm:inline-flex shrink-0 px-1.5 py-0.5 rounded border text-[10px] font-semibold ${meta.tone} border-current/20`}>
        {meta.label}
      </span>

      <span className={`shrink-0 inline-flex items-center gap-1 px-2 py-0.5 rounded-full border text-[10px] font-semibold ${p.chip}`}>
        <span className={`w-1.5 h-1.5 rounded-full ${p.dot}`} />
        {p.label}
      </span>

      <ArrowLeft size={12} className="shrink-0 text-muted" />
    </li>
  );
};

export default SmartQueue;