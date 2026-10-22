-- Executed by scripts/test-r1-concurrency.sh against a FRESH isolated Postgres with every
-- migration applied (0001..latest, so 0128's admission rule and 0131's concurrent limit).
--
-- Fixtures and helpers for the REAL parallel-session simulation of 0131. The script, not this
-- file, starts the racing sessions; this file only prepares each scenario and, afterwards,
-- proves from the database what the racers' answers already claim: exactly the expected number
-- of sessions, attempts, starts and 65-minute charges, and nothing charged twice.
--
-- The fixture shapes are r1_foundation_assert.sql's (_r1_tests.cand / send / consent / admit /
-- fail_live / settings): the same role, owner, consent template, Send, consent and admission
-- calls, under their own ids. Each scenario books into its OWN far-future month and its rounds
-- expire five days after its Send, so when a later scenario runs no earlier round is still a hold
-- or an uncounted charge at that scenario's `now`: every budget and snapshot figure is exact.
create schema if not exists _r1c;

create or replace function _r1c.u(p_n integer) returns uuid language sql immutable as $$
  select ('c1310000-0000-4000-8000-' || lpad(p_n::text, 12, '0'))::uuid;
$$;
create or replace function _r1c.digest(p_tag text) returns text language sql immutable as $$
  select encode(sha256(convert_to('r1-concurrency-' || p_tag, 'UTF8')), 'hex');
$$;
create or replace function _r1c.fail(p_label text, p_detail text) returns void language plpgsql as $$
begin
  raise exception 'R1 concurrency FAIL: % (%)', p_label, p_detail;
end;
$$;

-- The shipped default before anything below changes the singleton: 0131 ships inert.
do $$
begin
  if (select max_concurrent_sessions from screening_v2.r1_settings where singleton) is distinct from 1 then
    perform _r1c.fail('0131 ships with max_concurrent_sessions = 1',
      coalesce((select max_concurrent_sessions::text from screening_v2.r1_settings where singleton), '<no row>'));
  end if;
  raise notice 'R1 concurrency PASS: the shipped r1_settings row reads max_concurrent_sessions = 1';
end;
$$;

-- Base fixtures: the owner (call_sessions.owner_id and interview_rounds.created_by), one sales_r1
-- role, and a consent template at version 9002, which sorts above every shipped release (those
-- are dates starting with '2'), so it is the greatest active version admission demands.
insert into auth.users (id, email) values ('c1310000-0000-4000-8000-000000000001', 'r1-concurrency@example.test')
on conflict (id) do nothing;
insert into screening_v2.roles (id, title, interview_kind)
values ('c1310000-0000-4000-8000-000000000002', 'R1 concurrency role', 'sales_r1');
insert into screening_v2.interview_round_consent_templates
  (id, version, locale, title, body_md, required_consents, is_active)
values ('c1310000-0000-4000-8000-000000000003', '9002', 'en-IN', 'R1 concurrency test', 'test', '[]'::jsonb, true);

-- Noise lease rows that must never count toward the browser pool: a PHONE-pipeline row of the
-- browser app, and browser rows of another app. Five of them, so a pool count that included any
-- would admit more than its scenario expects (e.g. 9, not 4, at limit 15 with 4 machines).
insert into screening_v2.voice_worker_leases (app, machine_id, pipeline, state, claimed_session_id, epoch) values
  ('project-hello-voice', 'r1cnoisephone', 'phone', 'stopped', null, 0),
  ('r1c-other-app', 'r1cnoise1', 'browser', 'stopped', null, 0),
  ('r1c-other-app', 'r1cnoise2', 'browser', 'stopped', null, 0),
  ('r1c-other-app', 'r1cnoise3', 'browser', 'stopped', null, 0),
  ('r1c-other-app', 'r1cnoise4', 'browser', 'busy', 'c1310000-0000-4000-8000-000000009999', 1);

create table _r1c.scenarios (
  tag text primary key,
  scenario_at timestamptz not null,
  n_rounds integer not null
);
create table _r1c.rounds (
  tag text not null references _r1c.scenarios(tag),
  k integer not null,
  round_id uuid not null unique,
  primary key (tag, k)
);

