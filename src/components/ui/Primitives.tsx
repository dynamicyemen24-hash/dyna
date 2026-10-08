import React from 'react';
import { AlertCircle, CheckCircle2, Loader2, Inbox } from 'lucide-react';

/* ------------------------------ Page shell ------------------------------ */
export const ScreenHeader: React.FC<{
  icon: React.ElementType;
  title: string;
  subtitle: string;
  accent?: string;
  actions?: React.ReactNode;
}> = ({ icon: Icon, title, subtitle, accent = 'text-brand', actions }) => (
  <div className="flex flex-wrap justify-between items-center gap-4 mb-6">
    <div>
      <h1 className="text-xl font-semibold tracking-tight text-ink flex items-center gap-2.5">
        <span className="w-9 h-9 rounded-xl bg-brand-soft text-brand grid place-items-center">
          <Icon size={18} />
        </span>
        {title}
      </h1>
      <p className="text-muted mt-1.5 text-[12.5px]">{subtitle}</p>
    </div>
    {actions && <div className="flex items-center gap-2">{actions}</div>}
  </div>
);

export const Pill: React.FC<{ children: React.ReactNode; tone?: string }> = ({
  children,
  tone = 'bg-subtle text-muted border-hairline',
}) => (
  <span className={`px-2.5 py-1 rounded-full text-[11px] font-bold border ${tone}`}>
    {children}
  </span>
);

/* ------------------------------ Async states ---------------------------- */
export const StandardProgress: React.FC<{
  label?: string;
  detail?: string;
  value?: number;
  tone?: 'brand' | 'amber' | 'rose';
}> = ({ label = 'جارٍ تجهيز بيئة العمل…', detail = 'يتم تحميل البيانات دون تعطيل الشاشة', value, tone = 'brand' }) => {
  const bar = tone === 'rose' ? 'bg-rose-500' : tone === 'amber' ? 'bg-amber-500' : 'bg-brand-600';
  return (
    <div className="w-full max-w-md rounded-2xl border border-hairline bg-surface p-4 shadow-sm" role="status" aria-live="polite">
      <div className="flex items-center justify-between gap-3">
        <div className="min-w-0">
          <p className="text-sm font-semibold text-ink truncate">{label}</p>
          <p className="mt-1 text-[11px] text-muted truncate">{detail}</p>
        </div>
        <Loader2 className="shrink-0 animate-spin text-brand-600" size={18} aria-hidden="true" />
      </div>
      <div className="mt-3 h-1.5 overflow-hidden rounded-full bg-subtle" aria-hidden="true">
        <div className={`h-full rounded-full transition-all duration-500 ${bar} ${value === undefined ? 'w-2/5 animate-pulse' : ''}`} style={value === undefined ? undefined : { width: `${Math.max(0, Math.min(100, value))}%` }} />
      </div>
      {value !== undefined && <p className="mt-1 text-end text-[10px] text-faint text-numeric">{Math.round(value)}%</p>}
    </div>
  );
};

export const Loading: React.FC<{ label?: string }> = ({
  label = 'جارٍ التحميل…',
}) => (
  <div className="flex items-center justify-center gap-3 py-16 text-muted">
    <Loader2 className="animate-spin" size={22} />
    <span className="text-sm">{label}</span>
  </div>
);

export const ErrorBox: React.FC<{ message: string; onRetry?: () => void }> = ({
  message,
  onRetry,
}) => (
  <div className="flex flex-col items-center justify-center gap-3 py-14 text-center">
    <AlertCircle className="text-rose-500" size={34} />
    <p className="text-rose-600 text-sm font-medium max-w-md">{message}</p>
    {onRetry && (
      <button
        onClick={onRetry}
        className="mt-2 px-5 py-2 bg-ink text-surface hover:opacity-85 rounded-xl text-xs font-bold transition-opacity"
      >
        إعادة المحاولة
      </button>
    )}
  </div>
);

export const EmptyState: React.FC<{
  message: string;
  action?: React.ReactNode;
}> = ({ message, action }) => (
  <div className="flex flex-col items-center justify-center gap-3 py-16 text-faint">
    <Inbox size={34} />
    <p className="text-sm text-muted">{message}</p>
    {action}
  </div>
);

