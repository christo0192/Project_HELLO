-- =====================================================================
-- 0029 — Ashby Wave 2 PR A: normalized integration schema + paused config
--        (job mappings / application identity / event receipts / resume
--         ingestion state / delivery+writeback operation outbox +
--         state-machine, dependency, and terminal-block triggers +
--         audited service-role-only mapping-administration RPCs).
--
-- Forward-only and additive (C-1): new tables (guarded CREATE IF NOT EXISTS),
-- guarded indexes/triggers, CREATE OR REPLACE functions, and the sanctioned
-- replaceable CHECK-evolution of audit_events.chk_audit_action (drop IF EXISTS
-- + re-create + NOT VALID + VALIDATE, same name). No destructive DDL, no
-- reverse SQL.
--
-- Security posture (mirrors 0015): every new integration table has RLS
-- enabled and NO anon/authenticated/public policy or grant — the browser never
-- reaches these tables; the API service uses the service-role client. Every
-- SECURITY DEFINER RPC pins search_path and is revoked from public/anon/
-- authenticated, granted to service_role only.
--
-- Privacy: contact fields (email/phone), resume text/bytes, signed URLs, and
-- invite tokens live ONLY in the existing sensitive candidate/invite model.
-- These operational/identity/event/outbox tables reference internal IDs and
-- opaque external handles/IDs — never duplicated PII, never raw webhook bodies.
-- =====================================================================

-- ═══════════════════════════════════════════════════════════════════════
-- 1. ashby_job_mappings — paused-by-default per-job mapping
-- ═══════════════════════════════════════════════════════════════════════
-- One row per (provider, Ashby job). Paused by default; can only be ENABLED
-- when the AI/TA screening stage IDs are present (completeness) and no drift
-- is recorded. Drift auto-pauses via mark_ashby_mapping_drift. The invite TTL
-- is fixed to 24h in Phase 1. `label` is a NON-SENSITIVE display label only
-- (e.g. a canary tag); it must never carry candidate/tenant secrets.

create table if not exists screening_v2.ashby_job_mappings (
  id                    uuid primary key default gen_random_uuid(),
  provider              text not null default 'ashby',
  external_job_id       text not null,
  role_id               uuid not null references screening_v2.roles(id) on delete restrict,
  ai_screening_stage_id text,
  ta_screening_stage_id text,
  feedback_form_id      text,
  interview_id          text,
  attribution_user_id   text,
  owner_id              uuid not null,   -- recruiter/admin auth UUID; FK omitted for test flexibility
  delivery_mode         text not null default 'manual',
  invite_ttl_hours      integer not null default 24,
  config_version        integer not null default 1,
  status                text not null default 'paused',
  status_reason         text,            -- sanitized paused/drift reason
  label                 text,            -- non-sensitive display label only
  created_at            timestamptz not null default now(),
  updated_at            timestamptz not null default now(),
  constraint uq_ashby_job_mappings_provider_job unique (provider, external_job_id),
  constraint chk_ashby_job_mappings_provider check (provider = 'ashby'),
  constraint chk_ashby_job_mappings_external_job_id check (length(external_job_id) between 1 and 256),
  constraint chk_ashby_job_mappings_delivery_mode check (delivery_mode in ('email','manual','both')),
  constraint chk_ashby_job_mappings_invite_ttl check (invite_ttl_hours = 24),
  constraint chk_ashby_job_mappings_config_version check (config_version >= 1),
  constraint chk_ashby_job_mappings_status check (status in ('paused','enabled','drift')),
  constraint chk_ashby_job_mappings_status_reason check (status_reason is null or length(status_reason) <= 200),
  constraint chk_ashby_job_mappings_label check (label is null or length(label) <= 120),
  constraint chk_ashby_job_mappings_stage_ids check (
    ai_screening_stage_id is null or length(ai_screening_stage_id) between 1 and 256),
  constraint chk_ashby_job_mappings_ta_stage_ids check (
    ta_screening_stage_id is null or length(ta_screening_stage_id) between 1 and 256),
  -- Incomplete mappings cannot be enabled: an ENABLED mapping MUST carry both
  -- the AI and TA screening stage IDs (per-mapping, not global/display-name).
  constraint chk_ashby_job_mappings_enabled_completeness check (
    status <> 'enabled'
    or (ai_screening_stage_id is not null and ta_screening_stage_id is not null)
  )
);

