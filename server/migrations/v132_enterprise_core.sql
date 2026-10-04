-- ===========================================================================
-- v132 — Enterprise Core: Multi-Currency, Units of Measure, RBAC
-- Design targets: SAP FI/CO (document currency + transaction currency +
-- group currency), Oracle Fusion (legal entities, UoM conversions), and
-- Microsoft Dynamics 365 (role-based security with duty separation).
-- ===========================================================================

-- ---------------------------------------------------------------------------
-- 1. MULTI-CURRENCY
-- Following SAP: every monetary document stores THREE amounts —
--   * transaction currency = the currency the document was written in
--   * local currency       = the legal entity's functional currency
--   * group currency       = the consolidation currency for reporting
-- Rates are stored historically so a document never silently revalues.
-- ---------------------------------------------------------------------------

ALTER TABLE dypos.currencies
  ADD COLUMN IF NOT EXISTS decimals     SMALLINT NOT NULL DEFAULT 2,
  ADD COLUMN IF NOT EXISTS is_base      BOOLEAN  NOT NULL DEFAULT FALSE,
  ADD COLUMN IF NOT EXISTS country_code VARCHAR(4),
  ADD COLUMN IF NOT EXISTS updated_by   VARCHAR(64);

-- Historical rate table with validity windows (Oracle-style effective dating).
CREATE TABLE IF NOT EXISTS dypos.currency_rates (
  id            TEXT PRIMARY KEY,
  tenant_id     VARCHAR(64) NOT NULL,
  from_currency VARCHAR(3)  NOT NULL,
  to_currency   VARCHAR(3)  NOT NULL,
  rate          NUMERIC(20,10) NOT NULL CHECK (rate > 0),
  rate_type     VARCHAR(16) NOT NULL DEFAULT 'manual'
                CHECK (rate_type IN ('manual','bank','ecb','customs','derived')),
  valid_from    TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  valid_to      TIMESTAMPTZ,
  source        VARCHAR(64),
  created_by    VARCHAR(64),
  created_at    TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  CONSTRAINT rate_pair_unique UNIQUE (tenant_id, from_currency, to_currency, valid_from)
);

CREATE INDEX IF NOT EXISTS idx_currency_rates_pair
  ON dypos.currency_rates (tenant_id, from_currency, to_currency, valid_from DESC);

ALTER TABLE dypos.invoices
  ADD COLUMN IF NOT EXISTS currency_code VARCHAR(3) NOT NULL DEFAULT 'SAR',
  ADD COLUMN IF NOT EXISTS base_total    NUMERIC(18,2),
  ADD COLUMN IF NOT EXISTS base_subtotal NUMERIC(18,2),
  ADD COLUMN IF NOT EXISTS base_tax      NUMERIC(18,2),
  ADD COLUMN IF NOT EXISTS fx_rate       NUMERIC(20,10) NOT NULL DEFAULT 1,
  ADD COLUMN IF NOT EXISTS fx_rate_id    VARCHAR(64);

ALTER TABLE dypos.purchase_orders
  ADD COLUMN IF NOT EXISTS currency_code VARCHAR(3) NOT NULL DEFAULT 'SAR',
  ADD COLUMN IF NOT EXISTS base_total    NUMERIC(18,2);

ALTER TABLE dypos.chart_of_accounts
  ADD COLUMN IF NOT EXISTS currency_code VARCHAR(3) NOT NULL DEFAULT 'SAR';

-- ---------------------------------------------------------------------------
-- 2. UNITS OF MEASURE
-- ISO 80000 style: a dimension groups units that measure the same thing.
-- Conversions are explicit factors — never guessed from unit names.
-- ---------------------------------------------------------------------------

CREATE TABLE IF NOT EXISTS dypos.units_of_measure (
  id           TEXT PRIMARY KEY,
  tenant_id    VARCHAR(64) NOT NULL,
  code         VARCHAR(16) NOT NULL,          -- EA, KG, L, M, BOX, PALLET
  name         VARCHAR(64) NOT NULL,
  dimension    VARCHAR(32) NOT NULL,          -- COUNT / WEIGHT / VOLUME / LENGTH
  base_unit_id VARCHAR(64),                    -- self-reference for base unit
  precision    SMALLINT NOT NULL DEFAULT 2,    -- decimal places for this UoM
  rounding     SMALLINT NOT NULL DEFAULT 0,
  is_active    BOOLEAN NOT NULL DEFAULT TRUE,
  UNIQUE (tenant_id, code)
);

