-- Executed by scripts/test-r1-foundation.sh inside the complete 0001..0120
-- Supabase schema, AFTER the foundation assertions and races (this file
-- changes the R1 settings singleton and leaves its fixtures in place, so
-- nothing may run after it). Covers migration 0120: r1_reserve_preflight,
-- r1_settle_attempt and r1_withdraw_consent.
--
-- Fixture ids live in 60000000-... and every digest is derived from a unique
-- tag with encode(sha256('<tag>'::bytea), 'hex').
create schema if not exists _r1_pr3_tests;
create or replace function _r1_pr3_tests.assert(p_label text, p_ok boolean, p_detail text default '')
returns void language plpgsql as $$
begin
  -- `is not true`, not `not`: a NULL condition must fail, never pass silently.
  if p_ok is not true then raise exception 'R1 PR-3 FAIL: % (%)', p_label, p_detail; end if;
  raise notice 'R1 PR-3 PASS: %', p_label;
end;
$$;

-- End a fixture session the way the worker's terminal write does. The lifecycle
-- trigger (0006) only allows created -> failed and in_progress -> completed, so a
-- completed session passes through in_progress first.
create or replace function _r1_pr3_tests.end_session(p_session uuid, p_completed boolean)
returns void language plpgsql as $$
begin
  if p_completed then
    update screening_v2.call_sessions set status = 'in_progress' where id = p_session;
    update screening_v2.call_sessions
       set status = 'completed', terminal_reason = 'conversation_complete'
     where id = p_session;
  else
    update screening_v2.call_sessions
       set status = 'failed', terminal_reason = 'worker_crash'
     where id = p_session;
  end if;
end;
$$;

