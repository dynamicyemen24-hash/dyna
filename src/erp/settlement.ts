/**
 * Promotion and stock-settlement engines.
 *
 * Both exist because the naive version of these operations is quietly wrong:
 * a flat discount field cannot express "buy 3 pay for 2", and an uncapped
 * percentage discount can sell a basket below cost.
 */

export interface OfferRule {
  code: string;
  name: string;
  ruleType:
    | 'percent_off' | 'amount_off' | 'buy_x_get_y'
    | 'bundle_price' | 'threshold_tier' | 'free_shipping';
  operandA: number;
  operandB: number;
  minQty: number;
  minAmount: number;
  maxDiscount: number | null;
  appliesTo: 'order' | 'line' | 'category' | 'product';
  appliesValue: string | null;
  stackable: boolean;
  priority: number;
}

export interface OfferLine {
  productId: string;
  name: string;
  qty: number;
  unitPrice: number;
  category?: string;
}

export interface AppliedOffer {
  code: string;
  name: string;
  discount: number;
  reason: string;
}

export interface OfferEvaluation {
  lineDiscounts: Array<{ productId: string; discount: number; offerCode: string }>;
  applied: AppliedOffer[];
  totalDiscount: number;
  /** Discount as a share of the pre-discount basket. */
  effectiveDiscountPct: number;
  /** Offers skipped, with the reason, so the UI can explain the basket. */
  rejected: Array<{ code: string; reason: string }>;
}

const lineGross = (l: OfferLine) => l.qty * l.unitPrice;

/**
 * Evaluates offers against a basket, honouring priority, caps, thresholds and
 * the stackability rule.
 *
 * Two rules keep this honest: an offer that does not qualify contributes zero
 * rather than throwing, and a non-stackable offer is refused once one has
 * applied — so a basket never silently stacks every promotion in the shop.
 */
export function evaluateOffers(
  lines: OfferLine[],
  basketAmount: number,
  offers: OfferRule[],
): OfferEvaluation {
  const applicable = [...offers].sort((a, b) => a.priority - b.priority);
  const applied: AppliedOffer[] = [];
  const rejected: Array<{ code: string; reason: string }> = [];
  const lineDiscounts: Array<{ productId: string; discount: number; offerCode: string }> = [];

  let nonStackableUsed = false;

  for (const offer of applicable) {
    if (!offer.stackable && nonStackableUsed) {
      rejected.push({ code: offer.code, reason: 'غير قابل للتجميع مع عرض آخر' });
      continue;
    }

    let discount = 0;
    let reason = '';

    switch (offer.ruleType) {
      case 'percent_off': {
        if (basketAmount < offer.minAmount) {
          rejected.push({ code: offer.code, reason: `السلة ${basketAmount} أقل من الحد ${offer.minAmount}` });
          continue;
        }
        discount = (basketAmount * offer.operandA) / 100;
        reason = `${offer.operandA}% على سلة ${basketAmount}`;
        break;
      }
      case 'amount_off': {
        if (basketAmount < offer.minAmount) {
          rejected.push({ code: offer.code, reason: `السلة ${basketAmount} أقل من الحد ${offer.minAmount}` });
          continue;
        }
        discount = offer.operandA;
        reason = `خصم ثابت ${offer.operandA}`;
        break;
      }
      case 'threshold_tier': {
        if (basketAmount < offer.operandA) {
          rejected.push({ code: offer.code, reason: `السلة ${basketAmount} أقل من عتبة ${offer.operandA}` });
          continue;
        }
        discount = (basketAmount * offer.operandB) / 100;
        reason = `${offer.operandB}% لتجاوز ${offer.operandA}`;
        break;
      }
      case 'buy_x_get_y': {
        // For every complete group of X bought, Y units are free. Only the
        // *complete* groups count — 5 units with a "buy 3 get 2" rule yields
        // ONE free pair (the remaining 2 are still paid for), not two.
        const x = offer.operandA;
        const y = offer.operandB;
        if (!(x > 0)) break;
        for (const l of lines) {
          const groups = Math.floor(l.qty / x);
          const freeUnits = groups * y;
          if (freeUnits <= 0) continue;
          const d = freeUnits * l.unitPrice;
          lineDiscounts.push({ productId: l.productId, discount: Number(d.toFixed(2)), offerCode: offer.code });
          discount += d;
        }
        if (discount === 0) {
          rejected.push({ code: offer.code, reason: `لا يوجد سطر بكميات ${x} كاملة` });
          continue;
        }
        reason = `${x} مدفوع + ${y} مجاناً`;
        break;
      }
      case 'bundle_price': {
        const target = lines.filter((l) =>
          offer.appliesTo === 'category'
            ? l.category === offer.appliesValue
            : l.productId === offer.appliesValue,
        );
        const total = target.reduce((s, l) => s + lineGross(l), 0);
        // Never "discount" to more than the bundle actually costs.
        if (target.length === 0 || total <= offer.operandA) {
          rejected.push({ code: offer.code, reason: 'الباقة غير مكتملة أو ليست أوفر' });
          continue;
        }
        discount = total - offer.operandA;
        reason = `سعر الباقة ${offer.operandA} بدل ${total.toFixed(2)}`;
        break;
      }
      case 'free_shipping':
        discount = 0;
        reason = 'شحن مجاني';
        break;
    }

    // A cap protects margin; without one a deep percentage runs away.
    if (offer.maxDiscount !== null && discount > offer.maxDiscount) {
      rejected.push({ code: offer.code, reason: `تجاوز سقف الخصم ${offer.maxDiscount}` });
      discount = offer.maxDiscount;
    }

    discount = Number(Math.min(discount, basketAmount).toFixed(2));
    if (discount <= 0) continue;

    applied.push({ code: offer.code, name: offer.name, discount, reason });
    if (!offer.stackable) nonStackableUsed = true;
  }

  // A line-scoped rule has already recorded its discount against each product
// line, so summing both buckets here would count it twice. `applied` is a
// narrative record of what ran; `lineDiscounts` plus order-level offers are
// the two actual sources of value.
const lineLevelDiscount = new Set(
  offers.filter((o) => o.appliesTo === 'line' || o.appliesTo === 'category' || o.appliesTo === 'product')
    .map((o) => o.code),
);

const lineTotal = lineDiscounts.reduce((s, d) => s + d.discount, 0);
const orderTotal = applied
  .filter((o) => !lineLevelDiscount.has(o.code))
  .reduce((s, o) => s + o.discount, 0);

const totalDiscount = Number(Math.min(lineTotal + orderTotal, basketAmount).toFixed(2));

  return {
    lineDiscounts,
    applied,
    totalDiscount,
    effectiveDiscountPct: basketAmount > 0
      ? Number(((totalDiscount / basketAmount) * 100).toFixed(2))
      : 0,
    rejected,
  };
}

