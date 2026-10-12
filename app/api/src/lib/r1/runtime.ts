/**
 * lib/r1/runtime.ts: the composition root for the R1 queue runtime (plan 6.7).
 *
 * ── DEDICATED AND ISOLATED ────────────────────────────────────────────
 * R1 gets its OWN `createQueueRunner` (concurrency 1) and its OWN loop scheduler. The assessment
 * runner hosts exactly one handler, `r1.assessment`. A SECOND runner, `r1-storage` (concurrency 1,
 * its own loop), hosts the recording lane (R1-REC): `r1.recording.finalize`, `r1.recording.erase`
 * (consent withdrawn / declined) and `r1.sweep` (retention, crash salvage, purge outbox). It is
 * separate so a ten-minute scoring job can never delay a deletion or a finalize. Neither runner is EVER
 * registered in the phone runtime (handlers `{phone.dial, phone.assessment}`,
 * `lib/phone-runtime/runtime.ts`) or the recording runtime, and the phone runtime is never
 * touched: `r1-runtime.test.ts` ("structural fences") pins both facts.
 *
 * ── WITH THE SHIPPED DEFAULTS THIS CONSTRUCTS NOTHING ─────────────────
 * `R1_ENABLED` is unset/false, so `createR1Runtime` returns null: no runner, no scheduler, no
 * timer, no database poll, no provider call. When it is on, a DB gate still applies: the
 * runner claims only while `r1_settings.enabled` is true (cached 5 s, FAIL CLOSED: a settings
 * row that cannot be read means "do not claim"). A paused R1 still scores sessions that
 * already finished ("live sessions finish"); a disabled one scores and applies nothing.
 *
 * ── FOUR LOOPS ────────────────────────────────────────────────────────
 *   r1-assessment  drains `r1.assessment` through the handler.
 *   r1-storage     drains the recording lane (`r1.recording.finalize`, `r1.recording.erase`,
 *                  `r1.sweep`). It claims while the R2 recording config is `enabled` and is NOT
 *                  tied to `r1_settings.enabled`: a paused or disabled R1 must still finish a
 *                  recording already in flight, and erase and sweep are privacy obligations that
 *                  a kill switch must never stop. With no R2 config the jobs simply stay
 *                  `pending` (no attempt is spent).
 *   r1-sweep       enqueues `r1.sweep` once per 15-minute bucket (dedup key `r1.sweep:<bucket>`)
 *                  while the R2 recording config is `enabled`. The loop scheduler never waits
 *                  longer than 60 s between ticks, so the tick itself is a cheap in-memory bucket
 *                  test; the bucket is the cadence.
 *   r1-status      closes due 24 h pending rejects (`r1_apply_due_pending_rejects`) and runs
 *                  the override monitor, which switches auto-status off at >10% over a
 *                  rolling 20. Both are SECURITY DEFINER RPCs that re-check the CAS, so a
 *                  second replica is harmless. The loop runs only while R1 is enabled, so a
 *                  window left open while it was off is overdue when R1 comes back: the RPC
 *                  drops a window more than an hour overdue (`window_stale`) instead of
 *                  executing it late. It also LAPSES ORPHANED SESSIONS (`orphan-lapse.ts`): an
 *                  R1 session no worker owns any more (created, waiting or in progress with no
 *                  activity far past anything a live one takes) is failed or expired with a
 *                  terminal reason and its attempt settled, because admission's one-live-R1
 *                  rule is GLOBAL and one such row blocked every R1 start forever. A `waiting`
 *                  row whose room still has a live worker job is spared (the pass asks the R1
 *                  SFU's dispatch list; see `orphan-lapse.ts`). A failure of one half never
 *                  skips the other.
 */

