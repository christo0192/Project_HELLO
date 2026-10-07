-- Executed by scripts/test-r1-foundation.sh inside the complete 0001..0126 Supabase
-- schema, AFTER the 0120 candidate-route assertions. Covers migration 0126: a COUNTED attempt
-- whose session did not complete is scored (r1_settle_attempt enqueues r1.assessment), and HR
-- can retake it (r1_transition_round grant-retake no longer needs a `completed` session).
--
-- Fixture ids live in 70000000-... and are self-contained: a role and an inactive consent
-- template of its own, one round + one session + one attempt per scenario.
create schema if not exists _r1_pr4_tests;
create or replace function _r1_pr4_tests.assert(p_label text, p_ok boolean, p_detail text default '')
returns void language plpgsql as $$
begin
  -- `is not true`, not `not`: a NULL condition must fail, never pass silently.
  if p_ok is not true then raise exception 'R1 PR-B FAIL: % (%)', p_label, p_detail; end if;
  raise notice 'R1 PR-B PASS: %', p_label;
end;
$$;

do $$
declare
  owner constant uuid := '70000000-0000-4000-8000-000000000001';
  tpl constant uuid := '70000000-0000-4000-8000-000000000003';
begin
  insert into auth.users (id, email) values (owner, 'r1-prb-assert@example.test')
  on conflict (id) do nothing;
  -- Inactive on purpose: this fixture must never become the authoritative template.
  insert into screening_v2.interview_round_consent_templates
    (id, version, locale, title, body_md, required_consents, is_active)
  values (tpl, 'prb-incomplete-fixture', 'en-IN', 'PR-B fixture', 'fixture',
          '["recording"]'::jsonb, false)
  on conflict (id) do nothing;
  if not exists (select 1 from screening_v2.roles where interview_kind = 'sales_r1') then
    insert into screening_v2.roles (id, title, interview_kind)
    values ('70000000-0000-4000-8000-000000000002', 'R1 PR-B assertion role', 'sales_r1');
  end if;
end;
$$;

-- One scenario: a candidate, an in_progress round, a `created` session with its attempt, an
-- optional transcript turn and an optional consent ('live', 'withdrawn' or 'none').
create or replace function _r1_pr4_tests.fixture(
  p_n integer,
  p_turn_phase text,
  p_consent text,
  p_attempts_allowed integer default 2
)
returns uuid
language plpgsql
as $$
declare
  owner constant uuid := '70000000-0000-4000-8000-000000000001';
  tpl constant uuid := '70000000-0000-4000-8000-000000000003';
  v_role uuid;
  v_candidate uuid := ('70000000-0000-4000-8000-0000000001' || lpad(p_n::text, 2, '0'))::uuid;
  v_round uuid := ('70000000-0000-4000-8000-0000000002' || lpad(p_n::text, 2, '0'))::uuid;
  v_session uuid := ('70000000-0000-4000-8000-0000000003' || lpad(p_n::text, 2, '0'))::uuid;
begin
  select r.id into v_role from screening_v2.roles r where r.interview_kind = 'sales_r1' limit 1;
  insert into screening_v2.candidates (id, role_id, name)
  values (v_candidate, v_role, 'prb incomplete ' || p_n::text);
  insert into screening_v2.interview_rounds
    (id, candidate_id, role_id, link_token_digest, expires_at, created_by, status, attempts_allowed)
  values (v_round, v_candidate, v_role,
          encode(sha256(('r1-prb-link-' || p_n::text)::bytea), 'hex'),
          '2099-01-01 00:00:00+00', owner, 'in_progress', p_attempts_allowed);
  insert into screening_v2.call_sessions
    (id, candidate_id, role_id, mode, provider, external_call_id, status, interview_round_id, owner_id)
  values (v_session, v_candidate, v_role, 'browser', 'livekit',
          'screening-' || v_session::text, 'created', v_round, owner);
  insert into screening_v2.interview_round_attempts
    (session_id, round_id, attempt_number, persona_id, nonce_digest)
  values (v_session, v_round, 1, 'p1_career_switcher',
          encode(sha256(('r1-prb-nonce-' || p_n::text)::bytea), 'hex'));
  if p_turn_phase is not null then
    insert into screening_v2.transcript_turns (session_id, turn_index, speaker, text, phase)
    values (v_session, 1, 'bot', 'prb fixture turn', p_turn_phase);
  end if;
  if p_consent in ('live', 'withdrawn') then
    insert into screening_v2.interview_round_consents
      (round_id, template_id, consents, proof, withdrawn_at)
    values (v_round, tpl, '["recording"]'::jsonb, '{"decision":"granted"}'::jsonb,
            case when p_consent = 'withdrawn' then '2031-04-01 09:00:00+00'::timestamptz else null end);
  end if;
  return v_session;
end;
$$;

-- The worker's terminal write, then its attempt-outcome post.
create or replace function _r1_pr4_tests.end_session(p_session uuid, p_status text, p_reason text)
returns void language plpgsql as $$
begin
  if p_status = 'completed' then
    update screening_v2.call_sessions set status = 'in_progress' where id = p_session;
  end if;
  update screening_v2.call_sessions
     set status = p_status, terminal_reason = p_reason
   where id = p_session;
