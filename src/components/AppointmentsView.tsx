import React, { useCallback, useEffect, useMemo, useState } from 'react';
import { Calendar, Plus, Trash2, Clock, CheckCircle2, PlayCircle } from 'lucide-react';
import {
  apiDelete, apiPatch, apiPost, apiGet, sar, fmtDateTime, ListResponse,
} from '../services/dyposApi';
import {
  ScreenHeader, Pill, Loading, ErrorBox, EmptyState, Toast, Modal,
  Field, Input, TextArea, Select, PrimaryButton, GhostButton, Stat, Card,
} from './ui/Primitives';

interface Appointment {
  id: string;
  service_name?: string | null;
  employee_name?: string | null;
  customer_name: string;
  customer_phone?: string | null;
  scheduled_start: string;
  scheduled_end: string;
  status: string;
  price: number | string;
  notes?: string | null;
}

interface ServiceOpt {
  id: string;
  name: string;
  base_price: number | string;
  duration_minutes: number;
  is_active?: boolean;
}

const STATUS: Record<string, { label: string; tone: string; next?: string }> = {
  scheduled: { label: 'مجدول', tone: 'bg-info-soft text-info-strong border-info/30', next: 'confirmed' },
  confirmed: { label: 'مؤكد', tone: 'bg-violet-500/10 text-violet-300 border-violet-500/30', next: 'in_progress' },
  in_progress: { label: 'قيد التنفيذ', tone: 'bg-warn-soft text-warn-strong border-warn/30', next: 'completed' },
  completed: { label: 'مكتمل', tone: 'bg-brand-soft text-brand-strong border-brand/30' },
  cancelled: { label: 'ملغي', tone: 'bg-subtle text-muted border-hairline' },
  no_show: { label: 'لم يحضر', tone: 'bg-err-soft text-err-strong border-err/30' },
};

const toLocalInput = (d: Date) => {
  const off = d.getTimezoneOffset();
  return new Date(d.getTime() - off * 60000).toISOString().slice(0, 16);
};

