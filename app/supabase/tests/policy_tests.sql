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

-- ── LLM-06 provenance validation tests ─────────────────────────────────

-- Helper: canonical valid current provenance
create or replace function _policy_tests.valid_provenance_json()
returns jsonb
language sql immutable
as $$
select '{"schema_version":1,"provider":"anthropic","requestedModel":"claude-haiku-4-5-20251001","workload":"screening","prompt_template_version":"2026-07-28.1","timestamp":"2026-07-28T12:00:00.000Z"}'::jsonb
$$;

-- Positive: valid current provenance
select _policy_tests.assert(
  'LLM-06: valid current provenance accepted',
  screening_v2.valid_model_provenance(_policy_tests.valid_provenance_json()),
  'current shape must be accepted'
);

-- Positive: valid with inference params
select _policy_tests.assert(
  'LLM-06: valid provenance with inference_params accepted',
  screening_v2.valid_model_provenance(
    '{"schema_version":1,"provider":"anthropic","requestedModel":"claude-sonnet-4-20250514","workload":"scoring","prompt_template_version":"2026-07-28.1","timestamp":"2026-07-28T12:00:00Z","inference_params":{"temperature":0.7,"max_tokens":4096}}'::jsonb
  ),
  'inference_params should be accepted'
);

-- Positive: valid ms timestamp
select _policy_tests.assert(
  'LLM-06: valid ms timestamp accepted',
  screening_v2.valid_model_provenance(
    '{"schema_version":1,"provider":"anthropic","requestedModel":"claude","workload":"screening","prompt_template_version":"v1","timestamp":"2026-07-28T12:00:00.000Z"}'::jsonb
  ),
  'ms timestamp should be accepted'
);

-- Positive: exact legacy sentinel
select _policy_tests.assert(
  'LLM-06: exact legacy sentinel accepted',
  screening_v2.valid_model_provenance(
    '{"schema_version":0,"provider":"legacy","requestedModel":"unknown","workload":"unknown","prompt_template_version":"legacy","timestamp":"1970-01-01T00:00:00Z"}'::jsonb
  ),
  'exact legacy sentinel must be accepted'
);

-- Positive: scoring workload
select _policy_tests.assert(
  'LLM-06: scoring workload accepted',
  screening_v2.valid_model_provenance(
    '{"schema_version":1,"provider":"anthropic","requestedModel":"claude-sonnet","workload":"scoring","prompt_template_version":"v1","timestamp":"2026-07-28T12:00:00Z"}'::jsonb
  ),
  'scoring workload must be accepted'
);

-- Negative: null
select _policy_tests.assert(
  'LLM-06: null rejected',
  not screening_v2.valid_model_provenance(null::jsonb),
  'null input must be rejected'
);

-- Negative: array
select _policy_tests.assert(
  'LLM-06: array rejected',
  not screening_v2.valid_model_provenance('[]'::jsonb),
  'array must be rejected'
);

-- Negative: string
select _policy_tests.assert(
  'LLM-06: string rejected',
  not screening_v2.valid_model_provenance('"hello"'::jsonb),
  'string must be rejected'
);

-- Negative: missing schema_version
select _policy_tests.assert(
  'LLM-06: missing schema_version rejected',
  not screening_v2.valid_model_provenance(
    '{"provider":"anthropic","requestedModel":"claude","workload":"screening","prompt_template_version":"v1","timestamp":"2026-07-28T12:00:00Z"}'::jsonb
  ),
  'missing schema_version must be rejected'
);

-- Negative: missing provider
select _policy_tests.assert(
  'LLM-06: missing provider rejected',
  not screening_v2.valid_model_provenance(
    '{"schema_version":1,"requestedModel":"claude","workload":"screening","prompt_template_version":"v1","timestamp":"2026-07-28T12:00:00Z"}'::jsonb
  ),
  'missing provider must be rejected'
);

-- Negative: wrong provider
select _policy_tests.assert(
  'LLM-06: wrong provider (openai) rejected',
  not screening_v2.valid_model_provenance(
    '{"schema_version":1,"provider":"openai","requestedModel":"claude","workload":"screening","prompt_template_version":"v1","timestamp":"2026-07-28T12:00:00Z"}'::jsonb
  ),
  'non-anthropic provider must be rejected'
);

-- Negative: wrong workload
select _policy_tests.assert(
  'LLM-06: wrong workload (deployment) rejected',
  not screening_v2.valid_model_provenance(
    '{"schema_version":1,"provider":"anthropic","requestedModel":"claude","workload":"deployment","prompt_template_version":"v1","timestamp":"2026-07-28T12:00:00Z"}'::jsonb
  ),
  'non-screening/scoring workload must be rejected'
);

-- Negative: wrong schema_version
select _policy_tests.assert(
  'LLM-06: schema_version 2 rejected',
  not screening_v2.valid_model_provenance(
    '{"schema_version":2,"provider":"anthropic","requestedModel":"claude","workload":"screening","prompt_template_version":"v1","timestamp":"2026-07-28T12:00:00Z"}'::jsonb
  ),
  'schema_version != 1 must be rejected'
);

