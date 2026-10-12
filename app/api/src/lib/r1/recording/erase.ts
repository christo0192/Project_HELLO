/**
 * Erasing R1 recordings: the ONE routine behind retention, consent withdrawal, DSAR and the purge
 * outbox (research/api-storage.md 7.2, mirroring the phone purge: "enumerate, delete, verify, record,
 * acknowledge").
 *
 *   1. Legal holds on the candidate, the session or the recording block the erase (audited, at most
 *      once a day per recording) and the recording is left exactly as it is.
 *   2. The row is marked `delete_requested_at` first, so no new capability (worker URL, staff URL,
 *      finalize) is issued for it from now on.
 *   3. Abort every multipart upload (the row's known id AND every upload listed under the prefix),
 *      list and delete every key under the prefix, repeat until a pass finds nothing.
 *   4. VERIFY: the prefix lists empty, no multipart upload is listed, and HEAD answers 404 for every
 *      key that was removed and for the four fixed names. A listing that cannot be read is an ERROR,
 *      never "empty".
 *   5. Only then the row becomes a `deleted` tombstone (keys and `upload_id` nulled; bytes and
 *      hashes stay as evidence of what was erased) and a governance audit row is written.
 *
 * Every step is idempotent and retryable: a failure anywhere leaves the row un-tombstoned and the
 * job retries. Deletion is always by PREFIX (`r1/<round>/<session>/`, validated shape), never by the
 * keys the database remembers, so an object a racing PUT created after the last list is still found.
 * Nothing here logs or returns a key, a URL or an upload id.
 */

import { governanceCorrelationId, recordGovernanceAudit, type GovernanceAction } from '../../retention.js';
import type { R1DbClient } from '../../../services/r1-assessment.js';
import { findActiveHolds } from './holds.js';
import {
  AUDIO_FILE,
  AUDIO_PARTIAL_FILE,
  STREAM_FILE,
  VIDEO_FILE,
  isRecordingPrefix,
  recordingPrefix,
  toCanonicalUuid,
} from './keys.js';
import {
  R1RecordingDbError,
  RECORDINGS_TABLE,
  loadRecording,
  markDeleteRequested,
  type R1RecordingRow,
} from './service.js';
import { guardStore, takeListing } from './store-errors.js';
import type { R1ObjectStore } from './store.js';

export const R1_ERASE_REASONS = ['retention', 'consent_withdrawn', 'dsar', 'row_deleted', 'admin'] as const;
export type R1EraseReason = (typeof R1_ERASE_REASONS)[number];

export function isEraseReason(value: unknown): value is R1EraseReason {
  return typeof value === 'string' && (R1_ERASE_REASONS as readonly string[]).includes(value);
}

/** The audit actor for background jobs (`audit.ts` `SYSTEM_ACTOR_ID`). */
export const R1_SYSTEM_ACTOR_ID = '00000000-0000-4000-8000-000000000001';

/** A held recording is audited as blocked at most this often. */
export const BLOCKED_AUDIT_INTERVAL_MS = 24 * 60 * 60 * 1000;

const MAX_LISTED_OBJECTS = 1000;
const MAX_LISTED_UPLOADS = 500;
const MAX_PASSES = 4;
const FIXED_NAMES = [STREAM_FILE, VIDEO_FILE, AUDIO_PARTIAL_FILE, AUDIO_FILE] as const;

export const PURGE_TABLE = 'r1_recording_purge';

export interface R1EraseDeps {
  readonly db: R1DbClient;
  readonly store: R1ObjectStore;
  /** The configured bucket: a row that names another bucket cannot be erased with this store. */
  readonly bucket: string;
  readonly now?: () => Date;
}

export interface R1EraseActor {
  readonly actorId?: string;
  readonly actorType?: string;
  readonly correlationId?: string;
}

const clockOf = (deps: { now?: () => Date }): (() => Date) => deps.now ?? ((): Date => new Date());

// ---------------------------------------------------------------- the storage routine

export interface R1PurgeResult {
  readonly objects: number;
  readonly uploads: number;
}

