/**
 * DEVICE DIAGNOSTICS ENGINE
 * ══════════════════════════════════════════════════════════════════════════
 *
 * WHY THIS FILE EXISTS
 * --------------------
 * A POS terminal fails in ways a login form cannot explain. The scale reads
 * 0.000 kg because Web Serial is Chromium-only. Receipts print blank because
 * there is no ESC/POS bridge. The till works all shift and then loses its
 * queue because `navigator.storage.persist()` was never granted.
 *
 * None of that is visible in the UI, so support calls became "try Chrome".
 * This engine turns the invisible state of the client into a report an
 * operator can read and a support agent can copy in one action.
 *
 * THREE RULES
 * -----------
 * 1. NOTHING IS FABRICATED. A check that cannot be evaluated reports
 *    `unknown`, never `pass`. The panel this replaces called
 *    `Math.random() > 0.1` and printed "جاهزة 🟢" — a random number dressed
 *    as a health check, on a screen operators were meant to trust.
 *
 * 2. EVERY CHECK SAYS WHAT TO DO. A red row with no remedy is an escalation
 *    to the IT department. `fix` is what happens next.
 *
 * 3. PROBES ARE CHEAP AND NON-DESTRUCTIVE. Nothing here writes to a scale
 *    or opens a cash drawer. The two probes that need a write (storage,
 *    persistence) use a namespaced key and delete it immediately.
 */

/** Severity of a single check. `unknown` is a real state, not a fallback. */
export type CheckStatus = 'pass' | 'warn' | 'fail' | 'unknown';

export interface DiagnosticCheck {
  /** Stable machine id — the React key and the id used in copied reports. */
  id: string;
  /** Arabic label shown to the operator. */
  label: string;
  /** The measured value, as a short display string. */
  value: string;
  status: CheckStatus;
  /** Why this matters, in one sentence. */
  detail: string;
  /** What to do about it, when it is not `pass`. */
  fix?: string;
}

export interface DiagnosticSection {
  id: string;
  title: string;
  /** Short purpose line shown under the section heading. */
  hint: string;
  checks: DiagnosticCheck[];
}

export interface DiagnosticReport {
  generatedAt: string;
  sections: DiagnosticSection[];
  /** Roll-up across every section, for the summary bar and copied report. */
  summary: { pass: number; warn: number; fail: number; unknown: number; total: number };
  /** Only the rows that block work — a support bundle leads with these. */
  blockers: DiagnosticCheck[];
  /** A flat, greppable dump for a support ticket. */
  raw: Record<string, string>;
}

/* ────────────────────────────── primitives ────────────────────────────── */

/** Read a `window`/`navigator` feature without throwing on old engines. */
const has = (path: string): boolean => {
  try {
    let cur: any = window;
    for (const part of path.split('.')) {
      if (cur == null) return false;
      cur = cur[part];
    }
    return cur != null;
  } catch {
    return false;
  }
};

/**
 * Media query read that survives browsers without `matchMedia`.
 * `unknown`, never `false` — a browser that cannot answer has not said no.
 */
const mq = (query: string): boolean | 'unknown' => {
  try {
    if (typeof window.matchMedia !== 'function') return 'unknown';
    return window.matchMedia(query).matches;
  } catch {
    return 'unknown';
  }
};

const boolCheck = (
  id: string, label: string, value: boolean, detail: string, fix?: string,
): DiagnosticCheck => ({
  id,
  label,
  value: value ? 'متوفر' : 'غير متوفر',
  status: value ? 'pass' : 'fail',
  detail,
  fix: value ? undefined : fix,
});
/* ─────────────────────────────── 1. platform ───────────────────────────── */

/**
 * Browser and engine identification.
 *
 * The UA string is parsed for *display only* — nothing in the product
 * branches on it. Every behavioural decision comes from a feature probe,
 * because the UA is freely editable and has misreported Chrome on iOS
 * since 2022.
 */
