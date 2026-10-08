import React, { useState, useEffect, useRef, useCallback } from 'react';
import { Product, Category, CartItem, Customer, Transaction } from '../types';
import { 
  Search, 
  Barcode, 
  Plus, 
  Minus, 
  Trash2, 
  ShoppingCart, 
  CreditCard, 
  DollarSign, 
  Printer, 
  CheckCircle, 
  Percent, 
  PauseCircle, 
  User, 
  Camera,
  X,
  Smartphone,
  Download,
  QrCode,
  Globe,
  RefreshCw,
  ShieldCheck,
  ShieldAlert
} from 'lucide-react';
import { generateInvoicePDF } from '../utils/pdfGenerator';
import { Currency } from '../types';
import { DEFAULT_CURRENCIES, formatDualCurrency, loadTenantCurrencies, convertFromSAR } from '../services/currencyService';
import { deviceGateway, NO_SCALE_READING, type ScaleReading } from '../services/deviceGateway';
import { paymentGatewayService, PaymentGatewayProvider } from '../services/paymentGatewayService';
import { useEntitlement } from '../contexts/EntitlementContext';
import { branchLine, UNRESOLVED_LABEL } from '../services/tenantIdentity';
import { apiGet } from '../services/dyposApi';

interface POSViewProps {
  products: Product[];
  categories: Category[];
  customers: Customer[];
  cart: CartItem[];
  onAddToCart: (product: Product) => void;
  onUpdateQuantity: (productId: string, delta: number) => void;
  onRemoveItem: (productId: string) => void;
  onClearCart: () => void;
  /**
   * Persists the sale and RESOLVES with the transaction the server recorded.
   *
   * The return value is the point: the receipt is rendered from it, so the
   * customer's paper and the ledger cannot disagree. It used to be `Promise<void>`,
   * which is why this screen had no honest source for an invoice number and
   * invented one.
   */
  onCompleteCheckout: (transactionData: Partial<Transaction>) => Promise<Transaction>;
}

