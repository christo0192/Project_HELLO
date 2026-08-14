-- =====================================================================
-- 0031 — Ashby Wave 2 PR C: screening-workflow execution primitives.
--
-- Adds the atomic, service-role-only primitives the disabled-by-default
-- orchestration workers need on top of the 0029 schema + 0030 ingress:
--   1. Additive lease/anchor/marker columns on ashby_operations (leased,
--      CAS-guarded outbox execution + scorecard idempotency + external anchor).
--   2. enqueue_ashby_operation      — idempotent outbox insert (unique
--      operation_key + optional content marker), fails closed on a terminal
--      application link.
--   3. claim_ashby_operation        — FOR UPDATE SKIP LOCKED lease claim of the
--      next runnable op whose dependency (scorecard-before-stage) has succeeded.
--   4. complete_ashby_operation     — CAS success under the live lease; persists
--      the sanitized external anchor + marker.
--   5. fail_ashby_operation         — CAS retry/fail under the live lease.
--   6. cancel_ashby_application     — ONE-transaction terminal cancellation:
--      mark the link terminal + cancel every in-flight operation + the in-flight
--      ingestion; idempotent; never reverses a succeeded op; never auto-rejects.
--   7. advance_ashby_ingestion      — restart-safe ingestion transition with
--      hash/version provenance (the 0029 trigger enforces legality).
--   8. set_ashby_mapping_status     — Mission Control pause/resume (enable still
--      requires completeness + non-drift).
--
-- Forward-only and additive (C-1): guarded ADD COLUMN IF NOT EXISTS + guarded
-- indexes + CREATE OR REPLACE functions + the sanctioned replaceable
-- CHECK-evolution of audit_events.chk_audit_action (drop IF EXISTS + re-create
-- + NOT VALID + VALIDATE, same name). No destructive DDL, no reverse SQL, no
-- changes to existing 0029/0030 object bodies.
--
-- Security posture (mirrors 0015/0029/0030): the touched tables keep RLS
-- enabled with NO anon/authenticated/public policy or grant — the browser never
-- reaches them; the API uses the service-role client. Every SECURITY DEFINER
-- RPC pins search_path and is revoked from public/anon/authenticated, granted to
-- service_role only, and writes its audit row in the same transaction.
--
-- Privacy: operations carry opaque ids, a sanitized external anchor, a content
-- marker hash, and sanitized error codes only — never PII, tokens, presigned
-- URLs, raw bodies, transcripts, or recordings.
-- =====================================================================

-- ═══════════════════════════════════════════════════════════════════════
-- 1. ashby_operations — additive lease/anchor/marker columns
-- ═══════════════════════════════════════════════════════════════════════

alter table screening_v2.ashby_operations
  add column if not exists lease_token     uuid,
  add column if not exists lease_owner     text,
  add column if not exists lease_expires_at timestamptz,
  add column if not exists external_anchor text,
  add column if not exists marker          text,
  add column if not exists last_error_at   timestamptz;

do $$
begin
  if not exists (
    select 1 from pg_constraint
     where conname = 'chk_ashby_operations_lease_owner'
       and conrelid = 'screening_v2.ashby_operations'::regclass
  ) then
    alter table screening_v2.ashby_operations
      add constraint chk_ashby_operations_lease_owner
        check (lease_owner is null or length(lease_owner) between 1 and 128);
  end if;
  if not exists (
    select 1 from pg_constraint
     where conname = 'chk_ashby_operations_external_anchor'
       and conrelid = 'screening_v2.ashby_operations'::regclass
  ) then
    alter table screening_v2.ashby_operations
      add constraint chk_ashby_operations_external_anchor
        check (external_anchor is null or length(external_anchor) between 1 and 256);
  end if;
  if not exists (
    select 1 from pg_constraint
     where conname = 'chk_ashby_operations_marker'
       and conrelid = 'screening_v2.ashby_operations'::regclass
  ) then
    alter table screening_v2.ashby_operations
      add constraint chk_ashby_operations_marker
        check (marker is null or marker ~ '^[a-f0-9]{8,64}$');
  end if;
end;
$$;

comment on column screening_v2.ashby_operations.lease_token is
  'Unguessable lease token for the current running claim (uuid). Never logged.';
comment on column screening_v2.ashby_operations.external_anchor is
  'Sanitized opaque external reference (e.g. Ashby feedback/scorecard id) — never PII/token/URL.';
comment on column screening_v2.ashby_operations.marker is
  'Deterministic content idempotency marker (hex hash) — "write only if no matching marker".';

