-- Executed by scripts/test-r1-foundation.sh inside the complete Supabase schema.
create schema if not exists _r1_tests;
create or replace function _r1_tests.assert(p_label text, p_ok boolean, p_detail text default '')
returns void language plpgsql as $$
begin
  if not p_ok then raise exception 'R1 foundation FAIL: % (%)', p_label, p_detail; end if;
  raise notice 'R1 foundation PASS: %', p_label;
end;
$$;

-- Fixture helpers for the capacity-model assertions (0119). Every id, digest and
-- external id they create is derived from the caller's unique tag; digests are
-- sha256 of that tag, never a repeated character, so they cannot collide with
-- the fixed fixtures below. Holds, uncounted charges and the outstanding terms
-- are GLOBAL (other suites and earlier blocks may leave some), so no assertion
-- below hard-codes a limit that depends on them: limits are computed from
-- r1_capacity_snapshot and the literal parts are asserted net of the snapshot's
-- own outstanding_holds (see _r1_tests.net).
create or replace function _r1_tests.u(p_n integer) returns uuid language sql immutable as $$
  select ('10000000-0000-4000-8000-' || lpad(p_n::text, 12, '0'))::uuid;
$$;
create or replace function _r1_tests.cand(p_n integer, p_name text) returns uuid language plpgsql as $$
begin
  insert into screening_v2.candidates(id, role_id, name)
  values (_r1_tests.u(p_n), '10000000-0000-4000-8000-000000000002', p_name);
  return _r1_tests.u(p_n);
end;
$$;
create or replace function _r1_tests.add_session(
  p_id uuid, p_candidate uuid, p_round uuid, p_start timestamptz, p_end timestamptz
) returns void language plpgsql as $$
begin
  -- A legacy browser session has no round (p_round null); an R1 session has one.
  -- New sessions must start 'created'; a finished one is failed with an explicit end.
  insert into screening_v2.call_sessions
    (id, candidate_id, role_id, mode, provider, external_call_id, status, interview_round_id, owner_id,
     started_at, created_at, updated_at)
  values (p_id, p_candidate, '10000000-0000-4000-8000-000000000002', 'browser', 'livekit',
          'r1-capacity-' || p_id::text, 'created', p_round, '10000000-0000-4000-8000-000000000001',
          p_start, p_start, p_start);
  if p_end is not null then
    update screening_v2.call_sessions
       set status = 'failed', terminal_reason = 'provider_error', ended_at = p_end where id = p_id;
  end if;
end;
$$;
-- A round that only carries metering fixtures (terminal, so it never counts as a hold).
create or replace function _r1_tests.dead_round(p_n integer, p_candidate uuid)
returns uuid language plpgsql as $$
begin
  insert into screening_v2.interview_rounds(id, candidate_id, role_id, link_token_digest, expires_at, created_by, status)
  values (_r1_tests.u(p_n), p_candidate, '10000000-0000-4000-8000-000000000002',
          encode(sha256(convert_to('r1-capacity-dead-round-' || p_n::text, 'UTF8')), 'hex'),
          '2099-01-01T00:00:00Z', '10000000-0000-4000-8000-000000000001', 'expired');
  return _r1_tests.u(p_n);
end;
$$;
create or replace function _r1_tests.settings(p_target text, p_cap integer, p_pause integer)
returns void language sql as $$
  update screening_v2.r1_settings
     set enabled = true, paused = false, livekit_target = p_target,
         monthly_cap_minutes = p_cap, pause_line_minutes = p_pause,
         dashboard_minutes = 0, dashboard_read_at = null, dashboard_estimate_baseline = null;
$$;
create or replace function _r1_tests.send_until(p_candidate uuid, p_tag text, p_now timestamptz, p_expires timestamptz)
returns jsonb language sql as $$
  select screening_v2.r1_send_round(p_candidate, '10000000-0000-4000-8000-000000000002',
    '10000000-0000-4000-8000-000000000001', encode(sha256(convert_to('r1-capacity-' || p_tag, 'UTF8')), 'hex'),
    null, p_expires, p_now);
$$;
create or replace function _r1_tests.send(p_candidate uuid, p_tag text, p_now timestamptz)
returns jsonb language sql as $$
  select _r1_tests.send_until(p_candidate, p_tag, p_now, p_now + interval '5 days');
$$;
create or replace function _r1_tests.admit(p_round uuid, p_tag text, p_now timestamptz)
returns jsonb language sql as $$
  select screening_v2.r1_admit_attempt(p_round, encode(sha256(convert_to('r1-capacity-' || p_tag, 'UTF8')), 'hex'), p_now);
$$;
create or replace function _r1_tests.consent(p_round uuid, p_at timestamptz default now()) returns void language sql as $$
  insert into screening_v2.interview_round_consents(round_id, template_id, granted_at)
  values (p_round, '10000000-0000-4000-8000-000000000052', p_at);
$$;
create or replace function _r1_tests.cancel(p_sent jsonb) returns void language plpgsql as $$
declare v_result jsonb; v_round uuid := (p_sent->>'id')::uuid;
begin
  -- Takes a Send result and releases its hold; a refused Send holds nothing. A
  -- cleanup that silently failed would leave a hold behind and skew every later
  -- capacity assertion, so a failed cancel is itself an error.
  if p_sent->>'status' is distinct from 'ok' then return; end if;
  v_result := screening_v2.r1_transition_round(v_round, 'cancel',
    (select version from screening_v2.interview_rounds where id = v_round), null, null);
  if v_result->>'status' <> 'ok' then raise exception 'fixture cancel failed: %', v_result; end if;
end;
$$;
create or replace function _r1_tests.fail_live() returns void language sql as $$
  update screening_v2.call_sessions set status = 'failed', terminal_reason = 'provider_error'
   where interview_round_id is not null and status in ('created', 'waiting', 'in_progress');
$$;
create or replace function _r1_tests.snap(p_now timestamptz, p_hold numeric default 0, p_used numeric default 0, p_actual numeric default 0)
returns jsonb language sql as $$
  select screening_v2.r1_capacity_snapshot(p_now, p_hold, p_used, p_actual);
$$;
create or replace function _r1_tests.num(p_snap jsonb, p_key text) returns numeric language sql immutable as $$
  select (p_snap->>p_key)::numeric;
$$;
-- A committed term with every outstanding hold taken out (the snapshot's own
-- outstanding_holds plus the requested hold change): what is left is the R1/pool
-- arithmetic, which is exact and does not depend on strays.
create or replace function _r1_tests.net(p_snap jsonb, p_key text) returns numeric language sql immutable as $$
  select (p_snap->>p_key)::numeric - (p_snap->>'outstanding_holds')::numeric - (p_snap->>'extra_hold')::numeric;
$$;
create or replace function _r1_tests.booked(p_month date) returns numeric language sql as $$
  select coalesce((select minutes_used from screening_v2.r1_budget_month where month_start = p_month), 0);
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
  candidate_k constant uuid := '10000000-0000-4000-8000-000000000021';
  candidate_l constant uuid := '10000000-0000-4000-8000-000000000022';
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
  round_k constant uuid := '10000000-0000-4000-8000-000000000041';
  round_l constant uuid := '10000000-0000-4000-8000-000000000042';
  template_old constant uuid := '10000000-0000-4000-8000-000000000051';
  template_new constant uuid := '10000000-0000-4000-8000-000000000052';
  template_inactive constant uuid := '10000000-0000-4000-8000-000000000053';
  template_required constant uuid := '10000000-0000-4000-8000-000000000054';
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
    (candidate_i, role_r1, 'I'), (candidate_j, role_r1, 'J'),
    (candidate_k, role_r1, 'K'), (candidate_l, role_r1, 'L');

  -- Version 002 is authoritative. Templates at that version exercise locale,
  -- inactive, withdrawal, and required-consent paths independently.
  insert into screening_v2.interview_round_consent_templates
    (id, version, locale, title, body_md, required_consents, is_active) values
    (template_old, '001', 'en-IN', 'R1 old test', 'test', '[]'::jsonb, true),
    (template_new, '002', 'en-IN', 'R1 current test', 'test', '[]'::jsonb, true),
    (template_inactive, '002', 'hi-IN', 'R1 current inactive locale test', 'test', '[]'::jsonb, false),
    (template_required, '002', 'en-GB', 'R1 current required-consent locale test', 'test',
     '["terms","recording"]'::jsonb, true);
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
    (round_j, candidate_j, role_r1, repeat('4', 64), now() + interval '1 day', owner, 'invited'),
    (round_k, candidate_k, role_r1, repeat('6', 64), now() + interval '1 day', owner, 'invited'),
    (round_l, candidate_l, role_r1, repeat('7', 64), now() + interval '1 day', owner, 'invited');
  insert into screening_v2.interview_round_consents(round_id, template_id, consents, withdrawn_at) values
    (round_a, template_new, '[]'::jsonb, null), (round_b, template_new, '[]'::jsonb, null),
    (round_d, template_new, '[]'::jsonb, null), (round_e, template_new, '[]'::jsonb, null),
    (round_f, template_new, '[]'::jsonb, null), (round_g, template_new, '[]'::jsonb, null),
    (round_h, template_old, '[]'::jsonb, null), (round_i, template_new, '[]'::jsonb, null),
    (round_j, template_new, '[]'::jsonb, null),
    (round_c, template_inactive, '[]'::jsonb, null),
    (round_k, template_new, '[]'::jsonb, now()),
    (round_l, template_required, '["terms"]'::jsonb, null);

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
  perform _r1_tests.assert('inactive current-version template consent refuses admission',
    (screening_v2.r1_admit_attempt(round_c, repeat('c', 64))->>'status') = 'consent_missing');
  perform _r1_tests.assert('withdrawn current-version consent refuses admission',
    (screening_v2.r1_admit_attempt(round_k, repeat('a', 64))->>'status') = 'consent_missing');
  perform _r1_tests.assert('current-version consent missing a required value refuses admission',
    (screening_v2.r1_admit_attempt(round_l, repeat('b', 64))->>'status') = 'consent_missing');
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
    (select persona_id from screening_v2.interview_round_attempts where session_id = sid) <> first_persona and
    (select hold_month = date_trunc('month',now())::date from screening_v2.interview_rounds where id=round_a));

  update screening_v2.r1_settings set paused = true;
  perform _r1_tests.assert('pause refuses admission',
    (screening_v2.r1_admit_attempt(round_i, repeat('a', 64))->>'status') = 'paused');
  update screening_v2.r1_settings set paused = false, monthly_cap_minutes = 55, pause_line_minutes = 55;
  -- 0117 evaluates the one-live-R1 rule BEFORE capacity: the counted retake above
  -- is still live, so a full cap must not mask the in-flight refusal.
  perform _r1_tests.assert('a live R1 session is refused before the cap is evaluated',
    (screening_v2.r1_admit_attempt(round_i, repeat('a', 64))->>'status') = 'r1_in_flight');
  update screening_v2.r1_settings set monthly_cap_minutes = 1000, pause_line_minutes = 1000;

  -- Valid lifecycle transitions are required before a terminal completion.
  update screening_v2.call_sessions set status = 'waiting' where id = sid;
  update screening_v2.call_sessions set status = 'in_progress' where id = sid;
  update screening_v2.call_sessions set status = 'completed', terminal_reason = 'conversation_complete' where id = sid;
  select count(*) into job_count from screening_v2.job_queue
   where name = 'r1.assessment' and dedup_key = 'r1.assessment:' || sid::text and max_attempts = 5;
  perform _r1_tests.assert('R1 completion enqueues exactly one deduped job', job_count = 1, job_count::text);

  -- No R1 session is live any more, so this isolates the 55-minute capacity hold.
  update screening_v2.r1_settings set monthly_cap_minutes = 55, pause_line_minutes = 55;
  perform _r1_tests.assert('55 minute hold enforces cap',
    (screening_v2.r1_admit_attempt(round_i, repeat('a', 64))->>'status') = 'capacity_exhausted');
  update screening_v2.r1_settings set monthly_cap_minutes = 1000, pause_line_minutes = 1000;
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
-- rather than call_sessions. Three live plus an expired machine attempt admits;
-- making that machine lease live creates the four-attempt refusal threshold.
-- These fixtures use the full phone tables and constraints.
do $$
declare
  owner constant uuid := '10000000-0000-4000-8000-000000000001';
  candidate constant uuid := '10000000-0000-4000-8000-000000000011';
  role_phone constant uuid := '10000000-0000-4000-8000-000000000003';
  round_i constant uuid := '10000000-0000-4000-8000-000000000039';
  round_j constant uuid := '10000000-0000-4000-8000-000000000040';
  template_new constant uuid := '10000000-0000-4000-8000-000000000052';
  good jsonb; good_sid uuid; self_hosted jsonb; self_hosted_sid uuid;
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
    ('10000000-0000-4000-8000-000000000064', 'r1-phone-app-expired', candidate);
  insert into screening_v2.phone_engagements (id, application_link_id, candidate_id, role_id, state) values
    ('10000000-0000-4000-8000-000000000071', '10000000-0000-4000-8000-000000000061', candidate, role_phone, 'eligible'),
    ('10000000-0000-4000-8000-000000000072', '10000000-0000-4000-8000-000000000062', candidate, role_phone, 'eligible'),
    ('10000000-0000-4000-8000-000000000073', '10000000-0000-4000-8000-000000000063', candidate, role_phone, 'eligible'),
    ('10000000-0000-4000-8000-000000000074', '10000000-0000-4000-8000-000000000064', candidate, role_phone, 'eligible');
  insert into screening_v2.phone_call_attempts
    (engagement_id, attempt_seq, epoch, kind, state, ist_date, prior_engagement_state, lease_expires_at) values
    ('10000000-0000-4000-8000-000000000071', 1, 0, 'initial', 'human', current_date, 'eligible', now() + interval '1 hour'),
    ('10000000-0000-4000-8000-000000000072', 1, 0, 'initial', 'ringing', current_date, 'eligible', now() + interval '1 hour'),
    ('10000000-0000-4000-8000-000000000073', 1, 0, 'initial', 'admitted', current_date, 'eligible', now() + interval '1 hour'),
    ('10000000-0000-4000-8000-000000000074', 1, 0, 'initial', 'machine', current_date, 'eligible', now() - interval '1 second');
  update screening_v2.r1_settings set enabled = true, paused = false, livekit_target = 'cloud', monthly_cap_minutes = 1000, pause_line_minutes = 100000;
  good := screening_v2.r1_admit_attempt(round_i, repeat('a', 64));
  good_sid := (good->>'session_id')::uuid;
  perform _r1_tests.assert('expired phone lease is excluded from cloud capacity', good->>'status' = 'ok', good::text);
  update screening_v2.call_sessions set status = 'waiting' where id = good_sid;
  update screening_v2.call_sessions set status = 'in_progress' where id = good_sid;
  update screening_v2.call_sessions set status = 'completed', terminal_reason = 'conversation_complete' where id = good_sid;
  update screening_v2.phone_call_attempts
     set lease_expires_at = now() + interval '1 hour'
   where engagement_id = '10000000-0000-4000-8000-000000000074';
  perform _r1_tests.assert('future-leased machine plus three live attempts refuse cloud R1 admission',
    (screening_v2.r1_admit_attempt(round_j, repeat('b', 64))->>'status') = 'cloud_capacity_exhausted');
  update screening_v2.r1_settings set livekit_target = 'r1';
  self_hosted := screening_v2.r1_admit_attempt(round_j, repeat('b', 64));
  self_hosted_sid := (self_hosted->>'session_id')::uuid;
  perform _r1_tests.assert('self-hosted R1 ignores the cloud phone threshold',
    self_hosted->>'status' = 'ok' and self_hosted_sid is not null, self_hosted::text);
  update screening_v2.call_sessions set status = 'waiting' where id = self_hosted_sid;
  update screening_v2.call_sessions set status = 'in_progress' where id = self_hosted_sid;
  update screening_v2.call_sessions set status = 'completed', terminal_reason = 'conversation_complete' where id = self_hosted_sid;
