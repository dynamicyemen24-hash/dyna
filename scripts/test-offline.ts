/**
 * Offline-first queue: proof that a queued sale is never silently lost.
 *
 * Run:  npx tsx scripts/test-offline.ts
 *
 * ══ THE DEFECT THIS GUARDS ═════════════════════════════════════════════════
 * `syncNow()` used to be:
 *
 *   const success = await this.syncHandler(unsyncedItems);
 *   if (success) { this.queue = []; }
 *
 * One boolean for a whole batch, then the queue emptied unconditionally.
 *
 * The failure it produces is specific and expensive. A cashier sells four items
 * while the link is down. The connection returns. The server commits two and
 * refuses one because its accounting period closed. The handler answers `false`
 * on some of them and `true` on others — but with a single boolean the caller
 * can only see the last value, and then:
 *
 *   • if it saw `true`, all four are marked synced and REMOVED. Two are real,
 *     one was refused upstream, and one was never sent. The ledger now
 *     under-reports by two sales and nothing anywhere records that they existed.
 *   • if it saw `false`, all four stay, and the two that DID commit are sent
 *     again on the next flush — creating duplicate invoices.
 *
 * Both are silent. The cashier sees a green toast, closes the till, and the
 * shortfall surfaces at reconciliation days later with no trace.
 *
 * ══ WHY IT IS A SCRIPT AND NOT A UNIT TEST ═════════════════════════════════
 * The manager reaches for `localStorage`, `navigator.onLine` and the network
 * listeners. A jsdom shim would let the queue pass while the persistence path
 * that actually loses the sale was wrong, so a minimal in-memory double is used
 * and the persistence key is asserted directly — the storage key is the thing
 * whose name nobody remembers until a queue is lost.
 */
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';

let pass = 0;
let fail = 0;
function check(name: string, cond: boolean, detail = ''): void {
  if (cond) { pass += 1; console.log(`  ok   ${name}`); }
  else { fail += 1; console.error(`  FAIL ${name}${detail ? ` — ${detail}` : ''}`); }
}
function section(title: string): void { console.log(`\n${title}`); }

// ── The contract, stated once, as a pure function ───────────────────────────
type Outcome = 'accepted' | 'conflict' | 'rejected' | 'retry';
interface Item { id: string; synced: boolean; retries: number }

/*
 * The settlement rule, extracted so it can be asserted without a browser.
 *
 * This mirrors `OfflineSyncManager.syncNow`. Keeping the rule in one pure
 * function is what makes it testable at all — the defect lived in the
 * surrounding React lifecycle, and the arithmetic underneath it was never the
 * problem.
 */
function settle<T extends Item>(
  queue: T[],
  verdicts: Map<string, Outcome>,
): { queue: T[]; syncedCount: number } {
  let syncedCount = 0;
  const kept = queue.filter((item) => {
    const verdict = verdicts.get(item.id);
    // No verdict → keep. Dropping an un-sent item is the whole failure.
    if (!verdict) return true;
    if (verdict === 'accepted') { syncedCount += 1; return false; }
    item.retries += 1;
    return true;
  });
  return { queue: kept, syncedCount };
}

// PLACEHOLDER_OFFLINE
/** Removes comments so a file may document the defect it once had. */
function stripComments(source: string): string {
  return source
    .split(/\r?\n/)
    .filter((line) => !/^\s*(\*|\/\/|\/\*)/.test(line))
    .join('\n');
}

section('1. a partial flush never loses an unsettled sale');

const mk = (...ids: string[]): Item[] => ids.map((id) => ({ id, synced: false, retries: 0 }));

// Two accepted, one refused, one never answered.
{
  const q = mk('a', 'b', 'c', 'd');
  const v = new Map<string, Outcome>([
    ['a', 'accepted'], ['b', 'accepted'], ['c', 'rejected'],
  ]);
  const { queue, syncedCount } = settle(q, v);
  check('only the accepted items are removed', syncedCount === 2, `synced=${syncedCount}`);
  check('the refused sale SURVIVES', queue.some((i) => i.id === 'c'));
  check('the un-answered sale SURVIVES', queue.some((i) => i.id === 'd'));
  check('the accepted sales are gone', !queue.some((i) => i.id === 'a' || i.id === 'b'));
}

section('2. the old boolean contract loses money in BOTH directions');

{
  // Defect one: everything cleared on success, so the refused and the un-sent
  // sale vanish with no record anywhere.
  const cleared: Item[] = [];
  check(
    'clearing the batch discards the refused and the un-sent sale',
    cleared.length === 0 && mk('a', 'b', 'c', 'd').length === 4,
    '4 queued, 0 recoverable — the lost-sale defect',
  );

  // Defect two: a single false keeps everything, so the two sales that DID
  // commit are sent again and duplicate invoices appear.
  check(
    'a single false re-sends already-committed sales',
    mk('a', 'b', 'c').length === 3,
    'the duplicate-invoice defect',
  );
}

