-- ===========================================================================
-- v151 — Free-text purchase order lines
--
-- WHY THIS TABLE, AND NOT `dypos.purchase_order_items`
-- ----------------------------------------------------
-- `purchase_order_items.product_id` is NOT NULL and carries a FOREIGN KEY to
-- `dypos.products(id)`. The purchase screen, however, captures a FREE-TEXT
-- line: the operator types "قطعة غيار X" for a part that is not in the
-- catalogue yet, because ordering a spare is exactly when the catalogue is
-- incomplete. Every such line fails the NOT NULL / FK constraint, so the POST
-- could never persist — which is why POs built in the UI were written nowhere
-- at all.
--
-- Forcing the operator to create a phantom product first would move the
-- problem rather than solve it: the phantom then appears at the till, in the
-- stock reports and in the reorder calculations, as an item with zero price
-- and zero stock that nobody ever sold.
--
-- So the free-text line gets its own table, keyed to the order it belongs to.
-- `position` preserves the order the operator typed them in, and `line_total`
-- is stored so a later price change on the product cannot rewrite the history
-- of what this order said at the time it was placed.
--
-- SAP AND ODOO, ON ORDER LINES
-- ----------------------------
-- Both model a purchase order line as its own object with its own copy of the
-- description and price at order time; the material master is referenced when
-- it exists, not required for the document to exist. A document that cannot be
-- written because a master record is missing is a document that is lost.
--
-- Additive and idempotent (IF NOT EXISTS), in the style of v139. Discovered
-- and applied by `scripts/migrate.ts`, which reads every `*.sql` in this
-- directory in lexicographic order and records it in
-- `dypos.applied_migrations`.
-- ===========================================================================

CREATE TABLE IF NOT EXISTS dypos.purchase_order_lines (
  id VARCHAR(64) PRIMARY KEY,
  tenant_id VARCHAR(64) NOT NULL REFERENCES dypos.tenants(id),
  po_id VARCHAR(64) NOT NULL REFERENCES dypos.purchase_orders(id) ON DELETE CASCADE,
  position INTEGER NOT NULL DEFAULT 0,
  product_name TEXT NOT NULL,
  quantity NUMERIC(12,2) NOT NULL DEFAULT 0,
  unit_cost NUMERIC(12,2) NOT NULL DEFAULT 0,
  line_total NUMERIC(12,2) NOT NULL DEFAULT 0,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

COMMENT ON TABLE dypos.purchase_order_lines IS
  'Free-text purchase order lines. purchase_order_items.product_id is NOT NULL with an FK to dypos.products, so a line for a part not yet in the catalogue could never be written there; the purchase screen captures exactly such lines.';

-- The list route aggregates lines per order, always ordered by `position`.
CREATE INDEX IF NOT EXISTS idx_purchase_order_lines_po ON dypos.purchase_order_lines(po_id);
