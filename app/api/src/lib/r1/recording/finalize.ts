/**
 * Finalize one R1 recording (job `r1.recording.finalize`; IMPLEMENTER-RULES C2, C11).
 *
 * The 0127 trigger enqueues this when a recording reaches `finishing`, either because the worker
 * called `complete` or because the sweep decided the worker was lost (`failure_reason =
 * 'worker_lost'`, layout NULL). It is the ONLY place a recording becomes `ready`, `partial` or
 * `failed`, and the same code serves a clean finish and crash salvage.
 *
 *   1. Claim: the row must still be `finishing`, not deleted and not awaiting erasure; the round must
 *      not have WITHDRAWN or DECLINED since the recording was made (else mark it for erasure, queue
 *      the erase job and stop: nothing is verified or kept for a withdrawn candidate). A round that
 *      merely has no live consent to recording (a superseded consent) did not withdraw: finalize goes on.
 *   2. Settle the multipart upload: ListParts (all pages), keep the longest contiguous prefix of
 *      UNIFORM parts (R2 needs every part but the last the same size), Complete it, or Abort it when
 *      no part qualifies. A NoSuchUpload means a previous run already did it.
 *   3. HEAD the four fixed keys; an object larger than R1_RECORDING_MAX_BYTES is removed.
 *   4. Verify the deliverable of each kind in one streaming pass: SHA-256, byte count (must equal the
 *      HEAD length, else a retryable `r2_short_read`) and a 12-byte sniff (`ftyp` at 4 for MP4,
 *      `OggS` at 0 for OGG). The object is NEVER buffered: peak memory is one network chunk.
 *      MP4 preference `video.mp4` (faststart copy) then `stream.mp4`; OGG `audio.ogg` then
 *      `audio.partial.ogg`.
 *   5. Decide layout and status (`decide`, the C11 table) and write them in ONE compare-and-set on
 *      `status = 'finishing'`; only then remove the objects the row does not reference. Transient
 *      objects are removed after the write, best effort (they live under the prefix, so erase and
 *      the bucket lifecycle rule still cover a leftover).
 *   6. Audit `recording.integrity_verified` (fail-open).
 *
 * Errors are closed codes the queue runner may persist (`r1_storage_unavailable`, ...). A transient
 * object-store failure is `r1_storage_unavailable`, which the handler turns into a bounded deferral.
 * No object key, upload id, URL or ETag ever appears in an error or a log line.
 */

import { createHash } from 'node:crypto';
import { loadRoundLiveConsent, type R1DbClient } from '../../../services/r1-assessment.js';
import { MAX_PARTS, PART_SIZE } from './config.js';
import { auditSystemEvent } from './audit.js';
import { recordingWithdrawn } from './erase.js';
import { R1_RECORDING_CONSENT } from './gate.js';
import { mp4ContentType, recordingKeys, type R1RecordingKeys } from './keys.js';
import { R1_RECORDING_ERASE_QUEUE } from './queues.js';
import {
  RECORDINGS_TABLE,
  R1RecordingDbError,
  loadRecording,
  markDeleteRequested,
  type R1RecordingLayout,
  type R1RecordingRow,
} from './service.js';
import { guardStore, storageError } from './store-errors.js';
import { isR1StoreError, type R1ObjectHead, type R1ObjectStore, type R1StoredPart } from './store.js';

export interface R1FinalizeDeps {
  readonly db: R1DbClient;
  readonly store: R1ObjectStore;
  /** R1_RECORDING_MAX_BYTES. */
  readonly maxBytes: number;
  readonly now?: () => Date;
  readonly enqueue: (name: string, payload: unknown, options: { dedupKey: string; maxAttempts: number }) => Promise<unknown>;
}

export type R1FinalizeOutcome =
  | { readonly kind: 'skipped'; readonly reason: 'no_row' | 'not_finishing' | 'deleted' }
  | { readonly kind: 'erase_requested' }
  /** The compare-and-set found the row changed (erased, finalized elsewhere): nothing was written. */
  | { readonly kind: 'raced' }
  | { readonly kind: 'finalized'; readonly status: 'ready' | 'partial' | 'failed'; readonly layout: R1RecordingLayout | null };

// ---------------------------------------------------------------- multipart

/**
 * The longest prefix of the uploaded parts R2 will accept: contiguous from part 1, every part but
 * the last the same size, the last no larger, and (R2's minimum) every non-last part at least
 * {@link PART_SIZE}. A single part is always acceptable (the last part may be any size).
 */