-- Idempotency: at most one operation per (application_link, marker).
create unique index if not exists uq_ashby_operations_marker
  on screening_v2.ashby_operations (application_link_id, marker) where marker is not null;
-- Claim path index: runnable pending ops by schedule.
create index if not exists idx_ashby_operations_claimable
  on screening_v2.ashby_operations (operation_type, scheduled_at)
  where state = 'pending';

-- ═══════════════════════════════════════════════════════════════════════
-- 2. audit_events action-CHECK evolution (additive, 0031)
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
      'ashby_application_cancel', 'ashby_operation_enqueue', 'ashby_operation_update'
    )
  )
  not valid;
alter table screening_v2.audit_events
  validate constraint chk_audit_action;

comment on constraint chk_audit_action on screening_v2.audit_events is
  'Audit action allowlist — extended additively by 0031 with the Ashby '
  'workflow-execution audits (ashby_application_cancel, ashby_operation_enqueue, '
  'ashby_operation_update). Metadata carries only opaque ids/codes — never PII.';

-- ═══════════════════════════════════════════════════════════════════════
-- 3. enqueue_ashby_operation — idempotent outbox insert (terminal-safe)
-- ═══════════════════════════════════════════════════════════════════════

create or replace function screening_v2.enqueue_ashby_operation(
  p_application_link_id uuid,
  p_operation_type      text,
  p_operation_key       text,
  p_depends_on          uuid,
  p_marker              text,
  p_actor_id            uuid
)
returns jsonb
language plpgsql
security definer
set search_path = pg_catalog, screening_v2
as $$
declare
  v_id uuid;
begin
  if p_application_link_id is null then
    return jsonb_build_object('status', 'invalid_link');
  end if;
  if coalesce(p_operation_type, '') not in ('invite_delivery','scorecard_write','stage_move') then
    return jsonb_build_object('status', 'invalid_operation_type');
  end if;
  if p_operation_key is null or length(p_operation_key) < 1 or length(p_operation_key) > 256 then
    return jsonb_build_object('status', 'invalid_operation_key');
  end if;
  if p_marker is not null and p_marker !~ '^[a-f0-9]{8,64}$' then
    return jsonb_build_object('status', 'invalid_marker');
  end if;

  begin
    insert into screening_v2.ashby_operations
      (application_link_id, provider, operation_type, operation_key,
       depends_on_operation_id, marker, state)
    values
      (p_application_link_id, 'ashby', p_operation_type, p_operation_key,
       p_depends_on, p_marker, 'pending')
    on conflict (provider, operation_key) do nothing
    returning id into v_id;
  exception
    when unique_violation then
      -- marker uniqueness (application_link_id, marker) — already enqueued.
      return jsonb_build_object('status', 'duplicate_marker');
    when raise_exception then
      -- The terminal-link INSERT trigger blocks new ops on a terminal link.
      return jsonb_build_object('status', 'blocked_terminal');
  end;

  if v_id is null then
    select id into v_id from screening_v2.ashby_operations
     where provider = 'ashby' and operation_key = p_operation_key;
    return jsonb_build_object('status', 'duplicate', 'id', v_id);
  end if;

  insert into screening_v2.audit_events
    (actor_id, actor_type, action, target_type, target_id, result, metadata)
  values
    (coalesce(p_actor_id, '00000000-0000-4000-8000-000000000001'), 'system',
     'ashby_operation_enqueue', 'ashby_operation', v_id::text, 'success',
     jsonb_build_object('operation_id', v_id, 'operation_type', p_operation_type,
                        'has_dependency', p_depends_on is not null));

  return jsonb_build_object('status', 'inserted', 'id', v_id);
end;
$$;

revoke all on function screening_v2.enqueue_ashby_operation(uuid, text, text, uuid, text, uuid)
  from public, anon, authenticated;
grant execute on function screening_v2.enqueue_ashby_operation(uuid, text, text, uuid, text, uuid)
  to service_role;

comment on function screening_v2.enqueue_ashby_operation is
  'Idempotent Ashby outbox insert keyed by unique operation_key (+ optional '
  'content marker for scorecard idempotency). Returns inserted/duplicate/'
  'duplicate_marker/blocked_terminal. Fails closed on a terminal application '
  'link. Service-role-only; audited.';

-- ═══════════════════════════════════════════════════════════════════════
-- 4. claim_ashby_operation — leased claim of the next runnable op
-- ═══════════════════════════════════════════════════════════════════════

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
   where o.provider = 'ashby'
     and o.state = 'pending'
     and o.scheduled_at <= p_now
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
   for update skip locked
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
  'operation whose dependency (scorecard-before-stage) has succeeded. Grants an '
  'unguessable lease token + bounded window; a stale worker cannot commit. '
  'Service-role-only.';

