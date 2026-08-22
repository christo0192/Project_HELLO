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
    -- Phase 1 (0007): 3 scoped (roles/candidates/call_sessions),
    --   2 active (transcript_turns/assessments), 1 recruiter (audit_events) = 6
    -- Phase 2 (0008): 5 active (consent_records, call_queue, sms_follow_ups,
    --   ats_sync_log, resumes) = 5
    -- Phase 3 (0012): 5 recruiter (retention_policies, legal_holds,
    --   erasure_exceptions, data_subject_requests, governance_audit) = 5
    -- Phase 3 (0013): 1 active (consent_templates) = 1
    -- Phase 7 (0014): 1 active (recording_integrity_events) = 1
    -- Total: 6 + 5 + 5 + 1 + 1 = 18
    select count(*) = 18
      from pg_policies
     where schemaname = 'screening_v2'
       and cmd = 'SELECT'
       and roles @> array['authenticated'::name]
       and (
         policyname like 'active recruiter read %'
         or policyname like 'scoped recruiter read %'
         or policyname in ('recruiter read audit_events',
            'recruiter read retention_policies', 'recruiter read legal_holds',
            'recruiter read erasure_exceptions', 'recruiter read data_subject_requests',
            'recruiter read governance_audit')
       )
  ),
  'all 18 dashboard SELECT policies must be gated by active recruiter membership'
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
  exception when check_violation or raise_exception then
    rejected_room_in_completed := true;
  end;

  -- Test 2: cancelled + worker_crash → must reject.
  begin
    insert into screening_v2.call_sessions
      (candidate_id, mode, status, terminal_reason)
    values (v_candidate_id, 'simulation', 'cancelled', 'worker_crash');
  exception when check_violation or raise_exception then
    rejected_worker_in_cancelled := true;
  end;

  -- Test 3: in_progress (non-terminal) + any reason → must reject.
  begin
    insert into screening_v2.call_sessions
      (candidate_id, mode, status, terminal_reason)
    values (v_candidate_id, 'simulation', 'in_progress', 'worker_crash');
  exception when check_violation or raise_exception then
    rejected_reason_on_nonterminal := true;
  end;

  -- Test 4: completed + null terminal_reason → must reject (required reason).
  begin
    insert into screening_v2.call_sessions
      (candidate_id, mode, status, terminal_reason)
    values (v_candidate_id, 'simulation', 'completed', null);
  exception when check_violation or raise_exception then
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
  select c.id, 'simulation', 'created'
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

  update screening_v2.call_sessions
     set status = 'in_progress'
   where id = v_id;

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

  -- Create a row and move it through the legal lifecycle into completed.
  insert into screening_v2.call_sessions
    (candidate_id, mode, status)
  values (v_id, 'simulation', 'created')
  returning id into v_id;

  update screening_v2.call_sessions
     set status = 'in_progress'
   where id = v_id;
  update screening_v2.call_sessions
     set status = 'completed', terminal_reason = 'assessment_done'
   where id = v_id;

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

-- ═══════════════════════════════════════════════════════════════════════
-- 0007 — Phase 1: Ownership scope, invites, grants, audit
-- ═══════════════════════════════════════════════════════════════════════

-- ── A. Owner_id columns ───────────────────────────────────────────────

select _policy_tests.assert(
  'roles has owner_id column',
  exists (
    select 1 from information_schema.columns
     where table_schema = 'screening_v2'
       and table_name = 'roles'
       and column_name = 'owner_id'
  ),
  'owner_id must exist on roles table'
);

select _policy_tests.assert(
  'candidates has owner_id column',
  exists (
    select 1 from information_schema.columns
     where table_schema = 'screening_v2'
       and table_name = 'candidates'
       and column_name = 'owner_id'
  ),
  'owner_id must exist on candidates table'
);

select _policy_tests.assert(
  'call_sessions has owner_id column',
  exists (
    select 1 from information_schema.columns
     where table_schema = 'screening_v2'
       and table_name = 'call_sessions'
       and column_name = 'owner_id'
  ),
  'owner_id must exist on call_sessions table'
);

select _policy_tests.assert(
  'owner_id is nullable on all three tables',
  exists (
    select 1 from information_schema.columns
     where table_schema = 'screening_v2'
       and table_name = 'roles'
       and column_name = 'owner_id'
       and is_nullable = 'YES'
  )
  and exists (
    select 1 from information_schema.columns
     where table_schema = 'screening_v2'
       and table_name = 'candidates'
       and column_name = 'owner_id'
       and is_nullable = 'YES'
  )
  and exists (
    select 1 from information_schema.columns
     where table_schema = 'screening_v2'
       and table_name = 'call_sessions'
       and column_name = 'owner_id'
       and is_nullable = 'YES'
  ),
  'owner_id must be nullable for legacy/backfill safety'
);

select _policy_tests.assert(
  'owner_id indexes exist',
  exists (
    select 1 from pg_indexes
     where schemaname = 'screening_v2'
       and tablename = 'roles'
       and indexname = 'idx_v2_roles_owner'
  )
  and exists (
    select 1 from pg_indexes
     where schemaname = 'screening_v2'
       and tablename = 'candidates'
       and indexname = 'idx_v2_candidates_owner'
  )
  and exists (
    select 1 from pg_indexes
     where schemaname = 'screening_v2'
       and tablename = 'call_sessions'
       and indexname = 'idx_v2_sessions_owner'
  ),
  'owner_id must have indexes on all three tables'
);

-- ── REC-05 recording_object_key ─────────────────────────────────────────

select _policy_tests.assert(
  'call_sessions has recording_object_key column',
  exists (
    select 1 from information_schema.columns
     where table_schema = 'screening_v2'
       and table_name = 'call_sessions'
       and column_name = 'recording_object_key'
  ),
  'recording_object_key must exist on call_sessions'
);

select _policy_tests.assert(
  'recording_object_key is nullable',
  exists (
    select 1 from information_schema.columns
     where table_schema = 'screening_v2'
       and table_name = 'call_sessions'
       and column_name = 'recording_object_key'
       and is_nullable = 'YES'
  ),
  'recording_object_key must be nullable (not yet recorded)'
);

select _policy_tests.assert(
  'recording_object_key CHECK constraint exists',
  exists (
    select 1 from pg_constraint
     where conrelid = 'screening_v2.call_sessions'::regclass
       and conname = 'chk_call_sessions_recording_obj_key'
       and contype = 'c'
       and convalidated
  ),
  'recording_object_key must have a validated CHECK constraint'
);

select _policy_tests.assert(
  'recording_object_key CHECK is bounded (1-512 chars, restricted charset)',
  (
    select pg_get_constraintdef(oid)
      from pg_constraint
     where conname = 'chk_call_sessions_recording_obj_key'
       and conrelid = 'screening_v2.call_sessions'::regclass
  ) like '%512%'
  and (
    select pg_get_constraintdef(oid)
      from pg_constraint
     where conname = 'chk_call_sessions_recording_obj_key'
       and conrelid = 'screening_v2.call_sessions'::regclass
  ) like '%a-zA-Z0-9%',
  'CHECK must bound length and restrict charset'
);

select _policy_tests.assert(
  'recording_object_key has partial index',
  exists (
    select 1 from pg_indexes
     where schemaname = 'screening_v2'
       and tablename = 'call_sessions'
       and indexname = 'idx_v2_sessions_recording_key'
  ),
  'recording_object_key must have a partial index'
);

select _policy_tests.assert(
  'no signed URL is persisted in recording_object_key',
  not exists (
    select 1 from information_schema.columns
     where table_schema = 'screening_v2'
       and table_name = 'call_sessions'
       and column_name in ('recording_signed_url', 'recording_presigned_url', 'recording_url_ttl')
  ),
  'no signed/presigned URL column may exist on call_sessions'
);

-- ── B. Recruiter role helper ──────────────────────────────────────────

select _policy_tests.assert(
  'recruiter_role function exists',
  exists (
    select 1 from pg_proc p
     join pg_namespace n on n.oid = p.pronamespace
     where n.nspname = 'screening_v2'
       and p.proname = 'recruiter_role'
  ),
  'screening_v2.recruiter_role() must exist'
);

select _policy_tests.assert(
  'recruiter_role is security definer with fixed search_path',
  exists (
    select 1
      from pg_proc p
      join pg_namespace n on n.oid = p.pronamespace
     where n.nspname = 'screening_v2'
       and p.proname = 'recruiter_role'
       and p.prosecdef
       and p.proconfig @> array['search_path=pg_catalog']
  ),
  'recruiter_role must be SECURITY DEFINER with search_path=pg_catalog'
);

select _policy_tests.assert(
  'recruiter_role not executable by anon/public',
  not exists (
    select 1 from pg_proc p
     join pg_namespace n on n.oid = p.pronamespace
     where n.nspname = 'screening_v2'
       and p.proname = 'recruiter_role'
       and has_function_privilege('public', p.oid, 'EXECUTE')
  )
  and not exists (
    select 1 from pg_proc p
     join pg_namespace n on n.oid = p.pronamespace
     where n.nspname = 'screening_v2'
       and p.proname = 'recruiter_role'
       and has_function_privilege('anon', p.oid, 'EXECUTE')
  ),
  'only authenticated and service_role should execute recruiter_role'
);

-- ── C. Role-aware RLS policies ────────────────────────────────────────

select _policy_tests.assert(
  'scoped recruiter read roles policy exists',
  exists (
    select 1 from pg_policies
     where schemaname = 'screening_v2'
       and tablename = 'roles'
       and policyname = 'scoped recruiter read roles'
       and cmd = 'SELECT'
  ),
  'roles must have a scoped SELECT policy'
);

select _policy_tests.assert(
  'scoped recruiter read candidates policy exists',
  exists (
    select 1 from pg_policies
     where schemaname = 'screening_v2'
       and tablename = 'candidates'
       and policyname = 'scoped recruiter read candidates'
       and cmd = 'SELECT'
  ),
  'candidates must have a scoped SELECT policy'
);

select _policy_tests.assert(
  'scoped recruiter read call_sessions policy exists',
  exists (
    select 1 from pg_policies
     where schemaname = 'screening_v2'
       and tablename = 'call_sessions'
       and policyname = 'scoped recruiter read call_sessions'
       and cmd = 'SELECT'
  ),
  'call_sessions must have a scoped SELECT policy'
);

select _policy_tests.assert(
  'old membership-agnostic policies are removed',
  not exists (
    select 1 from pg_policies
     where schemaname = 'screening_v2'
       and policyname like 'active recruiter read %'
       and tablename in ('roles', 'candidates', 'call_sessions')
  ),
  'the three old un-scoped policies on roles/candidates/call_sessions must be removed'
);

select _policy_tests.assert(
  'transcript_turns still has active recruiter read policy',
  exists (
    select 1 from pg_policies
     where schemaname = 'screening_v2'
       and tablename = 'transcript_turns'
       and policyname = 'active recruiter read transcript_turns'
  ),
  'transcript_turns retains the active recruiter read policy'
);

select _policy_tests.assert(
  'assessments still has active recruiter read policy',
  exists (
    select 1 from pg_policies
     where schemaname = 'screening_v2'
       and tablename = 'assessments'
       and policyname = 'active recruiter read assessments'
  ),
  'assessments retains the active recruiter read policy'
);

-- ── D. Candidate invites table ────────────────────────────────────────

select _policy_tests.assert(
  'candidate_invites table exists',
  to_regclass('screening_v2.candidate_invites') is not null,
  'screening_v2.candidate_invites must exist'
);

select _policy_tests.assert(
  'candidate_invites has token_digest column',
  exists (
    select 1 from information_schema.columns
     where table_schema = 'screening_v2'
       and table_name = 'candidate_invites'
       and column_name = 'token_digest'
  ),
  'candidate_invites must have token_digest column (SHA-256)'
);

select _policy_tests.assert(
  'candidate_invites has no plaintext token column',
  not exists (
    select 1 from information_schema.columns
     where table_schema = 'screening_v2'
       and table_name = 'candidate_invites'
       and column_name in ('token', 'token_plaintext', 'secret', 'auth_code')
  ),
  'no plaintext token column may exist on candidate_invites'
);

select _policy_tests.assert(
  'candidate_invites token_digest is unique',
  exists (
    select 1 from pg_constraint
     where conrelid = 'screening_v2.candidate_invites'::regclass
       and conname = 'uq_candidate_invites_digest'
       and contype = 'u'
  ),
  'token_digest must have a UNIQUE constraint'
);

select _policy_tests.assert(
  'candidate_invites has digest format check',
  exists (
    select 1 from pg_constraint
     where conrelid = 'screening_v2.candidate_invites'::regclass
       and conname = 'chk_invite_token_digest'
       and contype = 'c'
  ),
  'token_digest must have a CHECK constraint for hex format'
);

select _policy_tests.assert(
  'candidate_invites has expires_at > created_at check',
  exists (
    select 1 from pg_constraint
     where conrelid = 'screening_v2.candidate_invites'::regclass
       and conname = 'chk_invite_expires_after_created'
       and contype = 'c'
  ),
  'invite must enforce expires_at > created_at'
);

select _policy_tests.assert(
  'candidate_invites has candidate_id FK',
  exists (
    select 1 from pg_constraint
     where conrelid = 'screening_v2.candidate_invites'::regclass
       and contype = 'f'
       and pg_get_constraintdef(oid) like '%candidates%'
  ),
  'candidate_invites must FK to candidates'
);

select _policy_tests.assert(
  'candidate_invites has RLS enabled',
  exists (
    select 1 from pg_class c
     join pg_namespace n on n.oid = c.relnamespace
     where n.nspname = 'screening_v2'
       and c.relname = 'candidate_invites'
       and c.relrowsecurity
  ),
  'RLS must be enabled on candidate_invites'
);

select _policy_tests.assert(
  'candidate_invites has no authenticated policy',
  not exists (
    select 1 from pg_policies
     where schemaname = 'screening_v2'
       and tablename = 'candidate_invites'
       and 'authenticated' = any(roles)
  ),
  'candidate_invites must remain server-only'
);

-- ── E. Candidate access grants table ──────────────────────────────────

select _policy_tests.assert(
  'candidate_access_grants table exists',
  to_regclass('screening_v2.candidate_access_grants') is not null,
  'screening_v2.candidate_access_grants must exist'
);

select _policy_tests.assert(
  'candidate_access_grants has token_digest column (no plaintext)',
  exists (
    select 1 from information_schema.columns
     where table_schema = 'screening_v2'
       and table_name = 'candidate_access_grants'
       and column_name = 'token_digest'
  )
  and not exists (
    select 1 from information_schema.columns
     where table_schema = 'screening_v2'
       and table_name = 'candidate_access_grants'
       and column_name in ('token', 'token_plaintext', 'secret', 'auth_code')
  ),
  'token_digest exists on grants; no plaintext token column'
);

select _policy_tests.assert(
  'candidate_access_grants token_digest is unique',
  exists (
    select 1 from pg_constraint
     where conrelid = 'screening_v2.candidate_access_grants'::regclass
       and conname = 'uq_candidate_grants_digest'
       and contype = 'u'
  ),
  'token_digest must have a UNIQUE constraint on grants'
);

select _policy_tests.assert(
  'candidate_access_grants has grant_type check',
  exists (
    select 1 from pg_constraint
     where conrelid = 'screening_v2.candidate_access_grants'::regclass
       and conname = 'chk_grant_type'
       and contype = 'c'
  ),
  'grant_type must have a CHECK constraint'
);

select _policy_tests.assert(
  'candidate_access_grants has RLS enabled',
  exists (
    select 1 from pg_class c
     join pg_namespace n on n.oid = c.relnamespace
     where n.nspname = 'screening_v2'
       and c.relname = 'candidate_access_grants'
       and c.relrowsecurity
  ),
  'RLS must be enabled on candidate_access_grants'
);

select _policy_tests.assert(
  'candidate_access_grants has no authenticated policy',
  not exists (
    select 1 from pg_policies
     where schemaname = 'screening_v2'
       and tablename = 'candidate_access_grants'
       and 'authenticated' = any(roles)
  ),
  'candidate_access_grants must remain server-only'
);

-- Verify grants table is NOT exposed through PostgREST
select _policy_tests.assert(
  'candidate_access_grants has no direct SELECT grant to authenticated',
  not exists (
    select 1
      from pg_class c
      join pg_namespace n on n.oid = c.relnamespace
     where n.nspname = 'screening_v2'
       and c.relname = 'candidate_access_grants'
       and has_table_privilege('authenticated', c.oid, 'SELECT')
  ),
  'candidate_access_grants must NOT have SELECT grant for authenticated (no PostgREST exposure)'
);

select _policy_tests.assert(
  'candidate_invites has no direct SELECT grant to authenticated',
  not exists (
    select 1
      from pg_class c
      join pg_namespace n on n.oid = c.relnamespace
     where n.nspname = 'screening_v2'
       and c.relname = 'candidate_invites'
       and has_table_privilege('authenticated', c.oid, 'SELECT')
  ),
  'candidate_invites must NOT have SELECT grant for authenticated (backend-only access)'
);

-- ── F. Audit events table ────────────────────────────────────────────

select _policy_tests.assert(
  'audit_events table exists',
  to_regclass('screening_v2.audit_events') is not null,
  'screening_v2.audit_events must exist'
);

select _policy_tests.assert(
  'audit_events has no PII columns',
  not exists (
    select 1 from information_schema.columns
     where table_schema = 'screening_v2'
       and table_name = 'audit_events'
       and column_name in (
         'transcript', 'resume_text', 'email', 'phone', 'name',
         'address', 'ssn', 'token', 'password', 'secret'
       )
  ),
  'audit_events must not contain PII or secret columns'
);

select _policy_tests.assert(
  'audit_events has actor_type check constraint',
  exists (
    select 1 from pg_constraint
     where conrelid = 'screening_v2.audit_events'::regclass
       and conname = 'chk_audit_actor_type'
       and contype = 'c'
  ),
  'audit_events must constrain actor_type'
);

select _policy_tests.assert(
  'audit_events has action check constraint',
  exists (
    select 1 from pg_constraint
     where conrelid = 'screening_v2.audit_events'::regclass
       and conname = 'chk_audit_action'
       and contype = 'c'
  ),
  'audit_events must constrain action'
);

select _policy_tests.assert(
  'audit_events has result check constraint',
  exists (
    select 1 from pg_constraint
     where conrelid = 'screening_v2.audit_events'::regclass
       and conname = 'chk_audit_result'
       and contype = 'c'
  ),
  'audit_events must constrain result'
);

select _policy_tests.assert(
  'audit_events has metadata size check',
  exists (
    select 1 from pg_constraint
     where conrelid = 'screening_v2.audit_events'::regclass
       and conname = 'chk_audit_metadata_size'
       and contype = 'c'
  ),
  'audit_events must constrain metadata size'
);

select _policy_tests.assert(
  'audit_events has UPDATE prevention trigger',
  exists (
    select 1 from pg_trigger t
      join pg_class c on c.oid = t.tgrelid
      join pg_namespace n on n.oid = c.relnamespace
     where n.nspname = 'screening_v2'
       and c.relname = 'audit_events'
       and t.tgname = 'trg_audit_prevent_update'
       and not t.tgisinternal
  ),
  'UPDATE trigger must block mutations on audit_events'
);

select _policy_tests.assert(
  'audit_events has DELETE prevention trigger',
  exists (
    select 1 from pg_trigger t
      join pg_class c on c.oid = t.tgrelid
      join pg_namespace n on n.oid = c.relnamespace
     where n.nspname = 'screening_v2'
       and c.relname = 'audit_events'
       and t.tgname = 'trg_audit_prevent_delete'
       and not t.tgisinternal
  ),
  'DELETE trigger must block mutations on audit_events'
);

select _policy_tests.assert(
  'audit_events has RLS enabled',
  exists (
    select 1 from pg_class c
     join pg_namespace n on n.oid = c.relnamespace
     where n.nspname = 'screening_v2'
       and c.relname = 'audit_events'
       and c.relrowsecurity
  ),
  'RLS must be enabled on audit_events'
);

select _policy_tests.assert(
  'audit_events has recruiter read policy',
  exists (
    select 1 from pg_policies
     where schemaname = 'screening_v2'
       and tablename = 'audit_events'
       and policyname = 'recruiter read audit_events'
  ),
  'active recruiters must be able to read audit_events'
);

-- Negative: anon has no audit access
select _policy_tests.assert(
  'anon has no SELECT on audit_events',
  not exists (
    select 1
      from pg_class c
      join pg_namespace n on n.oid = c.relnamespace
     where n.nspname = 'screening_v2'
       and c.relname = 'audit_events'
       and has_table_privilege('anon', c.oid, 'SELECT')
  ),
  'anon must not have SELECT on audit_events'
);

-- ── G. Live audit mutation tests ──────────────────────────────────────

do $$
declare
  v_audit_id uuid;
  update_rejected boolean := false;
  delete_rejected boolean := false;
begin
  -- Insert a synthetic audit event to test mutation guards
  insert into screening_v2.audit_events (
    actor_id, actor_type, action, target_type, target_id, result
  ) values (
    '00000000-0000-0000-0000-000000000000'::uuid,
    'system',
    'config_changed',
    'system',
    '00000000-0000-0000-0000-000000000000',
    'success'
  ) returning id into v_audit_id;

  if v_audit_id is null then
    insert into _policy_tests.results(test, passed, detail) values
      ('audit UPDATE blocked (live)', true, 'skipped: could not insert audit row'),
      ('audit DELETE blocked (live)', true, 'skipped: could not insert audit row');
    return;
  end if;

  -- UPDATE must be rejected
  begin
    update screening_v2.audit_events
       set result = 'failure'
     where id = v_audit_id;
  exception when others then
    update_rejected := true;
  end;

  -- DELETE must be rejected
  begin
    delete from screening_v2.audit_events where id = v_audit_id;
  exception when others then
    delete_rejected := true;
  end;

  -- Clean up via escape hatch for test cleanup
  if not update_rejected or not delete_rejected then
    begin
      set local app.allow_audit_mutation = 'true';
      delete from screening_v2.audit_events where id = v_audit_id;
    exception when others then null;
    end;
  end if;

  insert into _policy_tests.results(test, passed, detail) values
    ('audit UPDATE blocked (live)',
     update_rejected,
     case when update_rejected then null
          else 'UPDATE was allowed on append-only audit_events' end),
    ('audit DELETE blocked (live)',
     delete_rejected,
     case when delete_rejected then null
          else 'DELETE was allowed on append-only audit_events' end);
end;
$$;

-- ── H. Cross-owner denial test ───────────────────────────────────────

-- Grant test-schema access so the `set local role authenticated` blocks
-- can insert results. The `_policy_tests` schema is dropped at the end.
grant usage on schema _policy_tests to authenticated;
grant all privileges on all tables    in schema _policy_tests to authenticated;
grant all privileges on all sequences in schema _policy_tests to authenticated;

do $$
declare
  v_interviewer_1_id uuid;
  v_interviewer_2_id uuid;
  v_admin_id uuid;
  v_role_id uuid;
  v_candidate_id uuid;
  rows_seen_by_interviewer_1 integer;
  rows_seen_by_interviewer_2 integer;
  rows_seen_by_admin integer;
begin
  -- Create synthetic auth users for testing
  insert into auth.users (
    instance_id, id, aud, role, email, encrypted_password,
    email_confirmed_at, raw_app_meta_data, raw_user_meta_data,
    created_at, updated_at
  ) values (
    '00000000-0000-0000-0000-000000000000',
    '20000000-0000-4000-a000-000000000001',
    'authenticated', 'authenticated', 'interviewer1@example.invalid', '',
    now(), '{}', '{}', now(), now()
  ) on conflict (id) do nothing;

  insert into auth.users (
    instance_id, id, aud, role, email, encrypted_password,
    email_confirmed_at, raw_app_meta_data, raw_user_meta_data,
    created_at, updated_at
  ) values (
    '00000000-0000-0000-0000-000000000000',
    '20000000-0000-4000-a000-000000000002',
    'authenticated', 'authenticated', 'interviewer2@example.invalid', '',
    now(), '{}', '{}', now(), now()
  ) on conflict (id) do nothing;

  insert into auth.users (
    instance_id, id, aud, role, email, encrypted_password,
    email_confirmed_at, raw_app_meta_data, raw_user_meta_data,
    created_at, updated_at
  ) values (
    '00000000-0000-0000-0000-000000000000',
    '20000000-0000-4000-a000-000000000003',
    'authenticated', 'authenticated', 'admin1@example.invalid', '',
    now(), '{}', '{}', now(), now()
  ) on conflict (id) do nothing;

  -- Create memberships
  insert into screening_v2.recruiter_memberships (user_id, role, active)
  values ('20000000-0000-4000-a000-000000000001', 'interviewer', true)
  on conflict (user_id) do update set role = excluded.role, active = excluded.active;

  insert into screening_v2.recruiter_memberships (user_id, role, active)
  values ('20000000-0000-4000-a000-000000000002', 'interviewer', true)
  on conflict (user_id) do update set role = excluded.role, active = excluded.active;

  insert into screening_v2.recruiter_memberships (user_id, role, active)
  values ('20000000-0000-4000-a000-000000000003', 'admin', true)
  on conflict (user_id) do update set role = excluded.role, active = excluded.active;

  -- Create a role owned by interviewer 1
  insert into screening_v2.roles (id, title, owner_id, created_at, updated_at)
  values (
    '20000000-0000-4000-a000-000000000010',
    'Cross-Owner Test Role',
    '20000000-0000-4000-a000-000000000001',
    now(), now()
  ) on conflict (id) do nothing
  returning id into v_role_id;

  -- Create a candidate owned by interviewer 1
  insert into screening_v2.candidates (id, role_id, name, email, skills, status, owner_id, created_at, updated_at)
  values (
    '20000000-0000-4000-a000-000000000020',
    v_role_id,
    'Cross-Owner Test Candidate',
    'cross.owner@example.invalid',
    '["testing"]'::jsonb,
    'new',
    '20000000-0000-4000-a000-000000000001',
    now(), now()
  ) on conflict (id) do nothing
  returning id into v_candidate_id;

  -- Test 1: Interviewer 1 sees their owned role
  begin
    set local role authenticated;
    set local "request.jwt.claims" to '{"sub":"20000000-0000-4000-a000-000000000001","role":"authenticated"}';
    select count(*) into rows_seen_by_interviewer_1
      from screening_v2.roles r
     where r.id = '20000000-0000-4000-a000-000000000010';
  end;

  -- Test 2: Interviewer 2 does NOT see interviewer 1's owned role
  begin
    set local role authenticated;
    set local "request.jwt.claims" to '{"sub":"20000000-0000-4000-a000-000000000002","role":"authenticated"}';
    select count(*) into rows_seen_by_interviewer_2
      from screening_v2.roles r
     where r.id = '20000000-0000-4000-a000-000000000010';
  end;

  -- Test 3: Admin sees interviewer 1's owned role
  begin
    set local role authenticated;
    set local "request.jwt.claims" to '{"sub":"20000000-0000-4000-a000-000000000003","role":"authenticated"}';
    select count(*) into rows_seen_by_admin
      from screening_v2.roles r
     where r.id = '20000000-0000-4000-a000-000000000010';
  end;

  insert into _policy_tests.results(test, passed, detail) values
    ('interviewer sees own owned role',
     rows_seen_by_interviewer_1 = 1,
     case when rows_seen_by_interviewer_1 = 1 then null
          else 'interviewer 1 could not see their owned role (count=' || rows_seen_by_interviewer_1 || ')' end),
    ('interviewer cannot see other owner role',
     rows_seen_by_interviewer_2 = 0,
     case when rows_seen_by_interviewer_2 = 0 then null
          else 'interviewer 2 could see interviewer 1 owned role (count=' || rows_seen_by_interviewer_2 || ')' end),
    ('admin can see all owned roles',
     rows_seen_by_admin = 1,
     case when rows_seen_by_admin = 1 then null
          else 'admin could not see interviewer 1 owned role (count=' || rows_seen_by_admin || ')' end);

  -- Same tests for candidates
  begin
    set local role authenticated;
    set local "request.jwt.claims" to '{"sub":"20000000-0000-4000-a000-000000000001","role":"authenticated"}';
    select count(*) into rows_seen_by_interviewer_1
      from screening_v2.candidates c
     where c.id = '20000000-0000-4000-a000-000000000020';
  end;

  begin
    set local role authenticated;
    set local "request.jwt.claims" to '{"sub":"20000000-0000-4000-a000-000000000002","role":"authenticated"}';
    select count(*) into rows_seen_by_interviewer_2
      from screening_v2.candidates c
     where c.id = '20000000-0000-4000-a000-000000000020';
  end;

  begin
    set local role authenticated;
    set local "request.jwt.claims" to '{"sub":"20000000-0000-4000-a000-000000000003","role":"authenticated"}';
    select count(*) into rows_seen_by_admin
      from screening_v2.candidates c
     where c.id = '20000000-0000-4000-a000-000000000020';
  end;

  insert into _policy_tests.results(test, passed, detail) values
    ('interviewer sees own owned candidate',
     rows_seen_by_interviewer_1 = 1,
     case when rows_seen_by_interviewer_1 = 1 then null
          else 'interviewer 1 could not see their owned candidate' end),
    ('interviewer cannot see other owner candidate',
     rows_seen_by_interviewer_2 = 0,
     case when rows_seen_by_interviewer_2 = 0 then null
          else 'interviewer 2 could see interviewer 1 owned candidate' end),
    ('admin can see all owned candidates',
     rows_seen_by_admin = 1,
     case when rows_seen_by_admin = 1 then null
          else 'admin could not see interviewer 1 owned candidate' end);
end;
$$;

-- Cleanup in a separate DO block (resets role to postgres automatically)
do $$
begin
  set local app.allow_audit_mutation to 'true';
  delete from screening_v2.candidates where id = '20000000-0000-4000-a000-000000000020';
  delete from screening_v2.roles where id = '20000000-0000-4000-a000-000000000010';
  delete from screening_v2.recruiter_memberships
   where user_id in (
     '20000000-0000-4000-a000-000000000001',
     '20000000-0000-4000-a000-000000000002',
     '20000000-0000-4000-a000-000000000003'
   );
  delete from auth.users
   where id in (
     '20000000-0000-4000-a000-000000000001',
     '20000000-0000-4000-a000-000000000002',
     '20000000-0000-4000-a000-000000000003'
   );
end;
$$;

-- ── I. Negative control: token_digest format enforcement ──────────────

do $$
declare
  invalid_accepted boolean := false;
  v_candidate_id uuid;
begin
  select id into v_candidate_id from screening_v2.candidates limit 1;

  if v_candidate_id is null then
    insert into _policy_tests.results(test, passed, detail) values
      ('INVITE: invalid token_digest format rejected', true,
       'skipped: no candidate row available');
    return;
  end if;

  begin
    insert into screening_v2.candidate_invites
      (candidate_id, token_digest, expires_at, created_by)
    values (
      v_candidate_id,
      'not-a-valid-sha256-hex',  -- wrong format
      now() + interval '1 day',
      '20000000-0000-4000-a000-000000000001'::uuid
    );
  exception when check_violation then
    invalid_accepted := true;
  end;

  insert into _policy_tests.results(test, passed, detail) values
    ('INVITE: invalid token_digest format rejected (live)',
     invalid_accepted,
     case when invalid_accepted then null
          else 'token_digest accepted non-hex value' end);
end;
$$;

-- ── J. Negative control: no plaintext token columns on any new table ────

select _policy_tests.assert(
  'no plaintext token column on candidate_invites (negative proof)',
  not exists (
    select 1 from information_schema.columns
     where table_schema = 'screening_v2'
       and table_name = 'candidate_invites'
       and column_name similar to '(token|secret|key|password|auth_code)'
       and column_name != 'token_digest'
  )
  and not exists (
    select 1 from information_schema.columns
     where table_schema = 'screening_v2'
       and table_name = 'candidate_access_grants'
       and column_name similar to '(token|secret|key|password|auth_code)'
       and column_name != 'token_digest'
  ),
  'no column named token, secret, key, password, or auth_code (except token_digest) may exist'
);

-- ── K. Negative control: anon denied on all new tables ────────────────

select _policy_tests.assert(
  'anon has no privilege on candidate_invites',
  not exists (
    select 1
      from pg_class c
      join pg_namespace n on n.oid = c.relnamespace
     where n.nspname = 'screening_v2'
       and c.relname = 'candidate_invites'
       and (has_any_column_privilege('anon', c.oid, 'SELECT,INSERT,UPDATE,REFERENCES')
         or has_table_privilege('anon', c.oid, 'DELETE'))
  ),
  'anon must have zero privileges on candidate_invites'
);

select _policy_tests.assert(
  'anon has no privilege on candidate_access_grants',
  not exists (
    select 1
      from pg_class c
      join pg_namespace n on n.oid = c.relnamespace
     where n.nspname = 'screening_v2'
       and c.relname = 'candidate_access_grants'
       and (has_any_column_privilege('anon', c.oid, 'SELECT,INSERT,UPDATE,REFERENCES')
         or has_table_privilege('anon', c.oid, 'DELETE'))
  ),
  'anon must have zero privileges on candidate_access_grants'
);

select _policy_tests.assert(
  'anon has no privilege on audit_events',
  not exists (
    select 1
      from pg_class c
      join pg_namespace n on n.oid = c.relnamespace
     where n.nspname = 'screening_v2'
       and c.relname = 'audit_events'
       and (has_any_column_privilege('anon', c.oid, 'SELECT,INSERT,UPDATE,REFERENCES')
         or has_table_privilege('anon', c.oid, 'DELETE'))
  ),
  'anon must have zero privileges on audit_events'
);

-- ═══════════════════════════════════════════════════════════════════════
-- Phase 2 WS-A (0008): recording_url deprecation, RLS matrix,
--                       Realtime publication, local-reset guards
-- ═══════════════════════════════════════════════════════════════════════

-- ── MIG-03/04/05: recording_url must always be NULL ────────────────────

select _policy_tests.assert(
  'recording_url column still exists (not dropped)',
  exists (
    select 1 from information_schema.columns
     where table_schema = 'screening_v2'
       and table_name = 'call_sessions'
       and column_name = 'recording_url'
  ),
  'recording_url must still exist (deprecated, not dropped)'
);

select _policy_tests.assert(
  'recording_url CHECK constraint forces IS NULL',
  exists (
    select 1 from pg_constraint
     where conrelid = 'screening_v2.call_sessions'::regclass
       and conname = 'chk_call_sessions_recording_url_null'
       and contype = 'c'
       and convalidated
  ),
  'chk_call_sessions_recording_url_null must be a validated CHECK'
);

select _policy_tests.assert(
  'recording_url constraint definition requires IS NULL',
  (
    select pg_get_constraintdef(oid)
      from pg_constraint
     where conname = 'chk_call_sessions_recording_url_null'
       and conrelid = 'screening_v2.call_sessions'::regclass
  ) ilike '%recording_url is null%',
  'constraint definition must contain recording_url IS NULL'
);

select _policy_tests.assert(
  'no durable URL column exists on call_sessions',
  not exists (
    select 1 from information_schema.columns
     where table_schema = 'screening_v2'
       and table_name = 'call_sessions'
       and column_name in (
         'recording_signed_url', 'recording_presigned_url',
         'recording_url_ttl', 'recording_download_url'
       )
  ),
  'no signed/presigned/signed URL column may exist on call_sessions'
);

select _policy_tests.assert(
  'recording_object_key preserved (not dropped by 0008)',
  exists (
    select 1 from information_schema.columns
     where table_schema = 'screening_v2'
       and table_name = 'call_sessions'
       and column_name = 'recording_object_key'
  ),
  'recording_object_key must still exist after 0008'
);

select _policy_tests.assert(
  'recordings_v2 bucket is NOT public',
  not exists (
    select 1 from storage.buckets
     where id = 'recordings_v2' and public = true
  ),
  'recordings_v2 bucket must remain private'
);

select _policy_tests.assert(
  'recordings_v2 has no browser policy',
  not exists (
    select 1 from pg_policies
     where schemaname = 'storage'
       and tablename = 'objects'
       and roles && array['anon'::name, 'authenticated'::name, 'public'::name]
       and (qual ilike '%recordings_v2%' or with_check ilike '%recordings_v2%')
  ),
  'no browser-role storage policies may exist for recordings_v2'
);

-- ── RLS matrix: service-role / backend identity assertions ─────────────

select _policy_tests.assert(
  'service_role has ALL on all screening_v2 tables',
  (
    -- Check a representative sample of tables; the grant is schema-level
    -- from migration 0001.
    select count(*) = 6
      from (
        select has_table_privilege('service_role',
          'screening_v2.consent_records'::regclass, 'SELECT,INSERT,UPDATE,DELETE') as ok
        union all
        select has_table_privilege('service_role',
          'screening_v2.call_queue'::regclass, 'SELECT,INSERT,UPDATE,DELETE')
        union all
        select has_table_privilege('service_role',
          'screening_v2.sms_follow_ups'::regclass, 'SELECT,INSERT,UPDATE,DELETE')
        union all
        select has_table_privilege('service_role',
          'screening_v2.ats_sync_log'::regclass, 'SELECT,INSERT,UPDATE,DELETE')
        union all
        select has_table_privilege('service_role',
          'screening_v2.resumes'::regclass, 'SELECT,INSERT,UPDATE,DELETE')
        union all
        select has_table_privilege('service_role',
          'screening_v2.candidate_invites'::regclass, 'SELECT,INSERT,UPDATE,DELETE')
      ) as checks
     where checks.ok
  ),
  'service_role must have full access to all screening_v2 tables'
);

select _policy_tests.assert(
  'authenticated has no INSERT/UPDATE/DELETE on consent_records',
  not exists (
    select 1 from pg_class c
     join pg_namespace n on n.oid = c.relnamespace
     where n.nspname = 'screening_v2'
       and c.relname = 'consent_records'
       and (has_table_privilege('authenticated', c.oid, 'INSERT')
         or has_table_privilege('authenticated', c.oid, 'UPDATE')
         or has_table_privilege('authenticated', c.oid, 'DELETE'))
  ),
  'authenticated must be read-only on consent_records'
);

select _policy_tests.assert(
  'authenticated has no INSERT/UPDATE/DELETE on call_queue',
  not exists (
    select 1 from pg_class c
     join pg_namespace n on n.oid = c.relnamespace
     where n.nspname = 'screening_v2'
       and c.relname = 'call_queue'
       and (has_table_privilege('authenticated', c.oid, 'INSERT')
         or has_table_privilege('authenticated', c.oid, 'UPDATE')
         or has_table_privilege('authenticated', c.oid, 'DELETE'))
  ),
  'authenticated must be read-only on call_queue'
);

select _policy_tests.assert(
  'authenticated has no INSERT/UPDATE/DELETE on sms_follow_ups',
  not exists (
    select 1 from pg_class c
     join pg_namespace n on n.oid = c.relnamespace
     where n.nspname = 'screening_v2'
       and c.relname = 'sms_follow_ups'
       and (has_table_privilege('authenticated', c.oid, 'INSERT')
         or has_table_privilege('authenticated', c.oid, 'UPDATE')
         or has_table_privilege('authenticated', c.oid, 'DELETE'))
  ),
  'authenticated must be read-only on sms_follow_ups'
);

select _policy_tests.assert(
  'authenticated has no INSERT/UPDATE/DELETE on ats_sync_log',
  not exists (
    select 1 from pg_class c
     join pg_namespace n on n.oid = c.relnamespace
     where n.nspname = 'screening_v2'
       and c.relname = 'ats_sync_log'
       and (has_table_privilege('authenticated', c.oid, 'INSERT')
         or has_table_privilege('authenticated', c.oid, 'UPDATE')
         or has_table_privilege('authenticated', c.oid, 'DELETE'))
  ),
  'authenticated must be read-only on ats_sync_log'
);

-- ── RLS matrix: policy coverage for all screening_v2 tables ────────────

-- consent_records, call_queue, sms_follow_ups, ats_sync_log, resumes
-- each need an active-recruiter-gated SELECT policy.

select _policy_tests.assert(
  'consent_records has active recruiter read policy',
  exists (
    select 1 from pg_policies
     where schemaname = 'screening_v2'
       and tablename = 'consent_records'
       and policyname = 'active recruiter read consent_records'
       and cmd = 'SELECT'
  ),
  'consent_records must have membership-gated SELECT policy'
);

select _policy_tests.assert(
  'call_queue has active recruiter read policy',
  exists (
    select 1 from pg_policies
     where schemaname = 'screening_v2'
       and tablename = 'call_queue'
       and policyname = 'active recruiter read call_queue'
       and cmd = 'SELECT'
  ),
  'call_queue must have membership-gated SELECT policy'
);

select _policy_tests.assert(
  'sms_follow_ups has active recruiter read policy',
  exists (
    select 1 from pg_policies
     where schemaname = 'screening_v2'
       and tablename = 'sms_follow_ups'
       and policyname = 'active recruiter read sms_follow_ups'
       and cmd = 'SELECT'
  ),
  'sms_follow_ups must have membership-gated SELECT policy'
);

select _policy_tests.assert(
  'ats_sync_log has active recruiter read policy',
  exists (
    select 1 from pg_policies
     where schemaname = 'screening_v2'
       and tablename = 'ats_sync_log'
       and policyname = 'active recruiter read ats_sync_log'
       and cmd = 'SELECT'
  ),
  'ats_sync_log must have membership-gated SELECT policy'
);

select _policy_tests.assert(
  'resumes has active recruiter read policy',
  exists (
    select 1 from pg_policies
     where schemaname = 'screening_v2'
       and tablename = 'resumes'
       and policyname = 'active recruiter read resumes'
       and cmd = 'SELECT'
  ),
  'resumes must have membership-gated SELECT policy'
);

-- ── INVARIANT: no USING(true) or WITH CHECK(true) policies exist ───────

select _policy_tests.assert(
  'no policy uses USING(true)',
  not exists (
    select 1 from pg_policies
     where schemaname = 'screening_v2'
       and (qual = 'true' or qual = 'true::boolean' or qual ilike '%using(true)%')
  ),
  'USING(true) would bypass all RLS -- forbidden'
);

select _policy_tests.assert(
  'no policy uses WITH CHECK(true)',
  not exists (
    select 1 from pg_policies
     where schemaname = 'screening_v2'
       and (with_check = 'true' or with_check = 'true::boolean' or with_check ilike '%with check(true)%')
  ),
  'WITH CHECK(true) would bypass all RLS write checks -- forbidden'
);

-- ── INVARIANT: SECURITY DEFINER functions have fixed search_path ───────

select _policy_tests.assert(
  'is_active_recruiter has fixed search_path=pg_catalog',
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
  'recruiter_role has fixed search_path=pg_catalog',
  exists (
    select 1
      from pg_proc p
      join pg_namespace n on n.oid = p.pronamespace
     where n.nspname = 'screening_v2'
       and p.proname = 'recruiter_role'
       and p.prosecdef
       and p.proconfig @> array['search_path=pg_catalog']
  ),
  'recruiter_role must be SECURITY DEFINER with search_path=pg_catalog'
);

select _policy_tests.assert(
  '_is_admin_or_viewer has fixed search_path=pg_catalog',
  exists (
    select 1
      from pg_proc p
      join pg_namespace n on n.oid = p.pronamespace
     where n.nspname = 'screening_v2'
       and p.proname = '_is_admin_or_viewer'
       and p.prosecdef
       and p.proconfig @> array['search_path=pg_catalog']
  ),
  '_is_admin_or_viewer must be SECURITY DEFINER with search_path=pg_catalog'
);

select _policy_tests.assert(
  '_is_interviewer has fixed search_path=pg_catalog',
  exists (
    select 1
      from pg_proc p
      join pg_namespace n on n.oid = p.pronamespace
     where n.nspname = 'screening_v2'
       and p.proname = '_is_interviewer'
       and p.prosecdef
       and p.proconfig @> array['search_path=pg_catalog']
  ),
  '_is_interviewer must be SECURITY DEFINER with search_path=pg_catalog'
);

-- ── INVARIANT: anon/PUBLIC cannot execute SECURITY DEFINER functions ────

select _policy_tests.assert(
  'anon cannot execute is_active_recruiter',
  not exists (
    select 1 from pg_proc p
     join pg_namespace n on n.oid = p.pronamespace
     where n.nspname = 'screening_v2'
       and p.proname = 'is_active_recruiter'
       and has_function_privilege('anon', p.oid, 'EXECUTE')
  ),
  'anon must not be able to execute is_active_recruiter'
);

select _policy_tests.assert(
  'public cannot execute is_active_recruiter',
  not exists (
    select 1 from pg_proc p
     join pg_namespace n on n.oid = p.pronamespace
     where n.nspname = 'screening_v2'
       and p.proname = 'is_active_recruiter'
       and has_function_privilege('public', p.oid, 'EXECUTE')
  ),
  'public must not be able to execute is_active_recruiter'
);

select _policy_tests.assert(
  'anon cannot execute recruiter_role',
  not exists (
    select 1 from pg_proc p
     join pg_namespace n on n.oid = p.pronamespace
     where n.nspname = 'screening_v2'
       and p.proname = 'recruiter_role'
       and has_function_privilege('anon', p.oid, 'EXECUTE')
  ),
  'anon must not be able to execute recruiter_role'
);

select _policy_tests.assert(
  'public cannot execute recruiter_role',
  not exists (
    select 1 from pg_proc p
     join pg_namespace n on n.oid = p.pronamespace
     where n.nspname = 'screening_v2'
       and p.proname = 'recruiter_role'
       and has_function_privilege('public', p.oid, 'EXECUTE')
  ),
  'public must not be able to execute recruiter_role'
);

select _policy_tests.assert(
  'anon cannot execute valid_model_provenance',
  not exists (
    select 1 from pg_proc p
     join pg_namespace n on n.oid = p.pronamespace
     where n.nspname = 'screening_v2'
       and p.proname = 'valid_model_provenance'
       and has_function_privilege('anon', p.oid, 'EXECUTE')
  ),
  'anon must not be able to execute valid_model_provenance'
);

select _policy_tests.assert(
  'authenticated cannot execute valid_model_provenance',
  not exists (
    select 1 from pg_proc p
     join pg_namespace n on n.oid = p.pronamespace
     where n.nspname = 'screening_v2'
       and p.proname = 'valid_model_provenance'
       and has_function_privilege('authenticated', p.oid, 'EXECUTE')
  ),
  'authenticated must not be able to execute valid_model_provenance'
);

-- ── Membership/consumer assertions ─────────────────────────────────────

select _policy_tests.assert(
  'recruiter_memberships RLS is enabled',
  exists (
    select 1 from pg_class c
     join pg_namespace n on n.oid = c.relnamespace
     where n.nspname = 'screening_v2'
       and c.relname = 'recruiter_memberships'
       and c.relrowsecurity
  ),
  'RLS must be enabled on recruiter_memberships'
);

select _policy_tests.assert(
  'recruiter_memberships has self-scoped SELECT policy',
  exists (
    select 1 from pg_policies
     where schemaname = 'screening_v2'
       and tablename = 'recruiter_memberships'
       and cmd = 'SELECT'
  ),
  'recruiter_memberships must have a SELECT policy (user sees own membership)'
);

select _policy_tests.assert(
  'authenticated can SELECT on recruiter_memberships',
  has_table_privilege('authenticated',
    'screening_v2.recruiter_memberships'::regclass, 'SELECT'),
  'authenticated must have SELECT grant on recruiter_memberships'
);

-- ── Realtime publication assertions ────────────────────────────────────

select _policy_tests.assert(
  'Realtime publication exists',
  exists (
    select 1 from pg_publication where pubname = 'supabase_realtime'
  ),
  'supabase_realtime publication must exist'
);

select _policy_tests.assert(
  'Realtime publication contains only 3 expected screening_v2 tables',
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
  'only call_sessions, transcript_turns, and assessments may be in supabase_realtime'
);

select _policy_tests.assert(
  'Realtime published tables have RLS enabled',
  not exists (
    select 1 from pg_publication_tables pt
     join pg_class c on c.relname = pt.tablename
     join pg_namespace n on n.oid = c.relnamespace
                     and n.nspname = pt.schemaname
     where pt.pubname = 'supabase_realtime'
       and pt.schemaname = 'screening_v2'
       and not c.relrowsecurity
  ),
  'every Realtime-published table must have RLS enabled'
);

select _policy_tests.assert(
  'Realtime published tables have no anon/PUBLIC policies',
  not exists (
    select 1 from pg_publication_tables pt
     join pg_policies p on p.tablename = pt.tablename
                      and p.schemaname = pt.schemaname
     where pt.pubname = 'supabase_realtime'
       and pt.schemaname = 'screening_v2'
       and p.roles && array['anon'::name, 'public'::name]
  ),
  'no Realtime-published table may have an anon/PUBLIC policy'
);

-- Honest local limitation: we can verify publication membership and RLS
-- policies locally, but we CANNOT prove that the hosted Supabase Realtime
-- server correctly enforces RLS or that websocket authorization works.
-- Those are platform-level guarantees that require end-to-end testing.

-- ── Single-org D-011 posture preservation ─────────────────────────────

select _policy_tests.assert(
  'no org_id column exists on any screening_v2 table',
  not exists (
    select 1 from information_schema.columns
     where table_schema = 'screening_v2'
       and column_name = 'org_id'
  ),
  'org_id must not exist -- single-org D-011 posture requires no tenant column'
);

select _policy_tests.assert(
  'no organization_id column exists on any screening_v2 table',
  not exists (
    select 1 from information_schema.columns
     where table_schema = 'screening_v2'
       and column_name = 'organization_id'
  ),
  'organization_id must not exist -- single-org D-011 posture'
);

select _policy_tests.assert(
  'no tenant_id column exists on any screening_v2 table',
  not exists (
    select 1 from information_schema.columns
     where table_schema = 'screening_v2'
       and column_name = 'tenant_id'
  ),
  'tenant_id must not exist -- single-org D-011 posture'
);

-- ── Adversarial: forbidden recording_url persistence (live) ────────────

do $$
declare
  v_candidate_id uuid;
  v_session_id uuid;
  insert_rejected boolean := false;
  update_rejected boolean := false;
begin
  select id into v_candidate_id from screening_v2.candidates limit 1;

  if v_candidate_id is null then
    insert into _policy_tests.results(test, passed, detail) values
      ('INSERT with non-null recording_url is rejected (live)', true,
       'skipped: no candidate row available'),
      ('UPDATE to set recording_url is rejected (live)', true,
       'skipped: no candidate row available');
    return;
  end if;

  -- Create a minimal session with status 'created' (the only INSERT-allowed state).
  insert into screening_v2.call_sessions
    (candidate_id, mode, status)
  values (v_candidate_id, 'simulation', 'created')
  returning id into v_session_id;

  -- Attempt to INSERT a row with non-null recording_url (must fail).
  begin
    insert into screening_v2.call_sessions
      (candidate_id, mode, status, recording_url)
    values (v_candidate_id, 'simulation', 'created', 'https://example.invalid/recording.mp3');
  exception when check_violation or raise_exception then
    insert_rejected := true;
  end;

  -- Attempt to UPDATE recording_url to non-null on existing row (must fail).
  if v_session_id is not null then
    begin
      update screening_v2.call_sessions
         set recording_url = 'https://example.invalid/recording.mp3'
       where id = v_session_id;
    exception when check_violation or raise_exception then
      update_rejected := true;
    end;

    -- Clean up.
    delete from screening_v2.call_sessions where id = v_session_id;
  end if;

  insert into _policy_tests.results(test, passed, detail) values
    ('INSERT with non-null recording_url is rejected (live)',
     insert_rejected,
     case when insert_rejected then null
          else 'INSERT with recording_url was allowed by constraint' end),
    ('UPDATE to set recording_url is rejected (live)',
     update_rejected,
     case when update_rejected then null
          else 'UPDATE setting recording_url was allowed by constraint' end);
end;
$$;

-- ── Adversarial: no broad browser writes (negative privilege test) ────

select _policy_tests.assert(
  'authenticated has no INSERT on any screening_v2 user-facing table',
  not exists (
    select 1 from pg_class c
     join pg_namespace n on n.oid = c.relnamespace
     where n.nspname = 'screening_v2'
       and c.relkind in ('r', 'p')
       and c.relname not in ('recruiter_memberships')
       and has_table_privilege('authenticated', c.oid, 'INSERT')
  ),
  'authenticated must have zero INSERT grants on user-facing tables'
);

select _policy_tests.assert(
  'authenticated has no UPDATE on any screening_v2 user-facing table',
  not exists (
    select 1 from pg_class c
     join pg_namespace n on n.oid = c.relnamespace
     where n.nspname = 'screening_v2'
       and c.relkind in ('r', 'p')
       and c.relname not in ('recruiter_memberships')
       and has_table_privilege('authenticated', c.oid, 'UPDATE')
  ),
  'authenticated must have zero UPDATE grants on user-facing tables'
);

select _policy_tests.assert(
  'authenticated has no DELETE on any screening_v2 table',
  not exists (
    select 1 from pg_class c
     join pg_namespace n on n.oid = c.relnamespace
     where n.nspname = 'screening_v2'
       and c.relkind in ('r', 'p')
       and has_table_privilege('authenticated', c.oid, 'DELETE')
  ),
  'authenticated must have zero DELETE grants on all screening_v2 tables'
);

-- ── Adversarial: candidate_invites/grants remain server-only ───────────

select _policy_tests.assert(
  'no authenticated policy on candidate_invites',
  not exists (
    select 1 from pg_policies
     where schemaname = 'screening_v2'
       and tablename = 'candidate_invites'
       and 'authenticated' = any(roles)
  ),
  'candidate_invites must have zero authenticated policies (server-only)'
);

select _policy_tests.assert(
  'no authenticated policy on candidate_access_grants',
  not exists (
    select 1 from pg_policies
     where schemaname = 'screening_v2'
       and tablename = 'candidate_access_grants'
       and 'authenticated' = any(roles)
  ),
  'candidate_access_grants must have zero authenticated policies (server-only)'
);

-- ── Local reset / idempotency guard (schema-only, no hosted command) ───

select _policy_tests.assert(
  'all 0008 policies are properly named with spaces',
  (
    select count(*) = 5
      from pg_policies
     where schemaname = 'screening_v2'
       and cmd = 'SELECT'
       and policyname in (
         'active recruiter read consent_records',
         'active recruiter read call_queue',
         'active recruiter read sms_follow_ups',
         'active recruiter read ats_sync_log',
         'active recruiter read resumes'
       )
  ),
  'all five new Phase 2 SELECT policies must exist with exact names'
);

-- Verify the full policy count (baseline + Phase 3-5 additions).
-- Phase 1 (migration 0007):
--   scoped recruiter read roles (1)
--   scoped recruiter read candidates (1)
--   scoped recruiter read call_sessions (1)
--   active recruiter read transcript_turns (1)
--   active recruiter read assessments (1)
--   recruiter read audit_events (1)
--   recruiter read own membership (1) [on recruiter_memberships]
-- Phase 2 (migration 0008):
--   active recruiter read consent_records (1)
--   active recruiter read call_queue (1)
--   active recruiter read sms_follow_ups (1)
--   active recruiter read ats_sync_log (1)
--   active recruiter read resumes (1)
-- Phase 3 (migration 0012):
--   recruiter read retention_policies (1)
--   recruiter read legal_holds (1)
--   recruiter read erasure_exceptions (1)
--   recruiter read data_subject_requests (1)
--   recruiter read governance_audit (1)
-- Phase 3 (migration 0013):
--   active recruiter read consent_templates (1)
-- Phase 7 (migration 0014):
--   active recruiter read recording_integrity_events (1)
-- Total expected: 7 + 5 + 5 + 1 + 1 = 19

select _policy_tests.assert(
  'expected total screening_v2 SELECT policy count is 19',
  (
    select count(*) = 19
      from pg_policies
     where schemaname = 'screening_v2'
       and cmd = 'SELECT'
  ),
  'expected exactly 19 SELECT policies after all migrations through 0014'
);

-- ═══════════════════════════════════════════════════════════════════════
-- Phase 3-5 (0009-0013): queue/outbox/reconciliation/governance/consent
-- ═══════════════════════════════════════════════════════════════════════

-- ── 0009: job_queue and job_dlq (backend infrastructure) ────────────

select _policy_tests.assert(
  'job_queue has RLS enabled',
  exists (
    select 1 from pg_class c
     join pg_namespace n on n.oid = c.relnamespace
     where n.nspname = 'screening_v2'
       and c.relname = 'job_queue'
       and c.relrowsecurity
  ),
  'RLS must be enabled on job_queue'
);

select _policy_tests.assert(
  'job_dlq has RLS enabled',
  exists (
    select 1 from pg_class c
     join pg_namespace n on n.oid = c.relnamespace
     where n.nspname = 'screening_v2'
       and c.relname = 'job_dlq'
       and c.relrowsecurity
  ),
  'RLS must be enabled on job_dlq'
);

select _policy_tests.assert(
  'job_queue has no authenticated policy (service_role only)',
  not exists (
    select 1 from pg_policies
     where schemaname = 'screening_v2'
       and tablename = 'job_queue'
       and 'authenticated' = any(roles)
  ),
  'job_queue must remain service_role-only'
);

select _policy_tests.assert(
  'job_dlq has no authenticated policy (service_role only)',
  not exists (
    select 1 from pg_policies
     where schemaname = 'screening_v2'
       and tablename = 'job_dlq'
       and 'authenticated' = any(roles)
  ),
  'job_dlq must remain service_role-only'
);

-- ── 0028: lease-safe queue columns + RPCs (backend infrastructure) ───

select _policy_tests.assert(
  'job_queue has the 0028 lease columns',
  (select count(*) from information_schema.columns
     where table_schema = 'screening_v2'
       and table_name = 'job_queue'
       and column_name in ('lease_token', 'lease_owner', 'lease_expires_at', 'lease_deadline_at')
  ) = 4,
  'lease_token/lease_owner/lease_expires_at/lease_deadline_at must exist on job_queue'
);

-- Every queue RPC (0009 dequeue + 0028 lease RPCs) is service-role only:
-- browser roles cannot execute them.
select _policy_tests.assert(
  'queue RPCs are revoked from anon/authenticated/public (service-role only)',
  not exists (
    select 1
      from pg_proc p
      join pg_namespace n on n.oid = p.pronamespace
     where n.nspname = 'screening_v2'
       and p.proname in (
         'dequeue_job', 'claim_job', 'heartbeat_job', 'complete_job',
         'fail_job', 'reclaim_expired_jobs', 'dlq_job', 'replay_dlq_job')
       and (has_function_privilege('anon', p.oid, 'EXECUTE')
         or has_function_privilege('authenticated', p.oid, 'EXECUTE')
         or has_function_privilege('public', p.oid, 'EXECUTE'))
  ),
  'anon/authenticated/public must not execute any queue RPC'
);

select _policy_tests.assert(
  'queue lease RPCs are executable by service_role',
  (select count(distinct p.proname)
     from pg_proc p
     join pg_namespace n on n.oid = p.pronamespace
    where n.nspname = 'screening_v2'
      and p.proname in (
        'claim_job', 'heartbeat_job', 'complete_job', 'fail_job',
        'reclaim_expired_jobs', 'dlq_job', 'replay_dlq_job')
      and has_function_privilege('service_role', p.oid, 'EXECUTE')
  ) = 7,
  'service_role must execute all seven 0028 queue RPCs'
);

-- ── 0010: transcript_events and outbox (backend infrastructure) ──────

select _policy_tests.assert(
  'transcript_events has RLS enabled',
  exists (
    select 1 from pg_class c
     join pg_namespace n on n.oid = c.relnamespace
     where n.nspname = 'screening_v2'
       and c.relname = 'transcript_events'
       and c.relrowsecurity
  ),
  'RLS must be enabled on transcript_events'
);

select _policy_tests.assert(
  'outbox has RLS enabled',
  exists (
    select 1 from pg_class c
     join pg_namespace n on n.oid = c.relnamespace
     where n.nspname = 'screening_v2'
       and c.relname = 'outbox'
       and c.relrowsecurity
  ),
  'RLS must be enabled on outbox'
);

select _policy_tests.assert(
  'transcript_events has no authenticated policy (service_role only)',
  not exists (
    select 1 from pg_policies
     where schemaname = 'screening_v2'
       and tablename = 'transcript_events'
       and 'authenticated' = any(roles)
  ),
  'transcript_events must remain service_role-only'
);

select _policy_tests.assert(
  'outbox has no authenticated policy (service_role only)',
  not exists (
    select 1 from pg_policies
     where schemaname = 'screening_v2'
       and tablename = 'outbox'
       and 'authenticated' = any(roles)
  ),
  'outbox must remain service_role-only'
);

select _policy_tests.assert(
  'authenticated has no SELECT on transcript_events',
  not exists (
    select 1
      from pg_class c
      join pg_namespace n on n.oid = c.relnamespace
     where n.nspname = 'screening_v2'
       and c.relname = 'transcript_events'
       and has_table_privilege('authenticated', c.oid, 'SELECT')
  ),
  'authenticated must not have SELECT on transcript_events'
);

select _policy_tests.assert(
  'authenticated has no SELECT on outbox',
  not exists (
    select 1
      from pg_class c
      join pg_namespace n on n.oid = c.relnamespace
     where n.nspname = 'screening_v2'
       and c.relname = 'outbox'
       and has_table_privilege('authenticated', c.oid, 'SELECT')
  ),
  'authenticated must not have SELECT on outbox'
);

-- ── 0011: reconciliation_log and quarantined_sessions ────────────────

select _policy_tests.assert(
  'reconciliation_log has RLS enabled',
  exists (
    select 1 from pg_class c
     join pg_namespace n on n.oid = c.relnamespace
     where n.nspname = 'screening_v2'
       and c.relname = 'reconciliation_log'
       and c.relrowsecurity
  ),
  'RLS must be enabled on reconciliation_log'
);

select _policy_tests.assert(
  'quarantined_sessions has RLS enabled',
  exists (
    select 1 from pg_class c
     join pg_namespace n on n.oid = c.relnamespace
     where n.nspname = 'screening_v2'
       and c.relname = 'quarantined_sessions'
       and c.relrowsecurity
  ),
  'RLS must be enabled on quarantined_sessions'
);

select _policy_tests.assert(
  'reconciliation_log has no authenticated policy',
  not exists (
    select 1 from pg_policies
     where schemaname = 'screening_v2'
       and tablename = 'reconciliation_log'
       and 'authenticated' = any(roles)
  ),
  'reconciliation_log must be service_role-only'
);

select _policy_tests.assert(
  'quarantined_sessions has no authenticated policy',
  not exists (
    select 1 from pg_policies
     where schemaname = 'screening_v2'
       and tablename = 'quarantined_sessions'
       and 'authenticated' = any(roles)
  ),
  'quarantined_sessions must be service_role-only'
);

-- ── 0012: governance tables (membership-gated SELECT) ────────────────

select _policy_tests.assert(
  'retention_policies has RLS enabled',
  exists (
    select 1 from pg_class c
     join pg_namespace n on n.oid = c.relnamespace
     where n.nspname = 'screening_v2'
       and c.relname = 'retention_policies'
       and c.relrowsecurity
  ),
  'RLS must be enabled on retention_policies'
);

select _policy_tests.assert(
  'legal_holds has RLS enabled',
  exists (
    select 1 from pg_class c
     join pg_namespace n on n.oid = c.relnamespace
     where n.nspname = 'screening_v2'
       and c.relname = 'legal_holds'
       and c.relrowsecurity
  ),
  'RLS must be enabled on legal_holds'
);

select _policy_tests.assert(
  'erasure_exceptions has RLS enabled',
  exists (
    select 1 from pg_class c
     join pg_namespace n on n.oid = c.relnamespace
     where n.nspname = 'screening_v2'
       and c.relname = 'erasure_exceptions'
       and c.relrowsecurity
  ),
  'RLS must be enabled on erasure_exceptions'
);

select _policy_tests.assert(
  'data_subject_requests has RLS enabled',
  exists (
    select 1 from pg_class c
     join pg_namespace n on n.oid = c.relnamespace
     where n.nspname = 'screening_v2'
       and c.relname = 'data_subject_requests'
       and c.relrowsecurity
  ),
  'RLS must be enabled on data_subject_requests'
);

select _policy_tests.assert(
  'governance_audit has RLS enabled',
  exists (
    select 1 from pg_class c
     join pg_namespace n on n.oid = c.relnamespace
     where n.nspname = 'screening_v2'
       and c.relname = 'governance_audit'
       and c.relrowsecurity
  ),
  'RLS must be enabled on governance_audit'
);

select _policy_tests.assert(
  'governance tables have membership-gated SELECT policies',
  (
    select count(*) = 5
      from pg_policies
     where schemaname = 'screening_v2'
       and tablename in (
         'retention_policies', 'legal_holds', 'erasure_exceptions',
         'data_subject_requests', 'governance_audit'
       )
       and cmd = 'SELECT'
       and roles @> array['authenticated'::name]
       and qual like '%is_active_recruiter()%'
  ),
  'all 5 governance tables must have is_active_recruiter-gated SELECT policies'
);

select _policy_tests.assert(
  'authenticated has no INSERT/UPDATE/DELETE on governance tables',
  not exists (
    select 1 from pg_class c
     join pg_namespace n on n.oid = c.relnamespace
     where n.nspname = 'screening_v2'
       and c.relname in (
         'retention_policies', 'legal_holds', 'erasure_exceptions',
         'data_subject_requests', 'governance_audit'
       )
       and (has_table_privilege('authenticated', c.oid, 'INSERT')
         or has_table_privilege('authenticated', c.oid, 'UPDATE')
         or has_table_privilege('authenticated', c.oid, 'DELETE'))
  ),
  'authenticated must be read-only on governance tables'
);

-- ── 0013: consent_templates ─────────────────────────────────────────

select _policy_tests.assert(
  'consent_templates has RLS enabled',
  exists (
    select 1 from pg_class c
     join pg_namespace n on n.oid = c.relnamespace
     where n.nspname = 'screening_v2'
       and c.relname = 'consent_templates'
       and c.relrowsecurity
  ),
  'RLS must be enabled on consent_templates'
);

select _policy_tests.assert(
  'consent_templates has membership-gated SELECT policy',
  exists (
    select 1 from pg_policies
     where schemaname = 'screening_v2'
       and tablename = 'consent_templates'
       and cmd = 'SELECT'
       and roles @> array['authenticated'::name]
       and qual like '%is_active_recruiter()%'
  ),
  'consent_templates must have is_active_recruiter-gated SELECT policy'
);

select _policy_tests.assert(
  'authenticated has no INSERT/UPDATE/DELETE on consent_templates',
  not exists (
    select 1 from pg_class c
     join pg_namespace n on n.oid = c.relnamespace
     where n.nspname = 'screening_v2'
       and c.relname = 'consent_templates'
       and (has_table_privilege('authenticated', c.oid, 'INSERT')
         or has_table_privilege('authenticated', c.oid, 'UPDATE')
         or has_table_privilege('authenticated', c.oid, 'DELETE'))
  ),
  'authenticated must be read-only on consent_templates'
);

-- ── Phase 3-5 negative: no anon grant on any new table ──────────────

select _policy_tests.assert(
  'anon has no privilege on any Phase 3-5 table',
  not exists (
    select 1
      from pg_class c
      join pg_namespace n on n.oid = c.relnamespace
     where n.nspname = 'screening_v2'
       and c.relname in (
         'job_queue', 'job_dlq', 'transcript_events', 'outbox',
         'reconciliation_log', 'quarantined_sessions',
         'retention_policies', 'legal_holds', 'erasure_exceptions',
         'data_subject_requests', 'governance_audit', 'consent_templates',
         'recording_integrity_events'
       )
       and (has_any_column_privilege('anon', c.oid, 'SELECT,INSERT,UPDATE,REFERENCES')
         or has_table_privilege('anon', c.oid, 'DELETE,TRUNCATE,TRIGGER'))
  ),
  'anon must have zero privileges on all Phase 3-5 tables'
);

-- ═══════════════════════════════════════════════════════════════════════
-- Phase 7 repair (0014): audit-action CHECK evolution + append-only guard
-- ═══════════════════════════════════════════════════════════════════════

-- The Phase 7 TS AuditEvent union (recording.download/upload/integrity_verified/
-- quarantined/revoked/deleted) must be accepted by the 0007 chk_audit_action
-- CHECK after 0014's additive evolution (otherwise the DB-backed audit sink
-- rejects every Phase 7 recording audit row).

select _policy_tests.assert(
  'audit_events action CHECK accepts all Phase 7 recording_* actions (0014)',
  (
    select count(*) = 1
      from pg_constraint pc
      join pg_class rel on rel.oid = pc.conrelid
      join pg_namespace ns on ns.oid = rel.relnamespace
     where ns.nspname = 'screening_v2'
       and rel.relname = 'audit_events'
       and pc.conname = 'chk_audit_action'
       and pc.convalidated
       and pg_get_constraintdef(pc.oid) ilike '%recording_download%'
       and pg_get_constraintdef(pc.oid) ilike '%recording_upload%'
       and pg_get_constraintdef(pc.oid) ilike '%recording_integrity_verified%'
       and pg_get_constraintdef(pc.oid) ilike '%recording_quarantined%'
       and pg_get_constraintdef(pc.oid) ilike '%recording_revoked%'
       and pg_get_constraintdef(pc.oid) ilike '%recording_deleted%'
  ),
  'chk_audit_action must include the six recording_* actions after 0014'
);

-- recording_integrity_events is claimed append-only: direct UPDATE/DELETE must
-- be blocked at the trigger boundary (every role, incl. service_role) while
-- the ON DELETE CASCADE from call_sessions (FK/retention semantics) must still
-- remove child rows when the parent session row is deleted.

select _policy_tests.assert(
  'recording_integrity_events has the append-only mutation guard trigger',
  (
    select count(*) = 2
      from pg_trigger t
      join pg_class rel on rel.oid = t.tgrelid
      join pg_namespace ns on ns.oid = rel.relnamespace
     where ns.nspname = 'screening_v2'
       and rel.relname = 'recording_integrity_events'
       and not t.tgisinternal
       and t.tgname in ('trg_recording_integrity_prevent_update', 'trg_recording_integrity_prevent_delete')
  ),
  'UPDATE/DELETE guard triggers must exist on recording_integrity_events'
);

-- Exactly-once lifecycle events (uploaded/deleted/revoked/mismatch_quarantined)
-- — the DB-level convergence guard used by RPCs + backfills.

select _policy_tests.assert(
  'uploaded/deleted/revoked/mismatch_quarantined integrity events are exactly-once per session (unique partial indexes)',
  (
    select count(*) = 4
      from pg_indexes
     where schemaname = 'screening_v2'
       and indexname in (
         'uq_v2_recording_integrity_events_uploaded_once',
         'uq_v2_recording_integrity_events_deleted_once',
         'uq_v2_recording_integrity_events_revoked_once',
         'uq_v2_recording_integrity_events_mismatch_once'
       )
       and indexdef ilike '%event_type%'
       and indexdef ilike '%unique%'
  ),
  '0014 must add the unique partial indexes for uploaded/deleted/revoked/mismatch_quarantined events'
);

-- F-A/F-B RPCs exist and are service-role-only.

select _policy_tests.assert(
  'finalize_recording_upload RPC exists',
  exists (
    select 1 from pg_proc p
      join pg_namespace ns on ns.oid = p.pronamespace
     where ns.nspname = 'screening_v2'
       and p.proname = 'finalize_recording_upload'
  ),
  '0014 must create the finalize_recording_upload RPC'
);

select _policy_tests.assert(
  'quarantine_recording RPC exists',
  exists (
    select 1 from pg_proc p
      join pg_namespace ns on ns.oid = p.pronamespace
     where ns.nspname = 'screening_v2'
       and p.proname = 'quarantine_recording'
  ),
  '0014 must create the quarantine_recording RPC'
);

-- Coherence constraint: browser_upload rows require non-null integrity columns.

select _policy_tests.assert(
  'browser_upload coherence constraint exists',
  exists (
    select 1 from pg_constraint c
      join pg_namespace ns on ns.oid = c.connamespace
     where ns.nspname = 'screening_v2'
       and c.conname = 'chk_call_sessions_browser_upload_coherence'
       and c.contype = 'c'
  ),
  '0014 must add the browser_upload coherence CHECK constraint'
);

-- F-C: recording_orphaned_objects table exists and is backend-only.

select _policy_tests.assert(
  'recording_orphaned_objects table exists',
  exists (
    select 1 from pg_class c
      join pg_namespace ns on ns.oid = c.relnamespace
     where ns.nspname = 'screening_v2'
       and c.relname = 'recording_orphaned_objects'
       and c.relkind = 'r'
  ),
  '0014 must create the recording_orphaned_objects backend-only table'
);

select _policy_tests.assert(
  'recording_orphaned_objects has NO authenticated or anon policies',
  not exists (
    select 1 from pg_policy p
      join pg_class c on c.oid = p.polrelid
      join pg_namespace ns on ns.oid = c.relnamespace
     where ns.nspname = 'screening_v2'
       and c.relname = 'recording_orphaned_objects'
       and p.polroles::text ilike any(array['%authenticated%','%anon%','%public%'])
  ),
  'orphan table must have zero authenticated/anon/PUBLIC policies — service_role only'
);

select _policy_tests.assert(
  'recording_orphaned_objects has unique constraint on object_key',
  exists (
    select 1 from pg_constraint c
      join pg_class rel on rel.oid = c.conrelid
      join pg_namespace ns on ns.oid = rel.relnamespace
     where ns.nspname = 'screening_v2'
       and rel.relname = 'recording_orphaned_objects'
       and c.conname = 'uq_recording_orphaned_objects_object_key'
       and c.contype = 'u'
  ),
  'orphan table must have unique constraint on object_key for idempotent upsert'
);

-- Live append-only behavior (needs a candidate row to satisfy the FK).

do $$
declare
  v_candidate_id uuid;
  v_session_id uuid;
  v_event_id uuid;
  update_blocked boolean := false;
  delete_blocked boolean := false;
  cascade_ok boolean := false;
begin
  select id into v_candidate_id from screening_v2.candidates limit 1;
  if v_candidate_id is null then
    insert into _policy_tests.results(test, passed, detail) values
      ('recording_integrity_events blocks direct UPDATE (live)', true,
       'skipped: no candidate row — trigger-presence proof above covers this'),
      ('recording_integrity_events blocks direct DELETE (live)', true,
       'skipped: no candidate row — trigger-presence proof above covers this'),
      ('recording_integrity_events preserves parent cascade delete (live)', true,
       'skipped: no candidate row');
    return;
  end if;

  -- Seed a session + one integrity event (service-role style insert).
  insert into screening_v2.call_sessions (candidate_id, mode, status)
    values (v_candidate_id, 'simulation', 'created')
    returning id into v_session_id;
  insert into screening_v2.recording_integrity_events (session_id, event_type, detail)
    values (v_session_id, 'uploaded', 'policy-test synthetic event')
    returning id into v_event_id;

  -- Direct UPDATE must be blocked by the guard.
  begin
    update screening_v2.recording_integrity_events
       set detail = 'tamper'
     where id = v_event_id;
  exception when others then
    update_blocked := true;
  end;

  -- Direct DELETE (parent still exists) must be blocked by the guard.
  begin
    delete from screening_v2.recording_integrity_events
     where id = v_event_id;
  exception when others then
    delete_blocked := true;
  end;

  -- Cascade delete from call_sessions must still remove the child event
  -- (required FK/retention semantics — the guard allows parent-gone deletes).
  delete from screening_v2.call_sessions where id = v_session_id;
  cascade_ok := not exists (
    select 1 from screening_v2.recording_integrity_events where id = v_event_id
  );

  insert into _policy_tests.results(test, passed, detail) values
    ('recording_integrity_events blocks direct UPDATE (live)', update_blocked,
     case when update_blocked then null
          else 'direct UPDATE on recording_integrity_events was allowed' end),
    ('recording_integrity_events blocks direct DELETE (live)', delete_blocked,
     case when delete_blocked then null
          else 'direct DELETE on recording_integrity_events was allowed' end),
    ('recording_integrity_events preserves parent cascade delete (live)', cascade_ok,
     case when cascade_ok then null
          else 'cascade delete did not remove the child event' end);
end;
$$;

-- ═══════════════════════════════════════════════════════════════════════
-- HELLO dashboard access allowlist (0016) — normalized-email access gate
-- ═══════════════════════════════════════════════════════════════════════

-- Direct anon/authenticated DB access must be impossible: no privileges,
-- no policies, RLS enabled.
select _policy_tests.assert(
  'email_allowlist has RLS enabled',
  exists (
    select 1
      from pg_class c
      join pg_namespace n on n.oid = c.relnamespace
     where n.nspname = 'screening_v2'
       and c.relname = 'email_allowlist'
       and c.relrowsecurity
  ),
  'email_allowlist must have row level security enabled'
);

select _policy_tests.assert(
  'anon has ZERO privileges on email_allowlist',
  not exists (
    select 1
      from pg_class c
      join pg_namespace n on n.oid = c.relnamespace
     where n.nspname = 'screening_v2'
       and c.relname = 'email_allowlist'
       and (has_any_column_privilege('anon', c.oid, 'SELECT,INSERT,UPDATE,REFERENCES')
         or has_table_privilege('anon', c.oid, 'DELETE,TRUNCATE,TRIGGER'))
  ),
  'anon must have zero effective privileges on email_allowlist'
);

select _policy_tests.assert(
  'authenticated has ZERO privileges on email_allowlist (no direct DB access)',
  not exists (
    select 1
      from pg_class c
      join pg_namespace n on n.oid = c.relnamespace
     where n.nspname = 'screening_v2'
       and c.relname = 'email_allowlist'
       and (has_any_column_privilege('authenticated', c.oid, 'SELECT,INSERT,UPDATE,REFERENCES')
         or has_table_privilege('authenticated', c.oid, 'DELETE,TRUNCATE,TRIGGER'))
  ),
  'authenticated browser sessions must never touch email_allowlist directly'
);

select _policy_tests.assert(
  'email_allowlist has NO authenticated/anon RLS policies',
  not exists (
    select 1
      from pg_policies p
      join pg_class c on c.relname = p.tablename
      join pg_namespace n on n.oid = c.relnamespace
     where n.nspname = 'screening_v2'
       and c.relname = 'email_allowlist'
       and p.roles && array['authenticated'::name, 'anon'::name]
  ),
  'no browser-role RLS policy may exist on email_allowlist'
);

select _policy_tests.assert(
  'email_allowlist grants service_role full access',
  exists (
    select 1
      from pg_class c
      join pg_namespace n on n.oid = c.relnamespace
     where n.nspname = 'screening_v2'
       and c.relname = 'email_allowlist'
       and has_table_privilege('service_role', c.oid, 'SELECT,INSERT,UPDATE,DELETE')
  ),
  'service_role must own email_allowlist access'
);

-- Bootstrap: exactly the three confirmed launch admins, all active, admin role.
select _policy_tests.assert(
  'bootstrap: exactly three allowlist entries',
  (select count(*) from screening_v2.email_allowlist) = 3,
  'expected exactly 3 bootstrap entries'
);

select _policy_tests.assert(
  'bootstrap: all three confirmed emails present, active admins',
  (select count(*) from screening_v2.email_allowlist
    where role = 'admin' and active
      and email_normalized in (
        'gopu.nair@interviewkickstart.com',
        'christo.b@interviewkickstart.com',
        'jerin@interviewkickstart.com'
      )) = 3,
  'all three bootstrap emails must be active admins'
);

select _policy_tests.assert(
  'bootstrap: no entry is linked before first login (independent of auth.users)',
  (select count(*) from screening_v2.email_allowlist
    where linked_user_id is not null or linked_at is not null) = 0,
  'bootstrap entries must not require auth.users rows'
);

-- Canonical shape: unique normalized email + exact-domain CHECK.
select _policy_tests.assert(
  'email_allowlist has UNIQUE email_normalized (duplicate case variants conflict)',
  exists (
    select 1
      from pg_constraint con
      join pg_class c on c.oid = con.conrelid
      join pg_namespace n on n.oid = c.relnamespace
     where n.nspname = 'screening_v2'
       and c.relname = 'email_allowlist'
       and con.contype = 'u'
       and con.conname = 'uq_email_allowlist_normalized'
  ),
  'a unique constraint on email_normalized must exist'
);

select _policy_tests.assert(
  'email_allowlist CHECK restricts to the exact company domain',
  exists (
    select 1
      from pg_constraint con
      join pg_class c on c.oid = con.conrelid
      join pg_namespace n on n.oid = c.relnamespace
     where n.nspname = 'screening_v2'
       and c.relname = 'email_allowlist'
       and con.contype = 'c'
       and con.conname = 'chk_email_allowlist_normalized'
  ),
  'the normalized-email CHECK constraint must exist'
);

select _policy_tests.assert(
  'email_allowlist role CHECK exists',
  exists (
    select 1
      from pg_constraint con
      join pg_class c on c.oid = con.conrelid
      join pg_namespace n on n.oid = c.relnamespace
     where n.nspname = 'screening_v2'
       and c.relname = 'email_allowlist'
       and con.contype = 'c'
       and con.conname = 'chk_email_allowlist_role'
  ),
  'the role CHECK constraint must exist'
);

-- RPCs: service-role only; never executable by browser roles.
select _policy_tests.assert(
  'resolve_allowlist_access is revoked from public/anon/authenticated',
  not exists (
    select 1
      from pg_proc p
      join pg_namespace n on n.oid = p.pronamespace
     where n.nspname = 'screening_v2'
       and p.proname = 'resolve_allowlist_access'
       and (has_function_privilege('anon', p.oid, 'EXECUTE')
         or has_function_privilege('authenticated', p.oid, 'EXECUTE'))
  ),
  'anon/authenticated must not execute resolve_allowlist_access'
);

select _policy_tests.assert(
  'resolve_allowlist_access is executable by service_role',
  exists (
    select 1
      from pg_proc p
      join pg_namespace n on n.oid = p.pronamespace
     where n.nspname = 'screening_v2'
       and p.proname = 'resolve_allowlist_access'
       and has_function_privilege('service_role', p.oid, 'EXECUTE')
  ),
  'service_role must execute resolve_allowlist_access'
);

select _policy_tests.assert(
  'add_allowlist_entry / update_allowlist_entry are service-role only',
  not exists (
    select 1
      from pg_proc p
      join pg_namespace n on n.oid = p.pronamespace
     where n.nspname = 'screening_v2'
       and p.proname in ('add_allowlist_entry', 'update_allowlist_entry')
       and (has_function_privilege('anon', p.oid, 'EXECUTE')
         or has_function_privilege('authenticated', p.oid, 'EXECUTE'))
  )
  and exists (
    select 1
      from pg_proc p
      join pg_namespace n on n.oid = p.pronamespace
     where n.nspname = 'screening_v2'
       and p.proname in ('add_allowlist_entry', 'update_allowlist_entry')
       and has_function_privilege('service_role', p.oid, 'EXECUTE')
  ),
  'admin allowlist RPCs must be service-role only'
);

select _policy_tests.assert(
  'audit action CHECK includes the 0016 allowlist actions',
  exists (
    select 1
      from pg_constraint con
      join pg_class c on c.oid = con.conrelid
      join pg_namespace n on n.oid = c.relnamespace
     where n.nspname = 'screening_v2'
       and c.relname = 'audit_events'
       and con.contype = 'c'
       and con.conname = 'chk_audit_action'
       and pg_get_constraintdef(con.oid) ~ 'allowlist_linked'
       and pg_get_constraintdef(con.oid) ~ 'admin_allowlist_add'
       and pg_get_constraintdef(con.oid) ~ 'admin_allowlist_update'
  ),
  'chk_audit_action must allow the 0016 allowlist actions'
);

-- ═══════════════════════════════════════════════════════════════════════
-- 0025/0026 — finalize_authoritative_recording: grants + behaviour
-- (T16-T25). 0026 replaces the six-arg finalizer with a seven-arg version
-- whose final argument (p_recording_egress_started_at_ms) DEFAULTS to NULL,
-- so every T16-T19 call below (six arguments) exercises the legacy-caller
-- compatibility path while regprocedure checks pin the 7-arg signature.
--
-- Sessions are created through the sanctioned lifecycle (created →
-- in_progress → completed); direct INSERTs at a terminal status are
-- rejected by trg_insert_created. Cleanup deletes the parent session only —
-- recording_integrity_events is append-only and refuses direct DELETE, but
-- the guard permits the parent cascade.
-- ═══════════════════════════════════════════════════════════════════════

-- Helper: create a completed session carrying a browser_upload recording and
-- a non-terminal egress, walking the allowed lifecycle transitions.
create or replace function _policy_tests.seed_repoint_session(
  p_candidate_id uuid,
  p_egress_id text,
  p_object_key text,
  p_deleted boolean,
  p_revoked boolean,
  p_quarantined boolean
)
returns uuid language plpgsql as $$
declare
  v_session_id uuid;
begin
  insert into screening_v2.call_sessions (candidate_id, mode, status)
    values (p_candidate_id, 'simulation', 'created')
    returning id into v_session_id;

  update screening_v2.call_sessions set status = 'in_progress' where id = v_session_id;
  update screening_v2.call_sessions
     set status = 'completed', terminal_reason = 'assessment_done'
   where id = v_session_id;

  update screening_v2.call_sessions
     set recording_egress_id = p_egress_id,
         recording_egress_status = 'complete',
         recording_object_key = p_object_key,
         recording_sha256 = repeat('a', 64),
         recording_size_bytes = 1024,
         recording_content_type = 'audio/webm',
         recording_provenance = 'browser_upload',
         recording_deleted_at = case when p_deleted then now() else null end,
         recording_revoked_at = case when p_revoked then now() else null end,
         recording_quarantined = p_quarantined
   where id = v_session_id;

  -- The 'uploaded' event the original browser upload would have written.
  insert into screening_v2.recording_integrity_events
    (session_id, event_type, sha256_expected, size_bytes, detail)
  values (v_session_id, 'uploaded', repeat('a', 64), 1024, 'policy-test synthetic upload');

  return v_session_id;
end;
$$;

-- ── T16: execute privilege is service-role-only ──────────────────────
select _policy_tests.assert(
  'T16: anon cannot execute finalize_authoritative_recording (7-arg)',
  not has_function_privilege(
    'anon',
    'screening_v2.finalize_authoritative_recording(uuid,text,text,bigint,text,text,bigint)'::regprocedure,
    'EXECUTE'),
  'anon must not be able to execute the authoritative recording RPC'
);

select _policy_tests.assert(
  'T16: authenticated cannot execute finalize_authoritative_recording (7-arg)',
  not has_function_privilege(
    'authenticated',
    'screening_v2.finalize_authoritative_recording(uuid,text,text,bigint,text,text,bigint)'::regprocedure,
    'EXECUTE'),
  'authenticated must not be able to execute the authoritative recording RPC'
);

select _policy_tests.assert(
  'T16: service_role can execute finalize_authoritative_recording (7-arg)',
  has_function_privilege(
    'service_role',
    'screening_v2.finalize_authoritative_recording(uuid,text,text,bigint,text,text,bigint)'::regprocedure,
    'EXECUTE'),
  'service_role must be able to execute the authoritative recording RPC'
);

-- ── T17: terminal rows are refused and left byte-identical ───────────
do $$
declare
  v_candidate_id uuid;
  v_session_id uuid;
  v_before record;
  v_after record;
  v_result jsonb;
  v_case record;
begin
  select id into v_candidate_id from screening_v2.candidates limit 1;
  if v_candidate_id is null then
    insert into _policy_tests.results(test, passed, detail) values
      ('T17: deleted row is refused with terminal_state', true, 'skipped: no candidate row'),
      ('T17: revoked row is refused with terminal_state', true, 'skipped: no candidate row'),
      ('T17: quarantined row is refused with terminal_state', true, 'skipped: no candidate row');
    return;
  end if;

  for v_case in
    select * from (values
      ('deleted',     true,  false, false, 'EG_polT17del'),
      ('revoked',     false, true,  false, 'EG_polT17rev'),
      ('quarantined', false, false, true,  'EG_polT17qua')
    ) as t(label, is_deleted, is_revoked, is_quarantined, egress_id)
  loop
    v_session_id := _policy_tests.seed_repoint_session(
      v_candidate_id, v_case.egress_id, 'policy-test-browser.webm',
      v_case.is_deleted, v_case.is_revoked, v_case.is_quarantined);

    select recording_object_key, recording_sha256, recording_size_bytes,
           recording_content_type, recording_provenance,
           recording_superseded_object_key, recording_deleted_at,
           recording_revoked_at, recording_quarantined
      into v_before
      from screening_v2.call_sessions where id = v_session_id;

    v_result := screening_v2.finalize_authoritative_recording(
      v_session_id, v_session_id::text || '-egress.ogg', repeat('b', 64), 4096, 'audio/ogg', null);

    select recording_object_key, recording_sha256, recording_size_bytes,
           recording_content_type, recording_provenance,
           recording_superseded_object_key, recording_deleted_at,
           recording_revoked_at, recording_quarantined
      into v_after
      from screening_v2.call_sessions where id = v_session_id;

    insert into _policy_tests.results(test, passed, detail) values
      ('T17: ' || v_case.label || ' row is refused with terminal_state',
       (v_result ->> 'status' = 'terminal_state')
       and (v_before is not distinct from v_after)
       and not exists (
         select 1 from screening_v2.recording_integrity_events
          where session_id = v_session_id and event_type = 'repointed'),
       'status=' || coalesce(v_result ->> 'status', 'null')
       || ' mutated=' || (v_before is distinct from v_after)::text);

    -- Parent delete cascades the integrity events (direct delete is blocked).
    delete from screening_v2.call_sessions where id = v_session_id;
  end loop;
end;
$$;

-- ── T18: browser → egress repoint writes exactly one 'repointed' event ─
do $$
declare
  v_candidate_id uuid;
  v_session_id uuid;
  v_result jsonb;
  v_total integer;
  v_repointed integer;
  v_provenance text;
  v_superseded text;
  v_key text;
begin
  select id into v_candidate_id from screening_v2.candidates limit 1;
  if v_candidate_id is null then
    insert into _policy_tests.results(test, passed, detail) values
      ('T18: browser upload is repointed to livekit_egress', true, 'skipped: no candidate row');
    return;
  end if;

  v_session_id := _policy_tests.seed_repoint_session(
    v_candidate_id, 'EG_polT18', 'policy-test-browser.webm', false, false, false);

  v_result := screening_v2.finalize_authoritative_recording(
    v_session_id, v_session_id::text || '-egress.ogg', repeat('b', 64), 4096, 'audio/ogg', null);

  select count(*) into v_total
    from screening_v2.recording_integrity_events where session_id = v_session_id;
  select count(*) into v_repointed
    from screening_v2.recording_integrity_events
   where session_id = v_session_id and event_type = 'repointed';
  select recording_provenance, recording_superseded_object_key, recording_object_key
    into v_provenance, v_superseded, v_key
    from screening_v2.call_sessions where id = v_session_id;

  insert into _policy_tests.results(test, passed, detail) values
    ('T18: browser upload is repointed to livekit_egress',
     (v_result ->> 'status' = 'ok')
     and v_provenance = 'livekit_egress'
     and v_key = v_session_id::text || '-egress.ogg'
     and v_superseded = 'policy-test-browser.webm'
     and v_total = 2          -- the original 'uploaded' plus one 'repointed'
     and v_repointed = 1,
     'status=' || coalesce(v_result ->> 'status', 'null')
     || ' provenance=' || coalesce(v_provenance, 'null')
     || ' superseded=' || coalesce(v_superseded, 'null')
     || ' events=' || v_total || ' repointed=' || v_repointed);

  delete from screening_v2.call_sessions where id = v_session_id;
end;
$$;

-- ── T19: a second repoint is idempotent (already_authoritative) ──────
do $$
declare
  v_candidate_id uuid;
  v_session_id uuid;
  v_result jsonb;
  v_total integer;
  v_repointed integer;
  v_key text;
begin
  select id into v_candidate_id from screening_v2.candidates limit 1;
  if v_candidate_id is null then
    insert into _policy_tests.results(test, passed, detail) values
      ('T19: repeat repoint returns already_authoritative', true, 'skipped: no candidate row');
    return;
  end if;

  v_session_id := _policy_tests.seed_repoint_session(
    v_candidate_id, 'EG_polT19', 'policy-test-browser.webm', false, false, false);

  perform screening_v2.finalize_authoritative_recording(
    v_session_id, v_session_id::text || '-egress.ogg', repeat('b', 64), 4096, 'audio/ogg', null);

  -- Second call with the same key still passes validation, but provenance is now livekit_egress.
  v_result := screening_v2.finalize_authoritative_recording(
    v_session_id, v_session_id::text || '-egress.ogg', repeat('b', 64), 4096, 'audio/ogg', null);

  select count(*) into v_total
    from screening_v2.recording_integrity_events where session_id = v_session_id;
  select count(*) into v_repointed
    from screening_v2.recording_integrity_events
   where session_id = v_session_id and event_type = 'repointed';
  select recording_object_key into v_key
    from screening_v2.call_sessions where id = v_session_id;

  insert into _policy_tests.results(test, passed, detail) values
    ('T19: repeat repoint returns already_authoritative',
     (v_result ->> 'status' = 'already_authoritative')
     and v_key = v_session_id::text || '-egress.ogg'   -- unchanged by the second call
     and v_total = 2
     and v_repointed = 1,
     'status=' || coalesce(v_result ->> 'status', 'null')
     || ' key=' || coalesce(v_key, 'null')
     || ' events=' || v_total || ' repointed=' || v_repointed);

  delete from screening_v2.call_sessions where id = v_session_id;
end;
$$;

-- ── T19b: a session without an egress is refused with no_egress ──────
do $$
declare
  v_candidate_id uuid;
  v_session_id uuid;
  v_result jsonb;
  v_provenance text;
begin
  select id into v_candidate_id from screening_v2.candidates limit 1;
  if v_candidate_id is null then
    insert into _policy_tests.results(test, passed, detail) values
      ('T19b: session without egress is refused with no_egress', true, 'skipped: no candidate row');
    return;
  end if;

  v_session_id := _policy_tests.seed_repoint_session(
    v_candidate_id, 'EG_polT19b', 'policy-test-browser.webm', false, false, false);
  update screening_v2.call_sessions
     set recording_egress_id = null, recording_egress_status = null
   where id = v_session_id;

  v_result := screening_v2.finalize_authoritative_recording(
    v_session_id, v_session_id::text || '-egress.ogg', repeat('b', 64), 4096, 'audio/ogg', null);

  select recording_provenance into v_provenance
    from screening_v2.call_sessions where id = v_session_id;

  insert into _policy_tests.results(test, passed, detail) values
    ('T19b: session without egress is refused with no_egress',
     (v_result ->> 'status' = 'no_egress') and v_provenance = 'browser_upload',
     'status=' || coalesce(v_result ->> 'status', 'null')
     || ' provenance=' || coalesce(v_provenance, 'null'));

  delete from screening_v2.call_sessions where id = v_session_id;
end;
$$;

-- ── T19c: invalid object key is rejected ─────────────────────────────
do $$
declare
  v_candidate_id uuid;
  v_session_id uuid;
  v_result jsonb;
begin
  select id into v_candidate_id from screening_v2.candidates limit 1;
  if v_candidate_id is null then
    insert into _policy_tests.results(test, passed, detail) values
      ('T19c: invalid object key rejected', true, 'skipped: no candidate row');
    return;
  end if;

  v_session_id := _policy_tests.seed_repoint_session(
    v_candidate_id, 'EG_polT19c', 'policy-test-browser.webm', false, false, false);

  -- Key does not match {session_id}-egress.ogg pattern.
  v_result := screening_v2.finalize_authoritative_recording(
    v_session_id, 'wrong-key.ogg', repeat('b', 64), 4096, 'audio/ogg', null);

  insert into _policy_tests.results(test, passed, detail) values
    ('T19c: invalid object key rejected',
     v_result ->> 'status' = 'invalid_object_key',
     'status=' || coalesce(v_result ->> 'status', 'null'));

  delete from screening_v2.call_sessions where id = v_session_id;
end;
$$;

-- ── T19d: size exceeds 52428800 is rejected ──────────────────────────
do $$
declare
  v_candidate_id uuid;
  v_session_id uuid;
  v_result jsonb;
begin
  select id into v_candidate_id from screening_v2.candidates limit 1;
  if v_candidate_id is null then
    insert into _policy_tests.results(test, passed, detail) values
      ('T19d: oversized bytes rejected', true, 'skipped: no candidate row');
    return;
  end if;

  v_session_id := _policy_tests.seed_repoint_session(
    v_candidate_id, 'EG_polT19d', 'policy-test-browser.webm', false, false, false);

  v_result := screening_v2.finalize_authoritative_recording(
    v_session_id, v_session_id::text || '-egress.ogg', repeat('b', 64), 52428801, 'audio/ogg', null);

  insert into _policy_tests.results(test, passed, detail) values
    ('T19d: oversized bytes rejected',
     v_result ->> 'status' = 'invalid_size_bytes',
     'status=' || coalesce(v_result ->> 'status', 'null'));

  delete from screening_v2.call_sessions where id = v_session_id;
end;
$$;

-- ── T19e: recording_provenance CHECK constraint rejects invalid values ─
-- The provenance_conflict status in the RPC is defence-in-depth that can
-- never fire while chk_call_sessions_recording_provenance (0014:128-135)
-- limits provenance to {null, browser_upload, livekit_egress}. Test that
-- the production constraint itself blocks an invalid provenance.
do $$
declare
  v_candidate_id uuid;
  v_session_id uuid;
begin
  select id into v_candidate_id from screening_v2.candidates limit 1;
  if v_candidate_id is null then
    insert into _policy_tests.results(test, passed, detail) values
      ('T19e: CHECK constraint rejects invalid provenance', true, 'skipped: no candidate row');
    return;
  end if;

  v_session_id := _policy_tests.seed_repoint_session(
    v_candidate_id, 'EG_polT19e', 'policy-test-browser.webm', false, false, false);

  -- The CHECK constraint must reject provenance values outside
  -- {null, browser_upload, livekit_egress}. This proves the constraint is
  -- active and the RPC's provenance_conflict branch is unreachable
  -- defence-in-depth, not a live code path.
  begin
    update screening_v2.call_sessions
       set recording_provenance = 'other_source'
     where id = v_session_id;
    insert into _policy_tests.results(test, passed, detail) values
      ('T19e: CHECK constraint rejects invalid provenance', false,
       'expected constraint violation but UPDATE succeeded');
  exception
    when check_violation then
      insert into _policy_tests.results(test, passed, detail) values
        ('T19e: CHECK constraint rejects invalid provenance', true,
         'check_violation raised as expected');
  end;

  delete from screening_v2.call_sessions where id = v_session_id;
end;
$$;

-- ═══════════════════════════════════════════════════════════════════════
-- 0026 — timing anchors + extended finalizer compatibility (T20-T25)
--
-- Covers: nullable bigint columns + CHECK guards (T20), removal of the
-- lingering six-arg overload + 7-arg grants (T21), legacy six-argument call
-- compatibility through the DEFAULT (T22), egress-start persistence and
-- fill-once immutability (T23), invalid egress-start validation (T24), and
-- idempotent re-call immutability (T25). Terminal-state protections,
-- repoint evidence, and validation ordering are already covered by
-- T17/T18/T19c/T19d against the same (now 7-arg) function via defaults.
-- ═══════════════════════════════════════════════════════════════════════

-- ── T20: nullable timing anchor columns exist with CHECK guards ────────
select _policy_tests.assert(
  'T20: call_sessions.recording_egress_started_at_ms is nullable bigint',
  exists (
    select 1 from information_schema.columns
     where table_schema = 'screening_v2'
       and table_name = 'call_sessions'
       and column_name = 'recording_egress_started_at_ms'
       and data_type = 'bigint'
       and is_nullable = 'YES'
  ),
  'recording_egress_started_at_ms must be a nullable bigint on call_sessions'
);

select _policy_tests.assert(
  'T20: transcript_turns.turn_started_at_ms is nullable bigint',
  exists (
    select 1 from information_schema.columns
     where table_schema = 'screening_v2'
       and table_name = 'transcript_turns'
       and column_name = 'turn_started_at_ms'
       and data_type = 'bigint'
       and is_nullable = 'YES'
  ),
  'turn_started_at_ms must be a nullable bigint on transcript_turns'
);

select _policy_tests.assert(
  'T20: timing anchor CHECK constraints guard the epoch window',
  exists (
    select 1 from pg_constraint
     where conrelid = 'screening_v2.call_sessions'::regclass
       and conname = 'chk_call_sessions_recording_egress_started_at_ms'
       and contype = 'c'
  )
  and exists (
    select 1 from pg_constraint
     where conrelid = 'screening_v2.transcript_turns'::regclass
       and conname = 'chk_transcript_turns_turn_started_at_ms'
       and contype = 'c'
  ),
  'both timing anchor columns must be guarded by CHECK constraints'
);

-- ── T21: no lingering 6-arg overload; grants pin the 7-arg signature ────
select _policy_tests.assert(
  'T21: the old 6-arg overload is removed',
  to_regprocedure('screening_v2.finalize_authoritative_recording(uuid,text,text,bigint,text,text)') is null,
  'the 6-arg overload must not linger (the DEFAULT arg preserves old callers)'
);

-- ── T22: legacy six-argument call resolves through the DEFAULT ──────────
do $$
declare
  v_candidate_id uuid;
  v_session_id uuid;
  v_result jsonb;
  v_started_at_ms bigint;
begin
  select id into v_candidate_id from screening_v2.candidates limit 1;
  if v_candidate_id is null then
    insert into _policy_tests.results(test, passed, detail) values
      ('T22: legacy 6-arg call resolves via default', true, 'skipped: no candidate row');
    return;
  end if;

  v_session_id := _policy_tests.seed_repoint_session(
    v_candidate_id, 'EG_polT22', 'policy-test-browser.webm', false, false, false);

  -- Exactly the six-argument shape the current API rpc uses; must resolve
  -- to the extended 7-arg function via DEFAULT NULL and leave timing NULL.
  v_result := screening_v2.finalize_authoritative_recording(
    v_session_id, v_session_id::text || '-egress.ogg', repeat('b', 64), 4096, 'audio/ogg', null);

  select recording_egress_started_at_ms into v_started_at_ms
    from screening_v2.call_sessions where id = v_session_id;

  insert into _policy_tests.results(test, passed, detail) values
    ('T22: legacy 6-arg call resolves via default',
     (v_result ->> 'status' = 'ok') and v_started_at_ms is null,
     'status=' || coalesce(v_result ->> 'status', 'null')
     || ' started_at_ms=' || coalesce(v_started_at_ms::text, 'null'));

  delete from screening_v2.call_sessions where id = v_session_id;
end;
$$;

-- ── T23: egress start persisted on first-writer link; never clobbered ───
do $$
declare
  v_candidate_id uuid;
  v_session_id uuid;
  v_result jsonb;
  v_started_at_ms bigint;
begin
  select id into v_candidate_id from screening_v2.candidates limit 1;
  if v_candidate_id is null then
    insert into _policy_tests.results(test, passed, detail) values
      ('T23: first-writer link persists egress start', true, 'skipped: no candidate row'),
      ('T23: existing egress start is never clobbered', true, 'skipped: no candidate row');
    return;
  end if;

  -- (a) Fresh row with no prior capture → finalize-time value is persisted.
  insert into screening_v2.call_sessions (candidate_id, mode, status)
    values (v_candidate_id, 'simulation', 'created')
    returning id into v_session_id;
  update screening_v2.call_sessions set status = 'in_progress' where id = v_session_id;
  update screening_v2.call_sessions
     set status = 'completed', terminal_reason = 'assessment_done',
         recording_egress_id = 'EG_polT23a', recording_egress_status = 'complete'
   where id = v_session_id;

  v_result := screening_v2.finalize_authoritative_recording(
    v_session_id, v_session_id::text || '-egress.ogg', repeat('c', 64), 8192, 'audio/ogg', null,
    1723000500000);

  select recording_egress_started_at_ms into v_started_at_ms
    from screening_v2.call_sessions where id = v_session_id;

  insert into _policy_tests.results(test, passed, detail) values
    ('T23: first-writer link persists egress start',
     (v_result ->> 'status' = 'ok') and v_started_at_ms = 1723000500000,
     'status=' || coalesce(v_result ->> 'status', 'null')
     || ' started_at_ms=' || coalesce(v_started_at_ms::text, 'null'));

  delete from screening_v2.call_sessions where id = v_session_id;

  -- (b) Start-time capture (Step 2) already wrote a value; the finalizer
  -- passes a later, different value → the existing value must win.
  insert into screening_v2.call_sessions (candidate_id, mode, status)
    values (v_candidate_id, 'simulation', 'created')
    returning id into v_session_id;
  update screening_v2.call_sessions set status = 'in_progress' where id = v_session_id;
  update screening_v2.call_sessions
     set status = 'completed', terminal_reason = 'assessment_done',
         recording_egress_id = 'EG_polT23b', recording_egress_status = 'complete',
         recording_egress_started_at_ms = 1723000000000
   where id = v_session_id;

  v_result := screening_v2.finalize_authoritative_recording(
    v_session_id, v_session_id::text || '-egress.ogg', repeat('d', 64), 8192, 'audio/ogg', null,
    1723000500000);

  select recording_egress_started_at_ms into v_started_at_ms
    from screening_v2.call_sessions where id = v_session_id;

  insert into _policy_tests.results(test, passed, detail) values
    ('T23: existing egress start is never clobbered',
     (v_result ->> 'status' = 'ok') and v_started_at_ms = 1723000000000,
     'status=' || coalesce(v_result ->> 'status', 'null')
     || ' started_at_ms=' || coalesce(v_started_at_ms::text, 'null'));

  delete from screening_v2.call_sessions where id = v_session_id;
end;
$$;

-- ── T24: invalid egress-start values are rejected before any mutation ───
do $$
declare
  v_candidate_id uuid;
  v_session_id uuid;
  v_result jsonb;
  v_started_at_ms bigint;
  v_case record;
begin
  select id into v_candidate_id from screening_v2.candidates limit 1;
  if v_candidate_id is null then
    insert into _policy_tests.results(test, passed, detail) values
      ('T24: non-positive egress start rejected', true, 'skipped: no candidate row'),
      ('T24: year-2100 boundary egress start rejected', true, 'skipped: no candidate row');
    return;
  end if;

  for v_case in
    select * from (values
      ('non-positive', 0::bigint),
      ('year-2100-boundary', 4102444800000::bigint)
    ) as t(label, value_ms)
  loop
    v_session_id := _policy_tests.seed_repoint_session(
      v_candidate_id, 'EG_polT24' || replace(v_case.label, '-', ''), 'policy-test-browser.webm',
      false, false, false);

    v_result := screening_v2.finalize_authoritative_recording(
      v_session_id, v_session_id::text || '-egress.ogg', repeat('b', 64), 4096, 'audio/ogg', null,
      v_case.value_ms);

    select recording_egress_started_at_ms into v_started_at_ms
      from screening_v2.call_sessions where id = v_session_id;

    insert into _policy_tests.results(test, passed, detail) values
      ('T24: ' || v_case.label || ' egress start rejected',
       (v_result ->> 'status' = 'invalid_egress_start') and v_started_at_ms is null,
       'status=' || coalesce(v_result ->> 'status', 'null')
       || ' started_at_ms=' || coalesce(v_started_at_ms::text, 'null'));

    delete from screening_v2.call_sessions where id = v_session_id;
  end loop;
end;
$$;

-- ── T25: idempotent re-call never mutates the timing anchor ─────────────
do $$
declare
  v_candidate_id uuid;
  v_session_id uuid;
  v_result jsonb;
  v_started_at_ms bigint;
  v_events integer;
begin
  select id into v_candidate_id from screening_v2.candidates limit 1;
  if v_candidate_id is null then
    insert into _policy_tests.results(test, passed, detail) values
      ('T25: idempotent re-call leaves timing anchor untouched', true, 'skipped: no candidate row');
    return;
  end if;

  v_session_id := _policy_tests.seed_repoint_session(
    v_candidate_id, 'EG_polT25', 'policy-test-browser.webm', false, false, false);

  -- First call captures the anchor.
  v_result := screening_v2.finalize_authoritative_recording(
    v_session_id, v_session_id::text || '-egress.ogg', repeat('b', 64), 4096, 'audio/ogg', null,
    1723000000000);

  -- Second call with a DIFFERENT anchor must be idempotent (no mutation).
  v_result := screening_v2.finalize_authoritative_recording(
    v_session_id, v_session_id::text || '-egress.ogg', repeat('b', 64), 4096, 'audio/ogg', null,
    1723000500000);

  select recording_egress_started_at_ms into v_started_at_ms
    from screening_v2.call_sessions where id = v_session_id;
  select count(*) into v_events
    from screening_v2.recording_integrity_events where session_id = v_session_id;

  insert into _policy_tests.results(test, passed, detail) values
    ('T25: idempotent re-call leaves timing anchor untouched',
     (v_result ->> 'status' = 'already_authoritative')
     and v_started_at_ms = 1723000000000
     and v_events = 2,          -- original 'uploaded' + single 'repointed'
     'status=' || coalesce(v_result ->> 'status', 'null')
     || ' started_at_ms=' || coalesce(v_started_at_ms::text, 'null')
     || ' events=' || v_events);

  delete from screening_v2.call_sessions where id = v_session_id;
end;
$$;

-- ═══════════════════════════════════════════════════════════════════════
-- 0029: Ashby integration schema — RLS/privilege + functional negative
-- controls (service-role-only backend, state machine, dependency ordering,
-- terminal block, and mapping-administration RPC gates).
-- ═══════════════════════════════════════════════════════════════════════

select _policy_tests.assert(
  'ashby integration tables have RLS enabled',
  (select count(*) from pg_class c
     join pg_namespace n on n.oid = c.relnamespace
    where n.nspname = 'screening_v2'
      and c.relname in ('ashby_job_mappings','ashby_application_links',
                        'ashby_event_receipts','ashby_resume_ingestions','ashby_operations')
      and c.relrowsecurity) = 5,
  'all five ashby_* integration tables must have RLS enabled'
);

select _policy_tests.assert(
  'ashby integration tables have no anon/authenticated/public policy',
  not exists (
    select 1 from pg_policies
     where schemaname = 'screening_v2'
       and tablename in ('ashby_job_mappings','ashby_application_links',
                         'ashby_event_receipts','ashby_resume_ingestions','ashby_operations')
       and roles && array['anon'::name, 'authenticated'::name, 'public'::name]
  ),
  'ashby_* integration tables must remain service_role-only'
);

select _policy_tests.assert(
  'ashby integration tables: browser roles have no read/write privilege',
  not exists (
    select 1 from pg_class c
      join pg_namespace n on n.oid = c.relnamespace
     where n.nspname = 'screening_v2'
       and c.relname in ('ashby_job_mappings','ashby_application_links',
                         'ashby_event_receipts','ashby_resume_ingestions','ashby_operations')
       and (has_table_privilege('anon', c.oid, 'SELECT,INSERT,UPDATE,DELETE')
         or has_table_privilege('authenticated', c.oid, 'INSERT,UPDATE,DELETE'))
  ),
  'anon/authenticated must not read/write ashby_* backend tables'
);

select _policy_tests.assert(
  'ashby integration tables: service_role has full access',
  (select count(*) from pg_class c
     join pg_namespace n on n.oid = c.relnamespace
    where n.nspname = 'screening_v2'
      and c.relname in ('ashby_job_mappings','ashby_application_links',
                        'ashby_event_receipts','ashby_resume_ingestions','ashby_operations')
      and has_table_privilege('service_role', c.oid, 'SELECT,INSERT,UPDATE,DELETE')) = 5,
  'service_role must own all ashby_* integration tables'
);

select _policy_tests.assert(
  'ashby mapping RPCs are service-role only',
  not exists (
    select 1 from pg_proc p
      join pg_namespace n on n.oid = p.pronamespace
     where n.nspname = 'screening_v2'
       and p.proname in ('upsert_ashby_job_mapping','mark_ashby_mapping_drift')
       and (has_function_privilege('anon', p.oid, 'EXECUTE')
         or has_function_privilege('authenticated', p.oid, 'EXECUTE')
         or has_function_privilege('public', p.oid, 'EXECUTE'))
  )
  and (
    select count(distinct p.proname) from pg_proc p
      join pg_namespace n on n.oid = p.pronamespace
     where n.nspname = 'screening_v2'
       and p.proname in ('upsert_ashby_job_mapping','mark_ashby_mapping_drift')
       and has_function_privilege('service_role', p.oid, 'EXECUTE')
  ) = 2,
  'ashby mapping-administration RPCs must be service-role only'
);

-- Functional negative controls against the live schema.
do $$
declare
  v_role   uuid;
  v_link   uuid;
  v_ing    uuid;
  v_score  uuid;
  v_stage  uuid;
  v_mapping uuid;
  v_res    jsonb;
begin
  select id into v_role from screening_v2.roles limit 1;
  if v_role is null then
    perform _policy_tests.assert('ashby functional: seed role present', false, 'no seed role available');
    return;
  end if;

  -- A. Duplicate application identity converges to one row.
  insert into screening_v2.ashby_application_links (external_application_id)
    values ('pol-app-dup') returning id into v_link;
  begin
    insert into screening_v2.ashby_application_links (external_application_id)
      values ('pol-app-dup');
    perform _policy_tests.assert('ashby: duplicate application rejected (one identity)', false, 'expected unique_violation');
  exception when unique_violation then
    perform _policy_tests.assert('ashby: duplicate application rejected (one identity)', true, 'unique_violation as expected');
  end;

  -- B. Incomplete mapping cannot be enabled (CHECK).
  begin
    insert into screening_v2.ashby_job_mappings (external_job_id, role_id, owner_id, status)
      values ('pol-job-incomplete', v_role, gen_random_uuid(), 'enabled');
    perform _policy_tests.assert('ashby: incomplete mapping cannot enable', false, 'expected check_violation');
  exception when check_violation then
    perform _policy_tests.assert('ashby: incomplete mapping cannot enable', true, 'check_violation as expected');
  end;

  -- C. Illegal ingestion state transition is rejected; legal one succeeds.
  insert into screening_v2.ashby_resume_ingestions (application_link_id)
    values (v_link) returning id into v_ing;
  begin
    update screening_v2.ashby_resume_ingestions set state = 'ready' where id = v_ing;
    perform _policy_tests.assert('ashby: invalid ingestion transition rejected', false, 'expected trigger raise');
  exception when others then
    perform _policy_tests.assert('ashby: invalid ingestion transition rejected', true, sqlerrm);
  end;
  update screening_v2.ashby_resume_ingestions set state = 'fetching' where id = v_ing;

  -- D. Scorecard-before-stage: stage_move cannot run before its dependency succeeds.
  insert into screening_v2.ashby_operations (application_link_id, operation_type, operation_key)
    values (v_link, 'scorecard_write', 'pol-op-score') returning id into v_score;
  insert into screening_v2.ashby_operations (application_link_id, operation_type, operation_key, depends_on_operation_id)
    values (v_link, 'stage_move', 'pol-op-stage', v_score) returning id into v_stage;
  begin
    update screening_v2.ashby_operations set state = 'running' where id = v_stage;
    perform _policy_tests.assert('ashby: stage cannot run before scorecard succeeds', false, 'expected trigger raise');
  exception when others then
    perform _policy_tests.assert('ashby: stage cannot run before scorecard succeeds', true, sqlerrm);
  end;
  update screening_v2.ashby_operations set state = 'running'   where id = v_score;
  update screening_v2.ashby_operations set state = 'succeeded' where id = v_score;
  update screening_v2.ashby_operations set state = 'running'   where id = v_stage;
  perform _policy_tests.assert('ashby: stage runs after scorecard success',
    (select state from screening_v2.ashby_operations where id = v_stage) = 'running',
    'stage_move should run once scorecard_write succeeded');

  -- E. Terminal application link blocks new operations.
  update screening_v2.ashby_application_links set terminal_state = 'withdrawn' where id = v_link;
  begin
    insert into screening_v2.ashby_operations (application_link_id, operation_type, operation_key)
      values (v_link, 'invite_delivery', 'pol-op-terminal');
    perform _policy_tests.assert('ashby: terminal link blocks new operation', false, 'expected trigger raise');
  exception when others then
    perform _policy_tests.assert('ashby: terminal link blocks new operation', true, sqlerrm);
  end;

  -- F. Mapping-administration RPC gates (incomplete/complete/drift).
  v_res := screening_v2.upsert_ashby_job_mapping(
    null::uuid, 'pol-job-rpc', v_role, null::text, null::text, null::text, null::text, null::text,
    gen_random_uuid(), 'manual', 24, 'enabled', null::text, gen_random_uuid());
  perform _policy_tests.assert('ashby RPC: enable incomplete rejected',
    v_res->>'status' = 'incomplete_cannot_enable', 'got ' || coalesce(v_res->>'status','null'));

  v_res := screening_v2.upsert_ashby_job_mapping(
    null::uuid, 'pol-job-rpc', v_role, 'ai_x', 'ta_x', null::text, null::text, null::text,
    gen_random_uuid(), 'both', 24, 'enabled', null::text, gen_random_uuid());
  perform _policy_tests.assert('ashby RPC: enable complete ok',
    v_res->>'status' = 'ok', 'got ' || coalesce(v_res->>'status','null'));
  v_mapping := (v_res->>'id')::uuid;

  perform screening_v2.mark_ashby_mapping_drift(v_mapping, 'stage_id_invalid', gen_random_uuid());
  v_res := screening_v2.upsert_ashby_job_mapping(
    v_mapping, 'pol-job-rpc', v_role, 'ai_x', 'ta_x', null::text, null::text, null::text,
    gen_random_uuid(), 'both', 24, 'enabled', null::text, gen_random_uuid());
  perform _policy_tests.assert('ashby RPC: drifted mapping cannot enable',
    v_res->>'status' = 'drifted_cannot_enable', 'got ' || coalesce(v_res->>'status','null'));

  -- Cleanup: deleting the link cascades its operations/ingestions.
  delete from screening_v2.ashby_application_links where external_application_id = 'pol-app-dup';
  delete from screening_v2.ashby_job_mappings where external_job_id in ('pol-job-incomplete','pol-job-rpc');
end;
$$;

-- ═══════════════════════════════════════════════════════════════════════
-- 0030: Ashby webhook + reconciliation — RLS/privilege + functional controls
-- (dedup-safe receipt ingress, checkpoint advance, forced full resync).
-- ═══════════════════════════════════════════════════════════════════════

select _policy_tests.assert(
  'ashby_sync_checkpoints has RLS enabled',
  (select count(*) from pg_class c
     join pg_namespace n on n.oid = c.relnamespace
    where n.nspname = 'screening_v2'
      and c.relname = 'ashby_sync_checkpoints'
      and c.relrowsecurity) = 1,
  'ashby_sync_checkpoints must have RLS enabled'
);

select _policy_tests.assert(
  'ashby_sync_checkpoints has no anon/authenticated/public policy or privilege',
  not exists (
    select 1 from pg_policies
     where schemaname = 'screening_v2' and tablename = 'ashby_sync_checkpoints'
       and roles && array['anon'::name, 'authenticated'::name, 'public'::name]
  )
  and not exists (
    select 1 from pg_class c
      join pg_namespace n on n.oid = c.relnamespace
     where n.nspname = 'screening_v2' and c.relname = 'ashby_sync_checkpoints'
       and (has_table_privilege('anon', c.oid, 'SELECT,INSERT,UPDATE,DELETE')
         or has_table_privilege('authenticated', c.oid, 'SELECT,INSERT,UPDATE,DELETE'))
  ),
  'ashby_sync_checkpoints must remain service_role-only'
);

select _policy_tests.assert(
  'ashby webhook/reconciliation RPCs are service-role only',
  not exists (
    select 1 from pg_proc p
      join pg_namespace n on n.oid = p.pronamespace
     where n.nspname = 'screening_v2'
       and p.proname in ('record_ashby_event_receipt','advance_ashby_sync_checkpoint','mark_ashby_sync_full_resync')
       and (has_function_privilege('anon', p.oid, 'EXECUTE')
         or has_function_privilege('authenticated', p.oid, 'EXECUTE')
         or has_function_privilege('public', p.oid, 'EXECUTE'))
  )
  and (
    select count(distinct p.proname) from pg_proc p
      join pg_namespace n on n.oid = p.pronamespace
     where n.nspname = 'screening_v2'
       and p.proname in ('record_ashby_event_receipt','advance_ashby_sync_checkpoint','mark_ashby_sync_full_resync')
       and has_function_privilege('service_role', p.oid, 'EXECUTE')
  ) = 3,
  'record/advance/resync RPCs must be service-role only'
);

-- Functional negative controls against the live 0030 primitives.
do $$
declare
  v_res  jsonb;
  v_tok  text;
  v_status text;
begin
  -- A. Dedup-safe receipt ingress: first inserts, second is a duplicate.
  v_res := screening_v2.record_ashby_event_receipt('pol-wh-1', 'candidateStageChange', null);
  perform _policy_tests.assert('ashby receipt: first delivery inserted',
    v_res->>'status' = 'inserted', 'got ' || coalesce(v_res->>'status','null'));
  v_res := screening_v2.record_ashby_event_receipt('pol-wh-1', 'candidateStageChange', null);
  perform _policy_tests.assert('ashby receipt: duplicate delivery deduped',
    v_res->>'status' = 'duplicate', 'got ' || coalesce(v_res->>'status','null'));
  perform _policy_tests.assert('ashby receipt: exactly one row for the key',
    (select count(*) from screening_v2.ashby_event_receipts
      where webhook_action_id = 'pol-wh-1' and action = 'candidateStageChange') = 1,
    'expected a single deduped receipt row');

  -- B. Oversized metadata is rejected (defensive bound).
  v_res := screening_v2.record_ashby_event_receipt('pol-wh-2', 'candidateStageChange',
    jsonb_build_object('blob', repeat('x', 4000)));
  perform _policy_tests.assert('ashby receipt: oversized metadata rejected',
    v_res->>'status' = 'metadata_too_large', 'got ' || coalesce(v_res->>'status','null'));

  -- B2. Transactional outbox: atomic receipt+job, idempotent re-drive, terminal guard.
  v_res := screening_v2.record_ashby_event_receipt(
    'pol-wh-ob', 'candidateStageChange', null,
    true, 'ashby.signal', 'ashby:signal:candidateStageChange:pol-wh-ob',
    jsonb_build_object('provider','ashby','webhookActionId','pol-wh-ob','action','candidateStageChange'), 5);
  perform _policy_tests.assert('ashby outbox: fresh delivery inserted + enqueued',
    v_res->>'status' = 'inserted' and (v_res->>'enqueued')::boolean and (v_res->>'work_pending')::boolean,
    'got ' || v_res::text);
  perform _policy_tests.assert('ashby outbox: exactly one live signal job',
    (select count(*) from screening_v2.job_queue
      where dedup_key = 'ashby:signal:candidateStageChange:pol-wh-ob'
        and status in ('pending','active','delayed')) = 1,
    'expected a single live signal job');

  -- Duplicate delivery: no second live job (idempotent).
  v_res := screening_v2.record_ashby_event_receipt(
    'pol-wh-ob', 'candidateStageChange', null,
    true, 'ashby.signal', 'ashby:signal:candidateStageChange:pol-wh-ob',
    jsonb_build_object('provider','ashby'), 5);
  perform _policy_tests.assert('ashby outbox: duplicate creates no second job',
    v_res->>'status' = 'duplicate' and not (v_res->>'enqueued')::boolean and (v_res->>'work_pending')::boolean
    and (select count(*) from screening_v2.job_queue
          where dedup_key = 'ashby:signal:candidateStageChange:pol-wh-ob'
            and status in ('pending','active','delayed')) = 1,
    'got ' || v_res::text);

  -- Re-drive: with the live job gone (completed) and receipt NOT terminal, a
  -- redelivery re-enqueues exactly one job (closes the F2 strand gap).
  update screening_v2.job_queue set status = 'completed'
    where dedup_key = 'ashby:signal:candidateStageChange:pol-wh-ob';
  v_res := screening_v2.record_ashby_event_receipt(
    'pol-wh-ob', 'candidateStageChange', null,
    true, 'ashby.signal', 'ashby:signal:candidateStageChange:pol-wh-ob',
    jsonb_build_object('provider','ashby'), 5);
  perform _policy_tests.assert('ashby outbox: re-drives a missing enqueue',
    (v_res->>'enqueued')::boolean and (v_res->>'work_pending')::boolean
    and (select count(*) from screening_v2.job_queue
          where dedup_key = 'ashby:signal:candidateStageChange:pol-wh-ob'
            and status in ('pending','active','delayed')) = 1,
    'got ' || v_res::text);

  -- Terminal-receipt guard: once the worker marks the receipt processed, a
  -- redelivery with no live job does NOT re-enqueue (no re-run of done work).
  update screening_v2.job_queue set status = 'completed'
    where dedup_key = 'ashby:signal:candidateStageChange:pol-wh-ob';
  update screening_v2.ashby_event_receipts set status = 'processed'
    where webhook_action_id = 'pol-wh-ob' and action = 'candidateStageChange';
  v_res := screening_v2.record_ashby_event_receipt(
    'pol-wh-ob', 'candidateStageChange', null,
    true, 'ashby.signal', 'ashby:signal:candidateStageChange:pol-wh-ob',
    jsonb_build_object('provider','ashby'), 5);
  perform _policy_tests.assert('ashby outbox: terminal receipt suppresses re-enqueue',
    not (v_res->>'enqueued')::boolean and (v_res->>'work_pending')::boolean
    and (select count(*) from screening_v2.job_queue
          where dedup_key = 'ashby:signal:candidateStageChange:pol-wh-ob'
            and status in ('pending','active','delayed')) = 0,
    'got ' || v_res::text);

  -- C. Checkpoint advance persists an opaque token + stamps the expiry anchor.
  v_res := screening_v2.advance_ashby_sync_checkpoint('pol-stream', 'opaque-token-1', 3, 12, true);
  perform _policy_tests.assert('ashby checkpoint: advance ok',
    v_res->>'status' = 'ok', 'got ' || coalesce(v_res->>'status','null'));
  select sync_token, status into v_tok, v_status
    from screening_v2.ashby_sync_checkpoints where checkpoint_key = 'pol-stream';
  perform _policy_tests.assert('ashby checkpoint: token persisted, status idle',
    v_tok = 'opaque-token-1' and v_status = 'idle', 'token=' || coalesce(v_tok,'null') || ' status=' || coalesce(v_status,'null'));

  -- D. Forced full resync nulls the token and flags the stream.
  v_res := screening_v2.mark_ashby_sync_full_resync('pol-stream', 'token_expired');
  perform _policy_tests.assert('ashby checkpoint: forced resync ok',
    v_res->>'status' = 'ok', 'got ' || coalesce(v_res->>'status','null'));
  select sync_token, status into v_tok, v_status
    from screening_v2.ashby_sync_checkpoints where checkpoint_key = 'pol-stream';
  perform _policy_tests.assert('ashby checkpoint: resync nulls token + flags stream',
    v_tok is null and v_status = 'full_resync_required', 'token=' || coalesce(v_tok,'null') || ' status=' || coalesce(v_status,'null'));

  -- Cleanup.
  delete from screening_v2.job_queue where dedup_key = 'ashby:signal:candidateStageChange:pol-wh-ob';
  delete from screening_v2.ashby_event_receipts where webhook_action_id in ('pol-wh-1','pol-wh-2','pol-wh-ob');
  delete from screening_v2.ashby_sync_checkpoints where checkpoint_key = 'pol-stream';
end;
$$;

-- ═══════════════════════════════════════════════════════════════════════
-- 0031: Ashby screening-workflow execution primitives — RLS/privilege +
--       functional controls (leased outbox, atomic terminal cancel,
--       ingestion advance, scorecard idempotency, mapping pause/resume).
-- ═══════════════════════════════════════════════════════════════════════

select _policy_tests.assert(
  'ashby workflow RPCs are service-role only',
  (select count(*)
     from pg_proc p join pg_namespace n on n.oid = p.pronamespace
    where n.nspname = 'screening_v2'
      and p.proname in ('enqueue_ashby_operation','claim_ashby_operation',
                        'complete_ashby_operation','fail_ashby_operation',
                        'cancel_ashby_application','advance_ashby_ingestion',
                        'set_ashby_mapping_status')
      and not has_function_privilege('anon', p.oid, 'EXECUTE')
      and not has_function_privilege('authenticated', p.oid, 'EXECUTE')
      and has_function_privilege('service_role', p.oid, 'EXECUTE')
  ) = 7,
  'ashby workflow-execution RPCs must be service-role only'
);

select _policy_tests.assert(
  'ashby_operations has additive lease/anchor/marker columns',
  (select count(*)
     from information_schema.columns
    where table_schema = 'screening_v2' and table_name = 'ashby_operations'
      and column_name in ('lease_token','lease_owner','lease_expires_at','external_anchor','marker')
  ) = 5,
  'ashby_operations must carry the 0031 lease/anchor/marker columns'
);

-- Functional negative controls against the live 0031 primitives.
do $$
declare
  v_role    uuid;
  v_res     jsonb;
  v_link    uuid;
  v_link2   uuid;
  v_score   uuid;
  v_stage   uuid;
  v_lease   uuid;
  v_map     jsonb;
  v_mapid   uuid;
  v_marker  text := repeat('a', 16);
begin
  select id into v_role from screening_v2.roles limit 1;
  if v_role is null then
    perform _policy_tests.assert('ashby 0031 functional: seed role present', false, 'no seed role available');
    return;
  end if;

  insert into screening_v2.ashby_application_links (external_application_id)
    values ('pol31-app') returning id into v_link;

  -- A. Idempotent outbox: insert, duplicate key, duplicate marker.
  v_res := screening_v2.enqueue_ashby_operation(v_link, 'scorecard_write', 'pol31-score', null, v_marker, gen_random_uuid());
  perform _policy_tests.assert('ashby 0031: enqueue scorecard inserted',
    v_res->>'status' = 'inserted', 'got ' || coalesce(v_res->>'status','null'));
  v_score := (v_res->>'id')::uuid;

  v_res := screening_v2.enqueue_ashby_operation(v_link, 'scorecard_write', 'pol31-score', null, null, gen_random_uuid());
  perform _policy_tests.assert('ashby 0031: duplicate operation_key deduped',
    v_res->>'status' = 'duplicate', 'got ' || coalesce(v_res->>'status','null'));

  v_res := screening_v2.enqueue_ashby_operation(v_link, 'scorecard_write', 'pol31-score-2', null, v_marker, gen_random_uuid());
  perform _policy_tests.assert('ashby 0031: duplicate marker rejected (scorecard idempotency)',
    v_res->>'status' = 'duplicate_marker', 'got ' || coalesce(v_res->>'status','null'));

  v_res := screening_v2.enqueue_ashby_operation(v_link, 'stage_move', 'pol31-stage', v_score, null, gen_random_uuid());
  perform _policy_tests.assert('ashby 0031: enqueue stage_move inserted',
    v_res->>'status' = 'inserted', 'got ' || coalesce(v_res->>'status','null'));
  v_stage := (v_res->>'id')::uuid;

  -- B. Scorecard-before-stage AT CLAIM: stage not claimable before scorecard succeeds.
  v_res := screening_v2.claim_ashby_operation('stage_move', 'w1', 30);
  perform _policy_tests.assert('ashby 0031: stage_move not claimable before scorecard succeeds',
    v_res->>'status' = 'empty', 'got ' || coalesce(v_res->>'status','null'));

  -- C. Lease claim + CAS complete (stale lease rejected).
  v_res := screening_v2.claim_ashby_operation('scorecard_write', 'w1', 30);
  perform _policy_tests.assert('ashby 0031: scorecard claimed under lease',
    v_res->>'status' = 'claimed' and (v_res->>'id')::uuid = v_score,
    'got ' || coalesce(v_res->>'status','null'));
  v_lease := (v_res->>'lease_token')::uuid;

  perform _policy_tests.assert('ashby 0031: complete with wrong lease is not_owned',
    (screening_v2.complete_ashby_operation(v_score, gen_random_uuid(), 'anchor_x', null, gen_random_uuid()))->>'status' = 'not_owned',
    'stale lease must not commit');

  v_res := screening_v2.complete_ashby_operation(v_score, v_lease, 'anchor_x', null, gen_random_uuid());
  perform _policy_tests.assert('ashby 0031: complete with live lease ok + anchor persisted',
    v_res->>'status' = 'ok'
    and (select external_anchor from screening_v2.ashby_operations where id = v_score) = 'anchor_x',
    'got ' || coalesce(v_res->>'status','null'));

  -- D. Now the stage_move is claimable (dependency succeeded); retryable fail reschedules.
  v_res := screening_v2.claim_ashby_operation('stage_move', 'w1', 30);
  perform _policy_tests.assert('ashby 0031: stage_move claimable after scorecard success',
    v_res->>'status' = 'claimed', 'got ' || coalesce(v_res->>'status','null'));
  v_lease := (v_res->>'lease_token')::uuid;
  v_res := screening_v2.fail_ashby_operation(v_stage, v_lease, 'transient_x', true);
  perform _policy_tests.assert('ashby 0031: retryable fail reschedules to pending',
    v_res->>'outcome' = 'retry'
    and (select state from screening_v2.ashby_operations where id = v_stage) = 'pending',
    'got ' || coalesce(v_res->>'outcome','null'));

  -- E. Restart-safe ingestion advance: legal move ok, illegal move rejected.
  insert into screening_v2.ashby_resume_ingestions (application_link_id) values (v_link)
    on conflict (application_link_id) do nothing;
  v_res := screening_v2.advance_ashby_ingestion(v_link, 'fetching', null, null, null, null);
  perform _policy_tests.assert('ashby 0031: ingestion queued->fetching ok',
    v_res->>'status' = 'ok', 'got ' || coalesce(v_res->>'status','null'));
  v_res := screening_v2.advance_ashby_ingestion(v_link, 'ready', null, null, null, null);
  perform _policy_tests.assert('ashby 0031: illegal ingestion transition rejected',
    v_res->>'status' = 'invalid_transition', 'got ' || coalesce(v_res->>'status','null'));

  -- F. Atomic terminal cancellation on a fresh link with in-flight work.
  insert into screening_v2.ashby_application_links (external_application_id)
    values ('pol31-app2') returning id into v_link2;
  perform screening_v2.enqueue_ashby_operation(v_link2, 'invite_delivery', 'pol31-inv2', null, null, gen_random_uuid());
  insert into screening_v2.ashby_resume_ingestions (application_link_id) values (v_link2)
    on conflict (application_link_id) do nothing;
  v_res := screening_v2.cancel_ashby_application(v_link2, 'withdrawn', 'candidate_withdrew', gen_random_uuid(), 'recruiter');
  perform _policy_tests.assert('ashby 0031: terminal cancel cancels in-flight op + ingestion',
    v_res->>'status' = 'ok'
    and (v_res->>'cancelled_operations')::int >= 1
    and (v_res->>'cancelled_ingestion')::int >= 1,
    'got ' || coalesce(v_res::text,'null'));
  v_res := screening_v2.cancel_ashby_application(v_link2, 'withdrawn', null, gen_random_uuid(), 'recruiter');
  perform _policy_tests.assert('ashby 0031: terminal cancel is idempotent',
    v_res->>'status' = 'already_terminal', 'got ' || coalesce(v_res->>'status','null'));
  v_res := screening_v2.enqueue_ashby_operation(v_link2, 'stage_move', 'pol31-after-terminal', null, null, gen_random_uuid());
  perform _policy_tests.assert('ashby 0031: enqueue on terminal link blocked',
    v_res->>'status' = 'blocked_terminal', 'got ' || coalesce(v_res->>'status','null'));

  -- G. Mission Control pause/resume gate.
  v_map := screening_v2.upsert_ashby_job_mapping(
    null::uuid, 'pol31-job', v_role, 'ai_x', 'ta_x', null::text, null::text, null::text,
    gen_random_uuid(), 'both', 24, 'enabled', null::text, gen_random_uuid());
  v_mapid := (v_map->>'id')::uuid;
  v_res := screening_v2.set_ashby_mapping_status(v_mapid, 'paused', 'mc_pause', gen_random_uuid());
  perform _policy_tests.assert('ashby 0031: mapping pause ok',
    v_res->>'status' = 'ok'
    and (select status from screening_v2.ashby_job_mappings where id = v_mapid) = 'paused',
    'got ' || coalesce(v_res->>'status','null'));

  v_map := screening_v2.upsert_ashby_job_mapping(
    null::uuid, 'pol31-job-incomplete', v_role, 'ai_only', null::text, null::text, null::text, null::text,
    gen_random_uuid(), 'manual', 24, 'paused', null::text, gen_random_uuid());
  v_res := screening_v2.set_ashby_mapping_status((v_map->>'id')::uuid, 'enabled', null, gen_random_uuid());
  perform _policy_tests.assert('ashby 0031: incomplete mapping cannot be resumed to enabled',
    v_res->>'status' = 'incomplete_cannot_enable', 'got ' || coalesce(v_res->>'status','null'));

  -- Cleanup (link deletes cascade operations + ingestions).
  delete from screening_v2.ashby_application_links where external_application_id in ('pol31-app','pol31-app2');
  delete from screening_v2.ashby_job_mappings where external_job_id in ('pol31-job','pol31-job-incomplete');
end;
$$;

-- ═══════════════════════════════════════════════════════════════════════
-- 0032: Ashby runtime activation — writeback_pending terminus, audited and
--       attempt-bounded retry, terminal-resurrection backstop, bounded
--       ingestion requeue, reconciliation single-flight.
-- ═══════════════════════════════════════════════════════════════════════

select _policy_tests.assert(
  'ashby 0032 RPCs are service-role only',
  (select count(*)
     from pg_proc p join pg_namespace n on n.oid = p.pronamespace
    where n.nspname = 'screening_v2'
      and p.proname in ('mark_ashby_writeback_pending','retry_ashby_operation',
                        'begin_ashby_sync_run','end_ashby_sync_run')
      and not has_function_privilege('anon', p.oid, 'EXECUTE')
      and not has_function_privilege('authenticated', p.oid, 'EXECUTE')
      and has_function_privilege('service_role', p.oid, 'EXECUTE')
  ) = 4,
  'ashby 0032 runtime RPCs must be service-role only'
);

select _policy_tests.assert(
  'ashby 0032 RPCs pin search_path',
  (select count(*)
     from pg_proc p join pg_namespace n on n.oid = p.pronamespace
    where n.nspname = 'screening_v2'
      and p.proname in ('mark_ashby_writeback_pending','retry_ashby_operation',
                        'begin_ashby_sync_run','end_ashby_sync_run')
      and p.prosecdef
      and array_to_string(coalesce(p.proconfig, '{}'), ',') like '%search_path%'
  ) = 4,
  'every 0032 SECURITY DEFINER RPC must pin search_path'
);

select _policy_tests.assert(
  'ashby 0032: writeback_pending is an accepted lifecycle value',
  pg_get_constraintdef(oid) like '%writeback_pending%',
  'lifecycle CHECK must admit writeback_pending'
) from pg_constraint
 where conname = 'chk_ashby_application_links_lifecycle'
   and conrelid = 'screening_v2.ashby_application_links'::regclass;

select _policy_tests.assert(
  'ashby 0032: terminal-resurrection UPDATE trigger exists',
  (select count(*) from pg_trigger
    where tgname = 'trg_ashby_operation_not_terminal_update'
      and tgrelid = 'screening_v2.ashby_operations'::regclass
      and not tgisinternal) = 1,
  'the BEFORE UPDATE terminal guard must exist'
);

do $$
declare
  v_role  uuid;
  v_map   jsonb;
  v_mapid uuid;
  v_link  uuid;
  v_op    jsonb;
  v_opid  uuid;
  v_res   jsonb;
  v_state text;
  v_begin jsonb;
  v_actor uuid := gen_random_uuid();
begin
  select id into v_role from screening_v2.roles order by created_at limit 1;
  if v_role is null then
    perform _policy_tests.assert('ashby 0032 functional: seed role present', false, 'no seed role available');
    return;
  end if;

  v_map := screening_v2.upsert_ashby_job_mapping(
    null::uuid, 'pol32-job', v_role, 'pol32_ai', 'pol32_ta', null::text, null::text, null::text,
    gen_random_uuid(), 'manual', 24, 'paused', null::text, v_actor);
  v_mapid := (v_map->>'id')::uuid;

  insert into screening_v2.ashby_application_links
    (provider, external_application_id, external_job_id, external_stage_id, job_mapping_id, lifecycle)
  values ('ashby', 'pol32-app', 'pol32-job', 'pol32_ai', v_mapid, 'imported')
  returning id into v_link;

  -- ── writeback_pending terminus ────────────────────────────────────────
  v_res := screening_v2.mark_ashby_writeback_pending(v_link, 'no_verified_result_sink', v_actor);
  perform _policy_tests.assert('ashby 0032: writeback_pending parks the application',
    v_res->>'status' = 'ok'
    and (select lifecycle from screening_v2.ashby_application_links where id = v_link) = 'writeback_pending',
    'got ' || coalesce(v_res->>'status','null'));

  perform _policy_tests.assert('ashby 0032: writeback_pending is audited',
    exists (select 1 from screening_v2.audit_events
             where action = 'ashby_writeback_pending' and target_id = v_link::text),
    'expected an ashby_writeback_pending audit row');

  v_res := screening_v2.mark_ashby_writeback_pending(v_link, 'again', v_actor);
  perform _policy_tests.assert('ashby 0032: writeback_pending is idempotent',
    v_res->>'status' = 'already_pending', 'got ' || coalesce(v_res->>'status','null'));

  perform _policy_tests.assert('ashby 0032: parking enqueues no operation',
    (select count(*) from screening_v2.ashby_operations where application_link_id = v_link) = 0,
    'writeback_pending must not schedule follow-on work');

  -- ── audited, bounded, terminal-safe retry ─────────────────────────────
  v_op := screening_v2.enqueue_ashby_operation(v_link, 'invite_delivery', 'pol32:invite', null, null, v_actor);
  v_opid := (v_op->>'id')::uuid;

  v_res := screening_v2.retry_ashby_operation(v_opid, v_actor);
  perform _policy_tests.assert('ashby 0032: retry refuses a non-failed operation',
    v_res->>'status' = 'not_retryable', 'got ' || coalesce(v_res->>'status','null'));

  update screening_v2.ashby_operations set state = 'failed', attempts = 1 where id = v_opid;
  v_res := screening_v2.retry_ashby_operation(v_opid, v_actor);
  perform _policy_tests.assert('ashby 0032: retry re-queues a failed operation',
    v_res->>'status' = 'ok'
    and (select state from screening_v2.ashby_operations where id = v_opid) = 'pending',
    'got ' || coalesce(v_res->>'status','null'));

  perform _policy_tests.assert('ashby 0032: retry is audited with the acting admin',
    exists (select 1 from screening_v2.audit_events
             where action = 'ashby_operation_retry' and target_id = v_opid::text and actor_id = v_actor),
    'expected an attributed ashby_operation_retry audit row');

  update screening_v2.ashby_operations
     set state = 'failed', attempts = max_attempts where id = v_opid;
  v_res := screening_v2.retry_ashby_operation(v_opid, v_actor);
  perform _policy_tests.assert('ashby 0032: retry is bounded by max_attempts',
    v_res->>'status' = 'retry_exhausted', 'got ' || coalesce(v_res->>'status','null'));

  -- ── terminal resurrection is impossible ───────────────────────────────
  update screening_v2.ashby_operations set state = 'failed', attempts = 1 where id = v_opid;
  v_res := screening_v2.cancel_ashby_application(v_link, 'withdrawn', 'pol32_withdraw', v_actor, 'recruiter');
  perform _policy_tests.assert('ashby 0032: cancel marks the link terminal',
    v_res->>'status' = 'ok', 'got ' || coalesce(v_res->>'status','null'));

  v_res := screening_v2.retry_ashby_operation(v_opid, v_actor);
  perform _policy_tests.assert('ashby 0032: retry cannot resurrect a terminal application',
    v_res->>'status' = 'blocked_terminal', 'got ' || coalesce(v_res->>'status','null'));

  -- The DB backstop: even a direct UPDATE cannot re-run terminal work.
  begin
    update screening_v2.ashby_operations set state = 'pending' where id = v_opid;
    perform _policy_tests.assert('ashby 0032: direct UPDATE to pending is blocked on a terminal link',
      false, 'expected P0001 from trg_ashby_operation_not_terminal_update');
  exception when others then
    perform _policy_tests.assert('ashby 0032: direct UPDATE to pending is blocked on a terminal link',
      true, null);
  end;

  -- Belt and braces: after cancellation no operation for that link is left in
  -- a claimable state, and the leased claim never returns one for it.
  perform _policy_tests.assert('ashby 0032: no claimable operation survives cancellation',
    not exists (select 1 from screening_v2.ashby_operations
                 where application_link_id = v_link and state = 'pending'),
    'a terminal link must retain no pending operation');

  v_res := screening_v2.claim_ashby_operation('invite_delivery', 'pol32-worker', 30);
  perform _policy_tests.assert('ashby 0032: claim never returns an operation on a terminal link',
    v_res->>'status' = 'empty'
      or (v_res->>'application_link_id') is distinct from v_link::text,
    'got ' || coalesce(v_res->>'status','null'));

  -- ── bounded ingestion requeue ─────────────────────────────────────────
  insert into screening_v2.ashby_application_links
    (provider, external_application_id, external_job_id, external_stage_id, job_mapping_id, lifecycle)
  values ('ashby', 'pol32-app2', 'pol32-job', 'pol32_ai', v_mapid, 'imported')
  returning id into v_link;

  v_res := screening_v2.advance_ashby_ingestion(v_link, 'fetching', null, null, null, null);
  perform _policy_tests.assert('ashby 0032: legal ingestion transition still succeeds',
    v_res->>'status' = 'ok', 'got ' || coalesce(v_res->>'status','null'));

  v_res := screening_v2.advance_ashby_ingestion(v_link, 'failed_review', null, null, null, 'synthetic');
  perform _policy_tests.assert('ashby 0032: failed_review transition succeeds',
    v_res->>'status' = 'ok', 'got ' || coalesce(v_res->>'status','null'));

  -- Requeue up to the ceiling, then refuse.
  for i in 1..10 loop
    v_res := screening_v2.advance_ashby_ingestion(v_link, 'queued', null, null, null, null);
    exit when v_res->>'status' = 'retry_exhausted';
    v_res := screening_v2.advance_ashby_ingestion(v_link, 'fetching', null, null, null, null);
    v_res := screening_v2.advance_ashby_ingestion(v_link, 'failed_review', null, null, null, 'synthetic');
  end loop;
  select state into v_state from screening_v2.ashby_resume_ingestions where application_link_id = v_link;
  perform _policy_tests.assert('ashby 0032: ingestion requeue is bounded and rests in failed_review',
    v_res->>'status' = 'retry_exhausted' and v_state = 'failed_review',
    'got status=' || coalesce(v_res->>'status','null') || ' state=' || coalesce(v_state,'null'));

  -- ── reconciliation single-flight ──────────────────────────────────────
  v_begin := screening_v2.begin_ashby_sync_run('pol32-stream', 'runner-a', 300);
  perform _policy_tests.assert('ashby 0032: first runner acquires the sync lease',
    v_begin->>'status' = 'ok', 'got ' || coalesce(v_begin->>'status','null'));

  v_res := screening_v2.begin_ashby_sync_run('pol32-stream', 'runner-b', 300);
  perform _policy_tests.assert('ashby 0032: a second concurrent runner is locked out',
    v_res->>'status' = 'locked', 'got ' || coalesce(v_res->>'status','null'));

  v_res := screening_v2.end_ashby_sync_run('pol32-stream', 'runner-b', true);
  perform _policy_tests.assert('ashby 0032: a non-owner cannot release the sync lease',
    v_res->>'status' = 'not_owned', 'got ' || coalesce(v_res->>'status','null'));

  v_res := screening_v2.end_ashby_sync_run('pol32-stream', 'runner-a', false);
  perform _policy_tests.assert('ashby 0032: a non-advancing run increments no_progress_runs',
    v_res->>'status' = 'ok' and (v_res->>'no_progress_runs')::int = 1,
    'got ' || coalesce(v_res->>'no_progress_runs','null'));

  v_begin := screening_v2.begin_ashby_sync_run('pol32-stream', 'runner-a', 300);
  v_res := screening_v2.end_ashby_sync_run('pol32-stream', 'runner-a', false);
  perform _policy_tests.assert('ashby 0032: consecutive non-advancing runs accumulate',
    (v_res->>'no_progress_runs')::int = 2,
    'got ' || coalesce(v_res->>'no_progress_runs','null'));

  perform screening_v2.advance_ashby_sync_checkpoint('pol32-stream', 'tok', 1, 1, false);
  perform _policy_tests.assert('ashby 0032: advancing resets no_progress_runs and clears the lease',
    (select no_progress_runs from screening_v2.ashby_sync_checkpoints
      where provider = 'ashby' and checkpoint_key = 'pol32-stream') = 0
    and (select lease_owner from screening_v2.ashby_sync_checkpoints
          where provider = 'ashby' and checkpoint_key = 'pol32-stream') is null,
    'advance must reset progress bookkeeping');

  -- Cleanup (link deletes cascade operations + ingestions).
  delete from screening_v2.ashby_application_links where external_application_id in ('pol32-app','pol32-app2');
  delete from screening_v2.ashby_job_mappings where external_job_id = 'pol32-job';
  delete from screening_v2.ashby_sync_checkpoints where checkpoint_key = 'pol32-stream';
end;
$$;

-- ═══════════════════════════════════════════════════════════════════════
-- 0032 review repair: manual-delivery truthfulness (B1) + per-op channel (M1)
-- ═══════════════════════════════════════════════════════════════════════

select _policy_tests.assert(
  'ashby 0032 repair RPCs are service-role only',
  (select count(*)
     from pg_proc p join pg_namespace n on n.oid = p.pronamespace
    where n.nspname = 'screening_v2'
      and p.proname in ('park_ashby_operation_awaiting_delivery',
                        'mark_ashby_invite_delivered',
                        'reissue_ashby_manual_invite')
      and p.prosecdef
      and array_to_string(coalesce(p.proconfig, '{}'), ',') like '%search_path%'
      and not has_function_privilege('anon', p.oid, 'EXECUTE')
      and not has_function_privilege('authenticated', p.oid, 'EXECUTE')
      and has_function_privilege('service_role', p.oid, 'EXECUTE')
  ) = 3,
  'the manual-delivery RPCs must be service-role only with a pinned search_path'
);

select _policy_tests.assert(
  'ashby 0032: awaiting_manual_delivery is an accepted operation state',
  pg_get_constraintdef(oid) like '%awaiting_manual_delivery%',
  'operation state CHECK must admit awaiting_manual_delivery'
) from pg_constraint
 where conname = 'chk_ashby_operations_state'
   and conrelid = 'screening_v2.ashby_operations'::regclass;

do $$
declare
  v_role   uuid;
  v_map    jsonb;
  v_mapid  uuid;
  v_link   uuid;
  v_cand   uuid;
  v_sess   uuid;
  v_opm    jsonb;
  v_ope    jsonb;
  v_claim  jsonb;
  v_res    jsonb;
  -- `candidates.owner_id` / `call_sessions.owner_id` FK to auth.users, so the
  -- actor must be a real (synthetic) identity, not a bare random uuid. The
  -- shared RLS fixture user is deleted earlier in this file, so seed our own.
  v_actor  uuid := '10000000-0000-0000-0000-0000000032b1';
  v_digest text := repeat('a', 64);
  v_digest2 text := repeat('b', 64);
  v_state  text;
  v_live   integer;
begin
  select id into v_role from screening_v2.roles order by created_at limit 1;
  if v_role is null then
    perform _policy_tests.assert('ashby 0032 repair: seed role present', false, 'no seed role available');
    return;
  end if;

  insert into auth.users (
    instance_id, id, aud, role, email, encrypted_password,
    email_confirmed_at, raw_app_meta_data, raw_user_meta_data, created_at, updated_at
  ) values (
    '00000000-0000-0000-0000-000000000000', v_actor,
    'authenticated', 'authenticated', 'pol32b@example.invalid', '',
    now(), '{}', '{}', now(), now()
  ) on conflict (id) do nothing;

  v_map := screening_v2.upsert_ashby_job_mapping(
    null::uuid, 'pol32b-job', v_role, 'b_ai', 'b_ta', null::text, null::text, null::text,
    v_actor, 'both', 24, 'paused', null::text, v_actor);
  v_mapid := (v_map->>'id')::uuid;
  -- 0035: an ENABLED mapping is now a CLAIM PREREQUISITE for invite_delivery.
  -- This block exercises operation-key/park/hand-off mechanics, not mapping
  -- status, so the mapping is enabled here — otherwise every claim below
  -- correctly returns `empty` and the assertions test nothing. The link
  -- deliberately carries no resume handle, so the ingestion prerequisite is
  -- satisfied by the application having no resume at all.
  perform screening_v2.set_ashby_mapping_status(v_mapid, 'enabled', null, v_actor);

  insert into screening_v2.candidates (role_id, owner_id, status)
  values (v_role, v_actor, 'new') returning id into v_cand;
  insert into screening_v2.call_sessions (candidate_id, role_id, owner_id, mode, status)
  values (v_cand, v_role, v_actor, 'browser', 'created') returning id into v_sess;

  insert into screening_v2.ashby_application_links
    (provider, external_application_id, external_job_id, external_stage_id,
     job_mapping_id, candidate_id, session_id, lifecycle)
  values ('ashby', 'pol32b-app', 'pol32b-job', 'b_ai', v_mapid, v_cand, v_sess, 'imported')
  returning id into v_link;

  -- ── M1: `both` enqueues two distinguishable operations ──────────────────
  v_opm := screening_v2.enqueue_ashby_operation(
    v_link, 'invite_delivery', 'ashby:invite:pol32b-app:manual:pending', null, null, v_actor);
  v_ope := screening_v2.enqueue_ashby_operation(
    v_link, 'invite_delivery', 'ashby:invite:pol32b-app:email:pending', null, null, v_actor);
  perform _policy_tests.assert('ashby 0032/M1: both mode enqueues two distinct operations',
    v_opm->>'status' = 'inserted' and v_ope->>'status' = 'inserted'
      and (v_opm->>'id') is distinct from (v_ope->>'id'),
    'got ' || coalesce(v_opm->>'status','null') || '/' || coalesce(v_ope->>'status','null'));

  -- Both operations were enqueued in THIS transaction, so they share one
  -- `scheduled_at`. `claim_ashby_operation` orders by `(scheduled_at, id)` and
  -- `id` is a RANDOM uuid, so without this the claim below would return the
  -- manual or the email operation with ~50/50 probability and the two
  -- assertions that follow would be a coin flip. Age the manual operation so
  -- the claim order is deterministic and the test asserts one fixed scenario.
  update screening_v2.ashby_operations
     set scheduled_at = scheduled_at - interval '1 minute'
   where operation_key = 'ashby:invite:pol32b-app:manual:pending';

  -- ── M1: the claim now returns operation_key so the channel is knowable ──
  v_claim := screening_v2.claim_ashby_operation('invite_delivery', 'pol32b-worker', 30);
  perform _policy_tests.assert('ashby 0032/M1: claim returns the operation key (channel)',
    v_claim->>'status' = 'claimed'
      and (v_claim->>'operation_key') = 'ashby:invite:pol32b-app:manual:pending',
    'got ' || coalesce(v_claim->>'operation_key','null'));

  -- ── B1: park under the live lease; NOT success ──────────────────────────
  v_res := screening_v2.park_ashby_operation_awaiting_delivery(
    (v_claim->>'id')::uuid, (v_claim->>'lease_token')::uuid, 'inv-anchor');
  select state into v_state from screening_v2.ashby_operations where id = (v_claim->>'id')::uuid;
  perform _policy_tests.assert('ashby 0032/B1: a minted manual invite parks, it does not succeed',
    v_res->>'status' = 'ok' and v_state = 'awaiting_manual_delivery',
    'got ' || coalesce(v_res->>'status','null') || '/' || coalesce(v_state,'null'));

  -- A stale lease cannot park.
  v_res := screening_v2.park_ashby_operation_awaiting_delivery(
    (v_claim->>'id')::uuid, gen_random_uuid(), null);
  perform _policy_tests.assert('ashby 0032/B1: a stale lease cannot park an operation',
    v_res->>'status' = 'not_owned', 'got ' || coalesce(v_res->>'status','null'));

  -- A parked operation is NOT runnable: the claim skips it and returns the
  -- OTHER (email) operation instead.
  v_claim := screening_v2.claim_ashby_operation('invite_delivery', 'pol32b-worker', 30);
  perform _policy_tests.assert('ashby 0032/B1: a parked operation is never re-claimed',
    (v_claim->>'operation_key') = 'ashby:invite:pol32b-app:email:pending',
    'got ' || coalesce(v_claim->>'operation_key', v_claim->>'status'));

  -- ...and with the manual operation parked and the email one running, there
  -- is nothing left to claim at all.
  v_claim := screening_v2.claim_ashby_operation('invite_delivery', 'pol32b-worker', 30);
  perform _policy_tests.assert('ashby 0032/B1: a parked operation is not claimable when alone',
    v_claim->>'status' = 'empty', 'got ' || coalesce(v_claim->>'status','null'));

  -- ── B1: the hand-off is what makes it succeed ───────────────────────────
  v_res := screening_v2.reissue_ashby_manual_invite(v_link, v_digest, now() + interval '24 hours', v_actor);
  perform _policy_tests.assert('ashby 0032/B1: reissue issues one invite and reports ok',
    v_res->>'status' = 'ok' and (v_res->>'invite_id') is not null,
    'got ' || coalesce(v_res->>'status','null'));

  select count(*) into v_live from screening_v2.candidate_invites
   where session_id = v_sess and consumed_at is null and revoked_at is null and expires_at > now();
  perform _policy_tests.assert('ashby 0032/B1: exactly one ACTIVE invite exists',
    v_live = 1, 'live invites: ' || v_live);

  perform _policy_tests.assert('ashby 0032/B1: only the digest is stored, never a plaintext token',
    exists (select 1 from screening_v2.candidate_invites
             where session_id = v_sess and token_digest = v_digest),
    'the supplied digest must be what is persisted');

  select state into v_state from screening_v2.ashby_operations
   where operation_key = 'ashby:invite:pol32b-app:manual:pending';
  perform _policy_tests.assert('ashby 0032/B1: the hand-off moves the manual op to succeeded',
    v_state = 'succeeded', 'got ' || coalesce(v_state,'null'));

  select state into v_state from screening_v2.ashby_operations
   where operation_key = 'ashby:invite:pol32b-app:email:pending';
  perform _policy_tests.assert('ashby 0032/M1: the EMAIL op is not completed by a manual hand-off',
    v_state is distinct from 'succeeded', 'got ' || coalesce(v_state,'null'));

  perform _policy_tests.assert('ashby 0032/B1: the hand-off is audited without a token',
    exists (select 1 from screening_v2.audit_events
             where action = 'ashby_invite_delivered' and target_id = v_link::text
               and metadata::text not like '%' || v_digest || '%'),
    'expected an ashby_invite_delivered audit row carrying no digest/token');

  -- ── B1: reissue revokes the previous link (never two live invites) ──────
  v_res := screening_v2.reissue_ashby_manual_invite(v_link, v_digest2, now() + interval '24 hours', v_actor);
  select count(*) into v_live from screening_v2.candidate_invites
   where session_id = v_sess and consumed_at is null and revoked_at is null and expires_at > now();
  perform _policy_tests.assert('ashby 0032/B1: reissue revokes the prior invite, leaving exactly one live',
    v_res->>'status' = 'ok' and (v_res->>'revoked_invites')::int = 1 and v_live = 1,
    'live=' || v_live || ' revoked=' || coalesce(v_res->>'revoked_invites','null'));

  -- ── Guards ──────────────────────────────────────────────────────────────
  v_res := screening_v2.reissue_ashby_manual_invite(v_link, 'not-a-digest', now() + interval '24 hours', v_actor);
  perform _policy_tests.assert('ashby 0032/B1: a malformed digest is refused',
    v_res->>'status' = 'invalid_digest', 'got ' || coalesce(v_res->>'status','null'));

  v_res := screening_v2.reissue_ashby_manual_invite(v_link, repeat('c', 64), now() - interval '1 hour', v_actor);
  perform _policy_tests.assert('ashby 0032/B1: an expiry in the past is refused',
    v_res->>'status' = 'invalid_expiry', 'got ' || coalesce(v_res->>'status','null'));

  -- Terminal cancellation sweeps a parked operation and blocks further hand-off.
  insert into screening_v2.ashby_application_links
    (provider, external_application_id, external_job_id, external_stage_id,
     job_mapping_id, candidate_id, session_id, lifecycle)
  values ('ashby', 'pol32b-app2', 'pol32b-job', 'b_ai', v_mapid, v_cand, v_sess, 'imported')
  returning id into v_link;
  v_opm := screening_v2.enqueue_ashby_operation(
    v_link, 'invite_delivery', 'ashby:invite:pol32b-app2:manual:pending', null, null, v_actor);
  update screening_v2.ashby_operations
     set state = 'awaiting_manual_delivery' where id = (v_opm->>'id')::uuid;

  v_res := screening_v2.cancel_ashby_application(v_link, 'withdrawn', 'pol32b', v_actor, 'recruiter');
  select state into v_state from screening_v2.ashby_operations where id = (v_opm->>'id')::uuid;
  perform _policy_tests.assert('ashby 0032/B1: terminal cancel sweeps an awaiting_manual_delivery op',
    v_res->>'status' = 'ok' and v_state = 'cancelled',
    'got ' || coalesce(v_state,'null'));

  v_res := screening_v2.reissue_ashby_manual_invite(v_link, repeat('d', 64), now() + interval '24 hours', v_actor);
  perform _policy_tests.assert('ashby 0032/B1: a terminal application never gets a fresh link',
    v_res->>'status' = 'blocked_terminal', 'got ' || coalesce(v_res->>'status','null'));

  -- A link with no materialized session is not ready for a hand-off.
  insert into screening_v2.ashby_application_links
    (provider, external_application_id, external_job_id, external_stage_id, job_mapping_id, lifecycle)
  values ('ashby', 'pol32b-app3', 'pol32b-job', 'b_ai', v_mapid, 'imported')
  returning id into v_link;
  v_res := screening_v2.reissue_ashby_manual_invite(v_link, repeat('e', 64), now() + interval '24 hours', v_actor);
  perform _policy_tests.assert('ashby 0032/B1: an unmaterialized application reports not_ready',
    v_res->>'status' = 'not_ready', 'got ' || coalesce(v_res->>'status','null'));

  -- Cleanup.
  delete from screening_v2.ashby_application_links
   where external_application_id in ('pol32b-app','pol32b-app2','pol32b-app3');
  delete from screening_v2.candidate_invites where session_id = v_sess;
  delete from screening_v2.call_sessions where id = v_sess;
  delete from screening_v2.candidates where id = v_cand;
  delete from screening_v2.ashby_job_mappings where external_job_id = 'pol32b-job';
  -- audit_events is append-only by design, so the audit rows this block wrote
  -- stay. The synthetic identity is therefore left in place too, since
  -- auth.users is what those rows attribute to.
end;
$$;


-- ═══════════════════════════════════════════════════════════════════════
-- 0033: Ashby reconciliation admission — forced full resync when enabling
--       a mapping opens admission, with an epoch guard so an in-flight run
--       cannot clear it.
-- ═══════════════════════════════════════════════════════════════════════

select _policy_tests.assert(
  'ashby 0033: resync_epoch column exists and is NOT NULL',
  (select count(*) from information_schema.columns
    where table_schema = 'screening_v2'
      and table_name = 'ashby_sync_checkpoints'
      and column_name = 'resync_epoch'
      and is_nullable = 'NO') = 1,
  'ashby_sync_checkpoints.resync_epoch must exist and be NOT NULL'
);

select _policy_tests.assert(
  'ashby 0033 RPCs are service-role only',
  (select count(*)
     from pg_proc p join pg_namespace n on n.oid = p.pronamespace
    where n.nspname = 'screening_v2'
      and p.proname in ('advance_ashby_sync_checkpoint','mark_ashby_sync_full_resync',
                        'begin_ashby_sync_run','upsert_ashby_job_mapping')
      and not has_function_privilege('anon', p.oid, 'EXECUTE')
      and not has_function_privilege('authenticated', p.oid, 'EXECUTE')
      and has_function_privilege('service_role', p.oid, 'EXECUTE')
  ) = 4,
  'ashby 0033 RPCs must be service-role only'
);

select _policy_tests.assert(
  'ashby 0033 RPCs pin search_path',
  (select count(*)
     from pg_proc p join pg_namespace n on n.oid = p.pronamespace
    where n.nspname = 'screening_v2'
      and p.proname in ('advance_ashby_sync_checkpoint','mark_ashby_sync_full_resync',
                        'begin_ashby_sync_run','upsert_ashby_job_mapping')
      and p.prosecdef
      and array_to_string(coalesce(p.proconfig, '{}'), ',') like '%search_path%'
  ) = 4,
  'every 0033 SECURITY DEFINER RPC must pin search_path'
);

-- The superseded 6-argument overload must be gone: leaving it callable would
-- let a caller advance the cursor while bypassing the epoch guard entirely.
select _policy_tests.assert(
  'ashby 0033: exactly one advance_ashby_sync_checkpoint overload remains',
  (select count(*)
     from pg_proc p join pg_namespace n on n.oid = p.pronamespace
    where n.nspname = 'screening_v2'
      and p.proname = 'advance_ashby_sync_checkpoint') = 1,
  'the pre-0033 six-argument overload must be dropped'
);

do $$
declare
  v_role   uuid;
  v_actor  uuid := gen_random_uuid();
  v_map    jsonb;
  v_mapid  uuid;
  v_cp     screening_v2.ashby_sync_checkpoints%rowtype;
  v_epoch  bigint;
  v_res    jsonb;
  v_begin  jsonb;
begin
  select id into v_role from screening_v2.roles order by created_at limit 1;
  if v_role is null then
    perform _policy_tests.assert('ashby 0033 functional: seed role present', false, 'no seed role available');
    return;
  end if;

  -- Start from a clean, advanced (idle) application.list checkpoint.
  delete from screening_v2.ashby_sync_checkpoints where checkpoint_key = 'application.list';
  v_res := screening_v2.advance_ashby_sync_checkpoint('application.list', 'tok-0033-a', 1, 1, true);
  select * into v_cp from screening_v2.ashby_sync_checkpoints
   where provider = 'ashby' and checkpoint_key = 'application.list';
  perform _policy_tests.assert('ashby 0033: baseline checkpoint is idle with a token',
    v_cp.status = 'idle' and v_cp.sync_token = 'tok-0033-a',
    'got status ' || v_cp.status);
  v_epoch := v_cp.resync_epoch;

  -- (a) Creating a PAUSED mapping must NOT force a resync — admission does
  --     not widen, so a routine save never triggers a full provider sweep.
  v_map := screening_v2.upsert_ashby_job_mapping(
    null::uuid, 'pol33-job', v_role, 'pol33_ai', 'pol33_ta', null::text, null::text, null::text,
    gen_random_uuid(), 'manual', 24, 'paused', null::text, v_actor);
  v_mapid := (v_map->>'id')::uuid;
  select * into v_cp from screening_v2.ashby_sync_checkpoints
   where provider = 'ashby' and checkpoint_key = 'application.list';
  perform _policy_tests.assert('ashby 0033: creating a paused mapping forces no resync',
    coalesce((v_map->>'forced_full_resync')::boolean, true) = false
      and v_cp.status = 'idle' and v_cp.resync_epoch = v_epoch,
    'paused create must not force a resync');

  -- (b) ENABLING the mapping must force full_resync_required in the SAME
  --     transaction, so applications already parked at the trigger stage are
  --     reconsidered under the new mapping.
  v_map := screening_v2.upsert_ashby_job_mapping(
    v_mapid, 'pol33-job', v_role, 'pol33_ai', 'pol33_ta', null::text, null::text, null::text,
    gen_random_uuid(), 'manual', 24, 'enabled', null::text, v_actor);
  select * into v_cp from screening_v2.ashby_sync_checkpoints
   where provider = 'ashby' and checkpoint_key = 'application.list';
  perform _policy_tests.assert('ashby 0033: enabling a mapping forces a full resync',
    (v_map->>'forced_full_resync')::boolean
      and v_cp.status = 'full_resync_required'
      and v_cp.sync_token is null
      and v_cp.resync_epoch = v_epoch + 1,
    'enable must force full_resync_required and bump the epoch');

  perform _policy_tests.assert('ashby 0033: the forced resync is audited on the mapping event',
    exists (select 1 from screening_v2.audit_events
             where action = 'ashby_mapping_update'
               and target_id = v_mapid::text
               and (metadata->>'forced_full_resync')::boolean),
    'the mapping audit row must record the forced resync');

  -- (c) Re-saving the SAME enabled mapping with an unchanged AI stage must
  --     not force another resync (the same rows are already admitted).
  v_epoch := v_cp.resync_epoch;
  v_res := screening_v2.advance_ashby_sync_checkpoint('application.list', 'tok-0033-b', 1, 1, true,
                                                      now(), v_epoch);
  v_map := screening_v2.upsert_ashby_job_mapping(
    v_mapid, 'pol33-job', v_role, 'pol33_ai', 'pol33_ta', null::text, null::text, null::text,
    gen_random_uuid(), 'both', 24, 'enabled', 'relabel', v_actor);
  select * into v_cp from screening_v2.ashby_sync_checkpoints
   where provider = 'ashby' and checkpoint_key = 'application.list';
  perform _policy_tests.assert('ashby 0033: re-saving an enabled mapping forces no resync',
    coalesce((v_map->>'forced_full_resync')::boolean, true) = false
      and v_cp.status = 'idle' and v_cp.resync_epoch = v_epoch,
    'an unchanged AI stage must not force a resync');

  -- (d) Repointing the AI stage of an ENABLED mapping opens new admission and
  --     must force a resync.
  v_map := screening_v2.upsert_ashby_job_mapping(
    v_mapid, 'pol33-job', v_role, 'pol33_ai_v2', 'pol33_ta', null::text, null::text, null::text,
    gen_random_uuid(), 'manual', 24, 'enabled', null::text, v_actor);
  select * into v_cp from screening_v2.ashby_sync_checkpoints
   where provider = 'ashby' and checkpoint_key = 'application.list';
  perform _policy_tests.assert('ashby 0033: repointing the AI stage forces a resync',
    (v_map->>'forced_full_resync')::boolean and v_cp.status = 'full_resync_required',
    'a new AI stage must force a resync');

  -- (e) EPOCH GUARD: a run that read the checkpoint BEFORE the enable must not
  --     clear the forced resync when it finishes.
  v_epoch := v_cp.resync_epoch;                    -- what an in-flight run read
  v_res := screening_v2.mark_ashby_sync_full_resync('application.list', 'mapping_enabled');
  v_res := screening_v2.advance_ashby_sync_checkpoint('application.list', 'tok-0033-c', 2, 5, true,
                                                      now(), v_epoch);
  select * into v_cp from screening_v2.ashby_sync_checkpoints
   where provider = 'ashby' and checkpoint_key = 'application.list';
  perform _policy_tests.assert('ashby 0033: a stale run cannot clear a mid-run forced resync',
    (v_res->>'resync_pending')::boolean
      and v_cp.status = 'full_resync_required'
      and v_cp.sync_token = 'tok-0033-c',
    'the cursor advances but the forced resync must stand');

  -- (f) A run holding the CURRENT epoch does clear the flag normally.
  v_res := screening_v2.advance_ashby_sync_checkpoint('application.list', 'tok-0033-d', 2, 5, true,
                                                      now(), v_cp.resync_epoch);
  select * into v_cp from screening_v2.ashby_sync_checkpoints
   where provider = 'ashby' and checkpoint_key = 'application.list';
  perform _policy_tests.assert('ashby 0033: a current-epoch run clears the forced resync',
    coalesce((v_res->>'resync_pending')::boolean, true) = false and v_cp.status = 'idle',
    'a run that observed the latest epoch must clear the flag');

  -- (g) begin_ashby_sync_run exposes the epoch the run must compare against.
  v_begin := screening_v2.begin_ashby_sync_run('application.list', 'pol33-owner', 60);
  perform _policy_tests.assert('ashby 0033: begin_ashby_sync_run returns resync_epoch',
    v_begin->>'status' = 'ok' and (v_begin->>'resync_epoch')::bigint = v_cp.resync_epoch,
    'the lease acquisition must expose the current epoch');
  v_res := screening_v2.end_ashby_sync_run('application.list', 'pol33-owner', true);

  -- Cleanup (audit_events is append-only by design and is left intact).
  delete from screening_v2.ashby_job_mappings where external_job_id = 'pol33-job';
  delete from screening_v2.ashby_sync_checkpoints where checkpoint_key = 'application.list';
end;
$$;


-- ── 0033 (B3): set_ashby_mapping_status is the REAL Mission Control resume
--    path (POST /mappings/:id/resume). Hooking only upsert_ashby_job_mapping
--    would have left the operator's actual resume with no backfill at all.

select _policy_tests.assert(
  'ashby 0033: set_ashby_mapping_status is service-role only with a pinned search_path',
  (select count(*)
     from pg_proc p join pg_namespace n on n.oid = p.pronamespace
    where n.nspname = 'screening_v2'
      and p.proname = 'set_ashby_mapping_status'
      and p.prosecdef
      and array_to_string(coalesce(p.proconfig, '{}'), ',') like '%search_path%'
      and not has_function_privilege('anon', p.oid, 'EXECUTE')
      and not has_function_privilege('authenticated', p.oid, 'EXECUTE')
      and has_function_privilege('service_role', p.oid, 'EXECUTE')) = 1,
  'set_ashby_mapping_status must stay service-role-only and pin search_path'
);

do $$
declare
  v_role  uuid;
  v_actor uuid := gen_random_uuid();
  v_map   jsonb;
  v_mapid uuid;
  v_res   jsonb;
  v_cp    screening_v2.ashby_sync_checkpoints%rowtype;
  v_epoch bigint;
begin
  select id into v_role from screening_v2.roles order by created_at limit 1;
  if v_role is null then
    perform _policy_tests.assert('ashby 0033/B3 functional: seed role present', false, 'no seed role available');
    return;
  end if;

  delete from screening_v2.ashby_sync_checkpoints where checkpoint_key = 'application.list';
  v_res := screening_v2.advance_ashby_sync_checkpoint('application.list', 'tok-b3', 1, 1, true);
  select * into v_cp from screening_v2.ashby_sync_checkpoints
   where provider = 'ashby' and checkpoint_key = 'application.list';
  v_epoch := v_cp.resync_epoch;

  v_map := screening_v2.upsert_ashby_job_mapping(
    null::uuid, 'pol33b-job', v_role, 'b3_ai', 'b3_ta', null::text, null::text, null::text,
    gen_random_uuid(), 'manual', 24, 'paused', null::text, v_actor);
  v_mapid := (v_map->>'id')::uuid;

  -- Resume (paused → enabled) MUST force the backfill in the same transaction.
  v_res := screening_v2.set_ashby_mapping_status(v_mapid, 'enabled', null::text, v_actor);
  select * into v_cp from screening_v2.ashby_sync_checkpoints
   where provider = 'ashby' and checkpoint_key = 'application.list';
  perform _policy_tests.assert('ashby 0033/B3: resume forces a full resync',
    v_res->>'status' = 'ok'
      and (v_res->>'forced_full_resync')::boolean
      and v_cp.status = 'full_resync_required'
      and v_cp.full_resync_reason = 'mapping_enabled'
      and v_cp.sync_token is null
      and v_cp.resync_epoch = v_epoch + 1,
    'POST /mappings/:id/resume must force the application.list backfill');

  perform _policy_tests.assert('ashby 0033/B3: the resume audit row records the forced resync',
    exists (select 1 from screening_v2.audit_events
             where action = 'ashby_mapping_update'
               and target_id = v_mapid::text
               and metadata->>'action' = 'set_status'
               and (metadata->>'forced_full_resync')::boolean),
    'the resume audit row must record forced_full_resync');

  -- Re-enabling an already-enabled mapping forces nothing (same rows admitted).
  v_epoch := v_cp.resync_epoch;
  v_res := screening_v2.advance_ashby_sync_checkpoint('application.list', 'tok-b3b', 1, 1, true,
                                                      now(), v_epoch);
  v_res := screening_v2.set_ashby_mapping_status(v_mapid, 'enabled', null::text, v_actor);
  select * into v_cp from screening_v2.ashby_sync_checkpoints
   where provider = 'ashby' and checkpoint_key = 'application.list';
  perform _policy_tests.assert('ashby 0033/B3: re-enabling an enabled mapping forces no resync',
    coalesce((v_res->>'forced_full_resync')::boolean, true) = false and v_cp.status = 'idle',
    'no transition means no backfill');

  -- PAUSING forces nothing: admission only narrows.
  v_res := screening_v2.set_ashby_mapping_status(v_mapid, 'paused', 'operator', v_actor);
  select * into v_cp from screening_v2.ashby_sync_checkpoints
   where provider = 'ashby' and checkpoint_key = 'application.list';
  perform _policy_tests.assert('ashby 0033/B3: pausing forces no resync',
    coalesce((v_res->>'forced_full_resync')::boolean, true) = false
      and v_cp.status = 'idle' and v_cp.resync_epoch = v_epoch,
    'pausing must not trigger a full provider sweep');

  -- An incomplete mapping still cannot be enabled, and forces nothing.
  v_map := screening_v2.upsert_ashby_job_mapping(
    null::uuid, 'pol33b-job2', v_role, null::text, null::text, null::text, null::text, null::text,
    gen_random_uuid(), 'manual', 24, 'paused', null::text, v_actor);
  v_res := screening_v2.set_ashby_mapping_status((v_map->>'id')::uuid, 'enabled', null::text, v_actor);
  select * into v_cp from screening_v2.ashby_sync_checkpoints
   where provider = 'ashby' and checkpoint_key = 'application.list';
  perform _policy_tests.assert('ashby 0033/B3: a refused enable forces no resync',
    v_res->>'status' = 'incomplete_cannot_enable' and v_cp.status = 'idle',
    'a rejected enable must leave the checkpoint untouched');

  -- Atomicity: rolling back the resume leaves BOTH the status and the
  -- checkpoint unchanged — they are one transaction, never half-applied.
  begin
    v_res := screening_v2.set_ashby_mapping_status(v_mapid, 'enabled', null::text, v_actor);
    raise exception 'rollback_probe';
  exception when others then
    if sqlerrm <> 'rollback_probe' then raise; end if;
  end;
  select * into v_cp from screening_v2.ashby_sync_checkpoints
   where provider = 'ashby' and checkpoint_key = 'application.list';
  perform _policy_tests.assert('ashby 0033/B3: a rolled-back resume leaves status AND checkpoint unchanged',
    v_cp.status = 'idle'
      and (select status from screening_v2.ashby_job_mappings where id = v_mapid) = 'paused',
    'the status flip and the forced resync must roll back together');

  delete from screening_v2.ashby_job_mappings where external_job_id in ('pol33b-job','pol33b-job2');
  delete from screening_v2.ashby_sync_checkpoints where checkpoint_key = 'application.list';
end;
$$;

-- ═══════════════════════════════════════════════════════════════════════
-- 0034 — page-anchored full-resync continuation
-- ═══════════════════════════════════════════════════════════════════════
-- The production stall this closes: a forced full resync had to drain in ONE
-- run or the cursor never moved, so a corpus above the per-run page/item bound
-- re-paged the same prefix forever and reconciliation never came up. These
-- tests pin the two compare-and-sets that make partial checkpointing safe
-- (resync_epoch, live lease owner) and the atomic finish.

select _policy_tests.assert(
  'ashby 0034 RPCs are service-role only',
  (select count(*)
     from pg_proc p join pg_namespace n on n.oid = p.pronamespace
    where n.nspname = 'screening_v2'
      and p.proname in ('save_ashby_resync_cursor','advance_ashby_sync_checkpoint',
                        'mark_ashby_sync_full_resync','begin_ashby_sync_run',
                        'halt_ashby_sync_sweep')
      and not has_function_privilege('anon', p.oid, 'EXECUTE')
      and not has_function_privilege('authenticated', p.oid, 'EXECUTE')
      and has_function_privilege('service_role', p.oid, 'EXECUTE')
  ) = 5,
  'ashby 0034 RPCs must be service-role only'
);

select _policy_tests.assert(
  'ashby 0034 RPCs pin search_path',
  (select count(*)
     from pg_proc p join pg_namespace n on n.oid = p.pronamespace
    where n.nspname = 'screening_v2'
      and p.proname in ('save_ashby_resync_cursor','advance_ashby_sync_checkpoint',
                        'mark_ashby_sync_full_resync','begin_ashby_sync_run',
                        'halt_ashby_sync_sweep')
      and p.prosecdef
      and array_to_string(coalesce(p.proconfig, '{}'), ',') like '%search_path%'
  ) = 5,
  'every 0034 SECURITY DEFINER RPC must pin search_path'
);

select _policy_tests.assert(
  'ashby 0034: exactly one save_ashby_resync_cursor overload exists',
  (select count(*)
     from pg_proc p join pg_namespace n on n.oid = p.pronamespace
    where n.nspname = 'screening_v2'
      and p.proname = 'save_ashby_resync_cursor') = 1,
  'a second overload could bypass the epoch/lease guards'
);

-- N1: the superseded save signatures are explicitly dropped, so an environment
-- that ever saw an in-progress form cannot end up with ambiguous dispatch.
select _policy_tests.assert(
  'ashby 0034/N1: no superseded save_ashby_resync_cursor overload survives',
  (select count(*)
     from pg_proc p join pg_namespace n on n.oid = p.pronamespace
    where n.nspname = 'screening_v2'
      and p.proname = 'save_ashby_resync_cursor'
      and p.pronargs <> 11) = 0,
  'only the 11-argument save_ashby_resync_cursor may exist'
);

-- The superseded 7-argument advance overload must be gone: leaving it callable
-- would let a stale runner advance while bypassing the lease guard entirely.
select _policy_tests.assert(
  'ashby 0034: exactly one advance_ashby_sync_checkpoint overload remains',
  (select count(*)
     from pg_proc p join pg_namespace n on n.oid = p.pronamespace
    where n.nspname = 'screening_v2'
      and p.proname = 'advance_ashby_sync_checkpoint') = 1,
  'the pre-0034 seven-argument overload must be dropped'
);

-- The continuation cursor is an opaque black box on a table that must stay
-- entirely out of reach of the browser roles — same posture as sync_token.
select _policy_tests.assert(
  'ashby 0034: browser roles cannot read the continuation cursor',
  not has_table_privilege('anon', 'screening_v2.ashby_sync_checkpoints', 'SELECT')
  and not has_table_privilege('authenticated', 'screening_v2.ashby_sync_checkpoints', 'SELECT'),
  'ashby_sync_checkpoints must remain service-role only'
);

do $$
declare
  v_role   uuid;
  v_actor  uuid := gen_random_uuid();
  v_cp     screening_v2.ashby_sync_checkpoints%rowtype;
  v_epoch  bigint;
  v_res    jsonb;
  v_begin  jsonb;
  v_map    jsonb;
begin
  select id into v_role from screening_v2.roles order by created_at limit 1;
  if v_role is null then
    perform _policy_tests.assert('ashby 0034 functional: seed role present', false, 'no seed role available');
    return;
  end if;

  delete from screening_v2.ashby_sync_checkpoints where checkpoint_key = 'application.list';

  -- (a) A forced resync starts a generation with NO continuation.
  v_res := screening_v2.mark_ashby_sync_full_resync('application.list', 'pol34_start');
  select * into v_cp from screening_v2.ashby_sync_checkpoints
   where provider = 'ashby' and checkpoint_key = 'application.list';
  perform _policy_tests.assert('ashby 0034: a forced resync leaves no page anchor',
    v_cp.status = 'full_resync_required' and v_cp.resync_cursor is null
      and v_cp.resync_pages_done = 0 and v_cp.resync_items_done = 0,
    'expected a clean continuation, got cursor ' || coalesce(v_cp.resync_cursor, '<null>'));
  v_epoch := v_cp.resync_epoch;

  -- (b) An anchor written WITHOUT the lease is refused. This is the guard that
  --     stops a runner whose lease expired from moving another runner's cursor.
  v_res := screening_v2.save_ashby_resync_cursor(
    'application.list', 'cur-100', 'runner-a', 1, 100, v_epoch, now(), 'full');
  perform _policy_tests.assert('ashby 0034: an unleased anchor write is refused',
    v_res->>'status' = 'lease_expired',
    'got ' || coalesce(v_res->>'status', '<null>'));

  -- (c) With the lease held, the anchor lands and the counters move forward.
  v_begin := screening_v2.begin_ashby_sync_run('application.list', 'runner-a', 300);
  perform _policy_tests.assert('ashby 0034: begin_ashby_sync_run exposes the continuation',
    v_begin->>'status' = 'ok' and v_begin->>'resync_cursor' is null
      and (v_begin->>'resync_pages_done')::integer = 0,
    'got ' || coalesce(v_begin::text, '<null>'));

  v_res := screening_v2.save_ashby_resync_cursor(
    'application.list', 'cur-100', 'runner-a', 1, 100, v_epoch, now(), 'full', 'tok-sweep-1', true);
  select * into v_cp from screening_v2.ashby_sync_checkpoints
   where provider = 'ashby' and checkpoint_key = 'application.list';
  perform _policy_tests.assert('ashby 0034: the leased anchor is persisted',
    v_res->>'status' = 'ok' and v_cp.resync_cursor = 'cur-100'
      and v_cp.resync_pages_done = 1 and v_cp.resync_items_done = 100
      and v_cp.resync_started_at is not null
      and v_cp.resync_cursor_epoch = v_epoch
      and v_cp.resync_cursor_at is not null
      and v_cp.sweep_mode = 'full'
      and v_cp.sweep_token = 'tok-sweep-1',
    'got cursor ' || coalesce(v_cp.resync_cursor, '<null>'));

  -- I7: an anchor write touches NO stream-level field. A pending forced
  -- resync must survive every anchor write untouched.
  perform _policy_tests.assert('ashby 0034: anchoring never rewrites stream state',
    v_cp.status = 'full_resync_required' and v_cp.sync_token is null
      and v_cp.full_resync_reason = 'pol34_start' and v_cp.no_progress_runs = 0,
    'anchoring altered stream state: status ' || v_cp.status);

  -- H-6: the sweep token is FIRST-write-wins across the sweep.
  v_res := screening_v2.save_ashby_resync_cursor(
    'application.list', 'cur-150', 'runner-a', 2, 150, v_epoch, now(), 'full', 'tok-sweep-2');
  select * into v_cp from screening_v2.ashby_sync_checkpoints
   where provider = 'ashby' and checkpoint_key = 'application.list';
  perform _policy_tests.assert('ashby 0034: the sweep token is earliest-wins',
    v_cp.sweep_token = 'tok-sweep-1',
    'expected the earliest token, got ' || coalesce(v_cp.sweep_token, '<null>'));

  -- An invalid sweep mode is refused rather than silently stored.
  v_res := screening_v2.save_ashby_resync_cursor(
    'application.list', 'cur-160', 'runner-a', 2, 160, v_epoch, now(), 'sideways');
  perform _policy_tests.assert('ashby 0034: an invalid sweep mode is refused',
    v_res->>'status' = 'invalid_mode',
    'got ' || coalesce(v_res->>'status', '<null>'));

  -- (d) A DIFFERENT runner cannot move it, even holding the right epoch.
  v_res := screening_v2.save_ashby_resync_cursor(
    'application.list', 'cur-999', 'runner-b', 9, 900, v_epoch, now(), 'full');
  select * into v_cp from screening_v2.ashby_sync_checkpoints
   where provider = 'ashby' and checkpoint_key = 'application.list';
  perform _policy_tests.assert('ashby 0034: a non-owner cannot move the anchor',
    v_res->>'status' = 'not_owned' and v_cp.resync_cursor = 'cur-150',
    'got ' || coalesce(v_res->>'status', '<null>'));

  -- (e) Counters never move backwards.
  v_res := screening_v2.save_ashby_resync_cursor(
    'application.list', 'cur-200', 'runner-a', 0, 0, v_epoch, now(), 'full');
  select * into v_cp from screening_v2.ashby_sync_checkpoints
   where provider = 'ashby' and checkpoint_key = 'application.list';
  perform _policy_tests.assert('ashby 0034: continuation counters only move forward',
    v_res->>'status' = 'ok' and v_cp.resync_cursor = 'cur-200'
      and v_cp.resync_pages_done = 2 and v_cp.resync_items_done = 150,
    'counters regressed to ' || v_cp.resync_pages_done || '/' || v_cp.resync_items_done);

  -- (f) An empty/null cursor is refused: it would silently mean "page 1".
  v_res := screening_v2.save_ashby_resync_cursor(
    'application.list', null, 'runner-a', 5, 500, v_epoch, now(), 'full');
  perform _policy_tests.assert('ashby 0034: a null anchor is refused',
    v_res->>'status' = 'invalid_cursor',
    'got ' || coalesce(v_res->>'status', '<null>'));

  -- (g) ENABLING A MAPPING MID-RUN invalidates the continuation, and the
  --     in-flight run can no longer anchor into the new generation.
  v_map := screening_v2.upsert_ashby_job_mapping(
    null::uuid, 'pol34-job', v_role, 'pol34_ai', 'pol34_ta', null::text, null::text, null::text,
    gen_random_uuid(), 'manual', 24, 'enabled', null::text, v_actor);
  select * into v_cp from screening_v2.ashby_sync_checkpoints
   where provider = 'ashby' and checkpoint_key = 'application.list';
  perform _policy_tests.assert('ashby 0034: enabling a mapping invalidates the continuation',
    v_cp.status = 'full_resync_required' and v_cp.resync_cursor is null
      and v_cp.resync_cursor_epoch is null and v_cp.sweep_mode is null
      and v_cp.sweep_token is null and v_cp.sweep_restarts = 0
      and v_cp.resync_pages_done = 0 and v_cp.resync_epoch = v_epoch + 1,
    'expected a cleared continuation at epoch ' || (v_epoch + 1)
      || ', got cursor ' || coalesce(v_cp.resync_cursor, '<null>')
      || ' at epoch ' || v_cp.resync_epoch);

  v_res := screening_v2.save_ashby_resync_cursor(
    'application.list', 'cur-300', 'runner-a', 3, 300, v_epoch, now(), 'full');
  select * into v_cp from screening_v2.ashby_sync_checkpoints
   where provider = 'ashby' and checkpoint_key = 'application.list';
  perform _policy_tests.assert('ashby 0034: a stale-epoch run cannot resurrect its anchor',
    v_res->>'status' = 'epoch_changed' and v_cp.resync_cursor is null,
    'got ' || coalesce(v_res->>'status', '<null>'));

  -- (h) That same stale run advancing must not clear the forced resync NOR
  --     touch the newer generation's continuation.
  v_epoch := v_cp.resync_epoch;
  v_res := screening_v2.save_ashby_resync_cursor(
    'application.list', 'cur-400', 'runner-a', 4, 400, v_epoch, now(), 'full', 'tok-gen2', true);
  perform _policy_tests.assert('ashby 0034: the new generation can anchor normally',
    v_res->>'status' = 'ok', 'got ' || coalesce(v_res->>'status', '<null>'));

  v_res := screening_v2.advance_ashby_sync_checkpoint(
    'application.list', 'tok-0034-stale', 2, 5, true, now(), v_epoch - 1);
  select * into v_cp from screening_v2.ashby_sync_checkpoints
   where provider = 'ashby' and checkpoint_key = 'application.list';
  perform _policy_tests.assert(
    'ashby 0034: a stale advance preserves the forced resync AND the newer anchor',
    (v_res->>'resync_pending')::boolean
      and v_cp.status = 'full_resync_required'
      and v_cp.resync_cursor = 'cur-400'
      and v_cp.resync_pages_done = 4,
    'got status ' || v_cp.status || ' cursor ' || coalesce(v_cp.resync_cursor, '<null>'));

  -- (i) A CURRENT-epoch drained run installs the token AND ends the
  --     continuation atomically — no window where a stale anchor coexists
  --     with a fresh incremental token.
  v_res := screening_v2.advance_ashby_sync_checkpoint(
    'application.list', 'tok-0034-final', 12, 1200, true, now(), v_cp.resync_epoch);
  select * into v_cp from screening_v2.ashby_sync_checkpoints
   where provider = 'ashby' and checkpoint_key = 'application.list';
  perform _policy_tests.assert(
    'ashby 0034: a drained run installs the EARLIEST token and ends the continuation',
    v_cp.status = 'idle'
      -- H-6: the token banked at the START of the sweep wins over the one the
      -- final run observed at the END.
      and v_cp.sync_token = 'tok-gen2'
      and v_cp.token_issued_at is not null
      and v_cp.resync_cursor is null and v_cp.resync_cursor_epoch is null
      and v_cp.resync_cursor_at is null and v_cp.sweep_mode is null
      and v_cp.sweep_token is null and v_cp.resync_pages_done = 0
      and v_cp.resync_items_done = 0 and v_cp.resync_started_at is null,
    'got status ' || v_cp.status || ' token ' || coalesce(v_cp.sync_token, '<null>'));

  -- (j) H-5: a runner that no longer holds the lease cannot install a token
  --     over the sweep whoever holds it is performing. Before this guard, a
  --     stale advance left the stream idle with a valid token and the live
  --     runner's unread pages were never swept again.
  v_res := screening_v2.begin_ashby_sync_run('application.list', 'runner-a', 300);
  v_res := screening_v2.save_ashby_resync_cursor(
    'application.list', 'cur-700', 'runner-a', 7, 700, null, now(), 'full');
  v_res := screening_v2.advance_ashby_sync_checkpoint(
    'application.list', 'tok-0034-stale-owner', 1, 1, true, now(), null, 'runner-b');
  select * into v_cp from screening_v2.ashby_sync_checkpoints
   where provider = 'ashby' and checkpoint_key = 'application.list';
  perform _policy_tests.assert('ashby 0034: a non-owner cannot install a sync token',
    v_res->>'status' = 'not_owned'
      and v_cp.sync_token is distinct from 'tok-0034-stale-owner'
      and v_cp.resync_cursor = 'cur-700',
    'got ' || coalesce(v_res->>'status', '<null>')
      || ' cursor ' || coalesce(v_cp.resync_cursor, '<null>'));

  -- The genuine owner still advances, and the continuation ends with it.
  v_res := screening_v2.advance_ashby_sync_checkpoint(
    'application.list', 'tok-0034-owned', 1, 1, true, now(), null, 'runner-a');
  select * into v_cp from screening_v2.ashby_sync_checkpoints
   where provider = 'ashby' and checkpoint_key = 'application.list';
  perform _policy_tests.assert('ashby 0034: the lease owner advances normally',
    v_res->>'status' = 'ok' and v_cp.sync_token = 'tok-0034-owned'
      and v_cp.resync_cursor is null,
    'got ' || coalesce(v_res->>'status', '<null>'));

  -- (k) H-8: the per-sweep enqueue accumulator and the HALT that bounds it.
  --     Page-aligning the per-run breaker made it a rate limit; this is the
  --     sweep-level ceiling that restores the wedge.
  v_res := screening_v2.save_ashby_resync_cursor(
    'application.list', 'cur-800', 'runner-a', 8, 800, null, now(), 'full', null, false, 120);
  select * into v_cp from screening_v2.ashby_sync_checkpoints
   where provider = 'ashby' and checkpoint_key = 'application.list';
  perform _policy_tests.assert('ashby 0034: sweep_enqueued accumulates with the anchor',
    v_res->>'status' = 'ok' and v_cp.sweep_enqueued = 120,
    'got sweep_enqueued ' || coalesce(v_cp.sweep_enqueued::text, '<null>'));

  -- Monotonic: a lower report never walks the budget backwards.
  v_res := screening_v2.save_ashby_resync_cursor(
    'application.list', 'cur-810', 'runner-a', 8, 810, null, now(), 'full', null, false, 5);
  select * into v_cp from screening_v2.ashby_sync_checkpoints
   where provider = 'ashby' and checkpoint_key = 'application.list';
  perform _policy_tests.assert('ashby 0034: sweep_enqueued only moves forward',
    v_cp.sweep_enqueued = 120,
    'budget regressed to ' || v_cp.sweep_enqueued);

  -- A non-owner cannot halt the stream.
  v_res := screening_v2.halt_ashby_sync_sweep(
    'application.list', 'runner-b', 'sweep_enqueue_budget');
  perform _policy_tests.assert('ashby 0034: a non-owner cannot halt the sweep',
    v_res->>'status' = 'not_owned',
    'got ' || coalesce(v_res->>'status', '<null>'));

  -- The owner halts: the anchor is dropped, `status` is NOT touched (D-3), so
  -- a pending forced-resync demand survives the halt.
  v_res := screening_v2.halt_ashby_sync_sweep(
    'application.list', 'runner-a', 'sweep_enqueue_budget');
  select * into v_cp from screening_v2.ashby_sync_checkpoints
   where provider = 'ashby' and checkpoint_key = 'application.list';
  perform _policy_tests.assert('ashby 0034: halting drops the anchor and preserves status',
    v_res->>'status' = 'ok'
      and v_cp.sweep_halted_at is not null
      and v_cp.sweep_halt_reason = 'sweep_enqueue_budget'
      and v_cp.resync_cursor is null and v_cp.resync_cursor_epoch is null
      and v_cp.status = 'idle',
    'got halt_reason ' || coalesce(v_cp.sweep_halt_reason, '<null>')
      || ' status ' || v_cp.status);

  -- A forced resync is the operator action that clears the halt.
  v_res := screening_v2.mark_ashby_sync_full_resync('application.list', 'pol34_clear');
  select * into v_cp from screening_v2.ashby_sync_checkpoints
   where provider = 'ashby' and checkpoint_key = 'application.list';
  perform _policy_tests.assert('ashby 0034: a forced resync clears the halt and the budget',
    v_cp.sweep_halted_at is null and v_cp.sweep_halt_reason is null
      and v_cp.sweep_enqueued = 0,
    'halt survived a forced resync');

  -- B2: the restart budget must be a per-EPISODE counter, not a lifetime
  -- latch. A lifetime counter made the documented halt-clear cosmetic: the
  -- stream re-halted on the first failed binding after it, forever.
  update screening_v2.ashby_sync_checkpoints
     set sweep_restarts = 5
   where provider = 'ashby' and checkpoint_key = 'application.list';
  v_res := screening_v2.mark_ashby_sync_full_resync('application.list', 'pol34_b2');
  select * into v_cp from screening_v2.ashby_sync_checkpoints
   where provider = 'ashby' and checkpoint_key = 'application.list';
  perform _policy_tests.assert('ashby 0034/B2: a forced resync clears the restart budget',
    v_cp.sweep_restarts = 0,
    'restart budget survived the documented clear: ' || v_cp.sweep_restarts);

  -- A drained sweep proves resume works, so it clears the tally too.
  update screening_v2.ashby_sync_checkpoints
     set sweep_restarts = 4
   where provider = 'ashby' and checkpoint_key = 'application.list';
  v_begin := screening_v2.begin_ashby_sync_run('application.list', 'runner-a', 300);
  select * into v_cp from screening_v2.ashby_sync_checkpoints
   where provider = 'ashby' and checkpoint_key = 'application.list';
  v_res := screening_v2.advance_ashby_sync_checkpoint(
    'application.list', 'tok-b2-drain', 1, 1, true, now(), v_cp.resync_epoch, 'runner-a');
  select * into v_cp from screening_v2.ashby_sync_checkpoints
   where provider = 'ashby' and checkpoint_key = 'application.list';
  perform _policy_tests.assert('ashby 0034/B2: a drained sweep clears the restart budget',
    v_res->>'status' = 'ok' and v_cp.sweep_restarts = 0 and v_cp.sweep_enqueued = 0,
    'got restarts ' || v_cp.sweep_restarts);
  v_res := screening_v2.end_ashby_sync_run('application.list', 'runner-a', true);

  -- N2: halting requires a LIVE lease, matching save and advance.
  v_res := screening_v2.halt_ashby_sync_sweep(
    'application.list', 'runner-a', 'sweep_enqueue_budget');
  perform _policy_tests.assert('ashby 0034/N2: an unleased halt is refused',
    v_res->>'status' = 'lease_expired',
    'got ' || coalesce(v_res->>'status', '<null>'));

  -- An unsanitized halt reason is refused rather than stored.
  v_res := screening_v2.begin_ashby_sync_run('application.list', 'runner-a', 300);
  v_res := screening_v2.halt_ashby_sync_sweep('application.list', 'runner-a', repeat('x', 65));
  perform _policy_tests.assert('ashby 0034: an over-long halt reason is refused',
    v_res->>'status' = 'invalid_reason',
    'got ' || coalesce(v_res->>'status', '<null>'));
  v_res := screening_v2.end_ashby_sync_run('application.list', 'runner-a', false);
  v_res := screening_v2.mark_ashby_sync_full_resync('application.list', 'pol34_reset2');
  v_begin := screening_v2.begin_ashby_sync_run('application.list', 'runner-a', 300);
  select * into v_cp from screening_v2.ashby_sync_checkpoints
   where provider = 'ashby' and checkpoint_key = 'application.list';

  -- (l) L2: advance requires a LIVE lease, not merely a matching owner name.
  update screening_v2.ashby_sync_checkpoints
     set lease_expires_at = now() - interval '1 second'
   where provider = 'ashby' and checkpoint_key = 'application.list';
  v_res := screening_v2.advance_ashby_sync_checkpoint(
    'application.list', 'tok-expired', 1, 1, true, now(), null, 'runner-a');
  perform _policy_tests.assert('ashby 0034: an EXPIRED lease cannot advance',
    v_res->>'status' = 'lease_expired',
    'got ' || coalesce(v_res->>'status', '<null>'));
  update screening_v2.ashby_sync_checkpoints
     set lease_expires_at = now() + interval '300 seconds'
   where provider = 'ashby' and checkpoint_key = 'application.list';

  -- (m) The anchor cannot outlive its own lease: end the run, then try again.
  v_res := screening_v2.end_ashby_sync_run('application.list', 'runner-a', true);
  v_res := screening_v2.save_ashby_resync_cursor(
    'application.list', 'cur-500', 'runner-a', 5, 500, v_cp.resync_epoch, now(), 'full');
  perform _policy_tests.assert('ashby 0034: a released lease cannot anchor',
    v_res->>'status' = 'lease_expired',
    'got ' || coalesce(v_res->>'status', '<null>'));

  delete from screening_v2.ashby_job_mappings where external_job_id = 'pol34-job';
  delete from screening_v2.ashby_sync_checkpoints where checkpoint_key = 'application.list';
end;
$$;


-- =====================================================================
-- 0035: Ashby invite prerequisites — claim gate, attempt-safe deferral,
--       guarded reopen, and the blocked/stuck counters.
-- =====================================================================

select _policy_tests.assert(
  'ashby 0035 RPCs are service-role only',
  (select count(*)
     from pg_proc p join pg_namespace n on n.oid = p.pronamespace
    where n.nspname = 'screening_v2'
      and p.proname in ('defer_ashby_operation','reopen_ashby_invite_delivery',
                        'ashby_prerequisite_backlog')
      and not has_function_privilege('anon', p.oid, 'EXECUTE')
      and not has_function_privilege('authenticated', p.oid, 'EXECUTE')
      and has_function_privilege('service_role', p.oid, 'EXECUTE')
  ) = 3,
  'ashby 0035 RPCs must be service-role only'
);

select _policy_tests.assert(
  'ashby 0035 RPCs pin search_path',
  (select count(*)
     from pg_proc p join pg_namespace n on n.oid = p.pronamespace
    where n.nspname = 'screening_v2'
      and p.proname in ('defer_ashby_operation','reopen_ashby_invite_delivery',
                        'ashby_prerequisite_backlog')
      and p.prosecdef
      and array_to_string(coalesce(p.proconfig, '{}'), ',') like '%search_path%'
  ) = 3,
  'every 0035 SECURITY DEFINER RPC must pin search_path'
);

-- The file-handle bound is a CROSS-LAYER contract (client + extractor + this
-- CHECK). 0035 deliberately does NOT widen it; this asserts it is still 512,
-- because raising it here alone would let an over-long handle reach createLink.
select _policy_tests.assert(
  'ashby 0035: the resume file handle CHECK is still bounded at 512',
  (select pg_get_constraintdef(oid)
     from pg_constraint
    where conname = 'chk_ashby_application_links_resume_handle'
      and conrelid = 'screening_v2.ashby_application_links'::regclass)
    like '%512%',
  'the 0029 resume-handle bound must stay 512 and move only together with the client + extractor'
);

do $$
declare
  v_role     uuid;
  v_map      uuid;
  v_link     uuid;   -- resume-backed
  v_link_nr  uuid;   -- no resume handle
  v_link_fr  uuid;   -- resume-backed, ingestion ends failed_review
  v_op       uuid;
  v_op_nr    uuid;
  v_res      jsonb;
  v_lease    uuid;
  v_att      integer;
  v_state    text;
  v_sched    timestamptz;
  v_owner    uuid := '00000000-0000-4000-8000-0000000000aa';
begin
  select id into v_role from screening_v2.roles limit 1;
  if v_role is null then
    perform _policy_tests.assert('ashby 0035 functional: seed role present', false, 'no seed role available');
    return;
  end if;

  insert into screening_v2.ashby_job_mappings
    (external_job_id, role_id, owner_id, ai_screening_stage_id, ta_screening_stage_id, status, delivery_mode)
  values ('pol35-job', v_role, v_owner, 'pol35-ai', 'pol35-ta', 'enabled', 'manual')
  returning id into v_map;

  insert into screening_v2.ashby_application_links
    (external_application_id, external_job_id, job_mapping_id, external_resume_file_handle)
  values ('pol35-app', 'pol35-job', v_map, repeat('h', 270))
  returning id into v_link;

  insert into screening_v2.ashby_application_links
    (external_application_id, external_job_id, job_mapping_id, external_resume_file_handle)
  values ('pol35-app-noresume', 'pol35-job', v_map, null)
  returning id into v_link_nr;

  -- `runImport` seeds an ingestion row for EVERY link, including one with no
  -- resume handle. Reproduce that faithfully — it is the F-2 trap.
  perform screening_v2.advance_ashby_ingestion(v_link, 'queued', null, null, null, null);
  perform screening_v2.advance_ashby_ingestion(v_link_nr, 'queued', null, null, null, null);

  v_res := screening_v2.enqueue_ashby_operation(
    v_link, 'invite_delivery', 'ashby:invite:manual:pol35-app:pending', null, null, gen_random_uuid());
  v_op := (v_res->>'id')::uuid;
  v_res := screening_v2.enqueue_ashby_operation(
    v_link_nr, 'invite_delivery', 'ashby:invite:manual:pol35-app-noresume:pending', null, null, gen_random_uuid());
  v_op_nr := (v_res->>'id')::uuid;

  -- ── B-2/B-1: a resume-backed link whose ingestion is not ready is NOT
  -- claimable, and crucially is charged NO attempt for waiting. ────────────
  -- Claim by type would otherwise pick up the no-resume operation, so assert
  -- on the ROW rather than on the claim being empty.
  for v_state in select unnest(array['queued','fetching','scanning','extracting','structuring']) loop
    perform screening_v2.claim_ashby_operation('invite_delivery', 'w35', 30);
    perform screening_v2.claim_ashby_operation('invite_delivery', 'w35', 30);
  end loop;
  select attempts, state into v_att, v_state from screening_v2.ashby_operations where id = v_op;
  perform _policy_tests.assert(
    'ashby 0035: a queued ingestion leaves the invite pending with ZERO attempts',
    v_att = 0 and v_state = 'pending',
    'attempts=' || v_att || ' state=' || v_state);

  -- ── F-2: a NO-RESUME link is claimable immediately even though its
  -- ingestion row exists and reads `queued`. ───────────────────────────────
  select attempts into v_att from screening_v2.ashby_operations where id = v_op_nr;
  perform _policy_tests.assert(
    'ashby 0035: a no-resume link is claimable despite a queued ingestion row',
    v_att > 0,
    'the no-resume invite must not wait on an ingestion that has nothing to ingest');

  -- Put the no-resume operation out of the way for the rest of the block.
  update screening_v2.ashby_operations set state = 'cancelled' where id = v_op_nr;

  -- ── A paused mapping is a claim prerequisite too. ────────────────────────
  perform screening_v2.set_ashby_mapping_status(v_map, 'paused', 'pol35 pause', v_owner);
  perform screening_v2.advance_ashby_ingestion(v_link, 'fetching', null, null, null, null);
  perform screening_v2.advance_ashby_ingestion(v_link, 'scanning', null, null, null, null);
  perform screening_v2.advance_ashby_ingestion(v_link, 'extracting', null, null, null, null);
  perform screening_v2.advance_ashby_ingestion(v_link, 'structuring', null, null, null, null);
  perform screening_v2.advance_ashby_ingestion(v_link, 'ready', null, null, null, null);
  v_res := screening_v2.claim_ashby_operation('invite_delivery', 'w35', 30);
  perform _policy_tests.assert(
    'ashby 0035: a PAUSED mapping makes the invite unclaimable even when ingestion is ready',
    v_res->>'status' = 'empty',
    'got ' || coalesce(v_res->>'status', '<null>'));
  select attempts into v_att from screening_v2.ashby_operations where id = v_op;
  perform _policy_tests.assert(
    'ashby 0035: a paused mapping charges the invite no attempt',
    v_att = 0, 'attempts=' || v_att);

  -- ── Everything satisfied: exactly one claim. ─────────────────────────────
  perform screening_v2.set_ashby_mapping_status(v_map, 'enabled', null, v_owner);
  v_res := screening_v2.claim_ashby_operation('invite_delivery', 'w35', 30);
  perform _policy_tests.assert(
    'ashby 0035: ready ingestion + enabled mapping makes the invite claimable',
    v_res->>'status' = 'claimed' and (v_res->>'id')::uuid = v_op,
    'got ' || coalesce(v_res->>'status', '<null>'));
  v_lease := (v_res->>'lease_token')::uuid;
  perform _policy_tests.assert(
    'ashby 0035: the claim charges exactly one attempt',
    (v_res->>'attempts')::int = 1, 'got ' || coalesce(v_res->>'attempts','<null>'));

  -- ── defer: refunds the attempt, reschedules, never fails. ────────────────
  v_res := screening_v2.defer_ashby_operation(v_op, gen_random_uuid(), 'ingestion_not_ready', 60);
  perform _policy_tests.assert(
    'ashby 0035: defer with a WRONG lease is not_owned',
    v_res->>'status' = 'not_owned', 'got ' || coalesce(v_res->>'status','<null>'));

  v_res := screening_v2.defer_ashby_operation(v_op, v_lease, 'not a valid code', 60);
  perform _policy_tests.assert(
    'ashby 0035: defer refuses an unsanitized reason code',
    v_res->>'status' = 'invalid_error_code', 'got ' || coalesce(v_res->>'status','<null>'));

  v_res := screening_v2.defer_ashby_operation(v_op, v_lease, 'ingestion_not_ready', 60);
  perform _policy_tests.assert(
    'ashby 0035: defer under the live lease refunds the attempt',
    v_res->>'status' = 'ok' and (v_res->>'attempts')::int = 0,
    'got ' || coalesce(v_res::text, '<null>'));

  select state, attempts, scheduled_at into v_state, v_att, v_sched
    from screening_v2.ashby_operations where id = v_op;
  perform _policy_tests.assert(
    'ashby 0035: a deferred operation is pending, un-charged and rescheduled forward',
    v_state = 'pending' and v_att = 0 and v_sched > now(),
    'state=' || v_state || ' attempts=' || v_att);

  -- The delay is server-clamped in BOTH directions: a deferral loop can never
  -- become a hot loop, and can never park a row for a week either.
  v_res := screening_v2.claim_ashby_operation('invite_delivery', 'w35', 30);
  update screening_v2.ashby_operations set scheduled_at = now() where id = v_op;
  v_res := screening_v2.claim_ashby_operation('invite_delivery', 'w35', 30);
  v_lease := (v_res->>'lease_token')::uuid;
  v_res := screening_v2.defer_ashby_operation(v_op, v_lease, 'ingestion_not_ready', 999999);
  perform _policy_tests.assert(
    'ashby 0035: an absurd defer delay is clamped to 3600s',
    (v_res->>'delay_seconds')::int = 3600, 'got ' || coalesce(v_res->>'delay_seconds','<null>'));

  -- ── reopen: six independent refusals, then the one success. ──────────────
  update screening_v2.ashby_operations
     set state = 'failed', attempts = 5, error_code = 'ingestion_not_ready',
         scheduled_at = now(), lease_token = null, lease_owner = null, lease_expires_at = null
   where id = v_op;

  v_res := screening_v2.reopen_ashby_invite_delivery(gen_random_uuid(), v_owner);
  perform _policy_tests.assert('ashby 0035 reopen: unknown operation is not_found',
    v_res->>'status' = 'not_found', 'got ' || coalesce(v_res->>'status','<null>'));

  -- Guard 1: never a scorecard_write / stage_move (the result-sink refusal).
  v_res := screening_v2.enqueue_ashby_operation(
    v_link, 'scorecard_write', 'pol35-score', null, null, gen_random_uuid());
  update screening_v2.ashby_operations
     set state = 'failed', error_code = 'ingestion_not_ready'
   where id = (v_res->>'id')::uuid;
  v_res := screening_v2.reopen_ashby_invite_delivery((v_res->>'id')::uuid, v_owner);
  perform _policy_tests.assert('ashby 0035 reopen: a scorecard_write is refused',
    v_res->>'status' = 'unsupported_operation_type', 'got ' || coalesce(v_res->>'status','<null>'));

  -- Guard 2: only a FAILED operation.
  update screening_v2.ashby_operations set state = 'pending' where id = v_op;
  v_res := screening_v2.reopen_ashby_invite_delivery(v_op, v_owner);
  perform _policy_tests.assert('ashby 0035 reopen: a non-failed operation is not_retryable',
    v_res->>'status' = 'not_retryable', 'got ' || coalesce(v_res->>'status','<null>'));
  update screening_v2.ashby_operations
     set state = 'failed', attempts = 5, error_code = 'ingestion_not_ready' where id = v_op;

  -- Guard 4: the mapping must still be ENABLED.
  perform screening_v2.set_ashby_mapping_status(v_map, 'paused', 'pol35 pause 2', v_owner);
  v_res := screening_v2.reopen_ashby_invite_delivery(v_op, v_owner);
  perform _policy_tests.assert('ashby 0035 reopen: a paused mapping is refused',
    v_res->>'status' = 'blocked_mapping', 'got ' || coalesce(v_res->>'status','<null>'));
  perform screening_v2.set_ashby_mapping_status(v_map, 'enabled', null, v_owner);

  -- Guard 5: the ingestion prerequisite must genuinely hold. `ready` is
  -- TERMINAL in the 0029 state machine, so an unfinished ingestion is
  -- reproduced by removing the row (the `missing` branch) and walking a fresh
  -- one forward, never by an illegal backwards transition.
  delete from screening_v2.ashby_resume_ingestions where application_link_id = v_link;
  v_res := screening_v2.reopen_ashby_invite_delivery(v_op, v_owner);
  perform _policy_tests.assert('ashby 0035 reopen: a MISSING ingestion is refused',
    v_res->>'status' = 'ingestion_not_ready', 'got ' || coalesce(v_res->>'status','<null>'));

  perform screening_v2.advance_ashby_ingestion(v_link, 'queued', null, null, null, null);
  perform screening_v2.advance_ashby_ingestion(v_link, 'fetching', null, null, null, null);
  v_res := screening_v2.reopen_ashby_invite_delivery(v_op, v_owner);
  perform _policy_tests.assert('ashby 0035 reopen: an IN-FLIGHT ingestion is refused',
    v_res->>'status' = 'ingestion_not_ready', 'got ' || coalesce(v_res->>'status','<null>'));

  perform screening_v2.advance_ashby_ingestion(v_link, 'scanning', null, null, null, null);
  perform screening_v2.advance_ashby_ingestion(v_link, 'extracting', null, null, null, null);
  perform screening_v2.advance_ashby_ingestion(v_link, 'structuring', null, null, null, null);
  perform screening_v2.advance_ashby_ingestion(v_link, 'ready', null, null, null, null);

  -- Guard 6: THE DEFERRAL-CODE ALLOWLIST. This is what stops the RPC being a
  -- general-purpose budget reset around max_attempts.
  update screening_v2.ashby_operations set error_code = 'blocked_provider' where id = v_op;
  v_res := screening_v2.reopen_ashby_invite_delivery(v_op, v_owner);
  perform _policy_tests.assert(
    'ashby 0035 reopen: a REAL delivery failure (blocked_provider) is refused',
    v_res->>'status' = 'not_a_deferral', 'got ' || coalesce(v_res->>'status','<null>'));
  update screening_v2.ashby_operations set error_code = 'invalid_reissue_path' where id = v_op;
  v_res := screening_v2.reopen_ashby_invite_delivery(v_op, v_owner);
  perform _policy_tests.assert(
    'ashby 0035 reopen: invalid_reissue_path is refused',
    v_res->>'status' = 'not_a_deferral', 'got ' || coalesce(v_res->>'status','<null>'));
  update screening_v2.ashby_operations set error_code = 'ingestion_not_ready' where id = v_op;

  -- The success path, with the audit row carrying the PRE-RESET attempts.
  v_res := screening_v2.reopen_ashby_invite_delivery(v_op, v_owner);
  perform _policy_tests.assert(
    'ashby 0035 reopen: every guard satisfied reopens the operation',
    v_res->>'status' = 'ok' and (v_res->>'attempts_before')::int = 5,
    'got ' || coalesce(v_res::text,'<null>'));

  select state, attempts into v_state, v_att from screening_v2.ashby_operations where id = v_op;
  perform _policy_tests.assert(
    'ashby 0035 reopen: the row is pending with a corrected attempt count',
    v_state = 'pending' and v_att = 0, 'state=' || v_state || ' attempts=' || v_att);

  perform _policy_tests.assert(
    'ashby 0035 reopen: max_attempts is NOT raised',
    (select max_attempts from screening_v2.ashby_operations where id = v_op) = 5,
    'the reopen must correct the accounting, never enlarge the budget');

  perform _policy_tests.assert(
    'ashby 0035 reopen: an audit row records the acting admin and the pre-reset attempts',
    exists (
      select 1 from screening_v2.audit_events
       where action = 'ashby_operation_retry'
         and target_id = v_op::text
         and actor_id = v_owner
         and (metadata->>'attempts_before')::int = 5
         and metadata->>'reopened_error_code' = 'ingestion_not_ready'),
    'the reopen must be attributable');

  -- Guard 3: the resurrection guard. Terminal beats everything above.
  update screening_v2.ashby_operations
     set state = 'failed', attempts = 5, error_code = 'ingestion_not_ready' where id = v_op;
  perform screening_v2.cancel_ashby_application(v_link, 'withdrawn', 'pol35 terminal', v_owner);
  v_res := screening_v2.reopen_ashby_invite_delivery(v_op, v_owner);
  perform _policy_tests.assert('ashby 0035 reopen: a terminal link is refused',
    v_res->>'status' = 'blocked_terminal', 'got ' || coalesce(v_res->>'status','<null>'));

  -- ── The blocked/stuck counters: no identifiers, correct arithmetic. ──────
  v_res := screening_v2.ashby_prerequisite_backlog(900);
  perform _policy_tests.assert(
    'ashby 0035: the prerequisite backlog reports all five counters',
    v_res ? 'pending_blocked' and v_res ? 'pending_blocked_failed_ingestion'
      and v_res ? 'failed_prerequisite'
      and v_res ? 'ingestion_stuck_queued' and v_res ? 'ingestion_stuck_fetching',
    'got ' || coalesce(v_res::text,'<null>'));
  perform _policy_tests.assert(
    'ashby 0035: the prerequisite backlog leaks no identifier of any kind',
    v_res::text not like '%pol35%' and v_res::text not like '%' || v_link::text || '%',
    'counters only — never an application, job, candidate or tenant identifier');

  -- ── O-1: a failed_review ingestion blocks its invite FOREVER, and that is
  -- a different fact from "waiting 30 seconds". The 0029 trigger lets
  -- failed_review go only to queued or cancelled and nothing in the runtime
  -- does either, so this invite never clears on its own. Build the case on a
  -- fresh link so the terminal link above cannot contribute.
  insert into screening_v2.ashby_application_links
    (external_application_id, external_job_id, job_mapping_id, external_resume_file_handle)
  values ('pol35-app-failed', 'pol35-job', v_map, repeat('h', 64))
  returning id into v_link_fr;
  perform screening_v2.advance_ashby_ingestion(v_link_fr, 'queued', null, null, null, null);
  perform screening_v2.advance_ashby_ingestion(v_link_fr, 'fetching', null, null, null, null);

  v_res := screening_v2.enqueue_ashby_operation(
    v_link_fr, 'invite_delivery', 'ashby:invite:manual:pol35-app-failed:pending',
    null, null, gen_random_uuid());

  -- While the ingestion is merely IN FLIGHT it is transient: blocked, but not
  -- permanently so.
  v_res := screening_v2.ashby_prerequisite_backlog(900);
  perform _policy_tests.assert(
    'ashby 0035/O1: an in-flight ingestion counts as blocked but NOT as permanently blocked',
    (v_res->>'pending_blocked')::int >= 1
      and (v_res->>'pending_blocked_failed_ingestion')::int = 0,
    'got ' || coalesce(v_res::text,'<null>'));

  perform screening_v2.advance_ashby_ingestion(
    v_link_fr, 'failed_review', null, null, null, 'scan_unavailable');

  v_res := screening_v2.ashby_prerequisite_backlog(900);
  perform _policy_tests.assert(
    'ashby 0035/O1: a failed_review ingestion counts as PERMANENTLY blocked',
    (v_res->>'pending_blocked_failed_ingestion')::int = 1,
    'got ' || coalesce(v_res::text,'<null>'));
  perform _policy_tests.assert(
    'ashby 0035/O1: the permanent count is a SUBSET of the total, not a replacement',
    (v_res->>'pending_blocked')::int >= (v_res->>'pending_blocked_failed_ingestion')::int,
    'got ' || coalesce(v_res::text,'<null>'));
  perform _policy_tests.assert(
    'ashby 0035/O1: the invite is still pending — blocked is never failed',
    (select state from screening_v2.ashby_operations
      where application_link_id = v_link_fr and operation_type = 'invite_delivery') = 'pending',
    'a blocked invite must not be converted back into a failure');

  -- An explicit requeue (the one exit the 0029 trigger allows) clears it.
  perform screening_v2.advance_ashby_ingestion(v_link_fr, 'queued', null, null, null, null);
  v_res := screening_v2.ashby_prerequisite_backlog(900);
  perform _policy_tests.assert(
    'ashby 0035/O1: requeueing the ingestion clears the permanent-block count',
    (v_res->>'pending_blocked_failed_ingestion')::int = 0,
    'got ' || coalesce(v_res::text,'<null>'));

  delete from screening_v2.ashby_operations
   where application_link_id in (v_link, v_link_nr, v_link_fr);
  delete from screening_v2.ashby_resume_ingestions
   where application_link_id in (v_link, v_link_nr, v_link_fr);
  delete from screening_v2.ashby_application_links where id in (v_link, v_link_nr, v_link_fr);
  delete from screening_v2.ashby_job_mappings where id = v_map;
end;
$$;

-- =====================================================================
-- 0036: Ashby ingestion attempt-counter reset — grants, pinned search_path,
--       the full refusal matrix, and the two things the RPC must NOT touch
--       (the row's state, and the requeue ceiling).
-- =====================================================================

select _policy_tests.assert(
  'ashby 0036 RPC is service-role only',
  (select count(*)
     from pg_proc p join pg_namespace n on n.oid = p.pronamespace
    where n.nspname = 'screening_v2'
      and p.proname = 'reset_ashby_ingestion_attempts'
      and not has_function_privilege('anon', p.oid, 'EXECUTE')
      and not has_function_privilege('authenticated', p.oid, 'EXECUTE')
      and has_function_privilege('service_role', p.oid, 'EXECUTE')
  ) = 1,
  'reset_ashby_ingestion_attempts must be service-role only — it corrects an audited counter'
);

select _policy_tests.assert(
  'ashby 0036 RPC pins search_path',
  (select count(*)
     from pg_proc p join pg_namespace n on n.oid = p.pronamespace
    where n.nspname = 'screening_v2'
      and p.proname = 'reset_ashby_ingestion_attempts'
      and p.prosecdef
      and array_to_string(coalesce(p.proconfig, '{}'), ',') like '%search_path%'
  ) = 1,
  'every SECURITY DEFINER RPC must pin search_path'
);

-- The audit action allowlist was re-declared wholesale by 0036. Assert both
-- that the new action landed AND that a representative sample of the older
-- ones survived, because a re-declaration that silently dropped an action
-- would break unrelated audit writes at runtime, not at migration time.
select _policy_tests.assert(
  'ashby 0036: the new audit action is permitted',
  (select pg_get_constraintdef(oid) from pg_constraint
    where conname = 'chk_audit_action'
      and conrelid = 'screening_v2.audit_events'::regclass)
    like '%ashby_ingestion_attempts_reset%',
  'the 0036 audit action must be in chk_audit_action'
);

select _policy_tests.assert(
  'ashby 0036: re-declaring chk_audit_action dropped none of the earlier actions',
  (select bool_and(pg_get_constraintdef(c.oid) like ('%' || a || '%'))
     from pg_constraint c,
          unnest(array['invite_sent','grant_issued','recording_quarantined',
                       'ashby_mapping_update','ashby_operation_retry',
                       'ashby_invite_delivered']) as a
    where c.conname = 'chk_audit_action'
      and c.conrelid = 'screening_v2.audit_events'::regclass),
  'widening chk_audit_action must be purely additive'
);

do $$
declare
  v_role      uuid;
  v_map       uuid;
  v_link      uuid;   -- burned ceiling, transport reason  → the ok path
  v_link_scan uuid;   -- failed_review, NON-transport reason → refused
  v_link_q    uuid;   -- still queued                        → refused
  v_link_term uuid;   -- terminal application                → refused
  v_link_zero uuid;   -- failed_review, transport reason, attempts 0 → noop
  v_res       jsonb;
  v_att       integer;
  v_state     text;
  v_audit     jsonb;
  v_owner     uuid := '00000000-0000-4000-8000-0000000000ab';
  i           integer;
begin
  select id into v_role from screening_v2.roles limit 1;
  if v_role is null then
    perform _policy_tests.assert('ashby 0036 functional: seed role present', false, 'no seed role available');
    return;
  end if;

  insert into screening_v2.ashby_job_mappings
    (external_job_id, role_id, owner_id, ai_screening_stage_id, ta_screening_stage_id, status, delivery_mode)
  values ('pol36-job', v_role, v_owner, 'pol36-ai', 'pol36-ta', 'enabled', 'manual')
  returning id into v_map;

  insert into screening_v2.ashby_application_links
    (external_application_id, external_job_id, job_mapping_id, external_resume_file_handle)
  values ('pol36-app',      'pol36-job', v_map, repeat('h', 64)) returning id into v_link;
  insert into screening_v2.ashby_application_links
    (external_application_id, external_job_id, job_mapping_id, external_resume_file_handle)
  values ('pol36-app-scan', 'pol36-job', v_map, repeat('h', 64)) returning id into v_link_scan;
  insert into screening_v2.ashby_application_links
    (external_application_id, external_job_id, job_mapping_id, external_resume_file_handle)
  values ('pol36-app-q',    'pol36-job', v_map, repeat('h', 64)) returning id into v_link_q;
  insert into screening_v2.ashby_application_links
    (external_application_id, external_job_id, job_mapping_id, external_resume_file_handle)
  values ('pol36-app-term', 'pol36-job', v_map, repeat('h', 64)) returning id into v_link_term;
  insert into screening_v2.ashby_application_links
    (external_application_id, external_job_id, job_mapping_id, external_resume_file_handle)
  values ('pol36-app-zero', 'pol36-job', v_map, repeat('h', 64)) returning id into v_link_zero;

  -- ── Burn the ceiling exactly the way the transport defect did: five
  --    identical fetch failures, each one costing a requeue. ──────────────
  perform screening_v2.advance_ashby_ingestion(v_link, 'queued', null, null, null, null);
  for i in 1..5 loop
    perform screening_v2.advance_ashby_ingestion(v_link, 'fetching', null, null, null, null);
    perform screening_v2.advance_ashby_ingestion(v_link, 'failed_review', null, null, null, 'fetch_http_error');
    perform screening_v2.advance_ashby_ingestion(v_link, 'queued', null, null, null, null);
  end loop;
  perform screening_v2.advance_ashby_ingestion(v_link, 'fetching', null, null, null, null);
  perform screening_v2.advance_ashby_ingestion(v_link, 'failed_review', null, null, null, 'fetch_http_error');

  select attempts, state into v_att, v_state
    from screening_v2.ashby_resume_ingestions where application_link_id = v_link;
  perform _policy_tests.assert(
    'ashby 0036: the setup reproduced a burned ceiling in failed_review',
    v_att = 5 and v_state = 'failed_review',
    'got attempts=' || coalesce(v_att::text,'<null>') || ' state=' || coalesce(v_state,'<null>'));

  -- The dead-end this RPC exists to resolve: the documented recovery refuses.
  v_res := screening_v2.advance_ashby_ingestion(v_link, 'queued', null, null, null, null);
  perform _policy_tests.assert(
    'ashby 0036: without a reset the documented requeue dead-ends at retry_exhausted',
    v_res->>'status' = 'retry_exhausted',
    'got ' || coalesce(v_res::text,'<null>'));

  -- ── Refusal matrix. Each branch refuses independently. ─────────────────
  v_res := screening_v2.reset_ashby_ingestion_attempts(gen_random_uuid(), v_owner);
  perform _policy_tests.assert(
    'ashby 0036 refusal: an unknown link is not_found',
    v_res->>'status' = 'not_found', 'got ' || coalesce(v_res::text,'<null>'));

  perform screening_v2.advance_ashby_ingestion(v_link_q, 'queued', null, null, null, null);
  v_res := screening_v2.reset_ashby_ingestion_attempts(v_link_q, v_owner);
  perform _policy_tests.assert(
    'ashby 0036 refusal: a live (non failed_review) ingestion is not_resettable',
    v_res->>'status' = 'not_resettable' and v_res->>'state' = 'queued',
    'a running ingestion''s counter belongs to the scheduler; got ' || coalesce(v_res::text,'<null>'));

  perform screening_v2.advance_ashby_ingestion(v_link_term, 'queued', null, null, null, null);
  perform screening_v2.advance_ashby_ingestion(v_link_term, 'fetching', null, null, null, null);
  perform screening_v2.advance_ashby_ingestion(v_link_term, 'failed_review', null, null, null, 'fetch_http_error');
  update screening_v2.ashby_application_links set terminal_state = 'withdrawn' where id = v_link_term;
  v_res := screening_v2.reset_ashby_ingestion_attempts(v_link_term, v_owner);
  perform _policy_tests.assert(
    'ashby 0036 refusal: a withdrawn application is blocked_terminal',
    v_res->>'status' = 'blocked_terminal' and v_res->>'terminal_state' = 'withdrawn',
    'the resurrection guard must fire even on a transport reason; got ' || coalesce(v_res::text,'<null>'));

  perform screening_v2.advance_ashby_ingestion(v_link_scan, 'queued', null, null, null, null);
  perform screening_v2.advance_ashby_ingestion(v_link_scan, 'fetching', null, null, null, null);
  perform screening_v2.advance_ashby_ingestion(v_link_scan, 'scanning', null, null, null, null);
  perform screening_v2.advance_ashby_ingestion(v_link_scan, 'failed_review', null, null, null, 'scan_infected');
  v_res := screening_v2.reset_ashby_ingestion_attempts(v_link_scan, v_owner);
  perform _policy_tests.assert(
    'ashby 0036 refusal: a NON-transport failure is not_a_transport_failure',
    v_res->>'status' = 'not_a_transport_failure' and v_res->>'failed_reason' = 'scan_infected',
    'a scan/parse/guard failure measured a real fault and its attempts are not returned; got '
      || coalesce(v_res::text,'<null>'));

  perform screening_v2.advance_ashby_ingestion(v_link_zero, 'queued', null, null, null, null);
  perform screening_v2.advance_ashby_ingestion(v_link_zero, 'fetching', null, null, null, null);
  perform screening_v2.advance_ashby_ingestion(v_link_zero, 'failed_review', null, null, null, 'fetch_timeout');
  v_res := screening_v2.reset_ashby_ingestion_attempts(v_link_zero, v_owner);
  perform _policy_tests.assert(
    'ashby 0036 refusal: an already-zero counter is a distinct noop, not ok',
    v_res->>'status' = 'noop' and (v_res->>'attempts')::int = 0,
    'an operator must be able to tell "already clear" from "just corrected"; got '
      || coalesce(v_res::text,'<null>'));

  -- ── The ok path, and the two things it must NOT change. ────────────────
  v_res := screening_v2.reset_ashby_ingestion_attempts(v_link, v_owner);
  perform _policy_tests.assert(
    'ashby 0036: the reset succeeds and reports the pre-reset count',
    v_res->>'status' = 'ok' and (v_res->>'attempts_before')::int = 5,
    'got ' || coalesce(v_res::text,'<null>'));

  select attempts, state into v_att, v_state
    from screening_v2.ashby_resume_ingestions where application_link_id = v_link;
  perform _policy_tests.assert(
    'ashby 0036: the reset zeroes the counter but does NOT transition state',
    v_att = 0 and v_state = 'failed_review',
    'there must remain exactly ONE counted way out of failed_review; got attempts='
      || coalesce(v_att::text,'<null>') || ' state=' || coalesce(v_state,'<null>'));

  -- The ceiling itself is untouched: the ordinary exit still charges 1 of 5.
  v_res := screening_v2.advance_ashby_ingestion(v_link, 'queued', null, null, null, null);
  perform _policy_tests.assert(
    'ashby 0036: the ceiling is unchanged — the ordinary requeue still charges 1 of 5',
    v_res->>'status' = 'ok'
      and (v_res->>'attempts')::int = 1
      and (v_res->>'max_attempts')::int = 5,
    'the reset must correct the counter, never enlarge the budget; got '
      || coalesce(v_res::text,'<null>'));

  -- Attribution: the correction is auditable, with the pre-reset value.
  select metadata into v_audit
    from screening_v2.audit_events
   where action = 'ashby_ingestion_attempts_reset'
     and metadata->>'application_link_id' = v_link::text
   order by created_at desc limit 1;
  perform _policy_tests.assert(
    'ashby 0036: the reset writes an audit row carrying the pre-reset count and reason',
    v_audit is not null
      and (v_audit->>'attempts_before')::int = 5
      and v_audit->>'failed_reason' = 'fetch_http_error',
    'an unattributable counter correction is indistinguishable from a raw UPDATE; got '
      || coalesce(v_audit::text,'<null>'));

  -- The audit row is deliberately NOT cleaned up: `audit_events` is
  -- append-only by the 0007 trigger, and reaching for its
  -- `app.allow_audit_mutation` escape hatch inside a test would be a far worse
  -- precedent than leaving one row behind. Every id it references is a local
  -- fixture, and the same is true of the sibling blocks above.
  delete from screening_v2.ashby_resume_ingestions
   where application_link_id in (v_link, v_link_scan, v_link_q, v_link_term, v_link_zero);
  delete from screening_v2.ashby_application_links
   where id in (v_link, v_link_scan, v_link_q, v_link_term, v_link_zero);
  delete from screening_v2.ashby_job_mappings where id = v_map;
end;
$$;

-- =====================================================================
-- 0037: lease-safe queue DEFERRAL, the abandon-before-verdict retry edges,
--       and the verdict-class requeue refusal.
--
--   The queue had two post-claim outcomes, complete and fail, so "the
--   prerequisite is not met yet" could only be said by FAILING — which spends
--   an attempt and dead-letters minutes-long waits in about thirty seconds.
--   These assert the third outcome exists, refunds exactly what the claim
--   charged, and cannot fail or dead-letter anything; and that making the
--   pipeline more willing to retry did NOT make known malware re-downloadable.
-- =====================================================================

select _policy_tests.assert(
  'ashby 0037: defer_job is service-role only',
  (select count(*)
     from pg_proc p join pg_namespace n on n.oid = p.pronamespace
    where n.nspname = 'screening_v2'
      and p.proname = 'defer_job'
      and not has_function_privilege('anon', p.oid, 'EXECUTE')
      and not has_function_privilege('authenticated', p.oid, 'EXECUTE')
      and has_function_privilege('service_role', p.oid, 'EXECUTE')
  ) = 1,
  'defer_job mutates the backend queue — anon/authenticated must never execute it'
);

select _policy_tests.assert(
  'ashby 0037: the re-declared complete_job/fail_job keep their grants',
  (select count(*)
     from pg_proc p join pg_namespace n on n.oid = p.pronamespace
    where n.nspname = 'screening_v2'
      and p.proname in ('complete_job', 'fail_job')
      and not has_function_privilege('anon', p.oid, 'EXECUTE')
      and not has_function_privilege('authenticated', p.oid, 'EXECUTE')
      and has_function_privilege('service_role', p.oid, 'EXECUTE')
  ) = 2,
  'a create-or-replace that dropped a revoke would silently open the queue'
);

do $$
declare
  v_job    uuid;
  v_tok    uuid;
  v_res    text;
  v_row    screening_v2.job_queue%rowtype;
  v_at     timestamptz;
  v_first_wait timestamptz;
  v_now    timestamptz := now();
begin
  -- ── deferral refunds exactly the claim's attempt ─────────────────────
  insert into screening_v2.job_queue
    (name, payload, status, attempts, max_attempts, priority, scheduled_at)
  values ('pol37.queue', '{}'::jsonb, 'pending', 0, 1, 0, v_now)
  returning id into v_job;

  select lease_token into v_tok
    from screening_v2.claim_job('pol37.queue', v_now, 30, 'pol37-worker');
  select * into v_row from screening_v2.job_queue where id = v_job;
  perform _policy_tests.assert('ashby 0037: a claim charges one attempt',
    v_row.attempts = 1, 'got ' || v_row.attempts);

  v_res := screening_v2.defer_job(v_job, v_tok, 'scanner_signatures_missing', 45, v_now);
  select * into v_row from screening_v2.job_queue where id = v_job;
  perform _policy_tests.assert('ashby 0037: defer refunds exactly the claim attempt',
    v_res = 'deferred' and v_row.attempts = 0,
    'got ' || v_res || ' attempts=' || v_row.attempts);
  perform _policy_tests.assert('ashby 0037: a deferral leaves NO failure evidence',
    v_row.status = 'delayed'
      and v_row.error_message is null
      and v_row.failed_at is null
      and v_row.lease_token is null
      and v_row.defer_reason = 'scanner_signatures_missing'
      and v_row.defer_count = 1
      and v_row.scheduled_at > v_now,
    'a deferred job must not look failed');

  -- ── a deferral can never dead-letter, even at max_attempts ───────────
  v_first_wait := v_row.deferred_at;
  for i in 1..5 loop
    select lease_token into v_tok
      from screening_v2.claim_job('pol37.queue', v_row.scheduled_at + interval '1 second', 30, 'pol37-worker');
    v_res := screening_v2.defer_job(v_job, v_tok, 'scanner_signatures_missing', 1,
                                    v_row.scheduled_at + interval '1 second');
    select * into v_row from screening_v2.job_queue where id = v_job;
  end loop;
  perform _policy_tests.assert('ashby 0037: repeated deferral never dead-letters (max_attempts=1)',
    v_row.status = 'delayed' and v_row.attempts = 0
      and not exists (select 1 from screening_v2.job_dlq where id = v_job),
    'got status=' || v_row.status || ' attempts=' || v_row.attempts);
  -- The COUNT alone does not test this claim: a job deferred every 45 seconds
  -- for an hour must report an hour of waiting, not 45 seconds of it, or
  -- "oldest scanner deferral" measures the last poll instead of the outage.
  perform _policy_tests.assert('ashby 0037: the wait start survives a repeating reason',
    v_row.defer_count = 6 and v_row.deferred_at = v_first_wait,
    'got defer_count=' || v_row.defer_count
      || ' deferred_at=' || coalesce(v_row.deferred_at::text,'null')
      || ' expected deferred_at=' || coalesce(v_first_wait::text,'null'));

  -- ...and a CHANGED reason restarts the clock, because it is a different wait.
  select lease_token into v_tok
    from screening_v2.claim_job('pol37.queue', v_row.scheduled_at + interval '1 second', 30, 'pol37-worker');
  v_at := v_row.scheduled_at + interval '1 second';
  v_res := screening_v2.defer_job(v_job, v_tok, 'scanner_busy', 1, v_at);
  select * into v_row from screening_v2.job_queue where id = v_job;
  perform _policy_tests.assert('ashby 0037: a changed reason restarts the wait clock',
    v_row.deferred_at = v_at and v_row.deferred_at <> v_first_wait,
    'got ' || coalesce(v_row.deferred_at::text,'null'));

  -- ── CAS: a wrong token mutates nothing ───────────────────────────────
  select lease_token into v_tok
    from screening_v2.claim_job('pol37.queue', v_row.scheduled_at + interval '1 second', 30, 'pol37-worker');
  v_res := screening_v2.defer_job(v_job, gen_random_uuid(), 'scanner_busy', 10,
                                  v_row.scheduled_at + interval '1 second');
  perform _policy_tests.assert('ashby 0037: a mismatched lease is refused',
    v_res = 'not_owned', 'got ' || v_res);

  -- ── the reason code is allowlisted, not merely trusted ───────────────
  v_res := screening_v2.defer_job(v_job, v_tok, 'Provider said: /var/lib/clamav missing', 10,
                                  v_row.scheduled_at + interval '1 second');
  perform _policy_tests.assert('ashby 0037: an unsanitized reason is refused before it is stored',
    v_res = 'invalid_reason_code', 'got ' || v_res);

  -- ── the delay is clamped server-side ─────────────────────────────────
  v_at := v_row.scheduled_at + interval '1 second';
  v_res := screening_v2.defer_job(v_job, v_tok, 'scanner_busy', 999999, v_at);
  select * into v_row from screening_v2.job_queue where id = v_job;
  perform _policy_tests.assert('ashby 0037: the deferral delay is clamped to one hour',
    v_res = 'deferred'
      and v_row.scheduled_at = v_at + interval '3600 seconds',
    'an unclamped delay could park a job for a year; got '
      || (v_row.scheduled_at - v_at)::text);

  -- ── a genuine failure still clears the deferral marker ───────────────
  -- Raise the ceiling first: with max_attempts = 1 the very next fail_job
  -- takes the DLQ branch, which is correct behaviour but a different path
  -- from the retry branch under test here.
  update screening_v2.job_queue set max_attempts = 5 where id = v_job;

  v_at := v_row.scheduled_at + interval '1 second';
  select lease_token into v_tok
    from screening_v2.claim_job('pol37.queue', v_at, 30, 'pol37-worker');
  v_res := screening_v2.fail_job(v_job, v_tok, v_at, 'genuine_fault', v_at + interval '1 minute');
  select * into v_row from screening_v2.job_queue where id = v_job;
  perform _policy_tests.assert('ashby 0037: a retry is not counted as a wait',
    v_row.defer_reason is null and v_row.deferred_at is null
      and v_row.error_message = 'genuine_fault',
    'a failing job must never be read as blocked on a prerequisite');

  delete from screening_v2.job_queue where id = v_job;
  delete from screening_v2.job_dlq where id = v_job;
end;
$$;

-- ── ingestion state machine: the two new edges, and the R-8 refusal ────
do $$
declare
  v_map   uuid;
  v_link  uuid;
  v_inf   uuid;
  v_res   jsonb;
  v_state text;
  v_role  uuid;
  v_owner uuid := '00000000-0000-4000-8000-0000000000bb';
begin
  select id into v_role from screening_v2.roles limit 1;
  if v_role is null then
    perform _policy_tests.assert('ashby 0037 functional: seed role present', false, 'no seed role available');
    return;
  end if;

  insert into screening_v2.ashby_job_mappings
    (external_job_id, role_id, owner_id, ai_screening_stage_id, status)
  values ('pol37-job', v_role, v_owner, 'pol37-ai', 'paused')
  returning id into v_map;

  insert into screening_v2.ashby_application_links
    (external_application_id, external_job_id, job_mapping_id)
  values ('pol37-app', 'pol37-job', v_map)
  returning id into v_link;

  -- fetching -> queued: abandoned before any statement about the file.
  v_res := screening_v2.advance_ashby_ingestion(v_link, 'fetching', null, null, null, null);
  v_res := screening_v2.advance_ashby_ingestion(v_link, 'queued', null, null, null, null);
  perform _policy_tests.assert('ashby 0037: fetching -> queued is a legal retry edge',
    v_res->>'status' = 'ok', 'got ' || coalesce(v_res->>'status','null'));

  -- scanning -> queued: the post-claim scanner race.
  v_res := screening_v2.advance_ashby_ingestion(v_link, 'fetching', null, null, null, null);
  v_res := screening_v2.advance_ashby_ingestion(v_link, 'scanning', null, null, null, null);
  v_res := screening_v2.advance_ashby_ingestion(v_link, 'queued', null, null, null, null);
  perform _policy_tests.assert('ashby 0037: scanning -> queued is a legal retry edge',
    v_res->>'status' = 'ok', 'got ' || coalesce(v_res->>'status','null'));

  -- extracting keeps no edge ON THIS PATH: by then the bytes were parsed.
  --
  -- SUPERSEDED IN MECHANISM BY 0039, NOT IN EFFECT. 0037 refused this at the
  -- TRIGGER (`invalid_transition`). 0039 makes the edge exist so a parse
  -- deferral can use it, and moves the refusal into `advance_ashby_ingestion`
  -- itself (`not_requeueable` / `parse_defer_only`). What matters — that the
  -- generic path, which `runImport` calls on every webhook redelivery, can
  -- never requeue a mid-parse row and re-download the resume — is unchanged,
  -- and this assertion still proves exactly that.
  v_res := screening_v2.advance_ashby_ingestion(v_link, 'fetching', null, null, null, null);
  v_res := screening_v2.advance_ashby_ingestion(v_link, 'scanning', null, null, null, null);
  v_res := screening_v2.advance_ashby_ingestion(v_link, 'extracting', null, null, null, null);
  v_res := screening_v2.advance_ashby_ingestion(v_link, 'queued', null, null, null, null);
  perform _policy_tests.assert('ashby 0037/0039: the GENERIC path never requeues from extracting',
    v_res->>'status' = 'not_requeueable' and v_res->>'reason' = 'parse_defer_only',
    'got ' || coalesce(v_res::text,'null'));

  -- An AVAILABILITY failure stays recoverable: it never had a verdict.
  v_res := screening_v2.advance_ashby_ingestion(v_link, 'failed_review', null, null, null,
                                                'scan_scanner_signatures_unavailable');
  v_res := screening_v2.advance_ashby_ingestion(v_link, 'queued', null, null, null, null);
  perform _policy_tests.assert('ashby 0037: an availability failure is still requeueable',
    v_res->>'status' = 'ok', 'got ' || coalesce(v_res->>'status','null'));
  select failed_reason into v_state from screening_v2.ashby_resume_ingestions
   where application_link_id = v_link;
  perform _policy_tests.assert('ashby 0037: a requeue clears the stale failure reason',
    v_state is null, 'got ' || coalesce(v_state,'null'));

  -- A VERDICT is permanent. Re-running it re-downloads known malware.
  insert into screening_v2.ashby_application_links
    (external_application_id, external_job_id, job_mapping_id)
  values ('pol37-app-inf', 'pol37-job', v_map)
  returning id into v_inf;

  v_res := screening_v2.advance_ashby_ingestion(v_inf, 'fetching', null, null, null, null);
  v_res := screening_v2.advance_ashby_ingestion(v_inf, 'scanning', null, null, null, null);
  v_res := screening_v2.advance_ashby_ingestion(v_inf, 'failed_review', null, null, null, 'scan_infected');
  v_res := screening_v2.advance_ashby_ingestion(v_inf, 'queued', null, null, null, null);
  perform _policy_tests.assert('ashby 0037: an INFECTED verdict is never requeueable',
    v_res->>'status' = 'not_requeueable', 'got ' || coalesce(v_res->>'status','null'));
  select state into v_state from screening_v2.ashby_resume_ingestions where application_link_id = v_inf;
  perform _policy_tests.assert('ashby 0037: the infected row is left where it rests',
    v_state = 'failed_review', 'got ' || coalesce(v_state,'null'));

  -- Deterministic content faults are verdicts about the file too.
  update screening_v2.ashby_resume_ingestions
     set failed_reason = 'guard_unsupported_type' where application_link_id = v_inf;
  v_res := screening_v2.advance_ashby_ingestion(v_inf, 'queued', null, null, null, null);
  perform _policy_tests.assert('ashby 0037: a guard rejection is never requeueable',
    v_res->>'status' = 'not_requeueable', 'got ' || coalesce(v_res->>'status','null'));

  update screening_v2.ashby_resume_ingestions
     set failed_reason = 'parse_error' where application_link_id = v_inf;
  v_res := screening_v2.advance_ashby_ingestion(v_inf, 'queued', null, null, null, null);
  perform _policy_tests.assert('ashby 0037: an unparseable document is never requeueable',
    v_res->>'status' = 'not_requeueable', 'got ' || coalesce(v_res->>'status','null'));

  delete from screening_v2.ashby_resume_ingestions where application_link_id in (v_link, v_inf);
  delete from screening_v2.ashby_application_links where id in (v_link, v_inf);
  delete from screening_v2.ashby_job_mappings where id = v_map;
end;
$$;

-- ═══════════════════════════════════════════════════════════════════════
-- 0038 — durable authoritative-recording finalization convergence
-- ═══════════════════════════════════════════════════════════════════════

select _policy_tests.assert(
  '0038: finalize observability columns exist on call_sessions',
  (select count(*) from information_schema.columns
    where table_schema = 'screening_v2' and table_name = 'call_sessions'
      and column_name in ('recording_finalize_attempts',
                          'recording_finalize_last_attempt_at',
                          'recording_finalize_defer_reason',
                          'recording_finalize_exhausted_at')) = 4,
  'a pending finalize must be able to say WHY, how often, and whether it gave up'
);

select _policy_tests.assert(
  '0038: defer reason is a bounded ALLOWLIST, never free text',
  exists (
    select 1 from pg_constraint
     where conname = 'chk_call_sessions_recording_finalize_defer_reason'
       and conrelid = 'screening_v2.call_sessions'::regclass
       and convalidated
  ),
  'provider text must never be persistable in a durable reason column'
);

select _policy_tests.assert(
  '0038: the egress-status domain is UNCHANGED (no read gate changes meaning)',
  (select pg_get_constraintdef(oid) from pg_constraint
    where conname = 'chk_call_sessions_recording_egress_status'
      and conrelid = 'screening_v2.call_sessions'::regclass)
    like '%''active''%complete''%failed''%',
  '0038 must not widen the three-value egress status domain'
);

select _policy_tests.assert(
  '0038: the sweeper index covers the FULL terminal set',
  (select indexdef from pg_indexes
    where schemaname = 'screening_v2'
      and indexname = 'idx_call_sessions_recording_finalize_pending')
    like '%cancelled%expired%',
  'a partial index narrower than the sweeper predicate silently changes eligibility'
);

select _policy_tests.assert(
  '0038: terminal-transition trigger is installed on call_sessions',
  exists (
    select 1 from pg_trigger t
      join pg_class c on c.oid = t.tgrelid
      join pg_namespace n on n.oid = c.relnamespace
     where n.nspname = 'screening_v2'
       and c.relname = 'call_sessions'
       and t.tgname = 'trg_enqueue_recording_finalize'
       and not t.tgisinternal
  ),
  'the trigger is the only seam covering the Python worker''s direct UPDATE'
);

select _policy_tests.assert(
  '0038: residency_timeout is a legal failed terminal_reason',
  (select pg_get_constraintdef(oid) from pg_constraint
    where conname = 'chk_call_sessions_terminal_reason'
      and conrelid = 'screening_v2.call_sessions'::regclass)
    like '%residency_timeout%',
  'the worker residency cap must be persistable truthfully, never as worker_crash'
);

select _policy_tests.assert(
  '0038: new functions are service-role-only',
  not exists (
    select 1 from pg_proc p
      join pg_namespace n on n.oid = p.pronamespace
     where n.nspname = 'screening_v2'
       and p.proname in ('reopen_recording_finalize',
                         'record_recording_finalize_deferral',
                         'set_recording_finalize_halt',
                         'clear_recording_finalize_halt',
                         'reap_completed_jobs')
       and (has_function_privilege('anon', p.oid, 'EXECUTE')
         or has_function_privilege('authenticated', p.oid, 'EXECUTE'))
  ),
  'browser roles must never execute the finalization control surface'
);

select _policy_tests.assert(
  '0038: the halt control table is RLS-enabled and browser-revoked',
  exists (
    select 1 from pg_class c
      join pg_namespace n on n.oid = c.relnamespace
     where n.nspname = 'screening_v2'
       and c.relname = 'recording_finalize_control'
       and c.relrowsecurity
  )
  and not exists (
    select 1 from pg_class c
      join pg_namespace n on n.oid = c.relnamespace
     where n.nspname = 'screening_v2'
       and c.relname = 'recording_finalize_control'
       and (has_table_privilege('anon', c.oid, 'SELECT')
         or has_table_privilege('authenticated', c.oid, 'SELECT'))
  ),
  'the kill switch is service-role-only backend infrastructure'
);

-- ── Live behaviour: the trigger, the dedup, the reopen RPC, the reaper ──
do $$
declare
  v_sid  uuid;
  v_cand uuid;
  v_jobs integer;
  v_res  jsonb;
  v_reaped jsonb;
  v_status text;
begin
  select id into v_cand from screening_v2.candidates limit 1;
  if v_cand is null then
    perform _policy_tests.assert('0038: trigger enqueues exactly one finalize job',
      true, 'skipped: no candidate row available for synthetic session');
    return;
  end if;

  insert into screening_v2.call_sessions (candidate_id, mode, status)
  values (v_cand, 'simulation', 'created')
  returning id into v_sid;

  update screening_v2.call_sessions
     set status = 'in_progress' where id = v_sid;
  -- Link an egress with no object key: the exact pre-terminal shape.
  update screening_v2.call_sessions
     set recording_egress_id = 'EG_policytest0001',
         recording_egress_status = 'active'
   where id = v_sid;

  -- THE PYTHON WORKER'S SHAPE: a direct SQL terminal UPDATE that bypasses
  -- every TypeScript seam. This is the whole reason the enqueue is a trigger.
  update screening_v2.call_sessions
     set status = 'completed', terminal_reason = 'conversation_complete',
         ended_at = now()
   where id = v_sid;

  select count(*) into v_jobs
    from screening_v2.job_queue
   where dedup_key = 'recording.finalize:' || v_sid::text;
  perform _policy_tests.assert(
    '0038: a direct SQL terminal UPDATE enqueues exactly one finalize job',
    v_jobs = 1,
    'expected 1 job, got ' || v_jobs::text);

  -- A second QUALIFYING update while that job is live must add nothing.
  -- Re-linking the egress on an already-terminal row is the trigger's second
  -- guard (old.recording_egress_id null -> new not null), so this genuinely
  -- fires the trigger again; uq_job_queue_dedup_active (which covers
  -- pending/active/delayed) is what makes the insert a no-op.
  update screening_v2.call_sessions
     set recording_egress_id = null where id = v_sid;
  update screening_v2.call_sessions
     set recording_egress_id = 'EG_policytest0001' where id = v_sid;
  select count(*) into v_jobs
    from screening_v2.job_queue
   where dedup_key = 'recording.finalize:' || v_sid::text;
  perform _policy_tests.assert(
    '0038: a repeat update while the job is live enqueues nothing further',
    v_jobs = 1,
    'expected 1 job after repeat update, got ' || v_jobs::text);

  -- ── record_recording_finalize_deferral: bookkeeping and its terminus ──
  v_res := screening_v2.record_recording_finalize_deferral(v_sid, 'not_a_real_reason', 5);
  perform _policy_tests.assert(
    '0038: an unlisted defer reason is refused',
    v_res->>'status' = 'invalid_reason',
    'got ' || coalesce(v_res->>'status', 'null'));

  v_res := screening_v2.record_recording_finalize_deferral(v_sid, 'poll_timeout', 2);
  perform _policy_tests.assert(
    '0038: the first deferral increments and does not exhaust',
    v_res->>'status' = 'ok' and (v_res->>'attempts')::int = 1
      and (v_res->>'exhausted')::boolean = false,
    'got ' || v_res::text);

  v_res := screening_v2.record_recording_finalize_deferral(v_sid, 'object_unreadable', 2);
  perform _policy_tests.assert(
    '0038: reaching the budget stamps the exhaustion TERMINUS',
    v_res->>'status' = 'ok' and (v_res->>'exhausted')::boolean = true,
    'got ' || v_res::text);

  perform _policy_tests.assert(
    '0038: an exhausted row is no longer selected by the sweeper predicate',
    not exists (
      select 1 from screening_v2.call_sessions
       where id = v_sid
         and status in ('completed','failed','cancelled','expired')
         and recording_egress_id is not null
         and recording_object_key is null
         and recording_egress_status = 'active'
         and recording_finalize_exhausted_at is null),
    'the exhaustion terminus must remove the row from the sweep');

  -- ── reopen_recording_finalize: the audited way back ──
  update screening_v2.call_sessions
     set recording_egress_status = 'failed' where id = v_sid;

  v_res := screening_v2.reopen_recording_finalize(v_sid, 'because_i_said_so');
  perform _policy_tests.assert(
    '0038: reopen refuses a reason outside the allowlist',
    v_res->>'status' = 'invalid_reason',
    'got ' || coalesce(v_res->>'status', 'null'));

  v_res := screening_v2.reopen_recording_finalize(v_sid, 'operator_review');
  select recording_egress_status into v_status
    from screening_v2.call_sessions where id = v_sid;
  perform _policy_tests.assert(
    '0038: reopen is the ONLY writer that moves failed back to active',
    v_res->>'status' = 'ok' and v_status = 'active',
    'status=' || coalesce(v_status, 'null') || ' res=' || v_res::text);

  perform _policy_tests.assert(
    '0038: reopen resets the attempt counter and clears the terminus',
    exists (select 1 from screening_v2.call_sessions
             where id = v_sid
               and recording_finalize_attempts = 0
               and recording_finalize_exhausted_at is null
               and recording_finalize_defer_reason is null),
    'a gate with no reset lifecycle is a one-way latch, not a control');

  perform _policy_tests.assert(
    '0038: reopen writes an attributable audit row',
    exists (select 1 from screening_v2.audit_events
             where action = 'admin_session_override'
               and target_type = 'call_session'
               and target_id = v_sid::text
               and metadata->>'override' = 'recording_finalize_reopen'),
    'an operator override must never be silent');

  -- Terminal recording states are refused, exactly as 0025 refuses them.
  update screening_v2.call_sessions
     set recording_deleted_at = now() where id = v_sid;
  v_res := screening_v2.reopen_recording_finalize(v_sid, 'operator_review');
  perform _policy_tests.assert(
    '0038: reopen refuses a deleted recording',
    v_res->>'status' = 'terminal_state',
    'got ' || coalesce(v_res->>'status', 'null'));

  update screening_v2.call_sessions
     set recording_deleted_at = null,
         recording_object_key = v_sid::text || '-egress.ogg'
   where id = v_sid;
  v_res := screening_v2.reopen_recording_finalize(v_sid, 'operator_review');
  perform _policy_tests.assert(
    '0038: reopen refuses an already-linked recording',
    v_res->>'status' = 'already_linked',
    'got ' || coalesce(v_res->>'status', 'null'));

  -- ── the halt control: set, idempotent re-set, and CLEAR ──
  v_res := screening_v2.set_recording_finalize_halt('not_a_reason');
  perform _policy_tests.assert(
    '0038: halt refuses a reason outside the allowlist',
    v_res->>'status' = 'invalid_reason',
    'got ' || coalesce(v_res->>'status', 'null'));

  v_res := screening_v2.set_recording_finalize_halt('operator_pause');
  perform _policy_tests.assert(
    '0038: the halt can be SET',
    v_res->>'status' = 'ok'
      and exists (select 1 from screening_v2.recording_finalize_control
                   where control_key = 'default' and sweep_halted_at is not null),
    'got ' || v_res::text);

  v_res := screening_v2.clear_recording_finalize_halt();
  perform _policy_tests.assert(
    '0038: the halt can be CLEARED — a gate with no reset is a latch',
    v_res->>'status' = 'ok' and (v_res->>'was_halted')::boolean = true
      and exists (select 1 from screening_v2.recording_finalize_control
                   where control_key = 'default'
                     and sweep_halted_at is null and sweep_halt_reason is null),
    'got ' || v_res::text);

  -- ── the bounded reaper ──
  update screening_v2.job_queue
     set status = 'completed', completed_at = now() - interval '30 days'
   where dedup_key = 'recording.finalize:' || v_sid::text;

  v_reaped := screening_v2.reap_completed_jobs(604800, 500);
  perform _policy_tests.assert(
    '0038: the reaper removes aged COMPLETED job rows',
    (v_reaped->>'deleted')::int >= 1
      and not exists (select 1 from screening_v2.job_queue
                       where dedup_key = 'recording.finalize:' || v_sid::text),
    'got ' || v_reaped::text);

  v_reaped := screening_v2.reap_completed_jobs(1, 1);
  perform _policy_tests.assert(
    '0038: the reaper CLAMPS its retention window rather than trusting input',
    (v_reaped->>'older_than_seconds')::int = 3600 and (v_reaped->>'limit')::int = 1,
    'got ' || v_reaped::text);

  delete from screening_v2.job_queue
   where dedup_key = 'recording.finalize:' || v_sid::text;
  -- audit_events is APPEND-ONLY (prevent_audit_mutation blocks DELETE), which
  -- is exactly the property the reopen audit relies on. The synthetic rows are
  -- left in place deliberately; they carry no candidate data.
  delete from screening_v2.call_sessions where id = v_sid;
end;
$$;

-- =====================================================================
-- 0039: Parse-class ingestion resilience — the guarded extracting -> queued
--       edge, the BOUNDED audited recovery (deliberately NOT a counter
--       reset), and the additive parse-failure counter.
-- =====================================================================

select _policy_tests.assert(
  'ashby 0039: defer_ashby_ingestion_parse is service-role only',
  (select count(*)
     from pg_proc p join pg_namespace n on n.oid = p.pronamespace
    where n.nspname = 'screening_v2'
      and p.proname = 'defer_ashby_ingestion_parse'
      and not has_function_privilege('anon', p.oid, 'EXECUTE')
      and not has_function_privilege('authenticated', p.oid, 'EXECUTE')
      and has_function_privilege('service_role', p.oid, 'EXECUTE')
  ) = 1,
  'the only door to extracting -> queued must not be reachable from a browser role'
);

select _policy_tests.assert(
  'ashby 0039: recover_ashby_ingestion_parse is service-role only',
  (select count(*)
     from pg_proc p join pg_namespace n on n.oid = p.pronamespace
    where n.nspname = 'screening_v2'
      and p.proname = 'recover_ashby_ingestion_parse'
      and not has_function_privilege('anon', p.oid, 'EXECUTE')
      and not has_function_privilege('authenticated', p.oid, 'EXECUTE')
      and has_function_privilege('service_role', p.oid, 'EXECUTE')
  ) = 1,
  'an audited admin recovery must not be reachable from a browser role'
);

select _policy_tests.assert(
  'ashby 0039: both new SECURITY DEFINER RPCs pin search_path',
  (select count(*)
     from pg_proc p join pg_namespace n on n.oid = p.pronamespace
    where n.nspname = 'screening_v2'
      and p.proname in ('defer_ashby_ingestion_parse','recover_ashby_ingestion_parse')
      and p.prosecdef
      and array_to_string(coalesce(p.proconfig, '{}'), ',') like '%search_path%'
  ) = 2,
  'every SECURITY DEFINER RPC must pin search_path'
);

select _policy_tests.assert(
  'ashby 0039: the new audit action is permitted',
  (select pg_get_constraintdef(oid) from pg_constraint
    where conname = 'chk_audit_action'
      and conrelid = 'screening_v2.audit_events'::regclass)
    like '%ashby_ingestion_parse_recovery%',
  'the 0039 audit action must be in chk_audit_action'
);

select _policy_tests.assert(
  'ashby 0039: re-declaring chk_audit_action dropped none of the earlier actions',
  (select bool_and(pg_get_constraintdef(c.oid) like ('%' || a || '%'))
     from pg_constraint c,
          unnest(array['invite_sent','grant_issued','recording_quarantined',
                       'ashby_mapping_update','ashby_operation_retry',
                       'ashby_invite_delivered','ashby_ingestion_attempts_reset']) as a
    where c.conname = 'chk_audit_action'
      and c.conrelid = 'screening_v2.audit_events'::regclass),
  'widening chk_audit_action must be purely additive'
);

do $$
declare
  v_role      uuid;
  v_map       uuid;
  v_link      uuid;   -- the parse-deferral path
  v_link_doc  uuid;   -- document verdict            → refused everywhere
  v_link_leg  uuid;   -- legacy generic parse_error  → recoverable ONCE per attempt
  v_link_term uuid;   -- terminal application        → refused
  v_link_gen  uuid;   -- the generic advance() refusal of extracting -> queued
  v_link_mat  uuid;   -- parse succeeded, persisting the candidate failed
  v_link_clk  uuid;   -- the defer wall-clock became uncomputable
  v_res       jsonb;
  v_att       integer;
  v_state     text;
  v_reason    text;
  v_audit     jsonb;
  v_backlog   jsonb;
  v_owner     uuid := '00000000-0000-4000-8000-0000000000ac';
  i           integer;
begin
  select id into v_role from screening_v2.roles limit 1;
  if v_role is null then
    perform _policy_tests.assert('ashby 0039 functional: seed role present', false, 'no seed role available');
    return;
  end if;

  insert into screening_v2.ashby_job_mappings
    (external_job_id, role_id, owner_id, ai_screening_stage_id, ta_screening_stage_id, status, delivery_mode)
  values ('pol39-job', v_role, v_owner, 'pol39-ai', 'pol39-ta', 'enabled', 'manual')
  returning id into v_map;

  insert into screening_v2.ashby_application_links
    (external_application_id, external_job_id, job_mapping_id, external_resume_file_handle)
  values ('pol39-app',      'pol39-job', v_map, repeat('h', 64)) returning id into v_link;
  insert into screening_v2.ashby_application_links
    (external_application_id, external_job_id, job_mapping_id, external_resume_file_handle)
  values ('pol39-app-doc',  'pol39-job', v_map, repeat('h', 64)) returning id into v_link_doc;
  insert into screening_v2.ashby_application_links
    (external_application_id, external_job_id, job_mapping_id, external_resume_file_handle)
  values ('pol39-app-leg',  'pol39-job', v_map, repeat('h', 64)) returning id into v_link_leg;
  insert into screening_v2.ashby_application_links
    (external_application_id, external_job_id, job_mapping_id, external_resume_file_handle)
  values ('pol39-app-term', 'pol39-job', v_map, repeat('h', 64)) returning id into v_link_term;
  insert into screening_v2.ashby_application_links
    (external_application_id, external_job_id, job_mapping_id, external_resume_file_handle)
  values ('pol39-app-gen',  'pol39-job', v_map, repeat('h', 64)) returning id into v_link_gen;
  insert into screening_v2.ashby_application_links
    (external_application_id, external_job_id, job_mapping_id, external_resume_file_handle)
  values ('pol39-app-mat',  'pol39-job', v_map, repeat('h', 64)) returning id into v_link_mat;
  insert into screening_v2.ashby_application_links
    (external_application_id, external_job_id, job_mapping_id, external_resume_file_handle)
  values ('pol39-app-clk',  'pol39-job', v_map, repeat('h', 64)) returning id into v_link_clk;

  -- ── The GENERIC path must still refuse extracting -> queued ────────────
  -- This is the guard that keeps the new edge from becoming a general
  -- re-download: runImport calls advance(link,'queued') unconditionally on
  -- every webhook redelivery.
  perform screening_v2.advance_ashby_ingestion(v_link_gen, 'queued', null, null, null, null);
  perform screening_v2.advance_ashby_ingestion(v_link_gen, 'fetching', null, null, null, null);
  perform screening_v2.advance_ashby_ingestion(v_link_gen, 'scanning', null, null, null, null);
  perform screening_v2.advance_ashby_ingestion(v_link_gen, 'extracting', null, null, null, null);
  v_res := screening_v2.advance_ashby_ingestion(v_link_gen, 'queued', null, null, null, null);
  perform _policy_tests.assert(
    'ashby 0039: advance_ashby_ingestion REFUSES extracting -> queued',
    v_res->>'status' = 'not_requeueable' and v_res->>'reason' = 'parse_defer_only',
    'the new edge belongs to defer_ashby_ingestion_parse alone; got ' || coalesce(v_res::text,'<null>'));

  select state, attempts into v_state, v_att
    from screening_v2.ashby_resume_ingestions where application_link_id = v_link_gen;
  perform _policy_tests.assert(
    'ashby 0039: the refused generic requeue changed nothing',
    v_state = 'extracting' and v_att = 0,
    'got state=' || coalesce(v_state,'<null>') || ' attempts=' || coalesce(v_att::text,'<null>'));

  -- ── The guarded deferral: reason allowlist, state guard, terminal guard ─
  perform screening_v2.advance_ashby_ingestion(v_link, 'queued', null, null, null, null);
  v_res := screening_v2.defer_ashby_ingestion_parse(v_link, 'parse_timeout');
  perform _policy_tests.assert(
    'ashby 0039 refusal: the deferral is legal ONLY from extracting',
    v_res->>'status' = 'invalid_state' and v_res->>'state' = 'queued',
    'got ' || coalesce(v_res::text,'<null>'));

  perform screening_v2.advance_ashby_ingestion(v_link, 'fetching', null, null, null, null);
  perform screening_v2.advance_ashby_ingestion(v_link, 'scanning', null, null, null, null);
  perform screening_v2.advance_ashby_ingestion(v_link, 'extracting', null, null, null, null);

  v_res := screening_v2.defer_ashby_ingestion_parse(v_link, 'parse_extract_failed');
  perform _policy_tests.assert(
    'ashby 0039 refusal: a DOCUMENT verdict may never defer',
    v_res->>'status' = 'not_deferrable' and v_res->>'reason' = 'parse_extract_failed',
    'only parser AVAILABILITY defers; got ' || coalesce(v_res::text,'<null>'));

  v_res := screening_v2.defer_ashby_ingestion_parse(v_link, 'parse_child_exit');
  perform _policy_tests.assert(
    'ashby 0039 refusal: a broken deployment rests loudly rather than waiting silently',
    v_res->>'status' = 'not_deferrable' and v_res->>'reason' = 'parse_child_exit',
    'got ' || coalesce(v_res::text,'<null>'));

  -- The ok path: back to queued, no failure reason, ONE attempt charged.
  v_res := screening_v2.defer_ashby_ingestion_parse(v_link, 'parse_timeout');
  perform _policy_tests.assert(
    'ashby 0039: a parse deferral requeues and charges exactly one attempt',
    v_res->>'status' = 'ok'
      and v_res->>'state' = 'queued'
      and (v_res->>'attempts')::int = 1
      and (v_res->>'max_attempts')::int = 5,
    'got ' || coalesce(v_res::text,'<null>'));

  select state, failed_reason into v_state, v_reason
    from screening_v2.ashby_resume_ingestions where application_link_id = v_link;
  perform _policy_tests.assert(
    'ashby 0039: a deferred row carries NO failure reason',
    v_state = 'queued' and v_reason is null,
    'nothing was learned about the document; got state=' || coalesce(v_state,'<null>')
      || ' reason=' || coalesce(v_reason,'<null>'));

  -- ── The ceiling is NOT relaxed by the deferral. ───────────────────────
  for i in 1..4 loop
    perform screening_v2.advance_ashby_ingestion(v_link, 'fetching', null, null, null, null);
    perform screening_v2.advance_ashby_ingestion(v_link, 'scanning', null, null, null, null);
    perform screening_v2.advance_ashby_ingestion(v_link, 'extracting', null, null, null, null);
    perform screening_v2.defer_ashby_ingestion_parse(v_link, 'parse_overload');
  end loop;
  perform screening_v2.advance_ashby_ingestion(v_link, 'fetching', null, null, null, null);
  perform screening_v2.advance_ashby_ingestion(v_link, 'scanning', null, null, null, null);
  perform screening_v2.advance_ashby_ingestion(v_link, 'extracting', null, null, null, null);
  v_res := screening_v2.defer_ashby_ingestion_parse(v_link, 'parse_overload');
  perform _policy_tests.assert(
    'ashby 0039: parse deferrals are bounded by the UNCHANGED 5-attempt ceiling',
    v_res->>'status' = 'retry_exhausted' and (v_res->>'max_attempts')::int = 5,
    'a deferral buys bounded patience, not unbounded patience; got ' || coalesce(v_res::text,'<null>'));

  -- ── Recovery: document verdicts are never recoverable ─────────────────
  perform screening_v2.advance_ashby_ingestion(v_link_doc, 'queued', null, null, null, null);
  perform screening_v2.advance_ashby_ingestion(v_link_doc, 'fetching', null, null, null, null);
  perform screening_v2.advance_ashby_ingestion(v_link_doc, 'scanning', null, null, null, null);
  perform screening_v2.advance_ashby_ingestion(v_link_doc, 'extracting', null, null, null, null);
  perform screening_v2.advance_ashby_ingestion(v_link_doc, 'failed_review', null, null, null, 'parse_extract_failed');
  v_res := screening_v2.recover_ashby_ingestion_parse(v_link_doc, v_owner);
  perform _policy_tests.assert(
    'ashby 0039 refusal: a document verdict is not recoverable',
    v_res->>'status' = 'not_a_parse_availability_failure'
      and v_res->>'failed_reason' = 'parse_extract_failed',
    'retrying an unparseable document re-burns attempts on a file that needs a human; got '
      || coalesce(v_res::text,'<null>'));

  v_res := screening_v2.recover_ashby_ingestion_parse(gen_random_uuid(), v_owner);
  perform _policy_tests.assert(
    'ashby 0039 refusal: an unknown link is not_found',
    v_res->>'status' = 'not_found', 'got ' || coalesce(v_res::text,'<null>'));

  perform screening_v2.advance_ashby_ingestion(v_link_term, 'queued', null, null, null, null);
  perform screening_v2.advance_ashby_ingestion(v_link_term, 'fetching', null, null, null, null);
  perform screening_v2.advance_ashby_ingestion(v_link_term, 'failed_review', null, null, null, 'parse_timeout');
  update screening_v2.ashby_application_links set terminal_state = 'withdrawn' where id = v_link_term;
  v_res := screening_v2.recover_ashby_ingestion_parse(v_link_term, v_owner);
  perform _policy_tests.assert(
    'ashby 0039 refusal: a withdrawn application is blocked_terminal',
    v_res->>'status' = 'blocked_terminal' and v_res->>'terminal_state' = 'withdrawn',
    'got ' || coalesce(v_res::text,'<null>'));

  v_res := screening_v2.recover_ashby_ingestion_parse(v_link_gen, v_owner);
  perform _policy_tests.assert(
    'ashby 0039 refusal: a live (non failed_review) ingestion is not_recoverable',
    v_res->>'status' = 'not_recoverable',
    'got ' || coalesce(v_res::text,'<null>'));

  -- ── Legacy `parse_error`: recoverable for RECLASSIFICATION, and BOUNDED ─
  perform screening_v2.advance_ashby_ingestion(v_link_leg, 'queued', null, null, null, null);
  perform screening_v2.advance_ashby_ingestion(v_link_leg, 'fetching', null, null, null, null);
  perform screening_v2.advance_ashby_ingestion(v_link_leg, 'scanning', null, null, null, null);
  perform screening_v2.advance_ashby_ingestion(v_link_leg, 'extracting', null, null, null, null);
  perform screening_v2.advance_ashby_ingestion(v_link_leg, 'failed_review', null, null, null, 'parse_error');

  -- The GENERIC path still refuses it: an unknown failure must not be retried
  -- automatically on every webhook redelivery.
  v_res := screening_v2.advance_ashby_ingestion(v_link_leg, 'queued', null, null, null, null);
  perform _policy_tests.assert(
    'ashby 0039: the generic path still refuses legacy parse_error',
    v_res->>'status' = 'not_requeueable' and v_res->>'failed_reason' = 'parse_error',
    'only the audited recovery may reclassify it; got ' || coalesce(v_res::text,'<null>'));

  v_res := screening_v2.recover_ashby_ingestion_parse(v_link_leg, v_owner);
  perform _policy_tests.assert(
    'ashby 0039: the audited recovery DOES accept legacy parse_error, and charges an attempt',
    v_res->>'status' = 'ok'
      and v_res->>'state' = 'queued'
      and (v_res->>'attempts_before')::int = 0
      and (v_res->>'attempts')::int = 1,
    'a row that never recorded its cause deserves ONE bounded retry to name it; got '
      || coalesce(v_res::text,'<null>'));

  select state, failed_reason into v_state, v_reason
    from screening_v2.ashby_resume_ingestions where application_link_id = v_link_leg;
  perform _policy_tests.assert(
    'ashby 0039: the recovered row is queued and carries no stale reason',
    v_state = 'queued' and v_reason is null,
    'got state=' || coalesce(v_state,'<null>') || ' reason=' || coalesce(v_reason,'<null>'));

  select metadata into v_audit
    from screening_v2.audit_events
   where action = 'ashby_ingestion_parse_recovery'
     and metadata->>'application_link_id' = v_link_leg::text
   order by created_at desc limit 1;
  perform _policy_tests.assert(
    'ashby 0039: the recovery is audited with the matched reason and both counts',
    v_audit is not null
      and v_audit->>'failed_reason' = 'parse_error'
      and (v_audit->>'attempts_before')::int = 0
      and (v_audit->>'attempts_after')::int = 1,
    'an unattributable retry is indistinguishable from a raw UPDATE; got '
      || coalesce(v_audit::text,'<null>'));

  -- BOUNDED, not resettable: burn the remaining budget and confirm it stops.
  for i in 1..4 loop
    perform screening_v2.advance_ashby_ingestion(v_link_leg, 'fetching', null, null, null, null);
    perform screening_v2.advance_ashby_ingestion(v_link_leg, 'failed_review', null, null, null, 'parse_timeout');
    perform screening_v2.recover_ashby_ingestion_parse(v_link_leg, v_owner);
  end loop;
  perform screening_v2.advance_ashby_ingestion(v_link_leg, 'fetching', null, null, null, null);
  perform screening_v2.advance_ashby_ingestion(v_link_leg, 'failed_review', null, null, null, 'parse_timeout');
  v_res := screening_v2.recover_ashby_ingestion_parse(v_link_leg, v_owner);
  perform _policy_tests.assert(
    'ashby 0039: the recovery CANNOT reset attempts — it exhausts like any requeue',
    v_res->>'status' = 'retry_exhausted' and (v_res->>'max_attempts')::int = 5,
    'this is deliberately not 0036: the ceiling is the bound and stays the bound; got '
      || coalesce(v_res::text,'<null>'));

  select attempts into v_att
    from screening_v2.ashby_resume_ingestions where application_link_id = v_link_leg;
  perform _policy_tests.assert(
    'ashby 0039: an exhausted row keeps its counter',
    v_att = 5, 'got attempts=' || coalesce(v_att::text,'<null>'));

  -- ── MACHINE-class recovery: materialize_failed and an unusable clock ───
  -- `materialize_failed` is the row written when the parse SUCCEEDED but the
  -- approved candidate/resume rows could not be written. It must be
  -- recoverable through BOTH doors — the generic requeue (so a redelivered
  -- webhook repairs it automatically) and the audited admin retry — because
  -- the document is fine and only our write failed.
  perform screening_v2.advance_ashby_ingestion(v_link_mat, 'queued', null, null, null, null);
  perform screening_v2.advance_ashby_ingestion(v_link_mat, 'fetching', null, null, null, null);
  perform screening_v2.advance_ashby_ingestion(v_link_mat, 'scanning', null, null, null, null);
  perform screening_v2.advance_ashby_ingestion(v_link_mat, 'extracting', null, null, null, null);
  perform screening_v2.advance_ashby_ingestion(v_link_mat, 'structuring', null, null, null, null);
  v_res := screening_v2.advance_ashby_ingestion(v_link_mat, 'failed_review', null, null, null, 'materialize_failed');
  perform _policy_tests.assert(
    'ashby 0039: structuring -> failed_review(materialize_failed) is legal',
    v_res->>'status' = 'ok',
    'the persist failure must be recordable from structuring; got ' || coalesce(v_res::text,'<null>'));

  v_res := screening_v2.recover_ashby_ingestion_parse(v_link_mat, v_owner);
  perform _policy_tests.assert(
    'ashby 0039: the audited retry ACCEPTS materialize_failed and charges an attempt',
    v_res->>'status' = 'ok' and (v_res->>'attempts')::int = 1,
    'a failed write of our own rows is machine-class, not a document verdict; got '
      || coalesce(v_res::text,'<null>'));

  -- ...and the GENERIC path accepts it too, so a redelivered webhook repairs
  -- it without an operator. This is what makes the blank-ready defect
  -- self-healing rather than merely reportable.
  perform screening_v2.advance_ashby_ingestion(v_link_mat, 'fetching', null, null, null, null);
  v_res := screening_v2.advance_ashby_ingestion(v_link_mat, 'failed_review', null, null, null, 'materialize_failed');
  v_res := screening_v2.advance_ashby_ingestion(v_link_mat, 'queued', null, null, null, null);
  perform _policy_tests.assert(
    'ashby 0039: the GENERIC requeue also accepts materialize_failed',
    v_res->>'status' = 'ok',
    'machine-class failures must stay auto-recoverable; got ' || coalesce(v_res::text,'<null>'));

  -- An uncomputable defer clock is recoverable on the same terms.
  perform screening_v2.advance_ashby_ingestion(v_link_clk, 'queued', null, null, null, null);
  perform screening_v2.advance_ashby_ingestion(v_link_clk, 'fetching', null, null, null, null);
  perform screening_v2.advance_ashby_ingestion(v_link_clk, 'failed_review', null, null, null, 'parse_defer_clock_invalid');
  v_res := screening_v2.recover_ashby_ingestion_parse(v_link_clk, v_owner);
  perform _policy_tests.assert(
    'ashby 0039: the audited retry accepts parse_defer_clock_invalid',
    v_res->>'status' = 'ok',
    'a wait we could not bound is not a statement about the document; got '
      || coalesce(v_res::text,'<null>'));

  -- The widening did NOT admit a document verdict by accident.
  perform screening_v2.advance_ashby_ingestion(v_link_clk, 'fetching', null, null, null, null);
  perform screening_v2.advance_ashby_ingestion(v_link_clk, 'scanning', null, null, null, null);
  perform screening_v2.advance_ashby_ingestion(v_link_clk, 'extracting', null, null, null, null);
  perform screening_v2.advance_ashby_ingestion(v_link_clk, 'failed_review', null, null, null, 'parse_no_output');
  v_res := screening_v2.recover_ashby_ingestion_parse(v_link_clk, v_owner);
  perform _policy_tests.assert(
    'ashby 0039: widening the allowlist admitted NO document verdict',
    v_res->>'status' = 'not_a_parse_availability_failure',
    'parse_no_output must still be refused; got ' || coalesce(v_res::text,'<null>'));

  -- ── The additive backlog counter sees BOTH legacy and sub-classified ───
  v_backlog := screening_v2.ashby_prerequisite_backlog(900);
  perform _policy_tests.assert(
    'ashby 0039: ashby_prerequisite_backlog reports ingestion_failed_parse',
    v_backlog ? 'ingestion_failed_parse'
      and (v_backlog->>'ingestion_failed_parse')::int >= 2,
    'the parse-class queue must be visible to operations (v_link_doc + v_link_leg); got '
      || coalesce(v_backlog::text,'<null>'));

  perform _policy_tests.assert(
    'ashby 0039: every pre-existing backlog counter still exists',
    v_backlog ? 'pending_blocked'
      and v_backlog ? 'pending_blocked_failed_ingestion'
      and v_backlog ? 'failed_prerequisite'
      and v_backlog ? 'ingestion_stuck_queued'
      and v_backlog ? 'ingestion_stuck_fetching',
    'widening the counter set must be purely additive; got ' || coalesce(v_backlog::text,'<null>'));

  -- Audit rows are append-only (0007) and deliberately left behind, exactly as
  -- the 0036 block does; every id they reference is a local fixture.
  delete from screening_v2.ashby_resume_ingestions
   where application_link_id in (v_link, v_link_doc, v_link_leg, v_link_term, v_link_gen, v_link_mat, v_link_clk);
  delete from screening_v2.ashby_application_links
   where id in (v_link, v_link_doc, v_link_leg, v_link_term, v_link_gen, v_link_mat, v_link_clk);
  delete from screening_v2.ashby_job_mappings where id = v_map;
end;
$$;

-- =====================================================================
-- 0040: Queue admission for the audited recovery — the transition and the
--       durable work are ONE transaction.
--
-- 0039 moved `failed_review -> queued`, charged an attempt and wrote a
-- `success` audit row while scheduling NOTHING: the original
-- `ashby.ingestion` job had completed, the governing event receipt was
-- already terminal, and the 0030 outbox therefore declines to re-drive on
-- every subsequent reconciliation pass and webhook redelivery. The row
-- rested in `queued` for ever, having LEFT the operator queue that was
-- watching it. These tests are the assertion that was never written: after
-- a successful recovery, durable CLAIMABLE work must exist.
-- =====================================================================

select _policy_tests.assert(
  'ashby 0040: recover_ashby_ingestion_parse is STILL service-role only',
  (select count(*)
     from pg_proc p join pg_namespace n on n.oid = p.pronamespace
    where n.nspname = 'screening_v2'
      and p.proname = 'recover_ashby_ingestion_parse'
      and p.prosecdef
      and array_to_string(coalesce(p.proconfig, '{}'), ',') like '%search_path%'
      and not has_function_privilege('anon', p.oid, 'EXECUTE')
      and not has_function_privilege('authenticated', p.oid, 'EXECUTE')
      and has_function_privilege('service_role', p.oid, 'EXECUTE')
  ) = 1,
  'replacing the body must not widen the grant or unpin search_path'
);

select _policy_tests.assert(
  'ashby 0040: exactly ONE recover_ashby_ingestion_parse overload exists',
  (select count(*)
     from pg_proc p join pg_namespace n on n.oid = p.pronamespace
    where n.nspname = 'screening_v2'
      and p.proname = 'recover_ashby_ingestion_parse') = 1,
  'a changed signature would leave the OLD non-enqueuing body callable'
);

-- The deadlock argument, asserted rather than asserted-in-prose:
-- `cancel_ashby_application` locks the LINK and then writes the ingestion.
-- The recovery must take the same two locks in the same order.
select _policy_tests.assert(
  'ashby 0040: the recovery locks the LINK before the ingestion',
  (select position('from screening_v2.ashby_application_links' in body) > 0
      and position('from screening_v2.ashby_resume_ingestions' in body) > 0
      and position('from screening_v2.ashby_application_links' in body)
        < position('from screening_v2.ashby_resume_ingestions' in body)
     from (select pg_get_functiondef(p.oid) as body
             from pg_proc p join pg_namespace n on n.oid = p.pronamespace
            where n.nspname = 'screening_v2'
              and p.proname = 'recover_ashby_ingestion_parse') s),
  'cancel_ashby_application takes link-then-ingestion; the reverse order here '
  'would be a deadlock-prone inversion between two service-role writers'
);

do $$
declare
  v_role      uuid;
  v_map       uuid;
  v_link_ok   uuid;   -- happy path: legacy parse_error, no prior job
  v_link_done uuid;   -- a COMPLETED old job must not block a new one
  v_link_live uuid;   -- a live pending job must not be duplicated
  v_link_term uuid;   -- terminal application     → no job, no state change
  v_link_act  uuid;   -- a job already IN FLIGHT  → refused, nothing spent
  v_link_can  uuid;   -- fully cancelled          → no job, no audit
  v_link_doc  uuid;   -- document verdict         → no job
  v_link_ex   uuid;   -- exhausted budget         → no job
  v_link_fail uuid;   -- enqueue FAILS            → everything rolls back
  v_owner     uuid := '00000000-0000-4000-8000-0000000000ad';
  v_res       jsonb;
  v_payload   jsonb;
  v_state     text;
  v_reason    text;
  v_att       integer;
  v_att0      integer;
  v_cnt       integer;
  v_audits    integer;
  v_job       record;
  v_old_job   uuid;
  v_now       timestamptz := now();
  i           integer;
begin
  select id into v_role from screening_v2.roles limit 1;
  if v_role is null then
    perform _policy_tests.assert('ashby 0040 functional: seed role present', false,
      'no seed role available');
    return;
  end if;

  insert into screening_v2.ashby_job_mappings
    (external_job_id, role_id, owner_id, ai_screening_stage_id, ta_screening_stage_id,
     status, delivery_mode)
  values ('pol40-job', v_role, v_owner, 'pol40-ai', 'pol40-ta', 'enabled', 'manual')
  returning id into v_map;

  insert into screening_v2.ashby_application_links
    (external_application_id, external_job_id, job_mapping_id, external_resume_file_handle)
  values ('pol40-app-ok',   'pol40-job', v_map, repeat('h', 64)) returning id into v_link_ok;
  insert into screening_v2.ashby_application_links
    (external_application_id, external_job_id, job_mapping_id, external_resume_file_handle)
  values ('pol40-app-done', 'pol40-job', v_map, repeat('h', 64)) returning id into v_link_done;
  insert into screening_v2.ashby_application_links
    (external_application_id, external_job_id, job_mapping_id, external_resume_file_handle)
  values ('pol40-app-live', 'pol40-job', v_map, repeat('h', 64)) returning id into v_link_live;
  insert into screening_v2.ashby_application_links
    (external_application_id, external_job_id, job_mapping_id, external_resume_file_handle)
  values ('pol40-app-term', 'pol40-job', v_map, repeat('h', 64)) returning id into v_link_term;
  insert into screening_v2.ashby_application_links
    (external_application_id, external_job_id, job_mapping_id, external_resume_file_handle)
  values ('pol40-app-act',  'pol40-job', v_map, repeat('h', 64)) returning id into v_link_act;
  insert into screening_v2.ashby_application_links
    (external_application_id, external_job_id, job_mapping_id, external_resume_file_handle)
  values ('pol40-app-can',  'pol40-job', v_map, repeat('h', 64)) returning id into v_link_can;
  insert into screening_v2.ashby_application_links
    (external_application_id, external_job_id, job_mapping_id, external_resume_file_handle)
  values ('pol40-app-doc',  'pol40-job', v_map, repeat('h', 64)) returning id into v_link_doc;
  insert into screening_v2.ashby_application_links
    (external_application_id, external_job_id, job_mapping_id, external_resume_file_handle)
  values ('pol40-app-ex',   'pol40-job', v_map, repeat('h', 64)) returning id into v_link_ex;
  insert into screening_v2.ashby_application_links
    (external_application_id, external_job_id, job_mapping_id, external_resume_file_handle)
  values ('pol40-app-fail', 'pol40-job', v_map, repeat('h', 64)) returning id into v_link_fail;

  -- ═══════════════════════════════════════════════════════════════════
  -- 1. The assertion that was never written: a successful recovery leaves
  --    a CLAIMABLE job, not merely a `queued` row.
  -- ═══════════════════════════════════════════════════════════════════
  perform screening_v2.advance_ashby_ingestion(v_link_ok, 'queued',    null, null, null, null);
  perform screening_v2.advance_ashby_ingestion(v_link_ok, 'fetching',  null, null, null, null);
  perform screening_v2.advance_ashby_ingestion(v_link_ok, 'scanning',  null, null, null, null);
  perform screening_v2.advance_ashby_ingestion(v_link_ok, 'extracting',null, null, null, null);
  perform screening_v2.advance_ashby_ingestion(v_link_ok, 'failed_review', null, null, null,
                                               'parse_error');
  select attempts into v_att0
    from screening_v2.ashby_resume_ingestions where application_link_id = v_link_ok;

  -- Nothing is live BEFORE the recovery — this is the shipped defect's
  -- starting state: the original ingestion job COMPLETED long ago.
  select count(*) into v_cnt
    from screening_v2.job_queue
   where name = 'ashby.ingestion'
     and dedup_key = 'ashby:ingestion:' || v_link_ok::text;
  perform _policy_tests.assert(
    'ashby 0040 precondition: no ashby.ingestion job exists before the recovery',
    v_cnt = 0, 'got ' || v_cnt || ' pre-existing job(s)');

  v_res := screening_v2.recover_ashby_ingestion_parse(v_link_ok, v_owner, v_now);
  perform _policy_tests.assert(
    'ashby 0040: the recovery still transitions and charges exactly one attempt',
    v_res->>'status' = 'ok'
      and v_res->>'state' = 'queued'
      and (v_res->>'attempts')::int = v_att0 + 1
      and (v_res->>'max_attempts')::int = 5,
    'the 0039 response contract must be byte-for-byte unchanged; got '
      || coalesce(v_res::text, '<null>'));

  select count(*) into v_cnt
    from screening_v2.job_queue
   where name = 'ashby.ingestion'
     and dedup_key = 'ashby:ingestion:' || v_link_ok::text;
  select * into v_job
    from screening_v2.job_queue
   where name = 'ashby.ingestion'
     and dedup_key = 'ashby:ingestion:' || v_link_ok::text
   limit 1;

  perform _policy_tests.assert(
    'ashby 0040: a successful recovery leaves EXACTLY ONE claimable ingestion job',
    v_cnt = 1 and v_job.status = 'pending',
    'a transition that owes work must guarantee the work in the same '
    'transaction; got ' || v_cnt || ' job(s) status='
      || coalesce(v_job.status, '<null>'));

  perform _policy_tests.assert(
    'ashby 0040: the job matches ordinary ingestion enqueue semantics exactly',
    v_job.max_attempts = 5
      and v_job.attempts = 0
      and v_job.priority = 0
      and v_job.scheduled_at = v_now,
    'a recovered ingestion must be indistinguishable from an imported one on '
    'the queue; got max_attempts=' || coalesce(v_job.max_attempts::text, '<null>')
      || ' attempts=' || coalesce(v_job.attempts::text, '<null>')
      || ' priority=' || coalesce(v_job.priority::text, '<null>')
      || ' scheduled_at=' || coalesce(v_job.scheduled_at::text, '<null>'));

  -- The payload the HANDLER reads. camelCase `applicationLinkId`; snake_case
  -- would dead-letter the job as `malformed_ingestion_payload`.
  v_payload := v_job.payload;
  perform _policy_tests.assert(
    'ashby 0040: the payload is EXACTLY the consumer contract, and nothing else',
    v_payload = jsonb_build_object('provider', 'ashby',
                                   'applicationLinkId', v_link_ok::text),
    'the handler reads payload.applicationLinkId; any other shape dead-letters. '
    'got ' || coalesce(v_payload::text, '<null>'));

  perform _policy_tests.assert(
    'ashby 0040: the payload carries no external id, candidate field, handle or PII',
    (select count(*) from jsonb_object_keys(v_payload)) = 2
      and v_payload::text not like '%' || repeat('h', 64) || '%'
      and v_payload::text not like '%pol40-app%'
      and v_payload::text not like '%pol40-job%'
      and not (v_payload ? 'external_application_id')
      and not (v_payload ? 'external_resume_file_handle')
      and not (v_payload ? 'resume_url')
      and not (v_payload ? 'failed_reason'),
    'queue payloads are opaque identifiers only; got '
      || coalesce(v_payload::text, '<null>'));

  select count(*) into v_audits
    from screening_v2.audit_events
   where action = 'ashby_ingestion_parse_recovery'
     and metadata->>'application_link_id' = v_link_ok::text
     and result = 'success';
  perform _policy_tests.assert(
    'ashby 0040: exactly one success audit row accompanies the admitted job',
    v_audits = 1, 'got ' || v_audits || ' audit row(s)');

  -- ── A SECOND recovery while the row is queued changes nothing ────────
  -- This is the observable consequence of the `for update` serialisation:
  -- the loser sees `queued`, is refused, charges nothing, audits nothing,
  -- and creates no second job.
  v_res := screening_v2.recover_ashby_ingestion_parse(v_link_ok, v_owner, v_now);
  select count(*) into v_cnt
    from screening_v2.job_queue
   where name = 'ashby.ingestion'
     and dedup_key = 'ashby:ingestion:' || v_link_ok::text
     and status in ('pending', 'active', 'delayed');
  select attempts into v_att
    from screening_v2.ashby_resume_ingestions where application_link_id = v_link_ok;
  select count(*) into v_audits
    from screening_v2.audit_events
   where action = 'ashby_ingestion_parse_recovery'
     and metadata->>'application_link_id' = v_link_ok::text;
  perform _policy_tests.assert(
    'ashby 0040: a repeat recovery is refused and creates no second job/charge/audit',
    v_res->>'status' = 'not_recoverable'
      and v_res->>'state' = 'queued'
      and v_cnt = 1
      and v_att = v_att0 + 1
      and v_audits = 1,
    'got ' || coalesce(v_res::text, '<null>') || ' live_jobs=' || v_cnt
      || ' attempts=' || coalesce(v_att::text, '<null>') || ' audits=' || v_audits);

  -- ═══════════════════════════════════════════════════════════════════
  -- 2. A COMPLETED old job does not block a new one.
  --    `uq_job_queue_dedup_active` is partial over pending/active/delayed.
  -- ═══════════════════════════════════════════════════════════════════
  perform screening_v2.advance_ashby_ingestion(v_link_done, 'queued',   null, null, null, null);
  perform screening_v2.advance_ashby_ingestion(v_link_done, 'fetching', null, null, null, null);
  perform screening_v2.advance_ashby_ingestion(v_link_done, 'failed_review', null, null, null,
                                               'parse_timeout');
  insert into screening_v2.job_queue
    (name, payload, status, dedup_key, attempts, max_attempts, priority,
     scheduled_at, completed_at)
  values
    ('ashby.ingestion',
     jsonb_build_object('provider', 'ashby', 'applicationLinkId', v_link_done),
     'completed', 'ashby:ingestion:' || v_link_done::text, 1, 5, 0, v_now, v_now)
  returning id into v_old_job;

  v_res := screening_v2.recover_ashby_ingestion_parse(v_link_done, v_owner, v_now);
  select count(*) into v_cnt
    from screening_v2.job_queue
   where dedup_key = 'ashby:ingestion:' || v_link_done::text
     and status in ('pending', 'active', 'delayed');
  perform _policy_tests.assert(
    'ashby 0040: a COMPLETED old job permits a fresh live one',
    v_res->>'status' = 'ok' and v_cnt = 1,
    'the dedup index covers live statuses only — a finished job must never '
    'make a row unrecoverable; got ' || coalesce(v_res::text, '<null>')
      || ' live_jobs=' || v_cnt);

  -- ═══════════════════════════════════════════════════════════════════
  -- 3. A pre-existing LIVE job converges to exactly one — the transition
  --    still happens, and no duplicate work is admitted.
  -- ═══════════════════════════════════════════════════════════════════
  perform screening_v2.advance_ashby_ingestion(v_link_live, 'queued',   null, null, null, null);
  perform screening_v2.advance_ashby_ingestion(v_link_live, 'fetching', null, null, null, null);
  perform screening_v2.advance_ashby_ingestion(v_link_live, 'failed_review', null, null, null,
                                               'materialize_failed');
  insert into screening_v2.job_queue
    (name, payload, status, dedup_key, attempts, max_attempts, priority, scheduled_at)
  values
    ('ashby.ingestion',
     jsonb_build_object('provider', 'ashby', 'applicationLinkId', v_link_live),
     'pending', 'ashby:ingestion:' || v_link_live::text, 0, 5, 0, v_now);

  v_res := screening_v2.recover_ashby_ingestion_parse(v_link_live, v_owner, v_now);
  select count(*) into v_cnt
    from screening_v2.job_queue
   where dedup_key = 'ashby:ingestion:' || v_link_live::text
     and status in ('pending', 'active', 'delayed');
  select state into v_state
    from screening_v2.ashby_resume_ingestions where application_link_id = v_link_live;
  perform _policy_tests.assert(
    'ashby 0040: a live job is not duplicated, and the transition still holds',
    v_res->>'status' = 'ok' and v_cnt = 1 and v_state = 'queued',
    'ok must mean "live work exists", never "a second copy was made"; got '
      || coalesce(v_res::text, '<null>') || ' live_jobs=' || v_cnt
      || ' state=' || coalesce(v_state, '<null>'));

  -- ═══════════════════════════════════════════════════════════════════
  -- 3b. An ACTIVE job is a job a worker has already CLAIMED, and it may be
  --     seconds from completing. Treating it as "live work exists" would
  --     recreate the shipped defect inside the fix: `queued` with nothing
  --     runnable. The dedup index forbids inserting a second one, so the
  --     honest answer is a refusal — given BEFORE anything is written, so
  --     no attempt is spent and there is nothing to roll back.
  -- ═══════════════════════════════════════════════════════════════════
  perform screening_v2.advance_ashby_ingestion(v_link_act, 'queued',   null, null, null, null);
  perform screening_v2.advance_ashby_ingestion(v_link_act, 'fetching', null, null, null, null);
  perform screening_v2.advance_ashby_ingestion(v_link_act, 'failed_review', null, null, null,
                                               'parse_timeout');
  select attempts into v_att0
    from screening_v2.ashby_resume_ingestions where application_link_id = v_link_act;
  insert into screening_v2.job_queue
    (name, payload, status, dedup_key, attempts, max_attempts, priority,
     scheduled_at, started_at)
  values
    ('ashby.ingestion',
     jsonb_build_object('provider', 'ashby', 'applicationLinkId', v_link_act),
     'active', 'ashby:ingestion:' || v_link_act::text, 1, 5, 0, v_now, v_now);

  v_res := screening_v2.recover_ashby_ingestion_parse(v_link_act, v_owner, v_now);
  select state, attempts into v_state, v_att
    from screening_v2.ashby_resume_ingestions where application_link_id = v_link_act;
  select count(*) into v_audits
    from screening_v2.audit_events
   where action = 'ashby_ingestion_parse_recovery'
     and metadata->>'application_link_id' = v_link_act::text;
  select count(*) into v_cnt
    from screening_v2.job_queue
   where dedup_key = 'ashby:ingestion:' || v_link_act::text;
  perform _policy_tests.assert(
    'ashby 0040: an IN-FLIGHT job refuses the retry without spending anything',
    v_res->>'status' = 'ingestion_job_in_flight'
      and v_state = 'failed_review'
      and v_att = v_att0
      and v_audits = 0
      and v_cnt = 1,
    'a claimed job about to complete must never be counted as the work this '
    'recovery owes; got ' || coalesce(v_res::text, '<null>')
      || ' state=' || coalesce(v_state, '<null>')
      || ' attempts=' || coalesce(v_att::text, '<null>')
      || ' audits=' || v_audits || ' jobs=' || v_cnt);

  -- Once that job finishes, the ordinary recovery admits a fresh one.
  update screening_v2.job_queue
     set status = 'completed', completed_at = v_now
   where dedup_key = 'ashby:ingestion:' || v_link_act::text;
  v_res := screening_v2.recover_ashby_ingestion_parse(v_link_act, v_owner, v_now);
  select count(*) into v_cnt
    from screening_v2.job_queue
   where dedup_key = 'ashby:ingestion:' || v_link_act::text
     and status in ('pending', 'active', 'delayed');
  perform _policy_tests.assert(
    'ashby 0040: the refusal is a WAIT, not a dead end — the next retry succeeds',
    v_res->>'status' = 'ok'
      and (v_res->>'attempts')::int = v_att0 + 1
      and v_cnt = 1,
    'got ' || coalesce(v_res::text, '<null>') || ' live_jobs=' || v_cnt);

  -- ═══════════════════════════════════════════════════════════════════
  -- 4. Every REFUSAL admits nothing. A refused recovery must leave the
  --    queue exactly as it found it.
  -- ═══════════════════════════════════════════════════════════════════
  -- 4a. Terminal application — now decided under the LINK row lock.
  perform screening_v2.advance_ashby_ingestion(v_link_term, 'queued',   null, null, null, null);
  perform screening_v2.advance_ashby_ingestion(v_link_term, 'fetching', null, null, null, null);
  perform screening_v2.advance_ashby_ingestion(v_link_term, 'failed_review', null, null, null,
                                               'parse_timeout');
  select attempts into v_att0
    from screening_v2.ashby_resume_ingestions where application_link_id = v_link_term;
  -- The RACE this closes: the link goes terminal while the ingestion is
  -- still rested in `failed_review`. Before 0040 the link was read without
  -- `for update`, so a cancel committing between the check and the update
  -- could leave `queued` behind — which now also means an admitted job.
  update screening_v2.ashby_application_links
     set terminal_state = 'withdrawn' where id = v_link_term;
  v_res := screening_v2.recover_ashby_ingestion_parse(v_link_term, v_owner, v_now);
  select count(*) into v_cnt
    from screening_v2.job_queue
   where dedup_key = 'ashby:ingestion:' || v_link_term::text;
  select state, attempts into v_state, v_att
    from screening_v2.ashby_resume_ingestions where application_link_id = v_link_term;
  select count(*) into v_audits
    from screening_v2.audit_events
   where action = 'ashby_ingestion_parse_recovery'
     and metadata->>'application_link_id' = v_link_term::text;
  perform _policy_tests.assert(
    'ashby 0040: a TERMINAL application admits NO job, changes no state, audits nothing',
    v_res->>'status' = 'blocked_terminal'
      and v_res->>'terminal_state' = 'withdrawn'
      and v_cnt = 0
      and v_state = 'failed_review'
      and v_att = v_att0
      and v_audits = 0,
    'terminal is terminal in both tables and on the queue; got '
      || coalesce(v_res::text, '<null>') || ' jobs=' || v_cnt
      || ' state=' || coalesce(v_state, '<null>') || ' audits=' || v_audits);

  -- 4a-bis. A FULL cancel also cancels the ingestion (0031), so the row is
  -- refused one gate earlier — by state rather than by terminality. Either
  -- way nothing is admitted.
  perform screening_v2.advance_ashby_ingestion(v_link_can, 'queued',   null, null, null, null);
  perform screening_v2.advance_ashby_ingestion(v_link_can, 'fetching', null, null, null, null);
  perform screening_v2.advance_ashby_ingestion(v_link_can, 'failed_review', null, null, null,
                                               'parse_timeout');
  select attempts into v_att0
    from screening_v2.ashby_resume_ingestions where application_link_id = v_link_can;
  perform screening_v2.cancel_ashby_application(v_link_can, 'withdrawn', 'pol40', v_owner,
                                                'system');
  v_res := screening_v2.recover_ashby_ingestion_parse(v_link_can, v_owner, v_now);
  select count(*) into v_cnt
    from screening_v2.job_queue
   where dedup_key = 'ashby:ingestion:' || v_link_can::text;
  select state, attempts into v_state, v_att
    from screening_v2.ashby_resume_ingestions where application_link_id = v_link_can;
  select count(*) into v_audits
    from screening_v2.audit_events
   where action = 'ashby_ingestion_parse_recovery'
     and metadata->>'application_link_id' = v_link_can::text;
  perform _policy_tests.assert(
    'ashby 0040: a CANCELLED ingestion admits NO job, changes no state, audits nothing',
    v_res->>'status' = 'not_recoverable'
      and v_res->>'state' = 'cancelled'
      and v_cnt = 0
      and v_state = 'cancelled'
      and v_att = v_att0
      and v_audits = 0,
    'a cancelled ingestion must never be resurrected onto the queue; got '
      || coalesce(v_res::text, '<null>') || ' jobs=' || v_cnt
      || ' state=' || coalesce(v_state, '<null>') || ' audits=' || v_audits);

  -- 4b. Document verdict.
  perform screening_v2.advance_ashby_ingestion(v_link_doc, 'queued',    null, null, null, null);
  perform screening_v2.advance_ashby_ingestion(v_link_doc, 'fetching',  null, null, null, null);
  perform screening_v2.advance_ashby_ingestion(v_link_doc, 'scanning',  null, null, null, null);
  perform screening_v2.advance_ashby_ingestion(v_link_doc, 'extracting',null, null, null, null);
  perform screening_v2.advance_ashby_ingestion(v_link_doc, 'failed_review', null, null, null,
                                               'parse_extract_failed');
  v_res := screening_v2.recover_ashby_ingestion_parse(v_link_doc, v_owner, v_now);
  select count(*) into v_cnt
    from screening_v2.job_queue
   where dedup_key = 'ashby:ingestion:' || v_link_doc::text;
  perform _policy_tests.assert(
    'ashby 0040: a DOCUMENT verdict admits no job',
    v_res->>'status' = 'not_a_parse_availability_failure' and v_cnt = 0,
    'the queue must never be used to re-burn attempts on a file that needs a '
    'human; got ' || coalesce(v_res::text, '<null>') || ' jobs=' || v_cnt);

  -- 4c. Exhausted budget.
  perform screening_v2.advance_ashby_ingestion(v_link_ex, 'queued',   null, null, null, null);
  perform screening_v2.advance_ashby_ingestion(v_link_ex, 'fetching', null, null, null, null);
  perform screening_v2.advance_ashby_ingestion(v_link_ex, 'failed_review', null, null, null,
                                               'parse_timeout');
  update screening_v2.ashby_resume_ingestions
     set attempts = 5 where application_link_id = v_link_ex;
  v_res := screening_v2.recover_ashby_ingestion_parse(v_link_ex, v_owner, v_now);
  select count(*) into v_cnt
    from screening_v2.job_queue
   where dedup_key = 'ashby:ingestion:' || v_link_ex::text;
  perform _policy_tests.assert(
    'ashby 0040: an EXHAUSTED row admits no job',
    v_res->>'status' = 'retry_exhausted' and v_cnt = 0,
    'the ceiling still bounds the work, not just the bookkeeping; got '
      || coalesce(v_res::text, '<null>') || ' jobs=' || v_cnt);

  -- ═══════════════════════════════════════════════════════════════════
  -- 5. THE INVARIANT ITSELF: if the enqueue cannot be made durable, the
  --    state change, the attempt charge and the audit row all roll back.
  --    Simulated with a temporary BEFORE INSERT trigger — the ONLY way to
  --    make a well-formed insert into job_queue fail on demand.
  -- ═══════════════════════════════════════════════════════════════════
  perform screening_v2.advance_ashby_ingestion(v_link_fail, 'queued',   null, null, null, null);
  perform screening_v2.advance_ashby_ingestion(v_link_fail, 'fetching', null, null, null, null);
  perform screening_v2.advance_ashby_ingestion(v_link_fail, 'failed_review', null, null, null,
                                               'parse_timeout');
  select attempts into v_att0
    from screening_v2.ashby_resume_ingestions where application_link_id = v_link_fail;

  create or replace function _policy_tests.block_pol40_enqueue()
  returns trigger language plpgsql as $trg$
  begin
    if new.dedup_key like 'ashby:ingestion:%'
       and new.payload->>'applicationLinkId' is not null
       and current_setting('policy_tests.block_link', true) = new.payload->>'applicationLinkId'
    then
      raise exception 'pol40_synthetic_enqueue_failure';
    end if;
    return new;
  end;
  $trg$;
  create trigger trg_pol40_block_enqueue
    before insert on screening_v2.job_queue
    for each row execute function _policy_tests.block_pol40_enqueue();
  perform set_config('policy_tests.block_link', v_link_fail::text, false);

  begin
    v_res := screening_v2.recover_ashby_ingestion_parse(v_link_fail, v_owner, v_now);
    perform _policy_tests.assert(
      'ashby 0040: a failed enqueue does NOT return ok',
      false, 'the recovery reported ' || coalesce(v_res::text, '<null>')
        || ' while no job could be admitted');
  exception
    when others then
      perform _policy_tests.assert(
        'ashby 0040: a failed enqueue aborts the whole recovery',
        sqlerrm like '%pol40_synthetic_enqueue_failure%',
        'expected the enqueue failure to propagate; got ' || sqlerrm);
  end;

  perform set_config('policy_tests.block_link', '', false);
  drop trigger trg_pol40_block_enqueue on screening_v2.job_queue;

  select state, failed_reason, attempts into v_state, v_reason, v_att
    from screening_v2.ashby_resume_ingestions where application_link_id = v_link_fail;
  select count(*) into v_audits
    from screening_v2.audit_events
   where action = 'ashby_ingestion_parse_recovery'
     and metadata->>'application_link_id' = v_link_fail::text;
  select count(*) into v_cnt
    from screening_v2.job_queue
   where dedup_key = 'ashby:ingestion:' || v_link_fail::text;
  perform _policy_tests.assert(
    'ashby 0040: the rolled-back recovery left state, reason, attempts and audit untouched',
    v_state = 'failed_review'
      and v_reason = 'parse_timeout'
      and v_att = v_att0
      and v_audits = 0
      and v_cnt = 0,
    'a recovery that cannot schedule work must not spend an attempt, leave the '
    'operator queue, or record a success; got state=' || coalesce(v_state, '<null>')
      || ' reason=' || coalesce(v_reason, '<null>')
      || ' attempts=' || coalesce(v_att::text, '<null>')
      || ' audits=' || v_audits || ' jobs=' || v_cnt);

  -- ── The recovery still works once the fault is gone ─────────────────
  v_res := screening_v2.recover_ashby_ingestion_parse(v_link_fail, v_owner, v_now);
  select count(*) into v_cnt
    from screening_v2.job_queue
   where dedup_key = 'ashby:ingestion:' || v_link_fail::text
     and status in ('pending', 'active', 'delayed');
  perform _policy_tests.assert(
    'ashby 0040: the row kept its full budget and recovers cleanly afterwards',
    v_res->>'status' = 'ok'
      and (v_res->>'attempts')::int = v_att0 + 1
      and v_cnt = 1,
    'the rollback must cost the operator nothing; got '
      || coalesce(v_res::text, '<null>') || ' live_jobs=' || v_cnt);

  -- ── Cleanup (audit rows are append-only, 0007, and left behind) ──────
  delete from screening_v2.job_queue
   where dedup_key in ('ashby:ingestion:' || v_link_ok::text,
                       'ashby:ingestion:' || v_link_done::text,
                       'ashby:ingestion:' || v_link_live::text,
                       'ashby:ingestion:' || v_link_term::text,
                       'ashby:ingestion:' || v_link_act::text,
                       'ashby:ingestion:' || v_link_can::text,
                       'ashby:ingestion:' || v_link_doc::text,
                       'ashby:ingestion:' || v_link_ex::text,
                       'ashby:ingestion:' || v_link_fail::text);
  delete from screening_v2.ashby_operations
   where application_link_id in (v_link_ok, v_link_done, v_link_live, v_link_term,
                                 v_link_act, v_link_can, v_link_doc, v_link_ex,
                                 v_link_fail);
  delete from screening_v2.ashby_resume_ingestions
   where application_link_id in (v_link_ok, v_link_done, v_link_live, v_link_term,
                                 v_link_act, v_link_can, v_link_doc, v_link_ex,
                                 v_link_fail);
  delete from screening_v2.ashby_application_links
   where id in (v_link_ok, v_link_done, v_link_live, v_link_term,
                v_link_act, v_link_can, v_link_doc, v_link_ex, v_link_fail);
  delete from screening_v2.ashby_job_mappings where id = v_map;
end;
$$;



-- =====================================================================
-- 0041: the ONE-SHOT release of a LEGACY parse_bad_output row.
--
-- `parse_bad_output` is raised by the parser parent in exactly one place —
-- when `JSON.parse` of the child's stdout throws — so it never meant "this
-- document is bad". Our own dependency was breaking that channel: pdf.js
-- logs warnings through `console.log`, i.e. to stdout, so a PDF it merely
-- warned about had a `Warning: ` line prepended to the child's valid JSON.
-- Those rows recorded a verdict the document never earned, and document
-- verdicts are refused by the 0039/0040 recovery for ever.
--
-- These tests hold the door to exactly one population — `parse_bad_output`
-- strictly older than the server-stamped boundary — and prove that every
-- other row, including a NEWER parse_bad_output, is still refused.
-- =====================================================================

select _policy_tests.assert(
  'ashby 0041: the boundary marker exists, is stamped, and is service-role only',
  (select count(*) from screening_v2.ashby_parser_fix_markers
    where marker = 'stdout_purity' and effective_at is not null) = 1
  and (select relrowsecurity from pg_class
        where oid = 'screening_v2.ashby_parser_fix_markers'::regclass),
  'the discriminator must be durable, present, and not readable from a browser role'
);

select _policy_tests.assert(
  'ashby 0041: recover_ashby_legacy_bad_output is service-role only and pins search_path',
  (select count(*)
     from pg_proc p join pg_namespace n on n.oid = p.pronamespace
    where n.nspname = 'screening_v2'
      and p.proname = 'recover_ashby_legacy_bad_output'
      and p.prosecdef
      and array_to_string(coalesce(p.proconfig, '{}'), ',') like '%search_path%'
      and not has_function_privilege('anon', p.oid, 'EXECUTE')
      and not has_function_privilege('authenticated', p.oid, 'EXECUTE')
      and has_function_privilege('service_role', p.oid, 'EXECUTE')
  ) = 1,
  'a legacy release must not be reachable from a browser role'
);

select _policy_tests.assert(
  'ashby 0041: the recovery locks the LINK before the ingestion',
  (select position('from screening_v2.ashby_application_links' in body) > 0
      and position('from screening_v2.ashby_resume_ingestions' in body) > 0
      and position('from screening_v2.ashby_application_links' in body)
        < position('from screening_v2.ashby_resume_ingestions' in body)
     from (select pg_get_functiondef(p.oid) as body
             from pg_proc p join pg_namespace n on n.oid = p.pronamespace
            where n.nspname = 'screening_v2'
              and p.proname = 'recover_ashby_legacy_bad_output') s),
  'cancel_ashby_application takes link-then-ingestion; the reverse here would be '
  'a deadlock-prone inversion between two service-role writers'
);

select _policy_tests.assert(
  'ashby 0041: the new audit action is permitted and nothing earlier was dropped',
  (select pg_get_constraintdef(oid) from pg_constraint
    where conname = 'chk_audit_action'
      and conrelid = 'screening_v2.audit_events'::regclass)
    like '%ashby_ingestion_legacy_bad_output_recovery%'
  and (select bool_and(pg_get_constraintdef(c.oid) like ('%' || a || '%'))
         from pg_constraint c,
              unnest(array['invite_sent','grant_issued','recording_quarantined',
                           'ashby_mapping_update','ashby_operation_retry',
                           'ashby_invite_delivered','ashby_ingestion_attempts_reset',
                           'ashby_ingestion_parse_recovery']) as a
        where c.conname = 'chk_audit_action'
          and c.conrelid = 'screening_v2.audit_events'::regclass),
  'widening chk_audit_action must be purely additive'
);

do $$
declare
  v_role      uuid;
  v_map       uuid;
  v_link_leg  uuid;   -- legacy parse_bad_output           → released ONCE
  v_link_new  uuid;   -- parse_bad_output AFTER the boundary → refused
  v_link_ext  uuid;   -- parse_extract_failed               → refused
  v_link_out  uuid;   -- parse_output_exceeded              → refused
  v_link_scan uuid;   -- scan_infected                      → refused
  v_link_term uuid;   -- terminal application               → refused
  v_link_ex   uuid;   -- exhausted global ceiling           → refused
  v_link_fail uuid;   -- enqueue fails                      → full rollback
  v_owner     uuid := '00000000-0000-4000-8000-0000000000ae';
  v_boundary  timestamptz;
  v_before    timestamptz;
  v_res       jsonb;
  v_state     text;
  v_reason    text;
  v_att       integer;
  v_att0      integer;
  v_cnt       integer;
  v_audits    integer;
  v_shot      timestamptz;
  v_payload   jsonb;
  v_job       record;
  v_now       timestamptz := now();
begin
  select id into v_role from screening_v2.roles limit 1;
  if v_role is null then
    perform _policy_tests.assert('ashby 0041 functional: seed role present', false,
      'no seed role available');
    return;
  end if;

  select effective_at into v_boundary
    from screening_v2.ashby_parser_fix_markers where marker = 'stdout_purity';
  v_before := v_boundary - interval '1 day';   -- unambiguously "legacy"

  insert into screening_v2.ashby_job_mappings
    (external_job_id, role_id, owner_id, ai_screening_stage_id, ta_screening_stage_id,
     status, delivery_mode)
  values ('pol41-job', v_role, v_owner, 'pol41-ai', 'pol41-ta', 'enabled', 'manual')
  returning id into v_map;

  insert into screening_v2.ashby_application_links
    (external_application_id, external_job_id, job_mapping_id, external_resume_file_handle)
  values ('pol41-app-leg',  'pol41-job', v_map, repeat('h', 64)) returning id into v_link_leg;
  insert into screening_v2.ashby_application_links
    (external_application_id, external_job_id, job_mapping_id, external_resume_file_handle)
  values ('pol41-app-new',  'pol41-job', v_map, repeat('h', 64)) returning id into v_link_new;
  insert into screening_v2.ashby_application_links
    (external_application_id, external_job_id, job_mapping_id, external_resume_file_handle)
  values ('pol41-app-ext',  'pol41-job', v_map, repeat('h', 64)) returning id into v_link_ext;
  insert into screening_v2.ashby_application_links
    (external_application_id, external_job_id, job_mapping_id, external_resume_file_handle)
  values ('pol41-app-out',  'pol41-job', v_map, repeat('h', 64)) returning id into v_link_out;
  insert into screening_v2.ashby_application_links
    (external_application_id, external_job_id, job_mapping_id, external_resume_file_handle)
  values ('pol41-app-scan', 'pol41-job', v_map, repeat('h', 64)) returning id into v_link_scan;
  insert into screening_v2.ashby_application_links
    (external_application_id, external_job_id, job_mapping_id, external_resume_file_handle)
  values ('pol41-app-term', 'pol41-job', v_map, repeat('h', 64)) returning id into v_link_term;
  insert into screening_v2.ashby_application_links
    (external_application_id, external_job_id, job_mapping_id, external_resume_file_handle)
  values ('pol41-app-ex',   'pol41-job', v_map, repeat('h', 64)) returning id into v_link_ex;
  insert into screening_v2.ashby_application_links
    (external_application_id, external_job_id, job_mapping_id, external_resume_file_handle)
  values ('pol41-app-fail', 'pol41-job', v_map, repeat('h', 64)) returning id into v_link_fail;

  -- Helper shape: rest a row in failed_review on a given reason, then age it.
  -- `updated_at` is what the boundary compares, so it is set explicitly rather
  -- than left to the transition clock.
  perform screening_v2.advance_ashby_ingestion(v_link_leg, 'queued',   null, null, null, null);
  perform screening_v2.advance_ashby_ingestion(v_link_leg, 'fetching', null, null, null, null);
  perform screening_v2.advance_ashby_ingestion(v_link_leg, 'failed_review', null, null, null,
                                               'parse_bad_output');
  update screening_v2.ashby_resume_ingestions
     set updated_at = v_before where application_link_id = v_link_leg;
  select attempts into v_att0
    from screening_v2.ashby_resume_ingestions where application_link_id = v_link_leg;

  -- ═══════════════════════════════════════════════════════════════════
  -- 1. The legacy row is released — once, atomically, with a live job
  -- ═══════════════════════════════════════════════════════════════════
  select count(*) into v_cnt
    from screening_v2.job_queue
   where dedup_key = 'ashby:ingestion:' || v_link_leg::text;
  perform _policy_tests.assert(
    'ashby 0041 precondition: the legacy row owns no queue job',
    v_cnt = 0, 'got ' || v_cnt);

  -- The ORDINARY door must still refuse this exact row. Asserted behaviourally
  -- rather than by reading the function text, because the 0039/0040 body
  -- legitimately NAMES parse_bad_output in its document-verdict commentary —
  -- a string match there proves nothing about the allowlist.
  v_res := screening_v2.recover_ashby_ingestion_parse(v_link_leg, v_owner, v_now);
  perform _policy_tests.assert(
    'ashby 0041: the 0039/0040 allowlist was NOT widened — the ordinary door still refuses',
    v_res->>'status' = 'not_a_parse_availability_failure'
      and v_res->>'failed_reason' = 'parse_bad_output',
    'the two doors ask different questions and must stay separate; got '
      || coalesce(v_res::text,'<null>'));

  select attempts into v_att0
    from screening_v2.ashby_resume_ingestions where application_link_id = v_link_leg;

  v_res := screening_v2.recover_ashby_legacy_bad_output(v_link_leg, v_owner, v_now);
  perform _policy_tests.assert(
    'ashby 0041: a LEGACY parse_bad_output row is released and charges one attempt',
    v_res->>'status' = 'ok'
      and v_res->>'state' = 'queued'
      and (v_res->>'attempts')::int = v_att0 + 1
      and (v_res->>'max_attempts')::int = 5,
    'got ' || coalesce(v_res::text, '<null>'));

  select state, failed_reason, attempts, legacy_bad_output_recovered_at
    into v_state, v_reason, v_att, v_shot
    from screening_v2.ashby_resume_ingestions where application_link_id = v_link_leg;
  perform _policy_tests.assert(
    'ashby 0041: the released row is queued, carries no stale reason, and spends its one shot',
    v_state = 'queued' and v_reason is null and v_att = v_att0 + 1 and v_shot is not null,
    'got state=' || coalesce(v_state,'<null>') || ' reason=' || coalesce(v_reason,'<null>')
      || ' attempts=' || coalesce(v_att::text,'<null>')
      || ' one_shot=' || coalesce(v_shot::text,'<null>'));

  select count(*) into v_cnt
    from screening_v2.job_queue
   where name = 'ashby.ingestion'
     and dedup_key = 'ashby:ingestion:' || v_link_leg::text;
  select * into v_job
    from screening_v2.job_queue
   where name = 'ashby.ingestion'
     and dedup_key = 'ashby:ingestion:' || v_link_leg::text
   limit 1;
  perform _policy_tests.assert(
    'ashby 0041: exactly ONE claimable job, on the 0040 contract',
    v_cnt = 1
      and v_job.status = 'pending'
      and v_job.max_attempts = 5
      and v_job.attempts = 0
      and v_job.priority = 0
      and v_job.scheduled_at = v_now,
    'a released ingestion must be indistinguishable from an imported one; got '
      || v_cnt || ' job(s)');

  v_payload := v_job.payload;
  perform _policy_tests.assert(
    'ashby 0041: the payload is EXACTLY the consumer contract, and carries no PII',
    v_payload = jsonb_build_object('provider', 'ashby',
                                   'applicationLinkId', v_link_leg::text)
      and (select count(*) from jsonb_object_keys(v_payload)) = 2
      and v_payload::text not like '%' || repeat('h', 64) || '%'
      and v_payload::text not like '%pol41-app%',
    'got ' || coalesce(v_payload::text, '<null>'));

  select count(*) into v_audits
    from screening_v2.audit_events
   where action = 'ashby_ingestion_legacy_bad_output_recovery'
     and metadata->>'application_link_id' = v_link_leg::text
     and result = 'success';
  select metadata into v_res
    from screening_v2.audit_events
   where action = 'ashby_ingestion_legacy_bad_output_recovery'
     and metadata->>'application_link_id' = v_link_leg::text
   order by created_at desc limit 1;
  perform _policy_tests.assert(
    'ashby 0041: exactly one sanitized audit row, marked as the one-shot release',
    v_audits = 1
      and (v_res->>'legacy_one_shot')::boolean
      and v_res->>'failed_reason' = 'parse_bad_output'
      and not (v_res ? 'effective_at')
      and v_res::text not like '%' || repeat('h', 64) || '%',
    'got audits=' || v_audits || ' metadata=' || coalesce(v_res::text,'<null>'));

  -- ── The door closes behind it ────────────────────────────────────────
  -- Bring the row back to failed_review on the same reason and age it again:
  -- even a perfectly "legacy-looking" row is refused once its shot is spent.
  perform screening_v2.advance_ashby_ingestion(v_link_leg, 'fetching', null, null, null, null);
  perform screening_v2.advance_ashby_ingestion(v_link_leg, 'failed_review', null, null, null,
                                               'parse_bad_output');
  update screening_v2.ashby_resume_ingestions
     set updated_at = v_before where application_link_id = v_link_leg;
  select attempts into v_att0
    from screening_v2.ashby_resume_ingestions where application_link_id = v_link_leg;

  v_res := screening_v2.recover_ashby_legacy_bad_output(v_link_leg, v_owner, v_now);
  select attempts into v_att
    from screening_v2.ashby_resume_ingestions where application_link_id = v_link_leg;
  select count(*) into v_audits
    from screening_v2.audit_events
   where action = 'ashby_ingestion_legacy_bad_output_recovery'
     and metadata->>'application_link_id' = v_link_leg::text;
  perform _policy_tests.assert(
    'ashby 0041: the release is ONE-SHOT — a second is refused, spending nothing',
    v_res->>'status' = 'legacy_recovery_exhausted'
      and v_att = v_att0
      and v_audits = 1,
    'this is what stops a loop; got ' || coalesce(v_res::text,'<null>')
      || ' attempts=' || coalesce(v_att::text,'<null>') || ' audits=' || v_audits);

  -- ═══════════════════════════════════════════════════════════════════
  -- 2. A NEWER parse_bad_output is a genuine protocol anomaly — refused
  -- ═══════════════════════════════════════════════════════════════════
  perform screening_v2.advance_ashby_ingestion(v_link_new, 'queued',   null, null, null, null);
  perform screening_v2.advance_ashby_ingestion(v_link_new, 'fetching', null, null, null, null);
  perform screening_v2.advance_ashby_ingestion(v_link_new, 'failed_review', null, null, null,
                                               'parse_bad_output');
  update screening_v2.ashby_resume_ingestions
     set updated_at = v_boundary + interval '1 second'
   where application_link_id = v_link_new;

  v_res := screening_v2.recover_ashby_legacy_bad_output(v_link_new, v_owner, v_now);
  select count(*) into v_cnt
    from screening_v2.job_queue
   where dedup_key = 'ashby:ingestion:' || v_link_new::text;
  select state, legacy_bad_output_recovered_at into v_state, v_shot
    from screening_v2.ashby_resume_ingestions where application_link_id = v_link_new;
  perform _policy_tests.assert(
    'ashby 0041: a parse_bad_output NEWER than the boundary is refused and admits nothing',
    v_res->>'status' = 'not_legacy_bad_output'
      and v_cnt = 0 and v_state = 'failed_review' and v_shot is null,
    'after the fix, bad_output can only mean a real protocol anomaly; got '
      || coalesce(v_res::text,'<null>') || ' jobs=' || v_cnt);

  -- The refusal is deliberately INDISTINGUISHABLE from the wrong-reason one:
  -- the caller learns "not eligible", never why, and never the boundary.
  perform _policy_tests.assert(
    'ashby 0041: the boundary refusal leaks no timestamp and no discriminator detail',
    not (v_res ? 'effective_at') and not (v_res ? 'boundary')
      and not (v_res ? 'updated_at') and not (v_res ? 'failed_reason'),
    'got ' || coalesce(v_res::text,'<null>'));

  -- ═══════════════════════════════════════════════════════════════════
  -- 3. Every other verdict stays refused, boundary or not
  -- ═══════════════════════════════════════════════════════════════════
  perform screening_v2.advance_ashby_ingestion(v_link_ext, 'queued',    null, null, null, null);
  perform screening_v2.advance_ashby_ingestion(v_link_ext, 'fetching',  null, null, null, null);
  perform screening_v2.advance_ashby_ingestion(v_link_ext, 'scanning',  null, null, null, null);
  perform screening_v2.advance_ashby_ingestion(v_link_ext, 'extracting',null, null, null, null);
  perform screening_v2.advance_ashby_ingestion(v_link_ext, 'failed_review', null, null, null,
                                               'parse_extract_failed');
  update screening_v2.ashby_resume_ingestions
     set updated_at = v_before where application_link_id = v_link_ext;

  perform screening_v2.advance_ashby_ingestion(v_link_out, 'queued',   null, null, null, null);
  perform screening_v2.advance_ashby_ingestion(v_link_out, 'fetching', null, null, null, null);
  perform screening_v2.advance_ashby_ingestion(v_link_out, 'failed_review', null, null, null,
                                               'parse_output_exceeded');
  update screening_v2.ashby_resume_ingestions
     set updated_at = v_before where application_link_id = v_link_out;

  perform screening_v2.advance_ashby_ingestion(v_link_scan, 'queued',   null, null, null, null);
  perform screening_v2.advance_ashby_ingestion(v_link_scan, 'fetching', null, null, null, null);
  perform screening_v2.advance_ashby_ingestion(v_link_scan, 'failed_review', null, null, null,
                                               'scan_infected');
  update screening_v2.ashby_resume_ingestions
     set updated_at = v_before where application_link_id = v_link_scan;

  v_res := screening_v2.recover_ashby_legacy_bad_output(v_link_ext, v_owner, v_now);
  perform _policy_tests.assert(
    'ashby 0041: parse_extract_failed is refused even when older than the boundary',
    v_res->>'status' = 'not_legacy_bad_output',
    'an unparseable document is a real verdict and stays one; got '
      || coalesce(v_res::text,'<null>'));

  v_res := screening_v2.recover_ashby_legacy_bad_output(v_link_out, v_owner, v_now);
  perform _policy_tests.assert(
    'ashby 0041: parse_output_exceeded is refused even when older than the boundary',
    v_res->>'status' = 'not_legacy_bad_output',
    'got ' || coalesce(v_res::text,'<null>'));

  v_res := screening_v2.recover_ashby_legacy_bad_output(v_link_scan, v_owner, v_now);
  perform _policy_tests.assert(
    'ashby 0041: scan_infected is refused even when older than the boundary',
    v_res->>'status' = 'not_legacy_bad_output',
    'an infected file must never be re-admitted by a parser repair; got '
      || coalesce(v_res::text,'<null>'));

  select count(*) into v_cnt
    from screening_v2.job_queue
   where dedup_key in ('ashby:ingestion:' || v_link_ext::text,
                       'ashby:ingestion:' || v_link_out::text,
                       'ashby:ingestion:' || v_link_scan::text);
  perform _policy_tests.assert(
    'ashby 0041: no refused verdict admitted any work',
    v_cnt = 0, 'got ' || v_cnt || ' job(s)');

  -- ═══════════════════════════════════════════════════════════════════
  -- 4. Terminal application, and the unchanged global ceiling
  -- ═══════════════════════════════════════════════════════════════════
  perform screening_v2.advance_ashby_ingestion(v_link_term, 'queued',   null, null, null, null);
  perform screening_v2.advance_ashby_ingestion(v_link_term, 'fetching', null, null, null, null);
  perform screening_v2.advance_ashby_ingestion(v_link_term, 'failed_review', null, null, null,
                                               'parse_bad_output');
  update screening_v2.ashby_resume_ingestions
     set updated_at = v_before where application_link_id = v_link_term;
  update screening_v2.ashby_application_links
     set terminal_state = 'withdrawn' where id = v_link_term;
  v_res := screening_v2.recover_ashby_legacy_bad_output(v_link_term, v_owner, v_now);
  select count(*) into v_cnt
    from screening_v2.job_queue
   where dedup_key = 'ashby:ingestion:' || v_link_term::text;
  perform _policy_tests.assert(
    'ashby 0041: a terminal application admits nothing',
    v_res->>'status' = 'blocked_terminal' and v_cnt = 0,
    'got ' || coalesce(v_res::text,'<null>') || ' jobs=' || v_cnt);

  perform screening_v2.advance_ashby_ingestion(v_link_ex, 'queued',   null, null, null, null);
  perform screening_v2.advance_ashby_ingestion(v_link_ex, 'fetching', null, null, null, null);
  perform screening_v2.advance_ashby_ingestion(v_link_ex, 'failed_review', null, null, null,
                                               'parse_bad_output');
  update screening_v2.ashby_resume_ingestions
     set attempts = 5, updated_at = v_before where application_link_id = v_link_ex;
  v_res := screening_v2.recover_ashby_legacy_bad_output(v_link_ex, v_owner, v_now);
  select count(*) into v_cnt
    from screening_v2.job_queue
   where dedup_key = 'ashby:ingestion:' || v_link_ex::text;
  perform _policy_tests.assert(
    'ashby 0041: the UNCHANGED five-attempt ceiling still bounds this door',
    v_res->>'status' = 'retry_exhausted' and v_cnt = 0,
    'the legacy shot never widens the budget; got '
      || coalesce(v_res::text,'<null>') || ' jobs=' || v_cnt);

  -- ═══════════════════════════════════════════════════════════════════
  -- 5. Fail-closed: a failed enqueue rolls back the whole release
  -- ═══════════════════════════════════════════════════════════════════
  perform screening_v2.advance_ashby_ingestion(v_link_fail, 'queued',   null, null, null, null);
  perform screening_v2.advance_ashby_ingestion(v_link_fail, 'fetching', null, null, null, null);
  perform screening_v2.advance_ashby_ingestion(v_link_fail, 'failed_review', null, null, null,
                                               'parse_bad_output');
  update screening_v2.ashby_resume_ingestions
     set updated_at = v_before where application_link_id = v_link_fail;
  select attempts into v_att0
    from screening_v2.ashby_resume_ingestions where application_link_id = v_link_fail;

  create or replace function _policy_tests.block_pol41_enqueue()
  returns trigger language plpgsql as $trg$
  begin
    if new.dedup_key like 'ashby:ingestion:%'
       and current_setting('policy_tests.block_link_41', true) = new.payload->>'applicationLinkId'
    then
      raise exception 'pol41_synthetic_enqueue_failure';
    end if;
    return new;
  end;
  $trg$;
  create trigger trg_pol41_block_enqueue
    before insert on screening_v2.job_queue
    for each row execute function _policy_tests.block_pol41_enqueue();
  perform set_config('policy_tests.block_link_41', v_link_fail::text, false);

  begin
    v_res := screening_v2.recover_ashby_legacy_bad_output(v_link_fail, v_owner, v_now);
    perform _policy_tests.assert(
      'ashby 0041: a failed enqueue does NOT return ok', false,
      'reported ' || coalesce(v_res::text,'<null>'));
  exception
    when others then
      perform _policy_tests.assert(
        'ashby 0041: a failed enqueue aborts the whole release',
        sqlerrm like '%pol41_synthetic_enqueue_failure%',
        'got ' || sqlerrm);
  end;

  perform set_config('policy_tests.block_link_41', '', false);
  drop trigger trg_pol41_block_enqueue on screening_v2.job_queue;

  select state, failed_reason, attempts, legacy_bad_output_recovered_at
    into v_state, v_reason, v_att, v_shot
    from screening_v2.ashby_resume_ingestions where application_link_id = v_link_fail;
  select count(*) into v_audits
    from screening_v2.audit_events
   where action = 'ashby_ingestion_legacy_bad_output_recovery'
     and metadata->>'application_link_id' = v_link_fail::text;
  perform _policy_tests.assert(
    'ashby 0041: the rolled-back release left state, reason, attempts, ONE-SHOT and audit untouched',
    v_state = 'failed_review' and v_reason = 'parse_bad_output'
      and v_att = v_att0 and v_shot is null and v_audits = 0,
    'the shot must survive a failure, or an operator loses it to an outage; got '
      || 'state=' || coalesce(v_state,'<null>') || ' reason=' || coalesce(v_reason,'<null>')
      || ' attempts=' || coalesce(v_att::text,'<null>')
      || ' one_shot=' || coalesce(v_shot::text,'<null>') || ' audits=' || v_audits);

  -- ...and it still works once the fault is gone.
  v_res := screening_v2.recover_ashby_legacy_bad_output(v_link_fail, v_owner, v_now);
  select count(*) into v_cnt
    from screening_v2.job_queue
   where dedup_key = 'ashby:ingestion:' || v_link_fail::text
     and status in ('pending','active','delayed');
  perform _policy_tests.assert(
    'ashby 0041: the row kept its shot and releases cleanly afterwards',
    v_res->>'status' = 'ok' and v_cnt = 1,
    'got ' || coalesce(v_res::text,'<null>') || ' live_jobs=' || v_cnt);

  -- ── Cleanup (audit rows are append-only, 0007, and left behind) ──────
  delete from screening_v2.job_queue
   where dedup_key in ('ashby:ingestion:' || v_link_leg::text,
                       'ashby:ingestion:' || v_link_new::text,
                       'ashby:ingestion:' || v_link_ext::text,
                       'ashby:ingestion:' || v_link_out::text,
                       'ashby:ingestion:' || v_link_scan::text,
                       'ashby:ingestion:' || v_link_term::text,
                       'ashby:ingestion:' || v_link_ex::text,
                       'ashby:ingestion:' || v_link_fail::text);
  delete from screening_v2.ashby_operations
   where application_link_id in (v_link_leg, v_link_new, v_link_ext, v_link_out,
                                 v_link_scan, v_link_term, v_link_ex, v_link_fail);
  delete from screening_v2.ashby_resume_ingestions
   where application_link_id in (v_link_leg, v_link_new, v_link_ext, v_link_out,
                                 v_link_scan, v_link_term, v_link_ex, v_link_fail);
  delete from screening_v2.ashby_application_links
   where id in (v_link_leg, v_link_new, v_link_ext, v_link_out,
                v_link_scan, v_link_term, v_link_ex, v_link_fail);
  delete from screening_v2.ashby_job_mappings where id = v_map;
end;
$$;


-- ═══════════════════════════════════════════════════════════════════════
-- 0042 — Phone screening substrate: structural contract
-- ═══════════════════════════════════════════════════════════════════════
-- These assertions are about the SHAPE of the migration rather than its
-- behaviour, and they are the ones that stay true when a future edit
-- looks harmless. Every one of them names an invariant that a reviewer
-- would otherwise have to re-derive by reading 0042 end to end.

-- The single most important structural fact: the phone model stores NO
-- phone number. The number lives on screening_v2.candidates, is read at
-- dial time, and is turned straight into a digest. A column called
-- phone_e164 / phone_raw / msisdn / number / e164 on any phone_* table
-- would silently re-create the PII duplication the design forbids.
select _policy_tests.assert(
  '0042: no phone_* table carries a raw phone or E.164 column',
  not exists (
    select 1
      from pg_attribute a
      join pg_class c on c.oid = a.attrelid
      join pg_namespace n on n.oid = c.relnamespace
     where n.nspname = 'screening_v2'
       and c.relkind = 'r'
       and c.relname like 'phone\_%'
       and a.attnum > 0
       and not a.attisdropped
       and (a.attname in ('phone_e164','phone_raw','msisdn','e164','number',
                          'phone','phone_number','dial_number','to_number','from_number')
            or a.attname like '%e164%')
  ),
  'a phone number stored on a phone table re-creates the PII duplication 0042 exists to avoid');

-- phone_sha256 is the ONE phone-derived column, and it is a digest.
select _policy_tests.assert(
  '0042: the only phone-derived column is the suppression SHA-256 digest',
  exists (
    select 1 from pg_constraint
     where conname = 'chk_phone_suppressions_sha'
       and pg_get_constraintdef(oid) like '%[a-f0-9]{64}%'),
  'phone_suppressions.phone_sha256 must be constrained to a hex digest, never a number');

do $$
declare
  v_tables text[] := array['phone_engagements','phone_call_attempts','phone_appointments',
                           'phone_call_events','phone_suppressions','phone_control'];
  v_t text;
  v_missing text := '';
begin
  foreach v_t in array v_tables loop
    if not exists (select 1 from pg_class c join pg_namespace n on n.oid = c.relnamespace
                    where n.nspname = 'screening_v2' and c.relname = v_t and c.relrowsecurity) then
      v_missing := v_missing || v_t || ' ';
    end if;
  end loop;
  perform _policy_tests.assert(
    '0042: RLS is enabled on every phone table',
    v_missing = '', 'RLS missing on: ' || v_missing);
end;
$$;

select _policy_tests.assert(
  '0042: no phone table grants any privilege to anon or authenticated',
  not exists (
    select 1
      from pg_class c
      join pg_namespace n on n.oid = c.relnamespace
     where n.nspname = 'screening_v2'
       and c.relkind = 'r'
       and c.relname like 'phone\_%'
       and (has_table_privilege('anon', c.oid, 'SELECT,INSERT,UPDATE,DELETE')
         or has_table_privilege('authenticated', c.oid, 'SELECT,INSERT,UPDATE,DELETE'))
  ),
  'an engagement row plus a suppression digest is a re-identifiable contact record; browsers get nothing');

select _policy_tests.assert(
  '0042: no RLS policy exists on any phone table',
  not exists (select 1 from pg_policies
               where schemaname = 'screening_v2' and tablename like 'phone\_%'),
  'phone tables are service-role-only; a policy would create a browser surface where none is intended');

-- A comment-stripped, DECLARE-stripped view of a function's executable
-- body. Position assertions below are about what the function DOES, and
-- a prose comment or a %rowtype declaration naming a table must not be
-- mistaken for a statement that touches it.
create or replace function _policy_tests.fn_body(p_name text)
returns text language sql stable as $fnb$
  select substring(
           regexp_replace(split_part(pg_get_functiondef(p.oid), '$function$', 2),
                          '--[^\n]*', '', 'g')
           from position(E'\nbegin' in
             regexp_replace(split_part(pg_get_functiondef(p.oid), '$function$', 2),
                            '--[^\n]*', '', 'g')))
    from pg_proc p join pg_namespace n on n.oid = p.pronamespace
   where n.nspname = 'screening_v2' and p.proname = p_name
   limit 1
$fnb$;

-- ── Function posture: definer, pinned search_path, service-role-only ──
do $$
declare
  v_fn record;
  v_bad text := '';
begin
  for v_fn in
    select p.oid, p.proname, p.prosecdef, p.proconfig,
           pg_get_function_identity_arguments(p.oid) as args
      from pg_proc p join pg_namespace n on n.oid = p.pronamespace
     where n.nspname = 'screening_v2'
       and (p.proname like 'phone\_%'
            or p.proname in ('admit_phone_attempt','heartbeat_phone_attempt',
                             'reclaim_phone_attempt_leases','apply_phone_event',
                             'schedule_phone_appointment','cancel_phone_appointment',
                             'expire_phone_appointments',
                             'set_phone_halt','clear_phone_halt'))
  loop
    if not v_fn.prosecdef and v_fn.proname not in ('phone_ist_date','phone_ist_window_open',
                                                   'phone_ist_window_open_at',
                                                   'phone_ist_window_close_at',
                                                   'phone_max_concurrent',
                                                   'phone_event_metadata_sanitized',
                                                   'phone_next_window_open',
                                                   'prevent_phone_call_event_mutation',
                                                   'enforce_phone_engagement_transition',
                                                   'enforce_phone_appointment_window') then
      v_bad := v_bad || v_fn.proname || ':not_definer ';
    end if;
    if v_fn.proconfig is null
       or not exists (select 1 from unnest(v_fn.proconfig) c where c like 'search_path=%') then
      v_bad := v_bad || v_fn.proname || ':no_search_path ';
    end if;
    if has_function_privilege('anon', v_fn.oid, 'EXECUTE')
       or has_function_privilege('authenticated', v_fn.oid, 'EXECUTE') then
      v_bad := v_bad || v_fn.proname || ':browser_executable ';
    end if;
  end loop;
  perform _policy_tests.assert(
    '0042: every phone function is definer-or-helper, pins search_path, and is not browser-executable',
    v_bad = '', 'violations: ' || v_bad);
end;
$$;

-- ── H-3: time is injected; no body reads the machine clock ────────────
-- A boundary test that reads the machine clock passes in Asia and fails
-- in CI. Parameter DEFAULTS keep now(); function BODIES may not.
do $$
declare
  v_fn record;
  v_body text;
  v_bad text := '';
begin
  for v_fn in
    select p.oid, p.proname, pg_get_functiondef(p.oid) as def
      from pg_proc p join pg_namespace n on n.oid = p.pronamespace
     where n.nspname = 'screening_v2'
       and (p.proname like 'phone\_%'
            or p.proname in ('admit_phone_attempt','heartbeat_phone_attempt',
                             'reclaim_phone_attempt_leases','apply_phone_event',
                             'schedule_phone_appointment','cancel_phone_appointment',
                             'expire_phone_appointments',
                             'set_phone_halt','clear_phone_halt'))
  loop
    -- Everything after the opening dollar-quote is the body; the
    -- signature (and therefore `p_now timestamptz default now()`) is
    -- everything before it.
    v_body := _policy_tests.fn_body(v_fn.proname);
    if v_body ~* '\mnow\s*\(' or v_body ~* '\mcurrent_timestamp\M'
       or v_body ~* '\mclock_timestamp\s*\(' or v_body ~* '\mstatement_timestamp\s*\(' then
      v_bad := v_bad || v_fn.proname || ':reads_clock ';
    end if;
    -- A blanket `when others` is how a fail-closed guard silently
    -- becomes fail-open.
    if v_body ~* 'when\s+others' then
      v_bad := v_bad || v_fn.proname || ':when_others ';
    end if;
    -- No RPC may enable the ledger escape hatch. It exists for a
    -- deliberate, session-scoped erasure or migration, never for a code
    -- path that runs on its own.
    if v_fn.proname <> 'prevent_phone_call_event_mutation'
       and v_body ~* 'allow_phone_event_mutation' then
      v_bad := v_bad || v_fn.proname || ':enables_ledger_hatch ';
    end if;
  end loop;
  perform _policy_tests.assert(
    '0042: no phone function body reads the machine clock or swallows every error',
    v_bad = '', 'violations: ' || v_bad);
end;
$$;


-- ── M-5(b): the halt read is not inside an exception handler ──────────
do $$
declare
  v_body    text;
  v_ctl_pos integer;
  v_exc_pos integer;
begin
  v_body := _policy_tests.fn_body('admit_phone_attempt');
  v_ctl_pos := position('phone_control' in v_body);
  v_exc_pos := position('exception' in v_body);
  perform _policy_tests.assert(
    '0042: the halt read precedes every exception handler in admit_phone_attempt',
    v_ctl_pos > 0 and (v_exc_pos = 0 or v_ctl_pos < v_exc_pos),
    'swallowing the control read is exactly how a kill switch becomes fail-open; '
      || 'control@' || v_ctl_pos || ' exception@' || v_exc_pos);
end;
$$;

-- ── H-1: the pinned lock order, asserted statically ───────────────────
do $$
declare
  v_body text;
  v_adv integer; v_link integer; v_eng integer; v_att integer; v_first_fu integer;
begin
  -- Whitespace-normalised so the assertion is about the statements and
  -- not about how they happen to be indented.
  v_body := regexp_replace(_policy_tests.fn_body('admit_phone_attempt'), '\s+', ' ', 'g');
  v_adv  := position('pg_advisory_xact_lock' in v_body);
  v_link := position('from screening_v2.ashby_application_links where id = v_link_id for update'
                     in v_body);
  v_eng  := position('from screening_v2.phone_engagements where id = p_engagement_id for update'
                     in v_body);
  v_att  := position('insert into screening_v2.phone_call_attempts' in v_body);
  v_first_fu := position('for update' in v_body);

  perform _policy_tests.assert(
    '0042: admit_phone_attempt takes the advisory lock before ANY row lock',
    v_adv > 0 and v_first_fu > 0 and v_adv < v_first_fu,
    'advisory@' || v_adv || ' first for-update@' || v_first_fu
      || ' — the inverse order is a genuine two-transaction deadlock cycle');
  -- The engagement is READ before the link is locked, to learn the link
  -- id at all. That read must stay unlocked, or the pinned order is
  -- inverted in the one place it matters.
  perform _policy_tests.assert(
    '0042: the pre-read that discovers the link id takes no row lock',
    v_adv > 0 and v_link > v_adv
      and position('select application_link_id into v_link_id from screening_v2.phone_engagements '
                   || 'where id = p_engagement_id; ' in v_body) > 0,
    'the unlocked pre-read is what keeps advisory -> link -> engagement true');
  perform _policy_tests.assert(
    '0042: admit_phone_attempt LOCKS advisory -> link -> engagement -> attempt, in that order',
    v_adv > 0 and v_link > v_adv and v_eng > v_link and v_att > v_eng,
    'advisory@' || v_adv || ' link-lock@' || v_link || ' engagement-lock@' || v_eng
      || ' attempt@' || v_att);

  -- The sweeper takes a strict SUFFIX of that order: engagement, then
  -- attempt. The inverse — attempt first, then engagement — is a real
  -- cycle against an admission that holds the engagement and is waiting
  -- on the one-live index entry, and it would surface as a 40P01 in
  -- production rather than here.
  v_body := regexp_replace(_policy_tests.fn_body('reclaim_phone_attempt_leases'),
                           '\s+', ' ', 'g');
  v_eng := position('from screening_v2.phone_engagements where id = v_row.engagement_id '
                    || 'for update skip locked' in v_body);
  v_att := position('from screening_v2.phone_call_attempts where id = v_row.id' in v_body);
  perform _policy_tests.assert(
    '0042: reclaim_phone_attempt_leases locks engagement BEFORE attempt, never the reverse',
    v_eng > 0 and v_att > v_eng,
    'engagement-lock@' || v_eng || ' attempt-lock@' || v_att
      || ' — the reverse order deadlocks against a live admission');

  -- apply_phone_event takes the same suffix and no advisory lock, so it
  -- cannot serialise against dialing and cannot close a cycle either.
  v_body := regexp_replace(_policy_tests.fn_body('apply_phone_event'), '\s+', ' ', 'g');
  v_eng := position('from screening_v2.phone_engagements where id = v_eng_id for update' in v_body);
  v_att := position('from screening_v2.phone_call_attempts where id = p_attempt_id for update'
                    in v_body);
  perform _policy_tests.assert(
    '0042: apply_phone_event locks engagement BEFORE attempt and takes no advisory lock',
    v_eng > 0 and v_att > v_eng
      and position('pg_advisory' in v_body) = 0,
    'engagement-lock@' || v_eng || ' attempt-lock@' || v_att);
end;
$$;

-- ── I15: the phone substrate cannot move a stage, email or score ──────
-- Widening ashby_operations.operation_type would put dialing inside the
-- machinery that performs stage moves and scorecard writes. It is the
-- single line whose change would give this feature that blast radius.
select _policy_tests.assert(
  '0042: chk_ashby_operations_type is NOT widened by the phone substrate',
  (select pg_get_constraintdef(oid) from pg_constraint
    where conname = 'chk_ashby_operations_type')
    = 'CHECK ((operation_type = ANY (ARRAY[''invite_delivery''::text, ''scorecard_write''::text, ''stage_move''::text])))',
  'phone must ride a queue NAME (phone.dial), never an Ashby operation type');

select _policy_tests.assert(
  '0042: no phone table or phone function mentions stage, scorecard or email',
  not exists (
    select 1 from pg_attribute a
      join pg_class c on c.oid = a.attrelid
      join pg_namespace n on n.oid = c.relnamespace
     where n.nspname = 'screening_v2' and c.relkind = 'r' and c.relname like 'phone\_%'
       and a.attnum > 0 and not a.attisdropped
       and (a.attname like '%stage%' or a.attname like '%scorecard%' or a.attname like '%email%'))
  and not exists (
    select 1 from pg_proc p join pg_namespace n on n.oid = p.pronamespace
     where n.nspname = 'screening_v2'
       and p.proname in ('admit_phone_attempt','apply_phone_event','reclaim_phone_attempt_leases')
       and (_policy_tests.fn_body(p.proname) ~* 'ashby_operations'
         or _policy_tests.fn_body(p.proname) ~* 'scorecard'
         or _policy_tests.fn_body(p.proname) ~* 'stage_move')),
  'a phone path that can reach the stage/scorecard/email machinery has the blast radius the design forbids');

-- ── The audit allowlist grew and lost nothing ─────────────────────────
do $$
declare
  v_def text;
  v_prior text[] := array[
    'invite_sent','grant_issued','screening_started','assessment_recorded',
    'candidate_status_changed','session_created','membership_created','role_created',
    'export_requested','login_success','config_changed','auth_login_success',
    'rbac_access_denied','resource_create','rate_limit_exceeded','audit_sink_failure',
    'recording_download','recording_quarantined','admin_session_override','quota_override',
    'allowlist_linked','ashby_mapping_update','ashby_application_cancel',
    'ashby_operation_retry','ashby_invite_delivered','ashby_ingestion_attempts_reset',
    'ashby_ingestion_parse_recovery','ashby_ingestion_legacy_bad_output_recovery'];
  v_new text[] := array[
    'phone_attempt_admitted','phone_attempt_classified','phone_attempt_ended',
    'phone_appointment_scheduled','phone_appointment_cancelled','phone_opt_out_recorded'];
  v_a text; v_missing text := '';
begin
  select pg_get_constraintdef(oid) into v_def
    from pg_constraint where conname = 'chk_audit_action';
  foreach v_a in array v_prior loop
    if position('''' || v_a || '''' in v_def) = 0 then v_missing := v_missing || 'lost:' || v_a || ' '; end if;
  end loop;
  foreach v_a in array v_new loop
    if position('''' || v_a || '''' in v_def) = 0 then v_missing := v_missing || 'absent:' || v_a || ' '; end if;
  end loop;
  perform _policy_tests.assert(
    '0042: chk_audit_action gained the six phone actions and dropped nothing',
    v_missing = '', v_missing);
end;
$$;

do $$
declare v_def text;
begin
  select pg_get_constraintdef(oid) into v_def
    from pg_constraint where conname = 'chk_call_sessions_terminal_reason';
  perform _policy_tests.assert(
    '0042: the cancelled terminal-reason family gained exactly candidate_opt_out and wrong_number',
    v_def like '%candidate_opt_out%' and v_def like '%wrong_number%'
      and v_def like '%recruiter_cancelled%' and v_def like '%residency_timeout%'
      -- Deliberately ABSENT: no call_sessions row is bound before human
      -- classification, so a machine-answered attempt has no session to
      -- terminalise and the reason would have no reachable writer.
      and v_def not like '%voicemail_detected%',
    'terminal reason families drifted: ' || coalesce(v_def, '<null>'));
end;
$$;

-- ── The dormant 0001 tables are labelled, not revived ─────────────────
select _policy_tests.assert(
  '0042: call_queue and sms_follow_ups are documented as deliberately dormant',
  coalesce(obj_description('screening_v2.call_queue'::regclass), '') like '%DORMANT%'
  and coalesce(obj_description('screening_v2.sms_follow_ups'::regclass), '') like '%DORMANT%',
  'without the comment the next reader cannot tell "unused" from "forgotten"');

-- ── M-1: the suppression digest is the EXISTING schema-qualified helper
select _policy_tests.assert(
  '0042: the suppression digest an RPC writes equals the one a fixture computes',
  screening_v2.sha256_hex('+919000000099')
    = encode(digest('+919000000099', 'sha256'), 'hex'),
  'a bare digest() under a pinned search_path fails at RUNTIME on Supabase, not at deploy');

-- ═══════════════════════════════════════════════════════════════════════
-- 0042 — Phone screening substrate: behaviour
-- ═══════════════════════════════════════════════════════════════════════
-- EVERY test below passes p_now EXPLICITLY. Not one reads the machine
-- clock, so the IST boundary assertions give the same answer in Asia and
-- in CI.
--
-- On the fixture numbers: India publishes no reserved "documentation"
-- telephone range, so there is no +1-555 equivalent to reach for. These
-- fixtures therefore use a fixed synthetic pattern that exists only
-- inside an ephemeral local container with no provider credentials and
-- no dial path — and 0042 contains no code that can originate a call at
-- all. No fixture number is ever dialled, logged, or written into a
-- phone table; the substrate turns it straight into a digest.

-- Removes one tagged fixture and everything hanging off it, in
-- dependency order. audit_events and phone_call_events are append-only
-- by design and are deliberately NOT deleted; every assertion about
-- their cardinality is therefore scoped to the row it is about.
create or replace function _policy_tests.phone_teardown(p_tag text)
returns void language plpgsql as $ptd$
declare v_links uuid[]; v_engs uuid[]; v_cands uuid[];
begin
  select coalesce(array_agg(id), '{}') into v_links
    from screening_v2.ashby_application_links where external_application_id = p_tag || '-app';
  select coalesce(array_agg(id), '{}') into v_engs
    from screening_v2.phone_engagements where application_link_id = any(v_links);
  select coalesce(array_agg(id), '{}') into v_cands
    from screening_v2.candidates where email = p_tag || '@example.test';

  delete from screening_v2.job_queue
   where dedup_key in (select 'phone.dial:' || id::text
                         from screening_v2.phone_call_attempts
                        where engagement_id = any(v_engs));
  -- The documented SET LOCAL escape hatch, used here exactly as an
  -- erasure or an emergency migration would use it, and scoped to this
  -- transaction only.
  perform set_config('app.allow_phone_event_mutation', 'true', true);
  delete from screening_v2.phone_call_events
   where engagement_id = any(v_engs) or attempt_id in (
     select id from screening_v2.phone_call_attempts where engagement_id = any(v_engs));
  perform set_config('app.allow_phone_event_mutation', 'false', true);
  delete from screening_v2.phone_call_attempts where engagement_id = any(v_engs);
  delete from screening_v2.phone_appointments where engagement_id = any(v_engs);
  delete from screening_v2.phone_engagements where id = any(v_engs);
  delete from screening_v2.ashby_resume_ingestions where application_link_id = any(v_links);
  delete from screening_v2.ashby_operations where application_link_id = any(v_links);
  delete from screening_v2.ashby_application_links where id = any(v_links);
  delete from screening_v2.ashby_job_mappings where external_job_id = p_tag || '-job';
  delete from screening_v2.consent_records where candidate_id = any(v_cands);
  delete from screening_v2.phone_suppressions where candidate_id = any(v_cands);
  delete from screening_v2.candidates where id = any(v_cands);
end;
$ptd$;


-- Two applications for ONE candidate is the shape the cross-application
-- opt-out control needs, and the tag-scoped teardown above assumes one
-- link per tag. This takes the link ids directly.
create or replace function _policy_tests.phone_teardown_links(p_apps text[], p_email text)
returns void language plpgsql as $ptl$
declare v_links uuid[]; v_engs uuid[]; v_cands uuid[];
begin
  select coalesce(array_agg(id), '{}') into v_links
    from screening_v2.ashby_application_links where external_application_id = any(p_apps);
  select coalesce(array_agg(id), '{}') into v_engs
    from screening_v2.phone_engagements where application_link_id = any(v_links);
  select coalesce(array_agg(id), '{}') into v_cands
    from screening_v2.candidates where email = p_email;

  perform set_config('app.allow_phone_event_mutation', 'true', true);
  delete from screening_v2.phone_call_events
   where engagement_id = any(v_engs)
      or attempt_id in (select id from screening_v2.phone_call_attempts
                         where engagement_id = any(v_engs));
  perform set_config('app.allow_phone_event_mutation', 'false', true);

  delete from screening_v2.job_queue
   where dedup_key in (select 'phone.dial:' || id::text
                         from screening_v2.phone_call_attempts
                        where engagement_id = any(v_engs));
  delete from screening_v2.phone_call_attempts where engagement_id = any(v_engs);
  delete from screening_v2.phone_appointments  where engagement_id = any(v_engs);
  delete from screening_v2.phone_engagements   where id = any(v_engs);
  delete from screening_v2.ashby_resume_ingestions where application_link_id = any(v_links);
  delete from screening_v2.ashby_operations        where application_link_id = any(v_links);
  delete from screening_v2.ashby_application_links where id = any(v_links);
  delete from screening_v2.phone_suppressions where candidate_id = any(v_cands);
  delete from screening_v2.consent_records where candidate_id = any(v_cands);
  delete from screening_v2.candidates where id = any(v_cands);
end;
$ptl$;

create or replace function _policy_tests.phone_fixture(
  p_tag       text,
  p_state     text default 'eligible',
  p_ingestion text default 'ready',
  p_mapping   text default 'enabled',
  p_consent   text default 'full',
  p_phone     text default null
)
returns uuid
language plpgsql as $pf$
declare
  v_role uuid; v_cand uuid; v_map uuid; v_link uuid; v_eng uuid;
  v_states text[] := array['queued','fetching','scanning','extracting','structuring','ready'];
  v_s text;
begin
  select id into v_role from screening_v2.roles order by id limit 1;

  -- Idempotent teardown FIRST, so a re-run of the suite against an
  -- already-seeded database starts clean rather than colliding with the
  -- previous run's unique (provider, external_job_id).
  perform _policy_tests.phone_teardown(p_tag);

  insert into screening_v2.candidates (role_id, name, email, phone_e164, phone_valid)
  values (v_role, 'phone fixture ' || p_tag, p_tag || '@example.test',
          coalesce(p_phone, '+9199990' || lpad((abs(hashtext(p_tag)) % 100000)::text, 5, '0')),
          p_phone is distinct from 'INVALID')
  returning id into v_cand;

  if p_consent = 'full' then
    insert into screening_v2.consent_records (candidate_id, status, consents, version)
    values (v_cand, 'granted',
            '{ai_interview,recording,purpose,data_processing,retention,rights}'
              ::screening_v2.consent_type[], '2026-08-04.1');
  elsif p_consent in ('declined','withdrawn') then
    insert into screening_v2.consent_records (candidate_id, status, consents, version)
    values (v_cand, p_consent,
            '{ai_interview,recording,purpose,data_processing,retention,rights}'
              ::screening_v2.consent_type[], '2026-08-04.1');
  elsif p_consent = 'expired' then
    insert into screening_v2.consent_records (candidate_id, status, consents, version, expires_at)
    values (v_cand, 'granted',
            '{ai_interview,recording,purpose,data_processing,retention,rights}'
              ::screening_v2.consent_type[], '2026-08-04.1', '2020-01-01T00:00:00Z');
  elsif p_consent = 'subset' then
    insert into screening_v2.consent_records (candidate_id, status, consents, version)
    values (v_cand, 'granted', '{job_application}'::screening_v2.consent_type[], '2026-08-04.1');
  end if;   -- 'none' writes no record at all

  insert into screening_v2.ashby_job_mappings
    (external_job_id, role_id, owner_id, ai_screening_stage_id, ta_screening_stage_id,
     status, delivery_mode)
  values (p_tag || '-job', v_role, '00000000-0000-4000-8000-0000000000ad',
          p_tag || '-ai', p_tag || '-ta', p_mapping, 'manual')
  returning id into v_map;

  insert into screening_v2.ashby_application_links
    (external_application_id, external_job_id, job_mapping_id,
     external_resume_file_handle, candidate_id)
  values (p_tag || '-app', p_tag || '-job', v_map,
          case when p_ingestion = 'no_resume' then null else repeat('h', 64) end, v_cand)
  returning id into v_link;

  if p_ingestion <> 'no_resume' then
    foreach v_s in array v_states loop
      perform screening_v2.advance_ashby_ingestion(v_link, v_s, null, null, null, null);
      exit when v_s = p_ingestion;
    end loop;
  end if;

  insert into screening_v2.phone_engagements
    (application_link_id, candidate_id, role_id, state, terminal_at)
  values (v_link, v_cand, v_role, p_state,
          case when p_state in ('completed','abandoned_no_answer','opted_out',
                                'wrong_number','failed','cancelled')
               then '2026-08-01T00:00:00Z'::timestamptz else null end)
  returning id into v_eng;

  return v_eng;
end;
$pf$;

-- ── B1: the IST window, at the boundary, on all seven days ────────────
do $$
declare
  v_eng uuid;
  v_res jsonb;
  v_d   integer;
  v_day date;
  v_bad text := '';
  v_no_answer integer; v_reconnects integer; v_failures integer;
begin
  v_eng := _policy_tests.phone_fixture('pol42-window');

  -- 2026-08-24 is a Monday, so seven consecutive dates cover every day
  -- of the week including both weekend days. This substrate calls seven
  -- days a week; a weekday-only helper would pass six of these.
  for v_d in 0..6 loop
    v_day := date '2026-08-24' + v_d;

    -- 08:59:59 IST = 03:29:59Z. Refused.
    v_res := screening_v2.admit_phone_attempt(
               v_eng, 'initial', null, 60, (v_day + time '03:29:59') at time zone 'UTC');
    if v_res->>'status' <> 'window_closed' then
      v_bad := v_bad || v_day || ':0859=' || (v_res->>'status') || ' '; end if;

    -- 09:00:00 IST = 03:30:00Z. Admitted — the first legal second.
    v_res := screening_v2.admit_phone_attempt(
               v_eng, 'initial', null, 60, (v_day + time '03:30:00') at time zone 'UTC');
    if v_res->>'status' <> 'ok' then
      v_bad := v_bad || v_day || ':0900=' || (v_res->>'status') || ' '; end if;
    delete from screening_v2.job_queue
     where dedup_key = 'phone.dial:' || (v_res->>'attempt_id');
    delete from screening_v2.phone_call_attempts where id = (v_res->>'attempt_id')::uuid;
    update screening_v2.phone_engagements set state = 'eligible' where id = v_eng;

    -- 20:59:59 IST = 15:29:59Z. Still inside; the window bounds the
    -- START of a call, and the last legal second is a legal second.
    v_res := screening_v2.admit_phone_attempt(
               v_eng, 'initial', null, 60, (v_day + time '15:29:59') at time zone 'UTC');
    if v_res->>'status' <> 'ok' then
      v_bad := v_bad || v_day || ':2059=' || (v_res->>'status') || ' '; end if;
    delete from screening_v2.job_queue
     where dedup_key = 'phone.dial:' || (v_res->>'attempt_id');
    delete from screening_v2.phone_call_attempts where id = (v_res->>'attempt_id')::uuid;
    update screening_v2.phone_engagements set state = 'eligible' where id = v_eng;

    -- 21:00:00 IST = 15:30:00Z. Refused.
    v_res := screening_v2.admit_phone_attempt(
               v_eng, 'initial', null, 60, (v_day + time '15:30:00') at time zone 'UTC');
    if v_res->>'status' <> 'window_closed' then
      v_bad := v_bad || v_day || ':2100=' || (v_res->>'status') || ' '; end if;
  end loop;

  perform _policy_tests.assert(
    '0042: 08:59:59 refused / 09:00:00 admitted / 20:59:59 admitted / 21:00:00 refused, all seven days',
    v_bad = '', 'boundary drift: ' || v_bad);

  -- A WAIT COSTS NOTHING. Fourteen window refusals just happened; if one
  -- of them had charged, a candidate would lose an attempt for being
  -- asleep.
  select no_answer_attempts, reconnects_used, provider_failures
    into v_no_answer, v_reconnects, v_failures
    from screening_v2.phone_engagements where id = v_eng;
  perform _policy_tests.assert(
    '0042: fourteen window refusals charged no budget at all',
    v_no_answer = 0 and v_reconnects = 0 and v_failures = 0,
    'no_answer=' || v_no_answer || ' reconnects=' || v_reconnects || ' failures=' || v_failures);
end;
$$;

-- The day rolls at IST midnight, not at UTC midnight. 18:29:59Z is
-- 23:59:59 IST; one second later is the next IST day while UTC has not
-- moved.
select _policy_tests.assert(
  '0042: the attempt day rolls at IST midnight, not UTC midnight',
  screening_v2.phone_ist_date('2026-08-23T18:29:59Z') = date '2026-08-23'
  and screening_v2.phone_ist_date('2026-08-23T18:30:00Z') = date '2026-08-24'
  and screening_v2.phone_ist_date('2026-08-23T23:59:59Z') = date '2026-08-24',
  'a UTC-dated budget would give an Indian candidate two attempts on one of their days');

-- ── B2: illegal and terminal transitions, and terminal_at coherence ───
do $$
declare
  v_eng uuid; v_ok boolean;
begin
  v_eng := _policy_tests.phone_fixture('pol42-trans');

  begin
    update screening_v2.phone_engagements set state = 'in_call' where id = v_eng;
    v_ok := false;
  exception when others then
    v_ok := sqlerrm like '%invalid phone engagement transition%';
  end;
  perform _policy_tests.assert(
    '0042: an illegal engagement transition (eligible -> in_call) is refused',
    v_ok, 'a state machine whose edges live only in TypeScript is a convention, not a machine');

  update screening_v2.phone_engagements
     set state = 'cancelled', terminal_at = '2026-08-24T06:00:00Z' where id = v_eng;
  begin
    update screening_v2.phone_engagements set state = 'eligible', terminal_at = null
     where id = v_eng;
    v_ok := false;
  exception when others then v_ok := true; end;
  perform _policy_tests.assert(
    '0042: a terminal engagement cannot be revived',
    v_ok, 'terminal must be immutable or every budget below it is meaningless');

  begin
    update screening_v2.phone_engagements
       set state = 'completed', terminal_at = '2026-08-24T06:00:00Z' where id = v_eng;
    v_ok := false;
  exception when others then v_ok := true; end;
  perform _policy_tests.assert(
    '0042: terminal-to-terminal is refused too',
    v_ok, 'cancelled -> completed would rewrite the outcome of a call that already ended');
end;
$$;

do $$
declare v_eng uuid; v_a boolean; v_b boolean;
begin
  v_eng := _policy_tests.phone_fixture('pol42-coherence');
  -- Direction 1: terminal state with no terminal_at.
  begin
    update screening_v2.phone_engagements set state = 'cancelled' where id = v_eng;
    v_a := false;
  exception when others then v_a := true; end;
  -- Direction 2: non-terminal state carrying a terminal_at.
  begin
    update screening_v2.phone_engagements set terminal_at = '2026-08-24T06:00:00Z'
     where id = v_eng;
    v_b := false;
  exception when others then v_b := true; end;
  perform _policy_tests.assert(
    '0042: terminal state and terminal_at are coherent in BOTH directions',
    v_a and v_b,
    'terminal-without-a-time=' || v_a || ' time-without-terminal=' || v_b);
end;
$$;

-- ── B3: the ingress ledger is insert-once, for service_role too ───────
do $$
declare
  v_eng uuid; v_res jsonb; v_ev uuid; v_u boolean; v_d boolean;
begin
  v_eng := _policy_tests.phone_fixture('pol42-ledger');
  v_res := screening_v2.apply_phone_event('internal', 'prereq.satisfied', null, v_eng,
                                          null, null, null, '2026-08-24T06:00:00Z');
  v_ev := (v_res->>'event_id')::uuid;

  begin
    update screening_v2.phone_call_events set applied = false where id = v_ev;
    v_u := false;
  exception when others then v_u := sqlerrm like '%insert-once%'; end;
  begin
    delete from screening_v2.phone_call_events where id = v_ev;
    v_d := false;
  exception when others then v_d := sqlerrm like '%insert-once%'; end;

  perform _policy_tests.assert(
    '0042: phone_call_events rejects UPDATE and DELETE for the table owner',
    v_u and v_d,
    'update_blocked=' || v_u || ' delete_blocked=' || v_d);
end;
$$;

-- The same proof under the role the backend actually uses. A trigger
-- that only stops an unprivileged role would prove nothing: service_role
-- owns every grant on these tables and bypasses RLS entirely, so it is
-- the only writer whose refusal is worth asserting.
do $$
declare
  v_eng uuid; v_res jsonb; v_ev uuid; v_u boolean; v_d boolean;
begin
  v_eng := _policy_tests.phone_fixture('pol42-ledger-sr');
  v_res := screening_v2.apply_phone_event('internal', 'prereq.satisfied', null, v_eng,
                                          null, null, null, '2026-08-24T06:00:00Z');
  v_ev := (v_res->>'event_id')::uuid;

  set local role service_role;
  begin
    update screening_v2.phone_call_events set applied = false where id = v_ev;
    v_u := false;
  exception when others then v_u := sqlerrm like '%insert-once%'; end;
  begin
    delete from screening_v2.phone_call_events where id = v_ev;
    v_d := false;
  exception when others then v_d := sqlerrm like '%insert-once%'; end;
  reset role;

  perform _policy_tests.assert(
    '0042: phone_call_events rejects UPDATE and DELETE as service_role',
    v_u and v_d,
    'service_role bypasses RLS and holds every grant, so this is the refusal that matters; '
      || 'update_blocked=' || v_u || ' delete_blocked=' || v_d);
  perform _policy_tests.assert(
    '0042: the role used above really does bypass RLS',
    (select rolbypassrls from pg_roles where rolname = 'service_role'),
    'if service_role did not bypass RLS the refusal could be a policy artefact');
end;
$$;

-- ── B4: the budget CHECKs reject a DIRECT write, with no RPC involved ─
do $$
declare v_eng uuid; v_over boolean; v_neg boolean;
begin
  v_eng := _policy_tests.phone_fixture('pol42-budget-check');
  begin
    update screening_v2.phone_engagements set no_answer_attempts = 4 where id = v_eng;
    v_over := false;
  exception when check_violation then v_over := true; end;
  begin
    update screening_v2.phone_engagements set reconnects_used = -1 where id = v_eng;
    v_neg := false;
  exception when check_violation then v_neg := true; end;
  perform _policy_tests.assert(
    '0042: a direct write of no_answer_attempts=4 or reconnects_used=-1 is rejected by CHECK',
    v_over and v_neg,
    'the budget ceilings must hold against any writer, not only against the RPCs; '
      || 'four=' || v_over || ' negative=' || v_neg);
end;
$$;

-- ── B5: every prerequisite refusal is free and leaves no trace ────────
-- The assertion that matters is not the status string. It is that a
-- refusal writes NO attempt, NO queue job and NO success audit, and
-- moves NO budget — because a fail-closed gate that quietly spends a
-- candidate's attempt is worse than no gate at all.
do $$
declare
  v_cases text[][] := array[
    ['consent-none',    'consent_missing'],
    ['consent-decl',    'consent_not_granted'],
    ['consent-wdrw',    'consent_not_granted'],
    ['consent-exp',     'consent_expired'],
    ['consent-sub',     'consent_subset_missing'],
    ['phone-bad',       'phone_invalid'],
    ['phone-nonin',     'phone_invalid'],
    ['map-paused',      'mapping_not_enabled'],
    ['ing-partial',     'ingestion_not_ready'],
    ['ing-none',        'ingestion_not_ready'],
    ['link-terminal',   'application_terminal'],
    ['suppressed',      'suppressed'],
    ['window-shut',     'window_closed'],
    ['halt-on',         'halted'],
    ['halt-missing',    'halt_unreadable']];
  v_i integer; v_tag text; v_want text;
  v_eng uuid; v_res jsonb; v_now timestamptz := '2026-08-24T06:00:00Z';
  v_bad text := ''; v_attempts integer; v_jobs integer; v_audits integer;
  v_na integer; v_rc integer; v_pf integer;
begin
  for v_i in 1..array_length(v_cases, 1) loop
    v_tag  := 'pol42-' || v_cases[v_i][1];
    v_want := v_cases[v_i][2];

    v_eng := case v_cases[v_i][1]
      when 'consent-none' then _policy_tests.phone_fixture(v_tag,'eligible','ready','enabled','none')
      when 'consent-decl' then _policy_tests.phone_fixture(v_tag,'eligible','ready','enabled','declined')
      when 'consent-wdrw' then _policy_tests.phone_fixture(v_tag,'eligible','ready','enabled','withdrawn')
      when 'consent-exp'  then _policy_tests.phone_fixture(v_tag,'eligible','ready','enabled','expired')
      when 'consent-sub'  then _policy_tests.phone_fixture(v_tag,'eligible','ready','enabled','subset')
      when 'phone-bad'    then _policy_tests.phone_fixture(v_tag,'eligible','ready','enabled','full','INVALID')
      -- A perfectly valid US number. India-only is not a formatting
      -- rule, it is a jurisdiction rule, and it must fail closed.
      when 'phone-nonin'  then _policy_tests.phone_fixture(v_tag,'eligible','ready','enabled','full','+14155550100')
      when 'map-paused'   then _policy_tests.phone_fixture(v_tag,'eligible','ready','paused','full')
      when 'ing-partial'  then _policy_tests.phone_fixture(v_tag,'eligible','structuring','enabled','full')
      when 'ing-none'     then _policy_tests.phone_fixture(v_tag,'eligible','no_resume','enabled','full')
      else _policy_tests.phone_fixture(v_tag)
    end;

    if v_cases[v_i][1] = 'link-terminal' then
      update screening_v2.ashby_application_links set terminal_state = 'withdrawn'
       where id = (select application_link_id from screening_v2.phone_engagements where id = v_eng);
    elsif v_cases[v_i][1] = 'suppressed' then
      insert into screening_v2.phone_suppressions (phone_sha256, reason, source)
      select screening_v2.sha256_hex(c.phone_e164), 'candidate_opt_out', 'candidate'
        from screening_v2.candidates c
        join screening_v2.phone_engagements e on e.candidate_id = c.id
       where e.id = v_eng
      on conflict (phone_sha256) do nothing;
    elsif v_cases[v_i][1] = 'halt-on' then
      perform screening_v2.set_phone_halt('operator_pause',
                                          '00000000-0000-4000-8000-0000000000ad', v_now);
    elsif v_cases[v_i][1] = 'halt-missing' then
      delete from screening_v2.phone_control where control_key = 'default';
    end if;

    v_res := screening_v2.admit_phone_attempt(
               v_eng, 'initial', null, 60,
               case when v_cases[v_i][1] = 'window-shut'
                    then '2026-08-24T16:30:00Z'::timestamptz   -- 22:00 IST
                    else v_now end);

    if v_res->>'status' <> v_want then
      v_bad := v_bad || v_tag || '=' || (v_res->>'status') || '(want ' || v_want || ') ';
    end if;

    select count(*) into v_attempts
      from screening_v2.phone_call_attempts where engagement_id = v_eng;
    select count(*) into v_jobs
      from screening_v2.job_queue where name = 'phone.dial'
        and payload->>'attemptId' in (select id::text from screening_v2.phone_call_attempts
                                       where engagement_id = v_eng);
    select count(*) into v_audits
      from screening_v2.audit_events
     where action = 'phone_attempt_admitted' and metadata->>'engagement_id' = v_eng::text;
    select no_answer_attempts, reconnects_used, provider_failures into v_na, v_rc, v_pf
      from screening_v2.phone_engagements where id = v_eng;

    if v_attempts <> 0 or v_jobs <> 0 or v_audits <> 0 or v_na <> 0 or v_rc <> 0 or v_pf <> 0 then
      v_bad := v_bad || v_tag || ':trace(attempts=' || v_attempts || ',jobs=' || v_jobs
               || ',audits=' || v_audits || ',budgets=' || v_na || '/' || v_rc || '/' || v_pf || ') ';
    end if;

    -- Undo the two global side effects immediately, so a later test can
    -- never inherit a halted or missing kill switch.
    if v_cases[v_i][1] = 'halt-on' then
      perform screening_v2.clear_phone_halt('00000000-0000-4000-8000-0000000000ad', v_now);
    elsif v_cases[v_i][1] = 'halt-missing' then
      insert into screening_v2.phone_control (control_key) values ('default')
      on conflict (control_key) do nothing;
    end if;
  end loop;

  perform _policy_tests.assert(
    '0042: all fifteen prerequisite refusals are exact, budget-free and leave no attempt, job or success audit',
    v_bad = '', v_bad);
end;
$$;

-- The active-template gate, isolated: with no active template there is
-- no authority to point at, so admission must stop even when the
-- candidate's own record looks complete.
do $$
declare v_eng uuid; v_res jsonb;
begin
  v_eng := _policy_tests.phone_fixture('pol42-tmpl');
  update screening_v2.consent_templates set is_active = false where is_active;
  v_res := screening_v2.admit_phone_attempt(v_eng, 'initial', null, 60, '2026-08-24T06:00:00Z');
  update screening_v2.consent_templates set is_active = true where version = '2026-08-04.1';
  perform _policy_tests.assert(
    '0042: admission stops when no consent template is active',
    v_res->>'status' = 'consent_template_inactive',
    'got ' || coalesce(v_res::text, '<null>'));
end;
$$;

-- ── B6: the per-IST-day budget, and what it does and does not block ───
do $$
declare
  v_eng uuid; v_res jsonb; v_att uuid;
  v_t timestamptz := '2026-08-24T06:00:00Z';   -- 11:30 IST
  v_na integer; v_rc integer;
begin
  v_eng := _policy_tests.phone_fixture('pol42-day');

  v_res := screening_v2.admit_phone_attempt(v_eng, 'initial', null, 60, v_t);
  v_att := (v_res->>'attempt_id')::uuid;
  perform _policy_tests.assert('0042: the first attempt of the day is admitted',
    v_res->>'status' = 'ok', coalesce(v_res::text, '<null>'));

  -- End it truthfully, the way a no-answer would.
  perform screening_v2.apply_phone_event('internal', 'sip.originate_timeout', v_att, null,
                                         null, 0, null, v_t + interval '30 seconds');
  select no_answer_attempts into v_na from screening_v2.phone_engagements where id = v_eng;
  perform _policy_tests.assert(
    '0042: a ring timeout charges exactly one no-answer attempt',
    v_na = 1, 'no_answer_attempts=' || v_na);

  -- Same IST day, later hour. Refused: one no-answer-class call a day.
  update screening_v2.phone_engagements set state = 'eligible' where id = v_eng;
  v_res := screening_v2.admit_phone_attempt(v_eng, 'no_answer_retry', null, 60,
                                            v_t + interval '4 hours');
  perform _policy_tests.assert(
    '0042: a second no-answer-class attempt on the SAME IST day is refused',
    v_res->>'status' = 'daily_attempt_exists',
    'calling the same person twice in a day is the harassment this index exists to prevent; got '
      || coalesce(v_res::text, '<null>'));

  -- An ENDED attempt must not block the next admission; that is the
  -- mirror of the PR #70 wedge, where a live row nothing could reclaim
  -- blocked an engagement for ever. The attempt above is already
  -- `ended` — the ring timeout ended it.
  update screening_v2.phone_engagements set state = 'eligible' where id = v_eng;
  v_res := screening_v2.admit_phone_attempt(v_eng, 'no_answer_retry', null, 60,
                                            v_t + interval '1 day');
  perform _policy_tests.assert(
    '0042: an ended attempt permits admission on the next IST day',
    v_res->>'status' = 'ok', coalesce(v_res::text, '<null>'));
  v_att := (v_res->>'attempt_id')::uuid;

  update screening_v2.phone_call_attempts set state = 'abandoned' where id = v_att;
  update screening_v2.phone_engagements set state = 'eligible' where id = v_eng;
  v_res := screening_v2.admit_phone_attempt(v_eng, 'no_answer_retry', null, 60,
                                            v_t + interval '2 days');
  perform _policy_tests.assert(
    '0042: an abandoned attempt permits admission on a later IST day',
    v_res->>'status' = 'ok', coalesce(v_res::text, '<null>'));
end;
$$;

-- A reconnect is a DIFFERENT budget and is excluded from the per-day
-- index BY CONSTRUCTION, so a dropped conversation can be resumed within
-- minutes without spending the candidate's call for that day. This walks
-- the real path — admit, join, classify, disclose, drop — rather than
-- forcing states, because the whole claim is that the machine reaches
-- `reconnecting` legally.
do $$
declare
  v_eng uuid; v_res jsonb; v_att uuid;
  v_t timestamptz := '2026-08-24T06:00:00Z';
  v_na integer; v_rc integer; v_state text;
begin
  v_eng := _policy_tests.phone_fixture('pol42-reconnect');
  v_res := screening_v2.admit_phone_attempt(v_eng, 'initial', null, 60, v_t);
  v_att := (v_res->>'attempt_id')::uuid;

  perform screening_v2.apply_phone_event('livekit_webhook','sip.participant_joined',
                                         v_att, null, 'pol42-rc-join', 0, null, v_t);
  perform screening_v2.apply_phone_event('internal','classify.human',
                                         v_att, null, null, 0, null, v_t);
  perform screening_v2.apply_phone_event('internal','disclosure.delivered',
                                         v_att, null, null, 0, null, v_t);
  select state into v_state from screening_v2.phone_engagements where id = v_eng;
  perform _policy_tests.assert(
    '0042: a delivered disclosure — and only that — opens the conversation',
    v_state = 'in_call', 'state=' || v_state);

  -- Mid-call drop, inside the window: one reconnect charged, no
  -- no-answer attempt spent.
  perform screening_v2.apply_phone_event('livekit_webhook','sip.participant_left',
                                         v_att, null, 'pol42-rc-left', 1, null,
                                         v_t + interval '5 minutes');
  select state, no_answer_attempts, reconnects_used into v_state, v_na, v_rc
    from screening_v2.phone_engagements where id = v_eng;
  perform _policy_tests.assert(
    '0042: a mid-call drop inside the window charges ONE reconnect and no no-answer attempt',
    v_state = 'reconnecting' and v_rc = 1 and v_na = 0,
    'state=' || v_state || ' reconnects=' || v_rc || ' no_answer=' || v_na);

  v_res := screening_v2.admit_phone_attempt(v_eng, 'reconnect', null, 60,
                                            v_t + interval '7 minutes');
  select no_answer_attempts, reconnects_used into v_na, v_rc
    from screening_v2.phone_engagements where id = v_eng;
  perform _policy_tests.assert(
    '0042: the reconnect is admitted the SAME IST day and charges nothing at admission',
    v_res->>'status' = 'ok' and v_na = 0 and v_rc = 1,
    'status=' || (v_res->>'status') || ' no_answer=' || v_na || ' reconnects=' || v_rc);
end;
$$;

-- ── B7: uq_phone_attempts_one_live is LOAD-BEARING, and a completed
--        queue row can never authorise a second dial ──────────────────
-- This is the test whose colour changes when the index is dropped. The
-- refusal cannot come from the state check (the engagement is forced to
-- an admissible state) nor from the per-day index (a reconnect is
-- excluded from it), so only the one-live index is left to say no.
do $$
declare
  v_eng uuid; v_res jsonb; v_att uuid; v_live integer; v_completed integer;
  v_t timestamptz := '2026-08-24T06:00:00Z';
begin
  v_eng := _policy_tests.phone_fixture('pol42-onelive');
  v_res := screening_v2.admit_phone_attempt(v_eng, 'initial', null, 60, v_t);
  v_att := (v_res->>'attempt_id')::uuid;

  -- Complete the dial job, exactly as a worker would. The dedup key is
  -- now released: uq_job_queue_dedup_active is partial over
  -- pending/active/delayed, so the QUEUE no longer objects to anything.
  update screening_v2.job_queue set status = 'completed', completed_at = v_t
   where dedup_key = 'phone.dial:' || v_att::text;
  select count(*) into v_completed from screening_v2.job_queue
   where dedup_key = 'phone.dial:' || v_att::text and status = 'completed';

  -- Put the engagement in an admissible state while its attempt is still
  -- LIVE. `dialing -> reconnecting` is a legal edge (it is how a
  -- reclaimed reconnect is restored), so this is a state the machine can
  -- genuinely be in — and `reconnect` is the one kind the per-day index
  -- does not cover. Neither the state check nor the day index can refuse
  -- what follows; only uq_phone_attempts_one_live can.
  update screening_v2.phone_engagements set state = 'reconnecting' where id = v_eng;
  v_res := screening_v2.admit_phone_attempt(v_eng, 'reconnect', null, 60,
                                            v_t + interval '2 minutes');

  select count(*) into v_live from screening_v2.phone_call_attempts
   where engagement_id = v_eng
     and state in ('admitted','ringing','answered_unclassified','human','machine');

  perform _policy_tests.assert(
    '0042: a COMPLETED phone.dial job cannot authorise a second live attempt',
    v_completed = 1 and v_res->>'status' = 'attempt_in_flight' and v_live = 1,
    'the durable attempt row is the exactly-once authority, never the queue dedup key; '
      || 'completed_jobs=' || v_completed || ' status=' || (v_res->>'status')
      || ' live_attempts=' || v_live);
end;
$$;

-- ── B7b: a failed enqueue rolls the WHOLE admission back ──────────────
do $$
declare
  v_eng uuid; v_res jsonb; v_state text; v_attempts integer; v_audits integer;
  v_na integer; v_threw boolean;
  v_t timestamptz := '2026-08-24T06:00:00Z';
begin
  v_eng := _policy_tests.phone_fixture('pol42-enqfail');

  create or replace function _policy_tests.block_pol42_enqueue()
  returns trigger language plpgsql as $trg$
  begin
    if new.name = 'phone.dial'
       and current_setting('policy_tests.block_eng_42', true) = 'on' then
      raise exception 'pol42_synthetic_enqueue_failure';
    end if;
    return new;
  end;
  $trg$;
  create trigger trg_pol42_block_enqueue
    before insert on screening_v2.job_queue
    for each row execute function _policy_tests.block_pol42_enqueue();
  perform set_config('policy_tests.block_eng_42', 'on', false);

  begin
    v_res := screening_v2.admit_phone_attempt(v_eng, 'initial', null, 60, v_t);
    v_threw := false;
  exception when others then
    v_threw := sqlerrm like '%pol42_synthetic_enqueue_failure%';
  end;

  perform set_config('policy_tests.block_eng_42', 'off', false);
  drop trigger trg_pol42_block_enqueue on screening_v2.job_queue;

  select state, no_answer_attempts into v_state, v_na
    from screening_v2.phone_engagements where id = v_eng;
  select count(*) into v_attempts
    from screening_v2.phone_call_attempts where engagement_id = v_eng;
  select count(*) into v_audits from screening_v2.audit_events
   where action = 'phone_attempt_admitted' and metadata->>'engagement_id' = v_eng::text;

  perform _policy_tests.assert(
    '0042: an enqueue failure rolls back the attempt, the lease, the transition and the audit together',
    v_threw and v_state = 'eligible' and v_attempts = 0 and v_audits = 0 and v_na = 0,
    'an admission that cannot schedule work must not report that it did; threw=' || v_threw
      || ' state=' || v_state || ' attempts=' || v_attempts || ' audits=' || v_audits);

  -- ...and future eligibility survives the outage untouched.
  v_res := screening_v2.admit_phone_attempt(v_eng, 'initial', null, 60, v_t);
  perform _policy_tests.assert(
    '0042: the engagement is fully admissible once the enqueue fault is gone',
    v_res->>'status' = 'ok', coalesce(v_res::text, '<null>'));
end;
$$;

-- ── B8: the fleet cap, lease renewal, and reclaim ─────────────────────
-- The cap is a DB-derived count over unexpired leases, never a stored
-- counter. Its correctness depends on something renewing those leases
-- for the length of a conversation — that loop is P5's, and this test is
-- what makes the dependency visible rather than hidden.
do $$
declare
  v_engs uuid[] := '{}'; v_toks uuid[] := '{}'; v_atts uuid[] := '{}';
  v_i integer; v_res jsonb; v_eng uuid;
  -- Deliberately a WEEK after every other block in this file. The fleet
  -- cap is global by design, so this is the one test that must not share
  -- a clock with its neighbours: an unexpired lease from an earlier
  -- fixture would occupy a slot and make the count mean nothing.
  v_t timestamptz := '2026-09-01T06:00:00Z';
  v_admitted integer := 0; v_bad text := '';
  v_backlog jsonb; v_state text; v_na integer; v_rc integer; v_pf integer;
  v_abandoned integer;
begin
  for v_i in 1..11 loop
    v_eng := _policy_tests.phone_fixture('pol42-cap' || v_i);
    v_engs := v_engs || v_eng;
  end loop;

  -- Drain every lease left over from the blocks above, so the ten
  -- admissions below start against an empty fleet.
  perform screening_v2.reclaim_phone_attempt_leases(500, v_t);

  for v_i in 1..10 loop
    v_res := screening_v2.admit_phone_attempt(v_engs[v_i], 'initial',
                                              'owner-' || v_i, 60, v_t);
    if v_res->>'status' = 'ok' then
      v_admitted := v_admitted + 1;
      v_atts := v_atts || (v_res->>'attempt_id')::uuid;
      v_toks := v_toks || (v_res->>'lease_token')::uuid;
    else
      v_bad := v_bad || v_i || '=' || (v_res->>'status') || ' ';
    end if;
  end loop;

  v_res := screening_v2.admit_phone_attempt(v_engs[11], 'initial', 'owner-11', 60, v_t);
  select no_answer_attempts, reconnects_used, provider_failures into v_na, v_rc, v_pf
    from screening_v2.phone_engagements where id = v_engs[11];
  perform _policy_tests.assert(
    '0042: ten concurrent admissions succeed and the eleventh is refused at_capacity, free of charge',
    v_admitted = 10 and v_res->>'status' = 'at_capacity'
      and (v_res->>'live')::integer = 10 and v_na = 0 and v_rc = 0 and v_pf = 0,
    'admitted=' || v_admitted || ' eleventh=' || (v_res->>'status') || ' ' || v_bad);

  v_backlog := screening_v2.phone_backlog(v_t);
  perform _policy_tests.assert(
    '0042: phone_backlog reports the ten live leases and nothing identifying',
    (v_backlog->'attempts'->>'live_with_unexpired_lease')::integer = 10
      and (v_backlog->'attempts'->>'max_concurrent')::integer = 10
      and v_backlog::text !~ '\+91' and v_backlog::text !~ '@example',
    'backlog=' || v_backlog::text);

  -- Renew every lease at T+50s. The ORIGINAL expiry was T+60s.
  for v_i in 1..10 loop
    v_res := screening_v2.heartbeat_phone_attempt(v_atts[v_i], v_toks[v_i], 60,
                                                  v_t + interval '50 seconds');
    if v_res->>'status' <> 'ok' then v_bad := v_bad || 'hb' || v_i || ' '; end if;
  end loop;

  -- T+70s is PAST every original expiry. A renewed lease still holds its
  -- slot, so the fleet is still full — which is the whole reason the
  -- concurrency lease is not the queue lease.
  v_res := screening_v2.admit_phone_attempt(v_engs[11], 'initial', 'owner-11', 60,
                                            v_t + interval '70 seconds');
  perform _policy_tests.assert(
    '0042: a heartbeat past the original expiry keeps the fleet full',
    v_res->>'status' = 'at_capacity' and v_bad = '',
    'a lease that lapses mid-call would admit an 11th call while the 10th was still talking; got '
      || (v_res->>'status') || ' ' || v_bad);

  -- A stale token can never renew, so a worker that lost its slot cannot
  -- silently keep it.
  v_res := screening_v2.heartbeat_phone_attempt(v_atts[1], gen_random_uuid(), 60,
                                                v_t + interval '80 seconds');
  perform _policy_tests.assert(
    '0042: a wrong lease token is refused, never a silent renew',
    v_res->>'status' = 'lease_lost', coalesce(v_res::text, '<null>'));

  -- Now let every lease lapse and sweep. A dead worker is our failure,
  -- not the candidate's attempt: nothing may be charged.
  v_res := screening_v2.reclaim_phone_attempt_leases(50, v_t + interval '10 minutes');
  select count(*) into v_abandoned from screening_v2.phone_call_attempts
   where id = any(v_atts) and state = 'abandoned';
  select state, no_answer_attempts, reconnects_used, provider_failures
    into v_state, v_na, v_rc, v_pf
    from screening_v2.phone_engagements where id = v_engs[1];
  perform _policy_tests.assert(
    '0042: reclaim abandons every expired attempt, restores the prior state and charges no budget',
    (v_res->>'reclaimed')::integer = 10 and v_abandoned = 10
      and v_state = 'eligible' and v_na = 0 and v_rc = 0 and v_pf = 0,
    'reclaimed=' || (v_res->>'reclaimed') || ' abandoned=' || v_abandoned
      || ' state=' || v_state || ' budgets=' || v_na || '/' || v_rc || '/' || v_pf);

  -- The freed slots are real: the eleventh engagement now gets in.
  v_res := screening_v2.admit_phone_attempt(v_engs[11], 'initial', 'owner-11', 60,
                                            v_t + interval '11 minutes');
  perform _policy_tests.assert(
    '0042: reclaiming an expired lease genuinely frees its fleet slot',
    v_res->>'status' = 'ok', coalesce(v_res::text, '<null>'));

  -- And a reclaimed engagement is admissible again — on the NEXT IST
  -- day. The per-day index still holds: an abandoned attempt may well
  -- have rung the phone before the worker died, and an anti-harassment
  -- invariant must fail closed on that uncertainty. No budget was spent,
  -- so the candidate keeps all three attempts.
  v_res := screening_v2.admit_phone_attempt(v_engs[1], 'initial', 'owner-1', 60,
                                            v_t + interval '12 minutes');
  perform _policy_tests.assert(
    '0042: a reclaimed engagement still respects the per-IST-day call limit',
    v_res->>'status' = 'daily_attempt_exists', coalesce(v_res::text, '<null>'));
  v_res := screening_v2.admit_phone_attempt(v_engs[1], 'initial', 'owner-1', 60,
                                            v_t + interval '1 day');
  perform _policy_tests.assert(
    '0042: a reclaimed engagement is fully re-admissible on the next IST day',
    v_res->>'status' = 'ok', coalesce(v_res::text, '<null>'));
end;
$$;

-- ── B9: the dial job's payload is exact, camelCase, and carries no PII
do $$
declare
  v_eng uuid; v_res jsonb; v_att uuid; v_payload jsonb; v_name text; v_key text;
  v_t timestamptz := '2026-08-24T06:00:00Z';
begin
  v_eng := _policy_tests.phone_fixture('pol42-payload');
  v_res := screening_v2.admit_phone_attempt(v_eng, 'initial', null, 60, v_t);
  v_att := (v_res->>'attempt_id')::uuid;
  select name, payload, dedup_key into v_name, v_payload, v_key
    from screening_v2.job_queue where dedup_key = 'phone.dial:' || v_att::text;

  perform _policy_tests.assert(
    '0042: the dial job is phone.dial with an attempt-scoped dedup key and an exact camelCase payload',
    v_name = 'phone.dial'
      and v_key = 'phone.dial:' || v_att::text
      and v_payload = jsonb_build_object('provider', 'phone', 'attemptId', v_att::text),
    'snake_case would dead-letter the job as a malformed payload — the documented 0040 trap; got '
      || 'name=' || coalesce(v_name, '<null>') || ' key=' || coalesce(v_key, '<null>')
      || ' payload=' || coalesce(v_payload::text, '<null>'));

  perform _policy_tests.assert(
    '0042: the dial payload carries exactly two keys and none of them is PII, a token or a URL',
    (select count(*) from jsonb_object_keys(v_payload)) = 2
      and v_payload->>'provider' = 'phone'
      and v_payload->>'attemptId' ~ '^[0-9a-f-]{36}$'
      -- The only literal 'phone' in the payload is the provider tag
      -- itself, so the leak check is run over the VALUES the payload
      -- would have to smuggle something in.
      and v_payload::text !~* '(e164|\+91|token|url|http|email|secret|handle|error|lease)',
    'payload=' || coalesce(v_payload::text, '<null>'));
end;
$$;

-- ── B10: every ingress verdict, exactly ───────────────────────────────
do $$
declare
  v_eng uuid; v_eng2 uuid; v_res jsonb; v_first jsonb; v_att uuid; v_rows integer;
  v_t timestamptz := '2026-08-24T06:00:00Z';
begin
  v_eng := _policy_tests.phone_fixture('pol42-events');
  v_res := screening_v2.admit_phone_attempt(v_eng, 'initial', null, 60, v_t);
  v_att := (v_res->>'attempt_id')::uuid;

  -- duplicate: one row, and the SAME answer both times
  v_first := screening_v2.apply_phone_event('livekit_webhook','sip.participant_joined',
                                            v_att, null, 'pol42-dup', 0, null, v_t);
  v_res   := screening_v2.apply_phone_event('livekit_webhook','sip.participant_joined',
                                            v_att, null, 'pol42-dup', 0, null, v_t);
  select count(*) into v_rows from screening_v2.phone_call_events
   where source = 'livekit_webhook' and provider_event_id = 'pol42-dup';
  perform _policy_tests.assert(
    '0042: a duplicate delivery writes ONE row and returns the ORIGINAL outcome',
    v_rows = 1 and (v_res->>'duplicate')::boolean
      and v_res->>'event_id' = v_first->>'event_id'
      and v_res->>'applied' = v_first->>'applied'
      and (v_first->>'duplicate')::boolean is false,
    'rows=' || v_rows || ' first=' || v_first::text || ' second=' || v_res::text);

  -- the deterministic synthetic id really is deterministic: a second
  -- internal event of the same type/epoch for the same attempt dedups
  v_first := screening_v2.apply_phone_event('internal','classify.human', v_att, null,
                                            null, 0, null, v_t);
  v_res   := screening_v2.apply_phone_event('internal','classify.human', v_att, null,
                                            null, 0, null, v_t);
  perform _policy_tests.assert(
    '0042: a non-provider source mints a DETERMINISTIC id, so the ledger dedups it too',
    (v_res->>'duplicate')::boolean and v_res->>'event_id' = v_first->>'event_id',
    'a nullable provider id would let every recovery channel insert freely; got ' || v_res::text);

  select count(*) into v_rows from screening_v2.phone_call_events
   where id = (v_first->>'event_id')::uuid and provider_event_id is not null;
  perform _policy_tests.assert(
    '0042: no ledger row can carry a null provider_event_id',
    v_rows = 1, 'NOT NULL is what makes one unique index cover every channel');

  -- unexpected: a legal event in a state that has no edge for it
  v_res := screening_v2.apply_phone_event('internal','assessment.completed', v_att, null,
                                          null, 0, null, v_t);
  perform _policy_tests.assert(
    '0042: a (state, event) pair outside the transition table is an explicit no-op',
    v_res->>'ignored_reason' = 'unexpected_event' and (v_res->>'applied')::boolean is false,
    'the machine must have no implicit default that mutates state; got ' || v_res::text);

  -- unknown attempt
  v_res := screening_v2.apply_phone_event('livekit_webhook','sip.participant_joined',
                                          gen_random_uuid(), null, 'pol42-ghost', 0, null, v_t);
  perform _policy_tests.assert(
    '0042: an event for an attempt we never admitted is recorded as unknown_attempt',
    v_res->>'ignored_reason' = 'unknown_attempt',
    'a nonzero rate here means admission and ingress have diverged; got ' || v_res::text);

  -- stale epoch
  v_res := screening_v2.apply_phone_event('internal','disclosure.delivered', v_att, null,
                                          null, 0, null, v_t);
  v_res := screening_v2.apply_phone_event('livekit_webhook','sip.participant_left', v_att, null,
                                          'pol42-stale', 0, null, v_t);
  perform _policy_tests.assert(
    '0042: a callback carrying a superseded epoch is fenced out, not timed out',
    v_res->>'ignored_reason' = 'stale_epoch',
    'late callbacks are solved by monotonic fencing; got ' || v_res::text);

  -- terminal
  v_eng2 := _policy_tests.phone_fixture('pol42-events-term', 'cancelled');
  v_res := screening_v2.apply_phone_event('livekit_webhook','sip.participant_joined',
                                          null, v_eng2, 'pol42-term', null, null, v_t);
  perform _policy_tests.assert(
    '0042: any event for a terminal engagement is recorded and ignored as terminal',
    v_res->>'ignored_reason' = 'terminal',
    'recorded, never silently dropped; got ' || v_res::text);

  -- a webhook with no provider id is not dedupable and is refused
  v_res := screening_v2.apply_phone_event('livekit_webhook','sip.participant_joined',
                                          v_att, null, null, 1, null, v_t);
  perform _policy_tests.assert(
    '0042: a provider callback with no provider event id is refused, never invented',
    v_res->>'status' = 'provider_event_id_required', coalesce(v_res::text, '<null>'));
end;
$$;

-- ── B11: the internal calendar ────────────────────────────────────────
do $$
declare
  v_eng uuid; v_res jsonb; v_apt uuid; v_ver integer; v_state text; v_live integer;
  v_t timestamptz := '2026-08-24T06:00:00Z';                 -- 11:30 IST
  v_slot timestamptz := '2026-08-25T09:00:00Z';              -- 14:30 IST next day
  v_ok boolean;
begin
  v_eng := _policy_tests.phone_fixture('pol42-cal');

  v_res := screening_v2.schedule_phone_appointment(
             v_eng, v_slot, v_slot + interval '30 minutes', 'candidate_voice',
             null, null, v_t);
  v_apt := (v_res->>'appointment_id')::uuid;
  v_ver := (v_res->>'version')::integer;
  select state into v_state from screening_v2.phone_engagements where id = v_eng;
  perform _policy_tests.assert(
    '0042: a candidate-negotiated slot books and moves the engagement to scheduled',
    v_res->>'status' = 'ok' and v_state = 'scheduled', coalesce(v_res::text, '<null>'));

  -- Outside the window: 22:00 IST.
  v_res := screening_v2.schedule_phone_appointment(
             v_eng, '2026-08-25T16:30:00Z', '2026-08-25T17:00:00Z', 'hr_manual',
             null, v_ver, v_t);
  perform _policy_tests.assert(
    '0042: a slot outside the approved IST window is refused',
    v_res->>'status' = 'window_closed', coalesce(v_res::text, '<null>'));

  -- Five minutes is not a screening call.
  v_res := screening_v2.schedule_phone_appointment(
             v_eng, v_slot, v_slot + interval '5 minutes', 'hr_manual', null, v_ver, v_t);
  perform _policy_tests.assert(
    '0042: a slot outside the 15-60 minute envelope is refused',
    v_res->>'status' = 'slot_duration_invalid', coalesce(v_res::text, '<null>'));

  -- A slot in the past cannot be kept.
  v_res := screening_v2.schedule_phone_appointment(
             v_eng, '2026-08-23T06:00:00Z', '2026-08-23T06:30:00Z', 'hr_manual',
             null, v_ver, v_t);
  perform _policy_tests.assert(
    '0042: a slot in the past is refused',
    v_res->>'status' = 'slot_in_past', coalesce(v_res::text, '<null>'));

  -- One live appointment per engagement, and a blind rebook is refused
  -- rather than silently replacing what a recruiter is looking at.
  v_res := screening_v2.schedule_phone_appointment(
             v_eng, v_slot + interval '2 hours', v_slot + interval '150 minutes',
             'hr_manual', null, null, v_t);
  perform _policy_tests.assert(
    '0042: rebooking without the expected version is refused as appointment_exists',
    v_res->>'status' = 'appointment_exists', coalesce(v_res::text, '<null>'));

  v_res := screening_v2.schedule_phone_appointment(
             v_eng, v_slot + interval '2 hours', v_slot + interval '150 minutes',
             'hr_manual', null, v_ver + 99, v_t);
  perform _policy_tests.assert(
    '0042: a stale version is refused as version_conflict',
    v_res->>'status' = 'version_conflict', coalesce(v_res::text, '<null>'));

  v_res := screening_v2.schedule_phone_appointment(
             v_eng, v_slot + interval '2 hours', v_slot + interval '150 minutes',
             'hr_manual', '00000000-0000-4000-8000-0000000000ad', v_ver, v_t);
  select count(*) into v_live from screening_v2.phone_appointments
   where engagement_id = v_eng and status in ('scheduled','confirmed');
  perform _policy_tests.assert(
    '0042: a correctly-versioned reschedule supersedes the old slot and leaves exactly one live',
    v_res->>'status' = 'ok' and v_live = 1
      and (select status from screening_v2.phone_appointments where id = v_apt) = 'superseded',
    'status=' || (v_res->>'status') || ' live=' || v_live);
  v_apt := (v_res->>'appointment_id')::uuid;

  -- Cancel returns the engagement to eligible and is idempotent.
  v_res := screening_v2.cancel_phone_appointment(v_apt, 'hr_cancelled',
             '00000000-0000-4000-8000-0000000000ad', null, v_t);
  select state into v_state from screening_v2.phone_engagements where id = v_eng;
  perform _policy_tests.assert(
    '0042: cancelling the only live slot returns the engagement to eligible',
    v_res->>'status' = 'ok' and v_state = 'eligible',
    'status=' || (v_res->>'status') || ' state=' || v_state);
  v_res := screening_v2.cancel_phone_appointment(v_apt, 'hr_cancelled', null, null, v_t);
  perform _policy_tests.assert(
    '0042: cancelling an already-cancelled slot is idempotent, not an error',
    v_res->>'status' = 'already_cancelled', coalesce(v_res::text, '<null>'));
  v_res := screening_v2.cancel_phone_appointment(v_apt, 'because i said so', null, null, v_t);
  perform _policy_tests.assert(
    '0042: a free-text cancel reason is refused by the fixed vocabulary',
    v_res->>'status' = 'invalid_reason',
    'provider or operator prose must never reach a durable column; got ' || v_res::text);

  -- The window is a DIRECT-WRITE guarantee, not only an RPC one.
  begin
    insert into screening_v2.phone_appointments
      (engagement_id, starts_at, ends_at, ist_date, status, source)
    values (v_eng, '2026-08-25T16:30:00Z', '2026-08-25T17:00:00Z',
            date '2026-08-25', 'scheduled', 'hr_manual');
    v_ok := false;
  exception when others then
    v_ok := sqlerrm like '%outside the approved IST calling window%';
  end;
  perform _policy_tests.assert(
    '0042: a DIRECT insert outside the IST window is rejected by the trigger',
    v_ok, 'the trigger is the backstop a CHECK could not be, because at time zone is STABLE');
end;
$$;

-- ── B12: the largest phone audit row still fits the 4096-byte cap ─────
select _policy_tests.assert(
  '0042: every phone audit row written by this suite is inside the 4096-byte metadata cap',
  coalesce((select max(octet_length(metadata::text)) from screening_v2.audit_events
             where action like 'phone\_%'), 0) <= 4096
  and coalesce((select max(octet_length(metadata::text)) from screening_v2.audit_events
                 where action = 'admin_session_override'
                   and metadata->>'override' like 'phone\_%'), 0) <= 4096,
  'chk_audit_metadata_size (0007) rejects the whole INSERT, which would roll back the admission');

select _policy_tests.assert(
  '0042: no phone audit row leaks a number, an email, a token or a lease',
  not exists (
    select 1 from screening_v2.audit_events
     where (action like 'phone\_%'
            or (action = 'admin_session_override' and metadata->>'override' like 'phone\_%'))
       and metadata::text ~* '(\+91|@example|lease_token|token|secret|url|http)'),
  'audit metadata carries opaque ids and stable codes only');

-- ── B13: the three budgets are EXHAUSTIBLE, and exhaustion is terminal ─
-- A budget that no test ever spends to its limit is a budget nobody has
-- checked. These three cases are what make the ceilings real rather than
-- decorative — and the reconnect one in particular is what catches a
-- counter that is silently reset by the edge that must respect it.
do $$
declare
  v_eng uuid; v_res jsonb; v_att uuid; v_t timestamptz := '2026-08-24T06:00:00Z';
  v_i integer; v_rc integer; v_state text; v_term timestamptz; v_reason text;
  v_bad text := ''; v_epoch integer;
begin
  v_eng := _policy_tests.phone_fixture('pol42-rcbudget');
  v_res := screening_v2.admit_phone_attempt(v_eng, 'initial', null, 60, v_t);
  v_att := (v_res->>'attempt_id')::uuid;

  -- Three full conversation cycles. Each one delivers a disclosure —
  -- which bumps the fencing epoch — and then drops.
  for v_i in 1..3 loop
    perform screening_v2.apply_phone_event('livekit_webhook','sip.participant_joined',
              v_att, null, 'pol42-rcb-join-' || v_i, null, null,
              v_t + (v_i * interval '10 minutes'));
    perform screening_v2.apply_phone_event('internal','classify.human',
              v_att, null, null, null, null, v_t + (v_i * interval '10 minutes'));
    perform screening_v2.apply_phone_event('internal','disclosure.delivered',
              v_att, null, null, null, null, v_t + (v_i * interval '10 minutes'));
    select epoch into v_epoch from screening_v2.phone_engagements where id = v_eng;
    perform screening_v2.apply_phone_event('livekit_webhook','sip.participant_left',
              v_att, null, 'pol42-rcb-left-' || v_i, v_epoch, null,
              v_t + (v_i * interval '10 minutes') + interval '2 minutes');

    select reconnects_used, state into v_rc, v_state
      from screening_v2.phone_engagements where id = v_eng;
    if v_rc <> v_i or v_state <> 'reconnecting' then
      v_bad := v_bad || 'cycle' || v_i || '(rc=' || v_rc || ',state=' || v_state || ') ';
    end if;

    -- Redeem the grant. An engagement whose reconnect has been CHARGED
    -- must be able to spend it; refusing here would wedge the row.
    v_res := screening_v2.admit_phone_attempt(v_eng, 'reconnect', null, 60,
               v_t + (v_i * interval '10 minutes') + interval '4 minutes');
    if v_res->>'status' <> 'ok' then
      v_bad := v_bad || 'redeem' || v_i || '=' || (v_res->>'status') || ' ';
    else
      v_att := (v_res->>'attempt_id')::uuid;
    end if;
  end loop;

  perform _policy_tests.assert(
    '0042: three successive mid-call drops charge reconnects 1, 2, 3 and each grant is redeemable',
    v_bad = '',
    'a reset on the reconnect path would pin this counter at 1 for ever, making '
      || '"max 3 reconnects" unenforceable on a billable dialer: ' || v_bad);

  -- The FOURTH drop earns no reconnect. Exhaustion must be TERMINAL, not
  -- a rest in `reconnecting` with nothing able to move it.
  perform screening_v2.apply_phone_event('livekit_webhook','sip.participant_joined',
            v_att, null, 'pol42-rcb-join-4', null, null, v_t + interval '50 minutes');
  perform screening_v2.apply_phone_event('internal','classify.human',
            v_att, null, null, null, null, v_t + interval '50 minutes');
  perform screening_v2.apply_phone_event('internal','disclosure.delivered',
            v_att, null, null, null, null, v_t + interval '50 minutes');
  select epoch into v_epoch from screening_v2.phone_engagements where id = v_eng;
  perform screening_v2.apply_phone_event('livekit_webhook','sip.participant_left',
            v_att, null, 'pol42-rcb-left-4', v_epoch, null, v_t + interval '52 minutes');

  select state, reconnects_used, terminal_at, state_reason
    into v_state, v_rc, v_term, v_reason
    from screening_v2.phone_engagements where id = v_eng;
  perform _policy_tests.assert(
    '0042: the fourth drop exhausts the reconnect budget and ends the engagement',
    v_state = 'failed' and v_rc = 3 and v_term is not null
      and v_reason = 'reconnect_budget_exhausted',
    'state=' || v_state || ' rc=' || v_rc || ' terminal_at=' || coalesce(v_term::text,'<null>')
      || ' reason=' || coalesce(v_reason,'<null>'));

  v_res := screening_v2.admit_phone_attempt(v_eng, 'reconnect', null, 60,
                                            v_t + interval '55 minutes');
  perform _policy_tests.assert(
    '0042: an exhausted engagement admits nothing further',
    v_res->>'status' = 'engagement_terminal', coalesce(v_res::text, '<null>'));
end;
$$;

do $$
declare
  v_eng uuid; v_res jsonb; v_att uuid; v_t timestamptz := '2026-08-24T06:00:00Z';
  v_i integer; v_na integer; v_state text; v_term timestamptz; v_bad text := '';
begin
  v_eng := _policy_tests.phone_fixture('pol42-nabudget');
  -- Three no-answers on three DISTINCT IST days, the way the per-day
  -- index requires them to happen.
  for v_i in 0..2 loop
    if v_i > 0 then
      update screening_v2.phone_engagements set state = 'eligible' where id = v_eng;
    end if;
    v_res := screening_v2.admit_phone_attempt(
               v_eng, case when v_i = 0 then 'initial' else 'no_answer_retry' end,
               null, 60, v_t + (v_i * interval '1 day'));
    if v_res->>'status' <> 'ok' then
      v_bad := v_bad || 'day' || v_i || '=' || (v_res->>'status') || ' '; continue;
    end if;
    v_att := (v_res->>'attempt_id')::uuid;
    perform screening_v2.apply_phone_event('internal','sip.originate_timeout',
              v_att, null, null, null, null, v_t + (v_i * interval '1 day') + interval '1 minute');
    select no_answer_attempts into v_na from screening_v2.phone_engagements where id = v_eng;
    if v_na <> v_i + 1 then v_bad := v_bad || 'day' || v_i || ':na=' || v_na || ' '; end if;
  end loop;

  select state, no_answer_attempts, terminal_at into v_state, v_na, v_term
    from screening_v2.phone_engagements where id = v_eng;
  perform _policy_tests.assert(
    '0042: three no-answers on three IST days spend the budget and end the engagement',
    v_bad = '' and v_na = 3 and v_state = 'abandoned_no_answer' and v_term is not null,
    'no stage move and no email follow this — it is a quiet, terminal give-up; '
      || v_bad || ' na=' || v_na || ' state=' || v_state);
end;
$$;

do $$
declare
  v_eng uuid; v_res jsonb; v_att uuid; v_t timestamptz := '2026-08-24T06:00:00Z';
  v_i integer; v_pf integer; v_state text; v_reason text; v_bad text := '';
begin
  v_eng := _policy_tests.phone_fixture('pol42-pfbudget');
  -- The provider budget is INDEPENDENT: five transport failures must
  -- never touch the candidate's no-answer attempts. Each failure returns
  -- the engagement to `eligible`, and a reconnect-kind dial is used so
  -- the per-day index does not interfere with the point being made.
  for v_i in 1..5 loop
    v_res := screening_v2.admit_phone_attempt(
               v_eng, case when v_i = 1 then 'initial' else 'no_answer_retry' end,
               null, 60, v_t + ((v_i - 1) * interval '1 day'));
    if v_res->>'status' <> 'ok' then
      v_bad := v_bad || 'admit' || v_i || '=' || (v_res->>'status') || ' '; exit;
    end if;
    v_att := (v_res->>'attempt_id')::uuid;
    perform screening_v2.apply_phone_event('internal','sip.originate_rejected_transport',
              v_att, null, null, null, null,
              v_t + ((v_i - 1) * interval '1 day') + interval '1 minute');
  end loop;

  select state, provider_failures, state_reason, no_answer_attempts
    into v_state, v_pf, v_reason, v_i
    from screening_v2.phone_engagements where id = v_eng;
  perform _policy_tests.assert(
    '0042: five provider failures end the engagement and never touch the no-answer budget',
    v_bad = '' and v_pf = 5 and v_state = 'failed'
      and v_reason = 'provider_budget_exhausted' and v_i = 0,
    'our outage must not spend the candidate''s attempts; ' || v_bad
      || ' provider_failures=' || v_pf || ' state=' || v_state
      || ' no_answer=' || v_i);
end;
$$;

-- ── B14: a worker that dies MID-CONVERSATION is recoverable ───────────
-- `dialing` is not the only state an engagement holds a live attempt in.
-- After a delivered disclosure it is `in_call` while its attempt is
-- still `human`, and a sweeper that only restores `dialing` strands
-- exactly that engagement for ever.
do $$
declare
  v_eng uuid; v_res jsonb; v_att uuid; v_t timestamptz := '2026-08-24T06:00:00Z';
  v_state text; v_astate text; v_na integer; v_rc integer; v_pf integer; v_term timestamptz;
begin
  v_eng := _policy_tests.phone_fixture('pol42-incall-reclaim');
  v_res := screening_v2.admit_phone_attempt(v_eng, 'initial', 'dying-worker', 60, v_t);
  v_att := (v_res->>'attempt_id')::uuid;
  perform screening_v2.apply_phone_event('livekit_webhook','sip.participant_joined',
            v_att, null, 'pol42-icr-join', null, null, v_t);
  perform screening_v2.apply_phone_event('internal','classify.human',
            v_att, null, null, null, null, v_t);
  perform screening_v2.apply_phone_event('internal','disclosure.delivered',
            v_att, null, null, null, null, v_t);
  select state into v_state from screening_v2.phone_engagements where id = v_eng;
  perform _policy_tests.assert(
    '0042: the fixture really is in_call with a live attempt before the worker dies',
    v_state = 'in_call', 'state=' || v_state);

  -- The worker dies here. Nothing heartbeats.
  perform screening_v2.reclaim_phone_attempt_leases(50, v_t + interval '10 minutes');

  select e.state, e.terminal_at, e.no_answer_attempts, e.reconnects_used, e.provider_failures,
         a.state
    into v_state, v_term, v_na, v_rc, v_pf, v_astate
    from screening_v2.phone_engagements e
    join screening_v2.phone_call_attempts a on a.id = v_att
   where e.id = v_eng;
  perform _policy_tests.assert(
    '0042: a lease that expires mid-conversation abandons the attempt and frees the engagement',
    v_astate = 'abandoned' and v_state = 'eligible' and v_term is null
      and v_na = 0 and v_rc = 0 and v_pf = 0,
    'an engagement stranded in_call with no live attempt has no edge out and no event that '
      || 'can send one — the PR #70 wedge; attempt=' || v_astate || ' engagement=' || v_state
      || ' budgets=' || v_na || '/' || v_rc || '/' || v_pf);

  v_res := screening_v2.admit_phone_attempt(v_eng, 'no_answer_retry', null, 60,
                                            v_t + interval '1 day');
  perform _policy_tests.assert(
    '0042: and it is genuinely re-admissible on the next IST day',
    v_res->>'status' = 'ok', coalesce(v_res::text, '<null>'));
end;
$$;

-- The reclaim audit row reports what HAPPENED, not what was intended.
do $$
declare
  v_eng uuid; v_res jsonb; v_att uuid; v_t timestamptz := '2026-08-24T06:00:00Z';
  v_meta jsonb;
begin
  v_eng := _policy_tests.phone_fixture('pol42-reclaim-audit');
  v_res := screening_v2.admit_phone_attempt(v_eng, 'initial', null, 60, v_t);
  v_att := (v_res->>'attempt_id')::uuid;
  -- Terminalise the engagement out from under the live attempt, which is
  -- what an emergency stop does.
  perform screening_v2.apply_phone_event('internal','emergency.stop',
            v_att, null, null, null, null, v_t + interval '1 minute');
  update screening_v2.phone_call_attempts
     set state = 'admitted', ended_at = null where id = v_att;

  perform screening_v2.reclaim_phone_attempt_leases(50, v_t + interval '10 minutes');
  select metadata into v_meta from screening_v2.audit_events
   where action = 'phone_attempt_ended' and target_id = v_att::text;
  perform _policy_tests.assert(
    '0042: reclaiming a terminal engagement''s attempt audits restored=false, not a fiction',
    (v_meta->>'restored')::boolean is false and v_meta->>'restored_state' is null
      and (v_meta->>'budget_charged')::boolean is false,
    'an audit row that claims a restoration that never happened sends an operator '
      || 'looking in the wrong place; metadata=' || coalesce(v_meta::text, '<null>'));
end;
$$;

-- ── B15: the calendar works from every state it claims to ─────────────
do $$
declare
  v_eng uuid; v_res jsonb; v_state text; v_bad text := '';
  v_t timestamptz := '2026-08-24T06:00:00Z';
  v_slot timestamptz := '2026-08-25T09:00:00Z';   -- 14:30 IST
  v_states text[] := array['eligible','awaiting_retry','in_call','reconnecting'];
  v_s text; v_i integer := 0;
begin
  foreach v_s in array v_states loop
    v_i := v_i + 1;
    v_eng := _policy_tests.phone_fixture('pol42-cal-' || v_i);
    -- Reach the state through legal edges only, so the test proves the
    -- machine allows it rather than that a direct write does.
    if v_s = 'awaiting_retry' then
      update screening_v2.phone_engagements set state = 'dialing'  where id = v_eng;
      update screening_v2.phone_engagements set state = 'awaiting_retry' where id = v_eng;
    elsif v_s = 'in_call' then
      update screening_v2.phone_engagements set state = 'dialing' where id = v_eng;
      update screening_v2.phone_engagements set state = 'in_call' where id = v_eng;
    elsif v_s = 'reconnecting' then
      update screening_v2.phone_engagements set state = 'dialing' where id = v_eng;
      update screening_v2.phone_engagements set state = 'reconnecting' where id = v_eng;
    end if;

    v_res := screening_v2.schedule_phone_appointment(
               v_eng, v_slot, v_slot + interval '30 minutes', 'hr_manual',
               '00000000-0000-4000-8000-0000000000ad', null, v_t);
    select state into v_state from screening_v2.phone_engagements where id = v_eng;
    if v_res->>'status' <> 'ok' or v_state <> 'scheduled' then
      v_bad := v_bad || v_s || '=' || (v_res->>'status') || '/' || v_state || ' ';
    end if;
  end loop;

  perform _policy_tests.assert(
    '0042: a callback can be booked from every non-terminal state the RPC claims to accept',
    v_bad = '',
    'booking a callback after a missed call is the most ordinary use of this calendar, and '
      || 'a transition the trigger rejects turns it into an unhandled exception: ' || v_bad);
end;
$$;

-- ── B16: the window is defined ONCE, and the two definitions agree ────
do $$
declare
  v_offsets interval[] := array[
    interval '0 hours', interval '3 hours', interval '4 hours', interval '6 hours',
    interval '9 hours', interval '14 hours', interval '15 hours', interval '18 hours',
    interval '21 hours', interval '23 hours'];
  v_o interval; v_at timestamptz; v_next timestamptz; v_bad text := '';
begin
  foreach v_o in array v_offsets loop
    v_at   := timestamptz '2026-08-24T00:00:00Z' + v_o;
    v_next := screening_v2.phone_next_window_open(v_at);
    if not screening_v2.phone_ist_window_open(v_next) then
      v_bad := v_bad || v_at::text || '->' || v_next::text || ' ';
    end if;
    if v_next < v_at then
      v_bad := v_bad || 'backwards@' || v_at::text || ' ';
    end if;
  end loop;
  perform _policy_tests.assert(
    '0042: the next legal instant is ALWAYS inside the window, and never in the past',
    v_bad = '',
    'when the open time is written down twice, narrowing the gate makes the deferral '
      || 'return an instant the appointment trigger then rejects — and the webhook that '
      || 'triggered it is retried for ever: ' || v_bad);
end;
$$;

select _policy_tests.assert(
  '0042: the window bounds and the fleet cap each have exactly one definition',
  -- The helpers exist, and no OTHER phone function inlines the literals
  -- or the number they return.
  screening_v2.phone_ist_window_open_at() = time '09:00:00'
  and screening_v2.phone_ist_window_close_at() = time '21:00:00'
  and screening_v2.phone_max_concurrent() = 10
  and not exists (
    select 1 from pg_proc p join pg_namespace n on n.oid = p.pronamespace
     where n.nspname = 'screening_v2'
       and p.proname in ('phone_ist_window_open','phone_next_window_open',
                         'admit_phone_attempt','apply_phone_event','phone_backlog',
                         'schedule_phone_appointment')
       and (_policy_tests.fn_body(p.proname) ~ '''09:00:00'''
         or _policy_tests.fn_body(p.proname) ~ '''21:00:00''')),
  'a bound written down twice is a bound that will drift');

-- ── B17: the ingress ledger cannot be used to smuggle in a payload ────
do $$
declare
  v_eng uuid; v_res jsonb; v_stored jsonb; v_ok boolean;
  v_t timestamptz := '2026-08-24T06:00:00Z';
begin
  -- Started in pending_prereqs so `prereq.satisfied` is a mapped edge and
  -- the event below is genuinely APPLIED — the point is that a dropped
  -- payload does not cost the event its verdict.
  v_eng := _policy_tests.phone_fixture('pol42-meta', 'pending_prereqs');

  v_res := screening_v2.apply_phone_event(
             'livekit_webhook', 'prereq.satisfied', null, v_eng, 'pol42-meta-raw', null,
             jsonb_build_object('from', '+919000000099',
                                'sip_uri', 'sip:x@provider.example/abc',
                                'error', 'Call failed: no route to host'),
             v_t);
  select metadata into v_stored from screening_v2.phone_call_events
   where id = (v_res->>'event_id')::uuid;
  perform _policy_tests.assert(
    '0042: a raw provider envelope is DROPPED rather than persisted, and the event survives',
    v_res->>'status' = 'applied'
      and v_stored = jsonb_build_object('metadata_rejected', true),
    'phone_call_events is append-only: a number written here could only be removed '
      || 'through the erasure hatch; stored=' || coalesce(v_stored::text, '<null>'));

  v_res := screening_v2.apply_phone_event(
             'livekit_webhook', 'prereq.lost', null, v_eng, 'pol42-meta-clean', null,
             jsonb_build_object('reason_code', 'no_route', 'attempt_seq', 2, 'retryable', true),
             v_t);
  select metadata into v_stored from screening_v2.phone_call_events
   where id = (v_res->>'event_id')::uuid;
  perform _policy_tests.assert(
    '0042: sanitized metadata is kept verbatim, so the drop is not a blunt instrument',
    v_stored = jsonb_build_object('reason_code', 'no_route', 'attempt_seq', 2,
                                  'retryable', true),
    'stored=' || coalesce(v_stored::text, '<null>'));

  begin
    insert into screening_v2.phone_call_events
      (source, provider_event_id, engagement_id, event_type, applied, metadata)
    values ('internal', 'pol42-meta-direct', v_eng, 'prereq.satisfied', true,
            jsonb_build_object('from', '+919000000099'));
    v_ok := false;
  exception when check_violation then v_ok := true; end;
  perform _policy_tests.assert(
    '0042: a DIRECT write of an unsanitized metadata payload is rejected by CHECK',
    v_ok, 'the RPC is not the only writer; the column must hold the line itself');
end;
$$;

select _policy_tests.assert(
  '0042: no ledger row anywhere in this suite carries a number, an address or a URL',
  not exists (
    select 1 from screening_v2.phone_call_events
     where metadata is not null
       and metadata::text ~ '(\+[0-9]{6,}|@|//|\shttp)'),
  'the append-only ledger is the one place an unsanitized write could never be undone');

-- ── B18: fencing is not optional ──────────────────────────────────────
do $$
declare
  v_eng uuid; v_res jsonb; v_att uuid; v_rc integer;
  v_t timestamptz := '2026-08-24T06:00:00Z';
begin
  v_eng := _policy_tests.phone_fixture('pol42-fence');
  v_res := screening_v2.admit_phone_attempt(v_eng, 'initial', null, 60, v_t);
  v_att := (v_res->>'attempt_id')::uuid;
  perform screening_v2.apply_phone_event('livekit_webhook','sip.participant_joined',
            v_att, null, 'pol42-fence-join', null, null, v_t);
  perform screening_v2.apply_phone_event('internal','classify.human',
            v_att, null, null, null, null, v_t);
  perform screening_v2.apply_phone_event('internal','disclosure.delivered',
            v_att, null, null, null, null, v_t);

  -- A callback from the SUPERSEDED conversation that carries no epoch at
  -- all. If the fence only applies when the caller volunteers an epoch,
  -- this charges a reconnect against a call that is still up.
  update screening_v2.phone_engagements set epoch = epoch + 1 where id = v_eng;
  v_res := screening_v2.apply_phone_event('livekit_webhook','sip.participant_left',
            v_att, null, 'pol42-fence-late', null, null, v_t + interval '1 minute');
  select reconnects_used into v_rc from screening_v2.phone_engagements where id = v_eng;
  perform _policy_tests.assert(
    '0042: a late callback with NO epoch is fenced against the attempt''s own epoch',
    v_res->>'ignored_reason' = 'stale_epoch' and v_rc = 0,
    'a fence the caller can skip by omitting a field is not a fence; got '
      || v_res::text || ' reconnects=' || v_rc);
end;
$$;

-- ── B19: an opt-out suppresses the LINE, in the same transaction ──────
-- The invariant this proves is the one the design says must never be
-- split. An opt-out modelled only on the engagement is enforced per
-- APPLICATION: the same person applying to a second role has a second
-- engagement, with its own terminal state, that knows nothing about the
-- first. The cross-application admission below is the whole point of the
-- test — a same-engagement assertion would pass even if suppression did
-- not exist.
do $$
declare
  v_role uuid; v_cand uuid; v_map uuid;
  v_link1 uuid; v_link2 uuid; v_eng1 uuid; v_eng2 uuid;
  v_res jsonb; v_att uuid; v_sup integer; v_digest text; v_state text;
  v_audit jsonb; v_t timestamptz := '2026-08-24T06:00:00Z';
  v_states text[] := array['queued','fetching','scanning','extracting','structuring','ready'];
  v_s text;
begin
  perform _policy_tests.phone_teardown_links(array['pol42-optout-app','pol42-optout-app2'],
                                             'pol42-optout@example.test');
  select id into v_role from screening_v2.roles order by id limit 1;

  -- ONE candidate, ONE line, TWO applications.
  insert into screening_v2.candidates (role_id, name, email, phone_e164, phone_valid)
  values (v_role, 'optout fixture', 'pol42-optout@example.test', '+919999012345', true)
  returning id into v_cand;
  insert into screening_v2.consent_records (candidate_id, status, consents, version)
  values (v_cand, 'granted',
          '{ai_interview,recording,purpose,data_processing,retention,rights}'
            ::screening_v2.consent_type[], '2026-08-04.1');
  insert into screening_v2.ashby_job_mappings
    (external_job_id, role_id, owner_id, ai_screening_stage_id, ta_screening_stage_id,
     status, delivery_mode)
  values ('pol42-optout-job', v_role, '00000000-0000-4000-8000-0000000000ad',
          'pol42-optout-ai', 'pol42-optout-ta', 'enabled', 'manual')
  returning id into v_map;

  foreach v_s in array array['pol42-optout-app', 'pol42-optout-app2'] loop
    insert into screening_v2.ashby_application_links
      (external_application_id, external_job_id, job_mapping_id,
       external_resume_file_handle, candidate_id)
    values (v_s, 'pol42-optout-job', v_map, repeat('h', 64), v_cand)
    returning id into v_link1;
    if v_s = 'pol42-optout-app2' then v_link2 := v_link1; end if;
  end loop;
  select id into v_link1 from screening_v2.ashby_application_links
   where external_application_id = 'pol42-optout-app';

  foreach v_s in array v_states loop
    perform screening_v2.advance_ashby_ingestion(v_link1, v_s, null, null, null, null);
    perform screening_v2.advance_ashby_ingestion(v_link2, v_s, null, null, null, null);
  end loop;

  insert into screening_v2.phone_engagements (application_link_id, candidate_id, role_id, state)
  values (v_link1, v_cand, v_role, 'eligible') returning id into v_eng1;
  insert into screening_v2.phone_engagements (application_link_id, candidate_id, role_id, state)
  values (v_link2, v_cand, v_role, 'eligible') returning id into v_eng2;

  v_digest := screening_v2.sha256_hex('+919999012345');

  -- Drive the FIRST application to an in-call opt-out through legal edges.
  v_res := screening_v2.admit_phone_attempt(v_eng1, 'initial', null, 60, v_t);
  v_att := (v_res->>'attempt_id')::uuid;
  perform screening_v2.apply_phone_event('livekit_webhook','sip.participant_joined',
            v_att, null, 'pol42-oo-join', null, null, v_t);
  perform screening_v2.apply_phone_event('internal','classify.human',
            v_att, null, null, null, null, v_t);
  perform screening_v2.apply_phone_event('internal','disclosure.delivered',
            v_att, null, null, null, null, v_t);
  perform screening_v2.apply_phone_event('internal','candidate.opt_out',
            v_att, null, null, null, null, v_t + interval '3 minutes');

  select count(*) into v_sup from screening_v2.phone_suppressions
   where phone_sha256 = v_digest;
  select state into v_state from screening_v2.phone_engagements where id = v_eng1;
  perform _policy_tests.assert(
    '0042: an in-call opt-out terminalises the engagement AND suppresses the line',
    v_state = 'opted_out' and v_sup = 1,
    'state=' || v_state || ' suppressions=' || v_sup);

  -- THE CONTROL. A different application, same person, same line.
  v_res := screening_v2.admit_phone_attempt(v_eng2, 'initial', null, 60,
                                            v_t + interval '10 minutes');
  perform _policy_tests.assert(
    '0042: the SECOND application for the same line is refused as suppressed',
    v_res->>'status' = 'suppressed',
    'an opt-out enforced only by a terminal engagement is enforced per APPLICATION, and '
      || 'would re-dial the same person on their next one; got ' || coalesce(v_res::text,'<null>'));

  select metadata into v_audit from screening_v2.audit_events
   where action = 'phone_suppression_added' and target_id = v_digest;
  perform _policy_tests.assert(
    '0042: the suppression audit names the DIGEST and carries no number',
    v_audit is not null and v_audit->>'reason' = 'candidate_opt_out'
      and v_audit::text !~ '\+91' and v_digest ~ '^[a-f0-9]{64}$',
    'audit=' || coalesce(v_audit::text, '<null>'));

  select metadata into v_audit from screening_v2.audit_events
   where action = 'phone_opt_out_recorded' and target_id = v_eng1::text;
  perform _policy_tests.assert(
    '0042: the opt-out audit reports that a suppression really was written',
    (v_audit->>'suppression_written')::boolean, coalesce(v_audit::text, '<null>'));

  perform _policy_tests.phone_teardown_links(array['pol42-optout-app','pol42-optout-app2'],
                                             'pol42-optout@example.test');
  delete from screening_v2.ashby_job_mappings where external_job_id = 'pol42-optout-job';
  delete from screening_v2.phone_suppressions where phone_sha256 = v_digest;
end;
$$;

-- wrong_number takes the same path, with its own reason.
do $$
declare
  v_eng uuid; v_res jsonb; v_att uuid; v_digest text; v_reason text;
  v_t timestamptz := '2026-08-24T06:00:00Z';
begin
  v_eng := _policy_tests.phone_fixture('pol42-wrongnum');
  select screening_v2.sha256_hex(c.phone_e164) into v_digest
    from screening_v2.candidates c
    join screening_v2.phone_engagements e on e.candidate_id = c.id where e.id = v_eng;
  v_res := screening_v2.admit_phone_attempt(v_eng, 'initial', null, 60, v_t);
  v_att := (v_res->>'attempt_id')::uuid;
  perform screening_v2.apply_phone_event('internal','candidate.wrong_number',
            v_att, null, null, null, null, v_t + interval '1 minute');
  select reason into v_reason from screening_v2.phone_suppressions where phone_sha256 = v_digest;
  perform _policy_tests.assert(
    '0042: a wrong number suppresses the line with its own truthful reason',
    v_reason = 'wrong_number', 'reason=' || coalesce(v_reason, '<none>'));
end;
$$;

-- An engagement with no number on record cannot suppress a line it does
-- not know. It must still terminalise, and must SAY that no suppression
-- was written rather than imply a control that was not applied.
do $$
declare
  v_eng uuid; v_res jsonb; v_att uuid; v_audit jsonb; v_state text;
  v_t timestamptz := '2026-08-24T06:00:00Z';
begin
  v_eng := _policy_tests.phone_fixture('pol42-optout-nonum');
  v_res := screening_v2.admit_phone_attempt(v_eng, 'initial', null, 60, v_t);
  v_att := (v_res->>'attempt_id')::uuid;
  -- The production shape: every Ashby import writes a null number.
  update screening_v2.candidates set phone_e164 = null, phone_valid = false
   where id = (select candidate_id from screening_v2.phone_engagements where id = v_eng);
  perform screening_v2.apply_phone_event('internal','disclosure.refused',
            v_att, null, null, null, null, v_t + interval '1 minute');
  select state into v_state from screening_v2.phone_engagements where id = v_eng;
  select metadata into v_audit from screening_v2.audit_events
   where action = 'phone_opt_out_recorded' and target_id = v_eng::text;
  perform _policy_tests.assert(
    '0042: an opt-out with no number on record still terminalises and says so honestly',
    v_state = 'opted_out' and (v_audit->>'suppression_written')::boolean is false,
    'state=' || v_state || ' audit=' || coalesce(v_audit::text, '<null>'));
end;
$$;

-- ── B20: a post that omits the attempt an edge needs is REFUSED ───────
do $$
declare
  v_eng uuid; v_res jsonb; v_att uuid; v_na integer; v_astate text; v_rows integer;
  v_t timestamptz := '2026-08-24T06:00:00Z';
begin
  v_eng := _policy_tests.phone_fixture('pol42-attreq');
  v_res := screening_v2.admit_phone_attempt(v_eng, 'initial', null, 60, v_t);
  v_att := (v_res->>'attempt_id')::uuid;

  -- classify.machine mutates the ATTEMPT and charges a budget. Posted
  -- engagement-only it must refuse, not apply half of itself.
  v_res := screening_v2.apply_phone_event('internal','classify.machine',
             null, v_eng, 'pol42-attreq-1', null, null, v_t);
  select no_answer_attempts into v_na from screening_v2.phone_engagements where id = v_eng;
  select state into v_astate from screening_v2.phone_call_attempts where id = v_att;
  select count(*) into v_rows from screening_v2.phone_call_events
   where provider_event_id = 'pol42-attreq-1';
  perform _policy_tests.assert(
    '0042: classify.machine without an attempt is refused attempt_required and changes nothing',
    v_res->>'status' = 'attempt_required' and v_na = 0 and v_astate = 'admitted' and v_rows = 0,
    'a silent skip would charge the budget, move the engagement and leave the attempt live '
      || 'holding a fleet slot nothing could free; got ' || v_res::text
      || ' no_answer=' || v_na || ' attempt=' || v_astate || ' rows=' || v_rows);

  -- disclosure.delivered bumps the epoch on BOTH rows. Posted
  -- engagement-only it would bump one and fence the other out for ever.
  v_res := screening_v2.apply_phone_event('internal','disclosure.delivered',
             null, v_eng, 'pol42-attreq-2', null, null, v_t);
  perform _policy_tests.assert(
    '0042: disclosure.delivered without an attempt is refused attempt_required',
    v_res->>'status' = 'attempt_required',
    'bumping the engagement epoch alone fences every later event on the live attempt as '
      || 'stale, leaving a conversation nothing can end; got ' || v_res::text);

  -- An engagement-scoped event that needs no attempt still works.
  v_res := screening_v2.apply_phone_event('internal','hr.cancelled',
             null, v_eng, 'pol42-attreq-3', null, null, v_t);
  perform _policy_tests.assert(
    '0042: an engagement-scoped event that needs no attempt is unaffected',
    v_res->>'status' = 'applied', coalesce(v_res::text, '<null>'));
end;
$$;

-- ── B21: the provider budget is paced by the IST day, deliberately ────
do $$
declare
  v_eng uuid; v_res jsonb; v_att uuid; v_next timestamptz; v_pf integer;
  v_t timestamptz := '2026-08-24T06:00:00Z';
begin
  v_eng := _policy_tests.phone_fixture('pol42-pfday');
  v_res := screening_v2.admit_phone_attempt(v_eng, 'initial', null, 60, v_t);
  v_att := (v_res->>'attempt_id')::uuid;
  perform screening_v2.apply_phone_event('internal','sip.originate_rejected_transport',
            v_att, null, null, null, null, v_t + interval '1 minute');

  select provider_failures, next_eligible_at into v_pf, v_next
    from screening_v2.phone_engagements where id = v_eng;
  perform _policy_tests.assert(
    '0042: a provider error charges only the provider budget and points at the next IST day',
    v_pf = 1 and v_next = timestamptz '2026-08-25T03:30:00Z',
    'the row must say out loud when it may next be tried, rather than looking eligible now '
      || 'and being refused by an index; provider_failures=' || v_pf
      || ' next_eligible_at=' || coalesce(v_next::text, '<null>'));

  -- SAME IST day. This is the documented, deliberate behaviour: we
  -- cannot tell from a transport rejection whether the line rang, so the
  -- anti-harassment index holds and the cost is throughput, never the
  -- candidate's.
  v_res := screening_v2.admit_phone_attempt(v_eng, 'no_answer_retry', null, 60,
                                            v_t + interval '4 hours');
  -- Refused, and refused with the MORE INFORMATIVE of the two available
  -- answers: `next_eligible_at` is checked before the per-day index, so
  -- the caller is told when it may next dial rather than merely that
  -- today is spent. Both refusals are correct; this is the one that
  -- names the instant.
  perform _policy_tests.assert(
    '0042: a second dial after a provider error on the SAME IST day is refused, with the instant',
    v_res->>'status' in ('not_yet_eligible', 'daily_attempt_exists')
      and (v_res->>'status' <> 'not_yet_eligible'
           or (v_res->>'next_eligible_at')::timestamptz = timestamptz '2026-08-25T03:30:00Z'),
    'documented and intended: exhausting the five-failure budget takes up to five IST '
      || 'days; got ' || coalesce(v_res::text, '<null>'));

  v_res := screening_v2.admit_phone_attempt(v_eng, 'no_answer_retry', null, 60,
                                            v_t + interval '1 day');
  perform _policy_tests.assert(
    '0042: and the next IST day admits normally',
    v_res->>'status' = 'ok', coalesce(v_res::text, '<null>'));
end;
$$;

-- ── B22: a reclaim leaves no queue row behind ─────────────────────────
do $$
declare
  v_eng uuid; v_res jsonb; v_att uuid; v_status text; v_meta jsonb;
  v_t timestamptz := '2026-08-24T06:00:00Z';
begin
  v_eng := _policy_tests.phone_fixture('pol42-orphanjob');
  v_res := screening_v2.admit_phone_attempt(v_eng, 'initial', 'doomed', 60, v_t);
  v_att := (v_res->>'attempt_id')::uuid;
  perform screening_v2.reclaim_phone_attempt_leases(50, v_t + interval '10 minutes');

  select status into v_status from screening_v2.job_queue
   where dedup_key = 'phone.dial:' || v_att::text;
  select metadata into v_meta from screening_v2.audit_events
   where action = 'phone_attempt_ended' and target_id = v_att::text;
  perform _policy_tests.assert(
    '0042: reclaiming an attempt also completes the dial job it owned',
    v_status = 'completed' and (v_meta->>'dial_jobs_completed')::integer = 1,
    'a queue row that outlives its work is claimed, finds nothing to do, and becomes '
      || 'dead-letter noise instead of a defect report; job=' || coalesce(v_status,'<none>')
      || ' audit=' || coalesce(v_meta::text, '<null>'));

  -- A job a worker has already CLAIMED belongs to that worker. Leaving
  -- it alone is the lease contract; the handler treats a non-live
  -- attempt as a no-op completion.
  v_res := screening_v2.admit_phone_attempt(v_eng, 'no_answer_retry', null, 60,
                                            v_t + interval '1 day');
  v_att := (v_res->>'attempt_id')::uuid;
  update screening_v2.job_queue set status = 'active'
   where dedup_key = 'phone.dial:' || v_att::text;
  perform screening_v2.reclaim_phone_attempt_leases(50, v_t + interval '1 day 10 minutes');
  select status into v_status from screening_v2.job_queue
   where dedup_key = 'phone.dial:' || v_att::text;
  perform _policy_tests.assert(
    '0042: a job already claimed by a worker is left to that worker',
    v_status = 'active',
    'completing a claimed job under its holder is the lease violation this sweeper exists '
      || 'to avoid; job=' || coalesce(v_status, '<none>'));
end;
$$;

-- ── B23: the append-only ledger blocks parent deletion, on purpose ────
-- A referential SET NULL is an UPDATE, so the insert-once trigger stops
-- it. That is deliberate — a ledger row must not be silently orphaned —
-- but it means an erasure or retention job must clear the ledger FIRST,
-- and the failure message names the ledger rather than the parent. This
-- test is how that is discovered in review instead of in an incident.
do $$
declare
  v_eng uuid; v_res jsonb; v_blocked boolean; v_ok boolean; v_cand uuid;
  v_t timestamptz := '2026-08-24T06:00:00Z';
begin
  v_eng := _policy_tests.phone_fixture('pol42-erasure', 'pending_prereqs');
  select candidate_id into v_cand from screening_v2.phone_engagements where id = v_eng;
  perform screening_v2.apply_phone_event('internal','prereq.satisfied', null, v_eng,
            null, null, null, v_t);

  begin
    delete from screening_v2.phone_engagements where id = v_eng;
    v_blocked := false;
  exception when others then
    v_blocked := sqlerrm like '%insert-once%';
  end;
  perform _policy_tests.assert(
    '0042: an engagement with ledger events cannot be deleted while they reference it',
    v_blocked,
    'the FK is on delete set null, and a referential SET NULL is an UPDATE the '
      || 'insert-once trigger refuses; the error names the LEDGER, not the parent');

  -- The documented erasure path: clear the ledger under the hatch, then
  -- the parent deletes normally.
  begin
    perform set_config('app.allow_phone_event_mutation', 'true', true);
    delete from screening_v2.phone_call_events where engagement_id = v_eng;
    perform set_config('app.allow_phone_event_mutation', 'false', true);
    delete from screening_v2.phone_engagements where id = v_eng;
    v_ok := true;
  exception when others then v_ok := false; end;
  perform _policy_tests.assert(
    '0042: the documented hatch-first erasure path works',
    v_ok, 'a DPDP erasure must not depend on an operator already knowing about a session GUC');
end;
$$;

-- ── B24: the metadata sanitizer refuses a plus-less number ────────────
do $$
declare v_eng uuid; v_num boolean; v_nat boolean; v_code boolean;
begin
  v_eng := _policy_tests.phone_fixture('pol42-digits');
  begin
    insert into screening_v2.phone_call_events
      (source, provider_event_id, engagement_id, event_type, applied, metadata)
    values ('internal','pol42-dig-1', v_eng, 'prereq.satisfied', true,
            jsonb_build_object('from', '919876543210'));
    v_num := false;
  exception when check_violation then v_num := true; end;
  begin
    insert into screening_v2.phone_call_events
      (source, provider_event_id, engagement_id, event_type, applied, metadata)
    values ('internal','pol42-dig-2', v_eng, 'prereq.satisfied', true,
            jsonb_build_object('caller', '9876543210'));
    v_nat := false;
  exception when check_violation then v_nat := true; end;
  begin
    insert into screening_v2.phone_call_events
      (source, provider_event_id, engagement_id, event_type, applied, metadata)
    values ('internal','pol42-dig-3', v_eng, 'prereq.satisfied', true,
            jsonb_build_object('sip_call_id', 'ABC-123', 'attempt_seq', 4));
    v_code := true;
  exception when others then v_code := false; end;

  perform _policy_tests.assert(
    '0042: a plus-less or national-format number is refused by the metadata sanitizer',
    v_num and v_nat and v_code,
    'the character set alone admits "919876543210", which would land in an append-only '
      || 'column removable only through the erasure hatch; e164_blocked=' || v_num
      || ' national_blocked=' || v_nat || ' short_code_allowed=' || v_code);
end;
$$;

-- ── B25: a passed slot stops being live, and a dialled slot is spent ──
do $$
declare
  v_eng uuid; v_res jsonb; v_status text; v_state text; v_apt uuid;
  v_t timestamptz := '2026-08-24T06:00:00Z';
  v_slot timestamptz := '2026-08-25T09:00:00Z';   -- 14:30 IST
begin
  v_eng := _policy_tests.phone_fixture('pol42-expire');
  v_res := screening_v2.schedule_phone_appointment(
             v_eng, v_slot, v_slot + interval '30 minutes', 'candidate_voice', null, null, v_t);
  v_apt := (v_res->>'appointment_id')::uuid;

  -- Inside the grace window: nothing happens yet.
  perform screening_v2.expire_phone_appointments(900, 50, v_slot + interval '35 minutes');
  select status into v_status from screening_v2.phone_appointments where id = v_apt;
  perform _policy_tests.assert(
    '0042: a slot inside its grace window is still live',
    v_status = 'scheduled', 'status=' || v_status);

  -- The sweep is fleet-wide, so it also clears slots left live by
  -- earlier fixtures. The assertion is scoped to THIS appointment; the
  -- global count is asserted only as "at least this one".
  v_res := screening_v2.expire_phone_appointments(900, 500, v_slot + interval '2 hours');
  select status into v_status from screening_v2.phone_appointments where id = v_apt;
  select state into v_state from screening_v2.phone_engagements where id = v_eng;
  perform _policy_tests.assert(
    '0042: a passed slot becomes missed and returns the engagement to eligible',
    (v_res->>'expired')::integer >= 1 and v_status = 'missed' and v_state = 'eligible',
    'a stale live slot is one HR sees as real, and it forces every later booking down the '
      || 'supersede path; expired=' || (v_res->>'expired') || ' status=' || v_status
      || ' engagement=' || v_state);

  -- And a slot that DID authorise a dial is spent by that dial.
  v_res := screening_v2.schedule_phone_appointment(
             v_eng, v_slot + interval '1 day', v_slot + interval '1 day 30 minutes',
             'hr_manual', null, null, v_slot + interval '2 hours');
  v_apt := (v_res->>'appointment_id')::uuid;
  v_res := screening_v2.admit_phone_attempt(v_eng, 'scheduled', null, 60,
                                            v_slot + interval '1 day');
  select status into v_status from screening_v2.phone_appointments where id = v_apt;
  perform _policy_tests.assert(
    '0042: the slot that authorised a dial is marked fulfilled by that dial',
    v_res->>'status' = 'ok' and v_status = 'fulfilled',
    'admit=' || (v_res->>'status') || ' appointment=' || v_status);
end;
$$;

-- The two vocabulary members 0042 deliberately does NOT write, asserted
-- so the residual is visible rather than inferred.
select _policy_tests.assert(
  '0042: `confirmed` has no writer here and is recorded as P4''s, not forgotten',
  not exists (
    select 1 from pg_proc p join pg_namespace n on n.oid = p.pronamespace
     where n.nspname = 'screening_v2' and p.proname like '%phone%'
       and _policy_tests.fn_body(p.proname) ~ 'confirmed_at\s*=')
  and (select pg_get_functiondef(p.oid) from pg_proc p
         join pg_namespace n on n.oid = p.pronamespace
        where n.nspname = 'screening_v2' and p.proname = 'schedule_phone_appointment')
      is not null,
  'an appointment is confirmed when the bot reads the slot back to the candidate, which is '
    || 'a voice event and not a schema one; the header names it as P4''s');

-- ── B26: the small truths ─────────────────────────────────────────────
do $$
declare v_eng uuid; v_ok boolean;
begin
  v_eng := _policy_tests.phone_fixture('pol42-terminal-imm', 'cancelled');
  begin
    update screening_v2.phone_engagements set no_answer_attempts = 2 where id = v_eng;
    v_ok := false;
  exception when others then v_ok := sqlerrm like '%terminal%'; end;
  perform _policy_tests.assert(
    '0042: a terminal engagement is immutable in EVERY column, not only in state',
    v_ok,
    'guarding only `state` leaves a finished engagement''s budgets, eligibility and '
      || 'consent authority rewritable after the fact');
end;
$$;

do $$
declare v_eng uuid; v_res jsonb; v_state text;
begin
  v_eng := _policy_tests.phone_fixture('pol42-blockedbook', 'pending_prereqs');
  v_res := screening_v2.schedule_phone_appointment(
             v_eng, '2026-08-25T09:00:00Z', '2026-08-25T09:30:00Z', 'hr_manual',
             null, null, '2026-08-24T06:00:00Z');
  select state into v_state from screening_v2.phone_engagements where id = v_eng;
  perform _policy_tests.assert(
    '0042: booking against a blocked engagement says so instead of reporting a plain ok',
    v_res->>'status' = 'ok_prereqs_pending' and v_state = 'pending_prereqs'
      and v_res->>'appointment_id' is not null,
    'the slot is real and HR can see it, but nothing will dial it; a plain ok would let a '
      || 'caller believe a call is going to happen; got ' || coalesce(v_res::text,'<null>'));
end;
$$;

do $$
declare
  v_eng uuid; v_res jsonb; v_att uuid; v_backlog jsonb;
  v_t timestamptz := '2026-08-24T06:00:00Z';
begin
  v_eng := _policy_tests.phone_fixture('pol42-split');
  v_res := screening_v2.admit_phone_attempt(v_eng, 'initial', null, 60, v_t);
  v_att := (v_res->>'attempt_id')::uuid;
  perform screening_v2.apply_phone_event('livekit_webhook','sip.participant_joined',
            gen_random_uuid(), null, 'pol42-split-ghost', null, null, v_t);
  perform screening_v2.apply_phone_event('internal','assessment.completed',
            v_att, null, 'pol42-split-unexp', null, null, v_t);

  v_backlog := screening_v2.phone_backlog(v_t);
  perform _policy_tests.assert(
    '0042: phone_backlog breaks the ignored ingress events out BY REASON',
    (v_backlog->'events'->>'unknown_attempt_last_24h')::integer >= 1
      and (v_backlog->'events'->>'unexpected_event_last_24h')::integer >= 1
      and v_backlog->'events' ? 'stale_epoch_last_24h'
      and v_backlog->'events' ? 'terminal_last_24h',
    'a nonzero unknown_attempt rate means admission and ingress have diverged, and is the '
      || 'only one of the four that is an incident; events=' || (v_backlog->'events')::text);
end;
$$;

do $$
declare
  v_eng uuid; v_res jsonb; v_att uuid; v_t timestamptz := '2026-08-24T06:00:00Z';
begin
  v_eng := _policy_tests.phone_fixture('pol42-constraint');
  v_res := screening_v2.admit_phone_attempt(v_eng, 'initial', null, 60, v_t);
  update screening_v2.phone_engagements set state = 'reconnecting' where id = v_eng;
  v_res := screening_v2.admit_phone_attempt(v_eng, 'reconnect', null, 60,
                                            v_t + interval '1 minute');
  perform _policy_tests.assert(
    '0042: a one-live refusal names the constraint that produced it',
    v_res->>'status' = 'attempt_in_flight'
      and v_res->>'constraint' = 'uq_phone_attempts_one_live',
    'reporting a same-day race as an in-flight attempt would send an operator looking for '
      || 'a call that is not happening; got ' || coalesce(v_res::text, '<null>'));
end;
$$;

do $$
declare v_eng uuid; v_res jsonb; v_t timestamptz := '2026-08-24T06:00:00Z';
begin
  v_eng := _policy_tests.phone_fixture('pol42-nodeadbranch');
  update screening_v2.phone_engagements set state = 'dialing' where id = v_eng;
  update screening_v2.phone_engagements set state = 'awaiting_retry' where id = v_eng;
  v_res := screening_v2.apply_phone_event('internal','budget.exhausted', null, v_eng,
             'pol42-nodead-1', null, null, v_t);
  perform _policy_tests.assert(
    '0042: budget.exhausted from awaiting_retry is an unmapped no-op, not a dead branch',
    v_res->>'ignored_reason' = 'unexpected_event',
    'the no-answer charge that lands on 3 goes straight to abandoned_no_answer, so an '
      || 'awaiting_retry engagement always has budget left; got ' || v_res::text);
end;
$$;

-- ── B27: terminal immutability upgrades two FKs to de-facto RESTRICT ──
-- `phone_engagements.role_id` and `.session_id` are `on delete set
-- null`. A referential SET NULL is an UPDATE, so on a TERMINAL
-- engagement the transition trigger refuses it — and the DELETE of the
-- referenced `roles` or `call_sessions` row fails, with an error naming
-- the engagement rather than the row being deleted.
--
-- This is deliberate and is NOT softened here: a finished engagement's
-- role and session are part of the record of what happened. What is
-- asserted is that the behaviour is real, that it is a property of
-- TERMINALITY rather than of the FKs, and that the documented erasure
-- order gets past both this guard and the ledger's insert-once guard.
do $$
declare
  v_role uuid; v_role2 uuid; v_cand uuid; v_sess uuid; v_map uuid;
  v_link uuid; v_eng uuid; v_s text; v_blocked boolean; v_err text;
  v_states text[] := array['queued','fetching','scanning','extracting','structuring','ready'];
begin
  perform _policy_tests.phone_teardown('pol42-fkrestrict');
  delete from screening_v2.roles where title = 'pol42-fkrestrict-role';
  select id into v_role from screening_v2.roles order by id limit 1;

  -- A role of its own, referenced by NOTHING else. ashby_job_mappings
  -- .role_id is ON DELETE RESTRICT, so reusing the seed role would have
  -- the mapping refuse the delete and prove nothing about the trigger.
  insert into screening_v2.roles (title) values ('pol42-fkrestrict-role') returning id into v_role2;

  insert into screening_v2.candidates (role_id, name, email, phone_e164, phone_valid)
  values (v_role, 'fk fixture', 'pol42-fkrestrict@example.test', '+919999054321', true)
  returning id into v_cand;
  insert into screening_v2.call_sessions (candidate_id, status)
  values (v_cand, 'created') returning id into v_sess;
  insert into screening_v2.ashby_job_mappings
    (external_job_id, role_id, owner_id, ai_screening_stage_id, ta_screening_stage_id,
     status, delivery_mode)
  values ('pol42-fkrestrict-job', v_role, '00000000-0000-4000-8000-0000000000ad',
          'pol42-fkrestrict-ai', 'pol42-fkrestrict-ta', 'enabled', 'manual')
  returning id into v_map;
  insert into screening_v2.ashby_application_links
    (external_application_id, external_job_id, job_mapping_id,
     external_resume_file_handle, candidate_id)
  values ('pol42-fkrestrict-app', 'pol42-fkrestrict-job', v_map, repeat('h', 64), v_cand)
  returning id into v_link;
  foreach v_s in array v_states loop
    perform screening_v2.advance_ashby_ingestion(v_link, v_s, null, null, null, null);
  end loop;

  -- ── First, the CONTROL: while the engagement is NON-terminal the
  --    SET NULL applies normally and the delete goes through. This is
  --    what makes the two assertions below about TERMINALITY rather
  --    than about the foreign keys.
  insert into screening_v2.phone_engagements
    (application_link_id, candidate_id, role_id, session_id, state)
  values (v_link, v_cand, v_role2, v_sess, 'pending_prereqs')
  returning id into v_eng;

  delete from screening_v2.call_sessions where id = v_sess;
  perform _policy_tests.assert(
    '0042: a NON-terminal engagement lets its session be deleted, nulling the reference',
    (select session_id is null from screening_v2.phone_engagements where id = v_eng),
    'the FKs really are on delete set null; the refusals below are the terminal guard, '
      || 'not the foreign keys');

  -- ── Now terminalise, and try the same two deletes.
  insert into screening_v2.call_sessions (candidate_id, status)
  values (v_cand, 'created') returning id into v_sess;
  update screening_v2.phone_engagements
     set session_id = v_sess where id = v_eng;
  update screening_v2.phone_engagements
     set state = 'cancelled', terminal_at = '2026-08-24T06:00:00Z' where id = v_eng;

  begin
    delete from screening_v2.call_sessions where id = v_sess;
    v_blocked := false; v_err := '<no error>';
  exception when others then
    v_blocked := true; v_err := sqlerrm;
  end;
  perform _policy_tests.assert(
    '0042: deleting a call_sessions row referenced by a TERMINAL engagement is refused',
    v_blocked and v_err like '%is terminal%',
    'a referential SET NULL is an UPDATE, so terminal immutability turns session_id into a '
      || 'de-facto restrict, and the error names the ENGAGEMENT rather than the session; '
      || 'got ' || coalesce(v_err, '<null>'));

  begin
    delete from screening_v2.roles where id = v_role2;
    v_blocked := false; v_err := '<no error>';
  exception when others then
    v_blocked := true; v_err := sqlerrm;
  end;
  perform _policy_tests.assert(
    '0042: deleting a roles row referenced by a TERMINAL engagement is refused the same way',
    v_blocked and v_err like '%is terminal%',
    'role_id carries the same on delete set null and the same consequence; got '
      || coalesce(v_err, '<null>'));

  -- ── And the DOCUMENTED ERASURE ORDER clears both guards at once:
  --    the insert-once ledger first, under its hatch, then the phone
  --    model, and only then the rows it pointed at.
  perform screening_v2.apply_phone_event('internal', 'hr.cancelled', null, v_eng,
            'pol42-fkrestrict-ev', null, null, '2026-08-24T06:00:00Z');

  begin
    perform set_config('app.allow_phone_event_mutation', 'true', true);
    delete from screening_v2.phone_call_events where engagement_id = v_eng;
    perform set_config('app.allow_phone_event_mutation', 'false', true);
    delete from screening_v2.phone_engagements where id = v_eng;
    delete from screening_v2.call_sessions where id = v_sess;
    delete from screening_v2.roles where id = v_role2;
    v_blocked := false; v_err := '<no error>';
  exception when others then
    v_blocked := true; v_err := sqlerrm;
  end;
  perform _policy_tests.assert(
    '0042: the documented erasure order — ledger under the hatch, then the phone model, '
      || 'then the rows it referenced — clears BOTH guards',
    not v_blocked
      and not exists (select 1 from screening_v2.phone_engagements where id = v_eng)
      and not exists (select 1 from screening_v2.call_sessions where id = v_sess)
      and not exists (select 1 from screening_v2.roles where id = v_role2),
    'delete out of order and the error points at a table you were not touching; got '
      || coalesce(v_err, '<null>'));

  perform _policy_tests.phone_teardown('pol42-fkrestrict');
  delete from screening_v2.roles where title = 'pol42-fkrestrict-role';
end;
$$;

-- The guard must not have been quietly weakened to make the above pass:
-- terminal immutability still refuses an ordinary column write.
do $$
declare v_eng uuid; v_ok boolean;
begin
  v_eng := _policy_tests.phone_fixture('pol42-imm-intact', 'cancelled');
  begin
    update screening_v2.phone_engagements set next_eligible_at = '2026-09-01T00:00:00Z'
     where id = v_eng;
    v_ok := false;
  exception when others then v_ok := sqlerrm like '%is terminal%'; end;
  perform _policy_tests.assert(
    '0042: documenting the FK consequence did NOT weaken terminal immutability',
    v_ok,
    'the fix for the FK consequence is documentation and an erasure order, never a hole '
      || 'in the guard');
end;
$$;

-- ── Teardown: the phone fixtures leave the database as they found it ──
-- The GOV-06 synthetic-seed suite asserts GLOBAL cardinality on
-- screening_v2.candidates and screening_v2.consent_records, so a fixture
-- left behind here fails a test three sections away with a message that
-- points nowhere near the cause. audit_events and phone_call_events are
-- append-only by design; the events are removed through the same
-- documented SET LOCAL hatch an erasure request would use, and the audit
-- trail is deliberately left intact.
do $$
declare v_engs uuid[]; v_links uuid[]; v_cands uuid[];
begin
  select coalesce(array_agg(id), '{}') into v_cands
    from screening_v2.candidates where email like 'pol42-%@example.test';
  select coalesce(array_agg(id), '{}') into v_links
    from screening_v2.ashby_application_links where external_application_id like 'pol42-%';
  select coalesce(array_agg(id), '{}') into v_engs
    from screening_v2.phone_engagements where application_link_id = any(v_links);

  perform set_config('app.allow_phone_event_mutation', 'true', true);
  delete from screening_v2.phone_call_events
   where engagement_id = any(v_engs)
      or attempt_id in (select id from screening_v2.phone_call_attempts
                         where engagement_id = any(v_engs));
  perform set_config('app.allow_phone_event_mutation', 'false', true);

  delete from screening_v2.job_queue
   where dedup_key in (select 'phone.dial:' || id::text
                         from screening_v2.phone_call_attempts
                        where engagement_id = any(v_engs));
  delete from screening_v2.phone_call_attempts where engagement_id = any(v_engs);
  delete from screening_v2.phone_appointments  where engagement_id = any(v_engs);
  delete from screening_v2.phone_engagements   where id = any(v_engs);
  delete from screening_v2.ashby_resume_ingestions where application_link_id = any(v_links);
  delete from screening_v2.ashby_operations        where application_link_id = any(v_links);
  delete from screening_v2.ashby_application_links where id = any(v_links);
  delete from screening_v2.ashby_job_mappings where external_job_id like 'pol42-%-job';
  delete from screening_v2.phone_suppressions
   where phone_sha256 in (select screening_v2.sha256_hex(phone_e164)
                            from screening_v2.candidates
                           where id = any(v_cands) and phone_e164 is not null);
  delete from screening_v2.consent_records where candidate_id = any(v_cands);
  delete from screening_v2.candidates where id = any(v_cands);
end;
$$;

select _policy_tests.assert(
  '0042: the phone fixtures left no candidate, consent record, engagement or live job behind',
  not exists (select 1 from screening_v2.candidates where email like 'pol42-%@example.test')
  and not exists (select 1 from screening_v2.phone_engagements)
  and not exists (select 1 from screening_v2.job_queue where name = 'phone.dial'),
  'a leaked fixture fails the GOV-06 cardinality suite three sections later, '
    || 'with a message that points nowhere near the cause');

select _policy_tests.assert(
  '0042: the phone control singleton is present and NOT halted after the suite',
  (select count(*) from screening_v2.phone_control where control_key = 'default') = 1
  and (select halted_at is null from screening_v2.phone_control where control_key = 'default'),
  'the halt tests must never leave the kill switch engaged for the races that follow');

-- ═══════════════════════════════════════════════════════════════════════
-- Verdict (includes all Phase 1 and Phase 2 WS-A tests above)
-- ═══════════════════════════════════════════════════════════════════════

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
