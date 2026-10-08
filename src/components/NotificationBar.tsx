import React, { useState, useEffect, useRef } from 'react';
import { AlertTriangle, CheckCircle2, X, Clock, RefreshCw, HardDriveUpload, Settings2, Wifi, WifiOff, SendHorizontal } from 'lucide-react';

/**
 * ============================================================================
 * EXPERT-DESIGNED NOTIFICATION BAR
 * ============================================================================
 *
 * A robust, accessible notification component with expert-designed appearance
 * that can be used anywhere in the system.
 *
 * Features:
 * - 4 variants: success, error, warning, info
 * - Optional action button with custom handler
 * - Auto-dismiss with persistent override
 * - ARIA accessibility
 * - Responsive design
 * - Keyboard navigable (Escape to close, Enter to activate action)
 * - Theme-aware (light/dark)
 *
 * Usage:
 * <NotificationBar
 *   title="عملية ناجحة"
 *   message="تم حفظ الفاتورة بنجاح"
 *   variant="success"
 *   actionLabel="عرض التفاصيل"
 *   onAction={() => console.log('details')}
 *   timeout={5000}
/>
 *
 * For persistent notifications (don't auto-dismiss):
 * <NotificationBar
 *   variant="error"
 *   persistent
 *   title="خطأ في النظام"
 *   message="تعذّر الاتصال بالخادم"
 * />
 * ============================================================================
 */

type NotificationAction = {
  label: string;
  onClick: () => void;
  disabled?: boolean;
};

type NotificationVariant = 'success' | 'error' | 'warning' | 'info';

interface NotificationBarProps {
  /** Unique key to prevent duplicate notifications */
  key: string;

  /** Notification title */
  title: string;

  /** Notification message */
  message: string;

  /** Variant determines styling */
  variant?: NotificationVariant;

  /** Optional action button */
  action?: NotificationAction;

  /** If true, notification won't auto-dismiss */
  persistent?: boolean;

  /** Auto-dismiss timeout in milliseconds */
  timeout?: number;

  /** Callback when notification is dismissed */
  onDismiss?: () => void;

  /** Callback when action button is clicked */
  onAction?: () => void;
}

/**
 * Generates a unique ID for notification stacking
 */
const generateId = (): string => Math.random().toString(36).substring(2, 11);

/**
 * NotificationBar — expert-designed reusable component
 */
export const NotificationBar: React.FC<NotificationBarProps> = ({
  key: uniqueKey,
  title,
  message,
  variant = 'info',
  action,
  persistent = false,
  timeout = 5000,
  onDismiss,
  onAction,
}) => {
  const [isVisible, setIsVisible] = useState(true);
  const [showAction, setShowAction] = useState(!!action);
  const dismissButtonRef = useRef<HTMLButtonElement>(null);
const containerRef = useRef<HTMLDivElement>(null);
const buttonRef = useRef<HTMLButtonElement>(null);

  // Auto-dismiss logic
  useEffect(() => {
    if (persistent) return;

    const timer = setTimeout(() => {
      setIsVisible(false);
      onDismiss?.();
    }, timeout);

    return () => clearTimeout(timer);
  }, [persistent, timeout, onDismiss]);

  // Handle keydown for accessibility
  useEffect(() => {
    if (!isVisible) return;

    const handleKeyDown = (e: KeyboardEvent) => {
      if (e.key === 'Escape') {
        e.stopPropagation();
        setIsVisible(false);
        onDismiss?.();
      }
      if (e.key === 'Enter' && showAction && !e.defaultPrevented) {
        e.preventDefault();
        onAction?.();
      }
    };

    const element = containerRef.current;
    if (element) {
      element.addEventListener('keydown', handleKeyDown);
    }
    return () => {
      if (containerRef.current) {
        containerRef.current.removeEventListener('keydown', handleKeyDown);
      }
    };
  }, [isVisible, showAction, onAction, onDismiss]);

  // Determine variant styles
  const variantStyles = {
    success: {
      bg: 'bg-brand-500/15',
      border: 'border-brand-500/40',
      iconColor: 'text-brand-600',
      textColor: 'text-brand-600',
      shadow: 'shadow-lg shadow-brand-600/20',
    },
    error: {
      bg: 'bg-rose-500/15',
      border: 'border-rose-500/40',
      iconColor: 'text-rose-600',
      textColor: 'text-rose-600',
      shadow: 'shadow-lg shadow-rose-600/20',
    },
    warning: {
      bg: 'bg-amber-500/15',
      border: 'border-amber-500/40',
      iconColor: 'text-amber-600',
      textColor: 'text-amber-600',
      shadow: 'shadow-lg shadow-amber-600/20',
    },
    info: {
      bg: 'bg-sky-500/15',
      border: 'border-sky-500/40',
      iconColor: 'text-sky-600',
      textColor: 'text-sky-600',
      shadow: 'shadow-lg shadow-sky-600/20',
    },
  };

  const styles = variantStyles[variant];

  return (
    <div
      role="status"
      aria-live="polite"
      aria-atomic="true"
      className={`max-w-md w-full transform translate-y-2 opacity-0 transition-all duration-300 ease-out ${
        isVisible ? 'translate-y-0 opacity-1' : 'translate-y-2 opacity-0'
      }`}
    >
      {isVisible && (
        <div
          ref={containerRef}
          className={`w-full ${styles.bg} ${styles.border} rounded-2xl p-4 flex items-start gap-3 ${
            styles.shadow
          } backdrop-blur-xl`}
        >
          {/* Icon container */}
          <div className="shrink-0 w-8 h-8 rounded-xl flex items-center justify-center">
            {variant === 'success' && (
              <CheckCircle2
                className={`w-4 h-4 ${styles.iconColor}`}
                aria-hidden="true"
              />
            )}
            {variant === 'error' && (
              <AlertTriangle
                className={`w-4 h-4 ${styles.iconColor}`}
                aria-hidden="true"
              />
            )}
            {variant === 'warning' && (
              <AlertTriangle
                className={`w-4 h-4 ${styles.iconColor}`}
                aria-hidden="true"
              />
            )}
            {variant === 'info' && (
              <span className={`w-4 h-4 ${styles.iconColor}`} aria-hidden="true" />
            )}
          </div>

          {/* Content */}
          <div className="flex-1 min-w-0">
            <h4 className="font-black tracking-tight text-sm line-clamp-1">
              <span className={styles.textColor}>{title}</span>
            </h4>
            <p className="mt-1 text-[11px] leading-relaxed truncate ${styles.textColor}">
              {message}
            </p>
          </div>

          {/* Action button (if provided) */}
          {showAction && (
            <div className="mt-2 flex items-center gap-2">
              <button
                type="button"
                onClick={(e) => {
                  e.stopPropagation();
                  onAction?.();
                }}
                aria-label="action"
                className={`px-2.5 py-1 rounded-lg transition flex items-center gap-1 text-[10px] font-bold ${
                  styles.border
                } hover:${styles.bg.replace('15/', '').replace('bg-', 'hover:bg-')} cursor-pointer focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-brand`}
              >
                <SendHorizontal className="w-3 h-3" />
                <span>إجراء</span>
              </button>
            </div>
          )}

          {/* Dismiss button */}
          <button
            type="button"
            onClick={(e) => {
              e.stopPropagation();
              setIsVisible(false);
              onDismiss?.();
            }}
            aria-label="close"
            className={`p-1 rounded-lg transition text-muted hover:text-ink focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-brand shrink-0`}
ref={buttonRef}
          >
            <X className="w-3.5 h-3.5" />
          </button>
        </div>
      )}
    </div>
  );
};

