import React, { useCallback, useEffect, useMemo, useState } from 'react';
import { Truck, Plus, Trash2, MapPin, PackageCheck } from 'lucide-react';
import { apiDelete, apiPatch, apiPost, apiGet, sar, fmtDateTime, ListResponse } from '../services/dyposApi';
import {
  ScreenHeader, Pill, Loading, ErrorBox, EmptyState, Toast, Modal, ConfirmDialog,
  Field, Input, TextArea, Select, PrimaryButton, GhostButton, Stat, Card,
} from './ui/Primitives';

interface Zone {
  id: string;
  name: string;
  fee: number | string;
  minimum_order_amount: number | string;
  estimated_minutes: number;
}

interface Delivery {
  id: string;
  customer_name: string;
  customer_phone?: string | null;
  address: string;
  zone_name?: string | null;
  driver_name?: string | null;
  status: string;
  fee: number | string;
  amount_due: number | string;
  estimated_minutes?: number | null;
  delivered_at?: string | null;
  created_at: string;
}

const FLOW: Record<string, { label: string; tone: string; next?: string; nextLabel?: string }> = {
  pending: { label: 'بانتظار الإسناد', tone: 'bg-subtle text-faint border-hairline', next: 'assigned', nextLabel: 'إسناد للسائق' },
  assigned: { label: 'مُسند', tone: 'bg-info-soft text-info-strong border-info/30', next: 'picked_up', nextLabel: 'استلام' },
  picked_up: { label: 'تم الاستلام', tone: 'bg-warn-soft text-warn-strong border-warn/30', next: 'on_the_way', nextLabel: 'في الطريق' },
  on_the_way: { label: 'في الطريق', tone: 'bg-violet-500/10 text-violet-300 border-violet-500/30', next: 'delivered', nextLabel: 'تسليم' },
  delivered: { label: 'مُسلّم', tone: 'bg-brand-soft text-brand-strong border-brand/30' },
  cancelled: { label: 'ملغي', tone: 'bg-err-soft text-err-strong border-err/30' },
};

