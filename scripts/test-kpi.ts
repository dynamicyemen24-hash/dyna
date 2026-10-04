/**
 * Verification suite for the KPI classification logic.
 *
 * The dangerous failure here is not a wrong number — it is a metric that reads
 * "fine" while deteriorating, or that reports a confident zero when no data
 * exists. Both are asserted explicitly below.
 */
import {
  classify, evaluate, narrate, groupByCategory,
  KPI_CATALOGUE, type KpiDefinition,
} from '../src/erp/kpi';

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

const def = (over: Partial<KpiDefinition> = {}): KpiDefinition => ({
  code: 'x', name: 'X', nameEn: 'X', category: 'sales',
  polarity: 'higher', unit: 'percent', formula: 'f',
  benchmark: 100, warn: 80, critical: 50, action: 'ACT', sortOrder: 1,
  ...over,
});

/** Classification takes a sample size; pass a non-zero one to isolate thresholds. */
const st = (d: KpiDefinition, v: number | null) => classify(d, v, 1).status;

console.log('\n[polarity: higher is better]');
const up = def({ polarity: 'higher', benchmark: 100, warn: 80, critical: 50 });
check('above benchmark is ok', st(up, 120), 'ok');
check('at the benchmark is ok', st(up, 100), 'ok');
check('at the warn line is warn', st(up, 80), 'warn');
check('between warn and critical is warn', st(up, 65), 'warn');
check('at the critical line is critical', st(up, 50), 'critical');
check('below critical is critical', st(up, 20), 'critical');

console.log('\n[polarity: lower is better]');
const down = def({ polarity: 'lower', benchmark: 45, warn: 75, critical: 120 });
check('below benchmark is ok', st(down, 30), 'ok');
check('at the benchmark is ok', st(down, 45), 'ok');
check('just above the benchmark is still ok', st(down, 60), 'ok');
check('at the warn line is warn', st(down, 75), 'warn');
check('past critical is critical', st(down, 200), 'critical');

console.log('\n[the trap: between warn and critical is NOT "close to target"]');
// A naive implementation compares |value - benchmark| and would call 90 "fine"
// for a metric whose warn line is 75. On a lower-is-better metric that is
// already a third of the way to its critical threshold.
check('90 days inventory is warned, not excused', st(down, 90), 'warn');
check('119 days is still warn', st(down, 119), 'warn');
check('120 days crosses to critical', st(down, 120), 'critical');

console.log('\n[polarity: target band]');
const band = def({ polarity: 'target', benchmark: 30, warn: 40, critical: 60 });
check('inside the band is ok', st(band, 30), 'ok');
check('near the band edge is ok', st(band, 38), 'ok');
check('at the warn deviation is warn', st(band, 40), 'warn');
check('at the critical deviation is critical', st(band, 60), 'critical');
// A target metric is two-sided: falling below the band matters too.
check('below the band is also judged', st(band, 0), 'critical');

console.log('\n[zero is not the same as no data]');
// The most expensive kind of dashboard lie: a metric computed from no rows
// rendered as a confident 0%, which reads as the best possible result.
check('null value is insufficient, not zero', classify(up, null, 0).status, 'insufficient_data');
check('zero sample size is insufficient', classify(up, 500, 0).status, 'insufficient_data');
check('NaN is insufficient', classify(up, Number.NaN, 5).status, 'insufficient_data');
check('Infinity is insufficient', classify(up, Infinity, 5).status, 'insufficient_data');
check('a real zero with data is judged normally', classify(up, 0, 10).status, 'critical');

console.log('\n[no benchmark means reported but never judged]');
const noBench = def({ benchmark: null, warn: null, critical: null });
check('unbenchmarked is ok regardless of value', st(noBench, 999), 'ok');
check('unbenchmarked but no data is still insufficient',
  classify(noBench, 999, 0).status, 'insufficient_data');

console.log('\n[narrative tells the operator what to do]');
check('ok narrative cites the benchmark', narrate(up, 120, 'ok').includes('100'), true);
check('breach narrative includes the action', narrate(up, 20, 'critical').includes('ACT'), true);
check('no-data narrative refuses to imply zero',
  narrate(up, null, 'insufficient_data').includes('لا توجد بيانات'), true);

console.log('\n[catalogue integrity]');
const codes = KPI_CATALOGUE.map((k) => k.code);
check('no duplicate codes', new Set(codes).size, codes.length);
check('every metric has an action', KPI_CATALOGUE.filter((k) => !k.action).length, 0);
check('every metric has a formula', KPI_CATALOGUE.filter((k) => !k.formula).length, 0);
check('every metric has an Arabic name', KPI_CATALOGUE.filter((k) => !k.name).length, 0);

// A benchmark without warn/critical thresholds would silently never alert.
check('no metric has a benchmark without thresholds',
  KPI_CATALOGUE.filter((k) => k.benchmark !== null && (k.warn === null || k.critical === null)).length, 0);

// The warn threshold must sit strictly between benchmark and critical,
// otherwise one of the two states is unreachable.
const badOrder = KPI_CATALOGUE.filter((k) => {
  if (k.benchmark === null || k.warn === null || k.critical === null) return false;
  if (k.polarity === 'higher') return !(k.critical < k.warn && k.warn < k.benchmark);
  if (k.polarity === 'lower') return !(k.benchmark < k.warn && k.warn < k.critical);
  return false;
});
check('thresholds are ordered consistently with polarity', badOrder.map((k) => k.code), []);

// Every category must be reachable, otherwise the board silently drops a group.
check('catalogue covers sales and inventory',
  ['sales', 'inventory'].every((c) =>
    KPI_CATALOGUE.some((k) => k.category === c)), true);

console.log('\n[grouping preserves the declared order]');
const vals = [
  evaluate(def({ code: 'a', category: 'inventory', sortOrder: 30 }), 10, 1),
  evaluate(def({ code: 'b', category: 'sales', sortOrder: 10 }), 10, 1),
  evaluate(def({ code: 'c', category: 'inventory', sortOrder: 31 }), 10, 1),
];
const grouped = groupByCategory(vals);
check('sales group comes first', grouped[0].category, 'sales');
check('inventory group is second', grouped[1].category, 'inventory');
check('items sorted inside the group',
  grouped[1].items.map((i) => i.definition.code), ['a', 'c']);

console.log(`\nRESULT: ${pass} passed, ${fail} failed`);
if (fail > 0) process.exit(1);