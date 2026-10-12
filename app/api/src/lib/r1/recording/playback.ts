/**
 * Staff playback of an R1 recording: authorize, look up, VERIFY the object still is what finalize
 * verified, then mint a short-lived presigned GET (IMPLEMENTER-RULES C6).
 *
 * Expected conditions are NOT errors: a recording that is still being written, failed, or erased
 * comes back as a normal result carrying a `state` and no URL, so the player can say so. Only
 * "not yours" (uniform 403, also for a missing round, so existence cannot be probed), "not found",
 * and storage trouble are error results.
 *
 *   1. the actor is active and may read the round's candidate (access.ts)       else forbidden
 *   2. the session is an attempt of THIS round (never trust one id alone)       else not_found
 *   3. the row's state decides whether there is anything to play
 *   4. ready | partial: HEAD every deliverable. 404 -> `failed/object_missing`, an ETag different
 *      from the one finalize recorded -> `failed/integrity`; both write the fail-closed
 *      `recording.quarantined` audit FIRST (an audit outage aborts with no state change) and never
 *      hand out a URL. A HEAD that cannot be answered is `unavailable` (503), never a URL.
 *   5. presign the GET(s) with a signed `response-content-type`; audit `recording.download` (fail-open).
 *
 * Nothing here returns or logs a key, a bucket, an ETag, a hash or an upload id; the only secret-ish
 * value in a result is the presigned URL itself, which goes to the authorised caller and nowhere else.
 */

import type { R1DbClient } from '../../../services/r1-assessment.js';
import { staffMayReadCandidate, seesEveryCandidate, type R1StaffActor } from './access.js';
import type { R1RecordingConfig } from './config.js';
import { OGG_CONTENT_TYPE, isUnderPrefix, mp4ContentType } from './keys.js';
import {
  R1RecordingDbError,
  RECORDINGS_TABLE,
  loadRecording,
  type R1RecordingRow,
} from './service.js';
import { summarizeRecording, type R1RecordingSummary } from './summary.js';
import { isR1StoreError, type R1ObjectHead, type R1ObjectStore } from './store.js';

export interface R1RecordingPlayback extends R1RecordingSummary {
  url?: string;
  content_type?: string;
  video_url?: string;
  audio_url?: string;
  video_content_type?: string;
  audio_content_type?: string;
  expires_in_sec?: number;
}

export type R1PlaybackResult =
  | { readonly kind: 'ok'; readonly body: R1RecordingPlayback }
  /** Uniform 403: not allowed, or (for an interviewer) the round does not exist. */
  | { readonly kind: 'forbidden' }
  | { readonly kind: 'not_found' }
  /** The object store could not answer, or is not configured: no URL. */
  | { readonly kind: 'unavailable' }
  | { readonly kind: 'error' };

export interface R1PlaybackDeps {
  readonly db: R1DbClient;
  readonly recordingConfig: () => R1RecordingConfig;
  readonly store: (config: Extract<R1RecordingConfig, { enabled: true }>) => R1ObjectStore;
  readonly now?: () => Date;
  /** `recording.download` (fail-open: a failure here never costs the caller its URL). */
  readonly auditDownload: (metadata: Record<string, unknown>) => Promise<void>;
  /** `recording.quarantined` (FAIL-CLOSED: a rejection aborts the quarantine and the request). */
  readonly auditQuarantine: (metadata: Record<string, unknown>) => Promise<void>;
  /** A fixed category code; never a value. */
  readonly log?: (category: string) => void;
}

type Quarantine = 'object_missing' | 'integrity';

interface Deliverable {
  readonly key: string;
  readonly etag: string | null;
  readonly contentType: string;
}

const sameEtag = (a: string, b: string): boolean => a.replace(/"/g, '') === b.replace(/"/g, '');

/** The objects the row says make up the recording; null when the row is inconsistent. */
function deliverables(row: R1RecordingRow): { mp4: Deliverable | null; ogg: Deliverable | null } | null {
  const mp4 = row.video_key
    ? { key: row.video_key, etag: row.video_etag, contentType: row.video_content_type ?? mp4ContentType(row.requested_mode) }
    : null;
  const ogg = row.audio_key ? { key: row.audio_key, etag: row.audio_etag, contentType: OGG_CONTENT_TYPE } : null;
  for (const item of [mp4, ogg]) if (item && !isUnderPrefix(item.key, row.prefix)) return null;
  if (row.layout === 'split') return mp4 && ogg ? { mp4, ogg } : null;
  if (row.layout === 'audio_only') return ogg ? { mp4: null, ogg } : null;
  if (row.layout === 'combined') return mp4 ? { mp4, ogg: null } : null;
  return null;
}

