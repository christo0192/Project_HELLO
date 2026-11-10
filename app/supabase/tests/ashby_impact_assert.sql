-- 0140 (M031 S5): the business-impact read model, run for real.
--
-- Executed by scripts/test-ashby-impact.sh inside scripts/supabase-test.sh's
-- local Supabase stack, against the complete schema (every migration applied;
-- never stubs). Everything runs in ONE transaction that is rolled back at the
-- end, so the fixtures, the switches and the audit rows it writes never
-- outlive the run. Any failed assertion raises and stops psql.
--
-- The fixture is one shared interview plan (the 18 live stages, labelled the
-- way the S2 catalogue refresh labels them) and 22 counted applications that
-- cover: nesting, a re-application by the same person on a second job, a
-- re-screen of the same application, a job transfer, a skipped stage, a
-- backward move, an archive from the Christy stage and one after R1 (the
-- Archived stage sits after Offer in plan order and must never count as
-- reached), provisional and held verdicts, a stuck import with no candidate,
-- browser_primary sessions and their consent, the IST week edge, small n,
-- progress off, a window nobody has read, exclusions, erased and restricted
-- subjects (an erased person whose link was already terminal included),
-- appeal blocks and the candidate list's visibility (D-M031-5). Two blocks at
-- the end add an erasure list check and a job nobody has read yet: each
-- cohort week, job row and verdict row is known on its own reads.
--
-- The clock is pinned: p_now = 2026-11-10 06:30 UTC (12:00 IST, a Tuesday).
-- Ids are md5 tags; names are "Impact fixture <tag>". No real data.

begin;

create schema _impact_tests;
create table _impact_tests.passed (label text primary key);

create function _impact_tests.ok(p_label text, p_ok boolean, p_detail text default '')
returns void language plpgsql as $$
begin
  if p_ok is not true then
    raise exception 'ashby impact FAIL: % (%)', p_label, p_detail;
  end if;
  insert into _impact_tests.passed (label) values (p_label) on conflict do nothing;
end;
$$;

create function _impact_tests.id(p_tag text) returns uuid
language sql immutable as $$ select md5('impact:' || p_tag)::uuid $$;

-- One pipeline step of a summary, by key.
create function _impact_tests.step(p_summary jsonb, p_key text) returns jsonb
language sql immutable as $$
  select s from jsonb_array_elements(p_summary -> 'pipeline') s where s ->> 'step' = p_key
$$;

create function _impact_tests.verdict_row(p_summary jsonb, p_verdict text) returns jsonb
language sql immutable as $$
  select r from jsonb_array_elements(p_summary -> 'verdictOutcomes' -> 'rows') r where r ->> 'verdict' = p_verdict
$$;

create function _impact_tests.timing(p_summary jsonb, p_key text) returns jsonb
language sql immutable as $$
  select t from jsonb_array_elements(p_summary -> 'timings') t where t ->> 'key' = p_key
$$;

create function _impact_tests.summary(
  p_from date, p_to date, p_job uuid default null, p_enabled boolean default true
) returns jsonb language plpgsql as $$
declare r jsonb;
begin
  r := screening_v2.impact_summary(p_from, p_to, p_job, p_enabled, timestamptz '2026-11-10 06:30:00+00');
  if r ->> 'status' <> 'ok' then raise exception 'impact_summary refused: %', r; end if;
  return r -> 'summary';
end;
$$;

create function _impact_tests.list(
  p_step text, p_verdict text, p_outcome text, p_leave text, p_dropped boolean,
  p_scope text, p_owner uuid, p_page integer default 1, p_size integer default 100,
  p_enabled boolean default true, p_job uuid default null
) returns jsonb language plpgsql as $$
declare r jsonb;
begin
  r := screening_v2.impact_candidates(date '2026-09-01', date '2026-11-10', p_job, p_step, p_verdict, p_outcome,
                                      p_leave, p_dropped, p_scope, p_owner, p_page, p_size, p_enabled,
                                      timestamptz '2026-11-10 06:30:00+00');
  if r ->> 'status' <> 'ok' then raise exception 'impact_candidates refused: %', r; end if;
  return r;
end;
$$;

-- ── Fixture helpers ──────────────────────────────────────────────────────

create function _impact_tests.cand(p_tag text, p_role uuid, p_owner uuid) returns uuid
language plpgsql as $$
begin
  insert into screening_v2.candidates (id, role_id, name, owner_id, status)
  values (_impact_tests.id('cand:' || p_tag), p_role, 'Impact fixture ' || p_tag, p_owner, 'screened');
  return _impact_tests.id('cand:' || p_tag);
end;
$$;

create function _impact_tests.link(
  p_tag text, p_map uuid, p_cand uuid, p_imported timestamptz, p_session uuid default null
) returns uuid language plpgsql as $$
begin
  insert into screening_v2.ashby_application_links
    (id, external_application_id, external_job_id, external_stage_id, job_mapping_id, candidate_id, session_id, created_at)
  select _impact_tests.id('link:' || p_tag), 'imp-app-' || p_tag, m.external_job_id, 'imp-stage-05-christy',
         m.id, p_cand, p_session, p_imported
    from screening_v2.ashby_job_mappings m where m.id = p_map;
  return _impact_tests.id('link:' || p_tag);
end;
$$;

-- One phone cycle on an application: a session, an engagement, one attempt at
-- p_called (answered or not) and, with consent, the session plan a minute later.
create function _impact_tests.phone(
  p_tag text, p_link uuid, p_cand uuid, p_role uuid, p_called timestamptz,
  p_answered boolean, p_consent boolean, p_cycle integer default 1, p_terminal boolean default false
) returns uuid language plpgsql as $$
declare
  v_sess uuid := _impact_tests.id('sess:' || p_tag);
  v_eng  uuid := _impact_tests.id('eng:' || p_tag);
begin
  insert into screening_v2.call_sessions (id, candidate_id, role_id, mode, provider, external_call_id, status)
  values (v_sess, p_cand, p_role, 'live', 'livekit', 'phone-' || v_sess::text, 'created');
  insert into screening_v2.phone_engagements
    (id, application_link_id, candidate_id, role_id, state, session_id, cycle_number, terminal_at)
  values (v_eng, p_link, p_cand, p_role, case when p_terminal then 'completed' else 'in_call' end, v_sess, p_cycle,
          case when p_terminal then p_called + interval '1 hour' end);
  insert into screening_v2.phone_call_attempts
    (engagement_id, attempt_seq, epoch, kind, state, outcome_class, ist_date, prior_engagement_state,
     session_id, admitted_at, answered_at, ended_at)
  values (v_eng, 1, 0, 'initial', 'ended', case when p_answered then 'completed' else 'no_answer' end,
          (p_called at time zone 'Asia/Kolkata')::date, 'eligible', v_sess, p_called,
          case when p_answered then p_called + interval '20 seconds' end, p_called + interval '10 minutes');
  if p_consent then
    insert into screening_v2.phone_session_plans (session_id, engagement_id, role_id, source, questions, question_count, created_at)
    select v_sess, v_eng, p_role, 'default', q, jsonb_array_length(q), p_called + interval '1 minute'
      from (select screening_v2.phone_default_question_plan() as q) s;
  end if;
  return v_sess;
end;
$$;

-- A browser session on an application: created, and started (waiting) at p_joined when given.
create function _impact_tests.browser_session(p_tag text, p_cand uuid, p_role uuid, p_joined timestamptz)
returns uuid language plpgsql as $$
declare v_sess uuid := _impact_tests.id('sess:' || p_tag);
begin
  insert into screening_v2.call_sessions (id, candidate_id, role_id, mode, provider, external_call_id, status)
  values (v_sess, p_cand, p_role, 'browser', 'livekit', 'screening-' || v_sess::text, 'created');
  if p_joined is not null then
    update screening_v2.call_sessions set status = 'waiting', waiting_at = p_joined where id = v_sess;
  end if;
  return v_sess;
end;
$$;

create function _impact_tests.consent(p_tag text, p_cand uuid, p_session uuid, p_at timestamptz)
returns void language plpgsql as $$
begin
  insert into screening_v2.consent_records
    (id, candidate_id, source, version, consents, status, proof, classification_level, created_at)
  values (_impact_tests.id('consent:' || p_tag), p_cand, 'candidate_portal', 'impact-test-v1',
          '{ai_interview,recording,purpose,data_processing,retention,rights}'::screening_v2.consent_type[], 'granted',
          jsonb_build_object('invite_id', _impact_tests.id('invite:' || p_tag), 'session_id', p_session,
                             'captured_at', p_at),
          3, p_at);
end;
$$;

-- An assessment on a session. p_grade 'insufficient' is a thin-evidence result.
create function _impact_tests.assess(
  p_tag text, p_session uuid, p_cand uuid, p_rec text, p_at timestamptz,
  p_status text default 'complete', p_grade text default null, p_source text default 'phone', p_score numeric default 70
) returns void language plpgsql as $$
begin
  insert into screening_v2.assessments
    (id, session_id, candidate_id, source, recommendation, scoring_status, evidence_grade, evidence_reason,
     overall_score, provenance, created_at)
  values (_impact_tests.id('asmt:' || p_tag), p_session, p_cand, p_source, p_rec, p_status, p_grade,
          case p_grade when 'insufficient' then 'partial_thin' when 'decision' then 'complete_call' end,
          p_score,
          '{"schema_version":1,"provider":"deepseek","requestedModel":"deepseek-v4-pro","workload":"scoring","prompt_template_version":"impact-test","timestamp":"2026-10-01T00:00:00Z"}'::jsonb,
          p_at);
end;
$$;

-- What the progress worker would have recorded. p_checked null = seeded, never read.
create function _impact_tests.progress(
  p_link uuid, p_status text, p_stage text, p_checked timestamptz,
  p_reason text default null, p_reason_type text default null, p_archived timestamptz default null,
  p_job text default null, p_next timestamptz default timestamptz '2026-11-10 12:30:00+00'
) returns void language plpgsql as $$
begin
  insert into screening_v2.ashby_application_progress
    (application_link_id, status, current_stage_id, current_job_id, archive_reason_id, archive_reason_type,
     archived_at, last_checked_at, next_check_at)
  values (p_link, p_status, p_stage, coalesce(p_job, (select external_job_id from screening_v2.ashby_application_links where id = p_link)),
          p_reason, p_reason_type, p_archived, p_checked, p_next);
end;
$$;

create function _impact_tests.hist(p_link uuid, p_n integer, p_stage text, p_title text, p_in timestamptz, p_out timestamptz)
returns void language plpgsql as $$
begin
  insert into screening_v2.ashby_application_stage_intervals
    (application_link_id, history_id, stage_id, stage_title_seen, entered_at, left_at, stage_number)
  values (p_link, 'imp-hist-' || p_link::text || '-' || p_n, p_stage, p_title, p_in, p_out, p_n);
end;
$$;

-- ── Isolation: nothing that was here before counts ───────────────────────
insert into screening_v2.ashby_impact_exclusions (job_mapping_id, excluded)
select m.id, true from screening_v2.ashby_job_mappings m
on conflict (job_mapping_id) do update set excluded = true;
delete from screening_v2.ashby_progress_runs;

-- ── The fixture ──────────────────────────────────────────────────────────
do $$
declare
  admin  uuid := _impact_tests.id('user:admin');
  i1     uuid := _impact_tests.id('user:i1');
  i2     uuid := _impact_tests.id('user:i2');
  role_a uuid := _impact_tests.id('role:a');
  role_b uuid := _impact_tests.id('role:b');
  role_c uuid := _impact_tests.id('role:c');
  role_d uuid := _impact_tests.id('role:d');
  role_e uuid := _impact_tests.id('role:e');
  role_f uuid := _impact_tests.id('role:f');
  map_a  uuid := _impact_tests.id('map:a');
  map_b  uuid := _impact_tests.id('map:b');
  map_c  uuid := _impact_tests.id('map:c');
  map_d  uuid := _impact_tests.id('map:d');
  map_e  uuid := _impact_tests.id('map:e');
  map_f  uuid := _impact_tests.id('map:f');
  c uuid; l uuid; s uuid; s2 uuid; x uuid;
  t timestamptz;
  r jsonb;
