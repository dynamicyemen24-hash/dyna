SET search_path TO dypos, public;
/*
  DyPOS — FINAL GLOBAL PRODUCTION COMPLEMENT
  Target: PostgreSQL 14+
  Baseline: DyPOS v1.36.0 + complementary v24-v40
  Purpose: enterprise-grade additive schema hardening.

  IMPORTANT:
  - This pack is intentionally additive and avoids destructive DROP/ALTER TYPE.
  - Run first in staging, then production under a controlled migration window.
  - Existing legacy VARCHAR(64)/TEXT/REAL columns are not silently retyped here.
  - Business application cutover/backfill remains a separate migration concern.
*/





CREATE SCHEMA IF NOT EXISTS dypos;

-- ============================================================
-- 1) GLOBAL / TENANT SETTINGS
-- ============================================================

CREATE TABLE IF NOT EXISTS dypos.system_settings (
  key TEXT PRIMARY KEY,
  value_json JSONB NOT NULL DEFAULT '{}'::jsonb,
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS dypos.tenant_features (
  tenant_id VARCHAR(64) NOT NULL,
  feature_key TEXT NOT NULL,
  enabled BOOLEAN NOT NULL DEFAULT TRUE,
  config_json JSONB NOT NULL DEFAULT '{}'::jsonb,
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  PRIMARY KEY (tenant_id, feature_key)
);

-- ============================================================
-- 2) DOUBLE-ENTRY ACCOUNTING
-- ============================================================

CREATE TABLE IF NOT EXISTS dypos.accounting_periods (
  id VARCHAR(64) PRIMARY KEY DEFAULT gen_random_uuid()::text,
  tenant_id VARCHAR(64) NOT NULL,
  name TEXT NOT NULL,
  period_start DATE NOT NULL,
  period_end DATE NOT NULL,
  status TEXT NOT NULL DEFAULT 'open'
    CHECK (status IN ('open','soft_closed','closed','locked')),
  closed_at TIMESTAMPTZ,
  closed_by VARCHAR(64),
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE (tenant_id, period_start, period_end),
  CHECK (period_end >= period_start)
);

CREATE TABLE IF NOT EXISTS dypos.chart_of_accounts (
  id VARCHAR(64) PRIMARY KEY DEFAULT gen_random_uuid()::text,
  tenant_id VARCHAR(64) NOT NULL,
  parent_id VARCHAR(64) REFERENCES dypos.chart_of_accounts(id),
  code TEXT NOT NULL,
  name TEXT NOT NULL,
  account_type TEXT NOT NULL
    CHECK (account_type IN ('asset','liability','equity','revenue','expense','contra_asset','contra_revenue')),
  normal_balance TEXT NOT NULL
    CHECK (normal_balance IN ('debit','credit')),
  currency_code CHAR(3),
  is_control_account BOOLEAN NOT NULL DEFAULT FALSE,
  is_system BOOLEAN NOT NULL DEFAULT FALSE,
  is_active BOOLEAN NOT NULL DEFAULT TRUE,
  metadata JSONB NOT NULL DEFAULT '{}'::jsonb,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE (tenant_id, code)
);

CREATE TABLE IF NOT EXISTS dypos.journal_entries (
  id VARCHAR(64) PRIMARY KEY DEFAULT gen_random_uuid()::text,
  tenant_id VARCHAR(64) NOT NULL,
  branch_id VARCHAR(64),
  period_id VARCHAR(64) REFERENCES dypos.accounting_periods(id),
  entry_no BIGINT,
  entry_date DATE NOT NULL,
  source_type TEXT,
  source_id VARCHAR(64),
  description TEXT,
  status TEXT NOT NULL DEFAULT 'posted'
    CHECK (status IN ('draft','posted','reversed','void')),
  reversal_of_id VARCHAR(64) REFERENCES dypos.journal_entries(id),
  currency_code CHAR(3),
  exchange_rate NUMERIC(20,10) NOT NULL DEFAULT 1,
  idempotency_key TEXT,
  posted_at TIMESTAMPTZ,
  posted_by VARCHAR(64),
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE (tenant_id, idempotency_key)
);

CREATE TABLE IF NOT EXISTS dypos.journal_lines (
  id VARCHAR(64) PRIMARY KEY DEFAULT gen_random_uuid()::text,
  journal_entry_id VARCHAR(64) NOT NULL REFERENCES dypos.journal_entries(id) ON DELETE CASCADE,
  account_id VARCHAR(64) NOT NULL REFERENCES dypos.chart_of_accounts(id),
  line_no INTEGER NOT NULL,
  description TEXT,
  debit NUMERIC(20,6) NOT NULL DEFAULT 0,
  credit NUMERIC(20,6) NOT NULL DEFAULT 0,
  currency_code CHAR(3),
  exchange_rate NUMERIC(20,10) NOT NULL DEFAULT 1,
  dimension_json JSONB NOT NULL DEFAULT '{}'::jsonb,
  CHECK (debit >= 0 AND credit >= 0),
  CHECK ((debit = 0 AND credit > 0) OR (credit = 0 AND debit > 0)),
  UNIQUE (journal_entry_id, line_no)
);

