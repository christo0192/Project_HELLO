-- 0081_owner_test_gate_scheduled.sql
--
-- Owner-test path for an ALREADY-SCHEDULED engagement (2026-09-05).
--
-- WHY: A real owner-test attempt on candidate 0cd4b8e0… was refused. The
-- operator route `POST /api/candidates/{id}/phone-test-gate` mints a FRESH
-- rescreen cycle first, but that candidate already had an active `scheduled`
-- cycle (a due appointment), so `request_phone_rescreen` returned
-- `active_cycle` and the whole request 409'd before a gate was ever armed.
-- Even bypassing the rescreen, the 0065 `arm_phone_test_gate` refuses any
-- engagement whose state is not exactly `eligible` (`test_gate_not_eligible`).
-- A legitimately scheduled, consented, DUE engagement therefore could not be
-- owner-test-dialled at all.
--
-- This migration widens the arm gate — and ONLY the arm gate — so that an
-- engagement whose slot is genuinely DUE right now can be armed on its
-- EXISTING cycle. Nothing about admission changes: `admit_phone_attempt`
-- still enforces consent, allowlist, number, IST window, lease, capacity and
-- the daily cap under the same advisory serialiser. The operator pause is
-- neither cleared nor modified; the gate is still the single-active,
-- candidate-and-engagement-scoped, `operator_pause`-only exception it has
-- always been.
--
-- Exactly TWO behavioural changes relative to 0065, both scoped to
-- `v_state = 'scheduled'`:
--
--   1. The state guard accepts `'scheduled'` in addition to `'eligible'`.
--      The terminal check is unchanged: a terminal engagement is still
--      refused with `test_gate_not_eligible`.
--
--   2. When (and only when) the state is `'scheduled'`, the engagement must
--      also have a genuinely DUE, VALID live appointment — the active
--      (`scheduled`|`confirmed`) row whose window contains `p_now`
--      (`starts_at <= p_now AND ends_at > p_now`). A future slot, an expired
--      slot, or a cancelled/superseded/fulfilled/missed row is NOT due, so
--      the arm is refused with the new status `test_gate_appointment_not_due`.
--      This makes the widened path unable to dial a slot that is not
--      currently owed: it cannot pre-empt a future booking and cannot
--      resurrect a past one.
--
-- `v_state = 'eligible'` behaviour is byte-for-byte identical to 0065: no
-- appointment is read and no appointment requirement applies. Every other
-- guard — actor_required, request_id format, expiry bounds (60s..15min),
-- the `operator_pause`-only halt requirement, engagement lookup + candidate
-- match, application-link lock, idempotency (`already_armed` /
-- `idempotency_conflict`), expired-gate retirement, the single-active-gate
-- unique check, `security definer`, `set search_path`, and the grants/revokes
-- — is preserved exactly. Forward-only `create or replace`.

create or replace function screening_v2.arm_phone_test_gate(
  p_candidate_id  uuid,
  p_engagement_id uuid,
  p_actor_id      uuid,
  p_request_id    text,
  p_expires_at    timestamptz,
  p_now           timestamptz default now()
)
returns jsonb
language plpgsql
security definer
set search_path = pg_catalog, screening_v2
as $$
declare
  v_ctl            record;
  v_link_id        uuid;
  v_candidate_id   uuid;
  v_state          text;
  v_terminal_at    timestamptz;
  v_due_exists     boolean;
  v_existing       screening_v2.phone_test_gates%rowtype;
  v_gate           screening_v2.phone_test_gates%rowtype;
