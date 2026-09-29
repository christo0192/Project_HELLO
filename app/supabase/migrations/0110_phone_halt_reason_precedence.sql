-- =====================================================================
-- 0110 — the phone kill switch records the MOST RESTRICTIVE reason in force
--
-- THE DEFECT (PR #320 review, BLOCKER)
-- ------------------------------------
-- 0042's set_phone_halt kept the FIRST reason while a halt was in force:
--
--     halt_reason = coalesce(halt_reason, p_reason)
--
-- So a `legal_hold` or `emergency_stop` raised while an everyday
-- `operator_pause` was already up was written to audit_events and nowhere
-- else. phone_control.halt_reason still said `operator_pause`, and every
-- reader that trusts that column then acted on the WEAKER reason:
--   * Mission Control's "Resume calling" button is offered only while the
--     reason in force is `operator_pause`, and /halt/clear checks the reason
--     the caller names against that same column — so one click lifted the
--     legal hold along with the pause and every eligible candidate was
--     dialled;
--   * the owner-test gate (0063/0065/0081 arm_phone_test_gate,
--     admit_phone_test_attempt, and the due loop's `gateMayRun`) may bypass
--     ONLY an `operator_pause`, and it was allowed to dial through the
--     "legal hold" because the column never said legal hold.
--
-- THE RULE
-- --------
-- While a halt is in force, the reason in force is the most restrictive of
-- (stored, requested), under this total order:
--
--     emergency_stop > legal_hold > provider_incident > cost_control
--                    > operator_pause
--
--   * A STRONGER request escalates the reason, and the escalating actor
--     becomes halt_actor_id (the system actor when none is given, exactly as
--     0042 attributes an anonymous halt). The person who raised the stop that
--     now governs is the person a reviewer needs to find.
--   * A WEAKER or EQUAL request changes nothing, as in 0042 — a pause can
--     never downgrade a legal hold.
--   * halted_at ALWAYS keeps the original instant, so "how long has dialing
--     been frozen" still measures the real outage.
--   * Not halted → identical to 0042.
--
-- The order is inlined as an array rather than a helper function: a new
-- screening_v2 function would be one more SECURITY DEFINER-adjacent object
-- for the posture sweeps to enumerate, and it would be callable on its own.
-- A stored reason the array does not rank (impossible while
-- chk_phone_control_reason holds) is never replaced — "cannot rank it" must
-- not become "overwrite it".
--
-- Clearing is unchanged: clear_phone_halt lifts whatever is in force, and
-- POST /api/phone/halt/clear still requires the caller to NAME it — which is
-- now the strongest reason, not the first.
--
-- Same signature, same security posture, same audit action and override key
-- as 0042; forward-only CREATE OR REPLACE.
-- =====================================================================

create or replace function screening_v2.set_phone_halt(
  p_reason   text,
  p_actor_id uuid        default null,
  p_now      timestamptz default now()
)
returns jsonb
language plpgsql
security definer
set search_path = pg_catalog, screening_v2
as $$
declare
  -- Ascending restrictiveness. array_position gives the rank.
  v_precedence  constant text[] := array[
    'operator_pause','cost_control','provider_incident','legal_hold','emergency_stop'];
  v_actor       constant uuid := coalesce(p_actor_id,
                                          '00000000-0000-4000-8000-000000000001'::uuid);
  v_prev_at     timestamptz;
  v_prev_reason text;
  v_escalated   boolean := false;
  v_in_force    text;
begin
  if p_reason is null or p_reason not in (
       'operator_pause','provider_incident','cost_control','legal_hold','emergency_stop') then
    return jsonb_build_object('status', 'invalid_reason');
  end if;

  insert into screening_v2.phone_control (control_key)
  values ('default') on conflict (control_key) do nothing;

  select halted_at, halt_reason into v_prev_at, v_prev_reason
    from screening_v2.phone_control
   where control_key = 'default'
   for update;

  -- Escalate only on a STRICTLY stronger reason. An unrankable stored reason
  -- yields null here, and null is not an escalation.
  if v_prev_at is not null then
    v_escalated := coalesce(
      array_position(v_precedence, p_reason) > array_position(v_precedence, v_prev_reason),
      false);
  end if;

  update screening_v2.phone_control
     -- Keep the ORIGINAL halt instant while a halt is already in force.
     set halted_at     = coalesce(halted_at, p_now),
         halt_reason   = case when v_prev_at is null or v_escalated
                              then p_reason else halt_reason end,
         halt_actor_id = case when v_prev_at is null or v_escalated
                              then v_actor else halt_actor_id end,
         updated_at    = p_now
   where control_key = 'default'
  returning halt_reason into v_in_force;

  insert into screening_v2.audit_events
    (actor_id, actor_type, action, target_type, target_id, result, metadata)
  values
    (v_actor,
     'recruiter', 'admin_session_override', 'phone_control', 'default', 'success',
     jsonb_build_object('override', 'phone_admission_halt_set',
                        'reason', p_reason,
                        'already_halted', v_prev_at is not null,
                        'previous_reason', coalesce(v_prev_reason, 'none'),
                        'reason_in_force', v_in_force,
                        'reason_escalated', v_escalated));

  return jsonb_build_object('status', 'ok',
                            'already_halted', v_prev_at is not null,
                            'halt_reason', v_in_force,
                            'reason_escalated', v_escalated);
end;
$$;

revoke all on function screening_v2.set_phone_halt(text, uuid, timestamptz)
  from public, anon, authenticated;
grant execute on function screening_v2.set_phone_halt(text, uuid, timestamptz) to service_role;

comment on function screening_v2.set_phone_halt is
  'Freezes ALL new outbound phone admission fleet-wide with no deploy, '
  'preserving the original halt instant across repeated calls. While a halt '
  'is in force the reason escalates to the MOST RESTRICTIVE requested '
  '(emergency_stop > legal_hold > provider_incident > cost_control > '
  'operator_pause) and is never downgraded; an escalation re-attributes the '
  'halt to the escalating actor. Returns the reason in force. Audited and '
  'attributable. Dialing cannot resume without clear_phone_halt: there is no '
  'automatic restart. Service-role-only.';
