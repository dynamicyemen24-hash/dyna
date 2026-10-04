/**
 * Verification suite for the Yemeni dual-zone engine, the progressive
 * commission ladder, the offer engine and stock settlement.
 * These figures drive the ledger, so they are asserted rather than eyeballed.
 */
import {
  crossZoneRate, parityGap, computeFxDifferential, netSettlement,
  computeCommission, computeBonus,
} from '../src/erp/yemen';
import { evaluateOffers, reconcileStock, type OfferRule } from '../src/erp/settlement';

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

// Seed values mirroring scripts/yemen-seed.ts.
const cbyYer = { issuer: 'CBY', code: 'YER', symbol: 'ر.ي', decimals: 0, usdRate: 250, parityPct: 0 };
const cbaYer = { issuer: 'CBA', code: 'YER', symbol: 'ر.ي(ع)', decimals: 0, usdRate: 247.5, parityPct: -1.2 };
const cbySar = { issuer: 'CBY', code: 'SAR', symbol: 'ر.س', decimals: 2, usdRate: 3.75, parityPct: 0 };

console.log('\n[cross-zone rate — a quotient, never a product]');
// One northern rial buys 250 / 247.5 = 1.0101 southern rials.
check('CBY YER -> CBA YER', Number(crossZoneRate(cbyYer, cbaYer).toFixed(6)), 1.010101);
check('CBA YER -> CBY YER (inverse)', Number(crossZoneRate(cbaYer, cbyYer).toFixed(6)), 0.99);
check('identity rate', crossZoneRate(cbyYer, cbyYer), 1);
check('CBY YER -> SAR', Number(crossZoneRate(cbyYer, cbySar).toFixed(4)), 66.6667);

// Multiplying the legs yields ~61,875 — absurd, yet it still "runs" silently.
check('multiplying instead would give', (cbyYer.usdRate * cbaYer.usdRate).toFixed(0), '61875');
check('parity gap north vs south', parityGap(cbyYer, cbaYer), 1);

console.log('\n[fx differential — a real gain or loss]');
// Rates are "currency units per reporting unit": 250 YER buys $1. So the
// reporting value of an amount is amount / rate — that inversion is itself a
// common source of error, so the test pins it explicitly.
// Booked 250,000 northern YER at 250 => $1,000. Settled in southern YER where
// the rate is 247.5 => $1,010.10, a genuine FX gain.
const gainYer = computeFxDifferential({
  bookingAmount: 250000, settlementAmount: 250000,
  bookingRate: 250, settlementRate: 247.5,
});
check('differential amount', gainYer.amount, 10.1);
check('differential direction', gainYer.direction, 'gain');
check('rate drift pct', gainYer.percentageDrift, -1);

// A move the other way must register as a loss.
const lossYer = computeFxDifferential({
  bookingAmount: 250000, settlementAmount: 250000,
  bookingRate: 247.5, settlementRate: 250,
});
check('adverse move is a loss', lossYer.direction, 'loss');
check('loss amount', lossYer.amount, -10.1);

// An explicit booking value must be honoured verbatim. 100 units settled at a
// rate of 4 is worth 25, against a booked value of 50 — a 25 loss.
check('explicit booking value honoured', computeFxDifferential({
  bookingAmount: 100, settlementAmount: 100,
  bookingRate: 2, settlementRate: 4, bookingValue: 50,
}).amount, -25);

// An unchanged rate produces exactly zero — no phantom P&L.
check('no movement, no differential', computeFxDifferential({
  bookingAmount: 1000, settlementAmount: 1000,
  bookingRate: 250, settlementRate: 250,
}).amount, 0);

console.log('\n[bank spread]');
// 250,000 units at a 1.0101 cross rate = 252,525 gross; 150bps leaves
// 251,737.37 after the bank's cut.
const net = netSettlement(250000, 1.010101, 150);
check('gross', net.gross, 252525.25);
check('spread', net.spread, 3787.88);
check('net = gross - spread', Number((net.gross - net.spread).toFixed(2)), net.net);

console.log('\n[commission — progressive, not flat]');
const tiers = [
  { from: 0, to: 50000, ratePct: 2.0 },
  { from: 50000, to: 150000, ratePct: 3.5 },
  { from: 150000, to: 300000, ratePct: 5.0 },
  { from: 300000, to: null, ratePct: 6.5 },
];

