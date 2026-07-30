-- =====================================================================
-- 0012 — Governance foundation: legal holds, retention policies, erasure
--        exceptions, data-subject requests (DSAR), and audit trail.
--
-- GOV-04: Synthetic legal-hold, retention, erasure exception foundations
-- GOV-05: DSAR export/delete/correct route foundations
-- GOV-10: Retention & erasure governance audit trail
--
-- DESIGN:
--   A. retention_policies — Configurable retention duration per data
--      category (candidate, session, transcript, recording, assessment).
--      D-009: retain-default is the initial state, but erasure MUST
--      still be possible (retain-default ≠ no-erasure).
--   B. legal_holds — Court-ordered or internal legal hold mandates.
--      When active, blocks erasure of the referenced entity. Audit
--      records the hold creation, modification, and attempted deletion.
--   C. erasure_exceptions — Data categories or individual records
--      exempted from erasure for legitimate business/legal reasons.
--   D. data_subject_requests — DSAR lifecycle tracking (export, delete,
--      correct). Tracks request type, status, fulfilment timestamps.
--   E. retention_audit — Append-only log of all governance actions:
--      hold placed/released, erasure completed/blocked, DSAR fulfilled.
--   F. RLS + grants — Service-role only for mutation; authenticated
--      recruiters can SELECT governance metadata (no PII).
-- =====================================================================

-- ── A. Retention policies ────────────────────────────────────────────

create table if not exists screening_v2.retention_policies (
  id              uuid primary key default gen_random_uuid(),
  data_category   text not null,
  retention_days  integer not null,
  strategy        text not null default 'delete',
  is_default      boolean not null default false,
  notes           text,
  created_by      uuid,                                   -- auth.users UUID; nullable for system defaults
  created_at      timestamptz not null default now(),
  updated_at      timestamptz not null default now(),
  constraint uq_retention_category unique (data_category),
  constraint chk_retention_days check (retention_days >= 0),
  constraint chk_retention_strategy check (strategy in ('delete', 'anonymize', 'archive')),
  constraint chk_retention_category check (
    data_category in (
      'candidate', 'session', 'transcript', 'recording', 'assessment',
      'resume', 'invite', 'audit_log'
    )
  )
);

alter table screening_v2.retention_policies enable row level security;

comment on table screening_v2.retention_policies is
  'GOV-04/GOV-10: Configurable retention duration per data category. '
  'D-009: retain-default (retention_days = -1 sentinel) is the initial '
  'state, but erasure requests MUST still be honoured — retain-default '
  'does NOT mean no-erasure. Use strategy=delete for hard delete, '
  'anonymize for pseudonymisation, archive for offload.';
comment on column screening_v2.retention_policies.data_category is
  'Data category this policy applies to. Each category has exactly one '
  'active policy (enforced by unique constraint).';
comment on column screening_v2.retention_policies.retention_days is
  'Retention period in days. 0 = delete immediately. -1 sentinel = '
  'retain indefinitely (D-009 default). Negative values reserved.';
comment on column screening_v2.retention_policies.strategy is
  'Action when retention period expires: delete, anonymize, or archive.';

create index if not exists idx_v2_retention_category
  on screening_v2.retention_policies(data_category);

drop trigger if exists trg_v2_retention_updated on screening_v2.retention_policies;
create trigger trg_v2_retention_updated before update on screening_v2.retention_policies
  for each row execute function screening_v2.set_updated_at();

-- Seed default retention policies (D-009: retain indefinitely)
insert into screening_v2.retention_policies (data_category, retention_days, strategy, is_default, notes)
values
  ('candidate',   -1, 'archive',   true, 'D-009 default: retain indefinitely; erasure still possible via GOV-05'),
  ('session',     -1, 'archive',   true, 'D-009 default: retain indefinitely; erasure still possible via GOV-05'),
  ('transcript',  -1, 'archive',   true, 'D-009 default: retain indefinitely; erasure still possible via GOV-05'),
  ('recording',   -1, 'archive',   true, 'D-009 default: retain indefinitely; erasure still possible via GOV-05'),
  ('assessment',  -1, 'archive',   true, 'D-009 default: retain indefinitely; erasure still possible via GOV-05'),
  ('resume',      -1, 'archive',   true, 'D-009 default: retain indefinitely; erasure still possible via GOV-05'),
  ('invite',      -1, 'delete',    true, 'D-009 default: retain indefinitely; erasure still possible via GOV-05'),
  ('audit_log',   -1, 'delete',    true, 'D-009 default: retain indefinitely; erasure still possible via GOV-05')
on conflict (data_category) do nothing;