export const detectBrowser = (): Record<string, string> => {
  const ua = navigator.userAgent;
  const out: Record<string, string> = { 'User agent': ua };

  // Chromium exposes the high-entropy brand list — far more honest than the
  // UA, which Chromium froze years ago to reduce fingerprinting.
  const brands = (navigator as any).userAgentData?.brands as
    | { brand: string; version: string }[] | undefined;
  if (brands?.length) {
    const notable = brands.filter((b) => !/Not.?A.?Brand/i.test(b.brand));
    out['Brand (UA-CH)'] = notable.map((b) => `${b.brand} ${b.version}`).join(' · ') || '—';
    out['Platform (UA-CH)'] = (navigator as any).userAgentData.platform ?? '—';
    out['Mobile (UA-CH)'] = String((navigator as any).userAgentData.mobile);
  }

  out['Engine'] = /Firefox\/\d/.test(ua) ? 'Gecko'
    : /Edg\/\d/.test(ua) ? 'Blink (Edge)'
    : /OPR\/\d/.test(ua) ? 'Blink (Opera)'
    : /Chrome\/\d/.test(ua) ? 'Blink (Chromium)'
    : /Safari\//.test(ua) ? 'WebKit'
    : 'غير معروف';

  // iPadOS 13+ reports a desktop UA with a touch screen. The touch-point
  // count is what separates it, which is why it is checked, not parsed.
  const isIos = /iPad|iPhone|iPod/.test(ua)
    || (/Macintosh/.test(ua) && (navigator as any).maxTouchPoints > 1);
  out['Platform'] = /Windows/.test(ua) ? 'Windows'
    : /Android/.test(ua) ? 'Android'
    : isIos ? 'iOS / iPadOS'
    : /Mac OS X/.test(ua) ? 'macOS'
    : /Linux/.test(ua) ? 'Linux'
    : 'غير معروف';
  return out;
};

/** True on Chromium-derived engines, which is what the USB/serial bridges need. */
const isChromium = (): boolean => /Chrome\/|Edg\/|OPR\//.test(navigator.userAgent);

const platformSection = (raw: Record<string, string>): DiagnosticSection => {
  const chromium = isChromium();
  // A syntax probe rather than a version parse: this is the actual question
  // ("can this engine run the bundle?"), and it costs nothing.
  let modernJs = true;
  try {
    // eslint-disable-next-line no-new-func
    new Function('a?.b ?? 1');
  } catch {
    modernJs = false;
  }

  const checks: DiagnosticCheck[] = [
    {
      id: 'platform.engine',
      label: 'محرّك المتصفح',
      value: raw['Engine'] ?? '—',
      status: 'pass',
      detail: 'يحدد أي الجسور تعمل فعلياً: المنفذ التسلسلي، USB، البلوتوث، ووضع التطبيق.',
    },
    {
      id: 'platform.secure-context',
      label: 'السياق الآمن (HTTPS)',
      value: window.isSecureContext ? 'نعم' : 'لا',
      status: window.isSecureContext ? 'pass' : 'fail',
      detail: 'بدون HTTPS تتعطل الكاميرا والبلوتوث والمنفذ التسلسلي والتخزين الدائم.',
      fix: 'افتح النظام عبر https:// أو ثبّت شهادة SSL داخلية على جهاز الكاشير.',
    },
    {
      id: 'platform.js-engine',
      label: 'مستوى لغة JavaScript',
      value: modernJs ? 'حديث (ES2022+)' : 'قديم',
      status: modernJs ? 'pass' : 'fail',
      detail: 'محرك تحديث قديم لا ينفّذ حزمة التطبيق الحالية.',
      fix: 'حدّث المتصفح إلى إصدار حديث.',
    },
    {
      id: 'platform.chromium',
      label: 'دعم Chromium للأجهزة الطرفية',
      value: chromium ? 'نعم' : 'لا',
      status: chromium ? 'pass' : 'warn',
      detail: 'Web Serial / Web USB / جسر الطابعة الحرارية متاحة على Chromium فقط.',
      fix: chromium ? undefined
        : 'على Firefox وSafari استخدم بدائل النظام: قارئ الباركود عبر الكاميرا، والميزان عبر Bluetooth أو إدخال يدوي للوزن.',
    },
    {
      id: 'platform.isolation',
      label: 'عزل المصادر (COOP/COEP)',
      value: window.crossOriginIsolated ? 'مفعّل' : 'غير مفعّل',
      status: 'pass',
      detail: 'ليس مطلوباً — النظام لا يستخدم ذاكرة مشتركة. مذكور لتضمينه في تقرير الدعم.',
    },
  ];

  return {
    id: 'platform',
    title: 'المتصفح ومحرّك التشغيل',
    hint: 'الأساس الذي تعمل عليه كل القدرات الأخرى',
    checks,
  };
};
/* ──────────────────────────── 2. display & input ──────────────────────── */

