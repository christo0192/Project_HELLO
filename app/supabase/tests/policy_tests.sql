\set ON_ERROR_STOP on

-- Production-boundary tests. Runs only against local synthetic Supabase.
create schema if not exists _policy_tests;
drop table if exists _policy_tests.results;
create table _policy_tests.results (
  id serial primary key,
  test text not null,
  passed boolean not null,
  detail text
);

create or replace function _policy_tests.assert(test_name text, condition boolean, failure_detail text)
returns void language plpgsql as $$
begin
  insert into _policy_tests.results(test, passed, detail)
  values (test_name, coalesce(condition, false), failure_detail);
end;
$$;

-- Browser roles must not inherit effective write access from PUBLIC or another role.
select _policy_tests.assert(
  'anon has no effective screening_v2 table privilege',
  not exists (
    select 1
      from pg_class c
      join pg_namespace n on n.oid = c.relnamespace
     where n.nspname = 'screening_v2'
       and c.relkind in ('r', 'p', 'v', 'm')
       and has_any_column_privilege('anon', c.oid, 'SELECT,INSERT,UPDATE,REFERENCES')
  )
  and not exists (
    select 1
      from pg_class c
      join pg_namespace n on n.oid = c.relnamespace
     where n.nspname = 'screening_v2'
       and c.relkind in ('r', 'p')
       and (has_table_privilege('anon', c.oid, 'DELETE')
         or has_table_privilege('anon', c.oid, 'TRUNCATE')
         or has_table_privilege('anon', c.oid, 'TRIGGER'))
  ),
  'anon must have zero effective privileges on screening_v2 objects'
);

select _policy_tests.assert(
  'authenticated has no direct write privilege',
  not exists (
    select 1
      from pg_class c
      join pg_namespace n on n.oid = c.relnamespace
     where n.nspname = 'screening_v2'
       and c.relkind in ('r', 'p')
       and (has_table_privilege('authenticated', c.oid, 'INSERT')
         or has_table_privilege('authenticated', c.oid, 'UPDATE')
         or has_table_privilege('authenticated', c.oid, 'DELETE')
         or has_table_privilege('authenticated', c.oid, 'TRUNCATE')
         or has_table_privilege('authenticated', c.oid, 'TRIGGER'))
  ),
  'authenticated browser sessions must be read-only at the database boundary'
);

select _policy_tests.assert(
  'no anon or public screening policy exists',
  not exists (
    select 1 from pg_policies
     where schemaname = 'screening_v2'
       and roles && array['anon'::name, 'public'::name]
  ),
  'an anon/PUBLIC policy would bypass the recruiter-membership gate'
);

select _policy_tests.assert(
  'all screening tables have RLS enabled',
  not exists (
    select 1
      from pg_class c
      join pg_namespace n on n.oid = c.relnamespace
     where n.nspname = 'screening_v2'
       and c.relkind in ('r', 'p')
       and not c.relrowsecurity
  ),
  'every screening_v2 table must enable row-level security'
);

-- Single-org recruiter allowlist and fixed-search-path helper.
select _policy_tests.assert(
  'recruiter_memberships exists with role constraint',
  to_regclass('screening_v2.recruiter_memberships') is not null
  and exists (
    select 1 from pg_constraint
     where conrelid = 'screening_v2.recruiter_memberships'::regclass
       and conname = 'chk_recruiter_membership_role'
       and contype = 'c'
  ),
  'active recruiter membership with admin/interviewer/viewer role is required'
);

select _policy_tests.assert(
  'membership helper is security definer with fixed search_path',
  exists (
    select 1
      from pg_proc p
      join pg_namespace n on n.oid = p.pronamespace
     where n.nspname = 'screening_v2'
       and p.proname = 'is_active_recruiter'
       and p.prosecdef
       and p.proconfig @> array['search_path=pg_catalog']
  ),
  'is_active_recruiter must be SECURITY DEFINER with search_path=pg_catalog'
);

select _policy_tests.assert(
  'dashboard policies invoke membership helper',
  (
    select count(*) = 5
      from pg_policies
     where schemaname = 'screening_v2'
       and policyname like 'active recruiter read %'
       and cmd = 'SELECT'
       and roles @> array['authenticated'::name]
       and qual like '%is_active_recruiter%'
  ),
  'exactly five dashboard SELECT policies must use is_active_recruiter'
);

-- Seed synthetic identities/data to exercise effective RLS, never candidate data.
insert into auth.users (
  instance_id, id, aud, role, email, encrypted_password,
  email_confirmed_at, raw_app_meta_data, raw_user_meta_data,
  created_at, updated_at
) values (
  '00000000-0000-0000-0000-000000000000',
  '10000000-0000-0000-0000-000000000001',
  'authenticated', 'authenticated', 'rls-test@example.invalid', '',
  now(), '{}', '{}', now(), now()
) on conflict (id) do nothing;

insert into screening_v2.roles (id, title)
values ('20000000-0000-0000-0000-000000000001', 'Synthetic RLS Test Role')
on conflict (id) do nothing;

