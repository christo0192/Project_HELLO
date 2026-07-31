-- =====================================================================
-- 0014 — Phase 7 L5: recording integrity / provenance / quarantine /
--        revocation / retention-tombstone columns + append-only
--        recording_integrity_events table (REC-03/04/05/06 + REC-01 half).
--
-- Forward-only and additive (C-1): every column is ADD COLUMN IF NOT EXISTS
-- and nullable; every CHECK is added NOT VALID then VALIDATE'd; the only
-- DROP ... IF EXISTS statements target constraints THIS migration re-creates
-- in the same chain. There is NO reverse SQL / down-migration — the
-- sanctioned recovery paths are fail-closed detection before acceptance,
-- clean reset / roll-forward from committed migrations, and approved
-- backup/restore. See docs/runbooks/supabase-migration-strategy.md.
--
-- DESIGN:
--   1. call_sessions gains integrity/provenance columns (REC-04):
--      sha256, size, content type, captured duration, synthetic object
--      version, provenance, verified_at, quarantined (+reason), revoked_at
--      (REC-05), deleted_at tombstone (REC-06, used by L6).
--   2. recording_integrity_events — append-only event log: uploaded,
--      verified, mismatch_quarantined, revoked, deleted, restored.
--   3. RLS: SELECT-only for active recruiters via is_active_recruiter();
--      writes are service_role-only. No anon/PUBLIC policy; no
--      authenticated write policy; no broad browser-role GRANT.
--   4. Partial indexes for quarantine/revocation scans + exactly-once unique
--      partial indexes for the per-session lifecycle events (deleted/revoked)
--      that make retry/backfill convergence DB-guaranteed.
--   5. Append-only mutation guard (UPDATE + direct DELETE blocked, cascade
--      delete from call_sessions preserved) mirroring 0007/0012.
--   6. Additive evolution of the 0007 audit_events action CHECK with the six
--      Phase 7 recording_* actions (recordAudit rows would otherwise fail).
-- =====================================================================

-- ═══════════════════════════════════════════════════════════════════════
-- 1. call_sessions integrity / provenance / lifecycle columns
-- ═══════════════════════════════════════════════════════════════════════

-- REC-04/01: SHA-256 hex digest of the recording object (computed at upload).
alter table screening_v2.call_sessions
  drop constraint if exists chk_call_sessions_recording_sha256;
alter table screening_v2.call_sessions
  add column if not exists recording_sha256 text;
alter table screening_v2.call_sessions
  add constraint chk_call_sessions_recording_sha256
    check (recording_sha256 is null or recording_sha256 ~ '^[a-f0-9]{64}$')
    not valid;
alter table screening_v2.call_sessions
  validate constraint chk_call_sessions_recording_sha256;

comment on column screening_v2.call_sessions.recording_sha256 is
  'REC-04/01: SHA-256 hex digest of the recording object bytes, computed at '
  'upload and verified on mismatch (fail-closed quarantine). Null before a '
  'recording is finalized.';

-- REC-04: byte size of the stored recording object.
alter table screening_v2.call_sessions
  drop constraint if exists chk_call_sessions_recording_size_bytes;
alter table screening_v2.call_sessions
  add column if not exists recording_size_bytes bigint;
alter table screening_v2.call_sessions
  add constraint chk_call_sessions_recording_size_bytes
    check (recording_size_bytes is null or recording_size_bytes >= 0)
    not valid;
alter table screening_v2.call_sessions
  validate constraint chk_call_sessions_recording_size_bytes;

comment on column screening_v2.call_sessions.recording_size_bytes is
  'REC-04: byte size of the stored recording object. Null before finalize.';

-- REC-04: canonical content type of the stored recording (audio set only).
alter table screening_v2.call_sessions
  drop constraint if exists chk_call_sessions_recording_content_type;
alter table screening_v2.call_sessions
  add column if not exists recording_content_type text;
alter table screening_v2.call_sessions
  add constraint chk_call_sessions_recording_content_type
    check (
      recording_content_type is null
      or recording_content_type in ('audio/webm','audio/ogg','audio/mpeg','audio/mp4')
    )
    not valid;
alter table screening_v2.call_sessions
  validate constraint chk_call_sessions_recording_content_type;

comment on column screening_v2.call_sessions.recording_content_type is
  'REC-04: canonical recording MIME type from the supported audio set. '
  'Null before finalize.';

-- REC-04: captured audio duration in whole seconds (distinct from the
-- session duration_sec column which measures the call itself).
alter table screening_v2.call_sessions
  drop constraint if exists chk_call_sessions_recording_captured_duration;
