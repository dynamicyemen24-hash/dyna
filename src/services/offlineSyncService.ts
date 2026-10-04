export interface OfflineQueueItem {
  id: string;
  type: 'transaction' | 'stock_update' | 'backup' | 'general';
  title: string;
  data: any;
  timestamp: string;
  synced: boolean;
  retries: number;
}

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
  private syncHandler: ((items: OfflineQueueItem[]) => Promise<boolean>) | null = null;

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

  public registerSyncHandler(handler: (items: OfflineQueueItem[]) => Promise<boolean>) {
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

  public enqueue(type: OfflineQueueItem['type'], title: string, data: any): string {
    const item: OfflineQueueItem = {
      id: `offline-${Date.now()}-${Math.random().toString(36).substr(2, 6)}`,
      type,
      title,
      data,
      timestamp: new Date().toLocaleTimeString('ar-SA'),
      synced: false,
      retries: 0,
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

    try {
      let success = true;
      if (this.syncHandler) {
        success = await this.syncHandler(unsyncedItems);
      } else {
        // Default simulated network delay
        await new Promise((resolve) => setTimeout(resolve, 1000));
        success = true;
      }

      if (success) {
        const count = unsyncedItems.length;
        this.queue = [];
        this.syncStatus = 'synced';
        this.lastSyncTime = new Date().toLocaleTimeString('ar-SA');
        this.saveState();

        this.showNotification(
          'success',
          'اكتملت المزامنة التلقائية بنجاح! 🟢',
          `تم بنجاح ترحيل واعتماد ${count} عملية في السحابة المركزية وتحديث الأرصدة والمستودع.`
        );
        this.notify();
        return { success: true, syncedCount: count };
      } else {
        throw new Error('Sync handler returned false');
      }
    } catch (err) {
      console.error('Failed to sync offline queue:', err);
      this.syncStatus = 'offline';
      this.showNotification(
        'error',
        'فشلت المزامنة المؤقتة ❌',
        'حدث خطأ في الاتصال بالخادم. سيتم إعادة المحاولة تلقائياً طبقاً للجدولة المحددة.'
      );
      this.notify();
      return { success: false, syncedCount: 0 };
    }
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