CREATE OR REPLACE FUNCTION dypos.assert_balanced_journal()
RETURNS TRIGGER
LANGUAGE plpgsql
AS $$
DECLARE
  d NUMERIC(30,6);
  c NUMERIC(30,6);
BEGIN
  IF NEW.status = 'posted' THEN
    SELECT COALESCE(SUM(debit),0), COALESCE(SUM(credit),0)
      INTO d,c
      FROM dypos.journal_lines
     WHERE journal_entry_id = NEW.id;
    IF d <> c OR d = 0 THEN
      RAISE EXCEPTION 'Journal entry % is not balanced', NEW.id;
    END IF;
  END IF;
  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS trg_assert_balanced_journal ON dypos.journal_entries;
CREATE CONSTRAINT TRIGGER trg_assert_balanced_journal
AFTER INSERT OR UPDATE OF status ON dypos.journal_entries
DEFERRABLE INITIALLY DEFERRED
FOR EACH ROW EXECUTE FUNCTION dypos.assert_balanced_journal();

CREATE TABLE IF NOT EXISTS dypos.accounts_receivable (
  id VARCHAR(64) PRIMARY KEY DEFAULT gen_random_uuid()::text,
  tenant_id VARCHAR(64) NOT NULL,
  customer_id VARCHAR(64),
  invoice_id VARCHAR(64),
  currency_code CHAR(3) NOT NULL,
  original_amount NUMERIC(20,6) NOT NULL,
  outstanding_amount NUMERIC(20,6) NOT NULL,
  due_date DATE,
  status TEXT NOT NULL DEFAULT 'open'
    CHECK (status IN ('open','partially_paid','paid','overdue','void')),
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  CHECK (original_amount >= 0 AND outstanding_amount >= 0 AND outstanding_amount <= original_amount)
);

CREATE TABLE IF NOT EXISTS dypos.accounts_payable (
  id VARCHAR(64) PRIMARY KEY DEFAULT gen_random_uuid()::text,
  tenant_id VARCHAR(64) NOT NULL,
  supplier_id VARCHAR(64),
  document_id VARCHAR(64),
  currency_code CHAR(3) NOT NULL,
  original_amount NUMERIC(20,6) NOT NULL,
  outstanding_amount NUMERIC(20,6) NOT NULL,
  due_date DATE,
  status TEXT NOT NULL DEFAULT 'open'
    CHECK (status IN ('open','partially_paid','paid','overdue','void')),
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  CHECK (original_amount >= 0 AND outstanding_amount >= 0 AND outstanding_amount <= original_amount)
);

-- ============================================================
-- 3) CURRENCY / FX
-- ============================================================

CREATE TABLE IF NOT EXISTS dypos.currencies (
  code CHAR(3) PRIMARY KEY,
  name TEXT NOT NULL,
  symbol TEXT,
  minor_units SMALLINT NOT NULL DEFAULT 2 CHECK (minor_units BETWEEN 0 AND 6),
  is_active BOOLEAN NOT NULL DEFAULT TRUE
);

CREATE TABLE IF NOT EXISTS dypos.exchange_rates (
  id VARCHAR(64) PRIMARY KEY DEFAULT gen_random_uuid()::text,
  tenant_id VARCHAR(64) NOT NULL,
  base_currency CHAR(3) NOT NULL REFERENCES dypos.currencies(code),
  quote_currency CHAR(3) NOT NULL REFERENCES dypos.currencies(code),
  rate NUMERIC(20,10) NOT NULL CHECK (rate > 0),
  valid_from TIMESTAMPTZ NOT NULL,
  source TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE (tenant_id, base_currency, quote_currency, valid_from)
);

-- ============================================================
-- 4) UNITS / PACKAGING / CONVERSIONS
-- ============================================================

CREATE TABLE IF NOT EXISTS dypos.units_of_measure (
  code TEXT PRIMARY KEY,
  name TEXT NOT NULL,
  dimension TEXT NOT NULL,
  precision_scale SMALLINT NOT NULL DEFAULT 3 CHECK (precision_scale BETWEEN 0 AND 9),
  is_active BOOLEAN NOT NULL DEFAULT TRUE
);

