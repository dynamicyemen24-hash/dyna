import React, { useState, useEffect } from 'react';
import {
  Wifi,
  WifiOff,
  RefreshCw,
  CheckCircle2,
  AlertTriangle,
  Clock,
  Database,
  ChevronUp,
  ChevronDown,
  X,
  Settings2,
  HardDriveUpload,
  Layers,
  Sparkles,
  Play,
  Pause,
  Sliders,
  SendHorizontal
} from 'lucide-react';
import { offlineSyncService, OfflineSyncState } from '../services/offlineSyncService';
import NotificationBar from './NotificationBar';

interface OfflineSyncToastProps {
  onForceSync?: () => Promise<boolean>;
}

/**
 * OfflineSyncToast — now built on top of the reusable NotificationBar component.
 * Provides the same offline sync status UX but using the expert-designed
 * NotificationBar system for consistency across the entire system.
 */
export const OfflineSyncToast: React.FC<OfflineSyncToastProps> = ({ onForceSync }) => {
  const [state, setState] = useState<OfflineSyncState>(offlineSyncService.getState());
  const [isExpanded, setIsExpanded] = useState(false);
  const [isSyncingLocal, setIsSyncingLocal] = useState(false);
  const pillRef = React.useRef<HTMLButtonElement>(null);

  useEffect(() => {
    const unsub = offlineSyncService.subscribe((newState) => {
      setState(newState);
    });
    return () => unsub();
  }, []);

  useEffect(() => {
    if (!isExpanded) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') {
        e.stopPropagation();
        setIsExpanded(false);
        pillRef.current?.focus();
      }
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [isExpanded]);

  const closeCard = () => {
    setIsExpanded(false);
    pillRef.current?.focus();
  };

  // Auto-dismiss success notifications after 5 seconds
  useEffect(() => {
    if (state.notification && state.notification.type === 'success') {
      const timer = setTimeout(() => {
        offlineSyncService.dismissNotification();
      }, 5000);
      return () => clearTimeout(timer);
    }
  }, [state.notification]);

  const handleManualSync = async () => {
    setIsSyncingLocal(true);
    try {
      if (onForceSync) {
        await onForceSync();
      }
      await offlineSyncService.syncNow();
    } finally {
      setIsSyncingLocal(false);
    }
  };

  const isBusy = isSyncingLocal || state.syncStatus === 'syncing';

  // Map internal notification types to NotificationBar variants
  const variantMap: Record<string, 'success' | 'error' | 'warning' | 'info'> = {
    offline: 'error',
    online: 'success',
    syncing: 'warning',
    success: 'success',
    error: 'error',
  };

  const variant = (state.notification && variantMap[state.notification.type]) || 'info';

  // Build title and message from notification
  const notificationTitle = state.notification?.title || 'تنبيه النظام';
  const notificationMessage = state.notification
    ? `${state.notification.message} ${state.pendingCount > 0 ? `· ${state.pendingCount} عملية مجدولة` : ''}`
    : 'لا توجد تنبيهات';

  return (
    <div
      dir="rtl"
      className="fixed bottom-10 left-4 z-50 font-['Cairo',sans-serif] flex flex-col items-start gap-2 max-w-sm sm:max-w-md select-none transition-all duration-300 pointer-events-auto"
    >
      {/* 1. Instant Notification using NotificationBar */}
      {state.notification && (
        <NotificationBar
          key={state.notification.id || 'sync-notif-' + Date.now()}
          title={notificationTitle}
          message={notificationMessage}
          variant={variant}
          persistent={state.notification.type === 'error'}
          timeout={state.notification.type === 'success' ? 5000 : undefined}
          onDismiss={() => offlineSyncService.dismissNotification()}
          onAction={() => {
            if (state.notification?.type === 'success' && state.pendingCount > 0) {
              setIsExpanded(true);
            }
          }}
        />
      )}

      {/* 2. Expanded Detail Card / Schedule Settings Modal */}
      {isExpanded && (
        <div
          role="dialog"
          aria-label="إدارة المزامنة اللحظية والوضع غير المتصل"
          className="w-full bg-surface border border-hairline rounded-3xl p-4 shadow-2xl backdrop-blur-2xl text-ink animate-in zoom-in-95 duration-200"
        >
          <div className="flex items-center justify-between pb-3 border-b border-hairline">
            <div className="flex items-center gap-2">
              <div className="w-7 h-7 rounded-xl bg-gradient-to-br from-brand-600 via-teal-600 to-cyan-600 flex items-center justify-center text-white">
                <Database className="w-3.5 h-3.5" />
              </div>
              <div>
                <h3 className="text-xs font-black">إدارة المزامنة اللحظية والوضع غير المتصل</h3>
                <p className="text-[10px] text-faint font-mono">Smart Ports Software · Neon PostgreSQL (dyposdb)</p>
              </div>
            </div>
            <button
              type="button"
              onClick={closeCard}
              aria-label="إغلاق بطاقة المزامنة"
              className="p-1.5 rounded-lg text-muted hover:text-ink hover:bg-subtle transition cursor-pointer focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-brand"
            >
              <X className="w-4 h-4" />
            </button>
          </div>

          {/* Real-time Status Card */}
          <div className="grid grid-cols-3 gap-1.5 my-3 font-mono text-xs">
            <div className="bg-subtle p-2 rounded-xl border border-hairline">
              <div className="flex items-center justify-between mb-1">
                <span className="text-[9px] text-muted font-sans">الإنترنت</span>
                {state.isOnline ? (
                  <Wifi className="w-3 h-3 text-brand-600 dark:text-brand-400" />
                ) : (
                  <WifiOff className="w-3 h-3 text-rose-600 dark:text-rose-400" />
                )}
              </div>
              <span
                className={`font-bold text-[10px] ${
                  state.isOnline ? 'text-brand-600 dark:text-brand-400' : 'text-rose-600 dark:text-rose-400'
                }`}
              >
                {state.isOnline ? 'متصل 🟢' : 'Offline 🔴'}
              </span>
            </div>

            <div className="bg-subtle p-2 rounded-xl border border-hairline">
              <div className="flex items-center justify-between mb-1">
                <span className="text-[9px] text-muted font-sans">Neon DB</span>
                <Database className="w-3 h-3 text-cyan-700 dark:text-cyan-300" />
              </div>
              <span className="font-bold text-[10px] text-cyan-700 dark:text-cyan-300">
                {state.isOnline ? 'Live 🟢' : 'Cached 💾'}
              </span>
            </div>

            <div className="bg-subtle p-2 rounded-xl border border-hairline">
              <div className="flex items-center justify-between mb-1">
                <span className="text-[9px] text-muted font-sans">المجدولة</span>
                <Layers className="w-3 h-3 text-amber-600 dark:text-amber-400" />
              </div>
              <span className="font-bold text-[10px] text-amber-700 dark:text-amber-300">
                {state.pendingCount} حركة
              </span>
            </div>
          </div>

          {/* Automatic Sync on Reconnection Scheduler Options */}
          <div className="bg-subtle rounded-2xl p-3 border border-hairline mb-3 space-y-2.5">
            <div className="flex items-center justify-between">
              <div>
                <label className="text-xs font-bold text-ink block">
                  جدولة المزامنة التلقائية عند عودة الاتصال
                </label>
                <p className="text-[10px] text-muted">
                  مزامنة كافة الفواتير والعمليات المحفوظة فورياً بمجرد توفر الإنترنت
                </p>
              </div>
              <button
                type="button"
                onClick={() =>
                  offlineSyncService.setAutoSyncOnReconnect(!state.autoSyncOnReconnect)
                }
                aria-pressed={state.autoSyncOnReconnect}
                aria-label="جدولة المزامنة التلقائية عند عودة الاتصال"
                className={`w-11 h-6 rounded-full transition-colors relative cursor-pointer focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-brand ${
                  state.autoSyncOnReconnect ? 'bg-brand-600' : 'bg-hairline'
                }`}
              >
                <span
                  className={`w-4 h-4 bg-white rounded-full absolute top-1 transition-transform ${
                    state.autoSyncOnReconnect ? 'right-1' : 'right-6'
                  }`}
                />
              </button>
            </div>

            {state.autoSyncOnReconnect && (
              <div className="pt-2 border-t border-hairline flex items-center justify-between text-xs">
                <span className="text-muted text-[11px] flex items-center gap-1.5">
                  <Clock className="w-3.5 h-3.5 text-amber-600 dark:text-amber-400" /> توقيت الترحيل التلقائي:
                </span>
                <select
                  value={state.scheduleIntervalMinutes}
                  onChange={(e) =>
                    offlineSyncService.setScheduleIntervalMinutes(Number(e.target.value))
                  }
                  className="bg-surface border border-hairline rounded-xl px-2.5 py-1 text-xs text-ink font-bold focus:outline-none focus:border-brand cursor-pointer"
                >
                  <option value={0}>فوري عند عودة الاتصال (Zero Delay)</option>
                  <option value={1}>بعد دقيقة واحدة (هدوء الشبكة)</option>
                  <option value={3}>كل 3 دقائق (تجميع الفواتير)</option>
                  <option value={5}>كل 5 دقائق (دفعات مجدولة)</option>
                </select>
              </div>
            )}
          </div>

          {/* Pending Queue List preview if any */}
          {state.queue.length > 0 && (
            <div className="mb-3 max-h-32 overflow-y-auto space-y-1.5 pr-1">
              <div className="text-[10px] font-bold text-muted mb-1 flex items-center justify-between">
                <span>سجل العمليات المجدولة في الذاكرة المحلية:</span>
                <span className="text-faint font-mono">{state.queue.length} عناصر</span>
              </div>
              {state.queue.slice(0, 4).map((item) => (
                <div
                  key={item.id}
                  className="bg-subtle p-2 rounded-xl border border-hairline text-[11px] flex items-center justify-between font-mono"
                >
                  <div className="flex items-center gap-2 truncate">
                    <span className="w-2 h-2 rounded-full bg-amber-500 shrink-0"></span>
                    <span className="text-ink font-sans truncate">{item.title}</span>
                  </div>
                  <span className="text-[10px] text-faint shrink-0 font-mono">
                    {item.timestamp}
                  </span>
                </div>
              ))}
              {state.queue.length > 4 && (
                <p className="text-[10px] text-faint text-center">
                  + {state.queue.length - 4} عمليات أخرى في الانتظار...
                </p>
              )}
            </div>
          )}

          {/* Action buttons */}
          <div className="flex items-center gap-2 pt-2 border-t border-hairline">
            <button
              type="button"
              onClick={handleManualSync}
              disabled={isBusy || !state.isOnline}
              className="flex-1 bg-brand-600 hover:bg-brand-500 text-white py-2 rounded-xl text-xs font-bold transition flex items-center justify-center gap-1.5 cursor-pointer disabled:opacity-40 disabled:cursor-not-allowed shadow-lg shadow-brand-600/20 focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-brand"
            >
              <RefreshCw className={`w-3.5 h-3.5 ${isBusy ? 'animate-spin' : ''}`} />
              <span>{isBusy ? 'جاري المزامنة...' : 'مزامنة فورية الآن'}</span>
            </button>

            <button
              type="button"
              onClick={() => offlineSyncService.toggleSimulatedOffline()}
              className={`px-3 py-2 rounded-xl text-xs font-bold border transition flex items-center gap-1 cursor-pointer focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-brand ${
                state.isSimulatedOffline
                  ? 'bg-rose-50 border-rose-300 text-rose-700 dark:bg-rose-950 dark:border-rose-800 dark:text-rose-200'
                  : 'bg-subtle hover:bg-surface border-hairline text-muted hover:text-ink'
              }`}
              title="محاكاة وضع عدم الاتصال لاختبار أداء المنظومة دون فصل النت الحقيقي"
            >
              <Sliders className="w-3.5 h-3.5" />
              <span>{state.isSimulatedOffline ? 'إلغاء المحاكاة' : 'محاكاة Offline'}</span>
            </button>
          </div>
        </div>
      )}

      {/* 3. Persistent Floating Status Pill */}
      <button
        ref={pillRef}
        type="button"
        onClick={() => setIsExpanded((prev) => !prev)}
        aria-expanded={isExpanded}
        aria-label={isExpanded ? 'إغلاق بطاقة المزامنة' : 'فتح بطاقة المزامنة'}
        className={`px-3.5 py-2 rounded-2xl border shadow-xl backdrop-blur-xl flex items-center gap-2.5 text-xs font-bold transition-all cursor-pointer hover:scale-[1.02] active:scale-95 focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-brand ${
          !state.isOnline
            ? 'bg-surface border-rose-500/60 text-rose-700 dark:text-rose-200 ring-2 ring-rose-500/20 animate-pulse'
            : isBusy
            ? 'bg-surface border-amber-500/60 text-amber-700 dark:text-amber-200'
            : state.pendingCount > 0
            ? 'bg-surface border-blue-500/60 text-blue-700 dark:text-blue-200'
            : 'bg-surface border-hairline text-muted hover:text-ink'
        }`}
      >
        <div className="relative flex items-center justify-center">
          {!state.isOnline ? (
            <WifiOff className="w-3.5 h-3.5 text-rose-600 dark:text-rose-400" />
          ) : isBusy ? (
            <RefreshCw className="w-3.5 h-3.5 text-amber-600 dark:text-amber-400 animate-spin" />
          ) : state.pendingCount > 0 ? (
            <HardDriveUpload className="w-3.5 h-3.5 text-blue-600 dark:text-blue-400" />
          ) : (
            <CheckCircle2 className="w-3.5 h-3.5 text-brand-600 dark:text-brand-400" />
          )}

          {!state.isOnline && (
            <span className="absolute -top-1 -right-1 w-2 h-2 rounded-full bg-rose-500 animate-ping" />
          )}
        </div>

        <div className="flex items-center gap-1.5">
          <span>
            {!state.isOnline
              ? 'وضع غير متصل (Offline)'
              : isBusy
              ? 'جاري المزامنة...'
              : state.pendingCount > 0
              ? 'مجدولة للمزامنة'
              : 'متصل بالسحابة'}
          </span>

          {state.pendingCount > 0 && (
            <span
              className={`px-1.5 py-0.2 rounded-md font-mono text-[10px] font-black ${
                !state.isOnline ? 'bg-rose-600 text-white' : 'bg-blue-600 text-white'
              }`}
            >
              {state.pendingCount}
            </span>
          )}
        </div>

        <div className="text-faint mr-1">
          {isExpanded ? <ChevronDown className="w-3.5 h-3.5" /> : <ChevronUp className="w-3.5 h-3.5" />}
        </div>
      </button>
    </div>
  );
};