import { randomUUID } from 'node:crypto';
import type { SupabaseClient } from '@supabase/supabase-js';
import { Queue } from '../queue/index.js';
import { PgAdapter } from '../queue/pg-adapter.js';
import { createQueueRunner, type QueueRunnerHandle } from '../queue/runner.js';
import {
  createLoopScheduler,
  queueRunnerTick,
  type LoopSchedulerHandle,
} from '../scheduler.js';
import { createLogger } from '../logger.js';
import { supabase } from '../supabase.js';
import { getR1Config, type R1Config } from './config.js';
import {
  R1_ASSESSMENT_QUEUE,
  createR1AssessmentHandler,
  createR1FinalDeferralGuard,
} from './assessment-handler.js';
import { lapseOrphanedR1Sessions, type R1OrphanLapseOptions } from './orphan-lapse.js';
import { getR1RecordingConfig, type R1RecordingConfig } from './recording/config.js';
import {
  createR1RecordingEraseHandler,
  createR1RecordingFinalizeHandler,
  createR1SweepHandler,
} from './recording/handlers.js';
import { R1_RECORDING_ERASE_QUEUE, R1_RECORDING_FINALIZE_QUEUE, R1_SWEEP_QUEUE } from './recording/queues.js';
import { getR1RecordingStore } from './recording/store-factory.js';
import type { R1ObjectStore } from './recording/store.js';
import { agentDispatchClientFor, browserLiveKitEndpoint } from '../livekit-endpoints.js';
import type { DispatchListerLike } from './worker-gate.js';
import { recordR1ScoringFailure, type R1AssessmentOptions } from '../../services/r1-assessment.js';

/** The ONLY queues this runtime registers. A structural test pins it. */
export const R1_RUNTIME_QUEUES: readonly string[] = [
  R1_ASSESSMENT_QUEUE,
  R1_RECORDING_FINALIZE_QUEUE,
  R1_RECORDING_ERASE_QUEUE,
  R1_SWEEP_QUEUE,
];
/** The queues the `r1-storage` runner claims (everything but scoring). */
const R1_STORAGE_QUEUES: ReadonlySet<string> = new Set([R1_RECORDING_FINALIZE_QUEUE, R1_RECORDING_ERASE_QUEUE, R1_SWEEP_QUEUE]);

export const R1_RUNTIME_BOUNDS = {
  /**
   * A scoring job is bounded by 2 x 4 sequential model calls of 300 s (run 0, then the others;
   * see deepseek-runner.ts); the runner heartbeats the lease every third of it.
   */
  jobLeaseSeconds: 600,
  queuePollMs: 5_000,
  /** The recording lane's poll: finalize is not latency-critical, but it should not lag a minute. */
  storagePollMs: 5_000,
  /** How often the sweep-enqueue loop wakes (the scheduler caps any loop at 60 s anyway). */
  sweepPollMs: 60_000,
  /** The cadence of `r1.sweep`: one job per bucket of this length. */
  sweepBucketMs: 15 * 60_000,
  statusPollMs: 60_000,
  /** How long an `r1_settings.enabled` read is trusted. */
  enabledCacheMs: 5_000,
  pendingRejectBatch: 50,
} as const;

export interface R1RuntimeSnapshot {
  readonly lastStatusApplied: number | null;
  readonly statusLoopErrors: number;
  /** Orphaned sessions the last lapse pass moved to a terminal state (null before the first pass). */
  readonly lastOrphansLapsed: number | null;
  /** Lapse reads/writes that failed (the next pass retries). */
  readonly orphanLapseErrors: number;
  readonly jobEvents: Readonly<Record<string, number>>;
  /** The recording lane's queue events, kept apart from `jobEvents` (scoring). */
  readonly storageJobEvents: Readonly<Record<string, number>>;
}

/**
 * The R1 SFU's agent-dispatch lister, or null when there is none to ask: the browser lane is not
 * on the R1 target, or the R1 credentials are not all set. Read at call time, never at import.
 */
export function defaultR1DispatchLister(): DispatchListerLike | null {
  const endpoint = browserLiveKitEndpoint();
  if (endpoint.target !== 'r1') return null;
  if (!endpoint.url || !endpoint.apiKey || !endpoint.apiSecret) return null;
  return agentDispatchClientFor(endpoint) as unknown as DispatchListerLike;
}

