/**
 * The `r1-meet` lane of the R1 runtime (M034 S06, dark; D-S06-2, D-S06-3, D-S06-31, D-S06-32). Three
 * pieces, hosted by `lib/r1/runtime.ts` and nothing else:
 *
 *   createR1MeetLane       the `r1-meet` queue runner. Built ONLY when `r1MeetActive` (R1 on AND Meet
 *                          on) at construction; otherwise null: no runner, no claim, and the R1
 *                          runtime's queues stay exactly the four it had. Its OWN runner (owner
 *                          `<owner>-meet`, concurrency 2, lease 60 s), so a ten-minute scoring job or a
 *                          finalize never delays a human waiting in the Meet; `shouldClaim` re-checks
 *                          Meet on every poll. One handler, the dispatcher (`dispatcher.ts`).
 *   withR1MeetStorageTick  no new loop (critic C8): the lane is ticked by the existing `r1-storage`
 *                          loop. A webhook of a live call must not wait for the loop's idle backoff
 *                          (up to 60 s, critic B10), so while the lane is HOT (a live call's event or
 *                          check in the last 5 minutes, a joining bot until 15 minutes after its
 *                          start) the loop stays at its 5 s base cadence, and the storage runner (three
 *                          claim RPCs a tick) is ticked at most every 30 s unless it just had work: a
 *                          hot window costs one claim RPC per tick, not four. With no lane the tick is
 *                          exactly the storage runner's.
 *   createR1MeetSweepTick  hooked into the existing `r1-sweep` loop (15-minute buckets). Meet active:
 *                          one `maintenance` job per bucket for the whole fleet (`maintenance.ts`),
 *                          queued during the bucket before and scheduled for its first instant, so
 *                          the dedup key holds it across machines until it runs. `R1_MEET_ENABLED`
 *                          deliberately off (status exactly `disabled`) with a usable Recall key: one
 *                          bounded drain pass (`drain.ts`: 10 bookings, 40 s, untouched for 5 minutes),
 *                          once per bucket unless rows remain. Anything else (never configured, a
 *                          malformed flag): nothing at all, not even a read. It never throws.
 *
 * WHAT "DARK" MEANS HERE (D-S06-32): never enabled and no key = zero queries and zero calls, ever. A key
 * with the flag off = at most two narrow booking reads per bucket, and no outbound call unless a booking
 * still holds a bot (then only GET, DELETE and leave_call). Nothing is created, armed or queued while off.
 *
 * MULTI-MACHINE (D-S06-35): correctness comes from the leases, the RPCs' compare-and-sets and the dedup
 * keys; the hot window and the bucket memory are per process and only shape cadence.
 *
 * Loading this module performs no I/O: the database client, the queue, the clock and the Recall seam
 * are arguments, and the Recall client is built on first use.
 */

import { createRecallClient } from '../../../integrations/recall/client.js';
import type { Queue } from '../../queue/index.js';
import { createQueueRunner, type QueueRunnerEvent, type QueueRunnerHandle } from '../../queue/runner.js';
import type { supabase } from '../../supabase.js';
import { r1MeetActive, r1MeetDrainAllowed, type R1MeetConfig, type R1MeetDrainConfig } from './config.js';
import { createR1MeetDispatcher } from './dispatcher.js';
import { R1_MEET_DRAIN, drainR1Meet, type R1MeetDrainPorts } from './drain.js';
import { R1_MEET_QUEUE, r1MeetJobs, type R1MeetJobSpec } from './jobs.js';
import {
  R1_MEET_ALERTS,
  createR1MeetLog,
  r1MeetRecallClientLogger,
  type R1MeetFlowDeps,
  type R1MeetJobDefinition,
  type R1MeetLog,
  type R1MeetRecall,
} from './recall-actions.js';
import { createR1MeetStore } from './runtime-store.js';

export type { R1MeetRecall } from './recall-actions.js';

type Db = typeof supabase;