-- ── B. Legal holds ───────────────────────────────────────────────────

create table if not exists screening_v2.legal_holds (
  id              uuid primary key default gen_random_uuid(),
  entity_type     text not null,     -- 'candidate', 'session', 'transcript', 'recording'
  entity_id       uuid not null,     -- FK to the referenced entity
  hold_reason     text not null,
  hold_source     text not null,     -- 'court_order', 'internal_investigation', 'litigation_hold'
  placed_by       uuid not null,     -- auth.users UUID who placed the hold
  placed_at       timestamptz not null default now(),
  released_at     timestamptz,       -- null = active hold
  released_by     uuid,              -- auth.users UUID who released the hold
  release_reason  text,
  expires_at      timestamptz,       -- optional automatic expiry
  metadata        jsonb,             -- additional context (case reference, notes)
  created_at      timestamptz not null default now(),
  updated_at      timestamptz not null default now(),
  constraint chk_legal_hold_entity_type check (
    entity_type in ('candidate', 'session', 'transcript', 'recording', 'assessment', 'resume')
  ),
  constraint chk_legal_hold_source check (
    hold_source in ('court_order', 'internal_investigation', 'litigation_hold', 'regulatory', 'other')
  ),
  constraint chk_legal_hold_release check (
    (released_at is null and released_by is null and release_reason is null)
    or (released_at is not null and released_by is not null)
  ),
  constraint chk_legal_hold_expiry check (
    expires_at is null or expires_at > placed_at
  ),
  constraint chk_legal_hold_metadata_size check (
    metadata is null or octet_length(metadata::text) <= 4096
  )
);

alter table screening_v2.legal_holds enable row level security;

comment on table screening_v2.legal_holds is
  'GOV-04: Legal hold mandates that prevent erasure of referenced entities. '
  'When an active hold exists for an entity, deletion/erasure is blocked '
  'and an audit event is recorded. Holds can be placed by court order, '
  'internal investigation, or litigation hold.';
comment on column screening_v2.legal_holds.hold_reason is
  'Human-readable reason for the hold. Examples: "Active litigation case #1234", '
  '"Regulatory investigation Q3-2026"';
comment on column screening_v2.legal_holds.released_at is
  'When the hold was released. NULL = hold is active. Only one active hold '
  'per entity is enforced by the API (not DB) to allow concurrent holds.';

create index if not exists idx_v2_legal_holds_entity
  on screening_v2.legal_holds(entity_type, entity_id)
  where released_at is null;
create index if not exists idx_v2_legal_holds_placed_by
  on screening_v2.legal_holds(placed_by);
create index if not exists idx_v2_legal_holds_active
  on screening_v2.legal_holds(released_at)
  where released_at is null;

drop trigger if exists trg_v2_legal_holds_updated on screening_v2.legal_holds;
create trigger trg_v2_legal_holds_updated before update on screening_v2.legal_holds
  for each row execute function screening_v2.set_updated_at();

-- ── C. Erasure exceptions ────────────────────────────────────────────

create table if not exists screening_v2.erasure_exceptions (
  id              uuid primary key default gen_random_uuid(),
  entity_type     text not null,     -- 'candidate', 'session', 'transcript', 'recording'
  entity_id       uuid not null,     -- FK to the referenced entity
  exception_type  text not null,     -- 'legal_hold', 'retention_obligation', 'business_necessity'
  reason          text not null,
  granted_by      uuid not null,     -- auth.users UUID who granted the exception
  granted_at      timestamptz not null default now(),
  expires_at      timestamptz,       -- optional automatic expiry
  revoked_at      timestamptz,       -- null = active exception
  revoked_by      uuid,              -- auth.users UUID who revoked the exception
  metadata        jsonb,
  created_at      timestamptz not null default now(),
  updated_at      timestamptz not null default now(),
  constraint chk_erasure_exception_type check (
    entity_type in ('candidate', 'session', 'transcript', 'recording', 'assessment', 'resume')
  ),
  constraint chk_erasure_exception_kind check (
    exception_type in ('legal_hold', 'retention_obligation', 'business_necessity', 'regulatory')
  ),
  constraint chk_erasure_exception_revoke check (
    (revoked_at is null and revoked_by is null)
    or (revoked_at is not null and revoked_by is not null)
  ),
  constraint chk_erasure_exception_metadata_size check (
    metadata is null or octet_length(metadata::text) <= 2048
  )
);

alter table screening_v2.erasure_exceptions enable row level security;