export interface R1RuntimeOptions {
  readonly config?: R1Config;
  readonly client?: SupabaseClient;
  /** Test seam for the orphan lapse's dispatch lookup; production asks the R1 SFU. */
  readonly dispatches?: R1OrphanLapseOptions['dispatches'];
  readonly queue?: Queue;
  readonly owner?: string;
  readonly infer?: R1AssessmentOptions['infer'];
  /** Test seam for the recording config; production reads `R1_RECORDING_*` at call time. */
  readonly recordingConfig?: () => R1RecordingConfig;
  /** Test seam for the object store; production uses the shared S3 store. */
  readonly recordingStore?: (config: Extract<R1RecordingConfig, { enabled: true }>) => R1ObjectStore;
  readonly now?: () => Date;
  readonly scheduler?: {
    readonly random?: () => number;
    readonly setTimer?: (fn: () => void, ms: number) => { unref?: () => void };
    readonly clearTimer?: (handle: unknown) => void;
    readonly now?: () => number;
  };
}

export interface R1RuntimeHandle {
  readonly scheduler: LoopSchedulerHandle;
  readonly runner: QueueRunnerHandle;
  /** The recording lane's runner (`r1-storage`). */
  readonly storageRunner: QueueRunnerHandle;
  readonly queue: Queue;
  /** The queue names this runtime claims from. */
  readonly queues: readonly string[];
  readonly loopIntervalsMs: Readonly<Record<string, number>>;
  snapshot(): R1RuntimeSnapshot;
  /** Drive one pass of every loop (tests; production uses the scheduler). */
  tickAll(): Promise<void>;
  stop(): Promise<void>;
}