CREATE TABLE IF NOT EXISTS dypos.unit_conversions (
  id VARCHAR(64) PRIMARY KEY DEFAULT gen_random_uuid()::text,
  tenant_id VARCHAR(64) NOT NULL,
  product_id VARCHAR(64),
  from_unit TEXT NOT NULL REFERENCES dypos.units_of_measure(code),
  to_unit TEXT NOT NULL REFERENCES dypos.units_of_measure(code),
  factor NUMERIC(30,12) NOT NULL CHECK (factor > 0),
  is_exact BOOLEAN NOT NULL DEFAULT TRUE,
  UNIQUE (tenant_id, product_id, from_unit, to_unit)
);

-- ============================================================
-- 5) PROMOTIONS / COUPONS / DISCOUNT GOVERNANCE
-- ============================================================

CREATE TABLE IF NOT EXISTS dypos.promotions (
  id VARCHAR(64) PRIMARY KEY DEFAULT gen_random_uuid()::text,
  tenant_id VARCHAR(64) NOT NULL,
  name TEXT NOT NULL,
  promotion_type TEXT NOT NULL
    CHECK (promotion_type IN ('percentage','fixed','buy_x_get_y','bundle','coupon','tiered')),
  priority INTEGER NOT NULL DEFAULT 100,
  stackable BOOLEAN NOT NULL DEFAULT FALSE,
  start_at TIMESTAMPTZ NOT NULL,
  end_at TIMESTAMPTZ,
  conditions_json JSONB NOT NULL DEFAULT '{}'::jsonb,
  reward_json JSONB NOT NULL DEFAULT '{}'::jsonb,
  max_redemptions BIGINT,
  max_redemptions_per_customer BIGINT,
  redemption_count BIGINT NOT NULL DEFAULT 0 CHECK (redemption_count >= 0),
  is_active BOOLEAN NOT NULL DEFAULT TRUE,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  CHECK (end_at IS NULL OR end_at >= start_at)
);

CREATE TABLE IF NOT EXISTS dypos.promotion_coupons (
  id VARCHAR(64) PRIMARY KEY DEFAULT gen_random_uuid()::text,
  tenant_id VARCHAR(64) NOT NULL,
  promotion_id VARCHAR(64) NOT NULL REFERENCES dypos.promotions(id) ON DELETE CASCADE,
  code TEXT NOT NULL,
  max_uses BIGINT,
  used_count BIGINT NOT NULL DEFAULT 0 CHECK (used_count >= 0),
  valid_from TIMESTAMPTZ,
  valid_to TIMESTAMPTZ,
  is_active BOOLEAN NOT NULL DEFAULT TRUE,
  UNIQUE (tenant_id, code)
);

CREATE TABLE IF NOT EXISTS dypos.promotion_redemptions (
  id VARCHAR(64) PRIMARY KEY DEFAULT gen_random_uuid()::text,
  tenant_id VARCHAR(64) NOT NULL,
  promotion_id VARCHAR(64) NOT NULL REFERENCES dypos.promotions(id),
  coupon_id VARCHAR(64) REFERENCES dypos.promotion_coupons(id),
  customer_id VARCHAR(64),
  invoice_id VARCHAR(64),
  discount_amount NUMERIC(20,6) NOT NULL DEFAULT 0 CHECK (discount_amount >= 0),
  redeemed_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  idempotency_key TEXT,
  UNIQUE (tenant_id, idempotency_key)
);

-- ============================================================
-- 6) PAYMENT ABSTRACTION / RECONCILIATION
-- ============================================================

CREATE TABLE IF NOT EXISTS dypos.payment_providers (
  id VARCHAR(64) PRIMARY KEY DEFAULT gen_random_uuid()::text,
  tenant_id VARCHAR(64) NOT NULL,
  provider_code TEXT NOT NULL,
  display_name TEXT NOT NULL,
  provider_type TEXT NOT NULL,
  config_ref TEXT,
  is_active BOOLEAN NOT NULL DEFAULT TRUE,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE (tenant_id, provider_code)
);

CREATE TABLE IF NOT EXISTS dypos.payment_transactions (
  id VARCHAR(64) PRIMARY KEY DEFAULT gen_random_uuid()::text,
  tenant_id VARCHAR(64) NOT NULL,
  branch_id VARCHAR(64),
  invoice_id VARCHAR(64),
  provider_id VARCHAR(64) REFERENCES dypos.payment_providers(id),
  method_code TEXT NOT NULL,
  external_transaction_id TEXT,
  idempotency_key TEXT NOT NULL,
  amount NUMERIC(20,6) NOT NULL CHECK (amount >= 0),
  currency_code CHAR(3) NOT NULL,
  status TEXT NOT NULL
    CHECK (status IN ('initiated','authorized','captured','settled','failed','voided','refunded','partially_refunded')),
  provider_payload JSONB NOT NULL DEFAULT '{}'::jsonb,
  initiated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  completed_at TIMESTAMPTZ,
  UNIQUE (tenant_id, idempotency_key),
  UNIQUE (tenant_id, provider_id, external_transaction_id)
);

