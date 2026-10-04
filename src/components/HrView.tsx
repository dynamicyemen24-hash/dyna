import React, { useState } from 'react';
import { Employee } from '../types';
import { Users, ShieldCheck, Plus, X } from 'lucide-react';
import {
  ScreenHeader,
  Stat,
  Pill,
  Input,
  Field,
  PrimaryButton,
  GhostButton,
  Modal,
  EmptyState,
} from './ui/Primitives';

interface HrViewProps {
  employees: Employee[];
  onAddEmployee: (emp: Employee) => void;
}

export const HrView: React.FC<HrViewProps> = ({ employees, onAddEmployee }) => {
  const [isModalOpen, setIsModalOpen] = useState(false);
  const [name, setName] = useState('');
  const [role, setRole] = useState('كاشير ومسؤول مبيعات');
  const [baseSalary, setBaseSalary] = useState('7000');

  const totalPayroll = employees.reduce((sum, e) => sum + e.baseSalary, 0);

  const handleSubmit = (e: React.FormEvent) => {
    e.preventDefault();
    if (!name || !baseSalary) return;

    const newEmp: Employee = {
      id: `emp-${Date.now()}`,
      name,
      role,
      branchId: 'b1',
      baseSalary: Number(baseSalary) || 6000,
      commissionRate: 1.0,
      status: 'active',
      attendanceToday: 'present',
    };

    onAddEmployee(newEmp);
    setIsModalOpen(false);
    setName('');
  };

  return (
    <div className="flex-1 flex flex-col p-6 overflow-y-auto bg-slate-950 text-slate-100">
      <div className="flex items-center justify-between mb-6">
        <div>
          <h2 className="text-xl font-black text-white flex items-center gap-2">
            <Users className="w-6 h-6 text-brand-400" />
            إدارة الموارد البشرية والرواتب (Odoo HR & SAP HCM)
          </h2>
          <p className="text-xs text-slate-400 mt-0.5">إدارة الموظفين، الحضور والانصراف، احتساب الرواتب والعمولات</p>
        </div>

        <button
          onClick={() => setIsModalOpen(true)}
          className="bg-brand-600 hover:bg-brand-500 text-white px-4 py-2.5 rounded-xl text-xs font-bold flex items-center gap-2 shadow-lg shadow-brand-600/30 transition-all"
        >
          <Plus className="w-4 h-4" />
          إضافة موظف جديد
        </button>
      </div>

      <div className="grid grid-cols-1 md:grid-cols-3 gap-4 mb-6">
        <div className="bg-slate-900 border border-slate-800 rounded-2xl p-5 shadow-sm">
          <span className="text-xs text-slate-400 block mb-1">إجمالي عدد الموظفين</span>
          <p className="text-2xl font-black text-white font-mono">{employees.length} <span className="text-xs text-slate-400">موظف</span></p>
          <p className="text-[11px] text-brand-400 mt-1 flex items-center gap-1">
            <ShieldCheck className="w-3.5 h-3.5" /> مسجلون بالتأمينات الاجتماعية
          </p>
        </div>
        <div className="bg-slate-900 border border-slate-800 rounded-2xl p-5 shadow-sm">
          <span className="text-xs text-slate-400 block mb-1">إجمالي الرواتب الشهرية</span>
          <p className="text-2xl font-black text-brand-400 font-mono">{totalPayroll.toLocaleString()} <span className="text-xs text-slate-400">ر.س</span></p>
          <p className="text-[11px] text-slate-400 mt-1">جاهز للصرف الآلي (WPS)</p>
        </div>
        <div className="bg-slate-900 border border-slate-800 rounded-2xl p-5 shadow-sm">
          <span className="text-xs text-slate-400 block mb-1">حالة الحضور اليوم</span>
          <p className="text-2xl font-black text-teal-400 font-mono">100% <span className="text-xs text-slate-400">ملتزمون</span></p>
          <p className="text-[11px] text-slate-400 mt-1">بصمة الحضور مسجلة بنجاح</p>
        </div>
      </div>

      <div className="bg-slate-900 border border-slate-800 rounded-2xl overflow-hidden shadow-sm">
        <div className="p-4 border-b border-slate-800">
          <h3 className="text-sm font-bold text-white">قائمة الموظفين والكادر الوظيفي</h3>
        </div>
        <div className="overflow-x-auto">
          <table className="w-full text-right text-xs">
            <thead className="bg-slate-950/80 text-slate-400 border-b border-slate-800 uppercase tracking-wider">
              <tr>
                <th className="p-4">اسم الموظف</th>
                <th className="p-4">المسمى الوظيفي</th>
                <th className="p-4">الراتب الأساسي</th>
                <th className="p-4">نسبة العمولات</th>
                <th className="p-4">حضور اليوم</th>
                <th className="p-4 text-center">الحالة</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-slate-800/80">
              {employees.map((emp) => (
                <tr key={emp.id} className="hover:bg-slate-800/40 transition-colors">
                  <td className="p-4 font-bold text-white text-sm">{emp.name}</td>
                  <td className="p-4 text-slate-300">{emp.role}</td>
                  <td className="p-4 font-mono font-bold text-brand-400">{emp.baseSalary.toLocaleString()} ر.س</td>
                  <td className="p-4 font-mono text-slate-300">{emp.commissionRate}%</td>
                  <td className="p-4">
                    <span className="px-2.5 py-1 rounded-full text-[10px] font-semibold bg-brand-500/10 text-brand-400 border border-brand-500/20">
                      حاضر (في الدوام)
                    </span>
                  </td>
                  <td className="p-4 text-center">
                    <span className="px-2.5 py-1 rounded-full text-[10px] font-semibold bg-brand-500/10 text-brand-400">
                      على رأس العمل
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
          <div className="bg-slate-900 border border-slate-800 rounded-2xl w-full max-w-md p-6 shadow-2xl">
            <div className="flex items-center justify-between pb-4 border-b border-slate-800 mb-4">
              <h3 className="text-base font-bold text-white">إضافة موظف جديد</h3>
              <button onClick={() => setIsModalOpen(false)} className="text-slate-400 hover:text-white">
                <X className="w-5 h-5" />
              </button>
            </div>

            <form onSubmit={handleSubmit} className="space-y-4">
              <div>
                <label className="block text-xs font-semibold text-slate-300 mb-1">اسم الموظف الثلاثي:</label>
                <input
                  type="text"
                  required
                  value={name}
                  onChange={(e) => setName(e.target.value)}
                  className="w-full bg-slate-950 border border-slate-800 rounded-xl px-4 py-2.5 text-xs text-white"
                />
              </div>

              <div>
                <label className="block text-xs font-semibold text-slate-300 mb-1">المسمى الوظيفي:</label>
                <input
                  type="text"
                  required
                  value={role}
                  onChange={(e) => setRole(e.target.value)}
                  className="w-full bg-slate-950 border border-slate-800 rounded-xl px-4 py-2.5 text-xs text-white"
                />
              </div>

              <div>
                <label className="block text-xs font-semibold text-slate-300 mb-1">الراتب الأساسي (ر.س):</label>
                <input
                  type="number"
                  required
                  value={baseSalary}
                  onChange={(e) => setBaseSalary(e.target.value)}
                  className="w-full bg-slate-950 border border-slate-800 rounded-xl px-4 py-2.5 text-xs text-white font-mono"
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
                  حفظ وتوظيف
                </button>
              </div>
            </form>
          </div>
        </div>
      )}
    </div>
  );
};
