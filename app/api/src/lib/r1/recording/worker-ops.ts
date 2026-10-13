/**
 * The four worker-facing operations of the R1 recording lane (IMPLEMENTER-RULES C4), free of Express
 * so they can be driven directly by tests: `prepare`, `part-url`, `object-url` and `complete`.
 *
 * Each returns {@link OpResult}: a value for the route to serialise, or the exact status and code
 * the contract names. Nothing here ever returns the multipart `upload_id`, an object key, the
 * bucket or an ETag; a presigned URL is returned only by the two URL operations, and only to the
 * route that hands it to the worker (never logged, never audited).
 *
 * Concurrency. `prepare` is the one place two callers can legitimately race (a worker retry that
 * overlaps the original request, two API machines): the row insert is the arbiter (unique session
 * id), the inserter alone calls CreateMultipartUpload, and the `upload_id` compare-and-set decides
 * a tie, the loser aborting its own upload. The counters of `part-url` / `object-url` advance by a
 * compare-and-set on the values that were read, so two concurrent requests can never both spend
 * the same slot.
 */

import { MAX_PARTS, MAX_URLS, WORKER_URL_TTL_SEC } from './config.js';
import type { R1RecordingGateContext } from './gate.js';
import {
  contentTypeForKind,
  keyForKind,
  mp4ContentType,
  recordingKeys,
  type R1ObjectKind,
  type R1RecordingMode,
} from './keys.js';
import {
  PREPARE_STALE_MS,
  casComplete,
  casIssue,
  casUploadStart,
  claimStalePrepare,
  insertPreparingRow,
  isGoneOrLeaving,
  loadRecording,
  modeRank,
  releasePrepareClaim,
  type CompleteInput,
  type R1RecordingRow,
} from './service.js';
import type { R1RecordingDb } from './service.js';
import type { R1ObjectStore } from './store.js';

export type OpResult<T> =
  | { readonly ok: true; readonly value: T }
  | { readonly ok: false; readonly status: number; readonly error: string };

export interface R1WorkerOpDeps {
  readonly db: R1RecordingDb;
  readonly store: R1ObjectStore;
  readonly now: () => Date;
  /** Waits for a concurrent `prepare` (tests pass an immediate yield). */
  readonly sleep: (ms: number) => Promise<void>;
}

const ok = <T>(value: T): OpResult<T> => ({ ok: true, value });
const refuse = (status: number, error: string): { ok: false; status: number; error: string } => ({ ok: false, status, error });
const STATE = (): { ok: false; status: number; error: string } => refuse(409, 'r1_recording_state');
const DELETED = (): { ok: false; status: number; error: string } => refuse(410, 'r1_recording_deleted');
const UNAVAILABLE = (): { ok: false; status: number; error: string } => refuse(503, 'service_unavailable');

/** How long a loser of a `prepare` race waits for the winner to finish creating the upload. */
const PREPARE_WAIT_POLLS = 8;
const PREPARE_WAIT_MS = 250;
/** Compare-and-set attempts for the issue counters before giving up with a retryable 503. */
const CAS_ATTEMPTS = 5;

/** The deadline after which a row is deleted: created_at + retention, fixed now, never extended. */
function deleteAfter(now: Date, retentionDays: number): string {
  return new Date(now.getTime() + retentionDays * 86_400_000).toISOString();
}

// ---------------------------------------------------------------- prepare

export async function prepareOp(
  deps: R1WorkerOpDeps,
  ctx: R1RecordingGateContext,
  mode: R1RecordingMode,
): Promise<OpResult<R1RecordingRow>> {
  // A worker may record LESS than the server allows, never more.
  if (modeRank(mode) > modeRank(ctx.serverMode)) return STATE();
  const { db } = deps;
  const keys = recordingKeys(ctx.roundId, ctx.sessionId);
  const nowIso = deps.now().toISOString();

  let row = await loadRecording(db, ctx.sessionId);
  let ours = false; // true once this call holds the right to create the multipart upload
  if (!row) {
    const inserted = await insertPreparingRow(db, {
      session_id: ctx.sessionId,
      round_id: ctx.roundId,
      bucket: ctx.config.s3.bucket,
      prefix: keys.prefix,
      requested_mode: mode,
      delete_after: deleteAfter(deps.now(), ctx.config.retentionDays),
      now: nowIso,
    });
    if (inserted) {
      row = inserted;
      ours = true;
    } else {
      row = await loadRecording(db, ctx.sessionId); // somebody else inserted between our read and write
      if (!row) return UNAVAILABLE();
    }
  }

  for (let poll = 0; ; poll += 1) {
    if (isGoneOrLeaving(row)) return DELETED();
    // `finishing` or later: a prepare can no longer change anything.
    if (row.status !== 'preparing' && row.status !== 'uploading') return STATE();
    if (row.upload_id !== null) return ok(row); // idempotent: the current state

    // preparing, no upload yet: create it if it is ours (or take over an abandoned one).
    if (!ours && row.status === 'preparing' && deps.now().getTime() - Date.parse(row.updated_at) > PREPARE_STALE_MS) {
      ours = await claimStalePrepare(db, row, deps.now().toISOString());
    }
    if (ours) return createUpload(deps, row, keys.stream);

    // Another call is creating the upload: wait for it, bounded.
    if (poll >= PREPARE_WAIT_POLLS) return UNAVAILABLE();
    await deps.sleep(PREPARE_WAIT_MS);
    const next = await loadRecording(db, ctx.sessionId);
    if (!next) return UNAVAILABLE();
    row = next;
  }
}