alter table screening_v2.call_sessions
  add column if not exists recording_captured_duration_sec integer;
alter table screening_v2.call_sessions
  add constraint chk_call_sessions_recording_captured_duration
    check (recording_captured_duration_sec is null or recording_captured_duration_sec >= 0)
    not valid;
alter table screening_v2.call_sessions
  validate constraint chk_call_sessions_recording_captured_duration;

comment on column screening_v2.call_sessions.recording_captured_duration_sec is
  'REC-04: captured recording duration in seconds. Null when unknown. '
  'Distinct from call_sessions.duration_sec (session call length).';

-- REC-04: object version identifier — populated synthetically today; true
-- object-level versioning (S3/R2 version IDs) remains external-pending.
alter table screening_v2.call_sessions
  drop constraint if exists chk_call_sessions_recording_object_version;
alter table screening_v2.call_sessions
  add column if not exists recording_object_version text;
alter table screening_v2.call_sessions
  add constraint chk_call_sessions_recording_object_version
    check (recording_object_version is null or length(recording_object_version) <= 256)
    not valid;
alter table screening_v2.call_sessions
  validate constraint chk_call_sessions_recording_object_version;

comment on column screening_v2.call_sessions.recording_object_version is
  'REC-04: recording object version token. Populated synthetically for now; '
  'real provider version IDs are external-pending.';

-- REC-01/04: recording provenance (how the object arrived).
alter table screening_v2.call_sessions
  drop constraint if exists chk_call_sessions_recording_provenance;
alter table screening_v2.call_sessions
  add column if not exists recording_provenance text;
alter table screening_v2.call_sessions
  add constraint chk_call_sessions_recording_provenance
    check (
      recording_provenance is null
      or recording_provenance in ('browser_upload','livekit_egress')
    )
    not valid;
alter table screening_v2.call_sessions
  validate constraint chk_call_sessions_recording_provenance;

comment on column screening_v2.call_sessions.recording_provenance is
  'REC-01/04: origin of the recording object: browser_upload (secondary/'
  'degraded path, built) or livekit_egress (primary server-side path, '
  'external-pending). Null before finalize.';

-- REC-04: when integrity was verified (upload-time digest computed).
alter table screening_v2.call_sessions
  add column if not exists recording_integrity_verified_at timestamptz;

comment on column screening_v2.call_sessions.recording_integrity_verified_at is
  'REC-04: timestamp when the recording digest was verified. Null before '
  'finalize. On-download re-verification is a synthetic hook (plan §5.2).';

-- REC-04: fail-closed quarantine flag — a quarantined recording is never
-- served. Default false backfills existing rows in-place (safe additive DDL).
alter table screening_v2.call_sessions
  add column if not exists recording_quarantined boolean not null default false;

comment on column screening_v2.call_sessions.recording_quarantined is
  'REC-04: true when the recording is quarantined (integrity mismatch or '
  'manual hold). Quarantined objects are never served (409 on mint).';

-- REC-04: human-readable quarantine reason (bounded).
alter table screening_v2.call_sessions
  drop constraint if exists chk_call_sessions_recording_quarantine_reason;
alter table screening_v2.call_sessions
  add column if not exists recording_quarantine_reason text;
alter table screening_v2.call_sessions
  add constraint chk_call_sessions_recording_quarantine_reason
    check (recording_quarantine_reason is null or length(recording_quarantine_reason) <= 200)
    not valid;
alter table screening_v2.call_sessions
  validate constraint chk_call_sessions_recording_quarantine_reason;

comment on column screening_v2.call_sessions.recording_quarantine_reason is
  'REC-04: bounded quarantine reason (e.g. digest mismatch). Never includes '
  'object keys, URLs, or tokens.';

-- REC-05: session-scoped immediate-revocation signal. Denies NEW signed-URL
-- mints on both recruiter-download and candidate-grant paths; existing URLs
-- expire naturally within their short TTL.
alter table screening_v2.call_sessions
  add column if not exists recording_revoked_at timestamptz;

comment on column screening_v2.call_sessions.recording_revoked_at is
  'REC-05: when recording access was revoked. Non-null denies new signed-URL '
  'mints (403) while set; existing short-TTL URLs expire naturally.';

-- REC-06: erasure tombstone (forward-compat with L6 retention/erasure).
-- A deleted recording is 404 on every mint path and can never be resurrected.
alter table screening_v2.call_sessions
  add column if not exists recording_deleted_at timestamptz;