/**
 * Screen, pointer and touch.
 *
 * The touch row matters more than it looks: a POS is sold as "works on
 * iPad", and `pointer: coarse` plus a small screen is exactly the
 * configuration where a hover-only menu becomes unreachable.
 */
const displaySection = (): DiagnosticSection => {
  const dpr = window.devicePixelRatio || 1;
  const w = window.screen?.width ?? 0;
  const h = window.screen?.height ?? 0;
  const touchPoints = (navigator as any).maxTouchPoints ?? 0;
  const coarse = mq('(pointer: coarse)');

  const formFactor = w && w < 820 ? 'هاتف / لوح صغير'
    : w && w < 1280 ? 'لوحي'
    : w ? 'سطح مكتب' : 'غير معروف';

  const checks: DiagnosticCheck[] = [
    {
      id: 'display.size',
      label: 'أبعاد الشاشة',
      value: w && h ? `${w}×${h} بكسل · ${formFactor}` : 'غير معروف',
      status: 'pass',
      detail: 'نفس الصيغة تُستخدم لاختيار تخطيط الكاشير: شبكة أزرار ولوحة مفاتيح.',
    },
    {
      id: 'display.viewport',
      label: 'إطار العرض الفعلي',
      value: `${Math.round(window.innerWidth)}×${Math.round(window.innerHeight)}`,
      status: 'pass',
      detail: 'المساحة الحقيقية المتاحة بعد أشرطة المتصفح ومناطق الأمان.',
    },
    {
      id: 'display.dpr',
      label: 'كثافة البكسل',
      value: `${dpr}×`,
      status: dpr >= 2 ? 'pass' : 'warn',
      detail: 'دقة أقل من 2× تجعل نصوص الواجهة الطرفية (11–13 بكسل) غير مقروءة من مسافة الكاشير.',
      fix: dpr >= 2 ? undefined : 'فعّل «تكبير النص» في نظام التشغيل أو استخدم جهازاً بدقة أعلى.',
    },
    {
      id: 'display.color-depth',
      label: 'عمق الألوان',
      value: `${window.screen?.colorDepth ?? '—'} بت`,
      status: (window.screen?.colorDepth ?? 0) >= 24 ? 'pass' : 'warn',
      detail: 'أقل من 24 بت يعني ألواناً متدرجة — يفسد التباين في ثيم الوصول العالي.',
      fix: (window.screen?.colorDepth ?? 0) >= 24 ? undefined : 'غيّر عمق ألوان الشاشة من إعدادات العرض.',
    },
    {
      id: 'input.touch',
      label: 'اللمس متعدد النقاط',
      value: `${touchPoints} نقطة`,
      status: touchPoints >= 5 ? 'pass' : touchPoints > 0 ? 'warn' : 'unknown',
      detail: 'نقاط اللمس المتعددة مطلوبة لإدخال الأصابع على شاشة الكاشير.',
      fix: touchPoints > 0 ? undefined : 'هذا جهاز مكتبي بدون لمس — استخدم الماوس ولوحة المفاتيح.',
    },
    {
      id: 'input.hover',
      label: 'دعم التحويم (hover)',
      value: mq('(hover: hover)') === 'unknown' ? 'غير معروف' : mq('(hover: hover)') ? 'متوفر' : 'غير متوفر',
      status: mq('(hover: hover)') === 'unknown' ? 'unknown' : 'pass',
      detail: 'القوائم التي تظهر عند التحويم وحده غير قابلة للوصول باللمس.',
    },
  ];

  // Read live rather than at boot: rotating a tablet changes the answer, and
  // a report generated in portrait is stale in landscape.
  const orientation = window.screen?.orientation?.type ?? (w > h ? 'landscape' : 'portrait');

  return {
    id: 'display',
    title: 'الشاشة واللمس',
    hint: coarse === true
      ? 'جهاز لمسي — الواجهة تعمل بالكامل بدون تمرير بالفأرة'
      : 'جهاز بمؤشر — قوائم التحويم مدعومة',
    checks: [
      ...checks,
      {
        id: 'display.orientation',
        label: 'اتجاه العرض',
        value: String(orientation),
        status: 'pass',
        detail: 'الكاشير يعمل في الوضعين، والشاشات العريضة تعرض لوحة جانبية بدل التمرير.',
      },
    ],
  };
};
/* ──────────────────────────── 3. hardware bridges ─────────────────────── */

