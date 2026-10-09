import React, { useCallback, useEffect, useMemo, useState } from 'react';
import { Clock, Plus, Trash2, AlertTriangle, PackageCheck } from 'lucide-react';
import { apiDelete, apiPost, apiGet, sar, fmtDate, ListResponse } from '../services/dyposApi';
import {
  ScreenHeader, Pill, Loading, ErrorBox, EmptyState, Toast, Modal, ConfirmDialog,
  Field, Input, Select, PrimaryButton, GhostButton, Stat, Card,
} from './ui/Primitives';

interface Batch {
  id: string;
  product_id: string;
  product_name?: string | null;
  unit?: string | null;
  batch_number: string;
  quantity: number | string;
  cost: number | string;
  expiry_date?: string | null;
  production_date?: string | null;
  days_to_expiry?: number | null;
  batch_value?: number | string;
  status: string;
}

interface ProductOpt { id: string; name: string }

const expiryTone = (days?: number | null) => {
  if (days === null || days === undefined) return 'bg-subtle text-faint border-hairline';
  if (days < 0) return 'bg-err-soft text-err-strong border-err/30';
  if (days <= 30) return 'bg-warn-soft text-warn-strong border-warn/30';
  if (days <= 90) return 'bg-yellow-500/10 text-yellow-300 border-yellow-500/30';
  return 'bg-brand-soft text-brand-strong border-brand/30';
};

const expiryLabel = (days?: number | null) => {
  if (days === null || days === undefined) return 'بدون صلاحية';
  if (days < 0) return `منتهية منذ ${Math.abs(days)} يوم`;
  if (days === 0) return 'تنتهي اليوم';
  return `متبقٍ ${days} يوم`;
};