end;
$$;

-- 0117: Send itself reserves capacity atomically; cancel/expiry release the
-- round-owned hold.  These are SQL assertions over the applied functions, not
-- route mocks.
do $$
declare
  owner constant uuid := '10000000-0000-4000-8000-000000000001';
  role_r1 constant uuid := '10000000-0000-4000-8000-000000000002';
  candidate constant uuid := '10000000-0000-4000-8000-000000000081';
  sent jsonb; rid uuid; before_reserved numeric; after_reserved numeric;
begin
  insert into screening_v2.candidates(id,role_id,name) values(candidate,role_r1,'hold assertion');
  update screening_v2.r1_settings set enabled=true,paused=false,livekit_target='r1',monthly_cap_minutes=10000,pause_line_minutes=10000,dashboard_minutes=0,dashboard_read_at=now();
  select minutes_reserved into before_reserved from screening_v2.r1_budget_month where month_start=date_trunc('month',now())::date;
  sent := screening_v2.r1_send_round(candidate,role_r1,owner,repeat('8',64),null,now()+interval '1 hour');
  rid := (sent->>'id')::uuid;
  select minutes_reserved into after_reserved from screening_v2.r1_budget_month where month_start=date_trunc('month',now())::date;
  perform _r1_tests.assert('Send R1 atomically inserts a round and reserves exactly its hold', sent->>'status'='ok' and (select held_minutes=55 from screening_v2.interview_rounds where id=rid) and after_reserved=before_reserved+55, sent::text);
  perform screening_v2.r1_transition_round(rid,'cancel',1,null,null);
  perform _r1_tests.assert('cancel releases the round hold', (select held_minutes=0 from screening_v2.interview_rounds where id=rid) and (select minutes_reserved=after_reserved-55 from screening_v2.r1_budget_month where month_start=date_trunc('month',now())::date));
  -- The view must include sessions with no usage row (session-timestamp fallback).
  perform _r1_tests.assert('estimate has session timestamp fallback', exists(select 1 from screening_v2.v_webrtc_minutes_estimate where month_start=date_trunc('month',now())::date));
  perform _r1_tests.assert('ledger has required idempotency and upper-bound constraints', exists(select 1 from pg_constraint where conrelid='screening_v2.r1_usage_ledger'::regclass and conname='chk_r1_usage_event_bounds') and exists(select 1 from pg_indexes where schemaname='screening_v2' and indexname='uq_r1_usage_ledger_session_event_key'));
end;
$$;

-- Outstanding holds are FUTURE minutes the estimate cannot contain (plan section
-- 3.3), so they count ON TOP of an estimate that already exceeds admitted minutes.
-- In Mode B (cloud) a dominant pool estimate (a fresh dashboard reading) must not
-- hide the reservation; in Mode A the R1 allocation counts it as well. The caps
-- below are pinned from the shared snapshot, one minute short of a second hold.
do $$
declare
  owner constant uuid := '10000000-0000-4000-8000-000000000001';
  role_r1 constant uuid := '10000000-0000-4000-8000-000000000002';
  first_candidate constant uuid := '10000000-0000-4000-8000-000000000083';
  second_candidate constant uuid := '10000000-0000-4000-8000-000000000084';
  first_sent jsonb; second_sent jsonb; third_sent jsonb; fourth_sent jsonb; snap jsonb;
begin
  insert into screening_v2.candidates(id, role_id, name) values
    (first_candidate, role_r1, 'reservation one'),
    (second_candidate, role_r1, 'reservation two');
  update screening_v2.r1_settings
     set enabled = true, paused = false, livekit_target = 'cloud',
         monthly_cap_minutes = 100000, pause_line_minutes = 100000,
         dashboard_minutes = 5000, dashboard_read_at = now(),
         dashboard_estimate_baseline = (screening_v2.r1_capacity_snapshot(now(), 0)->>'pool_pure')::numeric;
  first_sent := screening_v2.r1_send_round(first_candidate, role_r1, owner,
    encode(sha256('r1-reservation-one'::bytea), 'hex'), null, now() + interval '1 hour');
  snap := screening_v2.r1_capacity_snapshot(now(), 0);
  -- Mode B: the pool check refuses the second hold because the first still counts.
  update screening_v2.r1_settings
     set pause_line_minutes = ceil((snap->>'pool_committed')::numeric) + 54;
  second_sent := screening_v2.r1_send_round(second_candidate, role_r1, owner,
    encode(sha256('r1-reservation-two'::bytea), 'hex'), null, now() + interval '1 hour');
  -- Mode A: the pause line is irrelevant, the R1 allocation counts the hold.
  update screening_v2.r1_settings
     set livekit_target = 'r1', pause_line_minutes = 1,
         monthly_cap_minutes = ceil((snap->>'r1_committed')::numeric) + 54;
  third_sent := screening_v2.r1_send_round(second_candidate, role_r1, owner,
    encode(sha256('r1-reservation-three'::bytea), 'hex'), null, now() + interval '1 hour');
  update screening_v2.r1_settings
     set monthly_cap_minutes = ceil((snap->>'r1_committed')::numeric) + 55;
  fourth_sent := screening_v2.r1_send_round(second_candidate, role_r1, owner,
    encode(sha256('r1-reservation-four'::bytea), 'hex'), null, now() + interval '1 hour');
  perform _r1_tests.assert('outstanding holds count on top of a dominant estimate',
    first_sent->>'status' = 'ok' and (snap->>'outstanding_holds')::numeric >= 55
      and (snap->>'pool_guard')::numeric > (snap->>'r1_committed')::numeric
      and second_sent->>'status' = 'capacity_exhausted'
      and third_sent->>'status' = 'capacity_exhausted'
      and fourth_sent->>'status' = 'ok',
    jsonb_build_array(first_sent, second_sent, third_sent, fourth_sent)::text);
  perform _r1_tests.cancel(first_sent);
  perform _r1_tests.cancel(fourth_sent);
  update screening_v2.r1_settings
     set monthly_cap_minutes = 10000, pause_line_minutes = 10000,
         dashboard_minutes = 0, dashboard_read_at = null, dashboard_estimate_baseline = null;
end;
$$;

-- A hold belongs to its originating budget month.  A February cancellation of
-- a January Send must release January and must not create or touch February.
do $$
declare
  owner constant uuid := '10000000-0000-4000-8000-000000000001';
  role_r1 constant uuid := '10000000-0000-4000-8000-000000000002';
  candidate constant uuid := '10000000-0000-4000-8000-000000000082';
  month_m constant date := '2030-01-01';
  month_next constant date := '2030-02-01';
  sent jsonb; rid uuid; version_before integer;
begin
  insert into screening_v2.candidates(id,role_id,name) values(candidate,role_r1,'cross-month hold assertion');
  update screening_v2.r1_settings set enabled=true,paused=false,livekit_target='r1',monthly_cap_minutes=10000,pause_line_minutes=10000,dashboard_minutes=0,dashboard_read_at='2030-01-01T00:00:00Z';
  sent := screening_v2.r1_send_round(candidate,role_r1,owner,repeat('9',64),null,'2030-01-20T00:00:00Z','2030-01-15T00:00:00Z');
  rid := (sent->>'id')::uuid;
  select version into version_before from screening_v2.interview_rounds where id=rid;
  perform _r1_tests.assert('Send persists the hold originating month',
    sent->>'status'='ok' and (select held_minutes=55 and hold_month=month_m from screening_v2.interview_rounds where id=rid), sent::text);
  perform screening_v2.r1_transition_round(rid,'cancel',version_before,null,null,'2030-02-02T00:00:00Z');
  perform _r1_tests.assert('cross-month cancel releases only the originating month',
    (select held_minutes=0 from screening_v2.interview_rounds where id=rid)
    and (select minutes_reserved=0 from screening_v2.r1_budget_month where month_start=month_m)
    and not exists(select 1 from screening_v2.r1_budget_month where month_start=month_next));
end;
$$;

-- 0119 capacity model. Every scenario below runs in its own far-future (or, for
-- the sweep, far-past) calendar month, selected by the p_now argument, so the
-- month-scoped terms (ledger, sessions, phone, legacy browser) are isolated from
-- every other suite's data. Holds and uncounted charges are month-agnostic and
-- global, so each scenario cancels the rounds it creates, and no limit is a
-- literal: it is derived from r1_capacity_snapshot for the same change the RPC
-- will make (refused one minute below it, admitted at it), while the arithmetic
-- under test is asserted as an exact literal NET of the snapshot's own
-- outstanding holds (_r1_tests.net), so a stray hold cannot move either.
-- Each finding has an assertion that fails under 0117's single least(cap, pause
-- line) rule and under the mutants named in its comment.

-- Finding 1 (P1): the R1 allocation is not expressible under the single rule.
-- The pool is dominated by 12 h of legacy browser (1441 estimated minutes, x1.15 =
-- 1657.15), far above a December-style 20 x 55 = 1100 allocation. Mode A must
-- still admit within its allocation, Mode B must apply the pause line, and the
-- allocation must bind exactly in both: with no R1 minutes in the month the
-- allocation edge is the outstanding holds + 55.
do $$
declare
  m constant timestamptz := '2034-03-15T12:00:00Z';
  mode_a jsonb; mode_b jsonb; too_small jsonb; edge_refused jsonb; edge_ok jsonb; edge jsonb; need integer;
begin
  perform _r1_tests.cand(101, 'allocation mode A');
  perform _r1_tests.cand(102, 'allocation mode B');
  perform _r1_tests.cand(103, 'allocation too small');
  perform _r1_tests.cand(501, 'allocation edge refused');
  perform _r1_tests.cand(502, 'allocation edge ok');
  perform _r1_tests.add_session(_r1_tests.u(301), _r1_tests.u(11), null, '2034-03-05T00:00:00Z', '2034-03-05T12:00:00Z');
  perform _r1_tests.settings('r1', 1100, 1100);
  mode_a := _r1_tests.send(_r1_tests.u(101), 'p1-mode-a', m);
  perform _r1_tests.cancel(mode_a);
  perform _r1_tests.settings('cloud', 1100, 1100);
  mode_b := _r1_tests.send(_r1_tests.u(102), 'p1-mode-b', m);
  perform _r1_tests.settings('r1', 54, 100000);
  too_small := _r1_tests.send(_r1_tests.u(103), 'p1-too-small', m);
  edge := _r1_tests.snap(m, 55);
  need := ceil(_r1_tests.num(edge, 'r1_committed'));
  perform _r1_tests.settings('r1', need - 1, 1);
  edge_refused := _r1_tests.send(_r1_tests.u(501), 'p1-edge-refused', m);
  perform _r1_tests.settings('r1', need, 1);
  edge_ok := _r1_tests.send(_r1_tests.u(502), 'p1-edge-ok', m);
  perform _r1_tests.assert('finding 1: R1 allocation is independent of the Cloud pool (Mode A ignores the pause line, Mode B applies both, the allocation binds exactly in both)',
    mode_a->>'status' = 'ok' and mode_b->>'status' = 'capacity_exhausted' and too_small->>'status' = 'capacity_exhausted'
      and edge_refused->>'status' = 'capacity_exhausted' and edge_ok->>'status' = 'ok'
      and _r1_tests.net(edge, 'r1_committed') = 0 and need = _r1_tests.num(edge, 'outstanding_holds') + 55,
    jsonb_build_array(mode_a, mode_b, too_small, edge_refused, edge_ok, edge)::text);
  perform _r1_tests.cancel(edge_ok);
end;
$$;

-- Finding 2 (P2): an admitted-but-unmetered live R1 is masked by
-- greatest(used, guard) when phone/legacy dominates. One live R1 session with no
-- metering counts at least its 55-minute charge, a booked charge that counts once
-- (never x1.15): 1441 x 1.15 + 55 = 1712.15 (net of holds), so a Send needs
-- 1767.15; 0117 counted that session as 0 (1657.15 net, 1712.15 with the Send's
-- hold).
do $$
declare
  owner constant uuid := '10000000-0000-4000-8000-000000000001';
  role_r1 constant uuid := '10000000-0000-4000-8000-000000000002';
  round_live constant uuid := '10000000-0000-4000-8000-000000000201';
  m constant timestamptz := '2034-04-15T12:00:00Z';
  before_send jsonb; at_send jsonb; refused jsonb; admitted jsonb; need integer;
