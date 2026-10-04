-- ===========================================================================
-- v141 — Establishment segment (medium commercial establishments)
-- ===========================================================================
--
-- WHY A SEGMENT AND NOT A LABEL
-- -----------------------------
-- The product is positioned for MEDIUM commercial establishments. A marketing
-- line in a settings screen would not make that true — it would only make the
-- claim visible in one place while every behaviour stayed as it was.
--
-- What actually distinguishes a medium establishment is operational, and it is
-- measurable:
--
--   · several branches, so branch-scoped access and inter-branch stock matter
--   · enough revenue to be inside ZATCA's e-invoicing waves
--   · a real product catalogue with per-item tax treatment
--
-- So the segment is recorded as DATA, and it drives provisioning. That makes it
-- falsifiable: "medium" means specific capability grants, and those grants are
-- inspectable in `tenant_capabilities`.
--
-- WHY THE SEGMENT IS NOT A VARCHAR FREEFORM
-- -----------------------------------------
-- A free-text segment lets a tenant be typed "Medium" and behave like anything,
-- which is the placeholder-record failure this system is supposed to have
-- eliminated. This is a CHECK-constrained domain instead, so an unknown segment
-- is rejected by the database rather than silently meaning "small".
--
-- ON THE VAT RATE
-- ---------------
-- `vat_rate` defaults to 15%, the standard Saudi rate, because that is the
-- correct default for the target market — NOT because 15% is universal. Saudi
-- VAT also has a 0% band for qualifying supplies, and other GCC rates exist, so
-- the column is per-tenant and the POS reads it rather than assuming it.
--
-- NO ZATCA STATUS COLUMN
-- ----------------------
-- An earlier plan added `zatca_phase2_required`. It was dropped deliberately: a
-- boolean here would be an unverified legal claim stored as data, which is worse
-- than silence. Scope under ZATCA's waves depends on taxable revenue in
-- specific reference years, and the authoritative answer is the notice ZATCA
-- sends the taxpayer — not a value this system can compute.
-- ===========================================================================

DO $$
BEGIN
  -- ── Establishment size ────────────────────────────────────────────────
  IF NOT EXISTS (
    SELECT 1 FROM information_schema.columns
    WHERE table_schema = 'dypos' AND table_name = 'tenants'
      AND column_name = 'establishment_segment'
  ) THEN
    ALTER TABLE dypos.tenants ADD COLUMN establishment_segment VARCHAR(32);
  END IF;

  -- Existing tenants are classified rather than left NULL: a NULL here would
  -- read as "not yet decided" forever, and every consumer would need a
  -- fallback for a state that never resolves on its own.
  UPDATE dypos.tenants
     SET establishment_segment = 'medium'
   WHERE establishment_segment IS NULL;

  ALTER TABLE dypos.tenants
    ALTER COLUMN establishment_segment SET DEFAULT 'medium';

  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
    WHERE conrelid = 'dypos.tenants'::regclass
      AND conname = 'tenants_establishment_segment_check'
  ) THEN
    ALTER TABLE dypos.tenants
      ADD CONSTRAINT tenants_establishment_segment_check
      CHECK (establishment_segment IN ('micro', 'small', 'medium', 'large'));
  END IF;

  -- ── Per-tenant VAT rate ───────────────────────────────────────────────
  IF NOT EXISTS (
    SELECT 1 FROM information_schema.columns
    WHERE table_schema = 'dypos' AND table_name = 'tenants'
      AND column_name = 'vat_rate'
  ) THEN
    ALTER TABLE dypos.tenants ADD COLUMN vat_rate NUMERIC(5, 2);
  END IF;

  UPDATE dypos.tenants SET vat_rate = 15.00 WHERE vat_rate IS NULL;

  ALTER TABLE dypos.tenants
    ALTER COLUMN vat_rate SET DEFAULT 15.00;

  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
    WHERE conrelid = 'dypos.tenants'::regclass
      AND conname = 'tenants_vat_rate_check'
  ) THEN
    -- A rate outside 0–100 cannot be reconciled against any tax return, so it
    -- is refused at the boundary rather than rendered on an invoice.
    ALTER TABLE dypos.tenants
      ADD CONSTRAINT tenants_vat_rate_check
      CHECK (vat_rate >= 0 AND vat_rate <= 100);
  END IF;

  -- ── Annual taxable revenue, in the tenant's base currency ────────────
  -- Recorded so capability provisioning and reporting can reason about scale
  -- without a hard-coded guess. NULL means "not yet declared", which is a true
  -- statement and is why nothing is inferred from it.
  IF NOT EXISTS (
    SELECT 1 FROM information_schema.columns
    WHERE table_schema = 'dypos' AND table_name = 'tenants'
      AND column_name = 'annual_revenue'
  ) THEN
    ALTER TABLE dypos.tenants
      ADD COLUMN annual_revenue NUMERIC(18, 2);
  END IF;

  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
    WHERE conrelid = 'dypos.tenants'::regclass
      AND conname = 'tenants_annual_revenue_check'
  ) THEN
    ALTER TABLE dypos.tenants
      ADD CONSTRAINT tenants_annual_revenue_check
      CHECK (annual_revenue IS NULL OR annual_revenue >= 0);
  END IF;
END $$;

COMMENT ON COLUMN dypos.tenants.establishment_segment IS
  'Operational size band: micro | small | medium | large. Constrained, and used '
  'to provision tenant_capabilities. "medium" is the product target segment.';

COMMENT ON COLUMN dypos.tenants.vat_rate IS
  'Default VAT percentage for this tenant (standard KSA rate is 15). Applied by '
  'the POS; individual products may override via products.tax_rate.';

COMMENT ON COLUMN dypos.tenants.annual_revenue IS
  'Declared annual taxable revenue, or NULL when not yet declared. Not used to '
  'assert tax-regulator status: ZATCA scope depends on revenue in specific '
  'reference years and on a notice the taxpayer receives directly.';