export const BatchesView: React.FC = () => {
  const [items, setItems] = useState<Batch[]>([]);
  const [products, setProducts] = useState<ProductOpt[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');
  const [toast, setToast] = useState<{ kind: 'ok' | 'err'; msg: string } | null>(null);
  const [filter, setFilter] = useState('all');
  const [modal, setModal] = useState(false);
  const [saving, setSaving] = useState(false);
  /* Batch awaiting confirmation before it is destroyed. */
  const [pendingDelete, setPendingDelete] = useState<Batch | null>(null);
  const [form, setForm] = useState({
    productId: '', batchNumber: '', quantity: '100', cost: '0', expiryDate: '',
  });

  const load = useCallback(async () => {
    setLoading(true);
    setError('');
    try {
      const [b, p] = await Promise.all([
        apiGet<ListResponse<Batch>>('/api/db/batches'),
        apiGet<{ products: ProductOpt[] }>('/api/db/products'),
      ]);
      setItems(b.items);
      setProducts(p.products || []);
    } catch (e: any) {
      setError(e.message || 'تعذّر تحميل التشغيلات');
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => { load(); }, [load]);

  const visible = useMemo(() => {
    if (filter === 'expiring') return items.filter((b) => (b.days_to_expiry ?? 999) <= 30);
    if (filter === 'expired') return items.filter((b) => (b.days_to_expiry ?? 1) < 0);
    return items;
  }, [items, filter]);

  const stats = useMemo(() => ({
    total: items.length,
    expiring: items.filter((b) => (b.days_to_expiry ?? 999) <= 30 && (b.days_to_expiry ?? 1) >= 0).length,
    expired: items.filter((b) => (b.days_to_expiry ?? 1) < 0).length,
    value: items.reduce((s, b) => s + Number(b.batch_value || 0), 0),
  }), [items]);

  const create = async () => {
    if (!form.productId) { setToast({ kind: 'err', msg: 'اختر المنتج' }); return; }
    if (!form.batchNumber.trim()) { setToast({ kind: 'err', msg: 'رقم التشغيلة مطلوب' }); return; }
    setSaving(true);
    try {
      await apiPost('/api/db/batches', {
        productId: form.productId,
        batchNumber: form.batchNumber.trim(),
        quantity: Number(form.quantity) || 0,
        cost: Number(form.cost) || 0,
        expiryDate: form.expiryDate || undefined,
      });
      setModal(false);
      setForm({ ...form, batchNumber: '', expiryDate: '' });
      setToast({ kind: 'ok', msg: 'تمت إضافة التشغيلة' });
      load();
    } catch (e: any) {
      setToast({ kind: 'err', msg: e.message });
    } finally {
      setSaving(false);
    }
  };

  const remove = (b: Batch) => setPendingDelete(b);

  const confirmDelete = async () => {
    const target = pendingDelete;
    setPendingDelete(null);
    if (!target) return;
    try {
      await apiDelete(`/api/db/batches/${target.id}`);
      setToast({ kind: 'ok', msg: 'تم الحذف' });
      load();
    } catch (e: any) {
      setToast({ kind: 'err', msg: e.message });
    }
  };

  return (
    <div className="space-y-6 animate-in slide-in-from-bottom-4 duration-500">
      <ScreenHeader
        icon={Clock}
        title="التشغيلات والصلاحية"
        subtitle="تتبع دفعات المخزون مع نظام FEFO وتنبيهات قرب الانتهاء."
        accent="text-warn-strong"
        actions={<PrimaryButton onClick={() => setModal(true)}><Plus size={18} /> تشغيله جديدة</PrimaryButton>}
      />

      <div className="grid grid-cols-2 lg:grid-cols-4 gap-4">
        <Stat label="إجمالي التشغيلات" value={String(stats.total)} icon={PackageCheck} />
        <Stat label="قاربت الانتهاء" value={String(stats.expiring)} tone="text-warn-strong" icon={Clock} />
        <Stat label="منتهية الصلاحية" value={String(stats.expired)} tone="text-err-strong" icon={AlertTriangle} />
        <Stat label="قيمة المخزون" value={sar(stats.value)} tone="text-brand" />
      </div>

      <Card className="overflow-hidden">
        <div className="p-4 border-b border-hairline flex flex-wrap gap-2">
          {[['all', 'الكل'], ['expiring', 'قاربت الانتهاء'], ['expired', 'منتهية']].map(([k, l]) => (
            <button key={k} onClick={() => setFilter(k)}
              className={`px-3.5 py-1.5 rounded-lg text-xs font-bold transition-colors ${
                filter === k ? 'bg-amber-600 text-white' : 'bg-hairline/40 text-faint hover:bg-hairline'}`}>
              {l}
            </button>
          ))}
        </div>

        {loading ? <Loading /> : error ? <ErrorBox message={error} onRetry={load} />
          : visible.length === 0 ? <EmptyState message="لا توجد تشغيلات" />
          : (
            <div className="overflow-x-auto">
              <table className="w-full text-right border-collapse">
                <thead>
                  <tr className="bg-subtle/30 text-muted text-xs font-black border-b border-hairline">
                    <th className="p-4">رقم التشغيلة</th>
                    <th className="p-4">المنتج</th>
                    <th className="p-4">الكمية</th>
                    <th className="p-4">الصلاحية</th>
                    <th className="p-4">الحالة</th>
                    <th className="p-4">القيمة</th>
                    <th className="p-4"></th>
                  </tr>
                </thead>
                <tbody className="divide-y divide-hairline">
                  {visible.map((b) => (
                    <tr key={b.id} className="hover:bg-hairline/60/20">
                      <td className="p-4">
                        <span className="font-mono text-xs bg-subtle px-2 py-1 rounded text-warn-strong" dir="ltr">
                          {b.batch_number}
                        </span>
                      </td>
                      <td className="p-4 font-bold">{b.product_name || b.product_id}</td>
                      <td className="p-4">{b.quantity} {b.unit || ''}</td>
                      <td className="p-4 text-sm">{fmtDate(b.expiry_date)}</td>
                      <td className="p-4">
                        <Pill tone={expiryTone(b.days_to_expiry)}>{expiryLabel(b.days_to_expiry)}</Pill>
                      </td>
                      <td className="p-4 font-bold">{sar(b.batch_value)}</td>
                      <td className="p-4">
                        <button onClick={() => remove(b)}
                          className="p-2 rounded-lg text-faint hover:text-err-strong"
                          aria-label="حذف">
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

      <Modal open={modal} onClose={() => setModal(false)} title="تشغيلة جديدة">
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
          <Field label="رقم التشغيلة *">
            <Input dir="ltr" value={form.batchNumber}
              onChange={(e) => setForm({ ...form, batchNumber: e.target.value })} />
          </Field>
          <Field label="الكمية">
            <Input type="number" min="0" value={form.quantity}
              onChange={(e) => setForm({ ...form, quantity: e.target.value })} />
          </Field>
          <Field label="تكلفة الوحدة">
            <Input type="number" min="0" step="0.0001" value={form.cost}
              onChange={(e) => setForm({ ...form, cost: e.target.value })} />
          </Field>
          <Field label="تاريخ الانتهاء">
            <Input type="date" value={form.expiryDate}
              onChange={(e) => setForm({ ...form, expiryDate: e.target.value })} />
          </Field>
        </div>
        <div className="flex justify-end gap-2 mt-6">
          <GhostButton onClick={() => setModal(false)}>إلغاء</GhostButton>
          <PrimaryButton onClick={create} disabled={saving}>
            {saving ? 'جارٍ الحفظ…' : 'حفظ'}
          </PrimaryButton>
        </div>
      </Modal>

      {toast && <Toast kind={toast.kind} message={toast.msg} onClose={() => setToast(null)} />}

      <ConfirmDialog
        open={pendingDelete !== null}
        title="حذف تشغيلة"
        message={pendingDelete ? `سيتم حذف التشغيلة «${pendingDelete.batch_number}» نهائياً.` : ''}
        confirmLabel="حذف"
        tone="err"
        onConfirm={confirmDelete}
        onCancel={() => setPendingDelete(null)}
      />
    </div>
  );
};