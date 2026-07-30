-- =====================================================================
-- 0007 — Ownership scope, candidate invites/grants, append-only audit,
--        role-aware RLS, and MFA config extension (SEC-09 / REC-04).
--
-- DESIGN:
--   A. Owner_id columns on roles, candidates, call_sessions — nullable
--      (backfill-safe) FK to auth.users. Interviewer-scoped RLS uses
--      these to restrict row access. Null = legacy/unowned/shared.
--   B. screening_v2.recruiter_role() — SECURITY DEFINER helper that
--      returns the active recruiter's role name.
--   C. Role-aware RLS policies: admin/viewer see all; interviewer sees
--      only owned or unowned rows. transcript_turns/assessments remain
--      org-wide (their parent-session scoping is an API-layer concern).
--   D. candidate_invites — SHA-256 token digest only; no plaintext
--      column. Binds candidate/session/room. Supports expiry, revocation,
--      consumed timestamp. UNIQUE token_digest prevents replay.
--   E. candidate_access_grants — Like invites but for candidate-facing
--      data access. SHA-256 digest only. Never exposed via PostgREST
--      (no SELECT grant to authenticated).
--   F. audit_events — Append-only, data-minimized. UPDATE/DELETE fail
--      at trigger boundary. Escape hatch: SET app.allow_audit_mutation
--      = 'true' for emergency migration only.
--   G. RLS/grants for new tables — anon denied; authenticated sees own
--      role's scope.
-- =====================================================================

-- ── A. Owner_id columns ───────────────────────────────────────────────

alter table screening_v2.roles
  add column if not exists owner_id uuid references auth.users(id)
  on delete set null;

alter table screening_v2.candidates
  add column if not exists owner_id uuid references auth.users(id)
  on delete set null;

alter table screening_v2.call_sessions
  add column if not exists owner_id uuid references auth.users(id)
  on delete set null;

comment on column screening_v2.roles.owner_id is
  'Nullable UUID linking this role to the recruiter who manages it. '
  'Null = legacy/shared/unowned. Used for interviewer scope in RLS.';
comment on column screening_v2.candidates.owner_id is
  'Nullable UUID linking this candidate to the recruiting interviewer. '
  'Null = legacy/shared/unowned. Used for interviewer scope in RLS.';
comment on column screening_v2.call_sessions.owner_id is
  'Nullable UUID linking this session to the recruiting interviewer. '
  'Null = legacy/shared/unowned. Used for interviewer scope in RLS.';

create index if not exists idx_v2_roles_owner on screening_v2.roles(owner_id);
create index if not exists idx_v2_candidates_owner on screening_v2.candidates(owner_id);
create index if not exists idx_v2_sessions_owner on screening_v2.call_sessions(owner_id);

-- ── A2. recording_object_key for REC-05 ──────────────────────────────

alter table screening_v2.call_sessions
  add column if not exists recording_object_key text;

comment on column screening_v2.call_sessions.recording_object_key is
  'REC-05: S3 object key for the recording file. Null before recording is '
  'finalized. No signed URL is ever persisted in this column -- the key is '
  'resolved to a short-TTL presigned URL at read time by the backend. '
  'Bounded to 512 chars and a restricted character set to prevent injection.';

-- Bounded-object-key constraint: no path injection, max 512 chars.
alter table screening_v2.call_sessions
  drop constraint if exists chk_call_sessions_recording_obj_key;

alter table screening_v2.call_sessions
  add constraint chk_call_sessions_recording_obj_key
    check (
      recording_object_key is null
      or (
        length(recording_object_key) between 1 and 512
        and recording_object_key ~ '^[a-zA-Z0-9_\-./]+$'
      )
    ) not valid;
alter table screening_v2.call_sessions
  validate constraint chk_call_sessions_recording_obj_key;

create index if not exists idx_v2_sessions_recording_key
  on screening_v2.call_sessions(recording_object_key)
  where recording_object_key is not null;

-- ── B. Recruiter role helper ──────────────────────────────────────────

