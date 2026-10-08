-- v153 — bind sales to the cashier shift
-- Financial operations must be attributable to the exact opened till shift.
ALTER TABLE dypos.invoices
  ADD COLUMN IF NOT EXISTS shift_id VARCHAR(64);

CREATE INDEX IF NOT EXISTS idx_invoices_shift
  ON dypos.invoices (tenant_id, shift_id, created_at DESC);

COMMENT ON COLUMN dypos.invoices.shift_id IS
  'Server-issued pos_sessions.id for the shift that accepted the sale; NULL only for historical rows.';

