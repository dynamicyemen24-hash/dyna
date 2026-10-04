/**
 * Verification suite for the enterprise primitives and the discount ladder.
 * These are calculations that must never be wrong, so they are asserted
 * rather than eyeballed.
 */
import { Money, roundMoney, decimalsFor } from '../src/erp/money';
import { Quantity, UnitError } from '../src/erp/quantity';
import { computeVat, computeCartTax, authoriseDiscount, tierFor } from '../src/erp/tax';

let pass = 0;
let fail = 0;

function check(name: string, actual: unknown, expected: unknown) {
  const ok = JSON.stringify(actual) === JSON.stringify(expected);
  if (ok) { pass++; console.log(`PASS  ${name}`); }
  else {
    fail++;
    console.log(`FAIL  ${name}`);
    console.log(`        expected ${JSON.stringify(expected)}`);
    console.log(`        actual   ${JSON.stringify(actual)}`);
  }
}

console.log('\n[currency rounding — ISO 4217 minor units]');
check('SAR to 2dp', roundMoney(10.005, 'SAR'), 10.01);
check('SAR 2dp carry', roundMoney(2.675, 'SAR'), 2.68);
check('JPY has 0 minor units', roundMoney(1234.56, 'JPY'), 1235);
check('KWD has 3 minor units', roundMoney(1.23456, 'KWD'), 1.235);
check('decimalsFor JPY', decimalsFor('JPY'), 0);
check('decimalsFor KWD', decimalsFor('KWD'), 3);

console.log('\n[money — three-currency model]');
const usd = new Money(100, 'USD', { rate: 3.75 });
check('transaction amount kept', usd.amount, 100);
check('base amount converted', usd.baseAmount, 375);
check('rate captured', usd.rate, 3.75);

const sar = new Money(1000, 'SAR');
check('base currency identity rate', sar.rate, 1);

const back = usd.convert('SAR', 3.75);
check('USD -> SAR', back.amount, 375);
check('round-trip SAR -> USD', back.convert('USD', 3.75).amount, 100);

// Mixing currencies in an addition must fail loudly rather than coerce silently.
let threw = false;
try { usd.add(sar); } catch { threw = true; }
check('add() rejects mixed currencies', threw, true);

console.log('\n[money — pivot through the base currency]');
// 100 USD -> 375 SAR -> EUR at 4.05/SAR = 92.5926, which EUR stores as 92.59
// because the euro has two minor units. Dividing the rates is correct;
// multiplying them is the classic double-conversion defect.
const eur = back.convert('EUR', 4.05);
check('USD -> SAR -> EUR (2dp)', eur.amount, 92.59);

console.log('\n[quantity — explicit conversion factors]');
const factors = [
  { fromUnitId: 'BOX', toUnitId: 'EA', numerator: 24, denominator: 1 },
  { fromUnitId: 'EA', toUnitId: 'BOX', numerator: 1, denominator: 24 },
  { fromUnitId: 'KG', toUnitId: 'GRM', numerator: 1000, denominator: 1 },
];
const BOX_UOM = { id: 'BOX', code: 'BOX', name: 'كرتون', dimension: 'COUNT', precision: 0, isBase: false };
const EA_UOM = { id: 'EA', code: 'EA', name: 'قطعة', dimension: 'COUNT', precision: 0, isBase: true };
const KG_UOM = { id: 'KG', code: 'KG', name: 'كيلوجرام', dimension: 'WEIGHT', precision: 3, isBase: true };
const GRM_UOM = { id: 'GRM', code: 'GRM', name: 'جرام', dimension: 'WEIGHT', precision: 1, isBase: false };

check('5 BOX -> EA', new Quantity(5, BOX_UOM).convertTo(EA_UOM, factors).value, 120);
check('120 EA -> BOX', new Quantity(120, EA_UOM).convertTo(BOX_UOM, factors).value, 5);
check('2 KG -> GRM', new Quantity(2, KG_UOM).convertTo(GRM_UOM, factors).value, 2000);

