-- Use the documented non-null system sentinel for recovery audit events.
-- 0023 correctly rolled back recovery when audit insertion failed; this
-- replacement preserves atomicity while satisfying the append-only contract.

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
    ('00000000-0000-0000-0000-000000000000'::uuid, 'system', 'admin_session_override', 'session', p_session_id::text,
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
