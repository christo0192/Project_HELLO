/**
 * The `profile_sweep` scheduler loop (M017, ADR-0018, design §1.6).
 *
 * The sweep is the backstop for every best-effort profile enqueue and the
 * backfill for links that predate them. `claim_ashby_profile_due` owns
 * due-ness, the attempt count and the backoff; the loop only claims and
 * enqueues. So what is pinned here is the loop's half of that contract:
 *
 *   - OFF claims nothing, so no link spends an attempt while the switch is off;
 *   - ON claims at most 25 and enqueues each id under `ashby-profile:<id>`,
 *     the key the import and the D3 trigger share, with the id as the WHOLE
 *     payload;
 *   - one failed enqueue does not strand the rest of the claimed batch;
 *   - the loop reports its own interval, so `/health` does not call a 600 s
 *     loop stale 30 s after boot, and its queue is on the liveness surface.
 *
 * Drives the REAL loop that `createAshbyWorkers` hands the REAL scheduler. The
 * scheduler factory is wrapped only to keep a handle on that loop table; the
 * runners are stubbed so no tick can reach a queue by accident.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

interface CapturedLoop {
  name: string;
  intervalMs: number;
  tick: () => Promise<boolean>;
}

const captured = vi.hoisted(() => ({ loops: [] as CapturedLoop[] }));

vi.mock('../integrations/ashby/scheduler.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../integrations/ashby/scheduler.js')>();
  return {
    ...actual,
    createAshbyScheduler: (options: Parameters<typeof actual.createAshbyScheduler>[0]) => {
      captured.loops = options.loops as CapturedLoop[];
      return actual.createAshbyScheduler(options);
    },
  };
});

vi.mock('../lib/queue/runner.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../lib/queue/runner.js')>();
  return {
    ...actual,
    createQueueRunner: () => ({
      tick: async () => 0,
      stop: async () => undefined,
      inFlight: () => 0,
    }),
  };
});

// ORDER MATTERS: `runtime-health` and `runtime-workers` import each other, and
// `ASHBY_QUEUE_NAMES` reads the queue constants at module evaluation. The app
// entry reaches `runtime-health` first (through the mission-control route);
// entering at `runtime-workers` instead is a TDZ ReferenceError under native
// ESM and, under vitest's transform, a silent `undefined` in the list.
import {
  ASHBY_QUEUE_NAMES,
  registerAshbyScheduler,
  clearAshbySchedulerRegistration,
  snapshotScheduler,
} from '../integrations/ashby/runtime-health.js';
import {
  createAshbyWorkers,
  ASHBY_PROFILE_QUEUE,
  profileDedupKey,
} from '../integrations/ashby/runtime-workers.js';

const T0 = Date.parse('2026-10-20T00:00:00.000Z');

interface Enqueued {
  name: string;
  payload: unknown;
  options?: { dedupKey?: string; maxAttempts?: number; scheduledAt?: string | Date };
}

interface World {
  claims: Array<{ limit: number }>;
  enqueued: Enqueued[];
}

interface Build {
  /** The switch. `undefined` means unset, which must read as OFF. */
  enabled?: boolean;
  /** What the claim returns, or an error it throws. */
  due?: string[] | Error;
  /** Ids whose enqueue throws. */
  failEnqueueFor?: string[];
  /** Omit the store seam entirely, as an older injected store would. */
  noClaimSeam?: boolean;
  /** Timer seam; the default never runs a timer. */
  setTimer?: (fn: () => void, ms: number) => { unref?: () => void };
}

function build(opts: Build = {}) {
  const world: World = { claims: [], enqueued: [] };
  const stores: Record<string, unknown> = {};
  if (!opts.noClaimSeam) {
    stores.claimAshbyProfileDue = async (input: { limit: number }) => {
      world.claims.push(input);
      if (opts.due instanceof Error) throw opts.due;
      return opts.due ?? [];
    };
  }
  const workers = createAshbyWorkers({
    runtime: {
      runtimeConfig: {
        leaseSeconds: 60, signalPollMs: 5000, operationPollMs: 7000,
        reconcileIntervalMs: 900_000, reclaimIntervalMs: 60_000,
        scannerReadinessTimeoutMs: 1000, reconcileCaps: {}, reconcileAnchorDisabled: false,
        ...(opts.enabled === undefined ? {} : { phoneParsingEnabled: opts.enabled }),
      },
      queue: {
        enqueue: async (name: string, payload: unknown, options?: Enqueued['options']) => {
          const id = (payload as { applicationLinkId?: string }).applicationLinkId ?? '';
          if (opts.failEnqueueFor?.includes(id)) throw new Error('queue_unavailable');
          world.enqueued.push({ name, payload, options });
          return { id: `job_${world.enqueued.length}` };
        },
      },
      stores, materialization: {}, client: {},
      shutdown: async () => undefined,
    } as never,
    owner: 'api-test',
    scheduler: {
      setTimer: (opts.setTimer ?? (() => ({ unref() {} }))) as never,
      clearTimer: (() => undefined) as never,
      random: () => 0.99,
      now: () => T0,
    },
  });
  const sweep = captured.loops.find((l) => l.name === 'profile_sweep');
  return { workers, world, sweep };
}