end;
$$;

create or replace function _r1_pr4_tests.jobs(p_session uuid)
returns integer language sql as $$
  select count(*)::integer from screening_v2.job_queue
   where name = 'r1.assessment' and dedup_key = 'r1.assessment:' || p_session::text;
$$;

create or replace function _r1_pr4_tests.round_of(p_session uuid)
returns uuid language sql as $$
  select a.round_id from screening_v2.interview_round_attempts a where a.session_id = p_session;
$$;

create or replace function _r1_pr4_tests.retake(p_round uuid)
returns jsonb language sql as $$
  select screening_v2.r1_transition_round(
    p_round, 'grant-retake',
    (select r.version from screening_v2.interview_rounds r where r.id = p_round),
    null, '2099-06-01 00:00:00+00', '2031-04-03 10:00:00+00');
$$;

-- Catalog: the replaced functions keep their definer hygiene and service_role-only ACL.
do $$
declare
  fn text;
begin
  foreach fn in array array[
    'screening_v2.r1_settle_attempt(uuid, text, timestamptz)',
    'screening_v2.r1_transition_round(uuid, text, integer, text, timestamptz, timestamptz)'
  ] loop
    perform _r1_pr4_tests.assert(fn || ' is security definer with a pinned search_path',
      (select p.prosecdef and p.proconfig @> array['search_path=pg_catalog, screening_v2']
         from pg_proc p where p.oid = fn::regprocedure));
    perform _r1_pr4_tests.assert(fn || ' is executable by service_role only',
      has_function_privilege('service_role', fn, 'execute')
      and not has_function_privilege('anon', fn, 'execute')
      and not has_function_privilege('authenticated', fn, 'execute')
      and not has_function_privilege('public', fn, 'execute'));
  end loop;
end;
$$;

-- A counted attempt whose session ENDED FAILED is scored, exactly once, and can be retaken.
do $$
declare
  sid uuid;
  rid uuid;
  res jsonb;
begin
  -- A. The candidate left after the role-play began; the round holds a live consent.
  sid := _r1_pr4_tests.fixture(1, 'roleplay', 'live');
  rid := _r1_pr4_tests.round_of(sid);
  perform _r1_pr4_tests.end_session(sid, 'failed', 'worker_crash');
  perform _r1_pr4_tests.assert('nothing is queued before the worker settles the attempt',
    _r1_pr4_tests.jobs(sid) = 0);
  res := screening_v2.r1_settle_attempt(sid, 'candidate_left');
  perform _r1_pr4_tests.assert('a counted candidate_left on a failed session is settled and counted',
    res->>'status' = 'ok' and (res->>'counted')::boolean
    and (select r.status = 'completed' and r.attempts_counted = 1
           from screening_v2.interview_rounds r where r.id = rid), res::text);
  perform _r1_pr4_tests.assert('...and enqueues exactly one deduped r1.assessment job (same shape as the 0116 trigger)',
    _r1_pr4_tests.jobs(sid) = 1
    and exists (select 1 from screening_v2.job_queue j
                 where j.dedup_key = 'r1.assessment:' || sid::text
                   and j.name = 'r1.assessment' and j.max_attempts = 5
                   and j.status = 'pending' and j.payload->>'session_id' = sid::text));
  res := screening_v2.r1_settle_attempt(sid, 'candidate_left');
  perform _r1_pr4_tests.assert('a replay is a duplicate and queues nothing more',
    res->>'status' = 'duplicate' and _r1_pr4_tests.jobs(sid) = 1, res::text);
  res := screening_v2.r1_settle_attempt(sid, 'no_show');
  perform _r1_pr4_tests.assert('a different outcome conflicts and queues nothing more',
    res->>'status' = 'outcome_conflict' and _r1_pr4_tests.jobs(sid) = 1, res::text);
  res := _r1_pr4_tests.retake(rid);
  perform _r1_pr4_tests.assert('HR can grant the retake of a counted FAILED attempt (was retake_not_allowed)',
    res->>'status' = 'ok'
    and (select r.status = 'invited' and r.attempts_counted = 1
           from screening_v2.interview_rounds r where r.id = rid), res::text);

  -- B. The residency cap ended the session.
  sid := _r1_pr4_tests.fixture(2, 'wrapup', 'live');
  rid := _r1_pr4_tests.round_of(sid);
  perform _r1_pr4_tests.end_session(sid, 'failed', 'residency_timeout');
  res := screening_v2.r1_settle_attempt(sid, 'residency_timeout');
  perform _r1_pr4_tests.assert('a counted residency_timeout is scored too',
    res->>'status' = 'ok' and (res->>'counted')::boolean and _r1_pr4_tests.jobs(sid) = 1, res::text);
  perform _r1_pr4_tests.assert('...and its round can be retaken',
    _r1_pr4_tests.retake(rid)->>'status' = 'ok');
end;
$$;

-- What must NOT be scored.
do $$
declare
  sid uuid;
  rid uuid;
  res jsonb;