comment on table screening_v2.ashby_job_mappings is
  'Paused-by-default per-job Ashby mapping (one per provider+job). Only '
  'ENABLED mappings are processed; enabling requires both AI/TA stage IDs '
  '(completeness) and no drift. invite_ttl_hours is fixed at 24 (Phase 1). '
  'Stage IDs are per-mapping — no global or display-name routing. `label` is '
  'a non-sensitive display label; never PII/secrets.';
comment on column screening_v2.ashby_job_mappings.status_reason is
  'Sanitized paused/drift reason code — never PII, tokens, or raw provider text.';

create index if not exists idx_ashby_job_mappings_enabled
  on screening_v2.ashby_job_mappings (provider, status) where status = 'enabled';
create index if not exists idx_ashby_job_mappings_role
  on screening_v2.ashby_job_mappings (role_id);

alter table screening_v2.ashby_job_mappings enable row level security;
revoke all on screening_v2.ashby_job_mappings from anon, authenticated, public;
grant all privileges on screening_v2.ashby_job_mappings to service_role;

-- ═══════════════════════════════════════════════════════════════════════
-- 2. ashby_application_links — application-centric workflow identity
-- ═══════════════════════════════════════════════════════════════════════
-- Unique (provider, external_application_id): the Ashby application ID is the
-- workflow identity. NEVER deduplicated by email/phone. Links optional
-- external references (candidate/job/stage/resume file HANDLE — a handle, not
-- bytes/URL) to internal candidate/session/invite/assessment IDs. Terminal
-- markers (withdrawn/deleted/manual_stage_cancel) are modeled WITHOUT deciding
-- local erasure policy (that remains a privacy/legal decision).

create table if not exists screening_v2.ashby_application_links (
  id                          uuid primary key default gen_random_uuid(),
  provider                    text not null default 'ashby',
  external_application_id      text not null,
  external_candidate_id       text,
  external_job_id             text,
  external_stage_id           text,
  external_resume_file_handle text,        -- opaque Ashby file handle; never bytes/URL
  job_mapping_id              uuid references screening_v2.ashby_job_mappings(id) on delete set null,
  candidate_id                uuid references screening_v2.candidates(id) on delete set null,
  session_id                  uuid references screening_v2.call_sessions(id) on delete set null,
  invite_id                   uuid references screening_v2.candidate_invites(id) on delete set null,
  assessment_id               uuid references screening_v2.assessments(id) on delete set null,
  lifecycle                   text not null default 'imported',
  terminal_state              text,        -- withdrawn|deleted|manual_stage_cancel
  terminal_reason             text,        -- sanitized
  created_at                  timestamptz not null default now(),
  updated_at                  timestamptz not null default now(),
  constraint uq_ashby_application_links_app unique (provider, external_application_id),
  constraint chk_ashby_application_links_provider check (provider = 'ashby'),
  constraint chk_ashby_application_links_app_id check (length(external_application_id) between 1 and 256),
  constraint chk_ashby_application_links_ext_candidate check (external_candidate_id is null or length(external_candidate_id) between 1 and 256),
  constraint chk_ashby_application_links_ext_job check (external_job_id is null or length(external_job_id) between 1 and 256),
  constraint chk_ashby_application_links_ext_stage check (external_stage_id is null or length(external_stage_id) between 1 and 256),
  constraint chk_ashby_application_links_resume_handle check (external_resume_file_handle is null or length(external_resume_file_handle) between 1 and 512),
  constraint chk_ashby_application_links_lifecycle check (lifecycle in ('imported','processing','ready','completed','cancelled')),
  constraint chk_ashby_application_links_terminal_state check (terminal_state is null or terminal_state in ('withdrawn','deleted','manual_stage_cancel')),
  constraint chk_ashby_application_links_terminal_reason check (terminal_reason is null or length(terminal_reason) <= 200)
);

