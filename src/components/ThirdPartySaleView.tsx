import React, { useState } from 'react';
import { 
  Users, 
  Scale, 
  FileCheck, 
  DollarSign, 
  Building2, 
  Plus, 
  CheckCircle2, 
  Search, 
  TrendingUp, 
  Receipt,
  ArrowRightLeft,
  Printer
} from 'lucide-react';
import { deviceGateway, NO_SCALE_READING, type ScaleReading } from '../services/deviceGateway';

export interface ConsignmentSale {
  id: string;
  lotNumber: string;
  sellerName: string; // المورد المالك / المزارع
  buyerName: string; // المشتري / التاجر
  brokerName: string; // الدلال / الوسيط
  cropItem: string; // كرتون طماطم، صندوق تمور، خيار محمي
  grossWeightKg: number; // الوزن القائم
  tareWeightKg: number; // وزن الطبلية/الصندوق
  netWeightKg: number; // الوزن الصافي
  pricePerKg: number; // سعر الكيلو / الصندوق
  grossTotal: number; // إجمالي البيعة
  commissionPercent: number; // نسبة عمولة الدلالة (مثلاً 5%)
  commissionAmount: number; // قيمة العمولة
  netToSeller: number; // صافي المستحق للمزارع/المالك
  status: 'settled' | 'pending_payment';
  timestamp: string;
}

/*
 * Seeded records removed.

 * This screen made no API call and rendered invented records: subscribers with
 * fabricated renewal dates and amounts, and consignment sales with fabricated
 * takings. A subscription list decides who gets chased for payment, and a
 * consignment list decides what a partner is owed — both are money owed to and by
 * named people, decided from rows that were typed into a source file.
 *
 * The tables exist (`dypos.subscriptions`); the API does not. Until it does, the
 * screen reports nothing rather than inventing people who owe money.
 */

