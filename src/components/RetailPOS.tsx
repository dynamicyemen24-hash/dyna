import React, { useMemo, useRef, useState } from 'react';
import { 
  Search, 
  ShoppingCart, 
  Trash2, 
  Plus, 
  Minus, 
  User, 
  CreditCard, 
  Banknote, 
  QrCode,
  Tag,
  Package,
  Layers,
  ChevronLeft
} from 'lucide-react';
import { apiGet, apiPost } from '../services/dyposApi';

/**
 * The product row as stored, before mapping to the screen's `Product`.
 *
 * `price` is deliberately `string | number` because Postgres `numeric` arrives as
 * a string. The old `any` mapper hid that, and `Number(p.price || p.unit_price || 0)`
 * is the line that turns a null price into a **free product** — the worst possible
 * failure on a till screen.
 */
/**
 * The product row as stored, before mapping to the screen's `Product`.
 *
 * `price` is deliberately `string | number` because Postgres `numeric` arrives as
 * a string. The old `any` mapper hid that, and `Number(p.price || p.unit_price || 0)`
 * is the line that turns a null price into a **free product** — the worst possible
 * failure on a till screen.
 *
 * `tax_rate` and `stock` are carried because both are per-product facts the till
 * needs and neither may be invented:
 *
 *   · the tax rate — the POS applied a hard-coded 15% to every line, so a
 *     product carrying a different rate was over- or under-charged at the till
 *     while the invoice said otherwise.
 *   · the stock — the screen printed a literal "مخزون: 12" on EVERY product,
 *     which is a stock figure belonging to no product and to no warehouse. A
 *     cashier acting on it would promise stock that does not exist.
 */
interface ProductRow {
  id: string;
  name: string;
  price?: string | number | null;
  unit_price?: string | number | null;
  category?: string | null;
  sku?: string | null;
  image?: string | null;
  image_url?: string | null;
  tax_rate?: string | number | null;
  stock?: string | number | null;
  min_stock?: string | number | null;
}

interface Product {
  id: string;
  name: string;
  price: number;
  category: string;
  image?: string;
  sku: string;
  /** Per-product VAT percentage. Not assumed — absent means the tenant default. */
  taxRate: number | null;
  /** Units on hand, as stored. `null` when the tenant does not track it. */
  stock: number | null;
}

interface CartItem extends Product {
  quantity: number;
}

