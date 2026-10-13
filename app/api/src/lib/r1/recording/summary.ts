/**
 * What staff see of a recording WITHOUT minting a URL: one `R1RecordingSummary` per attempt
 * (IMPLEMENTER-RULES C6/C11), built from the database row.
 *
 * A summary NEVER carries a URL, a key, a bucket, a hash, an ETag or an upload id: it is safe to put
 * in the rounds list that every staff role reads. The rows are read with an explicit column list
 * (no `select('*')`), so a secret column cannot reach this module by accident.
 *
 * State mapping:
 *   no row                                           none
 *   deleted tombstone, OR delete requested           deleted    (a recording being erased gives no new access)
 *   preparing | uploading, updated within 10 min     recording
 *   preparing | uploading, older                     processing (the worker is gone; the sweep will salvage it)
 *   finishing                                        processing
 *   ready | partial | failed                         as is
 */

import type { R1DbClient } from '../../../services/r1-assessment.js';
import { createLogger } from '../../logger.js';
import { RECORDINGS_TABLE, type R1RecordingRow } from './service.js';

const logger = createLogger('r1-recording');

export type R1RecordingState = 'none' | 'recording' | 'processing' | 'ready' | 'partial' | 'failed' | 'deleted';

export interface R1RecordingSummary {
  state: R1RecordingState;
  /** C11 web vocabulary; null when there is nothing to explain. */
  reason: string | null;
  mode: 'single' | 'split' | null;
  has_video: boolean | null;
  started_at_ms: number | null;
  duration_ms: number | null;
  camera_off_ms: number | null;
  degraded_at_ms: number | null;
  /** ISO, = `delete_after`. */
  retention_until: string | null;
  /** ISO. */
  deleted_at: string | null;
}

export interface R1AttemptSummary {
  session_id: string;
  attempt_number: number;
  counted: boolean;
  outcome: string | null;
  recording: R1RecordingSummary;
}

/** A recording still being written counts as `recording` while its row moved within this window. */
export const LIVE_RECORDING_WINDOW_MS = 10 * 60 * 1000;

/** The columns a summary needs. No secret, key, hash or ETag column is on this list. */
export const SUMMARY_COLUMNS = [
  'session_id',
  'round_id',
  'status',
  'layout',
  'has_video',
  'started_at_ms',
  'duration_ms',
  'camera_off_ms',
  'degraded_at_ms',
  'degraded_reason',
  'failure_reason',
  'delete_after',
  'delete_requested_at',
  'delete_reason',
  'deleted_at',
  'updated_at',
].join(',');

type SummaryRow = Pick<
  R1RecordingRow,
  | 'session_id'
  | 'round_id'
  | 'status'
  | 'layout'
  | 'has_video'
  | 'started_at_ms'
  | 'duration_ms'
  | 'camera_off_ms'
  | 'degraded_at_ms'
  | 'degraded_reason'
  | 'failure_reason'
  | 'delete_after'
  | 'delete_requested_at'
  | 'delete_reason'
  | 'deleted_at'
  | 'updated_at'
>;

const NONE: R1RecordingSummary = {
  state: 'none',
  reason: null,
  mode: null,
  has_video: null,
  started_at_ms: null,
  duration_ms: null,
  camera_off_ms: null,
  degraded_at_ms: null,
  retention_until: null,
  deleted_at: null,
};

function iso(value: unknown): string | null {
  if (typeof value !== 'string') return null;
  const ms = Date.parse(value);
  return Number.isFinite(ms) ? new Date(ms).toISOString() : null;
}

function num(value: unknown): number | null {
  if (value === null || value === undefined) return null;
  const n = Number(value);
  return Number.isFinite(n) ? n : null;
}

export function recordingState(row: SummaryRow | null, nowMs: number): R1RecordingState {
  if (!row) return 'none';
  if (row.status === 'deleted' || row.deleted_at !== null || row.delete_requested_at !== null) return 'deleted';
  switch (row.status) {
    case 'preparing':
    case 'uploading': {
      const touched = Date.parse(row.updated_at);
      return Number.isFinite(touched) && nowMs - touched <= LIVE_RECORDING_WINDOW_MS ? 'recording' : 'processing';
    }
    case 'finishing':
      return 'processing';
    case 'ready':
    case 'partial':
    case 'failed':
      return row.status;
    default:
      // A status this build does not know can never be offered as a player.
      return 'processing';
  }
}

function deletedReason(reason: string | null): string | null {
  switch (reason) {
    case 'retention':
      return 'retention';
    case 'consent_withdrawn':
      return 'consent_withdrawn';
    case 'dsar':
    case 'row_deleted':
    case 'admin':
      return 'erasure';
    default:
      return null;
  }
}

