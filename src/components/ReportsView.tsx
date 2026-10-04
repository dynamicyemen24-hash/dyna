import React, { useState, useMemo, useEffect } from 'react';
import { Transaction } from '../types';
import { apiGet } from '../services/dyposApi';
import { 
  BarChart3, 
  TrendingUp, 
  DollarSign, 
  ShoppingBag, 
  Printer, 
  FileText, 
  Search, 
  Clock,
  PieChart as PieIcon,
  LineChart as LineIcon,
  Download
} from 'lucide-react';
import { generateSummaryReportPDF, generateInvoicePDF } from '../utils/pdfGenerator';
import { useEntitlement } from '../contexts/EntitlementContext';
import {
  AreaChart,
  Area,
  BarChart,
  Bar,
  PieChart,
  Pie,
  Cell,
  XAxis,
  YAxis,
  CartesianGrid,
  Tooltip,
  ResponsiveContainer,
  Legend
} from 'recharts';

/**
 * Palette for the payment-method donut.
 *
 * This was referenced by the chart but never defined, so opening Reports threw
 * a ReferenceError and the whole screen failed to render.
 */
const COLORS = ['#10b981', '#3b82f6', '#f59e0b', '#8b5cf6', '#ef4444', '#14b8a6'];

interface ReportsViewProps {
  transactions: Transaction[];
}

// Live series pulled from PostgreSQL so the charts never show placeholder numbers.
interface DailySales {
  day: string;
  day_name: string;
  revenue: number;
  net: number;
  vat: number;
  invoices: number;
}