/**
 * Peripheral bridges — the actual POS hardware surface.
 *
 * Feature-detected, never assumed. Each carries the consequence of its
 * absence in `fix`, because "Web Serial غير متاح" means nothing to a
 * cashier and "الوزن يُدخَل يدوياً" means everything.
 */
const hardwareSection = (): DiagnosticSection => {
  const checks: DiagnosticCheck[] = [
    boolCheck(
      'hw.serial', 'منفذ تسلسلي (Web Serial)', has('navigator.serial'),
      'ربط الميزان الإلكتروني عبر RS-232/USB مباشرة بدون جسر خارجي.',
      'استخدم ربط البلوتوث للميزان، أو أدخل الوزن يدوياً، أو بدّل المتصفح إلى Chrome/Edge.',
    ),
    boolCheck(
      'hw.usb', 'منفذ USB (Web USB)', has('navigator.usb'),
      'الوصول المباشر لأجهزة USB مثل قارئ الباركود.',
      'قارئ الباركود يعمل أيضاً كلوحة مفاتيح (HID) دون هذه الواجهة.',
    ),
    boolCheck(
      'hw.bluetooth', 'بلوتوث (Web Bluetooth)', has('navigator.bluetooth'),
      'ربط لاسلكي للميزان ودرج النقدية بدون أسلاك.',
      'الجهاز غير مزوّد ببلوتوث — استخدم المنفذ التسلسلي أو الإدخال اليدوي.',
    ),
    boolCheck(
      'hw.hid', 'أجهزة HID', has('navigator.hid'),
      'قراءة قارئات الباركود التي تعمل كلوحة مفاتيح، دون طلب إذن.',
      'استخدم قارئ باركود يعمل كلوحة مفاتيح معياري (HID).',
    ),
    boolCheck(
      'hw.barcode', 'ماسح باركود بالكاميرا', has('BarcodeDetector'),
      'قراءة الباركود عبر كاميرا الجهاز دون قارئ خارجي (للأجهزة المحمولة).',
      'استخدم تطبيق الكاميرا الخارجي أو أدخل الباركود يدوياً.',
    ),
    boolCheck(
      'hw.print', 'الطباعة من المتصفح', has('window.print'),
      'طباعة الفواتير والتقارير — متاحة في كل المتصفحات بصيغة مختلفة.',
    ),
    {
      id: 'hw.vibrate',
      label: 'الاهتزاز اللمسي',
      value: has('navigator.vibrate') ? 'متوفر' : 'غير متوفر',
      status: has('navigator.vibrate') ? 'pass' : 'unknown',
      detail: 'تأكيدات لمسية عند مسح الباركود أو رفض عملية.',
    },
    {
      id: 'hw.drawer',
      label: 'درج النقدية (نبضة ESC/POS)',
      value: 'عبر الطابعة',
      status: 'unknown',
      detail: 'يُفتح بنبضة كهربائية عبر منفذ الطابعة. لا يمكن التحقق منه بدون جهاز فعلي متصل.',
      fix: 'اختبر فتح الدرج من شاشة البيع بعد توصيل الطابعة.',
    },
  ];

  return {
    id: 'hardware',
    title: 'الأجهزة الطرفية',
    hint: has('navigator.serial')
      ? 'جسور الأجهزة متاحة — الميزان والطابعة قابلة للربط'
      : 'المتصفح لا يدعم الجسور المباشرة — البدائل اليدوية مُعطّلة تلقائياً',
    checks,
  };
};

