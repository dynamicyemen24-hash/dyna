-- ===========================================================================
-- v135 — Release control + forced credential rotation
--
-- Two problems are solved here:
--
-- 1. Password storage. The earlier SHA-256 digest had no salt, so every user
--    sharing one password produced an identical hash, and a single rainbow
--    table would open every account at once. PBKDF2-SHA512 with a per-user
--    random salt and a high iteration count replaces it. Legacy digests stay
--    readable only so a user can log in once and be migrated.
--
-- 2. Release traceability. Every build is numbered and stamped, so a
--    deployment can be identified in the field without guesswork.
-- ===========================================================================

-- ---------------------------------------------------------------------------
-- 1. CREDENTIAL STATE
-- ---------------------------------------------------------------------------

ALTER TABLE dypos.users
  ADD COLUMN IF NOT EXISTS password_algo       VARCHAR(24) NOT NULL DEFAULT 'pbkdf2-sha512',
  ADD COLUMN IF NOT EXISTS password_salt       VARCHAR(64),
  ADD COLUMN IF NOT EXISTS password_iterations INTEGER NOT NULL DEFAULT 210000,
  ADD COLUMN IF NOT EXISTS password_updated_at TIMESTAMPTZ,
  -- The flag that forces a change on next sign-in.
  ADD COLUMN IF NOT EXISTS must_change_password BOOLEAN NOT NULL DEFAULT TRUE,
  ADD COLUMN IF NOT EXISTS password_expires_at  TIMESTAMPTZ,
  -- Self-service reset tokens are hashed before storage, never stored raw.
  ADD COLUMN IF NOT EXISTS reset_token_hash     VARCHAR(128),
  ADD COLUMN IF NOT EXISTS reset_token_expires  TIMESTAMPTZ,
  ADD COLUMN IF NOT EXISTS failed_attempts      SMALLINT NOT NULL DEFAULT 0,
  ADD COLUMN IF NOT EXISTS locked_until         TIMESTAMPTZ;

-- ---------------------------------------------------------------------------
-- 2. LOGIN AUDIT
-- A credential event is evidence. Recording successes and failures separately
-- is what makes brute-force detection possible at all.
-- ---------------------------------------------------------------------------

CREATE TABLE IF NOT EXISTS dypos.auth_events (
  id          TEXT PRIMARY KEY,
  tenant_id   VARCHAR(64) NOT NULL,
  username    VARCHAR(64) NOT NULL,
  event_type  VARCHAR(24) NOT NULL
              CHECK (event_type IN (
                'login_success', 'login_failed', 'password_changed',
                'password_reset_requested', 'password_reset_completed',
                'account_locked', 'logout'
              )),
  ip_address  VARCHAR(64),
  user_agent  VARCHAR(255),
  reason      VARCHAR(128),
  created_at  TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_auth_events_lookup
  ON dypos.auth_events (tenant_id, username, created_at DESC);

-- ---------------------------------------------------------------------------
-- 3. RELEASE LEDGER
-- The version is written to the database on deploy so a running instance can
-- report exactly what code produced its numbers.
-- ---------------------------------------------------------------------------

CREATE TABLE IF NOT EXISTS dypos.app_releases (
  version      VARCHAR(24) PRIMARY KEY,
  build_at     TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  notes        TEXT,
  deployed_by  VARCHAR(64),
  is_current   BOOLEAN NOT NULL DEFAULT FALSE
);

CREATE UNIQUE INDEX IF NOT EXISTS uq_current_release
  ON dypos.app_releases (is_current) WHERE is_current;