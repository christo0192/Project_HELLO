-- =====================================================================
-- L5 scratch destructive fixture for TST-15 (migrate-rollback.test.mjs).
--
-- INTENTIONALLY incompatible with the forward-only migration strategy.
-- NOT part of app/supabase/migrations and never applied to any database.
-- It exists only to prove the destructive-change detector is LIVE for a
-- data-destroying verb (TRUNCATE) not covered by the 9001 fixture: the
-- verifier must flag this statement RED (fail-closed) alongside 9001.
-- =====================================================================

truncate screening_v2.call_sessions;