comment on column screening_v2.call_sessions.recording_deleted_at is
  'REC-06: erasure tombstone. Non-null ⇒ object erased (L6 synthetic storage) '
  'and never re-mintable (404). Forward-compat: L5 only reads this column.';

-- ═══════════════════════════════════════════════════════════════════════
-- 2. recording_integrity_events — append-only integrity event log
-- ═══════════════════════════════════════════════════════════════════════

create table if not exists screening_v2.recording_integrity_events (
  id uuid primary key default gen_random_uuid(),
  session_id uuid not null references screening_v2.call_sessions(id)
    on delete cascade,
  event_type text not null,
  sha256_expected text,
  sha256_actual text,
  size_bytes bigint,
  detail text,
  correlation_id text,
  created_at timestamptz not null default now(),
  constraint chk_recording_integrity_events_event_type
    check (event_type in (
      'uploaded','verified','mismatch_quarantined','revoked','deleted','restored'
    ))
);

comment on table screening_v2.recording_integrity_events is
  'REC-04: append-only recording integrity event log. Written exclusively by '
  'the service-role backend; recruiters get SELECT-only (membership-gated).';

comment on column screening_v2.recording_integrity_events.event_type is
  'Event kind: uploaded, verified, mismatch_quarantined, revoked, deleted, '
  'restored.';
comment on column screening_v2.recording_integrity_events.sha256_expected is
  'Digest the object was expected to have (from the event context).';
comment on column screening_v2.recording_integrity_events.sha256_actual is
  'Digest actually observed (mismatch_quarantined).';
comment on column screening_v2.recording_integrity_events.detail is
  'Bounded event detail — never object keys, URLs, or tokens.';
comment on column screening_v2.recording_integrity_events.correlation_id is
  'Request correlation id for traceability (not PII).';

create index if not exists idx_v2_recording_integrity_events_session
  on screening_v2.recording_integrity_events (session_id, created_at);

-- ═══════════════════════════════════════════════════════════════════════
-- 3. Partial indexes for quarantine / revocation scans
-- ═══════════════════════════════════════════════════════════════════════

create index if not exists idx_v2_sessions_quarantined
  on screening_v2.call_sessions (id)
  where recording_quarantined = true;

create index if not exists idx_v2_sessions_recording_revoked
  on screening_v2.call_sessions (id)
  where recording_revoked_at is not null;

-- ═══════════════════════════════════════════════════════════════════════
-- 3b. Exactly-once lifecycle events (retry-convergence, F1/F2/F3)
--
-- 'deleted' (REC-06 erasure) and 'revoked' (REC-05 revocation) are
-- one-per-session lifecycle events. The unique partial indexes make the
-- append-only log EXACTLY-ONCE for these kinds: a retry that backfills a
-- missing event after a partial write collides (23505) instead of appending
-- a duplicate — this is the DB-level convergence guard the service layer
-- relies on (see lib/retention.ts eraseRecording/revokeRecording).
-- 'uploaded'/'mismatch_quarantined' stay non-unique: a session can
-- legitimately record multiple mismatch events over its lifetime and the
-- upload event is bound to the single upload transition.
-- ═══════════════════════════════════════════════════════════════════════

create unique index if not exists uq_v2_recording_integrity_events_deleted_once
  on screening_v2.recording_integrity_events (session_id)
  where event_type = 'deleted';

create unique index if not exists uq_v2_recording_integrity_events_revoked_once
  on screening_v2.recording_integrity_events (session_id)
  where event_type = 'revoked';

-- ═══════════════════════════════════════════════════════════════════════
-- 4. RLS & grants (static-gate-compliant)
-- ═══════════════════════════════════════════════════════════════════════

-- The new call_sessions columns inherit the existing table RLS (0001) and
-- the scoped recruiter-read policy (0007); no new authenticated-write policy
-- is added for call_sessions.

