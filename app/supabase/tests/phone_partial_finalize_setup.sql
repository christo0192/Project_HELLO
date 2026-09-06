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
-- It ALSO seeds a CRASH session — the residue 0071's reclaim leaves: the
-- attempt is `abandoned` (reclaim nulls its outcome_class) 600s ago and
-- the SESSION was already driven to `expired`/`grace_timeout` (its MP3
-- finalized by reclaim, its scoring never enqueued). The assert proves
-- 0072 ALSO selects this residue, RETURNS it with transitioned=false and
-- disconnect_reason='worker_crash' WITHOUT attempting the illegal
-- `expired -> completed` re-transition, and that once an assessment row
-- exists it is not re-selected (idempotency / no re-score).
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
  -- 600s ago — older than the 180s grace, so it MUST be selected. Session
  -- stays `in_progress` (the hangup path) → driven to completed.
  -- CONTROL  (slug 'control'):  attempt ended 10s ago — inside the grace,
  -- so it MUST NOT be selected.
  -- CRASH    (slug 'crash'):    attempt `abandoned` (outcome NULL) 600s ago
  -- and the SESSION already `expired`/`grace_timeout` — the residue 0071's
  -- reclaim leaves. MUST be selected, returned with transitioned=false and
  -- disconnect_reason='worker_crash', and NOT re-transitioned.
  -- LEASE_LAPSED (slug 'lease'): the EXACT live-call ac7c8c77 shape (RCA
  -- 2026-09-06). The candidate answered and was classified `human`, then the
  -- leg was lost by disconnect: the worker's `disconnect` branch preserves the
  -- room (reconnect) and returns, cancelling the heartbeat — so the lease STOPS
  -- renewing and lapses, but the attempt is NEVER driven `ended`/`abandoned`.
  -- The session stays `in_progress` forever. This is the selector's
  -- LEASE-EXPIRY branch (`state in ('human'...)` with `lease_expires_at` past),
  -- the one branch the stranded/crash fixtures do NOT exercise. 0072 MUST
  -- select it, drive it to completed/conversation_complete, and report
  -- disconnect_reason='worker_crash' (a lapsed lease in a live state).
  for v_s in select unnest(array['stranded','control','crash','lease']) loop
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

    -- CRASH residue: 0071's reclaim already drove this session terminal to
    -- `expired`/`grace_timeout` (a valid in_progress -> expired edge), keeping
    -- the stuck-recording egress shape (egress id set, object key null, status
    -- 'active') that finalized the MP3. 0072 must select it terminal.
    if v_s = 'crash' then
      update screening_v2.call_sessions
         set status          = 'expired',
             terminal_reason = 'grace_timeout',
             ended_at        = v_now - interval '600 seconds',
             updated_at      = v_now - interval '600 seconds'
       where id = v_sess;
    end if;

    update screening_v2.phone_engagements set session_id = v_sess where id = v_eng;

    -- The immutable plan: the deterministic default plan (its questions are
    -- guaranteed speakable, which the 0065 plan-validation trigger enforces).
    -- `total` in the assert is derived from THIS count, not a literal.
    insert into screening_v2.phone_session_plans
      (session_id, engagement_id, role_id, source, questions, question_count)
    select v_sess, v_eng, v_role, 'default', q,
           jsonb_array_length(q)
      from (select screening_v2.phone_default_question_plan() as q) s;

    -- The attempt:
    --   * stranded/control: terminal `ended` with outcome `disconnected`
    --     (candidate hangup). Stranded ended 600s ago; control 10s ago.
    --   * crash: `abandoned` with outcome NULL (reclaim's crash terminal),
    --     ended 600s ago — the residue 0072's abandoned-branch must select.
    --   * lease: live-state `human`, outcome NULL, NO ended_at, and a lease
    --     that lapsed 600s ago — the disconnect-abandoned RCA shape. Selected by
    --     the lease-expiry branch, NOT the ended/abandoned branches.
    insert into screening_v2.phone_call_attempts
      (engagement_id, attempt_seq, epoch, kind, state, outcome_class,
       ist_date, prior_engagement_state, session_id, admitted_at, answered_at,
       ended_at, lease_expires_at)
    values (v_eng, 1, 0, 'initial',
            case
              when v_s = 'crash' then 'abandoned'
              when v_s = 'lease' then 'human'
              else 'ended'
            end,
            case when v_s in ('crash','lease') then null else 'disconnected' end,
            '2026-08-24', 'eligible', v_sess,
            v_now - interval '1200 seconds', v_now - interval '1100 seconds',
            -- ended_at: NULL for the lease case (the attempt never terminalized).
            case
              when v_s = 'lease' then null
              when v_s = 'control' then v_now - interval '10 seconds'
              else v_now - interval '600 seconds'
            end,
            -- lease_expires_at: only the lease case relies on it (lapsed 600s
            -- ago). The others leave it NULL — their selection is by ended_at.
            case when v_s = 'lease' then v_now - interval '600 seconds'
                 else null end)
    returning id into v_att;
  end loop;

  raise notice 'pf72: stranded + control + crash engagements ready at %', v_now;
end;
$$;
