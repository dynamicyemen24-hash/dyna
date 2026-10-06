-- ===========================================================================
-- v149 — dypos.users gains email and phone
-- ===========================================================================
--
-- WHY THIS MIGRATION EXISTS
-- -------------------------
-- `server/enrollmentEngine.ts` resolves an UNKNOWN username during sign-in by
-- querying:
--
--     SELECT id, tenant_id, username, email, phone, is_active, locked_until
--       FROM dypos.users ...
--
-- Neither `email` nor `phone` has ever existed on `dypos.users` — the table is
-- created in `server/neonDb.ts` without them, and no pack in v131..v148 adds
-- them. The query therefore raises `42703 column "email" does not exist`, the
-- route's error handler answers 500, and:
--
--   1. SIGN-IN FOR AN UNKNOWN USERNAME IS A 500, not the generic 401. The
--      on-premise path (`npm start` → Express) is exactly where this runs;
--      the Cloudflare Worker does not call the enrollment engine, so the
--      public site looked healthy while the self-hosted door did not.
--   2. The 500 is itself a USERNAME ORACLE: an existing user with a wrong
--      password gets 401, a non-existing user gets 500 — the error code
--      distinguishes them, which GENERIC_AUTH_ERROR exists to prevent.
--   3. It was found by a rate-limit test, not by the suite: the login path's
--      failure branch had no coverage for the unknown-user case.
--
-- WHY ADDITIVE ONLY
-- -----------------
-- Same rule as every pack here: no DROP, no DELETE, no TRUNCATE, IF NOT EXISTS
-- throughout, so the migration is a no-op on any database that already has the
-- columns (e.g. one provisioned by a schema that declared them).
--
-- WHY NULL IS FINE
-- ----------------
-- The identity engine treats email/phone as OPTIONAL proofs (`CanonicalUserRef`
-- marks both `?`). Existing rows keep NULL until an operator supplies them; a
-- NULL never blocks sign-in because the engine matches on username first.
-- ===========================================================================

ALTER TABLE dypos.users ADD COLUMN IF NOT EXISTS email VARCHAR(255);
ALTER TABLE dypos.users ADD COLUMN IF NOT EXISTS phone VARCHAR(64);

-- Sign-in looks users up by (tenant_id, username); the enrollment resolution
-- additionally scans active users as a whole. Both predicates are covered.
CREATE INDEX IF NOT EXISTS idx_users_tenant_username
  ON dypos.users (tenant_id, username);
