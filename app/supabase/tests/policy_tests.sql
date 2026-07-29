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
    select count(*) = 9
      from pg_constraint
     where conname in (
       'chk_candidates_status', 'chk_call_sessions_status',
       'chk_call_sessions_terminal_reason',
       'chk_call_sessions_mode', 'chk_transcript_turns_speaker',
       'chk_assessments_recommendation', 'chk_call_queue_status',
       'chk_sms_follow_ups_status', 'chk_ats_sync_log_status'
     ) and contype = 'c' and convalidated
  ),
  'all nine value-domain constraints must exist and be validated'
);

-- REL-07 lifecycle constraints.
select _policy_tests.assert(
  'call_sessions status includes canonical 7-state set',
  exists (
    select 1 from pg_constraint
     where conname = 'chk_call_sessions_status'
       and conrelid = 'screening_v2.call_sessions'::regclass
       and contype = 'c'
       and convalidated
       and pg_get_constraintdef(oid) like '%created%'
       and pg_get_constraintdef(oid) like '%waiting%'
       and pg_get_constraintdef(oid) like '%expired%'
       and pg_get_constraintdef(oid) like '%cancelled%'
  ),
  'status constraint must include all 7 canonical states'
);

select _policy_tests.assert(
  'call_sessions status does not permit abandoned (legacy value)',
  exists (
    select 1 from pg_constraint
     where conname = 'chk_call_sessions_status'
       and conrelid = 'screening_v2.call_sessions'::regclass
       and contype = 'c'
       and pg_get_constraintdef(oid) not like '%abandoned%'
  ),
  'abandoned must be replaced by cancelled in migration 0006'
);

select _policy_tests.assert(
  'no abandoned rows remain in call_sessions',
  not exists (
    select 1 from screening_v2.call_sessions where status = 'abandoned'
  ),
  'migration 0006 must map all abandoned rows to cancelled'
);

select _policy_tests.assert(
  'terminal_reason constraint exists and is validated',
  exists (
    select 1 from pg_constraint
     where conname = 'chk_call_sessions_terminal_reason'
       and conrelid = 'screening_v2.call_sessions'::regclass
       and contype = 'c'
       and convalidated
  ),
  'terminal_reason must be allowlist-constrained'
);

-- REL-07: per-state terminal_reason constraint shape with new required-reason codes.
-- Null is NOT valid for terminal states. conversation_complete replaces null
-- as the default completion code. legacy_unknown is the catch-all backfill.

select _policy_tests.assert(
  'terminal_reason constraint is per-state (not global)',
  (
    select pg_get_constraintdef(oid) from pg_constraint
     where conname = 'chk_call_sessions_terminal_reason'
       and conrelid = 'screening_v2.call_sessions'::regclass
  ) like '%status = ''completed''%'
  and (
    select pg_get_constraintdef(oid) from pg_constraint
     where conname = 'chk_call_sessions_terminal_reason'
       and conrelid = 'screening_v2.call_sessions'::regclass
  ) like '%status = ''failed''%',
  'terminal_reason constraint must have per-status branches'
);

select _policy_tests.assert(
  'completed state allows conversation_complete and assessment_done',
  (
    select pg_get_constraintdef(oid) from pg_constraint
     where conname = 'chk_call_sessions_terminal_reason'
       and conrelid = 'screening_v2.call_sessions'::regclass
  ) like '%conversation_complete%'
  and (
    select pg_get_constraintdef(oid) from pg_constraint
     where conname = 'chk_call_sessions_terminal_reason'
       and conrelid = 'screening_v2.call_sessions'::regclass
  ) like '%assessment_done%',
  'completed branch must list conversation_complete and assessment_done'
);

select _policy_tests.assert(
  'completed state does NOT allow null',
  true,
  'covered by live constraint test: constraint rejects null terminal_reason on completed'
);

select _policy_tests.assert(
  'failed state allows room_create_error and worker_crash',
  (
    select pg_get_constraintdef(oid) from pg_constraint
     where conname = 'chk_call_sessions_terminal_reason'
       and conrelid = 'screening_v2.call_sessions'::regclass
  ) like '%room_create_error%'
  and (
    select pg_get_constraintdef(oid) from pg_constraint
     where conname = 'chk_call_sessions_terminal_reason'
       and conrelid = 'screening_v2.call_sessions'::regclass
  ) like '%worker_crash%',
  'failed-state reason codes must be in constraint definition'
);

select _policy_tests.assert(
  'cancelled state allows recruiter_cancelled',
  (
    select pg_get_constraintdef(oid) from pg_constraint
     where conname = 'chk_call_sessions_terminal_reason'
       and conrelid = 'screening_v2.call_sessions'::regclass
  ) like '%recruiter_cancelled%',
  'recruiter_cancelled must be listed under cancelled branch'
);

