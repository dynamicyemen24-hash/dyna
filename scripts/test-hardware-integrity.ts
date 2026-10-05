/**
 * Hardware integrity — proof that no peripheral is simulated.
 *
 * Run:  npx tsx scripts/test-hardware-integrity.ts
 *
 * ══ THE DEFECT THIS GUARDS ════════════════════════════════════════════════
 * The POS displayed a live weight of 1.45 kg on page load, before anything had
 * been placed on a scale. It came from two cooperating fictions:
 *
 *   - `deviceGateway`'s constructor ran `setInterval` + `Math.random()` and
 *     started at 1.45, so a "live" number drifted on screen forever;
 *   - `scaleProtocolHAL`'s constructor called `startSimulation()`, defaulted its
 *     status to `'simulated'`, and — the part that made it indefensible —
 *     **restored the simulation on a failed connection**:
 *     `catch { this.startSimulation(); }`.
 *
 * `openCashDrawer()` and `printReceiptEscPos()` were `console.log(...)` followed
 * by `return true`, so a button reported success for hardware that did not exist.
 *
 * The consequence was arithmetic on invented digits. `ThirdPartySaleView`
 * computed what a **named farmer is owed**:
 *
 *     const netSeller = netKg * unitPrice * (1 - commissionRate / 100);
 *
 * from a reading produced by a random number generator. §7 of the constitution
 * says a figure the system cannot read is never displayed as a number; this broke
 * it in the only place where the number decides money.
 *
 * ══ WHY A SCAN AND NOT A RUNTIME TEST ══════════════════════════════════════
 * The old code was not merely inaccurate — it was *type-correct and passing*
 * while lying. `return true` satisfies `boolean`; `1.45` satisfies `number`. A
 * unit test can only assert what the author already believes. So this asserts
 * the properties directly on the source:
 *
 *   1. no `Math.random` reaches a published weight;
 *   2. no simulation timer exists;
 *   3. a failed connection cannot restore fabricated data;
 *   4. the reading type cannot hold a fabricated number — its fields are
 *      `number | null`, which is the change that makes the lie unrepresentable;
 *   5. a hardware action reports a verdict instead of a bare `true`.
 *
 * Point 4 is the one that matters. The others are symptoms; that one is the
 * fix, and it is the reason a re-introduced seed literal would not compile.
 */
import fs from 'node:fs';

let pass = 0;
let fail = 0;

function check(name: string, cond: boolean, detail = ''): void {
  if (cond) { pass += 1; console.log(`  ok   ${name}`); }
  else { fail += 1; console.error(`  FAIL ${name}${detail ? ` — ${detail}` : ''}`); }
}

const read = (rel: string): string => fs.readFileSync(rel, 'utf8');

/**
 * Strips comments, keeping only lines that are actually code.
 *
 * Every banned construct below is quoted in the comment explaining why it was
 * removed, and that comment is the most valuable line in the file. A scan that
 * failed on its own rationale would be deleted within a week.
 */