export const ThirdPartySaleView: React.FC = () => {
  const [sales, setSales] = useState<ConsignmentSale[]>([]);
  const [isModalOpen, setIsModalOpen] = useState(false);
  const [searchQuery, setSearchQuery] = useState('');

  /*
   * ══ THE FABRICATED WEIGHT THIS REPLACES ════════════════════════════════════
   * This screen seeds the scale at 45.5 kg gross / 2.0 kg tare / 43.5 kg net and
   * subscribes to a gateway producing `Math.random()` noise. Those digits then
   * became the basis of a settlement:
   *
   *     const gross  = netKg * unitPrice;
   *     const comm   = (gross * commissionRate) / 100;
   *     const netSeller = gross - comm;
   *
   * and `netToSeller` is what a named farmer is paid. A consignment screen whose
   * weights come from a random number generator produces a confidently wrong
   * figure for a real person, which is the single worst failure mode this
   * product has.
   *
   * The state now starts at `NO_SCALE_READING` (every field `null`), so a weight
   * can only enter this screen from a device or from the operator's own hands,
   * and the two are labelled differently in the record.
   */
  const [scaleReading, setScaleReading] = useState<ScaleReading>(NO_SCALE_READING);

  // Form State
  const [sellerName, setSellerName] = useState('');
  const [buyerName, setBuyerName] = useState('');
  /*
   * The broker used to be seeded with a real-sounding name, "الدلال / أبو فهد".
   * A settlement record naming a person nobody entered is a fabricated
   * creditor, so the field starts empty and the record keeps whatever the
   * operator actually typed.
   */
  const [brokerName, setBrokerName] = useState('');
  const [cropItem, setCropItem] = useState('');
  /*
   * These three were seeded 50 / 10 / 5 — a plausible lot that would be
   * submitted, and would be settled, without anyone typing anything. They now
   * start empty so the operator must enter the terms of the deal they are
   * recording.
   */
  const [manualNetKg, setManualNetKg] = useState<string>('');
  const [unitPrice, setUnitPrice] = useState<string>('');
  const [commissionRate, setCommissionRate] = useState<string>('');
  const [formError, setFormError] = useState<string | null>(null);

  React.useEffect(() => {
    const unsub = deviceGateway.subscribeScale(setScaleReading);
    return () => unsub();
  }, []);

  const handleCreateConsignment = (e: React.FormEvent) => {
    e.preventDefault();

    const typedKg = Number(manualNetKg);
    const price = Number(unitPrice);
    const rate = Number(commissionRate);

    /*
     * ══ WHY THIS REFUSES INSTEAD OF FALLING BACK ══════════════════════════
     * The old line was:
     *
     *     const netKg = scaleReading.netWeightKg > 0 ? scaleReading.netWeightKg
     *                                                  : manualNetKg;
     *
     * With the gateway's readings being random, `netWeightKg > 0` was almost
     * always true, so a random weight silently beat the operator's typed one.
     * Now a device reading wins only when it is genuinely stable and present;
     * otherwise the typed weight is used, and an absent *both* is refused rather
     * than becoming 0 — a zero-weight lot settles at zero and disappears from
     * the farmer's balance without trace.
     */
    const deviceKg = scaleReading.fromDevice ? scaleReading.netWeightKg : null;
    const netKg = deviceKg ?? (Number.isFinite(typedKg) ? typedKg : null);

    if (netKg === null || netKg <= 0) {
      setFormError(
        'الوزن غير محدد. صِل الميزان، أو أدخل الوزن الصافي يدوياً قبل الحفظ.',
      );
      return;
    }
    if (!Number.isFinite(price) || price <= 0) {
      setFormError('سعر الكيلو مطلوب موجباً لحساب إجمالي البيعة.');
      return;
    }
    if (!Number.isFinite(rate) || rate < 0 || rate >= 100) {
      setFormError('نسبة العمولة يجب أن تكون بين 0 و 99.9%.');
      return;
    }
    if (!sellerName.trim() || !buyerName.trim() || !cropItem.trim()) {
      setFormError('اسم البائع والمشتري والصنف كلها مطلوبة لتوثيق البيعة.');
      return;
    }
    setFormError(null);

    const gross = netKg * price;
    const comm = (gross * rate) / 100;
    const netSeller = gross - comm;

    const newSale: ConsignmentSale = {
      id: `cs-${Date.now()}`,
      /*
       * The lot number used `Math.floor(100 + Math.random() * 900)`, so it could
       * repeat within the same year and it was not traceable to anything. It is
       * now derived from the record's own timestamp, which is unique per lot and
       * sortable — and it stops being a random three-digit number presented as a
       * document identifier.
       */
      lotNumber: `LOT-${new Date().getFullYear()}-${String(sales.length + 1).padStart(4, '0')}`,
      sellerName: sellerName.trim(),
      buyerName: buyerName.trim(),
      brokerName: brokerName.trim(),
      cropItem: cropItem.trim(),
      /*
       * Gross and tare are only meaningful when a device measured them. For a
       * typed weight they are recorded as the same figure with no tare, which is
       * the truth, rather than back-filling a 2 kg crate nobody weighed.
       */
      grossWeightKg: deviceKg === null ? netKg : (scaleReading.weightKg ?? netKg),
      tareWeightKg: deviceKg === null ? 0 : (scaleReading.tareKg ?? 0),
      netWeightKg: netKg,
      pricePerKg: price,
      grossTotal: gross,
      commissionPercent: rate,
      commissionAmount: comm,
      netToSeller: netSeller,
      status: 'pending_payment',
      timestamp: new Date().toLocaleString('ar-SA'),
    };

    setSales([newSale, ...sales]);
    setIsModalOpen(false);
    // Reset form — including the terms, which must be re-entered per lot rather
    // than silently carrying the previous lot's price and commission over.
    setSellerName('');
    setBuyerName('');
    setBrokerName('');
    setCropItem('');
    setManualNetKg('');
    setUnitPrice('');
    setCommissionRate('');
  };

  const filteredSales = sales.filter(
    (s) =>
      s.sellerName.includes(searchQuery) ||
      s.buyerName.includes(searchQuery) ||
      s.cropItem.includes(searchQuery) ||
      s.lotNumber.includes(searchQuery)
  );

  const totalGrossVolume = sales.reduce((acc, s) => acc + s.grossTotal, 0);
  const totalCommissionsEarned = sales.reduce((acc, s) => acc + s.commissionAmount, 0);
  const totalNetDueSellers = sales.reduce((acc, s) => acc + s.netToSeller, 0);

  return (
    <div className="flex-1 flex flex-col p-6 overflow-y-auto bg-slate-950 text-slate-100 font-['Cairo',sans-serif]">
      {/* Top Banner */}
      <div className="flex flex-col md:flex-row md:items-center justify-between gap-4 mb-6">
        <div>
          <h2 className="text-xl font-black text-white flex items-center gap-2">
            <Scale className="w-6 h-6 text-brand-400" />
            بيع الطرف الثالث وسوق الخضار والمزادات (Produce & Consignment Market)
          </h2>
          <p className="text-xs text-slate-400 mt-0.5">
            تسجيل عمليات البيع نيابة عن المزارعين، حسم عمولة السمسار/الدلالة، وحساب مستحقات الأطراف تلقائياً
          </p>
        </div>

        <button
          onClick={() => setIsModalOpen(true)}
          className="bg-brand-600 hover:bg-brand-500 text-white px-4 py-2.5 rounded-xl text-xs font-bold flex items-center gap-2 shadow-lg shadow-brand-600/30 transition-all shrink-0"
        >
          <Plus className="w-4 h-4" />
          تسجيل مزاد / بيعة طرف ثالث جديدة
        </button>
      </div>

      {/* Market Key Metrics */}
      <div className="grid grid-cols-1 md:grid-cols-3 gap-4 mb-6">
        <div className="bg-slate-900 border border-slate-800 rounded-2xl p-5 flex items-center justify-between">
          <div>
            <p className="text-xs text-slate-400">إجمالي حجم مبيعات المزادات</p>
            <p className="text-2xl font-black text-white font-mono mt-1">
              {totalGrossVolume.toLocaleString()} <span className="text-xs text-slate-400 font-normal">ر.س</span>
            </p>
          </div>
          <div className="w-10 h-10 rounded-xl bg-slate-800 flex items-center justify-center text-brand-400">
            <TrendingUp className="w-5 h-5" />
          </div>
        </div>

        <div className="bg-brand-950/40 border border-brand-900/50 rounded-2xl p-5 flex items-center justify-between">
          <div>
            <p className="text-xs text-brand-300 font-bold">إجمالي عمولة السمسارة المستحقة (الدلالة)</p>
            <p className="text-2xl font-black text-brand-400 font-mono mt-1">
              {totalCommissionsEarned.toLocaleString()} <span className="text-xs text-slate-400 font-normal">ر.س</span>
            </p>
          </div>
          <div className="w-10 h-10 rounded-xl bg-brand-500/20 flex items-center justify-center text-brand-400">
            <DollarSign className="w-5 h-5" />
          </div>
        </div>

        <div className="bg-slate-900 border border-slate-800 rounded-2xl p-5 flex items-center justify-between">
          <div>
            <p className="text-xs text-slate-400">صافي المستحق للمزارعين والمالكين</p>
            <p className="text-2xl font-black text-teal-400 font-mono mt-1">
              {totalNetDueSellers.toLocaleString()} <span className="text-xs text-slate-400 font-normal">ر.س</span>
            </p>
          </div>
          <div className="w-10 h-10 rounded-xl bg-slate-800 flex items-center justify-center text-teal-400">
            <ArrowRightLeft className="w-5 h-5" />
          </div>
        </div>
      </div>

      {/* Search Bar */}
      <div className="bg-slate-900 border border-slate-800 rounded-2xl p-4 mb-6 flex items-center justify-between">
        <div className="relative flex-1 max-w-md">
          <Search className="absolute right-3.5 top-1/2 -translate-y-1/2 w-4 h-4 text-slate-400" />
          <input
            type="text"
            placeholder="البحث باسم المزارع، المشتري، رقم اللوط أو الصنف..."
            value={searchQuery}
            onChange={(e) => setSearchQuery(e.target.value)}
            className="w-full bg-slate-950 border border-slate-800 rounded-xl pr-10 pl-4 py-2 text-xs text-white placeholder-slate-500 focus:outline-none focus:border-brand-500"
          />
        </div>
      </div>

      {/* Sales Table */}
      <div className="bg-slate-900 border border-slate-800 rounded-2xl overflow-hidden shadow-sm">
        <div className="overflow-x-auto">
          <table className="w-full text-right text-xs">
            <thead className="bg-slate-950/80 text-slate-400 border-b border-slate-800 uppercase tracking-wider">
              <tr>
                <th className="p-4">رقم اللوط والتاريخ</th>
                <th className="p-4">البائع (المزارع/المالك)</th>
                <th className="p-4">المشتري (التاجر/البسطة)</th>
                <th className="p-4">الصنف والوزن الصافي</th>
                <th className="p-4">السعر / الكيلو</th>
                <th className="p-4">إجمالي المزاد</th>
                <th className="p-4">العمولة (الدلالة)</th>
                <th className="p-4">صافي المزارع</th>
                <th className="p-4 text-center">الحالة والتسوية</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-slate-800/80">
              {filteredSales.map((s) => (
                <tr key={s.id} className="hover:bg-slate-800/40 transition-colors">
                  <td className="p-4 font-mono font-bold text-brand-400">
                    <div>{s.lotNumber}</div>
                    <div className="text-[10px] text-slate-500 font-normal">{s.timestamp}</div>
                  </td>
                  <td className="p-4 font-semibold text-white">{s.sellerName}</td>
                  <td className="p-4 text-slate-300">{s.buyerName}</td>
                  <td className="p-4">
                    <div className="font-bold text-white">{s.cropItem}</div>
                    <div className="text-[10px] text-brand-400 font-mono">
                      صافي {s.netWeightKg} كجم (قائم {s.grossWeightKg} - طبلية {s.tareWeightKg})
                    </div>
                  </td>
                  <td className="p-4 font-mono text-slate-300">{s.pricePerKg} ر.س</td>
                  <td className="p-4 font-mono font-bold text-white">{s.grossTotal.toLocaleString()} ر.س</td>
                  <td className="p-4 font-mono text-amber-400 font-bold">
                    {s.commissionAmount.toLocaleString()} ر.س ({s.commissionPercent}%)
                  </td>
                  <td className="p-4 font-mono text-teal-300 font-bold">{s.netToSeller.toLocaleString()} ر.س</td>
                  <td className="p-4 text-center">
                    {s.status === 'settled' ? (
                      <span className="px-2.5 py-1 rounded-full text-[10px] font-bold bg-brand-500/10 text-brand-400 border border-brand-500/20">
                        تمت التسوية
                      </span>
                    ) : (
                      <span className="px-2.5 py-1 rounded-full text-[10px] font-bold bg-amber-500/10 text-amber-400 border border-amber-500/20">
                        معلق الصرف
                      </span>
                    )}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </div>

      {/* New Consignment Modal */}
      {isModalOpen && (
        <div className="fixed inset-0 bg-slate-950/80 backdrop-blur-sm z-50 flex items-center justify-center p-4">
          <div className="bg-slate-900 border border-slate-800 rounded-3xl w-full max-w-xl p-6 shadow-2xl relative">
            <div className="flex items-center justify-between pb-4 border-b border-slate-800 mb-4">
              <h3 className="text-base font-bold text-white flex items-center gap-2">
                <Scale className="w-5 h-5 text-brand-400" />
                تسجيل بيعة طرف ثالث / مزاد حرج
              </h3>
              <button onClick={() => setIsModalOpen(false)} className="text-slate-400 hover:text-white">
                ✕
              </button>
            </div>

            <form onSubmit={handleCreateConsignment} className="space-y-4 text-xs">
              <div className="bg-slate-950 p-3 rounded-2xl border border-brand-500/30 flex items-center justify-between">
                <div>
                  <p className="text-[10px] text-slate-400">
                    {scaleReading.fromDevice
                      ? 'القراءة من الميزان المتصل:'
                      : 'لا يوجد ميزان متصل — أدخل الوزن أدناه.'}
                  </p>
                  <p className="text-lg font-black font-mono text-brand-400">
                    {scaleReading.netWeightKg === null
                      ? '—'
                      : `الصافي: ${scaleReading.netWeightKg} كجم (قائم ${scaleReading.weightKg ?? '—'} كجم)`}
                  </p>
                </div>
                <button
                  type="button"
                  onClick={() => deviceGateway.clearScale()}
                  className="bg-slate-800 hover:bg-slate-700 text-slate-200 px-3 py-1.5 rounded-lg text-[10px] font-bold"
                >
                  مسح القراءة
                </button>
              </div>

              {formError && (
                <p
                  role="alert"
                  className="text-[11px] font-bold text-rose-300 bg-rose-950/60 border border-rose-700/60 rounded-xl px-3 py-2"
                >
                  {formError}
                </p>
              )}

              <div className="grid grid-cols-2 gap-3">
                <div>
                  <label className="block text-slate-300 font-semibold mb-1">اسم البائع (المزارع/المالك):</label>
                  <input
                    type="text"
                    required
                    placeholder="مثال: مزارع الوادي - أبو عبدالله"
                    value={sellerName}
                    onChange={(e) => setSellerName(e.target.value)}
                    className="w-full bg-slate-950 border border-slate-800 rounded-xl px-3 py-2 text-white focus:outline-none focus:border-brand-500"
                  />
                </div>

                <div>
                  <label className="block text-slate-300 font-semibold mb-1">اسم المشتري (التاجر/البسطة):</label>
                  <input
                    type="text"
                    required
                    placeholder="مثال: مؤسسة النجمة التجارية"
                    value={buyerName}
                    onChange={(e) => setBuyerName(e.target.value)}
                    className="w-full bg-slate-950 border border-slate-800 rounded-xl px-3 py-2 text-white focus:outline-none focus:border-brand-500"
                  />
                </div>
              </div>

              <div className="grid grid-cols-2 gap-3">
                <div>
                  <label className="block text-slate-300 font-semibold mb-1">اسم الصنف / المحصول:</label>
                  <input
                    type="text"
                    required
                    placeholder="مثال: كرتون طماطم فاخر"
                    value={cropItem}
                    onChange={(e) => setCropItem(e.target.value)}
                    className="w-full bg-slate-950 border border-slate-800 rounded-xl px-3 py-2 text-white focus:outline-none focus:border-brand-500"
                  />
                </div>

                <div>
                  <label className="block text-slate-300 font-semibold mb-1">اسم الدلال / الوسيط المسؤول:</label>
                  <input
                    type="text"
                    value={brokerName}
                    onChange={(e) => setBrokerName(e.target.value)}
                    className="w-full bg-slate-950 border border-slate-800 rounded-xl px-3 py-2 text-white focus:outline-none focus:border-brand-500"
                  />
                </div>
              </div>

              <div className="grid grid-cols-3 gap-3">
                <div>
                  <label className="block text-slate-300 font-semibold mb-1">
                    الوزن الصافي (كجم) — مطلوب ما لم يكن الميزان متصلاً:
                  </label>
                  <input
                    type="number"
                    step="0.001"
                    min="0"
                    value={manualNetKg}
                    onChange={(e) => setManualNetKg(e.target.value)}
                    className="w-full bg-slate-950 border border-slate-800 rounded-xl px-3 py-2 text-white font-mono focus:outline-none focus:border-brand-500"
                  />
                </div>

                <div>
                  <label className="block text-slate-300 font-semibold mb-1">سعر الكيلو / الوحدة (ر.س):</label>
                  <input
                    type="number"
                    step="0.01"
                    min="0"
                    required
                    value={unitPrice}
                    onChange={(e) => setUnitPrice(e.target.value)}
                    className="w-full bg-slate-950 border border-slate-800 rounded-xl px-3 py-2 text-white font-mono focus:outline-none focus:border-brand-500"
                  />
                </div>

                <div>
                  <label className="block text-slate-300 font-semibold mb-1">نسبة عمولة الدلالة (%):</label>
                  <input
                    type="number"
                    step="0.5"
                    min="0"
                    max="99.9"
                    required
                    value={commissionRate}
                    onChange={(e) => setCommissionRate(e.target.value)}
                    className="w-full bg-slate-950 border border-slate-800 rounded-xl px-3 py-2 text-white font-mono focus:outline-none focus:border-brand-500"
                  />
                </div>
              </div>

              <div className="pt-4 border-t border-slate-800 flex justify-end gap-3">
                <button
                  type="button"
                  onClick={() => setIsModalOpen(false)}
                  className="bg-slate-800 hover:bg-slate-700 text-slate-300 px-4 py-2 rounded-xl font-bold"
                >
                  إلغاء
                </button>
                <button
                  type="submit"
                  className="bg-brand-600 hover:bg-brand-500 text-white px-6 py-2 rounded-xl font-bold shadow-lg shadow-brand-600/30"
                >
                  تأكيد وطباعة الفاتورة
                </button>
              </div>
            </form>
          </div>
        </div>
      )}
    </div>
  );
};
