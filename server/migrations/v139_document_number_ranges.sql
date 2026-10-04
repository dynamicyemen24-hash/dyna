-- ===========================================================================
-- v139 — Server-side document number ranges
--
-- WHY A SEPARATE MIGRATION
-- -----------------------
-- v138 is already recorded in `dypos.applied_migrations`, and that ledger is what
-- makes migrations idempotent. Editing an applied file would silently skip the
-- new statements: the runner compares filenames, not contents, so the change
-- would never execute on any deployed database. New schema gets a new version.
--
-- SAP AND ODOO, ON NUMBER RANGES
-- -------------------------------
-- SAP models number allocation as an application-server object (number range,
-- FBNR/NCO) rather than something a form constructs. Odoo reaches the same place
-- by making the sequence a model that only the server may advance. Both reject
-- the same failure: a document number produced in the client can be produced
-- twice, has no gap record, and cannot be reconciled later.
--
-- The client was doing exactly that:
--
--     `INV-${year}-${String(transactions.length + 1002).padStart(4,'0')}`
--
-- `transactions.length` is the length of the array THIS TERMINAL loaded, so two
-- terminals issue the same invoice number for different sales.
--
-- CONCURRENCY
-- -----------
-- Allocation runs `UPDATE … RETURNING`, which takes a row lock held to commit, so
-- concurrent checkouts serialise on the counter. The `INSERT … ON CONFLICT DO
-- NOTHING` seeds the first row of a period without racing. The primary key is
-- belt-and-braces: if the lock were ever bypassed, the second writer fails loudly
-- instead of silently duplicating a posted document.
--
-- Additive and idempotent.
-- ===========================================================================

CREATE TABLE IF NOT EXISTS dypos.document_sequences (
  tenant_id    VARCHAR(64) NOT NULL REFERENCES dypos.tenants(id),
  -- 'invoice' | 'purchase_order' | 'work_order' | 'journal' | …
  doc_type     VARCHAR(32) NOT NULL,
  -- Tenant-wide running number, e.g. '2026'.
  period_key   VARCHAR(16) NOT NULL,
  next_value   BIGINT NOT NULL DEFAULT 1,
  prefix       VARCHAR(16) NOT NULL DEFAULT '',
  updated_at   TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  PRIMARY KEY (tenant_id, doc_type, period_key)
);

COMMENT ON TABLE dypos.document_sequences IS
  'Server-side number ranges (SAP NCO / Odoo sequence). Allocated by allocateDocumentNumber(); never constructed in a client.';

-- The invoice path resolves the number through the counter, so a gap in
-- `invoice_number` is meaningful: it means an allocation was consumed by a
-- write that then failed. That is auditable. A duplicate would not be.
CREATE INDEX IF NOT EXISTS idx_invoice_number_lookup
  ON dypos.invoices (tenant_id, invoice_number)
  WHERE invoice_number IS NOT NULL;