// 200,000 => 50k@2% + 100k@3.5% + 50k@5% = 1000 + 3500 + 2500 = 7000.
check('200,000 commission', computeCommission(200000, tiers).amount, 7000);
check('200,000 band count', computeCommission(200000, tiers).breakdown.length, 3);
check('30,000 commission', computeCommission(30000, tiers).amount, 600);
// 400,000 => 50k@2% + 100k@3.5% + 150k@5% + 100k@6.5%
//            = 1000 + 3500 + 7500 + 6500 = 18500.
check('400,000 commission spans all four bands', computeCommission(400000, tiers).amount, 18500);
check('400,000 band count', computeCommission(400000, tiers).breakdown.length, 4);
check('zero base', computeCommission(0, tiers).amount, 0);

// A flat 2% on 200,000 pays 4,000 — the ladder pays 7,000 for the same work.
check('progressive beats flat-at-lowest-rate',
  computeCommission(200000, tiers).amount > 200000 * 0.02, true);

// The blended rate must sit between the lowest and highest band rate.
const eff = computeCommission(200000, tiers).effectiveRatePct;
check('effective rate within band bounds', eff > 2 && eff < 6.5, true);

console.log('\n[bonus — pro-rated above threshold]');
const plan = { metric: 'sales_target' as const, target: 150000, rewardType: 'fixed' as const, rewardValue: 15000 };

check('below target, no threshold -> pro-rated', computeBonus(75000, { ...plan, thresholdPct: 0 }).amount, 7500);
check('half target with a 50% threshold pays half', computeBonus(75000, { ...plan, thresholdPct: 50 }).amount, 7500);
check('below the 50% threshold pays nothing', computeBonus(60000, { ...plan, thresholdPct: 50 }).amount, 0);
check('target met pays full', computeBonus(150000, { ...plan, thresholdPct: 50 }).amount, 15000);
check('double target is capped at the reward', computeBonus(300000, { ...plan, thresholdPct: 50 }).amount, 15000);
// Between the threshold and the target the payout scales linearly: at 50% of
// a 100% threshold with a 100,000 target, 50,000 achieved is the midpoint.
check('midpoint scales linearly', computeBonus(50000, {
  metric: 'sales_target' as const, target: 100000,
  rewardType: 'fixed' as const, rewardValue: 20000, thresholdPct: 0,
}).amount, 10000);

check('per-unit bonus', computeBonus(12, {
  metric: 'new_customers' as const, target: 10,
  rewardType: 'per_unit' as const, rewardValue: 2000, thresholdPct: 80,
}).amount, 24000);

// 12 achieved against a target of 10 is 120% attainment, not 12000%.
check('attainment pct', computeBonus(12000, {
  metric: 'new_customers' as const, target: 10000,
  rewardType: 'per_unit' as const, rewardValue: 2000,
}).attainmentPct, 120);

check('percent of achieved', computeBonus(200000, {
  metric: 'margin' as const, target: 200000,
  rewardType: 'percent' as const, rewardValue: 2,
}).amount, 4000);

console.log('\n[offers — real mechanics]');
const offers: OfferRule[] = [
  { code: 'TIER', name: 'tier', ruleType: 'threshold_tier', operandA: 100000, operandB: 15, minQty: 0, minAmount: 100000, maxDiscount: 20000, appliesTo: 'order', appliesValue: null, stackable: false, priority: 5 },
  { code: 'WEEK10', name: 'week10', ruleType: 'percent_off', operandA: 10, operandB: 0, minQty: 0, minAmount: 20000, maxDiscount: 5000, appliesTo: 'order', appliesValue: null, stackable: false, priority: 10 },
  { code: 'B3G2', name: 'b3g2', ruleType: 'buy_x_get_y', operandA: 3, operandB: 2, minQty: 0, minAmount: 0, maxDiscount: null, appliesTo: 'line', appliesValue: null, stackable: false, priority: 20 },
];

const smallBasket = evaluateOffers([{ productId: 'p1', name: 'A', qty: 1, unitPrice: 15000 }], 15000, offers);
check('no offer on a small basket', smallBasket.totalDiscount, 0);
check('non-qualifying offers are explained', smallBasket.rejected.length > 0, true);

