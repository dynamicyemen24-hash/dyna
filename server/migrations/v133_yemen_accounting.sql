-- ===========================================================================
-- v133 — Yemen Dual-Authority Zones + Accountant Workbench
--
-- Yemen is not a single-currency economy. Two monetary authorities issue
-- money inside the same country:
--   * Sana'a / northern zone — Central Bank of Yemen (CBY), YER
--   * Aden  / southern zone — a separate issuer whose nominal currency trades
--                            at a materially different rate for the same unit.
--
-- The rate gap between the zones is not a rounding artefact. It is a real,
-- persistent, priced difference, so this schema records it as a first-class
-- economic object and lets the ledger post the differential instead of hiding
-- it inside a rounded sale price.
-- ===========================================================================

-- ---------------------------------------------------------------------------
-- 1. ZONES AND ISSUERS
-- ---------------------------------------------------------------------------

CREATE TABLE IF NOT EXISTS dypos.zones (
  id           TEXT PRIMARY KEY,
  tenant_id    VARCHAR(64) NOT NULL,
  code         VARCHAR(16) NOT NULL,        -- SANAA, ADEN
  name         VARCHAR(96) NOT NULL,
  country_code VARCHAR(2) NOT NULL DEFAULT 'YE',
  issuer       VARCHAR(96) NOT NULL,        -- the authority actually issuing
  vat_rate     NUMERIC(5,2) NOT NULL DEFAULT 5.00,
  is_active    BOOLEAN NOT NULL DEFAULT TRUE,
  UNIQUE (tenant_id, code)
);

-- ---------------------------------------------------------------------------
-- 2. ISSUER CURRENCIES
-- A currency belongs to an issuer, not to a country. The same nominal can exist
-- under two issuers at different rates, which is exactly the Yemeni case.
-- ---------------------------------------------------------------------------

CREATE TABLE IF NOT EXISTS dypos.issuer_currencies (
  id         TEXT PRIMARY KEY,
  tenant_id  VARCHAR(64) NOT NULL,
  issuer     VARCHAR(96) NOT NULL,         -- 'CBY' | 'CBA' | 'CBY-PRE2014'
  code       VARCHAR(8)  NOT NULL,         -- YER | YDD | SAR | USD
  name       VARCHAR(96) NOT NULL,
  symbol     VARCHAR(16) NOT NULL,
  decimals   SMALLINT NOT NULL DEFAULT 0, -- YER has no minor unit in practice
  -- Value of one unit in USD, per issuer.
  usd_rate   NUMERIC(20,10) NOT NULL CHECK (usd_rate > 0),
  -- Premium/discount against the reference issuer, as a fraction.
  -- 0 = at par; positive = the zone currency trades above the reference.
  parity_pct NUMERIC(10,4) NOT NULL DEFAULT 0,
  is_active  BOOLEAN NOT NULL DEFAULT TRUE,
  UNIQUE (tenant_id, issuer, code)
);

-- ---------------------------------------------------------------------------
-- 3. ZONE RATES — the differential is stored, never re-derived at read time
-- ---------------------------------------------------------------------------