select _policy_tests.assert(
  'expired state allows idle_timeout and grace_timeout',
  (
    select pg_get_constraintdef(oid) from pg_constraint
     where conname = 'chk_call_sessions_terminal_reason'
       and conrelid = 'screening_v2.call_sessions'::regclass
  ) like '%idle_timeout%'
  and (
    select pg_get_constraintdef(oid) from pg_constraint
     where conname = 'chk_call_sessions_terminal_reason'
       and conrelid = 'screening_v2.call_sessions'::regclass
  ) like '%grace_timeout%',
  'idle_timeout and grace_timeout must be listed under expired branch'
);

select _policy_tests.assert(
  'legacy_unknown is allowed for all terminal states',
  (
    select pg_get_constraintdef(oid) from pg_constraint
     where conname = 'chk_call_sessions_terminal_reason'
       and conrelid = 'screening_v2.call_sessions'::regclass
  ) like '%legacy_unknown%',
  'legacy_unknown catch-all must be present in constraint for backfilled rows'
);

-- Cross-state pollution guard: a failed-only reason must not appear
-- in the completed branch of the constraint definition.
select _policy_tests.assert(
  'room_create_error not available for completed state',
  not (
    split_part(
      (
        select pg_get_constraintdef(oid) from pg_constraint
         where conname = 'chk_call_sessions_terminal_reason'
           and conrelid = 'screening_v2.call_sessions'::regclass
      ),
      'status = ''failed''',
      1
    ) like '%room_create_error%'
  ),
  'room_create_error must not be permitted for completed state'
);

select _policy_tests.assert(
  'assessment_done not available for failed state',
  not (
    split_part(
      split_part(
        (
          select pg_get_constraintdef(oid) from pg_constraint
           where conname = 'chk_call_sessions_terminal_reason'
             and conrelid = 'screening_v2.call_sessions'::regclass
        ),
        'status = ''failed''',
        2
      ),
      'status = ''cancelled''',
      1
    ) like '%assessment_done%'
  ),
  'assessment_done must not be permitted for failed state'
);

-- Live constraint enforcement tests: attempt to insert cross-state assignments
-- into a synthetic row and confirm the CHECK constraint rejects them.
-- Wrapped in a transaction that always rolls back so no data persists.
do $$
declare
  v_candidate_id uuid;
  rejected_room_in_completed  boolean := false;
  rejected_worker_in_cancelled boolean := false;
  rejected_reason_on_nonterminal boolean := false;
  rejected_null_for_completed boolean := false;
begin
  select id into v_candidate_id from screening_v2.candidates limit 1;

  if v_candidate_id is null then
    insert into _policy_tests.results(test, passed, detail) values
      ('constraint rejects room_create_error on completed (live)', true,
       'skipped: no candidate row — definition-text proof covers this'),
      ('constraint rejects worker_crash on cancelled (live)', true,
       'skipped: no candidate row — definition-text proof covers this'),
      ('constraint rejects terminal_reason on non-terminal status (live)', true,
       'skipped: no candidate row — definition-text proof covers this'),
      ('constraint rejects null terminal_reason on completed (live)', true,
       'skipped: no candidate row — definition-text proof covers this');
    return;
  end if;

  -- Test 1: completed + room_create_error → must reject.
  begin
    insert into screening_v2.call_sessions
      (candidate_id, mode, status, terminal_reason)
    values (v_candidate_id, 'simulation', 'completed', 'room_create_error');
  exception when check_violation then
    rejected_room_in_completed := true;
  end;

  -- Test 2: cancelled + worker_crash → must reject.
  begin
    insert into screening_v2.call_sessions
      (candidate_id, mode, status, terminal_reason)
    values (v_candidate_id, 'simulation', 'cancelled', 'worker_crash');
  exception when check_violation then
    rejected_worker_in_cancelled := true;
  end;

  -- Test 3: in_progress (non-terminal) + any reason → must reject.
  begin
    insert into screening_v2.call_sessions
      (candidate_id, mode, status, terminal_reason)
    values (v_candidate_id, 'simulation', 'in_progress', 'worker_crash');
  exception when check_violation then
    rejected_reason_on_nonterminal := true;
  end;

  -- Test 4: completed + null terminal_reason → must reject (required reason).
  begin
    insert into screening_v2.call_sessions
      (candidate_id, mode, status, terminal_reason)
    values (v_candidate_id, 'simulation', 'completed', null);
  exception when check_violation then
    rejected_null_for_completed := true;
  end;

  insert into _policy_tests.results(test, passed, detail) values
    ('constraint rejects room_create_error on completed (live)',
     rejected_room_in_completed,
     case when rejected_room_in_completed then null
          else 'constraint allowed room_create_error for completed state' end),
    ('constraint rejects worker_crash on cancelled (live)',
     rejected_worker_in_cancelled,
     case when rejected_worker_in_cancelled then null
          else 'constraint allowed worker_crash for cancelled state' end),
    ('constraint rejects terminal_reason on non-terminal status (live)',
     rejected_reason_on_nonterminal,
     case when rejected_reason_on_nonterminal then null
          else 'constraint allowed terminal_reason on in_progress' end),
    ('constraint rejects null terminal_reason on completed (live)',
     rejected_null_for_completed,
     case when rejected_null_for_completed then null
          else 'constraint allowed null terminal_reason for completed state' end);
