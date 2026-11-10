/**
 * The `ashby-progress` scheduler loop (M031 S3).
 *
 *   - registered next to the other Ashby loops, with its interval reported, so
 *     /health measures it against its own cadence;
 *   - ASHBY_PROGRESS_ENABLED off (the default; fly.toml turns it on since M031 go-live):
 *     the loop ticks and does nothing: no query, no Ashby call;
 *   - on: one pass through the runtime's client and progress store, and the
 *     short drain interval only while a pass fills its batch.
 *
 * Drives the REAL loop that `createAshbyWorkers` hands the REAL scheduler. The
 * scheduler factory is wrapped only to keep a handle on the loop table; the
 * queue runners are stubbed so no tick reaches a queue.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

interface CapturedLoop {
  name: string;
  intervalMs: number;
  intervalMsFor?: () => number;
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
    createQueueRunner: () => ({ tick: async () => 0, stop: async () => undefined, inFlight: () => 0 }),
  };
});

// ORDER MATTERS (see ashby-profile-sweep.test.ts): runtime-health before runtime-workers.
import { clearAshbySchedulerRegistration } from '../integrations/ashby/runtime-health.js';
import { ASHBY_INGESTION_QUEUE, ASHBY_PROGRESS_LOOP, createAshbyWorkers } from '../integrations/ashby/runtime-workers.js';
import { loadAshbyProgressConfig, type AshbyProgressConfig } from '../integrations/ashby/config.js';
import { MAX_SCANNER_SKIPS, SCANNER_QUEUE, type ProgressStore } from '../integrations/ashby/progress-worker.js';

function store(claimed: number) {
  const rows = Array.from({ length: claimed }, (_, i) => ({
    progressId: `p${i}`, linkId: `l${i}`, applicationId: `app-${i}`, leaseUntil: `lease-${i}`, attempts: 1,
    stored: { status: null, currentStageId: null, currentStageEnteredAt: null, archivedAt: null, ashbyUpdatedAt: null, lastCheckedAt: null, historyReadAt: null },
  }));
  return {
    scannerBusy: vi.fn(async () => false),
    claimDue: vi.fn(async (args: { limit: number }) => ({ seeded: 0, backfillOpen: false, backfillStartedAt: null, claimed: rows.slice(0, args.limit) })),
    knownStages: vi.fn(async (ids: string[]) => new Map(ids.map((id) => [id, { source: 'plan' as const, stageType: 'Active' }]))),
    christyStageIds: vi.fn(async () => []),
    record: vi.fn(async () => ({ status: 'ok' as const, changed: true })),
    recordRun: vi.fn(async () => ({ backfillFinished: false })),
    overview: vi.fn(),
    startBackfill: vi.fn(),
  } satisfies ProgressStore;
}

function client() {
  return {
    applicationInfo: vi.fn(async (id: string) => ({ results: { id, status: 'Active', currentInterviewStage: { id: 'stage-09-r1', title: 'R1', type: 'Active' } } })),
    applicationListHistory: vi.fn(async () => ({ results: [], moreDataAvailable: false })),
    interviewStageInfo: vi.fn(),
  };
}

function build(progress: AshbyProgressConfig | undefined, progressStore?: ProgressStore) {
  const ashby = client();
  const workers = createAshbyWorkers({
    runtime: {
      runtimeConfig: {
        leaseSeconds: 60, signalPollMs: 5000, operationPollMs: 7000,
        reconcileIntervalMs: 900_000, reclaimIntervalMs: 60_000,
        scannerReadinessTimeoutMs: 1000, reconcileCaps: {}, reconcileAnchorDisabled: false,
        ...(progress ? { progress } : {}),
      },
      queue: { enqueue: async () => ({ id: 'job' }) },
      stores: {}, materialization: {}, client: ashby,
      ...(progressStore ? { progress: progressStore } : {}),
      shutdown: async () => undefined,
    } as never,
    owner: 'api-test',
    scheduler: {
      setTimer: (() => ({ unref() {} })) as never,
      clearTimer: (() => undefined) as never,
      random: () => 0.99,
      now: () => Date.parse('2026-11-10T00:00:00.000Z'),
    },
  });
  const loop = captured.loops.find((l) => l.name === ASHBY_PROGRESS_LOOP);
  return { workers, loop, ashby };
}

beforeEach(() => { captured.loops = []; });
afterEach(() => { clearAshbySchedulerRegistration(); });

describe('the ashby-progress loop', () => {
  it('is registered, with its interval reported like every other loop', () => {
    const { workers, loop } = build(loadAshbyProgressConfig({}));
    expect(ASHBY_PROGRESS_LOOP).toBe('ashby-progress');
    expect(loop, 'no ashby-progress loop').toBeDefined();
    expect(loop!.intervalMs).toBe(120_000);
    expect(workers.loopIntervalsMs[ASHBY_PROGRESS_LOOP]).toBe(120_000);
    expect(Object.keys(workers.loopIntervalsMs).sort()).toEqual(captured.loops.map((l) => l.name).sort());
  });

  it('the scanner check watches the resume ingestion queue', () => {
    expect(SCANNER_QUEUE).toBe(ASHBY_INGESTION_QUEUE);
  });

  it('off by default: it ticks and does nothing', async () => {
    const s = store(3);
    const { loop, ashby } = build(loadAshbyProgressConfig({}), s);
    expect(await loop!.tick()).toBe(false);
    for (const fn of Object.values(s)) expect(fn).not.toHaveBeenCalled();
    expect(ashby.applicationInfo).not.toHaveBeenCalled();
  });

  it('a runtime built without the config or the store is off', async () => {
    const s = store(3);
    expect(await build(undefined, s).loop!.tick()).toBe(false);
    expect(s.claimDue).not.toHaveBeenCalled();
    const { loop } = build({ ...loadAshbyProgressConfig({}), enabled: true });
    expect(await loop!.tick()).toBe(false);
  });

  it('on: one pass through the runtime client and store, and the drain interval only after a full batch', async () => {
    const config = { ...loadAshbyProgressConfig({ ASHBY_PROGRESS_ENABLED: 'true', ASHBY_PROGRESS_BATCH_SIZE: '2' }), minCallIntervalMs: 100 };
    const full = store(2);
    const on = build(config, full);
    expect(on.loop!.intervalMsFor!()).toBe(120_000);
    expect(await on.loop!.tick()).toBe(true);
    expect(full.claimDue).toHaveBeenCalledWith(expect.objectContaining({ limit: 2, leaseSeconds: 105 }));
    expect(on.ashby.applicationInfo).toHaveBeenCalledTimes(2);
    expect(full.recordRun).toHaveBeenCalledTimes(1);
    expect(on.loop!.intervalMsFor!()).toBe(5_000);

    const short = store(1);
    const half = build(config, short);
    await half.loop!.tick();
    expect(half.loop!.intervalMsFor!()).toBe(120_000);
  });

  it('counts the passes it skips for a CPU-starved scanner, reads one application at the cap, and starts counting again (S3-3)', async () => {
    const config = { ...loadAshbyProgressConfig({ ASHBY_PROGRESS_ENABLED: 'true' }), minCallIntervalMs: 100 };
    const s = store(3);
    s.scannerBusy.mockResolvedValue(true);
    const { loop, ashby } = build(config, s);
    for (let i = 0; i < MAX_SCANNER_SKIPS; i += 1) expect(await loop!.tick()).toBe(false);
    expect(s.claimDue).not.toHaveBeenCalled();
    // The cap: one application, and the skipped passes on its run row.
    await loop!.tick();
    expect(s.claimDue).toHaveBeenCalledTimes(1);
    expect(s.claimDue).toHaveBeenCalledWith(expect.objectContaining({ limit: 1 }));
    expect(s.recordRun).toHaveBeenCalledWith(expect.objectContaining({ errors: { scanner_paused: MAX_SCANNER_SKIPS } }));
    expect(ashby.applicationInfo).toHaveBeenCalled();
    expect(loop!.intervalMsFor!()).toBe(120_000);
    // Paused again: the count starts over.
    await loop!.tick();
    expect(s.claimDue).toHaveBeenCalledTimes(1);
    // The scanner recovers before the cap: the next pass is a full one and records the one skip.
    s.scannerBusy.mockResolvedValue(false);
    await loop!.tick();
    expect(s.claimDue).toHaveBeenLastCalledWith(expect.objectContaining({ limit: config.batchSize }));
    expect(s.recordRun).toHaveBeenLastCalledWith(expect.objectContaining({ errors: { scanner_paused: 1 } }));
  });
});