const SECOND_MS = 1000;
const MINUTE_MS = 60 * SECOND_MS;

/** The lane's bounds. Frozen. */
export const R1_MEET_LANE = Object.freeze({
  concurrency: 2,
  leaseSeconds: 60,
  pollMs: 5 * SECOND_MS,
  /** While hot, the storage runner is ticked at most this often (unless it just had work). */
  storageThrottleMs: 30 * SECOND_MS,
  /** A hint never keeps the lane hot longer than this from now (a bounded window). */
  hotMaxMs: 60 * MINUTE_MS,
  /** The `r1-sweep` bucket (the R1 runtime's own cadence of `r1.sweep`). */
  sweepBucketMs: 15 * MINUTE_MS,
});

/** The queue operations the lane uses. `Queue` satisfies it. */
export type R1MeetLaneQueue = Pick<Queue, 'claim' | 'completeClaim' | 'failClaim' | 'heartbeat' | 'deferClaim' | 'enqueue'>;

export interface R1MeetLaneDeps {
  /** R1's own switch (`getR1Config`), asked at construction and on every poll. */
  readonly r1Config: () => { readonly enabled: boolean };
  /** The Meet configuration (`getR1MeetConfig`), asked at construction and on every poll. */
  readonly meetConfig: () => R1MeetConfig;
  readonly client: Db;
  readonly queue: R1MeetLaneQueue;
  /** The host runtime's owner id; the lane claims as `<owner>-meet`. */
  readonly owner: string;
  /** Epoch ms. */
  readonly now: () => number;
  /** Test seam: production builds the Recall client from the enabled config on first use. */
  readonly recall?: R1MeetRecall;
  /** Test seam: production logs through `lib/logger.ts`. */
  readonly log?: R1MeetLog;
  /** Test seam (and S09's): production registers `R1_MEET_DEFINITIONS`. */
  readonly definitions?: readonly R1MeetJobDefinition[];
}

export interface R1MeetLaneTick {
  /** The runner claimed at least one job. */
  readonly worked: boolean;
  /** A live call keeps the host loop at its base cadence. */
  readonly hot: boolean;
}

export interface R1MeetLane {
  readonly runner: QueueRunnerHandle;
  /** The queue names the lane claims: exactly `r1-meet`. */
  readonly queues: readonly string[];
  /** R1 and Meet still on (re-read now). */
  active(): boolean;
  /** Epoch ms until which the lane is hot (0 = never was). */
  hotUntilMs(): number;
  /** The runner's events by kind (claimed, completed, deferred, failed, ...). */
  events(): Readonly<Record<string, number>>;
  /** Queue one `r1-meet` job (an `r1MeetJobs.*` spec). */
  enqueue(spec: R1MeetJobSpec, options?: { readonly scheduledAt?: string }): Promise<void>;
  tick(): Promise<R1MeetLaneTick>;
  /** Stop claiming and resolve once the jobs in flight settle. */
  stop(): Promise<void>;
}

function laneActive(deps: Pick<R1MeetLaneDeps, 'r1Config' | 'meetConfig'>): boolean {
  try {
    return r1MeetActive(deps.r1Config(), deps.meetConfig());
  } catch {
    // A switch that cannot be read grants nothing.
    return false;
  }
}

