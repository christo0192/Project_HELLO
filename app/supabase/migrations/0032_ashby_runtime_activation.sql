-- =====================================================================
-- 0032 — Ashby runtime activation: durable writeback_pending terminus,
--        audited/bounded operation retry, terminal-resurrection backstop,
--        bounded ingestion requeue, and reconciliation single-flight.
--
-- Forward-only and additive (C-1): guarded ALTER ... ADD COLUMN IF NOT
-- EXISTS, guarded CHECK-constraint evolution (the sanctioned replaceable
-- data-guard pattern already used by 0029/0031), CREATE OR REPLACE
-- functions, and a guarded drop+recreate of one trigger. No table is
-- dropped, no column is dropped or retyped, no data is deleted.
--
-- Security posture (mirrors 0029/0030/0031): every SECURITY DEFINER RPC
-- pins search_path, is revoked from public/anon/authenticated, and is
-- granted to service_role only. No table gains a browser-role grant or
-- policy. All audit metadata is opaque ids + sanitized codes — never PII,
-- tokens, presigned URLs, raw bodies, transcripts, or recordings.
--
-- WHY THIS MIGRATION EXISTS (activation-exposed findings):
--   F-1 (S1) Terminal-link retry resurrection. trg_ashby_operation_not_
--       terminal was INSERT-only and cancel_ashby_application deliberately
--       leaves already-`failed` operations alone, so a Mission Control
--       retry could return a failed op to `pending` on a withdrawn
--       application — and once a runtime exists, a worker would execute it.
--       Closed by retry_ashby_operation (terminal + attempt guards), by
--       excluding terminal links from claim_ashby_operation, and by a
--       BEFORE UPDATE trigger backstop.
--   F-2 (S3) Unaudited, uncapped retry. The prior Mission Control retry was
--       a direct table UPDATE that discarded the actor and ignored
--       max_attempts. Closed by the audited, bounded RPC.
--   F-3 (S2) Ingestion requeue had no ceiling: advance_ashby_ingestion
--       incremented attempts on every `queued` transition with nothing
--       reading a cap, so a flapping fetch could requeue forever once a
--       runtime existed. Closed by a bounded requeue that refuses at the
--       cap and leaves the row in failed_review for human review.
--   F-4 (S2) Reconciliation had no single-flight guard and could not signal
--       lack of progress. Closed by a leased begin/end run pair plus a
--       no_progress_runs counter that advance resets.
--
-- The `writeback_pending` lifecycle value is the durable, honest resting
-- state for an application whose screening completed but whose result
-- CANNOT be published because no approved Ashby result sink exists (no
-- tenant-verified feedback-form binding). It is a terminus, not a queue:
-- nothing in the runtime claims or executes scorecard_write or stage_move.
-- =====================================================================

-- ═══════════════════════════════════════════════════════════════════════
-- 1. ashby_application_links.lifecycle — additive CHECK evolution
-- ═══════════════════════════════════════════════════════════════════════
-- Adds 'writeback_pending'. Existing values are unchanged and every
-- previously-valid row remains valid, so the constraint validates without
-- a rewrite. Same drop-if-exists / add NOT VALID / validate idiom 0031
-- used for chk_audit_action.

alter table screening_v2.ashby_application_links
  drop constraint if exists chk_ashby_application_links_lifecycle;
alter table screening_v2.ashby_application_links
  add constraint chk_ashby_application_links_lifecycle check (
    lifecycle in ('imported','processing','ready','completed','writeback_pending','cancelled')
  )
  not valid;
alter table screening_v2.ashby_application_links
  validate constraint chk_ashby_application_links_lifecycle;

comment on constraint chk_ashby_application_links_lifecycle
  on screening_v2.ashby_application_links is
  'Application lifecycle allowlist, extended additively by 0032 with '
  '"writeback_pending": screening completed but the result cannot be '
  'published because no tenant-verified Ashby result sink exists. It is a '
  'terminus — no scorecard write and no stage move follow from it.';