CREATE TABLE IF NOT EXISTS dypos.payment_refunds (
  id VARCHAR(64) PRIMARY KEY DEFAULT gen_random_uuid()::text,
  tenant_id VARCHAR(64) NOT NULL,
  payment_transaction_id VARCHAR(64) NOT NULL REFERENCES dypos.payment_transactions(id),
  amount NUMERIC(20,6) NOT NULL CHECK (amount > 0),
  reason TEXT,
  external_refund_id TEXT,
  idempotency_key TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'completed'
    CHECK (status IN ('requested','completed','failed','cancelled')),
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE (tenant_id, idempotency_key)
);

CREATE TABLE IF NOT EXISTS dypos.payment_reconciliations (
  id VARCHAR(64) PRIMARY KEY DEFAULT gen_random_uuid()::text,
  tenant_id VARCHAR(64) NOT NULL,
  provider_id VARCHAR(64) REFERENCES dypos.payment_providers(id),
  statement_ref TEXT,
  period_start TIMESTAMPTZ NOT NULL,
  period_end TIMESTAMPTZ NOT NULL,
  expected_amount NUMERIC(20,6) NOT NULL DEFAULT 0,
  settled_amount NUMERIC(20,6) NOT NULL DEFAULT 0,
  difference_amount NUMERIC(20,6) NOT NULL DEFAULT 0,
  status TEXT NOT NULL DEFAULT 'open'
    CHECK (status IN ('open','matched','partial','exception','closed')),
  notes TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  CHECK (period_end >= period_start)
);

-- ============================================================
-- 7) ORDER / RESERVATION / DELIVERY
-- ============================================================