-- Append-only mutation guard for recording_integrity_events (REC-04, F1/F2/F3
-- repair): UPDATE and direct DELETE are blocked at the trigger boundary for
-- EVERY role (including service_role — accidental service-layer mutation is
-- prevented), mirroring audit_events (0007) / governance_audit (0012).
--
-- FK / retention semantics are PRESERVED: an ON DELETE CASCADE from
-- call_sessions (the sanctioned way rows leave the log when a session row is
-- removed) is detected by checking whether the parent row still exists at
-- cascade time — the parent is already gone, so the child delete is allowed.
-- A direct DELETE while the parent still exists is blocked. TRUNCATE does not
-- fire row triggers and is unchanged. Escape hatch:
-- SET LOCAL app.allow_recording_integrity_mutation = 'true' for emergency
-- migration/maintenance only; never enable globally or in app connections.
create or replace function screening_v2.prevent_recording_integrity_mutation()
returns trigger
language plpgsql
security invoker
set search_path = pg_catalog
as $$
begin
  if current_setting('app.allow_recording_integrity_mutation', true) = 'true' then
    return coalesce(new, old);  -- allow for emergency migration only
  end if;
  if tg_op = 'UPDATE' then
    raise exception 'recording_integrity_events is append-only: UPDATE not permitted'
      using errcode = 'P0001';
  end if;
  if tg_op = 'DELETE' then
    -- Preserve FK retention semantics: allow a cascade delete from the
    -- parent call_sessions row (parent already gone at cascade time).
    if exists (select 1 from screening_v2.call_sessions where id = old.session_id) then
      raise exception 'recording_integrity_events is append-only: DELETE not permitted'
        using errcode = 'P0001';
    end if;
    return old;
  end if;
  return new;
end;
$$;

drop trigger if exists trg_recording_integrity_prevent_update
  on screening_v2.recording_integrity_events;
create trigger trg_recording_integrity_prevent_update
  before update on screening_v2.recording_integrity_events
  for each row
  execute function screening_v2.prevent_recording_integrity_mutation();

drop trigger if exists trg_recording_integrity_prevent_delete
  on screening_v2.recording_integrity_events;
create trigger trg_recording_integrity_prevent_delete
  before delete on screening_v2.recording_integrity_events
  for each row
  execute function screening_v2.prevent_recording_integrity_mutation();

comment on function screening_v2.prevent_recording_integrity_mutation is
  'Blocks UPDATE and direct DELETE on recording_integrity_events; allows the '
  'sanctioned ON DELETE CASCADE from call_sessions (parent-gone check). To '
  'allow emergency migration/maintenance, set '
  'app.allow_recording_integrity_mutation = ''true'' via SET LOCAL in a '
  'dedicated session, then RESET. Never enable globally or in application '
  'connections.';

alter table screening_v2.recording_integrity_events enable row level security;

-- SELECT-only, membership-gated: an active recruiter may read integrity
-- events; writes are service_role-only (no authenticated write policy).
drop policy if exists "active recruiter read recording_integrity_events"
  on screening_v2.recording_integrity_events;
create policy "active recruiter read recording_integrity_events"
  on screening_v2.recording_integrity_events for select to authenticated
  using ((select screening_v2.is_active_recruiter()));

grant all privileges on screening_v2.recording_integrity_events to service_role;
grant select on screening_v2.recording_integrity_events to authenticated;

-- ═══════════════════════════════════════════════════════════════════════
-- 5. audit_events action-CHECK evolution (additive, 0014)
--
-- Phase 7 introduces six recording lifecycle audit actions in TS
-- (recording.download / upload / integrity_verified / quarantined /
-- revoked / deleted — see lib/audit.ts). Migration 0007's chk_audit_action
-- predates them, so without this additive evolution the DB-backed audit
-- sink would reject every Phase 7 recording audit row (and fail-closed
-- mutations would abort). The CHECK is re-created with the SAME name and
-- the full 0007 action list PLUS the six recording_* actions. This is the
-- sanctioned replaceable data-guard evolution pattern (drop-guarded IF
-- EXISTS + re-create in the same chain — no reverse SQL; existing rows all
-- satisfy the widened list).
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
      'recording_quarantined', 'recording_revoked', 'recording_deleted'
    )
  )
  not valid;
alter table screening_v2.audit_events
  validate constraint chk_audit_action;

comment on constraint chk_audit_action on screening_v2.audit_events is
  'Audit action allowlist — extended additively by 0014 with the Phase 7 '
  'recording_* lifecycle actions (download/upload/integrity_verified/'
  'quarantined/revoked/deleted).';