comment on table screening_v2.ashby_application_links is
  'Application-centric Ashby workflow identity, unique per '
  '(provider, external_application_id) — NEVER deduplicated by email/phone. '
  'Holds opaque external IDs and a resume file HANDLE reference (never bytes '
  'or signed URLs) plus optional internal candidate/session/invite/assessment '
  'FKs. Terminal markers are modeled without deciding local erasure policy.';
comment on column screening_v2.ashby_application_links.external_resume_file_handle is
  'Opaque Ashby file handle reference only — never resume bytes or a signed URL.';

create index if not exists idx_ashby_application_links_mapping
  on screening_v2.ashby_application_links (job_mapping_id);
create index if not exists idx_ashby_application_links_candidate
  on screening_v2.ashby_application_links (candidate_id);
create index if not exists idx_ashby_application_links_terminal
  on screening_v2.ashby_application_links (id) where terminal_state is not null;

alter table screening_v2.ashby_application_links enable row level security;
revoke all on screening_v2.ashby_application_links from anon, authenticated, public;
grant all privileges on screening_v2.ashby_application_links to service_role;

-- ═══════════════════════════════════════════════════════════════════════
-- 3. ashby_event_receipts — sanitized webhook/event receipts
-- ═══════════════════════════════════════════════════════════════════════
-- Unique (provider, webhook_action_id, action): duplicate/self-generated
-- events converge to one receipt. Bounded non-PII metadata only — never the
-- raw webhook body, contact/resume data, or tokens.

create table if not exists screening_v2.ashby_event_receipts (
  id                  uuid primary key default gen_random_uuid(),
  provider            text not null default 'ashby',
  webhook_action_id   text not null,
  action              text not null,
  application_link_id uuid references screening_v2.ashby_application_links(id) on delete set null,
  status              text not null default 'received',
  metadata            jsonb,
  received_at         timestamptz not null default now(),
  processed_at        timestamptz,
  created_at          timestamptz not null default now(),
  constraint uq_ashby_event_receipts_key unique (provider, webhook_action_id, action),
  constraint chk_ashby_event_receipts_provider check (provider = 'ashby'),
  constraint chk_ashby_event_receipts_action_id check (length(webhook_action_id) between 1 and 256),
  constraint chk_ashby_event_receipts_action check (length(action) between 1 and 128),
  constraint chk_ashby_event_receipts_status check (status in ('received','processing','processed','failed','ignored')),
  constraint chk_ashby_event_receipts_metadata_size check (metadata is null or octet_length(metadata::text) <= 2048)
);

comment on table screening_v2.ashby_event_receipts is
  'Sanitized Ashby webhook/event receipts, unique per '
  '(provider, webhook_action_id, action) so duplicate and self-generated '
  'events converge to one receipt. metadata is bounded non-PII only — never '
  'the raw webhook body, contact/resume data, tokens, or signed URLs.';

create index if not exists idx_ashby_event_receipts_status
  on screening_v2.ashby_event_receipts (status, received_at);
create index if not exists idx_ashby_event_receipts_link
  on screening_v2.ashby_event_receipts (application_link_id);

alter table screening_v2.ashby_event_receipts enable row level security;
revoke all on screening_v2.ashby_event_receipts from anon, authenticated, public;
grant all privileges on screening_v2.ashby_event_receipts to service_role;

-- ═══════════════════════════════════════════════════════════════════════
-- 4. ashby_resume_ingestions — ephemeral ingestion state machine
-- ═══════════════════════════════════════════════════════════════════════
-- One ingestion per application link. State machine
-- queued -> fetching -> scanning -> extracting -> structuring -> ready
-- with failed_review / cancelled branches. Stores hash/version/provenance
-- REFERENCES only — never original bytes or signed URLs. Legal transitions
-- enforced by a trigger.

