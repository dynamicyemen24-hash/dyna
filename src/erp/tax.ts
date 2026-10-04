import { roundMoney } from './money';

/**
 * Tax engine — regional by design.
 *
 * Two decisions matter and most simple implementations get them wrong:
 *  1. INCLUSIVE vs EXCLUSIVE. Saudi GCC VAT is quoted inclusive on retail
 *     receipts, so the net must be solved backwards: net = gross / (1 + r).
 *  2. ROUNDING ORDER. Every retail tax rule rounds the *line* first and sums
 *     afterwards. Rounding the total instead drifts by cents across a basket.
 */

export interface VatBreakdown {
  net: number;
  tax: number;
  gross: number;
  rate: number;
  inclusive: boolean;
}

export type VatMode = 'exclusive' | 'inclusive';

export function computeVat(
  amount: number,
  ratePercent: number,
  mode: VatMode = 'exclusive',
  currency = 'SAR',
): VatBreakdown {
  const r = ratePercent / 100;

  if (mode === 'inclusive') {
    const net = amount / (1 + r);
    const tax = amount - net;
    return {
      net: roundMoney(net, currency),
      tax: roundMoney(tax, currency),
      gross: roundMoney(amount, currency),
      rate: ratePercent,
      inclusive: true,
    };
  }

  const net = amount;
  const tax = net * r;
  return {
    net: roundMoney(net, currency),
    tax: roundMoney(tax, currency),
    gross: roundMoney(net + tax, currency),
    rate: ratePercent,
    inclusive: false,
  };
}

export interface TaxLineInput {
  /** Price including tax when `mode` is inclusive. */
  amount: number;
  ratePercent: number;
  quantity: number;
}

export interface TaxLineResult {
  net: number;
  tax: number;
  gross: number;
}

export interface CartTaxResult {
  lines: TaxLineResult[];
  net: number;
  tax: number;
  gross: number;
  /** Effective blended rate — handy when a basket mixes 0% and 15%. */
  effectiveRate: number;
}

/**
 * Basket-level tax that rounds per line, which is what every retail tax
 * authority expects. Summing pre-rounded lines keeps the invoice footer
 * equal to the printed receipts, avoiding reconciliation disputes.
 */
export function computeCartTax(
  lines: TaxLineInput[],
  mode: VatMode = 'inclusive',
  currency = 'SAR',
): CartTaxResult {
  const results = lines.map((l) => {
    const lineGross = l.amount * l.quantity;
    const v = computeVat(lineGross, l.ratePercent, mode, currency);
    return { net: v.net, tax: v.tax, gross: v.gross };
  });

  const net = roundMoney(results.reduce((s, l) => s + l.net, 0), currency);
  const tax = roundMoney(results.reduce((s, l) => s + l.tax, 0), currency);
  const gross = roundMoney(results.reduce((s, l) => s + l.gross, 0), currency);

  return {
    lines: results,
    net,
    tax,
    gross,
    effectiveRate: net > 0 ? Number(((tax / net) * 100).toFixed(3)) : 0,
  };
}

/**
 * Discount approval ladder. Instead of a single hard cap, the required
 * permission escalates with the discount so authority matches the value at
 * risk — the control an auditor actually looks for.
 */
export interface DiscountTier {
  upToPercent: number;
  requiresPermission: string;
  label: string;
  approver: string;
}

export const DISCOUNT_TIERS: DiscountTier[] = [
  { upToPercent: 5,  requiresPermission: 'sales.discount',         label: 'خصم تشغيلي',   approver: 'الكاشير' },
  { upToPercent: 15, requiresPermission: 'sales.discount.approve',  label: 'خصم تجاري',    approver: 'مدير المبيعات' },
  { upToPercent: 30, requiresPermission: 'sales.discount.override', label: 'خصم استثنائي', approver: 'المدير العام' },
];

export function tierFor(percent: number): DiscountTier | null {
  return DISCOUNT_TIERS.find((t) => percent <= t.upToPercent) ?? null;
}

export interface DiscountDecision {
  allowed: boolean;
  tier: DiscountTier | null;
  reason: string;
}

/**
 * Decides whether the signed-in user's permissions cover the requested
 * discount. Called on the server before the price is ever applied.
 */
export function authoriseDiscount(
  percent: number,
  has: (permission: string) => boolean,
): DiscountDecision {
  const tier = tierFor(percent);
  if (!tier) {
    return {
      allowed: false, tier: null,
      reason: `الخصم ${percent}% يتجاوز الحد الأقصى المعتمد (${DISCOUNT_TIERS.at(-1)!.upToPercent}%)`,
    };
  }
  if (has(tier.requiresPermission)) {
    return { allowed: true, tier, reason: `${tier.label} — معتمد` };
  }
  return {
    allowed: false, tier,
    reason: `${tier.label} يتطلب صلاحية: ${tier.requiresPermission}`,
  };
}