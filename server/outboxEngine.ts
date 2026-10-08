import { pool } from './neonDb.js';
import { makeId } from './apiHelpers.js';

export type OutboxStatus = 'queued' | 'sending' | 'sent' | 'failed' | 'dead_letter';

export interface OutboxEvent {
  id: string;
  tenantId: string;
  kind: string;
  payload: Record<string, unknown>;
  status: OutboxStatus;
  attempts: number;
  createdAt?: Date;
  updatedAt?: Date;
}

export async function enqueueOutboxEvent(tenantId: string, kind: string, payload: Record<string, unknown>): Promise<OutboxEvent> {
  const id = `outbox-${makeId('o').replace(/-/g, '').slice(0, 18)}`;
  const res = await pool.query(
    `INSERT INTO dypos.identity_outbox (id, tenant_id, kind, payload, status, attempts, created_at, updated_at)
     VALUES ($1, $2, $3, $4, 'queued', 0, NOW(), NOW())
     RETURNING *`,
    [id, tenantId, kind, payload],
  );

  const row = res.rows[0];
  return {
    id: row.id,
    tenantId: row.tenant_id,
    kind: row.kind,
    payload: row.payload || {},
    status: row.status,
    attempts: Number(row.attempts || 0),
    createdAt: row.created_at ? new Date(row.created_at) : undefined,
    updatedAt: row.updated_at ? new Date(row.updated_at) : undefined,
  };
}

export async function processIdentityOutbox(limit = 20): Promise<{ processed: number; failed: number; items: string[] }> {
  const rows = await pool.query(
    `SELECT * FROM dypos.identity_outbox
     WHERE status IN ('queued', 'failed')
     ORDER BY created_at ASC
     LIMIT $1`,
    [limit],
  );

  let processed = 0;
  let failed = 0;
  const items: string[] = [];

  for (const row of rows.rows) {
    items.push(row.id);
    try {
      await pool.query(
        `UPDATE dypos.identity_outbox
         SET status = 'sending', attempts = attempts + 1, updated_at = NOW()
         WHERE id = $1`,
        [row.id],
      );

      if (row.kind === 'tenant_enrollment') {
        const payload = row.payload || {};
        const tenantId = payload.tenantId as string | undefined;
        const userId = payload.userId as string | undefined;
        const branchId = payload.branchId as string | undefined;

        if (!tenantId || !userId || !branchId) {
          throw new Error('Missing tenant/user/branch in enrollment payload');
        }

        const tenantCheck = await pool.query(
          `SELECT id FROM dypos.tenants WHERE id = $1 AND is_active IS NOT FALSE`,
          [tenantId],
        );
        if (!tenantCheck.rows[0]) {
          throw new Error('tenant enrollment not found after queueing');
        }
      }

      await pool.query(
        `UPDATE dypos.identity_outbox
         SET status = 'sent', updated_at = NOW()
         WHERE id = $1`,
        [row.id],
      );
      processed += 1;
    } catch (error) {
      failed += 1;
      await pool.query(
        `UPDATE dypos.identity_outbox
         SET status = CASE WHEN attempts >= 5 THEN 'dead_letter' ELSE 'failed' END,
             updated_at = NOW()
         WHERE id = $1`,
        [row.id],
      );
    }
  }

  return { processed, failed, items };
}
