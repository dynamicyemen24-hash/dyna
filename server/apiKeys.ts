/**
 * Subscriber API keys.
 *
 * ══ THE KEY IS SHOWN ONCE ═════════════════════════════════════════════════
 * `createKey` returns the plaintext and nothing ever stores it. The row holds a
 * SHA-256 hash. That is the rule a password-reset token follows, and the reason
 * a stolen database snapshot does not yield working credentials.
 *
 * ══ WHY SHA-256 AND NOT A SLOW KDF ═════════════════════════════════════════
 * bcrypt and argon2 are right for a HUMAN password: a human picks from a small
 * space, and the deliberate cost is what makes guessing it impractical.
 *
 * An API key here is 32 bytes from `randomBytes` — 256 bits of entropy. There
 * is no dictionary to attack and no low-entropy space to enumerate, so a KDF with
 * a delay would add latency to every authenticated API call without making a
 * stolen hash meaningfully harder to reverse. The property that matters is
 * irreversibility, and SHA-256 has it.
 *
 * A key authenticates a caller to its tenant. It never CREATES a tenant — that is
 * the line that stops a leaked key from becoming a new customer on our system.
 */
import { createHash, randomBytes } from 'node:crypto';
import { pool } from './neonDb.js';
import { makeId } from './apiHelpers.js';

export type ApiKeyScope = 'read' | 'write';

export interface IssuedApiKey {
  id: string;
  /** Plaintext. RETURNED ONCE — never stored, never recoverable. */
  key: string;
  keyPrefix: string;
  label: string;
  scopes: ApiKeyScope[];
  createdAt: string;
}

export interface ApiKeyRecord {
  id: string;
  tenantId: string;
  keyPrefix: string;
  label: string;
  scopes: ApiKeyScope[];
  createdAt: string;
  lastUsedAt: string | null;
  revokedAt: string | null;
}

const hashKey = (key: string): string =>
  createHash('sha256').update(key, 'utf8').digest('hex');

/**
 * Mints a key.
 *
 * The visible prefix identifies the key as ours, so one that reaches a log or a
 * support ticket is recognisable — and recognisable as NOT a password, which is
 * the useful part. The part that authenticates is 32 random bytes; the prefix
 * adds no entropy and is not a secret.
 */
export async function createKey(
  tenantId: string,
  label: string,
  scopes: ApiKeyScope[] = ['read'],
  createdBy?: string,
): Promise<IssuedApiKey> {
  const id = makeId('key');
  const secret = randomBytes(32).toString('base64url');
  const key = `dypos_${id.slice(-6)}_${secret}`;

  const { rows } = await pool.query(
    `INSERT INTO dypos.api_keys
       (id, tenant_id, key_hash, key_prefix, label, scopes, created_by)
     VALUES ($1,$2,$3,$4,$5,$6,$7)
     RETURNING id, key_prefix, label, scopes, created_at`,
    [id, tenantId, hashKey(key), key.slice(0, 14), label, scopes, createdBy ?? null],
  );

  const row = rows[0];
  return {
    id: row.id,
    key,
    keyPrefix: row.key_prefix,
    label: row.label,
    scopes: row.scopes,
    createdAt: row.created_at,
  };
}

/**
 * Resolves a presented key to the tenant it authenticates.
 *
 * Returns null for an unknown key, a revoked key, or an inactive tenant — all
 * indistinguishable to the caller, so this cannot be used to learn whether a
 * particular key once existed.
 */
export async function verifyKey(
  key: string,
): Promise<{ tenantId: string; keyId: string; scopes: ApiKeyScope[] } | null> {
  if (typeof key !== 'string' || key.length < 20 || key.length > 200) return null;

  const { rows } = await pool.query(
    `SELECT k.id, k.tenant_id, k.scopes, t.is_active
       FROM dypos.api_keys k
       JOIN dypos.tenants t ON t.id = k.tenant_id
      WHERE k.key_hash = $1 AND k.revoked_at IS NULL`,
    [hashKey(key)],
  );
  if (!rows.length) return null;
  if (rows[0].is_active === false) return null;

  /*
   * `last_used_at` is a DIAGNOSTIC — "which keys are actually in use" — and must
   * never be able to fail an authentication or slow one down. So it is a separate
   * statement whose error is swallowed: a key that verifies but cannot be stamped
   * is still a valid key.
   */
  pool.query(
    `UPDATE dypos.api_keys SET last_used_at = NOW() WHERE id = $1`,
    [rows[0].id],
  ).catch(() => { /* diagnostic only — never affects the result */ });

  return { tenantId: rows[0].tenant_id, keyId: rows[0].id, scopes: rows[0].scopes };
}

/** The list shown in settings. No hashes and no secret material. */
export async function listKeys(tenantId: string): Promise<ApiKeyRecord[]> {
  const { rows } = await pool.query(
    `SELECT id, key_prefix, label, scopes, created_at, last_used_at, revoked_at
       FROM dypos.api_keys
      WHERE tenant_id = $1
      ORDER BY revoked_at NULLS FIRST, created_at DESC`,
    [tenantId],
  );
  return rows.map((r: Record<string, unknown>) => ({
    id: String(r.id),
    tenantId,
    keyPrefix: String(r.key_prefix),
    label: String(r.label),
    // `scopes` is a Postgres text[]; the row is typed at the boundary rather than
    // trusted to be well-formed, because a value written by a migration is not
    // covered by the TS type.
    scopes: Array.isArray(r.scopes) ? (r.scopes as ApiKeyScope[]) : ['read'],
    createdAt: String(r.created_at),
    lastUsedAt: r.last_used_at ? String(r.last_used_at) : null,
    revokedAt: r.revoked_at ? String(r.revoked_at) : null,
  }));
}

/**
 * Revokes a key.
 *
 * Revocation is a MARKER, not a DELETE: the row stays so "this key existed and
 * was revoked on this date" remains answerable, which is the first question asked
 * after an incident. Deleting it would also free the prefix, so a stale key in
 * an old integration could be silently superseded by a new one.
 */
export async function revokeKey(
  tenantId: string,
  keyId: string,
  revokedBy?: string,
): Promise<boolean> {
  const { rowCount } = await pool.query(
    `UPDATE dypos.api_keys
        SET revoked_at = NOW(), revoked_by = $3
      WHERE id = $1 AND tenant_id = $2 AND revoked_at IS NULL`,
    [keyId, tenantId, revokedBy ?? null],
  );
  return (rowCount ?? 0) > 0;
}