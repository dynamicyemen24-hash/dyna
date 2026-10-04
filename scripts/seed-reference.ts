/**
 * Reference data for the Royal Global institutional seed.
 * Kept separate from the writer so both files stay readable.
 */

export const TENANT = 'royal-global-hq';

export const BRANCHES = [
  { id: 'rg-branch-hq', code: 'HQ-RUH', name: 'الفرع الرئيسي — الرياض', city: 'الرياض',
    phone: '0112345678', address: 'حي العليا، طريق الملك فهد، برج المملكة',
    manager: 'يعقوب يوسف سهل' },
  { id: 'rg-branch-marib', code: 'MRB-MAR', name: 'فرع مارب', city: 'مارب',
    phone: '0691234567', address: 'شارع المدينة، مركز مارب التجاري',
    manager: 'سهل عبدالله الأحمدي' },
  { id: 'rg-branch-jeddah', code: 'JED-JED', name: 'فرع جدة', city: 'جدة',
    phone: '0123456789', address: 'حي الروضة، شارع الأمير سلطان',
    manager: 'نورة سعد القحطاني' },
];

export const USERS = [
  { id: 'rg-user-yacoub', name: 'يعقوب يوسف سهل', email: 'yacoub@royalglobal.sa',
    phone: '0551112233', role: 'owner', branch: 'rg-branch-hq' },
  { id: 'rg-user-sahl', name: 'سهل عبدالله الأحمدي', email: 'sahl@royalglobal.sa',
    phone: '0552223344', role: 'manager', branch: 'rg-branch-marib' },
  { id: 'rg-user-noura', name: ' كاشير 1 ', email: 'noura@royalglobal.sa',
    phone: '0553334455', role: 'manager', branch: 'rg-branch-jeddah' },
  { id: 'rg-user-fahad', name: '  كاشير 2', email: 'fahad@royalglobal.sa',
    phone: '0554445566', role: 'cashier', branch: 'rg-branch-hq' },
];

export const WAREHOUSES = [
  { id: 'rg-wh-main', name: 'المستودع الرئيسي', branch: 'rg-branch-hq', city: 'الرياض' },
  { id: 'rg-wh-marib', name: 'مستودع مارب', branch: 'rg-branch-marib', city: 'مارب' },
];

export const EMPLOYEES = [
  { id: 'rg-emp-1', name: 'يعقوب يوسف سهل', role: 'المالك والمدير العام',
    branch: 'rg-branch-hq', salary: 18000, rate: 0 },
  { id: 'rg-emp-2', name: 'سهل عبدالله الأحمدي', role: 'مدير فرع مارب',
    branch: 'rg-branch-marib', salary: 11000, rate: 1.5 },
  { id: 'rg-emp-3', name: 'نورة سعد القحطاني', role: 'مديرة فرع جدة',
    branch: 'rg-branch-jeddah', salary: 11000, rate: 1.5 },
  { id: 'rg-emp-4', name: 'فهد محمد العتيبي', role: 'كاشير رئيسي',
    branch: 'rg-branch-hq', salary: 6500, rate: 1.0 },
  { id: 'rg-emp-5', name: 'ريم خالد المطيري', role: 'محاسبة',
    branch: 'rg-branch-hq', salary: 9000, rate: 0.5 },
  { id: 'rg-emp-6', name: 'سلطان فهد الحربي', role: 'أمين مستودع',
    branch: 'rg-branch-marib', salary: 5500, rate: 0 },
  { id: 'rg-emp-7', name: 'منى سالم العتيبي', role: 'منسقة مبيعات',
    branch: 'rg-branch-jeddah', salary: 6000, rate: 1.2 },
  { id: 'rg-emp-8', name: 'عبدالرحمن ناصر', role: 'مندوب توصيل',
    branch: 'rg-branch-hq', salary: 5000, rate: 0.3 },
];