begin
  insert into auth.users (id, email) values
    (admin, 'impact-admin@example.test'), (i1, 'impact-i1@example.test'), (i2, 'impact-i2@example.test')
  on conflict (id) do nothing;
  insert into screening_v2.roles (id, title, owner_id) values
    (role_a, 'Sales Program Advisor', admin), (role_b, 'Data Analyst', admin), (role_c, 'Browser Screen Role', admin),
    (role_d, 'Archived Old Role', admin), (role_e, 'Staff Test Role', admin), (role_f, 'Archived Kept Role', admin);
  insert into screening_v2.ashby_job_mappings
    (id, external_job_id, role_id, owner_id, ai_screening_stage_id, ta_screening_stage_id, status, delivery_mode,
     screening_mode, archived_at)
  values
    (map_a, 'imp-job-a', role_a, admin, 'imp-stage-05-christy', 'imp-stage-06-ta', 'paused', 'manual', 'phone_primary', null),
    (map_b, 'imp-job-b', role_b, admin, 'imp-stage-05-christy', 'imp-stage-06-ta', 'paused', 'manual', 'phone_primary', null),
    (map_c, 'imp-job-c', role_c, admin, 'imp-stage-05-christy', 'imp-stage-06-ta', 'paused', 'manual', 'browser_primary', null),
    (map_d, 'imp-job-d', role_d, admin, 'imp-stage-05-christy', 'imp-stage-06-ta', 'paused', 'manual', 'phone_primary', timestamptz '2026-10-20 00:00:00+00'),
    (map_e, 'imp-job-e', role_e, admin, 'imp-stage-05-christy', 'imp-stage-06-ta', 'paused', 'manual', 'phone_primary', null),
    (map_f, 'imp-job-f', role_f, admin, 'imp-stage-05-christy', 'imp-stage-06-ta', 'paused', 'manual', 'phone_primary', timestamptz '2026-10-20 00:00:00+00');
  insert into screening_v2.ashby_impact_exclusions (job_mapping_id, excluded) values (map_e, true), (map_f, false);

  -- The catalogue, through S2's own refresh, labelled as stage-catalog.ts defaults them.
  r := screening_v2.refresh_ashby_stage_catalog(jsonb_build_array(
    jsonb_build_object('stage_id','imp-stage-01-lead','interview_plan_id','imp-plan-1','title','New Lead','stage_type','Lead','order_in_plan',0),
    jsonb_build_object('stage_id','imp-stage-02-reached','interview_plan_id','imp-plan-1','title','Reached Out','stage_type','Lead','order_in_plan',1),
    jsonb_build_object('stage_id','imp-stage-03-replied','interview_plan_id','imp-plan-1','title','Replied','stage_type','Lead','order_in_plan',2),
    jsonb_build_object('stage_id','imp-stage-04-review','interview_plan_id','imp-plan-1','title','Application Review','stage_type','PreInterviewScreen','order_in_plan',3),
    jsonb_build_object('stage_id','imp-stage-05-christy','interview_plan_id','imp-plan-1','title','Hello Christy','stage_type','PreInterviewScreen','order_in_plan',4,'default_milestone','christy'),
    jsonb_build_object('stage_id','imp-stage-06-ta','interview_plan_id','imp-plan-1','title','TA Screen','stage_type','PreInterviewScreen','order_in_plan',5),
    jsonb_build_object('stage_id','imp-stage-07-hm','interview_plan_id','imp-plan-1','title','HM Review','stage_type','Active','order_in_plan',6),
    jsonb_build_object('stage_id','imp-stage-08-r0','interview_plan_id','imp-plan-1','title','R0 - Online Assessment','stage_type','Active','order_in_plan',7),
    jsonb_build_object('stage_id','imp-stage-09-r1','interview_plan_id','imp-plan-1','title','R1','stage_type','Active','order_in_plan',8,'default_milestone','r1'),
    jsonb_build_object('stage_id','imp-stage-10-r2','interview_plan_id','imp-plan-1','title','R2','stage_type','Active','order_in_plan',9,'default_milestone','r2'),
    jsonb_build_object('stage_id','imp-stage-11-r3','interview_plan_id','imp-plan-1','title','R3','stage_type','Active','order_in_plan',10,'default_milestone','r3'),
    jsonb_build_object('stage_id','imp-stage-12-r4','interview_plan_id','imp-plan-1','title','R4','stage_type','Active','order_in_plan',11,'default_milestone','r4'),
    jsonb_build_object('stage_id','imp-stage-13-r5','interview_plan_id','imp-plan-1','title','R5','stage_type','Active','order_in_plan',12,'default_milestone','r5'),
    jsonb_build_object('stage_id','imp-stage-14-ref','interview_plan_id','imp-plan-1','title','Reference Check','stage_type','Active','order_in_plan',13,'default_milestone','reference'),
    jsonb_build_object('stage_id','imp-stage-15-docs','interview_plan_id','imp-plan-1','title','Document Submission','stage_type','Active','order_in_plan',14),
    jsonb_build_object('stage_id','imp-stage-16-offer','interview_plan_id','imp-plan-1','title','Offer','stage_type','Offer','order_in_plan',15,'default_milestone','offer'),
    jsonb_build_object('stage_id','imp-stage-17-archived','interview_plan_id','imp-plan-1','title','Archived','stage_type','Archived','order_in_plan',16,'default_milestone','archived'),
    jsonb_build_object('stage_id','imp-stage-18-hired','interview_plan_id','imp-plan-1','title','Hired','stage_type','Hired','order_in_plan',17,'default_milestone','hired')
  ), admin);
  if r ->> 'status' <> 'ok' then raise exception 'catalogue refresh refused: %', r; end if;

  insert into screening_v2.ashby_archive_reasons (reason_id, text, reason_type) values
    ('imp-reason-fit', 'Not a fit', 'RejectedByOrg'),
    ('imp-reason-withdrew', 'Withdrew', 'RejectedByCandidate'),
    ('imp-reason-filled', 'Position filled', 'Other');
  insert into screening_v2.ashby_progress_runs (started_at, finished_at, checked, changed, mode)
  values (timestamptz '2026-11-10 04:55:00+00', timestamptz '2026-11-10 05:00:00+00', 15, 3, 'sweep');

  -- A1: the whole way to Hired. Application Review came BEFORE Christy and counts for nothing.
  t := timestamptz '2026-10-05 04:00:00+00';
  c := _impact_tests.cand('a1', role_a, i1);
  l := _impact_tests.link('a1', map_a, c, t + interval '5 minutes');
  s := _impact_tests.phone('a1', l, c, role_a, t + interval '1 hour', true, true);
  perform _impact_tests.assess('a1', s, c, 'advance', t + interval '2 hours');
  perform _impact_tests.progress(l, 'Hired', 'imp-stage-18-hired', timestamptz '2026-11-10 05:00:00+00');
  perform _impact_tests.hist(l, 0, 'imp-stage-04-review', 'Application Review', t - interval '4 days', t);
  perform _impact_tests.hist(l, 1, 'imp-stage-05-christy', 'Hello Christy', t, t + interval '2 days');
  perform _impact_tests.hist(l, 2, 'imp-stage-06-ta', 'TA Screen', t + interval '2 days', t + interval '4 days');
  perform _impact_tests.hist(l, 3, 'imp-stage-09-r1', 'R1', t + interval '4 days', t + interval '7 days');
  perform _impact_tests.hist(l, 4, 'imp-stage-10-r2', 'R2', t + interval '7 days', t + interval '10 days');
  perform _impact_tests.hist(l, 5, 'imp-stage-16-offer', 'Offer', t + interval '10 days', t + interval '15 days');
  perform _impact_tests.hist(l, 6, 'imp-stage-18-hired', 'Hired', t + interval '15 days', null);

  -- A2: Reject, archived from the Christy stage (RejectedByOrg, "Not a fit").
  t := timestamptz '2026-10-06 04:00:00+00';
  c := _impact_tests.cand('a2', role_a, i1);
  l := _impact_tests.link('a2', map_a, c, t + interval '5 minutes');
  s := _impact_tests.phone('a2', l, c, role_a, t + interval '2 hours', true, true);
  perform _impact_tests.assess('a2', s, c, 'reject', t + interval '3 hours');
  perform _impact_tests.progress(l, 'Archived', 'imp-stage-17-archived', timestamptz '2026-11-10 05:00:00+00',
                                 'imp-reason-fit', 'RejectedByOrg', t + interval '2 days');
  perform _impact_tests.hist(l, 1, 'imp-stage-05-christy', 'Hello Christy', t, t + interval '2 days');
  perform _impact_tests.hist(l, 2, 'imp-stage-17-archived', 'Archived', t + interval '2 days', null);

  -- A3: a provisional Select, still in the Christy stage.
  t := timestamptz '2026-10-20 04:00:00+00';
  c := _impact_tests.cand('a3', role_a, i2);
  l := _impact_tests.link('a3', map_a, c, t + interval '5 minutes');
  s := _impact_tests.phone('a3', l, c, role_a, t + interval '3 hours', true, true);
  perform _impact_tests.assess('a3', s, c, 'advance', t + interval '4 hours', 'incomplete_evidence');
  perform _impact_tests.progress(l, 'Active', 'imp-stage-05-christy', timestamptz '2026-11-10 05:00:00+00');
  perform _impact_tests.hist(l, 1, 'imp-stage-05-christy', 'Hello Christy', t, null);

  -- A4: Held (thin evidence): connected, never scored.
  t := timestamptz '2026-10-21 04:00:00+00';
  c := _impact_tests.cand('a4', role_a, i1);
  l := _impact_tests.link('a4', map_a, c, t + interval '5 minutes');
  s := _impact_tests.phone('a4', l, c, role_a, t + interval '4 hours', true, true);
  perform _impact_tests.assess('a4', s, c, 'hold', t + interval '5 hours', 'complete', 'insufficient');
  perform _impact_tests.progress(l, 'Active', 'imp-stage-05-christy', timestamptz '2026-11-10 05:00:00+00');
  perform _impact_tests.hist(l, 1, 'imp-stage-05-christy', 'Hello Christy', t, null);

  -- A5: called, never answered, then withdrew (archived from the Christy stage).
  t := timestamptz '2026-10-22 04:00:00+00';
  c := _impact_tests.cand('a5', role_a, i2);
  l := _impact_tests.link('a5', map_a, c, t + interval '5 minutes');
  s := _impact_tests.phone('a5', l, c, role_a, t + interval '5 hours', false, false);
  perform _impact_tests.progress(l, 'Archived', 'imp-stage-17-archived', timestamptz '2026-11-10 05:00:00+00',
                                 'imp-reason-withdrew', 'RejectedByCandidate', t + interval '1 day');
  perform _impact_tests.hist(l, 1, 'imp-stage-05-christy', 'Hello Christy', t, t + interval '1 day');
  perform _impact_tests.hist(l, 2, 'imp-stage-17-archived', 'Archived', t + interval '1 day', null);

  -- A6: answered (voicemail), no consent: answered but not connected.
  t := timestamptz '2026-10-22 05:00:00+00';
  c := _impact_tests.cand('a6', role_a, i1);
  l := _impact_tests.link('a6', map_a, c, t + interval '5 minutes');
  s := _impact_tests.phone('a6', l, c, role_a, t + interval '6 hours', true, false);
  perform _impact_tests.progress(l, 'Active', 'imp-stage-05-christy', timestamptz '2026-11-10 05:00:00+00');
  perform _impact_tests.hist(l, 1, 'imp-stage-05-christy', 'Hello Christy', t, null);

  -- A7: a stuck import with no candidate record; its progress row was seeded and never read (stale).
  t := timestamptz '2026-10-23 04:00:00+00';
  l := _impact_tests.link('a7', map_a, null, t);
  perform _impact_tests.progress(l, null, null, null, p_next => t);

  -- A8: Select, then straight from Christy to R2 (skipped TA, HM, R0 and R1).
  t := timestamptz '2026-10-12 04:00:00+00';
  c := _impact_tests.cand('a8', role_a, i1);
  l := _impact_tests.link('a8', map_a, c, t + interval '5 minutes');
  s := _impact_tests.phone('a8', l, c, role_a, t + interval '7 hours', true, true);
  perform _impact_tests.assess('a8', s, c, 'advance', t + interval '8 hours');
  perform _impact_tests.progress(l, 'Active', 'imp-stage-10-r2', timestamptz '2026-11-10 05:00:00+00');
  perform _impact_tests.hist(l, 1, 'imp-stage-05-christy', 'Hello Christy', t, t + interval '2 days');
  perform _impact_tests.hist(l, 2, 'imp-stage-10-r2', 'R2', t + interval '2 days', null);

  -- A9: re-screened (cycle 1 Reject, cycle 2 Select: the newest wins), moved to
  -- TA Screen and back to the Christy stage (a backward move).
  t := timestamptz '2026-10-13 04:00:00+00';
  c := _impact_tests.cand('a9', role_a, i2);
  l := _impact_tests.link('a9', map_a, c, t + interval '5 minutes');
  s := _impact_tests.phone('a9-1', l, c, role_a, t + interval '8 hours', true, true, 1, true);
  perform _impact_tests.assess('a9-1', s, c, 'reject', t + interval '9 hours');
  s2 := _impact_tests.phone('a9-2', l, c, role_a, t + interval '3 days 1 hour', true, true, 2, false);
  perform _impact_tests.assess('a9-2', s2, c, 'advance', t + interval '3 days 2 hours');
  perform _impact_tests.progress(l, 'Active', 'imp-stage-05-christy', timestamptz '2026-11-10 05:00:00+00');
  perform _impact_tests.hist(l, 1, 'imp-stage-05-christy', 'Hello Christy', t, t + interval '2 days');
  perform _impact_tests.hist(l, 2, 'imp-stage-06-ta', 'TA Screen', t + interval '2 days', t + interval '3 days');
  perform _impact_tests.hist(l, 3, 'imp-stage-05-christy', 'Hello Christy', t + interval '3 days', null);

  -- A10: Borderline, R1, then archived (the Archived stage sits after Offer and must not count).
  t := timestamptz '2026-10-01 04:00:00+00';
  c := _impact_tests.cand('a10', role_a, i1);
  l := _impact_tests.link('a10', map_a, c, t + interval '5 minutes');
  s := _impact_tests.phone('a10', l, c, role_a, t + interval '9 hours', true, true);
  perform _impact_tests.assess('a10', s, c, 'hold', t + interval '10 hours');
  perform _impact_tests.progress(l, 'Archived', 'imp-stage-17-archived', timestamptz '2026-11-10 05:00:00+00',
                                 'imp-reason-filled', 'Other', t + interval '5 days');
  perform _impact_tests.hist(l, 1, 'imp-stage-05-christy', 'Hello Christy', t, t + interval '2 days');
  perform _impact_tests.hist(l, 2, 'imp-stage-09-r1', 'R1', t + interval '2 days', t + interval '5 days');
  perform _impact_tests.hist(l, 3, 'imp-stage-17-archived', 'Archived', t + interval '5 days', null);

  -- A11: Select, transferred to another job, into a stage HELLO's catalogue does not know.
  t := timestamptz '2026-10-02 04:00:00+00';
  c := _impact_tests.cand('a11', role_a, i2);
  l := _impact_tests.link('a11', map_a, c, t + interval '5 minutes');
  s := _impact_tests.phone('a11', l, c, role_a, t + interval '10 hours', true, true);
  perform _impact_tests.assess('a11', s, c, 'advance', t + interval '11 hours');
  perform _impact_tests.progress(l, 'Active', 'imp-other-stage', timestamptz '2026-11-10 05:00:00+00', p_job => 'imp-job-other');
  perform _impact_tests.hist(l, 1, 'imp-stage-05-christy', 'Hello Christy', t, t + interval '2 days');
  perform _impact_tests.hist(l, 2, 'imp-other-stage', 'Other team screen', t + interval '2 days', null);

  -- A12 and B1: ONE person on two jobs. A12 is a Reject; B1 (newer) a Select.
  x := _impact_tests.cand('ax', role_a, i1);
  t := timestamptz '2026-10-07 04:00:00+00';
  l := _impact_tests.link('a12', map_a, x, t + interval '5 minutes');
  s := _impact_tests.phone('a12', l, x, role_a, t + interval '11 hours', true, true);
  perform _impact_tests.assess('a12', s, x, 'reject', t + interval '12 hours');
  perform _impact_tests.progress(l, 'Active', 'imp-stage-05-christy', timestamptz '2026-11-10 05:00:00+00');
  perform _impact_tests.hist(l, 1, 'imp-stage-05-christy', 'Hello Christy', t, null);
  t := timestamptz '2026-10-08 04:00:00+00';
  l := _impact_tests.link('b1', map_b, x, t + interval '5 minutes');
  s := _impact_tests.phone('b1', l, x, role_b, t + interval '13 hours', true, true);
  perform _impact_tests.assess('b1', s, x, 'advance', t + interval '14 hours');
  perform _impact_tests.progress(l, 'Active', 'imp-stage-09-r1', timestamptz '2026-11-10 05:00:00+00');
  perform _impact_tests.hist(l, 1, 'imp-stage-05-christy', 'Hello Christy', t, t + interval '1 day');
  perform _impact_tests.hist(l, 2, 'imp-stage-09-r1', 'R1', t + interval '1 day', null);

  -- A13 / A14: the IST week edge, from the import time (no history read).
  -- 2026-11-01 18:29 UTC = Sunday 23:59 IST (week of 26 Oct);
  -- 2026-11-01 18:31 UTC = Monday 00:01 IST (week of 2 Nov).
  c := _impact_tests.cand('a13', role_a, i1);
  perform _impact_tests.link('a13', map_a, c, timestamptz '2026-11-01 18:29:00+00');
  c := _impact_tests.cand('a14', role_a, i1);
  perform _impact_tests.link('a14', map_a, c, timestamptz '2026-11-01 18:31:00+00');

  -- A15: a restriction request is pending: never counted. A16: erased: never counted.
  c := _impact_tests.cand('a15', role_a, i1);
  l := _impact_tests.link('a15', map_a, c, timestamptz '2026-10-15 04:00:00+00');
  insert into screening_v2.data_subject_requests (candidate_id, request_type, request_status, requested_by)
  values (c, 'restrict', 'pending', admin);
  l := _impact_tests.link('a16', map_a, null, timestamptz '2026-10-15 05:00:00+00');
  update screening_v2.ashby_application_links set terminal_state = 'deleted', terminal_reason = 'subject_erasure' where id = l;

  -- Z1 and Z1B: one person, erased. Z1 was ALREADY terminal (withdrawn in Ashby
  -- before Christy called) and Ashby has been read for it; Z1B is the same
  -- person's live application on job B. lib/dsar.ts terminates only the live
  -- link, lists EVERY link of the person, then deletes the candidate: the
  -- request row goes with the candidate (ON DELETE CASCADE) and both links lose
  -- their candidate_id, so nothing but the list says Z1 is an erased subject's.
  t := timestamptz '2026-10-16 04:00:00+00';
  c := _impact_tests.cand('z1', role_a, i1);
  l := _impact_tests.link('z1', map_a, c, t + interval '5 minutes');
  update screening_v2.ashby_application_links
     set terminal_state = 'withdrawn', terminal_reason = 'ashby_application_archived' where id = l;
  perform _impact_tests.progress(l, 'Archived', 'imp-stage-17-archived', timestamptz '2026-11-10 05:00:00+00',
                                 'imp-reason-withdrew', 'RejectedByCandidate', t + interval '1 day');
  perform _impact_tests.hist(l, 1, 'imp-stage-05-christy', 'Hello Christy', t, t + interval '1 day');
  perform _impact_tests.hist(l, 2, 'imp-stage-17-archived', 'Archived', t + interval '1 day', null);
  l := _impact_tests.link('z1b', map_b, c, t + interval '1 hour');
  perform _impact_tests.progress(l, 'Active', 'imp-stage-05-christy', timestamptz '2026-11-10 05:00:00+00');
  perform _impact_tests.hist(l, 1, 'imp-stage-05-christy', 'Hello Christy', t + interval '1 hour', null);
  insert into screening_v2.data_subject_requests (candidate_id, request_type, request_status, requested_by)
  values (c, 'delete', 'pending', admin);
  -- lib/dsar.ts's order: terminate the live links, list every link, delete the candidate.
  update screening_v2.ashby_application_links set terminal_state = 'deleted', terminal_reason = 'subject_erasure'
   where candidate_id = c and terminal_state is null;
  r := screening_v2.mark_ashby_application_links_erased(c);
  if r is distinct from '{"status": "ok", "listed": 2, "added": 2}'::jsonb then
    raise exception 'erasure list refused: %', r;
  end if;
  delete from screening_v2.candidates where id = c;

  -- A17: an appeal-blocked Select, still in the Christy stage.
  t := timestamptz '2026-10-09 04:00:00+00';
  c := _impact_tests.cand('a17', role_a, i1);
  update screening_v2.candidates set decision_use_blocked_at = timestamptz '2026-10-20 00:00:00+00' where id = c;
  l := _impact_tests.link('a17', map_a, c, t + interval '5 minutes');
  s := _impact_tests.phone('a17', l, c, role_a, t + interval '12 hours', true, true);
  perform _impact_tests.assess('a17', s, c, 'advance', t + interval '13 hours');
  perform _impact_tests.progress(l, 'Active', 'imp-stage-05-christy', timestamptz '2026-11-10 05:00:00+00');
  perform _impact_tests.hist(l, 1, 'imp-stage-05-christy', 'Hello Christy', t, null);

  -- A18: archived from the Christy stage with no reason, never called.
  t := timestamptz '2026-10-03 04:00:00+00';
  c := _impact_tests.cand('a18', role_a, i2);
  l := _impact_tests.link('a18', map_a, c, t + interval '5 minutes');
  perform _impact_tests.progress(l, 'Archived', 'imp-stage-17-archived', timestamptz '2026-11-10 05:00:00+00',
                                 null, null, t + interval '1 day');
  perform _impact_tests.hist(l, 1, 'imp-stage-05-christy', 'Hello Christy', t, t + interval '1 day');
  perform _impact_tests.hist(l, 2, 'imp-stage-17-archived', 'Archived', t + interval '1 day', null);

  -- browser_primary (mapping C): C1 started and consented on its own session; C2 started,
  -- no consent; C3 consented, never started; C4 started, consent bound to another session.
  t := timestamptz '2026-10-10 04:00:00+00';
  c := _impact_tests.cand('c1', role_c, i2);
  s := _impact_tests.browser_session('c1', c, role_c, t + interval '14 hours');
  l := _impact_tests.link('c1', map_c, c, t + interval '5 minutes', s);
  perform _impact_tests.consent('c1', c, s, t + interval '13 hours 59 minutes');
  perform _impact_tests.assess('c1', s, c, 'advance', t + interval '15 hours', p_source => 'browser');
  perform _impact_tests.progress(l, 'Active', 'imp-stage-05-christy', timestamptz '2026-11-10 05:00:00+00');
  perform _impact_tests.hist(l, 1, 'imp-stage-05-christy', 'Hello Christy', t, null);
  t := timestamptz '2026-10-11 04:00:00+00';
  c := _impact_tests.cand('c2', role_c, i2);
  s := _impact_tests.browser_session('c2', c, role_c, t + interval '15 hours');
  perform _impact_tests.link('c2', map_c, c, t, s);
  c := _impact_tests.cand('c3', role_c, i2);
  s := _impact_tests.browser_session('c3', c, role_c, null);
  perform _impact_tests.link('c3', map_c, c, t + interval '3 hours', s);
  perform _impact_tests.consent('c3', c, s, t + interval '4 hours');
  t := timestamptz '2026-10-11 05:00:00+00';
  c := _impact_tests.cand('c4', role_c, i2);
  s := _impact_tests.browser_session('c4', c, role_c, t + interval '16 hours');
  perform _impact_tests.link('c4', map_c, c, t, s);
  perform _impact_tests.consent('c4', c, _impact_tests.id('sess:some-other-session'), t + interval '15 hours');

  -- D1: archived mapping, the default: never counted. E1: excluded: never counted.
  c := _impact_tests.cand('d1', role_d, i1);
  perform _impact_tests.link('d1', map_d, c, timestamptz '2026-10-05 04:00:00+00');
  c := _impact_tests.cand('e1', role_e, i1);
  perform _impact_tests.link('e1', map_e, c, timestamptz '2026-10-05 04:00:00+00');
  -- F1: an archived mapping an admin chose to keep: counted.
  c := _impact_tests.cand('f1', role_f, i1);
  perform _impact_tests.link('f1', map_f, c, timestamptz '2026-10-15 04:00:00+00');
