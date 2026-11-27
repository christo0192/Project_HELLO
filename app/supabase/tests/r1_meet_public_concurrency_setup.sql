-- Executed by scripts/test-r1-meet-public-concurrency.sh against a FRESH isolated Postgres with every
-- migration applied (0001..latest, and 0143 a second time). Its fixtures are COMMITTED, in that
-- throwaway database only.
--
-- Fixtures and helpers for the REAL two-session race checks of 0143 (M035 S01): the public booking
-- create and move. Their only guard against a double booking is a pair of advisory locks (the
-- candidate's, then the slot's IST day), so only two sessions calling at the same instant prove that
-- the counts and refusals read under those locks hold. The script, not this file, starts the racers
-- behind a blocker that holds the contended lock; this file prepares the candidates and, afterwards,
-- proves from the database what the racers' answers claim: exactly one booking, one round, one live
-- consent and the three r1-meet jobs for the winner, nothing for the loser, and the month reserving
-- 65 minutes per round and nothing more.
--
-- The fixture shapes are r1_meet_public_bookings_assert.sql's (setup, candidate, create): the R1
-- switches open, exactly one sales_r1 role, an enabled Ashby job mapping, our consent notice as the
-- newest active release, candidates with their Ashby application links. Ids live in
-- 7f000000-0000-4000-8000-<kind:4><n:8> (1 auth users, 2 roles, 3 consent templates, 10 candidates,
-- 13 job mappings, 22 Ashby applications, 40 booking ids, 41 public request ids); digests are
-- computed at run time; the one user email is @example.test. The clock is pinned: every call passes
-- p_now = 2026-12-01 04:00 UTC (09:30 IST); nothing reads now().
--
-- Scenarios (each on its own candidates and IST day):
--   C1 candidate 1, two tabs: two request ids and two booking ids (11, 12), one two-seat slot of
--      IST 2026-12-02; the blocker holds the candidate lock.
--   C2 candidate 2, one request id (20) from two tabs with two booking ids (21, 22), IST 2026-12-03;
--      the blocker holds the candidate lock.
--   C3 candidates 3 and 4, one one-seat slot of IST 2026-12-04 (bookings 31, 32); the blocker holds
--      the day lock.
--   C4 candidates 5 and 6, two slots of IST 2026-12-05 under a public day limit of 1 (bookings 41,
--      42); the blocker holds the day lock.
--   C5 candidates 7 and 8, booked HERE on IST 2026-12-09 (bookings 51, 52, manage digests set), both
--      moved into one one-seat slot of IST 2026-12-08; the blocker holds that day's lock, the lower
--      date, so both moves wait on it first.
create schema if not exists _r1mp;

create or replace function _r1mp.id(p_kind integer, p_n integer) returns uuid language sql immutable as $$
  select ('7f000000-0000-4000-8000-' || lpad(p_kind::text, 4, '0') || lpad(p_n::text, 8, '0'))::uuid
$$;

-- A runtime SHA-256 hex digest of a tag (never a literal digest in this file).
create or replace function _r1mp.digest(p_tag text) returns text language sql immutable as $$
  select encode(sha256(convert_to('r1-meet-public-race:' || p_tag, 'UTF8')), 'hex')
$$;

-- The pinned clock of every call.
create or replace function _r1mp.at() returns timestamptz language sql immutable as $$
  select '2026-12-01 04:00:00+00'::timestamptz
$$;

create or replace function _r1mp.fail(p_label text, p_detail text) returns void language plpgsql as $$
begin
  raise exception 'R1 MEET PUBLIC RACE FAIL: % (%)', p_label, p_detail;
end;
$$;

create or replace function _r1mp.pass(p_label text) returns void language plpgsql as $$
begin
  raise notice 'R1 MEET PUBLIC RACE PASS: %', p_label;
end;
$$;

-- The form's consent: every key our notice requires, the India tick, a TEST-NET-3 prefix.
create or replace function _r1mp.form_consent() returns jsonb language sql immutable as $$
  select jsonb_build_object(
    'template_version', 'zz-meet-public-race-current',
    'consents', '["ai_interview", "video_audio_recording", "ai_evaluation", "data_processing"]'::jsonb,
    'in_india', true,
    'ip_prefix', '203.0.113.0/24',
    'user_agent', 'meet public race')
$$;

