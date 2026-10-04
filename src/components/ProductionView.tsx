import React, { useCallback, useEffect, useMemo, useState } from 'react';
import { Factory, Plus, Trash2, PlayCircle, Boxes, Layers } from 'lucide-react';
import { apiDelete, apiPost, apiGet, ListResponse } from '../services/dyposApi';
import {
  ScreenHeader, Pill, Loading, ErrorBox, EmptyState, Toast, Modal,
  Field, Input, TextArea, Select, PrimaryButton, GhostButton, Stat, Card,
} from './ui/Primitives';

interface ProdOrder {
  id: string;
  product_id: string;
  product_name?: string | null;
  unit?: string | null;
  recipe_id?: string | null;
  quantity: number | string;
  completed_qty: number | string;
  status: string;
  planned_start?: string | null;
  planned_end?: string | null;
  notes?: string | null;
}

interface Component {
  componentId: string;
  componentName?: string | null;
  qty: number | string;
  wastePercent: number | string;
}

interface Recipe {
  id: string;
  product_id: string;
  product_name?: string | null;
  version: number;
  yield_qty: number | string;
  is_active: boolean;
  components: Component[];
}

interface ProductOpt { id: string; name: string; unit?: string | null }

const STATUS: Record<string, { label: string; tone: string }> = {
  draft: { label: 'مسودة', tone: 'bg-slate-800 text-slate-400 border-slate-700' },
  in_progress: { label: 'جاري', tone: 'bg-amber-500/10 text-amber-300 border-amber-500/30' },
  completed: { label: 'مكتمل', tone: 'bg-brand-500/10 text-brand-300 border-brand-500/30' },
  cancelled: { label: 'ملغي', tone: 'bg-rose-500/10 text-rose-300 border-rose-500/30' },
};