begin
  perform _r1_tests.cand(104, 'live unmetered holder');
  perform _r1_tests.cand(105, 'live unmetered refused');
  perform _r1_tests.cand(106, 'live unmetered control');
  insert into screening_v2.interview_rounds(id, candidate_id, role_id, link_token_digest, expires_at, created_by, status)
    values (round_live, _r1_tests.u(104), role_r1,
            encode(sha256('r1-capacity-p2-live-round'::bytea), 'hex'), '2034-04-30T00:00:00Z', owner, 'in_progress');
  perform _r1_tests.add_session(_r1_tests.u(302), _r1_tests.u(11), null, '2034-04-02T00:00:00Z', '2034-04-02T12:00:00Z');
  perform _r1_tests.add_session(_r1_tests.u(303), _r1_tests.u(104), round_live, '2034-04-10T08:00:00Z', null);
  insert into screening_v2.r1_budget_month(month_start, minutes_used) values ('2034-04-01', 55)
    on conflict (month_start) do update set minutes_used = 55;
  before_send := _r1_tests.snap(m, 0);
  at_send := _r1_tests.snap(m, 55);
  need := ceil(_r1_tests.num(at_send, 'pool_committed'));
  perform _r1_tests.settings('cloud', 100000, need - 1);
  refused := _r1_tests.send(_r1_tests.u(105), 'p2-refused', m);
  perform _r1_tests.settings('cloud', 100000, need);
  admitted := _r1_tests.send(_r1_tests.u(106), 'p2-control', m);
  perform _r1_tests.assert('finding 2: a live unmetered R1 session is counted, not masked by the dominant pool estimate',
    refused->>'status' = 'capacity_exhausted' and admitted->>'status' = 'ok'
      and _r1_tests.num(before_send, 'live_unmetered_minutes') = 55
      and abs(_r1_tests.net(at_send, 'pool_committed') - 1712.15) < 0.001
      and abs(_r1_tests.net(at_send, 'r1_committed') - 55) < 0.001,
    jsonb_build_array(refused, admitted, at_send)::text);
  perform _r1_tests.fail_live();
  perform _r1_tests.cancel(admitted);
end;
$$;

-- Finding 2, fallback half: a session with no usable ledger row counts candidate
-- AND agent (x2, like legacy browser), and neither a zero-second ledger row nor a
-- preflight row bound to the session suppresses it. A 22-minute session counts
-- 44 as R1 session minutes; the 10 s preflight is pool-only test time.
do $$
declare
  round_fallback uuid; round_live uuid; session_fallback constant uuid := '10000000-0000-4000-8000-000000000304';
  s jsonb; s_live jsonb;
begin
  perform _r1_tests.cand(107, 'fallback session');
  round_fallback := _r1_tests.dead_round(202, _r1_tests.u(107));
  perform _r1_tests.add_session(session_fallback, _r1_tests.u(107), round_fallback,
    '2035-03-10T09:00:00Z', '2035-03-10T09:22:00Z');
  insert into screening_v2.r1_usage_ledger(session_id, round_id, participant_kind, event, seconds, event_key, occurred_at) values
    (session_fallback, round_fallback, 'candidate', 'connect', 0, 'r1-fallback-zero', '2035-03-10T09:00:00Z'),
    (session_fallback, round_fallback, 'preflight', 'usage', 10, 'r1-fallback-preflight', '2035-03-10T09:00:00Z');
  s := _r1_tests.snap('2035-03-15T12:00:00Z', 0);
  perform _r1_tests.assert('finding 2: the session fallback counts two participants; a zero-second or preflight ledger row does not suppress it',
    abs(_r1_tests.num(s, 'r1_actual') - 44) < 0.001
      and abs(_r1_tests.num(s, 'r1_test_minutes') - 10 / 60.0) < 0.001
      and abs(_r1_tests.num(s, 'pool_pure') - (44 + 10 / 60.0)) < 0.001,
    s::text);
  -- A LIVE session with a preflight row and no metering still counts at its 55-minute floor.
  round_live := _r1_tests.dead_round(605, _r1_tests.u(107));
  perform _r1_tests.add_session(_r1_tests.u(705), _r1_tests.u(107), round_live, '2035-03-12T09:00:00Z', null);
  insert into screening_v2.r1_usage_ledger(session_id, round_id, participant_kind, event, seconds, event_key, occurred_at)
    values (_r1_tests.u(705), round_live, 'preflight', 'usage', 10, 'r1-live-preflight', '2035-03-12T09:00:00Z');
  s_live := _r1_tests.snap('2035-03-15T12:00:00Z', 0);
  perform _r1_tests.assert('finding 2: a preflight row does not replace the live floor of an unmetered live session',
    abs(_r1_tests.num(s_live, 'live_unmetered_minutes') - 55) < 0.001
      and abs(_r1_tests.num(s_live, 'r1_actual') - (44 + 55)) < 0.001
      and abs(_r1_tests.num(s_live, 'r1_test_minutes') - 20 / 60.0) < 0.001,
    s_live::text);
  perform _r1_tests.fail_live();
end;
$$;

-- Finding 3 (P2): converting a Send hold never re-checked the pool. The hold is
-- already counted, and the converted start exchanges it for a booked 55 plus the
-- new live session's 55-minute floor, which count as 55 together (a floor is a
-- booked charge, never x1.15): the start needs exactly the hold it converts, 55
-- (net of holds). A start that fits at Send time therefore fits again (see the
-- first-of-month regression below). Boundaries come from the snapshot of that
-- exact change: refused one minute below, admitted at it, in Mode A (allocation
-- only; the pause line of 1 is ignored) and Mode B (pause line, on a second hold
-- so each edge admits once). Mutants killed: no check on the held path, +55 on
-- the held path (needs 110), and Mode A applying the pause line.
do $$
declare
  m constant timestamptz := '2034-05-15T12:00:00Z';
  sent jsonb; rid uuid; conversion jsonb; need integer;
  cloud jsonb; allocation jsonb; mode_a jsonb;
  sent_b jsonb; rid_b uuid; conversion_b jsonb; need_b integer; cloud_below jsonb; cloud_edge jsonb;
begin
  perform _r1_tests.cand(108, 'held conversion');
  perform _r1_tests.cand(503, 'held conversion cloud edge');
  perform _r1_tests.settings('cloud', 100000, 100000);
  sent := _r1_tests.send(_r1_tests.u(108), 'p3-held', m);
  rid := (sent->>'id')::uuid;
  perform _r1_tests.consent(rid);
  conversion := _r1_tests.snap(m, -55, 55, 55);
  need := ceil(_r1_tests.num(conversion, 'r1_committed'));
  -- Phone grew after the Send: the pool is above the pause line when the link is used.
  perform _r1_tests.settings('cloud', 100000, need - 1);
  cloud := _r1_tests.admit(rid, 'p3-cloud', m);
  perform _r1_tests.settings('r1', need - 1, 1);
  allocation := _r1_tests.admit(rid, 'p3-allocation', m);
  perform _r1_tests.settings('r1', need, 1);
  mode_a := _r1_tests.admit(rid, 'p3-mode-a', m);
  perform _r1_tests.fail_live();
  perform _r1_tests.cancel(sent);
  perform _r1_tests.settings('cloud', 100000, 100000);
  sent_b := _r1_tests.send(_r1_tests.u(503), 'p3-held-b', m);
  rid_b := (sent_b->>'id')::uuid;
  perform _r1_tests.consent(rid_b);
  conversion_b := _r1_tests.snap(m, -55, 55, 55);
  need_b := ceil(_r1_tests.num(conversion_b, 'pool_committed'));
  perform _r1_tests.settings('cloud', 100000, need_b - 1);
  cloud_below := _r1_tests.admit(rid_b, 'p3-cloud-below', m);
  perform _r1_tests.settings('cloud', 100000, need_b);
  cloud_edge := _r1_tests.admit(rid_b, 'p3-cloud-edge', m);
  perform _r1_tests.assert('finding 3: the held-path conversion is checked after the start, refused one minute below its exact edge and admitted at it, in both modes',
    sent->>'status' = 'ok' and cloud->>'status' = 'capacity_exhausted'
      and allocation->>'status' = 'capacity_exhausted' and mode_a->>'status' = 'ok'
      and cloud_below->>'status' = 'capacity_exhausted' and cloud_edge->>'status' = 'ok'
      and _r1_tests.net(conversion, 'r1_committed') = 55
      and _r1_tests.net(conversion, 'pool_committed') = 55
      and need = _r1_tests.num(conversion, 'outstanding_holds'),
    jsonb_build_array(sent, cloud, allocation, mode_a, cloud_below, cloud_edge, conversion)::text);
  perform _r1_tests.fail_live();
  perform _r1_tests.cancel(sent_b);
end;
$$;

-- Finding 3b: the booked 55 of a start counts when the month is dominated by booked
-- minutes rather than metered ones (U-dominated, the usual case). With 1000
-- booked, converting a hold needs 1000 + 55 = 1055 (net of holds), and a retake
-- after a counted first attempt needs 1055 + 55 = 1110. Mutant killed: a start
-- that books nothing (it would fit at 1000 and 1055).
do $$
declare
  m constant timestamptz := '2037-01-15T12:00:00Z';
  sent jsonb; rid uuid; conversion jsonb; need integer; refused jsonb; admitted jsonb;
  retake_state jsonb; need_retake integer; retake_refused jsonb; retake_ok jsonb;
begin
  perform _r1_tests.cand(514, 'booked-dominated start');
  insert into screening_v2.r1_budget_month(month_start, minutes_used) values ('2037-01-01', 1000)
    on conflict (month_start) do update set minutes_used = 1000;
  perform _r1_tests.settings('r1', 100000, 100000);
  sent := _r1_tests.send(_r1_tests.u(514), 'p3b', m);
  rid := (sent->>'id')::uuid;
  perform _r1_tests.consent(rid);
  conversion := _r1_tests.snap(m, -55, 55, 55);
  need := ceil(_r1_tests.num(conversion, 'r1_committed'));
  perform _r1_tests.settings('r1', need - 1, 1);
  refused := _r1_tests.admit(rid, 'p3b-refused', m);
  perform _r1_tests.settings('r1', need, 1);
  admitted := _r1_tests.admit(rid, 'p3b-edge', m);
  perform _r1_tests.fail_live();
  update screening_v2.interview_round_attempts set counted = true where session_id = (admitted->>'session_id')::uuid;
  update screening_v2.interview_rounds set attempts_counted = 1 where id = rid;
  retake_state := _r1_tests.snap(m, 0, 55, 55);
  need_retake := ceil(_r1_tests.num(retake_state, 'r1_committed'));
  perform _r1_tests.settings('r1', need_retake - 1, 1);
  retake_refused := _r1_tests.admit(rid, 'p3b-retake-refused', m);
  perform _r1_tests.settings('r1', need_retake, 1);
  retake_ok := _r1_tests.admit(rid, 'p3b-retake-edge', m);
  perform _r1_tests.assert('finding 3b: a start books its 55 (conversion and retake) when booked minutes dominate',
    refused->>'status' = 'capacity_exhausted' and admitted->>'status' = 'ok'
      and retake_refused->>'status' = 'capacity_exhausted' and retake_ok->>'status' = 'ok'
      and abs(_r1_tests.net(conversion, 'r1_committed') - 1055) < 0.001
      and abs(_r1_tests.net(retake_state, 'r1_committed') - 1110) < 0.001
      and _r1_tests.booked('2037-01-01') = 1110,
    jsonb_build_array(refused, admitted, retake_refused, retake_ok, conversion, retake_state)::text);
  perform _r1_tests.fail_live();
  perform _r1_tests.cancel(sent);
end;
$$;

-- Finding 1b (P2, restart): an uncounted restart used to be checked at +0 on the
-- state BEFORE it. When metered minutes dominate the booked 55 (A-dominated), the
-- restart's live session then overshot the allocation. A first start that ran 30
-- minutes and failed without counting leaves 60 metered minutes (x1.15 = 69, over
-- the 55 booked). The restart re-uses the booked 55 (charged once: no second 55,
-- no hold left outstanding) and adds its live floor, a booked charge that counts
-- once: 1.15 x 60 + 55 = 124, net of holds. A check on the state before the
-- restart needed only 69.
do $$
declare
  m constant timestamptz := '2036-03-15T12:00:00Z';
  sent jsonb; rid uuid; first_start jsonb; before_restart jsonb; restart_state jsonb; need integer;
  refused jsonb; admitted jsonb; retake_state jsonb; need_retake integer; retake_refused jsonb; retake_ok jsonb;
begin
  perform _r1_tests.cand(504, 'restart A-dominated');
  perform _r1_tests.settings('r1', 100000, 100000);
  sent := _r1_tests.send(_r1_tests.u(504), 'e-restart', m);
  rid := (sent->>'id')::uuid;
  perform _r1_tests.consent(rid);
  first_start := _r1_tests.admit(rid, 'e-first', m);
  update screening_v2.call_sessions
     set started_at = '2036-03-10T09:00:00Z', ended_at = '2036-03-10T09:30:00Z',
         status = 'failed', terminal_reason = 'provider_error'
   where id = (first_start->>'session_id')::uuid;
  before_restart := _r1_tests.snap(m, 0);
  restart_state := _r1_tests.snap(m, -55, 55, 55);
  need := ceil(_r1_tests.num(restart_state, 'r1_committed'));
  perform _r1_tests.settings('r1', need - 1, 1);
  refused := _r1_tests.admit(rid, 'e-restart-refused', m);
  perform _r1_tests.settings('r1', need, 1);
  admitted := _r1_tests.admit(rid, 'e-restart-edge', m);
  perform _r1_tests.assert('finding 1b: an A-dominated restart is checked after its live session starts and charged once (one booked 55, one live floor)',
    first_start->>'status' = 'ok' and refused->>'status' = 'capacity_exhausted' and admitted->>'status' = 'ok'
      and (admitted->>'attempt_number')::integer = 1
      and _r1_tests.num(before_restart, 'uncounted_charges') = 1
      and abs(_r1_tests.num(before_restart, 'r1_actual') - 60) < 0.001
      and abs(_r1_tests.net(before_restart, 'r1_committed') - 69) < 0.001
      and abs(_r1_tests.net(restart_state, 'r1_committed') - 124) < 0.001
      and _r1_tests.booked('2036-03-01') = 55,
    jsonb_build_array(first_start, refused, admitted, before_restart, restart_state)::text);
  -- The restart ran 30 minutes and ended too; attempt 1 counts. A retake books a fresh 55
  -- AND adds its live floor; here the metered minutes dominate the booked ones (110), so
  -- the floor shows on top of them: 1.15 x 120 + 55 = 193.
  update screening_v2.call_sessions
     set started_at = '2036-03-11T09:00:00Z', ended_at = '2036-03-11T09:30:00Z',
         status = 'failed', terminal_reason = 'provider_error'
   where id = (admitted->>'session_id')::uuid;
  update screening_v2.interview_round_attempts set counted = true where session_id = (admitted->>'session_id')::uuid;
  update screening_v2.interview_rounds set attempts_counted = 1 where id = rid;
  retake_state := _r1_tests.snap(m, 0, 55, 55);
  need_retake := ceil(_r1_tests.num(retake_state, 'r1_committed'));
  perform _r1_tests.settings('r1', need_retake - 1, 1);
  retake_refused := _r1_tests.admit(rid, 'e-retake-refused', m);
  perform _r1_tests.settings('r1', need_retake, 1);
  retake_ok := _r1_tests.admit(rid, 'e-retake-edge', m);
  perform _r1_tests.assert('finding 1b: a retake is checked after its live session starts (fresh 55 booked plus the live floor)',
    retake_refused->>'status' = 'capacity_exhausted' and retake_ok->>'status' = 'ok'
      and (retake_ok->>'attempt_number')::integer = 2
      and abs(_r1_tests.net(retake_state, 'r1_committed') - 193) < 0.001
      and _r1_tests.booked('2036-03-01') = 110,
    jsonb_build_array(retake_refused, retake_ok, retake_state)::text);
  perform _r1_tests.fail_live();
  perform _r1_tests.cancel(sent);
