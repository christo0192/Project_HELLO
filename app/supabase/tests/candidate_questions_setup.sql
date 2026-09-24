-- =====================================================================
-- 0103 fixture — six calls about to start, differing only in what the
-- candidate's generated question set looks like.
--
-- `start_phone_assessment` is the most dangerous function in this system:
-- it runs once per call, under lock, and whatever it snapshots IS the
-- conversation. 0103 changes its plan-selection block, so the only
-- verification worth having is EXECUTION against the real function with
-- every migration applied.
--
-- Six families under the `cqs103-` namespace, each a legitimate call at
-- the moment the worker asks for its plan:
--
--   ready      a valid generated set exists  → the plan is the CANDIDATE's,
--              and `source` is `candidate_resume`
--   absent     no row at all                 → the ROLE template
--   pending    a row that has not finished   → the ROLE template
--   failed     a row that gave up            → the ROLE template
--   malformed  status `ready`, but the questions are not questions. The
--              table's CHECK only bounds the ARRAY, so this row is
--              storable — and it is the shape a generator bug produces
--              → the ROLE template, NOT a refused call
--   badrole    an invalid ROLE template and NO candidate set → still
--              `invalid_role_template`. 0044 refuses rather than
--              substituting defaults, and 0103 must not have softened it
--
-- Run:
--   psql -v ON_ERROR_STOP=1 -f candidate_questions_setup.sql
--   psql -v ON_ERROR_STOP=1 -f candidate_questions_assert.sql
--
-- Synthetic identifiers only; no real candidate, email or document.
-- =====================================================================
\set ON_ERROR_STOP on

do $$
declare
  v_role     uuid;
  v_badrole  uuid;
  v_cand     uuid;
  v_map      uuid;
  v_link     uuid;
  v_eng      uuid;
  v_sess     uuid;
  v_att      uuid;
  v_prior    uuid;
  v_s        text;
  v_owner    constant uuid := '00000000-0000-4000-8000-0000000000ad';
  v_states   constant text[] := array['queued','fetching','scanning','extracting','structuring','ready'];
  -- The role's own template: a compartmented screen, exactly the shape
  -- `withArc` writes. The two variable compartments are what a candidate
  -- set replaces; everything else must survive untouched.
  v_template constant jsonb := jsonb_build_array(
    jsonb_build_object('id','q1','question','To start, could you tell me about yourself?','weight',1,'mandatory',true,'category','introduction'),
    jsonb_build_object('id','q2','question','What does your current role involve day to day?','weight',1,'category','profile_relevance'),
    jsonb_build_object('id','q3','question','How do you handle an unhappy customer?','weight',1,'category','profile_relevance'),
    jsonb_build_object('id','q4','question','How do you feel about working nights regularly?','weight',1,'mandatory',true,'category','shift_fit'),
    jsonb_build_object('id','q5','question','How long have you stayed in your recent positions?','weight',1,'category','stability'),
    jsonb_build_object('id','q6','question','What is your current annual CTC?','weight',1,'mandatory',true,'category','compensation')
  );
  -- The same screen with the two variable compartments rewritten about one
  -- candidate. Same ids, same order, same mandatory flags.
  v_candidate constant jsonb := jsonb_build_array(
    jsonb_build_object('id','q1','question','To start, could you tell me about yourself?','weight',1,'mandatory',true,'category','introduction'),
    jsonb_build_object('id','q2','question','At Lumen Retail you grew the pipeline by forty percent, so what did you change?','weight',1,'category','profile_relevance'),
    jsonb_build_object('id','q3','question','You led a team of six there; how did you coach the weakest performer?','weight',1,'category','profile_relevance'),
    jsonb_build_object('id','q4','question','How do you feel about working nights regularly?','weight',1,'mandatory',true,'category','shift_fit'),
    jsonb_build_object('id','q5','question','You moved on after two years at Brightpath, so what made that the right time?','weight',1,'category','stability'),
    jsonb_build_object('id','q6','question','What is your current annual CTC?','weight',1,'mandatory',true,'category','compensation')
  );