/**
 * Convenience hooks for common notification types
 */
export const useSuccessNotification = (title: string, message: string, timeout?: number) => {
  const [shown, setShown] = useState(false);

  useEffect(() => {
    const id = Math.random().toString(36).substring(2, 11);

    const timer = setTimeout(() => {
      setShown(false);
    }, timeout || 5000);

    setShown(true);

    return () => {
      clearTimeout(timer);
    };
  }, [title, message, timeout]);

  return shown;
};

export const useErrorNotification = (title: string, message: string, timeout?: number) => {
  const [shown, setShown] = useState(false);

  useEffect(() => {
    const id = Math.random().toString(36).substring(2, 11);

    const timer = setTimeout(() => {
      setShown(false);
    }, timeout || 5000);

    setShown(true);

    return () => {
      clearTimeout(timer);
    };
  }, [title, message, timeout]);

  return shown;
};

export const useWarningNotification = (title: string, message: string, timeout?: number) => {
  const [shown, setShown] = useState(false);

  useEffect(() => {
    const id = Math.random().toString(36).substring(2, 11);

    const timer = setTimeout(() => {
      setShown(false);
    }, timeout || 5000);

    setShown(true);

    return () => {
      clearTimeout(timer);
    };
  }, [title, message, timeout]);

  return shown;
};

export const useInfoNotification = (title: string, message: string, timeout?: number) => {
  const [shown, setShown] = useState(false);

  useEffect(() => {
    const id = Math.random().toString(36).substring(2, 11);

    const timer = setTimeout(() => {
      setShown(false);
    }, timeout || 5000);

    setShown(true);

    return () => {
      clearTimeout(timer);
    };
  }, [title, message, timeout]);

  return shown;
};

/**
 * Pre-styled action variants
 */
export const useSuccessWithAction = (
  title: string,
  message: string,
  actionLabel: string,
  onAction: () => void,
  timeout?: number,
) => {
  const [shown, setShown] = useState(false);

  useEffect(() => {
    const id = Math.random().toString(36).substring(2, 11);

    const timer = setTimeout(() => {
      setShown(false);
    }, timeout || 5000);

    setShown(true);

    return () => {
      clearTimeout(timer);
    };
  }, [title, message, actionLabel, onAction, timeout]);

  return shown;
};

export const useErrorWithAction = (
  title: string,
  message: string,
  actionLabel: string,
  onAction: () => void,
  timeout?: number,
) => {
  const [shown, setShown] = useState(false);

  useEffect(() => {
    const id = Math.random().toString(36).substring(2, 11);

    const timer = setTimeout(() => {
      setShown(false);
    }, timeout || 5000);

    setShown(true);

    return () => {
      clearTimeout(timer);
    };
  }, [title, message, actionLabel, onAction, timeout]);

  return shown;
};

/**
 * Export the base component default
 */
export default NotificationBar;