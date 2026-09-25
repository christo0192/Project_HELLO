-- =====================================================================
-- 0103 assertions — what each of the seven calls actually gets.
--
-- Executed against `start_phone_assessment` itself, with every migration
-- applied. Nothing here reads the function's source or trusts a comment:
-- each scenario calls it and reads the plan it snapshotted.
--
-- Run after `candidate_questions_setup.sql`.
-- =====================================================================
\set ON_ERROR_STOP on

-- ── Part 1: phone_normalize_question_plan, the extracted loop ─────────
-- Its rules ARE 0044's rules, so they are asserted directly rather than
-- only through the caller — a projection bug would otherwise show up as a
-- weird plan rather than as a failing rule.
do $$
declare
  v jsonb;
begin
  -- A valid template projects to the worker's {key,text,mandatory,hint}.
  v := screening_v2.phone_normalize_question_plan(jsonb_build_array(
         jsonb_build_object('id','q1','question','First question?','mandatory',true,
                            'follow_up_hint','probe the numbers'),
         jsonb_build_object('id','q2','question','  Second question?  ')));
  if v is null then raise exception 'cqs103/norm: a valid template was rejected'; end if;
  if jsonb_array_length(v) <> 2 then
    raise exception 'cqs103/norm: expected 2 questions, got %', jsonb_array_length(v);
  end if;
  -- `is distinct from`, NOT `<>`. A projection that drops `hint` altogether
  -- makes `v -> 0 ->> 'hint'` NULL, and `NULL <> 'probe the numbers'` is NULL,
  -- not TRUE — so the `if` never fired and the bot could lose every probe hint
  -- with this assertion green. Found by mutation.
  if v -> 0 ->> 'key' is distinct from 'q1'
     or v -> 0 ->> 'text' is distinct from 'First question?'
     or (v -> 0 -> 'mandatory') is distinct from 'true'::jsonb
     or v -> 0 ->> 'hint' is distinct from 'probe the numbers' then
    raise exception 'cqs103/norm: first question projected wrong: %', v -> 0;
  end if;
  -- Whitespace trimmed, `mandatory` defaulted to false, `hint` null.
  if v -> 1 ->> 'text' <> 'Second question?' then
    raise exception 'cqs103/norm: text was not trimmed: %', v -> 1;
  end if;
  if (v -> 1 -> 'mandatory') <> 'false'::jsonb then
    raise exception 'cqs103/norm: mandatory did not default to false: %', v -> 1;
  end if;
  if (v -> 1 -> 'hint') is distinct from 'null'::jsonb then
    raise exception 'cqs103/norm: absent hint was not null: %', v -> 1;
  end if;

  -- ORDER IS PRESERVED. The array IS the conversation.
  v := screening_v2.phone_normalize_question_plan(jsonb_build_array(
         jsonb_build_object('id','a','question','One?'),
         jsonb_build_object('id','b','question','Two?'),
         jsonb_build_object('id','c','question','Three?')));
  if v -> 0 ->> 'key' <> 'a' or v -> 1 ->> 'key' <> 'b' or v -> 2 ->> 'key' <> 'c' then
    raise exception 'cqs103/norm: order was not preserved: %', v;
  end if;

  -- UNKNOWN KEYS ARE IGNORED, never refused. `category` reaches this
  -- function on every modern template; refusing it would kill every call.
  v := screening_v2.phone_normalize_question_plan(jsonb_build_array(
         jsonb_build_object('id','q1','question','First?','category','introduction',
                            'weight',3,'something_new','x')));
  if v is null then raise exception 'cqs103/norm: an unknown key was refused'; end if;
  if v -> 0 ? 'category' then
    raise exception 'cqs103/norm: an unknown key reached the worker plan: %', v -> 0;
  end if;

  -- EMPTY IS EMPTY, not malformed: the caller distinguishes them.
  if screening_v2.phone_normalize_question_plan('[]'::jsonb) is distinct from '[]'::jsonb then
    raise exception 'cqs103/norm: an empty array did not project to an empty array';
  end if;

  -- And every refusal 0044 made, still made. NULL is the only signal.
  if screening_v2.phone_normalize_question_plan(null) is not null then
    raise exception 'cqs103/norm: null was accepted'; end if;
  if screening_v2.phone_normalize_question_plan('{"not":"an array"}'::jsonb) is not null then
    raise exception 'cqs103/norm: an object was accepted'; end if;
  if screening_v2.phone_normalize_question_plan('"a string"'::jsonb) is not null then
    raise exception 'cqs103/norm: a string was accepted'; end if;
  if screening_v2.phone_normalize_question_plan(jsonb_build_array('not an object')) is not null then
    raise exception 'cqs103/norm: a non-object item was accepted'; end if;
  if screening_v2.phone_normalize_question_plan(
       jsonb_build_array(jsonb_build_object('question','No id?'))) is not null then
    raise exception 'cqs103/norm: a missing id was accepted'; end if;
  if screening_v2.phone_normalize_question_plan(
       jsonb_build_array(jsonb_build_object('id','q1','question','   '))) is not null then
    raise exception 'cqs103/norm: a blank question was accepted'; end if;
  if screening_v2.phone_normalize_question_plan(
       jsonb_build_array(jsonb_build_object('id','has space','question','Q?'))) is not null then
    raise exception 'cqs103/norm: an id outside the key pattern was accepted'; end if;
  if screening_v2.phone_normalize_question_plan(
       jsonb_build_array(jsonb_build_object('id','q1','question',repeat('x', 2001))) ) is not null then
    raise exception 'cqs103/norm: a 2001-character question was accepted'; end if;
  -- ...and exactly 2000 is still accepted. Only the refusing side was asserted,
  -- so tightening the bound to `>= 2000` — which would start refusing live role
  -- templates — was invisible.
  if screening_v2.phone_normalize_question_plan(
       jsonb_build_array(jsonb_build_object('id','q1','question',repeat('x', 2000))) ) is null then
    raise exception 'cqs103/norm: a 2000-character question was refused'; end if;
  -- The hint bound, which had no assertion at all in either direction.
  if screening_v2.phone_normalize_question_plan(
       jsonb_build_array(jsonb_build_object('id','q1','question','Q?',
                                            'follow_up_hint',repeat('h', 2000)))) is null then
    raise exception 'cqs103/norm: a 2000-character hint was refused'; end if;
  if screening_v2.phone_normalize_question_plan(
       jsonb_build_array(jsonb_build_object('id','q1','question','Q?',
                                            'follow_up_hint',repeat('h', 2001)))) is not null then
    raise exception 'cqs103/norm: a 2001-character hint was accepted'; end if;
  -- EVERY CHARACTER THE ID PATTERN ALLOWS. Only `has space` was tested as a
  -- reject and nothing exercised an accept, so narrowing the class to
  -- `[A-Za-z0-9_-]` — which would refuse a live template with a dotted id and
  -- kill those calls outright — was invisible.
  if screening_v2.phone_normalize_question_plan(
       jsonb_build_array(jsonb_build_object('id','a.b:c-d_1','question','Q?'))) is null then
    raise exception 'cqs103/norm: a dotted/colonned id was refused'; end if;
  if screening_v2.phone_normalize_question_plan(
       jsonb_build_array(jsonb_build_object('id',repeat('k',100),'question','Q?'))) is null then
    raise exception 'cqs103/norm: a 100-character id was refused'; end if;
  if screening_v2.phone_normalize_question_plan(
       jsonb_build_array(jsonb_build_object('id',repeat('k',101),'question','Q?'))) is not null then
    raise exception 'cqs103/norm: a 101-character id was accepted'; end if;
  if screening_v2.phone_normalize_question_plan(
       jsonb_build_array(jsonb_build_object('id','q1','question','Q?','mandatory','yes'))) is not null then
    raise exception 'cqs103/norm: a non-boolean mandatory was accepted'; end if;
  if screening_v2.phone_normalize_question_plan(
       jsonb_build_array(jsonb_build_object('id','q1','question','One?'),
                         jsonb_build_object('id','q1','question','Two?'))) is not null then
    raise exception 'cqs103/norm: a duplicate id was accepted'; end if;
  if screening_v2.phone_normalize_question_plan(
       (select jsonb_agg(jsonb_build_object('id','q' || i, 'question','Q' || i || '?'))
          from generate_series(1, 101) i)) is not null then
    raise exception 'cqs103/norm: a 101-question template was accepted'; end if;
  -- ...and 100 exactly is still fine, so the bound is the documented one.
  if screening_v2.phone_normalize_question_plan(
       (select jsonb_agg(jsonb_build_object('id','q' || i, 'question','Q' || i || '?'))
          from generate_series(1, 100) i)) is null then
    raise exception 'cqs103/norm: a 100-question template was refused'; end if;

  raise notice 'cqs103/norm: PASS';
