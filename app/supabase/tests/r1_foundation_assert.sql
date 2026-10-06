-- Executed by scripts/test-r1-foundation.sh inside the complete Supabase schema.
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
  role_mapped constant uuid := '10000000-0000-4000-8000-000000000004';
  candidate_a constant uuid := '10000000-0000-4000-8000-000000000011';
  candidate_b constant uuid := '10000000-0000-4000-8000-000000000012';
  candidate_c constant uuid := '10000000-0000-4000-8000-000000000013';
  candidate_d constant uuid := '10000000-0000-4000-8000-000000000014';
  candidate_e constant uuid := '10000000-0000-4000-8000-000000000015';
  candidate_f constant uuid := '10000000-0000-4000-8000-000000000016';
  candidate_g constant uuid := '10000000-0000-4000-8000-000000000017';
  candidate_h constant uuid := '10000000-0000-4000-8000-000000000018';
  candidate_i constant uuid := '10000000-0000-4000-8000-000000000019';
  candidate_j constant uuid := '10000000-0000-4000-8000-000000000020';
  round_a constant uuid := '10000000-0000-4000-8000-000000000031';
  round_b constant uuid := '10000000-0000-4000-8000-000000000032';
  round_c constant uuid := '10000000-0000-4000-8000-000000000033';
  round_d constant uuid := '10000000-0000-4000-8000-000000000034';
  round_e constant uuid := '10000000-0000-4000-8000-000000000035';
  round_f constant uuid := '10000000-0000-4000-8000-000000000036';
  round_g constant uuid := '10000000-0000-4000-8000-000000000037';
  round_h constant uuid := '10000000-0000-4000-8000-000000000038';
  round_i constant uuid := '10000000-0000-4000-8000-000000000039';
  round_j constant uuid := '10000000-0000-4000-8000-000000000040';
  template_old constant uuid := '10000000-0000-4000-8000-000000000051';
  template_new constant uuid := '10000000-0000-4000-8000-000000000052';
  res jsonb; sid uuid; phone_sid uuid; first_persona text; second_persona text; job_count integer;