end;
$$;

-- Finding 4 (P2): outstanding holds are month-agnostic. A July hold whose link is
-- still alive in September must count against a September Send. A hold whose link
-- has LAPSED must not, even before any sweep (stored held_minutes stays 55): it
-- would otherwise shrink every later month's allocation until something sweeps.
-- Reissuing a lapsed link revives its hold, so it re-checks capacity as a fresh
-- 55; reissuing a link that is still alive changes nothing and is not checked.
do $$
declare
  july constant timestamptz := '2034-07-15T12:00:00Z';
  september constant timestamptz := '2034-09-15T12:00:00Z';
  h0 numeric; h1 numeric; held jsonb; lapsed jsonb; refused jsonb; admitted jsonb; at_send jsonb; need integer;
  at_reissue jsonb; need_reissue integer; reissue_refused jsonb; reissue_ok jsonb; live_reissue jsonb;
  lapsed_id uuid; held_id uuid;
begin
  perform _r1_tests.cand(109, 'prior-month hold');
  perform _r1_tests.cand(110, 'later-month refused');
  perform _r1_tests.cand(111, 'later-month control');
  perform _r1_tests.cand(505, 'lapsed link hold');
  perform _r1_tests.settings('r1', 100000, 100000);
  h0 := _r1_tests.num(_r1_tests.snap(september, 0), 'outstanding_holds');
  held := _r1_tests.send_until(_r1_tests.u(109), 'p4-july', july, '2034-10-01T00:00:00Z');
  lapsed := _r1_tests.send(_r1_tests.u(505), 'p4-lapsed', july);
  held_id := (held->>'id')::uuid;
  lapsed_id := (lapsed->>'id')::uuid;
  h1 := _r1_tests.num(_r1_tests.snap(september, 0), 'outstanding_holds');
  at_send := _r1_tests.snap(september, 55);
  need := ceil(_r1_tests.num(at_send, 'r1_committed'));
  perform _r1_tests.settings('r1', need - 1, 100000);
  refused := _r1_tests.send(_r1_tests.u(110), 'p4-september-refused', september);
  perform _r1_tests.settings('r1', need, 100000);
  admitted := _r1_tests.send(_r1_tests.u(111), 'p4-september-control', september);
  at_reissue := _r1_tests.snap(september, 55);
  need_reissue := ceil(_r1_tests.num(at_reissue, 'r1_committed'));
  perform _r1_tests.settings('r1', need_reissue - 1, 100000);
  reissue_refused := screening_v2.r1_transition_round(lapsed_id, 'reissue',
    (select version from screening_v2.interview_rounds where id = lapsed_id),
    encode(sha256('r1-capacity-p4-reissue-a'::bytea), 'hex'), september + interval '5 days', september);
  perform _r1_tests.settings('r1', need_reissue, 100000);
  reissue_ok := screening_v2.r1_transition_round(lapsed_id, 'reissue',
    (select version from screening_v2.interview_rounds where id = lapsed_id),
    encode(sha256('r1-capacity-p4-reissue-b'::bytea), 'hex'), september + interval '5 days', september);
  perform _r1_tests.settings('r1', 1, 100000);
  live_reissue := screening_v2.r1_transition_round(held_id, 'reissue',
    (select version from screening_v2.interview_rounds where id = held_id),
    encode(sha256('r1-capacity-p4-reissue-c'::bytea), 'hex'), september + interval '5 days', september);
  perform _r1_tests.assert('finding 4: a prior-month hold with a live link is counted, a lapsed link is not (even unswept), and reissuing a lapsed link re-checks capacity',
    held->>'status' = 'ok' and lapsed->>'status' = 'ok' and h1 - h0 = 55
      and (select held_minutes = 55 and status = 'invited' from screening_v2.interview_rounds where id = lapsed_id)
      and refused->>'status' = 'capacity_exhausted' and admitted->>'status' = 'ok'
      and need = h1 + 55
      and reissue_refused->>'status' = 'capacity_exhausted' and reissue_ok->>'status' = 'ok'
      and live_reissue->>'status' = 'ok',
    jsonb_build_array(held, lapsed, h0, h1, refused, admitted, reissue_refused, reissue_ok, live_reissue)::text);
  perform _r1_tests.cancel(held);
  perform _r1_tests.cancel(admitted);
  perform _r1_tests.cancel(lapsed);
end;
$$;

-- Finding 5 (P2): reconciliation adds ALL estimated growth since the dashboard
-- reading (phone and legacy too), not just R1 ledger rows. Reading 2000 was taken
-- when the estimate was 1441; 961 more minutes accrued since, so the guard is
-- max(2000, 2000 + 961 x 1.15, 2402 x 1.15) = 3105.15 (net of holds). 0117
-- ignored the growth (2762.3).
do $$
declare
  m constant timestamptz := '2034-10-15T12:00:00Z';
  at_send jsonb; need integer; refused jsonb; admitted jsonb;
begin
  perform _r1_tests.cand(112, 'reconciliation refused');
  perform _r1_tests.cand(113, 'reconciliation control');
  perform _r1_tests.add_session(_r1_tests.u(305), _r1_tests.u(11), null, '2034-10-01T00:00:00Z', '2034-10-01T12:00:00Z');
  perform _r1_tests.settings('cloud', 100000, 100000);
  update screening_v2.r1_settings
     set dashboard_minutes = 2000, dashboard_read_at = '2034-10-02T00:00:00Z', dashboard_estimate_baseline = 1441;
  perform _r1_tests.add_session(_r1_tests.u(306), _r1_tests.u(11), null, '2034-10-10T00:00:00Z', '2034-10-10T08:00:00Z');
  at_send := _r1_tests.snap(m, 55);
  need := ceil(_r1_tests.num(at_send, 'pool_committed'));
  update screening_v2.r1_settings set pause_line_minutes = need - 1;
  refused := _r1_tests.send(_r1_tests.u(112), 'p5-refused', m);
  update screening_v2.r1_settings set pause_line_minutes = need;
  admitted := _r1_tests.send(_r1_tests.u(113), 'p5-control', m);
  perform _r1_tests.assert('finding 5: reconciliation counts all estimated growth since the dashboard reading',
    refused->>'status' = 'capacity_exhausted' and admitted->>'status' = 'ok'
      and abs(_r1_tests.net(at_send, 'pool_committed') - 3105.15) < 0.001,
    jsonb_build_array(refused, admitted, at_send)::text);
  perform _r1_tests.cancel(admitted);
end;
$$;

-- Finding 6 (P3): a prior-month dashboard reading is stale, and the authoritative
-- dashboard figure is not multiplied by 1.15. The stale November reading of 3990
-- WOULD refuse a December Send at a 4000 line if it applied (3990 + 55 = 4045),
-- so admitting proves it is ignored (0117 applied it x1.15 = 4588). In the
-- reading's own month the guard is exactly 3000 (not 3450) with no growth.
do $$
declare
  december constant timestamptz := '2034-12-02T12:00:00Z';
  january constant timestamptz := '2035-01-15T12:00:00Z';
  stale_state jsonb; stale jsonb; at_send jsonb; need integer; exact_fit jsonb; one_short jsonb;
begin
  perform _r1_tests.cand(114, 'stale reading');
  perform _r1_tests.cand(115, 'exact fit');
  perform _r1_tests.cand(116, 'one short');
  perform _r1_tests.settings('cloud', 100000, 4000);
  update screening_v2.r1_settings
     set dashboard_minutes = 3990, dashboard_read_at = '2034-11-20T12:00:00Z', dashboard_estimate_baseline = 0;
  stale_state := _r1_tests.snap(december, 55);
  stale := _r1_tests.send(_r1_tests.u(114), 'p6-stale', december);
  -- Holds are global: release this one before the next scenario counts holds.
  perform _r1_tests.cancel(stale);
  perform _r1_tests.settings('cloud', 100000, 100000);
  update screening_v2.r1_settings
     set dashboard_minutes = 3000, dashboard_read_at = '2035-01-02T12:00:00Z', dashboard_estimate_baseline = 0;
  at_send := _r1_tests.snap(january, 55);
  need := ceil(_r1_tests.num(at_send, 'pool_committed'));
  update screening_v2.r1_settings set pause_line_minutes = need;
  exact_fit := _r1_tests.send(_r1_tests.u(115), 'p6-exact', january);
  perform _r1_tests.cancel(exact_fit);
  update screening_v2.r1_settings set pause_line_minutes = need - 1;
  one_short := _r1_tests.send(_r1_tests.u(116), 'p6-one-short', january);
  perform _r1_tests.assert('finding 6: a stale prior-month dashboard reading is ignored and the dashboard figure is not multiplied by 1.15',
    stale->>'status' = 'ok' and not (stale_state->>'dashboard_applies')::boolean
      and _r1_tests.net(stale_state, 'pool_committed') = 0
      and exact_fit->>'status' = 'ok' and one_short->>'status' = 'capacity_exhausted'
      and (at_send->>'dashboard_applies')::boolean and _r1_tests.net(at_send, 'pool_committed') = 3000,
    jsonb_build_array(stale, exact_fit, one_short, stale_state, at_send)::text);
end;
$$;

-- Guard floors and the NULL baseline. (a) the 1.15 x estimate floor binds when a
-- reading is small: reading 100 at baseline 1441 with 1441 now gives
-- 1657.15, not 100. (b) the authoritative floor binds when the estimate has
-- SHRUNK below its baseline (a revised session, a purged row): 3000 + 1.15 x
-- (1441 - 2000) = 2357.15 must not undercut the reading, so the guard is 3000.
-- (c) a current-month reading with no baseline (entered under 0117) applies, with
-- "baseline = the estimate now": 3500, not the bare estimate. Each has a Send
-- edge computed from the snapshot, plus the exact literal.
do $$
declare
  m constant timestamptz := '2035-06-15T12:00:00Z';
  a_state jsonb; b_state jsonb; c_state jsonb; need_a integer; a_refused jsonb; a_ok jsonb;
begin
  perform _r1_tests.cand(512, 'guard floor refused');
  perform _r1_tests.cand(513, 'guard floor ok');
  perform _r1_tests.add_session(_r1_tests.u(701), _r1_tests.u(11), null, '2035-06-05T00:00:00Z', '2035-06-05T12:00:00Z');
  perform _r1_tests.settings('cloud', 100000, 100000);
  update screening_v2.r1_settings
     set dashboard_minutes = 100, dashboard_read_at = '2035-06-02T00:00:00Z', dashboard_estimate_baseline = 1441;
  a_state := _r1_tests.snap(m, 55);
  need_a := ceil(_r1_tests.num(a_state, 'pool_committed'));
  update screening_v2.r1_settings set pause_line_minutes = need_a - 1;
  a_refused := _r1_tests.send(_r1_tests.u(512), 'floor-a-refused', m);
  update screening_v2.r1_settings set pause_line_minutes = need_a;
  a_ok := _r1_tests.send(_r1_tests.u(513), 'floor-a-ok', m);
  perform _r1_tests.cancel(a_ok);
  update screening_v2.r1_settings set dashboard_minutes = 3000, dashboard_estimate_baseline = 2000;
  b_state := _r1_tests.snap(m, 0);
  update screening_v2.r1_settings set dashboard_minutes = 3500, dashboard_estimate_baseline = null;
  c_state := _r1_tests.snap(m, 0);
  perform _r1_tests.assert('guard floor: a small reading cannot undercut 1.15 x the estimate',
    a_refused->>'status' = 'capacity_exhausted' and a_ok->>'status' = 'ok'
      and abs(_r1_tests.num(a_state, 'pool_guard') - 1657.15) < 0.001
      and abs(_r1_tests.net(a_state, 'pool_committed') - 1657.15) < 0.001,
    jsonb_build_array(a_refused, a_ok, a_state)::text);
  perform _r1_tests.assert('guard floor: an estimate that shrank below its baseline cannot lower the guard under the authoritative reading',
    abs(_r1_tests.num(b_state, 'pool_guard') - 3000) < 0.001, b_state::text);
  perform _r1_tests.assert('a current-month reading with no baseline applies as baseline = the estimate now',
    (c_state->>'dashboard_applies')::boolean and abs(_r1_tests.num(c_state, 'pool_guard') - 3500) < 0.001, c_state::text);
end;
$$;

-- Dashboard baseline and live floors. A live R1 session that has not metered yet
-- counts at its 55-minute floor, which the metering later REPLACES. If the
-- baseline contained the floor, the replacement would show as negative growth and
-- pull the guard under the authoritative reading. The baseline is therefore taken
-- net of live floors: reading 3000 stamped with a live session gives baseline 0
-- and guard 3000 + 55 = 3055 (the floor is a booked charge: counted once, never
-- x1.15); after 5 + 5 metered minutes it is 3000 + 1.15 x 10 = 3011.5, never under
-- 3000 (the floored baseline gave 2948.25).
do $$
declare
  owner constant uuid := '10000000-0000-4000-8000-000000000001';
  m constant timestamptz := '2036-04-12T12:00:00Z';
  live_round uuid := _r1_tests.u(602); live_session uuid := _r1_tests.u(702);
  stamp jsonb; live_state jsonb; null_state jsonb; metered_state jsonb; stored numeric;
