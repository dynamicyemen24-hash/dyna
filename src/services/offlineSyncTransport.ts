/**
 * ══ THE DEFECT THIS REPLACES ════════════════════════════════════════════════
 * `registerSyncHandler` existed on the manager and was **called from nowhere**.
 *
 * `syncNow()` therefore took this branch on every single attempt:
 *
 *     if (this.syncHandler) { … } else {
 *       results.set(item.id, { outcome: 'retry', reason: 'لم يُسجَّل معالِج مزامنة' });
 *     }
 *
 * so every queued sale stayed queued forever, retrying with the same reason,
 * while the status bar alternated between "scheduled" and "offline" and the
 * operator was told their sales were safe. They were not on the server. The
 * offline queue was, in practice, a write-only log: the till believed it had a
 * durable record of a sale that existed only in one browser's localStorage, and
 * would lose every one of them to a cleared cache, a replaced disk, or a till
 * sold second-hand.
 *
 * `/api/db/sync-batch` existed, was authenticated, derived the tenant from the
 * token, and recomputed the totals server-side. Nothing called it.
 *
 * This module is that missing link: the one place that turns a queued item into
 * an authenticated request, and turns the server's answer into a verdict the
 * queue can act on.
 */
import { offlineSyncService, type OfflineQueueItem, type SyncResult } from './offlineSyncService';

/**
 * How an HTTP status becomes a verdict.
 *
 * The distinction that matters is between "the server considered this and said
 * no" (`rejected` — retrying cannot help) and "the server never considered it"
 * (`retry` — a transport fault). Collapsing them into one boolean is how a
 * queue either loses a sale or retries a doomed payload forever.
 *
 *   200 → accepted   the row is committed
 *   401/403 → rejected  a credential the offline till cannot fix by retrying
 *   409 → conflict   the server holds a newer version; a human must decide
 *   4xx (other) → rejected  the payload will never be accepted as it stands
 *   5xx / network → retry  the request may never have arrived
 */
function verdictFor(status: number, body: unknown): SyncResult {
  if (status === 401 || status === 403) {
    return {
      outcome: 'rejected',
      reason: 'الجلسة منتهية أو الصلاحية غير كافية — أعد تسجيل الدخول ثم أعد المزامنة.',
    };
  }
  if (status === 409) {
    return {
      outcome: 'conflict',
      reason: 'السجل موجود في الخادم نسخة أحدث — يلزم مراجعة يدوية.',
    };
  }
  if (status >= 400 && status < 500) {
    const message = (body as { message?: string; error?: string } | null);
    return {
      outcome: 'rejected',
      reason: message?.message ?? message?.error ?? `رفض الخادم العملية (${status}).`,
    };
  }
  if (status >= 500) {
    return { outcome: 'retry', reason: `خطأ في الخادم (${status}) — ستتم إعادة المحاولة.` };
  }
  return { outcome: 'accepted' };
}

/**
 * The bearer token of the signed-in session, or `null`.
 *
 * The queue sends for itself rather than through `apiGet`/`apiPost` because it
 * must be able to inspect the raw status and body to derive a *verdict* — a
 * helper that throws on 4xx would collapse "rejected" and "retry" into one
 * failure. So the credential is read from exactly one place, the same session
 * record `AuthContext` writes, which is also what `activeTenant()` reads. There
 * is therefore one session on the till, not two.
 */
function sessionToken(): string | null {
  // Canonical first: the live login (`LoginView` via `dyposApi`) persists the
  // signed token under sessionStorage `dypos_token`. The legacy
  // `localStorage dypos_session_v1` record (dead `AuthContext`) is kept ONLY
  // as a fallback so an older tab's queue can still flush after an upgrade.
  try {
    const live = sessionStorage.getItem('dypos_token');
    if (typeof live === 'string' && live.trim()) return live.trim();
  } catch {
    // Storage unavailable — fall through to the legacy record.
  }
  try {
    const raw = localStorage.getItem('dypos_session_v1');
    if (!raw) return null;
    const { token } = JSON.parse(raw) as { token?: string };
    return typeof token === 'string' && token.trim() ? token.trim() : null;
  } catch {
    return null;
  }
}