create table if not exists screening_v2.ashby_resume_ingestions (
  id                  uuid primary key default gen_random_uuid(),
  application_link_id uuid not null references screening_v2.ashby_application_links(id) on delete cascade,
  provider            text not null default 'ashby',
  state               text not null default 'queued',
  content_sha256      text,
  extractor_version   text,
  structurer_version  text,
  provenance          jsonb,
  failed_reason       text,       -- sanitized
  attempts            integer not null default 0,
  created_at          timestamptz not null default now(),
  updated_at          timestamptz not null default now(),
  constraint uq_ashby_resume_ingestions_link unique (application_link_id),
  constraint chk_ashby_resume_ingestions_provider check (provider = 'ashby'),
  constraint chk_ashby_resume_ingestions_state check (
    state in ('queued','fetching','scanning','extracting','structuring','ready','failed_review','cancelled')),
  constraint chk_ashby_resume_ingestions_sha check (content_sha256 is null or content_sha256 ~ '^[a-f0-9]{64}$'),
  constraint chk_ashby_resume_ingestions_extractor check (extractor_version is null or length(extractor_version) <= 64),
  constraint chk_ashby_resume_ingestions_structurer check (structurer_version is null or length(structurer_version) <= 64),
  constraint chk_ashby_resume_ingestions_provenance_size check (provenance is null or octet_length(provenance::text) <= 2048),
  constraint chk_ashby_resume_ingestions_failed_reason check (failed_reason is null or length(failed_reason) <= 200),
  constraint chk_ashby_resume_ingestions_attempts check (attempts >= 0)
);

comment on table screening_v2.ashby_resume_ingestions is
  'Ephemeral resume-ingestion state per application link. States: queued -> '
  'fetching -> scanning -> extracting -> structuring -> ready, with '
  'failed_review/cancelled branches; legal transitions enforced by trigger. '
  'Stores content hash, extractor/structurer versions, and provenance '
  'REFERENCES only — never original bytes or signed URLs.';

create index if not exists idx_ashby_resume_ingestions_state
  on screening_v2.ashby_resume_ingestions (state, updated_at);

-- Legal-transition enforcement for the ingestion state machine.
create or replace function screening_v2.enforce_ashby_ingestion_transition()
returns trigger
language plpgsql
security invoker
set search_path = pg_catalog
as $$
declare
  allowed text[];
begin
  if old.state = new.state then
    return new;   -- idempotent no-op
  end if;
  case old.state
    when 'queued'      then allowed := array['fetching','cancelled'];
    when 'fetching'    then allowed := array['scanning','failed_review','cancelled'];
    when 'scanning'    then allowed := array['extracting','failed_review','cancelled'];
    when 'extracting'  then allowed := array['structuring','failed_review','cancelled'];
    when 'structuring' then allowed := array['ready','failed_review','cancelled'];
    when 'failed_review' then allowed := array['queued','cancelled'];  -- retriable
    when 'ready'       then allowed := '{}'::text[];   -- terminal
    when 'cancelled'   then allowed := '{}'::text[];   -- terminal
    else allowed := '{}'::text[];
  end case;
  if not (new.state = any(allowed)) then
    raise exception 'invalid ashby resume ingestion transition % -> %', old.state, new.state
      using errcode = 'P0001';
  end if;
  return new;
end;
$$;

drop trigger if exists trg_ashby_ingestion_transition
  on screening_v2.ashby_resume_ingestions;
create trigger trg_ashby_ingestion_transition
  before update on screening_v2.ashby_resume_ingestions
  for each row
  execute function screening_v2.enforce_ashby_ingestion_transition();

