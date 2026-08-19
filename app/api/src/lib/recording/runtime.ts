/**
 * lib/recording/runtime.ts — the composition root for recording finalization.
 *
 * ASHBY-INDEPENDENT BY CONSTRUCTION. Nothing in this module (or in the modules
 * it composes) reads an Ashby environment variable, imports an Ashby module,
 * or constructs an Ashby object. That is the requirement the canary makes
 * non-negotiable: the Ashby runtime is PAUSED on that deployment, and
 * recording convergence must keep working anyway. `index.ts` builds and starts
 * this runtime in its own try/catch so a failure of either runtime cannot
 * prevent the other — or the HTTP server — from starting.
 *
 * FOUR LOOPS, and why each one is load-bearing:
 *
 *   recording-finalize  the queue runner. Drains the durable intent the 0038
 *                       trigger records inside the completing CAS.
 *   recording-sweep     the backstop for the accumulated backlog and for any
 *                       terminal write the trigger's WHEN clause misses.
 *   recording-reclaim   NOT optional. `uq_job_queue_dedup_active` covers
 *                       `active`, so a machine that dies mid-finalize leaves
 *                       the job active with an expired lease — after which the
 *                       trigger's `on conflict do nothing` and the sweeper's
 *                       dedup-keyed enqueue are BOTH silent no-ops and the
 *                       session is stuck forever. The only recovery is
 *                       `reclaim_expired_jobs`, whose sole production caller
 *                       was the ASHBY scheduler. Reproducing the exact failure
 *                       this change repairs, one level up in the queue, on the
 *                       exact configuration it was written for, is not an
 *                       acceptable outcome — so this runtime drives its own.
 *   recording-reap      bounds terminal `job_queue` growth. The trigger
 *                       enqueues one job per RECORDED SESSION (not per stuck
 *                       one), `complete_job` leaves the row at `completed`,
 *                       and nothing in this repository ever deleted one.
 *
 * NOTE ON THE SHARED RECLAIM BUDGET: `reclaim_expired_jobs` is
 * queue-name-AGNOSTIC — its signature is `(timestamptz, integer)` with no
 * queue name — so with both runtimes enabled the Ashby reclaim loop (limit 50)
 * and this one (limit 25) share ONE global per-pass budget. The limits are set
 * so neither can starve the other, and this is stated because it is not
 * discoverable from either call site alone.
 */

import type { SupabaseClient } from '@supabase/supabase-js';
import { Queue } from '../queue/index.js';
import { PgAdapter } from '../queue/pg-adapter.js';
import { createQueueRunner, type QueueRunnerHandle } from '../queue/runner.js';
import { createLoopScheduler, queueRunnerTick, type LoopSchedulerHandle } from '../scheduler.js';
import { createLogger } from '../logger.js';
import { supabase } from '../supabase.js';
import {
  effectiveSweepAdmission,
  loadRecordingRuntimeConfig,
  RECORDING_FINALIZE_QUEUE,
  type RecordingRuntimeConfig,
} from './config.js';
import { createHaltReader, type HaltReader } from './halt.js';
import { createRecordingFinalizeHandler } from './finalize-worker.js';
import type { RecordingFinalizeStatus } from '../recording-egress.js';
import { runRecordingSweep, type SweepResult } from './sweeper.js';

export interface RecordingRuntimeOptions {
  client?: SupabaseClient;
  config?: RecordingRuntimeConfig;
  /** Opaque worker identity used as the lease owner. Never a secret. */
  owner?: string;
  /** Test seams for the scheduler's timers/jitter/clock. */
  scheduler?: {
    setTimer?: (fn: () => void, ms: number) => { unref?: () => void };
    clearTimer?: (handle: unknown) => void;
    random?: () => number;
    now?: () => number;
  };
  /** Injected queue (tests use the in-memory adapter). */
  queue?: Queue;
  /**
   * Injectable finalizer seam. Production always uses the real
   * `finalizeAuthoritativeRecording`; the convergence suite drives the
   * composition end-to-end without a LiveKit provider or a storage bucket.
   */
  finalize?: (sessionId: string) => Promise<RecordingFinalizeStatus>;
  /** Injectable configuration probe (same rationale as `finalize`). */
  configured?: () => boolean;
}

export interface RecordingRuntimeHandle {
  scheduler: LoopSchedulerHandle;
  runner: QueueRunnerHandle;
  queue: Queue;
  halt: HaltReader;
  loopIntervalsMs: Record<string, number>;
  /** Last completed sweep pass, for the health surface. Process-local. */
  lastSweep(): SweepResult | null;
  /** Drive one pass of every loop (tests; never used in production). */
  tickAll(): Promise<void>;
  stop(): Promise<void>;
}

