-- =====================================================================
-- Policy & Constraint Tests — Run AFTER all migrations are applied.
--
-- Designed to run via psql as the 'postgres' superuser. Each test
-- block switches to the appropriate role (anon/authenticated) before
-- asserting access controls. Superuser checks (policy existence,
-- constraints) run as postgres.
--
-- Idempotent: drops _policy_tests schema on each run.
-- =====================================================================

-- Ephemeral result table
create schema if not exists _policy_tests;
drop table if exists _policy_tests.results;
create table _policy_tests.results (
  id          serial primary key,
  test        text not null,
  passed      boolean not null,
  detail      text,
  ran_at      timestamptz not null default now()
);

-- Helper
create or replace function _policy_tests.assert(test text, cond boolean, detail text default null)
returns void language plpgsql as $$
begin
  insert into _policy_tests.results (test, passed, detail) values (test, cond, detail);
end;
$$;

-- =====================================================================
-- 1. ANON DENIAL TESTS (switch to anon role)
-- =====================================================================
set local role anon;

-- Anon has no schema usage → select should error
do $$
declare
  got_error boolean := false;
begin
  begin
    perform 1 from screening_v2.candidates limit 1;
  exception when insufficient_privilege then
    got_error := true;
  end;
  perform _policy_tests.assert(
    'anon: denied access to candidates (insufficient_privilege)',
    got_error,
    'Expected anon to have no access to screening_v2.candidates'
  );
end;
$$;

do $$
declare
  got_error boolean := false;
begin
  begin
    perform 1 from screening_v2.call_sessions limit 1;
  exception when insufficient_privilege then
    got_error := true;
  end;
  perform _policy_tests.assert(
    'anon: denied access to call_sessions (insufficient_privilege)',
    got_error,
    'Expected anon to have no access to screening_v2.call_sessions'
  );
end;
$$;

do $$
declare
  got_error boolean := false;
begin
  begin
    perform 1 from screening_v2.roles limit 1;
  exception when insufficient_privilege then
    got_error := true;
  end;
  perform _policy_tests.assert(
    'anon: denied access to roles (insufficient_privilege)',
    got_error,
    'Expected anon to have no access to screening_v2.roles'
  );
end;
$$;

-- Switch back to postgres for policy checks
reset role;

-- =====================================================================
-- 2. NO BLANKET ANON POLICIES (run as postgres — checks pg_policies)
-- =====================================================================
do $$
declare
  pol_count int;
begin
  select count(*) into pol_count
  from pg_policies
  where schemaname = 'screening_v2'
    and roles @> array['anon'::name];

  perform _policy_tests.assert(
    'no anon policies exist in screening_v2',
    pol_count = 0,
    format('Found %s anon policies — expected 0', pol_count)
  );
end;
$$;

-- =====================================================================
-- 3. AUTHENTICATED SEAMS (check policies exist)
-- =====================================================================
select _policy_tests.assert(
  'authenticated has SELECT policy on candidates',
  exists (
    select 1 from pg_policies
    where schemaname = 'screening_v2'
      and tablename = 'candidates'
      and cmd = 'SELECT'
      and roles @> array['authenticated'::name]
  ),
  'Expected authenticated SELECT policy on candidates'
);

select _policy_tests.assert(
  'authenticated has SELECT policy on call_sessions',
  exists (
    select 1 from pg_policies
    where schemaname = 'screening_v2'
      and tablename = 'call_sessions'
      and cmd = 'SELECT'
      and roles @> array['authenticated'::name]
  ),
  'Expected authenticated SELECT policy on call_sessions'
);

-- =====================================================================
-- 4. AUTHENTICATED CAN READ (role-switch test)
-- =====================================================================
set local role authenticated;

do $$
declare
  got_error boolean := false;
begin
  begin
    perform 1 from screening_v2.candidates limit 1;
  exception when others then
    got_error := true;
  end;
  perform _policy_tests.assert(
    'authenticated: can select from candidates',
    not got_error,
    'Expected authenticated role to read screening_v2.candidates'
  );
end;
$$;

do $$
declare
  got_error boolean := false;
begin
  begin
    perform 1 from screening_v2.call_sessions limit 1;
  exception when others then
    got_error := true;
  end;
  perform _policy_tests.assert(
    'authenticated: can select from call_sessions',
    not got_error,
    'Expected authenticated role to read screening_v2.call_sessions'
  );
end;
$$;

reset role;

-- =====================================================================
-- 5. CHECK CONSTRAINTS
-- =====================================================================
select _policy_tests.assert(
  'CHECK constraint: chk_candidates_status',
  exists (select 1 from pg_constraint where conname = 'chk_candidates_status' and contype = 'c'),
  'Expected chk_candidates_status CHECK constraint'
);

