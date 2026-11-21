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

do $$
declare
  n integer;
begin
  select count(*) into n from _r1_meet_tests.passed;
  raise notice 'R1 MEET: % assertions passed', n;
end;
$$;

rollback;
