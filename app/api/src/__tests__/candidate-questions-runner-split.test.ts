/**
 * `candidate.questions` runs on its OWN queue runner, and that is load-bearing.
 *
 * `createQueueRunner` bounds in-flight work with ONE `active` counter across
 * every handler it owns, decremented only when a job settles. PR #296's
 * per-tick cap fixed which queue is offered the budget; nothing bounds how long
 * one queue HOLDS it. So while generation shared the Ashby runner's budget of
 * 2, two jobs in flight stopped `ashby.signal`, `ashby.import` and
 * `ashby.ingestion` claiming anything for the length of a provider call — a
 * review measured −25% dilution before any call and far worse once one was
 * slow, which is why the feature shipped default-OFF.
 *
 * The split is what makes it safe to turn on, so the split needs a test that
 * fails when it is undone. This asserts the two runners are built with DISJOINT
 * handler maps and the right budgets — the property, not the plumbing.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';

interface CapturedRunner {
  handlers: Record<string, unknown>;
  owner: string;
  concurrency?: number;
  shouldClaim?: unknown;
  pollMs: number;
  tick: ReturnType<typeof vi.fn>;
  stop: ReturnType<typeof vi.fn>;
}

const captured: CapturedRunner[] = [];

/**
 * The scheduler's loop table — and this is the half that matters.
 *
 * `tickAll()` has ZERO production callers (`grep '\.tickAll()'` finds nothing
 * outside `__tests__`); the real driver is the scheduler loop built here. An
 * earlier version of this file asserted only `tickAll`, so DELETING the
 * `questions` loop left 1829 tests green — and in production would have meant
 * jobs enqueued for every admitted candidate and never claimed, growing
 * unbounded, invisible to `reclaim_expired_jobs` (which scans `status='active'`
 * only). Found by review.
 */
interface CapturedLoop {
  name: string;
  intervalMs: number;
  tick: () => Promise<unknown>;
}
let loops: CapturedLoop[] = [];

vi.mock('../integrations/ashby/scheduler.js', () => ({
  createAshbyScheduler: (options: { loops: CapturedLoop[] }) => {
    loops = options.loops;
    return { start: vi.fn(), stop: vi.fn().mockResolvedValue(undefined), snapshot: vi.fn() };
  },
  queueRunnerTick: (runner: { tick: () => Promise<unknown> }) => async () => {
    await runner.tick();
    return false;
  },
}));

vi.mock('../lib/queue/runner.js', () => ({
  createQueueRunner: (options: Record<string, unknown>) => {
    const handle: CapturedRunner = {
      handlers: options.handlers as Record<string, unknown>,
      owner: options.owner as string,
      concurrency: options.concurrency as number | undefined,
      shouldClaim: options.shouldClaim,
      pollMs: options.pollMs as number,
      tick: vi.fn().mockResolvedValue({ processed: 0 }),
      stop: vi.fn().mockResolvedValue(undefined),
    };
    captured.push(handle);
    return handle;
  },
  queueRunnerTick: (runner: { tick: () => Promise<unknown> }) => async () => {
    await runner.tick();
    return false;
  },
}));

const { createAshbyWorkers } = await import('../integrations/ashby/runtime-workers.js');
const { CANDIDATE_QUESTIONS_QUEUE } = await import('../lib/candidate-question-jobs.js');

/** Enough runtime for the workers to be constructed; no timer is ever armed. */
function runtime() {
  return {
    runtimeConfig: {
      leaseSeconds: 60,
      signalPollMs: 5000,
      operationPollMs: 7000,
      reconcileIntervalMs: 900_000,
      reclaimIntervalMs: 60_000,
      scannerReadinessTimeoutMs: 1000,
      reconcileCaps: {},
      reconcileAnchorDisabled: false,
    },
    queue: { enqueue: vi.fn(), claim: vi.fn() },
    stores: {},
    materialization: {},
    client: {},
    resolveMappingForLink: vi.fn(),
    shutdown: vi.fn().mockResolvedValue(undefined),
  } as never;
}

function build() {
  captured.length = 0;
  // `createAshbyScheduler` arms nothing until `start()`, and these seams keep
  // even its construction free of real timers.
  return createAshbyWorkers({
    runtime: runtime(),
    owner: 'api-test',
    scheduler: {
      setTimer: (() => 0) as never,
      clearTimer: (() => undefined) as never,
      random: () => 0.5,
      now: () => 0,
    },
  });
}

beforeEach(() => {
  captured.length = 0;
  loops = [];
});

