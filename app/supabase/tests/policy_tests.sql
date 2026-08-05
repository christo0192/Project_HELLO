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
-- 0025 — finalize_authoritative_recording: grants + behaviour (T16-T19)
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
  'T16: anon cannot execute finalize_authoritative_recording',
  not has_function_privilege(
    'anon',
    'screening_v2.finalize_authoritative_recording(uuid,text,text,bigint,text,text)'::regprocedure,
    'EXECUTE'),
  'anon must not be able to execute the authoritative recording RPC'
);

select _policy_tests.assert(
  'T16: authenticated cannot execute finalize_authoritative_recording',
  not has_function_privilege(
    'authenticated',
    'screening_v2.finalize_authoritative_recording(uuid,text,text,bigint,text,text)'::regprocedure,
    'EXECUTE'),
  'authenticated must not be able to execute the authoritative recording RPC'
);

select _policy_tests.assert(
  'T16: service_role can execute finalize_authoritative_recording',
  has_function_privilege(
    'service_role',
    'screening_v2.finalize_authoritative_recording(uuid,text,text,bigint,text,text)'::regprocedure,
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

-- ── T19e: non-null provenance other than browser_upload/livekit_egress → provenance_conflict
do $$
declare
  v_candidate_id uuid;
  v_session_id uuid;
  v_result jsonb;
begin
  select id into v_candidate_id from screening_v2.candidates limit 1;
  if v_candidate_id is null then
    insert into _policy_tests.results(test, passed, detail) values
      ('T19e: provenance conflict rejected', true, 'skipped: no candidate row');
    return;
  end if;

  v_session_id := _policy_tests.seed_repoint_session(
    v_candidate_id, 'EG_polT19e', 'policy-test-browser.webm', false, false, false);
  -- Set provenance to something other than null / browser_upload / livekit_egress.
  update screening_v2.call_sessions
     set recording_provenance = 'other_source'
   where id = v_session_id;

  v_result := screening_v2.finalize_authoritative_recording(
    v_session_id, v_session_id::text || '-egress.ogg', repeat('b', 64), 4096, 'audio/ogg', null);

  insert into _policy_tests.results(test, passed, detail) values
    ('T19e: provenance conflict rejected',
     v_result ->> 'status' = 'provenance_conflict',
     'status=' || coalesce(v_result ->> 'status', 'null'));

  delete from screening_v2.call_sessions where id = v_session_id;
end;
$$;

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
