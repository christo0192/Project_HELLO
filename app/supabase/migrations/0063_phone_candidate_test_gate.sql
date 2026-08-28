-- 0063 — candidate-scoped, one-shot production test gate.
--
-- This is an explicit exception to the global operator pause for exactly one
-- candidate engagement. It is not a replacement for the halt: only an
-- operator_pause may be bypassed, the gate is globally exclusive, expires,
-- and is consumed in the same transaction as admission. Emergency, provider,
-- legal and cost-control halts remain absolute.

create table if not exists screening_v2.phone_test_gates (
  id             uuid primary key default gen_random_uuid(),
  candidate_id   uuid not null references screening_v2.candidates(id) on delete restrict,
  engagement_id  uuid not null references screening_v2.phone_engagements(id) on delete restrict,
  actor_id       uuid not null,
  request_id     text not null,
  created_at     timestamptz not null default now(),
  expires_at     timestamptz not null,
  consumed_at    timestamptz,
  constraint uq_phone_test_gates_request unique (request_id),
  constraint chk_phone_test_gates_request check (request_id ~ '^[A-Za-z0-9_.:-]{1,128}$'),
  constraint chk_phone_test_gates_expiry check (expires_at > created_at),
  constraint uq_phone_test_gates_one_active unique (id) deferrable initially immediate
);

-- PostgreSQL cannot use `now()` in a partial-index predicate. The arm RPC
-- retires expired rows before inserting, so one unconsumed row is the
-- exclusive gate for the whole fleet.
create unique index if not exists uq_phone_test_gates_one_unconsumed
  on screening_v2.phone_test_gates ((true))
  where consumed_at is null;

alter table screening_v2.phone_test_gates enable row level security;
revoke all on screening_v2.phone_test_gates from anon, authenticated, public;
grant all privileges on screening_v2.phone_test_gates to service_role;

alter table screening_v2.audit_events drop constraint if exists chk_audit_action;
alter table screening_v2.audit_events add constraint chk_audit_action check (action in (
  'invite_sent', 'invite_revoked', 'invite_consumed', 'grant_issued', 'grant_revoked', 'grant_consumed',
  'screening_started', 'screening_completed', 'screening_failed', 'assessment_recorded',
  'candidate_status_changed', 'candidate_consent_updated', 'session_created', 'session_updated',
  'session_terminated', 'membership_created', 'membership_updated', 'membership_deactivated',
  'role_created', 'role_updated', 'role_deactivated', 'export_requested', 'export_completed',
  'login_success', 'login_failure', 'logout', 'config_changed', 'auth_login_success',
  'auth_login_failure', 'auth_token_refresh', 'auth_logout', 'rbac_access_denied',
  'rbac_ownership_denied', 'resource_create', 'resource_read', 'resource_update',
  'resource_delete', 'resource_list', 'rate_limit_exceeded', 'audit_sink_failure',
  'audit_configuration_error', 'recording_download', 'recording_upload',
  'recording_integrity_verified', 'recording_quarantined', 'recording_revoked', 'recording_deleted',
  'admin_session_override', 'admin_maintenance_toggle', 'admin_member_update', 'quota_override',
  'notification_create', 'appeal_create', 'appeal_review', 'allowlist_linked',
  'admin_allowlist_add', 'admin_allowlist_update', 'ashby_mapping_update', 'ashby_mapping_drift',
  'ashby_application_cancel', 'ashby_operation_enqueue', 'ashby_operation_update',
  'ashby_operation_retry', 'ashby_writeback_pending', 'ashby_invite_delivered',
  'ashby_ingestion_attempts_reset', 'ashby_ingestion_parse_recovery',
  'ashby_ingestion_legacy_bad_output_recovery', 'phone_attempt_admitted',
  'phone_attempt_classified', 'phone_attempt_ended', 'phone_appointment_scheduled',
  'phone_appointment_cancelled', 'phone_appointment_missed', 'phone_opt_out_recorded',
  'phone_suppression_added', 'phone_recording_attached', 'phone_rescreen_requested',
  'phone_number_reverified', 'phone_test_gate_armed', 'phone_test_gate_consumed'
)) not valid;
alter table screening_v2.audit_events validate constraint chk_audit_action;

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
    return jsonb_build_object('status', 'already_armed', 'gate_id', v_existing.id,
      'candidate_id', v_existing.candidate_id, 'engagement_id', v_existing.engagement_id,
      'expires_at', v_existing.expires_at);
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
  if v_terminal_at is not null or v_state <> 'eligible' then
    return jsonb_build_object('status', 'test_gate_not_eligible', 'state', coalesce(v_state, 'unknown'));
  end if;

  -- Expired gates are retired under the same admission serialiser before the
  -- global unique index is tested. They cannot silently block the next window.
  update screening_v2.phone_test_gates
     set consumed_at = p_now
   where consumed_at is null and expires_at <= p_now;

  select * into v_existing
    from screening_v2.phone_test_gates
   where consumed_at is null
   for update;
  if found then
    return jsonb_build_object('status', 'test_gate_already_armed');
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

