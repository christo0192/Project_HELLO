-- =====================================================================
-- 0092 — end the temporary 24/7 phone-calling window; restore 09:00–21:00 IST
--
-- The all-hours window was a reviewed, date-bounded TESTING allowance:
-- 0064 opened it through 2026-09-06 and 0085 extended it through 2026-09-13.
-- Testing finished on 2026-09-10 (owner decision), so the cutoff is pulled
-- back to 2026-09-09 — the last IST calendar date that has already ended —
-- and from the moment this applies every call start is governed by the
-- original 0042 window again: 09:00 inclusive to 21:00 exclusive,
-- Asia/Kolkata, all seven days.
--
-- WHY MOVE THE DATE RATHER THAN DELETE THE MECHANISM
-- `phone_ist_window_open` and `phone_next_window_open` (0085 bodies) read
-- `phone_temporary_247_until()` and fall through to the 0042 bounds for any
-- IST date after it. A cutoff in the past therefore IS the permanent window,
-- with no second predicate to keep in step, and the TypeScript mirror
-- (`lib/phone-screening/ist-window.ts`, `PHONE_TEMPORARY_247_UNTIL_IST`) is
-- moved to the same date in the same change — the 2026-09-07 incident showed
-- what a lone out-of-band change to one side does (an approved extension went
-- inert after 21:00 IST because the due-loop preflight consults the mirror).
--
-- The cutoff is deliberately not an environment variable. It is a reviewed
-- migration fact, shared by admission and retry scheduling, and cannot be
-- re-extended by changing a deployment secret. This migration changes no
-- halt, consent, suppression, budget, concurrency, recording or provider
-- control, and no function body.
--
-- EFFECT ON WORK ALREADY BOOKED
-- A scheduled slot or retry that testing placed outside 09:00–21:00 IST is
-- no longer admissible at its instant; `admit_phone_attempt` refuses it as
-- outside the window and `phone_next_window_open` defers it to the next
-- 09:00 IST, exactly as for any after-hours instant before 0064 existed.
-- =====================================================================

create or replace function screening_v2.phone_temporary_247_until()
returns date
language sql
immutable
set search_path = pg_catalog
as $$ select date '2026-09-09' $$;

revoke all on function screening_v2.phone_temporary_247_until()
  from public, anon, authenticated;
grant execute on function screening_v2.phone_temporary_247_until() to service_role;

comment on function screening_v2.phone_temporary_247_until is
  'The inclusive final IST calendar date of the reviewed temporary 24/7 '
  'calling window (2026-09-09 — already elapsed, so the window is closed). '
  'The normal 09:00–21:00 IST window governs every later date. '
  'Service-role-only.';

comment on function screening_v2.phone_ist_window_open is
  'True when a call may START: 09:00 inclusive to 21:00 exclusive IST, all '
  'seven days (the temporary all-hours allowance ended 2026-09-09). Call '
  'duration is not bounded here. Service-role-only.';

comment on function screening_v2.phone_next_window_open is
  'The next legal call-start instant under the 09:00–21:00 IST window: the '
  'argument itself when inside it, otherwise the next 09:00 IST. The '
  'temporary all-hours allowance ended 2026-09-09. Service-role-only.';