create or replace function screening_v2.recruiter_role()
returns text
language sql
stable
security definer
set search_path = pg_catalog
as $$
  select role
    from screening_v2.recruiter_memberships as membership
   where membership.user_id = (select auth.uid())
     and membership.active;
$$;
revoke all on function screening_v2.recruiter_role() from public, anon;
grant execute on function screening_v2.recruiter_role() to authenticated, service_role;

comment on function screening_v2.recruiter_role is
  'Returns the active recruiter role (admin|interviewer|viewer) or NULL '
  'if the user has no active membership. SECURITY DEFINER with fixed '
  'search_path prevents RLS recursion.';

-- ── C. Role-aware RLS policies ────────────────────────────────────────

-- Drop old membership-agnostic policies.
drop policy if exists "active recruiter read roles" on screening_v2.roles;
drop policy if exists "active recruiter read candidates" on screening_v2.candidates;
drop policy if exists "active recruiter read call_sessions" on screening_v2.call_sessions;
drop policy if exists "active recruiter read transcript_turns" on screening_v2.transcript_turns;
drop policy if exists "active recruiter read assessments" on screening_v2.assessments;

-- Helper: user is an active recruiter with admin or viewer role (org-wide access)
create or replace function screening_v2._is_admin_or_viewer()
returns boolean
language sql
stable
security definer
set search_path = pg_catalog
as $$
  select exists (
    select 1
      from screening_v2.recruiter_memberships as membership
     where membership.user_id = (select auth.uid())
       and membership.active
       and membership.role in ('admin', 'viewer')
  );
$$;
revoke all on function screening_v2._is_admin_or_viewer() from public, anon;
grant execute on function screening_v2._is_admin_or_viewer() to authenticated, service_role;

-- Helper: user is an active interviewer
create or replace function screening_v2._is_interviewer()
returns boolean
language sql
stable
security definer
set search_path = pg_catalog
as $$
  select exists (
    select 1
      from screening_v2.recruiter_memberships as membership
     where membership.user_id = (select auth.uid())
       and membership.active
       and membership.role = 'interviewer'
  );
$$;
revoke all on function screening_v2._is_interviewer() from public, anon;
grant execute on function screening_v2._is_interviewer() to authenticated, service_role;

-- Admin/viewer read the single organization; interviewers read owned rows only.
-- Legacy NULL ownership is intentionally invisible to interviewers until claimed
-- through an authorized API operation or backfilled by an administrator.
create policy "scoped recruiter read roles"
  on screening_v2.roles for select to authenticated
  using (
    (select screening_v2._is_admin_or_viewer())
    or ((select screening_v2._is_interviewer()) and owner_id = (select auth.uid()))
  );

create policy "scoped recruiter read candidates"
  on screening_v2.candidates for select to authenticated
  using (
    (select screening_v2._is_admin_or_viewer())
    or ((select screening_v2._is_interviewer()) and owner_id = (select auth.uid()))
  );

create policy "scoped recruiter read call_sessions"
  on screening_v2.call_sessions for select to authenticated
  using (
    (select screening_v2._is_admin_or_viewer())
    or ((select screening_v2._is_interviewer()) and owner_id = (select auth.uid()))
  );

-- Transcript turns and assessments remain org-wide readable.
-- Their parent-session/candidate scoping is enforced at the API layer.
create policy "active recruiter read transcript_turns"
  on screening_v2.transcript_turns for select to authenticated
  using ((select screening_v2.is_active_recruiter()));
create policy "active recruiter read assessments"
  on screening_v2.assessments for select to authenticated
  using ((select screening_v2.is_active_recruiter()));

-- ── D. Candidate invites ──────────────────────────────────────────────

