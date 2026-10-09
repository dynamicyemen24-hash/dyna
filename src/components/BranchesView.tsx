import React, { useState } from 'react';
import { Branch, ShiftInfo } from '../types';
import { Building2, MapPin, Phone, Clock, ShieldCheck } from 'lucide-react';
import { ShiftOpeningDialog } from './ShiftOpeningDialog';

interface BranchesViewProps {
  branches: Branch[];
  selectedBranch: Branch;
  onSelectBranch: (branch: Branch) => void;
  shift: ShiftInfo;
  onToggleShift: (openingCash: number) => void | boolean | Promise<void | boolean>;
  /** The signed-in operator, for the audit line on the count. */
  cashierName?: string;
}

export const BranchesView: React.FC<BranchesViewProps> = ({
  branches,
  selectedBranch,
  onSelectBranch,
  shift,
  onToggleShift,
  cashierName = '',
}) => {
  /*
   * The cash count lives in a dialog, not in this toolbar.
   *
   * It was a bare `<input>` defaulting to `'1000'`, whose handler read
   * `Number(input) || 1000` — so an empty or unparsable field silently became
   * 1000 riyals, and closing a shift passed a literal zero. Both paths
   * invented money.
   *
   * Now: opening counts before opening, closing counts before closing, and
   * the dialog only closes once the server has actually recorded the shift.
   * A rejected write leaves it open, because the operator has to know their
   * count did not land.
   */
  const [dialogOpen, setDialogOpen] = useState(false);
  const [busy, setBusy] = useState(false);

  const confirmCount = async (value: number) => {
    setBusy(true);
    try {
      const result = await onToggleShift(value);
      if (result !== false) setDialogOpen(false);
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="flex-1 flex flex-col p-6 overflow-y-auto bg-canvas text-ink">
      <div className="mb-6">
        <h2 className="text-xl font-black text-ink flex items-center gap-2">
          <Building2 className="w-6 h-6 text-brand" />
          إدارة الفروع وورديات الكاشير (Z-Report)
        </h2>
        <p className="text-xs text-faint mt-0.5">إدارة فروع المؤسسة، فتح وإغلاق الورديات، ومتابعة النقدية الافتتاحية</p>
      </div>

      {/* Shift Control Card */}
      <div className="surface-card rounded-2xl p-6 mb-6 shadow-sm">
        <div className="flex flex-col md:flex-row md:items-center justify-between gap-4 pb-4 border-b border-hairline">
          <div>
            <h3 className="text-base font-bold text-ink flex items-center gap-2">
              <Clock className="w-5 h-5 text-brand" />
              حالة الوردية الحالية
            </h3>
            <p className="text-xs text-faint mt-1">
              {shift.isOpen ? `الوردية مفتوحة بواسطة الكاشير: ${shift.cashierName} منذ ${shift.startTime}` : 'الوردية مغلقة حالياً. يرجى فتح وردية جديدة لبدء المبيعات.'}
            </p>
          </div>

          <div>
            {shift.isOpen ? (
              <button
                type="button"
                onClick={() => setDialogOpen(true)}
                className="bg-err-soft border border-err/30 text-err-strong hover:bg-rose-500/20 px-6 py-2.5 rounded-xl text-xs font-bold transition-all"
              >
                إغلاق الوردية (Z-Report)
              </button>
            ) : (
              <button
                type="button"
                onClick={() => setDialogOpen(true)}
                className="bg-brand-600 hover:bg-brand-500 text-white px-5 py-2.5 rounded-xl text-xs font-bold transition-all shadow-lg shadow-brand-600/30"
              >
                فتح الوردية بعد عدّ النقدية
              </button>
            )}
          </div>
        </div>

        {shift.isOpen && (
          <div className="grid grid-cols-1 sm:grid-cols-3 gap-4 pt-4">
            <div className="bg-subtle p-4 rounded-xl border border-hairline">
              <span className="text-xs text-faint block mb-1">إجمالي مبيعات الوردية</span>
              <span className="text-xl font-black text-brand font-mono">{shift.totalSales.toLocaleString()} ر.س</span>
            </div>
            <div className="bg-subtle p-4 rounded-xl border border-hairline">
              <span className="text-xs text-faint block mb-1">عدد الفواتير المصدرة</span>
              <span className="text-xl font-black text-ink font-mono">{shift.transactionsCount} فاتورة</span>
            </div>
            <div className="bg-subtle p-4 rounded-xl border border-hairline">
              <span className="text-xs text-faint block mb-1">النقدية في الدرج</span>
              <span className="text-xl font-black text-teal-400 font-mono">{(shift.openingCash + shift.cashSales).toLocaleString()} ر.س</span>
            </div>
          </div>
        )}
      </div>

      {/* Branches List */}
      <h3 className="text-sm font-bold text-ink mb-4">فروع المؤسسة المتاحة</h3>
      <div className="grid grid-cols-1 md:grid-cols-3 gap-4">
        {branches.map((b) => {
          const isSelected = selectedBranch.id === b.id;
          return (
            <div
              key={b.id}
              onClick={() => onSelectBranch(b)}
              className={`bg-surface border rounded-2xl p-5 cursor-pointer transition-all ${
                isSelected ? 'border-brand bg-brand-soft shadow-lg shadow-brand-500/10' : 'border-hairline hover:border-hairline'
              }`}
            >
              <div className="flex items-center justify-between mb-3">
                <h4 className="text-sm font-bold text-ink">{b.name}</h4>
                {isSelected && (
                  <span className="bg-brand-soft text-brand border border-brand/20 px-2 py-0.5 rounded-full text-[10px] font-semibold">
                    الفرع الحالي
                  </span>
                )}
              </div>

              <div className="space-y-2 text-xs text-faint mb-4">
                <div className="flex items-center gap-2">
                  <MapPin className="w-3.5 h-3.5 text-muted" />
                  <span>{b.city} - {b.address}</span>
                </div>
                <div className="flex items-center gap-2">
                  <Phone className="w-3.5 h-3.5 text-muted" />
                  <span className="font-mono">{b.phone}</span>
                </div>
              </div>

              <div className="pt-3 border-t border-hairline flex items-center justify-between">
                <span className="text-[11px] text-brand font-medium">نشط وعمليات مزامنة لحظية</span>
                <ShieldCheck className="w-4 h-4 text-brand" />
              </div>
            </div>
          );
        })}
      </div>

      <ShiftOpeningDialog
        open={dialogOpen}
        onClose={() => setDialogOpen(false)}
        onConfirm={confirmCount}
        busy={busy}
        branchName={selectedBranch?.name ?? ''}
        cashierName={cashierName || shift.cashierName}
      />
    </div>
  );
};
