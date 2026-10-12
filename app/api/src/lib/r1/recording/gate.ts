/**
 * The gate every worker-facing recording route passes, in this order (IMPLEMENTER-RULES C4):
 *
 *   1. R1 AND recording config enabled              else 503 r1_recording_disabled
 *   2. room shape                                   else 400 invalid_r1_room
 *      live R1 browser session for the room         else 409 r1_session   (DB error: 503 service_unavailable)
 *   3. r1_settings.recording_mode != 'off'          else 503 r1_recording_disabled
 *   4. the round's LIVE consent contains
 *      `video_audio_recording`                      else 409 r1_consent_withdrawn
 *      (and, when the round WITHDREW or DECLINED after the recording was made, that recording is
 *      marked for erasure and an erase job is queued; a superseded consent erases nothing)
 *   5. (row checks are the route's: state, counters, deleted -> 410)
 *
 * Why every route re-checks 3 and 4: the worker keeps calling these routes while it is FINISHING,
 * long after the context said `recording.mode`, and a candidate can withdraw consent or staff can
 * flip the switch in that time. The answer is the worker's instruction: 503 / 409 means "stop and
 * delete what you hold; the interview continues".
 *
 * A per-session token bucket sits after the session lookup, in addition to the database counters
 * (`urls_issued <= 400`, `parts_issued <= 60`): the counters bound what can be issued, the bucket
 * bounds how hard a stuck worker can hammer the database while asking.
 *
 * The session predicate is the one `routes/r1.ts` `r1Session` uses (kept in step by a test); it is
 * repeated here because `r1.ts` may only be edited additively.
 */

import { loadRoundLiveConsent, type R1DbClient } from '../../../services/r1-assessment.js';
import type { R1RecordingConfig } from './config.js';
import { recordingWithdrawn } from './erase.js';
import { toCanonicalUuid } from './keys.js';
import { R1_RECORDING_ERASE_QUEUE } from './queues.js';
import { asRecordingMode, loadRecording, markDeleteRequested } from './service.js';

/** The consent item that authorises recording (`consent-items.ts`). */
export const R1_RECORDING_CONSENT = 'video_audio_recording';

const ROOM = /^screening-[0-9a-f-]{36}$/i;
const LIVE_STATUSES = ['waiting', 'in_progress'];

export type EnabledRecordingConfig = Extract<R1RecordingConfig, { enabled: true }>;

export interface R1RecordingGateContext {
  /** Canonical lower-case ids. */
  readonly sessionId: string;
  readonly roundId: string;
  readonly config: EnabledRecordingConfig;
  /** The server-side recording mode (`audio` or `av`; `off` never reaches a route). */
  readonly serverMode: 'audio' | 'av';
}

export type R1RecordingGateOutcome =
  | { readonly ok: true; readonly ctx: R1RecordingGateContext }
  | { readonly ok: false; readonly status: number; readonly error: string };

// ---------------------------------------------------------------- per-session token bucket

export interface SessionLimiter {
  /** True when the call may proceed. */
  take(key: string): boolean;
}

export interface SessionLimiterOptions {
  readonly capacity?: number;
  readonly refillPerSec?: number;
  readonly maxKeys?: number;
  readonly now?: () => number;
}

/**
 * A small in-process token bucket per session. A legitimate worker makes a handful of calls per
 * minute (one part URL per ~100 s, one checkpoint per 120 s, a burst of 4-5 at the finish), so the
 * defaults leave a large margin; only a loop trips it. Bounded in memory: when more than `maxKeys`
 * sessions are tracked, the stalest entries are dropped.
 */
export function createSessionLimiter(options: SessionLimiterOptions = {}): SessionLimiter {
  const capacity = options.capacity ?? 30;
  const refillPerSec = options.refillPerSec ?? 3;
  const maxKeys = options.maxKeys ?? 2000;
  const now = options.now ?? Date.now;
  const buckets = new Map<string, { tokens: number; at: number }>();
  return {
    take(key: string): boolean {
      const t = now();
      let bucket = buckets.get(key);
      if (!bucket) {
        if (buckets.size >= maxKeys) {
          // Map keeps insertion order; refresh-on-use below keeps the front the stalest.
          const oldest = buckets.keys().next().value;
          if (oldest !== undefined) buckets.delete(oldest);
        }
        bucket = { tokens: capacity, at: t };
      } else {
        buckets.delete(key);
        bucket = { tokens: Math.min(capacity, bucket.tokens + ((t - bucket.at) / 1000) * refillPerSec), at: t };
      }
      const allowed = bucket.tokens >= 1;
      if (allowed) bucket.tokens -= 1;
      buckets.set(key, bucket);
      return allowed;
    },
  };
}

