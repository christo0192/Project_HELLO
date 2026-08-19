/**
 * lib/recording/finalize-worker.ts — the queue handler for one session's
 * authoritative-recording finalization.
 *
 * This is the actor that did not exist. `finalizeAuthoritativeRecording` was
 * only ever reachable from a candidate's browser tab or a recruiter pressing
 * play; a session completed by the voice worker had nobody to call it and
 * froze at `recording_egress_status = 'active'` with a NULL object key.
 *
 * OUTCOME MAPPING — three outcomes, not two
 *   'ready'             → complete the claim. Converged.
 *   'fallback_required' → complete the claim. The row is now TRUTHFULLY
 *                         `'failed'` (or has no egress at all); the job's work
 *                         is done and retrying it cannot change the answer.
 *   'pending'           → return a DEFER DIRECTIVE, never a throw. A wait must
 *                         not be charged against a failure budget: five waits
 *                         would otherwise dead-letter a session whose only
 *                         problem is that storage had not caught up yet.
 *   a genuine throw     → fail the claim under its lease (retry, then DLQ).
 *                         Reserved for "the database is unreachable"-class
 *                         faults, where retrying really is the right answer.
 *
 * EXHAUSTION ends the deferral loop. Once 0038 stamps
 * `recording_finalize_exhausted_at`, further deferrals would poll forever, so
 * the job COMPLETES and the durable terminus lives on the session row where
 * `/api/recordings/health` and the sweeper's predicate can both see it. That
 * is a loud stop, not a silent one: it is logged and counted.
 */

import type { QueueJob } from '../queue/types.js';
import {
  isDeferDirective,
  type QueueDeferDirective,
  type QueueHandler,
  type QueueHandlerResult,
} from '../queue/runner.js';
import { createLogger } from '../logger.js';
import {
  egressFinalizeConfigured,
  finalizeAuthoritativeRecording,
  recordRecordingFinalizeDeferral,
  type RecordingFinalizeDeferReason,
  type RecordingFinalizeStatus,
} from '../recording-egress.js';
import type { SupabaseClient } from '@supabase/supabase-js';
import { supabase } from '../supabase.js';

/** Base delay for a finalize deferral, in seconds. */
export const BASE_DEFER_SECONDS = 30;
/** Ceiling for the geometric deferral delay, in seconds (the queue clamps at 3600). */
export const MAX_DEFER_SECONDS = 900;

/**
 * Geometric backoff for a deferral.
 *
 * The exponent comes from the SESSION's `recording_finalize_attempts`, not
 * from `job_queue.attempts`: `defer_job` REFUNDS the attempt the claim
 * charged (`attempts = greatest(attempts - 1, 0)`), so the job's own counter
 * is flat across a hundred deferrals and cannot serve as an exponent.
 */
export function deferDelaySeconds(attempts: number | null): number {
  const n = typeof attempts === 'number' && Number.isFinite(attempts) && attempts > 0
    ? Math.min(Math.floor(attempts), 10)
    : 1;
  return Math.min(MAX_DEFER_SECONDS, BASE_DEFER_SECONDS * Math.pow(2, n - 1));
}

/** Read a UUID session id out of an untrusted job payload. */
export function sessionIdFromPayload(payload: unknown): string | null {
  if (payload === null || typeof payload !== 'object') return null;
  const raw = (payload as Record<string, unknown>).session_id;
  if (typeof raw !== 'string') return null;
  return /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(raw)
    ? raw
    : null;
}

export interface FinalizeHandlerOptions {
  maxAttempts: number;
  /** Injectable finalizer seam (tests, and the precedence suite). */
  finalize?: (sessionId: string) => Promise<RecordingFinalizeStatus>;
  /** Injectable configuration probe. */
  configured?: () => boolean;
  /** Injectable deferral recorder. */
  recordDeferral?: (
    sessionId: string,
    reason: RecordingFinalizeDeferReason,
    maxAttempts: number,
  ) => Promise<{ attempts: number | null; exhausted: boolean }>;
  /** Injectable session reader for the post-deferral bookkeeping read. */
  client?: SupabaseClient;
}

interface DeferralSnapshot {
  attempts: number | null;
  reason: string | null;
  exhausted: boolean;
}

/**
 * Read back what `finalizeAuthoritativeRecording` persisted about its own
 * deferral, so the directive carries the real reason and the real exponent
 * rather than a guess. Best-effort: an unreadable row degrades to the generic
 * code and the base delay, never to a failure.
 */