-- ═══════════════════════════════════════════════════════════════════════
-- 2. audit_events action allowlist — additive CHECK evolution
-- ═══════════════════════════════════════════════════════════════════════

alter table screening_v2.audit_events
  drop constraint if exists chk_audit_action;
alter table screening_v2.audit_events
  add constraint chk_audit_action check (
    action in (
      'invite_sent', 'invite_revoked', 'invite_consumed',
      'grant_issued', 'grant_revoked', 'grant_consumed',
      'screening_started', 'screening_completed', 'screening_failed',
      'assessment_recorded',
      'candidate_status_changed', 'candidate_consent_updated',
      'session_created', 'session_updated', 'session_terminated',
      'membership_created', 'membership_updated', 'membership_deactivated',
      'role_created', 'role_updated', 'role_deactivated',
      'export_requested', 'export_completed',
      'login_success', 'login_failure', 'logout',
      'config_changed',
      'auth_login_success', 'auth_login_failure', 'auth_token_refresh', 'auth_logout',
      'rbac_access_denied', 'rbac_ownership_denied',
      'resource_create', 'resource_read', 'resource_update',
      'resource_delete', 'resource_list', 'rate_limit_exceeded',
      'audit_sink_failure', 'audit_configuration_error',
      'recording_download', 'recording_upload', 'recording_integrity_verified',
      'recording_quarantined', 'recording_revoked', 'recording_deleted',
      'admin_session_override', 'admin_maintenance_toggle', 'admin_member_update',
      'quota_override', 'notification_create', 'appeal_create', 'appeal_review',
      'allowlist_linked', 'admin_allowlist_add', 'admin_allowlist_update',
      -- Ashby Wave 2 (0029): mapping-administration audits.
      'ashby_mapping_update', 'ashby_mapping_drift',
      -- Ashby Wave 2 (0031, additive): workflow-execution audits.
      'ashby_application_cancel', 'ashby_operation_enqueue', 'ashby_operation_update',
      -- Ashby Wave 2 (0032, additive): runtime-activation audits.
      'ashby_operation_retry', 'ashby_writeback_pending'
    )
  )
  not valid;
alter table screening_v2.audit_events
  validate constraint chk_audit_action;

comment on constraint chk_audit_action on screening_v2.audit_events is
  'Audit action allowlist — extended additively by 0032 with the Ashby '
  'runtime-activation audits (ashby_operation_retry, ashby_writeback_pending). '
  'Metadata carries only opaque ids/codes — never PII.';

-- ═══════════════════════════════════════════════════════════════════════
-- 3. ashby_sync_checkpoints — single-flight lease + progress counter
-- ═══════════════════════════════════════════════════════════════════════
-- The lock is the LEASE, deliberately not the `status` column: `status`
-- keeps its existing meaning ('idle' | 'full_resync_required') so the
-- forced-full-resync signal survives a concurrent run attempt untouched.

alter table screening_v2.ashby_sync_checkpoints
  add column if not exists lease_owner      text,
  add column if not exists lease_expires_at timestamptz,
  add column if not exists no_progress_runs integer not null default 0;

do $$
begin
  if not exists (
    select 1 from pg_constraint
     where conname = 'chk_ashby_sync_checkpoints_lease_owner'
       and conrelid = 'screening_v2.ashby_sync_checkpoints'::regclass
  ) then
    alter table screening_v2.ashby_sync_checkpoints
      add constraint chk_ashby_sync_checkpoints_lease_owner
        check (lease_owner is null or length(lease_owner) between 1 and 128);
  end if;
  if not exists (
    select 1 from pg_constraint
     where conname = 'chk_ashby_sync_checkpoints_no_progress'
       and conrelid = 'screening_v2.ashby_sync_checkpoints'::regclass
  ) then
    alter table screening_v2.ashby_sync_checkpoints
      add constraint chk_ashby_sync_checkpoints_no_progress
        check (no_progress_runs >= 0);
  end if;
end;
$$;

