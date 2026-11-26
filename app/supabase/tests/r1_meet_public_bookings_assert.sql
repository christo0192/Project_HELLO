-- 0143 (M035 S01): public R1 Meet bookings (one public booking link), run for real.
--
-- Executed by scripts/test-r1-meet-public.sh inside scripts/supabase-test.sh's local Supabase
-- stack, right after the 0142 suite, against the complete schema (every migration applied; never
-- stubs). Everything runs in ONE transaction that is rolled back at the end, so the fixtures
-- (including the consent template), the settings change and every job row it writes never outlive
-- the run. Any failed assertion raises and stops psql (ON_ERROR_STOP=1).
--
-- Sections:
--   T1-A catalog posture: the seven new booking columns, the three nullable Ashby ids (the
--        application id stays NOT NULL), the two partial unique indexes, the throttle table (RLS
--        on with no policy, its key, its index, closed to anon / authenticated / PUBLIC by catalog
--        and by trying, service_role limited to select/insert/update/delete), the two trigger
--        functions' security mode, search_path and EXECUTE, and the two triggers.
--   T1-B source and the Ashby ids, both ways.
--   T1-C every 0143 table CHECK re-validates over a booking of every status family (both
--        sources), and is itself validated.
--   T1-D the calendar event id pin.
--   T1-E the public columns: tied to the source, the invite time, the calendar states, the digest,
--        move_count, and the two unique keys.
--   T1-F the 34 reasons and the status/reason pairing (every 0142 pair still accepted).
--   T1-G the terminal trigger (calendar cancel + tag removal, exact payloads and keys) and the
--        purge trigger (incl. the DSAR cascade beside 0142's bot release, and its dedup).
--   T1-H the throttle table's CHECKs and key.
--   T2-A the slot and IST-day counts (§10, §11) and r1_meet_public_capacity (§13): overlap only,
--        live only, both sources, the IST midnight boundary, zero days, the 15-day window, the
--        0131 effective concurrency, admits, the settings mirror and a missing settings row.
--   T2-B r1_meet_public_precheck over r1_meet_public_refusal (§12, §14): every refusal code in
--        order, precedence pairs, the expirable and reusable rounds that stay eligible, the field
--        refusals, and no write.
--   T2-C r1_meet_public_set_manage_digest (§16).
--   T2-D r1_meet_public_manage_read (§17).
--   T2-E r1_meet_public_set_calendar_state (§21).
--   T2-F r1_meet_public_throttle_hit (§22).
--   T2-G r1_meet_public_throttle_prune (§23).
--   T2-H catalog posture of the T2 functions (definer RPCs, invoker helpers, volatility,
--        search_path, EXECUTE).
--   T3-A r1_meet_create_round_from_public (§15), the happy path: the round, the candidate_web
--        consent, the booking, the three jobs, the exact answer, and admission accepting the round.
--   T3-B replay by request id (same candidate, another candidate or application) and the taken
--        booking id.
--   T3-C slot and IST-day capacity under the day lock, at the limits.
--   T3-D every precheck refusal reached through the create, nothing written.
--   T3-E created_by_unknown, in_past, slot_too_far, consent_stale, consent_incomplete, every
--        consent shape failure and every other field, nothing written.
--   T3-F re-link: after an Ashby cancel, after a failed public booking, after HR's grant-retake,
--        the consent checks of a re-link, and the round audience without a notice.
--   T3-G the step-8a expiry of a lapsed Meet round, and a lapsed round that still has a booking.
--   T3-H the settings refusals through the create, the re-link under a full cap, and the catalog
--        posture of the create.
--   T4-A r1_meet_public_move_booking (§18): a move to another day and within a day (the jobs and
--        their keys), capacity without the booking itself, every refusal in the plan order with a
--        precedence pair for each adjacent pair that can co-occur, the S06 bot path (set_bot
--        replace, then move), version_exhausted as moves_exhausted, round_not_live, every field,
--        no write on any refusal, and the catalog posture.
--   T4-B r1_meet_public_cancel_booking (§19): from pending and from bot_scheduled (ticket, bot,
--        invite, withdrawal), the hold refund, the jobs (no round_cancelled), already_cancelled,
--        not_found, cutoff_passed, booking_dispatched, an expired round, the one retry, the fail
--        closed raise, a round-less booking, re-booking after a cancel, every field, the catalog.
--   T4-C r1_meet_public_reconsent (§20): the same notice, a newer release, after a withdrawal,
--        consent_stale, consent_incomplete, booking_dispatched, not_found, every field, the
--        catalog.
--
-- The clock is pinned: every time is written explicitly (p_now = 2026-12-01 04:00 UTC, 09:30 IST;
-- the default slot is 2026-12-02 05:00-05:45 UTC, 10:30-11:15 IST); nothing asserts on now().
-- Fixture ids live in 7f000000-0000-4000-8000-<kind:4><n:8> (the 0142 namespace; the suites run in
-- separate rolled-back transactions); digests are computed at run time; candidate names are
-- "meet public assert <n>", the one user email is @example.test. No real data. Table aliases are
-- always `x`: no variable is named x.

begin;

create schema _r1_meet_public_tests;
create table _r1_meet_public_tests.passed (label text primary key);

create function _r1_meet_public_tests.assert(p_label text, p_ok boolean, p_detail text default '')
returns void language plpgsql as $$
begin
  -- `is not true`, not `not`: a NULL condition must fail, never pass silently.
  if p_ok is not true then
    raise exception 'R1 MEET PUBLIC FAIL: % (%)', p_label, p_detail;
  end if;
  insert into _r1_meet_public_tests.passed (label) values (p_label) on conflict do nothing;
  raise notice 'R1 MEET PUBLIC PASS: %', p_label;
end;
$$;

-- Runs a statement that MUST raise the given SQLSTATE; any other outcome fails the assertion.
create function _r1_meet_public_tests.raises(p_label text, p_sql text, p_sqlstate text)
returns void language plpgsql as $$
declare
  v_state text;
begin
  begin
    execute p_sql;
  exception when others then
    get stacked diagnostics v_state = returned_sqlstate;
    perform _r1_meet_public_tests.assert(p_label || ' (rejected with ' || p_sqlstate || ')',
      v_state = p_sqlstate, 'got ' || v_state);
    return;
  end;
  raise exception 'R1 MEET PUBLIC FAIL: % (statement was accepted)', p_label;
end;
$$;

-- Runs a statement AS p_role that MUST raise the given SQLSTATE. The role switch is local to the
-- inner block: its subtransaction is always rolled back (an accepted statement raises a sentinel
-- to force that), which restores the role and undoes any write before the verdict. A switch that
-- did not happen fails loudly instead of passing on the switch's own 42501.
create function _r1_meet_public_tests.raises_as(p_role text, p_label text, p_sql text, p_sqlstate text)
returns void language plpgsql as $$
declare
  v_state text;
  v_before text := current_user;
  v_switched boolean := false;
  v_accepted boolean := false;
begin
  begin
    perform set_config('role', p_role, true);
    v_switched := current_user = p_role;
    execute p_sql;
    v_accepted := true;
    raise exception 'r1 meet public raises_as sentinel' using errcode = 'P0001';
  exception when others then
    get stacked diagnostics v_state = returned_sqlstate;
  end;
  if not v_switched then
    raise exception 'R1 MEET PUBLIC FAIL: % (could not switch to role %: %)', p_label, p_role, v_state;
  end if;
  if v_accepted then
    raise exception 'R1 MEET PUBLIC FAIL: % as % (statement was accepted)', p_label, p_role;
  end if;
  perform _r1_meet_public_tests.assert(p_label || ' as ' || p_role || ' (rejected with ' || p_sqlstate || ')',
    v_state = p_sqlstate and current_user = v_before,
    'got ' || coalesce(v_state, 'null') || ' as ' || current_user);
end;
$$;

-- Fixture ids: 7f000000-0000-4000-8000-<kind:4><n:8>.
--   1 auth users, 2 roles, 3 consent templates, 10 candidates, 11 rounds, 12 call sessions,
--   13 job mappings, 14 DSAR requests, 15 phone engagements, 20 Ashby interview events,
--   21 Ashby schedules, 22 Ashby applications, 23 Ashby stages, 24 Ashby interviews,
--   25 Ashby schedulers, 30 Recall bots, 40 public booking ids, 41 public request ids.
create function _r1_meet_public_tests.id(p_kind integer, p_n integer) returns uuid
language sql immutable as $$
  select ('7f000000-0000-4000-8000-' || lpad(p_kind::text, 4, '0') || lpad(p_n::text, 8, '0'))::uuid
$$;

-- A runtime SHA-256 hex digest of a tag (never a literal digest in this file).
create function _r1_meet_public_tests.digest(p_tag text) returns text
language sql immutable as $$
  select encode(sha256(convert_to('r1-meet-public-assert:' || p_tag, 'UTF8')), 'hex')
$$;

-- Setup: the R1 switches open (later sections create rounds through the RPCs), one auth user as the
-- round creator, EXACTLY one sales_r1 role (ours; earlier suites leave sales_r1 roles of their own
-- and the round RPCs require exactly one, so every other role loses the kind inside this
-- transaction only), one ordinary role for the Ashby job mappings (a mapping may not point at an
-- interview_kind role, 0115), three mappings (enabled, paused, archived), and our consent notice
-- as the newest active release ('zz-' sorts after every digit-led release; earlier suites leave
-- active test releases behind).
do $$
begin
  update screening_v2.r1_settings
     set enabled = true, paused = false, livekit_target = 'r1', max_concurrent_sessions = 1,
         monthly_cap_minutes = 100000, pause_line_minutes = 100000, dashboard_minutes = 0
   where singleton;
  insert into auth.users (id, email)
  values (_r1_meet_public_tests.id(1, 1), 'r1-meet-public-assert-1@example.test')
  on conflict (id) do nothing;
  update screening_v2.roles set interview_kind = null where interview_kind = 'sales_r1';
  insert into screening_v2.roles (id, title, interview_kind)
  values (_r1_meet_public_tests.id(2, 1), 'R1 Meet public assertion role', 'sales_r1');
  insert into screening_v2.roles (id, title)
  values (_r1_meet_public_tests.id(2, 2), 'R1 Meet public assertion mapping role');
  insert into screening_v2.ashby_job_mappings
    (id, external_job_id, role_id, owner_id, status, ai_screening_stage_id, ta_screening_stage_id)
  values (_r1_meet_public_tests.id(13, 1), 'meet-public-assert-job-1', _r1_meet_public_tests.id(2, 2),
          _r1_meet_public_tests.id(1, 1), 'enabled', 'meet-public-assert-ai', 'meet-public-assert-ta');
  insert into screening_v2.ashby_job_mappings (id, external_job_id, role_id, owner_id, status)
  values (_r1_meet_public_tests.id(13, 2), 'meet-public-assert-job-2', _r1_meet_public_tests.id(2, 2),
          _r1_meet_public_tests.id(1, 1), 'paused');
  insert into screening_v2.ashby_job_mappings (id, external_job_id, role_id, owner_id, status, archived_at)
  values (_r1_meet_public_tests.id(13, 3), 'meet-public-assert-job-3', _r1_meet_public_tests.id(2, 2),
          _r1_meet_public_tests.id(1, 1), 'paused', '2026-11-01 00:00:00+00');
  insert into screening_v2.interview_round_consent_templates
    (id, version, locale, title, body_md, required_consents, is_active)
  values (_r1_meet_public_tests.id(3, 1), 'zz-meet-public-assert-current', 'en-IN',
          'R1 Meet public assertion current notice', 'fixture',
          '["ai_interview", "video_audio_recording", "ai_evaluation", "data_processing"]'::jsonb, true);
  perform _r1_meet_public_tests.assert('setup: exactly one sales_r1 role, ours',
    (select count(*) = 1 and bool_and(x.id = _r1_meet_public_tests.id(2, 1))
       from screening_v2.roles x where x.interview_kind = 'sales_r1'));
  perform _r1_meet_public_tests.assert('setup: our en-IN release is the newest active release',
    (select max(x.version) = 'zz-meet-public-assert-current'
       from screening_v2.interview_round_consent_templates x where x.is_active));
end;
$$;

-- A candidate of the assertion role, optionally with its Ashby application link
-- (external_application_id = Ashby application id(22, n)) on mapping 'enabled' id(13, 1),
-- 'paused' id(13, 2) or 'archived' id(13, 3); NULL leaves the link without a mapping.
create function _r1_meet_public_tests.candidate(p_n integer, p_link boolean default true,
                                                p_mapping text default 'enabled')
returns uuid language plpgsql as $$
begin
  insert into screening_v2.candidates (id, role_id, name)
  values (_r1_meet_public_tests.id(10, p_n), _r1_meet_public_tests.id(2, 1),
          'meet public assert ' || p_n::text);
  if p_link then
    insert into screening_v2.ashby_application_links
      (provider, external_application_id, candidate_id, job_mapping_id)
    values ('ashby', _r1_meet_public_tests.id(22, p_n)::text, _r1_meet_public_tests.id(10, p_n),
            case p_mapping
              when 'enabled' then _r1_meet_public_tests.id(13, 1)
              when 'paused' then _r1_meet_public_tests.id(13, 2)
              when 'archived' then _r1_meet_public_tests.id(13, 3)
            end);
  end if;
  return _r1_meet_public_tests.id(10, p_n);
end;
$$;

-- A round of candidate n inserted directly (T1 schema checks; later sections create rounds through
-- the RPCs). Channel meet by default; the expiry defaults to the default slot end + 7200 s.
create function _r1_meet_public_tests.round(p_n integer, p_status text default 'invited',
                                            p_channel text default 'meet',
                                            p_expires_at timestamptz default '2026-12-02 07:45:00+00')
returns uuid language plpgsql as $$
begin
  insert into screening_v2.interview_rounds
    (id, candidate_id, role_id, link_token_digest, expires_at, created_by, status, channel)
  values (_r1_meet_public_tests.id(11, p_n), _r1_meet_public_tests.id(10, p_n),
          _r1_meet_public_tests.id(2, 1), _r1_meet_public_tests.digest('link-' || p_n::text),
          p_expires_at, _r1_meet_public_tests.id(1, 1), p_status, p_channel);
  return _r1_meet_public_tests.id(11, p_n);
end;
$$;

-- A complete, valid PUBLIC booking row n: booking id(40, n), request id(41, n), the event id derived
-- from the booking id, calendar 'created', pending/eligible on candidate n and round n (create them
-- first, or override candidate_id / round_id), no Ashby event, schedule or scheduler.
create function _r1_meet_public_tests.public_row(p_n integer) returns jsonb
language sql as $$
  select jsonb_build_object(
    'id', _r1_meet_public_tests.id(40, p_n),
    'source', 'public_page',
    'ashby_interview_event_id', null,
    'ashby_schedule_id', null,
    'ashby_application_id', _r1_meet_public_tests.id(22, p_n)::text,
    'ashby_interview_stage_id', null,
    'ashby_interview_id', null,
    'ashby_scheduled_by_user_id', null,
    'ashby_updated_at', null,
    'candidate_id', _r1_meet_public_tests.id(10, p_n),
    'round_id', _r1_meet_public_tests.id(11, p_n),
    'objective_profile', 'r1_dex_sales',
    'status', 'pending',
    'reason', 'eligible',
    'version', 0,
    'key_attempt', 0,
    'meet_url', 'https://meet.google.com/abc-defg-hij',
    'start_at', '2026-12-02T05:00:00+00:00',
    'end_at', '2026-12-02T05:45:00+00:00',
    'recall_bot_id', null,
    'ticket_digest', null,
    'ticket_not_before', null,
    'ticket_expires_at', null,
    'ticket_claimed_at', null,
    'ticket_arms', 0,
    'session_id', null,
    'google_calendar_event_id', replace(_r1_meet_public_tests.id(40, p_n)::text, '-', ''),
    'calendar_state', 'created',
    'invite_sent_at', null,
    'public_request_id', _r1_meet_public_tests.id(41, p_n),
    'manage_token_digest', null,
    'move_count', 0,
    'created_at', '2026-12-01T04:00:00+00:00',
    'updated_at', '2026-12-01T04:00:00+00:00')
$$;

-- The bindings of a terminal booking that needs no candidate, round or bot (pairs with public_row).
create function _r1_meet_public_tests.unbound() returns jsonb
language sql immutable as $$
  select '{"status": "cancelled", "reason": "candidate_cancelled", "candidate_id": null, "round_id": null}'::jsonb
$$;

-- A complete, valid 0142-shaped ASHBY booking row for Ashby event id(20, n): unmatched, no
-- candidate, no round, no bot. It carries none of the 0143 columns.
create function _r1_meet_public_tests.ashby_row(p_n integer) returns jsonb
language sql as $$
  select jsonb_build_object(
    'id', gen_random_uuid(),
    'ashby_interview_event_id', _r1_meet_public_tests.id(20, p_n),
    'ashby_schedule_id', _r1_meet_public_tests.id(21, p_n)::text,
    'ashby_application_id', _r1_meet_public_tests.id(22, p_n)::text,
    'ashby_interview_stage_id', _r1_meet_public_tests.id(23, p_n)::text,
    'ashby_interview_id', _r1_meet_public_tests.id(24, p_n)::text,
    'ashby_scheduled_by_user_id', _r1_meet_public_tests.id(25, 1)::text,
    'ashby_updated_at', '2026-11-30T09:00:00+00:00',
    'candidate_id', null,
    'round_id', null,
    'objective_profile', 'r1_dex_sales',
    'status', 'unmatched_application',
    'reason', 'application_unknown',
    'version', 0,
    'key_attempt', 0,
    'meet_url', 'https://meet.google.com/abc-defg-hij',
    'start_at', '2026-12-02T05:00:00+00:00',
    'end_at', '2026-12-02T05:45:00+00:00',
    'recall_bot_id', null,
    'ticket_digest', null,
    'ticket_not_before', null,
    'ticket_expires_at', null,
    'ticket_claimed_at', null,
    'ticket_arms', 0,
    'session_id', null,
    'created_at', '2026-12-01T04:00:00+00:00',
    'updated_at', '2026-12-01T04:00:00+00:00')
$$;

-- Inserts EVERY column of p_row (a key it lacks is NULL, never the column default); returns the id.
create function _r1_meet_public_tests.insert_full(p_row jsonb)
returns uuid language plpgsql as $$
declare
  v_id uuid;
begin
  insert into screening_v2.r1_meet_bookings
  select * from jsonb_populate_record(null::screening_v2.r1_meet_bookings, p_row)
  returning id into v_id;
  return v_id;
end;
$$;

-- Inserts public_row(n) with the given columns overridden (a JSON null is SQL NULL).
create function _r1_meet_public_tests.public_booking(p_n integer, p_args jsonb default '{}'::jsonb)
returns uuid language sql as $$
  select _r1_meet_public_tests.insert_full(_r1_meet_public_tests.public_row(p_n) || p_args)
$$;

-- Inserts an Ashby booking the way the 0142 code does: ONLY the 0142 columns are named, so source
-- and the public columns take their defaults. p_args overrides 0142 columns only.
create function _r1_meet_public_tests.ashby_booking(p_n integer, p_args jsonb default '{}'::jsonb)
returns uuid language plpgsql as $$
declare
  v_id uuid;
begin
  insert into screening_v2.r1_meet_bookings
    (id, ashby_interview_event_id, ashby_schedule_id, ashby_application_id,
     ashby_interview_stage_id, ashby_interview_id, ashby_scheduled_by_user_id, ashby_updated_at,
     candidate_id, round_id, objective_profile, status, reason, version, key_attempt, meet_url,
     start_at, end_at, recall_bot_id, ticket_digest, ticket_not_before, ticket_expires_at,
     ticket_claimed_at, ticket_arms, session_id, created_at, updated_at)
  select x.id, x.ashby_interview_event_id, x.ashby_schedule_id, x.ashby_application_id,
         x.ashby_interview_stage_id, x.ashby_interview_id, x.ashby_scheduled_by_user_id,
         x.ashby_updated_at, x.candidate_id, x.round_id, x.objective_profile, x.status, x.reason,
         x.version, x.key_attempt, x.meet_url, x.start_at, x.end_at, x.recall_bot_id,
         x.ticket_digest, x.ticket_not_before, x.ticket_expires_at, x.ticket_claimed_at,
         x.ticket_arms, x.session_id, x.created_at, x.updated_at
    from jsonb_populate_record(null::screening_v2.r1_meet_bookings,
                               _r1_meet_public_tests.ashby_row(p_n) || p_args) x
  returning id into v_id;
  return v_id;
end;
$$;

-- An Ashby row with every column named, the Ashby values of the 0143 columns spelled out: the
-- base for "an Ashby row with a public column set" (insert_full ignores no key).
create function _r1_meet_public_tests.ashby_full(p_n integer) returns jsonb
language sql as $$
  select _r1_meet_public_tests.ashby_row(p_n) || '{"source": "ashby", "move_count": 0}'::jsonb
$$;

create function _r1_meet_public_tests.rejected(p_label text, p_row jsonb, p_sqlstate text default '23514')
returns void language plpgsql as $$
begin
  perform _r1_meet_public_tests.raises(p_label,
    format('select _r1_meet_public_tests.insert_full(%L::jsonb)', p_row::text), p_sqlstate);
end;
$$;

-- The booking's r1-meet job rows, as {payload, dedup_key, max_attempts}, ordered by dedup_key.
create function _r1_meet_public_tests.jobs_of(p_booking uuid) returns jsonb
language sql stable as $$
  select coalesce(jsonb_agg(jsonb_build_object('payload', x.payload, 'dedup_key', x.dedup_key,
                                               'max_attempts', x.max_attempts)
                            order by x.dedup_key collate "C"), '[]'::jsonb)
    from screening_v2.job_queue x
   where x.name = 'r1-meet' and x.payload ->> 'booking_id' = p_booking::text
$$;

-- One expected job of jobs_of.
create function _r1_meet_public_tests.job(p_payload jsonb, p_dedup text) returns jsonb
language sql immutable as $$
  select jsonb_build_object('payload', p_payload, 'dedup_key', p_dedup, 'max_attempts', 10)
$$;

-- The two jobs the terminal trigger queues, in jobs_of order (ashby-tag sorts before calendar).
create function _r1_meet_public_tests.terminal_jobs(p_booking uuid, p_with_calendar boolean)
returns jsonb language sql immutable as $$
  select jsonb_build_array(_r1_meet_public_tests.job(
           jsonb_build_object('kind', 'ashby_booked_tag', 'op', 'remove', 'booking_id', p_booking),
           'r1-meet:ashby-tag:' || p_booking::text || ':remove'))
         || case when p_with_calendar then jsonb_build_array(_r1_meet_public_tests.job(
           jsonb_build_object('kind', 'calendar_sync', 'op', 'cancel', 'booking_id', p_booking),
           'r1-meet:calendar:' || p_booking::text || ':cancel'))
         else '[]'::jsonb end
$$;

-- The one job the purge trigger queues.
create function _r1_meet_public_tests.purge_job(p_booking uuid) returns jsonb
language sql immutable as $$
  select _r1_meet_public_tests.job(
           jsonb_build_object('kind', 'calendar_sync', 'op', 'purge', 'booking_id', p_booking),
           'r1-meet:calendar:' || p_booking::text || ':purge')
$$;

-- =============================================================================================
-- T1-A. Catalog posture.
-- =============================================================================================
do $$
declare
  fn text;
  who text;
  v text;
  v_throttle constant text := 'screening_v2.r1_meet_public_throttle';
begin
  select string_agg(x.column_name || ':' || x.data_type || ':' || x.is_nullable || ':'
                    || coalesce(x.column_default, '-'), ',' order by x.ordinal_position)
    into v
    from information_schema.columns x
   where x.table_schema = 'screening_v2' and x.table_name = 'r1_meet_bookings'
     and x.column_name in ('source', 'google_calendar_event_id', 'calendar_state', 'invite_sent_at',
                           'public_request_id', 'manage_token_digest', 'move_count');
  perform _r1_meet_public_tests.assert('T1-A the seven new booking columns: type, nullability, default, order',
    v = 'source:text:NO:''ashby''::text,google_calendar_event_id:text:YES:-,calendar_state:text:YES:-,'
        || 'invite_sent_at:timestamp with time zone:YES:-,public_request_id:uuid:YES:-,'
        || 'manage_token_digest:text:YES:-,move_count:smallint:NO:0', v);
  perform _r1_meet_public_tests.assert('T1-A the three Ashby event, schedule and scheduler ids are nullable',
    (select count(*) = 3 from information_schema.columns x
      where x.table_schema = 'screening_v2' and x.table_name = 'r1_meet_bookings'
        and x.column_name in ('ashby_interview_event_id', 'ashby_schedule_id', 'ashby_scheduled_by_user_id')
        and x.is_nullable = 'YES'));
  perform _r1_meet_public_tests.assert('T1-A ashby_application_id stays NOT NULL',
    (select x.is_nullable = 'NO' from information_schema.columns x
      where x.table_schema = 'screening_v2' and x.table_name = 'r1_meet_bookings'
        and x.column_name = 'ashby_application_id'));
  perform _r1_meet_public_tests.assert('T1-A uq_r1_meet_bookings_public_request is unique and partial',
    (select x.indexdef = 'CREATE UNIQUE INDEX uq_r1_meet_bookings_public_request ON screening_v2.r1_meet_bookings USING btree (public_request_id) WHERE (public_request_id IS NOT NULL)'
       from pg_indexes x where x.schemaname = 'screening_v2' and x.indexname = 'uq_r1_meet_bookings_public_request'));
  perform _r1_meet_public_tests.assert('T1-A uq_r1_meet_bookings_manage_digest is unique and partial',
    (select x.indexdef = 'CREATE UNIQUE INDEX uq_r1_meet_bookings_manage_digest ON screening_v2.r1_meet_bookings USING btree (manage_token_digest) WHERE (manage_token_digest IS NOT NULL)'
       from pg_indexes x where x.schemaname = 'screening_v2' and x.indexname = 'uq_r1_meet_bookings_manage_digest'));
  perform _r1_meet_public_tests.assert('T1-A r1_meet_bookings keeps RLS on with no policy',
    (select x.relrowsecurity from pg_class x where x.oid = 'screening_v2.r1_meet_bookings'::regclass)
    and not exists (select 1 from pg_policies x where x.schemaname = 'screening_v2'
                                                  and x.tablename = 'r1_meet_bookings'));

  -- The throttle table.
  perform _r1_meet_public_tests.assert('T1-A r1_meet_public_throttle columns: type, nullability, default, order',
    (select string_agg(x.column_name || ':' || x.data_type || ':' || x.is_nullable || ':'
                       || coalesce(x.column_default, '-'), ',' order by x.ordinal_position)
       from information_schema.columns x
      where x.table_schema = 'screening_v2' and x.table_name = 'r1_meet_public_throttle')
    = 'key_digest:text:NO:-,bucket_start:timestamp with time zone:NO:-,hits:integer:NO:0');
  perform _r1_meet_public_tests.assert('T1-A r1_meet_public_throttle has RLS enabled and no policy',
    (select x.relrowsecurity from pg_class x where x.oid = 'screening_v2.r1_meet_public_throttle'::regclass)
    and not exists (select 1 from pg_policies x where x.schemaname = 'screening_v2'
                                                  and x.tablename = 'r1_meet_public_throttle'));
  perform _r1_meet_public_tests.assert('T1-A r1_meet_public_throttle is keyed by (key_digest, bucket_start)',
    (select pg_get_constraintdef(x.oid) = 'PRIMARY KEY (key_digest, bucket_start)'
       from pg_constraint x
      where x.conrelid = 'screening_v2.r1_meet_public_throttle'::regclass and x.contype = 'p'
        and x.conname = 'pk_r1_meet_public_throttle'));
  perform _r1_meet_public_tests.assert('T1-A idx_r1_meet_public_throttle_bucket indexes bucket_start',
    (select x.indexdef = 'CREATE INDEX idx_r1_meet_public_throttle_bucket ON screening_v2.r1_meet_public_throttle USING btree (bucket_start)'
       from pg_indexes x where x.schemaname = 'screening_v2' and x.indexname = 'idx_r1_meet_public_throttle_bucket'));
  foreach who in array array['anon', 'authenticated'] loop
    perform _r1_meet_public_tests.assert('T1-A r1_meet_public_throttle grants nothing to ' || who,
      not has_table_privilege(who, v_throttle, 'select,insert,update,delete,truncate,references,trigger'));
  end loop;
  perform _r1_meet_public_tests.assert('T1-A r1_meet_public_throttle grants nothing to PUBLIC',
    not exists (
      select 1 from information_schema.role_table_grants x
       where x.table_schema = 'screening_v2' and x.table_name = 'r1_meet_public_throttle'
         and x.grantee = 'PUBLIC'));
  perform _r1_meet_public_tests.assert('T1-A service_role can select, insert, update and delete the throttle',
    has_table_privilege('service_role', v_throttle, 'select')
    and has_table_privilege('service_role', v_throttle, 'insert')
    and has_table_privilege('service_role', v_throttle, 'update')
    and has_table_privilege('service_role', v_throttle, 'delete'));
  perform _r1_meet_public_tests.assert('T1-A service_role has no truncate, references or trigger on the throttle',
    not has_table_privilege('service_role', v_throttle, 'truncate,references,trigger'));
  -- Behavioural: the browser roles are refused by the database itself.
  foreach who in array array['anon', 'authenticated'] loop
    perform _r1_meet_public_tests.raises_as(who, 'T1-A select from r1_meet_public_throttle',
      'select count(*) from screening_v2.r1_meet_public_throttle', '42501');
    perform _r1_meet_public_tests.raises_as(who, 'T1-A insert into r1_meet_public_throttle',
      'insert into screening_v2.r1_meet_public_throttle default values', '42501');
    perform _r1_meet_public_tests.raises_as(who, 'T1-A update r1_meet_public_throttle',
      'update screening_v2.r1_meet_public_throttle set hits = hits', '42501');
    perform _r1_meet_public_tests.raises_as(who, 'T1-A delete from r1_meet_public_throttle',
      'delete from screening_v2.r1_meet_public_throttle', '42501');
  end loop;

  -- The two trigger functions and their triggers.
  foreach fn in array array[
    'screening_v2.enqueue_r1_meet_public_terminal()',
    'screening_v2.enqueue_r1_meet_calendar_purge()'
  ] loop
    perform _r1_meet_public_tests.assert('T1-A ' || fn || ' is security invoker with search_path pg_catalog',
      (select not x.prosecdef and x.proconfig = array['search_path=pg_catalog']
         from pg_proc x where x.oid = fn::regprocedure));
    perform _r1_meet_public_tests.assert('T1-A ' || fn || ' is not executable by anon, authenticated or public',
      not has_function_privilege('anon', fn, 'execute')
      and not has_function_privilege('authenticated', fn, 'execute')
      and not has_function_privilege('public', fn, 'execute'));
  end loop;
  -- tgtype bits: 1 row, 2 before, 4 insert, 8 delete, 16 update, 32 truncate, 64 instead.
  perform _r1_meet_public_tests.assert(
    'T1-A enqueue_r1_meet_public_terminal: enabled, AFTER UPDATE OF status, FOR EACH ROW, with a WHEN clause',
    exists (select 1 from pg_trigger x
             where x.tgrelid = 'screening_v2.r1_meet_bookings'::regclass
               and x.tgname = 'enqueue_r1_meet_public_terminal'
               and not x.tgisinternal and x.tgenabled = 'O'
               and (x.tgtype::integer & 127) = 17
               and x.tgfoid = 'screening_v2.enqueue_r1_meet_public_terminal()'::regprocedure
               and x.tgqual is not null
               and pg_get_triggerdef(x.oid) like
                 'CREATE TRIGGER enqueue_r1_meet_public_terminal AFTER UPDATE OF status ON screening_v2.r1_meet_bookings FOR EACH ROW WHEN %'));
  perform _r1_meet_public_tests.assert(
    'T1-A enqueue_r1_meet_calendar_purge: enabled, AFTER DELETE, FOR EACH ROW, with a WHEN clause',
    exists (select 1 from pg_trigger x
             where x.tgrelid = 'screening_v2.r1_meet_bookings'::regclass
               and x.tgname = 'enqueue_r1_meet_calendar_purge'
               and not x.tgisinternal and x.tgenabled = 'O'
               and (x.tgtype::integer & 127) = 9
               and x.tgfoid = 'screening_v2.enqueue_r1_meet_calendar_purge()'::regprocedure
               and x.tgqual is not null
               and pg_get_triggerdef(x.oid) like
                 'CREATE TRIGGER enqueue_r1_meet_calendar_purge AFTER DELETE ON screening_v2.r1_meet_bookings FOR EACH ROW WHEN %'));
  perform _r1_meet_public_tests.assert('T1-A the 0142 bot release trigger is still there beside the purge',
    exists (select 1 from pg_trigger x
             where x.tgrelid = 'screening_v2.r1_meet_bookings'::regclass
               and x.tgname = 'enqueue_r1_meet_bot_release'
               and not x.tgisinternal and x.tgenabled = 'O'));
  -- Existing data reads the Ashby values: nothing was rewritten.
  perform _r1_meet_public_tests.assert('T1-A every booking that predates this run reads source ashby with no public column',
    not exists (select 1 from screening_v2.r1_meet_bookings x
                 where x.source <> 'ashby' or x.google_calendar_event_id is not null
                    or x.calendar_state is not null or x.invite_sent_at is not null
                    or x.public_request_id is not null or x.manage_token_digest is not null
                    or x.move_count <> 0));
end;
$$;

-- =============================================================================================
-- T1-B. source and the Ashby ids, both ways.
-- =============================================================================================
do $$
declare
  b uuid;
  col text;
begin
  -- An Ashby booking written the 0142 way (no source named) reads ashby, all public columns empty.
  b := _r1_meet_public_tests.ashby_booking(1);
  perform _r1_meet_public_tests.assert('T1-B an Ashby booking without source reads ashby and passes',
    (select x.source = 'ashby' and x.move_count = 0 and x.google_calendar_event_id is null
            and x.calendar_state is null and x.invite_sent_at is null
            and x.public_request_id is null and x.manage_token_digest is null
       from screening_v2.r1_meet_bookings x where x.id = b));
  foreach col in array array['ashby_interview_event_id', 'ashby_schedule_id', 'ashby_scheduled_by_user_id'] loop
    perform _r1_meet_public_tests.raises('T1-B an Ashby booking without ' || col,
      format('select _r1_meet_public_tests.ashby_booking(2, %L::jsonb)',
             jsonb_build_object(col, null)::text), '23514');
    perform _r1_meet_public_tests.rejected('T1-B an Ashby booking (source named) without ' || col,
      _r1_meet_public_tests.ashby_full(2) || jsonb_build_object(col, null));
  end loop;

  -- A public booking has none of the three, and every other column of a valid row.
  perform _r1_meet_public_tests.candidate(3);
  perform _r1_meet_public_tests.round(3);
  perform _r1_meet_public_tests.rejected('T1-B a public booking with an Ashby event id',
    _r1_meet_public_tests.public_row(3)
      || jsonb_build_object('ashby_interview_event_id', _r1_meet_public_tests.id(20, 3)));
  perform _r1_meet_public_tests.rejected('T1-B a public booking with an Ashby schedule id',
    _r1_meet_public_tests.public_row(3)
      || jsonb_build_object('ashby_schedule_id', _r1_meet_public_tests.id(21, 3)::text));
  perform _r1_meet_public_tests.rejected('T1-B a public booking with an Ashby scheduler id',
    _r1_meet_public_tests.public_row(3)
      || jsonb_build_object('ashby_scheduled_by_user_id', _r1_meet_public_tests.id(25, 1)::text));
  b := _r1_meet_public_tests.public_booking(3);
  perform _r1_meet_public_tests.assert('T1-B a valid public booking passes with no Ashby event, schedule or scheduler',
    (select x.source = 'public_page' and x.ashby_interview_event_id is null
            and x.ashby_schedule_id is null and x.ashby_scheduled_by_user_id is null
            and x.ashby_application_id = _r1_meet_public_tests.id(22, 3)::text
       from screening_v2.r1_meet_bookings x where x.id = b));

  -- The closed source list; the application id on every row.
  perform _r1_meet_public_tests.rejected('T1-B source other',
    _r1_meet_public_tests.public_row(4) || _r1_meet_public_tests.unbound() || '{"source": "other"}'::jsonb);
  perform _r1_meet_public_tests.rejected('T1-B source null',
    _r1_meet_public_tests.public_row(4) || _r1_meet_public_tests.unbound() || '{"source": null}'::jsonb,
    '23502');
  perform _r1_meet_public_tests.rejected('T1-B a public booking without ashby_application_id',
    _r1_meet_public_tests.public_row(4) || _r1_meet_public_tests.unbound()
      || '{"ashby_application_id": null}'::jsonb, '23502');
  perform _r1_meet_public_tests.raises('T1-B an Ashby booking without ashby_application_id',
    'select _r1_meet_public_tests.ashby_booking(5, ''{"ashby_application_id": null}''::jsonb)', '23502');
end;
$$;

-- =============================================================================================
-- T1-C. Every 0143 table CHECK re-validates over a booking of every status family, both sources.
-- =============================================================================================
do $$
declare
  con text;
  def text;
  v_count integer;
begin
  -- One 0142-shaped Ashby booking per status family, with the round and bot its bindings need.
  perform _r1_meet_public_tests.candidate(20, false);
  perform _r1_meet_public_tests.round(20);
  perform _r1_meet_public_tests.ashby_booking(20, jsonb_build_object('status', 'pending', 'reason', 'eligible',
    'candidate_id', _r1_meet_public_tests.id(10, 20), 'round_id', _r1_meet_public_tests.id(11, 20)));
  perform _r1_meet_public_tests.ashby_booking(21);
  perform _r1_meet_public_tests.ashby_booking(22, '{"status": "unmapped_scheduler", "reason": "scheduler_unmapped"}'::jsonb);
  perform _r1_meet_public_tests.ashby_booking(23, '{"status": "blocked", "reason": "not_scheduled"}'::jsonb);
  perform _r1_meet_public_tests.candidate(24, false);
  perform _r1_meet_public_tests.round(24);
  perform _r1_meet_public_tests.ashby_booking(24, jsonb_build_object('status', 'bot_scheduled', 'reason', 'eligible',
    'candidate_id', _r1_meet_public_tests.id(10, 24), 'round_id', _r1_meet_public_tests.id(11, 24),
    'recall_bot_id', _r1_meet_public_tests.id(30, 24)));
  perform _r1_meet_public_tests.candidate(25, false);
  perform _r1_meet_public_tests.round(25);
  perform _r1_meet_public_tests.ashby_booking(25, jsonb_build_object('status', 'completed', 'reason', 'attempt_settled',
    'candidate_id', _r1_meet_public_tests.id(10, 25), 'round_id', _r1_meet_public_tests.id(11, 25),
    'recall_bot_id', _r1_meet_public_tests.id(30, 25)));
  perform _r1_meet_public_tests.ashby_booking(26, '{"status": "cancelled", "reason": "cancelled"}'::jsonb);
  perform _r1_meet_public_tests.ashby_booking(27, '{"status": "failed", "reason": "no_show"}'::jsonb);
  perform _r1_meet_public_tests.ashby_booking(28, '{"status": "drained", "reason": "flag_off"}'::jsonb);
  -- And public bookings in each calendar state.
  perform _r1_meet_public_tests.candidate(29, false);
  perform _r1_meet_public_tests.round(29);
  perform _r1_meet_public_tests.public_booking(29);
  perform _r1_meet_public_tests.public_booking(30, _r1_meet_public_tests.unbound()
    || '{"calendar_state": "invited", "invite_sent_at": "2026-12-01T04:00:00+00:00"}'::jsonb);
  perform _r1_meet_public_tests.public_booking(31, _r1_meet_public_tests.unbound()
    || '{"calendar_state": "cancelled", "invite_sent_at": "2026-12-01T04:00:00+00:00"}'::jsonb);
  perform _r1_meet_public_tests.public_booking(32, _r1_meet_public_tests.unbound()
    || '{"calendar_state": "purged", "status": "failed", "reason": "invite_undeliverable"}'::jsonb);
  select count(*) into v_count from screening_v2.r1_meet_bookings x
   where x.ashby_interview_event_id in (select _r1_meet_public_tests.id(20, n) from generate_series(20, 28) n)
      or x.id in (select _r1_meet_public_tests.id(40, n) from generate_series(29, 32) n);
  perform _r1_meet_public_tests.assert('T1-C the thirteen family bookings exist', v_count = 13, v_count::text);

  foreach con in array array[
    'chk_r1_meet_bookings_source_ids', 'chk_r1_meet_bookings_calendar_event_id',
    'chk_r1_meet_bookings_public_columns', 'chk_r1_meet_bookings_reason',
    'chk_r1_meet_bookings_status_reason'
  ] loop
    select pg_get_constraintdef(x.oid) into def
      from pg_constraint x
     where x.conrelid = 'screening_v2.r1_meet_bookings'::regclass and x.conname = con
       and x.contype = 'c' and x.convalidated;
    perform _r1_meet_public_tests.assert('T1-C ' || con || ' exists as a validated CHECK', def is not null);
    -- A copy added NOT VALID and validated scans every row of the table: none may fail it.
    execute format('alter table screening_v2.r1_meet_bookings add constraint %I %s not valid', con || '_rv', def);
    execute format('alter table screening_v2.r1_meet_bookings validate constraint %I', con || '_rv');
    execute format('alter table screening_v2.r1_meet_bookings drop constraint %I', con || '_rv');
    perform _r1_meet_public_tests.assert('T1-C ' || con || ' validates over every booking of every family', true);
  end loop;
  foreach con in array array[
    'chk_r1_meet_bookings_source', 'chk_r1_meet_bookings_calendar_state',
    'chk_r1_meet_bookings_manage_digest', 'chk_r1_meet_bookings_move_count'
  ] loop
    perform _r1_meet_public_tests.assert('T1-C column CHECK ' || con || ' exists and is validated',
      exists (select 1 from pg_constraint x
               where x.conrelid = 'screening_v2.r1_meet_bookings'::regclass and x.conname = con
                 and x.contype = 'c' and x.convalidated));
  end loop;
end;
$$;

-- =============================================================================================
-- T1-D. The calendar event id is the booking id without dashes.
-- =============================================================================================
do $$
declare
  b uuid;
begin
  b := _r1_meet_public_tests.public_booking(40, _r1_meet_public_tests.unbound());
  perform _r1_meet_public_tests.assert('T1-D a public booking carries its id without dashes as the event id',
    (select x.google_calendar_event_id = replace(x.id::text, '-', '')
            and x.google_calendar_event_id ~ '^[0-9a-f]{32}$'
       from screening_v2.r1_meet_bookings x where x.id = b));
  perform _r1_meet_public_tests.rejected('T1-D another 32-hex event id',
    _r1_meet_public_tests.public_row(41) || _r1_meet_public_tests.unbound()
      || jsonb_build_object('google_calendar_event_id', replace(_r1_meet_public_tests.id(40, 99)::text, '-', '')));
  perform _r1_meet_public_tests.rejected('T1-D the dashed booking id as the event id',
    _r1_meet_public_tests.public_row(41) || _r1_meet_public_tests.unbound()
      || jsonb_build_object('google_calendar_event_id', _r1_meet_public_tests.id(40, 41)::text));
  perform _r1_meet_public_tests.rejected('T1-D the upper-case form as the event id',
    _r1_meet_public_tests.public_row(41) || _r1_meet_public_tests.unbound()
      || jsonb_build_object('google_calendar_event_id',
                            upper(replace(_r1_meet_public_tests.id(40, 41)::text, '-', ''))));
  perform _r1_meet_public_tests.rejected('T1-D a public booking without an event id',
    _r1_meet_public_tests.public_row(41) || _r1_meet_public_tests.unbound()
      || '{"google_calendar_event_id": null}'::jsonb);
  perform _r1_meet_public_tests.rejected('T1-D an Ashby booking with an event id (even the pinned one)',
    _r1_meet_public_tests.ashby_full(42) || jsonb_build_object(
      'id', _r1_meet_public_tests.id(40, 42),
      'google_calendar_event_id', replace(_r1_meet_public_tests.id(40, 42)::text, '-', '')));
end;
$$;

-- =============================================================================================
-- T1-E. The public columns.
-- =============================================================================================
do $$
declare
  b uuid;
  st text;
  d text := _r1_meet_public_tests.digest('manage-50');
begin
  -- None of them on an Ashby booking.
  perform _r1_meet_public_tests.rejected('T1-E an Ashby booking with a calendar state',
    _r1_meet_public_tests.ashby_full(50) || '{"calendar_state": "created"}'::jsonb);
  perform _r1_meet_public_tests.rejected('T1-E an Ashby booking with an invite time',
    _r1_meet_public_tests.ashby_full(50) || '{"invite_sent_at": "2026-12-01T04:00:00+00:00"}'::jsonb);
  perform _r1_meet_public_tests.rejected('T1-E an Ashby booking with a public request id',
    _r1_meet_public_tests.ashby_full(50) || jsonb_build_object('public_request_id', _r1_meet_public_tests.id(41, 50)));
  perform _r1_meet_public_tests.rejected('T1-E an Ashby booking with a manage digest',
    _r1_meet_public_tests.ashby_full(50) || jsonb_build_object('manage_token_digest', d));
  perform _r1_meet_public_tests.rejected('T1-E an Ashby booking with move_count 1',
    _r1_meet_public_tests.ashby_full(50) || '{"move_count": 1}'::jsonb);
  perform _r1_meet_public_tests.rejected('T1-E an Ashby booking with a calendar event id',
    _r1_meet_public_tests.ashby_full(50) || jsonb_build_object(
      'google_calendar_event_id', replace(_r1_meet_public_tests.id(40, 50)::text, '-', ''),
      'id', _r1_meet_public_tests.id(40, 50)));
  -- Setting one later is refused too (the update path).
  b := _r1_meet_public_tests.ashby_booking(51);
  perform _r1_meet_public_tests.raises('T1-E an update giving an Ashby booking a calendar state',
    format('update screening_v2.r1_meet_bookings set calendar_state = %L where id = %L', 'created', b), '23514');
  perform _r1_meet_public_tests.raises('T1-E an update turning an Ashby booking into a public one',
    format('update screening_v2.r1_meet_bookings set source = %L where id = %L', 'public_page', b), '23514');

  -- A public booking always has its calendar state and request id.
  perform _r1_meet_public_tests.rejected('T1-E a public booking without a calendar state',
    _r1_meet_public_tests.public_row(52) || _r1_meet_public_tests.unbound() || '{"calendar_state": null}'::jsonb);
  perform _r1_meet_public_tests.rejected('T1-E a public booking without a request id',
    _r1_meet_public_tests.public_row(52) || _r1_meet_public_tests.unbound() || '{"public_request_id": null}'::jsonb);
  -- An invite time only once invited.
  perform _r1_meet_public_tests.rejected('T1-E an invite time on a created event',
    _r1_meet_public_tests.public_row(52) || _r1_meet_public_tests.unbound()
      || '{"invite_sent_at": "2026-12-01T04:00:00+00:00"}'::jsonb);
  foreach st in array array['invited', 'cancelled', 'purged'] loop
    b := _r1_meet_public_tests.public_booking(53 + array_position(array['invited', 'cancelled', 'purged'], st),
      _r1_meet_public_tests.unbound() || jsonb_build_object('calendar_state', st,
                                                          'invite_sent_at', '2026-12-01T04:00:00+00:00'));
    perform _r1_meet_public_tests.assert('T1-E an invite time with calendar state ' || st || ' passes',
      (select x.calendar_state = st and x.invite_sent_at = '2026-12-01 04:00:00+00'
         from screening_v2.r1_meet_bookings x where x.id = b));
  end loop;
  perform _r1_meet_public_tests.rejected('T1-E calendar state cancel_pending',
    _r1_meet_public_tests.public_row(52) || _r1_meet_public_tests.unbound() || '{"calendar_state": "cancel_pending"}'::jsonb);
  -- The manage digest: 64 lower-case hex characters.
  perform _r1_meet_public_tests.rejected('T1-E an upper-case manage digest',
    _r1_meet_public_tests.public_row(52) || _r1_meet_public_tests.unbound()
      || jsonb_build_object('manage_token_digest', upper(d)));
  perform _r1_meet_public_tests.rejected('T1-E a 63-character manage digest',
    _r1_meet_public_tests.public_row(52) || _r1_meet_public_tests.unbound()
      || jsonb_build_object('manage_token_digest', left(d, 63)));
  perform _r1_meet_public_tests.rejected('T1-E a non-hex manage digest',
    _r1_meet_public_tests.public_row(52) || _r1_meet_public_tests.unbound()
      || jsonb_build_object('manage_token_digest', 'g' || right(d, 63)));
  -- move_count 0..10.
  perform _r1_meet_public_tests.rejected('T1-E move_count 11',
    _r1_meet_public_tests.public_row(52) || _r1_meet_public_tests.unbound() || '{"move_count": 11}'::jsonb);
  perform _r1_meet_public_tests.rejected('T1-E move_count -1',
    _r1_meet_public_tests.public_row(52) || _r1_meet_public_tests.unbound() || '{"move_count": -1}'::jsonb);
  b := _r1_meet_public_tests.public_booking(52, _r1_meet_public_tests.unbound()
    || jsonb_build_object('move_count', 10, 'manage_token_digest', d));
  perform _r1_meet_public_tests.assert('T1-E a public booking with move_count 10 and a digest passes',
    (select x.move_count = 10 and x.manage_token_digest = d from screening_v2.r1_meet_bookings x where x.id = b));
  -- The two unique keys (another booking id, everything else valid).
  perform _r1_meet_public_tests.rejected('T1-E a second booking with the same public request id',
    _r1_meet_public_tests.public_row(57) || _r1_meet_public_tests.unbound()
      || jsonb_build_object('public_request_id', _r1_meet_public_tests.id(41, 52)), '23505');
  perform _r1_meet_public_tests.rejected('T1-E a second booking with the same manage digest',
    _r1_meet_public_tests.public_row(57) || _r1_meet_public_tests.unbound()
      || jsonb_build_object('manage_token_digest', d), '23505');
end;
$$;

-- =============================================================================================
-- T1-F. The 34 reasons and the status/reason pairing.
-- =============================================================================================
do $$
declare
  pair record;
  n integer := 100;
  v_args jsonb;
  v_accepted integer := 0;
  v_reasons text[] := array[]::text[];
  v_def text;
begin
  -- Every pair of the 0143 pairing: the 0142 families plus cancelled/candidate_cancelled and
  -- failed/invite_undeliverable. Each pair is one Ashby booking with the bindings its status needs.
  for pair in
    select s.status, r.reason
      from (values
        (array['pending', 'bot_scheduled', 'bot_joining', 'human_present', 'in_call'], array['eligible']),
        (array['unmatched_application'], array['application_unknown', 'application_terminal']),
        (array['unmapped_scheduler'], array['scheduler_unmapped', 'created_by_unknown']),
        (array['blocked'], array['not_scheduled', 'no_attester', 'no_meet_link', 'disabled', 'paused',
                                 'candidate_ineligible', 'role_not_configured', 'round_active',
                                 'phone_engagement_active', 'phone_assessment_pending', 'capacity_exhausted',
                                 'consent_template_unavailable', 'slot_too_far', 'bot_cap_reached']),
        (array['completed'], array['attempt_settled']),
        (array['cancelled'], array['cancelled', 'dex_absent', 'event_removed', 'round_cancelled',
                                   'candidate_cancelled']),
        (array['failed'], array['in_past', 'bot_create_failed', 'bot_fatal', 'no_show', 'admission_refused',
                                'multiple_humans', 'round_expired', 'invite_undeliverable']),
        (array['drained'], array['flag_off'])
      ) as f(statuses, reasons)
      cross join lateral unnest(f.statuses) as s(status)
      cross join lateral unnest(f.reasons) as r(reason)
  loop
    n := n + 1;
    v_args := jsonb_build_object('status', pair.status, 'reason', pair.reason);
    if pair.status in ('pending', 'bot_scheduled', 'bot_joining', 'human_present', 'in_call', 'completed') then
      perform _r1_meet_public_tests.candidate(n, false);
      perform _r1_meet_public_tests.round(n);
      v_args := v_args || jsonb_build_object('candidate_id', _r1_meet_public_tests.id(10, n),
                                             'round_id', _r1_meet_public_tests.id(11, n));
    end if;
    if pair.status in ('bot_scheduled', 'bot_joining', 'human_present', 'in_call') then
      v_args := v_args || jsonb_build_object('recall_bot_id', _r1_meet_public_tests.id(30, n));
    end if;
    perform _r1_meet_public_tests.ashby_booking(n, v_args);
    v_accepted := v_accepted + 1;
    if not pair.reason = any(v_reasons) then
      v_reasons := v_reasons || pair.reason;
    end if;
  end loop;
  perform _r1_meet_public_tests.assert('T1-F all 38 (status, reason) pairs are accepted', v_accepted = 38,
    v_accepted::text);
  perform _r1_meet_public_tests.assert('T1-F the pairs cover exactly 34 distinct reasons',
    cardinality(v_reasons) = 34, cardinality(v_reasons)::text);
  select pg_get_constraintdef(x.oid) into v_def
    from pg_constraint x
   where x.conrelid = 'screening_v2.r1_meet_bookings'::regclass
     and x.conname = 'chk_r1_meet_bookings_reason';
  perform _r1_meet_public_tests.assert('T1-F the swapped reason CHECK names exactly those 34 reasons',
    (length(v_def) - length(replace(v_def, '''::text', ''))) / length('''::text') = 34
    and (select bool_and(strpos(v_def, '''' || r.reason || '''::text') > 0) from unnest(v_reasons) r(reason)),
    v_def);

  -- The two new pairs on public bookings.
  perform _r1_meet_public_tests.public_booking(150, _r1_meet_public_tests.unbound());
  perform _r1_meet_public_tests.public_booking(151, _r1_meet_public_tests.unbound()
    || '{"status": "failed", "reason": "invite_undeliverable"}'::jsonb);
  perform _r1_meet_public_tests.assert('T1-F a public booking accepts cancelled/candidate_cancelled and failed/invite_undeliverable',
    (select count(*) = 2 from screening_v2.r1_meet_bookings x
      where x.id in (_r1_meet_public_tests.id(40, 150), _r1_meet_public_tests.id(40, 151))));

  -- Refused pairs and an unknown reason.
  perform _r1_meet_public_tests.raises('T1-F failed/candidate_cancelled',
    'select _r1_meet_public_tests.ashby_booking(160, ''{"status": "failed", "reason": "candidate_cancelled"}''::jsonb)', '23514');
  perform _r1_meet_public_tests.raises('T1-F cancelled/invite_undeliverable',
    'select _r1_meet_public_tests.ashby_booking(160, ''{"status": "cancelled", "reason": "invite_undeliverable"}''::jsonb)', '23514');
  perform _r1_meet_public_tests.raises('T1-F blocked/invite_undeliverable',
    'select _r1_meet_public_tests.ashby_booking(160, ''{"status": "blocked", "reason": "invite_undeliverable"}''::jsonb)', '23514');
  perform _r1_meet_public_tests.raises('T1-F cancelled/bogus',
    'select _r1_meet_public_tests.ashby_booking(160, ''{"status": "cancelled", "reason": "bogus"}''::jsonb)', '23514');
  perform _r1_meet_public_tests.candidate(161, false);
  perform _r1_meet_public_tests.round(161);
  perform _r1_meet_public_tests.rejected('T1-F pending/candidate_cancelled',
    _r1_meet_public_tests.public_row(161) || '{"reason": "candidate_cancelled"}'::jsonb);
  perform _r1_meet_public_tests.rejected('T1-F a public booking failed/candidate_cancelled',
    _r1_meet_public_tests.public_row(162) || _r1_meet_public_tests.unbound() || '{"status": "failed"}'::jsonb);
end;
$$;

-- =============================================================================================
-- T1-G. The terminal trigger and the purge trigger.
-- =============================================================================================
do $$
declare
  t record;
  n integer := 200;
  b uuid;
  b2 uuid;
  res jsonb;
begin
  -- A pending public booking (on a directly inserted round) that becomes cancelled, failed or
  -- drained queues exactly the calendar cancel and the tag removal.
  for t in
    select * from (values ('cancelled', 'candidate_cancelled'), ('failed', 'bot_create_failed'),
                          ('failed', 'invite_undeliverable'), ('drained', 'flag_off')) v(status, reason)
  loop
    n := n + 1;
    perform _r1_meet_public_tests.candidate(n, false);
    perform _r1_meet_public_tests.round(n);
    b := _r1_meet_public_tests.public_booking(n);
    perform _r1_meet_public_tests.assert('T1-G a new public booking row queues nothing by itself (' || t.status || ')',
      _r1_meet_public_tests.jobs_of(b) = '[]'::jsonb);
    update screening_v2.r1_meet_bookings set status = t.status, reason = t.reason where id = b;
    perform _r1_meet_public_tests.assert('T1-G pending -> ' || t.status || '/' || t.reason
      || ' queues the calendar cancel and the tag removal, exactly',
      _r1_meet_public_tests.jobs_of(b) = _r1_meet_public_tests.terminal_jobs(b, true),
      _r1_meet_public_tests.jobs_of(b)::text);
  end loop;
  perform _r1_meet_public_tests.assert('T1-G the queued jobs are pending r1-meet rows carrying ids, ops and kinds only',
    (select count(*) = 8
            and bool_and(x.status = 'pending' and x.name = 'r1-meet' and x.attempts = 0
                         and array(select jsonb_object_keys(x.payload) order by 1) = array['booking_id', 'kind', 'op'])
       from screening_v2.job_queue x
      where x.payload ->> 'booking_id' in (select _r1_meet_public_tests.id(40, k)::text from generate_series(201, 204) k)));

  -- No calendar cancel once the event is gone; the tag removal still.
  perform _r1_meet_public_tests.candidate(210, false);
  perform _r1_meet_public_tests.round(210);
  b := _r1_meet_public_tests.public_booking(210, '{"calendar_state": "cancelled"}'::jsonb);
  update screening_v2.r1_meet_bookings set status = 'failed', reason = 'bot_create_failed' where id = b;
  perform _r1_meet_public_tests.assert('T1-G calendar state cancelled: only the tag removal',
    _r1_meet_public_tests.jobs_of(b) = _r1_meet_public_tests.terminal_jobs(b, false),
    _r1_meet_public_tests.jobs_of(b)::text);
  perform _r1_meet_public_tests.candidate(211, false);
  perform _r1_meet_public_tests.round(211);
  b := _r1_meet_public_tests.public_booking(211, '{"calendar_state": "purged"}'::jsonb);
  update screening_v2.r1_meet_bookings set status = 'drained', reason = 'flag_off' where id = b;
  perform _r1_meet_public_tests.assert('T1-G calendar state purged: only the tag removal',
    _r1_meet_public_tests.jobs_of(b) = _r1_meet_public_tests.terminal_jobs(b, false),
    _r1_meet_public_tests.jobs_of(b)::text);
  -- An invited event is cancelled too.
  perform _r1_meet_public_tests.candidate(212, false);
  perform _r1_meet_public_tests.round(212);
  b := _r1_meet_public_tests.public_booking(212,
    '{"calendar_state": "invited", "invite_sent_at": "2026-12-01T04:00:00+00:00"}'::jsonb);
  update screening_v2.r1_meet_bookings set status = 'cancelled', reason = 'round_cancelled' where id = b;
  perform _r1_meet_public_tests.assert('T1-G calendar state invited: the calendar cancel and the tag removal',
    _r1_meet_public_tests.jobs_of(b) = _r1_meet_public_tests.terminal_jobs(b, true),
    _r1_meet_public_tests.jobs_of(b)::text);

  -- A completed booking keeps its tag (S11) and its event (the retention purge is later).
  perform _r1_meet_public_tests.candidate(213, false);
  perform _r1_meet_public_tests.round(213);
  b := _r1_meet_public_tests.public_booking(213, jsonb_build_object(
    'status', 'in_call', 'recall_bot_id', _r1_meet_public_tests.id(30, 213)));
  update screening_v2.r1_meet_bookings set status = 'completed', reason = 'attempt_settled' where id = b;
  perform _r1_meet_public_tests.assert('T1-G in_call -> completed/attempt_settled queues nothing',
    _r1_meet_public_tests.jobs_of(b) = '[]'::jsonb, _r1_meet_public_tests.jobs_of(b)::text);
  -- ... and a later failure of a completed booking does not fire it either (old status terminal).
  update screening_v2.r1_meet_bookings set status = 'failed', reason = 'no_show' where id = b;
  perform _r1_meet_public_tests.assert('T1-G completed -> failed (a terminal row moved) queues nothing',
    _r1_meet_public_tests.jobs_of(b) = '[]'::jsonb, _r1_meet_public_tests.jobs_of(b)::text);

  -- A second terminal update (a reason change on a cancelled row) adds nothing, even once the
  -- first jobs are settled (so the dedup index could not be what holds it back).
  b := _r1_meet_public_tests.id(40, 201);
  update screening_v2.job_queue set status = 'completed'
   where name = 'r1-meet' and payload ->> 'booking_id' = b::text;
  update screening_v2.r1_meet_bookings set status = 'cancelled', reason = 'dex_absent' where id = b;
  perform _r1_meet_public_tests.assert('T1-G a second terminal update of a cancelled public booking queues nothing',
    (select count(*) = 2 and bool_and(x.status = 'completed') from screening_v2.job_queue x
      where x.name = 'r1-meet' and x.payload ->> 'booking_id' = b::text));
  -- A non-status update of a live public booking never fires it.
  perform _r1_meet_public_tests.candidate(214, false);
  perform _r1_meet_public_tests.round(214);
  b := _r1_meet_public_tests.public_booking(214);
  update screening_v2.r1_meet_bookings set calendar_state = 'invited', invite_sent_at = '2026-12-01 04:00:00+00'
   where id = b;
  update screening_v2.r1_meet_bookings set status = 'blocked', reason = 'bot_cap_reached' where id = b;
  perform _r1_meet_public_tests.assert('T1-G a calendar-state change and pending -> blocked queue nothing',
    _r1_meet_public_tests.jobs_of(b) = '[]'::jsonb, _r1_meet_public_tests.jobs_of(b)::text);

  -- Ashby bookings never enqueue anything new.
  perform _r1_meet_public_tests.candidate(215, false);
  perform _r1_meet_public_tests.round(215);
  b := _r1_meet_public_tests.ashby_booking(215, jsonb_build_object('status', 'pending', 'reason', 'eligible',
    'candidate_id', _r1_meet_public_tests.id(10, 215), 'round_id', _r1_meet_public_tests.id(11, 215)));
  update screening_v2.r1_meet_bookings set status = 'cancelled', reason = 'cancelled' where id = b;
  perform _r1_meet_public_tests.assert('T1-G an Ashby booking that is cancelled queues none of the new kinds',
    _r1_meet_public_tests.jobs_of(b) = '[]'::jsonb, _r1_meet_public_tests.jobs_of(b)::text);
  b := _r1_meet_public_tests.ashby_booking(216, '{"status": "blocked", "reason": "not_scheduled"}'::jsonb);
  update screening_v2.r1_meet_bookings set status = 'failed', reason = 'in_past' where id = b;
  delete from screening_v2.r1_meet_bookings where id = b;
  perform _r1_meet_public_tests.assert('T1-G an Ashby booking that fails and is deleted queues nothing',
    not exists (select 1 from screening_v2.job_queue x where x.payload ->> 'booking_id' = b::text));

  -- Through the 0142 runtime RPC as S05 will call it for an undeliverable invite.
  perform _r1_meet_public_tests.candidate(217, false);
  perform _r1_meet_public_tests.round(217);
  b := _r1_meet_public_tests.public_booking(217);
  res := screening_v2.r1_meet_transition_booking(b, 'pending', 'failed', 'invite_undeliverable',
                                                 '2026-12-01 04:00:00+00');
  perform _r1_meet_public_tests.assert('T1-G r1_meet_transition_booking pending -> failed/invite_undeliverable is ok',
    res ->> 'status' = 'ok', res::text);
  perform _r1_meet_public_tests.assert('T1-G ... and queues the calendar cancel and the tag removal',
    _r1_meet_public_tests.jobs_of(b) = _r1_meet_public_tests.terminal_jobs(b, true),
    _r1_meet_public_tests.jobs_of(b)::text);

  -- The purge: a deleted public booking whose event exists queues one calendar purge.
  b := _r1_meet_public_tests.public_booking(220, _r1_meet_public_tests.unbound());
  delete from screening_v2.r1_meet_bookings where id = b;
  perform _r1_meet_public_tests.assert('T1-G deleting a public booking whose event is created queues one purge',
    _r1_meet_public_tests.jobs_of(b) = jsonb_build_array(_r1_meet_public_tests.purge_job(b)),
    _r1_meet_public_tests.jobs_of(b)::text);
  b := _r1_meet_public_tests.public_booking(221, _r1_meet_public_tests.unbound()
    || '{"calendar_state": "invited", "invite_sent_at": "2026-12-01T04:00:00+00:00"}'::jsonb);
  delete from screening_v2.r1_meet_bookings where id = b;
  perform _r1_meet_public_tests.assert('T1-G deleting a public booking whose event is invited queues one purge',
    _r1_meet_public_tests.jobs_of(b) = jsonb_build_array(_r1_meet_public_tests.purge_job(b)),
    _r1_meet_public_tests.jobs_of(b)::text);
  b := _r1_meet_public_tests.public_booking(222, _r1_meet_public_tests.unbound()
    || '{"calendar_state": "cancelled"}'::jsonb);
  delete from screening_v2.r1_meet_bookings where id = b;
  perform _r1_meet_public_tests.assert('T1-G deleting a public booking whose event is cancelled queues nothing',
    _r1_meet_public_tests.jobs_of(b) = '[]'::jsonb, _r1_meet_public_tests.jobs_of(b)::text);
  b := _r1_meet_public_tests.public_booking(223, _r1_meet_public_tests.unbound()
    || '{"calendar_state": "purged"}'::jsonb);
  delete from screening_v2.r1_meet_bookings where id = b;
  perform _r1_meet_public_tests.assert('T1-G deleting a public booking whose event is purged queues nothing',
    _r1_meet_public_tests.jobs_of(b) = '[]'::jsonb, _r1_meet_public_tests.jobs_of(b)::text);
  b := _r1_meet_public_tests.ashby_booking(224, '{"status": "cancelled", "reason": "cancelled"}'::jsonb);
  delete from screening_v2.r1_meet_bookings where id = b;
  perform _r1_meet_public_tests.assert('T1-G deleting an Ashby booking queues no purge',
    not exists (select 1 from screening_v2.job_queue x where x.payload ->> 'booking_id' = b::text));

  -- The DSAR cascade: a candidate delete takes a public booking holding a bot with it and leaves
  -- the purge AND the 0142 bot release.
  perform _r1_meet_public_tests.candidate(225, true);
  perform _r1_meet_public_tests.round(225);
  b := _r1_meet_public_tests.public_booking(225, jsonb_build_object(
    'status', 'bot_scheduled', 'recall_bot_id', _r1_meet_public_tests.id(30, 225)));
  delete from screening_v2.candidates where id = _r1_meet_public_tests.id(10, 225);
  perform _r1_meet_public_tests.assert('T1-G a candidate delete cascades the public booking',
    not exists (select 1 from screening_v2.r1_meet_bookings x where x.id = b));
  perform _r1_meet_public_tests.assert('T1-G ... and queues the bot release and the calendar purge, exactly',
    _r1_meet_public_tests.jobs_of(b) = jsonb_build_array(
      _r1_meet_public_tests.job(jsonb_build_object('kind', 'bot_release',
                                                   'recall_bot_id', _r1_meet_public_tests.id(30, 225),
                                                   'booking_id', b),
                                'r1-meet:bot-release:' || _r1_meet_public_tests.id(30, 225)::text),
      _r1_meet_public_tests.purge_job(b)),
    _r1_meet_public_tests.jobs_of(b)::text);
  -- A round delete cascades too.
  perform _r1_meet_public_tests.candidate(226, false);
  perform _r1_meet_public_tests.round(226);
  b := _r1_meet_public_tests.public_booking(226);
  delete from screening_v2.interview_rounds where id = _r1_meet_public_tests.id(11, 226);
  perform _r1_meet_public_tests.assert('T1-G a round delete cascades the public booking and queues one purge',
    not exists (select 1 from screening_v2.r1_meet_bookings x where x.id = b)
    and _r1_meet_public_tests.jobs_of(b) = jsonb_build_array(_r1_meet_public_tests.purge_job(b)),
    _r1_meet_public_tests.jobs_of(b)::text);

  -- Dedup: the same booking id deleted again while its first purge job is live adds no job.
  b := _r1_meet_public_tests.public_booking(227, _r1_meet_public_tests.unbound());
  delete from screening_v2.r1_meet_bookings where id = b;
  b2 := _r1_meet_public_tests.public_booking(227, _r1_meet_public_tests.unbound());
  delete from screening_v2.r1_meet_bookings where id = b2;
  perform _r1_meet_public_tests.assert('T1-G a repeated purge of the same booking while its job is live adds no job',
    b2 = b and _r1_meet_public_tests.jobs_of(b) = jsonb_build_array(_r1_meet_public_tests.purge_job(b)),
    _r1_meet_public_tests.jobs_of(b)::text);
end;
$$;

-- =============================================================================================
-- T1-H. The throttle table's CHECKs and key.
-- =============================================================================================
do $$
declare
  k text := _r1_meet_public_tests.digest('throttle-1');
begin
  insert into screening_v2.r1_meet_public_throttle (key_digest, bucket_start)
  values (k, '2026-12-01 04:00:00+00');
  perform _r1_meet_public_tests.assert('T1-H a throttle row starts at 0 hits',
    (select x.hits = 0 from screening_v2.r1_meet_public_throttle x
      where x.key_digest = k and x.bucket_start = '2026-12-01 04:00:00+00'));
  perform _r1_meet_public_tests.raises('T1-H a non-hex throttle key',
    format('insert into screening_v2.r1_meet_public_throttle (key_digest, bucket_start) values (%L, %L)',
           'g' || right(k, 63), '2026-12-01 04:00:00+00'), '23514');
  perform _r1_meet_public_tests.raises('T1-H an upper-case throttle key',
    format('insert into screening_v2.r1_meet_public_throttle (key_digest, bucket_start) values (%L, %L)',
           upper(k), '2026-12-01 04:00:00+00'), '23514');
  perform _r1_meet_public_tests.raises('T1-H a 63-character throttle key',
    format('insert into screening_v2.r1_meet_public_throttle (key_digest, bucket_start) values (%L, %L)',
           left(k, 63), '2026-12-01 04:00:00+00'), '23514');
  perform _r1_meet_public_tests.raises('T1-H negative hits',
    format('insert into screening_v2.r1_meet_public_throttle (key_digest, bucket_start, hits) values (%L, %L, -1)',
           _r1_meet_public_tests.digest('throttle-2'), '2026-12-01 04:00:00+00'), '23514');
  perform _r1_meet_public_tests.raises('T1-H a NULL bucket',
    format('insert into screening_v2.r1_meet_public_throttle (key_digest, bucket_start) values (%L, null)',
           _r1_meet_public_tests.digest('throttle-3')), '23502');
  perform _r1_meet_public_tests.raises('T1-H a duplicate (key, bucket)',
    format('insert into screening_v2.r1_meet_public_throttle (key_digest, bucket_start) values (%L, %L)',
           k, '2026-12-01 04:00:00+00'), '23505');
  insert into screening_v2.r1_meet_public_throttle (key_digest, bucket_start)
  values (k, '2026-12-01 04:01:00+00');
  perform _r1_meet_public_tests.assert('T1-H the same key in another bucket is another row',
    (select count(*) = 2 from screening_v2.r1_meet_public_throttle x where x.key_digest = k));
end;
$$;

-- =============================================================================================
-- T2 fixtures. Fixture numbers 300-499; p_now is 2026-12-01 04:00 UTC unless a call says
-- otherwise. Rounds and bookings are inserted directly, holds come from r1_send_round, and the
-- one Ashby round comes from r1_meet_create_round_from_ashby (T3 adds the create-based cases).
-- =============================================================================================

-- A slot of p_minutes starting at p_start, as booking columns.
create function _r1_meet_public_tests.slot(p_start timestamptz, p_minutes integer default 45)
returns jsonb language sql stable as $$
  select jsonb_build_object('start_at', p_start, 'end_at', p_start + make_interval(mins => p_minutes))
$$;

-- A live public booking that needs no candidate or round (pairs with public_row): blocked.
create function _r1_meet_public_tests.blocked() returns jsonb
language sql immutable as $$
  select '{"status": "blocked", "reason": "bot_cap_reached", "candidate_id": null, "round_id": null}'::jsonb
$$;

-- Another round of candidate p_candidate (round id(11, p_round)), inserted directly.
create function _r1_meet_public_tests.round_of(p_round integer, p_candidate integer, p_status text,
                                               p_channel text default 'meet',
                                               p_expires_at timestamptz default '2026-12-02 07:45:00+00')
returns uuid language plpgsql as $$
begin
  insert into screening_v2.interview_rounds
    (id, candidate_id, role_id, link_token_digest, expires_at, created_by, status, channel)
  values (_r1_meet_public_tests.id(11, p_round), _r1_meet_public_tests.id(10, p_candidate),
          _r1_meet_public_tests.id(2, 1), _r1_meet_public_tests.digest('link-of-' || p_round::text),
          p_expires_at, _r1_meet_public_tests.id(1, 1), p_status, p_channel);
  return _r1_meet_public_tests.id(11, p_round);
end;
$$;

-- A browser call session of round p_round (status `created`, as every new session starts).
create function _r1_meet_public_tests.session(p_n integer, p_round uuid)
returns uuid language plpgsql as $$
begin
  insert into screening_v2.call_sessions
    (id, candidate_id, role_id, mode, provider, external_call_id, status, interview_round_id, owner_id)
  select _r1_meet_public_tests.id(12, p_n), x.candidate_id, x.role_id, 'browser', 'livekit',
         'screening-' || _r1_meet_public_tests.id(12, p_n)::text, 'created', x.id,
         _r1_meet_public_tests.id(1, 1)
    from screening_v2.interview_rounds x
   where x.id = p_round;
  return _r1_meet_public_tests.id(12, p_n);
end;
$$;

-- A candidate_web consent of round p_round on our notice (every required key).
create function _r1_meet_public_tests.consent(p_round uuid,
                                              p_granted_at timestamptz default '2026-12-01 03:00:00+00')
returns uuid language plpgsql as $$
declare
  v_id uuid;
begin
  insert into screening_v2.interview_round_consents (round_id, template_id, consents, proof, granted_at)
  values (p_round, _r1_meet_public_tests.id(3, 1),
          '["ai_interview", "video_audio_recording", "ai_evaluation", "data_processing"]'::jsonb,
          '{"decision": "granted"}'::jsonb, p_granted_at)
  returning id into v_id;
  return v_id;
end;
$$;

-- The precheck of candidate n for its own application n: 'eligible', the refusal code, or
-- '<status>:<field>'.
create function _r1_meet_public_tests.pre(p_n integer, p_now timestamptz default '2026-12-01 04:00:00+00')
returns text language plpgsql as $$
declare
  v_res jsonb := screening_v2.r1_meet_public_precheck(_r1_meet_public_tests.id(10, p_n),
                                                     _r1_meet_public_tests.id(22, p_n)::text, p_now);
begin
  return case v_res ->> 'status'
           when 'eligible' then 'eligible'
           when 'refused' then v_res ->> 'code'
           else coalesce(v_res ->> 'status', 'null') || ':' || coalesce(v_res ->> 'field', '')
         end;
end;
$$;

-- Runs the statements p_setup, then the query p_sql (one jsonb), inside a subtransaction that is
-- ALWAYS rolled back, and returns the answer. A real error (a failed assertion too) is re-raised,
-- never mistaken for the sentinel.
create function _r1_meet_public_tests.in_rollback(p_setup text[], p_sql text)
returns jsonb language plpgsql as $$
declare
  v_res jsonb;
  v_done boolean := false;
  v_stmt text;
begin
  begin
    foreach v_stmt in array p_setup loop
      execute v_stmt;
    end loop;
    execute p_sql into v_res;
    v_done := true;
    raise exception 'r1 meet public rollback sentinel' using errcode = 'P0001';
  exception when sqlstate 'P0001' then
    if not v_done then
      raise;
    end if;
  end;
  return v_res;
end;
$$;

-- Runs p_sql under one more active consent release (newer than ours), rolled back as above
-- (releases are immutable and could not be removed otherwise).
create function _r1_meet_public_tests.under_release(p_version text, p_locale text, p_required jsonb,
                                                    p_sql text)
returns jsonb language plpgsql as $$
declare
  v_res jsonb;
  v_done boolean := false;
begin
  begin
    insert into screening_v2.interview_round_consent_templates
      (version, locale, title, body_md, required_consents, is_active)
    values (p_version, p_locale, 'R1 Meet public assertion newer notice', 'fixture', p_required, true);
    perform _r1_meet_public_tests.assert('T2 fixture release ' || p_version || ' (' || p_locale
                                         || ') is the newest active release',
      (select max(x.version) = p_version
         from screening_v2.interview_round_consent_templates x where x.is_active));
    execute p_sql into v_res;
    v_done := true;
    raise exception 'r1 meet public rollback sentinel' using errcode = 'P0001';
  exception when sqlstate 'P0001' then
    if not v_done then
      raise;
    end if;
  end;
  return v_res;
end;
$$;

-- Everything a read-only call must leave alone, as one value: row counts and row digests of the
-- bookings, rounds, consents, jobs, budget months and throttle rows.
create function _r1_meet_public_tests.counts() returns jsonb
language sql stable as $$
  select jsonb_build_object(
    'bookings', (select count(*) || ':' || coalesce(md5(string_agg(x::text, '|' order by x.id)), '')
                   from screening_v2.r1_meet_bookings x),
    'rounds', (select count(*) || ':' || coalesce(md5(string_agg(x::text, '|' order by x.id)), '')
                 from screening_v2.interview_rounds x),
    'consents', (select count(*) || ':' || coalesce(md5(string_agg(x::text, '|' order by x.id)), '')
                   from screening_v2.interview_round_consents x),
    'jobs', (select count(*) || ':' || coalesce(md5(string_agg(x::text, '|' order by x.id)), '')
               from screening_v2.job_queue x),
    'months', (select count(*) || ':' || coalesce(md5(string_agg(x::text, '|' order by x.month_start)), '')
                 from screening_v2.r1_budget_month x),
    'throttle', (select count(*) || ':' || coalesce(md5(string_agg(x::text, '|'
                                                                  order by x.key_digest, x.bucket_start)), '')
                   from screening_v2.r1_meet_public_throttle x))
$$;

-- The hits of one throttle row (NULL when the row does not exist).
create function _r1_meet_public_tests.hits(p_key text, p_bucket timestamptz) returns integer
language sql stable as $$
  select x.hits from screening_v2.r1_meet_public_throttle x
   where x.key_digest = p_key and x.bucket_start = p_bucket
$$;

-- =============================================================================================
-- T2-A. Slot and day counts (§10, §11) and r1_meet_public_capacity (§13).
-- =============================================================================================
-- Every booking here starts on IST 2026-12-09 or 2026-12-10, days no other section uses.
do $$
declare
  p_now constant timestamptz := '2026-12-01 04:00:00+00';
  c_from constant timestamptz := '2026-12-08 18:30:00+00';
  c_to constant timestamptz := '2026-12-10 18:30:00+00';
  res jsonb;
  res2 jsonb;
  v_pool integer;
begin
  perform _r1_meet_public_tests.assert('T2-A fixture: no booking starts on IST 2026-12-08 .. 2026-12-24 yet',
    not exists (select 1 from screening_v2.r1_meet_bookings x
                 where x.start_at >= '2026-12-07 18:30:00+00' and x.start_at < '2026-12-24 18:30:00+00'));

  -- IST 2026-12-09 is UTC 2026-12-08 18:30 .. 2026-12-09 18:30. Live, both sources:
  perform _r1_meet_public_tests.public_booking(300, _r1_meet_public_tests.blocked()
    || _r1_meet_public_tests.slot('2026-12-09 05:00:00+00'));
  perform _r1_meet_public_tests.ashby_booking(301, '{"status": "blocked", "reason": "not_scheduled"}'::jsonb
    || _r1_meet_public_tests.slot('2026-12-09 05:30:00+00'));
  perform _r1_meet_public_tests.candidate(302, false);
  perform _r1_meet_public_tests.round(302);
  perform _r1_meet_public_tests.public_booking(302, _r1_meet_public_tests.slot('2026-12-09 05:45:00+00'));
  perform _r1_meet_public_tests.ashby_booking(303, '{"status": "blocked", "reason": "not_scheduled"}'::jsonb
    || _r1_meet_public_tests.slot('2026-12-09 04:15:00+00'));
  -- Terminal on the same day: completed/attempt_settled and failed/no_show used a bot (they count);
  -- failed/in_past, failed/invite_undeliverable, failed/bot_create_failed and both cancels did not.
  perform _r1_meet_public_tests.candidate(304, false);
  perform _r1_meet_public_tests.round(304);
  perform _r1_meet_public_tests.public_booking(304, jsonb_build_object(
    'status', 'completed', 'reason', 'attempt_settled', 'recall_bot_id', _r1_meet_public_tests.id(30, 304))
    || _r1_meet_public_tests.slot('2026-12-09 07:00:00+00'));
  perform _r1_meet_public_tests.public_booking(305, _r1_meet_public_tests.unbound()
    || '{"status": "failed", "reason": "no_show"}'::jsonb || _r1_meet_public_tests.slot('2026-12-09 08:00:00+00'));
  perform _r1_meet_public_tests.ashby_booking(306, '{"status": "failed", "reason": "in_past"}'::jsonb
    || _r1_meet_public_tests.slot('2026-12-09 08:00:00+00'));
  perform _r1_meet_public_tests.public_booking(307, _r1_meet_public_tests.unbound()
    || '{"status": "failed", "reason": "invite_undeliverable"}'::jsonb
    || _r1_meet_public_tests.slot('2026-12-09 09:00:00+00'));
  perform _r1_meet_public_tests.public_booking(308, _r1_meet_public_tests.unbound()
    || _r1_meet_public_tests.slot('2026-12-09 09:00:00+00'));
  perform _r1_meet_public_tests.ashby_booking(309, '{"status": "cancelled", "reason": "cancelled"}'::jsonb
    || _r1_meet_public_tests.slot('2026-12-09 09:00:00+00'));
  perform _r1_meet_public_tests.ashby_booking(310, '{"status": "failed", "reason": "bot_create_failed"}'::jsonb
    || _r1_meet_public_tests.slot('2026-12-09 10:00:00+00'));
  -- Not live either: an unmatched Ashby booking (the ashby_row default).
  perform _r1_meet_public_tests.ashby_booking(311, _r1_meet_public_tests.slot('2026-12-09 10:00:00+00'));
  -- The IST midnight: 23:59:59 IST on the 9th, then 00:00 IST on the 10th.
  perform _r1_meet_public_tests.public_booking(312, _r1_meet_public_tests.blocked()
    || _r1_meet_public_tests.slot('2026-12-09 18:29:59+00'));
  perform _r1_meet_public_tests.ashby_booking(313, '{"status": "blocked", "reason": "not_scheduled"}'::jsonb
    || _r1_meet_public_tests.slot('2026-12-09 18:30:00+00'));

  -- §10: overlap only, live only, both sources, one booking left out on request.
  perform _r1_meet_public_tests.assert('T2-A slot count 05:00-05:45: one public and one Ashby live booking; the touching ones are out',
    screening_v2.r1_meet_public_slot_count('2026-12-09 05:00:00+00', '2026-12-09 05:45:00+00', null) = 2);
  perform _r1_meet_public_tests.assert('T2-A slot count leaves the excluded booking out',
    screening_v2.r1_meet_public_slot_count('2026-12-09 05:00:00+00', '2026-12-09 05:45:00+00',
                                           _r1_meet_public_tests.id(40, 300)) = 1);
  perform _r1_meet_public_tests.assert('T2-A slot count 05:30-06:00 overlaps three live bookings',
    screening_v2.r1_meet_public_slot_count('2026-12-09 05:30:00+00', '2026-12-09 06:00:00+00', null) = 3);
  perform _r1_meet_public_tests.assert('T2-A slot count: a booking that starts when the slot ends is out',
    screening_v2.r1_meet_public_slot_count('2026-12-09 03:30:00+00', '2026-12-09 04:15:00+00', null) = 0);
  perform _r1_meet_public_tests.assert('T2-A slot count: completed, failed, cancelled and unmatched bookings are out',
    screening_v2.r1_meet_public_slot_count('2026-12-09 07:00:00+00', '2026-12-09 07:45:00+00', null) = 0
    and screening_v2.r1_meet_public_slot_count('2026-12-09 08:00:00+00', '2026-12-09 08:45:00+00', null) = 0
    and screening_v2.r1_meet_public_slot_count('2026-12-09 09:00:00+00', '2026-12-09 09:45:00+00', null) = 0
    and screening_v2.r1_meet_public_slot_count('2026-12-09 10:00:00+00', '2026-12-09 10:45:00+00', null) = 0);
  perform _r1_meet_public_tests.assert('T2-A slot count across the IST midnight sees both sides',
    screening_v2.r1_meet_public_slot_count('2026-12-09 18:00:00+00', '2026-12-09 19:00:00+00', null) = 2);

  -- §11: by IST start date; live or used a bot; total and public.
  res := screening_v2.r1_meet_public_day_count('2026-12-09', null);
  perform _r1_meet_public_tests.assert('T2-A day count IST 2026-12-09: total 7 (5 live + attempt_settled + no_show), public 5',
    res = '{"total": 7, "public": 5}'::jsonb, res::text);
  res := screening_v2.r1_meet_public_day_count('2026-12-09', _r1_meet_public_tests.id(40, 300));
  perform _r1_meet_public_tests.assert('T2-A day count leaves an excluded public booking out of both counts',
    res = '{"total": 6, "public": 4}'::jsonb, res::text);
  res := screening_v2.r1_meet_public_day_count('2026-12-09', (select x.id from screening_v2.r1_meet_bookings x
                                                             where x.ashby_interview_event_id = _r1_meet_public_tests.id(20, 301)));
  perform _r1_meet_public_tests.assert('T2-A day count leaves an excluded Ashby booking out of the total only',
    res = '{"total": 6, "public": 5}'::jsonb, res::text);
  res := screening_v2.r1_meet_public_day_count('2026-12-10', null);
  perform _r1_meet_public_tests.assert('T2-A day count IST 2026-12-10 holds the 18:30 UTC booking only',
    res = '{"total": 1, "public": 0}'::jsonb, res::text);
  res := screening_v2.r1_meet_public_day_count('2026-12-11', null);
  perform _r1_meet_public_tests.assert('T2-A day count of an empty day is zero',
    res = '{"total": 0, "public": 0}'::jsonb, res::text);

  -- §13: the full answer for IST 2026-12-09 .. 2026-12-10.
  res := screening_v2.r1_meet_public_capacity(c_from, c_to, p_now);
  perform _r1_meet_public_tests.assert('T2-A capacity answers exactly the contract keys',
    array(select jsonb_object_keys(res) order by 1)
      = array['admits', 'day_counts', 'effective_concurrency', 'enabled', 'intervals', 'paused', 'status'],
    res::text);
  perform _r1_meet_public_tests.assert('T2-A capacity: ok, enabled, not paused, admits, effective concurrency 1',
    res ->> 'status' = 'ok' and (res -> 'enabled') = 'true'::jsonb and (res -> 'paused') = 'false'::jsonb
    and (res -> 'admits') = 'true'::jsonb and (res -> 'effective_concurrency') = '1'::jsonb, res::text);
  perform _r1_meet_public_tests.assert('T2-A capacity intervals: the live bookings of both sources, by start, no ids',
    res -> 'intervals' = jsonb_build_array(
      _r1_meet_public_tests.slot('2026-12-09 04:15:00+00'), _r1_meet_public_tests.slot('2026-12-09 05:00:00+00'),
      _r1_meet_public_tests.slot('2026-12-09 05:30:00+00'), _r1_meet_public_tests.slot('2026-12-09 05:45:00+00'),
      _r1_meet_public_tests.slot('2026-12-09 18:29:59+00'), _r1_meet_public_tests.slot('2026-12-09 18:30:00+00')),
    (res -> 'intervals')::text);
  perform _r1_meet_public_tests.assert('T2-A capacity intervals carry start_at and end_at only',
    (select bool_and(array(select jsonb_object_keys(e) order by 1) = array['end_at', 'start_at'])
       from jsonb_array_elements(res -> 'intervals') e));
  perform _r1_meet_public_tests.assert('T2-A capacity day_counts: one entry per IST date, ascending',
    res -> 'day_counts' = '[{"ist_date": "2026-12-09", "total": 7, "public": 5},
                            {"ist_date": "2026-12-10", "total": 1, "public": 0}]'::jsonb,
    (res -> 'day_counts')::text);
  res := screening_v2.r1_meet_public_capacity('2026-12-09 05:40:00+00', '2026-12-09 05:50:00+00', p_now);
  perform _r1_meet_public_tests.assert('T2-A capacity of a 10-minute window: the three overlapping intervals and its one day',
    res -> 'intervals' = jsonb_build_array(
      _r1_meet_public_tests.slot('2026-12-09 05:00:00+00'), _r1_meet_public_tests.slot('2026-12-09 05:30:00+00'),
      _r1_meet_public_tests.slot('2026-12-09 05:45:00+00'))
    and res -> 'day_counts' = '[{"ist_date": "2026-12-09", "total": 7, "public": 5}]'::jsonb, res::text);
  res := screening_v2.r1_meet_public_capacity('2026-12-09 06:30:00+00', '2026-12-09 07:00:00+00', p_now);
  perform _r1_meet_public_tests.assert('T2-A capacity: a booking that ends when the window starts is out (empty intervals)',
    res -> 'intervals' = '[]'::jsonb, res::text);
  res := screening_v2.r1_meet_public_capacity('2026-12-09 18:30:00+00', '2026-12-12 18:30:00+00', p_now);
  perform _r1_meet_public_tests.assert('T2-A capacity lists the zero days too',
    res -> 'day_counts' = '[{"ist_date": "2026-12-10", "total": 1, "public": 0},
                            {"ist_date": "2026-12-11", "total": 0, "public": 0},
                            {"ist_date": "2026-12-12", "total": 0, "public": 0}]'::jsonb,
    (res -> 'day_counts')::text);
  res := screening_v2.r1_meet_public_capacity('2026-12-09 00:00:00+00', '2026-12-24 00:00:00+00', p_now);
  perform _r1_meet_public_tests.assert('T2-A a 15-day window answers 16 ascending IST dates, 2026-12-09 .. 2026-12-24',
    res ->> 'status' = 'ok' and jsonb_array_length(res -> 'day_counts') = 16
    and res -> 'day_counts' -> 0 ->> 'ist_date' = '2026-12-09'
    and res -> 'day_counts' -> 15 ->> 'ist_date' = '2026-12-24'
    and (select bool_and((e.value ->> 'ist_date')::date = '2026-12-09'::date + (e.ordinality - 1)::integer)
           from jsonb_array_elements(res -> 'day_counts') with ordinality e), res::text);

  -- The window and now.
  res := screening_v2.r1_meet_public_capacity('2026-12-09 00:00:00+00', '2026-12-24 00:00:01+00', p_now);
  perform _r1_meet_public_tests.assert('T2-A capacity refuses 15 days + 1 s',
    res = '{"status": "invalid_request", "field": "window"}'::jsonb, res::text);
  res := screening_v2.r1_meet_public_capacity(c_from, c_from, p_now);
  perform _r1_meet_public_tests.assert('T2-A capacity refuses an empty window',
    res = '{"status": "invalid_request", "field": "window"}'::jsonb, res::text);
  res := screening_v2.r1_meet_public_capacity(c_to, c_from, p_now);
  perform _r1_meet_public_tests.assert('T2-A capacity refuses a reversed window',
    res = '{"status": "invalid_request", "field": "window"}'::jsonb, res::text);
  res := screening_v2.r1_meet_public_capacity(null, c_to, p_now);
  perform _r1_meet_public_tests.assert('T2-A capacity refuses a NULL bound',
    res = '{"status": "invalid_request", "field": "window"}'::jsonb, res::text);
  res := screening_v2.r1_meet_public_capacity(c_from, c_to, null);
  perform _r1_meet_public_tests.assert('T2-A capacity refuses a NULL now',
    res = '{"status": "invalid_request", "field": "now"}'::jsonb, res::text);

  -- effective_concurrency: the 0131 admission limit.
  select count(*) into v_pool from screening_v2.voice_worker_leases x
   where x.app = 'project-hello-voice' and x.pipeline = 'browser';
  update screening_v2.r1_settings set max_concurrent_sessions = 3 where singleton;
  res := screening_v2.r1_meet_public_capacity(c_from, c_to, p_now);
  perform _r1_meet_public_tests.assert('T2-A target r1, max 3: least(3, greatest(browser pool, 1)), 1 with no pool',
    (res ->> 'effective_concurrency')::integer = least(3, greatest(v_pool, 1))
    and (v_pool > 0 or (res ->> 'effective_concurrency')::integer = 1), res::text || ' pool ' || v_pool);
  insert into screening_v2.voice_worker_leases (app, machine_id, pipeline)
  values ('project-hello-voice', 'meet-public-assert-1', 'browser'),
         ('project-hello-voice', 'meet-public-assert-2', 'browser'),
         ('project-hello-voice', 'meet-public-assert-3', 'phone'),
         ('meet-public-assert-other-app', 'meet-public-assert-4', 'browser');
  res := screening_v2.r1_meet_public_capacity(c_from, c_to, p_now);
  perform _r1_meet_public_tests.assert('T2-A two more browser machines of the browser app raise it (phone and other apps do not count)',
    (res ->> 'effective_concurrency')::integer = least(3, v_pool + 2), res::text || ' pool ' || v_pool);
  update screening_v2.r1_settings set livekit_target = 'cloud' where singleton;
  res := screening_v2.r1_meet_public_capacity(c_from, c_to, p_now);
  perform _r1_meet_public_tests.assert('T2-A target cloud: effective concurrency 1',
    (res ->> 'effective_concurrency')::integer = 1, res::text);
  update screening_v2.r1_settings set livekit_target = 'r1', max_concurrent_sessions = 1 where singleton;

  -- enabled and paused mirror the settings.
  update screening_v2.r1_settings set paused = true where singleton;
  res := screening_v2.r1_meet_public_capacity(c_from, c_to, p_now);
  perform _r1_meet_public_tests.assert('T2-A paused settings: paused true, enabled true',
    (res -> 'paused') = 'true'::jsonb and (res -> 'enabled') = 'true'::jsonb, res::text);
  update screening_v2.r1_settings set paused = false, enabled = false where singleton;
  res := screening_v2.r1_meet_public_capacity(c_from, c_to, p_now);
  perform _r1_meet_public_tests.assert('T2-A disabled settings: enabled false, paused false',
    (res -> 'enabled') = 'false'::jsonb and (res -> 'paused') = 'false'::jsonb, res::text);
  update screening_v2.r1_settings set enabled = true where singleton;

  -- admits: r1_send_round's capacity rule (one more 65-minute hold must fit).
  perform _r1_meet_public_tests.candidate(314, false);
  res := screening_v2.r1_send_round(_r1_meet_public_tests.id(10, 314), _r1_meet_public_tests.id(2, 1),
                                    _r1_meet_public_tests.id(1, 1), _r1_meet_public_tests.digest('send-314'),
                                    'queued', '2026-12-02 07:45:00+00', p_now);
  perform _r1_meet_public_tests.assert('T2-A fixture: r1_send_round leaves a 65-minute hold outstanding',
    res ->> 'status' = 'ok'
    and (select x.held_minutes = 65 from screening_v2.interview_rounds x where x.id = (res ->> 'id')::uuid), res::text);
  update screening_v2.r1_settings set monthly_cap_minutes = 65 where singleton;
  res := screening_v2.r1_meet_public_capacity(c_from, c_to, p_now);
  perform _r1_meet_public_tests.assert('T2-A a 65-minute cap with a hold outstanding: admits false',
    (res -> 'admits') = 'false'::jsonb, res::text);
  update screening_v2.r1_settings set monthly_cap_minutes = 100000 where singleton;
  res := screening_v2.r1_meet_public_capacity(c_from, c_to, p_now);
  perform _r1_meet_public_tests.assert('T2-A the cap restored: admits true',
    (res -> 'admits') = 'true'::jsonb, res::text);

  -- No settings row: closed defaults, the intervals and day counts still answered (rolled back).
  res2 := _r1_meet_public_tests.in_rollback(array['delete from screening_v2.r1_settings'],
    format('select screening_v2.r1_meet_public_capacity(%L, %L, %L)', c_from, c_to, p_now));
  perform _r1_meet_public_tests.assert('T2-A no settings row: enabled false, paused false, admits false, effective concurrency 1',
    res2 = res || '{"enabled": false, "paused": false, "admits": false, "effective_concurrency": 1}'::jsonb,
    res2::text);
  perform _r1_meet_public_tests.assert('T2-A the settings row is back after the rolled-back delete',
    exists (select 1 from screening_v2.r1_settings x where x.singleton and x.enabled));
end;
$$;

-- =============================================================================================
-- T2-B. r1_meet_public_precheck and the shared refusal predicates (§12, §14), in order.
-- =============================================================================================
do $$
declare
  p_now constant timestamptz := '2026-12-01 04:00:00+00';
  res jsonb;
  r uuid;
  v_link uuid;
begin
  -- The fields, before anything is read.
  res := screening_v2.r1_meet_public_precheck(null, _r1_meet_public_tests.id(22, 320)::text, p_now);
  perform _r1_meet_public_tests.assert('T2-B precheck refuses a NULL candidate id',
    res = '{"status": "invalid_request", "field": "candidate_id"}'::jsonb, res::text);
  res := screening_v2.r1_meet_public_precheck(_r1_meet_public_tests.id(10, 320), null, p_now);
  perform _r1_meet_public_tests.assert('T2-B precheck refuses a NULL application id',
    res = '{"status": "invalid_request", "field": "application_id"}'::jsonb, res::text);
  res := screening_v2.r1_meet_public_precheck(_r1_meet_public_tests.id(10, 320), 'not-a-uuid', p_now);
  perform _r1_meet_public_tests.assert('T2-B precheck refuses an application id that is not UUID-shaped',
    res = '{"status": "invalid_request", "field": "application_id"}'::jsonb, res::text);
  res := screening_v2.r1_meet_public_precheck(_r1_meet_public_tests.id(10, 320),
                                             _r1_meet_public_tests.id(22, 320)::text, null);
  perform _r1_meet_public_tests.assert('T2-B precheck refuses a NULL now',
    res = '{"status": "invalid_request", "field": "now"}'::jsonb, res::text);

  -- 1. application_unknown.
  perform _r1_meet_public_tests.candidate(320, false);
  perform _r1_meet_public_tests.assert('T2-B no Ashby link: application_unknown',
    _r1_meet_public_tests.pre(320) = 'application_unknown', _r1_meet_public_tests.pre(320));
  res := screening_v2.r1_meet_public_precheck(_r1_meet_public_tests.id(10, 320),
                                             _r1_meet_public_tests.id(22, 320)::text, p_now);
  perform _r1_meet_public_tests.assert('T2-B a refusal answers exactly {status refused, code}',
    res = '{"status": "refused", "code": "application_unknown"}'::jsonb, res::text);
  perform _r1_meet_public_tests.candidate(321);
  res := screening_v2.r1_meet_public_precheck(_r1_meet_public_tests.id(10, 321),
                                             _r1_meet_public_tests.id(22, 399)::text, p_now);
  perform _r1_meet_public_tests.assert('T2-B an application id nobody has: application_unknown',
    res ->> 'code' = 'application_unknown', res::text);
  res := screening_v2.r1_meet_public_precheck(_r1_meet_public_tests.id(10, 321),
                                             upper(_r1_meet_public_tests.id(22, 321)::text), p_now);
  perform _r1_meet_public_tests.assert('T2-B the application id is matched verbatim (the upper-case form is unknown)',
    res ->> 'code' = 'application_unknown', res::text);
  perform _r1_meet_public_tests.candidate(322);
  perform _r1_meet_public_tests.candidate(323, false);
  res := screening_v2.r1_meet_public_precheck(_r1_meet_public_tests.id(10, 323),
                                             _r1_meet_public_tests.id(22, 322)::text, p_now);
  perform _r1_meet_public_tests.assert('T2-B a link bound to another candidate: application_unknown',
    res ->> 'code' = 'application_unknown', res::text);
  perform _r1_meet_public_tests.assert('T2-B ... while its own candidate is eligible',
    _r1_meet_public_tests.pre(322) = 'eligible', _r1_meet_public_tests.pre(322));

  -- 2. application_terminal, also before a DSAR hold.
  perform _r1_meet_public_tests.candidate(324);
  update screening_v2.ashby_application_links set terminal_state = 'withdrawn'
   where provider = 'ashby' and external_application_id = _r1_meet_public_tests.id(22, 324)::text;
  perform _r1_meet_public_tests.assert('T2-B a terminal link: application_terminal',
    _r1_meet_public_tests.pre(324) = 'application_terminal', _r1_meet_public_tests.pre(324));
  insert into screening_v2.data_subject_requests (candidate_id, request_type, requested_by)
  values (_r1_meet_public_tests.id(10, 324), 'delete', _r1_meet_public_tests.id(1, 1));
  perform _r1_meet_public_tests.assert('T2-B a terminal link and a DSAR hold: application_terminal first',
    _r1_meet_public_tests.pre(324) = 'application_terminal', _r1_meet_public_tests.pre(324));

  -- 3. mapping_unavailable: paused, archived, none; also before a DSAR hold.
  perform _r1_meet_public_tests.candidate(326, true, 'paused');
  perform _r1_meet_public_tests.assert('T2-B a paused mapping: mapping_unavailable',
    _r1_meet_public_tests.pre(326) = 'mapping_unavailable', _r1_meet_public_tests.pre(326));
  perform _r1_meet_public_tests.candidate(327, true, 'archived');
  perform _r1_meet_public_tests.assert('T2-B an archived mapping: mapping_unavailable',
    _r1_meet_public_tests.pre(327) = 'mapping_unavailable', _r1_meet_public_tests.pre(327));
  perform _r1_meet_public_tests.candidate(328, true, null);
  perform _r1_meet_public_tests.assert('T2-B a link without a mapping: mapping_unavailable',
    _r1_meet_public_tests.pre(328) = 'mapping_unavailable', _r1_meet_public_tests.pre(328));
  insert into screening_v2.data_subject_requests (candidate_id, request_type, requested_by)
  values (_r1_meet_public_tests.id(10, 328), 'restrict', _r1_meet_public_tests.id(1, 1));
  perform _r1_meet_public_tests.assert('T2-B no mapping and a DSAR hold: mapping_unavailable first',
    _r1_meet_public_tests.pre(328) = 'mapping_unavailable', _r1_meet_public_tests.pre(328));

  -- 4. dsar_hold (the 0130 predicate), also before a decision-use block.
  perform _r1_meet_public_tests.candidate(329);
  insert into screening_v2.data_subject_requests (candidate_id, request_type, requested_by)
  values (_r1_meet_public_tests.id(10, 329), 'delete', _r1_meet_public_tests.id(1, 1));
  perform _r1_meet_public_tests.assert('T2-B a pending delete request: dsar_hold',
    _r1_meet_public_tests.pre(329) = 'dsar_hold', _r1_meet_public_tests.pre(329));
  update screening_v2.candidates set decision_use_blocked_at = '2026-12-01 03:00:00+00'
   where id = _r1_meet_public_tests.id(10, 329);
  perform _r1_meet_public_tests.assert('T2-B a DSAR hold and a decision-use block: dsar_hold first',
    _r1_meet_public_tests.pre(329) = 'dsar_hold', _r1_meet_public_tests.pre(329));
  perform _r1_meet_public_tests.candidate(330);
  insert into screening_v2.data_subject_requests (candidate_id, request_type, requested_by)
  values (_r1_meet_public_tests.id(10, 330), 'export', _r1_meet_public_tests.id(1, 1));
  insert into screening_v2.data_subject_requests (candidate_id, request_type, requested_by, request_status, rejection_reason)
  values (_r1_meet_public_tests.id(10, 330), 'delete', _r1_meet_public_tests.id(1, 1), 'rejected', 'fixture');
  perform _r1_meet_public_tests.assert('T2-B an export request and a rejected delete hold nothing: eligible',
    _r1_meet_public_tests.pre(330) = 'eligible', _r1_meet_public_tests.pre(330));

  -- 5. candidate_ineligible.
  perform _r1_meet_public_tests.candidate(331);
  update screening_v2.candidates set decision_use_blocked_at = '2026-12-01 03:00:00+00'
   where id = _r1_meet_public_tests.id(10, 331);
  perform _r1_meet_public_tests.assert('T2-B a decision-use block: candidate_ineligible',
    _r1_meet_public_tests.pre(331) = 'candidate_ineligible', _r1_meet_public_tests.pre(331));

  -- 6. already_booked.
  perform _r1_meet_public_tests.candidate(332);
  perform _r1_meet_public_tests.round(332);
  perform _r1_meet_public_tests.public_booking(332);
  perform _r1_meet_public_tests.assert('T2-B a live public booking (its Meet round has a live booking): already_booked',
    _r1_meet_public_tests.pre(332) = 'already_booked', _r1_meet_public_tests.pre(332));
  perform _r1_meet_public_tests.candidate(333);
  perform _r1_meet_public_tests.ashby_booking(333, jsonb_build_object('status', 'blocked', 'reason', 'not_scheduled',
    'candidate_id', _r1_meet_public_tests.id(10, 333)));
  perform _r1_meet_public_tests.assert('T2-B a live Ashby booking (blocked, no round): already_booked',
    _r1_meet_public_tests.pre(333) = 'already_booked', _r1_meet_public_tests.pre(333));
  perform _r1_meet_public_tests.candidate(334);
  perform _r1_meet_public_tests.round(334, 'invited', 'browser', '2026-12-05 00:00:00+00');
  perform _r1_meet_public_tests.assert('T2-B a live browser round: already_booked',
    _r1_meet_public_tests.pre(334) = 'already_booked', _r1_meet_public_tests.pre(334));
  perform _r1_meet_public_tests.candidate(335);
  perform _r1_meet_public_tests.round(335, 'invited', 'browser', '2026-11-30 00:00:00+00');
  perform _r1_meet_public_tests.assert('T2-B a lapsed browser round: already_booked',
    _r1_meet_public_tests.pre(335) = 'already_booked', _r1_meet_public_tests.pre(335));
  perform _r1_meet_public_tests.candidate(336);
  r := _r1_meet_public_tests.round(336, 'in_progress', 'meet', '2026-11-30 00:00:00+00');
  update screening_v2.interview_rounds set starts_used = 1 where id = r;
  perform _r1_meet_public_tests.assert('T2-B an in-progress lapsed Meet round: already_booked',
    _r1_meet_public_tests.pre(336) = 'already_booked', _r1_meet_public_tests.pre(336));
  perform _r1_meet_public_tests.candidate(337);
  r := _r1_meet_public_tests.round(337);
  perform _r1_meet_public_tests.session(337, r);
  perform _r1_meet_public_tests.assert('T2-B a Meet round with a live session: already_booked',
    _r1_meet_public_tests.pre(337) = 'already_booked', _r1_meet_public_tests.pre(337));
  perform _r1_meet_public_tests.candidate(338);
  r := _r1_meet_public_tests.round(338);
  update screening_v2.interview_rounds set attempts_counted = 2 where id = r;
  perform _r1_meet_public_tests.assert('T2-B a Meet round with no attempt left: already_booked',
    _r1_meet_public_tests.pre(338) = 'already_booked', _r1_meet_public_tests.pre(338));
  perform _r1_meet_public_tests.candidate(345);
  r := _r1_meet_public_tests.round(345);
  update screening_v2.interview_rounds set starts_used = 3 where id = r;
  perform _r1_meet_public_tests.assert('T2-B a Meet round with no start left: already_booked',
    _r1_meet_public_tests.pre(345) = 'already_booked', _r1_meet_public_tests.pre(345));
  perform _r1_meet_public_tests.candidate(339);
  perform _r1_meet_public_tests.round_of(1339, 339, 'completed');
  perform _r1_meet_public_tests.round(339);
  perform _r1_meet_public_tests.public_booking(339);
  perform _r1_meet_public_tests.assert('T2-B a live booking and a completed round: already_booked first',
    _r1_meet_public_tests.pre(339) = 'already_booked', _r1_meet_public_tests.pre(339));

  -- Eligible: a Meet round the create would re-link, or expire first.
  perform _r1_meet_public_tests.candidate(340);
  perform _r1_meet_public_tests.round(340);
  perform _r1_meet_public_tests.assert('T2-B a reusable Meet round (live, no booking, no session): eligible',
    _r1_meet_public_tests.pre(340) = 'eligible', _r1_meet_public_tests.pre(340));
  perform _r1_meet_public_tests.candidate(341);
  res := screening_v2.r1_meet_create_round_from_ashby(
    _r1_meet_public_tests.id(20, 341), _r1_meet_public_tests.id(21, 341)::text,
    _r1_meet_public_tests.id(22, 341)::text, null, null, _r1_meet_public_tests.id(25, 1)::text,
    '2026-11-30 09:00:00+00', '2026-11-30 09:00:05+00', 'https://meet.google.com/abc-defg-hij',
    '2026-12-02 05:00:00+00', '2026-12-02 05:45:00+00', _r1_meet_public_tests.id(1, 1),
    'r1_dex_sales', 7200, p_now);
  perform _r1_meet_public_tests.assert('T2-B fixture: HR booked Dex in Ashby (0142 created the round and the booking)',
    res ->> 'status' = 'created', res::text);
  perform _r1_meet_public_tests.assert('T2-B ... so the candidate is already_booked',
    _r1_meet_public_tests.pre(341) = 'already_booked', _r1_meet_public_tests.pre(341));
  res := screening_v2.r1_meet_cancel_booking((res ->> 'booking_id')::uuid, 'cancelled', p_now);
  perform _r1_meet_public_tests.assert('T2-B ... HR cancels that booking (round, consent untouched), and the candidate is eligible',
    res ->> 'status' = 'ok' and _r1_meet_public_tests.pre(341) = 'eligible', res::text);
  perform _r1_meet_public_tests.candidate(342);
  perform _r1_meet_public_tests.round(342, 'invited', 'meet', '2026-11-30 00:00:00+00');
  perform _r1_meet_public_tests.assert('T2-B an expirable lapsed Meet round (unstarted, unused): eligible',
    _r1_meet_public_tests.pre(342) = 'eligible', _r1_meet_public_tests.pre(342));
  perform _r1_meet_public_tests.candidate(343);
  r := _r1_meet_public_tests.round(343);
  update screening_v2.interview_rounds set attempts_counted = 1, starts_used = 1 where id = r;
  perform _r1_meet_public_tests.assert('T2-B the round HR grant-retake leaves (invited, 1 of 2 attempts, 1 start): eligible',
    _r1_meet_public_tests.pre(343) = 'eligible', _r1_meet_public_tests.pre(343));

  -- 7. r1_completed: a completed round and nothing to re-link (no public retake).
  perform _r1_meet_public_tests.candidate(346);
  perform _r1_meet_public_tests.round(346, 'completed');
  perform _r1_meet_public_tests.assert('T2-B a completed R1 and no live round: r1_completed',
    _r1_meet_public_tests.pre(346) = 'r1_completed', _r1_meet_public_tests.pre(346));
  perform _r1_meet_public_tests.candidate(347);
  perform _r1_meet_public_tests.round_of(1347, 347, 'completed');
  perform _r1_meet_public_tests.round(347, 'invited', 'meet', '2026-11-30 00:00:00+00');
  perform _r1_meet_public_tests.assert('T2-B a completed R1 and an expirable lapsed round: r1_completed',
    _r1_meet_public_tests.pre(347) = 'r1_completed', _r1_meet_public_tests.pre(347));
  perform _r1_meet_public_tests.candidate(348);
  perform _r1_meet_public_tests.round_of(1348, 348, 'completed');
  perform _r1_meet_public_tests.round(348);
  perform _r1_meet_public_tests.assert('T2-B a completed R1 and a reusable Meet round: eligible (the round is re-linked)',
    _r1_meet_public_tests.pre(348) = 'eligible', _r1_meet_public_tests.pre(348));
  update screening_v2.r1_settings set paused = true where singleton;
  perform _r1_meet_public_tests.assert('T2-B a completed R1 while paused: r1_completed first',
    _r1_meet_public_tests.pre(346) = 'r1_completed', _r1_meet_public_tests.pre(346));
  update screening_v2.r1_settings set paused = false where singleton;

  -- 8. phone_engagement_active (the 0128 predicate); a terminal engagement holds nothing.
  perform _r1_meet_public_tests.candidate(349);
  insert into screening_v2.phone_engagements (application_link_id, candidate_id, role_id, state)
  select x.id, x.candidate_id, _r1_meet_public_tests.id(2, 1), 'pending_prereqs'
    from screening_v2.ashby_application_links x
   where x.provider = 'ashby' and x.external_application_id = _r1_meet_public_tests.id(22, 349)::text;
  perform _r1_meet_public_tests.assert('T2-B a live phone engagement: phone_engagement_active',
    _r1_meet_public_tests.pre(349) = 'phone_engagement_active', _r1_meet_public_tests.pre(349));
  insert into screening_v2.roles (id, title, interview_kind)
  values (_r1_meet_public_tests.id(2, 3), 'R1 Meet public assertion second role', 'sales_r1');
  perform _r1_meet_public_tests.assert('T2-B a live phone engagement and two sales_r1 roles: phone_engagement_active first',
    _r1_meet_public_tests.pre(349) = 'phone_engagement_active', _r1_meet_public_tests.pre(349));
  update screening_v2.roles set interview_kind = null where id = _r1_meet_public_tests.id(2, 3);
  perform _r1_meet_public_tests.candidate(350);
  select x.id into v_link from screening_v2.ashby_application_links x
   where x.provider = 'ashby' and x.external_application_id = _r1_meet_public_tests.id(22, 350)::text;
  insert into screening_v2.phone_engagements (application_link_id, candidate_id, role_id, state, terminal_at)
  values (v_link, _r1_meet_public_tests.id(10, 350), _r1_meet_public_tests.id(2, 1), 'completed',
          '2026-11-30 00:00:00+00');
  perform _r1_meet_public_tests.assert('T2-B a completed phone engagement: eligible',
    _r1_meet_public_tests.pre(350) = 'eligible', _r1_meet_public_tests.pre(350));

  -- 9. phone_assessment_pending (the 0128 predicate); a settled job holds nothing.
  perform _r1_meet_public_tests.candidate(351);
  insert into screening_v2.call_sessions (id, candidate_id, role_id, mode, provider, external_call_id, status)
  values (_r1_meet_public_tests.id(12, 351), _r1_meet_public_tests.id(10, 351), _r1_meet_public_tests.id(2, 1),
          'live', 'livekit', 'phone-' || _r1_meet_public_tests.id(12, 351)::text, 'created');
  insert into screening_v2.job_queue (name, payload)
  values ('phone.assessment', jsonb_build_object('session_id', _r1_meet_public_tests.id(12, 351)));
  perform _r1_meet_public_tests.assert('T2-B a pending phone assessment: phone_assessment_pending',
    _r1_meet_public_tests.pre(351) = 'phone_assessment_pending', _r1_meet_public_tests.pre(351));
  perform _r1_meet_public_tests.candidate(352);
  insert into screening_v2.call_sessions (id, candidate_id, role_id, mode, provider, external_call_id, status)
  values (_r1_meet_public_tests.id(12, 352), _r1_meet_public_tests.id(10, 352), _r1_meet_public_tests.id(2, 1),
          'live', 'livekit', 'phone-' || _r1_meet_public_tests.id(12, 352)::text, 'created');
  insert into screening_v2.job_queue (name, payload, status)
  values ('phone.assessment', jsonb_build_object('session_id', _r1_meet_public_tests.id(12, 352)), 'completed');
  perform _r1_meet_public_tests.assert('T2-B a completed phone assessment job: eligible',
    _r1_meet_public_tests.pre(352) = 'eligible', _r1_meet_public_tests.pre(352));

  -- 10. role_not_configured: two sales_r1 roles, or none.
  perform _r1_meet_public_tests.candidate(353);
  update screening_v2.roles set interview_kind = 'sales_r1' where id = _r1_meet_public_tests.id(2, 3);
  perform _r1_meet_public_tests.assert('T2-B two sales_r1 roles: role_not_configured',
    _r1_meet_public_tests.pre(353) = 'role_not_configured', _r1_meet_public_tests.pre(353));
  update screening_v2.roles set interview_kind = null where id = _r1_meet_public_tests.id(2, 3);
  update screening_v2.roles set interview_kind = null where id = _r1_meet_public_tests.id(2, 1);
  perform _r1_meet_public_tests.assert('T2-B no sales_r1 role: role_not_configured',
    _r1_meet_public_tests.pre(353) = 'role_not_configured', _r1_meet_public_tests.pre(353));
  update screening_v2.roles set interview_kind = 'sales_r1' where id = _r1_meet_public_tests.id(2, 1);
  perform _r1_meet_public_tests.assert('T2-B one sales_r1 role again: eligible',
    _r1_meet_public_tests.pre(353) = 'eligible', _r1_meet_public_tests.pre(353));

  -- 11. consent_template_unavailable.
  perform _r1_meet_public_tests.candidate(354);
  res := _r1_meet_public_tests.under_release('zzz-meet-public-assert-newer', 'en-GB', '["ai_interview"]'::jsonb,
    format('select screening_v2.r1_meet_public_precheck(%L, %L, %L)', _r1_meet_public_tests.id(10, 354),
           _r1_meet_public_tests.id(22, 354)::text, p_now));
  perform _r1_meet_public_tests.assert('T2-B the newest release has no en-IN notice: consent_template_unavailable',
    res = '{"status": "refused", "code": "consent_template_unavailable"}'::jsonb, res::text);
  res := _r1_meet_public_tests.under_release('zzz-meet-public-assert-newer', 'en-IN', '[]'::jsonb,
    format('select screening_v2.r1_meet_public_precheck(%L, %L, %L)', _r1_meet_public_tests.id(10, 354),
           _r1_meet_public_tests.id(22, 354)::text, p_now));
  perform _r1_meet_public_tests.assert('T2-B the newest en-IN notice requires nothing: consent_template_unavailable',
    res = '{"status": "refused", "code": "consent_template_unavailable"}'::jsonb, res::text);
  perform _r1_meet_public_tests.assert('T2-B with our notice the newest again: eligible',
    _r1_meet_public_tests.pre(354) = 'eligible', _r1_meet_public_tests.pre(354));
  perform _r1_meet_public_tests.candidate(355);
  r := _r1_meet_public_tests.round(355);
  update screening_v2.interview_rounds set consent_locale = 'en-IN-x-staff' where id = r;
  perform _r1_meet_public_tests.assert('T2-B a reusable round for the staff audience with no staff notice: consent_template_unavailable',
    _r1_meet_public_tests.pre(355) = 'consent_template_unavailable', _r1_meet_public_tests.pre(355));

  -- 12-13. disabled, paused (disabled first).
  perform _r1_meet_public_tests.candidate(356);
  update screening_v2.r1_settings set enabled = false, paused = true where singleton;
  perform _r1_meet_public_tests.assert('T2-B R1 disabled (and paused): disabled',
    _r1_meet_public_tests.pre(356) = 'disabled', _r1_meet_public_tests.pre(356));
  update screening_v2.r1_settings set enabled = true where singleton;
  perform _r1_meet_public_tests.assert('T2-B R1 paused: paused',
    _r1_meet_public_tests.pre(356) = 'paused', _r1_meet_public_tests.pre(356));
  update screening_v2.r1_settings set paused = false where singleton;

  -- 14. capacity_exhausted, skipped when a round is re-linked (no new hold).
  perform _r1_meet_public_tests.candidate(357);
  update screening_v2.r1_settings set monthly_cap_minutes = 65 where singleton;
  perform _r1_meet_public_tests.assert('T2-B capacity fixture: a 65-minute hold is outstanding',
    exists (select 1 from screening_v2.interview_rounds x
             where x.held_minutes > 0 and x.status in ('invited', 'in_progress') and x.expires_at > p_now));
  perform _r1_meet_public_tests.assert('T2-B a 65-minute cap with a hold outstanding: capacity_exhausted',
    _r1_meet_public_tests.pre(357) = 'capacity_exhausted', _r1_meet_public_tests.pre(357));
  perform _r1_meet_public_tests.assert('T2-B the same cap with a reusable Meet round: eligible',
    _r1_meet_public_tests.pre(340) = 'eligible' and _r1_meet_public_tests.pre(341) = 'eligible',
    _r1_meet_public_tests.pre(340) || ' ' || _r1_meet_public_tests.pre(341));
  perform _r1_meet_public_tests.assert('T2-B the same cap with an expirable round only: capacity_exhausted',
    _r1_meet_public_tests.pre(342) = 'capacity_exhausted', _r1_meet_public_tests.pre(342));
  update screening_v2.r1_settings set monthly_cap_minutes = 100000 where singleton;
  perform _r1_meet_public_tests.assert('T2-B the cap restored: eligible',
    _r1_meet_public_tests.pre(357) = 'eligible', _r1_meet_public_tests.pre(357));
end;
$$;

-- T2-B (continued): the precheck writes nothing; every T2-B candidate checked again changes nothing.
do $$
declare
  v_before jsonb := _r1_meet_public_tests.counts();
  v_codes text := '';
  n integer;
begin
  for n in 320..357 loop
    v_codes := v_codes || ' ' || _r1_meet_public_tests.pre(n);
  end loop;
  perform _r1_meet_public_tests.assert('T2-B the precheck writes nothing (bookings, rounds, consents, jobs, months, throttle)',
    _r1_meet_public_tests.counts() = v_before, v_codes);
end;
$$;

-- =============================================================================================
-- T2-C. r1_meet_public_set_manage_digest (§16).
-- =============================================================================================
do $$
declare
  p_now constant timestamptz := '2026-12-01 04:00:00+00';
  d1 text := _r1_meet_public_tests.digest('t2c-1');
  d2 text := _r1_meet_public_tests.digest('t2c-2');
  b uuid;
  b2 uuid;
  res jsonb;
begin
  perform _r1_meet_public_tests.candidate(380, false);
  perform _r1_meet_public_tests.round(380);
  b := _r1_meet_public_tests.public_booking(380);
  res := screening_v2.r1_meet_public_set_manage_digest(b, d1, p_now);
  perform _r1_meet_public_tests.assert('T2-C a live public booking takes a digest: ok',
    res = '{"status": "ok"}'::jsonb
    and (select x.manage_token_digest = d1 from screening_v2.r1_meet_bookings x where x.id = b), res::text);
  res := screening_v2.r1_meet_public_set_manage_digest(b, d2, p_now + interval '1 hour');
  perform _r1_meet_public_tests.assert('T2-C a new digest rotates the old one out',
    res = '{"status": "ok"}'::jsonb
    and (select x.manage_token_digest = d2 from screening_v2.r1_meet_bookings x where x.id = b)
    and not exists (select 1 from screening_v2.r1_meet_bookings x where x.manage_token_digest = d1), res::text);
  perform _r1_meet_public_tests.assert('T2-C setting the digest leaves updated_at and the status alone',
    (select x.updated_at = '2026-12-01 04:00:00+00' and x.status = 'pending'
       from screening_v2.r1_meet_bookings x where x.id = b));

  res := screening_v2.r1_meet_public_set_manage_digest(_r1_meet_public_tests.id(40, 389), d1, p_now);
  perform _r1_meet_public_tests.assert('T2-C an unknown booking: not_found',
    res = '{"status": "not_found"}'::jsonb, res::text);
  b2 := _r1_meet_public_tests.ashby_booking(381);
  res := screening_v2.r1_meet_public_set_manage_digest(b2, d1, p_now);
  perform _r1_meet_public_tests.assert('T2-C an Ashby booking: not_public',
    res = '{"status": "not_public"}'::jsonb
    and (select x.manage_token_digest is null from screening_v2.r1_meet_bookings x where x.id = b2), res::text);
  b2 := _r1_meet_public_tests.public_booking(382, _r1_meet_public_tests.unbound());
  res := screening_v2.r1_meet_public_set_manage_digest(b2, d1, p_now);
  perform _r1_meet_public_tests.assert('T2-C a cancelled public booking: booking_terminal',
    res = '{"status": "booking_terminal"}'::jsonb, res::text);
  b2 := _r1_meet_public_tests.public_booking(384, _r1_meet_public_tests.unbound()
    || '{"status": "failed", "reason": "invite_undeliverable"}'::jsonb);
  res := screening_v2.r1_meet_public_set_manage_digest(b2, d1, p_now);
  perform _r1_meet_public_tests.assert('T2-C a failed public booking: booking_terminal',
    res = '{"status": "booking_terminal"}'::jsonb, res::text);

  res := screening_v2.r1_meet_public_set_manage_digest(b, upper(d1), p_now);
  perform _r1_meet_public_tests.assert('T2-C an upper-case digest: invalid_request digest',
    res = '{"status": "invalid_request", "field": "digest"}'::jsonb, res::text);
  res := screening_v2.r1_meet_public_set_manage_digest(b, left(d1, 63), p_now);
  perform _r1_meet_public_tests.assert('T2-C a 63-character digest: invalid_request digest',
    res = '{"status": "invalid_request", "field": "digest"}'::jsonb, res::text);
  res := screening_v2.r1_meet_public_set_manage_digest(b, null, p_now);
  perform _r1_meet_public_tests.assert('T2-C a NULL digest: invalid_request digest',
    res = '{"status": "invalid_request", "field": "digest"}'::jsonb, res::text);
  res := screening_v2.r1_meet_public_set_manage_digest(null, null, p_now);
  perform _r1_meet_public_tests.assert('T2-C a NULL booking id (and digest): invalid_request booking_id',
    res = '{"status": "invalid_request", "field": "booking_id"}'::jsonb, res::text);
  res := screening_v2.r1_meet_public_set_manage_digest(b, d1, null);
  perform _r1_meet_public_tests.assert('T2-C a NULL now: invalid_request now',
    res = '{"status": "invalid_request", "field": "now"}'::jsonb, res::text);
  perform _r1_meet_public_tests.assert('T2-C no refusal changed the digest',
    (select x.manage_token_digest = d2 from screening_v2.r1_meet_bookings x where x.id = b));

  perform _r1_meet_public_tests.candidate(383, false);
  perform _r1_meet_public_tests.round(383);
  b2 := _r1_meet_public_tests.public_booking(383);
  perform _r1_meet_public_tests.raises('T2-C a digest another booking holds',
    format('select screening_v2.r1_meet_public_set_manage_digest(%L, %L, %L)', b2, d2, p_now), '23505');
end;
$$;

-- =============================================================================================
-- T2-D. r1_meet_public_manage_read (§17).
-- =============================================================================================
do $$
declare
  p_now constant timestamptz := '2026-12-01 04:00:00+00';
  d text := _r1_meet_public_tests.digest('t2d-390');
  d391 text := _r1_meet_public_tests.digest('t2d-391');
  d392 text := _r1_meet_public_tests.digest('t2d-392');
  d394 text := _r1_meet_public_tests.digest('t2d-394');
  b uuid;
  r uuid;
  ab uuid;
  res jsonb;
begin
  perform _r1_meet_public_tests.candidate(390, false);
  r := _r1_meet_public_tests.round(390);
  b := _r1_meet_public_tests.public_booking(390);
  perform _r1_meet_public_tests.consent(r);
  perform screening_v2.r1_meet_public_set_manage_digest(b, d, p_now);

  res := screening_v2.r1_meet_public_manage_read(d, 3600, 2, p_now);
  perform _r1_meet_public_tests.assert('T2-D the full ok answer of a pending booking with a current consent',
    res = jsonb_build_object('status', 'ok', 'booking_id', b, 'booking_status', 'pending', 'version', 0,
                             'has_bot', false, 'start_at', '2026-12-02 05:00:00+00'::timestamptz,
                             'end_at', '2026-12-02 05:45:00+00'::timestamptz, 'can_move', true,
                             'can_cancel', true, 'moves_left', 2, 'consent_current', true), res::text);
  res := screening_v2.r1_meet_public_manage_read(d, 3600, 2, '2026-12-02 03:59:59+00');
  perform _r1_meet_public_tests.assert('T2-D one second before start - cutoff: can_move and can_cancel',
    (res -> 'can_move') = 'true'::jsonb and (res -> 'can_cancel') = 'true'::jsonb, res::text);
  res := screening_v2.r1_meet_public_manage_read(d, 3600, 2, '2026-12-02 04:00:00+00');
  perform _r1_meet_public_tests.assert('T2-D at start - cutoff: neither can_move nor can_cancel',
    res ->> 'status' = 'ok' and (res -> 'can_move') = 'false'::jsonb and (res -> 'can_cancel') = 'false'::jsonb,
    res::text);
  res := screening_v2.r1_meet_public_manage_read(d, 900, 2, '2026-12-02 04:00:00+00');
  perform _r1_meet_public_tests.assert('T2-D the same instant with a 15-minute cutoff: both again',
    (res -> 'can_move') = 'true'::jsonb and (res -> 'can_cancel') = 'true'::jsonb, res::text);

  update screening_v2.r1_meet_bookings set move_count = 2 where id = b;
  res := screening_v2.r1_meet_public_manage_read(d, 3600, 2, p_now);
  perform _r1_meet_public_tests.assert('T2-D move_count at the limit: can_move false, moves_left 0, can_cancel still',
    (res -> 'can_move') = 'false'::jsonb and (res -> 'moves_left') = '0'::jsonb
    and (res -> 'can_cancel') = 'true'::jsonb, res::text);
  res := screening_v2.r1_meet_public_manage_read(d, 3600, 1, p_now);
  perform _r1_meet_public_tests.assert('T2-D moves_left floors at 0 when the limit is below move_count',
    (res -> 'moves_left') = '0'::jsonb and (res -> 'can_move') = 'false'::jsonb, res::text);
  res := screening_v2.r1_meet_public_manage_read(d, 3600, 5, p_now);
  perform _r1_meet_public_tests.assert('T2-D a higher limit: moves_left 3, can_move',
    (res -> 'moves_left') = '3'::jsonb and (res -> 'can_move') = 'true'::jsonb, res::text);
  update screening_v2.r1_meet_bookings set move_count = 0 where id = b;

  -- A dispatched bot: neither move nor cancel; an undispatched bot: both.
  perform _r1_meet_public_tests.candidate(391, false);
  r := _r1_meet_public_tests.round(391);
  perform _r1_meet_public_tests.public_booking(391, jsonb_build_object(
    'status', 'bot_joining', 'recall_bot_id', _r1_meet_public_tests.id(30, 391), 'manage_token_digest', d391));
  res := screening_v2.r1_meet_public_manage_read(d391, 3600, 2, p_now);
  perform _r1_meet_public_tests.assert('T2-D bot_joining: has_bot, neither can_move nor can_cancel',
    res ->> 'booking_status' = 'bot_joining' and (res -> 'has_bot') = 'true'::jsonb
    and (res -> 'can_move') = 'false'::jsonb and (res -> 'can_cancel') = 'false'::jsonb, res::text);
  perform _r1_meet_public_tests.assert('T2-D no consent on the round: consent_current false',
    (res -> 'consent_current') = 'false'::jsonb, res::text);
  perform _r1_meet_public_tests.consent(r, '2026-12-01 05:00:00+00');
  res := screening_v2.r1_meet_public_manage_read(d391, 3600, 2, p_now);
  perform _r1_meet_public_tests.assert('T2-D a consent granted after now: consent_current false',
    (res -> 'consent_current') = 'false'::jsonb, res::text);
  res := screening_v2.r1_meet_public_manage_read(d391, 3600, 2, '2026-12-01 05:00:00+00');
  perform _r1_meet_public_tests.assert('T2-D ... and true once now reaches its grant',
    (res -> 'consent_current') = 'true'::jsonb, res::text);
  perform _r1_meet_public_tests.candidate(392, false);
  perform _r1_meet_public_tests.round(392);
  perform _r1_meet_public_tests.public_booking(392, jsonb_build_object(
    'status', 'bot_scheduled', 'recall_bot_id', _r1_meet_public_tests.id(30, 392), 'manage_token_digest', d392));
  res := screening_v2.r1_meet_public_manage_read(d392, 3600, 2, p_now);
  perform _r1_meet_public_tests.assert('T2-D bot_scheduled: has_bot, can_move and can_cancel',
    res ->> 'booking_status' = 'bot_scheduled' and (res -> 'has_bot') = 'true'::jsonb
    and (res -> 'can_move') = 'true'::jsonb and (res -> 'can_cancel') = 'true'::jsonb, res::text);

  -- consent_current follows admission: a newer release, then a withdrawal.
  res := _r1_meet_public_tests.under_release('zzz-meet-public-assert-newer', 'en-IN', '["ai_interview"]'::jsonb,
    format('select screening_v2.r1_meet_public_manage_read(%L, 3600, 2, %L)', d, p_now));
  perform _r1_meet_public_tests.assert('T2-D a newer active release: consent_current false (the rest unchanged)',
    res ->> 'status' = 'ok' and (res -> 'consent_current') = 'false'::jsonb
    and (res -> 'can_move') = 'true'::jsonb, res::text);
  res := screening_v2.r1_meet_public_manage_read(d, 3600, 2, p_now);
  perform _r1_meet_public_tests.assert('T2-D with our release the newest again: consent_current true',
    (res -> 'consent_current') = 'true'::jsonb, res::text);
  perform screening_v2.r1_withdraw_consent(_r1_meet_public_tests.id(11, 390), '{}'::jsonb, p_now, 'withdrawn');
  res := screening_v2.r1_meet_public_manage_read(d, 3600, 2, p_now);
  perform _r1_meet_public_tests.assert('T2-D after a withdrawal: consent_current false',
    res ->> 'status' = 'ok' and (res -> 'consent_current') = 'false'::jsonb, res::text);

  -- not_found: unknown, terminal, slot ended, and an Ashby row (the source filter).
  res := screening_v2.r1_meet_public_manage_read(_r1_meet_public_tests.digest('t2d-unknown'), 3600, 2, p_now);
  perform _r1_meet_public_tests.assert('T2-D an unknown digest: not_found',
    res = '{"status": "not_found"}'::jsonb, res::text);
  perform _r1_meet_public_tests.public_booking(393, _r1_meet_public_tests.unbound()
    || jsonb_build_object('manage_token_digest', _r1_meet_public_tests.digest('t2d-393')));
  res := screening_v2.r1_meet_public_manage_read(_r1_meet_public_tests.digest('t2d-393'), 3600, 2, p_now);
  perform _r1_meet_public_tests.assert('T2-D a terminal booking: not_found',
    res = '{"status": "not_found"}'::jsonb, res::text);
  res := screening_v2.r1_meet_public_manage_read(d, 3600, 2, '2026-12-02 05:44:59+00');
  perform _r1_meet_public_tests.assert('T2-D one second before the slot ends: ok',
    res ->> 'status' = 'ok', res::text);
  res := screening_v2.r1_meet_public_manage_read(d, 3600, 2, '2026-12-02 05:45:00+00');
  perform _r1_meet_public_tests.assert('T2-D at the slot end: not_found',
    res = '{"status": "not_found"}'::jsonb, res::text);
  ab := _r1_meet_public_tests.ashby_booking(394, '{"status": "blocked", "reason": "not_scheduled"}'::jsonb);
  res := _r1_meet_public_tests.in_rollback(array[
      'alter table screening_v2.r1_meet_bookings drop constraint chk_r1_meet_bookings_public_columns',
      format('update screening_v2.r1_meet_bookings set manage_token_digest = %L where id = %L', d394, ab)],
    format('select jsonb_build_object(''read'', screening_v2.r1_meet_public_manage_read(%L, 3600, 2, %L), '
           '''held'', (select x.manage_token_digest = %L from screening_v2.r1_meet_bookings x where x.id = %L))',
           d394, p_now, d394, ab));
  perform _r1_meet_public_tests.assert('T2-D a live Ashby booking holding the digest (CHECK lifted, rolled back): not_found',
    res = '{"read": {"status": "not_found"}, "held": true}'::jsonb, res::text);
  perform _r1_meet_public_tests.assert('T2-D ... and the public-columns CHECK is back',
    exists (select 1 from pg_constraint x
             where x.conrelid = 'screening_v2.r1_meet_bookings'::regclass
               and x.conname = 'chk_r1_meet_bookings_public_columns' and x.convalidated));

  -- The fields.
  res := screening_v2.r1_meet_public_manage_read(null, 3600, 2, p_now);
  perform _r1_meet_public_tests.assert('T2-D a NULL digest: invalid_request digest',
    res = '{"status": "invalid_request", "field": "digest"}'::jsonb, res::text);
  res := screening_v2.r1_meet_public_manage_read(upper(d), 3600, 2, p_now);
  perform _r1_meet_public_tests.assert('T2-D an upper-case digest: invalid_request digest',
    res = '{"status": "invalid_request", "field": "digest"}'::jsonb, res::text);
  res := screening_v2.r1_meet_public_manage_read(d, 899, 2, p_now);
  perform _r1_meet_public_tests.assert('T2-D a cutoff of 899 s: invalid_request cutoff',
    res = '{"status": "invalid_request", "field": "cutoff"}'::jsonb, res::text);
  res := screening_v2.r1_meet_public_manage_read(d, 43201, 2, p_now);
  perform _r1_meet_public_tests.assert('T2-D a cutoff of 43201 s: invalid_request cutoff',
    res = '{"status": "invalid_request", "field": "cutoff"}'::jsonb, res::text);
  res := screening_v2.r1_meet_public_manage_read(d, null, 2, p_now);
  perform _r1_meet_public_tests.assert('T2-D a NULL cutoff: invalid_request cutoff',
    res = '{"status": "invalid_request", "field": "cutoff"}'::jsonb, res::text);
  res := screening_v2.r1_meet_public_manage_read(d, 43200, 0, p_now);
  perform _r1_meet_public_tests.assert('T2-D cutoff 43200 s and max_moves 0 are accepted (no move left)',
    res ->> 'status' = 'ok' and (res -> 'moves_left') = '0'::jsonb and (res -> 'can_move') = 'false'::jsonb,
    res::text);
  res := screening_v2.r1_meet_public_manage_read(d, 3600, -1, p_now);
  perform _r1_meet_public_tests.assert('T2-D max_moves -1: invalid_request max_moves',
    res = '{"status": "invalid_request", "field": "max_moves"}'::jsonb, res::text);
  res := screening_v2.r1_meet_public_manage_read(d, 3600, 11, p_now);
  perform _r1_meet_public_tests.assert('T2-D max_moves 11: invalid_request max_moves',
    res = '{"status": "invalid_request", "field": "max_moves"}'::jsonb, res::text);
  res := screening_v2.r1_meet_public_manage_read(d, 3600, null, p_now);
  perform _r1_meet_public_tests.assert('T2-D a NULL max_moves: invalid_request max_moves',
    res = '{"status": "invalid_request", "field": "max_moves"}'::jsonb, res::text);
  res := screening_v2.r1_meet_public_manage_read(d, 3600, 2, null);
  perform _r1_meet_public_tests.assert('T2-D a NULL now: invalid_request now',
    res = '{"status": "invalid_request", "field": "now"}'::jsonb, res::text);
end;
$$;

-- =============================================================================================
-- T2-E. r1_meet_public_set_calendar_state (§21).
-- =============================================================================================
do $$
declare
  p_now constant timestamptz := '2026-12-01 04:00:00+00';
  b uuid;
  b2 uuid;
  res jsonb;
begin
  perform _r1_meet_public_tests.candidate(400, false);
  perform _r1_meet_public_tests.round(400);
  b := _r1_meet_public_tests.public_booking(400);
  res := screening_v2.r1_meet_public_set_calendar_state(b, array['created'], 'invited', p_now);
  perform _r1_meet_public_tests.assert('T2-E created -> invited: ok, invite_sent_at = now',
    res = '{"status": "ok", "calendar_state": "invited"}'::jsonb
    and (select x.calendar_state = 'invited' and x.invite_sent_at = p_now
           from screening_v2.r1_meet_bookings x where x.id = b), res::text);
  res := screening_v2.r1_meet_public_set_calendar_state(b, array['created', 'invited'], 'invited',
                                                         p_now + interval '1 hour');
  perform _r1_meet_public_tests.assert('T2-E invited -> invited (a re-send) keeps the first invite time',
    res = '{"status": "ok", "calendar_state": "invited"}'::jsonb
    and (select x.invite_sent_at = p_now from screening_v2.r1_meet_bookings x where x.id = b), res::text);
  res := screening_v2.r1_meet_public_set_calendar_state(b, array['invited'], 'cancelled', p_now);
  perform _r1_meet_public_tests.assert('T2-E invited -> cancelled: ok, the invite time kept',
    res = '{"status": "ok", "calendar_state": "cancelled"}'::jsonb
    and (select x.calendar_state = 'cancelled' and x.invite_sent_at = p_now
           from screening_v2.r1_meet_bookings x where x.id = b), res::text);
  res := screening_v2.r1_meet_public_set_calendar_state(b, array['cancelled'], 'purged', p_now);
  perform _r1_meet_public_tests.assert('T2-E cancelled -> purged: ok',
    res = '{"status": "ok", "calendar_state": "purged"}'::jsonb, res::text);
  res := screening_v2.r1_meet_public_set_calendar_state(b, array['created', 'invited'], 'invited', p_now);
  perform _r1_meet_public_tests.assert('T2-E a purged event is not invited again: state_conflict (+current)',
    res = '{"status": "state_conflict", "current": "purged"}'::jsonb, res::text);
  res := screening_v2.r1_meet_public_set_calendar_state(b, array['created', 'invited', 'cancelled'], 'purged', p_now);
  perform _r1_meet_public_tests.assert('T2-E purged -> purged: state_conflict',
    res = '{"status": "state_conflict", "current": "purged"}'::jsonb, res::text);
  perform _r1_meet_public_tests.assert('T2-E the calendar moves left updated_at, the status and the jobs alone',
    (select x.updated_at = '2026-12-01 04:00:00+00' and x.status = 'pending' and x.reason = 'eligible'
       from screening_v2.r1_meet_bookings x where x.id = b)
    and _r1_meet_public_tests.jobs_of(b) = '[]'::jsonb, _r1_meet_public_tests.jobs_of(b)::text);

  b2 := _r1_meet_public_tests.public_booking(401, _r1_meet_public_tests.blocked());
  res := screening_v2.r1_meet_public_set_calendar_state(b2, array['created'], 'cancelled', p_now);
  perform _r1_meet_public_tests.assert('T2-E created -> cancelled: ok, no invite time',
    res = '{"status": "ok", "calendar_state": "cancelled"}'::jsonb
    and (select x.invite_sent_at is null from screening_v2.r1_meet_bookings x where x.id = b2), res::text);
  b2 := _r1_meet_public_tests.public_booking(402, _r1_meet_public_tests.blocked());
  res := screening_v2.r1_meet_public_set_calendar_state(b2, array['created'], 'purged', p_now);
  perform _r1_meet_public_tests.assert('T2-E created -> purged: ok',
    res = '{"status": "ok", "calendar_state": "purged"}'::jsonb, res::text);
  b2 := _r1_meet_public_tests.public_booking(403, _r1_meet_public_tests.blocked());
  perform screening_v2.r1_meet_public_set_calendar_state(b2, array['created'], 'invited', p_now);
  res := screening_v2.r1_meet_public_set_calendar_state(b2, array['invited'], 'purged', p_now);
  perform _r1_meet_public_tests.assert('T2-E invited -> purged: ok',
    res = '{"status": "ok", "calendar_state": "purged"}'::jsonb, res::text);
  b2 := _r1_meet_public_tests.public_booking(404, _r1_meet_public_tests.blocked());
  res := screening_v2.r1_meet_public_set_calendar_state(b2, array['invited'], 'cancelled', p_now);
  perform _r1_meet_public_tests.assert('T2-E an expected state that is not the current one: state_conflict created',
    res = '{"status": "state_conflict", "current": "created"}'::jsonb
    and (select x.calendar_state = 'created' from screening_v2.r1_meet_bookings x where x.id = b2), res::text);

  b2 := _r1_meet_public_tests.ashby_booking(405);
  res := screening_v2.r1_meet_public_set_calendar_state(b2, array['created'], 'invited', p_now);
  perform _r1_meet_public_tests.assert('T2-E an Ashby booking: not_public',
    res = '{"status": "not_public"}'::jsonb, res::text);
  res := screening_v2.r1_meet_public_set_calendar_state(_r1_meet_public_tests.id(40, 409), array['created'],
                                                         'invited', p_now);
  perform _r1_meet_public_tests.assert('T2-E an unknown booking: not_found',
    res = '{"status": "not_found"}'::jsonb, res::text);

  -- The fields: to, then from (closed, one-dimensional, 1..3, each a legal source of to).
  b2 := _r1_meet_public_tests.id(40, 404);
  res := screening_v2.r1_meet_public_set_calendar_state(b2, array['created'], 'created', p_now);
  perform _r1_meet_public_tests.assert('T2-E to created: invalid_request to',
    res = '{"status": "invalid_request", "field": "to"}'::jsonb, res::text);
  res := screening_v2.r1_meet_public_set_calendar_state(b2, array['created'], 'bogus', p_now);
  perform _r1_meet_public_tests.assert('T2-E to bogus: invalid_request to',
    res = '{"status": "invalid_request", "field": "to"}'::jsonb, res::text);
  res := screening_v2.r1_meet_public_set_calendar_state(b2, '{}'::text[], null, p_now);
  perform _r1_meet_public_tests.assert('T2-E a NULL to (and an empty from): invalid_request to',
    res = '{"status": "invalid_request", "field": "to"}'::jsonb, res::text);
  res := screening_v2.r1_meet_public_set_calendar_state(b2, '{}'::text[], 'invited', p_now);
  perform _r1_meet_public_tests.assert('T2-E an empty from: invalid_request from',
    res = '{"status": "invalid_request", "field": "from"}'::jsonb, res::text);
  res := screening_v2.r1_meet_public_set_calendar_state(b2, null, 'invited', p_now);
  perform _r1_meet_public_tests.assert('T2-E a NULL from: invalid_request from',
    res = '{"status": "invalid_request", "field": "from"}'::jsonb, res::text);
  res := screening_v2.r1_meet_public_set_calendar_state(b2, array['created', null], 'invited', p_now);
  perform _r1_meet_public_tests.assert('T2-E a NULL element in from: invalid_request from',
    res = '{"status": "invalid_request", "field": "from"}'::jsonb, res::text);
  res := screening_v2.r1_meet_public_set_calendar_state(b2, array['purged'], 'purged', p_now);
  perform _r1_meet_public_tests.assert('T2-E purged as a source: invalid_request from',
    res = '{"status": "invalid_request", "field": "from"}'::jsonb, res::text);
  res := screening_v2.r1_meet_public_set_calendar_state(b2, array['cancelled'], 'invited', p_now);
  perform _r1_meet_public_tests.assert('T2-E cancelled as a source of invited: invalid_request from',
    res = '{"status": "invalid_request", "field": "from"}'::jsonb, res::text);
  res := screening_v2.r1_meet_public_set_calendar_state(b2, array['cancelled'], 'cancelled', p_now);
  perform _r1_meet_public_tests.assert('T2-E cancelled as a source of cancelled: invalid_request from',
    res = '{"status": "invalid_request", "field": "from"}'::jsonb, res::text);
  res := screening_v2.r1_meet_public_set_calendar_state(b2, array[['created'], ['invited']], 'invited', p_now);
  perform _r1_meet_public_tests.assert('T2-E a two-dimensional from: invalid_request from',
    res = '{"status": "invalid_request", "field": "from"}'::jsonb, res::text);
  res := screening_v2.r1_meet_public_set_calendar_state(b2, array['created', 'invited', 'cancelled', 'created'],
                                                         'purged', p_now);
  perform _r1_meet_public_tests.assert('T2-E four sources: invalid_request from',
    res = '{"status": "invalid_request", "field": "from"}'::jsonb, res::text);
  res := screening_v2.r1_meet_public_set_calendar_state(null, array['created'], 'invited', p_now);
  perform _r1_meet_public_tests.assert('T2-E a NULL booking id: invalid_request booking_id',
    res = '{"status": "invalid_request", "field": "booking_id"}'::jsonb, res::text);
  res := screening_v2.r1_meet_public_set_calendar_state(b2, array['created'], 'invited', null);
  perform _r1_meet_public_tests.assert('T2-E a NULL now: invalid_request now',
    res = '{"status": "invalid_request", "field": "now"}'::jsonb, res::text);
  perform _r1_meet_public_tests.assert('T2-E no refusal changed the event state',
    (select x.calendar_state = 'created' and x.invite_sent_at is null
       from screening_v2.r1_meet_bookings x where x.id = b2));
end;
$$;

-- =============================================================================================
-- T2-F. r1_meet_public_throttle_hit (§22).
-- =============================================================================================
do $$
declare
  k1 text := _r1_meet_public_tests.digest('t2f-1');
  k2 text := _r1_meet_public_tests.digest('t2f-2');
  k3 text := _r1_meet_public_tests.digest('t2f-3');
  k4 text := _r1_meet_public_tests.digest('t2f-4');
  k5 text := _r1_meet_public_tests.digest('t2f-5');
  k6 text := _r1_meet_public_tests.digest('t2f-6');
  k7 text := _r1_meet_public_tests.digest('t2f-7');
  nine text[];
  v_before jsonb := _r1_meet_public_tests.counts();
  res jsonb;
begin
  -- One key, a 60-second window: the bucket is p_now floored to the minute.
  res := screening_v2.r1_meet_public_throttle_hit(array[k1], array[2], 60, '2026-12-01 04:00:37+00');
  perform _r1_meet_public_tests.assert('T2-F the first hit: ok, nothing over, one hit in the floored bucket',
    res = '{"status": "ok", "over": []}'::jsonb and _r1_meet_public_tests.hits(k1, '2026-12-01 04:00:00+00') = 1,
    res::text);
  res := screening_v2.r1_meet_public_throttle_hit(array[k1], array[2], 60, '2026-12-01 04:00:50+00');
  perform _r1_meet_public_tests.assert('T2-F the second hit in the same window shares the row (2 = the limit, not over)',
    res = '{"status": "ok", "over": []}'::jsonb and _r1_meet_public_tests.hits(k1, '2026-12-01 04:00:00+00') = 2,
    res::text);
  res := screening_v2.r1_meet_public_throttle_hit(array[k1], array[2], 60, '2026-12-01 04:00:59.999+00');
  perform _r1_meet_public_tests.assert('T2-F the third hit exceeds the limit: over [0]',
    res = '{"status": "ok", "over": [0]}'::jsonb and _r1_meet_public_tests.hits(k1, '2026-12-01 04:00:00+00') = 3,
    res::text);
  res := screening_v2.r1_meet_public_throttle_hit(array[k1], array[2], 60, '2026-12-01 04:01:00+00');
  perform _r1_meet_public_tests.assert('T2-F the next window is a new row',
    res = '{"status": "ok", "over": []}'::jsonb and _r1_meet_public_tests.hits(k1, '2026-12-01 04:01:00+00') = 1
    and (select count(*) = 2 from screening_v2.r1_meet_public_throttle x where x.key_digest = k1), res::text);

  -- Several keys, an hour window, keys out of order: the indexes are the caller's.
  res := screening_v2.r1_meet_public_throttle_hit(array[k3, k2], array[5, 1], 3600, '2026-12-01 04:59:59+00');
  perform _r1_meet_public_tests.assert('T2-F two keys, a 3600 s window: both rows in the 04:00 bucket, nothing over',
    res = '{"status": "ok", "over": []}'::jsonb
    and _r1_meet_public_tests.hits(k2, '2026-12-01 04:00:00+00') = 1
    and _r1_meet_public_tests.hits(k3, '2026-12-01 04:00:00+00') = 1, res::text);
  res := screening_v2.r1_meet_public_throttle_hit(array[k3, k2], array[5, 1], 3600, '2026-12-01 04:30:00+00');
  perform _r1_meet_public_tests.assert('T2-F the second key over its limit: over [1]',
    res = '{"status": "ok", "over": [1]}'::jsonb, res::text);
  perform screening_v2.r1_meet_public_throttle_hit(array[k4, k5, k6], array[1, 1, 1], 60, '2026-12-01 04:00:00+00');
  res := screening_v2.r1_meet_public_throttle_hit(array[k6, k4, k5], array[1, 2, 1], 60, '2026-12-01 04:00:10+00');
  perform _r1_meet_public_tests.assert('T2-F exact over indexes, ascending: [0, 2]',
    res = '{"status": "ok", "over": [0, 2]}'::jsonb, res::text);
  res := screening_v2.r1_meet_public_throttle_hit(array[k1], array[100000], 86400, '2026-12-01 23:59:59+00');
  perform _r1_meet_public_tests.assert('T2-F a 86400 s window floors to the UTC day; limit 100000 accepted',
    res = '{"status": "ok", "over": []}'::jsonb and _r1_meet_public_tests.hits(k1, '2026-12-01 00:00:00+00') = 1,
    res::text);
  insert into screening_v2.r1_meet_public_throttle (key_digest, bucket_start, hits)
  values (k7, '2026-12-01 04:00:00+00', 1000000000);
  res := screening_v2.r1_meet_public_throttle_hit(array[k7], array[100000], 60, '2026-12-01 04:00:00+00');
  perform _r1_meet_public_tests.assert('T2-F hits are capped at 1000000000',
    res = '{"status": "ok", "over": [0]}'::jsonb
    and _r1_meet_public_tests.hits(k7, '2026-12-01 04:00:00+00') = 1000000000, res::text);
  perform _r1_meet_public_tests.assert('T2-F the hits wrote the throttle table only',
    (_r1_meet_public_tests.counts() - 'throttle') = (v_before - 'throttle'));

  -- The fields: keys, limits, window, now (first refusal wins).
  select array_agg(_r1_meet_public_tests.digest('t2f-nine-' || n)) into nine from generate_series(1, 9) n;
  v_before := _r1_meet_public_tests.counts();
  res := screening_v2.r1_meet_public_throttle_hit(null, array[1], 60, '2026-12-01 04:00:00+00');
  perform _r1_meet_public_tests.assert('T2-F NULL keys: refused (field keys)',
    res = '{"status": "invalid_request", "field": "keys"}'::jsonb, res::text);
  res := screening_v2.r1_meet_public_throttle_hit('{}'::text[], '{}'::integer[], 60, '2026-12-01 04:00:00+00');
  perform _r1_meet_public_tests.assert('T2-F no key: refused (field keys)',
    res = '{"status": "invalid_request", "field": "keys"}'::jsonb, res::text);
  res := screening_v2.r1_meet_public_throttle_hit(nine, array[1, 1, 1, 1, 1, 1, 1, 1, 1], 60, '2026-12-01 04:00:00+00');
  perform _r1_meet_public_tests.assert('T2-F nine keys: refused (field keys)',
    res = '{"status": "invalid_request", "field": "keys"}'::jsonb, res::text);
  res := screening_v2.r1_meet_public_throttle_hit(nine[1:8], array[1, 1, 1, 1, 1, 1, 1, 1], 60, '2026-12-01 04:00:00+00');
  perform _r1_meet_public_tests.assert('T2-F eight keys are accepted',
    res = '{"status": "ok", "over": []}'::jsonb, res::text);
  v_before := _r1_meet_public_tests.counts();
  res := screening_v2.r1_meet_public_throttle_hit(array[k1, null], array[1, 1], 60, '2026-12-01 04:00:00+00');
  perform _r1_meet_public_tests.assert('T2-F a NULL key: refused (field keys)',
    res = '{"status": "invalid_request", "field": "keys"}'::jsonb, res::text);
  res := screening_v2.r1_meet_public_throttle_hit(array[upper(k1)], array[1], 60, '2026-12-01 04:00:00+00');
  perform _r1_meet_public_tests.assert('T2-F an upper-case key: refused (field keys)',
    res = '{"status": "invalid_request", "field": "keys"}'::jsonb, res::text);
  res := screening_v2.r1_meet_public_throttle_hit(array[left(k1, 63)], array[1], 60, '2026-12-01 04:00:00+00');
  perform _r1_meet_public_tests.assert('T2-F a 63-character key: refused (field keys)',
    res = '{"status": "invalid_request", "field": "keys"}'::jsonb, res::text);
  res := screening_v2.r1_meet_public_throttle_hit(array[k1, k1], array[1, 1], 60, '2026-12-01 04:00:00+00');
  perform _r1_meet_public_tests.assert('T2-F duplicate keys: refused (field keys)',
    res = '{"status": "invalid_request", "field": "keys"}'::jsonb, res::text);
  res := screening_v2.r1_meet_public_throttle_hit(array[[k1], [k2]], array[1, 1], 60, '2026-12-01 04:00:00+00');
  perform _r1_meet_public_tests.assert('T2-F two-dimensional keys: refused (field keys)',
    res = '{"status": "invalid_request", "field": "keys"}'::jsonb, res::text);
  res := screening_v2.r1_meet_public_throttle_hit(array[k1, k1], array[1, 1], 59, '2026-12-01 04:00:00+00');
  perform _r1_meet_public_tests.assert('T2-F bad keys and a bad window: keys first',
    res = '{"status": "invalid_request", "field": "keys"}'::jsonb, res::text);
  res := screening_v2.r1_meet_public_throttle_hit(array[k1], null, 60, '2026-12-01 04:00:00+00');
  perform _r1_meet_public_tests.assert('T2-F NULL limits: invalid_request limits',
    res = '{"status": "invalid_request", "field": "limits"}'::jsonb, res::text);
  res := screening_v2.r1_meet_public_throttle_hit(array[k1], array[1, 2], 60, '2026-12-01 04:00:00+00');
  perform _r1_meet_public_tests.assert('T2-F more limits than keys: refused (field limits)',
    res = '{"status": "invalid_request", "field": "limits"}'::jsonb, res::text);
  res := screening_v2.r1_meet_public_throttle_hit(array[k1], array[0], 60, '2026-12-01 04:00:00+00');
  perform _r1_meet_public_tests.assert('T2-F a limit of 0: invalid_request limits',
    res = '{"status": "invalid_request", "field": "limits"}'::jsonb, res::text);
  res := screening_v2.r1_meet_public_throttle_hit(array[k1], array[100001], 60, '2026-12-01 04:00:00+00');
  perform _r1_meet_public_tests.assert('T2-F a limit of 100001: invalid_request limits',
    res = '{"status": "invalid_request", "field": "limits"}'::jsonb, res::text);
  res := screening_v2.r1_meet_public_throttle_hit(array[k1], array[null::integer], 60, '2026-12-01 04:00:00+00');
  perform _r1_meet_public_tests.assert('T2-F a NULL limit: invalid_request limits',
    res = '{"status": "invalid_request", "field": "limits"}'::jsonb, res::text);
  res := screening_v2.r1_meet_public_throttle_hit(array[k1], array[[1]], 60, '2026-12-01 04:00:00+00');
  perform _r1_meet_public_tests.assert('T2-F two-dimensional limits: invalid_request limits',
    res = '{"status": "invalid_request", "field": "limits"}'::jsonb, res::text);
  res := screening_v2.r1_meet_public_throttle_hit(array[k1], array[1], 59, '2026-12-01 04:00:00+00');
  perform _r1_meet_public_tests.assert('T2-F a 59 s window: invalid_request window',
    res = '{"status": "invalid_request", "field": "window"}'::jsonb, res::text);
  res := screening_v2.r1_meet_public_throttle_hit(array[k1], array[1], 86401, '2026-12-01 04:00:00+00');
  perform _r1_meet_public_tests.assert('T2-F a 86401 s window: invalid_request window',
    res = '{"status": "invalid_request", "field": "window"}'::jsonb, res::text);
  res := screening_v2.r1_meet_public_throttle_hit(array[k1], array[1], null, '2026-12-01 04:00:00+00');
  perform _r1_meet_public_tests.assert('T2-F a NULL window: invalid_request window',
    res = '{"status": "invalid_request", "field": "window"}'::jsonb, res::text);
  res := screening_v2.r1_meet_public_throttle_hit(array[k1], array[1], 60, null);
  perform _r1_meet_public_tests.assert('T2-F a NULL now: invalid_request now',
    res = '{"status": "invalid_request", "field": "now"}'::jsonb, res::text);
  perform _r1_meet_public_tests.assert('T2-F no refusal wrote anything',
    _r1_meet_public_tests.counts() = v_before);
end;
$$;

-- =============================================================================================
-- T2-G. r1_meet_public_throttle_prune (§23).
-- =============================================================================================
do $$
declare
  p_now constant timestamptz := '2026-12-01 04:00:00+00';
  c_30d constant integer := 2592000;
  res jsonb;
begin
  insert into screening_v2.r1_meet_public_throttle (key_digest, bucket_start, hits)
  values (_r1_meet_public_tests.digest('t2g-1'), '2026-10-01 00:00:00+00', 1),
         (_r1_meet_public_tests.digest('t2g-2'), '2026-10-02 00:00:00+00', 1),
         (_r1_meet_public_tests.digest('t2g-3'), '2026-10-03 00:00:00+00', 1),
         (_r1_meet_public_tests.digest('t2g-4'), '2026-11-15 00:00:00+00', 1);
  perform _r1_meet_public_tests.assert('T2-G fixture: exactly our three rows are older than 30 days',
    (select count(*) = 3 from screening_v2.r1_meet_public_throttle x
      where x.bucket_start < p_now - interval '30 days'));

  res := screening_v2.r1_meet_public_throttle_prune(3599, 10, p_now);
  perform _r1_meet_public_tests.assert('T2-G an age under one hour: invalid_request older_than',
    res = '{"status": "invalid_request", "field": "older_than"}'::jsonb, res::text);
  res := screening_v2.r1_meet_public_throttle_prune(31536001, 10, p_now);
  perform _r1_meet_public_tests.assert('T2-G an age over 365 days: invalid_request older_than',
    res = '{"status": "invalid_request", "field": "older_than"}'::jsonb, res::text);
  res := screening_v2.r1_meet_public_throttle_prune(null, 10, p_now);
  perform _r1_meet_public_tests.assert('T2-G a NULL age: invalid_request older_than',
    res = '{"status": "invalid_request", "field": "older_than"}'::jsonb, res::text);
  res := screening_v2.r1_meet_public_throttle_prune(c_30d, 0, p_now);
  perform _r1_meet_public_tests.assert('T2-G a limit of 0: invalid_request limit',
    res = '{"status": "invalid_request", "field": "limit"}'::jsonb, res::text);
  res := screening_v2.r1_meet_public_throttle_prune(c_30d, 5001, p_now);
  perform _r1_meet_public_tests.assert('T2-G a limit of 5001: invalid_request limit',
    res = '{"status": "invalid_request", "field": "limit"}'::jsonb, res::text);
  res := screening_v2.r1_meet_public_throttle_prune(c_30d, null, p_now);
  perform _r1_meet_public_tests.assert('T2-G a NULL limit: invalid_request limit',
    res = '{"status": "invalid_request", "field": "limit"}'::jsonb, res::text);
  res := screening_v2.r1_meet_public_throttle_prune(c_30d, 10, null);
  perform _r1_meet_public_tests.assert('T2-G a NULL now: invalid_request now',
    res = '{"status": "invalid_request", "field": "now"}'::jsonb, res::text);
  perform _r1_meet_public_tests.assert('T2-G no refusal deleted anything',
    (select count(*) = 4 from screening_v2.r1_meet_public_throttle x
      where x.key_digest in (_r1_meet_public_tests.digest('t2g-1'), _r1_meet_public_tests.digest('t2g-2'),
                             _r1_meet_public_tests.digest('t2g-3'), _r1_meet_public_tests.digest('t2g-4'))));

  res := screening_v2.r1_meet_public_throttle_prune(31536000, 5000, p_now);
  perform _r1_meet_public_tests.assert('T2-G 365 days and a limit of 5000 are accepted (nothing that old)',
    res = '{"status": "ok", "deleted": 0}'::jsonb, res::text);
  res := screening_v2.r1_meet_public_throttle_prune(3600, 1, '2026-01-01 00:00:00+00');
  perform _r1_meet_public_tests.assert('T2-G one hour and a limit of 1 are accepted (nothing that old then)',
    res = '{"status": "ok", "deleted": 0}'::jsonb, res::text);
  res := screening_v2.r1_meet_public_throttle_prune(c_30d, 2, p_now);
  perform _r1_meet_public_tests.assert('T2-G a limit of 2 deletes the two oldest buckets only',
    res = '{"status": "ok", "deleted": 2}'::jsonb
    and not exists (select 1 from screening_v2.r1_meet_public_throttle x
                     where x.key_digest in (_r1_meet_public_tests.digest('t2g-1'), _r1_meet_public_tests.digest('t2g-2')))
    and exists (select 1 from screening_v2.r1_meet_public_throttle x
                 where x.key_digest = _r1_meet_public_tests.digest('t2g-3')), res::text);
  res := screening_v2.r1_meet_public_throttle_prune(c_30d, 5000, p_now);
  perform _r1_meet_public_tests.assert('T2-G the next call deletes the last old bucket and keeps the newer one',
    res = '{"status": "ok", "deleted": 1}'::jsonb
    and exists (select 1 from screening_v2.r1_meet_public_throttle x
                 where x.key_digest = _r1_meet_public_tests.digest('t2g-4')), res::text);
  res := screening_v2.r1_meet_public_throttle_prune(c_30d, 5000, p_now);
  perform _r1_meet_public_tests.assert('T2-G nothing left that old: deleted 0',
    res = '{"status": "ok", "deleted": 0}'::jsonb, res::text);
end;
$$;

-- =============================================================================================
-- T2-H. Catalog posture of the T2 functions.
-- =============================================================================================
do $$
declare
  fn record;
begin
  for fn in
    select * from (values
      ('screening_v2.r1_meet_public_capacity(timestamptz, timestamptz, timestamptz)', 's'),
      ('screening_v2.r1_meet_public_precheck(uuid, text, timestamptz)', 's'),
      ('screening_v2.r1_meet_public_set_manage_digest(uuid, text, timestamptz)', 'v'),
      ('screening_v2.r1_meet_public_manage_read(text, integer, integer, timestamptz)', 's'),
      ('screening_v2.r1_meet_public_set_calendar_state(uuid, text[], text, timestamptz)', 'v'),
      ('screening_v2.r1_meet_public_throttle_hit(text[], integer[], integer, timestamptz)', 'v'),
      ('screening_v2.r1_meet_public_throttle_prune(integer, integer, timestamptz)', 'v')
    ) v(sig, volatility)
  loop
    perform _r1_meet_public_tests.assert('T2-H ' || fn.sig || ' is security definer, ' || fn.volatility
                                         || ', search_path pg_catalog, screening_v2, returns jsonb',
      (select x.prosecdef and x.provolatile = fn.volatility
              and x.proconfig = array['search_path=pg_catalog, screening_v2']
              and x.prorettype = 'jsonb'::regtype
         from pg_proc x where x.oid = fn.sig::regprocedure));
    perform _r1_meet_public_tests.assert('T2-H ' || fn.sig || ' is executable by service_role only',
      has_function_privilege('service_role', fn.sig, 'execute')
      and not has_function_privilege('anon', fn.sig, 'execute')
      and not has_function_privilege('authenticated', fn.sig, 'execute')
      and not has_function_privilege('public', fn.sig, 'execute'));
  end loop;
  for fn in
    select * from (values
      ('screening_v2.r1_meet_public_slot_count(timestamptz, timestamptz, uuid)', 'integer'),
      ('screening_v2.r1_meet_public_day_count(date, uuid)', 'jsonb'),
      ('screening_v2.r1_meet_public_refusal(uuid, text, timestamptz)', 'text')
    ) v(sig, rettype)
  loop
    perform _r1_meet_public_tests.assert('T2-H ' || fn.sig || ' is an internal stable security invoker helper',
      (select not x.prosecdef and x.provolatile = 's'
              and x.proconfig = array['search_path=pg_catalog, screening_v2']
              and x.prorettype = fn.rettype::regtype
         from pg_proc x where x.oid = fn.sig::regprocedure));
    perform _r1_meet_public_tests.assert('T2-H ' || fn.sig || ' is executable by no API role, service_role included',
      not has_function_privilege('service_role', fn.sig, 'execute')
      and not has_function_privilege('anon', fn.sig, 'execute')
      and not has_function_privilege('authenticated', fn.sig, 'execute')
      and not has_function_privilege('public', fn.sig, 'execute'));
  end loop;
  perform _r1_meet_public_tests.raises_as('service_role', 'T2-H execute r1_meet_public_refusal',
    format('select screening_v2.r1_meet_public_refusal(%L, %L, %L)', _r1_meet_public_tests.id(10, 340),
           _r1_meet_public_tests.id(22, 340)::text, '2026-12-01 04:00:00+00'), '42501');
  -- The 0142 suite leaves the r1_meet_public_* names to this one (the T4 three included, in file
  -- order; T4-A, T4-B and T4-C check their posture).
  perform _r1_meet_public_tests.assert(
    'T2-H the screening_v2 functions named r1_meet_public_* are exactly these thirteen, one overload each',
    (select array_agg(x.oid order by x.oid) from pg_proc x
      where x.pronamespace = 'screening_v2'::regnamespace and x.proname like 'r1\_meet\_public\_%')
    = (select array_agg(f::regprocedure::oid order by f::regprocedure::oid) from unnest(array[
         'screening_v2.r1_meet_public_slot_count(timestamptz, timestamptz, uuid)',
         'screening_v2.r1_meet_public_day_count(date, uuid)',
         'screening_v2.r1_meet_public_refusal(uuid, text, timestamptz)',
         'screening_v2.r1_meet_public_capacity(timestamptz, timestamptz, timestamptz)',
         'screening_v2.r1_meet_public_precheck(uuid, text, timestamptz)',
         'screening_v2.r1_meet_public_set_manage_digest(uuid, text, timestamptz)',
         'screening_v2.r1_meet_public_manage_read(text, integer, integer, timestamptz)',
         'screening_v2.r1_meet_public_move_booking(uuid, text, integer, timestamptz, timestamptz, integer, integer, integer, integer, integer, integer, timestamptz)',
         'screening_v2.r1_meet_public_cancel_booking(text, boolean, integer, timestamptz)',
         'screening_v2.r1_meet_public_reconsent(text, jsonb, timestamptz)',
         'screening_v2.r1_meet_public_set_calendar_state(uuid, text[], text, timestamptz)',
         'screening_v2.r1_meet_public_throttle_hit(text[], integer[], integer, timestamptz)',
         'screening_v2.r1_meet_public_throttle_prune(integer, integer, timestamptz)']) f));
end;
$$;

-- =============================================================================================
-- T3 fixtures. Fixture numbers 500-599 (and 5001-5999 for a second booking or request id of
-- candidate n/10); p_now is 2026-12-01 04:00 UTC unless a call says otherwise. create(n) books
-- candidate n's application n into its own default slot slot_of(n): one hour apart, twelve per IST
-- day from 2026-12-03 09:00 IST, so no two default slots overlap and no IST day comes near the
-- default limits (20). T3-C counts on its own days (IST 2026-12-11 and 2026-12-12).
-- =============================================================================================

-- The default slot start of create(n).
create function _r1_meet_public_tests.slot_of(p_n integer) returns timestamptz
language sql stable as $$
  select '2026-12-03 03:30:00+00'::timestamptz
         + make_interval(days => (p_n - 500) / 12, hours => (p_n - 500) % 12)
$$;

-- The consent the form sends by default: our notice, every required consent, the India tick, a
-- TEST-NET-3 prefix and a fixture user agent.
create function _r1_meet_public_tests.form_consent() returns jsonb
language sql immutable as $$
  select '{"template_version": "zz-meet-public-assert-current",
           "consents": ["ai_interview", "video_audio_recording", "ai_evaluation", "data_processing"],
           "in_india": true, "ip_prefix": "203.0.113.0/24", "user_agent": "meet public assert"}'::jsonb
$$;

-- Calls the create RPC as S06 would: defaults for candidate n, overridden by p_args (a JSON null
-- is SQL NULL).
create function _r1_meet_public_tests.create(p_n integer, p_args jsonb default '{}'::jsonb)
returns jsonb language plpgsql as $$
declare
  a jsonb := jsonb_build_object(
    'booking_id', _r1_meet_public_tests.id(40, p_n),
    'request_id', _r1_meet_public_tests.id(41, p_n),
    'candidate_id', _r1_meet_public_tests.id(10, p_n),
    'application_id', _r1_meet_public_tests.id(22, p_n)::text,
    'meet_url', 'https://meet.google.com/abc-defg-hij',
    'start_at', _r1_meet_public_tests.slot_of(p_n),
    'end_at', _r1_meet_public_tests.slot_of(p_n) + interval '45 minutes',
    'created_by', _r1_meet_public_tests.id(1, 1),
    'consent', _r1_meet_public_tests.form_consent(),
    'seats', 2,
    'public_limit', 20,
    'bot_limit', 20,
    'profile', 'r1_dex_sales',
    'grace', 7200,
    'now', '2026-12-01T04:00:00+00:00') || p_args;
begin
  return screening_v2.r1_meet_create_round_from_public(
    (a ->> 'booking_id')::uuid, (a ->> 'request_id')::uuid, (a ->> 'candidate_id')::uuid,
    a ->> 'application_id', a ->> 'meet_url', (a ->> 'start_at')::timestamptz,
    (a ->> 'end_at')::timestamptz, (a ->> 'created_by')::uuid,
    nullif(a -> 'consent', 'null'::jsonb),
    (a ->> 'seats')::integer, (a ->> 'public_limit')::integer, (a ->> 'bot_limit')::integer,
    a ->> 'profile', (a ->> 'grace')::integer, (a ->> 'now')::timestamptz);
end;
$$;

-- An answer as one word: '<status>:<result, code or field>' ('replayed:' for a replay).
create function _r1_meet_public_tests.outcome(p_res jsonb) returns text
language sql immutable as $$
  select coalesce(p_res ->> 'status', 'null') || ':'
         || coalesce(p_res ->> 'result', p_res ->> 'code', p_res ->> 'field', '')
$$;

-- create(n, p_args) must answer p_outcome, and anything but booked must write nothing at all
-- (bookings, rounds, consents, jobs, budget months, throttle rows).
create function _r1_meet_public_tests.expect(p_label text, p_n integer, p_args jsonb, p_outcome text)
returns jsonb language plpgsql as $$
declare
  v_before jsonb := _r1_meet_public_tests.counts();
  v_res jsonb;
begin
  v_res := _r1_meet_public_tests.create(p_n, p_args);
  perform _r1_meet_public_tests.assert(p_label || ' answers ' || p_outcome,
    _r1_meet_public_tests.outcome(v_res) = p_outcome, v_res::text);
  if p_outcome not like 'booked:%' then
    perform _r1_meet_public_tests.assert(p_label || ' writes nothing',
      _r1_meet_public_tests.counts() = v_before, v_res::text);
  end if;
  return v_res;
end;
$$;

-- The minutes reserved in one budget month (0 when the month row does not exist).
create function _r1_meet_public_tests.reserved(p_month date) returns numeric
language sql stable as $$
  select coalesce(sum(x.minutes_reserved), 0) from screening_v2.r1_budget_month x
   where x.month_start = p_month
$$;

-- The three jobs a public create queues, in jobs_of order (ashby-tag, calendar, ensure-bot).
create function _r1_meet_public_tests.create_jobs(p_booking uuid) returns jsonb
language sql immutable as $$
  select jsonb_build_array(
    _r1_meet_public_tests.job(
      jsonb_build_object('kind', 'ashby_booked_tag', 'op', 'add', 'booking_id', p_booking),
      'r1-meet:ashby-tag:' || p_booking::text || ':add'),
    _r1_meet_public_tests.job(
      jsonb_build_object('kind', 'calendar_sync', 'op', 'invite', 'booking_id', p_booking),
      'r1-meet:calendar:' || p_booking::text || ':invite'),
    _r1_meet_public_tests.job(
      jsonb_build_object('kind', 'ensure_bot', 'booking_id', p_booking),
      'r1-meet:ensure-bot:' || p_booking::text))
$$;

-- The live consent of one round (NULL when there is none; the table allows at most one).
create function _r1_meet_public_tests.live_consent(p_round uuid) returns uuid
language sql stable as $$
  select x.id from screening_v2.interview_round_consents x
   where x.round_id = p_round and x.withdrawn_at is null
$$;

-- Whether consent row p_id is the candidate's own consent of the form: candidate_web, no
-- attestation, live, on template p_template with exactly its required set, granted at p_now, and
-- a proof of exactly the nine fields (the ip prefix and user agent as given, JSON null for NULL).
create function _r1_meet_public_tests.form_consent_ok(p_id uuid, p_template uuid, p_now timestamptz,
                                                      p_ip text default '203.0.113.0/24',
                                                      p_ua text default 'meet public assert')
returns boolean language sql stable as $$
  select x.method = 'candidate_web' and x.attested_by_external_id is null and x.attested_at is null
     and x.india_location_attested is null and x.withdrawn_at is null
     and x.template_id = p_template and x.consents = t.required_consents and x.granted_at = p_now
     and x.proof = jsonb_build_object(
       'decision', 'granted', 'captured_at', p_now, 'template_version', t.version,
       'locale', t.locale, 'ip_prefix', p_ip, 'user_agent', p_ua, 'source', 'r1_public_booking',
       'channel', 'meet', 'india_location_confirmed', true)
    from screening_v2.interview_round_consents x
    join screening_v2.interview_round_consent_templates t on t.id = x.template_id
   where x.id = p_id
$$;

-- =============================================================================================
-- T3-A. r1_meet_create_round_from_public (§15): the happy path.
-- =============================================================================================
do $$
declare
  p_now constant timestamptz := '2026-12-01 04:00:00+00';
  tpl constant uuid := _r1_meet_public_tests.id(3, 1);
  bid constant uuid := _r1_meet_public_tests.id(40, 500);
  s constant timestamptz := _r1_meet_public_tests.slot_of(500);
  c uuid;
  res jsonb;
  adm jsonb;
  b screening_v2.r1_meet_bookings%rowtype;
  r screening_v2.interview_rounds%rowtype;
  k uuid;
  reserved_before numeric;
begin
  c := _r1_meet_public_tests.candidate(500);
  reserved_before := _r1_meet_public_tests.reserved('2026-12-01');
  res := _r1_meet_public_tests.create(500);
  select * into b from screening_v2.r1_meet_bookings x where x.id = bid;
  select * into r from screening_v2.interview_rounds x where x.id = b.round_id;
  perform _r1_meet_public_tests.assert('T3-A a first eligible submit answers booked/created with exactly the contract fields',
    res = jsonb_build_object('status', 'booked', 'result', 'created', 'booking_id', bid,
                             'round_id', r.id, 'candidate_id', c, 'start_at', s,
                             'end_at', s + interval '45 minutes', 'version', 0, 'key_attempt', 0,
                             'round_expires_at', s + interval '45 minutes' + interval '7200 seconds'),
    res::text);
  perform _r1_meet_public_tests.assert(
    'T3-A the booking is public, pending/eligible, with no Ashby event, schedule or scheduler',
    b.source = 'public_page' and b.status = 'pending' and b.reason = 'eligible'
    and b.ashby_interview_event_id is null and b.ashby_schedule_id is null
    and b.ashby_scheduled_by_user_id is null and b.ashby_interview_stage_id is null
    and b.ashby_interview_id is null and b.ashby_updated_at is null
    and b.ashby_application_id = _r1_meet_public_tests.id(22, 500)::text
    and b.candidate_id = c and b.round_id = r.id and b.objective_profile = 'r1_dex_sales'
    and b.meet_url = 'https://meet.google.com/abc-defg-hij'
    and b.start_at = s and b.end_at = s + interval '45 minutes'
    and b.version = 0 and b.key_attempt = 0 and b.recall_bot_id is null
    and b.ticket_digest is null and b.ticket_arms = 0 and b.session_id is null
    and b.created_at = p_now and b.updated_at = p_now, to_jsonb(b)::text);
  perform _r1_meet_public_tests.assert(
    'T3-A the booking carries the event id pin, calendar created, its request id, no invite, no manage digest, no move',
    b.google_calendar_event_id = replace(bid::text, '-', '') and b.calendar_state = 'created'
    and b.invite_sent_at is null and b.public_request_id = _r1_meet_public_tests.id(41, 500)
    and b.manage_token_digest is null and b.move_count = 0, to_jsonb(b)::text);
  perform _r1_meet_public_tests.assert('T3-A the round is a Meet round created through r1_send_round',
    r.channel = 'meet' and r.status = 'invited' and r.kind = 'sales_r1'
    and r.role_id = _r1_meet_public_tests.id(2, 1) and r.candidate_id = c
    and r.created_by = _r1_meet_public_tests.id(1, 1)
    and r.candidate_status_at_send = (select x.status from screening_v2.candidates x where x.id = c)
    and r.consent_locale = 'en-IN' and r.starts_used = 0 and r.attempts_counted = 0
    and r.version = 1 and r.link_token_digest ~ '^[a-f0-9]{64}$', to_jsonb(r)::text);
  perform _r1_meet_public_tests.assert(
    'T3-A the round holds 65 minutes in the month of p_now and expires at slot end + 7200 s',
    r.held_minutes = 65 and r.hold_month = '2026-12-01'
    and _r1_meet_public_tests.reserved('2026-12-01') = reserved_before + 65
    and r.expires_at = s + interval '45 minutes' + interval '7200 seconds',
    format('held %s, month %s, reserved %s -> %s, expires %s', r.held_minutes, r.hold_month,
           reserved_before, _r1_meet_public_tests.reserved('2026-12-01'), r.expires_at));
  perform _r1_meet_public_tests.assert('T3-A the round has exactly one consent row, and it is live',
    (select count(*) = 1 from screening_v2.interview_round_consents x where x.round_id = r.id)
    and _r1_meet_public_tests.live_consent(r.id) is not null);
  k := _r1_meet_public_tests.live_consent(r.id);
  perform _r1_meet_public_tests.assert(
    'T3-A the consent is the candidate''s own: candidate_web, no attestation, our notice and its required set, the nine proof fields exactly',
    _r1_meet_public_tests.form_consent_ok(k, tpl, p_now),
    (select to_jsonb(x)::text from screening_v2.interview_round_consents x where x.id = k));
  perform _r1_meet_public_tests.assert(
    'T3-A the booking queues exactly the ensure_bot, calendar invite and Ashby tag add jobs',
    _r1_meet_public_tests.jobs_of(bid) = _r1_meet_public_tests.create_jobs(bid),
    _r1_meet_public_tests.jobs_of(bid)::text);
  perform _r1_meet_public_tests.assert('T3-A every job naming the booking is a pending r1-meet job',
    (select count(*) = 3 and bool_and(x.name = 'r1-meet' and x.status = 'pending')
       from screening_v2.job_queue x where x.payload ->> 'booking_id' = bid::text));
  perform _r1_meet_public_tests.assert('T3-A creating the round created no call session',
    not exists (select 1 from screening_v2.call_sessions x where x.interview_round_id = r.id));
  perform _r1_meet_public_tests.assert(
    'T3-A the answer carries no Meet URL, link digest, request id or calendar event id',
    position('meet.google.com' in res::text) = 0 and position(r.link_token_digest in res::text) = 0
    and position(_r1_meet_public_tests.id(41, 500)::text in res::text) = 0
    and position(b.google_calendar_event_id in res::text) = 0, res::text);
  perform _r1_meet_public_tests.assert('T3-A the precheck now answers already_booked',
    _r1_meet_public_tests.pre(500) = 'already_booked', _r1_meet_public_tests.pre(500));

  -- Admission accepts the candidate_web row unchanged. The answer must come from a check AFTER
  -- the consent gate (earlier suites may leave live R1 sessions, so `ok` alone would be flaky),
  -- and the same kind of round with its consent withdrawn must stop exactly at the gate.
  perform _r1_meet_public_tests.candidate(501);
  res := _r1_meet_public_tests.create(501);
  adm := screening_v2.r1_admit_attempt((res ->> 'round_id')::uuid, _r1_meet_public_tests.digest('nonce-501'),
                                       _r1_meet_public_tests.slot_of(501) + interval '1 minute');
  perform _r1_meet_public_tests.assert('T3-A admission passes the consent gate of a public Meet round',
    _r1_meet_public_tests.outcome(res) = 'booked:created'
    and adm ->> 'status' in ('ok', 'r1_in_flight', 'round_live', 'cloud_capacity_exhausted',
                             'capacity_exhausted'), adm::text);
  perform _r1_meet_public_tests.candidate(502);
  res := _r1_meet_public_tests.create(502);
  adm := screening_v2.r1_withdraw_consent((res ->> 'round_id')::uuid, '{}'::jsonb, p_now);
  perform _r1_meet_public_tests.assert('T3-A the candidate_web consent is withdrawn like any other',
    _r1_meet_public_tests.outcome(res) = 'booked:created' and adm ->> 'status' = 'ok', adm::text);
  adm := screening_v2.r1_admit_attempt((res ->> 'round_id')::uuid, _r1_meet_public_tests.digest('nonce-502'),
                                       _r1_meet_public_tests.slot_of(502) + interval '1 minute');
  perform _r1_meet_public_tests.assert(
    'T3-A admission refuses the round once its consent is withdrawn: consent_missing',
    adm ->> 'status' = 'consent_missing', adm::text);
end;
$$;

-- =============================================================================================
-- T3-B. Replay by request id, and the taken booking id.
-- =============================================================================================
do $$
declare
  s constant timestamptz := _r1_meet_public_tests.slot_of(503);
  res jsonb;
  v_before jsonb;
begin
  perform _r1_meet_public_tests.candidate(503);
  perform _r1_meet_public_tests.candidate(504);
  res := _r1_meet_public_tests.create(503);
  perform _r1_meet_public_tests.assert('T3-B fixture: candidate 503 books its slot',
    _r1_meet_public_tests.outcome(res) = 'booked:created', res::text);
  v_before := _r1_meet_public_tests.counts();
  res := _r1_meet_public_tests.create(503);
  perform _r1_meet_public_tests.assert(
    'T3-B the same submit again answers replayed with the booking and its slot, exactly',
    res = jsonb_build_object('status', 'replayed', 'booking_id', _r1_meet_public_tests.id(40, 503),
                             'start_at', s, 'end_at', s + interval '45 minutes'), res::text);
  res := _r1_meet_public_tests.create(503, jsonb_build_object(
    'booking_id', _r1_meet_public_tests.id(40, 5031), 'start_at', '2026-12-04T08:00:00+00:00',
    'end_at', '2026-12-04T08:30:00+00:00', 'now', '2026-12-01T05:00:00+00:00'));
  perform _r1_meet_public_tests.assert(
    'T3-B the same request id with another booking id and slot answers the first booking and slot',
    res = jsonb_build_object('status', 'replayed', 'booking_id', _r1_meet_public_tests.id(40, 503),
                             'start_at', s, 'end_at', s + interval '45 minutes'), res::text);
  res := _r1_meet_public_tests.create(503, jsonb_build_object('now', s + interval '10 minutes'));
  perform _r1_meet_public_tests.assert(
    'T3-B a replay after the slot started still answers replayed (the replay comes before in_past)',
    _r1_meet_public_tests.outcome(res) = 'replayed:', res::text);
  res := _r1_meet_public_tests.create(504, jsonb_build_object('request_id', _r1_meet_public_tests.id(41, 503)));
  perform _r1_meet_public_tests.assert('T3-B the same request id for another candidate: invalid_request request_id',
    res = '{"status": "invalid_request", "field": "request_id"}'::jsonb, res::text);
  res := _r1_meet_public_tests.create(503, jsonb_build_object(
    'application_id', _r1_meet_public_tests.id(22, 504)::text));
  perform _r1_meet_public_tests.assert('T3-B the same request id for another application: invalid_request request_id',
    res = '{"status": "invalid_request", "field": "request_id"}'::jsonb, res::text);
  res := _r1_meet_public_tests.create(504, jsonb_build_object('booking_id', _r1_meet_public_tests.id(40, 503)));
  perform _r1_meet_public_tests.assert(
    'T3-B a booking id already taken, with a new request id: invalid_request booking_id',
    res = '{"status": "invalid_request", "field": "booking_id"}'::jsonb, res::text);
  perform _r1_meet_public_tests.assert('T3-B the replays and the refusals wrote nothing',
    _r1_meet_public_tests.counts() = v_before);
  perform _r1_meet_public_tests.expect('T3-B candidate 504 with its own ids', 504, '{}'::jsonb, 'booked:created');
end;
$$;

-- =============================================================================================
-- T3-C. Slot and IST-day capacity under the day lock, at the limits.
-- =============================================================================================
do $$
declare
  s1 constant timestamptz := '2026-12-11 05:00:00+00';
  s2 constant timestamptz := '2026-12-11 07:00:00+00';
  s3 constant timestamptz := '2026-12-11 09:00:00+00';
  v_day jsonb;
begin
  -- One live public booking (blocked, no candidate) holds a seat of s1.
  perform _r1_meet_public_tests.public_booking(505, _r1_meet_public_tests.blocked() || _r1_meet_public_tests.slot(s1));
  perform _r1_meet_public_tests.candidate(506);
  perform _r1_meet_public_tests.expect('T3-C one seat and one live public booking in the slot', 506,
    jsonb_build_object('start_at', s1, 'end_at', s1 + interval '45 minutes', 'seats', 1), 'refused:slot_full');
  perform _r1_meet_public_tests.expect('T3-C one seat and a partly overlapping live booking', 506,
    jsonb_build_object('start_at', s1 + interval '30 minutes', 'end_at', s1 + interval '75 minutes', 'seats', 1),
    'refused:slot_full');
  perform _r1_meet_public_tests.expect('T3-C two seats and one live booking in the slot', 506,
    jsonb_build_object('start_at', s1, 'end_at', s1 + interval '45 minutes', 'seats', 2), 'booked:created');
  perform _r1_meet_public_tests.candidate(509);
  perform _r1_meet_public_tests.expect('T3-C two seats and two live bookings in the slot', 509,
    jsonb_build_object('start_at', s1, 'end_at', s1 + interval '45 minutes', 'seats', 2), 'refused:slot_full');

  -- A live Ashby booking holds a seat too; a slot that only touches it is free.
  perform _r1_meet_public_tests.ashby_booking(507, jsonb_build_object('status', 'blocked', 'reason', 'not_scheduled')
                                                  || _r1_meet_public_tests.slot(s2));
  perform _r1_meet_public_tests.candidate(508);
  perform _r1_meet_public_tests.expect('T3-C one seat and one live Ashby booking in the slot', 508,
    jsonb_build_object('start_at', s2, 'end_at', s2 + interval '45 minutes', 'seats', 1), 'refused:slot_full');
  perform _r1_meet_public_tests.expect('T3-C one seat and a slot that starts when the Ashby one ends', 508,
    jsonb_build_object('start_at', s2 + interval '45 minutes', 'end_at', s2 + interval '90 minutes', 'seats', 1),
    'booked:created');

  -- The IST day 2026-12-11: four live bookings, three of them public.
  v_day := screening_v2.r1_meet_public_day_count('2026-12-11', null);
  perform _r1_meet_public_tests.assert('T3-C fixture: IST 2026-12-11 counts total 4, public 3',
    v_day = '{"total": 4, "public": 3}'::jsonb, v_day::text);
  perform _r1_meet_public_tests.expect('T3-C the public count at the public day limit', 509,
    jsonb_build_object('start_at', s3, 'end_at', s3 + interval '45 minutes', 'public_limit', 3), 'refused:day_full');
  perform _r1_meet_public_tests.expect('T3-C the total at the bot day limit', 509,
    jsonb_build_object('start_at', s3, 'end_at', s3 + interval '45 minutes', 'public_limit', 4, 'bot_limit', 4),
    'refused:day_full');

  -- An Ashby booking that used a bot counts toward the total; a failure that never had one does not.
  perform _r1_meet_public_tests.candidate(510);
  perform _r1_meet_public_tests.round(510, 'completed');
  perform _r1_meet_public_tests.ashby_booking(510, jsonb_build_object(
    'status', 'completed', 'reason', 'attempt_settled', 'candidate_id', _r1_meet_public_tests.id(10, 510),
    'round_id', _r1_meet_public_tests.id(11, 510), 'recall_bot_id', _r1_meet_public_tests.id(30, 510))
    || _r1_meet_public_tests.slot('2026-12-11 10:00:00+00'));
  perform _r1_meet_public_tests.ashby_booking(511, jsonb_build_object('status', 'failed', 'reason', 'in_past')
                                                  || _r1_meet_public_tests.slot('2026-12-11 11:00:00+00'));
  v_day := screening_v2.r1_meet_public_day_count('2026-12-11', null);
  perform _r1_meet_public_tests.assert(
    'T3-C fixture: a completed Ashby booking with a bot counts, a failed/in_past one does not: total 5, public 3',
    v_day = '{"total": 5, "public": 3}'::jsonb, v_day::text);
  perform _r1_meet_public_tests.expect('T3-C the total (with the completed Ashby booking) at the bot day limit', 509,
    jsonb_build_object('start_at', s3, 'end_at', s3 + interval '45 minutes', 'public_limit', 4, 'bot_limit', 5),
    'refused:day_full');
  perform _r1_meet_public_tests.expect('T3-C one under both day limits', 509,
    jsonb_build_object('start_at', s3, 'end_at', s3 + interval '45 minutes', 'public_limit', 4, 'bot_limit', 6),
    'booked:created');

  -- Another IST day is counted on its own, by its IST date (00:00 IST is 18:30 UTC the day before).
  perform _r1_meet_public_tests.candidate(512);
  perform _r1_meet_public_tests.expect('T3-C IST 2026-12-12 with day limits of 1', 512,
    jsonb_build_object('start_at', '2026-12-12 05:00:00+00', 'end_at', '2026-12-12 05:45:00+00',
                       'public_limit', 1, 'bot_limit', 1), 'booked:created');
  perform _r1_meet_public_tests.candidate(560);
  perform _r1_meet_public_tests.expect(
    'T3-C a slot at 00:00 IST on 2026-12-12 (18:30 UTC on 2026-12-11) is counted on IST 2026-12-12', 560,
    jsonb_build_object('start_at', '2026-12-11 18:30:00+00', 'end_at', '2026-12-11 19:15:00+00',
                       'public_limit', 2, 'bot_limit', 2), 'booked:created');
end;
$$;

-- =============================================================================================
-- T3-D. Every precheck refusal reached through the create, nothing written.
-- =============================================================================================
do $$
declare
  res jsonb;
  v_before jsonb;
  n integer;
begin
  -- Fixtures first (each refusal below is checked to write nothing).
  perform _r1_meet_public_tests.candidate(513, false);
  perform _r1_meet_public_tests.candidate(514);
  update screening_v2.ashby_application_links set terminal_state = 'withdrawn'
   where provider = 'ashby' and external_application_id = _r1_meet_public_tests.id(22, 514)::text;
  perform _r1_meet_public_tests.candidate(515, true, 'paused');
  perform _r1_meet_public_tests.candidate(516);
  insert into screening_v2.data_subject_requests (candidate_id, request_type, requested_by)
  values (_r1_meet_public_tests.id(10, 516), 'delete', _r1_meet_public_tests.id(1, 1));
  perform _r1_meet_public_tests.candidate(517);
  update screening_v2.candidates set decision_use_blocked_at = '2026-12-01 03:00:00+00'
   where id = _r1_meet_public_tests.id(10, 517);
  perform _r1_meet_public_tests.candidate(518);
  perform _r1_meet_public_tests.round(518, 'invited', 'browser', '2026-12-10 00:00:00+00');
  perform _r1_meet_public_tests.candidate(519);
  perform _r1_meet_public_tests.round(519, 'completed');
  perform _r1_meet_public_tests.candidate(520);
  insert into screening_v2.phone_engagements (application_link_id, candidate_id, role_id, state)
  select x.id, x.candidate_id, _r1_meet_public_tests.id(2, 1), 'pending_prereqs'
    from screening_v2.ashby_application_links x
   where x.provider = 'ashby' and x.external_application_id = _r1_meet_public_tests.id(22, 520)::text;
  perform _r1_meet_public_tests.candidate(521);
  insert into screening_v2.call_sessions (id, candidate_id, role_id, mode, provider, external_call_id, status)
  values (_r1_meet_public_tests.id(12, 521), _r1_meet_public_tests.id(10, 521), _r1_meet_public_tests.id(2, 1),
          'live', 'livekit', 'phone-' || _r1_meet_public_tests.id(12, 521)::text, 'created');
  insert into screening_v2.job_queue (name, payload)
  values ('phone.assessment', jsonb_build_object('session_id', _r1_meet_public_tests.id(12, 521)));
  perform _r1_meet_public_tests.candidate(522);
  perform _r1_meet_public_tests.candidate(523);
  perform _r1_meet_public_tests.candidate(524, false);

  perform _r1_meet_public_tests.expect('T3-D no Ashby link', 513, '{}'::jsonb, 'refused:application_unknown');
  perform _r1_meet_public_tests.expect('T3-D a link bound to another candidate', 524,
    jsonb_build_object('application_id', _r1_meet_public_tests.id(22, 500)::text), 'refused:application_unknown');
  perform _r1_meet_public_tests.expect('T3-D a terminal link', 514, '{}'::jsonb, 'refused:application_terminal');
  perform _r1_meet_public_tests.expect('T3-D a paused mapping', 515, '{}'::jsonb, 'refused:mapping_unavailable');
  perform _r1_meet_public_tests.expect('T3-D a pending delete request', 516, '{}'::jsonb, 'refused:dsar_hold');
  perform _r1_meet_public_tests.expect('T3-D a decision-use block', 517, '{}'::jsonb, 'refused:candidate_ineligible');
  perform _r1_meet_public_tests.expect('T3-D a second submit of a booked candidate (new booking and request ids)', 500,
    jsonb_build_object('booking_id', _r1_meet_public_tests.id(40, 5001), 'request_id', _r1_meet_public_tests.id(41, 5001)),
    'refused:already_booked');
  perform _r1_meet_public_tests.expect('T3-D a live browser round', 518, '{}'::jsonb, 'refused:already_booked');
  perform _r1_meet_public_tests.expect('T3-D a completed R1 and no live round', 519, '{}'::jsonb, 'refused:r1_completed');
  perform _r1_meet_public_tests.expect('T3-D a live phone engagement', 520, '{}'::jsonb, 'refused:phone_engagement_active');
  perform _r1_meet_public_tests.expect('T3-D a pending phone assessment', 521, '{}'::jsonb, 'refused:phone_assessment_pending');
  update screening_v2.roles set interview_kind = 'sales_r1' where id = _r1_meet_public_tests.id(2, 3);
  perform _r1_meet_public_tests.expect('T3-D two sales_r1 roles', 522, '{}'::jsonb, 'refused:role_not_configured');
  update screening_v2.roles set interview_kind = null where id = _r1_meet_public_tests.id(2, 3);
  v_before := _r1_meet_public_tests.counts();
  res := _r1_meet_public_tests.under_release('zzz-meet-public-assert-newer', 'en-GB', '["ai_interview"]'::jsonb,
    'select _r1_meet_public_tests.create(523)');
  perform _r1_meet_public_tests.assert('T3-D the newest release has no en-IN notice: consent_template_unavailable',
    _r1_meet_public_tests.outcome(res) = 'refused:consent_template_unavailable'
    and _r1_meet_public_tests.counts() = v_before, res::text);

  -- One refusal set: the precheck answers exactly the code the create answers (522 is eligible
  -- again now that the second role is gone, so it is not part of this loop).
  for n in 513..521 loop
    res := _r1_meet_public_tests.create(n);
    perform _r1_meet_public_tests.assert('T3-D precheck and create agree for candidate ' || n::text,
      res ->> 'status' = 'refused' and res ->> 'code' = _r1_meet_public_tests.pre(n),
      res::text || ' vs ' || _r1_meet_public_tests.pre(n));
  end loop;
  res := screening_v2.r1_meet_public_precheck(_r1_meet_public_tests.id(10, 524),
                                             _r1_meet_public_tests.id(22, 500)::text, '2026-12-01 04:00:00+00');
  perform _r1_meet_public_tests.assert('T3-D precheck and create agree for a link bound to another candidate',
    res ->> 'code' = 'application_unknown', res::text);
end;
$$;

-- =============================================================================================
-- T3-E. created_by_unknown, in_past, slot_too_far, the consent checks, the consent shape and
-- every other field, nothing written.
-- =============================================================================================
do $$
declare
  p_now constant timestamptz := '2026-12-01 04:00:00+00';
  tpl constant uuid := _r1_meet_public_tests.id(3, 1);
  s constant timestamptz := _r1_meet_public_tests.slot_of(529);
  base constant jsonb := _r1_meet_public_tests.form_consent();
  stale constant jsonb := _r1_meet_public_tests.form_consent()
                          || '{"template_version": "zz-meet-public-assert-older"}'::jsonb;
  f record;
  res jsonb;
begin
  perform _r1_meet_public_tests.candidate(529);
  perform _r1_meet_public_tests.assert('T3-E fixture: id(1, 99) is not an auth user',
    not exists (select 1 from auth.users x where x.id = _r1_meet_public_tests.id(1, 99)));
  for f in
    select * from (values
      ('T3-E a NULL booking id', jsonb_build_object('booking_id', null), 'invalid_request:booking_id'),
      ('T3-E a NULL booking id and a NULL now (booking_id first)',
       jsonb_build_object('booking_id', null, 'now', null), 'invalid_request:booking_id'),
      ('T3-E a NULL request id', jsonb_build_object('request_id', null), 'invalid_request:request_id'),
      ('T3-E a NULL candidate id', jsonb_build_object('candidate_id', null), 'invalid_request:candidate_id'),
      ('T3-E a NULL application id', jsonb_build_object('application_id', null), 'invalid_request:application_id'),
      ('T3-E an application id that is not UUID-shaped', '{"application_id": "not-a-uuid"}'::jsonb,
       'invalid_request:application_id'),
      ('T3-E a NULL Meet URL', jsonb_build_object('meet_url', null), 'invalid_request:meet_url'),
      ('T3-E a Meet URL that is not a Meet room', '{"meet_url": "https://meet.google.com/abc-defg-hi"}'::jsonb,
       'invalid_request:meet_url'),
      ('T3-E a NULL slot start', jsonb_build_object('start_at', null), 'invalid_request:slot'),
      ('T3-E a NULL slot end', jsonb_build_object('end_at', null), 'invalid_request:slot'),
      ('T3-E a 29-minute slot', jsonb_build_object('start_at', s, 'end_at', s + interval '29 minutes'),
       'invalid_request:slot'),
      ('T3-E a 61-minute slot', jsonb_build_object('start_at', s, 'end_at', s + interval '61 minutes'),
       'invalid_request:slot'),
      ('T3-E a slot that ends before it starts', jsonb_build_object('start_at', s, 'end_at', s - interval '45 minutes'),
       'invalid_request:slot'),
      ('T3-E a NULL round creator', jsonb_build_object('created_by', null), 'invalid_request:created_by'),
      ('T3-E no consent', jsonb_build_object('consent', null), 'invalid_request:consent'),
      ('T3-E a consent that is not an object', jsonb_build_object('consent', jsonb_build_array(base)),
       'invalid_request:consent'),
      ('T3-E a consent without in_india', jsonb_build_object('consent', base - 'in_india'), 'invalid_request:consent'),
      ('T3-E in_india as a string', jsonb_build_object('consent', base || '{"in_india": "true"}'::jsonb),
       'invalid_request:consent'),
      ('T3-E a consent with a field the shape does not name',
       jsonb_build_object('consent', base || '{"name": "meet public assert"}'::jsonb), 'invalid_request:consent'),
      ('T3-E a consent without template_version', jsonb_build_object('consent', base - 'template_version'),
       'invalid_request:consent'),
      ('T3-E an empty template_version', jsonb_build_object('consent', base || '{"template_version": ""}'::jsonb),
       'invalid_request:consent'),
      ('T3-E a 65-character template_version',
       jsonb_build_object('consent', base || jsonb_build_object('template_version', repeat('v', 65))),
       'invalid_request:consent'),
      ('T3-E a numeric template_version', jsonb_build_object('consent', base || '{"template_version": 7}'::jsonb),
       'invalid_request:consent'),
      ('T3-E a consent without its consents list', jsonb_build_object('consent', base - 'consents'),
       'invalid_request:consent'),
      ('T3-E consents that are not a list',
       jsonb_build_object('consent', base || '{"consents": "ai_interview"}'::jsonb), 'invalid_request:consent'),
      ('T3-E an empty consents list', jsonb_build_object('consent', base || '{"consents": []}'::jsonb),
       'invalid_request:consent'),
      ('T3-E nine consents',
       jsonb_build_object('consent', base || '{"consents": ["c1", "c2", "c3", "c4", "c5", "c6", "c7", "c8", "c9"]}'::jsonb),
       'invalid_request:consent'),
      ('T3-E a consent granted twice',
       jsonb_build_object('consent', base || '{"consents": ["ai_interview", "ai_interview"]}'::jsonb),
       'invalid_request:consent'),
      ('T3-E a consent that is not a string', jsonb_build_object('consent', base || '{"consents": [1]}'::jsonb),
       'invalid_request:consent'),
      ('T3-E a consent outside the closed spelling',
       jsonb_build_object('consent', base || '{"consents": ["AI_interview"]}'::jsonb), 'invalid_request:consent'),
      ('T3-E an empty ip_prefix', jsonb_build_object('consent', base || '{"ip_prefix": ""}'::jsonb),
       'invalid_request:consent'),
      ('T3-E a 65-character ip_prefix',
       jsonb_build_object('consent', base || jsonb_build_object('ip_prefix', repeat('2', 65))), 'invalid_request:consent'),
      ('T3-E a numeric ip_prefix', jsonb_build_object('consent', base || '{"ip_prefix": 203}'::jsonb),
       'invalid_request:consent'),
      ('T3-E a 257-character user_agent',
       jsonb_build_object('consent', base || jsonb_build_object('user_agent', repeat('u', 257))), 'invalid_request:consent'),
      ('T3-E a numeric user_agent', jsonb_build_object('consent', base || '{"user_agent": 5}'::jsonb),
       'invalid_request:consent'),
      ('T3-E zero seats', '{"seats": 0}'::jsonb, 'invalid_request:seats'),
      ('T3-E sixteen seats', '{"seats": 16}'::jsonb, 'invalid_request:seats'),
      ('T3-E NULL seats', jsonb_build_object('seats', null), 'invalid_request:seats'),
      ('T3-E a public day limit of 0', '{"public_limit": 0}'::jsonb, 'invalid_request:day_limit'),
      ('T3-E a NULL public day limit', jsonb_build_object('public_limit', null), 'invalid_request:day_limit'),
      ('T3-E a bot day limit of 201', '{"bot_limit": 201}'::jsonb, 'invalid_request:day_limit'),
      ('T3-E another objective profile', '{"profile": "r1_other"}'::jsonb, 'invalid_request:profile'),
      ('T3-E a NULL objective profile', jsonb_build_object('profile', null), 'invalid_request:profile'),
      ('T3-E a grace of 899 s', '{"grace": 899}'::jsonb, 'invalid_request:grace'),
      ('T3-E a grace of 86401 s', '{"grace": 86401}'::jsonb, 'invalid_request:grace'),
      ('T3-E a NULL now', jsonb_build_object('now', null), 'invalid_request:now'),
      -- The bounds that pass: a stale notice then stops each before anything is written.
      ('T3-E a 30-minute slot passes the field checks',
       jsonb_build_object('start_at', s, 'end_at', s + interval '30 minutes', 'consent', stale), 'refused:consent_stale'),
      ('T3-E a 60-minute slot passes the field checks',
       jsonb_build_object('start_at', s, 'end_at', s + interval '60 minutes', 'consent', stale), 'refused:consent_stale'),
      ('T3-E a 64-character template_version passes the shape',
       jsonb_build_object('consent', base || jsonb_build_object('template_version', repeat('v', 64))),
       'refused:consent_stale'),
      ('T3-E eight consents, a 64-character ip_prefix and a 256-character user_agent pass the shape',
       jsonb_build_object('consent', stale || jsonb_build_object(
         'consents', '["c1", "c2", "c3", "c4", "c5", "c6", "c7", "c8"]'::jsonb,
         'ip_prefix', repeat('2', 64), 'user_agent', repeat('u', 256))), 'refused:consent_stale'),
      ('T3-E JSON null ip_prefix and user_agent pass the shape',
       jsonb_build_object('consent', stale || '{"ip_prefix": null, "user_agent": null}'::jsonb), 'refused:consent_stale'),
      -- The refusals after the field checks.
      ('T3-E an unknown round creator', jsonb_build_object('created_by', _r1_meet_public_tests.id(1, 99)),
       'refused:created_by_unknown'),
      ('T3-E a slot that starts now', jsonb_build_object('start_at', p_now, 'end_at', p_now + interval '45 minutes'),
       'refused:in_past'),
      ('T3-E a slot that has started',
       jsonb_build_object('start_at', p_now - interval '10 minutes', 'end_at', p_now + interval '35 minutes'),
       'refused:in_past'),
      ('T3-E an expiry one second past now + 14 days',
       '{"start_at": "2026-12-15T01:15:01+00:00", "end_at": "2026-12-15T02:00:01+00:00"}'::jsonb, 'refused:slot_too_far'),
      ('T3-E another notice version than the newest', jsonb_build_object('consent', stale), 'refused:consent_stale'),
      ('T3-E a required consent not granted',
       jsonb_build_object('consent', base || '{"consents": ["ai_interview", "video_audio_recording", "ai_evaluation"]}'::jsonb),
       'refused:consent_incomplete'),
      ('T3-E no India tick', jsonb_build_object('consent', base || '{"in_india": false}'::jsonb),
       'refused:consent_incomplete')
    ) v(label, args, outcome)
  loop
    perform _r1_meet_public_tests.expect(f.label, 529, f.args, f.outcome);
  end loop;
  perform _r1_meet_public_tests.assert('T3-E the candidate is still eligible after every refusal',
    _r1_meet_public_tests.pre(529) = 'eligible', _r1_meet_public_tests.pre(529));

  -- What passes: the expiry bound exactly, extra granted consents, no prefix or user agent.
  perform _r1_meet_public_tests.candidate(530);
  res := _r1_meet_public_tests.expect('T3-E an expiry of exactly now + 14 days', 530,
    '{"start_at": "2026-12-15T01:15:00+00:00", "end_at": "2026-12-15T02:00:00+00:00"}'::jsonb, 'booked:created');
  perform _r1_meet_public_tests.assert('T3-E ... and the round expires exactly at now + 14 days',
    (res ->> 'round_expires_at')::timestamptz = p_now + interval '14 days', res::text);
  perform _r1_meet_public_tests.candidate(531);
  res := _r1_meet_public_tests.expect('T3-E extra granted consents', 531, jsonb_build_object('consent', base
    || '{"consents": ["ai_interview", "video_audio_recording", "ai_evaluation", "data_processing", "marketing_updates"]}'::jsonb),
    'booked:created');
  perform _r1_meet_public_tests.assert('T3-E ... store exactly the notice''s required set',
    _r1_meet_public_tests.form_consent_ok(_r1_meet_public_tests.live_consent((res ->> 'round_id')::uuid), tpl, p_now));
  perform _r1_meet_public_tests.candidate(532);
  res := _r1_meet_public_tests.expect('T3-E a consent without ip_prefix and user_agent', 532,
    jsonb_build_object('consent', base - 'ip_prefix' - 'user_agent'), 'booked:created');
  perform _r1_meet_public_tests.assert('T3-E ... stores both as JSON null in the nine proof fields',
    _r1_meet_public_tests.form_consent_ok(_r1_meet_public_tests.live_consent((res ->> 'round_id')::uuid), tpl, p_now,
                                          null, null));
end;
$$;

-- =============================================================================================
-- T3-F. Re-link: after an Ashby cancel, after a failed public booking, after HR's grant-retake;
-- the consent checks of a re-link; the round audience without a notice.
-- =============================================================================================
do $$
declare
  p_now constant timestamptz := '2026-12-01 04:00:00+00';
  t5 constant timestamptz := '2026-12-01 05:00:00+00';
  tpl constant uuid := _r1_meet_public_tests.id(3, 1);
  res jsonb;
  r uuid;
  ab uuid;
  hr uuid;
  k uuid;
  b1 uuid;
  r_before screening_v2.interview_rounds%rowtype;
  r_after screening_v2.interview_rounds%rowtype;
  reserved_before numeric;
  stored jsonb;
begin
  -- (1) HR booked Dex in Ashby (0142: round + HR-attested consent), then cancelled the booking.
  perform _r1_meet_public_tests.candidate(536);
  res := screening_v2.r1_meet_create_round_from_ashby(
    _r1_meet_public_tests.id(20, 536), _r1_meet_public_tests.id(21, 536)::text,
    _r1_meet_public_tests.id(22, 536)::text, null, null, _r1_meet_public_tests.id(25, 1)::text,
    '2026-11-30 09:00:00+00', '2026-11-30 09:00:05+00', 'https://meet.google.com/abc-defg-hij',
    _r1_meet_public_tests.slot_of(536), _r1_meet_public_tests.slot_of(536) + interval '45 minutes',
    _r1_meet_public_tests.id(1, 1), 'r1_dex_sales', 7200, p_now);
  r := (res ->> 'round_id')::uuid;
  ab := (res ->> 'booking_id')::uuid;
  hr := _r1_meet_public_tests.live_consent(r);
  perform _r1_meet_public_tests.assert('T3-F fixture: an Ashby booking with its round and HR-attested consent',
    res ->> 'status' = 'created'
    and (select x.method = 'hr_attested_ashby' from screening_v2.interview_round_consents x where x.id = hr), res::text);
  res := screening_v2.r1_meet_cancel_booking(ab, 'cancelled', p_now);
  perform _r1_meet_public_tests.assert('T3-F fixture: HR cancels the Ashby booking, and the candidate is eligible',
    res ->> 'status' = 'ok' and _r1_meet_public_tests.pre(536) = 'eligible', res::text);
  select * into r_before from screening_v2.interview_rounds x where x.id = r;
  reserved_before := _r1_meet_public_tests.reserved('2026-12-01');
  res := _r1_meet_public_tests.create(536, jsonb_build_object('now', t5));
  select * into r_after from screening_v2.interview_rounds x where x.id = r;
  perform _r1_meet_public_tests.assert('T3-F after an Ashby cancel the public submit re-links the same round',
    _r1_meet_public_tests.outcome(res) = 'booked:relinked' and (res ->> 'round_id')::uuid = r, res::text);
  perform _r1_meet_public_tests.assert(
    'T3-F ... the round moves its expiry, version + 1, keeps its hold and its month counter',
    r_after.expires_at = _r1_meet_public_tests.slot_of(536) + interval '45 minutes' + interval '7200 seconds'
    and (res ->> 'round_expires_at')::timestamptz = r_after.expires_at
    and r_after.version = r_before.version + 1 and r_after.updated_at = t5
    and r_after.status = 'invited' and r_after.channel = 'meet'
    and r_after.held_minutes = r_before.held_minutes and r_after.hold_month = r_before.hold_month
    and _r1_meet_public_tests.reserved('2026-12-01') = reserved_before, to_jsonb(r_after)::text);
  perform _r1_meet_public_tests.assert('T3-F ... the HR-attested consent is superseded, never erased',
    (select x.withdrawn_at = t5 and x.proof ->> 'decision' = 'superseded'
            and (x.proof ->> 'superseded_at')::timestamptz = t5 and x.method = 'hr_attested_ashby'
       from screening_v2.interview_round_consents x where x.id = hr)
    and not exists (select 1 from screening_v2.job_queue x
                     where x.name = 'r1.recording.erase' and x.dedup_key = 'r1.recording.erase:' || hr::text));
  k := _r1_meet_public_tests.live_consent(r);
  perform _r1_meet_public_tests.assert('T3-F ... and the candidate_web consent of the form is the one live consent',
    k is distinct from hr and _r1_meet_public_tests.form_consent_ok(k, tpl, t5));
  perform _r1_meet_public_tests.assert('T3-F ... the new public booking queues its three jobs; the Ashby booking stays history',
    _r1_meet_public_tests.jobs_of(_r1_meet_public_tests.id(40, 536))
      = _r1_meet_public_tests.create_jobs(_r1_meet_public_tests.id(40, 536))
    and (select x.status = 'cancelled' and x.round_id = r and x.source = 'ashby'
           from screening_v2.r1_meet_bookings x where x.id = ab));

  -- (2) A public booking whose bot could not be created (failed): a new submit re-links its round.
  perform _r1_meet_public_tests.candidate(537);
  res := _r1_meet_public_tests.create(537);
  r := (res ->> 'round_id')::uuid;
  b1 := (res ->> 'booking_id')::uuid;
  k := _r1_meet_public_tests.live_consent(r);
  res := screening_v2.r1_meet_transition_booking(b1, 'pending', 'failed', 'bot_create_failed', p_now);
  perform _r1_meet_public_tests.assert('T3-F fixture: the public booking failed (bot_create_failed), the candidate is eligible',
    res ->> 'status' = 'ok' and _r1_meet_public_tests.pre(537) = 'eligible', res::text);
  res := _r1_meet_public_tests.create(537, jsonb_build_object(
    'booking_id', _r1_meet_public_tests.id(40, 5371), 'request_id', _r1_meet_public_tests.id(41, 5371), 'now', t5));
  perform _r1_meet_public_tests.assert('T3-F after a failed public booking a new submit re-links the same round',
    _r1_meet_public_tests.outcome(res) = 'booked:relinked' and (res ->> 'round_id')::uuid = r
    and (res ->> 'booking_id')::uuid = _r1_meet_public_tests.id(40, 5371), res::text);
  perform _r1_meet_public_tests.assert('T3-F ... the first consent is superseded and the new one is live',
    (select x.withdrawn_at = t5 and x.proof ->> 'decision' = 'superseded'
       from screening_v2.interview_round_consents x where x.id = k)
    and _r1_meet_public_tests.form_consent_ok(_r1_meet_public_tests.live_consent(r), tpl, t5));
  perform _r1_meet_public_tests.assert('T3-F ... exactly one live booking of the candidate, the new one',
    (select count(*) = 1 and bool_and(x.id = _r1_meet_public_tests.id(40, 5371))
       from screening_v2.r1_meet_bookings x
      where x.candidate_id = _r1_meet_public_tests.id(10, 537)
        and x.status in ('pending', 'blocked', 'bot_scheduled', 'bot_joining', 'human_present', 'in_call')));

  -- (3) HR's grant-retake: a completed Meet round with exactly one counted attempt goes back to
  -- invited (r1_transition_round), and the public submit re-links it.
  perform _r1_meet_public_tests.candidate(538);
  r := _r1_meet_public_tests.round(538, 'completed', 'meet', '2026-12-01 03:00:00+00');
  update screening_v2.interview_rounds set attempts_counted = 1, starts_used = 1 where id = r;
  insert into screening_v2.call_sessions
    (id, candidate_id, role_id, mode, provider, external_call_id, status, interview_round_id, owner_id)
  values (_r1_meet_public_tests.id(12, 538), _r1_meet_public_tests.id(10, 538), _r1_meet_public_tests.id(2, 1),
          'browser', 'livekit', 'screening-' || _r1_meet_public_tests.id(12, 538)::text, 'created', r,
          _r1_meet_public_tests.id(1, 1));
  -- The attempt's session ended (every session starts created, 0006); a counted attempt's session
  -- need not be completed (0126).
  update screening_v2.call_sessions set status = 'failed', terminal_reason = 'worker_crash'
   where id = _r1_meet_public_tests.id(12, 538);
  insert into screening_v2.interview_round_attempts
    (session_id, round_id, attempt_number, persona_id, counted, nonce_digest)
  values (_r1_meet_public_tests.id(12, 538), r, 1, 'p1_career_switcher', true,
          _r1_meet_public_tests.digest('attempt-538'));
  perform _r1_meet_public_tests.assert('T3-F fixture: a completed Meet R1 and no live round is r1_completed',
    _r1_meet_public_tests.pre(538) = 'r1_completed', _r1_meet_public_tests.pre(538));
  res := screening_v2.r1_transition_round(r, 'grant-retake',
    (select x.version from screening_v2.interview_rounds x where x.id = r), null, '2026-12-08 00:00:00+00', p_now);
  perform _r1_meet_public_tests.assert('T3-F HR grants the retake: the round is invited again and the candidate eligible',
    res ->> 'status' = 'ok' and _r1_meet_public_tests.pre(538) = 'eligible'
    and (select x.status = 'invited' and x.attempts_counted = 1 from screening_v2.interview_rounds x where x.id = r),
    res::text);
  res := _r1_meet_public_tests.create(538);
  perform _r1_meet_public_tests.assert('T3-F after HR''s grant-retake the public submit re-links the round',
    _r1_meet_public_tests.outcome(res) = 'booked:relinked' and (res ->> 'round_id')::uuid = r
    and (select x.expires_at = _r1_meet_public_tests.slot_of(538) + interval '45 minutes' + interval '7200 seconds'
                and x.attempts_counted = 1 and x.status = 'invited'
           from screening_v2.interview_rounds x where x.id = r)
    and _r1_meet_public_tests.form_consent_ok(_r1_meet_public_tests.live_consent(r), tpl, p_now), res::text);

  -- (4) A re-link under a newer release: the form's older notice is stale; the newest one books.
  perform _r1_meet_public_tests.candidate(539);
  r := _r1_meet_public_tests.round(539);
  res := _r1_meet_public_tests.under_release('zzz-meet-public-assert-newer', 'en-IN',
    '["ai_interview", "video_audio_recording", "ai_evaluation", "data_processing"]'::jsonb,
    'select _r1_meet_public_tests.create(539)');
  perform _r1_meet_public_tests.assert('T3-F a re-link under a newer release the form did not show: consent_stale',
    _r1_meet_public_tests.outcome(res) = 'refused:consent_stale', res::text);
  res := _r1_meet_public_tests.under_release('zzz-meet-public-assert-newer', 'en-IN',
    '["ai_interview", "video_audio_recording", "ai_evaluation", "data_processing"]'::jsonb,
    format('select _r1_meet_public_tests.create(539, %L::jsonb)', jsonb_build_object('consent',
      _r1_meet_public_tests.form_consent() || '{"template_version": "zzz-meet-public-assert-newer"}'::jsonb)));
  perform _r1_meet_public_tests.assert('T3-F ... and with the newest notice it re-links (rolled back)',
    _r1_meet_public_tests.outcome(res) = 'booked:relinked' and (res ->> 'round_id')::uuid = r, res::text);

  -- (5) The round's audience decides the notice of a re-link: a staff round re-checks the form
  -- against the staff notice of the newest release, which may require more than the en-IN one.
  perform _r1_meet_public_tests.candidate(540);
  r := _r1_meet_public_tests.round(540);
  update screening_v2.interview_rounds set consent_locale = 'en-IN-x-staff' where id = r;
  res := _r1_meet_public_tests.in_rollback(array[
      'insert into screening_v2.interview_round_consent_templates (version, locale, title, body_md, required_consents, is_active) '
      || 'values (''zzz-meet-public-assert-staff'', ''en-IN'', ''R1 Meet public assertion newer notice'', ''fixture'', '
      || '''["ai_interview"]''::jsonb, true)',
      'insert into screening_v2.interview_round_consent_templates (version, locale, title, body_md, required_consents, is_active) '
      || 'values (''zzz-meet-public-assert-staff'', ''en-IN-x-staff'', ''R1 Meet public assertion staff notice'', ''fixture'', '
      || '''["ai_interview", "staff_recording"]''::jsonb, true)'],
    format('select _r1_meet_public_tests.create(540, %L::jsonb)', jsonb_build_object('consent',
      _r1_meet_public_tests.form_consent()
      || '{"template_version": "zzz-meet-public-assert-staff", "consents": ["ai_interview"]}'::jsonb)));
  perform _r1_meet_public_tests.assert(
    'T3-F a staff round whose staff notice requires more than the form granted: consent_incomplete',
    _r1_meet_public_tests.outcome(res) = 'refused:consent_incomplete', res::text);
  stored := _r1_meet_public_tests.in_rollback(array[
      'insert into screening_v2.interview_round_consent_templates (version, locale, title, body_md, required_consents, is_active) '
      || 'values (''zzz-meet-public-assert-staff'', ''en-IN'', ''R1 Meet public assertion newer notice'', ''fixture'', '
      || '''["ai_interview"]''::jsonb, true)',
      'insert into screening_v2.interview_round_consent_templates (version, locale, title, body_md, required_consents, is_active) '
      || 'values (''zzz-meet-public-assert-staff'', ''en-IN-x-staff'', ''R1 Meet public assertion staff notice'', ''fixture'', '
      || '''["ai_interview", "staff_recording"]''::jsonb, true)',
      format('select _r1_meet_public_tests.assert(%L, _r1_meet_public_tests.outcome(_r1_meet_public_tests.create(540, %L::jsonb)) = %L)',
             'T3-F ... granting the staff notice''s set re-links the staff round (rolled back)',
             jsonb_build_object('consent', _r1_meet_public_tests.form_consent()
               || '{"template_version": "zzz-meet-public-assert-staff", "consents": ["ai_interview", "staff_recording"]}'::jsonb),
             'booked:relinked')],
    format('select to_jsonb(x) from screening_v2.interview_round_consents x where x.round_id = %L and x.withdrawn_at is null', r));
  perform _r1_meet_public_tests.assert('T3-F ... and stores the staff notice''s required set and locale',
    stored -> 'consents' = '["ai_interview", "staff_recording"]'::jsonb
    and stored -> 'proof' ->> 'locale' = 'en-IN-x-staff'
    and stored -> 'proof' ->> 'template_version' = 'zzz-meet-public-assert-staff'
    and stored ->> 'method' = 'candidate_web', coalesce(stored::text, 'null'));

  -- (6) A reusable staff round and no staff notice in the newest release.
  perform _r1_meet_public_tests.candidate(541);
  r := _r1_meet_public_tests.round(541);
  update screening_v2.interview_rounds set consent_locale = 'en-IN-x-staff' where id = r;
  perform _r1_meet_public_tests.expect('T3-F a reusable staff round with no staff notice', 541, '{}'::jsonb,
    'refused:consent_template_unavailable');
end;
$$;

-- =============================================================================================
-- T3-G. The step-8a expiry of a lapsed Meet round, and a lapsed round that still has a booking.
-- =============================================================================================
do $$
declare
  p_now constant timestamptz := '2026-12-01 04:00:00+00';
  res jsonb;
  r_old uuid;
  b_old uuid;
  old_version integer;
  nov_before numeric;
  dec_before numeric;
begin
  -- A public booking made on 2026-11-28 for 2026-11-29; its bot never joined (failed/in_past), so
  -- its round lapsed unstarted and unused, still holding 65 minutes of November.
  perform _r1_meet_public_tests.candidate(546);
  res := _r1_meet_public_tests.create(546, '{"now": "2026-11-28T04:00:00+00:00",
    "start_at": "2026-11-29T05:00:00+00:00", "end_at": "2026-11-29T05:45:00+00:00"}'::jsonb);
  r_old := (res ->> 'round_id')::uuid;
  b_old := (res ->> 'booking_id')::uuid;
  perform _r1_meet_public_tests.assert('T3-G fixture: a November booking holds 65 minutes of November',
    _r1_meet_public_tests.outcome(res) = 'booked:created'
    and (select x.held_minutes = 65 and x.hold_month = '2026-11-01'
           from screening_v2.interview_rounds x where x.id = r_old), res::text);
  res := screening_v2.r1_meet_transition_booking(b_old, 'pending', 'failed', 'in_past', '2026-11-29 05:00:00+00');
  perform _r1_meet_public_tests.assert('T3-G fixture: the booking failed and its round lapsed; the candidate is eligible',
    res ->> 'status' = 'ok' and _r1_meet_public_tests.pre(546) = 'eligible', res::text);
  select x.version into old_version from screening_v2.interview_rounds x where x.id = r_old;
  nov_before := _r1_meet_public_tests.reserved('2026-11-01');
  dec_before := _r1_meet_public_tests.reserved('2026-12-01');
  res := _r1_meet_public_tests.create(546, jsonb_build_object(
    'booking_id', _r1_meet_public_tests.id(40, 5461), 'request_id', _r1_meet_public_tests.id(41, 5461)));
  perform _r1_meet_public_tests.assert('T3-G a lapsed, unused Meet round is expired and a new round created',
    _r1_meet_public_tests.outcome(res) = 'booked:created' and (res ->> 'round_id')::uuid <> r_old, res::text);
  perform _r1_meet_public_tests.assert(
    'T3-G ... through r1_transition_round expire: status expired, version + 1, the November hold released',
    (select x.status = 'expired' and x.held_minutes = 0 and x.version = old_version + 1 and x.updated_at = p_now
       from screening_v2.interview_rounds x where x.id = r_old)
    and _r1_meet_public_tests.reserved('2026-11-01') = nov_before - 65
    and _r1_meet_public_tests.reserved('2026-12-01') = dec_before + 65,
    format('november %s -> %s, december %s -> %s', nov_before, _r1_meet_public_tests.reserved('2026-11-01'),
           dec_before, _r1_meet_public_tests.reserved('2026-12-01')));

  -- A lapsed Meet round that still has a live booking is never expired: already_booked, no write.
  perform _r1_meet_public_tests.candidate(547);
  perform _r1_meet_public_tests.round(547, 'invited', 'meet', '2026-11-30 00:00:00+00');
  perform _r1_meet_public_tests.public_booking(547);
  perform _r1_meet_public_tests.expect('T3-G a lapsed Meet round that still has a live booking', 547,
    jsonb_build_object('booking_id', _r1_meet_public_tests.id(40, 5471), 'request_id', _r1_meet_public_tests.id(41, 5471)),
    'refused:already_booked');
  perform _r1_meet_public_tests.assert('T3-G ... and its round stays invited',
    (select x.status = 'invited' from screening_v2.interview_rounds x where x.id = _r1_meet_public_tests.id(11, 547)));
end;
$$;

-- =============================================================================================
-- T3-H. The settings refusals through the create (the §12 codes come before r1_send_round), the
-- re-link under a full cap, and the catalog posture of the create.
-- =============================================================================================
do $$
declare
  sig constant text :=
    'screening_v2.r1_meet_create_round_from_public(uuid, uuid, uuid, text, text, timestamptz, timestamptz, '
    || 'uuid, jsonb, integer, integer, integer, text, integer, timestamptz)';
  role_name text;
begin
  perform _r1_meet_public_tests.candidate(550);
  perform _r1_meet_public_tests.candidate(551);
  perform _r1_meet_public_tests.round(551);
  update screening_v2.r1_settings set enabled = false, paused = true where singleton;
  perform _r1_meet_public_tests.expect('T3-H R1 disabled (and paused)', 550, '{}'::jsonb, 'refused:disabled');
  update screening_v2.r1_settings set enabled = true where singleton;
  perform _r1_meet_public_tests.expect('T3-H R1 paused', 550, '{}'::jsonb, 'refused:paused');
  update screening_v2.r1_settings set paused = false, monthly_cap_minutes = 65 where singleton;
  perform _r1_meet_public_tests.assert('T3-H fixture: a 65-minute hold is outstanding',
    exists (select 1 from screening_v2.interview_rounds x
             where x.held_minutes > 0 and x.status in ('invited', 'in_progress')
               and x.expires_at > '2026-12-01 04:00:00+00'));
  perform _r1_meet_public_tests.expect('T3-H a 65-minute cap with a hold outstanding', 550, '{}'::jsonb,
    'refused:capacity_exhausted');
  perform _r1_meet_public_tests.expect('T3-H the same cap with a reusable Meet round (a re-link takes no new hold)', 551,
    '{}'::jsonb, 'booked:relinked');
  update screening_v2.r1_settings set monthly_cap_minutes = 100000 where singleton;
  perform _r1_meet_public_tests.expect('T3-H the cap restored', 550, '{}'::jsonb, 'booked:created');

  perform _r1_meet_public_tests.assert('T3-H the create is one security definer, volatile function returning jsonb',
    (select x.prosecdef and x.provolatile = 'v'
            and x.proconfig = array['search_path=pg_catalog, screening_v2']
            and x.prorettype = 'jsonb'::regtype and x.pronargs = 15 and x.pronargdefaults = 3
       from pg_proc x where x.oid = sig::regprocedure)
    and (select count(*) = 1 from pg_proc x
          where x.pronamespace = 'screening_v2'::regnamespace and x.proname = 'r1_meet_create_round_from_public'));
  perform _r1_meet_public_tests.assert('T3-H the create is executable by service_role only',
    has_function_privilege('service_role', sig, 'execute')
    and not has_function_privilege('anon', sig, 'execute')
    and not has_function_privilege('authenticated', sig, 'execute')
    and not has_function_privilege('public', sig, 'execute'));
  foreach role_name in array array['anon', 'authenticated'] loop
    perform _r1_meet_public_tests.raises_as(role_name, 'T3-H execute r1_meet_create_round_from_public',
      'select screening_v2.r1_meet_create_round_from_public(null, null, null, null, null, null, null, null, '
      || 'null, null, null, null)', '42501');
  end loop;
end;
$$;

-- =============================================================================================
-- T4 fixtures. Fixture numbers 600-689 for candidates booked through the create RPC, 690-699 for
-- rows inserted directly, 6001-6999 for a second booking or request id of candidate n/10. p_now is
-- 2026-12-20 04:00 UTC (09:30 IST) unless a call says otherwise, so every T4 day (IST 2026-12-20 and
-- later) is free of earlier bookings. t4_book(n) books candidate n's application n into t4_slot(n)
-- (one hour apart, twelve per IST day from 2026-12-21 09:00 IST) and sets the manage digest md(n);
-- moves that leave the day land on IST 2026-12-30 and later, where no T4 booking starts.
-- =============================================================================================

-- The slot start of t4_book(n).
create function _r1_meet_public_tests.t4_slot(p_n integer) returns timestamptz
language sql stable as $$
  select '2026-12-21 03:30:00+00'::timestamptz
         + make_interval(days => (p_n - 600) / 12, hours => (p_n - 600) % 12)
$$;

-- The manage digest of candidate n's T4 booking (computed at run time, never a literal).
create function _r1_meet_public_tests.md(p_n integer) returns text
language sql immutable as $$
  select _r1_meet_public_tests.digest('t4-manage-' || p_n::text)
$$;

-- A new candidate n (with its link) booked through the create RPC into t4_slot(n) at the T4 now,
-- with the manage digest md(n). Returns the booking id, id(40, n).
create function _r1_meet_public_tests.t4_book(p_n integer) returns uuid
language plpgsql as $$
declare
  v_res jsonb;
  v_set jsonb;
begin
  perform _r1_meet_public_tests.candidate(p_n);
  v_res := _r1_meet_public_tests.create(p_n, jsonb_build_object(
    'start_at', _r1_meet_public_tests.t4_slot(p_n),
    'end_at', _r1_meet_public_tests.t4_slot(p_n) + interval '45 minutes',
    'now', '2026-12-20T04:00:00+00:00'));
  v_set := screening_v2.r1_meet_public_set_manage_digest(_r1_meet_public_tests.id(40, p_n),
             _r1_meet_public_tests.md(p_n), '2026-12-20 04:00:00+00');
  perform _r1_meet_public_tests.assert('T4 fixture: candidate ' || p_n || ' booked, with its manage digest',
    _r1_meet_public_tests.outcome(v_res) = 'booked:created' and v_set ->> 'status' = 'ok',
    v_res::text || ' ' || coalesce(v_set::text, 'null'));
  return _r1_meet_public_tests.id(40, p_n);
end;
$$;

-- The round of a booking.
create function _r1_meet_public_tests.round_of_booking(p_booking uuid) returns uuid
language sql stable as $$
  select x.round_id from screening_v2.r1_meet_bookings x where x.id = p_booking
$$;

-- The version of a round.
create function _r1_meet_public_tests.round_version(p_round uuid) returns integer
language sql stable as $$
  select x.version from screening_v2.interview_rounds x where x.id = p_round
$$;

-- Attaches Recall bot id(30, n) to booking id(40, n) through 0142's r1_meet_set_bot: bot_scheduled.
create function _r1_meet_public_tests.attach(p_n integer) returns void
language plpgsql as $$
declare
  v_res jsonb;
begin
  select screening_v2.r1_meet_set_bot(x.id, 'attach', x.version, x.key_attempt,
                                      _r1_meet_public_tests.id(30, p_n), '2026-12-20 04:00:00+00')
    into v_res
    from screening_v2.r1_meet_bookings x where x.id = _r1_meet_public_tests.id(40, p_n);
  perform _r1_meet_public_tests.assert('T4 fixture: bot ' || p_n || ' attached (bot_scheduled)',
    v_res ->> 'status' = 'ok' and v_res ->> 'booking_status' = 'bot_scheduled', coalesce(v_res::text, 'null'));
end;
$$;

-- Attaches the bot, then Recall dispatches it (0142 r1_meet_transition_booking: bot_joining).
create function _r1_meet_public_tests.dispatch(p_n integer) returns void
language plpgsql as $$
declare
  v_res jsonb;
begin
  perform _r1_meet_public_tests.attach(p_n);
  v_res := screening_v2.r1_meet_transition_booking(_r1_meet_public_tests.id(40, p_n), 'bot_scheduled',
                                                   'bot_joining', 'eligible', '2026-12-20 04:00:00+00');
  perform _r1_meet_public_tests.assert('T4 fixture: bot ' || p_n || ' dispatched (bot_joining)',
    v_res ->> 'status' = 'ok', v_res::text);
end;
$$;

-- Calls the move RPC as S06 would for booking id(40, n): its manage digest md(n), the booking's
-- current version, the slot t4_slot(n) + 15 min (45 min long: it overlaps only the booking's own
-- slot), seats 2, limits 20/20, at most 3 moves, a one-hour cutoff, grace 7200, the T4 now;
-- overridden by p_args (a JSON null is SQL NULL).
create function _r1_meet_public_tests.move(p_n integer, p_args jsonb default '{}'::jsonb)
returns jsonb language plpgsql as $$
declare
  a jsonb := jsonb_build_object(
    'booking_id', _r1_meet_public_tests.id(40, p_n),
    'digest', _r1_meet_public_tests.md(p_n),
    'version', (select x.version from screening_v2.r1_meet_bookings x
                 where x.id = _r1_meet_public_tests.id(40, p_n)),
    'start_at', _r1_meet_public_tests.t4_slot(p_n) + interval '15 minutes',
    'end_at', _r1_meet_public_tests.t4_slot(p_n) + interval '60 minutes',
    'seats', 2,
    'public_limit', 20,
    'bot_limit', 20,
    'max_moves', 3,
    'cutoff', 3600,
    'grace', 7200,
    'now', '2026-12-20T04:00:00+00:00') || p_args;
begin
  return screening_v2.r1_meet_public_move_booking(
    (a ->> 'booking_id')::uuid, a ->> 'digest', (a ->> 'version')::integer,
    (a ->> 'start_at')::timestamptz, (a ->> 'end_at')::timestamptz,
    (a ->> 'seats')::integer, (a ->> 'public_limit')::integer, (a ->> 'bot_limit')::integer,
    (a ->> 'max_moves')::integer, (a ->> 'cutoff')::integer, (a ->> 'grace')::integer,
    (a ->> 'now')::timestamptz);
end;
$$;

-- Calls the cancel RPC for candidate n's digest md(n): no withdrawal, a one-hour cutoff, the T4 now.
create function _r1_meet_public_tests.cancel(p_n integer, p_args jsonb default '{}'::jsonb)
returns jsonb language plpgsql as $$
declare
  a jsonb := jsonb_build_object('digest', _r1_meet_public_tests.md(p_n), 'withdraw', false,
                                'cutoff', 3600, 'now', '2026-12-20T04:00:00+00:00') || p_args;
begin
  return screening_v2.r1_meet_public_cancel_booking(
    a ->> 'digest', (a ->> 'withdraw')::boolean, (a ->> 'cutoff')::integer, (a ->> 'now')::timestamptz);
end;
$$;

-- Calls the re-consent RPC for candidate n's digest md(n): the form's default consent, the T4 now.
create function _r1_meet_public_tests.reconsent(p_n integer, p_args jsonb default '{}'::jsonb)
returns jsonb language plpgsql as $$
declare
  a jsonb := jsonb_build_object('digest', _r1_meet_public_tests.md(p_n),
                                'consent', _r1_meet_public_tests.form_consent(),
                                'now', '2026-12-20T04:00:00+00:00') || p_args;
begin
  return screening_v2.r1_meet_public_reconsent(
    a ->> 'digest', nullif(a -> 'consent', 'null'::jsonb), (a ->> 'now')::timestamptz);
end;
$$;

-- p_sql (one jsonb answer) must answer p_outcome (the outcome() word); every answer but the three
-- that write (moved, cancelled, ok) must leave counts() unchanged.
create function _r1_meet_public_tests.expect_rpc(p_label text, p_sql text, p_outcome text)
returns jsonb language plpgsql as $$
declare
  v_before jsonb := _r1_meet_public_tests.counts();
  v_res jsonb;
begin
  execute p_sql into v_res;
  perform _r1_meet_public_tests.assert(p_label || ' answers ' || p_outcome,
    _r1_meet_public_tests.outcome(v_res) = p_outcome, coalesce(v_res::text, 'null'));
  if p_outcome not in ('moved:', 'cancelled:', 'ok:') then
    perform _r1_meet_public_tests.assert(p_label || ' writes nothing',
      _r1_meet_public_tests.counts() = v_before, coalesce(v_res::text, 'null'));
  end if;
  return v_res;
end;
$$;

create function _r1_meet_public_tests.expect_move(p_label text, p_n integer, p_args jsonb, p_outcome text)
returns jsonb language sql as $$
  select _r1_meet_public_tests.expect_rpc(p_label,
    format('select _r1_meet_public_tests.move(%s, %L::jsonb)', p_n, p_args), p_outcome)
$$;

create function _r1_meet_public_tests.expect_cancel(p_label text, p_n integer, p_args jsonb, p_outcome text)
returns jsonb language sql as $$
  select _r1_meet_public_tests.expect_rpc(p_label,
    format('select _r1_meet_public_tests.cancel(%s, %L::jsonb)', p_n, p_args), p_outcome)
$$;

create function _r1_meet_public_tests.expect_reconsent(p_label text, p_n integer, p_args jsonb, p_outcome text)
returns jsonb language sql as $$
  select _r1_meet_public_tests.expect_rpc(p_label,
    format('select _r1_meet_public_tests.reconsent(%s, %L::jsonb)', p_n, p_args), p_outcome)
$$;

-- The expected jobs of the T4 RPCs (contracts section 5), and a job list in jobs_of order.
create function _r1_meet_public_tests.move_job(p_booking uuid, p_count integer) returns jsonb
language sql immutable as $$
  select _r1_meet_public_tests.job(
           jsonb_build_object('kind', 'calendar_sync', 'op', 'move', 'booking_id', p_booking),
           'r1-meet:calendar:' || p_booking::text || ':move:' || p_count::text)
$$;

create function _r1_meet_public_tests.ensure_job(p_booking uuid) returns jsonb
language sql immutable as $$
  select _r1_meet_public_tests.job(jsonb_build_object('kind', 'ensure_bot', 'booking_id', p_booking),
                                   'r1-meet:ensure-bot:' || p_booking::text)
$$;

create function _r1_meet_public_tests.release_job(p_booking uuid, p_bot uuid) returns jsonb
language sql immutable as $$
  select _r1_meet_public_tests.job(
           jsonb_build_object('kind', 'bot_release', 'recall_bot_id', p_bot, 'booking_id', p_booking),
           'r1-meet:bot-release:' || p_bot::text)
$$;

create function _r1_meet_public_tests.by_key(p_jobs jsonb) returns jsonb
language sql immutable as $$
  select coalesce(jsonb_agg(e.item order by e.item ->> 'dedup_key' collate "C"), '[]'::jsonb)
    from jsonb_array_elements(p_jobs) e(item)
$$;

-- Whether a round_cancelled job names the booking (0142's trigger on a Meet round's cancel).
create function _r1_meet_public_tests.round_cancelled_job(p_booking uuid) returns boolean
language sql stable as $$
  select exists (select 1 from screening_v2.job_queue x
                  where x.dedup_key = 'r1-meet:round-cancelled:' || p_booking::text
                     or (x.name = 'r1-meet' and x.payload ->> 'kind' = 'round_cancelled'
                         and x.payload ->> 'booking_id' = p_booking::text))
$$;

-- A test-only BEFORE UPDATE trigger function: bumps the booking's round version, as a concurrent
-- writer would between the cancel's read of the round and r1_transition_round.
create function _r1_meet_public_tests.bump_round() returns trigger
language plpgsql as $$
begin
  update screening_v2.interview_rounds set version = version + 1 where id = new.round_id;
  return new;
end;
$$;

-- Under the newer release 'zzz-meet-public-assert-newer' (inside under_release): the manage page
-- reads consent_current false, the older notice is stale, the newer one is accepted; the old
-- consent is superseded and the new candidate_web row is on the newer notice. Returns the answer.
create function _r1_meet_public_tests.t4_newer(p_n integer, p_now timestamptz) returns jsonb
language plpgsql as $$
declare
  v_round uuid := _r1_meet_public_tests.round_of_booking(_r1_meet_public_tests.id(40, p_n));
  v_old uuid := _r1_meet_public_tests.live_consent(
                  _r1_meet_public_tests.round_of_booking(_r1_meet_public_tests.id(40, p_n)));
  v_tpl uuid := (select x.id from screening_v2.interview_round_consent_templates x
                  where x.version = 'zzz-meet-public-assert-newer' and x.locale = 'en-IN');
  v_res jsonb;
  v_new uuid;
begin
  perform _r1_meet_public_tests.assert('T4-C under a newer release the manage page reads consent_current false',
    (screening_v2.r1_meet_public_manage_read(_r1_meet_public_tests.md(p_n), 3600, 3, p_now)
      -> 'consent_current') = 'false'::jsonb);
  perform _r1_meet_public_tests.expect_reconsent('T4-C under a newer release, the older notice', p_n,
    jsonb_build_object('now', p_now), 'refused:consent_stale');
  v_res := _r1_meet_public_tests.expect_reconsent('T4-C under a newer release, the newer notice', p_n,
    jsonb_build_object('now', p_now, 'consent', _r1_meet_public_tests.form_consent()
      || '{"template_version": "zzz-meet-public-assert-newer"}'::jsonb), 'ok:');
  v_new := _r1_meet_public_tests.live_consent(v_round);
  perform _r1_meet_public_tests.assert(
    'T4-C ... supersedes the old consent (no recording erase) and stores the newer notice''s candidate_web consent',
    (select x.withdrawn_at = p_now and x.proof ->> 'decision' = 'superseded'
       from screening_v2.interview_round_consents x where x.id = v_old)
    and not exists (select 1 from screening_v2.job_queue x
                     where x.name = 'r1.recording.erase' and x.dedup_key = 'r1.recording.erase:' || v_old::text)
    and v_new is distinct from v_old and v_tpl is not null
    and _r1_meet_public_tests.form_consent_ok(v_new, v_tpl, p_now));
  perform _r1_meet_public_tests.assert('T4-C ... and the manage page reads consent_current true',
    (screening_v2.r1_meet_public_manage_read(_r1_meet_public_tests.md(p_n), 3600, 3, p_now)
      -> 'consent_current') = 'true'::jsonb);
  return v_res;
end;
$$;

-- =============================================================================================
-- T4-A. r1_meet_public_move_booking (§18): moves, every refusal in order, the S06 bot path.
-- =============================================================================================
do $$
declare
  t4 constant timestamptz := '2026-12-20 04:00:00+00';
  t5 constant timestamptz := '2026-12-20 05:00:00+00';
  d30 constant timestamptz := '2026-12-30 05:00:00+00';
  far constant timestamptz := '2027-01-03 01:15:00+00';
  sig constant text :=
    'screening_v2.r1_meet_public_move_booking(uuid, text, integer, timestamptz, timestamptz, integer, '
    || 'integer, integer, integer, integer, integer, timestamptz)';
  b uuid;
  r uuid;
  ab uuid;
  res jsonb;
  bk screening_v2.r1_meet_bookings%rowtype;
  rd screening_v2.interview_rounds%rowtype;
  r_version integer;
  reserved_before numeric;
  v_public integer;
  v_total integer;
  bad jsonb;
  f text;
  role_name text;
  s timestamptz;
  n integer;
begin
  -- Every booking of this section first (IST 2026-12-21, 09:00 to 16:00 IST).
  for n in 600..607 loop
    perform _r1_meet_public_tests.t4_book(n);
  end loop;

  -- (1) A move to another IST day: the new slot, a new bot generation, move_count 1, the round's
  -- expiry moved, the calendar move job; the create's ensure_bot job (still pending) absorbs the
  -- move's.
  b := _r1_meet_public_tests.id(40, 600);
  select * into rd from screening_v2.interview_rounds x where x.id = _r1_meet_public_tests.round_of_booking(b);
  r := rd.id;
  r_version := rd.version;
  reserved_before := _r1_meet_public_tests.reserved('2026-12-01');
  res := _r1_meet_public_tests.expect_move('T4-A a move to another IST day', 600,
    jsonb_build_object('start_at', d30, 'end_at', d30 + interval '45 minutes', 'now', t5), 'moved:');
  perform _r1_meet_public_tests.assert('T4-A ... answers moved with exactly the contract fields',
    res = jsonb_build_object('status', 'moved', 'booking_id', b, 'start_at', d30,
                             'end_at', d30 + interval '45 minutes', 'version', 1, 'key_attempt', 0,
                             'move_count', 1), res::text);
  select * into bk from screening_v2.r1_meet_bookings x where x.id = b;
  perform _r1_meet_public_tests.assert(
    'T4-A ... the booking has the new slot, a new bot generation, move_count 1, pending/eligible, the same link, round and digest',
    bk.start_at = d30 and bk.end_at = d30 + interval '45 minutes' and bk.version = 1 and bk.key_attempt = 0
    and bk.move_count = 1 and bk.status = 'pending' and bk.reason = 'eligible' and bk.updated_at = t5
    and bk.meet_url = 'https://meet.google.com/abc-defg-hij' and bk.round_id = r
    and bk.manage_token_digest = _r1_meet_public_tests.md(600) and bk.calendar_state = 'created'
    and bk.ticket_digest is null and bk.recall_bot_id is null and bk.source = 'public_page'
    and bk.ashby_updated_at is null and bk.ashby_interview_event_id is null, to_jsonb(bk)::text);
  select * into rd from screening_v2.interview_rounds x where x.id = r;
  perform _r1_meet_public_tests.assert(
    'T4-A ... the round expires at the new end + 7200 s, version + 1, the same hold and month counter',
    rd.expires_at = d30 + interval '45 minutes' + interval '7200 seconds' and rd.version = r_version + 1
    and rd.updated_at = t5 and rd.status = 'invited' and rd.held_minutes = 65
    and rd.hold_month = '2026-12-01' and _r1_meet_public_tests.reserved('2026-12-01') = reserved_before,
    to_jsonb(rd)::text);
  perform _r1_meet_public_tests.assert(
    'T4-A ... the jobs: the create''s three and calendar move:1 (the pending ensure_bot absorbed the move''s)',
    _r1_meet_public_tests.jobs_of(b)
      = _r1_meet_public_tests.by_key(_r1_meet_public_tests.create_jobs(b)
                                     || jsonb_build_array(_r1_meet_public_tests.move_job(b, 1))),
    _r1_meet_public_tests.jobs_of(b)::text);

  -- (2) A second move within the new day: move_count 2, key move:2. The first ensure_bot job has
  -- completed by then, so the move queues a fresh one (one live ensure_bot either way).
  update screening_v2.job_queue set status = 'completed', completed_at = t5
   where dedup_key = 'r1-meet:ensure-bot:' || b::text;
  res := _r1_meet_public_tests.expect_move('T4-A a second move within the new IST day', 600,
    jsonb_build_object('start_at', d30 + interval '1 hour', 'end_at', d30 + interval '105 minutes', 'now', t5),
    'moved:');
  perform _r1_meet_public_tests.assert('T4-A ... answers move_count 2, version 2, key_attempt 0',
    res = jsonb_build_object('status', 'moved', 'booking_id', b, 'start_at', d30 + interval '1 hour',
                             'end_at', d30 + interval '105 minutes', 'version', 2, 'key_attempt', 0,
                             'move_count', 2), res::text);
  perform _r1_meet_public_tests.assert(
    'T4-A ... queues calendar move:2 and, the first ensure_bot done, one new live ensure_bot',
    _r1_meet_public_tests.jobs_of(b)
      = _r1_meet_public_tests.by_key(_r1_meet_public_tests.create_jobs(b)
          || jsonb_build_array(_r1_meet_public_tests.move_job(b, 1), _r1_meet_public_tests.move_job(b, 2),
                               _r1_meet_public_tests.ensure_job(b)))
    and (select count(*) = 1 from screening_v2.job_queue x
          where x.dedup_key = 'r1-meet:ensure-bot:' || b::text and x.status in ('pending', 'active', 'delayed')),
    _r1_meet_public_tests.jobs_of(b)::text);
  perform _r1_meet_public_tests.assert('T4-A ... the round follows: expiry at the second end + 7200 s, version + 2',
    (select x.expires_at = d30 + interval '105 minutes' + interval '7200 seconds' and x.version = r_version + 2
       from screening_v2.interview_rounds x where x.id = r));

  -- (3) Capacity leaves the booking itself out: one seat and a slot overlapping only its own; the
  -- day's counts (the booking included) as the limits move it, one below them is day_full.
  s := _r1_meet_public_tests.t4_slot(601);
  perform _r1_meet_public_tests.expect_move('T4-A one seat and a slot overlapping only the booking''s own', 601,
    '{"seats": 1}'::jsonb, 'moved:');
  v_public := (screening_v2.r1_meet_public_day_count((s at time zone 'Asia/Kolkata')::date, null) ->> 'public')::integer;
  v_total := (screening_v2.r1_meet_public_day_count((s at time zone 'Asia/Kolkata')::date, null) ->> 'total')::integer;
  perform _r1_meet_public_tests.assert('T4-A fixture: the booking''s IST day counts it and the other T4 bookings',
    v_public >= 2 and v_total >= v_public, format('public %s, total %s', v_public, v_total));
  perform _r1_meet_public_tests.expect_move('T4-A the public limit one below the day''s public count', 601,
    jsonb_build_object('start_at', s + interval '5 minutes', 'end_at', s + interval '50 minutes',
                       'public_limit', v_public - 1), 'refused:day_full');
  perform _r1_meet_public_tests.expect_move('T4-A the bot limit one below the day''s total', 601,
    jsonb_build_object('start_at', s + interval '5 minutes', 'end_at', s + interval '50 minutes',
                       'bot_limit', v_total - 1), 'refused:day_full');
  perform _r1_meet_public_tests.expect_move('T4-A the day''s own counts (the booking included) as the limits, one seat',
    601, jsonb_build_object('start_at', s + interval '5 minutes', 'end_at', s + interval '50 minutes',
                            'public_limit', v_public, 'bot_limit', v_total, 'seats', 1), 'moved:');

  -- (4) invalid_request: every field wrong, then fixed one at a time, answers each field in order.
  s := _r1_meet_public_tests.t4_slot(602);
  bad := jsonb_build_object('booking_id', null, 'digest', 'not-a-digest', 'version', 51, 'start_at', null,
                            'seats', 0, 'public_limit', 0, 'max_moves', 11, 'cutoff', 899, 'grace', 899,
                            'now', null);
  foreach f in array array['booking_id', 'digest', 'version', 'slot', 'seats', 'day_limit', 'max_moves',
                           'cutoff', 'grace', 'now'] loop
    perform _r1_meet_public_tests.expect_move('T4-A every field wrong from ' || f || ' on', 602, bad,
      'invalid_request:' || f);
    bad := bad - case f when 'slot' then 'start_at' when 'day_limit' then 'public_limit' else f end;
  end loop;
  perform _r1_meet_public_tests.expect_move('T4-A an upper-case digest', 602,
    jsonb_build_object('digest', upper(_r1_meet_public_tests.md(602))), 'invalid_request:digest');
  perform _r1_meet_public_tests.expect_move('T4-A a 63-character digest', 602,
    jsonb_build_object('digest', left(_r1_meet_public_tests.md(602), 63)), 'invalid_request:digest');
  perform _r1_meet_public_tests.expect_move('T4-A version -1', 602, '{"version": -1}'::jsonb, 'invalid_request:version');
  perform _r1_meet_public_tests.expect_move('T4-A no version', 602, '{"version": null}'::jsonb, 'invalid_request:version');
  perform _r1_meet_public_tests.expect_move('T4-A a 29-minute slot', 602,
    jsonb_build_object('start_at', s + interval '1 day', 'end_at', s + interval '1 day 29 minutes'), 'invalid_request:slot');
  perform _r1_meet_public_tests.expect_move('T4-A a 61-minute slot', 602,
    jsonb_build_object('start_at', s + interval '1 day', 'end_at', s + interval '1 day 61 minutes'), 'invalid_request:slot');
  perform _r1_meet_public_tests.expect_move('T4-A an end before the start', 602,
    jsonb_build_object('start_at', s + interval '1 day', 'end_at', s + interval '23 hours'), 'invalid_request:slot');
  perform _r1_meet_public_tests.expect_move('T4-A no end', 602, '{"end_at": null}'::jsonb, 'invalid_request:slot');
  perform _r1_meet_public_tests.expect_move('T4-A 16 seats', 602, '{"seats": 16}'::jsonb, 'invalid_request:seats');
  perform _r1_meet_public_tests.expect_move('T4-A a public limit of 201', 602, '{"public_limit": 201}'::jsonb,
    'invalid_request:day_limit');
  perform _r1_meet_public_tests.expect_move('T4-A a bot limit of 0', 602, '{"bot_limit": 0}'::jsonb,
    'invalid_request:day_limit');
  perform _r1_meet_public_tests.expect_move('T4-A no bot limit', 602, '{"bot_limit": null}'::jsonb,
    'invalid_request:day_limit');
  perform _r1_meet_public_tests.expect_move('T4-A max_moves -1', 602, '{"max_moves": -1}'::jsonb,
    'invalid_request:max_moves');
  perform _r1_meet_public_tests.expect_move('T4-A a cutoff of 43201 s', 602, '{"cutoff": 43201}'::jsonb,
    'invalid_request:cutoff');
  perform _r1_meet_public_tests.expect_move('T4-A a grace of 86401 s', 602, '{"grace": 86401}'::jsonb,
    'invalid_request:grace');
  perform _r1_meet_public_tests.expect_move('T4-A an unknown digest and no now: the field first', 602,
    jsonb_build_object('digest', _r1_meet_public_tests.digest('t4-unknown'), 'now', null), 'invalid_request:now');

  -- (5) not_found: the digest must name THIS live public booking before its slot ends.
  perform _r1_meet_public_tests.expect_move('T4-A an unknown digest', 602,
    jsonb_build_object('digest', _r1_meet_public_tests.digest('t4-unknown')), 'refused:not_found');
  perform _r1_meet_public_tests.expect_move('T4-A another booking''s digest', 602,
    jsonb_build_object('digest', _r1_meet_public_tests.md(603)), 'refused:not_found');
  ab := _r1_meet_public_tests.ashby_booking(692, jsonb_build_object('status', 'blocked', 'reason', 'not_scheduled',
          'start_at', '2026-12-31 05:00:00+00'::timestamptz, 'end_at', '2026-12-31 05:45:00+00'::timestamptz));
  perform _r1_meet_public_tests.expect_move('T4-A an Ashby booking id', 602,
    jsonb_build_object('booking_id', ab, 'version', 0), 'refused:not_found');
  res := screening_v2.r1_meet_transition_booking(_r1_meet_public_tests.id(40, 603), 'pending', 'failed',
                                                 'bot_create_failed', t4);
  perform _r1_meet_public_tests.assert('T4-A fixture: booking 603 failed (bot_create_failed)',
    res ->> 'status' = 'ok', res::text);
  perform _r1_meet_public_tests.expect_move('T4-A a failed booking', 603, '{}'::jsonb, 'refused:not_found');
  perform _r1_meet_public_tests.expect_move('T4-A at the slot end (the cutoff has passed too)', 602,
    jsonb_build_object('now', s + interval '45 minutes'), 'refused:not_found');

  -- (6) cutoff_passed, moves_exhausted, same_slot.
  perform _r1_meet_public_tests.expect_move('T4-A one second before the slot end', 602,
    jsonb_build_object('now', s + interval '44 minutes 59 seconds'), 'refused:cutoff_passed');
  perform _r1_meet_public_tests.expect_move('T4-A at start - cutoff with no moves left', 602,
    jsonb_build_object('now', s - interval '1 hour', 'max_moves', 0), 'refused:cutoff_passed');
  perform _r1_meet_public_tests.expect_move('T4-A one second before start - cutoff with no moves left', 602,
    jsonb_build_object('now', s - interval '1 hour 1 second', 'max_moves', 0), 'refused:moves_exhausted');
  perform _r1_meet_public_tests.expect_move('T4-A no moves left and the same slot', 602,
    jsonb_build_object('max_moves', 0, 'start_at', s, 'end_at', s + interval '45 minutes'), 'refused:moves_exhausted');
  perform _r1_meet_public_tests.expect_move('T4-A the same slot', 602,
    jsonb_build_object('start_at', s, 'end_at', s + interval '45 minutes'), 'refused:same_slot');

  -- (7) booking_dispatched (its bot attached, the slot in the past or not), then in_past.
  perform _r1_meet_public_tests.dispatch(605);
  perform _r1_meet_public_tests.expect_move('T4-A a dispatched booking and the same slot', 605,
    jsonb_build_object('start_at', _r1_meet_public_tests.t4_slot(605),
                       'end_at', _r1_meet_public_tests.t4_slot(605) + interval '45 minutes'), 'refused:same_slot');
  perform _r1_meet_public_tests.expect_move('T4-A a dispatched booking (its bot attached)', 605, '{}'::jsonb,
    'refused:booking_dispatched');
  perform _r1_meet_public_tests.expect_move('T4-A a dispatched booking and a slot in the past', 605,
    jsonb_build_object('start_at', t4 - interval '1 hour', 'end_at', t4 - interval '15 minutes'),
    'refused:booking_dispatched');
  perform _r1_meet_public_tests.public_booking(690, _r1_meet_public_tests.blocked()
    || _r1_meet_public_tests.slot(t4 - interval '1 hour'));
  perform _r1_meet_public_tests.assert('T4-A fixture: a live blocked booking holds the past hour',
    screening_v2.r1_meet_public_slot_count(t4 - interval '1 hour', t4 - interval '15 minutes', null) >= 1);
  perform _r1_meet_public_tests.expect_move('T4-A a slot starting now', 602,
    jsonb_build_object('start_at', t4, 'end_at', t4 + interval '45 minutes'), 'refused:in_past');
  perform _r1_meet_public_tests.expect_move('T4-A one seat in a past slot a live booking holds', 602,
    jsonb_build_object('start_at', t4 - interval '1 hour', 'end_at', t4 - interval '15 minutes', 'seats', 1),
    'refused:in_past');

  -- (8) slot_too_far, slot_full, day_full (public and total), version_conflict. A live blocked
  -- public booking sits at the 14-day bound (end + 7200 s = now + 14 days), a live blocked Ashby
  -- booking on IST 2026-12-31.
  perform _r1_meet_public_tests.public_booking(691, _r1_meet_public_tests.blocked()
    || jsonb_build_object('start_at', far, 'end_at', far + interval '45 minutes'));
  perform _r1_meet_public_tests.expect_move('T4-A an expiry one second past now + 14 days, one seat, a live booking there',
    602, jsonb_build_object('start_at', far + interval '1 second', 'end_at', far + interval '45 minutes 1 second',
                            'seats', 1), 'refused:slot_too_far');
  perform _r1_meet_public_tests.expect_move('T4-A an expiry exactly at now + 14 days, one seat, the day''s public limit 1',
    602, jsonb_build_object('start_at', far, 'end_at', far + interval '45 minutes', 'seats', 1, 'public_limit', 1),
    'refused:slot_full');
  perform _r1_meet_public_tests.expect_move('T4-A two seats there and the day''s public limit 1', 602,
    jsonb_build_object('start_at', far, 'end_at', far + interval '45 minutes', 'public_limit', 1), 'refused:day_full');
  perform _r1_meet_public_tests.expect_move('T4-A the bot limit 1 on a day with one live Ashby booking, a stale version too',
    602, jsonb_build_object('start_at', '2026-12-31 08:00:00+00'::timestamptz,
                            'end_at', '2026-12-31 08:45:00+00'::timestamptz, 'bot_limit', 1, 'version', 7),
    'refused:day_full');
  perform _r1_meet_public_tests.expect_move('T4-A a stale version', 602,
    jsonb_build_object('start_at', '2026-12-31 08:00:00+00'::timestamptz,
                       'end_at', '2026-12-31 08:45:00+00'::timestamptz, 'version', 7), 'refused:version_conflict');

  -- (9) A bot attached: version_conflict and capacity come first, then bot_attached; the S06 path
  -- (Recall removes the bot, r1_meet_set_bot replace, the move with the new version) moves it.
  perform _r1_meet_public_tests.attach(604);
  perform _r1_meet_public_tests.expect_move('T4-A a stale version and a bot attached', 604, '{"version": 1}'::jsonb,
    'refused:version_conflict');
  perform _r1_meet_public_tests.expect_move('T4-A one seat in a slot a live booking holds, a bot attached', 604,
    jsonb_build_object('start_at', _r1_meet_public_tests.t4_slot(605),
                       'end_at', _r1_meet_public_tests.t4_slot(605) + interval '45 minutes', 'seats', 1),
    'refused:slot_full');
  perform _r1_meet_public_tests.expect_move('T4-A a bot attached', 604, '{}'::jsonb, 'refused:bot_attached');
  res := screening_v2.r1_meet_set_bot(_r1_meet_public_tests.id(40, 604), 'replace', 0, 0, null, t4);
  perform _r1_meet_public_tests.assert('T4-A fixture: S06 replaces the bot (a new generation, pending)',
    res ->> 'status' = 'ok' and (res ->> 'version')::integer = 1 and res ->> 'booking_status' = 'pending', res::text);
  perform _r1_meet_public_tests.expect_move('T4-A after set_bot replace, the version read before it', 604,
    '{"version": 0}'::jsonb, 'refused:version_conflict');
  res := _r1_meet_public_tests.expect_move('T4-A after set_bot replace, the new version: the S06 bot path moves', 604,
    '{"version": 1}'::jsonb, 'moved:');
  perform _r1_meet_public_tests.assert('T4-A ... a further generation, no bot, move_count 1',
    (res ->> 'version')::integer = 2 and (res ->> 'key_attempt')::integer = 0 and (res ->> 'move_count')::integer = 1
    and (select x.recall_bot_id is null and x.status = 'pending'
           from screening_v2.r1_meet_bookings x where x.id = _r1_meet_public_tests.id(40, 604)), res::text);

  -- (10) The reschedule's version_exhausted at generation 50 answers moves_exhausted.
  update screening_v2.r1_meet_bookings set version = 50 where id = _r1_meet_public_tests.id(40, 606);
  perform _r1_meet_public_tests.expect_move('T4-A at bot generation 50 with a stale version', 606,
    '{"version": 49}'::jsonb, 'refused:version_conflict');
  perform _r1_meet_public_tests.expect_move('T4-A at bot generation 50 (the reschedule''s version_exhausted)', 606,
    '{"version": 50}'::jsonb, 'refused:moves_exhausted');

  -- (11) round_not_live: HR cancels the round in the app (0142 queues its round_cancelled job);
  -- with the bot still attached the move answers bot_attached, after the replace round_not_live.
  perform _r1_meet_public_tests.attach(607);
  r := _r1_meet_public_tests.round_of_booking(_r1_meet_public_tests.id(40, 607));
  res := screening_v2.r1_transition_round(r, 'cancel', _r1_meet_public_tests.round_version(r), null, null, t4);
  perform _r1_meet_public_tests.assert('T4-A fixture: HR cancels the round of booking 607',
    res ->> 'status' = 'ok', res::text);
  perform _r1_meet_public_tests.expect_move('T4-A a bot attached and the round cancelled', 607, '{}'::jsonb,
    'refused:bot_attached');
  res := screening_v2.r1_meet_set_bot(_r1_meet_public_tests.id(40, 607), 'replace', 0, 0, null, t4);
  perform _r1_meet_public_tests.assert('T4-A fixture: booking 607''s bot replaced', res ->> 'status' = 'ok', res::text);
  perform _r1_meet_public_tests.expect_move('T4-A the round cancelled by HR', 607, '{}'::jsonb, 'refused:round_not_live');

  -- (12) Catalog posture.
  perform _r1_meet_public_tests.assert('T4-A the move is one security definer, volatile function returning jsonb',
    (select x.prosecdef and x.provolatile = 'v'
            and x.proconfig = array['search_path=pg_catalog, screening_v2']
            and x.prorettype = 'jsonb'::regtype and x.pronargs = 12 and x.pronargdefaults = 2
       from pg_proc x where x.oid = sig::regprocedure)
    and (select count(*) = 1 from pg_proc x
          where x.pronamespace = 'screening_v2'::regnamespace and x.proname = 'r1_meet_public_move_booking'));
  perform _r1_meet_public_tests.assert('T4-A the move is executable by service_role only',
    has_function_privilege('service_role', sig, 'execute')
    and not has_function_privilege('anon', sig, 'execute')
    and not has_function_privilege('authenticated', sig, 'execute')
    and not has_function_privilege('public', sig, 'execute'));
  foreach role_name in array array['anon', 'authenticated'] loop
    perform _r1_meet_public_tests.raises_as(role_name, 'T4-A execute r1_meet_public_move_booking',
      'select screening_v2.r1_meet_public_move_booking(null, null, null, null, null, null, null, null, null, null)',
      '42501');
  end loop;
end;
$$;

-- =============================================================================================
-- T4-B. r1_meet_public_cancel_booking (§19).
-- =============================================================================================
do $$
declare
  t4 constant timestamptz := '2026-12-20 04:00:00+00';
  t5 constant timestamptz := '2026-12-20 05:00:00+00';
  sig constant text := 'screening_v2.r1_meet_public_cancel_booking(text, boolean, integer, timestamptz)';
  b uuid;
  r uuid;
  k uuid;
  ab uuid;
  bot uuid;
  res jsonb;
  bk screening_v2.r1_meet_bookings%rowtype;
  rd screening_v2.interview_rounds%rowtype;
  r_version integer;
  reserved_before numeric;
  s timestamptz;
  bad jsonb;
  f text;
  role_name text;
begin
  -- (1) A pending booking, the consent kept: the booking, then the round (hold refunded), the
  -- §3 trigger's two jobs, and no round_cancelled job.
  b := _r1_meet_public_tests.t4_book(620);
  r := _r1_meet_public_tests.round_of_booking(b);
  k := _r1_meet_public_tests.live_consent(r);
  r_version := _r1_meet_public_tests.round_version(r);
  reserved_before := _r1_meet_public_tests.reserved('2026-12-01');
  res := _r1_meet_public_tests.expect_cancel('T4-B a pending booking, the consent kept', 620,
    jsonb_build_object('now', t5), 'cancelled:');
  perform _r1_meet_public_tests.assert('T4-B ... answers exactly cancelled and the booking id',
    res = jsonb_build_object('status', 'cancelled', 'booking_id', b), res::text);
  select * into bk from screening_v2.r1_meet_bookings x where x.id = b;
  perform _r1_meet_public_tests.assert('T4-B ... the booking is cancelled/candidate_cancelled at now',
    bk.status = 'cancelled' and bk.reason = 'candidate_cancelled' and bk.updated_at = t5 and bk.round_id = r
    and bk.calendar_state = 'created' and bk.move_count = 0 and bk.manage_token_digest = _r1_meet_public_tests.md(620),
    to_jsonb(bk)::text);
  select * into rd from screening_v2.interview_rounds x where x.id = r;
  perform _r1_meet_public_tests.assert(
    'T4-B ... the round is cancelled through r1_transition_round and its 65-minute hold refunded',
    rd.status = 'cancelled' and rd.version = r_version + 1 and rd.held_minutes = 0 and rd.updated_at = t5
    and _r1_meet_public_tests.reserved('2026-12-01') = reserved_before - 65, to_jsonb(rd)::text);
  perform _r1_meet_public_tests.assert('T4-B ... the consent stays live (no withdrawal asked), no erase job',
    _r1_meet_public_tests.live_consent(r) = k
    and not exists (select 1 from screening_v2.job_queue x
                     where x.name = 'r1.recording.erase' and x.dedup_key = 'r1.recording.erase:' || k::text));
  perform _r1_meet_public_tests.assert(
    'T4-B ... the jobs: the create''s three, the calendar cancel and the Ashby tag removal (the terminal trigger)',
    _r1_meet_public_tests.jobs_of(b)
      = _r1_meet_public_tests.by_key(_r1_meet_public_tests.create_jobs(b) || _r1_meet_public_tests.terminal_jobs(b, true)),
    _r1_meet_public_tests.jobs_of(b)::text);
  perform _r1_meet_public_tests.assert(
    'T4-B ... and no round_cancelled job (0142''s trigger found no live booking on the round)',
    not _r1_meet_public_tests.round_cancelled_job(b));

  res := _r1_meet_public_tests.expect_cancel('T4-B the same cancel again', 620, jsonb_build_object('now', t5),
    'already_cancelled:');
  perform _r1_meet_public_tests.assert('T4-B ... answers exactly already_cancelled',
    res = '{"status": "already_cancelled"}'::jsonb, res::text);
  perform _r1_meet_public_tests.expect_cancel('T4-B ... and again, withdrawing the consent', 620,
    jsonb_build_object('now', t5, 'withdraw', true), 'already_cancelled:');
  perform _r1_meet_public_tests.expect_cancel('T4-B ... and after its slot ended', 620,
    jsonb_build_object('now', _r1_meet_public_tests.t4_slot(620) + interval '45 minutes'), 'refused:not_found');
  perform _r1_meet_public_tests.assert('T4-B ... the manage page reads not_found',
    screening_v2.r1_meet_public_manage_read(_r1_meet_public_tests.md(620), 3600, 3, t5) = '{"status": "not_found"}'::jsonb);

  -- A cancel is not a completed R1: the candidate books the freed slot again (one seat), a new round.
  perform _r1_meet_public_tests.assert('T4-B after the cancel the precheck answers eligible',
    _r1_meet_public_tests.pre(620, t5) = 'eligible', _r1_meet_public_tests.pre(620, t5));
  res := _r1_meet_public_tests.create(620, jsonb_build_object(
    'booking_id', _r1_meet_public_tests.id(40, 6201), 'request_id', _r1_meet_public_tests.id(41, 6201),
    'start_at', _r1_meet_public_tests.t4_slot(620), 'end_at', _r1_meet_public_tests.t4_slot(620) + interval '45 minutes',
    'seats', 1, 'now', t5));
  perform _r1_meet_public_tests.assert('T4-B after the cancel the candidate books the freed slot again: a new round',
    _r1_meet_public_tests.outcome(res) = 'booked:created' and (res ->> 'round_id')::uuid <> r
    and _r1_meet_public_tests.reserved('2026-12-01') = reserved_before, res::text);

  -- (2) A booking with a bot, an unclaimed ticket and a sent invite, withdrawing the consent.
  b := _r1_meet_public_tests.t4_book(621);
  r := _r1_meet_public_tests.round_of_booking(b);
  k := _r1_meet_public_tests.live_consent(r);
  bot := _r1_meet_public_tests.id(30, 621);
  res := screening_v2.r1_meet_public_set_calendar_state(b, array['created'], 'invited', t4);
  perform _r1_meet_public_tests.assert('T4-B fixture: the invite was sent', res ->> 'status' = 'ok', res::text);
  perform _r1_meet_public_tests.attach(621);
  update screening_v2.r1_meet_bookings
     set ticket_digest = _r1_meet_public_tests.digest('t4-ticket-621'), ticket_not_before = t4,
         ticket_expires_at = t4 + interval '1 day'
   where id = b;
  reserved_before := _r1_meet_public_tests.reserved('2026-12-01');
  res := _r1_meet_public_tests.expect_cancel(
    'T4-B a booking with a bot, an unclaimed ticket and a sent invite, withdrawing the consent', 621,
    jsonb_build_object('now', t5, 'withdraw', true), 'cancelled:');
  select * into bk from screening_v2.r1_meet_bookings x where x.id = b;
  perform _r1_meet_public_tests.assert(
    'T4-B ... the unclaimed ticket is cleared; the bot id stays until its release is confirmed',
    bk.status = 'cancelled' and bk.reason = 'candidate_cancelled' and bk.ticket_digest is null
    and bk.ticket_not_before is null and bk.ticket_expires_at is null and bk.ticket_claimed_at is null
    and bk.recall_bot_id = bot and bk.updated_at = t5 and bk.calendar_state = 'invited', to_jsonb(bk)::text);
  perform _r1_meet_public_tests.assert('T4-B ... the round is cancelled and its hold refunded',
    (select x.status = 'cancelled' and x.held_minutes = 0 from screening_v2.interview_rounds x where x.id = r)
    and _r1_meet_public_tests.reserved('2026-12-01') = reserved_before - 65);
  perform _r1_meet_public_tests.assert(
    'T4-B ... the consent is withdrawn through r1_withdraw_consent (decision withdrawn, the source in its withdrawal proof)',
    (select x.withdrawn_at = t5 and x.proof ->> 'decision' = 'withdrawn'
            and x.proof -> 'withdrawal' = '{"source": "r1_public_booking"}'::jsonb
            and (x.proof ->> 'withdrawn_at')::timestamptz = t5
            and x.proof ->> 'source' = 'r1_public_booking' and x.proof ->> 'india_location_confirmed' = 'true'
       from screening_v2.interview_round_consents x where x.id = k)
    and _r1_meet_public_tests.live_consent(r) is null);
  perform _r1_meet_public_tests.assert('T4-B ... which queues exactly the existing 0127 recording erase job',
    (select count(*) = 1
            and bool_and(x.payload = jsonb_build_object('round_id', r, 'reason', 'consent_withdrawn')
                         and x.max_attempts = 5)
       from screening_v2.job_queue x
      where x.name = 'r1.recording.erase' and x.dedup_key = 'r1.recording.erase:' || k::text));
  perform _r1_meet_public_tests.assert(
    'T4-B ... the jobs: the create''s three, the calendar cancel, the tag removal and the bot release (0142 key)',
    _r1_meet_public_tests.jobs_of(b)
      = _r1_meet_public_tests.by_key(_r1_meet_public_tests.create_jobs(b) || _r1_meet_public_tests.terminal_jobs(b, true)
                                     || jsonb_build_array(_r1_meet_public_tests.release_job(b, bot))),
    _r1_meet_public_tests.jobs_of(b)::text);
  perform _r1_meet_public_tests.assert('T4-B ... and no round_cancelled job', not _r1_meet_public_tests.round_cancelled_job(b));

  -- (3) A claimed ticket stays as evidence.
  b := _r1_meet_public_tests.t4_book(622);
  perform _r1_meet_public_tests.attach(622);
  update screening_v2.r1_meet_bookings
     set ticket_digest = _r1_meet_public_tests.digest('t4-ticket-622'), ticket_not_before = t4,
         ticket_expires_at = t4 + interval '1 day', ticket_claimed_at = t4
   where id = b;
  perform _r1_meet_public_tests.expect_cancel('T4-B a booking whose ticket was claimed', 622, '{}'::jsonb, 'cancelled:');
  perform _r1_meet_public_tests.assert('T4-B ... the claimed ticket stays as evidence',
    (select x.status = 'cancelled' and x.ticket_digest = _r1_meet_public_tests.digest('t4-ticket-622')
            and x.ticket_not_before = t4 and x.ticket_expires_at = t4 + interval '1 day' and x.ticket_claimed_at = t4
       from screening_v2.r1_meet_bookings x where x.id = b));

  -- (4) not_found: unknown, another terminal booking, another cancel reason, an Ashby row, the end.
  perform _r1_meet_public_tests.expect_cancel('T4-B an unknown digest', 620,
    jsonb_build_object('digest', _r1_meet_public_tests.digest('t4-unknown')), 'refused:not_found');
  b := _r1_meet_public_tests.t4_book(623);
  res := screening_v2.r1_meet_transition_booking(b, 'pending', 'failed', 'bot_create_failed', t4);
  perform _r1_meet_public_tests.assert('T4-B fixture: booking 623 failed', res ->> 'status' = 'ok', res::text);
  perform _r1_meet_public_tests.expect_cancel('T4-B a failed booking', 623, '{}'::jsonb, 'refused:not_found');
  b := _r1_meet_public_tests.t4_book(624);
  res := screening_v2.r1_meet_cancel_booking(b, 'event_removed', t4);
  perform _r1_meet_public_tests.assert('T4-B fixture: booking 624 cancelled (event_removed)', res ->> 'status' = 'ok', res::text);
  perform _r1_meet_public_tests.expect_cancel('T4-B a booking cancelled for another reason (event_removed)', 624,
    '{}'::jsonb, 'refused:not_found');
  ab := _r1_meet_public_tests.ashby_booking(694, jsonb_build_object('status', 'blocked', 'reason', 'not_scheduled',
          'start_at', '2026-12-31 07:00:00+00'::timestamptz, 'end_at', '2026-12-31 07:45:00+00'::timestamptz));
  res := _r1_meet_public_tests.in_rollback(array[
      'alter table screening_v2.r1_meet_bookings drop constraint chk_r1_meet_bookings_public_columns',
      format('update screening_v2.r1_meet_bookings set manage_token_digest = %L where id = %L',
             _r1_meet_public_tests.md(694), ab)],
    format('select jsonb_build_object(''cancel'', screening_v2.r1_meet_public_cancel_booking(%L, false, 3600, %L), '
           '''status'', (select x.status from screening_v2.r1_meet_bookings x where x.id = %L))',
           _r1_meet_public_tests.md(694), t4, ab));
  perform _r1_meet_public_tests.assert(
    'T4-B a live Ashby booking holding the digest (CHECK lifted, rolled back): not_found, untouched',
    res = '{"cancel": {"status": "refused", "code": "not_found"}, "status": "blocked"}'::jsonb, res::text);

  -- (5) The slot end, the cutoff, a dispatched bot.
  b := _r1_meet_public_tests.t4_book(625);
  s := _r1_meet_public_tests.t4_slot(625);
  perform _r1_meet_public_tests.expect_cancel('T4-B at the slot end', 625,
    jsonb_build_object('now', s + interval '45 minutes'), 'refused:not_found');
  perform _r1_meet_public_tests.expect_cancel('T4-B at start - cutoff', 625,
    jsonb_build_object('now', s - interval '1 hour'), 'refused:cutoff_passed');
  b := _r1_meet_public_tests.t4_book(626);
  perform _r1_meet_public_tests.dispatch(626);
  perform _r1_meet_public_tests.expect_cancel('T4-B a dispatched booking at start - cutoff', 626,
    jsonb_build_object('now', _r1_meet_public_tests.t4_slot(626) - interval '1 hour'), 'refused:cutoff_passed');
  perform _r1_meet_public_tests.expect_cancel('T4-B a dispatched booking', 626, '{}'::jsonb, 'refused:booking_dispatched');
  perform _r1_meet_public_tests.expect_cancel('T4-B one second before start - cutoff', 625,
    jsonb_build_object('now', s - interval '1 hour 1 second'), 'cancelled:');

  -- (6) The round already expired (as the sweep would): the booking is cancelled, the round left
  -- as it is (r1_transition_round is not called), the consent still withdrawn on request.
  b := _r1_meet_public_tests.t4_book(627);
  r := _r1_meet_public_tests.round_of_booking(b);
  res := screening_v2.r1_transition_round(r, 'expire', _r1_meet_public_tests.round_version(r), null, null, t4);
  perform _r1_meet_public_tests.assert('T4-B fixture: the round of booking 627 expired', res ->> 'status' = 'ok', res::text);
  select * into rd from screening_v2.interview_rounds x where x.id = r;
  reserved_before := _r1_meet_public_tests.reserved('2026-12-01');
  perform _r1_meet_public_tests.expect_cancel('T4-B a booking whose round already expired, withdrawing the consent', 627,
    jsonb_build_object('withdraw', true), 'cancelled:');
  perform _r1_meet_public_tests.assert('T4-B ... the booking is cancelled; the expired round is left as it was',
    (select x.status = 'cancelled' and x.reason = 'candidate_cancelled' from screening_v2.r1_meet_bookings x where x.id = b)
    and (select to_jsonb(x) = to_jsonb(rd) from screening_v2.interview_rounds x where x.id = r)
    and _r1_meet_public_tests.reserved('2026-12-01') = reserved_before);
  perform _r1_meet_public_tests.assert('T4-B ... and its consent is withdrawn', _r1_meet_public_tests.live_consent(r) is null);

  -- (7) The round's version moves after the cancel read it (a concurrent writer): one retry.
  b := _r1_meet_public_tests.t4_book(628);
  r := _r1_meet_public_tests.round_of_booking(b);
  r_version := _r1_meet_public_tests.round_version(r);
  execute format('create trigger t4_bump_round before update of status on screening_v2.r1_meet_bookings '
                 'for each row when (new.id = %L::uuid and new.status = %L) '
                 'execute function _r1_meet_public_tests.bump_round()', b, 'cancelled');
  perform _r1_meet_public_tests.expect_cancel('T4-B the round version moves during the cancel: one retry cancels it', 628,
    '{}'::jsonb, 'cancelled:');
  drop trigger t4_bump_round on screening_v2.r1_meet_bookings;
  perform _r1_meet_public_tests.assert('T4-B ... the round is cancelled at the moved version, its hold refunded',
    (select x.status = 'cancelled' and x.version = r_version + 2 and x.held_minutes = 0
       from screening_v2.interview_rounds x where x.id = r));

  -- (8) Fail closed: a round r1_transition_round cannot cancel (its hold month row is missing).
  b := _r1_meet_public_tests.t4_book(629);
  r := _r1_meet_public_tests.round_of_booking(b);
  perform _r1_meet_public_tests.assert('T4-B fixture: no budget month 2031-07',
    not exists (select 1 from screening_v2.r1_budget_month x where x.month_start = '2031-07-01'));
  update screening_v2.interview_rounds set hold_month = '2031-07-01' where id = r;
  perform _r1_meet_public_tests.raises(
    'T4-B a round whose hold month row is missing: the cancel raises',
    'select _r1_meet_public_tests.cancel(629)', 'P0001');
  perform _r1_meet_public_tests.assert('T4-B ... and nothing of it stays: booking pending, round invited, the create''s jobs',
    (select x.status = 'pending' from screening_v2.r1_meet_bookings x where x.id = b)
    and (select x.status = 'invited' and x.held_minutes = 65 from screening_v2.interview_rounds x where x.id = r)
    and _r1_meet_public_tests.jobs_of(b) = _r1_meet_public_tests.create_jobs(b));
  update screening_v2.interview_rounds set hold_month = '2026-12-01' where id = r;

  -- (9) A live public booking without a round (blocked, inserted directly): cancelled, no round
  -- touched, the withdrawal skipped.
  b := _r1_meet_public_tests.public_booking(695, _r1_meet_public_tests.blocked()
    || _r1_meet_public_tests.slot(_r1_meet_public_tests.t4_slot(695))
    || jsonb_build_object('manage_token_digest', _r1_meet_public_tests.md(695)));
  perform _r1_meet_public_tests.expect_cancel('T4-B a live public booking with no round, withdrawing the consent', 695,
    jsonb_build_object('withdraw', true), 'cancelled:');
  perform _r1_meet_public_tests.assert('T4-B ... is cancelled with the calendar cancel and the tag removal only',
    (select x.status = 'cancelled' and x.reason = 'candidate_cancelled' from screening_v2.r1_meet_bookings x where x.id = b)
    and _r1_meet_public_tests.jobs_of(b) = _r1_meet_public_tests.terminal_jobs(b, true),
    _r1_meet_public_tests.jobs_of(b)::text);

  -- (10) invalid_request: every field wrong, then fixed one at a time.
  bad := jsonb_build_object('digest', null, 'withdraw', null, 'cutoff', 899, 'now', null);
  foreach f in array array['digest', 'withdraw_consent', 'cutoff', 'now'] loop
    perform _r1_meet_public_tests.expect_cancel('T4-B every field wrong from ' || f || ' on', 620, bad,
      'invalid_request:' || f);
    bad := bad - case f when 'withdraw_consent' then 'withdraw' else f end;
  end loop;
  perform _r1_meet_public_tests.expect_cancel('T4-B an upper-case digest', 620,
    jsonb_build_object('digest', upper(_r1_meet_public_tests.md(620))), 'invalid_request:digest');
  perform _r1_meet_public_tests.expect_cancel('T4-B a cutoff of 43201 s', 620, '{"cutoff": 43201}'::jsonb,
    'invalid_request:cutoff');

  -- (11) Catalog posture.
  perform _r1_meet_public_tests.assert('T4-B the cancel is one security definer, volatile function returning jsonb',
    (select x.prosecdef and x.provolatile = 'v'
            and x.proconfig = array['search_path=pg_catalog, screening_v2']
            and x.prorettype = 'jsonb'::regtype and x.pronargs = 4 and x.pronargdefaults = 1
       from pg_proc x where x.oid = sig::regprocedure)
    and (select count(*) = 1 from pg_proc x
          where x.pronamespace = 'screening_v2'::regnamespace and x.proname = 'r1_meet_public_cancel_booking'));
  perform _r1_meet_public_tests.assert('T4-B the cancel is executable by service_role only',
    has_function_privilege('service_role', sig, 'execute')
    and not has_function_privilege('anon', sig, 'execute')
    and not has_function_privilege('authenticated', sig, 'execute')
    and not has_function_privilege('public', sig, 'execute'));
  foreach role_name in array array['anon', 'authenticated'] loop
    perform _r1_meet_public_tests.raises_as(role_name, 'T4-B execute r1_meet_public_cancel_booking',
      'select screening_v2.r1_meet_public_cancel_booking(null, null, null)', '42501');
  end loop;
end;
$$;

-- =============================================================================================
-- T4-C. r1_meet_public_reconsent (§20).
-- =============================================================================================
do $$
declare
  t4 constant timestamptz := '2026-12-20 04:00:00+00';
  t5 constant timestamptz := '2026-12-20 05:00:00+00';
  tpl constant uuid := _r1_meet_public_tests.id(3, 1);
  sig constant text := 'screening_v2.r1_meet_public_reconsent(text, jsonb, timestamptz)';
  older constant jsonb := _r1_meet_public_tests.form_consent()
                          || '{"template_version": "zz-meet-public-assert-older"}'::jsonb;
  b uuid;
  r uuid;
  k uuid;
  k2 uuid;
  res jsonb;
  bk screening_v2.r1_meet_bookings%rowtype;
  rd screening_v2.interview_rounds%rowtype;
  bad jsonb;
  f text;
  shape jsonb;
  stored jsonb;
  i integer := 0;
  role_name text;
begin
  -- (1) The same notice again: the live consent superseded, a new candidate_web row; nothing else.
  b := _r1_meet_public_tests.t4_book(640);
  r := _r1_meet_public_tests.round_of_booking(b);
  k := _r1_meet_public_tests.live_consent(r);
  select * into bk from screening_v2.r1_meet_bookings x where x.id = b;
  select * into rd from screening_v2.interview_rounds x where x.id = r;
  res := _r1_meet_public_tests.expect_reconsent('T4-C a re-consent on the current notice', 640,
    jsonb_build_object('now', t5), 'ok:');
  perform _r1_meet_public_tests.assert('T4-C ... answers exactly ok', res = '{"status": "ok"}'::jsonb, res::text);
  perform _r1_meet_public_tests.assert('T4-C ... supersedes the live consent (no recording erase)',
    (select x.withdrawn_at = t5 and x.proof ->> 'decision' = 'superseded'
            and (x.proof ->> 'superseded_at')::timestamptz = t5
       from screening_v2.interview_round_consents x where x.id = k)
    and not exists (select 1 from screening_v2.job_queue x
                     where x.name = 'r1.recording.erase' and x.dedup_key = 'r1.recording.erase:' || k::text));
  k2 := _r1_meet_public_tests.live_consent(r);
  perform _r1_meet_public_tests.assert(
    'T4-C ... and inserts the candidate_web consent of the form, the nine proof fields exactly',
    k2 is distinct from k and _r1_meet_public_tests.form_consent_ok(k2, tpl, t5)
    and (select count(*) = 2 from screening_v2.interview_round_consents x where x.round_id = r));
  perform _r1_meet_public_tests.assert('T4-C ... the booking, the round and the jobs are untouched',
    (select to_jsonb(x) = to_jsonb(bk) from screening_v2.r1_meet_bookings x where x.id = b)
    and (select to_jsonb(x) = to_jsonb(rd) from screening_v2.interview_rounds x where x.id = r)
    and _r1_meet_public_tests.jobs_of(b) = _r1_meet_public_tests.create_jobs(b));

  -- (2) A newer release: the older notice is stale, the newer one is accepted (rolled back).
  perform _r1_meet_public_tests.t4_book(641);
  res := _r1_meet_public_tests.under_release('zzz-meet-public-assert-newer', 'en-IN',
    '["ai_interview", "video_audio_recording", "ai_evaluation", "data_processing"]'::jsonb,
    format('select _r1_meet_public_tests.t4_newer(%s, %L)', 641, t5));
  perform _r1_meet_public_tests.assert('T4-C under a newer release the newer notice answers ok (rolled back)',
    res = '{"status": "ok"}'::jsonb, coalesce(res::text, 'null'));

  -- (3) After a withdrawal: the withdrawn row keeps its decision, the new one is live and current.
  b := _r1_meet_public_tests.t4_book(642);
  r := _r1_meet_public_tests.round_of_booking(b);
  k := _r1_meet_public_tests.live_consent(r);
  perform screening_v2.r1_withdraw_consent(r, '{}'::jsonb, t4, 'withdrawn');
  perform _r1_meet_public_tests.assert('T4-C fixture: withdrawn, the manage page reads consent_current false',
    (screening_v2.r1_meet_public_manage_read(_r1_meet_public_tests.md(642), 3600, 3, t4) -> 'consent_current')
      = 'false'::jsonb);
  perform _r1_meet_public_tests.expect_reconsent('T4-C after the candidate withdrew', 642,
    jsonb_build_object('now', t5), 'ok:');
  perform _r1_meet_public_tests.assert('T4-C ... the withdrawn consent keeps its decision; the new one is live and current',
    (select x.proof ->> 'decision' = 'withdrawn' and x.withdrawn_at = t4
       from screening_v2.interview_round_consents x where x.id = k)
    and _r1_meet_public_tests.form_consent_ok(_r1_meet_public_tests.live_consent(r), tpl, t5)
    and (screening_v2.r1_meet_public_manage_read(_r1_meet_public_tests.md(642), 3600, 3, t5) -> 'consent_current')
      = 'true'::jsonb);

  -- (4) consent_stale and consent_incomplete.
  perform _r1_meet_public_tests.t4_book(643);
  res := _r1_meet_public_tests.under_release('zzz-meet-public-assert-staff-only', 'en-IN-x-staff',
    '["ai_interview"]'::jsonb,
    format('select _r1_meet_public_tests.expect_reconsent(%L, %s, %L::jsonb, %L)',
           'T4-C the newest release has no notice for the round''s audience', 643,
           jsonb_build_object('consent', _r1_meet_public_tests.form_consent()
             || '{"template_version": "zzz-meet-public-assert-staff-only"}'::jsonb),
           'refused:consent_stale'));
  perform _r1_meet_public_tests.assert('T4-C ... (rolled back) answered consent_stale',
    res = '{"status": "refused", "code": "consent_stale"}'::jsonb, coalesce(res::text, 'null'));
  perform _r1_meet_public_tests.expect_reconsent('T4-C a notice that is not the newest', 643,
    jsonb_build_object('consent', older), 'refused:consent_stale');
  perform _r1_meet_public_tests.expect_reconsent('T4-C a stale notice and no India tick: consent_stale first', 643,
    jsonb_build_object('consent', older || '{"in_india": false}'::jsonb), 'refused:consent_stale');
  perform _r1_meet_public_tests.expect_reconsent('T4-C a required consent not granted', 643,
    jsonb_build_object('consent', _r1_meet_public_tests.form_consent()
      || '{"consents": ["ai_interview", "video_audio_recording", "ai_evaluation"]}'::jsonb),
    'refused:consent_incomplete');
  perform _r1_meet_public_tests.expect_reconsent('T4-C no India tick', 643,
    jsonb_build_object('consent', _r1_meet_public_tests.form_consent() || '{"in_india": false}'::jsonb),
    'refused:consent_incomplete');

  -- (4b) The round's audience decides the notice: a staff round (inserted directly, its public
  -- booking too) is re-checked against the staff notice of the newest release (rolled back), which
  -- may require more than the en-IN one.
  perform _r1_meet_public_tests.candidate(696, false);
  r := _r1_meet_public_tests.round(696, 'invited', 'meet',
         _r1_meet_public_tests.t4_slot(696) + interval '45 minutes' + interval '7200 seconds');
  update screening_v2.interview_rounds set consent_locale = 'en-IN-x-staff' where id = r;
  perform _r1_meet_public_tests.public_booking(696, _r1_meet_public_tests.slot(_r1_meet_public_tests.t4_slot(696))
    || jsonb_build_object('manage_token_digest', _r1_meet_public_tests.md(696)));
  res := _r1_meet_public_tests.in_rollback(array[
      'insert into screening_v2.interview_round_consent_templates (version, locale, title, body_md, required_consents, is_active) '
      || 'values (''zzz-meet-public-assert-staff'', ''en-IN'', ''R1 Meet public assertion newer notice'', ''fixture'', '
      || '''["ai_interview"]''::jsonb, true)',
      'insert into screening_v2.interview_round_consent_templates (version, locale, title, body_md, required_consents, is_active) '
      || 'values (''zzz-meet-public-assert-staff'', ''en-IN-x-staff'', ''R1 Meet public assertion staff notice'', ''fixture'', '
      || '''["ai_interview", "staff_recording"]''::jsonb, true)'],
    format('select _r1_meet_public_tests.reconsent(696, %L::jsonb)', jsonb_build_object('consent',
      _r1_meet_public_tests.form_consent()
      || '{"template_version": "zzz-meet-public-assert-staff", "consents": ["ai_interview"]}'::jsonb)));
  perform _r1_meet_public_tests.assert(
    'T4-C a staff round whose staff notice requires more than the form granted: consent_incomplete',
    res = '{"status": "refused", "code": "consent_incomplete"}'::jsonb, coalesce(res::text, 'null'));
  stored := _r1_meet_public_tests.in_rollback(array[
      'insert into screening_v2.interview_round_consent_templates (version, locale, title, body_md, required_consents, is_active) '
      || 'values (''zzz-meet-public-assert-staff'', ''en-IN'', ''R1 Meet public assertion newer notice'', ''fixture'', '
      || '''["ai_interview"]''::jsonb, true)',
      'insert into screening_v2.interview_round_consent_templates (version, locale, title, body_md, required_consents, is_active) '
      || 'values (''zzz-meet-public-assert-staff'', ''en-IN-x-staff'', ''R1 Meet public assertion staff notice'', ''fixture'', '
      || '''["ai_interview", "staff_recording"]''::jsonb, true)',
      format('select _r1_meet_public_tests.assert(%L, _r1_meet_public_tests.reconsent(696, %L::jsonb) = %L::jsonb)',
             'T4-C ... granting the staff notice''s set re-consents the staff round (rolled back)',
             jsonb_build_object('consent', _r1_meet_public_tests.form_consent()
               || '{"template_version": "zzz-meet-public-assert-staff", "consents": ["ai_interview", "staff_recording"]}'::jsonb),
             '{"status": "ok"}')],
    format('select to_jsonb(x) from screening_v2.interview_round_consents x where x.round_id = %L and x.withdrawn_at is null', r));
  perform _r1_meet_public_tests.assert('T4-C ... and stores the staff notice''s required set and locale',
    stored -> 'consents' = '["ai_interview", "staff_recording"]'::jsonb
    and stored -> 'proof' ->> 'locale' = 'en-IN-x-staff'
    and stored -> 'proof' ->> 'template_version' = 'zzz-meet-public-assert-staff'
    and stored ->> 'method' = 'candidate_web', coalesce(stored::text, 'null'));

  -- (5) booking_dispatched; an undispatched bot is fine.
  perform _r1_meet_public_tests.t4_book(644);
  perform _r1_meet_public_tests.dispatch(644);
  perform _r1_meet_public_tests.expect_reconsent('T4-C a dispatched booking', 644, '{}'::jsonb,
    'refused:booking_dispatched');
  perform _r1_meet_public_tests.expect_reconsent('T4-C a dispatched booking and a stale notice', 644,
    jsonb_build_object('consent', older), 'refused:booking_dispatched');
  perform _r1_meet_public_tests.t4_book(645);
  perform _r1_meet_public_tests.attach(645);
  perform _r1_meet_public_tests.expect_reconsent('T4-C a booking whose bot is scheduled, not dispatched', 645,
    jsonb_build_object('now', t5), 'ok:');

  -- (6) not_found: unknown, terminal, the slot end, a round HR cancelled.
  perform _r1_meet_public_tests.expect_reconsent('T4-C an unknown digest', 640,
    jsonb_build_object('digest', _r1_meet_public_tests.digest('t4-unknown')), 'refused:not_found');
  b := _r1_meet_public_tests.t4_book(646);
  res := screening_v2.r1_meet_transition_booking(b, 'pending', 'failed', 'bot_create_failed', t4);
  perform _r1_meet_public_tests.assert('T4-C fixture: booking 646 failed', res ->> 'status' = 'ok', res::text);
  perform _r1_meet_public_tests.expect_reconsent('T4-C a failed booking', 646, '{}'::jsonb, 'refused:not_found');
  perform _r1_meet_public_tests.expect_reconsent('T4-C at the slot end', 643,
    jsonb_build_object('now', _r1_meet_public_tests.t4_slot(643) + interval '45 minutes'), 'refused:not_found');
  b := _r1_meet_public_tests.t4_book(647);
  r := _r1_meet_public_tests.round_of_booking(b);
  res := screening_v2.r1_transition_round(r, 'cancel', _r1_meet_public_tests.round_version(r), null, null, t4);
  perform _r1_meet_public_tests.assert('T4-C fixture: HR cancels the round of booking 647', res ->> 'status' = 'ok', res::text);
  perform _r1_meet_public_tests.expect_reconsent('T4-C a booking whose round HR cancelled', 647, '{}'::jsonb,
    'refused:not_found');
  perform _r1_meet_public_tests.expect_reconsent('T4-C a cancelled round and a stale notice', 647,
    jsonb_build_object('consent', older), 'refused:not_found');

  -- (7) invalid_request: every field wrong, then fixed one at a time; every consent shape failure.
  bad := jsonb_build_object('digest', null, 'consent', 'not an object', 'now', null);
  foreach f in array array['digest', 'consent', 'now'] loop
    perform _r1_meet_public_tests.expect_reconsent('T4-C every field wrong from ' || f || ' on', 640, bad,
      'invalid_request:' || f);
    bad := bad - f;
  end loop;
  perform _r1_meet_public_tests.expect_reconsent('T4-C an upper-case digest', 640,
    jsonb_build_object('digest', upper(_r1_meet_public_tests.md(640))), 'invalid_request:digest');
  foreach shape in array array[
      'null'::jsonb,
      '[]'::jsonb,
      _r1_meet_public_tests.form_consent() || '{"name": "meet public assert"}'::jsonb,
      _r1_meet_public_tests.form_consent() || '{"in_india": "yes"}'::jsonb,
      _r1_meet_public_tests.form_consent() - 'in_india',
      _r1_meet_public_tests.form_consent() || '{"consents": []}'::jsonb,
      _r1_meet_public_tests.form_consent() || '{"consents": ["a", "b", "c", "d", "e", "f", "g", "h", "i"]}'::jsonb,
      _r1_meet_public_tests.form_consent() || '{"consents": ["ai_interview", "ai_interview"]}'::jsonb,
      _r1_meet_public_tests.form_consent() || '{"consents": ["AI_interview"]}'::jsonb,
      _r1_meet_public_tests.form_consent() || jsonb_build_object('template_version', repeat('v', 65)),
      _r1_meet_public_tests.form_consent() || jsonb_build_object('user_agent', repeat('u', 257)),
      _r1_meet_public_tests.form_consent() || jsonb_build_object('ip_prefix', repeat('1', 65))] loop
    i := i + 1;
    perform _r1_meet_public_tests.expect_reconsent('T4-C a consent of the wrong shape (' || i || ')', 640,
      jsonb_build_object('consent', shape), 'invalid_request:consent');
  end loop;

  -- (8) Catalog posture.
  perform _r1_meet_public_tests.assert('T4-C the re-consent is one security definer, volatile function returning jsonb',
    (select x.prosecdef and x.provolatile = 'v'
            and x.proconfig = array['search_path=pg_catalog, screening_v2']
            and x.prorettype = 'jsonb'::regtype and x.pronargs = 3 and x.pronargdefaults = 1
       from pg_proc x where x.oid = sig::regprocedure)
    and (select count(*) = 1 from pg_proc x
          where x.pronamespace = 'screening_v2'::regnamespace and x.proname = 'r1_meet_public_reconsent'));
  perform _r1_meet_public_tests.assert('T4-C the re-consent is executable by service_role only',
    has_function_privilege('service_role', sig, 'execute')
    and not has_function_privilege('anon', sig, 'execute')
    and not has_function_privilege('authenticated', sig, 'execute')
    and not has_function_privilege('public', sig, 'execute'));
  foreach role_name in array array['anon', 'authenticated'] loop
    perform _r1_meet_public_tests.raises_as(role_name, 'T4-C execute r1_meet_public_reconsent',
      'select screening_v2.r1_meet_public_reconsent(null, null)', '42501');
  end loop;
end;
$$;

rollback;