end $$;

-- ── Part 2: what each of the seven calls actually gets ────────────────
do $$
declare
  r          record;
  v_res      jsonb;
  v_plan     record;
  v_expected text;
  -- COUNTED, because a scenario that the join silently drops is a scenario
  -- that passes by never running. That is the shape of most of the useless
  -- tests this repository has had to repair.
  v_seen     integer := 0;
begin
  for r in
    select l.external_application_id as name,
           e.id   as engagement_id,
           a.id   as attempt_id,
           e.session_id,
           s.id   as sess_id
      from screening_v2.phone_engagements e
      join screening_v2.ashby_application_links l on l.id = e.application_link_id
      join screening_v2.phone_call_attempts a on a.engagement_id = e.id
      join screening_v2.call_sessions s on s.external_call_id like 'phone-%'
                                       and s.candidate_id = e.candidate_id
     where l.external_application_id like 'cqs103-%-app'
     order by l.external_application_id
  loop
    v_seen := v_seen + 1;
    v_res := screening_v2.start_phone_assessment(r.attempt_id, r.sess_id, now());

    -- ── badrole: an invalid ROLE template is still REFUSED ────────────
    -- 0044 refuses rather than substituting the defaults, because screening
    -- someone against questions nobody chose while the recruiter believes
    -- their own template is running is worse than not screening them. 0103
    -- must not have softened that into a fallback.
    if r.name = 'cqs103-badrole-app' then
      if v_res ->> 'status' <> 'invalid_role_template' then
        raise exception 'cqs103/%: expected invalid_role_template, got %',
          r.name, v_res ->> 'status';
      end if;
      if exists (select 1 from screening_v2.phone_session_plans where session_id = r.sess_id) then
        raise exception 'cqs103/%: a refused call still wrote a plan', r.name;
      end if;
      raise notice 'cqs103/%: PASS (refused: invalid_role_template)', r.name;
      continue;
    end if;

    if v_res ->> 'status' <> 'ok' then
      raise exception 'cqs103/%: expected ok, got % (%)',
        r.name, v_res ->> 'status', v_res;
    end if;

    select * into v_plan from screening_v2.phone_session_plans where session_id = r.sess_id;
    if not found then
      raise exception 'cqs103/%: no plan was snapshotted', r.name;
    end if;

    -- ── THE SET IS KEYED ON THE ENGAGEMENT, NOT THE CANDIDATE ─────────
    -- `rescreen` holds a TERMINAL cycle-1 engagement carrying a ready set, and
    -- an active cycle-2 engagement carrying none. Reading the candidate's set
    -- by candidate, by role, or by "most recent" would put cycle one's stale
    -- questions on this call. Every fixture used to have exactly one
    -- engagement, so this — the design's headline claim — was untestable.
    v_expected := case when r.name = 'cqs103-ready-app'
                       then 'candidate_resume' else 'role_template' end;
    if v_plan.source <> v_expected then
      raise exception 'cqs103/%: expected source %, got %', r.name, v_expected, v_plan.source;
    end if;

    -- Six questions either way: a candidate set REPLACES TEXT, it never
    -- changes the shape of the call.
    if v_plan.question_count <> 6 then
      raise exception 'cqs103/%: expected 6 questions, got %', r.name, v_plan.question_count;
    end if;

    if r.name = 'cqs103-ready-app' then
      -- The candidate's own questions, in the role's own slots.
      if v_plan.questions -> 1 ->> 'text'
         <> 'At Lumen Retail you grew the pipeline by forty percent, so what did you change?' then
        raise exception 'cqs103/%: the relevance slot is not the candidate''s: %',
          r.name, v_plan.questions -> 1 ->> 'text';
      end if;
      if v_plan.questions -> 4 ->> 'text'
         <> 'You moved on after two years at Brightpath, so what made that the right time?' then
        raise exception 'cqs103/%: the stability slot is not the candidate''s: %',
          r.name, v_plan.questions -> 4 ->> 'text';
      end if;
      -- AND THE FIXED COMPARTMENTS ARE UNTOUCHED. This is the whole safety
      -- claim: pay, notice and the shift question are asked of everyone,
      -- with the same words, or the answers are not comparable.
      if v_plan.questions -> 0 ->> 'text' <> 'To start, could you tell me about yourself?'
         or v_plan.questions -> 3 ->> 'text' <> 'How do you feel about working nights regularly?'
         or v_plan.questions -> 5 ->> 'text' <> 'What is your current annual CTC?' then
        raise exception 'cqs103/%: a fixed compartment changed: %', r.name, v_plan.questions;
      end if;
      -- The mandatory flags survive the substitution.
      if (v_plan.questions -> 0 -> 'mandatory') <> 'true'::jsonb
         or (v_plan.questions -> 1 -> 'mandatory') <> 'false'::jsonb
         or (v_plan.questions -> 5 -> 'mandatory') <> 'true'::jsonb then
        raise exception 'cqs103/%: mandatory flags did not survive: %', r.name, v_plan.questions;
      end if;
    else
      -- Absent, pending, failed, MALFORMED and the rescreen's fresh cycle all
      -- get the recruiter's own template — the screen the candidate would have
      -- had before 0103.
      if v_plan.questions -> 1 ->> 'text' is distinct from 'What does your current role involve day to day?' then
        raise exception 'cqs103/%: expected the role template, got %',
          r.name, v_plan.questions -> 1 ->> 'text';
      end if;
      -- And explicitly NOT another engagement's questions, nor a half-written
      -- row's. Both are storable states that the plan builder must never read.
      if exists (select 1 from jsonb_array_elements(v_plan.questions) q
                  where q ->> 'text' like 'STALE CYCLE ONE%') then
        raise exception 'cqs103/%: a TERMINAL cycle''s questions reached this call', r.name;
      end if;
      if exists (select 1 from jsonb_array_elements(v_plan.questions) q
                  where q ->> 'text' like 'HALF-WRITTEN PENDING%') then
        raise exception 'cqs103/%: a non-ready row''s questions reached this call', r.name;
      end if;
    end if;

    raise notice 'cqs103/%: PASS (source=%)', r.name, v_plan.source;
  end loop;

  if v_seen <> 7 then
    raise exception 'cqs103: expected 7 calls, the join produced % — a scenario '
                    'that never runs is a scenario that cannot fail', v_seen;
  end if;
