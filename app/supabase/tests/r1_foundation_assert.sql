-- Executed by scripts/test-r1-foundation.sh against an isolated PostgreSQL.
create schema if not exists _r1_tests;
create or replace function _r1_tests.assert(p_label text, p_ok boolean, p_detail text default '')
returns void language plpgsql as $$
begin
  if not p_ok then raise exception 'R1 foundation FAIL: % (%)', p_label, p_detail; end if;
  raise notice 'R1 foundation PASS: %', p_label;
end;
$$;

do $$
declare
  owner constant uuid := '10000000-0000-4000-8000-000000000001';
  role_r1 constant uuid := '10000000-0000-4000-8000-000000000002';
  role_phone constant uuid := '10000000-0000-4000-8000-000000000003';
  candidate_a constant uuid := '10000000-0000-4000-8000-000000000004';
  candidate_b constant uuid := '10000000-0000-4000-8000-000000000005';
  candidate_c constant uuid := '10000000-0000-4000-8000-000000000006';
  candidate_d constant uuid := '10000000-0000-4000-8000-000000000011';
  round_a constant uuid := '10000000-0000-4000-8000-000000000007';
  round_b constant uuid := '10000000-0000-4000-8000-000000000008';
  round_c constant uuid := '10000000-0000-4000-8000-000000000009';
  round_d constant uuid := '10000000-0000-4000-8000-000000000012';
  template_id constant uuid := '10000000-0000-4000-8000-000000000010';
  res jsonb; sid uuid; first_sid uuid; first_persona text; second_persona text; job_count integer;
