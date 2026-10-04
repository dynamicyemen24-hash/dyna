SET search_path TO dypos, public;
/*
===============================================================================
DyPOS — GLOBAL PRODUCTION DATABASE ENGINE PACK
Companion to:
  dypos_final_global_production_complement_v41_v100.sql

Target:
  PostgreSQL 14+

Scope:
  Views + materialized views + functions + procedures + triggers + audit +
  validation + accounting posting + outbox workers + sync safeguards +
  operational indexes + health views + maintenance helpers.

Design:
  - Additive and idempotent where practical.
  - No destructive changes to legacy application tables.
  - Uses only objects introduced by the v41-v100 complement pack.
  - Application authorization remains mandatory in addition to RLS.
===============================================================================
*/



CREATE SCHEMA IF NOT EXISTS dypos;

-- ============================================================================
-- 1. COMMON FUNCTIONS
-- ============================================================================

CREATE OR REPLACE FUNCTION dypos.touch_updated_at()
RETURNS TRIGGER
LANGUAGE plpgsql
AS $$
BEGIN
  IF TG_OP = 'UPDATE' THEN
    NEW.updated_at := clock_timestamp();
  END IF;
  RETURN NEW;
END;
$$;

CREATE OR REPLACE FUNCTION dypos.current_tenant_id()
RETURNS VARCHAR(64)
LANGUAGE sql
STABLE
AS $$
  SELECT NULLIF(current_setting('app.tenant_id', true), '')
$$;

CREATE OR REPLACE FUNCTION dypos.current_request_id()
RETURNS TEXT
LANGUAGE sql
STABLE
AS $$
  SELECT NULLIF(current_setting('app.request_id', true), '')
$$;

CREATE OR REPLACE FUNCTION dypos.require_tenant_context()
RETURNS VARCHAR(64)
LANGUAGE plpgsql
STABLE
AS $$
DECLARE
  v VARCHAR(64);
BEGIN
  v := dypos.current_tenant_id();
  IF v IS NULL THEN
    RAISE EXCEPTION 'DyPOS tenant context is required';
  END IF;
  RETURN v;
END;
$$;

CREATE OR REPLACE FUNCTION dypos.jsonb_sha256(p_payload JSONB)
RETURNS TEXT
LANGUAGE sql
IMMUTABLE
AS $$
  SELECT encode(digest(convert_to(p_payload::text, 'UTF8'), 'sha256'), 'hex')
$$;

-- ============================================================================
-- 2. AUDIT ENGINE
-- ============================================================================

CREATE OR REPLACE FUNCTION dypos.audit_row_change()
RETURNS TRIGGER
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = dypos, public
AS $$
DECLARE
  v_old JSONB;
  v_new JSONB;
  v_entity_id VARCHAR(64);
  v_tenant VARCHAR(64);
  v_action TEXT;
BEGIN
  IF TG_OP = 'INSERT' THEN
    v_old := NULL;
    v_new := to_jsonb(NEW);
    v_action := 'create';
  ELSIF TG_OP = 'UPDATE' THEN
    v_old := to_jsonb(OLD);
    v_new := to_jsonb(NEW);
    v_action := 'update';
  ELSE
    v_old := to_jsonb(OLD);
    v_new := NULL;
    v_action := 'delete';
  END IF;

  v_tenant := COALESCE(
    NULLIF((COALESCE(v_new, v_old)->>'tenant_id'), '')::VARCHAR(64),
    dypos.current_tenant_id()
  );

  BEGIN
    v_entity_id := NULLIF((COALESCE(v_new, v_old)->>'id'), '')::VARCHAR(64);
  EXCEPTION WHEN invalid_text_representation THEN
    v_entity_id := NULL;
  END;

  INSERT INTO dypos.audit_log
    (tenant_id, actor_user_id, device_id, request_id,
     action, entity_type, entity_id, before_json, after_json, occurred_at)
  VALUES
    (v_tenant, 
     NULLIF(current_setting('app.user_id', true), '')::VARCHAR(64),
     NULLIF(current_setting('app.device_id', true), '')::VARCHAR(64),
     dypos.current_request_id(),
     v_action, TG_TABLE_SCHEMA || '.' || TG_TABLE_NAME, v_entity_id,
     v_old, v_new, clock_timestamp());

  RETURN COALESCE(NEW, OLD);
END;
$$;

-- Audit the mutable business tables introduced by the production pack.
DO $$
DECLARE
  t TEXT;
BEGIN
  FOREACH t IN ARRAY ARRAY[
    'tenant_features',
    'accounting_periods',
    'chart_of_accounts',
    'journal_entries',
    'accounts_receivable',
    'accounts_payable',
    'exchange_rates',
    'unit_conversions',
    'promotions',
    'promotion_coupons',
    'promotion_redemptions',
    'payment_providers',
    'payment_transactions',
    'payment_refunds',
    'payment_reconciliations',
    'orders',
    'order_items',
    'reservations',
    'delivery_zones',
    'deliveries',
    'kitchen_stations',
    'kitchen_tickets',
    'kitchen_ticket_items',
    'devices',
    'sync_batches',
    'sync_operations',
    'sync_tombstones',
    'sync_conflict_resolutions',
    'data_retention_policies',
    'notifications',
    'notification_outbox',
    'integration_endpoints',
    'integration_outbox',
    'integration_inbox'
  ]
  LOOP
    EXECUTE format('DROP TRIGGER IF EXISTS trg_audit_%I ON dypos.%I', t, t);
    EXECUTE format(
      'CREATE TRIGGER trg_audit_%I
       AFTER INSERT OR UPDATE OR DELETE ON dypos.%I
       FOR EACH ROW EXECUTE FUNCTION dypos.audit_row_change()',
      t, t
    );
  END LOOP;