-- An answer as one word: '<status>:<result, code or field>' ('replayed:' for a replay, 'moved:').
create or replace function _r1mp.outcome(p_res jsonb) returns text language sql immutable as $$
  select coalesce(p_res ->> 'status', 'null') || ':'
         || coalesce(p_res ->> 'result', p_res ->> 'code', p_res ->> 'field', '')
$$;

-- One racer's create: candidate p_n for its own application, booking id(40, p_booking_n), request
-- id(41, p_request_n), the slot [p_start, p_end), p_seats seats, a public day limit of
-- p_public_limit (the bot day limit 20), the pinned now. Volatile, like the RPC: every statement of
-- the RPC reads a fresh snapshot once its advisory lock is granted.
create or replace function _r1mp.create(p_n integer, p_booking_n integer, p_request_n integer,
                                        p_start timestamptz, p_end timestamptz, p_seats integer,
                                        p_public_limit integer)
returns text language plpgsql as $$
declare
  v_res jsonb;
begin
  v_res := screening_v2.r1_meet_create_round_from_public(
    _r1mp.id(40, p_booking_n), _r1mp.id(41, p_request_n), _r1mp.id(10, p_n), _r1mp.id(22, p_n)::text,
    'https://meet.google.com/abc-defg-hij', p_start, p_end, _r1mp.id(1, 1), _r1mp.form_consent(),
    p_seats, p_public_limit, 20, 'r1_dex_sales', 7200, _r1mp.at());
  return _r1mp.outcome(v_res);
end;
$$;

-- One racer's move of booking id(40, p_booking_n) through its manage digest, with the version it
-- reads first (as S06 does from manage_read): p_seats seats, day limits 20/20, three moves, a
-- one-hour cutoff, the default grace, the pinned now.
create or replace function _r1mp.move(p_booking_n integer, p_start timestamptz, p_end timestamptz,
                                      p_seats integer)
returns text language plpgsql as $$
declare
  v_res jsonb;
begin
  v_res := screening_v2.r1_meet_public_move_booking(
    _r1mp.id(40, p_booking_n), _r1mp.digest('manage-' || p_booking_n::text),
    (select x.version from screening_v2.r1_meet_bookings x where x.id = _r1mp.id(40, p_booking_n)),
    p_start, p_end, p_seats, 20, 20, 3, 3600, 7200, _r1mp.at());
  return _r1mp.outcome(v_res);
end;
$$;

-- The booking's r1-meet job rows, as {payload, dedup_key, max_attempts}, ordered by dedup_key.
create or replace function _r1mp.jobs_of(p_booking uuid) returns jsonb language sql stable as $$
  select coalesce(jsonb_agg(jsonb_build_object('payload', x.payload, 'dedup_key', x.dedup_key,
                                               'max_attempts', x.max_attempts)
                            order by x.dedup_key collate "C"), '[]'::jsonb)
    from screening_v2.job_queue x
   where x.name = 'r1-meet' and x.payload ->> 'booking_id' = p_booking::text
$$;

-- One expected job, and a list of them in jobs_of order.
create or replace function _r1mp.job(p_payload jsonb, p_dedup text) returns jsonb language sql immutable as $$
  select jsonb_build_object('payload', p_payload, 'dedup_key', p_dedup, 'max_attempts', 10)
$$;
create or replace function _r1mp.by_key(p_jobs jsonb) returns jsonb language sql immutable as $$
  select coalesce(jsonb_agg(e.item order by e.item ->> 'dedup_key' collate "C"), '[]'::jsonb)
    from jsonb_array_elements(p_jobs) e(item)
$$;

-- The three jobs a public create queues (contracts section 5), exactly.
create or replace function _r1mp.create_jobs(p_booking uuid) returns jsonb language sql immutable as $$
  select _r1mp.by_key(jsonb_build_array(
    _r1mp.job(jsonb_build_object('kind', 'ensure_bot', 'booking_id', p_booking),
              'r1-meet:ensure-bot:' || p_booking::text),
    _r1mp.job(jsonb_build_object('kind', 'calendar_sync', 'op', 'invite', 'booking_id', p_booking),
              'r1-meet:calendar:' || p_booking::text || ':invite'),
    _r1mp.job(jsonb_build_object('kind', 'ashby_booked_tag', 'op', 'add', 'booking_id', p_booking),
              'r1-meet:ashby-tag:' || p_booking::text || ':add')))
$$;