const CRASH_REASONS = ['worker_lost', 'encoder_crashed', 'encoder_stalled'];
const DEGRADED_REASONS = ['cpu_loop_lag', 'cpu_vad_slow', 'frame_drops', 'upload_backlog'];

function failureReason(reason: string | null): string {
  if (reason === 'integrity' || reason === 'oversize' || reason === 'object_missing') return reason;
  if (reason !== null && CRASH_REASONS.includes(reason)) return 'crash_recovered';
  return 'capture_failed';
}

/** The C11 web `reason` for a playable (ready | partial) recording. */
function playableReason(row: SummaryRow): string | null {
  if (row.layout === 'split') return 'crash_recovered';
  if (row.failure_reason !== null) return failureReason(row.failure_reason);
  if (row.degraded_reason === null) return null;
  if (row.degraded_reason === 'video_unavailable') return 'video_unavailable';
  if (CRASH_REASONS.includes(row.degraded_reason)) return 'crash_recovered';
  return DEGRADED_REASONS.includes(row.degraded_reason) ? 'audio_only_degraded' : null;
}

export function summarizeRecording(row: SummaryRow | null, nowMs: number): R1RecordingSummary {
  const state = recordingState(row, nowMs);
  if (!row || state === 'none') return { ...NONE };
  const base: R1RecordingSummary = {
    ...NONE,
    state,
    retention_until: iso(row.delete_after),
    deleted_at: state === 'deleted' ? iso(row.deleted_at) : null,
  };
  if (state === 'deleted') return { ...base, reason: deletedReason(row.delete_reason) };
  if (state === 'failed') return { ...base, reason: failureReason(row.failure_reason) };
  if (state === 'ready' || state === 'partial') {
    return {
      ...base,
      reason: playableReason(row),
      mode: row.layout === 'split' ? 'split' : 'single',
      has_video: row.has_video,
      started_at_ms: num(row.started_at_ms),
      duration_ms: num(row.duration_ms),
      camera_off_ms: num(row.camera_off_ms),
      degraded_at_ms: num(row.degraded_at_ms),
    };
  }
  return base;
}

/**
 * Add `attempts[]` (ordered by attempt number, each with its recording summary) to every round of
 * the rounds list: one query on `interview_round_attempts`, one on the recordings, no N+1.
 *
 * NEVER throws and never breaks the list: if either read fails the rounds come back unchanged
 * (without `attempts`, which the web treats as optional) and one fixed log category is written. A
 * partial result would show attempts with a false "no recording" state.
 */
export async function withRecordingAttempts<T extends { id?: unknown }>(
  db: R1DbClient,
  rounds: readonly T[],
  nowMs: number = Date.now(),
): Promise<Array<T | (T & { attempts: R1AttemptSummary[] })>> {
  const roundIds = rounds.map((round) => round.id).filter((id): id is string => typeof id === 'string');
  if (roundIds.length === 0) return [...rounds];
  try {
    const attemptsResult = await db
      .from('interview_round_attempts')
      .select('session_id,round_id,attempt_number,counted,outcome')
      .in('round_id', roundIds)
      .order('attempt_number', { ascending: true });
    const recordingsResult = await db.from(RECORDINGS_TABLE).select(SUMMARY_COLUMNS).in('round_id', roundIds);
    if (attemptsResult.error || recordingsResult.error) throw new Error('r1_attempts_read_error');

    const bySession = new Map<string, SummaryRow>();
    for (const row of (Array.isArray(recordingsResult.data) ? recordingsResult.data : []) as SummaryRow[]) bySession.set(row.session_id, row);
    const byRound = new Map<string, R1AttemptSummary[]>();
    for (const attempt of (Array.isArray(attemptsResult.data) ? attemptsResult.data : []) as Array<Record<string, unknown>>) {
      const sessionId = String(attempt.session_id);
      const list = byRound.get(String(attempt.round_id)) ?? [];
      list.push({
        session_id: sessionId,
        attempt_number: Number(attempt.attempt_number),
        counted: attempt.counted === true,
        outcome: typeof attempt.outcome === 'string' ? attempt.outcome : null,
        recording: summarizeRecording(bySession.get(sessionId) ?? null, nowMs),
      });
      byRound.set(String(attempt.round_id), list);
    }
    return rounds.map((round) => ({
      ...round,
      attempts: (byRound.get(String(round.id)) ?? []).sort((a, b) => a.attempt_number - b.attempt_number),
    }));
  } catch {
    logger.warn('unknown_event', { error_category: 'r1_recording_attempts_unavailable' });
    return [...rounds];
  }
}