CREATE TABLE IF NOT EXISTS dypos.uom_conversions (
  id           TEXT PRIMARY KEY,
  tenant_id    VARCHAR(64) NOT NULL,
  from_unit_id VARCHAR(64) NOT NULL REFERENCES dypos.units_of_measure(id),
  to_unit_id   VARCHAR(64) NOT NULL REFERENCES dypos.units_of_measure(id),
  numerator    NUMERIC(20,10) NOT NULL DEFAULT 1,
  denominator  NUMERIC(20,10) NOT NULL DEFAULT 1,
  UNIQUE (tenant_id, from_unit_id, to_unit_id),
  CONSTRAINT no_self_conversion CHECK (from_unit_id <> to_unit_id)
);

CREATE INDEX IF NOT EXISTS idx_uom_dim ON dypos.units_of_measure (tenant_id, dimension);

-- Products carry the unit they are stocked in and the one they are priced in.
ALTER TABLE dypos.products
  ADD COLUMN IF NOT EXISTS base_uom_id     VARCHAR(64),
  ADD COLUMN IF NOT EXISTS purchase_uom_id VARCHAR(64),
  ADD COLUMN IF NOT EXISTS sales_uom_id     VARCHAR(64),
  ADD COLUMN IF NOT EXISTS weight_kg        NUMERIC(18,6),
  ADD COLUMN IF NOT EXISTS volume_l         NUMERIC(18,6);

-- Stock moves record both the transacted UoM and the normalised base quantity,
-- so stock is never summed across incompatible units.
ALTER TABLE dypos.stock_movements
  ADD COLUMN IF NOT EXISTS uom_id        VARCHAR(64),
  ADD COLUMN IF NOT EXISTS quantity_base NUMERIC(18,6),
  ADD COLUMN IF NOT EXISTS base_uom_id   VARCHAR(64);

-- ---------------------------------------------------------------------------
-- 3. ROLE-BASED ACCESS CONTROL
-- Dynamics-style: users hold roles, roles grant permissions, and a user can
-- hold several roles whose grants are unioned. A deny grant always beats an
-- allow grant, which is how Dynamics resolves conflicting combinations.
-- ---------------------------------------------------------------------------

CREATE TABLE IF NOT EXISTS dypos.roles (
  id          TEXT PRIMARY KEY,
  tenant_id   VARCHAR(64) NOT NULL,
  code        VARCHAR(48) NOT NULL,
  name        VARCHAR(96) NOT NULL,
  description TEXT,
  is_system   BOOLEAN NOT NULL DEFAULT FALSE,  -- cannot be deleted, only cloned
  sod_group   VARCHAR(32),                      -- SoD: these roles may not combine
  is_active   BOOLEAN NOT NULL DEFAULT TRUE,
  created_at  TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  UNIQUE (tenant_id, code)
);

CREATE TABLE IF NOT EXISTS dypos.role_permissions (
  role_id    VARCHAR(64) NOT NULL REFERENCES dypos.roles(id) ON DELETE CASCADE,
  permission VARCHAR(64) NOT NULL,
  effect     VARCHAR(8) NOT NULL DEFAULT 'allow' CHECK (effect IN ('allow','deny')),
  PRIMARY KEY (role_id, permission)
);

CREATE TABLE IF NOT EXISTS dypos.user_roles (
  user_id    VARCHAR(64) NOT NULL REFERENCES dypos.users(id) ON DELETE CASCADE,
  role_id    VARCHAR(64) NOT NULL REFERENCES dypos.roles(id) ON DELETE CASCADE,
  branch_id  VARCHAR(64),            -- null = role applies tenant-wide
  granted_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  PRIMARY KEY (user_id, role_id)
);

-- Branch-scoped data access: which branches a user may see.
CREATE TABLE IF NOT EXISTS dypos.user_branch_access (
  user_id   VARCHAR(64) NOT NULL REFERENCES dypos.users(id) ON DELETE CASCADE,
  branch_id VARCHAR(64) NOT NULL,
  PRIMARY KEY (user_id, branch_id)
);

CREATE INDEX IF NOT EXISTS idx_user_roles_user    ON dypos.user_roles (user_id);
CREATE INDEX IF NOT EXISTS idx_rbac_branch_access ON dypos.user_branch_access (user_id, branch_id);

-- ---------------------------------------------------------------------------
-- 4. PERIOD / LEDGER LOCKING
-- SAP FI closes a posting period; once closed, documents in it cannot change.
-- ---------------------------------------------------------------------------

CREATE TABLE IF NOT EXISTS dypos.accounting_periods (
  id        TEXT PRIMARY KEY,
  tenant_id VARCHAR(64) NOT NULL,
  branch_id VARCHAR(64),
  period    VARCHAR(7) NOT NULL,        -- YYYY-MM
  status    VARCHAR(16) NOT NULL DEFAULT 'open'
            CHECK (status IN ('open','closing','closed')),
  closed_at TIMESTAMPTZ,
  closed_by VARCHAR(64),
  UNIQUE (tenant_id, branch_id, period)
);