-- ═══════════════════════════════════════════════════════════════════════
-- 6. Atomic finalization RPCs (service-role-only, F-A / F-B repair)
--
-- F-A: `finalize_recording_upload` atomically links a storage object to
--   a session (CAS: only when recording_object_key IS NULL) AND inserts
--   the exactly-one 'uploaded' integrity event in a single transaction.
--   The caller MUST have already uploaded the object to storage; if this
--   RPC fails the caller must delete the orphaned object (compensation).
--   The FOR UPDATE lock serialises concurrent uploads so exactly one
--   wins; the unique partial index `uq_v2_recording_integrity_events_uploaded_once`
--   is the DB-level safety net.
--
-- F-B: `quarantine_recording` atomically flips recording_quarantined
--   (CAS: only when currently false) AND inserts the exactly-one
--   'mismatch_quarantined' integrity event in a single transaction.
--   The FOR UPDATE lock serialises concurrent quarantine attempts; the
--   unique partial index `uq_v2_recording_integrity_events_mismatch_once`
--   is the DB-level safety net. A concurrent loser (already_quarantined)
--   receives 'already_quarantined' so the caller can skip duplicate
--   evidence and still deny (409).
-- ═══════════════════════════════════════════════════════════════════════

create or replace function screening_v2.finalize_recording_upload(
  p_session_id uuid,
  p_object_key text,
  p_sha256 text,
  p_size_bytes bigint,
  p_content_type text,
  p_provenance text,
  p_correlation_id text
)
returns jsonb
language plpgsql
security definer
set search_path = pg_catalog, screening_v2
as $$
declare
  v_existing_key text;
begin
  -- Lock the session row to serialise concurrent upload finalizations.
  select recording_object_key into v_existing_key
    from screening_v2.call_sessions
   where id = p_session_id
     for update;

  if not found then
    return jsonb_build_object('status', 'session_not_found');
  end if;

  -- CAS: reject if a recording is already linked.
  if v_existing_key is not null then
    return jsonb_build_object('status', 'recording_already_exists');
  end if;

  -- Link the object to the session.
  update screening_v2.call_sessions
     set recording_object_key = p_object_key,
         recording_sha256 = p_sha256,
         recording_size_bytes = p_size_bytes,
         recording_content_type = p_content_type,
         recording_provenance = p_provenance,
         recording_integrity_verified_at = now()
   where id = p_session_id;

  -- Append the exactly-one 'uploaded' integrity event.
  insert into screening_v2.recording_integrity_events
    (session_id, event_type, sha256_expected, size_bytes, detail, correlation_id)
  values
    (p_session_id, 'uploaded', p_sha256, p_size_bytes,
     'browser_upload verified sha256:' || left(p_sha256, 16) || chr(8230),
     p_correlation_id);

  return jsonb_build_object('status', 'ok');
end;
$$;

revoke all on function screening_v2.finalize_recording_upload from public, anon, authenticated;
grant execute on function screening_v2.finalize_recording_upload to service_role;

comment on function screening_v2.finalize_recording_upload is
  'F-A repair (Phase 7 quality): atomically links a storage object to a '
  'session (CAS on recording_object_key IS NULL) and inserts the exactly-one '
  '''''uploaded'''' integrity event. Service-role-only. The caller must compensate '
  '(delete the storage object) on failure. FOR UPDATE serialises concurrent '
  'uploads.';

-- ──

create or replace function screening_v2.quarantine_recording(
  p_session_id uuid,
  p_reason text,
  p_expected_sha256 text,
  p_actual_sha256 text,
  p_size_bytes bigint,
  p_correlation_id text
)
returns jsonb
language plpgsql
security definer
set search_path = pg_catalog, screening_v2
as $$
declare
  v_quarantined boolean;
begin
  -- Lock the session row to serialise concurrent quarantine attempts.
  select recording_quarantined into v_quarantined
    from screening_v2.call_sessions
   where id = p_session_id
     for update;

  if not found then
    return jsonb_build_object('status', 'session_not_found');
  end if;

  -- CAS: if already quarantined, no duplicate evidence.
  if v_quarantined then
    return jsonb_build_object('status', 'already_quarantined');
  end if;

  -- Flip the flag.
  update screening_v2.call_sessions
     set recording_quarantined = true,
         recording_quarantine_reason = p_reason
   where id = p_session_id;

  -- Insert exactly-one mismatch event.
  insert into screening_v2.recording_integrity_events
    (session_id, event_type, sha256_expected, sha256_actual,
     size_bytes, detail, correlation_id)
  values
    (p_session_id, 'mismatch_quarantined', p_expected_sha256, p_actual_sha256,
     p_size_bytes, p_reason, p_correlation_id);

  return jsonb_build_object('status', 'quarantined');
end;
$$;

revoke all on function screening_v2.quarantine_recording from public, anon, authenticated;
grant execute on function screening_v2.quarantine_recording to service_role;