begin
  perform _r1_tests.cand(506, 'baseline live floor');
  insert into screening_v2.interview_rounds(id, candidate_id, role_id, link_token_digest, expires_at, created_by, status)
    values (live_round, _r1_tests.u(506), '10000000-0000-4000-8000-000000000002',
            encode(sha256('r1-capacity-baseline-live-round'::bytea), 'hex'), '2036-04-30T00:00:00Z', owner, 'in_progress');
  perform _r1_tests.add_session(live_session, _r1_tests.u(506), live_round, '2036-04-10T08:00:00Z', null);
  perform _r1_tests.settings('cloud', 100000, 100000);
  stamp := screening_v2.r1_stamp_dashboard_reading(3000, owner, m);
  live_state := _r1_tests.snap(m, 0);
  select dashboard_estimate_baseline into stored from screening_v2.r1_settings;
  -- A reading with NO stored baseline (entered under 0117 and not migrated, or written around the RPC)
  -- takes "the estimate now, net of live floors" as its baseline, so the live floor still adds on top:
  -- 3000 + 55. Ignoring the NULL (greatest() skips NULLs) would give 3000.
  update screening_v2.r1_settings set dashboard_estimate_baseline = null;
  null_state := _r1_tests.snap(m, 0);
  update screening_v2.r1_settings set dashboard_estimate_baseline = stored;
  insert into screening_v2.r1_usage_ledger(session_id, round_id, participant_kind, event, seconds, event_key, occurred_at) values
    (live_session, live_round, 'candidate', 'usage', 300, 'r1-baseline-candidate', '2036-04-10T08:10:00Z'),
    (live_session, live_round, 'agent', 'usage', 300, 'r1-baseline-agent', '2036-04-10T08:10:00Z');
  metered_state := _r1_tests.snap(m, 0);
  perform _r1_tests.assert('dashboard baseline excludes live floors and the guard never falls below the authoritative reading',
    stamp->>'status' = 'ok' and stored = 0
      and abs(_r1_tests.num(live_state, 'pool_guard') - 3055) < 0.001
      and abs(_r1_tests.num(metered_state, 'pool_guard') - 3011.5) < 0.001
      and _r1_tests.num(metered_state, 'pool_guard') >= 3000,
    jsonb_build_array(stamp, stored, live_state, metered_state)::text);
  perform _r1_tests.assert('a reading with no stored baseline takes the estimate now (net of live floors) as its baseline',
    (null_state->>'dashboard_applies')::boolean and abs(_r1_tests.num(null_state, 'pool_guard') - 3055) < 0.001,
    null_state::text);
  perform _r1_tests.fail_live();
end;
$$;

-- Ledger kinds: manual_test and preflight minutes are Cloud-pool minutes but not
-- R1 session minutes (the plan formula already subtracts planned tests from the
-- session cap). 12 x 30 test minutes + 10 s of preflight in a month: the pool
-- estimate carries them (x1.15), the R1 allocation does not, so a Send fits an
-- allocation of exactly the outstanding holds + 55.
do $$
declare
  m constant timestamptz := '2036-05-15T12:00:00Z';
  state jsonb; need integer; admitted jsonb;
begin
  perform _r1_tests.cand(507, 'test minutes');
  insert into screening_v2.r1_usage_ledger(participant_kind, event, seconds, event_key, occurred_at)
    select 'manual_test', 'usage', 1800, 'r1-kinds-test-' || n::text, '2036-05-10T10:00:00Z' from generate_series(1, 12) n;
  insert into screening_v2.r1_usage_ledger(participant_kind, event, seconds, event_key, occurred_at)
    values ('preflight', 'usage', 10, 'r1-kinds-preflight', '2036-05-10T10:00:00Z');
  state := _r1_tests.snap(m, 55);
  need := ceil(_r1_tests.num(state, 'r1_committed'));
  perform _r1_tests.settings('r1', need, 1);
  admitted := _r1_tests.send(_r1_tests.u(507), 'kinds', m);
  perform _r1_tests.assert('ledger kinds: manual_test and preflight minutes count against the pool only, not the R1 allocation',
    admitted->>'status' = 'ok'
      and _r1_tests.num(state, 'r1_actual') = 0
      and abs(_r1_tests.num(state, 'r1_test_minutes') - (360 + 10 / 60.0)) < 0.001
      and abs(_r1_tests.num(state, 'pool_pure') - (360 + 10 / 60.0)) < 0.001
      and abs(_r1_tests.num(state, 'pool_guard') - (360 + 10 / 60.0) * 1.15) < 0.001
      and need = _r1_tests.num(state, 'outstanding_holds') + 55,
    jsonb_build_array(admitted, state)::text);
  perform _r1_tests.cancel(admitted);
end;
$$;

-- r1_committed = greatest(minutes_used, 1.15 x r1_actual) + holds: the booked
-- minutes and the metered ones describe the SAME sessions, so they must not add.
-- 55 booked and a 10-minute session in the month: 55 (not 66.5). A sum would
-- need 121.5; the edge is exactly holds + 55 + 55.
do $$
declare
  m constant timestamptz := '2036-06-15T12:00:00Z';
  round_k uuid; state jsonb; need integer; refused jsonb; admitted jsonb;
begin
  perform _r1_tests.cand(508, 'greatest not sum');
  round_k := _r1_tests.dead_round(603, _r1_tests.u(508));
  perform _r1_tests.add_session(_r1_tests.u(703), _r1_tests.u(11), round_k, '2036-06-10T09:00:00Z', '2036-06-10T09:10:00Z');
  insert into screening_v2.r1_usage_ledger(session_id, round_id, participant_kind, event, seconds, event_key, occurred_at)
    values (_r1_tests.u(703), round_k, 'agent', 'usage', 600, 'r1-greatest-agent', '2036-06-10T09:10:00Z');
  insert into screening_v2.r1_budget_month(month_start, minutes_used) values ('2036-06-01', 55)
    on conflict (month_start) do update set minutes_used = 55;
  state := _r1_tests.snap(m, 55);
  need := ceil(_r1_tests.num(state, 'r1_committed'));
  perform _r1_tests.settings('r1', need - 1, 1);
  refused := _r1_tests.send(_r1_tests.u(508), 'greatest-refused', m);
  perform _r1_tests.settings('r1', need, 1);
  admitted := _r1_tests.send(_r1_tests.u(508), 'greatest-ok', m);
  perform _r1_tests.assert('r1_committed takes the greater of booked and 1.15 x metered minutes, never their sum',
    refused->>'status' = 'capacity_exhausted' and admitted->>'status' = 'ok'
      and abs(_r1_tests.net(state, 'r1_committed') - 55) < 0.001
      and need = _r1_tests.num(state, 'outstanding_holds') + 55 + 55,
    jsonb_build_array(refused, admitted, state)::text);
  perform _r1_tests.cancel(admitted);
end;
$$;

-- Finding 7 (P3): the view's guard must be the RPC guard (and Mission Control must
-- read the RPC's committed terms). With a reading of 1,000,000 stamped at baseline
-- 0 the guard is 1,000,000 + 1.15 x the estimate; 0117's view showed only
-- greatest(estimate, dashboard) = 1,000,000. Then every exposed term must equal
-- the shared snapshot's. The current month must also be present when it has no
-- budget row yet (first of the month, or a prior-month hold converted this month).
do $$
declare
  role_r1 constant uuid := '10000000-0000-4000-8000-000000000002';
  held jsonb; pure numeric; expected_guard numeric; snap jsonb; v record; empty_row record; empty_snap jsonb;
begin
  perform _r1_tests.cand(119, 'view parity');
  perform _r1_tests.settings('cloud', 100000, 2000000);
  insert into screening_v2.r1_usage_ledger(participant_kind, event, seconds, event_key)
    values ('manual_test', 'usage', 600, 'r1-view-parity');
  update screening_v2.r1_settings
     set dashboard_minutes = 1000000, dashboard_read_at = now(), dashboard_estimate_baseline = 0;
  held := _r1_tests.send(_r1_tests.u(119), 'p7-view', now());
  select e.r1_minutes + e.phone_minutes + e.legacy_browser_minutes into pure
    from screening_v2.v_webrtc_minutes_estimate e where e.month_start = date_trunc('month', now())::date;
  expected_guard := 1000000 + pure * 1.15;
  select * into v from screening_v2.v_r1_budget_month where month_start = date_trunc('month', now())::date;
  perform _r1_tests.assert('finding 7: the view guard equals the RPC guard rule',
    held->>'status' = 'ok' and pure >= 10 and abs(v.guarded_minutes - expected_guard) < 0.01,
    jsonb_build_array(v.guarded_minutes, expected_guard)::text);
  snap := screening_v2.r1_capacity_snapshot(now(), 0);
  perform _r1_tests.assert('finding 7: every view term equals the shared snapshot',
    v.r1_committed = (snap->>'r1_committed')::numeric
    and v.pool_committed = (snap->>'pool_committed')::numeric
    and v.pool_guard = (snap->>'pool_guard')::numeric
    and v.outstanding_holds = (snap->>'outstanding_holds')::numeric
    and v.r1_headroom = (snap->>'r1_headroom')::numeric
    and v.pool_headroom = (snap->>'pool_headroom')::numeric
    and v.pool_check_applies and v.outstanding_holds >= 55
    and v.r1_headroom = v.monthly_cap_minutes - v.r1_committed
    and v.pool_headroom = v.pause_line_minutes - v.pool_committed,
    snap::text);
  perform _r1_tests.cancel(held);
  perform _r1_tests.settings('r1', 10000, 10000);
  -- No budget row for the current month: the view still reports it, from the snapshot.
  delete from screening_v2.r1_budget_month where month_start = date_trunc('month', now())::date;
  select * into empty_row from screening_v2.v_r1_budget_month where month_start = date_trunc('month', now())::date;
  empty_snap := screening_v2.r1_capacity_snapshot(now(), 0);
  perform _r1_tests.assert('finding 7: the current month is reported even before its budget row exists',
    empty_row.month_start is not null and empty_row.minutes_reserved = 0 and empty_row.minutes_used = 0
      and empty_row.starts_admitted = 0 and empty_row.monthly_cap_minutes = 10000
      and empty_row.r1_committed = (empty_snap->>'r1_committed')::numeric
      and empty_row.pool_committed = (empty_snap->>'pool_committed')::numeric
      and empty_row.pool_check_applies is not null,
    empty_snap::text);
end;
$$;

