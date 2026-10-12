-- R1 interview recording (R1-REC): the metadata, durable erase outbox and operational switch for
-- candidate camera video + both-side audio captured inside the R1 worker and stored in the private
-- Cloudflare R2 bucket `ik-r1-recordings` (objects live in R2; this file stores no media, no
-- credential and no presigned URL).
--
--   1. screening_v2.interview_round_recordings: one row per ATTEMPT session (a round can hold two).
--      Composite FK (session_id, round_id) -> interview_round_attempts so the pair can never
--      disagree; status machine preparing -> uploading -> finishing -> ready | partial | failed,
--      plus a `deleted` tombstone. `upload_id` is Secret-class (never returned, never logged).
--      `delete_after` is fixed per row at prepare time (created_at + retention days, max 90) so a
--      later env change can never extend a promise already made to a candidate.
--   2. screening_v2.r1_recording_purge: a durable erase outbox filled by a BEFORE DELETE row
--      trigger on the recordings table. Every FK above it cascades (candidate -> call_sessions ->
--      interview_round_attempts -> recordings), and row-level BEFORE DELETE triggers fire for
--      cascades too, so a candidate delete, a DSAR or an ops script can never strand R2 objects
--      without a durable erase request that `r1.sweep` drains.
--   3. screening_v2.r1_settings.recording_mode: the instant operational switch
--      (`off` default | `audio` | `av`). Recording happens only when ALL locks are open (API R2
--      secrets, worker R1_RECORDING / R1_VIDEO_RECORDING secrets, this column, and a live consent
--      containing `video_audio_recording`). Shipping this migration changes no behaviour.
--   4. Three trigger functions (security invoker, search_path pinned, execute revoked), all
--      enqueuing into screening_v2.job_queue like enqueue_r1_assessment (0116):
--        - enqueue_r1_recording_finalize: recording status -> 'finishing' => r1.recording.finalize.
--        - enqueue_r1_recording_erase: a consent withdrawn or declined => r1.recording.erase.
--          Keyed on proof->>'decision', NEVER on withdrawn_at alone: superseding a live consent
--          by a newer template also sets withdrawn_at (decision 'superseded') and must not erase.
--        - purge_on_r1_recording_delete: row delete => r1_recording_purge outbox row.
--
-- Dedup scope: uq_job_queue_dedup_active (0009) is PARTIAL over pending/active/delayed jobs, so a
-- dedup key only blocks a duplicate while a job with that key is still live; once it has
-- completed or failed the same key may be enqueued again (the sweep relies on this to re-drive a
-- stuck finalize). The erase key is per consent row (a consent can be withdrawn only once).
--
-- Rollback note: additive and forward-only (CI refuses edits to applied migrations; later fixes
-- are 0128+). To disable recording, unset the R1_RECORDING_S3_* API secrets (the recording routes
-- answer 503 r1_recording_disabled and /context reports mode off) and/or set recording_mode =
-- 'off'. NEVER drop these tables or the column while R2 objects exist: the rows are the erase and
-- retention index for those objects. The shared 0038 recording.finalize trigger requires a
-- recording_egress_id and therefore never fires for R1.
--
-- Idempotent: tables and the column are `if not exists`, triggers are dropped-if-exists then
-- created, functions are `create or replace`. Re-applying the same text is a no-op.
set local lock_timeout = '10s';