end $$;

-- ── Part 3: the constraints the table and the plan now carry ──────────
do $$
declare
  v_eng             uuid;
  v_ok              boolean;
  v_probe_session   uuid;
  v_src             text;
begin
  select e.id into v_eng
    from screening_v2.phone_engagements e
    join screening_v2.ashby_application_links l on l.id = e.application_link_id
   where l.external_application_id = 'cqs103-absent-app';

  -- `chk_candidate_questions_ready`: a ready row must carry questions.
  v_ok := false;
  begin
    insert into screening_v2.candidate_screening_questions (engagement_id, status, questions)
    values (v_eng, 'ready', null);
  exception when check_violation then v_ok := true;
  end;
  if not v_ok then
    raise exception 'cqs103/chk: a ready row with no questions was accepted';
  end if;

  v_ok := false;
  begin
    insert into screening_v2.candidate_screening_questions (engagement_id, status, questions)
    values (v_eng, 'ready', '[]'::jsonb);
  exception when check_violation then v_ok := true;
  end;
  if not v_ok then
    raise exception 'cqs103/chk: a ready row with an empty array was accepted';
  end if;

  -- `chk_candidate_questions_status`: only the three states exist.
  v_ok := false;
  begin
    insert into screening_v2.candidate_screening_questions (engagement_id, status)
    values (v_eng, 'running');
  exception when check_violation then v_ok := true;
  end;
  if not v_ok then
    raise exception 'cqs103/chk: an undeclared status was accepted';
  end if;

  -- `chk_phone_session_plans_source` accepts the new value AND still refuses a
  -- typo, which is the only reason the constraint exists.
  --
  -- ON A FRESH SESSION, AND CATCHING ONLY check_violation. The first version
  -- inserted into a session that Part 2 had ALREADY written a plan for and
  -- accepted `unique_violation` as success — so the primary-key collision
  -- satisfied it whatever the CHECK said, and widening the constraint to
  -- `source is not null` left it green. Found by mutation.
  insert into screening_v2.call_sessions
    (candidate_id, role_id, mode, provider, external_call_id, status, current_question_index)
  select c.id, c.role_id, 'live', 'livekit', 'phone-cqs103-constraint-probe', 'created', 0
    from screening_v2.candidates c
   where c.email = 'cqs103-absent@example.test'
  returning id into v_probe_session;

  v_ok := false;
  begin
    insert into screening_v2.phone_session_plans
      (session_id, engagement_id, source, questions, question_count)
    values (v_probe_session, v_eng, 'candidate_resumes',
            '[{"key":"q1","text":"Q?"}]'::jsonb, 1);
  exception when check_violation then v_ok := true;
  end;
  if not v_ok then
    raise exception 'cqs103/chk: a misspelled plan source was accepted';
  end if;
  -- And the three real values are all accepted, so the constraint was not
  -- merely refusing everything.
  for v_src in select unnest(array['role_template','default','candidate_resume']) loop
    delete from screening_v2.phone_session_plans where session_id = v_probe_session;
    insert into screening_v2.phone_session_plans
      (session_id, engagement_id, source, questions, question_count)
    values (v_probe_session, v_eng, v_src, '[{"key":"q1","text":"Q?"}]'::jsonb, 1);
  end loop;
  delete from screening_v2.phone_session_plans where session_id = v_probe_session;
  delete from screening_v2.call_sessions where id = v_probe_session;

  raise notice 'cqs103/chk: PASS';