-- Negative: extra top-level key
select _policy_tests.assert(
  'LLM-06: extra key rejected',
  not screening_v2.valid_model_provenance(
    '{"schema_version":1,"provider":"anthropic","requestedModel":"claude","workload":"screening","prompt_template_version":"v1","timestamp":"2026-07-28T12:00:00Z","extra":"bad"}'::jsonb
  ),
  'extra top-level keys must be rejected'
);

-- Negative: extra key on legacy sentinel
select _policy_tests.assert(
  'LLM-06: extra key on legacy rejected',
  not screening_v2.valid_model_provenance(
    '{"schema_version":0,"provider":"legacy","requestedModel":"unknown","workload":"unknown","prompt_template_version":"legacy","timestamp":"1970-01-01T00:00:00Z","extra":true}'::jsonb
  ),
  'legacy sentinel with extra keys must be rejected'
);

-- Negative: non-UTC timestamp
select _policy_tests.assert(
  'LLM-06: non-UTC timestamp rejected',
  not screening_v2.valid_model_provenance(
    '{"schema_version":1,"provider":"anthropic","requestedModel":"claude","workload":"screening","prompt_template_version":"v1","timestamp":"2026-07-28T12:00:00+00:00"}'::jsonb
  ),
  'timezone-offset timestamps must be rejected'
);

-- Negative: impossible date
select _policy_tests.assert(
  'LLM-06: impossible date (month 13) rejected',
  not screening_v2.valid_model_provenance(
    '{"schema_version":1,"provider":"anthropic","requestedModel":"claude","workload":"screening","prompt_template_version":"v1","timestamp":"2026-13-28T12:00:00Z"}'::jsonb
  ),
  'impossible month must be rejected'
);

-- Negative: empty requestedModel
select _policy_tests.assert(
  'LLM-06: empty requestedModel rejected',
  not screening_v2.valid_model_provenance(
    '{"schema_version":1,"provider":"anthropic","requestedModel":"","workload":"screening","prompt_template_version":"v1","timestamp":"2026-07-28T12:00:00Z"}'::jsonb
  ),
  'empty model string must be rejected'
);

-- Negative: inference_params as array
select _policy_tests.assert(
  'LLM-06: inference_params array rejected',
  not screening_v2.valid_model_provenance(
    '{"schema_version":1,"provider":"anthropic","requestedModel":"claude","workload":"screening","prompt_template_version":"v1","timestamp":"2026-07-28T12:00:00Z","inference_params":["bad"]}'::jsonb
  ),
  'array inference_params must be rejected'
);

-- Negative: unknown inference param key
select _policy_tests.assert(
  'LLM-06: unknown inference param key rejected',
  not screening_v2.valid_model_provenance(
    '{"schema_version":1,"provider":"anthropic","requestedModel":"claude","workload":"screening","prompt_template_version":"v1","timestamp":"2026-07-28T12:00:00Z","inference_params":{"temperature":0.5,"bad_key":1}}'::jsonb
  ),
  'unknown inference keys must be rejected'
);

-- Negative: temperature out of range
select _policy_tests.assert(
  'LLM-06: temperature > 2 rejected',
  not screening_v2.valid_model_provenance(
    '{"schema_version":1,"provider":"anthropic","requestedModel":"claude","workload":"screening","prompt_template_version":"v1","timestamp":"2026-07-28T12:00:00Z","inference_params":{"temperature":3}}'::jsonb
  ),
  'temperature > 2 must be rejected'
);

-- Negative: max_tokens out of range
select _policy_tests.assert(
  'LLM-06: max_tokens > 100000 rejected',
  not screening_v2.valid_model_provenance(
    '{"schema_version":1,"provider":"anthropic","requestedModel":"claude","workload":"screening","prompt_template_version":"v1","timestamp":"2026-07-28T12:00:00Z","inference_params":{"max_tokens":100001}}'::jsonb
  ),
  'max_tokens > 100000 must be rejected'
);

-- Negative: oversized payload. JSONB normalizes whitespace, so construct an
-- actually oversized string field rather than appending spaces to JSON text.
select _policy_tests.assert(
  'LLM-06: oversized payload rejected',
  not screening_v2.valid_model_provenance(
    jsonb_build_object(
      'schema_version', 1,
      'provider', 'anthropic',
      'requestedModel', repeat('a', 2049),
      'workload', 'screening',
      'prompt_template_version', 'v1',
      'timestamp', '2026-07-28T12:00:00Z'
    )
  ),
  'payload > 2048 bytes must be rejected'
);

-- ── LLM-06 migration order tests ───────────────────────────────────────

select _policy_tests.assert(
  'LLM-06: chk_call_sessions_provenance_type allows null',
  position('provenance IS NULL' in (
    select pg_get_constraintdef(oid)
      from pg_constraint
     where conname = 'chk_call_sessions_provenance_type'
  )) > 0,
  'call_sessions provenance CHECK must allow null'
);

