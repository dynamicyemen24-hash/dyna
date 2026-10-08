import React, { useState } from 'react';
import { Supplier, PurchaseOrder } from '../types';
import { ShoppingCart, Truck, Plus, Phone, Mail, Building, CheckCircle } from 'lucide-react';
import {
  ScreenHeader,
  Pill,
  Input,
  Select,
  Field,
  PrimaryButton,
  GhostButton,
  Modal,
} from './ui/Primitives';

interface PurchasesViewProps {
  suppliers: Supplier[];
  purchaseOrders: PurchaseOrder[];
  /**
   * Creates the order on the server and resolves with the row it recorded.
   *
   * The payload carries no `id`, `poNumber` or `supplierName`: `poNumber` is
   * allocated server-side (`PO-2026-000001`) and the supplier name is resolved
   * from `supplierId` there, so the list cannot drift from the supplier table.
   */
  onAddPurchaseOrder: (
    po: Omit<PurchaseOrder, 'id' | 'poNumber' | 'supplierName'>,
  ) => Promise<PurchaseOrder>;
}

export const PurchasesView: React.FC<PurchasesViewProps> = ({ suppliers, purchaseOrders, onAddPurchaseOrder }) => {
  const [isModalOpen, setIsModalOpen] = useState(false);
  const [selectedSupplierId, setSelectedSupplierId] = useState(suppliers[0]?.id || '');
  const [itemName, setItemName] = useState('عطر جسم 88 مل');
  const [quantity, setQuantity] = useState('50');
  const [unitCost, setUnitCost] = useState('6.6');
  // A refused order keeps the modal open with the server's Arabic reason;
  // closing it would tell the operator the order was saved when it was not.
  const [submitError, setSubmitError] = useState('');
  const [submitting, setSubmitting] = useState(false);

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    const sup = suppliers.find((s) => s.id === selectedSupplierId);
    if (!sup) return;

    const qtyNum = Number(quantity) || 1;
    const costNum = Number(unitCost) || 0;

    setSubmitError('');
    setSubmitting(true);
    try {
      // No `id`, no `poNumber`, no `supplierName`: the server allocates and
      // resolves all three and returns the recorded order.
      await onAddPurchaseOrder({
        supplierId: sup.id,
        items: [{ productName: itemName, quantity: qtyNum, unitCost: costNum }],
        totalAmount: qtyNum * costNum,
        status: 'approved',
        orderDate: new Date().toISOString().split('T')[0],
      });
      setIsModalOpen(false);
    } catch (err: any) {
      setSubmitError(err?.message || 'تعذّر حفظ أمر الشراء على الخادم — تحقق من الاتصال وحاول مرة أخرى');
    } finally {
      setSubmitting(false);
    }
  };

  return (
    <div className="space-y-6">
      <ScreenHeader
        icon={Truck}
        title="إدارة المشتريات وسلسلة الإمداد"
        subtitle="أوامر الشراء للموردين، استقبال البضائع، ومتابعة الأرصدة الدائنة"
        actions={
          <PrimaryButton onClick={() => { setSubmitError(''); setIsModalOpen(true); }}>
            <Plus className="w-4 h-4" />
            إنشاء أمر شراء جديد (PO)
          </PrimaryButton>
        }
      />

      <div className="grid grid-cols-1 md:grid-cols-3 gap-4">
        {suppliers.map((sup) => (
          <div key={sup.id} className="surface-card p-5 elev-1 transition-shadow hover:elev-2">
            <div className="flex items-center justify-between mb-3 gap-2">
              <h3 className="text-sm font-bold text-ink truncate">{sup.name}</h3>
              <Pill tone="bg-brand-soft text-brand border-brand/20">{sup.category}</Pill>
            </div>

            <div className="space-y-2 text-xs text-muted mb-4">
              <div className="flex items-center gap-2">
                <Building className="w-3.5 h-3.5 text-faint" />
                <span>المسؤول: {sup.contactPerson}</span>
              </div>
              <div className="flex items-center gap-2">
                <Phone className="w-3.5 h-3.5 text-faint" />
                <span className="text-numeric">{sup.phone}</span>
              </div>
            </div>

            <div className="pt-3 border-t border-hairline flex items-center justify-between text-xs">
              <span className="text-faint">المستحق للمورد:</span>
              <span className="text-numeric font-bold text-amber-600">{sup.balanceDue.toLocaleString()} ر.س</span>
            </div>
          </div>
        ))}
      </div>

      <div className="surface-card overflow-hidden">
        <div className="px-5 py-4 border-b border-hairline">
          <h3 className="text-sm font-semibold text-ink">سجل أوامر الشراء (Purchase Orders)</h3>
        </div>
        <div className="overflow-x-auto">
          <table className="w-full text-right text-xs">
            <thead className="bg-subtle text-faint border-b border-hairline">
              <tr>
                <th className="px-5 py-3 font-semibold">رقم أمر الشراء</th>
                <th className="px-5 py-3 font-semibold">المورد</th>
                <th className="px-5 py-3 font-semibold">الصنف والكمية</th>
                <th className="px-5 py-3 font-semibold">التاريخ</th>
                <th className="px-5 py-3 font-semibold">الإجمالي</th>
                <th className="px-5 py-3 font-semibold text-center">الحالة</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-hairline">
              {purchaseOrders.map((po) => (
                <tr key={po.id} className="hover:bg-subtle/70 transition-colors">
                  <td className="px-5 py-3.5 text-numeric font-bold text-ink">{po.poNumber}</td>
                  <td className="px-5 py-3.5 text-muted font-medium">{po.supplierName}</td>
                  <td className="px-5 py-3.5 text-muted">
                    {po.items.map((i, idx) => (
                      <span key={idx}>{i.productName} ({i.quantity} قطعة)</span>
                    ))}
                  </td>
                  <td className="px-5 py-3.5 text-muted text-numeric">{po.orderDate}</td>
                  <td className="px-5 py-3.5 text-numeric font-bold text-brand">{po.totalAmount.toLocaleString()} ر.س</td>
                  <td className="px-5 py-3.5 text-center">
                    <Pill tone="bg-brand-soft text-brand border-brand/20">
                      {po.status === 'received' ? 'تم الاستلام والمزامنة' : 'معتمد'}
                    </Pill>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </div>

      <Modal open={isModalOpen} title="إنشاء أمر شراء جديد للمورد" onClose={() => setIsModalOpen(false)}>
        <form onSubmit={handleSubmit} className="space-y-4">
          <Field label="المورد:">
            <Select
              value={selectedSupplierId}
              onChange={(e) => setSelectedSupplierId(e.target.value)}
            >
              {suppliers.map((s) => (
                <option key={s.id} value={s.id}>{s.name}</option>
              ))}
            </Select>
          </Field>

          <Field label="اسم الصنف المطلوب:">
            <Input
              type="text"
              required
              value={itemName}
              onChange={(e) => setItemName(e.target.value)}
            />
          </Field>

          <div className="grid grid-cols-2 gap-4">
            <Field label="الكمية المطلوبة:">
              <Input
                type="number"
                required
                value={quantity}
                onChange={(e) => setQuantity(e.target.value)}
                inputMode="numeric"
                className="text-numeric"
              />
            </Field>
            <Field label="سعر الوحدة (ر.س):">
              <Input
                type="number"
                required
                value={unitCost}
                onChange={(e) => setUnitCost(e.target.value)}
                inputMode="decimal"
                className="text-numeric"
              />
            </Field>
          </div>

          <div className="flex items-center justify-end gap-3 pt-4 border-t border-hairline">
            <GhostButton type="button" onClick={() => setIsModalOpen(false)}>
              إلغاء
            </GhostButton>
            {submitError && (
              <p
                role="alert"
                className="flex-1 text-right text-[11px] leading-relaxed font-semibold text-rose-700 bg-rose-50 border border-rose-200 rounded-lg px-3 py-2"
              >
                {submitError}
              </p>
            )}
            <PrimaryButton type="submit" disabled={submitting}>
              {submitting ? 'جارٍ الحفظ…' : 'حفظ واعتماد أمر الشراء'}
            </PrimaryButton>
          </div>
        </form>
      </Modal>
    </div>
  );
};