comment on table screening_v2.erasure_exceptions is
  'GOV-04: Exceptions that prevent erasure of specific entities. '
  'Legal holds create exceptions automatically. Additional exceptions '
  'can be granted for retention obligations or business necessity. '
  'Revocable by authorised users.';

create index if not exists idx_v2_erasure_exceptions_entity
  on screening_v2.erasure_exceptions(entity_type, entity_id)
  where revoked_at is null;
create index if not exists idx_v2_erasure_exceptions_active
  on screening_v2.erasure_exceptions(revoked_at)
  where revoked_at is null;

drop trigger if exists trg_v2_erasure_exceptions_updated on screening_v2.erasure_exceptions;
create trigger trg_v2_erasure_exceptions_updated before update on screening_v2.erasure_exceptions
  for each row execute function screening_v2.set_updated_at();

-- ── D. Data Subject Access Requests (DSAR) ───────────────────────────

create table if not exists screening_v2.data_subject_requests (
  id                uuid primary key default gen_random_uuid(),
  candidate_id      uuid not null references screening_v2.candidates(id)
                    on delete cascade,
  request_type      text not null,     -- 'export', 'delete', 'correct', 'restrict'
  request_status    text not null default 'pending',
  requested_by      uuid not null,     -- auth.users UUID of the requester
  requested_at      timestamptz not null default now(),
  reviewed_by       uuid,              -- auth.users UUID who reviewed/fulfilled
  reviewed_at       timestamptz,
  fulfilled_at      timestamptz,
  rejection_reason  text,              -- non-null when request_status = 'rejected'
  legal_hold_blocked boolean not null default false,  -- true if erasure blocked by legal hold
  notes             text,
  metadata          jsonb,             -- request context, export format, correction payload
  created_at        timestamptz not null default now(),
  updated_at        timestamptz not null default now(),
  constraint chk_dsar_request_type check (
    request_type in ('export', 'delete', 'correct', 'restrict')
  ),
  constraint chk_dsar_request_status check (
    request_status in ('pending', 'in_progress', 'fulfilled', 'rejected', 'cancelled')
  ),
  constraint chk_dsar_fulfilled check (
    (request_status = 'fulfilled' and fulfilled_at is not null)
    or (request_status != 'fulfilled' and fulfilled_at is null)
  ),
  constraint chk_dsar_rejected check (
    (request_status = 'rejected' and rejection_reason is not null)
    or (request_status != 'rejected' and rejection_reason is null)
  ),
  constraint chk_dsar_metadata_size check (
    metadata is null or octet_length(metadata::text) <= 4096
  )
);

alter table screening_v2.data_subject_requests enable row level security;

comment on table screening_v2.data_subject_requests is
  'GOV-05: DSAR lifecycle tracking. Each request is linked to a candidate '
  'and tracks the fulfilment process. Export requests store the export '
  'reference in metadata. Delete requests check legal holds before '
  'proceeding. Correct requests store the correction diff in metadata.';
comment on column screening_v2.data_subject_requests.request_type is
  'export = data portability export; delete = erasure (right to be forgotten); '
  'correct = rectification; restrict = restriction of processing.';
comment on column screening_v2.data_subject_requests.legal_hold_blocked is
  'Set to true when a delete request encounters an active legal hold. '
  'The request remains in pending until the hold is released or the '
  'request is escalated.';

create index if not exists idx_v2_dsar_candidate
  on screening_v2.data_subject_requests(candidate_id);
create index if not exists idx_v2_dsar_status
  on screening_v2.data_subject_requests(request_status);
create index if not exists idx_v2_dsar_type_status
  on screening_v2.data_subject_requests(request_type, request_status);

drop trigger if exists trg_v2_dsar_updated on screening_v2.data_subject_requests;
create trigger trg_v2_dsar_updated before update on screening_v2.data_subject_requests
  for each row execute function screening_v2.set_updated_at();

-- ── E. Retention / Governance audit trail ────────────────────────────

create table if not exists screening_v2.governance_audit (
  id              uuid primary key default gen_random_uuid(),
  action          text not null,
  actor_id        uuid not null,
  actor_type      text not null default 'recruiter',
  entity_type     text,
  entity_id       text,                -- opaque UUID reference, never PII
  details         jsonb,               -- bounded context, no PII
  outcome         text not null default 'success',
  correlation_id  uuid,                -- groups related governance events
  created_at      timestamptz not null default now(),
  constraint chk_gov_audit_action check (
    action in (
      'legal_hold_placed', 'legal_hold_released', 'legal_hold_blocked_deletion',
      'retention_policy_created', 'retention_policy_updated',
      'erasure_exception_granted', 'erasure_exception_revoked',
      'dsar_created', 'dsar_fulfilled', 'dsar_rejected', 'dsar_cancelled',
      'data_exported', 'data_deleted', 'data_corrected',
      'erasure_blocked_legal_hold', 'erasure_completed',
      'governance_config_changed'
    )
  ),
  constraint chk_gov_audit_outcome check (
    outcome in ('success', 'failure', 'blocked')
  ),
  constraint chk_gov_audit_details_size check (
    details is null or octet_length(details::text) <= 4096
  )
);

