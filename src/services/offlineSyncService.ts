export interface OfflineQueueItem {
  id: string;
  type: 'transaction' | 'stock_update' | 'backup' | 'general';
  title: string;
  data: any;
  timestamp: string;
  synced: boolean;
  retries: number;

  /*
   * The key the SERVER assigned at creation time, when there is one.
   *
   * A queued sale needs an identity before the server has seen it. Locally
   * generated ids are not unique across terminals: two tills that lose
   * connectivity at the same moment in the same shop both mint
   * `txn-1712345-abc`, and the flush then commits one and silently drops the
   * other. A per-device monotonic sequence plus the device id makes the pair
   * unique across the estate, which is what lets the server treat a repeat as
   * a replay instead of a second sale.
   */
  clientId?: string;
  clientSeq?: number;
}

/*
 * ══ WHY THE SYNC HANDLER RETURNS A RESULT, NOT A BOOLEAN ═══════════════════
 * The handler used to be `(items) => Promise<boolean>`, so the caller could only
 * answer "did the flush succeed". That collapses three outcomes demanding three
 * completely different actions:
 *
 *   accepted — committed upstream. Drop it from the queue.
 *   conflict — the server holds a newer version of the same record. The queued
 *              work is stale; re-sending it is pointless at best, destructive at
 *              worst.
 *   rejected — the payload will never be accepted (validation, a closed
 *              accounting period, a revoked permission). Retrying forever is the
 *              failure mode this most invites.
 *
 * A `boolean` forces a conflict to be treated as a success, because the
 * alternative is showing the cashier an error — and that silently discards a
 * queued sale. That is the offline failure that loses money: the customer paid,
 * the till queued the invoice, the sync "succeeded", and the sale never reached
 * the ledger. Nothing reports it, because from the queue's point of view the item
 * was removed.
 *
 * So the contract is a discriminated result, and `retry` is separate from
 * `rejected` so a timeout can be retried while a 422 is not.
 */
export type SyncOutcome = 'accepted' | 'conflict' | 'rejected' | 'retry';

export interface SyncResult {
  outcome: SyncOutcome;
  /** The server's own words, surfaced to the operator rather than swallowed. */
  reason?: string;
  /** True when the item was already committed — a replay, not a new write. */
  duplicate?: boolean;
}

export type SyncHandler = (items: OfflineQueueItem[]) => Promise<SyncResult>;

export type NotificationType = 'online' | 'offline' | 'syncing' | 'success' | 'error';

export interface OfflineNotification {
  id: string;
  type: NotificationType;
  title: string;
  message: string;
  timestamp: number;
}

export interface OfflineSyncState {
  isOnline: boolean;
  isSimulatedOffline: boolean;
  syncStatus: 'synced' | 'syncing' | 'offline' | 'scheduled';
  autoSyncOnReconnect: boolean;
  scheduleIntervalMinutes: number; // 0 = Instant upon reconnect, 1 = 1 min, 5 = 5 min
  lastSyncTime: string | null;
  pendingCount: number;
  queue: OfflineQueueItem[];
  notification: OfflineNotification | null;
}

const STORAGE_KEY_QUEUE = 'dypos_offline_sync_queue';
const STORAGE_KEY_CONFIG = 'dypos_offline_sync_config';
const STORAGE_KEY_LAST_SYNC = 'dypos_offline_last_sync';

class OfflineSyncManager {
  private listeners: Set<(state: OfflineSyncState) => void> = new Set();
  private queue: OfflineQueueItem[] = [];
  private isSimulatedOffline: boolean = false;
  private autoSyncOnReconnect: boolean = true;
  private scheduleIntervalMinutes: number = 0; // 0 means instant upon reconnect
  private syncStatus: 'synced' | 'syncing' | 'offline' | 'scheduled' = 'synced';
  private lastSyncTime: string | null = null;
  private notification: OfflineSyncState['notification'] = null;
  private scheduledTimer: ReturnType<typeof setTimeout> | null = null;
  private syncHandler: SyncHandler | null = null;

