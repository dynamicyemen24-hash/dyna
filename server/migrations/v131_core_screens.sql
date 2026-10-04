-- =====================================================================
-- DyPOS Enterprise Cloud & Edge
-- Migration Pack v131 — Core Screens End-to-End
-- Backing tables for the seven screens that were placeholders:
--   services, appointments, production, batches, serials,
--   commissions, delivery.
-- Idempotent: safe to run repeatedly.
-- =====================================================================

BEGIN;

CREATE SCHEMA IF NOT EXISTS dypos;
SET search_path TO dypos, public;

-- 1. SERVICE CATALOG (الخدمات)
CREATE TABLE IF NOT EXISTS dypos.services (
  id               VARCHAR(64) PRIMARY KEY,
  tenant_id        VARCHAR(64) NOT NULL,
  name             VARCHAR(255) NOT NULL,
  name_en          VARCHAR(255),
  category         VARCHAR(128),
  description      TEXT,
  base_price       NUMERIC(15, 2) NOT NULL DEFAULT 0,
  tax_rate         NUMERIC(6, 3)  NOT NULL DEFAULT 15,
  duration_minutes INTEGER NOT NULL DEFAULT 30,
  is_active        BOOLEAN NOT NULL DEFAULT TRUE,
  metadata         JSONB NOT NULL DEFAULT '{}'::jsonb,
  created_at       TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at       TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
CREATE INDEX IF NOT EXISTS idx_services_tenant ON dypos.services (tenant_id, is_active);

-- 2. APPOINTMENTS (المواعيد)
CREATE TABLE IF NOT EXISTS dypos.appointments (
  id              VARCHAR(64) PRIMARY KEY,
  tenant_id       VARCHAR(64) NOT NULL,
  branch_id       VARCHAR(64),
  service_id      VARCHAR(64) REFERENCES dypos.services(id) ON DELETE SET NULL,
  customer_id     VARCHAR(64),
  customer_name   VARCHAR(255),
  customer_phone  VARCHAR(64),
  employee_id     VARCHAR(64),
  scheduled_start TIMESTAMPTZ NOT NULL,
  scheduled_end   TIMESTAMPTZ NOT NULL,
  status          VARCHAR(32) NOT NULL DEFAULT 'scheduled',
  price           NUMERIC(15, 2) NOT NULL DEFAULT 0,
  notes           TEXT,
  created_at      TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at      TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
CREATE INDEX IF NOT EXISTS idx_appointments_window
  ON dypos.appointments (tenant_id, scheduled_start, status);

-- 3. PRODUCTION ORDERS (أوامر الإنتاج) — BOM recipes already exist
CREATE TABLE IF NOT EXISTS dypos.production_orders (
  id            VARCHAR(64) PRIMARY KEY,
  tenant_id     VARCHAR(64) NOT NULL,
  branch_id     VARCHAR(64),
  recipe_id     VARCHAR(64) REFERENCES dypos.product_recipes(id) ON DELETE SET NULL,
  product_id    VARCHAR(64) NOT NULL,
  quantity      NUMERIC(15, 3) NOT NULL CHECK (quantity > 0),
  status        VARCHAR(32) NOT NULL DEFAULT 'draft',
  planned_start TIMESTAMPTZ,
  planned_end   TIMESTAMPTZ,
  completed_qty NUMERIC(15, 3) NOT NULL DEFAULT 0,
  notes         TEXT,
  created_at    TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at    TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
CREATE INDEX IF NOT EXISTS idx_production_orders_status
  ON dypos.production_orders (tenant_id, status, created_at DESC);

-- 4. BATCHES & EXPIRY (التشغيلات والصلاحية — FEFO/FIFO)
CREATE TABLE IF NOT EXISTS dypos.product_batches (
  id              VARCHAR(64) PRIMARY KEY,
  tenant_id       VARCHAR(64) NOT NULL,
  branch_id       VARCHAR(64),
  product_id      VARCHAR(64) NOT NULL,
  batch_number    VARCHAR(128) NOT NULL,
  quantity        NUMERIC(15, 3) NOT NULL DEFAULT 0,
  cost            NUMERIC(15, 4) NOT NULL DEFAULT 0,
  expiry_date     DATE,
  production_date DATE,
  supplier_id     VARCHAR(64),
  status          VARCHAR(32) NOT NULL DEFAULT 'active',
  created_at      TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  UNIQUE (tenant_id, product_id, batch_number)
);
CREATE INDEX IF NOT EXISTS idx_batches_fefo
  ON dypos.product_batches (tenant_id, product_id, expiry_date NULLS LAST);

-- 5. SERIAL / IMEI TRACKING (الأرقام التسلسلية)
CREATE TABLE IF NOT EXISTS dypos.product_serials (
  id              VARCHAR(64) PRIMARY KEY,
  tenant_id       VARCHAR(64) NOT NULL,
  branch_id       VARCHAR(64),
  product_id      VARCHAR(64) NOT NULL,
  serial_number   VARCHAR(128) NOT NULL,
  imei            VARCHAR(64),
  status          VARCHAR(32) NOT NULL DEFAULT 'in_stock',
  warranty_end    DATE,
  sold_invoice_id VARCHAR(64),
  purchased_at    TIMESTAMPTZ DEFAULT NOW(),
  sold_at         TIMESTAMPTZ,
  created_at      TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  UNIQUE (tenant_id, product_id, serial_number)
);
CREATE INDEX IF NOT EXISTS idx_serials_lookup
  ON dypos.product_serials (tenant_id, product_id, status);

-- 6. COMMISSIONS (العمولات)
CREATE TABLE IF NOT EXISTS dypos.commissions (
  id            VARCHAR(64) PRIMARY KEY,
  tenant_id     VARCHAR(64) NOT NULL,
  employee_id   VARCHAR(64) NOT NULL,
  employee_name VARCHAR(255),
  period_year   INT NOT NULL,
  period_month  INT NOT NULL,
  base_amount   NUMERIC(15, 2) NOT NULL DEFAULT 0,
  rate          NUMERIC(7, 3)  NOT NULL DEFAULT 0,
  amount        NUMERIC(15, 2) NOT NULL DEFAULT 0,
  status        VARCHAR(32) NOT NULL DEFAULT 'accrued',
  paid_at       TIMESTAMPTZ,
  notes         TEXT,
  created_at    TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  UNIQUE (tenant_id, employee_id, period_year, period_month)
);
CREATE INDEX IF NOT EXISTS idx_commissions_period
  ON dypos.commissions (tenant_id, period_year, period_month);

-- 7. DELIVERY ORDERS (إدارة التوصيل)
CREATE TABLE IF NOT EXISTS dypos.deliveries (
  id             VARCHAR(64) PRIMARY KEY,
  tenant_id      VARCHAR(64) NOT NULL,
  branch_id      VARCHAR(64),
  invoice_id     VARCHAR(64),
  zone_id        VARCHAR(64) REFERENCES dypos.delivery_zones(id) ON DELETE SET NULL,
  customer_name  VARCHAR(255) NOT NULL,
  customer_phone VARCHAR(64),
  address        TEXT NOT NULL,
  driver_id      VARCHAR(64),
  driver_name    VARCHAR(255),
  status         VARCHAR(32) NOT NULL DEFAULT 'pending',
  fee            NUMERIC(15, 2) NOT NULL DEFAULT 0,
  amount_due     NUMERIC(15, 2) NOT NULL DEFAULT 0,
  distance_km    NUMERIC(8, 2),
  picked_at      TIMESTAMPTZ,
  delivered_at   TIMESTAMPTZ,
  notes          TEXT,
  created_at     TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at     TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
CREATE INDEX IF NOT EXISTS idx_deliveries_status
  ON dypos.deliveries (tenant_id, status, created_at DESC);

-- updated_at trigger helper + wiring
CREATE OR REPLACE FUNCTION dypos.touch_updated_at() RETURNS TRIGGER AS $$
BEGIN
  NEW.updated_at = NOW();
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

DO $$
DECLARE t TEXT;
BEGIN
  FOREACH t IN ARRAY ARRAY[
    'services','appointments','production_orders','deliveries'
  ] LOOP
    EXECUTE format('DROP TRIGGER IF EXISTS trg_%1$s_touch ON dypos.%1$I', t);
    EXECUTE format(
      'CREATE TRIGGER trg_%1$s_touch BEFORE UPDATE ON dypos.%1$I
       FOR EACH ROW EXECUTE FUNCTION dypos.touch_updated_at()', t);
  END LOOP;
END $$;

-- Seed delivery zones when the table is completely empty
INSERT INTO dypos.delivery_zones
  (id, tenant_id, branch_id, name, fee, minimum_order_amount, estimated_minutes, is_active)
SELECT v.id, v.tenant_id, v.branch_id, v.name, v.fee, v.minimum_order_amount, v.estimated_minutes, v.is_active
FROM (VALUES
  ('dz-riyadh-central', 'royal-global-hq', 'b1', 'وسط الرياض', 15.00,  50.00, 30, TRUE),
  ('dz-riyadh-north',   'royal-global-hq', 'b1', 'شمال الرياض', 22.00, 80.00, 45, TRUE),
  ('dz-riyadh-south',   'royal-global-hq', 'b1', 'جنوب الرياض', 25.00, 100.00, 55, TRUE),
  ('dz-riyadh-east',    'royal-global-hq', 'b1', 'شرق الرياض', 18.00, 60.00, 35, TRUE)
) AS v(id, tenant_id, branch_id, name, fee, minimum_order_amount, estimated_minutes, is_active)
WHERE NOT EXISTS (SELECT 1 FROM dypos.delivery_zones LIMIT 1);

COMMIT;