-- Candidate n's bookings, rounds, consents and live consents, as one word for the failure detail.
create or replace function _r1mp.footprint(p_n integer) returns text language sql stable as $$
  select format('candidate %s: bookings=%s rounds=%s consents=%s live_consents=%s', p_n,
    (select count(*) from screening_v2.r1_meet_bookings x where x.candidate_id = _r1mp.id(10, p_n)),
    (select count(*) from screening_v2.interview_rounds x
      where x.candidate_id = _r1mp.id(10, p_n) and x.kind = 'sales_r1'),
    (select count(*) from screening_v2.interview_round_consents c
       join screening_v2.interview_rounds x on x.id = c.round_id
      where x.candidate_id = _r1mp.id(10, p_n)),
    (select count(*) from screening_v2.interview_round_consents c
       join screening_v2.interview_rounds x on x.id = c.round_id
      where x.candidate_id = _r1mp.id(10, p_n) and c.withdrawn_at is null))
$$;

-- What holds after EVERY scenario, over the whole throwaway database: every round has exactly one
-- booking and one consent (no orphan round or consent from a loser, nothing superseded), every live
-- round holds 65 minutes, and the month reserves exactly that (no hold for a loser, none twice).
create or replace function _r1mp.ledger(p_tag text) returns void language plpgsql as $$
declare
  v_rounds integer; v_bookings integer; v_booked_rounds integer; v_consents integer; v_live integer;
  v_held numeric; v_reserved numeric; v_detail text;
begin
  select count(*), coalesce(sum(x.held_minutes) filter (where x.status in ('invited', 'in_progress')), 0)
    into v_rounds, v_held
    from screening_v2.interview_rounds x where x.kind = 'sales_r1';
  select count(*), count(distinct x.round_id) into v_bookings, v_booked_rounds from screening_v2.r1_meet_bookings x;
  select count(*), count(*) filter (where c.withdrawn_at is null) into v_consents, v_live
    from screening_v2.interview_round_consents c;
  select x.minutes_reserved into v_reserved from screening_v2.r1_budget_month x
   where x.month_start = date_trunc('month', _r1mp.at())::date;
  v_detail := format('rounds=%s bookings=%s booked_rounds=%s consents=%s live_consents=%s held=%s reserved=%s',
                     v_rounds, v_bookings, v_booked_rounds, v_consents, v_live, v_held, v_reserved);
  if v_bookings <> v_rounds or v_booked_rounds <> v_rounds or v_consents <> v_rounds or v_live <> v_rounds
     or v_held <> 65 * v_rounds or v_reserved is distinct from v_held then
    perform _r1mp.fail(p_tag || ': one booking and one live consent per round, 65 minutes reserved per round, once', v_detail);
  end if;
  perform _r1mp.pass(p_tag || ': ' || v_detail);
end;
$$;

-- After a create race: booking p_winner_booking (one of p_bookings, made with the request id at the
-- same position of p_requests) is the one public, pending/eligible booking of its candidate, with one
-- invited Meet round holding 65 minutes, one live candidate_web consent and exactly the three create
-- jobs; every other racer's booking id has no row and no job; every other candidate of p_candidates
-- has no booking, round or consent at all.
create or replace function _r1mp.verify_create(p_tag text, p_candidates integer[], p_bookings integer[],
                                               p_requests integer[], p_winner_booking integer)
returns void language plpgsql as $$
declare
  v_at integer := array_position(p_bookings, p_winner_booking);
  b screening_v2.r1_meet_bookings%rowtype;
  v_n integer;
  v_footprint text;
