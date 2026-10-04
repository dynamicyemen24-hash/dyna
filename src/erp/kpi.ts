/**
 * Decision KPI engine — the catalogue.
 *
 * A number is only a KPI when it can change a decision. Every metric here
 * carries four things a dashboard alone cannot supply:
 *   1. an auditable formula,
 *   2. a benchmark to measure against,
 *   3. the direction that is GOOD (a lower DIO is better; a higher DSO is not),
 *   4. the concrete action to take when it breaches.
 *
 * Metrics that fail test (4) are deliberately excluded. "Total customers" is
 * not a KPI — nobody can act on it.
 */

export type KpiCategory =
  | 'sales' | 'margin' | 'inventory' | 'receivable'
  | 'payable' | 'cash' | 'fx' | 'hr' | 'compliance';

/** Which direction is healthy. Getting this wrong inverts every alert. */
export type Polarity = 'higher' | 'lower' | 'target';

export type KpiUnit = 'currency' | 'percent' | 'days' | 'ratio' | 'count';

export interface KpiDefinition {
  code: string;
  name: string;
  nameEn: string;
  category: KpiCategory;
  polarity: Polarity;
  unit: KpiUnit;
  formula: string;
  benchmark: number | null;
  warn: number | null;
  critical: number | null;
  /** What the operator should actually do about a breach. */
  action: string;
  sortOrder: number;
}

/**
 * The catalogue. Benchmarks are retail defaults meant to be overridden per
 * tenant — they are starting points, not truths.
 */
