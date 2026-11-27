-- 0144 (M035 S12): the public R1 booking page's on-the-spot Ashby import, its read-only local match
-- lookup and the fences that keep such an import away from resume ingestion, the Ashby profile
-- step and the phone lane, run for real.
--
-- Executed by scripts/test-r1-meet-public-import.sh inside scripts/supabase-test.sh's local
-- Supabase stack, against the complete schema (every migration applied; never stubs). Everything
-- runs in ONE transaction that is rolled back at the end, so the fixtures, the claim stamps and the
-- two guard triggers section D switches off for a moment (and back on, asserted) never outlive the
-- run. Any failed assertion raises and stops psql (ON_ERROR_STOP=1).
--
-- Sections:
--   A catalog posture: the intake CHECK (its three values, validated, the default unchanged, the
--     column comment), the six 0144 functions (signature, security definer, the pinned
--     search_path, language, volatility, return type, no EXECUTE for anon, authenticated or
--     PUBLIC, service_role on the two RPCs and the claim), the three triggers (enabled, BEFORE,
--     row level, the right table and event, the WHEN clause of the lock only) and the view's
--     security_invoker option.
--   B the intake lock: an r1_public_booking link never changes its intake and no link becomes one;
--     the 0130 stamp resume_parsing -> phone_parsing and every other column still update.
--   C the two insert guards (the exact closed messages), also reached through
--     advance_ashby_ingestion, apply_ashby_candidate_profile and ensure_ashby_phone_engagement.
--     Recorded outcome for ensure: it RAISES P0001 (the engagement guard). With a bound link and
--     no engagement, the cycle-1 insert is the first write ensure makes (0130 section 4), before
--     any other gate, so the guard is the gate that fires; no engagement row is left either way.
--   D claim_ashby_profile_due: the 0130 arms A, B (both intakes) and C are still claimed
--     (regressions); an r1_public_booking import in the no-resume shape (B, imported WITHOUT a
--     number, so only the 0144 hunk excludes it) is never claimed while its resume_parsing twin
--     is; r1 links in the A and C shapes are never claimed either.
--   E v_ashby_application_impact and impact_application_rows leave the import out.
--   F r1_meet_public_local_rows: every invalid input, the matches, the per-link flags, the holds,
--     the order, the limit, the eight keys, no contact data in the answer, no write.
--   G r1_meet_public_import_application: every invalid field and their precedence, the accepted
--     boundaries, the link and the shell it writes (exactly), nothing else written, replays,
--     adoption, the holds over the Ashby person and their precedence, one R1 per Ashby person
--     (S12 fix round F3), the mapping, and the privileges (anon / authenticated refused,
--     service_role runs both RPCs).
--   H the Christy phone funnel (v_funnel_candidate, and the funnel_stage_daily rollup built from
--     it) leaves an import out and keeps every other candidate (S12 fix round F1).
--   I r1_meet_public_person_r1_check: the book path's one-R1-per-person lookup (S12 fix round
--     F3): every invalid input, application_unknown, r1_completed only for the person's OTHER
--     candidates, the exact answers, no write, and the privileges.
--
-- The clock is pinned: p_now = 2026-12-01 04:00 UTC everywhere; nothing asserts on now(). Fixture
-- ids live in 7f144000-0000-4000-8000-<kind:4><n:8> (unused elsewhere): 1 auth users, 2 roles,
-- 10 candidates, 13 job mappings, 14 DSAR requests, 15 phone engagements, 16 ingestions, 22 Ashby
-- applications, 26 Ashby candidates, 27 interview rounds. Job ids are mpi-job-<n>, stage ids mpi-stage-<n>, candidate
-- names "meet public import assert <n>", emails <n>@example.test, numbers are built at run time.
-- The claim fixtures are created 2020-01-01, so they sort first among never-checked links and
-- leftover rows cannot crowd them out of the 50-row claim. No real data.

begin;

create schema _r1_mpi_tests;
create table _r1_mpi_tests.passed (label text primary key);

create function _r1_mpi_tests.assert(p_label text, p_ok boolean, p_detail text default '')
returns void language plpgsql as $$
begin
  -- `is not true`, not `not`: a NULL condition must fail, never pass silently.
  if p_ok is not true then
    raise exception 'R1 MPI FAIL: % (%)', p_label, p_detail;
  end if;
  insert into _r1_mpi_tests.passed (label) values (p_label) on conflict do nothing;
  raise notice 'R1 MPI PASS: %', p_label;
end;
$$;

-- Runs a statement that MUST raise the given SQLSTATE; any other outcome fails the assertion.
create function _r1_mpi_tests.raises(p_label text, p_sql text, p_sqlstate text)
returns void language plpgsql as $$
declare
  v_state text;
begin
  begin
    execute p_sql;
  exception when others then
    get stacked diagnostics v_state = returned_sqlstate;
    perform _r1_mpi_tests.assert(p_label || ' (rejected with ' || p_sqlstate || ')',
      v_state = p_sqlstate, 'got ' || v_state);
    return;
  end;
  raise exception 'R1 MPI FAIL: % (statement was accepted)', p_label;
end;
$$;

-- As raises, and the error message must be exactly p_message (one of the closed 0144 texts).
create function _r1_mpi_tests.raises_with(p_label text, p_sql text, p_sqlstate text, p_message text)
returns void language plpgsql as $$
declare
  v_state text;
  v_msg text;
begin
  begin
    execute p_sql;
  exception when others then
    get stacked diagnostics v_state = returned_sqlstate, v_msg = message_text;
    perform _r1_mpi_tests.assert(p_label || ' (rejected with ' || p_sqlstate || ' and the closed message)',
      v_state = p_sqlstate and v_msg = p_message,
      'got ' || coalesce(v_state, 'null') || ': ' || coalesce(v_msg, 'null'));
    return;
  end;
  raise exception 'R1 MPI FAIL: % (statement was accepted)', p_label;
end;
$$;

-- Runs a statement AS p_role that MUST raise the given SQLSTATE. The role switch is local to the
-- inner block: its subtransaction is always rolled back (an accepted statement raises a sentinel
-- to force that), which restores the role and undoes any write before the verdict. A switch that
-- did not happen fails loudly instead of passing on the switch's own 42501.
create function _r1_mpi_tests.raises_as(p_role text, p_label text, p_sql text, p_sqlstate text)
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
    raise exception 'r1 mpi raises_as sentinel' using errcode = 'P0001';
  exception when others then
    get stacked diagnostics v_state = returned_sqlstate;
  end;
  if not v_switched then
    raise exception 'R1 MPI FAIL: % (could not switch to role %: %)', p_label, p_role, v_state;
  end if;
  if v_accepted then
    raise exception 'R1 MPI FAIL: % as % (statement was accepted)', p_label, p_role;
  end if;
  perform _r1_mpi_tests.assert(p_label || ' as ' || p_role || ' (rejected with ' || p_sqlstate || ')',
    v_state = p_sqlstate and current_user = v_before,
    'got ' || coalesce(v_state, 'null') || ' as ' || current_user);
end;
$$;

-- Runs a statement AS p_role that MUST succeed, and returns its jsonb answer. As in raises_as, the
-- inner block always rolls back (a sentinel after the statement), so the role is restored and
-- whatever the statement wrote is undone.
create function _r1_mpi_tests.runs_as(p_role text, p_label text, p_sql text)
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
    raise exception 'r1 mpi runs_as sentinel' using errcode = 'P0001';
  exception when others then
    get stacked diagnostics v_state = returned_sqlstate, v_msg = message_text;
  end;
  if not v_switched then
    raise exception 'R1 MPI FAIL: % (could not switch to role %: %)', p_label, p_role, v_msg;
  end if;
  perform _r1_mpi_tests.assert(p_label || ' runs as ' || p_role,
    v_done and v_res is not null and current_user = v_before,
    coalesce(v_state, 'null') || ': ' || coalesce(v_msg, 'null'));
  return v_res;
end;
$$;

-- Fixture ids: 7f144000-0000-4000-8000-<kind:4><n:8>.
--   1 auth users, 2 roles, 10 candidates, 13 job mappings, 14 DSAR requests,
--   15 phone engagements, 16 ingestions, 22 Ashby applications, 26 Ashby candidates,
--   27 interview rounds.
create function _r1_mpi_tests.id(p_kind integer, p_n integer) returns uuid
language sql immutable as $$
  select ('7f144000-0000-4000-8000-' || lpad(p_kind::text, 4, '0') || lpad(p_n::text, 8, '0'))::uuid
$$;

-- The pinned clock.
create function _r1_mpi_tests.t0() returns timestamptz
language sql immutable as $$ select timestamptz '2026-12-01 04:00:00+00' $$;

-- Fixture contact data, built at run time (never a literal number).
create function _r1_mpi_tests.phone(p_n integer) returns text
language sql immutable as $$ select '+9198' || lpad(p_n::text, 8, '0') $$;
create function _r1_mpi_tests.email(p_n integer) returns text
language sql immutable as $$ select p_n::text || '@example.test' $$;
create function _r1_mpi_tests.name(p_n integer) returns text
language sql immutable as $$ select 'meet public import assert ' || p_n::text $$;

-- The three closed 0144 messages.
create function _r1_mpi_tests.msg(p_which text) returns text
language sql immutable as $$
  select case p_which
    when 'lock' then 'r1_public_booking: the intake type of a public booking import never changes'
    when 'engagement' then 'r1_public_booking: a public booking import never gets a phone engagement'
    when 'ingestion' then 'r1_public_booking: a public booking import never gets a resume ingestion'
  end
$$;

-- The keys of a JSON object; the keys whose value is not JSON null; set equality.
create function _r1_mpi_tests.keys(p jsonb) returns text[]
language sql immutable as $$ select array(select jsonb_object_keys(p)) $$;
create function _r1_mpi_tests.set_cols(p jsonb) returns text[]
language sql immutable as $$ select array(select e.k from jsonb_each(p) e(k, val) where e.val <> 'null'::jsonb) $$;
create function _r1_mpi_tests.same_set(p_a text[], p_b text[]) returns boolean
language sql immutable as $$
  select p_a @> p_b and p_a <@ p_b and cardinality(p_a) = cardinality(p_b)
$$;

-- The row counts that a lookup, a refusal or a replay may never change.
create function _r1_mpi_tests.counts() returns jsonb
language sql as $$
  select jsonb_build_object(
    'candidates', (select count(*) from screening_v2.candidates),
    'links', (select count(*) from screening_v2.ashby_application_links),
    'ingestions', (select count(*) from screening_v2.ashby_resume_ingestions),
    'engagements', (select count(*) from screening_v2.phone_engagements),
    'operations', (select count(*) from screening_v2.ashby_operations),
    'jobs', (select count(*) from screening_v2.job_queue),
    'sessions', (select count(*) from screening_v2.call_sessions),
    'invites', (select count(*) from screening_v2.candidate_invites),
    'consents', (select count(*) from screening_v2.consent_records),
    'rounds', (select count(*) from screening_v2.interview_rounds),
    'dsar', (select count(*) from screening_v2.data_subject_requests),
    'erased', (select count(*) from screening_v2.ashby_erased_application_links),
    'audit', (select count(*) from screening_v2.audit_events))
$$;

-- A candidate row (role 1 unless given), with an optional email and number; phone_valid false.
create function _r1_mpi_tests.cand(p_n integer, p_email text default null, p_phone text default null,
                                   p_role uuid default null)
returns uuid language plpgsql as $$
begin
  insert into screening_v2.candidates (id, role_id, name, email, phone_e164)
  values (_r1_mpi_tests.id(10, p_n), coalesce(p_role, _r1_mpi_tests.id(2, 1)), _r1_mpi_tests.name(p_n),
          p_email, p_phone);
  return _r1_mpi_tests.id(10, p_n);
end;
$$;

-- An Ashby link inserted directly: application id(22, n) of Ashby candidate id(26, p_person or n),
-- on p_mapping's job (none without a mapping), at stage mpi-stage-1.
create function _r1_mpi_tests.link(p_n integer, p_mapping uuid, p_candidate uuid,
                                   p_intake text default 'resume_parsing', p_handle text default null,
                                   p_created timestamptz default '2026-12-01 04:00:00+00',
                                   p_terminal text default null, p_person integer default null,
                                   p_terminal_reason text default null)
returns uuid language plpgsql as $$
declare
  v_id uuid;
begin
  insert into screening_v2.ashby_application_links
    (external_application_id, external_candidate_id, external_job_id, external_stage_id,
     external_resume_file_handle, job_mapping_id, candidate_id, intake_type, terminal_state,
     terminal_reason, created_at, updated_at)
  values (_r1_mpi_tests.id(22, p_n)::text, _r1_mpi_tests.id(26, coalesce(p_person, p_n))::text,
          (select m.external_job_id from screening_v2.ashby_job_mappings m where m.id = p_mapping),
          'mpi-stage-1', p_handle, p_mapping, p_candidate, p_intake, p_terminal, p_terminal_reason,
          p_created, p_created)
  returning id into v_id;
  return v_id;
end;
$$;

-- The link of application id(22, n).
create function _r1_mpi_tests.link_of(p_n integer) returns uuid
language sql as $$
  select l.id from screening_v2.ashby_application_links l
   where l.provider = 'ashby' and l.external_application_id = _r1_mpi_tests.id(22, p_n)::text
$$;

-- The import RPC for application id(22, n) of Ashby candidate id(26, n), at stage mpi-stage-1.
create function _r1_mpi_tests.import_app(p_n integer, p_job text default 'mpi-job-1',
                                         p_name text default null, p_email text default null,
                                         p_phone text default null,
                                         p_now timestamptz default '2026-12-01 04:00:00+00')
returns jsonb language sql as $$
  select screening_v2.r1_meet_public_import_application(
    _r1_mpi_tests.id(22, p_n)::text, _r1_mpi_tests.id(26, p_n)::text, p_job, 'mpi-stage-1',
    p_name, p_email, p_phone, p_now)
$$;

-- A data-subject request (id(14, k)) on a candidate, valid for every type and status.
create function _r1_mpi_tests.dsar(p_k integer, p_candidate uuid, p_type text, p_status text)
returns uuid language plpgsql as $$
begin
  insert into screening_v2.data_subject_requests
    (id, candidate_id, request_type, request_status, requested_by, fulfilled_at, rejection_reason)
  values (_r1_mpi_tests.id(14, p_k), p_candidate, p_type, p_status, _r1_mpi_tests.id(1, 1),
          case when p_status = 'fulfilled' then _r1_mpi_tests.t0() end,
          case when p_status = 'rejected' then 'mpi fixture' end);
  return _r1_mpi_tests.id(14, p_k);
end;
$$;

-- A sales_r1 interview round (id(27, k)) of a candidate, in a status, with p_counted counted
-- attempts. Only the columns the 0144 rule reads matter; the link digest is built at run time.
create function _r1_mpi_tests.sales_round(p_k integer, p_candidate uuid, p_status text, p_counted integer default 0)
returns uuid language plpgsql as $$
begin
  insert into screening_v2.interview_rounds
    (id, candidate_id, role_id, link_token_digest, expires_at, created_by, status, attempts_counted)
  values (_r1_mpi_tests.id(27, p_k), p_candidate, _r1_mpi_tests.id(2, 1),
          encode(sha256(convert_to('r1-mpi-round-' || p_k::text, 'UTF8')), 'hex'),
          timestamptz '2099-01-01 00:00:00+00', _r1_mpi_tests.id(1, 1), p_status, p_counted);
  return _r1_mpi_tests.id(27, p_k);
end;
$$;

-- The book path's person check for candidate id(10, c) and application id(22, a).
create function _r1_mpi_tests.person(p_c integer, p_a integer) returns jsonb
language sql as $$
  select screening_v2.r1_meet_public_person_r1_check(_r1_mpi_tests.id(10, p_c), _r1_mpi_tests.id(22, p_a)::text)
$$;