END $$;

-- ============================================================================
-- 3. RLS HARDENING
-- ============================================================================

ALTER TABLE dypos.journal_lines ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS tenant_isolation ON dypos.journal_lines;

CREATE POLICY tenant_isolation ON dypos.journal_lines
USING (
  EXISTS (
    SELECT 1
      FROM dypos.journal_entries je
     WHERE je.id = journal_lines.journal_entry_id
       AND je.tenant_id = dypos.current_tenant_id()
  )
)
WITH CHECK (
  EXISTS (
    SELECT 1
      FROM dypos.journal_entries je
     WHERE je.id = journal_lines.journal_entry_id
       AND je.tenant_id = dypos.current_tenant_id()
  )
);

-- ============================================================================
-- 4. ACCOUNTING VALIDATION / POSTING
-- ============================================================================

CREATE OR REPLACE FUNCTION dypos.validate_journal_entry(p_entry_id VARCHAR(64))
RETURNS BOOLEAN
LANGUAGE plpgsql
STABLE
AS $$
DECLARE
  v_tenant VARCHAR(64);
  v_debit NUMERIC(30,6);
  v_credit NUMERIC(30,6);
  v_count BIGINT;
  v_status TEXT;
BEGIN
  SELECT tenant_id, status
    INTO v_tenant, v_status
    FROM dypos.journal_entries
   WHERE id = p_entry_id;

  IF v_tenant IS NULL THEN
    RAISE EXCEPTION 'Journal entry % does not exist', p_entry_id;
  END IF;

  IF dypos.current_tenant_id() IS NOT NULL
     AND v_tenant <> dypos.current_tenant_id() THEN
    RAISE EXCEPTION 'Cross-tenant journal access denied';
  END IF;

  SELECT COUNT(*), COALESCE(SUM(debit),0), COALESCE(SUM(credit),0)
    INTO v_count, v_debit, v_credit
    FROM dypos.journal_lines
   WHERE journal_entry_id = p_entry_id;

  IF v_status = 'posted' AND (v_count < 2 OR v_debit = 0 OR v_debit <> v_credit) THEN
    RETURN FALSE;
  END IF;

  RETURN TRUE;
END;
$$;

CREATE OR REPLACE PROCEDURE dypos.post_journal_entry(
  p_entry_id VARCHAR(64),
  p_posted_by VARCHAR(64) DEFAULT NULL
)
LANGUAGE plpgsql
AS $$
DECLARE
  v_period_status TEXT;
  v_entry_date DATE;
BEGIN
  SELECT ap.status, je.entry_date
    INTO v_period_status, v_entry_date
    FROM dypos.journal_entries je
    LEFT JOIN dypos.accounting_periods ap ON ap.id = je.period_id
   WHERE je.id = p_entry_id
   FOR UPDATE;

  IF NOT FOUND THEN
    RAISE EXCEPTION 'Journal entry % not found', p_entry_id;
  END IF;

  IF v_period_status IS NOT NULL AND v_period_status <> 'open' THEN
    RAISE EXCEPTION 'Accounting period is not open';
  END IF;

  IF NOT dypos.validate_journal_entry(p_entry_id) THEN
    RAISE EXCEPTION 'Journal entry % is not balanced or has insufficient lines', p_entry_id;
  END IF;

  UPDATE dypos.journal_entries
     SET status = 'posted',
         posted_at = clock_timestamp(),
         posted_by = p_posted_by
   WHERE id = p_entry_id;
END;
$$;

CREATE OR REPLACE PROCEDURE dypos.reverse_journal_entry(
  p_entry_id VARCHAR(64),
  p_reason TEXT DEFAULT NULL,
  p_posted_by VARCHAR(64) DEFAULT NULL
)
LANGUAGE plpgsql
AS $$
DECLARE
  v_new VARCHAR(64);
  v_tenant VARCHAR(64);
BEGIN
  SELECT tenant_id INTO v_tenant
    FROM dypos.journal_entries
   WHERE id = p_entry_id
   FOR UPDATE;

  IF NOT FOUND THEN
    RAISE EXCEPTION 'Journal entry % not found', p_entry_id;
  END IF;

  IF EXISTS (
    SELECT 1 FROM dypos.journal_entries
     WHERE reversal_of_id = p_entry_id
  ) THEN
    RAISE EXCEPTION 'Journal entry % already reversed', p_entry_id;
  END IF;

  INSERT INTO dypos.journal_entries
    (tenant_id, branch_id, period_id, entry_date, source_type, source_id,
     description, status, reversal_of_id, currency_code, exchange_rate,
     posted_by, posted_at)
  SELECT tenant_id, branch_id, period_id, CURRENT_DATE,
         'reversal', id,
         COALESCE(p_reason, 'Reversal'),
         'draft', id, currency_code, exchange_rate,
         p_posted_by, NULL
    FROM dypos.journal_entries
   WHERE id = p_entry_id
  RETURNING id INTO v_new;

  INSERT INTO dypos.journal_lines
    (journal_entry_id, account_id, line_no, description,
     debit, credit, currency_code, exchange_rate, dimension_json)
  SELECT v_new, account_id, line_no, description,
         credit, debit, currency_code, exchange_rate, dimension_json
    FROM dypos.journal_lines
   WHERE journal_entry_id = p_entry_id;

  CALL dypos.post_journal_entry(v_new, p_posted_by);

  UPDATE dypos.journal_entries
     SET status = 'reversed'
   WHERE id = p_entry_id;