describe('the generation queue has its own runner', () => {
  it('BUILDS EXACTLY TWO RUNNERS', () => {
    build();
    expect(captured).toHaveLength(2);
  });

  it('KEEPS candidate.questions OUT of the Ashby runner', () => {
    build();
    const [ashby] = captured;
    expect(Object.keys(ashby.handlers)).not.toContain(CANDIDATE_QUESTIONS_QUEUE);
    // And the three it must still own.
    for (const name of ['ashby.signal', 'ashby.import', 'ashby.ingestion']) {
      expect(Object.keys(ashby.handlers), name).toContain(name);
    }
  });

  it('GIVES THE GENERATION RUNNER NOTHING ELSE', () => {
    build();
    const [, questions] = captured;
    expect(Object.keys(questions.handlers)).toEqual([CANDIDATE_QUESTIONS_QUEUE]);
  });

  it('LEAVES THE ASHBY BUDGET AT 2, and bounds generation at 1', () => {
    // The whole point: the drain keeps both slots, and one slow generation can
    // never become two.
    build();
    const [ashby, questions] = captured;
    expect(ashby.concurrency).toBe(2);
    expect(questions.concurrency).toBe(1);
  });

  it('gives the generation runner its own lease owner', () => {
    // So an expired lease is attributable to the runner that took it.
    build();
    const [ashby, questions] = captured;
    expect(questions.owner).not.toBe(ashby.owner);
    expect(questions.owner).toContain('questions');
  });

  it('does NOT put the scanner gate on the generation runner', () => {
    // `shouldClaim` is the résumé scanner's readiness. It has nothing to say
    // about writing a question, and a scanner outage must not stop generation.
    build();
    const [ashby, questions] = captured;
    expect(ashby.shouldClaim).toBeTypeOf('function');
    expect(questions.shouldClaim).toBeUndefined();
  });

  it('DRIVES AND STOPS BOTH, or one of them leaks', () => {
    const workers = build();
    const [ashby, questions] = captured;

    return (async () => {
      await workers.tickAll();
      expect(ashby.tick).toHaveBeenCalledTimes(1);
      expect(questions.tick).toHaveBeenCalledTimes(1);

      await workers.stop();
      expect(ashby.stop).toHaveBeenCalledTimes(1);
      expect(questions.stop).toHaveBeenCalledTimes(1);
    })();
  });

  it('IS ACTUALLY DRIVEN IN PRODUCTION — a scheduler loop of its own', async () => {
    // THE ONE THAT WAS MISSING. Without this, deleting the loop, folding the
    // questions tick into the `signal` loop, or slowing it to the reconcile
    // cadence all pass. In production each of those is a feature that enqueues
    // for every candidate and never runs.
    build();
    const [, questions] = captured;
    const loop = loops.find((l) => l.name === 'questions');
    expect(loop, 'no `questions` loop was registered with the scheduler').toBeDefined();

    // It must drive THE QUESTIONS RUNNER, not some other one.
    await loop!.tick();
    expect(questions.tick).toHaveBeenCalledTimes(1);
    expect(captured[0].tick, 'the questions loop must not drive the Ashby runner')
      .not.toHaveBeenCalled();
  });

  it('polls on the SIGNAL cadence, not the reconcile one', () => {
    // At the 15-minute reconcile cadence a generation would not finish before
    // the call is planned, and the feature would look broken rather than slow.
    build();
    const loop = loops.find((l) => l.name === 'questions');
    expect(loop?.intervalMs).toBe(5000);
  });

  it('LEAVES THE ASHBY LOOPS ALONE', () => {
    // Its own loop, not a passenger on `signal` — the coupling the split exists
    // to remove.
    build();
    const [ashby] = captured;
    const signal = loops.find((l) => l.name === 'signal');
    expect(signal).toBeDefined();
    return (async () => {
      await signal!.tick();
      expect(ashby.tick).toHaveBeenCalledTimes(1);
      expect(captured[1].tick, 'the signal loop must not drive generation')
        .not.toHaveBeenCalled();
    })();
  });

  it('reports its own loop interval, so /health can tell the loop is stale', () => {
    const workers = build();
    expect(workers.loopIntervalsMs).toHaveProperty('questions');
    expect(workers.loopIntervalsMs.questions).toBe(5000);
    // The Ashby loops are untouched.
    expect(workers.loopIntervalsMs.signal).toBe(5000);
    expect(workers.loopIntervalsMs.operation).toBe(7000);
  });
});
