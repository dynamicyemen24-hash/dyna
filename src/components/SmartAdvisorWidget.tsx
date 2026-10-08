import React, { useState } from 'react';
import { Sparkles, X, ChevronUp, ChevronDown, ArrowRight, ShieldCheck, AlertCircle, Info } from 'lucide-react';
import { getOperationalAdvice, OperationalAdvice } from '../services/smartAdvisor';

interface SmartAdvisorWidgetProps {
  currentScreen: string;
  userRole: string;
  activeShiftOpen?: boolean;
  onActionClick?: (target: string) => void;
  themeMode?: string;
}

export const SmartAdvisorWidget: React.FC<SmartAdvisorWidgetProps> = ({
  currentScreen,
  userRole,
  activeShiftOpen = false,
  onActionClick,
}) => {
  const [isOpen, setIsOpen] = useState(true);
  const advices = getOperationalAdvice(currentScreen, userRole, activeShiftOpen);

  if (advices.length === 0) return null;

  return (
    <div className="fixed bottom-4 start-4 z-50 max-w-sm w-full bg-slate-950/95 backdrop-blur-xl border border-brand-500/40 rounded-2xl shadow-2xl p-4 text-slate-100 font-['Cairo',sans-serif]" dir="rtl">
      <div className="flex items-center justify-between pb-3 border-b border-slate-800">
        <div className="flex items-center gap-2">
          <div className="w-8 h-8 rounded-xl bg-brand-500/20 border border-brand-500/40 flex items-center justify-center text-brand-400">
            <Sparkles className="w-4 h-4 animate-pulse" />
          </div>
          <div>
            <h4 className="text-xs font-bold text-white flex items-center gap-1.5">
              <span>المستشار الذكي (AI Co-Pilot)</span>
              <span className="w-2 h-2 rounded-full bg-emerald-500 animate-ping" />
            </h4>
            <p className="text-[10px] text-slate-400">توجيه تشغيلي ذكي فوري</p>
          </div>
        </div>
        <div className="flex items-center gap-1">
          <button
            type="button"
            onClick={() => setIsOpen(!isOpen)}
            className="p-1 rounded-lg hover:bg-slate-800 text-slate-400 hover:text-white transition-colors"
            aria-label="طي/إظهار المستشار"
          >
            {isOpen ? <ChevronDown className="w-4 h-4" /> : <ChevronUp className="w-4 h-4" />}
          </button>
          <button
            type="button"
            onClick={() => setIsOpen(false)}
            className="p-1 rounded-lg hover:bg-slate-800 text-slate-400 hover:text-white transition-colors"
            aria-label="إغلاق"
          >
            <X className="w-4 h-4" />
          </button>
        </div>
      </div>

      {isOpen && (
        <div className="mt-3 space-y-2.5 max-h-60 overflow-y-auto">
          {advices.map((advice) => (
            <div
              key={advice.id}
              className={`p-3 rounded-xl border text-xs flex flex-col gap-1.5 ${
                advice.type === 'warning'
                  ? 'bg-amber-950/40 border-amber-500/40 text-amber-200'
                  : advice.type === 'success'
                  ? 'bg-emerald-950/40 border-emerald-500/40 text-emerald-200'
                  : 'bg-brand-950/40 border-brand-500/40 text-brand-100'
              }`}
            >
              <div className="flex items-start gap-2">
                {advice.type === 'warning' ? (
                  <AlertCircle className="w-4 h-4 text-amber-400 shrink-0 mt-0.5" />
                ) : advice.type === 'success' ? (
                  <ShieldCheck className="w-4 h-4 text-emerald-400 shrink-0 mt-0.5" />
                ) : (
                  <Info className="w-4 h-4 text-brand-400 shrink-0 mt-0.5" />
                )}
                <div>
                  <h5 className="font-bold text-[11px]">{advice.title}</h5>
                  <p className="text-[10px] opacity-90 leading-relaxed mt-0.5">{advice.message}</p>
                </div>
              </div>

              {advice.actionLabel && advice.actionTarget && (
                <button
                  type="button"
                  onClick={() => onActionClick?.(advice.actionTarget!)}
                  className="mt-1 self-start inline-flex items-center gap-1 px-2.5 py-1 rounded-lg bg-brand-600 hover:bg-brand-500 text-white text-[10px] font-bold transition-colors cursor-pointer"
                >
                  <span>{advice.actionLabel}</span>
                  <ArrowRight className="w-3 h-3" />
                </button>
              )}
            </div>
          ))}
        </div>
      )}
    </div>
  );
};
