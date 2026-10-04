-- ===========================================================================
-- v137 — Detailed Financial Statements (P&L and Cash Flow)
--
-- Why this migration exists
-- ------------------------
-- The transactional tables could answer "how much did we sell" and nothing
-- else. `dypos.expenses` and `dypos.purchase_orders` existed but were never
-- written to, and `dypos.ledger` / `dypos.journal_entries` were empty, so a
-- profit-and-loss statement built on them would report a net profit exactly
-- equal to gross profit — arithmetically true and operationally worthless.
--
-- Design principles, matching the rest of the engine:
--
--   1. OPERATING flows are DERIVED, never stored. Cash in and cash out of
--      trading come from `invoices`, `expenses` and `purchase_orders`, which
--      are already the authoritative record. A second copy of them would drift
--      and then disagree with the POS.
--
--   2. `cash_movements` therefore holds ONLY the flows that no transactional
--      table can know about: capital expenditure, loans, owner draws, other
--      income. A CHECK constraint refuses 'operating' so a double count is
--      impossible at the storage layer rather than a bug waiting to be found
--      in a meeting.
--
--   3. A PUBLISHED statement is immutable. Once a period is reported and
--      locked, re-running the query must not silently rewrite last month's
--      numbers; the snapshot in `financial_statements` is the record of what
--      was actually presented, and it is append-only.
--
--   4. Every file here is idempotent (CREATE ... IF NOT EXISTS, ADD COLUMN IF
--      NOT EXISTS) so `npm run migrate` is safe to repeat.
-- ===========================================================================

-- ---------------------------------------------------------------------------
-- 1. CASH MOVEMENTS — the non-trading cash flows
--
-- Money that moves without an invoice: buying a machine, taking a loan,
-- drawing owner capital, recording an asset sale. Without this table a cash
-- flow statement can only ever describe trading, which is a false statement
-- of the business rather than a narrow one.
-- ---------------------------------------------------------------------------