begin
  -- ── Idempotent teardown, children before parents ───────────────────
  delete from screening_v2.candidate_screening_questions
   where engagement_id in (
     select id from screening_v2.phone_engagements
      where application_link_id in (
        select id from screening_v2.ashby_application_links
         where external_application_id like 'cqs103-%'));
  delete from screening_v2.phone_session_plans
   where engagement_id in (
     select id from screening_v2.phone_engagements
      where application_link_id in (
        select id from screening_v2.ashby_application_links
         where external_application_id like 'cqs103-%'));
  delete from screening_v2.phone_call_attempts
   where engagement_id in (
     select id from screening_v2.phone_engagements
      where application_link_id in (
        select id from screening_v2.ashby_application_links
         where external_application_id like 'cqs103-%'));
  delete from screening_v2.phone_engagements
   where application_link_id in (
     select id from screening_v2.ashby_application_links
      where external_application_id like 'cqs103-%');
  delete from screening_v2.call_sessions where external_call_id like 'phone-%'
     and candidate_id in (select id from screening_v2.candidates
                           where email like 'cqs103-%@example.test');
  delete from screening_v2.ashby_application_links where external_application_id like 'cqs103-%';
  delete from screening_v2.ashby_job_mappings where external_job_id like 'cqs103-%';
  delete from screening_v2.candidates where email like 'cqs103-%@example.test';
  delete from screening_v2.roles where title like 'cqs103 %';

  -- ── Two roles: one with a usable template, one with a broken one ───
  insert into screening_v2.roles (title, jd, required_skills, screening_template, owner_id)
  values ('cqs103 good role', 'Sell to enterprise buyers on US hours.',
          '["Outbound calling"]'::jsonb, v_template, v_owner)
  returning id into v_role;

  -- A template `phone_normalize_question_plan` must reject: a duplicate id.
  -- 0044 refused this and 0103 must still refuse it.
  insert into screening_v2.roles (title, jd, required_skills, screening_template, owner_id)
  values ('cqs103 bad role', 'Sell things.', '["Outbound calling"]'::jsonb,
          jsonb_build_array(
            jsonb_build_object('id','q1','question','First question?'),
            jsonb_build_object('id','q1','question','Second question with the same id?')),
          v_owner)
  returning id into v_badrole;

  -- ── One call per scenario, each genuinely ready to be screened ──────
  for v_s in select unnest(array['ready','absent','pending','failed','malformed','badrole','rescreen']) loop
    insert into screening_v2.candidates (role_id, name, email, phone_e164, phone_valid)
    values (case when v_s = 'badrole' then v_badrole else v_role end,
            'cqs103 ' || v_s, 'cqs103-' || v_s || '@example.test',
            '+9199866' || lpad((abs(hashtext('c' || v_s)) % 100000)::text, 5, '0'), true)
    returning id into v_cand;

    insert into screening_v2.consent_records (candidate_id, status, consents, version)
    values (v_cand, 'granted',
            '{ai_interview,recording,purpose,data_processing,retention,rights}'
              ::screening_v2.consent_type[], '2026-08-04.1');

    insert into screening_v2.ashby_job_mappings
      (external_job_id, role_id, owner_id, ai_screening_stage_id, ta_screening_stage_id,
       status, delivery_mode)
    values ('cqs103-' || v_s || '-job',
            case when v_s = 'badrole' then v_badrole else v_role end,
            v_owner, 'cqs103-' || v_s || '-ai', 'cqs103-' || v_s || '-ta',
            'enabled', 'manual')
    returning id into v_map;

    insert into screening_v2.ashby_application_links
      (external_application_id, external_job_id, job_mapping_id,
       external_resume_file_handle, candidate_id)
    values ('cqs103-' || v_s || '-app', 'cqs103-' || v_s || '-job', v_map,
            repeat('h', 64), v_cand)
    returning id into v_link;

    perform screening_v2.advance_ashby_ingestion(v_link, unnest, null, null, null, null)
      from unnest(v_states);

    -- ── A PRIOR, TERMINAL CYCLE FOR THE RESCREEN FAMILY ───────────────
    -- `0057` allows three cycles per application, and only one may be
    -- non-terminal. Cycle 1 here is `cancelled` and carries a READY set whose
    -- questions are unmistakable, so an implementation that reads the
    -- candidate's set by anything other than THIS engagement is visible.
    if v_s = 'rescreen' then
      insert into screening_v2.phone_engagements
        (application_link_id, candidate_id, role_id, cycle_number, state)
      values (v_link, v_cand, v_role, 1, 'pending_prereqs')
      returning id into v_prior;
      update screening_v2.phone_engagements
         set state = 'cancelled', terminal_at = now() where id = v_prior;
      insert into screening_v2.candidate_screening_questions
        (engagement_id, role_id, status, questions, template_hash, model, generated_at)
      values (v_prior, v_role, 'ready',
              jsonb_build_array(
                jsonb_build_object('id','q1','question','STALE CYCLE ONE QUESTION, never ask this?','weight',1)),
              'fnv1a32:00000003:1', 'deepseek', now());
    end if;

    insert into screening_v2.phone_engagements
      (application_link_id, candidate_id, role_id, cycle_number, state)
    values (v_link, v_cand,
            case when v_s = 'badrole' then v_badrole else v_role end,
            case when v_s = 'rescreen' then 2 else 1 end,
            'pending_prereqs')
    returning id into v_eng;

    -- The session, then its DETERMINISTIC room name. `start_phone_assessment`
    -- verifies `external_call_id = 'phone-' || session_id` rather than taking
    -- the worker's word for the binding, so it cannot be written up front.
    insert into screening_v2.call_sessions
      (candidate_id, role_id, mode, provider, external_call_id, status,
       current_question_index)
    values (v_cand, case when v_s = 'badrole' then v_badrole else v_role end,
            'live', 'livekit', 'phone-placeholder-' || v_s, 'created', 0)
    returning id into v_sess;
    update screening_v2.call_sessions
       set external_call_id = 'phone-' || v_sess::text,
           status           = 'waiting'
     where id = v_sess;

    -- `in_call` is the consent gate: reached only through
    -- `disclosure.delivered`, and the transition trigger enforces the path.
    update screening_v2.phone_engagements set state = 'eligible' where id = v_eng;
    update screening_v2.phone_engagements set state = 'dialing'  where id = v_eng;
    update screening_v2.phone_engagements set state = 'in_call'  where id = v_eng;

    insert into screening_v2.phone_call_attempts
      (engagement_id, attempt_seq, epoch, kind, state, ist_date,
       prior_engagement_state, admitted_at, answered_at)
    -- `prior_engagement_state` is the state the attempt was ADMITTED from —
    -- the one a sweeper would restore — and `chk_phone_call_attempts_prior_state`
    -- allows only eligible/scheduled/reconnecting. `dialing` is where the
    -- engagement goes next, not where it came from.
    values (v_eng, 1, 0, 'initial', 'human', current_date, 'eligible', now(), now())
    returning id into v_att;

    -- The generated set, in whatever state this scenario is about.
    if v_s = 'ready' then
      insert into screening_v2.candidate_screening_questions
        (engagement_id, role_id, status, questions, template_hash, model, generated_at)
      values (v_eng, v_role, 'ready', v_candidate, 'fnv1a32:00000001:6', 'deepseek', now());
    elsif v_s = 'pending' then
      -- CARRYING QUESTIONS, deliberately. `chk_candidate_questions_ready`
      -- constrains only `ready` rows, so a half-written `pending` row can hold
      -- an array — and with every fixture's non-ready row left empty, dropping
      -- the `status = 'ready'` filter from the plan builder changed nothing
      -- and the harness stayed green. Now it does not.
      insert into screening_v2.candidate_screening_questions
        (engagement_id, role_id, status, questions)
      values (v_eng, v_role, 'pending',
              jsonb_build_array(
                jsonb_build_object('id','q1','question','HALF-WRITTEN PENDING QUESTION, never ask this?','weight',1)));
    elsif v_s = 'failed' then
      insert into screening_v2.candidate_screening_questions
        (engagement_id, role_id, status, error_reason)
      values (v_eng, v_role, 'failed', 'no_resume');
    elsif v_s = 'malformed' then
      -- STORABLE, because `chk_candidate_questions_ready` bounds the ARRAY
      -- and not its contents. This is the shape a generator bug produces,
      -- and the call must fall back rather than refuse.
      insert into screening_v2.candidate_screening_questions
        (engagement_id, role_id, status, questions, template_hash, model, generated_at)
      values (v_eng, v_role, 'ready',
              jsonb_build_array(jsonb_build_object('id','q1','question',''),
                                jsonb_build_object('nothing','useful')),
              'fnv1a32:00000002:2', 'deepseek', now());
    end if;

  end loop;
end $$;

-- A visible tally, so a silent seeding failure is not mistaken for a pass.
select 'cqs103 seeded' as fixture,
       count(*) filter (where e.state = 'in_call') as calls_ready,
       count(*) filter (where q.status is not null) as question_rows
  from screening_v2.phone_engagements e
  join screening_v2.ashby_application_links l on l.id = e.application_link_id
  left join screening_v2.candidate_screening_questions q on q.engagement_id = e.id
 where l.external_application_id like 'cqs103-%';
