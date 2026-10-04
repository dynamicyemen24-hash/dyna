import { roundMoney } from './money';

/**
 * Unit of measure + quantity primitives.
 *
 * Oracle Fusion / ISO 80000 rule: a quantity is meaningless without its unit,
 * and two units are only interchangeable when the system holds an explicit
 * conversion factor for them. Nothing is inferred from unit *names* — "KG" and
 * "BAG" look different but are only convertible if a factor was configured.
 */

export interface UomSpec {
  id: string;
  code: string;
  name: string;
  /** COUNT | WEIGHT | VOLUME | LENGTH */
  dimension: string;
  /** Decimal places allowed when storing a quantity in this unit. */
  precision: number;
  isBase: boolean;
}

export interface ConversionFactor {
  fromUnitId: string;
  toUnitId: string;
  numerator: number;
  denominator: number;
}

export class UnitError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'UnitError';
  }
}

/** A quantity expressed in a specific unit, convertible to its dimension's base. */
export class Quantity {
  readonly value: number;
  readonly uom: UomSpec;

  constructor(value: number, uom: UomSpec) {
    this.value = Number(Number(value).toFixed(uom.precision));
    this.uom = uom;
  }

  /**
   * Convert to another unit of the same dimension using the configured factor
   * table. Cross-dimension conversion is rejected outright — it is always a
   * configuration error, never a legitimate operation.
   */
  convertTo(target: UomSpec, factors: ConversionFactor[]): Quantity {
    if (target.dimension !== this.uom.dimension) {
      throw new UnitError(
        `تعذّر التحويل: ${this.uom.name} (${this.uom.dimension}) لا يتبع ${target.name} (${target.dimension})`,
      );
    }
    if (target.id === this.uom.id) return this;

    const f = factors.find(
      (x) => x.fromUnitId === this.uom.id && x.toUnitId === target.id,
    );
    if (!f) {
      throw new UnitError(
        `لا يوجد معامل تحويل مُعرَّف من ${this.uom.name} إلى ${target.name}`,
      );
    }
    const raw = (this.value * f.numerator) / f.denominator;
    return new Quantity(raw, target);
  }

  add(other: Quantity, factors: ConversionFactor[]): Quantity {
    return new Quantity(this.value + other.convertTo(this.uom, factors).value, this.uom);
  }

  toString(): string {
    return `${this.value} ${this.uom.code}`;
  }
}

/**
 * Total stock for a product expressed in one consistent unit. Summing across
 * units is the classic inventory bug, so callers must state the target unit
 * and the factors — there is no implicit unit.
 */
export function normaliseToBase(
  entries: Array<{ qty: number; uom: UomSpec }>,
  baseUom: UomSpec,
  factors: ConversionFactor[],
): Quantity {
  return entries.reduce(
    (acc, e) => acc.add(new Quantity(e.qty, e.uom), factors),
    new Quantity(0, baseUom),
  );
}