comment on column screening_v2.ashby_sync_checkpoints.lease_owner is
  'Opaque owner of the current single-flight reconciliation lease. Never a secret.';
comment on column screening_v2.ashby_sync_checkpoints.no_progress_runs is
  'Consecutive reconciliation runs that ended WITHOUT advancing the cursor '
  '(page_cap/item_cap/deadline/failure). Reset to 0 on every advance. An '
  'operator alert threshold — a silent non-advancing loop is a liveness bug.';

-- ═══════════════════════════════════════════════════════════════════════
-- 4. Terminal-resurrection backstop — BEFORE UPDATE on ashby_operations
-- ═══════════════════════════════════════════════════════════════════════
-- The 0029 trigger guards INSERT only. This guards the UPDATE path: an
-- operation belonging to a TERMINAL application link may never (re-)enter
-- a runnable state. Recording an outcome for work already in flight when
-- the cancel landed stays legal — 'succeeded', 'failed' and 'cancelled'
-- are all permitted, so cancel_ashby_application (which marks the link
-- terminal FIRST and then cancels in-flight operations) is unaffected.

create or replace function screening_v2.enforce_ashby_operation_not_terminal_update()
returns trigger
language plpgsql
security invoker
set search_path = pg_catalog
as $$
declare
  v_terminal text;
begin
  -- Only a transition INTO a runnable state can resurrect work.
  if new.state is not distinct from old.state then
    return new;
  end if;
  if new.state not in ('pending','running') then
    return new;
  end if;
  select terminal_state into v_terminal
    from screening_v2.ashby_application_links
   where id = new.application_link_id;
  if v_terminal is not null then
    raise exception 'cannot resurrect ashby operation on terminal application link (%)', v_terminal
      using errcode = 'P0001';
  end if;
  return new;
end;
$$;

drop trigger if exists trg_ashby_operation_not_terminal_update
  on screening_v2.ashby_operations;
create trigger trg_ashby_operation_not_terminal_update
  before update on screening_v2.ashby_operations
  for each row
  execute function screening_v2.enforce_ashby_operation_not_terminal_update();

comment on function screening_v2.enforce_ashby_operation_not_terminal_update is
  'Blocks any UPDATE that moves an ashby_operations row INTO pending/running '
  'while its application link is terminal (withdrawn/deleted/manual_stage_'
  'cancel). Recording a terminal outcome (succeeded/failed/cancelled) for '
  'already-claimed work remains legal, so atomic terminal cancellation is '
  'unaffected. DB backstop for the retry-resurrection path.';

-- ═══════════════════════════════════════════════════════════════════════
-- 5. claim_ashby_operation — never claim work on a terminal link
-- ═══════════════════════════════════════════════════════════════════════
-- Same signature as 0031 (text, text, integer, timestamptz). The added
-- predicate makes the terminal guard a silent no-match rather than a
-- trigger exception, so a worker sees an ordinary empty claim.

create or replace function screening_v2.claim_ashby_operation(
  p_operation_type text,
  p_owner          text,
  p_lease_seconds  integer,
  p_now            timestamptz default now()
)
returns jsonb
language plpgsql
security definer
set search_path = pg_catalog, screening_v2
as $$
declare
  v_op    screening_v2.ashby_operations%rowtype;
  v_lease integer := least(greatest(coalesce(p_lease_seconds, 30), 1), 900);
  v_token uuid := gen_random_uuid();
