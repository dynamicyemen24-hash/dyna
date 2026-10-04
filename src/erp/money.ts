/**
 * Enterprise money primitive.
 *
 * Design intent follows SAP: a document keeps the currency it was written in
 * *and* its base-currency value at a fixed rate, so a historical document
 * never silently changes when the market rate moves. Reporting always uses the
 * base amount; the transaction currency stays for legal and customer records.
 *
 * Plain value object — no framework, no React — so it is unit testable and
 * reusable on both the client and the server.
 */

export interface CurrencySpec {
  code: string;
  symbol: string;
  /** ISO 4217 minor units — JPY has none, KWD has three. */
  decimals: number;
  isBase: boolean;
}

/** ISO 4217 minor units for the currencies this deployment accepts. */
const CURRENCY_MINOR_UNITS: Record<string, number> = {
  SAR: 2, USD: 2, EUR: 2, AED: 2, GBP: 2, EGP: 2,
  JPY: 0, KWD: 3, BHD: 3, OMR: 3, JOD: 3,
};

export const CURRENCY_SYMBOLS: Record<string, string> = {
  SAR: 'ر.س', USD: '$', EUR: '€', AED: 'د.إ', GBP: '£', EGP: 'ج.م',
  JPY: '¥', KWD: 'د.ك', BHD: 'د.ب', OMR: 'ر.ع', JOD: 'د.أ',
};

export function decimalsFor(code: string): number {
  return CURRENCY_MINOR_UNITS[code?.toUpperCase()] ?? 2;
}

export function symbolFor(code: string): string {
  return CURRENCY_SYMBOLS[code?.toUpperCase()] ?? code;
}

/**
 * Half-up rounding to the currency's minor unit. The EPSILON term guards
 * against 1.005 rounding down to 1.00 because of its binary representation —
 * a classic defect in hand-rolled POS tax code.
 */
export function roundMoney(value: number, code = 'SAR'): number {
  const d = decimalsFor(code);
  if (!Number.isFinite(value)) return 0;
  const nudged = value + Number.EPSILON * Math.abs(value);
  return Number((Math.round(nudged * 10 ** d) / 10 ** d).toFixed(d));
}

export class CurrencyError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'CurrencyError';
  }
}

/**
 * An amount in a specific currency together with its base-currency value at a
 * captured rate — the three-currency model: transaction / local / group.
 */
export class Money {
  readonly amount: number;
  readonly currency: string;
  readonly baseAmount: number;
  readonly baseCurrency: string;
  readonly rate: number;

  constructor(
    amount: number,
    currency = 'SAR',
    opts: { rate?: number; baseCurrency?: string } = {},
  ) {
    const code = (currency || 'SAR').toUpperCase();
    const base = (opts.baseCurrency || 'SAR').toUpperCase();
    const rounded = roundMoney(amount, code);

    this.currency = code;
    this.amount = rounded;
    this.rate = code === base ? 1 : opts.rate ?? 1;
    this.baseCurrency = base;
    this.baseAmount = roundMoney(rounded * this.rate, base);
  }

  /** Re-express the same economic value in another currency. */
  convert(to: string, rate: number): Money {
    const code = (to || '').toUpperCase();
    if (!rate || rate <= 0) {
      throw new CurrencyError(`سعر صرف غير صالح من ${this.currency} إلى ${code || '?'}`);
    }
    if (code === this.currency) return this;

    // The base-currency value is already the pivot point; converting *to* the
    // base must not divide again, or the amount collapses back to the original.
    if (code === this.baseCurrency) {
      return new Money(this.amount * this.rate, code, {
        baseCurrency: this.baseCurrency,
      });
    }

    // Between two foreign currencies always pivot through the base: never
    // multiply two rates, which is the classic double-conversion defect.
    const baseValue = this.amount * this.rate;
    return new Money(baseValue / rate, code, { rate, baseCurrency: this.baseCurrency });
  }

  /** Reporting impact of the FX movement on this document. */
  get fxDelta(): number {
    return roundMoney(this.baseAmount - this.amount, this.baseCurrency);
  }

  add(other: Money): Money {
    if (other.currency !== this.currency) {
      throw new CurrencyError(
        `لا يمكن جمع ${this.currency} مع ${other.currency} — وحّد العملة أولاً`,
      );
    }
    return new Money(this.amount + other.amount, this.currency, {
      rate: this.rate, baseCurrency: this.baseCurrency,
    });
  }

  times(qty: number): Money {
    return new Money(this.amount * qty, this.currency, {
      rate: this.rate, baseCurrency: this.baseCurrency,
    });
  }

  negate(): Money {
    return new Money(-this.amount, this.currency, {
      rate: this.rate, baseCurrency: this.baseCurrency,
    });
  }

  format(locale = 'ar-SA'): string {
    return `${this.amount.toLocaleString(locale, {
      minimumFractionDigits: decimalsFor(this.currency),
      maximumFractionDigits: decimalsFor(this.currency),
    })} ${symbolFor(this.currency)}`;
  }

  toString(): string {
    return `${this.amount.toFixed(decimalsFor(this.currency))} ${symbolFor(this.currency)}`;
  }

  toJSON() {
    return {
      amount: this.amount,
      currency: this.currency,
      baseAmount: this.baseAmount,
      baseCurrency: this.baseCurrency,
      rate: this.rate,
    };
  }
}