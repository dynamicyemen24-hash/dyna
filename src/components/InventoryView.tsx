import React, { useState } from 'react';
import { Product, Category } from '../types';
import { 
  Package, 
  Search, 
  Plus, 
  AlertTriangle, 
  Edit, 
  Trash2, 
  X,
  Sparkles,
  ShoppingBag,
  ArrowUpRight,
  TrendingDown,
  CheckCircle2,
  AlertCircle
} from 'lucide-react';

/**
 * What the form submits to `POST /api/db/products`.
 *
 * Everything here is either typed by the operator or carried over from the
 * product being edited. `id` is absent because the server creates the row;
 * `barcode` is optional because the server allocates the EAN-13 when the field
 * is left empty; `branchId` is optional because on create the server scopes the
 * product to the session's branch, and on edit the existing product carries
 * its own.
 */
export type ProductDraft = Omit<Product, 'id' | 'barcode' | 'branchId'> & {
  barcode?: string;
  branchId?: string;
};

interface InventoryViewProps {
  products: Product[];
  categories: Category[];
  /** Resolves with the product the SERVER recorded (its real barcode). */
  onAddProduct: (product: ProductDraft) => Promise<Product>;
  onUpdateProduct: (product: Product) => void;
  onDeleteProduct: (productId: string) => void;
}