CREATE TABLE IF NOT EXISTS dypos.orders (
  id VARCHAR(64) PRIMARY KEY DEFAULT gen_random_uuid()::text,
  tenant_id VARCHAR(64) NOT NULL,
  branch_id VARCHAR(64),
  customer_id VARCHAR(64),
  order_no BIGINT,
  order_type TEXT NOT NULL
    CHECK (order_type IN ('sale','pickup','delivery','dine_in','reservation','service')),
  status TEXT NOT NULL DEFAULT 'draft'
    CHECK (status IN ('draft','confirmed','preparing','ready','dispatched','completed','cancelled','failed')),
  source TEXT,
  scheduled_at TIMESTAMPTZ,
  delivery_address_json JSONB,
  notes TEXT,
  total_amount NUMERIC(20,6) NOT NULL DEFAULT 0,
  currency_code CHAR(3),
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS dypos.order_items (
  id VARCHAR(64) PRIMARY KEY DEFAULT gen_random_uuid()::text,
  order_id VARCHAR(64) NOT NULL REFERENCES dypos.orders(id) ON DELETE CASCADE,
  line_no INTEGER NOT NULL,
  product_id VARCHAR(64),
  description TEXT,
  quantity NUMERIC(20,6) NOT NULL CHECK (quantity > 0),
  unit_price NUMERIC(20,6) NOT NULL CHECK (unit_price >= 0),
  discount_amount NUMERIC(20,6) NOT NULL DEFAULT 0 CHECK (discount_amount >= 0),
  tax_amount NUMERIC(20,6) NOT NULL DEFAULT 0 CHECK (tax_amount >= 0),
  total_amount NUMERIC(20,6) NOT NULL CHECK (total_amount >= 0),
  UNIQUE (order_id, line_no)
);

CREATE TABLE IF NOT EXISTS dypos.reservations (
  id VARCHAR(64) PRIMARY KEY DEFAULT gen_random_uuid()::text,
  tenant_id VARCHAR(64) NOT NULL,
  branch_id VARCHAR(64),
  customer_id VARCHAR(64),
  resource_type TEXT NOT NULL,
  resource_id VARCHAR(64),
  starts_at TIMESTAMPTZ NOT NULL,
  ends_at TIMESTAMPTZ NOT NULL,
  party_size INTEGER,
  status TEXT NOT NULL DEFAULT 'pending'
    CHECK (status IN ('pending','confirmed','seated','completed','cancelled','no_show')),
  notes TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  CHECK (ends_at > starts_at)
);

CREATE TABLE IF NOT EXISTS dypos.delivery_zones (
  id VARCHAR(64) PRIMARY KEY DEFAULT gen_random_uuid()::text,
  tenant_id VARCHAR(64) NOT NULL,
  branch_id VARCHAR(64),
  name TEXT NOT NULL,
  fee NUMERIC(20,6) NOT NULL DEFAULT 0 CHECK (fee >= 0),
  minimum_order_amount NUMERIC(20,6) NOT NULL DEFAULT 0 CHECK (minimum_order_amount >= 0),
  estimated_minutes INTEGER,
  is_active BOOLEAN NOT NULL DEFAULT TRUE,
  UNIQUE (tenant_id, branch_id, name)
);

CREATE TABLE IF NOT EXISTS dypos.deliveries (
  id VARCHAR(64) PRIMARY KEY DEFAULT gen_random_uuid()::text,
  tenant_id VARCHAR(64) NOT NULL,
  order_id VARCHAR(64) NOT NULL REFERENCES dypos.orders(id),
  zone_id VARCHAR(64) REFERENCES dypos.delivery_zones(id),
  driver_id VARCHAR(64),
  address_json JSONB NOT NULL DEFAULT '{}'::jsonb,
  status TEXT NOT NULL DEFAULT 'pending'
    CHECK (status IN ('pending','assigned','picked_up','in_transit','delivered','failed','cancelled')),
  fee NUMERIC(20,6) NOT NULL DEFAULT 0 CHECK (fee >= 0),
  dispatched_at TIMESTAMPTZ,
  delivered_at TIMESTAMPTZ,
  proof_json JSONB NOT NULL DEFAULT '{}'::jsonb,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- ============================================================
-- 8) RESTAURANT KDS
-- ============================================================

CREATE TABLE IF NOT EXISTS dypos.kitchen_stations (
  id VARCHAR(64) PRIMARY KEY DEFAULT gen_random_uuid()::text,
  tenant_id VARCHAR(64) NOT NULL,
  branch_id VARCHAR(64),
  code TEXT NOT NULL,
  name TEXT NOT NULL,
  station_type TEXT NOT NULL,
  is_active BOOLEAN NOT NULL DEFAULT TRUE,
  UNIQUE (tenant_id, branch_id, code)
);

CREATE TABLE IF NOT EXISTS dypos.kitchen_tickets (
  id VARCHAR(64) PRIMARY KEY DEFAULT gen_random_uuid()::text,
  tenant_id VARCHAR(64) NOT NULL,
  branch_id VARCHAR(64),
  order_id VARCHAR(64) REFERENCES dypos.orders(id),
  station_id VARCHAR(64) REFERENCES dypos.kitchen_stations(id),
  ticket_no BIGINT,
  status TEXT NOT NULL DEFAULT 'queued'
    CHECK (status IN ('queued','accepted','preparing','ready','served','cancelled')),
  priority INTEGER NOT NULL DEFAULT 100,
  queued_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  started_at TIMESTAMPTZ,
  ready_at TIMESTAMPTZ,
  served_at TIMESTAMPTZ,
  metadata JSONB NOT NULL DEFAULT '{}'::jsonb
);

CREATE TABLE IF NOT EXISTS dypos.kitchen_ticket_items (
  id VARCHAR(64) PRIMARY KEY DEFAULT gen_random_uuid()::text,
  ticket_id VARCHAR(64) NOT NULL REFERENCES dypos.kitchen_tickets(id) ON DELETE CASCADE,
  order_item_id VARCHAR(64),
  product_id VARCHAR(64),
  quantity NUMERIC(20,6) NOT NULL CHECK (quantity > 0),
  status TEXT NOT NULL DEFAULT 'queued'
    CHECK (status IN ('queued','preparing','ready','served','cancelled')),
  modifiers_json JSONB NOT NULL DEFAULT '{}'::jsonb
);

-- ============================================================
-- 9) DEVICE / OFFLINE-FIRST / SYNC HARDENING
-- ============================================================

CREATE TABLE IF NOT EXISTS dypos.devices (
  id VARCHAR(64) PRIMARY KEY DEFAULT gen_random_uuid()::text,
  tenant_id VARCHAR(64) NOT NULL,
  branch_id VARCHAR(64),
  terminal_id VARCHAR(64),
  device_uid TEXT NOT NULL,
  device_type TEXT NOT NULL,
  public_key TEXT,
  status TEXT NOT NULL DEFAULT 'active'
    CHECK (status IN ('pending','active','revoked','quarantined')),
  last_seen_at TIMESTAMPTZ,
  registered_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  metadata JSONB NOT NULL DEFAULT '{}'::jsonb,
  UNIQUE (tenant_id, device_uid)
);

CREATE TABLE IF NOT EXISTS dypos.sync_batches (
  id VARCHAR(64) PRIMARY KEY DEFAULT gen_random_uuid()::text,
  tenant_id VARCHAR(64) NOT NULL,
  device_id VARCHAR(64) REFERENCES dypos.devices(id),
  batch_no BIGINT NOT NULL,
  direction TEXT NOT NULL CHECK (direction IN ('upload','download')),
  started_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  completed_at TIMESTAMPTZ,
  status TEXT NOT NULL DEFAULT 'started'
    CHECK (status IN ('started','completed','partial','failed','quarantined')),
  item_count INTEGER NOT NULL DEFAULT 0,
  checksum TEXT,
  UNIQUE (tenant_id, device_id, batch_no, direction)
);

