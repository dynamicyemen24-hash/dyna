import React from 'react';
import { AlertTriangle, RefreshCw, Home } from 'lucide-react';

interface Props {
  children: React.ReactNode;
  /** Shown instead of the default panel when a boundary is placed per screen. */
  label?: string;
}

interface State {
  error: Error | null;
  info: string;
}

/**
 * Contains a render failure to one screen.
 *
 * The POS is used on shared terminals: an uncaught render error previously
 * unmounted the whole React tree and left the operator staring at a blank page
 * with no way back except a refresh. Now the failure is contained, described,
 * and recoverable in place.
 */
export class ErrorBoundary extends React.Component<Props, State> {
  state: State = { error: null, info: '' };

  static getDerivedStateFromError(error: Error): Partial<State> {
    return { error };
  }

  componentDidCatch(error: Error, info: React.ErrorInfo) {
    // Kept server-side too, so a crash report names the screen that failed.
    console.error('[دينا] render error', error, info.componentStack);
    this.setState({ info: (info.componentStack || '').split('\n').slice(1, 4).join(' ').trim() });
  }

  private reset = () => this.setState({ error: null, info: '' });

  render() {
    const { error, info } = this.state;
    if (!error) return this.props.children;

    return (
      <div className="flex flex-col items-center justify-center gap-5 py-20 px-8 text-center" role="alert">
        <span className="w-14 h-14 rounded-2xl bg-amber-50 text-amber-600 grid place-items-center">
          <AlertTriangle size={26} />
        </span>
        <div>
          <h2 className="text-lg font-semibold text-slate-900">
            تعذّر عرض {this.props.label || 'هذه الشاشة'}
          </h2>
<p className="text-[12.5px] text-slate-500 mt-1.5 max-w-md leading-relaxed">
              بقية النظام يعمل بشكل طبيعي. تعرض هذه الشاشة Error مؤقتاً؛ يمكنك:
            </p>
            <ul className="text-[11px] text-slate-400 mt-1 space-y-1 max-w-md">
              <li className="flex items-center gap-2">
                <svg
                  xmlns="http://www.w3.org/2000/svg"
                  width="16"
                  height="16"
                  viewBox="0 0 24 24"
                  fill="currentColor"
                  className="shrink-0"
                >
                  <path d="M12 2L2 7l10 5 10-5-10-5zM2 17l10 5 10-5-10-5z" />
                </svg>
                إعادة المحاولة (Retry)
              </li>
              <li className="flex items-center gap-2">
                <svg
                  xmlns="http://www.w3.org/2000/svg"
                  width="16"
                  height="16"
                  viewBox="0 0 24 24"
                  fill="currentColor"
                  className="shrink-0"
                >
                  <path d="M12 22c1.1 0 2-.9 2-2h-3l-1 4h-3l-1-4H2c0 1.1.89 2 2 2zM2 12l10 5 10-5-10-5z" />
                </svg>
                العودة للوحة التحكم (Home)
              </li>
              <li className="flex items-center gap-2">
                <svg
                  xmlns="http://www.w3.org/2000/svg"
                  width="16"
                  height="16"
                  viewBox="0 0 24 24"
                  fill="currentColor"
                  className="shrink-0"
                >
                  <path d="M12 6l8 6-8 6h-3v-6h3l-8-6zM2 12l10 5 10-5-10-5z" />
                </svg>
                إرسال تقرير خطأ (Report Error)
              </li>
            </ul>
          <p className="text-[11px] text-slate-400 mt-3 font-mono break-words max-w-md" dir="ltr">
            {error.message}
          </p>
          {info && (
            <p className="text-[10.5px] text-slate-300 mt-1 font-mono break-words max-w-md" dir="ltr">
              {info}
            </p>
          )}
        </div>
        <div className="flex items-center gap-2">
          <button
            onClick={this.reset}
            className="inline-flex items-center gap-2 px-4 py-2.5 rounded-xl bg-slate-900 hover:bg-slate-700 text-white text-[12.5px] font-semibold transition-colors"
          >
            <RefreshCw size={14} />
            إعادة المحاولة
          </button>
          <button
            onClick={() => {
              this.reset();
              window.location.href = '/';
            }}
            className="inline-flex items-center gap-2 px-4 py-2.5 rounded-xl border border-slate-200 hover:bg-slate-50 text-slate-700 text-[12.5px] font-semibold transition-colors"
          >
            <Home size={14} />
            لوحة التحكم
          </button>
        </div>
      </div>
    );
  }
}

export default ErrorBoundary;