  /** Per-device sequence, persisted so it stays monotonic across reloads. */
  private clientSeq = 0;

  /**
   * Stable id for THIS terminal, used to scope `clientSeq`.
   *
   * It is not a security credential — the session token is — it is a collision
   * namespace. A stable random value in localStorage serves that, and generating
   * a new one per reload would defeat it.
   */
  private deviceId(): string {
    const KEY = 'dypos_offline_device_id';
    try {
      const existing = localStorage.getItem(KEY);
      if (existing) return existing;
      const minted = `d${Math.random().toString(36).slice(2, 10)}`;
      localStorage.setItem(KEY, minted);
      return minted;
    } catch {
      // Storage disabled: fall back to a per-session value. Two such terminals
      // could in principle collide, which is exactly why the counter is the
      // primary guarantee and this is the fallback.
      return 'ephemeral';
    }
  }

  constructor() {
    this.loadState();
    this.setupNetworkListeners();
  }

  private loadState() {
    try {
      const savedQueue = localStorage.getItem(STORAGE_KEY_QUEUE);
      if (savedQueue) {
        this.queue = JSON.parse(savedQueue);
      }

      /*
       * Resume the sequence ABOVE every id already in the queue.
       *
       * Without this the counter restarts at 0 on each reload, so the first sale
       * after a refresh is minted as `offline-<device>-1` — an id the queue may
       * already contain. The server would then see a repeat and treat a genuine
       * new sale as a replay of an old one, which silently drops it. Taking the
       * maximum of what is queued makes the sequence monotonic for the lifetime
       * of the stored queue, not merely of the page.
       */
      this.clientSeq = this.queue.reduce(
        (max, item) => (typeof item.clientSeq === 'number' && item.clientSeq > max ? item.clientSeq : max),
        0,
      );

      const savedConfig = localStorage.getItem(STORAGE_KEY_CONFIG);
      if (savedConfig) {
        const parsed = JSON.parse(savedConfig);
        this.autoSyncOnReconnect = parsed.autoSyncOnReconnect ?? true;
        this.scheduleIntervalMinutes = parsed.scheduleIntervalMinutes ?? 0;
        this.isSimulatedOffline = parsed.isSimulatedOffline ?? false;
      }

      this.lastSyncTime = localStorage.getItem(STORAGE_KEY_LAST_SYNC) || new Date().toLocaleTimeString('ar-SA');
      this.syncStatus = this.getEffectiveOnline() ? (this.queue.length > 0 ? 'scheduled' : 'synced') : 'offline';
    } catch (e) {
      console.error('Error loading offline sync state:', e);
    }
  }

  private saveState() {
    try {
      localStorage.setItem(STORAGE_KEY_QUEUE, JSON.stringify(this.queue));
      localStorage.setItem(
        STORAGE_KEY_CONFIG,
        JSON.stringify({
          autoSyncOnReconnect: this.autoSyncOnReconnect,
          scheduleIntervalMinutes: this.scheduleIntervalMinutes,
          isSimulatedOffline: this.isSimulatedOffline,
        })
      );
      if (this.lastSyncTime) {
        localStorage.setItem(STORAGE_KEY_LAST_SYNC, this.lastSyncTime);
      }
    } catch (e) {
      console.error('Error saving offline sync state:', e);
    }
  }

  private setupNetworkListeners() {
    if (typeof window === 'undefined') return;

    window.addEventListener('online', () => {
      this.handleNetworkChange(true);
    });

    window.addEventListener('offline', () => {
      this.handleNetworkChange(false);
    });
  }

