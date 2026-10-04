import React, { useState } from 'react';
import { AuditLogEntry } from '../types';
import { 
  ShieldAlert, 
  Search, 
  Filter, 
  AlertCircle, 
  AlertTriangle, 
  Info, 
  User, 
  Building2, 
  Clock, 
  FileSpreadsheet,
  Download,
  CheckCircle2
} from 'lucide-react';

interface AuditLogViewProps {
  logs: AuditLogEntry[];
}

export const AuditLogView: React.FC<AuditLogViewProps> = ({ logs }) => {
  const [searchQuery, setSearchQuery] = useState('');
  const [selectedCategory, setSelectedCategory] = useState<'all' | 'critical' | 'warning' | 'info'>('all');

  const filteredLogs = logs.filter((log) => {
    const matchesCategory = selectedCategory === 'all' || log.category === selectedCategory;
    const matchesSearch =
      log.user.toLowerCase().includes(searchQuery.toLowerCase()) ||
      log.action.toLowerCase().includes(searchQuery.toLowerCase()) ||
      log.details.toLowerCase().includes(searchQuery.toLowerCase()) ||
      log.branch.toLowerCase().includes(searchQuery.toLowerCase());
    return matchesCategory && matchesSearch;
  });

  const criticalCount = logs.filter((l) => l.category === 'critical').length;
  const warningCount = logs.filter((l) => l.category === 'warning').length;

  const handleExportCSV = () => {
    const headers = 'المعرف,التاريخ والوقت,الموظف,الفرع,نوع الإجراء,المستوى,التفاصيل,القيمة السابقة,القيمة الجديدة\n';
    const rows = filteredLogs
      .map(
        (l) =>
          `"${l.id}","${l.timestamp}","${l.user}","${l.branch}","${l.action}","${l.category}","${l.details}","${l.previousValue || ''}","${l.newValue || ''}"`
      )
      .join('\n');

    const blob = new Blob(['\uFEFF' + headers + rows], { type: 'text/csv;charset=utf-8;' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = `audit_logs_${new Date().toISOString().slice(0, 10)}.csv`;
    a.click();
  };

  return (
    <div className="flex-1 flex flex-col p-6 overflow-y-auto bg-slate-950 text-slate-100 font-['Cairo',sans-serif]">
      {/* Top Banner & Header */}
      <div className="flex flex-col md:flex-row md:items-center justify-between gap-4 mb-6">
        <div>
          <h2 className="text-xl font-black text-white flex items-center gap-2">
            <ShieldAlert className="w-6 h-6 text-rose-500" />
            سجل النشاط والرقابة الحساسة (Employee Audit Log)
          </h2>
          <p className="text-xs text-slate-400 mt-0.5">
            تتبع وتسجيل جميع العمليات الإدارية والمالية الحساسة لشركة رويال العالمية لمنع التلاعب وتطبيق أقصى درجات الحوكمة
          </p>
        </div>

        <button
          onClick={handleExportCSV}
          className="bg-slate-900 hover:bg-slate-800 text-brand-400 border border-brand-500/30 px-4 py-2.5 rounded-xl text-xs font-bold flex items-center gap-2 shadow-sm transition-all shrink-0"
        >
          <FileSpreadsheet className="w-4 h-4 text-brand-400" />
          تصدير سجل الرقابة (CSV)
        </button>
      </div>

      {/* Audit Stats */}
      <div className="grid grid-cols-1 md:grid-cols-3 gap-4 mb-6">
        <div className="bg-slate-900 border border-slate-800 rounded-2xl p-5 flex items-center justify-between">
          <div>
            <p className="text-xs text-slate-400">إجمالي السجلات الحساسة</p>
            <p className="text-2xl font-black text-white font-mono mt-1">{logs.length}</p>
          </div>
          <div className="w-10 h-10 rounded-xl bg-slate-800 flex items-center justify-center text-slate-300">
            <ShieldAlert className="w-5 h-5" />
          </div>
        </div>

        <div className="bg-rose-950/30 border border-rose-900/50 rounded-2xl p-5 flex items-center justify-between">
          <div>
            <p className="text-xs text-rose-300 font-bold">إجراءات عالية الخطورة (Critical)</p>
            <p className="text-2xl font-black text-rose-400 font-mono mt-1">{criticalCount}</p>
          </div>
          <div className="w-10 h-10 rounded-xl bg-rose-500/20 flex items-center justify-center text-rose-400">
            <AlertCircle className="w-5 h-5" />
          </div>
        </div>

        <div className="bg-amber-950/30 border border-amber-900/50 rounded-2xl p-5 flex items-center justify-between">
          <div>
            <p className="text-xs text-amber-300 font-bold">تعديلات أسعار وخصومات (Warnings)</p>
            <p className="text-2xl font-black text-amber-400 font-mono mt-1">{warningCount}</p>
          </div>
          <div className="w-10 h-10 rounded-xl bg-amber-500/20 flex items-center justify-center text-amber-400">
            <AlertTriangle className="w-5 h-5" />
          </div>
        </div>
      </div>

      {/* Filters & Search */}
      <div className="bg-slate-900 border border-slate-800 rounded-2xl p-4 mb-6 flex flex-col md:flex-row gap-4 items-center justify-between">
        <div className="relative flex-1 w-full md:w-auto">
          <Search className="absolute right-3.5 top-1/2 -translate-y-1/2 w-4 h-4 text-slate-400" />
          <input
            type="text"
            placeholder="البحث باسم الموظف، الفرع، أو نوع الإجراء..."
            value={searchQuery}
            onChange={(e) => setSearchQuery(e.target.value)}
            className="w-full bg-slate-950 border border-slate-800 rounded-xl pr-10 pl-4 py-2.5 text-sm text-white placeholder-slate-500 focus:outline-none focus:border-rose-500"
          />
        </div>

        <div className="flex items-center gap-2 overflow-x-auto w-full md:w-auto pb-1 md:pb-0">
          <button
            onClick={() => setSelectedCategory('all')}
            className={`px-3.5 py-2 rounded-xl text-xs font-semibold whitespace-nowrap transition-all ${
              selectedCategory === 'all'
                ? 'bg-rose-600 text-white shadow-md'
                : 'bg-slate-950 text-slate-400 border border-slate-800 hover:text-white'
            }`}
          >
            جميع السجلات ({logs.length})
          </button>
          <button
            onClick={() => setSelectedCategory('critical')}
            className={`px-3.5 py-2 rounded-xl text-xs font-semibold whitespace-nowrap transition-all ${
              selectedCategory === 'critical'
                ? 'bg-rose-600 text-white shadow-md'
                : 'bg-slate-950 text-rose-400 border border-slate-800 hover:bg-rose-950/40'
            }`}
          >
            🔴 حرجة جداً ({criticalCount})
          </button>
          <button
            onClick={() => setSelectedCategory('warning')}
            className={`px-3.5 py-2 rounded-xl text-xs font-semibold whitespace-nowrap transition-all ${
              selectedCategory === 'warning'
                ? 'bg-amber-600 text-white shadow-md'
                : 'bg-slate-950 text-amber-400 border border-slate-800 hover:bg-amber-950/40'
            }`}
          >
            🟡 تحذيرات الأسعار ({warningCount})
          </button>
          <button
            onClick={() => setSelectedCategory('info')}
            className={`px-3.5 py-2 rounded-xl text-xs font-semibold whitespace-nowrap transition-all ${
              selectedCategory === 'info'
                ? 'bg-blue-600 text-white shadow-md'
                : 'bg-slate-950 text-blue-400 border border-slate-800 hover:bg-blue-950/40'
            }`}
          >
            🔵 معلومات النظام
          </button>
        </div>
      </div>

      {/* Audit Log Table */}
      <div className="bg-slate-900 border border-slate-800 rounded-2xl overflow-hidden shadow-sm">
        <div className="overflow-x-auto">
          <table className="w-full text-right text-xs">
            <thead className="bg-slate-950/80 text-slate-400 border-b border-slate-800 uppercase tracking-wider">
              <tr>
                <th className="p-4">التاريخ والوقت</th>
                <th className="p-4">الموظف المسؤول</th>
                <th className="p-4">الفرع</th>
                <th className="p-4">نوع الإجراء</th>
                <th className="p-4">تفاصيل العملية</th>
                <th className="p-4">القيمة السابقة / الجديدة</th>
                <th className="p-4 text-center">مستوى الخطورة</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-slate-800/80">
              {filteredLogs.length === 0 ? (
                <tr>
                  <td colSpan={7} className="p-8 text-center text-slate-500">
                    لا توجد سجلات رقابة مطابقة للبحث الحالي.
                  </td>
                </tr>
              ) : (
                filteredLogs.map((log) => (
                  <tr
                    key={log.id}
                    className={`hover:bg-slate-800/40 transition-colors ${
                      log.category === 'critical'
                        ? 'bg-rose-950/10'
                        : log.category === 'warning'
                        ? 'bg-amber-950/10'
                        : ''
                    }`}
                  >
                    <td className="p-4 font-mono text-slate-300 whitespace-nowrap">
                      <div className="flex items-center gap-1.5">
                        <Clock className="w-3.5 h-3.5 text-slate-500" />
                        <span>{log.timestamp}</span>
                      </div>
                    </td>
                    <td className="p-4 font-bold text-white">
                      <div className="flex items-center gap-1.5">
                        <User className="w-3.5 h-3.5 text-slate-400" />
                        <span>{log.user}</span>
                      </div>
                    </td>
                    <td className="p-4 text-slate-300">
                      <div className="flex items-center gap-1.5">
                        <Building2 className="w-3.5 h-3.5 text-slate-500" />
                        <span>{log.branch}</span>
                      </div>
                    </td>
                    <td className="p-4 font-bold text-slate-200">{log.action}</td>
                    <td className="p-4 text-slate-300 max-w-xs leading-relaxed">{log.details}</td>
                    <td className="p-4 font-mono text-[11px]">
                      {log.previousValue || log.newValue ? (
                        <div className="flex items-center gap-1.5">
                          <span className="text-slate-400 line-through">{log.previousValue || '-'}</span>
                          <span className="text-slate-500">←</span>
                          <span className="text-brand-400 font-bold">{log.newValue || '-'}</span>
                        </div>
                      ) : (
                        <span className="text-slate-600">-</span>
                      )}
                    </td>
                    <td className="p-4 text-center">
                      {log.category === 'critical' && (
                        <span className="inline-flex items-center gap-1 bg-rose-500/20 text-rose-300 border border-rose-500/30 px-2.5 py-1 rounded-full text-[10px] font-bold">
                          <AlertCircle className="w-3 h-3 text-rose-400" /> خطيرة
                        </span>
                      )}
                      {log.category === 'warning' && (
                        <span className="inline-flex items-center gap-1 bg-amber-500/20 text-amber-300 border border-amber-500/30 px-2.5 py-1 rounded-full text-[10px] font-bold">
                          <AlertTriangle className="w-3 h-3 text-amber-400" /> تحذير
                        </span>
                      )}
                      {log.category === 'info' && (
                        <span className="inline-flex items-center gap-1 bg-blue-500/10 text-blue-400 border border-blue-500/20 px-2.5 py-1 rounded-full text-[10px] font-semibold">
                          <Info className="w-3 h-3" /> معلومات
                        </span>
                      )}
                    </td>
                  </tr>
                ))
              )}
            </tbody>
          </table>
        </div>
      </div>
    </div>
  );
};
