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
-- control. It changes ONE function body (the appointment trigger, below) and
-- repairs the rows that body would otherwise strand.
--
-- EFFECT ON WORK ALREADY BOOKED — AND THE TRAP THE FIRST DRAFT MISSED
-- A due engagement whose `next_eligible_at` fell after hours is simply
-- refused by `admit_phone_attempt` (`window_closed`, nothing charged) and
-- picked up at 09:00 IST. APPOINTMENTS are different. 0042's trigger
-- `enforce_phone_appointment_window` fired on EVERY update and re-validated
-- `starts_at` against the window, so a slot booked legitimately at, say,
-- 03:00 IST on 2026-09-11 under the 24/7 allowance would — the moment this
-- cutoff moved — throw P0001 on any later UPDATE: `cancel_phone_appointment`
-- (HR could not cancel it), the supersede in `schedule_phone_appointment`
-- (the engagement could not be rebooked), `admit_phone_attempt`'s
-- `status='fulfilled'` write (the scheduled dial itself would abort), and
-- `expire_phone_appointments`, whose `order by ends_at` scan would hit that
-- row first every tick and abort the WHOLE sweep — no appointment fleet-wide
-- would expire. Two repairs, in order:
--   1. The trigger re-validates the SLOT only when it is set or moved
--      (INSERT, or an UPDATE that changes `starts_at`/`ends_at`). A
--      status-only transition on a row booked under a wider window passes.
--   2. Live after-hours rows (`scheduled`/`confirmed`, start outside the
--      restored window) are cancelled with a stable reason and their
--      engagements returned to `eligible`, mirroring `expire_phone_appointments`
--      — an uncharged, audited, single pass. Nothing dials from this block.
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

-- ── 1. The appointment trigger validates the SLOT, not every write ──────
-- Body otherwise identical to 0042: `ist_date` is still derived (never
-- supplied), the window and the no-midnight-straddle rules still apply to
-- every INSERT and to every UPDATE that moves the slot. What changes is that
-- an UPDATE which leaves `starts_at` and `ends_at` untouched — a status
-- transition — no longer re-litigates a start instant that was legal when it
-- was booked. The trigger definition itself (before insert or update, for
-- each row) is unchanged; only the function is replaced.
create or replace function screening_v2.enforce_phone_appointment_window()
returns trigger
language plpgsql
security invoker
set search_path = pg_catalog, screening_v2
as $$
begin
  -- Derived, never supplied: a caller cannot lie about which IST day a
  -- slot belongs to.
  new.ist_date := screening_v2.phone_ist_date(new.starts_at);

  if tg_op = 'UPDATE'
     and new.starts_at = old.starts_at
     and new.ends_at = old.ends_at then
    -- A status-only transition. The slot was validated when it was set; a
    -- window that has since narrowed must not make the row un-cancellable,
    -- un-expirable or un-fulfillable.
    return new;
  end if;

  if not screening_v2.phone_ist_window_open(new.starts_at) then
    raise exception 'phone appointment start is outside the approved IST calling window'
      using errcode = 'P0001';
  end if;
  if screening_v2.phone_ist_date(new.starts_at)
     <> screening_v2.phone_ist_date(new.ends_at) then
    raise exception 'phone appointment may not straddle IST midnight'
      using errcode = 'P0001';
  end if;
  return new;
end;
$$;

comment on function screening_v2.enforce_phone_appointment_window is
  'Derives phone_appointments.ist_date and enforces the approved IST START '
  'window plus the no-IST-midnight-straddle rule on INSERT and on any UPDATE '
  'that moves the slot. A status-only UPDATE is not re-validated (0092), so a '
  'slot booked under an earlier, wider window can still be cancelled, '
  'expired or fulfilled. A trigger rather than a CHECK because `at time zone` '
  'is STABLE and a CHECK expression must be IMMUTABLE.';

-- ── 2. One pass over the rows the testing window left behind ────────────
-- Mirrors `expire_phone_appointments` exactly (status + reason + version,
-- engagement scheduled→eligible with next_eligible_at = now, one audit row,
-- budget_charged=false) so the outcome is one the runbook already describes.
-- Idempotent: a re-run finds no live after-hours rows. The reason literal
-- satisfies chk_phone_appointments_cancel_reason (`^[a-z0-9_.:-]{1,64}$`).
do $$
declare
  v_now   constant timestamptz := now();
  v_row   record;
  v_count integer := 0;
begin
  for v_row in
    select a.id, a.engagement_id
      from screening_v2.phone_appointments a
     where a.status in ('scheduled', 'confirmed')
       and not screening_v2.phone_ist_window_open(a.starts_at)
     order by a.starts_at
       for update
  loop
    update screening_v2.phone_appointments
       set status        = 'cancelled',
           cancel_reason = 'window_restored_0092',
           version       = version + 1,
           updated_at    = v_now
     where id = v_row.id;

    update screening_v2.phone_engagements
       set state            = 'eligible',
           state_reason     = 'appointment_window_restored',
           next_eligible_at = v_now,
           version          = version + 1,
           updated_at       = v_now
     where id = v_row.engagement_id
       and terminal_at is null
       and state = 'scheduled';

    insert into screening_v2.audit_events
      (actor_id, actor_type, action, target_type, target_id, result, metadata)
    values
      ('00000000-0000-0000-0000-000000000000'::uuid, 'system',
       'phone_appointment_window_restored', 'phone_appointment', v_row.id::text, 'success',
       jsonb_build_object('engagement_id', v_row.engagement_id,
                          'migration', '0092',
                          'budget_charged', false));

    v_count := v_count + 1;
  end loop;

  raise notice '0092: cancelled % after-hours appointment(s) left by the temporary 24/7 window', v_count;
end;
$$;
