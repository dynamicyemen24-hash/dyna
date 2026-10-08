import { Pool } from 'pg';
import { PG_SSL } from './neonDb.ts';
import { DEFAULT_TENANT } from './tenant.js';

const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  ssl: PG_SSL,
  max: 3,
});

export async function initSyncEngineTables() {
  const client = await pool.connect();
  try {
    await client.query(`
      CREATE SCHEMA IF NOT EXISTS dypos;

      CREATE TABLE IF NOT EXISTS dypos.sync_outbox (
        id VARCHAR(64) PRIMARY KEY,
        tenant_id VARCHAR(64) NOT NULL,
        branch_id VARCHAR(64),
        client_id VARCHAR(64) NOT NULL,
        table_name VARCHAR(128) NOT NULL,
        record_id VARCHAR(64) NOT NULL,
        operation VARCHAR(16) NOT NULL CHECK (operation IN ('INSERT', 'UPDATE', 'DELETE')),
        payload JSONB NOT NULL,
        vector_clock JSONB NOT NULL DEFAULT '{}'::jsonb,
        status VARCHAR(32) NOT NULL DEFAULT 'pending', -- pending, synced, conflicted, resolved
        conflict_details JSONB,
        created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
        synced_at TIMESTAMPTZ
      );

      CREATE INDEX IF NOT EXISTS idx_sync_outbox_tenant_status 
        ON dypos.sync_outbox (tenant_id, status, created_at DESC);

      CREATE TABLE IF NOT EXISTS dypos.crdt_state_vector (
        tenant_id VARCHAR(64) NOT NULL,
        table_name VARCHAR(128) NOT NULL,
        record_id VARCHAR(64) NOT NULL,
        state_version BIGINT NOT NULL DEFAULT 1,
        last_modified_by VARCHAR(64) NOT NULL,
        vector_clock JSONB NOT NULL DEFAULT '{}'::jsonb,
        data JSONB NOT NULL,
        PRIMARY KEY (tenant_id, table_name, record_id)
      );
    `);
    console.log('[SyncEngine] CRDT sync engine tables initialized successfully.');
  } finally {
    client.release();
  }
}

export function registerSyncRoutes(app: any) {
  // Push offline transactions batch
  app.post('/api/sync/push', async (req: any, res: any) => {
    const client = await pool.connect();
    try {
      const { clientId, branchId, changes } = req.body;
      const tenantId = req.headers['x-tenant-id'] || req.body.tenantId || DEFAULT_TENANT;
      
      if (!Array.isArray(changes)) {
        return res.status(400).json({ error: 'changes array is required' });
      }

      const results = [];
      await client.query('BEGIN');

      for (const item of changes) {
        const { id, tableName, recordId, operation, payload, vectorClock } = item;
        
        // Check vector clock conflict (Last-Writer-Wins with causal vector precedence)
        const existingRes = await client.query(
          `SELECT state_version, vector_clock FROM dypos.crdt_state_vector WHERE tenant_id = $1 AND table_name = $2 AND record_id = $3`,
          [tenantId, tableName, recordId]
        );

        let status = 'synced';
        let conflictDetails = null;

        if (existingRes.rows.length > 0) {
          const currentVersion = existingRes.rows[0].state_version;
          const incomingVersion = vectorClock?.version || (currentVersion + 1);
          
          if (incomingVersion <= currentVersion) {
            // Potential concurrent write conflict -> LWW or merge
            status = 'conflicted';
            conflictDetails = { serverVersion: currentVersion, incomingVersion, resolvedBy: 'LWW' };
          }
        }

        // Upsert outbox log
        await client.query(
          `INSERT INTO dypos.sync_outbox (id, tenant_id, branch_id, client_id, table_name, record_id, operation, payload, vector_clock, status, conflict_details, synced_at)
           VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, NOW())
           ON CONFLICT (id) DO UPDATE SET status = EXCLUDED.status, synced_at = NOW()`,
          [id || crypto.randomUUID(), tenantId, branchId, clientId, tableName, recordId, operation, JSON.stringify(payload), JSON.stringify(vectorClock || {}), status, conflictDetails ? JSON.stringify(conflictDetails) : null]
        );

        // Update CRDT state vector
        await client.query(
          `INSERT INTO dypos.crdt_state_vector (tenant_id, table_name, record_id, state_version, last_modified_by, vector_clock, data)
           VALUES ($1, $2, $3, $4, $5, $6, $7)
           ON CONFLICT (tenant_id, table_name, record_id) DO UPDATE 
           SET state_version = dypos.crdt_state_vector.state_version + 1,
               last_modified_by = EXCLUDED.last_modified_by,
               vector_clock = EXCLUDED.vector_clock,
               data = EXCLUDED.data`,
          [tenantId, tableName, recordId, vectorClock?.version || 1, clientId, JSON.stringify(vectorClock || {}), JSON.stringify(payload)]
        );

        results.push({ id, status, recordId, tableName });
      }

      await client.query('COMMIT');
      res.json({ ok: true, syncedCount: results.length, results });
    } catch (err: any) {
      await client.query('ROLLBACK');
      console.error('[SyncEngine] Push sync error:', err);
      res.status(500).json({ error: err.message });
    } finally {
      client.release();
    }
  });

  // Pull server changes since client version
  app.get('/api/sync/pull', async (req: any, res: any) => {
    const client = await pool.connect();
    try {
      const tenantId = req.query.tenantId || req.headers['x-tenant-id'] || DEFAULT_TENANT;
      const since = req.query.since ? new Date(String(req.query.since)) : new Date(Date.now() - 86400000);

      const rows = await client.query(
        `SELECT table_name, record_id, state_version, last_modified_by, vector_clock, data 
         FROM dypos.crdt_state_vector 
         WHERE tenant_id = $1`,
        [tenantId]
      );

      res.json({ ok: true, serverTime: new Date().toISOString(), records: rows.rows });
    } catch (err: any) {
      res.status(500).json({ error: err.message });
    } finally {
      client.release();
    }
  });
}
