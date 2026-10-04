/**
 * Yemeni dual-zone accounting engine.
 *
 * Yemen has two monetary authorities issuing nominally identical rials. A
 * Sana'a rial and an Aden rial are not interchangeable: they trade at
 * different rates, and moving value between them is a priced transaction, not
 * a bookkeeping formality.
 *
 * Everything here is deterministic and side-effect free so the ledger can be
 * re-run and produce identical figures.
 */

export interface Zone {
  id: string;
  code: string;
  name: string;
  issuer: string;
  vatRate: number;
}

export interface IssuerCurrency {
  issuer: string;
  code: string;
  symbol: string;
  decimals: number;
  /** Value of one unit expressed in USD. */
  usdRate: number;
  /** Premium/discount against the reference issuer, as a fraction. */
  parityPct: number;
}

export class ZoneError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'ZoneError';
  }
}

/**
 * Resolves a cross-zone rate from the USD legs.
 *
 * Both currencies are quoted against USD, so the cross rate is the *quotient*
 * of the two USD rates — never their product. Reversing this is the classic
 * multi-currency defect: it produces plausible-looking but wrong figures.
 */
export function crossZoneRate(from: IssuerCurrency, to: IssuerCurrency): number {
  if (from.issuer === to.issuer && from.code === to.code) return 1;
  if (!(from.usdRate > 0) || !(to.usdRate > 0)) {
    throw new ZoneError('سعر أساس غير صالح — إحدىlegs الدولار مفقودة');
  }
  // "How many units of TO does one unit of FROM buy?"
  return from.usdRate / to.usdRate;
}

/** Percentage gap between two zones for the same nominal, in favour of north. */
export function parityGap(north: IssuerCurrency, south: IssuerCurrency): number {
  if (!(north.usdRate > 0)) return 0;
  return Number((((north.usdRate - south.usdRate) / north.usdRate) * 100).toFixed(4));
}

// ---------------------------------------------------------------------------
// FX DIFFERENTIAL
// ---------------------------------------------------------------------------

export interface FxSettlement {
  /** Amount originally booked, in the document currency. */
  bookingAmount: number;
  /** Amount actually received, in the settlement currency. */
  settlementAmount: number;
  /** Rate used when the document was booked, in units per currency unit. */
  bookingRate: number;
  /** Rate actually obtained, in units per currency unit. */
  settlementRate: number;
  /**
   * Reporting value already computed at the booking rate. Supplying it skips
   * the conversion, which is what a ledger caller does when it has already
   * posted the original entry.
   */
  bookingValue?: number;
}

export interface FxDifferential {
  /** Positive = gain, negative = loss, in the reporting currency. */
  amount: number;
  direction: 'gain' | 'loss';
  rateDelta: number;
  percentageDrift: number;
  explanation: string;
}

/**
 * The gap between the value a document was booked at and the value it actually
 * settled at. This is a real economic gain or loss and belongs in its own P&L
 * bucket — folding it into revenue or expense misstates both.
 *
 * Rates are expressed as "currency units per reporting unit" (250 YER buys
 * $1), so the reporting value of an amount is `amount / rate`. Getting this
 * inversion wrong scales every figure by the rate itself.
 */
export function computeFxDifferential(s: FxSettlement): FxDifferential {
  const toReporting = (amount: number, rate: number) =>
    rate > 0 ? amount / rate : Number.NaN;

  const bookingValue =
    s.bookingValue !== undefined
      ? s.bookingValue
      : toReporting(s.bookingAmount, s.bookingRate);
  const settlementValue = toReporting(s.settlementAmount, s.settlementRate);

  const amount = Number((settlementValue - bookingValue).toFixed(2));

  return {
    amount,
    direction: amount >= 0 ? 'gain' : 'loss',
    rateDelta: Number((s.settlementRate - s.bookingRate).toFixed(10)),
    percentageDrift: s.bookingRate > 0
      ? Number((((s.settlementRate - s.bookingRate) / s.bookingRate) * 100).toFixed(4))
      : 0,
    explanation:
      `حُجزت بقيمة ${bookingValue.toFixed(2)} بسعر ${s.bookingRate} ` +
      `واستُلمت بقيمة ${settlementValue.toFixed(2)} بسعر ${s.settlementRate} — ` +
      `الفرق ${amount >= 0 ? 'ربح' : 'خسارة'} ${Math.abs(amount).toFixed(2)}`,
  };
}

/**
 * Net settlement including the bank's spread. A mid-market rate is not what the
 * counterparty actually received; ignoring the spread overstates cash on every
 * cross-zone remittance.
 */
