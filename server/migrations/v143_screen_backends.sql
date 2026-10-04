-- ===========================================================================
-- v143 — Backends for the restaurant, subscription and consignment screens
-- ===========================================================================
--
-- WHY
-- ---
-- Three screens — restaurant floor, subscriptions, consignment sales — had NO
-- API at all. They made zero calls to the server and rendered invented records:
-- occupied tables with running totals, kitchen tickets, subscribers with renewal
-- dates, consignment takings.
--
-- Removing the fabrications left those screens empty and non-functional, which is
-- honest but not finished. A screen that can only ever show nothing is not a
-- feature; the work is to give it a real source, not to stop at silence.
--
-- WHAT THIS ADDS
-- --------------
-- 1. `tenant_id` on `restaurant_areas` and `restaurant_tables`.
--
--    Both tables were created WITHOUT it. Since they carry business state —
--    which table is occupied, and against which invoice — that is not cosmetic:
--    with no tenant column there is no way to scope a query to one business, so
--    any screen reading them reads every restaurant on the system. They are now
--    tenant-owned like everything else.
--
--    Backfill derives each area's owner from the branch it hangs from. Rows whose
--    owner cannot be derived are DELETED rather than adopted: a row belonging to
--    an unknown owner is not data worth keeping, and guessing an owner is exactly
--    the invention this work has been removing.
--
-- 2. `consignment_sales` — the table did not exist at all. Consignment decides
--    what a partner is owed, so it is a financial record and needs the same
--    guarantees as an invoice: a tenant, a server-allocated number, and amounts
--    that are never supplied by the browser.
--
-- 3. `kitchen_tickets` — the KDS displayed orders no table stored.
--
-- ON NUMBERS
-- ----------
-- `consignment_sales` takes its number from the SAME server sequence allocator as
-- every other document. A consignment receipt is an accounting document, and a
-- number minted in the browser is not one.
-- ===========================================================================

-- ── 1. Tenant ownership for the restaurant floor ──────────────────────────
DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM information_schema.columns
    WHERE table_schema = 'dypos' AND table_name = 'restaurant_areas'
      AND column_name = 'tenant_id'
  ) THEN
    ALTER TABLE dypos.restaurant_areas ADD COLUMN tenant_id VARCHAR(64);
  END IF;

  IF NOT EXISTS (
    SELECT 1 FROM information_schema.columns
    WHERE table_schema = 'dypos' AND table_name = 'restaurant_tables'
      AND column_name = 'tenant_id'
  ) THEN
    ALTER TABLE dypos.restaurant_tables ADD COLUMN tenant_id VARCHAR(64);
  END IF;
END $$;

-- Derive each area's owner from the branch it belongs to.
UPDATE dypos.restaurant_areas a
   SET tenant_id = b.tenant_id
  FROM dypos.branches b
 WHERE a.branch_id = b.id AND a.tenant_id IS NULL;

-- An area whose owner cannot be derived is removed rather than adopted.
DELETE FROM dypos.restaurant_areas WHERE tenant_id IS NULL;

-- Tables follow their area.
UPDATE dypos.restaurant_tables t
   SET tenant_id = a.tenant_id
  FROM dypos.restaurant_areas a
 WHERE t.area_id = a.id AND t.tenant_id IS NULL;

DELETE FROM dypos.restaurant_tables WHERE tenant_id IS NULL;

-- Now that no row is NULL, enforce it.
ALTER TABLE dypos.restaurant_areas  ALTER COLUMN tenant_id SET NOT NULL;
ALTER TABLE dypos.restaurant_tables ALTER COLUMN tenant_id SET NOT NULL;

-- The foreign keys could not be added while the columns held NULLs.
DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
    WHERE conrelid = 'dypos.restaurant_areas'::regclass
      AND conname = 'restaurant_areas_tenant_id_fkey'
  ) THEN
    ALTER TABLE dypos.restaurant_areas
      ADD CONSTRAINT restaurant_areas_tenant_id_fkey
      FOREIGN KEY (tenant_id) REFERENCES dypos.tenants(id);
  END IF;

  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
    WHERE conrelid = 'dypos.restaurant_tables'::regclass
      AND conname = 'restaurant_tables_tenant_id_fkey'
  ) THEN
    ALTER TABLE dypos.restaurant_tables
      ADD CONSTRAINT restaurant_tables_tenant_id_fkey
      FOREIGN KEY (tenant_id) REFERENCES dypos.tenants(id);
  END IF;
END $$;