select _policy_tests.assert(
  'CHECK constraint: chk_transcript_turns_speaker',
  exists (select 1 from pg_constraint where conname = 'chk_transcript_turns_speaker' and contype = 'c'),
  'Expected chk_transcript_turns_speaker CHECK constraint'
);

select _policy_tests.assert(
  'CHECK constraint: chk_assessments_recommendation',
  exists (select 1 from pg_constraint where conname = 'chk_assessments_recommendation' and contype = 'c'),
  'Expected chk_assessments_recommendation CHECK constraint'
);

select _policy_tests.assert(
  'CHECK constraint: chk_call_sessions_status',
  exists (select 1 from pg_constraint where conname = 'chk_call_sessions_status' and contype = 'c'),
  'Expected chk_call_sessions_status CHECK constraint'
);

-- =====================================================================
-- 6. UNIQUE CONSTRAINT
-- =====================================================================
select _policy_tests.assert(
  'UNIQUE constraint: transcript_turns(session_id, turn_index)',
  exists (select 1 from pg_constraint where conname = 'uq_transcript_turns_session_turn' and contype = 'u'),
  'Expected unique constraint on transcript_turns(session_id, turn_index)'
);

-- =====================================================================
-- 7. UPDATED_AT TRIGGERS
-- =====================================================================
select _policy_tests.assert(
  'trigger: trg_v2_sessions_updated on call_sessions',
  exists (select 1 from pg_trigger where tgname = 'trg_v2_sessions_updated'),
  'Expected trg_v2_sessions_updated trigger'
);

select _policy_tests.assert(
  'trigger: trg_v2_roles_updated on roles',
  exists (select 1 from pg_trigger where tgname = 'trg_v2_roles_updated'),
  'Expected trg_v2_roles_updated trigger'
);

select _policy_tests.assert(
  'trigger: trg_v2_assess_updated on assessments',
  exists (select 1 from pg_trigger where tgname = 'trg_v2_assess_updated'),
  'Expected trg_v2_assess_updated trigger'
);

-- =====================================================================
-- 8. STORAGE POLICIES
-- =====================================================================
select _policy_tests.assert(
  'storage: authenticated read policy on resumes_v2',
  exists (
    select 1 from pg_policies
    where schemaname = 'storage'
      and tablename = 'objects'
      and policyname = 'authenticated read resumes_v2'
  ),
  'Expected storage policy "authenticated read resumes_v2"'
);

select _policy_tests.assert(
  'storage: authenticated write policy on resumes_v2',
  exists (
    select 1 from pg_policies
    where schemaname = 'storage'
      and tablename = 'objects'
      and policyname = 'authenticated write resumes_v2'
  ),
  'Expected storage policy "authenticated write resumes_v2"'
);

select _policy_tests.assert(
  'storage: anon denied all storage access',
  exists (
    select 1 from pg_policies
    where schemaname = 'storage'
      and tablename = 'objects'
      and policyname = 'anon deny all storage'
  ),
  'Expected storage policy "anon deny all storage"'
);

-- =====================================================================
-- 9. GRANTS — anon has zero table privileges
-- =====================================================================
do $$
declare
  anon_table_privs int;
begin
  select count(*) into anon_table_privs
  from information_schema.role_table_grants
  where grantee = 'anon'
    and table_schema = 'screening_v2';

  perform _policy_tests.assert(
    'anon has zero table privileges on screening_v2',
    anon_table_privs = 0,
    format('Anon has %s table privileges — expected 0', anon_table_privs)
  );
end;
$$;

-- =====================================================================
-- 10. AUTHENTICATED HAS USAGE ON SCHEMA
-- =====================================================================
select _policy_tests.assert(
  'authenticated has USAGE on schema screening_v2',
  exists (
    select 1 from information_schema.usage_privileges
    where grantee = 'authenticated'
      and object_type = 'SCHEMA'
      and object_name = 'screening_v2'
  ),
  'Expected authenticated to have USAGE on screening_v2'
);

-- =====================================================================
-- REPORT & VERDICT
-- =====================================================================
select test,
       case when passed then 'PASS' else 'FAIL' end as result,
       detail
from _policy_tests.results
order by id;

do $$
declare
  failures int;
  total int;
begin
  select count(*) into total   from _policy_tests.results;
  select count(*) into failures from _policy_tests.results where not passed;
  if failures > 0 then
    raise exception '% of % policy tests FAILED', failures, total;
  else
    raise notice 'All % policy tests PASSED', total;
  end if;
end;
$$;

-- Cleanup
drop schema _policy_tests cascade;
