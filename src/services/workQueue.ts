export interface WorkItem {
  id: string;
  kind: 'appointment' | 'production' | 'batch' | 'delivery' | 'purchase' | 'service';
  title: string;
  reference: string;
  /** ISO timestamp used for the urgency calculation. */
  dueAt: string | null;
  amount: number;
  status: string;
  /** Optional blocking dependency — a delivery waits for its order. */
  blockedBy?: string | null;
}

export type Priority = 'critical' | 'high' | 'normal' | 'low';

export interface ScoredWork extends WorkItem {
  score: number;
  priority: Priority;
  reason: string;
}

/**
 * Sequencing rules, applied in order of authority:
 *  1. Blocking dependency — nothing else matters until the blocker clears.
 *  2. SLA breach — the promise to the customer is already missed.
 *  3. Imminent due time — within the lead time the sector normally needs.
 *  4. Commercial weight — larger value gets attention when nothing is late.
 *
 * The result is a stable, explainable order rather than a raw date sort, so
 * two operators looking at the same queue always agree on what is next.
 */
export function scoreWorkItem(item: WorkItem, now: number = Date.now()): number {
  let score = 0;

  if (item.blockedBy) score += 1000;                       // Rule 1
  if (item.status === 'blocked' || item.status === 'overdue') score += 400;

  if (item.dueAt) {
    const hoursLeft = (new Date(item.dueAt).getTime() - now) / 3_600_000;

    if (hoursLeft < 0) {
      score += 300 + Math.min(200, -hoursLeft * 10);        // Rule 2 — SLA breached
    } else if (hoursLeft < 2) {
      score += 220;                                          // Rule 3 — under 2h
    } else if (hoursLeft < 8) {
      score += 160;
    } else if (hoursLeft < 24) {
      score += 90;
    } else {
      score += 30;
    }
  }

  score += Math.min(120, Math.log10(Math.max(1, item.amount)) * 40); // Rule 4

  return Math.round(score);
}

export function priorityOf(score: number): Priority {
  if (score >= 900) return 'critical';
  if (score >= 400) return 'high';
  if (score >= 200) return 'normal';
  return 'low';
}

export const PRIORITY_META: Record<Priority, { label: string; dot: string; chip: string }> = {
  critical: { label: 'حرج', dot: 'bg-rose-500', chip: 'bg-err-soft text-err-strong border-err/30' },
  high: { label: 'عالٍ', dot: 'bg-amber-500', chip: 'bg-warn-soft text-warn-strong border-warn/30' },
  normal: { label: 'عادي', dot: 'bg-sky-500', chip: 'bg-info-soft text-info-strong border-sky-200' },
  low: { label: 'منخفض', dot: 'bg-slate-300', chip: 'bg-subtle text-muted border-hairline' },
};

/**
 * Human-readable reason so the operator knows *why* an item is where it is.
 */
export function explainPriority(item: WorkItem, score: number): string {
  const reasons: string[] = [];
  if (item.blockedBy) reasons.push(`معطّل بسبب ${item.blockedBy}`);
  if (item.dueAt) {
    const hoursLeft = (new Date(item.dueAt).getTime() - Date.now()) / 3_600_000;
    if (hoursLeft < 0) reasons.push(`متأخر ${Math.round(-hoursLeft)} ساعة`);
    else if (hoursLeft < 2) reasons.push(`يستحق خلال ${Math.max(1, Math.round(hoursLeft * 60))} دقيقة`);
    else if (hoursLeft < 8) reasons.push(`يستحق خلال ${Math.round(hoursLeft)} ساعة`);
    else if (hoursLeft < 24) reasons.push('يستحق خلال يوم');
  }
  if (reasons.length === 0) reasons.push('ضمن المهلة — مرتّب حسب القيمة');
  return reasons.join(' · ');
}

/** Full pipeline: score, label, explain, then sort. */
export function buildWorkQueue(items: WorkItem[], now: number = Date.now()): ScoredWork[] {
  return items
    .map((item) => {
      const score = scoreWorkItem(item, now);
      return { ...item, score, priority: priorityOf(score), reason: explainPriority(item, score) };
    })
    .sort((a, b) => {
      if (b.score !== a.score) return b.score - a.score;
      // Stable tie-break so equal scores keep a deterministic order.
      return new Date(a.dueAt ?? '2999-01-01').getTime() - new Date(b.dueAt ?? '2999-01-01').getTime();
    });
}

/** Maps a sector to the order in which its modules should be worked. */
export const SECTOR_SEQUENCE: Record<string, string[]> = {
  tailoring: ['appointment', 'measurement', 'service', 'production', 'batch', 'delivery'],
  workshop: ['service', 'production', 'serial_imei', 'purchase', 'delivery'],
  salon: ['appointment', 'service', 'commission', 'delivery'],
  laundry: ['service', 'production', 'delivery'],
  restaurant: ['production', 'delivery', 'purchase'],
  retail: ['purchase', 'batch', 'delivery'],
  pharmacy: ['purchase', 'batch', 'delivery'],
  electronics: ['purchase', 'serial_imei', 'delivery'],
};

/** Splits a mixed queue into sector-correct phases. */
export function groupBySectorPhase(items: ScoredWork[], sector: string): ScoredWork[][] {
  const order = SECTOR_SEQUENCE[sector] ?? [];
  const known = order.filter((k) => items.some((i) => i.kind === k));
  const rest = items.filter((i) => !known.includes(i.kind));
  const phases = known.map((kind) => items.filter((i) => i.kind === kind));
  return rest.length ? [...phases, rest] : phases;
}