export const DeliveryView: React.FC = () => {
  const [items, setItems] = useState<Delivery[]>([]);
  const [zones, setZones] = useState<Zone[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');
  const [toast, setToast] = useState<{ kind: 'ok' | 'err'; msg: string } | null>(null);
  const [filter, setFilter] = useState('all');
  const [modal, setModal] = useState(false);
  const [saving, setSaving] = useState(false);
  /* Delivery order awaiting confirmation before it is destroyed. */
  const [pendingDelete, setPendingDelete] = useState<Delivery | null>(null);
  const [form, setForm] = useState({
    customerName: '', customerPhone: '', address: '',
    zoneId: '', amountDue: '', driverName: '', notes: '',
  });

  const load = useCallback(async () => {
    setLoading(true);
    setError('');
    try {
      const [d, z] = await Promise.all([
        apiGet<ListResponse<Delivery>>('/api/db/deliveries'),
        apiGet<ListResponse<Zone>>('/api/db/delivery-zones'),
      ]);
      setItems(d.items);
      setZones(z.items);
    } catch (e: any) {
      setError(e.message || 'تعذّر تحميل طلبات التوصيل');
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => { load(); }, [load]);

  const visible = useMemo(
    () => (filter === 'all' ? items : items.filter((d) => d.status === filter)),
    [items, filter],
  );

  const selectedZone = useMemo(
    () => zones.find((z) => z.id === form.zoneId),
    [zones, form.zoneId],
  );

  const stats = useMemo(() => ({
    total: items.length,
    active: items.filter((d) => !['delivered', 'cancelled'].includes(d.status)).length,
    delivered: items.filter((d) => d.status === 'delivered').length,
    fees: items.filter((d) => d.status === 'delivered')
      .reduce((s, d) => s + Number(d.fee || 0), 0),
  }), [items]);

  const create = async () => {
    if (!form.customerName.trim()) { setToast({ kind: 'err', msg: 'اسم العميل مطلوب' }); return; }
    if (!form.address.trim()) { setToast({ kind: 'err', msg: 'العنوان مطلوب' }); return; }
    setSaving(true);
    try {
      await apiPost('/api/db/deliveries', {
        customerName: form.customerName.trim(),
        customerPhone: form.customerPhone.trim() || undefined,
        address: form.address.trim(),
        zoneId: form.zoneId || undefined,
        amountDue: Number(form.amountDue) || 0,
        driverName: form.driverName.trim() || undefined,
        notes: form.notes.trim() || undefined,
      });
      setModal(false);
      setForm({ ...form, customerName: '', customerPhone: '', address: '', amountDue: '', driverName: '', notes: '' });
      setToast({ kind: 'ok', msg: 'تم إنشاء طلب التوصيل' });
      load();
    } catch (e: any) {
      setToast({ kind: 'err', msg: e.message });
    } finally {
      setSaving(false);
    }
  };

  const advance = async (d: Delivery) => {
    const f = FLOW[d.status];
    if (!f?.next) return;
    try {
      await apiPatch(`/api/db/deliveries/${d.id}/status`, { status: f.next });
      setToast({ kind: 'ok', msg: `تم التحديث: ${FLOW[f.next!].label}` });
      load();
    } catch (e: any) {
      setToast({ kind: 'err', msg: e.message });
    }
  };

  const remove = (d: Delivery) => setPendingDelete(d);

  const confirmDelete = async () => {
    const target = pendingDelete;
    setPendingDelete(null);
    if (!target) return;
    try {
      await apiDelete(`/api/db/deliveries/${target.id}`);
      setToast({ kind: 'ok', msg: 'تم الحذف' });
      load();
    } catch (e: any) {
      setToast({ kind: 'err', msg: e.message });
    }
  };

  return (
    <div className="space-y-6 animate-in slide-in-from-bottom-4 duration-500">
      <ScreenHeader
        icon={Truck}
        title="إدارة التوصيل"
        subtitle="إنشاء طلبات التوصيل وتتبّعها من الإنشاء حتى التسليم مع مناطق وأرسوم."
        accent="text-teal-400"
        actions={<PrimaryButton onClick={() => setModal(true)}><Plus size={18} /> طلب توصيل جديد</PrimaryButton>}
      />

      <div className="grid grid-cols-2 lg:grid-cols-4 gap-4">
        <Stat label="إجمالي الطلبات" value={String(stats.total)} icon={Truck} />
        <Stat label="قيد التنفيذ" value={String(stats.active)} tone="text-warn-strong" />
        <Stat label="مُسلّمة" value={String(stats.delivered)} tone="text-brand" icon={PackageCheck} />
        <Stat label="أرسوم مُحصّلة" value={sar(stats.fees)} tone="text-teal-400" />
      </div>

      <Card className="overflow-hidden">
        <div className="p-4 border-b border-hairline flex flex-wrap gap-2">
          {[['all', 'الكل'], ['pending', 'بانتظار'], ['assigned', 'مُسند'],
            ['on_the_way', 'في الطريق'], ['delivered', 'مُسلّم']].map(([k, l]) => (
            <button key={k} onClick={() => setFilter(k)}
              className={`px-3.5 py-1.5 rounded-lg text-xs font-bold transition-colors ${
                filter === k ? 'bg-teal-600 text-white' : 'bg-hairline/40 text-faint hover:bg-hairline'}`}>
              {l}
            </button>
          ))}
        </div>

        {loading ? <Loading /> : error ? <ErrorBox message={error} onRetry={load} />
          : visible.length === 0 ? <EmptyState message="لا توجد طلبات توصيل" />
          : (
            <div className="divide-y divide-hairline">
              {visible.map((d) => {
                const f = FLOW[d.status] || FLOW.pending;
                return (
                  <div key={d.id} className="p-4 flex flex-wrap items-center gap-4 hover:bg-hairline/60/20">
                    <div className="flex-1 min-w-[220px]">
                      <div className="flex items-center gap-2 flex-wrap">
                        <span className="font-bold">{d.customer_name}</span>
                        {d.customer_phone && (
                          <span className="text-xs text-muted" dir="ltr">{d.customer_phone}</span>
                        )}
                      </div>
                      <p className="text-xs text-faint mt-1 flex items-center gap-1">
                        <MapPin size={12} className="shrink-0" />
                        <span className="truncate">{d.address}</span>
                      </p>
                      <p className="text-[11px] text-muted mt-1">
                        {d.zone_name ? `${d.zone_name} · ` : ''}
                        {d.driver_name ? `السائق: ${d.driver_name}` : 'لم يُسند سائق'}
                        {d.estimated_minutes ? ` · ~${d.estimated_minutes} دقيقة` : ''}
                      </p>
                    </div>
                    <div className="text-left">
                      <p className="font-black text-teal-400">{sar(d.amount_due)}</p>
                      <p className="text-[11px] text-muted">رسوم: {sar(d.fee)}</p>
                    </div>
                    <div className="flex items-center gap-3">
                      <Pill tone={f.tone}>{f.label}</Pill>
                      {f.next && (
                        <button onClick={() => advance(d)}
                          className="px-3 py-1.5 rounded-lg text-[11px] font-bold bg-teal-600 hover:bg-teal-500 text-white">
                          {f.nextLabel}
                        </button>
                      )}
                      <button onClick={() => remove(d)}
                        className="p-2 rounded-lg text-faint hover:text-err-strong"
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

      <Modal open={modal} onClose={() => setModal(false)} title="طلب توصيل جديد">
        <div className="grid sm:grid-cols-2 gap-4">
          <Field label="اسم العميل *">
            <Input value={form.customerName}
              onChange={(e) => setForm({ ...form, customerName: e.target.value })} />
          </Field>
          <Field label="رقم الجوال">
            <Input dir="ltr" value={form.customerPhone}
              onChange={(e) => setForm({ ...form, customerPhone: e.target.value })} />
          </Field>
          <div className="sm:col-span-2">
            <Field label="العنوان *">
              <TextArea value={form.address}
                onChange={(e) => setForm({ ...form, address: e.target.value })} />
            </Field>
          </div>
          <Field label="منطقة التوصيل"
            hint={selectedZone
              ? `رسوم ${sar(selectedZone.fee)} · الحد الأدنى ${sar(selectedZone.minimum_order_amount)}`
              : 'تُحتسب الرسوم تلقائياً من المنطقة'}>
            <Select value={form.zoneId}
              onChange={(e) => setForm({ ...form, zoneId: e.target.value })}>
              <option value="">— بدون منطقة —</option>
              {zones.map((z) => (
                <option key={z.id} value={z.id}>
                  {z.name} ({sar(z.fee)})
                </option>
              ))}
            </Select>
          </Field>
          <Field label="المبلغ المستحق (ر.س)">
            <Input type="number" min="0" step="0.01" value={form.amountDue}
              onChange={(e) => setForm({ ...form, amountDue: e.target.value })} />
          </Field>
          <Field label="اسم السائق">
            <Input value={form.driverName}
              onChange={(e) => setForm({ ...form, driverName: e.target.value })} />
          </Field>
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
            {saving ? 'جارٍ الإنشاء…' : 'إنشاء الطلب'}
          </PrimaryButton>
        </div>
      </Modal>

      {toast && <Toast kind={toast.kind} message={toast.msg} onClose={() => setToast(null)} />}

      <ConfirmDialog
        open={pendingDelete !== null}
        title="حذف طلب توصيل"
        message={pendingDelete ? `سيتم حذف طلب التوصيل الخاص بـ «${pendingDelete.customer_name}» نهائياً.` : ''}
        confirmLabel="حذف"
        tone="err"
        onConfirm={confirmDelete}
        onCancel={() => setPendingDelete(null)}
      />
    </div>
  );
};