CREATE TABLE IF NOT EXISTS dypos.cash_movements (
  id              VARCHAR(64) PRIMARY KEY DEFAULT gen_random_uuid()::text,
  tenant_id       VARCHAR(64) NOT NULL REFERENCES dypos.tenants(id),
  branch_id       VARCHAR(64) REFERENCES dypos.branches(id),

  -- 'in' adds cash, 'out' removes it. Separate from the sign of the amount so
  -- a stored amount is never negative and SUM() needs no CASE gymnastics.
  direction       VARCHAR(8)  NOT NULL CHECK (direction IN ('in','out')),

  -- 'operating' is deliberately absent: operating flows are derived from the
  -- transactional tables, and permitting it here would let the same cash be
  -- counted twice with nothing to catch it.
  section         VARCHAR(16) NOT NULL
                  CHECK (section IN ('investing','financing','other')),

  category        VARCHAR(128) NOT NULL,
  amount          NUMERIC(18,2) NOT NULL CHECK (amount > 0),

  occurred_on     DATE NOT NULL DEFAULT CURRENT_DATE,
  payment_method  VARCHAR(64) DEFAULT 'cash',
  reference       VARCHAR(128),          -- PO, cheque or invoice number
  description     TEXT,
  created_by      VARCHAR(64),
  created_at      TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

-- The cash flow query always filters a date window and orders by it; without
-- this index a year of history is a sequential scan on every dashboard load.
CREATE INDEX IF NOT EXISTS idx_cash_movements_date
  ON dypos.cash_movements (tenant_id, occurred_on DESC);

CREATE INDEX IF NOT EXISTS idx_cash_movements_branch_date
  ON dypos.cash_movements (tenant_id, branch_id, occurred_on DESC);

-- 'other' flows feed the P&L as non-operating income/expense; indexing the
-- section keeps that lookup off a full scan.
CREATE INDEX IF NOT EXISTS idx_cash_movements_section
  ON dypos.cash_movements (tenant_id, section, occurred_on DESC);

-- ---------------------------------------------------------------------------
-- 2. REPORTING INDEXES
--
-- `expenses` and `purchase_orders` were created without a single index, so the
-- monthly aggregation had no usable access path at all.
-- ---------------------------------------------------------------------------

CREATE INDEX IF NOT EXISTS idx_expenses_tenant_date
  ON dypos.expenses (tenant_id, expense_date DESC);

CREATE INDEX IF NOT EXISTS idx_expenses_branch_date
  ON dypos.expenses (tenant_id, branch_id, expense_date DESC);

CREATE INDEX IF NOT EXISTS idx_expenses_category
  ON dypos.expenses (tenant_id, category, expense_date DESC);

CREATE INDEX IF NOT EXISTS idx_purchase_orders_tenant_date
  ON dypos.purchase_orders (tenant_id, ordered_at DESC);

CREATE INDEX IF NOT EXISTS idx_purchase_orders_branch_date
  ON dypos.purchase_orders (tenant_id, branch_id, ordered_at DESC);

-- Cost of sales is rebuilt from the JSONB line items on every request, which
-- cannot use an index. This index only narrows the invoice side of that join.
CREATE INDEX IF NOT EXISTS idx_invoices_tenant_created
  ON dypos.invoices (tenant_id, created_at DESC);

-- ---------------------------------------------------------------------------
-- 3. PUBLISHED STATEMENTS — the append-only record of what was reported
--
-- A live query can always be re-run, so it cannot answer "what did we tell
-- the bank last month?". A published snapshot can, and it never mutates: a
-- correction is a NEW row with a new `version`, not an UPDATE.
-- ---------------------------------------------------------------------------

CREATE TABLE IF NOT EXISTS dypos.financial_statements (
  id              VARCHAR(64) PRIMARY KEY DEFAULT gen_random_uuid()::text,
  tenant_id       VARCHAR(64) NOT NULL REFERENCES dypos.tenants(id),
  branch_id       VARCHAR(64),

  -- 'YYYY-MM'. Only monthly statements are published: a statement is a legal
  -- artefact, and a week is a report, not an artefact.
  period          VARCHAR(7)  NOT NULL,
  version         SMALLINT    NOT NULL DEFAULT 1,

  -- 'pnl' | 'cashflow'. Both are published separately because a P&L can be
  -- finalised before the bank reconciliation that closes the cash flow.
  statement_type  VARCHAR(16) NOT NULL CHECK (statement_type IN ('pnl','cashflow')),

  currency_code   VARCHAR(8) NOT NULL DEFAULT 'SAR',
  status          VARCHAR(16) NOT NULL DEFAULT 'published'
                  CHECK (status IN ('draft','published','superseded')),

  -- The headline figures as computed AT PUBLISH TIME, so a reader comparing
  -- snapshots can see at a glance which version they are looking at.
  total_revenue   NUMERIC(18,2),
  total_cogs      NUMERIC(18,2),
  total_expenses  NUMERIC(18,2),
  net_result      NUMERIC(18,2),
  opening_cash    NUMERIC(18,2),
  closing_cash    NUMERIC(18,2),

  -- Set when COGS could not be fully attributed to a cost. A statement whose
  -- margin is knowingly incomplete is still publishable — but it must carry
  -- this flag rather than presenting an over-stated profit as final.
  cogs_complete   BOOLEAN NOT NULL DEFAULT TRUE,
  data_notes      TEXT,

  generated_by    VARCHAR(64),
  generated_at    TIMESTAMPTZ NOT NULL DEFAULT NOW(),

  UNIQUE (tenant_id, branch_id, period, version, statement_type)
);

-- Postgres treats NULLs as distinct in a plain unique index, so a tenant-wide
-- (NULL branch) statement could be published twice. COALESCE folds the null
-- into a sentinel so the natural key is genuinely unique.
CREATE UNIQUE INDEX IF NOT EXISTS uq_financial_statement_natural
  ON dypos.financial_statements (
    tenant_id, COALESCE(branch_id, '__all__'), period, version, statement_type
  );

CREATE INDEX IF NOT EXISTS idx_financial_statements_period
  ON dypos.financial_statements (tenant_id, period DESC, statement_type);

-- ---------------------------------------------------------------------------
-- 4. EXPENSE CATEGORY MAPPING
--
-- `dypos.expenses.category` is free text typed by an operator ("Rent",
-- "rent", "إيجار"). Grouping by it directly produces a report with the same
-- cost split three ways and none of the headings a reader recognises. The
-- mapping is data, not code, so finance can reclassify without a deploy.
-- ---------------------------------------------------------------------------

CREATE TABLE IF NOT EXISTS dypos.expense_category_map (
  id            VARCHAR(64) PRIMARY KEY DEFAULT gen_random_uuid()::text,
  tenant_id     VARCHAR(64) NOT NULL REFERENCES dypos.tenants(id),
  -- Lower-cased source text, matched with a case-insensitive comparison.
  source_label  VARCHAR(128) NOT NULL,
  -- The reporting group this rolls up into.
  bucket        VARCHAR(64) NOT NULL CHECK (bucket IN (
                  'cost_of_sales','payroll','rent','utilities',
                  'marketing','logistics','maintenance',
                  'professional_fees','bank_charges','other'
                )),
  is_active     BOOLEAN NOT NULL DEFAULT TRUE,
  created_at    TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  UNIQUE (tenant_id, source_label)
);

CREATE INDEX IF NOT EXISTS idx_expense_map_bucket
  ON dypos.expense_category_map (tenant_id, bucket);

-- Default roll-ups. Idempotent and tenant-wide: an unmapped category falls
-- into 'other' rather than silently vanishing from the P&L, which would make
-- the statement foot to something the reader cannot reproduce.

INSERT INTO dypos.expense_category_map (tenant_id, source_label, bucket)
VALUES
  ('royal-global-hq', 'cost of goods sold', 'cost_of_sales'),
  ('royal-global-hq', 'تكلفة البضاعة',        'cost_of_sales'),
  ('royal-global-hq', 'salary',               'payroll'),
  ('royal-global-hq', 'salaries',             'payroll'),
  ('royal-global-hq', 'wages',                'payroll'),
  ('royal-global-hq', 'رواتب',                'payroll'),
  ('royal-global-hq', 'rent',                 'rent'),
  ('royal-global-hq', 'lease',                'rent'),
  ('royal-global-hq', 'إيجار',                'rent'),
  ('royal-global-hq', 'utilities',            'utilities'),
  ('royal-global-hq', 'electricity',          'utilities'),
  ('royal-global-hq', 'water',                'utilities'),
  ('royal-global-hq', 'مرافق',                'utilities'),
  ('royal-global-hq', 'marketing',            'marketing'),
  ('royal-global-hq', 'advertising',          'marketing'),
  ('royal-global-hq', 'تسويق',                'marketing'),
  ('royal-global-hq', 'logistics',            'logistics'),
  ('royal-global-hq', 'delivery',             'logistics'),
  ('royal-global-hq', 'شحن ونقل',             'logistics'),
  ('royal-global-hq', 'maintenance',          'maintenance'),
  ('royal-global-hq', 'repairs',              'maintenance'),
  ('royal-global-hq', 'صيانة',                'maintenance'),
  ('royal-global-hq', 'professional fees',    'professional_fees'),
  ('royal-global-hq', 'consulting',           'professional_fees'),
  ('royal-global-hq', 'رسوم مهنية',           'professional_fees'),
  ('royal-global-hq', 'bank charges',         'bank_charges'),
  ('royal-global-hq', 'mada fees',            'bank_charges'),
  ('royal-global-hq', 'رسوم بنكية',           'bank_charges')
ON CONFLICT (tenant_id, source_label) DO NOTHING;

-- ---------------------------------------------------------------------------
-- 5. THE REMAINING SEEDED SCREENS
--
-- Restaurant, subscriptions and consignment each rendered hard-coded rows from
-- their component file. None of the screens could read real data, so the
-- tables are brought into line with what each screen actually shows.
--
-- IMPORTANT: `restaurant_tables`, `kitchen_tickets` and `subscriptions` all
-- ALREADY EXIST from earlier schema passes, each with a DIFFERENT shape than
-- the screens assume. Creating them again would be a silent no-op (CREATE TABLE
-- IF NOT EXISTS), so each one is ALTERED to carry the columns the screen reads.
-- The new columns are additive: no existing column is dropped or retyped, so
-- the other screens and views that depend on these tables keep working.
-- ---------------------------------------------------------------------------

-- --- Restaurant tables ---------------------------------------------------
-- `restaurant_tables` is created by the runtime schema bootstrap, but that runs
-- as a separate best-effort connection, so a database restored from a dump can
-- be missing it. CREATE-then-ALTER covers both cases without assuming either.
CREATE TABLE IF NOT EXISTS dypos.restaurant_tables (
  id          VARCHAR(64) PRIMARY KEY,
  area_id     VARCHAR(64),
  table_number VARCHAR(32) NOT NULL,
  capacity    INTEGER DEFAULT 4,
  -- 'available' here; the screen maps it to 'free'. Retyping the column would
  -- break every other reader of the existing values.
  status      VARCHAR(32) DEFAULT 'available',
  current_invoice_id VARCHAR(64)
);

-- Needed by the floor plan: a tenant scope, a seats count the UI shows, and the
-- live order value sitting on the table.
ALTER TABLE dypos.restaurant_tables
  ADD COLUMN IF NOT EXISTS tenant_id       VARCHAR(64),
  ADD COLUMN IF NOT EXISTS branch_id       VARCHAR(64) REFERENCES dypos.branches(id),
  ADD COLUMN IF NOT EXISTS seats           INTEGER NOT NULL DEFAULT 4,
  ADD COLUMN IF NOT EXISTS active_order_total NUMERIC(18,2) NOT NULL DEFAULT 0,
  ADD COLUMN IF NOT EXISTS items_count     INTEGER NOT NULL DEFAULT 0;

CREATE INDEX IF NOT EXISTS idx_restaurant_tables_branch
  ON dypos.restaurant_tables (tenant_id, branch_id, status);

-- --- Subscriptions -------------------------------------------------------
-- `subscriptions` is likewise created by the runtime bootstrap.
CREATE TABLE IF NOT EXISTS dypos.subscriptions (
  id                VARCHAR(64) PRIMARY KEY DEFAULT gen_random_uuid()::text,
  tenant_id         VARCHAR(64) NOT NULL,
  customer_id       VARCHAR(64),
  plan_id           VARCHAR(64),
  status            VARCHAR(32) DEFAULT 'active',
  start_date        DATE,
  end_date          DATE,
  auto_renew        BOOLEAN DEFAULT true,
  last_payment_date DATE,
  metadata          JSONB DEFAULT '{}'::jsonb,
  created_at        TIMESTAMP WITH TIME ZONE DEFAULT CURRENT_TIMESTAMP
);

-- Needed by the screen: a display name, a price, a billing cycle, the next due
-- date and a stored-credit balance.
ALTER TABLE dypos.subscriptions
  ADD COLUMN IF NOT EXISTS branch_id            VARCHAR(64) REFERENCES dypos.branches(id),
  ADD COLUMN IF NOT EXISTS customer_name        VARCHAR(255),
  ADD COLUMN IF NOT EXISTS plan_name            VARCHAR(128),
  ADD COLUMN IF NOT EXISTS price                NUMERIC(18,2),
  ADD COLUMN IF NOT EXISTS billing_cycle        VARCHAR(16),
  ADD COLUMN IF NOT EXISTS next_billing_date    DATE,
  ADD COLUMN IF NOT EXISTS store_credit_balance NUMERIC(18,2) NOT NULL DEFAULT 0;

-- --- Kitchen tickets -----------------------------------------------------
-- `kitchen_tickets` is referenced by the v101–v130 engine pack, but this
-- database does not actually have it: the pack creates it only inside its own
-- transaction and that transaction is skipped when earlier statements fail.
-- So the table is CREATED when absent and ALTERED when present — one statement
-- pair covers both realities instead of assuming either one.
--
-- The created shape matches the engine's (queued/accepted/preparing/ready/
-- served/cancelled) so the engine's views keep working against it.
CREATE TABLE IF NOT EXISTS dypos.kitchen_tickets (
  id         VARCHAR(64) PRIMARY KEY DEFAULT gen_random_uuid()::text,
  tenant_id  VARCHAR(64) NOT NULL,
  branch_id  VARCHAR(64),
  order_id   VARCHAR(64),
  station_id VARCHAR(64),
  ticket_no  BIGINT,
  status     TEXT NOT NULL DEFAULT 'queued'
             CHECK (status IN ('queued','accepted','preparing','ready','served','cancelled')),
  priority   INTEGER NOT NULL DEFAULT 100,
  queued_at  TIMESTAMPTZ NOT NULL DEFAULT now(),
  started_at TIMESTAMPTZ,
  ready_at   TIMESTAMPTZ,
  served_at  TIMESTAMPTZ,
  metadata   JSONB NOT NULL DEFAULT '{}'::jsonb
);