function codeOnly(source: string): string {
  return source
    .replace(/\/\*[\s\S]*?\*\//g, '')
    .split('\n')
    .map((line) => line.replace(/(^|[^:])\/\/.*$/, '$1'))
    .join('\n');
}

const deviceGateway = read('src/services/deviceGateway.ts');
const scaleHal = read('src/services/scaleProtocolHAL.ts');
const posView = read('src/components/POSView.tsx');
const consignment = read('src/components/ThirdPartySaleView.tsx');
const widget = read('src/components/ScaleHALWidget.tsx');

const gwCode = codeOnly(deviceGateway);
const halCode = codeOnly(scaleHal);
const posCode = codeOnly(posView);
const consCode = codeOnly(consignment);
const widgetCode = codeOnly(widget);

console.log('\n1. no weight is ever invented');
check(
  'the device facade contains no random number generator',
  !gwCode.includes('Math.random'),
  'a published weight derived from Math.random is a fabricated measurement',
);
check(
  'the device facade starts no timer',
  !gwCode.includes('setInterval') && !gwCode.includes('setTimeout'),
  'a repeating timer is how a fabricated reading kept looking live',
);
check(
  'the scale HAL contains no random number generator',
  !halCode.includes('Math.random'),
);
check(
  'the scale HAL starts no timer',
  !halCode.includes('setInterval') && !halCode.includes('setTimeout'),
);
check(
  'there is no simulation routine left to call',
  !halCode.includes('startSimulation') && !halCode.includes('stopSimulation'),
);
check(
  "no code path emits the 'simulated' status",
  !/updateStatus\(\s*'simulated'/.test(halCode),
  "'simulated' is declared in the union but nothing may set it",
);

console.log('\n2. a failed connection fails closed');
const serialSection = halCode.slice(
  halCode.indexOf('connectWebSerial'),
  halCode.indexOf('connectBluetooth'),
);
check(
  'a serial failure does not fabricate a reading',
  !serialSection.includes('Math.random') && !serialSection.includes('reportDeviceWeight'),
);
check(
  'a serial failure clears the facade instead of leaving stale digits',
  serialSection.includes('clearScale'),
);
check(
  'a bluetooth failure clears the facade',
  halCode.slice(halCode.indexOf('connectBluetooth')).includes('clearScale'),
);
check(
  'no connection attempt reports success unconditionally',
  !/connectWebSerial\(\)[^{]*\{[^}]*return true/.test(halCode),
);

console.log('\n3. the reading type cannot hold a fabricated number');
check(
  'the facade reading fields are nullable',
  /weightKg:\s*number\s*\|\s*null/.test(deviceGateway)
    && /netWeightKg:\s*number\s*\|\s*null/.test(deviceGateway),
  'a non-nullable weight field is what let a seed literal compile',
);
check(
  'there is a single canonical "no reading" constant',
  /NO_SCALE_READING/.test(deviceGateway) && /Object\.freeze/.test(deviceGateway),
  'an immutable empty state is what a screen falls back to',
);
check(
  'the empty reading carries nulls, not zeros',
  /NO_SCALE_READING[^=]*=\s*Object\.freeze\(\{[\s\S]*?weightKg:\s*null/.test(deviceGateway),
  'zero is a measurement; null is the absence of one',
);

console.log('\n4. screens seed no weight of their own');
check(
  'the POS does not seed a weight literal',
  !/useState<ScaleReading>\(\{[\s\S]{0,200}?weightKg:\s*[\d.]/.test(posCode),
);
check(
  'the consignment screen does not seed a weight literal',
  !/useState<ScaleReading>\(\{[\s\S]{0,200}?weightKg:\s*[\d.]/.test(consCode),
);
check(
  'the widget starts from the HAL\'s own empty frame',
  /useState<ScaleReading>\(NO_FRAME\)/.test(widgetCode),
  'a hand-written copy of the empty state is how a fabricated seed reappears',
);
check(
  'the POS and consignment screens start from the shared empty reading',
  posCode.includes('useState<ScaleReading>(NO_SCALE_READING)')
    && consCode.includes('useState<ScaleReading>(NO_SCALE_READING)'),
  'one frozen constant, not a literal copied into each screen',
);
check(
  'a rendered weight is guarded on the reading existing',
  posCode.includes('scaleReading.netWeightKg === null')
    && consCode.includes('scaleReading.netWeightKg === null'),
);

console.log('\n5. the consignment settlement cannot be driven by a phantom weight');
check(
  'no seeded broker name',
  !consCode.includes('أبو فهد'),
  'a settlement record naming a person nobody entered is a fabricated creditor',
);
check(
  'the deal terms start empty rather than pre-filled',
  !/useState<number>\(\s*\d/.test(consCode),
  'pre-filled price and commission are terms nobody agreed to',
);
check(
  'a missing weight is refused, not defaulted to zero',
  consCode.includes('if (netKg === null'),
);
check(
  'the lot number is not derived from a random number',
  !/LOT-[^`]*\$\{[^}]*Math\.random/.test(consCode),
  'a random three-digit string is not a document identifier',
);

console.log('\n6. hardware actions report a verdict, not a bare true');
check(
  'the cash drawer returns a discriminated outcome',
  /openCashDrawer\(\)[^:]*:\s*Promise<HardwareOutcome>/.test(deviceGateway),
);
check(
  'the drawer refuses when no port is open',
  /No ESC\/POS port is open/.test(deviceGateway),
);
check(
  'the drawer writes the real ESC/POS pulse',
  deviceGateway.includes('0x1b, 0x70'),
);
check(
  'no hardware method returns an unconditional true',
  !/openCashDrawer\(\)[^}]*\{\s*console\.log[\s\S]{0,200}?return true/.test(deviceGateway),
);
check(
  'no hardware method fakes a print with a log line',
  !gwCode.includes('printReceiptEscPos'),
  'the removed method is named in the rationale comment, which codeOnly strips',
);
check(
  'the POS surfaces the drawer outcome instead of ignoring it',
  posCode.includes('drawerMessage'),
);

console.log(`\n${pass} passed, ${fail} failed`);
if (fail > 0) {
  console.error(
    '\nA peripheral is reporting data or success it did not produce. '
    + 'See docs/DECISION_MAP.md §P7.',
  );
  process.exit(1);
}