begin
  -- C. Consent withdrawn: the attempt still counts, but a withdrawal stops all processing.
  sid := _r1_pr4_tests.fixture(3, 'roleplay', 'withdrawn');
  perform _r1_pr4_tests.end_session(sid, 'failed', 'worker_crash');
  res := screening_v2.r1_settle_attempt(sid, 'candidate_left');
  perform _r1_pr4_tests.assert('a withdrawn consent is counted but never scored',
    res->>'status' = 'ok' and (res->>'counted')::boolean and _r1_pr4_tests.jobs(sid) = 0, res::text);

  -- D. No consent record at all.
  sid := _r1_pr4_tests.fixture(4, 'roleplay', 'none');
  perform _r1_pr4_tests.end_session(sid, 'failed', 'worker_crash');
  res := screening_v2.r1_settle_attempt(sid, 'candidate_left');
  perform _r1_pr4_tests.assert('a round with no live consent is never scored',
    res->>'status' = 'ok' and (res->>'counted')::boolean and _r1_pr4_tests.jobs(sid) = 0, res::text);

  -- E. Left before TRANSITION: uncounted, so nothing to score and no retake to grant.
  sid := _r1_pr4_tests.fixture(5, 'icebreaker', 'live');
  rid := _r1_pr4_tests.round_of(sid);
  perform _r1_pr4_tests.end_session(sid, 'failed', 'worker_crash');
  res := screening_v2.r1_settle_attempt(sid, 'candidate_left');
  perform _r1_pr4_tests.assert('leaving before TRANSITION is uncounted and queues nothing',
    res->>'status' = 'ok' and not (res->>'counted')::boolean and _r1_pr4_tests.jobs(sid) = 0, res::text);
  perform _r1_pr4_tests.assert('...the round stays open and no retake is offered',
    (select r.status = 'in_progress' from screening_v2.interview_rounds r where r.id = rid)
    and _r1_pr4_tests.retake(rid)->>'status' = 'retake_not_allowed');

  -- F. A system failure never counts, even after the role-play began.
  sid := _r1_pr4_tests.fixture(6, 'roleplay', 'live');
  perform _r1_pr4_tests.end_session(sid, 'failed', 'provider_error');
  res := screening_v2.r1_settle_attempt(sid, 'provider_error');
  perform _r1_pr4_tests.assert('a system failure is uncounted and queues nothing',
    res->>'status' = 'ok' and not (res->>'counted')::boolean and _r1_pr4_tests.jobs(sid) = 0, res::text);

  -- H. A cancelled session (the recruiter or a withdrawal stopped it) is never queued by settle.
  sid := _r1_pr4_tests.fixture(8, 'roleplay', 'live');
  perform _r1_pr4_tests.end_session(sid, 'cancelled', 'recruiter_cancelled');
  res := screening_v2.r1_settle_attempt(sid, 'candidate_left');
  perform _r1_pr4_tests.assert('a cancelled session is settled but never queued',
    res->>'status' = 'ok' and _r1_pr4_tests.jobs(sid) = 0, res::text);
end;
$$;

-- G and I. The completed path is unchanged; a single-attempt round cannot be retaken.
do $$
declare
  sid uuid;
  rid uuid;
  res jsonb;
begin
  -- G. Completion enqueues once (the 0116 trigger); settling a completed attempt adds nothing.
  sid := _r1_pr4_tests.fixture(7, 'roleplay', 'live');
  rid := _r1_pr4_tests.round_of(sid);
  perform _r1_pr4_tests.end_session(sid, 'completed', 'conversation_complete');
  perform _r1_pr4_tests.assert('completion enqueues exactly one job (the 0116 trigger)',
    _r1_pr4_tests.jobs(sid) = 1);
  res := screening_v2.r1_settle_attempt(sid, 'complete');
  perform _r1_pr4_tests.assert('settling a completed attempt counts it and queues no second job',
    res->>'status' = 'ok' and (res->>'counted')::boolean and _r1_pr4_tests.jobs(sid) = 1, res::text);
  perform _r1_pr4_tests.assert('the retake of a completed attempt still works',
    _r1_pr4_tests.retake(rid)->>'status' = 'ok');

  -- I. attempts_allowed = 1: a counted failed attempt is scored but there is no retake to grant.
  sid := _r1_pr4_tests.fixture(9, 'roleplay', 'live', 1);
  rid := _r1_pr4_tests.round_of(sid);
  perform _r1_pr4_tests.end_session(sid, 'failed', 'worker_crash');
  res := screening_v2.r1_settle_attempt(sid, 'candidate_left');
  perform _r1_pr4_tests.assert('a single-attempt round still scores its counted failed attempt',
    res->>'status' = 'ok' and (res->>'counted')::boolean and _r1_pr4_tests.jobs(sid) = 1, res::text);
  perform _r1_pr4_tests.assert('...but offers no retake (attempts_allowed = 1)',
    _r1_pr4_tests.retake(rid)->>'status' = 'retake_not_allowed');
end;
$$;

drop schema _r1_pr4_tests cascade;
