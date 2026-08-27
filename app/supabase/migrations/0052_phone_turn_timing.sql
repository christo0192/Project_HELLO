-- 0052 — carry validated speech-start anchors through phone boundaries.
--
-- The phone assessment path commits complete boundaries through one RPC. Before
-- this migration the worker could observe ChatMessage.metrics, but the store
-- deliberately reduced each turn to speaker/text before the RPC, so every
-- phone turn lost its timing anchor. This replacement keeps the atomic
-- boundary while persisting the optional anchor on each transcript row.

create or replace function screening_v2.commit_phone_question_boundary(
  p_session_id      uuid,
  p_question_key    text,
  p_expected_index  integer,
  p_source_event_id text,
  p_turns           jsonb,
  p_now             timestamptz default now()
)
returns jsonb
language plpgsql
security definer
set search_path = pg_catalog, screening_v2
as $$
declare
  v_sess     screening_v2.call_sessions%rowtype;
  v_plan     screening_v2.phone_session_plans%rowtype;
  v_prog     screening_v2.phone_session_progress%rowtype;
  v_item     jsonb;
  v_speaker  text;
  v_text     text;
  v_count    integer;
  v_cursor   integer;
  v_expected text;
  v_base     integer;
  v_updated  integer;
begin
  if p_session_id is null then
    return jsonb_build_object('status', 'unknown_session');
  end if;

  select * into v_sess from screening_v2.call_sessions
   where id = p_session_id for update;
  if not found then
    return jsonb_build_object('status', 'unknown_session');
  end if;

  select * into v_plan from screening_v2.phone_session_plans
   where session_id = p_session_id;
  if not found then
    return jsonb_build_object('status', 'plan_missing');
  end if;

  if p_source_event_id is null
     or p_source_event_id !~ '^[A-Za-z0-9_.:-]{1,200}$'
     or p_question_key is null
     or p_turns is null
     or jsonb_typeof(p_turns) <> 'array' then
    return jsonb_build_object('status', 'invalid_turns');
  end if;
  v_count := jsonb_array_length(p_turns);
  if v_count < 2 or v_count > 12 then
    return jsonb_build_object('status', 'invalid_turns');
  end if;

  for v_item in select value from jsonb_array_elements(p_turns) loop
    if jsonb_typeof(v_item) <> 'object' then
      return jsonb_build_object('status', 'invalid_turns');
    end if;
    v_speaker := v_item ->> 'speaker';
    v_text    := btrim(coalesce(v_item ->> 'text', ''));
    if v_speaker is null
       or v_speaker not in ('bot','candidate')
       or v_text = ''
       or length(v_text) > 8000 then
      return jsonb_build_object('status', 'invalid_turns');
    end if;
    -- NULL/omitted is the compatibility path for legacy workers and SDK
    -- items that carry no speech-start metadata. Accept only an integer
    -- epoch-ms value in the same window as migration 0026.
    if v_item ? 'turn_started_at_ms'
       and v_item ->> 'turn_started_at_ms' is not null
       and (jsonb_typeof(v_item -> 'turn_started_at_ms') <> 'number'
            or v_item ->> 'turn_started_at_ms' !~ '^[1-9][0-9]{0,15}$'
            or (v_item ->> 'turn_started_at_ms')::numeric >= 4102444800000) then
      return jsonb_build_object('status', 'invalid_turns');
    end if;
  end loop;

  if (p_turns -> 0 ->> 'speaker') <> 'bot'
     or (p_turns -> (v_count - 1) ->> 'speaker') <> 'candidate' then
    return jsonb_build_object('status', 'invalid_turns');
  end if;

  select * into v_prog from screening_v2.phone_session_progress
   where session_id = p_session_id and source_event_id = p_source_event_id;
  if found then
    return jsonb_build_object(
      'status', 'applied',
      'applied', true,
      'duplicate', true,
      'question_key', v_prog.question_key,
      'question_index', v_prog.question_index,
      'first_turn_index', v_prog.first_turn_index,
      'last_turn_index', v_prog.last_turn_index,
      'cursor', greatest(coalesce(v_sess.current_question_index, 0), 0),
      'question_count', v_plan.question_count,
      'plan_complete',
        greatest(coalesce(v_sess.current_question_index, 0), 0) >= v_plan.question_count);
  end if;

  if v_sess.status <> 'in_progress' then
    return jsonb_build_object('status', 'session_not_active',
                              'session_status', v_sess.status);
  end if;

  v_cursor := greatest(coalesce(v_sess.current_question_index, 0), 0);
  if p_expected_index is null or p_expected_index <> v_cursor then
    return jsonb_build_object('status', 'stale_cursor',
                              'cursor', v_cursor,
                              'question_count', v_plan.question_count);
  end if;
  if v_cursor >= v_plan.question_count then
    return jsonb_build_object('status', 'plan_complete',
                              'cursor', v_cursor,
                              'question_count', v_plan.question_count);
  end if;
  v_expected := v_plan.questions -> v_cursor ->> 'key';
  if p_question_key <> v_expected then
    return jsonb_build_object('status', 'key_not_current',
                              'cursor', v_cursor,
                              'expected_key', v_expected,
                              'question_count', v_plan.question_count);
  end if;

  select coalesce(max(turn_index), -1) + 1 into v_base
    from screening_v2.transcript_turns where session_id = p_session_id;

  insert into screening_v2.transcript_turns
    (session_id, turn_index, speaker, text, created_at, turn_started_at_ms)
  select p_session_id,
         v_base + (t.ord - 1)::integer,
         t.value ->> 'speaker',
         btrim(t.value ->> 'text'),
         p_now,
         case when t.value ->> 'turn_started_at_ms' is null then null
              else (t.value ->> 'turn_started_at_ms')::bigint end
    from jsonb_array_elements(p_turns) with ordinality as t(value, ord);

  insert into screening_v2.phone_session_progress
    (session_id, question_key, question_index, source_event_id,
     first_turn_index, last_turn_index, turn_count, committed_at)
  values
    (p_session_id, p_question_key, v_cursor, p_source_event_id,
     v_base, v_base + v_count - 1, v_count, p_now);

  update screening_v2.call_sessions
     set current_question_index = v_cursor + 1
   where id = p_session_id
     and coalesce(current_question_index, 0) = v_cursor;
  get diagnostics v_updated = row_count;
  if v_updated <> 1 then
    raise exception 'phone question cursor CAS lost under row lock'
      using errcode = 'P0001';
  end if;

  return jsonb_build_object(
    'status', 'applied',
    'applied', true,
    'duplicate', false,
    'question_key', p_question_key,
    'question_index', v_cursor,
    'first_turn_index', v_base,
    'last_turn_index', v_base + v_count - 1,
    'cursor', v_cursor + 1,
    'question_count', v_plan.question_count,
    'plan_complete', (v_cursor + 1) >= v_plan.question_count);
