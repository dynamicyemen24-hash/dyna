-- ===========================================================================
-- v152 — auth_events: widen event_type so legitimate evidence is recordable
-- ===========================================================================
--
-- WHY THIS MIGRATION EXISTS
-- -------------------------
-- `dypos.auth_events.event_type` carries a CHECK written in v135 listing the
-- ORIGINAL seven credential events and widened once in v138 for the second
-- factor. Since then the code has grown four more legitimate events —
-- identity resolution and enrollment (`identity_conflict`,
-- `identity_pending_verification`, `provision_failed`) and shift handover
-- (`shift_open`, `shift_close`) — and none of them are in the allowed set.
--
-- A CHECK that rejects a legitimate event is not a refused write, it is a
-- runtime crash on the login path: `server/authRoutes.ts` awaits the audit row
-- BEFORE returning its verdict, so an unknown username that resolves to an
-- identity decision answered 500 instead of 401/409. That is the same class as
-- DECISION_MAP P7b — a 500 that both breaks sign-in and hands an attacker the
-- enumeration oracle `GENERIC_AUTH_ERROR` exists to prevent. The rate-limit
-- suite found it (`npm run test:rate-limit`), exactly as it found P7b.
--
-- The edge never hit it only because `worker/index.ts` swallows audit failures;
-- Express did not. Both runtimes now converge on "audit must never fail the
-- sign-in" (the Express guard is in `audit()` itself), and this pack makes the
-- constraint agree with the code so the swallow is a belt-and-braces safety net
-- rather than the thing standing between a merchant and their own till.
--
-- WHY VARCHAR(32) AND NOT JUST A WIDER SET
-- ---------------------------------------
-- `identity_pending_verification` is 29 characters; `event_type` is
-- `VARCHAR(24)`. Widening the CHECK alone would trade a 23514 for a 22003 on
-- the same request — same 500, new error code.
--
-- Everything is idempotent (DROP IF EXISTS + ADD), like v138: PostgreSQL
-- cannot ALTER a constraint, and re-running the pack must be safe.
-- ===========================================================================

ALTER TABLE dypos.auth_events ALTER COLUMN event_type TYPE VARCHAR(32);

ALTER TABLE dypos.auth_events DROP CONSTRAINT IF EXISTS auth_events_event_type_check;

ALTER TABLE dypos.auth_events
  ADD CONSTRAINT auth_events_event_type_check
  CHECK (event_type IN (
    -- The original seven (v135).
    'login_success', 'login_failed', 'password_changed',
    'password_reset_requested', 'password_reset_completed',
    'account_locked', 'logout',
    -- Second factor (v138).
    'mfa_challenged', 'mfa_success', 'mfa_failed',
    -- Emergency access (v138).
    'break_glass_issued', 'break_glass_redeemed', 'break_glass_denied',
    -- Identity resolution and enrollment during sign-in.
    'identity_conflict', 'identity_pending_verification', 'provision_failed',
    -- Shift handover.
    'shift_open', 'shift_close'
  ));