/* ────────────────────────────── 4. storage ────────────────────────────── */

/**
 * Storage, service worker and persistence.
 *
 * Persistence is the row that bites: a till granted storage by a browser
 * that later evicts it loses an unsent offline queue. The probe below
 * actually asks for persistence rather than assuming it was granted.
 */
const storageSection = async (raw: Record<string, string>): Promise<DiagnosticSection> => {
  const checks: DiagnosticCheck[] = [];

  // localStorage: write a namespaced key, read it back, remove it. A private
  // window throws on write — the exact failure this must catch.
  let lsOk = false;
  try {
    localStorage.setItem('__dypos_probe__', '1');
    lsOk = localStorage.getItem('__dypos_probe__') === '1';
    localStorage.removeItem('__dypos_probe__');
  } catch { /* private mode */ }
  raw['localStorage'] = String(lsOk);
  checks.push(boolCheck(
    'store.local', 'التخزين المحلي (localStorage)', lsOk,
    'يحفظ اختيار السمة والفرع وحالة التطبيق بين الجلسات.',
    'الوضع الخاص في المتصفح يمنع الحفظ — ستفقد التفضيلات عند كل تحديث. استخدم نافذة عادية.',
  ));

  const ssOk = (() => {
    try {
      sessionStorage.setItem('__dypos_probe__', '1');
      sessionStorage.removeItem('__dypos_probe__');
      return true;
    } catch { return false; }
  })();
  checks.push(boolCheck(
    'store.session', 'تخزين الجلسة', ssOk,
    'يحفظ جلسة الدخول المؤقتة حتى إغلاق التبويب.',
    'الجلسة لن تبقى بعد إغلاق التبويب — سجّل الدخول بالبيانات في كل مرة.',
  ));

// IndexedDB backs the offline queue.
  const idb = await new Promise<boolean>((resolve) => {
    try {
      if (!has('window.indexedDB')) return resolve(false);
      const req = indexedDB.open('__dypos_probe__', 1);
      req.onsuccess = () => {
        req.result.close();
        indexedDB.deleteDatabase('__dypos_probe__');
        resolve(true);
      };
      req.onerror = () => resolve(false);
      // Safari in private mode can leave the request pending forever.
      setTimeout(() => resolve(false), 1500);
    } catch { resolve(false); }
  });
  raw['indexedDB'] = String(idb);
  checks.push(boolCheck(
    'store.idb', 'قاعدة IndexedDB', idb,
    'تخزين طابور العمليات عند انقطاع الشبكة — بدونها تضيع المبيعات غير المتزامنة.',
    'العمليات ستعمل فقط عند الاتصال. تحقق من مساحة التخزين في إعدادات المتصفح.',
  ));

  if (has('navigator.storage.estimate')) {
    try {
      const est = await navigator.storage.estimate();
      const usedMb = ((est.usage ?? 0) / 1048576).toFixed(1);
      const quotaMb = ((est.quota ?? 0) / 1048576).toFixed(0);
      raw['Storage used (MB)'] = usedMb;
      raw['Storage quota (MB)'] = quotaMb;
      checks.push({
        id: 'store.quota',
        label: 'مساحة التخزين المتاحة',
        value: `${usedMb} / ${quotaMb} ميغابايت`,
        status: 'pass',
        detail: 'المساحة التي يمكن للتطبيق استخدامها من مساحة الموقع.',
      });
    } catch {
      checks.push({
        id: 'store.quota', label: 'مساحة التخزين المتاحة', value: 'غير معروف',
        status: 'unknown', detail: 'المتصفح رفض قياس المساحة.',
      });
    }
  }

  // Persistence — the eviction risk, asked for explicitly rather than hoped for.
  let persisted = false;
  if (has('navigator.storage.persisted')) {
    persisted = await navigator.storage.persisted().catch(() => false);
  }
  if (has('navigator.storage.persist')) {
    persisted = (await navigator.storage.persist().catch(() => false)) || persisted;
  }
  raw['storage.persisted'] = String(persisted);
  checks.push({
    id: 'store.persist',
    label: 'تخزين دائم (persistent)',
    value: persisted ? 'مفعّل' : 'غير مفعّل',
    status: persisted ? 'pass' : 'warn',
    detail: 'يمنع المتصفح من حذف الطابور تلقائياً عند امتلاء المساحة.',
    fix: persisted ? undefined
      : 'قد يمسح المتصفح بيانات العمل عند امتلاء المساحة. فعّل الموقع من «الإعدادات ← التخزين».',
  });

  // Service worker — the actual offline engine.
  let swCtrl = false;
  let swScope = '—';
  if (has('navigator.serviceWorker')) {
    try {
      const reg = await navigator.serviceWorker.getRegistration();
      swCtrl = Boolean(navigator.serviceWorker.controller);
      swScope = reg?.scope ?? '—';
    } catch { /* ignore */ }
  }
  raw['serviceWorker'] = has('navigator.serviceWorker') ? (swCtrl ? 'active' : 'inactive') : 'unsupported';
  raw['serviceWorker.scope'] = swScope;
  checks.push({
    id: 'store.sw',
    label: 'عامل الخدمة (Service Worker)',
    value: swCtrl ? 'نشط' : has('navigator.serviceWorker') ? 'مسجَّل بلا تحكم' : 'غير مدعوم',
    status: swCtrl ? 'pass' : 'warn',
    detail: 'يمكّن فتح النظام والعمل بدون إنترنت، ويحدّث النسخة دون مقاطعة.',
    fix: swCtrl ? undefined
      : 'بدون عامل خدمة لن يعمل النظام دون اتصال ولن يتحدث تلقائياً. أعد تحميل الصفحة مرة واحدة.',
  });

  return {
    id: 'storage',
    title: 'التخزين والعمل دون اتصال',
    hint: 'ما الذي سيبقى محفوظاً لو انقطعت الكهرباء الآن',
    checks,
  };
};