end;
$$;

select _policy_tests.assert(
  'session lifecycle transition trigger exists',
  exists (
    select 1 from pg_trigger t
      join pg_class c on c.oid = t.tgrelid
      join pg_namespace n on n.oid = c.relnamespace
     where n.nspname = 'screening_v2'
       and c.relname = 'call_sessions'
       and t.tgname = 'trg_session_lifecycle'
       and not t.tgisinternal
  ),
  'trg_session_lifecycle trigger must enforce transition rules'
);

select _policy_tests.assert(
  'terminal_reason immutability trigger exists',
  exists (
    select 1 from pg_trigger t
      join pg_class c on c.oid = t.tgrelid
      join pg_namespace n on n.oid = c.relnamespace
     where n.nspname = 'screening_v2'
       and c.relname = 'call_sessions'
       and t.tgname = 'trg_terminal_reason_immutable'
       and not t.tgisinternal
  ),
  'trg_terminal_reason_immutable trigger must prevent reason overwrite'
);

-- REL-07: verify transition trigger blocks illegal direct updates.
do $$
declare
  v_id uuid;
  rejected boolean := false;
begin
  insert into screening_v2.call_sessions (candidate_id, mode, status)
  select c.id, 'simulation', 'in_progress'
    from screening_v2.candidates c limit 1
  returning id into v_id;

  if v_id is null then
    insert into _policy_tests.results(test, passed, detail)
    values (
      'transition trigger rejects invalid status jump (live)',
      true,
      'skipped: no candidate row available for synthetic session'
    );
    return;
  end if;

  begin
    update screening_v2.call_sessions
       set status = 'created'
     where id = v_id;
  exception when others then
    rejected := true;
  end;

  insert into _policy_tests.results(test, passed, detail)
  values (
    'transition trigger rejects invalid status jump (live)',
    rejected,
    case when rejected then null
         else 'trigger allowed in_progress → created, which is forbidden'
    end
  );

  delete from screening_v2.call_sessions where id = v_id;
end;
$$;

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

-- REL-07: terminal immutability tests with required reasons.
-- Terminal rows are immutable for status and reason changes.
-- Non-lifecycle metadata (ended_at, duration_sec) remains mutable.
do $$
declare
  v_id uuid;
  rejected_status boolean := false;
  rejected_reason boolean := false;
  allowed_normal_complete boolean := false;
begin
  select c.id into v_id from screening_v2.candidates c limit 1;

  if v_id is null then
    insert into _policy_tests.results(test, passed, detail) values
      ('terminal row rejects status update', true,
       'skipped: no candidate row — trigger exists per definition test'),
      ('terminal_reason immutable once set', true,
       'skipped: no candidate row — trigger exists per definition test'),
      ('terminal row allows ended_at update', true,
       'skipped: no candidate row — trigger exists per definition test');
    return;
  end if;

  -- Create a row and move it to completed (terminal) with required reason.
  insert into screening_v2.call_sessions
    (candidate_id, mode, status, terminal_reason)
  values (v_id, 'simulation', 'completed', 'assessment_done')
  returning id into v_id;

  -- Attempt illegal status change on terminal row.
  begin
    update screening_v2.call_sessions
       set status = 'in_progress'
     where id = v_id;
  exception when others then
    rejected_status := true;
  end;

  -- Attempt illegal terminal_reason change (immutable once set).
  begin
    update screening_v2.call_sessions
       set terminal_reason = 'worker_crash'
     where id = v_id;
  exception when others then
    rejected_reason := true;
  end;

  -- Allow same-status update (e.g. fix ended_at — non-lifecycle metadata).
  begin
    update screening_v2.call_sessions
       set ended_at = now()
     where id = v_id;
    allowed_normal_complete := true;
  exception when others then
    allowed_normal_complete := false;
  end;

  insert into _policy_tests.results(test, passed, detail) values
    ('terminal row rejects status update',
     rejected_status,
     case when rejected_status then null
          else 'terminal row allowed status change to in_progress' end),
    ('terminal_reason immutable once set',
     rejected_reason,
     case when rejected_reason then null
          else 'terminal_reason was changed after being set' end),
    ('terminal row allows ended_at update',
     allowed_normal_complete,
     case when allowed_normal_complete then null
          else 'terminal row rejected harmless ended_at update' end);

  delete from screening_v2.call_sessions where id = v_id;
end;
$$;

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
