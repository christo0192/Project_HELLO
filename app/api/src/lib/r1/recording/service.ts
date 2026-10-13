/**
 * Row operations of the R1 recording state machine (IMPLEMENTER-RULES C3, C4, C11).
 *
 *   preparing -> uploading -> finishing -> ready | partial | failed        (+ the `deleted` tombstone)
 *
 * Every transition is a compare-and-set on the row, written so that two requests racing for the
 * same session (a worker retry that overlaps the original call, two API machines) cannot both win:
 * `.update(...).eq(...).select()` answers the rows it really changed, and the caller compares the
 * count. Nothing here reads or returns a presigned URL; `upload_id` is Secret-class and only ever
 * flows from the database to the object store.
 *
 * Failures are reported as {@link R1RecordingDbError}: a closed message with no provider text, row
 * data or id in it, so it is safe to log or map to a job error code.
 */

import { isRecordingMode, type R1RecordingMode } from './keys.js';

export type R1RecordingStatus = 'preparing' | 'uploading' | 'finishing' | 'ready' | 'partial' | 'failed' | 'deleted';
export type R1RecordingLayout = 'combined' | 'split' | 'audio_only';

/** The slice of the Supabase client this module needs (the real singleton satisfies it). */
export interface R1RecordingDb {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  from(table: string): any;
}

export interface R1RecordingRow {
  session_id: string;
  round_id: string;
  bucket: string;
  prefix: string;
  requested_mode: R1RecordingMode;
  status: R1RecordingStatus;
  layout: R1RecordingLayout | null;
  has_video: boolean | null;
  /** SECRET: never returned, never logged. */
  upload_id: string | null;
  parts_issued: number;
  urls_issued: number;
  video_key: string | null;
  video_bytes: number | null;
  video_sha256: string | null;
  video_etag: string | null;
  video_content_type: string | null;
  audio_key: string | null;
  audio_bytes: number | null;
  audio_sha256: string | null;
  audio_etag: string | null;
  started_at_ms: number | null;
  duration_ms: number | null;
  width: number | null;
  height: number | null;
  fps: number | null;
  frames_encoded: number | null;
  frames_dropped: number | null;
  camera_off_ms: number | null;
  degraded_at_ms: number | null;
  reported_stream_bytes: number | null;
  reported_parts: number | null;
  degraded_reason: string | null;
  failure_reason: string | null;
  finalize_attempts: number;
  created_at: string;
  updated_at: string;
  finalize_requested_at: string | null;
  finalized_at: string | null;
  delete_after: string;
  delete_requested_at: string | null;
  delete_reason: string | null;
  deleted_at: string | null;
}

export const RECORDINGS_TABLE = 'interview_round_recordings';

/** A database read or write failed. The message is a fixed code; nothing about the row is in it. */
export class R1RecordingDbError extends Error {
  constructor() {
    super('r1_recording_db_error');
    this.name = 'R1RecordingDbError';
  }
}

/** A `preparing` row with no upload id older than this was abandoned mid-prepare and may be re-claimed. */
export const PREPARE_STALE_MS = 60_000;

/** `off < audio < av`. */
export function modeRank(mode: 'off' | R1RecordingMode): number {
  return mode === 'av' ? 2 : mode === 'audio' ? 1 : 0;
}

export function asRecordingMode(value: unknown): 'off' | R1RecordingMode {
  return isRecordingMode(value) ? value : 'off';
}

// ---------------------------------------------------------------- vocabularies (C11)

/** What the worker may report as `failure_reason`. Anything else is stored as NULL, never rejected. */
export const WORKER_FAILURE_REASONS: readonly string[] = [
  'encoder_unavailable',
  'encoder_crashed',
  'upload_failed',
  'spool_disk_full',
  'finish_timeout',
  'prepare_failed',
];
/** Reasons only the server may set (finalize, sweep, playback quarantine). */
export const SERVER_FAILURE_REASONS: readonly string[] = [
  'worker_lost',
  'nothing_uploaded',
  'oversize',
  'finalize_exhausted',
  'object_missing',
  'integrity',
];
export const DEGRADED_REASONS: readonly string[] = [
  'cpu_loop_lag',
  'cpu_vad_slow',
  'frame_drops',
  'upload_backlog',
  'encoder_stalled',
  'video_unavailable',
];