export async function resolvePlayback(
  deps: R1PlaybackDeps,
  actor: R1StaffActor,
  roundId: string,
  sessionId: string,
): Promise<R1PlaybackResult> {
  try {
    const clock = deps.now ?? ((): Date => new Date());
    if (!actor.active) return { kind: 'forbidden' };

    // 1. The round and the candidate it belongs to.
    const { data: round, error: roundError } = await deps.db.from('interview_rounds').select('id,candidate_id').eq('id', roundId).maybeSingle();
    if (roundError) return { kind: 'error' };
    const candidateId = (round as { candidate_id?: unknown } | null)?.candidate_id;
    if (!round || typeof candidateId !== 'string') return seesEveryCandidate(actor) ? { kind: 'not_found' } : { kind: 'forbidden' };
    const access = await staffMayReadCandidate(deps.db, actor, candidateId);
    if (access === 'denied') return { kind: 'forbidden' };
    if (access === 'unavailable') return { kind: 'error' };

    // 2. The session must be an attempt of THIS round.
    const { data: attempt, error: attemptError } = await deps.db
      .from('interview_round_attempts')
      .select('session_id')
      .eq('session_id', sessionId)
      .eq('round_id', roundId)
      .maybeSingle();
    if (attemptError) return { kind: 'error' };
    if (!attempt) return { kind: 'not_found' };

    // 3. The state.
    const row = await loadRecording(deps.db, sessionId);
    const summary = summarizeRecording(row, clock().getTime());
    if (!row || (summary.state !== 'ready' && summary.state !== 'partial')) return { kind: 'ok', body: summary };

    // 4. Verify what is in the bucket.
    const config = deps.recordingConfig();
    if (!config.enabled) return { kind: 'unavailable' };
    const store = deps.store(config);
    const parts = deliverables(row);
    if (!parts) return await quarantine(deps, row, 'integrity', clock);
    const wanted = [parts.mp4, parts.ogg].filter((item): item is Deliverable => item !== null);
    for (const item of wanted) {
      let head: R1ObjectHead | null;
      try {
        head = await store.head(item.key);
      } catch (error) {
        if (isR1StoreError(error)) return { kind: 'unavailable' };
        throw error;
      }
      if (head === null) return await quarantine(deps, row, 'object_missing', clock);
      if (item.etag !== null && !sameEtag(head.etag, item.etag)) return await quarantine(deps, row, 'integrity', clock);
    }

    // 5. Mint.
    const ttl = config.downloadTtlSec;
    const sign = (item: Deliverable): Promise<string> => store.presignGet(item.key, ttl, { contentType: item.contentType });
    let body: R1RecordingPlayback;
    try {
      if (summary.mode === 'split' && parts.mp4 && parts.ogg) {
        body = {
          ...summary,
          video_url: await sign(parts.mp4),
          audio_url: await sign(parts.ogg),
          video_content_type: parts.mp4.contentType,
          audio_content_type: parts.ogg.contentType,
          expires_in_sec: ttl,
        };
      } else {
        const only = parts.mp4 ?? parts.ogg!;
        body = { ...summary, url: await sign(only), content_type: only.contentType, expires_in_sec: ttl };
      }
    } catch (error) {
      if (isR1StoreError(error)) return { kind: 'unavailable' };
      throw error;
    }
    await deps.auditDownload({ resource: 'r1_recording', session_id: sessionId, round_id: roundId, ttl_sec: ttl, layout: row.layout, state: summary.state }).catch(() => undefined);
    return { kind: 'ok', body };
  } catch (error) {
    // A closed category only: never the error text (it could carry a key or an id).
    deps.log?.(error instanceof R1RecordingDbError ? 'r1_recording_playback_db_error' : 'r1_recording_playback_error');
    return { kind: 'error' };
  }
}

/** Audit (fail-closed), then flip `ready | partial` to `failed` and answer the new state: no URL. */
async function quarantine(
  deps: R1PlaybackDeps,
  row: R1RecordingRow,
  reason: Quarantine,
  clock: () => Date,
): Promise<R1PlaybackResult> {
  await deps.auditQuarantine({ resource: 'r1_recording', session_id: row.session_id, round_id: row.round_id, reason });
  const nowIso = clock().toISOString();
  const { data, error } = await deps.db
    .from(RECORDINGS_TABLE)
    .update({ status: 'failed', failure_reason: reason, updated_at: nowIso })
    .eq('session_id', row.session_id)
    .in('status', ['ready', 'partial'])
    .is('deleted_at', null)
    .select('*');
  if (error) throw new R1RecordingDbError();
  // Lost the race (erased, or quarantined by another request): answer whatever the row is now.
  const current = Array.isArray(data) && data.length === 1 ? (data[0] as R1RecordingRow) : await loadRecording(deps.db, row.session_id);
  return { kind: 'ok', body: summarizeRecording(current, clock().getTime()) };
}
