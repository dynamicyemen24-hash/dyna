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
    <AlertCircle className="text-err" size={34} />
    <p className="text-err-strong text-sm font-medium max-w-md">{message}</p>
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
        : 'bg-err-soft border-err/30 text-err-strong'
    }`}
    role="status"
  >
    {kind === 'ok' ? (
      <CheckCircle2 size={18} className="text-brand" />
    ) : (
      <AlertCircle size={18} className="text-err" />
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

/* --------------------------- Status semantics --------------------------- */
/* Fiori ObjectStatus + Fluent Badge + Redwood pattern, theme-token driven. */
export type StatusTone = 'ok' | 'warn' | 'err' | 'info' | 'brand' | 'neutral';

const STATUS_TONE_CLASS: Record<StatusTone, string> = {
  ok: 'bg-ok-soft text-ok-strong border-ok/30',
  warn: 'bg-warn-soft text-warn-strong border-warn/30',
  err: 'bg-err-soft text-err-strong border-err/30',
  info: 'bg-info-soft text-info-strong border-info/30',
  brand: 'bg-brand-soft text-brand-strong border-brand/30',
  neutral: 'bg-subtle text-muted border-hairline',
};

export const StatusBadge: React.FC<{
  tone?: StatusTone;
  dot?: boolean;
  children: React.ReactNode;
}> = ({ tone = 'neutral', dot = false, children }) => (
  <span
    className={`inline-flex items-center gap-1.5 px-2.5 py-1 rounded-full text-[11px] font-bold border ${STATUS_TONE_CLASS[tone]}`}
  >
    {dot && (
      <span
        aria-hidden="true"
        className={`w-1.5 h-1.5 rounded-full ${
          tone === 'ok' ? 'bg-ok' : tone === 'warn' ? 'bg-warn' : tone === 'err' ? 'bg-err' : tone === 'info' ? 'bg-info' : tone === 'brand' ? 'bg-brand' : 'bg-faint'
        }`}
      />
    )}
    {children}
  </span>
);

/* ------------------------------ Skeletons ------------------------------- */
/* Content-shaped loading: reserves layout so first paint never jumps. */
export const Skeleton: React.FC<{ className?: string }> = ({ className = '' }) => (
  <div aria-hidden="true" className={`animate-pulse rounded-lg bg-subtle border border-hairline ${className}`} />
);

export const SkeletonRows: React.FC<{ rows?: number }> = ({ rows = 5 }) => (
  <div className="space-y-2.5" role="status" aria-label="جارٍ تحميل البيانات">
    {Array.from({ length: rows }).map((_, i) => (
      <Skeleton key={i} className="h-11 w-full" />
    ))}
  </div>
);

export const SkeletonCards: React.FC<{ count?: number }> = ({ count = 4 }) => (
  <div className="grid gap-4 sm:grid-cols-2 xl:grid-cols-4" role="status" aria-label="جارٍ تحميل البيانات">
    {Array.from({ length: count }).map((_, i) => (
      <div key={i} className="surface-card p-4 space-y-3">
        <Skeleton className="h-3 w-2/5" />
        <Skeleton className="h-7 w-4/5" />
      </div>
    ))}
  </div>
);

/* ------------------------------ SearchField ----------------------------- */
/* Fiori SearchField: debounced-ready input with clear action + kbd hint. */
export const SearchField: React.FC<{
  value: string;
  onChange: (v: string) => void;
  placeholder?: string;
  kbd?: string;
  autoFocus?: boolean;
}> = ({ value, onChange, placeholder = 'بحث…', kbd, autoFocus }) => (
  <div className="relative">
    <svg
      aria-hidden="true"
      className="absolute start-3 top-1/2 -translate-y-1/2 w-4 h-4 text-faint pointer-events-none"
      viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2"
    >
      <circle cx="11" cy="11" r="7" /><path d="m20 20-3.5-3.5" />
    </svg>
    <input
      type="search"
      value={value}
      autoFocus={autoFocus}
      onChange={(e) => onChange(e.target.value)}
      placeholder={placeholder}
      aria-label={placeholder}
      className="w-full bg-surface border border-hairline rounded-xl ps-9 pe-16 py-2.5 text-sm text-ink placeholder-faint outline-none transition focus:border-brand focus:ring-2 focus:ring-brand/20"
    />
    {value && (
      <button
        type="button"
        onClick={() => onChange('')}
        aria-label="مسح البحث"
        className="absolute end-9 top-1/2 -translate-y-1/2 w-5 h-5 grid place-items-center rounded-full text-faint hover:text-ink hover:bg-subtle transition-colors"
      >
        ×
      </button>
    )}
    {kbd && (
      <kbd className="absolute end-2.5 top-1/2 -translate-y-1/2 px-1.5 py-0.5 rounded border border-hairline bg-subtle text-[10px] font-mono text-faint">
        {kbd}
      </kbd>
    )}
  </div>
);

/* ------------------------------- MessageStrip ---------------------------- */
/* Fiori MessageStrip: inline semantic notice with optional dismiss. */
export const MessageStrip: React.FC<{
  tone?: StatusTone;
  title?: string;
  onDismiss?: () => void;
  children: React.ReactNode;
}> = ({ tone = 'info', title, onDismiss, children }) => {
  const wrap: Record<StatusTone, string> = {
    ok: 'bg-ok-soft border-ok/30 text-ok-strong',
    warn: 'bg-warn-soft border-warn/30 text-warn-strong',
    err: 'bg-err-soft border-err/30 text-err-strong',
    info: 'bg-info-soft border-info/30 text-info-strong',
    brand: 'bg-brand-soft border-brand/30 text-brand-strong',
    neutral: 'bg-subtle border-hairline text-muted',
  };
  return (
    <div className={`flex items-start gap-2.5 rounded-xl border px-3.5 py-2.5 text-[13px] ${wrap[tone]}`} role="status">
      <div className="min-w-0 flex-1">
        {title && <p className="font-bold mb-0.5">{title}</p>}
        <div className="opacity-90 leading-relaxed">{children}</div>
      </div>
      {onDismiss && (
        <button
          type="button"
          onClick={onDismiss}
          aria-label="إغلاق التنبيه"
          className="shrink-0 w-6 h-6 grid place-items-center rounded-lg opacity-70 hover:opacity-100 hover:bg-black/5 transition"
        >
          ×
        </button>
      )}
    </div>
  );
};

/* --------------------------------- Tabs --------------------------------- */
/* Segmented tab bar: roving single-select with aria-selected semantics. */
export const Tabs: React.FC<{
  tabs: { id: string; label: string; count?: number }[];
  active: string;
  onChange: (id: string) => void;
}> = ({ tabs, active, onChange }) => (
  <div className="inline-flex items-center gap-1 p-1 rounded-xl bg-subtle border border-hairline" role="tablist" aria-label="تبويبات العرض">
    {tabs.map((t) => {
      const selected = t.id === active;
      return (
        <button
          key={t.id}
          role="tab"
          aria-selected={selected}
          onClick={() => onChange(t.id)}
          className={`inline-flex items-center gap-1.5 px-3.5 py-1.5 rounded-lg text-[13px] font-bold transition-all ${
            selected
              ? 'bg-surface text-ink shadow-sm border border-hairline'
              : 'text-muted hover:text-ink'
          }`}
        >
          {t.label}
          {t.count !== undefined && (
            <span className={`px-1.5 py-px rounded-md text-[10px] font-mono ${selected ? 'bg-brand-soft text-brand-strong' : 'bg-surface text-faint border border-hairline'}`}>
              {t.count}
            </span>
          )}
        </button>
      );
    })}
  </div>
);
