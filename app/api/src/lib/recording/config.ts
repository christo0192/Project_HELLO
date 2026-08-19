/**
 * lib/recording/config.ts — the bounded shape of the finalization runtime,
 * and the ONE invariant that keeps it from digging its own backlog.
 *
 * Every value arrives already clamped from `lib/env.ts`; this module exists so
 * the producer/consumer relationship between the sweeper and the queue runner
 * is a checked property rather than a coincidence of two defaults.
 */

import { env } from '../env.js';

/** Queue name for one session's authoritative-recording finalization. */
export const RECORDING_FINALIZE_QUEUE = 'recording.finalize';

/** Deterministic dedup key. Identical to the 0038 trigger's literal. */
export function recordingFinalizeDedupKey(sessionId: string): string {
  return `${RECORDING_FINALIZE_QUEUE}:${sessionId}`;
}

/**
 * The 0006 terminal set, in full.
 *
 * `completed` alone is NOT the stuck population. `lib/reconciliation.ts`
 * transitions a stale session to `expired`/`idle_timeout` — the existing
 * repair for a candidate who closed the tab and never called
 * `POST /:sessionId/complete`, i.e. precisely the rows that have a live
 * egress, a NULL object key, and nobody to finalize them. This constant, the
 * 0038 trigger's WHEN clause, and the 0038 partial index must stay identical:
 * a partial index narrower than the query predicate is not merely unused, it
 * silently changes which rows are eligible.
 */
export const TERMINAL_SESSION_STATUSES: readonly string[] = [
  'completed', 'failed', 'cancelled', 'expired',
];

export interface RecordingRuntimeConfig {
  enabled: boolean;
  graceSec: number;
  maxAttempts: number;
  concurrency: number;
  sweepAdmission: number;
  sweepMaxAgeSec: number;
  pollMs: number;
  sweepMs: number;
  reclaimMs: number;
  reclaimLimit: number;
  leaseSeconds: number;
  haltTtlMs: number;
  reapMs: number;
  reapAgeSec: number;
  reapLimit: number;
}

/** Read the runtime shape from the process env (already clamped there). */
export function loadRecordingRuntimeConfig(): RecordingRuntimeConfig {
  return {
    enabled: env.recordingFinalizeWorkerEnabled,
    graceSec: env.recordingFinalizeGraceSec,
    maxAttempts: env.recordingFinalizeMaxAttempts,
    concurrency: env.recordingFinalizeConcurrency,
    sweepAdmission: env.recordingFinalizeSweepAdmission,
    sweepMaxAgeSec: env.recordingFinalizeSweepMaxAgeSec,
    pollMs: env.recordingFinalizePollMs,
    sweepMs: env.recordingFinalizeSweepMs,
    reclaimMs: env.recordingFinalizeReclaimMs,
    reclaimLimit: env.recordingFinalizeReclaimLimit,
    leaseSeconds: env.recordingFinalizeLeaseSec,
    haltTtlMs: env.recordingFinalizeHaltTtlMs,
    reapMs: env.recordingJobReapMs,
    reapAgeSec: env.recordingJobReapAgeSec,
    reapLimit: env.recordingJobReapLimit,
  };
}

/**
 * Maximum rows the consumer can drain in ONE sweep window.
 *
 * `runner.tick()` claims at most `concurrency` NEW jobs per tick
 * (`while (active < concurrency)` in lib/queue/runner.ts) and the scheduler
 * then waits `pollMs`. So over one `sweepMs` window the fleet member drains
 * at most `concurrency × floor(sweepMs / pollMs)` jobs.
 */
export function drainCapacityPerSweep(config: RecordingRuntimeConfig): number {
  return config.concurrency * Math.max(1, Math.floor(config.sweepMs / config.pollMs));
}

/**
 * THE INVARIANT: a sweep may not admit more work than the runner can drain
 * before the next sweep.
 *
 * Violating it means the backlog GROWS for as long as the sweeper runs, which
 * makes the "converged within ~2 minutes of ended_at" target unreachable for
 * anything but a near-empty queue, and — worse — makes it unreachable
 * SILENTLY, since the three sweeper bounds all bound the PRODUCER and none of
 * them measures the queue.
 *
 * Returns the effective admission: the configured value when the invariant
 * holds, the drain capacity when an operator has raised admission past it. It
 * never throws — a misconfigured knob must degrade the rate, not refuse to
 * start a subsystem whose entire purpose is convergence — and the clamp is
 * reported so the truncation is not silent.
 */
export function effectiveSweepAdmission(
  config: RecordingRuntimeConfig,
): { admission: number; clamped: boolean } {
  const capacity = drainCapacityPerSweep(config);
  if (config.sweepAdmission <= capacity) {
    return { admission: config.sweepAdmission, clamped: false };
  }
  return { admission: capacity, clamped: true };
}
