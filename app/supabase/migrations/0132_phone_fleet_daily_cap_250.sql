-- 0132 — raise the fleet daily cold-dial ceiling, phone_max_daily_dials(), from 50 to 250.
--
-- WHY. Owner decision 2026-11-03. A 96-application Ashby batch (Sales Program Advisor) used the
-- 50-per-IST-day ceiling by 13:06 IST, and every remaining due engagement (46 never dialled) was
-- refused `fleet_daily_cap_reached` for the rest of the window. The next day had about 88 due for
-- that role alone. The pass logs it as a benign refusal, so nothing alerted. It looked like a stall.
--
-- WHAT CHANGES. Only the constant. Nothing else is redeclared:
--   * admit_phone_attempt (latest body 0130) reads the value through
--     `v_max_daily constant integer := screening_v2.phone_max_daily_dials()`, so its counting
--     rule stays exactly 0094's. It counts initial / no_answer_retry / scheduled per IST day and
--     excludes reconnects and infra-deferred abandonments. Scheduled dials are counted but never
--     refused. The order of refusals is unchanged too: the fleet cap is reported before
--     `at_capacity`.
--   * phone_max_concurrent() stays 10. The daily cap bounds the day's volume and the concurrency
--     cap bounds simultaneity. At ten live calls, 250 dials is a few hours of dialling.
--
-- STILL A MIGRATION, ON PURPOSE (0094): a blast-radius bound that any operator can raise in a
-- hurry is not a bound. Declared exactly as 0094 declared it: `language sql immutable`, pinned
-- search_path, not SECURITY DEFINER, executable only by service_role (CREATE OR REPLACE keeps the
-- ACL; it is restated anyway, as 0094 did). The policy_tests.sql `not_definer` exemption already
-- names this function.
--
-- No table, row or other function is touched, so this may run while calls are live. The deploy's
-- drift check (scripts/verify-prod-function-drift.sh) proves the live body reads `select 250`.
-- Whether admission is using it shows on the due pass: the `phone_due_refusal` log line
-- `admission_refused:fleet_daily_cap_reached` should stop within one tick (15 s). Forward-only.
-- Raising or lowering the cap again is another migration of this shape
-- (`NNNN_phone_fleet_daily_cap_<value>.sql`). See phone-0132-daily-cap.test.ts.
set local lock_timeout = '10s';

create or replace function screening_v2.phone_max_daily_dials()
returns integer
language sql
immutable
set search_path to 'pg_catalog'
as $$ select 250 $$;

comment on function screening_v2.phone_max_daily_dials() is
  'Fleet-wide cold-dial ceiling per IST day (250 since 0132; 50 in 0094). Enforced ONLY inside '
  'admit_phone_attempt, under the phone_admission advisory lock. Excludes '
  'reconnect (already-charged budget) and infra-deferred abandonments. '
  'scheduled dials are COUNTED but never refused.';

revoke all on function screening_v2.phone_max_daily_dials()
  from public, anon, authenticated;
grant execute on function screening_v2.phone_max_daily_dials() to service_role;