comment on function screening_v2.enforce_ashby_ingestion_transition is
  'Enforces the legal ashby_resume_ingestions state machine on UPDATE; '
  'same-state is a no-op. Terminal states (ready, cancelled) reject all '
  'transitions.';

alter table screening_v2.ashby_resume_ingestions enable row level security;
revoke all on screening_v2.ashby_resume_ingestions from anon, authenticated, public;
grant all privileges on screening_v2.ashby_resume_ingestions to service_role;

-- ═══════════════════════════════════════════════════════════════════════
-- 5. ashby_operations — delivery + external-operation outbox
-- ═══════════════════════════════════════════════════════════════════════
-- Deterministic unique operation key per (provider, operation_key). Supports
-- invitation delivery, scorecard write-back, and stage movement. Ordering /
-- dependency support scorecard-before-stage via depends_on_operation_id: a
-- stage_move cannot become runnable (running) or succeeded until its
-- dependency (scorecard_write) has succeeded — enforced by trigger. Creating
-- any operation for a TERMINAL application link (withdrawn/deleted/
-- manual_stage_cancel) is rejected. Errors are sanitized stable codes only.

create table if not exists screening_v2.ashby_operations (
  id                      uuid primary key default gen_random_uuid(),
  application_link_id     uuid not null references screening_v2.ashby_application_links(id) on delete cascade,
  provider                text not null default 'ashby',
  operation_type          text not null,
  operation_key           text not null,
  depends_on_operation_id uuid references screening_v2.ashby_operations(id) on delete set null,
  state                   text not null default 'pending',
  attempts                integer not null default 0,
  max_attempts            integer not null default 5,
  scheduled_at            timestamptz not null default now(),
  error_code              text,        -- sanitized stable code
  error_detail            text,        -- sanitized bounded
  created_at              timestamptz not null default now(),
  updated_at              timestamptz not null default now(),
  constraint uq_ashby_operations_key unique (provider, operation_key),
  constraint chk_ashby_operations_provider check (provider = 'ashby'),
  constraint chk_ashby_operations_type check (operation_type in ('invite_delivery','scorecard_write','stage_move')),
  constraint chk_ashby_operations_key check (length(operation_key) between 1 and 256),
  constraint chk_ashby_operations_state check (state in ('pending','running','succeeded','failed','blocked','cancelled')),
  constraint chk_ashby_operations_attempts check (attempts >= 0),
  constraint chk_ashby_operations_max_attempts check (max_attempts between 1 and 20),
  constraint chk_ashby_operations_error_code check (error_code is null or error_code ~ '^[a-z0-9_.:-]{1,64}$'),
  constraint chk_ashby_operations_error_detail check (error_detail is null or length(error_detail) <= 200),
  constraint chk_ashby_operations_no_self_dep check (depends_on_operation_id is null or depends_on_operation_id <> id)
);

comment on table screening_v2.ashby_operations is
  'Delivery + external-operation outbox (invite_delivery / scorecard_write / '
  'stage_move) with a deterministic unique (provider, operation_key). '
  'depends_on_operation_id models scorecard-before-stage: a stage_move cannot '
  'run or succeed until its dependency (scorecard_write) succeeds (trigger). '
  'Operations for a terminal application link are rejected. Errors are '
  'sanitized stable codes only — never provider bodies, tokens, or PII.';

create index if not exists idx_ashby_operations_runnable
  on screening_v2.ashby_operations (provider, state, scheduled_at) where state = 'pending';
create index if not exists idx_ashby_operations_link
  on screening_v2.ashby_operations (application_link_id, operation_type);
create index if not exists idx_ashby_operations_depends
  on screening_v2.ashby_operations (depends_on_operation_id);

-- Reject creating any operation for a TERMINAL application link.
create or replace function screening_v2.enforce_ashby_operation_not_terminal()
returns trigger
language plpgsql
security invoker
set search_path = pg_catalog
as $$
declare
  v_terminal text;
