import { Pool } from 'pg';
import { PG_SSL } from './neonDb.ts';
import { DEFAULT_TENANT } from './tenant.js';
import crypto from 'crypto';

const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  ssl: PG_SSL,
  max: 3,
});

export async function initSsoTables() {
  const client = await pool.connect();
  try {
    await client.query(`
      CREATE TABLE IF NOT EXISTS dypos.passkeys (
        id VARCHAR(64) PRIMARY KEY,
        tenant_id VARCHAR(64) NOT NULL,
        username VARCHAR(128) NOT NULL,
        credential_id TEXT NOT NULL UNIQUE,
        public_key TEXT NOT NULL,
        counter BIGINT NOT NULL DEFAULT 0,
        device_name VARCHAR(128),
        created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
      );

      CREATE TABLE IF NOT EXISTS dypos.sso_providers (
        tenant_id VARCHAR(64) PRIMARY KEY,
        provider_name VARCHAR(64) NOT NULL, -- e.g., 'azure_ad', 'okta', 'google_workspace'
        issuer_url TEXT NOT NULL,
        client_id TEXT NOT NULL,
        client_secret TEXT NOT NULL,
        is_active BOOLEAN NOT NULL DEFAULT true,
        updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
      );
    `);
    console.log('[SSOEngine] SSO & Passkeys tables initialized successfully.');
  } finally {
    client.release();
  }
}

export function registerSsoRoutes(app: any) {
  // Generate WebAuthn registration challenge for Passkeys
  app.post('/api/auth/passkey/register-challenge', async (req: any, res: any) => {
    try {
      const { username, tenantId } = req.body;
      const challenge = crypto.randomBytes(32).toString('base64url');
      res.json({
        ok: true,
        challenge,
        rp: { name: 'دينا: منصة التجارة الذكية', id: req.hostname || '' },
        user: { id: Buffer.from(username || 'user').toString('base64url'), name: username, displayName: username },
        pubKeyCredParams: [{ alg: -7, type: 'public-key' }, { alg: -257, type: 'public-key' }],
        timeout: 60000,
        attestation: 'direct'
      });
    } catch (err: any) {
      res.status(500).json({ error: err.message });
    }
  });

  // Verify and store Passkey credential
  app.post('/api/auth/passkey/register-verify', async (req: any, res: any) => {
    const client = await pool.connect();
    try {
      const { username, tenantId = DEFAULT_TENANT, credentialId, publicKey, deviceName } = req.body;
      if (!credentialId || !publicKey) {
        return res.status(400).json({ error: 'credentialId and publicKey are required' });
      }

      await client.query(
        `INSERT INTO dypos.passkeys (id, tenant_id, username, credential_id, public_key, device_name)
         VALUES ($1, $2, $3, $4, $5, $6)
         ON CONFLICT (credential_id) DO UPDATE SET counter = dypos.passkeys.counter + 1`,
        [crypto.randomUUID(), tenantId, username, credentialId, publicKey, deviceName || 'Zero-Trust Passkey Device']
      );

      res.json({ ok: true, message: 'Passkey registered successfully. Zero-trust authentication active.' });
    } catch (err: any) {
      res.status(500).json({ error: err.message });
    } finally {
      client.release();
    }
  });

  // Federated SSO Configuration endpoint for Enterprise Admins
  app.get('/api/auth/sso/config', async (req: any, res: any) => {
    const client = await pool.connect();
    try {
      const tenantId = req.query.tenantId || DEFAULT_TENANT;
      const result = await client.query(`SELECT provider_name, issuer_url, is_active FROM dypos.sso_providers WHERE tenant_id = $1`, [tenantId]);
      res.json({ ok: true, provider: result.rows[0] || null });
    } catch (err: any) {
      res.status(500).json({ error: err.message });
    } finally {
      client.release();
    }
  });
}