-- One expected row of r1_meet_public_local_rows (application p_app of Ashby candidate id(26, p_app);
-- p_app null is the fail-closed no-link row).
create function _r1_mpi_tests.local_row(p_cand integer, p_by text, p_app integer, p_terminal boolean,
                                        p_enabled boolean, p_dsar boolean default false,
                                        p_blocked boolean default false)
returns jsonb language sql immutable as $$
  select jsonb_build_object(
    'candidate_id', _r1_mpi_tests.id(10, p_cand)::text,
    'matched_by', p_by,
    'application_id', case when p_app is null then null else _r1_mpi_tests.id(22, p_app)::text end,
    'ashby_candidate_id', case when p_app is null then null else _r1_mpi_tests.id(26, p_app)::text end,
    'link_terminal', p_terminal,
    'mapping_enabled', p_enabled,
    'dsar_hold', p_dsar,
    'decision_blocked', p_blocked)
$$;

-- The ok answer of r1_meet_public_local_rows for these rows, in order.
create function _r1_mpi_tests.ok_rows(variadic p_rows jsonb[]) returns jsonb
language sql immutable as $$
  select jsonb_build_object('status', 'ok', 'rows', coalesce(jsonb_agg(r order by o), '[]'::jsonb))
    from unnest(p_rows) with ordinality as x(r, o)
$$;

-- Setup: two auth users (mapping owners), two roles, and the job mappings:
--   M1 mpi-job-1 enabled phone_primary (role 1, owner 1)   M2 mpi-job-2 enabled browser_primary (role 2, owner 2)
--   M3 mpi-job-3 paused                                    M4 mpi-job-4 drift
--   M5 mpi-job-5 archived (paused, archived_at set)
--   M6 mpi-job-6 archived and M7 mpi-job-6 enabled: one live mapping per job (0109), so the job's
--   import resolves to M7.
do $$
declare
  k_t0 constant timestamptz := _r1_mpi_tests.t0();
begin
  insert into auth.users (id, email)
  values (_r1_mpi_tests.id(1, 1), 'r1-mpi-assert-1@example.test'),
         (_r1_mpi_tests.id(1, 2), 'r1-mpi-assert-2@example.test')
  on conflict (id) do nothing;
  insert into screening_v2.roles (id, title)
  values (_r1_mpi_tests.id(2, 1), 'R1 MPI assertion role 1'),
         (_r1_mpi_tests.id(2, 2), 'R1 MPI assertion role 2');
  insert into screening_v2.ashby_job_mappings
    (id, external_job_id, role_id, ai_screening_stage_id, ta_screening_stage_id, owner_id, status,
     screening_mode, archived_at)
  values
    (_r1_mpi_tests.id(13, 1), 'mpi-job-1', _r1_mpi_tests.id(2, 1), 'mpi-stage-1', 'mpi-stage-2',
     _r1_mpi_tests.id(1, 1), 'enabled', 'phone_primary', null),
    (_r1_mpi_tests.id(13, 2), 'mpi-job-2', _r1_mpi_tests.id(2, 2), 'mpi-stage-1', 'mpi-stage-2',
     _r1_mpi_tests.id(1, 2), 'enabled', 'browser_primary', null),
    (_r1_mpi_tests.id(13, 3), 'mpi-job-3', _r1_mpi_tests.id(2, 1), 'mpi-stage-1', 'mpi-stage-2',
     _r1_mpi_tests.id(1, 1), 'paused', 'phone_primary', null),
    (_r1_mpi_tests.id(13, 4), 'mpi-job-4', _r1_mpi_tests.id(2, 1), 'mpi-stage-1', 'mpi-stage-2',
     _r1_mpi_tests.id(1, 1), 'drift', 'phone_primary', null),
    (_r1_mpi_tests.id(13, 5), 'mpi-job-5', _r1_mpi_tests.id(2, 1), 'mpi-stage-1', 'mpi-stage-2',
     _r1_mpi_tests.id(1, 1), 'paused', 'phone_primary', k_t0 - interval '1 day'),
    (_r1_mpi_tests.id(13, 6), 'mpi-job-6', _r1_mpi_tests.id(2, 1), 'mpi-stage-1', 'mpi-stage-2',
     _r1_mpi_tests.id(1, 1), 'paused', 'phone_primary', k_t0 - interval '1 day'),
    (_r1_mpi_tests.id(13, 7), 'mpi-job-6', _r1_mpi_tests.id(2, 1), 'mpi-stage-1', 'mpi-stage-2',
     _r1_mpi_tests.id(1, 1), 'enabled', 'phone_primary', null);
  perform _r1_mpi_tests.assert('setup: seven fixture mappings, M1 and M2 and M7 enabled',
    (select count(*) = 7 and count(*) filter (where m.status = 'enabled') = 3
       from screening_v2.ashby_job_mappings m where m.external_job_id like 'mpi-job-%'));
end;
$$;

-- =================================================================================================
-- A. Catalog posture.
-- =================================================================================================
do $$
declare
  k_links constant regclass := 'screening_v2.ashby_application_links'::regclass;
  v_attnum integer;
  v_text text;
  v_fn record;
  v_proc record;
  v_tg record;