// Mixed dimensions are always a configuration error, never a valid operation.
let dimThrew = false;
try { new Quantity(2, KG_UOM).convertTo(EA_UOM, factors); } catch (e) { dimThrew = e instanceof UnitError; }
check('cross-dimension refused', dimThrew, true);

// Adding quantities in different units of the SAME dimension normalises the
// incoming quantity first: 5 BOX + 72 EA = 5 BOX + 3 BOX = 8 BOX.
check(
  'add across units normalises',
  new Quantity(5, BOX_UOM).add(new Quantity(72, EA_UOM), factors).value,
  8,
);

// An undefined factor must not silently degrade to 1.
let noFactor = false;
try { new Quantity(5, BOX_UOM).convertTo(GRM_UOM, factors); } catch (e) { noFactor = e instanceof UnitError; }
check('missing factor refused', noFactor, true);

console.log('\n[tax — inclusive vs exclusive]');
// 115 SAR inclusive of 15% VAT => net 100, tax 15. Solved algebraically.
const incl = computeVat(115, 15, 'inclusive', 'SAR');
check('inclusive net', incl.net, 100);
check('inclusive tax', incl.tax, 15);
check('inclusive gross', incl.gross, 115);

const excl = computeVat(100, 15, 'exclusive', 'SAR');
check('exclusive net', excl.net, 100);
check('exclusive tax', excl.tax, 15);
check('exclusive gross', excl.gross, 115);
check('zero-rated tax', computeVat(100, 0, 'exclusive', 'SAR').tax, 0);

console.log('\n[tax — rounding happens per line]');
// Retail rules round each line then sum. Rounding the total instead drifts by
// cents: three 0.05 lines at 15% give 0.01 of tax each = 0.03, whereas
// taxing the 0.15 total once would give only 0.02.
const drift = computeCartTax(
  [
    { amount: 0.05, ratePercent: 15, quantity: 1 },
    { amount: 0.05, ratePercent: 15, quantity: 1 },
    { amount: 0.05, ratePercent: 15, quantity: 1 },
  ],
  'exclusive',
  'SAR',
);
check('per-line rounding avoids the cent drift', drift.tax, 0.03);
check('total-based rounding would have given', Math.round(0.15 * 0.15 * 100) / 100, 0.02);

// A normal basket: each line rounds cleanly and the footer matches the sum.
const cart = computeCartTax(
  [
    { amount: 33.33, ratePercent: 15, quantity: 1 },
    { amount: 33.33, ratePercent: 15, quantity: 1 },
    { amount: 33.34, ratePercent: 15, quantity: 1 },
  ],
  'exclusive',
  'SAR',
);
check('cart tax sums per line', cart.tax, 15);
check('cart net', cart.net, 100);
check('cart gross = net + tax', cart.gross, 115);

console.log('\n[discount authority ladder]');
check('5% -> cashier', tierFor(5)?.approver, 'الكاشير');
check('15% -> sales manager', tierFor(15)?.approver, 'مدير المبيعات');
check('30% -> general manager', tierFor(30)?.approver, 'المدير العام');
check('40% -> no tier', tierFor(40), null);

const cashier = new Set(['sales.discount']);
check('cashier may apply 5%', authoriseDiscount(5, (p) => cashier.has(p)).allowed, true);
check('cashier blocked at 15%', authoriseDiscount(15, (p) => cashier.has(p)).allowed, false);
check('cashier blocked at 40%', authoriseDiscount(40, (p) => cashier.has(p)).allowed, false);

const gm = new Set(['sales.discount', 'sales.discount.approve', 'sales.discount.override']);
check('GM may apply 30%', authoriseDiscount(30, (p) => gm.has(p)).allowed, true);
check('GM still blocked at 45%', authoriseDiscount(45, (p) => gm.has(p)).allowed, false);

console.log(`\nRESULT: ${pass} passed, ${fail} failed`);
if (fail > 0) process.exit(1);