export const ProductionView: React.FC = () => {
  const [orders, setOrders] = useState<ProdOrder[]>([]);
  const [recipes, setRecipes] = useState<Recipe[]>([]);
  const [products, setProducts] = useState<ProductOpt[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');
  const [toast, setToast] = useState<{ kind: 'ok' | 'err'; msg: string } | null>(null);
  const [modal, setModal] = useState(false);
  const [saving, setSaving] = useState(false);
  const [busyId, setBusyId] = useState('');
  const [form, setForm] = useState({
    productId: '', recipeId: '', quantity: '10', notes: '',
  });

  const load = useCallback(async () => {
    setLoading(true);
    setError('');
    try {
      const [o, r, p] = await Promise.all([
        apiGet<ListResponse<ProdOrder>>('/api/db/production'),
        apiGet<ListResponse<Recipe>>('/api/db/production/recipes'),
        apiGet<{ products: ProductOpt[] }>('/api/db/products'),
      ]);
      setOrders(o.items);
      setRecipes(r.items);
      setProducts(p.products || []);
    } catch (e: any) {
      setError(e.message || 'تعذّر تحميل بيانات الإنتاج');
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => { load(); }, [load]);

  const selectedRecipe = useMemo(
    () => recipes.find((r) => r.id === form.recipeId),
    [recipes, form.recipeId],
  );

  const stats = useMemo(() => ({
    total: orders.length,
    active: orders.filter((o) => o.status === 'in_progress').length,
    done: orders.filter((o) => o.status === 'completed').length,
    produced: orders
      .filter((o) => o.status === 'completed')
      .reduce((s, o) => s + Number(o.completed_qty || 0), 0),
  }), [orders]);

  const create = async () => {
    if (!form.productId) { setToast({ kind: 'err', msg: 'اختر المنتج المُنتَج' }); return; }
    if (Number(form.quantity) <= 0) { setToast({ kind: 'err', msg: 'الكمية يجب أن تكون أكبر من صفر' }); return; }
    setSaving(true);
    try {
      await apiPost('/api/db/production', {
        productId: form.productId,
        recipeId: form.recipeId || undefined,
        quantity: Number(form.quantity),
        status: 'in_progress',
        notes: form.notes.trim() || undefined,
      });
      setModal(false);
      setForm({ ...form, notes: '' });
      setToast({ kind: 'ok', msg: 'تم إنشاء أمر الإنتاج' });
      load();
    } catch (e: any) {
      setToast({ kind: 'err', msg: e.message });
    } finally {
      setSaving(false);
    }
  };

  const complete = async (o: ProdOrder) => {
    if (!confirm(
      `سيتم استهلاك مكونات الوصفة (FEFO) وإضافة ${o.quantity} من «${o.product_name}» للمخزون. متابعة؟`,
    )) return;
    setBusyId(o.id);
    try {
      const res: any = await apiPost(`/api/db/production/${o.id}/complete`, {
        completedQty: Number(o.quantity),
      });
      const consumed = res.consumed?.length || 0;
      setToast({ kind: 'ok', msg: `تم إتمام الإنتاج — استُهلك ${consumed} مكوّن` });
      load();
    } catch (e: any) {
      setToast({ kind: 'err', msg: e.message });
    } finally {
      setBusyId('');
    }
  };

  const remove = async (o: ProdOrder) => {
    if (!confirm('حذف أمر الإنتاج؟')) return;
    try {
      await apiDelete(`/api/db/production/${o.id}`);
      setToast({ kind: 'ok', msg: 'تم الحذف' });
      load();
    } catch (e: any) {
      setToast({ kind: 'err', msg: e.message });
    }
  };

  return (
    <div className="space-y-6 animate-in slide-in-from-bottom-4 duration-500">
      <ScreenHeader
        icon={Factory}
        title="محرك الإنتاج"
        subtitle="أوامر الإنتاج مع وصفات BOM — الاستهلاك يتبع نظام FEFO ويُسجَّل كحركة مخزون."
        accent="text-orange-400"
        actions={<PrimaryButton onClick={() => setModal(true)}><Plus size={18} /> أمر إنتاج جديد</PrimaryButton>}
      />

      <div className="grid grid-cols-2 lg:grid-cols-4 gap-4">
        <Stat label="إجمالي الأوامر" value={String(stats.total)} icon={Factory} />
        <Stat label="جارية" value={String(stats.active)} tone="text-amber-400" />
        <Stat label="مكتملة" value={String(stats.done)} tone="text-brand-400" />
        <Stat label="وحدات مُنتجة" value={String(stats.produced)} tone="text-orange-400" icon={Boxes} />
      </div>

      <div className="grid lg:grid-cols-3 gap-6">
        <div className="lg:col-span-2">
          <Card className="overflow-hidden">
            <div className="p-4 border-b border-slate-800 font-bold text-sm">أوامر الإنتاج</div>
            {loading ? <Loading /> : error ? <ErrorBox message={error} onRetry={load} />
              : orders.length === 0 ? <EmptyState message="لا توجد أوامر إنتاج" />
              : (
                <div className="divide-y divide-slate-800">
                  {orders.map((o) => {
                    const st = STATUS[o.status] || STATUS.draft;
                    return (
                      <div key={o.id} className="p-4 flex flex-wrap items-center gap-4 hover:bg-slate-800/20">
                        <div className="flex-1 min-w-[180px]">
                          <p className="font-bold">{o.product_name || o.product_id}</p>
                          <p className="text-xs text-slate-500 mt-1">
                            الكمية: <span className="text-orange-400 font-bold">{o.quantity}</span>
                            {o.unit ? ` ${o.unit}` : ''}
                            {o.completed_qty ? ` — أُنتج ${o.completed_qty}` : ''}
                          </p>
                        </div>
                        <Pill tone={st.tone}>{st.label}</Pill>
                        <div className="flex gap-1.5">
                          {o.status !== 'completed' && (
                            <button onClick={() => complete(o)} disabled={busyId === o.id}
                              className="p-2 rounded-lg text-brand-400 hover:bg-slate-800 disabled:opacity-40"
                              title="إتمام الإنتاج" aria-label="إتمام">
                              <PlayCircle size={17} />
                            </button>
                          )}
                          <button onClick={() => remove(o)}
                            className="p-2 rounded-lg text-slate-400 hover:text-rose-400 hover:bg-slate-800"
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
        </div>

        <Card className="p-4">
          <div className="flex items-center gap-2 font-bold text-sm mb-3">
            <Layers size={16} className="text-orange-400" /> الوصفات (BOM)
          </div>
          {recipes.length === 0 ? (
            <p className="text-xs text-slate-500 leading-relaxed py-4">
              لا توجد وصفات مسجّلة بعد. سجّل مكوّنات في جدول
              <span className="text-orange-400"> product_recipe_items </span>
              ليظهر الاستهلاك التلقائي هنا.
            </p>
          ) : (
            <div className="space-y-3 max-h-[420px] overflow-y-auto">
              {recipes.map((r) => (
                <div key={r.id} className="bg-slate-900/80 border border-slate-800 rounded-xl p-3">
                  <p className="font-bold text-sm">{r.product_name || r.product_id}</p>
                  <p className="text-[11px] text-slate-500 mb-2">
                    الإصدار {r.version} • إنتاج {r.yield_qty}
                  </p>
                  {r.components.length === 0 ? (
                    <p className="text-[11px] text-slate-600">بدون مكوّنات</p>
                  ) : (
                    <ul className="space-y-1">
                      {r.components.map((c, i) => (
                        <li key={i} className="text-xs text-slate-400 flex justify-between gap-2">
                          <span className="truncate">{c.componentName || c.componentId}</span>
                          <span className="text-orange-400 shrink-0">
                            {c.qty}{Number(c.wastePercent) ? ` (+${c.wastePercent}%)` : ''}
                          </span>
                        </li>
                      ))}
                    </ul>
                  )}
                </div>
              ))}
            </div>
          )}
        </Card>
      </div>

      <Modal open={modal} onClose={() => setModal(false)} title="أمر إنتاج جديد">
        <div className="grid sm:grid-cols-2 gap-4">
          <Field label="المنتج المُنتَج *">
            <Select value={form.productId}
              onChange={(e) => setForm({ ...form, productId: e.target.value })}>
              <option value="">— اختر المنتج —</option>
              {products.map((p) => <option key={p.id} value={p.id}>{p.name}</option>)}
            </Select>
          </Field>
          <Field label="الكمية المطلوبة *">
            <Input type="number" min="1" value={form.quantity}
              onChange={(e) => setForm({ ...form, quantity: e.target.value })} />
          </Field>
          <div className="sm:col-span-2">
            <Field label="الوصفة (اختياري)"
              hint="عند اختيار وصفة يُحسَب استهلاك المكونات تلقائياً">
              <Select value={form.recipeId}
                onChange={(e) => setForm({ ...form, recipeId: e.target.value })}>
                <option value="">— بلا وصفة —</option>
                {recipes.map((r) => (
                  <option key={r.id} value={r.id}>{r.product_name || r.product_id}</option>
                ))}
              </Select>
            </Field>
          </div>
          {selectedRecipe && selectedRecipe.components.length > 0 && (
            <div className="sm:col-span-2 bg-slate-900/70 border border-slate-800 rounded-xl p-3">
              <p className="text-xs font-bold text-slate-400 mb-2">المكونات المطلوبة</p>
              <ul className="space-y-1">
                {selectedRecipe.components.map((c, i) => {
                  const total = Number(c.qty) * Number(form.quantity || 0) *
                    (1 + Number(c.wastePercent || 0) / 100);
                  return (
                    <li key={i} className="text-xs flex justify-between gap-3">
                      <span className="text-slate-300 truncate">
                        {c.componentName || c.componentId}
                      </span>
                      <span className="text-orange-400 font-bold shrink-0">
                        {Number(c.qty)} × {form.quantity} = {total.toFixed(2)}
                      </span>
                    </li>
                  );
                })}
              </ul>
            </div>
          )}
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
            {saving ? 'جارٍ الإنشاء…' : 'إنشاء الأمر'}
          </PrimaryButton>
        </div>
      </Modal>

      {toast && <Toast kind={toast.kind} message={toast.msg} onClose={() => setToast(null)} />}
    </div>
  );
};