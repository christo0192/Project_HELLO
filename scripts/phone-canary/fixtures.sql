-- ═══════════════════════════════════════════════════════════════════════
--  fixtures.sql — the reusable Canary-0 substrate
-- ═══════════════════════════════════════════════════════════════════════
--
-- Apply this FIRST, then `canary0.sql`, then `teardown.sql`.
--
-- WHY IT IS A SEPARATE FILE. `canary0.sql` proves the nine scenarios one
-- session can express. The tenth — a halt landing on an admission that is
-- already blocked on `pg_advisory_xact_lock(hashtext('phone_admission'))` —
-- needs two CONTENDING sessions, so it is driven from the Node runner after
-- `canary0.sql` has finished. That runner calls the same fixture and
-- teardown helpers, which therefore cannot live in the file that used to
-- drop them on its way out.
--
-- IT EMITS NOTHING. Query output and command tags are redirected for the
-- whole file, so applying it cannot inject a line into the protocol stream
-- the runner parses.

\set QUIET on
\o /dev/null

-- Only real problems reach stderr. A runner that has to filter chatter to
-- find a failure will one day filter a failure.
set client_min_messages = warning;

-- ── Idempotent, and re-runnable while a canary is mid-flight ──────────
-- Nothing here DROPS. The runner applies this file, runs `canary0.sql`,
-- then drives the halt RACE from Node through these same helpers — so a
-- re-application must never pull the schema out from under work already in
-- progress. The two report tables are the only state that must not survive
-- a re-run, and `canary0.sql` truncates those itself.
create schema if not exists _phone_canary;

create table if not exists _phone_canary.verdict (
  ord        bigserial primary key,
  scenario   text not null,
  check_name text not null,
  ok         boolean not null,
  code       text not null
);

create table if not exists _phone_canary.metric (
  ord      bigserial primary key,
  scenario text not null,
  key      text not null,
  value    bigint not null
);

-- `p_code` is a STABLE CODE and never a value. Both are re-asserted here
-- against the protocol grammar rather than trusted, because a canary that
-- can print an identifier is a canary whose manifest cannot be published.
create or replace function _phone_canary.chk(
  p_scenario text, p_check text, p_ok boolean, p_code text
) returns void language plpgsql as $$
begin
  if p_scenario !~ '^[a-z][a-z0-9_]{2,63}$' then
    raise exception 'canary scenario name violates protocol';
  end if;
  if p_check !~ '^[a-z][a-z0-9_]{2,79}$' then
    raise exception 'canary check name violates protocol';
  end if;
  if p_code is null or p_code !~ '^[a-z][a-z0-9_]{0,63}$' then
    raise exception 'canary code violates protocol';
  end if;
  insert into _phone_canary.verdict (scenario, check_name, ok, code)
  values (p_scenario, p_check, coalesce(p_ok, false), p_code);
end;
$$;

-- A status literal read back from an RPC is already a closed vocabulary,
-- but it arrives as data. Passing it through this makes "the code I print
-- is a code" a property of the printer rather than of the caller.
create or replace function _phone_canary.code(p_status text)
returns text language sql immutable as $$
  select case
           when p_status is null then 'null_status'
           when p_status ~ '^[a-z][a-z0-9_]{0,63}$' then p_status
           else 'unprintable_status'
         end;
$$;

create or replace function _phone_canary.cnt(
  p_scenario text, p_key text, p_value bigint
) returns void language plpgsql as $$
begin
  if p_key !~ '^[a-z][a-z0-9_]{2,47}$' then
    raise exception 'canary metric key violates protocol';
  end if;
  if p_value is null or p_value < 0 or p_value > 999999999 then
    raise exception 'canary metric value out of protocol range';
  end if;
  insert into _phone_canary.metric (scenario, key, value)
  values (p_scenario, p_key, p_value);
end;
$$;

-- ── Fixtures ──────────────────────────────────────────────────────────
--
-- Modelled on `_policy_tests.phone_fixture` / `phone_teardown`, with two
-- deliberate departures:
--
--   * The canary owns its own ROLE, carrying a fixed four-question
--     screening template. The seeded roles carry templates of one and
--     three questions, and a plan length that moves with the seed would
--     make "the cursor is still 1 and the plan is not complete" — the
--     whole point of the reconnect scenario — depend on data this file
--     does not control.
--   * The phone number's last five digits are passed in EXPLICITLY rather
--     than hashed from the tag. `phone_suppressions` is unique on the
--     DIGEST of the line, so two fixtures that collided on a number would
--     make one scenario's opt-out suppress another scenario's candidate.
--     A hash makes that unlikely; an explicit suffix makes it impossible.