export const CUSTOMERS = [
  { name: 'مؤسسة النخبة التجارية', phone: '0501000001', email: 'elite@example.com',
    points: 1250, balance: 4500, credit: 20000, tax: '300012345600003' },
  { name: 'شركة الأثاث الحديث', phone: '0501000002', email: 'furniture@example.com',
    points: 890, balance: 0, credit: 15000, tax: '300012345600003' },
  { name: 'مؤسسة مسك للتجارة', phone: '0501000003', email: 'misk@example.com',
    points: 2100, balance: 12400, credit: 30000, tax: '300098765400003' },
  { name: 'عبدالرحمن الشمري', phone: '0501000004', email: null,
    points: 340, balance: 250, credit: 5000, tax: null },
  { name: 'هند العتيبي', phone: '0501000005', email: 'hind@example.com',
    points: 720, balance: 0, credit: 8000, tax: null },
  { name: 'مؤسسة الواحة الذهبية', phone: '0501000006', email: 'oasis@example.com',
    points: 450, balance: 8750, credit: 25000, tax: '300022334400003' },
  { name: 'فيصل الدوسري', phone: '0501000007', email: null,
    points: 95, balance: 0, credit: 3000, tax: null },
  { name: 'شركة Laguna للتوريدات', phone: '0501000008', email: 'laguna@example.com',
    points: 1890, balance: 3200, credit: 40000, tax: '300044556600003' },
  { name: 'ريم السبيعي', phone: '0501000009', email: null,
    points: 530, balance: 150, credit: 6000, tax: null },
  { name: 'مؤسسة أتقان الخليج', phone: '0501000010', email: 'itqan@example.com',
    points: 1450, balance: 6700, credit: 35000, tax: '300066778800003' },
];

export const SUPPLIERS = [
  { name: 'شركة أوني للتوزيع', contact: 'أحمد كامل', phone: '0543210987',
    email: 'sales@uni.example.com', category: 'عطور وتجميل', due: 18500 },
  { name: 'مؤسسة الروائح الشرقية', contact: 'يوسف العلي', phone: '0567890123',
    email: 'orders@oriental.example.com', category: 'عطور ومخبرات', due: 9200 },
  { name: 'شركة بيوتي لنور للتوريد', contact: 'سامي الحسن', phone: '0509988776',
    email: 'info@beauty.example.com', category: 'مستحضرات تجميل', due: 7400 },
  { name: 'مصنع الخليج للورق', contact: 'ماجد الدوسري', phone: '0566123450',
    email: 'sales@gulfpaper.example.com', category: 'مستلزمات', due: 3200 },
];

export const CHART = [
  { code: '1000', name: 'النقدية في البنك', type: 'asset' },
  { code: '1100', name: 'النقدية في الصندوق', type: 'asset' },
  { code: '1200', name: 'الذمم المدينة', type: 'asset' },
  { code: '1300', name: 'المخزون', type: 'asset' },
  { code: '2000', name: 'ذمم دائنة الموردين', type: 'liability' },
  { code: '2100', name: 'ضريبة القيمة المضافة المستحقة', type: 'liability' },
  { code: '3000', name: 'رأس المال', type: 'equity' },
  { code: '3100', name: 'الأرباح المحتجزة', type: 'equity' },
  { code: '4000', name: 'إيرادات المبيعات', type: 'revenue' },
  { code: '4100', name: 'مردودات المبيعات', type: 'revenue' },
  { code: '5000', name: 'تكلفة المبيعات', type: 'expense' },
  { code: '6000', name: 'مصروف الرواتب', type: 'expense' },
  { code: '6100', name: 'مصروف الإيجار', type: 'expense' },
  { code: '6200', name: 'مصروف كهرباء ومياه', type: 'expense' },
  { code: '6300', name: 'مصروف المشتريات', type: 'expense' },
];

export const CURRENCIES = [
  { code: 'SAR', name: 'ريال سعودي', symbol: 'ر.س', rate: 1.0 },
  { code: 'USD', name: 'دولار أمريكي', symbol: '$', rate: 3.75 },
  { code: 'EUR', name: 'يورو', symbol: '€', rate: 4.05 },
  { code: 'AED', name: 'درهم إماراتي', symbol: 'د.إ', rate: 1.02 },
];