export const ReportsView: React.FC<ReportsViewProps> = ({ transactions }) => {
  // The seller identity on a re-issued invoice comes from the server, like every
  // other invoice. A report screen is a legal surface too: it hands the customer
  // a document naming who sold to them.
  const { identity } = useEntitlement();
  const [filterMethod, setFilterMethod] = useState<string>('all');
  const [searchQuery, setSearchQuery] = useState('');
  const [dailySales, setDailySales] = useState<DailySales[]>([]);
  const [loadingCharts, setLoadingCharts] = useState(true);

  const totalRevenue = transactions.reduce((sum, tx) => sum + tx.total, 0);
  const totalTax = transactions.reduce((sum, tx) => sum + tx.tax, 0);
  const totalDiscount = transactions.reduce((sum, tx) => sum + tx.discount, 0);
  const totalCount = transactions.length;

  const filteredTx = transactions.filter((tx) => {
    const matchesMethod = filterMethod === 'all' || tx.paymentMethod === filterMethod;
    const matchesSearch = tx.invoiceNumber.toLowerCase().includes(searchQuery.toLowerCase()) || (tx.customerName && tx.customerName.includes(searchQuery));
    return matchesMethod && matchesSearch;
  });

  // Load the real daily series from PostgreSQL.
  useEffect(() => {
    let alive = true;
    (async () => {
      try {
        setLoadingCharts(true);
        const res = await apiGet<{ items: DailySales[] }>(
          '/api/db/reports/daily-sales?days=14',
        );
        if (alive) setDailySales(res.items || []);
      } catch {
        if (alive) setDailySales([]);
      } finally {
        if (alive) setLoadingCharts(false);
      }
    })();
    return () => { alive = false; };
  }, []);

  // Recharts data — every series comes from the database, never a literal.
  const salesTrendData = useMemo(() => {
    if (dailySales.length === 0) return [];
    return dailySales.map((d) => ({
      day: d.day_name || d.day,
      revenue: Number(d.revenue),
      net: Number(d.net),
      vat: Number(d.vat),
      sales: Number(d.revenue),
      invoices: d.invoices,
    }));
  }, [dailySales]);

  const topProductsData = useMemo(() => {
    const productSalesMap: Record<string, number> = {};

    transactions.forEach((tx) => {
      tx.items.forEach((item) => {
        const pName = item.product.name.split('-')[0].trim();
        productSalesMap[pName] = (productSalesMap[pName] || 0) + item.quantity * item.product.price;
      });
    });

    return Object.entries(productSalesMap)
      .map(([name, sales]) => ({ name, sales }))
      .sort((a, b) => b.sales - a.sales)
      .slice(0, 5);
  }, [transactions]);

  const paymentMethodData = useMemo(() => {
    const methodMap: Record<string, number> = {
      'شبكة مدى': 0,
      'Apple Pay': 0,
      'نقدي': 0,
      'بطاقة ائتمان': 0,
    };

    transactions.forEach((tx) => {
      const label = tx.paymentMethod === 'mada' ? 'شبكة مدى' : tx.paymentMethod === 'apple_pay' ? 'Apple Pay' : tx.paymentMethod === 'cash' ? 'نقدي' : 'بطاقة ائتمان';
      methodMap[label] = (methodMap[label] || 0) + tx.total;
    });

    return Object.entries(methodMap).map(([name, value]) => ({ name, value }));
  }, [transactions]);

  return (
    <div className="flex-1 flex flex-col p-6 overflow-y-auto bg-slate-950 text-slate-100 font-['Cairo',sans-serif]">
      <div className="mb-6 flex flex-col md:flex-row md:items-center justify-between gap-4">
        <div>
          <h2 className="text-xl font-black text-white flex items-center gap-2">
            <BarChart3 className="w-6 h-6 text-brand-400" />
            التقارير التحليلية والرسوم البيانية (BI Dashboard)
          </h2>
          <p className="text-xs text-slate-400 mt-0.5">متابعة الأداء المالي اللحظي، اتجاهات المبيعات، والأصناف الأكثر طلباً</p>
        </div>

        <button
          onClick={() => generateSummaryReportPDF(transactions)}
          className="bg-brand-600 hover:bg-brand-500 text-white px-4 py-2.5 rounded-xl text-xs font-bold flex items-center gap-2 shadow-lg shadow-brand-600/30 transition-all self-start md:self-auto"
        >
          <Download className="w-4 h-4" />
          تصدير التقرير المالي (PDF)
        </button>
      </div>

      {/* Metric Cards */}
      <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-4 gap-4 mb-6">
        <div className="bg-slate-900 border border-slate-800 rounded-2xl p-5 shadow-sm">
          <div className="flex items-center justify-between mb-3">
            <span className="text-xs text-slate-400">إجمالي الإيرادات</span>
            <div className="w-9 h-9 rounded-xl bg-brand-500/10 text-brand-400 flex items-center justify-center">
              <DollarSign className="w-5 h-5" />
            </div>
          </div>
          <p className="text-2xl font-black text-white font-mono">{totalRevenue.toLocaleString()} <span className="text-xs font-normal text-slate-400">ر.س</span></p>
          <p className="text-[11px] text-brand-400 mt-1 flex items-center gap-1">
            <TrendingUp className="w-3 h-3" /> نمو ملحوظ (+14.2%)
          </p>
        </div>

        <div className="bg-slate-900 border border-slate-800 rounded-2xl p-5 shadow-sm">
          <div className="flex items-center justify-between mb-3">
            <span className="text-xs text-slate-400">عدد الفواتير المسجلة</span>
            <div className="w-9 h-9 rounded-xl bg-teal-500/10 text-teal-400 flex items-center justify-center">
              <ShoppingBag className="w-5 h-5" />
            </div>
          </div>
          <p className="text-2xl font-black text-white font-mono">{totalCount} <span className="text-xs font-normal text-slate-400">فاتورة</span></p>
          <p className="text-[11px] text-slate-400 mt-1">مسجلة بالفرع الحالي</p>
        </div>

        <div className="bg-slate-900 border border-slate-800 rounded-2xl p-5 shadow-sm">
          <div className="flex items-center justify-between mb-3">
            <span className="text-xs text-slate-400">الضريبة المحصلة (15%)</span>
            <div className="w-9 h-9 rounded-xl bg-cyan-500/10 text-cyan-400 flex items-center justify-center">
              <FileText className="w-5 h-5" />
            </div>
          </div>
          <p className="text-2xl font-black text-white font-mono">{totalTax.toLocaleString()} <span className="text-xs font-normal text-slate-400">ر.س</span></p>
          <p className="text-[11px] text-cyan-400 mt-1">جاهزة للإقرار الضريبي</p>
        </div>

        <div className="bg-slate-900 border border-slate-800 rounded-2xl p-5 shadow-sm">
          <div className="flex items-center justify-between mb-3">
            <span className="text-xs text-slate-400">إجمالي الخصومات المقدمة</span>
            <div className="w-9 h-9 rounded-xl bg-amber-500/10 text-amber-400 flex items-center justify-center">
              <TrendingUp className="w-5 h-5" />
            </div>
          </div>
          <p className="text-2xl font-black text-white font-mono">{totalDiscount.toLocaleString()} <span className="text-xs font-normal text-slate-400">ر.س</span></p>
          <p className="text-[11px] text-slate-400 mt-1">عروض الولاء والتخفيضات</p>
        </div>
      </div>

      {/* Recharts Analytics Dashboard */}
      <div className="grid grid-cols-1 lg:grid-cols-3 gap-6 mb-6">
        {/* Sales Trend Area Chart (2 Cols) */}
        <div className="lg:col-span-2 bg-slate-900 border border-slate-800 rounded-2xl p-5 shadow-sm">
          <div className="flex items-center justify-between mb-4 pb-3 border-b border-slate-800/80">
            <h3 className="text-sm font-bold text-white flex items-center gap-2">
              <LineIcon className="w-4 h-4 text-brand-400" />
              مؤشر حركة المبيعات الأسبوعية (Sales Trend)
            </h3>
            <span className="text-[11px] text-slate-400 bg-slate-950 px-2.5 py-1 rounded-full border border-slate-800">
              تحديث لحظي
            </span>
          </div>

          <div className="h-64 w-full">
            <ResponsiveContainer width="100%" height="100%">
              <AreaChart data={salesTrendData} margin={{ top: 10, right: 10, left: 0, bottom: 0 }}>
                <defs>
                  <linearGradient id="colorSales" x1="0" y1="0" x2="0" y2="1">
                    <stop offset="5%" stopColor="#10b981" stopOpacity={0.4}/>
                    <stop offset="95%" stopColor="#10b981" stopOpacity={0}/>
                  </linearGradient>
                </defs>
                <CartesianGrid strokeDasharray="3 3" stroke="#1e293b" />
                <XAxis dataKey="day" stroke="#64748b" fontSize={11} />
                <YAxis stroke="#64748b" fontSize={11} tickFormatter={(v) => `${v.toLocaleString()} ر.س`} />
                <Tooltip
                  contentStyle={{ backgroundColor: '#0f172a', borderColor: '#334155', borderRadius: '12px', fontSize: '12px' }}
                  labelStyle={{ color: '#10b981', fontWeight: 'bold' }}
                  formatter={(value: any) => [`${Number(value).toLocaleString()} ر.س`, 'المبيعات']}
                />
                <Area type="monotone" dataKey="sales" stroke="#10b981" strokeWidth={3} fillOpacity={1} fill="url(#colorSales)" />
              </AreaChart>
            </ResponsiveContainer>
          </div>
        </div>

        {/* Payment Methods Breakdown Pie Chart */}
        <div className="bg-slate-900 border border-slate-800 rounded-2xl p-5 shadow-sm flex flex-col justify-between">
          <div className="flex items-center justify-between mb-4 pb-3 border-b border-slate-800/80">
            <h3 className="text-sm font-bold text-white flex items-center gap-2">
              <PieIcon className="w-4 h-4 text-cyan-400" />
              توزيع طرق الدفع
            </h3>
          </div>

          <div className="h-56 w-full relative">
            <ResponsiveContainer width="100%" height="100%">
              <PieChart>
                <Pie
                  data={paymentMethodData}
                  cx="50%"
                  cy="50%"
                  innerRadius={50}
                  outerRadius={80}
                  paddingAngle={5}
                  dataKey="value"
                >
                  {paymentMethodData.map((entry, index) => (
                    <Cell key={`cell-${index}`} fill={COLORS[index % COLORS.length]} />
                  ))}
                </Pie>
                <Tooltip
                  contentStyle={{ backgroundColor: '#0f172a', borderColor: '#334155', borderRadius: '12px', fontSize: '12px' }}
                  formatter={(val: any) => [`${Number(val).toLocaleString()} ر.س`, 'إجمالي الدفع']}
                />
                <Legend verticalAlign="bottom" height={36} wrapperStyle={{ fontSize: '11px', color: '#94a3b8' }} />
              </PieChart>
            </ResponsiveContainer>
          </div>
        </div>
      </div>

      {/* Top Products Bar Chart */}
      <div className="bg-slate-900 border border-slate-800 rounded-2xl p-5 shadow-sm mb-6">
        <div className="flex items-center justify-between mb-4 pb-3 border-b border-slate-800/80">
          <h3 className="text-sm font-bold text-white flex items-center gap-2">
            <BarChart3 className="w-4 h-4 text-teal-400" />
            الأصناف الأكثر مبيعاً وتحقيقاً للإيرادات (Top Products)
          </h3>
        </div>

        <div className="h-60 w-full">
          <ResponsiveContainer width="100%" height="100%">
            <BarChart data={topProductsData} margin={{ top: 10, right: 10, left: 0, bottom: 0 }}>
              <CartesianGrid strokeDasharray="3 3" stroke="#1e293b" />
              <XAxis dataKey="name" stroke="#94a3b8" fontSize={11} />
              <YAxis stroke="#64748b" fontSize={11} tickFormatter={(v) => `${v.toLocaleString()} ر.س`} />
              <Tooltip
                contentStyle={{ backgroundColor: '#0f172a', borderColor: '#334155', borderRadius: '12px', fontSize: '12px' }}
                labelStyle={{ color: '#14b8a6', fontWeight: 'bold' }}
                formatter={(val: any) => [`${Number(val).toLocaleString()} ر.س`, 'المبيعات']}
              />
              <Bar dataKey="sales" fill="#14b8a6" radius={[8, 8, 0, 0]} />
            </BarChart>
          </ResponsiveContainer>
        </div>
      </div>

      {/* Transactions Table Filter */}
      <div className="bg-slate-900 border border-slate-800 rounded-2xl p-4 mb-6 flex flex-col md:flex-row gap-4 items-center justify-between">
        <div className="relative flex-1 w-full md:w-auto">
          <Search className="absolute right-3.5 top-1/2 -translate-y-1/2 w-4 h-4 text-slate-400" />
          <input
            type="text"
            placeholder="بحث برقم الفاتورة أو اسم العميل..."
            value={searchQuery}
            onChange={(e) => setSearchQuery(e.target.value)}
            className="w-full bg-slate-950 border border-slate-800 rounded-xl pr-10 pl-4 py-2.5 text-sm text-white placeholder-slate-500 focus:outline-none focus:border-brand-500"
          />
        </div>

        <div className="flex items-center gap-2 w-full md:w-auto">
          <select
            value={filterMethod}
            onChange={(e) => setFilterMethod(e.target.value)}
            className="bg-slate-950 border border-slate-800 rounded-xl px-4 py-2.5 text-xs text-white focus:outline-none focus:border-brand-500 cursor-pointer"
          >
            <option value="all">جميع طرق الدفع</option>
            <option value="mada">شبكة مدى</option>
            <option value="apple_pay">Apple Pay</option>
            <option value="cash">نقدي</option>
            <option value="card">بطاقة ائتمان</option>
            <option value="credit">حساب العملاء</option>
          </select>
        </div>
      </div>

      {/* Transactions List */}
      <div className="bg-slate-900 border border-slate-800 rounded-2xl overflow-hidden shadow-sm">
        <div className="overflow-x-auto">
          <table className="w-full text-right text-xs">
            <thead className="bg-slate-950/80 text-slate-400 border-b border-slate-800 uppercase tracking-wider">
              <tr>
                <th className="p-4">رقم الفاتورة</th>
                <th className="p-4">التاريخ والوقت</th>
                <th className="p-4">العميل</th>
                <th className="p-4">الكاشير</th>
                <th className="p-4">طريقة الدفع</th>
                <th className="p-4">الإجمالي</th>
                <th className="p-4 text-center">الإجراءات</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-slate-800/80">
              {filteredTx.map((tx) => (
                <tr key={tx.id} className="hover:bg-slate-800/40 transition-colors">
                  <td className="p-4 font-mono font-bold text-white">{tx.invoiceNumber}</td>
                  <td className="p-4 text-slate-300 flex items-center gap-1.5">
                    <Clock className="w-3.5 h-3.5 text-slate-400" />
                    {tx.timestamp}
                  </td>
                  <td className="p-4 text-slate-300">{tx.customerName || 'عميل عام'}</td>
                  <td className="p-4 text-slate-300">{tx.cashierName}</td>
                  <td className="p-4">
                    <span className="px-2.5 py-1 rounded-full text-[10px] font-semibold bg-brand-500/10 text-brand-400 border border-brand-500/20">
                      {tx.paymentMethod === 'mada' ? 'شبكة مدى' : tx.paymentMethod === 'apple_pay' ? 'Apple Pay' : tx.paymentMethod === 'cash' ? 'نقدي' : 'بطاقة'}
                    </span>
                  </td>
                  <td className="p-4 font-mono font-bold text-brand-400 text-sm">{tx.total.toLocaleString()} ر.س</td>
                  <td className="p-4 text-center">
                    <div className="flex items-center justify-center gap-1.5">
                      <button
                        onClick={() => window.print()}
                        className="p-1.5 rounded-lg bg-slate-800 hover:bg-slate-700 text-slate-300 transition-colors"
                        title="طباعة حرارية"
                      >
                        <Printer className="w-4 h-4" />
                      </button>
                      <button
                        onClick={() => generateInvoicePDF(tx, identity)}
                        className="p-1.5 rounded-lg bg-brand-600/20 hover:bg-brand-600/40 text-brand-400 border border-brand-500/30 transition-colors"
                        title="تحميل فاتورة PDF"
                      >
                        <Download className="w-4 h-4" />
                      </button>
                    </div>
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