// ---------------------------------------------------------------- the gate

export interface R1RecordingGateDeps {
  readonly db: R1DbClient;
  /** `getR1Config().enabled` */
  readonly r1Enabled: () => boolean;
  readonly recordingConfig: () => R1RecordingConfig;
  readonly enqueue: (name: string, payload: unknown, options: { dedupKey: string; maxAttempts: number }) => Promise<unknown>;
  readonly now: () => Date;
  readonly limiter: SessionLimiter;
  /** A sanitized category code; never a value. */
  readonly log: (category: string) => void;
}

const refuse = (status: number, error: string): R1RecordingGateOutcome => ({ ok: false, status, error });

export async function runRecordingGate(deps: R1RecordingGateDeps, body: unknown): Promise<R1RecordingGateOutcome> {
  try {
    // 1. both switches
    const config = deps.recordingConfig();
    if (!deps.r1Enabled() || !config.enabled) return refuse(503, 'r1_recording_disabled');

    // 2. the room and its live R1 browser session
    const room = (body as { room?: unknown } | null | undefined)?.room;
    if (typeof room !== 'string' || !ROOM.test(room)) return refuse(400, 'invalid_r1_room');
    const { data: session, error: sessionError } = await deps.db
      .from('call_sessions')
      .select('id,candidate_id,interview_round_id,status,external_call_id,mode')
      .eq('external_call_id', room)
      .maybeSingle();
    if (sessionError) return refuse(503, 'service_unavailable');
    const sessionId = toCanonicalUuid(session?.id);
    const roundId = toCanonicalUuid(session?.interview_round_id);
    if (
      !session
      || session.mode !== 'browser'
      || !roundId
      || !sessionId
      || !LIVE_STATUSES.includes(session.status)
      || session.external_call_id !== room
    ) {
      return refuse(409, 'r1_session');
    }
    if (!deps.limiter.take(sessionId)) return refuse(429, 'rate_limited');

    // 3. the operational switch
    const { data: settings, error: settingsError } = await deps.db
      .from('r1_settings')
      .select('recording_mode')
      .eq('singleton', true)
      .maybeSingle();
    if (settingsError || !settings) return refuse(503, 'service_unavailable');
    const serverMode = asRecordingMode((settings as { recording_mode?: unknown }).recording_mode);
    if (serverMode === 'off') return refuse(503, 'r1_recording_disabled');

    // 4. the candidate's live consent to recording
    const consent = await loadRoundLiveConsent(deps.db, roundId);
    const granted = consent !== null && Array.isArray(consent.consents) && consent.consents.includes(R1_RECORDING_CONSENT);
    if (!granted) {
      await onConsentGone(deps, sessionId, roundId);
      return refuse(409, 'r1_consent_withdrawn');
    }

    return { ok: true, ctx: { sessionId, roundId, config, serverMode } };
  } catch {
    deps.log('r1_recording_gate_error');
    return refuse(503, 'service_unavailable');
  }
}

/**
 * The round has no live consent to recording while a worker is (or was) recording. The worker is told
 * 409 either way (stop, delete what you hold, the interview goes on). But only a WITHDRAWAL erases
 * what is already stored: then mark the existing recording for erasure and queue the erase job, so it
 * is removed even if the withdrawal trigger's own job was lost. A consent that was merely SUPERSEDED
 * by a newer template (two writes: the old one is closed, the new one inserted; the insert can fail)
 * leaves a round with no live consent and no withdrawal, and nothing is erased for that. Best effort:
 * the sweep's withdrawal backstop covers a failure here.
 */
async function onConsentGone(deps: R1RecordingGateDeps, sessionId: string, roundId: string): Promise<void> {
  try {
    const row = await loadRecording(deps.db, sessionId);
    if (!row || row.deleted_at !== null) return;
    if (!(await recordingWithdrawn(deps.db, roundId, row.created_at))) return;
    await markDeleteRequested(deps.db, sessionId, 'consent_withdrawn', deps.now().toISOString());
    await deps.enqueue(
      R1_RECORDING_ERASE_QUEUE,
      { session_id: sessionId, reason: 'consent_withdrawn' },
      { dedupKey: `${R1_RECORDING_ERASE_QUEUE}:session:${sessionId}`, maxAttempts: 5 },
    );
  } catch {
    deps.log('r1_recording_withdraw_side_effect_failed');
  }
}
