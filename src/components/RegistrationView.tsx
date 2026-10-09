import React, { useState } from 'react';
import { apiPost } from '../services/dyposApi';
import { PrimaryButton, Field, Input } from './ui/Primitives';
export const RegistrationView: React.FC = () => {
  const [form, setForm] = useState({
    name: '',
    email: '',
    username: '',
    password: '',
    confirmPassword: '',
  });
  const [saving, setSaving] = useState(false);
  const [saved, setSaved] = useState(false);
  const [error, setError] = useState('');

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    if (saving) return;
    if (form.password !== form.confirmPassword) {
      setError('تأكيد كلمة المرور غير متطابق');
      return;
    }
    if (form.password.length < 12) {
      setError('يجب أن تكون كلمة المرور 12 حرفاً أو أكثر');
      return;
    }
    setSaving(true);
    setError('');
    try {
      await apiPost('/api/auth/register', {
        name: form.name.trim(),
        email: form.email.trim(),
        username: form.username.trim(),
        password: form.password,
      });
      setSaved(true);
    } catch (e: any) {
      setError(e.message || 'تعذّر إنشاء الحساب');
    } finally {
      setSaving(false);
    }
  };

  return (
    <div className="space-y-6">
      <div className="text-center">
        <h1 className="text-2xl font-bold text-ink">تسجيل حساب جديد</h1>
        <p className="text-muted mt-1">أنشئ حسابك لإدارة منشأتك التجارية من خلال DyPOS.</p>
      </div>

      {saved ? (
        <div className="rounded-xl border border-ok border-opacity-20 bg-ok-soft p-4 text-sm text-ok-strong">
          <p className="font-bold">تم التسجيل بنجاح</p>
          <p className="mt-1 text-xs">سيرسل المالك بيانات الدخول بعد التفعيل. في الإنتاج يحتاج الحساب موافقة المالك/المدير.</p>
        </div>
      ) : (
        <form className="space-y-5" onSubmit={handleSubmit} noValidate>
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

          <PrimaryButton type="submit" disabled={saving} className="w-full">
            {saving ? 'جارٍ الإنشاء…' : 'إنشاء حساب'}
          </PrimaryButton>

          <p className="text-center text-xs text-faint">
            في الإنتاج، لا توجد تسجيل ذاتي. يُحقن الحساب عبر صفحة <a href="#register-info" className="text-brand font-semibold">المالك/المدير</a>.
          </p>
        </form>
      )}
    </div>
  );
};
