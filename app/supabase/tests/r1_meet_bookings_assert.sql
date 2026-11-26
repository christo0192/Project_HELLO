-- 0142 (M034 S02): R1 over Google Meet bookings, receipts, the round channel and HR-attested
-- consent, run for real.
--
-- Executed by scripts/test-r1-meet.sh inside scripts/supabase-test.sh's local Supabase stack,
-- against the complete schema (every migration applied; never stubs). Everything runs in ONE
-- transaction that is rolled back at the end, so the fixtures (including the immutable consent
-- template), the settings change and every job row it writes never outlive the run. Any failed
-- assertion raises and stops psql (ON_ERROR_STOP=1).
--
-- Sections:
--   T1-A catalog posture: RLS on with no policy, closed to anon / authenticated / PUBLIC (by catalog
--        and by trying), service_role limited to select/insert/update/delete, the two trigger
--        functions' security mode, search_path and EXECUTE, the triggers enabled, the new columns.
--   T1-B interview_rounds.channel: default, value space, the browser -> meet lock.
--   T1-C interview_round_consents: the browser grant, decline, supersede and withdraw shapes are
--        unchanged (candidate_web, no attestation); the attestation pairing.
--   T1-D r1_meet_bookings: every CHECK, the unique keys (event, live round, bot, ticket digest).
--   T1-E r1_meet_receipts: every CHECK and the dedupe key, incl. the longest S01 Ashby key form.
--   T1-F cascades and the bot release job.
--   T2   r1_meet_create_round_from_ashby: the round, the HR-attested consent and the booking.
--   T3   the booking lifecycle: r1_meet_cancel_booking (writes the booking only), r1_meet_set_bot
--        (attach, rotate_key, replace, release; compare-and-set; the caps),
--        r1_meet_reschedule_booking, r1_meet_transition_booking (the matrix) and
--        r1_meet_bind_session.
--   T4   the bridge ticket (r1_meet_arm_ticket, r1_meet_claim_ticket: armable states, the window,
--        single use, replay, expiry, re-arm, the arm budget), durable receipts with the outbox
--        (r1_meet_record_receipt: dedupe, one live r1-meet job, re-drive, settled work, refusals),
--        the receipt prune (r1_meet_prune_receipts), and the behavioural privilege proof of both
--        tables and all eleven RPCs (anon / authenticated refused, service_role runs each).
--   T3-G the per-event recovery (review F1, F6): the re-bind of a lapsed round before dispatch (also
--        after the real sweep expired it), the revival of a moved failed booking, the reset of every
--        counter of the old attempt (key, arm budget, ticket, session), step 8a's guard for another
--        event's live booking, bot_attached, version_exhausted, replays after the slot started.
--   T3-H the round side (review F3): no reissue of a Meet round's link; HR's cancel of a Meet
--        round queues one round_cancelled job per live booking.
--   T4-C also the receipt prune of dead-lettered enqueued receipts and r1_meet_prune_bookings
--        (review F5).
--
-- The clock is pinned: every time is written explicitly (p_now = 2026-12-01 04:00 UTC); nothing
-- asserts on now(). Fixture ids live in 7f000000-0000-4000-8000-<kind:4><n:8> (unused elsewhere);
-- candidate names are "meet assert <n>", the one user email is @example.test. No real data.

begin;

create schema _r1_meet_tests;
create table _r1_meet_tests.passed (label text primary key);

create function _r1_meet_tests.assert(p_label text, p_ok boolean, p_detail text default '')
returns void language plpgsql as $$
begin
  -- `is not true`, not `not`: a NULL condition must fail, never pass silently.
  if p_ok is not true then
    raise exception 'R1 MEET FAIL: % (%)', p_label, p_detail;
  end if;
  insert into _r1_meet_tests.passed (label) values (p_label) on conflict do nothing;
  raise notice 'R1 MEET PASS: %', p_label;
end;
$$;

-- Runs a statement that MUST raise the given SQLSTATE; any other outcome fails the assertion.
create function _r1_meet_tests.raises(p_label text, p_sql text, p_sqlstate text)
returns void language plpgsql as $$
declare
  v_state text;
begin
  begin
    execute p_sql;
  exception when others then
    get stacked diagnostics v_state = returned_sqlstate;
    perform _r1_meet_tests.assert(p_label || ' (rejected with ' || p_sqlstate || ')',
      v_state = p_sqlstate, 'got ' || v_state);
    return;
  end;
  raise exception 'R1 MEET FAIL: % (statement was accepted)', p_label;
end;
$$;

-- Runs a statement AS p_role that MUST raise the given SQLSTATE. The role switch is local to the
-- inner block: its subtransaction is always rolled back (an accepted statement raises a sentinel
-- to force that), which restores the role and undoes any write before the verdict. A switch that
-- did not happen fails loudly instead of passing on the switch's own 42501.
create function _r1_meet_tests.raises_as(p_role text, p_label text, p_sql text, p_sqlstate text)
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
    raise exception 'r1 meet raises_as sentinel' using errcode = 'P0001';
  exception when others then
    get stacked diagnostics v_state = returned_sqlstate;
  end;
  if not v_switched then
    raise exception 'R1 MEET FAIL: % (could not switch to role %: %)', p_label, p_role, v_state;
  end if;
  if v_accepted then
    raise exception 'R1 MEET FAIL: % as % (statement was accepted)', p_label, p_role;
  end if;
  perform _r1_meet_tests.assert(p_label || ' as ' || p_role || ' (rejected with ' || p_sqlstate || ')',
    v_state = p_sqlstate and current_user = v_before,
    'got ' || coalesce(v_state, 'null') || ' as ' || current_user);
end;
$$;

-- Fixture ids: 7f000000-0000-4000-8000-<kind:4><n:8>.
--   1 auth users, 2 role, 3 consent template, 10 candidates, 11 rounds, 12 call sessions,
--   20 Ashby interview events, 21 schedules, 22 applications, 23 stages, 24 interviews,
--   25 Ashby users (HR schedulers), 30 Recall bots.
create function _r1_meet_tests.id(p_kind integer, p_n integer) returns uuid
language sql immutable as $$
  select ('7f000000-0000-4000-8000-' || lpad(p_kind::text, 4, '0') || lpad(p_n::text, 8, '0'))::uuid
$$;

-- A runtime SHA-256 hex digest of a tag (never a literal digest in this file).
create function _r1_meet_tests.digest(p_tag text) returns text
language sql immutable as $$
  select encode(sha256(convert_to('r1-meet-assert:' || p_tag, 'UTF8')), 'hex')
$$;

-- Setup: the R1 switches open (later sections create rounds through the RPCs), one auth user as the
-- round creator and session owner, one inactive consent template of our own, and EXACTLY one
-- sales_r1 role. Earlier suites (r1_foundation_assert, r1_candidate_routes_assert,
-- r1_concurrency_setup) leave sales_r1 roles of their own, and the Meet round RPC, like the browser
-- route, requires exactly one, so every other role loses the kind inside this transaction only.
do $$
begin
  update screening_v2.r1_settings
     set enabled = true, paused = false, livekit_target = 'r1',
         monthly_cap_minutes = 100000, pause_line_minutes = 100000, dashboard_minutes = 0
   where singleton;
  insert into auth.users (id, email)
  values (_r1_meet_tests.id(1, 1), 'r1-meet-assert-1@example.test')
  on conflict (id) do nothing;
  -- Inactive on purpose: this fixture must never become the authoritative template.
  insert into screening_v2.interview_round_consent_templates
    (id, version, locale, title, body_md, required_consents, is_active)
  values (_r1_meet_tests.id(3, 1), 'meet-assert-fixture', 'en-IN', 'R1 Meet assertion fixture',
          'fixture', '["video_audio_recording"]'::jsonb, false);
  update screening_v2.roles set interview_kind = null where interview_kind = 'sales_r1';
  insert into screening_v2.roles (id, title, interview_kind)
  values (_r1_meet_tests.id(2, 1), 'R1 Meet assertion role', 'sales_r1');
  perform _r1_meet_tests.assert('setup: exactly one sales_r1 role, ours',
    (select count(*) = 1 and bool_and(r.id = _r1_meet_tests.id(2, 1))
       from screening_v2.roles r where r.interview_kind = 'sales_r1'));
end;
$$;

-- A candidate of the assertion role, optionally with its Ashby application link
-- (external_application_id = Ashby application id(22, n)).
create function _r1_meet_tests.candidate(p_n integer, p_link boolean default true,
                                         p_terminal text default null)
returns uuid language plpgsql as $$
begin
  insert into screening_v2.candidates (id, role_id, name)
  values (_r1_meet_tests.id(10, p_n), _r1_meet_tests.id(2, 1), 'meet assert ' || p_n::text);
  if p_link then
    insert into screening_v2.ashby_application_links
      (provider, external_application_id, candidate_id, terminal_state)
    values ('ashby', _r1_meet_tests.id(22, p_n)::text, _r1_meet_tests.id(10, p_n), p_terminal);
  end if;
  return _r1_meet_tests.id(10, p_n);
end;
$$;

-- A round inserted directly (the T1 schema checks; later sections create rounds through the RPC).
create function _r1_meet_tests.round(p_n integer, p_status text default 'invited')
returns uuid language plpgsql as $$
begin
  insert into screening_v2.interview_rounds
    (id, candidate_id, role_id, link_token_digest, expires_at, created_by, status)
  values (_r1_meet_tests.id(11, p_n), _r1_meet_tests.id(10, p_n), _r1_meet_tests.id(2, 1),
          _r1_meet_tests.digest('link-' || p_n::text), '2099-01-01 00:00:00+00',
          _r1_meet_tests.id(1, 1), p_status);
  return _r1_meet_tests.id(11, p_n);
end;
$$;

-- A browser call session of round p_round (status `created`, as every new session starts).
create function _r1_meet_tests.session(p_n integer, p_round uuid)
returns uuid language plpgsql as $$
begin
  insert into screening_v2.call_sessions
    (id, candidate_id, role_id, mode, provider, external_call_id, status, interview_round_id, owner_id)
  select _r1_meet_tests.id(12, p_n), r.candidate_id, r.role_id, 'browser', 'livekit',
         'screening-' || _r1_meet_tests.id(12, p_n)::text, 'created', r.id, _r1_meet_tests.id(1, 1)
    from screening_v2.interview_rounds r
   where r.id = p_round;
  return _r1_meet_tests.id(12, p_n);
end;
$$;

-- A complete, valid booking row for Ashby event id(20, n): unmatched, no candidate, no round, no bot.
create function _r1_meet_tests.booking_row(p_n integer) returns jsonb
language sql as $$
  select jsonb_build_object(
    'id', gen_random_uuid(),
    'ashby_interview_event_id', _r1_meet_tests.id(20, p_n),
    'ashby_schedule_id', _r1_meet_tests.id(21, p_n)::text,
    'ashby_application_id', _r1_meet_tests.id(22, p_n)::text,
    'ashby_interview_stage_id', _r1_meet_tests.id(23, p_n)::text,
    'ashby_interview_id', _r1_meet_tests.id(24, p_n)::text,
    'ashby_scheduled_by_user_id', _r1_meet_tests.id(25, 1)::text,
    'ashby_updated_at', '2026-11-30T09:00:00+00:00',
    'candidate_id', null,
    'round_id', null,
    'objective_profile', 'r1_dex_sales',
    'status', 'unmatched_application',
    'reason', 'application_unknown',
    'version', 0,
    'key_attempt', 0,
    'meet_url', 'https://meet.google.com/abc-defg-hij',
    'start_at', '2026-12-02T10:30:00+00:00',
    'end_at', '2026-12-02T11:15:00+00:00',
    'recall_bot_id', null,
    'ticket_digest', null,
    'ticket_not_before', null,
    'ticket_expires_at', null,
    'ticket_claimed_at', null,
    'ticket_arms', 0,
    'session_id', null,
    -- 0143 (M035 S01) added two NOT NULL columns with defaults; jsonb_populate_record leaves a
    -- missing key NULL rather than the default, so this Ashby row spells their Ashby values out.
    'source', 'ashby',
    'move_count', 0,
    'created_at', '2026-12-01T04:00:00+00:00',
    'updated_at', '2026-12-01T04:00:00+00:00')
$$;

-- Inserts booking_row(n) with the given columns overridden; returns the booking id.
create function _r1_meet_tests.insert_booking(p_n integer, p_cols jsonb default '{}'::jsonb)
returns uuid language plpgsql as $$
declare
  v_id uuid;
begin
  insert into screening_v2.r1_meet_bookings
  select * from jsonb_populate_record(null::screening_v2.r1_meet_bookings,
                                      _r1_meet_tests.booking_row(p_n) || p_cols)
  returning id into v_id;
  return v_id;
end;
$$;

create function _r1_meet_tests.booking_rejected(p_label text, p_n integer, p_cols jsonb,
                                                p_sqlstate text default '23514')
returns void language plpgsql as $$
begin
  perform _r1_meet_tests.raises(p_label,
    format('select _r1_meet_tests.insert_booking(%s, %L::jsonb)', p_n, p_cols::text), p_sqlstate);
end;
$$;

create function _r1_meet_tests.receipt(p_source text, p_dedupe text,
                                       p_event text default 'bot.status_change',
                                       p_outcome text default 'recorded',
                                       p_processed_at timestamptz default null,
                                       p_booking uuid default null)
returns uuid language plpgsql as $$
declare
  v_id uuid;
begin
  insert into screening_v2.r1_meet_receipts
    (source, dedupe_key, event_type, booking_id, outcome, received_at, processed_at)
  values (p_source, p_dedupe, p_event, p_booking, p_outcome, '2026-12-01 04:00:00+00', p_processed_at)
  returning id into v_id;
  return v_id;
end;
$$;

create function _r1_meet_tests.receipt_rejected(p_label text, p_source text, p_dedupe text,
                                                p_event text default 'bot.status_change',
                                                p_outcome text default 'recorded',
                                                p_processed_at timestamptz default null,
                                                p_sqlstate text default '23514')
returns void language plpgsql as $$
begin
  perform _r1_meet_tests.raises(p_label,
    format('select _r1_meet_tests.receipt(%L, %L, %L, %L, %L::timestamptz)',
           p_source, p_dedupe, p_event, p_outcome, p_processed_at), p_sqlstate);
end;
$$;

-- =============================================================================================
-- T1-A. Catalog posture.
-- =============================================================================================
do $$
declare
  tbl text;
  fn text;
  who text;
