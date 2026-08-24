-- ═══════════════════════════════════════════════════════════════════════
--  teardown.sql — remove the Canary-0 substrate
-- ═══════════════════════════════════════════════════════════════════════
--
-- The runner applies this LAST, after `canary0.sql` and after the Node-
-- driven halt race. Safe when the substrate is already absent, so a run
-- that aborted early still cleans up.
--
-- It removes the canary ROLE as well as the schema. Dropping the schema
-- alone would leave a row in `screening_v2.roles` behind, and "the canary
-- leaves nothing behind" has to be true of the whole database rather than
-- of one schema. The role is removed only when nothing references it:
-- `ashby_job_mappings.role_id` is ON DELETE RESTRICT, so an unconditional
-- delete would ABORT this file whenever a fixture leaked — turning a
-- cleanup that should report the leak into one that fails on it.

\set QUIET on
\o /dev/null
set client_min_messages = warning;

drop schema if exists _phone_canary cascade;

delete from screening_v2.roles r
 where r.title = 'canary0 role'
   and not exists (select 1 from screening_v2.ashby_job_mappings m where m.role_id = r.id)
   and not exists (select 1 from screening_v2.candidates c where c.role_id = r.id)
   and not exists (select 1 from screening_v2.call_sessions s where s.role_id = r.id)
   and not exists (select 1 from screening_v2.phone_engagements e where e.role_id = r.id);

\o
