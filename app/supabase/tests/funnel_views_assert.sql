\set ON_ERROR_STOP on
-- ── Fixture ────────────────────────────────────────────────────────────
insert into screening_v2.roles (id, title) values
  ('10000000-0000-0000-0000-000000000001', 'Senior Data Engineer');

insert into screening_v2.candidates (id, role_id, phone_valid, parsed) values
  ('20000000-0000-0000-0000-000000000001', '10000000-0000-0000-0000-000000000001', true,  '{"current_role":"Data Engineer"}'),
  ('20000000-0000-0000-0000-000000000002', '10000000-0000-0000-0000-000000000001', true,  '{"current_role":"Data Engineer"}'),
  ('20000000-0000-0000-0000-000000000003', '10000000-0000-0000-0000-000000000001', false, '{"current_role":"Data Engineer"}'),
  ('20000000-0000-0000-0000-000000000004', '10000000-0000-0000-0000-000000000001', true,  '{"current_role":"Data Engineer"}');

insert into screening_v2.ashby_job_mappings (id, role_id, reference_check_stage_id) values
  ('60000000-0000-0000-0000-000000000001', '10000000-0000-0000-0000-000000000001', 'stage_ref');

-- C1: full funnel THROUGH reference check (advance + external_stage matches)
insert into screening_v2.call_sessions (id, candidate_id, status, terminal_reason, duration_sec) values
  ('30000000-0000-0000-0000-000000000001', '20000000-0000-0000-0000-000000000001', 'completed', 'assessment_done', 300);
insert into screening_v2.phone_engagements (id, candidate_id, role_id, state, session_id) values
  ('40000000-0000-0000-0000-000000000001', '20000000-0000-0000-0000-000000000001', '10000000-0000-0000-0000-000000000001', 'completed', '30000000-0000-0000-0000-000000000001');
insert into screening_v2.phone_call_attempts (id, engagement_id, session_id, state, outcome_class, admitted_at, answered_at, ended_at) values
  ('50000000-0000-0000-0000-000000000001', '40000000-0000-0000-0000-000000000001', '30000000-0000-0000-0000-000000000001', 'human', 'completed',
   now() - interval '10 minutes', now() - interval '9 minutes', now() - interval '4 minutes');
insert into screening_v2.phone_session_plans (session_id, engagement_id, question_count) values
  ('30000000-0000-0000-0000-000000000001', '40000000-0000-0000-0000-000000000001', 2);
insert into screening_v2.phone_session_progress (session_id, question_key, disposition) values
  ('30000000-0000-0000-0000-000000000001', 'q1', 'asked_answered'),
  ('30000000-0000-0000-0000-000000000001', 'q2', 'volunteered_with_evidence');
insert into screening_v2.assessments (session_id, candidate_id, recommendation, scoring_status, overall_score, weighted_score_5) values
  ('30000000-0000-0000-0000-000000000001', '20000000-0000-0000-0000-000000000001', 'advance', 'complete', 82, 4.1);
insert into screening_v2.ashby_application_links (id, external_application_id, external_stage_id, job_mapping_id, candidate_id) values
  ('70000000-0000-0000-0000-000000000001', 'app1', 'stage_ref', '60000000-0000-0000-0000-000000000001', '20000000-0000-0000-0000-000000000001');

-- C2: dialed, no answer
insert into screening_v2.phone_engagements (id, candidate_id, role_id, state) values
  ('40000000-0000-0000-0000-000000000002', '20000000-0000-0000-0000-000000000002', '10000000-0000-0000-0000-000000000001', 'abandoned_no_answer');
insert into screening_v2.phone_call_attempts (id, engagement_id, state, outcome_class, admitted_at) values
  ('50000000-0000-0000-0000-000000000002', '40000000-0000-0000-0000-000000000002', 'ended', 'no_answer', now() - interval '20 minutes');