/** The `r1-meet` lane, or null unless R1 and Meet are both on (see the header). */
export function createR1MeetLane(deps: R1MeetLaneDeps): R1MeetLane | null {
  const meet = deps.meetConfig();
  // THE GATE. Nothing below this line runs unless R1 AND Meet are on.
  if (!meet.enabled || !laneActive(deps)) return null;

  const log = deps.log ?? createR1MeetLog();
  const store = createR1MeetStore(deps.client);
  const events: Record<string, number> = {};
  let hotUntil = 0;
  const active = (): boolean => laneActive(deps);

  const enqueue = async (spec: R1MeetJobSpec, options: { readonly scheduledAt?: string } = {}): Promise<void> => {
    await deps.queue.enqueue(R1_MEET_QUEUE, spec.payload, {
      dedupKey: spec.dedupKey,
      maxAttempts: spec.maxAttempts,
      ...(options.scheduledAt === undefined ? {} : { scheduledAt: options.scheduledAt }),
    });
  };

  // Built on the first job, once: the Recall client holds the key as a private field and is reused.
  let flow: R1MeetFlowDeps | null = null;
  const flowDeps = (): R1MeetFlowDeps =>
    (flow ??= Object.freeze({
      store,
      recall:
        deps.recall
        ?? createRecallClient({
          apiKey: meet.recall.apiKey,
          baseUrl: meet.recall.baseUrl,
          logger: r1MeetRecallClientLogger(log),
        }),
      config: meet,
      enqueue,
      now: deps.now,
      log,
      hotUntil: (untilMs: number) => {
        // Bounded: a hint can never hold the loop fast for longer than `hotMaxMs` from now.
        const capped = Math.min(untilMs, deps.now() + R1_MEET_LANE.hotMaxMs);
        if (Number.isFinite(capped) && capped > hotUntil) hotUntil = capped;
      },
    }));

  const dispatcher = createR1MeetDispatcher({
    ...(deps.definitions === undefined ? {} : { definitions: deps.definitions }),
    flowDeps,
    active,
  });

  const runner = createQueueRunner({
    queue: deps.queue,
    handlers: { [R1_MEET_QUEUE]: (job) => dispatcher.handle(job) },
    owner: `${deps.owner}-meet`,
    shouldClaim: (queueName: string): boolean => queueName === R1_MEET_QUEUE && active(),
    leaseSeconds: R1_MEET_LANE.leaseSeconds,
    concurrency: R1_MEET_LANE.concurrency,
    pollMs: R1_MEET_LANE.pollMs,
    onEvent: (event: QueueRunnerEvent) => {
      events[event.kind] = (events[event.kind] ?? 0) + 1;
      // The dispatcher writes the one line per job; the runner adds only what it alone sees.
      if (event.kind === 'poll_error' || event.kind === 'stale_lease' || event.kind === 'no_handler') {
        log.warn({ error_category: `r1_meet_queue_${event.kind}` });
      }
    },
  });

  return Object.freeze({
    runner,
    queues: Object.freeze([R1_MEET_QUEUE]),
    active,
    hotUntilMs: () => hotUntil,
    events: () => ({ ...events }),
    enqueue,
    async tick(): Promise<R1MeetLaneTick> {
      let claimed = 0;
      try {
        claimed = await runner.tick();
      } catch {
        // The runner never throws; this guard keeps the host loop's other half running if it did.
      }
      return { worked: claimed > 0, hot: deps.now() < hotUntil };
    },
    stop: () => runner.stop(),
  });
}

/**
 * The `r1-storage` loop's tick with the lane in it (D-S06-3, see the header). No lane: `storageTick`
 * itself, unchanged.
 */
export function withR1MeetStorageTick(
  lane: R1MeetLane | null,
  storageTick: () => Promise<boolean>,
  nowMs: () => number,
): () => Promise<boolean> {
  if (lane === null) return storageTick;
  let lastStorageMs = Number.NEGATIVE_INFINITY;
  let storageHadWork = false;
  return async () => {
    const meet = await lane.tick();
    const now = nowMs();
    let storage = false;
    if (!meet.hot || storageHadWork || now - lastStorageMs >= R1_MEET_LANE.storageThrottleMs) {
      lastStorageMs = now;
      storage = await storageTick();
      storageHadWork = storage;
    }
    // Hot counts as work: the scheduler keeps the base cadence instead of backing off.
    return meet.worked || storage || meet.hot;
  };
}