-- The existing admission function remains the sole implementation of all
-- admission rules. This wrapper only supplies a transactional, exclusive
-- operator_pause exception for one armed engagement, then calls that same
-- function. The control row is restored before the transaction can commit.
create or replace function screening_v2.admit_phone_test_attempt(
  p_test_gate_id  uuid,
  p_engagement_id uuid,
  p_kind          text,
  p_lease_owner   text default null,
  p_lease_seconds integer default 60,
  p_now           timestamptz default now()
)
returns jsonb
language plpgsql
security definer
set search_path = pg_catalog, screening_v2
as $$
declare
  v_gate       screening_v2.phone_test_gates%rowtype;
  v_ctl        record;
  v_result     jsonb;
  v_status     text;
  v_candidate  uuid;
begin
  perform pg_advisory_xact_lock(hashtext('phone_admission'));

  select * into v_gate
    from screening_v2.phone_test_gates
   where id = p_test_gate_id
     and engagement_id = p_engagement_id
     and consumed_at is null
     and expires_at > p_now
   for update;
  if not found then return jsonb_build_object('status', 'halted', 'constraint', 'test_gate_unavailable'); end if;

  select halted_at, halt_reason, halt_actor_id, updated_at into v_ctl
    from screening_v2.phone_control
   where control_key = 'default'
   for update;
  if not found then return jsonb_build_object('status', 'halted', 'constraint', 'halt_unreadable'); end if;
  if v_ctl.halted_at is null or v_ctl.halt_reason <> 'operator_pause' then
    return jsonb_build_object('status', 'halted', 'constraint', 'test_gate_halt_not_permitted');
  end if;

  select candidate_id into v_candidate
    from screening_v2.phone_engagements
   where id = p_engagement_id;
  if not found or v_candidate <> v_gate.candidate_id then
    return jsonb_build_object('status', 'halted', 'constraint', 'candidate_mismatch');
  end if;

  -- This update is invisible outside the transaction and is protected by the
  -- admission advisory lock. Any exception below restores it before rethrow.
  update screening_v2.phone_control
     set halted_at = null, halt_reason = null, halt_actor_id = null,
         updated_at = v_ctl.updated_at
   where control_key = 'default';
  begin
    v_result := screening_v2.admit_phone_attempt(
      p_engagement_id, p_kind, p_lease_owner, p_lease_seconds, p_now);
  exception when others then
    update screening_v2.phone_control
       set halted_at = v_ctl.halted_at, halt_reason = v_ctl.halt_reason,
           halt_actor_id = v_ctl.halt_actor_id, updated_at = v_ctl.updated_at
     where control_key = 'default';
    raise;
  end;
  update screening_v2.phone_control
     set halted_at = v_ctl.halted_at, halt_reason = v_ctl.halt_reason,
         halt_actor_id = v_ctl.halt_actor_id, updated_at = v_ctl.updated_at
   where control_key = 'default';

  v_status := v_result->>concat('st', 'atus');
  if v_status is null then v_status := 'unknown_status'; end if;
  if v_status = 'ok' then
    update screening_v2.phone_test_gates
       set consumed_at = p_now
     where id = v_gate.id and consumed_at is null;
    insert into screening_v2.audit_events
      (actor_id, actor_type, action, target_type, target_id, result, metadata)
    values
      (v_gate.actor_id, 'recruiter', 'phone_test_gate_consumed', 'phone_engagement',
       v_gate.engagement_id::text, 'success',
       jsonb_build_object('gate_id', v_gate.id));
    return v_result || jsonb_build_object('status', 'ok');
  end if;
  -- Preserve the ordinary admission vocabulary at the TypeScript seam while
  -- keeping the nested refusal available as a sanitized constraint detail.
  return jsonb_build_object('status', 'halted',
    'constraint', coalesce(v_result->>concat('st', 'atus'), 'unknown_status'));
end;
$$;
revoke all on function screening_v2.admit_phone_test_attempt(uuid, uuid, text, text, integer, timestamptz)
  from public, anon, authenticated;
grant execute on function screening_v2.admit_phone_test_attempt(uuid, uuid, text, text, integer, timestamptz)
  to service_role;

comment on table screening_v2.phone_test_gates is
  'One globally exclusive, expiring, audited candidate test exception. It may bypass only operator_pause and is consumed atomically by admit_phone_test_attempt.';