END;
$$;

CREATE OR REPLACE FUNCTION dypos.account_balance(
  p_account_id VARCHAR(64),
  p_as_of DATE DEFAULT CURRENT_DATE
)
RETURNS NUMERIC(30,6)
LANGUAGE sql
STABLE
AS $$
  SELECT COALESCE(SUM(jl.debit - jl.credit), 0)
    FROM dypos.journal_lines jl
    JOIN dypos.journal_entries je ON je.id = jl.journal_entry_id
   WHERE jl.account_id = p_account_id
     AND je.status = 'posted'
     AND je.entry_date <= p_as_of
$$;

-- ============================================================================
-- 5. ACCOUNTING VIEWS
-- ============================================================================

CREATE OR REPLACE VIEW dypos.v_trial_balance AS
SELECT
  je.tenant_id,
  jl.account_id,
  coa.code,
  coa.name,
  coa.account_type,
  COALESCE(SUM(jl.debit),0) AS total_debit,
  COALESCE(SUM(jl.credit),0) AS total_credit,
  COALESCE(SUM(jl.debit - jl.credit),0) AS balance
FROM dypos.journal_entries je
JOIN dypos.journal_lines jl ON jl.journal_entry_id = je.id
JOIN dypos.chart_of_accounts coa ON coa.id = jl.account_id
WHERE je.status = 'posted'
GROUP BY je.tenant_id, jl.account_id, coa.code, coa.name, coa.account_type;

CREATE OR REPLACE VIEW dypos.v_general_ledger AS
SELECT
  je.tenant_id,
  je.id AS journal_entry_id,
  je.entry_no,
  je.entry_date,
  coa.code AS account_code,
  coa.name AS account_name,
  jl.line_no,
  jl.description AS line_description,
  jl.debit,
  jl.credit,
  jl.currency_code,
  je.source_type,
  je.source_id
FROM dypos.journal_entries je
JOIN dypos.journal_lines jl ON jl.journal_entry_id = je.id
JOIN dypos.chart_of_accounts coa ON coa.id = jl.account_id
WHERE je.status = 'posted';

CREATE OR REPLACE VIEW dypos.v_ar_aging AS
SELECT
  ar.tenant_id,
  ar.customer_id,
  ar.currency_code,
  ar.id,
  ar.original_amount,
  ar.outstanding_amount,
  ar.due_date,
  CASE
    WHEN ar.due_date IS NULL THEN 'undated'
    WHEN ar.due_date >= CURRENT_DATE THEN 'current'
    WHEN CURRENT_DATE - ar.due_date <= 30 THEN '1_30'
    WHEN CURRENT_DATE - ar.due_date <= 60 THEN '31_60'
    WHEN CURRENT_DATE - ar.due_date <= 90 THEN '61_90'
    ELSE '90_plus'
  END AS aging_bucket,
  ar.status
FROM dypos.accounts_receivable ar
WHERE ar.status NOT IN ('paid','void');

CREATE OR REPLACE VIEW dypos.v_ap_aging AS
SELECT
  ap.tenant_id,
  ap.supplier_id,
  ap.currency_code,
  ap.id,
  ap.original_amount,
  ap.outstanding_amount,
  ap.due_date,
  CASE
    WHEN ap.due_date IS NULL THEN 'undated'
    WHEN ap.due_date >= CURRENT_DATE THEN 'current'
    WHEN CURRENT_DATE - ap.due_date <= 30 THEN '1_30'
    WHEN CURRENT_DATE - ap.due_date <= 60 THEN '31_60'
    WHEN CURRENT_DATE - ap.due_date <= 90 THEN '61_90'
    ELSE '90_plus'
  END AS aging_bucket,
  ap.status
FROM dypos.accounts_payable ap
WHERE ap.status NOT IN ('paid','void');

-- ============================================================================
-- 6. OPERATIONAL VIEWS
-- ============================================================================

CREATE OR REPLACE VIEW dypos.v_payment_summary AS
SELECT
  tenant_id,
  currency_code,
  method_code,
  status,
  COUNT(*) AS transaction_count,
  SUM(amount) AS amount
FROM dypos.payment_transactions
GROUP BY tenant_id, currency_code, method_code, status;

CREATE OR REPLACE VIEW dypos.v_order_summary AS
SELECT
  tenant_id,
  branch_id,
  status,
  order_type,
  COUNT(*) AS order_count,
  COALESCE(SUM(total_amount),0) AS total_amount
FROM dypos.orders
GROUP BY tenant_id, branch_id, status, order_type;

CREATE OR REPLACE VIEW dypos.v_kitchen_queue AS
SELECT
  kt.tenant_id,
  kt.branch_id,
  kt.id AS ticket_id,
  kt.ticket_no,
  ks.code AS station_code,
  ks.name AS station_name,
  kt.status,
  kt.priority,
  kt.queued_at,
  EXTRACT(EPOCH FROM (clock_timestamp() - kt.queued_at))/60.0 AS queue_minutes