CREATE TABLE IF NOT EXISTS dypos.sync_operations (
  id VARCHAR(64) PRIMARY KEY DEFAULT gen_random_uuid()::text,
  tenant_id VARCHAR(64) NOT NULL,
  batch_id VARCHAR(64) REFERENCES dypos.sync_batches(id) ON DELETE CASCADE,
  device_id VARCHAR(64) REFERENCES dypos.devices(id),
  sequence_no BIGINT NOT NULL,
  entity_type TEXT NOT NULL,
  entity_id VARCHAR(64),
  operation TEXT NOT NULL CHECK (operation IN ('create','update','delete')),
  payload JSONB NOT NULL,
  payload_hash TEXT NOT NULL,
  occurred_at TIMESTAMPTZ NOT NULL,
  applied_at TIMESTAMPTZ,
  status TEXT NOT NULL DEFAULT 'pending'
    CHECK (status IN ('pending','applied','rejected','conflict','quarantined')),
  error_code TEXT,
  UNIQUE (tenant_id, device_id, sequence_no)
);

CREATE TABLE IF NOT EXISTS dypos.sync_tombstones (
  tenant_id VARCHAR(64) NOT NULL,
  entity_type TEXT NOT NULL,
  entity_id VARCHAR(64) NOT NULL,
  deleted_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  device_id VARCHAR(64),
  PRIMARY KEY (tenant_id, entity_type, entity_id)
);

CREATE TABLE IF NOT EXISTS dypos.sync_conflict_resolutions (
  id VARCHAR(64) PRIMARY KEY DEFAULT gen_random_uuid()::text,
  tenant_id VARCHAR(64) NOT NULL,
  conflict_id VARCHAR(64) NOT NULL,
  resolution TEXT NOT NULL CHECK (resolution IN ('server_wins','client_wins','merge','reject','manual')),
  resolved_by VARCHAR(64),
  resolved_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  notes TEXT
);

-- ============================================================
-- 10) AUDIT / SECURITY / DATA GOVERNANCE
-- ============================================================