  private handleNetworkChange(isSystemOnline: boolean) {
    if (this.isSimulatedOffline) return;

    if (isSystemOnline) {
      this.showNotification(
        'online',
        'تم استعادة الاتصال بالشبكة 🌐',
        this.autoSyncOnReconnect && this.queue.length > 0
          ? `عادت إشارة الإنترنت. جاري جدولة مزامنة ${this.queue.length} عملية مخزنة محلياً...`
          : 'المنظومة متصلة بالإنترنت وجاهزة للربط اللحظي مع السحابة.'
      );

      if (this.autoSyncOnReconnect && this.queue.length > 0) {
        if (this.scheduleIntervalMinutes > 0) {
          this.scheduleDelayedSync(this.scheduleIntervalMinutes * 60 * 1000);
        } else {
          // Instant sync
          setTimeout(() => {
            this.syncNow();
          }, 800);
        }
      } else {
        this.syncStatus = this.queue.length > 0 ? 'scheduled' : 'synced';
        this.notify();
      }
    } else {
      this.syncStatus = 'offline';
      this.showNotification(
        'offline',
        'تم تفعيل وضع عدم الاتصال (Offline Mode) 📡',
        'انقطع الاتصال بالإنترنت. تستمر نقاط البيع بالعمل بكامل الصلاحيات، وسيتم حفظ العمليات محلياً ومزامنتها تلقائياً فور عودة الاتصال.'
      );
      this.notify();
    }
  }

  /*
   * Registers how queued work is flushed.
   *
   * The handler now returns a `SyncResult` rather than a `boolean`, so a
   * conflict is distinguishable from a rejection and from a transient failure.
   * See `SyncOutcome` for why collapsing them loses sales silently.
   */
  public registerSyncHandler(handler: SyncHandler) {
    this.syncHandler = handler;
  }

  public getEffectiveOnline(): boolean {
    if (typeof navigator === 'undefined') return true;
    return navigator.onLine && !this.isSimulatedOffline;
  }

  public getState(): OfflineSyncState {
    const isOnline = this.getEffectiveOnline();
    return {
      isOnline,
      isSimulatedOffline: this.isSimulatedOffline,
      syncStatus: this.syncStatus,
      autoSyncOnReconnect: this.autoSyncOnReconnect,
      scheduleIntervalMinutes: this.scheduleIntervalMinutes,
      lastSyncTime: this.lastSyncTime,
      pendingCount: this.queue.filter((q) => !q.synced).length,
      queue: [...this.queue],
      notification: this.notification,
    };
  }

  public subscribe(listener: (state: OfflineSyncState) => void): () => void {
    this.listeners.add(listener);
    listener(this.getState());
    return () => {
      this.listeners.delete(listener);
    };
  }

  private notify() {
    const state = this.getState();
    this.listeners.forEach((listener) => {
      try {
        listener(state);
      } catch (err) {
        console.error('OfflineSyncManager listener error:', err);
      }
    });
  }

  public showNotification(
    type: NotificationType,
    title: string,
    message: string
  ) {
    this.notification = {
      id: `notif-${Date.now()}-${Math.random().toString(36).substr(2, 4)}`,
      type,
      title,
      message,
      timestamp: Date.now(),
    };
    this.notify();
  }

  public dismissNotification() {
    this.notification = null;
    this.notify();
  }

  /*
   * Enqueues work for later flush.
   *
   * ══ WHY THE IDENTITY IS DEVICE-SCOPED AND MONOTONIC ══════════════════════
   * The id was `offline-${Date.now()}-${Math.random()…}`. Two tills in the same
   * shop that lose connectivity within the same millisecond can mint the same
   * value, and the loser is then either rejected as a duplicate primary key or —
   * worse — silently overwritten. Either way a paid sale disappears.
   *
   * `clientSeq` is a per-device counter persisted alongside the queue and
   * advanced across reloads, so it stays monotonic for the life of the till
   * rather than resetting each session. Combined with `clientId`, the pair is
   * unique across the estate, which is what lets the SERVER treat a repeat as a
   * replay of the same sale instead of a second sale.
   *
   * `Math.random` is not the problem on its own; using it as the only source of
   * identity is. The counter is what makes the guarantee, and the random suffix
   * stays only as a belt-and-braces guard against two tabs of the same browser.
   */
  public enqueue(type: OfflineQueueItem['type'], title: string, data: any): string {
    this.clientSeq += 1;

    const item: OfflineQueueItem = {
      id: `offline-${this.deviceId()}-${this.clientSeq}`,
      type,
      title,
      data,
      timestamp: new Date().toLocaleTimeString('ar-SA'),
      synced: false,
      retries: 0,
      clientId: this.deviceId(),
      clientSeq: this.clientSeq,
    };

    this.queue.unshift(item);
    this.saveState();

    if (!this.getEffectiveOnline()) {
      this.syncStatus = 'offline';
      this.showNotification(
        'offline',
        'تم حفظ العملية محلياً (Offline)',
        `تم تسجيل "${title}" في قائمة الانتظار المحلية بأمان. إجمالي العمليات المجدولة: ${this.queue.length}`
      );
    } else {
      if (this.autoSyncOnReconnect) {
        this.scheduleDelayedSync(500); // quick flush
      } else {
        this.syncStatus = 'scheduled';
      }
    }

    this.notify();
    return item.id;
  }