create or replace function _phone_canary.role_id()
returns uuid language sql stable as $$
  select id from screening_v2.roles where title = 'canary0 role';
$$;

create or replace function _phone_canary.ensure_role()
returns uuid language plpgsql as $$
declare v_id uuid;
begin
  select id into v_id from screening_v2.roles where title = 'canary0 role';
  if v_id is not null then return v_id; end if;
  insert into screening_v2.roles (title, jd, required_skills, screening_template, is_active)
  values (
    'canary0 role', 'canary0 fixture role', '[]'::jsonb,
    jsonb_build_array(
      jsonb_build_object('id','canary_q1','question','Question one.','mandatory',false),
      jsonb_build_object('id','canary_q2','question','Question two.','mandatory',true),
      jsonb_build_object('id','canary_q3','question','Question three.','mandatory',false),
      jsonb_build_object('id','canary_q4','question','Question four.','mandatory',true)
    ),
    true)
  returning id into v_id;
  return v_id;
end;
$$;

create or replace function _phone_canary.teardown(p_tag text)
returns void language plpgsql as $$
declare v_links uuid[]; v_engs uuid[]; v_cands uuid[]; v_sess uuid[];
begin
  select coalesce(array_agg(id), '{}') into v_cands
    from screening_v2.candidates where email = p_tag || '@example.test';
  select coalesce(array_agg(id), '{}') into v_links
    from screening_v2.ashby_application_links
   where external_application_id like p_tag || '-app%';
  select coalesce(array_agg(id), '{}') into v_engs
    from screening_v2.phone_engagements where application_link_id = any(v_links);
  select coalesce(array_agg(id), '{}') into v_sess
    from screening_v2.call_sessions where candidate_id = any(v_cands);

  delete from screening_v2.job_queue
   where dedup_key in (select 'phone.dial:' || id::text
                         from screening_v2.phone_call_attempts
                        where engagement_id = any(v_engs));

  -- The documented SET LOCAL escape hatch on the append-only ledger, used
  -- exactly as an erasure would use it and scoped to this transaction.
  perform set_config('app.allow_phone_event_mutation', 'true', true);
  delete from screening_v2.phone_call_events
   where engagement_id = any(v_engs)
      or attempt_id in (select id from screening_v2.phone_call_attempts
                         where engagement_id = any(v_engs));
  perform set_config('app.allow_phone_event_mutation', 'false', true);

  delete from screening_v2.phone_call_attempts where engagement_id = any(v_engs);
  delete from screening_v2.phone_appointments  where engagement_id = any(v_engs);
  -- The engagement's terminal-immutability trigger blocks UPDATE, not
  -- DELETE, so a terminal fixture tears down like any other.
  delete from screening_v2.phone_engagements   where id = any(v_engs);
  delete from screening_v2.ashby_resume_ingestions where application_link_id = any(v_links);
  delete from screening_v2.ashby_operations        where application_link_id = any(v_links);
  delete from screening_v2.ashby_application_links where id = any(v_links);
  delete from screening_v2.ashby_job_mappings where external_job_id like p_tag || '-job%';
  delete from screening_v2.assessments where session_id = any(v_sess);
  delete from screening_v2.transcript_turns where session_id = any(v_sess);
  delete from screening_v2.phone_session_progress where session_id = any(v_sess);
  delete from screening_v2.phone_session_plans where session_id = any(v_sess);
  delete from screening_v2.call_sessions where id = any(v_sess);
  delete from screening_v2.phone_suppressions where candidate_id = any(v_cands);
  delete from screening_v2.consent_records where candidate_id = any(v_cands);
  delete from screening_v2.candidates where id = any(v_cands);
end;
$$;

create or replace function _phone_canary.new_candidate(
  p_tag text, p_digits text
) returns uuid language plpgsql as $$
declare v_id uuid;
begin
  if p_digits !~ '^[0-9]{5}$' then
    raise exception 'canary fixture needs an explicit five-digit line suffix';
  end if;
  insert into screening_v2.candidates
    (role_id, name, email, phone_e164, phone_valid)
  values
    (_phone_canary.ensure_role(), 'canary0 ' || p_tag, p_tag || '@example.test',
     '+9199990' || p_digits, true)
  returning id into v_id;

  insert into screening_v2.consent_records (candidate_id, status, consents, version)
  values (v_id, 'granted',
          '{ai_interview,recording,purpose,data_processing,retention,rights}'
            ::screening_v2.consent_type[], '2026-08-04.1');
  return v_id;
end;
$$;

create or replace function _phone_canary.new_engagement(
  p_tag text, p_suffix text, p_candidate uuid, p_state text default 'eligible'
) returns uuid language plpgsql as $$
declare
  v_role uuid := _phone_canary.ensure_role();
  v_map uuid; v_link uuid; v_eng uuid;
  v_states text[] := array['queued','fetching','scanning','extracting','structuring','ready'];
  v_s text;
