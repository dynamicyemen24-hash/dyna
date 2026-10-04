import React, { useEffect, useState } from 'react';
import { apiPost, ApiError } from '../services/dyposApi';
import {
  KeyRound, ShieldCheck, Loader2, Check, X, AlertTriangle, Fingerprint,
} from 'lucide-react';

interface PolicyResult { ok: boolean; score: number; problems: string[] }

interface ChangePasswordViewProps {
  username: string;
  /** Called once the rotation succeeded, to unblock the application. */
  onDone: () => void;
  onSignOut: () => void;
}

const Field: React.FC<{
  label: string;
  value: string;
  onChange?: (v: string) => void;
  type?: string;
  disabled?: boolean;
  autoComplete?: string;
  error?: string;
  ok?: boolean;
}> = ({ label, value, onChange, type = 'text', disabled, autoComplete, error, ok }) => (
  <label className="block">
    <span className="text-[11px] font-medium text-slate-600">{label}</span>
    <input
      value={value}
      onChange={(e) => onChange?.(e.target.value)}
      type={type}
      disabled={disabled}
      autoComplete={autoComplete}
      className="mt-1 w-full px-3 py-2 rounded-lg border border-slate-200 bg-white text-[12.5px] text-slate-800 outline-none focus:border-slate-400 focus:ring-2 focus:ring-slate-900/5 disabled:bg-slate-50 disabled:text-slate-500"
    />
    {error && <span className="text-[10.5px] text-rose-600">{error}</span>}
    {ok && !error && <span className="text-[10.5px] text-brand-600">مطابقة</span>}
  </label>
);

/**
 * Forced password rotation.
 *
 * This screen is a hard gate: the application must not render a single
 * business module until it succeeds. The temporary credential shipped with the
 * deployment is known to the customer, so it is treated as compromised the
 * moment it is issued.
 */
export const ChangePasswordView: React.FC<ChangePasswordViewProps> = ({
  username, onDone, onSignOut,
}) => {
  const [current, setCurrent] = useState('');
  const [next, setNext] = useState('');
  const [confirm, setConfirm] = useState('');
  const [policy, setPolicy] = useState<PolicyResult | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const [done, setDone] = useState(false);

  // Live policy check, debounced so typing does not hammer the endpoint.
  useEffect(() => {
    if (!next) { setPolicy(null); return; }
    const t = setTimeout(async () => {
      try {
        setPolicy(await apiPost<PolicyResult>('/api/auth/password-policy', {
          password: next, username,
        }));
      } catch { /* the server re-checks on submit regardless */ }
    }, 250);
    return () => clearTimeout(t);
  }, [next, username]);

  const matches = next.length > 0 && next === confirm;
  const canSubmit = current.length > 0 && matches && Boolean(policy?.ok) && !busy;

  const submit = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!canSubmit) return;
    setBusy(true);
    setError('');
    try {
      await apiPost('/api/auth/change-password', {
        currentPassword: current, newPassword: next, confirmPassword: confirm,
      });
      setDone(true);
      setTimeout(onDone, 900);
    } catch (err: any) {
      setError(err instanceof ApiError ? err.message : 'تعذّر تغيير كلمة المرور');
    } finally {
      setBusy(false);
    }
  };

  const scoreColor = !policy ? 'bg-slate-200'
    : policy.score >= 4 ? 'bg-brand-500'
    : policy.score >= 3 ? 'bg-amber-500'
    : 'bg-rose-500';

  return (
    <div className="min-h-screen bg-[#f6f7f9] grid place-items-center px-6 py-10" dir="rtl">
      <div className="w-full max-w-md">
        <header className="text-center mb-6">
          <div className="w-11 h-11 mx-auto mb-3 rounded-xl bg-amber-500/10 grid place-items-center">
            <ShieldCheck size={22} className="text-amber-600" />
          </div>
          <h1 className="text-[17px] font-semibold text-slate-900">يجب تغيير كلمة المرور</h1>
          <p className="text-[12.5px] text-slate-500 mt-1.5 leading-relaxed">
            كلمة المرور المؤقتة المرسلة مع النسخة صارت معروفة وستُستخدم إن سُرّبت.
            اختر كلمة خاصة بك قبل فتح النظام.
          </p>
        </header>

        <form onSubmit={submit} className="surface-card p-6 space-y-4">
          <Field label="المستخدم" value={username} disabled />
          <Field label="كلمة المرور الحالية" value={current} onChange={setCurrent}
            type="password" autoComplete="current-password" />
          <Field label="كلمة المرور الجديدة" value={next} onChange={setNext}
            type="password" autoComplete="new-password" />

          <div className="flex items-center gap-1.5">
            {[0, 1, 2, 3].map((i) => (
              <span key={i}
                className={`h-1 flex-1 rounded-full transition-colors ${
                  policy && i < policy.score ? scoreColor : 'bg-slate-200'
                }`} />
            ))}
            {policy && <span className="text-[10.5px] text-slate-400 mr-1">{policy.score}/4</span>}
          </div>

          {policy && policy.problems.length > 0 && (
            <ul className="space-y-1">
              {policy.problems.map((p) => (
                <li key={p} className="text-[11px] text-rose-600 flex items-center gap-1.5">
                  <X size={10} /> {p}
                </li>
              ))}
            </ul>
          )}
          {policy?.ok && (
            <p className="text-[11px] text-brand-600 flex items-center gap-1.5">
              <Check size={11} /> كلمة المرور تحقق الشروط
            </p>
          )}

          <Field label="تأكيد كلمة المرور" value={confirm} onChange={setConfirm}
            type="password" autoComplete="new-password"
            error={confirm.length > 0 && !matches ? 'غير مطابقة' : ''}
            ok={matches && confirm.length > 0} />

          {error && (
            <p className="text-[11.5px] text-rose-600 bg-rose-50 border border-rose-200 rounded-md px-3 py-2 flex items-start gap-1.5">
              <AlertTriangle size={12} className="mt-0.5 shrink-0" /> {error}
            </p>
          )}

          <button type="submit" disabled={!canSubmit}
            className="w-full flex items-center justify-center gap-2 py-2.5 rounded-lg bg-slate-900 text-white text-[12.5px] font-semibold hover:bg-slate-800 disabled:opacity-40 disabled:cursor-not-allowed transition-colors">
            {busy ? <Loader2 size={14} className="animate-spin" />
              : done ? <Check size={14} />
              : <KeyRound size={14} />}
            {done ? 'تم التغيير بنجاح' : busy ? 'جارٍ الحفظ…' : 'حفظ وفتح النظام'}
          </button>

          <button type="button" onClick={onSignOut}
            className="w-full text-[11.5px] text-slate-400 hover:text-slate-700 py-1">
            تسجيل الخروج والعودة لشاشة الدخول
          </button>
        </form>

        <p className="text-[10.5px] text-slate-400 text-center mt-4 flex items-center justify-center gap-1.5">
          <Fingerprint size={11} />
          التخزين: PBKDF2-SHA512 بـ 210,000 دورة وملح فريد لكل مستخدم
        </p>
      </div>
    </div>
  );
};

export default ChangePasswordView;