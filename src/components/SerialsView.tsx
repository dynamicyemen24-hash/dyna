import React, { useCallback, useEffect, useMemo, useState } from 'react';
import { Hash, Plus, Trash2, Smartphone, ShieldCheck } from 'lucide-react';
import { apiDelete, apiPatch, apiPost, apiGet, fmtDate, ListResponse } from '../services/dyposApi';
import {
  ScreenHeader, Pill, Loading, ErrorBox, EmptyState, Toast, Modal,
  Field, Input, Select, PrimaryButton, GhostButton, Stat, Card,
} from './ui/Primitives';

interface Serial {
  id: string;
  product_id: string;
  product_name?: string | null;
  serial_number: string;
  imei?: string | null;
  status: string;
  warranty_end?: string | null;
  sold_at?: string | null;
  purchased_at?: string | null;
}

interface ProductOpt { id: string; name: string }

const STATUS: Record<string, { label: string; tone: string }> = {
  in_stock: { label: 'متوفر', tone: 'bg-brand-soft text-brand-strong border-brand/30' },
  sold: { label: 'مُباع', tone: 'bg-info-soft text-info-strong border-info/30' },
  returned: { label: 'مُرتجع', tone: 'bg-warn-soft text-warn-strong border-warn/30' },
  defective: { label: 'معيب', tone: 'bg-err-soft text-err-strong border-err/30' },
};

