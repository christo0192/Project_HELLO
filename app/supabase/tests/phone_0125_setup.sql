-- =====================================================================
-- 0125 fixture, part 1 — HISTORY seeded BEFORE 0125 is applied.
--
-- scripts/test-phone-0125.sh applies every migration up to 0114, runs THIS
-- file, then applies 0125 (twice), then runs phone_0125_assert.sql. So the
-- sessions below complete under the OLD 0076 duration rule, exactly as the
-- production rows did, and the assert proves what 0125's §2/§3 backfills do
-- to them.
--
-- Four completed phone sessions, each with its own engagement chain
-- (candidate -> job mapping -> application link -> ingestion `ready` ->
-- engagement -> attempts -> session), all under the synthetic p115 namespace:
--
--   two_legs  The 9f60523d SHAPE (timings only, all identifiers synthetic):
--             leg A answered 03:30:46.8, ended 03:32:02.4 by the reconciler
--             (`ended`/`disconnected`); leg B, the reconnect, answered
--             03:34:49.6 and was ended only by the LEASE RECLAIM at
--             03:40:57.5 (`abandoned`, outcome NULL, abandon_reason NULL),
--             bound to the session by 0114 C1-d with room_name NULL. The
--             session completed at 03:43:59.6. 0076 sums 75.6 + 367.856 =
--             443 s; the truthful answer is 75 s plus one unobserved leg.
--   only      A single answered leg, reclaimed 6 min later; the session
--             completed after the reclaim. 0076: 360 s. 0125: NULL (unknown)
--             with 1 unobserved leg.
--   clean     One leg ended by the reconciler. 0076: 90 s. 0125 must leave
--             it untouched (nothing unobserved).
--   late      One leg still live when the session completed (0076 bounds it
--             by the session end: 120 s), reclaimed AFTERWARDS. Its end was
--             never observed either (the session end is no observation of
--             the leg), so 0125 makes it NULL (unknown) with 1 unobserved
--             leg, the same rule as the API's per-leg read.
--
-- Synthetic identifiers only; no real candidate, email, number or document.
-- =====================================================================
\set ON_ERROR_STOP on

create schema if not exists _p115;
create table if not exists _p115.snap (
  slug       text primary key,
  session_id uuid not null,
  updated_at timestamptz
);

do $$
declare
  v_owner  constant uuid := '00000000-0000-4000-8000-0000000000ad';
  v_states constant text[] := array['queued','fetching','scanning','extracting','structuring','ready'];
  v_role uuid;
  v_cand uuid;
  v_map  uuid;
  v_link uuid;
  v_eng  uuid;
  v_sess uuid;
  v_s    text;
  v_n    integer := 0;