begin
  insert into screening_v2.roles(id, title, interview_kind) values
    (role_r1, 'Sales Program Advisor R1', 'sales_r1'), (role_phone, 'Phone role', null);
  insert into screening_v2.candidates(id, role_id, name) values
    (candidate_a, role_r1, 'A'), (candidate_b, role_r1, 'B'), (candidate_c, role_r1, 'C'), (candidate_d, role_r1, 'D');
  insert into screening_v2.interview_round_consent_templates(id, version, title, body_md, is_active)
    values (template_id, 'test-1', 'R1 test', 'test', true);
  insert into screening_v2.interview_rounds
    (id, candidate_id, role_id, link_token_digest, expires_at, created_by) values
    (round_a, candidate_a, role_r1, repeat('a', 64), now() + interval '1 day', owner),
    (round_b, candidate_b, role_r1, repeat('b', 64), now() + interval '1 day', owner),
    (round_c, candidate_c, role_r1, repeat('c', 64), now() + interval '1 day', owner),
    (round_d, candidate_d, role_r1, repeat('3', 64), now() + interval '1 day', owner);
  insert into screening_v2.interview_round_consents(round_id, template_id) values
    (round_a, template_id), (round_b, template_id), (round_d, template_id);
  update screening_v2.r1_settings set enabled = true, monthly_cap_minutes = 1000, pause_line_minutes = 1000;

  res := screening_v2.r1_admit_attempt(round_a, repeat('d', 64));
  sid := (res->>'session_id')::uuid;
  first_sid := sid;
  select persona_id into first_persona from screening_v2.interview_round_attempts where session_id = sid;
  perform _r1_tests.assert('happy admission', res->>'status' = 'ok' and sid is not null, res::text);
  perform _r1_tests.assert('R1 session is browser/livekit and bound to round', exists (
    select 1 from screening_v2.call_sessions where id = sid and mode = 'browser' and provider = 'livekit'
      and interview_round_id = round_a and owner_id = owner and status = 'created'));
  perform _r1_tests.assert('attempt carries a fixed supported persona', exists (
    select 1 from screening_v2.interview_round_attempts where session_id = sid
      and persona_id in ('p1_career_switcher','p2_recent_grad','p3_data_analyst','p4_research_scholar')));
  update screening_v2.call_sessions set status = 'failed' where id = sid;
  res := screening_v2.r1_admit_attempt(round_a, repeat('9', 64));
  sid := (res->>'session_id')::uuid;
  select persona_id into second_persona from screening_v2.interview_round_attempts where session_id = sid;
  perform _r1_tests.assert('uncounted restart retains its persona', res->>'status' = 'ok' and second_persona = first_persona);
  update screening_v2.call_sessions set status = 'failed' where id = sid;
  update screening_v2.interview_round_attempts set counted = true where session_id = sid;
  update screening_v2.interview_rounds set attempts_counted = 1 where id = round_a;
  res := screening_v2.r1_admit_attempt(round_a, repeat('8', 64));
  sid := (res->>'session_id')::uuid;
  select persona_id into second_persona from screening_v2.interview_round_attempts where session_id = sid;
  perform _r1_tests.assert('counted retake receives a different persona', res->>'status' = 'ok' and second_persona <> first_persona);

  update screening_v2.r1_settings set paused = true;
  perform _r1_tests.assert('pause refuses admission', (screening_v2.r1_admit_attempt(round_b, repeat('e', 64))->>'status') = 'paused');
  update screening_v2.r1_settings set paused = false, monthly_cap_minutes = 55, pause_line_minutes = 55;
  perform _r1_tests.assert('55 minute hold enforces cap', (screening_v2.r1_admit_attempt(round_b, repeat('e', 64))->>'status') = 'capacity_exhausted');
  update screening_v2.r1_settings set monthly_cap_minutes = 1000, pause_line_minutes = 1000;
  update screening_v2.interview_rounds set starts_used = 3 where id = round_b;
  perform _r1_tests.assert('three starts refuse another start', (screening_v2.r1_admit_attempt(round_b, repeat('e', 64))->>'status') = 'starts_exhausted');
  update screening_v2.interview_rounds set attempts_counted = attempts_allowed where id = round_d;
  perform _r1_tests.assert('counted-attempt allowance refuses a retake', (screening_v2.r1_admit_attempt(round_d, repeat('7', 64))->>'status') = 'attempts_exhausted');
  insert into screening_v2.interview_round_consents(round_id, template_id, withdrawn_at)
    values (round_c, template_id, now());
  perform _r1_tests.assert('withdrawn consent refuses admission', (screening_v2.r1_admit_attempt(round_c, repeat('f', 64))->>'status') = 'consent_missing');
  begin
    update screening_v2.interview_round_consent_templates set title = 'must fail' where id = template_id;
    raise exception 'consent template unexpectedly mutable';
  exception when raise_exception then
    if sqlerrm = 'consent template unexpectedly mutable' then raise; end if;
  end;
  perform _r1_tests.assert('consent templates are immutable', (select title = 'R1 test' from screening_v2.interview_round_consent_templates where id = template_id));

  -- Phone completion must not enqueue an R1 assessment.
  insert into screening_v2.call_sessions (candidate_id, role_id, mode, provider, status)
    values (candidate_b, role_phone, 'live', 'livekit', 'created');
  update screening_v2.call_sessions set status = 'completed'
   where candidate_id = candidate_b and interview_round_id is null and mode = 'live';
  select count(*) into job_count from screening_v2.job_queue where name = 'r1.assessment';
  perform _r1_tests.assert('phone completion creates no R1 job', job_count = 0, job_count::text);

  update screening_v2.call_sessions set status = 'completed' where id = sid;
  update screening_v2.call_sessions set status = 'completed' where id = sid;
  select count(*) into job_count from screening_v2.job_queue
   where name = 'r1.assessment' and dedup_key = 'r1.assessment:' || sid::text and max_attempts = 5;
  perform _r1_tests.assert('R1 completion enqueues exactly one deduped job', job_count = 1, job_count::text);

  begin
    insert into screening_v2.ashby_job_mappings
      (external_job_id, role_id, owner_id, ai_screening_stage_id, ta_screening_stage_id, status)
    values ('r1-mapping-must-fail', role_r1, owner, 'ai', 'ta', 'enabled');
    raise exception 'Ashby mapping unexpectedly accepted R1 role';
  exception when check_violation then null;
  end;
  perform _r1_tests.assert('Ashby guard rejects R1 roles', not exists (
    select 1 from screening_v2.ashby_job_mappings where external_job_id = 'r1-mapping-must-fail'));
  perform _r1_tests.assert('anon has no digest select grant', not has_table_privilege('anon', 'screening_v2.interview_rounds', 'select'));
  perform _r1_tests.assert('authenticated has no digest select grant', not has_table_privilege('authenticated', 'screening_v2.interview_rounds', 'select'));
  perform _r1_tests.assert('settings changes are audited', exists (
    select 1 from screening_v2.audit_events where action = 'config_changed' and target_type = 'r1_settings'));
end;
$$;

drop schema _r1_tests cascade;