export const KPI_CATALOGUE: KpiDefinition[] = [
  // ---------------- SALES ----------------
  {
    code: 'net_sales_30d', name: 'صافي المبيعات (30 يوم)', nameEn: 'Net Sales 30d',
    category: 'sales', polarity: 'higher', unit: 'currency',
    formula: 'SUM(base_subtotal) WHERE status=completed AND created_at >= now()-30d',
    benchmark: null, warn: null, critical: null,
    action: 'انخفاض عن الشهر السابق: افحص أداء الفروع والأصناف الراكدة',
    sortOrder: 10,
  },
  {
    code: 'sales_growth_mom', name: 'النمو الشهري', nameEn: 'MoM Sales Growth',
    category: 'sales', polarity: 'higher', unit: 'percent',
    formula: '((sales_this_month - sales_last_month) / sales_last_month) * 100',
    benchmark: 5, warn: 0, critical: -10,
    action: 'تراجع: افحص الحركة اليومية والأسبوع الأخير تحديداً',
    sortOrder: 11,
  },
  {
    code: 'avg_basket_value', name: 'متوسط قيمة الفاتورة', nameEn: 'Average Basket Value',
    category: 'sales', polarity: 'higher', unit: 'currency',
    formula: 'SUM(base_total) / COUNT(DISTINCT invoice_id)',
    benchmark: null, warn: null, critical: null,
    action: 'انخفاضها: فعّل البيع المقترح أو باقات تشجيع الكمية',
    sortOrder: 12,
  },
  {
    code: 'units_per_transaction', name: 'متوسط عدد القطع/الفاتورة', nameEn: 'Units per Transaction',
    category: 'sales', polarity: 'higher', unit: 'ratio',
    formula: 'SUM(item.qty) / COUNT(DISTINCT invoice_id)',
    benchmark: 2.0, warn: 1.5, critical: 1.0,
    action: 'قيمة منخفضة: كل قطعة تُقلّص هامش الفاتورة — ارفع الحافز للبيع الإضافي',
    sortOrder: 13,
  },
  {
    code: 'selling_days', name: 'أيام البيع الفعّالة/30', nameEn: 'Active Selling Days',
    category: 'sales', polarity: 'higher', unit: 'count',
    formula: 'COUNT(DISTINCT created_at::date) WHERE created_at >= now()-30d',
    benchmark: 26, warn: 20, critical: 14,
    action: 'أيام مغلقة دون بيع: تحقق من ساعات العمل وتغطية الفروع',
    sortOrder: 14,
  },

  // ---------------- MARGIN ----------------
  {
    code: 'gross_margin_pct', name: 'هامش الربح الإجمالي', nameEn: 'Gross Margin %',
    category: 'margin', polarity: 'higher', unit: 'percent',
    formula: '(SUM(base_subtotal) - SUM(item.qty*item.cost)) / SUM(base_subtotal) * 100',
    benchmark: 30, warn: 22, critical: 15,
    action: 'هامش منخفض: راجع تكلفة الشراء وسعر البيع — لا ترفع السعر قبل تثبيت التكلفة',
    sortOrder: 20,
  },
  {
    code: 'price_realisation_pct', name: 'نسبة تحقيق السعر', nameEn: 'Price Realisation %',
    category: 'margin', polarity: 'higher', unit: 'percent',
    formula: 'AVG(item.price / products.unit_price) * 100',
    benchmark: 95, warn: 88, critical: 80,
    action: 'تحقيق منخفض مع حجم ثابت: تسرّب هوامش عبر خصم غير مصرّح به',
    sortOrder: 21,
  },
  {
    code: 'discount_ratio_pct', name: 'نسبة الخصومات الممنوحة', nameEn: 'Discount Ratio %',
    category: 'margin', polarity: 'lower', unit: 'percent',
    formula: 'SUM(discount) / SUM(base_subtotal) * 100',
    benchmark: 5, warn: 10, critical: 18,
    action: 'نسبة مرتفعة: قصر صلاحية الخصم على مدير المبيعات وراجع سجل الصلاحيات',
    sortOrder: 22,
  },

  // ---------------- INVENTORY ----------------
  {
    code: 'inventory_turnover', name: 'دوران المخزون', nameEn: 'Inventory Turnover',
    category: 'inventory', polarity: 'higher', unit: 'ratio',
    formula: 'COGS(365d) / AVG(inventory_value)',
    benchmark: 6, warn: 4, critical: 2,
    action: 'دوران منخفض: المال محبوس في بضاعة لا تتحرك',
    sortOrder: 30,
  },
  {
    code: 'dio_days', name: 'مدة بقاء المخزون', nameEn: 'Days Inventory Outstanding',
    category: 'inventory', polarity: 'lower', unit: 'days',
    formula: 'AVG(inventory_value) / COGS(365d) * 365',
    benchmark: 45, warn: 75, critical: 120,
    action: 'مدة طويلة: جمّد إعادة الطلب وبِعِ الراكد قبل أن يلتهم السيولة',
    sortOrder: 31,
  },
  {
    code: 'dead_stock_pct', name: 'نسبة المخزون الراكد', nameEn: 'Dead Stock %',
    category: 'inventory', polarity: 'lower', unit: 'percent',
    formula: 'SUM(cost*stock WHERE no sale in 90d) / SUM(cost*stock) * 100',
    benchmark: 15, warn: 25, critical: 40,
    action: 'نسبة مرتفعة: خفّض إعادة الطلب لهذه الأصناف وراجع خطة الشراء',
    sortOrder: 32,
  },
  {
    code: 'stockout_risk_count', name: 'أصناف تحت حد الطلب', nameEn: 'Stock-out Risk Items',
    category: 'inventory', polarity: 'lower', unit: 'count',
    formula: 'COUNT(products WHERE stock <= reorder_point)',
    benchmark: 0, warn: 5, critical: 15,
    action: 'إنشاء أوامر شراء فورية — كل يوم نقص يعني مبيعات ضائعة',
    sortOrder: 33,
  },
  {
    code: 'inventory_accuracy_pct', name: 'دقة المخزون', nameEn: 'Inventory Accuracy %',
    category: 'inventory', polarity: 'higher', unit: 'percent',
    formula: '(1 - SUM(ABS(variance_qty)) / SUM(system_qty)) * 100',
    benchmark: 98, warn: 95, critical: 90,
    action: 'دقة منخفضة: جرد دوري متصاعد — فروقات الجرد تفسد قرار الشراء كله',
    sortOrder: 34,
  },
  {
    code: 'shrinkage_rate_pct', name: 'نسبة التلف والفقد', nameEn: 'Shrinkage Rate %',
    category: 'inventory', polarity: 'lower', unit: 'percent',
    formula: 'SUM(shrink_value) / SUM(counted_value) * 100',
    benchmark: 1, warn: 2, critical: 4,
    action: 'فقد مرتفع: راجع إجراءات الاستلام والإرجاع — قد يكون تلاعباً',
    sortOrder: 35,
  },
  {
    code: 'aging_stock_pct', name: 'نسبة مخزون قرب الانتهاء', nameEn: 'Near-Expiry Stock %',
    category: 'inventory', polarity: 'lower', unit: 'percent',
    formula: 'SUM(quantity*cost WHERE expiry within 60d) / SUM(quantity*cost) * 100',
    benchmark: 3, warn: 8, critical: 15,
    action: 'تصريف فوري بعرض تخفيضي منظّم أو إتلاف موثّق',
    sortOrder: 36,
  },

  // ---------------- RECEIVABLE ----------------
  {
    code: 'dso_days', name: 'مدة تحصيل الذمم', nameEn: 'Days Sales Outstanding',
    category: 'receivable', polarity: 'lower', unit: 'days',
    formula: 'AVG(AR outstanding) / (net_sales_365 / 365)',
    benchmark: 35, warn: 50, critical: 75,
    action: 'تحصيل بطيء: شدّد سياسة الائتمان ووقف البيع الآجل للمتخلفين',
    sortOrder: 40,
  },
  {
    code: 'overdue_ar_pct', name: 'نسبة الذمم المتأخرة', nameEn: 'Overdue AR %',
    category: 'receivable', polarity: 'lower', unit: 'percent',
    formula: 'SUM(AR outstanding WHERE due_date < today) / SUM(AR outstanding) * 100',
    benchmark: 10, warn: 20, critical: 35,
    action: 'متأخرات عالية: جدولة تحصيل فورية ووقف سقف ائتماني جديد',
    sortOrder: 41,
  },
  {
    code: 'credit_utilisation_pct', name: 'استخدام سقف الائتمان', nameEn: 'Credit Utilisation %',
    category: 'receivable', polarity: 'lower', unit: 'percent',
    formula: 'SUM(customer outstanding) / SUM(customer credit_limit) * 100',
    benchmark: 50, warn: 75, critical: 90,
    action: 'استخدام مرتفع: خفّض السقوف — خطر التعثر-default مرتفع',
    sortOrder: 42,
  },
  {
    code: 'customer_retention_pct', name: 'معدل الاحتفاظ بالعملاء', nameEn: 'Customer Retention %',
    category: 'receivable', polarity: 'higher', unit: 'percent',
    formula: 'repeat customers / total active customers * 100',
    benchmark: 40, warn: 25, critical: 15,
    action: 'احتفاظ منخفض: اكسب سبب التخلّي — عروض ولاء مستهدفة',
    sortOrder: 43,
  },

  // ---------------- PAYABLE ----------------
  {
    code: 'dpo_days', name: 'مدة سداد الموردين', nameEn: 'Days Payable Outstanding',
    category: 'payable', polarity: 'target', unit: 'days',
    formula: 'AVG(AP outstanding) / (purchases_365 / 365)',
    benchmark: 30, warn: 45, critical: 60,
    action: 'سداد متأخر: خطر قطع التوريد — راجع الالتزامات التعاقدية',
    sortOrder: 45,
  },
  {
    code: 'overdue_ap_pct', name: 'نسبة المستحقات للموردين', nameEn: 'Overdue AP %',
    category: 'payable', polarity: 'lower', unit: 'percent',
    formula: 'SUM(AP outstanding WHERE due_date < today) / SUM(AP outstanding) * 100',
    benchmark: 5, warn: 15, critical: 30,
    action: 'مستحقات متأخرة: سدّد فوراً لتفادي تعليق التوريد',
    sortOrder: 46,
  },

  // ---------------- CASH ----------------
  {
    code: 'ccc_days', name: 'دورة التحويل النقدي', nameEn: 'Cash Conversion Cycle',
    category: 'cash', polarity: 'lower', unit: 'days',
    formula: 'DIO + DSO - DPO',
    benchmark: 15, warn: 40, critical: 70,
    action: 'دورة طويلة: المال محبوس في المخزون والذمم — تمويل ضروري',
    sortOrder: 50,
  },
  {
    code: 'cash_sales_ratio_pct', name: 'نسبة المبيعات النقدية', nameEn: 'Cash Sales Ratio %',
    category: 'cash', polarity: 'higher', unit: 'percent',
    formula: 'SUM(total WHERE payment_method = cash) / SUM(total) * 100',
    benchmark: 60, warn: 45, critical: 30,
    action: 'نسبة نقدية منخفضة: وجّه الخصم النقدي لتحسين دورة التحصيل',
    sortOrder: 51,
  },
  {
    code: 'cash_variance_abs', name: 'فروقات الصندوق', nameEn: 'Cash Variance',
    category: 'cash', polarity: 'lower', unit: 'currency',
    formula: 'SUM(ABS(cash_counts.variance))',
    benchmark: 0, warn: 50, critical: 200,
    action: 'فروقات نقدية: جرد كل وردية فوراً — الفروقات الصغيرة التراكمية تعني مشكلة',
    sortOrder: 52,
  },

  // ---------------- HR ----------------
  {
    code: 'sales_per_employee', name: 'المبيعات/موظف', nameEn: 'Sales per Employee',
    category: 'hr', polarity: 'higher', unit: 'currency',
    formula: 'net_sales_30d / active_employees',
    benchmark: null, warn: null, critical: null,
    action: 'قياس إنتاجية — قارنه بمتوسط القطاع قبل زيادة عدد الموظفين',
    sortOrder: 55,
  },
  {
    code: 'attendance_rate_pct', name: 'نسبة الحضور', nameEn: 'Attendance Rate %',
    category: 'hr', polarity: 'higher', unit: 'percent',
    formula: 'present_days / (present + absent) * 100',
    benchmark: 92, warn: 85, critical: 75,
    action: 'غياب مرتفع: راجع الحافز والظروف — الغياب المبكر يقلب التكلفة',
    sortOrder: 56,
  },
];