/* ────────────────────────────── 5. network ────────────────────────────── */

/**
 * Network, measured rather than declared.
 *
 * A ping row is included because "الشبكة تعمل" and "الشبكة بطيئة" need
 * different responses: the first is a cable, the second is a queue that
 * will not drain before the shift change.
 */
const networkSection = async (raw: Record<string, string>): Promise<DiagnosticSection> => {
  const conn = (navigator as any).connection ?? (navigator as any).mozConnection ?? (navigator as any).webkitConnection;
  if (conn) {
    raw['Connection type'] = conn.effectiveType ?? '—';
    raw['Connection downlink'] = conn.downlink != null ? `${conn.downlink} Mb/s` : '—';
    raw['Connection RTT'] = conn.rtt != null ? `${conn.rtt} ms` : '—';
    raw['Data saver'] = String(Boolean(conn.saveData));
  }

  const checks: DiagnosticCheck[] = [{
    id: 'net.online',
    label: 'حالة الاتصال',
    value: navigator.onLine ? 'متصل' : 'غير متصل',
    status: navigator.onLine ? 'pass' : 'warn',
    detail: 'النظام يعمل دون اتصال؛ يُرسل الطابور تلقائياً عند عودة الشبكة.',
    fix: navigator.onLine ? undefined : 'العامل يعمل — سيُرسل الطابور فور عودة الشبكة.',
  }];

  if (conn?.effectiveType) {
    const slow = /2g|slow/.test(conn.effectiveType);
    checks.push({
      id: 'net.effective',
      label: 'جودة الشبكة',
      value: String(conn.effectiveType),
      status: slow ? 'warn' : 'pass',
      detail: 'شبكة بطيئة تؤخر فتح شاشات التحميل وتُطيل استجابة الدفع.',
      fix: slow ? 'استخدم شبكة有线 في المخزن أو نقطة وصول أقرب للصالة.' : undefined,
    });
  }

  // A real request against the app's own API — the one the POS actually
  // depends on. Cached responses are excluded so the number means something.
  const started = performance.now();
  let apiOk = false;
  let apiMs = 0;
  try {
    const res = await fetch('/api/release', { cache: 'no-store' });
    apiMs = Math.round(performance.now() - started);
    apiOk = res.ok;
    raw['API /api/release'] = `${res.status} · ${apiMs} ms`;
  } catch (e) {
    apiMs = Math.round(performance.now() - started);
    raw['API /api/release'] = `فشل · ${apiMs} ms`;
  }
  checks.push({
    id: 'net.api',
    label: 'استجابة الخادم',
    value: apiOk ? `${apiMs} مللي ثانية` : 'غير متاح',
    status: apiOk ? (apiMs < 800 ? 'pass' : 'warn') : 'fail',
    detail: 'قياس فعلي لواجهة النظام على هذا الجهاز، لا قيمة ثابتة.',
    fix: apiOk ? (apiMs < 800 ? undefined : 'الاستجابة بطيئة — قد يكون الخادم أو الشبكة مشغولين.')
      : 'تعذّر الوصول إلى الخادم. سيعمل النظام محلياً، ولن تُحفظ المبيعات على الخادم.',
  });

  return {
    id: 'network',
    title: 'الشبكة والخادم',
    hint: 'الاتصال الحالي وسرعة الاستجابة المقاسة',
    checks,
  };
};