export function workerFailureReason(value: unknown): string | null {
  return typeof value === 'string' && WORKER_FAILURE_REASONS.includes(value) ? value : null;
}
export function degradedReason(value: unknown): string | null {
  return typeof value === 'string' && DEGRADED_REASONS.includes(value) ? value : null;
}

// ---------------------------------------------------------------- the worker's report

export interface R1SanitizedReport {
  started_at_ms: number | null;
  duration_ms: number | null;
  width: number | null;
  height: number | null;
  fps: number | null;
  frames_encoded: number | null;
  frames_dropped: number | null;
  camera_off_ms: number | null;
  degraded_at_ms: number | null;
  reported_stream_bytes: number | null;
  reported_parts: number | null;
}

function windowed(value: unknown, min: number, max: number, decimals = 0): number | null {
  if (typeof value !== 'number' || !Number.isFinite(value)) return null;
  const scale = 10 ** decimals;
  const rounded = Math.round(value * scale) / scale;
  return rounded >= min && rounded <= max ? rounded : null;
}

/**
 * The worker's `report` is DISPLAY-ONLY data. A value outside the window the database accepts is
 * dropped to NULL here (never a 400, never a 500 from a CHECK): the recording itself must not be
 * lost because a counter overflowed. Unknown keys are ignored.
 */
export function sanitizeCompleteReport(raw: unknown): R1SanitizedReport {
  const report = raw !== null && typeof raw === 'object' && !Array.isArray(raw) ? (raw as Record<string, unknown>) : {};
  return {
    started_at_ms: windowed(report.started_at_ms, 1_577_836_800_000, 4_102_444_800_000),
    duration_ms: windowed(report.duration_ms, 1, 86_400_000),
    width: windowed(report.width, 16, 4096),
    height: windowed(report.height, 16, 4096),
    fps: windowed(report.fps, 1, 60, 2),
    frames_encoded: windowed(report.frames_encoded, 0, 10_000_000),
    frames_dropped: windowed(report.frames_dropped, 0, 10_000_000),
    camera_off_ms: windowed(report.camera_off_ms, 0, 86_400_000),
    degraded_at_ms: windowed(report.degraded_at_ms, 0, 86_400_000),
    reported_stream_bytes: windowed(report.stream_bytes, 0, 1_099_511_627_776),
    reported_parts: windowed(report.parts_uploaded, 0, 60),
  };
}

// ---------------------------------------------------------------- reads and writes

function fail(): never {
  throw new R1RecordingDbError();
}

export async function loadRecording(db: R1RecordingDb, sessionId: string): Promise<R1RecordingRow | null> {
  const { data, error } = await db.from(RECORDINGS_TABLE).select('*').eq('session_id', sessionId).maybeSingle();
  if (error) fail();
  return (data as R1RecordingRow | null) ?? null;
}

export interface NewRecordingRow {
  session_id: string;
  round_id: string;
  bucket: string;
  prefix: string;
  requested_mode: R1RecordingMode;
  delete_after: string;
  now: string;
}

/** Insert the `preparing` row. `null` = the row already exists (the unique violation); anything else throws. */
export async function insertPreparingRow(db: R1RecordingDb, input: NewRecordingRow): Promise<R1RecordingRow | null> {
  const { data, error } = await db
    .from(RECORDINGS_TABLE)
    .insert({
      session_id: input.session_id,
      round_id: input.round_id,
      bucket: input.bucket,
      prefix: input.prefix,
      requested_mode: input.requested_mode,
      status: 'preparing',
      delete_after: input.delete_after,
      created_at: input.now,
      updated_at: input.now,
    })
    .select('*')
    .single();
  if (error) {
    if ((error as { code?: unknown }).code === '23505') return null;
    fail();
  }
  return data as R1RecordingRow;
}

/** Take over an abandoned `preparing` row. Exactly one of several racing callers gets `true`. */
export async function claimStalePrepare(db: R1RecordingDb, row: R1RecordingRow, now: string): Promise<boolean> {
  const { data, error } = await db
    .from(RECORDINGS_TABLE)
    .update({ updated_at: now })
    .eq('session_id', row.session_id)
    .eq('status', 'preparing')
    .is('upload_id', null)
    .eq('updated_at', row.updated_at)
    .select('session_id');
  if (error) fail();
  return Array.isArray(data) && data.length === 1;
}

