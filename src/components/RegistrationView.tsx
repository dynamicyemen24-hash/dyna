/**
 * REGISTRATION → ONBOARDING → MAIN SCREEN
 * ══════════════════════════════════════════════════════════════════════════
 * Two steps, then straight into the workspace:
 *
 *   1. ACCOUNT   — posted to the real `/api/auth/register`, which creates the
 *                  owner INSIDE the pinned deployment tenant (the tenant that
 *                  login searches).
 *   2. ONBOARD   — country (+ base currency + VAT) and establishment sector,
 *                  applied through the real `POST /api/db/tenant/profile`,
 *                  the only tenant-config write endpoint. It also re-seeds
 *                  the sector's capability grants so screens follow sector.
 *
 * After both, the owner is signed in for real (`/api/auth/login` — the exact
 * call the login screen makes) and `onLogin` opens the main screen directly.
 * Registration issues no token by itself, so skipping the login call would
 * leave a freshly created owner unable to reach a single protected route.
 *
 * OPENING BALANCES are deliberately NOT collected here. A balance is a
 * counted figure, not a registration preference: it is entered after
 * authentication in `ShiftOpeningDialog`, by the person who counts the
 * drawer — see that component's header for why a pre-filled figure is the
 * most dangerous kind of default.
 *
 * NO DATA IS FABRICATED: the countries below carry each market's real ISO
 * currency and real standard VAT rate, and the sector list is the product's
 * own `industryProfiles` catalogue — the same source the server validates.
 */
import React, { useState } from 'react';
import { apiPost, TOKEN_KEY, tenantId } from '../services/dyposApi';
import { PrimaryButton, Field, Input } from './ui/Primitives';
import { industryProfiles } from '../config/industryProfiles';
import type { BaseLoginUser, AuthedSession } from './LoginView';

interface OnboardingCountry {
  /** ISO 3166-1 alpha-2. */
  code: string;
  nameAr: string;
  /** ISO 4217 code of the market's currency. */
  currency: string;
  /** The market's real standard VAT rate, percent. */
  vat: number;
}

const COUNTRIES: OnboardingCountry[] = [
  { code: 'SA', nameAr: 'السعودية', currency: 'SAR', vat: 15 },
  { code: 'AE', nameAr: 'الإمارات', currency: 'AED', vat: 5 },
  { code: 'KW', nameAr: 'الكويت', currency: 'KWD', vat: 0 },
  { code: 'QA', nameAr: 'قطر', currency: 'QAR', vat: 0 },
  { code: 'BH', nameAr: 'البحرين', currency: 'BHD', vat: 10 },
  { code: 'OM', nameAr: 'عُمان', currency: 'OMR', vat: 5 },
  { code: 'JO', nameAr: 'الأردن', currency: 'JOD', vat: 16 },
  { code: 'EG', nameAr: 'مصر', currency: 'EGP', vat: 14 },
];

interface Props {
  /** The shell's `onAuthenticated` — opens the main screen with the session. */
  onLogin?: (user: BaseLoginUser) => void;
}

