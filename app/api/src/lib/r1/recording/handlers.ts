/**
 * Queue handlers of the R1 recording lane. Registered ONLY in the R1 runtime's second runner
 * (`r1-storage`, `lib/r1/runtime.ts`), never in the phone runtime.
 *
 * `r1.recording.finalize` (payload `{ session_id }`, enqueued by the 0127 trigger when a recording
 * reaches `finishing`) runs {@link finalizeRecording}.
 * `r1.recording.erase` (payload `{ round_id, reason }` from the 0127 consent trigger, or
 * `{ session_id, reason }` from the worker gate / finalize) runs the erase routine (erase.ts).
 * `r1.sweep` (payload `{ bucket }`, one per 15 minutes) runs the housekeeping tasks (sweep.ts).
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
import {
  eraseRoundRecordings,
  eraseSessionRecording,
  isEraseReason,
  type R1EraseBatchResult,
  type R1EraseReason,
} from './erase.js';
import { finalizeRecording, type R1FinalizeOutcome } from './finalize.js';
import { toCanonicalUuid } from './keys.js';
import { runR1Sweep, sweepHadErrors, type R1SweepReport } from './sweep.js';
import type { R1ObjectStore } from './store.js';

export { R1_RECORDING_ERASE_QUEUE, R1_RECORDING_FINALIZE_QUEUE, R1_SWEEP_QUEUE } from './queues.js';

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
    // The claim gate normally keeps this from happening; if the config flipped since, wait.
    if (!config.enabled) return unconfigured();
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
      return deferOrThrow(error, job, clock().getTime());
    }
  };
}

// ---------------------------------------------------------------- shared by the jobs below

type EnabledConfig = Extract<R1RecordingConfig, { enabled: true }>;

/** The job waits while the R2 secrets are not configured on this machine (no attempt is spent). */
function unconfigured(): QueueHandlerResult {
  return { outcome: 'defer', reasonCode: R1_STORAGE_UNCONFIGURED_REASON, delaySeconds: R1_STORAGE_UNCONFIGURED_SECONDS };
}

/** A transient object-store failure defers (bounded); everything else fails the job under its lease. */
function deferOrThrow(error: unknown, job: QueueJob<unknown>, nowMs: number): QueueHandlerResult {
  const code = error instanceof Error ? error.message : '';
  if (code === 'r1_storage_unavailable' && storageDeferAllowed(job, nowMs)) {
    return { outcome: 'defer', reasonCode: R1_STORAGE_DEFER_REASON, delaySeconds: R1_STORAGE_DEFER_SECONDS };
  }
  throw error;
}

// ---------------------------------------------------------------- r1.recording.erase

export interface R1RecordingEraseHandlerDeps {
  readonly db: R1DbClient;
  readonly recordingConfig: () => R1RecordingConfig;
  readonly store: (config: EnabledConfig) => R1ObjectStore;
  readonly now?: () => Date;
  /** Observer for tests and metrics; receives the counters only. */
  readonly onResult?: (result: R1EraseBatchResult) => void;
}

export type R1EraseTarget =
  | { readonly kind: 'round'; readonly id: string; readonly reason: R1EraseReason }
  | { readonly kind: 'session'; readonly id: string; readonly reason: R1EraseReason };

/**
 * `{ round_id, reason? }` (consent trigger) or `{ session_id, reason? }` (gate / finalize). A missing
 * reason is `consent_withdrawn`; an unknown one, a missing id, or BOTH ids make the payload malformed.
 */
export function parseEraseTarget(payload: unknown): R1EraseTarget | null {
  if (payload === null || typeof payload !== 'object' || Array.isArray(payload)) return null;
  const body = payload as Record<string, unknown>;
  const reason = body.reason === undefined ? 'consent_withdrawn' : body.reason;
  if (!isEraseReason(reason)) return null;
  const round = toCanonicalUuid(body.round_id);
  const session = toCanonicalUuid(body.session_id);
  if (round && !session && body.session_id === undefined) return { kind: 'round', id: round, reason };
  if (session && !round && body.round_id === undefined) return { kind: 'session', id: session, reason };
  return null;
}

export function createR1RecordingEraseHandler(deps: R1RecordingEraseHandlerDeps): QueueHandler {
  const clock = deps.now ?? ((): Date => new Date());
  return async (job: QueueJob<unknown>): Promise<QueueHandlerResult> => {
    const target = parseEraseTarget(job.payload);
    if (!target) throw new Error('malformed_r1_recording_payload');
    const config = deps.recordingConfig();
    if (!config.enabled) return unconfigured();
    try {
      const eraseDeps = { db: deps.db, store: deps.store(config), bucket: config.s3.bucket, now: clock };
      const result = target.kind === 'round'
        ? await eraseRoundRecordings(eraseDeps, target.id, target.reason)
        : await eraseSessionRecording(eraseDeps, target.id, target.reason);
      deps.onResult?.(result);
    } catch (error) {
      return deferOrThrow(error, job, clock().getTime());
    }
  };
}

// ---------------------------------------------------------------- r1.sweep

export interface R1SweepHandlerDeps {
  readonly db: R1DbClient;
  readonly recordingConfig: () => R1RecordingConfig;
  readonly store: (config: EnabledConfig) => R1ObjectStore;
  readonly enqueue: (name: string, payload: unknown, options: { dedupKey: string; maxAttempts: number }) => Promise<unknown>;
  readonly now?: () => Date;
  /** A fixed category code; never a value. */
  readonly log?: (category: string) => void;
  /** Observer for tests and metrics; receives the counters only. */
  readonly onResult?: (report: R1SweepReport) => void;
}

/**
 * The sweep never fails because a task did (each task is isolated and counted); it returns normally
 * so the 15-minute cadence is the retry. A run that had errors logs one fixed category.
 */
export function createR1SweepHandler(deps: R1SweepHandlerDeps): QueueHandler {
  const clock = deps.now ?? ((): Date => new Date());
  return async (): Promise<QueueHandlerResult> => {
    const config = deps.recordingConfig();
    if (!config.enabled) return unconfigured();
    const report = await runR1Sweep({
      db: deps.db,
      store: deps.store(config),
      bucket: config.s3.bucket,
      now: clock,
      enqueue: deps.enqueue,
      ...(deps.log ? { log: deps.log } : {}),
    });
    if (sweepHadErrors(report)) deps.log?.('r1_sweep_had_errors');
    deps.onResult?.(report);
  };
}