/* ─────────────────────────── 6. accessibility ─────────────────────────── */

/**
 * Accessibility preferences.
 *
 * These are honoured by the design system already (`prefers-reduced-motion`
 * in `index.css`); reporting them lets an operator confirm the accommodation
 * took effect on *this* device rather than assuming it did.
 */
const accessibilitySection = (): DiagnosticSection => {
  const row = (
    id: string, label: string, query: string,
    activeDetail: string, inactiveDetail: string,
  ): DiagnosticCheck => {
    const m = mq(query);
    return {
      id,
      label,
      value: m === 'unknown' ? 'غير مدعوم' : m ? 'مفعّل' : 'غير مفعّل',
      status: m === 'unknown' ? 'unknown' : 'pass',
      detail: m ? activeDetail : inactiveDetail,
    };
  };

  return {
    id: 'a11y',
    title: 'إمكانية الوصول',
    hint: 'احتياطات نظام التشغيل المُفعّلة على هذا الجهاز',
    checks: [
      row('a11y.reduce-motion', 'تقليل الحركة', '(prefers-reduced-motion: reduce)',
        'أوقفت الرسوم المتحركة، بما فيها خلفية 3D في شاشة الدخول.',
        'الحركة مسموحة — يمكن تعطيلها من إعدادات النظام أو من شاشة الدخول.'),
      row('a11y.contrast', 'تباين مرتفع', '(prefers-contrast: more)',
        'يزيد وزن الخطوط والحدود تلقائياً.',
        'التباين على إعداد النظام الافتراضي؛ ثيم «التباين العالي» متاح يدوياً من الأدوات.'),
      row('a11y.forced-colors', 'ألوان النظام القسرية', '(forced-colors: active)',
        'النظام يتبع ألوان نظام التشغيل (وضع الوصول العالي في Windows).',
        'ألوان النظام غير مفعّلة — النظام يستخدم سمة DyPOS الخاصة.'),
      row('a11y.transparency', 'تقليل الشفافية', '(prefers-reduced-transparency: reduce)',
        'أوقفت الطبقات شبه الشفافة.',
        'الشفافية مسموحة — قد تُخفف وضوح بعض البطاقات.'),
      row('a11y.coarse-pointer', 'مؤشر خشن (لمس)', '(pointer: coarse)',
        'أزرار النظام بمقاس لمس مناسب (‏44 بكسل كحد أدنى).',
        'لا يوجد مؤشر سطحي — الأزرار بمقاس الماوس.'),
    ],
  };
};