/** Record the multipart upload id and open the row for uploads. `null` = somebody else got there first. */
export async function casUploadStart(db: R1RecordingDb, sessionId: string, uploadId: string, now: string): Promise<R1RecordingRow | null> {
  const { data, error } = await db
    .from(RECORDINGS_TABLE)
    .update({ upload_id: uploadId, status: 'uploading', updated_at: now })
    .eq('session_id', sessionId)
    .eq('status', 'preparing')
    .is('upload_id', null)
    .is('deleted_at', null)
    .is('delete_requested_at', null)
    .select('*');
  if (error) fail();
  return Array.isArray(data) && data.length === 1 ? (data[0] as R1RecordingRow) : null;
}

/**
 * Give up a claim on a `preparing` row after CreateMultipartUpload failed: back-date `updated_at`
 * past {@link PREPARE_STALE_MS} so the worker's retry (about a second later) can re-claim it instead
 * of waiting a minute. Best effort: a failure only means the retry waits for the normal staleness.
 */
export async function releasePrepareClaim(db: R1RecordingDb, sessionId: string, nowMs: number): Promise<void> {
  try {
    await db
      .from(RECORDINGS_TABLE)
      .update({ updated_at: new Date(nowMs - 2 * PREPARE_STALE_MS).toISOString() })
      .eq('session_id', sessionId)
      .eq('status', 'preparing')
      .is('upload_id', null);
  } catch {
    /* best effort */
  }
}

/** Advance the issue counters from exactly the values that were read. `false` = lost the race; re-read and retry. */
export async function casIssue(
  db: R1RecordingDb,
  row: R1RecordingRow,
  next: { parts_issued: number; urls_issued: number },
  now: string,
): Promise<boolean> {
  const { data, error } = await db
    .from(RECORDINGS_TABLE)
    .update({ parts_issued: next.parts_issued, urls_issued: next.urls_issued, updated_at: now })
    .eq('session_id', row.session_id)
    .eq('status', 'uploading')
    .eq('parts_issued', row.parts_issued)
    .eq('urls_issued', row.urls_issued)
    .is('deleted_at', null)
    .is('delete_requested_at', null)
    .select('session_id');
  if (error) fail();
  return Array.isArray(data) && data.length === 1;
}

export interface CompleteInput {
  layout: R1RecordingLayout;
  has_video: boolean;
  failure_reason: string | null;
  degraded_reason: string | null;
  report: R1SanitizedReport;
  now: string;
}

/** `preparing | uploading -> finishing` (the 0127 trigger enqueues the finalize job in the same transaction). */
export async function casComplete(db: R1RecordingDb, sessionId: string, input: CompleteInput): Promise<R1RecordingRow | null> {
  const { data, error } = await db
    .from(RECORDINGS_TABLE)
    .update({
      status: 'finishing',
      layout: input.layout,
      has_video: input.has_video,
      failure_reason: input.failure_reason,
      degraded_reason: input.degraded_reason,
      ...input.report,
      finalize_requested_at: input.now,
      updated_at: input.now,
    })
    .eq('session_id', sessionId)
    .in('status', ['preparing', 'uploading'])
    .is('deleted_at', null)
    .is('delete_requested_at', null)
    .select('*');
  if (error) fail();
  return Array.isArray(data) && data.length === 1 ? (data[0] as R1RecordingRow) : null;
}

/** Ask for the recording to be erased (consent gone). Never changes `status`; the erase job does the work. */
export async function markDeleteRequested(db: R1RecordingDb, sessionId: string, reason: string, now: string): Promise<void> {
  const { error } = await db
    .from(RECORDINGS_TABLE)
    .update({ delete_requested_at: now, delete_reason: reason, updated_at: now })
    .eq('session_id', sessionId)
    .is('delete_requested_at', null)
    .is('deleted_at', null);
  if (error) fail();
}

/** True once the recording is gone or on its way out: no new capability may be issued for it. */
export function isGoneOrLeaving(row: R1RecordingRow): boolean {
  return row.status === 'deleted' || row.deleted_at !== null || row.delete_requested_at !== null;
}