export function createR1Runtime(options: R1RuntimeOptions = {}): R1RuntimeHandle | null {
  const config = options.config ?? getR1Config();
  // THE GATE. Nothing below this line runs unless R1_ENABLED is exactly "true".
  if (!config.enabled) return null;

  const logger = createLogger('r1-runtime');
  const client = options.client ?? (supabase as unknown as SupabaseClient);
  const queue = options.queue ?? new Queue(new PgAdapter(client), { defaultMaxAttempts: 5 });
  const owner = options.owner ?? `r1-${process.pid}-${randomUUID().slice(0, 8)}`;
  const clock = options.now ?? ((): Date => new Date());

  let enabledCheckedAtMs = 0;
  let enabledCached = false;
  const r1Enabled = async (): Promise<boolean> => {
    const nowMs = clock().getTime();
    if (enabledCheckedAtMs !== 0 && nowMs - enabledCheckedAtMs < R1_RUNTIME_BOUNDS.enabledCacheMs) {
      return enabledCached;
    }
    enabledCheckedAtMs = nowMs;
    try {
      const { data, error } = await client
        .from('r1_settings')
        .select('enabled')
        .eq('singleton', true)
        .maybeSingle();
      enabledCached = !error && (data as { enabled?: unknown } | null)?.enabled === true;
    } catch {
      enabledCached = false;
    }
    return enabledCached;
  };

  const jobEvents: Record<string, number> = {};
  const storageJobEvents: Record<string, number> = {};
  const recordingConfig = options.recordingConfig ?? ((): R1RecordingConfig => getR1RecordingConfig());
  let lastStatusApplied: number | null = null;
  let statusLoopErrors = 0;
  let lastOrphansLapsed: number | null = null;
  let orphanLapseErrors = 0;

  // A deferral on the FINAL attempt writes no placeholder (the job is alive), so one that does not
  // commit would leave HR nothing when the lease expiry dead-letters the job. This records the
  // placeholder in that case only. Best effort and never throws (assessment-handler.ts).
  const finalDeferrals = createR1FinalDeferralGuard(async ({ sessionId, code }) => {
    try {
      await recordR1ScoringFailure(sessionId, code, { client: client as never, now: clock });
      logger.warn('unknown_event', { error_category: 'r1_final_defer_uncommitted', rejection_reason: code });
    } catch {
      logger.warn('unknown_event', { error_category: 'r1_placeholder_failed' });
    }
  });

  const runner = createQueueRunner({
    queue: finalDeferrals.guard(queue),
    handlers: {
      [R1_ASSESSMENT_QUEUE]: createR1AssessmentHandler({
        client: client as never,
        infer: options.infer,
        // The deferral budget is measured against the same clock as the rest of the runtime.
        now: () => clock().getTime(),
        onFinalDeferral: finalDeferrals.note,
      }),
    },
    owner,
    shouldClaim: async (queueName: string): Promise<boolean> =>
      queueName === R1_ASSESSMENT_QUEUE && (await r1Enabled()),
    leaseSeconds: R1_RUNTIME_BOUNDS.jobLeaseSeconds,
    concurrency: 1,
    pollMs: R1_RUNTIME_BOUNDS.queuePollMs,
    onEvent: (event) => {
      jobEvents[event.kind] = (jobEvents[event.kind] ?? 0) + 1;
      // Metadata only: a queue name and a sanitized kind. Never a payload or an id.
      logger.info('unknown_event', {
        error_category: `r1_queue_${event.kind}`,
        error_type: event.queueName,
      });
    },
  });

  // The recording lane. NOT gated on `r1_settings.enabled`: only on the R2 config, so a paused or
  // disabled R1 still finalizes a recording in flight, and a withdrawal or the retention sweep is
  // never stopped by a kill switch.
  const recordingStore = options.recordingStore ?? getR1RecordingStore;
  const storageEnqueue = (name: string, payload: unknown, enqueueOptions: { dedupKey: string; maxAttempts: number }): Promise<unknown> =>
    queue.enqueue(name, payload, enqueueOptions);
  const storageRunner = createQueueRunner({
    queue,
    handlers: {
      [R1_RECORDING_FINALIZE_QUEUE]: createR1RecordingFinalizeHandler({
        db: client as never,
        recordingConfig,
        store: recordingStore,
        enqueue: storageEnqueue,
        now: clock,
        // The verdict only: no id, key or size ever reaches a log line.
        onResult: (outcome) => logger.info('unknown_event', {
          error_category: outcome.kind === 'finalized' ? `r1_recording_${outcome.status}` : `r1_recording_${outcome.kind}`,
        }),
      }),
      [R1_RECORDING_ERASE_QUEUE]: createR1RecordingEraseHandler({
        db: client as never,
        recordingConfig,
        store: recordingStore,
        now: clock,
        // Counters only: no id, key or size ever reaches a log line.
        onResult: (result) => logger.info('unknown_event', {
          error_category: result.errors > 0 ? 'r1_recording_erase_errors' : result.blocked > 0 ? 'r1_recording_erase_blocked' : 'r1_recording_erase_done',
        }),
      }),
      [R1_SWEEP_QUEUE]: createR1SweepHandler({
        db: client as never,
        recordingConfig,
        store: recordingStore,
        enqueue: storageEnqueue,
        now: clock,
        log: (category) => logger.warn('unknown_event', { error_category: category }),
        onResult: () => logger.info('unknown_event', { error_category: 'r1_sweep_done' }),
      }),
    },
    owner: `${owner}-storage`,
    shouldClaim: async (queueName: string): Promise<boolean> =>
      R1_STORAGE_QUEUES.has(queueName) && recordingConfig().enabled,
    leaseSeconds: R1_RUNTIME_BOUNDS.jobLeaseSeconds,
    concurrency: 1,
    pollMs: R1_RUNTIME_BOUNDS.storagePollMs,
    onEvent: (event) => {
      storageJobEvents[event.kind] = (storageJobEvents[event.kind] ?? 0) + 1;
      // With no R2 config every 5 s tick is `not_admitted`: count it, but do not write a log line
      // forever for the shipped default (recording off).
      if (event.kind === 'not_admitted') return;
      // Metadata only: a queue name and a sanitized kind. Never a payload, an id or a key.
      logger.info('unknown_event', {
        error_category: `r1_storage_queue_${event.kind}`,
        error_type: event.queueName,
      });
    },
  });

  const sweepPendingRejects = async (): Promise<boolean> => {
    try {
      const { data, error } = await client.rpc('r1_apply_due_pending_rejects', {
        p_now: clock().toISOString(),
        p_limit: R1_RUNTIME_BOUNDS.pendingRejectBatch,
      });
      if (error) {
        statusLoopErrors += 1;
        logger.warn('unknown_event', { error_category: 'r1_status_sweep_error' });
        return false;
      }
      lastStatusApplied = typeof data === 'number' ? data : 0;
      return lastStatusApplied > 0;
    } catch {
      statusLoopErrors += 1;
      logger.warn('unknown_event', { error_category: 'r1_status_sweep_throw' });
      return false;
    }
  };

  /** Lapse R1 sessions no worker owns. Never throws; its own counters, its own log category. */
  const lapseOrphans = async (): Promise<boolean> => {
    try {
      const result = await lapseOrphanedR1Sessions(client as never, clock(), {
        dispatches: options.dispatches ?? defaultR1DispatchLister,
      });
      lastOrphansLapsed = result.lapsed;
      orphanLapseErrors += result.errors;
      return result.lapsed > 0;
    } catch {
      orphanLapseErrors += 1;
      logger.warn('unknown_event', { error_category: 'r1_orphan_lapse_throw' });
      return false;
    }
  };

  const statusTick = async (): Promise<boolean> => {
    if (!(await r1Enabled())) return false;
    // Independent halves: one failing must never skip the other.
    const rejected = await sweepPendingRejects();
    const lapsed = await lapseOrphans();
    return rejected || lapsed;
  };

  // One `r1.sweep` job per 15-minute bucket while the storage config is enabled. The scheduler never
  // waits more than 60 s between ticks, so this tick must be cheap: the bucket test is in memory and
  // the queue is touched once per bucket. A second replica may enqueue the same bucket; the dedup key
  // collapses it while the first job is live, and the sweep is idempotent anyway.
  let lastSweepBucket = -1;
  const sweepEnqueueTick = async (): Promise<boolean> => {
    if (!recordingConfig().enabled) return false;
    const bucket = Math.floor(clock().getTime() / R1_RUNTIME_BOUNDS.sweepBucketMs);
    if (bucket === lastSweepBucket) return false;
    try {
      await queue.enqueue(R1_SWEEP_QUEUE, { bucket }, { dedupKey: `${R1_SWEEP_QUEUE}:${bucket}`, maxAttempts: 3 });
      lastSweepBucket = bucket;
      return true;
    } catch {
      logger.warn('unknown_event', { error_category: 'r1_sweep_enqueue_error' });
      return false;
    }
  };

  const loopIntervalsMs = {
    'r1-assessment': R1_RUNTIME_BOUNDS.queuePollMs,
    'r1-status': R1_RUNTIME_BOUNDS.statusPollMs,
    'r1-storage': R1_RUNTIME_BOUNDS.storagePollMs,
    'r1-sweep': R1_RUNTIME_BOUNDS.sweepPollMs,
  } as const;
  const scheduler = createLoopScheduler({
    ...(options.scheduler ?? {}),
    metricPrefix: 'r1',
    loops: [
      {
        name: 'r1-assessment',
        intervalMs: loopIntervalsMs['r1-assessment'],
        tick: queueRunnerTick(runner),
      },
      { name: 'r1-status', intervalMs: loopIntervalsMs['r1-status'], tick: statusTick },
      {
        name: 'r1-storage',
        intervalMs: loopIntervalsMs['r1-storage'],
        tick: queueRunnerTick(storageRunner),
      },
      { name: 'r1-sweep', intervalMs: loopIntervalsMs['r1-sweep'], tick: sweepEnqueueTick },
    ],
  });

  return {
    scheduler,
    runner,
    storageRunner,
    queue,
    queues: R1_RUNTIME_QUEUES,
    loopIntervalsMs,
    snapshot: () => ({
      lastStatusApplied,
      statusLoopErrors,
      lastOrphansLapsed,
      orphanLapseErrors,
      jobEvents: { ...jobEvents },
      storageJobEvents: { ...storageJobEvents },
    }),
    async tickAll(): Promise<void> {
      await runner.tick();
      await sweepEnqueueTick();
      await storageRunner.tick();
      await statusTick();
    },
    async stop(): Promise<void> {
      await scheduler.stop();
      await runner.stop();
      await storageRunner.stop();
    },
  };
}