-- ═══════════════════════════════════════════════════════════════════════
-- 5. complete_ashby_operation — CAS success under the live lease
-- ═══════════════════════════════════════════════════════════════════════

create or replace function screening_v2.complete_ashby_operation(
  p_operation_id   uuid,
  p_lease_token    uuid,
  p_external_anchor text,
  p_marker         text,
  p_actor_id       uuid,
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
  if p_external_anchor is not null and (length(p_external_anchor) < 1 or length(p_external_anchor) > 256) then
    return jsonb_build_object('status', 'invalid_anchor');
  end if;
  if p_marker is not null and p_marker !~ '^[a-f0-9]{8,64}$' then
    return jsonb_build_object('status', 'invalid_marker');
  end if;

  update screening_v2.ashby_operations
     set state = 'succeeded',
         external_anchor = coalesce(p_external_anchor, external_anchor),
         marker = coalesce(p_marker, marker),
         lease_token = null,
         lease_owner = null,
         lease_expires_at = null,
         error_code = null,
         error_detail = null,
         updated_at = p_now
   where id = p_operation_id
     and lease_token = p_lease_token
     and state = 'running'
  returning id into v_id;

  if v_id is null then
    return jsonb_build_object('status', 'not_owned');
  end if;

  insert into screening_v2.audit_events
    (actor_id, actor_type, action, target_type, target_id, result, metadata)
  values
    (coalesce(p_actor_id, '00000000-0000-4000-8000-000000000001'), 'system',
     'ashby_operation_update', 'ashby_operation', v_id::text, 'success',
     jsonb_build_object('operation_id', v_id, 'outcome', 'succeeded',
                        'has_anchor', p_external_anchor is not null));

  return jsonb_build_object('status', 'ok');
end;
$$;

revoke all on function screening_v2.complete_ashby_operation(uuid, uuid, text, text, uuid, timestamptz)
  from public, anon, authenticated;
grant execute on function screening_v2.complete_ashby_operation(uuid, uuid, text, text, uuid, timestamptz)
  to service_role;

comment on function screening_v2.complete_ashby_operation is
  'CAS completion of a running Ashby operation under the live lease token; '
  'persists the sanitized external anchor + content marker. Returns not_owned '
  'for a stale/mismatched lease (a stale worker cannot commit). Service-role-only.';

-- ═══════════════════════════════════════════════════════════════════════
-- 6. fail_ashby_operation — CAS retry/fail under the live lease
-- ═══════════════════════════════════════════════════════════════════════

create or replace function screening_v2.fail_ashby_operation(
  p_operation_id uuid,
  p_lease_token  uuid,
  p_error_code   text,
  p_retryable    boolean,
  p_now          timestamptz default now()
)
returns jsonb
language plpgsql
security definer
set search_path = pg_catalog, screening_v2
as $$
declare
  v_op      screening_v2.ashby_operations%rowtype;
  v_outcome text;
begin
  if p_error_code is not null and p_error_code !~ '^[a-z0-9_.:-]{1,64}$' then
    return jsonb_build_object('status', 'invalid_error_code');
  end if;

  select * into v_op
    from screening_v2.ashby_operations
   where id = p_operation_id and lease_token = p_lease_token and state = 'running'
   for update;
  if not found then
    return jsonb_build_object('status', 'not_owned');
  end if;

  if coalesce(p_retryable, false) and v_op.attempts < v_op.max_attempts then
    update screening_v2.ashby_operations
       set state = 'pending',
           lease_token = null, lease_owner = null, lease_expires_at = null,
           error_code = p_error_code, last_error_at = p_now,
           scheduled_at = p_now, updated_at = p_now
     where id = p_operation_id;
    v_outcome := 'retry';
  else
    update screening_v2.ashby_operations
       set state = 'failed',
           lease_token = null, lease_owner = null, lease_expires_at = null,
           error_code = p_error_code, last_error_at = p_now, updated_at = p_now
     where id = p_operation_id;
    v_outcome := 'failed';
  end if;

  insert into screening_v2.audit_events
    (actor_id, actor_type, action, target_type, target_id, result, metadata)
  values
    ('00000000-0000-4000-8000-000000000001', 'system',
     'ashby_operation_update', 'ashby_operation', p_operation_id::text,
     case when v_outcome = 'failed' then 'failure' else 'success' end,
     jsonb_build_object('operation_id', p_operation_id, 'outcome', v_outcome,
                        'error_code', p_error_code));

  return jsonb_build_object('status', 'ok', 'outcome', v_outcome);
end;
$$;

revoke all on function screening_v2.fail_ashby_operation(uuid, uuid, text, boolean, timestamptz)
  from public, anon, authenticated;
grant execute on function screening_v2.fail_ashby_operation(uuid, uuid, text, boolean, timestamptz)
  to service_role;

comment on function screening_v2.fail_ashby_operation is
  'CAS failure of a running Ashby operation under the live lease: reschedules '
  'to pending while attempts remain (retryable), else marks failed. Returns '
  'not_owned for a stale lease. Sanitized error codes only. Service-role-only.';

-- ═══════════════════════════════════════════════════════════════════════
-- 7. cancel_ashby_application — ONE-transaction terminal cancellation
-- ═══════════════════════════════════════════════════════════════════════
-- Marks the link terminal AND cancels every in-flight operation + the
-- in-flight ingestion atomically. Idempotent (already-terminal → no-op). Never
-- reverses a succeeded/failed operation; never auto-rejects the candidate.

create or replace function screening_v2.cancel_ashby_application(
  p_application_link_id uuid,
  p_terminal_state      text,
  p_reason              text,
  p_actor_id            uuid,
  p_actor_type          text default 'system'
)
returns jsonb
language plpgsql
security definer
set search_path = pg_catalog, screening_v2
as $$
declare
  v_link          screening_v2.ashby_application_links%rowtype;
  v_cancelled_ops integer := 0;
  v_cancelled_ing integer := 0;
begin
  if p_terminal_state not in ('withdrawn','deleted','manual_stage_cancel') then
    return jsonb_build_object('status', 'invalid_terminal_state');
  end if;
  if p_reason is not null and length(p_reason) > 200 then
    return jsonb_build_object('status', 'invalid_reason');
  end if;

  select * into v_link
    from screening_v2.ashby_application_links
   where id = p_application_link_id
   for update;
  if not found then
    return jsonb_build_object('status', 'not_found');
  end if;

  if v_link.terminal_state is not null then
    -- Idempotent: an already-terminal link is not re-cancelled or reversed.
    return jsonb_build_object('status', 'already_terminal',
                              'terminal_state', v_link.terminal_state);
  end if;

  update screening_v2.ashby_application_links
     set terminal_state = p_terminal_state,
         terminal_reason = coalesce(p_reason, 'terminal_cancel'),
         lifecycle = 'cancelled',
         updated_at = now()
   where id = p_application_link_id;

  -- Cancel every still-in-flight operation (never touch succeeded/failed/cancelled).
  with cancelled as (
    update screening_v2.ashby_operations
       set state = 'cancelled',
           error_code = 'terminal_cancel',
           lease_token = null, lease_owner = null, lease_expires_at = null,
           updated_at = now()
     where application_link_id = p_application_link_id
       and state in ('pending','running','blocked')
    returning 1
  )
  select count(*) into v_cancelled_ops from cancelled;

  -- Cancel an in-flight ingestion (the 0029 trigger allows any non-terminal → cancelled).
  with cancelled_ing as (
    update screening_v2.ashby_resume_ingestions
       set state = 'cancelled',
           failed_reason = 'terminal_cancel',
           updated_at = now()
     where application_link_id = p_application_link_id
       and state in ('queued','fetching','scanning','extracting','structuring','failed_review')
    returning 1
  )
  select count(*) into v_cancelled_ing from cancelled_ing;

  insert into screening_v2.audit_events
    (actor_id, actor_type, action, target_type, target_id, result, metadata)
  values
    (coalesce(p_actor_id, '00000000-0000-4000-8000-000000000001'),
     case when p_actor_type in ('recruiter','system','admin') then p_actor_type else 'system' end,
     'ashby_application_cancel', 'ashby_application_link', p_application_link_id::text, 'success',
     jsonb_build_object('application_link_id', p_application_link_id,
                        'terminal_state', p_terminal_state,
                        'cancelled_operations', v_cancelled_ops,
                        'cancelled_ingestion', v_cancelled_ing));

  return jsonb_build_object('status', 'ok',
                            'terminal_state', p_terminal_state,
                            'cancelled_operations', v_cancelled_ops,
                            'cancelled_ingestion', v_cancelled_ing);
end;
$$;

revoke all on function screening_v2.cancel_ashby_application(uuid, text, text, uuid, text)
  from public, anon, authenticated;
grant execute on function screening_v2.cancel_ashby_application(uuid, text, text, uuid, text)
  to service_role;

comment on function screening_v2.cancel_ashby_application is
  'Atomic terminal cancellation: marks the application link terminal and '
  'cancels every in-flight operation + the in-flight ingestion in one '
  'transaction. Idempotent; never reverses a succeeded/failed op; never '
  'auto-rejects. Service-role-only; audited.';

-- ═══════════════════════════════════════════════════════════════════════
-- 8. advance_ashby_ingestion — restart-safe ingestion transition + provenance
-- ═══════════════════════════════════════════════════════════════════════

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
  v_id uuid;
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

  begin
    update screening_v2.ashby_resume_ingestions
       set state = p_next_state,
           content_sha256 = coalesce(p_content_sha256, content_sha256),
           extractor_version = coalesce(p_extractor_version, extractor_version),
           structurer_version = coalesce(p_structurer_version, structurer_version),
           failed_reason = case when p_next_state = 'failed_review'
                                then left(coalesce(p_failed_reason, 'failed'), 200) else failed_reason end,
           attempts = case when p_next_state = 'queued' then attempts + 1 else attempts end,
           updated_at = p_now
     where application_link_id = p_application_link_id
    returning id into v_id;
  exception
    when raise_exception then
      -- The 0029 transition trigger raised: illegal state move.
      return jsonb_build_object('status', 'invalid_transition');
  end;

  if v_id is null then
    return jsonb_build_object('status', 'not_found');
  end if;
  return jsonb_build_object('status', 'ok', 'state', p_next_state);
end;
$$;

revoke all on function screening_v2.advance_ashby_ingestion(uuid, text, text, text, text, text, timestamptz)
  from public, anon, authenticated;
grant execute on function screening_v2.advance_ashby_ingestion(uuid, text, text, text, text, text, timestamptz)
  to service_role;

comment on function screening_v2.advance_ashby_ingestion is
  'Restart-safe ingestion state transition with hash/version provenance. The '
  '0029 trigger enforces legality; an illegal move returns invalid_transition. '
  'Stores references only — never bytes or URLs. Service-role-only.';

-- ═══════════════════════════════════════════════════════════════════════
-- 9. set_ashby_mapping_status — Mission Control pause/resume
-- ═══════════════════════════════════════════════════════════════════════
-- Toggles a mapping between paused and enabled. Enabling still requires
-- completeness (both stage IDs) and a non-drifted current status.

create or replace function screening_v2.set_ashby_mapping_status(
  p_mapping_id uuid,
  p_status     text,
  p_reason     text,
  p_actor_id   uuid
)
returns jsonb
language plpgsql
security definer
set search_path = pg_catalog, screening_v2
as $$
declare
  v_current screening_v2.ashby_job_mappings%rowtype;
begin
  if p_actor_id is null then
    return jsonb_build_object('status', 'actor_required');
  end if;
  if p_status not in ('paused','enabled') then
    return jsonb_build_object('status', 'invalid_status');
  end if;

  select * into v_current from screening_v2.ashby_job_mappings
   where id = p_mapping_id for update;
  if not found then
    return jsonb_build_object('status', 'not_found');
  end if;

  if p_status = 'enabled' then
    if v_current.ai_screening_stage_id is null or v_current.ta_screening_stage_id is null then
      return jsonb_build_object('status', 'incomplete_cannot_enable');
    end if;
    if v_current.status = 'drift' then
      return jsonb_build_object('status', 'drifted_cannot_enable');
    end if;
  end if;

  update screening_v2.ashby_job_mappings
     set status = p_status,
         status_reason = case when p_status = 'enabled' then null else left(coalesce(p_reason, 'paused'), 200) end,
         config_version = config_version + 1,
         updated_at = now()
   where id = p_mapping_id;

  insert into screening_v2.audit_events
    (actor_id, actor_type, action, target_type, target_id, result, metadata)
  values
    (p_actor_id, 'recruiter', 'ashby_mapping_update', 'ashby_job_mapping', p_mapping_id::text, 'success',
     jsonb_build_object('mapping_id', p_mapping_id, 'status', p_status, 'action', 'set_status'));

  return jsonb_build_object('status', 'ok', 'mapping_status', p_status);
end;
$$;

revoke all on function screening_v2.set_ashby_mapping_status(uuid, text, text, uuid)
  from public, anon, authenticated;
grant execute on function screening_v2.set_ashby_mapping_status(uuid, text, text, uuid)
  to service_role;

comment on function screening_v2.set_ashby_mapping_status is
  'Mission Control pause/resume of a mapping. Enabling still requires both '
  'stage IDs (completeness) and a non-drifted status. Audited. Service-role-only.';

-- ═══════════════════════════════════════════════════════════════════════
-- Verifier: schema reload notification
-- ═══════════════════════════════════════════════════════════════════════

notify pgrst, 'reload schema';