/**
 * Build the runtime, or return null when the gate is closed.
 *
 * With the shipped defaults `RECORDING_FINALIZE_WORKER_ENABLED=false`, so
 * nothing is constructed: no runner, no scheduler, no timer, no DB poll. The
 * 0038 trigger still records finalization intent durably in `job_queue` while
 * the worker is off — that accumulation is bounded by the reaper in §7 of the
 * migration, and is what makes enabling later a drain rather than a rebuild.
 */
export function createRecordingRuntime(
  options: RecordingRuntimeOptions = {},
): RecordingRuntimeHandle | null {
  const config = options.config ?? loadRecordingRuntimeConfig();
  if (!config.enabled) return null;

  const logger = createLogger('recording-runtime');
  const client = options.client ?? (supabase as unknown as SupabaseClient);
  const queue = options.queue
    ?? new Queue(new PgAdapter(client), { defaultMaxAttempts: 5 });
  const owner = options.owner ?? `recording-${process.pid}`;
  const halt = createHaltReader({ client, ttlMs: config.haltTtlMs });

  const { admission, clamped } = effectiveSweepAdmission(config);
  if (clamped) {
    // The producer was configured to outrun the consumer. Clamping rather than
    // refusing to start keeps convergence working; saying so keeps the
    // operator from believing the configured rate is the real one.
    logger.warn('unknown_event', {
      error_category: 'recording_sweep_admission_clamped',
      error_type: 'drain_invariant',
    });
  }

  const handler = createRecordingFinalizeHandler({
    maxAttempts: config.maxAttempts,
    client,
    ...(options.finalize ? { finalize: options.finalize } : {}),
    ...(options.configured ? { configured: options.configured } : {}),
  });

  const runner = createQueueRunner({
    queue,
    handlers: { [RECORDING_FINALIZE_QUEUE]: handler },
    owner,
    leaseSeconds: config.leaseSeconds,
    concurrency: config.concurrency,
    pollMs: config.pollMs,
    // The SAME halt flag that freezes the sweep also freezes claiming, so a
    // runaway backlog can be frozen at both ends. Cached, because this gate
    // runs on every poll and its contract requires a cheap consult; fail-OPEN,
    // because failing closed would let one DB error stop all claiming (see
    // lib/recording/halt.ts).
    shouldClaim: () => halt.admits(),
    onEvent: (e) => {
      // Metadata only: queue name + sanitized code. Never a payload or token.
      logger.info('unknown_event', {
        error_category: `recording_queue_${e.kind}`,
        error_type: e.queueName,
      });
    },
  });

  let lastSweep: SweepResult | null = null;

  const scheduler = createLoopScheduler({
    ...(options.scheduler ?? {}),
    metricPrefix: 'recording',
    loops: [
      {
        name: 'recording-finalize',
        intervalMs: config.pollMs,
        tick: queueRunnerTick(runner),
      },
      {
        name: 'recording-sweep',
        intervalMs: config.sweepMs,
        tick: async () => {
          const result = await runRecordingSweep({
            client,
            queue,
            halt,
            admission,
            graceSec: config.graceSec,
            maxAgeSec: config.sweepMaxAgeSec,
            maxAttempts: 5,
          });
          lastSweep = result;
          return result.enqueued > 0;
        },
      },
      {
        name: 'recording-reclaim',
        intervalMs: config.reclaimMs,
        tick: async () => {
          const r = await queue.reclaimExpired({ limit: config.reclaimLimit });
          return r.requeued.length + r.deadLettered.length > 0;
        },
      },
      {
        name: 'recording-reap',
        intervalMs: config.reapMs,
        tick: async () => {
          const { data, error } = await client.rpc('reap_completed_jobs', {
            p_older_than_seconds: config.reapAgeSec,
            p_limit: config.reapLimit,
          });
          if (error) return false;
          const row = (data ?? {}) as { deleted?: unknown; truncated?: unknown };
          if (row.truncated === true) {
            // A full budget means terminal rows are accumulating faster than
            // this cadence removes them.
            logger.warn('unknown_event', {
              error_category: 'recording_job_reap_truncated',
              error_type: 'reap_budget',
            });
          }
          return typeof row.deleted === 'number' && row.deleted > 0;
        },
      },
    ],
  });

  return {
    scheduler,
    runner,
    queue,
    halt,
    loopIntervalsMs: {
      'recording-finalize': config.pollMs,
      'recording-sweep': config.sweepMs,
      'recording-reclaim': config.reclaimMs,
      'recording-reap': config.reapMs,
    },
    lastSweep: () => lastSweep,
    async tickAll(): Promise<void> {
      await runner.tick();
    },
    async stop(): Promise<void> {
      await scheduler.stop();
      await runner.stop();
    },
  };
}
