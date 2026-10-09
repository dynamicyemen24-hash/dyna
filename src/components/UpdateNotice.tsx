/**
 * Announces a newly deployed version and applies it on the operator's terms.
 *
 * ══ WHY THIS IS NOT AUTOMATIC ═════════════════════════════════════════════
 * Reloading on `updatefound` is the common implementation and it is wrong for a
 * till. The event fires whenever a worker finishes installing — which can be
 * while a basket is open, a payment is mid-flight, or an operator is halfway
 * through entering a customer.
 *
 * Reloading there discards the basket and, depending on when, can abandon a
 * submitted sale whose response has not yet returned. The idempotency key added
 * to the sale path means a retry is safe, but losing the basket is still a lost
 * sale at the counter.
 *
 * So the update waits. It is offered, it explains itself, and the operator — or
 * the shell, once the workspace is idle — decides.
 */
import React, { useEffect, useState } from 'react';
import { RefreshCw, X } from 'lucide-react';

export const UpdateNotice: React.FC = () => {
  const [waitingWorker, setWaitingWorker] = useState<ServiceWorker | null>(null);
  const [dismissed, setDismissed] = useState(false);
  const [applying, setApplying] = useState(false);

  useEffect(() => {
    if (typeof navigator === 'undefined' || !('serviceWorker' in navigator)) return;

    // A worker may already be waiting by the time this mounts.
    navigator.serviceWorker.ready.then((reg) => {
      if (reg.waiting && !dismissed) setWaitingWorker(reg.waiting);
    }).catch(() => { /* no worker; nothing to update */ });

    const onReady = () => {
      navigator.serviceWorker.ready.then((reg) => {
        if (reg.waiting) setWaitingWorker(reg.waiting);
      }).catch(() => { /* ignore */ });
    };
    window.addEventListener('dypos:update-ready', onReady);
    // Escape dismisses the offer without applying — the till is never forced.
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') setDismissed(true);
    };
    window.addEventListener('keydown', onKey);
    return () => {
      window.removeEventListener('dypos:update-ready', onReady);
      window.removeEventListener('keydown', onKey);
    };
  }, [dismissed]);

  const applyUpdate = () => {
    if (!waitingWorker) return;
    setApplying(true);
    /*
     * `skipWaiting` promotes the new worker and `controllerchange` fires once it
     * has taken over. The reload is chained to THAT event rather than issued
     * immediately, because reloading before the new worker is in control would
     * serve the page from the OLD cache — the one case where the operator gets
     * the stale build they were trying to leave.
     */
    let reloaded = false;
    navigator.serviceWorker.addEventListener('controllerchange', () => {
      if (reloaded) return;
      reloaded = true;
      window.location.reload();
    });
    waitingWorker.postMessage({ type: 'SKIP_WAITING' });
  };

  if (!waitingWorker || dismissed) return null;

  return (
    <div
      role="status"
      aria-live="polite"
      className="fixed bottom-4 left-1/2 z-50 -translate-x-1/2 rounded-2xl border border-[var(--t-hairline)] bg-[var(--t-surface)] px-4 py-3 shadow-2xl"
    >
      <div className="flex items-center gap-3">
        <RefreshCw size={18} className="shrink-0 text-[var(--t-brand)]" aria-hidden="true" />
        <div className="min-w-0">
          <p className="text-sm font-bold text-[var(--t-ink)]">يتوفّر تحديث جديد</p>
          <p className="text-xs text-[var(--t-muted)]">
            لن يُطبَّق تلقائياً حتى تنتهي من العملية الحالية.
          </p>
        </div>

        <button
          type="button"
          onClick={applyUpdate}
          disabled={applying}
          className="rounded-xl bg-[var(--t-brand)] px-3 py-1.5 text-xs font-bold text-ink disabled:opacity-60 focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-[var(--t-brand)]"
        >
          {applying ? 'جارٍ التحديث…' : 'تطبيق الآن'}
        </button>

        <button
          type="button"
          onClick={() => setDismissed(true)}
          aria-label="لاحقاً"
          className="rounded-lg p-1 text-[var(--t-muted)] hover:text-[var(--t-ink)] focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-[var(--t-brand)]"
        >
          <X size={16} />
        </button>
      </div>
    </div>
  );
};

export default UpdateNotice;