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

rollback;