export function longestUniformPrefix(parts: readonly R1StoredPart[]): R1StoredPart[] {
  const sorted = [...parts].sort((a, b) => a.n - b.n);
  const keep: R1StoredPart[] = [];
  for (let i = 0; i < sorted.length && i < MAX_PARTS; i += 1) {
    const part = sorted[i]!;
    if (part.n !== i + 1 || part.size <= 0) break;
    if (i > 0) {
      const first = sorted[0]!.size;
      const previous = sorted[i - 1]!;
      // `previous` was the last part so far; it can stay non-last only if it is a full part.
      if (previous.size !== first || first < PART_SIZE || part.size > first) break;
    }
    keep.push(part);
  }
  return keep;
}

// ---------------------------------------------------------------- the verdict (C11)

export interface DecisionInput {
  /** The worker's layout from `complete`; null = no `complete` (salvage). */
  readonly claimLayout: R1RecordingLayout | null;
  readonly requestedMode: 'audio' | 'av';
  /** The worker's `has_video` from `complete` (null in salvage). */
  readonly claimHasVideo: boolean | null;
  /** The worker's failure_reason from `complete` (already vocabulary-checked), or the sweep's. */
  readonly failureReason: string | null;
  readonly degradedReason: string | null;
  readonly hasMp4: boolean;
  readonly hasOgg: boolean;
  /** The deliverable is `stream.mp4` and holds fewer bytes than the worker said it wrote. */
  readonly truncated: boolean;
  readonly oversize: boolean;
  /** An object exists but failed its sniff. */
  readonly invalidSeen: boolean;
}

export interface Decision {
  readonly layout: R1RecordingLayout | null;
  readonly status: 'ready' | 'partial' | 'failed';
  readonly hasVideo: boolean;
  readonly failureReason: string | null;
  readonly keepMp4: boolean;
  readonly keepOgg: boolean;
}

function chooseLayout(claim: R1RecordingLayout | null, mp4: boolean, ogg: boolean): R1RecordingLayout | null {
  if (claim === 'combined') return mp4 ? 'combined' : ogg ? 'audio_only' : null;
  if (claim === 'audio_only') return ogg ? 'audio_only' : mp4 ? 'combined' : null;
  // 'split' and salvage: both artefacts make a split recording; one alone is what it is.
  if (mp4 && ogg) return 'split';
  return mp4 ? 'combined' : ogg ? 'audio_only' : null;
}

/**
 * Layout, status and failure reason from what the verification found.
 *
 *   `ready`   iff the layout is `combined` AND is what the worker claimed, there is no failure reason,
 *             and (the recording is audio-only by request OR it has video and no degradation);
 *   `partial` otherwise, when any artefact is valid;
 *   `failed`  when nothing valid exists.
 * Without a `complete` (salvage, layout NULL) the reason is `worker_lost` and the status is never `ready`.
 */
export function decide(input: DecisionInput): Decision {
  const layout = chooseLayout(input.claimLayout, input.hasMp4, input.hasOgg);
  if (layout === null) {
    return {
      layout: null,
      status: 'failed',
      hasVideo: false,
      failureReason: input.oversize ? 'oversize' : input.invalidSeen ? 'integrity' : 'nothing_uploaded',
      keepMp4: false,
      keepOgg: false,
    };
  }
  const failureReason =
    input.failureReason
    ?? (input.claimLayout === null ? 'worker_lost' : null)
    ?? (input.oversize ? 'oversize' : null)
    ?? (input.truncated ? 'upload_failed' : null);
  const hasVideo =
    input.requestedMode === 'av'
    && (layout === 'combined' || layout === 'split')
    && (input.claimLayout === null ? true : input.claimHasVideo === true);
  const ready =
    layout === 'combined'
    && input.claimLayout === 'combined'
    && failureReason === null
    && (input.requestedMode === 'audio' || (hasVideo && input.degradedReason === null));
  return {
    layout,
    status: ready ? 'ready' : 'partial',
    hasVideo,
    failureReason,
    keepMp4: layout === 'combined' || layout === 'split',
    keepOgg: layout === 'split' || layout === 'audio_only',
  };
}

// ---------------------------------------------------------------- object verification

interface Verified {
  readonly key: string;
  readonly bytes: number;
  readonly etag: string;
  readonly sha256: string;
  readonly name: 'video' | 'stream' | 'audio' | 'audioPartial';
}

/** `ftyp` at offset 4 (MP4) or `OggS` at offset 0 (OGG). Needs the first 12 bytes (or all of a shorter object). */
export function sniffMatches(first: Uint8Array, have: number, kind: 'mp4' | 'ogg'): boolean {
  if (kind === 'mp4') return have >= 8 && first[4] === 0x66 && first[5] === 0x74 && first[6] === 0x79 && first[7] === 0x70;
  return have >= 4 && first[0] === 0x4f && first[1] === 0x67 && first[2] === 0x67 && first[3] === 0x53;
}