begin
  select terminal_state into v_terminal
    from screening_v2.ashby_application_links
   where id = new.application_link_id;
  if v_terminal is not null then
    raise exception 'cannot create ashby operation for terminal application link (%)', v_terminal
      using errcode = 'P0001';
  end if;
  return new;
end;
$$;

drop trigger if exists trg_ashby_operation_not_terminal
  on screening_v2.ashby_operations;
create trigger trg_ashby_operation_not_terminal
  before insert on screening_v2.ashby_operations
  for each row
  execute function screening_v2.enforce_ashby_operation_not_terminal();

comment on function screening_v2.enforce_ashby_operation_not_terminal is
  'Blocks INSERT of any ashby_operations row whose application link is in a '
  'terminal state (withdrawn/deleted/manual_stage_cancel) — no further '
  'delivery/write-back once the recruiter has ended the workflow.';

-- Enforce scorecard-before-stage: a stage_move (or any op with a dependency)
-- cannot transition to running/succeeded until its dependency has succeeded.
create or replace function screening_v2.enforce_ashby_operation_dependency()
returns trigger
language plpgsql
security invoker
set search_path = pg_catalog
as $$
declare
  v_dep_state text;
begin
  if new.state in ('running','succeeded')
     and new.depends_on_operation_id is not null then
    select state into v_dep_state
      from screening_v2.ashby_operations
     where id = new.depends_on_operation_id;
    if v_dep_state is distinct from 'succeeded' then
      raise exception 'ashby operation cannot become % before its prerequisite succeeds (dependency=%)',
        new.state, coalesce(v_dep_state, 'missing')
        using errcode = 'P0001';
    end if;
  end if;
  return new;
end;
$$;

drop trigger if exists trg_ashby_operation_dependency
  on screening_v2.ashby_operations;
create trigger trg_ashby_operation_dependency
  before update on screening_v2.ashby_operations
  for each row
  execute function screening_v2.enforce_ashby_operation_dependency();

comment on function screening_v2.enforce_ashby_operation_dependency is
  'Enforces dependency ordering (scorecard-before-stage): an operation with a '
  'dependency cannot become running/succeeded until the dependency operation '
  'has succeeded.';

alter table screening_v2.ashby_operations enable row level security;
revoke all on screening_v2.ashby_operations from anon, authenticated, public;
grant all privileges on screening_v2.ashby_operations to service_role;

-- ═══════════════════════════════════════════════════════════════════════
-- 6. audit_events action-CHECK evolution (additive, 0029)
--    Adds the two Ashby mapping-administration actions to the exact 0016
--    allowlist (sanctioned replaceable data-guard evolution).
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
      -- Ashby Wave 2 (0029, additive): mapping-administration audits.
      'ashby_mapping_update', 'ashby_mapping_drift'
    )
  )
  not valid;
alter table screening_v2.audit_events
  validate constraint chk_audit_action;

comment on constraint chk_audit_action on screening_v2.audit_events is
  'Audit action allowlist — extended additively by 0029 with the Ashby '
  'mapping-administration actions (ashby_mapping_update, ashby_mapping_drift). '
  'Metadata for these actions carries only opaque IDs/mode/status — never PII.';

-- ═══════════════════════════════════════════════════════════════════════
-- 7. Service-role-only SECURITY DEFINER RPCs (fixed search_path)
-- ═══════════════════════════════════════════════════════════════════════

-- ───────────────────────────────────────────────────────────────────────
-- 7a. upsert_ashby_job_mapping — race-safe admin create/update with an
--     audited quota_override-style mapping_update event in ONE transaction.
--     Validation is defensive (fail closed): delivery mode, fixed 24h TTL,
--     completeness-for-enable, and a refusal to ENABLE a drifted mapping.
-- ───────────────────────────────────────────────────────────────────────