end $$;

-- ── Part 3b: the exposure posture, asserted here as well as centrally ──
-- `policy_tests.sql` carries the schema-wide versions of these. They are
-- repeated beside the migration because that file runs in a different CI job
-- with a different trigger, and the first EXECUTION of a wrong grant should
-- not be a browser session reading another candidate's questions.
do $$
declare
  v_oid oid;
begin
  if not exists (select 1 from pg_class c join pg_namespace n on n.oid = c.relnamespace
                  where n.nspname = 'screening_v2'
                    and c.relname = 'candidate_screening_questions'
                    and c.relrowsecurity) then
    raise exception 'cqs103/rls: row-level security is not enabled on the table';
  end if;
  -- RLS with a lingering grant is one policy away from being readable, so the
  -- grants are the other half of the same control.
  for v_oid in select c.oid from pg_class c join pg_namespace n on n.oid = c.relnamespace
                where n.nspname = 'screening_v2'
                  and c.relname = 'candidate_screening_questions' loop
    if has_table_privilege('anon', v_oid, 'SELECT')
       or has_table_privilege('authenticated', v_oid, 'SELECT') then
      raise exception 'cqs103/rls: a browser role can read the table';
    end if;
    if not has_table_privilege('service_role', v_oid, 'SELECT') then
      raise exception 'cqs103/rls: service_role cannot read the table it must write';
    end if;
  end loop;

  select p.oid into v_oid from pg_proc p join pg_namespace n on n.oid = p.pronamespace
   where n.nspname = 'screening_v2' and p.proname = 'phone_normalize_question_plan';
  if v_oid is null then
    raise exception 'cqs103/rls: the helper does not exist';
  end if;
  if has_function_privilege('anon', v_oid, 'EXECUTE')
     or has_function_privilege('authenticated', v_oid, 'EXECUTE') then
    raise exception 'cqs103/rls: the helper is browser-executable';
  end if;
  if not has_function_privilege('service_role', v_oid, 'EXECUTE') then
    raise exception 'cqs103/rls: service_role cannot execute the helper';
  end if;
  -- It pins its search_path, like every other function in this schema.
  if not exists (select 1 from pg_proc p, unnest(p.proconfig) c
                  where p.oid = v_oid and c like 'search_path=%') then
    raise exception 'cqs103/rls: the helper does not pin search_path';
  end if;

  raise notice 'cqs103/rls: PASS';