begin
  select a.attnum into v_attnum
    from pg_attribute a
   where a.attrelid = k_links and a.attname = 'intake_type' and not a.attisdropped;

  -- The CHECK: validated, exactly the three values in the 0144 order.
  select pg_get_constraintdef(c.oid) into v_text
    from pg_constraint c
   where c.conrelid = k_links and c.conname = 'chk_ashby_application_links_intake_type'
     and c.contype = 'c' and c.convalidated;
  perform _r1_mpi_tests.assert('A the intake CHECK is validated and lists exactly the three intakes',
    array(select m[1] from regexp_matches(coalesce(v_text, ''), '''([a-z0-9_]+)''', 'g') as m)
      = array['resume_parsing', 'phone_parsing', 'r1_public_booking'],
    coalesce(v_text, 'null'));
  perform _r1_mpi_tests.assert('A no other CHECK on the links table names intake_type',
    (select count(*) from pg_constraint c
      where c.conrelid = k_links and c.contype = 'c'
        and pg_get_constraintdef(c.oid) like '%intake_type%') = 1);

  select pg_get_expr(d.adbin, d.adrelid) into v_text
    from pg_attrdef d where d.adrelid = k_links and d.adnum = v_attnum;
  perform _r1_mpi_tests.assert('A the intake default is still resume_parsing',
    v_text = '''resume_parsing''::text', coalesce(v_text, 'null'));

  v_text := col_description(k_links, v_attnum);
  perform _r1_mpi_tests.assert('A the intake column comment keeps the 0130 text and names r1_public_booking',
    position('0130 (M017, ADR-0018)' in v_text) = 1
    and position('0144 (M035 S12): r1_public_booking' in v_text) > 0, coalesce(v_text, 'null'));

  insert into screening_v2.ashby_application_links (external_application_id, intake_type)
  values (_r1_mpi_tests.id(22, 1)::text, 'resume_parsing'),
         (_r1_mpi_tests.id(22, 2)::text, 'phone_parsing'),
         (_r1_mpi_tests.id(22, 3)::text, 'r1_public_booking');
  perform _r1_mpi_tests.assert('A the intake CHECK accepts resume_parsing, phone_parsing and r1_public_booking',
    array(select l.intake_type from screening_v2.ashby_application_links l
           where l.external_application_id in (_r1_mpi_tests.id(22, 1)::text, _r1_mpi_tests.id(22, 2)::text,
                                                _r1_mpi_tests.id(22, 3)::text)
           order by l.external_application_id)
      = array['resume_parsing', 'phone_parsing', 'r1_public_booking']);
  perform _r1_mpi_tests.raises('A the intake CHECK refuses any other value',
    format('insert into screening_v2.ashby_application_links (external_application_id, intake_type) values (%L, %L)',
           _r1_mpi_tests.id(22, 4)::text, 'other'), '23514');
  perform _r1_mpi_tests.raises('A intake_type stays NOT NULL',
    format('insert into screening_v2.ashby_application_links (external_application_id, intake_type) values (%L, null)',
           _r1_mpi_tests.id(22, 5)::text), '23502');

  -- The seven functions 0144 declares (four RPC-level, three trigger functions).
  for v_fn in
    select *
      from (values
        ('claim_ashby_profile_due',
         'screening_v2.claim_ashby_profile_due(integer,integer,integer,integer,timestamptz)',
         true, 'v', 'sql', 'uuid', 0),
        ('r1_meet_public_local_rows',
         'screening_v2.r1_meet_public_local_rows(text,text,integer)',
         true, 's', 'plpgsql', 'jsonb', 1),
        ('r1_meet_public_import_application',
         'screening_v2.r1_meet_public_import_application(text,text,text,text,text,text,text,timestamptz)',
         true, 'v', 'plpgsql', 'jsonb', 1),
        ('r1_meet_public_person_r1_check',
         'screening_v2.r1_meet_public_person_r1_check(uuid,text)',
         true, 's', 'plpgsql', 'jsonb', 0),
        ('reject_r1_public_booking_intake_change',
         'screening_v2.reject_r1_public_booking_intake_change()', false, 'v', 'plpgsql', 'trigger', 0),
        ('reject_r1_public_booking_engagement',
         'screening_v2.reject_r1_public_booking_engagement()', false, 'v', 'plpgsql', 'trigger', 0),
        ('reject_r1_public_booking_ingestion',
         'screening_v2.reject_r1_public_booking_ingestion()', false, 'v', 'plpgsql', 'trigger', 0)
      ) as f(fn, sig, rpc, vol, lang, ret, n_defaults)
  loop
    select p.oid, p.prosecdef, p.proconfig, p.provolatile::text as vol, l.lanname,
           format_type(p.prorettype, null) as ret, p.pronargdefaults::integer as n_defaults, p.proacl
      into v_proc
      from pg_proc p
      join pg_language l on l.oid = p.prolang
     where p.oid = to_regprocedure(v_fn.sig);
    perform _r1_mpi_tests.assert('A ' || v_fn.fn || ' exists with its exact signature',
      v_proc.oid is not null, v_fn.sig);
    perform _r1_mpi_tests.assert('A ' || v_fn.fn || ' is the only function of its name',
      (select count(*) from pg_proc p join pg_namespace n on n.oid = p.pronamespace
        where n.nspname = 'screening_v2' and p.proname = v_fn.fn) = 1);
    perform _r1_mpi_tests.assert('A ' || v_fn.fn || ' is security definer with search_path pg_catalog, screening_v2',
      v_proc.prosecdef and v_proc.proconfig @> array['search_path=pg_catalog, screening_v2'],
      coalesce(v_proc.proconfig::text, 'null'));
    perform _r1_mpi_tests.assert('A ' || v_fn.fn || ' is ' || v_fn.lang || ', volatility ' || v_fn.vol
                                 || ', returns ' || v_fn.ret || ' with ' || v_fn.n_defaults || ' default(s)',
      v_proc.lanname = v_fn.lang and v_proc.vol = v_fn.vol and v_proc.ret = v_fn.ret
      and v_proc.n_defaults = v_fn.n_defaults,
      v_proc.lanname || ' ' || v_proc.vol || ' ' || v_proc.ret || ' ' || v_proc.n_defaults);
    perform _r1_mpi_tests.assert('A anon and authenticated may not execute ' || v_fn.fn,
      not has_function_privilege('anon', v_proc.oid, 'execute')
      and not has_function_privilege('authenticated', v_proc.oid, 'execute'));
    -- has_function_privilege has no PUBLIC role: read the ACL itself (grantee 0 is PUBLIC).
    perform _r1_mpi_tests.assert('A PUBLIC holds no EXECUTE on ' || v_fn.fn,
      v_proc.proacl is not null
      and not exists (select 1 from aclexplode(v_proc.proacl) a
                       where a.grantee = 0 and a.privilege_type = 'EXECUTE'));
    if v_fn.rpc then
      perform _r1_mpi_tests.assert('A service_role may execute ' || v_fn.fn,
        has_function_privilege('service_role', v_proc.oid, 'execute'));
    end if;
  end loop;

  -- The three triggers: enabled, BEFORE, row level, on the right table and for the right event.
  for v_tg in
    select *
      from (values
        ('trg_ashby_application_links_intake_locked', 'screening_v2.ashby_application_links',
         'screening_v2.reject_r1_public_booking_intake_change()', 16, true),
        ('trg_phone_engagements_r1_public_booking', 'screening_v2.phone_engagements',
         'screening_v2.reject_r1_public_booking_engagement()', 4, false),
        ('trg_ashby_resume_ingestions_r1_public_booking', 'screening_v2.ashby_resume_ingestions',
         'screening_v2.reject_r1_public_booking_ingestion()', 4, false)
      ) as t(trigger_name, table_name, fn, event_bits, has_when)
  loop
    -- tgtype bits: 1 row, 2 before, 4 insert, 8 delete, 16 update, 32 truncate, 64 instead.
    perform _r1_mpi_tests.assert('A ' || v_tg.trigger_name || ' is an enabled BEFORE '
                                 || case v_tg.event_bits when 16 then 'UPDATE' else 'INSERT' end
                                 || ' row trigger on ' || v_tg.table_name || ' and nothing else',
      exists (select 1 from pg_trigger t
               where t.tgname = v_tg.trigger_name and t.tgrelid = v_tg.table_name::regclass
                 and not t.tgisinternal and t.tgenabled = 'O'
                 and t.tgfoid = v_tg.fn::regprocedure
                 and (t.tgtype::integer & 1) = 1 and (t.tgtype::integer & 2) = 2
                 and (t.tgtype::integer & 64) = 0
                 and (t.tgtype::integer & 60) = v_tg.event_bits
                 and (t.tgqual is not null) = v_tg.has_when));
  end loop;
  perform _r1_mpi_tests.assert('A the intake lock fires only for an update of intake_type',
    (select t.tgattr::text from pg_trigger t
      where t.tgname = 'trg_ashby_application_links_intake_locked' and t.tgrelid = k_links) = v_attnum::text);
  perform _r1_mpi_tests.assert('A the three 0144 trigger functions back exactly these three triggers',
    (select count(*) from pg_trigger t
      where t.tgfoid in ('screening_v2.reject_r1_public_booking_intake_change()'::regprocedure,
                         'screening_v2.reject_r1_public_booking_engagement()'::regprocedure,
                         'screening_v2.reject_r1_public_booking_ingestion()'::regprocedure)) = 3);

  perform _r1_mpi_tests.assert('A v_ashby_application_impact still runs as its caller (security_invoker)',
    (select c.reloptions from pg_class c
      where c.oid = 'screening_v2.v_ashby_application_impact'::regclass) @> array['security_invoker=true']);
  perform _r1_mpi_tests.assert('A the view comment names the 0144 change',
    position('0144 (M035 S12)' in
             obj_description('screening_v2.v_ashby_application_impact'::regclass, 'pg_class')) > 0);
  perform _r1_mpi_tests.assert('A v_funnel_candidate still runs as its caller (security_invoker)',
    (select c.reloptions from pg_class c
      where c.oid = 'screening_v2.v_funnel_candidate'::regclass) @> array['security_invoker=true']);
  perform _r1_mpi_tests.assert('A the funnel view comment keeps the 0122 text and names the 0144 change',
    position('One row per candidate across the whole funnel' in
             obj_description('screening_v2.v_funnel_candidate'::regclass, 'pg_class')) = 1
    and position('0144 (M035 S12)' in
                 obj_description('screening_v2.v_funnel_candidate'::regclass, 'pg_class')) > 0);
  perform _r1_mpi_tests.assert('A the funnel view is still service-role only',
    has_table_privilege('service_role', 'screening_v2.v_funnel_candidate', 'select')
    and not has_table_privilege('anon', 'screening_v2.v_funnel_candidate', 'select')
    and not has_table_privilege('authenticated', 'screening_v2.v_funnel_candidate', 'select'));
end;
$$;

-- =================================================================================================
-- B. The intake lock: an r1_public_booking link never changes its intake, and no link becomes one.
-- =================================================================================================
do $$
declare
  k_t0 constant timestamptz := _r1_mpi_tests.t0();
  k_m1 constant uuid := _r1_mpi_tests.id(13, 1);
  v jsonb;
  v_r1 uuid;
  v_rp uuid;
  v_pp uuid;
  v_row screening_v2.ashby_application_links%rowtype;
begin
  v := _r1_mpi_tests.import_app(10);
  perform _r1_mpi_tests.assert('B setup: an on-the-spot import', v ->> 'status' = 'imported', v::text);
  v_r1 := (v ->> 'application_link_id')::uuid;
  v_rp := _r1_mpi_tests.link(11, k_m1, _r1_mpi_tests.cand(11));
  v_pp := _r1_mpi_tests.link(12, k_m1, _r1_mpi_tests.cand(12), 'phone_parsing');

  perform _r1_mpi_tests.raises_with('B an r1_public_booking link never becomes phone_parsing',
    format('update screening_v2.ashby_application_links set intake_type = %L where id = %L::uuid',
           'phone_parsing', v_r1), 'P0001', _r1_mpi_tests.msg('lock'));
  perform _r1_mpi_tests.raises_with('B an r1_public_booking link never becomes resume_parsing',
    format('update screening_v2.ashby_application_links set intake_type = %L where id = %L::uuid',
           'resume_parsing', v_r1), 'P0001', _r1_mpi_tests.msg('lock'));
  perform _r1_mpi_tests.raises_with('B a resume_parsing link never becomes r1_public_booking',
    format('update screening_v2.ashby_application_links set intake_type = %L where id = %L::uuid',
           'r1_public_booking', v_rp), 'P0001', _r1_mpi_tests.msg('lock'));
  perform _r1_mpi_tests.raises_with('B a phone_parsing link never becomes r1_public_booking',
    format('update screening_v2.ashby_application_links set intake_type = %L where id = %L::uuid',
           'r1_public_booking', v_pp), 'P0001', _r1_mpi_tests.msg('lock'));
  perform _r1_mpi_tests.raises_with('B a bulk update that would change an r1_public_booking link is refused whole',
    format('update screening_v2.ashby_application_links set intake_type = %L where id in (%L::uuid, %L::uuid)',
           'phone_parsing', v_rp, v_r1), 'P0001', _r1_mpi_tests.msg('lock'));
  perform _r1_mpi_tests.assert('B the refused updates changed no intake',
    (select l.intake_type from screening_v2.ashby_application_links l where l.id = v_r1) = 'r1_public_booking'
    and (select l.intake_type from screening_v2.ashby_application_links l where l.id = v_rp) = 'resume_parsing'
    and (select l.intake_type from screening_v2.ashby_application_links l where l.id = v_pp) = 'phone_parsing');

  -- The 0130 stamp (apply_ashby_candidate_profile step 9) still works on every other link.
  update screening_v2.ashby_application_links set intake_type = 'phone_parsing', updated_at = k_t0
   where id = v_rp;
  perform _r1_mpi_tests.assert('B resume_parsing -> phone_parsing still works',
    (select l.intake_type from screening_v2.ashby_application_links l where l.id = v_rp) = 'phone_parsing');

  update screening_v2.ashby_application_links
     set profile_outcome = 'not_applicable', terminal_state = 'withdrawn', terminal_reason = 'mpi_fixture',
         updated_at = k_t0 + interval '1 hour'
   where id = v_r1;
  select * into v_row from screening_v2.ashby_application_links l where l.id = v_r1;
  perform _r1_mpi_tests.assert('B every other column of an r1_public_booking link still updates',
    v_row.profile_outcome = 'not_applicable' and v_row.terminal_state = 'withdrawn'
    and v_row.terminal_reason = 'mpi_fixture' and v_row.updated_at = k_t0 + interval '1 hour'
    and v_row.intake_type = 'r1_public_booking', to_jsonb(v_row)::text);

  update screening_v2.ashby_application_links set intake_type = 'r1_public_booking' where id = v_r1;
  perform _r1_mpi_tests.assert('B writing the same intake again is no change (the WHEN clause lets it through)',
    (select l.intake_type from screening_v2.ashby_application_links l where l.id = v_r1) = 'r1_public_booking');
end;
$$;

-- =================================================================================================
-- C. The two insert guards, directly and through the 0084 / 0130 writers.
-- =================================================================================================
do $$
declare
  k_t0 constant timestamptz := _r1_mpi_tests.t0();
  k_m1 constant uuid := _r1_mpi_tests.id(13, 1);
  v jsonb;
  v_r1 uuid;
  v_shell uuid;
  v_rp uuid;
  v_rp_cand uuid;
  v_pp uuid;
  v_pp_cand uuid;
  v_link_before jsonb;
  v_cand_before jsonb;
begin
  perform _r1_mpi_tests.assert('C the closed messages carry no id, no value and no placeholder',
    (select bool_and(m !~ '[0-9a-f]{8}-[0-9a-f]{4}-' and position('%' in m) = 0 and m !~ '[0-9]{3}')
       from unnest(array[_r1_mpi_tests.msg('lock'), _r1_mpi_tests.msg('engagement'),
                         _r1_mpi_tests.msg('ingestion')]) as x(m)));

  v := _r1_mpi_tests.import_app(20);
  perform _r1_mpi_tests.assert('C setup: an on-the-spot import without a number', v ->> 'status' = 'imported', v::text);
  v_r1 := (v ->> 'application_link_id')::uuid;
  v_shell := (v ->> 'candidate_id')::uuid;
  v_rp_cand := _r1_mpi_tests.cand(21);
  v_rp := _r1_mpi_tests.link(21, k_m1, v_rp_cand);
  v_pp_cand := _r1_mpi_tests.cand(22);
  v_pp := _r1_mpi_tests.link(22, k_m1, v_pp_cand, 'phone_parsing');

  perform _r1_mpi_tests.raises_with('C a phone engagement for an r1_public_booking link is refused',
    format('insert into screening_v2.phone_engagements (id, application_link_id, candidate_id, role_id) '
           'values (%L::uuid, %L::uuid, %L::uuid, %L::uuid)',
           _r1_mpi_tests.id(15, 20), v_r1, v_shell, _r1_mpi_tests.id(2, 1)),
    'P0001', _r1_mpi_tests.msg('engagement'));
  perform _r1_mpi_tests.raises_with('C a resume ingestion for an r1_public_booking link is refused',
    format('insert into screening_v2.ashby_resume_ingestions (id, application_link_id) values (%L::uuid, %L::uuid)',
           _r1_mpi_tests.id(16, 20), v_r1),
    'P0001', _r1_mpi_tests.msg('ingestion'));

  insert into screening_v2.phone_engagements (id, application_link_id, candidate_id, role_id)
  values (_r1_mpi_tests.id(15, 21), v_rp, v_rp_cand, _r1_mpi_tests.id(2, 1)),
         (_r1_mpi_tests.id(15, 22), v_pp, v_pp_cand, _r1_mpi_tests.id(2, 1));
  insert into screening_v2.ashby_resume_ingestions (id, application_link_id)
  values (_r1_mpi_tests.id(16, 21), v_rp),
         (_r1_mpi_tests.id(16, 22), v_pp);
  perform _r1_mpi_tests.assert('C a resume_parsing and a phone_parsing link still take an engagement and an ingestion',
    (select count(*) from screening_v2.phone_engagements e where e.application_link_id in (v_rp, v_pp)) = 2
    and (select count(*) from screening_v2.ashby_resume_ingestions i where i.application_link_id in (v_rp, v_pp)) = 2);

  -- advance_ashby_ingestion (0084) opens the row with an insert first: the guard refuses it.
  perform _r1_mpi_tests.raises_with('C advance_ashby_ingestion cannot open an ingestion for an r1_public_booking link',
    format('select screening_v2.advance_ashby_ingestion(%L::uuid, %L, null, null, null, null, %L::timestamptz)',
           v_r1, 'queued', k_t0),
    'P0001', _r1_mpi_tests.msg('ingestion'));

  -- apply_ashby_candidate_profile (0130 section 5) on an enabled phone_primary mapping: no handle and
  -- no ingestion, so step 9 stamps phone_parsing, which the intake lock refuses. Nothing changes.
  v_link_before := (select to_jsonb(l) from screening_v2.ashby_application_links l where l.id = v_r1);
  v_cand_before := (select to_jsonb(c) from screening_v2.candidates c where c.id = v_shell);
  perform _r1_mpi_tests.raises_with('C apply_ashby_candidate_profile cannot stamp an r1_public_booking link phone_parsing',
    format('select screening_v2.apply_ashby_candidate_profile(%L::uuid, %L, %L, %L, %L, %L, null, %L::timestamptz)',
           v_r1, 'phone_parsing', _r1_mpi_tests.name(20), _r1_mpi_tests.email(20), _r1_mpi_tests.phone(20),
           _r1_mpi_tests.phone(20), k_t0),
    'P0001', _r1_mpi_tests.msg('lock'));
  perform _r1_mpi_tests.assert('C the refused profile left the link and its shell exactly as they were',
    (select to_jsonb(l) from screening_v2.ashby_application_links l where l.id = v_r1) = v_link_before
    and (select to_jsonb(c) from screening_v2.candidates c where c.id = v_shell) = v_cand_before);

  -- ensure_ashby_phone_engagement (0130 section 4): the link is bound and has no engagement, so the
  -- cycle-1 insert is the first write ensure makes, before any other gate. Outcome: it RAISES.
  perform _r1_mpi_tests.raises_with('C ensure_ashby_phone_engagement cannot open a cycle for an r1_public_booking link',
    format('select screening_v2.ensure_ashby_phone_engagement(%L::uuid, %L::timestamptz)', v_r1, k_t0),
    'P0001', _r1_mpi_tests.msg('engagement'));
  perform _r1_mpi_tests.assert('C no engagement and no ingestion exist for the r1_public_booking link',
    not exists (select 1 from screening_v2.phone_engagements e
                 where e.application_link_id = v_r1 or e.candidate_id = v_shell)
    and not exists (select 1 from screening_v2.ashby_resume_ingestions i where i.application_link_id = v_r1));
  perform _r1_mpi_tests.assert('C the link and its shell are still unchanged after ensure',
    (select to_jsonb(l) from screening_v2.ashby_application_links l where l.id = v_r1) = v_link_before
    and (select to_jsonb(c) from screening_v2.candidates c where c.id = v_shell) = v_cand_before);
end;
$$;

-- =================================================================================================
-- D. claim_ashby_profile_due: the 0130 arms still claim; an r1_public_booking link never.
-- =================================================================================================
do $$
declare
  k_t0 constant timestamptz := _r1_mpi_tests.t0();
  k_old constant timestamptz := '2020-01-01 00:00:00+00';
  k_m1 constant uuid := _r1_mpi_tests.id(13, 1);
  v jsonb;
  v_c uuid;
  v_r1_b uuid;
  v_r1_b_shell uuid;
  v_r1_a uuid;
  v_r1_c uuid;
  v_twin uuid;
  v_due uuid[];
  v_claimed uuid[];
  v_drop constant text[] := array['id', 'external_application_id', 'external_candidate_id', 'candidate_id',
                                  'intake_type'];
begin
  -- Arm A: a ready resume link whose engagement has waited on phone_invalid.
  v_c := _r1_mpi_tests.cand(30);
  perform _r1_mpi_tests.link(30, k_m1, v_c, 'resume_parsing', 'mpi-handle-30', k_old);
  insert into screening_v2.ashby_resume_ingestions (id, application_link_id, state, created_at, updated_at)
  values (_r1_mpi_tests.id(16, 30), _r1_mpi_tests.link_of(30), 'ready', k_old, k_old);
  insert into screening_v2.phone_engagements
    (id, application_link_id, candidate_id, role_id, state, state_reason, created_at, updated_at)
  values (_r1_mpi_tests.id(15, 30), _r1_mpi_tests.link_of(30), v_c, _r1_mpi_tests.id(2, 1),
          'pending_prereqs', 'phone_invalid', k_old, k_old);
  -- Arm B: no resume handle (phone_parsing here; the resume_parsing twin of the r1 import below).
  perform _r1_mpi_tests.link(32, k_m1, _r1_mpi_tests.cand(32), 'phone_parsing', null, k_old);
  -- Arm C: a handle whose ingestion rests in failed_review on a document verdict, both intakes.
  perform _r1_mpi_tests.link(33, k_m1, _r1_mpi_tests.cand(33), 'resume_parsing', 'mpi-handle-33', k_old);
  perform _r1_mpi_tests.link(34, k_m1, _r1_mpi_tests.cand(34), 'phone_parsing', 'mpi-handle-34', k_old);
  insert into screening_v2.ashby_resume_ingestions
    (id, application_link_id, state, failed_reason, created_at, updated_at)
  values (_r1_mpi_tests.id(16, 33), _r1_mpi_tests.link_of(33), 'failed_review', 'scan_infected', k_old, k_old),
         (_r1_mpi_tests.id(16, 34), _r1_mpi_tests.link_of(34), 'failed_review', 'scan_infected', k_old, k_old);

  -- The r1_public_booking import in the arm B shape: imported by the RPC at the old clock WITHOUT a
  -- number, so phone_valid is false and ashby_phone_applied_at is null: only the hunk excludes it.
  v := _r1_mpi_tests.import_app(36, p_now => k_old);
  perform _r1_mpi_tests.assert('D setup: the arm B shaped import', v ->> 'status' = 'imported', v::text);
  v_r1_b := (v ->> 'application_link_id')::uuid;
  v_r1_b_shell := (v ->> 'candidate_id')::uuid;
  -- Its twin: the same link and the same shell, the intake (and the ids) the only difference.
  insert into screening_v2.candidates
    (id, role_id, owner_id, resume_id, name, email, phone_raw, phone_e164, phone_valid, skills,
     experience_years, parsed, status, ats_source, ashby_phone_applied_at, created_at, updated_at)
  select _r1_mpi_tests.id(10, 31), c.role_id, c.owner_id, c.resume_id, c.name, c.email, c.phone_raw,
         c.phone_e164, c.phone_valid, c.skills, c.experience_years, c.parsed, c.status, c.ats_source,
         c.ashby_phone_applied_at, c.created_at, c.updated_at
    from screening_v2.candidates c where c.id = v_r1_b_shell;
  insert into screening_v2.ashby_application_links
    (provider, external_application_id, external_candidate_id, external_job_id, external_stage_id,
     job_mapping_id, candidate_id, lifecycle, intake_type, created_at, updated_at)
  select l.provider, _r1_mpi_tests.id(22, 31)::text, _r1_mpi_tests.id(26, 31)::text, l.external_job_id,
         l.external_stage_id, l.job_mapping_id, _r1_mpi_tests.id(10, 31), l.lifecycle, 'resume_parsing',
         l.created_at, l.updated_at
    from screening_v2.ashby_application_links l where l.id = v_r1_b
  returning id into v_twin;
  perform _r1_mpi_tests.assert('D the twin differs from the import only in its ids and its intake',
    (select to_jsonb(l) - v_drop from screening_v2.ashby_application_links l where l.id = v_twin)
      = (select to_jsonb(l) - v_drop from screening_v2.ashby_application_links l where l.id = v_r1_b)
    and (select to_jsonb(c) - 'id' from screening_v2.candidates c where c.id = _r1_mpi_tests.id(10, 31))
      = (select to_jsonb(c) - 'id' from screening_v2.candidates c where c.id = v_r1_b_shell));

  -- r1_public_booking imports in the arm A and arm C shapes. The guards refuse their rows, so they
  -- are switched off for these three inserts only, inside this rolled-back transaction.
  v := _r1_mpi_tests.import_app(37, p_now => k_old);
  v_r1_a := (v ->> 'application_link_id')::uuid;
  v_c := (v ->> 'candidate_id')::uuid;
  v := _r1_mpi_tests.import_app(38, p_now => k_old);
  v_r1_c := (v ->> 'application_link_id')::uuid;
  update screening_v2.ashby_application_links set external_resume_file_handle = 'mpi-handle-37' where id = v_r1_a;
  update screening_v2.ashby_application_links set external_resume_file_handle = 'mpi-handle-38' where id = v_r1_c;
  alter table screening_v2.ashby_resume_ingestions disable trigger trg_ashby_resume_ingestions_r1_public_booking;
  alter table screening_v2.phone_engagements disable trigger trg_phone_engagements_r1_public_booking;
  insert into screening_v2.ashby_resume_ingestions
    (id, application_link_id, state, failed_reason, created_at, updated_at)
  values (_r1_mpi_tests.id(16, 37), v_r1_a, 'ready', null, k_old, k_old),
         (_r1_mpi_tests.id(16, 38), v_r1_c, 'failed_review', 'scan_infected', k_old, k_old);
  insert into screening_v2.phone_engagements
    (id, application_link_id, candidate_id, role_id, state, state_reason, created_at, updated_at)
  values (_r1_mpi_tests.id(15, 37), v_r1_a, v_c, _r1_mpi_tests.id(2, 1),
          'pending_prereqs', 'phone_invalid', k_old, k_old);
  alter table screening_v2.ashby_resume_ingestions enable trigger trg_ashby_resume_ingestions_r1_public_booking;
  alter table screening_v2.phone_engagements enable trigger trg_phone_engagements_r1_public_booking;
  perform _r1_mpi_tests.assert('D both guards are enabled again',
    (select count(*) from pg_trigger t
      where t.tgname in ('trg_ashby_resume_ingestions_r1_public_booking', 'trg_phone_engagements_r1_public_booking')
        and t.tgenabled = 'O') = 2);
  perform _r1_mpi_tests.raises_with('D the re-enabled engagement guard refuses again',
    format('insert into screening_v2.phone_engagements (id, application_link_id, candidate_id, role_id) '
           'values (%L::uuid, %L::uuid, %L::uuid, %L::uuid)',
           _r1_mpi_tests.id(15, 36), v_r1_b, v_r1_b_shell, _r1_mpi_tests.id(2, 1)),
    'P0001', _r1_mpi_tests.msg('engagement'));
  perform _r1_mpi_tests.raises_with('D the re-enabled ingestion guard refuses again',
    format('insert into screening_v2.ashby_resume_ingestions (id, application_link_id) values (%L::uuid, %L::uuid)',
           _r1_mpi_tests.id(16, 36), v_r1_b),
    'P0001', _r1_mpi_tests.msg('ingestion'));

  v_due := array[_r1_mpi_tests.link_of(30), v_twin, _r1_mpi_tests.link_of(32), _r1_mpi_tests.link_of(33),
                 _r1_mpi_tests.link_of(34)];
  select coalesce(array_agg(d.application_link_id), '{}'::uuid[]) into v_claimed
    from screening_v2.claim_ashby_profile_due(50, 900, 21600, 4, k_t0) d;

  perform _r1_mpi_tests.assert('D regression: arm A (a ready resume link on phone_invalid) is claimed',
    _r1_mpi_tests.link_of(30) = any(v_claimed), v_claimed::text);
  perform _r1_mpi_tests.assert('D regression: arm B, resume_parsing (the twin), is claimed',
    v_twin = any(v_claimed), v_claimed::text);
  perform _r1_mpi_tests.assert('D regression: arm B, phone_parsing, is claimed',
    _r1_mpi_tests.link_of(32) = any(v_claimed), v_claimed::text);
  perform _r1_mpi_tests.assert('D regression: arm C, resume_parsing, is claimed',
    _r1_mpi_tests.link_of(33) = any(v_claimed), v_claimed::text);
  perform _r1_mpi_tests.assert('D regression: arm C, phone_parsing, is claimed',
    _r1_mpi_tests.link_of(34) = any(v_claimed), v_claimed::text);
  perform _r1_mpi_tests.assert('D an r1_public_booking import in the arm B shape is never claimed',
    not (v_r1_b = any(v_claimed)), v_claimed::text);
  perform _r1_mpi_tests.assert('D an r1_public_booking import in the arm A shape is never claimed',
    not (v_r1_a = any(v_claimed)), v_claimed::text);
  perform _r1_mpi_tests.assert('D an r1_public_booking import in the arm C shape is never claimed',
    not (v_r1_c = any(v_claimed)), v_claimed::text);
  perform _r1_mpi_tests.assert('D the claim stamped the five due links once',
    (select count(*) from screening_v2.ashby_application_links l
      where l.id = any(v_due) and l.profile_attempts = 1 and l.profile_checked_at = k_t0) = 5);
  perform _r1_mpi_tests.assert('D every r1_public_booking link keeps 0 profile attempts and no check time',
    (select count(*) from screening_v2.ashby_application_links l
      where l.id in (v_r1_b, v_r1_a, v_r1_c) and l.intake_type = 'r1_public_booking'
        and l.profile_attempts = 0 and l.profile_checked_at is null) = 3);

  -- Thirty days on, past every backoff, the claim still leaves them alone.
  select coalesce(array_agg(d.application_link_id), '{}'::uuid[]) into v_claimed
    from screening_v2.claim_ashby_profile_due(50, 900, 21600, 4, k_t0 + interval '30 days') d;
  perform _r1_mpi_tests.assert('D a later claim, past the backoff, re-claims the twin and still no r1_public_booking link',
    v_twin = any(v_claimed) and not (v_r1_b = any(v_claimed)) and not (v_r1_a = any(v_claimed))
    and not (v_r1_c = any(v_claimed)), v_claimed::text);
  perform _r1_mpi_tests.assert('D the r1_public_booking links still have 0 profile attempts',
    (select count(*) from screening_v2.ashby_application_links l
      where l.id in (v_r1_b, v_r1_a, v_r1_c) and l.profile_attempts = 0) = 3);
end;
$$;

-- =================================================================================================
-- E. The business-impact read model leaves an on-the-spot import out.
-- =================================================================================================
do $$
declare
  k_t0 constant timestamptz := _r1_mpi_tests.t0();
  k_m1 constant uuid := _r1_mpi_tests.id(13, 1);
  v jsonb;
  v_rp uuid;
  v_r1 uuid;
  v_shell uuid;
begin
  v_rp := _r1_mpi_tests.link(50, k_m1, _r1_mpi_tests.cand(50));
  v := _r1_mpi_tests.import_app(51, 'mpi-job-1', _r1_mpi_tests.name(51), _r1_mpi_tests.email(51),
                                _r1_mpi_tests.phone(51));
  perform _r1_mpi_tests.assert('E setup: an on-the-spot import on the same job', v ->> 'status' = 'imported', v::text);
  v_r1 := (v ->> 'application_link_id')::uuid;
  v_shell := (v ->> 'candidate_id')::uuid;

  perform _r1_mpi_tests.assert('E a resume_parsing link of the mapped job is an impact application',
    exists (select 1 from screening_v2.v_ashby_application_impact i
             where i.application_link_id = v_rp and i.in_impact and i.cohort_day = date '2026-12-01'));
  perform _r1_mpi_tests.assert('E the r1_public_booking import is not in v_ashby_application_impact at all',
    not exists (select 1 from screening_v2.v_ashby_application_impact i
                 where i.application_link_id = v_r1 or i.candidate_id = v_shell));
  perform _r1_mpi_tests.assert('E impact_application_rows of the job lists the resume link and not the import',
    exists (select 1 from screening_v2.impact_application_rows(date '2026-12-01', date '2026-12-01', k_m1, false, k_t0) r
             where r.application_link_id = v_rp)
    and not exists (select 1 from screening_v2.impact_application_rows(date '2026-12-01', date '2026-12-01', k_m1, false, k_t0) r
                     where r.application_link_id = v_r1 or r.candidate_id = v_shell));
  perform _r1_mpi_tests.assert('E impact_application_rows of every job, progress on, leaves the import out too',
    exists (select 1 from screening_v2.impact_application_rows(date '2026-11-01', date '2026-12-31', null, true, k_t0) r
             where r.application_link_id = v_rp)
    and not exists (select 1 from screening_v2.impact_application_rows(date '2026-11-01', date '2026-12-31', null, true, k_t0) r
                     where r.application_link_id = v_r1 or r.candidate_id = v_shell));
end;
$$;

-- =================================================================================================
-- F. r1_meet_public_local_rows: the read-only local match lookup.
-- =================================================================================================
do $$
declare
  k_t0 constant timestamptz := _r1_mpi_tests.t0();
  k_m1 constant uuid := _r1_mpi_tests.id(13, 1);
  k_keys constant text[] := array['candidate_id', 'matched_by', 'application_id', 'ashby_candidate_id',
                                  'link_terminal', 'mapping_enabled', 'dsar_hold', 'decision_blocked'];
  v jsonb;
  v_before jsonb;
  v_case record;
  v_elem jsonb;
  v_all text := '';
begin
  -- Fixtures.
  perform _r1_mpi_tests.link(100, k_m1, _r1_mpi_tests.cand(100, _r1_mpi_tests.email(100), _r1_mpi_tests.phone(100)));
  -- One candidate, five links: terminal on an enabled mapping, paused, archived, no mapping, drift.
  perform _r1_mpi_tests.cand(101, _r1_mpi_tests.email(101));
  perform _r1_mpi_tests.link(101, k_m1, _r1_mpi_tests.id(10, 101), p_terminal => 'withdrawn');
  perform _r1_mpi_tests.link(102, _r1_mpi_tests.id(13, 3), _r1_mpi_tests.id(10, 101));
  perform _r1_mpi_tests.link(103, _r1_mpi_tests.id(13, 5), _r1_mpi_tests.id(10, 101));
  perform _r1_mpi_tests.link(104, null, _r1_mpi_tests.id(10, 101));
  perform _r1_mpi_tests.link(105, _r1_mpi_tests.id(13, 4), _r1_mpi_tests.id(10, 101));
  -- A stored address with spaces and capitals; no link.
  perform _r1_mpi_tests.cand(106, '  Mixed@Example.test ');
  -- A decision-blocked candidate.
  perform _r1_mpi_tests.link(107, k_m1, _r1_mpi_tests.cand(107, _r1_mpi_tests.email(107)));
  update screening_v2.candidates set decision_use_blocked_at = k_t0 where id = _r1_mpi_tests.id(10, 107);
  perform _r1_mpi_tests.link(109, k_m1, _r1_mpi_tests.cand(109, _r1_mpi_tests.email(109), _r1_mpi_tests.phone(109)));
  -- Three candidates with one address, inserted in reverse id order.
  perform _r1_mpi_tests.cand(112, _r1_mpi_tests.email(110));
  perform _r1_mpi_tests.cand(111, _r1_mpi_tests.email(110));
  perform _r1_mpi_tests.cand(110, _r1_mpi_tests.email(110));
  perform _r1_mpi_tests.link(112, k_m1, _r1_mpi_tests.id(10, 112));
  perform _r1_mpi_tests.link(111, k_m1, _r1_mpi_tests.id(10, 111));
  perform _r1_mpi_tests.link(110, k_m1, _r1_mpi_tests.id(10, 110));

  v_before := _r1_mpi_tests.counts();

  -- Every invalid input answers exactly {"status":"invalid_request"}: no field, no value.
  for v_case in
    select *
      from (values
        ('both inputs null', null::text, null::text, 21),
        ('p_limit 0', _r1_mpi_tests.email(100), null, 0),
        ('p_limit 22', _r1_mpi_tests.email(100), null, 22),
        ('p_limit null', _r1_mpi_tests.email(100), null, null),
        ('an upper-case email', 'A@example.test', null, 21),
        ('an email with a leading space', ' a@example.test', null, 21),
        ('an email with no @', 'no-at', null, 21),
        ('an email with two @', 'a@b@c', null, 21),
        ('a 2-character email', 'a@', null, 21),
        ('a 255-character email', repeat('a', 242) || '@example.test', null, 21),
        ('a short number', null, '+9198', 21),
        ('a foreign number', null, '+14155550123', 21),
        ('a landline-shaped number', null, '+915' || repeat('0', 9), 21),
        ('a number with a trailing space', null, _r1_mpi_tests.phone(100) || ' ', 21),
        ('a good email with a bad number', _r1_mpi_tests.email(100), '+14155550123', 21)
      ) as c(label, p_email, p_phone, p_limit)
  loop
    v := screening_v2.r1_meet_public_local_rows(v_case.p_email, v_case.p_phone, v_case.p_limit);
    perform _r1_mpi_tests.assert('F invalid_request and nothing else for ' || v_case.label,
      v = '{"status":"invalid_request"}'::jsonb, v::text);
  end loop;
  perform _r1_mpi_tests.assert('F the shortest (3) and longest (254) emails are valid and match nothing here',
    screening_v2.r1_meet_public_local_rows('a@b', null) = '{"status":"ok","rows":[]}'::jsonb
    and screening_v2.r1_meet_public_local_rows(repeat('a', 241) || '@example.test', null) = '{"status":"ok","rows":[]}'::jsonb);

  -- Matches.
  v := screening_v2.r1_meet_public_local_rows(_r1_mpi_tests.email(100), null);
  v_all := v_all || v::text;
  perform _r1_mpi_tests.assert('F an email-only lookup finds its candidate (matched_by email)',
    v = _r1_mpi_tests.ok_rows(_r1_mpi_tests.local_row(100, 'email', 100, false, true)), v::text);
  perform _r1_mpi_tests.assert('F the answer is exactly status and rows',
    _r1_mpi_tests.same_set(_r1_mpi_tests.keys(v), array['status', 'rows']), v::text);
  v := screening_v2.r1_meet_public_local_rows(null, _r1_mpi_tests.phone(100));
  v_all := v_all || v::text;
  perform _r1_mpi_tests.assert('F a phone-only lookup finds its candidate (matched_by phone)',
    v = _r1_mpi_tests.ok_rows(_r1_mpi_tests.local_row(100, 'phone', 100, false, true)), v::text);
  v := screening_v2.r1_meet_public_local_rows(_r1_mpi_tests.email(100), _r1_mpi_tests.phone(100));
  perform _r1_mpi_tests.assert('F both inputs on one candidate give one row (matched_by both)',
    v = _r1_mpi_tests.ok_rows(_r1_mpi_tests.local_row(100, 'both', 100, false, true)), v::text);
  v := screening_v2.r1_meet_public_local_rows(_r1_mpi_tests.email(100), _r1_mpi_tests.phone(109));
  perform _r1_mpi_tests.assert('F the email and the number may find two candidates, ordered by candidate id',
    v = _r1_mpi_tests.ok_rows(_r1_mpi_tests.local_row(100, 'email', 100, false, true),
                              _r1_mpi_tests.local_row(109, 'phone', 109, false, true)), v::text);
  v := screening_v2.r1_meet_public_local_rows('mixed@example.test', null);
  v_all := v_all || v::text;
  perform _r1_mpi_tests.assert('F a stored address is compared trimmed and lower-cased; no link is one fail-closed row',
    v = _r1_mpi_tests.ok_rows(_r1_mpi_tests.local_row(106, 'email', null, true, false)), v::text);

  -- Per link: terminal, and the mapping enabled / paused / archived / none / drift, by application id.
  v := screening_v2.r1_meet_public_local_rows(_r1_mpi_tests.email(101), null);
  v_all := v_all || v::text;
  perform _r1_mpi_tests.assert('F one row per link: terminal true only for a terminal link; mapping_enabled only for an enabled live mapping',
    v = _r1_mpi_tests.ok_rows(_r1_mpi_tests.local_row(101, 'email', 101, true, true),
                              _r1_mpi_tests.local_row(101, 'email', 102, false, false),
                              _r1_mpi_tests.local_row(101, 'email', 103, false, false),
                              _r1_mpi_tests.local_row(101, 'email', 104, false, false),
                              _r1_mpi_tests.local_row(101, 'email', 105, false, false)), v::text);
  for v_elem in select e.val from jsonb_array_elements(v -> 'rows') as e(val) loop
    perform _r1_mpi_tests.assert('F every row has exactly the eight keys, booleans as JSON booleans',
      _r1_mpi_tests.same_set(_r1_mpi_tests.keys(v_elem), k_keys)
      and jsonb_typeof(v_elem -> 'link_terminal') = 'boolean' and jsonb_typeof(v_elem -> 'mapping_enabled') = 'boolean'
      and jsonb_typeof(v_elem -> 'dsar_hold') = 'boolean' and jsonb_typeof(v_elem -> 'decision_blocked') = 'boolean',
      v_elem::text);
  end loop;
  v := screening_v2.r1_meet_public_local_rows(_r1_mpi_tests.email(101), null, 2);
  perform _r1_mpi_tests.assert('F p_limit cuts the rows (links included) in application-id order',
    v = _r1_mpi_tests.ok_rows(_r1_mpi_tests.local_row(101, 'email', 101, true, true),
                              _r1_mpi_tests.local_row(101, 'email', 102, false, false)), v::text);

  v := screening_v2.r1_meet_public_local_rows(_r1_mpi_tests.email(107), null);
  perform _r1_mpi_tests.assert('F decision_blocked is true for a decision-blocked candidate',
    v = _r1_mpi_tests.ok_rows(_r1_mpi_tests.local_row(107, 'email', 107, false, true, false, true)), v::text);

  -- Ordering by candidate id and the limit.
  v := screening_v2.r1_meet_public_local_rows(_r1_mpi_tests.email(110), null);
  perform _r1_mpi_tests.assert('F rows are ordered by candidate id whatever the insert order',
    v = _r1_mpi_tests.ok_rows(_r1_mpi_tests.local_row(110, 'email', 110, false, true),
                              _r1_mpi_tests.local_row(111, 'email', 111, false, true),
                              _r1_mpi_tests.local_row(112, 'email', 112, false, true)), v::text);
  v := screening_v2.r1_meet_public_local_rows(_r1_mpi_tests.email(110), null, 2);
  perform _r1_mpi_tests.assert('F p_limit 2 with three matches answers the first two',
    v = _r1_mpi_tests.ok_rows(_r1_mpi_tests.local_row(110, 'email', 110, false, true),
                              _r1_mpi_tests.local_row(111, 'email', 111, false, true)), v::text);
  v := screening_v2.r1_meet_public_local_rows(_r1_mpi_tests.email(110), null, 1);
  perform _r1_mpi_tests.assert('F p_limit 1 answers the first',
    v = _r1_mpi_tests.ok_rows(_r1_mpi_tests.local_row(110, 'email', 110, false, true)), v::text);

  -- No contact data ever comes back.
  perform _r1_mpi_tests.assert('F no answer carries an email, a number or a name',
    position('@' in v_all) = 0 and position('+91' in v_all) = 0
    and position('meet public import assert' in v_all) = 0 and position('Mixed' in v_all) = 0, v_all);

  perform _r1_mpi_tests.assert('F the lookups wrote nothing', _r1_mpi_tests.counts() = v_before,
    _r1_mpi_tests.counts()::text || ' vs ' || v_before::text);
end;
$$;

-- F (holds): dsar_hold for every request type x status (0012), one request at a time; each request
-- lives only inside a subtransaction that a sentinel rolls back.
do $$
declare
  k_hold_types constant text[] := array['correct', 'restrict', 'delete'];
  k_hold_statuses constant text[] := array['pending', 'in_progress', 'fulfilled'];
  v jsonb;
  v_case record;
  v_msg text;
  v_k integer := 0;
begin
  perform _r1_mpi_tests.link(108, _r1_mpi_tests.id(13, 1), _r1_mpi_tests.cand(108, _r1_mpi_tests.email(108)));
  for v_case in
    select t.request_type, s.request_status
      from unnest(array['export', 'delete', 'correct', 'restrict']) as t(request_type)
     cross join unnest(array['pending', 'in_progress', 'fulfilled', 'rejected', 'cancelled']) as s(request_status)
  loop
    v_k := v_k + 1;
    v := null;
    begin
      perform _r1_mpi_tests.dsar(100 + v_k, _r1_mpi_tests.id(10, 108), v_case.request_type, v_case.request_status);
      v := screening_v2.r1_meet_public_local_rows(_r1_mpi_tests.email(108), null);
      raise exception 'r1 mpi undo' using errcode = 'P0001';
    exception when sqlstate 'P0001' then
      get stacked diagnostics v_msg = message_text;
      if v_msg <> 'r1 mpi undo' then
        raise;
      end if;
    end;
    perform _r1_mpi_tests.assert(format('F dsar_hold is %s for a %s request that is %s',
        (v_case.request_type = any(k_hold_types) and v_case.request_status = any(k_hold_statuses))::text,
        v_case.request_type, v_case.request_status),
      v = _r1_mpi_tests.ok_rows(_r1_mpi_tests.local_row(108, 'email', 108, false, true,
            v_case.request_type = any(k_hold_types) and v_case.request_status = any(k_hold_statuses))),
      coalesce(v::text, 'null'));
  end loop;
  perform _r1_mpi_tests.assert('F the twenty requests were all undone',
    not exists (select 1 from screening_v2.data_subject_requests d where d.candidate_id = _r1_mpi_tests.id(10, 108)));
end;
$$;

-- =================================================================================================
-- G. r1_meet_public_import_application: the on-the-spot import.
-- =================================================================================================

-- G1. Validation: every invalid field, one at a time, then the precedence when two are bad; and
-- the accepted boundaries, which reach the mapping step (an unknown job: mapping_unavailable).
do $$
declare
  k_t0 constant timestamptz := _r1_mpi_tests.t0();
  k_app constant text := _r1_mpi_tests.id(22, 160)::text;
  k_person constant text := _r1_mpi_tests.id(26, 160)::text;
  v jsonb;
  v_before jsonb;
  v_case record;
begin
  v_before := _r1_mpi_tests.counts();
  for v_case in
    select *
      from (values
        ('application_id', 'a null application id', null::text, k_person, 'mpi-job-1'::text, null::text, null::text, null::text, null::text, k_t0),
        ('application_id', 'a word', 'nope', k_person, 'mpi-job-1', null, null, null, null, k_t0),
        ('application_id', 'a truncated uuid', left(k_app, 35), k_person, 'mpi-job-1', null, null, null, null, k_t0),
        ('application_id', 'a uuid with a trailing space', k_app || ' ', k_person, 'mpi-job-1', null, null, null, null, k_t0),
        ('application_id', 'a uuid without dashes', replace(k_app, '-', ''), k_person, 'mpi-job-1', null, null, null, null, k_t0),
        ('ashby_candidate_id', 'a null Ashby candidate id', k_app, null, 'mpi-job-1', null, null, null, null, k_t0),
        ('ashby_candidate_id', 'a short Ashby candidate id', k_app, 'x', 'mpi-job-1', null, null, null, null, k_t0),
        ('ashby_candidate_id', 'an Ashby candidate id with a suffix', k_app, k_person || 'x', 'mpi-job-1', null, null, null, null, k_t0),
        ('job_id', 'a null job id', k_app, k_person, null, null, null, null, null, k_t0),
        ('job_id', 'an empty job id', k_app, k_person, '', null, null, null, null, k_t0),
        ('job_id', 'a 257-character job id', k_app, k_person, repeat('j', 257), null, null, null, null, k_t0),
        ('stage_id', 'an empty stage id', k_app, k_person, 'mpi-job-1', '', null, null, null, k_t0),
        ('stage_id', 'a 257-character stage id', k_app, k_person, 'mpi-job-1', repeat('s', 257), null, null, null, k_t0),
        ('name', 'an empty name', k_app, k_person, 'mpi-job-1', null, '', null, null, k_t0),
        ('name', 'a blank name', k_app, k_person, 'mpi-job-1', null, '   ', null, null, k_t0),
        ('name', 'a 201-character name', k_app, k_person, 'mpi-job-1', null, repeat('n', 201), null, null, k_t0),
        ('name', 'a name with a tab', k_app, k_person, 'mpi-job-1', null, 'a' || chr(9) || 'b', null, null, k_t0),
        ('name', 'a name with a newline', k_app, k_person, 'mpi-job-1', null, 'a' || chr(10) || 'b', null, null, k_t0),
        ('email', 'a 255-character email', k_app, k_person, 'mpi-job-1', null, null, repeat('e', 242) || '@example.test', null, k_t0),
        ('email', 'an email with a space', k_app, k_person, 'mpi-job-1', null, null, 'a b@example.test', null, k_t0),
        ('email', 'an email with two @', k_app, k_person, 'mpi-job-1', null, null, 'a@b@c', null, k_t0),
        ('email', 'an email with no @', k_app, k_person, 'mpi-job-1', null, null, 'no-at', null, k_t0),
        ('email', 'an email with no local part', k_app, k_person, 'mpi-job-1', null, null, '@example.test', null, k_t0),
        ('email', 'an email with no domain', k_app, k_person, 'mpi-job-1', null, null, 'a@', null, k_t0),
        ('email', 'an email with a tab', k_app, k_person, 'mpi-job-1', null, null, 'a' || chr(9) || '@example.test', null, k_t0),
        ('phone', 'a foreign number', k_app, k_person, 'mpi-job-1', null, null, null, '+14155550123', k_t0),
        ('phone', 'a short number', k_app, k_person, 'mpi-job-1', null, null, null, '+9198', k_t0),
        ('phone', 'a landline-shaped number', k_app, k_person, 'mpi-job-1', null, null, null, '+915' || repeat('0', 9), k_t0),
        ('phone', 'a number without the plus', k_app, k_person, 'mpi-job-1', null, null, null, ltrim(_r1_mpi_tests.phone(160), '+'), k_t0),
        ('phone', 'a number with a trailing space', k_app, k_person, 'mpi-job-1', null, null, null, _r1_mpi_tests.phone(160) || ' ', k_t0),
        ('phone', 'a number with a space inside', k_app, k_person, 'mpi-job-1', null, null, null, '+91 ' || right(_r1_mpi_tests.phone(160), 10), k_t0),
        ('now', 'a null clock', k_app, k_person, 'mpi-job-1', null, null, null, null, null),
        ('now', 'an infinite clock', k_app, k_person, 'mpi-job-1', null, null, null, null, 'infinity'),
        ('now', 'a minus-infinite clock', k_app, k_person, 'mpi-job-1', null, null, null, null, '-infinity'),
        -- Precedence: the first failing field in signature order wins.
        ('application_id', 'a bad application id and a bad number', 'nope', k_person, 'mpi-job-1', null, null, null, '+1', k_t0),
        ('ashby_candidate_id', 'a bad Ashby candidate id and a bad job', k_app, 'x', '', null, null, null, null, k_t0),
        ('job_id', 'a bad job and a bad stage', k_app, k_person, '', '', null, null, null, k_t0),
        ('stage_id', 'a bad stage and a bad name', k_app, k_person, 'mpi-job-1', '', '', null, null, k_t0),
        ('name', 'a bad name and a bad email', k_app, k_person, 'mpi-job-1', null, '', 'no-at', null, k_t0),
        ('email', 'a bad email and a bad number', k_app, k_person, 'mpi-job-1', null, null, 'no-at', '+1', k_t0),
        ('phone', 'a bad number and a bad clock', k_app, k_person, 'mpi-job-1', null, null, null, '+1', null)
      ) as c(field, label, p_app, p_person, p_job, p_stage, p_name, p_email, p_phone, p_at)
  loop
    v := screening_v2.r1_meet_public_import_application(v_case.p_app, v_case.p_person, v_case.p_job,
           v_case.p_stage, v_case.p_name, v_case.p_email, v_case.p_phone, v_case.p_at);
    perform _r1_mpi_tests.assert('G invalid_request field ' || v_case.field || ' for ' || v_case.label,
      v = jsonb_build_object('status', 'invalid_request', 'field', v_case.field), v::text);
  end loop;
  perform _r1_mpi_tests.assert('G no invalid request wrote anything', _r1_mpi_tests.counts() = v_before,
    _r1_mpi_tests.counts()::text || ' vs ' || v_before::text);

  -- Accepted boundaries: validation passes, and the unknown job stops the import at the mapping.
  for v_case in
    select *
      from (values
        ('an upper-case application id', upper(_r1_mpi_tests.id(22, 161)::text), _r1_mpi_tests.id(26, 161)::text, null::text, null::text, null::text, null::text, k_t0),
        ('an upper-case Ashby candidate id', _r1_mpi_tests.id(22, 161)::text, upper(_r1_mpi_tests.id(26, 161)::text), null, null, null, null, k_t0),
        ('a 256-character stage id', _r1_mpi_tests.id(22, 161)::text, _r1_mpi_tests.id(26, 161)::text, repeat('s', 256), null, null, null, k_t0),
        ('a 200-character name', _r1_mpi_tests.id(22, 161)::text, _r1_mpi_tests.id(26, 161)::text, null, repeat('n', 200), null, null, k_t0),
        ('a name with spaces around it', _r1_mpi_tests.id(22, 161)::text, _r1_mpi_tests.id(26, 161)::text, null, ' a b ', null, null, k_t0),
        ('a 254-character email', _r1_mpi_tests.id(22, 161)::text, _r1_mpi_tests.id(26, 161)::text, null, null, repeat('e', 241) || '@example.test', null, k_t0),
        ('an email with capitals (Ashby text as is)', _r1_mpi_tests.id(22, 161)::text, _r1_mpi_tests.id(26, 161)::text, null, null, 'A.B@Example.test', null, k_t0),
        ('the lowest mobile prefix', _r1_mpi_tests.id(22, 161)::text, _r1_mpi_tests.id(26, 161)::text, null, null, null, '+916' || repeat('0', 9), k_t0),
        ('the highest mobile number', _r1_mpi_tests.id(22, 161)::text, _r1_mpi_tests.id(26, 161)::text, null, null, null, '+91' || repeat('9', 10), k_t0),
        ('a clock in the past', _r1_mpi_tests.id(22, 161)::text, _r1_mpi_tests.id(26, 161)::text, null, null, null, null, '2020-01-01 00:00:00+00')
      ) as c(label, p_app, p_person, p_stage, p_name, p_email, p_phone, p_at)
  loop
    v := screening_v2.r1_meet_public_import_application(v_case.p_app, v_case.p_person, 'mpi-job-99',
           v_case.p_stage, v_case.p_name, v_case.p_email, v_case.p_phone, v_case.p_at);
    perform _r1_mpi_tests.assert('G valid input reaches the mapping step: ' || v_case.label,
      v = '{"status":"refused","code":"mapping_unavailable"}'::jsonb, v::text);
  end loop;
  perform _r1_mpi_tests.assert('G a 256-character job id is valid (and unknown)',
    screening_v2.r1_meet_public_import_application(_r1_mpi_tests.id(22, 161)::text, _r1_mpi_tests.id(26, 161)::text,
      repeat('j', 256), null, null, null, null, k_t0) = '{"status":"refused","code":"mapping_unavailable"}'::jsonb);
  perform _r1_mpi_tests.assert('G the accepted boundaries wrote nothing', _r1_mpi_tests.counts() = v_before,
    _r1_mpi_tests.counts()::text || ' vs ' || v_before::text);
end;
$$;

-- G2. The import: the link and the shell exactly, nothing else, replays, and the guards after it.
do $$
declare
  k_t0 constant timestamptz := _r1_mpi_tests.t0();
  k_link_cols constant text[] := array['id', 'provider', 'external_application_id', 'external_candidate_id',
    'external_job_id', 'external_stage_id', 'job_mapping_id', 'candidate_id', 'lifecycle', 'intake_type',
    'profile_attempts', 'created_at', 'updated_at'];
  k_shell_cols constant text[] := array['id', 'role_id', 'owner_id', 'name', 'email', 'phone_e164', 'phone_valid',
    'skills', 'status', 'consent_source', 'ats_source', 'ashby_phone_applied_at', 'created_at', 'updated_at'];
  v jsonb;
  v2 jsonb;
  v_before jsonb;
  v_after jsonb;
  v_snap jsonb;
  v_link screening_v2.ashby_application_links%rowtype;
  v_cand screening_v2.candidates%rowtype;
  v_link_id uuid;
  v_cand_id uuid;
begin
  v_before := _r1_mpi_tests.counts();
  v := screening_v2.r1_meet_public_import_application(_r1_mpi_tests.id(22, 150)::text, _r1_mpi_tests.id(26, 150)::text,
         'mpi-job-1', 'mpi-stage-1', _r1_mpi_tests.name(150), _r1_mpi_tests.email(150), _r1_mpi_tests.phone(150), k_t0);
  perform _r1_mpi_tests.assert('G imported answers exactly status, candidate_id and application_link_id',
    v ->> 'status' = 'imported'
    and _r1_mpi_tests.same_set(_r1_mpi_tests.keys(v), array['status', 'candidate_id', 'application_link_id']), v::text);
  perform _r1_mpi_tests.assert('G the answer carries no name, email or number',
    position(_r1_mpi_tests.name(150) in v::text) = 0 and position(_r1_mpi_tests.email(150) in v::text) = 0
    and position(_r1_mpi_tests.phone(150) in v::text) = 0 and position('@' in v::text) = 0, v::text);
  v_link_id := (v ->> 'application_link_id')::uuid;
  v_cand_id := (v ->> 'candidate_id')::uuid;

  select * into v_link from screening_v2.ashby_application_links l where l.id = v_link_id;
  perform _r1_mpi_tests.assert('G the link columns are exactly the import values',
    v_link.provider = 'ashby' and v_link.external_application_id = _r1_mpi_tests.id(22, 150)::text
    and v_link.external_candidate_id = _r1_mpi_tests.id(26, 150)::text and v_link.external_job_id = 'mpi-job-1'
    and v_link.external_stage_id = 'mpi-stage-1' and v_link.job_mapping_id = _r1_mpi_tests.id(13, 1)
    and v_link.candidate_id = v_cand_id and v_link.lifecycle = 'imported' and v_link.intake_type = 'r1_public_booking'
    and v_link.terminal_state is null and v_link.terminal_reason is null
    and v_link.external_resume_file_handle is null and v_link.submitted_at is null
    and v_link.session_id is null and v_link.invite_id is null and v_link.assessment_id is null
    and v_link.profile_attempts = 0 and v_link.profile_outcome is null and v_link.profile_checked_at is null
    and v_link.created_at = k_t0 and v_link.updated_at = k_t0, to_jsonb(v_link)::text);
  perform _r1_mpi_tests.assert('G the link sets exactly these columns and leaves every other one null',
    _r1_mpi_tests.same_set(_r1_mpi_tests.set_cols(to_jsonb(v_link)), k_link_cols), to_jsonb(v_link)::text);

  select * into v_cand from screening_v2.candidates c where c.id = v_cand_id;
  perform _r1_mpi_tests.assert('G the shell holds the mapping''s role and owner and the Ashby values',
    v_cand.role_id = _r1_mpi_tests.id(2, 1) and v_cand.owner_id = _r1_mpi_tests.id(1, 1)
    and v_cand.resume_id is null and v_cand.name = _r1_mpi_tests.name(150) and v_cand.email = _r1_mpi_tests.email(150)
    and v_cand.phone_raw is null and v_cand.phone_e164 = _r1_mpi_tests.phone(150) and v_cand.phone_valid = false
    and v_cand.skills = '[]'::jsonb and v_cand.experience_years is null and v_cand.parsed is null
    and v_cand.status = 'queued' and v_cand.ats_source = 'ashby' and v_cand.ats_external_id is null
    and v_cand.consent_at is null and v_cand.decision_use_blocked_at is null
    and v_cand.ashby_phone_applied_at = k_t0 and v_cand.created_at = k_t0 and v_cand.updated_at = k_t0,
    'shell columns differ');
  -- consent_source is the column default, as on every Ashby import shell (insertCandidateShell).
  perform _r1_mpi_tests.assert('G the shell sets exactly these columns and leaves every other one null',
    _r1_mpi_tests.same_set(_r1_mpi_tests.set_cols(to_jsonb(v_cand)), k_shell_cols),
    array_to_string(_r1_mpi_tests.set_cols(to_jsonb(v_cand)), ','));

  v_after := _r1_mpi_tests.counts();
  perform _r1_mpi_tests.assert('G the import wrote exactly one link and one candidate, and no other row anywhere',
    v_after = v_before || jsonb_build_object('candidates', (v_before ->> 'candidates')::bigint + 1,
                                             'links', (v_before ->> 'links')::bigint + 1),
    v_after::text || ' vs ' || v_before::text);
  perform _r1_mpi_tests.assert('G no ingestion, engagement or operation for the link; no session, invite, consent or round for the shell',
    not exists (select 1 from screening_v2.ashby_resume_ingestions i where i.application_link_id = v_link_id)
    and not exists (select 1 from screening_v2.phone_engagements e
                     where e.application_link_id = v_link_id or e.candidate_id = v_cand_id)
    and not exists (select 1 from screening_v2.ashby_operations o where o.application_link_id = v_link_id)
    and not exists (select 1 from screening_v2.call_sessions s where s.candidate_id = v_cand_id)
    and not exists (select 1 from screening_v2.candidate_invites i where i.candidate_id = v_cand_id)
    and not exists (select 1 from screening_v2.consent_records r where r.candidate_id = v_cand_id)
    and not exists (select 1 from screening_v2.interview_rounds r where r.candidate_id = v_cand_id));

  -- End to end with C: the new import never takes an engagement or an ingestion.
  perform _r1_mpi_tests.raises_with('G an engagement for the new import is refused',
    format('insert into screening_v2.phone_engagements (id, application_link_id, candidate_id, role_id) '
           'values (%L::uuid, %L::uuid, %L::uuid, %L::uuid)',
           _r1_mpi_tests.id(15, 150), v_link_id, v_cand_id, _r1_mpi_tests.id(2, 1)),
    'P0001', _r1_mpi_tests.msg('engagement'));
  perform _r1_mpi_tests.raises_with('G an ingestion for the new import is refused',
    format('insert into screening_v2.ashby_resume_ingestions (id, application_link_id) values (%L::uuid, %L::uuid)',
           _r1_mpi_tests.id(16, 150), v_link_id),
    'P0001', _r1_mpi_tests.msg('ingestion'));

  -- Replays answer exists with the same ids and change nothing (updated_at included).
  v_snap := (select jsonb_build_array(to_jsonb(l), to_jsonb(c))
               from screening_v2.ashby_application_links l
               join screening_v2.candidates c on c.id = l.candidate_id
              where l.id = v_link_id);
  v2 := screening_v2.r1_meet_public_import_application(_r1_mpi_tests.id(22, 150)::text, _r1_mpi_tests.id(26, 150)::text,
          'mpi-job-1', 'mpi-stage-1', _r1_mpi_tests.name(150), _r1_mpi_tests.email(150), _r1_mpi_tests.phone(150), k_t0);
  perform _r1_mpi_tests.assert('G an identical replay answers exists with the same ids',
    v2 = jsonb_build_object('status', 'exists', 'candidate_id', v_cand_id::text, 'application_link_id', v_link_id::text),
    v2::text);
  v2 := screening_v2.r1_meet_public_import_application(_r1_mpi_tests.id(22, 150)::text, _r1_mpi_tests.id(26, 150)::text,
          'mpi-job-2', 'mpi-stage-2', null, null, null, k_t0 + interval '1 day');
  perform _r1_mpi_tests.assert('G a replay with other values and a later clock still answers exists with the same ids',
    v2 = jsonb_build_object('status', 'exists', 'candidate_id', v_cand_id::text, 'application_link_id', v_link_id::text),
    v2::text);
  perform _r1_mpi_tests.assert('G the replays changed nothing, updated_at included',
    (select jsonb_build_array(to_jsonb(l), to_jsonb(c))
       from screening_v2.ashby_application_links l
       join screening_v2.candidates c on c.id = l.candidate_id
      where l.id = v_link_id) = v_snap);
  perform _r1_mpi_tests.assert('G the replays wrote nothing', _r1_mpi_tests.counts() = v_after,
    _r1_mpi_tests.counts()::text || ' vs ' || v_after::text);

  -- Without a number, name or email (the Ashby record had none): all null, no applied marker; the
  -- Ashby ids are stored verbatim (an upper-case candidate id stays upper-case).
  v := screening_v2.r1_meet_public_import_application(_r1_mpi_tests.id(22, 151)::text,
         upper(_r1_mpi_tests.id(26, 151)::text), 'mpi-job-1', null, null, null, null, k_t0);
  perform _r1_mpi_tests.assert('G an import with no name, email, number or stage is accepted', v ->> 'status' = 'imported', v::text);
  select * into v_link from screening_v2.ashby_application_links l where l.id = (v ->> 'application_link_id')::uuid;
  select * into v_cand from screening_v2.candidates c where c.id = (v ->> 'candidate_id')::uuid;
  perform _r1_mpi_tests.assert('G without a number the shell has no phone_e164 and no ashby_phone_applied_at',
    v_cand.phone_e164 is null and v_cand.ashby_phone_applied_at is null and v_cand.phone_valid = false
    and v_cand.phone_raw is null);
  perform _r1_mpi_tests.assert('G a null name and email stay null',
    v_cand.name is null and v_cand.email is null);
  perform _r1_mpi_tests.assert('G the Ashby ids are stored verbatim and a null stage stays null',
    v_link.external_candidate_id = upper(_r1_mpi_tests.id(26, 151)::text)
    and v_link.external_application_id = _r1_mpi_tests.id(22, 151)::text and v_link.external_stage_id is null,
    to_jsonb(v_link)::text);

  -- The mapping gives the role, the owner and the link's mapping (M2, browser_primary).
  v := screening_v2.r1_meet_public_import_application(_r1_mpi_tests.id(22, 152)::text, _r1_mpi_tests.id(26, 152)::text,
         'mpi-job-2', 'mpi-stage-1', _r1_mpi_tests.name(152), _r1_mpi_tests.email(152), _r1_mpi_tests.phone(152), k_t0);
  select * into v_link from screening_v2.ashby_application_links l where l.id = (v ->> 'application_link_id')::uuid;
  select * into v_cand from screening_v2.candidates c where c.id = (v ->> 'candidate_id')::uuid;
  perform _r1_mpi_tests.assert('G the shell takes the role and the owner of the job''s mapping',
    v ->> 'status' = 'imported' and v_link.job_mapping_id = _r1_mpi_tests.id(13, 2)
    and v_cand.role_id = _r1_mpi_tests.id(2, 2) and v_cand.owner_id = _r1_mpi_tests.id(1, 2), v::text);

  -- One live mapping per job: the archived M6 is ignored, the enabled M7 is used.
  v := _r1_mpi_tests.import_app(153, 'mpi-job-6');
  perform _r1_mpi_tests.assert('G a job with an archived and a live mapping imports onto the live one',
    v ->> 'status' = 'imported'
    and (select l.job_mapping_id from screening_v2.ashby_application_links l
          where l.id = (v ->> 'application_link_id')::uuid) = _r1_mpi_tests.id(13, 7), v::text);
end;
$$;

-- G3. Existing links: adopted unchanged (exists, any intake, any mapping), unbound, terminal; the
-- mapping refusals; and every refusal writes nothing.
do $$
declare
  k_t0 constant timestamptz := _r1_mpi_tests.t0();
  k_m1 constant uuid := _r1_mpi_tests.id(13, 1);
  v jsonb;
  v_before jsonb;
  v_snap jsonb;
  v_id uuid;
  v_job text;
begin
  -- A bound resume_parsing link on the PAUSED M3 is adopted unchanged: the link is read before the
  -- mapping.
  v_id := _r1_mpi_tests.link(188, _r1_mpi_tests.id(13, 3), _r1_mpi_tests.cand(188));
  v_snap := (select jsonb_build_array(to_jsonb(l), to_jsonb(c)) from screening_v2.ashby_application_links l
               join screening_v2.candidates c on c.id = l.candidate_id where l.id = v_id);
  v_before := _r1_mpi_tests.counts();
  v := _r1_mpi_tests.import_app(188, 'mpi-job-3', _r1_mpi_tests.name(188), _r1_mpi_tests.email(188), _r1_mpi_tests.phone(188));
  perform _r1_mpi_tests.assert('G an existing bound resume_parsing link answers exists with its ids',
    v = jsonb_build_object('status', 'exists', 'candidate_id', _r1_mpi_tests.id(10, 188)::text,
                           'application_link_id', v_id::text), v::text);
  perform _r1_mpi_tests.assert('G the adopted link and its candidate are unchanged, the intake still resume_parsing',
    (select jsonb_build_array(to_jsonb(l), to_jsonb(c)) from screening_v2.ashby_application_links l
       join screening_v2.candidates c on c.id = l.candidate_id where l.id = v_id) = v_snap
    and (select l.intake_type from screening_v2.ashby_application_links l where l.id = v_id) = 'resume_parsing');
  perform _r1_mpi_tests.assert('G the adoption wrote nothing', _r1_mpi_tests.counts() = v_before);

  -- A phone_parsing link, and a link Christy completed (terminal_state null): both adopted.
  v_id := _r1_mpi_tests.link(189, k_m1, _r1_mpi_tests.cand(189), 'phone_parsing');
  v := _r1_mpi_tests.import_app(189);
  perform _r1_mpi_tests.assert('G an existing phone_parsing link answers exists',
    v = jsonb_build_object('status', 'exists', 'candidate_id', _r1_mpi_tests.id(10, 189)::text,
                           'application_link_id', v_id::text), v::text);
  v_id := _r1_mpi_tests.link(190, k_m1, _r1_mpi_tests.cand(190));
  update screening_v2.ashby_application_links set lifecycle = 'completed' where id = v_id;
  v := _r1_mpi_tests.import_app(190);
  perform _r1_mpi_tests.assert('G a completed (not terminal) link answers exists: only terminal_state makes it terminal',
    v = jsonb_build_object('status', 'exists', 'candidate_id', _r1_mpi_tests.id(10, 190)::text,
                           'application_link_id', v_id::text), v::text);

  -- An unbound link (an import mid-flight) and a terminal link; the unknown job never matters.
  perform _r1_mpi_tests.link(186, k_m1, null);
  perform _r1_mpi_tests.link(187, k_m1, _r1_mpi_tests.cand(187), p_terminal => 'manual_stage_cancel');
  v_before := _r1_mpi_tests.counts();
  v := _r1_mpi_tests.import_app(186, 'mpi-job-99');
  perform _r1_mpi_tests.assert('G a link with no candidate yet answers link_unbound',
    v = '{"status":"refused","code":"link_unbound"}'::jsonb, v::text);
  v := _r1_mpi_tests.import_app(187, 'mpi-job-99');
  perform _r1_mpi_tests.assert('G a terminal link answers application_terminal',
    v = '{"status":"refused","code":"application_terminal"}'::jsonb, v::text);
  perform _r1_mpi_tests.assert('G link_unbound and application_terminal wrote nothing',
    _r1_mpi_tests.counts() = v_before
    and (select l.candidate_id from screening_v2.ashby_application_links l where l.id = _r1_mpi_tests.link_of(186)) is null);

  -- No live enabled mapping for the job: paused, drift, archived, unknown.
  foreach v_job in array array['mpi-job-3', 'mpi-job-4', 'mpi-job-5', 'mpi-job-99'] loop
    v_before := _r1_mpi_tests.counts();
    v := _r1_mpi_tests.import_app(192, v_job, _r1_mpi_tests.name(192), _r1_mpi_tests.email(192), _r1_mpi_tests.phone(192));
    perform _r1_mpi_tests.assert('G mapping_unavailable for ' || v_job
                                 || case v_job when 'mpi-job-3' then ' (paused)' when 'mpi-job-4' then ' (drift)'
                                               when 'mpi-job-5' then ' (archived)' else ' (unknown job)' end,
      v = '{"status":"refused","code":"mapping_unavailable"}'::jsonb, v::text);
    perform _r1_mpi_tests.assert('G mapping_unavailable for ' || v_job || ' wrote nothing',
      _r1_mpi_tests.counts() = v_before and _r1_mpi_tests.link_of(192) is null);
  end loop;
end;
$$;

-- G4. Holds over the Ashby person: dsar_hold (the 0130 DSAR hold, a subject_erasure link, a link on
-- the erasure list), then candidate_ineligible (a decision block), each before the link and the
-- mapping; the precedence; and each refusal writes nothing.
do $$
declare
  k_t0 constant timestamptz := _r1_mpi_tests.t0();
  k_m1 constant uuid := _r1_mpi_tests.id(13, 1);
  v jsonb;
  v_before jsonb;
  v_c uuid;
begin
  -- (i) A held candidate of the same Ashby person on another application; the id typed in upper case.
  v_c := _r1_mpi_tests.cand(170);
  perform _r1_mpi_tests.link(170, k_m1, v_c);
  perform _r1_mpi_tests.dsar(170, v_c, 'restrict', 'pending');
  -- ... and the other way round: stored in upper case, asked in lower case.
  v_c := _r1_mpi_tests.cand(172);
  insert into screening_v2.ashby_application_links (external_application_id, external_candidate_id, job_mapping_id, candidate_id)
  values (_r1_mpi_tests.id(22, 172)::text, upper(_r1_mpi_tests.id(26, 172)::text), k_m1, v_c);
  perform _r1_mpi_tests.dsar(172, v_c, 'delete', 'in_progress');
  -- (ii) A link of the person that an erasure terminated (no candidate left).
  perform _r1_mpi_tests.link(174, k_m1, null, p_terminal => 'deleted', p_terminal_reason => 'subject_erasure');
  -- (iii) A link of the person on the erasure list.
  perform _r1_mpi_tests.link(176, k_m1, null);
  insert into screening_v2.ashby_erased_application_links (application_link_id) values (_r1_mpi_tests.link_of(176));
  -- (iv) This application's own link (another person id), its candidate held: dsar_hold beats exists.
  v_c := _r1_mpi_tests.cand(178);
  perform _r1_mpi_tests.link(178, k_m1, v_c, p_person => 179);
  perform _r1_mpi_tests.dsar(178, v_c, 'correct', 'fulfilled');
  -- Decision blocks: the person's other application, and this application's own link.
  v_c := _r1_mpi_tests.cand(180);
  perform _r1_mpi_tests.link(180, k_m1, v_c);
  update screening_v2.candidates set decision_use_blocked_at = k_t0 where id = v_c;
  v_c := _r1_mpi_tests.cand(182);
  perform _r1_mpi_tests.link(182, k_m1, v_c, p_person => 183);
  update screening_v2.candidates set decision_use_blocked_at = k_t0 where id = v_c;
  -- Precedence: person 184 has a terminal link of this application with a decision-blocked
  -- candidate AND another link with a held candidate; person 185 the terminal blocked link only;
  -- person 187 is the plain terminal link of G3.
  v_c := _r1_mpi_tests.cand(184);
  perform _r1_mpi_tests.link(184, k_m1, v_c, p_terminal => 'withdrawn');
  update screening_v2.candidates set decision_use_blocked_at = k_t0 where id = v_c;
  v_c := _r1_mpi_tests.cand(194);
  perform _r1_mpi_tests.link(194, k_m1, v_c, p_person => 184);
  perform _r1_mpi_tests.dsar(194, v_c, 'restrict', 'in_progress');
  v_c := _r1_mpi_tests.cand(185);
  perform _r1_mpi_tests.link(185, k_m1, v_c, p_terminal => 'withdrawn');
  update screening_v2.candidates set decision_use_blocked_at = k_t0 where id = v_c;

  v_before := _r1_mpi_tests.counts();
  v := screening_v2.r1_meet_public_import_application(_r1_mpi_tests.id(22, 171)::text, upper(_r1_mpi_tests.id(26, 170)::text),
         'mpi-job-1', 'mpi-stage-1', _r1_mpi_tests.name(171), _r1_mpi_tests.email(171), _r1_mpi_tests.phone(171), k_t0);
  perform _r1_mpi_tests.assert('G dsar_hold: a held candidate of the same Ashby person, the id in upper case',
    v = '{"status":"refused","code":"dsar_hold"}'::jsonb, v::text);
  v := screening_v2.r1_meet_public_import_application(_r1_mpi_tests.id(22, 173)::text, _r1_mpi_tests.id(26, 172)::text,
         'mpi-job-1', null, null, null, null, k_t0);
  perform _r1_mpi_tests.assert('G dsar_hold: the person''s id stored in upper case, asked in lower case',
    v = '{"status":"refused","code":"dsar_hold"}'::jsonb, v::text);
  v := screening_v2.r1_meet_public_import_application(_r1_mpi_tests.id(22, 175)::text, _r1_mpi_tests.id(26, 174)::text,
         'mpi-job-1', null, null, null, null, k_t0);
  perform _r1_mpi_tests.assert('G dsar_hold: a link of the person terminated by an erasure (subject_erasure)',
    v = '{"status":"refused","code":"dsar_hold"}'::jsonb, v::text);
  v := screening_v2.r1_meet_public_import_application(_r1_mpi_tests.id(22, 177)::text, _r1_mpi_tests.id(26, 176)::text,
         'mpi-job-1', null, null, null, null, k_t0);
  perform _r1_mpi_tests.assert('G dsar_hold: a link of the person on the erasure list',
    v = '{"status":"refused","code":"dsar_hold"}'::jsonb, v::text);
  v := _r1_mpi_tests.import_app(178);
  perform _r1_mpi_tests.assert('G dsar_hold: this application''s own link has a held candidate (before exists)',
    v = '{"status":"refused","code":"dsar_hold"}'::jsonb, v::text);
  v := screening_v2.r1_meet_public_import_application(_r1_mpi_tests.id(22, 181)::text, _r1_mpi_tests.id(26, 180)::text,
         'mpi-job-1', null, null, null, null, k_t0);
  perform _r1_mpi_tests.assert('G candidate_ineligible: a decision-blocked candidate of the same Ashby person',
    v = '{"status":"refused","code":"candidate_ineligible"}'::jsonb, v::text);
  v := _r1_mpi_tests.import_app(182);
  perform _r1_mpi_tests.assert('G candidate_ineligible: this application''s own link has a blocked candidate (before exists)',
    v = '{"status":"refused","code":"candidate_ineligible"}'::jsonb, v::text);
  v := _r1_mpi_tests.import_app(184);
  perform _r1_mpi_tests.assert('G precedence: dsar_hold before candidate_ineligible and application_terminal',
    v = '{"status":"refused","code":"dsar_hold"}'::jsonb, v::text);
  v := _r1_mpi_tests.import_app(185);
  perform _r1_mpi_tests.assert('G precedence: candidate_ineligible before application_terminal',
    v = '{"status":"refused","code":"candidate_ineligible"}'::jsonb, v::text);
  v := _r1_mpi_tests.import_app(187, 'mpi-job-99');
  perform _r1_mpi_tests.assert('G precedence: application_terminal before mapping_unavailable',
    v = '{"status":"refused","code":"application_terminal"}'::jsonb, v::text);
  v := _r1_mpi_tests.import_app(184, p_phone => '+1');
  perform _r1_mpi_tests.assert('G precedence: invalid_request before every refusal',
    v = '{"status":"invalid_request","field":"phone"}'::jsonb, v::text);
  perform _r1_mpi_tests.assert('G the holds wrote nothing (no link for the asked applications)',
    _r1_mpi_tests.counts() = v_before
    and _r1_mpi_tests.link_of(171) is null and _r1_mpi_tests.link_of(173) is null
    and _r1_mpi_tests.link_of(175) is null and _r1_mpi_tests.link_of(177) is null
    and _r1_mpi_tests.link_of(181) is null);
end;
$$;

-- G4b. One R1 per Ashby person (S12 fix round F3): a person with a completed or counted sales_r1
-- round under another local candidate is candidate_ineligible, case ignored, after the adoption
-- and before the mapping; an uncounted cancelled, expired or live round is not a done R1; another
-- person's R1 never counts; each refusal writes nothing.
do $$
declare
  k_t0 constant timestamptz := _r1_mpi_tests.t0();
  k_m1 constant uuid := _r1_mpi_tests.id(13, 1);
  v jsonb;
  v_before jsonb;
  v_c uuid;
begin
  -- Person 300: a completed R1 under candidate 300 (application 300).
  v_c := _r1_mpi_tests.cand(300);
  perform _r1_mpi_tests.link(300, k_m1, v_c);
  perform _r1_mpi_tests.sales_round(300, v_c, 'completed', 1);
  -- Person 302: HR's retake round, cancelled, keeps its counted attempt.
  v_c := _r1_mpi_tests.cand(302);
  perform _r1_mpi_tests.link(302, k_m1, v_c);
  perform _r1_mpi_tests.sales_round(302, v_c, 'cancelled', 1);
  -- Person 304: a round in progress with a counted attempt.
  v_c := _r1_mpi_tests.cand(304);
  perform _r1_mpi_tests.link(304, k_m1, v_c);
  perform _r1_mpi_tests.sales_round(304, v_c, 'in_progress', 1);
  -- Person 306: a cancelled and an expired round, neither with a counted attempt.
  v_c := _r1_mpi_tests.cand(306);
  perform _r1_mpi_tests.link(306, k_m1, v_c);
  perform _r1_mpi_tests.sales_round(306, v_c, 'cancelled', 0);
  perform _r1_mpi_tests.sales_round(307, v_c, 'expired', 0);
  -- Person 308: a live, uncounted invited round (not a done R1; see contracts 9).
  v_c := _r1_mpi_tests.cand(308);
  perform _r1_mpi_tests.link(308, k_m1, v_c);
  perform _r1_mpi_tests.sales_round(308, v_c, 'invited', 0);
  -- Person 310: a completed R1 of ANOTHER person (310) than the one imported (311).
  v_c := _r1_mpi_tests.cand(310);
  perform _r1_mpi_tests.link(310, k_m1, v_c);
  perform _r1_mpi_tests.sales_round(310, v_c, 'completed', 1);
  -- Application 312's own bound link, whose candidate has a completed R1: adopted (exists).
  v_c := _r1_mpi_tests.cand(312);
  perform _r1_mpi_tests.link(312, k_m1, v_c);
  perform _r1_mpi_tests.sales_round(312, v_c, 'completed', 1);
  -- Person 314: a DSAR hold AND a completed R1 under candidate 314.
  v_c := _r1_mpi_tests.cand(314);
  perform _r1_mpi_tests.link(314, k_m1, v_c);
  perform _r1_mpi_tests.dsar(314, v_c, 'restrict', 'pending');
  perform _r1_mpi_tests.sales_round(314, v_c, 'completed', 1);

  v_before := _r1_mpi_tests.counts();
  v := screening_v2.r1_meet_public_import_application(_r1_mpi_tests.id(22, 301)::text, _r1_mpi_tests.id(26, 300)::text,
         'mpi-job-1', 'mpi-stage-1', _r1_mpi_tests.name(301), _r1_mpi_tests.email(301), _r1_mpi_tests.phone(301), k_t0);
  perform _r1_mpi_tests.assert('G R1 per person: a completed R1 under another candidate of the person is candidate_ineligible',
    v = '{"status":"refused","code":"candidate_ineligible"}'::jsonb, v::text);
  v := screening_v2.r1_meet_public_import_application(_r1_mpi_tests.id(22, 301)::text, upper(_r1_mpi_tests.id(26, 300)::text),
         'mpi-job-1', 'mpi-stage-1', null, null, null, k_t0);
  perform _r1_mpi_tests.assert('G R1 per person: the person id asked in upper case still matches',
    v = '{"status":"refused","code":"candidate_ineligible"}'::jsonb, v::text);
  v := screening_v2.r1_meet_public_import_application(_r1_mpi_tests.id(22, 303)::text, _r1_mpi_tests.id(26, 302)::text,
         'mpi-job-1', null, null, null, null, k_t0);
  perform _r1_mpi_tests.assert('G R1 per person: a cancelled round that holds a counted attempt is a done R1',
    v = '{"status":"refused","code":"candidate_ineligible"}'::jsonb, v::text);
  v := screening_v2.r1_meet_public_import_application(_r1_mpi_tests.id(22, 305)::text, _r1_mpi_tests.id(26, 304)::text,
         'mpi-job-1', null, null, null, null, k_t0);
  perform _r1_mpi_tests.assert('G R1 per person: a round in progress with a counted attempt is a done R1',
    v = '{"status":"refused","code":"candidate_ineligible"}'::jsonb, v::text);
  v := screening_v2.r1_meet_public_import_application(_r1_mpi_tests.id(22, 301)::text, _r1_mpi_tests.id(26, 300)::text,
         'mpi-job-99', null, null, null, null, k_t0);
  perform _r1_mpi_tests.assert('G precedence: candidate_ineligible (a done R1) before mapping_unavailable',
    v = '{"status":"refused","code":"candidate_ineligible"}'::jsonb, v::text);
  v := screening_v2.r1_meet_public_import_application(_r1_mpi_tests.id(22, 315)::text, _r1_mpi_tests.id(26, 314)::text,
         'mpi-job-1', null, null, null, null, k_t0);
  perform _r1_mpi_tests.assert('G precedence: dsar_hold before a done R1',
    v = '{"status":"refused","code":"dsar_hold"}'::jsonb, v::text);
  perform _r1_mpi_tests.assert('G the done-R1 refusals wrote nothing',
    _r1_mpi_tests.counts() = v_before
    and _r1_mpi_tests.link_of(301) is null and _r1_mpi_tests.link_of(303) is null
    and _r1_mpi_tests.link_of(305) is null and _r1_mpi_tests.link_of(315) is null);

  v := _r1_mpi_tests.import_app(312);
  perform _r1_mpi_tests.assert('G an existing link of this application is adopted before the R1 rule (the book path decides)',
    v ->> 'status' = 'exists' and v ->> 'candidate_id' = _r1_mpi_tests.id(10, 312)::text, v::text);
  v := screening_v2.r1_meet_public_import_application(_r1_mpi_tests.id(22, 309)::text, _r1_mpi_tests.id(26, 306)::text,
         'mpi-job-1', null, null, null, null, k_t0);
  perform _r1_mpi_tests.assert('G R1 per person: uncounted cancelled and expired rounds are not a done R1',
    v ->> 'status' = 'imported', v::text);
  v := screening_v2.r1_meet_public_import_application(_r1_mpi_tests.id(22, 317)::text, _r1_mpi_tests.id(26, 308)::text,
         'mpi-job-1', null, null, null, null, k_t0);
  perform _r1_mpi_tests.assert('G R1 per person: a live, uncounted round elsewhere is not a done R1',
    v ->> 'status' = 'imported', v::text);
  v := screening_v2.r1_meet_public_import_application(_r1_mpi_tests.id(22, 311)::text, _r1_mpi_tests.id(26, 311)::text,
         'mpi-job-1', null, null, null, null, k_t0);
  perform _r1_mpi_tests.assert('G R1 per person: another person''s completed R1 never counts',
    v ->> 'status' = 'imported', v::text);
end;
$$;

-- G5. Privileges, by trying: anon and authenticated are refused both RPCs (and the claim); service_role
-- runs both (each call rolled back by runs_as).
do $$
declare
  k_t0 constant timestamptz := _r1_mpi_tests.t0();
  v jsonb;
  v_import_sql text := format(
    'select screening_v2.r1_meet_public_import_application(%L, %L, %L, null, null, null, null, %L::timestamptz)',
    _r1_mpi_tests.id(22, 196)::text, _r1_mpi_tests.id(26, 196)::text, 'mpi-job-1', k_t0);
  v_local_sql text := format('select screening_v2.r1_meet_public_local_rows(%L, null)', _r1_mpi_tests.email(100));
  v_claim_sql text := format(
    'select coalesce(jsonb_agg(d.application_link_id), %L::jsonb) from screening_v2.claim_ashby_profile_due(50, 900, 21600, 4, %L::timestamptz) d',
    '[]', k_t0);
  v_role text;
begin
  foreach v_role in array array['anon', 'authenticated'] loop
    perform _r1_mpi_tests.raises_as(v_role, 'G r1_meet_public_import_application', v_import_sql, '42501');
    perform _r1_mpi_tests.raises_as(v_role, 'G r1_meet_public_local_rows', v_local_sql, '42501');
    perform _r1_mpi_tests.raises_as(v_role, 'G claim_ashby_profile_due', v_claim_sql, '42501');
  end loop;
  v := _r1_mpi_tests.runs_as('service_role', 'G r1_meet_public_import_application', v_import_sql);
  perform _r1_mpi_tests.assert('G service_role: the import answers imported', v ->> 'status' = 'imported', v::text);
  v := _r1_mpi_tests.runs_as('service_role', 'G r1_meet_public_local_rows', v_local_sql);
  perform _r1_mpi_tests.assert('G service_role: the lookup answers ok',
    v = _r1_mpi_tests.ok_rows(_r1_mpi_tests.local_row(100, 'email', 100, false, true)), v::text);
  perform _r1_mpi_tests.assert('G the service_role import left nothing behind (rolled back)',
    _r1_mpi_tests.link_of(196) is null);
end;
$$;

-- =================================================================================================
-- H. The Christy phone funnel leaves an on-the-spot import out (S12 fix round F1).
-- =================================================================================================
-- v_funnel_candidate has one row per candidate; without the 0144 hunk every import would join its
-- mapped role's funnel as parsed, missing_phone and not_dialed, and the funnel_stage_daily rollup
-- (refresh_funnel_rollup, 0098) would count it. Every import of sections E, G and H is created at
-- the pinned clock on role 1, so the rollup's (2026-12-01, role 1) grain holds many of them.
do $$
declare
  k_t0 constant timestamptz := _r1_mpi_tests.t0();
  k_m1 constant uuid := _r1_mpi_tests.id(13, 1);
  k_role constant uuid := _r1_mpi_tests.id(2, 1);
  v jsonb;
  v_shell uuid;
  v_rp uuid;
  v_pp uuid;
  v_mixed uuid;
  v_bare uuid;
  v_only bigint;
  v_view bigint;
  v_all bigint;
  v_rolled bigint;
begin
  -- An import WITH a dialable Ashby number: still not a Christy funnel candidate.
  v := _r1_mpi_tests.import_app(320, 'mpi-job-1', _r1_mpi_tests.name(320), _r1_mpi_tests.email(320),
                                _r1_mpi_tests.phone(320));
  perform _r1_mpi_tests.assert('H setup: an on-the-spot import with a number', v ->> 'status' = 'imported', v::text);
  v_shell := (v ->> 'candidate_id')::uuid;
  -- Controls: a resume_parsing and a phone_parsing candidate, a candidate with an r1_public_booking
  -- link AND a resume link (not an import-only candidate), and a candidate with no link at all.
  v_rp := _r1_mpi_tests.cand(321);
  perform _r1_mpi_tests.link(321, k_m1, v_rp);
  v_pp := _r1_mpi_tests.cand(322);
  perform _r1_mpi_tests.link(322, k_m1, v_pp, 'phone_parsing');
  v_mixed := _r1_mpi_tests.cand(323);
  perform _r1_mpi_tests.link(323, k_m1, v_mixed, 'r1_public_booking');
  perform _r1_mpi_tests.link(324, k_m1, v_mixed);
  v_bare := _r1_mpi_tests.cand(325);

  perform _r1_mpi_tests.assert('H the import is not in v_funnel_candidate, and its shell still exists',
    not exists (select 1 from screening_v2.v_funnel_candidate f where f.candidate_id = v_shell)
    and exists (select 1 from screening_v2.candidates c where c.id = v_shell));
  perform _r1_mpi_tests.assert('H the resume, phone-parsing, mixed and link-less candidates are all in the funnel',
    (select count(*) from screening_v2.v_funnel_candidate f
      where f.candidate_id in (v_rp, v_pp, v_mixed, v_bare)) = 4);
  perform _r1_mpi_tests.assert('H the control candidates keep their 0122 reading (parsed, missing_phone, not_dialed)',
    (select bool_and(f.furthest_stage = 'parsed' and f.missing_phone and f.drop_reason = 'not_dialed')
       from screening_v2.v_funnel_candidate f where f.candidate_id in (v_rp, v_pp, v_mixed, v_bare)));

  select count(*) into v_only
    from screening_v2.candidates c
   where exists (select 1 from screening_v2.ashby_application_links l
                  where l.candidate_id = c.id and l.intake_type = 'r1_public_booking')
     and not exists (select 1 from screening_v2.ashby_application_links l
                      where l.candidate_id = c.id and l.intake_type <> 'r1_public_booking');
  perform _r1_mpi_tests.assert('H many import-only candidates exist by now (the next check is not vacuous)',
    v_only >= 5, v_only::text);
  perform _r1_mpi_tests.assert('H no import-only candidate is anywhere in the funnel',
    not exists (select 1 from screening_v2.v_funnel_candidate f
                 where exists (select 1 from screening_v2.ashby_application_links l
                                where l.candidate_id = f.candidate_id and l.intake_type = 'r1_public_booking')
                   and not exists (select 1 from screening_v2.ashby_application_links l
                                    where l.candidate_id = f.candidate_id and l.intake_type <> 'r1_public_booking')));
  perform _r1_mpi_tests.assert('H every other candidate still has exactly one funnel row',
    (select count(*) from screening_v2.v_funnel_candidate)
      = (select count(*) from screening_v2.candidates) - v_only
    and (select count(*) from screening_v2.v_funnel_candidate)
      = (select count(distinct f.candidate_id) from screening_v2.v_funnel_candidate f));

  -- The stored rollup is built from the view, so the imports are left out of it too.
  v := screening_v2.refresh_funnel_rollup(k_t0, 30);
  perform _r1_mpi_tests.assert('H refresh_funnel_rollup runs', v ->> 'status' = 'ok', v::text);
  select count(*) into v_view from screening_v2.v_funnel_candidate f
   where f.cohort_day = (k_t0)::date and f.role_id = k_role;
  select count(*) into v_all from screening_v2.candidates c
   where (c.created_at)::date = (k_t0)::date and c.role_id = k_role;
  select coalesce((select d.candidates_total from screening_v2.funnel_stage_daily d
                    where d.cohort_day = (k_t0)::date and d.role_id = k_role), 0) into v_rolled;
  perform _r1_mpi_tests.assert('H the rollup''s candidates_total for the imports'' day and role counts no import',
    v_rolled = v_view and v_all > v_view,
    'rolled ' || v_rolled || ', view ' || v_view || ', all ' || v_all);
end;
$$;

-- =================================================================================================
-- I. r1_meet_public_person_r1_check: one R1 per Ashby person on the book path (S12 fix round F3).
-- =================================================================================================
do $$
declare
  k_m1 constant uuid := _r1_mpi_tests.id(13, 1);
  v jsonb;
  v_before jsonb;
  v_c uuid;
  v_role text;
  v_sql text;
begin
  -- Person 340: candidate 340 is to be booked; the person's other candidate 341 completed R1.
  v_c := _r1_mpi_tests.cand(340);
  perform _r1_mpi_tests.link(340, k_m1, v_c);
  v_c := _r1_mpi_tests.cand(341);
  perform _r1_mpi_tests.link(341, k_m1, v_c, p_person => 340);
  perform _r1_mpi_tests.sales_round(341, v_c, 'completed', 1);
  -- Person 342: the other row stores the person id in upper case; its cancelled retake was counted.
  v_c := _r1_mpi_tests.cand(342);
  perform _r1_mpi_tests.link(342, k_m1, v_c);
  v_c := _r1_mpi_tests.cand(343);
  insert into screening_v2.ashby_application_links (external_application_id, external_candidate_id, job_mapping_id, candidate_id)
  values (_r1_mpi_tests.id(22, 343)::text, upper(_r1_mpi_tests.id(26, 342)::text), k_m1, v_c);
  perform _r1_mpi_tests.sales_round(343, v_c, 'cancelled', 1);
  -- Person 344: the other row has only uncounted cancelled and expired rounds.
  v_c := _r1_mpi_tests.cand(344);
  perform _r1_mpi_tests.link(344, k_m1, v_c);
  v_c := _r1_mpi_tests.cand(345);
  perform _r1_mpi_tests.link(345, k_m1, v_c, p_person => 344);
  perform _r1_mpi_tests.sales_round(345, v_c, 'cancelled', 0);
  perform _r1_mpi_tests.sales_round(346, v_c, 'expired', 0);
  -- Candidate 347: its OWN completed R1 is the 0143 precheck's, not this lookup's.
  v_c := _r1_mpi_tests.cand(347);
  perform _r1_mpi_tests.link(347, k_m1, v_c);
  perform _r1_mpi_tests.sales_round(347, v_c, 'completed', 1);
  -- Person 348: another PERSON (349) completed R1.
  v_c := _r1_mpi_tests.cand(348);
  perform _r1_mpi_tests.link(348, k_m1, v_c);
  v_c := _r1_mpi_tests.cand(349);
  perform _r1_mpi_tests.link(349, k_m1, v_c);
  perform _r1_mpi_tests.sales_round(349, v_c, 'completed', 1);
  -- Person 350: the other row has a live, uncounted invited round (not a done R1; contracts 9).
  v_c := _r1_mpi_tests.cand(350);
  perform _r1_mpi_tests.link(350, k_m1, v_c);
  v_c := _r1_mpi_tests.cand(351);
  perform _r1_mpi_tests.link(351, k_m1, v_c, p_person => 350);
  perform _r1_mpi_tests.sales_round(351, v_c, 'invited', 0);
  -- Person 352: the other row's round is in progress with a counted attempt.
  v_c := _r1_mpi_tests.cand(352);
  perform _r1_mpi_tests.link(352, k_m1, v_c);
  v_c := _r1_mpi_tests.cand(353);
  perform _r1_mpi_tests.link(353, k_m1, v_c, p_person => 352);
  perform _r1_mpi_tests.sales_round(353, v_c, 'in_progress', 1);
  -- Candidates 354 and 355: two links with NO Ashby candidate id; 355 completed R1.
  v_c := _r1_mpi_tests.cand(354);
  insert into screening_v2.ashby_application_links (external_application_id, job_mapping_id, candidate_id)
  values (_r1_mpi_tests.id(22, 354)::text, k_m1, v_c);
  v_c := _r1_mpi_tests.cand(355);
  insert into screening_v2.ashby_application_links (external_application_id, job_mapping_id, candidate_id)
  values (_r1_mpi_tests.id(22, 355)::text, k_m1, v_c);
  perform _r1_mpi_tests.sales_round(355, v_c, 'completed', 1);

  v_before := _r1_mpi_tests.counts();

  -- Invalid input: a closed field, the candidate first; nothing read.
  v := screening_v2.r1_meet_public_person_r1_check(null, null);
  perform _r1_mpi_tests.assert('I invalid_request: candidate_id first', v = '{"status":"invalid_request","field":"candidate_id"}'::jsonb, v::text);
  v := screening_v2.r1_meet_public_person_r1_check(_r1_mpi_tests.id(10, 340), null);
  perform _r1_mpi_tests.assert('I invalid_request: a null application id', v = '{"status":"invalid_request","field":"application_id"}'::jsonb, v::text);
  v := screening_v2.r1_meet_public_person_r1_check(_r1_mpi_tests.id(10, 340), 'mpi-app-not-a-uuid');
  perform _r1_mpi_tests.assert('I invalid_request: an application id that is not UUID-shaped', v = '{"status":"invalid_request","field":"application_id"}'::jsonb, v::text);

  -- application_unknown: no link, a link bound to another candidate, the id in another case.
  v := _r1_mpi_tests.person(340, 399);
  perform _r1_mpi_tests.assert('I application_unknown: no link for the application', v = '{"status":"refused","code":"application_unknown"}'::jsonb, v::text);
  v := _r1_mpi_tests.person(340, 341);
  perform _r1_mpi_tests.assert('I application_unknown: the link is bound to another candidate', v = '{"status":"refused","code":"application_unknown"}'::jsonb, v::text);
  v := screening_v2.r1_meet_public_person_r1_check(_r1_mpi_tests.id(10, 340), upper(_r1_mpi_tests.id(22, 340)::text));
  perform _r1_mpi_tests.assert('I application_unknown: the application id is matched verbatim (as the 0143 precheck does)',
    v = '{"status":"refused","code":"application_unknown"}'::jsonb, v::text);

  -- r1_completed: another candidate of the same person did R1.
  v := _r1_mpi_tests.person(340, 340);
  perform _r1_mpi_tests.assert('I r1_completed: another candidate of the person completed R1', v = '{"status":"refused","code":"r1_completed"}'::jsonb, v::text);
  v := _r1_mpi_tests.person(342, 342);
  perform _r1_mpi_tests.assert('I r1_completed: case ignored, and a cancelled round with a counted attempt', v = '{"status":"refused","code":"r1_completed"}'::jsonb, v::text);
  v := _r1_mpi_tests.person(352, 352);
  perform _r1_mpi_tests.assert('I r1_completed: a round in progress with a counted attempt', v = '{"status":"refused","code":"r1_completed"}'::jsonb, v::text);
  v := _r1_mpi_tests.person(341, 341);
  perform _r1_mpi_tests.assert('I eligible for the candidate who did R1 (the precheck answers its own rounds)', v = '{"status":"eligible"}'::jsonb, v::text);

  -- eligible otherwise.
  v := _r1_mpi_tests.person(344, 344);
  perform _r1_mpi_tests.assert('I eligible: uncounted cancelled and expired rounds elsewhere', v = '{"status":"eligible"}'::jsonb, v::text);
  v := _r1_mpi_tests.person(347, 347);
  perform _r1_mpi_tests.assert('I eligible: the candidate''s own completed R1 is left to the precheck', v = '{"status":"eligible"}'::jsonb, v::text);
  v := _r1_mpi_tests.person(348, 348);
  perform _r1_mpi_tests.assert('I eligible: another person''s R1 never counts', v = '{"status":"eligible"}'::jsonb, v::text);
  v := _r1_mpi_tests.person(350, 350);
  perform _r1_mpi_tests.assert('I eligible: a live, uncounted round elsewhere is not a done R1', v = '{"status":"eligible"}'::jsonb, v::text);
  v := _r1_mpi_tests.person(354, 354);
  perform _r1_mpi_tests.assert('I eligible: a link with no Ashby candidate id is never matched to another row', v = '{"status":"eligible"}'::jsonb, v::text);

  perform _r1_mpi_tests.assert('I the lookup wrote nothing', _r1_mpi_tests.counts() = v_before);

  -- Privileges, by trying.
  v_sql := format('select screening_v2.r1_meet_public_person_r1_check(%L::uuid, %L)',
                  _r1_mpi_tests.id(10, 340), _r1_mpi_tests.id(22, 340)::text);
  foreach v_role in array array['anon', 'authenticated'] loop
    perform _r1_mpi_tests.raises_as(v_role, 'I r1_meet_public_person_r1_check', v_sql, '42501');
  end loop;
  v := _r1_mpi_tests.runs_as('service_role', 'I r1_meet_public_person_r1_check', v_sql);
  perform _r1_mpi_tests.assert('I service_role: the lookup answers r1_completed',
    v = '{"status":"refused","code":"r1_completed"}'::jsonb, v::text);
end;
$$;

do $$
declare
  n integer;
begin
  select count(*) into n from _r1_mpi_tests.passed;
  raise notice 'R1 MPI: % assertions passed', n;
end;
$$;

rollback;