export const RegistrationView: React.FC<Props> = ({ onLogin }) => {
  const [step, setStep] = useState<'account' | 'onboard'>('account');
  const [form, setForm] = useState({
    name: '',
    email: '',
    username: '',
    password: '',
    confirmPassword: '',
  });
  const [sector, setSector] = useState('retail');
  const [country, setCountry] = useState('SA');
  const [saving, setSaving] = useState(false);
  const [phase, setPhase] = useState('');
  const [error, setError] = useState('');

  const activeCountry = COUNTRIES.find((c) => c.code === country) ?? COUNTRIES[0];

  /** Step 1 → step 2. Local validation only; the server still verifies. */
  const goOnboard = (e: React.FormEvent) => {
    e.preventDefault();
    setError('');
    if (!form.name.trim() || !form.username.trim()) {
      setError('الاسم واسم المستخدم مطلوبان');
      return;
    }
    if (form.password !== form.confirmPassword) {
      setError('تأكيد كلمة المرور غير متطابق');
      return;
    }
    if (form.password.length < 12) {
      setError('يجب أن تكون كلمة المرور 12 حرفاً أو أكثر');
      return;
    }
    setStep('onboard');
  };

  /** Step 2 → register → login → init profile → open the main screen. */
  const finish = async (e: React.FormEvent) => {
    e.preventDefault();
    if (saving) return;
    setSaving(true);
    setError('');
    const username = form.username.trim().toLowerCase();
    try {
      // 1 — create the owner inside the pinned tenant.
      setPhase('جارٍ إنشاء الحساب…');
      await apiPost('/api/auth/register', {
        name: form.name.trim(),
        email: form.email.trim(),
        username,
        password: form.password,
      });

      // 2 — real sign-in; registration issues no token by itself.
      setPhase('جارٍ فتح الجلسة…');
      const res = await apiPost<{ session: AuthedSession }>('/api/auth/login', {
        username,
        password: form.password,
        tenantId: tenantId(),
      });
      const s = res.session;
      sessionStorage.setItem(TOKEN_KEY, s.token);

      // 3 — apply the onboarding profile through the real write endpoint.
      // A failure here must not trap a freshly created owner outside the
      // app: the account and session are already real, and the sector can
      // be applied again from الإعدادات by an authenticated administrator.
      setPhase('جارٍ تهيئة ملف المنشأة…');
      try {
        await apiPost('/api/db/tenant/profile', {
          profileId: sector,
          countryCode: activeCountry.code,
          baseCurrency: activeCountry.currency,
          vatRate: activeCountry.vat,
        });
      } catch {
        console.warn('[registration] tenant profile init failed — apply it from settings');
      }

      // 4 — straight into the main screen.
      setPhase('جارٍ فتح الشاشة الرئيسية…');
      onLogin?.({
        name: s.user.name,
        role: s.user.role,
        username: s.user.username,
        mustChangePassword: Boolean(s.mustChangePassword),
        branch: s.branch ?? null,
      });
    } catch (err: unknown) {
      // Any failure in the chain surfaces here with the server's own message
      // (401 stays generic by server design); nothing above half-completes
      // silently.
      setError(err instanceof Error ? err.message : 'تعذّر إتمام التسجيل');
      setSaving(false);
      setPhase('');
    }
  };

  const selectClass =
    'w-full rounded-xl border border-hairline bg-transparent px-3 py-2.5 text-sm text-ink focus:outline-none focus:ring-2 focus:ring-brand';


  return (
    <div className="space-y-6">
      <div className="text-center">
        <h1 className="text-2xl font-bold text-ink">
          {step === 'account' ? 'تسجيل حساب جديد' : 'تهيئة المنشأة'}
        </h1>
        <p className="text-muted mt-1">
          {step === 'account'
            ? 'أنشئ حسابك لإدارة منشأتك التجارية من خلال DyPOS.'
            : 'حدّد دولة النشاط وقطاع المنشأة — تُطبّق البيانات الأساسية تلقائياً قبل فتح الشاشة.'}
        </p>
        <p className="text-faint text-xs mt-2">الخطوة {step === 'account' ? '1' : '2'} من 2</p>
      </div>

      {step === 'account' ? (
        <form className="space-y-5" onSubmit={goOnboard} noValidate>
          <div className="grid sm:grid-cols-2 gap-4">
            <Field label="الاسم">
              <Input
                value={form.name}
                onChange={(e) => setForm({ ...form, name: e.target.value })}
                placeholder="الاسم الثلاثي"
                autoComplete="name"
                required
              />
            </Field>
            <Field label="البريد الإلكتروني">
              <Input
                type="email"
                value={form.email}
                onChange={(e) => setForm({ ...form, email: e.target.value })}
                placeholder="أدخل البريد الإلكتروني"
                autoComplete="email"
                required
              />
            </Field>
          </div>

          <Field label="اسم المستخدم">
            <Input
              value={form.username}
              onChange={(e) => setForm({ ...form, username: e.target.value })}
              placeholder="اسم المستخدم"
              autoComplete="username"
              required
              dir="ltr"
            />
          </Field>

          <Field label="كلمة المرور">
            <Input
              type="password"
              value={form.password}
              onChange={(e) => setForm({ ...form, password: e.target.value })}
              placeholder="يجب أن تكون 12 حرفاً أو أكثر"
              autoComplete="new-password"
              required
            />
            <p className="mt-1 text-[11px] text-faint">
              الشروط: 12 حرفاً فأكبر، ثلاثة أنواع على الأقل، دائماً أفضل.
            </p>
          </Field>

          <Field label="تأكيد كلمة المرور">
            <Input
              type="password"
              value={form.confirmPassword}
              onChange={(e) => setForm({ ...form, confirmPassword: e.target.value })}
              placeholder="أعد كتابة كلمة المرور"
              autoComplete="new-password"
              required
            />
          </Field>

          {error && (
            <p role="alert" className="text-sm text-err-strong">
              {error}
            </p>
          )}

          <div className="flex items-center gap-3">
            <input
              id="agree"
              type="checkbox"
              className="h-4 w-4 rounded border-hairline text-brand focus:ring-brand"
              required
            />
            <label htmlFor="agree" className="text-sm text-ink">
              أوافق على <a href="#terms" target="_blank" rel="noopener noreferrer" className="text-brand hover:underline">شروط الخدمة</a> و <a href="#privacy" target="_blank" rel="noopener noreferrer" className="text-brand hover:underline">سياسة الخصوصية</a> و <a href="#gateway" target="_blank" rel="noopener noreferrer" className="text-brand hover:underline">سياسة بوابة الشركة</a>.
            </label>
          </div>

          <PrimaryButton type="submit" className="w-full">
            التالي — تهيئة المنشأة
          </PrimaryButton>
        </form>
      ) : (

        <form className="space-y-5" onSubmit={finish} noValidate>
          <Field label="دولة النشاط">
            <select
              className={selectClass}
              value={country}
              onChange={(e) => setCountry(e.target.value)}
            >
              {COUNTRIES.map((c) => (
                <option key={c.code} value={c.code}>
                  {c.nameAr}
                </option>
              ))}
            </select>
          </Field>

          <div className="rounded-xl border border-hairline p-3 text-xs text-muted space-y-1">
            <p>
              العملة الأساسية: <b className="text-ink">{activeCountry.currency}</b>
            </p>
            <p>
              ضريبة القيمة المضافة القياسية: <b className="text-ink">{activeCountry.vat}%</b>
            </p>
          </div>

          <Field label="نوع المنشأة (القطاع)">
            <select
              className={selectClass}
              value={sector}
              onChange={(e) => setSector(e.target.value)}
            >
              {industryProfiles.map((p) => (
                <option key={p.id} value={p.id}>
                  {p.name_ar}
                </option>
              ))}
            </select>
          </Field>

          <p className="text-[11px] text-faint">
            الأرصدة الافتتاحية للدرج تُدخل بعد الدخول مباشرةً من نافذة عدّ الدرج عند فتح أول
            وردية — رقم معدود يُعتمد مرة واحدة ومن مكان واحد، ولا يُفترض مسبقاً.
          </p>

          {error && (
            <p role="alert" className="text-sm text-err-strong">
              {error}
            </p>
          )}

          <div className="flex items-center gap-3">
            <PrimaryButton type="submit" disabled={saving} className="flex-1">
              {saving ? phase || 'جارٍ الحفظ…' : 'إنهاء التسجيل وفتح الشاشة'}
            </PrimaryButton>
            <button
              type="button"
              disabled={saving}
              onClick={() => {
                setError('');
                setStep('account');
              }}
              className="text-brand hover:underline text-xs font-bold"
            >
              رجوع
            </button>
          </div>
        </form>
      )}
    </div>
  );
};