begin
  insert into screening_v2.ashby_job_mappings
    (external_job_id, role_id, owner_id, ai_screening_stage_id, ta_screening_stage_id,
     status, delivery_mode)
  values (p_tag || '-job' || p_suffix, v_role, '00000000-0000-4000-8000-0000000000ad',
          p_tag || '-ai' || p_suffix, p_tag || '-ta' || p_suffix, 'enabled', 'manual')
  returning id into v_map;

  insert into screening_v2.ashby_application_links
    (external_application_id, external_job_id, job_mapping_id,
     external_resume_file_handle, candidate_id)
  values (p_tag || '-app' || p_suffix, p_tag || '-job' || p_suffix, v_map,
          repeat('h', 64), p_candidate)
  returning id into v_link;

  foreach v_s in array v_states loop
    perform screening_v2.advance_ashby_ingestion(v_link, v_s, null, null, null, null);
  end loop;

  insert into screening_v2.phone_engagements
    (application_link_id, candidate_id, role_id, state)
  values (v_link, p_candidate, v_role, p_state)
  returning id into v_eng;
  return v_eng;
end;
$$;

-- One tag, one candidate, one engagement — the shape eight of the nine
-- scenarios want, and the shape the Node halt-race wants too.
--
-- `p_digits` is REQUIRED and deliberately not defaulted. `phone_suppressions`
-- is unique on the DIGEST of the line, so two live fixtures sharing a number
-- would let one caller's opt-out suppress another caller's candidate. A
-- default would make that collision the easy path; a mandatory argument
-- makes it unrepresentable. The nine scenarios in `canary0.sql` own
-- 10001..90001, so anything driven from outside this file must pick a
-- suffix outside that set.
create or replace function _phone_canary.fixture(
  p_tag text, p_digits text, p_state text default 'eligible'
) returns uuid language plpgsql as $$
begin
  perform _phone_canary.teardown(p_tag);
  return _phone_canary.new_engagement(
           p_tag, '', _phone_canary.new_candidate(p_tag, p_digits), p_state);
end;
$$;

-- The session a phone leg screens in. `start_phone_assessment` VERIFIES
-- `external_call_id = 'phone-' || session_id`, so the row is written and
-- then stamped with its own id rather than guessing one.
create or replace function _phone_canary.new_session(
  p_candidate uuid, p_now timestamptz
) returns uuid language plpgsql as $$
declare v_id uuid;
begin
  -- `enforce_insert_created` requires every session to BEGIN at `created`,
  -- so the row is written there and walked to `waiting` — the same path a
  -- real provisioning takes.
  insert into screening_v2.call_sessions
    (candidate_id, role_id, mode, provider, status, started_at, updated_at)
  values (p_candidate, _phone_canary.role_id(), 'live', 'livekit', 'created', p_now, p_now)
  returning id into v_id;
  update screening_v2.call_sessions
     set status = 'waiting',
         waiting_at = p_now,
         external_call_id = 'phone-' || v_id::text
   where id = v_id;
  return v_id;
end;
$$;

-- The provenance sentinel `valid_model_provenance` accepts verbatim. The
-- canary is not modelling a scoring run; it needs a row to exist so the
-- 0044 completion interlock has something real to find.
create or replace function _phone_canary.score(
  p_session uuid, p_candidate uuid, p_now timestamptz
) returns void language sql as $$
  insert into screening_v2.assessments
    (session_id, candidate_id, source, recommendation, overall_score, provenance,
     created_at, updated_at)
  values (p_session, p_candidate, 'phone', 'hold', 5.0,
          '{"schema_version":0,"provider":"legacy","requestedModel":"unknown","workload":"unknown","prompt_template_version":"legacy","timestamp":"1970-01-01T00:00:00Z"}'::jsonb,
          p_now, p_now);
$$;

-- A synthetic LiveKit/SIP ingress. The provider event id is derived from
-- the attempt and a caller-supplied ordinal so a replay is expressible.
create or replace function _phone_canary.sip(
  p_attempt uuid, p_event text, p_now timestamptz, p_seq integer default 1
) returns jsonb language sql as $$
  select screening_v2.apply_phone_event(
    'livekit_webhook', p_event, p_attempt, null,
    'canary0-' || replace(p_attempt::text, '-', '') || '-' || p_seq::text,
    null, null, p_now);
$$;

-- Created here rather than lazily inside the first fixture, so a caller
-- that only ever uses `new_session` still finds it.
select _phone_canary.ensure_role();

\o