async function readDeferralSnapshot(
  client: SupabaseClient,
  sessionId: string,
): Promise<DeferralSnapshot> {
  try {
    const { data, error } = await client
      .from('call_sessions')
      .select('recording_finalize_attempts, recording_finalize_defer_reason, recording_finalize_exhausted_at')
      .eq('id', sessionId)
      .maybeSingle();
    if (error || !data) return { attempts: null, reason: null, exhausted: false };
    const row = data as {
      recording_finalize_attempts?: unknown;
      recording_finalize_defer_reason?: unknown;
      recording_finalize_exhausted_at?: unknown;
    };
    return {
      attempts: typeof row.recording_finalize_attempts === 'number'
        ? row.recording_finalize_attempts
        : null,
      reason: typeof row.recording_finalize_defer_reason === 'string'
        ? row.recording_finalize_defer_reason
        : null,
      exhausted: Boolean(row.recording_finalize_exhausted_at),
    };
  } catch {
    return { attempts: null, reason: null, exhausted: false };
  }
}

/**
 * Build the `recording.finalize` handler.
 *
 * Ashby-INDEPENDENT by construction: nothing in this module reads an Ashby
 * env var, imports an Ashby module, or constructs an Ashby object. That is a
 * requirement, not a nicety — the Ashby runtime is paused on the deployment
 * this repair exists for, and recording convergence must not depend on it.
 */
export function createRecordingFinalizeHandler(
  options: FinalizeHandlerOptions,
): QueueHandler {
  const logger = createLogger('recording-finalize');
  const finalize = options.finalize ?? ((id: string) => finalizeAuthoritativeRecording(id));
  const configured = options.configured ?? egressFinalizeConfigured;
  const recordDeferral = options.recordDeferral
    ?? ((id, reason, max) => recordRecordingFinalizeDeferral(id, reason, max));
  const client = options.client ?? (supabase as unknown as SupabaseClient);

  const deferDirective = (
    reasonCode: string,
    attempts: number | null,
  ): QueueDeferDirective => ({
    outcome: 'defer',
    reasonCode,
    delaySeconds: deferDelaySeconds(attempts),
  });

  return async function handleRecordingFinalize(
    job: QueueJob<unknown>,
  ): Promise<QueueHandlerResult> {
    const sessionId = sessionIdFromPayload(job.payload);
    if (!sessionId) {
      // A payload we cannot address is a PERMANENT fault, not a wait. Throwing
      // routes it through the sanitized failure path and, at max_attempts, the
      // DLQ — where a malformed job belongs.
      throw new Error('malformed_recording_finalize_payload');
    }

    // ── Pre-check: is finalization even possible on this build? ──────────
    // `finalizeAuthoritativeRecording` never consulted the enable flag, so on
    // a build with egress disabled but legacy rows still carrying an egress
    // id, `egressClient()` would construct against an empty LiveKit URL and
    // THROW — dead-lettering, after five attempts, a job whose only problem is
    // that the feature is switched off. Defer instead.
    if (!configured()) {
      const record = await recordDeferral(sessionId, 'egress_disabled', options.maxAttempts);
      if (record.exhausted) {
        logger.warn('unknown_event', {
          error_category: 'recording_finalize_exhausted',
          error_type: 'egress_disabled',
        });
        return;
      }
      return deferDirective('egress_disabled', record.attempts);
    }

    let status: RecordingFinalizeStatus;
    try {
      status = await finalize(sessionId);
    } catch {
      // The one place a provider/storage exception was swallowed into silence.
      // It is still not a job failure — a provider outage is a wait — but it
      // is now RECORDED and counted before it becomes one.
      const record = await recordDeferral(sessionId, 'provider_error', options.maxAttempts);
      logger.warn('unknown_event', {
        error_category: 'recording_finalize_provider_error',
        error_type: 'provider_error',
      });
      if (record.exhausted) {
        logger.error('unknown_event', {
          error_category: 'recording_finalize_exhausted',
          error_type: 'provider_error',
        });
        return;
      }
      return deferDirective('provider_error', record.attempts);
    }

    if (status === 'ready' || status === 'fallback_required') {
      // Converged, or truthfully failed. Either way the job's work is done.
      return;
    }

    // 'pending'. `finalizeAuthoritativeRecording` has already persisted WHY.
    const snapshot = await readDeferralSnapshot(client, sessionId);
    if (snapshot.exhausted) {
      // The terminus. Deferring forever would keep a job alive against a row
      // that has given up; the durable state lives on the session, where the
      // sweeper's predicate and /api/recordings/health can both read it.
      logger.error('unknown_event', {
        error_category: 'recording_finalize_exhausted',
        error_type: snapshot.reason ?? 'unknown',
      });
      return;
    }
    return deferDirective(snapshot.reason ?? 'poll_timeout', snapshot.attempts);
  };
}

export { isDeferDirective };