begin
  if v_at is null then
    perform _r1mp.fail(p_tag || ' verify', 'booking ' || p_winner_booking || ' is not one of the racers''');
  end if;
  select * into b from screening_v2.r1_meet_bookings x where x.id = _r1mp.id(40, p_winner_booking);
  if not found then
    perform _r1mp.fail(p_tag || ': the winner''s booking exists', 'booking ' || p_winner_booking || ' is missing');
  end if;
  if b.source is distinct from 'public_page' or b.status is distinct from 'pending'
     or b.reason is distinct from 'eligible' or b.calendar_state is distinct from 'created'
     or b.public_request_id is distinct from _r1mp.id(41, p_requests[v_at])
     or b.version <> 0 or b.key_attempt <> 0 or b.move_count <> 0 or b.round_id is null
     or not exists (select 1 from unnest(p_candidates) c(n) where _r1mp.id(10, c.n) = b.candidate_id) then
    perform _r1mp.fail(p_tag || ': the winner''s booking is a fresh public booking of a racing candidate',
      format('source=%s status=%s/%s calendar=%s version=%s moves=%s round=%s',
             b.source, b.status, b.reason, b.calendar_state, b.version, b.move_count, b.round_id));
  end if;
  foreach v_n in array p_candidates loop
    v_footprint := _r1mp.footprint(v_n);
    if _r1mp.id(10, v_n) = b.candidate_id then
      if v_footprint <> format('candidate %s: bookings=1 rounds=1 consents=1 live_consents=1', v_n)
         or not exists (select 1 from screening_v2.interview_rounds x
                         where x.id = b.round_id and x.candidate_id = b.candidate_id
                           and x.status = 'invited' and x.channel = 'meet' and x.held_minutes = 65
                           and x.expires_at = b.end_at + interval '7200 seconds')
         or not exists (select 1 from screening_v2.interview_round_consents c
                         where c.round_id = b.round_id and c.withdrawn_at is null
                           and c.method = 'candidate_web' and c.granted_at = _r1mp.at()) then
        perform _r1mp.fail(p_tag || ': exactly one booking, one round and one live consent for the winner', v_footprint);
      end if;
    elsif v_footprint <> format('candidate %s: bookings=0 rounds=0 consents=0 live_consents=0', v_n) then
      perform _r1mp.fail(p_tag || ': nothing at all for the losing candidate', v_footprint);
    end if;
  end loop;
  if _r1mp.jobs_of(b.id) is distinct from _r1mp.create_jobs(b.id) then
    perform _r1mp.fail(p_tag || ': exactly the ensure_bot, calendar invite and Ashby tag add jobs for the winner',
      _r1mp.jobs_of(b.id)::text);
  end if;
  foreach v_n in array p_bookings loop
    if v_n <> p_winner_booking
       and (exists (select 1 from screening_v2.r1_meet_bookings x where x.id = _r1mp.id(40, v_n))
            or _r1mp.jobs_of(_r1mp.id(40, v_n)) <> '[]'::jsonb) then
      perform _r1mp.fail(p_tag || ': no booking row and no job for the losing racer''s booking id',
        'booking ' || v_n || ' jobs ' || _r1mp.jobs_of(_r1mp.id(40, v_n))::text);
    end if;
  end loop;
  perform _r1mp.ledger(p_tag);
  perform _r1mp.pass(format('%s: booking %s won; one booking, one round, one live consent and three jobs; nothing for the loser',
                            p_tag, p_winner_booking));
end;
$$;

-- The C5 bookings, booked by the setup below, and the slot each was booked into.
create table if not exists _r1mp.moves (
  booking_n integer primary key,
  candidate_n integer not null,
  start_at timestamptz not null,
  end_at timestamptz not null
);