/**
 * Empty `prefix` of objects and multipart uploads, then prove it. Throws (a closed `r1_*` code) if
 * anything cannot be listed, deleted or verified.
 */
export async function purgePrefix(store: R1ObjectStore, prefix: string, knownUploadIds: readonly string[] = []): Promise<R1PurgeResult> {
  // The prefix decides what gets deleted: refuse anything that is not exactly r1/<uuid>/<uuid>/.
  if (!isRecordingPrefix(prefix)) throw new Error('r1_erase_prefix_invalid');
  const streamKey = `${prefix}${STREAM_FILE}`;
  const removed = new Set<string>();
  let objects = 0;
  let uploads = 0;

  for (let pass = 0; pass < MAX_PASSES; pass += 1) {
    if (pass === 0) {
      for (const uploadId of new Set(knownUploadIds)) {
        await guardStore(() => store.abortMultipart(streamKey, uploadId));
        uploads += 1;
      }
    }
    const listedUploads = await takeListing(store.listMultipartUploads(prefix), MAX_LISTED_UPLOADS);
    for (const upload of listedUploads) {
      if (!upload.key.startsWith(prefix)) continue;
      await guardStore(() => store.abortMultipart(upload.key, upload.uploadId));
      uploads += 1;
    }
    const keys = (await takeListing(store.listPrefix(prefix), MAX_LISTED_OBJECTS))
      .map((object) => object.key)
      .filter((key) => key.startsWith(prefix));
    if (keys.length === 0 && listedUploads.length === 0) break;
    if (keys.length > 0) {
      await guardStore(() => store.remove(keys));
      objects += keys.length;
      for (const key of keys) removed.add(key);
    }
  }

  // Verify. An unreadable listing throws inside the listing helper: it is never taken for "empty".
  const leftover = await takeListing(store.listPrefix(prefix), 1);
  const leftoverUploads = await takeListing(store.listMultipartUploads(prefix), 1);
  if (leftover.length > 0 || leftoverUploads.length > 0) throw new Error('r1_erase_unverified');
  for (const key of new Set([...removed, ...FIXED_NAMES.map((name) => `${prefix}${name}`)])) {
    if ((await guardStore(() => store.head(key))) !== null) throw new Error('r1_erase_unverified');
  }
  return { objects, uploads };
}

// ---------------------------------------------------------------- legal holds

async function candidateOfRound(db: R1DbClient, roundId: string): Promise<string | null> {
  const { data, error } = await db.from('interview_rounds').select('candidate_id').eq('id', roundId).maybeSingle();
  if (error) throw new R1RecordingDbError();
  return toCanonicalUuid((data as { candidate_id?: unknown } | null)?.candidate_id);
}

/** Audit "erasure blocked by a legal hold" unless the same recording was audited within the last day. */
async function auditBlocked(
  deps: R1EraseDeps,
  sessionId: string,
  holdIds: readonly string[],
  reason: string,
  actor: R1EraseActor,
): Promise<void> {
  const now = clockOf(deps)();
  try {
    const since = new Date(now.getTime() - BLOCKED_AUDIT_INTERVAL_MS).toISOString();
    const { data, error } = await deps.db
      .from('governance_audit')
      .select('id')
      .eq('action', 'erasure_blocked_legal_hold')
      .eq('entity_type', 'recording')
      .eq('entity_id', sessionId)
      .gte('created_at', since)
      .limit(1);
    if (!error && Array.isArray(data) && data.length > 0) return;
  } catch {
    /* a failed look-up only means we audit again */
  }
  await recordGovernanceAudit({
    action: 'erasure_blocked_legal_hold',
    actorId: actor.actorId ?? R1_SYSTEM_ACTOR_ID,
    actorType: actor.actorType ?? 'system',
    entityType: 'recording',
    entityId: sessionId,
    details: { resource: 'r1_recording', block_reason: 'legal_hold', reason, hold_ids: [...holdIds] },
    outcome: 'blocked',
    correlationId: actor.correlationId ?? governanceCorrelationId(),
  }, deps.db as never);
}

