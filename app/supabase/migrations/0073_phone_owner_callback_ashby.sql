-- 0073 — owner-call callback/session identity repairs.
-- Forward-only: restores the server-valid 900 second voice callback and makes
-- every Ashby scorecard operation carry its exact source session before claim.

alter table screening_v2.call_sessions
  drop constraint if exists chk_call_sessions_recording_finalize_defer_reason;
alter table screening_v2.call_sessions
  add constraint chk_call_sessions_recording_finalize_defer_reason check (
    recording_finalize_defer_reason is null
    or recording_finalize_defer_reason in (
      'poll_timeout','object_unreadable','object_absent','manifest_unwritable',
      'provider_error','egress_identity_mismatch','provenance_conflict',
      'terminal_state','rpc_unknown','egress_disabled')) not valid;
alter table screening_v2.call_sessions
  validate constraint chk_call_sessions_recording_finalize_defer_reason;

alter table screening_v2.phone_appointments
  drop constraint if exists chk_phone_appointments_duration;
alter table screening_v2.phone_appointments
  add constraint chk_phone_appointments_duration check (
    extract(epoch from (ends_at - starts_at)) between 900 and 3600);
alter table screening_v2.phone_appointments
  validate constraint chk_phone_appointments_duration;

create or replace function screening_v2.confirm_candidate_voice_callback(
  p_attempt_id uuid,
  p_starts_at timestamptz,
  p_now timestamptz default now()
)
returns jsonb
language plpgsql
security definer
set search_path = pg_catalog, screening_v2
as $$
declare
  v_attempt screening_v2.phone_call_attempts%rowtype;
  v_eng screening_v2.phone_engagements%rowtype;
  v_live screening_v2.phone_appointments%rowtype;
  v_eng_id uuid;
  v_appointment_id uuid;
  v_version integer;
  v_live_count integer;
  v_max constant integer := screening_v2.phone_max_concurrent();
  v_end timestamptz;
  v_day date;