begin
  if p_operation_type is not null
     and p_operation_type not in ('invite_delivery','scorecard_write','stage_move') then
    return jsonb_build_object('status', 'invalid_operation_type');
  end if;

  select o.* into v_op
    from screening_v2.ashby_operations o
    join screening_v2.ashby_application_links l on l.id = o.application_link_id
   where o.provider = 'ashby'
     and o.state = 'pending'
     and o.scheduled_at <= p_now
     and l.terminal_state is null
     and (p_operation_type is null or o.operation_type = p_operation_type)
     and (o.lease_expires_at is null or o.lease_expires_at <= p_now)
     and (
       o.depends_on_operation_id is null
       or exists (
         select 1 from screening_v2.ashby_operations d
          where d.id = o.depends_on_operation_id and d.state = 'succeeded'
       )
     )
   order by o.scheduled_at, o.id
   for update of o skip locked
   limit 1;

  if not found then
    return jsonb_build_object('status', 'empty');
  end if;

  update screening_v2.ashby_operations
     set state = 'running',
         attempts = attempts + 1,
         lease_token = v_token,
         lease_owner = left(coalesce(p_owner, 'worker'), 128),
         lease_expires_at = p_now + make_interval(secs => v_lease),
         updated_at = p_now
   where id = v_op.id;

  return jsonb_build_object(
    'status', 'claimed',
    'id', v_op.id,
    'operation_type', v_op.operation_type,
    'application_link_id', v_op.application_link_id,
    'lease_token', v_token,
    'attempts', v_op.attempts + 1,
    'max_attempts', v_op.max_attempts,
    'marker', v_op.marker
  );
end;
$$;

revoke all on function screening_v2.claim_ashby_operation(text, text, integer, timestamptz)
  from public, anon, authenticated;
grant execute on function screening_v2.claim_ashby_operation(text, text, integer, timestamptz)
  to service_role;

comment on function screening_v2.claim_ashby_operation is
  'Leased claim (FOR UPDATE SKIP LOCKED) of the next runnable pending Ashby '
  'operation. 0032: operations whose application link is TERMINAL are never '
  'claimed. Honours the scorecard-before-stage dependency gate. Service-role-only.';

-- ═══════════════════════════════════════════════════════════════════════
-- 6. advance_ashby_ingestion — bounded requeue ceiling
-- ═══════════════════════════════════════════════════════════════════════
-- Identical signature and behaviour to 0031 except: a `queued` requeue that
-- would exceed the attempt ceiling is REFUSED (status 'retry_exhausted')
-- and the row is left in failed_review for human review. Note the 0029
-- transition trigger permits failed_review -> queued but NOT queued ->
-- failed_review, so the cap is enforced by refusing the transition rather
-- than by forcing a new one.

create or replace function screening_v2.advance_ashby_ingestion(
  p_application_link_id uuid,
  p_next_state          text,
  p_content_sha256      text,
  p_extractor_version   text,
  p_structurer_version  text,
  p_failed_reason       text,
  p_now                 timestamptz default now()
)
returns jsonb
language plpgsql
security definer
set search_path = pg_catalog, screening_v2
as $$
declare
  v_id       uuid;
  v_attempts integer;
  v_state    text;
  -- Bounded requeue ceiling (0032). A flapping fetch/scan/parse can no longer
  -- requeue forever; at the cap the row rests in failed_review.
  v_max_attempts constant integer := 5;
