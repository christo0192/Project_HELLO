-- =====================================================================
-- 0125 assertions, part 3 — after the SECOND apply of 0125.
--
-- Proves by execution, against the real functions and triggers:
--   * idempotency: the second apply re-ran both backfills and changed no row;
--   * §1: the columns exist with their types, and each CHECK refuses the
--     garbage it exists for (0 ms, a seconds-for-ms slip, an end long before
--     admission, a negative count);
--   * §2: phone_call_attempts carries EXACTLY two triggers (0055 + 0125), the
--     stamp fills room_name on INSERT and on UPDATE OF session_id, never
--     overwrites an explicit room_name, and leaves it when session_id is
--     cleared;
--   * §3: on first completion the new rule gives the 9f60523d shape 75 s / 1
--     unobserved; the same shape with the reconnect leg's observed end gives
--     94 s / 0; a session whose only answered leg is reclaimed gives NULL / 1;
--     a preset duration_sec is still kept; a terminal session accepts a
--     duration-only UPDATE;
--   * posture: the new functions are not browser-executable, the definer one
--     pins search_path.
-- =====================================================================
\set ON_ERROR_STOP on

-- One engagement chain per slug: candidate -> mapping -> link (ingestion
-- `ready`) -> engagement `in_call` -> session `in_progress` named
-- phone-<id>. Returns the engagement and session ids.
create or replace function _p115.chain(p_slug text, out eng uuid, out sess uuid)
language plpgsql as $$
declare
  v_owner  constant uuid := '00000000-0000-4000-8000-0000000000ad';
  v_states constant text[] := array['queued','fetching','scanning','extracting','structuring','ready'];
  v_role uuid;
  v_cand uuid;
  v_map  uuid;
  v_link uuid;
begin
  select id into v_role from screening_v2.roles where title = 'p115 role';
  insert into screening_v2.candidates (role_id, name, email, phone_e164, phone_valid)
  values (v_role, 'p115 ' || p_slug, 'p115-' || p_slug || '@example.test',
          '+9199900' || lpad((abs(hashtext(p_slug)) % 100000)::text, 5, '0'), true)
  returning id into v_cand;
  insert into screening_v2.ashby_job_mappings
    (external_job_id, role_id, owner_id, ai_screening_stage_id, ta_screening_stage_id,
     status, delivery_mode)
  values ('p115-' || p_slug || '-job', v_role, v_owner,
          'p115-' || p_slug || '-ai', 'p115-' || p_slug || '-ta', 'enabled', 'manual')
  returning id into v_map;
  insert into screening_v2.ashby_application_links
    (external_application_id, external_job_id, job_mapping_id,
     external_resume_file_handle, candidate_id)
  values ('p115-' || p_slug || '-app', 'p115-' || p_slug || '-job', v_map, repeat('h', 64), v_cand)
  returning id into v_link;
  perform screening_v2.advance_ashby_ingestion(v_link, unnest, null, null, null, null)
    from unnest(v_states);
  insert into screening_v2.phone_engagements (application_link_id, candidate_id, role_id, state)
  values (v_link, v_cand, v_role, 'in_call')
  returning id into eng;
  insert into screening_v2.call_sessions
    (candidate_id, role_id, mode, provider, external_call_id, status, current_question_index)
  values (v_cand, v_role, 'live', 'livekit', 'p115-placeholder-' || p_slug, 'created', 0)
  returning id into sess;
  update screening_v2.call_sessions
     set external_call_id = 'phone-' || sess::text, status = 'in_progress'
   where id = sess;
  update screening_v2.phone_engagements set session_id = sess where id = eng;
end;
$$;

-- ── Idempotency: the second apply changed no session row ─────────────
do $$
declare
  v_bad text;
