-- ===========================================================================
-- v146 — Subscriber registration and API keys
-- ===========================================================================
--
-- WHAT THIS IS FOR
-- ----------------
-- A business subscribes to DyPOS, receives a public key it can use from its own
-- integration (a till, a store, a reporting job), and that key identifies the
-- subscription wherever it is used.
--
-- ══ THE KEY IS STORED AS A HASH, NEVER AS ITSELF ═════════════════════════
-- The plaintext key is returned exactly once, at creation, and is not
-- recoverable afterwards. `key_hash` is a SHA-256 of the key.
--
-- This is the same discipline a password uses, and for the same reason: a
-- database that can be read must not yield a usable credential. A `key_prefix`
-- column holds the first few characters so a key can be RECOGNISED in a list
-- without being verifiable from the list — the same reason a bank shows the last
-- four of a card number.
--
-- SHA-256 rather than bcrypt/argon2 is deliberate and worth stating, because it
-- is normally the wrong choice: an API key is 256 bits of cryptographic
-- randomness, not a human password. There is no dictionary to attack and no
-- low-entropy guess to slow down, so a slow KDF would add latency to every
-- single API call without making the key any harder to recover from a stolen
-- hash. The property that matters is that the stored value cannot be reversed.
--
-- ══ UNIQUE PER TENANT, NOT GLOBALLY ═════════════════════════════════════════
-- Two customers may each hold a key. Scoping the uniqueness to the tenant mirrors
-- `users(idempotency_key)`: a global index would let one tenant's key collide
-- with another's and turn a legitimate call into a 500 that says nothing useful.
--
-- ══ KEY STATE IS EXPLICIT ═════════════════════════════════════════════════
-- `revoked_at` rather than a boolean, because a key is revoked at a moment and
-- "when" is the fact worth keeping. `last_used_at` is what makes an unused key
-- distinguishable from a dead one.
-- ===========================================================================

CREATE TABLE IF NOT EXISTS dypos.api_keys (
  id            VARCHAR(64) PRIMARY KEY,
  tenant_id     VARCHAR(64) NOT NULL REFERENCES dypos.tenants(id) ON DELETE CASCADE,
  key_hash      VARCHAR(64) NOT NULL,
  /*
   * The first characters of the key, shown in a list so a key can be recognised.
   * Deliberately too short to be a meaningful part of a 256-bit secret.
   */
  key_prefix    VARCHAR(16) NOT NULL,
  label         VARCHAR(128) NOT NULL,
  /*
   * What the key may do. An API key that can only read cannot be used to change
   * anything, so leaking one does not become a write incident.
   */
  scopes        TEXT[] NOT NULL DEFAULT ARRAY['read']::TEXT[],
  created_at    TIMESTAMP WITH TIME ZONE DEFAULT CURRENT_TIMESTAMP,
  last_used_at  TIMESTAMP WITH TIME ZONE,
  revoked_at    TIMESTAMP WITH TIME ZONE,
  revoked_by    VARCHAR(64),
  /*
   * Who created it. A credential issued by a person is auditable; one issued by
   * nothing is not.
   */
  created_by    VARCHAR(64)
);

-- One hash per tenant. This is the lookup path on every API call, so it is
-- indexed directly rather than left to a sequential scan.
CREATE UNIQUE INDEX IF NOT EXISTS api_keys_hash_uq
  ON dypos.api_keys (key_hash);

CREATE UNIQUE INDEX IF NOT EXISTS api_keys_tenant_prefix_uq
  ON dypos.api_keys (tenant_id, key_prefix);

CREATE INDEX IF NOT EXISTS api_keys_tenant_active_idx
  ON dypos.api_keys (tenant_id)
  WHERE revoked_at IS NULL;

ALTER TABLE dypos.api_keys
  DROP CONSTRAINT IF EXISTS api_keys_scopes_check;
ALTER TABLE dypos.api_keys
  ADD CONSTRAINT api_keys_scopes_check
  CHECK (
    cardinality(scopes) > 0
    AND scopes <@ ARRAY['read', 'write']::TEXT[]
  );

COMMENT ON TABLE dypos.api_keys IS
  'Subscriber API keys. The plaintext key is returned ONCE at creation and is '
  'never stored — key_hash is SHA-256. A key authenticates a caller to its '
  'tenant; it does not create one.';

COMMENT ON COLUMN dypos.api_keys.key_prefix IS
  'First characters of the key, for recognition in a list. Not sufficient to '
  'authenticate with, by design.';