create table if not exists screening_v2.candidate_invites (
  id            uuid primary key default gen_random_uuid(),
  candidate_id  uuid not null references screening_v2.candidates(id)
                on delete cascade,
  session_id    uuid references screening_v2.call_sessions(id)
                on delete set null,
  token_digest  text not null,
  expires_at    timestamptz not null,
  revoked_at    timestamptz,
  consumed_at   timestamptz,
  created_by    uuid not null,  -- auth.users UUID; FK omitted for test flexibility
  created_at    timestamptz not null default now(),
  updated_at    timestamptz not null default now(),
  constraint uq_candidate_invites_digest unique (token_digest),
  constraint chk_invite_token_digest check (token_digest ~ '^[a-f0-9]{64}$'),
  constraint chk_invite_expires_after_created check (expires_at > created_at),
  constraint chk_invite_token_use check (
    not (revoked_at is not null and consumed_at is not null)
  )
);

alter table screening_v2.candidate_invites enable row level security;

comment on table screening_v2.candidate_invites is
  'High-entropy-token-based invites for candidates. Only SHA-256 hex digest '
  'is stored — no plaintext token column. The token is sent to the candidate '
  'and hashed on consumption to look up this row. UNIQUE token_digest '
  'prevents replay.';
comment on column screening_v2.candidate_invites.token_digest is
  'SHA-256 hex digest (64 chars) of the high-entropy invite token. '
  'The raw token is never stored.';
comment on column screening_v2.candidate_invites.created_by is
  'UUID of the recruiter who created the invite. References auth.users '
  'in production; FK omitted for local test flexibility.';

create index if not exists idx_v2_invites_candidate
  on screening_v2.candidate_invites(candidate_id);
create index if not exists idx_v2_invites_digest
  on screening_v2.candidate_invites(token_digest);
create index if not exists idx_v2_invites_session
  on screening_v2.candidate_invites(session_id);

drop trigger if exists trg_v2_invites_updated on screening_v2.candidate_invites;
create trigger trg_v2_invites_updated before update on screening_v2.candidate_invites
  for each row execute function screening_v2.set_updated_at();

-- ── E. Candidate access grants ────────────────────────────────────────

create table if not exists screening_v2.candidate_access_grants (
  id            uuid primary key default gen_random_uuid(),
  candidate_id  uuid not null references screening_v2.candidates(id)
                on delete cascade,
  session_id    uuid not null references screening_v2.call_sessions(id)
                on delete cascade,
  room_name     text not null,
  token_digest  text not null,
  grant_type    text not null default 'view',
  expires_at    timestamptz not null,
  revoked_at    timestamptz,
  consumed_at   timestamptz,
  created_at    timestamptz not null default now(),
  constraint uq_candidate_grants_digest unique (token_digest),
  constraint chk_grant_token_digest check (token_digest ~ '^[a-f0-9]{64}$'),
  constraint chk_grant_type check (grant_type in ('view', 'screening')),
  constraint chk_grant_room_name check (room_name ~ '^screening-[0-9a-f-]{36}$'),
  constraint chk_grant_expiry check (expires_at > created_at)
);

alter table screening_v2.candidate_access_grants enable row level security;

comment on table screening_v2.candidate_access_grants is
  'Time-limited access grants for candidates to view their screening data. '
  'Only SHA-256 hex digest is stored — no plaintext token column. '
  'Never exposed through PostgREST (no SELECT grant to authenticated).';
comment on column screening_v2.candidate_access_grants.token_digest is
  'SHA-256 hex digest (64 chars) of the high-entropy access token.';
comment on column screening_v2.candidate_access_grants.grant_type is
  'view = candidate can view their screening results; '
  'screening = candidate can participate in screening (invite equivalent).';

create index if not exists idx_v2_grants_candidate
  on screening_v2.candidate_access_grants(candidate_id);
create index if not exists idx_v2_grants_digest
  on screening_v2.candidate_access_grants(token_digest);
create index if not exists idx_v2_grants_session
  on screening_v2.candidate_access_grants(session_id);

-- ── F. Audit events (append-only) ─────────────────────────────────────