beforeEach(() => {
  captured.loops = [];
});
afterEach(() => {
  clearAshbySchedulerRegistration();
});

// ═══════════════════════════════════════════════════════════════════════
// Registration
// ═══════════════════════════════════════════════════════════════════════

describe('the profile_sweep loop is registered with the scheduler', () => {
  it('as its own loop, on the 600 s cadence', () => {
    const { sweep } = build({ enabled: true });
    expect(sweep, 'no `profile_sweep` loop was registered').toBeDefined();
    expect(sweep!.intervalMs).toBe(600_000);
  });

  it('even while the switch is off (it ticks, and does nothing)', () => {
    expect(build({ enabled: false }).sweep).toBeDefined();
    expect(build().sweep).toBeDefined();
  });

  it('reports its interval, and every loop the scheduler runs has one', () => {
    // A loop with no entry here is measured against the 30 s floor, which is
    // the false `scheduler_loop_stale` the next block pins.
    const { workers } = build({ enabled: true });
    expect(workers.loopIntervalsMs.profile_sweep).toBe(600_000);
    expect(Object.keys(workers.loopIntervalsMs).sort())
      .toEqual(captured.loops.map((l) => l.name).sort());
    for (const loop of captured.loops) {
      expect(workers.loopIntervalsMs[loop.name], loop.name).toBe(loop.intervalMs);
    }
  });
});

// ═══════════════════════════════════════════════════════════════════════
// The kill switch
// ═══════════════════════════════════════════════════════════════════════

describe('switch off: no claim, so no attempt is spent', () => {
  it('OFF makes no claim and enqueues nothing', async () => {
    const { sweep, world } = build({ enabled: false, due: ['link_a'] });
    await expect(sweep!.tick()).resolves.toBe(false);
    expect(world.claims).toEqual([]);
    expect(world.enqueued).toEqual([]);
  });

  it('UNSET is OFF', async () => {
    const { sweep, world } = build({ due: ['link_a'] });
    await expect(sweep!.tick()).resolves.toBe(false);
    expect(world.claims).toEqual([]);
    expect(world.enqueued).toEqual([]);
  });

  it('a store without the claim seam is a no-op, not a crash', async () => {
    const { sweep, world } = build({ enabled: true, noClaimSeam: true });
    await expect(sweep!.tick()).resolves.toBe(false);
    expect(world.enqueued).toEqual([]);
  });
});

// ═══════════════════════════════════════════════════════════════════════
// Claim and enqueue
// ═══════════════════════════════════════════════════════════════════════

describe('switch on: claim at most 25, enqueue each under the shared dedup key', () => {
  it('claims with limit 25, exactly once per tick', async () => {
    const { sweep, world } = build({ enabled: true, due: [] });
    await sweep!.tick();
    expect(world.claims).toEqual([{ limit: 25 }]);
  });

  it('enqueues every claimed id on ashby.profile with dedup ashby-profile:<id>', async () => {
    const { sweep, world } = build({ enabled: true, due: ['link_a', 'link_b', 'link_c'] });
    await expect(sweep!.tick()).resolves.toBe(true);

    expect(world.enqueued.map((e) => e.name)).toEqual([
      ASHBY_PROFILE_QUEUE, ASHBY_PROFILE_QUEUE, ASHBY_PROFILE_QUEUE,
    ]);
    expect(world.enqueued.map((e) => e.options?.dedupKey)).toEqual([
      'ashby-profile:link_a', 'ashby-profile:link_b', 'ashby-profile:link_c',
    ]);
    // The SAME key the import and the D3 trigger use, so a claim collapses
    // onto a job either of them already queued.
    for (const e of world.enqueued) {
      const id = (e.payload as { applicationLinkId: string }).applicationLinkId;
      expect(e.options?.dedupKey).toBe(profileDedupKey(id));
    }
  });

  it('puts the link id and NOTHING else in the payload', async () => {
    const { sweep, world } = build({ enabled: true, due: ['link_a'] });
    await sweep!.tick();
    expect(world.enqueued[0]!.payload).toEqual({ applicationLinkId: 'link_a' });
    expect(Object.keys(world.enqueued[0]!.payload as object)).toEqual(['applicationLinkId']);
  });

  it('enqueues for NOW, with the profile job attempt bound', async () => {
    // The claim already applied the age gates; delaying again would only add
    // another 15 minutes to a link that is overdue.
    const { sweep, world } = build({ enabled: true, due: ['link_a'] });
    await sweep!.tick();
    expect(world.enqueued[0]!.options?.scheduledAt).toBeUndefined();
    expect(world.enqueued[0]!.options?.maxAttempts).toBe(3);
  });

  it('an empty claim is an idle tick', async () => {
    const { sweep, world } = build({ enabled: true, due: [] });
    await expect(sweep!.tick()).resolves.toBe(false);
    expect(world.enqueued).toEqual([]);
  });
});