/**
 * One streaming pass over an object: SHA-256, byte count and the 12-byte sniff. Nothing is
 * accumulated: each chunk is hashed and dropped. The count must equal the HEAD length.
 */
async function hashObject(store: R1ObjectStore, key: string, expectedBytes: number, kind: 'mp4' | 'ogg'): Promise<{ sha256: string; valid: boolean } | null> {
  let body: AsyncIterable<Uint8Array>;
  try {
    body = await store.read(key);
  } catch (error) {
    if (isR1StoreError(error) && error.code === 'not_found') return null; // vanished since the HEAD
    throw storageError(error);
  }
  const hash = createHash('sha256');
  const first = new Uint8Array(12);
  let have = 0;
  let total = 0;
  try {
    for await (const chunk of body) {
      total += chunk.length;
      if (total > expectedBytes) throw new Error('r2_short_read'); // grew or changed since the HEAD
      hash.update(chunk);
      if (have < 12) {
        const take = Math.min(12 - have, chunk.length);
        first.set(chunk.subarray(0, take), have);
        have += take;
      }
    }
  } catch (error) {
    if (error instanceof Error && error.message === 'r2_short_read') throw error;
    throw storageError(error);
  }
  if (total !== expectedBytes) throw new Error('r2_short_read');
  return { sha256: hash.digest('hex'), valid: sniffMatches(first, have, kind) };
}

// ---------------------------------------------------------------- the job

export async function finalizeRecording(deps: R1FinalizeDeps, sessionId: string): Promise<R1FinalizeOutcome> {
  const { db, store } = deps;
  const clock = deps.now ?? ((): Date => new Date());

  const row = await loadRecording(db, sessionId);
  if (!row) return { kind: 'skipped', reason: 'no_row' };
  if (row.deleted_at !== null || row.status === 'deleted' || row.delete_requested_at !== null) return { kind: 'skipped', reason: 'deleted' };
  if (row.status !== 'finishing') return { kind: 'skipped', reason: 'not_finishing' };

  // 1. The candidate may have withdrawn between `complete` and this job. Only a WITHDRAWAL (or a
  // decline) at or after the recording erases it: a round with no live consent that never withdrew
  // (a superseded consent whose replacement is not in yet, or never arrives) is not one, and the
  // recording made under the consent then in force is finalized like any other.
  const consent = await loadRoundLiveConsent(db, row.round_id);
  const consentLive = !!consent && Array.isArray(consent.consents) && consent.consents.includes(R1_RECORDING_CONSENT);
  if (!consentLive && await recordingWithdrawn(db, row.round_id, row.created_at)) {
    await markDeleteRequested(db, sessionId, 'consent_withdrawn', clock().toISOString());
    await deps.enqueue(
      R1_RECORDING_ERASE_QUEUE,
      { session_id: sessionId, reason: 'consent_withdrawn' },
      { dedupKey: `${R1_RECORDING_ERASE_QUEUE}:session:${sessionId}`, maxAttempts: 5 },
    );
    return { kind: 'erase_requested' };
  }

  await bumpAttempts(db, row, clock());
  const keys = recordingKeys(row.round_id, row.session_id);

  // 2. Complete or abort the multipart upload.
  await guardStore(() => settleMultipart(deps, row, keys));

  // 3. HEAD the fixed keys; remove anything over the cap.
  const heads = new Map<string, R1ObjectHead>();
  let oversize = false;
  for (const key of [keys.video, keys.stream, keys.audio, keys.audioPartial]) {
    const head = await guardStore(() => store.head(key));
    if (!head) continue;
    if (head.bytes > deps.maxBytes) {
      await guardStore(() => store.remove([key]));
      oversize = true;
      continue;
    }
    heads.set(key, head);
  }

  // 4. Verify one MP4 and one OGG deliverable.
  let invalidSeen = false;
  const verifyFirst = async (
    candidates: ReadonlyArray<{ key: string; name: Verified['name'] }>,
    kind: 'mp4' | 'ogg',
  ): Promise<Verified | null> => {
    for (const candidate of candidates) {
      const head = heads.get(candidate.key);
      if (!head) continue;
      const result = await hashObject(store, candidate.key, head.bytes, kind);
      if (!result) continue;
      if (!result.valid) {
        invalidSeen = true;
        continue;
      }
      return { key: candidate.key, bytes: head.bytes, etag: head.etag, sha256: result.sha256, name: candidate.name };
    }
    return null;
  };
  const mp4 = await verifyFirst([{ key: keys.video, name: 'video' }, { key: keys.stream, name: 'stream' }], 'mp4');
  const ogg = await verifyFirst([{ key: keys.audio, name: 'audio' }, { key: keys.audioPartial, name: 'audioPartial' }], 'ogg');

  // 5. Decide and write.
  const truncated =
    mp4?.name === 'stream'
    && row.reported_stream_bytes !== null
    && mp4.bytes < row.reported_stream_bytes;
  const decision = decide({
    claimLayout: row.layout,
    requestedMode: row.requested_mode,
    claimHasVideo: row.layout === null ? null : row.has_video,
    failureReason: row.failure_reason,
    degradedReason: row.degraded_reason,
    hasMp4: mp4 !== null,
    hasOgg: ogg !== null,
    truncated,
    oversize,
    invalidSeen,
  });

  const finalMp4 = decision.keepMp4 ? mp4 : null;
  const finalOgg = decision.keepOgg ? ogg : null;
  const nowIso = clock().toISOString();
  const written = await writeVerdict(db, row, {
    status: decision.status,
    layout: decision.layout,
    has_video: decision.hasVideo,
    failure_reason: decision.failureReason,
    upload_id: null,
    video_key: finalMp4?.key ?? null,
    video_bytes: finalMp4?.bytes ?? null,
    video_sha256: finalMp4?.sha256 ?? null,
    video_etag: finalMp4?.etag ?? null,
    video_content_type: finalMp4 ? mp4ContentType(row.requested_mode) : null,
    audio_key: finalOgg?.key ?? null,
    audio_bytes: finalOgg?.bytes ?? null,
    audio_sha256: finalOgg?.sha256 ?? null,
    audio_etag: finalOgg?.etag ?? null,
    finalized_at: nowIso,
    updated_at: nowIso,
  });
  if (!written) return { kind: 'raced' };

  // Remove what the row does not reference, but only when something valid was kept: a failed
  // recording leaves its objects for the erase job and the retention sweep, which find them by prefix.
  if (decision.status !== 'failed') {
    const keep = new Set([finalMp4?.key, finalOgg?.key].filter((k): k is string => typeof k === 'string'));
    const leftovers = [...heads.keys()].filter((key) => !keep.has(key));
    if (leftovers.length > 0) {
      try {
        await store.remove(leftovers);
      } catch {
        /* best effort: the objects sit under the prefix and are erased with it */
      }
    }
  }

  await auditSystemEvent('recording.integrity_verified', '/jobs/r1.recording.finalize', {
    resource: 'r1_recording',
    session_id: row.session_id,
    round_id: row.round_id,
    status: decision.status,
    layout: decision.layout,
    has_video: decision.hasVideo,
  }, clock);
  return { kind: 'finalized', status: decision.status, layout: decision.layout };
}