begin
  if p_next_state not in ('queued','fetching','scanning','extracting','structuring','ready','failed_review','cancelled') then
    return jsonb_build_object('status', 'invalid_state');
  end if;
  if p_content_sha256 is not null and p_content_sha256 !~ '^[a-f0-9]{64}$' then
    return jsonb_build_object('status', 'invalid_sha');
  end if;

  -- Ensure the ingestion row exists (created at import; created here if absent).
  insert into screening_v2.ashby_resume_ingestions (application_link_id, provider, state)
  values (p_application_link_id, 'ashby', 'queued')
  on conflict (application_link_id) do nothing;

  -- Enforce the requeue ceiling BEFORE attempting the transition.
  if p_next_state = 'queued' then
    select attempts, state into v_attempts, v_state
      from screening_v2.ashby_resume_ingestions
     where application_link_id = p_application_link_id
     for update;
    if v_attempts is null then
      return jsonb_build_object('status', 'not_found');
    end if;
    -- A same-state no-op requeue must not consume an attempt.
    if v_state is distinct from 'queued' and v_attempts + 1 > v_max_attempts then
      return jsonb_build_object('status', 'retry_exhausted',
                                'state', v_state,
                                'attempts', v_attempts,
                                'max_attempts', v_max_attempts);
    end if;
  end if;

  begin
    update screening_v2.ashby_resume_ingestions
       set state = p_next_state,
           content_sha256 = coalesce(p_content_sha256, content_sha256),
           extractor_version = coalesce(p_extractor_version, extractor_version),
           structurer_version = coalesce(p_structurer_version, structurer_version),
           failed_reason = case when p_next_state = 'failed_review'
                                then left(coalesce(p_failed_reason, 'failed'), 200) else failed_reason end,
           attempts = case when p_next_state = 'queued' and state is distinct from 'queued'
                           then attempts + 1 else attempts end,
           updated_at = p_now
     where application_link_id = p_application_link_id
    returning id, attempts into v_id, v_attempts;
  exception
    when raise_exception then
      -- The 0029 transition trigger raised: illegal state move.
      return jsonb_build_object('status', 'invalid_transition');
  end;

  if v_id is null then
    return jsonb_build_object('status', 'not_found');
  end if;
  return jsonb_build_object('status', 'ok', 'state', p_next_state,
                            'attempts', v_attempts, 'max_attempts', v_max_attempts);
end;
$$;

revoke all on function screening_v2.advance_ashby_ingestion(uuid, text, text, text, text, text, timestamptz)
  from public, anon, authenticated;
grant execute on function screening_v2.advance_ashby_ingestion(uuid, text, text, text, text, text, timestamptz)
  to service_role;

comment on function screening_v2.advance_ashby_ingestion is
  'Restart-safe ingestion state transition with hash/version provenance. '
  '0032: a requeue past the bounded attempt ceiling (5) is refused with '
  'retry_exhausted and the row rests in failed_review — no unbounded '
  'requeue loop. Service-role-only.';

-- ═══════════════════════════════════════════════════════════════════════
-- 7. mark_ashby_writeback_pending — audited, idempotent, terminal-safe
-- ═══════════════════════════════════════════════════════════════════════
-- The ONLY completion transition the runtime performs. It parks the
-- application and enqueues NOTHING: no scorecard_write, no stage_move, no
-- provider mutation, no auto-reject.

create or replace function screening_v2.mark_ashby_writeback_pending(
  p_application_link_id uuid,
  p_reason              text,
  p_actor_id            uuid,
  p_now                 timestamptz default now()
)
returns jsonb
language plpgsql
security definer
set search_path = pg_catalog, screening_v2
as $$
declare
  v_link   screening_v2.ashby_application_links%rowtype;
  v_reason text := left(coalesce(p_reason, 'no_verified_result_sink'), 200);
begin
  select * into v_link
    from screening_v2.ashby_application_links
   where id = p_application_link_id
   for update;
  if not found then
    return jsonb_build_object('status', 'not_found');
  end if;

  -- A terminal application is never revived into a pending-publication state.
  if v_link.terminal_state is not null then
    return jsonb_build_object('status', 'blocked_terminal',
                              'terminal_state', v_link.terminal_state);
  end if;

  -- Idempotent: a second call changes nothing and writes no duplicate audit.
  if v_link.lifecycle = 'writeback_pending' then
    return jsonb_build_object('status', 'already_pending', 'lifecycle', 'writeback_pending');
  end if;

  update screening_v2.ashby_application_links
     set lifecycle = 'writeback_pending',
         updated_at = p_now
   where id = p_application_link_id;

  insert into screening_v2.audit_events
    (actor_id, actor_type, action, target_type, target_id, result, metadata)
  values
    (coalesce(p_actor_id, '00000000-0000-4000-8000-000000000001'),
     'system',
     'ashby_writeback_pending', 'ashby_application_link', p_application_link_id::text, 'success',
     jsonb_build_object('application_link_id', p_application_link_id,
                        'reason', v_reason,
                        'published', false));

  return jsonb_build_object('status', 'ok', 'lifecycle', 'writeback_pending');