export const Toast: React.FC<{
  kind: 'ok' | 'err';
  message: string;
  onClose: () => void;
}> = ({ kind, message, onClose }) => (
  <div
    className={`fixed bottom-6 left-1/2 -translate-x-1/2 z-50 flex items-center gap-3 px-5 py-3 rounded-2xl elev-2 border text-sm font-bold max-w-lg ${
      kind === 'ok'
        ? 'bg-surface border-hairline text-ink'
        : 'bg-rose-50 border-rose-200 text-rose-700'
    }`}
    role="status"
  >
    {kind === 'ok' ? (
      <CheckCircle2 size={18} className="text-brand" />
    ) : (
      <AlertCircle size={18} className="text-rose-500" />
    )}
    <span>{message}</span>
    <button
      onClick={onClose}
      className="text-faint hover:text-ink text-lg leading-none"
      aria-label="إغلاق"
    >
      ×
    </button>
  </div>
);

/* ------------------------------ Form parts ------------------------------ */
const fieldBase =
  'w-full bg-surface border border-hairline rounded-xl px-3.5 py-2.5 text-sm ' +
  'text-ink placeholder-faint outline-none transition ' +
  'focus:border-brand focus:ring-2 focus:ring-brand/20';


export const Field: React.FC<{
  label: string;
  children: React.ReactNode;
  hint?: string;
}> = ({ label, children, hint }) => (
  <label className="block space-y-1.5">
    <span className="block text-xs font-bold text-muted">{label}</span>
    {children}
    {hint && <span className="block text-[11px] text-faint">{hint}</span>}
  </label>
);

export const Input = (props: React.InputHTMLAttributes<HTMLInputElement>) => (
  <input {...props} className={fieldBase} />
);

export const TextArea = (props: React.TextareaHTMLAttributes<HTMLTextAreaElement>) => (
  <textarea {...props} className={`${fieldBase} min-h-[80px] resize-y`} />
);

export const Select = (props: React.SelectHTMLAttributes<HTMLSelectElement>) => (
  <select {...props} className={fieldBase} />
);

export const PrimaryButton: React.FC<React.ButtonHTMLAttributes<HTMLButtonElement>> = ({
  className = '',
  ...rest
}) => (
  <button
    {...rest}
    className={`px-5 py-2.5 bg-brand-600 hover:bg-brand-500 disabled:opacity-50
      disabled:cursor-not-allowed text-white rounded-xl text-sm font-bold
      transition-all inline-flex items-center gap-2 ${className}`}
  />
);

export const GhostButton: React.FC<React.ButtonHTMLAttributes<HTMLButtonElement>> = ({
  className = '',
  ...rest
}) => (
  <button
    {...rest}
    className={`px-4 py-2.5 bg-subtle hover:bg-hairline/60 text-ink border border-hairline
      rounded-xl text-sm font-bold transition-colors inline-flex items-center
      gap-2 ${className}`}
  />
);

/* ------------------------------- Modal ---------------------------------- */
export const Modal: React.FC<{
  open: boolean;
  title: string;
  onClose: () => void;
  children: React.ReactNode;
}> = ({ open, title, onClose, children }) => {
  if (!open) return null;
  return (
    <div
      className="fixed inset-0 z-40 flex items-start justify-center overflow-y-auto bg-slate-950/45 backdrop-blur-sm p-4 sm:p-8"
      onClick={onClose}
    >
      <div
        className="w-full max-w-2xl surface-card elev-2 my-auto overflow-hidden"
        onClick={(e) => e.stopPropagation()}
        role="dialog"
        aria-modal="true"
      >
        <div className="flex items-center justify-between px-5 py-4 border-b border-hairline">
          <h3 className="text-base font-semibold text-ink">{title}</h3>
          <button
            onClick={onClose}
            className="w-8 h-8 grid place-items-center rounded-lg text-faint hover:text-ink hover:bg-subtle text-2xl leading-none transition-colors"
            aria-label="إغلاق"
          >
            ×
          </button>
        </div>
        <div className="p-5">{children}</div>
      </div>
    </div>
  );
};

/* ---------------------------- Layout helpers ---------------------------- */
export const Stat: React.FC<{
  label: string;
  value: string;
  tone?: string;
  icon?: React.ElementType;
}> = ({ label, value, tone = 'text-ink', icon: Icon }) => (
  <div className="surface-card p-4">
    <div className="flex items-center gap-2 text-faint text-xs font-bold mb-1.5">
      {Icon && <Icon size={14} />}
      {label}
    </div>
    <p className={`text-2xl font-semibold text-numeric tracking-tight ${tone}`}>{value}</p>
  </div>
);

export const Card: React.FC<{ children: React.ReactNode; className?: string }> = ({
  children,
  className = '',
}) => (
  <div className={`surface-card p-5 ${className}`}>{children}</div>
);