FROM dypos.kitchen_tickets kt
LEFT JOIN dypos.kitchen_stations ks ON ks.id = kt.station_id
WHERE kt.status IN ('queued','accepted','preparing','ready');

CREATE OR REPLACE VIEW dypos.v_sync_health AS
SELECT
  d.tenant_id,
  d.id AS device_id,
  d.device_uid,
  d.status AS device_status,
  d.last_seen_at,
  COUNT(so.id) FILTER (WHERE so.status = 'pending') AS pending_operations,
  COUNT(so.id) FILTER (WHERE so.status = 'conflict') AS conflict_operations,
  COUNT(so.id) FILTER (WHERE so.status = 'quarantined') AS quarantined_operations,
  MAX(so.occurred_at) AS last_operation_at
FROM dypos.devices d
LEFT JOIN dypos.sync_operations so ON so.device_id = d.id
GROUP BY d.tenant_id, d.id, d.device_uid, d.status, d.last_seen_at;

CREATE OR REPLACE VIEW dypos.v_outbox_health AS
SELECT
  tenant_id,
  status,
  COUNT(*) AS item_count,
  MIN(created_at) AS oldest_item,
  MIN(next_attempt_at) FILTER (WHERE status = 'pending') AS next_attempt
FROM dypos.integration_outbox
GROUP BY tenant_id, status;

CREATE OR REPLACE VIEW dypos.v_security_health AS
SELECT
  tenant_id,
  severity,
  COUNT(*) AS event_count,
  MAX(occurred_at) AS last_event
FROM dypos.security_events
WHERE occurred_at >= clock_timestamp() - INTERVAL '24 hours'
GROUP BY tenant_id, severity;

CREATE OR REPLACE VIEW dypos.v_audit_activity AS
SELECT
  tenant_id,
  entity_type,
  action,
  COUNT(*) AS event_count,
  MAX(occurred_at) AS last_event
FROM dypos.audit_log
WHERE occurred_at >= clock_timestamp() - INTERVAL '24 hours'
GROUP BY tenant_id, entity_type, action;

-- ============================================================================
-- 7. SYNC / IDEMPOTENCY FUNCTIONS
-- ============================================================================

CREATE OR REPLACE FUNCTION dypos.accept_sync_operation(
  p_device_id VARCHAR(64),
  p_sequence_no BIGINT,
  p_entity_type TEXT,
  p_entity_id VARCHAR(64),
  p_operation TEXT,
  p_payload JSONB,
  p_occurred_at TIMESTAMPTZ DEFAULT clock_timestamp()
)
RETURNS VARCHAR(64)
LANGUAGE plpgsql
AS $$
DECLARE
  v_tenant VARCHAR(64);
  v_id VARCHAR(64);
  v_hash TEXT;
BEGIN
  SELECT tenant_id INTO v_tenant
    FROM dypos.devices
   WHERE id = p_device_id
     AND status = 'active';

  IF v_tenant IS NULL THEN
    RAISE EXCEPTION 'Device is not active or does not exist';
  END IF;

  v_hash := dypos.jsonb_sha256(p_payload);

  INSERT INTO dypos.sync_operations
    (tenant_id, device_id, sequence_no, entity_type, entity_id,
     operation, payload, payload_hash, occurred_at)
  VALUES
    (v_tenant, p_device_id, p_sequence_no, p_entity_type, p_entity_id,
     p_operation, p_payload, v_hash, p_occurred_at)
  ON CONFLICT (tenant_id, device_id, sequence_no)
  DO UPDATE SET
    status = CASE
      WHEN dypos.sync_operations.payload_hash = EXCLUDED.payload_hash
      THEN dypos.sync_operations.status
      ELSE 'conflict'
    END,
    error_code = CASE
      WHEN dypos.sync_operations.payload_hash = EXCLUDED.payload_hash
      THEN dypos.sync_operations.error_code
      ELSE 'SEQUENCE_REUSE_DIFFERENT_PAYLOAD'
    END
  RETURNING id INTO v_id;

  UPDATE dypos.devices
     SET last_seen_at = clock_timestamp()
   WHERE id = p_device_id;

  RETURN v_id;
END;
$$;

CREATE OR REPLACE PROCEDURE dypos.quarantine_device(
  p_device_id VARCHAR(64),
  p_reason TEXT DEFAULT NULL
)
LANGUAGE plpgsql
AS $$
DECLARE
  v_tenant VARCHAR(64);
BEGIN
  SELECT tenant_id INTO v_tenant FROM dypos.devices WHERE id = p_device_id FOR UPDATE;

  IF v_tenant IS NULL THEN
    RAISE EXCEPTION 'Device not found';
  END IF;

  UPDATE dypos.devices
     SET status = 'quarantined'
   WHERE id = p_device_id;

  INSERT INTO dypos.security_events
    (tenant_id, device_id, event_type, severity, details)
  VALUES
    (v_tenant, p_device_id, 'device_quarantined', 'high',
     jsonb_build_object('reason', p_reason));
END;
$$;

-- ============================================================================
-- 8. OUTBOX / RETRY WORKERS
-- ============================================================================