export const SerialsView: React.FC = () => {
  const [items, setItems] = useState<Serial[]>([]);
  const [products, setProducts] = useState<ProductOpt[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');
  const [toast, setToast] = useState<{ kind: 'ok' | 'err'; msg: string } | null>(null);
  const [filter, setFilter] = useState('all');
  const [search, setSearch] = useState('');
  const [modal, setModal] = useState(false);
  const [saving, setSaving] = useState(false);
  const [form, setForm] = useState({ productId: '', serialNumber: '', imei: '', warrantyEnd: '' });

  const load = useCallback(async () => {
    setLoading(true);
    setError('');
    try {
      const [s, p] = await Promise.all([
        apiGet<ListResponse<Serial>>('/api/db/serials'),
        apiGet<{ products: ProductOpt[] }>('/api/db/products'),
      ]);
      setItems(s.items);
      setProducts(p.products || []);
    } catch (e: any) {
      setError(e.message || 'تعذّر تحميل الأرقام التسلسلية');
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => { load(); }, [load]);

  const visible = useMemo(() => {
    const t = search.trim().toLowerCase();
    return items.filter((s) => {
      if (filter !== 'all' && s.status !== filter) return false;
      if (!t) return true;
      return (
        s.serial_number?.toLowerCase().includes(t) ||
        s.imei?.toLowerCase().includes(t) ||
        s.product_name?.toLowerCase().includes(t)
      );
    });
  }, [items, filter, search]);

  const stats = useMemo(() => ({
    total: items.length,
    stock: items.filter((s) => s.status === 'in_stock').length,
    sold: items.filter((s) => s.status === 'sold').length,
    defective: items.filter((s) => s.status === 'defective').length,
  }), [items]);

  const create = async () => {
    if (!form.productId) { setToast({ kind: 'err', msg: 'اختر المنتج' }); return; }
    if (!form.serialNumber.trim()) { setToast({ kind: 'err', msg: 'الرقم التسلسلي مطلوب' }); return; }
    setSaving(true);
    try {
      await apiPost('/api/db/serials', {
        productId: form.productId,
        serialNumber: form.serialNumber.trim(),
        imei: form.imei.trim() || undefined,
        warrantyEnd: form.warrantyEnd || undefined,
      });
      setModal(false);
      setForm({ productId: '', serialNumber: '', imei: '', warrantyEnd: '' });
      setToast({ kind: 'ok', msg: 'تمت إضافة الرقم التسلسلي' });
      load();
    } catch (e: any) {
      setToast({ kind: 'err', msg: e.message });
    } finally {
      setSaving(false);
    }
  };

  const setStatus = async (s: Serial, status: string) => {
    try {
      await apiPatch(`/api/db/serials/${s.id}`, { status });
      setToast({ kind: 'ok', msg: `تم التحديث: ${STATUS[status]?.label || status}` });
      load();
    } catch (e: any) {
      setToast({ kind: 'err', msg: e.message });
    }
  };

  const remove = async (s: Serial) => {
    if (!confirm('حذف هذا الرقم التسلسلي؟')) return;
    try {
      await apiDelete(`/api/db/serials/${s.id}`);
      setToast({ kind: 'ok', msg: 'تم الحذف' });
      load();
    } catch (e: any) {
      setToast({ kind: 'err', msg: e.message });
    }
  };

  return (
    <div className="space-y-6 animate-in slide-in-from-bottom-4 duration-500">
      <ScreenHeader
        icon={Hash}
        title="الأرقام التسلسلية / IMEI"
        subtitle="تتبع القطع الفردية للأجهزة الإلكترونية مع الضمان وحالة البيع."
        accent="text-info-strong"
        actions={<PrimaryButton onClick={() => setModal(true)}><Plus size={18} /> رقم تسلسلي جديد</PrimaryButton>}
      />

      <div className="grid grid-cols-2 lg:grid-cols-4 gap-4">
        <Stat label="إجمالي الأرقام" value={String(stats.total)} icon={Hash} />
        <Stat label="متوفر بالمخزون" value={String(stats.stock)} tone="text-brand" />
        <Stat label="مُباع" value={String(stats.sold)} tone="text-info-strong" icon={Smartphone} />
        <Stat label="معيب" value={String(stats.defective)} tone="text-err-strong" />
      </div>

      <Card className="overflow-hidden">
        <div className="p-4 border-b border-hairline flex flex-wrap gap-3 items-center">
          <Input value={search} onChange={(e) => setSearch(e.target.value)}
            placeholder="ابحث برقم تسلسلي أو IMEI…" className="flex-1 min-w-[200px]" />
          <div className="flex gap-2 flex-wrap">
            {[['all', 'الكل'], ['in_stock', 'متوفر'], ['sold', 'مُباع'],
              ['returned', 'مُرتجع'], ['defective', 'معيب']].map(([k, l]) => (
              <button key={k} onClick={() => setFilter(k)}
                className={`px-3 py-1.5 rounded-lg text-xs font-bold transition-colors ${
                  filter === k ? 'bg-cyan-600 text-white' : 'bg-hairline/40 text-faint hover:bg-hairline'}`}>
                {l}
              </button>
            ))}
          </div>
        </div>

        {loading ? <Loading /> : error ? <ErrorBox message={error} onRetry={load} />
          : visible.length === 0 ? <EmptyState message="لا توجد أرقام تسلسلية" />
          : (
            <div className="overflow-x-auto">
              <table className="w-full text-right border-collapse">
                <thead>
                  <tr className="bg-subtle/30 text-muted text-xs font-black border-b border-hairline">
                    <th className="p-4">الرقم التسلسلي</th>
                    <th className="p-4">IMEI</th>
                    <th className="p-4">المنتج</th>
                    <th className="p-4">الضمان</th>
                    <th className="p-4">الحالة</th>
                    <th className="p-4">إجراء</th>
                    <th className="p-4"></th>
                  </tr>
                </thead>
                <tbody className="divide-y divide-hairline">
                  {visible.map((s) => (
                    <tr key={s.id} className="hover:bg-hairline/60/20">
                      <td className="p-4 font-mono text-xs text-info-strong" dir="ltr">{s.serial_number}</td>
                      <td className="p-4 font-mono text-xs text-faint" dir="ltr">{s.imei || '—'}</td>
                      <td className="p-4 font-bold">{s.product_name || s.product_id}</td>
                      <td className="p-4 text-sm">
                        {s.warranty_end ? (
                          <span className="flex items-center gap-1 text-brand">
                            <ShieldCheck size={13} /> {fmtDate(s.warranty_end)}
                          </span>
                        ) : '—'}
                      </td>
                      <td className="p-4">
                        <Pill tone={(STATUS[s.status] || STATUS.in_stock).tone}>
                          {(STATUS[s.status] || STATUS.in_stock).label}
                        </Pill>
                      </td>
                      <td className="p-4">
                        <Select value={s.status} onChange={(e) => setStatus(s, e.target.value)}
                          className="!py-1 !text-xs w-28">
                          {Object.entries(STATUS).map(([k, v]) => (
                            <option key={k} value={k}>{v.label}</option>
                          ))}
                        </Select>
                      </td>
                      <td className="p-4">
                        <button onClick={() => remove(s)}
                          className="p-2 rounded-lg text-faint hover:text-err-strong" aria-label="حذف">
                          <Trash2 size={16} />
                        </button>
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
      </Card>

      <Modal open={modal} onClose={() => setModal(false)} title="رقم تسلسلي جديد">
        <div className="grid sm:grid-cols-2 gap-4">
          <div className="sm:col-span-2">
            <Field label="المنتج *">
              <Select value={form.productId}
                onChange={(e) => setForm({ ...form, productId: e.target.value })}>
                <option value="">— اختر المنتج —</option>
                {products.map((p) => <option key={p.id} value={p.id}>{p.name}</option>)}
              </Select>
            </Field>
          </div>
          <Field label="الرقم التسلسلي *">
            <Input dir="ltr" value={form.serialNumber}
              onChange={(e) => setForm({ ...form, serialNumber: e.target.value })} />
          </Field>
          <Field label="IMEI">
            <Input dir="ltr" value={form.imei}
              onChange={(e) => setForm({ ...form, imei: e.target.value })} />
          </Field>
          <div className="sm:col-span-2">
            <Field label="نهاية الضمان">
              <Input type="date" value={form.warrantyEnd}
                onChange={(e) => setForm({ ...form, warrantyEnd: e.target.value })} />
            </Field>
          </div>
        </div>
        <div className="flex justify-end gap-2 mt-6">
          <GhostButton onClick={() => setModal(false)}>إلغاء</GhostButton>
          <PrimaryButton onClick={create} disabled={saving}>
            {saving ? 'جارٍ الحفظ…' : 'حفظ'}
          </PrimaryButton>
        </div>
      </Modal>

      {toast && <Toast kind={toast.kind} message={toast.msg} onClose={() => setToast(null)} />}
    </div>
  );
};