create or replace function screening_v2.upsert_ashby_job_mapping(
  p_mapping_id            uuid,
  p_external_job_id       text,
  p_role_id               uuid,
  p_ai_screening_stage_id text,
  p_ta_screening_stage_id text,
  p_feedback_form_id      text,
  p_interview_id          text,
  p_attribution_user_id   text,
  p_owner_id              uuid,
  p_delivery_mode         text,
  p_invite_ttl_hours      integer,
  p_status                text,
  p_label                 text,
  p_actor_id              uuid
)
returns jsonb
language plpgsql
security definer
set search_path = pg_catalog, screening_v2
as $$
declare
  v_id uuid;
  v_created boolean := false;
  v_current screening_v2.ashby_job_mappings%rowtype;
  v_ttl integer := coalesce(p_invite_ttl_hours, 24);
  v_status text := lower(coalesce(p_status, 'paused'));
  v_ai text := p_ai_screening_stage_id;
  v_ta text := p_ta_screening_stage_id;
begin
  if p_actor_id is null then
    return jsonb_build_object('status', 'actor_required');
  end if;
  if p_owner_id is null then
    return jsonb_build_object('status', 'owner_required');
  end if;
  if p_role_id is null then
    return jsonb_build_object('status', 'role_required');
  end if;
  if p_external_job_id is null or length(p_external_job_id) < 1 or length(p_external_job_id) > 256 then
    return jsonb_build_object('status', 'invalid_external_job_id');
  end if;
  if coalesce(p_delivery_mode, 'manual') not in ('email','manual','both') then
    return jsonb_build_object('status', 'invalid_delivery_mode');
  end if;
  if v_ttl <> 24 then
    return jsonb_build_object('status', 'invalid_invite_ttl');   -- Phase 1: 24h only
  end if;
  if v_status not in ('paused','enabled') then
    -- Drift is set only by mark_ashby_mapping_drift, never via upsert.
    return jsonb_build_object('status', 'invalid_status');
  end if;
  if p_label is not null and length(p_label) > 120 then
    return jsonb_build_object('status', 'invalid_label');
  end if;

  -- Lock the existing row (if any) so concurrent upserts serialise.
  if p_mapping_id is not null then
    select * into v_current
      from screening_v2.ashby_job_mappings
     where id = p_mapping_id
     for update;
    if not found then
      return jsonb_build_object('status', 'not_found');
    end if;
    -- Preserve unspecified stage IDs on update (coalesce to current).
    v_ai := coalesce(v_ai, v_current.ai_screening_stage_id);
    v_ta := coalesce(v_ta, v_current.ta_screening_stage_id);
  end if;

  -- Completeness gate for ENABLE (defense in depth beyond the CHECK).
  if v_status = 'enabled' and (v_ai is null or v_ta is null) then
    return jsonb_build_object('status', 'incomplete_cannot_enable');
  end if;
  -- A drifted mapping must be repaired (its drift cleared to 'paused') before
  -- it can be enabled again; refuse to enable straight from drift.
  if v_status = 'enabled' and p_mapping_id is not null and v_current.status = 'drift' then
    return jsonb_build_object('status', 'drifted_cannot_enable');
  end if;

  if p_mapping_id is not null then
    update screening_v2.ashby_job_mappings set
      external_job_id = p_external_job_id,
      role_id = p_role_id,
      ai_screening_stage_id = v_ai,
      ta_screening_stage_id = v_ta,
      feedback_form_id = p_feedback_form_id,
      interview_id = p_interview_id,
      attribution_user_id = p_attribution_user_id,
      owner_id = p_owner_id,
      delivery_mode = coalesce(p_delivery_mode, 'manual'),
      invite_ttl_hours = 24,
      status = v_status,
      status_reason = case when v_status = 'enabled' then null else v_current.status_reason end,
      label = p_label,
      config_version = v_current.config_version + 1,
      updated_at = now()
    where id = p_mapping_id
    returning id into v_id;
  else
    insert into screening_v2.ashby_job_mappings (
      provider, external_job_id, role_id, ai_screening_stage_id, ta_screening_stage_id,
      feedback_form_id, interview_id, attribution_user_id, owner_id, delivery_mode,
      invite_ttl_hours, status, label
    ) values (
      'ashby', p_external_job_id, p_role_id, v_ai, v_ta,
      p_feedback_form_id, p_interview_id, p_attribution_user_id, p_owner_id,
      coalesce(p_delivery_mode, 'manual'), 24, v_status, p_label
    )
    returning id into v_id;
    v_created := true;
  end if;

  insert into screening_v2.audit_events
    (actor_id, actor_type, action, target_type, target_id, result, metadata)
  values
    (p_actor_id, 'recruiter', 'ashby_mapping_update', 'ashby_job_mapping', v_id::text,
     'success',
     jsonb_build_object('mapping_id', v_id, 'status', v_status,
                        'delivery_mode', coalesce(p_delivery_mode, 'manual'),
                        'created', v_created));

  return jsonb_build_object('status', 'ok', 'id', v_id, 'created', v_created);