CREATE OR REPLACE FUNCTION dypos.claim_integration_outbox(
  p_limit INTEGER DEFAULT 100
)
RETURNS SETOF dypos.integration_outbox
LANGUAGE plpgsql
AS $$
BEGIN
  RETURN QUERY
  WITH picked AS (
    SELECT id
      FROM dypos.integration_outbox
     WHERE status = 'pending'
       AND next_attempt_at <= clock_timestamp()
     ORDER BY created_at
     FOR UPDATE SKIP LOCKED
     LIMIT GREATEST(p_limit, 1)
  )
  UPDATE dypos.integration_outbox o
     SET status = 'processing',
         attempts = attempts + 1
    FROM picked
   WHERE o.id = picked.id
  RETURNING o.*;
END;
$$;

CREATE OR REPLACE FUNCTION dypos.complete_integration_outbox(
  p_id VARCHAR(64),
  p_success BOOLEAN,
  p_error TEXT DEFAULT NULL,
  p_retry_seconds INTEGER DEFAULT 60
)
RETURNS VOID
LANGUAGE plpgsql
AS $$
BEGIN
  UPDATE dypos.integration_outbox
     SET status = CASE WHEN p_success THEN 'sent'
                       WHEN attempts >= 10 THEN 'dead_letter'
                       ELSE 'pending' END,
         last_error = CASE WHEN p_success THEN NULL ELSE p_error END,
         next_attempt_at = CASE
           WHEN p_success THEN next_attempt_at
           ELSE clock_timestamp() + make_interval(secs => GREATEST(p_retry_seconds, 1))
         END,
         sent_at = CASE WHEN p_success THEN clock_timestamp() ELSE sent_at END
   WHERE id = p_id;
END;
$$;

CREATE OR REPLACE FUNCTION dypos.claim_notification_outbox(
  p_limit INTEGER DEFAULT 100
)
RETURNS SETOF dypos.notification_outbox
LANGUAGE plpgsql
AS $$
BEGIN
  RETURN QUERY
  WITH picked AS (
    SELECT id
      FROM dypos.notification_outbox
     WHERE status = 'pending'
       AND next_attempt_at <= clock_timestamp()
     ORDER BY created_at
     FOR UPDATE SKIP LOCKED
     LIMIT GREATEST(p_limit, 1)
  )
  UPDATE dypos.notification_outbox n
     SET status = 'processing',
         attempts = attempts + 1
    FROM picked
   WHERE n.id = picked.id
  RETURNING n.*;
END;
$$;

-- ============================================================================
-- 9. PROMOTION SAFETY
-- ============================================================================

CREATE OR REPLACE FUNCTION dypos.redeem_coupon(
  p_tenant_id VARCHAR(64),
  p_coupon_code TEXT,
  p_customer_id VARCHAR(64),
  p_invoice_id VARCHAR(64),
  p_discount_amount NUMERIC,
  p_idempotency_key TEXT
)
RETURNS VARCHAR(64)
LANGUAGE plpgsql
AS $$
DECLARE
  v_coupon dypos.promotion_coupons%ROWTYPE;
  v_redemption VARCHAR(64);
BEGIN
  SELECT pc.*
    INTO v_coupon
    FROM dypos.promotion_coupons pc
   WHERE pc.tenant_id = p_tenant_id
     AND pc.code = p_coupon_code
     AND pc.is_active = TRUE
   FOR UPDATE;

  IF NOT FOUND THEN
    RAISE EXCEPTION 'Coupon is invalid or inactive';
  END IF;

  IF v_coupon.valid_from IS NOT NULL AND clock_timestamp() < v_coupon.valid_from THEN
    RAISE EXCEPTION 'Coupon is not active yet';
  END IF;

  IF v_coupon.valid_to IS NOT NULL AND clock_timestamp() > v_coupon.valid_to THEN
    RAISE EXCEPTION 'Coupon has expired';
  END IF;

  IF v_coupon.max_uses IS NOT NULL AND v_coupon.used_count >= v_coupon.max_uses THEN
    RAISE EXCEPTION 'Coupon usage limit reached';
  END IF;

  INSERT INTO dypos.promotion_redemptions
    (tenant_id, promotion_id, coupon_id, customer_id, invoice_id,
     discount_amount, idempotency_key)
  VALUES
    (p_tenant_id, v_coupon.promotion_id, v_coupon.id, p_customer_id,
     p_invoice_id, p_discount_amount, p_idempotency_key)
  ON CONFLICT (tenant_id, idempotency_key)
  DO UPDATE SET idempotency_key = EXCLUDED.idempotency_key
  RETURNING id INTO v_redemption;

  UPDATE dypos.promotion_coupons
     SET used_count = used_count + 1
   WHERE id = v_coupon.id
     AND NOT EXISTS (
       SELECT 1
         FROM dypos.promotion_redemptions r
        WHERE r.id = v_redemption
          AND r.redeemed_at < clock_timestamp() - INTERVAL '1 second'
     );

  RETURN v_redemption;
END;
$$;

-- ============================================================================
-- 10. PAYMENT / REFUND SAFETY
-- ============================================================================

CREATE OR REPLACE FUNCTION dypos.payment_refunded_amount(
  p_payment_id VARCHAR(64)
)
RETURNS NUMERIC(20,6)
LANGUAGE sql
STABLE
AS $$
  SELECT COALESCE(SUM(amount),0)
    FROM dypos.payment_refunds
   WHERE payment_transaction_id = p_payment_id
     AND status = 'completed'
