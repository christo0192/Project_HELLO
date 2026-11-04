-- 0135 — raise the fleet daily cold-dial ceiling, phone_max_daily_dials(), from 250 to 500.
--
-- WHY. Owner decision 2026-11-04. Sales Program Advisor imports that day came to 288
-- applications (145 by midday, 173 more from 18:37 IST). The midday batch, its same-day
-- retries and the other roles used all 250 dials (0132), so the evening batch could not be
-- called until the next IST day. 500 covers a day of that volume.
--
-- WHAT CHANGES. Only the constant, exactly as 0132 did. Nothing else is redeclared:
--   * admit_phone_attempt reads the value through
--     `v_max_daily constant integer := screening_v2.phone_max_daily_dials()`, so its counting
--     rule stays exactly 0094's. It counts initial / no_answer_retry / scheduled per IST day and
--     excludes reconnects and infra-deferred abandonments. Scheduled dials are counted but never
--     refused. The fleet cap is still reported before `at_capacity`.
--   * phone_max_concurrent() stays 10. The daily cap bounds the day's volume and the concurrency
--     cap bounds simultaneity. At ten live calls, 500 dials fits inside one dialling window.
--
-- STILL A MIGRATION, ON PURPOSE (0094): a blast-radius bound that any operator can raise in a
-- hurry is not a bound. Declared exactly as 0094 and 0132 declared it: `language sql immutable`,
-- pinned search_path, not SECURITY DEFINER, executable only by service_role (CREATE OR REPLACE
-- keeps the ACL; it is restated anyway). The policy_tests.sql `not_definer` exemption already
-- names this function.
--
-- No table, row or other function is touched, so this may run while calls are live. The deploy's
-- drift check (scripts/verify-prod-function-drift.sh) proves the live body reads `select 500`.
-- A dial refused today stops being refused within one due-pass tick (15 s); 0132 showed the
-- function's plan-cache invalidation takes effect without a restart. Forward-only. Raising or
-- lowering the cap again is another migration of this shape
-- (`NNNN_phone_fleet_daily_cap_<value>.sql`). See phone-0135-daily-cap.test.ts.
set local lock_timeout = '10s';

create or replace function screening_v2.phone_max_daily_dials()
returns integer
language sql
immutable
set search_path to 'pg_catalog'
as $$ select 500 $$;

comment on function screening_v2.phone_max_daily_dials() is
  'Fleet-wide cold-dial ceiling per IST day (500 since 0135; 250 in 0132; 50 in 0094). Enforced '
  'ONLY inside admit_phone_attempt, under the phone_admission advisory lock. Excludes '
  'reconnect (already-charged budget) and infra-deferred abandonments. '
  'scheduled dials are COUNTED but never refused.';

revoke all on function screening_v2.phone_max_daily_dials()
  from public, anon, authenticated;
grant execute on function screening_v2.phone_max_daily_dials() to service_role;
