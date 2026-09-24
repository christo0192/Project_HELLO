-- =====================================================================
-- 0103 assertions — what each of the six calls actually gets.
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
  if v -> 0 ->> 'key' <> 'q1' or v -> 0 ->> 'text' <> 'First question?'
     or (v -> 0 -> 'mandatory') <> 'true'::jsonb
     or v -> 0 ->> 'hint' <> 'probe the numbers' then
    raise exception 'cqs103/norm: first question projected wrong: %', v -> 0;
  end if;
  -- Whitespace trimmed, `mandatory` defaulted to false, `hint` null.
  if v -> 1 ->> 'text' <> 'Second question?' then
    raise exception 'cqs103/norm: text was not trimmed: %', v -> 1;
  end if;
  if (v -> 1 -> 'mandatory') <> 'false'::jsonb then
    raise exception 'cqs103/norm: mandatory did not default to false: %', v -> 1;
  end if;
  if (v -> 1 -> 'hint') <> 'null'::jsonb then
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

-- ── Part 2: what each of the six calls actually gets ──────────────────
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
      -- Absent, pending, failed and MALFORMED all get the recruiter's own
      -- template — the screen the candidate would have had before 0103.
      if v_plan.questions -> 1 ->> 'text' <> 'What does your current role involve day to day?' then
        raise exception 'cqs103/%: expected the role template, got %',
          r.name, v_plan.questions -> 1 ->> 'text';
      end if;
    end if;

    raise notice 'cqs103/%: PASS (source=%)', r.name, v_plan.source;
  end loop;

  if v_seen <> 6 then
    raise exception 'cqs103: expected 6 calls, the join produced % — a scenario '
                    'that never runs is a scenario that cannot fail', v_seen;
  end if;
end $$;

-- ── Part 3: the constraints the table and the plan now carry ──────────
do $$
declare
  v_eng uuid;
  v_ok  boolean;
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

  -- `chk_phone_session_plans_source` accepts the new value AND still
  -- refuses a typo, which is the only reason the constraint exists.
  v_ok := false;
  begin
    insert into screening_v2.phone_session_plans
      (session_id, engagement_id, source, questions, question_count)
    select s.id, v_eng, 'candidate_resumes', '[{"key":"q1","text":"Q?"}]'::jsonb, 1
      from screening_v2.call_sessions s
      join screening_v2.candidates c on c.id = s.candidate_id
     where c.email = 'cqs103-absent@example.test' limit 1;
  exception when check_violation then v_ok := true;
           when unique_violation then v_ok := true;
  end;
  if not v_ok then
    raise exception 'cqs103/chk: a misspelled plan source was accepted';
  end if;

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

select 'cqs103 ALL ASSERTIONS PASSED' as result;
