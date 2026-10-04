-- ===========================================================================
-- v138 — Server-enforced second factor
--
-- WHY THIS MIGRATION EXISTS
-- -----------------------
-- The sign-in screen ran a "2FA" step entirely in the browser: it compared the
-- entered digits against a constant compiled into the JavaScript bundle
-- (`DEFAULT_OTP`), and the break-glass path compared against a hard-coded list
-- of passcodes (`SUP1999`, `EMRG9999`, `breakglass`). Neither check touched the
-- server, so BOTH were bypassed by anyone who opened devtools — the second
-- factor protected nothing, and "break glass" was a universal backdoor that
-- skipped password verification entirely.
--
-- The factor must be decided and verified by the server, because the client is
-- the untrusted party. This migration adds the storage that makes that
-- possible:
--
--   1. `mfa_secrets`  — per-user enrolment state. `enabled` is per-user so a
--                        tenant can roll MFA out without a migration per account.
--   2. `mfa_challenges` — one row per *attempted login*, holding the challenge
--                        token and the hashed code. The code is never stored in
--                        the clear: a dump of this table must not let anyone log
--                        in. Attempts are counted per row and the row is burnt
--                        after the allowance, so brute-forcing a six-digit code
--                        is 10^6 online attempts against a 5-try budget, not a
--                        single guess.
--   3. `break_glass_grants` — emergency access is now an *issued, expiring,
--                        single-use, audited* grant, not a magic string.
--
-- Everything is additive and idempotent: an existing installation gains the
-- tables without losing rows, and re-running is safe.
-- ===========================================================================

-- ---------------------------------------------------------------------------
-- 1. PER-USER MFA ENROLMENT
-- ---------------------------------------------------------------------------

CREATE TABLE IF NOT EXISTS dypos.mfa_secrets (
  user_id       VARCHAR(64) PRIMARY KEY REFERENCES dypos.users(id) ON DELETE CASCADE,
  tenant_id     VARCHAR(64) NOT NULL REFERENCES dypos.tenants(id),
  -- Only ever a *hash*. The secret itself exists only at enrolment time and is
  -- shown to the operator once, exactly like a password.
  secret_hash   TEXT NOT NULL,
  enabled       BOOLEAN NOT NULL DEFAULT false,
  -- Digits (6 = TOTP-style / SMS-style numeric code length).
  digits        SMALLINT NOT NULL DEFAULT 6 CHECK (digits BETWEEN 6 AND 10),
  -- Seconds between accepted time-steps; a small window absorbs clock skew.
  period        INTEGER NOT NULL DEFAULT 30 CHECK (period BETWEEN 15 AND 120),
  enrolled_at   TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  last_used_at  TIMESTAMPTZ,
  -- Set when the factor is deliberately withdrawn; keeps the audit trail.
  disabled_at   TIMESTAMPTZ,
  disabled_by   VARCHAR(64)
);

CREATE INDEX IF NOT EXISTS idx_mfa_secrets_tenant
  ON dypos.mfa_secrets (tenant_id, enabled);

-- ---------------------------------------------------------------------------
-- 2. PENDING CHALLENGES  (the "password is right, prove the second factor")
-- ---------------------------------------------------------------------------

CREATE TABLE IF NOT EXISTS dypos.mfa_challenges (
  id            VARCHAR(64) PRIMARY KEY,
  tenant_id     VARCHAR(64) NOT NULL REFERENCES dypos.tenants(id),
  user_id       VARCHAR(64) NOT NULL REFERENCES dypos.users(id) ON DELETE CASCADE,
  branch_id     VARCHAR(64),
  -- Opaque handle the client echoes back. Carries no authority of its own: it
  -- only names the row, and the row is consumed on first successful verify.
  challenge     VARCHAR(128) NOT NULL UNIQUE,
  -- SHA-256 of the delivered code. Never the code.
  code_hash     TEXT NOT NULL,
  digits        SMALLINT NOT NULL DEFAULT 6,
  attempts      SMALLINT NOT NULL DEFAULT 0,
  max_attempts  SMALLINT NOT NULL DEFAULT 5,
  expires_at    TIMESTAMPTZ NOT NULL,
  consumed_at   TIMESTAMPTZ,
  created_at    TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

-- Only live, unexpired challenges are ever looked up.
CREATE INDEX IF NOT EXISTS idx_mfa_challenges_live
  ON dypos.mfa_challenges (challenge, expires_at)
  WHERE consumed_at IS NULL;

CREATE INDEX IF NOT EXISTS idx_mfa_challenges_user
  ON dypos.mfa_challenges (user_id, created_at DESC);

-- ---------------------------------------------------------------------------
-- 3. BREAK-GLASS GRANTS  (emergency access as an auditable object)
-- ---------------------------------------------------------------------------

CREATE TABLE IF NOT EXISTS dypos.break_glass_grants (
  id            VARCHAR(64) PRIMARY KEY,
  tenant_id     VARCHAR(64) NOT NULL REFERENCES dypos.tenants(id),
  -- Hash of the one-time code handed to the supervisor. Single use.
  code_hash     TEXT NOT NULL,
  issued_by     VARCHAR(64) NOT NULL,
  reason        TEXT NOT NULL,
  -- Null while unused; set the moment it is redeemed.
  used_at       TIMESTAMPTZ,
  used_by       VARCHAR(64),
  expires_at    TIMESTAMPTZ NOT NULL,
  created_at    TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_break_glass_live
  ON dypos.break_glass_grants (tenant_id, expires_at)
  WHERE used_at IS NULL;

-- ---------------------------------------------------------------------------
-- 4. LOGIN ATTEMPT BUDGET FOR THE SECOND FACTOR
--
-- Password lockout lives on `users.failed_attempts`. A stolen *valid* password
-- would otherwise let an attacker grind the six-digit code forever, so the
-- factor gets its own independent budget and lockout window.
-- ---------------------------------------------------------------------------

-- ---------------------------------------------------------------------------
-- 4. LOGIN ATTEMPT BUDGET FOR THE SECOND FACTOR
--
-- Password lockout lives on `users.failed_attempts`. A stolen *valid* password
-- would otherwise let an attacker grind the six-digit code forever, so the
-- factor gets its own independent budget and lockout window.
-- ---------------------------------------------------------------------------

--
-- `auth_events.event_type` carries a CHECK constraint listing the original
-- seven credential events. The second factor adds new, equally auditable
-- events, and a CHECK that rejects a legitimate event is a runtime crash on the
-- login path — so the allowed set is widened here rather than by writing a
-- narrower insert in the route.
--
-- The CHECK is dropped and replaced: PostgreSQL cannot ALTER a constraint, and
-- the replacement is written to be idempotent.
-- ---------------------------------------------------------------------------

ALTER TABLE dypos.auth_events DROP CONSTRAINT IF EXISTS auth_events_event_type_check;

ALTER TABLE dypos.auth_events
  ADD CONSTRAINT auth_events_event_type_check
  CHECK (event_type IN (
    'login_success', 'login_failed', 'password_changed',
    'password_reset_requested', 'password_reset_completed',
    'account_locked', 'logout',
    -- Second factor.
    'mfa_challenged', 'mfa_success', 'mfa_failed',
    -- Emergency access, on issue and on redemption.
    'break_glass_issued', 'break_glass_redeemed', 'break_glass_denied'
  ));
