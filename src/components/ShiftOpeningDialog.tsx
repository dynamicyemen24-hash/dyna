/**
 * SHIFT OPENING — the cash count that belongs to a shift
 * ══════════════════════════════════════════════════════════════════════════
 *
 * WHY THIS IS NOT A FIELD ON THE SIGN-IN SCREEN
 * ──────────────────────────────────────────────
 * It used to be, and it was wrong in four ways at once.
 *
 * 1. IT IS A DIFFERENT EVENT. Authentication answers "who are you". A cash
 *    count answers "how much money was in the drawer when this shift began".
 *    Those happen at different moments, for different reasons, and are
 *    witnessed by different people. Merging them means every sign-in
 *    silently opens a shift.
 *
 * 2. THE SIGN-IN SCREEN IS PRE-AUTHENTICATION. Typing a cash figure on a
 *    screen that has not yet verified anybody records money against an
 *    unproven identity. The shift is the auditable financial record; the
 *    identity has to be settled before it is opened.
 *
 * 3. IT FABRICATED A BALANCE. The field shipped pre-filled with `500.00`.
 *    Nobody counted 500 riyals. A default that looks like a measurement is
 *    the most dangerous kind of default: it survives into the ledger as
 *    fact.
 *
 * 4. IT CONTRADICTED THE SERVER. `selectBranch` opened a local shift with
 *    `openingCash: 0` while `/api/auth/login` had already recorded the typed
 *    500 in `pos_sessions`. Two sources of truth for one number, and they
 *    disagreed from the first frame.
 *
 * WHAT REPLACES IT
 * ───────────────
 * This dialog. The operator signs in, THEN counts the drawer. The count is
 * declared by nobody — it is entered by the person who physically counted
 * it, and it is written once, to one place, through one call.
 *
 * It follows the cash-handling controls every retail and hospitality system
 * with a real audit trail: the float is counted at handover, confirmed
 * explicitly, and the count is the authoritative opening balance for every
 * variance check until the shift closes.
 *
 * ACCESSIBILITY
 *  - The field is a labelled `inputmode="decimal"` with a real `<label>`,
 *    not a placeholder — a placeholder disappears the moment a value exists,
 *    and this is the one number an auditor must never misread.
 *  - The keypad is `dir="ltr"` and numeric: money is written LTR in Arabic
 *    and the caret jumping between digits is unusable.
 *  - Focus moves into the field on open, Escape is handled by the dialog
 *    shell, and the destructive "start without a count" path states plainly
 *    what it will record.
 */

import React, { useEffect, useMemo, useRef, useState } from 'react';
import { Banknote, Check, X, AlertTriangle, ShieldCheck, Coins } from 'lucide-react';
import type { ShiftInfo } from '../types';

/** Denominations offered as quick-add, in Saudi Riyals. */
const QUICK_AMOUNTS = [100, 200, 500, 1000];

/** How a count is parsed. Rejects nonsense before it can reach the ledger. */
export const parseCash = (raw: string): { value: number; error: string | null } => {
  const trimmed = raw.trim().replace(/[,\s]/g, '');
  if (trimmed === '') return { value: 0, error: null };
  if (!/^\d+(\.\d{1,2})?$/.test(trimmed)) {
    return { value: 0, error: 'أدخل رقماً صحيحاً، وبحد أقصى منزلتين عشريتين (مثال: 250.00)' };
  }
  const value = Number(trimmed);
  if (!Number.isFinite(value)) return { value: 0, error: 'قيمة غير صالحة' };
  if (value > 10_000_000) return { value: 0, error: 'القيمة أكبر من الحد المعقول لبيت نقدي' };
  // Smallest coin in circulation is 1 halala; anything finer is a typo.
  if (Math.round(value * 100) !== value * 100) {
    return { value: 0, error: 'أدخل فقط إلى منزلتين عشريتين (هللات)' };
  }
  return { value, error: null };
};

export interface ShiftOpeningDialogProps {
  open: boolean;
  branchName: string;
  cashierName: string;
  /** Called with the counted amount once the shift is confirmed open. */
  onConfirm: (openingCash: number) => void;
  /** Shown only when there is no branch to open a shift against. */
  blockedReason?: string;
  onClose?: () => void;
  /**
   * A write is in flight.
   *
   * The confirm button is held disabled until it clears. Without this a
   * cashier double-taps — which is exactly what people do at a till — and
   * two shift records are attempted for one handover. The server also
   * refuses the second, but making the control honest about being busy is
   * better than relying on the conflict to be the feedback.
   */
  busy?: boolean;
}

