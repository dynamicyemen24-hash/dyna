-- ===========================================================================
-- v144 — Tenant ownership for the double-entry ledger, plus fixed assets
-- ===========================================================================
--
-- THE ISOLATION GAP
-- -----------------
-- `dypos.journal_entries` carries `tenant_id`. `dypos.ledger` — the table every
-- account balance is summed from — did not.
--
-- That makes the ledger the ONE table in the financial model whose rows belong
-- to no tenant. `SELECT ... FROM dypos.ledger` returns every entry on the system,
-- and an account balance computed from it is a system-wide balance. For a hosted
-- multi-tenant product this is not a bug in one feature; it is the accounting
-- being readable across customers.
--
-- It is also a limit of static analysis, not an oversight. O2 reports a MISSING
-- predicate on a tenant-owned table — it cannot report an absent COLUMN. There
-- is no `tenant_id` in the query, so there is nothing for the rule to find. This
-- migration is the answer to that boundary.
--
-- WHY BACKFILL IS SAFE
-- -------------------
-- The owner is derived from the journal entry, which already carries a tenant,
-- so the attribution is exact rather than inferred. Any line that cannot be
-- attributed makes the migration REFUSE, with a count — a financial record with
-- no owner is not data to adopt on a guess.
--
-- FIXED ASSETS
-- -----------
-- Nothing tracked a fixed asset. Depreciation affects the P&L and the balance
-- sheet, so an asset register is not optional for a business running a real
-- ledger: without one, the fixed-asset account can only be adjusted by hand and
-- every depreciation figure is an opinion.
--
-- `assets.finance_ledger_id` links each asset to the ledger line that recorded
-- it, so the register can be traced to the journal entry that created it rather
-- than existing as a standalone record that can disagree with the accounts.
-- ===========================================================================

-- ── 1. Ledger ownership ───────────────────────────────────────────────────
DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM information_schema.columns
    WHERE table_schema = 'dypos' AND table_name = 'ledger'
      AND column_name = 'tenant_id'
  ) THEN
    ALTER TABLE dypos.ledger ADD COLUMN tenant_id VARCHAR(64);
  END IF;
END $$;

-- Exact derivation from the parent journal entry.
UPDATE dypos.ledger l
   SET tenant_id = j.tenant_id
  FROM dypos.journal_entries j
 WHERE j.id = l.journal_id AND l.tenant_id IS NULL;

DO $$
DECLARE
  orphans BIGINT;
BEGIN
  SELECT count(*) INTO orphans FROM dypos.ledger WHERE tenant_id IS NULL;
  IF orphans > 0 THEN
    RAISE EXCEPTION
      'v144: % ledger rows have no derivable tenant. Refusing to guess an owner '
      'for a financial record — attribute them to a journal entry first.',
      orphans;
  END IF;
END $$;

ALTER TABLE dypos.ledger ALTER COLUMN tenant_id SET NOT NULL;

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
    WHERE conrelid = 'dypos.ledger'::regclass
      AND conname = 'ledger_tenant_id_fkey'
  ) THEN
    ALTER TABLE dypos.ledger
      ADD CONSTRAINT ledger_tenant_id_fkey
      FOREIGN KEY (tenant_id) REFERENCES dypos.tenants(id);
  END IF;
END $$;

-- Balances are always summed per tenant over a range, so this index is the
-- difference between an instant account-balance screen and a full ledger scan.
CREATE INDEX IF NOT EXISTS ledger_tenant_account_idx
  ON dypos.ledger (tenant_id, account_code);

COMMENT ON TABLE dypos.ledger IS
  'Double-entry ledger lines. TENANT-OWNED (added in v144) — every balance must '
  'be SUMmed within a tenant, never across tenants.';
-- ── 2. Fixed assets ───────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS dypos.assets (
  id                  VARCHAR(64) PRIMARY KEY,
  tenant_id           VARCHAR(64) NOT NULL REFERENCES dypos.tenants(id),
  branch_id           VARCHAR(64),
  asset_tag           VARCHAR(64) NOT NULL,
  name                VARCHAR(255) NOT NULL,
  category            VARCHAR(128) NOT NULL,
  acquisition_date    DATE NOT NULL,
  acquisition_cost    NUMERIC(14, 2) NOT NULL,
  salvage_value       NUMERIC(14, 2) NOT NULL DEFAULT 0,
  useful_life_months  INTEGER NOT NULL,
  /*
   * The method is RECORDED, not assumed, so the figure can be explained. It is
   * constrained rather than free text because a method the calculator does not
   * implement would silently produce no depreciation at all — the most expensive
   * kind of wrong answer, because it looks like a correct one.
   */
  depreciation_method VARCHAR(32) NOT NULL DEFAULT 'straight_line',
  accumulated_depreciation NUMERIC(14, 2) NOT NULL DEFAULT 0,
  status              VARCHAR(24) NOT NULL DEFAULT 'in_use',
  disposal_date       DATE,
  disposal_value      NUMERIC(14, 2),
  finance_ledger_id   VARCHAR(64) REFERENCES dypos.ledger(id),
  notes               TEXT,
  created_at          TIMESTAMP WITH TIME ZONE DEFAULT CURRENT_TIMESTAMP,
  updated_at          TIMESTAMP WITH TIME ZONE DEFAULT CURRENT_TIMESTAMP
);

-- An asset tag identifies a physical thing within a business; two assets sharing
-- one cannot be told apart on a floor walk.
CREATE UNIQUE INDEX IF NOT EXISTS assets_tenant_tag_uq
  ON dypos.assets (tenant_id, asset_tag);

CREATE INDEX IF NOT EXISTS assets_tenant_status_idx
  ON dypos.assets (tenant_id, status);

-- A cost of nothing, a life of zero months, or a salvage above the cost each
-- produce a depreciation figure that looks entirely plausible. Refused here.
ALTER TABLE dypos.assets
  DROP CONSTRAINT IF EXISTS assets_amounts_check;
ALTER TABLE dypos.assets
  ADD CONSTRAINT assets_amounts_check
  CHECK (
    acquisition_cost > 0
    AND salvage_value >= 0
    AND salvage_value <= acquisition_cost
    AND useful_life_months > 0
    AND accumulated_depreciation >= 0
    AND accumulated_depreciation <= acquisition_cost
    AND depreciation_method IN ('straight_line', 'declining_balance')
    AND status IN ('in_use', 'idle', 'disposed')
  );

-- A disposed asset has a disposal date; an in-use one does not. Stated as a
-- constraint so "disposed but undated" cannot exist and later be reported as an
-- asset still on the books.
ALTER TABLE dypos.assets
  DROP CONSTRAINT IF EXISTS assets_disposal_check;
ALTER TABLE dypos.assets
  ADD CONSTRAINT assets_disposal_check
  CHECK (
    (status = 'disposed' AND disposal_date IS NOT NULL)
    OR (status <> 'disposed' AND disposal_date IS NULL)
  );

COMMENT ON TABLE dypos.assets IS
  'Fixed assets. Net book value is COMPUTED from cost less accumulated '
  'depreciation — never stored — so it cannot drift from the components that '
  'produced it. finance_ledger_id ties each asset to the ledger entry that '
  'recorded it.';