alter table screening_v2.governance_audit enable row level security;

comment on table screening_v2.governance_audit is
  'GOV-10: Append-only governance audit trail. Every legal hold, erasure, '
  'retention policy change, and DSAR action is recorded here. No PII, '
  'transcript, resume text, tokens, or secrets may be stored. Entity IDs '
  'are opaque UUIDs or references.';

create index if not exists idx_v2_gov_audit_action
  on screening_v2.governance_audit(action, created_at);
create index if not exists idx_v2_gov_audit_actor
  on screening_v2.governance_audit(actor_id, created_at);
create index if not exists idx_v2_gov_audit_entity
  on screening_v2.governance_audit(entity_type, entity_id)
  where entity_type is not null;
create index if not exists idx_v2_gov_audit_correlation
  on screening_v2.governance_audit(correlation_id);
create index if not exists idx_v2_gov_audit_created
  on screening_v2.governance_audit(created_at);

-- Governance audit mutation guard (append-only, like audit_events)
create or replace function screening_v2.prevent_gov_audit_mutation()
returns trigger
language plpgsql
security invoker
set search_path = pg_catalog
as $$
begin
  if current_setting('app.allow_gov_audit_mutation', true) = 'true' then
    return new;
  end if;
  raise exception 'governance_audit is append-only: % not permitted', tg_op
    using errcode = 'P0001';
end;
$$;

drop trigger if exists trg_gov_audit_prevent_update on screening_v2.governance_audit;
create trigger trg_gov_audit_prevent_update
  before update on screening_v2.governance_audit
  for each row
  execute function screening_v2.prevent_gov_audit_mutation();

drop trigger if exists trg_gov_audit_prevent_delete on screening_v2.governance_audit;
create trigger trg_gov_audit_prevent_delete
  before delete on screening_v2.governance_audit
  for each row
  execute function screening_v2.prevent_gov_audit_mutation();

comment on function screening_v2.prevent_gov_audit_mutation is
  'Blocks UPDATE/DELETE on governance_audit. To allow migration/maintenance, '
  'set app.allow_gov_audit_mutation = ''true'' via SET LOCAL in a dedicated '
  'session, then RESET. Never enable globally or in application connections.';

-- ── F. RLS policies ──────────────────────────────────────────────────

-- retention_policies: all active recruiters can read; service_role writes
create policy "recruiter read retention_policies"
  on screening_v2.retention_policies for select to authenticated
  using ((select screening_v2.is_active_recruiter()));

-- legal_holds: all active recruiters can read; service_role writes
create policy "recruiter read legal_holds"
  on screening_v2.legal_holds for select to authenticated
  using ((select screening_v2.is_active_recruiter()));

-- erasure_exceptions: all active recruiters can read; service_role writes
create policy "recruiter read erasure_exceptions"
  on screening_v2.erasure_exceptions for select to authenticated
  using ((select screening_v2.is_active_recruiter()));

-- data_subject_requests: all active recruiters can read; service_role writes
create policy "recruiter read data_subject_requests"
  on screening_v2.data_subject_requests for select to authenticated
  using ((select screening_v2.is_active_recruiter()));

-- governance_audit: all active recruiters can read; service_role writes
create policy "recruiter read governance_audit"
  on screening_v2.governance_audit for select to authenticated
  using ((select screening_v2.is_active_recruiter()));

-- ── G. Grants ────────────────────────────────────────────────────────

grant all privileges on screening_v2.retention_policies to service_role;
grant select on screening_v2.retention_policies to authenticated;

grant all privileges on screening_v2.legal_holds to service_role;
grant select on screening_v2.legal_holds to authenticated;

grant all privileges on screening_v2.erasure_exceptions to service_role;
grant select on screening_v2.erasure_exceptions to authenticated;

grant all privileges on screening_v2.data_subject_requests to service_role;
grant select on screening_v2.data_subject_requests to authenticated;

grant all privileges on screening_v2.governance_audit to service_role;
grant select on screening_v2.governance_audit to authenticated;

-- ── Verify schema reload ─────────────────────────────────────────────

notify pgrst, 'reload schema';
