-- =====================================================================
-- 0072 partial-finalize fixture — a stranded-disconnected phone session
-- past the reconnect grace, plus a control session still WITHIN grace.
--
-- Seeds the full phone chain (candidate -> consent -> job mapping ->
-- application link -> ingestion `ready` -> engagement -> attempt ->
-- session -> plan) for TWO engagements under the synthetic 72-namespace
-- so `phone_partial_finalize_assert.sql` can prove:
--
--   * the selector `finalize_phone_partial_sessions` picks the STRANDED
--     session (attempt terminal `ended`/outcome `disconnected`,
--     ended_at older than the grace) and drives it to
--     completed/conversation_complete — the transition that fires the
--     0038 recording-finalize trigger and makes the session scorable;
--   * it does NOT pick the CONTROL session (attempt ended only moments
--     ago, inside the grace);
--   * the returned coverage (covered=cursor, total=plan question_count)
--     and disconnect_reason ('candidate_hangup') are correct.
--
-- Run (standalone; not yet wired into scripts/supabase-test.sh):
--   psql -v ON_ERROR_STOP=1 -f phone_partial_finalize_setup.sql
--   psql -v ON_ERROR_STOP=1 -f phone_partial_finalize_assert.sql
--
-- Synthetic identifiers only; no real candidate, email or document.
-- =====================================================================
\set ON_ERROR_STOP on

do $$
declare
  v_role  uuid;
  v_now   constant timestamptz := '2026-08-24T06:00:00Z'::timestamptz;
  -- covered=2, total=3: a partial. The cursor and the plan length are the
  -- two numbers the RPC must report.
  v_cand  uuid;
  v_map   uuid;
  v_link  uuid;
  v_eng   uuid;
  v_sess  uuid;
  v_att   uuid;
  v_s     text;
  v_states constant text[] := array['queued','fetching','scanning','extracting','structuring','ready'];
begin
  select id into v_role from screening_v2.roles order by id limit 1;
  if v_role is null then
    raise exception 'pf72: no seed role available';
  end if;

  -- Idempotent teardown first, so a re-run starts clean.
  delete from screening_v2.phone_call_attempts
   where engagement_id in (
     select id from screening_v2.phone_engagements
      where application_link_id in (
        select id from screening_v2.ashby_application_links
         where external_application_id like 'pf72-%'));
  delete from screening_v2.phone_session_plans
   where session_id in (
     select id from screening_v2.call_sessions where external_call_id like 'phone-pf72-%');
  delete from screening_v2.assessments
   where session_id in (
     select id from screening_v2.call_sessions where external_call_id like 'phone-pf72-%');
  delete from screening_v2.phone_engagements
   where application_link_id in (
     select id from screening_v2.ashby_application_links where external_application_id like 'pf72-%');
  delete from screening_v2.call_sessions where external_call_id like 'phone-pf72-%';
  delete from screening_v2.ashby_application_links where external_application_id like 'pf72-%';
  delete from screening_v2.ashby_job_mappings where external_job_id like 'pf72-%';
  delete from screening_v2.candidates where email like 'pf72-%@example.test';

  -- ── Build one engagement's chain, returning the ids we bind below. ──
  -- STRANDED (slug 'stranded'): attempt ended (outcome disconnected)
  -- 600s ago — older than the 180s grace, so it MUST be selected.
  -- CONTROL  (slug 'control'):  attempt ended 10s ago — inside the grace,
  -- so it MUST NOT be selected.
  for v_s in select unnest(array['stranded','control']) loop
    insert into screening_v2.candidates (role_id, name, email, phone_e164, phone_valid)
    values (v_role, 'pf72 ' || v_s, 'pf72-' || v_s || '@example.test',
            '+9199988' || lpad((abs(hashtext(v_s)) % 100000)::text, 5, '0'), true)
    returning id into v_cand;

    insert into screening_v2.consent_records (candidate_id, status, consents, version)
    values (v_cand, 'granted',
            '{ai_interview,recording,purpose,data_processing,retention,rights}'
              ::screening_v2.consent_type[], '2026-08-04.1');

    insert into screening_v2.ashby_job_mappings
      (external_job_id, role_id, owner_id, ai_screening_stage_id, ta_screening_stage_id,
       status, delivery_mode)
    values ('pf72-' || v_s || '-job', v_role, '00000000-0000-4000-8000-0000000000ad',
            'pf72-' || v_s || '-ai', 'pf72-' || v_s || '-ta', 'enabled', 'manual')
    returning id into v_map;

    insert into screening_v2.ashby_application_links
      (external_application_id, external_job_id, job_mapping_id,
       external_resume_file_handle, candidate_id)
    values ('pf72-' || v_s || '-app', 'pf72-' || v_s || '-job', v_map, repeat('h', 64), v_cand)
    returning id into v_link;

    perform screening_v2.advance_ashby_ingestion(v_link, unnest, null, null, null, null)
      from unnest(v_states);

    insert into screening_v2.phone_engagements
      (application_link_id, candidate_id, role_id, state)
    values (v_link, v_cand, v_role, 'in_call')
    returning id into v_eng;

    -- A live phone session, still in_progress, with an ACTIVE recording egress
    -- and NO object key — the exact shape a disconnect leaves behind. The
    -- cursor is 2 (two of three questions covered). A trigger enforces that
    -- every session starts `created`, so it is inserted `created` then driven
    -- to `in_progress` (a valid 0006 edge) carrying the recording stamp.
    insert into screening_v2.call_sessions
      (candidate_id, role_id, mode, provider, external_call_id, status,
       current_question_index, started_at, updated_at)
    values (v_cand, v_role, 'live', 'livekit', 'phone-pf72-' || v_s, 'created',
            2, v_now - interval '900 seconds', v_now - interval '900 seconds')
    returning id into v_sess;

    update screening_v2.call_sessions
       set status                  = 'in_progress',
           recording_egress_id     = 'EG_pf72' || v_s,
           recording_egress_status = 'active',
           updated_at              = v_now - interval '900 seconds'
     where id = v_sess;

    update screening_v2.phone_engagements set session_id = v_sess where id = v_eng;

    -- The immutable plan: the deterministic default plan (its questions are
    -- guaranteed speakable, which the 0065 plan-validation trigger enforces).
    -- `total` in the assert is derived from THIS count, not a literal.
    insert into screening_v2.phone_session_plans
      (session_id, engagement_id, role_id, source, questions, question_count)
    select v_sess, v_eng, v_role, 'default', q,
           jsonb_array_length(q)
      from (select screening_v2.phone_default_question_plan() as q) s;

    -- The attempt: terminal `ended` with outcome `disconnected` (candidate
    -- hangup). The stranded one ended 600s ago; the control one 10s ago.
    insert into screening_v2.phone_call_attempts
      (engagement_id, attempt_seq, epoch, kind, state, outcome_class,
       ist_date, prior_engagement_state, session_id, admitted_at, answered_at, ended_at)
    values (v_eng, 1, 0, 'initial', 'ended', 'disconnected',
            '2026-08-24', 'eligible', v_sess,
            v_now - interval '1200 seconds', v_now - interval '1100 seconds',
            case when v_s = 'stranded'
                 then v_now - interval '600 seconds'
                 else v_now - interval '10 seconds' end)
    returning id into v_att;
  end loop;

  raise notice 'pf72: stranded + control engagements ready at %', v_now;
end;
$$;