end $$;

-- ── Part 4: the cascade, proven by deleting ───────────────────────────
do $$
declare
  v_eng    uuid;
  v_before integer;
  v_after  integer;
begin
  select e.id into v_eng
    from screening_v2.phone_engagements e
    join screening_v2.ashby_application_links l on l.id = e.application_link_id
   where l.external_application_id = 'cqs103-ready-app';

  select count(*) into v_before from screening_v2.candidate_screening_questions
   where engagement_id = v_eng;
  if v_before <> 1 then
    raise exception 'cqs103/cascade: expected 1 generated row, found %', v_before;
  end if;

  -- The plan and the attempt reference the engagement too; both cascade.
  delete from screening_v2.phone_session_plans where engagement_id = v_eng;
  delete from screening_v2.phone_call_attempts where engagement_id = v_eng;
  update screening_v2.phone_engagements set state = 'cancelled', terminal_at = now()
   where id = v_eng;
  delete from screening_v2.phone_engagements where id = v_eng;

  select count(*) into v_after from screening_v2.candidate_screening_questions
   where engagement_id = v_eng;
  if v_after <> 0 then
    raise exception 'cqs103/cascade: % generated rows survived the engagement', v_after;
  end if;
  raise notice 'cqs103/cascade: PASS';
end $$;