// ---------------------------------------------------------------- one recording

export type R1EraseOutcome =
  | { readonly kind: 'erased'; readonly objects: number }
  /** Already a tombstone (or another worker tombstoned it between our read and write). */
  | { readonly kind: 'already_deleted' }
  | { readonly kind: 'blocked'; readonly holdIds: readonly string[] };

function auditActionFor(reason: R1EraseReason): GovernanceAction {
  return reason === 'retention' || reason === 'row_deleted' ? 'data_deleted' : 'erasure_completed';
}

/** Erase one recording and tombstone its row. See the file header for the order and the invariants. */
export async function eraseRecording(
  deps: R1EraseDeps,
  row: R1RecordingRow,
  reason: R1EraseReason,
  actor: R1EraseActor = {},
): Promise<R1EraseOutcome> {
  if (row.status === 'deleted' || row.deleted_at !== null) return { kind: 'already_deleted' };
  if (row.prefix !== recordingPrefix(row.round_id, row.session_id)) throw new Error('r1_erase_prefix_invalid');
  if (row.bucket !== deps.bucket) throw new Error('r1_erase_bucket_mismatch');
  const now = clockOf(deps)();
  const nowIso = now.toISOString();

  // 1. No new capability from here on, hold or not: deletion HAS been requested.
  await markDeleteRequested(deps.db, row.session_id, reason, nowIso);

  // 2. Legal holds win over every erase (retention, withdrawal, DSAR, admin).
  const candidateId = await candidateOfRound(deps.db, row.round_id);
  const holds = await findActiveHolds(deps.db, [
    ...(candidateId ? [{ type: 'candidate' as const, id: candidateId }] : []),
    { type: 'session', id: row.session_id },
    { type: 'recording', id: row.session_id },
  ]);
  if (holds.length > 0) {
    const holdIds = holds.map((hold) => hold.id);
    await auditBlocked(deps, row.session_id, holdIds, reason, actor);
    return { kind: 'blocked', holdIds };
  }

  // 3-4. Delete by prefix, then verify.
  const purged = await purgePrefix(deps.store, row.prefix, row.upload_id ? [row.upload_id] : []);

  // 5. Tombstone: keys and upload id go, bytes/hashes stay as evidence. `delete_requested_at` and
  // `delete_reason` were set in step 1 (and are never overwritten there), so the FIRST reason survives.
  const { data, error } = await deps.db
    .from(RECORDINGS_TABLE)
    .update({
      status: 'deleted',
      deleted_at: nowIso,
      upload_id: null,
      video_key: null,
      audio_key: null,
      updated_at: nowIso,
    })
    .eq('session_id', row.session_id)
    .is('deleted_at', null)
    .select('session_id');
  if (error) throw new R1RecordingDbError();
  if (!Array.isArray(data) || data.length !== 1) return { kind: 'already_deleted' };

  await recordGovernanceAudit({
    action: auditActionFor(reason),
    actorId: actor.actorId ?? R1_SYSTEM_ACTOR_ID,
    actorType: actor.actorType ?? 'system',
    entityType: 'recording',
    entityId: row.session_id,
    details: { resource: 'r1_recording', reason, objects: purged.objects, uploads_aborted: purged.uploads },
    outcome: 'success',
    correlationId: actor.correlationId ?? governanceCorrelationId(),
  }, deps.db as never);
  return { kind: 'erased', objects: purged.objects };
}

// ---------------------------------------------------------------- scope by consent withdrawal

const WITHDRAWAL_DECISIONS = ['withdrawn', 'declined'];

/**
 * For each round, the time of its LATEST withdrawal or decline (epoch ms). A consent that was merely
 * SUPERSEDED by a newer template also has `withdrawn_at`, but its `proof.decision` is `superseded`
 * and it is not a withdrawal. A round with none is absent from the map.
 */