ALTER TABLE dypos.kitchen_tickets
  ADD COLUMN IF NOT EXISTS ticket_label VARCHAR(32),
  ADD COLUMN IF NOT EXISTS table_label  VARCHAR(64),
  ADD COLUMN IF NOT EXISTS order_type   VARCHAR(16) NOT NULL DEFAULT 'dine_in',
  ADD COLUMN IF NOT EXISTS items        JSONB NOT NULL DEFAULT '[]'::jsonb;

-- The KDS board reads by status and age, so the index is on both.
CREATE INDEX IF NOT EXISTS idx_kitchen_tickets_board
  ON dypos.kitchen_tickets (tenant_id, branch_id, status, queued_at);

-- --- Consignment sales ---------------------------------------------------
-- The screen models a WEIGHTED consignment sale settled through a broker, not a
-- simple quantity consignment: gross and tare weights, a net weight, a unit
-- price, and a broker commission deducted from what the seller receives.
--
-- All of those are stored rather than recomputed, because a commission is
-- negotiated per lot. Re-deriving it from a percentage on read would silently
-- change what a seller was already paid whenever the default rate was edited.
--
-- The DROP is deliberate and narrow: an earlier version of this migration
-- created a quantity-based table under the same name, and `CREATE TABLE IF NOT
-- EXISTS` would silently leave that wrong shape in place. The guard below
-- refuses to drop a table that already holds rows, so real data is never lost.
DO $$
BEGIN
  IF to_regclass('dypos.consignment_sales') IS NOT NULL
     AND NOT EXISTS (SELECT 1 FROM dypos.consignment_sales) THEN
    DROP TABLE dypos.consignment_sales;
  END IF;