-- ── Part 5: 0104 — holding the dial, and never pulling it forward ─────
-- THE SUBJECT IS AN `eligible` ENGAGEMENT, which is what production passes and
-- the only state the RPC now accepts. An earlier draft asserted entirely
-- against an `in_call` fixture — so a guard refusing exactly the production
-- state would have passed every assertion here.
do $$
declare
  v_eng     uuid;
  v_busy    uuid;
  v_before  timestamptz;
  v_after   timestamptz;
  v_res     jsonb;
  -- 15:30 IST — comfortably inside the 09:00-21:00 window.
  v_now     constant timestamptz := '2026-09-25T10:00:00Z'::timestamptz;
  -- 20:58 IST. A 150s push from here lands at 21:00:30 IST, past the close.
  v_edge    constant timestamptz := '2026-09-25T15:28:00Z'::timestamptz;
begin
  select e.id into v_eng
    from screening_v2.phone_engagements e
    join screening_v2.ashby_application_links l on l.id = e.application_link_id
   where l.external_application_id = 'cqs104-dialgrace-app';
  if v_eng is null then
    raise exception 'cqs104: the eligible fixture is missing';
  end if;
  if (select state from screening_v2.phone_engagements where id = v_eng) <> 'eligible' then
    raise exception 'cqs104: the fixture is not in the state production uses';
  end if;

  -- ── A candidate due NOW is pushed by the grace ─────────────────────
  update screening_v2.phone_engagements set next_eligible_at = v_now where id = v_eng;
  v_res := screening_v2.defer_phone_dial_for_questions(v_eng, 150, v_now);
  if v_res ->> 'status' <> 'deferred' then
    raise exception 'cqs104: expected deferred, got %', v_res;
  end if;
  select next_eligible_at into v_after from screening_v2.phone_engagements where id = v_eng;
  if v_after <> v_now + interval '150 seconds' then
    raise exception 'cqs104: expected a 150s push, got %', v_after;
  end if;

  -- ── THE SAFETY PROPERTY: it NEVER moves the dial earlier ───────────
  -- `next_eligible_at` is also what holds a candidate imported outside the
  -- IST calling window until the window opens. Writing `now + grace`
  -- unconditionally would drag them forward and ring a phone at 2am.
  v_before := v_now + interval '9 hours';
  update screening_v2.phone_engagements set next_eligible_at = v_before where id = v_eng;
  v_res := screening_v2.defer_phone_dial_for_questions(v_eng, 150, v_now);
  if v_res ->> 'status' <> 'unchanged' then
    raise exception 'cqs104: a windowed candidate was not left alone: %', v_res;
  end if;
  select next_eligible_at into v_after from screening_v2.phone_engagements where id = v_eng;
  if v_after <> v_before then
    raise exception 'cqs104: A WINDOWED CANDIDATE WAS PULLED FORWARD, % -> %', v_before, v_after;
  end if;

  -- A null timestamp is "due now", so it takes the grace rather than staying null.
  update screening_v2.phone_engagements set next_eligible_at = null where id = v_eng;
  v_res := screening_v2.defer_phone_dial_for_questions(v_eng, 150, v_now);
  select next_eligible_at into v_after from screening_v2.phone_engagements where id = v_eng;
  if v_after is distinct from v_now + interval '150 seconds' then
    raise exception 'cqs104: a null next_eligible_at was not held: %', v_after;
  end if;

  -- ── NEVER PAST THE CLOSE OF THE CALLING WINDOW ─────────────────────
  -- At 20:58 IST the push lands at 21:00:30 IST. Nothing re-normalises a
  -- `next_eligible_at` sitting past the close, so the candidate would wait
  -- until 09:00 the NEXT DAY — a twelve-hour delay bought with a 150-second
  -- race. The RPC must decline and leave the row alone.
  update screening_v2.phone_engagements set next_eligible_at = v_edge where id = v_eng;
  v_res := screening_v2.defer_phone_dial_for_questions(v_eng, 150, v_edge);
  if v_res ->> 'status' <> 'window_edge' then
    raise exception 'cqs104: a push past the window close was allowed: %', v_res;
  end if;
  select next_eligible_at into v_after from screening_v2.phone_engagements where id = v_eng;
  if v_after <> v_edge then
    raise exception 'cqs104: the window-edge candidate was moved to %', v_after;
  end if;
  -- ...and the guard is a WINDOW test, not a blanket refusal: the same call
  -- two hours earlier still defers.
  update screening_v2.phone_engagements
     set next_eligible_at = v_edge - interval '2 hours' where id = v_eng;
  if screening_v2.defer_phone_dial_for_questions(v_eng, 150, v_edge - interval '2 hours')
       ->> 'status' <> 'deferred' then
    raise exception 'cqs104: the window guard refuses calls inside the window';
  end if;

  -- ── The refusals ───────────────────────────────────────────────────
  update screening_v2.phone_engagements set next_eligible_at = v_now where id = v_eng;
  if screening_v2.defer_phone_dial_for_questions(null, 150, v_now) ->> 'status'
     <> 'unknown_engagement' then
    raise exception 'cqs104: a null engagement was accepted'; end if;
  if screening_v2.defer_phone_dial_for_questions(
       '00000000-0000-4000-8000-00000000dead'::uuid, 150, v_now) ->> 'status'
     <> 'unknown_engagement' then
    raise exception 'cqs104: an unknown engagement was accepted'; end if;
  -- A grace nobody meant is REFUSED, not clamped: silently accepting an hour
  -- would park a candidate nobody could find.
  for v_res in select screening_v2.defer_phone_dial_for_questions(v_eng, g, v_now)
                 from unnest(array[-1, 601, 100000]) g loop
    if v_res ->> 'status' <> 'invalid_grace' then
      raise exception 'cqs104: an out-of-range grace was accepted: %', v_res;
    end if;
  end loop;
  if screening_v2.defer_phone_dial_for_questions(v_eng, null, v_now) ->> 'status'
     <> 'invalid_grace' then
    raise exception 'cqs104: a null grace was accepted'; end if;
  -- ...and the bounds themselves are accepted, so the check is a range and
  -- not a refusal of everything.
  update screening_v2.phone_engagements set next_eligible_at = v_now where id = v_eng;
  if screening_v2.defer_phone_dial_for_questions(v_eng, 600, v_now) ->> 'status'
     <> 'deferred' then
    raise exception 'cqs104: the upper bound was refused'; end if;

  -- ── ONLY AN ENGAGEMENT STILL WAITING FOR ITS FIRST DIAL ────────────
  -- `engagement_active` (which the caller treats as dialable) also covers
  -- `dialing`, `in_call` and `reconnecting`. For a reconnect the due time
  -- lives on `updated_at`, not on this column, so moving it is meaningless;
  -- for a call already underway it is far too late to matter. The 0103
  -- fixtures are all walked to `in_call`, which makes one a perfect subject.
  select e.id into v_busy
    from screening_v2.phone_engagements e
    join screening_v2.ashby_application_links l on l.id = e.application_link_id
   where l.external_application_id = 'cqs103-absent-app';
  update screening_v2.phone_engagements set next_eligible_at = v_now where id = v_busy;
  v_res := screening_v2.defer_phone_dial_for_questions(v_busy, 150, v_now);
  if v_res ->> 'status' <> 'engagement_not_waiting' then
    raise exception 'cqs104: an in_call engagement was deferred: %', v_res;
  end if;
  if v_res ->> 'engagement_state' <> 'in_call' then
    raise exception 'cqs104: the refusal does not say which state: %', v_res;
  end if;
  select next_eligible_at into v_after from screening_v2.phone_engagements where id = v_busy;
  if v_after <> v_now then
    raise exception 'cqs104: an in_call engagement had its dial moved to %', v_after;
  end if;

  -- `updated_at` IS THE RECONNECT DUE CLOCK and this function must never
  -- touch it — a bump would push a candidate who was just cut off another
  -- backoff away. Asserted on the row it DOES write.
  update screening_v2.phone_engagements
     set next_eligible_at = v_now, updated_at = v_now - interval '1 hour'
   where id = v_eng;
  if screening_v2.defer_phone_dial_for_questions(v_eng, 150, v_now) ->> 'status'
     <> 'deferred' then
    raise exception 'cqs104: the deferred precondition did not hold'; end if;
  select updated_at into v_after from screening_v2.phone_engagements where id = v_eng;
  if v_after <> v_now - interval '1 hour' then
    raise exception 'cqs104: updated_at WAS MOVED to % (reconnect clock)', v_after;
  end if;

  -- ── A terminal engagement is immutable, and says so ────────────────
  -- Done LAST on a fixture nothing else reads, so the shared rows stay usable
  -- for whoever adds Part 6.
  update screening_v2.phone_engagements set next_eligible_at = v_now where id = v_eng;
  update screening_v2.phone_engagements
     set state = 'cancelled', terminal_at = v_now where id = v_eng;
  v_res := screening_v2.defer_phone_dial_for_questions(v_eng, 150, v_now);
  if v_res ->> 'status' <> 'engagement_terminal' then
    raise exception 'cqs104: a terminal engagement was deferred: %', v_res;
  end if;

  -- ── Exposure posture, like every other phone RPC ───────────────────
  if has_function_privilege('anon', 'screening_v2.defer_phone_dial_for_questions(uuid,integer,timestamptz)', 'EXECUTE')
     or has_function_privilege('authenticated', 'screening_v2.defer_phone_dial_for_questions(uuid,integer,timestamptz)', 'EXECUTE') then
    raise exception 'cqs104: the RPC is browser-executable';
  end if;

  raise notice 'cqs104: PASS';
end $$;

select 'cqs103 ALL ASSERTIONS PASSED' as result;