create table if not exists screening_v2.interview_round_recordings (
  session_id uuid primary key,
  round_id uuid not null,
  bucket text not null,
  prefix text not null,
  requested_mode text not null check (requested_mode in ('audio', 'av')),
  status text not null default 'preparing'
    check (status in ('preparing', 'uploading', 'finishing', 'ready', 'partial', 'failed', 'deleted')),
  layout text check (layout in ('combined', 'split', 'audio_only')),
  has_video boolean,
  -- SECRET: the multipart upload id is never returned to any client and never logged.
  upload_id text check (upload_id is null or length(upload_id) between 1 and 1024),
  parts_issued integer not null default 0 check (parts_issued between 0 and 60),
  urls_issued integer not null default 0 check (urls_issued between 0 and 400),
  -- The deliverable MP4 (server-validated at finalize).
  video_key text,
  video_bytes bigint check (video_bytes is null or video_bytes >= 0),
  video_sha256 text check (video_sha256 is null or video_sha256 ~ '^[a-f0-9]{64}$'),
  video_etag text,
  video_content_type text check (video_content_type is null or video_content_type in ('video/mp4', 'audio/mp4')),
  -- The OGG artefact, kept only when the MP4 cannot carry all the audio.
  audio_key text,
  audio_bytes bigint check (audio_bytes is null or audio_bytes >= 0),
  audio_sha256 text check (audio_sha256 is null or audio_sha256 ~ '^[a-f0-9]{64}$'),
  audio_etag text,
  -- Epoch ms of media t=0 (worker clock), the anchor for click-to-seek.
  started_at_ms bigint check (started_at_ms is null or started_at_ms between 1577836800000 and 4102444800000),
  -- Display-only worker report: an out-of-window value is stored as NULL by the API, never rejected.
  duration_ms integer check (duration_ms is null or duration_ms between 1 and 86400000),
  width integer check (width is null or width between 16 and 4096),
  height integer check (height is null or height between 16 and 4096),
  fps numeric(5, 2) check (fps is null or fps between 1 and 60),
  frames_encoded integer check (frames_encoded is null or frames_encoded between 0 and 10000000),
  frames_dropped integer check (frames_dropped is null or frames_dropped between 0 and 10000000),
  camera_off_ms integer check (camera_off_ms is null or camera_off_ms >= 0),
  degraded_at_ms integer check (degraded_at_ms is null or degraded_at_ms between 0 and 86400000),
  -- Advisory worker counters, compared with ListParts at finalize.
  reported_stream_bytes bigint check (reported_stream_bytes is null or reported_stream_bytes between 0 and 1099511627776),
  reported_parts integer check (reported_parts is null or reported_parts between 0 and 60),
  degraded_reason text check (degraded_reason is null or degraded_reason ~ '^[a-z0-9_.:-]{1,64}$'),
  failure_reason text check (failure_reason is null or failure_reason ~ '^[a-z0-9_.:-]{1,64}$'),
  finalize_attempts integer not null default 0 check (finalize_attempts >= 0),
  created_at timestamptz not null default now(),
  -- Application code sets updated_at on every write (no trigger).
  updated_at timestamptz not null default now(),
  finalize_requested_at timestamptz,
  finalized_at timestamptz,
  delete_after timestamptz not null,
  delete_requested_at timestamptz,
  delete_reason text check (delete_reason is null
    or delete_reason in ('retention', 'consent_withdrawn', 'dsar', 'row_deleted', 'admin')),
  deleted_at timestamptz,
  constraint fk_r1_recording_attempt foreign key (session_id, round_id)
    references screening_v2.interview_round_attempts (session_id, round_id) on delete cascade,
  constraint chk_r1_recording_prefix
    check (prefix = 'r1/' || round_id::text || '/' || session_id::text || '/'),
  constraint chk_r1_recording_keys check (
    (video_key is null or starts_with(video_key, prefix))
    and (audio_key is null or starts_with(audio_key, prefix))
  ),
  constraint chk_r1_recording_deleted check ((status = 'deleted') = (deleted_at is not null))
);

create index if not exists idx_r1_recordings_round
  on screening_v2.interview_round_recordings (round_id);
create index if not exists idx_r1_recordings_live
  on screening_v2.interview_round_recordings (updated_at)
  where status in ('preparing', 'uploading', 'finishing');
create index if not exists idx_r1_recordings_retention
  on screening_v2.interview_round_recordings (delete_after)
  where deleted_at is null;

create table if not exists screening_v2.r1_recording_purge (
  id uuid primary key default gen_random_uuid(),
  bucket text not null,
  prefix text not null,
  upload_id text,
  reason text not null,
  queued_at timestamptz not null default now(),
  attempts integer not null default 0,
  last_error_code text,
  done_at timestamptz
);
create index if not exists idx_r1_recording_purge_open
  on screening_v2.r1_recording_purge (queued_at)
  where done_at is null;