comment on function screening_v2.quarantine_recording is
  'F-B repair (Phase 7 quality): atomically flips recording_quarantined '
  '(CAS: only when currently false) and inserts the exactly-one '
  '''''mismatch_quarantined'''' integrity event. Service-role-only. On RPC '
  'failure the caller must mint NO URL and leave the prior clean state retryable.';

-- ═══════════════════════════════════════════════════════════════════════
-- 6b. Exactly-once unique partial indexes — DB-level convergence guard
--     for 'uploaded' and 'mismatch_quarantined' (F-A / F-B repair).
--     'deleted' and 'revoked' were added in §3b above.
-- ═══════════════════════════════════════════════════════════════════════

create unique index if not exists uq_v2_recording_integrity_events_uploaded_once
  on screening_v2.recording_integrity_events (session_id)
  where event_type = 'uploaded';

create unique index if not exists uq_v2_recording_integrity_events_mismatch_once
  on screening_v2.recording_integrity_events (session_id)
  where event_type = 'mismatch_quarantined';

-- ═══════════════════════════════════════════════════════════════════════
-- 7. Browser-upload coherence constraint (quality repair)
--
-- When provenance is 'browser_upload' the digest/size/key columns MUST be
-- non-null so the download-time re-verify path can safely compute bounds.
-- Legacy null rows (no recording / pre-0014 rows) are unaffected — the
-- constraint only fires for provenance='browser_upload'.
-- ═══════════════════════════════════════════════════════════════════════

alter table screening_v2.call_sessions
  drop constraint if exists chk_call_sessions_browser_upload_coherence;
alter table screening_v2.call_sessions
  add constraint chk_call_sessions_browser_upload_coherence
    check (
      recording_provenance is distinct from 'browser_upload'
      or (
        recording_object_key is not null
        and recording_sha256 is not null
        and recording_sha256 ~ '^[a-f0-9]{64}$'
        and recording_size_bytes is not null
        and recording_size_bytes >= 0
        and recording_content_type is not null
      )
    )
    not valid;
alter table screening_v2.call_sessions
  validate constraint chk_call_sessions_browser_upload_coherence;

comment on constraint chk_call_sessions_browser_upload_coherence
  on screening_v2.call_sessions is
  'Quality repair (F-A): browser_upload provenance rows must have non-null '
  'object_key, sha256, size_bytes, and content_type so the download-time '
  're-verify bound computations are safe. Legacy null rows are unaffected.';

-- ═══════════════════════════════════════════════════════════════════════
-- 8. recording_orphaned_objects — backend-only orphan-cleanup table (F-C)
--
-- When upload finalization fails after storage upload AND the compensation
-- delete also fails, the orphaned object key is recorded HERE (never in
-- recruiter-readable integrity_events). This table has NO authenticated/
-- anon policy — only service_role can read/write. A unique constraint on
-- object_key prevents duplicate orphan rows (idempotent upsert).
-- ═══════════════════════════════════════════════════════════════════════

create table if not exists screening_v2.recording_orphaned_objects (
  id uuid primary key default gen_random_uuid(),
  session_id uuid not null references screening_v2.call_sessions(id)
    on delete cascade,
  object_key text not null,
  sha256 text,
  size_bytes bigint,
  content_type text,
  status text not null default 'pending_cleanup'
    check (status in ('pending_cleanup','cleaned_up')),
  error_detail text,
  correlation_id text,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  constraint uq_recording_orphaned_objects_object_key
    unique (object_key)
);

comment on table screening_v2.recording_orphaned_objects is
  'F-C repair (Phase 7 quality): backend-only orphaned storage-object '
  'registry. Written when both upload finalization AND compensation delete '
  'fail. NEVER exposes object keys to recruiters — RLS has zero '
  'authenticated/anon policy. A reconciliation job cleans these up.';

comment on column screening_v2.recording_orphaned_objects.object_key is
  'Storage object key of the orphaned upload. Needed for manual/automated '
  'cleanup. NOT recruiter-readable.';

comment on column screening_v2.recording_orphaned_objects.status is
  'pending_cleanup: orphan needs bucket-manifest reconciliation. '
  'cleaned_up: reconciliation job has removed the storage object.';

-- RLS: backend-only — zero authenticated/anon policy.
alter table screening_v2.recording_orphaned_objects enable row level security;

grant all privileges on screening_v2.recording_orphaned_objects to service_role;
-- No GRANT to authenticated or anon. No policy for any role but service_role.

-- ═══════════════════════════════════════════════════════════════════════
-- Verifier: schema reload notification
-- ═══════════════════════════════════════════════════════════════════════

notify pgrst, 'reload schema';