CREATE TABLE IF NOT EXISTS dypos.audit_log (
  id BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  tenant_id VARCHAR(64),
  branch_id VARCHAR(64),
  actor_user_id VARCHAR(64),
  device_id VARCHAR(64),
  request_id TEXT,
  action TEXT NOT NULL,
  entity_type TEXT NOT NULL,
  entity_id VARCHAR(64),
  before_json JSONB,
  after_json JSONB,
  reason TEXT,
  ip INET,
  user_agent TEXT,
  occurred_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS dypos.security_events (
  id BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  tenant_id VARCHAR(64),
  actor_user_id VARCHAR(64),
  device_id VARCHAR(64),
  event_type TEXT NOT NULL,
  severity TEXT NOT NULL DEFAULT 'info'
    CHECK (severity IN ('info','low','medium','high','critical')),
  request_id TEXT,
  ip INET,
  details JSONB NOT NULL DEFAULT '{}'::jsonb,
  occurred_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS dypos.data_retention_policies (
  id VARCHAR(64) PRIMARY KEY DEFAULT gen_random_uuid()::text,
  tenant_id VARCHAR(64) NOT NULL,
  entity_type TEXT NOT NULL,
  retention_days INTEGER NOT NULL CHECK (retention_days >= 0),
  archive_after_days INTEGER,
  legal_hold BOOLEAN NOT NULL DEFAULT FALSE,
  is_active BOOLEAN NOT NULL DEFAULT TRUE,
  UNIQUE (tenant_id, entity_type)
);

-- ============================================================
-- 11) NOTIFICATIONS / OPERATIONAL ALERTS
-- ============================================================

CREATE TABLE IF NOT EXISTS dypos.notifications (
  id VARCHAR(64) PRIMARY KEY DEFAULT gen_random_uuid()::text,
  tenant_id VARCHAR(64) NOT NULL,
  user_id VARCHAR(64),
  type TEXT NOT NULL,
  title TEXT NOT NULL,
  body TEXT,
  severity TEXT NOT NULL DEFAULT 'info'
    CHECK (severity IN ('info','success','warning','error','critical')),
  channel TEXT NOT NULL DEFAULT 'in_app'
    CHECK (channel IN ('in_app','email','sms','push','webhook')),
  status TEXT NOT NULL DEFAULT 'queued'
    CHECK (status IN ('queued','sent','delivered','failed','read','cancelled')),
  data_json JSONB NOT NULL DEFAULT '{}'::jsonb,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  read_at TIMESTAMPTZ
);

CREATE TABLE IF NOT EXISTS dypos.notification_outbox (
  id VARCHAR(64) PRIMARY KEY DEFAULT gen_random_uuid()::text,
  tenant_id VARCHAR(64) NOT NULL,
  notification_id VARCHAR(64) REFERENCES dypos.notifications(id) ON DELETE CASCADE,
  channel TEXT NOT NULL,
  destination TEXT,
  payload JSONB NOT NULL,
  attempts INTEGER NOT NULL DEFAULT 0 CHECK (attempts >= 0),
  next_attempt_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  status TEXT NOT NULL DEFAULT 'pending'
    CHECK (status IN ('pending','processing','sent','failed','dead_letter')),
  last_error TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- ============================================================
-- 12) INTEGRATION / WEBHOOK / OUTBOX
-- ============================================================

CREATE TABLE IF NOT EXISTS dypos.integration_endpoints (
  id VARCHAR(64) PRIMARY KEY DEFAULT gen_random_uuid()::text,
  tenant_id VARCHAR(64) NOT NULL,
  name TEXT NOT NULL,
  endpoint_type TEXT NOT NULL,
  base_url TEXT,
  secret_ref TEXT,
  enabled BOOLEAN NOT NULL DEFAULT TRUE,
  config_json JSONB NOT NULL DEFAULT '{}'::jsonb,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE (tenant_id, name)
);

CREATE TABLE IF NOT EXISTS dypos.integration_outbox (
  id VARCHAR(64) PRIMARY KEY DEFAULT gen_random_uuid()::text,
  tenant_id VARCHAR(64) NOT NULL,
  endpoint_id VARCHAR(64) REFERENCES dypos.integration_endpoints(id),
  event_type TEXT NOT NULL,
  aggregate_type TEXT,
  aggregate_id VARCHAR(64),
  payload JSONB NOT NULL,
  idempotency_key TEXT NOT NULL,
  attempts INTEGER NOT NULL DEFAULT 0,
  next_attempt_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  status TEXT NOT NULL DEFAULT 'pending'
    CHECK (status IN ('pending','processing','sent','failed','dead_letter')),
  last_error TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  sent_at TIMESTAMPTZ,
  UNIQUE (tenant_id, idempotency_key)
);

CREATE TABLE IF NOT EXISTS dypos.integration_inbox (
  id VARCHAR(64) PRIMARY KEY DEFAULT gen_random_uuid()::text,
  tenant_id VARCHAR(64) NOT NULL,
  endpoint_id VARCHAR(64) REFERENCES dypos.integration_endpoints(id),
  external_event_id TEXT NOT NULL,
  event_type TEXT,
  payload JSONB NOT NULL,
  received_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  processed_at TIMESTAMPTZ,
  status TEXT NOT NULL DEFAULT 'received'
    CHECK (status IN ('received','processed','failed','ignored')),
  error TEXT,
  UNIQUE (tenant_id, endpoint_id, external_event_id)
);

-- ============================================================
-- 13) ROW-LEVEL SECURITY FOUNDATION
-- ============================================================

CREATE OR REPLACE FUNCTION dypos.current_tenant_id()
RETURNS VARCHAR(64)
LANGUAGE sql
STABLE
AS $$
  SELECT NULLIF(current_setting('app.tenant_id', true), '')
$$;

-- Enable RLS on core new tenant-scoped tables.
DO $$
DECLARE
  t TEXT;
BEGIN
  FOREACH t IN ARRAY ARRAY[
    'tenant_features','accounting_periods','chart_of_accounts',
    'journal_entries','accounts_receivable','accounts_payable',
    'exchange_rates','unit_conversions','promotions','promotion_coupons',
    'promotion_redemptions','payment_providers','payment_transactions',
    'payment_refunds','payment_reconciliations','orders','reservations',
    'delivery_zones','deliveries','kitchen_stations','kitchen_tickets',
    'devices','sync_batches','sync_operations','sync_tombstones',
    'sync_conflict_resolutions','audit_log','security_events',
    'data_retention_policies','notifications','notification_outbox',
    'integration_endpoints','integration_outbox','integration_inbox'
  ]
  LOOP
    EXECUTE format('ALTER TABLE dypos.%I ENABLE ROW LEVEL SECURITY', t);
    EXECUTE format('DROP POLICY IF EXISTS tenant_isolation ON dypos.%I', t);
    EXECUTE format(
      'CREATE POLICY tenant_isolation ON dypos.%I USING (tenant_id = dypos.current_tenant_id()) WITH CHECK (tenant_id = dypos.current_tenant_id())',
      t
    );
  END LOOP;
END $$;

