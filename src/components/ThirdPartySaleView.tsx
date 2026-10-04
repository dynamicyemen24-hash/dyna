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
import { deviceGateway, ScaleReading } from '../services/deviceGateway';

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

  // Scale Integration
  const [scaleReading, setScaleReading] = useState<ScaleReading>({
    weightKg: 45.5,
    tareKg: 2.0,
    netWeightKg: 43.5,
    isStable: true,
  });

  // Form State
  const [sellerName, setSellerName] = useState('');
  const [buyerName, setBuyerName] = useState('');
  const [brokerName, setBrokerName] = useState('الدلال / أبو فهد');
  const [cropItem, setCropItem] = useState('');
  const [manualNetKg, setManualNetKg] = useState<number>(50);
  const [unitPrice, setUnitPrice] = useState<number>(10);
  const [commissionRate, setCommissionRate] = useState<number>(5);

  React.useEffect(() => {
    const unsub = deviceGateway.subscribeScale((reading) => {
      setScaleReading(reading);
    });
    return () => unsub();
  }, []);

  const handleCreateConsignment = (e: React.FormEvent) => {
    e.preventDefault();
    const netKg = scaleReading.netWeightKg > 0 ? scaleReading.netWeightKg : manualNetKg;
    const gross = netKg * unitPrice;
    const comm = (gross * commissionRate) / 100;
    const netSeller = gross - comm;

    const newSale: ConsignmentSale = {
      id: `cs-${Date.now()}`,
      lotNumber: `LOT-2026-${Math.floor(100 + Math.random() * 900)}`,
      sellerName,
      buyerName,
      brokerName,
      cropItem,
      grossWeightKg: scaleReading.weightKg,
      tareWeightKg: scaleReading.tareKg,
      netWeightKg: netKg,
      pricePerKg: unitPrice,
      grossTotal: gross,
      commissionPercent: commissionRate,
      commissionAmount: comm,
      netToSeller: netSeller,
      status: 'pending_payment',
      timestamp: new Date().toLocaleString('ar-SA'),
    };

    setSales([newSale, ...sales]);
    setIsModalOpen(false);
    // Reset form
    setSellerName('');
    setBuyerName('');
    setCropItem('');
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
              {/* Scale Live Reader Bar */}
              <div className="bg-slate-950 p-3 rounded-2xl border border-brand-500/30 flex items-center justify-between">
                <div>
                  <p className="text-[10px] text-slate-400">قراءة الميزان الإلكتروني المباشر:</p>
                  <p className="text-lg font-black font-mono text-brand-400">
                    الصافي: {scaleReading.netWeightKg} كجم (قائم {scaleReading.weightKg} كجم)
                  </p>
                </div>
                <button
                  type="button"
                  onClick={() => deviceGateway.setTare()}
                  className="bg-slate-800 hover:bg-slate-700 text-slate-200 px-3 py-1.5 rounded-lg text-[10px] font-bold"
                >
                  صفر الميزان (Tare)
                </button>
              </div>

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
                  <label className="block text-slate-300 font-semibold mb-1">الوزن اليدوي (إذا كان الميزان غير متصل):</label>
                  <input
                    type="number"
                    step="0.1"
                    value={manualNetKg}
                    onChange={(e) => setManualNetKg(Number(e.target.value))}
                    className="w-full bg-slate-950 border border-slate-800 rounded-xl px-3 py-2 text-white font-mono focus:outline-none focus:border-brand-500"
                  />
                </div>

                <div>
                  <label className="block text-slate-300 font-semibold mb-1">سعر الكيلو / الوحدة:</label>
                  <input
                    type="number"
                    step="0.1"
                    required
                    value={unitPrice}
                    onChange={(e) => setUnitPrice(Number(e.target.value))}
                    className="w-full bg-slate-950 border border-slate-800 rounded-xl px-3 py-2 text-white font-mono focus:outline-none focus:border-brand-500"
                  />
                </div>

                <div>
                  <label className="block text-slate-300 font-semibold mb-1">نسبة عمولة الدلالة (%):</label>
                  <input
                    type="number"
                    step="0.5"
                    value={commissionRate}
                    onChange={(e) => setCommissionRate(Number(e.target.value))}
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