begin
  perform pg_advisory_xact_lock(hashtext('phone_admission'));

  if p_actor_id is null then return jsonb_build_object('status', 'actor_required'); end if;
  if p_request_id is null or p_request_id !~ '^[A-Za-z0-9_.:-]{1,128}$' then
    return jsonb_build_object('status', 'invalid_request_id');
  end if;
  if p_expires_at is null or p_expires_at <= p_now + interval '60 seconds'
     or p_expires_at > p_now + interval '15 minutes' then
    return jsonb_build_object('status', 'invalid_expiry');
  end if;

  select halted_at, halt_reason into v_ctl
    from screening_v2.phone_control
   where control_key = 'default'
   for share;
  if not found then return jsonb_build_object('status', 'halt_unreadable'); end if;
  if v_ctl.halted_at is null then
    return jsonb_build_object('status', 'test_gate_requires_halt');
  end if;
  if v_ctl.halt_reason <> 'operator_pause' then
    return jsonb_build_object('status', 'test_gate_halt_not_permitted');
  end if;

  select application_link_id, candidate_id into v_link_id, v_candidate_id
    from screening_v2.phone_engagements
   where id = p_engagement_id;
  if not found then return jsonb_build_object('status', 'engagement_not_found'); end if;
  if v_candidate_id <> p_candidate_id then
    return jsonb_build_object('status', 'candidate_mismatch');
  end if;

  select * into v_existing
    from screening_v2.phone_test_gates
   where request_id = p_request_id
   for update;
  if found then
    if v_existing.candidate_id <> p_candidate_id
       or v_existing.engagement_id <> p_engagement_id then
      return jsonb_build_object('status', 'idempotency_conflict');
    end if;
    -- A CONSUMED gate is spent history: one request key authorizes one test.
    -- A STILL-ACTIVE gate is idempotent success. Only an EXPIRED, unconsumed
    -- gate falls through to the refresh below — before this migration that
    -- case answered `already_armed` with a dead expiry, which the route
    -- reported to the operator as "armed" while nothing could ever dial.
    if v_existing.consumed_at is not null
       or v_existing.expires_at > p_now then
      return jsonb_build_object('status', 'already_armed', 'gate_id', v_existing.id,
        'candidate_id', v_existing.candidate_id, 'engagement_id', v_existing.engagement_id,
        'expires_at', v_existing.expires_at);
    end if;
  end if;

  -- Lock order matches admission: advisory -> application link -> engagement.
  perform 1 from screening_v2.ashby_application_links
   where id = v_link_id
   for update;
  if not found then return jsonb_build_object('status', 'application_not_found'); end if;
  select state, terminal_at into v_state, v_terminal_at
    from screening_v2.phone_engagements
   where id = p_engagement_id
   for update;
  if not found then return jsonb_build_object('status', 'engagement_not_found'); end if;
  -- 0081 widens the state guard from `eligible` only to `eligible` OR
  -- `scheduled`, so an owner test can be armed on an existing due engagement
  -- instead of forcing a fresh rescreen cycle. The terminal check is
  -- unchanged: a terminal engagement is never gate-armable.
  if v_terminal_at is not null or v_state not in ('eligible', 'scheduled') then
    return jsonb_build_object('status', 'test_gate_not_eligible', 'state', coalesce(v_state, 'unknown'));
  end if;

  -- 0081: the `scheduled` widening is only safe when the slot is genuinely
  -- OWED right now. Read the engagement's LIVE appointment (the at-most-one
  -- `scheduled`|`confirmed` row, per uq_phone_appointments_one_live) and
  -- require its window to contain `p_now`: starts_at <= now AND ends_at > now.
  -- A future slot, an expired slot, or any cancelled/superseded/fulfilled/
  -- missed row is not live-and-due, so the gate is refused. `eligible`
  -- engagements skip this check entirely — their arm behaviour is unchanged
  -- from 0065.
  if v_state = 'scheduled' then
    select exists (
      select 1 from screening_v2.phone_appointments
       where engagement_id = p_engagement_id
         and status in ('scheduled', 'confirmed')
         and starts_at <= p_now
         and ends_at > p_now
    ) into v_due_exists;
    if not v_due_exists then
      return jsonb_build_object('status', 'test_gate_appointment_not_due', 'state', v_state);
    end if;
  end if;

  -- Expired gates are retired under the same admission serialiser before the
  -- global unique index is tested. They cannot silently block the next window.
  update screening_v2.phone_test_gates
     set consumed_at = p_now
   where consumed_at is null and expires_at <= p_now
     and (v_existing.id is null or id <> v_existing.id);

  select * into v_gate
    from screening_v2.phone_test_gates
   where consumed_at is null and expires_at > p_now
   for update;
  if found then
    return jsonb_build_object('status', 'test_gate_already_armed');
  end if;

  if v_existing.id is not null then
    -- Refresh the expired, unconsumed gate in place: the request key keeps
    -- its one-row identity, the expiry becomes real again, and the audit
    -- trail records the re-arm as its own action.
    update screening_v2.phone_test_gates
       set expires_at = p_expires_at, actor_id = p_actor_id
     where id = v_existing.id
     returning * into v_gate;

    insert into screening_v2.audit_events
      (actor_id, actor_type, action, target_type, target_id, result, metadata)
    values
      (p_actor_id, 'recruiter', 'phone_test_gate_rearmed', 'phone_engagement',
       v_gate.engagement_id::text, 'success',
       jsonb_build_object('candidate_id', v_gate.candidate_id,
         'gate_id', v_gate.id, 'request_id', v_gate.request_id,
         'expires_at', v_gate.expires_at));

    return jsonb_build_object('status', 'ok', 'gate_id', v_gate.id,
      'candidate_id', v_gate.candidate_id, 'engagement_id', v_gate.engagement_id,
      'expires_at', v_gate.expires_at);
  end if;

  insert into screening_v2.phone_test_gates
    (candidate_id, engagement_id, actor_id, request_id, created_at, expires_at)
  values
    (p_candidate_id, p_engagement_id, p_actor_id, p_request_id, p_now, p_expires_at)
  returning * into v_gate;

  insert into screening_v2.audit_events
    (actor_id, actor_type, action, target_type, target_id, result, metadata)
  values
    (p_actor_id, 'recruiter', 'phone_test_gate_armed', 'phone_engagement',
     v_gate.engagement_id::text, 'success',
     jsonb_build_object('candidate_id', v_gate.candidate_id,
       'gate_id', v_gate.id, 'request_id', v_gate.request_id,
       'expires_at', v_gate.expires_at));

  return jsonb_build_object('status', 'ok', 'gate_id', v_gate.id,
    'candidate_id', v_gate.candidate_id, 'engagement_id', v_gate.engagement_id,
    'expires_at', v_gate.expires_at);
end;
$$;

revoke all on function screening_v2.arm_phone_test_gate(uuid, uuid, uuid, text, timestamptz, timestamptz)
  from public, anon, authenticated;
grant execute on function screening_v2.arm_phone_test_gate(uuid, uuid, uuid, text, timestamptz, timestamptz)
  to service_role;

comment on function screening_v2.arm_phone_test_gate(uuid, uuid, uuid, text, timestamptz, timestamptz) is
  'Arms the exclusive, single-active, operator_pause-only owner-test gate for '
  'ONE candidate/engagement. 0081 widened the state guard to accept a '
  '`scheduled` engagement in addition to `eligible`, but only when that '
  'engagement has a genuinely DUE live appointment (starts_at <= now < '
  'ends_at); otherwise it refuses with test_gate_appointment_not_due. '
  'Admission (admit_phone_attempt) still enforces every consent/allowlist/'
  'number/window/lease/capacity/cap check under the advisory lock; this '
  'function only mints the exception, it does not weaken admission.';