-- journal_lines inherit tenant isolation through parent entry in application logic;
-- direct RLS is intentionally omitted because tenant_id is not duplicated.

-- ============================================================
-- 14) INDEXES
-- ============================================================

CREATE INDEX IF NOT EXISTS idx_journal_entries_tenant_date
  ON dypos.journal_entries(tenant_id, entry_date, id);

CREATE INDEX IF NOT EXISTS idx_journal_lines_account
  ON dypos.journal_lines(account_id, journal_entry_id);

CREATE INDEX IF NOT EXISTS idx_ar_customer_status
  ON dypos.accounts_receivable(tenant_id, customer_id, status);

CREATE INDEX IF NOT EXISTS idx_ap_supplier_status
  ON dypos.accounts_payable(tenant_id, supplier_id, status);

CREATE INDEX IF NOT EXISTS idx_fx_lookup
  ON dypos.exchange_rates(tenant_id, base_currency, quote_currency, valid_from DESC);

CREATE INDEX IF NOT EXISTS idx_promotions_active_window
  ON dypos.promotions(tenant_id, is_active, start_at, end_at);

CREATE INDEX IF NOT EXISTS idx_payment_tx_invoice
  ON dypos.payment_transactions(tenant_id, invoice_id, status);

CREATE INDEX IF NOT EXISTS idx_payment_tx_external
  ON dypos.payment_transactions(tenant_id, external_transaction_id);

CREATE INDEX IF NOT EXISTS idx_orders_status
  ON dypos.orders(tenant_id, branch_id, status, created_at DESC);

CREATE INDEX IF NOT EXISTS idx_reservations_resource_time
  ON dypos.reservations(tenant_id, resource_type, resource_id, starts_at, ends_at);

CREATE INDEX IF NOT EXISTS idx_deliveries_status
  ON dypos.deliveries(tenant_id, status, created_at DESC);

CREATE INDEX IF NOT EXISTS idx_kitchen_tickets_station_status
  ON dypos.kitchen_tickets(tenant_id, station_id, status, queued_at);

CREATE INDEX IF NOT EXISTS idx_sync_ops_pending
  ON dypos.sync_operations(tenant_id, device_id, status, sequence_no);

CREATE INDEX IF NOT EXISTS idx_audit_tenant_time
  ON dypos.audit_log(tenant_id, occurred_at DESC);

CREATE INDEX IF NOT EXISTS idx_security_events_tenant_time
  ON dypos.security_events(tenant_id, occurred_at DESC);

CREATE INDEX IF NOT EXISTS idx_outbox_pending
  ON dypos.integration_outbox(status, next_attempt_at);

CREATE INDEX IF NOT EXISTS idx_inbox_status
  ON dypos.integration_inbox(tenant_id, status, received_at);

-- ============================================================
-- 15) GENERIC UPDATED_AT
-- ============================================================

CREATE OR REPLACE FUNCTION dypos.set_updated_at()
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
    'system_settings','tenant_features','chart_of_accounts',
    'promotions','orders'
  ]
  LOOP
    EXECUTE format('DROP TRIGGER IF EXISTS trg_%s_updated_at ON dypos.%I', t, t);
    EXECUTE format(
      'CREATE TRIGGER trg_%s_updated_at BEFORE UPDATE ON dypos.%I FOR EACH ROW EXECUTE FUNCTION dypos.set_updated_at()',
      t, t
    );
  END LOOP;
END $$;

-- ============================================================
-- 16) MIGRATION REGISTRY
-- ============================================================

CREATE TABLE IF NOT EXISTS dypos.schema_migrations (
  version TEXT PRIMARY KEY,
  applied_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  checksum TEXT,
  description TEXT
);

INSERT INTO dypos.schema_migrations(version, checksum, description)
VALUES
(
  'global-production-complement-v41-v100',
  md5('DyPOS final global production complement v41-v100'),
  'Accounting, FX, units, promotions, payments, orders, KDS, offline hardening, audit, RLS, outbox and governance'
)
ON CONFLICT (version) DO NOTHING;



/*
  PRODUCTION CUTOVER CHECKLIST
  1. Backup + restore test.
  2. Execute in staging against a production-like copy.
  3. Validate existing application migrations and table names before enabling FK backfills.
  4. Configure app.tenant_id per authenticated request/transaction before querying RLS tables.
  5. Seed currencies/UOM/chart of accounts.
  6. Backfill AR/AP/promotions/payment/order data only after mapping legacy IDs.
  7. Generate journal entries in application service/transaction boundaries; never trust client totals.
  8. Add application-level authorization in addition to PostgreSQL RLS.
  9. Monitor dead-letter/outbox/sync/audit growth and define retention policies.
  10. Partition very large append-only tables after measuring production volume.
*/