-- The operational switch. NOT NULL with a constant default is a metadata-only change; the
-- check restricts the value space (a value such as 'video' is rejected).
alter table screening_v2.r1_settings
  add column if not exists recording_mode text not null default 'off'
    constraint chk_r1_settings_recording_mode check (recording_mode in ('off', 'audio', 'av'));

-- 1. recording -> 'finishing' enqueues exactly one finalize job, atomically with the status flip.
create or replace function screening_v2.enqueue_r1_recording_finalize()
returns trigger
language plpgsql
security invoker
set search_path = pg_catalog
as $$
begin
  insert into screening_v2.job_queue (name, payload, dedup_key, max_attempts)
  values ('r1.recording.finalize', jsonb_build_object('session_id', new.session_id),
          'r1.recording.finalize:' || new.session_id::text, 5)
  on conflict do nothing;
  return new;
end;
$$;

drop trigger if exists enqueue_r1_recording_finalize on screening_v2.interview_round_recordings;
create trigger enqueue_r1_recording_finalize
  after update of status on screening_v2.interview_round_recordings
  for each row
  when (new.status = 'finishing' and old.status is distinct from 'finishing')
  execute function screening_v2.enqueue_r1_recording_finalize();

-- 2. A consent WITHDRAWN or DECLINED enqueues the erase of the round's recordings in the same
-- transaction as the withdrawal. The WHEN guard on proof->>'decision' is load-bearing:
-- superseding a live consent with a newer template also sets withdrawn_at (decision
-- 'superseded', r1-candidate.ts) and must NOT erase anything. r1_withdraw_consent (0120) sets
-- decision in the same UPDATE as withdrawn_at, so the trigger sees it. The erase handler
-- recomputes its scope at run time, so a dedup that collapses two jobs loses nothing.
create or replace function screening_v2.enqueue_r1_recording_erase()
returns trigger
language plpgsql
security invoker
set search_path = pg_catalog
as $$
begin
  insert into screening_v2.job_queue (name, payload, dedup_key, max_attempts)
  values ('r1.recording.erase',
          jsonb_build_object('round_id', new.round_id, 'reason', 'consent_withdrawn'),
          'r1.recording.erase:' || new.id::text, 5)
  on conflict do nothing;
  return new;
end;
$$;

drop trigger if exists enqueue_r1_recording_erase on screening_v2.interview_round_consents;
create trigger enqueue_r1_recording_erase
  after update of withdrawn_at on screening_v2.interview_round_consents
  for each row
  when (old.withdrawn_at is null and new.withdrawn_at is not null
        and new.proof ->> 'decision' in ('withdrawn', 'declined'))
  execute function screening_v2.enqueue_r1_recording_erase();

-- 3. Any row delete (including FK cascades) that still has objects to erase leaves a durable
-- outbox row. A tombstoned row (deleted_at set) has nothing left in R2 and queues nothing.
create or replace function screening_v2.purge_on_r1_recording_delete()
returns trigger
language plpgsql
security invoker
set search_path = pg_catalog
as $$
begin
  insert into screening_v2.r1_recording_purge (bucket, prefix, upload_id, reason)
  values (old.bucket, old.prefix, old.upload_id, 'row_deleted');
  return old;
end;
$$;

drop trigger if exists purge_on_r1_recording_delete on screening_v2.interview_round_recordings;
create trigger purge_on_r1_recording_delete
  before delete on screening_v2.interview_round_recordings
  for each row
  when (old.deleted_at is null)
  execute function screening_v2.purge_on_r1_recording_delete();

-- RLS on, no policies, service_role only: staff never read these tables directly, the API
-- (service role) enforces authorization in code (0115 pattern).
alter table screening_v2.interview_round_recordings enable row level security;
alter table screening_v2.r1_recording_purge enable row level security;

revoke all on screening_v2.interview_round_recordings, screening_v2.r1_recording_purge
  from public, anon, authenticated;
grant all privileges on screening_v2.interview_round_recordings, screening_v2.r1_recording_purge
  to service_role;

revoke all on function screening_v2.enqueue_r1_recording_finalize() from public, anon, authenticated;
revoke all on function screening_v2.enqueue_r1_recording_erase() from public, anon, authenticated;
revoke all on function screening_v2.purge_on_r1_recording_delete() from public, anon, authenticated;