end;
$$;

revoke all on function screening_v2.mark_ashby_writeback_pending(uuid, text, uuid, timestamptz)
  from public, anon, authenticated;
grant execute on function screening_v2.mark_ashby_writeback_pending(uuid, text, uuid, timestamptz)
  to service_role;

comment on function screening_v2.mark_ashby_writeback_pending is
  'Parks a completed Ashby application as writeback_pending because no '
  'tenant-verified result sink exists. Idempotent, audited, refuses on a '
  'terminal link, and enqueues NO operation — no scorecard write, no stage '
  'move, no auto-reject. Service-role-only.';

-- ═══════════════════════════════════════════════════════════════════════
-- 8. retry_ashby_operation — audited, attempt-bounded, terminal-safe
-- ═══════════════════════════════════════════════════════════════════════
-- Replaces the prior unaudited direct-UPDATE Mission Control retry.

create or replace function screening_v2.retry_ashby_operation(
  p_operation_id uuid,
  p_actor_id     uuid,
  p_now          timestamptz default now()
)
returns jsonb
language plpgsql
security definer
set search_path = pg_catalog, screening_v2
as $$
declare
  v_op       screening_v2.ashby_operations%rowtype;
  v_terminal text;
begin
  select * into v_op
    from screening_v2.ashby_operations
   where id = p_operation_id and provider = 'ashby'
   for update;
  if not found then
    return jsonb_build_object('status', 'not_found');
  end if;

  select terminal_state into v_terminal
    from screening_v2.ashby_application_links
   where id = v_op.application_link_id;
  if v_terminal is not null then
    -- Resurrection guard: a withdrawn/deleted/cancelled application never
    -- gets its failed work re-run.
    return jsonb_build_object('status', 'blocked_terminal', 'terminal_state', v_terminal);
  end if;

  if v_op.state <> 'failed' then
    return jsonb_build_object('status', 'not_retryable', 'state', v_op.state);
  end if;

  -- Bounded: retry never drives attempts past the operation's own ceiling.
  if v_op.attempts >= v_op.max_attempts then
    return jsonb_build_object('status', 'retry_exhausted',
                              'attempts', v_op.attempts,
                              'max_attempts', v_op.max_attempts);
  end if;

  update screening_v2.ashby_operations
     set state = 'pending',
         scheduled_at = p_now,
         error_code = null,
         error_detail = null,
         lease_token = null,
         lease_owner = null,
         lease_expires_at = null,
         updated_at = p_now
   where id = p_operation_id;

  insert into screening_v2.audit_events
    (actor_id, actor_type, action, target_type, target_id, result, metadata)
  values
    (coalesce(p_actor_id, '00000000-0000-4000-8000-000000000001'),
     -- 'recruiter' is the actor_type the 0007 CHECK allows for a human operator
     -- ('admin' is not a member of that set); the ADMIN identity is carried by
     -- actor_id, which is what makes the retry attributable.
     'recruiter',
     'ashby_operation_retry', 'ashby_operation', p_operation_id::text, 'success',
     jsonb_build_object('operation_id', p_operation_id,
                        'application_link_id', v_op.application_link_id,
                        'operation_type', v_op.operation_type,
                        'attempts', v_op.attempts,
                        'max_attempts', v_op.max_attempts));

  return jsonb_build_object('status', 'ok',
                            'attempts', v_op.attempts,
                            'max_attempts', v_op.max_attempts);
end;
$$;

revoke all on function screening_v2.retry_ashby_operation(uuid, uuid, timestamptz)
  from public, anon, authenticated;
grant execute on function screening_v2.retry_ashby_operation(uuid, uuid, timestamptz)
  to service_role;

comment on function screening_v2.retry_ashby_operation is
  'Audited, attempt-bounded retry of a FAILED Ashby operation. Refuses when '
  'the application link is terminal (blocked_terminal), when the operation is '
  'not failed (not_retryable), or when attempts have reached max_attempts '
  '(retry_exhausted). Records the acting admin. Service-role-only.';