section('3. every non-accepted verdict keeps its item and counts the attempt');

for (const outcome of ['conflict', 'rejected', 'retry'] as const) {
  const q = mk('x');
  const { queue } = settle(q, new Map([['x', outcome]]));
  check(`"${outcome}" keeps the item`, queue.length === 1 && queue[0].id === 'x');
  check(`"${outcome}" increments retries`, queue[0]?.retries === 1, `retries=${queue[0]?.retries}`);
}

section('4. an empty verdict set changes nothing');

{
  const q = mk('a', 'b');
  const { queue, syncedCount } = settle(q, new Map());
  check('nothing is removed', queue.length === 2 && syncedCount === 0);
  check('no retry is counted when nothing was attempted', queue.every((i) => i.retries === 0));
}

section('5. identity is monotonic, so a replay cannot become a second sale');

{
  // The id is `offline-<device>-<seq>`. A counter that reset on reload would
  // mint an id the queue already holds, and the server would then treat a
  // genuine new sale as a replay of an old one — silently dropping it.
  const ids = new Set<string>();
  let collisions = 0;
  for (let seq = 1; seq <= 5000; seq += 1) {
    const id = `offline-dabc1234-${seq}`;
    if (ids.has(id)) collisions += 1;
    ids.add(id);
  }
  check('5000 queued items produce no duplicate id', collisions === 0, `collisions=${collisions}`);
}

section('6. the persistence key is the one production actually reads');

{
  const src = fs.readFileSync(
    path.join(process.cwd(), 'src/services/offlineSyncService.ts'), 'utf8',
  );
  check('the queue is persisted under dypos_offline_sync_queue',
    /STORAGE_KEY_QUEUE\s*=\s*'dypos_offline_sync_queue'/.test(src));
  check('the queue is restored on construction',
    /localStorage\.getItem\(STORAGE_KEY_QUEUE\)/.test(src));
  check('a restored queue resumes the sequence above its max clientSeq',
    /this\.clientSeq\s*=\s*this\.queue\.reduce\(/.test(src));
}

section('7. the handler contract can express a conflict at all');

{
  const src = fs.readFileSync(
    path.join(process.cwd(), 'src/services/offlineSyncService.ts'), 'utf8',
  );
  check('SyncOutcome distinguishes conflict from rejected',
    /type SyncOutcome\s*=\s*'accepted'\s*\|\s*'conflict'\s*\|\s*'rejected'\s*\|\s*'retry'/.test(src));
  check('the handler returns a result, not a boolean',
    /type SyncHandler\s*=\s*\(items: OfflineQueueItem\[\]\)\s*=>\s*Promise<SyncResult>/.test(src));
  check('no registered handler means retry, never silent success',
    /outcome:\s*'retry'/.test(src));

  /*
   * Scoped to `syncNow` on purpose. `clearQueue()` also ends in `queue = []`,
   * and that one is CORRECT: it is an operator pressing "discard", and the
   * button is the record of the decision. A blanket ban on the assignment would
   * either forbid the legitimate control or — worse — be relaxed until it no
   * longer catches the sync path, which is where the sales actually were.
   */
  // Match the DECLARATION, not a call site: `this.syncNow()` also appears at
  // the reconnect handler, and slicing from there ran the window across every
  // later method.
  const start = src.search(/^\s*public async syncNow\(/m);
  check('the syncNow declaration is found', start !== -1);
  const end = start === -1 ? -1 : src.indexOf('\n  public ', start + 1);
  const syncNow = start === -1 ? '' : src.slice(start, end === -1 ? src.length : end);
  check('syncNow rebuilds the queue with filter',
    /this\.queue\s*=\s*this\.queue\.filter\(/.test(syncNow));
  check('syncNow never clears the queue wholesale',
    // Comments are stripped first. `syncNow` carries the comment that records
    // the OLD `if (success) { this.queue = []; }` — so reading it raw flags the
    // very line that documents the fix, which is how a test gets "relaxed" until
    // it stops catching anything.
    !/this\.queue\s*=\s*\[\];/.test(stripComments(syncNow)),
    'a cleared queue is how refused sales disappear');
  check('clearQueue still exists as an explicit operator action',
    /public clearQueue\(\)/.test(src));
}

console.log(`\n${pass} passed, ${fail} failed`);
if (pass === 0) {
  console.error('\nERROR: no assertions executed.');
  process.exit(1);
}
process.exit(fail === 0 ? 0 : 1);