/**
 * The dialog body.
 *
 * The count is not validated against a "minimum float" — that is a policy
 * decision a tenant makes, and inventing a threshold here would block a
 * legitimately empty till. What IS enforced is that the number is either a
 * real measurement or an explicit, recorded decision to proceed without one.
 */
export const ShiftOpeningDialog: React.FC<ShiftOpeningDialogProps> = ({
  open, branchName, cashierName, onConfirm, blockedReason, onClose, busy = false,
}) => {
  const [raw, setRaw] = useState('');
  const [touched, setTouched] = useState(false);
  const inputRef = useRef<HTMLInputElement>(null);

  useEffect(() => {
    if (!open) return;
    setRaw('');
    setTouched(false);
    // Focus the field: this dialog has exactly one input, and sending the
    // operator straight to it is what makes the count fast.
    const t = setTimeout(() => inputRef.current?.focus(), 60);
    return () => clearTimeout(t);
  }, [open]);

  const parsed = useMemo(() => parseCash(raw), [raw]);
  const showError = touched && parsed.error !== null;
  const isEmpty = parsed.value === 0 && raw.trim() === '';
  const blocked = Boolean(blockedReason);

  if (!open) return null;

  const confirm = () => {
    setTouched(true);
    if (parsed.error) return;
    onConfirm(parsed.value);
  };

  const addQuick = (amount: number) => {
    setTouched(true);
    setRaw((parsed.value + amount).toFixed(2));
  };
  return (
    <div
      className="fixed inset-0 z-[90] flex items-center justify-center bg-black/60 backdrop-blur-sm p-4"
      onMouseDown={(e) => { if (onClose && e.target === e.currentTarget) onClose(); }}
    >
      <div
        role="dialog"
        aria-modal="true"
        aria-labelledby="shift-open-h"
        className="w-full max-w-md bg-surface text-ink rounded-2xl border border-hairline elev-2 overflow-hidden"
      >
        <header className="flex items-start justify-between gap-3 px-5 py-4 border-b border-hairline">
          <div className="min-w-0">
            <h2 id="shift-open-h" className="text-base font-semibold text-ink flex items-center gap-2">
              <Banknote size={17} className="text-brand" aria-hidden="true" />
              فتح الوردية — عدّ النقدية
            </h2>
            <p className="text-2xs text-muted mt-1 leading-relaxed">
              خطوة مستقلة عن تسجيل الدخول. يُسجَّل باسم
              <strong className="text-ink"> {cashierName || 'الكاشير'}</strong>
              {branchName ? <> في <strong className="text-ink">{branchName}</strong></> : null}
              {' '}ويُستخدم أساساً لمطابقة إغلاق الوردية.
            </p>
          </div>
          {onClose && (
            <button
              type="button"
              onClick={onClose}
              aria-label="إغلاق"
              className="shrink-0 w-8 h-8 grid place-items-center rounded-lg text-faint hover:text-ink hover:bg-subtle transition-colors"
            >
              <X size={16} aria-hidden="true" />
            </button>
          )}
        </header>
        <div className="p-5 space-y-4">
          {blocked ? (
            <div role="alert" className="flex items-start gap-2.5 rounded-xl border border-rose-200 bg-rose-50 p-3">
              <AlertTriangle size={15} className="text-rose-600 mt-0.5 shrink-0" aria-hidden="true" />
              <p className="text-2xs text-rose-800 leading-relaxed">{blockedReason}</p>
            </div>
          ) : (
            <>
              <div>
                <label htmlFor="shift-open-cash" className="block text-xs font-bold text-ink mb-1.5">
                  المبلغ المعدود في الدرج
                </label>
                <div className="relative">
                  <input
                    id="shift-open-cash"
                    ref={inputRef}
                    type="text"
                    inputMode="decimal"
                    dir="ltr"
                    autoComplete="off"
                    value={raw}
                    onChange={(e) => { setRaw(e.target.value); setTouched(true); }}
                    onBlur={() => setTouched(true)}
                    onKeyDown={(e) => { if (e.key === 'Enter') confirm(); }}
                    aria-invalid={showError}
                    aria-describedby={showError ? 'shift-open-err' : 'shift-open-hint'}
                    placeholder="0.00"
                    className="w-full bg-subtle border border-hairline rounded-xl px-3 py-2.5 text-lg font-mono text-ink text-right placeholder:text-faint focus:outline-none focus:border-brand"
                  />
                  <span className="absolute left-3 top-1/2 -translate-y-1/2 text-2xs text-faint font-mono pointer-events-none">
                    SAR
                  </span>
                </div>

                {showError ? (
                  <p id="shift-open-err" role="alert" className="text-2xs text-rose-600 mt-1.5 flex items-center gap-1.5">
                    <AlertTriangle size={12} aria-hidden="true" />
                    {parsed.error}
                  </p>
                ) : (
                  <p id="shift-open-hint" className="text-2xs text-muted mt-1.5">
                    عدّ الفئات ثم اكتب الإجمالي. اتركه صفراً إذا كان الدرج فارغاً.
                  </p>
                )}
              </div>

              {/* Quick-add: counting a till is arithmetic, and doing it in
                  the operator's head is where counting errors come from. */}
              <div>
                <p className="text-2xs text-muted mb-1.5">إضافة سريعة</p>
                <div className="flex flex-wrap gap-1.5">
                  {QUICK_AMOUNTS.map((amt) => (
                    <button
                      key={amt}
                      type="button"
                      onClick={() => addQuick(amt)}
                      className="px-3 py-1.5 rounded-lg border border-hairline bg-surface text-2xs font-bold text-ink hover:bg-subtle transition-colors font-mono"
                    >
                      +{amt}
                    </button>
                  ))}
                  <button
                    type="button"
                    onClick={() => { setRaw(''); setTouched(false); inputRef.current?.focus(); }}
                    disabled={isEmpty}
                    className="px-3 py-1.5 rounded-lg border border-hairline bg-surface text-2xs font-bold text-muted hover:text-ink transition-colors disabled:opacity-40"
                  >
                    تصفير
                  </button>
                </div>
              </div>

              {/* Where the number goes. An operator who cannot see that will
                  not enter it. */}
              <div className="rounded-xl border border-hairline bg-subtle p-3 space-y-1.5">
                <p className="text-2xs text-muted">ما الذي سيُسجَّل عند التأكيد</p>
                <dl className="text-xs space-y-1">
                  <div className="flex items-center justify-between">
                    <dt className="text-muted">الرصيد الافتتاحي</dt>
                    <dd className="font-mono font-bold text-ink">
                      {parsed.error ? '—' : `${parsed.value.toFixed(2)} SAR`}
                    </dd>
                  </div>
                  <div className="flex items-center justify-between">
                    <dt className="text-muted">الوقت</dt>
                    <dd className="font-mono text-ink">
                      {new Date().toLocaleTimeString('ar-SA', { hour: '2-digit', minute: '2-digit' })}
                    </dd>
                  </div>
                </dl>
              </div>
            </>
          )}
        </div>

        <footer className="flex items-center justify-between gap-2 px-5 py-3.5 border-t border-hairline bg-subtle">
          <span className="text-2xs text-faint flex items-center gap-1.5">
            <ShieldCheck size={12} aria-hidden="true" />
            يُسجَّل في سجل التدقيق
          </span>
          <div className="flex items-center gap-2">
            {onClose && (
              <button
                type="button"
                onClick={onClose}
                className="px-4 py-2.5 rounded-lg border border-hairline bg-surface text-xs font-bold text-muted hover:text-ink transition-colors"
              >
                إلغاء
              </button>
            )}
            <button
              type="button"
              onClick={confirm}
              disabled={blocked || busy || parsed.error !== null}
              className="px-5 py-2.5 rounded-lg bg-brand text-white text-xs font-bold hover:opacity-90 disabled:opacity-50 transition-opacity inline-flex items-center gap-1.5"
            >
              {isEmpty ? <Coins size={14} aria-hidden="true" /> : <Check size={14} aria-hidden="true" />}
              {isEmpty ? 'فتح الوردية برصيد صفر' : 'تأكيد العدّ وفتح الوردية'}
            </button>
          </div>
        </footer>
      </div>
    </div>
  );
};