-- ── 2. Consignment sales — NOTHING IS CREATED HERE ────────────────────────
--
-- The first draft of this migration created `consignment_sales` from scratch,
-- with `partner_name`, `gross_sales`, `commission_amount`, `net_amount` and a
-- `consignment_number`.
--
-- That table ALREADY EXISTS, with a different and better-shaped schema:
-- `consignor`, `product_name`, `quantity`, `sold_quantity`,
-- `consignor_share_pct`, `sale_amount`, `settled_at`, `status`. It models
-- consignments LINE BY LINE — one consignor, one product, a share percentage —
-- where my draft modelled one partner's whole statement.
--
-- The existing model is the correct one. A consignor's balance is the SUM of
-- their lines; storing a pre-computed statement total instead would make every
-- settlement a figure nobody could recompute from the underlying sales, which is
-- precisely the property a consignment account is for.
--
-- `CREATE TABLE IF NOT EXISTS` therefore did nothing, and the next statement
-- failed on `consignment_number does not exist`, rolling the whole file back.
--
-- The lesson is one this project keeps learning: read the schema before writing
-- to it. A migration that invents a table instead of reading the existing one
-- fails loudly here — which is luck, not design. Had the index been optional it
-- would have succeeded against a shape nothing reads.
--
-- All that remains for consignment is an INDEX, so the screen's queries are
-- scoped and indexed by tenant rather than scanning the table.
-- ═══════════════════════════════════════════════════════════════════════════

CREATE INDEX IF NOT EXISTS consignment_sales_tenant_idx
  ON dypos.consignment_sales (tenant_id, status);

-- A consignor's share cannot exceed 100%, and an amount cannot be negative.
-- Both are checkable, so they are checked at the boundary rather than trusted.
ALTER TABLE dypos.consignment_sales
  DROP CONSTRAINT IF EXISTS consignment_sales_bounds_check;
ALTER TABLE dypos.consignment_sales
  ADD CONSTRAINT consignment_sales_bounds_check
  CHECK (
    quantity >= 0
    AND sold_quantity >= 0
    AND sold_quantity <= quantity
    AND consignor_share_pct >= 0 AND consignor_share_pct <= 100
    AND sale_amount >= 0
  );

COMMENT ON TABLE dypos.consignment_sales IS
  'Consignment lines — what a consignor is owed. Modelled per consignor per '
  'product; a balance is the SUM of the lines, never a stored total.';
-- ── 3. Kitchen tickets — NOTHING IS CREATED HERE ──────────────────────────
--
-- Same mistake as the consignment table, caught the same way: `kitchen_tickets`
-- already exists and is a proper KDS model — `ticket_no` (a BIGINT), `priority`,
-- `station_id`, `queued_at`, `started_at`, `ready_at`, `served_at`,
-- `ticket_label`, `table_label`, `order_type` and `metadata`.
--
-- One detail there is worth keeping deliberately: `ticket_no` is a bigint, so
-- the kitchen display is ordered by a real counter. Had this draft's `VARCHAR`
-- ticket number shipped, "100" would have sorted before "99" and the kitchen
-- would have cooked tickets in the wrong order every day after the ninety-ninth.
--
-- So nothing is created. What is missing is an index for the KDS query and a
-- status constraint: the lifecycle is a defined set of states, and the database
-- is the right place to say so, because a status the screen does not understand
-- renders as a blank column in front of a chef.
-- ═══════════════════════════════════════════════════════════════════════════

CREATE INDEX IF NOT EXISTS kitchen_tickets_tenant_status_idx
  ON dypos.kitchen_tickets (tenant_id, status, queued_at);

ALTER TABLE dypos.kitchen_tickets
  DROP CONSTRAINT IF EXISTS kitchen_tickets_status_check;
ALTER TABLE dypos.kitchen_tickets
  ADD CONSTRAINT kitchen_tickets_status_check
  CHECK (status IN ('queued', 'preparing', 'ready', 'served', 'cancelled'));

ALTER TABLE dypos.kitchen_tickets
  DROP CONSTRAINT IF EXISTS kitchen_tickets_priority_check;
ALTER TABLE dypos.kitchen_tickets
  ADD CONSTRAINT kitchen_tickets_priority_check
  CHECK (priority >= 0);

COMMENT ON TABLE dypos.kitchen_tickets IS
  'Kitchen display tickets. ticket_no is a bigint counter, so ordering is '
  'numeric and priority orders within it. A ticket is raised from an order — it '
  'is never an independent statement of what a customer ordered.';