-- ═══════════════════════════════════════════════════════════════════════
-- 9. Reconciliation single-flight lease + no-progress counter
-- ═══════════════════════════════════════════════════════════════════════

create or replace function screening_v2.begin_ashby_sync_run(
  p_checkpoint_key text,
  p_owner          text,
  p_lease_seconds  integer,
  p_now            timestamptz default now()
)
returns jsonb
language plpgsql
security definer
set search_path = pg_catalog, screening_v2
as $$
declare
  v_row   screening_v2.ashby_sync_checkpoints%rowtype;
  v_lease integer := least(greatest(coalesce(p_lease_seconds, 300), 1), 3600);
  v_owner text := left(coalesce(p_owner, 'scheduler'), 128);
begin
  if p_checkpoint_key is null or length(p_checkpoint_key) < 1 or length(p_checkpoint_key) > 128 then
    return jsonb_build_object('status', 'invalid_checkpoint_key');
  end if;

  -- Create the row on first use so the very first run is also single-flight.
  insert into screening_v2.ashby_sync_checkpoints (provider, checkpoint_key, status)
  values ('ashby', p_checkpoint_key, 'idle')
  on conflict (provider, checkpoint_key) do nothing;

  select * into v_row
    from screening_v2.ashby_sync_checkpoints
   where provider = 'ashby' and checkpoint_key = p_checkpoint_key
   for update;

  if v_row.lease_expires_at is not null and v_row.lease_expires_at > p_now then
    return jsonb_build_object('status', 'locked');
  end if;

  update screening_v2.ashby_sync_checkpoints
     set lease_owner = v_owner,
         lease_expires_at = p_now + make_interval(secs => v_lease),
         updated_at = p_now
   where provider = 'ashby' and checkpoint_key = p_checkpoint_key;

  -- `status` intentionally keeps its own meaning (idle | full_resync_required)
  -- so a pending forced resync survives the lease acquisition untouched.
  return jsonb_build_object(
    'status', 'ok',
    'lease_owner', v_owner,
    'sync_token', v_row.sync_token,
    'checkpoint_status', v_row.status,
    'token_issued_at', v_row.token_issued_at,
    'last_success_at', v_row.last_success_at,
    'no_progress_runs', v_row.no_progress_runs
  );
end;
$$;

revoke all on function screening_v2.begin_ashby_sync_run(text, text, integer, timestamptz)
  from public, anon, authenticated;
grant execute on function screening_v2.begin_ashby_sync_run(text, text, integer, timestamptz)
  to service_role;

comment on function screening_v2.begin_ashby_sync_run is
  'Single-flight lease acquisition for one reconciliation stream. Returns '
  'locked when a live lease is held, so two schedulers (or an overlapping '
  'slow run) can never both page and both advance the cursor. Returns the '
  'opaque cursor state for the caller''s sync-mode decision. Service-role-only.';

create or replace function screening_v2.end_ashby_sync_run(
  p_checkpoint_key text,
  p_owner          text,
  p_advanced       boolean,
  p_now            timestamptz default now()
)
returns jsonb
language plpgsql
security definer
set search_path = pg_catalog, screening_v2
as $$
declare
  v_row   screening_v2.ashby_sync_checkpoints%rowtype;
  v_owner text := left(coalesce(p_owner, 'scheduler'), 128);
  v_next  integer;
begin
  select * into v_row
    from screening_v2.ashby_sync_checkpoints
   where provider = 'ashby' and checkpoint_key = p_checkpoint_key
   for update;
  if not found then
    return jsonb_build_object('status', 'not_found');
  end if;

  -- Compare-and-set on the live lease owner: a stale runner cannot release
  -- (or corrupt the progress counter of) a lease another runner now holds.
  if v_row.lease_owner is distinct from v_owner then
    return jsonb_build_object('status', 'not_owned');
  end if;

  -- advance_ashby_sync_checkpoint already zeroed the counter on success; a
  -- non-advancing run increments it so a silent no-progress loop is visible.
  v_next := case when coalesce(p_advanced, false) then 0 else v_row.no_progress_runs + 1 end;

  update screening_v2.ashby_sync_checkpoints
     set lease_owner = null,
         lease_expires_at = null,
         no_progress_runs = v_next,
         updated_at = p_now
   where provider = 'ashby' and checkpoint_key = p_checkpoint_key;

  return jsonb_build_object('status', 'ok', 'no_progress_runs', v_next);