end;
$$;

revoke all on function screening_v2.commit_phone_question_boundary(uuid, text, integer, text, jsonb, timestamptz)
  from public, anon, authenticated;
grant execute on function screening_v2.commit_phone_question_boundary(uuid, text, integer, text, jsonb, timestamptz)
  to service_role;

-- The old four-argument stamp used p_now only as an audit timestamp and left
-- the egress origin unset. Replace it with an optional provider anchor; p_now
-- remains final for the repository RPC contract.
drop function if exists screening_v2.stamp_phone_session_egress(uuid, uuid, text, timestamptz);

create or replace function screening_v2.stamp_phone_session_egress(
  p_session_id           uuid,
  p_attempt_id           uuid,
  p_egress_id            text,
  p_egress_started_at_ms bigint default null,
  p_now                  timestamptz default now()
)
returns jsonb
language plpgsql
security definer
set search_path = pg_catalog, screening_v2
as $$
declare
  v_att screening_v2.phone_call_attempts%rowtype;
  v_eng screening_v2.phone_engagements%rowtype;
  v_ses screening_v2.call_sessions%rowtype;
begin
  if p_session_id is null or p_attempt_id is null then
    return jsonb_build_object('status', 'not_found');
  end if;
  if p_egress_id is null or p_egress_id !~ '^EG_[A-Za-z0-9_-]{4,200}$' then
    return jsonb_build_object('status', 'invalid_egress_id');
  end if;
  if p_egress_started_at_ms is not null
     and (p_egress_started_at_ms <= 0 or p_egress_started_at_ms >= 4102444800000) then
    return jsonb_build_object('status', 'invalid_egress_started_at');
  end if;

  select a.* into v_att from screening_v2.phone_call_attempts a
   where a.id = p_attempt_id for update;
  if not found then
    return jsonb_build_object('status', 'not_found');
  end if;
  select e.* into v_eng from screening_v2.phone_engagements e
   where e.id = v_att.engagement_id;
  if not found then
    return jsonb_build_object('status', 'not_found');
  end if;
  select s.* into v_ses from screening_v2.call_sessions s
   where s.id = p_session_id for update;
  if not found then
    return jsonb_build_object('status', 'session_not_found');
  end if;
  if v_ses.candidate_id is distinct from v_eng.candidate_id then
    return jsonb_build_object('status', 'session_candidate_mismatch');
  end if;
  if v_ses.mode is distinct from 'live'
     or v_ses.external_call_id is distinct from ('phone-' || p_session_id::text) then
    return jsonb_build_object('status', 'session_binding_mismatch');
  end if;
  if v_ses.status not in ('waiting', 'in_progress') then
    return jsonb_build_object('status', 'session_not_active');
  end if;
  if v_att.session_id is not null and v_att.session_id <> p_session_id then
    return jsonb_build_object('status', 'session_already_bound');
  end if;
  if v_ses.recording_deleted_at is not null
     or v_ses.recording_revoked_at is not null
     or coalesce(v_ses.recording_quarantined, false) then
    return jsonb_build_object('status', 'recording_terminal');
  end if;
  if v_ses.recording_egress_id is not null then
    if v_ses.recording_egress_id = p_egress_id then
      return jsonb_build_object('status', 'ok', 'duplicate', true);
    end if;
    return jsonb_build_object('status', 'egress_already_bound');
  end if;

  update screening_v2.call_sessions
     set recording_egress_id = p_egress_id,
         recording_egress_status = 'active',
         recording_egress_started_at_ms = coalesce(
           recording_egress_started_at_ms, p_egress_started_at_ms)
   where id = p_session_id;
  return jsonb_build_object('status', 'ok', 'duplicate', false);
end;
$$;

revoke all on function screening_v2.stamp_phone_session_egress(uuid, uuid, text, bigint, timestamptz)
  from public, anon, authenticated;
grant execute on function screening_v2.stamp_phone_session_egress(uuid, uuid, text, bigint, timestamptz)
  to service_role;