begin
  if p_attempt_id is null or p_starts_at is null or p_now is null then
    return jsonb_build_object('status', 'invalid_input');
  end if;

  -- Serialize booking decisions with one deterministic lock. This is separate
  -- from the engagement row lock and makes overlapping callback reservations
  -- a real capacity decision rather than an advisory UI projection.
  perform pg_advisory_xact_lock(hashtext('phone_callback_booking'));

  select engagement_id into v_eng_id
    from screening_v2.phone_call_attempts
   where id = p_attempt_id;
  if not found then
    return jsonb_build_object('status', 'unknown_attempt');
  end if;

  select * into v_eng
    from screening_v2.phone_engagements
   where id = v_eng_id for update;
  if not found or v_eng.terminal_at is not null then
    return jsonb_build_object('status', 'engagement_terminal');
  end if;

  select * into v_attempt
    from screening_v2.phone_call_attempts
   where id = p_attempt_id for update;
  if not found or v_attempt.engagement_id <> v_eng.id then
    return jsonb_build_object('status', 'unknown_attempt');
  end if;

  -- Only an answered, live leg can prove that the candidate confirmed. A
  -- stale/replayed worker cannot close an unrelated attempt.
  if v_attempt.state not in ('answered_unclassified', 'human')
     or v_eng.state not in ('dialing', 'in_call') then
    if exists (
      select 1 from screening_v2.phone_appointments
       where confirmed_from_attempt_id = p_attempt_id
    ) then
      select id, version into v_appointment_id, v_version
        from screening_v2.phone_appointments
       where confirmed_from_attempt_id = p_attempt_id;
      return jsonb_build_object('status', 'already_confirmed',
                                'appointment_id', v_appointment_id,
                                'version', v_version);
    end if;
    return jsonb_build_object('status', 'attempt_in_flight');
  end if;

  if p_starts_at < p_now + interval '5 minutes' then
    return jsonb_build_object('status', 'lead_time_too_short');
  end if;
  if not screening_v2.phone_ist_window_open(p_starts_at) then
    return jsonb_build_object('status', 'window_closed');
  end if;
  if screening_v2.phone_ist_date(p_starts_at) <> screening_v2.phone_ist_date(
       p_starts_at + interval '15 minutes') then
    return jsonb_build_object('status', 'slot_straddles_ist_midnight');
  end if;

  v_day := screening_v2.phone_ist_date(p_starts_at);
  if v_day = screening_v2.phone_ist_date(p_now) then
    -- Preserve the existing per-IST-day contact ledger. The callback is not a
    -- loophole for a second same-day cold call.
    return jsonb_build_object('status', 'slot_not_yet_eligible', 'ist_date', v_day);
  end if;
  if v_eng.next_eligible_at is not null and p_starts_at < v_eng.next_eligible_at then
    return jsonb_build_object('status', 'slot_not_yet_eligible',
                              'next_eligible_at', v_eng.next_eligible_at);
  end if;
  if exists (
    select 1 from screening_v2.phone_call_attempts a
     where a.engagement_id = v_eng.id
       and a.ist_date = v_day
       and a.kind in ('initial','no_answer_retry','scheduled')
  ) then
    return jsonb_build_object('status', 'daily_attempt_exists', 'ist_date', v_day);
  end if;

  v_end := p_starts_at + interval '15 minutes';
  select count(*) into v_live_count
    from screening_v2.phone_appointments a
   where a.status in ('scheduled','confirmed')
     and a.starts_at < v_end
     and a.ends_at > p_starts_at
     and a.engagement_id <> v_eng.id;
  if v_live_count >= v_max then
    return jsonb_build_object('status', 'slot_full', 'live', v_live_count,
                              'max_concurrent', v_max);
  end if;

  select * into v_live
    from screening_v2.phone_appointments
   where engagement_id = v_eng.id
     and status in ('scheduled','confirmed')
   for update;

  if found then
    update screening_v2.phone_appointments
       set status = 'superseded', version = version + 1,
           cancel_reason = 'superseded', updated_at = p_now
     where id = v_live.id;
  end if;

  insert into screening_v2.phone_appointments
    (engagement_id, starts_at, ends_at, ist_date, status, source,
     confirmed_at, confirmed_from_attempt_id, created_by, created_at, updated_at)
  values
    (v_eng.id, p_starts_at, v_end, v_day, 'confirmed', 'candidate_voice',
     p_now, p_attempt_id,
     '00000000-0000-0000-0000-000000000000'::uuid, p_now, p_now)
  returning id, version into v_appointment_id, v_version;

  -- End the current leg in the same transaction. This is deliberately not an
  -- assessment completion/score claim and does not charge a no-answer budget.
  update screening_v2.phone_call_attempts
     set state = 'ended', outcome_class = 'disconnected', ended_at = p_now
   where id = p_attempt_id;
  update screening_v2.phone_engagements
     set state = 'scheduled', state_reason = 'candidate_callback_confirmed',
         version = version + 1, updated_at = p_now
   where id = v_eng.id;

  insert into screening_v2.audit_events
    (actor_id, actor_type, action, target_type, target_id, result, metadata)
  values
    ('00000000-0000-0000-0000-000000000000'::uuid, 'system',
     'phone_callback_confirmed', 'phone_appointment', v_appointment_id::text,
     'success', jsonb_build_object('engagement_id', v_eng.id,
                                    'source_attempt_id', p_attempt_id,
                                    'duration_seconds', 900,
                                    'ist_date', v_day,
                                    'superseded', v_live.id is not null));

  return jsonb_build_object('status', 'ok', 'appointment_id', v_appointment_id,
                            'version', v_version,
                            'superseded_appointment_id', v_live.id);