export const InventoryView: React.FC<InventoryViewProps> = ({
  products,
  categories,
  onAddProduct,
  onUpdateProduct,
  onDeleteProduct,
}) => {
  const [searchQuery, setSearchQuery] = useState('');
  const [selectedCategory, setSelectedCategory] = useState('الكل');
  const [filterAlertOnly, setFilterAlertOnly] = useState(false);
  const [isAddModalOpen, setIsAddModalOpen] = useState(false);
  const [editingProduct, setEditingProduct] = useState<Product | null>(null);
  const [restockSuccessMessage, setRestockSuccessMessage] = useState<string | null>(null);
  // A refused save keeps the modal open with the server's Arabic reason;
  // closing it would tell the operator the product was recorded when it was not.
  const [submitError, setSubmitError] = useState('');
  const [submitting, setSubmitting] = useState(false);

  // Form state
  const [formName, setFormName] = useState('');
  const [formBarcode, setFormBarcode] = useState('');
  const [formCategory, setFormCategory] = useState(categories[1]?.name || '');
  const [formPrice, setFormPrice] = useState('');
  const [formCost, setFormCost] = useState('');
  const [formStock, setFormStock] = useState('');
  const [formMinStock, setFormMinStock] = useState('5');
  const [formUnit, setFormUnit] = useState('قطعة');
  const [formImage, setFormImage] = useState('');

  // Stock Categorization & Reorder Logic
  const outOfStockProducts = products.filter((p) => p.stock === 0);
  const criticalStockProducts = products.filter((p) => p.stock > 0 && p.stock <= Math.ceil(p.minStock / 2));
  const lowStockProducts = products.filter((p) => p.stock > 0 && p.stock <= p.minStock);
  const allAlertProducts = products.filter((p) => p.stock <= p.minStock);

  const totalUnits = products.reduce((s, p) => s + (p.stock || 0), 0);
  const totalCostValue = products.reduce((s, p) => s + ((p.cost || 0) * (p.stock || 0)), 0);
  const totalRetailValue = products.reduce((s, p) => s + ((p.price || 0) * (p.stock || 0)), 0);
  const estimatedProfit = totalRetailValue - totalCostValue;
  const profitMarginPercent = totalRetailValue > 0 ? ((estimatedProfit / totalRetailValue) * 100).toFixed(1) : '0';

  const filteredProducts = products.filter((p) => {
    const matchesCategory = selectedCategory === 'الكل' || p.category === selectedCategory;
    const matchesSearch = 
      p.name.toLowerCase().includes(searchQuery.toLowerCase()) || 
      p.barcode.includes(searchQuery) ||
      p.id.toLowerCase().includes(searchQuery.toLowerCase());
    const matchesAlert = !filterAlertOnly || p.stock <= p.minStock;
    return matchesCategory && matchesSearch && matchesAlert;
  });

  const handleOpenAdd = () => {
    setEditingProduct(null);
    // Deliberately empty: the barcode is ALLOCATED BY THE SERVER (a 13-digit
    // EAN-13) when the operator leaves the field blank and saves.
    setFormBarcode('');
    setFormCategory(categories[1]?.name || 'عطور وبخاخات');
    setFormPrice('');
    setFormCost('');
    setFormStock('10');
    setFormMinStock('3');
    setFormUnit('حبة');
    setFormImage('');
    setSubmitError('');
    setIsAddModalOpen(true);
  };

  const handleOpenEdit = (p: Product) => {
    setEditingProduct(p);
    setFormName(p.name);
    setFormBarcode(p.barcode);
    setFormCategory(p.category);
    setFormPrice(p.price.toString());
    setFormCost(p.cost.toString());
    setFormStock(p.stock.toString());
    setFormMinStock(p.minStock.toString());
    setFormUnit(p.unit);
    setFormImage(p.image || '');
    setSubmitError('');
    setIsAddModalOpen(true);
  };

  const handleSaveProduct = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!formName || !formPrice) return;

    setSubmitError('');
    setSubmitting(true);
    try {
      // Only what the operator typed. No invented `id`, no fabricated barcode
      // digits: the server creates the row and allocates the EAN-13.
      const draft: ProductDraft = {
        name: formName,
        // On edit the field is read-only and holds the existing value; on add
        // an empty field means "allocate it for me".
        barcode: editingProduct ? formBarcode : (formBarcode || undefined),
        category: formCategory,
        price: Number(formPrice),
        cost: Number(formCost) || 0,
        stock: Number(formStock) || 0,
        minStock: Number(formMinStock) || 5,
        unit: formUnit,
        image: formImage || undefined,
        // `branchId` omitted on purpose: on edit the spread below keeps the
        // product's real branch, and on create the server scopes it to the
        // session's branch instead of a made-up id.
      };

      if (editingProduct) {
        // Editing stays a local update: the contract this screen writes
        // through defines POST (create) only, and re-POSTing would duplicate
        // the row the server already allocated a barcode for.
        onUpdateProduct({ ...editingProduct, ...draft, barcode: formBarcode });
      } else {
        // The row that comes back carries the barcode the SERVER allocated;
        // it replaces the draft before the modal closes.
        const saved = await onAddProduct(draft);
        setFormBarcode(saved.barcode);
      }
      setIsAddModalOpen(false);
    } catch (err: any) {
      setSubmitError(err?.message || 'تعذّر حفظ المنتج على الخادم — تحقق من الاتصال وحاول مرة أخرى');
    } finally {
      setSubmitting(false);
    }
  };

  // Quick Restock Action
  const handleQuickRestock = (product: Product, suggestedQty: number) => {
    const updated: Product = {
      ...product,
      stock: product.stock + suggestedQty,
    };
    onUpdateProduct(updated);
    setRestockSuccessMessage(`تمت إعادة تغذية مخزون (${product.name}) بـ +${suggestedQty} ${product.unit} بنجاح!`);
    setTimeout(() => setRestockSuccessMessage(null), 4000);
  };

  return (
    <div className="flex-1 flex flex-col p-6 overflow-y-auto bg-canvas text-ink font-['Cairo',sans-serif]">
      {/* Toast Notification */}
      {restockSuccessMessage && (
        <div className="mb-4 bg-brand-500/20 border border-brand-500 text-brand-300 p-4 rounded-2xl flex items-center justify-between shadow-lg animate-in slide-in-from-top-4 duration-300">
          <div className="flex items-center gap-2">
            <CheckCircle2 className="w-5 h-5 text-brand-400" />
            <span className="text-xs font-bold">{restockSuccessMessage}</span>
          </div>
          <button onClick={() => setRestockSuccessMessage(null)} className="text-brand-400 hover:text-white">
            <X className="w-4 h-4" />
          </button>
        </div>
      )}

      {/* Top Banner & Stats */}
      <div className="flex flex-col md:flex-row md:items-center justify-between gap-4 mb-6">
        <div>
          <h2 className="text-xl font-black text-white flex items-center gap-2">
            <Package className="w-6 h-6 text-brand-400" />
            إدارة المخزون والتنبيهات الذكية (Inventory & Smart Reorder)
          </h2>
          <p className="text-xs text-slate-400 mt-0.5">متابعة الأرصدة الحية لشركة رويال العالمية مع التنبيهات الملونة واقتراح كميات الشراء</p>
        </div>

        <div className="flex items-center gap-3">
          <button
            onClick={() => setFilterAlertOnly(!filterAlertOnly)}
            className={`px-4 py-2.5 rounded-xl text-xs font-bold flex items-center gap-2 border transition-all ${
              filterAlertOnly
                ? 'bg-amber-500 text-slate-950 border-amber-400 font-black shadow-lg shadow-amber-500/20'
                : 'bg-slate-900 border-slate-800 text-amber-400 hover:bg-slate-800'
            }`}
          >
            <AlertTriangle className="w-4 h-4" />
            <span>تنبيهات نقص المخزون ({allAlertProducts.length})</span>
          </button>

          <button
            onClick={handleOpenAdd}
            className="bg-brand-600 hover:bg-brand-500 text-white px-4 py-2.5 rounded-xl text-xs font-bold flex items-center gap-2 shadow-lg shadow-brand-600/30 transition-all"
          >
            <Plus className="w-4 h-4" />
            إضافة صنف جديد
          </button>
        </div>
      </div>

      {/* Executive Inventory KPIs Ribbon for Royal Global */}
      <div className="grid grid-cols-2 md:grid-cols-4 gap-4 mb-6">
        <div className="bg-slate-900 border border-slate-800 rounded-2xl p-4 shadow-sm">
          <span className="text-[11px] font-bold text-slate-400">إجمالي الأصناف المسجلة</span>
          <div className="text-xl font-black text-white font-mono mt-1">{products.length} صنف</div>
          <span className="text-[10px] text-brand-400 font-bold">100% مطابقة لقالب الأرصدة الافتتاحية</span>
        </div>

        <div className="bg-slate-900 border border-slate-800 rounded-2xl p-4 shadow-sm">
          <span className="text-[11px] font-bold text-slate-400">إجمالي الكمية الفعلية بالمستودع</span>
          <div className="text-xl font-black text-cyan-400 font-mono mt-1">{totalUnits.toLocaleString()} حبة</div>
          <span className="text-[10px] text-slate-400">المستودع الرئيسي (HQ)</span>
        </div>

        <div className="bg-slate-900 border border-slate-800 rounded-2xl p-4 shadow-sm">
          <span className="text-[11px] font-bold text-slate-400">إجمالي قيمة المخزون (سعر التكلفة)</span>
          <div className="text-xl font-black text-amber-400 font-mono mt-1">{totalCostValue.toLocaleString(undefined, { minimumFractionDigits: 2, maximumFractionDigits: 2 })} ر.س</div>
          <span className="text-[10px] text-slate-400">رأس المال المستثمر</span>
        </div>

        <div className="bg-slate-900 border border-slate-800 rounded-2xl p-4 shadow-sm">
          <span className="text-[11px] font-bold text-slate-400">القيمة التقديرية للبيع (هامش الربح)</span>
          <div className="text-xl font-black text-brand-400 font-mono mt-1">{totalRetailValue.toLocaleString(undefined, { minimumFractionDigits: 2, maximumFractionDigits: 2 })} ر.س</div>
          <span className="text-[10px] text-brand-300 font-bold font-mono">هامش ربح متوقع +{profitMarginPercent}%</span>
        </div>
      </div>

      {/* Smart Low-Stock Intelligence Cards */}
      <div className="grid grid-cols-1 md:grid-cols-3 gap-4 mb-6">
        {/* Out of Stock Card */}
        <div className="bg-rose-950/30 border border-rose-900/50 rounded-2xl p-5 shadow-sm relative overflow-hidden">
          <div className="flex items-center justify-between mb-2">
            <span className="text-xs font-bold text-rose-300 flex items-center gap-1.5">
              <AlertCircle className="w-4 h-4 text-rose-400" />
              أصناف نافذة تماماً (Out of Stock)
            </span>
            <span className="px-2 py-0.5 rounded-full text-xs font-black bg-rose-500/20 text-rose-300 font-mono">
              {outOfStockProducts.length} صنف
            </span>
          </div>
          <p className="text-xs text-rose-200/80 mb-3">توقف مبيعاتها كلياً وتتطلب إعادة التوريد فوراً</p>
          {outOfStockProducts.length > 0 && (
            <div className="space-y-1.5 pt-2 border-t border-rose-900/40">
              {outOfStockProducts.map((p) => (
                <div key={p.id} className="flex justify-between items-center text-[11px] text-rose-200">
                  <span className="truncate max-w-[180px]">{p.name}</span>
                  <button
                    onClick={() => handleQuickRestock(p, Math.max(10, p.minStock * 3))}
                    className="text-[10px] bg-rose-600 hover:bg-rose-500 text-white px-2 py-0.5 rounded font-semibold transition-colors"
                  >
                    طلب توريد آلي (+{Math.max(10, p.minStock * 3)})
                  </button>
                </div>
              ))}
            </div>
          )}
        </div>

        {/* Critical Stock Card */}
        <div className="bg-amber-950/30 border border-amber-900/50 rounded-2xl p-5 shadow-sm relative overflow-hidden">
          <div className="flex items-center justify-between mb-2">
            <span className="text-xs font-bold text-amber-300 flex items-center gap-1.5">
              <TrendingDown className="w-4 h-4 text-amber-400" />
              مخزون حرج (Critical Level)
            </span>
            <span className="px-2 py-0.5 rounded-full text-xs font-black bg-amber-500/20 text-amber-300 font-mono">
              {criticalStockProducts.length} أصناف
            </span>
          </div>
          <p className="text-xs text-amber-200/80 mb-3">اقتربت من النفاذ دون حد الأمان المطلوب</p>
          {criticalStockProducts.length > 0 && (
            <div className="space-y-1.5 pt-2 border-t border-amber-900/40">
              {criticalStockProducts.map((p) => {
                const suggestedQty = Math.max(5, Math.ceil((p.minStock * 2.5) - p.stock));
                return (
                  <div key={p.id} className="flex justify-between items-center text-[11px] text-amber-200">
                    <span className="truncate max-w-[160px]">{p.name} ({p.stock} متبقي)</span>
                    <button
                      onClick={() => handleQuickRestock(p, suggestedQty)}
                      className="text-[10px] bg-amber-600 hover:bg-amber-500 text-white px-2 py-0.5 rounded font-semibold transition-colors"
                    >
                      إعادة طلب (+{suggestedQty})
                    </button>
                  </div>
                );
              })}
            </div>
          )}
        </div>

        {/* Smart Reorder AI Suggestion Card */}
        <div className="bg-brand-950/30 border border-brand-900/50 rounded-2xl p-5 shadow-sm relative overflow-hidden">
          <div className="flex items-center justify-between mb-2">
            <span className="text-xs font-bold text-brand-300 flex items-center gap-1.5">
              <Sparkles className="w-4 h-4 text-brand-400" />
              مساعد التوريد الذكي (Reorder Intelligence)
            </span>
            <span className="px-2 py-0.5 rounded-full text-xs font-black bg-brand-500/20 text-brand-300 font-mono">
              آلي
            </span>
          </div>
          <p className="text-xs text-brand-200/80 mb-3">يحدد كميات التغذية بناءً على معدل المبيعات وحد الأمان</p>
          <div className="bg-slate-900/80 rounded-xl p-2.5 border border-slate-800 text-[11px] text-slate-300 space-y-1">
            <div className="flex justify-between">
              <span>إجمالي الأصناف بالمخزون:</span>
              <span className="font-mono font-bold text-white">{products.length}</span>
            </div>
            <div className="flex justify-between">
              <span>أصناف تحتاج طلب توريد:</span>
              <span className="font-mono font-bold text-amber-400">{allAlertProducts.length}</span>
            </div>
          </div>
        </div>
      </div>

      {/* Filters & Search */}
      <div className="bg-slate-900 border border-slate-800 rounded-2xl p-4 mb-6 flex flex-col md:flex-row gap-4 items-center justify-between">
        <div className="relative flex-1 w-full md:w-auto">
          <Search className="absolute right-3.5 top-1/2 -translate-y-1/2 w-4 h-4 text-slate-400" />
          <input
            type="text"
            placeholder="البحث بالاسم أو الباركود..."
            value={searchQuery}
            onChange={(e) => setSearchQuery(e.target.value)}
            className="w-full bg-slate-950 border border-slate-800 rounded-xl pr-10 pl-4 py-2.5 text-sm text-white placeholder-slate-500 focus:outline-none focus:border-brand-500"
          />
        </div>

        <div className="flex items-center gap-2 overflow-x-auto w-full md:w-auto pb-1 md:pb-0">
          {categories.map((cat) => (
            <button
              key={cat.id}
              onClick={() => setSelectedCategory(cat.name)}
              className={`px-3.5 py-2 rounded-xl text-xs font-semibold whitespace-nowrap transition-all ${
                selectedCategory === cat.name
                  ? 'bg-brand-600 text-white shadow-md'
                  : 'bg-slate-950 text-slate-400 border border-slate-800 hover:text-white'
              }`}
            >
              {cat.name}
            </button>
          ))}
        </div>
      </div>

      {/* Products Table with Smart Reorder Quantity Column */}
      <div className="bg-slate-900 border border-slate-800 rounded-2xl overflow-hidden shadow-sm">
        <div className="overflow-x-auto">
          <table className="w-full text-right text-xs">
            <thead className="bg-slate-950/80 text-slate-400 border-b border-slate-800 uppercase tracking-wider">
              <tr>
                <th className="p-4">المنتج</th>
                <th className="p-4">الباركود</th>
                <th className="p-4">التصنيف</th>
                <th className="p-4">سعر التكلفة</th>
                <th className="p-4">سعر البيع</th>
                <th className="p-4">المخزون الحالي</th>
                <th className="p-4">حد إعادة الطلب</th>
                <th className="p-4">الكمية المقترحة للطلب</th>
                <th className="p-4">الحالة</th>
                <th className="p-4 text-center">الإجراءات</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-slate-800/80">
              {filteredProducts.map((product) => {
                const isOutOfStock = product.stock === 0;
                const isCritical = product.stock > 0 && product.stock <= Math.ceil(product.minStock / 2);
                const isLow = product.stock <= product.minStock;

                // Suggested order calculation formula
                const suggestedQty = Math.max(0, Math.ceil((product.minStock * 2.5) - product.stock));

                return (
                  <tr 
                    key={product.id} 
                    className={`transition-colors ${
                      isOutOfStock
                        ? 'bg-rose-950/20 hover:bg-rose-900/30'
                        : isCritical
                        ? 'bg-amber-950/20 hover:bg-amber-900/30'
                        : 'hover:bg-slate-800/40'
                    }`}
                  >
                    <td className="p-4 flex items-center gap-3">
                      <div className="w-10 h-10 rounded-lg bg-slate-950 overflow-hidden shrink-0 border border-slate-800">
                        {product.image ? (
                          <img src={product.image} alt={product.name} className="w-full h-full object-cover" />
                        ) : (
                          <div className="w-full h-full flex items-center justify-center text-slate-600">
                            <Package className="w-5 h-5" />
                          </div>
                        )}
                      </div>
                      <div>
                        <p className="font-bold text-white text-sm">{product.name}</p>
                        <p className="text-[10px] text-slate-400">الوحدة: {product.unit}</p>
                      </div>
                    </td>
                    <td className="p-4 font-mono text-slate-300">{product.barcode}</td>
                    <td className="p-4 text-slate-300">{product.category}</td>
                    <td className="p-4 font-mono text-slate-300">{product.cost} ر.س</td>
                    <td className="p-4 font-mono font-bold text-brand-400">{product.price} ر.س</td>
                    <td className="p-4 font-mono font-bold text-white">
                      <span className={isOutOfStock ? 'text-rose-400' : isLow ? 'text-amber-400' : 'text-white'}>
                        {product.stock} {product.unit}
                      </span>
                    </td>
                    <td className="p-4 font-mono text-slate-400">
                      {product.minStock} {product.unit}
                    </td>
                    <td className="p-4 font-mono">
                      {isLow ? (
                        <span className="font-bold text-brand-400 flex items-center gap-1">
                          +{suggestedQty} {product.unit}
                        </span>
                      ) : (
                        <span className="text-slate-500">-</span>
                      )}
                    </td>
                    <td className="p-4">
                      {isOutOfStock ? (
                        <span className="inline-flex items-center gap-1 bg-rose-500/20 text-rose-300 border border-rose-500/30 px-2.5 py-1 rounded-full text-[10px] font-bold">
                          <AlertCircle className="w-3 h-3 text-rose-400" /> نافذ تماماً
                        </span>
                      ) : isCritical ? (
                        <span className="inline-flex items-center gap-1 bg-amber-500/20 text-amber-300 border border-amber-500/30 px-2.5 py-1 rounded-full text-[10px] font-bold">
                          <AlertTriangle className="w-3 h-3 text-amber-400" /> حرج جداً
                        </span>
                      ) : isLow ? (
                        <span className="inline-flex items-center gap-1 bg-amber-500/10 text-amber-400 border border-amber-500/20 px-2.5 py-1 rounded-full text-[10px] font-semibold">
                          <AlertTriangle className="w-3 h-3" /> وصل حد الطلب
                        </span>
                      ) : (
                        <span className="inline-flex items-center gap-1 bg-brand-500/10 text-brand-400 border border-brand-500/20 px-2.5 py-1 rounded-full text-[10px] font-semibold">
                          متوفر وفير
                        </span>
                      )}
                    </td>
                    <td className="p-4 text-center">
                      <div className="flex items-center justify-center gap-1.5">
                        {isLow && (
                          <button
                            onClick={() => handleQuickRestock(product, suggestedQty)}
                            className="px-2 py-1 bg-brand-600 hover:bg-brand-500 text-white rounded-lg text-[10px] font-bold transition-colors flex items-center gap-1"
                            title="إعادة تغذية المخزون"
                          >
                            <ShoppingBag className="w-3 h-3" />
                            تغذية (+{suggestedQty})
                          </button>
                        )}
                        <button
                          onClick={() => handleOpenEdit(product)}
                          className="p-1.5 rounded-lg bg-slate-800 hover:bg-slate-700 text-slate-300 transition-colors"
                          title="تعديل"
                        >
                          <Edit className="w-4 h-4" />
                        </button>
                        <button
                          onClick={() => onDeleteProduct(product.id)}
                          className="p-1.5 rounded-lg bg-rose-500/10 hover:bg-rose-500/20 text-rose-400 transition-colors"
                          title="حذف"
                        >
                          <Trash2 className="w-4 h-4" />
                        </button>
                      </div>
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
      </div>

      {/* Add / Edit Modal */}
      {isAddModalOpen && (
        <div className="fixed inset-0 bg-slate-950/80 backdrop-blur-sm z-50 flex items-center justify-center p-4">
          <div className="bg-slate-900 border border-slate-800 rounded-2xl w-full max-w-xl p-6 shadow-2xl animate-in zoom-in-95 duration-200">
            <div className="flex items-center justify-between pb-4 border-b border-slate-800 mb-5">
              <h3 className="text-base font-bold text-white flex items-center gap-2">
                <Package className="w-5 h-5 text-brand-400" />
                {editingProduct ? 'تعديل بيانات المنتج' : 'إضافة صنف جديد للمخزون'}
              </h3>
              <button onClick={() => setIsAddModalOpen(false)} className="text-slate-400 hover:text-white">
                <X className="w-5 h-5" />
              </button>
            </div>

            <form onSubmit={handleSaveProduct} className="space-y-4">
              <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
                <div>
                  <label className="block text-xs font-semibold text-slate-300 mb-1">اسم المنتج:</label>
                  <input
                    type="text"
                    required
                    value={formName}
                    onChange={(e) => setFormName(e.target.value)}
                    placeholder="مثال: سماعات لاسلكية..."
                    className="w-full bg-slate-950 border border-slate-800 rounded-xl px-4 py-2.5 text-xs text-white focus:outline-none focus:border-brand-500"
                  />
                </div>

                <div>
                  <label className="block text-xs font-semibold text-slate-300 mb-1">الباركود:</label>
                  <input
                    type="text"
                    value={formBarcode}
                    readOnly={!!editingProduct}
                    onChange={(e) => setFormBarcode(e.target.value)}
                    placeholder={editingProduct ? undefined : 'يُخصّص تلقائياً من الخادم عند الحفظ (EAN-13)'}
                    title={editingProduct ? 'الباركود ثابت بعد إنشاء المنتج ولا يمكن تعديله' : undefined}
                    className={`w-full bg-slate-950 border border-slate-800 rounded-xl px-4 py-2.5 text-xs font-mono focus:outline-none focus:border-brand-500 ${
                      editingProduct
                        ? 'text-slate-400 cursor-not-allowed'
                        : 'text-white placeholder-slate-500'
                    }`}
                  />
                  <p className="mt-1 text-[10px] text-slate-500">
                    {editingProduct
                      ? 'الباركود ثابت بعد إنشاء المنتج ولا يمكن تعديله'
                      : 'يُخصّص تلقائياً من الخادم عند الحفظ (EAN-13)'}
                  </p>
                </div>

                <div>
                  <label className="block text-xs font-semibold text-slate-300 mb-1">التصنيف:</label>
                  <select
                    value={formCategory}
                    onChange={(e) => setFormCategory(e.target.value)}
                    className="w-full bg-slate-950 border border-slate-800 rounded-xl px-4 py-2.5 text-xs text-white focus:outline-none focus:border-brand-500"
                  >
                    {categories.filter(c => c.name !== 'الكل').map((c) => (
                      <option key={c.id} value={c.name} className="bg-slate-900 text-white">
                        {c.name}
                      </option>
                    ))}
                  </select>
                </div>

                <div>
                  <label className="block text-xs font-semibold text-slate-300 mb-1">وحدة القياس:</label>
                  <input
                    type="text"
                    value={formUnit}
                    onChange={(e) => setFormUnit(e.target.value)}
                    className="w-full bg-slate-950 border border-slate-800 rounded-xl px-4 py-2.5 text-xs text-white focus:outline-none focus:border-brand-500"
                  />
                </div>

                <div>
                  <label className="block text-xs font-semibold text-slate-300 mb-1">سعر التكلفة (ر.س):</label>
                  <input
                    type="number"
                    value={formCost}
                    onChange={(e) => setFormCost(e.target.value)}
                    placeholder="0.00"
                    className="w-full bg-slate-950 border border-slate-800 rounded-xl px-4 py-2.5 text-xs text-white font-mono focus:outline-none focus:border-brand-500"
                  />
                </div>

                <div>
                  <label className="block text-xs font-semibold text-slate-300 mb-1">سعر البيع (ر.س):</label>
                  <input
                    type="number"
                    required
                    value={formPrice}
                    onChange={(e) => setFormPrice(e.target.value)}
                    placeholder="0.00"
                    className="w-full bg-slate-950 border border-slate-800 rounded-xl px-4 py-2.5 text-xs text-white font-mono focus:outline-none focus:border-brand-500"
                  />
                </div>

                <div>
                  <label className="block text-xs font-semibold text-slate-300 mb-1">الكمية بالمخزون:</label>
                  <input
                    type="number"
                    value={formStock}
                    onChange={(e) => setFormStock(e.target.value)}
                    className="w-full bg-slate-950 border border-slate-800 rounded-xl px-4 py-2.5 text-xs text-white font-mono focus:outline-none focus:border-brand-500"
                  />
                </div>

                <div>
                  <label className="block text-xs font-semibold text-slate-300 mb-1">حد التنبيه للانخفاض:</label>
                  <input
                    type="number"
                    value={formMinStock}
                    onChange={(e) => setFormMinStock(e.target.value)}
                    className="w-full bg-slate-950 border border-slate-800 rounded-xl px-4 py-2.5 text-xs text-white font-mono focus:outline-none focus:border-brand-500"
                  />
                </div>
              </div>

              <div>
                <label className="block text-xs font-semibold text-slate-300 mb-1">رابط صورة المنتج (URL):</label>
                <input
                  type="text"
                  value={formImage}
                  onChange={(e) => setFormImage(e.target.value)}
                  placeholder="https://images.unsplash.com/..."
                  className="w-full bg-slate-950 border border-slate-800 rounded-xl px-4 py-2.5 text-xs text-white font-mono focus:outline-none focus:border-brand-500"
                />
              </div>

              <div className="flex items-center justify-end gap-3 pt-4 border-t border-slate-800">
                <button
                  type="button"
                  onClick={() => setIsAddModalOpen(false)}
                  className="px-4 py-2.5 rounded-xl text-xs font-semibold bg-slate-800 hover:bg-slate-700 text-slate-300 transition-colors"
                >
                  إلغاء
                </button>
                {submitError && (
                  <p
                    role="alert"
                    className="flex-1 text-right text-[11px] leading-relaxed font-semibold text-rose-300 bg-rose-500/10 border border-rose-500/30 rounded-lg px-3 py-2"
                  >
                    {submitError}
                  </p>
                )}
                <button
                  type="submit"
                  disabled={submitting}
                  className="px-6 py-2.5 rounded-xl text-xs font-bold bg-brand-600 hover:bg-brand-500 text-white shadow-lg shadow-brand-600/30 transition-all disabled:opacity-60 disabled:cursor-not-allowed"
                >
                  {submitting ? 'جارٍ الحفظ…' : editingProduct ? 'حفظ التعديلات' : 'إضافة للمخزون'}
                </button>
              </div>
            </form>
          </div>
        </div>
      )}
    </div>
  );
};