begin
  foreach tbl in array array['r1_meet_bookings', 'r1_meet_receipts'] loop
    perform _r1_meet_tests.assert('T1-A ' || tbl || ' has RLS enabled and no policy',
      (select c.relrowsecurity from pg_class c where c.oid = ('screening_v2.' || tbl)::regclass)
      and not exists (select 1 from pg_policies p where p.schemaname = 'screening_v2' and p.tablename = tbl));
    perform _r1_meet_tests.assert('T1-A ' || tbl || ' is closed to anon, authenticated and public',
      not has_table_privilege('anon', 'screening_v2.' || tbl,
                              'select,insert,update,delete,truncate,references,trigger')
      and not has_table_privilege('authenticated', 'screening_v2.' || tbl,
                                  'select,insert,update,delete,truncate,references,trigger')
      and not exists (
        select 1 from information_schema.role_table_grants g
         where g.table_schema = 'screening_v2' and g.table_name = tbl and g.grantee = 'PUBLIC'));
    perform _r1_meet_tests.assert('T1-A service_role can select, insert, update and delete ' || tbl,
      has_table_privilege('service_role', 'screening_v2.' || tbl, 'select')
      and has_table_privilege('service_role', 'screening_v2.' || tbl, 'insert')
      and has_table_privilege('service_role', 'screening_v2.' || tbl, 'update')
      and has_table_privilege('service_role', 'screening_v2.' || tbl, 'delete'));
    perform _r1_meet_tests.assert('T1-A service_role has no truncate, references or trigger on ' || tbl,
      not has_table_privilege('service_role', 'screening_v2.' || tbl, 'truncate,references,trigger'));
    -- Behavioural: the browser roles are refused by the database itself.
    foreach who in array array['anon', 'authenticated'] loop
      perform _r1_meet_tests.raises_as(who, 'T1-A select from ' || tbl,
        format('select count(*) from screening_v2.%I', tbl), '42501');
      perform _r1_meet_tests.raises_as(who, 'T1-A insert into ' || tbl,
        format('insert into screening_v2.%I default values', tbl), '42501');
      perform _r1_meet_tests.raises_as(who, 'T1-A update ' || tbl,
        format('update screening_v2.%I set id = id', tbl), '42501');
      perform _r1_meet_tests.raises_as(who, 'T1-A delete from ' || tbl,
        format('delete from screening_v2.%I', tbl), '42501');
    end loop;
  end loop;

  perform _r1_meet_tests.assert(
    'T1-A reject_interview_round_channel_change is security definer with search_path pg_catalog, screening_v2',
    (select p.prosecdef and p.proconfig = array['search_path=pg_catalog, screening_v2']
       from pg_proc p where p.oid = 'screening_v2.reject_interview_round_channel_change()'::regprocedure));
  perform _r1_meet_tests.assert(
    'T1-A enqueue_r1_meet_bot_release is security invoker with search_path pg_catalog',
    (select not p.prosecdef and p.proconfig = array['search_path=pg_catalog']
       from pg_proc p where p.oid = 'screening_v2.enqueue_r1_meet_bot_release()'::regprocedure));
  foreach fn in array array[
    'screening_v2.reject_interview_round_channel_change()',
    'screening_v2.enqueue_r1_meet_bot_release()'
  ] loop
    perform _r1_meet_tests.assert('T1-A ' || fn || ' is not executable by anon, authenticated or public',
      not has_function_privilege('anon', fn, 'execute')
      and not has_function_privilege('authenticated', fn, 'execute')
      and not has_function_privilege('public', fn, 'execute'));
  end loop;
  perform _r1_meet_tests.assert('T1-A the channel lock and the bot release triggers exist and are enabled',
    exists (select 1 from pg_trigger t
             where t.tgrelid = 'screening_v2.interview_rounds'::regclass
               and t.tgname = 'trg_interview_rounds_channel_locked'
               and not t.tgisinternal and t.tgenabled = 'O')
    and exists (select 1 from pg_trigger t
                 where t.tgrelid = 'screening_v2.r1_meet_bookings'::regclass
                   and t.tgname = 'enqueue_r1_meet_bot_release'
                   and not t.tgisinternal and t.tgenabled = 'O'));

  perform _r1_meet_tests.assert('T1-A interview_rounds.channel is text, not null, default browser',
    exists (select 1 from information_schema.columns
             where table_schema = 'screening_v2' and table_name = 'interview_rounds'
               and column_name = 'channel' and data_type = 'text' and is_nullable = 'NO'
               and column_default like '''browser''%'));
  perform _r1_meet_tests.assert('T1-A interview_round_consents.method is text, not null, default candidate_web',
    exists (select 1 from information_schema.columns
             where table_schema = 'screening_v2' and table_name = 'interview_round_consents'
               and column_name = 'method' and data_type = 'text' and is_nullable = 'NO'
               and column_default like '''candidate_web''%'));
  perform _r1_meet_tests.assert('T1-A the three attestation columns are nullable with no default',
    (select count(*) = 3 from information_schema.columns
      where table_schema = 'screening_v2' and table_name = 'interview_round_consents'
        and column_name in ('attested_by_external_id', 'attested_at', 'india_location_attested')
        and is_nullable = 'YES' and column_default is null));
  -- Existing data reads the browser values: nothing was rewritten.
  perform _r1_meet_tests.assert('T1-A every existing round reads channel browser',
    not exists (select 1 from screening_v2.interview_rounds where channel <> 'browser'));
  perform _r1_meet_tests.assert('T1-A every existing consent reads candidate_web with no attestation',
    not exists (select 1 from screening_v2.interview_round_consents
                 where method <> 'candidate_web' or attested_by_external_id is not null
                    or attested_at is not null or india_location_attested is not null));
end;
$$;

-- =============================================================================================
-- T1-B. interview_rounds.channel.
-- =============================================================================================
do $$
declare
  r_a uuid;
  r_b uuid;
  r_c uuid;
  r_d uuid;
  r_e uuid;
begin
  perform _r1_meet_tests.candidate(1, false);
  r_a := _r1_meet_tests.round(1);
  perform _r1_meet_tests.assert('T1-B a round inserted without a channel reads browser',
    (select channel = 'browser' from screening_v2.interview_rounds where id = r_a));

  perform _r1_meet_tests.candidate(2, false);
  perform _r1_meet_tests.raises('T1-B a round with channel phone',
    format($q$insert into screening_v2.interview_rounds
                (candidate_id, role_id, link_token_digest, expires_at, created_by, channel)
              values (%L, %L, %L, '2099-01-01 00:00:00+00', %L, 'phone')$q$,
           _r1_meet_tests.id(10, 2), _r1_meet_tests.id(2, 1), _r1_meet_tests.digest('link-phone'),
           _r1_meet_tests.id(1, 1)),
    '23514');
  perform _r1_meet_tests.raises('T1-B an update to channel phone is refused by the lock',
    format('update screening_v2.interview_rounds set channel = %L where id = %L', 'phone', r_a), 'P0001');

  update screening_v2.interview_rounds set channel = 'meet' where id = r_a;
  perform _r1_meet_tests.assert('T1-B browser -> meet is allowed on a fresh invited round with no consent',
    (select channel = 'meet' from screening_v2.interview_rounds where id = r_a));
  perform _r1_meet_tests.raises('T1-B meet -> browser',
    format('update screening_v2.interview_rounds set channel = %L where id = %L', 'browser', r_a), 'P0001');
  update screening_v2.interview_rounds set channel = 'meet' where id = r_a;
  perform _r1_meet_tests.assert('T1-B a write of the same channel is never refused',
    (select channel = 'meet' from screening_v2.interview_rounds where id = r_a));

  -- After a consent row (any decision) the channel is fixed.
  perform _r1_meet_tests.candidate(3, false);
  r_b := _r1_meet_tests.round(3);
  insert into screening_v2.interview_round_consents (round_id, template_id, consents, proof, granted_at)
  values (r_b, _r1_meet_tests.id(3, 1), '["video_audio_recording"]'::jsonb,
          '{"decision":"granted"}'::jsonb, '2026-12-01 04:00:00+00');
  perform _r1_meet_tests.raises('T1-B browser -> meet after a consent row',
    format('update screening_v2.interview_rounds set channel = %L where id = %L', 'meet', r_b), 'P0001');
  update screening_v2.interview_rounds set channel = 'browser' where id = r_b;
  perform _r1_meet_tests.assert('T1-B a same-value write after consent is not refused',
    (select channel = 'browser' from screening_v2.interview_rounds where id = r_b));

  -- After a start the channel is fixed.
  perform _r1_meet_tests.candidate(4, false);
  r_c := _r1_meet_tests.round(4);
  update screening_v2.interview_rounds set starts_used = 1 where id = r_c;
  perform _r1_meet_tests.raises('T1-B browser -> meet after starts_used = 1',
    format('update screening_v2.interview_rounds set channel = %L where id = %L', 'meet', r_c), 'P0001');

  -- Outside `invited` the channel is fixed.
  perform _r1_meet_tests.candidate(5, false);
  r_d := _r1_meet_tests.round(5, 'in_progress');
  perform _r1_meet_tests.raises('T1-B browser -> meet on an in_progress round',
    format('update screening_v2.interview_rounds set channel = %L where id = %L', 'meet', r_d), 'P0001');

  -- The lock is on updates only: an insert may name either channel.
  perform _r1_meet_tests.candidate(6, false);
  insert into screening_v2.interview_rounds
    (id, candidate_id, role_id, link_token_digest, expires_at, created_by, channel)
  values (_r1_meet_tests.id(11, 6), _r1_meet_tests.id(10, 6), _r1_meet_tests.id(2, 1),
          _r1_meet_tests.digest('link-6'), '2099-01-01 00:00:00+00', _r1_meet_tests.id(1, 1), 'meet')
  returning id into r_e;
  perform _r1_meet_tests.assert('T1-B an insert may name channel meet',
    (select channel = 'meet' from screening_v2.interview_rounds where id = r_e));
end;
$$;

-- =============================================================================================
-- T1-C. interview_round_consents: the browser shapes unchanged; the HR attestation pairing.
-- =============================================================================================
do $$
declare
  p_now constant timestamptz := '2026-12-01 04:00:00+00';
  tpl constant uuid := _r1_meet_tests.id(3, 1);
  hr constant text := _r1_meet_tests.id(25, 1)::text;
  r_g uuid;
  r_d uuid;
  r_h uuid;
  r_u uuid;
  v_first uuid;
  v_second uuid;
  v_n integer;
  res jsonb;
  bad record;
begin
  -- The grant insert of routes/r1-candidate.ts (round_id, template_id, consents, proof, granted_at).
  perform _r1_meet_tests.candidate(10, false);
  r_g := _r1_meet_tests.round(10);
  insert into screening_v2.interview_round_consents (round_id, template_id, consents, proof, granted_at)
  values (r_g, tpl, '["video_audio_recording"]'::jsonb,
          jsonb_build_object('decision', 'granted', 'captured_at', p_now,
                             'template_version', 'meet-assert-fixture', 'locale', 'en-IN'),
          p_now)
  returning id into v_first;
  perform _r1_meet_tests.assert('T1-C a browser grant reads candidate_web with no attestation',
    (select c.method = 'candidate_web' and c.attested_by_external_id is null
            and c.attested_at is null and c.india_location_attested is null
       from screening_v2.interview_round_consents c where c.id = v_first));

  -- The supersede update of routes/r1-candidate.ts (withdrawn_at + proof decision 'superseded').
  update screening_v2.interview_round_consents
     set withdrawn_at = p_now,
         proof = coalesce(proof, '{}'::jsonb)
           || jsonb_build_object('decision', 'superseded', 'superseded_at', p_now)
   where id = v_first and withdrawn_at is null;
  get diagnostics v_n = row_count;
  perform _r1_meet_tests.assert('T1-C the browser supersede update still applies',
    v_n = 1 and (select c.method = 'candidate_web' and c.proof ->> 'decision' = 'superseded'
                   from screening_v2.interview_round_consents c where c.id = v_first));
  perform _r1_meet_tests.assert('T1-C a superseded consent queues no recording erase',
    not exists (select 1 from screening_v2.job_queue j
                 where j.name = 'r1.recording.erase' and j.dedup_key in ('r1.recording.erase:' || v_first::text)));
  insert into screening_v2.interview_round_consents (round_id, template_id, consents, proof, granted_at)
  values (r_g, tpl, '["video_audio_recording"]'::jsonb, '{"decision":"granted"}'::jsonb, p_now)
  returning id into v_second;

  -- r1_withdraw_consent (0120) on a browser consent.
  res := screening_v2.r1_withdraw_consent(r_g, '{}'::jsonb, p_now);
  perform _r1_meet_tests.assert('T1-C r1_withdraw_consent withdraws a browser consent unchanged',
    res ->> 'status' = 'ok' and (res ->> 'withdrawn')::integer = 1
    and (select c.method = 'candidate_web' and c.withdrawn_at = p_now and c.proof ->> 'decision' = 'withdrawn'
           from screening_v2.interview_round_consents c where c.id = v_second), res::text);

  -- The decline insert of routes/r1-candidate.ts (consents [], decision declined, withdrawn at once).
  perform _r1_meet_tests.candidate(11, false);
  r_d := _r1_meet_tests.round(11);
  insert into screening_v2.interview_round_consents
    (round_id, template_id, consents, proof, granted_at, withdrawn_at)
  values (r_d, tpl, '[]'::jsonb, '{"decision":"declined"}'::jsonb, p_now, p_now);
  perform _r1_meet_tests.assert('T1-C a browser decline reads candidate_web with no attestation',
    (select c.method = 'candidate_web' and c.attested_by_external_id is null
            and c.attested_at is null and c.india_location_attested is null
       from screening_v2.interview_round_consents c where c.round_id = r_d));

  -- The method value space and the attestation pairing.
  perform _r1_meet_tests.candidate(12, false);
  r_h := _r1_meet_tests.round(12);
  for bad in
    select * from (values
      ('method other', 'other', hr, p_now - interval '1 day', true),
      ('hr_attested_ashby without an attester', 'hr_attested_ashby', null, p_now - interval '1 day', true),
      ('hr_attested_ashby without attested_at', 'hr_attested_ashby', hr, null, true),
      ('hr_attested_ashby with india_location_attested false', 'hr_attested_ashby', hr, p_now - interval '1 day', false),
      ('hr_attested_ashby with india_location_attested null', 'hr_attested_ashby', hr, p_now - interval '1 day', null),
      ('hr_attested_ashby with a non-UUID attester', 'hr_attested_ashby', 'hr-person-1', p_now - interval '1 day', true),
      ('candidate_web with an attester', 'candidate_web', hr, null, null),
      ('candidate_web with attested_at', 'candidate_web', null, p_now - interval '1 day', null),
      ('candidate_web with india_location_attested', 'candidate_web', null, null, true)
    ) as t(label, method, attester, attested_at, india)
  loop
    perform _r1_meet_tests.raises('T1-C ' || bad.label,
      format($q$insert into screening_v2.interview_round_consents
                  (round_id, template_id, consents, proof, granted_at, method,
                   attested_by_external_id, attested_at, india_location_attested)
                values (%L, %L, '["video_audio_recording"]'::jsonb, '{"decision":"granted"}'::jsonb,
                        %L::timestamptz, %L, %L, %L::timestamptz, %L::boolean)$q$,
             r_h, tpl, p_now, bad.method, bad.attester, bad.attested_at, bad.india),
      '23514');
  end loop;

  insert into screening_v2.interview_round_consents
    (round_id, template_id, consents, proof, granted_at, method,
     attested_by_external_id, attested_at, india_location_attested)
  values (r_h, tpl, '["video_audio_recording"]'::jsonb,
          jsonb_build_object('decision', 'granted', 'method', 'hr_attested_ashby'), p_now,
          'hr_attested_ashby', hr, p_now - interval '1 day', true);
  perform _r1_meet_tests.assert('T1-C a complete HR-attested consent is accepted and stored verbatim',
    (select c.method = 'hr_attested_ashby' and c.attested_by_external_id = hr
            and c.attested_at = p_now - interval '1 day' and c.india_location_attested
       from screening_v2.interview_round_consents c where c.round_id = r_h and c.withdrawn_at is null));
  res := screening_v2.r1_withdraw_consent(r_h, '{}'::jsonb, p_now);
  perform _r1_meet_tests.assert('T1-C an HR-attested consent is withdrawn like any other and keeps its evidence',
    res ->> 'status' = 'ok' and (res ->> 'withdrawn')::integer = 1
    and (select c.method = 'hr_attested_ashby' and c.attested_by_external_id = hr
                and c.withdrawn_at = p_now and c.proof ->> 'decision' = 'withdrawn'
           from screening_v2.interview_round_consents c where c.round_id = r_h), res::text);

  -- Ashby ids are kept verbatim: an upper-case attester is UUID-shaped too.
  perform _r1_meet_tests.candidate(13, false);
  r_u := _r1_meet_tests.round(13);
  insert into screening_v2.interview_round_consents
    (round_id, template_id, consents, proof, granted_at, method,
     attested_by_external_id, attested_at, india_location_attested)
  values (r_u, tpl, '["video_audio_recording"]'::jsonb, '{"decision":"granted"}'::jsonb, p_now,
          'hr_attested_ashby', upper(hr), p_now, true);
  perform _r1_meet_tests.assert('T1-C an upper-case Ashby attester id is accepted verbatim',
    (select c.attested_by_external_id = upper(hr)
       from screening_v2.interview_round_consents c where c.round_id = r_u));
end;
$$;

-- =============================================================================================
-- T1-D. r1_meet_bookings: CHECKs and unique keys.
-- =============================================================================================
do $$
declare
  c_a uuid;
  c_b uuid;
  r_a uuid;
  r_b uuid;
  b1 uuid;
  b_live uuid;
  b_t uuid;
  active jsonb;
  bad record;
  tkt constant text := _r1_meet_tests.digest('ticket-d1');
begin
  -- The base row (unmatched, nothing bound) is valid.
  b1 := _r1_meet_tests.insert_booking(1);
  perform _r1_meet_tests.assert('T1-D the base unmatched booking is accepted with its defaults',
    (select b.status = 'unmatched_application' and b.reason = 'application_unknown'
            and b.objective_profile = 'r1_dex_sales' and b.version = 0 and b.key_attempt = 0
            and b.ticket_arms = 0
       from screening_v2.r1_meet_bookings b where b.id = b1));

  c_a := _r1_meet_tests.candidate(20, false);
  r_a := _r1_meet_tests.round(20);
  c_b := _r1_meet_tests.candidate(21, false);
  r_b := _r1_meet_tests.round(21);
  -- Overrides that make a valid bot_scheduled booking on round r_b.
  active := jsonb_build_object('status', 'bot_scheduled', 'reason', 'eligible',
                               'candidate_id', c_b, 'round_id', r_b,
                               'recall_bot_id', _r1_meet_tests.id(30, 90));

  for bad in
    select * from (values
      ('bad status', jsonb_build_object('status', 'scheduled')),
      ('bad reason', jsonb_build_object('reason', 'because')),
      ('a mismatched status/reason pair (blocked, eligible)',
        jsonb_build_object('status', 'blocked', 'reason', 'eligible')),
      ('a mismatched status/reason pair (cancelled, flag_off)',
        jsonb_build_object('status', 'cancelled', 'reason', 'flag_off')),
      ('objective_profile other', jsonb_build_object('objective_profile', 'other')),
      ('an upper-case Meet URL', jsonb_build_object('meet_url', 'https://meet.google.com/ABC-DEFG-HIJ')),
      ('a Meet URL with ?authuser=0', jsonb_build_object('meet_url', 'https://meet.google.com/abc-defg-hij?authuser=0')),
      ('an http:// Meet URL', jsonb_build_object('meet_url', 'http://meet.google.com/abc-defg-hij')),
      ('a non-Meet URL', jsonb_build_object('meet_url', 'https://zoom.us/j/abc-defg-hij')),
      ('end_at equal to start_at', jsonb_build_object('end_at', '2026-12-02T10:30:00+00:00')),
      ('end_at before start_at', jsonb_build_object('end_at', '2026-12-02T10:00:00+00:00')),
      ('a 25 h slot', jsonb_build_object('end_at', '2026-12-03T11:30:00+00:00')),
      ('version 51', jsonb_build_object('version', 51)),
      ('version -1', jsonb_build_object('version', -1)),
      ('key_attempt 21', jsonb_build_object('key_attempt', 21)),
      ('ticket_arms 6', jsonb_build_object('ticket_arms', 6)),
      ('a non-UUID schedule id', jsonb_build_object('ashby_schedule_id', 'schedule-1')),
      ('a non-UUID application id', jsonb_build_object('ashby_application_id', 'application-1')),
      ('a non-UUID stage id', jsonb_build_object('ashby_interview_stage_id', 'stage-1')),
      ('a non-UUID interview id', jsonb_build_object('ashby_interview_id', 'interview-1')),
      ('a non-UUID scheduler id', jsonb_build_object('ashby_scheduled_by_user_id', 'hr-person-1')),
      ('unmatched_application with a candidate', jsonb_build_object('candidate_id', c_a)),
      ('unmapped_scheduler with a round',
        jsonb_build_object('status', 'unmapped_scheduler', 'reason', 'scheduler_unmapped',
                           'candidate_id', c_a, 'round_id', r_a)),
      ('a round without a candidate',
        jsonb_build_object('status', 'blocked', 'reason', 'round_active', 'round_id', r_a)),
      ('pending without a round',
        jsonb_build_object('status', 'pending', 'reason', 'eligible', 'candidate_id', c_a)),
      ('completed without a round',
        jsonb_build_object('status', 'completed', 'reason', 'attempt_settled', 'candidate_id', c_a)),
      ('pending with a bot',
        jsonb_build_object('status', 'pending', 'reason', 'eligible', 'candidate_id', c_b,
                           'round_id', r_b, 'recall_bot_id', _r1_meet_tests.id(30, 91))),
      ('blocked with a bot',
        jsonb_build_object('status', 'blocked', 'reason', 'no_meet_link', 'candidate_id', c_b,
                           'round_id', r_b, 'recall_bot_id', _r1_meet_tests.id(30, 91))),
      ('bot_scheduled without a bot', active || jsonb_build_object('recall_bot_id', null)),
      ('in_call without a bot',
        active || jsonb_build_object('status', 'in_call', 'recall_bot_id', null)),
      ('a ticket digest that is not hex64',
        active || jsonb_build_object('ticket_digest', upper(tkt),
                                     'ticket_not_before', '2026-12-02T10:15:00+00:00',
                                     'ticket_expires_at', '2026-12-02T11:30:00+00:00')),
      ('a ticket digest without its window', active || jsonb_build_object('ticket_digest', tkt)),
      ('a ticket window without its digest',
        active || jsonb_build_object('ticket_not_before', '2026-12-02T10:15:00+00:00',
                                     'ticket_expires_at', '2026-12-02T11:30:00+00:00')),
      ('a ticket without expires_at',
        active || jsonb_build_object('ticket_digest', tkt, 'ticket_not_before', '2026-12-02T10:15:00+00:00')),
      ('ticket_expires_at equal to ticket_not_before',
        active || jsonb_build_object('ticket_digest', tkt,
                                     'ticket_not_before', '2026-12-02T10:15:00+00:00',
                                     'ticket_expires_at', '2026-12-02T10:15:00+00:00')),
      ('ticket_expires_at before ticket_not_before',
        active || jsonb_build_object('ticket_digest', tkt,
                                     'ticket_not_before', '2026-12-02T10:15:00+00:00',
                                     'ticket_expires_at', '2026-12-02T10:00:00+00:00')),
      ('a claimed ticket without a digest',
        active || jsonb_build_object('ticket_claimed_at', '2026-12-02T10:20:00+00:00')),
      ('a ticket on a pending booking',
        jsonb_build_object('status', 'pending', 'reason', 'eligible', 'candidate_id', c_b, 'round_id', r_b,
                           'ticket_digest', tkt,
                           'ticket_not_before', '2026-12-02T10:15:00+00:00',
                           'ticket_expires_at', '2026-12-02T11:30:00+00:00'))
    ) as t(label, cols)
  loop
    perform _r1_meet_tests.booking_rejected('T1-D ' || bad.label, 50, bad.cols);
  end loop;
  perform _r1_meet_tests.assert('T1-D no rejected insert left a row',
    not exists (select 1 from screening_v2.r1_meet_bookings b
                 where b.ashby_interview_event_id = _r1_meet_tests.id(20, 50)));

  -- Valid shapes: upper-case Ashby ids (kept verbatim), every family, an armed and claimed ticket.
  perform _r1_meet_tests.insert_booking(2, jsonb_build_object(
    'ashby_schedule_id', upper(_r1_meet_tests.id(21, 2)::text),
    'ashby_application_id', upper(_r1_meet_tests.id(22, 2)::text),
    'ashby_interview_stage_id', null, 'ashby_interview_id', null,
    'ashby_scheduled_by_user_id', upper(_r1_meet_tests.id(25, 1)::text)));
  perform _r1_meet_tests.assert('T1-D upper-case Ashby ids and null optional ids are accepted',
    exists (select 1 from screening_v2.r1_meet_bookings b
             where b.ashby_interview_event_id = _r1_meet_tests.id(20, 2)
               and b.ashby_schedule_id = upper(_r1_meet_tests.id(21, 2)::text)));
  b_live := _r1_meet_tests.insert_booking(3, active || jsonb_build_object(
    'ticket_digest', tkt,
    'ticket_not_before', '2026-12-02T10:15:00+00:00',
    'ticket_expires_at', '2026-12-02T11:30:00+00:00',
    'ticket_claimed_at', '2026-12-02T10:20:00+00:00',
    'ticket_arms', 1));
  perform _r1_meet_tests.assert('T1-D a bot_scheduled booking with an armed, claimed ticket is accepted',
    (select b.status = 'bot_scheduled' and b.recall_bot_id = _r1_meet_tests.id(30, 90)
       from screening_v2.r1_meet_bookings b where b.id = b_live));
  perform _r1_meet_tests.insert_booking(4, jsonb_build_object(
    'status', 'unmapped_scheduler', 'reason', 'created_by_unknown', 'candidate_id', c_a));
  perform _r1_meet_tests.insert_booking(5, jsonb_build_object(
    'status', 'blocked', 'reason', 'slot_too_far', 'candidate_id', c_a));
  perform _r1_meet_tests.insert_booking(6, jsonb_build_object(
    'status', 'drained', 'reason', 'flag_off', 'candidate_id', c_b, 'round_id', r_b,
    'recall_bot_id', _r1_meet_tests.id(30, 6)));
  perform _r1_meet_tests.assert('T1-D the unmapped, blocked and drained families are accepted',
    (select count(*) = 3 from screening_v2.r1_meet_bookings b
      where b.ashby_interview_event_id in (_r1_meet_tests.id(20, 4), _r1_meet_tests.id(20, 5),
                                           _r1_meet_tests.id(20, 6))));

  -- Unique keys.
  perform _r1_meet_tests.booking_rejected('T1-D a duplicate Ashby event id', 1, '{}'::jsonb, '23505');
  perform _r1_meet_tests.raises('T1-D the same Ashby event id in upper case',
    format('select _r1_meet_tests.insert_booking(51, %L::jsonb)',
           jsonb_build_object('ashby_interview_event_id', upper(_r1_meet_tests.id(20, 1)::text))::text),
    '23505');
  perform _r1_meet_tests.booking_rejected('T1-D a second live booking on the same round', 52,
    jsonb_build_object('status', 'pending', 'reason', 'eligible', 'candidate_id', c_b, 'round_id', r_b),
    '23505');
  b_t := _r1_meet_tests.insert_booking(7, jsonb_build_object(
    'status', 'cancelled', 'reason', 'event_removed', 'candidate_id', c_b, 'round_id', r_b));
  perform _r1_meet_tests.assert('T1-D a terminal booking may share the round of a live one',
    exists (select 1 from screening_v2.r1_meet_bookings b where b.id = b_t));
  perform _r1_meet_tests.booking_rejected('T1-D the same ticket digest on two bookings', 53,
    jsonb_build_object('status', 'cancelled', 'reason', 'cancelled', 'candidate_id', c_b, 'round_id', r_b,
                       'recall_bot_id', _r1_meet_tests.id(30, 53),
                       'ticket_digest', tkt,
                       'ticket_not_before', '2026-12-02T10:15:00+00:00',
                       'ticket_expires_at', '2026-12-02T11:30:00+00:00'),
    '23505');
  perform _r1_meet_tests.booking_rejected('T1-D the same Recall bot on two bookings', 54,
    jsonb_build_object('status', 'failed', 'reason', 'bot_fatal', 'candidate_id', c_b, 'round_id', r_b,
                       'recall_bot_id', _r1_meet_tests.id(30, 90)),
    '23505');
end;
$$;

-- =============================================================================================
-- T1-E. r1_meet_receipts: CHECKs and the dedupe key.
-- =============================================================================================
do $$
declare
  p_now constant timestamptz := '2026-12-01 04:00:00+00';
  fp constant text := left(_r1_meet_tests.digest('s01-fingerprint'), 16);
  s01_longest text := 'ashby-schedule:' || _r1_meet_tests.id(21, 1)::text || ':r8640000000000000:' || fp;
  s01_year0 text := 'ashby-schedule:' || _r1_meet_tests.id(21, 1)::text || ':-62167219200000:' || fp;
  svix text := 'msg_' || 'p' || left(_r1_meet_tests.digest('svix-1'), 26);
  v_first uuid;
  v_id uuid;
begin
  perform _r1_meet_tests.assert('T1-E the longest S01 Ashby key form is 86 characters',
    char_length(s01_longest) = 86, s01_longest);
  v_first := _r1_meet_tests.receipt('ashby', s01_longest, 'interviewScheduleUpdate');
  perform _r1_meet_tests.assert('T1-E the 86-character S01 Ashby key is accepted, outcome recorded',
    (select r.outcome = 'recorded' and r.processed_at is null and r.booking_id is null
       from screening_v2.r1_meet_receipts r where r.id = v_first));
  perform _r1_meet_tests.receipt('ashby', s01_year0, 'interviewScheduleCreate');
  perform _r1_meet_tests.receipt('recall', svix);
  perform _r1_meet_tests.receipt('recall', 'msg_' || repeat('a', 252));
  perform _r1_meet_tests.assert('T1-E a year-0000 S01 key, a Svix id and a 256-character id are accepted',
    (select count(*) = 3 from screening_v2.r1_meet_receipts r
      where r.dedupe_key in (s01_year0, svix, 'msg_' || repeat('a', 252))));
  v_id := _r1_meet_tests.receipt('recall', svix || '-processed', 'bot.done', 'processed', p_now);
  perform _r1_meet_tests.receipt('recall', svix || '-enqueued', 'bot.done', 'enqueued');
  perform _r1_meet_tests.receipt('recall', svix || '-ignored', 'bot.done', 'ignored', p_now);
  perform _r1_meet_tests.receipt('recall', svix || '-failed', 'bot.done', 'failed', p_now);
  perform _r1_meet_tests.assert('T1-E every outcome is accepted with its processed_at pairing',
    (select count(*) = 4 from screening_v2.r1_meet_receipts r
      where r.dedupe_key like svix || '-%'));

  perform _r1_meet_tests.receipt_rejected('T1-E source calendly', 'calendly', svix || '-c');
  perform _r1_meet_tests.receipt_rejected('T1-E an ashby-source key without the prefix', 'ashby', svix || '-a');
  perform _r1_meet_tests.receipt_rejected('T1-E a recall-source key with the Ashby prefix', 'recall',
    'ashby-schedule:' || _r1_meet_tests.id(21, 2)::text || ':r1:' || fp);
  perform _r1_meet_tests.receipt_rejected('T1-E a key with a space', 'recall', 'msg_with space');
  perform _r1_meet_tests.receipt_rejected('T1-E a key with a slash', 'recall', 'msg_with/slash');
  perform _r1_meet_tests.receipt_rejected('T1-E an empty key', 'recall', '');
  perform _r1_meet_tests.receipt_rejected('T1-E a 257-character key', 'recall', 'msg_' || repeat('a', 253));
  perform _r1_meet_tests.receipt_rejected('T1-E an event type with a space', 'recall', svix || '-e1', 'bot status');
  perform _r1_meet_tests.receipt_rejected('T1-E a 129-character event type', 'recall', svix || '-e2', repeat('e', 129));
  perform _r1_meet_tests.receipt_rejected('T1-E an unknown outcome', 'recall', svix || '-o', 'bot.done', 'done', p_now);
  perform _r1_meet_tests.receipt_rejected('T1-E processed without processed_at', 'recall', svix || '-p', 'bot.done', 'processed', null);
  perform _r1_meet_tests.receipt_rejected('T1-E enqueued with processed_at', 'recall', svix || '-q', 'bot.done', 'enqueued', p_now);
  perform _r1_meet_tests.receipt_rejected('T1-E recorded with processed_at', 'recall', svix || '-r', 'bot.done', 'recorded', p_now);
  perform _r1_meet_tests.receipt_rejected('T1-E a duplicate dedupe key', 'ashby', s01_longest,
    'interviewScheduleUpdate', 'recorded', null, '23505');
  perform _r1_meet_tests.assert('T1-E the duplicate left the first receipt alone',
    (select count(*) = 1 from screening_v2.r1_meet_receipts r where r.dedupe_key in (s01_longest)));
end;
$$;

-- =============================================================================================
-- T1-F. Cascades and the bot release job.
-- =============================================================================================
do $$
declare
  c_n uuid;
  c_y uuid;
  c_s uuid;
  r_s uuid;
  r_r uuid;
  r_x uuid;
  s_1 uuid;
  b_none uuid;
  b_bot uuid;
  b_s uuid;
  b_r uuid;
  b_c uuid;
  b_c2 uuid;
  b_x uuid;
  v_rcpt uuid;
  bot_y constant uuid := _r1_meet_tests.id(30, 1);
  bot_c constant uuid := _r1_meet_tests.id(30, 2);
  bot_x constant uuid := _r1_meet_tests.id(30, 3);
  bot_s constant uuid := _r1_meet_tests.id(30, 4);
begin
  -- A candidate delete (DSAR) removes its booking; a booking without a bot queues nothing.
  c_n := _r1_meet_tests.candidate(30, false);
  perform _r1_meet_tests.round(30);
  b_none := _r1_meet_tests.insert_booking(30, jsonb_build_object(
    'status', 'pending', 'reason', 'eligible', 'candidate_id', c_n, 'round_id', _r1_meet_tests.id(11, 30)));
  delete from screening_v2.candidates where id = c_n;
  perform _r1_meet_tests.assert('T1-F deleting a candidate deletes its booking',
    not exists (select 1 from screening_v2.r1_meet_bookings b where b.id = b_none));
  perform _r1_meet_tests.assert('T1-F a deleted booking without a bot queues no release',
    not exists (select 1 from screening_v2.job_queue j
                 where j.name = 'r1-meet' and j.payload ->> 'booking_id' = b_none::text));

  -- A candidate delete with a bot attached leaves exactly one r1-meet bot_release job.
  c_y := _r1_meet_tests.candidate(31, false);
  perform _r1_meet_tests.round(31);
  b_bot := _r1_meet_tests.insert_booking(31, jsonb_build_object(
    'status', 'bot_scheduled', 'reason', 'eligible', 'candidate_id', c_y,
    'round_id', _r1_meet_tests.id(11, 31), 'recall_bot_id', bot_y));
  delete from screening_v2.candidates where id = c_y;
  perform _r1_meet_tests.assert('T1-F the cascaded booking delete queues exactly one bot_release job',
    not exists (select 1 from screening_v2.r1_meet_bookings b where b.id = b_bot)
    and (select count(*) = 1 from screening_v2.job_queue j
          where j.name = 'r1-meet' and j.status = 'pending' and j.max_attempts = 10
            and j.payload ->> 'kind' = 'bot_release'
            and j.payload ->> 'recall_bot_id' = bot_y::text
            and j.payload ->> 'booking_id' = b_bot::text
            and j.dedup_key in ('r1-meet:bot-release:' || bot_y::text)));
  perform _r1_meet_tests.assert('T1-F the release job carries ids only',
    (select array(select jsonb_object_keys(j.payload) order by 1) = array['booking_id', 'kind', 'recall_bot_id']
       from screening_v2.job_queue j where j.payload ->> 'booking_id' = b_bot::text));

  -- A round delete removes its booking too, and a terminal booking still owed a release queues one.
  perform _r1_meet_tests.candidate(32, false);
  r_r := _r1_meet_tests.round(32);
  b_r := _r1_meet_tests.insert_booking(32, jsonb_build_object(
    'status', 'cancelled', 'reason', 'cancelled', 'candidate_id', _r1_meet_tests.id(10, 32),
    'round_id', r_r, 'recall_bot_id', bot_c));
  delete from screening_v2.interview_rounds where id = r_r;
  perform _r1_meet_tests.assert('T1-F deleting a round deletes its booking and queues the owed release',
    not exists (select 1 from screening_v2.r1_meet_bookings b where b.id = b_r)
    and (select count(*) = 1 from screening_v2.job_queue j
          where j.name = 'r1-meet' and j.dedup_key in ('r1-meet:bot-release:' || bot_c::text)
            and j.payload ->> 'booking_id' = b_r::text));
  perform _r1_meet_tests.assert('T1-F the round delete left the candidate alone',
    exists (select 1 from screening_v2.candidates c where c.id = _r1_meet_tests.id(10, 32)));

  -- A second delete of the same bot while its job is live adds nothing.
  b_c := _r1_meet_tests.insert_booking(33, jsonb_build_object(
    'status', 'failed', 'reason', 'no_show', 'recall_bot_id', bot_x));
  delete from screening_v2.r1_meet_bookings where id = b_c;
  b_c2 := _r1_meet_tests.insert_booking(34, jsonb_build_object(
    'status', 'failed', 'reason', 'no_show', 'recall_bot_id', bot_x));
  delete from screening_v2.r1_meet_bookings where id = b_c2;
  perform _r1_meet_tests.assert('T1-F a repeated release of the same bot while its job is live adds no job',
    (select count(*) = 1 from screening_v2.job_queue j
      where j.name = 'r1-meet' and j.dedup_key in ('r1-meet:bot-release:' || bot_x::text)
        and j.payload ->> 'booking_id' = b_c::text));

  -- Deleting a session keeps the booking and clears its session.
  c_s := _r1_meet_tests.candidate(35, false);
  r_s := _r1_meet_tests.round(35);
  s_1 := _r1_meet_tests.session(35, r_s);
  b_s := _r1_meet_tests.insert_booking(35, jsonb_build_object(
    'status', 'in_call', 'reason', 'eligible', 'candidate_id', c_s, 'round_id', r_s,
    'recall_bot_id', bot_s, 'session_id', s_1));
  delete from screening_v2.call_sessions where id = s_1;
  perform _r1_meet_tests.assert('T1-F deleting a session nulls the booking session_id and keeps the booking',
    (select b.session_id is null and b.status = 'in_call' from screening_v2.r1_meet_bookings b where b.id = b_s));
  perform _r1_meet_tests.assert('T1-F a session delete queues no bot release',
    not exists (select 1 from screening_v2.job_queue j
                 where j.name = 'r1-meet' and j.payload ->> 'booking_id' = b_s::text));

  -- Deleting a booking keeps its receipt and clears the link.
  perform _r1_meet_tests.candidate(36, false);
  r_x := _r1_meet_tests.round(36);
  b_x := _r1_meet_tests.insert_booking(36, jsonb_build_object(
    'status', 'pending', 'reason', 'eligible', 'candidate_id', _r1_meet_tests.id(10, 36), 'round_id', r_x));
  v_rcpt := _r1_meet_tests.receipt('recall', 'msg_' || left(_r1_meet_tests.digest('svix-f'), 24),
                                   'bot.status_change', 'recorded', null, b_x);
  delete from screening_v2.r1_meet_bookings where id = b_x;
  perform _r1_meet_tests.assert('T1-F deleting a booking nulls the receipt booking_id and keeps the receipt',
    (select r.booking_id is null from screening_v2.r1_meet_receipts r where r.id = v_rcpt));
end;
$$;

-- =============================================================================================
-- T2. r1_meet_create_round_from_ashby: the round, the HR-attested consent and the booking.
-- =============================================================================================
-- Fixture numbers 100-199: candidate n is linked to Ashby application id(22, n), and event n books
-- application n unless a call says otherwise. Every call passes p_now explicitly (default
-- 2026-12-01 04:00 UTC). The default slot is 2026-12-02 10:30-11:15 UTC, so a default round
-- expires at 13:15 (slot end + 7200 s). Table aliases are always `x`: no variable is named x.
--
-- The newest active consent release is made OURS for the rest of the run. Earlier suites leave
-- active test releases behind (r1_foundation_assert: version '9002', en-IN, requiring nothing),
-- which would turn every Meet round into blocked/consent_template_unavailable. 'zz-' sorts after
-- every digit-led release in any collation, and the setup asserts that it is the newest.

-- Calls the RPC as S06 would: defaults for event n, overridden by p_args (a JSON null is SQL NULL).
create function _r1_meet_tests.create_round(p_n integer, p_args jsonb default '{}'::jsonb)
returns jsonb language plpgsql as $$
declare
  a jsonb := jsonb_build_object(
    'event_id', _r1_meet_tests.id(20, p_n),
    'schedule_id', _r1_meet_tests.id(21, p_n)::text,
    'application_id', _r1_meet_tests.id(22, p_n)::text,
    'stage_id', _r1_meet_tests.id(23, p_n)::text,
    'interview_id', _r1_meet_tests.id(24, p_n)::text,
    'attester', _r1_meet_tests.id(25, 1)::text,
    'attested_at', '2026-11-30T09:00:00+00:00',
    'updated_at', '2026-11-30T09:00:05+00:00',
    'meet_url', 'https://meet.google.com/abc-defg-hij',
    'start_at', '2026-12-02T10:30:00+00:00',
    'end_at', '2026-12-02T11:15:00+00:00',
    'created_by', _r1_meet_tests.id(1, 1),
    'profile', 'r1_dex_sales',
    'grace', 7200,
    'now', '2026-12-01T04:00:00+00:00') || p_args;
begin
  return screening_v2.r1_meet_create_round_from_ashby(
    (a ->> 'event_id')::uuid, a ->> 'schedule_id', a ->> 'application_id', a ->> 'stage_id',
    a ->> 'interview_id', a ->> 'attester', (a ->> 'attested_at')::timestamptz,
    (a ->> 'updated_at')::timestamptz, a ->> 'meet_url', (a ->> 'start_at')::timestamptz,
    (a ->> 'end_at')::timestamptz, (a ->> 'created_by')::uuid, a ->> 'profile',
    (a ->> 'grace')::integer, (a ->> 'now')::timestamptz);
end;
$$;

-- Runs create_round(p_n) under one more active consent release (newer than ours) inside a
-- subtransaction that is ALWAYS rolled back, so the release and every write of the call vanish
-- (releases are immutable and could not be removed otherwise). Returns the call's answer. A real
-- error (including a failed assertion) is re-raised, never mistaken for the sentinel.
create function _r1_meet_tests.create_round_under_release(p_n integer, p_version text,
                                                          p_locale text, p_required jsonb)
returns jsonb language plpgsql as $$
declare
  v_res jsonb;
  v_done boolean := false;
begin
  begin
    insert into screening_v2.interview_round_consent_templates
      (version, locale, title, body_md, required_consents, is_active)
    values (p_version, p_locale, 'R1 Meet assertion newer notice', 'fixture', p_required, true);
    perform _r1_meet_tests.assert('T2 fixture release ' || p_version || ' (' || p_locale
                                  || ') is the newest active release',
      (select max(x.version) = p_version
         from screening_v2.interview_round_consent_templates x where x.is_active));
    v_res := _r1_meet_tests.create_round(p_n);
    v_done := true;
    raise exception 'r1 meet rollback sentinel' using errcode = 'P0001';
  exception when sqlstate 'P0001' then
    if not v_done then
      raise;
    end if;
  end;
  return v_res;
end;
$$;

-- Every call session of one round (counted per round: earlier suites may leave live sessions).
create function _r1_meet_tests.sessions_of(p_round uuid) returns integer
language sql stable as $$
  select count(*)::integer from screening_v2.call_sessions x where x.interview_round_id = p_round
$$;

-- The minutes reserved in one budget month (0 when the month row does not exist yet).
create function _r1_meet_tests.reserved(p_month date) returns numeric
language sql stable as $$
  select coalesce(sum(x.minutes_reserved), 0) from screening_v2.r1_budget_month x
   where x.month_start = p_month
$$;

-- T2-A. Setup, the happy path, idempotent replay, and admission accepting the HR-attested row.
do $$
declare
  p_now constant timestamptz := '2026-12-01 04:00:00+00';
  hr1 constant text := _r1_meet_tests.id(25, 1)::text;
  tpl constant uuid := _r1_meet_tests.id(3, 2);
  c uuid;
  res jsonb;
  again jsonb;
  b screening_v2.r1_meet_bookings%rowtype;
  r screening_v2.interview_rounds%rowtype;
  k screening_v2.interview_round_consents%rowtype;
  reserved_before numeric;
  r_adm uuid;
  r_wd uuid;
begin
  -- A second auth user: the R1_MEET_SERVICE_USER_ID fallback of T2-B.
  insert into auth.users (id, email)
  values (_r1_meet_tests.id(1, 2), 'r1-meet-assert-2@example.test')
  on conflict (id) do nothing;
  insert into screening_v2.interview_round_consent_templates
    (id, version, locale, title, body_md, required_consents, is_active)
  values (tpl, 'zz-meet-assert-current', 'en-IN', 'R1 Meet assertion current notice', 'fixture',
          '["ai_interview", "video_audio_recording", "ai_evaluation", "data_processing"]'::jsonb, true);
  perform _r1_meet_tests.assert('T2 setup: our en-IN release is the newest active release',
    (select max(x.version) = 'zz-meet-assert-current'
       from screening_v2.interview_round_consent_templates x where x.is_active));
  perform _r1_meet_tests.assert('T2 setup: id(1, 99) is not an auth user',
    not exists (select 1 from auth.users x where x.id = _r1_meet_tests.id(1, 99)));

  -- The happy path.
  c := _r1_meet_tests.candidate(100);
  reserved_before := _r1_meet_tests.reserved('2026-12-01');
  res := _r1_meet_tests.create_round(100);
  select * into b from screening_v2.r1_meet_bookings
   where ashby_interview_event_id = _r1_meet_tests.id(20, 100);
  select * into r from screening_v2.interview_rounds where id = b.round_id;
  perform _r1_meet_tests.assert('T2-A a first eligible event answers created with the binding',
    res ->> 'status' = 'created' and (res ->> 'booking_id')::uuid = b.id
    and (res ->> 'round_id')::uuid = r.id and (res ->> 'candidate_id')::uuid = c
    and res ->> 'booking_status' = 'pending' and res ->> 'reason' = 'eligible'
    and (res ->> 'version')::integer = 0 and (res ->> 'key_attempt')::integer = 0
    and (res ->> 'round_expires_at')::timestamptz = '2026-12-02 13:15:00+00'
    and res ->> 'objective_profile' = 'r1_dex_sales', res::text);
  perform _r1_meet_tests.assert(
    'T2-A the booking is pending/eligible, generation 0, attested by the Ashby scheduler',
    b.status = 'pending' and b.reason = 'eligible' and b.version = 0 and b.key_attempt = 0
    and b.ticket_arms = 0 and b.candidate_id = c and b.round_id = r.id
    and b.ashby_scheduled_by_user_id = hr1
    and b.ashby_schedule_id = _r1_meet_tests.id(21, 100)::text
    and b.ashby_application_id = _r1_meet_tests.id(22, 100)::text
    and b.ashby_interview_stage_id = _r1_meet_tests.id(23, 100)::text
    and b.ashby_interview_id = _r1_meet_tests.id(24, 100)::text
    and b.ashby_updated_at = '2026-11-30 09:00:05+00' and b.objective_profile = 'r1_dex_sales'
    and b.meet_url = 'https://meet.google.com/abc-defg-hij'
    and b.start_at = '2026-12-02 10:30:00+00' and b.end_at = '2026-12-02 11:15:00+00'
    and b.recall_bot_id is null and b.ticket_digest is null and b.session_id is null
    and b.created_at = p_now and b.updated_at = p_now, to_jsonb(b)::text);
  perform _r1_meet_tests.assert('T2-A the round is a Meet round created through r1_send_round',
    r.channel = 'meet' and r.status = 'invited' and r.kind = 'sales_r1'
    and r.role_id = _r1_meet_tests.id(2, 1) and r.candidate_id = c
    and r.created_by = _r1_meet_tests.id(1, 1) and r.candidate_status_at_send = 'new'
    and r.consent_locale = 'en-IN' and r.starts_used = 0 and r.version = 1
    and r.link_token_digest ~ '^[a-f0-9]{64}$', to_jsonb(r)::text);
  perform _r1_meet_tests.assert('T2-A the round holds 65 minutes in the month of p_now',
    r.held_minutes = 65 and r.hold_month = '2026-12-01'
    and _r1_meet_tests.reserved('2026-12-01') = reserved_before + 65,
    format('held %s, month %s, reserved %s -> %s', r.held_minutes, r.hold_month, reserved_before,
           _r1_meet_tests.reserved('2026-12-01')));
  perform _r1_meet_tests.assert('T2-A the round expires exactly at slot end + 7200 s (bounded expiry)',
    r.expires_at = '2026-12-02 11:15:00+00'::timestamptz + interval '7200 seconds',
    r.expires_at::text);

  perform _r1_meet_tests.assert('T2-A the round has exactly one consent row, and it is live',
    (select count(*) = 1 and bool_and(x.withdrawn_at is null)
       from screening_v2.interview_round_consents x where x.round_id = r.id));
  select * into k from screening_v2.interview_round_consents x where x.round_id = r.id;
  perform _r1_meet_tests.assert(
    'T2-A the consent is HR-attested by the Ashby scheduler, never by the round creator',
    k.method = 'hr_attested_ashby' and k.attested_by_external_id = hr1
    and k.attested_by_external_id <> r.created_by::text
    and k.attested_at = '2026-11-30 09:00:00+00' and k.india_location_attested
    and k.granted_at = p_now, to_jsonb(k)::text);
  perform _r1_meet_tests.assert('T2-A the consent covers the newest active en-IN release',
    k.template_id = tpl
    and k.consents = (select x.required_consents
                        from screening_v2.interview_round_consent_templates x where x.id = tpl));
  perform _r1_meet_tests.assert(
    'T2-A the consent proof carries the attestation evidence and nothing personal',
    k.proof ?& array['decision', 'method', 'captured_at', 'template_version', 'locale',
                     'attested_by_external_id', 'attested_at', 'india_location_attested',
                     'source', 'ashby_interview_event_id', 'ashby_schedule_id']
    and (select count(*) = 11 from jsonb_object_keys(k.proof) as x(key))
    and k.proof ->> 'decision' = 'granted' and k.proof ->> 'method' = 'hr_attested_ashby'
    and (k.proof ->> 'captured_at')::timestamptz = p_now
    and k.proof ->> 'template_version' = 'zz-meet-assert-current' and k.proof ->> 'locale' = 'en-IN'
    and k.proof ->> 'attested_by_external_id' = hr1
    and (k.proof ->> 'attested_at')::timestamptz = '2026-11-30 09:00:00+00'
    and (k.proof ->> 'india_location_attested')::boolean
    and k.proof ->> 'source' = 'ashby_interview_schedule'
    and (k.proof ->> 'ashby_interview_event_id')::uuid = _r1_meet_tests.id(20, 100)
    and k.proof ->> 'ashby_schedule_id' = _r1_meet_tests.id(21, 100)::text
    and not (k.proof ?| array['ip_prefix', 'user_agent', 'name', 'email']), k.proof::text);
  perform _r1_meet_tests.assert('T2-A creating the Meet round created no call session',
    _r1_meet_tests.sessions_of(r.id) = 0);
  perform _r1_meet_tests.assert('T2-A the answer carries no link, token or digest',
    not exists (select 1 from jsonb_object_keys(res) as x(key) where x.key ~ '(link|token|digest)')
    and position(r.link_token_digest in res::text) = 0, res::text);

  -- Idempotent replay: the same event answers exists and writes nothing, even with other times.
  again := _r1_meet_tests.create_round(100);
  perform _r1_meet_tests.assert('T2-A an identical replay answers exists with the same binding',
    again ->> 'status' = 'exists' and again ->> 'booking_id' = res ->> 'booking_id'
    and again ->> 'round_id' = res ->> 'round_id' and again ->> 'candidate_id' = res ->> 'candidate_id'
    and again ->> 'booking_status' = 'pending' and again ->> 'reason' = 'eligible'
    and (again ->> 'version')::integer = 0 and (again ->> 'key_attempt')::integer = 0
    and (again ->> 'round_expires_at')::timestamptz = r.expires_at, again::text);
  again := _r1_meet_tests.create_round(100, jsonb_build_object(
    'start_at', '2026-12-02T12:00:00+00:00', 'end_at', '2026-12-02T12:45:00+00:00',
    'updated_at', '2026-11-30T10:00:00+00:00', 'now', '2026-12-01T05:00:00+00:00'));
  perform _r1_meet_tests.assert('T2-A a replay with other times still answers exists',
    again ->> 'status' = 'exists' and again ->> 'round_id' = res ->> 'round_id', again::text);
  perform _r1_meet_tests.assert(
    'T2-A the replays wrote nothing: one round, one consent, one booking, the same hold',
    (select count(*) = 1 from screening_v2.interview_rounds x where x.candidate_id = c)
    and (select count(*) = 1 from screening_v2.interview_round_consents x where x.round_id = r.id)
    and (select count(*) = 1 from screening_v2.r1_meet_bookings x where x.candidate_id = c)
    and _r1_meet_tests.reserved('2026-12-01') = reserved_before + 65
    and (select x.start_at = b.start_at and x.end_at = b.end_at and x.updated_at = b.updated_at
                and x.ashby_updated_at = b.ashby_updated_at
           from screening_v2.r1_meet_bookings x where x.id = b.id)
    and (select x.expires_at = r.expires_at and x.version = r.version
           from screening_v2.interview_rounds x where x.id = r.id));

  -- Admission accepts the HR-attested row UNCHANGED (D4). The answer must come from a check AFTER
  -- the consent gate (earlier suites may leave live R1 sessions, so `ok` alone would be flaky),
  -- and the same kind of round with its consent withdrawn must stop exactly at the gate.
  perform _r1_meet_tests.candidate(101);
  res := _r1_meet_tests.create_round(101);
  r_adm := (res ->> 'round_id')::uuid;
  again := screening_v2.r1_admit_attempt(r_adm, _r1_meet_tests.digest('nonce-101'),
                                         '2026-12-02 10:31:00+00');
  perform _r1_meet_tests.assert('T2-A admission passes the consent gate of a Meet round unchanged',
    res ->> 'status' = 'created'
    and again ->> 'status' in ('ok', 'r1_in_flight', 'round_live', 'cloud_capacity_exhausted',
                               'capacity_exhausted'), again::text);
  perform _r1_meet_tests.candidate(102);
  res := _r1_meet_tests.create_round(102);
  r_wd := (res ->> 'round_id')::uuid;
  again := screening_v2.r1_withdraw_consent(r_wd, '{}'::jsonb, p_now);
  perform _r1_meet_tests.assert('T2-A an HR-attested consent is withdrawn like any other',
    res ->> 'status' = 'created' and again ->> 'status' = 'ok'
    and (again ->> 'withdrawn')::integer = 1, again::text);
  again := screening_v2.r1_admit_attempt(r_wd, _r1_meet_tests.digest('nonce-102'),
                                         '2026-12-02 10:31:00+00');
  perform _r1_meet_tests.assert(
    'T2-A admission refuses a Meet round whose consent was withdrawn: consent_missing',
    again ->> 'status' = 'consent_missing', again::text);
  perform _r1_meet_tests.assert('T2-A the refused admission created no call session',
    _r1_meet_tests.sessions_of(r_wd) = 0);
end;
$$;

-- T2-B. created_by: the service-user fallback, an unknown user, none; the attester never changes.
do $$
declare
  svc constant uuid := _r1_meet_tests.id(1, 2);
  hr2 constant text := _r1_meet_tests.id(25, 2)::text;
  c uuid;
  res jsonb;
  bid uuid;
  b screening_v2.r1_meet_bookings%rowtype;
begin
  c := _r1_meet_tests.candidate(103);
  res := _r1_meet_tests.create_round(103, jsonb_build_object('created_by', svc, 'attester', hr2));
  perform _r1_meet_tests.assert(
    'T2-B the service user creates the round and the Ashby scheduler is the attester',
    res ->> 'status' = 'created'
    and (select x.created_by = svc from screening_v2.interview_rounds x
          where x.id = (res ->> 'round_id')::uuid)
    and (select x.ashby_scheduled_by_user_id = hr2 from screening_v2.r1_meet_bookings x
          where x.id = (res ->> 'booking_id')::uuid)
    and (select x.attested_by_external_id = hr2 and x.attested_by_external_id <> svc::text
                and x.proof ->> 'attested_by_external_id' = hr2
           from screening_v2.interview_round_consents x
          where x.round_id = (res ->> 'round_id')::uuid and x.withdrawn_at is null)
    and _r1_meet_tests.sessions_of((res ->> 'round_id')::uuid) = 0, res::text);

  c := _r1_meet_tests.candidate(104);
  res := _r1_meet_tests.create_round(104, jsonb_build_object('created_by', _r1_meet_tests.id(1, 99)));
  select * into b from screening_v2.r1_meet_bookings
   where ashby_interview_event_id = _r1_meet_tests.id(20, 104);
  bid := b.id;
  perform _r1_meet_tests.assert(
    'T2-B a created_by that is not an auth user: unmapped_scheduler/created_by_unknown, no round',
    res ->> 'status' = 'unmapped_scheduler' and res ->> 'reason' = 'created_by_unknown'
    and (res ->> 'booking_id')::uuid = bid
    and b.status = 'unmapped_scheduler' and b.reason = 'created_by_unknown'
    and b.candidate_id = c and b.round_id is null
    and not exists (select 1 from screening_v2.interview_rounds x where x.candidate_id = c), res::text);
  res := _r1_meet_tests.create_round(104, jsonb_build_object('created_by', null));
  perform _r1_meet_tests.assert(
    'T2-B no created_by: unmapped_scheduler/scheduler_unmapped on the same booking',
    res ->> 'status' = 'unmapped_scheduler' and res ->> 'reason' = 'scheduler_unmapped'
    and (res ->> 'booking_id')::uuid = bid
    and (select x.reason = 'scheduler_unmapped' from screening_v2.r1_meet_bookings x where x.id = bid)
    and not exists (select 1 from screening_v2.interview_rounds x where x.candidate_id = c), res::text);
  res := _r1_meet_tests.create_round(104);
  perform _r1_meet_tests.assert(
    'T2-B once the scheduler maps, the replay creates the round on the same booking row',
    res ->> 'status' = 'created' and (res ->> 'booking_id')::uuid = bid
    and (select count(*) = 1 from screening_v2.r1_meet_bookings x
          where x.ashby_interview_event_id = _r1_meet_tests.id(20, 104))
    and (select x.round_id = (res ->> 'round_id')::uuid and x.status = 'pending'
           from screening_v2.r1_meet_bookings x where x.id = bid), res::text);
end;
$$;

-- T2-C. Candidate matching through ashby_application_links, and the out-of-order guard.
do $$
declare
  res jsonb;
  bid uuid;
  b screening_v2.r1_meet_bookings%rowtype;
begin
  perform _r1_meet_tests.candidate(105, false);
  res := _r1_meet_tests.create_round(105);
  select * into b from screening_v2.r1_meet_bookings
   where ashby_interview_event_id = _r1_meet_tests.id(20, 105);
  bid := b.id;
  perform _r1_meet_tests.assert(
    'T2-C an application with no link: unmatched_application/application_unknown',
    res ->> 'status' = 'unmatched_application' and res ->> 'reason' = 'application_unknown'
    and (res ->> 'booking_id')::uuid = bid and b.status = 'unmatched_application'
    and b.candidate_id is null and b.round_id is null, res::text);

  insert into screening_v2.ashby_application_links (provider, external_application_id)
  values ('ashby', _r1_meet_tests.id(22, 106)::text);
  res := _r1_meet_tests.create_round(106);
  perform _r1_meet_tests.assert('T2-C a link without a candidate: application_unknown',
    res ->> 'status' = 'unmatched_application' and res ->> 'reason' = 'application_unknown', res::text);

  perform _r1_meet_tests.candidate(107, true, 'withdrawn');
  res := _r1_meet_tests.create_round(107);
  perform _r1_meet_tests.assert(
    'T2-C a terminal application link: unmatched_application/application_terminal, no candidate bound',
    res ->> 'status' = 'unmatched_application' and res ->> 'reason' = 'application_terminal'
    and (select x.candidate_id is null and x.round_id is null and x.reason = 'application_terminal'
           from screening_v2.r1_meet_bookings x
          where x.ashby_interview_event_id = _r1_meet_tests.id(20, 107))
    and not exists (select 1 from screening_v2.interview_rounds x
                     where x.candidate_id = _r1_meet_tests.id(10, 107)), res::text);

  res := _r1_meet_tests.create_round(107, jsonb_build_object(
    'updated_at', '2026-11-30T08:00:00+00:00', 'now', '2026-12-01T04:30:00+00:00'));
  perform _r1_meet_tests.assert(
    'T2-C an older Ashby updatedAt on a round-less booking: stale_update, nothing written',
    res ->> 'status' = 'stale_update'
    and (select x.updated_at = '2026-12-01 04:00:00+00' and x.ashby_updated_at = '2026-11-30 09:00:05+00'
           from screening_v2.r1_meet_bookings x
          where x.ashby_interview_event_id = _r1_meet_tests.id(20, 107)), res::text);

  -- The import catches up and links the application: the replay creates on the same booking.
  insert into screening_v2.ashby_application_links (provider, external_application_id, candidate_id)
  values ('ashby', _r1_meet_tests.id(22, 105)::text, _r1_meet_tests.id(10, 105));
  res := _r1_meet_tests.create_round(105);
  perform _r1_meet_tests.assert('T2-C once the application links, the replay creates on the same booking',
    res ->> 'status' = 'created' and (res ->> 'booking_id')::uuid = bid
    and (res ->> 'candidate_id')::uuid = _r1_meet_tests.id(10, 105), res::text);
end;
$$;

-- T2-D. The 14-day window, a started slot, and every invalid_request field.
do $$
declare
  c uuid;
  res jsonb;
  bad record;
  n_bookings integer;
begin
  c := _r1_meet_tests.candidate(108);
  res := _r1_meet_tests.create_round(108, jsonb_build_object(
    'start_at', '2026-12-16T10:00:00+00:00', 'end_at', '2026-12-16T10:45:00+00:00'));
  perform _r1_meet_tests.assert(
    'T2-D an expiry beyond 14 days: blocked/slot_too_far, retry_after = expiry - 14 days, no round',
    res ->> 'status' = 'blocked' and res ->> 'reason' = 'slot_too_far'
    and (res ->> 'retry_after')::timestamptz = '2026-12-16 12:45:00+00'::timestamptz - interval '14 days'
    and (select x.status = 'blocked' and x.reason = 'slot_too_far' and x.candidate_id = c
                and x.round_id is null
           from screening_v2.r1_meet_bookings x
          where x.ashby_interview_event_id = _r1_meet_tests.id(20, 108))
    and not exists (select 1 from screening_v2.interview_rounds x where x.candidate_id = c), res::text);

  c := _r1_meet_tests.candidate(109);
  res := _r1_meet_tests.create_round(109, jsonb_build_object(
    'start_at', '2026-12-15T01:00:00+00:00', 'end_at', '2026-12-15T02:00:00+00:00'));
  perform _r1_meet_tests.assert('T2-D an expiry of exactly p_now + 14 days is inside the window',
    res ->> 'status' = 'created'
    and (select x.expires_at = '2026-12-15 04:00:00+00' from screening_v2.interview_rounds x
          where x.id = (res ->> 'round_id')::uuid), res::text);

  select count(*) into n_bookings from screening_v2.r1_meet_bookings;
  res := _r1_meet_tests.create_round(110, jsonb_build_object(
    'start_at', '2026-12-01T04:00:00+00:00', 'end_at', '2026-12-01T04:45:00+00:00'));
  perform _r1_meet_tests.assert('T2-D a slot that starts at p_now: in_past, no booking',
    res = jsonb_build_object('status', 'in_past')
    and not exists (select 1 from screening_v2.r1_meet_bookings x
                     where x.ashby_interview_event_id = _r1_meet_tests.id(20, 110)), res::text);

  for bad in
    select * from (values
      ('event_id', jsonb_build_object('event_id', null)),
      ('schedule_id', jsonb_build_object('schedule_id', 'schedule-1')),
      ('schedule_id', jsonb_build_object('schedule_id', null)),
      ('application_id', jsonb_build_object('application_id', 'application-1')),
      ('application_id', jsonb_build_object('application_id', null)),
      ('stage_id', jsonb_build_object('stage_id', 'stage-1')),
      ('interview_id', jsonb_build_object('interview_id', 'interview-1')),
      ('attester', jsonb_build_object('attester', 'hr-person-1')),
      ('attester', jsonb_build_object('attester', null)),
      ('meet_url', jsonb_build_object('meet_url', 'https://meet.google.com/ABC-DEFG-HIJ')),
      ('meet_url', jsonb_build_object('meet_url', 'https://meet.google.com/abc-defg-hij?authuser=0')),
      ('meet_url', jsonb_build_object('meet_url', null)),
      ('slot', jsonb_build_object('end_at', '2026-12-02T10:30:00+00:00')),
      ('slot', jsonb_build_object('end_at', '2026-12-03T10:31:00+00:00')),
      ('slot', jsonb_build_object('start_at', null)),
      ('attested_at', jsonb_build_object('attested_at', null)),
      ('attested_at', jsonb_build_object('attested_at', '2026-12-01T04:05:01+00:00')),
      ('profile', jsonb_build_object('profile', 'other')),
      ('profile', jsonb_build_object('profile', null)),
      ('grace', jsonb_build_object('grace', 899)),
      ('grace', jsonb_build_object('grace', 86401)),
      ('grace', jsonb_build_object('grace', null)),
      ('now', jsonb_build_object('now', null))
    ) as t(field, args)
  loop
    res := _r1_meet_tests.create_round(111, bad.args);
    perform _r1_meet_tests.assert('T2-D invalid_request names the field ' || bad.field || ' for '
                                  || bad.args::text,
      res = jsonb_build_object('status', 'invalid_request', 'field', bad.field), res::text);
  end loop;
  perform _r1_meet_tests.assert('T2-D neither in_past nor any invalid_request wrote a booking',
    (select count(*) from screening_v2.r1_meet_bookings) = n_bookings);
end;
$$;

-- T2-E. r1_send_round's refusals become blocked/<code>; the blocked booking retries in place.
do $$
declare
  c uuid;
  res jsonb;
  bid uuid;
  b screening_v2.r1_meet_bookings%rowtype;
begin
  c := _r1_meet_tests.candidate(112);
  update screening_v2.r1_settings set enabled = false where singleton;
  res := _r1_meet_tests.create_round(112);
  select * into b from screening_v2.r1_meet_bookings
   where ashby_interview_event_id = _r1_meet_tests.id(20, 112);
  bid := b.id;
  perform _r1_meet_tests.assert('T2-E R1 disabled: blocked/disabled, candidate bound, no round',
    res ->> 'status' = 'blocked' and res ->> 'reason' = 'disabled' and (res ->> 'booking_id')::uuid = bid
    and b.status = 'blocked' and b.reason = 'disabled' and b.candidate_id = c and b.round_id is null
    and not exists (select 1 from screening_v2.interview_rounds x where x.candidate_id = c), res::text);

  update screening_v2.r1_settings set enabled = true, paused = true where singleton;
  res := _r1_meet_tests.create_round(112);
  perform _r1_meet_tests.assert('T2-E R1 paused: blocked/paused on the same booking',
    res ->> 'status' = 'blocked' and res ->> 'reason' = 'paused'
    and (res ->> 'booking_id')::uuid = bid, res::text);

  update screening_v2.r1_settings set paused = false, monthly_cap_minutes = 65 where singleton;
  perform _r1_meet_tests.assert('T2-E capacity fixture: an outstanding 65-minute hold exists',
    exists (select 1 from screening_v2.interview_rounds x
             where x.held_minutes > 0 and x.status in ('invited', 'in_progress')
               and x.expires_at > '2026-12-01 04:00:00+00'));
  res := _r1_meet_tests.create_round(112);
  perform _r1_meet_tests.assert('T2-E a cap at 65 with a hold outstanding: blocked/capacity_exhausted',
    res ->> 'status' = 'blocked' and res ->> 'reason' = 'capacity_exhausted'
    and (res ->> 'booking_id')::uuid = bid, res::text);
  update screening_v2.r1_settings set monthly_cap_minutes = 100000 where singleton;

  update screening_v2.candidates set decision_use_blocked_at = '2026-12-01 03:00:00+00' where id = c;
  res := _r1_meet_tests.create_round(112);
  perform _r1_meet_tests.assert('T2-E a decision-use block: blocked/candidate_ineligible',
    res ->> 'status' = 'blocked' and res ->> 'reason' = 'candidate_ineligible', res::text);
  update screening_v2.candidates set decision_use_blocked_at = null where id = c;

  update screening_v2.roles set interview_kind = null where id = _r1_meet_tests.id(2, 1);
  res := _r1_meet_tests.create_round(112);
  perform _r1_meet_tests.assert('T2-E no sales_r1 role: blocked/role_not_configured',
    res ->> 'status' = 'blocked' and res ->> 'reason' = 'role_not_configured', res::text);
  update screening_v2.roles set interview_kind = 'sales_r1' where id = _r1_meet_tests.id(2, 1);
  insert into screening_v2.roles (id, title, interview_kind)
  values (_r1_meet_tests.id(2, 2), 'R1 Meet assertion second role', 'sales_r1');
  res := _r1_meet_tests.create_round(112);
  perform _r1_meet_tests.assert('T2-E two sales_r1 roles: blocked/role_not_configured',
    res ->> 'status' = 'blocked' and res ->> 'reason' = 'role_not_configured', res::text);
  update screening_v2.roles set interview_kind = null where id = _r1_meet_tests.id(2, 2);

  res := _r1_meet_tests.create_round(112);
  perform _r1_meet_tests.assert('T2-E once fixed, the blocked booking retries to created in place',
    res ->> 'status' = 'created' and (res ->> 'booking_id')::uuid = bid
    and (select count(*) = 1 from screening_v2.interview_rounds x where x.candidate_id = c)
    and (select count(*) = 1 from screening_v2.r1_meet_bookings x
          where x.ashby_interview_event_id = _r1_meet_tests.id(20, 112)), res::text);
end;
$$;

-- T2-F. No usable notice: the newest release lacks en-IN, or requires nothing (rolled back).
do $$
declare
  res jsonb;
begin
  perform _r1_meet_tests.candidate(113);
  res := _r1_meet_tests.create_round_under_release(113, 'zzz-meet-assert-newer', 'en-GB',
                                                   '["ai_interview"]'::jsonb);
  perform _r1_meet_tests.assert(
    'T2-F the newest release has no en-IN notice: blocked/consent_template_unavailable',
    res ->> 'status' = 'blocked' and res ->> 'reason' = 'consent_template_unavailable', res::text);
  res := _r1_meet_tests.create_round_under_release(113, 'zzz-meet-assert-newer', 'en-IN', '[]'::jsonb);
  perform _r1_meet_tests.assert(
    'T2-F the newest en-IN notice requires nothing: blocked/consent_template_unavailable',
    res ->> 'status' = 'blocked' and res ->> 'reason' = 'consent_template_unavailable', res::text);
  perform _r1_meet_tests.assert('T2-F the rolled-back releases are gone and ours is the newest again',
    (select max(x.version) = 'zz-meet-assert-current'
       from screening_v2.interview_round_consent_templates x where x.is_active));
  res := _r1_meet_tests.create_round(113);
  perform _r1_meet_tests.assert('T2-F with the notice back, the same event creates its round',
    res ->> 'status' = 'created', res::text);
end;
$$;

-- Everything a booking RPC must leave alone around one round, as one jsonb value: the round row,
-- its consent rows, its candidate row, its call sessions and every budget month row. Equal before
-- and after a call = byte-identical (used by T2-G and T3).
create function _r1_meet_tests.round_state(p_round uuid) returns jsonb
language sql stable as $$
  select jsonb_build_object(
    'round', (select to_jsonb(x) from screening_v2.interview_rounds x where x.id = p_round),
    'consents', (select coalesce(jsonb_agg(to_jsonb(x) order by x.id), '[]'::jsonb)
                   from screening_v2.interview_round_consents x where x.round_id = p_round),
    'candidate', (select to_jsonb(y) from screening_v2.candidates y
                   join screening_v2.interview_rounds x on x.candidate_id = y.id
                  where x.id = p_round),
    'sessions', (select coalesce(jsonb_agg(to_jsonb(x) order by x.id), '[]'::jsonb)
                   from screening_v2.call_sessions x where x.interview_round_id = p_round),
    'months', (select coalesce(jsonb_agg(to_jsonb(x) order by x.month_start), '[]'::jsonb)
                 from screening_v2.r1_budget_month x))
$$;

-- T2-G. Re-link after HR cancels and re-books; a live booking or a browser round is never taken.
do $$
declare
  p_now constant timestamptz := '2026-12-01 04:00:00+00';
  hr1 constant text := _r1_meet_tests.id(25, 1)::text;
  hr3 constant text := _r1_meet_tests.id(25, 3)::text;
  c uuid;
  res jsonb;
  browser jsonb;
  r_id uuid;
  k1 uuid;
  b1 uuid;
  st_before jsonb;
  reserved_before numeric;
  r_before screening_v2.interview_rounds%rowtype;
  r_after screening_v2.interview_rounds%rowtype;
  r_browser screening_v2.interview_rounds%rowtype;
begin
  -- E1 (event 120) creates the round, then HR cancels E1 through r1_meet_cancel_booking, which
  -- leaves the round, its consent and the candidate exactly as they were.
  c := _r1_meet_tests.candidate(120);
  res := _r1_meet_tests.create_round(120);
  r_id := (res ->> 'round_id')::uuid;
  b1 := (res ->> 'booking_id')::uuid;
  select * into r_before from screening_v2.interview_rounds where id = r_id;
  select x.id into k1 from screening_v2.interview_round_consents x
   where x.round_id = r_id and x.withdrawn_at is null;
  st_before := _r1_meet_tests.round_state(r_id);
  res := screening_v2.r1_meet_cancel_booking(b1, 'cancelled', p_now);
  perform _r1_meet_tests.assert(
    'T2-G HR cancels E1 through r1_meet_cancel_booking; the round, consent and candidate are byte-identical',
    res ->> 'status' = 'ok' and res ->> 'previous_status' = 'pending'
    and _r1_meet_tests.round_state(r_id) = st_before, res::text);

  -- E2 (event 121): HR schedules a new Dex interview for the same application.
  reserved_before := _r1_meet_tests.reserved('2026-12-01');
  res := _r1_meet_tests.create_round(121, jsonb_build_object(
    'application_id', _r1_meet_tests.id(22, 120)::text, 'attester', hr3,
    'start_at', '2026-12-03T10:00:00+00:00', 'end_at', '2026-12-03T10:45:00+00:00',
    'attested_at', '2026-12-01T03:00:00+00:00'));
  select * into r_after from screening_v2.interview_rounds where id = r_id;
  perform _r1_meet_tests.assert('T2-G a re-booking after a cancel re-links the same Meet round',
    res ->> 'status' = 'relinked' and (res ->> 'round_id')::uuid = r_id
    and (res ->> 'candidate_id')::uuid = c
    and res ->> 'booking_status' = 'pending' and res ->> 'reason' = 'eligible'
    and (res ->> 'version')::integer = 0 and (res ->> 'key_attempt')::integer = 0
    and (res ->> 'round_expires_at')::timestamptz = '2026-12-03 12:45:00+00'
    and (select x.status = 'pending' and x.round_id = r_id and x.ashby_scheduled_by_user_id = hr3
           from screening_v2.r1_meet_bookings x
          where x.ashby_interview_event_id = _r1_meet_tests.id(20, 121)), res::text);
  perform _r1_meet_tests.assert(
    'T2-G the re-link moves only the expiry and the version; the hold stays in its month',
    r_after.expires_at = '2026-12-03 12:45:00+00' and r_after.version = r_before.version + 1
    and r_after.updated_at = p_now and r_after.channel = 'meet' and r_after.status = 'invited'
    and r_after.held_minutes = r_before.held_minutes and r_after.hold_month = r_before.hold_month
    and r_after.link_token_digest = r_before.link_token_digest
    and r_after.created_by = r_before.created_by
    and _r1_meet_tests.reserved('2026-12-01') = reserved_before,
    to_jsonb(r_after)::text);
  perform _r1_meet_tests.assert(
    'T2-G the old consent is superseded, not withdrawn, and no recording erase is queued',
    (select x.withdrawn_at = p_now and x.proof ->> 'decision' = 'superseded'
            and (x.proof ->> 'superseded_at')::timestamptz = p_now
            and x.method = 'hr_attested_ashby' and x.attested_by_external_id = hr1
       from screening_v2.interview_round_consents x where x.id = k1)
    and not exists (select 1 from screening_v2.job_queue j
                     where j.name = 'r1.recording.erase'
                       and j.dedup_key in ('r1.recording.erase:' || k1::text)));
  perform _r1_meet_tests.assert('T2-G the new live consent is attested by the re-booking scheduler',
    (select count(*) = 2 from screening_v2.interview_round_consents x where x.round_id = r_id)
    and (select x.attested_by_external_id = hr3 and x.attested_at = '2026-12-01 03:00:00+00'
                and x.method = 'hr_attested_ashby' and x.template_id = _r1_meet_tests.id(3, 2)
                and (x.proof ->> 'ashby_interview_event_id')::uuid = _r1_meet_tests.id(20, 121)
           from screening_v2.interview_round_consents x
          where x.round_id = r_id and x.withdrawn_at is null));
  perform _r1_meet_tests.assert('T2-G the cancelled booking is left exactly as it was',
    (select x.status = 'cancelled' and x.reason = 'cancelled' and x.round_id = r_id
       from screening_v2.r1_meet_bookings x
      where x.ashby_interview_event_id = _r1_meet_tests.id(20, 120)));
  perform _r1_meet_tests.assert('T2-G the re-link created no call session',
    _r1_meet_tests.sessions_of(r_id) = 0);

  -- E3 (event 122) while E2 is live: the round already has a live booking.
  res := _r1_meet_tests.create_round(122, jsonb_build_object(
    'application_id', _r1_meet_tests.id(22, 120)::text,
    'start_at', '2026-12-04T10:00:00+00:00', 'end_at', '2026-12-04T10:45:00+00:00'));
  perform _r1_meet_tests.assert(
    'T2-G a third event while the re-linked booking is live: blocked/round_active, round untouched',
    res ->> 'status' = 'blocked' and res ->> 'reason' = 'round_active'
    and (select x.status = 'blocked' and x.reason = 'round_active' and x.candidate_id = c
                and x.round_id is null
           from screening_v2.r1_meet_bookings x
          where x.ashby_interview_event_id = _r1_meet_tests.id(20, 122))
    and (select x.expires_at = r_after.expires_at and x.version = r_after.version
           from screening_v2.interview_rounds x where x.id = r_id)
    and (select count(*) = 1 from screening_v2.interview_round_consents x
          where x.round_id = r_id and x.withdrawn_at is null), res::text);

  -- A live BROWSER round is never taken over.
  c := _r1_meet_tests.candidate(123);
  browser := screening_v2.r1_send_round(c, _r1_meet_tests.id(2, 1), _r1_meet_tests.id(1, 1),
                                        _r1_meet_tests.digest('link-123'), 'new',
                                        '2026-12-04 04:00:00+00', p_now);
  res := _r1_meet_tests.create_round(123);
  select * into r_browser from screening_v2.interview_rounds where id = (browser ->> 'id')::uuid;
  perform _r1_meet_tests.assert('T2-G a live browser round is never taken over: blocked/round_active',
    browser ->> 'status' = 'ok' and res ->> 'status' = 'blocked' and res ->> 'reason' = 'round_active'
    and r_browser.channel = 'browser' and r_browser.version = 1
    and r_browser.expires_at = '2026-12-04 04:00:00+00'
    and not exists (select 1 from screening_v2.interview_round_consents x
                     where x.round_id = r_browser.id), res::text);

  -- A lapsed Meet round (its hold no longer counts) is never revived by a re-booking. Nothing can
  -- use it any more (invited, never started, no live booking), so it is expired exactly as
  -- r1_sweep_expired_rounds would expire it, and the re-booking gets a fresh round.
  c := _r1_meet_tests.candidate(124);
  res := _r1_meet_tests.create_round(124);
  r_id := (res ->> 'round_id')::uuid;
  res := screening_v2.r1_meet_cancel_booking((res ->> 'booking_id')::uuid, 'cancelled', p_now);
  perform _r1_meet_tests.assert('T2-G HR cancels event 124 through r1_meet_cancel_booking',
    res ->> 'status' = 'ok', res::text);
  reserved_before := _r1_meet_tests.reserved('2026-12-01');
  res := _r1_meet_tests.create_round(125, jsonb_build_object(
    'application_id', _r1_meet_tests.id(22, 124)::text, 'now', '2026-12-02T14:00:00+00:00',
    'start_at', '2026-12-03T10:00:00+00:00', 'end_at', '2026-12-03T10:45:00+00:00'));
  perform _r1_meet_tests.assert(
    'T2-G a lapsed Meet round is not re-linked: it is expired (hold released) and a fresh round is created',
    res ->> 'status' = 'created' and (res ->> 'round_id')::uuid <> r_id
    and (res ->> 'candidate_id')::uuid = c
    and (select x.status = 'expired' and x.held_minutes = 0 and x.expires_at = '2026-12-02 13:15:00+00'
           from screening_v2.interview_rounds x where x.id = r_id)
    and (select x.status = 'invited' and x.channel = 'meet' and x.held_minutes = 65
                and x.expires_at = '2026-12-03 12:45:00+00'
           from screening_v2.interview_rounds x where x.id = (res ->> 'round_id')::uuid)
    and _r1_meet_tests.reserved('2026-12-01') = reserved_before,
    res::text);
  perform _r1_meet_tests.assert('T2-G the expired round keeps its consent rows; no call session anywhere',
    (select count(*) = 1 from screening_v2.interview_round_consents x where x.round_id = r_id)
    and _r1_meet_tests.sessions_of(r_id) = 0
    and _r1_meet_tests.sessions_of((res ->> 'round_id')::uuid) = 0);
end;
$$;

-- T2-H. Catalog posture of the RPC.
do $$
declare
  fn constant text := 'screening_v2.r1_meet_create_round_from_ashby(uuid, text, text, text, text, text, '
                      'timestamptz, timestamptz, text, timestamptz, timestamptz, uuid, text, integer, timestamptz)';
  who text;
begin
  perform _r1_meet_tests.assert(
    'T2-H r1_meet_create_round_from_ashby is security definer with search_path pg_catalog, screening_v2',
    (select x.prosecdef and x.proconfig = array['search_path=pg_catalog, screening_v2']
       from pg_proc x where x.oid = fn::regprocedure));
  perform _r1_meet_tests.assert('T2-H r1_meet_create_round_from_ashby is executable by service_role only',
    has_function_privilege('service_role', fn, 'execute')
    and not has_function_privilege('anon', fn, 'execute')
    and not has_function_privilege('authenticated', fn, 'execute')
    and not has_function_privilege('public', fn, 'execute'));
  foreach who in array array['anon', 'authenticated'] loop
    perform _r1_meet_tests.raises_as(who, 'T2-H execute r1_meet_create_round_from_ashby',
      'select screening_v2.r1_meet_create_round_from_ashby(null, null, null, null, null, null, '
      'null, null, null, null, null, null)', '42501');
  end loop;
end;
$$;

-- =============================================================================================
-- T3. The booking lifecycle: cancel, the bot generation, reschedule, transitions, sessions.
-- =============================================================================================
-- Fixture numbers 200-299; Recall bots id(30, n) on direct inserts and id(30, 2000+) on RPC
-- attaches. A "pending booking" comes from the T2 RPC: a real Meet round (channel meet, live until
-- slot end + 7200 s = 2026-12-02 13:15 UTC), an HR-attested consent, and the booking
-- pending/eligible at generation (version 0, key_attempt 0). The transition matrix and the session
-- binding read only the booking (and the session), so their bookings are inserted directly in each
-- status (T1 style). In-call states and armed tickets are fixtures here, marked "T4 fixture": T4's
-- arm and claim RPCs write the same columns. Every call passes p_now.

-- A pending booking for event n through the create RPC; returns the booking id.
create function _r1_meet_tests.pending_booking(p_n integer, p_args jsonb default '{}'::jsonb)
returns uuid language plpgsql as $$
declare
  v_res jsonb;
begin
  perform _r1_meet_tests.candidate(p_n);
  v_res := _r1_meet_tests.create_round(p_n, p_args);
  if v_res ->> 'status' is distinct from 'created' then
    raise exception 'R1 MEET FAIL: fixture booking % was not created (%)', p_n, v_res::text;
  end if;
  return (v_res ->> 'booking_id')::uuid;
end;
$$;

-- r1_meet_set_bot with the booking's current generation, as S06 calls it (read, then compare-and-set).
create function _r1_meet_tests.set_bot(p_booking uuid, p_action text, p_bot uuid default null,
                                       p_now timestamptz default '2026-12-01 04:00:00+00')
returns jsonb language plpgsql as $$
declare
  v_version integer;
  v_key integer;
begin
  select x.version, x.key_attempt into v_version, v_key
    from screening_v2.r1_meet_bookings x where x.id = p_booking;
  return screening_v2.r1_meet_set_bot(p_booking, p_action, v_version, v_key, p_bot, p_now);
end;
$$;

-- Calls the reschedule RPC with defaults (the booking's current generation, a new slot on
-- 2026-12-03 09:00-09:45 UTC, a new Meet link, a newer Ashby updatedAt), overridden by p_args.
create function _r1_meet_tests.reschedule(p_booking uuid, p_args jsonb default '{}'::jsonb)
returns jsonb language plpgsql as $$
declare
  a jsonb := jsonb_build_object(
    'version', (select x.version from screening_v2.r1_meet_bookings x where x.id = p_booking),
    'start_at', '2026-12-03T09:00:00+00:00',
    'end_at', '2026-12-03T09:45:00+00:00',
    'meet_url', 'https://meet.google.com/xyz-abcd-efg',
    'updated_at', '2026-11-30T12:00:00+00:00',
    'grace', 7200,
    'now', '2026-12-01T05:00:00+00:00') || p_args;
begin
  return screening_v2.r1_meet_reschedule_booking(
    p_booking, (a ->> 'version')::integer, (a ->> 'start_at')::timestamptz,
    (a ->> 'end_at')::timestamptz, a ->> 'meet_url', (a ->> 'updated_at')::timestamptz,
    (a ->> 'grace')::integer, (a ->> 'now')::timestamptz);
end;
$$;

-- The booking row as one jsonb value (equal before and after = nothing written).
create function _r1_meet_tests.booking_json(p_booking uuid) returns jsonb
language sql stable as $$
  select to_jsonb(x) from screening_v2.r1_meet_bookings x where x.id = p_booking
$$;

-- A booking for event n inserted directly in p_status, on candidate n (no Ashby link) and, where
-- the status allows them, round n (inserted directly) and Recall bot id(30, n).
create function _r1_meet_tests.booking_in(p_n integer, p_status text) returns uuid
language plpgsql as $$
declare
  v_cols jsonb;
begin
  perform _r1_meet_tests.candidate(p_n, false);
  if p_status = 'unmatched_application' then
    v_cols := jsonb_build_object('status', p_status, 'reason', 'application_unknown');
  elsif p_status = 'unmapped_scheduler' then
    v_cols := jsonb_build_object('status', p_status, 'reason', 'scheduler_unmapped',
                                 'candidate_id', _r1_meet_tests.id(10, p_n));
  else
    perform _r1_meet_tests.round(p_n);
    v_cols := jsonb_build_object(
      'status', p_status,
      'reason', case when p_status = 'blocked' then 'not_scheduled' else 'eligible' end,
      'candidate_id', _r1_meet_tests.id(10, p_n),
      'round_id', _r1_meet_tests.id(11, p_n),
      'recall_bot_id', case when p_status in ('bot_scheduled', 'bot_joining', 'human_present', 'in_call')
                            then _r1_meet_tests.id(30, p_n) end);
  end if;
  return _r1_meet_tests.insert_booking(p_n, v_cols);
end;
$$;

-- T4 fixture: an armed ticket (claimed when p_claimed_at is given), the columns T4's
-- r1_meet_arm_ticket and r1_meet_claim_ticket write.
create function _r1_meet_tests.arm_fixture(p_booking uuid, p_tag text,
                                           p_claimed_at timestamptz default null)
returns void language plpgsql as $$
begin
  update screening_v2.r1_meet_bookings
     set ticket_digest = _r1_meet_tests.digest(p_tag),
         ticket_not_before = '2026-12-02 10:15:00+00',
         ticket_expires_at = '2026-12-02 11:45:00+00',
         ticket_claimed_at = p_claimed_at,
         ticket_arms = ticket_arms + 1
   where id = p_booking;
end;
$$;

-- T3-A. Cancel writes the booking only: never the round, its consent, the candidate, a session or
-- a budget month (to_jsonb snapshots before and after).
do $$
declare
  p_now constant timestamptz := '2026-12-01 04:00:00+00';
  t_cancel constant timestamptz := '2026-12-01 06:00:00+00';
  bot_a constant uuid := _r1_meet_tests.id(30, 2001);
  bot_b constant uuid := _r1_meet_tests.id(30, 2002);
  b uuid;
  r uuid;
  res jsonb;
  bj jsonb;
  st_before jsonb;
  bk screening_v2.r1_meet_bookings%rowtype;
begin
  -- A bot_scheduled booking with an armed, unclaimed ticket.
  b := _r1_meet_tests.pending_booking(200);
  select x.round_id into r from screening_v2.r1_meet_bookings x where x.id = b;
  res := _r1_meet_tests.set_bot(b, 'attach', bot_a);
  perform _r1_meet_tests.assert('T3-A fixture: the booking holds a bot', res ->> 'status' = 'ok', res::text);
  perform _r1_meet_tests.arm_fixture(b, 'ticket-200');
  st_before := _r1_meet_tests.round_state(r);
  res := screening_v2.r1_meet_cancel_booking(b, 'cancelled', t_cancel);
  select * into bk from screening_v2.r1_meet_bookings x where x.id = b;
  perform _r1_meet_tests.assert(
    'T3-A cancel of a bot_scheduled booking: ok, names the bot it keeps, not dispatched',
    res = jsonb_build_object('status', 'ok', 'booking_id', b, 'previous_status', 'bot_scheduled',
                             'recall_bot_id', bot_a, 'bot_dispatched', false)
    and bk.status = 'cancelled' and bk.reason = 'cancelled' and bk.recall_bot_id = bot_a
    and bk.version = 0 and bk.key_attempt = 0 and bk.updated_at = t_cancel, res::text);
  perform _r1_meet_tests.assert('T3-A the cancel clears the unclaimed ticket',
    bk.ticket_digest is null and bk.ticket_not_before is null and bk.ticket_expires_at is null
    and bk.ticket_claimed_at is null and bk.ticket_arms = 1, to_jsonb(bk)::text);
  perform _r1_meet_tests.assert(
    'T3-A the cancel left the round, its consent, the candidate, its sessions and the months byte-identical',
    _r1_meet_tests.round_state(r) = st_before);
  perform _r1_meet_tests.assert('T3-A the cancelled booking is an owed bot release',
    exists (select 1 from screening_v2.r1_meet_bookings x
             where x.id = b and x.recall_bot_id is not null
               and x.status in ('completed', 'cancelled', 'failed', 'drained')));

  bj := _r1_meet_tests.booking_json(b);
  res := screening_v2.r1_meet_cancel_booking(b, 'event_removed', '2026-12-01 07:00:00+00');
  perform _r1_meet_tests.assert('T3-A a repeated cancel: already_cancelled with the bot, nothing written',
    res = jsonb_build_object('status', 'already_cancelled', 'booking_id', b, 'reason', 'cancelled',
                             'recall_bot_id', bot_a)
    and _r1_meet_tests.booking_json(b) = bj, res::text);

  -- An in-call booking (dispatched bot, claimed ticket): leave_call, and the ticket stays as evidence.
  b := _r1_meet_tests.pending_booking(201);
  select x.round_id into r from screening_v2.r1_meet_bookings x where x.id = b;
  res := _r1_meet_tests.set_bot(b, 'attach', bot_b);
  res := screening_v2.r1_meet_transition_booking(b, 'bot_scheduled', 'human_present', 'eligible', p_now);
  perform _r1_meet_tests.assert('T3-A fixture: a human is present', res ->> 'status' = 'ok', res::text);
  -- T4 fixture: the claim moves the booking to in_call with a claimed ticket.
  perform _r1_meet_tests.arm_fixture(b, 'ticket-201', '2026-12-02 10:31:00+00');
  update screening_v2.r1_meet_bookings set status = 'in_call' where id = b;
  st_before := _r1_meet_tests.round_state(r);
  res := screening_v2.r1_meet_cancel_booking(b, 'event_removed', '2026-12-02 10:40:00+00');
  select * into bk from screening_v2.r1_meet_bookings x where x.id = b;
  perform _r1_meet_tests.assert('T3-A cancel of an in-call booking: ok, bot_dispatched (leave_call)',
    res = jsonb_build_object('status', 'ok', 'booking_id', b, 'previous_status', 'in_call',
                             'recall_bot_id', bot_b, 'bot_dispatched', true)
    and bk.status = 'cancelled' and bk.reason = 'event_removed' and bk.recall_bot_id = bot_b, res::text);
  perform _r1_meet_tests.assert('T3-A a claimed ticket is kept by the cancel',
    bk.ticket_digest = _r1_meet_tests.digest('ticket-201')
    and bk.ticket_claimed_at = '2026-12-02 10:31:00+00'
    and bk.ticket_not_before = '2026-12-02 10:15:00+00'
    and bk.ticket_expires_at = '2026-12-02 11:45:00+00', to_jsonb(bk)::text);
  perform _r1_meet_tests.assert(
    'T3-A the in-call cancel left the round, its consent, the candidate, its sessions and the months byte-identical',
    _r1_meet_tests.round_state(r) = st_before);

  -- A pending booking (no bot yet): nothing to remove.
  b := _r1_meet_tests.pending_booking(202);
  select x.round_id into r from screening_v2.r1_meet_bookings x where x.id = b;
  st_before := _r1_meet_tests.round_state(r);
  res := screening_v2.r1_meet_cancel_booking(b, 'dex_absent', t_cancel);
  perform _r1_meet_tests.assert('T3-A cancel of a pending booking: ok, no bot, not dispatched',
    res = jsonb_build_object('status', 'ok', 'booking_id', b, 'previous_status', 'pending',
                             'recall_bot_id', null::uuid, 'bot_dispatched', false)
    and (select x.status = 'cancelled' and x.reason = 'dex_absent' and x.recall_bot_id is null
           from screening_v2.r1_meet_bookings x where x.id = b)
    and _r1_meet_tests.round_state(r) = st_before, res::text);

  -- An unmatched booking (no candidate, no round).
  perform _r1_meet_tests.candidate(203, false);
  res := _r1_meet_tests.create_round(203);
  b := (res ->> 'booking_id')::uuid;
  res := screening_v2.r1_meet_cancel_booking(b, 'cancelled', t_cancel);
  perform _r1_meet_tests.assert('T3-A cancel of an unmatched booking: ok',
    res ->> 'status' = 'ok' and res ->> 'previous_status' = 'unmatched_application'
    and (select x.status = 'cancelled' and x.candidate_id is null and x.round_id is null
           from screening_v2.r1_meet_bookings x where x.id = b), res::text);

  -- Refusals.
  b := _r1_meet_tests.pending_booking(204);
  bj := _r1_meet_tests.booking_json(b);
  res := screening_v2.r1_meet_cancel_booking(b, 'flag_off', t_cancel);
  perform _r1_meet_tests.assert('T3-A a reason outside the cancelled family: invalid_reason',
    res = jsonb_build_object('status', 'invalid_reason'), res::text);
  res := screening_v2.r1_meet_cancel_booking(b, null, t_cancel);
  perform _r1_meet_tests.assert('T3-A no reason: invalid_reason',
    res = jsonb_build_object('status', 'invalid_reason'), res::text);
  res := screening_v2.r1_meet_cancel_booking(b, 'cancelled', null);
  perform _r1_meet_tests.assert('T3-A no p_now: invalid_request (now)',
    res = jsonb_build_object('status', 'invalid_request', 'field', 'now'), res::text);
  perform _r1_meet_tests.assert('T3-A the refused cancels wrote nothing',
    _r1_meet_tests.booking_json(b) = bj);
  res := screening_v2.r1_meet_cancel_booking(_r1_meet_tests.id(99, 1), 'cancelled', t_cancel);
  perform _r1_meet_tests.assert('T3-A an unknown booking: not_found',
    res = jsonb_build_object('status', 'not_found'), res::text);

  b := _r1_meet_tests.pending_booking(205);
  res := screening_v2.r1_meet_transition_booking(b, 'pending', 'failed', 'in_past', p_now);
  res := screening_v2.r1_meet_cancel_booking(b, 'cancelled', t_cancel);
  perform _r1_meet_tests.assert('T3-A a failed booking is not cancelled: booking_terminal',
    res = jsonb_build_object('status', 'booking_terminal', 'booking_id', b,
                             'booking_status', 'failed', 'reason', 'in_past')
    and (select x.status = 'failed' from screening_v2.r1_meet_bookings x where x.id = b), res::text);
end;
$$;

-- T3-B. r1_meet_set_bot: attach, rotate_key, replace, release; compare-and-set on (version,
-- key_attempt); the caps of 20 key attempts and 50 generations.
do $$
declare
  p_now constant timestamptz := '2026-12-01 04:00:00+00';
  bot_a constant uuid := _r1_meet_tests.id(30, 2101);
  bot_b constant uuid := _r1_meet_tests.id(30, 2102);
  bot_c constant uuid := _r1_meet_tests.id(30, 2103);
  bot_d constant uuid := _r1_meet_tests.id(30, 2104);
  b uuid;
  b2 uuid;
  res jsonb;
  bj jsonb;
  ok_all boolean;
  i integer;
  bk screening_v2.r1_meet_bookings%rowtype;
  rr screening_v2.interview_rounds%rowtype;
begin
  b := _r1_meet_tests.pending_booking(210);
  res := screening_v2.r1_meet_set_bot(b, 'attach', 0, 0, bot_a, '2026-12-01 05:00:00+00');
  select * into bk from screening_v2.r1_meet_bookings x where x.id = b;
  perform _r1_meet_tests.assert('T3-B attach on a pending booking: bot_scheduled, the generation unchanged',
    res = jsonb_build_object('status', 'ok', 'booking_id', b, 'version', 0, 'key_attempt', 0,
                             'booking_status', 'bot_scheduled')
    and bk.status = 'bot_scheduled' and bk.reason = 'eligible' and bk.recall_bot_id = bot_a
    and bk.updated_at = '2026-12-01 05:00:00+00', res::text);

  bj := _r1_meet_tests.booking_json(b);
  res := screening_v2.r1_meet_set_bot(b, 'attach', 0, 0, bot_a, p_now);
  perform _r1_meet_tests.assert('T3-B the same bot again: duplicate',
    res = jsonb_build_object('status', 'duplicate', 'booking_id', b, 'version', 0, 'key_attempt', 0,
                             'booking_status', 'bot_scheduled'), res::text);
  res := screening_v2.r1_meet_set_bot(b, 'attach', 0, 0, bot_b, p_now);
  perform _r1_meet_tests.assert('T3-B another bot while one is attached: bot_conflict',
    res ->> 'status' = 'bot_conflict', res::text);
  res := screening_v2.r1_meet_set_bot(b, 'attach', 1, 0, bot_a, p_now);
  perform _r1_meet_tests.assert('T3-B a stale version: version_conflict with the current generation',
    res = jsonb_build_object('status', 'version_conflict', 'booking_id', b, 'version', 0,
                             'key_attempt', 0, 'booking_status', 'bot_scheduled'), res::text);
  res := screening_v2.r1_meet_set_bot(b, 'attach', 0, 1, bot_a, p_now);
  perform _r1_meet_tests.assert('T3-B a stale key_attempt: version_conflict',
    res ->> 'status' = 'version_conflict', res::text);
  res := screening_v2.r1_meet_set_bot(b, 'replace', 0, 1, null, p_now);
  perform _r1_meet_tests.assert('T3-B the compare-and-set guards replace too: version_conflict',
    res ->> 'status' = 'version_conflict', res::text);
  res := screening_v2.r1_meet_set_bot(b, 'rotate_key', 0, 0, null, p_now);
  perform _r1_meet_tests.assert('T3-B rotate_key while a bot is attached: not_allowed',
    res ->> 'status' = 'not_allowed', res::text);
  res := screening_v2.r1_meet_set_bot(b, 'release', 0, 0, null, p_now);
  perform _r1_meet_tests.assert('T3-B release of an active booking: not_allowed',
    res ->> 'status' = 'not_allowed', res::text);
  perform _r1_meet_tests.assert('T3-B none of these refusals wrote anything',
    _r1_meet_tests.booking_json(b) = bj);

  -- replace: the bot was deleted at Recall before dispatch; a new generation, no bot, no ticket.
  perform _r1_meet_tests.arm_fixture(b, 'ticket-210');
  perform _r1_meet_tests.arm_fixture(b, 'ticket-210b');
  res := screening_v2.r1_meet_set_bot(b, 'replace', 0, 0, null, '2026-12-01 05:10:00+00');
  select * into bk from screening_v2.r1_meet_bookings x where x.id = b;
  perform _r1_meet_tests.assert(
    'T3-B replace: pending/eligible, version + 1, key_attempt 0, no bot, no ticket, a fresh arm budget',
    res = jsonb_build_object('status', 'ok', 'booking_id', b, 'version', 1, 'key_attempt', 0,
                             'booking_status', 'pending')
    and bk.status = 'pending' and bk.reason = 'eligible' and bk.recall_bot_id is null
    and bk.version = 1 and bk.key_attempt = 0 and bk.ticket_digest is null
    and bk.ticket_not_before is null and bk.ticket_expires_at is null and bk.ticket_claimed_at is null
    and bk.ticket_arms = 0 and bk.updated_at = '2026-12-01 05:10:00+00', to_jsonb(bk)::text);
  res := screening_v2.r1_meet_set_bot(b, 'replace', 1, 0, null, p_now);
  perform _r1_meet_tests.assert('T3-B replace without a bot: not_allowed',
    res ->> 'status' = 'not_allowed', res::text);

  -- rotate_key on the pending booking: 1, 2, ... 20, then exhausted.
  res := screening_v2.r1_meet_set_bot(b, 'rotate_key', 1, 0, null, '2026-12-01 05:20:00+00');
  perform _r1_meet_tests.assert('T3-B rotate_key on a pending booking: key_attempt 1, same generation',
    res = jsonb_build_object('status', 'ok', 'booking_id', b, 'version', 1, 'key_attempt', 1,
                             'booking_status', 'pending')
    and (select x.updated_at = '2026-12-01 05:20:00+00' from screening_v2.r1_meet_bookings x where x.id = b),
    res::text);
  ok_all := true;
  for i in 1..19 loop
    res := screening_v2.r1_meet_set_bot(b, 'rotate_key', 1, i, null, p_now);
    ok_all := ok_all and res ->> 'status' = 'ok' and (res ->> 'key_attempt')::integer = i + 1;
  end loop;
  perform _r1_meet_tests.assert('T3-B rotate_key counts up to 20',
    ok_all and (select x.key_attempt = 20 from screening_v2.r1_meet_bookings x where x.id = b));
  res := screening_v2.r1_meet_set_bot(b, 'rotate_key', 1, 20, null, p_now);
  perform _r1_meet_tests.assert('T3-B a 21st key: key_attempts_exhausted, nothing written',
    res = jsonb_build_object('status', 'key_attempts_exhausted', 'booking_id', b, 'version', 1,
                             'key_attempt', 20, 'booking_status', 'pending'), res::text);
  res := screening_v2.r1_meet_set_bot(b, 'attach', 1, 20, bot_b, p_now);
  perform _r1_meet_tests.assert('T3-B the last key still attaches a bot', res ->> 'status' = 'ok', res::text);
  res := screening_v2.r1_meet_set_bot(b, 'replace', 1, 20, null, p_now);
  perform _r1_meet_tests.assert('T3-B replace starts the next generation at key_attempt 0',
    res ->> 'status' = 'ok' and (res ->> 'version')::integer = 2 and (res ->> 'key_attempt')::integer = 0,
    res::text);

  -- Generations 2..49 attach and replace; the 50th cannot be replaced.
  ok_all := true;
  for i in 2..49 loop
    res := screening_v2.r1_meet_set_bot(b, 'attach', i, 0, _r1_meet_tests.id(30, 2300 + i), p_now);
    ok_all := ok_all and res ->> 'status' = 'ok';
    res := screening_v2.r1_meet_set_bot(b, 'replace', i, 0, null, p_now);
    ok_all := ok_all and res ->> 'status' = 'ok' and (res ->> 'version')::integer = i + 1;
  end loop;
  perform _r1_meet_tests.assert('T3-B every generation up to 50 attaches and is replaced',
    ok_all and (select x.version = 50 and x.status = 'pending' from screening_v2.r1_meet_bookings x
                 where x.id = b));
  res := screening_v2.r1_meet_set_bot(b, 'attach', 50, 0, bot_c, p_now);
  perform _r1_meet_tests.assert('T3-B generation 50 attaches', res ->> 'status' = 'ok', res::text);
  res := screening_v2.r1_meet_set_bot(b, 'replace', 50, 0, null, p_now);
  perform _r1_meet_tests.assert('T3-B replacing generation 50: version_exhausted, the bot stays',
    res = jsonb_build_object('status', 'version_exhausted', 'booking_id', b, 'version', 50,
                             'key_attempt', 0, 'booking_status', 'bot_scheduled')
    and (select x.recall_bot_id = bot_c from screening_v2.r1_meet_bookings x where x.id = b), res::text);

  -- The slot has ended: no bot is attached.
  b2 := _r1_meet_tests.pending_booking(211);
  res := screening_v2.r1_meet_set_bot(b2, 'attach', 0, 0, bot_d, '2026-12-02 11:15:00+00');
  perform _r1_meet_tests.assert('T3-B attach at the slot end: in_past',
    res ->> 'status' = 'in_past', res::text);
  res := screening_v2.r1_meet_set_bot(b2, 'attach', 0, 0, bot_d, '2026-12-02 12:00:00+00');
  perform _r1_meet_tests.assert('T3-B attach after the slot end: in_past, still pending without a bot',
    res ->> 'status' = 'in_past'
    and (select x.status = 'pending' and x.recall_bot_id is null
           from screening_v2.r1_meet_bookings x where x.id = b2), res::text);

  -- A bot belongs to one booking.
  res := screening_v2.r1_meet_set_bot(b2, 'attach', 0, 0, bot_c, p_now);
  perform _r1_meet_tests.assert('T3-B a bot already on another booking: bot_in_use',
    res ->> 'status' = 'bot_in_use'
    and (select x.recall_bot_id is null from screening_v2.r1_meet_bookings x where x.id = b2), res::text);
  res := screening_v2.r1_meet_set_bot(b2, 'attach', 0, 0, bot_d, p_now);
  perform _r1_meet_tests.assert('T3-B a fresh bot attaches', res ->> 'status' = 'ok', res::text);

  -- release: only a terminal booking's bot, once.
  res := screening_v2.r1_meet_cancel_booking(b2, 'cancelled', p_now);
  res := screening_v2.r1_meet_set_bot(b2, 'release', 0, 0, null, '2026-12-01 06:00:00+00');
  select * into bk from screening_v2.r1_meet_bookings x where x.id = b2;
  perform _r1_meet_tests.assert('T3-B release on a cancelled booking clears the bot (no longer owed)',
    res = jsonb_build_object('status', 'ok', 'booking_id', b2, 'version', 0, 'key_attempt', 0,
                             'booking_status', 'cancelled')
    and bk.recall_bot_id is null and bk.status = 'cancelled' and bk.reason = 'cancelled'
    and bk.updated_at = '2026-12-01 06:00:00+00', res::text);
  res := screening_v2.r1_meet_set_bot(b2, 'release', 0, 0, null, p_now);
  perform _r1_meet_tests.assert('T3-B a second release: duplicate', res ->> 'status' = 'duplicate', res::text);
  res := screening_v2.r1_meet_set_bot(b2, 'attach', 0, 0, bot_d, p_now);
  perform _r1_meet_tests.assert('T3-B a terminal booking takes no bot: not_allowed',
    res ->> 'status' = 'not_allowed', res::text);
  perform _r1_meet_tests.assert('T3-B set_bot queued no job',
    not exists (select 1 from screening_v2.job_queue j
                 where j.name = 'r1-meet' and j.payload ->> 'booking_id' in (b::text, b2::text)));

  -- Not pending: a blocked booking takes no bot and rotates no key.
  b := _r1_meet_tests.pending_booking(212);
  res := screening_v2.r1_meet_transition_booking(b, 'pending', 'blocked', 'no_meet_link', p_now);
  res := screening_v2.r1_meet_set_bot(b, 'attach', 0, 0, _r1_meet_tests.id(30, 2105), p_now);
  perform _r1_meet_tests.assert('T3-B attach on a blocked booking: not_allowed',
    res ->> 'status' = 'not_allowed', res::text);
  res := screening_v2.r1_meet_set_bot(b, 'rotate_key', 0, 0, null, p_now);
  perform _r1_meet_tests.assert('T3-B rotate_key on a blocked booking: not_allowed',
    res ->> 'status' = 'not_allowed', res::text);

  -- The round is no longer live (HR cancelled it in our app).
  b := _r1_meet_tests.pending_booking(213);
  select * into rr from screening_v2.interview_rounds x
   where x.id = (select y.round_id from screening_v2.r1_meet_bookings y where y.id = b);
  res := screening_v2.r1_transition_round(rr.id, 'cancel', rr.version, null, null, p_now);
  perform _r1_meet_tests.assert('T3-B fixture: the round is cancelled', res ->> 'status' = 'ok', res::text);
  res := screening_v2.r1_meet_set_bot(b, 'attach', 0, 0, _r1_meet_tests.id(30, 2106), p_now);
  perform _r1_meet_tests.assert('T3-B attach on a cancelled round: round_not_live, no bot',
    res ->> 'status' = 'round_not_live'
    and (select x.recall_bot_id is null and x.status = 'pending'
           from screening_v2.r1_meet_bookings x where x.id = b), res::text);

  -- Input checks.
  res := screening_v2.r1_meet_set_bot(b, 'delete', 0, 0, null, p_now);
  perform _r1_meet_tests.assert('T3-B an unknown action: invalid_action',
    res = jsonb_build_object('status', 'invalid_action'), res::text);
  res := screening_v2.r1_meet_set_bot(b, null, 0, 0, null, p_now);
  perform _r1_meet_tests.assert('T3-B no action: invalid_action',
    res = jsonb_build_object('status', 'invalid_action'), res::text);
  res := screening_v2.r1_meet_set_bot(b, 'attach', 0, 0, null, p_now);
  perform _r1_meet_tests.assert('T3-B attach without a bot id: invalid_request (recall_bot_id)',
    res = jsonb_build_object('status', 'invalid_request', 'field', 'recall_bot_id'), res::text);
  res := screening_v2.r1_meet_set_bot(b, 'rotate_key', 0, 0, null, null);
  perform _r1_meet_tests.assert('T3-B no p_now: invalid_request (now)',
    res = jsonb_build_object('status', 'invalid_request', 'field', 'now'), res::text);
  res := screening_v2.r1_meet_set_bot(_r1_meet_tests.id(99, 1), 'rotate_key', 0, 0, null, p_now);
  perform _r1_meet_tests.assert('T3-B an unknown booking: not_found',
    res = jsonb_build_object('status', 'not_found'), res::text);
end;
$$;

-- T3-C. r1_meet_reschedule_booking: the new slot and link, the round expiry with it, every refusal.
do $$
declare
  p_now constant timestamptz := '2026-12-01 04:00:00+00';
  url2 constant text := 'https://meet.google.com/xyz-abcd-efg';
  b uuid;
  b2 uuid;
  r uuid;
  res jsonb;
  bj jsonb;
  st_before jsonb;
  k_before jsonb;
  reserved_before numeric;
  bad record;
  bk screening_v2.r1_meet_bookings%rowtype;
  r_before screening_v2.interview_rounds%rowtype;
  r_after screening_v2.interview_rounds%rowtype;
begin
  b := _r1_meet_tests.pending_booking(220);
  select x.round_id into r from screening_v2.r1_meet_bookings x where x.id = b;
  select * into r_before from screening_v2.interview_rounds x where x.id = r;
  select jsonb_agg(to_jsonb(x) order by x.id) into k_before
    from screening_v2.interview_round_consents x where x.round_id = r;
  reserved_before := _r1_meet_tests.reserved('2026-12-01');
  res := _r1_meet_tests.reschedule(b, jsonb_build_object('updated_at', '2026-11-30T10:00:00+00:00'));
  select * into r_after from screening_v2.interview_rounds x where x.id = r;
  select * into bk from screening_v2.r1_meet_bookings x where x.id = b;
  perform _r1_meet_tests.assert(
    'T3-C reschedule of a pending booking: ok, the round expires at the new end + 7200 s',
    res ->> 'status' = 'ok' and (res ->> 'booking_id')::uuid = b
    and (res ->> 'round_expires_at')::timestamptz = '2026-12-03 11:45:00+00'
    and (res ->> 'version')::integer = 1 and (res ->> 'key_attempt')::integer = 0, res::text);
  perform _r1_meet_tests.assert(
    'T3-C the round moved only its expiry, version and updated_at; the hold stays in its month',
    r_after.expires_at = '2026-12-03 11:45:00+00' and r_after.version = r_before.version + 1
    and r_after.updated_at = '2026-12-01 05:00:00+00'
    and (to_jsonb(r_after) - 'expires_at' - 'version' - 'updated_at')
        = (to_jsonb(r_before) - 'expires_at' - 'version' - 'updated_at')
    and _r1_meet_tests.reserved('2026-12-01') = reserved_before, to_jsonb(r_after)::text);
  perform _r1_meet_tests.assert('T3-C the consent rows are untouched by a reschedule',
    (select jsonb_agg(to_jsonb(x) order by x.id) from screening_v2.interview_round_consents x
      where x.round_id = r) = k_before);
  perform _r1_meet_tests.assert(
    'T3-C the booking has the new slot, link and Ashby updatedAt, pending/eligible, the next generation',
    bk.start_at = '2026-12-03 09:00:00+00' and bk.end_at = '2026-12-03 09:45:00+00'
    and bk.meet_url = url2 and bk.ashby_updated_at = '2026-11-30 10:00:00+00'
    and bk.status = 'pending' and bk.reason = 'eligible' and bk.version = 1 and bk.key_attempt = 0
    and bk.round_id = r and bk.updated_at = '2026-12-01 05:00:00+00', to_jsonb(bk)::text);
  perform _r1_meet_tests.assert('T3-C the reschedule created no call session',
    _r1_meet_tests.sessions_of(r) = 0);

  -- An earlier slot shortens the expiry; a missing Ashby updatedAt keeps the stored one.
  res := _r1_meet_tests.reschedule(b, jsonb_build_object(
    'start_at', '2026-12-01T20:00:00+00:00', 'end_at', '2026-12-01T20:45:00+00:00',
    'updated_at', null, 'grace', 900, 'now', '2026-12-01T05:30:00+00:00'));
  perform _r1_meet_tests.assert('T3-C an earlier slot shortens the round expiry',
    res ->> 'status' = 'ok' and (res ->> 'round_expires_at')::timestamptz = '2026-12-01 21:00:00+00'
    and (res ->> 'version')::integer = 2
    and (select x.expires_at = '2026-12-01 21:00:00+00' and x.version = r_before.version + 2
           from screening_v2.interview_rounds x where x.id = r)
    and (select x.ashby_updated_at = '2026-11-30 10:00:00+00' and x.start_at = '2026-12-01 20:00:00+00'
                and x.version = 2 and x.key_attempt = 0
           from screening_v2.r1_meet_bookings x where x.id = b), res::text);

  -- Refusals that change nothing.
  bj := _r1_meet_tests.booking_json(b);
  st_before := _r1_meet_tests.round_state(r);
  res := _r1_meet_tests.reschedule(b, jsonb_build_object('updated_at', '2026-11-30T09:30:00+00:00'));
  perform _r1_meet_tests.assert('T3-C an older Ashby updatedAt: stale_update',
    res = jsonb_build_object('status', 'stale_update', 'booking_id', b), res::text);
  res := _r1_meet_tests.reschedule(b, jsonb_build_object('version', 1));
  perform _r1_meet_tests.assert('T3-C another bot generation: version_conflict',
    res = jsonb_build_object('status', 'version_conflict', 'booking_id', b, 'version', 2,
                             'key_attempt', 0), res::text);
  res := _r1_meet_tests.reschedule(b, jsonb_build_object(
    'start_at', '2026-12-20T10:00:00+00:00', 'end_at', '2026-12-20T10:45:00+00:00',
    'now', '2026-12-01T06:00:00+00:00'));
  perform _r1_meet_tests.assert(
    'T3-C a new expiry beyond 14 days: slot_too_far with retry_after, nothing changes',
    res ->> 'status' = 'slot_too_far'
    and (res ->> 'retry_after')::timestamptz = '2026-12-20 12:45:00+00'::timestamptz - interval '14 days',
    res::text);
  res := _r1_meet_tests.reschedule(b, jsonb_build_object(
    'start_at', '2026-12-01T05:00:00+00:00', 'end_at', '2026-12-01T05:45:00+00:00',
    'now', '2026-12-01T06:00:00+00:00'));
  perform _r1_meet_tests.assert('T3-C a slot that has started: in_past',
    res = jsonb_build_object('status', 'in_past', 'booking_id', b), res::text);
  for bad in
    select * from (values
      ('meet_url', jsonb_build_object('meet_url', 'https://meet.google.com/XYZ-ABCD-EFG')),
      ('meet_url', jsonb_build_object('meet_url', null)),
      ('slot', jsonb_build_object('end_at', '2026-12-03T09:00:00+00:00')),
      ('slot', jsonb_build_object('end_at', '2026-12-04T09:01:00+00:00')),
      ('slot', jsonb_build_object('start_at', null)),
      ('grace', jsonb_build_object('grace', 899)),
      ('grace', jsonb_build_object('grace', 86401)),
      ('grace', jsonb_build_object('grace', null)),
      ('now', jsonb_build_object('now', null))
    ) as t(field, args)
  loop
    res := _r1_meet_tests.reschedule(b, bad.args);
    perform _r1_meet_tests.assert('T3-C invalid_request names the field ' || bad.field || ' for '
                                  || bad.args::text,
      res = jsonb_build_object('status', 'invalid_request', 'field', bad.field), res::text);
  end loop;
  res := _r1_meet_tests.reschedule(_r1_meet_tests.id(99, 1));
  perform _r1_meet_tests.assert('T3-C an unknown booking: not_found',
    res = jsonb_build_object('status', 'not_found'), res::text);
  perform _r1_meet_tests.assert(
    'T3-C none of the refusals changed the booking, the round, its consent or the months',
    _r1_meet_tests.booking_json(b) = bj and _r1_meet_tests.round_state(r) = st_before);

  -- A bot is attached: S06 deletes it at Recall, replaces, reschedules, attaches the next one.
  b2 := _r1_meet_tests.pending_booking(221);
  res := _r1_meet_tests.set_bot(b2, 'attach', _r1_meet_tests.id(30, 2201));
  res := _r1_meet_tests.reschedule(b2);
  perform _r1_meet_tests.assert('T3-C a booking that holds a bot: bot_attached',
    res = jsonb_build_object('status', 'bot_attached', 'booking_id', b2, 'version', 0,
                             'key_attempt', 0), res::text);
  res := _r1_meet_tests.set_bot(b2, 'replace');
  res := _r1_meet_tests.reschedule(b2, jsonb_build_object('version', 0));
  perform _r1_meet_tests.assert('T3-C the generation before the replace: version_conflict',
    res ->> 'status' = 'version_conflict' and (res ->> 'version')::integer = 1, res::text);
  res := _r1_meet_tests.reschedule(b2);
  perform _r1_meet_tests.assert(
    'T3-C after the replace the reschedule goes through, a new slot and link being one more generation',
    res ->> 'status' = 'ok' and (res ->> 'version')::integer = 2, res::text);
  res := _r1_meet_tests.set_bot(b2, 'attach', _r1_meet_tests.id(30, 2202));
  perform _r1_meet_tests.assert('T3-C the next generation attaches on the new slot',
    res ->> 'status' = 'ok'
    and (select x.status = 'bot_scheduled' and x.version = 2 and x.recall_bot_id = _r1_meet_tests.id(30, 2202)
                and x.start_at = '2026-12-03 09:00:00+00'
           from screening_v2.r1_meet_bookings x where x.id = b2), res::text);
  res := screening_v2.r1_meet_transition_booking(b2, 'bot_scheduled', 'bot_joining', 'eligible', p_now);
  res := _r1_meet_tests.reschedule(b2);
  perform _r1_meet_tests.assert('T3-C a dispatched bot holds the slot: booking_dispatched',
    res = jsonb_build_object('status', 'booking_dispatched', 'booking_id', b2,
                             'booking_status', 'bot_joining'), res::text);

  -- A booking without a round retries through the create RPC instead.
  perform _r1_meet_tests.candidate(222);
  res := _r1_meet_tests.create_round(222, jsonb_build_object(
    'start_at', '2026-12-20T10:00:00+00:00', 'end_at', '2026-12-20T10:45:00+00:00'));
  b := (res ->> 'booking_id')::uuid;
  res := _r1_meet_tests.reschedule(b);
  perform _r1_meet_tests.assert('T3-C a round-less blocked booking: no_round',
    res = jsonb_build_object('status', 'no_round', 'booking_id', b, 'booking_status', 'blocked',
                             'reason', 'slot_too_far'), res::text);

  -- A blocked booking with a round (its Meet link went away) comes back to pending.
  b := _r1_meet_tests.pending_booking(223);
  res := screening_v2.r1_meet_transition_booking(b, 'pending', 'blocked', 'no_meet_link', p_now);
  res := _r1_meet_tests.reschedule(b, jsonb_build_object('meet_url', 'https://meet.google.com/pqr-stuv-wxy'));
  perform _r1_meet_tests.assert('T3-C blocked/no_meet_link with a round: back to pending/eligible',
    res ->> 'status' = 'ok'
    and (select x.status = 'pending' and x.reason = 'eligible'
                and x.meet_url = 'https://meet.google.com/pqr-stuv-wxy'
           from screening_v2.r1_meet_bookings x where x.id = b), res::text);

  -- The round was cancelled in our app: nothing to move.
  b := _r1_meet_tests.pending_booking(224);
  select * into r_before from screening_v2.interview_rounds x
   where x.id = (select y.round_id from screening_v2.r1_meet_bookings y where y.id = b);
  res := screening_v2.r1_transition_round(r_before.id, 'cancel', r_before.version, null, null, p_now);
  perform _r1_meet_tests.assert('T3-C fixture: the round is cancelled', res ->> 'status' = 'ok', res::text);
  bj := _r1_meet_tests.booking_json(b);
  st_before := _r1_meet_tests.round_state(r_before.id);
  res := _r1_meet_tests.reschedule(b);
  perform _r1_meet_tests.assert('T3-C a cancelled round: round_not_live, nothing changes',
    res = jsonb_build_object('status', 'round_not_live', 'booking_id', b, 'round_id', r_before.id)
    and _r1_meet_tests.booking_json(b) = bj and _r1_meet_tests.round_state(r_before.id) = st_before,
    res::text);
  res := screening_v2.r1_meet_cancel_booking(b, 'round_cancelled', p_now);
  res := _r1_meet_tests.reschedule(b);
  perform _r1_meet_tests.assert('T3-C a cancelled booking is never rescheduled: booking_terminal',
    res = jsonb_build_object('status', 'booking_terminal', 'booking_id', b,
                             'booking_status', 'cancelled', 'reason', 'round_cancelled'), res::text);

  -- The Idempotency-Key follows the body (review F2). Recall ignores the body of a request whose
  -- key it has seen, so a new slot or link is a new bot generation (version + 1, key_attempt 0),
  -- and a reschedule that moves neither keeps both counters.
  b := _r1_meet_tests.pending_booking(225);
  res := _r1_meet_tests.set_bot(b, 'rotate_key');
  perform _r1_meet_tests.assert('T3-C fixture: a rotated key (generation 0, attempt 1)',
    res ->> 'status' = 'ok' and (res ->> 'key_attempt')::integer = 1, res::text);
  res := screening_v2.r1_meet_transition_booking(b, 'pending', 'blocked', 'not_scheduled', p_now);
  res := _r1_meet_tests.reschedule(b, jsonb_build_object(
    'start_at', '2026-12-02T10:30:00+00:00', 'end_at', '2026-12-02T11:15:00+00:00',
    'meet_url', 'https://meet.google.com/abc-defg-hij'));
  perform _r1_meet_tests.assert(
    'T3-C a reschedule that moves neither the slot nor the link keeps the generation and the key attempt',
    res ->> 'status' = 'ok' and (res ->> 'version')::integer = 0 and (res ->> 'key_attempt')::integer = 1
    and (select x.status = 'pending' and x.version = 0 and x.key_attempt = 1
           from screening_v2.r1_meet_bookings x where x.id = b), res::text);
  -- A create was sent with key v0-k1 and its answer was lost (no bot recorded); HR then moves the
  -- slot. The reschedule starts generation 1, so the next create never replays the slot-A answer.
  res := _r1_meet_tests.reschedule(b, jsonb_build_object('meet_url', 'https://meet.google.com/abc-defg-hij'));
  perform _r1_meet_tests.assert('T3-C a new slot alone is a new generation: version 1, key attempt 0',
    res ->> 'status' = 'ok' and (res ->> 'version')::integer = 1 and (res ->> 'key_attempt')::integer = 0
    and (select x.version = 1 and x.key_attempt = 0 and x.start_at = '2026-12-03 09:00:00+00'
           from screening_v2.r1_meet_bookings x where x.id = b), res::text);
  res := screening_v2.r1_meet_set_bot(b, 'attach', 0, 1, _r1_meet_tests.id(30, 2251), p_now);
  perform _r1_meet_tests.assert(
    'T3-C the bot that the lost slot-A create made cannot attach: version_conflict, no bot',
    res ->> 'status' = 'version_conflict' and (res ->> 'version')::integer = 1
    and (select x.recall_bot_id is null and x.status = 'pending'
           from screening_v2.r1_meet_bookings x where x.id = b), res::text);
  res := _r1_meet_tests.reschedule(b, jsonb_build_object(
    'start_at', '2026-12-03T09:00:00+00:00', 'end_at', '2026-12-03T09:45:00+00:00',
    'meet_url', 'https://meet.google.com/pqr-stuv-wxy'));
  perform _r1_meet_tests.assert('T3-C a new link alone is a new generation: version 2',
    res ->> 'status' = 'ok' and (res ->> 'version')::integer = 2, res::text);
  -- The 50-generation cap: a move at version 50 changes nothing; a no-move reschedule still works.
  b := _r1_meet_tests.pending_booking(226);
  update screening_v2.r1_meet_bookings set version = 50 where id = b;
  bj := _r1_meet_tests.booking_json(b);
  res := _r1_meet_tests.reschedule(b);
  perform _r1_meet_tests.assert('T3-C a move at generation 50: version_exhausted, nothing written',
    res = jsonb_build_object('status', 'version_exhausted', 'booking_id', b, 'version', 50)
    and _r1_meet_tests.booking_json(b) = bj, res::text);
  res := _r1_meet_tests.reschedule(b, jsonb_build_object(
    'start_at', '2026-12-02T10:30:00+00:00', 'end_at', '2026-12-02T11:15:00+00:00',
    'meet_url', 'https://meet.google.com/abc-defg-hij'));
  perform _r1_meet_tests.assert('T3-C at generation 50 a reschedule that moves nothing still goes through',
    res ->> 'status' = 'ok' and (res ->> 'version')::integer = 50, res::text);
end;
$$;

-- T3-D. r1_meet_transition_booking: every edge of the matrix once, and every refusal.
do $$
declare
  t_move constant timestamptz := '2026-12-01 07:00:00+00';
  e record;
  n integer := 230;
  b uuid;
  had_bot uuid;
  res jsonb;
  bj jsonb;
  bk screening_v2.r1_meet_bookings%rowtype;
begin
  for e in
    select * from (values
      ('bot_scheduled', 'bot_joining', 'eligible'),
      ('bot_scheduled', 'human_present', 'eligible'),
      ('bot_joining', 'human_present', 'eligible'),
      ('in_call', 'completed', 'attempt_settled'),
      ('pending', 'blocked', 'bot_cap_reached'),
      ('blocked', 'blocked', 'no_attester'),
      ('pending', 'failed', 'in_past'),
      ('blocked', 'failed', 'round_expired'),
      ('unmatched_application', 'failed', 'in_past'),
      ('unmapped_scheduler', 'failed', 'in_past'),
      ('bot_scheduled', 'failed', 'bot_fatal'),
      ('bot_joining', 'failed', 'no_show'),
      ('human_present', 'failed', 'multiple_humans'),
      ('in_call', 'failed', 'admission_refused'),
      ('pending', 'drained', 'flag_off'),
      ('blocked', 'drained', 'flag_off'),
      ('unmatched_application', 'drained', 'flag_off'),
      ('unmapped_scheduler', 'drained', 'flag_off'),
      ('bot_scheduled', 'drained', 'flag_off'),
      ('bot_joining', 'drained', 'flag_off'),
      ('human_present', 'drained', 'flag_off'),
      ('in_call', 'drained', 'flag_off')
    ) as t(from_status, to_status, why)
  loop
    n := n + 1;
    b := _r1_meet_tests.booking_in(n, e.from_status);
    select x.recall_bot_id into had_bot from screening_v2.r1_meet_bookings x where x.id = b;
    res := screening_v2.r1_meet_transition_booking(b, e.from_status, e.to_status, e.why, t_move);
    select * into bk from screening_v2.r1_meet_bookings x where x.id = b;
    perform _r1_meet_tests.assert(
      'T3-D edge ' || e.from_status || ' -> ' || e.to_status || ' (' || e.why || ')',
      res = jsonb_build_object('status', 'ok', 'booking_id', b, 'previous_status', e.from_status,
                               'booking_status', e.to_status, 'reason', e.why,
                               'recall_bot_id', had_bot)
      and bk.status = e.to_status and bk.reason = e.why and bk.updated_at = t_move
      and bk.recall_bot_id is not distinct from had_bot, res::text);
  end loop;
  perform _r1_meet_tests.assert('T3-D the matrix has 22 edges', n = 252, n::text);

  -- Moves outside the matrix, and a moved booking: nothing is written.
  b := _r1_meet_tests.booking_in(253, 'pending');
  bj := _r1_meet_tests.booking_json(b);
  res := screening_v2.r1_meet_transition_booking(b, 'pending', 'completed', 'attempt_settled', t_move);
  perform _r1_meet_tests.assert('T3-D pending -> completed: invalid_transition',
    res = jsonb_build_object('status', 'invalid_transition', 'booking_id', b,
                             'from_status', 'pending', 'to_status', 'completed'), res::text);
  res := screening_v2.r1_meet_transition_booking(b, 'pending', 'cancelled', 'cancelled', t_move);
  perform _r1_meet_tests.assert('T3-D pending -> cancelled (the cancel RPC owns it): invalid_transition',
    res ->> 'status' = 'invalid_transition', res::text);
  res := screening_v2.r1_meet_transition_booking(b, 'pending', 'bot_scheduled', 'eligible', t_move);
  perform _r1_meet_tests.assert('T3-D pending -> bot_scheduled (set_bot owns it): invalid_transition',
    res ->> 'status' = 'invalid_transition', res::text);
  res := screening_v2.r1_meet_transition_booking(b, 'pending', 'in_call', 'eligible', t_move);
  perform _r1_meet_tests.assert('T3-D pending -> in_call (the claim owns it): invalid_transition',
    res ->> 'status' = 'invalid_transition', res::text);
  res := screening_v2.r1_meet_transition_booking(b, 'pending', 'pending', 'eligible', t_move);
  perform _r1_meet_tests.assert('T3-D pending -> pending: invalid_transition',
    res ->> 'status' = 'invalid_transition', res::text);
  res := screening_v2.r1_meet_transition_booking(b, 'pending', null, 'in_past', t_move);
  perform _r1_meet_tests.assert('T3-D no target status: invalid_transition',
    res ->> 'status' = 'invalid_transition', res::text);
  res := screening_v2.r1_meet_transition_booking(b, 'blocked', 'failed', 'in_past', t_move);
  perform _r1_meet_tests.assert('T3-D a wrong from-status: status_conflict with the current status',
    res = jsonb_build_object('status', 'status_conflict', 'booking_id', b, 'current', 'pending'),
    res::text);
  res := screening_v2.r1_meet_transition_booking(b, null, 'failed', 'in_past', t_move);
  perform _r1_meet_tests.assert('T3-D no from-status: status_conflict',
    res ->> 'status' = 'status_conflict', res::text);
  perform _r1_meet_tests.assert('T3-D the refused moves wrote nothing', _r1_meet_tests.booking_json(b) = bj);

  b := _r1_meet_tests.booking_in(254, 'human_present');
  res := screening_v2.r1_meet_transition_booking(b, 'human_present', 'bot_joining', 'eligible', t_move);
  perform _r1_meet_tests.assert('T3-D human_present -> bot_joining (backwards): invalid_transition',
    res ->> 'status' = 'invalid_transition', res::text);
  res := screening_v2.r1_meet_transition_booking(b, 'human_present', 'in_call', 'eligible', t_move);
  perform _r1_meet_tests.assert('T3-D human_present -> in_call (the claim owns it): invalid_transition',
    res ->> 'status' = 'invalid_transition', res::text);
  res := screening_v2.r1_meet_transition_booking(b, 'human_present', 'completed', 'attempt_settled', t_move);
  perform _r1_meet_tests.assert('T3-D human_present -> completed: invalid_transition',
    res ->> 'status' = 'invalid_transition', res::text);

  b := _r1_meet_tests.booking_in(255, 'pending');
  res := screening_v2.r1_meet_transition_booking(b, 'pending', 'failed', 'in_past', t_move);
  res := screening_v2.r1_meet_transition_booking(b, 'failed', 'drained', 'flag_off', t_move);
  perform _r1_meet_tests.assert('T3-D a terminal booking moves no further: invalid_transition',
    res ->> 'status' = 'invalid_transition'
    and (select x.status = 'failed' and x.reason = 'in_past' from screening_v2.r1_meet_bookings x
          where x.id = b), res::text);

  -- The reason is checked by the status/reason pairing CHECK alone (23514).
  b := _r1_meet_tests.booking_in(256, 'pending');
  bj := _r1_meet_tests.booking_json(b);
  perform _r1_meet_tests.raises('T3-D pending -> failed with reason flag_off',
    format('select screening_v2.r1_meet_transition_booking(%L::uuid, %L, %L, %L, %L::timestamptz)',
           b, 'pending', 'failed', 'flag_off', t_move), '23514');
  perform _r1_meet_tests.raises('T3-D pending -> blocked with reason eligible',
    format('select screening_v2.r1_meet_transition_booking(%L::uuid, %L, %L, %L, %L::timestamptz)',
           b, 'pending', 'blocked', 'eligible', t_move), '23514');
  perform _r1_meet_tests.raises('T3-D pending -> drained with an unknown reason',
    format('select screening_v2.r1_meet_transition_booking(%L::uuid, %L, %L, %L, %L::timestamptz)',
           b, 'pending', 'drained', 'because', t_move), '23514');
  perform _r1_meet_tests.assert('T3-D the rejected reasons wrote nothing', _r1_meet_tests.booking_json(b) = bj);

  -- A terminal move clears an unclaimed ticket and keeps a claimed one; other moves keep it.
  b := _r1_meet_tests.booking_in(257, 'bot_scheduled');
  perform _r1_meet_tests.arm_fixture(b, 'ticket-257');
  res := screening_v2.r1_meet_transition_booking(b, 'bot_scheduled', 'failed', 'bot_fatal', t_move);
  select * into bk from screening_v2.r1_meet_bookings x where x.id = b;
  perform _r1_meet_tests.assert('T3-D a move to failed clears the unclaimed ticket, keeps the bot',
    res ->> 'status' = 'ok' and bk.ticket_digest is null and bk.ticket_not_before is null
    and bk.ticket_expires_at is null and bk.ticket_claimed_at is null and bk.ticket_arms = 1
    and bk.recall_bot_id = _r1_meet_tests.id(30, 257), to_jsonb(bk)::text);
  b := _r1_meet_tests.booking_in(258, 'in_call');
  perform _r1_meet_tests.arm_fixture(b, 'ticket-258', '2026-12-02 10:31:00+00');
  res := screening_v2.r1_meet_transition_booking(b, 'in_call', 'completed', 'attempt_settled', t_move);
  select * into bk from screening_v2.r1_meet_bookings x where x.id = b;
  perform _r1_meet_tests.assert('T3-D a move to completed keeps the claimed ticket',
    res ->> 'status' = 'ok' and bk.ticket_digest = _r1_meet_tests.digest('ticket-258')
    and bk.ticket_claimed_at = '2026-12-02 10:31:00+00', to_jsonb(bk)::text);
  b := _r1_meet_tests.booking_in(259, 'in_call');
  perform _r1_meet_tests.arm_fixture(b, 'ticket-259');
  res := screening_v2.r1_meet_transition_booking(b, 'in_call', 'drained', 'flag_off', t_move);
  perform _r1_meet_tests.assert('T3-D a move to drained clears an unclaimed (re-armed) ticket',
    res ->> 'status' = 'ok'
    and (select x.ticket_digest is null and x.ticket_expires_at is null
           from screening_v2.r1_meet_bookings x where x.id = b), res::text);
  b := _r1_meet_tests.booking_in(260, 'bot_scheduled');
  perform _r1_meet_tests.arm_fixture(b, 'ticket-260');
  res := screening_v2.r1_meet_transition_booking(b, 'bot_scheduled', 'human_present', 'eligible', t_move);
  perform _r1_meet_tests.assert('T3-D a move to human_present keeps the armed ticket',
    res ->> 'status' = 'ok'
    and (select x.ticket_digest = _r1_meet_tests.digest('ticket-260') and x.ticket_claimed_at is null
           from screening_v2.r1_meet_bookings x where x.id = b), res::text);

  -- Input checks.
  res := screening_v2.r1_meet_transition_booking(_r1_meet_tests.id(99, 1), 'pending', 'failed', 'in_past', t_move);
  perform _r1_meet_tests.assert('T3-D an unknown booking: not_found',
    res = jsonb_build_object('status', 'not_found'), res::text);
  res := screening_v2.r1_meet_transition_booking(b, 'human_present', 'failed', 'no_show', null);
  perform _r1_meet_tests.assert('T3-D no p_now: invalid_request (now)',
    res = jsonb_build_object('status', 'invalid_request', 'field', 'now'), res::text);
end;
$$;

-- T3-E. r1_meet_bind_session: an in-call booking binds a session of its own round; a restart
-- re-binds.
do $$
declare
  b uuid;
  b_sched uuid;
  r uuid;
  s1 uuid;
  s2 uuid;
  s_other uuid;
  res jsonb;
  bk screening_v2.r1_meet_bookings%rowtype;
begin
  b := _r1_meet_tests.booking_in(270, 'in_call');
  r := _r1_meet_tests.id(11, 270);
  s1 := _r1_meet_tests.session(270, r);
  perform _r1_meet_tests.candidate(271, false);
  s_other := _r1_meet_tests.session(271, _r1_meet_tests.round(271));
  b_sched := _r1_meet_tests.booking_in(272, 'bot_scheduled');

  res := screening_v2.r1_meet_bind_session(b_sched, s1, '2026-12-02 10:32:00+00');
  perform _r1_meet_tests.assert('T3-E a booking that is not in call: not_in_call',
    res = jsonb_build_object('status', 'not_in_call', 'booking_id', b_sched,
                             'booking_status', 'bot_scheduled'), res::text);
  res := screening_v2.r1_meet_bind_session(b, s_other, '2026-12-02 10:32:00+00');
  perform _r1_meet_tests.assert('T3-E a session of another round: session_mismatch',
    res = jsonb_build_object('status', 'session_mismatch', 'booking_id', b), res::text);
  res := screening_v2.r1_meet_bind_session(b, _r1_meet_tests.id(12, 299), '2026-12-02 10:32:00+00');
  perform _r1_meet_tests.assert('T3-E an unknown session: session_mismatch',
    res ->> 'status' = 'session_mismatch', res::text);
  res := screening_v2.r1_meet_bind_session(b, null, '2026-12-02 10:32:00+00');
  perform _r1_meet_tests.assert('T3-E no session: session_mismatch',
    res ->> 'status' = 'session_mismatch'
    and (select x.session_id is null from screening_v2.r1_meet_bookings x where x.id = b), res::text);

  res := screening_v2.r1_meet_bind_session(b, s1, '2026-12-02 10:32:00+00');
  select * into bk from screening_v2.r1_meet_bookings x where x.id = b;
  perform _r1_meet_tests.assert('T3-E the round''s session binds to the in-call booking',
    res = jsonb_build_object('status', 'ok', 'booking_id', b, 'session_id', s1,
                             'previous_session_id', null::uuid)
    and bk.session_id = s1 and bk.status = 'in_call' and bk.updated_at = '2026-12-02 10:32:00+00',
    res::text);
  res := screening_v2.r1_meet_bind_session(b, s1, '2026-12-02 10:33:00+00');
  perform _r1_meet_tests.assert('T3-E the same session again: duplicate, nothing written',
    res = jsonb_build_object('status', 'duplicate', 'booking_id', b, 'session_id', s1)
    and (select x.updated_at = '2026-12-02 10:32:00+00' from screening_v2.r1_meet_bookings x
          where x.id = b), res::text);

  -- A restart: the first session ended, and the round's next session re-binds.
  update screening_v2.call_sessions set status = 'failed', terminal_reason = 'worker_crash' where id = s1;
  s2 := _r1_meet_tests.session(273, r);
  res := screening_v2.r1_meet_bind_session(b, s2, '2026-12-02 10:40:00+00');
  perform _r1_meet_tests.assert('T3-E a later session of the same round re-binds and names the previous one',
    res = jsonb_build_object('status', 'ok', 'booking_id', b, 'session_id', s2,
                             'previous_session_id', s1)
    and (select x.session_id = s2 from screening_v2.r1_meet_bookings x where x.id = b), res::text);
  perform _r1_meet_tests.assert('T3-E binding created no session of its own',
    _r1_meet_tests.sessions_of(r) = 2);

  res := screening_v2.r1_meet_bind_session(_r1_meet_tests.id(99, 1), s2, '2026-12-02 10:40:00+00');
  perform _r1_meet_tests.assert('T3-E an unknown booking: not_found',
    res = jsonb_build_object('status', 'not_found'), res::text);
  res := screening_v2.r1_meet_bind_session(b, s2, null);
  perform _r1_meet_tests.assert('T3-E no p_now: invalid_request (now)',
    res = jsonb_build_object('status', 'invalid_request', 'field', 'now'), res::text);

  -- Leave no live fixture session behind.
  update screening_v2.call_sessions set status = 'failed', terminal_reason = 'worker_crash'
   where id in (s2, s_other);
end;
$$;

-- T3-F. Catalog posture of the five lifecycle RPCs.
do $$
declare
  fn text;
  who text;
begin
  foreach fn in array array[
    'screening_v2.r1_meet_reschedule_booking(uuid, integer, timestamptz, timestamptz, text, timestamptz, integer, timestamptz)',
    'screening_v2.r1_meet_cancel_booking(uuid, text, timestamptz)',
    'screening_v2.r1_meet_set_bot(uuid, text, integer, integer, uuid, timestamptz)',
    'screening_v2.r1_meet_transition_booking(uuid, text, text, text, timestamptz)',
    'screening_v2.r1_meet_bind_session(uuid, uuid, timestamptz)'
  ] loop
    perform _r1_meet_tests.assert(
      'T3-F ' || fn || ' is security definer with search_path pg_catalog, screening_v2',
      (select x.prosecdef and x.proconfig = array['search_path=pg_catalog, screening_v2']
         from pg_proc x where x.oid = fn::regprocedure));
    perform _r1_meet_tests.assert('T3-F ' || fn || ' is executable by service_role only',
      has_function_privilege('service_role', fn, 'execute')
      and not has_function_privilege('anon', fn, 'execute')
      and not has_function_privilege('authenticated', fn, 'execute')
      and not has_function_privilege('public', fn, 'execute'));
  end loop;
  foreach who in array array['anon', 'authenticated'] loop
    perform _r1_meet_tests.raises_as(who, 'T3-F execute r1_meet_reschedule_booking',
      'select screening_v2.r1_meet_reschedule_booking(null, null, null, null, null, null)', '42501');
    perform _r1_meet_tests.raises_as(who, 'T3-F execute r1_meet_cancel_booking',
      'select screening_v2.r1_meet_cancel_booking(null, null)', '42501');
    perform _r1_meet_tests.raises_as(who, 'T3-F execute r1_meet_set_bot',
      'select screening_v2.r1_meet_set_bot(null, null, null, null)', '42501');
    perform _r1_meet_tests.raises_as(who, 'T3-F execute r1_meet_transition_booking',
      'select screening_v2.r1_meet_transition_booking(null, null, null, null)', '42501');
    perform _r1_meet_tests.raises_as(who, 'T3-F execute r1_meet_bind_session',
      'select screening_v2.r1_meet_bind_session(null, null)', '42501');
  end loop;
end;
$$;

-- T3-G. Recovery for one Ashby event (review F1, F6). A booking whose round lapsed before its bot
-- was dispatched re-binds to a fresh round on the create replay; a failed booking that Ashby moves
-- to a new, future slot or link is revived the same way; both start a new bot generation (a new
-- Idempotency-Key). A replay always reads the event's booking first, also after the slot started.
-- Cases (l) to (o) (review F1, round 2): a re-bind or a revival resets every counter of the old
-- attempt (a rotated key, a spent arm budget, a claimed ticket, a bound session); step 8a never
-- expires a round another event's live booking holds; and a round the sweep already expired is
-- re-bound like one that only lapsed. (o) runs the real r1_sweep_expired_rounds, so it comes last.
-- Fixture numbers 274-278 and 280-292; Recall bots id(30, 2800 + n) in (a)-(k) and the named
-- constants below in (l)-(o).
do $$
declare
  p_now constant timestamptz := '2026-12-01 04:00:00+00';
  t_lapsed constant timestamptz := '2026-12-02 14:00:00+00';
  bot_l1 constant uuid := _r1_meet_tests.id(30, 2741);
  bot_l2 constant uuid := _r1_meet_tests.id(30, 2742);
  bot_m constant uuid := _r1_meet_tests.id(30, 2751);
  bot_n constant uuid := _r1_meet_tests.id(30, 2761);
  b uuid;
  r_old uuid;
  r_new uuid;
  k_old uuid;
  s uuid;
  i integer;
  n_swept integer;
  rj jsonb;
  res jsonb;
  bj jsonb;
  st_before jsonb;
  bk screening_v2.r1_meet_bookings%rowtype;
begin
  -- (a) The slot_too_far gap. HR moves a pending booking's slot 20 days out: the reschedule answers
  -- slot_too_far and S06 blocks the booking. The round lapses at 2026-12-02 13:15. At retry_after
  -- the reschedule still answers round_not_live, and the create replay re-binds.
  b := _r1_meet_tests.pending_booking(280);
  select x.round_id into r_old from screening_v2.r1_meet_bookings x where x.id = b;
  res := _r1_meet_tests.reschedule(b, jsonb_build_object(
    'start_at', '2026-12-21T10:00:00+00:00', 'end_at', '2026-12-21T10:45:00+00:00'));
  perform _r1_meet_tests.assert('T3-G fixture: a move 20 days out answers slot_too_far',
    res ->> 'status' = 'slot_too_far', res::text);
  res := screening_v2.r1_meet_transition_booking(b, 'pending', 'blocked', 'slot_too_far', p_now);
  res := _r1_meet_tests.reschedule(b, jsonb_build_object(
    'start_at', '2026-12-21T10:00:00+00:00', 'end_at', '2026-12-21T10:45:00+00:00',
    'now', '2026-12-07T12:45:00+00:00'));
  perform _r1_meet_tests.assert('T3-G at retry_after the reschedule answers round_not_live (the round lapsed)',
    res ->> 'status' = 'round_not_live', res::text);
  res := _r1_meet_tests.create_round(280, jsonb_build_object(
    'start_at', '2026-12-21T10:00:00+00:00', 'end_at', '2026-12-21T10:45:00+00:00',
    'updated_at', '2026-11-30T12:00:00+00:00', 'now', '2026-12-07T12:45:00+00:00'));
  r_new := (res ->> 'round_id')::uuid;
  select * into bk from screening_v2.r1_meet_bookings x where x.id = b;
  perform _r1_meet_tests.assert(
    'T3-G the create replay re-binds a blocked booking whose round lapsed: a fresh round, generation 1',
    res ->> 'status' = 'created' and (res ->> 'rebound')::boolean
    and (res ->> 'booking_id')::uuid = b and r_new <> r_old
    and res ->> 'booking_status' = 'pending' and (res ->> 'version')::integer = 1
    and (res ->> 'key_attempt')::integer = 0
    and (res ->> 'round_expires_at')::timestamptz = '2026-12-21 12:45:00+00'
    and bk.status = 'pending' and bk.reason = 'eligible' and bk.round_id = r_new and bk.version = 1
    and bk.start_at = '2026-12-21 10:00:00+00' and bk.updated_at = '2026-12-07 12:45:00+00', res::text);
  perform _r1_meet_tests.assert('T3-G the lapsed round is expired (hold released); the new one is a Meet round',
    (select x.status = 'expired' and x.held_minutes = 0 from screening_v2.interview_rounds x where x.id = r_old)
    and (select x.status = 'invited' and x.channel = 'meet' and x.held_minutes = 65
                and x.expires_at = '2026-12-21 12:45:00+00'
           from screening_v2.interview_rounds x where x.id = r_new));
  perform _r1_meet_tests.assert('T3-G the fresh round carries a live HR-attested consent of its own',
    (select count(*) = 1 and bool_and(x.method = 'hr_attested_ashby' and x.withdrawn_at is null)
       from screening_v2.interview_round_consents x where x.round_id = r_new)
    and (select count(*) = 1 from screening_v2.interview_round_consents x
          where x.round_id = r_old and x.withdrawn_at is null));
  perform _r1_meet_tests.assert('T3-G the re-bind created no call session',
    _r1_meet_tests.sessions_of(r_old) = 0 and _r1_meet_tests.sessions_of(r_new) = 0);
  res := _r1_meet_tests.create_round(280, jsonb_build_object(
    'start_at', '2026-12-21T10:00:00+00:00', 'end_at', '2026-12-21T10:45:00+00:00',
    'updated_at', '2026-11-30T12:00:00+00:00', 'now', '2026-12-07T13:00:00+00:00'));
  perform _r1_meet_tests.assert('T3-G a replay after the re-bind answers exists on the fresh round',
    res ->> 'status' = 'exists' and (res ->> 'round_id')::uuid = r_new and (res ->> 'round_live')::boolean
    and (res ->> 'version')::integer = 1, res::text);

  -- (b) A lapsed round under a booking that still holds an undispatched bot: bot_attached, nothing
  -- written; after S06 deletes the bot at Recall and replaces it, the replay re-binds.
  b := _r1_meet_tests.pending_booking(281);
  res := _r1_meet_tests.set_bot(b, 'attach', _r1_meet_tests.id(30, 2881));
  bj := _r1_meet_tests.booking_json(b);
  res := _r1_meet_tests.create_round(281, jsonb_build_object(
    'start_at', '2026-12-05T10:00:00+00:00', 'end_at', '2026-12-05T10:45:00+00:00',
    'updated_at', '2026-11-30T12:00:00+00:00', 'now', t_lapsed));
  perform _r1_meet_tests.assert('T3-G a lapsed round under a scheduled bot: bot_attached, nothing written',
    res = jsonb_build_object('status', 'bot_attached', 'booking_id', b, 'booking_status', 'bot_scheduled',
                             'version', 0, 'key_attempt', 0)
    and _r1_meet_tests.booking_json(b) = bj, res::text);
  res := _r1_meet_tests.set_bot(b, 'replace', null, t_lapsed);
  res := _r1_meet_tests.create_round(281, jsonb_build_object(
    'start_at', '2026-12-05T10:00:00+00:00', 'end_at', '2026-12-05T10:45:00+00:00',
    'updated_at', '2026-11-30T12:00:00+00:00', 'now', t_lapsed));
  perform _r1_meet_tests.assert('T3-G after the replace the replay re-binds: generation 2, no bot',
    res ->> 'status' = 'created' and (res ->> 'rebound')::boolean and (res ->> 'version')::integer = 2
    and (select x.recall_bot_id is null and x.status = 'pending' and x.start_at = '2026-12-05 10:00:00+00'
           from screening_v2.r1_meet_bookings x where x.id = b), res::text);

  -- (c) A dispatched booking whose round lapsed is never re-bound: exists (round_live false).
  b := _r1_meet_tests.pending_booking(282);
  res := _r1_meet_tests.set_bot(b, 'attach', _r1_meet_tests.id(30, 2882));
  res := screening_v2.r1_meet_transition_booking(b, 'bot_scheduled', 'bot_joining', 'eligible', p_now);
  bj := _r1_meet_tests.booking_json(b);
  res := _r1_meet_tests.create_round(282, jsonb_build_object(
    'start_at', '2026-12-05T10:00:00+00:00', 'end_at', '2026-12-05T10:45:00+00:00',
    'updated_at', '2026-11-30T12:00:00+00:00', 'now', t_lapsed));
  perform _r1_meet_tests.assert('T3-G a dispatched booking with a lapsed round: exists, round_live false',
    res ->> 'status' = 'exists' and not (res ->> 'round_live')::boolean
    and res ->> 'booking_status' = 'bot_joining' and _r1_meet_tests.booking_json(b) = bj, res::text);

  -- (d) Review F6: a replay after the slot started still reads the event's booking.
  b := _r1_meet_tests.pending_booking(283);
  res := _r1_meet_tests.create_round(283, jsonb_build_object('now', '2026-12-02T10:40:00+00:00'));
  perform _r1_meet_tests.assert('T3-G a replay during the slot answers exists, not in_past',
    res ->> 'status' = 'exists' and (res ->> 'booking_id')::uuid = b and (res ->> 'round_live')::boolean,
    res::text);
  perform _r1_meet_tests.candidate(284, false);
  res := _r1_meet_tests.create_round(284);
  b := (res ->> 'booking_id')::uuid;
  bj := _r1_meet_tests.booking_json(b);
  res := _r1_meet_tests.create_round(284, jsonb_build_object('now', '2026-12-02T10:40:00+00:00'));
  perform _r1_meet_tests.assert(
    'T3-G a round-less booking whose slot started: in_past with the booking id, nothing written',
    res = jsonb_build_object('status', 'in_past', 'booking_id', b)
    and _r1_meet_tests.booking_json(b) = bj, res::text);

  -- (e) A failed booking (no-show) whose round lapsed, moved by Ashby to a later slot: revived.
  b := _r1_meet_tests.pending_booking(285);
  select x.round_id into r_old from screening_v2.r1_meet_bookings x where x.id = b;
  res := screening_v2.r1_meet_transition_booking(b, 'pending', 'failed', 'no_show', '2026-12-02 11:20:00+00');
  bj := _r1_meet_tests.booking_json(b);
  res := _r1_meet_tests.create_round(285, jsonb_build_object('now', '2026-12-02T11:30:00+00:00'));
  perform _r1_meet_tests.assert('T3-G a failed booking replayed during its old slot: booking_terminal',
    res = jsonb_build_object('status', 'booking_terminal', 'booking_id', b, 'booking_status', 'failed',
                             'reason', 'no_show')
    and _r1_meet_tests.booking_json(b) = bj, res::text);
  res := _r1_meet_tests.create_round(285, jsonb_build_object(
    'start_at', '2026-12-04T10:00:00+00:00', 'end_at', '2026-12-04T10:45:00+00:00',
    'updated_at', '2026-11-30T08:00:00+00:00', 'now', '2026-12-02T15:00:00+00:00'));
  perform _r1_meet_tests.assert('T3-G a revival with an older Ashby updatedAt: stale_update, nothing written',
    res = jsonb_build_object('status', 'stale_update', 'booking_id', b)
    and _r1_meet_tests.booking_json(b) = bj, res::text);
  res := _r1_meet_tests.create_round(285, jsonb_build_object(
    'start_at', '2026-12-04T10:00:00+00:00', 'end_at', '2026-12-04T10:45:00+00:00',
    'updated_at', '2026-12-02T14:50:00+00:00', 'now', '2026-12-02T15:00:00+00:00'));
  r_new := (res ->> 'round_id')::uuid;
  perform _r1_meet_tests.assert(
    'T3-G a failed booking that Ashby moved to a future slot is revived on a fresh round, generation 1',
    res ->> 'status' = 'created' and (res ->> 'rebound')::boolean and (res ->> 'booking_id')::uuid = b
    and r_new <> r_old and (res ->> 'version')::integer = 1
    and (select x.status = 'pending' and x.reason = 'eligible' and x.round_id = r_new
                and x.start_at = '2026-12-04 10:00:00+00' and x.session_id is null and x.ticket_arms = 0
                and x.ashby_updated_at = '2026-12-02 14:50:00+00'
           from screening_v2.r1_meet_bookings x where x.id = b)
    and (select x.status = 'expired' from screening_v2.interview_rounds x where x.id = r_old), res::text);

  -- (f) A failed booking (the bot could not be created) whose round is still live, moved to a new
  -- slot: revived by re-linking that same round (moved expiry, consent re-attested).
  b := _r1_meet_tests.pending_booking(286);
  select x.round_id into r_old from screening_v2.r1_meet_bookings x where x.id = b;
  select x.id into k_old from screening_v2.interview_round_consents x
   where x.round_id = r_old and x.withdrawn_at is null;
  res := screening_v2.r1_meet_transition_booking(b, 'pending', 'failed', 'bot_create_failed', p_now);
  bj := _r1_meet_tests.booking_json(b);
  res := _r1_meet_tests.create_round(286, jsonb_build_object('now', '2026-12-01T05:00:00+00:00'));
  perform _r1_meet_tests.assert('T3-G a failed booking replayed with its unchanged future slot: booking_terminal',
    res ->> 'status' = 'booking_terminal' and _r1_meet_tests.booking_json(b) = bj, res::text);
  res := _r1_meet_tests.create_round(286, jsonb_build_object(
    'start_at', '2026-12-03T10:00:00+00:00', 'end_at', '2026-12-03T10:45:00+00:00',
    'updated_at', '2026-12-01T04:30:00+00:00', 'now', '2026-12-01T05:00:00+00:00'));
  perform _r1_meet_tests.assert(
    'T3-G a failed booking whose round is live is revived by re-linking that round',
    res ->> 'status' = 'relinked' and (res ->> 'rebound')::boolean and (res ->> 'round_id')::uuid = r_old
    and (res ->> 'version')::integer = 1
    and (res ->> 'round_expires_at')::timestamptz = '2026-12-03 12:45:00+00'
    and (select x.proof ->> 'decision' = 'superseded' from screening_v2.interview_round_consents x
          where x.id = k_old)
    and (select count(*) = 1 from screening_v2.interview_round_consents x
          where x.round_id = r_old and x.withdrawn_at is null), res::text);

  -- (g) A failed booking that still holds its bot (owed release): bot_attached until S06 releases it.
  b := _r1_meet_tests.pending_booking(287);
  res := _r1_meet_tests.set_bot(b, 'attach', _r1_meet_tests.id(30, 2887));
  res := screening_v2.r1_meet_transition_booking(b, 'bot_scheduled', 'failed', 'bot_fatal', p_now);
  res := _r1_meet_tests.create_round(287, jsonb_build_object(
    'start_at', '2026-12-03T10:00:00+00:00', 'end_at', '2026-12-03T10:45:00+00:00',
    'updated_at', '2026-12-01T04:30:00+00:00', 'now', '2026-12-01T05:00:00+00:00'));
  perform _r1_meet_tests.assert('T3-G a moved failed booking that still holds a bot: bot_attached',
    res = jsonb_build_object('status', 'bot_attached', 'booking_id', b, 'booking_status', 'failed',
                             'version', 0, 'key_attempt', 0), res::text);
  res := _r1_meet_tests.set_bot(b, 'release', null, '2026-12-01 05:00:00+00');
  res := _r1_meet_tests.create_round(287, jsonb_build_object(
    'start_at', '2026-12-03T10:00:00+00:00', 'end_at', '2026-12-03T10:45:00+00:00',
    'updated_at', '2026-12-01T04:30:00+00:00', 'now', '2026-12-01T05:00:00+00:00'));
  perform _r1_meet_tests.assert('T3-G once released, the moved failed booking is revived',
    res ->> 'status' = 'relinked' and (res ->> 'rebound')::boolean and (res ->> 'version')::integer = 1,
    res::text);

  -- (h) completed, cancelled and drained bookings stay history, even on a moved slot.
  b := _r1_meet_tests.pending_booking(288);
  res := screening_v2.r1_meet_cancel_booking(b, 'dex_absent', p_now);
  bj := _r1_meet_tests.booking_json(b);
  res := _r1_meet_tests.create_round(288, jsonb_build_object(
    'start_at', '2026-12-03T10:00:00+00:00', 'end_at', '2026-12-03T10:45:00+00:00',
    'updated_at', '2026-12-01T04:30:00+00:00', 'now', '2026-12-01T05:00:00+00:00'));
  perform _r1_meet_tests.assert('T3-G a cancelled booking on a moved slot: booking_terminal, nothing written',
    res = jsonb_build_object('status', 'booking_terminal', 'booking_id', b, 'booking_status', 'cancelled',
                             'reason', 'dex_absent')
    and _r1_meet_tests.booking_json(b) = bj, res::text);
  b := _r1_meet_tests.pending_booking(289);
  res := screening_v2.r1_meet_transition_booking(b, 'pending', 'drained', 'flag_off', p_now);
  res := _r1_meet_tests.create_round(289, jsonb_build_object(
    'start_at', '2026-12-03T10:00:00+00:00', 'end_at', '2026-12-03T10:45:00+00:00',
    'updated_at', '2026-12-01T04:30:00+00:00', 'now', '2026-12-01T05:00:00+00:00'));
  perform _r1_meet_tests.assert('T3-G a drained booking on a moved slot: booking_terminal',
    res ->> 'status' = 'booking_terminal' and res ->> 'booking_status' = 'drained', res::text);

  -- (i) A pending booking whose Meet round HR cancelled in our app is never re-bound (that would
  -- undo HR's cancel): exists with round_live false; S06 cancels the booking (T3-H).
  b := _r1_meet_tests.pending_booking(290);
  select x.round_id into r_old from screening_v2.r1_meet_bookings x where x.id = b;
  res := screening_v2.r1_transition_round(r_old, 'cancel',
    (select x.version from screening_v2.interview_rounds x where x.id = r_old), null, null, p_now);
  bj := _r1_meet_tests.booking_json(b);
  res := _r1_meet_tests.create_round(290, jsonb_build_object(
    'start_at', '2026-12-03T10:00:00+00:00', 'end_at', '2026-12-03T10:45:00+00:00',
    'updated_at', '2026-12-01T04:30:00+00:00', 'now', '2026-12-01T05:00:00+00:00'));
  perform _r1_meet_tests.assert('T3-G a booking on a round HR cancelled: exists, round_live false, nothing written',
    res ->> 'status' = 'exists' and not (res ->> 'round_live')::boolean
    and _r1_meet_tests.booking_json(b) = bj, res::text);

  -- (j) A lapsed BROWSER round is never expired by the Meet RPC: blocked/round_active.
  perform _r1_meet_tests.candidate(291);
  res := screening_v2.r1_send_round(_r1_meet_tests.id(10, 291), _r1_meet_tests.id(2, 1),
                                    _r1_meet_tests.id(1, 1), _r1_meet_tests.digest('link-291'), 'new',
                                    '2026-12-01 05:00:00+00', p_now);
  r_old := (res ->> 'id')::uuid;
  st_before := _r1_meet_tests.round_state(r_old);
  res := _r1_meet_tests.create_round(291, jsonb_build_object('now', '2026-12-01T06:00:00+00:00'));
  perform _r1_meet_tests.assert('T3-G a lapsed browser round is left alone: blocked/round_active',
    res ->> 'status' = 'blocked' and res ->> 'reason' = 'round_active'
    and (select x.status = 'invited' and x.channel = 'browser' from screening_v2.interview_rounds x
          where x.id = r_old), res::text);

  -- (k) The generation cap also bounds a revival.
  b := _r1_meet_tests.pending_booking(292);
  res := screening_v2.r1_meet_transition_booking(b, 'pending', 'failed', 'bot_create_failed', p_now);
  update screening_v2.r1_meet_bookings set version = 50 where id = b;
  bj := _r1_meet_tests.booking_json(b);
  res := _r1_meet_tests.create_round(292, jsonb_build_object(
    'start_at', '2026-12-03T10:00:00+00:00', 'end_at', '2026-12-03T10:45:00+00:00',
    'updated_at', '2026-12-01T04:30:00+00:00', 'now', '2026-12-01T05:00:00+00:00'));
  perform _r1_meet_tests.assert('T3-G a revival at generation 50: version_exhausted, nothing written',
    res = jsonb_build_object('status', 'version_exhausted', 'booking_id', b, 'version', 50)
    and _r1_meet_tests.booking_json(b) = bj, res::text);

  -- (l) A revival resets the rotated key and the spent arm budget. The first create hit an error
  -- Recall caches (key_attempt 1), the bot was armed 5 times (the whole budget of a generation) and
  -- then failed fatally; S06 released it and Ashby moved the event. Without the reset the revived
  -- booking would answer ticket_arms_exhausted and Dex could never bridge into the new slot.
  b := _r1_meet_tests.pending_booking(274);
  select x.round_id into r_old from screening_v2.r1_meet_bookings x where x.id = b;
  res := _r1_meet_tests.set_bot(b, 'rotate_key');
  res := _r1_meet_tests.set_bot(b, 'attach', bot_l1);
  for i in 1..5 loop
    res := screening_v2.r1_meet_arm_ticket(b, _r1_meet_tests.digest('t3g-274-' || i::text),
                                           '2026-12-02 10:15:00+00', '2026-12-02 11:45:00+00', p_now);
  end loop;
  res := screening_v2.r1_meet_arm_ticket(b, _r1_meet_tests.digest('t3g-274-6'),
                                         '2026-12-02 10:15:00+00', '2026-12-02 11:45:00+00', p_now);
  perform _r1_meet_tests.assert('T3-G fixture: a rotated key, then the bot spent its whole arm budget',
    res ->> 'status' = 'ticket_arms_exhausted'
    and (select x.status = 'bot_scheduled' and x.key_attempt = 1 and x.ticket_arms = 5 and x.version = 0
           from screening_v2.r1_meet_bookings x where x.id = b), res::text);
  res := screening_v2.r1_meet_transition_booking(b, 'bot_scheduled', 'failed', 'bot_fatal', p_now);
  res := _r1_meet_tests.set_bot(b, 'release', null, '2026-12-01 04:30:00+00');
  res := _r1_meet_tests.create_round(274, jsonb_build_object(
    'start_at', '2026-12-03T10:00:00+00:00', 'end_at', '2026-12-03T10:45:00+00:00',
    'updated_at', '2026-12-01T04:30:00+00:00', 'now', '2026-12-01T05:00:00+00:00'));
  select * into bk from screening_v2.r1_meet_bookings x where x.id = b;
  perform _r1_meet_tests.assert(
    'T3-G a revival resets the rotated key and the spent arm budget: key attempt 0, no arms, generation 1',
    res ->> 'status' = 'relinked' and (res ->> 'rebound')::boolean and (res ->> 'round_id')::uuid = r_old
    and (res ->> 'version')::integer = 1 and (res ->> 'key_attempt')::integer = 0
    and bk.status = 'pending' and bk.reason = 'eligible' and bk.version = 1 and bk.key_attempt = 0
    and bk.ticket_arms = 0 and bk.ticket_digest is null and bk.recall_bot_id is null, res::text);
  res := screening_v2.r1_meet_set_bot(b, 'attach', 1, 0, bot_l2, '2026-12-01 05:10:00+00');
  perform _r1_meet_tests.assert('T3-G fixture: the revived generation attaches its own bot',
    res ->> 'status' = 'ok' and res ->> 'booking_status' = 'bot_scheduled', res::text);
  res := screening_v2.r1_meet_arm_ticket(b, _r1_meet_tests.digest('t3g-274-next'),
                                         '2026-12-03 09:45:00+00', '2026-12-03 11:15:00+00',
                                         '2026-12-01 05:10:00+00');
  perform _r1_meet_tests.assert('T3-G the revived booking arms the bridge ticket for the new slot',
    res ->> 'status' = 'ok' and (res ->> 'ticket_arms')::integer = 1, res::text);

  -- (m) A revival clears the claimed ticket and the bound session of the old attempt. The bot
  -- joined, the bridge claimed its ticket and bound a session; the call then ended without a settled
  -- attempt (the worker crashed), S06 failed the booking and released the bot, and Ashby moved the
  -- event. The round is still live, so it is re-linked.
  b := _r1_meet_tests.pending_booking(275);
  select x.round_id into r_old from screening_v2.r1_meet_bookings x where x.id = b;
  res := _r1_meet_tests.set_bot(b, 'attach', bot_m);
  res := screening_v2.r1_meet_arm_ticket(b, _r1_meet_tests.digest('t3g-275'),
                                         '2026-12-02 10:15:00+00', '2026-12-02 11:45:00+00', p_now);
  res := screening_v2.r1_meet_claim_ticket(_r1_meet_tests.digest('t3g-275'), '2026-12-02 10:31:00+00');
  s := _r1_meet_tests.session(275, r_old);
  res := screening_v2.r1_meet_bind_session(b, s, '2026-12-02 10:32:00+00');
  update screening_v2.call_sessions set status = 'failed', terminal_reason = 'worker_crash' where id = s;
  res := screening_v2.r1_meet_transition_booking(b, 'in_call', 'failed', 'bot_fatal', '2026-12-02 10:50:00+00');
  res := _r1_meet_tests.set_bot(b, 'release', null, '2026-12-02 10:55:00+00');
  select * into bk from screening_v2.r1_meet_bookings x where x.id = b;
  perform _r1_meet_tests.assert('T3-G fixture: a failed booking with a claimed ticket and a bound session',
    bk.status = 'failed' and bk.reason = 'bot_fatal' and bk.recall_bot_id is null and bk.session_id = s
    and bk.ticket_digest = _r1_meet_tests.digest('t3g-275')
    and bk.ticket_claimed_at = '2026-12-02 10:31:00+00' and bk.ticket_arms = 1 and bk.version = 0,
    res::text);
  res := _r1_meet_tests.create_round(275, jsonb_build_object(
    'start_at', '2026-12-04T10:00:00+00:00', 'end_at', '2026-12-04T10:45:00+00:00',
    'updated_at', '2026-12-02T11:40:00+00:00', 'now', '2026-12-02T12:00:00+00:00'));
  select * into bk from screening_v2.r1_meet_bookings x where x.id = b;
  perform _r1_meet_tests.assert(
    'T3-G a revival clears the claimed ticket and the bound session of the old attempt',
    res ->> 'status' = 'relinked' and (res ->> 'rebound')::boolean and (res ->> 'round_id')::uuid = r_old
    and (res ->> 'version')::integer = 1 and (res ->> 'key_attempt')::integer = 0
    and bk.status = 'pending' and bk.round_id = r_old and bk.version = 1 and bk.session_id is null
    and bk.ticket_digest is null and bk.ticket_not_before is null and bk.ticket_expires_at is null
    and bk.ticket_claimed_at is null and bk.ticket_arms = 0 and bk.start_at = '2026-12-04 10:00:00+00',
    res::text);
  res := screening_v2.r1_meet_claim_ticket(_r1_meet_tests.digest('t3g-275'), '2026-12-04 10:31:00+00');
  perform _r1_meet_tests.assert(
    'T3-G after the revival the old ticket is unknown; the old session itself is kept',
    res = jsonb_build_object('status', 'ticket_unknown')
    and (select x.status = 'failed' from screening_v2.call_sessions x where x.id = s)
    and _r1_meet_tests.sessions_of(r_old) = 1, res::text);

  -- (n) Step 8a never expires a lapsed round that another event's live booking holds. Event 276's
  -- bot is joining on round r_old, which lapsed at 2026-12-02 13:15; a second Dex event (277) for
  -- the same application must not expire that round under it: blocked/round_active.
  b := _r1_meet_tests.pending_booking(276);
  select x.round_id into r_old from screening_v2.r1_meet_bookings x where x.id = b;
  res := _r1_meet_tests.set_bot(b, 'attach', bot_n);
  res := screening_v2.r1_meet_transition_booking(b, 'bot_scheduled', 'bot_joining', 'eligible', p_now);
  bj := _r1_meet_tests.booking_json(b);
  st_before := _r1_meet_tests.round_state(r_old);
  res := _r1_meet_tests.create_round(277, jsonb_build_object(
    'application_id', _r1_meet_tests.id(22, 276)::text, 'now', t_lapsed,
    'start_at', '2026-12-04T10:00:00+00:00', 'end_at', '2026-12-04T10:45:00+00:00'));
  perform _r1_meet_tests.assert(
    'T3-G step 8a leaves a lapsed round held by the live booking of another event: blocked/round_active',
    res ->> 'status' = 'blocked' and res ->> 'reason' = 'round_active'
    and _r1_meet_tests.round_state(r_old) = st_before and _r1_meet_tests.booking_json(b) = bj
    and (select x.candidate_id = _r1_meet_tests.id(10, 276) and x.round_id is null
                and x.ashby_interview_event_id = _r1_meet_tests.id(20, 277)
           from screening_v2.r1_meet_bookings x where x.id = (res ->> 'booking_id')::uuid), res::text);

  -- (o) In production the R1 tick's sweep usually expires a lapsed round before S06 retries at
  -- retry_after, so the create replay finds the round `expired`, not merely past its expiry. It
  -- re-binds just the same (and resets the rotated key). The real sweep runs here; it expires every
  -- lapsed fixture round, so this case is the last one of T3-G.
  b := _r1_meet_tests.pending_booking(278);
  select x.round_id into r_old from screening_v2.r1_meet_bookings x where x.id = b;
  res := _r1_meet_tests.set_bot(b, 'rotate_key');
  res := _r1_meet_tests.reschedule(b, jsonb_build_object(
    'start_at', '2026-12-21T10:00:00+00:00', 'end_at', '2026-12-21T10:45:00+00:00'));
  perform _r1_meet_tests.assert('T3-G fixture: a rotated key, then a move 20 days out answers slot_too_far',
    res ->> 'status' = 'slot_too_far'
    and (select x.key_attempt = 1 and x.version = 0 from screening_v2.r1_meet_bookings x where x.id = b),
    res::text);
  res := screening_v2.r1_meet_transition_booking(b, 'pending', 'blocked', 'slot_too_far', p_now);
  for i in 1..20 loop
    n_swept := screening_v2.r1_sweep_expired_rounds('2026-12-07 12:00:00+00', 1000);
    exit when n_swept = 0
           or (select x.status = 'expired' from screening_v2.interview_rounds x where x.id = r_old);
  end loop;
  rj := (select to_jsonb(x) from screening_v2.interview_rounds x where x.id = r_old);
  perform _r1_meet_tests.assert('T3-G fixture: the sweep expired the lapsed round before the retry (hold released)',
    rj ->> 'status' = 'expired' and (rj ->> 'held_minutes')::numeric = 0, rj::text);
  res := _r1_meet_tests.create_round(278, jsonb_build_object(
    'start_at', '2026-12-21T10:00:00+00:00', 'end_at', '2026-12-21T10:45:00+00:00',
    'updated_at', '2026-11-30T12:00:00+00:00', 'now', '2026-12-07T12:45:00+00:00'));
  r_new := (res ->> 'round_id')::uuid;
  select * into bk from screening_v2.r1_meet_bookings x where x.id = b;
  perform _r1_meet_tests.assert(
    'T3-G a round the sweep already expired is re-bound by the create replay: a fresh round, generation 1',
    res ->> 'status' = 'created' and (res ->> 'rebound')::boolean and (res ->> 'booking_id')::uuid = b
    and r_new <> r_old and (res ->> 'version')::integer = 1 and (res ->> 'key_attempt')::integer = 0
    and bk.status = 'pending' and bk.reason = 'eligible' and bk.round_id = r_new
    and bk.version = 1 and bk.key_attempt = 0
    and (select to_jsonb(x) from screening_v2.interview_rounds x where x.id = r_old) = rj
    and (select x.status = 'invited' and x.channel = 'meet' and x.held_minutes = 65
           from screening_v2.interview_rounds x where x.id = r_new)
    and _r1_meet_tests.sessions_of(r_new) = 0, res::text);
end;
$$;

-- T3-H. The round side of a Meet booking (review F3): the link of a Meet round is never reissued,
-- and HR's cancel of a Meet round in our app queues one r1-meet round_cancelled job per live
-- booking, so S06 cancels the booking and removes its bot. Fixture numbers 293-299.
do $$
declare
  p_now constant timestamptz := '2026-12-01 04:00:00+00';
  b uuid;
  b2 uuid;
  rr screening_v2.interview_rounds%rowtype;
  res jsonb;
  browser uuid;
  n_jobs bigint;
begin
  b := _r1_meet_tests.pending_booking(293);
  select * into rr from screening_v2.interview_rounds x
   where x.id = (select y.round_id from screening_v2.r1_meet_bookings y where y.id = b);
  perform _r1_meet_tests.raises('T3-H reissuing the link of a Meet round raises P0001',
    format('select screening_v2.r1_transition_round(%L::uuid, %L, %s, %L, %L::timestamptz, %L::timestamptz)',
           rr.id, 'reissue', rr.version, _r1_meet_tests.digest('reissue-293'), '2026-12-03 04:00:00+00', p_now),
    'P0001');
  perform _r1_meet_tests.raises('T3-H a direct write of a Meet round''s link digest raises P0001',
    format('update screening_v2.interview_rounds set link_token_digest = %L where id = %L::uuid',
           _r1_meet_tests.digest('reissue-293b'), rr.id),
    'P0001');
  perform _r1_meet_tests.assert('T3-H the refused reissues left the Meet round as it was',
    (select to_jsonb(x) = to_jsonb(rr) from screening_v2.interview_rounds x where x.id = rr.id));
  perform _r1_meet_tests.assert('T3-H the reissue guard and the cancel trigger exist and are enabled',
    exists (select 1 from pg_trigger t
             where t.tgrelid = 'screening_v2.interview_rounds'::regclass
               and t.tgname = 'trg_interview_rounds_meet_link_locked' and t.tgenabled = 'O')
    and exists (select 1 from pg_trigger t
                 where t.tgrelid = 'screening_v2.interview_rounds'::regclass
                   and t.tgname = 'enqueue_r1_meet_round_cancelled' and t.tgenabled = 'O'));
  perform _r1_meet_tests.assert(
    'T3-H the two round trigger functions pin search_path and are not executable by browser roles',
    (select bool_and(x.proconfig is not null
                     and not has_function_privilege('anon', x.oid, 'execute')
                     and not has_function_privilege('authenticated', x.oid, 'execute')
                     and not has_function_privilege('public', x.oid, 'execute'))
       from pg_proc x
      where x.pronamespace = 'screening_v2'::regnamespace
        and x.proname in ('reject_meet_round_link_reissue', 'enqueue_r1_meet_round_cancelled'))
    and (select count(*) = 2 from pg_proc x
          where x.pronamespace = 'screening_v2'::regnamespace
            and x.proname in ('reject_meet_round_link_reissue', 'enqueue_r1_meet_round_cancelled')));

  -- A browser round still reissues exactly as before.
  perform _r1_meet_tests.candidate(294);
  res := screening_v2.r1_send_round(_r1_meet_tests.id(10, 294), _r1_meet_tests.id(2, 1),
                                    _r1_meet_tests.id(1, 1), _r1_meet_tests.digest('link-294'), 'new',
                                    '2026-12-04 04:00:00+00', p_now);
  browser := (res ->> 'id')::uuid;
  res := screening_v2.r1_transition_round(browser, 'reissue', 1, _r1_meet_tests.digest('link-294b'),
                                          '2026-12-05 04:00:00+00', p_now);
  perform _r1_meet_tests.assert('T3-H a browser round is reissued unchanged',
    res ->> 'status' = 'ok'
    and (select x.link_token_digest = _r1_meet_tests.digest('link-294b')
                and x.expires_at = '2026-12-05 04:00:00+00'
           from screening_v2.interview_rounds x where x.id = browser), res::text);

  -- HR cancels the Meet round: one round_cancelled job for its live booking; the booking itself is
  -- left for S06 (its RPC writes the cancel), and the cancel itself is unchanged.
  res := screening_v2.r1_transition_round(rr.id, 'cancel', rr.version, null, null, p_now);
  perform _r1_meet_tests.assert('T3-H HR cancels the Meet round: ok',
    res ->> 'status' = 'ok'
    and (select x.status = 'cancelled' from screening_v2.interview_rounds x where x.id = rr.id), res::text);
  perform _r1_meet_tests.assert('T3-H exactly one r1-meet round_cancelled job, ids only',
    (select count(*) = 1 from screening_v2.job_queue j where j.payload ->> 'round_id' = rr.id::text)
    and (select j.name = 'r1-meet' and j.status = 'pending'
                and j.dedup_key = 'r1-meet:round-cancelled:' || b::text
                and j.payload = jsonb_build_object('kind', 'round_cancelled', 'booking_id', b,
                                                   'round_id', rr.id)
           from screening_v2.job_queue j where j.payload ->> 'round_id' = rr.id::text));
  perform _r1_meet_tests.assert('T3-H the booking is untouched by the round cancel',
    (select x.status = 'pending' and x.round_id = rr.id from screening_v2.r1_meet_bookings x where x.id = b));
  res := screening_v2.r1_meet_cancel_booking(b, 'round_cancelled', p_now);
  perform _r1_meet_tests.assert('T3-H S06 then cancels the booking: ok',
    res ->> 'status' = 'ok', res::text);

  -- No job when nothing is live on the round, for a browser round, or for an expiry.
  n_jobs := (select count(*) from screening_v2.job_queue j where j.name = 'r1-meet');
  b2 := _r1_meet_tests.pending_booking(295);
  select * into rr from screening_v2.interview_rounds x
   where x.id = (select y.round_id from screening_v2.r1_meet_bookings y where y.id = b2);
  res := screening_v2.r1_meet_cancel_booking(b2, 'cancelled', p_now);
  res := screening_v2.r1_transition_round(rr.id, 'cancel', rr.version, null, null, p_now);
  perform _r1_meet_tests.assert('T3-H fixture: the Meet round of a cancelled booking is cancelled',
    res ->> 'status' = 'ok', res::text);
  res := screening_v2.r1_transition_round(browser, 'cancel', 2, null, null, p_now);
  perform _r1_meet_tests.assert('T3-H fixture: the browser round is cancelled', res ->> 'status' = 'ok', res::text);
  b2 := _r1_meet_tests.pending_booking(296);
  select * into rr from screening_v2.interview_rounds x
   where x.id = (select y.round_id from screening_v2.r1_meet_bookings y where y.id = b2);
  res := screening_v2.r1_transition_round(rr.id, 'expire', rr.version, null, null, '2026-12-02 14:00:00+00');
  perform _r1_meet_tests.assert('T3-H fixture: a lapsed Meet round with a live booking is expired',
    res ->> 'status' = 'ok', res::text);
  perform _r1_meet_tests.assert(
    'T3-H no job for a round with no live booking, a browser round, or an expiry',
    (select count(*) from screening_v2.job_queue j where j.name = 'r1-meet') = n_jobs);
end;
$$;

-- =============================================================================================
-- T4. The bridge ticket, durable receipts with the outbox, the receipt prune, and the behavioural
--     privilege proof of all eleven RPCs.
-- =============================================================================================
-- Fixture numbers 300-399; Recall bots id(30, 3000 + n) on RPC attaches. Ticket digests are
-- computed at run time (_r1_meet_tests.digest), never written. A booking from the RPCs has the
-- default slot 2026-12-02 10:30-11:15 UTC, so a ticket window may run from 10:15 (start - 15 min)
-- to 11:45 (end + 30 min); its Meet round lives until 13:15. Receipts recorded here are received on
-- 2026-12-01, like every other receipt of the run, except the T4-C prune fixtures (received in
-- 2026-08 to 2026-10), so the prune calls (p_now 2026-11-01) can only ever reach those.

-- A bot_scheduled booking for event n through the RPCs: create, then attach bot id(30, 3000 + n).
create function _r1_meet_tests.scheduled_booking(p_n integer) returns uuid
language plpgsql as $$
declare
  v_booking uuid;
  v_res jsonb;
begin
  v_booking := _r1_meet_tests.pending_booking(p_n);
  v_res := _r1_meet_tests.set_bot(v_booking, 'attach', _r1_meet_tests.id(30, 3000 + p_n));
  if v_res ->> 'status' is distinct from 'ok' then
    raise exception 'R1 MEET FAIL: fixture booking % took no bot (%)', p_n, v_res::text;
  end if;
  return v_booking;
end;
$$;

-- r1_meet_arm_ticket for the digest of p_tag: by default armed at 10:00 with the widest window the
-- default slot allows (10:15-11:45).
create function _r1_meet_tests.arm(p_booking uuid, p_tag text,
                                   p_now timestamptz default '2026-12-02 10:00:00+00',
                                   p_not_before timestamptz default '2026-12-02 10:15:00+00',
                                   p_expires_at timestamptz default '2026-12-02 11:45:00+00')
returns jsonb language sql as $$
  select screening_v2.r1_meet_arm_ticket(p_booking, _r1_meet_tests.digest(p_tag), p_not_before,
                                         p_expires_at, p_now)
$$;

-- r1_meet_claim_ticket for the digest of p_tag, by default at 10:31 (inside the default window).
create function _r1_meet_tests.claim(p_tag text, p_now timestamptz default '2026-12-02 10:31:00+00')
returns jsonb language sql as $$
  select screening_v2.r1_meet_claim_ticket(_r1_meet_tests.digest(p_tag), p_now)
$$;

-- The r1-meet jobs of one receipt (all of them, or only the live ones: pending, active, delayed).
create function _r1_meet_tests.receipt_jobs(p_receipt uuid, p_live boolean default false)
returns integer language sql stable as $$
  select count(*)::integer from screening_v2.job_queue j
   where j.dedup_key = 'r1-meet:receipt:' || p_receipt::text
     and (not p_live or j.status in ('pending', 'active', 'delayed'))
$$;

-- Runs a statement AS p_role that MUST complete, and returns its jsonb value. The role switch and
-- every write of the statement are local to the inner block: an accepted statement raises a
-- sentinel that rolls that subtransaction back (restoring the role) after its value is kept.
create function _r1_meet_tests.runs_as(p_role text, p_label text, p_sql text)
returns jsonb language plpgsql as $$
declare
  v_res jsonb;
  v_before text := current_user;
  v_switched boolean := false;
  v_done boolean := false;
  v_state text;
  v_msg text;
begin
  begin
    perform set_config('role', p_role, true);
    v_switched := current_user = p_role;
    execute p_sql into v_res;
    v_done := true;
    raise exception 'r1 meet runs_as sentinel' using errcode = 'P0001';
  exception when others then
    get stacked diagnostics v_state = returned_sqlstate, v_msg = message_text;
  end;
  if not v_switched then
    raise exception 'R1 MEET FAIL: % (could not switch to role %: %)', p_label, p_role, v_msg;
  end if;
  perform _r1_meet_tests.assert(p_label || ' runs as ' || p_role,
    v_done and v_res is not null and current_user = v_before,
    coalesce(v_state, 'null') || ': ' || coalesce(v_msg, 'null'));
  return v_res;
end;
$$;

-- T4-A. The bridge ticket: armable states, the window inside the slot, single use under the row
-- lock, replay, expiry, a re-arm for page recovery, the spent digest, the arm budget, and no call
-- session from any arm or claim.
do $$
declare
  t_arm constant timestamptz := '2026-12-02 10:00:00+00';
  nb constant timestamptz := '2026-12-02 10:15:00+00';
  ex constant timestamptz := '2026-12-02 11:45:00+00';
  n_sessions bigint := (select count(*) from screening_v2.call_sessions);
  b uuid;
  b2 uuid;
  b3 uuid;
  r uuid;
  c uuid;
  rr screening_v2.interview_rounds%rowtype;
  res jsonb;
  bj jsonb;
  bk screening_v2.r1_meet_bookings%rowtype;
begin
  -- A pending booking holds no bot yet, so no ticket.
  b := _r1_meet_tests.pending_booking(300);
  bj := _r1_meet_tests.booking_json(b);
  res := _r1_meet_tests.arm(b, 'ticket-300');
  perform _r1_meet_tests.assert('T4-A arm on a pending booking: not_armable, nothing written',
    res = jsonb_build_object('status', 'not_armable', 'booking_id', b, 'booking_status', 'pending')
    and _r1_meet_tests.booking_json(b) = bj, res::text);

  -- Armed on a bot_scheduled booking, at both window bounds exactly: the status does not move.
  b := _r1_meet_tests.scheduled_booking(301);
  select x.round_id, x.candidate_id into r, c from screening_v2.r1_meet_bookings x where x.id = b;
  res := _r1_meet_tests.arm(b, 'ticket-301');
  select * into bk from screening_v2.r1_meet_bookings x where x.id = b;
  perform _r1_meet_tests.assert(
    'T4-A arm on a bot_scheduled booking with the widest window (start - 15 min .. end + 30 min): ok, status unchanged',
    res ->> 'status' = 'ok' and res ->> 'booking_id' = b::text
    and (res ->> 'not_before')::timestamptz = nb and (res ->> 'expires_at')::timestamptz = ex
    and (res ->> 'ticket_arms')::integer = 1
    and (select array_agg(k order by k) from jsonb_object_keys(res) k)
        = array['booking_id', 'expires_at', 'not_before', 'status', 'ticket_arms']
    and bk.status = 'bot_scheduled' and bk.reason = 'eligible'
    and bk.ticket_digest = _r1_meet_tests.digest('ticket-301')
    and bk.ticket_not_before = nb and bk.ticket_expires_at = ex and bk.ticket_claimed_at is null
    and bk.ticket_arms = 1 and bk.updated_at = t_arm, res::text);

  -- Every window bound is enforced; a refused window writes nothing.
  bj := _r1_meet_tests.booking_json(b);
  res := _r1_meet_tests.arm(b, 'ticket-301w', t_arm, nb - interval '1 second', ex);
  perform _r1_meet_tests.assert('T4-A a window opening before start - 15 min: invalid_window',
    res = jsonb_build_object('status', 'invalid_window', 'booking_id', b), res::text);
  res := _r1_meet_tests.arm(b, 'ticket-301w', t_arm, nb, ex + interval '1 second');
  perform _r1_meet_tests.assert('T4-A a window closing after end + 30 min: invalid_window',
    res = jsonb_build_object('status', 'invalid_window', 'booking_id', b), res::text);
  res := _r1_meet_tests.arm(b, 'ticket-301w', t_arm, '2026-12-02 11:00:00+00', '2026-12-02 11:00:00+00');
  perform _r1_meet_tests.assert('T4-A an empty window (not_before = expires_at): invalid_window',
    res = jsonb_build_object('status', 'invalid_window'), res::text);
  res := _r1_meet_tests.arm(b, 'ticket-301w', '2026-12-02 11:00:00+00', nb, '2026-12-02 11:00:00+00');
  perform _r1_meet_tests.assert('T4-A a window already closed (expires_at = p_now): invalid_window',
    res = jsonb_build_object('status', 'invalid_window'), res::text);
  res := _r1_meet_tests.arm(b, 'ticket-301w', t_arm, null, ex);
  perform _r1_meet_tests.assert('T4-A no not_before: invalid_window',
    res = jsonb_build_object('status', 'invalid_window'), res::text);
  res := _r1_meet_tests.arm(b, 'ticket-301w', t_arm, nb, null);
  perform _r1_meet_tests.assert('T4-A no expires_at: invalid_window',
    res = jsonb_build_object('status', 'invalid_window'), res::text);
  perform _r1_meet_tests.assert('T4-A the refused windows wrote nothing',
    _r1_meet_tests.booking_json(b) = bj);

  -- Single use: too early, then once inside the window, then never again.
  res := _r1_meet_tests.claim('ticket-301', nb - interval '1 second');
  perform _r1_meet_tests.assert('T4-A a claim before not_before: ticket_not_yet_valid, nothing written',
    res = jsonb_build_object('status', 'ticket_not_yet_valid', 'booking_id', b)
    and _r1_meet_tests.booking_json(b) = bj, res::text);
  res := _r1_meet_tests.claim('ticket-301', '2026-12-02 10:31:00+00');
  select * into bk from screening_v2.r1_meet_bookings x where x.id = b;
  perform _r1_meet_tests.assert(
    'T4-A a claim inside the window: ok with the booking, round, candidate, profile, event, session and slot binding',
    res - 'start_at' - 'end_at' = jsonb_build_object(
      'status', 'ok', 'booking_id', b, 'round_id', r, 'candidate_id', c,
      'objective_profile', 'r1_dex_sales', 'ashby_interview_event_id', _r1_meet_tests.id(20, 301),
      'session_id', null::uuid)
    and (res ->> 'start_at')::timestamptz = '2026-12-02 10:30:00+00'
    and (res ->> 'end_at')::timestamptz = '2026-12-02 11:15:00+00', res::text);
  perform _r1_meet_tests.assert('T4-A the claim moved the booking to in_call and spent the ticket',
    bk.status = 'in_call' and bk.reason = 'eligible'
    and bk.ticket_claimed_at = '2026-12-02 10:31:00+00' and bk.updated_at = '2026-12-02 10:31:00+00'
    and bk.ticket_digest = _r1_meet_tests.digest('ticket-301') and bk.ticket_arms = 1
    and bk.recall_bot_id = _r1_meet_tests.id(30, 3301), to_jsonb(bk)::text);
  bj := _r1_meet_tests.booking_json(b);
  res := _r1_meet_tests.claim('ticket-301', '2026-12-02 10:32:00+00');
  perform _r1_meet_tests.assert(
    'T4-A a second claim of the same ticket: ticket_already_claimed with the booking id, nothing written',
    res = jsonb_build_object('status', 'ticket_already_claimed', 'booking_id', b)
    and _r1_meet_tests.booking_json(b) = bj, res::text);
  res := _r1_meet_tests.claim('ticket-301', '2026-12-02 12:00:00+00');
  perform _r1_meet_tests.assert('T4-A a replay after the window closed: still ticket_already_claimed',
    res = jsonb_build_object('status', 'ticket_already_claimed', 'booking_id', b), res::text);

  -- Page recovery: a re-arm in in_call is a new single-use ticket; the old digest is gone.
  res := _r1_meet_tests.arm(b, 'ticket-301b', '2026-12-02 10:40:00+00');
  select * into bk from screening_v2.r1_meet_bookings x where x.id = b;
  perform _r1_meet_tests.assert('T4-A a re-arm in in_call: ok, a fresh unclaimed ticket, still in_call',
    res ->> 'status' = 'ok' and (res ->> 'ticket_arms')::integer = 2
    and bk.status = 'in_call' and bk.ticket_digest = _r1_meet_tests.digest('ticket-301b')
    and bk.ticket_claimed_at is null and bk.ticket_arms = 2, res::text);
  res := _r1_meet_tests.claim('ticket-301', '2026-12-02 10:41:00+00');
  perform _r1_meet_tests.assert('T4-A the replaced ticket no longer exists: ticket_unknown',
    res = jsonb_build_object('status', 'ticket_unknown'), res::text);
  res := _r1_meet_tests.claim('ticket-301b', '2026-12-02 10:41:00+00');
  perform _r1_meet_tests.assert('T4-A the re-armed ticket claims once: ok, in_call',
    res ->> 'status' = 'ok' and res ->> 'booking_id' = b::text
    and (select x.status = 'in_call' and x.ticket_claimed_at = '2026-12-02 10:41:00+00'
           from screening_v2.r1_meet_bookings x where x.id = b), res::text);
  res := _r1_meet_tests.claim('ticket-301b', '2026-12-02 10:42:00+00');
  perform _r1_meet_tests.assert('T4-A the re-armed ticket a second time: ticket_already_claimed',
    res = jsonb_build_object('status', 'ticket_already_claimed', 'booking_id', b), res::text);
  bj := _r1_meet_tests.booking_json(b);
  res := _r1_meet_tests.arm(b, 'ticket-301b', '2026-12-02 10:43:00+00');
  perform _r1_meet_tests.assert('T4-A re-arming the spent (claimed) digest: digest_in_use, nothing written',
    res = jsonb_build_object('status', 'digest_in_use', 'booking_id', b)
    and _r1_meet_tests.booking_json(b) = bj, res::text);

  -- An identical re-arm is idempotent; a new window for the same unclaimed ticket re-arms; the
  -- sixth arm of one bot generation is refused.
  res := _r1_meet_tests.arm(b, 'ticket-301c', '2026-12-02 10:44:00+00');
  perform _r1_meet_tests.assert('T4-A the third arm: ok',
    res ->> 'status' = 'ok' and (res ->> 'ticket_arms')::integer = 3, res::text);
  bj := _r1_meet_tests.booking_json(b);
  res := _r1_meet_tests.arm(b, 'ticket-301c', '2026-12-02 10:45:00+00');
  perform _r1_meet_tests.assert(
    'T4-A the same unclaimed ticket and window again: duplicate, no arm used, nothing written',
    res ->> 'status' = 'duplicate' and res ->> 'booking_id' = b::text
    and (res ->> 'ticket_arms')::integer = 3 and _r1_meet_tests.booking_json(b) = bj, res::text);
  res := _r1_meet_tests.arm(b, 'ticket-301c', '2026-12-02 10:46:00+00', '2026-12-02 10:46:00+00', ex);
  perform _r1_meet_tests.assert('T4-A the same unclaimed ticket with a new window re-arms: the fourth arm',
    res ->> 'status' = 'ok' and (res ->> 'ticket_arms')::integer = 4
    and (select x.ticket_not_before = '2026-12-02 10:46:00+00' and x.ticket_claimed_at is null
           from screening_v2.r1_meet_bookings x where x.id = b), res::text);
  res := _r1_meet_tests.arm(b, 'ticket-301d', '2026-12-02 10:47:00+00');
  perform _r1_meet_tests.assert('T4-A the fifth arm: ok',
    res ->> 'status' = 'ok' and (res ->> 'ticket_arms')::integer = 5, res::text);
  bj := _r1_meet_tests.booking_json(b);
  res := _r1_meet_tests.arm(b, 'ticket-301e', '2026-12-02 10:48:00+00');
  perform _r1_meet_tests.assert('T4-A a sixth arm in one bot generation: ticket_arms_exhausted, nothing written',
    res = jsonb_build_object('status', 'ticket_arms_exhausted', 'booking_id', b, 'ticket_arms', 5)
    and _r1_meet_tests.booking_json(b) = bj, res::text);
  res := _r1_meet_tests.claim('ticket-301d', '2026-12-02 10:49:00+00');
  perform _r1_meet_tests.assert('T4-A the fifth ticket still claims once',
    res ->> 'status' = 'ok' and res ->> 'booking_id' = b::text, res::text);
  perform _r1_meet_tests.assert('T4-A arming and claiming created no call session for the round',
    _r1_meet_tests.sessions_of(r) = 0);

  -- Armable while the bot joins and once a human is present; a claim from human_present.
  b2 := _r1_meet_tests.scheduled_booking(302);
  res := screening_v2.r1_meet_transition_booking(b2, 'bot_scheduled', 'bot_joining', 'eligible',
                                                 '2026-12-02 10:25:00+00');
  perform _r1_meet_tests.assert('T4-A fixture: the bot is joining', res ->> 'status' = 'ok', res::text);
  res := _r1_meet_tests.arm(b2, 'ticket-302', '2026-12-02 10:26:00+00');
  perform _r1_meet_tests.assert('T4-A arm on a bot_joining booking: ok, still bot_joining',
    res ->> 'status' = 'ok'
    and (select x.status = 'bot_joining' from screening_v2.r1_meet_bookings x where x.id = b2), res::text);
  res := screening_v2.r1_meet_transition_booking(b2, 'bot_joining', 'human_present', 'eligible',
                                                 '2026-12-02 10:31:00+00');
  res := _r1_meet_tests.arm(b2, 'ticket-302b', '2026-12-02 10:31:30+00');
  perform _r1_meet_tests.assert('T4-A arm on a human_present booking: ok, still human_present',
    res ->> 'status' = 'ok' and (res ->> 'ticket_arms')::integer = 2
    and (select x.status = 'human_present' from screening_v2.r1_meet_bookings x where x.id = b2), res::text);
  res := _r1_meet_tests.claim('ticket-302b', '2026-12-02 10:32:00+00');
  perform _r1_meet_tests.assert('T4-A a claim from human_present: ok, in_call',
    res ->> 'status' = 'ok'
    and (select x.status = 'in_call' from screening_v2.r1_meet_bookings x where x.id = b2), res::text);

  -- Expiry: a claim at expires_at is too late.
  b3 := _r1_meet_tests.scheduled_booking(303);
  res := _r1_meet_tests.arm(b3, 'ticket-303', t_arm, nb, '2026-12-02 10:45:00+00');
  bj := _r1_meet_tests.booking_json(b3);
  res := _r1_meet_tests.claim('ticket-303', '2026-12-02 10:45:00+00');
  perform _r1_meet_tests.assert('T4-A a claim at expires_at: ticket_expired, nothing written',
    res = jsonb_build_object('status', 'ticket_expired', 'booking_id', b3)
    and _r1_meet_tests.booking_json(b3) = bj, res::text);

  -- A digest another booking holds, claimed (301d) or not (303), is never armed twice.
  res := _r1_meet_tests.arm(b3, 'ticket-301d', '2026-12-02 10:50:00+00');
  perform _r1_meet_tests.assert('T4-A arming a digest another booking holds (claimed): digest_in_use',
    res = jsonb_build_object('status', 'digest_in_use', 'booking_id', b3)
    and _r1_meet_tests.booking_json(b3) = bj, res::text);
  res := _r1_meet_tests.arm(b2, 'ticket-303', '2026-12-02 10:50:00+00');
  perform _r1_meet_tests.assert('T4-A arming a digest another booking holds (unclaimed): digest_in_use',
    res = jsonb_build_object('status', 'digest_in_use', 'booking_id', b2)
    and (select x.ticket_digest = _r1_meet_tests.digest('ticket-302b')
           from screening_v2.r1_meet_bookings x where x.id = b2), res::text);

  -- Cancelled: the cancel clears the unclaimed ticket (its digest is then unknown) and a cancelled
  -- booking is not armable. A terminal booking that still holds an unclaimed ticket is a state no
  -- RPC writes; inserted directly, its ticket is still never claimable.
  b3 := _r1_meet_tests.scheduled_booking(304);
  res := _r1_meet_tests.arm(b3, 'ticket-304', '2026-12-01 05:00:00+00');
  res := screening_v2.r1_meet_cancel_booking(b3, 'cancelled', '2026-12-01 06:00:00+00');
  perform _r1_meet_tests.assert('T4-A fixture: the armed booking is cancelled', res ->> 'status' = 'ok', res::text);
  res := _r1_meet_tests.claim('ticket-304');
  perform _r1_meet_tests.assert('T4-A the ticket of a cancelled booking: ticket_unknown (the cancel cleared it)',
    res = jsonb_build_object('status', 'ticket_unknown'), res::text);
  res := _r1_meet_tests.arm(b3, 'ticket-304b', '2026-12-01 07:00:00+00');
  perform _r1_meet_tests.assert('T4-A arm on a cancelled booking: not_armable',
    res = jsonb_build_object('status', 'not_armable', 'booking_id', b3, 'booking_status', 'cancelled'),
    res::text);
  perform _r1_meet_tests.candidate(305, false);
  perform _r1_meet_tests.round(305);
  b3 := _r1_meet_tests.insert_booking(305, jsonb_build_object(
    'status', 'cancelled', 'reason', 'cancelled',
    'candidate_id', _r1_meet_tests.id(10, 305), 'round_id', _r1_meet_tests.id(11, 305),
    'recall_bot_id', _r1_meet_tests.id(30, 3305),
    'ticket_digest', _r1_meet_tests.digest('ticket-305'),
    'ticket_not_before', nb, 'ticket_expires_at', ex, 'ticket_arms', 1));
  res := _r1_meet_tests.claim('ticket-305');
  perform _r1_meet_tests.assert(
    'T4-A a claim on a cancelled booking that still holds an unclaimed ticket: booking_not_claimable',
    res = jsonb_build_object('status', 'booking_not_claimable', 'booking_id', b3,
                             'booking_status', 'cancelled')
    and (select x.status = 'cancelled' and x.ticket_claimed_at is null
           from screening_v2.r1_meet_bookings x where x.id = b3), res::text);

  -- The round must be a live Meet round: a browser round, or one HR cancelled, is not claimable.
  b3 := _r1_meet_tests.booking_in(306, 'bot_scheduled');
  res := _r1_meet_tests.arm(b3, 'ticket-306');
  perform _r1_meet_tests.assert('T4-A fixture: a booking on a browser round is armed', res ->> 'status' = 'ok', res::text);
  res := _r1_meet_tests.claim('ticket-306');
  perform _r1_meet_tests.assert('T4-A a claim whose round is not a Meet round (channel browser): round_not_live',
    res = jsonb_build_object('status', 'round_not_live', 'booking_id', b3,
                             'round_id', _r1_meet_tests.id(11, 306))
    and (select x.status = 'bot_scheduled' and x.ticket_claimed_at is null
           from screening_v2.r1_meet_bookings x where x.id = b3), res::text);
  b3 := _r1_meet_tests.scheduled_booking(307);
  select * into rr from screening_v2.interview_rounds x
   where x.id = (select y.round_id from screening_v2.r1_meet_bookings y where y.id = b3);
  res := _r1_meet_tests.arm(b3, 'ticket-307');
  res := screening_v2.r1_transition_round(rr.id, 'cancel', rr.version, null, null, '2026-12-02 10:05:00+00');
  perform _r1_meet_tests.assert('T4-A fixture: the Meet round is cancelled', res ->> 'status' = 'ok', res::text);
  bj := _r1_meet_tests.booking_json(b3);
  res := _r1_meet_tests.claim('ticket-307');
  perform _r1_meet_tests.assert('T4-A a claim whose Meet round was cancelled: round_not_live, nothing written',
    res = jsonb_build_object('status', 'round_not_live', 'booking_id', b3, 'round_id', rr.id)
    and _r1_meet_tests.booking_json(b3) = bj, res::text);

  -- Input checks.
  res := screening_v2.r1_meet_claim_ticket('xyz', t_arm);
  perform _r1_meet_tests.assert('T4-A a claim of ''xyz'': invalid_ticket',
    res = jsonb_build_object('status', 'invalid_ticket'), res::text);
  res := screening_v2.r1_meet_claim_ticket(upper(_r1_meet_tests.digest('ticket-303')), '2026-12-02 10:31:00+00');
  perform _r1_meet_tests.assert('T4-A a claim of an upper-case digest: invalid_ticket',
    res = jsonb_build_object('status', 'invalid_ticket'), res::text);
  res := screening_v2.r1_meet_claim_ticket(null, t_arm);
  perform _r1_meet_tests.assert('T4-A a claim of no ticket: invalid_ticket',
    res = jsonb_build_object('status', 'invalid_ticket'), res::text);
  res := screening_v2.r1_meet_claim_ticket(_r1_meet_tests.digest('ticket-303'), null);
  perform _r1_meet_tests.assert('T4-A a claim without p_now: invalid_request (now)',
    res = jsonb_build_object('status', 'invalid_request', 'field', 'now'), res::text);
  res := _r1_meet_tests.claim('never-armed');
  perform _r1_meet_tests.assert('T4-A a claim of a ticket never armed: ticket_unknown',
    res = jsonb_build_object('status', 'ticket_unknown'), res::text);
  res := screening_v2.r1_meet_arm_ticket(b2, 'xyz', nb, ex, t_arm);
  perform _r1_meet_tests.assert('T4-A an arm of ''xyz'': invalid_ticket',
    res = jsonb_build_object('status', 'invalid_ticket'), res::text);
  res := screening_v2.r1_meet_arm_ticket(b2, null, nb, ex, t_arm);
  perform _r1_meet_tests.assert('T4-A an arm of no digest: invalid_ticket',
    res = jsonb_build_object('status', 'invalid_ticket'), res::text);
  res := screening_v2.r1_meet_arm_ticket(b2, _r1_meet_tests.digest('ticket-x'), nb, ex, null);
  perform _r1_meet_tests.assert('T4-A an arm without p_now: invalid_request (now)',
    res = jsonb_build_object('status', 'invalid_request', 'field', 'now'), res::text);
  res := screening_v2.r1_meet_arm_ticket(_r1_meet_tests.id(99, 1), _r1_meet_tests.digest('ticket-x'), nb, ex, t_arm);
  perform _r1_meet_tests.assert('T4-A an arm on an unknown booking: not_found',
    res = jsonb_build_object('status', 'not_found'), res::text);
  perform _r1_meet_tests.assert('T4-A the unclaimed ticket 303 is still unclaimed after the refused claims',
    (select x.ticket_claimed_at is null and x.status = 'bot_scheduled'
       from screening_v2.r1_meet_bookings x where x.ticket_digest = _r1_meet_tests.digest('ticket-303')));

  perform _r1_meet_tests.assert('T4-A no call_sessions row was created by any arm or claim',
    (select count(*) from screening_v2.call_sessions) = n_sessions);
end;
$$;

-- T4-B. r1_meet_record_receipt: insert-or-report-duplicate, the outbox (one live r1-meet job per
-- receipt while it is enqueued), re-drive, settled work, the booking link, every refusal.
do $$
declare
  p_now constant timestamptz := '2026-12-01 05:00:00+00';
  k1 constant text := 'msg_t4' || left(_r1_meet_tests.digest('t4-svix-1'), 24);
  k2 constant text := 'msg_t4' || left(_r1_meet_tests.digest('t4-svix-2'), 24);
  k3 constant text := 'msg_t4' || left(_r1_meet_tests.digest('t4-svix-3'), 24);
  k4 constant text := 'msg_t4' || left(_r1_meet_tests.digest('t4-svix-4'), 24);
  fp constant text := left(_r1_meet_tests.digest('t4-fingerprint'), 16);
  ka constant text := 'ashby-schedule:' || _r1_meet_tests.id(21, 311)::text || ':1764493205000:' || fp;
  ka_longest constant text := 'ashby-schedule:' || _r1_meet_tests.id(21, 312)::text
                              || ':r8640000000000000:' || fp;
  w_payload constant jsonb := jsonb_build_object('kind', 'bot_status');
  b uuid;
  id1 uuid;
  id2 uuid;
  id3 uuid;
  res jsonb;
  rc jsonb;
  jb screening_v2.job_queue%rowtype;
  n_receipts bigint;
  n_jobs bigint;
  bad record;
begin
  -- A delivery without work: recorded, nothing queued; the same key again is a duplicate.
  res := screening_v2.r1_meet_record_receipt('recall', k1, 'bot.status_change', null, false, null, null, p_now);
  id1 := (res ->> 'id')::uuid;
  perform _r1_meet_tests.assert('T4-B a first delivery without work: inserted, recorded, nothing queued',
    res = jsonb_build_object('status', 'inserted', 'id', id1, 'outcome', 'recorded', 'enqueued', false,
                             'work_pending', false, 'booking_linked', false)
    and (select x.source = 'recall' and x.dedupe_key = k1 and x.event_type = 'bot.status_change'
                and x.outcome = 'recorded' and x.received_at = p_now and x.processed_at is null
                and x.booking_id is null
           from screening_v2.r1_meet_receipts x where x.id = id1)
    and _r1_meet_tests.receipt_jobs(id1) = 0, res::text);
  rc := (select to_jsonb(x) from screening_v2.r1_meet_receipts x where x.id = id1);
  res := screening_v2.r1_meet_record_receipt('recall', k1, 'bot.status_change', null, false, null, null,
                                             p_now + interval '1 minute');
  perform _r1_meet_tests.assert('T4-B the same dedupe key again: duplicate with the same id, nothing written',
    res = jsonb_build_object('status', 'duplicate', 'id', id1, 'outcome', 'recorded', 'enqueued', false,
                             'work_pending', false, 'booking_linked', false)
    and (select to_jsonb(x) from screening_v2.r1_meet_receipts x where x.id = id1) = rc
    and (select count(*) = 1 from screening_v2.r1_meet_receipts x where x.dedupe_key in (k1)), res::text);

  -- A delivery with work: one job in the r1-meet queue, linked to its booking.
  b := _r1_meet_tests.booking_in(310, 'bot_scheduled');
  res := screening_v2.r1_meet_record_receipt('recall', k2, 'bot.in_call_recording', b, true,
    jsonb_build_object('kind', 'bot_status', 'recall_bot_id', _r1_meet_tests.id(30, 310)), null, p_now);
  id2 := (res ->> 'id')::uuid;
  select * into jb from screening_v2.job_queue j where j.dedup_key = 'r1-meet:receipt:' || id2::text;
  perform _r1_meet_tests.assert('T4-B a delivery with work: inserted, enqueued, work pending, linked to its booking',
    res = jsonb_build_object('status', 'inserted', 'id', id2, 'outcome', 'enqueued', 'enqueued', true,
                             'work_pending', true, 'booking_linked', true)
    and (select x.outcome = 'enqueued' and x.booking_id = b and x.processed_at is null
           from screening_v2.r1_meet_receipts x where x.id = id2), res::text);
  perform _r1_meet_tests.assert(
    'T4-B exactly one r1-meet job: the payload kind plus receipt_id and source, 5 attempts, due at p_now',
    _r1_meet_tests.receipt_jobs(id2) = 1
    and jb.name = 'r1-meet' and jb.status = 'pending'
    and jb.payload = jsonb_build_object('kind', 'bot_status', 'recall_bot_id', _r1_meet_tests.id(30, 310),
                                        'receipt_id', id2, 'source', 'recall')
    and jb.attempts = 0 and jb.max_attempts = 5 and jb.priority = 0
    and jb.scheduled_at = p_now and jb.created_at = p_now, to_jsonb(jb)::text);

  -- Re-drive: never a second live job; a missing job comes back while the receipt is enqueued.
  res := screening_v2.r1_meet_record_receipt('recall', k2, 'bot.in_call_recording', b, true, w_payload, null,
                                             p_now + interval '1 minute');
  perform _r1_meet_tests.assert('T4-B a duplicate while the job is live: no second job, work pending',
    res = jsonb_build_object('status', 'duplicate', 'id', id2, 'outcome', 'enqueued', 'enqueued', false,
                             'work_pending', true, 'booking_linked', true)
    and _r1_meet_tests.receipt_jobs(id2) = 1, res::text);
  update screening_v2.job_queue set status = 'completed', completed_at = p_now
   where dedup_key = 'r1-meet:receipt:' || id2::text;
  res := screening_v2.r1_meet_record_receipt('recall', k2, 'bot.in_call_recording', b, true, w_payload, null,
                                             p_now + interval '2 minutes');
  perform _r1_meet_tests.assert(
    'T4-B the job finished but the receipt is still enqueued: the duplicate re-drives exactly one job',
    res = jsonb_build_object('status', 'duplicate', 'id', id2, 'outcome', 'enqueued', 'enqueued', true,
                             'work_pending', true, 'booking_linked', true)
    and _r1_meet_tests.receipt_jobs(id2) = 2 and _r1_meet_tests.receipt_jobs(id2, true) = 1, res::text);

  -- Settled work is never re-run: processed, and failed.
  update screening_v2.job_queue set status = 'completed', completed_at = p_now
   where dedup_key = 'r1-meet:receipt:' || id2::text and status = 'pending';
  update screening_v2.r1_meet_receipts
     set outcome = 'processed', processed_at = p_now + interval '3 minutes'
   where id = id2;
  res := screening_v2.r1_meet_record_receipt('recall', k2, 'bot.in_call_recording', b, true, w_payload, null,
                                             p_now + interval '4 minutes');
  perform _r1_meet_tests.assert('T4-B a processed receipt: the duplicate queues nothing, the work is settled',
    res = jsonb_build_object('status', 'duplicate', 'id', id2, 'outcome', 'processed', 'enqueued', false,
                             'work_pending', true, 'booking_linked', true)
    and _r1_meet_tests.receipt_jobs(id2) = 2 and _r1_meet_tests.receipt_jobs(id2, true) = 0, res::text);
  res := screening_v2.r1_meet_record_receipt('recall', k3, 'bot.fatal', null, true, w_payload, null, p_now);
  id3 := (res ->> 'id')::uuid;
  update screening_v2.job_queue set status = 'failed', failed_at = p_now
   where dedup_key = 'r1-meet:receipt:' || id3::text;
  update screening_v2.r1_meet_receipts set outcome = 'failed', processed_at = p_now where id = id3;
  res := screening_v2.r1_meet_record_receipt('recall', k3, 'bot.fatal', null, true, w_payload, null,
                                             p_now + interval '1 minute');
  perform _r1_meet_tests.assert('T4-B a failed receipt: the duplicate queues nothing',
    res = jsonb_build_object('status', 'duplicate', 'id', id3, 'outcome', 'failed', 'enqueued', false,
                             'work_pending', true, 'booking_linked', false)
    and _r1_meet_tests.receipt_jobs(id3) = 1 and _r1_meet_tests.receipt_jobs(id3, true) = 0, res::text);

  -- A recorded-only receipt that a later delivery asks work for becomes enqueued, with one job.
  res := screening_v2.r1_meet_record_receipt('recall', k1, 'bot.status_change', null, true, w_payload, null,
                                             p_now + interval '5 minutes');
  perform _r1_meet_tests.assert(
    'T4-B a recorded-only receipt asked for work by a later delivery: enqueued, one live job',
    res = jsonb_build_object('status', 'duplicate', 'id', id1, 'outcome', 'enqueued', 'enqueued', true,
                             'work_pending', true, 'booking_linked', false)
    and (select x.outcome = 'enqueued' and x.processed_at is null and x.received_at = p_now
                and x.event_type = 'bot.status_change'
           from screening_v2.r1_meet_receipts x where x.id = id1)
    and _r1_meet_tests.receipt_jobs(id1, true) = 1, res::text);

  -- An Ashby schedule receipt with a delayed job (S06 re-runs), and the longest S01 key.
  res := screening_v2.r1_meet_record_receipt('ashby', ka, 'interviewScheduleUpdate', null, true,
    jsonb_build_object('kind', 'ashby_schedule', 'schedule_id', _r1_meet_tests.id(21, 311)::text),
    p_now + interval '2 hours', p_now);
  select * into jb from screening_v2.job_queue j
   where j.dedup_key = 'r1-meet:receipt:' || (res ->> 'id');
  perform _r1_meet_tests.assert('T4-B an Ashby schedule receipt with p_scheduled_at: the job is due then',
    res ->> 'status' = 'inserted' and (res ->> 'enqueued')::boolean
    and jb.name = 'r1-meet' and jb.scheduled_at = p_now + interval '2 hours' and jb.created_at = p_now
    and jb.payload ->> 'source' = 'ashby' and jb.payload ->> 'kind' = 'ashby_schedule'
    and jb.payload ->> 'receipt_id' = res ->> 'id', res::text);
  perform _r1_meet_tests.assert('T4-B fixture: the longest S01 Ashby key is 86 characters',
    char_length(ka_longest) = 86, ka_longest);
  res := screening_v2.r1_meet_record_receipt('ashby', ka_longest, 'interviewScheduleCreate', null, false,
                                             null, null, p_now);
  perform _r1_meet_tests.assert('T4-B the 86-character S01 Ashby key is accepted by the RPC',
    res ->> 'status' = 'inserted'
    and exists (select 1 from screening_v2.r1_meet_receipts x
                 where x.id = (res ->> 'id')::uuid and x.dedupe_key in (ka_longest)
                   and x.source = 'ashby'), res::text);

  -- The booking link: an unknown booking id is stored as NULL, never an error.
  res := screening_v2.r1_meet_record_receipt('recall', k4, 'bot.done', _r1_meet_tests.id(99, 2), false,
                                             null, null, p_now);
  perform _r1_meet_tests.assert('T4-B an unknown booking id is stored as NULL: inserted, booking_linked false',
    res ->> 'status' = 'inserted' and (res ->> 'booking_linked')::boolean = false
    and (select x.booking_id is null from screening_v2.r1_meet_receipts x where x.id = (res ->> 'id')::uuid),
    res::text);
  res := screening_v2.r1_meet_record_receipt('recall', 'msg_t4-nullenqueue', 'bot.done', null, null, null,
                                             null, p_now);
  perform _r1_meet_tests.assert('T4-B a NULL p_enqueue records without work',
    res ->> 'status' = 'inserted' and res ->> 'outcome' = 'recorded'
    and (res ->> 'enqueued')::boolean = false
    and _r1_meet_tests.receipt_jobs((res ->> 'id')::uuid) = 0, res::text);
  res := screening_v2.r1_meet_record_receipt('recall', 'msg_t4-sched-bounds', 'bot.done', null, true, w_payload,
                                             p_now + interval '30 days', p_now);
  perform _r1_meet_tests.assert('T4-B a job scheduled exactly 30 days ahead is accepted',
    res ->> 'status' = 'inserted' and (res ->> 'enqueued')::boolean, res::text);
  res := screening_v2.r1_meet_record_receipt('recall', 'msg_t4-sched-past', 'bot.done', null, true, w_payload,
                                             p_now - interval '1 hour', p_now);
  perform _r1_meet_tests.assert('T4-B a job scheduled exactly an hour back is accepted',
    res ->> 'status' = 'inserted' and (res ->> 'enqueued')::boolean, res::text);

  -- Every refusal, none of which writes a receipt or queues a job.
  n_receipts := (select count(*) from screening_v2.r1_meet_receipts);
  n_jobs := (select count(*) from screening_v2.job_queue j where j.name = 'r1-meet');
  for bad in
    select * from (values
      ('invalid_source', 'no source', null::text, 'msg_t4-bad'::text, 'bot.done'::text, false, null::jsonb, null::timestamptz, p_now),
      ('invalid_source', 'source calendly', 'calendly', 'msg_t4-bad', 'bot.done', false, null, null, p_now),
      ('invalid_dedupe_key', 'no dedupe key', 'recall', null, 'bot.done', false, null, null, p_now),
      ('invalid_dedupe_key', 'an empty dedupe key', 'recall', '', 'bot.done', false, null, null, p_now),
      ('invalid_dedupe_key', 'a dedupe key with a space', 'recall', 'msg_t4 bad', 'bot.done', false, null, null, p_now),
      ('invalid_dedupe_key', 'a 257-character dedupe key', 'recall', 'msg_' || repeat('a', 253), 'bot.done', false, null, null, p_now),
      ('invalid_dedupe_key', 'an ashby receipt without the S01 prefix', 'ashby', 'msg_t4-bad', 'bot.done', false, null, null, p_now),
      ('invalid_dedupe_key', 'a recall receipt with the S01 prefix', 'recall',
        'ashby-schedule:' || _r1_meet_tests.id(21, 313)::text || ':1:' || fp, 'bot.done', false, null, null, p_now),
      ('invalid_event_type', 'no event type', 'recall', 'msg_t4-bad', null, false, null, null, p_now),
      ('invalid_event_type', 'an empty event type', 'recall', 'msg_t4-bad', '', false, null, null, p_now),
      ('invalid_event_type', 'an event type with a space', 'recall', 'msg_t4-bad', 'bot done', false, null, null, p_now),
      ('invalid_event_type', 'a 129-character event type', 'recall', 'msg_t4-bad', repeat('e', 129), false, null, null, p_now),
      ('invalid_request', 'no p_now', 'recall', 'msg_t4-bad', 'bot.done', false, null, null, null),
      ('invalid_payload', 'work without a payload', 'recall', 'msg_t4-bad', 'bot.done', true, null, null, p_now),
      ('invalid_payload', 'work with an array payload', 'recall', 'msg_t4-bad', 'bot.done', true, '[]'::jsonb, null, p_now),
      ('invalid_payload', 'work with a JSON null payload', 'recall', 'msg_t4-bad', 'bot.done', true, 'null'::jsonb, null, p_now),
      ('invalid_payload', 'work without a kind', 'recall', 'msg_t4-bad', 'bot.done', true, '{}'::jsonb, null, p_now),
      ('invalid_payload', 'a numeric kind', 'recall', 'msg_t4-bad', 'bot.done', true, '{"kind": 5}'::jsonb, null, p_now),
      ('invalid_payload', 'a boolean kind', 'recall', 'msg_t4-bad', 'bot.done', true, '{"kind": true}'::jsonb, null, p_now),
      ('invalid_payload', 'an upper-case kind', 'recall', 'msg_t4-bad', 'bot.done', true, '{"kind": "Bot"}'::jsonb, null, p_now),
      ('invalid_payload', 'a kind that starts with a digit', 'recall', 'msg_t4-bad', 'bot.done', true, '{"kind": "1bot"}'::jsonb, null, p_now),
      ('invalid_payload', 'a 41-character kind', 'recall', 'msg_t4-bad', 'bot.done', true, jsonb_build_object('kind', repeat('k', 41)), null, p_now),
      ('invalid_payload', 'a payload without p_enqueue', 'recall', 'msg_t4-bad', 'bot.done', false, w_payload, null, p_now),
      ('payload_too_large', 'a payload over 4096 bytes', 'recall', 'msg_t4-bad', 'bot.done', true,
        jsonb_build_object('kind', 'bot_status', 'pad', repeat('p', 4100)), null, p_now),
      ('invalid_scheduled_at', 'a job due more than an hour back', 'recall', 'msg_t4-bad', 'bot.done', true, w_payload,
        p_now - interval '1 hour 1 second', p_now),
      ('invalid_scheduled_at', 'a job due more than 30 days ahead', 'recall', 'msg_t4-bad', 'bot.done', true, w_payload,
        p_now + interval '30 days 1 second', p_now),
      ('invalid_scheduled_at', 'a due time without p_enqueue', 'recall', 'msg_t4-bad', 'bot.done', false, null,
        p_now + interval '1 hour', p_now)
    ) as v(code, label, src, dkey, evt, enq, payload, sched, at_now)
  loop
    res := screening_v2.r1_meet_record_receipt(bad.src, bad.dkey, bad.evt, null, bad.enq, bad.payload,
                                               bad.sched, bad.at_now);
    perform _r1_meet_tests.assert('T4-B ' || bad.label || ': ' || bad.code,
      res = case when bad.code = 'invalid_request'
                 then jsonb_build_object('status', bad.code, 'field', 'now')
                 else jsonb_build_object('status', bad.code) end, res::text);
  end loop;
  perform _r1_meet_tests.assert('T4-B the refused deliveries wrote no receipt and queued no job',
    (select count(*) from screening_v2.r1_meet_receipts) = n_receipts
    and (select count(*) from screening_v2.job_queue j where j.name = 'r1-meet') = n_jobs);
end;
$$;

-- T4-C. r1_meet_prune_receipts: the 7-day floor, the batch limit, settled receipts only. Its
-- fixtures are the only receipts of the run received before 2026-11-01.
do $$
declare
  p_now constant timestamptz := '2026-11-01 00:00:00+00';
  cutoff constant timestamptz := '2026-10-01 00:00:00+00';
  n_recent bigint := (select count(*) from screening_v2.r1_meet_receipts x
                       where x.received_at >= '2026-11-01 00:00:00+00');
  res jsonb;
begin
  insert into screening_v2.r1_meet_receipts
    (source, dedupe_key, event_type, outcome, received_at, processed_at)
  values
    ('recall', 'msg_t4prune-p1', 'bot.done', 'processed', '2026-09-01 00:00:00+00', '2026-09-01 00:01:00+00'),
    ('recall', 'msg_t4prune-p2', 'bot.done', 'processed', '2026-09-02 00:00:00+00', '2026-09-02 00:01:00+00'),
    ('recall', 'msg_t4prune-i', 'bot.done', 'ignored', '2026-09-03 00:00:00+00', '2026-09-03 00:01:00+00'),
    ('recall', 'msg_t4prune-f', 'bot.done', 'failed', '2026-09-04 00:00:00+00', '2026-09-04 00:01:00+00'),
    ('recall', 'msg_t4prune-r', 'bot.done', 'recorded', '2026-09-05 00:00:00+00', null),
    ('recall', 'msg_t4prune-e', 'bot.done', 'enqueued', '2026-08-01 00:00:00+00', null),
    ('recall', 'msg_t4prune-d', 'bot.done', 'enqueued', '2026-09-06 00:00:00+00', null),
    ('recall', 'msg_t4prune-new', 'bot.done', 'processed', '2026-10-30 00:00:00+00', '2026-10-30 00:01:00+00');
  -- msg_t4prune-e still has its live outbox job; msg_t4prune-d's job dead-lettered (no live row, so
  -- nothing will ever settle the receipt).
  insert into screening_v2.job_queue (name, payload, dedup_key)
  select 'r1-meet', jsonb_build_object('kind', 'bot_status', 'receipt_id', x.id),
         'r1-meet:receipt:' || x.id::text
    from screening_v2.r1_meet_receipts x where x.dedupe_key in ('msg_t4prune-e');

  res := screening_v2.r1_meet_prune_receipts(p_now - interval '6 days', 500, p_now);
  perform _r1_meet_tests.assert('T4-C six days of retention: retention_too_short',
    res = jsonb_build_object('status', 'retention_too_short'), res::text);
  res := screening_v2.r1_meet_prune_receipts(cutoff, 0, p_now);
  perform _r1_meet_tests.assert('T4-C a limit of 0: invalid_request (limit)',
    res = jsonb_build_object('status', 'invalid_request', 'field', 'limit'), res::text);
  res := screening_v2.r1_meet_prune_receipts(cutoff, 5001, p_now);
  perform _r1_meet_tests.assert('T4-C a limit of 5001: invalid_request (limit)',
    res = jsonb_build_object('status', 'invalid_request', 'field', 'limit'), res::text);
  res := screening_v2.r1_meet_prune_receipts(cutoff, null, p_now);
  perform _r1_meet_tests.assert('T4-C no limit: invalid_request (limit)',
    res = jsonb_build_object('status', 'invalid_request', 'field', 'limit'), res::text);
  res := screening_v2.r1_meet_prune_receipts(null, 500, p_now);
  perform _r1_meet_tests.assert('T4-C no cutoff: invalid_request (older_than)',
    res = jsonb_build_object('status', 'invalid_request', 'field', 'older_than'), res::text);
  res := screening_v2.r1_meet_prune_receipts(cutoff, 500, null);
  perform _r1_meet_tests.assert('T4-C no p_now: invalid_request (now)',
    res = jsonb_build_object('status', 'invalid_request', 'field', 'now'), res::text);
  perform _r1_meet_tests.assert('T4-C the refused prunes deleted nothing',
    (select count(*) = 8 from screening_v2.r1_meet_receipts x where x.dedupe_key like 'msg_t4prune-%'));

  res := screening_v2.r1_meet_prune_receipts(cutoff, 2, p_now);
  perform _r1_meet_tests.assert(
    'T4-C a batch of 2: the two oldest settled receipts go; the older enqueued one stays',
    res = jsonb_build_object('status', 'ok', 'deleted', 2)
    and not exists (select 1 from screening_v2.r1_meet_receipts x
                     where x.dedupe_key in ('msg_t4prune-p1', 'msg_t4prune-p2'))
    and exists (select 1 from screening_v2.r1_meet_receipts x where x.dedupe_key in ('msg_t4prune-e')),
    res::text);
  res := screening_v2.r1_meet_prune_receipts(cutoff, 500, p_now);
  perform _r1_meet_tests.assert(
    'T4-C the rest: old ignored, failed and recorded receipts go; enqueued and recent ones stay',
    res = jsonb_build_object('status', 'ok', 'deleted', 4)
    and (select array_agg(x.dedupe_key order by x.dedupe_key) from screening_v2.r1_meet_receipts x
          where x.dedupe_key like 'msg_t4prune-%') = array['msg_t4prune-e', 'msg_t4prune-new'],
    res::text);
  perform _r1_meet_tests.assert(
    'T4-C an old enqueued receipt whose job dead-lettered goes; one whose job is still live stays',
    not exists (select 1 from screening_v2.r1_meet_receipts x where x.dedupe_key in ('msg_t4prune-d'))
    and exists (select 1 from screening_v2.r1_meet_receipts x where x.dedupe_key in ('msg_t4prune-e')));
  res := screening_v2.r1_meet_prune_receipts(p_now - interval '7 days', 500, p_now);
  perform _r1_meet_tests.assert('T4-C exactly seven days of retention is allowed; nothing older is left',
    res = jsonb_build_object('status', 'ok', 'deleted', 0)
    and exists (select 1 from screening_v2.r1_meet_receipts x where x.dedupe_key in ('msg_t4prune-new')),
    res::text);
  perform _r1_meet_tests.assert('T4-C every receipt received on or after 2026-11-01 is untouched',
    (select count(*) from screening_v2.r1_meet_receipts x
      where x.received_at >= '2026-11-01 00:00:00+00') = n_recent);
end;
$$;

-- T4-C (bookings, review F5). r1_meet_prune_bookings: a booking that never got a round is reached
-- by no round cascade (and an unmatched one by no candidate cascade either), so it is deleted once
-- its slot ended before the cutoff. A booking with a round lives as long as its round. Its
-- fixtures are the only bookings of the run whose slot ended before 2026-07-01.
do $$
declare
  p_now constant timestamptz := '2026-08-01 00:00:00+00';
  cutoff constant timestamptz := '2026-07-01 00:00:00+00';
  n_others bigint := (select count(*) from screening_v2.r1_meet_bookings x where x.end_at >= '2026-07-01 00:00:00+00');
  u uuid;
  res jsonb;
  rcpt uuid;
begin
  perform _r1_meet_tests.assert('T4-C (bookings) fixture: no other booking of the run ended before the cutoff',
    not exists (select 1 from screening_v2.r1_meet_bookings x where x.end_at < cutoff));
  u := _r1_meet_tests.insert_booking(380, jsonb_build_object(
    'start_at', '2026-06-01T10:00:00+00:00', 'end_at', '2026-06-01T10:45:00+00:00'));
  perform _r1_meet_tests.candidate(381, false);
  perform _r1_meet_tests.insert_booking(381, jsonb_build_object(
    'status', 'unmapped_scheduler', 'reason', 'scheduler_unmapped', 'candidate_id', _r1_meet_tests.id(10, 381),
    'start_at', '2026-06-02T10:00:00+00:00', 'end_at', '2026-06-02T10:45:00+00:00'));
  perform _r1_meet_tests.candidate(382, false);
  perform _r1_meet_tests.insert_booking(382, jsonb_build_object(
    'status', 'cancelled', 'reason', 'cancelled', 'candidate_id', _r1_meet_tests.id(10, 382),
    'start_at', '2026-06-03T10:00:00+00:00', 'end_at', '2026-06-03T10:45:00+00:00'));
  -- A booking WITH a round (cancelled, an old slot) stays: it lives as long as its round.
  perform _r1_meet_tests.candidate(383, false);
  perform _r1_meet_tests.round(383);
  perform _r1_meet_tests.insert_booking(383, jsonb_build_object(
    'status', 'cancelled', 'reason', 'cancelled', 'candidate_id', _r1_meet_tests.id(10, 383),
    'round_id', _r1_meet_tests.id(11, 383),
    'start_at', '2026-05-01T10:00:00+00:00', 'end_at', '2026-05-01T10:45:00+00:00'));
  -- A round-less booking whose slot ended after the cutoff stays.
  perform _r1_meet_tests.insert_booking(384, jsonb_build_object(
    'start_at', '2026-07-15T10:00:00+00:00', 'end_at', '2026-07-15T10:45:00+00:00'));
  rcpt := _r1_meet_tests.receipt('recall', 'msg_t4prune-booking', 'bot.done', 'processed',
                                 '2026-06-01 11:00:00+00', u);

  res := screening_v2.r1_meet_prune_bookings(p_now - interval '6 days', 500, p_now);
  perform _r1_meet_tests.assert('T4-C (bookings) six days after the slot: retention_too_short',
    res = jsonb_build_object('status', 'retention_too_short'), res::text);
  res := screening_v2.r1_meet_prune_bookings(cutoff, 0, p_now);
  perform _r1_meet_tests.assert('T4-C (bookings) a limit of 0: invalid_request (limit)',
    res = jsonb_build_object('status', 'invalid_request', 'field', 'limit'), res::text);
  res := screening_v2.r1_meet_prune_bookings(cutoff, 5001, p_now);
  perform _r1_meet_tests.assert('T4-C (bookings) a limit of 5001: invalid_request (limit)',
    res = jsonb_build_object('status', 'invalid_request', 'field', 'limit'), res::text);
  res := screening_v2.r1_meet_prune_bookings(null, 500, p_now);
  perform _r1_meet_tests.assert('T4-C (bookings) no cutoff: invalid_request (older_than)',
    res = jsonb_build_object('status', 'invalid_request', 'field', 'older_than'), res::text);
  res := screening_v2.r1_meet_prune_bookings(cutoff, 500, null);
  perform _r1_meet_tests.assert('T4-C (bookings) no p_now: invalid_request (now)',
    res = jsonb_build_object('status', 'invalid_request', 'field', 'now'), res::text);

  res := screening_v2.r1_meet_prune_bookings(cutoff, 2, p_now);
  perform _r1_meet_tests.assert('T4-C (bookings) a batch of 2: the two oldest round-less bookings go',
    res = jsonb_build_object('status', 'ok', 'deleted', 2)
    and not exists (select 1 from screening_v2.r1_meet_bookings x
                     where x.ashby_interview_event_id in (_r1_meet_tests.id(20, 380), _r1_meet_tests.id(20, 381)))
    and exists (select 1 from screening_v2.r1_meet_bookings x
                 where x.ashby_interview_event_id = _r1_meet_tests.id(20, 382)), res::text);
  res := screening_v2.r1_meet_prune_bookings(cutoff, 500, p_now);
  perform _r1_meet_tests.assert(
    'T4-C (bookings) the rest: a terminal round-less booking goes; a booking with a round and a recent one stay',
    res = jsonb_build_object('status', 'ok', 'deleted', 1)
    and (select array_agg(x.ashby_interview_event_id order by x.end_at) from screening_v2.r1_meet_bookings x
          where x.end_at < '2026-08-01 00:00:00+00')
        = array[_r1_meet_tests.id(20, 383), _r1_meet_tests.id(20, 384)], res::text);
  perform _r1_meet_tests.assert('T4-C (bookings) a receipt of a pruned booking keeps no booking id',
    (select x.booking_id is null from screening_v2.r1_meet_receipts x where x.id = rcpt));
  perform _r1_meet_tests.assert('T4-C (bookings) every booking whose slot ended after the cutoff is untouched',
    (select count(*) from screening_v2.r1_meet_bookings x where x.end_at >= '2026-07-01 00:00:00+00')
    = n_others + 1);
  perform _r1_meet_tests.assert('T4-C (bookings) the prune queued no job and touched no round',
    exists (select 1 from screening_v2.interview_rounds x where x.id = _r1_meet_tests.id(11, 383))
    and not exists (select 1 from screening_v2.job_queue j
                     where j.payload ->> 'booking_id' in (u::text)));
end;
$$;

-- T4-D. The privilege proof, by behaviour and by catalog: anon and authenticated can neither touch
-- the two tables nor execute any of the eleven RPCs (42501); service_role reads both tables and runs
-- each RPC (its writes rolled back); every RPC is security definer with the pinned search_path and
-- executable by service_role only; these eleven are the only r1_meet_ functions.
do $$
declare
  rpcs constant text[] := array[
    'screening_v2.r1_meet_create_round_from_ashby(uuid, text, text, text, text, text, timestamptz, timestamptz, text, timestamptz, timestamptz, uuid, text, integer, timestamptz)',
    'screening_v2.r1_meet_reschedule_booking(uuid, integer, timestamptz, timestamptz, text, timestamptz, integer, timestamptz)',
    'screening_v2.r1_meet_cancel_booking(uuid, text, timestamptz)',
    'screening_v2.r1_meet_set_bot(uuid, text, integer, integer, uuid, timestamptz)',
    'screening_v2.r1_meet_transition_booking(uuid, text, text, text, timestamptz)',
    'screening_v2.r1_meet_bind_session(uuid, uuid, timestamptz)',
    'screening_v2.r1_meet_arm_ticket(uuid, text, timestamptz, timestamptz, timestamptz)',
    'screening_v2.r1_meet_claim_ticket(text, timestamptz)',
    'screening_v2.r1_meet_record_receipt(text, text, text, uuid, boolean, jsonb, timestamptz, timestamptz)',
    'screening_v2.r1_meet_prune_receipts(timestamptz, integer, timestamptz)',
    'screening_v2.r1_meet_prune_bookings(timestamptz, integer, timestamptz)'];
  -- The same order: one call each, with the fewest arguments the defaults allow.
  denied_calls constant text[] := array[
    'select screening_v2.r1_meet_create_round_from_ashby(null, null, null, null, null, null, null, null, null, null, null, null)',
    'select screening_v2.r1_meet_reschedule_booking(null, null, null, null, null, null)',
    'select screening_v2.r1_meet_cancel_booking(null, null)',
    'select screening_v2.r1_meet_set_bot(null, null, null, null)',
    'select screening_v2.r1_meet_transition_booking(null, null, null, null)',
    'select screening_v2.r1_meet_bind_session(null, null)',
    'select screening_v2.r1_meet_arm_ticket(null, null, null, null)',
    'select screening_v2.r1_meet_claim_ticket(null)',
    'select screening_v2.r1_meet_record_receipt(null, null, null)',
    'select screening_v2.r1_meet_prune_receipts(null)',
    'select screening_v2.r1_meet_prune_bookings(null)'];
  t_now constant text := '2026-12-01 04:00:00+00';
  no_booking constant uuid := _r1_meet_tests.id(99, 3);
  fn text;
  tbl text;
  who text;
  i integer;
  res jsonb;
begin
  for i in 1 .. array_length(rpcs, 1) loop
    fn := rpcs[i];
    perform _r1_meet_tests.assert(
      'T4-D ' || fn || ' is security definer with search_path pg_catalog, screening_v2',
      (select x.prosecdef and x.proconfig = array['search_path=pg_catalog, screening_v2']
         from pg_proc x where x.oid = fn::regprocedure));
    perform _r1_meet_tests.assert('T4-D ' || fn || ' is executable by service_role only (catalog)',
      has_function_privilege('service_role', fn, 'execute')
      and not has_function_privilege('anon', fn, 'execute')
      and not has_function_privilege('authenticated', fn, 'execute')
      and not has_function_privilege('public', fn, 'execute'));
    foreach who in array array['anon', 'authenticated'] loop
      perform _r1_meet_tests.raises_as(who, 'T4-D execute ' || split_part(fn, '(', 1),
        denied_calls[i], '42501');
    end loop;
  end loop;
  perform _r1_meet_tests.assert(
    'T4-D the eleven RPCs are the only screening_v2 functions named r1_meet_*, one overload each',
    (select array_agg(x.oid order by x.oid) from pg_proc x
      where x.pronamespace = 'screening_v2'::regnamespace and x.proname like 'r1\_meet\_%')
    = (select array_agg(f::regprocedure::oid order by f::regprocedure::oid) from unnest(rpcs) f));

  foreach tbl in array array['r1_meet_bookings', 'r1_meet_receipts'] loop
    foreach who in array array['anon', 'authenticated'] loop
      perform _r1_meet_tests.raises_as(who, 'T4-D select from ' || tbl,
        format('select count(*) from screening_v2.%I', tbl), '42501');
      perform _r1_meet_tests.raises_as(who, 'T4-D insert into ' || tbl,
        format('insert into screening_v2.%I default values', tbl), '42501');
      perform _r1_meet_tests.raises_as(who, 'T4-D update ' || tbl,
        format('update screening_v2.%I set id = id', tbl), '42501');
      perform _r1_meet_tests.raises_as(who, 'T4-D delete from ' || tbl,
        format('delete from screening_v2.%I', tbl), '42501');
    end loop;
    res := _r1_meet_tests.runs_as('service_role', 'T4-D select from ' || tbl,
      format('select jsonb_build_object(''n'', count(*)) from screening_v2.%I', tbl));
    perform _r1_meet_tests.assert('T4-D service_role reads ' || tbl, (res ->> 'n')::bigint >= 0, res::text);
  end loop;

  -- service_role runs every RPC (each answer a closed status of its own).
  res := _r1_meet_tests.runs_as('service_role', 'T4-D r1_meet_create_round_from_ashby', format(
    'select screening_v2.r1_meet_create_round_from_ashby(%L::uuid, %L, %L, null, null, %L, %L::timestamptz, '
    || '%L::timestamptz, %L, %L::timestamptz, %L::timestamptz, %L::uuid, %L, 7200, %L::timestamptz)',
    _r1_meet_tests.id(20, 390), _r1_meet_tests.id(21, 390), _r1_meet_tests.id(22, 390),
    _r1_meet_tests.id(25, 1), '2026-11-30 09:00:00+00', '2026-11-30 09:00:05+00',
    'https://meet.google.com/abc-defg-hij', '2026-12-02 10:30:00+00', '2026-12-02 11:15:00+00',
    _r1_meet_tests.id(1, 1), 'r1_dex_sales', t_now));
  perform _r1_meet_tests.assert('T4-D service_role: create answers unmatched_application (event 390 has no link)',
    res ->> 'status' = 'unmatched_application', res::text);
  res := _r1_meet_tests.runs_as('service_role', 'T4-D r1_meet_reschedule_booking', format(
    'select screening_v2.r1_meet_reschedule_booking(%L::uuid, 0, %L::timestamptz, %L::timestamptz, %L, '
    || '%L::timestamptz, 7200, %L::timestamptz)',
    no_booking, '2026-12-03 09:00:00+00', '2026-12-03 09:45:00+00', 'https://meet.google.com/xyz-abcd-efg',
    '2026-11-30 12:00:00+00', t_now));
  perform _r1_meet_tests.assert('T4-D service_role: reschedule answers not_found',
    res = jsonb_build_object('status', 'not_found'), res::text);
  res := _r1_meet_tests.runs_as('service_role', 'T4-D r1_meet_cancel_booking', format(
    'select screening_v2.r1_meet_cancel_booking(%L::uuid, %L, %L::timestamptz)', no_booking, 'cancelled', t_now));
  perform _r1_meet_tests.assert('T4-D service_role: cancel answers not_found',
    res = jsonb_build_object('status', 'not_found'), res::text);
  res := _r1_meet_tests.runs_as('service_role', 'T4-D r1_meet_set_bot', format(
    'select screening_v2.r1_meet_set_bot(%L::uuid, %L, 0, 0, null, %L::timestamptz)', no_booking, 'rotate_key', t_now));
  perform _r1_meet_tests.assert('T4-D service_role: set_bot answers not_found',
    res = jsonb_build_object('status', 'not_found'), res::text);
  res := _r1_meet_tests.runs_as('service_role', 'T4-D r1_meet_transition_booking', format(
    'select screening_v2.r1_meet_transition_booking(%L::uuid, %L, %L, %L, %L::timestamptz)',
    no_booking, 'pending', 'failed', 'in_past', t_now));
  perform _r1_meet_tests.assert('T4-D service_role: transition answers not_found',
    res = jsonb_build_object('status', 'not_found'), res::text);
  res := _r1_meet_tests.runs_as('service_role', 'T4-D r1_meet_bind_session', format(
    'select screening_v2.r1_meet_bind_session(%L::uuid, %L::uuid, %L::timestamptz)',
    no_booking, _r1_meet_tests.id(12, 399), t_now));
  perform _r1_meet_tests.assert('T4-D service_role: bind_session answers not_found',
    res = jsonb_build_object('status', 'not_found'), res::text);
  res := _r1_meet_tests.runs_as('service_role', 'T4-D r1_meet_arm_ticket', format(
    'select screening_v2.r1_meet_arm_ticket(%L::uuid, %L, %L::timestamptz, %L::timestamptz, %L::timestamptz)',
    no_booking, _r1_meet_tests.digest('t4d-ticket'), '2026-12-02 10:15:00+00', '2026-12-02 11:45:00+00', t_now));
  perform _r1_meet_tests.assert('T4-D service_role: arm_ticket answers not_found',
    res = jsonb_build_object('status', 'not_found'), res::text);
  res := _r1_meet_tests.runs_as('service_role', 'T4-D r1_meet_claim_ticket', format(
    'select screening_v2.r1_meet_claim_ticket(%L, %L::timestamptz)', _r1_meet_tests.digest('t4d-ticket'), t_now));
  perform _r1_meet_tests.assert('T4-D service_role: claim_ticket answers ticket_unknown',
    res = jsonb_build_object('status', 'ticket_unknown'), res::text);
  res := _r1_meet_tests.runs_as('service_role', 'T4-D r1_meet_record_receipt', format(
    'select screening_v2.r1_meet_record_receipt(%L, %L, %L, null, false, null, null, %L::timestamptz)',
    'recall', 'msg_t4d-privilege', 'bot.done', t_now));
  perform _r1_meet_tests.assert('T4-D service_role: record_receipt answers inserted',
    res ->> 'status' = 'inserted', res::text);
  res := _r1_meet_tests.runs_as('service_role', 'T4-D r1_meet_prune_receipts', format(
    'select screening_v2.r1_meet_prune_receipts(%L::timestamptz, 10, %L::timestamptz)',
    '2025-01-01 00:00:00+00', '2026-01-01 00:00:00+00'));
  perform _r1_meet_tests.assert('T4-D service_role: prune_receipts answers ok',
    res ->> 'status' = 'ok', res::text);
  res := _r1_meet_tests.runs_as('service_role', 'T4-D r1_meet_prune_bookings', format(
    'select screening_v2.r1_meet_prune_bookings(%L::timestamptz, 10, %L::timestamptz)',
    '2025-01-01 00:00:00+00', '2026-01-01 00:00:00+00'));
  perform _r1_meet_tests.assert('T4-D service_role: prune_bookings answers ok',
    res ->> 'status' = 'ok', res::text);
  perform _r1_meet_tests.assert('T4-D the service_role calls left nothing behind (rolled back)',
    not exists (select 1 from screening_v2.r1_meet_receipts x where x.dedupe_key in ('msg_t4d-privilege'))
    and not exists (select 1 from screening_v2.r1_meet_bookings x
                     where x.ashby_interview_event_id = _r1_meet_tests.id(20, 390)));
end;
$$;

do $$
declare
  n integer;
begin
  select count(*) into n from _r1_meet_tests.passed;
  raise notice 'R1 MEET: % assertions passed', n;
end;
$$;

rollback;