end $$;

-- ── The view: one row per counted application ────────────────────────────
do $$
declare
  n integer;
  v record;
begin
  select count(*) into n from screening_v2.v_ashby_application_impact i
    join screening_v2.ashby_application_links l on l.id = i.application_link_id
   where l.external_application_id like 'imp-app-%';
  -- 28 links on mappings, less the restricted (A15) and the erased (A16, Z1, Z1B) subjects.
  perform _impact_tests.ok('0140 view: erased and restricted subjects are not in the view at all', n = 24, n::text);
  perform _impact_tests.ok('0140 view: an erased subject whose link was already terminal is in no row, nor their other application',
    not exists (select 1 from screening_v2.v_ashby_application_impact i
                 where i.application_link_id in (_impact_tests.id('link:z1'), _impact_tests.id('link:z1b'))), 'z1');
  select count(*) into n from screening_v2.v_ashby_application_impact i
    join screening_v2.ashby_application_links l on l.id = i.application_link_id
   where l.external_application_id like 'imp-app-%' and i.in_impact;
  perform _impact_tests.ok('0140 view: archived (D) and excluded (E) mappings are left out, a kept archived one (F) counts', n = 22, n::text);

  select * into v from screening_v2.v_ashby_application_impact where application_link_id = _impact_tests.id('link:a12');
  perform _impact_tests.ok('0140 view: a re-application keeps its OWN verdict (not the same person''s newer Select)',
    v.verdict = 'reject', v.verdict);
  select * into v from screening_v2.v_ashby_application_impact where application_link_id = _impact_tests.id('link:b1');
  perform _impact_tests.ok('0140 view: the same person''s other application has its own verdict', v.verdict = 'select', v.verdict);
  select * into v from screening_v2.v_ashby_application_impact where application_link_id = _impact_tests.id('link:a9');
  perform _impact_tests.ok('0140 view: a re-screen of the same application takes the newest verdict', v.verdict = 'select', v.verdict);
  perform _impact_tests.ok('0140 view: a backward move still counts as moved forward, and the application is back in Christy',
    v.moved_forward and v.still_christy and v.decided and not v.reached_r1, row_to_json(v)::text);
  select * into v from screening_v2.v_ashby_application_impact where application_link_id = _impact_tests.id('link:a17');
  perform _impact_tests.ok('0140 view: an appeal block is carried as a flag, and only as a flag', v.decision_blocked and v.verdict = 'select', row_to_json(v)::text);
  select * into v from screening_v2.v_ashby_application_impact where application_link_id = _impact_tests.id('link:a1');
  perform _impact_tests.ok('0140 view: no appeal block, no flag', not v.decision_blocked, row_to_json(v)::text);
  select * into v from screening_v2.v_ashby_application_impact where application_link_id = _impact_tests.id('link:a3');
  perform _impact_tests.ok('0140 view: a provisional verdict counts under its verdict, marked', v.verdict = 'select' and v.provisional, row_to_json(v)::text);
  select * into v from screening_v2.v_ashby_application_impact where application_link_id = _impact_tests.id('link:a4');
  perform _impact_tests.ok('0140 view: thin evidence is held, never a verdict', v.verdict = 'held' and not v.provisional, v.verdict);
  select * into v from screening_v2.v_ashby_application_impact where application_link_id = _impact_tests.id('link:a1');
  perform _impact_tests.ok('0140 view: came in at the first Christy entry, not before (Application Review is earlier)',
    v.came_in_at = timestamptz '2026-10-05 04:00:00+00' and v.came_in_from_history and v.cohort_day = date '2026-10-05', row_to_json(v)::text);
  perform _impact_tests.ok('0140 view: a hired application reached every milestone with its first-reached times',
    v.reached_hired and v.reached_offer and v.reached_r2 and v.reached_r1 and v.moved_forward
    and v.r1_at = timestamptz '2026-10-09 04:00:00+00' and v.r2_at = timestamptz '2026-10-12 04:00:00+00'
    and v.offer_at = timestamptz '2026-10-15 04:00:00+00' and v.hired_at = timestamptz '2026-10-20 04:00:00+00'
    and v.decided_at = timestamptz '2026-10-07 04:00:00+00' and v.current_milestone = 'hired' and v.status = 'Hired', row_to_json(v)::text);
  select * into v from screening_v2.v_ashby_application_impact where application_link_id = _impact_tests.id('link:a10');
  perform _impact_tests.ok('0140 view: an Archived stage late in the plan never counts as reaching Offer or R2',
    v.reached_r1 and not v.reached_r2 and not v.reached_offer and not v.reached_hired and v.archived
    and v.leave_stage_id = 'imp-stage-09-r1' and v.leave_milestone = 'r1' and v.archive_reason_type = 'other'
    and v.archive_reason_text = 'Position filled', row_to_json(v)::text);
  select * into v from screening_v2.v_ashby_application_impact where application_link_id = _impact_tests.id('link:a8');
  perform _impact_tests.ok('0140 view: a skipped stage still reaches R1 and R2, both first reached when R2 was',
    v.reached_r1 and v.reached_r2 and not v.reached_offer and v.r1_at = v.r2_at and v.current_stage_title = 'R2', row_to_json(v)::text);
  select * into v from screening_v2.v_ashby_application_impact where application_link_id = _impact_tests.id('link:a11');
  perform _impact_tests.ok('0140 view: a job transfer counts under the job it came from, decided, not forward, transferred out',
    v.job_mapping_id = _impact_tests.id('map:a') and v.decided and not v.moved_forward and v.transferred_out
    and v.current_stage_title = 'Other team screen', row_to_json(v)::text);
  select * into v from screening_v2.v_ashby_application_impact where application_link_id = _impact_tests.id('link:a2');
  perform _impact_tests.ok('0140 view: archived from the Christy stage: decided, not forward, left from Christy, Ashby''s reason text',
    v.archived_christy and v.decided and not v.moved_forward and v.archive_reason_type = 'rejected_by_org'
    and v.archive_reason_text = 'Not a fit' and v.leave_stage_title = 'Hello Christy', row_to_json(v)::text);
  select * into v from screening_v2.v_ashby_application_impact where application_link_id = _impact_tests.id('link:a18');
  perform _impact_tests.ok('0140 view: an archive with no reason reads as none', v.archive_reason_type = 'none' and v.archived_christy, row_to_json(v)::text);
  select * into v from screening_v2.v_ashby_application_impact where application_link_id = _impact_tests.id('link:a6');
  perform _impact_tests.ok('0140 view: an answered call without consent is answered, not connected', v.called and v.answered and not v.connected, row_to_json(v)::text);
  select * into v from screening_v2.v_ashby_application_impact where application_link_id = _impact_tests.id('link:a7');
  perform _impact_tests.ok('0140 view: a stuck import with no candidate came in at its import time, and nothing about Ashby is known',
    v.candidate_id is null and not v.came_in_from_history and v.came_in_at = timestamptz '2026-10-23 04:00:00+00'
    and not v.ashby_known and v.status is null and not v.decided and not v.called, row_to_json(v)::text);
  select * into v from screening_v2.v_ashby_application_impact where application_link_id = _impact_tests.id('link:a13');
  perform _impact_tests.ok('0140 view: 23:59 IST on a Sunday is that Sunday''s cohort day', v.cohort_day = date '2026-11-01', v.cohort_day::text);
  select * into v from screening_v2.v_ashby_application_impact where application_link_id = _impact_tests.id('link:a14');
  perform _impact_tests.ok('0140 view: 00:01 IST on the Monday is the Monday''s cohort day', v.cohort_day = date '2026-11-02', v.cohort_day::text);
  select * into v from screening_v2.v_ashby_application_impact where application_link_id = _impact_tests.id('link:c1');
  perform _impact_tests.ok('0140 view: browser_primary: a started session with consent bound to it is called and connected',
    v.called and v.connected and v.answered and v.verdict = 'select'
    and v.called_at = timestamptz '2026-10-10 18:00:00+00' and v.connected_at = timestamptz '2026-10-10 18:00:00+00', row_to_json(v)::text);
  select * into v from screening_v2.v_ashby_application_impact where application_link_id = _impact_tests.id('link:c2');
  perform _impact_tests.ok('0140 view: browser_primary: a started session without consent is called, not connected', v.called and not v.connected, row_to_json(v)::text);
  select * into v from screening_v2.v_ashby_application_impact where application_link_id = _impact_tests.id('link:c3');
  perform _impact_tests.ok('0140 view: browser_primary: consent on a session never started is neither called nor connected', not v.called and not v.connected, row_to_json(v)::text);
  select * into v from screening_v2.v_ashby_application_impact where application_link_id = _impact_tests.id('link:c4');
  perform _impact_tests.ok('0140 view: browser_primary: consent given for another session never counts', v.called and not v.connected, row_to_json(v)::text);
