-- ===========================================================================
-- v136 — POS sale integrity
--
-- The checkout route writes invoices, invoice lines and stock movements. The
-- live `invoices` table predates that route and lacks several columns the code
-- assumes, so a sale failed with
--   "column \"exchange_rate\" of relation \"invoices\" does not exist".
--
-- Migrations are additive and idempotent: an existing installation gains the
-- columns without losing historical rows.
-- ===========================================================================

-- ---------------------------------------------------------------------------
-- 1. INVOICE COLUMNS USED BY THE SALE ROUTE
-- ---------------------------------------------------------------------------

ALTER TABLE dypos.invoices
  ADD COLUMN IF NOT EXISTS exchange_rate     NUMERIC(15,6)  NOT NULL DEFAULT 1,
  ADD COLUMN IF NOT EXISTS currency_code     VARCHAR(10)    NOT NULL DEFAULT 'SAR',
  ADD COLUMN IF NOT EXISTS items             JSONB          DEFAULT '[]'::jsonb,
  ADD COLUMN IF NOT EXISTS metadata          JSONB          DEFAULT '{}'::jsonb,
  ADD COLUMN IF NOT EXISTS timestamp         VARCHAR(128),
  ADD COLUMN IF NOT EXISTS cashier_id        VARCHAR(64),
  ADD COLUMN IF NOT EXISTS customer_id       VARCHAR(64),
  ADD COLUMN IF NOT EXISTS payment_method    VARCHAR(64)    NOT NULL DEFAULT 'mada',
  ADD COLUMN IF NOT EXISTS status            VARCHAR(64)    NOT NULL DEFAULT 'completed',
  ADD COLUMN IF NOT EXISTS discount          NUMERIC(12,2)  NOT NULL DEFAULT 0;

-- `timestamp` is reserved-ish as an identifier in some tools; quote it where it
-- is referenced by name.
CREATE INDEX IF NOT EXISTS idx_invoices_branch_time
  ON dypos.invoices (tenant_id, branch_id, created_at DESC);

CREATE INDEX IF NOT EXISTS idx_invoices_customer
  ON dypos.invoices (tenant_id, customer_id)
  WHERE customer_id IS NOT NULL;

-- ---------------------------------------------------------------------------
-- 2. INVOICE LINES
--
-- The sale route inserts one row per line. ON DELETE CASCADE keeps the ledger
-- consistent: removing an invoice must remove its lines, never orphan them.
-- ---------------------------------------------------------------------------

CREATE TABLE IF NOT EXISTS dypos.invoice_items (
  id          VARCHAR(64) PRIMARY KEY,
  invoice_id  VARCHAR(64) NOT NULL REFERENCES dypos.invoices(id) ON DELETE CASCADE,
  product_id  VARCHAR(64) REFERENCES dypos.products(id),
  quantity    NUMERIC(12,3) NOT NULL CHECK (quantity > 0),
  unit_price  NUMERIC(12,2) NOT NULL CHECK (unit_price >= 0),
  discount    NUMERIC(12,2) NOT NULL DEFAULT 0,
  tax_amount  NUMERIC(12,2) NOT NULL DEFAULT 0,
  total       NUMERIC(12,2) NOT NULL DEFAULT 0,
  created_at  TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

-- Older rows may predate the primary key default; backfill then enforce.
UPDATE dypos.invoice_items
   SET id = 'inv-item-' || id
 WHERE id IS NULL;

CREATE INDEX IF NOT EXISTS idx_invoice_items_invoice
  ON dypos.invoice_items (invoice_id);

-- ---------------------------------------------------------------------------
-- 3. STOCK MOVEMENT LEDGER
--
-- The column names in an already-deployed table are `type` / `reference_id`,
-- so the sale route writes exactly those. The table is created defensively for
-- installations that never ran the original schema pass.
-- ---------------------------------------------------------------------------

CREATE TABLE IF NOT EXISTS dypos.stock_movements (
  id           VARCHAR(64) PRIMARY KEY,
  product_id   VARCHAR(64) REFERENCES dypos.products(id),
  tenant_id    VARCHAR(64) REFERENCES dypos.tenants(id),
  branch_id    VARCHAR(64),
  type         VARCHAR(32) NOT NULL,
  quantity     NUMERIC(12,3) NOT NULL,
  reference_id VARCHAR(128),
  reason       TEXT,
  created_at   TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_stock_movements_product
  ON dypos.stock_movements (tenant_id, product_id, created_at DESC);