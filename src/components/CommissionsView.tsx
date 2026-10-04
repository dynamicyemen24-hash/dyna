import React, { useCallback, useEffect, useMemo, useState } from 'react';
import { Percent, Plus, Wallet, CheckCheck, TrendingUp } from 'lucide-react';
import { apiPost, apiGet, sar, ListResponse } from '../services/dyposApi';
import {
  ScreenHeader, Pill, Loading, ErrorBox, EmptyState, Toast, Modal,
  Field, Input, Select, PrimaryButton, GhostButton, Stat, Card,
} from './ui/Primitives';

interface Commission {
  id: string;
  employee_id: string;
  employee_name?: string | null;
  period_year: number;
  period_month: number;
  base_amount: number | string;
  rate: number | string;
  amount: number | string;
  status: string;
  paid_at?: string | null;
}

interface Employee { id: string; name: string }

const MONTHS = [
  'يناير', 'فبراير', 'مارس', 'أبريل', 'مايو', 'يونيو',
  'يوليو', 'أغسطس', 'سبتمبر', 'أكتوبر', 'نوفمبر', 'ديسمبر',
];

const now = new Date();

export const CommissionsView: React.FC = () => {
  const [items, setItems] = useState<Commission[]>([]);
  const [employees, setEmployees] = useState<Employee[]>([]);
  const [totals, setTotals] = useState({ accrued: 0, paid: 0 });
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');
  const [toast, setToast] = useState<{ kind: 'ok' | 'err'; msg: string } | null>(null);
  const [year, setYear] = useState(String(now.getFullYear()));
  const [month, setMonth] = useState(String(now.getMonth() + 1));
  const [modal, setModal] = useState(false);
  const [saving, setSaving] = useState(false);
  const [form, setForm] = useState({ employeeId: '', baseAmount: '', rate: '1.5' });

  const load = useCallback(async () => {
    setLoading(true);
    setError('');
    try {
      const [c, e] = await Promise.all([
        apiGet<ListResponse<Commission> & { totals: any }>(
          `/api/db/commissions?year=${year}&month=${month}`,
        ),
        apiGet<{ items: Employee[] }>('/api/db/employees'),
      ]);
      setItems(c.items);
      setTotals(c.totals || { accrued: 0, paid: 0 });
      setEmployees(e.items || []);
    } catch (err: any) {
      setError(err.message || 'تعذّر تحميل العمولات');
    } finally {
      setLoading(false);
    }
  }, [year, month]);

  useEffect(() => { load(); }, [load]);

  const preview = useMemo(() => {
    const base = Number(form.baseAmount) || 0;
    const rate = Number(form.rate) || 0;
    return (base * rate) / 100;
  }, [form.baseAmount, form.rate]);

  const create = async () => {
    if (!form.employeeId) { setToast({ kind: 'err', msg: 'اختر الموظف' }); return; }
    if (Number(form.baseAmount) <= 0) { setToast({ kind: 'err', msg: 'أدخل المبيعات الأساسية' }); return; }
    const emp = employees.find((e) => e.id === form.employeeId);
    setSaving(true);
    try {
      await apiPost('/api/db/commissions', {
        employeeId: form.employeeId,
        employeeName: emp?.name,
        baseAmount: Number(form.baseAmount),
        rate: Number(form.rate),
        periodYear: Number(year),
        periodMonth: Number(month),
      });
      setModal(false);
      setForm({ employeeId: '', baseAmount: '', rate: '1.5' });
      setToast({ kind: 'ok', msg: 'تم احتساب العمولة' });
      load();
    } catch (e: any) {
      setToast({ kind: 'err', msg: e.message });
    } finally {
      setSaving(false);
    }
  };

  const settle = async (c: Commission) => {
    try {
      await apiPost('/api/db/commissions/settle', { ids: [c.id] });
      setToast({ kind: 'ok', msg: 'تم صرف العمولة' });
      load();
    } catch (e: any) {
      setToast({ kind: 'err', msg: e.message });
    }
  };

  const settleAll = async () => {
    const pending = items.filter((c) => c.status !== 'paid').map((c) => c.id);
    if (!pending.length) { setToast({ kind: 'err', msg: 'لا توجد عمولات غير مصروفة' }); return; }
    try {
      await apiPost('/api/db/commissions/settle', { ids: pending });
      setToast({ kind: 'ok', msg: `تم صرف ${pending.length} عمولة` });
      load();
    } catch (e: any) {
      setToast({ kind: 'err', msg: e.message });
    }
  };

  const years = useMemo(() => {
    const y = now.getFullYear();
    return [y, y - 1, y - 2];
  }, []);

  return (
    <div className="space-y-6 animate-in slide-in-from-bottom-4 duration-500">
      <ScreenHeader
        icon={Percent}
        title="نظام العمولات"
        subtitle="احتساب عمولات الموظفين والوكلاء شهرياً مع صرف ومتابعة الأرصدة."
        accent="text-fuchsia-400"
        actions={
          <>
            <GhostButton onClick={settleAll}>
              <CheckCheck size={18} /> صرف الكل
            </GhostButton>
            <PrimaryButton onClick={() => setModal(true)}>
              <Plus size={18} /> عمولة جديدة
            </PrimaryButton>
          </>
        }
      />

      <div className="flex flex-wrap gap-3">
        <Select value={year} onChange={(e) => setYear(e.target.value)} className="w-36">
          {years.map((y) => <option key={y} value={y}>{y}</option>)}
        </Select>
        <Select value={month} onChange={(e) => setMonth(e.target.value)} className="w-44">
          {MONTHS.map((m, i) => <option key={m} value={i + 1}>{m}</option>)}
        </Select>
      </div>

      <div className="grid grid-cols-2 lg:grid-cols-3 gap-4">
        <Stat label="عدد العمولات" value={String(items.length)} icon={Percent} />
        <Stat label="مستحقة (غير مصروفة)" value={sar(totals.accrued)} tone="text-amber-400" icon={Wallet} />
        <Stat label="مصروفة" value={sar(totals.paid)} tone="text-brand-400" icon={CheckCheck} />
      </div>

      <Card className="overflow-hidden">
        {loading ? <Loading /> : error ? <ErrorBox message={error} onRetry={load} />
          : items.length === 0 ? <EmptyState message="لا توجد عمولات لهذه الفترة" />
          : (
            <div className="overflow-x-auto">
              <table className="w-full text-right border-collapse">
                <thead>
                  <tr className="bg-slate-800/30 text-slate-500 text-xs font-black border-b border-slate-800">
                    <th className="p-4">الموظف</th>
                    <th className="p-4">مبيعات الفترة</th>
                    <th className="p-4">نسبة العمولة</th>
                    <th className="p-4">قيمة العمولة</th>
                    <th className="p-4">الحالة</th>
                    <th className="p-4"></th>
                  </tr>
                </thead>
                <tbody className="divide-y divide-slate-800">
                  {items.map((c) => (
                    <tr key={c.id} className="hover:bg-slate-800/20">
                      <td className="p-4 font-bold">
                        {c.employee_name || c.employee_id}
                      </td>
                      <td className="p-4">{sar(c.base_amount)}</td>
                      <td className="p-4 text-fuchsia-400 font-bold">{c.rate}%</td>
                      <td className="p-4 font-black text-fuchsia-300">{sar(c.amount)}</td>
                      <td className="p-4">
                        <Pill tone={c.status === 'paid'
                          ? 'bg-brand-500/10 text-brand-300 border-brand-500/30'
                          : 'bg-amber-500/10 text-amber-300 border-amber-500/30'}>
                          {c.status === 'paid' ? 'مصروفة' : 'مستحقة'}
                        </Pill>
                      </td>
                      <td className="p-4">
                        {c.status !== 'paid' && (
                          <button onClick={() => settle(c)}
                            className="px-3 py-1.5 rounded-lg text-[11px] font-bold bg-fuchsia-600 hover:bg-fuchsia-500 text-white">
                            صرف
                          </button>
                        )}
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
      </Card>

      <Modal open={modal} onClose={() => setModal(false)} title="احتساب عمولة جديدة">
        <div className="grid sm:grid-cols-2 gap-4">
          <div className="sm:col-span-2">
            <Field label="الموظف *">
              <Select value={form.employeeId}
                onChange={(e) => setForm({ ...form, employeeId: e.target.value })}>
                <option value="">— اختر الموظف —</option>
                {employees.map((e) => (
                  <option key={e.id} value={e.id}>{e.name}</option>
                ))}
              </Select>
            </Field>
          </div>
          <Field label="مبيعات الفترة (ر.س) *">
            <Input type="number" min="0" step="0.01" value={form.baseAmount}
              onChange={(e) => setForm({ ...form, baseAmount: e.target.value })} />
          </Field>
          <Field label="نسبة العمولة %">
            <Input type="number" min="0" step="0.01" value={form.rate}
              onChange={(e) => setForm({ ...form, rate: e.target.value })} />
          </Field>
          <div className="sm:col-span-2 bg-fuchsia-500/10 border border-fuchsia-500/25 rounded-xl p-4 flex items-center justify-between">
            <span className="text-sm font-bold text-fuchsia-200">قيمة العمولة المحسوبة</span>
            <span className="text-2xl font-black text-fuchsia-300">{sar(preview)}</span>
          </div>
          <p className="sm:col-span-2 text-xs text-slate-500">
            الفترة: {MONTHS[Number(month) - 1]} {year} — تُحفظ العمولة مرة واحدة لكل موظف في الفترة نفسها.
          </p>
        </div>
        <div className="flex justify-end gap-2 mt-6">
          <GhostButton onClick={() => setModal(false)}>إلغاء</GhostButton>
          <PrimaryButton onClick={create} disabled={saving}>
            {saving ? 'جارٍ الاحتساب…' : 'احتساب'}
          </PrimaryButton>
        </div>
      </Modal>

      {toast && <Toast kind={toast.kind} message={toast.msg} onClose={() => setToast(null)} />}
    </div>
  );
};