-- C4: REGRESSION GUARD for the drop_reason bug — advanced/qualified but NOT yet
-- at reference check (no matching external_stage). Must be furthest='qualified'
-- with drop_reason IS NULL (before the fix it was wrongly 'scored_not_advanced').
insert into screening_v2.call_sessions (id, candidate_id, status, terminal_reason, duration_sec) values
  ('30000000-0000-0000-0000-000000000004', '20000000-0000-0000-0000-000000000004', 'completed', 'assessment_done', 240);
insert into screening_v2.phone_engagements (id, candidate_id, role_id, state, session_id) values
  ('40000000-0000-0000-0000-000000000004', '20000000-0000-0000-0000-000000000004', '10000000-0000-0000-0000-000000000001', 'completed', '30000000-0000-0000-0000-000000000004');
insert into screening_v2.phone_call_attempts (id, engagement_id, session_id, state, outcome_class, admitted_at, answered_at, ended_at) values
  ('50000000-0000-0000-0000-000000000004', '40000000-0000-0000-0000-000000000004', '30000000-0000-0000-0000-000000000004', 'human', 'completed',
   now() - interval '30 minutes', now() - interval '29 minutes', now() - interval '26 minutes');
insert into screening_v2.phone_session_plans (session_id, engagement_id, question_count) values
  ('30000000-0000-0000-0000-000000000004', '40000000-0000-0000-0000-000000000004', 1);
insert into screening_v2.phone_session_progress (session_id, question_key, disposition) values
  ('30000000-0000-0000-0000-000000000004', 'q1', 'asked_answered');
insert into screening_v2.assessments (session_id, candidate_id, recommendation, scoring_status, overall_score, weighted_score_5) values
  ('30000000-0000-0000-0000-000000000004', '20000000-0000-0000-0000-000000000004', 'advance', 'complete', 78, 3.9);

-- Failure sources: two ashby ingestions (one clean code, one messy → sanitized
-- to 'other'), plus a sync-upload failure.
insert into screening_v2.ashby_application_links (id, external_application_id, job_mapping_id) values
  ('70000000-0000-0000-0000-000000000009', 'app_fail', '60000000-0000-0000-0000-000000000001'),
  ('70000000-0000-0000-0000-00000000000a', 'app_fail2', '60000000-0000-0000-0000-000000000001');
insert into screening_v2.ashby_resume_ingestions (id, application_link_id, state, failed_reason) values
  ('80000000-0000-0000-0000-000000000001', '70000000-0000-0000-0000-000000000009', 'failed_review', 'parse_bad_output'),
  ('80000000-0000-0000-0000-000000000002', '70000000-0000-0000-0000-00000000000a', 'failed_review', 'Bad Output With Spaces');
insert into screening_v2.resume_intake_failures (role_id, failed_reason) values
  ('10000000-0000-0000-0000-000000000001', 'no_extractable_fields');