-- Finding 8 (P3) and the no-show rule (plan 5.11: "not counted; the hold is kept
-- for the link"). The first start converts the Send hold (booked 55). If that
-- attempt ends without counting, the 55 is a HOLD kept for the link, not a
-- spend: it leaves minutes_used and joins the outstanding holds, and a restart
-- takes it back (no second 55). The attempt rows are purged before the restart (a
-- retention purge cascades from call_sessions): the marker lives on the round, so
-- the restart still re-uses the booked charge; a rule derived from the attempt
-- rows would charge again. A counted attempt's 55 stays; a retake is a NEW attempt
-- number and takes a fresh 55; the retake's own uncounted end is refunded exactly
-- once when the round is cancelled.
do $$
declare
  february constant timestamptz := '2035-02-15T12:00:00Z';
  sent jsonb; rid uuid; first_start jsonb; refused_restart jsonb; restart jsonb; retake jsonb;
  h_before numeric; noshow_state jsonb; after_cancel_state jsonb; refund_again jsonb;
  used_first numeric; used_restart numeric; used_retake numeric; used_cancelled numeric; used_again numeric;
  admitted_restart integer; marker_final integer;
begin
  perform _r1_tests.cand(118, 'restart charge');
  perform _r1_tests.settings('r1', 100000, 100000);
  h_before := _r1_tests.num(_r1_tests.snap(february, 0), 'outstanding_holds');
  sent := _r1_tests.send(_r1_tests.u(118), 'p8', february);
  rid := (sent->>'id')::uuid;
  perform _r1_tests.consent(rid);
  first_start := _r1_tests.admit(rid, 'p8-first', february);
  used_first := _r1_tests.booked('2035-02-01');
  -- No-show: the session ends and the attempt never counted.
  perform _r1_tests.fail_live();
  noshow_state := _r1_tests.snap(february, 0);
  delete from screening_v2.interview_round_attempts where round_id = rid;
  -- A restart is subject to the same checks as a converted hold: refused above the Cloud pause line.
  perform _r1_tests.settings('cloud', 100000, 1);
  refused_restart := _r1_tests.admit(rid, 'p8-restart-refused', february);
  perform _r1_tests.settings('r1', 100000, 100000);
  restart := _r1_tests.admit(rid, 'p8-restart', february);
  used_restart := _r1_tests.booked('2035-02-01');
  select starts_admitted into admitted_restart from screening_v2.r1_budget_month where month_start = '2035-02-01';
  perform _r1_tests.fail_live();
  -- Attempt 1 counts; the retake is attempt 2 and takes a fresh 55.
  update screening_v2.interview_round_attempts set counted = true where session_id = (restart->>'session_id')::uuid;
  update screening_v2.interview_rounds set attempts_counted = 1 where id = rid;
  retake := _r1_tests.admit(rid, 'p8-retake', february);
  used_retake := _r1_tests.booked('2035-02-01');
  perform _r1_tests.fail_live();
  -- The retake ended without counting; cancelling the link gives back exactly that 55, once.
  perform _r1_tests.cancel(sent);
  used_cancelled := _r1_tests.booked('2035-02-01');
  refund_again := screening_v2.r1_release_round_hold(rid);
  after_cancel_state := _r1_tests.snap(february, 0);
  used_again := _r1_tests.booked('2035-02-01');
  select charged_attempt_number into marker_final from screening_v2.interview_rounds where id = rid;
  perform _r1_tests.assert('finding 8: an uncounted restart does not double-charge (also after its attempt rows were deleted), a counted retake does',
    first_start->>'status' = 'ok' and restart->>'status' = 'ok' and retake->>'status' = 'ok'
      and (restart->>'attempt_number')::integer = 1 and (retake->>'attempt_number')::integer = 2
      and used_first = 55 and used_restart = 55 and admitted_restart = 1 and used_retake = 110,
    jsonb_build_array(first_start, restart, retake, used_first, used_restart, admitted_restart, used_retake)::text);
  perform _r1_tests.assert('an uncounted restart is subject to the same checks as a converted hold',
    refused_restart->>'status' = 'capacity_exhausted', refused_restart::text);
  perform _r1_tests.assert('no-show: the charge of an attempt that ended uncounted is a hold kept for the link, not a spend',
    _r1_tests.num(noshow_state, 'uncounted_charges') = 1
      and _r1_tests.num(noshow_state, 'booked_minutes_used') = 55 and _r1_tests.num(noshow_state, 'minutes_used') = 0
      and _r1_tests.num(noshow_state, 'restored_holds') = 55
      and _r1_tests.num(noshow_state, 'outstanding_holds') - h_before = 55,
    noshow_state::text);
  perform _r1_tests.assert('no-show: cancelling the link refunds the uncounted charge exactly once and leaves the counted attempt booked',
    used_cancelled = 55 and used_again = 55 and (refund_again->>'refunded')::numeric = 0 and marker_final = 1
      and _r1_tests.num(after_cancel_state, 'uncounted_charges') = 0
      and _r1_tests.num(after_cancel_state, 'outstanding_holds') = h_before,
    jsonb_build_array(used_cancelled, used_again, refund_again, marker_final, after_cancel_state)::text);
end;
$$;

-- The sweep (far-past month so its p_now cannot touch any other suite's rounds).
-- A link that lapsed is released BEFORE any sweep by the snapshot itself, and the
-- sweep then tidies the stored counters: an unopened invited link expires and its
-- hold is released; a no-show round that is still in progress with a lapsed link
-- (or with all three starts used, which is dead while its link lives: it holds
-- nothing before the sweep either) has its uncounted charge refunded and keeps
-- its status. A second sweep finds nothing (exactly once).
do $$
declare
  sent_at constant timestamptz := '2020-01-02T00:00:00Z';
  expires constant timestamptz := '2020-01-05T00:00:00Z';
  admit_at constant timestamptz := '2020-01-03T00:00:00Z';
  alive constant timestamptz := '2020-01-04T00:00:00Z';
  lapsed constant timestamptz := '2020-01-10T00:00:00Z';
  noshow jsonb; unopened jsonb; exhausted jsonb; rid_noshow uuid; rid_unopened uuid; rid_exhausted uuid; first_start jsonb;
  ex_starts text[];
  h_alive0 numeric; h_lapsed0 numeric; h_alive numeric; h_lapsed numeric; swept integer; swept_again integer;
  reserved_before numeric; booked_before numeric; reserved_after numeric; booked_after numeric; i integer;
begin
  perform _r1_tests.cand(509, 'sweep no-show');
  perform _r1_tests.cand(510, 'sweep unopened');
  perform _r1_tests.cand(511, 'sweep starts exhausted');
  perform _r1_tests.settings('r1', 100000, 100000);
  -- Earlier suites may leave a dead round with a charge to give back (for example the foundation
  -- block's third start, which completed without counting): sweep those first so the counts below
  -- are exactly this scenario's.
  perform screening_v2.r1_sweep_expired_rounds(lapsed, 1000);
  h_alive0 := _r1_tests.num(_r1_tests.snap(alive, 0), 'outstanding_holds');
  h_lapsed0 := _r1_tests.num(_r1_tests.snap(lapsed, 0), 'outstanding_holds');
  noshow := _r1_tests.send_until(_r1_tests.u(509), 'sw-noshow', sent_at, expires);
  unopened := _r1_tests.send_until(_r1_tests.u(510), 'sw-unopened', sent_at, expires);
  rid_noshow := (noshow->>'id')::uuid;
  rid_unopened := (unopened->>'id')::uuid;
  perform _r1_tests.consent(rid_noshow, '2020-01-01T00:00:00Z');
  first_start := _r1_tests.admit(rid_noshow, 'sw-first', admit_at);
  perform _r1_tests.fail_live();
  -- Three starts, none counted: the link is alive but can never be started again, so it holds nothing.
  exhausted := _r1_tests.send_until(_r1_tests.u(511), 'sw-exhausted', sent_at, expires);
  rid_exhausted := (exhausted->>'id')::uuid;
  perform _r1_tests.consent(rid_exhausted, '2020-01-01T00:00:00Z');
  ex_starts := array[]::text[];
  for i in 1..3 loop
    ex_starts := ex_starts || (_r1_tests.admit(rid_exhausted, 'sw-ex-' || i::text, admit_at)->>'status');
    perform _r1_tests.fail_live();
  end loop;
  h_alive := _r1_tests.num(_r1_tests.snap(alive, 0), 'outstanding_holds');
  h_lapsed := _r1_tests.num(_r1_tests.snap(lapsed, 0), 'outstanding_holds');
  select minutes_reserved, minutes_used into reserved_before, booked_before
    from screening_v2.r1_budget_month where month_start = '2020-01-01';
  swept := screening_v2.r1_sweep_expired_rounds(lapsed, 1000);
  swept_again := screening_v2.r1_sweep_expired_rounds(lapsed, 1000);
  select minutes_reserved, minutes_used into reserved_after, booked_after
    from screening_v2.r1_budget_month where month_start = '2020-01-01';
  perform _r1_tests.assert('the sweep releases a lapsed hold and refunds a lapsed no-show charge, once, and the snapshot never needed it',
    noshow->>'status' = 'ok' and unopened->>'status' = 'ok' and first_start->>'status' = 'ok'
      and exhausted->>'status' = 'ok' and ex_starts = array['ok', 'ok', 'ok']
      and (select starts_used = 3 from screening_v2.interview_rounds where id = rid_exhausted)
      and h_alive - h_alive0 = 110 and h_lapsed = h_lapsed0
      and reserved_before = 55 and booked_before = 110 and reserved_after = 0 and booked_after = 0
      and swept = 3 and swept_again = 0
      and (select status = 'expired' and held_minutes = 0 from screening_v2.interview_rounds where id = rid_unopened)
      and (select count(*) = 2 from screening_v2.interview_rounds
            where id in (rid_noshow, rid_exhausted) and status = 'in_progress' and held_minutes = 0
              and charged_attempt_number = attempts_counted),
    jsonb_build_array(h_alive - h_alive0, h_lapsed - h_lapsed0, reserved_before, booked_before, reserved_after, booked_after, swept, swept_again, ex_starts)::text);
end;
$$;

-- The snapshot's own arithmetic: ledger minutes are month-scoped (the June row
-- must not count in May), R1 terms carry the 1.15 multiplier, Mode A has no pool
-- check, and the requested change is applied before the checks. 30 metered R1
-- minutes -> 34.5; a Send adds its hold on top (net of holds the term is still
-- 34.5; the headroom is the limit less everything committed).
do $$
declare
  round_arith uuid; s jsonb;
begin
  perform _r1_tests.cand(609, 'snapshot arithmetic');
  round_arith := _r1_tests.dead_round(604, _r1_tests.u(609));
  perform _r1_tests.add_session(_r1_tests.u(704), _r1_tests.u(609), round_arith, '2035-05-10T09:00:00Z', '2035-05-10T09:30:00Z');
  perform _r1_tests.settings('r1', 100000, 100000);
  insert into screening_v2.r1_usage_ledger(session_id, round_id, participant_kind, event, seconds, event_key, occurred_at) values
    (_r1_tests.u(704), round_arith, 'candidate', 'usage', 1800, 'r1-arith-may', '2035-05-10T10:00:00Z'),
    (_r1_tests.u(704), round_arith, 'candidate', 'usage', 1800, 'r1-arith-june', '2035-06-10T10:00:00Z');
  s := _r1_tests.snap('2035-05-15T12:00:00Z', 55);
  perform _r1_tests.assert('snapshot arithmetic: month-scoped ledger, 1.15 on estimates, headroom, Mode A has no pool check',
    _r1_tests.num(s, 'r1_ledger_minutes') = 30 and _r1_tests.num(s, 'r1_actual') = 30
    and _r1_tests.num(s, 'pool_pure') = 30 and _r1_tests.num(s, 'pool_guard') = 34.5
    and _r1_tests.net(s, 'r1_committed') = 34.5 and _r1_tests.net(s, 'pool_committed') = 34.5
    and _r1_tests.num(s, 'extra_hold') = 55
    and _r1_tests.num(s, 'r1_headroom') = 100000 - _r1_tests.num(s, 'r1_committed')
    and _r1_tests.num(s, 'r1_headroom') = 100000 - 34.5 - 55 - _r1_tests.num(s, 'outstanding_holds')
    and not (s->>'pool_check_applies')::boolean and (s->>'admits')::boolean
    and (s->>'dashboard_applies')::boolean = false,
    s::text);
end;
$$;

-- The dashboard stamp is database-owned: it records the database clock and the
-- database's own pool estimate atomically, only when the reading changes (or was
-- never stamped), and rejects values the numeric(10,2) column cannot hold.
do $$
declare
  owner constant uuid := '10000000-0000-4000-8000-000000000001';
  first_stamp jsonb; unchanged jsonb; changed jsonb; invalid jsonb; rolled jsonb; rolled_baseline numeric; s record;
begin
  perform _r1_tests.settings('cloud', 100000, 100000);
  perform _r1_tests.add_session(_r1_tests.u(307), _r1_tests.u(11), null, '2035-04-05T00:00:00Z', '2035-04-05T12:00:00Z');
  first_stamp := screening_v2.r1_stamp_dashboard_reading(2500, owner, '2035-04-15T12:00:00Z');
  select * into s from screening_v2.r1_settings;
  perform _r1_tests.assert('dashboard stamp records the database clock and pool estimate',
    first_stamp->>'status' = 'ok' and (first_stamp->>'changed')::boolean
      and s.dashboard_minutes = 2500 and s.dashboard_read_at = '2035-04-15T12:00:00Z'
      and s.dashboard_estimate_baseline = 1441 and s.updated_by = owner,
    first_stamp::text);
  perform _r1_tests.add_session(_r1_tests.u(308), _r1_tests.u(11), null, '2035-04-06T00:00:00Z', '2035-04-06T08:00:00Z');
  unchanged := screening_v2.r1_stamp_dashboard_reading(2500, owner, '2035-04-20T12:00:00Z');
  select * into s from screening_v2.r1_settings;
  perform _r1_tests.assert('re-saving an unchanged dashboard reading does not reset its baseline',
    unchanged->>'status' = 'ok' and not (unchanged->>'changed')::boolean
      and s.dashboard_read_at = '2035-04-15T12:00:00Z' and s.dashboard_estimate_baseline = 1441,
    unchanged::text);
  changed := screening_v2.r1_stamp_dashboard_reading(2600, owner, '2035-04-20T12:00:00Z');
  select * into s from screening_v2.r1_settings;
  perform _r1_tests.assert('a changed dashboard reading is re-stamped with the new estimate',
    (changed->>'changed')::boolean and s.dashboard_minutes = 2600
      and s.dashboard_read_at = '2035-04-20T12:00:00Z' and s.dashboard_estimate_baseline = 2402,
    changed::text);
  invalid := screening_v2.r1_stamp_dashboard_reading(-1, owner, '2035-04-21T12:00:00Z');
  select * into s from screening_v2.r1_settings;
  perform _r1_tests.assert('an invalid dashboard reading is rejected without a write',
    invalid->>'status' = 'invalid_request' and s.dashboard_minutes = 2600,
    invalid::text);
  -- The same figure entered in a LATER month is that month's reading (the snapshot ignores the April one in
  -- May): it re-stamps instead of leaving a stale read_at that the snapshot would discard.
  rolled := screening_v2.r1_stamp_dashboard_reading(2600, owner, '2035-05-03T12:00:00Z');
  rolled_baseline := (_r1_tests.snap('2035-05-03T12:00:00Z', 0)->>'pool_settled')::numeric;
  select * into s from screening_v2.r1_settings;
  perform _r1_tests.assert('an unchanged dashboard figure entered in a later month is re-stamped for that month',
    rolled->>'status' = 'ok' and (rolled->>'changed')::boolean
      and s.dashboard_read_at = '2035-05-03T12:00:00Z' and s.dashboard_estimate_baseline = rolled_baseline
      and s.dashboard_estimate_baseline <> 2402 and (_r1_tests.snap('2035-05-03T12:00:00Z', 0)->>'dashboard_applies')::boolean,
    jsonb_build_array(rolled, rolled_baseline, s.dashboard_estimate_baseline)::text);
  perform _r1_tests.assert('capacity functions are service-role only and the refund helper is internal',
    has_function_privilege('service_role', 'screening_v2.r1_capacity_snapshot(timestamptz,numeric,numeric,numeric)', 'execute')
    and has_function_privilege('service_role', 'screening_v2.r1_stamp_dashboard_reading(numeric,uuid,timestamptz)', 'execute')
    and not has_function_privilege('anon', 'screening_v2.r1_capacity_snapshot(timestamptz,numeric,numeric,numeric)', 'execute')
    and not has_function_privilege('authenticated', 'screening_v2.r1_capacity_snapshot(timestamptz,numeric,numeric,numeric)', 'execute')
    and not has_function_privilege('anon', 'screening_v2.r1_stamp_dashboard_reading(numeric,uuid,timestamptz)', 'execute')
    and not has_function_privilege('authenticated', 'screening_v2.r1_stamp_dashboard_reading(numeric,uuid,timestamptz)', 'execute')
    and not has_function_privilege('service_role', 'screening_v2.r1_refund_uncounted_charge(uuid,timestamptz)', 'execute')
    and not has_function_privilege('anon', 'screening_v2.r1_refund_uncounted_charge(uuid,timestamptz)', 'execute')
    and not has_function_privilege('authenticated', 'screening_v2.r1_refund_uncounted_charge(uuid,timestamptz)', 'execute'));
  perform _r1_tests.settings('r1', 10000, 10000);
end;
$$;

-- ---------------------------------------------------------------------------
-- Gate review of PR-2b. One block per finding; each names the mutant it kills.
-- ---------------------------------------------------------------------------

