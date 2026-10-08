import { pool } from './neonDb.js';

export interface RecoverySnapshot {
  tenantId?: string;
  userId?: string;
  branchId?: string;
  state: 'healthy' | 'needs_recovery' | 'conflict' | 'offline_pending';
  message: string;
}

export async function recoverIdentityState(tenantId?: string, userId?: string): Promise<RecoverySnapshot> {
  if (!tenantId || !userId) {
    return {
      state: 'needs_recovery',
      message: 'Identity is incomplete after restart or interrupted enrollment.',
    };
  }

  const tenantRow = await pool.query(
    `SELECT id, is_active FROM dypos.tenants WHERE id = $1`,
    [tenantId],
  );

  const userRow = await pool.query(
    `SELECT id, tenant_id, is_active FROM dypos.users WHERE id = $1 AND tenant_id = $2`,
    [userId, tenantId],
  );

  if (!tenantRow.rows[0] || !userRow.rows[0]) {
    return {
      state: 'conflict',
      message: 'Identity mismatch: tenant and user mapping do not agree.',
      tenantId,
      userId,
    };
  }

  const branchRow = await pool.query(
    `SELECT branch_id FROM dypos.user_branch_access WHERE user_id = $1 LIMIT 1`,
    [userId],
  );

  if (!branchRow.rows[0]) {
    return {
      state: 'needs_recovery',
      message: 'User is valid but has no branch attached yet.',
      tenantId,
      userId,
    };
  }

  return {
    state: 'healthy',
    message: 'Identity state restored successfully.',
    tenantId,
    userId,
    branchId: branchRow.rows[0].branch_id,
  };
}
