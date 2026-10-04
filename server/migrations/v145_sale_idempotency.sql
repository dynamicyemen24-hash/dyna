-- ===========================================================================
-- v145 — Sale idempotency and invoice-number uniqueness
-- ===========================================================================
--
-- THE DEFECT
-- ---------
-- `POST /api/db/invoices` had no idempotency of any kind. The only guard against a
-- double sale was React state in the browser (`if (isSelling) return`), which is
-- not a defence:
--
--   · a second click inside the gap before React re-renders is not blocked;
--   · a retry after a timeout re-sends the whole request;
--   · a proxy or gateway that replays a POST re-sends it;
--   · two tills restoring the same offline queue post the same sale twice;
--   · the operator refreshing mid-request does not know whether it landed.
--
-- Every one of those produces a SECOND invoice and a SECOND stock movement for
-- one sale. The ledger, the receipt and the stock all agree with each other, so
-- nothing downstream can detect it — the goods leave twice and are counted once.
--
-- WHAT THIS ADDS
-- -------------
-- 1. `idempotency_key`, UNIQUE per tenant.
--    The client generates one key per sale ATTEMPT and reuses it on every retry of
--    that attempt. A replay finds the key already present and returns the
--    ORIGINAL invoice instead of writing a second one.
--
--    Unique per tenant, not global: the key is opaque and client-chosen, so a
--    global unique index would let one tenant's key collide with another's and
--    turn a retry into a 500.
--
-- 2. UNIQUE on `(tenant_id, invoice_number)`.
--    The allocator in `documentNumber.ts` is already atomic, so this is defence
--    in depth rather than a live bug — but the number is the document's identity
--    and it was protected by nothing but application code. Verified before
--    adding: zero duplicate pairs exist today, so this cannot fail on data
--    already stored.
--
-- WHY A UNIQUE INDEX IS THE RIGHT TOOL
-- ------------------------------------
-- Application code cannot enforce this. A check-then-insert has a window between
-- the two statements, and two concurrent requests both pass the check. Only the
-- database can make the second one fail, which is what idempotency requires.
-- ===========================================================================

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM information_schema.columns
    WHERE table_schema = 'dypos' AND table_name = 'invoices'
      AND column_name = 'idempotency_key'
  ) THEN
    ALTER TABLE dypos.invoices ADD COLUMN idempotency_key VARCHAR(128);
  END IF;
END $$;

-- One sale per key, per tenant.
--
-- `WHERE ... IS NOT NULL` because a partial unique index over NULLs would still
-- allow many NULLs in Postgres, and rows created before this column existed — or
-- by the batch-sync path, which has no key — must not collide with each other.
CREATE UNIQUE INDEX IF NOT EXISTS invoices_idempotency_uq
  ON dypos.invoices (tenant_id, idempotency_key)
  WHERE idempotency_key IS NOT NULL;

-- The invoice number is the document's identity; the database enforces it.
--
-- The existing `idx_invoice_number_lookup` is a plain, non-unique index and stays
-- as it is: replacing it outright would change an index other queries may rely on
-- for planning, and a second unique index on the same columns is redundant work
-- on every insert. This one is what makes duplicates impossible.
CREATE UNIQUE INDEX IF NOT EXISTS invoices_tenant_number_uq
  ON dypos.invoices (tenant_id, invoice_number)
  WHERE invoice_number IS NOT NULL;

COMMENT ON COLUMN dypos.invoices.idempotency_key IS
  'Client-generated key for one SALE ATTEMPT, reused across retries of that '
  'attempt. Uniqueness per tenant (invoices_idempotency_uq) makes a replayed '
  'POST return the original invoice instead of recording a second sale.';

COMMENT ON INDEX dypos.invoices_tenant_number_uq IS
  'Guarantees one invoice number per tenant per period. The allocator is already '
  'atomic; this makes a duplicate impossible even if that code is bypassed.';