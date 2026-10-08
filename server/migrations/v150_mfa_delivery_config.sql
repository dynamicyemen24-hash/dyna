-- ===========================================================================
-- v150 — Per-tenant MFA delivery configuration (merchant-configurable)
-- ===========================================================================
--
-- WHY THIS MIGRATION EXISTS
-- -------------------------
-- `server/mfa.ts` exposed `setMfaDeliverer()` at BOOT: one channel for the
-- whole installation. On a multi-tenant SaaS deployment that is the wrong
-- owner — a merchant cannot choose how THEIR operators receive codes, and the
-- only way to change the channel was a code deploy. The delivery seam now
-- lives in the database, scoped per tenant, editable by the merchant from the
-- settings screen behind `settings.manage`.
--
-- WHY A NEW TABLE AND NOT COLUMNS ON `tenants`
-- --------------------------------------------
-- A webhook config is a nested object (endpoint, template, auth header) with
-- its own audit lifecycle (created/rotated/tested), not a scalar on the
-- tenant row. A separate table also keeps the hot tenant lookup untouched —
-- no extra JSONB parsing on every request of every user.
--
-- WHY THE SECRET IS A HASHED TOKEN, NOT A PASSWORD
-- ------------------------------------------------
-- `webhook_secret_hash` authenticates the TENANT's own endpoint handshake
-- when our server calls OUT (shared secret in theAuthorization header), and
-- it is stored hashed with SHA-256 so a database dump cannot replay it.
-- The raw value is shown exactly ONCE at creation, like a reset token.
--
-- CHANNEL VALUES
-- --------------
--   'server-log' — the honest default; code goes to the server log.
--   'webhook'    — POST {to, code, expiresInSeconds} to webhook_url.
--   'sms'        — reserved for a future direct-SMS gateway config; writing it
--                  today is refused (422) rather than stored and ignored, so a
--                  merchant can never believe SMS is on when nothing sends.
--
-- Everything is additive and idempotent, like every pack in this directory.
-- ===========================================================================

CREATE TABLE IF NOT EXISTS dypos.mfa_delivery_config (
  tenant_id          VARCHAR(64) PRIMARY KEY REFERENCES dypos.tenants(id) ON DELETE CASCADE,
  channel            VARCHAR(16) NOT NULL DEFAULT 'server-log'
                     CHECK (channel IN ('server-log', 'webhook')),
  webhook_url        TEXT,
  webhook_template   TEXT,
  webhook_secret_hash TEXT,
  updated_by         VARCHAR(64),
  updated_at         TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  created_at         TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

-- Switching between stock schema shapes must not strand tenants: a webhook
-- row without a URL is a row that cannot be used, so the check below rejects
-- the inconsistent state instead of letting the runtime discover it at 02:00.
ALTER TABLE dypos.mfa_delivery_config
  ADD CONSTRAINT mfa_delivery_webhook_needs_url
  CHECK (
    channel <> 'webhook'
    OR (webhook_url IS NOT NULL AND webhook_url <> '')
  );