export async function withdrawalCutoffs(db: R1DbClient, roundIds: readonly string[]): Promise<Map<string, number>> {
  const cutoffs = new Map<string, number>();
  for (let at = 0; at < roundIds.length; at += 100) {
    const chunk = roundIds.slice(at, at + 100);
    const { data, error } = await db
      .from('interview_round_consents')
      .select('round_id,withdrawn_at,proof')
      .in('round_id', chunk)
      .not('withdrawn_at', 'is', null);
    if (error) throw new R1RecordingDbError();
    for (const consent of Array.isArray(data) ? data : []) {
      const decision = (consent as { proof?: { decision?: unknown } | null }).proof?.decision;
      if (typeof decision !== 'string' || !WITHDRAWAL_DECISIONS.includes(decision)) continue;
      const withdrawnAt = Date.parse(String((consent as { withdrawn_at?: unknown }).withdrawn_at));
      const roundId = String((consent as { round_id?: unknown }).round_id);
      if (Number.isFinite(withdrawnAt) && withdrawnAt > (cutoffs.get(roundId) ?? Number.NEGATIVE_INFINITY)) cutoffs.set(roundId, withdrawnAt);
    }
  }
  return cutoffs;
}

export interface R1EraseBatchResult {
  readonly erased: number;
  readonly blocked: number;
  readonly already_deleted: number;
  /** Rows left alone because they were made AFTER the latest withdrawal (a later re-consent). */
  readonly out_of_scope: number;
  readonly errors: number;
}

const EMPTY_BATCH: R1EraseBatchResult = { erased: 0, blocked: 0, already_deleted: 0, out_of_scope: 0, errors: 0 };

/** Run `eraseRecording` over rows, counting outcomes; every row is attempted even after a failure. */
export async function eraseRows(
  deps: R1EraseDeps,
  rows: readonly R1RecordingRow[],
  reasonOf: (row: R1RecordingRow) => R1EraseReason,
  actor: R1EraseActor = {},
): Promise<{ result: R1EraseBatchResult; firstError: unknown }> {
  let result = { ...EMPTY_BATCH };
  let firstError: unknown;
  for (const row of rows) {
    try {
      const outcome = await eraseRecording(deps, row, reasonOf(row), actor);
      if (outcome.kind === 'erased') result = { ...result, erased: result.erased + 1 };
      else if (outcome.kind === 'blocked') result = { ...result, blocked: result.blocked + 1 };
      else result = { ...result, already_deleted: result.already_deleted + 1 };
    } catch (error) {
      result = { ...result, errors: result.errors + 1 };
      firstError ??= error;
    }
  }
  return { result, firstError };
}

/**
 * The `{ round_id }` erase job (a consent was withdrawn or declined). Scope: this round's recordings
 * created at or before the round's latest withdrawal. A recording made after a later re-consent is
 * untouched. Throws the first failure after attempting every row.
 */
export async function eraseRoundRecordings(deps: R1EraseDeps, roundId: string, reason: R1EraseReason = 'consent_withdrawn'): Promise<R1EraseBatchResult> {
  const cutoffs = await withdrawalCutoffs(deps.db, [roundId]);
  const cutoff = cutoffs.get(roundId);
  if (cutoff === undefined) return EMPTY_BATCH;
  const { data, error } = await deps.db.from(RECORDINGS_TABLE).select('*').eq('round_id', roundId).is('deleted_at', null);
  if (error) throw new R1RecordingDbError();
  const rows = (Array.isArray(data) ? data : []) as R1RecordingRow[];
  const inScope = rows.filter((row) => Date.parse(row.created_at) <= cutoff);
  const { result, firstError } = await eraseRows(deps, inScope, () => reason);
  if (firstError !== undefined) throw firstError;
  return { ...result, out_of_scope: rows.length - inScope.length };
}

/** The `{ session_id }` erase job (the worker gate or finalize found the consent gone): that one recording, no scope test. */
export async function eraseSessionRecording(deps: R1EraseDeps, sessionId: string, reason: R1EraseReason = 'consent_withdrawn'): Promise<R1EraseBatchResult> {
  const row = await loadRecording(deps.db, sessionId);
  if (!row) return EMPTY_BATCH;
  const { result, firstError } = await eraseRows(deps, [row], () => reason);
  if (firstError !== undefined) throw firstError;
  return result;
}