async function createUpload(deps: R1WorkerOpDeps, row: R1RecordingRow, streamKey: string): Promise<OpResult<R1RecordingRow>> {
  const { db, store } = deps;
  let uploadId: string;
  try {
    uploadId = await store.createMultipart(streamKey, mp4ContentType(row.requested_mode));
  } catch (error) {
    await releasePrepareClaim(db, row.session_id, deps.now().getTime());
    throw error;
  }
  let started: R1RecordingRow | null;
  try {
    started = await casUploadStart(db, row.session_id, uploadId, deps.now().toISOString());
  } catch (error) {
    await abortQuietly(store, streamKey, uploadId);
    throw error;
  }
  if (started) return ok(started);
  // Lost the race (or the row was withdrawn meanwhile): our upload is a stray; remove it and re-read.
  await abortQuietly(store, streamKey, uploadId);
  const current = await loadRecording(db, row.session_id);
  if (!current) return UNAVAILABLE();
  if (isGoneOrLeaving(current)) return DELETED();
  if (current.status !== 'preparing' && current.status !== 'uploading') return STATE();
  return current.upload_id !== null ? ok(current) : UNAVAILABLE();
}

async function abortQuietly(store: R1ObjectStore, key: string, uploadId: string): Promise<void> {
  try {
    await store.abortMultipart(key, uploadId);
  } catch {
    // A stray upload left behind is aborted by the sweep and by the 1-day bucket lifecycle rule.
  }
}

// ---------------------------------------------------------------- part-url / object-url

type Issued = { url: string };

export async function partUrlOp(
  deps: R1WorkerOpDeps,
  ctx: R1RecordingGateContext,
  partNumber: number,
): Promise<OpResult<Issued & { part_number: number }>> {
  for (let attempt = 0; attempt < CAS_ATTEMPTS; attempt += 1) {
    const row = await loadRecording(deps.db, ctx.sessionId);
    if (!row) return STATE();
    if (isGoneOrLeaving(row)) return DELETED();
    if (row.status !== 'uploading' || row.upload_id === null) return STATE();
    // No skipping ahead (a part number above parts_issued + 1 is a bug or an attack); re-requesting an
    // issued number is fine because a re-PUT of the same part number REPLACES the part.
    if (!Number.isInteger(partNumber) || partNumber < 1 || partNumber > Math.min(MAX_PARTS, row.parts_issued + 1)) return STATE();
    if (row.urls_issued >= MAX_URLS) return STATE();
    const won = await casIssue(
      deps.db,
      row,
      { parts_issued: Math.max(row.parts_issued, partNumber), urls_issued: row.urls_issued + 1 },
      deps.now().toISOString(),
    );
    if (!won) continue;
    const keys = recordingKeys(row.round_id, row.session_id);
    const url = await deps.store.presignPart(keys.stream, row.upload_id, partNumber, WORKER_URL_TTL_SEC);
    return ok({ url, part_number: partNumber });
  }
  return UNAVAILABLE();
}

export async function objectUrlOp(
  deps: R1WorkerOpDeps,
  ctx: R1RecordingGateContext,
  kind: R1ObjectKind,
): Promise<OpResult<Issued & { kind: R1ObjectKind; content_type: string }>> {
  for (let attempt = 0; attempt < CAS_ATTEMPTS; attempt += 1) {
    const row = await loadRecording(deps.db, ctx.sessionId);
    if (!row) return STATE();
    if (isGoneOrLeaving(row)) return DELETED();
    if (row.status !== 'uploading') return STATE();
    if (row.urls_issued >= MAX_URLS) return STATE();
    const won = await casIssue(
      deps.db,
      row,
      { parts_issued: row.parts_issued, urls_issued: row.urls_issued + 1 },
      deps.now().toISOString(),
    );
    if (!won) continue;
    const keys = recordingKeys(row.round_id, row.session_id);
    const contentType = contentTypeForKind(kind, row.requested_mode);
    const url = await deps.store.presignPut(keyForKind(keys, kind), WORKER_URL_TTL_SEC, contentType);
    return ok({ url, kind, content_type: contentType });
  }
  return UNAVAILABLE();
}

// ---------------------------------------------------------------- complete

export interface CompleteRequest {
  readonly layout: CompleteInput['layout'];
  readonly has_video: boolean;
  readonly failure_reason: string | null;
  readonly degraded_reason: string | null;
  readonly report: CompleteInput['report'];
}

/** `preparing | uploading -> finishing`; a replay on any later state answers the current state. */
export async function completeOp(
  deps: R1WorkerOpDeps,
  ctx: R1RecordingGateContext,
  request: CompleteRequest,
): Promise<OpResult<{ status: string }>> {
  for (let attempt = 0; attempt < 2; attempt += 1) {
    const row = await loadRecording(deps.db, ctx.sessionId);
    if (!row) return STATE(); // complete without prepare
    if (isGoneOrLeaving(row)) return DELETED();
    if (row.status !== 'preparing' && row.status !== 'uploading') return ok({ status: row.status }); // replay
    const updated = await casComplete(deps.db, ctx.sessionId, {
      ...request,
      // The server's mode is the truth: an audio-only recording has no video whatever the worker says.
      has_video: request.has_video && row.requested_mode === 'av',
      now: deps.now().toISOString(),
    });
    if (updated) return ok({ status: 'finishing' });
  }
  return UNAVAILABLE();
}