begin;
set local role authenticated;
select set_config(
  'request.jwt.claims',
  '{"sub":"10000000-0000-0000-0000-000000000001","role":"authenticated"}',
  true
);
select count(*)::integer as without_membership_count
  from screening_v2.roles
 where id = '20000000-0000-0000-0000-000000000001' \gset
rollback;

select _policy_tests.assert(
  'authenticated user without membership sees no dashboard rows',
  :without_membership_count::integer = 0,
  'a valid Supabase account alone must not grant recruiter data access'
);

insert into screening_v2.recruiter_memberships(user_id, role, active)
values ('10000000-0000-0000-0000-000000000001', 'viewer', true)
on conflict (user_id) do update set role = excluded.role, active = excluded.active;

begin;
set local role authenticated;
select set_config(
  'request.jwt.claims',
  '{"sub":"10000000-0000-0000-0000-000000000001","role":"authenticated"}',
  true
);
select count(*)::integer as active_membership_count
  from screening_v2.roles
 where id = '20000000-0000-0000-0000-000000000001' \gset
select count(*)::integer as own_membership_count
  from screening_v2.recruiter_memberships
 where user_id = '10000000-0000-0000-0000-000000000001' \gset
rollback;

select _policy_tests.assert(
  'active recruiter can read single-org dashboard rows',
  :active_membership_count::integer = 1,
  'an active recruiter membership should unlock read-only dashboard data'
);
select _policy_tests.assert(
  'active recruiter can read only own membership row',
  :own_membership_count::integer = 1,
  'the authenticated recruiter should see their own active membership'
);

update screening_v2.recruiter_memberships
   set active = false
 where user_id = '10000000-0000-0000-0000-000000000001';

begin;
set local role authenticated;
select set_config(
  'request.jwt.claims',
  '{"sub":"10000000-0000-0000-0000-000000000001","role":"authenticated"}',
  true
);
select count(*)::integer as inactive_membership_count
  from screening_v2.roles
 where id = '20000000-0000-0000-0000-000000000001' \gset
rollback;

select _policy_tests.assert(
  'inactive recruiter loses dashboard access',
  :inactive_membership_count::integer = 0,
  'membership revocation must take effect immediately'
);

-- Schema integrity.
select _policy_tests.assert(
  'required CHECK constraints exist and are validated',
  (
    select count(*) = 8
      from pg_constraint
     where conname in (
       'chk_candidates_status', 'chk_call_sessions_status',
       'chk_call_sessions_mode', 'chk_transcript_turns_speaker',
       'chk_assessments_recommendation', 'chk_call_queue_status',
       'chk_sms_follow_ups_status', 'chk_ats_sync_log_status'
     ) and contype = 'c' and convalidated
  ),
  'all eight value-domain constraints must exist and be validated'
);

select _policy_tests.assert(
  'transcript event position is unique per session',
  exists (
    select 1 from pg_constraint
     where conname = 'uq_transcript_turns_session_turn'
       and conrelid = 'screening_v2.transcript_turns'::regclass
       and contype = 'u'
  ),
  'duplicate transcript turn indexes must be rejected'
);

select _policy_tests.assert(
  'private storage has no browser allow policy',
  not exists (
    select 1 from pg_policies
     where schemaname = 'storage'
       and tablename = 'objects'
       and roles && array['anon'::name, 'authenticated'::name, 'public'::name]
       and (qual ilike '%resumes_v2%' or qual ilike '%recordings_v2%'
         or with_check ilike '%resumes_v2%' or with_check ilike '%recordings_v2%')
  )
  and not exists (
    select 1 from storage.buckets
     where id in ('resumes_v2', 'recordings_v2') and public
  ),
  'resumes and recordings must remain private and server-only'
);

select _policy_tests.assert(
  'Realtime publication is limited to expected dashboard tables',
  (
    select count(*) = 3
      from pg_publication_tables
     where pubname = 'supabase_realtime'
       and schemaname = 'screening_v2'
       and tablename in ('call_sessions', 'transcript_turns', 'assessments')
  )
  and not exists (
    select 1 from pg_publication_tables
     where pubname = 'supabase_realtime'
       and schemaname = 'screening_v2'
       and tablename not in ('call_sessions', 'transcript_turns', 'assessments')
  ),
  'only call_sessions, transcript_turns, and assessments may be published'
);

-- Remove synthetic fixtures before the verdict.
delete from screening_v2.recruiter_memberships
 where user_id = '10000000-0000-0000-0000-000000000001';
delete from screening_v2.roles
 where id = '20000000-0000-0000-0000-000000000001';
delete from auth.users
 where id = '10000000-0000-0000-0000-000000000001';

select test, case when passed then 'PASS' else 'FAIL' end as result, detail
  from _policy_tests.results order by id;

do $$
declare failures integer; total integer;
begin
  select count(*), count(*) filter (where not passed)
    into total, failures from _policy_tests.results;
  if failures > 0 then
    raise exception '% of % Supabase policy tests FAILED', failures, total;
  end if;
  raise notice 'All % Supabase policy tests PASSED', total;
end;
$$;

drop schema _policy_tests cascade;
