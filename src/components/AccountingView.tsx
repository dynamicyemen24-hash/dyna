import React, { useState } from 'react';
import { JournalEntry } from '../types';
import { BookOpen, DollarSign, FileText, Plus, ShieldCheck, CheckCircle, X } from 'lucide-react';

interface AccountingViewProps {
  journalEntries: JournalEntry[];
  onAddJournalEntry: (entry: JournalEntry) => void;
}

export const AccountingView: React.FC<AccountingViewProps> = ({ journalEntries, onAddJournalEntry }) => {
  const [isModalOpen, setIsModalOpen] = useState(false);
  const [description, setDescription] = useState('');
  const [accountDebit, setAccountDebit] = useState('الصندوق الرئيسي (1101)');
  const [accountCredit, setAccountCredit] = useState('إيرادات المبيعات (4101)');
  const [amount, setAmount] = useState('');

  const totalDebits = journalEntries.reduce((sum, je) => sum + je.amount, 0);

  const handleSubmit = (e: React.FormEvent) => {
    e.preventDefault();
    if (!description || !amount) return;

    const newEntry: JournalEntry = {
      id: `je-${Date.now()}`,
      entryNumber: `JE-2026-${Math.floor(100 + Math.random() * 900)}`,
      date: new Date().toISOString().split('T')[0],
      description,
      accountDebit,
      accountCredit,
      amount: Number(amount),
      status: 'posted',
    };

    onAddJournalEntry(newEntry);
    setIsModalOpen(false);
    setDescription('');
    setAmount('');
  };

  return (
    <div className="flex-1 flex flex-col p-6 overflow-y-auto bg-slate-950 text-slate-100">
      <div className="flex items-center justify-between mb-6">
        <div>
          <h2 className="text-xl font-black text-white flex items-center gap-2">
            <BookOpen className="w-6 h-6 text-brand-400" />
            الحسابات العامة والأستاذ العام (معايير SAP & Odoo)
          </h2>
          <p className="text-xs text-slate-400 mt-0.5">قيود اليومية المزدوجة، دليل الحسابات المالي، وقوائم المركز المالي</p>
        </div>

        <button
          onClick={() => setIsModalOpen(true)}
          className="bg-brand-600 hover:bg-brand-500 text-white px-4 py-2.5 rounded-xl text-xs font-bold flex items-center gap-2 shadow-lg shadow-brand-600/30 transition-all"
        >
          <Plus className="w-4 h-4" />
          قيد يومية جديد (Journal Entry)
        </button>
      </div>

      <div className="grid grid-cols-1 md:grid-cols-3 gap-4 mb-6">
        <div className="bg-slate-900 border border-slate-800 rounded-2xl p-5 shadow-sm">
          <span className="text-xs text-slate-400 block mb-1">إجمالي الحركات المحاسبية</span>
          <p className="text-2xl font-black text-white font-mono">{totalDebits.toLocaleString()} <span className="text-xs text-slate-400">ر.س</span></p>
          <p className="text-[11px] text-brand-400 mt-1 flex items-center gap-1">
            <ShieldCheck className="w-3.5 h-3.5" /> متطابق وفق النظام المزدوج
          </p>
        </div>
        <div className="bg-slate-900 border border-slate-800 rounded-2xl p-5 shadow-sm">
          <span className="text-xs text-slate-400 block mb-1">صافي أرباح الفترة (P&L)</span>
          <p className="text-2xl font-black text-brand-400 font-mono">184,500 <span className="text-xs text-slate-400">ر.س</span></p>
          <p className="text-[11px] text-slate-400 mt-1">هامش ربح إجمالي 34.2%</p>
        </div>
        <div className="bg-slate-900 border border-slate-800 rounded-2xl p-5 shadow-sm">
          <span className="text-xs text-slate-400 block mb-1">الذمم الدائنة للموردين</span>
          <p className="text-2xl font-black text-amber-400 font-mono">65,900 <span className="text-xs text-slate-400">ر.س</span></p>
          <p className="text-[11px] text-slate-400 mt-1">مستحقة خلال 30 يوم</p>
        </div>
      </div>

      <div className="bg-slate-900 border border-slate-800 rounded-2xl overflow-hidden shadow-sm">
        <div className="p-4 border-b border-slate-800">
          <h3 className="text-sm font-bold text-white">سجل القيود المحاسبية (General Ledger)</h3>
        </div>
        <div className="overflow-x-auto">
          <table className="w-full text-right text-xs">
            <thead className="bg-slate-950/80 text-slate-400 border-b border-slate-800 uppercase tracking-wider">
              <tr>
                <th className="p-4">رقم القيد</th>
                <th className="p-4">التاريخ</th>
                <th className="p-4">وصف القيد وبيان الحركة</th>
                <th className="p-4">مدين (Debit)</th>
                <th className="p-4">دائن (Credit)</th>
                <th className="p-4">المبلغ</th>
                <th className="p-4 text-center">الحالة</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-slate-800/80">
              {journalEntries.map((je) => (
                <tr key={je.id} className="hover:bg-slate-800/40 transition-colors">
                  <td className="p-4 font-mono font-bold text-white">{je.entryNumber}</td>
                  <td className="p-4 text-slate-300">{je.date}</td>
                  <td className="p-4 text-slate-200 font-medium">{je.description}</td>
                  <td className="p-4 text-brand-400">{je.accountDebit}</td>
                  <td className="p-4 text-rose-400">{je.accountCredit}</td>
                  <td className="p-4 font-mono font-bold text-white">{je.amount.toLocaleString()} ر.س</td>
                  <td className="p-4 text-center">
                    <span className="px-2.5 py-1 rounded-full text-[10px] font-semibold bg-brand-500/10 text-brand-400 border border-brand-500/20">
                      معتمد ومرحل
                    </span>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </div>

      {isModalOpen && (
        <div className="fixed inset-0 bg-slate-950/80 backdrop-blur-sm z-50 flex items-center justify-center p-4">
          <div className="bg-slate-900 border border-slate-800 rounded-2xl w-full max-w-lg p-6 shadow-2xl">
            <div className="flex items-center justify-between pb-4 border-b border-slate-800 mb-4">
              <h3 className="text-base font-bold text-white">إضافة قيد يومية مزدوج جديد</h3>
              <button onClick={() => setIsModalOpen(false)} className="text-slate-400 hover:text-white">
                <X className="w-5 h-5" />
              </button>
            </div>

            <form onSubmit={handleSubmit} className="space-y-4">
              <div>
                <label className="block text-xs font-semibold text-slate-300 mb-1">وصف وقصة القيد:</label>
                <input
                  type="text"
                  required
                  value={description}
                  onChange={(e) => setDescription(e.target.value)}
                  placeholder="مثال: إثبات إيرادات مبيعات نقدية..."
                  className="w-full bg-slate-950 border border-slate-800 rounded-xl px-4 py-2.5 text-xs text-white focus:outline-none focus:border-brand-500"
                />
              </div>

              <div className="grid grid-cols-2 gap-4">
                <div>
                  <label className="block text-xs font-semibold text-slate-300 mb-1">الحساب المدين:</label>
                  <select
                    value={accountDebit}
                    onChange={(e) => setAccountDebit(e.target.value)}
                    className="w-full bg-slate-950 border border-slate-800 rounded-xl px-4 py-2 text-xs text-white"
                  >
                    <option value="الصندوق الرئيسي (1101)">الصندوق الرئيسي (1101)</option>
                    <option value="البنك الأهلي السعودي (1102)">البنك الأهلي السعودي (1102)</option>
                    <option value="المخزون السلعي (1201)">المخزون السلعي (1201)</option>
                  </select>
                </div>

                <div>
                  <label className="block text-xs font-semibold text-slate-300 mb-1">الحساب الدائن:</label>
                  <select
                    value={accountCredit}
                    onChange={(e) => setAccountCredit(e.target.value)}
                    className="w-full bg-slate-950 border border-slate-800 rounded-xl px-4 py-2 text-xs text-white"
                  >
                    <option value="إيرادات المبيعات (4101)">إيرادات المبيعات (4101)</option>
                    <option value="حساب الدائنين والموردين (2101)">حساب الدائنين والموردين (2101)</option>
                    <option value="رأس المال (3101)">رأس المال (3101)</option>
                  </select>
                </div>
              </div>

              <div>
                <label className="block text-xs font-semibold text-slate-300 mb-1">المبلغ (ر.س):</label>
                <input
                  type="number"
                  required
                  value={amount}
                  onChange={(e) => setAmount(e.target.value)}
                  placeholder="0.00"
                  className="w-full bg-slate-950 border border-slate-800 rounded-xl px-4 py-2.5 text-xs text-white font-mono focus:outline-none focus:border-brand-500"
                />
              </div>

              <div className="flex items-center justify-end gap-3 pt-4 border-t border-slate-800">
                <button
                  type="button"
                  onClick={() => setIsModalOpen(false)}
                  className="px-4 py-2.5 rounded-xl text-xs font-semibold bg-slate-800 text-slate-300"
                >
                  إلغاء
                </button>
                <button
                  type="submit"
                  className="px-6 py-2.5 rounded-xl text-xs font-bold bg-brand-600 text-white shadow-lg shadow-brand-600/30"
                >
                  ترحيل القيد المحاسبي
                </button>
              </div>
            </form>
          </div>
        </div>
      )}
    </div>
  );
};