begin
  select string_agg(p.slug, ',') into v_bad
    from _p115.snap p join screening_v2.call_sessions s on s.id = p.session_id
   where s.updated_at is distinct from p.updated_at;
  if v_bad is not null then
    raise exception 'p115 idempotency: the second apply of 0125 re-updated: %', v_bad;
  end if;
  if (select duration_sec from screening_v2.call_sessions s join _p115.snap p
        on p.session_id = s.id where p.slug = 'two_legs') <> 75 then
    raise exception 'p115 idempotency: two_legs lost its backfilled duration';
  end if;
end $$;

-- ── §1: columns and CHECKs ────────────────────────────────────────────
do $$
declare
  v_types jsonb;
  v_eng   uuid;
  v_sess  uuid;
  v_att   uuid;
  v_ok    boolean;
  v_col   text;
  v_val   text;
begin
  select jsonb_object_agg(table_name || '.' || column_name, data_type) into v_types
    from information_schema.columns
   where table_schema = 'screening_v2'
     and ((table_name = 'phone_call_attempts'
           and column_name in ('observed_ended_at','recording_started_at_ms',
                               'recording_duration_ms','recording_tail_flushed'))
       or (table_name = 'call_sessions' and column_name = 'duration_unobserved_legs'));
  if v_types <> jsonb_build_object(
       'phone_call_attempts.observed_ended_at',       'timestamp with time zone',
       'phone_call_attempts.recording_started_at_ms', 'bigint',
       'phone_call_attempts.recording_duration_ms',   'integer',
       'phone_call_attempts.recording_tail_flushed',  'boolean',
       'call_sessions.duration_unobserved_legs',      'smallint') then
    raise exception 'p115 §1: unexpected column types: %', v_types;
  end if;

  select eng, sess into v_eng, v_sess from _p115.chain('checks');
  insert into screening_v2.phone_call_attempts
    (engagement_id, attempt_seq, epoch, kind, state, outcome_class, ist_date,
     prior_engagement_state, session_id, admitted_at, answered_at, ended_at)
  values (v_eng, 1, 0, 'initial', 'ended', 'disconnected', '2026-10-06', 'eligible', v_sess,
          '2026-10-06T05:00:00Z', '2026-10-06T05:00:20Z', '2026-10-06T05:01:00Z')
  returning id into v_att;

  -- Values that MUST be accepted (the worker's real shapes).
  update screening_v2.phone_call_attempts
     set observed_ended_at       = '2026-10-06T05:00:58Z',
         recording_started_at_ms = 1791263821000,
         recording_duration_ms   = 37000,
         recording_tail_flushed  = true
   where id = v_att;

  -- Values that MUST be refused, one at a time.
  for v_col, v_val in
    select * from (values
      ('recording_duration_ms',   '0'),
      ('recording_duration_ms',   '-5'),
      ('recording_duration_ms',   '86400001'),
      ('recording_started_at_ms', '1791263821'),        -- seconds, not ms
      ('recording_started_at_ms', '0'),
      ('observed_ended_at',       '''2026-10-06T04:00:00Z''')  -- an hour before admission
    ) t(c, v)
  loop
    v_ok := false;
    begin
      execute format('update screening_v2.phone_call_attempts set %I = %s where id = %L',
                     v_col, v_val, v_att);
    exception when check_violation then
      v_ok := true;
    end;
    if not v_ok then
      raise exception 'p115 §1: % = % was accepted', v_col, v_val;
    end if;
  end loop;

  v_ok := false;
  begin
    update screening_v2.call_sessions set duration_unobserved_legs = -1 where id = v_sess;
  exception when check_violation then
    v_ok := true;
  end;
  if not v_ok then
    raise exception 'p115 §1: duration_unobserved_legs = -1 was accepted';
  end if;
end $$;

-- ── §2: exactly two attempt triggers, and the room_name stamp ─────────
do $$
declare
  v_trg  text[];
  v_eng  uuid;
  v_sess uuid;
  v_att  uuid;
  v_room text;
begin
  select array_agg(t.tgname::text order by t.tgname) into v_trg
    from pg_trigger t
   where t.tgrelid = 'screening_v2.phone_call_attempts'::regclass
     and not t.tgisinternal;
  if v_trg <> array['trg_phone_attempt_answered_at', 'trg_phone_attempt_room_name'] then
    raise exception 'p115 §2: phone_call_attempts triggers are %, expected exactly the 0055 and 0125 pair', v_trg;
  end if;

  select eng, sess into v_eng, v_sess from _p115.chain('room');

  -- INSERT with a session and no room name: stamped.
  insert into screening_v2.phone_call_attempts
    (engagement_id, attempt_seq, epoch, kind, state, outcome_class, ist_date,
     prior_engagement_state, session_id, admitted_at, answered_at, ended_at)
  values (v_eng, 1, 0, 'initial', 'ended', 'disconnected', '2026-10-06', 'eligible', v_sess,
          '2026-10-06T06:00:00Z', '2026-10-06T06:00:20Z', '2026-10-06T06:01:00Z')
  returning id, room_name into v_att, v_room;
  if v_room is distinct from 'phone-' || v_sess::text then
    raise exception 'p115 §2: insert with session_id stamped room_name %', v_room;
  end if;

  -- INSERT unbound (the reconnect leg as admitted), then bound by an UPDATE
  -- OF session_id (the 0114 C1-d write): stamped at bind time.
  insert into screening_v2.phone_call_attempts
    (engagement_id, attempt_seq, epoch, kind, state, ist_date, prior_engagement_state,
     admitted_at)
  values (v_eng, 2, 1, 'reconnect', 'ringing', '2026-10-06', 'reconnecting',
          '2026-10-06T06:03:00Z')
  returning id, room_name into v_att, v_room;
  if v_room is not null then
    raise exception 'p115 §2: an unbound leg got room_name %', v_room;
  end if;
  update screening_v2.phone_call_attempts
     set session_id = coalesce(session_id, v_sess)
   where id = v_att
  returning room_name into v_room;
  if v_room is distinct from 'phone-' || v_sess::text then
    raise exception 'p115 §2: binding a reconnect leg stamped room_name %', v_room;
  end if;

  -- Clearing session_id keeps the room name (history).
  update screening_v2.phone_call_attempts set session_id = null where id = v_att
  returning room_name into v_room;
  if v_room is distinct from 'phone-' || v_sess::text then
    raise exception 'p115 §2: clearing session_id changed room_name to %', v_room;
  end if;
  update screening_v2.phone_call_attempts
     set state = 'ended', outcome_class = 'no_answer', ended_at = '2026-10-06T06:04:00Z'
   where id = v_att;

  -- An explicit room name is never overwritten.
  insert into screening_v2.phone_call_attempts
    (engagement_id, attempt_seq, epoch, kind, state, ist_date, prior_engagement_state,
     session_id, room_name, admitted_at)
  values (v_eng, 3, 2, 'reconnect', 'ringing', '2026-10-06', 'reconnecting',
          v_sess, 'explicit-room', '2026-10-06T06:05:00Z')
  returning id, room_name into v_att, v_room;
  if v_room <> 'explicit-room' then
    raise exception 'p115 §2: an explicit room_name was overwritten with %', v_room;
  end if;
  update screening_v2.phone_call_attempts set session_id = v_sess where id = v_att
  returning room_name into v_room;
  if v_room <> 'explicit-room' then
    raise exception 'p115 §2: re-binding overwrote an explicit room_name with %', v_room;
  end if;
end $$;

-- ── §3: the duration rule on first completion ─────────────────────────
do $$
declare
  v_eng  uuid;
  v_sess uuid;
  v_got  jsonb;
  v_slug text;
begin
  -- The 9f60523d shape (unobserved) and the same shape with leg B's observed
  -- end stamped by /recording/complete before the session completed.
  foreach v_slug in array array['new_unobserved', 'new_observed'] loop
    select eng, sess into v_eng, v_sess from _p115.chain(v_slug);
    insert into screening_v2.phone_call_attempts
      (engagement_id, attempt_seq, epoch, kind, state, outcome_class, ist_date,
       prior_engagement_state, session_id, admitted_at, answered_at, ended_at)
    values (v_eng, 1, 0, 'initial', 'ended', 'disconnected', '2026-10-05', 'eligible', v_sess,
            '2026-10-05T03:30:20.000Z', '2026-10-05T03:30:46.800Z', '2026-10-05T03:32:02.400Z');
    insert into screening_v2.phone_call_attempts
      (engagement_id, attempt_seq, epoch, kind, state, outcome_class, ist_date,
       prior_engagement_state, session_id, admitted_at, answered_at, ended_at,
       observed_ended_at)
    values (v_eng, 2, 1, 'reconnect', 'abandoned', null, '2026-10-05', 'reconnecting', v_sess,
            '2026-10-05T03:34:30.000Z', '2026-10-05T03:34:49.600Z', '2026-10-05T03:40:57.456Z',
            case when v_slug = 'new_observed' then '2026-10-05T03:35:08.300Z'::timestamptz end);
    update screening_v2.call_sessions
       set status = 'completed', terminal_reason = 'conversation_complete',
           ended_at = '2026-10-05T03:43:59.622Z'
     where id = v_sess;
    insert into _p115.snap (slug, session_id) values (v_slug, v_sess);
  end loop;

  -- The only answered leg was reclaimed and never observed: unknown.
  select eng, sess into v_eng, v_sess from _p115.chain('new_only');
  insert into screening_v2.phone_call_attempts
    (engagement_id, attempt_seq, epoch, kind, state, outcome_class, ist_date,
     prior_engagement_state, session_id, admitted_at, answered_at, ended_at)
  values (v_eng, 1, 0, 'initial', 'abandoned', null, '2026-10-05', 'eligible', v_sess,
          '2026-10-05T10:00:00Z', '2026-10-05T10:00:20Z', '2026-10-05T10:06:20Z');
  update screening_v2.call_sessions
     set status = 'completed', terminal_reason = 'conversation_complete',
         ended_at = '2026-10-05T10:09:20Z'
   where id = v_sess;
  insert into _p115.snap (slug, session_id) values ('new_only', v_sess);

  -- An infra-deferred abandonment (0083 marker) is NOT a reclaim; it never
  -- answered anyway, so it neither counts nor is excluded. Plus one live
  -- leg (no end yet) bounded by the session end, as in 0076: 100 s.
  select eng, sess into v_eng, v_sess from _p115.chain('new_live');
  insert into screening_v2.phone_call_attempts
    (engagement_id, attempt_seq, epoch, kind, state, outcome_class, ist_date,
     prior_engagement_state, session_id, admitted_at, ended_at, abandon_reason)
  values (v_eng, 1, 0, 'initial', 'abandoned', null, '2026-10-05', 'eligible', v_sess,
          '2026-10-05T13:00:00Z', '2026-10-05T13:00:05Z', 'infra_deferred');
  insert into screening_v2.phone_call_attempts
    (engagement_id, attempt_seq, epoch, kind, state, outcome_class, ist_date,
     prior_engagement_state, session_id, admitted_at, answered_at, lease_expires_at)
  values (v_eng, 2, 0, 'initial', 'human', null, '2026-10-05', 'eligible', v_sess,
          '2026-10-05T13:01:00Z', '2026-10-05T13:01:20Z', '2026-10-05T13:05:00Z');
  update screening_v2.call_sessions
     set status = 'completed', terminal_reason = 'conversation_complete',
         ended_at = '2026-10-05T13:03:00Z'
   where id = v_sess;
  insert into _p115.snap (slug, session_id) values ('new_live', v_sess);

  -- A duration_sec already present at completion is kept (0076 rule).
  select eng, sess into v_eng, v_sess from _p115.chain('new_preset');
  insert into screening_v2.phone_call_attempts
    (engagement_id, attempt_seq, epoch, kind, state, outcome_class, ist_date,
     prior_engagement_state, session_id, admitted_at, answered_at, ended_at)
  values (v_eng, 1, 0, 'initial', 'abandoned', null, '2026-10-05', 'eligible', v_sess,
          '2026-10-05T14:00:00Z', '2026-10-05T14:00:20Z', '2026-10-05T14:06:20Z');
  update screening_v2.call_sessions set duration_sec = 42 where id = v_sess;
  update screening_v2.call_sessions
     set status = 'completed', terminal_reason = 'conversation_complete',
         ended_at = '2026-10-05T14:09:20Z'
   where id = v_sess;
  insert into _p115.snap (slug, session_id) values ('new_preset', v_sess);

  select jsonb_object_agg(p.slug, jsonb_build_array(s.duration_sec, s.duration_unobserved_legs))
    into v_got
    from _p115.snap p join screening_v2.call_sessions s on s.id = p.session_id
   where p.slug like 'new\_%';
  if v_got <> jsonb_build_object(
       'new_unobserved', jsonb_build_array(75, 1),
       'new_observed',   jsonb_build_array(94, 0),
       'new_only',       jsonb_build_array(null, 1),
       'new_live',       jsonb_build_array(100, 0),
       'new_preset',     jsonb_build_array(42, null)) then
    raise exception 'p115 §3: unexpected (duration_sec, unobserved) on first completion: %', v_got;
  end if;

  -- A terminal session accepts a duration-only UPDATE (what the §3c
  -- backfill relies on), and status/terminal_reason stay immutable.
  select session_id into v_sess from _p115.snap where slug = 'new_only';
  update screening_v2.call_sessions
     set duration_sec = 19, duration_unobserved_legs = 0
   where id = v_sess;
  if (select duration_sec from screening_v2.call_sessions where id = v_sess) <> 19 then
    raise exception 'p115 §3: a terminal session refused a duration-only update';
  end if;
  begin
    update screening_v2.call_sessions set status = 'failed' where id = v_sess;
    raise exception 'p115 §3: a terminal session accepted a status change';
  exception when sqlstate 'P0001' then
    if sqlerrm like 'p115 %' then raise; end if;
  end;
end $$;

-- ── Posture of the new functions ──────────────────────────────────────
do $$
declare
  v_bad text := '';
  v_fn  record;
begin
  for v_fn in
    select p.oid, p.proname, p.prosecdef, p.proconfig
      from pg_proc p join pg_namespace n on n.oid = p.pronamespace
     where n.nspname = 'screening_v2'
       and p.proname in ('phone_session_leg_duration', 'set_phone_session_duration',
                         'stamp_phone_attempt_room_name')
  loop
    if has_function_privilege('anon', v_fn.oid, 'EXECUTE')
       or has_function_privilege('authenticated', v_fn.oid, 'EXECUTE') then
      v_bad := v_bad || v_fn.proname || ':browser_executable ';
    end if;
    if not exists (select 1 from unnest(coalesce(v_fn.proconfig, '{}')) c where c like 'search_path=%') then
      v_bad := v_bad || v_fn.proname || ':no_search_path ';
    end if;
    if v_fn.proname <> 'stamp_phone_attempt_room_name' and not v_fn.prosecdef then
      v_bad := v_bad || v_fn.proname || ':not_definer ';
    end if;
  end loop;
  if v_bad <> '' then
    raise exception 'p115 posture: %', v_bad;
  end if;
  if (select count(*) from pg_proc p join pg_namespace n on n.oid = p.pronamespace
       where n.nspname = 'screening_v2'
         and p.proname in ('phone_session_leg_duration', 'set_phone_session_duration',
                           'stamp_phone_attempt_room_name')) <> 3 then
    raise exception 'p115 posture: expected exactly one overload of each new/replaced function';
  end if;
end $$;

select 'p115 PASS' as result;