/* ──────────────────────────── 7. compose & export ─────────────────────── */

/**
 * Runs every probe and returns a complete report.
 *
 * Ordered so the most decisive sections come first: a browser that cannot
 * run the bundle explains everything below it, and an agent reading top to
 * bottom stops at the first hard failure instead of triaging thirty rows.
 */
export const runDeviceDiagnostics = async (): Promise<DiagnosticReport> => {
  const raw: Record<string, string> = {
    'Timestamp': new Date().toISOString(),
    'URL': location.href,
    'Language': navigator.language,
    'Languages': (navigator.languages || []).join(', '),
    'Timezone': Intl.DateTimeFormat().resolvedOptions().timeZone,
    'Cores': String(navigator.hardwareConcurrency || '—'),
    'Device memory (GB)': String((navigator as any).deviceMemory ?? '—'),
  };

  // Credentials can sit in the URL on a deep link, and a report gets pasted
  // into a public ticket. Keep only what identifies the page.
  raw['URL'] = location.origin + location.pathname;

  const browser = detectBrowser();
  Object.assign(raw, browser);

  const sections: DiagnosticSection[] = [
    platformSection(browser),
    displaySection(),
    hardwareSection(),
    await storageSection(raw),
    await networkSection(raw),
    accessibilitySection(),
  ];

  const all = sections.flatMap((s) => s.checks);
  const count = (k: CheckStatus) => all.filter((c) => c.status === k).length;

  const report: DiagnosticReport = {
    generatedAt: new Date().toISOString(),
    sections,
    summary: {
      pass: count('pass'),
      warn: count('warn'),
      fail: count('fail'),
      unknown: count('unknown'),
      total: all.length,
    },
    blockers: all.filter((c) => c.status === 'fail'),
    raw,
  };
  return report;
};

/**
 * A plain-text bundle for a support ticket.
 *
 * Deliberately text, not JSON: the person reading it is an agent on the
 * phone, and the same content is pasted into an email, a chat, or a printed
 * page without reformatting.
 */
export const formatReport = (r: DiagnosticReport): string => {
  const MARK: Record<CheckStatus, string> = {
    pass: '[✓]', warn: '[!]', fail: '[✗]', unknown: '[?]',
  };
  const lines: string[] = [
    '══════ تقرير فحص الجهاز — DyPOS ══════',
    `التاريخ: ${r.generatedAt}`,
    `الملخص: ${r.summary.pass} سليم · ${r.summary.warn} تحذير · ${r.summary.fail} تعطل · ${r.summary.unknown} غير معروف`,
    '',
  ];
  for (const s of r.sections) {
    lines.push(`── ${s.title} ──`);
    for (const c of s.checks) {
      lines.push(`${MARK[c.status]} ${c.label}: ${c.value}`);
      if (c.status !== 'pass') {
        lines.push(`    ${c.detail}`);
        if (c.fix) lines.push(`    الحل: ${c.fix}`);
      }
    }
    lines.push('');
  }
  lines.push('── بيانات البيئة الخام ──');
  for (const [k, v] of Object.entries(r.raw)) lines.push(`${k}: ${v}`);
  return lines.join('\n');
};

/**
 * Copy helper with a fallback.
 *
 * The async clipboard API needs a secure context and a permission the user
 * may have denied — exactly the two states where a support agent most needs
 * to paste a report. The textarea fallback works in both.
 */
export const copyText = async (text: string): Promise<boolean> => {
  try {
    if (navigator.clipboard?.writeText) {
      await navigator.clipboard.writeText(text);
      return true;
    }
  } catch { /* fall through to the legacy path */ }

  try {
    const ta = document.createElement('textarea');
    ta.value = text;
    ta.setAttribute('readonly', '');
    ta.style.position = 'fixed';
    ta.style.opacity = '0';
    document.body.appendChild(ta);
    ta.select();
    const ok = document.execCommand('copy');
    document.body.removeChild(ta);
    return ok;
  } catch {
    return false;
  }
};