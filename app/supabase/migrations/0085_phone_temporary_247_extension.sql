-- =====================================================================
-- 0085 — re-assert the temporary 24/7 phone-calling window at 2026-09-13
--
-- The live database's `phone_temporary_247_until()` was already extended
-- out-of-band to 2026-09-13 (owner-approved), but the repo SQL still said
-- 2026-09-06 and the deployed TypeScript mirror still gated the due-loop
-- preflight on the old date — so the extension was inert after 21:00 IST.
-- This migration makes repo SQL equal to the live database by re-asserting
-- the 0064-style function bodies with the 2026-09-13 cutoff; against the
-- already-extended production database it is a no-op-equivalent re-apply.
--
-- The normal 09:00 inclusive / 21:00 exclusive IST bounds remain intact in
-- 0042: every instant on or before 2026-09-13 in Asia/Kolkata is legal for a
-- call start; from 2026-09-14 onward the original 09:00–21:00 window applies
-- again.
--
-- The cutoff is deliberately not an environment variable.  It is a reviewed
-- migration fact, shared by admission and retry scheduling, and cannot be
-- extended by changing a deployment secret.  This migration changes no halt,
-- consent, suppression, budget, concurrency, recording or provider control.
-- =====================================================================

create or replace function screening_v2.phone_temporary_247_until()
returns date
language sql
immutable
set search_path = pg_catalog
as $$ select date '2026-09-13' $$;

revoke all on function screening_v2.phone_temporary_247_until()
  from public, anon, authenticated;
grant execute on function screening_v2.phone_temporary_247_until() to service_role;

comment on function screening_v2.phone_temporary_247_until is
  'The inclusive final IST calendar date of the reviewed temporary 24/7 '
  'calling window. The normal 09:00–21:00 IST window resumes on the next '
  'IST date. Service-role-only.';

create or replace function screening_v2.phone_ist_window_open(p_at timestamptz)
returns boolean
language sql
stable
set search_path = pg_catalog, screening_v2
as $$
  select (p_at at time zone 'Asia/Kolkata')::date
           <= screening_v2.phone_temporary_247_until()
      or (
        (p_at at time zone 'Asia/Kolkata')::time >= screening_v2.phone_ist_window_open_at()
        and (p_at at time zone 'Asia/Kolkata')::time < screening_v2.phone_ist_window_close_at()
      )
$$;

revoke all on function screening_v2.phone_ist_window_open(timestamptz)
  from public, anon, authenticated;
grant execute on function screening_v2.phone_ist_window_open(timestamptz) to service_role;

comment on function screening_v2.phone_ist_window_open is
  'True when a call may START: all hours through 2026-09-13 inclusive in '
  'Asia/Kolkata, then the original 09:00 inclusive to 21:00 exclusive IST '
  'window. Call duration is not bounded here. Service-role-only.';

create or replace function screening_v2.phone_next_window_open(p_at timestamptz)
returns timestamptz
language sql
stable
set search_path = pg_catalog, screening_v2
as $$
  select case
    -- During the temporary period, the instant itself is already legal.
    when (p_at at time zone 'Asia/Kolkata')::date
           <= screening_v2.phone_temporary_247_until()
      then p_at
    -- After the override, restore the original daily window semantics.
    when (p_at at time zone 'Asia/Kolkata')::time < screening_v2.phone_ist_window_open_at()
      then ((p_at at time zone 'Asia/Kolkata')::date
              + screening_v2.phone_ist_window_open_at())
             at time zone 'Asia/Kolkata'
    when screening_v2.phone_ist_window_open(p_at) then p_at
    else (((p_at at time zone 'Asia/Kolkata')::date + 1)
            + screening_v2.phone_ist_window_open_at())
           at time zone 'Asia/Kolkata'
  end
$$;

revoke all on function screening_v2.phone_next_window_open(timestamptz)
  from public, anon, authenticated;
grant execute on function screening_v2.phone_next_window_open(timestamptz) to service_role;

comment on function screening_v2.phone_next_window_open is
  'The next legal call-start instant: the argument itself through the fixed '
  '2026-09-13 IST cutoff, and thereafter the restored 09:00–21:00 IST '
  'window. Service-role-only.';
