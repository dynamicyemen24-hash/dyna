export type SupportedLanguage = 'ar' | 'en' | 'ur' | 'fr';

export interface LanguageConfig {
  code: SupportedLanguage;
  name: string;
  nativeName: string;
  dir: 'rtl' | 'ltr';
  flag: string;
}

export const SUPPORTED_LANGUAGES: LanguageConfig[] = [
  { code: 'ar', name: 'Arabic', nativeName: 'العربية', dir: 'rtl', flag: '🇸🇦' },
  { code: 'en', name: 'English', nativeName: 'English', dir: 'ltr', flag: '🇺🇸' },
  { code: 'ur', name: 'Urdu', nativeName: 'اردو', dir: 'rtl', flag: '🇵🇰' },
  { code: 'fr', name: 'French', nativeName: 'Français', dir: 'ltr', flag: '🇫🇷' },
];

export const TRANSLATIONS: Record<SupportedLanguage, Record<string, string>> = {
  ar: {
    // Brand & Company
    ownerCompany: 'شركة المنافذ الذكية للبرمجيات (Smart Ports Software)',
    ownerCompanyShort: 'المنافذ الذكية',
    brandName: 'DyPOS Cloud & Edge',
    brandSubtitle: 'المنظومة السحابية الذكية لنقاط البيع وإدارة المنشآت',

    // Navigation Tabs
    tabPos: 'نقطة البيع (POS)',
    tabInventory: 'إدارة المستودع',
    tabPurchases: 'المشتريات والموردين',
    tabAccounting: 'المحاسبة والقيود',
    tabHr: 'الموارد البشرية',
    tabReports: 'التقارير والمبيعات',
    tabCustomers: 'دليل العملاء',
    tabBranches: 'الفروع والورديات',
    tabThirdParty: 'تطبيقات التوصيل',
    tabRestaurant: 'إدارة الطاولات',
    tabSubscriptions: 'الاشتراكات SaaS',
    tabAudit: 'سجل التدقيق',
    tabAi: 'مساعد DyPOS الذكي',
    tabSettings: 'إعدادات النظام',

    // POS & Sales
    searchProduct: 'بحث عن صنف، باركود، أو تصنيف...',
    allCategories: 'كافة التصنيفات',
    cartTitle: 'سلة المبيعات',
    emptyCart: 'السلة فارغة. اختر أصنافاً للبدء.',
    subtotal: 'المجموع الفرعي',
    tax: 'ضريبة القيمة المضافة (15%)',
    discount: 'الخصم',
    total: 'الإجمالي النهائي',
    checkout: 'إتمام الدفع والفاتورة',
    holdInvoice: 'تعليق الفاتورة',
    clearCart: 'تفريغ السلة',
    customer: 'العميل',
    cashier: 'أمين الصندوق',
    invoiceNumber: 'رقم الفاتورة',

    // Payment Methods
    paymentMada: 'مدى (Mada)',
    paymentVisa: 'فيزا / ماستركارد',
    paymentCash: 'نقداً (Cash)',
    paymentSplit: 'دفع متعدد (Split)',

    // Offline & Sync
    statusOnline: 'متصل بالسحابة وقاعدة البيانات',
    statusOffline: 'وضع غير متصل (Offline Mode)',
    statusSyncing: 'جاري المزامنة السحابية...',
    statusScheduled: 'عمليات مجدولة للترحيل',
    neonDbHealthy: 'قاعدة بيانات Neon PostgreSQL متصلة',
    forceSync: 'مزامنة فورية',
    autoSyncOnReconnect: 'جدولة تلقائية عند عودة النت',

    // General Actions
    save: 'حفظ',
    cancel: 'إلغاء',
    delete: 'حذف',
    edit: 'تعديل',
    add: 'إضافة جديد',
    printReceipt: 'طباعة الإيصال الإلكتروني',
    lockScreen: 'قفل الشاشة',
    installApp: 'تثبيت التطبيق',
    language: 'اللغة',
    theme: 'المظهر',
  },

  en: {
    // Brand & Company
    ownerCompany: 'Smart Ports Software',
    ownerCompanyShort: 'Smart Ports',
    brandName: 'DyPOS Cloud & Edge',
    brandSubtitle: 'Smart Enterprise Cloud POS & ERP System',

    // Navigation Tabs
    tabPos: 'Point of Sale (POS)',
    tabInventory: 'Inventory Management',
    tabPurchases: 'Purchases & Vendors',
    tabAccounting: 'Accounting & Ledger',
    tabHr: 'Human Resources',
    tabReports: 'Sales Reports & Analytics',
    tabCustomers: 'Customers Directory',
    tabBranches: 'Branches & Shifts',
    tabThirdParty: 'Delivery Integrations',
    tabRestaurant: 'Tables & Dining',
    tabSubscriptions: 'SaaS Subscriptions',
    tabAudit: 'Audit Trail',
    tabAi: 'DyPOS AI Assistant',
    tabSettings: 'System Settings',

    // POS & Sales
    searchProduct: 'Search products, barcode, or SKU...',
    allCategories: 'All Categories',
    cartTitle: 'Order Cart',
    emptyCart: 'Cart is empty. Select items to begin.',
    subtotal: 'Subtotal',
    tax: 'VAT (15%)',
    discount: 'Discount',
    total: 'Grand Total',
    checkout: 'Checkout & Pay',
    holdInvoice: 'Hold Order',
    clearCart: 'Clear Cart',
    customer: 'Customer',
    cashier: 'Cashier',
    invoiceNumber: 'Invoice #',

    // Payment Methods
    paymentMada: 'Mada / Debit',
    paymentVisa: 'Visa / MasterCard',
    paymentCash: 'Cash',
    paymentSplit: 'Split Payment',

    // Offline & Sync
    statusOnline: 'Connected to Cloud & PostgreSQL',
    statusOffline: 'Offline Mode (Local Storage)',
    statusSyncing: 'Syncing to Cloud...',
    statusScheduled: 'Queued for Cloud Sync',
    neonDbHealthy: 'Neon PostgreSQL Connected',
    forceSync: 'Force Sync Now',
    autoSyncOnReconnect: 'Auto-Sync on Reconnect',

    // General Actions
    save: 'Save',
    cancel: 'Cancel',
    delete: 'Delete',
    edit: 'Edit',
    add: 'Add New',
    printReceipt: 'Print e-Receipt',
    lockScreen: 'Lock Terminal',
    installApp: 'Install App',
    language: 'Language',
    theme: 'Theme',
  },

  ur: {
    ownerCompany: 'اسمارٹ پورٹس سافٹ ویئر (Smart Ports Software)',
    ownerCompanyShort: 'اسمارٹ پورٹس',
    brandName: 'DyPOS Cloud & Edge',
    brandSubtitle: 'سمارٹ کلاؤڈ پوائنٹ آف سیل اور انٹرپرائز سسٹم',

    tabPos: 'پوائنٹ آف سیل (POS)',
    tabInventory: 'انوینٹری مینجمنٹ',
    tabPurchases: 'خریداری اور سپلائرز',
    tabAccounting: 'اکاؤنٹنگ',
    tabHr: 'انسانی وسائل',
    tabReports: 'رپورٹس اور سیلز',
    tabCustomers: 'کسٹمرز',
    tabBranches: 'برانچز اور شفٹس',
    tabThirdParty: 'ڈیلیوری ایپس',
    tabRestaurant: 'ریستوران ٹیبلز',
    tabSubscriptions: 'سبسکرپشنز',
    tabAudit: 'آڈٹ لاگ',
    tabAi: 'DyPOS AI اسسٹنٹ',
    tabSettings: 'ترتیبات',

    searchProduct: 'پروڈکٹ، بارکوڈ یا کیٹیگری تلاش کریں...',
    allCategories: 'تمام اقسام',
    cartTitle: 'آرڈر کی ٹوکری',
    emptyCart: 'ٹوکری خالی ہے۔ اشیاء منتخب کریں۔',
    subtotal: 'ذیلی کل',
    tax: 'ٹیکس (15%)',
    discount: 'رعایت',
    total: 'کل رقم',
    checkout: 'ادائیگی اور رسید',
    holdInvoice: 'آرڈر محفوظ کریں',
    clearCart: 'ٹوکری صاف کریں',
    customer: 'کسٹمر',
    cashier: 'کیشیئر',
    invoiceNumber: 'انوائس نمبر',

    paymentMada: 'مدى / ڈیبٹ کارڈ',
    paymentVisa: 'ویزا / ماسٹر کارڈ',
    paymentCash: 'نقد (Cash)',
    paymentSplit: 'مشترکہ ادائیگی',

    statusOnline: 'کلاؤڈ اور ڈیٹابیس سے منسلک',
    statusOffline: 'آف لائن موڈ (محفوظ اسٹوریج)',
    statusSyncing: 'ہم آہنگی جاری ہے...',
    statusScheduled: 'شیڈول شدہ کارروائی',
    neonDbHealthy: 'Neon PostgreSQL متحرک ہے',
    forceSync: 'ابھی سنک کریں',
    autoSyncOnReconnect: 'خودکار سنک جب نیٹ آئے',

    save: 'محفوظ کریں',
    cancel: 'منسوخ کریں',
    delete: 'حذف کریں',
    edit: 'ترمیم کریں',
    add: 'نیا شامل کریں',
    printReceipt: 'رسید پرنٹ کریں',
    lockScreen: 'اسکرین لاک کریں',
    installApp: 'ایپ انسٹال کریں',
    language: 'زبان',
    theme: 'تھیم',
  },

  fr: {
    ownerCompany: 'Smart Ports Software',
    ownerCompanyShort: 'Smart Ports',
    brandName: 'DyPOS Cloud & Edge',
    brandSubtitle: 'Système Cloud de Point de Vente & Gestion Intelligente',

    tabPos: 'Point de Vente (POS)',
    tabInventory: 'Gestion des Stocks',
    tabPurchases: 'Achats & Fournisseurs',
    tabAccounting: 'Comptabilité & Grand Livre',
    tabHr: 'Ressources Humaines',
    tabReports: 'Rapports & Ventes',
    tabCustomers: 'Répertoire Clients',
    tabBranches: 'Succursales & Postes',
    tabThirdParty: 'Intégrations Livraison',
    tabRestaurant: 'Tables & Salle',
    tabSubscriptions: 'Abonnements SaaS',
    tabAudit: 'Journal d’Audit',
    tabAi: 'Assistant DyPOS IA',
    tabSettings: 'Paramètres Système',

    searchProduct: 'Rechercher produit, code-barres...',
    allCategories: 'Toutes les catégories',
    cartTitle: 'Panier de Vente',
    emptyCart: 'Le panier est vide.',
    subtotal: 'Sous-total',
    tax: 'TVA (15%)',
    discount: 'Remise',
    total: 'Total Général',
    checkout: 'Finaliser & Encaisser',
    holdInvoice: 'Mettre en attente',
    clearCart: 'Vider le panier',
    customer: 'Client',
    cashier: 'Caissier',
    invoiceNumber: 'Facture N°',

    paymentMada: 'Carte Bancaire / Débit',
    paymentVisa: 'Visa / MasterCard',
    paymentCash: 'Espèces',
    paymentSplit: 'Paiement Mixte',

    statusOnline: 'Connecté au Cloud & PostgreSQL',
    statusOffline: 'Mode Hors Ligne (Offline)',
    statusSyncing: 'Synchronisation Cloud...',
    statusScheduled: 'En attente de synchronisation',
    neonDbHealthy: 'Neon PostgreSQL Connecté',
    forceSync: 'Synchroniser Maintenant',
    autoSyncOnReconnect: 'Sync automatique au retour',

    save: 'Enregistrer',
    cancel: 'Annuler',
    delete: 'Supprimer',
    edit: 'Modifier',
    add: 'Ajouter',
    printReceipt: 'Imprimer Ticket',
    lockScreen: 'Verrouiller',
    installApp: 'Installer l’application',
    language: 'Langue',
    theme: 'Thème',
  },
};

