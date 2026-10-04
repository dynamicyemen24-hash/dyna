/**
 * DOCUMENT NUMBER RANGES — the SAP NCO pattern.
 *
 * ── Why this exists ─────────────────────────────────────────────────────────
 * The client was building invoice numbers itself:
 *
 *     `INV-${new Date().getFullYear()}-${String(transactions.length + 1002).padStart(4,'0')}`
 *
 * which is `transactions.length` — the length of the array THIS TERMINAL has
 * loaded. Two terminals at the same moment produce the same number, and a number
 * is only as good as its ability to be reconciled later. SAP makes number
 * allocation a server-side object precisely for this reason.
 *
 * ── The concurrency guarantee ───────────────────────────────────────────────
 * `SELECT … FOR UPDATE` takes a row lock on the counter, so two simultaneous
 * checkouts serialise: one reads, increments, writes and commits; the other
 * blocks until then reads the incremented value. Without the lock (and this is
 * the detail that is easy to get wrong) two workers read the same `next_value`
 * and both receive the same number.
 *
 * The first allocation of a period creates its row, which is why the lock alone
 * is not sufficient and the `ON CONFLICT DO NOTHING` + retry exists.
 */
import { pool } from './neonDb.js';

export type DocumentType = 'invoice' | 'purchase_order' | 'work_order' | 'journal';

/** Default prefix per document type. Tenant-configurable via the `prefix` column. */
const DEFAULT_PREFIX: Record<DocumentType, string> = {
  invoice: 'INV',
  purchase_order: 'PO',
  work_order: 'WO',
  journal: 'JRN',
};

/**
 * Allocates the next number for a document type, atomically.
 *
 * Returns e.g. `INV-2026-000042`. The number is GAPLESS by construction: it is
 * only consumed by a document that is then written, and a failed write leaves a
 * visible gap rather than a silent duplicate — which is the trade SAP also
 * makes, because a gap is auditable and a duplicate is not.
 */
/**
 * The single row `UPDATE … RETURNING` hands back.
 *
 * `next_value` is a Postgres `bigint`, which the driver returns as a string —
 * typed as such so the arithmetic below cannot silently produce `NaN` if the
 * column type ever changes. `prefix` is nullable in the schema.
 */
interface SequenceRow {
  next_value: string | number;
  prefix: string | null;
}

export async function allocateDocumentNumber(
  tenantId: string,
  docType: DocumentType,
  when: Date = new Date(),
  /**
   * The caller's transaction client.
   *
   * This is REQUIRED for the lock to mean anything. The counter row is locked by
   * `UPDATE … RETURNING` and that lock is held only until the enclosing
   * transaction ends — so allocating through `pool` from inside an open
   * transaction would take the lock on a DIFFERENT connection, release it
   * immediately, and let a concurrent checkout read the same value. Passing the
   * client is what makes the row lock cover the invoice write that follows.
   */
  client?: { query: (sql: string, values?: unknown[]) => Promise<{ rows: SequenceRow[] }> },
): Promise<string> {
  const q = client ?? pool;
  const periodKey = String(when.getUTCFullYear());

  // Ensure the counter row exists. `ON CONFLICT DO NOTHING` makes concurrent
  // creators safe: exactly one wins, the others see no row and fall through.
  await q.query(
    `INSERT INTO dypos.document_sequences
       (tenant_id, doc_type, period_key, next_value, prefix)
     VALUES ($1, $2, $3, 1, $4)
     ON CONFLICT (tenant_id, doc_type, period_key) DO NOTHING`,
    [tenantId, docType, periodKey, DEFAULT_PREFIX[docType] ?? docType.toUpperCase()],
  );

  /*
   * The lock is the whole point. `UPDATE … RETURNING` takes a row lock held to
   * commit, so the read and the increment cannot interleave with another
   * allocator's on the same tenant and document type.
   */
  const { rows } = await q.query(
    `UPDATE dypos.document_sequences
        SET next_value = next_value + 1,
            updated_at = NOW()
      WHERE tenant_id = $1 AND doc_type = $2 AND period_key = $3
      RETURNING next_value, prefix`,
    [tenantId, docType, periodKey],
  );

  if (rows.length === 0) {
    throw new Error(`تعذّر تخصيص رقم لل{documentType} — لا يوجد عدّاد للفترة ${periodKey}`);
  }

  // `next_value` is post-increment, so the number issued is the value BEFORE it.
  const issued = Number(rows[0].next_value) - 1;
  const prefix = String(rows[0].prefix || DEFAULT_PREFIX[docType] || 'DOC');

  return `${prefix}-${periodKey}-${String(issued).padStart(6, '0')}`;
}
