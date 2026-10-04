SET search_path TO dypos, public;
-- ============================================================================
-- DyPOS PostgreSQL Complementary Schema
-- Migration Pack: v24 -> v40
-- Purpose: close structural gaps in the POS / Smart Cashier data model
-- Target: PostgreSQL 14+
--
-- Design principles:
--   * additive / backward-compatible where practical
--   * VARCHAR(64) + timestamptz + NUMERIC for transactional data
--   * tenant/branch scoping
--   * immutable inventory and cash ledgers
--   * idempotent DDL (IF NOT EXISTS / guarded constraints)
--   * no destructive DROP/ALTER TYPE operations
--
-- Existing baseline:
--   DyPOS schema through v23 is assumed to exist.
--   Run after the current schema-postgres.sql.
-- ============================================================================





-- ----------------------------------------------------------------------------
-- 0. Helper: migration ledger
-- ----------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS schema_migrations (
  version INTEGER PRIMARY KEY,
  name TEXT NOT NULL,
  applied_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- ----------------------------------------------------------------------------
-- v24: tenant business profile + branch/terminal configuration
-- ----------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS tenant_settings (
  tenant_id VARCHAR(64) PRIMARY KEY REFERENCES tenants(id) ON DELETE CASCADE,
  legal_name TEXT,
  legal_name_ar TEXT,
  trade_name TEXT,
  trade_name_ar TEXT,
  vat_number TEXT,
  commercial_registration TEXT,
  country_code CHAR(2) NOT NULL DEFAULT 'YE',
  timezone TEXT NOT NULL DEFAULT 'Asia/Aden',
  base_currency TEXT NOT NULL DEFAULT 'YER',
  tax_inclusive BOOLEAN NOT NULL DEFAULT FALSE,
  fiscal_receipt_enabled BOOLEAN NOT NULL DEFAULT FALSE,
  logo_url TEXT,
  address_json JSONB NOT NULL DEFAULT '{}',
  contact_json JSONB NOT NULL DEFAULT '{}',
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS branch_settings (
  branch_id VARCHAR(64) PRIMARY KEY REFERENCES branches(id) ON DELETE CASCADE,
  receipt_header TEXT NOT NULL DEFAULT '',
  receipt_footer TEXT NOT NULL DEFAULT '',
  invoice_prefix TEXT NOT NULL DEFAULT 'INV',
  timezone TEXT,
  currency TEXT,
  tax_inclusive BOOLEAN,
  settings_json JSONB NOT NULL DEFAULT '{}',
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS pos_terminals (
  id VARCHAR(64) PRIMARY KEY DEFAULT gen_random_uuid()::text,
  tenant_id VARCHAR(64) NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  branch_id VARCHAR(64) NOT NULL REFERENCES branches(id) ON DELETE RESTRICT,
  terminal_code TEXT NOT NULL,
  name TEXT NOT NULL,
  terminal_type TEXT NOT NULL DEFAULT 'POS',
  status TEXT NOT NULL DEFAULT 'ACTIVE',
  device_id TEXT,
  printer_device_id TEXT,
  cash_drawer_device_id TEXT,
  scanner_device_id TEXT,
  default_warehouse_id TEXT REFERENCES warehouses(id),
  last_seen_at TIMESTAMPTZ,
  metadata JSONB NOT NULL DEFAULT '{}',
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE (tenant_id, terminal_code)
);

CREATE INDEX IF NOT EXISTS idx_pos_terminals_branch
  ON pos_terminals(branch_id, status);

CREATE INDEX IF NOT EXISTS idx_pos_terminals_device
  ON pos_terminals(device_id);

-- ----------------------------------------------------------------------------
-- v25: normalized product catalog
-- ----------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS product_categories (
  id VARCHAR(64) PRIMARY KEY DEFAULT gen_random_uuid()::text,
  tenant_id VARCHAR(64) NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  parent_id VARCHAR(64) REFERENCES product_categories(id) ON DELETE SET NULL,
  code TEXT NOT NULL,
  name TEXT NOT NULL,
  name_ar TEXT NOT NULL DEFAULT '',
  sort_order INTEGER NOT NULL DEFAULT 100,
  is_active BOOLEAN NOT NULL DEFAULT TRUE,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE (tenant_id, code)
);

CREATE INDEX IF NOT EXISTS idx_product_categories_parent
  ON product_categories(parent_id);

CREATE TABLE IF NOT EXISTS brands (
  id VARCHAR(64) PRIMARY KEY DEFAULT gen_random_uuid()::text,
  tenant_id VARCHAR(64) NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  code TEXT NOT NULL,
  name TEXT NOT NULL,
  name_ar TEXT NOT NULL DEFAULT '',
  is_active BOOLEAN NOT NULL DEFAULT TRUE,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE (tenant_id, code)
);

CREATE TABLE IF NOT EXISTS product_barcodes (
  id VARCHAR(64) PRIMARY KEY DEFAULT gen_random_uuid()::text,
  tenant_id VARCHAR(64) NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  product_id VARCHAR(64) NOT NULL REFERENCES products(id) ON DELETE CASCADE,
  barcode TEXT NOT NULL,
  barcode_type TEXT NOT NULL DEFAULT 'EAN13',
  is_primary BOOLEAN NOT NULL DEFAULT FALSE,
  is_active BOOLEAN NOT NULL DEFAULT TRUE,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE (tenant_id, barcode)
);

CREATE INDEX IF NOT EXISTS idx_product_barcodes_product
  ON product_barcodes(product_id, is_active);

CREATE TABLE IF NOT EXISTS price_lists (
  id VARCHAR(64) PRIMARY KEY DEFAULT gen_random_uuid()::text,
  tenant_id VARCHAR(64) NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  code TEXT NOT NULL,
  name TEXT NOT NULL,
  currency TEXT NOT NULL DEFAULT 'YER',
  priority INTEGER NOT NULL DEFAULT 100,
  valid_from TIMESTAMPTZ,
  valid_to TIMESTAMPTZ,
  is_default BOOLEAN NOT NULL DEFAULT FALSE,
  is_active BOOLEAN NOT NULL DEFAULT TRUE,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE (tenant_id, code)
);

CREATE TABLE IF NOT EXISTS product_prices (
  id VARCHAR(64) PRIMARY KEY DEFAULT gen_random_uuid()::text,
  price_list_id VARCHAR(64) NOT NULL REFERENCES price_lists(id) ON DELETE CASCADE,
  product_id VARCHAR(64) NOT NULL REFERENCES products(id) ON DELETE CASCADE,
  uom_code TEXT NOT NULL DEFAULT 'Unit',
  min_qty NUMERIC(14,3) NOT NULL DEFAULT 1,
  price NUMERIC(14,4) NOT NULL,
  compare_at_price NUMERIC(14,4),
  valid_from TIMESTAMPTZ,
  valid_to TIMESTAMPTZ,
  is_active BOOLEAN NOT NULL DEFAULT TRUE,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  CHECK (min_qty > 0),
  CHECK (price >= 0)
);

CREATE UNIQUE INDEX IF NOT EXISTS uq_product_prices_tier
  ON product_prices(price_list_id, product_id, uom_code, min_qty);

CREATE INDEX IF NOT EXISTS idx_product_prices_product
  ON product_prices(product_id, is_active);

ALTER TABLE products ADD COLUMN IF NOT EXISTS category_id VARCHAR(64);
ALTER TABLE products ADD COLUMN IF NOT EXISTS brand_id VARCHAR(64);
ALTER TABLE products ADD COLUMN IF NOT EXISTS default_uom_code TEXT;
ALTER TABLE products ADD COLUMN IF NOT EXISTS sku TEXT;
ALTER TABLE products ADD COLUMN IF NOT EXISTS min_stock NUMERIC(14,3) NOT NULL DEFAULT 0;
ALTER TABLE products ADD COLUMN IF NOT EXISTS reorder_point NUMERIC(14,3) NOT NULL DEFAULT 0;
ALTER TABLE products ADD COLUMN IF NOT EXISTS reorder_qty NUMERIC(14,3) NOT NULL DEFAULT 0;
ALTER TABLE products ADD COLUMN IF NOT EXISTS track_batch BOOLEAN NOT NULL DEFAULT FALSE;
ALTER TABLE products ADD COLUMN IF NOT EXISTS track_serial BOOLEAN NOT NULL DEFAULT FALSE;
ALTER TABLE products ADD COLUMN IF NOT EXISTS allow_negative_stock BOOLEAN NOT NULL DEFAULT FALSE;
ALTER TABLE products ADD COLUMN IF NOT EXISTS product_type TEXT NOT NULL DEFAULT 'GOODS';

CREATE INDEX IF NOT EXISTS idx_products_category_id ON products(category_id);
CREATE INDEX IF NOT EXISTS idx_products_brand_id ON products(brand_id);
CREATE INDEX IF NOT EXISTS idx_products_sku ON products(tenant_id, sku);

-- ----------------------------------------------------------------------------
-- v26: tax engine
-- ----------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS tax_rates (
  id VARCHAR(64) PRIMARY KEY DEFAULT gen_random_uuid()::text,
  tenant_id VARCHAR(64) NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  code TEXT NOT NULL,
  name TEXT NOT NULL,
  name_ar TEXT NOT NULL DEFAULT '',
  rate NUMERIC(7,4) NOT NULL DEFAULT 0,
  tax_type TEXT NOT NULL DEFAULT 'VAT',
  inclusive BOOLEAN NOT NULL DEFAULT FALSE,
  effective_from DATE,
  effective_to DATE,
  is_active BOOLEAN NOT NULL DEFAULT TRUE,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  CHECK (rate >= 0 AND rate <= 100),
  UNIQUE (tenant_id, code)
);

CREATE TABLE IF NOT EXISTS product_tax_rates (
  product_id VARCHAR(64) NOT NULL REFERENCES products(id) ON DELETE CASCADE,
  tax_rate_id VARCHAR(64) NOT NULL REFERENCES tax_rates(id) ON DELETE RESTRICT,
  priority INTEGER NOT NULL DEFAULT 1,
  PRIMARY KEY (product_id, tax_rate_id)
);

ALTER TABLE invoices ADD COLUMN IF NOT EXISTS tax_exempt_amount NUMERIC(14,2) NOT NULL DEFAULT 0;
ALTER TABLE invoices ADD COLUMN IF NOT EXISTS rounding_amount NUMERIC(14,2) NOT NULL DEFAULT 0;
ALTER TABLE invoices ADD COLUMN IF NOT EXISTS fiscal_status TEXT NOT NULL DEFAULT 'NOT_APPLICABLE';
ALTER TABLE invoices ADD COLUMN IF NOT EXISTS fiscal_uuid TEXT;
ALTER TABLE invoices ADD COLUMN IF NOT EXISTS fiscal_qr TEXT;

ALTER TABLE invoice_items ADD COLUMN IF NOT EXISTS tax_inclusive BOOLEAN NOT NULL DEFAULT FALSE;
ALTER TABLE invoice_items ADD COLUMN IF NOT EXISTS tax_code TEXT;

CREATE INDEX IF NOT EXISTS idx_invoices_fiscal_status
  ON invoices(tenant_id, fiscal_status, created_at DESC);

-- ----------------------------------------------------------------------------
-- v27: suppliers + purchasing / receiving
-- ----------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS suppliers (
  id VARCHAR(64) PRIMARY KEY DEFAULT gen_random_uuid()::text,
  tenant_id VARCHAR(64) NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  code TEXT NOT NULL,
  name TEXT NOT NULL,
  name_ar TEXT NOT NULL DEFAULT '',
  phone TEXT,
  email TEXT,
  tax_number TEXT,
  address TEXT,
  payment_terms_days INTEGER NOT NULL DEFAULT 0,
  credit_limit NUMERIC(14,2) NOT NULL DEFAULT 0,
  is_active BOOLEAN NOT NULL DEFAULT TRUE,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE (tenant_id, code)
);

CREATE TABLE IF NOT EXISTS purchase_orders (
  id VARCHAR(64) PRIMARY KEY DEFAULT gen_random_uuid()::text,
  tenant_id VARCHAR(64) NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  branch_id VARCHAR(64) REFERENCES branches(id) ON DELETE RESTRICT,
  warehouse_id TEXT REFERENCES warehouses(id),
  supplier_id VARCHAR(64) NOT NULL REFERENCES suppliers(id) ON DELETE RESTRICT,
  number TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'DRAFT',
  currency TEXT NOT NULL DEFAULT 'YER',
  subtotal NUMERIC(14,2) NOT NULL DEFAULT 0,
  tax_amount NUMERIC(14,2) NOT NULL DEFAULT 0,
  discount_amount NUMERIC(14,2) NOT NULL DEFAULT 0,
  total NUMERIC(14,2) NOT NULL DEFAULT 0,
  ordered_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  expected_at TIMESTAMPTZ,
  received_at TIMESTAMPTZ,
  notes TEXT NOT NULL DEFAULT '',
  created_by VARCHAR(64) REFERENCES users(id),
  approved_by VARCHAR(64) REFERENCES users(id),
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE (tenant_id, number)
);

CREATE TABLE IF NOT EXISTS purchase_order_items (
  id VARCHAR(64) PRIMARY KEY DEFAULT gen_random_uuid()::text,
  purchase_order_id VARCHAR(64) NOT NULL REFERENCES purchase_orders(id) ON DELETE CASCADE,
  product_id VARCHAR(64) NOT NULL REFERENCES products(id) ON DELETE RESTRICT,
  ordered_qty NUMERIC(14,3) NOT NULL,
  received_qty NUMERIC(14,3) NOT NULL DEFAULT 0,
  unit_cost NUMERIC(14,4) NOT NULL,
  tax_amount NUMERIC(14,2) NOT NULL DEFAULT 0,
  discount_amount NUMERIC(14,2) NOT NULL DEFAULT 0,
  batch_no TEXT,
  expiry_date DATE,
  notes TEXT NOT NULL DEFAULT '',
  CHECK (ordered_qty > 0),
  CHECK (received_qty >= 0)
);

CREATE INDEX IF NOT EXISTS idx_po_supplier
  ON purchase_orders(supplier_id, ordered_at DESC);

CREATE INDEX IF NOT EXISTS idx_po_status
  ON purchase_orders(tenant_id, status, ordered_at DESC);

-- ----------------------------------------------------------------------------
-- v28: inventory ledger / batches / serials / adjustments / transfers
-- ----------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS inventory_batches (
  id VARCHAR(64) PRIMARY KEY DEFAULT gen_random_uuid()::text,
  tenant_id VARCHAR(64) NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  product_id VARCHAR(64) NOT NULL REFERENCES products(id) ON DELETE RESTRICT,
  warehouse_id TEXT NOT NULL REFERENCES warehouses(id),
  batch_no TEXT NOT NULL,
  expiry_date DATE,
  received_at TIMESTAMPTZ,
  unit_cost NUMERIC(14,4) NOT NULL DEFAULT 0,
  qty_received NUMERIC(14,3) NOT NULL DEFAULT 0,
  qty_available NUMERIC(14,3) NOT NULL DEFAULT 0,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE (tenant_id, product_id, warehouse_id, batch_no)
);

CREATE INDEX IF NOT EXISTS idx_batches_expiry
  ON inventory_batches(tenant_id, expiry_date)
  WHERE expiry_date IS NOT NULL;

CREATE TABLE IF NOT EXISTS inventory_serials (
  id VARCHAR(64) PRIMARY KEY DEFAULT gen_random_uuid()::text,
  tenant_id VARCHAR(64) NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  product_id VARCHAR(64) NOT NULL REFERENCES products(id) ON DELETE RESTRICT,
  warehouse_id TEXT REFERENCES warehouses(id),
  batch_id VARCHAR(64) REFERENCES inventory_batches(id) ON DELETE SET NULL,
  serial_no TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'IN_STOCK',
  sold_invoice_item_id VARCHAR(64) REFERENCES invoice_items(id) ON DELETE SET NULL,
  received_at TIMESTAMPTZ,
  sold_at TIMESTAMPTZ,
  UNIQUE (tenant_id, serial_no)
);

CREATE TABLE IF NOT EXISTS inventory_movements (
  id BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  tenant_id VARCHAR(64) NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  product_id VARCHAR(64) NOT NULL REFERENCES products(id) ON DELETE RESTRICT,
  warehouse_id TEXT NOT NULL REFERENCES warehouses(id),
  movement_type TEXT NOT NULL,
  qty NUMERIC(14,3) NOT NULL,
  unit_cost NUMERIC(14,4),
  reference_type TEXT,
  reference_id TEXT,
  batch_id VARCHAR(64) REFERENCES inventory_batches(id) ON DELETE SET NULL,
  serial_id VARCHAR(64) REFERENCES inventory_serials(id) ON DELETE SET NULL,
  reason TEXT,
  created_by VARCHAR(64) REFERENCES users(id),
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  CHECK (qty <> 0)
);

CREATE INDEX IF NOT EXISTS idx_inventory_movements_product
  ON inventory_movements(tenant_id, product_id, warehouse_id, created_at DESC);

CREATE INDEX IF NOT EXISTS idx_inventory_movements_ref
  ON inventory_movements(reference_type, reference_id);

CREATE TABLE IF NOT EXISTS stock_adjustments (
  id VARCHAR(64) PRIMARY KEY DEFAULT gen_random_uuid()::text,
  tenant_id VARCHAR(64) NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  branch_id VARCHAR(64) REFERENCES branches(id),
  warehouse_id TEXT NOT NULL REFERENCES warehouses(id),
  number TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'DRAFT',
  reason TEXT NOT NULL DEFAULT '',
  created_by VARCHAR(64) REFERENCES users(id),
  approved_by VARCHAR(64) REFERENCES users(id),
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  posted_at TIMESTAMPTZ,
  UNIQUE (tenant_id, number)
);

CREATE TABLE IF NOT EXISTS stock_adjustment_items (
  id VARCHAR(64) PRIMARY KEY DEFAULT gen_random_uuid()::text,
  adjustment_id VARCHAR(64) NOT NULL REFERENCES stock_adjustments(id) ON DELETE CASCADE,
  product_id VARCHAR(64) NOT NULL REFERENCES products(id) ON DELETE RESTRICT,
  system_qty NUMERIC(14,3) NOT NULL DEFAULT 0,
  counted_qty NUMERIC(14,3) NOT NULL DEFAULT 0,
  difference_qty NUMERIC(14,3) NOT NULL DEFAULT 0,
  unit_cost NUMERIC(14,4) NOT NULL DEFAULT 0
);

CREATE TABLE IF NOT EXISTS stock_transfers (
  id VARCHAR(64) PRIMARY KEY DEFAULT gen_random_uuid()::text,
  tenant_id VARCHAR(64) NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  number TEXT NOT NULL,
  from_warehouse_id TEXT NOT NULL REFERENCES warehouses(id),
  to_warehouse_id TEXT NOT NULL REFERENCES warehouses(id),
  status TEXT NOT NULL DEFAULT 'DRAFT',
  requested_by VARCHAR(64) REFERENCES users(id),
  approved_by VARCHAR(64) REFERENCES users(id),
  shipped_at TIMESTAMPTZ,
  received_at TIMESTAMPTZ,
  notes TEXT NOT NULL DEFAULT '',
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE (tenant_id, number),
  CHECK (from_warehouse_id <> to_warehouse_id)
);

CREATE TABLE IF NOT EXISTS stock_transfer_items (
  id VARCHAR(64) PRIMARY KEY DEFAULT gen_random_uuid()::text,
  transfer_id VARCHAR(64) NOT NULL REFERENCES stock_transfers(id) ON DELETE CASCADE,
  product_id VARCHAR(64) NOT NULL REFERENCES products(id) ON DELETE RESTRICT,
  requested_qty NUMERIC(14,3) NOT NULL,
  shipped_qty NUMERIC(14,3) NOT NULL DEFAULT 0,
  received_qty NUMERIC(14,3) NOT NULL DEFAULT 0,
  CHECK (requested_qty > 0)
);

-- ----------------------------------------------------------------------------
-- v29: cash management + safe reconciliation
-- ----------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS cash_movements (
  id VARCHAR(64) PRIMARY KEY DEFAULT gen_random_uuid()::text,
  tenant_id VARCHAR(64) NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  branch_id VARCHAR(64) REFERENCES branches(id),
  terminal_code TEXT,
  shift_id VARCHAR(64) NOT NULL REFERENCES shifts(id) ON DELETE RESTRICT,
  movement_type TEXT NOT NULL,
  direction TEXT NOT NULL,
  amount NUMERIC(14,2) NOT NULL,
  currency TEXT NOT NULL DEFAULT 'YER',
  reference_type TEXT,
  reference_id TEXT,
  reason TEXT NOT NULL DEFAULT '',
  created_by VARCHAR(64) REFERENCES users(id),
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  CHECK (amount > 0),
  CHECK (direction IN ('IN','OUT'))
);

CREATE INDEX IF NOT EXISTS idx_cash_movements_shift
  ON cash_movements(shift_id, created_at);

CREATE TABLE IF NOT EXISTS cash_counts (
  id VARCHAR(64) PRIMARY KEY DEFAULT gen_random_uuid()::text,
  shift_id VARCHAR(64) NOT NULL REFERENCES shifts(id) ON DELETE CASCADE,
  counted_by VARCHAR(64) REFERENCES users(id),
  counted_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  denomination_json JSONB NOT NULL DEFAULT '{}',
  counted_amount NUMERIC(14,2) NOT NULL DEFAULT 0,
  expected_amount NUMERIC(14,2) NOT NULL DEFAULT 0,
  variance NUMERIC(14,2) NOT NULL DEFAULT 0,
  notes TEXT NOT NULL DEFAULT ''
);

ALTER TABLE shifts ADD COLUMN IF NOT EXISTS currency TEXT NOT NULL DEFAULT 'YER';
ALTER TABLE shifts ADD COLUMN IF NOT EXISTS terminal_code TEXT;
ALTER TABLE shifts ADD COLUMN IF NOT EXISTS opening_count_json JSONB NOT NULL DEFAULT '{}';
ALTER TABLE shifts ADD COLUMN IF NOT EXISTS closing_count_json JSONB NOT NULL DEFAULT '{}';

-- ----------------------------------------------------------------------------
-- v30: customer credit ledger + AR documents
-- ----------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS customer_credit_transactions (
  id BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  tenant_id VARCHAR(64) NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  customer_id VARCHAR(64) NOT NULL REFERENCES customers(id) ON DELETE CASCADE,
  invoice_id VARCHAR(64) REFERENCES invoices(id) ON DELETE SET NULL,
  transaction_type TEXT NOT NULL,
  debit NUMERIC(14,2) NOT NULL DEFAULT 0,
  credit NUMERIC(14,2) NOT NULL DEFAULT 0,
  balance_after NUMERIC(14,2) NOT NULL DEFAULT 0,
  reference TEXT,
  note TEXT NOT NULL DEFAULT '',
  created_by VARCHAR(64) REFERENCES users(id),
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  CHECK (debit >= 0 AND credit >= 0),
  CHECK (debit <> 0 OR credit <> 0)
);

CREATE INDEX IF NOT EXISTS idx_customer_credit_ledger
  ON customer_credit_transactions(customer_id, created_at DESC);

CREATE TABLE IF NOT EXISTS customer_credit_payments (
  id VARCHAR(64) PRIMARY KEY DEFAULT gen_random_uuid()::text,
  tenant_id VARCHAR(64) NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  customer_id VARCHAR(64) NOT NULL REFERENCES customers(id) ON DELETE CASCADE,
  amount NUMERIC(14,2) NOT NULL,
  method TEXT NOT NULL,
  reference TEXT,
  received_by VARCHAR(64) REFERENCES users(id),
  received_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  CHECK (amount > 0)
);

-- ----------------------------------------------------------------------------
-- v31: sales returns as first-class documents
-- ----------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS sales_returns (
  id VARCHAR(64) PRIMARY KEY DEFAULT gen_random_uuid()::text,
  tenant_id VARCHAR(64) NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  branch_id VARCHAR(64) REFERENCES branches(id),
  invoice_id VARCHAR(64) NOT NULL REFERENCES invoices(id) ON DELETE RESTRICT,
  customer_id VARCHAR(64) REFERENCES customers(id),
  number TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'DRAFT',
  reason TEXT NOT NULL DEFAULT '',
  subtotal NUMERIC(14,2) NOT NULL DEFAULT 0,
  tax_amount NUMERIC(14,2) NOT NULL DEFAULT 0,
  total NUMERIC(14,2) NOT NULL DEFAULT 0,
  refund_amount NUMERIC(14,2) NOT NULL DEFAULT 0,
  refund_method TEXT,
  created_by VARCHAR(64) REFERENCES users(id),
  approved_by VARCHAR(64) REFERENCES users(id),
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  posted_at TIMESTAMPTZ,
  UNIQUE (tenant_id, number)
);

CREATE TABLE IF NOT EXISTS sales_return_items (
  id VARCHAR(64) PRIMARY KEY DEFAULT gen_random_uuid()::text,
  return_id VARCHAR(64) NOT NULL REFERENCES sales_returns(id) ON DELETE CASCADE,
  invoice_item_id VARCHAR(64) NOT NULL REFERENCES invoice_items(id) ON DELETE RESTRICT,
  product_id VARCHAR(64) REFERENCES products(id) ON DELETE RESTRICT,
  qty NUMERIC(14,3) NOT NULL,
  unit_price NUMERIC(14,4) NOT NULL,
  tax_amount NUMERIC(14,2) NOT NULL DEFAULT 0,
  total NUMERIC(14,2) NOT NULL DEFAULT 0,
  reason TEXT NOT NULL DEFAULT '',
  CHECK (qty > 0)
);

CREATE INDEX IF NOT EXISTS idx_sales_returns_invoice
  ON sales_returns(invoice_id, created_at DESC);

-- ----------------------------------------------------------------------------
-- v32: POS parked carts / quotes / order lifecycle
-- ----------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS sales_carts (
  id VARCHAR(64) PRIMARY KEY DEFAULT gen_random_uuid()::text,
  tenant_id VARCHAR(64) NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  branch_id VARCHAR(64) REFERENCES branches(id),
  terminal_code TEXT,
  customer_id VARCHAR(64) REFERENCES customers(id),
  status TEXT NOT NULL DEFAULT 'PARKED',
  cart_number TEXT,
  expires_at TIMESTAMPTZ,
  notes TEXT NOT NULL DEFAULT '',
  created_by VARCHAR(64) REFERENCES users(id),
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS sales_cart_items (
  id VARCHAR(64) PRIMARY KEY DEFAULT gen_random_uuid()::text,
  cart_id VARCHAR(64) NOT NULL REFERENCES sales_carts(id) ON DELETE CASCADE,
  product_id VARCHAR(64) REFERENCES products(id) ON DELETE SET NULL,
  product_name TEXT NOT NULL,
  qty NUMERIC(14,3) NOT NULL,
  unit_price NUMERIC(14,4) NOT NULL,
  discount NUMERIC(14,2) NOT NULL DEFAULT 0,
  tax_amount NUMERIC(14,2) NOT NULL DEFAULT 0,
  total NUMERIC(14,2) NOT NULL DEFAULT 0,
  CHECK (qty > 0)
);

CREATE INDEX IF NOT EXISTS idx_sales_carts_active
  ON sales_carts(tenant_id, status, updated_at DESC);

-- ----------------------------------------------------------------------------
-- v33: restaurant / cafe operational plane
-- ----------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS dining_areas (
  id VARCHAR(64) PRIMARY KEY DEFAULT gen_random_uuid()::text,
  tenant_id VARCHAR(64) NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  branch_id VARCHAR(64) NOT NULL REFERENCES branches(id) ON DELETE CASCADE,
  name TEXT NOT NULL,
  sort_order INTEGER NOT NULL DEFAULT 100,
  is_active BOOLEAN NOT NULL DEFAULT TRUE,
  UNIQUE (branch_id, name)
);

CREATE TABLE IF NOT EXISTS dining_tables (
  id VARCHAR(64) PRIMARY KEY DEFAULT gen_random_uuid()::text,
  area_id VARCHAR(64) NOT NULL REFERENCES dining_areas(id) ON DELETE CASCADE,
  table_code TEXT NOT NULL,
  name TEXT NOT NULL,
  seats INTEGER NOT NULL DEFAULT 2,
  status TEXT NOT NULL DEFAULT 'AVAILABLE',
  x NUMERIC(8,2),
  y NUMERIC(8,2),
  metadata JSONB NOT NULL DEFAULT '{}',
  UNIQUE (area_id, table_code),
  CHECK (seats > 0)
);

CREATE TABLE IF NOT EXISTS service_orders (
  id VARCHAR(64) PRIMARY KEY DEFAULT gen_random_uuid()::text,
  tenant_id VARCHAR(64) NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  branch_id VARCHAR(64) REFERENCES branches(id),
  table_id VARCHAR(64) REFERENCES dining_tables(id) ON DELETE SET NULL,
  invoice_id VARCHAR(64) REFERENCES invoices(id) ON DELETE SET NULL,
  order_number TEXT NOT NULL,
  order_type TEXT NOT NULL DEFAULT 'DINE_IN',
  status TEXT NOT NULL DEFAULT 'OPEN',
  guest_count INTEGER NOT NULL DEFAULT 1,
  opened_by VARCHAR(64) REFERENCES users(id),
  closed_by VARCHAR(64) REFERENCES users(id),
  opened_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  closed_at TIMESTAMPTZ,
  notes TEXT NOT NULL DEFAULT '',
  UNIQUE (tenant_id, order_number),
  CHECK (guest_count > 0)
);

CREATE TABLE IF NOT EXISTS service_order_items (
  id VARCHAR(64) PRIMARY KEY DEFAULT gen_random_uuid()::text,
  service_order_id VARCHAR(64) NOT NULL REFERENCES service_orders(id) ON DELETE CASCADE,
  product_id VARCHAR(64) REFERENCES products(id) ON DELETE SET NULL,
  product_name TEXT NOT NULL,
  qty NUMERIC(14,3) NOT NULL,
  unit_price NUMERIC(14,4) NOT NULL,
  status TEXT NOT NULL DEFAULT 'NEW',
  kitchen_note TEXT NOT NULL DEFAULT '',
  modifiers_json JSONB NOT NULL DEFAULT '[]',
  sent_to_kitchen_at TIMESTAMPTZ,
  completed_at TIMESTAMPTZ,
  CHECK (qty > 0)
);

CREATE INDEX IF NOT EXISTS idx_service_orders_table
  ON service_orders(table_id, status);

CREATE INDEX IF NOT EXISTS idx_service_order_items_status
  ON service_order_items(service_order_id, status);

-- ----------------------------------------------------------------------------
-- v34: recipe / BOM / modifiers
-- ----------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS product_modifiers (
  id VARCHAR(64) PRIMARY KEY DEFAULT gen_random_uuid()::text,
  tenant_id VARCHAR(64) NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  code TEXT NOT NULL,
  name TEXT NOT NULL,
  name_ar TEXT NOT NULL DEFAULT '',
  price_delta NUMERIC(14,4) NOT NULL DEFAULT 0,
  is_active BOOLEAN NOT NULL DEFAULT TRUE,
  UNIQUE (tenant_id, code)
);

CREATE TABLE IF NOT EXISTS product_modifier_options (
  id VARCHAR(64) PRIMARY KEY DEFAULT gen_random_uuid()::text,
  modifier_id VARCHAR(64) NOT NULL REFERENCES product_modifiers(id) ON DELETE CASCADE,
  option_code TEXT NOT NULL,
  name TEXT NOT NULL,
  name_ar TEXT NOT NULL DEFAULT '',
  price_delta NUMERIC(14,4) NOT NULL DEFAULT 0,
  is_default BOOLEAN NOT NULL DEFAULT FALSE,
  sort_order INTEGER NOT NULL DEFAULT 100,
  UNIQUE (modifier_id, option_code)
);

CREATE TABLE IF NOT EXISTS product_recipes (
  id VARCHAR(64) PRIMARY KEY DEFAULT gen_random_uuid()::text,
  tenant_id VARCHAR(64) NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  product_id VARCHAR(64) NOT NULL REFERENCES products(id) ON DELETE CASCADE,
  version INTEGER NOT NULL DEFAULT 1,
  yield_qty NUMERIC(14,3) NOT NULL DEFAULT 1,
  is_active BOOLEAN NOT NULL DEFAULT TRUE,
  effective_from TIMESTAMPTZ,
  effective_to TIMESTAMPTZ,
  UNIQUE (product_id, version),
  CHECK (yield_qty > 0)
);

CREATE TABLE IF NOT EXISTS product_recipe_items (
  id VARCHAR(64) PRIMARY KEY DEFAULT gen_random_uuid()::text,
  recipe_id VARCHAR(64) NOT NULL REFERENCES product_recipes(id) ON DELETE CASCADE,
  component_product_id VARCHAR(64) NOT NULL REFERENCES products(id) ON DELETE RESTRICT,
  qty NUMERIC(14,4) NOT NULL,
  waste_percent NUMERIC(7,4) NOT NULL DEFAULT 0,
  CHECK (qty > 0),
  CHECK (waste_percent >= 0 AND waste_percent <= 100)
);

-- ----------------------------------------------------------------------------
-- v35: RBAC / permissions
-- ----------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS roles (
  id VARCHAR(64) PRIMARY KEY DEFAULT gen_random_uuid()::text,
  tenant_id VARCHAR(64) REFERENCES tenants(id) ON DELETE CASCADE,
  code TEXT NOT NULL,
  name TEXT NOT NULL,
  is_system BOOLEAN NOT NULL DEFAULT FALSE,
  is_active BOOLEAN NOT NULL DEFAULT TRUE,
  UNIQUE (tenant_id, code)
);

CREATE TABLE IF NOT EXISTS permissions (
  code TEXT PRIMARY KEY,
  name TEXT NOT NULL,
  module TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS role_permissions (
  role_id VARCHAR(64) NOT NULL REFERENCES roles(id) ON DELETE CASCADE,
  permission_code TEXT NOT NULL REFERENCES permissions(code) ON DELETE CASCADE,
  PRIMARY KEY (role_id, permission_code)
);

CREATE TABLE IF NOT EXISTS user_roles (
  user_id VARCHAR(64) NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  role_id VARCHAR(64) NOT NULL REFERENCES roles(id) ON DELETE CASCADE,
  PRIMARY KEY (user_id, role_id)
);

CREATE INDEX IF NOT EXISTS idx_user_roles_role ON user_roles(role_id);

INSERT INTO permissions(code,name,module) VALUES
  ('sales.create','Create sales','SALES'),
  ('sales.void','Void sales','SALES'),
  ('sales.discount','Apply discount','SALES'),
  ('sales.return','Return sales','SALES'),
  ('payments.refund','Refund payments','PAYMENTS'),
  ('cash.open_shift','Open shift','CASH'),
  ('cash.close_shift','Close shift','CASH'),
  ('cash.adjust','Cash adjustment','CASH'),
  ('inventory.adjust','Adjust inventory','INVENTORY'),
  ('inventory.transfer','Transfer inventory','INVENTORY'),
  ('inventory.receive','Receive purchases','INVENTORY'),
  ('products.manage','Manage products','CATALOG'),
  ('customers.manage','Manage customers','CRM'),
  ('reports.view','View reports','REPORTS'),
  ('settings.manage','Manage settings','ADMIN'),
  ('users.manage','Manage users','ADMIN'),
  ('integrations.manage','Manage integrations','INTEGRATION')
ON CONFLICT DO NOTHING;

-- ----------------------------------------------------------------------------
-- v36: offline sync cursor / conflicts / dead-letter
-- ----------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS sync_cursors (
  id VARCHAR(64) PRIMARY KEY DEFAULT gen_random_uuid()::text,
  tenant_id VARCHAR(64) NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  device_id TEXT NOT NULL,
  entity_type TEXT NOT NULL,
  last_server_cursor BIGINT NOT NULL DEFAULT 0,
  last_client_cursor BIGINT NOT NULL DEFAULT 0,
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE (tenant_id, device_id, entity_type)
);

CREATE TABLE IF NOT EXISTS sync_conflicts (
  id BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  tenant_id VARCHAR(64) REFERENCES tenants(id) ON DELETE CASCADE,
  device_id TEXT,
  entity_type TEXT NOT NULL,
  entity_id TEXT NOT NULL,
  operation TEXT NOT NULL,
  local_payload JSONB NOT NULL DEFAULT '{}',
  server_payload JSONB NOT NULL DEFAULT '{}',
  resolution TEXT NOT NULL DEFAULT 'PENDING',
  resolved_by VARCHAR(64) REFERENCES users(id),
  resolved_at TIMESTAMPTZ,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_sync_conflicts_pending
  ON sync_conflicts(tenant_id, resolution, created_at);

CREATE TABLE IF NOT EXISTS integration_dead_letters (
  id BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  tenant_id VARCHAR(64),
  integration_run_id BIGINT,
  entity_type TEXT,
  entity_id TEXT,
  error_code TEXT,
  error_message TEXT NOT NULL,
  request_json JSONB NOT NULL DEFAULT '{}',
  response_json JSONB NOT NULL DEFAULT '{}',
  retry_count INTEGER NOT NULL DEFAULT 0,
  last_attempt_at TIMESTAMPTZ,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- ----------------------------------------------------------------------------
-- v37: immutable business events / event store
-- ----------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS business_events (
  id BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  tenant_id VARCHAR(64) REFERENCES tenants(id) ON DELETE CASCADE,
  event_id VARCHAR(64) NOT NULL DEFAULT gen_random_uuid()::text,
  aggregate_type TEXT NOT NULL,
  aggregate_id TEXT NOT NULL,
  event_type TEXT NOT NULL,
  event_version INTEGER NOT NULL DEFAULT 1,
  payload JSONB NOT NULL DEFAULT '{}',
  occurred_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  recorded_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  actor_user_id VARCHAR(64) REFERENCES users(id),
  correlation_id TEXT,
  causation_id TEXT,
  idempotency_key TEXT,
  UNIQUE(event_id)
);

CREATE UNIQUE INDEX IF NOT EXISTS uq_business_events_idem
  ON business_events(tenant_id, idempotency_key)
  WHERE idempotency_key IS NOT NULL AND idempotency_key <> '';

CREATE INDEX IF NOT EXISTS idx_business_events_aggregate
  ON business_events(tenant_id, aggregate_type, aggregate_id, id);

CREATE INDEX IF NOT EXISTS idx_business_events_type_time
  ON business_events(tenant_id, event_type, occurred_at DESC);

-- ----------------------------------------------------------------------------
-- v38: reporting / daily POS snapshot
-- ----------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS pos_daily_snapshots (
  id BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  tenant_id VARCHAR(64) NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  branch_id VARCHAR(64) REFERENCES branches(id) ON DELETE CASCADE,
  business_date DATE NOT NULL,
  invoices_count INTEGER NOT NULL DEFAULT 0,
  gross_sales NUMERIC(14,2) NOT NULL DEFAULT 0,
  discounts NUMERIC(14,2) NOT NULL DEFAULT 0,
  tax NUMERIC(14,2) NOT NULL DEFAULT 0,
  returns NUMERIC(14,2) NOT NULL DEFAULT 0,
  net_sales NUMERIC(14,2) NOT NULL DEFAULT 0,
  cash_sales NUMERIC(14,2) NOT NULL DEFAULT 0,
  card_sales NUMERIC(14,2) NOT NULL DEFAULT 0,
  wallet_sales NUMERIC(14,2) NOT NULL DEFAULT 0,
  credit_sales NUMERIC(14,2) NOT NULL DEFAULT 0,
  cogs NUMERIC(14,2) NOT NULL DEFAULT 0,
  gross_profit NUMERIC(14,2) NOT NULL DEFAULT 0,
  generated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE (tenant_id, branch_id, business_date)
);

-- ----------------------------------------------------------------------------
-- v39: safe constraints on existing core monetary/quantity columns
-- ----------------------------------------------------------------------------
DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint WHERE conname = 'products_unit_price_nonnegative'
  ) THEN
    ALTER TABLE products
      ADD CONSTRAINT products_unit_price_nonnegative CHECK (unit_price >= 0);
  END IF;

  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint WHERE conname = 'products_cost_nonnegative'
  ) THEN
    ALTER TABLE products
      ADD CONSTRAINT products_cost_nonnegative CHECK (cost >= 0);
  END IF;

  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint WHERE conname = 'customers_wallet_nonnegative'
  ) THEN
    ALTER TABLE customers
      ADD CONSTRAINT customers_wallet_nonnegative CHECK (wallet_balance >= 0);
  END IF;

  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint WHERE conname = 'customers_credit_limit_nonnegative'
  ) THEN
    ALTER TABLE customers
      ADD CONSTRAINT customers_credit_limit_nonnegative CHECK (credit_limit >= 0);
  END IF;
END $$;

-- ----------------------------------------------------------------------------
-- v40: operational indexes for large-scale POS workloads
-- ----------------------------------------------------------------------------
CREATE INDEX IF NOT EXISTS idx_invoices_tenant_branch_date
  ON invoices(tenant_id, branch_id, created_at DESC);

CREATE INDEX IF NOT EXISTS idx_invoices_customer_status
  ON invoices(tenant_id, customer_id, status, created_at DESC);

CREATE INDEX IF NOT EXISTS idx_invoice_items_product_invoice
  ON invoice_items(product_id, invoice_id);

CREATE INDEX IF NOT EXISTS idx_payments_invoice_created
  ON payments(invoice_id, created_at DESC);

CREATE INDEX IF NOT EXISTS idx_sync_log_pending
  ON sync_log(tenant_id, status, id)
  WHERE status IN ('PENDING','FAILED');

CREATE INDEX IF NOT EXISTS idx_webhook_outbox_ready
  ON webhook_outbox(status, next_attempt_at, id)
  WHERE status IN ('PENDING','FAILED');

CREATE INDEX IF NOT EXISTS idx_integration_runs_ready
  ON integration_runs(tenant_id, status, next_attempt_at, id)
  WHERE status IN ('PENDING','FAILED');

-- ----------------------------------------------------------------------------
-- updated_at trigger: centralized and reusable
-- ----------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION dypos_set_updated_at()
RETURNS TRIGGER
LANGUAGE plpgsql
AS $$
BEGIN
  NEW.updated_at = now();
  RETURN NEW;
END;
$$;

DO $$
DECLARE
  t TEXT;
BEGIN
  FOREACH t IN ARRAY ARRAY[
    'tenant_settings',
    'branch_settings',
    'pos_terminals',
    'product_categories',
    'brands',
    'price_lists',
    'suppliers',
    'purchase_orders',
    'sales_carts'
  ]
  LOOP
    EXECUTE format(
      'DROP TRIGGER IF EXISTS trg_%I_updated_at ON %I',
      t, t
    );
    EXECUTE format(
      'CREATE TRIGGER trg_%I_updated_at BEFORE UPDATE ON %I
       FOR EACH ROW EXECUTE FUNCTION dypos_set_updated_at()',
      t, t
    );
  END LOOP;
END $$;

-- ----------------------------------------------------------------------------
-- Register migration versions
-- ----------------------------------------------------------------------------
INSERT INTO schema_migrations(version,name) VALUES
  (24,'tenant and POS terminal configuration'),
  (25,'normalized product catalog and pricing'),
  (26,'tax engine and fiscal fields'),
  (27,'suppliers and purchasing'),
  (28,'inventory ledger batches serials adjustments transfers'),
  (29,'cash management and reconciliation'),
  (30,'customer credit ledger'),
  (31,'sales returns'),
  (32,'parked carts and sales lifecycle'),
  (33,'restaurant and cafe operations'),
  (34,'recipes and modifiers'),
  (35,'RBAC permissions'),
  (36,'offline sync conflicts and dead letters'),
  (37,'immutable business events'),
  (38,'reporting snapshots'),
  (39,'core safety constraints'),
  (40,'large-scale operational indexes')
ON CONFLICT (version) DO NOTHING;

-- Keep legacy schema_version in sync with the highest complementary migration.
INSERT INTO schema_version(version,description)
VALUES (40,'DyPOS complementary schema pack v24-v40')
ON CONFLICT (version) DO NOTHING;



-- ============================================================================
-- OPTIONAL DATA-BACKFILL / CUTOVER NOTES
-- ============================================================================
-- 1) Populate product_categories/category_id and brands/brand_id from legacy
--    products.category / products.brand before switching application reads.
--
-- 2) Populate product_barcodes from products.barcode.
--
-- 3) Create one price_list per branch/tenant and backfill product_prices from
--    products.unit_price.
--
-- 4) Populate inventory_movements from the application's historical stock
--    transactions if historical auditability is required. Do not fabricate
--    movements from current stock quantities.
--
-- 5) Map existing terminal_id TEXT values to pos_terminals. Keep terminal_code
--    stable during the transition so old invoices/shifts remain readable.
--
-- 6) The existing schema contains a mixture of VARCHAR(64)/TEXT tenant identifiers
--    and some legacy REAL/TEXT tables. This pack deliberately avoids destructive
--    type changes. A separate controlled data migration should normalize those
--    columns after application compatibility is verified.
--
-- 7) For high-volume deployments, partitioning can be introduced later for
--    invoices, invoice_items, inventory_movements, business_events and audit
--    tables by tenant/date. Do this only after measuring actual workload and
--    query plans.
