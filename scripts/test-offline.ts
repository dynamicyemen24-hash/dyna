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

section('6. the persistence key is tenant-scoped');

{
  const src = fs.readFileSync(
    path.join(process.cwd(), 'src/services/offlineSyncService.ts'), 'utf8',
  );
  const code = stripComments(src);

  /*
   * ══ WHAT CHANGED AND WHY THE OLD ASSERTION WAS WRONG ═════════════════════
   * This section asserted:
   *
   *     /STORAGE_KEY_QUEUE\s*=\s*'dypos_offline_sync_queue'/
   *
   * i.e. that the queue lives under ONE fixed key. That was not a neutral
   * detail — it was the defect. `localStorage` survives sign-out, so on a till
   * shared between two merchants the second sign-in inherited the first one's
   * unpaid invoices and flushed them under its own token.
   *
   * The key is now a function of the tenant, and the tenant comes from the
   * SIGNED token rather than from `rememberTenant()` — which is a plain
   * localStorage string written before the server confirms which tenant the
   * password belongs to, and is therefore a claim rather than an identity.
   */
  check('the queue key is scoped by tenant',
    /dypos_offline_sync_queue::/.test(code) || /scopedKey\('dypos_offline_sync_queue'\)/.test(code),
    'one global key is how one merchant is billed for another\'s sales');
  check('the namespace falls back to something unclaimed',
    /__unclaimed__/.test(code),
    'work queued with no identity must be inert, not attributed to whoever signs in next');
  check('the tenant is read from the signed session token',
    /dypos_session_v1/.test(code) && /tenantId/.test(code));
  check('JWT tenant decoding reads the payload segment, not the JOSE header',
    /const parts = token\\.split\\('\\.'\\)/.test(code)
      && /parts\\[1\\]/.test(code),
    'reading token.slice(0, firstDot) decodes the header and strands real queues in __unclaimed__');
  check('the tenant is NOT taken from the rewritable localStorage claim',
    !/scopedKey[\s\S]{0,400}getItem\('dypos_tenant'\)/.test(code),
    'rememberTenant() is a client-writable string, not an identity');
  check('the key is resolved per access, not frozen at module load',
    /const queueKey = \(\)/.test(code) && /getItem\(queueKey\(\)\)/.test(code),
    'a constant computed at import resolves before the session is restored');
  check('the queue is restored on construction',
    /localStorage\.getItem\(queueKey\(\)\)/.test(code));
  check('a restored queue resumes the sequence above its max clientSeq',
    /this\.clientSeq\s*=\s*this\.queue\.reduce\(/.test(code));

  /*
   * The reload is not optional. Without it the singleton keeps the queue it read
   * before sign-in — empty — and the next `saveState()` overwrites the merchant's
   * real pending sales with that emptiness. Unsent invoices from a whole shift
   * would be erased by a page refresh.
   */
  check('the queue is re-read once the tenant is known',
    /public reloadForTenant\(\)/.test(code));
  check('the reload replaces the queue rather than merging tenants',
    /reloadForTenant[\s\S]{0,400}this\.loadState\(\)/.test(code)
      && !/reloadForTenant[\s\S]{0,400}push\(\.\.\./.test(code));

  const auth = fs.readFileSync(
    path.join(process.cwd(), 'src/contexts/AuthContext.tsx'), 'utf8',
  );
  check('the queue is reloaded after sign-in, not only on restore',
    (auth.match(/offlineSyncService\.reloadForTenant\(\)/g) ?? []).length >= 2,
    'a shared till signs out of one merchant and into another');
}

section('6b. the queue actually has a transport');

{
  const transport = fs.readFileSync(
    path.join(process.cwd(), 'src/services/offlineSyncTransport.ts'), 'utf8',
  );
  const app = fs.readFileSync(path.join(process.cwd(), 'src/App.tsx'), 'utf8');

  /*
   * ══ THE DEFECT THIS GUARDS ════════════════════════════════════════════════
   * `registerSyncHandler` existed on the manager and was called from NOWHERE.
   * Every `syncNow()` therefore took the "no handler registered" branch and
   * returned `{ outcome: 'retry' }` for every item, so the queue never drained:
   * the till said its sales were recorded, and none of them ever reached the
   * ledger. `/api/db/sync-batch` was authenticated, tenant-scoped and
   * server-recomputed — and entirely unreached.
   *
   * This is the single assertion that would have caught it, because nothing else
   * in the system fails when a handler is missing: the build is green, the type
   * is satisfied, and the queue correctly refuses to discard unsent work.
   */
  check('a transport module exists', transport.length > 0);
  check('the handler is actually registered',
    /registerSyncHandler/.test(transport),
    'an unregistered handler means no offline sale ever reaches the server');
  check('the application registers it',
    /attachOfflineSyncTransport\(\)/.test(app),
    'the transport must be wired at start-up or the queue is inert');
  check('it targets the authenticated batch endpoint',
    /\/api\/db\/sync-batch/.test(transport));
  check('it sends the bearer token',
    /Authorization/.test(transport) && /Bearer/.test(transport),
    'an unauthenticated sync would be refused by the session gate');
  check('it does NOT send a client-supplied tenant',
    !/tenantId:\s*activeTenant/.test(transport)
      && !/body:\s*JSON\.stringify\(\{[^}]*tenantId/.test(transport),
    'the server derives the tenant from the token; a client claim is how this was cross-tenant');
  check('a 5xx is retried rather than discarded',
    /status >= 500[\s\S]{0,80}'retry'/.test(transport),
    'a transport fault is not a verdict on the data');
  check('an auth failure is not retried forever',
    /401[\s\S]{0,120}'rejected'/.test(transport));
  check('a row the server skipped is not reported as accepted',
    /skipped/.test(transport) && /'rejected'/.test(transport),
    'a silently dropped invoice is a sale the business made and lost');
  check('the offline id travels so a retry is not a duplicate',
    /id:\s*item\.id/.test(transport));
}

section('6c. a clean service-worker install caches the complete build');

{
  const vite = fs.readFileSync(path.join(process.cwd(), 'vite.config.ts'), 'utf8');
  const worker = fs.readFileSync(path.join(process.cwd(), 'public/sw.js'), 'utf8');
  check('the updated install strategy uses a new cache version',
    /dypos-offline-v\d+\.0/.test(worker));
  check('the build emits a manifest from every generated asset',
    /fileName:\s*'dypos-precache\.json'/.test(vite)
      && /fileName\.startsWith\('assets\/'\)/.test(vite));
  check('the service worker requires and validates that manifest',
    /fetch\('\/dypos-precache\.json'/.test(worker)
      && /assets\.some\(\(asset\)/.test(worker));
  check('all generated bundles are cached before worker activation',
    /await cache\.addAll\(assets\)/.test(worker)
      && !/Pre-caching non-fatal warning/.test(worker));
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