$$;

CREATE OR REPLACE FUNCTION dypos.validate_refund_amount()
RETURNS TRIGGER
LANGUAGE plpgsql
AS $$
DECLARE
  v_payment_amount NUMERIC(20,6);
  v_refunded NUMERIC(20,6);
BEGIN
  SELECT amount INTO v_payment_amount
    FROM dypos.payment_transactions
   WHERE id = NEW.payment_transaction_id
   FOR UPDATE;

  IF v_payment_amount IS NULL THEN
    RAISE EXCEPTION 'Payment transaction not found';
  END IF;

  SELECT COALESCE(SUM(amount),0)
    INTO v_refunded
    FROM dypos.payment_refunds
   WHERE payment_transaction_id = NEW.payment_transaction_id
     AND status IN ('requested','completed')
     AND id <> COALESCE(NEW.id, gen_random_uuid()::text);

  IF v_refunded + NEW.amount > v_payment_amount THEN
    RAISE EXCEPTION 'Refund exceeds captured payment amount';
  END IF;

  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS trg_validate_refund_amount ON dypos.payment_refunds;
CREATE TRIGGER trg_validate_refund_amount
BEFORE INSERT OR UPDATE OF amount, status ON dypos.payment_refunds
FOR EACH ROW EXECUTE FUNCTION dypos.validate_refund_amount();

-- ============================================================================
-- 11. ORDER TOTAL VALIDATION
-- ============================================================================

CREATE OR REPLACE FUNCTION dypos.recalculate_order_total(p_order_id VARCHAR(64))
RETURNS NUMERIC(20,6)
LANGUAGE sql
STABLE
AS $$
  SELECT COALESCE(SUM(total_amount),0)
    FROM dypos.order_items
   WHERE order_id = p_order_id
$$;

CREATE OR REPLACE FUNCTION dypos.sync_order_total()
RETURNS TRIGGER
LANGUAGE plpgsql
AS $$
DECLARE
  v_order_id VARCHAR(64);
BEGIN
  v_order_id := COALESCE(NEW.order_id, OLD.order_id);

  UPDATE dypos.orders
     SET total_amount = dypos.recalculate_order_total(v_order_id)
   WHERE id = v_order_id;

  RETURN COALESCE(NEW, OLD);
END;
$$;

DROP TRIGGER IF EXISTS trg_sync_order_total ON dypos.order_items;
CREATE TRIGGER trg_sync_order_total
AFTER INSERT OR UPDATE OF quantity, unit_price, discount_amount, tax_amount, total_amount
OR DELETE ON dypos.order_items
FOR EACH ROW EXECUTE FUNCTION dypos.sync_order_total();

-- ============================================================================
-- 12. STATUS TIMELINE / KDS AUTOMATION
-- ============================================================================

CREATE OR REPLACE FUNCTION dypos.kitchen_status_guard()
RETURNS TRIGGER
LANGUAGE plpgsql
AS $$
BEGIN
  IF NEW.status = 'preparing' AND OLD.status NOT IN ('queued','accepted','preparing') THEN
    RAISE EXCEPTION 'Invalid KDS transition % -> %', OLD.status, NEW.status;
  END IF;

  IF NEW.status = 'ready' AND NEW.ready_at IS NULL THEN
    NEW.ready_at := clock_timestamp();
  END IF;

  IF NEW.status = 'served' AND NEW.served_at IS NULL THEN
    NEW.served_at := clock_timestamp();
  END IF;

  IF NEW.status = 'preparing' AND NEW.started_at IS NULL THEN
    NEW.started_at := clock_timestamp();
  END IF;

  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS trg_kitchen_status_guard ON dypos.kitchen_tickets;
CREATE TRIGGER trg_kitchen_status_guard
BEFORE UPDATE OF status ON dypos.kitchen_tickets
FOR EACH ROW EXECUTE FUNCTION dypos.kitchen_status_guard();

-- ============================================================================
-- 13. DATA QUALITY / HEALTH FUNCTIONS
-- ============================================================================

CREATE OR REPLACE FUNCTION dypos.health_check()
RETURNS TABLE (
  check_name TEXT,
  status TEXT,
  metric NUMERIC,
  details TEXT
)
LANGUAGE sql
STABLE
AS $$
  SELECT
    'unbalanced_posted_journals',
    CASE WHEN COUNT(*) = 0 THEN 'OK' ELSE 'FAIL' END,
    COUNT(*)::NUMERIC,
    'Posted journals with unequal debit/credit totals'
  FROM (
    SELECT je.id
      FROM dypos.journal_entries je
      JOIN dypos.journal_lines jl ON jl.journal_entry_id = je.id
     WHERE je.status = 'posted'
     GROUP BY je.id
    HAVING SUM(jl.debit) <> SUM(jl.credit) OR SUM(jl.debit) = 0
  ) x

  UNION ALL

  SELECT
    'pending_sync_operations',
    CASE WHEN COUNT(*) < 10000 THEN 'OK' ELSE 'WARN' END,
    COUNT(*)::NUMERIC,
    'Pending sync operations'
  FROM dypos.sync_operations
  WHERE status = 'pending'

  UNION ALL

  SELECT
    'dead_letter_integrations',
    CASE WHEN COUNT(*) = 0 THEN 'OK' ELSE 'WARN' END,
    COUNT(*)::NUMERIC,
    'Integration messages in dead-letter state'
  FROM dypos.integration_outbox
  WHERE status = 'dead_letter'

  UNION ALL

  SELECT
    'quarantined_devices',
    CASE WHEN COUNT(*) = 0 THEN 'OK' ELSE 'WARN' END,
    COUNT(*)::NUMERIC,
    'Devices requiring security review'
  FROM dypos.devices
  WHERE status = 'quarantined';