end $$;

-- ── impact_summary: progress on, the whole window ─────────────────────────
do $$
declare
  s jsonb := _impact_tests.summary(date '2026-09-01', date '2026-11-10');
  st jsonb;
  prev integer := null;
  expected_reached integer[] := array[22, 16, 12, 11, 7, 5, 4, 2, 1, 1];
  expected_still integer[] := array[0, 1, 1, 4, null, 1, 1, 1, 0, null];
  expected_dropped integer[] := array[1, 1, 0, 0, 1, 0, 1, 0, 0, null];
  keys text[] := array['came_in','called','connected','scored','decided','moved_forward','r1','r2','offer','hired'];
  i integer;
  row jsonb;
begin
  perform _impact_tests.ok('0140 summary: meta.progressEnabled, coverage of the window, stale rows, last pass, minTimingN',
    (s -> 'meta' ->> 'progressEnabled')::boolean
    and (s -> 'meta' -> 'coverage' ->> 'checked')::int = 15 and (s -> 'meta' -> 'coverage' ->> 'total')::int = 22
    and (s -> 'meta' ->> 'staleRows')::int = 1
    and (s -> 'meta' ->> 'lastPassAt')::timestamptz = timestamptz '2026-11-10 05:00:00+00'
    and (s -> 'meta' ->> 'minTimingN')::int = 5 and s -> 'meta' ->> 'timezone' = 'Asia/Kolkata', (s -> 'meta')::text);
  perform _impact_tests.ok('0140 summary: unlabelled stages are the plan''s after Christy plus one seen only in history',
    (s -> 'meta' ->> 'unlabelledStages')::int = 5 and not (s -> 'meta' ->> 'labelsConfigured')::boolean, (s -> 'meta')::text);
  perform _impact_tests.ok('0140 summary: filters echo the window and list only the counted jobs',
    s -> 'filters' ->> 'from' = '2026-09-01' and s -> 'filters' ->> 'to' = '2026-11-10' and s -> 'filters' -> 'job' = 'null'::jsonb
    and jsonb_array_length(s -> 'filters' -> 'jobs') = 4
    and (select array_agg(j ->> 'label' order by ord) from jsonb_array_elements(s -> 'filters' -> 'jobs') with ordinality as x(j, ord))
        = array['Archived Kept Role', 'Browser Screen Role', 'Data Analyst', 'Sales Program Advisor'], (s -> 'filters')::text);

  for i in 1..10 loop
    st := _impact_tests.step(s, keys[i]);
    perform _impact_tests.ok('0140 summary: pipeline ' || keys[i] || ' reached', (st ->> 'reached')::int = expected_reached[i], st::text);
    perform _impact_tests.ok('0140 summary: pipeline ' || keys[i] || ' still here',
      (st -> 'stillHere') = coalesce(to_jsonb(expected_still[i]), 'null'::jsonb), st::text);
    perform _impact_tests.ok('0140 summary: pipeline ' || keys[i] || ' dropped here',
      (st -> 'droppedHere') = coalesce(to_jsonb(expected_dropped[i]), 'null'::jsonb), st::text);
    -- Nesting: never more than the step before, and no share is ever over 1.
    perform _impact_tests.ok('0140 summary: ' || keys[i] || ' nests under the step before it',
      prev is null or (st ->> 'reached')::int <= prev, st::text);
    perform _impact_tests.ok('0140 summary: ' || keys[i] || ' has no share over 100%',
      coalesce((st ->> 'ofPrevious')::numeric, 0) <= 1 and coalesce((st ->> 'ofCameIn')::numeric, 0) <= 1, st::text);
    prev := (st ->> 'reached')::int;
  end loop;
  perform _impact_tests.ok('0140 summary: shares are the nested fractions, rounded to 3 places',
    _impact_tests.step(s, 'came_in') -> 'ofPrevious' = 'null'::jsonb and (_impact_tests.step(s, 'came_in') ->> 'ofCameIn')::numeric = 1
    and (_impact_tests.step(s, 'called') ->> 'ofPrevious')::numeric = 0.727
    and (_impact_tests.step(s, 'connected') ->> 'ofPrevious')::numeric = 0.75
    and (_impact_tests.step(s, 'scored') ->> 'ofPrevious')::numeric = 0.917
    and (_impact_tests.step(s, 'decided') ->> 'ofPrevious')::numeric = 0.636
    and (_impact_tests.step(s, 'hired') ->> 'ofPrevious')::numeric = 1
    and (_impact_tests.step(s, 'hired') ->> 'ofCameIn')::numeric = 0.045, s -> 'pipeline' #>> '{}');
  perform _impact_tests.ok('0140 summary: the connected step carries Call answered (voicemail included) underneath',
    _impact_tests.step(s, 'connected') -> 'sub' = '{"label": "Call answered", "reached": 15}'::jsonb, _impact_tests.step(s, 'connected')::text);
  perform _impact_tests.ok('0140 summary: the steps come in the contract''s order with its labels',
    (select array_agg(p ->> 'step' order by ord) from jsonb_array_elements(s -> 'pipeline') with ordinality as x(p, ord)) = keys
    and _impact_tests.step(s, 'decided') ->> 'label' = 'A person decided in Ashby'
    and _impact_tests.step(s, 'moved_forward') ->> 'label' = 'Moved forward in Ashby', s -> 'pipeline' #>> '{}');

  -- The verdict table: the connected applications, partitioned by their own verdict.
  row := _impact_tests.verdict_row(s, 'select');
  -- Eight connected Selects, less A17, whose appeal blocks decision use: its verdict is suppressed.
  perform _impact_tests.ok('0140 summary: Select row (provisional included, the appeal-blocked one left out)', (row ->> 'total')::int = 7
    and row -> 'cells' = '{"still_christy": 3, "archived_christy": 0, "moved_forward": 4, "r1": 3, "r2": 2, "offer": 1, "hired": 1, "active": 6}'::jsonb, row::text);
  row := _impact_tests.verdict_row(s, 'borderline');
  perform _impact_tests.ok('0140 summary: Borderline row', (row ->> 'total')::int = 1
    and row -> 'cells' = '{"still_christy": 0, "archived_christy": 0, "moved_forward": 1, "r1": 1, "r2": 0, "offer": 0, "hired": 0, "active": 0}'::jsonb, row::text);
  row := _impact_tests.verdict_row(s, 'reject');
  perform _impact_tests.ok('0140 summary: Reject row', (row ->> 'total')::int = 2
    and row -> 'cells' = '{"still_christy": 1, "archived_christy": 1, "moved_forward": 0, "r1": 0, "r2": 0, "offer": 0, "hired": 0, "active": 1}'::jsonb, row::text);
  row := _impact_tests.verdict_row(s, 'held');
  perform _impact_tests.ok('0140 summary: Held row', (row ->> 'total')::int = 1 and row ->> 'label' = 'Held (thin evidence)'
    and row -> 'cells' = '{"still_christy": 1, "archived_christy": 0, "moved_forward": 0, "r1": 0, "r2": 0, "offer": 0, "hired": 0, "active": 1}'::jsonb, row::text);
  row := _impact_tests.verdict_row(s, 'none');
  -- An empty row has nothing unread: it follows the window (read), so its cells are 0.
  perform _impact_tests.ok('0140 summary: No verdict row: empty, so its cells follow the window and are 0',
    (row ->> 'total')::int = 0
    and row -> 'cells' = '{"still_christy": 0, "archived_christy": 0, "moved_forward": 0, "r1": 0, "r2": 0, "offer": 0, "hired": 0, "active": 0}'::jsonb,
    row::text);
  perform _impact_tests.ok('0140 summary: the verdict rows add up to the connected step, and Select+Borderline+Reject to scored, each less the appeal-blocked one',
    (select sum((r ->> 'total')::int) from jsonb_array_elements(s -> 'verdictOutcomes' -> 'rows') r) = 12 - 1
    and (select sum((r ->> 'total')::int) from jsonb_array_elements(s -> 'verdictOutcomes' -> 'rows') r
          where r ->> 'verdict' in ('select', 'borderline', 'reject')) = 11 - 1, s -> 'verdictOutcomes' #>> '{}');
  perform _impact_tests.ok('0140 summary: the verdict columns are the contract''s eight',
    (select array_agg(c ->> 'key' order by ord) from jsonb_array_elements(s -> 'verdictOutcomes' -> 'columns') with ordinality as x(c, ord))
      = array['still_christy','archived_christy','moved_forward','r1','r2','offer','hired','active'], s -> 'verdictOutcomes' #>> '{}');

  -- Where candidates leave: by the last stage before the Archived one, Ashby's reasons only.
  perform _impact_tests.ok('0140 summary: leaves, by stage in plan order, reason types and the catalogue''s top reasons',
    s -> 'leaves' = jsonb_build_array(
      jsonb_build_object('stageId', 'imp-stage-05-christy', 'stageTitle', 'Hello Christy', 'milestone', 'christy', 'archived', 3,
        'byReasonType', jsonb_build_object('rejected_by_org', 1, 'rejected_by_candidate', 1, 'other', 0, 'none', 1),
        'topReasons', jsonb_build_array(jsonb_build_object('text', 'Not a fit', 'count', 1), jsonb_build_object('text', 'Withdrew', 'count', 1))),
      jsonb_build_object('stageId', 'imp-stage-09-r1', 'stageTitle', 'R1', 'milestone', 'r1', 'archived', 1,
        'byReasonType', jsonb_build_object('rejected_by_org', 0, 'rejected_by_candidate', 0, 'other', 1, 'none', 0),
        'topReasons', jsonb_build_array(jsonb_build_object('text', 'Position filled', 'count', 1)))), s -> 'leaves' #>> '{}');

  -- Timings: completed steps only; median and p90 only from n 5.
  perform _impact_tests.ok('0140 summary: Christy stage to first call over 16 calls (1..16 hours): median 0.35, p90 0.6',
    _impact_tests.timing(s, 'entry_to_first_call') = '{"key": "entry_to_first_call", "label": "Christy stage to first call", "medianDays": 0.35, "p90Days": 0.6, "n": 16}'::jsonb,
    _impact_tests.timing(s, 'entry_to_first_call')::text);
  perform _impact_tests.ok('0140 summary: Christy stage to verdict over the 11 scored',
    (_impact_tests.timing(s, 'entry_to_verdict') ->> 'n')::int = 11 and _impact_tests.timing(s, 'entry_to_verdict') ->> 'medianDays' is not null,
    _impact_tests.timing(s, 'entry_to_verdict')::text);
  perform _impact_tests.ok('0140 summary: verdict to a decision leaves out the re-screen decided before its newest verdict (n 6)',
    (_impact_tests.timing(s, 'verdict_to_decision') ->> 'n')::int = 6 and _impact_tests.timing(s, 'verdict_to_decision') ->> 'medianDays' is not null,
    _impact_tests.timing(s, 'verdict_to_decision')::text);
  perform _impact_tests.ok('0140 summary: under n 5 the median and p90 are null and n is still given',
    _impact_tests.timing(s, 'christy_to_r1') = '{"key": "christy_to_r1", "label": "Christy stage to R1", "medianDays": null, "p90Days": null, "n": 4}'::jsonb
    and _impact_tests.timing(s, 'r1_to_r2') ->> 'n' = '1' and _impact_tests.timing(s, 'r1_to_r2') -> 'medianDays' = 'null'::jsonb
    and _impact_tests.timing(s, 'r2_to_offer') ->> 'n' = '1' and _impact_tests.timing(s, 'offer_to_hired') ->> 'n' = '1'
    and jsonb_array_length(s -> 'timings') = 7, s -> 'timings' #>> '{}');

  -- Cohorts: IST weeks from Monday; young weeks are maturing.
  perform _impact_tests.ok('0140 summary: one cohort per IST week, oldest first, with its age and size',
    (select array_agg((c ->> 'weekStart') || ':' || (c ->> 'cameIn') || ':' || (c ->> 'ageDays') || ':' || (c ->> 'maturing') order by ord)
       from jsonb_array_elements(s -> 'cohorts') with ordinality as x(c, ord))
    = array['2026-09-28:3:43:false', '2026-10-05:9:36:true', '2026-10-12:3:29:true', '2026-10-19:5:22:true',
            '2026-10-26:1:15:true', '2026-11-02:1:8:true'], s -> 'cohorts' #>> '{}');
  perform _impact_tests.ok('0140 summary: a cohort''s shares are the nested steps over the week''s came in',
    (select c -> 'shares' from jsonb_array_elements(s -> 'cohorts') c where c ->> 'weekStart' = '2026-10-05')
      = '{"connected": 0.667, "scored": 0.667, "moved_forward": 0.222, "r1": 0.222, "r2": 0.111, "offer": 0.111, "hired": 0.111}'::jsonb,
    s -> 'cohorts' #>> '{}');
  -- The weeks of 26 Oct and 2 Nov hold only A13 and A14, never read from Ashby.
  perform _impact_tests.ok('0140 summary: a week none of whose applications Ashby has read shows null Ashby-side shares, never 0',
    (select count(*) from jsonb_array_elements(s -> 'cohorts') c
      where c ->> 'weekStart' in ('2026-10-26', '2026-11-02')
        and c -> 'shares' = '{"connected": 0, "scored": 0, "moved_forward": null, "r1": null, "r2": null, "offer": null, "hired": null}'::jsonb) = 2,
    s -> 'cohorts' #>> '{}');

  perform _impact_tests.ok('0140 summary: by job, under the job each application came in on',
    (select array_agg((j ->> 'label') || ':' || (j ->> 'cameIn') order by ord) from jsonb_array_elements(s -> 'byJob') with ordinality as x(j, ord))
      = array['Archived Kept Role:1', 'Browser Screen Role:4', 'Data Analyst:1', 'Sales Program Advisor:16'], s -> 'byJob' #>> '{}');
  perform _impact_tests.ok('0140 summary: a job''s shares',
    (select j -> 'shares' from jsonb_array_elements(s -> 'byJob') j where j ->> 'label' = 'Data Analyst')
      = '{"connected": 1, "scored": 1, "moved_forward": 1, "r1": 1, "r2": 0, "offer": 0, "hired": 0}'::jsonb, s -> 'byJob' #>> '{}');
  perform _impact_tests.ok('0140 summary: the contract''s top-level keys, and nothing else',
    (select array_agg(k order by k) from jsonb_object_keys(s) k) = array['byJob','cohorts','filters','leaves','meta','pipeline','timings','verdictOutcomes'],
    (select string_agg(k, ',') from jsonb_object_keys(s) k));
end $$;

-- ── Every figure's list holds exactly the applications behind it ─────────
do $$
declare
  s jsonb := _impact_tests.summary(date '2026-09-01', date '2026-11-10');
  st jsonb;
  vr jsonb;
  cell record;
  lv jsonb;
  r jsonb;
begin
  for st in select * from jsonb_array_elements(s -> 'pipeline') loop
    r := _impact_tests.list(st ->> 'step', null, null, null, null, 'all', null);
    perform _impact_tests.ok('0140 list: ' || (st ->> 'step') || ' lists exactly its figure (admin)',
      (r ->> 'total')::int = (st ->> 'reached')::int and (r ->> 'hidden')::int = 0, r::text);
    if st -> 'droppedHere' <> 'null'::jsonb then
      r := _impact_tests.list(st ->> 'step', null, null, null, true, 'all', null);
      perform _impact_tests.ok('0140 list: dropped at ' || (st ->> 'step') || ' lists exactly its figure',
        (r ->> 'total')::int = (st ->> 'droppedHere')::int, r::text);
    end if;
  end loop;
  for vr in select * from jsonb_array_elements(s -> 'verdictOutcomes' -> 'rows') loop
    for cell in select * from jsonb_each(vr -> 'cells') loop
      r := _impact_tests.list(null, vr ->> 'verdict', cell.key, null, null, 'all', null);
      -- A cell that is not known (null) has nothing behind it.
      perform _impact_tests.ok('0140 list: ' || (vr ->> 'verdict') || ' x ' || cell.key || ' is its cell (listed + hidden)',
        (r ->> 'total')::int + (r ->> 'hidden')::int = coalesce((cell.value #>> '{}')::int, 0), r::text);
    end loop;
  end loop;
  for lv in select * from jsonb_array_elements(s -> 'leaves') loop
    r := _impact_tests.list(null, null, null, lv ->> 'stageId', null, 'all', null);
    perform _impact_tests.ok('0140 list: archived at ' || (lv ->> 'stageTitle') || ' is its figure',
      (r ->> 'total')::int = (lv ->> 'archived')::int, r::text);
  end loop;
end $$;

-- ── Visibility (D-M031-5) ────────────────────────────────────────────────
do $$
declare
  i1 uuid := _impact_tests.id('user:i1');
  i2 uuid := _impact_tests.id('user:i2');
  r jsonb;
  n integer;
  ids uuid[];
  seen text[] := '{}';
  p integer;
begin
  r := _impact_tests.list('came_in', null, null, null, null, 'all', null);
  perform _impact_tests.ok('0140 visibility: a role that opens every candidate sees all 22, the stuck import included as no candidate',
    (r ->> 'total')::int = 22 and (r ->> 'hidden')::int = 0 and jsonb_array_length(r -> 'rows') = 22
    and (select count(*) from jsonb_array_elements(r -> 'rows') x where x -> 'candidateId' = 'null'::jsonb and x -> 'name' = 'null'::jsonb) = 1, r::text);

  r := _impact_tests.list('came_in', null, null, null, null, 'owner', i1);
  select array_agg(c.id) into ids from screening_v2.candidates c where c.owner_id = i1;
  perform _impact_tests.ok('0140 visibility: an interviewer lists only their own candidates, the rest counted as hidden',
    (r ->> 'total')::int = 12 and (r ->> 'hidden')::int = 10 and jsonb_array_length(r -> 'rows') = 12, r::text);
  perform _impact_tests.ok('0140 visibility: no row of another owner, and no row without a candidate, ever reaches an interviewer',
    not exists (select 1 from jsonb_array_elements(r -> 'rows') x
                 where x -> 'candidateId' = 'null'::jsonb or not ((x ->> 'candidateId')::uuid = any (ids))), r::text);
  r := _impact_tests.list('came_in', null, null, null, null, 'owner', i2);
  perform _impact_tests.ok('0140 visibility: the other interviewer: their 9, 13 hidden, total + hidden = the figure',
    (r ->> 'total')::int = 9 and (r ->> 'hidden')::int = 13, r::text);
  r := _impact_tests.list('came_in', null, null, null, null, 'owner', _impact_tests.id('user:nobody'));
  perform _impact_tests.ok('0140 visibility: an interviewer who owns none sees no row and the whole figure as hidden',
    (r ->> 'total')::int = 0 and (r ->> 'hidden')::int = 22 and r -> 'rows' = '[]'::jsonb, r::text);

  -- Appeal-blocked: listed under a step with no verdict or score; never under a verdict.
  r := _impact_tests.list('scored', null, null, null, null, 'all', null);
  perform _impact_tests.ok('0140 visibility: an appeal-blocked candidate is listed under a step without verdict, score or provisional mark',
    (select count(*) from jsonb_array_elements(r -> 'rows') x
      where x ->> 'candidateId' = _impact_tests.id('cand:a17')::text
        and x -> 'verdict' = 'null'::jsonb and x -> 'score' = 'null'::jsonb and x -> 'provisional' = 'false'::jsonb) = 1, r::text);
  perform _impact_tests.ok('0140 visibility: a provisional verdict is marked in the list',
    (select count(*) from jsonb_array_elements(r -> 'rows') x
      where x ->> 'candidateId' = _impact_tests.id('cand:a3')::text and x ->> 'verdict' = 'select' and x -> 'provisional' = 'true'::jsonb) = 1, r::text);
  r := _impact_tests.list(null, 'select', 'still_christy', null, null, 'all', null);
  perform _impact_tests.ok('0140 visibility: under a verdict the appeal-blocked candidate is neither listed nor counted, so no subtraction recovers its verdict',
    (r ->> 'total')::int = 3 and (r ->> 'hidden')::int = 0
    and not exists (select 1 from jsonb_array_elements(r -> 'rows') x where x ->> 'candidateId' = _impact_tests.id('cand:a17')::text), r::text);
  r := _impact_tests.list(null, 'select', 'still_christy', null, null, 'owner', i1);
  perform _impact_tests.ok('0140 visibility: an interviewer''s verdict list: the other owner''s three hidden',
    (r ->> 'total')::int = 0 and (r ->> 'hidden')::int = 3, r::text);

  -- Rows carry only the contract's fields.
  r := _impact_tests.list('hired', null, null, null, null, 'all', null);
  perform _impact_tests.ok('0140 list: a row carries exactly the contract''s fields',
    (select array_agg(k order by k) from jsonb_object_keys(r -> 'rows' -> 0) k)
      = array['candidateId','currentMilestone','currentStageTitle','enteredChristyAt','lastMoveAt','name','provisional','roleTitle','score','status','verdict'], r::text);
  perform _impact_tests.ok('0140 list: the hired row: name and role from the candidate record, stage and status from Ashby',
    r -> 'rows' -> 0 ->> 'name' = 'Impact fixture a1' and r -> 'rows' -> 0 ->> 'roleTitle' = 'Sales Program Advisor'
    and r -> 'rows' -> 0 ->> 'currentStageTitle' = 'Hired' and r -> 'rows' -> 0 ->> 'currentMilestone' = 'hired'
    and r -> 'rows' -> 0 ->> 'status' = 'Hired' and (r -> 'rows' -> 0 ->> 'enteredChristyAt')::timestamptz = timestamptz '2026-10-05 04:00:00+00'
    and (r -> 'rows' -> 0 ->> 'lastMoveAt')::timestamptz = timestamptz '2026-10-20 04:00:00+00', r::text);

  -- Paging: a total order, no row twice, none skipped; past the end is empty.
  for p in 1..5 loop
    r := _impact_tests.list('came_in', null, null, null, null, 'all', null, p, 5);
    perform _impact_tests.ok('0140 list: page ' || p || ' of 5 has its rows', (r ->> 'page')::int = p and (r ->> 'pageSize')::int = 5
      and jsonb_array_length(r -> 'rows') = case when p < 5 then 5 else 2 end and (r ->> 'total')::int = 22, r::text);
    -- A row has no id of its own (the contract carries none), so a person and their came-in time is the key.
    select seen || array_agg(coalesce(x ->> 'candidateId', 'none') || '@' || (x ->> 'enteredChristyAt')) into seen
      from jsonb_array_elements(r -> 'rows') x;
  end loop;
  perform _impact_tests.ok('0140 list: the five pages hold every row exactly once',
    cardinality(seen) = 22 and (select count(distinct u) from unnest(seen) u) = 22, array_to_string(seen, ','));
  r := _impact_tests.list('came_in', null, null, null, null, 'all', null, 6, 5);
  perform _impact_tests.ok('0140 list: a page past the end is empty, totals unchanged',
    r -> 'rows' = '[]'::jsonb and (r ->> 'page')::int = 6 and (r ->> 'total')::int = 22, r::text);
  r := _impact_tests.list('came_in', null, null, null, null, 'all', null, 1, 500);
  perform _impact_tests.ok('0140 list: the page size is capped at 100', (r ->> 'pageSize')::int = 100, r::text);
  r := _impact_tests.list('decided', null, null, null, null, 'all', null);
  perform _impact_tests.ok('0140 list: newest Ashby move first',
    (select array_agg(x ->> 'name' order by ord) from jsonb_array_elements(r -> 'rows') with ordinality as y(x, ord))
      = array['Impact fixture a1', 'Impact fixture a9', 'Impact fixture a8', 'Impact fixture ax', 'Impact fixture a2',
              'Impact fixture a10', 'Impact fixture a11'], r::text);
end $$;

-- ── Refusals ─────────────────────────────────────────────────────────────
do $$
declare
  now_ constant timestamptz := timestamptz '2026-11-10 06:30:00+00';
begin
  perform _impact_tests.ok('0140 refusal: from after to',
    screening_v2.impact_summary(date '2026-11-10', date '2026-11-01', null, true, now_) ->> 'status' = 'invalid_filter');
  perform _impact_tests.ok('0140 refusal: an unknown job',
    screening_v2.impact_summary(null, null, _impact_tests.id('map:nope'), true, now_) ->> 'status' = 'unknown_job');
  perform _impact_tests.ok('0140 refusal: an excluded job is unknown to the page',
    screening_v2.impact_summary(null, null, _impact_tests.id('map:e'), true, now_) ->> 'status' = 'unknown_job');
  perform _impact_tests.ok('0140 refusal: a list with two selectors',
    screening_v2.impact_candidates(null, null, null, 'called', 'select', 'r1', null, null, 'all', null, 1, 50, true, now_) ->> 'status' = 'invalid_filter');
  perform _impact_tests.ok('0140 refusal: a list with no selector',
    screening_v2.impact_candidates(null, null, null, null, null, null, null, null, 'all', null, 1, 50, true, now_) ->> 'status' = 'invalid_filter');
  perform _impact_tests.ok('0140 refusal: a verdict without an outcome',
    screening_v2.impact_candidates(null, null, null, null, 'select', null, null, null, 'all', null, 1, 50, true, now_) ->> 'status' = 'invalid_filter');
  perform _impact_tests.ok('0140 refusal: an unknown step, verdict or outcome',
    screening_v2.impact_candidates(null, null, null, 'nope', null, null, null, null, 'all', null, 1, 50, true, now_) ->> 'status' = 'invalid_filter'
    and screening_v2.impact_candidates(null, null, null, null, 'great', 'r1', null, null, 'all', null, 1, 50, true, now_) ->> 'status' = 'invalid_filter'
    and screening_v2.impact_candidates(null, null, null, null, 'select', 'r9', null, null, 'all', null, 1, 50, true, now_) ->> 'status' = 'invalid_filter');
  perform _impact_tests.ok('0140 refusal: a malformed stage id',
    screening_v2.impact_candidates(null, null, null, null, null, null, 'bad id!', null, 'all', null, 1, 50, true, now_) ->> 'status' = 'invalid_filter');
  perform _impact_tests.ok('0140 refusal: dropped needs a step, and Hired has no dropped',
    screening_v2.impact_candidates(null, null, null, null, 'select', 'r1', null, true, 'all', null, 1, 50, true, now_) ->> 'status' = 'invalid_filter'
    and screening_v2.impact_candidates(null, null, null, 'hired', null, null, null, true, 'all', null, 1, 50, true, now_) ->> 'status' = 'invalid_filter');
  perform _impact_tests.ok('0140 refusal: a scope that is not all or owner, or owner with no owner',
    screening_v2.impact_candidates(null, null, null, 'called', null, null, null, null, 'everyone', null, 1, 50, true, now_) ->> 'status' = 'invalid_scope'
    and screening_v2.impact_candidates(null, null, null, 'called', null, null, null, null, 'owner', null, 1, 50, true, now_) ->> 'status' = 'invalid_scope'
    and screening_v2.impact_candidates(null, null, null, 'called', null, null, null, null, null, null, 1, 50, true, now_) ->> 'status' = 'invalid_scope');
end $$;

-- ── Progress off, and a window nobody has read: every Ashby-side figure is null ──
do $$
declare
  s jsonb;
  st jsonb;
  k text;
  r jsonb;
begin
  s := _impact_tests.summary(date '2026-09-01', date '2026-11-10', null, false);
  perform _impact_tests.ok('0140 progress off: meta says so, and coverage is still reported',
    not (s -> 'meta' ->> 'progressEnabled')::boolean and (s -> 'meta' -> 'coverage' ->> 'checked')::int = 15, (s -> 'meta')::text);
  perform _impact_tests.ok('0140 progress off: Christy''s steps are still counted',
    (_impact_tests.step(s, 'came_in') ->> 'reached')::int = 22 and (_impact_tests.step(s, 'called') ->> 'reached')::int = 16
    and (_impact_tests.step(s, 'connected') ->> 'reached')::int = 12 and (_impact_tests.step(s, 'scored') ->> 'reached')::int = 11
    and (_impact_tests.step(s, 'scored') ->> 'ofPrevious')::numeric = 0.917, s -> 'pipeline' #>> '{}');
  foreach k in array array['decided','moved_forward','r1','r2','offer','hired'] loop
    st := _impact_tests.step(s, k);
    perform _impact_tests.ok('0140 progress off: ' || k || ' is null, never 0',
      st -> 'reached' = 'null'::jsonb and st -> 'ofPrevious' = 'null'::jsonb and st -> 'ofCameIn' = 'null'::jsonb
      and st -> 'stillHere' = 'null'::jsonb and st -> 'droppedHere' = 'null'::jsonb, st::text);
  end loop;
  perform _impact_tests.ok('0140 progress off: still and dropped are not known for Christy''s steps either',
    _impact_tests.step(s, 'came_in') -> 'stillHere' = 'null'::jsonb and _impact_tests.step(s, 'scored') -> 'droppedHere' = 'null'::jsonb,
    s -> 'pipeline' #>> '{}');
  perform _impact_tests.ok('0140 progress off: verdict totals stay, every cell is null',
    (_impact_tests.verdict_row(s, 'select') ->> 'total')::int = 7
    and not exists (select 1 from jsonb_array_elements(s -> 'verdictOutcomes' -> 'rows') vr, jsonb_each(vr -> 'cells') c
                     where c.value <> 'null'::jsonb), s -> 'verdictOutcomes' #>> '{}');
  perform _impact_tests.ok('0140 progress off: no leaves, Ashby timings n 0, Ashby shares null',
    s -> 'leaves' = '[]'::jsonb
    and (_impact_tests.timing(s, 'verdict_to_decision') ->> 'n')::int = 0
    and (_impact_tests.timing(s, 'entry_to_first_call') ->> 'n')::int = 16
    and not exists (select 1 from jsonb_array_elements(s -> 'cohorts') c
                     where c -> 'shares' -> 'moved_forward' <> 'null'::jsonb or c -> 'shares' -> 'hired' <> 'null'::jsonb)
    and not exists (select 1 from jsonb_array_elements(s -> 'byJob') j where j -> 'shares' -> 'r1' <> 'null'::jsonb),
    s::text);
  r := _impact_tests.list('decided', null, null, null, null, 'all', null, p_enabled => false);
  perform _impact_tests.ok('0140 progress off: nothing is listed behind an Ashby-side step', (r ->> 'total')::int = 0 and (r ->> 'hidden')::int = 0, r::text);
  r := _impact_tests.list('scored', null, null, null, null, 'all', null, p_enabled => false);
  perform _impact_tests.ok('0140 progress off: a Christy step''s list carries no Ashby stage or status',
    (r ->> 'total')::int = 11 and not exists (select 1 from jsonb_array_elements(r -> 'rows') x
      where x -> 'status' <> 'null'::jsonb or x -> 'currentStageTitle' <> 'null'::jsonb or x -> 'lastMoveAt' <> 'null'::jsonb), r::text);

  -- A window none of whose applications has been read (coverage.checked 0), progress on.
  s := _impact_tests.summary(date '2026-11-01', date '2026-11-02', null, true);
  perform _impact_tests.ok('0140 coverage 0: the two edge applications, none read, so every Ashby-side figure is null',
    (s -> 'meta' -> 'coverage') = '{"checked": 0, "total": 2}'::jsonb
    and (_impact_tests.step(s, 'came_in') ->> 'reached')::int = 2
    and _impact_tests.step(s, 'decided') -> 'reached' = 'null'::jsonb and _impact_tests.step(s, 'hired') -> 'reached' = 'null'::jsonb
    and _impact_tests.step(s, 'came_in') -> 'stillHere' = 'null'::jsonb, s::text);
  perform _impact_tests.ok('0140 IST week edge: 23:59 Sunday and 00:01 Monday fall in different weeks',
    (select array_agg((c ->> 'weekStart') || ':' || (c ->> 'cameIn') order by ord) from jsonb_array_elements(s -> 'cohorts') with ordinality as x(c, ord))
      = array['2026-10-26:1', '2026-11-02:1'], s -> 'cohorts' #>> '{}');
  s := _impact_tests.summary(date '2026-11-02', date '2026-11-02', null, true);
  perform _impact_tests.ok('0140 IST week edge: a one-day window on the Monday holds only the 00:01 application',
    (_impact_tests.step(s, 'came_in') ->> 'reached')::int = 1, s::text);

  -- The same week answers the same whether it is chosen alone or seen inside a longer window.
  s := _impact_tests.summary(date '2026-10-26', date '2026-11-01', null, true);
  perform _impact_tests.ok('0140 cohorts: an unread week chosen alone is the same row as inside the 12-week view',
    s -> 'meta' -> 'coverage' = '{"checked": 0, "total": 1}'::jsonb
    and s -> 'cohorts' -> 0 = (select c from jsonb_array_elements(_impact_tests.summary(date '2026-09-01', date '2026-11-10') -> 'cohorts') c
                                 where c ->> 'weekStart' = '2026-10-26'), s::text);

  -- An empty window: zeros, no share, nothing Ashby-side.
  s := _impact_tests.summary(date '2026-01-05', date '2026-01-11', null, true);
  perform _impact_tests.ok('0140 empty window: zero came in, no shares, empty lists',
    (_impact_tests.step(s, 'came_in') ->> 'reached')::int = 0 and _impact_tests.step(s, 'came_in') -> 'ofCameIn' = 'null'::jsonb
    and _impact_tests.step(s, 'called') -> 'ofPrevious' = 'null'::jsonb and s -> 'cohorts' = '[]'::jsonb and s -> 'byJob' = '[]'::jsonb
    and s -> 'leaves' = '[]'::jsonb, s::text);

  -- The default window: the last 12 IST weeks, Monday 24 Aug to today.
  s := screening_v2.impact_summary(null, null, null, true, timestamptz '2026-11-10 06:30:00+00') -> 'summary';
  perform _impact_tests.ok('0140 default window: the last 12 IST weeks, from a Monday to today',
    s -> 'filters' ->> 'from' = '2026-08-24' and s -> 'filters' ->> 'to' = '2026-11-10', (s -> 'filters')::text);

  -- One job.
  s := _impact_tests.summary(date '2026-09-01', date '2026-11-10', _impact_tests.id('map:a'), true);
  perform _impact_tests.ok('0140 job filter: only that job''s applications, and its own coverage',
    (_impact_tests.step(s, 'came_in') ->> 'reached')::int = 16 and jsonb_array_length(s -> 'byJob') = 1
    and s -> 'filters' ->> 'job' = _impact_tests.id('map:a')::text
    and (s -> 'meta' -> 'coverage') = '{"checked": 13, "total": 16}'::jsonb, s::text);
end $$;

-- ── Labels: an admin's label changes the notice, not the counts ──────────
do $$
declare
  admin uuid := _impact_tests.id('user:admin');
  before_ jsonb := _impact_tests.summary(date '2026-09-01', date '2026-11-10');
  after_ jsonb;
  r jsonb;
  st text;
begin
  foreach st in array array['imp-stage-06-ta', 'imp-stage-07-hm', 'imp-stage-08-r0', 'imp-stage-15-docs'] loop
    r := screening_v2.set_ashby_stage_milestone(st, 'other', 'admin', admin);
    if r ->> 'status' <> 'ok' then raise exception 'label refused: %', r; end if;
  end loop;
  after_ := _impact_tests.summary(date '2026-09-01', date '2026-11-10');
  perform _impact_tests.ok('0140 labels: the plan''s stages labelled, only the history-only stage stays unlabelled',
    (after_ -> 'meta' ->> 'unlabelledStages')::int = 1 and not (after_ -> 'meta' ->> 'labelsConfigured')::boolean, (after_ -> 'meta')::text);
  perform _impact_tests.ok('0140 labels: labelling a stage after Christy as other changes no count',
    after_ -> 'pipeline' = before_ -> 'pipeline' and after_ -> 'verdictOutcomes' = before_ -> 'verdictOutcomes', after_ -> 'pipeline' #>> '{}');
end $$;

-- ── The switch: set_ashby_impact_exclusion ───────────────────────────────
do $$
declare
  admin uuid := _impact_tests.id('user:admin');
  map_a uuid := _impact_tests.id('map:a');
  map_d uuid := _impact_tests.id('map:d');
  r jsonb;
  s jsonb;
  n integer;
  audits integer;
begin
  select count(*) into audits from screening_v2.audit_events where target_type = 'ashby_impact_exclusion';
  r := screening_v2.set_ashby_impact_exclusion(map_a, true, admin);
  perform _impact_tests.ok('0140 switch: leaving a job out answers before and after',
    r = jsonb_build_object('status', 'ok', 'excluded_from', null, 'excluded', true, 'archived', false, 'in_impact', false), r::text);
  s := _impact_tests.summary(date '2026-09-01', date '2026-11-10');
  perform _impact_tests.ok('0140 switch: a job left out leaves every figure and the job list',
    (_impact_tests.step(s, 'came_in') ->> 'reached')::int = 6 and jsonb_array_length(s -> 'filters' -> 'jobs') = 3, s::text);
  perform _impact_tests.ok('0140 switch: the job left out is unknown to the list',
    screening_v2.impact_candidates(null, null, map_a, 'called', null, null, null, null, 'all', null, 1, 50, true,
                                   timestamptz '2026-11-10 06:30:00+00') ->> 'status' = 'unknown_job');
  r := screening_v2.set_ashby_impact_exclusion(map_a, null, admin);
  perform _impact_tests.ok('0140 switch: back to the default is stored as NULL, never deleted',
    r ->> 'excluded_from' = 'true' and r -> 'excluded' = 'null'::jsonb and (r ->> 'in_impact')::boolean
    and exists (select 1 from screening_v2.ashby_impact_exclusions where job_mapping_id = map_a and excluded is null), r::text);
  r := screening_v2.set_ashby_impact_exclusion(map_d, false, admin);
  s := _impact_tests.summary(date '2026-09-01', date '2026-11-10');
  perform _impact_tests.ok('0140 switch: an archived job an admin keeps is counted',
    (r ->> 'archived')::boolean and (r ->> 'in_impact')::boolean and (_impact_tests.step(s, 'came_in') ->> 'reached')::int = 23, s::text);
  select count(*) - audits into n from screening_v2.audit_events where target_type = 'ashby_impact_exclusion';
  perform _impact_tests.ok('0140 switch: each change wrote one audit row (config_changed), the admin as its actor, no names',
    n = 3 and not exists (select 1 from screening_v2.audit_events
                           where target_type = 'ashby_impact_exclusion' and (actor_id <> admin or action <> 'config_changed')),
    n::text);
  perform _impact_tests.ok('0140 switch: refusals change nothing',
    screening_v2.set_ashby_impact_exclusion(map_a, true, null) ->> 'status' = 'actor_required'
    and screening_v2.set_ashby_impact_exclusion(_impact_tests.id('map:nope'), true, admin) ->> 'status' = 'not_found'
    and screening_v2.set_ashby_impact_exclusion(null, true, admin) ->> 'status' = 'not_found'
    and (select excluded from screening_v2.ashby_impact_exclusions where job_mapping_id = map_a) is null);
  perform _impact_tests.ok('0140 switch: the settings list names every mapping and whether it counts',
    (select count(*) from jsonb_array_elements(screening_v2.ashby_impact_mapping_settings() -> 'mappings') m
      where m ->> 'id' in (_impact_tests.id('map:a')::text, _impact_tests.id('map:d')::text, _impact_tests.id('map:e')::text)
        and (m ->> 'inImpact')::boolean = (m ->> 'id' <> _impact_tests.id('map:e')::text)) = 3);
end $$;

-- An audit row Postgres refuses rolls the switch back with it.
create function _impact_tests.refuse_audit() returns trigger language plpgsql as $$
begin
  raise exception 'impact test: audit refused';
end;
$$;
create trigger _impact_tests_refuse_audit before insert on screening_v2.audit_events
  for each row when (new.target_type = 'ashby_impact_exclusion')
  execute function _impact_tests.refuse_audit();
do $$
declare
  admin uuid := _impact_tests.id('user:admin');
  map_b uuid := _impact_tests.id('map:b');
  failed boolean := false;
begin
  begin
    perform screening_v2.set_ashby_impact_exclusion(map_b, true, admin);
  exception when others then
    failed := sqlerrm like '%audit refused%';
  end;
  perform _impact_tests.ok('0140 switch: a refused audit row rolls the switch back',
    failed and not exists (select 1 from screening_v2.ashby_impact_exclusions where job_mapping_id = map_b));
end $$;
drop trigger _impact_tests_refuse_audit on screening_v2.audit_events;

-- ── Erasure: every application of an erased person is listed, and never counted ──
do $$
declare
  admin  uuid := _impact_tests.id('user:admin');
  i1     uuid := _impact_tests.id('user:i1');
  role_e uuid := _impact_tests.id('role:e');
  map_e  uuid := _impact_tests.id('map:e');
  now_   constant timestamptz := timestamptz '2026-11-10 06:30:00+00';
  c uuid; c2 uuid; l uuid; l2 uuid;
  r jsonb; r2 jsonb;
begin
  -- Z1 and Z1B, after lib/dsar.ts's steps in the fixture.
  perform _impact_tests.ok('0140 erasure: every link of the erased person is listed, the already-terminal one included',
    (select count(*) from screening_v2.ashby_erased_application_links e
      where e.application_link_id in (_impact_tests.id('link:z1'), _impact_tests.id('link:z1b'))) = 2);
  perform _impact_tests.ok('0140 erasure: the list writes no link: the already-terminal one keeps its own state; the request went with the candidate',
    (select terminal_state = 'withdrawn' and terminal_reason = 'ashby_application_archived' and candidate_id is null
       from screening_v2.ashby_application_links where id = _impact_tests.id('link:z1'))
    and (select terminal_state = 'deleted' and terminal_reason = 'subject_erasure' and candidate_id is null
           from screening_v2.ashby_application_links where id = _impact_tests.id('link:z1b'))
    and not exists (select 1 from screening_v2.data_subject_requests where candidate_id = _impact_tests.id('cand:z1')));
  perform _impact_tests.ok('0140 erasure: an erased person is in no list: not for an admin, not hidden from an interviewer',
    screening_v2.impact_candidates(date '2026-10-16', date '2026-10-16', null, 'came_in', null, null, null, false,
                                   'all', null, 1, 50, true, now_) @> '{"status": "ok", "total": 0, "hidden": 0}'::jsonb
    and screening_v2.impact_candidates(date '2026-10-16', date '2026-10-16', null, 'came_in', null, null, null, false,
                                       'owner', i1, 1, 50, true, now_) @> '{"status": "ok", "total": 0, "hidden": 0}'::jsonb);

  -- Y1 and Y2 on the excluded mapping E, so nothing here can move a figure.
  c := _impact_tests.cand('y1', role_e, i1);
  l := _impact_tests.link('y1', map_e, c, timestamptz '2026-10-05 04:00:00+00');
  c2 := _impact_tests.cand('y2', role_e, i1);
  l2 := _impact_tests.link('y2', map_e, c2, timestamptz '2026-10-05 04:00:00+00');
  insert into screening_v2.data_subject_requests (candidate_id, request_type, request_status, requested_by)
  values (c, 'restrict', 'pending', admin), (c2, 'delete', 'pending', admin);
  r := screening_v2.mark_ashby_application_links_erased(c);
  perform _impact_tests.ok('0140 erasure: listing needs a deletion request for that person (a restriction is not one), and a refusal lists nothing',
    r = '{"status": "no_erasure_request"}'::jsonb
    and not exists (select 1 from screening_v2.ashby_erased_application_links where application_link_id = l), r::text);
  perform _impact_tests.ok('0140 erasure: no person, no list',
    screening_v2.mark_ashby_application_links_erased(null) = '{"status": "invalid_request"}'::jsonb);
  insert into screening_v2.data_subject_requests (candidate_id, request_type, request_status, requested_by)
  values (c, 'delete', 'in_progress', admin);
  r := screening_v2.mark_ashby_application_links_erased(c);
  r2 := screening_v2.mark_ashby_application_links_erased(c);
  perform _impact_tests.ok('0140 erasure: a retry lists nothing twice, and only that person''s links are listed',
    r = '{"status": "ok", "listed": 1, "added": 1}'::jsonb and r2 = '{"status": "ok", "listed": 1, "added": 0}'::jsonb
    and (select count(*) from screening_v2.ashby_erased_application_links where application_link_id = l) = 1
    and not exists (select 1 from screening_v2.ashby_erased_application_links where application_link_id = l2),
    r::text || ' ' || r2::text);
  perform _impact_tests.ok('0140 erasure: listing reads the link and writes only the list',
    (select terminal_state is null and terminal_reason is null and candidate_id = c
       from screening_v2.ashby_application_links where id = l));
end $$;

-- ── Each cohort, job and verdict row is known on its own reads ────────────
-- A new counted job G whose seven applications the worker has seeded and not
-- read yet, next to jobs that are read.
do $$
declare
  admin   uuid := _impact_tests.id('user:admin');
  i1      uuid := _impact_tests.id('user:i1');
  role_g  uuid := _impact_tests.id('role:g');
  map_g   uuid := _impact_tests.id('map:g');
  before_ jsonb := _impact_tests.summary(date '2026-09-01', date '2026-11-10');
  s  jsonb;
  sg jsonb;
  c uuid; l uuid; x uuid; t timestamptz; k integer;
begin
  insert into screening_v2.roles (id, title, owner_id) values (role_g, 'Growth Associate', admin);
  insert into screening_v2.ashby_job_mappings
    (id, external_job_id, role_id, owner_id, ai_screening_stage_id, ta_screening_stage_id, status, delivery_mode, screening_mode)
  values (map_g, 'imp-job-g', role_g, admin, 'imp-stage-05-christy', 'imp-stage-06-ta', 'paused', 'manual', 'phone_primary');
  -- G1..G6: connected Selects. G7: connected, no verdict.
  for k in 1..7 loop
    t := timestamptz '2026-10-14 04:00:00+00' + make_interval(hours => k);
    c := _impact_tests.cand('g' || k, role_g, i1);
    l := _impact_tests.link('g' || k, map_g, c, t);
    x := _impact_tests.phone('g' || k, l, c, role_g, t + interval '1 hour', true, true);
    if k <= 6 then
      perform _impact_tests.assess('g' || k, x, c, 'advance', t + interval '2 hours');
    end if;
    perform _impact_tests.progress(l, null, null, null);
  end loop;
  s := _impact_tests.summary(date '2026-09-01', date '2026-11-10');
  sg := _impact_tests.summary(date '2026-09-01', date '2026-11-10', map_g);

  perform _impact_tests.ok('0140 by job: an unread job is the same row in the all-jobs view as chosen alone',
    jsonb_array_length(sg -> 'byJob') = 1
    and (select j from jsonb_array_elements(s -> 'byJob') j where j ->> 'jobId' = map_g::text) = sg -> 'byJob' -> 0,
    (s -> 'byJob')::text || ' vs ' || (sg -> 'byJob')::text);
  perform _impact_tests.ok('0140 by job: an unread job shows its Christy shares, and null Ashby-side shares, never 0',
    sg -> 'byJob' -> 0 -> 'shares'
      = '{"connected": 1, "scored": 0.857, "moved_forward": null, "r1": null, "r2": null, "offer": null, "hired": null}'::jsonb,
    (sg -> 'byJob')::text);
  perform _impact_tests.ok('0140 by job: the jobs that are read keep their figures beside it',
    (select jsonb_agg(j order by j ->> 'jobId') from jsonb_array_elements(s -> 'byJob') j where j ->> 'jobId' <> map_g::text)
      = (select jsonb_agg(j order by j ->> 'jobId') from jsonb_array_elements(before_ -> 'byJob') j), s -> 'byJob' #>> '{}');
  perform _impact_tests.ok('0140 verdicts: a row partly read counts its read applications in the cells; its total holds them all',
    (_impact_tests.verdict_row(s, 'select') ->> 'total')::int = (_impact_tests.verdict_row(before_, 'select') ->> 'total')::int + 6
    and _impact_tests.verdict_row(s, 'select') -> 'cells' = _impact_tests.verdict_row(before_, 'select') -> 'cells'
    and s -> 'meta' -> 'coverage' ->> 'checked' = before_ -> 'meta' -> 'coverage' ->> 'checked'
    and (s -> 'meta' -> 'coverage' ->> 'total')::int = (before_ -> 'meta' -> 'coverage' ->> 'total')::int + 7,
    s -> 'verdictOutcomes' #>> '{}');
  perform _impact_tests.ok('0140 verdicts: a row none of whose applications is read shows null cells, never 0',
    (_impact_tests.verdict_row(s, 'none') ->> 'total')::int = 1
    and not exists (select 1 from jsonb_each(_impact_tests.verdict_row(s, 'none') -> 'cells') c where c.value <> 'null'::jsonb),
    _impact_tests.verdict_row(s, 'none')::text);
  perform _impact_tests.ok('0140 verdicts: the unread job chosen alone knows no cell, and nothing is listed behind one',
    not exists (select 1 from jsonb_array_elements(sg -> 'verdictOutcomes' -> 'rows') vr, jsonb_each(vr -> 'cells') c
                 where c.value <> 'null'::jsonb)
    and (_impact_tests.list(null, 'select', 'still_christy', null, null, 'all', null, p_job => map_g) ->> 'total')::int = 0,
    sg -> 'verdictOutcomes' #>> '{}');
end $$;

do $$
declare n integer;
begin
  select count(*) into n from _impact_tests.passed;
  raise notice 'ashby impact: % assertions passed', n;
end $$;

rollback;
