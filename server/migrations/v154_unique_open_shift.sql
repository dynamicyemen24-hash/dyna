-- v154 — enforce one active cashier shift per operator and branch
-- Application checks prevent normal duplicates; this partial unique index closes the
-- remaining race where two concurrent requests both pass the pre-insert check.
CREATE UNIQUE INDEX IF NOT EXISTS uq_pos_sessions_open_operator_branch
  ON dypos.pos_sessions (tenant_id, branch_id, user_id)
  WHERE status = 'open';

COMMENT ON INDEX uq_pos_sessions_open_operator_branch IS
  'At most one open POS shift per operator and branch within a tenant.';
