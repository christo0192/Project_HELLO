-- 0111_phone_owner_test_night_2026_09_30.sql
--
-- ONE-NIGHT OWNER TEST ALLOWANCE (owner request, 2026-09-30 ~22:00 IST).
--
-- The owner needs ONE test call after 21:00 IST tonight to verify the phone
-- worker's RNNoise release (#324) end to end. The 09:00–21:00 IST window is a
-- legal control, so this is deliberately the narrowest possible opening:
--
--   * ONE IST calendar date, 2026-09-30, written as a literal — it is not a
--     cutoff. Every other date keeps exactly its 0085/0092 behaviour, so all
--     historical assertions (09-10..09-29 closed at night) still hold, and the
--     allowance EXPIRES BY ITSELF at 00:00 IST 2026-10-01 with no revert
--     migration needed.
--   * Only the call-start predicate changes. `phone_next_window_open` is left
--     as 0085 declared it: for every instant at or after 09:00 IST it defers to
--     this predicate (its third branch), which covers the whole of tonight.
--   * Real candidates are NOT exposed: the owner test gate (0063/0081) only
--     arms while the operator halt is raised with reason `operator_pause`, and
--     a raised halt stops the ordinary due loop. The runbook for tonight is:
--     raise the halt -> arm the test gate on the owner's own engagement ->
--     call -> clear the halt the next morning.
--
-- The TypeScript mirror (`PHONE_OWNER_TEST_247_DATES_IST` in
-- app/api/src/lib/phone-screening/ist-window.ts) carries the same single date;
-- the due-loop preflight consults that mirror before SQL, so the two move
-- together (the 2026-09-07 drift lesson recorded in ist-window.ts).

create or replace function screening_v2.phone_ist_window_open(p_at timestamptz)
returns boolean
language sql
stable
set search_path = pg_catalog, screening_v2
as $$
  select (p_at at time zone 'Asia/Kolkata')::date
           <= screening_v2.phone_temporary_247_until()
      or (p_at at time zone 'Asia/Kolkata')::date = date '2026-09-30'
      or (
        (p_at at time zone 'Asia/Kolkata')::time >= screening_v2.phone_ist_window_open_at()
        and (p_at at time zone 'Asia/Kolkata')::time < screening_v2.phone_ist_window_close_at()
      )
$$;

revoke all on function screening_v2.phone_ist_window_open(timestamptz)
  from public, anon, authenticated;
grant execute on function screening_v2.phone_ist_window_open(timestamptz) to service_role;

comment on function screening_v2.phone_ist_window_open is
  'True when a call may START: 09:00 inclusive to 21:00 exclusive IST, all '
  'seven days, plus two dated allowances — all hours through the elapsed '
  'phone_temporary_247_until() cutoff (2026-09-09), and all hours on the single '
  'owner-test date 2026-09-30 (0111; expires 00:00 IST 2026-10-01). Call '
  'duration is not bounded here. Service-role-only.';