export interface R1MeetSweepTickDeps {
  /** The lane of the full R1 runtime, or null (Meet off, or the standalone storage runtime). */
  readonly lane: R1MeetLane | null;
  readonly meetConfig: () => R1MeetConfig;
  /** `getR1MeetDrainConfig`: the Recall key and base URL alone, whatever the flag says. */
  readonly drainConfig: () => R1MeetDrainConfig;
  readonly client: Db;
  /** Epoch ms. */
  readonly now: () => number;
  /** Test seam: production builds the drain's Recall client from `drainConfig` on first use. */
  readonly recall?: R1MeetRecall;
  readonly log?: R1MeetLog;
}

/** The `r1-sweep` loop's Meet half (see the header): maintenance while active, the drain while off. */
export function createR1MeetSweepTick(deps: R1MeetSweepTickDeps): () => Promise<boolean> {
  let maintenanceBucket = -1;
  let drainBucket = -1;
  let drainMore = false;
  let ports: R1MeetDrainPorts | null = null;
  let log: R1MeetLog | null = deps.log ?? null;
  const logger = (): R1MeetLog => (log ??= createR1MeetLog());

  const maintain = async (lane: R1MeetLane, bucket: number): Promise<boolean> => {
    // The NEXT bucket's job, scheduled for that bucket's first instant (PR #444 review S06-R5). The
    // dedup key only stops a second LIVE job, and a job run at once completes in a second: every
    // machine's tick would then queue the bucket again. Queued a whole bucket ahead, it stays live
    // (delayed) until it runs, so every machine's tick in this bucket collapses into it: one run per
    // bucket for the fleet. The memory below only saves the redundant inserts of this process.
    const next = bucket + 1;
    if (next === maintenanceBucket) return false;
    try {
      await lane.enqueue(r1MeetJobs.maintenance(next), {
        scheduledAt: new Date(next * R1_MEET_LANE.sweepBucketMs).toISOString(),
      });
      maintenanceBucket = next;
      return true;
    } catch {
      logger().warn({ error_category: 'r1_meet_maintenance_enqueue_error' });
      return false;
    }
  };

  const drain = async (bucket: number): Promise<boolean> => {
    // (c): a malformed flag (`invalid`) never drains; only a deliberate off does.
    if (!r1MeetDrainAllowed(deps.meetConfig())) return false;
    if (bucket === drainBucket && !drainMore) return false;
    const config = deps.drainConfig();
    // Never configured (no key): zero queries, zero calls.
    if (!config.available) return false;
    drainBucket = bucket;
    drainMore = false;
    ports ??= {
      store: createR1MeetStore(deps.client),
      recall:
        deps.recall
        ?? createRecallClient({
          apiKey: config.recall.apiKey,
          baseUrl: config.recall.baseUrl,
          logger: r1MeetRecallClientLogger(logger()),
        }),
      now: deps.now,
      log: logger(),
    };
    try {
      const report = await drainR1Meet(ports, {
        limit: R1_MEET_DRAIN.backstopLimit,
        untouchedForMs: R1_MEET_DRAIN.backstopUntouchedMs,
        force: false,
        budgetMs: R1_MEET_DRAIN.backstopBudgetMs,
      });
      // Rows beyond this pass: the next tick (a minute) takes them. Live interviews and failures
      // wait for the next bucket.
      drainMore = report.more;
      const settled = report.drained + report.completed + report.released;
      if (settled > 0) logger().info({ error_category: 'r1_meet_drain_pass', error_type: `settled_${settled}` });
      return settled > 0;
    } catch {
      logger().error({ error_category: R1_MEET_ALERTS.drainFailed, error_type: 'pass' });
      return false;
    }
  };

  return async () => {
    try {
      const bucket = Math.floor(deps.now() / R1_MEET_LANE.sweepBucketMs);
      if (deps.lane !== null && deps.lane.active()) return await maintain(deps.lane, bucket);
      return await drain(bucket);
    } catch {
      // Never throws: this tick shares a loop with the recording sweep.
      return false;
    }
  };
}