// ═══════════════════════════════════════════════════════════════════════
// Failures
// ═══════════════════════════════════════════════════════════════════════

describe('failures surface as a failed tick with a fixed code', () => {
  it('a claim error propagates unchanged, and nothing is enqueued', async () => {
    const { sweep, world } = build({ enabled: true, due: new Error('ashby_profile_due_claim_error') });
    await expect(sweep!.tick()).rejects.toThrow('ashby_profile_due_claim_error');
    expect(world.enqueued).toEqual([]);
  });

  it('one failed enqueue does not strand the links claimed beside it', async () => {
    // The claim has already counted an attempt for every id it returned, so
    // giving up on the first failure would cost the rest a whole backoff.
    const { sweep, world } = build({
      enabled: true, due: ['link_a', 'link_b', 'link_c'], failEnqueueFor: ['link_a'],
    });
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    try {
      const err = await sweep!.tick().then(() => null, (e: unknown) => e);
      expect(err).toBeInstanceOf(Error);
      expect((err as Error).message).toBe('ashby_profile_sweep_enqueue_error');
      expect((err as Error).message).not.toContain('link_a');
    } finally {
      warn.mockRestore();
    }
    expect(world.enqueued.map((e) => e.options?.dedupKey)).toEqual([
      'ashby-profile:link_b', 'ashby-profile:link_c',
    ]);
  });

  it('the scheduler counts a failed sweep as a loop error on /health', async () => {
    const pending: Array<() => void> = [];
    const { workers } = build({
      enabled: true,
      due: new Error('ashby_profile_due_claim_error'),
      setTimer: (fn) => { pending.push(fn); return { unref() {} }; },
    });
    registerAshbyScheduler(workers.scheduler, workers.loopIntervalsMs);
    workers.scheduler.start();
    try {
      // `start()` arms the loops in table order; run only the sweep's timer.
      const index = captured.loops.findIndex((l) => l.name === 'profile_sweep');
      pending[index]!();
      await new Promise((r) => setTimeout(r, 0));
      const loop = snapshotScheduler(T0).loops.find((l) => l.name === 'profile_sweep')!;
      expect(loop.ticks).toBe(1);
      expect(loop.errors).toBe(1);
      expect(loop.consecutiveErrors).toBe(1);
    } finally {
      await workers.scheduler.stop();
    }
  });
});

// ═══════════════════════════════════════════════════════════════════════
// Health wiring
// ═══════════════════════════════════════════════════════════════════════

describe('health wiring', () => {
  it('profile_sweep is NOT stale at t+60 s after boot', async () => {
    // `start()` staggers the first tick by up to one whole interval — up to
    // 10 minutes here. Measured against the 30 s floor instead of its own
    // 600 s cadence, the loop would read stale a minute after every deploy.
    const { workers } = build({ enabled: true });
    registerAshbyScheduler(workers.scheduler, workers.loopIntervalsMs);
    workers.scheduler.start();
    try {
      const snap = snapshotScheduler(T0 + 60_000);
      const loop = snap.loops.find((l) => l.name === 'profile_sweep');
      expect(loop, 'profile_sweep missing from the health snapshot').toBeDefined();
      expect(loop!.running).toBe(true);
      expect(loop!.lastTickAt).toBeNull();
      expect(loop!.stale).toBe(false);
    } finally {
      await workers.scheduler.stop();
    }
  });

  it('control: without its interval entry the same loop WOULD be stale at t+60 s', async () => {
    // Proves the check above can fail: this is the defect it pins.
    const { workers } = build({ enabled: true });
    const withoutSweep = { ...workers.loopIntervalsMs };
    delete withoutSweep.profile_sweep;
    registerAshbyScheduler(workers.scheduler, withoutSweep);
    workers.scheduler.start();
    try {
      const loop = snapshotScheduler(T0 + 60_000).loops.find((l) => l.name === 'profile_sweep');
      expect(loop!.stale).toBe(true);
    } finally {
      await workers.scheduler.stop();
    }
  });

  it('ASHBY_QUEUE_NAMES includes ashby.profile', () => {
    expect(ASHBY_QUEUE_NAMES).toContain('ashby.profile');
    expect(ASHBY_QUEUE_NAMES).toContain(ASHBY_PROFILE_QUEUE);
  });
});