-- After a move race: booking p_winner_booking now holds [p_start, p_end) (move_count 1, bot
-- generation 1, pending/eligible, its round's expiry moved, the calendar move:1 job beside the
-- create's three; the pending ensure_bot absorbed the move's), p_loser_booking is exactly as booked
-- (slot, generation, round expiry, the create's three jobs only), the target slot holds one live
-- booking, and each candidate still has one booking, one round and one live consent.
create or replace function _r1mp.verify_move(p_tag text, p_winner_booking integer, p_loser_booking integer,
                                             p_start timestamptz, p_end timestamptz)
returns void language plpgsql as $$
declare
  w screening_v2.r1_meet_bookings%rowtype;
  l screening_v2.r1_meet_bookings%rowtype;
  o _r1mp.moves%rowtype;
  v_n integer;
  v_in_slot integer;
begin
  select * into w from screening_v2.r1_meet_bookings x where x.id = _r1mp.id(40, p_winner_booking);
  select * into l from screening_v2.r1_meet_bookings x where x.id = _r1mp.id(40, p_loser_booking);
  select * into o from _r1mp.moves x where x.booking_n = p_loser_booking;
  if w.id is null or l.id is null or o.booking_n is null or w.id = l.id then
    perform _r1mp.fail(p_tag || ' verify', 'unknown bookings ' || p_winner_booking || ' / ' || p_loser_booking);
  end if;
  if w.start_at <> p_start or w.end_at <> p_end or w.move_count <> 1 or w.version <> 1 or w.key_attempt <> 0
     or w.status <> 'pending' or w.reason <> 'eligible'
     or not exists (select 1 from screening_v2.interview_rounds x
                     where x.id = w.round_id and x.expires_at = p_end + interval '7200 seconds') then
    perform _r1mp.fail(p_tag || ': the winner moved once into the target slot',
      format('slot=%s..%s moves=%s version=%s key=%s status=%s/%s', w.start_at, w.end_at, w.move_count,
             w.version, w.key_attempt, w.status, w.reason));
  end if;
  if _r1mp.jobs_of(w.id) is distinct from _r1mp.by_key(_r1mp.create_jobs(w.id) || jsonb_build_array(
       _r1mp.job(jsonb_build_object('kind', 'calendar_sync', 'op', 'move', 'booking_id', w.id),
                 'r1-meet:calendar:' || w.id::text || ':move:1'))) then
    perform _r1mp.fail(p_tag || ': the winner''s jobs are the create''s three and calendar move:1', _r1mp.jobs_of(w.id)::text);
  end if;
  if l.start_at <> o.start_at or l.end_at <> o.end_at or l.move_count <> 0 or l.version <> 0
     or l.key_attempt <> 0 or l.status <> 'pending' or l.reason <> 'eligible'
     or not exists (select 1 from screening_v2.interview_rounds x
                     where x.id = l.round_id and x.expires_at = o.end_at + interval '7200 seconds')
     or _r1mp.jobs_of(l.id) is distinct from _r1mp.create_jobs(l.id) then
    perform _r1mp.fail(p_tag || ': the loser is exactly as booked (slot, generation, round expiry, jobs)',
      format('slot=%s..%s moves=%s version=%s jobs=%s', l.start_at, l.end_at, l.move_count, l.version,
             _r1mp.jobs_of(l.id)));
  end if;
  select count(*) into v_in_slot from screening_v2.r1_meet_bookings x
   where x.status in ('pending', 'blocked', 'bot_scheduled', 'bot_joining', 'human_present', 'in_call')
     and x.start_at < p_end and x.end_at > p_start;
  if v_in_slot <> 1 then
    perform _r1mp.fail(p_tag || ': the one-seat target slot holds exactly one live booking', v_in_slot::text);
  end if;
  for v_n in select x.candidate_n from _r1mp.moves x loop
    if _r1mp.footprint(v_n) <> format('candidate %s: bookings=1 rounds=1 consents=1 live_consents=1', v_n) then
      perform _r1mp.fail(p_tag || ': each moving candidate keeps one booking, one round and one live consent',
        _r1mp.footprint(v_n));
    end if;
  end loop;
  perform _r1mp.ledger(p_tag);
  perform _r1mp.pass(format('%s: booking %s moved, booking %s untouched', p_tag, p_winner_booking, p_loser_booking));
end;
$$;

-- Setup: the R1 switches open, the round creator, EXACTLY one sales_r1 role (ours), one ordinary
-- role for the Ashby job mapping (a mapping may not point at an interview_kind role, 0115), one
-- enabled mapping, and our notice as the newest active release ('zz-' sorts after every shipped,
-- digit-led release).
do $$
begin
  update screening_v2.r1_settings
     set enabled = true, paused = false, livekit_target = 'r1', max_concurrent_sessions = 1,
         monthly_cap_minutes = 100000, pause_line_minutes = 100000, dashboard_minutes = 0
   where singleton;
  if not found then
    perform _r1mp.fail('setup: the r1_settings row', 'missing');
  end if;
  insert into auth.users (id, email)
  values (_r1mp.id(1, 1), 'r1-meet-public-race@example.test')
  on conflict (id) do nothing;
  update screening_v2.roles set interview_kind = null where interview_kind = 'sales_r1';
  insert into screening_v2.roles (id, title, interview_kind)
  values (_r1mp.id(2, 1), 'R1 Meet public race role', 'sales_r1');
  insert into screening_v2.roles (id, title)
  values (_r1mp.id(2, 2), 'R1 Meet public race mapping role');
  insert into screening_v2.ashby_job_mappings
    (id, external_job_id, role_id, owner_id, status, ai_screening_stage_id, ta_screening_stage_id)
  values (_r1mp.id(13, 1), 'meet-public-race-job-1', _r1mp.id(2, 2), _r1mp.id(1, 1), 'enabled',
          'meet-public-race-ai', 'meet-public-race-ta');
  insert into screening_v2.interview_round_consent_templates
    (id, version, locale, title, body_md, required_consents, is_active)
  values (_r1mp.id(3, 1), 'zz-meet-public-race-current', 'en-IN', 'R1 Meet public race notice', 'fixture',
          '["ai_interview", "video_audio_recording", "ai_evaluation", "data_processing"]'::jsonb, true);
  if (select count(*) from screening_v2.roles x where x.interview_kind = 'sales_r1') <> 1
     or not exists (select 1 from screening_v2.roles x
                     where x.id = _r1mp.id(2, 1) and x.interview_kind = 'sales_r1') then
    perform _r1mp.fail('setup: exactly one sales_r1 role, ours', 'another sales_r1 role exists');
  end if;
  if (select max(x.version) from screening_v2.interview_round_consent_templates x where x.is_active)
     is distinct from 'zz-meet-public-race-current' then
    perform _r1mp.fail('setup: our en-IN notice is the newest active release', 'a newer release exists');
  end if;
  perform _r1mp.pass('setup: R1 open, one sales_r1 role, one enabled mapping, our notice the newest');
end;
$$;

-- Candidates 1..8 with their Ashby application links (external_application_id = id(22, n)) on the
-- enabled mapping; each is eligible before any race.
do $$
declare
  n integer;
  v_res jsonb;
begin
  for n in 1..8 loop
    insert into screening_v2.candidates (id, role_id, name)
    values (_r1mp.id(10, n), _r1mp.id(2, 1), 'meet public race ' || n::text);
    insert into screening_v2.ashby_application_links
      (provider, external_application_id, candidate_id, job_mapping_id)
    values ('ashby', _r1mp.id(22, n)::text, _r1mp.id(10, n), _r1mp.id(13, 1));
  end loop;
  for n in 1..8 loop
    v_res := screening_v2.r1_meet_public_precheck(_r1mp.id(10, n), _r1mp.id(22, n)::text, _r1mp.at());
    if v_res is distinct from '{"status": "eligible"}'::jsonb then
      perform _r1mp.fail('setup: candidate ' || n || ' is eligible before the races', v_res::text);
    end if;
  end loop;
  perform _r1mp.pass('setup: candidates 1..8 linked to the enabled mapping and eligible');
end;
$$;

-- C5's bookings, made one at a time (so the create itself is proven before any race), then their
-- manage digests. verify_create checks each, and must refuse a wrong winner (it is not vacuous).
insert into _r1mp.moves (booking_n, candidate_n, start_at, end_at) values
  (51, 7, '2026-12-09 05:00:00+00', '2026-12-09 05:45:00+00'),
  (52, 8, '2026-12-09 07:00:00+00', '2026-12-09 07:45:00+00');

do $$
declare
  m _r1mp.moves%rowtype;
  v_answer text;
  v_res jsonb;
begin
  for m in select * from _r1mp.moves x order by x.booking_n loop
    v_answer := _r1mp.create(m.candidate_n, m.booking_n, m.booking_n, m.start_at, m.end_at, 2, 20);
    if v_answer is distinct from 'booked:created' then
      perform _r1mp.fail('setup: C5 booking ' || m.booking_n || ' is created', v_answer);
    end if;
    v_res := screening_v2.r1_meet_public_set_manage_digest(_r1mp.id(40, m.booking_n),
                                                           _r1mp.digest('manage-' || m.booking_n::text), _r1mp.at());
    if v_res is distinct from '{"status": "ok"}'::jsonb then
      perform _r1mp.fail('setup: C5 booking ' || m.booking_n || ' gets its manage digest', v_res::text);
    end if;
    perform _r1mp.verify_create('setup C5 booking ' || m.booking_n, array[m.candidate_n],
                                array[m.booking_n], array[m.booking_n], m.booking_n);
  end loop;
  -- verify_create is not vacuous: read as one race, 7 and 8 both booked, so "nothing for the loser"
  -- must fail; and a winner that never booked must fail.
  begin
    perform _r1mp.verify_create('self-test', array[7, 8], array[51, 52], array[51, 52], 51);
    raise exception 'r1mp verify self-test sentinel';
  exception when others then
    if sqlerrm not like 'R1 MEET PUBLIC RACE FAIL: self-test: nothing at all for the losing candidate%' then
      raise;
    end if;
  end;
  begin
    perform _r1mp.verify_create('self-test', array[7], array[51, 59], array[51, 59], 59);
    raise exception 'r1mp verify self-test sentinel';
  exception when others then
    if sqlerrm not like 'R1 MEET PUBLIC RACE FAIL: self-test: the winner''s booking exists%' then
      raise;
    end if;
  end;
  perform _r1mp.pass('setup: verify_create refuses a loser with a booking and a winner without one');
end;
$$;
