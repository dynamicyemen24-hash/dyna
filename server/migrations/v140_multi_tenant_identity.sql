-- ===========================================================================
-- v140 — Multi-tenant identity: per-tenant usernames
-- ===========================================================================
--
-- THE DEFECT
-- ---------
-- `dypos.users` carried `username VARCHAR(128) UNIQUE` — a GLOBAL uniqueness
-- constraint. Two tenants therefore could not both own an `admin`, or both own
-- a `manager`, and every login path was pinned to a single hard-coded
-- `DEFAULT_TENANT`.
--
-- The practical effect was that multi-tenancy did not exist: there was one
-- tenant that could sign in, and 22 other tenants' worth of schema with no way
-- to reach it. Tenant isolation, which the API now enforces correctly, protects
-- data that no second tenant could ever hold.
--
-- WHY THIS IS A SCHEMA CHANGE AND NOT JUST CODE
-- ---------------------------------------------
-- The constraint is in the database, so no amount of application code can route
-- around it. Relaxing it is the whole change; leaving it would mean an
-- "ordinary" second tenant failing at the moment someone created its admin
-- account, with a constraint-violation error rather than anything explanatory.
--
-- WHY IT MUST BE (tenant_id, username) AND NOT JUST username
-- ----------------------------------------------------------
-- Simply dropping the constraint would allow `admin` in every tenant and no
-- longer be unique within one — which would break login itself, since login
-- resolves a name to exactly one user. Uniqueness has to move DOWN a level:
-- unique per tenant, not unique per system.
--
-- EXISTING DATA IS SAFE
-- ---------------------
-- Global uniqueness implies per-tenant uniqueness, so the new constraint is
-- satisfied by every row already present. No data is rewritten and no collision
-- is possible at migration time. `IF NOT EXISTS` keeps re-runs idempotent, and
-- the constraint is dropped only if it is still named exactly what we expect —
-- if someone has already replaced it, the ALTER is skipped rather than
-- destroying whatever they built.
-- ===========================================================================

DO $$
BEGIN
  -- Drop the global uniqueness, but only the constraint we know by name.
  IF EXISTS (
    SELECT 1 FROM pg_constraint
    WHERE conrelid = 'dypos.users'::regclass AND conname = 'users_username_key'
  ) THEN
    ALTER TABLE dypos.users DROP CONSTRAINT users_username_key;
  END IF;

  -- Uniqueness per tenant. IF NOT EXISTS so a re-run is a no-op.
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
    WHERE conrelid = 'dypos.users'::regclass AND conname = 'users_tenant_username_key'
  ) THEN
    ALTER TABLE dypos.users
      ADD CONSTRAINT users_tenant_username_key UNIQUE (tenant_id, username);
  END IF;
END $$;

-- Comment on the column so the next reader learns the constraint moved rather
-- than trusting `UNIQUE NOT NULL` on the CREATE TABLE and re-deriving it wrong.
COMMENT ON COLUMN dypos.users.username IS
  'Login name, unique WITHIN a tenant (constraint users_tenant_username_key). '
  'Not unique across the system: two tenants may each have an "admin".';