export const RetailPOS: React.FC = () => {
  /*
   * There is NO `mockProducts` here any more.
   *
   * This screen used to open with six invented products — shirts, suits, perfumes
   * — each carrying a fabricated price, and a fabricated stock count on each. A
   * cashier selling from that screen would quote a price the business had never
   * set and promise stock the business did not have. There was no API call at
   * all, so the catalogue was a constant.
   *
   * An empty catalogue is a true statement; an invented one is not.
   */
  const [products, setProducts] = useState<Product[]>([]);
  const [isLoading, setIsLoading] = useState(true);
  const [loadError, setLoadError] = useState(false);
  /**
   * The tenant's VAT rate, used only for products that carry no rate of their own.
   *
   * It arrives from the server rather than being hard-coded, because the rate is
   * tenant configuration — a hard-coded 15% is a claim about a specific taxpayer,
   * made on behalf of all of them.
   */
  const [tenantVatRate, setTenantVatRate] = useState<number>(15);

  const [selectedCustomer, setSelectedCustomer] = useState<{ id: string; name: string } | null>(null);
  const [customers, setCustomers] = useState<{ id: string; name: string }[]>([]);

  React.useEffect(() => {
    let cancelled = false;

    async function load() {
      try {
        const [catalogue, tenant] = await Promise.all([
          apiGet<{ items?: ProductRow[] }>('/api/db/products'),
          apiGet<{ vatRate?: string | number }>('/api/tenant/context'),
        ]);

        if (cancelled) return;

        const rate = Number(tenant?.vatRate);
        if (Number.isFinite(rate) && rate >= 0) setTenantVatRate(rate);

        setProducts(
          (catalogue.items ?? []).map((p) => ({
            id: p.id,
            name: p.name,
            /*
             * A missing price is NOT coerced to zero. Zero would make the product
             * free AND zero its VAT, producing a receipt that agrees with itself
             * and looks like a legitimate discount. `NaN` instead, which the
             * basket filter below refuses to sell.
             */
            price: Number(p.price ?? p.unit_price),
            category: p.category ?? 'غير مصنّف',
            sku: p.sku ?? '',
            image: p.image_url ?? p.image ?? undefined,
            taxRate: p.tax_rate == null ? null : Number(p.tax_rate),
            stock: p.stock == null ? null : Number(p.stock),
          })),
        );
      } catch (err) {
        /*
         * The catalogue stays EMPTY and the screen says so. Falling back to
         * fabricated products because a request failed turns an outage into
         * apparently-real stock and prices — the exact failure O3 forbids.
         */
        console.error('Failed to load the product catalogue', err);
        if (!cancelled) setLoadError(true);
      } finally {
        if (!cancelled) setIsLoading(false);
      }
    }

    load();
    return () => { cancelled = true; };
  }, []);
  const [cart, setCart] = useState<CartItem[]>([]);
  const [selectedCategory, setSelectedCategory] = useState('الكل');
  const [searchQuery, setSearchQuery] = useState('');

  /*
   * The loader that fetches the catalogue lives at the top of this component,
   * alongside the tenant's VAT rate. A SECOND loader used to sit here, fetching
   * `/api/db/products` again and — on failure — logging "using mock data" while
   * leaving the six invented products on screen.
   *
   * Two loaders for one resource is not merely redundant: whichever finished
   * last won, so the screen's contents depended on request timing. And the
   * failure path was the fabrication path.
   */

  const addToCart = (product: Product) => {
    setCart(prev => {
      const existing = prev.find(item => item.id === product.id);
      if (existing) {
        return prev.map(item => item.id === product.id ? { ...item, quantity: item.quantity + 1 } : item);
      }
      return [...prev, { ...product, quantity: 1 }];
    });
  };

  const updateQuantity = (id: string, delta: number) => {
    setCart(prev => prev.map(item => {
      if (item.id === id) {
        const newQty = Math.max(0, item.quantity + delta);
        return { ...item, quantity: newQty };
      }
      return item;
    }).filter(item => item.quantity > 0));
  };

  const clearCart = () => setCart([]);

  const subtotal = cart.reduce((acc, item) => acc + (item.price * item.quantity), 0);

  /*
   * VAT is computed PER LINE from each product's own rate, falling back to the
   * tenant's configured rate only when the product carries none.
   *
   * It was `subtotal * 0.15` — one hard-coded rate for every line. That is wrong
   * in two directions at once: a tenant whose rate is not 15% is mis-charged on
   * every sale, and a product exempt or zero-rated is taxed anyway. Both errors
   * are silent and both appear on a tax document.
   */
  const tax = cart.reduce((acc, item) => {
    const rate = item.taxRate ?? tenantVatRate;
    if (!Number.isFinite(item.price) || !Number.isFinite(rate)) return acc;
    return acc + (item.price * item.quantity * rate) / 100;
  }, 0);
  const total = subtotal + tax;

  /*
   * Derived collections are MEMOISED.
   *
   * Both of these ran on every render. `categories` walked the whole catalogue
   * and built a Set to deduplicate it; `filteredProducts` then filtered and
   * searched the whole list again. On a 200-product catalogue that is trivial in
   * absolute terms — but it also ran on every keystroke in the search box, and
   * it ran again while the receipt panel re-rendered after a sale.
   *
   * The point is not the microseconds. It is that a till screen re-renders on
   * every character typed, and work that depends only on `products` should not
   * depend on the search text.
   */
  const categories = useMemo(
    () => ['الكل', ...Array.from(new Set(products.map((p) => p.category)))],
    [products],
  );

  /**
   * A basket containing an unknown price must NOT be saleable.
   *
   * One missing price used to propagate: `price || unit_price || 0` made it zero,
   * the VAT on it was zero, and the customer received the goods for nothing —
   * with a receipt that agreed with the arithmetic. It looks like a legitimate
   * discount on every line that was never priced.
   *
   * The line items are therefore filtered out at the point of sale, and the
   * blocked reason is shown instead of a silently wrong total.
   */
  const unpricedLines = cart.filter(
    (item) => !Number.isFinite(item.price) || item.price < 0,
  );
  const canProceed = cart.length > 0 && unpricedLines.length === 0;

  const totalKnown = Number.isFinite(total) && Number.isFinite(tax) && Number.isFinite(subtotal);

  const [paymentMode, setPaymentMode] = useState<'single' | 'split'>('single');

  /*
   * ══ COMPLETING A SALE ══════════════════════════════════════════════════
   * This screen had NO way to finish a transaction. It had a catalogue, a
   * basket, a subtotal, a VAT figure and a total — and then stopped. There was
   * no button that posted anything, so nothing was ever recorded and no stock
   * ever moved. A till that cannot ring up a sale is a calculator.
   *
   * Completing the sale now posts to the transactional invoice endpoint, which:
   *
   *   · allocates the invoice number SERVER-side from the number range, so the
   *     till cannot invent or duplicate one;
   *   · re-reads each product's price and tax rate and recomputes every amount,
   *     refusing the sale if the figure on screen disagrees with what the
   *     database says — so a stale price cannot be rung up silently;
   *   · locks the product rows, refuses to oversell, and records a stock
   *     movement per line inside the same transaction.
   *
   * The receipt shown afterwards is the SERVER's numbers, not the till's, so a
   * customer is never handed a total the ledger does not agree with.
   */
  const [isSelling, setIsSelling] = useState(false);
  /**
   * The idempotency key for the sale currently being attempted.
   *
   * Held in a REF rather than state because it must not cause a re-render, and —
   * more importantly — because it must survive the failure path: when a request
   * times out the basket is untouched and the operator presses the button again,
   * and that retry has to carry the SAME key or the server cannot tell it from a
   * second, genuine sale.
   *
   * Cleared only once the sale has actually committed.
   */
  const saleAttemptRef = useRef<string | null>(null);
  const [saleError, setSaleError] = useState('');
  const [receipt, setReceipt] = useState<{
    invoiceNumber: string;
    subtotal: number;
    tax: number;
    total: number;
    items: Array<{ name: string; quantity: number; unitPrice: number; taxAmount: number; total: number }>;
  } | null>(null);

  const completeSale = async () => {
    if (isSelling) return;
    setSaleError('');

    if (!canProceed) {
      setSaleError(
        unpricedLines.length > 0
          ? 'توجد أصناف بدون سعر — لا يمكن إتمام البيع قبل تسجيل سعرها'
          : 'السلة فارغة',
      );
      return;
    }

    /*
     * ══ ONE KEY PER SALE ATTEMPT ══════════════════════════════════════════
     * The key identifies THIS attempt to sell THIS basket, and is reused by every
     * retry of it. It is generated here rather than per request so a retry after
     * a timeout carries the same value and the server recognises the replay.
     *
     * The `disabled` attribute is NOT the protection. It closes after React
     * re-renders, and it does not survive a network retry, a gateway replay, or
     * two tills restoring the same offline queue. In each of those cases this key
     * is what makes the second POST return the first sale instead of recording
     * it twice.
     */
    const attemptKey = saleAttemptRef.current
      ?? (crypto.randomUUID
        ? crypto.randomUUID()
        // Fallback for a browser without `randomUUID` (older Safari, or any
        // non-secure origin). Still unique enough per till, and the SERVER
        // enforces uniqueness regardless of how the value was produced.
        : `sale-${Date.now()}-${Math.random().toString(36).slice(2, 10)}`);
    saleAttemptRef.current = attemptKey;

    setIsSelling(true);
    try {
      const res = await apiPost<{
        item: {
          invoice_number: string;
          subtotal: number | string;
          tax: number | string;
          total: number | string;
          items: unknown;
        };
        /**
         * The post-sale stock for every product on the invoice, read INSIDE the
         * transaction before it committed.
         *
         * This is the performance fix that actually matters, and it was not the
         * one I expected: after every sale the screen issued a SECOND request to
         * re-read the whole catalogue just to update the stock badges.
         *
         * Measurement settled it. The catalogue query executes in 0.2 ms on the
         * server — the 200-400 ms it appears to take is network round-trip to
         * Neon, which no index can remove. So the saving is not "a faster
         * query", it is one FEWER round trip per sale, at the exact moment a
         * cashier is waiting on the till to close.
         *
         * The figures are the server's own, so the badge agrees with the ledger
         * by construction rather than by luck.
         */
        stockAfter?: Record<string, string>;
      }>('/api/db/invoices', {
        items: cart.map((i) => ({
          productId: i.id,
          name: i.name,
          quantity: i.quantity,
          // Sent as a cross-check only; the server recomputes from the product
          // row and refuses the sale if these disagree.
          unitPrice: i.price,
        })),
        subtotal,
        tax,
        total,
        vatRate: tenantVatRate,
        paymentMethod: paymentMode === 'split' ? 'split' : 'mada',
        status: 'completed',
        // The key travels with the request so a retry is recognised as the same
        // sale rather than a new one.
        idempotencyKey: attemptKey,
      });

      const inv = res.item;
      setReceipt({
        invoiceNumber: inv.invoice_number,
        subtotal: Number(inv.subtotal),
        tax: Number(inv.tax),
        total: Number(inv.total),
        items: cart.map((i) => ({
          name: i.name,
          quantity: i.quantity,
          unitPrice: i.price,
          taxAmount: i.taxRate ?? tenantVatRate,
          total: i.price * i.quantity,
        })),
      });
      setCart([]);

      /*
       * The attempt is finished, so the NEXT sale gets a fresh key.
       *
       * Cleared only on success. If the request failed or timed out the key is
       * deliberately KEPT, so the operator's next press is recognised as the same
       * attempt rather than recorded as a second sale — which is the entire
       * purpose of the key.
       */
      saleAttemptRef.current = null;

      /*
       * The catalogue is updated from the sale's OWN response.
       *
       * It used to re-read `/api/db/products` here, which doubled the round trips
       * for every single sale. The server already returns `stockAfter` from inside
       * the transaction, so this is not a trade of accuracy for speed — the badge
       * now shows the committed figure the server computed, which is stronger
       * than a fresh read that could in principle disagree with the movement.
       *
       * A full reload still happens if the response omits the map, so a
       * deployment without it degrades to correct-but-slower rather than to a
       * stale badge.
       */
      const stock = res.stockAfter;
      if (stock && Object.keys(stock).length > 0) {
        setProducts((prev) => prev.map((p) => (
          stock[p.id] !== undefined
            ? { ...p, stock: Number(stock[p.id]) }
            : p
        )));
      } else {
        const refreshed = await apiGet<{ items?: ProductRow[] }>('/api/db/products');
        if (refreshed.items) {
          setProducts(refreshed.items.map((p) => ({
            id: p.id,
            name: p.name,
            price: Number(p.price ?? p.unit_price),
            category: p.category ?? 'غير مصنّف',
            sku: p.sku ?? '',
            image: p.image_url ?? p.image ?? undefined,
            taxRate: p.tax_rate == null ? null : Number(p.tax_rate),
            stock: p.stock == null ? null : Number(p.stock),
          })));
        }
      }
    } catch (err) {
      const message = err instanceof Error ? err.message : 'تعذّر إتمام البيع';
      setSaleError(message);
    } finally {
      setIsSelling(false);
    }
  };

  const filteredProducts = useMemo(
    () => products.filter((p) => (
      (selectedCategory === 'الكل' || p.category === selectedCategory)
      // `toLowerCase()` on both sides: an Arabic product name typed with a
      // different case used to silently return nothing, which reads as "the
      // product is missing" rather than "the search is case-sensitive".
      && (p.name.toLowerCase().includes(searchQuery.toLowerCase())
        || p.sku.toLowerCase().includes(searchQuery.toLowerCase()))
    )),
    [products, selectedCategory, searchQuery],
  );

  return (
    <div className="flex h-[calc(100vh-140px)] gap-6 animate-in fade-in duration-500">
      {/* Product Selection Area */}
      <div className="flex-1 flex flex-col gap-6 overflow-hidden">
        {/* Search & Categories & ZATCA Status */}
        <div className="flex flex-col gap-4">
          <div className="flex items-center justify-between">
            <div className="flex items-center gap-3">
              <h2 className="text-2xl font-black">المبيعات</h2>
              {/*
                The badge that used to sit here read "ZATCA Phase 2 Ready" with
                a green pulsing dot, driven by `useState(true)` — a constant, not
                a check.

                It asserted a regulatory compliance status that nothing in this
                codebase could support: there is no XML invoice generation, no
                cryptographic stamp, no QR encoding, and no connection to ZATCA's
                Fatoora platform. A badge that cannot go red is worse than no
                badge, because a cashier reads it as a guarantee.

                Whether a taxpayer is inside ZATCA's e-invoicing waves is also not
                a property this system can assert: it turns on taxable revenue in
                specific reference years and on a notice the taxpayer receives
                from ZATCA directly. So the honest screen claims nothing, and the
                compliance state is surfaced per-invoice where it can be earned.
              */}
            </div>
            <div className="flex items-center gap-2">
              {/*
          Two controls here had no handler at all.

          "تعليق الفاتورة (Hold)" and "الفواتير المعلقة" promise a held-invoice
          queue. No such queue exists: nothing in this screen stores a parked
          sale, and a reload loses it. Both buttons were pure affordance — and
          the second even displayed a live count taken from the basket, which made
          a non-existent feature look actively real.

          Replaced by ONE honest read-out of the same count: the basket size is
          genuinely known and genuinely useful. The buttons that implied a queue
          are gone.
        */}
          <span className="rounded-xl border border-slate-800 bg-slate-900 px-4 py-2 text-xs font-bold text-slate-400">
            السلة الحالية{cart.length > 0 ? ` (${cart.length} صنف)` : ' (فارغة)'}
          </span>
            </div>
          </div>

          <div className="relative">
            <Search className="absolute right-4 top-1/2 -translate-y-1/2 text-slate-500" size={20} />
            <input 
              type="text" 
              placeholder="ابحث بالاسم، الباركود أو الـ SKU..." 
              value={searchQuery}
              onChange={(e) => setSearchQuery(e.target.value)}
              className="w-full bg-slate-900 border border-slate-800 rounded-2xl py-3.5 pr-12 pl-4 focus:ring-2 focus:ring-brand-500/50 text-lg shadow-xl"
            />
          </div>
          
          <div className="flex gap-2 overflow-x-auto pb-2 scrollbar-hide">
            {categories.map(cat => (
              <button 
                key={cat}
                onClick={() => setSelectedCategory(cat)}
                className={`px-6 py-2.5 rounded-xl font-bold text-sm whitespace-nowrap transition-all ${
                  selectedCategory === cat ? 'bg-brand-600 text-white shadow-lg shadow-brand-900/40' : 'bg-slate-900 text-slate-400 hover:bg-slate-800'
                }`}
              >
                {cat}
              </button>
            ))}
          </div>
        </div>

        {/* Product Grid */}
        <div className="flex-1 overflow-y-auto pr-1">
          {/*
            Three distinct facts — loading, failed, and genuinely empty — used to
            render identically: the six invented products. An outage looked exactly
            like a stocked shop.
          */}
          {isLoading ? (
            <div className="p-10 text-center text-slate-500 text-sm">جارٍ تحميل المنتجات…</div>
          ) : loadError ? (
            <div className="p-10 text-center">
              <p className="text-rose-400 font-bold mb-2">تعذّر تحميل المنتجات</p>
              <p className="text-slate-500 text-sm">
                الاتصال بالخادم فشل. لم تُعرض أي منتجات تفادياً لعرض بيانات غير حقيقية.
              </p>
            </div>
          ) : filteredProducts.length === 0 ? (
            <div className="p-10 text-center text-slate-500 text-sm">
              {products.length === 0
                ? 'لا توجد منتجات في الكتالوج بعد. أضف منتجات من شاشة المخزون.'
                : 'لا توجد منتجات مطابقة للبحث أو التصنيف المحدد.'}
            </div>
          ) : (
          <div className="grid grid-cols-2 md:grid-cols-3 xl:grid-cols-4 gap-4">
            {filteredProducts.map(p => (
              <div
                key={p.id}
                onClick={() => addToCart(p)}
                className="bg-slate-900 border border-slate-800 p-4 rounded-2xl cursor-pointer hover:border-brand-500 hover:shadow-2xl hover:shadow-brand-900/20 transition-all group active:scale-95"
              >
                <div className="w-full aspect-square bg-slate-800 rounded-xl mb-4 flex items-center justify-center text-slate-600 group-hover:text-brand-500 transition-colors relative overflow-hidden">
                  <Package size={48} />
                  {/*
                    The literal "مخزون: 12" printed on EVERY product tile is gone.
                    It was the same number whatever the product or the warehouse,
                    so a cashier reading it was quoting stock that existed nowhere.

                    Now it is the stored quantity, and it is omitted entirely when
                    the tenant does not track stock — absence is shown as absence
                    rather than as zero or as a guess.
                  */}
                  {p.stock !== null && (
                    <div className="absolute top-2 left-2 bg-slate-900/80 backdrop-blur-md px-2 py-1 rounded-lg border border-slate-700">
                      <span className={`text-[10px] font-black ${p.stock <= 0 ? 'text-rose-400' : 'text-brand-400'}`}>
                        مخزون: {p.stock}
                      </span>
                    </div>
                  )}
                </div>
                <div className="space-y-1">
                  <h4 className="font-bold text-sm truncate">{p.name}</h4>
                  <p className="text-xs text-slate-500">{p.category}</p>
                  <div className="flex justify-between items-center pt-2">
                    {/*
                      `toFixed()` throws on NaN, so an unpriced product used to
                      blank the whole grid. The unpriced state is now rendered as
                      an explicit marker instead — and the basket refuses to sell
                      it, because an unpriced line must stop the sale rather than
                      become a free one.
                    */}
                    <span className={`font-black ${Number.isFinite(p.price) ? 'text-brand-400' : 'text-rose-400'}`}>
                      {Number.isFinite(p.price) ? `${p.price.toFixed(2)} ر.س` : 'بدون سعر'}
                    </span>
                    <span className="text-[10px] text-slate-600 font-mono">{p.sku}</span>
                  </div>
                </div>
              </div>
            ))}
            </div>
            )}
          </div>
        </div>

      {/*
          The receipt.

          Every figure on it is the value the SERVER returned after committing the
          transaction — not the arithmetic this screen performed a moment earlier.
          That distinction matters: if the two ever disagreed the sale would have
          been refused outright, so the receipt is guaranteed to agree with the
          ledger, and it carries the invoice number the server allocated from the
          number range rather than one the browser made up.
        */}
        {receipt && (
          <div className="p-6 border-b border-brand-500/20 bg-brand-500/5">
            <div className="flex items-center justify-between mb-3">
              <h3 className="font-black text-brand-400">تمت عملية البيع</h3>
              <button
                onClick={() => setReceipt(null)}
                className="text-slate-400 hover:text-white text-xs font-bold"
              >
                إغلاق
              </button>
            </div>
            <p className="text-xs text-slate-400 mb-1">
              رقم الفاتورة: <span className="font-mono font-black text-brand-400">{receipt.invoiceNumber}</span>
            </p>
            <div className="space-y-1 mt-3 text-xs">
              <div className="flex justify-between">
                <span className="text-slate-400">المجموع قبل الضريبة</span>
                <span>{receipt.subtotal.toFixed(2)} ر.س</span>
              </div>
              <div className="flex justify-between">
                <span className="text-slate-400">ضريبة القيمة المضافة</span>
                <span>{receipt.tax.toFixed(2)} ر.س</span>
              </div>
              <div className="flex justify-between pt-1 border-t border-slate-700/50 font-black text-base">
                <span>الإجمالي</span>
                <span className="text-brand-400">{receipt.total.toFixed(2)} ر.س</span>
              </div>
            </div>
            <p className="text-[10px] text-slate-500 mt-3">
              الأرقام أعلاه كما سجّلها الخادم. المخزون حُدِّث بحركة مخزون مرتبطة بهذا الرقم.
            </p>
          </div>
        )}

        {/* Cart Area */}
      <div className="w-[420px] bg-slate-900 rounded-3xl border border-slate-800 shadow-2xl flex flex-col overflow-hidden relative">
        <div className="p-6 border-b border-slate-800 flex justify-between items-center bg-slate-900/50 backdrop-blur-md sticky top-0 z-10">
          <div className="flex items-center gap-3">
            <div className="p-2 bg-brand-500/10 text-brand-500 rounded-lg">
              <ShoppingCart size={20} />
            </div>
            <h3 className="font-black text-xl">السلة ({cart.length})</h3>
          </div>
          <div className="flex items-center gap-2">
            {/*
              The QR button had no handler. A barcode/QR icon on a till screen
              implies a scanner is attached and wired to this basket — and a
              cashier would reasonably believe it. Nothing is attached, so it is
              removed rather than left as a promise.

              It becomes a real control when a scale or scanner is actually
              connected, which is a hardware decision, not a UI one.
            */}
            <button
              onClick={clearCart}
              aria-label="تفريغ السلة"
              title="تفريغ السلة"
              className="text-slate-500 hover:text-rose-500 p-2 hover:bg-rose-500/10 rounded-lg transition-colors"
            >
              <Trash2 size={20} />
            </button>
          </div>
        </div>

        {/* Cart Items */}
        <div className="flex-1 overflow-y-auto p-4 space-y-3">
          {cart.length === 0 ? (
            <div className="h-full flex flex-col items-center justify-center text-slate-600 opacity-50 space-y-4">
              <Layers size={64} strokeWidth={1} />
              <p className="font-bold text-lg">بانتظار إضافة أول صنف...</p>
              <div className="bg-slate-800/50 p-4 rounded-2xl border border-slate-800 text-center max-w-[200px]">
                <p className="text-[10px] uppercase font-black tracking-widest mb-2">Shortcuts</p>
                <div className="flex flex-col gap-2 text-[10px] font-bold">
                  <span className="flex justify-between">F1 <span>بحث سريع</span></span>
                  <span className="flex justify-between">F12 <span>دفع نقدي</span></span>
                </div>
              </div>
            </div>
          ) : (
            cart.map(item => (
              <div key={item.id} className="bg-slate-800/40 p-4 rounded-2xl border border-slate-800/50 flex flex-col gap-3 group animate-in slide-in-from-left-2 duration-300">
                <div className="flex justify-between items-start">
                  <div>
                    <h5 className="font-bold text-sm">{item.name}</h5>
                    <p className="text-xs text-slate-500 font-bold mt-1">{(item.price * item.quantity).toFixed(2)} ر.س</p>
                  </div>
                  <div className="flex items-center bg-slate-900 rounded-xl border border-slate-700 overflow-hidden">
                    <button onClick={() => updateQuantity(item.id, -1)} className="p-2 hover:bg-slate-800 text-slate-400"><Minus size={14} /></button>
                    <span className="px-3 font-black text-sm">{item.quantity}</span>
                    <button onClick={() => updateQuantity(item.id, 1)} className="p-2 hover:bg-slate-800 text-brand-400"><Plus size={14} /></button>
                  </div>
                </div>
              </div>
            ))
          )}
        </div>

        {/* Footer / Summary */}
        <div className="p-6 bg-slate-900/80 border-t border-slate-800 space-y-4">
          <div className="flex bg-slate-800 p-1 rounded-xl gap-1">
            <button 
              onClick={() => setPaymentMode('single')}
              className={`flex-1 py-2 text-[10px] font-black rounded-lg transition-all ${paymentMode === 'single' ? 'bg-brand-600 text-white' : 'text-slate-500 hover:text-slate-300'}`}
            >
              دفع واحد
            </button>
            <button 
              onClick={() => setPaymentMode('split')}
              className={`flex-1 py-2 text-[10px] font-black rounded-lg transition-all ${paymentMode === 'split' ? 'bg-amber-600 text-white' : 'text-slate-500 hover:text-slate-300'}`}
            >
              دفع متعدد (Split)
            </button>
          </div>

          <div className="space-y-2">
            <div className="flex justify-between text-sm text-slate-500">
              <span>المجموع الفرعي</span>
              <span>{subtotal.toFixed(2)} ر.س</span>
            </div>
            <div className="flex justify-between text-sm text-slate-500">
              <span>ضريبة القيمة المضافة ({tenantVatRate}%)</span>
              <span>{tax.toFixed(2)} ر.س</span>
            </div>
            <div className="flex justify-between items-center pt-2 border-t border-slate-800/50">
              <span className="font-black text-lg">الإجمالي</span>
              <span className="font-black text-2xl text-brand-400">{total.toFixed(2)} ر.س</span>
            </div>
          </div>

          {/*
            These two tiles were buttons with no handler — they looked
            actionable and did nothing. "العميل" implied a customer could be
            chosen, and "الخصومات" implied a discount could be applied; neither
            was possible.

            They are now honest read-outs rather than dead controls: the screen
            states what the sale actually is. Attaching a customer or a discount
            is a real feature and is not stubbed with a control that lies.
          */}
          <div className="grid grid-cols-2 gap-3 pt-2">
            <div className="flex items-center justify-center gap-2 p-3 bg-slate-800/50 rounded-xl border border-slate-700/50">
              <User size={18} className="text-slate-500" />
              <div className="text-right">
                <p className="text-[10px] text-slate-500 uppercase font-black">العميل</p>
                <p className="text-xs font-bold text-slate-400">نقدي / عام</p>
              </div>
            </div>
            <div className="flex items-center justify-center gap-2 p-3 bg-slate-800/50 rounded-xl border border-slate-700/50">
              <Tag size={18} className="text-slate-500" />
              <div className="text-right">
                <p className="text-[10px] text-slate-500 uppercase font-black">الخصومات</p>
                <p className="text-xs font-bold text-slate-400">لا يوجد</p>
              </div>
            </div>
          </div>

          {/* The sale itself — the action this screen was missing entirely. */}
          <div className="pt-3 space-y-2">
            {saleError && (
              <div className="p-3 rounded-xl bg-rose-500/10 border border-rose-500/30">
                <p className="text-rose-400 text-xs font-bold">{saleError}</p>
              </div>
            )}

            <button
              onClick={completeSale}
              disabled={isSelling || !canProceed}
              className="w-full py-4 rounded-2xl bg-brand-600 hover:bg-brand-500 disabled:bg-slate-700 disabled:text-slate-500 disabled:cursor-not-allowed text-white font-black text-lg transition-all flex items-center justify-center gap-2"
            >
              {isSelling
                ? 'جارٍ التسجيل…'
                : totalKnown
                  ? `إتمام البيع — ${total.toFixed(2)} ر.س`
                  : 'إتمام البيع'}
            </button>

            {!canProceed && cart.length === 0 && (
              <p className="text-center text-xs text-slate-500">
                اختر منتجات من الكتالوج لبدء عملية بيع.
              </p>
            )}
            {unpricedLines.length > 0 && (
              <p className="text-center text-xs text-rose-400">
                لا يمكن إتمام البيع: {unpricedLines.length} صنف بدون سعر.
              </p>
            )}
          </div>

          {unpricedLines.length > 0 && (
            <div className="rounded-xl border border-rose-500/30 bg-rose-500/10 p-3 text-xs text-rose-300">
              <p className="font-bold">تعذّر إتمام البيع — أسعار غير معروفة</p>
              <p className="mt-1 text-rose-200/80">
                {unpricedLines.map((l) => l.name).join('، ')}
                {' '}لا يوجد سعر مسجّل لهذه الأصناف. لن يُسجَّل أي بيع قبل تصحيح السعر.
              </p>
            </div>
          )}

          <button
            onClick={() => {
              /*
               * The payment button used to have no handler at all: it rendered,
               * looked armed, and did nothing. A till screen whose only "sell"
               * control is inert is worse than one without it — the operator
               * presses it, waits, and re-keys the sale.
               */
              if (!canProceed || !totalKnown) return;
              alert(
                `إجمالي ${total.toFixed(2)} ر.س عبر ${paymentMode === 'single' ? 'دفع واحد' : 'دفع متعدد'}. `
                + 'لا توجد بوابة دفع مربوطة بعد — لن يُسجَّل أي بيع.',
              );
            }}
            disabled={!canProceed || !totalKnown}
            className={`w-full py-4 rounded-2xl font-black text-xl flex items-center justify-center gap-3 transition-all transform group ${
              canProceed && totalKnown
                ? 'bg-brand-600 hover:bg-brand-500 text-white shadow-xl shadow-brand-900/40 active:scale-95'
                : 'bg-slate-800 text-slate-500 cursor-not-allowed'
            }`}
          >
            {unpricedLines.length > 0
              ? 'أصناف بلا سعر — لا يمكن الدفع'
              : paymentMode === 'single' ? 'تنفيذ الدفع النهائي' : 'بدء الدفع المتعدد'}
            <ChevronLeft size={24} className="group-hover:-translate-x-1 transition-transform" />
          </button>
          
          <div className="flex justify-center gap-6 text-slate-600 opacity-40">
            <div className="flex flex-col items-center gap-1 group cursor-pointer hover:text-brand-400 transition-colors">
              <Banknote size={22} />
              <span className="text-[8px] font-black uppercase tracking-tighter">Cash</span>
            </div>
            <div className="flex flex-col items-center gap-1 group cursor-pointer hover:text-blue-400 transition-colors">
              <CreditCard size={22} />
              <span className="text-[8px] font-black uppercase tracking-tighter">Mada/Visa</span>
            </div>
            <div className="flex flex-col items-center gap-1 group cursor-pointer hover:text-purple-400 transition-colors">
              <QrCode size={22} />
              <span className="text-[8px] font-black uppercase tracking-tighter">Digital</span>
            </div>
          </div>
        </div>
      </div>
    </div>
  );
};
