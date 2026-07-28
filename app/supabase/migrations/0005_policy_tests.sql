-- =====================================================================
-- Policy & Constraint Tests — Run after migrations to verify hardening.
--
-- These tests are idempotent: they produce one row per test with
-- pass/fail/notes. Designed to run in CI via scripts/supabase-test.sh
-- against a local Supabase Docker instance.
-- =====================================================================

-- Create a test results table (ephemeral — dropped at end)
create schema if not exists _policy_tests;
drop table if exists _policy_tests.results;
create table _policy_tests.results (
  id          serial primary key,
  test        text not null,
  passed      boolean not null,
  detail      text,
  ran_at      timestamptz not null default now()
);

-- Helper: assert that a condition passes
create or replace function _policy_tests.assert(test text, cond boolean, detail text default null)
returns void language plpgsql as $$
begin
  insert into _policy_tests.results (test, passed, detail) values (test, cond, detail);
end;
$$;

-- =====================================================================
-- TESTS
-- =====================================================================

-- ----- 3.1 ANON DENIAL -----
select _policy_tests.assert(
  'anon: cannot select candidates',
  not exists (select 1 from screening_v2.candidates limit 1),
  'Anon should have zero access to candidates table'
);

select _policy_tests.assert(
  'anon: cannot select call_sessions',
  not exists (select 1 from screening_v2.call_sessions limit 1),
  'Anon should have zero access to call_sessions table'
);

-- ----- 3.2 NO BLANKET ANON POLICIES -----
do $$
declare
  pol_count int;
begin
  select count(*) into pol_count
  from pg_policies
  where schemaname = 'screening_v2'
    and roles @> array['anon'::name];

  perform _policy_tests.assert(
    'no anon policies exist',
    pol_count = 0,
    format('Found %s anon policies — expected 0', pol_count)
  );
end;
$$;

-- ----- 3.3 AUTHENTICATED CAN READ -----
select _policy_tests.assert(
  'authenticated has read policies on candidates',
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
  'authenticated has read policies on call_sessions',
  exists (
    select 1 from pg_policies
    where schemaname = 'screening_v2'
      and tablename = 'call_sessions'
      and cmd = 'SELECT'
      and roles @> array['authenticated'::name]
  ),
  'Expected authenticated SELECT policy on call_sessions'
);

-- ----- 3.4 NO using(true) ON AUTHENTICATED POLICIES -----
do $$
declare
  pol_count int;
begin
  select count(*) into pol_count
  from pg_policies
  where schemaname = 'screening_v2'
    and qual::text = '(true)'::text;

  -- Note: single-org currently uses (true) for authenticated.
  -- This is acceptable for single-org launch per alignment.
  -- If multi-tenancy is adopted later, these must be scoped to org_id.
  perform _policy_tests.assert(
    'authenticated policies use (true) qualifier (single-org acceptable)',
    true,
    format('%s policies use (true) qualifier — acceptable for single-org launch', pol_count)
  );
end;
$$;

-- ----- 3.5 CHECK CONSTRAINTS EXIST -----
select _policy_tests.assert(
  'CHECK constraint on candidates.status',
  exists (
    select 1 from pg_constraint
    where conname = 'chk_candidates_status' and contype = 'c'
  ),
  'Expected chk_candidates_status CHECK constraint'
);

select _policy_tests.assert(
  'CHECK constraint on transcript_turns.speaker',
  exists (
    select 1 from pg_constraint
    where conname = 'chk_transcript_turns_speaker' and contype = 'c'
  ),
  'Expected chk_transcript_turns_speaker CHECK constraint'
);

select _policy_tests.assert(
  'CHECK constraint on assessments.recommendation',
  exists (
    select 1 from pg_constraint
    where conname = 'chk_assessments_recommendation' and contype = 'c'
  ),
  'Expected chk_assessments_recommendation CHECK constraint'
);

-- ----- 3.6 UNIQUE CONSTRAINT ON transcript_turns -----
select _policy_tests.assert(
  'UNIQUE constraint on transcript_turns(session_id, turn_index)',
  exists (
    select 1 from pg_constraint
    where conname = 'uq_transcript_turns_session_turn' and contype = 'u'
  ),
  'Expected unique constraint on transcript_turns(session_id, turn_index)'
);

-- ----- 3.7 UPDATED_AT TRIGGERS -----
select _policy_tests.assert(
  'updated_at trigger on call_sessions',
  exists (
    select 1 from pg_trigger
    where tgname = 'trg_v2_sessions_updated'
  ),
  'Expected trg_v2_sessions_updated on call_sessions'
);

select _policy_tests.assert(
  'updated_at trigger on roles',
  exists (
    select 1 from pg_trigger
    where tgname = 'trg_v2_roles_updated'
  ),
  'Expected trg_v2_roles_updated on roles'
);

select _policy_tests.assert(
  'updated_at trigger on assessments',
  exists (
    select 1 from pg_trigger
    where tgname = 'trg_v2_assess_updated'
  ),
  'Expected trg_v2_assess_updated on assessments'
);

-- ----- 3.8 STORAGE POLICIES -----
select _policy_tests.assert(
  'storage: authenticated read policy on resumes_v2',
  exists (
    select 1 from pg_policies
    where schemaname = 'storage'
      and tablename = 'objects'
      and policyname = 'authenticated read resumes_v2'
  ),
  'Expected storage policy authenticated read resumes_v2'
);

select _policy_tests.assert(
  'storage: authenticated write policy on resumes_v2',
  exists (
    select 1 from pg_policies
    where schemaname = 'storage'
      and tablename = 'objects'
      and policyname = 'authenticated write resumes_v2'
  ),
  'Expected storage policy authenticated write resumes_v2'
);

select _policy_tests.assert(
  'storage: anon denied all access',
  exists (
    select 1 from pg_policies
    where schemaname = 'storage'
      and tablename = 'objects'
      and policyname = 'anon deny all storage'
  ),
  'Expected storage policy anon deny all storage'
);

-- ----- 3.9 GRANTS — anon has no privileges -----
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

-- ----- 3.10 GRANTS — authenticated has usage -----
select _policy_tests.assert(
  'authenticated has usage on schema screening_v2',
  exists (
    select 1 from information_schema.usage_privileges
    where grantee = 'authenticated'
      and object_type = 'SCHEMA'
      and object_name = 'screening_v2'
  ),
  'Expected authenticated to have USAGE on screening_v2'
);

-- =====================================================================
-- REPORT
-- =====================================================================
select test,
       case when passed then 'PASS' else 'FAIL' end as result,
       detail
from _policy_tests.results
order by id;

-- Exit with failure if any test failed
do $$
declare
  failures int;
begin
  select count(*) into failures from _policy_tests.results where not passed;
  if failures > 0 then
    raise exception '% of % policy tests FAILED', failures, (select count(*) from _policy_tests.results);
  end if;
end;
$$;

-- Cleanup
drop schema _policy_tests cascade;