-- Catalog assertions: the server-owned consent audience on the round (PR-CT's
-- audience contract). A round nobody marked shows the candidate notice, and the
-- column admits only the two audiences 0123 ships.
do $$
begin
  perform _r1_pr3_tests.assert('interview_rounds.consent_locale is not null and defaults to en-IN',
    (select c.is_nullable = 'NO' and c.column_default like '''en-IN''%'
       from information_schema.columns c
      where c.table_schema = 'screening_v2' and c.table_name = 'interview_rounds'
        and c.column_name = 'consent_locale'));
  -- Exactly two quoted values, and exactly these two: a LIKE would pass with a third
  -- locale allowed (the behavioural refusals below are the second line of defence).
  perform _r1_pr3_tests.assert('interview_rounds.consent_locale admits only the two audiences',
    (select count(*) = 2 and bool_and(m[1] in ('en-IN', 'en-IN-x-staff'))
       from pg_constraint k,
            regexp_matches(pg_get_constraintdef(k.oid), '''([^'']+)''', 'g') as m
      where k.conrelid = 'screening_v2.interview_rounds'::regclass
        and k.conname = 'chk_interview_rounds_consent_locale'
        and k.contype = 'c'));
  perform _r1_pr3_tests.assert('the audience is locked by a before-update trigger on consent_locale',
    exists (
      select 1 from pg_trigger t
       where t.tgrelid = 'screening_v2.interview_rounds'::regclass
         and t.tgname = 'trg_interview_rounds_audience_locked'
         and not t.tgisinternal
         and (t.tgtype & 2) = 2      -- BEFORE
         and (t.tgtype & 16) = 16    -- UPDATE
         and (t.tgtype & 1) = 1));   -- FOR EACH ROW
end;
$$;

-- Catalog assertions: least privilege and definer hygiene.
do $$
declare
  fn text;
begin
  foreach fn in array array[
    'screening_v2.r1_reserve_preflight(uuid, text, timestamptz)',
    'screening_v2.r1_settle_attempt(uuid, text, timestamptz)',
    'screening_v2.r1_withdraw_consent(uuid, jsonb, timestamptz, text)'
  ] loop
    perform _r1_pr3_tests.assert(fn || ' is security definer with a pinned search_path',
      (select p.prosecdef and p.proconfig @> array['search_path=pg_catalog, screening_v2']
         from pg_proc p where p.oid = fn::regprocedure));
    perform _r1_pr3_tests.assert(fn || ' is executable by service_role only',
      has_function_privilege('service_role', fn, 'execute')
      and not has_function_privilege('anon', fn, 'execute')
      and not has_function_privilege('authenticated', fn, 'execute')
      and not has_function_privilege('public', fn, 'execute'));
  end loop;
end;
$$;

do $$
declare
  owner constant uuid := '60000000-0000-4000-8000-000000000001';
  role_r1 constant uuid := '60000000-0000-4000-8000-000000000002';
  cand_pf constant uuid := '60000000-0000-4000-8000-000000000011';
  cand_pf2 constant uuid := '60000000-0000-4000-8000-000000000012';
  cand_cancelled constant uuid := '60000000-0000-4000-8000-000000000013';
  cand_expired constant uuid := '60000000-0000-4000-8000-000000000014';
  round_pf constant uuid := '60000000-0000-4000-8000-000000000021';
  round_pf2 constant uuid := '60000000-0000-4000-8000-000000000022';
  round_cancelled constant uuid := '60000000-0000-4000-8000-000000000023';
  round_expired constant uuid := '60000000-0000-4000-8000-000000000024';
  t0 constant timestamptz := '2031-03-01 10:00:00+00';
  res jsonb;
  n integer;
  estimated numeric;
begin
  insert into auth.users (id, email) values (owner, 'r1-pr3-assert@example.test')
  on conflict (id) do nothing;
  insert into screening_v2.roles (id, title, interview_kind)
  values (role_r1, 'R1 PR-3 assertion role', 'sales_r1');
  insert into screening_v2.candidates (id, role_id, name) values
    (cand_pf, role_r1, 'pr3 preflight a'), (cand_pf2, role_r1, 'pr3 preflight b'),
    (cand_cancelled, role_r1, 'pr3 cancelled'), (cand_expired, role_r1, 'pr3 expired');
  insert into screening_v2.interview_rounds
    (id, candidate_id, role_id, link_token_digest, expires_at, created_by, status) values
    (round_pf, cand_pf, role_r1, encode(sha256('r1-pr3-link-pf'::bytea), 'hex'),
     '2099-01-01 00:00:00+00', owner, 'invited'),
    (round_pf2, cand_pf2, role_r1, encode(sha256('r1-pr3-link-pf2'::bytea), 'hex'),
     '2099-01-01 00:00:00+00', owner, 'invited'),
    (round_cancelled, cand_cancelled, role_r1, encode(sha256('r1-pr3-link-cancelled'::bytea), 'hex'),
     '2099-01-01 00:00:00+00', owner, 'cancelled'),
    (round_expired, cand_expired, role_r1, encode(sha256('r1-pr3-link-expired'::bytea), 'hex'),
     '2031-03-01 09:00:00+00', owner, 'invited');

  -- r1_reserve_preflight -------------------------------------------------
  perform _r1_pr3_tests.assert('preflight refuses a missing or malformed event key',
    (screening_v2.r1_reserve_preflight(round_pf, null, t0)->>'status') = 'invalid_request'
    and (screening_v2.r1_reserve_preflight(round_pf, 'bad key!', t0)->>'status') = 'invalid_request'
    and (screening_v2.r1_reserve_preflight(round_pf, repeat('k', 129), t0)->>'status') = 'invalid_request');
  perform _r1_pr3_tests.assert('preflight refuses an unknown round',
    (screening_v2.r1_reserve_preflight('60000000-0000-4000-8000-0000000000ff', 'pf:unknown', t0)->>'status')
      = 'round_not_found');
  perform _r1_pr3_tests.assert('preflight refuses a cancelled or lapsed round',
    (screening_v2.r1_reserve_preflight(round_cancelled, 'pf:cancelled', t0)->>'status') = 'round_not_admissible'
    and (screening_v2.r1_reserve_preflight(round_expired, 'pf:expired', t0)->>'status') = 'round_not_admissible');
  perform _r1_pr3_tests.assert('refusals write no ledger row',
    (select count(*) = 0 from screening_v2.r1_usage_ledger
      where round_id in (round_pf, round_cancelled, round_expired) and participant_kind = 'preflight'));

  res := screening_v2.r1_reserve_preflight(round_pf, 'pf:pf:1', t0);
  perform _r1_pr3_tests.assert('first preflight is reserved with 9 remaining',
    res->>'status' = 'ok' and (res->>'remaining')::integer = 9, res::text);
  res := screening_v2.r1_reserve_preflight(round_pf, 'pf:pf:2', t0 + interval '1 second');
  perform _r1_pr3_tests.assert('second preflight is reserved', res->>'status' = 'ok'
    and (res->>'remaining')::integer = 8, res::text);
  res := screening_v2.r1_reserve_preflight(round_pf, 'pf:pf:3', t0 + interval '2 seconds');
  perform _r1_pr3_tests.assert('third preflight in a minute is reserved', res->>'status' = 'ok'
    and (res->>'remaining')::integer = 7, res::text);
  res := screening_v2.r1_reserve_preflight(round_pf, 'pf:pf:4', t0 + interval '3 seconds');
  perform _r1_pr3_tests.assert('fourth preflight inside a minute is rate limited and writes nothing',
    res->>'status' = 'preflight_rate_limited'
    and (select count(*) = 3 from screening_v2.r1_usage_ledger
          where round_id = round_pf and participant_kind = 'preflight'), res::text);
  res := screening_v2.r1_reserve_preflight(round_pf, 'pf:pf:4', t0 + interval '61 seconds');
  perform _r1_pr3_tests.assert('the window slides: a preflight after the first one ages out is allowed',
    res->>'status' = 'ok' and (res->>'remaining')::integer = 6, res::text);

  -- Six more, each more than a minute apart, reach the lifetime cap of 10.
  for n in 5..10 loop
    res := screening_v2.r1_reserve_preflight(
      round_pf, 'pf:pf:' || n::text, t0 + (n * interval '2 minutes'));
    perform _r1_pr3_tests.assert('preflight ' || n::text || ' of 10 is reserved',
      res->>'status' = 'ok' and (res->>'remaining')::integer = 10 - n, res::text);
  end loop;
  res := screening_v2.r1_reserve_preflight(round_pf, 'pf:pf:11', t0 + interval '1 day');
  perform _r1_pr3_tests.assert('the eleventh preflight hits the per-link lifetime cap, even long after',
    res->>'status' = 'preflight_limit', res::text);
  perform _r1_pr3_tests.assert('exactly ten preflight rows exist, none attached to a session',
    (select count(*) = 10 and bool_and(session_id is null and seconds = 10 and event = 'usage')
       from screening_v2.r1_usage_ledger
      where round_id = round_pf and participant_kind = 'preflight'));

  res := screening_v2.r1_reserve_preflight(round_pf2, 'pf:pf2:1', t0);
  perform _r1_pr3_tests.assert('another link has its own budget', res->>'status' = 'ok'
    and (res->>'remaining')::integer = 9, res::text);

  select r1_minutes into estimated from screening_v2.v_webrtc_minutes_estimate
   where month_start = date '2031-03-01';
  perform _r1_pr3_tests.assert('preflight rows are charged to the minutes estimate (11 x 10 s)',
    estimated >= 110.0 / 60.0, estimated::text);
end;
$$;

-- r1_settle_attempt (plan D1) -------------------------------------------
do $$
declare
  owner constant uuid := '60000000-0000-4000-8000-000000000001';
  role_r1 constant uuid := '60000000-0000-4000-8000-000000000002';
  res jsonb;
  case_row record;
  v_round uuid;
  v_candidate uuid;
  v_session uuid;
  v_version integer;
  v_attempt_two constant uuid := '60000000-0000-4000-8000-000000000602';
begin
  -- One round + one live session + one attempt per scenario.
  for case_row in
    select * from (values
      (1, 'no_show',            null::text,       false, 'a no-show never counts'),
      (2, 'provider_error',     'roleplay',       false, 'a system failure never counts, even after TRANSITION'),
      (3, 'shutdown_forced',    'wrapup',         false, 'a forced shutdown never counts'),
      (4, 'configuration_failed', null::text,     false, 'a configuration failure never counts'),
      (5, 'context_failed',     null::text,       false, 'a context failure never counts'),
      (6, 'candidate_left',     'icebreaker',     false, 'leaving before TRANSITION never counts'),
      (7, 'candidate_left',     null::text,       false, 'leaving with no turns never counts'),
      (8, 'candidate_left',     'transition',     true,  'leaving once TRANSITION started counts'),
      (9, 'residency_timeout',  'roleplay',       true,  'a residency timeout after TRANSITION counts'),
      (10, 'residency_timeout', 'opening',        false, 'a residency timeout before TRANSITION never counts'),
      (11, 'complete',          null::text,       true,  'a completed interview counts')
    ) as t(n, outcome, turn_phase, expect_counted, label)
  loop
    v_round := ('60000000-0000-4000-8000-0000000002' || lpad(case_row.n::text, 2, '0'))::uuid;
    v_candidate := ('60000000-0000-4000-8000-0000000001' || lpad(case_row.n::text, 2, '0'))::uuid;
    v_session := ('60000000-0000-4000-8000-0000000003' || lpad(case_row.n::text, 2, '0'))::uuid;
    insert into screening_v2.candidates (id, role_id, name)
    values (v_candidate, role_r1, 'pr3 settle ' || case_row.n::text);
    insert into screening_v2.interview_rounds
      (id, candidate_id, role_id, link_token_digest, expires_at, created_by, status)
    values (v_round, v_candidate, role_r1,
            encode(sha256(('r1-pr3-settle-link-' || case_row.n::text)::bytea), 'hex'),
            '2099-01-01 00:00:00+00', owner, 'in_progress');
    insert into screening_v2.call_sessions
      (id, candidate_id, role_id, mode, provider, external_call_id, status, interview_round_id, owner_id)
    values (v_session, v_candidate, role_r1, 'browser', 'livekit',
            'screening-' || v_session::text, 'created', v_round, owner);
    insert into screening_v2.interview_round_attempts
      (session_id, round_id, attempt_number, persona_id, nonce_digest)
    values (v_session, v_round, 1, 'p1_career_switcher',
            encode(sha256(('r1-pr3-settle-nonce-' || case_row.n::text)::bytea), 'hex'));
    if case_row.turn_phase is not null then
      insert into screening_v2.transcript_turns (session_id, turn_index, speaker, text, phase)
      values (v_session, 1, 'bot', 'pr3 fixture turn', case_row.turn_phase);
    end if;
    -- The worker settles AFTER its terminal write: end the session first, the
    -- way r1_persistence.py does (complete -> completed; everything else -> failed).
    perform _r1_pr3_tests.end_session(v_session, case_row.outcome = 'complete');

    select version into v_version from screening_v2.interview_rounds where id = v_round;
    res := screening_v2.r1_settle_attempt(v_session, case_row.outcome);
    perform _r1_pr3_tests.assert(case_row.label,
      res->>'status' = 'ok' and (res->>'counted')::boolean = case_row.expect_counted
      and (select a.outcome = case_row.outcome and a.counted = case_row.expect_counted
             from screening_v2.interview_round_attempts a where a.session_id = v_session)
      and (select r.attempts_counted = case when case_row.expect_counted then 1 else 0 end
                  and r.version = v_version + case when case_row.expect_counted then 1 else 0 end
             from screening_v2.interview_rounds r where r.id = v_round),
      res::text);
    -- A counted attempt closes the round; an uncounted one leaves it open.
    perform _r1_pr3_tests.assert(case_row.label || ' (round status follows the count)',
      (select r.status = case when case_row.expect_counted then 'completed' else 'in_progress' end
         from screening_v2.interview_rounds r where r.id = v_round));

    -- Idempotent replay: no double count, same decision; a different outcome conflicts.
    res := screening_v2.r1_settle_attempt(v_session, case_row.outcome);
    perform _r1_pr3_tests.assert(case_row.label || ' (replay is a duplicate and counts nothing more)',
      res->>'status' = 'duplicate' and (res->>'counted')::boolean = case_row.expect_counted
      and (select r.attempts_counted = case when case_row.expect_counted then 1 else 0 end
             from screening_v2.interview_rounds r where r.id = v_round), res::text);
    res := screening_v2.r1_settle_attempt(
      v_session, case when case_row.outcome = 'complete' then 'no_show' else 'complete' end);
    perform _r1_pr3_tests.assert(case_row.label || ' (a different outcome conflicts and changes nothing)',
      res->>'status' = 'outcome_conflict'
      and (select a.outcome = case_row.outcome from screening_v2.interview_round_attempts a
            where a.session_id = v_session), res::text);
  end loop;

  perform _r1_pr3_tests.assert('an unknown attempt and an unknown outcome are refused',
    (screening_v2.r1_settle_attempt('60000000-0000-4000-8000-0000000003ff', 'complete')->>'status')
      = 'attempt_not_found'
    and (screening_v2.r1_settle_attempt('60000000-0000-4000-8000-0000000003ff', 'finished')->>'status')
      = 'invalid_outcome'
    and (screening_v2.r1_settle_attempt('60000000-0000-4000-8000-0000000003ff', null)->>'status')
      = 'invalid_outcome');

  -- An uncounted first attempt leaves the retake available; the second counts.
  v_round := '60000000-0000-4000-8000-000000000501';
  v_candidate := '60000000-0000-4000-8000-000000000401';
  v_session := '60000000-0000-4000-8000-000000000601';
  insert into screening_v2.candidates (id, role_id, name) values (v_candidate, role_r1, 'pr3 two attempts');
  insert into screening_v2.interview_rounds
    (id, candidate_id, role_id, link_token_digest, expires_at, created_by, status)
  values (v_round, v_candidate, role_r1, encode(sha256('r1-pr3-two-attempts-link'::bytea), 'hex'),
          '2099-01-01 00:00:00+00', owner, 'in_progress');
  insert into screening_v2.call_sessions
    (id, candidate_id, role_id, mode, provider, external_call_id, status, interview_round_id, owner_id)
  values (v_session, v_candidate, role_r1, 'browser', 'livekit',
          'screening-' || v_session::text, 'created', v_round, owner);
  insert into screening_v2.interview_round_attempts
    (session_id, round_id, attempt_number, persona_id, nonce_digest)
  values (v_session, v_round, 1, 'p2_recent_grad',
          encode(sha256('r1-pr3-two-attempts-nonce-1'::bytea), 'hex'));
  update screening_v2.call_sessions
     set status = 'failed', terminal_reason = 'provider_error' where id = v_session;
  perform screening_v2.r1_settle_attempt(v_session, 'shutdown_forced');
  insert into screening_v2.call_sessions
    (id, candidate_id, role_id, mode, provider, external_call_id, status, interview_round_id, owner_id)
  values (v_attempt_two, v_candidate, role_r1, 'browser', 'livekit',
          'screening-' || v_attempt_two::text, 'created', v_round, owner);
  insert into screening_v2.interview_round_attempts
    (session_id, round_id, attempt_number, persona_id, nonce_digest)
  values (v_attempt_two, v_round, 1, 'p2_recent_grad',
          encode(sha256('r1-pr3-two-attempts-nonce-2'::bytea), 'hex'));
  perform _r1_pr3_tests.end_session(v_attempt_two, true);
  res := screening_v2.r1_settle_attempt(v_attempt_two, 'complete');
  perform _r1_pr3_tests.assert('a forced shutdown does not consume the attempt; the retry then counts once',
    res->>'status' = 'ok' and (res->>'counted')::boolean
    and (select attempts_counted = 1 from screening_v2.interview_rounds where id = v_round), res::text);

  -- The count can never pass what the round allows (chk_interview_rounds_attempts).
  v_round := '60000000-0000-4000-8000-000000000502';
  v_candidate := '60000000-0000-4000-8000-000000000402';
  v_session := '60000000-0000-4000-8000-000000000603';
  insert into screening_v2.candidates (id, role_id, name) values (v_candidate, role_r1, 'pr3 capped');
  insert into screening_v2.interview_rounds
    (id, candidate_id, role_id, link_token_digest, expires_at, created_by, status,
     attempts_allowed, attempts_counted)
  values (v_round, v_candidate, role_r1, encode(sha256('r1-pr3-capped-link'::bytea), 'hex'),
          '2099-01-01 00:00:00+00', owner, 'in_progress', 1, 1);
  insert into screening_v2.call_sessions
    (id, candidate_id, role_id, mode, provider, external_call_id, status, interview_round_id, owner_id)
  values (v_session, v_candidate, role_r1, 'browser', 'livekit',
          'screening-' || v_session::text, 'created', v_round, owner);
  insert into screening_v2.interview_round_attempts
    (session_id, round_id, attempt_number, persona_id, nonce_digest)
  values (v_session, v_round, 2, 'p3_data_analyst',
          encode(sha256('r1-pr3-capped-nonce'::bytea), 'hex'));
  perform _r1_pr3_tests.end_session(v_session, true);
  res := screening_v2.r1_settle_attempt(v_session, 'complete');
  perform _r1_pr3_tests.assert('a count past attempts_allowed is withheld instead of violating the CHECK',
    res->>'status' = 'ok' and not (res->>'counted')::boolean
    and (select attempts_counted = 1 and status = 'in_progress'
           from screening_v2.interview_rounds where id = v_round), res::text);
end;
$$;

-- r1_settle_attempt: only a SETTLED session settles; a counted attempt closes the round
do $$
declare
  owner constant uuid := '60000000-0000-4000-8000-000000000001';
  role_r1 constant uuid := '60000000-0000-4000-8000-000000000002';
  cand_s constant uuid := '60000000-0000-4000-8000-000000000701';
  cand_m constant uuid := '60000000-0000-4000-8000-000000000702';
  cand_c constant uuid := '60000000-0000-4000-8000-000000000703';
  cand_x constant uuid := '60000000-0000-4000-8000-000000000704';
  round_s constant uuid := '60000000-0000-4000-8000-000000000801';
  round_m constant uuid := '60000000-0000-4000-8000-000000000802';
  round_c constant uuid := '60000000-0000-4000-8000-000000000803';
  round_x constant uuid := '60000000-0000-4000-8000-000000000804';
  sess_s constant uuid := '60000000-0000-4000-8000-000000000901';
  sess_m constant uuid := '60000000-0000-4000-8000-000000000902';
  sess_c constant uuid := '60000000-0000-4000-8000-000000000903';
  sess_x constant uuid := '60000000-0000-4000-8000-000000000904';
  res jsonb;
  v_version integer;
begin
  insert into screening_v2.candidates (id, role_id, name) values
    (cand_s, role_r1, 'pr3 settled state'), (cand_m, role_r1, 'pr3 round mismatch'),
    (cand_c, role_r1, 'pr3 closing'), (cand_x, role_r1, 'pr3 cancelled round');
  insert into screening_v2.interview_rounds
    (id, candidate_id, role_id, link_token_digest, expires_at, created_by, status) values
    (round_s, cand_s, role_r1, encode(sha256('r1-pr3-state-link-s'::bytea), 'hex'),
     '2099-01-01 00:00:00+00', owner, 'in_progress'),
    (round_m, cand_m, role_r1, encode(sha256('r1-pr3-state-link-m'::bytea), 'hex'),
     '2099-01-01 00:00:00+00', owner, 'in_progress'),
    (round_c, cand_c, role_r1, encode(sha256('r1-pr3-state-link-c'::bytea), 'hex'),
     '2099-01-01 00:00:00+00', owner, 'in_progress'),
    (round_x, cand_x, role_r1, encode(sha256('r1-pr3-state-link-x'::bytea), 'hex'),
     '2099-01-01 00:00:00+00', owner, 'cancelled');
  insert into screening_v2.call_sessions
    (id, candidate_id, role_id, mode, provider, external_call_id, status, interview_round_id, owner_id)
  values
    (sess_s, cand_s, role_r1, 'browser', 'livekit', 'screening-' || sess_s::text, 'created', round_s, owner),
    -- sess_m belongs to round_m, but its attempt row below points at round_s.
    (sess_m, cand_m, role_r1, 'browser', 'livekit', 'screening-' || sess_m::text, 'created', round_m, owner),
    (sess_c, cand_c, role_r1, 'browser', 'livekit', 'screening-' || sess_c::text, 'created', round_c, owner),
    (sess_x, cand_x, role_r1, 'browser', 'livekit', 'screening-' || sess_x::text, 'created', round_x, owner);
  insert into screening_v2.interview_round_attempts
    (session_id, round_id, attempt_number, persona_id, nonce_digest) values
    (sess_s, round_s, 1, 'p1_career_switcher', encode(sha256('r1-pr3-state-nonce-s'::bytea), 'hex')),
    (sess_m, round_s, 1, 'p1_career_switcher', encode(sha256('r1-pr3-state-nonce-m'::bytea), 'hex')),
    (sess_c, round_c, 1, 'p2_recent_grad', encode(sha256('r1-pr3-state-nonce-c'::bytea), 'hex')),
    (sess_x, round_x, 1, 'p3_data_analyst', encode(sha256('r1-pr3-state-nonce-x'::bytea), 'hex'));

  -- A LIVE session is never settled, whatever the outcome: the worker posts an
  -- outcome even when its terminal write failed, and the secret is shared.
  select version into v_version from screening_v2.interview_rounds where id = round_s;
  perform _r1_pr3_tests.assert('a created session is not settled, not even by a complete outcome',
    (screening_v2.r1_settle_attempt(sess_s, 'complete')->>'status') = 'session_not_settled'
    and (screening_v2.r1_settle_attempt(sess_s, 'no_show')->>'status') = 'session_not_settled');
  update screening_v2.call_sessions set status = 'in_progress' where id = sess_s;
  perform _r1_pr3_tests.assert('an in-progress session is not settled either',
    (screening_v2.r1_settle_attempt(sess_s, 'candidate_left')->>'status') = 'session_not_settled'
    and (screening_v2.r1_settle_attempt(sess_s, 'complete')->>'status') = 'session_not_settled');
  perform _r1_pr3_tests.assert('a refused settlement changes nothing',
    (select a.outcome is null and not a.counted
       from screening_v2.interview_round_attempts a where a.session_id = sess_s)
    and (select r.attempts_counted = 0 and r.status = 'in_progress' and r.version = v_version
           from screening_v2.interview_rounds r where r.id = round_s));

  -- `complete` needs a COMPLETED session; a failed one can only report a failure.
  update screening_v2.call_sessions
     set status = 'failed', terminal_reason = 'worker_crash' where id = sess_s;
  res := screening_v2.r1_settle_attempt(sess_s, 'complete');
  perform _r1_pr3_tests.assert('complete is refused for a session that failed',
    res->>'status' = 'session_not_settled'
    and (select a.outcome is null from screening_v2.interview_round_attempts a
          where a.session_id = sess_s), res::text);
  res := screening_v2.r1_settle_attempt(sess_s, 'provider_error');
  perform _r1_pr3_tests.assert('the refusal did not poison the attempt: a true outcome still settles',
    res->>'status' = 'ok' and not (res->>'counted')::boolean
    and (select a.outcome = 'provider_error' from screening_v2.interview_round_attempts a
          where a.session_id = sess_s), res::text);

  -- The session must belong to the attempt's own round.
  perform _r1_pr3_tests.end_session(sess_m, false);
  res := screening_v2.r1_settle_attempt(sess_m, 'provider_error');
  perform _r1_pr3_tests.assert('an attempt whose session belongs to another round is not settled',
    res->>'status' = 'session_not_settled'
    and (select a.outcome is null from screening_v2.interview_round_attempts a
          where a.session_id = sess_m), res::text);

  -- A counted attempt closes the round, once, with the count.
  perform _r1_pr3_tests.end_session(sess_c, true);
  select version into v_version from screening_v2.interview_rounds where id = round_c;
  res := screening_v2.r1_settle_attempt(sess_c, 'complete');
  perform _r1_pr3_tests.assert('a counted completion closes the round in the same step as the count',
    res->>'status' = 'ok' and (res->>'counted')::boolean
    and (select r.status = 'completed' and r.attempts_counted = 1 and r.version = v_version + 1
           from screening_v2.interview_rounds r where r.id = round_c), res::text);
  res := screening_v2.r1_settle_attempt(sess_c, 'complete');
  perform _r1_pr3_tests.assert('a replay neither counts again nor bumps the round',
    res->>'status' = 'duplicate'
    and (select r.status = 'completed' and r.attempts_counted = 1 and r.version = v_version + 1
           from screening_v2.interview_rounds r where r.id = round_c), res::text);

  -- A round HR already cancelled keeps its status; only the count is recorded.
  perform _r1_pr3_tests.end_session(sess_x, true);
  res := screening_v2.r1_settle_attempt(sess_x, 'complete');
  perform _r1_pr3_tests.assert('a counted attempt never resurrects a cancelled round',
    res->>'status' = 'ok' and (res->>'counted')::boolean
    and (select r.status = 'cancelled' and r.attempts_counted = 1
           from screening_v2.interview_rounds r where r.id = round_x), res::text);
end;
$$;

-- r1_withdraw_consent -----------------------------------------------------
do $$
declare
  owner constant uuid := '60000000-0000-4000-8000-000000000001';
  role_r1 constant uuid := '60000000-0000-4000-8000-000000000002';
  tpl constant uuid := '60000000-0000-4000-8000-000000000003';
  cand_a constant uuid := '60000000-0000-4000-8000-000000000131';
  cand_b constant uuid := '60000000-0000-4000-8000-000000000132';
  cand_c constant uuid := '60000000-0000-4000-8000-000000000133';
  cand_d constant uuid := '60000000-0000-4000-8000-000000000134';
  round_a constant uuid := '60000000-0000-4000-8000-000000000231';
  round_b constant uuid := '60000000-0000-4000-8000-000000000232';
  round_c constant uuid := '60000000-0000-4000-8000-000000000233';
  round_d constant uuid := '60000000-0000-4000-8000-000000000234';
  sess_a constant uuid := '60000000-0000-4000-8000-000000000331';
  sess_b constant uuid := '60000000-0000-4000-8000-000000000332';
  res jsonb;
  refused boolean;
  v_locale text;
begin
  -- Inactive on purpose: this fixture must never become the authoritative template.
  insert into screening_v2.interview_round_consent_templates
    (id, version, locale, title, body_md, required_consents, is_active)
  values (tpl, 'pr3-withdraw-fixture', 'en-IN', 'PR-3 fixture', 'fixture',
          '["recording"]'::jsonb, false);
  insert into screening_v2.candidates (id, role_id, name) values
    (cand_a, role_r1, 'pr3 withdraw a'), (cand_b, role_r1, 'pr3 withdraw b'),
    (cand_c, role_r1, 'pr3 withdraw c'), (cand_d, role_r1, 'pr3 withdraw d');
  insert into screening_v2.interview_rounds
    (id, candidate_id, role_id, link_token_digest, expires_at, created_by, status) values
    (round_a, cand_a, role_r1, encode(sha256('r1-pr3-withdraw-link-a'::bytea), 'hex'),
     '2099-01-01 00:00:00+00', owner, 'in_progress'),
    (round_b, cand_b, role_r1, encode(sha256('r1-pr3-withdraw-link-b'::bytea), 'hex'),
     '2099-01-01 00:00:00+00', owner, 'in_progress'),
    (round_c, cand_c, role_r1, encode(sha256('r1-pr3-withdraw-link-c'::bytea), 'hex'),
     '2099-01-01 00:00:00+00', owner, 'invited'),
    (round_d, cand_d, role_r1, encode(sha256('r1-pr3-withdraw-link-d'::bytea), 'hex'),
     '2099-01-01 00:00:00+00', owner, 'invited');
  insert into screening_v2.interview_round_consents (round_id, template_id, consents, proof) values
    (round_d, tpl, '["recording"]'::jsonb, '{"decision":"granted"}'::jsonb),
    (round_a, tpl, '["recording"]'::jsonb,
     '{"decision":"granted","template_version":"pr3","locale":"en-IN","captured_at":"2031-03-01T09:00:00Z","ip_prefix":"198.51.100.0/24","user_agent":"grant-agent"}'::jsonb),
    (round_b, tpl, '["recording"]'::jsonb, '{"decision":"granted"}'::jsonb);
  insert into screening_v2.call_sessions
    (id, candidate_id, role_id, mode, provider, external_call_id, status, interview_round_id, owner_id) values
    (sess_a, cand_a, role_r1, 'browser', 'livekit', 'screening-' || sess_a::text, 'created', round_a, owner),
    (sess_b, cand_b, role_r1, 'browser', 'livekit', 'screening-' || sess_b::text, 'created', round_b, owner);
  update screening_v2.call_sessions set status = 'in_progress' where id = sess_b;

  res := screening_v2.r1_withdraw_consent(
    round_a, '{"decision":"granted","ip_prefix":"203.0.113.0/24"}'::jsonb,
    '2031-03-02 10:00:00+00');
  perform _r1_pr3_tests.assert('withdrawal reports the one live consent and the live created session',
    res->>'status' = 'ok' and (res->>'withdrawn')::integer = 1
    and jsonb_array_length(res->'live_sessions') = 1
    and res->'live_sessions'->0->>'session_id' = sess_a::text
    and res->'live_sessions'->0->>'status' = 'created', res::text);
  perform _r1_pr3_tests.assert('the consent is withdrawn and the decision is not overridable',
    (select c.withdrawn_at = '2031-03-02 10:00:00+00'
        and c.proof->>'decision' = 'withdrawn'
        and c.proof->>'withdrawn_at' is not null
       from screening_v2.interview_round_consents c where c.round_id = round_a));
  -- DPDP evidence: who consented, from where and to which notice survives the
  -- withdrawal; the withdrawal's own context sits beside it, never over it.
  perform _r1_pr3_tests.assert('the grant evidence survives and the withdrawal context is nested',
    (select c.proof->>'ip_prefix' = '198.51.100.0/24'
        and c.proof->>'user_agent' = 'grant-agent'
        and c.proof->>'captured_at' = '2031-03-01T09:00:00Z'
        and c.proof->>'locale' = 'en-IN'
        and c.proof->>'template_version' = 'pr3'
        and c.proof->'withdrawal'->>'ip_prefix' = '203.0.113.0/24'
       from screening_v2.interview_round_consents c where c.round_id = round_a));
  res := screening_v2.r1_withdraw_consent(round_a);
  perform _r1_pr3_tests.assert('a repeated withdrawal changes nothing and still reports the live session',
    res->>'status' = 'ok' and (res->>'withdrawn')::integer = 0
    and jsonb_array_length(res->'live_sessions') = 1
    and (select count(*) = 1 from screening_v2.interview_round_consents where round_id = round_a), res::text);

  res := screening_v2.r1_withdraw_consent(round_b, p_decision => 'declined');
  perform _r1_pr3_tests.assert('an in-progress session is reported so the API can cut its room',
    (res->>'withdrawn')::integer = 1 and res->'live_sessions'->0->>'status' = 'in_progress', res::text);
  perform _r1_pr3_tests.assert('a decline after a grant is stored as declined, which PR-7 reads',
    (select c.proof->>'decision' = 'declined' and c.withdrawn_at is not null
       from screening_v2.interview_round_consents c where c.round_id = round_b));

  perform _r1_pr3_tests.assert('an unknown decision is refused and changes nothing',
    (screening_v2.r1_withdraw_consent(round_c, p_decision => 'bogus')->>'status') = 'invalid_decision'
    and (screening_v2.r1_withdraw_consent(round_c, p_decision => null)->>'status') = 'invalid_decision');

  res := screening_v2.r1_withdraw_consent(round_c);
  perform _r1_pr3_tests.assert('a round with no consent and no session is a clean no-op',
    res->>'status' = 'ok' and (res->>'withdrawn')::integer = 0
    and jsonb_array_length(res->'live_sessions') = 0, res::text);
  perform _r1_pr3_tests.assert('an unknown round is reported',
    (screening_v2.r1_withdraw_consent('60000000-0000-4000-8000-0000000002ff')->>'status') = 'round_not_found');

  -- The audience column admits exactly the two notices 0123 ships, and no other value
  -- (a LIKE over the constraint text would pass with a third locale allowed).
  foreach v_locale in array array['fr-FR', 'en', 'EN-IN', 'en-IN-x-other', ''] loop
    refused := false;
    begin
      update screening_v2.interview_rounds set consent_locale = v_locale where id = round_c;
    exception when check_violation then
      refused := true;
    end;
    perform _r1_pr3_tests.assert('consent_locale refuses ' || quote_literal(v_locale), refused);
  end loop;
  update screening_v2.interview_rounds set consent_locale = 'en-IN-x-staff' where id = round_c;
  perform _r1_pr3_tests.assert('consent_locale admits the staff dry-run notice',
    (select consent_locale = 'en-IN-x-staff' from screening_v2.interview_rounds where id = round_c));

  -- The audience is locked once a consent exists or the round has left `invited`: re-marking
  -- the round would leave a consent given to the other notice standing as `granted`.
  update screening_v2.interview_rounds set consent_locale = 'en-IN' where id = round_c;
  perform _r1_pr3_tests.assert('an invited round with no consent can still be re-marked',
    (select consent_locale = 'en-IN' from screening_v2.interview_rounds where id = round_c));
  refused := false;
  begin
    update screening_v2.interview_rounds set consent_locale = 'en-IN-x-staff' where id = round_d;
  exception when raise_exception then
    refused := true;
  end;
  perform _r1_pr3_tests.assert('an invited round WITH a consent record keeps its audience', refused);
  -- Withdrawn or declined, the record still says which notice the person saw.
  perform screening_v2.r1_withdraw_consent(round_d);
  refused := false;
  begin
    update screening_v2.interview_rounds set consent_locale = 'en-IN-x-staff' where id = round_d;
  exception when raise_exception then
    refused := true;
  end;
  perform _r1_pr3_tests.assert('a withdrawn consent still locks the audience of an invited round',
    refused and (select status = 'invited' from screening_v2.interview_rounds where id = round_d));
  refused := false;
  begin
    update screening_v2.interview_rounds set consent_locale = 'en-IN-x-staff' where id = round_a;
  exception when raise_exception then
    refused := true;
  end;
  perform _r1_pr3_tests.assert('an in-progress round keeps its audience', refused);
  refused := false;
  begin
    -- No consent row at all, but the round is no longer `invited`.
    update screening_v2.interview_rounds set status = 'in_progress' where id = round_c;
    update screening_v2.interview_rounds set consent_locale = 'en-IN-x-staff' where id = round_c;
  exception when raise_exception then
    refused := true;
  end;
  perform _r1_pr3_tests.assert('a round that has left invited keeps its audience', refused);
  update screening_v2.interview_rounds set status = 'invited' where id = round_c;
  update screening_v2.interview_rounds set consent_locale = consent_locale where id = round_d;
  update screening_v2.interview_rounds set status = status where id = round_d;
  perform _r1_pr3_tests.assert('a write that leaves the audience unchanged is never refused',
    (select consent_locale = 'en-IN' from screening_v2.interview_rounds where id = round_d));
  perform _r1_pr3_tests.assert('every round still reads the audience it was given',
    (select count(*) = 2 from screening_v2.interview_rounds
      where id in (round_a, round_d) and consent_locale = 'en-IN'));

  -- Withdrawal blocks admission: with R1 open, the withdrawn round has no live consent.
  update screening_v2.r1_settings
     set enabled = true, paused = false, livekit_target = 'r1',
         monthly_cap_minutes = 100000, pause_line_minutes = 100000, dashboard_minutes = 0;
  update screening_v2.call_sessions set status = 'cancelled', terminal_reason = 'recruiter_cancelled'
   where id = sess_a;
  res := screening_v2.r1_admit_attempt(round_a, encode(sha256('r1-pr3-withdraw-admit'::bytea), 'hex'));
  perform _r1_pr3_tests.assert('admission refuses a round whose consent was withdrawn',
    res->>'status' = 'consent_missing', res::text);
end;
$$;

-- A round closed by a counted attempt: no second start, and HR can grant the retake.
-- (The settings were opened by the withdrawal block above.)
do $$
declare
  round_c constant uuid := '60000000-0000-4000-8000-000000000803';
  res jsonb;
begin
  res := screening_v2.r1_admit_attempt(
    round_c, encode(sha256('r1-pr3-closed-round-admit'::bytea), 'hex'));
  perform _r1_pr3_tests.assert('a counted attempt cannot be followed by a second start before scoring',
    res->>'status' = 'round_not_admissible', res::text);
  perform _r1_pr3_tests.assert('the refused admission started nothing',
    (select count(*) = 1 from screening_v2.interview_round_attempts where round_id = round_c)
    and (select r.starts_used = 0 from screening_v2.interview_rounds r where r.id = round_c));

  res := screening_v2.r1_transition_round(
    round_c, 'grant-retake',
    (select r.version from screening_v2.interview_rounds r where r.id = round_c),
    null, '2099-06-01 00:00:00+00', '2031-03-03 10:00:00+00');
  perform _r1_pr3_tests.assert('HR can grant the retake once the counted session completed',
    res->>'status' = 'ok'
    and (select r.status = 'invited' and r.attempts_counted = 1
           from screening_v2.interview_rounds r where r.id = round_c), res::text);
end;
$$;

drop schema _r1_pr3_tests cascade;
