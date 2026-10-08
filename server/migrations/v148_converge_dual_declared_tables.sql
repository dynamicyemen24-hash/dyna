-- ===========================================================================
-- v148 — Converge the tables the legacy packs and the migrations both declare
-- ===========================================================================
--
-- WHY THIS MIGRATION IS NECESSARY
-- -------------------------------
-- Six tables are declared by BOTH a legacy SQL pack and a numbered migration,
-- with different column sets:
--
--     table              pack (v24–v130)            migration (v131–v147)
--     -----------------  -------------------------  ------------------------
--     roles              id,tenant,code,name,…      + description, sod_group, created_at
--     user_roles         user_id, role_id           + branch_id, granted_at
--     role_permissions   role_id, permission_code   permission, effect
--     accounting_periods name,period_start,_end     branch_id, period
--     deliveries         order_id,address_json,…     + invoice_id, customer_name, picked_at…
--
-- Every one of them is created with `CREATE TABLE IF NOT EXISTS`, so whichever
-- side runs FIRST silently wins and the other becomes a no-op. That is a coin
-- toss decided by execution order:
--
--     initDatabaseSchema()  →  the packs run on EVERY boot
--     npm run migrate       →  the numbered migrations run ONCE, by hand
--
-- The packs therefore win by default, and the migration's column set is simply
-- never applied.
--
-- WHAT IS ACTUALLY BROKEN
-- -----------------------
-- `authz.ts` — the authorization engine every authenticated request passes
-- through — reads:
--
--     r.sod_group              from dypos.roles
--     rp.permission, rp.effect from dypos.role_permissions
--     ur.branch_id             from dypos.user_roles
--
-- Under the pack's shapes those columns do not exist, so the query raises
-- `column does not exist` and the request fails closed as a 403. A user who
-- legitimately holds a right is refused, and the symptom reads as a permissions
-- problem rather than a schema problem.
--
-- WHY THIS IS WRITTEN AS ADD COLUMN, NOT A NEW TABLE
-- -------------------------------------------------
-- A `CREATE TABLE` here would be a no-op for the same reason the original was.
-- Every statement is `ADD COLUMN IF NOT EXISTS`, so this converges the schema
-- whether the pack's shape or the migration's shape is already in place. That is
-- deliberate: it removes the dependence on knowing which side won, which is
-- exactly the fact that could not be established without inspecting production.
--
-- No column is dropped and no row is deleted. The pack's columns stay, so any
-- code still reading them keeps working.
-- ===========================================================================

-- ---------------------------------------------------------------------------
-- 1. ROLES — sod_group drives the duty-separation check in authz.ts
-- ---------------------------------------------------------------------------
-- A missing column is an error; a NULL value is merely an unclassified officer.
ALTER TABLE dypos.roles
  ADD COLUMN IF NOT EXISTS description  VARCHAR(255),
  ADD COLUMN IF NOT EXISTS sod_group    VARCHAR(64),
  ADD COLUMN IF NOT EXISTS created_at   TIMESTAMPTZ NOT NULL DEFAULT NOW();

-- ---------------------------------------------------------------------------
-- 2. USER_ROLES — branch scoping
-- ---------------------------------------------------------------------------
-- A grant may be limited to one branch (a regional manager). Rows written
-- before this column existed are not branch-scoped, which is the correct
-- default: NULL means "every branch", which is what they meant at the time.
ALTER TABLE dypos.user_roles
  ADD COLUMN IF NOT EXISTS branch_id  VARCHAR(64),
  ADD COLUMN IF NOT EXISTS granted_at TIMESTAMPTZ NOT NULL DEFAULT NOW();

-- ---------------------------------------------------------------------------
-- 3. ROLE_PERMISSIONS — the allow/deny columns, AND the data to back them
-- ---------------------------------------------------------------------------
-- The hardest of the six, because it is a RENAME in effect.
--
-- The pack named the column `permission_code`; v132 and the live code use
-- `permission`, and `effect` ('allow'/'deny') has no pack-side equivalent.
-- Adding the columns is not enough — existing grants would sit in
-- `permission_code` with `permission` NULL, and every user would resolve to an
-- empty grant set. So the old column is COPIED across.
ALTER TABLE dypos.role_permissions
  ADD COLUMN IF NOT EXISTS permission VARCHAR(128),
  ADD COLUMN IF NOT EXISTS effect     VARCHAR(8) NOT NULL DEFAULT 'allow';