export function netSettlement(
  amount: number,
  rate: number,
  spreadBps: number,
): { gross: number; spread: number; net: number } {
  const gross = amount * rate;
  const spread = (gross * spreadBps) / 10_000;
  return {
    gross: Number(gross.toFixed(2)),
    spread: Number(spread.toFixed(2)),
    net: Number((gross - spread).toFixed(2)),
  };
}

// ---------------------------------------------------------------------------
// COMMISSION — progressive tiers
// ---------------------------------------------------------------------------

export interface CommissionTier {
  from: number;
  /** null marks the open-ended top band. */
  to: number | null;
  ratePct: number;
}

export interface CommissionResult {
  amount: number;
  effectiveRatePct: number;
  breakdown: Array<{
    from: number; to: number | null; sliceBase: number; ratePct: number; amount: number;
  }>;
}

/**
 * Progressive commission: every band is paid at its own rate.
 *
 * A flat rate on the whole amount pays a salesperson for the portion of the
 * target they never reached — unfair, and a controllable payroll leak. Tiers
 * pay only what each band actually earned.
 */
export function computeCommission(base: number, tiers: CommissionTier[]): CommissionResult {
  const sorted = [...tiers].sort((a, b) => a.from - b.from);
  const breakdown: CommissionResult['breakdown'] = [];

  let total = 0;

  for (const t of sorted) {
    // Only the slice of the base that actually falls inside this band counts.
    const upper = t.to ?? Number.POSITIVE_INFINITY;
    const sliceBase = Math.max(0, Math.min(base, upper) - t.from);
    if (sliceBase <= 0) continue;

    const amount = (sliceBase * t.ratePct) / 100;
    total += amount;
    breakdown.push({
      from: t.from,
      to: t.to,
      sliceBase: Number(sliceBase.toFixed(2)),
      ratePct: t.ratePct,
      amount: Number(amount.toFixed(2)),
    });
  }

  const rounded = Number(total.toFixed(2));
  return {
    amount: rounded,
    effectiveRatePct: base > 0 ? Number(((rounded / base) * 100).toFixed(4)) : 0,
    breakdown,
  };
}

// ---------------------------------------------------------------------------
// BONUSES
// ---------------------------------------------------------------------------

export interface BonusPlan {
  metric: 'sales_target' | 'margin' | 'new_customers' | 'collections' | 'items_sold';
  target: number;
  rewardType: 'fixed' | 'percent' | 'per_unit';
  rewardValue: number;
  /** Fraction of the target required before anything is paid. */
  thresholdPct?: number;
}

export interface BonusResult {
  amount: number;
  attainmentPct: number;
  qualified: boolean;
  reason: string;
}

/**
 * Bonus measured against a declared target, pro-rated above the threshold.
 *
 * A cliff (all-or-nothing) either pays nothing for real effort or pays in full
 * for the last 1% — both distort behaviour. Pro-rating rewards the extra mile
 * without creating an incentive to overshoot into margin erosion.
 */
export function computeBonus(achieved: number, plan: BonusPlan): BonusResult {
  const thresholdPct = plan.thresholdPct ?? 0;
  const attainment = plan.target > 0 ? (achieved / plan.target) * 100 : 0;

  if (achieved <= 0) {
    return {
      amount: 0,
      attainmentPct: Number(attainment.toFixed(2)),
      qualified: false,
      reason: 'لا يوجد إنجاز مسجّل',
    };
  }
  if (attainment < thresholdPct) {
    return {
      amount: 0,
      attainmentPct: Number(attainment.toFixed(2)),
      qualified: false,
      reason: `لم يتحقق الحد الأدنى ${thresholdPct}% — نسبةالتحقيق ${attainment.toFixed(1)}%`,
    };
  }

  // The payout scales linearly from the threshold up to the target, and the
  // full reward is paid at the target. Reaching the threshold exactly still
  // pays the full reward — pro-rating from zero there meant hitting the bar
  // paid nothing, which is impossible to defend to an employee.
  const progress = plan.target > 0
    ? Math.min(1, Math.max(0, attainment / 100))
    : 0;

  let amount: number;
  switch (plan.rewardType) {
    case 'fixed':
      amount = plan.rewardValue * progress;
      break;
    case 'percent':
      amount = (achieved * plan.rewardValue) / 100;
      break;
    case 'per_unit':
      amount = achieved * plan.rewardValue;
      break;
  }

  return {
    amount: Number(amount.toFixed(2)),
    attainmentPct: Number(attainment.toFixed(2)),
    qualified: true,
    reason: `تحقيق ${attainment.toFixed(1)}% من هدف ${plan.target}`,
  };
}