/**
 * Sends queued items to the server and returns their verdicts.
 *
 * The parameter is an ARRAY because that is the manager's contract, and the
 * caller already sends one item at a time — `syncNow` settles each verdict
 * individually precisely so a partial success cannot be mistaken for a total
 * one. That contract is kept rather than widened: a batch endpoint returning one
 * boolean for four invoices is what forced the caller to treat a partial
 * success as total, which is exactly the sale-loss this queue exists to prevent.
 *
 * The tenant is NOT sent. `/api/db/sync-batch` derives it from the bearer token
 * (`attachPrincipal` → `tenantOf(req)`), so including one would be a claim the
 * client is in no position to make — and a client-supplied tenant is precisely
 * what made this endpoint cross-tenant before it was authenticated.
 */
async function pushItem(items: OfflineQueueItem[]): Promise<SyncResult> {
  const item = items[0];
  if (!item) {
    // Nothing to send. `accepted` is correct here because the queue asked for an
    // empty batch, and leaving a phantom entry behind would retry forever.
    return { outcome: 'accepted' };
  }

  const token = sessionToken();
  if (!token) {
    // No credential is not a payload problem and not a transport fault: the same
    // bytes will be accepted once someone signs in. `retry`, not `rejected`,
    // because nothing about the sale is wrong.
    return {
      outcome: 'retry',
      reason: 'لا توجد جلسة مسجّلة — ستُرسل المبيعات تلقائياً بعد تسجيل الدخول.',
    };
  }

  const payload = (item.data ?? {}) as Record<string, unknown>;
  // The queue id is the idempotent primary key. This provisional number is
  // only for the human-facing document until the server allocates authority.
  const invoiceNumber = String(
    payload.invoiceNumber
      ?? `OFF-${item.clientId ?? 'device'}-${item.clientSeq ?? item.id}`,
  );

  const response = await fetch('/api/db/sync-batch', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` },
    credentials: 'same-origin',
    body: JSON.stringify({
      /*
       * The item's own id is the offline identity, so a retry after a dropped
       * response hits the same primary key and the server's ON CONFLICT clause
       * treats it as the same sale rather than a second one. Without it, a
       * flaky link would duplicate a paid invoice on every attempt.
       */
      invoices: [{
        ...payload,
        id: item.id,
        clientId: item.clientId,
        invoiceNumber,
        timestamp: payload.timestamp ?? new Date().toISOString(),
        status: 'completed',
      }],
      clientId: item.clientId,
      sequenceNo: item.clientSeq,
    }),
  });

  let body: unknown = null;
  try {
    body = await response.json();
  } catch {
    // A body-less response is not a failure of the request itself; the status
    // still decides the verdict.
  }

  const verdict = verdictFor(response.status, body);

  /*
   * `skipped > 0` means the server reached a row it would not accept — the batch
   * reports it rather than swallowing it, which is the only reason an operator
   * ever learns an offline sale did not land. Treating that as `accepted` is
   * what would silently drop a paid invoice.
   */
  if (verdict.outcome === 'accepted') {
    const skipped = (body as { skipped?: number } | null)?.skipped ?? 0;
    if (skipped > 0) {
      return {
        outcome: 'rejected',
        reason: 'الخادم لم يسجّل الفاتورة (بيانات ناقصة) — احفظها وراجعها يدوياً.',
      };
    }
    const synced = (body as { synced?: { transactions?: number } } | null)?.synced;
    if (synced && (synced.transactions ?? 0) === 0) {
      return {
        outcome: 'rejected',
        reason: 'الخادم لم يُدرج أي فاتورة من هذا العنصر.',
      };
    }
  }

  return verdict;
}

/**
 * Wires the offline queue to the authenticated API.
 *
 * Called once, at application start, by `App.tsx`. Until it runs, `syncNow`
 * holds every item with "لم يُسجَّل معالِج مزامنة" — so this registration is the
 * difference between an offline sale that reaches the ledger and one that does
 * not exist.
 *
 * It is exported as a single call rather than a module side effect so the wiring
 * is visible at the call site and can be asserted by a test.
 */
export function attachOfflineSyncTransport(): void {
  offlineSyncService.registerSyncHandler(pushItem);
}