const bigBasket = evaluateOffers([{ productId: 'p1', name: 'A', qty: 1, unitPrice: 150000 }], 150000, offers);
// TIER applies (15% = 22,500) but is capped at 20,000; WEEK10 is then refused
// because a non-stackable offer has already run.
check('tier offer capped at its ceiling', bigBasket.applied[0].discount, 20000);
check('non-stackable refuses the second offer', bigBasket.applied.length, 1);
check('effective discount pct', bigBasket.effectiveDiscountPct, 13.33);

// Buy 3 get 2 free: 5 units at 10,000 yields floor(5/3) = 1 complete group,
// so 2 free units = 20,000 off. The remaining 2 units are still paid for.
check('buy 3 get 2 on five units', evaluateOffers(
  [{ productId: 'p9', name: 'X', qty: 5, unitPrice: 10000 }], 50000,
  [{ ...offers[2], priority: 1 }],
).totalDiscount, 20000);

// Only 4 units is still exactly one complete group of 3, so the same payout.
check('four units is still one complete group', evaluateOffers(
  [{ productId: 'p9', name: 'X', qty: 4, unitPrice: 10000 }], 40000,
  [{ ...offers[2], priority: 1 }],
).totalDiscount, 20000);

// Two units is not a complete group at all.
check('two units earns nothing', evaluateOffers(
  [{ productId: 'p9', name: 'X', qty: 2, unitPrice: 10000 }], 20000,
  [{ ...offers[2], priority: 1 }],
).totalDiscount, 0);

// Six units make two complete groups, so the reward doubles.
check('six units doubles the reward', evaluateOffers(
  [{ productId: 'p9', name: 'X', qty: 6, unitPrice: 10000 }], 60000,
  [{ ...offers[2], priority: 1 }],
).totalDiscount, 40000);

// A bundle must never cost more than the items it replaces.
check('bundle dearer than contents is refused', evaluateOffers(
  [{ productId: 'p1', name: 'A', qty: 1, unitPrice: 5000, category: 'عطور' }], 5000,
  [{ code: 'B', name: 'bundle', ruleType: 'bundle_price', operandA: 8000, operandB: 0, minQty: 0, minAmount: 0, maxDiscount: null, appliesTo: 'category', appliesValue: 'عطور', stackable: false, priority: 1 }],
).totalDiscount, 0);

// A discount can never exceed the basket itself.
check('discount never exceeds the basket', evaluateOffers(
  [{ productId: 'p1', name: 'A', qty: 1, unitPrice: 100 }], 100,
  [{ code: 'X', name: 'x', ruleType: 'percent_off', operandA: 500, operandB: 0, minQty: 0, minAmount: 0, maxDiscount: null, appliesTo: 'order', appliesValue: null, stackable: false, priority: 1 }],
).totalDiscount, 100);

console.log('\n[stock settlement — shrinkage costed]');
const count = reconcileStock([
  { productId: 'p1', systemQty: 100, countedQty: 92, unitCost: 250 },  // -8 @250 = -2000
  { productId: 'p2', systemQty: 50, countedQty: 51, unitCost: 100 },   // +1 @100 = +100
  { productId: 'p3', systemQty: 20, countedQty: 20, unitCost: 500 },   // exact
]);
check('shrink qty', count.shrinkQty, 8);
check('surplus qty', count.surplusQty, 1);
check('shrink value', count.shrinkValue, 2000);
check('surplus value', count.surplusValue, 100);
check('net variance', count.netVarianceValue, -1900);
check('matched line reason', count.lines[2].reason, 'مطابق');

// A 0.4% difference is counting noise and must NOT be booked as a loss.
const noise = reconcileStock([{ productId: 'p1', systemQty: 1000, countedQty: 996, unitCost: 100 }]);
check('within-tolerance variance is not charged', noise.shrinkValue, 0);
check('within-tolerance still reports the qty', noise.shrinkQty, 4);
check('within-tolerance reason', noise.lines[0].reason, 'نقص ضمن حد التسامح');

// A 2% difference is a genuine loss and must be charged. Shrinkage is measured
// against the counted value (980 x 100 = 98,000), so 2,000 / 98,000 = 2.041%.
const realLoss = reconcileStock([{ productId: 'p1', systemQty: 1000, countedQty: 980, unitCost: 100 }]);
check('real shrinkage is charged', realLoss.shrinkValue, 2000);
check('shrinkage pct is measured against counted value', realLoss.shrinkagePct, 2.041);

console.log(`\nRESULT: ${pass} passed, ${fail} failed`);
if (fail > 0) process.exit(1);