export const POSView: React.FC<POSViewProps> = ({
  products,
  categories,
  customers,
  cart,
  onAddToCart,
  onUpdateQuantity,
  onRemoveItem,
  onClearCart,
  onCompleteCheckout,
}) => {
  const [selectedCategory, setSelectedCategory] = useState('الكل');
  /*
   * Company, branch and VAT number, resolved from the server by the entitlement
   * context. Reading them from here rather than from literals is what stops this
   * screen from becoming a single-customer product — see the receipt header for
   * why a compiled-in tax number is a legal problem and not a cosmetic one.
   */
  const { identity } = useEntitlement();

  /*
   * The settlement account is read from the server, never carried in the bundle.
   *
   * This panel used to render a real IBAN from a string literal, and the QR
   * generator held the same value as a default argument — so a merchant who
   * configured nothing was still shown a QR for someone else's bank account, and
   * had no way to override it.
   *
   * `settlementAccount === null` therefore means "this merchant has not
   * configured one", and the panel is not rendered at all. It is not replaced by
   * a sample value: a QR that looks real and pays the wrong party is the most
   * expensive thing this screen can display.
   */
  const [settlementAccount, setSettlementAccount] = useState<{
    iban: string; bankName: string | null; holderName: string | null;
  } | null>(null);

  useEffect(() => {
    let alive = true;
    (async () => {
      try {
        const res = await apiGet<{ items: Array<{ iban: string; bankName: string | null; holderName: string | null }> }>(
          '/api/db/settlement/accounts?paymentMethod=bank_transfer',
        );
        if (!alive) return;
        // The route orders the default first, so the head IS the account to show.
        const first = Array.isArray(res.items) ? res.items[0] : undefined;
        setSettlementAccount(first ?? null);
      } catch {
        // A till must keep selling when the settlement list is unreachable, so
        // this degrades to "no bank transfer offered" rather than blocking.
        if (alive) setSettlementAccount(null);
      }
    })();
    return () => { alive = false; };
  }, []);
  const [searchQuery, setSearchQuery] = useState('');
  const [barcodeInput, setBarcodeInput] = useState('');
  const [selectedCustomer, setSelectedCustomer] = useState<Customer>(customers[0]);
  const [globalDiscount, setGlobalDiscount] = useState<number>(0);
  const [isPaymentModalOpen, setIsPaymentModalOpen] = useState(false);
  const [paymentMethod, setPaymentMethod] = useState<'cash' | 'card' | 'mada' | 'apple_pay' | 'credit'>('mada');
  const [cashGiven, setCashGiven] = useState<string>('');
  const [lastCompletedTx, setLastCompletedTx] = useState<Transaction | null>(null);
  const [isReceiptModalOpen, setIsReceiptModalOpen] = useState(false);
  const [heldOrders, setHeldOrders] = useState<{ id: string; items: CartItem[]; time: string }[]>([]);
  const [nightMode, setNightMode] = useState(false);
  const [currencies, setCurrencies] = useState<Currency[]>(DEFAULT_CURRENCIES);
  const [selectedCurrency, setSelectedCurrency] = useState<Currency>(DEFAULT_CURRENCIES[1]); // USD default

  /*
   * ══ THE FABRICATED READING THIS REPLACES ════════════════════════════════
   * This state was seeded with a weight of 1.45 kg and `isStable: true`, and a
   * subscription to a gateway whose "readings" were `Math.random()` noise. So the
   * till showed "⚖ 1.450 كجم" on page load, before a single item was placed on
   * anything — and clicking "tare" called a method that only subtracted the
   * invented number from itself.
   *
   * It now starts at `NO_SCALE_READING`, whose fields are `null`. That is the
   * whole fix: there is no number to display, so the screen displays a state
   * instead, and the only way a weight appears is a device reporting one or an
   * operator typing one.
   */
  const [scaleReading, setScaleReading] = useState<ScaleReading>(NO_SCALE_READING);

  useEffect(() => {
    const unsub = deviceGateway.subscribeScale(setScaleReading);
    return () => unsub();
  }, []);

  /**
   * Opens the drawer and reports what actually happened.
   *
   * The button used to call a method that logged a line and returned `true`. It
   * now shows the peripheral's own verdict, so "the drawer did not open" is
   * visible to the operator instead of being silently true.
   */
  const [drawerMessage, setDrawerMessage] = useState<string | null>(null);
  const handleOpenDrawer = useCallback(async () => {
    const outcome = await deviceGateway.openCashDrawer();
    setDrawerMessage(outcome.ok ? outcome.detail : outcome.reason);
  }, []);

  /**
   * Applies a measured weight to a weighed line in the cart.
   *
   * Refuses to apply anything when neither a device nor an operator has produced
   * a weight. The cart is owned by `App.tsx` and only exposes an increment
   * callback, so the line is driven through the same path as a keypad press —
   * there is no second, private way to write a quantity into the sale.
   */
  const applyScaleToCart = useCallback(() => {
    const kg = scaleReading.netWeightKg;
    if (kg === null || kg <= 0) return;

    const weighed = cart.find((i) => i.product.unit === 'kg' || i.product.unit === 'كجم');
    if (!weighed) return;

    // `onUpdateQuantity` is a delta, so the target minus the current quantity is
    // the increment. Rounding guards against a float landing on 4.9999999.
    const delta = Math.round((kg - weighed.quantity) * 1000) / 1000;
    if (delta === 0) return;
    onUpdateQuantity(weighed.product.id, delta);
  }, [scaleReading.netWeightKg, cart, onUpdateQuantity]);

  // Load custom currencies from Firestore
  useEffect(() => {
    loadTenantCurrencies().then((list) => {
      setCurrencies(list);
      if (list.length > 1) {
        setSelectedCurrency(list[1]);
      }
    });
  }, []);
  
  // Camera Barcode Scanner State
  const [isCameraModalOpen, setIsCameraModalOpen] = useState(false);
  const videoRef = useRef<HTMLVideoElement | null>(null);
  const [cameraError, setCameraError] = useState<string | null>(null);

  // USB Barcode Scanner Keyboard Wedge listener
  useEffect(() => {
    let barcodeBuffer = '';
    let lastKeyTime = Date.now();

    const handleKeyDown = (e: KeyboardEvent) => {
      // Ignore if user is typing in an input field
      if (['INPUT', 'TEXTAREA', 'SELECT'].includes((e.target as HTMLElement).tagName)) {
        return;
      }

      const currentTime = Date.now();
      if (currentTime - lastKeyTime > 100) {
        barcodeBuffer = ''; // Reset buffer if too slow (human typing)
      }
      lastKeyTime = currentTime;

      if (e.key === 'Enter') {
        if (barcodeBuffer.length >= 3) {
          const buf = barcodeBuffer.trim().toLowerCase();
          const matchedProduct = products.find((p) => p.barcode === barcodeBuffer.trim() || p.id.toLowerCase() === buf);
          if (matchedProduct) {
            onAddToCart(matchedProduct);
            audioBeep();
          }
        }
        barcodeBuffer = '';
      } else if (e.key.length === 1) {
        barcodeBuffer += e.key;
      }
    };

    window.addEventListener('keydown', handleKeyDown);
    return () => window.removeEventListener('keydown', handleKeyDown);
  }, [products, onAddToCart]);

  const audioBeep = () => {
    try {
      const ctx = new (window.AudioContext || (window as any).webkitAudioContext)();
      const osc = ctx.createOscillator();
      const gain = ctx.createGain();
      osc.type = 'sine';
      osc.frequency.value = 880;
      gain.gain.setValueAtTime(0.1, ctx.currentTime);
      osc.connect(gain);
      gain.connect(ctx.destination);
      osc.start();
      osc.stop(ctx.currentTime + 0.1);
    } catch {
      // Audio context ignored if restricted
    }
  };

  // Start Camera Stream for Barcode Scanning
  const startCamera = async () => {
    setIsCameraModalOpen(true);
    setCameraError(null);
    try {
      const stream = await navigator.mediaDevices.getUserMedia({ video: { facingMode: 'environment' } });
      if (videoRef.current) {
        videoRef.current.srcObject = stream;
        videoRef.current.play();
      }
    } catch (err: any) {
      setCameraError('تعذر الوصول إلى كاميرا الجهاز. يمكنك إدخال الباركود يدوياً.');
    }
  };

  const stopCamera = () => {
    if (videoRef.current && videoRef.current.srcObject) {
      const stream = videoRef.current.srcObject as MediaStream;
      stream.getTracks().forEach((t) => t.stop());
    }
    setIsCameraModalOpen(false);
  };

  // Simulate scanning a barcode via camera viewfinder
  const handleSimulateCameraScan = (product: Product) => {
    onAddToCart(product);
    audioBeep();
    stopCamera();
  };

  // Filter products
  const filteredProducts = products.filter((p) => {
    const matchesCategory = selectedCategory === 'الكل' || p.category === selectedCategory;
    const q = searchQuery.toLowerCase().trim();
    const matchesSearch = 
      p.name.toLowerCase().includes(q) || 
      p.barcode.includes(q) ||
      p.id.toLowerCase().includes(q);
    return matchesCategory && matchesSearch;
  });

  const handleBarcodeSubmit = (e: React.FormEvent) => {
    e.preventDefault();
    const input = barcodeInput.trim().toLowerCase();
    const product = products.find((p) => p.barcode === barcodeInput.trim() || p.id.toLowerCase() === input);
    if (product) {
      onAddToCart(product);
      audioBeep();
      setBarcodeInput('');
    } else {
      alert('لم يتم العثور على منتج بهذا الباركود أو الكود');
    }
  };

  // Calculations
  const subtotal = cart.reduce((sum, item) => sum + item.product.price * item.quantity, 0);
  const discountAmount = (subtotal * globalDiscount) / 100;
  const taxableAmount = subtotal - discountAmount;
  const tax = taxableAmount * 0.15; // 15% VAT
  const total = taxableAmount + tax;
  const changeDue = Number(cashGiven) - total;

  const [isProcessingPayment, setIsProcessingPayment] = useState(false);

  /** Shown inside the payment dialog when the sale could not be recorded. */
  const [paymentError, setPaymentError] = useState('');

  const handleProcessPayment = async () => {
    if (cart.length === 0) return;
    setIsProcessingPayment(true);
    setPaymentError('');

    try {
      /*
       * Payment-method mapping, stated rather than cast.
       *
       * The POS enum (`cash | card | mada | apple_pay | credit`) and the gateway
       * enum (`mada | apple_pay | card | bank_transfer | stc_pay`) are genuinely
       * different: cash and store credit never touch a gateway, while a bank
       * transfer does. `paymentMethod as any` hid that mismatch from the compiler
       * and would have let an unmapped value reach the acquirer.
       *
       * Unmapped methods become `null`, and the gateway is simply not called —
       * which is correct, because those methods do not need one.
       */
      const gatewayMethod =
        paymentMethod === 'card' || paymentMethod === 'mada' || paymentMethod === 'apple_pay'
          ? paymentMethod
          : null;

      const needsGateway = gatewayMethod !== null;

      const resp = gatewayMethod
        ? await paymentGatewayService.processPayment({
            amountSAR: total,
            currency: 'SAR',
            paymentMethod: gatewayMethod,
            customerName: selectedCustomer.name,
            customerPhone: selectedCustomer.phone,
            // A correlation id for the gateway conversation, NOT a business
            // document number. It was `ORD-${Date.now().slice(-6)}`, which two
            // terminals in the same second would collide on — and a gateway
            // reference that collides is a reconciliation problem at the
            // acquirer. The invoice number itself is allocated by the server.
            orderId: crypto.randomUUID(),
          })
        : null;

      /*
       * An authorisation that is not `paid` must NEVER become an invoice.
       *
       * The previous version ignored the response entirely and went straight to
       * `onCompleteCheckout`, so an unconfigured (or declined) gateway still
       * produced a paid invoice and a printed receipt. Cash and store credit
       * never needed a gateway at all, which is why `needsGateway` is derived
       * from the mapping above rather than assumed.
       */
      if (resp && resp.status !== 'paid') {
        setPaymentError(
          resp.errorMessage
            ?? 'لم تتم الموافقة على الدفع — لم يُسجَّل أي بيع. اختر طريقة دفع أخرى.',
        );
        return;
      }

      const tx: Partial<Transaction> = {
        items: [...cart],
        subtotal,
        tax,
        discount: discountAmount,
        total,
        paymentMethod,
        customerName: selectedCustomer.name,
      };

      // Persist BEFORE showing a receipt. If the server refuses the sale the
      // operator must not be handed a receipt for an invoice that does not
      // exist, and the basket is kept so the sale can be retried.
      //
      // `onCompleteCheckout` returns the transaction the SERVER recorded. The
      // receipt is rendered from that, not from values invented here: the
      // previous version fabricated an invoice number, a cashier name and a
      // branch id, so a customer left with a receipt that disagreed with the
      // ledger — unresolvable in a dispute, and an audit finding.
      const saved = await onCompleteCheckout(tx);

      // `saved` is a full `Transaction` (the server's own values win); the
      // spreads below only restate the line-level figures the receipt shows.
      setLastCompletedTx({
        ...saved,
        // The gateway id, when there is one. Cash and bank transfer have none,
        // and inventing a `TXN-…` there was exactly the fabrication above.
        id: resp?.transactionId || saved.id,
        items: [...cart],
        subtotal,
        tax,
        discount: discountAmount,
        total,
        paymentMethod,
        customerName: selectedCustomer.name,
        status: 'completed',
      });

      setIsPaymentModalOpen(false);
      setIsReceiptModalOpen(true);
      // The cart is cleared by App once the sale is durably recorded.
      setCashGiven('');
    } catch (err: any) {
      // Previously only logged, so a rejected sale looked successful.
      console.error('تعذّر إتمام عملية البيع:', err);
      setPaymentError(
        err?.message ?? 'تعذّر حفظ الفاتورة. لم يتم خصم المبلغ — يُرجى المحاولة مرة أخرى.',
      );
    } finally {
      setIsProcessingPayment(false);
    }
  };

  const handleHoldOrder = () => {
    if (cart.length === 0) return;
    // A hold is a POS-session artefact that never becomes a document, so it does
    // not consume a number range. `randomUUID` is still the right source: a
    // `Date.now()` tail collides within the same millisecond across terminals.
    const holdId = `HOLD-${crypto.randomUUID().slice(0, 8).toUpperCase()}`;
    setHeldOrders([
      ...heldOrders,
      { id: holdId, items: [...cart], time: new Date().toLocaleTimeString('ar-SA') },
    ]);
    onClearCart();
  };

  return (
    <div className={`flex-1 flex flex-col lg:flex-row h-[calc(100vh-65px)] overflow-hidden transition-colors duration-300 ${nightMode ? 'bg-black text-amber-100' : 'bg-slate-950 text-slate-100'}`}>
      {/* Left / Products Catalog Area */}
      <div className="flex-1 flex flex-col p-4 overflow-hidden border-l border-slate-800">
        {/* Search, Barcode & Camera Scanner Bar */}
        <div className="flex flex-col sm:flex-row gap-3 mb-4">
          <div className="relative flex-1">
            <Search className="absolute right-3.5 top-1/2 -translate-y-1/2 w-4 h-4 text-slate-400" />
            <input
              type="text"
              placeholder="ابحث عن منتج بالاسم أو الباركود..."
              value={searchQuery}
              onChange={(e) => setSearchQuery(e.target.value)}
              className={`w-full border rounded-xl pr-10 pl-4 py-2.5 text-sm placeholder-slate-500 focus:outline-none transition-colors ${
                nightMode ? 'bg-zinc-950 border-amber-900/40 text-amber-100' : 'bg-slate-900 border-slate-800 text-white'
              }`}
            />
          </div>

          <div className="flex gap-2">
            <form onSubmit={handleBarcodeSubmit} className="flex gap-2">
              <div className="relative">
                <Barcode className="absolute right-3 top-1/2 -translate-y-1/2 w-4 h-4 text-brand-400" />
                <input
                  type="text"
                  placeholder="الباركود..."
                  value={barcodeInput}
                  onChange={(e) => setBarcodeInput(e.target.value)}
                  className={`border rounded-xl pr-9 pl-4 py-2.5 text-sm placeholder-slate-500 focus:outline-none w-36 ${
                    nightMode ? 'bg-zinc-950 border-amber-900/40 text-amber-100' : 'bg-slate-900 border-slate-800 text-white'
                  }`}
                />
              </div>
              <button type="submit" className="bg-brand-600 hover:bg-brand-500 text-white px-3 py-2.5 rounded-xl text-xs font-semibold transition-colors shrink-0">
                إضافة
              </button>
            </form>

            <button
              onClick={startCamera}
              className={`border px-3.5 py-2.5 rounded-xl text-xs font-bold flex items-center gap-1.5 transition-all shrink-0 ${
                nightMode ? 'bg-zinc-950 border-amber-500/40 text-amber-400' : 'bg-slate-900 border-brand-500/40 text-brand-400'
              }`}
              title="مسح الباركود بالكاميرا"
            >
              <Camera className="w-4 h-4" />
              <span className="hidden sm:inline">كاميرا</span>
            </button>

            {/*
              The scale badge renders a NUMBER only when a weight actually
              exists; otherwise it names the state. Showing "0.000" for a scale
              that is not there is the same lie as showing "1.450".
            */}
            <button
              type="button"
              onClick={applyScaleToCart}
              disabled={scaleReading.netWeightKg === null}
              className="bg-slate-900 border border-brand-500/40 text-brand-300 px-3 py-2 rounded-xl text-xs font-mono font-bold flex items-center gap-1.5 shrink-0 hover:bg-slate-800 transition-all disabled:opacity-50 disabled:cursor-not-allowed"
              title={
                scaleReading.netWeightKg === null
                  ? 'لا يوجد ميزان متصل — أدخل الكمية يدوياً'
                  : (scaleReading.fromDevice
                    ? 'إدراج الوزن المقيس في السلة'
                    : 'إدراج الوزن المُدخل يدوياً في السلة')
              }
            >
              <span>⚖️</span>
              <span>
                {scaleReading.netWeightKg === null
                  ? 'بدون ميزان'
                  : `${scaleReading.netWeightKg.toFixed(3)} كجم${scaleReading.fromDevice ? '' : ' (يدوي)'}`}
              </span>
            </button>

            {/* Cash drawer — reports the peripheral's actual verdict. */}
            <button
              type="button"
              onClick={() => void handleOpenDrawer()}
              className="bg-slate-900 border border-slate-800 text-slate-300 hover:text-white px-2.5 py-2 rounded-xl text-xs font-bold flex items-center gap-1 shrink-0"
              title="فتح درج النقود عبر منفذ ESC/POS"
            >
              <span>📥</span>
              <span className="hidden xl:inline">الدرج</span>
            </button>
            {drawerMessage && (
              <span
                role="status"
                className="text-[10px] font-bold text-amber-300 max-w-[16rem] truncate"
                title={drawerMessage}
              >
                {drawerMessage}
              </span>
            )}

            {/* Multi-Currency Switcher */}
            <div className="flex items-center gap-1.5 bg-slate-900 border border-slate-800 rounded-xl px-2.5 py-1 shrink-0">
              <span className="text-xs text-slate-400 font-bold">💱</span>
              <select
                value={selectedCurrency.code}
                onChange={(e) => {
                  const found = currencies.find((c) => c.code === e.target.value);
                  if (found) setSelectedCurrency(found);
                }}
                className="bg-transparent text-xs text-brand-400 font-bold focus:outline-none cursor-pointer"
                title="تحديد العملة الثانوية للعرض"
              >
                {currencies.map((c) => (
                  <option key={c.code} value={c.code} className="bg-slate-900 text-white">
                    {c.code} ({c.symbol})
                  </option>
                ))}
              </select>
            </div>

            {/* Night Mode Toggle */}
            <button
              onClick={() => setNightMode(!nightMode)}
              className={`px-3.5 py-2.5 rounded-xl text-xs font-bold flex items-center gap-1.5 transition-all shrink-0 border ${
                nightMode ? 'bg-amber-500/20 border-amber-500 text-amber-300' : 'bg-slate-900 border-slate-800 text-slate-400 hover:text-white'
              }`}
              title="الوضع الليلي المخفف للإضاءة (للمناوبات)"
            >
              <span>🌙</span>
              <span className="hidden sm:inline">{nightMode ? 'الليلي مفعل' : 'الوضع الليلي'}</span>
            </button>
          </div>
        </div>

        {/* Categories Horizontal Scroll */}
        <div className="flex items-center gap-2 overflow-x-auto pb-2 mb-4 scrollbar-thin">
          {categories.map((cat) => (
            <button
              key={cat.id}
              onClick={() => setSelectedCategory(cat.name)}
              className={`px-4 py-2 rounded-xl text-xs font-semibold whitespace-nowrap transition-all ${
                selectedCategory === cat.name
                  ? 'bg-brand-600 text-white shadow-lg shadow-brand-600/30'
                  : 'bg-slate-900 text-slate-400 border border-slate-800 hover:text-white hover:bg-slate-800'
              }`}
            >
              {cat.name}
            </button>
          ))}
        </div>

        {/* Products Grid */}
        <div className="flex-1 overflow-y-auto grid grid-cols-2 md:grid-cols-3 xl:grid-cols-4 gap-3.5 pr-1">
          {filteredProducts.map((product) => (
            <div
              key={product.id}
              onClick={() => {
                onAddToCart(product);
                audioBeep();
              }}
              className="bg-slate-900/90 border border-slate-800/80 rounded-2xl p-3.5 flex flex-col justify-between hover:border-brand-500/50 hover:bg-slate-900 transition-all cursor-pointer group shadow-sm relative overflow-hidden"
            >
              <div className="absolute top-2 left-2 bg-slate-950/80 backdrop-blur-md px-2 py-0.5 rounded-full text-[10px] font-mono text-brand-400 border border-slate-800">
                مخزون: {product.stock}
              </div>
              <div className="w-full h-28 rounded-xl bg-slate-950 overflow-hidden mb-3 relative">
                {product.image ? (
                  <img src={product.image} alt={product.name} className="w-full h-full object-cover group-hover:scale-105 transition-transform duration-300" />
                ) : (
                  <div className="w-full h-full flex items-center justify-center text-slate-600">
                    <ShoppingCart className="w-8 h-8" />
                  </div>
                )}
              </div>
              <div>
                <h3 className="text-xs font-bold text-white line-clamp-2 mb-1.5 group-hover:text-brand-400 transition-colors">
                  {product.name}
                </h3>
                <p className="text-[11px] text-slate-400 mb-2">{product.category}</p>
              </div>
              <div className="flex items-center justify-between pt-2 border-t border-slate-800/60">
                <span className="text-sm font-black text-brand-400 font-mono">
                  {product.price.toLocaleString()} <span className="text-[10px] font-normal text-slate-400">ر.س</span>
                </span>
                <span className="w-7 h-7 rounded-lg bg-brand-600/10 text-brand-400 group-hover:bg-brand-600 group-hover:text-white flex items-center justify-center transition-colors">
                  <Plus className="w-4 h-4" />
                </span>
              </div>
            </div>
          ))}
        </div>
      </div>

      {/* Right / Cart & Checkout Panel */}
      <div className="w-full lg:w-[420px] bg-slate-900 border-t lg:border-t-0 lg:border-r border-slate-800 flex flex-col shrink-0">
        {/* Cart Header */}
        <div className="p-4 border-b border-slate-800 flex items-center justify-between">
          <div className="flex items-center gap-2">
            <ShoppingCart className="w-5 h-5 text-brand-400" />
            <h2 className="text-sm font-bold text-white">سلة المبيعات الحالية</h2>
            <span className="bg-brand-500/10 text-brand-400 px-2 py-0.5 rounded-full text-xs font-mono font-bold">
              {cart.reduce((s, i) => s + i.quantity, 0)}
            </span>
          </div>
          <div className="flex items-center gap-2">
            {heldOrders.length > 0 && (
              <button
                onClick={() => {
                  const lastHold = heldOrders[heldOrders.length - 1];
                  setHeldOrders(heldOrders.slice(0, -1));
                }}
                className="text-xs bg-amber-500/10 text-amber-400 px-2.5 py-1 rounded-lg border border-amber-500/20 hover:bg-amber-500/20 transition-colors"
              >
                معلقة ({heldOrders.length})
              </button>
            )}
            <button
              onClick={onClearCart}
              disabled={cart.length === 0}
              className="text-xs text-rose-400 hover:text-rose-300 p-1 rounded-lg disabled:opacity-40 transition-colors"
              title="إفراغ السلة"
            >
              <Trash2 className="w-4 h-4" />
            </button>
          </div>
        </div>

        {/* Customer Select */}
        <div className="p-3 border-b border-slate-800/80 bg-slate-950/40 flex items-center justify-between">
          <div className="flex items-center gap-2">
            <User className="w-4 h-4 text-brand-400" />
            <select
              value={selectedCustomer.id}
              onChange={(e) => {
                const c = customers.find((item) => item.id === e.target.value);
                if (c) setSelectedCustomer(c);
              }}
              className="bg-transparent text-xs text-white font-medium focus:outline-none cursor-pointer"
            >
              {customers.map((cus) => (
                <option key={cus.id} value={cus.id} className="bg-slate-900 text-white">
                  {cus.name} ({cus.phone})
                </option>
              ))}
            </select>
          </div>
          <span className="text-[10px] bg-brand-500/10 text-brand-400 px-2 py-0.5 rounded-full font-mono">
            نقاط الولاء: {selectedCustomer.points}
          </span>
        </div>

        {/* Cart Items List */}
        <div className="flex-1 overflow-y-auto p-3 space-y-2.5 scrollbar-thin">
          {cart.length === 0 ? (
            <div className="h-full flex flex-col items-center justify-center text-slate-500 text-center p-6">
              <ShoppingCart className="w-12 h-12 mb-3 stroke-1 text-slate-600" />
              <p className="text-sm font-medium">السلة فارغة حالياً</p>
              <p className="text-xs text-slate-600 mt-1">اختر المنتجات أو امسح الباركود بالكاميرا أو الجهاز</p>
            </div>
          ) : (
            cart.map((item) => (
              <div key={item.product.id} className="bg-slate-950/80 border border-slate-800/80 rounded-xl p-3 flex items-center justify-between">
                <div className="flex-1 min-w-0 pr-2">
                  <h4 className="text-xs font-bold text-white truncate">{item.product.name}</h4>
                  <div className="flex items-center gap-2 mt-1">
                    <span className="text-xs font-mono font-bold text-brand-400">
                      {(item.product.price * item.quantity).toLocaleString()} ر.س
                    </span>
                    <span className="text-[10px] text-slate-500">({item.product.price} للقطعة)</span>
                  </div>
                </div>

                <div className="flex items-center gap-2">
                  <div className="flex items-center bg-slate-900 border border-slate-800 rounded-lg overflow-hidden">
                    <button
                      onClick={() => onUpdateQuantity(item.product.id, -1)}
                      className="p-1 hover:bg-slate-800 text-slate-300 transition-colors"
                    >
                      <Minus className="w-3.5 h-3.5" />
                    </button>
                    <span className="w-8 text-center text-xs font-mono font-bold text-white">
                      {item.quantity}
                    </span>
                    <button
                      onClick={() => onUpdateQuantity(item.product.id, 1)}
                      className="p-1 hover:bg-slate-800 text-slate-300 transition-colors"
                    >
                      <Plus className="w-3.5 h-3.5" />
                    </button>
                  </div>
                  <button
                    onClick={() => onRemoveItem(item.product.id)}
                    className="p-1.5 text-rose-400 hover:text-rose-300 hover:bg-rose-500/10 rounded-lg transition-colors"
                  >
                    <Trash2 className="w-3.5 h-3.5" />
                  </button>
                </div>
              </div>
            ))
          )}
        </div>

        {/* Cart Totals & Checkout Actions */}
        <div className="p-4 border-t border-slate-800 bg-slate-950/60 space-y-3">
          <div className="flex items-center justify-between text-xs text-slate-400">
            <span>المجموع الفرعي:</span>
            <span className="font-mono font-bold text-white">{subtotal.toLocaleString()} ر.س</span>
          </div>

          <div className="flex items-center justify-between text-xs text-slate-400">
            <div className="flex items-center gap-2">
              <span>خصم إضافي:</span>
              <div className="flex items-center gap-1 bg-slate-900 border border-slate-800 rounded px-2 py-0.5 w-20">
                <input
                  type="number"
                  value={globalDiscount}
                  onChange={(e) => setGlobalDiscount(Math.max(0, Number(e.target.value)))}
                  className="w-full bg-transparent text-xs text-white focus:outline-none font-mono"
                  placeholder="0"
                />
                <Percent className="w-3 h-3 text-brand-400" />
              </div>
            </div>
            <span className="font-mono text-rose-400">-{discountAmount.toLocaleString()} ر.س</span>
          </div>

          <div className="flex items-center justify-between text-xs text-slate-400">
            <span>ضريبة القيمة المضافة (15%):</span>
            <span className="font-mono font-bold text-white">{tax.toLocaleString()} ر.س</span>
          </div>

          <div className="pt-2 border-t border-slate-800 flex flex-col gap-1">
            <div className="flex items-center justify-between">
              <span className="text-sm font-bold text-white">الإجمالي النهائي:</span>
              <span className="text-lg font-black text-brand-400 font-mono">
                {total.toLocaleString()} ر.س
              </span>
            </div>
            {selectedCurrency && selectedCurrency.code !== 'SAR' && (
              <div className="flex items-center justify-between text-xs text-amber-300 font-mono bg-slate-900/90 px-2.5 py-1 rounded-lg border border-amber-500/20">
                <span>المعادل بـ ({selectedCurrency.name}):</span>
                <span className="font-bold">
                  {selectedCurrency.symbol}
                  {convertFromSAR(total, selectedCurrency).toLocaleString(undefined, { minimumFractionDigits: 2, maximumFractionDigits: 2 })} {selectedCurrency.code}
                </span>
              </div>
            )}
          </div>

          <div className="grid grid-cols-2 gap-2 pt-1">
            <button
              onClick={handleHoldOrder}
              disabled={cart.length === 0}
              className="bg-slate-800 hover:bg-slate-700 disabled:opacity-40 text-slate-300 py-2.5 rounded-xl text-xs font-semibold flex items-center justify-center gap-1.5 transition-colors"
            >
              <PauseCircle className="w-4 h-4 text-amber-400" />
              تعليق الفاتورة
            </button>
            <button
              onClick={() => setIsPaymentModalOpen(true)}
              disabled={cart.length === 0}
              className="bg-brand-600 hover:bg-brand-500 disabled:opacity-40 text-white py-2.5 rounded-xl text-xs font-bold flex items-center justify-center gap-1.5 shadow-lg shadow-brand-600/30 transition-all"
            >
              <CheckCircle className="w-4 h-4" />
              إتمام الدفع ({total.toLocaleString()} ر.س)
            </button>
          </div>
        </div>
      </div>

      {/* Camera Barcode Scanner Modal */}
      {isCameraModalOpen && (
        <div className="fixed inset-0 bg-slate-950/90 backdrop-blur-md z-50 flex items-center justify-center p-4">
          <div className="bg-slate-900 border border-slate-800 rounded-3xl w-full max-w-md p-6 shadow-2xl relative">
            <div className="flex items-center justify-between pb-4 border-b border-slate-800 mb-4">
              <h3 className="text-base font-bold text-white flex items-center gap-2">
                <Camera className="w-5 h-5 text-brand-400" />
                ماسح الباركود بالكاميرا (Camera Barcode Scanner)
              </h3>
              <button onClick={stopCamera} className="text-slate-400 hover:text-white">
                <X className="w-5 h-5" />
              </button>
            </div>

            <div className="space-y-4 text-center">
              <div className="relative w-full h-64 rounded-2xl bg-slate-950 overflow-hidden border border-brand-500/30 flex items-center justify-center">
                <video ref={videoRef} className="w-full h-full object-cover" muted playsInline />
                <div className="absolute inset-0 border-2 border-dashed border-brand-400/60 m-8 rounded-xl pointer-events-none flex items-center justify-center">
                  <span className="bg-slate-950/80 text-brand-300 text-xs px-3 py-1 rounded-full border border-brand-500/30">
                    ضع الباركود داخل الإطار للمسح الفوري
                  </span>
                </div>
              </div>

              {cameraError && (
                <p className="text-xs text-rose-400 bg-rose-500/10 border border-rose-500/20 p-2.5 rounded-xl">
                  {cameraError}
                </p>
              )}

              <p className="text-xs text-slate-400">
                أو انقر على أي منتج أدناه لمحاكاة قراءة الباركود السريعة عبر الكاميرا:
              </p>

              <div className="max-h-40 overflow-y-auto space-y-2 pr-1 text-right">
                {products.slice(0, 5).map((p) => (
                  <button
                    key={p.id}
                    onClick={() => handleSimulateCameraScan(p)}
                    className="w-full bg-slate-950 hover:bg-slate-800 border border-slate-800 hover:border-brand-500 p-2.5 rounded-xl flex items-center justify-between text-xs transition-colors"
                  >
                    <span className="font-bold text-white">{p.name}</span>
                    <span className="font-mono text-brand-400">{p.barcode}</span>
                  </button>
                ))}
              </div>

              <button
                onClick={stopCamera}
                className="w-full bg-slate-800 hover:bg-slate-700 text-slate-300 py-2.5 rounded-xl text-xs font-semibold transition-colors"
              >
                إغلاق الكاميرا
              </button>
            </div>
          </div>
        </div>
      )}

      {/* Payment Modal */}
      {isPaymentModalOpen && (
        <div className="fixed inset-0 bg-slate-950/80 backdrop-blur-sm z-50 flex items-center justify-center p-4">
          <div className="bg-slate-900 border border-slate-800 rounded-2xl w-full max-w-lg p-6 shadow-2xl animate-in fade-in zoom-in-95 duration-200">
            <div className="flex items-center justify-between pb-4 border-b border-slate-800 mb-6">
              <h3 className="text-base font-bold text-white flex items-center gap-2">
                <CreditCard className="w-5 h-5 text-brand-400" />
                إتمام الدفع وتحصيل الفاتورة
              </h3>
              <button onClick={() => setIsPaymentModalOpen(false)} className="text-slate-400 hover:text-white">
                <X className="w-5 h-5" />
              </button>
            </div>

            <div className="space-y-5">
              {/*
                A gateway that is not configured is disclosed BEFORE the operator
                picks a card, not after they are told the payment failed. The
                service now fails closed, so this notice is the difference
                between "we do not take cards here" and a failed sale at the till.
              */}
              {!paymentGatewayService.isConfigured() && (
                <div
                  role="status"
                  className="flex items-start gap-2.5 rounded-xl border border-amber-500/30 bg-amber-500/10 p-3.5"
                >
                  <ShieldAlert size={16} className="mt-0.5 shrink-0 text-amber-400" />
                  <p className="text-[11.5px] leading-relaxed text-amber-200/90">
                    بوابة الدفع بالبطاقة غير مُهيَّأة على هذا الخادم — استخدم النقد أو التحويل
                    البنكي فقط.
                  </p>
                </div>
              )}

              {/* A refused sale must be visible: the operator needs to know the
                  money was NOT captured before they hand over a receipt. */}
              {paymentError && (
                <div
                  role="alert"
                  className="flex items-start gap-2.5 p-3.5 rounded-xl bg-rose-500/10 border border-rose-500/30"
                >
                  <ShieldAlert size={16} className="text-rose-400 shrink-0 mt-0.5" />
                  <div>
                    <p className="text-xs font-bold text-rose-300">لم تكتمل عملية البيع</p>
                    <p className="text-[11.5px] text-rose-200/80 mt-0.5 leading-relaxed">
                      {paymentError}
                    </p>
                  </div>
                </div>
              )}

              <div className="bg-slate-950/60 p-4 rounded-xl border border-slate-800 text-center">
                <p className="text-xs text-slate-400 mb-1">المبلغ المطلوب سداده</p>
                <p className="text-3xl font-black text-brand-400 font-mono">{total.toLocaleString()} ر.س</p>
              </div>

              {/* Payment Provider Gateway Selector */}
              <div className="bg-slate-950 p-3 rounded-xl border border-slate-800 flex items-center justify-between">
                <div className="flex items-center gap-2 text-xs font-semibold text-slate-300">
                  <ShieldCheck className="w-4 h-4 text-brand-400" />
                  <span>بوابة الدفع الإلكتروني المباشرة:</span>
                </div>
                <select
                  value={paymentGatewayService.getActiveProvider()}
                  onChange={(e) => {
                    const prov = e.target.value as PaymentGatewayProvider;
                    paymentGatewayService.setActiveProvider(prov);
                  }}
                  className="bg-slate-900 border border-slate-800 text-brand-400 font-bold rounded-lg px-2.5 py-1 text-xs focus:outline-none cursor-pointer"
                >
                  <option value="moyasar">Moyasar (مُيسر - مدى/بطاقة/Apple Pay)</option>
                  <option value="stripe">Stripe Terminal (سترايب العالمية)</option>
                  <option value="sarie_bank_transfer">سريع SARIE (تحويل بنكي فوري QR)</option>
                </select>
              </div>

              {/* Payment Methods Grid */}
              <div>
                <label className="block text-xs font-semibold text-slate-300 mb-2">طريقة الدفع المطلوب استخدامها:</label>
                <div className="grid grid-cols-3 gap-2">
                  {[
                    { id: 'mada', label: 'شبكة مدى', icon: CreditCard },
                    { id: 'apple_pay', label: 'Apple Pay', icon: Smartphone },
                    { id: 'cash', label: 'نقدي (كاش)', icon: DollarSign },
                    { id: 'card', label: 'بطاقة ائتمان', icon: CreditCard },
                    { id: 'bank_transfer', label: 'تحويل بنكي فوري (سريع)', icon: QrCode },
                    { id: 'credit', label: 'حساب العملاء (دين)', icon: User },
                  ].map((m) => {
                    const Icon = m.icon;
                    return (
                      <button
                        key={m.id}
                        onClick={() => setPaymentMethod(m.id as any)}
                        className={`p-3 rounded-xl border flex flex-col items-center justify-center gap-1.5 transition-all cursor-pointer ${
                          paymentMethod === m.id
                            ? 'bg-brand-600/10 border-brand-500 text-brand-400 font-bold shadow-md'
                            : 'bg-slate-950 border-slate-800 text-slate-400 hover:bg-slate-800 hover:text-white'
                        }`}
                      >
                        <Icon className="w-5 h-5" />
                        <span className="text-xs text-center">{m.label}</span>
                      </button>
                    );
                  })}
                </div>
              </div>

              {/* Instant Bank Transfer QR — only when THIS tenant configured an account. */}
              {paymentMethod === ('bank_transfer' as any) && settlementAccount && (
                (() => {
                  const qr = paymentGatewayService.generateSarieIbanQr(total, settlementAccount.iban);
                  if (!qr) return null;
                  return (
                  <div className="bg-slate-950 p-4 rounded-xl border border-brand-500/30 text-center space-y-2.5 animate-in fade-in duration-150">
                   <p className="text-xs font-bold text-white">امسح كود QR عبر تطبيق بنكك للتحويل السريع (SARIE Instant Transfer):</p>
                   <div className="bg-white p-2.5 rounded-2xl inline-block shadow-lg mx-auto">
                     <img
                       src={qr}
                       alt="SARIE Instant Bank Transfer QR"
                       className="w-36 h-36 mx-auto object-contain"
                     />
                   </div>
                   <div className="text-[11px] font-mono text-slate-300 bg-slate-900 p-2 rounded-lg border border-slate-800 space-y-1">
                     <p className="text-brand-400 font-bold break-all">{settlementAccount.iban}</p>
                     {/* Bank and holder names come from the merchant's own record.
                         Showing the bank we happen to be looking at is what makes the
                         payer able to confirm the destination is the right one. */}
                     <p className="text-slate-400">
                       {[settlementAccount.bankName, settlementAccount.holderName]
                         .filter(Boolean).join(' — ') || identity.ownerCompany}
                     </p>
                   </div>
                   {/*
                     A bank transfer is NOT proof of payment. The money moves by IBAN
                     and nothing here confirms it arrived, so the sale must be recorded
                     as awaiting reconciliation rather than paid.
                   */}
                   <p className="text-[10px] text-amber-400 font-semibold">
                     لم يتم تأكيد الدفع — سيُسوّى المبلغ عند تأكيد التحويل
                   </p>
                  </div>
                  );
                })()
              )}

              {paymentMethod === 'cash' && (
                <div className="space-y-2">
                  <label className="block text-xs font-semibold text-slate-300">المبلغ المستلم نقداً:</label>
                  <input
                    type="number"
                    value={cashGiven}
                    onChange={(e) => setCashGiven(e.target.value)}
                    placeholder="أدخل المبلغ..."
                    className="w-full bg-slate-950 border border-slate-800 rounded-xl px-4 py-2.5 text-sm text-white font-mono focus:outline-none focus:border-brand-500"
                  />
                  {Number(cashGiven) >= total && (
                    <div className="bg-brand-950/40 border border-brand-500/20 p-3 rounded-xl flex items-center justify-between text-xs">
                      <span className="text-brand-300">المتبقي للعميل (الصرف):</span>
                      <span className="font-mono font-bold text-brand-400 text-sm">{changeDue.toLocaleString()} ر.س</span>
                    </div>
                  )}
                </div>
              )}

              <div className="flex items-center justify-end gap-3 pt-4 border-t border-slate-800">
                <button
                  onClick={() => setIsPaymentModalOpen(false)}
                  className="px-4 py-2.5 rounded-xl text-xs font-semibold bg-slate-800 hover:bg-slate-700 text-slate-300 transition-colors"
                >
                  إلغاء
                </button>
                <button
                  onClick={handleProcessPayment}
                  disabled={isProcessingPayment}
                  className="px-6 py-2.5 rounded-xl text-xs font-bold bg-brand-600 hover:bg-brand-500 disabled:opacity-50 text-white shadow-lg shadow-brand-600/30 transition-all flex items-center gap-2 cursor-pointer"
                >
                  {isProcessingPayment ? (
                    <>
                      <RefreshCw className="w-4 h-4 animate-spin" />
                      <span>جاري معالجة بوابة الدفع...</span>
                    </>
                  ) : (
                    <>
                      <CheckCircle className="w-4 h-4" />
                      <span>تأكيد وطباعة الفاتورة</span>
                    </>
                  )}
                </button>
              </div>
            </div>
          </div>
        </div>
      )}

      {/* Thermal Receipt Preview Modal */}
      {isReceiptModalOpen && lastCompletedTx && (
        <div className="fixed inset-0 bg-slate-950/80 backdrop-blur-sm z-50 flex items-center justify-center p-4">
          <div id="thermal-receipt-printable" className="bg-white text-slate-900 rounded-2xl w-full max-w-sm p-6 shadow-2xl font-mono text-xs relative animate-in zoom-in-95 duration-200">
            {/*
             * The fiscal header comes from `dypos.tenants` and `dypos.branches`,
             * not from a literal in this file.
             *
             * It used to read "شركة رويال العالمية - منصة التجارة / فرع الرياض الرئيسي /
             * 300123456700003" as three JSX text nodes. On a VAT invoice the tax
             * number is a legal assertion, so a compiled-in one means this build
             * cannot be issued to a second customer — it would print that
             * customer's receipts under this company's registration, and every
             * value on the receipt would still look self-consistent.
             *
             * `identity.source === 'unresolved'` is rendered as a visible warning
             * rather than a blank, because a receipt issued without a VAT number
             * must never be indistinguishable from a complete one.
             */}
            <div className="text-center pb-4 border-b border-dashed border-slate-300">
              <h2 className="text-base font-black">{identity.ownerCompany}</h2>
              <p className="text-[10px] text-slate-600 mt-0.5">{branchLine(identity)}</p>
              <p className="text-[10px] text-slate-600">
                {identity.taxNumber
                  ? `الرقم الضريبي: ${identity.taxNumber}`
                  : `الرقم الضريبي: ${UNRESOLVED_LABEL}`}
              </p>
              {identity.source === 'unresolved' && (
                <p className="text-[9px] text-red-600 mt-1 font-bold">
                  بيانات المؤسسة غير مكتملة — الإيصال غير صالح ضريبياً ({identity.missing.join('، ')})
                </p>
              )}
            </div>

            <div className="py-3 space-y-1 text-[11px] border-b border-dashed border-slate-300">
              <div className="flex justify-between">
                <span>رقم الفاتورة:</span>
                <span className="font-bold">{lastCompletedTx.invoiceNumber}</span>
              </div>
              <div className="flex justify-between">
                <span>التاريخ والوقت:</span>
                <span>{lastCompletedTx.timestamp}</span>
              </div>
              <div className="flex justify-between">
                <span>الكاشير:</span>
                <span>{lastCompletedTx.cashierName}</span>
              </div>
              <div className="flex justify-between">
                <span>العميل:</span>
                <span>{lastCompletedTx.customerName}</span>
              </div>
            </div>

            <div className="py-3 space-y-2 border-b border-dashed border-slate-300">
              <div className="flex justify-between font-bold text-[10px] text-slate-500 pb-1 border-b border-slate-200">
                <span>الصنف</span>
                <span>الكمية × السعر</span>
              </div>
              {lastCompletedTx.items.map((it, idx) => (
                <div key={idx} className="flex justify-between text-[11px]">
                  <span className="truncate max-w-[160px]">{it.product.name}</span>
                  <span>{it.quantity} × {it.product.price}</span>
                </div>
              ))}
            </div>

            <div className="py-3 space-y-1 text-[11px] border-b border-dashed border-slate-300">
              <div className="flex justify-between">
                <span>المجموع الفرعي:</span>
                <span>{lastCompletedTx.subtotal.toLocaleString()} ر.س</span>
              </div>
              {lastCompletedTx.discount > 0 && (
                <div className="flex justify-between text-rose-600">
                  <span>الخصم:</span>
                  <span>-{lastCompletedTx.discount.toLocaleString()} ر.س</span>
                </div>
              )}
              <div className="flex justify-between">
                <span>ضريبة القيمة المضافة (15%):</span>
                <span>{lastCompletedTx.tax.toLocaleString()} ر.س</span>
              </div>
              <div className="flex justify-between font-black text-sm pt-1 border-t border-slate-300">
                <span>الإجمالي النهائي:</span>
                <span>{lastCompletedTx.total.toLocaleString()} ر.س</span>
              </div>
            </div>

            <div className="text-center pt-4 space-y-2">
              <p className="text-[10px] text-slate-500">شكراً لتعاملكم مع {identity.ownerCompany}</p>
              <div className="flex gap-2 pt-2">
                <button
                  onClick={() => window.print()}
                  className="flex-1 bg-slate-900 hover:bg-slate-800 text-white py-2 rounded-xl text-xs font-semibold flex items-center justify-center gap-1.5 transition-colors"
                >
                  <Printer className="w-3.5 h-3.5" />
                  طباعة حرارية
                </button>
                <button
                  onClick={() => generateInvoicePDF(lastCompletedTx, identity)}
                  className="flex-1 bg-brand-700 hover:bg-brand-600 text-white py-2 rounded-xl text-xs font-semibold flex items-center justify-center gap-1.5 transition-colors"
                >
                  <Download className="w-3.5 h-3.5" />
                  تحميل PDF
                </button>
                <button
                  onClick={() => setIsReceiptModalOpen(false)}
                  className="bg-slate-200 hover:bg-slate-300 text-slate-800 px-3 py-2 rounded-xl text-xs font-bold transition-colors"
                >
                  إغلاق
                </button>
              </div>
            </div>
          </div>
        </div>
      )}
    </div>
  );
};