begin
  -- `owner_id` on the R1-created call session is a real FK in the full chain.
  insert into auth.users (id, email) values (owner, 'r1-foundation@example.test')
  on conflict (id) do nothing;
  insert into screening_v2.roles (id, title, interview_kind) values
    (role_r1, 'Sales Program Advisor R1', 'sales_r1'),
    (role_phone, 'Phone role', null),
    (role_mapped, 'Mapped role', null);
  insert into screening_v2.candidates (id, role_id, name) values
    (candidate_a, role_r1, 'A'), (candidate_b, role_r1, 'B'),
    (candidate_c, role_r1, 'C'), (candidate_d, role_r1, 'D'),
    (candidate_e, role_phone, 'E'), (candidate_f, role_r1, 'F'),
    (candidate_g, role_r1, 'G'), (candidate_h, role_r1, 'H'),
    (candidate_i, role_r1, 'I'), (candidate_j, role_r1, 'J');

  -- Both are active; text version ordering makes 002 the authoritative template.
  insert into screening_v2.interview_round_consent_templates
    (id, version, title, body_md, is_active) values
    (template_old, '001', 'R1 old test', 'test', true),
    (template_new, '002', 'R1 current test', 'test', true);
  insert into screening_v2.interview_rounds
    (id, candidate_id, role_id, link_token_digest, expires_at, created_by, status) values
    (round_a, candidate_a, role_r1, repeat('a', 64), now() + interval '1 day', owner, 'invited'),
    (round_b, candidate_b, role_r1, repeat('b', 64), now() + interval '1 day', owner, 'invited'),
    (round_c, candidate_c, role_r1, repeat('c', 64), now() + interval '1 day', owner, 'invited'),
    (round_d, candidate_d, role_r1, repeat('d', 64), now() + interval '1 day', owner, 'invited'),
    (round_e, candidate_e, role_phone, repeat('e', 64), now() + interval '1 day', owner, 'invited'),
    (round_f, candidate_f, role_r1, repeat('f', 64), now() - interval '1 minute', owner, 'invited'),
    (round_g, candidate_g, role_r1, repeat('1', 64), now() + interval '1 day', owner, 'cancelled'),
    (round_h, candidate_h, role_r1, repeat('2', 64), now() + interval '1 day', owner, 'invited'),
    (round_i, candidate_i, role_r1, repeat('3', 64), now() + interval '1 day', owner, 'invited'),
    (round_j, candidate_j, role_r1, repeat('4', 64), now() + interval '1 day', owner, 'invited');
  insert into screening_v2.interview_round_consents(round_id, template_id) values
    (round_a, template_new), (round_b, template_new), (round_d, template_new),
    (round_e, template_new), (round_f, template_new), (round_g, template_new),
    (round_h, template_old), (round_i, template_new), (round_j, template_new);

  -- Metadata proves the shared-table checks/FK were added NOT VALID then validated.
  perform _r1_tests.assert('named shared-table constraints are validated', (
    select count(*) = 3 from pg_constraint
     where conname in ('fk_call_sessions_interview_round', 'chk_transcript_turns_phase', 'chk_roles_interview_kind')
       and convalidated
  ));
  perform _r1_tests.assert('link and nonce digest tables have RLS and no caller grants',
    (select relrowsecurity from pg_class where oid = 'screening_v2.interview_rounds'::regclass)
    and (select relrowsecurity from pg_class where oid = 'screening_v2.interview_round_attempts'::regclass)
    and not has_table_privilege('anon', 'screening_v2.interview_rounds', 'select')
    and not has_table_privilege('authenticated', 'screening_v2.interview_rounds', 'select')
    and not has_table_privilege('anon', 'screening_v2.interview_round_attempts', 'select')
    and not has_table_privilege('authenticated', 'screening_v2.interview_round_attempts', 'select'));

  -- Admission refusal order and every policy gate in the foundation plan.
  perform _r1_tests.assert('invalid nonce refuses before any state read',
    (screening_v2.r1_admit_attempt(round_a, 'not-a-digest')->>'status') = 'invalid_nonce');
  perform _r1_tests.assert('disabled refuses admission',
    (screening_v2.r1_admit_attempt(round_a, repeat('5', 64))->>'status') = 'disabled');
  update screening_v2.r1_settings set enabled = true, livekit_target = 'r1', monthly_cap_minutes = 1000, pause_line_minutes = 1000, dashboard_minutes = 0;
  perform _r1_tests.assert('unknown round refuses admission',
    (screening_v2.r1_admit_attempt('10000000-0000-4000-8000-000000000099', repeat('6', 64))->>'status') = 'round_not_found');
  perform _r1_tests.assert('non-admissible round refuses admission',
    (screening_v2.r1_admit_attempt(round_g, repeat('7', 64))->>'status') = 'round_not_admissible');
  perform _r1_tests.assert('expired round refuses admission',
    (screening_v2.r1_admit_attempt(round_f, repeat('8', 64))->>'status') = 'round_expired');
  perform _r1_tests.assert('non-R1 role refuses admission',
    (screening_v2.r1_admit_attempt(round_e, repeat('9', 64))->>'status') = 'r1_role_invalid');
  perform _r1_tests.assert('superseded active-template consent refuses admission',
    (screening_v2.r1_admit_attempt(round_h, repeat('0', 64))->>'status') = 'consent_missing');
  update screening_v2.interview_rounds set starts_used = 3 where id = round_b;
  perform _r1_tests.assert('three starts refuse another start',
    (screening_v2.r1_admit_attempt(round_b, repeat('b', 64))->>'status') = 'starts_exhausted');
  update screening_v2.interview_rounds set attempts_counted = attempts_allowed where id = round_d;
  perform _r1_tests.assert('counted-attempt allowance refuses a retake',
    (screening_v2.r1_admit_attempt(round_d, repeat('d', 64))->>'status') = 'attempts_exhausted');

  insert into screening_v2.call_sessions
    (candidate_id, role_id, mode, provider, external_call_id, status, interview_round_id, owner_id)
    values (candidate_j, role_r1, 'browser', 'livekit', 'r1-foundation-in-flight', 'created', round_j, owner);
  perform _r1_tests.assert('one live R1 session refuses another',
    (screening_v2.r1_admit_attempt(round_i, repeat('a', 64))->>'status') = 'r1_in_flight');
  update screening_v2.call_sessions set status = 'failed', terminal_reason = 'provider_error'
   where interview_round_id = round_j;

  res := screening_v2.r1_admit_attempt(round_a, repeat('a', 64));
  sid := (res->>'session_id')::uuid;
  select persona_id into first_persona from screening_v2.interview_round_attempts where session_id = sid;
  perform _r1_tests.assert('happy admission', res->>'status' = 'ok' and sid is not null, res::text);
  perform _r1_tests.assert('R1 session is browser/livekit and bound to round', exists (
    select 1 from screening_v2.call_sessions where id = sid and mode = 'browser' and provider = 'livekit'
      and interview_round_id = round_a and owner_id = owner and status = 'created'));
  perform _r1_tests.assert('attempt carries a fixed supported persona', exists (
    select 1 from screening_v2.interview_round_attempts where session_id = sid
      and persona_id in ('p1_career_switcher','p2_recent_grad','p3_data_analyst','p4_research_scholar')));
  update screening_v2.call_sessions set status = 'failed', terminal_reason = 'provider_error' where id = sid;
  res := screening_v2.r1_admit_attempt(round_a, repeat('c', 64));
  sid := (res->>'session_id')::uuid;
  select persona_id into second_persona from screening_v2.interview_round_attempts where session_id = sid;
  perform _r1_tests.assert('uncounted restart retains its persona', res->>'status' = 'ok' and second_persona = first_persona);
  update screening_v2.call_sessions set status = 'failed', terminal_reason = 'provider_error' where id = sid;
  update screening_v2.interview_round_attempts set counted = true where session_id = sid;
  update screening_v2.interview_rounds set attempts_counted = 1 where id = round_a;
  res := screening_v2.r1_admit_attempt(round_a, repeat('e', 64));
  sid := (res->>'session_id')::uuid;
  perform _r1_tests.assert('counted retake receives a different persona', res->>'status' = 'ok' and
    (select persona_id from screening_v2.interview_round_attempts where session_id = sid) <> first_persona);

  update screening_v2.r1_settings set paused = true;
  perform _r1_tests.assert('pause refuses admission',
    (screening_v2.r1_admit_attempt(round_i, repeat('a', 64))->>'status') = 'paused');
  update screening_v2.r1_settings set paused = false, monthly_cap_minutes = 55, pause_line_minutes = 55;
  perform _r1_tests.assert('55 minute hold enforces cap',
    (screening_v2.r1_admit_attempt(round_i, repeat('a', 64))->>'status') = 'capacity_exhausted');
  update screening_v2.r1_settings set monthly_cap_minutes = 1000, pause_line_minutes = 1000;

  -- Valid lifecycle transitions are required before a terminal completion.
  update screening_v2.call_sessions set status = 'waiting' where id = sid;
  update screening_v2.call_sessions set status = 'in_progress' where id = sid;
  update screening_v2.call_sessions set status = 'completed', terminal_reason = 'conversation_complete' where id = sid;
  select count(*) into job_count from screening_v2.job_queue
   where name = 'r1.assessment' and dedup_key = 'r1.assessment:' || sid::text and max_attempts = 5;
  perform _r1_tests.assert('R1 completion enqueues exactly one deduped job', job_count = 1, job_count::text);
  insert into screening_v2.call_sessions
    (candidate_id, role_id, mode, provider, external_call_id, status, owner_id)
    values (candidate_a, role_phone, 'live', 'livekit', 'r1-foundation-phone', 'created', owner)
    returning id into phone_sid;
  update screening_v2.call_sessions set status = 'waiting' where id = phone_sid;
  update screening_v2.call_sessions set status = 'in_progress' where id = phone_sid;
  update screening_v2.call_sessions set status = 'completed', terminal_reason = 'conversation_complete' where id = phone_sid;
  perform _r1_tests.assert('phone completion creates no R1 assessment job', not exists (
    select 1 from screening_v2.job_queue where dedup_key = 'r1.assessment:' || phone_sid::text));
  begin
    insert into screening_v2.call_sessions
      (candidate_id, role_id, mode, provider, external_call_id, interview_round_id, owner_id)
      values (candidate_a, role_r1, 'browser', 'livekit', 'r1-foundation-bad-round',
              '10000000-0000-4000-8000-000000000098', owner);
    raise exception 'invalid interview-round FK unexpectedly accepted';
  exception when foreign_key_violation then null;
  end;
  begin
    insert into screening_v2.transcript_turns (session_id, turn_index, speaker, text, phase)
      values (sid, 999, 'bot', 'constraint probe', 'not-a-phase');
    raise exception 'invalid transcript phase unexpectedly accepted';
  exception when check_violation then null;
  end;
  begin
    update screening_v2.roles set interview_kind = 'not-r1' where id = role_phone;
    raise exception 'invalid interview kind unexpectedly accepted';
  exception when check_violation then null;
  end;
  perform _r1_tests.assert('named FK and CHECK constraints enforce new writes',
    (select interview_kind is null from screening_v2.roles where id = role_phone));

  -- Mapping INSERT/update and the reverse roles update are both guarded.
  begin
    insert into screening_v2.ashby_job_mappings (external_job_id, role_id, owner_id, status)
      values ('r1-mapping-insert-must-fail', role_r1, owner, 'paused');
    raise exception 'Ashby mapping unexpectedly accepted R1 role';
  exception when check_violation then null;
  end;
  insert into screening_v2.ashby_job_mappings (external_job_id, role_id, owner_id, status)
    values ('r1-mapping-reverse', role_mapped, owner, 'paused');
  begin
    update screening_v2.roles set interview_kind = 'sales_r1' where id = role_mapped;
    raise exception 'mapped role unexpectedly became R1';
  exception when check_violation then null;
  end;
  insert into screening_v2.ashby_job_mappings (external_job_id, role_id, owner_id, status)
    values ('r1-mapping-role-update', role_phone, owner, 'paused');
  begin
    update screening_v2.ashby_job_mappings set role_id = role_r1 where external_job_id = 'r1-mapping-role-update';
    raise exception 'Ashby mapping role update unexpectedly accepted R1 role';
  exception when check_violation then null;
  end;
  perform _r1_tests.assert('both Ashby guard paths reject R1 mappings',
    (select interview_kind is null from screening_v2.roles where id = role_mapped)
    and (select role_id = role_phone from screening_v2.ashby_job_mappings where external_job_id = 'r1-mapping-role-update'));

  begin
    update screening_v2.interview_round_consent_templates set title = 'must fail' where id = template_new;
    raise exception 'consent template unexpectedly mutable';
  exception when raise_exception then
    if sqlerrm = 'consent template unexpectedly mutable' then raise; end if;
  end;
  perform _r1_tests.assert('consent templates are immutable',
    (select title = 'R1 current test' from screening_v2.interview_round_consent_templates where id = template_new));
  perform _r1_tests.assert('settings changes are audited', exists (
    select 1 from screening_v2.audit_events where action = 'config_changed' and target_type = 'r1_settings'));