DO $$
BEGIN
  -- Only where the old spelling holds a value, so this is idempotent and safe to
  -- re-run. Guarded on the column existing because a fresh installation gets the
  -- v132 shape and never had `permission_code`.
  IF EXISTS (
    SELECT 1 FROM information_schema.columns
    WHERE table_schema = 'dypos' AND table_name = 'role_permissions'
      AND column_name = 'permission_code'
  ) THEN
    UPDATE dypos.role_permissions
       SET permission = permission_code
     WHERE permission IS NULL
       AND permission_code IS NOT NULL;
  END IF;
END $$;

-- The grant set is read on every authenticated request. An index on
-- (role_id, permission) keeps that lookup off a sequential scan as roles and
-- permissions grow.
CREATE INDEX IF NOT EXISTS idx_role_permissions_role_permission
  ON dypos.role_permissions (role_id, permission);

-- ---------------------------------------------------------------------------
-- 4. ACCOUNTING_PERIODS — the period identifier and its branch
-- ---------------------------------------------------------------------------
-- `period` is the human label ('2026-01') that finance types and reports by;
-- the pack instead carried `period_start`/`period_end`. Both are kept: the date
-- range is a real constraint, the label is what the UI groups by.
ALTER TABLE dypos.accounting_periods
  ADD COLUMN IF NOT EXISTS branch_id VARCHAR(64),
  ADD COLUMN IF NOT EXISTS period    VARCHAR(16);

-- Backfill the label from the range where one exists, so a period created by the
-- pack is addressable by the label the new code queries. 'YYYY-MM' from
-- period_start is the same string finance would have typed.
DO $$
BEGIN
  IF EXISTS (
    SELECT 1 FROM information_schema.columns
    WHERE table_schema = 'dypos' AND table_name = 'accounting_periods'
      AND column_name = 'period_start'
  ) THEN
    UPDATE dypos.accounting_periods
       SET period = to_char(period_start, 'YYYY-MM')
     WHERE period IS NULL
       AND period_start IS NOT NULL;
  END IF;
END $$;

-- ---------------------------------------------------------------------------
-- 5. DELIVERIES — the customer/order columns the delivery screen reads
-- ---------------------------------------------------------------------------
-- The pack modelled a delivery against `orders`; the live code records one
-- against the `invoice_id` of the sale it fulfils. Both `order_id` and
-- `invoice_id` are kept — the screen joins through invoice_id, and dropping
-- order_id is not this migration's decision to make.
ALTER TABLE dypos.deliveries
  ADD COLUMN IF NOT EXISTS branch_id       VARCHAR(64),
  ADD COLUMN IF NOT EXISTS invoice_id      VARCHAR(64) REFERENCES dypos.invoices(id) ON DELETE SET NULL,
  ADD COLUMN IF NOT EXISTS customer_name   VARCHAR(255),
  ADD COLUMN IF NOT EXISTS customer_phone  VARCHAR(64),
  ADD COLUMN IF NOT EXISTS address         TEXT,
  ADD COLUMN IF NOT EXISTS driver_name     VARCHAR(128),
  ADD COLUMN IF NOT EXISTS amount_due      NUMERIC(14,2),
  ADD COLUMN IF NOT EXISTS distance_km     NUMERIC(10,2),
  ADD COLUMN IF NOT EXISTS picked_at       TIMESTAMPTZ,
  ADD COLUMN IF NOT EXISTS notes           TEXT,
  ADD COLUMN IF NOT EXISTS updated_at      TIMESTAMPTZ NOT NULL DEFAULT NOW();

-- The delivery list filters by tenant and orders by recency on every load.
CREATE INDEX IF NOT EXISTS idx_deliveries_tenant_created
  ON dypos.deliveries (tenant_id, created_at DESC);

-- ---------------------------------------------------------------------------
-- 6. CASH_MOVEMENTS — deliberately nothing added here
-- ---------------------------------------------------------------------------
-- This table is already reconciled: the boot path neutralises the pack's
-- conflicting declaration so v137's shape (section, occurred_on, direction in
-- 'in'/'out') is the single authority, which is what `financialRoutes.ts`
-- writes. Adding the pack's `shift_id`/`movement_type` would re-create the very
-- dual schema this migration exists to close.

-- ===========================================================================
-- RECORD
-- ===========================================================================
COMMENT ON TABLE dypos.role_permissions IS
  'Grants per role. permission/effect are authoritative; permission_code is the '
  'legacy spelling, retained so this migration stays reversible by inspection.';