// ---------------------------------------------------------------- the purge outbox

export interface R1PurgeRow {
  readonly id: string;
  readonly bucket: string;
  readonly prefix: string;
  readonly upload_id: string | null;
  readonly reason: string;
  readonly queued_at: string;
  readonly attempts: number;
  readonly last_error_code: string | null;
  readonly done_at: string | null;
}

export type R1PurgeOutcome =
  | { readonly kind: 'done'; readonly objects: number }
  | { readonly kind: 'blocked' }
  | { readonly kind: 'failed'; readonly code: string };

/** The session id a recording prefix names (`r1/<round>/<session>/`), or null for a malformed one. */
export function sessionIdOfPrefix(prefix: string): string | null {
  return isRecordingPrefix(prefix) ? (prefix.split('/')[2] ?? null) : null;
}

function errorCodeOf(error: unknown): string {
  const message = error instanceof Error ? error.message : '';
  return /^[a-z0-9_]{1,64}$/.test(message) ? message : 'r1_erase_error';
}

async function noteOutbox(db: R1DbClient, row: R1PurgeRow, patch: Record<string, unknown>): Promise<void> {
  const { error } = await db.from(PURGE_TABLE).update({ attempts: row.attempts + 1, ...patch }).eq('id', row.id).is('done_at', null);
  if (error) throw new R1RecordingDbError();
}

/**
 * Drain one outbox row (a recording row that was deleted without a tombstone: a candidate delete, an
 * ops script, a cascade). The row is gone, so there is no candidate to look up: holds are checked on
 * the session and recording ids the prefix names. A failure is recorded on the outbox row itself
 * (attempts, a closed `last_error_code`) and returned, never thrown, so one bad row cannot stop a drain.
 */
export async function eraseOutboxRow(deps: R1EraseDeps, row: R1PurgeRow, actor: R1EraseActor = {}): Promise<R1PurgeOutcome> {
  try {
    const sessionId = sessionIdOfPrefix(row.prefix);
    if (!sessionId) {
      await noteOutbox(deps.db, row, { last_error_code: 'r1_erase_prefix_invalid' });
      return { kind: 'failed', code: 'r1_erase_prefix_invalid' };
    }
    if (row.bucket !== deps.bucket) {
      await noteOutbox(deps.db, row, { last_error_code: 'r1_erase_bucket_mismatch' });
      return { kind: 'failed', code: 'r1_erase_bucket_mismatch' };
    }
    const holds = await findActiveHolds(deps.db, [{ type: 'session', id: sessionId }, { type: 'recording', id: sessionId }]);
    if (holds.length > 0) {
      await auditBlocked(deps, sessionId, holds.map((hold) => hold.id), row.reason, actor);
      await noteOutbox(deps.db, row, { last_error_code: 'legal_hold' });
      return { kind: 'blocked' };
    }
    const purged = await purgePrefix(deps.store, row.prefix, row.upload_id ? [row.upload_id] : []);
    await noteOutbox(deps.db, row, { done_at: clockOf(deps)().toISOString(), last_error_code: null });
    await recordGovernanceAudit({
      action: 'data_deleted',
      actorId: actor.actorId ?? R1_SYSTEM_ACTOR_ID,
      actorType: actor.actorType ?? 'system',
      entityType: 'recording',
      entityId: sessionId,
      details: { resource: 'r1_recording', reason: 'row_deleted', source: 'purge_outbox', objects: purged.objects, uploads_aborted: purged.uploads },
      outcome: 'success',
      correlationId: actor.correlationId ?? governanceCorrelationId(),
    }, deps.db as never);
    return { kind: 'done', objects: purged.objects };
  } catch (error) {
    const code = errorCodeOf(error);
    try {
      await noteOutbox(deps.db, row, { last_error_code: code });
    } catch {
      /* the next drain retries; the failure itself is the return value */
    }
    return { kind: 'failed', code };
  }
}