exception when unique_violation then
  -- A retry after the first transaction committed is a success, not a second
  -- booking. The unique source-attempt index is the final idempotency fence.
  select id, version into v_appointment_id, v_version
    from screening_v2.phone_appointments
   where confirmed_from_attempt_id = p_attempt_id;
  if v_appointment_id is not null then
    return jsonb_build_object('status', 'already_confirmed',
                              'appointment_id', v_appointment_id,
                              'version', v_version);
  end if;
  raise;
end;
$$;

revoke all on function screening_v2.confirm_candidate_voice_callback(uuid, timestamptz, timestamptz)
  from public, anon, authenticated;
grant execute on function screening_v2.confirm_candidate_voice_callback(uuid, timestamptz, timestamptz)
  to service_role;

comment on function screening_v2.confirm_candidate_voice_callback is
  'Confirms one candidate voice callback after explicit affirmative consent. '
  'Reserves exactly fifteen minutes, requires five minutes lead, enforces IST and '
  'capacity rules, preserves the daily-contact ledger, atomically supersedes '
  'the prior live appointment, and closes the current answered leg. Idempotent '
  'by source attempt. Service-role-only.';

create or replace function screening_v2.enqueue_ashby_cycle_scorecard(
  p_application_link_id uuid,
  p_session_id uuid,
  p_operation_key text,
  p_marker text,
  p_actor_id uuid,
  p_now timestamptz default now()
)
returns jsonb
language plpgsql
security definer
set search_path = pg_catalog, screening_v2
as $$
declare
  v_link screening_v2.ashby_application_links%rowtype;
  v_existing screening_v2.ashby_operations%rowtype;
  v_engagement_id uuid;
  v_result jsonb;
  v_status text;
begin
  if p_application_link_id is null or p_session_id is null or p_operation_key is null then
    return jsonb_build_object('status', 'invalid_request');
  end if;
  select * into v_link from screening_v2.ashby_application_links
   where id = p_application_link_id and provider = 'ashby' for update;
  if not found then return jsonb_build_object('status', 'not_found'); end if;
  if v_link.terminal_state is not null then
    return jsonb_build_object('status', 'blocked_terminal');
  end if;
  select e.id into v_engagement_id
    from screening_v2.phone_engagements e
   where e.application_link_id = p_application_link_id
     and e.session_id = p_session_id
   order by e.cycle_number desc, e.id desc
   limit 1;
  if not found then return jsonb_build_object('status', 'session_mismatch'); end if;

  select * into v_existing from screening_v2.ashby_operations
   where provider = 'ashby'
     and operation_type = 'scorecard_write'
     and (operation_key = p_operation_key or
          (application_link_id = p_application_link_id and source_session_id = p_session_id))
   order by created_at, id limit 1;
  if found then
    -- A legacy initial-cycle operation may have the same immutable key but no
    -- source. Stamp it only after the ownership check above, never over a
    -- different non-null session.
    if v_existing.source_session_id is null then
      update screening_v2.ashby_operations
         set source_session_id = p_session_id, updated_at = p_now
       where id = v_existing.id and source_session_id is null
       returning * into v_existing;
    end if;
    if v_existing.source_session_id is distinct from p_session_id then
      return jsonb_build_object('status', 'session_mismatch');
    end if;
    return jsonb_build_object('status', 'duplicate', 'id', v_existing.id,
      'source_session_id', v_existing.source_session_id);
  end if;

  v_result := screening_v2.enqueue_ashby_operation(
    p_application_link_id, 'scorecard_write', p_operation_key,
    null, p_marker, p_actor_id);
  v_status := coalesce(v_result->>'status', 'unknown_status');
  if v_status = 'inserted' then
    update screening_v2.ashby_operations
       set source_session_id = p_session_id, updated_at = p_now
     where id = (v_result->>'id')::uuid;
  end if;
  return v_result;
end;
$$;

revoke all on function screening_v2.enqueue_ashby_cycle_scorecard(uuid, uuid, text, text, uuid, timestamptz)
  from public, anon, authenticated;
grant execute on function screening_v2.enqueue_ashby_cycle_scorecard(uuid, uuid, text, text, uuid, timestamptz)
  to service_role;