export type KpiStatus = 'ok' | 'warn' | 'critical' | 'insufficient_data';

export interface KpiValue {
  definition: KpiDefinition;
  value: number | null;
  status: KpiStatus;
  /** Gap against the benchmark, signed toward "good". */
  gap: number | null;
  /** Human sentence describing what to do. */
  narrative: string;
  sampleSize: number;
}

/**
 * Classifies a measurement against its thresholds, respecting polarity.
 *
 * The subtlety here is that "warn" and "critical" are NOT simply "further from
 * the benchmark". For a lower-is-better metric like days inventory, a value
 * between warn and critical is *better* news than one sitting exactly on the
 * benchmark. Naive threshold logic reports those as fine, which is how a
 * genuinely deteriorating number slips through a dashboard for months.
 */
export function classify(def: KpiDefinition, value: number | null, sampleSize = 0): {
  status: KpiStatus;
  gap: number | null;
} {
  // A metric computed from no rows is not "zero" — reporting it as zero would
  // read as the best possible number, which is the most dangerous kind of lie.
  if (value === null || !Number.isFinite(value) || sampleSize <= 0) {
    return { status: 'insufficient_data', gap: null };
  }

  // No benchmark configured means the value is reported but never judged.
  if (def.benchmark === null) {
    return { status: 'ok', gap: null };
  }
  if (def.warn === null || def.critical === null) {
    return { status: 'ok', gap: value - def.benchmark };
  }

  if (def.polarity === 'higher') {
    if (value <= def.critical) return { status: 'critical', gap: value - def.benchmark };
    if (value <= def.warn) return { status: 'warn', gap: value - def.benchmark };
    return { status: 'ok', gap: value - def.benchmark };
  }

  if (def.polarity === 'lower') {
    if (value >= def.critical) return { status: 'critical', gap: value - def.benchmark };
    if (value >= def.warn) return { status: 'warn', gap: value - def.benchmark };
    return { status: 'ok', gap: value - def.benchmark };
  }

  // 'target' — a band around the benchmark rather than a one-sided limit.
  const dev = Math.abs(value - def.benchmark);
  if (dev >= Math.abs(def.critical - def.benchmark)) return { status: 'critical', gap: value - def.benchmark };
  if (dev >= Math.abs(def.warn - def.benchmark)) return { status: 'warn', gap: value - def.benchmark };
  return { status: 'ok', gap: value - def.benchmark };
}

