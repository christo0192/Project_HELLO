-- Recover false worker_crash terminal states caused by an SDK close-reason
-- compatibility mismatch. Recovery is deliberately narrow, service-role-only,
-- recording-backed, transcript-backed, and audited. Normal terminal-state
-- immutability remains unchanged outside this RPC's transaction-local guard.

create or replace function screening_v2.enforce_session_transition()
returns trigger
language plpgsql
set search_path = pg_catalog
as $$
declare
  allowed_next text[];
  recovery_enabled boolean :=
    current_setting('screening_v2.false_worker_crash_recovery', true) = 'on';
begin
  if old.status = new.status then
    return new;
  end if;

  if recovery_enabled
     and old.status = 'failed'
     and old.terminal_reason = 'worker_crash'
     and new.status = 'completed'
     and new.terminal_reason = 'conversation_complete'
     and new.recording_object_key is not null then
    return new;
  end if;

  if old.status in ('completed', 'failed', 'cancelled', 'expired') then
    raise exception
      'session is in terminal state % — no further transitions are permitted',
      old.status
      using errcode = 'P0001';
  end if;

  case old.status
    when 'created'     then allowed_next := array['waiting', 'in_progress', 'cancelled', 'failed'];
    when 'waiting'     then allowed_next := array['in_progress', 'cancelled', 'failed', 'expired'];
    when 'in_progress' then allowed_next := array['completed', 'failed', 'cancelled', 'expired'];
    else allowed_next := '{}'::text[];
  end case;

  if not (new.status = any(allowed_next)) then
    raise exception
      'invalid session transition % → %',
      old.status, new.status
      using errcode = 'P0001';
  end if;

  return new;
end;
$$;

create or replace function screening_v2.enforce_terminal_reason_immutable()
returns trigger
language plpgsql
set search_path = pg_catalog
as $$
declare
  recovery_enabled boolean :=
    current_setting('screening_v2.false_worker_crash_recovery', true) = 'on';
begin
  if recovery_enabled
     and old.status = 'failed'
     and old.terminal_reason = 'worker_crash'
     and new.status = 'completed'
     and new.terminal_reason = 'conversation_complete'
     and new.recording_object_key is not null then
    return new;
  end if;

  if old.terminal_reason is not null
     and new.terminal_reason is distinct from old.terminal_reason then
    raise exception
      'terminal_reason is immutable once set'
      using errcode = 'P0001';
  end if;
  return new;
end;
$$;

create or replace function screening_v2.recover_false_worker_crash(
  p_session_id uuid,
  p_reason text
)
returns jsonb
language plpgsql
security definer
set search_path = pg_catalog, screening_v2
as $$
declare
  v_session screening_v2.call_sessions%rowtype;
  v_turn_count integer;
  v_assessment_count integer;
begin
  if p_reason is null or length(p_reason) < 1 or length(p_reason) > 200 then
    return jsonb_build_object('status', 'invalid_reason');
  end if;

  select * into v_session
    from screening_v2.call_sessions
   where id = p_session_id
   for update;

  if not found then
    return jsonb_build_object('status', 'session_not_found');
  end if;
  if v_session.status = 'completed' then
    return jsonb_build_object('status', 'already_completed');
  end if;
  if v_session.status <> 'failed' or v_session.terminal_reason <> 'worker_crash' then
    return jsonb_build_object('status', 'ineligible_terminal_state');
  end if;
  if v_session.recording_object_key is null or v_session.recording_size_bytes is null
     or v_session.recording_size_bytes <= 0 then
    return jsonb_build_object('status', 'recording_required');
  end if;

  select count(*) into v_turn_count
    from screening_v2.transcript_turns
   where session_id = p_session_id;
  if v_turn_count < 2 then
    return jsonb_build_object('status', 'transcript_required');
  end if;

  select count(*) into v_assessment_count
    from screening_v2.assessments
   where session_id = p_session_id;
  if v_assessment_count > 0 then
    return jsonb_build_object('status', 'assessment_already_exists');
  end if;

  perform set_config('screening_v2.false_worker_crash_recovery', 'on', true);

  update screening_v2.call_sessions
     set status = 'completed',
         terminal_reason = 'conversation_complete',
         duration_sec = coalesce(
           duration_sec,
           greatest(0, floor(extract(epoch from (ended_at - started_at)))::integer)
         )
   where id = p_session_id;

  insert into screening_v2.audit_events
    (actor_id, actor_type, action, target_type, target_id, result, correlation_id, metadata)
  values
    (null, 'system', 'admin_session_override', 'session', p_session_id::text,
     'success', null,
     jsonb_build_object(
       'prior_status', 'failed',
       'new_status', 'completed',
       'reason', p_reason,
       'recovery_kind', 'false_worker_crash'
     ));

  return jsonb_build_object(
    'status', 'ok',
    'turn_count', v_turn_count,
    'recording_size_bytes', v_session.recording_size_bytes
  );
end;
$$;

revoke all on function screening_v2.recover_false_worker_crash(uuid, text)
  from public, anon, authenticated;
grant execute on function screening_v2.recover_false_worker_crash(uuid, text)
  to service_role;

comment on function screening_v2.recover_false_worker_crash(uuid, text) is
  'Narrow audited recovery for recording-backed, transcript-backed sessions '
  'misclassified as failed/worker_crash by an SDK close-reason mismatch. '
  'Service-role-only; does not weaken ordinary terminal immutability.';