-- Prepare one scenario: end every live R1 session, set the target and the limit (null = the
-- column default, i.e. what an untouched deployment has), make the browser pool exactly p_pool
-- stopped machines, and Send + consent p_rounds rounds of fresh candidates at p_at.
create or replace function _r1c.scenario(
  p_tag text, p_seq integer, p_at timestamptz, p_target text, p_limit integer, p_pool integer, p_rounds integer
) returns void language plpgsql as $$
declare
  res jsonb; v_round uuid; v_cand uuid; k integer;
begin
  update screening_v2.call_sessions set status = 'failed', terminal_reason = 'provider_error'
   where interview_round_id is not null and status in ('created', 'waiting', 'in_progress');
  update screening_v2.r1_settings
     set enabled = true, paused = false, livekit_target = p_target,
         monthly_cap_minutes = 100000, pause_line_minutes = 100000,
         dashboard_minutes = 0, dashboard_read_at = null, dashboard_estimate_baseline = null
   where singleton;
  if p_limit is null then
    update screening_v2.r1_settings set max_concurrent_sessions = default where singleton;
  else
    update screening_v2.r1_settings set max_concurrent_sessions = p_limit where singleton;
  end if;
  delete from screening_v2.voice_worker_leases where app = 'project-hello-voice' and pipeline = 'browser';
  insert into screening_v2.voice_worker_leases (app, machine_id, pipeline, state, claimed_session_id, epoch)
  select 'project-hello-voice', 'r1c' || p_seq || 'm' || i, 'browser', 'stopped', null, 0
    from generate_series(1, p_pool) i;
  insert into _r1c.scenarios (tag, scenario_at, n_rounds) values (p_tag, p_at, p_rounds);
  for k in 1..p_rounds loop
    v_cand := _r1c.u(p_seq * 1000 + k);
    insert into screening_v2.candidates (id, role_id, name)
    values (v_cand, 'c1310000-0000-4000-8000-000000000002', 'r1c ' || p_tag || ' ' || k);
    res := screening_v2.r1_send_round(v_cand, 'c1310000-0000-4000-8000-000000000002',
      'c1310000-0000-4000-8000-000000000001', _r1c.digest(p_tag || '-link-' || k), null,
      p_at + interval '5 days', p_at);
    if res->>'status' is distinct from 'ok' then
      perform _r1c.fail(p_tag || ' fixture Send ' || k, res::text);
    end if;
    v_round := (res->>'id')::uuid;
    insert into screening_v2.interview_round_consents (round_id, template_id, granted_at)
    values (v_round, 'c1310000-0000-4000-8000-000000000003', p_at - interval '1 minute');
    insert into _r1c.rounds (tag, k, round_id) values (p_tag, k, v_round);
  end loop;
  -- The scenario starts from a clean slate: nothing live, the exact pool, every round a hold.
  if exists (select 1 from screening_v2.call_sessions
              where interview_round_id is not null and status in ('created', 'waiting', 'in_progress'))
     or (select count(*) from screening_v2.voice_worker_leases
          where app = 'project-hello-voice' and pipeline = 'browser') <> p_pool
     or (select max_concurrent_sessions from screening_v2.r1_settings where singleton)
          is distinct from coalesce(p_limit, 1) then
    perform _r1c.fail(p_tag || ' scenario preparation', 'live sessions, pool or limit not as requested');
  end if;
end;
$$;