export const AppointmentsView: React.FC = () => {
  const [items, setItems] = useState<Appointment[]>([]);
  const [services, setServices] = useState<ServiceOpt[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');
  const [toast, setToast] = useState<{ kind: 'ok' | 'err'; msg: string } | null>(null);
  const [filter, setFilter] = useState('all');
  const [modal, setModal] = useState(false);
  const [saving, setSaving] = useState(false);
  const [form, setForm] = useState({
    serviceId: '', customerName: '', customerPhone: '',
    start: toLocalInput(new Date(Date.now() + 3600_000)), notes: '',
  });

  const load = useCallback(async () => {
    setLoading(true);
    setError('');
    try {
      const [a, s] = await Promise.all([
        apiGet<ListResponse<Appointment>>('/api/db/appointments'),
        apiGet<ListResponse<ServiceOpt>>('/api/db/services'),
      ]);
      setItems(a.items);
      setServices(s.items.filter((x) => x.is_active !== false));
    } catch (e: any) {
      setError(e.message || 'تعذّر تحميل المواعيد');
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => { load(); }, [load]);

  const visible = useMemo(
    () => (filter === 'all' ? items : items.filter((a) => a.status === filter)),
    [items, filter],
  );

  const counts = useMemo(() => {
    const today = new Date().toDateString();
    return {
      today: items.filter((a) => new Date(a.scheduled_start).toDateString() === today).length,
      pending: items.filter((a) => a.status === 'scheduled' || a.status === 'confirmed').length,
      done: items.filter((a) => a.status === 'completed').length,
      revenue: items
        .filter((a) => a.status === 'completed')
        .reduce((sum, a) => sum + Number(a.price || 0), 0),
    };
  }, [items]);

  const create = async () => {
    if (!form.serviceId) { setToast({ kind: 'err', msg: 'اختر الخدمة المطلوبة' }); return; }
    if (!form.customerName.trim()) { setToast({ kind: 'err', msg: 'اسم العميل مطلوب' }); return; }
    setSaving(true);
    try {
      await apiPost('/api/db/appointments', {
        serviceId: form.serviceId,
        customerName: form.customerName.trim(),
        customerPhone: form.customerPhone.trim() || undefined,
        scheduledStart: new Date(form.start).toISOString(),
        notes: form.notes.trim() || undefined,
      });
      setModal(false);
      setForm({ ...form, customerName: '', customerPhone: '', notes: '' });
      setToast({ kind: 'ok', msg: 'تم حجز الموعد' });
      load();
    } catch (e: any) {
      setToast({ kind: 'err', msg: e.message });
    } finally {
      setSaving(false);
    }
  };

  const advance = async (a: Appointment) => {
    const s = STATUS[a.status];
    if (!s?.next) return;
    try {
      await apiPatch(`/api/db/appointments/${a.id}/status`, { status: s.next });
      setToast({ kind: 'ok', msg: `تم تحديث الموعد إلى: ${STATUS[s.next!].label}` });
      load();
    } catch (e: any) {
      setToast({ kind: 'err', msg: e.message });
    }
  };

  const cancel = async (a: Appointment) => {
    try {
      await apiPatch(`/api/db/appointments/${a.id}/status`, { status: 'cancelled' });
      setToast({ kind: 'ok', msg: 'تم إلغاء الموعد' });
      load();
    } catch (e: any) {
      setToast({ kind: 'err', msg: e.message });
    }
  };

  const remove = async (a: Appointment) => {
    if (!confirm('حذف هذا الموعد؟')) return;
    try {
      await apiDelete(`/api/db/appointments/${a.id}`);
      setToast({ kind: 'ok', msg: 'تم حذف الموعد' });
      load();
    } catch (e: any) {
      setToast({ kind: 'err', msg: e.message });
    }
  };

  return (
    <div className="space-y-6 animate-in slide-in-from-bottom-4 duration-500">
      <ScreenHeader
        icon={Calendar}
        title="نظام المواعيد"
        subtitle="جدولة الخدمات والعملاء مع تتبع حالة كل موعد حتى الإتمام."
        accent="text-violet-400"
        actions={<PrimaryButton onClick={() => setModal(true)}><Plus size={18} /> حجز موعد</PrimaryButton>}
      />

      <div className="grid grid-cols-2 lg:grid-cols-4 gap-4">
        <Stat label="مواعيد اليوم" value={String(counts.today)} icon={Calendar} />
        <Stat label="قيد الانتظار" value={String(counts.pending)} tone="text-info-strong" icon={Clock} />
        <Stat label="مكتملة" value={String(counts.done)} tone="text-brand" icon={CheckCircle2} />
        <Stat label="إيراد مُنجز" value={sar(counts.revenue)} tone="text-violet-400" />
      </div>

      <Card className="overflow-hidden">
        <div className="p-4 border-b border-hairline flex flex-wrap gap-2">
          {[['all', 'الكل'], ['scheduled', 'مجدولة'], ['confirmed', 'مؤكدة'],
            ['in_progress', 'جارية'], ['completed', 'مكتملة'], ['cancelled', 'ملغاة']].map(([k, l]) => (
            <button key={k} onClick={() => setFilter(k)}
              className={`px-3.5 py-1.5 rounded-lg text-xs font-bold transition-colors ${
                filter === k
                  ? 'bg-violet-600 text-white'
                  : 'bg-subtle text-faint hover:bg-hairline'}`}>
              {l}
            </button>
          ))}
        </div>

        {loading ? <Loading /> : error ? <ErrorBox message={error} onRetry={load} />
          : visible.length === 0 ? <EmptyState message="لا توجد مواعيد" />
          : (
            <div className="divide-y divide-hairline">
              {visible.map((a) => {
                const st = STATUS[a.status] || STATUS.scheduled;
                return (
                  <div key={a.id} className="p-4 flex flex-wrap items-center gap-4 hover:bg-hairline/60/20">
                    <div className="w-14 text-center shrink-0">
                      <p className="text-2xl font-black text-violet-400">
                        {new Date(a.scheduled_start).getDate()}
                      </p>
                      <p className="text-[10px] text-muted">
                        {new Date(a.scheduled_start).toLocaleDateString('ar-SA', { month: 'short' })}
                      </p>
                    </div>
                    <div className="flex-1 min-w-[200px]">
                      <div className="flex items-center gap-2 flex-wrap">
                        <span className="font-bold">{a.customer_name}</span>
                        {a.customer_phone && (
                          <span className="text-xs text-muted" dir="ltr">{a.customer_phone}</span>
                        )}
                      </div>
                      <p className="text-xs text-faint mt-1 flex items-center gap-2 flex-wrap">
                        <span className="text-violet-300">{a.service_name || 'خدمة'}</span>
                        <span>· {fmtDateTime(a.scheduled_start)}</span>
                        {a.employee_name && <span>· {a.employee_name}</span>}
                      </p>
                      {a.notes && <p className="text-[11px] text-muted mt-1">{a.notes}</p>}
                    </div>
                    <div className="flex items-center gap-3">
                      <span className="font-black text-sm">{sar(a.price)}</span>
                      <Pill tone={st.tone}>{st.label}</Pill>
                      {st.next && (
                        <button onClick={() => advance(a)} title="الحالة التالية"
                          className="p-2 rounded-lg text-brand hover:bg-hairline/60 transition-colors"
                          aria-label="تحديث الحالة">
                          <PlayCircle size={17} />
                        </button>
                      )}
                      {a.status !== 'cancelled' && a.status !== 'completed' && (
                        <button onClick={() => cancel(a)}
                          className="px-2 py-1 rounded-lg text-[11px] text-warn-strong hover:bg-hairline/60">
                          إلغاء
                        </button>
                      )}
                      <button onClick={() => remove(a)}
                        className="p-2 rounded-lg text-faint hover:text-err-strong hover:bg-hairline/60"
                        aria-label="حذف">
                        <Trash2 size={16} />
                      </button>
                    </div>
                  </div>
                );
              })}
            </div>
          )}
      </Card>

      <Modal open={modal} onClose={() => setModal(false)} title="حجز موعد جديد">
        <div className="grid sm:grid-cols-2 gap-4">
          <div className="sm:col-span-2">
            <Field label="الخدمة *">
              <Select value={form.serviceId}
                onChange={(e) => setForm({ ...form, serviceId: e.target.value })}>
                <option value="">— اختر الخدمة —</option>
                {services.map((s) => (
                  <option key={s.id} value={s.id}>
                    {s.name} ({sar(s.base_price)} · {s.duration_minutes} د)
                  </option>
                ))}
              </Select>
            </Field>
          </div>
          <Field label="اسم العميل *">
            <Input value={form.customerName}
              onChange={(e) => setForm({ ...form, customerName: e.target.value })} />
          </Field>
          <Field label="رقم الجوال">
            <Input dir="ltr" value={form.customerPhone}
              onChange={(e) => setForm({ ...form, customerPhone: e.target.value })} />
          </Field>
          <div className="sm:col-span-2">
            <Field label="موعد البدء *" hint="يُحسب وقت الانتهاء تلقائياً من مدة الخدمة">
              <Input type="datetime-local" value={form.start}
                onChange={(e) => setForm({ ...form, start: e.target.value })} />
            </Field>
          </div>
          <div className="sm:col-span-2">
            <Field label="ملاحظات">
              <TextArea value={form.notes}
                onChange={(e) => setForm({ ...form, notes: e.target.value })} />
            </Field>
          </div>
        </div>
        <div className="flex justify-end gap-2 mt-6">
          <GhostButton onClick={() => setModal(false)}>إلغاء</GhostButton>
          <PrimaryButton onClick={create} disabled={saving}>
            {saving ? 'جارٍ الحجز…' : 'تأكيد الحجز'}
          </PrimaryButton>
        </div>
      </Modal>

      {toast && <Toast kind={toast.kind} message={toast.msg} onClose={() => setToast(null)} />}
    </div>
  );
};