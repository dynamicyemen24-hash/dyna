import React, { useState, useEffect } from 'react';
import {
  Clock, Database, ShieldCheck, CloudCheck, HardDriveUpload, RefreshCw,
  Globe2, UserCheck, Calendar, Sparkles, GitBranch, AlertTriangle,
} from 'lucide-react';
import { ShiftInfo, SyncStatus } from '../types';

/**
 * Status bar — the terminal's own health line.
 *
 * Two rules it exists to enforce:
 *
 *  1. **Nothing invented.** The synchronised/unsynchronised state and the last
 *     sync time come from the offline queue service, the branch comes from the
 *     selected branch, and the shift state comes from the session. The bar used
 *     to print `Station #POS-01` and "backup: now" as constants, which on a
 *     terminal that had never backed up is a lie printed under every screen.
 *  2. **Readable in the light.** The tokens from `index.css` are used rather
 *     than slate-300 on white, so the bar survives the dark, OLED and
 *     high-contrast themes instead of disappearing in them.
 */
interface BottomStatusBarProps {
  shift: ShiftInfo;
  syncStatus: SyncStatus;
  lastBackupTime: string | null;
  onOpenAppInstaller: () => void;
  /** Operations waiting in the local queue. 0 means everything is durable. */
  pendingCount?: number;
  /** The branch this terminal works in. */
  branchLabel?: string;
  /** The organisation's reporting base currency (`dypos.tenants.base_currency`). */
  baseCurrency?: string;
}

export const BottomStatusBar: React.FC<BottomStatusBarProps> = ({
  shift,
  syncStatus,
  lastBackupTime,
  onOpenAppInstaller,
  pendingCount = 0,
  branchLabel,
  baseCurrency = 'SAR',
}) => {
  const [currentTime, setCurrentTime] = useState(new Date());

  useEffect(() => {
    const timer = setInterval(() => setCurrentTime(new Date()), 1000);
    return () => clearInterval(timer);
  }, []);

  const timeString = currentTime.toLocaleTimeString('ar-SA', {
    hour: '2-digit', minute: '2-digit', second: '2-digit',
  });
  const dateString = currentTime.toLocaleDateString('ar-SA', {
    weekday: 'short', day: 'numeric', month: 'short', year: 'numeric',
  });

  return (
    <div className="w-full bg-surface text-muted border-t border-hairline px-3 py-1 flex items-center justify-between text-2xs select-none z-40 relative">
      {/* Terminal identity — who is working, where, and on which shift */}
      <div className="flex items-center gap-3 min-w-0">
        <div className="flex items-center gap-1.5 min-w-0">
          <UserCheck size={13} className="text-brand shrink-0" />
          <span className="truncate">
            العامل:{' '}
            <strong className="text-ink">{shift.cashierName || '—'}</strong>
          </span>
        </div>

        <span className="h-3 w-px bg-hairline hidden sm:block" />

        <span className="hidden sm:flex items-center gap-1.5 truncate" title={branchLabel}>
          <GitBranch size={12} className="text-faint shrink-0" />
          {branchLabel || 'بلا فرع'}
        </span>

        <span className="h-3 w-px bg-hairline hidden sm:block" />

        <span
          className={`flex items-center gap-1.5 ${shift.isOpen ? 'text-brand-600' : 'text-amber-600'}`}
          title={shift.isOpen
            ? `وردية مفتوحة — نقدي افتتاحي ${shift.openingCash}`
            : 'لا توجد وردية مفتوحة على هذا الجهاز'}
        >
          <span className={`w-1.5 h-1.5 rounded-full ${shift.isOpen ? 'bg-brand-500' : 'bg-amber-500'}`} />
          {shift.isOpen ? 'وردية مفتوحة' : 'بلا وردية'}
        </span>

        <span className="h-3 w-px bg-hairline hidden lg:block" />

        <span className="hidden lg:flex items-center gap-1.5" title="العملة الأساسية للتوحيد">
          <Globe2 size={12} className="text-faint" />
          <span>التوحيد: <strong className="text-ink">{baseCurrency}</strong></span>
        </span>
      </div>

      {/* Storage and synchronisation — the state that decides whether a sale is durable */}
      <div className="flex items-center gap-3">
        <div className="hidden md:flex items-center gap-1.5 text-2xs font-mono" title="قاعدة البيانات المركزية">
          <Database size={12} className="text-faint" />
          <span>Neon PostgreSQL</span>
        </div>

        <span className="h-3 w-px bg-hairline hidden md:block" />

        <div className="flex items-center gap-1.5 font-mono">
          {syncStatus === 'synced' && (
            <span className="text-brand-600 flex items-center gap-1 font-semibold">
              <CloudCheck size={13} />
              متزامن{lastBackupTime ? ` · ${lastBackupTime}` : ''}
            </span>
          )}
          {syncStatus === 'syncing' && (
            <span className="text-amber-600 flex items-center gap-1 font-semibold">
              <RefreshCw size={13} className="animate-spin" />
              جارٍ التزامن
            </span>
          )}
          {syncStatus === 'offline' && (
            <span className="text-amber-700 flex items-center gap-1 font-semibold" title="العمليات محفوظة محلياً حتى عودة الشبكة">
              <HardDriveUpload size={13} />
              {pendingCount > 0 ? `${pendingCount} بانتظار المزامنة` : 'محلي آمن'}
            </span>
          )}
        </div>

        {syncStatus !== 'synced' && (
          <span className="hidden sm:flex items-center gap-1 text-2xs text-faint">
            <ShieldCheck size={12} />
            لا فقد بيانات
          </span>
        )}

        {pendingCount > 0 && syncStatus === 'offline' && (
          <span className="hidden xl:flex items-center gap-1 text-2xs text-amber-700">
            <AlertTriangle size={12} />
            راجع قائمة الانتظار قبل إغلاق الوردية
          </span>
        )}
      </div>

      {/* Application install and the live clock */}
      <div className="flex items-center gap-3">
        <button
          onClick={onOpenAppInstaller}
          className="hidden lg:flex items-center gap-1 text-2xs text-brand hover:underline font-semibold transition-colors cursor-pointer"
        >
          <Sparkles size={12} />
          <span>تثبيت التطبيق</span>
        </button>

        <span className="h-3 w-px bg-hairline hidden lg:block" />

        <div className="flex items-center gap-2 font-mono text-2xs">
          <Calendar size={12} className="text-faint hidden sm:inline" />
          <span className="hidden sm:inline text-muted">{dateString}</span>
          <Clock size={12} className="text-faint" />
          <span className="text-ink">{timeString}</span>
        </div>
      </div>
    </div>
  );
};

export default BottomStatusBar;