CREATE TABLE IF NOT EXISTS dypos.zone_rates (
  id          TEXT PRIMARY KEY,
  tenant_id   VARCHAR(64) NOT NULL,
  from_issuer VARCHAR(96) NOT NULL,
  to_issuer   VARCHAR(96) NOT NULL,
  rate        NUMERIC(20,10) NOT NULL CHECK (rate > 0),
  rate_type   VARCHAR(16) NOT NULL DEFAULT 'manual'
              CHECK (rate_type IN ('manual','bank','market','official','derived')),
  spread_bps  NUMERIC(8,4) NOT NULL DEFAULT 0,   -- bid/ask in basis points
  valid_from  TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  valid_to    TIMESTAMPTZ,
  source      VARCHAR(96),
  created_by  VARCHAR(64),
  created_at  TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_zone_rates_pair
  ON dypos.zone_rates (tenant_id, from_issuer, to_issuer, valid_from DESC);

-- ---------------------------------------------------------------------------
-- 4. SETTLEMENT ACCOUNTS BY ZONE
-- Cash collected in one zone cannot settle an obligation in the other without
-- a conversion, so each zone keeps its own cash and bank position.
-- ---------------------------------------------------------------------------

CREATE TABLE IF NOT EXISTS dypos.zone_accounts (
  id            TEXT PRIMARY KEY,
  tenant_id     VARCHAR(64) NOT NULL,
  zone_id       VARCHAR(64) NOT NULL REFERENCES dypos.zones(id),
  branch_id     VARCHAR(64),
  account_code  VARCHAR(32) NOT NULL,
  account_name  VARCHAR(96) NOT NULL,
  account_type  VARCHAR(24) NOT NULL
                CHECK (account_type IN ('cash','bank','wallet','receivable','payable')),
  currency_code VARCHAR(8) NOT NULL,
  issuer        VARCHAR(96) NOT NULL,
  is_active     BOOLEAN NOT NULL DEFAULT TRUE,
  UNIQUE (tenant_id, zone_id, account_type, currency_code)
);

-- ---------------------------------------------------------------------------
-- 5. RETURNS AND CREDIT NOTES
-- A return is a document, not a deletion. It captures its own FX rate, so a
-- refund issued weeks later returns value at the refund-date rate rather than
-- silently restating the original sale.
-- ---------------------------------------------------------------------------

CREATE TABLE IF NOT EXISTS dypos.returns (
  id                  TEXT PRIMARY KEY,
  tenant_id           VARCHAR(64) NOT NULL,
  branch_id           VARCHAR(64),
  number              VARCHAR(48) NOT NULL,
  original_invoice_id VARCHAR(64),
  customer_id         VARCHAR(64),
  type                VARCHAR(16) NOT NULL DEFAULT 'sale'
                      CHECK (type IN ('sale','purchase')),
  status              VARCHAR(16) NOT NULL DEFAULT 'draft'
                      CHECK (status IN ('draft','approved','settled','void')),
  reason_code         VARCHAR(32),
  reason_note         TEXT,
  qty_base            NUMERIC(18,6) NOT NULL DEFAULT 0,
  restock             BOOLEAN NOT NULL DEFAULT TRUE,
  gross_amount        NUMERIC(18,2) NOT NULL DEFAULT 0,
  tax_amount          NUMERIC(18,2) NOT NULL DEFAULT 0,
  net_amount          NUMERIC(18,2) NOT NULL DEFAULT 0,
  transaction_currency VARCHAR(8) NOT NULL DEFAULT 'YER',
  transaction_issuer   VARCHAR(96),
  fx_rate             NUMERIC(20,10) NOT NULL DEFAULT 1,
  base_amount         NUMERIC(18,2) NOT NULL DEFAULT 0,
  base_currency       VARCHAR(8) NOT NULL DEFAULT 'SAR',
  zone_id             VARCHAR(64),
  approved_by         VARCHAR(64),
  approved_at         TIMESTAMPTZ,
  settled_by          VARCHAR(64),
  settled_at          TIMESTAMPTZ,
  created_by          VARCHAR(64),
  created_at          TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  UNIQUE (tenant_id, number)
);

CREATE TABLE IF NOT EXISTS dypos.return_lines (
  id           TEXT PRIMARY KEY,
  tenant_id    VARCHAR(64) NOT NULL,
  return_id    VARCHAR(64) NOT NULL REFERENCES dypos.returns(id) ON DELETE CASCADE,
  product_id   VARCHAR(64),
  product_name VARCHAR(128),
  qty_base     NUMERIC(18,6) NOT NULL DEFAULT 0,
  unit_cost    NUMERIC(18,6) NOT NULL DEFAULT 0,
  unit_price   NUMERIC(18,2) NOT NULL DEFAULT 0,
  tax_rate     NUMERIC(5,2) NOT NULL DEFAULT 0,
  gross_amount NUMERIC(18,2) NOT NULL DEFAULT 0,
  tax_amount   NUMERIC(18,2) NOT NULL DEFAULT 0,
  net_amount   NUMERIC(18,2) NOT NULL DEFAULT 0,
  restock      BOOLEAN NOT NULL DEFAULT TRUE
);

CREATE INDEX IF NOT EXISTS idx_returns_invoice ON dypos.returns (original_invoice_id);

-- ---------------------------------------------------------------------------
-- 6. STOCK SETTLEMENT / CYCLE COUNT
-- A settlement is counted quantity versus system quantity, with the variance
-- costed at moving average so the ledger impact is auditable line by line.
-- ---------------------------------------------------------------------------

CREATE TABLE IF NOT EXISTS dypos.stock_settlements (
  id                    TEXT PRIMARY KEY,
  tenant_id             VARCHAR(64) NOT NULL,
  branch_id             VARCHAR(64),
  warehouse_id          VARCHAR(64),
  number                VARCHAR(48) NOT NULL,
  status                VARCHAR(16) NOT NULL DEFAULT 'open'
                        CHECK (status IN ('open','counted','reviewed','posted','cancelled')),
  method                VARCHAR(16) NOT NULL DEFAULT 'cycle'
                        CHECK (method IN ('cycle','full','spot')),
  scope                 VARCHAR(24) NOT NULL DEFAULT 'category'
                        CHECK (scope IN ('category','location','sku','supplier')),
  scope_value           VARCHAR(64),
  counted_by            VARCHAR(64),
  counted_at            TIMESTAMPTZ,
  reviewed_by           VARCHAR(64),
  reviewed_at           TIMESTAMPTZ,
  posted_by             VARCHAR(64),
  posted_at             TIMESTAMPTZ,
  variance_value        NUMERIC(18,2) NOT NULL DEFAULT 0,  -- positive = shrinkage
  shrink_value          NUMERIC(18,2) NOT NULL DEFAULT 0,
  surplus_value         NUMERIC(18,2) NOT NULL DEFAULT 0,
  counted_variance_pct  NUMERIC(8,4) NOT NULL DEFAULT 0,
  created_at            TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  UNIQUE (tenant_id, number)
);

CREATE TABLE IF NOT EXISTS dypos.stock_settlement_lines (
  id             TEXT PRIMARY KEY,
  tenant_id      VARCHAR(64) NOT NULL,
  settlement_id  VARCHAR(64) NOT NULL REFERENCES dypos.stock_settlements(id) ON DELETE CASCADE,
  product_id     VARCHAR(64) NOT NULL,
  system_qty     NUMERIC(18,6) NOT NULL DEFAULT 0,
  counted_qty    NUMERIC(18,6) NOT NULL DEFAULT 0,
  variance_qty   NUMERIC(18,6) NOT NULL DEFAULT 0,
  unit_cost      NUMERIC(18,6) NOT NULL DEFAULT 0,
  variance_value NUMERIC(18,2) NOT NULL DEFAULT 0,
  uom_id         VARCHAR(64),
  reason_code    VARCHAR(32),
  note           TEXT
);

CREATE INDEX IF NOT EXISTS idx_settlement_lines ON dypos.stock_settlement_lines (settlement_id);

-- ---------------------------------------------------------------------------
-- 7. COMMISSION PLANS — progressive tiers, not one flat percentage
-- A flat rate on the whole amount pays a salesperson for the part of the
-- target they never reached. Tiers pay each band at its own rate.
-- ---------------------------------------------------------------------------

CREATE TABLE IF NOT EXISTS dypos.commission_plans (
  id            TEXT PRIMARY KEY,
  tenant_id     VARCHAR(64) NOT NULL,
  code          VARCHAR(32) NOT NULL,
  name          VARCHAR(96) NOT NULL,
  scope         VARCHAR(16) NOT NULL DEFAULT 'sales'
                CHECK (scope IN ('sales','category','product','service')),
  scope_value   VARCHAR(64),
  period_type   VARCHAR(16) NOT NULL DEFAULT 'monthly'
                CHECK (period_type IN ('monthly','quarterly','annual')),
  currency_code VARCHAR(8) NOT NULL DEFAULT 'YER',
  is_active     BOOLEAN NOT NULL DEFAULT TRUE,
  UNIQUE (tenant_id, code)
);

CREATE TABLE IF NOT EXISTS dypos.commission_tiers (
  id          TEXT PRIMARY KEY,
  plan_id     VARCHAR(64) NOT NULL REFERENCES dypos.commission_plans(id) ON DELETE CASCADE,
  from_amount NUMERIC(18,2) NOT NULL,
  to_amount   NUMERIC(18,2),
  rate_pct    NUMERIC(7,4) NOT NULL CHECK (rate_pct >= 0),
  UNIQUE (plan_id, from_amount)
);

CREATE TABLE IF NOT EXISTS dypos.commission_accruals (
  id             TEXT PRIMARY KEY,
  tenant_id      VARCHAR(64) NOT NULL,
  employee_id    VARCHAR(64) NOT NULL,
  plan_id        VARCHAR(64) NOT NULL,
  period         VARCHAR(7) NOT NULL,           -- YYYY-MM
  base_amount    NUMERIC(18,2) NOT NULL DEFAULT 0,
  effective_rate NUMERIC(7,4) NOT NULL DEFAULT 0,  -- blended rate after tiers
  amount         NUMERIC(18,2) NOT NULL DEFAULT 0,
  currency_code  VARCHAR(8) NOT NULL DEFAULT 'YER',
  zone_id        VARCHAR(64),
  status         VARCHAR(16) NOT NULL DEFAULT 'accrued'
                 CHECK (status IN ('accrued','approved','paid','reversed')),
  approved_by    VARCHAR(64),
  paid_at        TIMESTAMPTZ,
  UNIQUE (tenant_id, employee_id, plan_id, period)
);

-- ---------------------------------------------------------------------------
-- 8. BONUSES — measured against a declared target, not paid at random
-- ---------------------------------------------------------------------------

CREATE TABLE IF NOT EXISTS dypos.bonus_plans (
  id            TEXT PRIMARY KEY,
  tenant_id     VARCHAR(64) NOT NULL,
  code          VARCHAR(32) NOT NULL,
  name          VARCHAR(96) NOT NULL,
  metric        VARCHAR(32) NOT NULL
                CHECK (metric IN ('sales_target','margin','new_customers','collections','items_sold')),
  target_value  NUMERIC(18,2) NOT NULL,
  reward_type   VARCHAR(16) NOT NULL DEFAULT 'fixed'
                CHECK (reward_type IN ('fixed','percent','per_unit')),
  reward_value  NUMERIC(18,2) NOT NULL,
  currency_code VARCHAR(8) NOT NULL DEFAULT 'YER',
  period_type   VARCHAR(16) NOT NULL DEFAULT 'monthly',
  zone_id       VARCHAR(64),
  is_active     BOOLEAN NOT NULL DEFAULT TRUE,
  UNIQUE (tenant_id, code)
);

CREATE TABLE IF NOT EXISTS dypos.bonus_accruals (
  id             TEXT PRIMARY KEY,
  tenant_id      VARCHAR(64) NOT NULL,
  plan_id        VARCHAR(64) NOT NULL REFERENCES dypos.bonus_plans(id) ON DELETE CASCADE,
  employee_id    VARCHAR(64) NOT NULL,
  period         VARCHAR(7) NOT NULL,
  achieved       NUMERIC(18,2) NOT NULL DEFAULT 0,
  attainment_pct NUMERIC(8,4) NOT NULL DEFAULT 0,
  amount         NUMERIC(18,2) NOT NULL DEFAULT 0,
  currency_code  VARCHAR(8) NOT NULL DEFAULT 'YER',
  status         VARCHAR(16) NOT NULL DEFAULT 'accrued',
  paid_at        TIMESTAMPTZ,
  UNIQUE (tenant_id, plan_id, employee_id, period)
);

-- ---------------------------------------------------------------------------
-- 9. OFFER RULES — real mechanics, not a flat discount field
-- The existing promotions table stores a bare (type, value) pair, which cannot
-- express "buy 3 pay for 2" or a discount that scales with the basket size.
-- Each rule carries typed operands instead of overloading one column.
-- ---------------------------------------------------------------------------

CREATE TABLE IF NOT EXISTS dypos.offer_rules (
  id            TEXT PRIMARY KEY,
  tenant_id     VARCHAR(64) NOT NULL,
  code          VARCHAR(32) NOT NULL,
  name          VARCHAR(96) NOT NULL,
  rule_type     VARCHAR(24) NOT NULL
                CHECK (rule_type IN (
                  'percent_off',      -- operand_a % off the qualifying amount
                  'amount_off',       -- operand_a flat amount off
                  'buy_x_get_y',      -- operand_a bought, operand_b free
                  'bundle_price',     -- operand_a price for the bundle
                  'threshold_tier',   -- spend operand_a -> discount operand_b %
                  'free_shipping'
                )),
  operand_a     NUMERIC(18,4) NOT NULL DEFAULT 0,
  operand_b     NUMERIC(18,4) NOT NULL DEFAULT 0,
  min_qty       NUMERIC(18,4) NOT NULL DEFAULT 0,
  min_amount    NUMERIC(18,2) NOT NULL DEFAULT 0,
  max_discount  NUMERIC(18,2),               -- cap; NULL = uncapped
  applies_to    VARCHAR(16) NOT NULL DEFAULT 'order'
                CHECK (applies_to IN ('order','line','category','product')),
  applies_value VARCHAR(64),
  stackable     BOOLEAN NOT NULL DEFAULT FALSE,
  priority      SMALLINT NOT NULL DEFAULT 100,   -- lower runs first
  start_date    DATE NOT NULL DEFAULT CURRENT_DATE,
  end_date      DATE,
  is_active     BOOLEAN NOT NULL DEFAULT TRUE,
  UNIQUE (tenant_id, code)
);

CREATE TABLE IF NOT EXISTS dypos.offer_products (
  id         TEXT PRIMARY KEY,
  tenant_id  VARCHAR(64) NOT NULL,
  offer_id   VARCHAR(64) NOT NULL REFERENCES dypos.offer_rules(id) ON DELETE CASCADE,
  product_id VARCHAR(64) NOT NULL,
  qty        NUMERIC(18,4) NOT NULL DEFAULT 1,
  UNIQUE (offer_id, product_id)
);

-- ---------------------------------------------------------------------------
-- 10. FX DIFFERENTIAL LEDGER
-- When a payment crosses zones, the gap between the booking rate and the
-- settlement rate is a real gain or loss. It gets its own posting bucket so it
-- never disappears into revenue or expense.
-- ---------------------------------------------------------------------------

CREATE TABLE IF NOT EXISTS dypos.fx_differentials (
  id                TEXT PRIMARY KEY,
  tenant_id         VARCHAR(64) NOT NULL,
  document_type     VARCHAR(24) NOT NULL,   -- invoice | return | settlement | payout
  document_id       VARCHAR(64) NOT NULL,
  from_zone         VARCHAR(64) NOT NULL,
  to_zone           VARCHAR(64) NOT NULL,
  from_issuer       VARCHAR(96) NOT NULL,
  to_issuer         VARCHAR(96) NOT NULL,
  from_amount       NUMERIC(18,2) NOT NULL,
  to_amount         NUMERIC(18,2) NOT NULL,
  booking_rate      NUMERIC(20,10) NOT NULL,
  settlement_rate   NUMERIC(20,10) NOT NULL,
  base_amount       NUMERIC(18,2) NOT NULL DEFAULT 0,
  differential      NUMERIC(18,2) NOT NULL DEFAULT 0,   -- + gain, - loss
  direction         VARCHAR(8) NOT NULL DEFAULT 'gain'
                    CHECK (direction IN ('gain','loss')),
  posted_to_account VARCHAR(32),
  created_at        TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_fx_diff_doc ON dypos.fx_differentials (document_id);