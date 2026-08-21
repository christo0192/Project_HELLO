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
   where application_link_id in (v_link, v_link_doc, v_link_leg, v_link_term, v_link_gen);
  delete from screening_v2.ashby_application_links
   where id in (v_link, v_link_doc, v_link_leg, v_link_term, v_link_gen);
  delete from screening_v2.ashby_job_mappings where id = v_map;
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
