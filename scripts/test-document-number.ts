/**
 * Document number ranges — proof (SAP NCO standard).
 *
 * Run:  npx tsx scripts/test-document-number.ts
 *
 * The property under test is the one the old client-side numbering broke:
 * **two concurrent allocations must never receive the same number.** That is a
 * concurrency property, so a sequential happy-path test would pass against the
 * broken implementation. The test therefore allocates in parallel.
 */
import dotenv from 'dotenv';
import pg from 'pg';
import { allocateDocumentNumber } from '../server/documentNumber.ts';

dotenv.config();

const pool = new pg.Pool({
  connectionString: process.env.DATABASE_URL,
  ssl: { rejectUnauthorized: false },
  /*
   * Wide enough for the concurrency section to actually be concurrent.
   *
   * With `max: 2`, eight simultaneous allocations were queued two-at-a-time by
   * the pool: each connection ran its queries serially, so the test exercised a
   * two-way race and PROVED NOTHING about eight. pg printed the reason while it
   * happened — "Calling client.query() when the client is already executing a
   * query is deprecated" — which is the pool queueing, not a bug in the
   * allocator.
   *
   * A concurrency test that quietly degrades to sequential is the same class of
   * defect as a glob that runs nothing: it passes against broken code. Eight
   * connections means eight real transactions overlapping.
   */
  max: 12,
  idleTimeoutMillis: 10_000,
  connectionTimeoutMillis: 20_000,
});

const TENANT = 'royal-global-hq';

let pass = 0;
let fail = 0;
function check(name: string, ok: boolean, detail = '') {
  if (ok) { pass += 1; console.log(`  ok   ${name}`); }
  else { fail += 1; console.error(`  FAIL ${name}${detail ? ` — ${detail}` : ''}`); }
}

async function main() {
  /*
   * ── Restoring the counters ──────────────────────────────────────────────────
   * These are production rows: the counter decides the next number a real
   * invoice will carry, so a test must not consume numbers.
   *
   * The obvious approach — delete the rows afterwards — is wrong, and the first
   * version of this test did exactly that. It either destroys the existing
   * counter for the tenant (and the next invoice reuses a number) or, for the
   * other doc types, leaves a row the invoice allocator will then advance from
   * an arbitrary point.
   *
   * So the ORIGINAL values are read BEFORE the first allocation and written back
   * after, and the restore is asserted. If the UPDATE matches no row, that is
   * reported as a failure rather than passing silently: a silently-skipped
   * restore means the sequence was left moved.
   */
  const before = await pool.query(
    `SELECT doc_type, period_key, next_value
       FROM dypos.document_sequences WHERE tenant_id = $1`,
    [TENANT],
  );
  const snapshot = before.rows.map((r: { doc_type: string; period_key: string; next_value: string }) => ({
    doc_type: r.doc_type, period_key: r.period_key, next_value: r.next_value,
  }));

  console.log('\n1. sequential allocation is unique and well-formed');
  const first = await allocateDocumentNumber(TENANT, 'invoice');
  const second = await allocateDocumentNumber(TENANT, 'invoice');
  check('a number is issued', /^INV-\d{4}-\d{6}$/.test(first), first);
  check('consecutive allocations differ', first !== second, `${first} vs ${second}`);
  check('the counter advances by one',
    Number(second.split('-')[2]) === Number(first.split('-')[2]) + 1,
    `${first} then ${second}`);

  console.log('\n2. document types have independent ranges');
  const po = await allocateDocumentNumber(TENANT, 'purchase_order');
  check('a purchase order gets its own prefix and counter',
    /^PO-\d{4}-\d{6}$/.test(po) && po.split('-')[2] === '000001', po);

  console.log('\n3. CONCURRENCY — the property the old code violated');
  // Eight allocations fired at once. Without a row lock several of them read the
  // same `next_value` and would receive the same number.
  const concurrent = await Promise.all(
    Array.from({ length: 8 }, () => allocateDocumentNumber(TENANT, 'work_order')),
  );
  const unique = new Set(concurrent);
  check('8 parallel allocations produced 8 distinct numbers',
    unique.size === 8, `${unique.size} unique: ${concurrent.join(' ')}`);
  check('all are well-formed', concurrent.every((n) => /^WO-\d{4}-\d{6}$/.test(n)));

  console.log('\n4. the sequence survives a fresh counter (idempotent seeding)');
  const again = await Promise.all([
    allocateDocumentNumber(TENANT, 'invoice'),
    allocateDocumentNumber(TENANT, 'invoice'),
  ]);
  check('two more allocations are still distinct', again[0] !== again[1],
    again.join(' vs '));

  // ── Restore, then prove the restore happened ────────────────────────────────
  await pool.query(
    `DELETE FROM dypos.document_sequences
      WHERE tenant_id = $1 AND doc_type = ANY($2)`,
    [TENANT, ['purchase_order', 'work_order']],
  );
  for (const s of snapshot) {
    await pool.query(
      `UPDATE dypos.document_sequences SET next_value = $4::bigint
        WHERE tenant_id = $1 AND doc_type = $2 AND period_key = $3`,
      [TENANT, s.doc_type, s.period_key, s.next_value],
    );
  }
  const after = await pool.query(
    `SELECT doc_type, period_key, next_value
       FROM dypos.document_sequences WHERE tenant_id = $1`,
    [TENANT],
  );
  const restored = new Map(
    after.rows.map((r: { doc_type: string; period_key: string; next_value: string }) =>
      [`${r.doc_type}/${r.period_key}`, r.next_value]),
  );
  const unchanged = snapshot.every((s) => restored.get(`${s.doc_type}/${s.period_key}`) === s.next_value);
  check('the counters are exactly as this test found them', unchanged,
    `expected ${snapshot.length} rows restored, found ${after.rows.length}`);
  await pool.end();

  console.log(`\n${pass} passed, ${fail} failed`);
  process.exit(fail === 0 ? 0 : 1);
}

main().catch((e) => { console.error(e); process.exit(1); });