end;
$$;

-- The cloud check must use phone attempts' live-state + unexpired-lease predicate,
-- rather than call_sessions.  Three live plus one expired attempt admits; a fourth
-- live attempt refuses. These fixtures use the full phone tables and constraints.
do $$
declare
  owner constant uuid := '10000000-0000-4000-8000-000000000001';
  candidate constant uuid := '10000000-0000-4000-8000-000000000011';
  role_phone constant uuid := '10000000-0000-4000-8000-000000000003';
  round_i constant uuid := '10000000-0000-4000-8000-000000000039';
  round_j constant uuid := '10000000-0000-4000-8000-000000000040';
  template_new constant uuid := '10000000-0000-4000-8000-000000000052';
  good jsonb; good_sid uuid;
begin
  -- This suite runs at the end of the disposable full-chain database lifetime.
  -- Expire pre-existing test leases so this assertion controls the entire cloud
  -- predicate without bypassing the phone-attempt table or its constraints.
  update screening_v2.phone_call_attempts
     set lease_expires_at = now() - interval '1 second'
   where state in ('admitted','ringing','answered_unclassified','human','machine')
     and lease_expires_at > now();
  insert into screening_v2.ashby_application_links (id, external_application_id, candidate_id) values
    ('10000000-0000-4000-8000-000000000061', 'r1-phone-app-1', candidate),
    ('10000000-0000-4000-8000-000000000062', 'r1-phone-app-2', candidate),
    ('10000000-0000-4000-8000-000000000063', 'r1-phone-app-3', candidate),
    ('10000000-0000-4000-8000-000000000064', 'r1-phone-app-expired', candidate),
    ('10000000-0000-4000-8000-000000000065', 'r1-phone-app-4', candidate);
  insert into screening_v2.phone_engagements (id, application_link_id, candidate_id, role_id, state) values
    ('10000000-0000-4000-8000-000000000071', '10000000-0000-4000-8000-000000000061', candidate, role_phone, 'eligible'),
    ('10000000-0000-4000-8000-000000000072', '10000000-0000-4000-8000-000000000062', candidate, role_phone, 'eligible'),
    ('10000000-0000-4000-8000-000000000073', '10000000-0000-4000-8000-000000000063', candidate, role_phone, 'eligible'),
    ('10000000-0000-4000-8000-000000000074', '10000000-0000-4000-8000-000000000064', candidate, role_phone, 'eligible'),
    ('10000000-0000-4000-8000-000000000075', '10000000-0000-4000-8000-000000000065', candidate, role_phone, 'eligible');
  insert into screening_v2.phone_call_attempts
    (engagement_id, attempt_seq, epoch, kind, state, ist_date, prior_engagement_state, lease_expires_at) values
    ('10000000-0000-4000-8000-000000000071', 1, 0, 'initial', 'human', current_date, 'eligible', now() + interval '1 hour'),
    ('10000000-0000-4000-8000-000000000072', 1, 0, 'initial', 'ringing', current_date, 'eligible', now() + interval '1 hour'),
    ('10000000-0000-4000-8000-000000000073', 1, 0, 'initial', 'admitted', current_date, 'eligible', now() + interval '1 hour'),
    ('10000000-0000-4000-8000-000000000074', 1, 0, 'initial', 'machine', current_date, 'eligible', now() - interval '1 second');
  update screening_v2.r1_settings set enabled = true, paused = false, livekit_target = 'cloud', monthly_cap_minutes = 1000, pause_line_minutes = 1000;
  good := screening_v2.r1_admit_attempt(round_i, repeat('a', 64));
  good_sid := (good->>'session_id')::uuid;
  perform _r1_tests.assert('expired phone lease is excluded from cloud capacity', good->>'status' = 'ok', good::text);
  update screening_v2.call_sessions set status = 'waiting' where id = good_sid;
  update screening_v2.call_sessions set status = 'in_progress' where id = good_sid;
  update screening_v2.call_sessions set status = 'completed', terminal_reason = 'conversation_complete' where id = good_sid;
  insert into screening_v2.phone_call_attempts
    (engagement_id, attempt_seq, epoch, kind, state, ist_date, prior_engagement_state, lease_expires_at)
    values ('10000000-0000-4000-8000-000000000075', 1, 0, 'initial', 'answered_unclassified', current_date, 'eligible', now() + interval '1 hour');
  perform _r1_tests.assert('four live unexpired phone attempts refuse cloud R1 admission',
    (screening_v2.r1_admit_attempt(round_j, repeat('b', 64))->>'status') = 'cloud_capacity_exhausted');
end;
$$;

drop schema _r1_tests cascade;
