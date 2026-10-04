-- ===========================================================================
-- v142 — The establishment segment may not be NULL
-- ===========================================================================
--
-- FOUND BY RUNNING THE PROVISIONER, NOT BY READING IT
-- ------------------------------------------------------
-- `v141` added
--
--     establishment_segment VARCHAR(32)
--     ... CHECK (establishment_segment IN ('micro','small','medium','large'))
--
-- and the migration script then inserted `undefined` for that column, because the
-- segment key had been dropped from its profile object. The row was created and
-- `establishment_segment` was stored as NULL.
--
-- ══ WHY THE CHECK DID NOT CATCH IT ════════════════════════════════════════
-- A CHECK constraint rejects a row when its predicate is FALSE. For NULL the
-- predicate evaluates to NULL, and NULL is not FALSE — so the row passed.
--
-- This is not an edge case or a PostgreSQL quirk to work around; it is the
-- documented meaning of CHECK. A CHECK alone therefore cannot enforce "this
-- value must be one of these", it can only enforce "this value, if present,
-- must be one of these".
--
-- That matters here because the segment drives capability provisioning. A NULL
-- segment is a tenant whose size was never decided, and every consumer would
-- need a fallback for a state that silently persists — which is precisely the
-- placeholder behaviour this system has been removing.
--
-- THE FIX
-- -------
-- NOT NULL, enforced on the existing rows first so the ALTER cannot fail
-- against a NULL left behind by the bug above. Order matters: ALTER ... SET NOT
-- NULL before the backfill would fail; the backfill must come first.
--
-- `vat_rate` gets the same treatment for the same reason — it is rendered on
-- tax documents, and NULL there is a document that cannot be produced.
-- ===========================================================================

DO $$
BEGIN
  -- Backfill first. Anything still NULL becomes 'medium', which is the
  -- product's target segment and the migration's own default. This is a
  -- genuine judgement call: 'medium' is not derivable from the row, so it is
  -- recorded as the segment the product targets, and is correctable.
  UPDATE dypos.tenants
     SET establishment_segment = 'medium'
   WHERE establishment_segment IS NULL;

  UPDATE dypos.tenants
     SET vat_rate = 15.00
   WHERE vat_rate IS NULL;

  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
    WHERE conrelid = 'dypos.tenants'::regclass
      AND conname = 'tenants_establishment_segment_nn'
  ) THEN
    ALTER TABLE dypos.tenants
      ADD CONSTRAINT tenants_establishment_segment_nn
      CHECK (establishment_segment IS NOT NULL);
  END IF;

  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
    WHERE conrelid = 'dypos.tenants'::regclass
      AND conname = 'tenants_vat_rate_nn'
  ) THEN
    ALTER TABLE dypos.tenants
      ADD CONSTRAINT tenants_vat_rate_nn
      CHECK (vat_rate IS NOT NULL);
  END IF;
END $$;

COMMENT ON CONSTRAINT tenants_establishment_segment_check ON dypos.tenants IS
  'Enumerates the permitted bands. NOTE: a CHECK alone permits NULL, because NULL '
  'is not FALSE — tenants_establishment_segment_nn closes that hole. Both are '
  'required: the CHECK bounds the value, the NOT NULL guarantees one exists.';

COMMENT ON CONSTRAINT tenants_vat_rate_nn ON dypos.tenants IS
  'Guarantees a tax rate exists, because it is rendered on tax documents. Pairs '
  'with tenants_vat_rate_check, which bounds it to 0-100.';