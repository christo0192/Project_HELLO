/**
 * Queue handlers of the R1 recording lane. Registered ONLY in the R1 runtime's second runner
 * (`r1-storage`, `lib/r1/runtime.ts`), never in the phone runtime.
 *
 * `r1.recording.finalize` (payload `{ session_id }`, enqueued by the 0127 trigger when a recording
 * reaches `finishing`) runs {@link finalizeRecording}. The erase and sweep handlers join this file in
 * the privacy-lifecycle task.
 *
 * RETRY AND DEFERRAL. A throwing handler fails the job under its lease (bounded retry with backoff,
 * five attempts, then the DLQ row `v_funnel_failures` shows as category `recording`). A TRANSIENT
 * object-store failure (`r1_storage_unavailable`: a 5xx, a timeout, SlowDown) does not say the job is
 * bad, so it is returned as a deferral that REFUNDS the attempt, within explicit bounds: a streak
 * older than an hour, or 30 deferrals in total, stop deferring and the failure then counts like any
 * other. Everything else (rejected credentials, a refused completion, a database error) fails
 * normally because waiting cannot fix it and the DLQ row is the operator alert.
 */

import type { R1DbClient } from '../../../services/r1-assessment.js';
import type { QueueHandler, QueueHandlerResult } from '../../queue/runner.js';
import type { QueueJob } from '../../queue/types.js';
import type { R1RecordingConfig } from './config.js';
import { finalizeRecording, type R1FinalizeOutcome } from './finalize.js';
import { toCanonicalUuid } from './keys.js';
import type { R1ObjectStore } from './store.js';

export { R1_RECORDING_FINALIZE_QUEUE } from './queues.js';

/** Deferral bounds for a transient object-store failure. */
export const R1_STORAGE_DEFER_SECONDS = 60;
export const R1_STORAGE_DEFER_MAX_MS = 60 * 60 * 1000;
export const R1_STORAGE_DEFER_MAX_COUNT = 30;
export const R1_STORAGE_DEFER_REASON = 'r1_storage_unavailable';
/** The job waits (no attempt spent) while the R2 secrets are not configured on this machine. */
export const R1_STORAGE_UNCONFIGURED_REASON = 'r1_storage_unconfigured';
export const R1_STORAGE_UNCONFIGURED_SECONDS = 300;

export interface R1RecordingHandlerDeps {
  readonly db: R1DbClient;
  readonly recordingConfig: () => R1RecordingConfig;
  readonly store: (config: Extract<R1RecordingConfig, { enabled: true }>) => R1ObjectStore;
  readonly enqueue: (name: string, payload: unknown, options: { dedupKey: string; maxAttempts: number }) => Promise<unknown>;
  readonly now?: () => Date;
  /** Observer for tests and metrics; receives the outcome only. */
  readonly onResult?: (outcome: R1FinalizeOutcome) => void;
}

function payloadSessionId(payload: unknown): string | null {
  if (payload === null || typeof payload !== 'object') return null;
  return toCanonicalUuid((payload as Record<string, unknown>).session_id);
}

/** May a transient storage failure of this job still be deferred? Both bounds come from the job's own columns. */
export function storageDeferAllowed(job: QueueJob<unknown>, nowMs: number): boolean {
  const count = typeof job.deferCount === 'number' ? job.deferCount : 0;
  if (count >= R1_STORAGE_DEFER_MAX_COUNT) return false;
  const since = job.deferredAt ? Date.parse(job.deferredAt) : Number.NaN;
  return !Number.isFinite(since) || nowMs - since < R1_STORAGE_DEFER_MAX_MS;
}

export function createR1RecordingFinalizeHandler(deps: R1RecordingHandlerDeps): QueueHandler {
  const clock = deps.now ?? ((): Date => new Date());
  return async (job: QueueJob<unknown>): Promise<QueueHandlerResult> => {
    const sessionId = payloadSessionId(job.payload);
    if (!sessionId) throw new Error('malformed_r1_recording_payload');
    const config = deps.recordingConfig();
    if (!config.enabled) {
      // The claim gate normally keeps this from happening; if the config flipped since, wait.
      return { outcome: 'defer', reasonCode: R1_STORAGE_UNCONFIGURED_REASON, delaySeconds: R1_STORAGE_UNCONFIGURED_SECONDS };
    }
    try {
      const outcome = await finalizeRecording(
        {
          db: deps.db,
          store: deps.store(config),
          maxBytes: config.maxBytes,
          now: clock,
          enqueue: deps.enqueue,
        },
        sessionId,
      );
      deps.onResult?.(outcome);
    } catch (error) {
      const code = error instanceof Error ? error.message : '';
      if (code === 'r1_storage_unavailable' && storageDeferAllowed(job, clock().getTime())) {
        return { outcome: 'defer', reasonCode: R1_STORAGE_DEFER_REASON, delaySeconds: R1_STORAGE_DEFER_SECONDS };
      }
      throw error;
    }
  };
}