$$;

-- ============================================================================
-- 14. MATERIALIZED REPORTING VIEWS
-- ============================================================================

CREATE MATERIALIZED VIEW IF NOT EXISTS dypos.mv_daily_accounting_summary AS
SELECT
  tenant_id,
  entry_date,
  currency_code,
  SUM(debit) AS debit_total,
  SUM(credit) AS credit_total,
  COUNT(DISTINCT journal_entry_id) AS journal_count
FROM dypos.v_general_ledger
GROUP BY tenant_id, entry_date, currency_code
WITH NO DATA;

CREATE UNIQUE INDEX IF NOT EXISTS ux_mv_daily_accounting_summary
  ON dypos.mv_daily_accounting_summary(tenant_id, entry_date, currency_code);

CREATE MATERIALIZED VIEW IF NOT EXISTS dypos.mv_daily_order_summary AS
SELECT
  tenant_id,
  branch_id,
  (created_at AT TIME ZONE 'UTC')::DATE AS order_date,
  order_type,
  status,
  COUNT(*) AS order_count,
  SUM(total_amount) AS total_amount
FROM dypos.orders
GROUP BY tenant_id, branch_id,
         (created_at AT TIME ZONE 'UTC')::DATE,
         order_type, status
WITH NO DATA;

CREATE UNIQUE INDEX IF NOT EXISTS ux_mv_daily_order_summary
  ON dypos.mv_daily_order_summary(
    tenant_id, branch_id, order_date, order_type, status
  );

CREATE OR REPLACE PROCEDURE dypos.refresh_reporting_views()
LANGUAGE plpgsql
AS $$
BEGIN
  REFRESH MATERIALIZED VIEW CONCURRENTLY dypos.mv_daily_accounting_summary;
  REFRESH MATERIALIZED VIEW CONCURRENTLY dypos.mv_daily_order_summary;
END;
$$;

-- ============================================================================
-- 15. MAINTENANCE PROCEDURES
-- ============================================================================

CREATE OR REPLACE PROCEDURE dypos.close_accounting_period(
  p_period_id VARCHAR(64),
  p_closed_by VARCHAR(64)
)
LANGUAGE plpgsql
AS $$
DECLARE
  v_tenant VARCHAR(64);
  v_status TEXT;
  v_unbalanced BIGINT;
BEGIN
  SELECT tenant_id, status
    INTO v_tenant, v_status
    FROM dypos.accounting_periods
   WHERE id = p_period_id
   FOR UPDATE;

  IF NOT FOUND THEN
    RAISE EXCEPTION 'Accounting period not found';
  END IF;

  IF v_status = 'locked' THEN
    RAISE EXCEPTION 'Accounting period is already locked';
  END IF;

  SELECT COUNT(*)
    INTO v_unbalanced
    FROM (
      SELECT je.id
        FROM dypos.journal_entries je
        JOIN dypos.journal_lines jl ON jl.journal_entry_id = je.id
       WHERE je.period_id = p_period_id
         AND je.status = 'posted'
       GROUP BY je.id
      HAVING SUM(jl.debit) <> SUM(jl.credit) OR SUM(jl.debit) = 0
    ) x;

  IF v_unbalanced > 0 THEN
    RAISE EXCEPTION 'Cannot close period: % unbalanced journals', v_unbalanced;
  END IF;

  UPDATE dypos.accounting_periods
     SET status = 'closed',
         closed_at = clock_timestamp(),
         closed_by = p_closed_by
   WHERE id = p_period_id;
END;
$$;

CREATE OR REPLACE PROCEDURE dypos.purge_old_sync_operations(
  p_before TIMESTAMPTZ,
  p_batch_size INTEGER DEFAULT 10000
)
LANGUAGE plpgsql
AS $$
BEGIN
  DELETE FROM dypos.sync_operations
   WHERE id IN (
     SELECT id
       FROM dypos.sync_operations
      WHERE status = 'applied'
        AND applied_at < p_before
      ORDER BY applied_at
      LIMIT GREATEST(p_batch_size, 1)
   );
END;
$$;

-- ============================================================================
-- 16. INDEXES — ENGINEERING / QUERY PATHS
-- ============================================================================

CREATE INDEX IF NOT EXISTS idx_journal_entries_source
  ON dypos.journal_entries(tenant_id, source_type, source_id);

CREATE INDEX IF NOT EXISTS idx_journal_entries_period_status
  ON dypos.journal_entries(tenant_id, period_id, status, entry_date);

CREATE INDEX IF NOT EXISTS idx_journal_lines_entry_line
  ON dypos.journal_lines(journal_entry_id, line_no);

CREATE INDEX IF NOT EXISTS idx_ar_due
  ON dypos.accounts_receivable(tenant_id, status, due_date)
  WHERE outstanding_amount > 0;

CREATE INDEX IF NOT EXISTS idx_ap_due
  ON dypos.accounts_payable(tenant_id, status, due_date)
  WHERE outstanding_amount > 0;