-- Gate P1: Send and start must agree. A Send reserves 55; the start that converts
-- it exchanges the hold for a booked 55 plus a 55-minute live floor, which count
-- as 55 together (a floor is a booked charge, never x1.15), so a start that fit at
-- Send time fits again. The runbook's December example, scaled down: an allocation
-- of N x 55 on the first of a month (nothing booked, nothing metered), N Sends,
-- then every one of the N starts. With the floor multiplied by 1.15 each start
-- needed 63.25 against its 55 hold and ALL N were refused ("temporarily
-- unavailable, your link stays valid") until a link expired. Both modes; the limits
-- are pinned from the snapshot so stray holds cannot move them. Mutants killed: a
-- floor (live or p_extra_actual) multiplied by 1.15 in r1_estimate, pool_estimate
-- or the dashboard guard.
do $$
declare
  c_n constant integer := 4;
  m_a constant timestamptz := '2038-03-01T10:00:00Z';
  m_b constant timestamptz := '2038-04-01T10:00:00Z';
  s jsonb; rid uuid; i integer; line integer;
  rounds_a uuid[] := array[]::uuid[]; sends_a text[] := array[]::text[]; starts_a text[] := array[]::text[];
  rounds_b uuid[] := array[]::uuid[]; sends_b text[] := array[]::text[]; starts_b text[] := array[]::text[];
  extra_a text; extra_b text; booked_a numeric; booked_b numeric; ok_n text[] := array_fill('ok'::text, array[c_n]);
begin
  for i in 1..2 * c_n + 2 loop
    perform _r1_tests.cand(800 + i, 'first start of the month ' || i::text);
  end loop;
  -- Mode A: the allocation is the only check (the pause line of 1 must be irrelevant).
  perform _r1_tests.settings('r1', 100000, 1);
  line := ceil(_r1_tests.num(_r1_tests.snap(m_a, 0), 'r1_committed')) + c_n * 55;
  perform _r1_tests.settings('r1', line, 1);
  for i in 1..c_n loop
    s := _r1_tests.send(_r1_tests.u(800 + i), 'fom-a-send-' || i::text, m_a);
    sends_a := sends_a || (s->>'status');
    if s->>'status' = 'ok' then
      rid := (s->>'id')::uuid; rounds_a := rounds_a || rid; perform _r1_tests.consent(rid);
    end if;
  end loop;
  extra_a := (_r1_tests.send(_r1_tests.u(800 + c_n + 1), 'fom-a-extra', m_a))->>'status';
  foreach rid in array rounds_a loop
    starts_a := starts_a || ((_r1_tests.admit(rid, 'fom-a-start-' || rid::text, m_a))->>'status');
    perform _r1_tests.fail_live();
  end loop;
  booked_a := _r1_tests.booked('2038-03-01');
  foreach rid in array rounds_a loop perform _r1_tests.cancel(jsonb_build_object('status', 'ok', 'id', rid)); end loop;
  -- Mode B: the pool pause line is pinned the same way and the allocation is out of the way.
  perform _r1_tests.settings('cloud', 100000, 100000);
  line := ceil(_r1_tests.num(_r1_tests.snap(m_b, 0), 'pool_committed')) + c_n * 55;
  perform _r1_tests.settings('cloud', 100000, line);
  for i in 1..c_n loop
    s := _r1_tests.send(_r1_tests.u(800 + c_n + 1 + i), 'fom-b-send-' || i::text, m_b);
    sends_b := sends_b || (s->>'status');
    if s->>'status' = 'ok' then
      rid := (s->>'id')::uuid; rounds_b := rounds_b || rid; perform _r1_tests.consent(rid);
    end if;
  end loop;
  extra_b := (_r1_tests.send(_r1_tests.u(800 + 2 * c_n + 2), 'fom-b-extra', m_b))->>'status';
  foreach rid in array rounds_b loop
    starts_b := starts_b || ((_r1_tests.admit(rid, 'fom-b-start-' || rid::text, m_b))->>'status');
    perform _r1_tests.fail_live();
  end loop;
  booked_b := _r1_tests.booked('2038-04-01');
  foreach rid in array rounds_b loop perform _r1_tests.cancel(jsonb_build_object('status', 'ok', 'id', rid)); end loop;
  perform _r1_tests.assert('gate P1 (Mode A): an allocation of N x 55 admits N Sends and then all N starts on the first of the month, and refuses the next Send',
    sends_a = ok_n and extra_a = 'capacity_exhausted' and starts_a = ok_n and booked_a = c_n * 55,
    jsonb_build_array(sends_a, extra_a, starts_a, booked_a)::text);
  perform _r1_tests.assert('gate P1 (Mode B): a pause line of N x 55 admits N Sends and then all N starts on the first of the month, and refuses the next Send',
    sends_b = ok_n and extra_b = 'capacity_exhausted' and starts_b = ok_n and booked_b = c_n * 55,
    jsonb_build_array(sends_b, extra_b, starts_b, booked_b)::text);
end;
$$;

-- Gate P3 (cross-month conversion): the chosen semantics, pinned. A hold is a
-- charge of the month that booked it (0117), so a July 31 Send converted on
-- August 1 books its 55 into JULY and adds NO booked 55 to August's allocation
-- check (p_extra_used 0 when the hold's month differs from p_now's). While live,
-- that session is absorbed by August's greatest(booked, estimate): Mode A's
-- allocation can be exceeded by one session per link that straddles a month end,
-- a bounded policy overshoot that the runbook states. August is booked-dominated
-- (990 = 18 sessions), allocation edges come from the snapshot of the pinned
-- change. Mutants killed: p_extra_used always 55 (the conversion would need 55
-- more and be refused at its pinned edge), no check on the held path, and a
-- conversion booked into the conversion month.
do $$
declare
  july constant timestamptz := '2042-07-31T10:00:00Z';
  august constant timestamptz := '2042-08-01T10:00:00Z';
  sent jsonb; rid uuid; conversion jsonb; need integer; refused jsonb; admitted jsonb;
  july_used numeric; august_used numeric; august_reserved numeric;
  later_state jsonb; need_later integer; later_refused jsonb; later_ok jsonb;
begin
  perform _r1_tests.cand(851, 'straddling link');
  perform _r1_tests.cand(852, 'later August Send refused');
  perform _r1_tests.cand(853, 'later August Send');
  insert into screening_v2.r1_budget_month(month_start, minutes_used) values ('2042-08-01', 990)
    on conflict (month_start) do update set minutes_used = 990;
  perform _r1_tests.settings('r1', 100000, 100000);
  sent := _r1_tests.send_until(_r1_tests.u(851), 'xm-july-send', july, '2042-08-03T10:00:00Z');
  rid := (sent->>'id')::uuid;
  perform _r1_tests.consent(rid);
  conversion := _r1_tests.snap(august, -55, 0, 55);
  need := ceil(_r1_tests.num(conversion, 'r1_committed'));
  perform _r1_tests.settings('r1', need - 1, 1);
  refused := _r1_tests.admit(rid, 'xm-refused', august);
  perform _r1_tests.settings('r1', need, 1);
  admitted := _r1_tests.admit(rid, 'xm-edge', august);
  select minutes_used into july_used from screening_v2.r1_budget_month where month_start = '2042-07-01';
  select minutes_used, minutes_reserved into august_used, august_reserved from screening_v2.r1_budget_month where month_start = '2042-08-01';
  -- The session is live and August's allocation does not carry it: one more August Send fits at
  -- exactly 55 above the pinned conversion edge, and not a minute below.
  later_state := _r1_tests.snap(august, 55);
  need_later := ceil(_r1_tests.num(later_state, 'r1_committed'));
  perform _r1_tests.settings('r1', need_later - 1, 1);
  later_refused := _r1_tests.send(_r1_tests.u(852), 'xm-later-refused', august);
  perform _r1_tests.settings('r1', need_later, 1);
  later_ok := _r1_tests.send(_r1_tests.u(853), 'xm-later-ok', august);
  perform _r1_tests.assert('gate P3: a hold converted in a later month is checked without a booked 55 (it is the Send month''s charge), refused one minute below that edge and admitted at it',
    sent->>'status' = 'ok' and refused->>'status' = 'capacity_exhausted' and admitted->>'status' = 'ok'
      and abs(_r1_tests.net(conversion, 'r1_committed') - 990) < 0.001
      and need = _r1_tests.num(conversion, 'outstanding_holds') - 55 + 990,
    jsonb_build_array(sent, refused, admitted, conversion)::text);
  perform _r1_tests.assert('gate P3: the converted hold is booked into its ORIGINATING month and August''s booked minutes are untouched',
    july_used = 55 and august_used = 990 and august_reserved = 0
      and (select held_minutes = 0 and hold_month = '2042-07-01' from screening_v2.interview_rounds where id = rid),
    jsonb_build_array(july_used, august_used, august_reserved)::text);
  perform _r1_tests.assert('gate P3: the straddling session does not consume August''s allocation (documented one-session-per-straddling-link overshoot)',
    abs(_r1_tests.net(later_state, 'r1_committed') - 990) < 0.001
      and later_refused->>'status' = 'capacity_exhausted' and later_ok->>'status' = 'ok',
    jsonb_build_array(later_refused, later_ok, later_state)::text);
  perform _r1_tests.fail_live();
  perform _r1_tests.cancel(sent);
  perform _r1_tests.cancel(later_ok);
end;
$$;

-- Gate P3 (live-session guard): cancelling a round while its session is LIVE must
-- not refund the attempt's 55. The worker counts the attempt at TRANSITION, while
-- the session is live (plan D1), so a live session's 55 is not yet known to be
-- uncounted; a refund then would reset charged_attempt_number and a real session's
-- 55 would vanish from minutes_used. After the session ends uncounted the sweep
-- refunds it, exactly once. Mutant killed: r1_refund_uncounted_charge without its
-- live-session guard.
do $$
declare
  sent_at constant timestamptz := '2019-03-02T00:00:00Z';
  admit_at constant timestamptz := '2019-03-03T00:00:00Z';
  cancel_at constant timestamptz := '2019-03-04T00:00:00Z';
  link_end constant timestamptz := '2019-03-06T00:00:00Z';
  sweep_at constant timestamptz := '2020-02-10T00:00:00Z';
  sent jsonb; rid uuid; started jsonb; cancelled jsonb; released_live jsonb; released_again jsonb;
  used_started numeric; used_live numeric; marker_live integer; used_swept numeric; marker_swept integer; used_again numeric;
begin
  perform _r1_tests.cand(861, 'cancel during a live session');
  perform _r1_tests.settings('r1', 100000, 100000);
  sent := _r1_tests.send_until(_r1_tests.u(861), 'live-cancel', sent_at, link_end);
  rid := (sent->>'id')::uuid;
  perform _r1_tests.consent(rid, '2019-03-01T00:00:00Z');
  started := _r1_tests.admit(rid, 'live-cancel-start', admit_at);
  used_started := _r1_tests.booked('2019-03-01');
  cancelled := screening_v2.r1_transition_round(rid, 'cancel', (select version from screening_v2.interview_rounds where id = rid), null, null, cancel_at);
  released_live := screening_v2.r1_release_round_hold(rid, cancel_at);
  used_live := _r1_tests.booked('2019-03-01');
  select charged_attempt_number into marker_live from screening_v2.interview_rounds where id = rid;
  -- The session ends without counting: now the 55 is a refundable uncounted charge.
  perform _r1_tests.fail_live();
  perform screening_v2.r1_sweep_expired_rounds(sweep_at, 1000);
  used_swept := _r1_tests.booked('2019-03-01');
  select charged_attempt_number into marker_swept from screening_v2.interview_rounds where id = rid;
  perform screening_v2.r1_sweep_expired_rounds(sweep_at, 1000);
  released_again := screening_v2.r1_release_round_hold(rid, sweep_at);
  used_again := _r1_tests.booked('2019-03-01');
  perform _r1_tests.assert('gate P3: cancelling during a live session refunds nothing (booked minutes and the charged marker stay), and the sweep refunds the uncounted 55 exactly once after the session ends',
    started->>'status' = 'ok' and cancelled->>'status' = 'ok'
      and used_started = 55 and used_live = 55 and marker_live = 1 and (released_live->>'refunded')::numeric = 0
      and used_swept = 0 and marker_swept = 0 and used_again = 0 and (released_again->>'refunded')::numeric = 0
      and (select status = 'cancelled' and held_minutes = 0 from screening_v2.interview_rounds where id = rid),
    jsonb_build_array(started, cancelled, used_started, used_live, marker_live, released_live, used_swept, marker_swept, used_again, released_again)::text);
end;
$$;

-- Gate P3 (worker contract): the no-show derivation treats "charged > counted and
-- no live session" as a hold kept for the link, and the sweep refunds it for good
-- once the link is dead. So the worker must write attempts_counted WHILE the
-- session is live (at TRANSITION, plan D1), and an uncount after a system failure
-- in the same transaction that terminalizes the session (runbook, "Worker
-- contract"). Round A follows the contract on its THIRD start (the sweep also
-- selects a round whose three starts are used): counted while live, the session
-- ends, the sweep leaves its 55 booked. Round B breaks it: the session ends
-- uncounted, the sweep refunds, and a late count finds its 55 gone - the loss the
-- contract rules out (this assertion documents the consequence; if the database
-- ever tolerates late counting, replace it with the positive one). Mutant killed:
-- a refund that ignores attempts_counted.
do $$
declare
  sweep_at constant timestamptz := '2020-02-10T00:00:00Z';
  sent_a jsonb; sent_b jsonb; rid_a uuid; rid_b uuid; third jsonb; first_b jsonb; i integer; starts_a text[] := array[]::text[];
  used_a numeric; marker_a integer; counted_a integer; starts_used_a integer; used_b_before numeric; used_b numeric; marker_b integer; counted_b integer;
begin
  perform _r1_tests.cand(881, 'contract: counted while live');
  perform _r1_tests.cand(882, 'contract: counted after the session ended');
  perform _r1_tests.settings('r1', 100000, 100000);
  sent_a := _r1_tests.send_until(_r1_tests.u(881), 'contract-a', '2018-05-02T00:00:00Z', '2018-05-06T00:00:00Z');
  rid_a := (sent_a->>'id')::uuid;
  perform _r1_tests.consent(rid_a, '2018-05-01T00:00:00Z');
  for i in 1..2 loop
    starts_a := starts_a || ((_r1_tests.admit(rid_a, 'contract-a-' || i::text, '2018-05-03T00:00:00Z'))->>'status');
    perform _r1_tests.fail_live();
  end loop;
  third := _r1_tests.admit(rid_a, 'contract-a-3', '2018-05-03T00:00:00Z');
  update screening_v2.interview_round_attempts set counted = true where session_id = (third->>'session_id')::uuid;
  update screening_v2.interview_rounds set attempts_counted = 1 where id = rid_a;
  perform _r1_tests.fail_live();
  sent_b := _r1_tests.send_until(_r1_tests.u(882), 'contract-b', '2018-06-02T00:00:00Z', '2018-06-06T00:00:00Z');
  rid_b := (sent_b->>'id')::uuid;
  perform _r1_tests.consent(rid_b, '2018-06-01T00:00:00Z');
  first_b := _r1_tests.admit(rid_b, 'contract-b-1', '2018-06-03T00:00:00Z');
  used_b_before := _r1_tests.booked('2018-06-01');
  perform _r1_tests.fail_live();
  perform screening_v2.r1_sweep_expired_rounds(sweep_at, 1000);
  select starts_used, attempts_counted, charged_attempt_number into starts_used_a, counted_a, marker_a from screening_v2.interview_rounds where id = rid_a;
  used_a := _r1_tests.booked('2018-05-01');
  -- Round B's worker writes the count only now, after the sweep refunded the uncounted charge.
  update screening_v2.interview_round_attempts set counted = true where session_id = (first_b->>'session_id')::uuid;
  update screening_v2.interview_rounds set attempts_counted = 1 where id = rid_b;
  used_b := _r1_tests.booked('2018-06-01');
  select charged_attempt_number, attempts_counted into marker_b, counted_b from screening_v2.interview_rounds where id = rid_b;
  perform _r1_tests.assert('worker contract: an attempt counted while its session is live keeps its 55 through the sweep, also as a third start',
    starts_a = array['ok', 'ok'] and third->>'status' = 'ok' and starts_used_a = 3 and counted_a = 1 and marker_a = 1 and used_a = 55,
    jsonb_build_array(starts_a, third, starts_used_a, counted_a, marker_a, used_a)::text);
  perform _r1_tests.assert('worker contract: counting only AFTER the session ended loses the 55 (the sweep already refunded it), which is why the contract forbids it',
    first_b->>'status' = 'ok' and used_b_before = 55 and used_b = 0 and marker_b = 0 and counted_b = 1,
    jsonb_build_array(first_b, used_b_before, used_b, marker_b, counted_b)::text);
  perform _r1_tests.cancel(sent_a);
  perform _r1_tests.cancel(sent_b);
end;
$$;

-- Gate P3 (view reconciliation): v_r1_budget_month keeps minutes_used as the BOOKED
-- column and starts_admitted as CHARGED starts, and appends the derived terms so
-- Mission Control can reconcile its own figures: r1_minutes_used = booked less 55
-- per uncounted charge, and r1_committed = greatest(r1_minutes_used, r1_estimate)
-- + outstanding_holds. A no-show moves 55 from r1_minutes_used into restored_holds
-- while the booked column keeps it; a restart charges nothing, so starts_admitted
-- does not move. The current month's other-suite state is global (an earlier block
-- deletes the month's budget row while rounds charged in it still exist, which
-- would clamp the derived figure at 0), so this block books 1000 into the month
-- first and every figure is a delta against the view read before. Mutants killed:
-- r1_minutes_used or uncounted_charges not derived, and a missing/renamed
-- appended column.
do $$
declare
  v0 record; v1 record; v2 record; sent jsonb; rid uuid; started jsonb; restarted jsonb;
  cur constant date := date_trunc('month', now())::date; prior numeric;