-- After the racers return: prove from the database that exactly p_ok rounds were admitted, once
-- each, and that the budget charged 65 minutes per admitted round and nothing more (0128's
-- price: the Send's 65-minute hold converted to a 65-minute charge, minutes_reserved -> used).
create or replace function _r1c.verify(p_tag text, p_ok integer) returns void language plpgsql as $$
declare
  v_at timestamptz; v_n integer; v_month date; b screening_v2.r1_budget_month%rowtype; snap jsonb;
  v_live integer; v_sessions integer; v_attempts integer; v_admitted integer; v_untouched integer;
  v_multi integer; v_live_rounds integer; v_detail text;
begin
  select scenario_at, n_rounds into v_at, v_n from _r1c.scenarios where tag = p_tag;
  if not found then perform _r1c.fail(p_tag || ' verify', 'unknown scenario'); end if;
  v_month := date_trunc('month', v_at)::date;

  select count(*) into v_live from screening_v2.call_sessions
   where interview_round_id is not null and status in ('created', 'waiting', 'in_progress');
  select count(*), count(distinct s.interview_round_id) into v_sessions, v_live_rounds
    from screening_v2.call_sessions s join _r1c.rounds r on r.round_id = s.interview_round_id
   where r.tag = p_tag;
  select count(*) into v_attempts
    from screening_v2.interview_round_attempts a join _r1c.rounds r on r.round_id = a.round_id
   where r.tag = p_tag;
  select count(*) filter (where i.held_minutes = 0 and i.starts_used = 1 and i.status = 'in_progress'
                                and i.charged_attempt_number = 1 and i.hold_month = v_month),
         count(*) filter (where i.held_minutes = 65 and i.starts_used = 0 and i.status = 'invited'
                                and i.charged_attempt_number = 0)
    into v_admitted, v_untouched
    from screening_v2.interview_rounds i join _r1c.rounds r on r.round_id = i.id
   where r.tag = p_tag;
  select count(*) into v_multi from (
    select s.interview_round_id from screening_v2.call_sessions s join _r1c.rounds r on r.round_id = s.interview_round_id
     where r.tag = p_tag group by 1 having count(*) > 1) d;
  v_detail := format('live=%s sessions=%s rounds_with_session=%s attempts=%s admitted_rounds=%s untouched_rounds=%s of %s',
                     v_live, v_sessions, v_live_rounds, v_attempts, v_admitted, v_untouched, v_n);
  if v_live <> p_ok or v_sessions <> p_ok or v_live_rounds <> p_ok or v_attempts <> p_ok
     or v_admitted <> p_ok or v_untouched <> v_n - p_ok or v_multi <> 0 then
    perform _r1c.fail(p_tag || ': exactly ' || p_ok || ' admitted, each once, every other round untouched', v_detail);
  end if;
  raise notice 'R1 concurrency PASS: % — % admitted once each, % untouched (%)', p_tag, p_ok, v_n - p_ok, v_detail;

  -- The month row: every Send reserved 65; every admission moved exactly its 65 to used.
  select * into b from screening_v2.r1_budget_month where month_start = v_month;
  if not found or b.minutes_used <> 65 * p_ok or b.minutes_reserved <> 65 * (v_n - p_ok)
     or b.starts_admitted <> p_ok then
    perform _r1c.fail(p_tag || ': the month books 65 x admitted as used, 65 x the rest as reserved',
      format('month=%s used=%s reserved=%s starts_admitted=%s expected used=%s reserved=%s starts=%s',
             v_month, b.minutes_used, b.minutes_reserved, b.starts_admitted, 65 * p_ok, 65 * (v_n - p_ok), p_ok));
  end if;
  -- The capacity snapshot the next admission would read agrees: no double charge, no lost hold.
  snap := screening_v2.r1_capacity_snapshot(v_at);
  if (snap->>'minutes_used')::numeric <> 65 * p_ok
     or (snap->>'booked_minutes_used')::numeric <> 65 * p_ok
     or (snap->>'outstanding_holds')::numeric <> 65 * (v_n - p_ok)
     or (snap->>'live_unmetered_sessions')::integer <> p_ok
     or (snap->>'uncounted_charges')::integer <> 0 then
    perform _r1c.fail(p_tag || ': the capacity snapshot carries 65 x admitted used and 65 x the rest held',
      jsonb_build_object('minutes_used', snap->'minutes_used', 'booked_minutes_used', snap->'booked_minutes_used',
                         'outstanding_holds', snap->'outstanding_holds',
                         'live_unmetered_sessions', snap->'live_unmetered_sessions',
                         'uncounted_charges', snap->'uncounted_charges')::text);
  end if;
  raise notice 'R1 concurrency PASS: % — budget used % / reserved % / starts %, snapshot used % / held % (65 per admitted round, none twice)',
    p_tag, b.minutes_used, b.minutes_reserved, b.starts_admitted, snap->>'minutes_used', snap->>'outstanding_holds';
end;
$$;
