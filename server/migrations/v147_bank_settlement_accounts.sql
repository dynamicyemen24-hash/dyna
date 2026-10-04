-- ===========================================================================
-- v147 — Per-tenant bank settlement accounts
-- ===========================================================================
--
-- WHY THIS MIGRATION EXISTS
-- -----------------------
-- The bank-transfer panel on the till printed this, from JavaScript literals:
--
--     IBAN: SA03 8000 0000 6080 1016 7519
--     بنك الراجحي - حساب شركة رويال العالمية
--
-- and `paymentGatewayService.generateSarieIbanQr` carried the same IBAN as a
-- DEFAULT PARAMETER ARGUMENT, so a caller that forgot to pass one silently paid
-- into a real bank account belonging to another organisation.
--
-- A settlement account is not a label. It is where the customer's money is
-- instructed to go. Three concrete failures follow from a compiled-in one:
--
--   1. Every merchant's takings are routed into one account. The merchant is
--      told "transfer to this IBAN", the QR says it, and the money leaves.
--   2. The default argument means the bug is invisible to review: the method
--      signature looks correct and the IBAN is not a parameter at all.
--   3. It cannot be fixed by configuration — it is in the bundle, so every
--      deployment carries it, and rotating the account requires a rebuild and a
--      redeploy of every tenant at once.
--
-- WHY A NEW TABLE RATHER THAN A COLUMN
-- -----------------------------------
-- `dypos.system_settings` is a GLOBAL key/value table — one row per key for the
-- whole installation. An IBAN there would be one merchant's account for every
-- tenant sharing the deployment, which is the same defect wearing a different
-- schema.
--
-- A business can also legitimately hold more than one account (a collection
-- account, a payroll account, a different bank per branch), so this is 1-to-many
-- rather than a single column on `tenants`. Branch scoping is included because a
-- chain of shops settles per branch and the QR on the till must match the branch
-- the sale was recorded at.
--
-- `holder_name` and `bank_name` are stored because the receiving bank shows them
-- to the payer; omitting them produces a transfer the customer cannot verify is
-- going to the right party.
-- ===========================================================================

CREATE TABLE IF NOT EXISTS dypos.bank_settlement_accounts (
  id              VARCHAR(64)  PRIMARY KEY,
  tenant_id       VARCHAR(64)  NOT NULL REFERENCES dypos.tenants(id) ON DELETE CASCADE,
  branch_id       VARCHAR(64),

  -- The account itself. Stored as text, never as a numeric type: IBANs are
  -- identifiers with check digits, not quantities, and leading zeros are
  -- significant. A numeric column would silently drop them.
  iban            TEXT         NOT NULL,
  bank_name       TEXT,
  holder_name     TEXT,
  swift_bic       TEXT,
  country_code    CHAR(2),

  -- A till may only offer accounts flagged for its own payment method, and the
  -- active flag is what "this is the one to show" means when several exist.
  payment_method  TEXT         NOT NULL DEFAULT 'bank_transfer',
  is_active       BOOLEAN      NOT NULL DEFAULT TRUE,
  is_default      BOOLEAN      NOT NULL DEFAULT FALSE,

  metadata        JSONB        NOT NULL DEFAULT '{}'::jsonb,
  created_at      TIMESTAMPTZ  NOT NULL DEFAULT NOW(),
  updated_at      TIMESTAMPTZ  NOT NULL DEFAULT NOW()
);

-- One account per tenant per IBAN. This is what stops a duplicated settlement
-- account from making a cashier choose between two identical destinations.
CREATE UNIQUE INDEX IF NOT EXISTS uq_bank_settlement_tenant_iban
  ON dypos.bank_settlement_accounts (tenant_id, iban);

-- A tenant has at most ONE default per payment method. A partial unique index
-- expresses "at most one default" in the database rather than in application
-- code, so a race between two operators setting defaults cannot produce two.
CREATE UNIQUE INDEX IF NOT EXISTS uq_bank_settlement_default_per_method
  ON dypos.bank_settlement_accounts (tenant_id, payment_method)
  WHERE is_default AND is_active;

-- The lookup the till actually performs.
CREATE INDEX IF NOT EXISTS idx_bank_settlement_active
  ON dypos.bank_settlement_accounts (tenant_id, is_active);

-- ── Tenancy ────────────────────────────────────────────────────────────────
-- RLS, so a missing tenant filter in a query returns nothing rather than
-- another merchant's account. Every other tenant-scoped table in this schema
-- sets RLS; a settlement account is strictly more sensitive than most, because
-- it is a destination for money rather than a record of it.
ALTER TABLE dypos.bank_settlement_accounts ENABLE ROW LEVEL SECURITY;

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_policies
    WHERE tablename = 'bank_settlement_accounts'
      AND policyname = 'bank_settlement_tenant_isolation'
  ) THEN
    EXECUTE $pol$
      CREATE POLICY bank_settlement_tenant_isolation
        ON dypos.bank_settlement_accounts
        USING (
          tenant_id = current_setting('app.tenant_id', TRUE)
          OR current_setting('app.tenant_id', TRUE) IS NULL
            AND current_setting('role', TRUE) = 'service_role'
        )
      WITH CHECK (
        tenant_id = current_setting('app.tenant_id', TRUE)
        OR current_setting('app.tenant_id', TRUE) IS NULL
            AND current_setting('role', TRUE) = 'service_role'
      );
    $pol$;
  END IF;
END $$;

COMMENT ON COLUMN dypos.bank_settlement_accounts.iban IS
  'Settlement IBAN. TEXT, never a numeric type: IBANs are identifiers with '
  'check digits, and a numeric column silently drops leading zeros — turning '
  'one bank account into a different one.';

COMMENT ON TABLE dypos.bank_settlement_accounts IS
  'Per-tenant bank settlement accounts. Replaces an IBAN that was compiled into '
  'the front-end bundle and a default parameter argument, which routed every '
  'merchant takings to one account and was invisible to review.';