/**
 * lib/r1/runtime.ts: the composition root for the R1 queue runtime (plan 6.7).
 *
 * ── DEDICATED AND ISOLATED ────────────────────────────────────────────
 * R1 gets its OWN `createQueueRunner` (concurrency 1) and its OWN loop scheduler. It hosts
 * exactly one handler today, `r1.assessment`; `r1.recording.finalize` and `r1.sweep` join it
 * in PR-8. It is NEVER registered in the phone runtime (handlers `{phone.dial,
 * phone.assessment}`, `lib/phone-runtime/runtime.ts`) or the recording runtime, and the phone
 * runtime is never touched: `r1-runtime-structural.test.ts` pins both facts.
 *
 * ── WITH THE SHIPPED DEFAULTS THIS CONSTRUCTS NOTHING ─────────────────
 * `R1_ENABLED` is unset/false, so `createR1Runtime` returns null: no runner, no scheduler, no
 * timer, no database poll, no provider call. When it is on, a DB gate still applies: the
 * runner claims only while `r1_settings.enabled` is true (cached 5 s, FAIL CLOSED: a settings
 * row that cannot be read means "do not claim"). A paused R1 still scores sessions that
 * already finished ("live sessions finish"); a disabled one scores and applies nothing.
 *
 * ── TWO LOOPS ─────────────────────────────────────────────────────────
 *   r1-assessment  drains `r1.assessment` through the handler.
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
import { R1_ASSESSMENT_QUEUE, createR1AssessmentHandler } from './assessment-handler.js';
import { lapseOrphanedR1Sessions, type R1OrphanLapseOptions } from './orphan-lapse.js';
import { agentDispatchClientFor, browserLiveKitEndpoint } from '../livekit-endpoints.js';
import type { DispatchListerLike } from './worker-gate.js';
import type { R1AssessmentOptions } from '../../services/r1-assessment.js';

/** The ONLY queues this runtime registers. A structural test pins it. */
export const R1_RUNTIME_QUEUES: readonly string[] = [R1_ASSESSMENT_QUEUE];

export const R1_RUNTIME_BOUNDS = {
  /**
   * A scoring job is bounded by 2 x 4 sequential model calls of 300 s (run 0, then the others;
   * see deepseek-runner.ts); the runner heartbeats the lease every third of it.
   */
  jobLeaseSeconds: 600,
  queuePollMs: 5_000,
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
  let lastStatusApplied: number | null = null;
  let statusLoopErrors = 0;
  let lastOrphansLapsed: number | null = null;
  let orphanLapseErrors = 0;

  const runner = createQueueRunner({
    queue,
    handlers: {
      [R1_ASSESSMENT_QUEUE]: createR1AssessmentHandler({
        client: client as never,
        infer: options.infer,
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

  const loopIntervalsMs = {
    'r1-assessment': R1_RUNTIME_BOUNDS.queuePollMs,
    'r1-status': R1_RUNTIME_BOUNDS.statusPollMs,
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
    ],
  });

  return {
    scheduler,
    runner,
    queue,
    queues: R1_RUNTIME_QUEUES,
    loopIntervalsMs,
    snapshot: () => ({
      lastStatusApplied,
      statusLoopErrors,
      lastOrphansLapsed,
      orphanLapseErrors,
      jobEvents: { ...jobEvents },
    }),
    async tickAll(): Promise<void> {
      await runner.tick();
      await statusTick();
    },
    async stop(): Promise<void> {
      await scheduler.stop();
      await runner.stop();
    },
  };
}
