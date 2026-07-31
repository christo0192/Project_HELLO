-- =====================================================================
-- Seeded NEGATIVE fixture for TST-15 (migrate-rollback.test.mjs).
--
-- This migration is INTENTIONALLY incompatible with the forward-only
-- migration strategy (no reverse SQL exists for 0001-0013). It is NOT part
-- of app/supabase/migrations and is never applied to any database. It exists
-- only so the rollback/compatibility gate can be proven non-vacuous: the
-- verifier must flag every statement here as RED (fail-closed).
--
-- Pattern: a migration that destroys data-bearing schema without any down
-- migration to undo it, references an unknown table, and narrows a column
-- type — all unrecoverable under the forward-only strategy.
-- =====================================================================

drop table screening_v2.candidates;

alter table screening_v2.transcript_events drop column payload;

alter table screening_v2.no_such_table add column x integer;

alter table screening_v2.roles alter column name type varchar(10);