end;
$$;

revoke all on function screening_v2.upsert_ashby_job_mapping(uuid, text, uuid, text, text, text, text, text, uuid, text, integer, text, text, uuid)
  from public, anon, authenticated;
grant execute on function screening_v2.upsert_ashby_job_mapping(uuid, text, uuid, text, text, text, text, text, uuid, text, integer, text, text, uuid)
  to service_role;

comment on function screening_v2.upsert_ashby_job_mapping is
  'Race-safe admin create/update of an Ashby job mapping with an '
  'ashby_mapping_update audit row in the same transaction. Fails closed on '
  'invalid delivery mode, non-24h TTL, or enabling an incomplete/drifted '
  'mapping. Drift status is never set here (see mark_ashby_mapping_drift). '
  'Service-role-only.';

-- ───────────────────────────────────────────────────────────────────────
-- 7b. mark_ashby_mapping_drift — auto-pause a mapping whose tenant IDs no
--     longer validate. Idempotent; sets status='drift' + sanitized reason;
--     audited. Fails closed (a drifted mapping is not 'enabled').
-- ───────────────────────────────────────────────────────────────────────

create or replace function screening_v2.mark_ashby_mapping_drift(
  p_mapping_id uuid,
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
  if p_reason is null or length(p_reason) < 1 or length(p_reason) > 200 then
    return jsonb_build_object('status', 'invalid_reason');
  end if;

  select * into v_current
    from screening_v2.ashby_job_mappings
   where id = p_mapping_id
   for update;
  if not found then
    return jsonb_build_object('status', 'not_found');
  end if;

  if v_current.status = 'drift' then
    return jsonb_build_object('status', 'already_drift');   -- idempotent
  end if;

  update screening_v2.ashby_job_mappings
     set status = 'drift', status_reason = p_reason, updated_at = now()
   where id = p_mapping_id;

  insert into screening_v2.audit_events
    (actor_id, actor_type, action, target_type, target_id, result, metadata)
  values
    (p_actor_id, 'system', 'ashby_mapping_drift', 'ashby_job_mapping', p_mapping_id::text,
     'success', jsonb_build_object('mapping_id', p_mapping_id, 'reason', p_reason));

  return jsonb_build_object('status', 'ok');
end;
$$;

revoke all on function screening_v2.mark_ashby_mapping_drift(uuid, text, uuid)
  from public, anon, authenticated;
grant execute on function screening_v2.mark_ashby_mapping_drift(uuid, text, uuid)
  to service_role;

comment on function screening_v2.mark_ashby_mapping_drift is
  'Auto-pauses a mapping by setting status=drift + sanitized reason and '
  'writing an ashby_mapping_drift audit row (same transaction). Idempotent. '
  'A drifted mapping is not enabled, so processing fails closed. '
  'Service-role-only.';

-- ═══════════════════════════════════════════════════════════════════════
-- Verifier: schema reload notification
-- ═══════════════════════════════════════════════════════════════════════

notify pgrst, 'reload schema';