begin
  insert into screening_v2.roles (title, jd, required_skills, screening_template, owner_id)
  values ('p115 role', 'Synthetic role for the 0125 harness.', '[]'::jsonb,
          jsonb_build_array(jsonb_build_object('id','q1','question','Tell me about yourself?','weight',1)),
          v_owner)
  returning id into v_role;

  for v_s in select unnest(array['two_legs','only','clean','late']) loop
    v_n := v_n + 1;
    insert into screening_v2.candidates (role_id, name, email, phone_e164, phone_valid)
    values (v_role, 'p115 ' || v_s, 'p115-' || v_s || '@example.test',
            '+91999001150' || v_n::text, true)
    returning id into v_cand;

    insert into screening_v2.ashby_job_mappings
      (external_job_id, role_id, owner_id, ai_screening_stage_id, ta_screening_stage_id,
       status, delivery_mode)
    values ('p115-' || v_s || '-job', v_role, v_owner,
            'p115-' || v_s || '-ai', 'p115-' || v_s || '-ta', 'enabled', 'manual')
    returning id into v_map;

    insert into screening_v2.ashby_application_links
      (external_application_id, external_job_id, job_mapping_id,
       external_resume_file_handle, candidate_id)
    values ('p115-' || v_s || '-app', 'p115-' || v_s || '-job', v_map, repeat('h', 64), v_cand)
    returning id into v_link;

    perform screening_v2.advance_ashby_ingestion(v_link, unnest, null, null, null, null)
      from unnest(v_states);

    insert into screening_v2.phone_engagements (application_link_id, candidate_id, role_id, state)
    values (v_link, v_cand, v_role, 'in_call')
    returning id into v_eng;

    -- Born `created` (the 0006 insert trigger insists), then `in_progress`
    -- carrying the deterministic phone room name 0076 keys on.
    insert into screening_v2.call_sessions
      (candidate_id, role_id, mode, provider, external_call_id, status, current_question_index)
    values (v_cand, v_role, 'live', 'livekit', 'p115-placeholder-' || v_s, 'created', 0)
    returning id into v_sess;
    update screening_v2.call_sessions
       set external_call_id = 'phone-' || v_sess::text,
           status           = 'in_progress'
     where id = v_sess;
    update screening_v2.phone_engagements set session_id = v_sess where id = v_eng;

    if v_s = 'two_legs' then
      -- Leg A: bound by start_phone_assessment, so it HAS a room name.
      insert into screening_v2.phone_call_attempts
        (engagement_id, attempt_seq, epoch, kind, state, outcome_class, ist_date,
         prior_engagement_state, session_id, room_name, admitted_at, answered_at, ended_at)
      values (v_eng, 1, 0, 'initial', 'ended', 'disconnected', '2026-10-05', 'eligible',
              v_sess, 'phone-' || v_sess::text,
              '2026-10-05T03:30:20.000Z', '2026-10-05T03:30:46.800Z', '2026-10-05T03:32:02.400Z');
      -- Leg B: the reconnect, bound by 0114 C1-d, room_name NULL, ended by
      -- the reclaim (the exact 0112 signature).
      insert into screening_v2.phone_call_attempts
        (engagement_id, attempt_seq, epoch, kind, state, outcome_class, ist_date,
         prior_engagement_state, session_id, admitted_at, answered_at, ended_at)
      values (v_eng, 2, 1, 'reconnect', 'abandoned', null, '2026-10-05', 'reconnecting',
              v_sess,
              '2026-10-05T03:34:30.000Z', '2026-10-05T03:34:49.600Z', '2026-10-05T03:40:57.456Z');
      update screening_v2.call_sessions
         set status = 'completed', terminal_reason = 'conversation_complete',
             ended_at = '2026-10-05T03:43:59.622Z'
       where id = v_sess;

    elsif v_s = 'only' then
      insert into screening_v2.phone_call_attempts
        (engagement_id, attempt_seq, epoch, kind, state, outcome_class, ist_date,
         prior_engagement_state, session_id, room_name, admitted_at, answered_at, ended_at)
      values (v_eng, 1, 0, 'initial', 'abandoned', null, '2026-10-05', 'eligible',
              v_sess, 'phone-' || v_sess::text,
              '2026-10-05T10:00:00Z', '2026-10-05T10:00:20Z', '2026-10-05T10:06:20Z');
      update screening_v2.call_sessions
         set status = 'completed', terminal_reason = 'conversation_complete',
             ended_at = '2026-10-05T10:09:20Z'
       where id = v_sess;

    elsif v_s = 'clean' then
      insert into screening_v2.phone_call_attempts
        (engagement_id, attempt_seq, epoch, kind, state, outcome_class, ist_date,
         prior_engagement_state, session_id, room_name, admitted_at, answered_at, ended_at)
      values (v_eng, 1, 0, 'initial', 'ended', 'disconnected', '2026-10-05', 'eligible',
              v_sess, 'phone-' || v_sess::text,
              '2026-10-05T11:00:00Z', '2026-10-05T11:00:30Z', '2026-10-05T11:02:00Z');
      update screening_v2.call_sessions
         set status = 'completed', terminal_reason = 'conversation_complete',
             ended_at = '2026-10-05T11:02:30Z'
       where id = v_sess;

    else -- late
      -- Live (`human`, no end) when the session completes ...
      insert into screening_v2.phone_call_attempts
        (engagement_id, attempt_seq, epoch, kind, state, outcome_class, ist_date,
         prior_engagement_state, session_id, room_name, admitted_at, answered_at,
         lease_expires_at)
      values (v_eng, 1, 0, 'initial', 'human', null, '2026-10-05', 'eligible',
              v_sess, 'phone-' || v_sess::text,
              '2026-10-05T12:00:00Z', '2026-10-05T12:00:30Z', '2026-10-05T12:02:30Z');
      update screening_v2.call_sessions
         set status = 'completed', terminal_reason = 'conversation_complete',
             ended_at = '2026-10-05T12:02:30Z'
       where id = v_sess;
      -- ... and reclaimed four minutes AFTER the session ended.
      update screening_v2.phone_call_attempts
         set state = 'abandoned', outcome_class = null, lease_token = null,
             lease_owner = null, ended_at = '2026-10-05T12:06:30Z'
       where engagement_id = v_eng;
    end if;

    insert into _p115.snap (slug, session_id) values (v_s, v_sess)
    on conflict (slug) do update set session_id = excluded.session_id;
  end loop;
end $$;

-- The 0076 baseline these rows carry into 0125: the numbers the backfill
-- must change (two_legs, only) or must leave alone (clean, late).
do $$
declare
  v_got jsonb;
begin
  select jsonb_object_agg(p.slug, s.duration_sec) into v_got
    from _p115.snap p join screening_v2.call_sessions s on s.id = p.session_id;
  if v_got <> '{"two_legs": 443, "only": 360, "clean": 90, "late": 120}'::jsonb then
    raise exception 'p115 setup: unexpected 0076 baseline durations: %', v_got;
  end if;
end $$;

select 'p115 history seeded' as fixture, count(*) as sessions from _p115.snap;
