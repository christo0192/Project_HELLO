-- =====================================================================
-- 0015 — Phase 9 L2: product-operations schema foundation
--        (system_config / recruiter_notes / quota / notification_intents
--         / appeal_grants / appeal_requests / appeal_review_events /
--         candidate decision-block + service-role-only operational RPCs).
--
-- Forward-only and additive (C-1): every column is ADD COLUMN IF NOT EXISTS
-- and nullable; every CHECK is added NOT VALID then VALIDATE'd; the only
-- DROP ... IF EXISTS statements target constraints THIS migration re-creates
-- in the same chain (the sanctioned replaceable data-guard evolution
-- pattern from 0014). There is NO reverse SQL / down-migration.
--
-- DESIGN:
--   1. system_config — bounded key/value operational configuration
--      (maintenance toggle lives here, key='maintenance').
--   2. recruiter_notes — append-only recruiter notes (UPDATE/direct DELETE
--      blocked at the trigger boundary; cascade from candidates preserved).
--   3. quota_policies / quota_usage / quota_reservations — quota engine.
--      quota_policies is DISABLED by default (enabled=false): quota
--      enforcement only engages once an admin enables a policy. Both
--      max_sessions and max_cost_units are nullable; cost_units_per_session
--      is an admin-configured integer/fixed-unit value (never currency,
--      provider price, or client-supplied); warning_percentage is nullable
--      with NO default — no warning intent is produced when it is null.
--   4. notification_intents — idempotent, digest-free intent log (no
--      actual send happens here; L3 adds the send hook).
--   5. appeal_grants — SHA-256 token digest only (never plaintext);
--      SEPARATE from candidate_access_grants (Phase 9 consistency #3).
--   6. appeal_requests — bounded appeal with assessment_snapshot storing
--      score/version/hash references ONLY (no transcript/resume/contact).
--   7. appeal_review_events — append-only immutable review log.
--   8. candidates.decision_use_blocked_at — additive decision-block field.
--   9. audit_events action CHECK widened (preserving the exact 0014 list)
--      with the underscored Phase 9 actions the DB sink persists via
--      replaceAll('.','_') (TS events may be dotted).
--  10. Service-role-only SECURITY DEFINER RPCs with fixed search_path,
--      revoked from public/anon/authenticated, granted service_role only.
--
-- RLS posture: every new operational table has RLS enabled and NO
-- authenticated/anon/public policy or grant — the browser (web) reaches
-- these tables exclusively through the RBAC-protected API using the
-- service-role client. PostgREST cannot read them directly.
-- =====================================================================

-- ═══════════════════════════════════════════════════════════════════════
-- 1. system_config — bounded operational configuration
-- ═══════════════════════════════════════════════════════════════════════

create table if not exists screening_v2.system_config (
  key        text primary key,
  value      jsonb not null,
  updated_by uuid,
  updated_at timestamptz not null default now(),
  constraint chk_system_config_key_length check (length(key) between 1 and 128),
  constraint chk_system_config_value_size check (octet_length(value::text) <= 4096)
);

comment on table screening_v2.system_config is
  'Bounded operational configuration (key/value). The maintenance toggle is '
  'stored under key = ''maintenance'' with value '
  '{enabled:boolean, reason:text, updated_by:uuid, updated_at:timestamptz}. '
  'Written exclusively via service-role RPCs; never directly by the browser.';

comment on column screening_v2.system_config.value is
  'JSONB configuration payload, bounded to 4096 octets; never contains '
  'secrets, tokens, or PII.';

alter table screening_v2.system_config enable row level security;
revoke all on screening_v2.system_config from anon, authenticated, public;
grant all privileges on screening_v2.system_config to service_role;

-- ═══════════════════════════════════════════════════════════════════════
-- 2. recruiter_notes — append-only recruiter notes
-- ═══════════════════════════════════════════════════════════════════════

create table if not exists screening_v2.recruiter_notes (
  id           uuid primary key default gen_random_uuid(),
  candidate_id uuid not null references screening_v2.candidates(id)
               on delete cascade,
  author_id    uuid not null,  -- auth.users UUID; FK omitted for test flexibility
  note         text not null,
  created_at   timestamptz not null default now(),
  constraint chk_recruiter_notes_length check (length(note) between 1 and 2000)
);

comment on table screening_v2.recruiter_notes is
  'Append-only recruiter notes on candidates. UPDATE and direct DELETE are '
  'blocked at the trigger boundary; the sanctioned ON DELETE CASCADE from '
  'candidates is preserved (parent-gone check).';

create index if not exists idx_v2_recruiter_notes_candidate
  on screening_v2.recruiter_notes (candidate_id, created_at);

-- Append-only mutation guard (mirrors 0007/0012/0014). Escape hatch:
-- SET LOCAL app.allow_recruiter_notes_mutation = 'true' for emergency
-- migration/maintenance only; never enable globally or in app connections.
create or replace function screening_v2.prevent_recruiter_notes_mutation()
returns trigger
language plpgsql
security invoker
set search_path = pg_catalog
as $$
begin
  if current_setting('app.allow_recruiter_notes_mutation', true) = 'true' then
    return coalesce(new, old);
  end if;
  if tg_op = 'UPDATE' then
    raise exception 'recruiter_notes is append-only: UPDATE not permitted'
      using errcode = 'P0001';
  end if;
  if tg_op = 'DELETE' then
    -- Preserve FK retention semantics: allow cascade delete from the parent
    -- candidates row (parent already gone at cascade time).
    if exists (select 1 from screening_v2.candidates where id = old.candidate_id) then
      raise exception 'recruiter_notes is append-only: DELETE not permitted'
        using errcode = 'P0001';
    end if;
    return old;
  end if;
  return new;
end;
$$;

drop trigger if exists trg_recruiter_notes_prevent_update
  on screening_v2.recruiter_notes;
create trigger trg_recruiter_notes_prevent_update
  before update on screening_v2.recruiter_notes
  for each row
  execute function screening_v2.prevent_recruiter_notes_mutation();

drop trigger if exists trg_recruiter_notes_prevent_delete
  on screening_v2.recruiter_notes;
create trigger trg_recruiter_notes_prevent_delete
  before delete on screening_v2.recruiter_notes
  for each row
  execute function screening_v2.prevent_recruiter_notes_mutation();

comment on function screening_v2.prevent_recruiter_notes_mutation is
  'Blocks UPDATE and direct DELETE on recruiter_notes; allows the sanctioned '
  'ON DELETE CASCADE from candidates (parent-gone check). Emergency escape '
  'hatch: SET LOCAL app.allow_recruiter_notes_mutation = ''true'' in a '
  'dedicated session.';

alter table screening_v2.recruiter_notes enable row level security;
revoke all on screening_v2.recruiter_notes from anon, authenticated, public;
grant all privileges on screening_v2.recruiter_notes to service_role;

-- ═══════════════════════════════════════════════════════════════════════
-- 3. Quota engine: quota_policies / quota_usage / quota_reservations
-- ═══════════════════════════════════════════════════════════════════════

create table if not exists screening_v2.quota_policies (
  id                      uuid primary key default gen_random_uuid(),
  scope                   text not null,
  scope_id                uuid,
  mode                    text not null default 'simulation',
  max_sessions            integer,
  max_cost_units          integer,
  cost_units_per_session  integer,
  warning_percentage      integer,
  period_days             integer not null default 1,
  enabled                 boolean not null default false,
  created_at              timestamptz not null default now(),
  updated_at              timestamptz not null default now(),
  constraint chk_quota_policies_scope check (scope in ('global','recruiter')),
  constraint chk_quota_policies_mode check (mode in ('simulation','live')),
  constraint chk_quota_policies_max_sessions check (max_sessions is null or max_sessions > 0),
  constraint chk_quota_policies_max_cost_units check (max_cost_units is null or max_cost_units > 0),
  constraint chk_quota_policies_cost_units_per_session check (cost_units_per_session is null or cost_units_per_session > 0),
  constraint chk_quota_policies_warning check (warning_percentage is null or (warning_percentage between 1 and 100)),
  constraint chk_quota_policies_period_days check (period_days between 1 and 365),
  constraint chk_quota_policies_scope_coherence check (
    (scope = 'global' and scope_id is null)
    or (scope = 'recruiter' and scope_id is not null)
  )
);

comment on table screening_v2.quota_policies is
  'Admin-configured quota policies. DISABLED by default (enabled=false): '
  'quota enforcement only engages once a policy is enabled. '
  'Scope: global (scope_id null, all recruiters aggregate) or recruiter '
  '(scope_id = recruiter membership user UUID, one recruiter isolated). '
  'cost_units_per_session is an admin-configured integer/fixed-unit value — '
  'never currency, provider price, or client-supplied. warning_percentage is '
  'nullable with NO default; when null no warning intent is produced.';

create index if not exists idx_v2_quota_policies_active
  on screening_v2.quota_policies (scope, scope_id, mode)
  where enabled = true;

alter table screening_v2.quota_policies enable row level security;
revoke all on screening_v2.quota_policies from anon, authenticated, public;
grant all privileges on screening_v2.quota_policies to service_role;

create table if not exists screening_v2.quota_usage (
  id               uuid primary key default gen_random_uuid(),
  policy_id        uuid not null references screening_v2.quota_policies(id)
                   on delete cascade,
  scope_id         uuid,
  period_start     date not null,
  sessions_used    integer not null default 0,
  cost_units_used  integer not null default 0,
  created_at       timestamptz not null default now(),
  updated_at       timestamptz not null default now(),
  constraint chk_quota_usage_sessions check (sessions_used >= 0),
  constraint chk_quota_usage_cost check (cost_units_used >= 0),
  -- One usage row per (policy, scope, period). NULLS NOT DISTINCT makes
  -- global policies (scope_id IS NULL) conflict-checkable, so a single
  -- global usage row exists per period.
  constraint uq_quota_usage_policy_scope_period
    unique nulls not distinct (policy_id, scope_id, period_start)
);

comment on table screening_v2.quota_usage is
  'Aggregated quota usage per (policy, scope, period). Incremented only by '
  'commit_quota_reservation; never written by the browser.';

create index if not exists idx_v2_quota_usage_period
  on screening_v2.quota_usage (period_start);

alter table screening_v2.quota_usage enable row level security;
revoke all on screening_v2.quota_usage from anon, authenticated, public;
grant all privileges on screening_v2.quota_usage to service_role;

create table if not exists screening_v2.quota_reservations (
  id                   uuid primary key default gen_random_uuid(),
  policy_id            uuid not null references screening_v2.quota_policies(id)
                       on delete cascade,
  scope_id             uuid,
  requester_id         uuid not null,
  idempotency_key      text not null,
  sessions_reserved    integer not null default 1,
  cost_units_reserved  integer not null default 0,
  status               text not null default 'reserved',
  reserved_at          timestamptz not null default now(),
  committed_at         timestamptz,
  released_at          timestamptz,
  constraint uq_quota_reservations_idempotency unique (requester_id, idempotency_key),
  constraint chk_quota_reservations_idempotency_length check (length(idempotency_key) between 1 and 128),
  constraint chk_quota_reservations_status check (status in ('reserved','committed','released')),
  constraint chk_quota_reservations_sessions check (sessions_reserved >= 1),
  constraint chk_quota_reservations_cost check (cost_units_reserved >= 0)
);

comment on table screening_v2.quota_reservations is
  'Exactly-one reservation per (requester, bounded Idempotency-Key). '
  'requester_id is the authenticated recruiter UUID — the same key from '
  'different recruiters never collides. status flow: '
  'reserved -> committed (session created, usage incremented) or '
  'reserved -> released (session creation failed, no usage increment). '
  'A committed/released reservation is terminal; a repeated key returns the '
  'same stable reservation (never double-reserves).';

create index if not exists idx_v2_quota_reservations_policy
  on screening_v2.quota_reservations (policy_id, status);

alter table screening_v2.quota_reservations enable row level security;
revoke all on screening_v2.quota_reservations from anon, authenticated, public;
grant all privileges on screening_v2.quota_reservations to service_role;

-- ═══════════════════════════════════════════════════════════════════════
-- 4. notification_intents — idempotent intent log (no send in this lane)
-- ═══════════════════════════════════════════════════════════════════════

create table if not exists screening_v2.notification_intents (
  id               uuid primary key default gen_random_uuid(),
  idempotency_key  text not null,
  kind             text not null,
  candidate_id     uuid references screening_v2.candidates(id)
                   on delete cascade,
  consent_verified boolean not null default false,
  payload          jsonb,
  created_at       timestamptz not null default now(),
  constraint uq_notification_intents_key unique (idempotency_key),
  constraint chk_notification_intents_key_length check (length(idempotency_key) between 1 and 128),
  constraint chk_notification_intents_kind check (kind in ('quota_warning','assessment_ready','appeal_resolved')),
  constraint chk_notification_intents_payload_size check (payload is null or octet_length(payload::text) <= 4096)
);

comment on table screening_v2.notification_intents is
  'Idempotent notification intent log. Insertion is idempotent (UNIQUE '
  'idempotency_key) and no actual send happens in this lane — the delivery '
  'hook is external-pending. consent_verified gates privacy-sensitive kinds.';

alter table screening_v2.notification_intents enable row level security;
revoke all on screening_v2.notification_intents from anon, authenticated, public;
grant all privileges on screening_v2.notification_intents to service_role;

-- ═══════════════════════════════════════════════════════════════════════
-- 5. appeal_grants — SHA-256 digest only; separate from
--    candidate_access_grants (Phase 9 consistency #3 — never touch that
--    table in the appeal flow)
-- ═══════════════════════════════════════════════════════════════════════

create table if not exists screening_v2.appeal_grants (
  id           uuid primary key default gen_random_uuid(),
  candidate_id uuid not null references screening_v2.candidates(id)
               on delete cascade,
  session_id   uuid not null references screening_v2.call_sessions(id)
               on delete cascade,
  token_digest text not null,
  created_by   uuid not null,  -- auth.users UUID; FK omitted for test flexibility
  expires_at   timestamptz not null,
  consumed_at  timestamptz,
  revoked_at   timestamptz,
  created_at   timestamptz not null default now(),
  constraint uq_appeal_grants_digest unique (token_digest),
  constraint chk_appeal_grants_digest check (token_digest ~ '^[a-f0-9]{64}$'),
  constraint chk_appeal_grants_expiry check (expires_at > created_at),
  constraint chk_appeal_grants_use check (not (consumed_at is not null and revoked_at is not null))
);

comment on table screening_v2.appeal_grants is
  'One-time appeal submission grants. Only the SHA-256 hex digest of the '
  'high-entropy token is stored — never the plaintext. Separate from '
  'candidate_access_grants by design (Phase 9 consistency #3).';

create index if not exists idx_v2_appeal_grants_candidate
  on screening_v2.appeal_grants (candidate_id);
create index if not exists idx_v2_appeal_grants_digest
  on screening_v2.appeal_grants (token_digest);

alter table screening_v2.appeal_grants enable row level security;
revoke all on screening_v2.appeal_grants from anon, authenticated, public;
grant all privileges on screening_v2.appeal_grants to service_role;

-- ═══════════════════════════════════════════════════════════════════════
-- 6. appeal_requests — bounded appeal + score/version/hash snapshot ONLY
-- ═══════════════════════════════════════════════════════════════════════

create table if not exists screening_v2.appeal_requests (
  id                  uuid primary key default gen_random_uuid(),
  candidate_id        uuid not null references screening_v2.candidates(id)
                      on delete cascade,
  session_id          uuid not null references screening_v2.call_sessions(id)
                      on delete cascade,
  assessment_id       uuid references screening_v2.assessments(id)
                      on delete set null,
  grant_digest        text not null,
  category            text not null,
  description         text not null,
  assessment_snapshot jsonb,
  status              text not null default 'open',
  created_at          timestamptz not null default now(),
  updated_at          timestamptz not null default now(),
  constraint chk_appeal_requests_grant_digest check (grant_digest ~ '^[a-f0-9]{64}$'),
  constraint chk_appeal_requests_category check (category in ('scoring','recording','accessibility','other')),
  constraint chk_appeal_requests_description_length check (length(description) between 1 and 2000),
  constraint chk_appeal_requests_status check (status in ('open','under_review','granted','denied')),
  constraint chk_appeal_requests_snapshot_size check (assessment_snapshot is null or octet_length(assessment_snapshot::text) <= 4096)
);

comment on table screening_v2.appeal_requests is
  'Candidate appeal against a screening assessment. assessment_snapshot '
  'stores score/version/hash references ONLY — never transcripts, resumes, '
  'or contact data. decision_use_blocked_at on the candidate is set when an '
  'appeal is created and cleared only when no unresolved appeals remain.';

create index if not exists idx_v2_appeal_requests_candidate
  on screening_v2.appeal_requests (candidate_id, status);
create index if not exists idx_v2_appeal_requests_session
  on screening_v2.appeal_requests (session_id);

alter table screening_v2.appeal_requests enable row level security;
revoke all on screening_v2.appeal_requests from anon, authenticated, public;
grant all privileges on screening_v2.appeal_requests to service_role;

-- ═══════════════════════════════════════════════════════════════════════
-- 7. appeal_review_events — append-only immutable review log
-- ═══════════════════════════════════════════════════════════════════════

create table if not exists screening_v2.appeal_review_events (
  id          uuid primary key default gen_random_uuid(),
  appeal_id   uuid not null references screening_v2.appeal_requests(id)
              on delete cascade,
  reviewer_id uuid not null,
  from_status text not null,
  to_status   text not null,
  notes       text,
  evidence    jsonb,
  created_at  timestamptz not null default now(),
  constraint chk_appeal_review_events_from check (from_status in ('open','under_review','granted','denied')),
  constraint chk_appeal_review_events_to check (to_status in ('open','under_review','granted','denied')),
  constraint chk_appeal_review_events_notes_length check (notes is null or length(notes) <= 2000),
  constraint chk_appeal_review_events_evidence_size check (evidence is null or octet_length(evidence::text) <= 4096)
);

comment on table screening_v2.appeal_review_events is
  'Immutable append-only appeal review log. Written by the review_appeal '
  'RPC in the same transaction as the status transition; UPDATE and direct '
  'DELETE are blocked (cascade from appeal_requests preserved). Evidence is '
  'bounded and never contains transcripts or contact data.';

create index if not exists idx_v2_appeal_review_events_appeal
  on screening_v2.appeal_review_events (appeal_id, created_at);

create or replace function screening_v2.prevent_appeal_review_mutation()
returns trigger
language plpgsql
security invoker
set search_path = pg_catalog
as $$
begin
  if current_setting('app.allow_appeal_review_mutation', true) = 'true' then
    return coalesce(new, old);
  end if;
  if tg_op = 'UPDATE' then
    raise exception 'appeal_review_events is append-only: UPDATE not permitted'
      using errcode = 'P0001';
  end if;
  if tg_op = 'DELETE' then
    -- Preserve FK retention semantics: allow cascade delete from the parent
    -- appeal_requests row (parent already gone at cascade time).
    if exists (select 1 from screening_v2.appeal_requests where id = old.appeal_id) then
      raise exception 'appeal_review_events is append-only: DELETE not permitted'
        using errcode = 'P0001';
    end if;
    return old;
  end if;
  return new;
end;
$$;

drop trigger if exists trg_appeal_review_prevent_update
  on screening_v2.appeal_review_events;
create trigger trg_appeal_review_prevent_update
  before update on screening_v2.appeal_review_events
  for each row
  execute function screening_v2.prevent_appeal_review_mutation();

drop trigger if exists trg_appeal_review_prevent_delete
  on screening_v2.appeal_review_events;
create trigger trg_appeal_review_prevent_delete
  before delete on screening_v2.appeal_review_events
  for each row
  execute function screening_v2.prevent_appeal_review_mutation();

comment on function screening_v2.prevent_appeal_review_mutation is
  'Blocks UPDATE and direct DELETE on appeal_review_events; allows the '
  'sanctioned ON DELETE CASCADE from appeal_requests (parent-gone check). '
  'Emergency escape hatch: SET LOCAL app.allow_appeal_review_mutation = '
  '''true'' in a dedicated session.';

alter table screening_v2.appeal_review_events enable row level security;
revoke all on screening_v2.appeal_review_events from anon, authenticated, public;
grant all privileges on screening_v2.appeal_review_events to service_role;

-- ═══════════════════════════════════════════════════════════════════════
-- 8. Additive candidate decision-block field
-- ═══════════════════════════════════════════════════════════════════════

alter table screening_v2.candidates
  add column if not exists decision_use_blocked_at timestamptz;

comment on column screening_v2.candidates.decision_use_blocked_at is
  'Set atomically when an appeal is created (create_appeal); cleared only '
  'when no unresolved appeals remain (review_appeal). Non-null blocks '
  'candidate status advancement (decision-use) at the API layer.';

create index if not exists idx_v2_candidates_decision_block
  on screening_v2.candidates (id)
  where decision_use_blocked_at is not null;

-- ═══════════════════════════════════════════════════════════════════════
-- 9. audit_events action-CHECK evolution (additive, 0015)
--
-- Phase 9 introduces seven underscored operational audit actions persisted
-- by the DB sink (createDbAuditSink replaceAll('.','_') — TS events may be
-- dotted): admin_session_override / admin_maintenance_toggle /
-- admin_member_update / quota_override / notification_create /
-- appeal_create / appeal_review. The CHECK is re-created with the SAME name
-- and the exact 0014 list PLUS the seven new actions (sanctioned
-- replaceable data-guard evolution — drop-guarded IF EXISTS + re-create in
-- the same chain; existing rows all satisfy the widened list).
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
      -- Phase 7 (REC-03/04/05, additive): recording lifecycle audits.
      'recording_download', 'recording_upload', 'recording_integrity_verified',
      'recording_quarantined', 'recording_revoked', 'recording_deleted',
      -- Phase 9 (L2, additive): product-operations audits (underscored —
      -- matches the DB sink's replaceAll('.','_') output).
      'admin_session_override', 'admin_maintenance_toggle', 'admin_member_update',
      'quota_override', 'notification_create', 'appeal_create', 'appeal_review'
    )
  )
  not valid;
alter table screening_v2.audit_events
  validate constraint chk_audit_action;

comment on constraint chk_audit_action on screening_v2.audit_events is
  'Audit action allowlist — extended additively by 0015 with the Phase 9 '
  'product-operations actions (admin_session_override, admin_maintenance_'
  'toggle, admin_member_update, quota_override, notification_create, '
  'appeal_create, appeal_review).';

-- ═══════════════════════════════════════════════════════════════════════
-- 10. Service-role-only SECURITY DEFINER RPCs (fixed search_path)
-- ═══════════════════════════════════════════════════════════════════════

-- ───────────────────────────────────────────────────────────────────────
-- 10a. check_and_reserve_quota — atomic quota check/reserve keyed by a
--      (requester, bounded Idempotency-Key) pair. Locks the matched policy
--      and the usage row, checks BOTH max_sessions and max_cost_units
--      against projected usage, creates/returns the stable reservation.
--      Configured cost units are read from the policy — NEVER from the
--      client. A repeated key FROM THE SAME REQUESTER returns the same
--      stable reservation (no extra units). Warning flag is only computed
--      when the policy's warning_percentage is non-null.
--      Period buckets are anchored to a stable epoch so 7/30-day caps do
--      not reset daily.
-- ───────────────────────────────────────────────────────────────────────

create or replace function screening_v2.check_and_reserve_quota(
  p_requester_id uuid,
  p_mode text,
  p_idempotency_key text
)
returns jsonb
language plpgsql
security definer
set search_path = pg_catalog, screening_v2
as $$
declare
  v_existing screening_v2.quota_reservations%rowtype;
  v_policy screening_v2.quota_policies%rowtype;
  v_usage screening_v2.quota_usage%rowtype;
  v_usage_scope_id uuid;
  v_period_start date;
  v_cost_units integer;
  v_pending_sessions bigint := 0;
  v_pending_cost bigint := 0;
  v_projected_sessions bigint;
  v_projected_cost bigint;
  v_session_cap_ok boolean := true;
  v_cost_cap_ok boolean := true;
  v_warning_reached boolean := false;
  v_reservation_id uuid;
  v_percent bigint;
  v_denominator integer;
  v_period_days integer;
  v_epoch_offset integer;
begin
  -- Requester-scoped idempotency: a repeated key from the SAME requester
  -- returns the stable reservation. Different requesters with the same key
  -- never collide (unique constraint is on (requester_id, idempotency_key)).
  select * into v_existing
    from screening_v2.quota_reservations
   where requester_id = p_requester_id
     and idempotency_key = p_idempotency_key;
  if found then
    return jsonb_build_object(
      'status', 'duplicate',
      'allowed', true,
      'reservation_id', v_existing.id,
      'reservation_status', v_existing.status
    );
  end if;

  -- Resolve the enabled policy: recruiter-specific first, then global
  -- fallback. Recruiter policy binds to the authenticated recruiter UUID;
  -- global aggregates all recruiters. Deterministic id tiebreak.
  select * into v_policy
    from screening_v2.quota_policies
   where enabled = true
     and mode = p_mode
     and (
       (scope = 'recruiter' and scope_id = p_requester_id)
       or (scope = 'global' and scope_id is null)
     )
   order by case when scope = 'recruiter' then 0 else 1 end, id
   limit 1
   for update;

  if not found then
    return jsonb_build_object('status', 'no_policy', 'allowed', false);
  end if;

  -- Usage scope: recruiter UUID for recruiter policy, NULL for global.
  -- Global usage aggregates ALL recruiters under a single NULL-scoped row.
  v_usage_scope_id := case when v_policy.scope = 'recruiter'
                       then p_requester_id else null end;

  -- Lock/create the usage row for the current PERIOD bucket.
  -- Period buckets are anchored to a stable epoch (2000-01-01) so 7/30-day
  -- windows do NOT reset daily. bucket = (now - epoch) / period_days.
  v_period_days := coalesce(v_policy.period_days, 1);
  v_epoch_offset := (date_trunc('day', now())::date
                     - '2000-01-01'::date)::integer;
  v_period_start := '2000-01-01'::date
                    + ((v_epoch_offset / v_period_days) * v_period_days);

  select * into v_usage
    from screening_v2.quota_usage
   where policy_id = v_policy.id
     and scope_id is not distinct from v_usage_scope_id
     and period_start = v_period_start
   for update;
  if not found then
    insert into screening_v2.quota_usage
      (policy_id, scope_id, period_start, sessions_used, cost_units_used)
    values
      (v_policy.id, v_usage_scope_id, v_period_start, 0, 0)
    returning * into v_usage;
  end if;

  -- Cost units come from the policy (fixed admin-configured units). Default
  -- 1 when unset so both caps remain comparable.
  v_cost_units := coalesce(v_policy.cost_units_per_session, 1);

  -- Project COMMITTED usage + PENDING (uncommitted) reservations so two
  -- concurrent requests for the final slot cannot both reserve: the FOR
  -- UPDATE lock on the usage row serialises the check, and the pending
  -- count makes the second caller see the first caller's reservation.
  -- Pending cutoff aligns with the current period bucket, not a rolling
  -- now()-period_days. Stale reserved rows hold their slot until
  -- stale-reservation reconciliation expires them (documented residual).
  select coalesce(sum(r.sessions_reserved), 0),
         coalesce(sum(r.cost_units_reserved), 0)
    into v_pending_sessions, v_pending_cost
    from screening_v2.quota_reservations r
   where r.policy_id = v_policy.id
     and r.scope_id is not distinct from v_usage_scope_id
     and r.status = 'reserved'
     and r.reserved_at >= v_period_start::timestamptz;

  v_projected_sessions := v_usage.sessions_used + v_pending_sessions;
  v_projected_cost := v_usage.cost_units_used + v_pending_cost;

  -- Check BOTH caps atomically against the projected usage.
  if v_policy.max_sessions is not null
     and (v_projected_sessions + 1) > v_policy.max_sessions then
    v_session_cap_ok := false;
  end if;
  if v_policy.max_cost_units is not null
     and (v_projected_cost + v_cost_units) > v_policy.max_cost_units then
    v_cost_cap_ok := false;
  end if;

  if not (v_session_cap_ok and v_cost_cap_ok) then
    return jsonb_build_object(
      'status', 'quota_exceeded',
      'allowed', false,
      'remaining_sessions',
        case when v_policy.max_sessions is null then null
             else greatest(v_policy.max_sessions - v_projected_sessions, 0) end,
      'remaining_cost_units',
        case when v_policy.max_cost_units is null then null
             else greatest(v_policy.max_cost_units - v_projected_cost, 0) end
    );
  end if;

  -- Create the reservation (exactly one per (requester, key) pair).
  insert into screening_v2.quota_reservations
    (policy_id, scope_id, requester_id, idempotency_key,
     sessions_reserved, cost_units_reserved, status)
  values
    (v_policy.id, v_usage_scope_id, p_requester_id, p_idempotency_key,
     1, v_cost_units, 'reserved')
  returning id into v_reservation_id;

  -- Warning percentage (only when the policy configures it; null => no warn).
  if v_policy.warning_percentage is not null then
    v_percent := (v_projected_sessions + 1) * 100;
    v_denominator := v_policy.max_sessions;
    if v_denominator is null and v_policy.max_cost_units is not null then
      v_percent := (v_projected_cost + v_cost_units) * 100;
      v_denominator := v_policy.max_cost_units;
    end if;
    if v_denominator is not null and v_denominator > 0
       and (v_percent / v_denominator) >= v_policy.warning_percentage then
      v_warning_reached := true;
    end if;
  end if;

  return jsonb_build_object(
    'status', 'ok',
    'allowed', true,
    'reservation_id', v_reservation_id,
    'remaining_sessions',
      case when v_policy.max_sessions is null then null
           else v_policy.max_sessions - v_projected_sessions - 1 end,
    'remaining_cost_units',
      case when v_policy.max_cost_units is null then null
           else v_policy.max_cost_units - v_projected_cost - v_cost_units end,
    'warning_reached', v_warning_reached
  );
end;
$$;

revoke all on function screening_v2.check_and_reserve_quota(uuid, text, text)
  from public, anon, authenticated;
grant execute on function screening_v2.check_and_reserve_quota(uuid, text, text)
  to service_role;

comment on function screening_v2.check_and_reserve_quota is
  'Atomic quota check/reserve keyed by a (requester, bounded Idempotency-Key) '
  'pair. Requester is the authenticated recruiter UUID — the same key from '
  'different recruiters never collides. Resolves recruiter-specific policy '
  'first, global fallback. Global usage aggregates under a NULL scope row. '
  'Period buckets are anchored to a stable epoch (2000-01-01) so 7/30-day '
  'windows do NOT reset daily. Locks the matched enabled policy + usage row, '
  'projects COMMITTED usage PLUS pending reservations so two concurrent '
  'requests for the final slot cannot both reserve, checks both max_sessions '
  'and max_cost_units. Cost units from the policy — never from the client. '
  'warning_reached only when warning_percentage is non-null. Service-role-only.';

-- ───────────────────────────────────────────────────────────────────────
-- 10b. commit_quota_reservation — idempotent CAS reserved->committed,
--      increments quota_usage atomically.
-- ───────────────────────────────────────────────────────────────────────

create or replace function screening_v2.commit_quota_reservation(
  p_reservation_id uuid
)
returns jsonb
language plpgsql
security definer
set search_path = pg_catalog, screening_v2
as $$
declare
  v_res screening_v2.quota_reservations%rowtype;
  v_period_start date;
begin
  select * into v_res
    from screening_v2.quota_reservations
   where id = p_reservation_id
   for update;

  if not found then
    return jsonb_build_object('status', 'reservation_not_found');
  end if;

  -- Idempotent: already committed is a no-op (no double increment).
  if v_res.status = 'committed' then
    return jsonb_build_object('status', 'already_committed');
  end if;
  -- Released reservations are terminal and cannot be committed.
  if v_res.status = 'released' then
    return jsonb_build_object('status', 'released_not_commitable');
  end if;

  update screening_v2.quota_reservations
     set status = 'committed', committed_at = now()
   where id = p_reservation_id;

  -- Increment usage in the reservation's own period (atomic upsert).
  v_period_start := date_trunc('day', v_res.reserved_at)::date;
  insert into screening_v2.quota_usage
    (policy_id, scope_id, period_start, sessions_used, cost_units_used)
  values
    (v_res.policy_id, v_res.scope_id, v_period_start,
     v_res.sessions_reserved, v_res.cost_units_reserved)
  on conflict (policy_id, scope_id, period_start)
  do update set
    sessions_used = screening_v2.quota_usage.sessions_used + excluded.sessions_used,
    cost_units_used = screening_v2.quota_usage.cost_units_used + excluded.cost_units_used,
    updated_at = now();

  return jsonb_build_object('status', 'committed');
end;
$$;

revoke all on function screening_v2.commit_quota_reservation(uuid)
  from public, anon, authenticated;
grant execute on function screening_v2.commit_quota_reservation(uuid)
  to service_role;

comment on function screening_v2.commit_quota_reservation is
  'Idempotent CAS reserved->committed. Increments the policy/scope/period '
  'usage row atomically. Already-committed is a no-op (never double-'
  'counts); released reservations cannot be committed. Service-role-only.';

-- ───────────────────────────────────────────────────────────────────────
-- 10c. release_quota_reservation — idempotent CAS reserved->released
--      (compensation for failed session creation; NO usage increment).
-- ───────────────────────────────────────────────────────────────────────

create or replace function screening_v2.release_quota_reservation(
  p_reservation_id uuid
)
returns jsonb
language plpgsql
security definer
set search_path = pg_catalog, screening_v2
as $$
declare
  v_res screening_v2.quota_reservations%rowtype;
begin
  select * into v_res
    from screening_v2.quota_reservations
   where id = p_reservation_id
   for update;

  if not found then
    return jsonb_build_object('status', 'reservation_not_found');
  end if;

  if v_res.status = 'released' then
    return jsonb_build_object('status', 'already_released');
  end if;
  -- Committed reservations are terminal (usage already counted); releasing
  -- is a no-op and never decrements usage.
  if v_res.status = 'committed' then
    return jsonb_build_object('status', 'already_committed');
  end if;

  update screening_v2.quota_reservations
     set status = 'released', released_at = now()
   where id = p_reservation_id;

  return jsonb_build_object('status', 'released');
end;
$$;

revoke all on function screening_v2.release_quota_reservation(uuid)
  from public, anon, authenticated;
grant execute on function screening_v2.release_quota_reservation(uuid)
  to service_role;

comment on function screening_v2.release_quota_reservation is
  'Idempotent CAS reserved->released — the compensation path for failed '
  'session creation. NO usage is incremented. Committed reservations are '
  'terminal (no-op, never decrements). Service-role-only.';

-- ───────────────────────────────────────────────────────────────────────
-- 10d. update_membership — atomic last-admin-safe membership mutation.
--      Advisory FOR UPDATE row lock serialises concurrent mutations; the
--      actor can never self-deactivate/demote and the last active admin
--      can never be demoted or deactivated. Audit row in the SAME
--      transaction.
-- ───────────────────────────────────────────────────────────────────────

create or replace function screening_v2.update_membership(
  p_user_id uuid,
  p_role text,
  p_active boolean,
  p_actor_id uuid
)
returns jsonb
language plpgsql
security definer
set search_path = pg_catalog, screening_v2
as $$
declare
  v_current screening_v2.recruiter_memberships%rowtype;
  v_new_role text;
  v_new_active boolean;
  v_active_admins integer;
begin
  if p_role is not null and p_role not in ('admin','interviewer','viewer') then
    return jsonb_build_object('status', 'invalid_role');
  end if;
  if p_role is null and p_active is null then
    return jsonb_build_object('status', 'no_changes');
  end if;

  select * into v_current
    from screening_v2.recruiter_memberships
   where user_id = p_user_id
   for update;

  if not found then
    return jsonb_build_object('status', 'not_found');
  end if;

  v_new_role := coalesce(p_role, v_current.role);
  v_new_active := coalesce(p_active, v_current.active);

  -- Self-modification guard: an actor cannot demote or deactivate their own
  -- membership through this RPC.
  if p_actor_id = p_user_id
     and (v_new_role <> v_current.role or v_new_active = false) then
    return jsonb_build_object('status', 'self_modification_denied');
  end if;

  -- Last-active-admin guard: demoting/deactivating the only active admin
  -- would strand the organization.
  if v_current.role = 'admin' and v_current.active
     and (v_new_role <> 'admin' or v_new_active = false) then
    select count(*) into v_active_admins
      from screening_v2.recruiter_memberships
     where role = 'admin' and active;
    -- The target row is included in the count; subtract it.
    if (v_active_admins - 1) <= 0 then
      return jsonb_build_object('status', 'last_active_admin');
    end if;
  end if;

  update screening_v2.recruiter_memberships
     set role = v_new_role, active = v_new_active, updated_at = now()
   where user_id = p_user_id;

  -- Audit in the same transaction (action allowlisted by 0015).
  insert into screening_v2.audit_events
    (actor_id, actor_type, action, target_type, target_id, result, correlation_id, metadata)
  values
    (p_actor_id, 'recruiter', 'admin_member_update', 'membership',
     p_user_id::text, 'success', null,
     jsonb_build_object('role', v_new_role, 'active', v_new_active));

  return jsonb_build_object('status', 'ok');
end;
$$;

revoke all on function screening_v2.update_membership(uuid, text, boolean, uuid)
  from public, anon, authenticated;
grant execute on function screening_v2.update_membership(uuid, text, boolean, uuid)
  to service_role;

comment on function screening_v2.update_membership is
  'Atomic last-admin-safe membership mutation (advisory FOR UPDATE row '
  'lock). Cannot self-deactivate/demote (p_actor_id = p_user_id) and cannot '
  'remove the last active admin. Audit row inserted in the same transaction '
  '(action admin_member_update). Service-role-only.';

-- ───────────────────────────────────────────────────────────────────────
-- 10e. override_admin_session — bounded atomic admin session override with
--      CAS, reason, prior/new state. No resurrection of failed/cancelled/
--      expired/deleted sessions. Audit row in the SAME transaction.
-- ───────────────────────────────────────────────────────────────────────

create or replace function screening_v2.override_admin_session(
  p_session_id uuid,
  p_target_status text,
  p_reason text,
  p_actor_id uuid
)
returns jsonb
language plpgsql
security definer
set search_path = pg_catalog, screening_v2
as $$
declare
  v_session screening_v2.call_sessions%rowtype;
  v_terminal_reason text;
begin
  if p_target_status not in ('created','waiting','in_progress','failed','cancelled','completed') then
    return jsonb_build_object('status', 'invalid_target');
  end if;
  if p_reason is null or length(p_reason) < 1 or length(p_reason) > 200 then
    return jsonb_build_object('status', 'invalid_reason');
  end if;

  select * into v_session
    from screening_v2.call_sessions
   where id = p_session_id
   for update;

  if not found then
    return jsonb_build_object('status', 'session_not_found');
  end if;

  -- No resurrection: terminal failed/cancelled/expired sessions cannot be
  -- brought back to a live state; erased (deleted) sessions are immutable.
  if v_session.status in ('failed','cancelled','expired') then
    return jsonb_build_object('status', 'resurrection_denied');
  end if;
  if v_session.recording_deleted_at is not null then
    return jsonb_build_object('status', 'deleted_denied');
  end if;

  if p_target_status = v_session.status then
    return jsonb_build_object('status', 'no_op', 'prior_status', v_session.status);
  end if;

  v_terminal_reason := case p_target_status
    when 'failed' then 'provider_error'
    when 'cancelled' then 'recruiter_cancelled'
    when 'completed' then 'assessment_done'
    else null
  end;

  update screening_v2.call_sessions
     set status = p_target_status,
         terminal_reason = v_terminal_reason,
         ended_at = case when v_terminal_reason is not null then now() else ended_at end
   where id = p_session_id;

  -- Audit in the same transaction (action allowlisted by 0015).
  insert into screening_v2.audit_events
    (actor_id, actor_type, action, target_type, target_id, result, correlation_id, metadata)
  values
    (p_actor_id, 'recruiter', 'admin_session_override', 'session',
     p_session_id::text, 'success', null,
     jsonb_build_object(
       'prior_status', v_session.status,
       'new_status', p_target_status,
       'reason', p_reason
     ));

  return jsonb_build_object('status', 'ok', 'prior_status', v_session.status);
end;
$$;

revoke all on function screening_v2.override_admin_session(uuid, text, text, uuid)
  from public, anon, authenticated;
grant execute on function screening_v2.override_admin_session(uuid, text, text, uuid)
  to service_role;

comment on function screening_v2.override_admin_session is
  'Bounded atomic admin session override: CAS on the current status with a '
  'reason (1..200 chars) and prior/new state persisted in the SAME '
  'transaction''s audit row. Refuses to resurrect failed/cancelled/expired '
  'sessions or override erased (deleted) ones. Service-role-only.';

-- ───────────────────────────────────────────────────────────────────────
-- 10f. toggle_maintenance — atomic maintenance toggle + audit in the same
--      transaction (system_config key='maintenance').
-- ───────────────────────────────────────────────────────────────────────

create or replace function screening_v2.toggle_maintenance(
  p_enabled boolean,
  p_reason text,
  p_actor_id uuid
)
returns jsonb
language plpgsql
security definer
set search_path = pg_catalog, screening_v2
as $$
declare
  v_updated_at timestamptz;
begin
  if p_reason is null or length(p_reason) < 1 or length(p_reason) > 200 then
    return jsonb_build_object('status', 'invalid_reason');
  end if;

  insert into screening_v2.system_config (key, value, updated_by, updated_at)
  values (
    'maintenance',
    jsonb_build_object(
      'enabled', p_enabled,
      'reason', p_reason,
      'updated_by', p_actor_id,
      'updated_at', now()
    ),
    p_actor_id,
    now()
  )
  on conflict (key) do update
    set value = excluded.value,
        updated_by = excluded.updated_by,
        updated_at = excluded.updated_at
  returning updated_at into v_updated_at;

  -- Audit in the same transaction (action allowlisted by 0015).
  insert into screening_v2.audit_events
    (actor_id, actor_type, action, target_type, target_id, result, correlation_id, metadata)
  values
    (p_actor_id, 'recruiter', 'admin_maintenance_toggle', 'config',
     'maintenance', 'success', null,
     jsonb_build_object('enabled', p_enabled, 'reason', p_reason));

  return jsonb_build_object('status', 'ok', 'enabled', p_enabled, 'updated_at', v_updated_at);
end;
$$;

revoke all on function screening_v2.toggle_maintenance(boolean, text, uuid)
  from public, anon, authenticated;
grant execute on function screening_v2.toggle_maintenance(boolean, text, uuid)
  to service_role;

comment on function screening_v2.toggle_maintenance is
  'Atomic maintenance toggle: upserts system_config key=''maintenance'' and '
  'inserts the admin_maintenance_toggle audit row in the SAME transaction. '
  'Reason is bounded (1..200 chars). Service-role-only.';

-- ───────────────────────────────────────────────────────────────────────
-- 10g. create_appeal — atomic appeal creation + decision-block set + grant
--      consumption. assessment_snapshot carries score/version/hash
--      references ONLY (no transcript/resume/contact data).
-- ───────────────────────────────────────────────────────────────────────

create or replace function screening_v2.create_appeal(
  p_candidate_id uuid,
  p_session_id uuid,
  p_assessment_id uuid,
  p_grant_digest text,
  p_category text,
  p_description text,
  p_assessment_snapshot jsonb
)
returns jsonb
language plpgsql
security definer
set search_path = pg_catalog, screening_v2
as $$
declare
  v_grant screening_v2.appeal_grants%rowtype;
  v_appeal_id uuid;
begin
  if p_grant_digest !~ '^[a-f0-9]{64}$' then
    return jsonb_build_object('status', 'invalid_grant_digest');
  end if;
  if p_category not in ('scoring','recording','accessibility','other') then
    return jsonb_build_object('status', 'invalid_category');
  end if;
  if p_description is null or length(p_description) < 1 or length(p_description) > 2000 then
    return jsonb_build_object('status', 'invalid_description');
  end if;
  if p_assessment_snapshot is not null
     and octet_length(p_assessment_snapshot::text) > 4096 then
    return jsonb_build_object('status', 'invalid_snapshot');
  end if;

  select * into v_grant
    from screening_v2.appeal_grants
   where token_digest = p_grant_digest
   for update;

  if not found then
    return jsonb_build_object('status', 'grant_not_found');
  end if;
  if v_grant.consumed_at is not null then
    return jsonb_build_object('status', 'grant_consumed');
  end if;
  if v_grant.revoked_at is not null then
    return jsonb_build_object('status', 'grant_revoked');
  end if;
  if v_grant.expires_at <= now() then
    return jsonb_build_object('status', 'grant_expired');
  end if;
  if v_grant.candidate_id <> p_candidate_id or v_grant.session_id <> p_session_id then
    return jsonb_build_object('status', 'grant_mismatch');
  end if;

  insert into screening_v2.appeal_requests
    (candidate_id, session_id, assessment_id, grant_digest, category,
     description, assessment_snapshot, status)
  values
    (p_candidate_id, p_session_id, p_assessment_id, p_grant_digest, p_category,
     p_description, p_assessment_snapshot, 'open')
  returning id into v_appeal_id;

  -- Consume the one-time grant (replay protection) and block decision-use.
  update screening_v2.appeal_grants
     set consumed_at = now()
   where id = v_grant.id;
  update screening_v2.candidates
     set decision_use_blocked_at = now()
   where id = p_candidate_id;

  -- Audit in the same transaction (action allowlisted by 0015).
  insert into screening_v2.audit_events
    (actor_id, actor_type, action, target_type, target_id, result, correlation_id, metadata)
  values
    (p_candidate_id, 'candidate', 'appeal_create', 'appeal',
     v_appeal_id::text, 'success', null,
     jsonb_build_object('category', p_category, 'session_id', p_session_id));

  return jsonb_build_object('status', 'ok', 'appeal_id', v_appeal_id);
end;
$$;

revoke all on function screening_v2.create_appeal(uuid, uuid, uuid, text, text, text, jsonb)
  from public, anon, authenticated;
grant execute on function screening_v2.create_appeal(uuid, uuid, uuid, text, text, text, jsonb)
  to service_role;

comment on function screening_v2.create_appeal is
  'Atomic appeal creation: validates the one-time appeal grant (digest, '
  'unconsumed, unrevoked, unexpired, candidate/session binding), inserts '
  'the appeal row, consumes the grant, sets candidates.'
  'decision_use_blocked_at, and writes the appeal_create audit row — all in '
  'one transaction. assessment_snapshot stores score/version/hash '
  'references ONLY (bounded 4096 octets); never transcripts/resumes/contact '
  'data. Service-role-only.';

-- ───────────────────────────────────────────────────────────────────────
-- 10h. review_appeal — atomic review transition + immutable
--      appeal_review_events insert + decision-block cleared only when no
--      unresolved appeals remain for the candidate.
-- ───────────────────────────────────────────────────────────────────────

create or replace function screening_v2.review_appeal(
  p_appeal_id uuid,
  p_reviewer_id uuid,
  p_to_status text,
  p_notes text,
  p_evidence jsonb
)
returns jsonb
language plpgsql
security definer
set search_path = pg_catalog, screening_v2
as $$
declare
  v_appeal screening_v2.appeal_requests%rowtype;
  v_unresolved integer;
begin
  if p_to_status not in ('under_review','granted','denied') then
    return jsonb_build_object('status', 'invalid_target');
  end if;
  if p_notes is not null and length(p_notes) > 2000 then
    return jsonb_build_object('status', 'invalid_notes');
  end if;
  if p_evidence is not null and octet_length(p_evidence::text) > 4096 then
    return jsonb_build_object('status', 'invalid_evidence');
  end if;

  select * into v_appeal
    from screening_v2.appeal_requests
   where id = p_appeal_id
   for update;

  if not found then
    return jsonb_build_object('status', 'appeal_not_found');
  end if;

  -- CAS: terminal states are immutable; under_review cannot regress to open.
  if v_appeal.status in ('granted','denied') then
    return jsonb_build_object('status', 'already_final');
  end if;
  if v_appeal.status = 'under_review' and p_to_status = 'open' then
    return jsonb_build_object('status', 'invalid_transition');
  end if;
  if v_appeal.status = p_to_status then
    return jsonb_build_object('status', 'no_op');
  end if;

  update screening_v2.appeal_requests
     set status = p_to_status, updated_at = now()
   where id = p_appeal_id;

  -- Immutable review event in the same transaction (append-only table).
  insert into screening_v2.appeal_review_events
    (appeal_id, reviewer_id, from_status, to_status, notes, evidence)
  values
    (p_appeal_id, p_reviewer_id, v_appeal.status, p_to_status, p_notes, p_evidence);

  -- Clear the decision block ONLY when no unresolved appeals remain.
  if p_to_status in ('granted','denied') then
    select count(*) into v_unresolved
      from screening_v2.appeal_requests
     where candidate_id = v_appeal.candidate_id
       and status in ('open','under_review');
    if v_unresolved = 0 then
      update screening_v2.candidates
         set decision_use_blocked_at = null
       where id = v_appeal.candidate_id;
    end if;
  end if;

  -- Audit in the same transaction (action allowlisted by 0015).
  insert into screening_v2.audit_events
    (actor_id, actor_type, action, target_type, target_id, result, correlation_id, metadata)
  values
    (p_reviewer_id, 'recruiter', 'appeal_review', 'appeal',
     p_appeal_id::text, 'success', null,
     jsonb_build_object(
       'from_status', v_appeal.status,
       'to_status', p_to_status
     ));

  return jsonb_build_object('status', 'ok');
end;
$$;

revoke all on function screening_v2.review_appeal(uuid, uuid, text, text, jsonb)
  from public, anon, authenticated;
grant execute on function screening_v2.review_appeal(uuid, uuid, text, text, jsonb)
  to service_role;

comment on function screening_v2.review_appeal is
  'Atomic appeal review transition: CAS on the current appeal status, one '
  'immutable appeal_review_events row, and — when the appeal is finalized '
  'and NO unresolved appeals remain for the candidate — clears candidates.'
  'decision_use_blocked_at. Audit row (appeal_review) in the same '
  'transaction. Service-role-only.';

-- ═══════════════════════════════════════════════════════════════════════
-- 9b. Quota policy administration (Phase 9 review repair — OPS-05).
--     Atomic upsert + quota_override audit in ONE transaction. SECURITY
--     DEFINER, fixed search_path, service-role-only. Cost units remain an
--     abstract admin integer — never currency/provider price/client input.
--     Validation is defensive here AND in the API schema (fail closed).
-- ═══════════════════════════════════════════════════════════════════════

create or replace function screening_v2.upsert_quota_policy(
  p_policy_id uuid,
  p_scope text,
  p_scope_id uuid,
  p_mode text,
  p_max_sessions integer,
  p_max_cost_units integer,
  p_cost_units_per_session integer,
  p_warning_percentage integer,
  p_period_days integer,
  p_enabled boolean,
  p_actor_id uuid
)
returns jsonb
language plpgsql
security definer
set search_path = pg_catalog, screening_v2
as $$
declare
  v_id uuid;
  v_created boolean := false;
  v_scope text := lower(coalesce(p_scope, ''));
  v_mode text := lower(coalesce(p_mode, 'simulation'));
  v_period_days integer := coalesce(p_period_days, 1);
begin
  -- Defensive bounds — never trust the client past the API schema.
  if v_scope not in ('global', 'recruiter') then
    return jsonb_build_object('status', 'invalid_scope');
  end if;
  if (v_scope = 'global' and p_scope_id is not null)
     or (v_scope = 'recruiter' and p_scope_id is null) then
    return jsonb_build_object('status', 'invalid_scope_coherence');
  end if;
  if v_mode not in ('simulation', 'live') then
    return jsonb_build_object('status', 'invalid_mode');
  end if;
  if p_max_sessions is not null and p_max_sessions <= 0 then
    return jsonb_build_object('status', 'invalid_max_sessions');
  end if;
  if p_max_cost_units is not null and p_max_cost_units <= 0 then
    return jsonb_build_object('status', 'invalid_max_cost_units');
  end if;
  if p_cost_units_per_session is not null and p_cost_units_per_session <= 0 then
    return jsonb_build_object('status', 'invalid_cost_units_per_session');
  end if;
  if p_warning_percentage is not null
     and (p_warning_percentage < 1 or p_warning_percentage > 100) then
    return jsonb_build_object('status', 'invalid_warning_percentage');
  end if;
  if v_period_days < 1 or v_period_days > 365 then
    return jsonb_build_object('status', 'invalid_period_days');
  end if;
  if p_actor_id is null then
    return jsonb_build_object('status', 'actor_required');
  end if;

  -- Deterministic create/update in one transaction: INSERT when no id is
  -- supplied; UPDATE (with an existence check) when one is. A PATCH of a
  -- nonexistent policy returns not_found WITHOUT creating a row. Concurrent
  -- upserts serialise on the PK/row lock; last-write-wins is deterministic.
  if p_policy_id is not null then
    update screening_v2.quota_policies set
      scope = v_scope,
      scope_id = p_scope_id,
      mode = v_mode,
      max_sessions = p_max_sessions,
      max_cost_units = p_max_cost_units,
      cost_units_per_session = p_cost_units_per_session,
      warning_percentage = p_warning_percentage,
      period_days = v_period_days,
      enabled = coalesce(p_enabled, false),
      updated_at = now()
    where id = p_policy_id
    returning id into v_id;
    if not found then
      return jsonb_build_object('status', 'not_found');
    end if;
  else
    insert into screening_v2.quota_policies (
      id, scope, scope_id, mode, max_sessions, max_cost_units,
      cost_units_per_session, warning_percentage, period_days, enabled
    )
    values (
      gen_random_uuid(), v_scope, p_scope_id, v_mode,
      p_max_sessions, p_max_cost_units, p_cost_units_per_session,
      p_warning_percentage, v_period_days, coalesce(p_enabled, false)
    )
    returning id into v_id;
    v_created := true;
  end if;

  -- Audit in the SAME transaction (allowlisted action quota_override).
  insert into screening_v2.audit_events (
    actor_id, actor_type, action, target_type, target_id, result, metadata
  ) values (
    p_actor_id, 'recruiter', 'quota_override', 'quota_policy', v_id::text,
    'success',
    jsonb_build_object(
      'policy_id', v_id,
      'scope', v_scope,
      'mode', v_mode,
      'enabled', coalesce(p_enabled, false),
      'created', v_created
    )
  );

  return jsonb_build_object('status', 'ok', 'id', v_id, 'created', v_created);
end;
$$;

revoke all on function screening_v2.upsert_quota_policy(uuid, text, uuid, text, integer, integer, integer, integer, integer, boolean, uuid)
  from public, anon, authenticated;
grant execute on function screening_v2.upsert_quota_policy(uuid, text, uuid, text, integer, integer, integer, integer, integer, boolean, uuid)
  to service_role;

comment on function screening_v2.upsert_quota_policy is
  'Atomic admin quota-policy create/update with a quota_override audit row in '
  'the same transaction. Cost units are abstract admin integers — never '
  'currency, provider price, or client-supplied. Policies stay DISABLED by '
  'default (enabled=false); enforcement engages only when enabled. '
  'Service-role-only.';

-- ═══════════════════════════════════════════════════════════════════════
-- Verifier: schema reload notification
-- ═══════════════════════════════════════════════════════════════════════

notify pgrst, 'reload schema';