begin
  perform _r1_tests.cand(871, 'view reconciliation');
  perform _r1_tests.settings('r1', 100000, 100000);
  select minutes_used into prior from screening_v2.r1_budget_month where month_start = cur;
  insert into screening_v2.r1_budget_month(month_start, minutes_used) values (cur, 1000)
    on conflict (month_start) do update set minutes_used = 1000;
  select * into v0 from screening_v2.v_r1_budget_month where month_start = date_trunc('month', now())::date;
  sent := _r1_tests.send(_r1_tests.u(871), 'view-reconcile', now());
  rid := (sent->>'id')::uuid;
  perform _r1_tests.consent(rid);
  started := _r1_tests.admit(rid, 'view-reconcile-first', now());
  perform _r1_tests.fail_live();
  select * into v1 from screening_v2.v_r1_budget_month where month_start = date_trunc('month', now())::date;
  restarted := _r1_tests.admit(rid, 'view-reconcile-restart', now());
  perform _r1_tests.fail_live();
  select * into v2 from screening_v2.v_r1_budget_month where month_start = date_trunc('month', now())::date;
  perform _r1_tests.assert('view: a no-show moves its 55 from the derived minutes into restored holds while the booked column keeps it',
    started->>'status' = 'ok'
      and v1.booked_minutes_used - v0.booked_minutes_used = 55 and v1.minutes_used = v1.booked_minutes_used
      and v1.uncounted_charges - v0.uncounted_charges = 1 and v1.restored_holds - v0.restored_holds = 55
      and v1.r1_minutes_used = v0.r1_minutes_used
      and v1.r1_minutes_used = v1.booked_minutes_used - 55 * v1.uncounted_charges and v1.r1_minutes_used > 0
      and v1.starts_admitted - v0.starts_admitted = 1,
    jsonb_build_array(to_jsonb(v0), to_jsonb(v1))::text);
  perform _r1_tests.assert('view: the appended terms reconcile r1_committed, and starts_admitted counts charged starts only (a restart is not charged again)',
    v1.r1_committed = greatest(v1.r1_minutes_used, v1.r1_estimate) + v1.outstanding_holds
      and v2.r1_committed = greatest(v2.r1_minutes_used, v2.r1_estimate) + v2.outstanding_holds
      and restarted->>'status' = 'ok' and v2.starts_admitted = v1.starts_admitted
      and v2.booked_minutes_used = v1.booked_minutes_used and v2.uncounted_charges = v1.uncounted_charges,
    jsonb_build_array(to_jsonb(v1), to_jsonb(v2))::text);
  perform _r1_tests.cancel(sent);
  if prior is null then delete from screening_v2.r1_budget_month where month_start = cur;
  else update screening_v2.r1_budget_month set minutes_used = prior where month_start = cur; end if;
end;
$$;

-- Gate P3 (allocation guard): allocation_set_at is stamped only by a write that
-- NAMES monthly_cap_minutes (UPDATE OF), so a deliberate save of an unchanged 4000
-- counts and nothing else does: not updated_by, not a dashboard reading (the stamp
-- RPC sets updated_by), not a threshold or enabled/paused write, not an empty save.
-- The settings API keys its "untouched default allocation" guard on this column.
-- Mutants killed: a trigger on every update, and no trigger at all.
do $$
declare
  owner constant uuid := '10000000-0000-4000-8000-000000000001';
  after_others timestamptz; stamped jsonb; first_save timestamptz; later_save timestamptz;
begin
  perform _r1_tests.settings('r1', 4000, 4000);
  -- A direct write of the stamp itself is not an allocation save (the column is not in the trigger's list).
  update screening_v2.r1_settings set allocation_set_at = null;
  update screening_v2.r1_settings set updated_by = owner;
  update screening_v2.r1_settings
     set enabled = true, paused = false, auto_status_enabled = auto_status_enabled, advance_threshold = advance_threshold,
         hold_threshold = hold_threshold, livekit_target = livekit_target, pause_line_minutes = pause_line_minutes,
         dashboard_minutes = 1200, updated_by = owner, updated_at = now();
  stamped := screening_v2.r1_stamp_dashboard_reading(1300, owner, now());
  select allocation_set_at into after_others from screening_v2.r1_settings;
  -- The deliberate save of the unchanged default.
  update screening_v2.r1_settings set monthly_cap_minutes = monthly_cap_minutes;
  select allocation_set_at into first_save from screening_v2.r1_settings;
  update screening_v2.r1_settings set monthly_cap_minutes = 1100, updated_by = owner;
  select allocation_set_at into later_save from screening_v2.r1_settings;
  perform _r1_tests.assert('allocation_set_at is NULL after every settings write that does not name monthly_cap_minutes (updated_by, a dashboard stamp, thresholds, enabled)',
    stamped->>'status' = 'ok' and after_others is null,
    jsonb_build_array(stamped, after_others)::text);
  perform _r1_tests.assert('allocation_set_at is stamped by a save of the allocation, even an unchanged 4000, and re-stamped by the next save',
    first_save is not null and later_save >= first_save and (select monthly_cap_minutes = 1100 from screening_v2.r1_settings),
    jsonb_build_array(first_save, later_save)::text);
  perform _r1_tests.settings('r1', 10000, 10000);
end;
$$;

-- Gate P3 (upgrade guard): 0117 charged a fresh 55 for every start, including the
-- restart of an uncounted attempt, which leaves a SECOND attempt row with the same
-- (round, attempt number); 0119 charges that attempt once. The migration refuses to
-- run over such rounds (their charged months are not recorded), using this count;
-- the abort itself is exercised by the upgrade rehearsal (a 0117 database seeded
-- with a restart). A retake is a new attempt number and is not a double charge.
-- Mutants killed: a count that includes retakes, and one that ignores restarts.
do $$
declare
  m constant timestamptz := '2043-03-15T12:00:00Z';
  sent_t jsonb; sent_r jsonb; rid_t uuid; rid_r uuid; first_t jsonb; retake_t jsonb; first_r jsonb; restart_r jsonb;
  n0 integer; n_retake integer; n_restart integer;
begin
  perform _r1_tests.cand(891, 'double-charge guard: restart');
  perform _r1_tests.cand(892, 'double-charge guard: retake');
  perform _r1_tests.settings('r1', 100000, 100000);
  n0 := screening_v2.r1_count_0117_restart_double_charges();
  sent_t := _r1_tests.send(_r1_tests.u(892), 'dc-retake', m);
  rid_t := (sent_t->>'id')::uuid;
  perform _r1_tests.consent(rid_t);
  first_t := _r1_tests.admit(rid_t, 'dc-retake-1', m);
  perform _r1_tests.fail_live();
  update screening_v2.interview_round_attempts set counted = true where session_id = (first_t->>'session_id')::uuid;
  update screening_v2.interview_rounds set attempts_counted = 1 where id = rid_t;
  retake_t := _r1_tests.admit(rid_t, 'dc-retake-2', m);
  perform _r1_tests.fail_live();
  n_retake := screening_v2.r1_count_0117_restart_double_charges();
  sent_r := _r1_tests.send(_r1_tests.u(891), 'dc-restart', m);
  rid_r := (sent_r->>'id')::uuid;
  perform _r1_tests.consent(rid_r);
  first_r := _r1_tests.admit(rid_r, 'dc-restart-1', m);
  perform _r1_tests.fail_live();
  restart_r := _r1_tests.admit(rid_r, 'dc-restart-2', m);
  perform _r1_tests.fail_live();
  n_restart := screening_v2.r1_count_0117_restart_double_charges();
  perform _r1_tests.assert('upgrade guard: a restart (same attempt number twice) is counted as a 0117 double charge, a counted retake (a new number) is not',
    first_t->>'status' = 'ok' and retake_t->>'status' = 'ok' and (retake_t->>'attempt_number')::integer = 2
      and first_r->>'status' = 'ok' and restart_r->>'status' = 'ok' and (restart_r->>'attempt_number')::integer = 1
      and n_retake = n0 and n_restart = n0 + 1
      and not has_function_privilege('service_role', 'screening_v2.r1_count_0117_restart_double_charges()', 'execute')
      and not has_function_privilege('authenticated', 'screening_v2.r1_count_0117_restart_double_charges()', 'execute'),
    jsonb_build_array(n0, n_retake, n_restart)::text);
  perform _r1_tests.cancel(sent_t);
  perform _r1_tests.cancel(sent_r);
end;
$$;

-- M2: worker-only append tables remain RLS-protected, while capacity views
-- execute as the caller and cannot be used as a write path into phone/legacy
-- sources. These are catalog assertions against the applied full chain, not
-- regex checks of the migration text.
do $$
begin
  perform _r1_tests.assert('M2 ledger and administration log have RLS with no caller grants',
    (select relrowsecurity from pg_class where oid = 'screening_v2.r1_usage_ledger'::regclass)
    and (select relrowsecurity from pg_class where oid = 'screening_v2.r1_admin_log'::regclass)
    and not has_table_privilege('anon', 'screening_v2.r1_usage_ledger', 'select')
    and not has_table_privilege('authenticated', 'screening_v2.r1_usage_ledger', 'insert')
    and not has_table_privilege('anon', 'screening_v2.r1_admin_log', 'select')
    and not has_table_privilege('authenticated', 'screening_v2.r1_admin_log', 'insert')
    and has_table_privilege('service_role', 'screening_v2.r1_usage_ledger', 'insert')
    and has_table_privilege('service_role', 'screening_v2.r1_admin_log', 'insert'));
  perform _r1_tests.assert('M2 estimate views use security_invoker and are read-only',
    (select reloptions @> array['security_invoker=true'] from pg_class where oid = 'screening_v2.v_webrtc_minutes_estimate'::regclass)
    and (select reloptions @> array['security_invoker=true'] from pg_class where oid = 'screening_v2.v_r1_budget_month'::regclass)
    and has_table_privilege('service_role', 'screening_v2.v_webrtc_minutes_estimate', 'select')
    and has_table_privilege('service_role', 'screening_v2.v_r1_budget_month', 'select')
    and not has_table_privilege('service_role', 'screening_v2.v_webrtc_minutes_estimate', 'insert,update,delete,truncate,references,trigger')
    and not has_table_privilege('service_role', 'screening_v2.v_r1_budget_month', 'insert,update,delete,truncate,references,trigger')
    and pg_relation_is_updatable('screening_v2.v_webrtc_minutes_estimate'::regclass, true) = 0
    and pg_relation_is_updatable('screening_v2.v_r1_budget_month'::regclass, true) = 0);
end;
$$;

drop schema _r1_tests cascade;