// ---------------------------------------------------------------------------
// STOCK SETTLEMENT / CYCLE COUNT
// ---------------------------------------------------------------------------

export interface CountLine {
  productId: string;
  systemQty: number;
  countedQty: number;
  unitCost: number;
}

export interface SettlementResult {
  lines: Array<CountLine & { varianceQty: number; varianceValue: number; reason: string }>;
  shrinkQty: number;
  surplusQty: number;
  shrinkValue: number;
  surplusValue: number;
  netVarianceValue: number;
  /** Variance as a share of the counted value — the shrinkage KPI. */
  shrinkagePct: number;
}

/** Variance tolerance below which a difference is counting noise, not a loss. */
const DEFAULT_TOLERANCE_PCT = 0.5;

/**
 * Reconciles counted stock against the system and costs the difference.
 *
 * Variance is costed at moving average, which is what makes the shrinkage
 * figure meaningful: it is money the business believes it lost, not a unit
 * count. Differences inside the tolerance are reported but NOT charged —
 * counting error is not a loss, and booking it as one poisons the inventory
 * valuation and manufactures an auditor question every single period.
 */
export function reconcileStock(
  lines: CountLine[],
  tolerancePct = DEFAULT_TOLERANCE_PCT,
): SettlementResult {
  const out: SettlementResult['lines'] = [];
  let shrinkQty = 0;
  let surplusQty = 0;
  let shrinkValue = 0;
  let surplusValue = 0;

  for (const l of lines) {
    const varianceQty = Number((l.countedQty - l.systemQty).toFixed(6));
    const varianceValue = Number((varianceQty * l.unitCost).toFixed(2));

    // Express the variance against the system position.
    const pct = l.systemQty !== 0 ? Math.abs((varianceQty / l.systemQty) * 100) : 0;
    const withinTolerance = pct <= tolerancePct;

    const reason =
      varianceQty === 0 ? 'مطابق'
      : varianceQty < 0
        ? (withinTolerance ? 'نقص ضمن حد التسامح' : 'نقص فعلي — تلف أو فقد')
        : (withinTolerance ? 'زيادة ضمن حد التسامح' : 'زيادة فعلية');

    if (varianceQty < 0) {
      shrinkQty += -varianceQty;
      if (!withinTolerance) shrinkValue += -varianceValue;
    } else if (varianceQty > 0) {
      surplusQty += varianceQty;
      if (!withinTolerance) surplusValue += varianceValue;
    }

    out.push({ ...l, varianceQty, varianceValue, reason });
  }

  const countedValue = lines.reduce((s, l) => s + l.countedQty * l.unitCost, 0);

  return {
    lines: out,
    shrinkQty: Number(shrinkQty.toFixed(6)),
    surplusQty: Number(surplusQty.toFixed(6)),
    shrinkValue: Number(shrinkValue.toFixed(2)),
    surplusValue: Number(surplusValue.toFixed(2)),
    netVarianceValue: Number((surplusValue - shrinkValue).toFixed(2)),
    shrinkagePct: countedValue > 0
      ? Number(((shrinkValue / countedValue) * 100).toFixed(3))
      : 0,
  };
}