-- ── Assertions ─────────────────────────────────────────────────────────
do $$
declare v int; t text;
begin
  if screening_v2.funnel_role_class('Senior Data Engineer') <> 'data' then raise exception 'role_class data'; end if;
  if screening_v2.funnel_role_class('Engineering Manager') <> 'engineering' then raise exception 'role_class engineering'; end if;
  if screening_v2.funnel_role_class(null) <> 'unknown' then raise exception 'null -> unknown'; end if;

  select count(*) into v from screening_v2.v_funnel_candidate;
  if v <> 4 then raise exception 'expected 4 candidate rows, got %', v; end if;

  -- C1: reached reference check, no drop
  select furthest_stage into t from screening_v2.v_funnel_candidate where candidate_id = '20000000-0000-0000-0000-000000000001';
  if t <> 'reference_check' then raise exception 'C1 furthest reference_check, got %', t; end if;
  select drop_reason into t from screening_v2.v_funnel_candidate where candidate_id = '20000000-0000-0000-0000-000000000001';
  if t is not null then raise exception 'C1 drop_reason null, got %', t; end if;

  -- C4: THE regression guard — qualified, NOT at reference check, drop MUST be null
  select furthest_stage into t from screening_v2.v_funnel_candidate where candidate_id = '20000000-0000-0000-0000-000000000004';
  if t <> 'qualified' then raise exception 'C4 furthest qualified, got %', t; end if;
  select drop_reason into t from screening_v2.v_funnel_candidate where candidate_id = '20000000-0000-0000-0000-000000000004';
  if t is not null then raise exception 'C4 (qualified, pre-reference-check) drop_reason MUST be null, got %', t; end if;

  select answered_questions into v from screening_v2.v_funnel_candidate where candidate_id = '20000000-0000-0000-0000-000000000001';
  if v <> 2 then raise exception 'C1 answered 2, got %', v; end if;

  select drop_reason into t from screening_v2.v_funnel_candidate where candidate_id = '20000000-0000-0000-0000-000000000002';
  if t <> 'no_answer' then raise exception 'C2 drop_reason no_answer, got %', t; end if;
  select drop_reason into t from screening_v2.v_funnel_candidate where candidate_id = '20000000-0000-0000-0000-000000000003';
  if t <> 'not_dialed' then raise exception 'C3 drop_reason not_dialed, got %', t; end if;

  -- intake: 4 parsed + 2 needs_review + 1 failed
  select count(*) into v from screening_v2.v_funnel_intake;
  if v <> 7 then raise exception 'expected 7 intake rows, got %', v; end if;
  select count(*) into v from screening_v2.v_funnel_intake where outcome = 'needs_review';
  if v <> 2 then raise exception 'expected 2 needs_review, got %', v; end if;

  -- failures: 3 resume_parse (2 ingestion + 1 sync)
  select count(*) into v from screening_v2.v_funnel_failures where stage = 'resume_parse';
  if v <> 3 then raise exception 'expected 3 resume_parse failures, got %', v; end if;
  -- K: the messy ashby code is sanitized to 'other'
  select code into t from screening_v2.v_funnel_failures where entity_id = '80000000-0000-0000-0000-000000000002';
  if t <> 'other' then raise exception 'messy ashby code MUST sanitize to other, got %', t; end if;

  raise notice 'VIEW ASSERTIONS PASSED';
end $$;

-- ── RPC + rollup ─────────────────────────────────────────────────────────
select screening_v2.refresh_funnel_rollup(now(), 30);
do $$
declare r record;
begin
  select * into r from screening_v2.funnel_stage_daily
    where role_id = '10000000-0000-0000-0000-000000000001' order by cohort_day desc limit 1;
  if r is null then raise exception 'no rollup row'; end if;
  if r.parsed_ok <> 4 then raise exception 'parsed_ok 4, got %', r.parsed_ok; end if;
  if r.needs_review <> 2 then raise exception 'needs_review 2, got %', r.needs_review; end if;
  if r.parse_failed <> 1 then raise exception 'parse_failed 1, got %', r.parse_failed; end if;
  if r.dialed <> 3 then raise exception 'dialed 3, got %', r.dialed; end if;
  if r.connected <> 2 then raise exception 'connected 2, got %', r.connected; end if;
  if r.qualified <> 2 then raise exception 'qualified 2, got %', r.qualified; end if;
  if r.reached_reference_check <> 1 then raise exception 'reached_reference_check 1, got %', r.reached_reference_check; end if;
  if r.total_call_seconds <> 540 then raise exception 'total_call_seconds 540, got %', r.total_call_seconds; end if;
  raise notice 'ROLLUP ASSERTIONS PASSED';
end $$;

-- idempotency + the unique grain guard: a second refresh keeps exactly one row
select screening_v2.refresh_funnel_rollup(now(), 30);
do $$
declare v int;
begin
  select count(*) into v from screening_v2.funnel_stage_daily where role_id = '10000000-0000-0000-0000-000000000001';
  if v <> 1 then raise exception 'expected 1 rollup row after re-refresh, got %', v; end if;
  raise notice 'IDEMPOTENCY ASSERTION PASSED';
end $$;
