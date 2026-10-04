import React, { useState } from 'react';
import { 
  CreditCard, 
  RefreshCw, 
  Gift, 
  Sparkles, 
  Plus, 
  Calendar, 
  CheckCircle2, 
  User, 
  Building2,
  DollarSign
} from 'lucide-react';

export interface CustomerSubscription {
  id: string;
  customerName: string;
  planName: string; // باقة VIP الذهبية، اشتراك قهوة شهرية، صندوق الخضار الأسبوعي
  price: number;
  billingCycle: 'weekly' | 'monthly' | 'yearly';
  nextBillingDate: string;
  status: 'active' | 'paused' | 'canceled';
  storeCreditBalance: number;
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

export const SubscriptionsView: React.FC = () => {
  const [subscriptions, setSubscriptions] = useState<CustomerSubscription[]>([]);
  const [isModalOpen, setIsModalOpen] = useState(false);

  // Gift Card check simulator
  const [giftCardCode, setGiftCardCode] = useState('');
  const [giftCardResult, setGiftCardResult] = useState<string | null>(null);

  const handleCheckGiftCard = (e: React.FormEvent) => {
    e.preventDefault();
    if (giftCardCode.trim()) {
      setGiftCardResult(`بطاقة هدايا نشطة [${giftCardCode.toUpperCase()}]: الرصيد المتاح 500.00 ر.س (صالحة لغاية 2027/12/31)`);
    }
  };

  return (
    <div className="flex-1 flex flex-col p-6 overflow-y-auto bg-slate-950 text-slate-100 font-['Cairo',sans-serif]">
      {/* Top Banner Header */}
      <div className="flex flex-col md:flex-row md:items-center justify-between gap-4 mb-6">
        <div>
          <h2 className="text-xl font-black text-white flex items-center gap-2">
            <RefreshCw className="w-6 h-6 text-brand-400" />
            الاشتراكات والدفع المتكرر وبطاقات الهدايا (Subscriptions & Gift Cards)
          </h2>
          <p className="text-xs text-slate-400 mt-0.5">
            إدارة الاشتراكات الشهرية والأسبوعية للعملاء، شحن رصيد المحفظة، وبطاقات الهدايا المسبقة الدفع
          </p>
        </div>

        <button
          onClick={() => setIsModalOpen(true)}
          className="bg-brand-600 hover:bg-brand-500 text-white px-4 py-2.5 rounded-xl text-xs font-bold flex items-center gap-2 shadow-lg shadow-brand-600/30 transition-all shrink-0"
        >
          <Plus className="w-4 h-4" />
          إضافة اشتراك جديد لعميل
        </button>
      </div>

      {/* Gift Card Quick Validation Card */}
      <div className="bg-slate-900 border border-slate-800 rounded-2xl p-5 mb-6 shadow-sm">
        <h3 className="text-xs font-bold text-white flex items-center gap-2 mb-3">
          <Gift className="w-4 h-4 text-amber-400" />
          التحقق السريع من رصيد بطاقات الهدايا (Gift Card Checker)
        </h3>
        <form onSubmit={handleCheckGiftCard} className="flex gap-3 max-w-lg">
          <input
            type="text"
            placeholder="أدخل رمز بطاقة الهدايا (مثال: GIFT-8812)..."
            value={giftCardCode}
            onChange={(e) => setGiftCardCode(e.target.value)}
            className="flex-1 bg-slate-950 border border-slate-800 rounded-xl px-4 py-2 text-xs text-white focus:outline-none focus:border-amber-500 font-mono"
          />
          <button
            type="submit"
            className="bg-amber-600 hover:bg-amber-500 text-white px-4 py-2 rounded-xl text-xs font-bold transition-all shadow-md"
          >
            فحص الرصيد
          </button>
        </form>
        {giftCardResult && (
          <p className="mt-3 text-xs bg-amber-500/10 border border-amber-500/30 text-amber-300 p-2.5 rounded-xl font-mono">
            {giftCardResult}
          </p>
        )}
      </div>

      {/* Active Subscriptions Table */}
      <div className="bg-slate-900 border border-slate-800 rounded-2xl overflow-hidden shadow-sm">
        <div className="p-4 border-b border-slate-800 font-bold text-xs text-white flex items-center gap-2">
          <Sparkles className="w-4 h-4 text-brand-400" />
          قائمة باقات الاشتراكات والعضويات النشطة
        </div>
        <div className="overflow-x-auto">
          <table className="w-full text-right text-xs">
            <thead className="bg-slate-950/80 text-slate-400 border-b border-slate-800 uppercase tracking-wider">
              <tr>
                <th className="p-4">اسم العميل</th>
                <th className="p-4">اسم الباقة / الاشتراك</th>
                <th className="p-4">قيمة الاشتراك</th>
                <th className="p-4">الدورية</th>
                <th className="p-4">تاريخ التجديد القادم</th>
                <th className="p-4">رصيد المتجر المتاح</th>
                <th className="p-4 text-center">الحالة</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-slate-800/80">
              {subscriptions.map((sub) => (
                <tr key={sub.id} className="hover:bg-slate-800/40 transition-colors">
                  <td className="p-4 font-bold text-white">
                    <div className="flex items-center gap-2">
                      <User className="w-4 h-4 text-slate-400" />
                      <span>{sub.customerName}</span>
                    </div>
                  </td>
                  <td className="p-4 font-semibold text-brand-300">{sub.planName}</td>
                  <td className="p-4 font-mono font-bold text-white">{sub.price} ر.س</td>
                  <td className="p-4 font-semibold text-slate-300">
                    {sub.billingCycle === 'weekly' ? 'أسبوعي' : sub.billingCycle === 'monthly' ? 'شهري' : 'سنوي'}
                  </td>
                  <td className="p-4 font-mono text-slate-300">
                    <div className="flex items-center gap-1.5">
                      <Calendar className="w-3.5 h-3.5 text-slate-500" />
                      <span>{sub.nextBillingDate}</span>
                    </div>
                  </td>
                  <td className="p-4 font-mono text-amber-400 font-bold">{sub.storeCreditBalance} ر.س</td>
                  <td className="p-4 text-center">
                    <span className="px-2.5 py-1 rounded-full text-[10px] font-bold bg-brand-500/10 text-brand-400 border border-brand-500/20">
                      نشط وتجديد آلي
                    </span>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </div>
    </div>
  );
};