  public scheduleDelayedSync(delayMs: number) {
    if (this.scheduledTimer) {
      clearTimeout(this.scheduledTimer);
    }

    this.syncStatus = 'scheduled';
    this.notify();

    this.scheduledTimer = setTimeout(() => {
      this.syncNow();
    }, delayMs);
  }

  public async syncNow(): Promise<{ success: boolean; syncedCount: number }> {
    if (!this.getEffectiveOnline()) {
      this.showNotification(
        'error',
        'تعذر المزامنة الحالية ⚠️',
        'الجهاز غير متصل بالإنترنت حالياً. تم الإبقاء على العمليات في الذاكرة المحلية حتى عودة الشبكة.'
      );
      this.syncStatus = 'offline';
      this.notify();
      return { success: false, syncedCount: 0 };
    }

    const unsyncedItems = this.queue.filter((q) => !q.synced);
    if (unsyncedItems.length === 0) {
      this.syncStatus = 'synced';
      this.lastSyncTime = new Date().toLocaleTimeString('ar-SA');
      this.saveState();
      this.showNotification(
        'success',
        'قائمة الانتظار محدثة بالكامل 🟢',
        'جميع البيانات والحركات متزامنة لحظياً مع خوادم السحابة وقاعدة البيانات.'
      );
      this.notify();
      return { success: true, syncedCount: 0 };
    }

    this.syncStatus = 'syncing';
    this.showNotification(
      'syncing',
      'جاري مزامنة البيانات مع السحابة... ⏳',
      `يتم الآن ترحيل ${unsyncedItems.length} عملية مخزنة محلياً إلى قاعدة البيانات المركزية.`
    );
    this.notify();

    /*
     * ══ WHY EACH ITEM IS SETTLED INDIVIDUALLY ══════════════════════════════
     * This used to be:
     *
     *   const success = await this.syncHandler(unsyncedItems);
     *   if (success) { this.queue = []; }
     *
     * One boolean for the whole batch, and then `queue = []` — which discards
     * EVERY item, including any the server never accepted, and including any the
     * handler never actually saw.
     *
     * A till queues work continuously: a customer pays while the link is down,
     * then the connection returns and a flush sends four invoices. If the server
     * commits two and refuses one because its accounting period closed, this
     * code marks all four synced and empties the queue. The two accepted are
     * correct. The refused sale is gone — not deferred, not flagged, gone — and
     * the ledger under-reports by exactly one sale with nothing tracing it.
     *
     * So each item gets its own verdict and the queue is REBUILT from those
     * verdicts rather than cleared:
     *
     *   accepted / duplicate → removed; the server holds it
     *   conflict   → kept and REPORTED. It is a stale write, so re-sending it
     *                 blindly would overwrite someone else's change; it needs a
     *                 human, which means it must be visible.
     *   rejected   → kept with the server's reason. Retrying cannot help.
     *   retry      → kept, attempt counted. A transport failure is not a verdict
     *                 on the data.
     */
    const results = new Map<string, SyncResult>();

    for (const item of unsyncedItems) {
      try {
        if (this.syncHandler) {
          const result = await this.syncHandler([item]);
          results.set(item.id, result ?? { outcome: 'retry' });
        } else {
          // No handler registered. Reporting success and clearing the queue
          // would discard sales with no error anywhere, so the item stays.
          results.set(item.id, {
            outcome: 'retry',
            reason: 'لم يُسجَّل معالِج مزامنة، فلا يمكن إرسال الطابور.',
          });
        }
      } catch (err) {
        // A thrown error is a transport failure, not a rejection: the request
        // may never have arrived, and the payload may be perfectly valid.
        console.error(`Sync failed for ${item.id}:`, err);
        results.set(item.id, { outcome: 'retry', reason: String(err) });
      }
    }

    let syncedCount = 0;
    this.queue = this.queue.filter((item) => {
      const verdict = results.get(item.id);
      // No verdict at all → leave it alone. Dropping an un-sent item is the
      // exact failure this block exists to prevent.
      if (!verdict) return true;
      if (verdict.outcome === 'accepted' || verdict.duplicate) {
        syncedCount += 1;
        return false;
      }
      item.retries += 1;
      return true;
    });

    const conflicted = [...results.values()].filter((r) => r.outcome === 'conflict');
    const rejected = [...results.values()].filter((r) => r.outcome === 'rejected');

    this.syncStatus = this.queue.length === 0 ? 'synced' : 'scheduled';
    this.lastSyncTime = new Date().toLocaleTimeString('ar-SA');
    this.saveState();

    if (syncedCount > 0 && conflicted.length === 0 && rejected.length === 0) {
      this.showNotification(
        'success',
        'اكتملت المزامنة بنجاح ✅',
        `تم ترحيل واعتماد ${syncedCount} عملية في السحابة وتحديث الأرصدة والمستودع.`,
      );
    } else {
      /*
       * A partial sync is reported as PARTIAL, with the reasons. Reporting plain
       * success here is what let a refused sale vanish: the operator saw a green
       * toast, closed the till, and the shortfall surfaced days later at
       * reconciliation with nothing to trace it back to.
       */
      const parts: string[] = [];
      if (conflicted.length) {
        parts.push(`${conflicted.length} عملية تتعارض مع نسخة أحدث على الخادم وتحتاج مراجعة يدوية`);
      }
      if (rejected.length) {
        const why = rejected.map((r) => r.reason).filter(Boolean)[0];
        parts.push(`${rejected.length} عملية رفضها الخادم${why ? `: ${why}` : ''}`);
      }
      const stillQueued = this.queue.length;
      if (stillQueued) parts.push(`${stillQueued} عملية لم تُحسم وستُعاد المحاولة`);

      this.showNotification(
        rejected.length || conflicted.length ? 'error' : 'syncing',
        `اكتملت المزامنة جزئياً — ${syncedCount} من ${unsyncedItems.length}`,
        `${parts.join(' · ')}. العمليات غير المحسومة محفوظة في الطابور ولم تُفقد.`,
      );
    }

    this.notify();
    return { success: syncedCount > 0, syncedCount };
  }

  public setAutoSyncOnReconnect(enabled: boolean) {
    this.autoSyncOnReconnect = enabled;
    this.saveState();
    this.notify();
  }

  public setScheduleIntervalMinutes(mins: number) {
    this.scheduleIntervalMinutes = mins;
    this.saveState();
    this.notify();
  }

  public toggleSimulatedOffline(): boolean {
    this.isSimulatedOffline = !this.isSimulatedOffline;
    this.saveState();

    if (this.isSimulatedOffline) {
      this.syncStatus = 'offline';
      this.showNotification(
        'offline',
        'تم تشغيل محاكاة وضع عدم الاتصال (Offline Simulation)',
        'تم تفعيل وضع Offline يدوياً للاختبار وفحص استجابة النظام عند انقطاع الإنترنت.'
      );
    } else {
      this.handleNetworkChange(navigator.onLine);
    }

    this.notify();
    return this.isSimulatedOffline;
  }

  public clearQueue() {
    this.queue = [];
    this.syncStatus = this.getEffectiveOnline() ? 'synced' : 'offline';
    this.saveState();
    this.notify();
  }
}

export const offlineSyncService = new OfflineSyncManager();