select _policy_tests.assert(
  'LLM-06: chk_assessments_provenance_not_null exists',
  exists (
    select 1 from pg_constraint
     where conname = 'chk_assessments_provenance_not_null'
       and contype = 'c'
  ),
  'assessments must have NOT NULL provenance constraint'
);

-- ── LLM-06 immutability trigger tests ─────────────────────────────────

drop table if exists _policy_tests._test_provenance;
create table _policy_tests._test_provenance (
  id int primary key,
  provenance jsonb
);

-- Apply the real trigger function on an isolated test-schema table.
drop trigger if exists trg_test_prevent_provenance_change on _policy_tests._test_provenance;
create trigger trg_test_prevent_provenance_change
  before update of provenance on _policy_tests._test_provenance
  for each row
  execute function screening_v2.prevent_provenance_change();

insert into _policy_tests._test_provenance (id, provenance) values (1, _policy_tests.valid_provenance_json());

-- Test same-value no-op (should succeed)
do $$
begin
  update _policy_tests._test_provenance set provenance = provenance where id = 1;
  insert into _policy_tests.results(test, passed, detail)
  values ('LLM-06: same-value no-op update', true, 'no-op update did not raise');
exception when others then
  insert into _policy_tests.results(test, passed, detail)
  values ('LLM-06: same-value no-op update', false, 'no-op unexpectedly raised: ' || sqlerrm);
end $$;

-- Test non-null→different (must raise)
do $$
begin
  update _policy_tests._test_provenance set provenance = '{"schema_version":1,"provider":"anthropic","requestedModel":"different","workload":"screening","prompt_template_version":"v1","timestamp":"2026-07-28T12:00:00Z"}'::jsonb where id = 1;
  insert into _policy_tests.results(test, passed, detail)
  values ('LLM-06: non-null→different rejected', false, 'should have raised exception');
exception when others then
  if sqlerrm like '%provenance: immutable once set%' then
    insert into _policy_tests.results(test, passed, detail)
    values ('LLM-06: non-null→different rejected', true, 'correctly raised: ' || sqlerrm);
  else
    insert into _policy_tests.results(test, passed, detail)
    values ('LLM-06: non-null→different rejected', false, 'wrong exception: ' || sqlerrm);
  end if;
end $$;

-- Test null→validated (should succeed)
insert into _policy_tests._test_provenance (id, provenance) values (2, null);
do $$
begin
  update _policy_tests._test_provenance set provenance = _policy_tests.valid_provenance_json() where id = 2;
  insert into _policy_tests.results(test, passed, detail)
  values ('LLM-06: null→validated allowed', true, 'null transition succeeded');
exception when others then
  insert into _policy_tests.results(test, passed, detail)
  values ('LLM-06: null→validated allowed', false, 'null transition raised: ' || sqlerrm);
end $$;

-- Test null→null (should succeed)
insert into _policy_tests._test_provenance (id, provenance) values (3, null);
do $$
begin
  update _policy_tests._test_provenance set provenance = null where id = 3;
  insert into _policy_tests.results(test, passed, detail)
  values ('LLM-06: null→null allowed', true, 'null→null succeeded');
exception when others then
  insert into _policy_tests.results(test, passed, detail)
  values ('LLM-06: null→null allowed', false, 'null→null raised: ' || sqlerrm);
end $$;

-- ── LLM-06 function security ──────────────────────────────────────────

select _policy_tests.assert(
  'LLM-06: valid_model_provenance not executable by anon/public',
  not exists (
    select 1 from pg_proc p
     join pg_namespace n on n.oid = p.pronamespace
     where n.nspname = 'screening_v2'
       and p.proname = 'valid_model_provenance'
       and has_function_privilege('public', p.oid, 'EXECUTE')
  )
  and not exists (
    select 1 from pg_proc p
     join pg_namespace n on n.oid = p.pronamespace
     where n.nspname = 'screening_v2'
       and p.proname = 'valid_model_provenance'
       and has_function_privilege('anon', p.oid, 'EXECUTE')
  ),
  'only service_role should execute valid_model_provenance'
);

select _policy_tests.assert(
  'LLM-06: prevent_provenance_change not executable by anon/public',
  not exists (
    select 1 from pg_proc p
     join pg_namespace n on n.oid = p.pronamespace
     where n.nspname = 'screening_v2'
       and p.proname = 'prevent_provenance_change'
       and has_function_privilege('public', p.oid, 'EXECUTE')
  )
  and not exists (
    select 1 from pg_proc p
     join pg_namespace n on n.oid = p.pronamespace
     where n.nspname = 'screening_v2'
       and p.proname = 'prevent_provenance_change'
       and has_function_privilege('anon', p.oid, 'EXECUTE')
  ),
  'only service_role should execute prevent_provenance_change'
);

-- ── Verdict ────────────────────────────────────────────────────────────

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