const STORAGE_KEY = 'dypos_language';

class I18nManager {
  private currentLanguage: SupportedLanguage = 'ar';
  private listeners: Set<(lang: SupportedLanguage) => void> = new Set();

  constructor() {
    if (typeof window !== 'undefined') {
      const saved = localStorage.getItem(STORAGE_KEY) as SupportedLanguage;
      if (saved && TRANSLATIONS[saved]) {
        this.currentLanguage = saved;
      }
      this.applyDomSettings();
    }
  }

  private applyDomSettings() {
    if (typeof document === 'undefined') return;
    const config = this.getLanguageConfig();
    document.documentElement.lang = config.code;
    document.documentElement.dir = config.dir;
  }

  public getLanguage(): SupportedLanguage {
    return this.currentLanguage;
  }

  public getLanguageConfig(): LanguageConfig {
    return (
      SUPPORTED_LANGUAGES.find((l) => l.code === this.currentLanguage) ||
      SUPPORTED_LANGUAGES[0]
    );
  }

  public setLanguage(code: SupportedLanguage) {
    if (!TRANSLATIONS[code]) return;
    this.currentLanguage = code;
    if (typeof window !== 'undefined') {
      localStorage.setItem(STORAGE_KEY, code);
      this.applyDomSettings();
    }
    this.listeners.forEach((listener) => {
      try {
        listener(code);
      } catch (err) {
        console.error('I18n listener error:', err);
      }
    });
  }

  public t(key: string, fallback?: string): string {
    const dict = TRANSLATIONS[this.currentLanguage];
    if (dict && dict[key]) {
      return dict[key];
    }
    const defaultDict = TRANSLATIONS['ar'];
    if (defaultDict && defaultDict[key]) {
      return defaultDict[key];
    }
    return fallback || key;
  }

  public subscribe(listener: (lang: SupportedLanguage) => void): () => void {
    this.listeners.add(listener);
    listener(this.currentLanguage);
    return () => {
      this.listeners.delete(listener);
    };
  }
}

export const i18n = new I18nManager();