/** Builds the sentence an operator actually reads. */
export function narrate(def: KpiDefinition, value: number | null, status: KpiStatus): string {
  if (status === 'insufficient_data') {
    return 'لا توجد بيانات كافية لحساب هذا المؤشر — لا تُعامل الصفر كنتيجة';
  }
  const formatted =
    def.unit === 'percent' ? `${Number(value).toFixed(1)}%`
    : def.unit === 'currency' ? Number(value).toLocaleString('en-US', { maximumFractionDigits: 2 })
    : def.unit === 'days' ? `${Number(value).toFixed(0)} يوم`
    : def.unit === 'ratio' ? Number(value).toFixed(2)
    : String(value);

  if (status === 'ok') {
    return def.benchmark === null
      ? `${formatted} — يُعرض للمقارنة دون معيار محدد`
      : `${formatted} — مطابق للمعيار (${def.benchmark})`;
  }
  return `${formatted} — ${def.action}`;
}

/** Assembles a measured value into the full result object. */
export function evaluate(
  def: KpiDefinition,
  value: number | null,
  sampleSize = 0,
): KpiValue {
  const { status, gap } = classify(def, value, sampleSize);
  return { definition: def, value, status, gap, narrative: narrate(def, value, status), sampleSize };
}

/** Lookup helper. */
export function kpiByCode(code: string): KpiDefinition | undefined {
  return KPI_CATALOGUE.find((k) => k.code === code);
}

export const CATEGORY_LABELS: Record<KpiCategory, string> = {
  sales: 'المبيعات',
  margin: 'الهامش والتسعير',
  inventory: 'المخزون',
  receivable: 'الذمم المدينة',
  payable: 'الذمم الدائنة',
  cash: 'النقد والسيولة',
  fx: 'العملات والفروق',
  hr: 'الموارد البشرية',
  compliance: 'الامتثال',
};

/** Groups the catalogue for display, preserving the declared sort order. */
export function groupByCategory(
  values: KpiValue[],
): Array<{ category: KpiCategory; label: string; items: KpiValue[] }> {
  const map = new Map<KpiCategory, KpiValue[]>();
  for (const v of values) {
    const list = map.get(v.definition.category) || [];
    list.push(v);
    map.set(v.definition.category, list);
  }
  return [...map.entries()]
    .map(([category, items]) => ({
      category,
      label: CATEGORY_LABELS[category],
      items: items.sort((a, b) => a.definition.sortOrder - b.definition.sortOrder),
    }))
    .sort((a, b) => (a.items[0]?.definition.sortOrder ?? 0) - (b.items[0]?.definition.sortOrder ?? 0));
}