CREATE INDEX IF NOT EXISTS idx_coupon_active
  ON dypos.promotion_coupons(tenant_id, code)
  WHERE is_active = TRUE;

CREATE INDEX IF NOT EXISTS idx_promotion_redemption_customer
  ON dypos.promotion_redemptions(tenant_id, customer_id, redeemed_at DESC);

CREATE INDEX IF NOT EXISTS idx_payment_status_time
  ON dypos.payment_transactions(tenant_id, status, initiated_at DESC);

CREATE INDEX IF NOT EXISTS idx_refunds_payment
  ON dypos.payment_refunds(tenant_id, payment_transaction_id, status);

CREATE INDEX IF NOT EXISTS idx_orders_customer_time
  ON dypos.orders(tenant_id, customer_id, created_at DESC);

CREATE INDEX IF NOT EXISTS idx_order_items_product
  ON dypos.order_items(product_id, order_id);

CREATE INDEX IF NOT EXISTS idx_kitchen_tickets_open
  ON dypos.kitchen_tickets(tenant_id, station_id, queued_at)
  WHERE status IN ('queued','accepted','preparing','ready');

CREATE INDEX IF NOT EXISTS idx_devices_last_seen
  ON dypos.devices(tenant_id, status, last_seen_at);

CREATE INDEX IF NOT EXISTS idx_sync_tombstones_deleted
  ON dypos.sync_tombstones(tenant_id, deleted_at);

CREATE INDEX IF NOT EXISTS idx_audit_entity
  ON dypos.audit_log(tenant_id, entity_type, entity_id, occurred_at DESC);

CREATE INDEX IF NOT EXISTS idx_security_event_severity
  ON dypos.security_events(tenant_id, severity, occurred_at DESC);

CREATE INDEX IF NOT EXISTS idx_notification_user_unread
  ON dypos.notifications(tenant_id, user_id, created_at DESC)
  WHERE read_at IS NULL;

CREATE INDEX IF NOT EXISTS idx_notification_outbox_pending
  ON dypos.notification_outbox(status, next_attempt_at)
  WHERE status IN ('pending','processing');

CREATE INDEX IF NOT EXISTS idx_integration_inbox_unprocessed
  ON dypos.integration_inbox(tenant_id, received_at)
  WHERE status = 'received';

-- JSONB indexes only where containment queries are expected.
CREATE INDEX IF NOT EXISTS idx_promotion_conditions_gin
  ON dypos.promotions USING GIN (conditions_json);

CREATE INDEX IF NOT EXISTS idx_promotion_rewards_gin
  ON dypos.promotions USING GIN (reward_json);

CREATE INDEX IF NOT EXISTS idx_device_metadata_gin
  ON dypos.devices USING GIN (metadata);

-- ============================================================================
-- 17. COMMENTS / DATABASE DOCUMENTATION
-- ============================================================================

COMMENT ON SCHEMA dypos IS
'DyPOS production database extension: accounting, payments, offline sync, integrations, audit and operational reporting.';

COMMENT ON FUNCTION dypos.current_tenant_id() IS
'Returns tenant context supplied by the trusted application transaction.';

COMMENT ON FUNCTION dypos.require_tenant_context() IS
'Fails closed when no tenant context is available.';

COMMENT ON FUNCTION dypos.validate_journal_entry(VARCHAR(64)) IS
'Validates double-entry balance before posting.';

COMMENT ON VIEW dypos.v_trial_balance IS
'Posted double-entry trial balance by tenant and account.';

COMMENT ON VIEW dypos.v_general_ledger IS
'Posted general ledger lines with source references.';

COMMENT ON VIEW dypos.v_sync_health IS
'Operational health of registered offline devices and sync queues.';

COMMENT ON VIEW dypos.v_outbox_health IS
'Operational health of integration outbox queues.';

-- ============================================================================
-- 18. MIGRATION REGISTRY
-- ============================================================================

CREATE TABLE IF NOT EXISTS dypos.schema_migrations (
  version TEXT PRIMARY KEY,
  applied_at TIMESTAMPTZ NOT NULL DEFAULT clock_timestamp(),
  checksum TEXT,
  description TEXT
);

INSERT INTO dypos.schema_migrations(version, checksum, description)
VALUES (
  'database-engine-v101-v130',
  md5('DyPOS database engine v101-v130'),
  'Production views, functions, procedures, triggers, audit engine, RLS hardening, health checks, materialized reporting and operational indexes'
)
ON CONFLICT (version) DO NOTHING;



/*
===============================================================================
DEPLOYMENT NOTES
===============================================================================
1. Apply v41-v100 first.
2. Apply this pack second.
3. Application must SET LOCAL app.tenant_id = '<tenant VARCHAR(64)>' inside every
   authenticated database transaction before accessing RLS protected tables.
4. Application should also set app.user_id, app.device_id and app.request_id.
5. The application/service layer must remain responsible for:
   - authorization
   - payment provider credentials
   - secret storage
   - tax/fiscal compliance rules by country
   - business-specific promotion calculation
   - physical inventory allocation
6. Refresh materialized views from a scheduler/worker, not from the POS request.
7. Use pg_dump/restore tests and staging verification before production.
8. For very large append-only tables, add partitioning only after measuring real
   production volume and retention requirements.
===============================================================================
*/
