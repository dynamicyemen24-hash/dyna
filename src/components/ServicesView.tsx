import React, { useCallback, useEffect, useMemo, useState } from 'react';
import {
  Scissors, Plus, Search, Pencil, Trash2, Clock, Wallet,
} from 'lucide-react';
import { apiDelete, apiPost, apiPut, apiGet, sar, ListResponse } from '../services/dyposApi';
import {
  ScreenHeader, Pill, Loading, ErrorBox, EmptyState, Toast, Modal,
  Field, Input, TextArea, PrimaryButton, GhostButton, Stat, Card,
} from './ui/Primitives';

interface Service {
  id: string;
  name: string;
  name_en?: string | null;
  category?: string | null;
  description?: string | null;
  base_price: number | string;
  tax_rate: number | string;
  duration_minutes: number;
  is_active: boolean;
}

interface Draft {
  id?: string;
  name: string;
  nameEn: string;
  category: string;
  description: string;
  basePrice: string;
  taxRate: string;
  durationMinutes: string;
  isActive: boolean;
}

const emptyDraft: Draft = {
  name: '', nameEn: '', category: '', description: '',
  basePrice: '0', taxRate: '15', durationMinutes: '30', isActive: true,
};

export const ServicesView: React.FC = () => {
  const [items, setItems] = useState<Service[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');
  const [toast, setToast] = useState<{ kind: 'ok' | 'err'; msg: string } | null>(null);
  const [search, setSearch] = useState('');
  const [onlyActive, setOnlyActive] = useState(false);
  const [modal, setModal] = useState(false);
  const [draft, setDraft] = useState<Draft>(emptyDraft);
  const [saving, setSaving] = useState(false);

  const load = useCallback(async () => {
    setLoading(true);
    setError('');
    try {
      const res = await apiGet<ListResponse<Service>>('/api/db/services');
      setItems(res.items);
    } catch (e: any) {
      setError(e.message || 'تعذّر تحميل الخدمات');
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => { load(); }, [load]);

  const filtered = useMemo(() => {
    const t = search.trim();
    return items.filter((s) => {
      if (onlyActive && !s.is_active) return false;
      if (!t) return true;
      return (
        s.name?.includes(t) ||
        s.name_en?.toLowerCase().includes(t.toLowerCase()) ||
        s.category?.includes(t)
      );
    });
  }, [items, search, onlyActive]);

  const openNew = () => { setDraft(emptyDraft); setModal(true); };

  const openEdit = (s: Service) => {
    setDraft({
      id: s.id,
      name: s.name ?? '',
      nameEn: s.name_en ?? '',
      category: s.category ?? '',
      description: s.description ?? '',
      basePrice: String(s.base_price ?? 0),
      taxRate: String(s.tax_rate ?? 15),
      durationMinutes: String(s.duration_minutes ?? 30),
      isActive: !!s.is_active,
    });
    setModal(true);
  };

  const save = async () => {
    if (!draft.name.trim()) {
      setToast({ kind: 'err', msg: 'اسم الخدمة مطلوب' });
      return;
    }
    setSaving(true);
    try {
      const payload = {
        id: draft.id,
        name: draft.name.trim(),
        nameEn: draft.nameEn.trim() || undefined,
        category: draft.category.trim() || undefined,
        description: draft.description.trim() || undefined,
        basePrice: Number(draft.basePrice) || 0,
        taxRate: Number(draft.taxRate) || 0,
        durationMinutes: Number(draft.durationMinutes) || 0,
        isActive: draft.isActive,
      };
      if (draft.id) await apiPut(`/api/db/services/${draft.id}`, payload);
      else await apiPost('/api/db/services', payload);

      setModal(false);
      setToast({ kind: 'ok', msg: draft.id ? 'تم تحديث الخدمة' : 'تمت إضافة الخدمة' });
      load();
    } catch (e: any) {
      setToast({ kind: 'err', msg: e.message });
    } finally {
      setSaving(false);
    }
  };

  const remove = async (s: Service) => {
    if (!confirm(`حذف الخدمة «${s.name}»؟`)) return;
    try {
      await apiDelete(`/api/db/services/${s.id}`);
      setToast({ kind: 'ok', msg: 'تم حذف الخدمة' });
      load();
    } catch (e: any) {
      setToast({ kind: 'err', msg: e.message });
    }
  };

  const totals = useMemo(() => {
    const active = items.filter((s) => s.is_active);
    return {
      count: items.length,
      active: active.length,
      avgDuration: active.length
        ? Math.round(active.reduce((a, s) => a + (s.duration_minutes || 0), 0) / active.length)
        : 0,
      avgPrice: active.length
        ? active.reduce((a, s) => a + Number(s.base_price || 0), 0) / active.length
        : 0,
    };
  }, [items]);

  // RENDER
  return (
    <div className="space-y-6 animate-in slide-in-from-bottom-4 duration-500">
      <ScreenHeader
        icon={Scissors}
        title="كتالوج الخدمات"
        subtitle="إدارة الخدمات وأسعارها ومدد تنفيذها — تُستخدم في المواعيد وأوامر العمل."
        accent="text-sky-400"
        actions={<PrimaryButton onClick={openNew}><Plus size={18} /> خدمة جديدة</PrimaryButton>}
      />
      <div className="grid grid-cols-2 lg:grid-cols-4 gap-4">
        <Stat label="إجمالي الخدمات" value={String(totals.count)} icon={Scissors} />
        <Stat label="خدمات نشطة" value={String(totals.active)} tone="text-brand-400" />
        <Stat label="متوسط المدة" value={`${totals.avgDuration} دقيقة`} tone="text-amber-400" icon={Clock} />
        <Stat label="متوسط السعر" value={sar(totals.avgPrice)} tone="text-sky-400" icon={Wallet} />
      </div>

      <Card className="overflow-hidden">
        <div className="p-4 border-b border-slate-800 flex flex-wrap gap-3 items-center">
          <div className="relative flex-1 min-w-[220px]">
            <Search className="absolute right-3.5 top-1/2 -translate-y-1/2 text-slate-500" size={17} />
            <Input value={search} onChange={(e) => setSearch(e.target.value)}
              placeholder="ابحث باسم الخدمة أو التصنيف…" className="pr-11" />
          </div>
          <label className="flex items-center gap-2 text-xs font-bold text-slate-400 cursor-pointer">
            <input type="checkbox" checked={onlyActive}
              onChange={(e) => setOnlyActive(e.target.checked)}
              className="accent-brand-500 w-4 h-4" />
            النشطة فقط
          </label>
        </div>

        {loading ? (
          <Loading />
        ) : error ? (
          <ErrorBox message={error} onRetry={load} />
        ) : filtered.length === 0 ? (
          <EmptyState message="لا توجد خدمات مطابقة"
            action={<PrimaryButton onClick={openNew} className="mt-2"><Plus size={16} /> أضف أول خدمة</PrimaryButton>} />
        ) : (
          <div className="grid sm:grid-cols-2 xl:grid-cols-3 gap-4 p-4">
            {filtered.map((s) => (
              <div key={s.id}
                className="bg-slate-900/80 border border-slate-800 rounded-2xl p-4 hover:border-sky-500/40 transition-colors">
                <div className="flex items-start justify-between gap-2 mb-2">
                  <div className="min-w-0">
                    <h3 className="font-bold text-base truncate">{s.name}</h3>
                    {s.name_en && <p className="text-[11px] text-slate-500 truncate" dir="ltr">{s.name_en}</p>}
                  </div>
                  <Pill tone={s.is_active
                    ? 'bg-brand-500/10 text-brand-400 border-brand-500/30'
                    : 'bg-slate-800 text-slate-500 border-slate-700'}>
                    {s.is_active ? 'نشطة' : 'موقوفة'}
                  </Pill>
                </div>

                {s.category && (
                  <Pill tone="bg-sky-500/10 text-sky-300 border-sky-500/20 mb-2">{s.category}</Pill>
                )}
                {s.description && (
                  <p className="text-xs text-slate-400 leading-relaxed mb-3 line-clamp-2">{s.description}</p>
                )}

                <div className="flex items-center justify-between pt-3 border-t border-slate-800">
                  <div>
                    <p className="text-lg font-black text-sky-400">{sar(s.base_price)}</p>
                    <p className="text-[11px] text-slate-500">
                      {s.duration_minutes} دقيقة · ضريبة {s.tax_rate}%
                    </p>
                  </div>
                  <div className="flex gap-1.5">
                    <button onClick={() => openEdit(s)}
                      className="p-2 rounded-lg text-slate-400 hover:text-sky-400 hover:bg-slate-800 transition-colors"
                      aria-label="تعديل"><Pencil size={16} /></button>
                    <button onClick={() => remove(s)}
                      className="p-2 rounded-lg text-slate-400 hover:text-rose-400 hover:bg-slate-800 transition-colors"
                      aria-label="حذف"><Trash2 size={16} /></button>
                  </div>
                </div>
              </div>
            ))}
          </div>
        )}
      </Card>

      <Modal open={modal} onClose={() => setModal(false)}
        title={draft.id ? 'تعديل الخدمة' : 'خدمة جديدة'}>
        <div className="grid sm:grid-cols-2 gap-4">
          <Field label="اسم الخدمة *">
            <Input value={draft.name} onChange={(e) => setDraft({ ...draft, name: e.target.value })} />
          </Field>
          <Field label="الاسم بالإنجليزية">
            <Input dir="ltr" value={draft.nameEn} onChange={(e) => setDraft({ ...draft, nameEn: e.target.value })} />
          </Field>
          <Field label="التصنيف">
            <Input value={draft.category} onChange={(e) => setDraft({ ...draft, category: e.target.value })} />
          </Field>
          <Field label="السعر الأساسي (ر.س)">
            <Input type="number" min="0" step="0.01" value={draft.basePrice}
              onChange={(e) => setDraft({ ...draft, basePrice: e.target.value })} />
          </Field>
          <Field label="نسبة الضريبة %">
            <Input type="number" min="0" step="0.01" value={draft.taxRate}
              onChange={(e) => setDraft({ ...draft, taxRate: e.target.value })} />
          </Field>
          <Field label="مدة التنفيذ (دقيقة)">
            <Input type="number" min="0" value={draft.durationMinutes}
              onChange={(e) => setDraft({ ...draft, durationMinutes: e.target.value })} />
          </Field>
          <div className="sm:col-span-2">
            <Field label="الوصف">
              <TextArea value={draft.description}
                onChange={(e) => setDraft({ ...draft, description: e.target.value })} />
            </Field>
          </div>
          <label className="sm:col-span-2 flex items-center gap-2 text-sm font-bold text-slate-300 cursor-pointer">
            <input type="checkbox" checked={draft.isActive}
              onChange={(e) => setDraft({ ...draft, isActive: e.target.checked })}
              className="accent-brand-500 w-4 h-4" />
            الخدمة نشطة
          </label>
        </div>
        <div className="flex justify-end gap-2 mt-6">
          <GhostButton onClick={() => setModal(false)}>إلغاء</GhostButton>
          <PrimaryButton onClick={save} disabled={saving}>
            {saving ? 'جارٍ الحفظ…' : 'حفظ'}
          </PrimaryButton>
        </div>
      </Modal>

      {toast && <Toast kind={toast.kind} message={toast.msg} onClose={() => setToast(null)} />}
    </div>
  );
};