END $$;

CREATE TABLE IF NOT EXISTS dypos.consignment_sales (
  id                   VARCHAR(64) PRIMARY KEY DEFAULT gen_random_uuid()::text,
  tenant_id            VARCHAR(64) NOT NULL REFERENCES dypos.tenants(id),
  branch_id            VARCHAR(64) REFERENCES dypos.branches(id),

  lot_number           VARCHAR(64) NOT NULL,

  -- The three parties. A consignment sale has no meaning without all three:
  -- who owns the goods, who bought them, and who brokered the deal.
  seller_name          VARCHAR(255) NOT NULL,
  buyer_name           VARCHAR(255) NOT NULL,
  broker_name          VARCHAR(255),

  crop_item            VARCHAR(255) NOT NULL,

  -- Weights in kilograms. `net_weight_kg` is a GENERATED column so the tare can
  -- never disagree with the gross — a stored net that drifted from its inputs
  -- is how a farmer gets paid for less than they delivered.
  gross_weight_kg      NUMERIC(12,3) NOT NULL DEFAULT 0 CHECK (gross_weight_kg >= 0),
  tare_weight_kg       NUMERIC(12,3) NOT NULL DEFAULT 0 CHECK (tare_weight_kg  >= 0),
  net_weight_kg        NUMERIC(12,3) GENERATED ALWAYS AS
                       (gross_weight_kg - tare_weight_kg) STORED,

  price_per_kg         NUMERIC(18,4) NOT NULL DEFAULT 0 CHECK (price_per_kg >= 0),

  -- The settled figures, frozen at the time of the sale.
  gross_total          NUMERIC(18,2) NOT NULL DEFAULT 0,
  commission_percent   NUMERIC(5,2)  NOT NULL DEFAULT 0
                       CHECK (commission_percent BETWEEN 0 AND 100),
  commission_amount    NUMERIC(18,2) NOT NULL DEFAULT 0,
  net_to_seller        NUMERIC(18,2) NOT NULL DEFAULT 0,

  status               VARCHAR(20) NOT NULL DEFAULT 'pending_payment'
                       CHECK (status IN ('settled','pending_payment','returned')),
  sold_at              TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  created_at           TIMESTAMPTZ NOT NULL DEFAULT NOW(),

  UNIQUE (tenant_id, lot_number)
);

-- The list screen filters by status and shows the newest first.
CREATE INDEX IF NOT EXISTS idx_consignment_status
  ON dypos.consignment_sales (tenant_id, branch_id, status, sold_at DESC);

-- Default roll-ups. Idempotent and tenant-wide: an unmapped category falls
-- into 'other' rather than silently vanishing from the P&L, which would make
-- the statement foot to something the reader cannot reproduce.