create table if not exists screening_v2.audit_events (
  id              uuid primary key default gen_random_uuid(),
  actor_id        uuid not null,  -- auth.users UUID or known system sentinel
  actor_type      text not null,
  action          text not null,
  target_type     text not null,
  target_id       text not null,  -- opaque UUID or reference, never PII
  result          text not null,
  correlation_id  uuid,           -- groups related events
  metadata        jsonb,          -- bounded, no transcript/resume/PII/tokens/secrets
  created_at      timestamptz not null default now(),
  constraint chk_audit_actor_type check (
    actor_type in ('recruiter', 'system', 'candidate', 'api_key')
  ),
  constraint chk_audit_action check (
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
      'audit_sink_failure', 'audit_configuration_error'
    )
  ),
  constraint chk_audit_result check (
    result in ('success', 'failure', 'pending')
  ),
  constraint chk_audit_metadata_size check (
    metadata is null or octet_length(metadata::text) <= 4096
  )
);

alter table screening_v2.audit_events enable row level security;

comment on table screening_v2.audit_events is
  'Append-only audit log. No transcript, resume text, tokens, secrets, '
  'or raw PII may be stored in the metadata column. All actor/target IDs '
  'are opaque UUIDs or reference IDs, never personal data. UPDATE and '
  'DELETE operations are blocked at the trigger boundary.';

create index if not exists idx_v2_audit_actor
  on screening_v2.audit_events(actor_id, created_at);
create index if not exists idx_v2_audit_action
  on screening_v2.audit_events(action, created_at);
create index if not exists idx_v2_audit_correlation
  on screening_v2.audit_events(correlation_id);
create index if not exists idx_v2_audit_created
  on screening_v2.audit_events(created_at);

-- Audit mutation guard: blocks UPDATE/DELETE unconditionally.
-- Escape hatch: SET app.allow_audit_mutation = 'true' for emergency
-- migration/maintenance (documented below).
create or replace function screening_v2.prevent_audit_mutation()
returns trigger
language plpgsql
security invoker
set search_path = pg_catalog
as $$
begin
  if current_setting('app.allow_audit_mutation', true) = 'true' then
    return new;  -- allow for emergency migration only
  end if;
  raise exception 'audit_events is append-only: % not permitted', tg_op
    using errcode = 'P0001';
end;
$$;

drop trigger if exists trg_audit_prevent_update on screening_v2.audit_events;
create trigger trg_audit_prevent_update
  before update on screening_v2.audit_events
  for each row
  execute function screening_v2.prevent_audit_mutation();

drop trigger if exists trg_audit_prevent_delete on screening_v2.audit_events;
create trigger trg_audit_prevent_delete
  before delete on screening_v2.audit_events
  for each row
  execute function screening_v2.prevent_audit_mutation();

comment on function screening_v2.prevent_audit_mutation is
  'Blocks UPDATE/DELETE on audit_events. To allow migration/maintenance, '
  'set app.allow_audit_mutation = ''true'' via SET LOCAL in a dedicated '
  'session, perform the operation, then RESET. Never enable globally or '
  'in application connections.';

-- ── G. RLS policies for new tables ────────────────────────────────────

-- Candidate invites and grants are deliberately server-only. There are no
-- authenticated policies or grants: recruiter authorization and ownership are
-- enforced by the API before its server-only client touches these tables.
-- This prevents a future browser grant from silently exposing token digests.

-- audit_events: all active recruiters can read; no one can write via RLS
-- (writes are service_role only, mutations blocked by trigger).
create policy "recruiter read audit_events"
  on screening_v2.audit_events for select to authenticated
  using ((select screening_v2.is_active_recruiter()));

-- ── H. Grants for new tables ──────────────────────────────────────────

-- candidate_invites: only service_role has full access. No authenticated
-- grant or policy exposes token digests through PostgREST.
grant all privileges on screening_v2.candidate_invites to service_role;
grant usage on schema screening_v2 to authenticated;

-- candidate_access_grants: NEVER exposed through PostgREST.
grant all privileges on screening_v2.candidate_access_grants to service_role;
-- No authenticated grants for grants table — deliberately invisible to
-- PostgREST. Access is through backend API using service_role.

-- audit_events: authenticated can SELECT; writes are service_role only.
grant all privileges on screening_v2.audit_events to service_role;
grant select on screening_v2.audit_events to authenticated;

-- ── Verify schema reload ─────────────────────────────────────────────

notify pgrst, 'reload schema';