async function bumpAttempts(db: R1DbClient, row: R1RecordingRow, now: Date): Promise<void> {
  try {
    await db
      .from(RECORDINGS_TABLE)
      .update({ finalize_attempts: row.finalize_attempts + 1, updated_at: now.toISOString() })
      .eq('session_id', row.session_id)
      .eq('status', 'finishing');
  } catch {
    /* diagnostic only */
  }
}

async function settleMultipart(deps: R1FinalizeDeps, row: R1RecordingRow, keys: R1RecordingKeys): Promise<void> {
  if (row.upload_id === null) return;
  const { store } = deps;
  try {
    const parts = await store.listParts(keys.stream, row.upload_id);
    const prefix = longestUniformPrefix(parts);
    if (prefix.length === 0) await store.abortMultipart(keys.stream, row.upload_id);
    else await store.completeMultipart(keys.stream, row.upload_id, prefix.map((p) => ({ n: p.n, etag: p.etag })));
  } catch (error) {
    // NoSuchUpload: an earlier run completed or aborted it (the id is cleared below).
    if (!(isR1StoreError(error) && error.code === 'no_such_upload')) throw error;
  }
  const { error } = await deps.db
    .from(RECORDINGS_TABLE)
    .update({ upload_id: null })
    .eq('session_id', row.session_id)
    .eq('status', 'finishing');
  if (error) throw new R1RecordingDbError();
}

async function writeVerdict(db: R1DbClient, row: R1RecordingRow, fields: Record<string, unknown>): Promise<boolean> {
  const { data, error } = await db
    .from(RECORDINGS_TABLE)
    .update(fields)
    .eq('session_id', row.session_id)
    .eq('status', 'finishing')
    .is('deleted_at', null)
    .is('delete_requested_at', null)
    .select('session_id');
  if (error) throw new R1RecordingDbError();
  return Array.isArray(data) && data.length === 1;
}