end;
$$;

revoke all on function screening_v2.end_ashby_sync_run(text, text, boolean, timestamptz)
  from public, anon, authenticated;
grant execute on function screening_v2.end_ashby_sync_run(text, text, boolean, timestamptz)
  to service_role;

comment on function screening_v2.end_ashby_sync_run is
  'Releases a reconciliation single-flight lease under a compare-and-set on '
  'the owner. A run that did NOT advance the cursor increments '
  'no_progress_runs so a stuck stream (e.g. a full resync permanently larger '
  'than item_cap) becomes observable instead of silently replaying. '
  'Service-role-only.';

-- advance_ashby_sync_checkpoint: same signature/semantics as 0030, plus it
-- clears the single-flight lease and resets the no-progress counter.
create or replace function screening_v2.advance_ashby_sync_checkpoint(
  p_checkpoint_key text,
  p_sync_token     text,
  p_pages          integer,
  p_items          integer,
  p_full           boolean default false,
  p_now            timestamptz default now()
)
returns jsonb
language plpgsql
security definer
set search_path = pg_catalog, screening_v2
as $$
declare
  v_id uuid;
begin
  if p_checkpoint_key is null or length(p_checkpoint_key) < 1 or length(p_checkpoint_key) > 128 then
    return jsonb_build_object('status', 'invalid_checkpoint_key');
  end if;
  if p_sync_token is not null and (length(p_sync_token) < 1 or length(p_sync_token) > 4096) then
    return jsonb_build_object('status', 'invalid_sync_token');
  end if;

  insert into screening_v2.ashby_sync_checkpoints
    (provider, checkpoint_key, sync_token, status, token_issued_at,
     last_success_at, last_full_sync_at, pages_last_run, items_last_run,
     full_resync_reason, no_progress_runs, updated_at)
  values
    ('ashby', p_checkpoint_key, p_sync_token, 'idle',
     case when p_sync_token is null then null else p_now end,
     p_now,
     case when p_full then p_now else null end,
     greatest(0, coalesce(p_pages, 0)), greatest(0, coalesce(p_items, 0)),
     null, 0, p_now)
  on conflict (provider, checkpoint_key) do update set
     sync_token         = excluded.sync_token,
     status             = 'idle',
     token_issued_at    = case when excluded.sync_token is null then null else p_now end,
     last_success_at    = p_now,
     last_full_sync_at  = case when p_full then p_now
                               else screening_v2.ashby_sync_checkpoints.last_full_sync_at end,
     pages_last_run     = greatest(0, coalesce(p_pages, 0)),
     items_last_run     = greatest(0, coalesce(p_items, 0)),
     full_resync_reason = null,
     no_progress_runs   = 0,
     updated_at         = p_now
  returning id into v_id;

  return jsonb_build_object('status', 'ok', 'id', v_id);
end;
$$;

revoke all on function screening_v2.advance_ashby_sync_checkpoint(text, text, integer, integer, boolean, timestamptz)
  from public, anon, authenticated;
grant execute on function screening_v2.advance_ashby_sync_checkpoint(text, text, integer, integer, boolean, timestamptz)
  to service_role;

comment on function screening_v2.advance_ashby_sync_checkpoint is
  'Persists a reconciliation cursor after a SUCCESSFUL fully-drained run. '
  '0032: also resets no_progress_runs to 0 (progress observed). The '
  'single-flight lease is released separately by end_ashby_sync_run. '
  'Service-role-only.';
