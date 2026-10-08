/**
 * R1 scoring under a PERSISTENT provider outage, end to end (review findings, T05 round 1).
 *
 * Every other R1 deferral test stubs `infer` (a breakerless mock), so none of them ever met the
 * thing that decides how an outage ends: R1's REAL circuit breaker. This file drives the real
 * queue runtime (a MemoryAdapter queue and the real runner), the real R1 DeepSeek runner and a
 * real `CircuitBreaker` (the production threshold and cooldown), on a simulated clock, at the
 * production cadence (the runner polls about 5 s after a job becomes due, the retry backoff is
 * the queue's own), until the job ends. It pins:
 *
 *   - the code that reaches `job_queue.error_message`, the DLQ row and the HR placeholder is the
 *     REAL provider failure (`deepseek_rate_limited`, `deepseek_server_error`,
 *     `deepseek_timeout`, ...), never `provider_circuit_open`, which is only the breaker refusing
 *     calls after the real failures opened it. (Before the fix every deferrable outage ended as
 *     `provider_circuit_open`, because by the cap the breaker was open and the five terminal
 *     attempts arrived inside its 60 s cooldown.)
 *   - the job ends in bounded time and with a bounded number of billed calls, and a timeout,
 *     the one billed failure, gets a much smaller budget than a 429;
 *   - a deferral that cannot be committed on the FINAL attempt still leaves HR a placeholder.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { Queue } from '../lib/queue/index.js';
import { MemoryAdapter } from '../lib/queue/memory-adapter.js';
import { CircuitBreaker } from '../lib/provider-resilience.js';
import {
  R1_BREAKER_COOLDOWN_MS,
  R1_BREAKER_FAILURE_THRESHOLD,
  R1_SCORER_TIMEOUT_MS,
  createR1DeepseekRunner,
  createR1Infer,
} from '../lib/r1/deepseek-runner.js';
import {
  R1_ASSESSMENT_QUEUE,
  R1_BREAKER_REFUSAL_CODE,
  R1_PROVIDER_DEFER_MAX_COUNT,
  R1_TIMEOUT_DEFER_MAX_COUNT,
} from '../lib/r1/assessment-handler.js';
import { createR1Runtime } from '../lib/r1/runtime.js';
import { R1_METRICS } from '../lib/r1/rubric.js';
import { r1ErrorCode } from '../services/r1-assessment.js';
import {
  ROUND_ID,
  SESSION_ID,
  baseTables,
  createFakeDb,
  happyRpc,
  type FakeDb,
  type Tables,
} from './support/r1-fake-db.js';
import { cleanLogRows, interviewRows, modelAnswer } from './support/r1-scorer.js';

const MAX_ATTEMPTS = 5;
const START_MS = Date.parse('2026-10-08T08:00:00Z');
/** The runner polls every 5 s (R1_RUNTIME_BOUNDS.queuePollMs): a due job is claimed about then. */
const POLL_MS = 5_000;

type Outage =
  | { readonly kind: 'status'; readonly status: number }
  | { readonly kind: 'timeout' }
  | { readonly kind: 'connection' }
  /** 429 for the first `after` calls, then a valid scoring answer for every call. */
  | { readonly kind: 'recovers'; readonly after: number };

function tablesWithInterview(): Tables {
  const tables = baseTables();
  tables.transcript_turns = interviewRows().map((row) => ({ ...row, session_id: SESSION_ID, is_gate: false }));
  tables.r1_admin_log = cleanLogRows().map((row) => ({ ...row, session_id: SESSION_ID, round_id: ROUND_ID }));
  return tables;
}

interface World {
  readonly queue: Queue;
  readonly db: FakeDb;
  readonly jobId: string;
  /** Model transport calls (each is a billed call when the provider answers or times out). */
  readonly calls: () => number;
  /** The `r1ErrorCode` of every failed model call, in order (refusals included). */
  readonly trace: string[];
  readonly now: () => number;
  advance(ms: number): void;
  readonly runtime: NonNullable<ReturnType<typeof createR1Runtime>>;
}

interface WorldOptions {
  readonly maxAttempts?: number;
  /** Make the queue itself misbehave (the runtime is handed the wrapped queue). */
  readonly wrapQueue?: (queue: Queue) => Queue;
  /** Make the database misbehave (the runtime is handed the wrapped client). */
  readonly wrapClient?: (client: FakeDb['client']) => FakeDb['client'];
}

/**
 * A runtime wired like production (real runner, real R1 breaker with the production threshold and
 * cooldown) over an in-memory queue and database, with the provider failing as `outage` says.
 */
async function makeWorld(outage: Outage, options: WorldOptions = {}): Promise<World> {
  let nowMs = START_MS;
  const iso = (): string => new Date(nowMs).toISOString();
  const queue = new Queue(new MemoryAdapter({ clock: iso }), { clock: iso });
  const db = createFakeDb(tablesWithInterview(), happyRpc());
  const queued = await queue.enqueue(
    R1_ASSESSMENT_QUEUE,
    { session_id: SESSION_ID },
    { maxAttempts: options.maxAttempts ?? MAX_ATTEMPTS },
  );

  const good = modelAnswer(interviewRows(), Object.fromEntries(R1_METRICS.map((metric) => [metric.key, 3])));
  let transportCalls = 0;
  const runner = createR1DeepseekRunner({
    breaker: new CircuitBreaker({
      failureThreshold: R1_BREAKER_FAILURE_THRESHOLD,
      cooldownMs: R1_BREAKER_COOLDOWN_MS,
      clock: { now: () => nowMs },
    }),
    clock: { now: () => nowMs },
    transport: async () => {
      transportCalls += 1;
      if (outage.kind === 'status') {
        return { ok: false, status: outage.status, text: async () => '{"error":{"message":"provider text"}}' };
      }
      if (outage.kind === 'recovers') {
        if (transportCalls <= outage.after) return { ok: false, status: 429, text: async () => '{}' };
        return {
          ok: true,
          status: 200,
          text: async () => JSON.stringify({ choices: [{ message: { content: JSON.stringify(good) } }] }),
        };
      }
      if (outage.kind === 'timeout') {
        // The call ran its whole timeout before the abort failed it.
        nowMs += R1_SCORER_TIMEOUT_MS;
        const aborted = new Error('aborted');
        aborted.name = 'AbortError';
        throw aborted;
      }
      throw new Error('ECONNRESET');
    },
  });
  const rawInfer = createR1Infer(runner);
  const trace: string[] = [];
  const infer = async (prompt: string): Promise<unknown> => {
    try {
      return await rawInfer(prompt);
    } catch (error) {
      trace.push(r1ErrorCode(error));
      throw error;
    }
  };

  const runtime = createR1Runtime({
    config: { enabled: true, status: 'enabled' },
    client: (options.wrapClient ? options.wrapClient(db.client) : db.client) as never,
    queue: options.wrapQueue ? options.wrapQueue(queue) : queue,
    infer,
    now: () => new Date(nowMs),
  });
  if (!runtime) throw new Error('runtime not built');
  return {
    queue,
    db,
    jobId: queued.id,
    calls: () => transportCalls,
    trace,
    now: () => nowMs,
    advance: (ms: number) => { nowMs += ms; },
    runtime,
  };
}

async function settle(world: World): Promise<void> {
  while (world.runtime.runner.inFlight() > 0) await new Promise((resolve) => setTimeout(resolve, 1));
}

interface Outcome {
  readonly ended: boolean;
  readonly calls: number;
  readonly elapsedMin: number;
  /** `job_queue.error_message` after each counted (retried) failure. */
  readonly failureCodes: string[];
  readonly dlqCodes: string[];
  readonly placeholderCodes: unknown[];
  readonly trace: string[];
  readonly events: Record<string, number>;
  readonly status: string | null;
}

/** Tick the runner at the production cadence until the job dead-letters or completes. */
async function driveToEnd(world: World, maxIterations = 400): Promise<Outcome> {
  let ended = false;
  const failureCodes: string[] = [];
  for (let i = 0; i < maxIterations; i += 1) {
    await world.runtime.runner.tick();
    await settle(world);
    const job = await world.queue.getById(world.jobId);
    if (!job || job.status === 'completed' || job.status === 'failed') { ended = true; break; }
    if (job.status === 'delayed' && job.errorMessage) failureCodes.push(job.errorMessage);
    // The next claim happens about one poll after the job is due.
    world.advance(Math.max(0, Date.parse(job.scheduledAt) - world.now()) + POLL_MS);
  }
  await world.runtime.runner.stop();
  const last = await world.queue.getById(world.jobId);
  return {
    ended,
    calls: world.calls(),
    elapsedMin: Math.round((world.now() - START_MS) / 60_000),
    failureCodes,
    dlqCodes: (await world.queue.getDlqJobs()).map((job) => String(job.errorMessage)),
    placeholderCodes: (world.db.tables.assessments ?? []).map((row) => row.raw?.r1?.code),
    trace: world.trace,
    events: world.runtime.snapshot().jobEvents,
    status: last?.status ?? null,
  };
}

beforeEach(() => {
  process.env.DEEPSEEK_API_KEY = 'sk-test-key-must-never-appear';
  // A 40-iteration outage logs a warn line per failed attempt; keep the test output readable.
  for (const method of ['info', 'warn', 'error', 'log'] as const) {
    vi.spyOn(console, method).mockImplementation(() => undefined);
  }
});
afterEach(() => {
  delete process.env.DEEPSEEK_API_KEY;
  vi.restoreAllMocks();
});

describe('a persistent provider outage ends with the REAL code, not the breaker refusing', () => {
  it.each([
    ['429', { kind: 'status', status: 429 } as Outage, 'deepseek_rate_limited'],
    ['503', { kind: 'status', status: 503 } as Outage, 'deepseek_server_error'],
    ['500', { kind: 'status', status: 500 } as Outage, 'deepseek_server_error'],
    ['timeout', { kind: 'timeout' } as Outage, 'deepseek_timeout'],
    ['connection reset', { kind: 'connection' } as Outage, 'deepseek_connection'],
  ])('%s: every counted failure, the DLQ row and the HR placeholder carry the real provider code', async (_name, outage, code) => {
    const world = await makeWorld(outage);
    const out = await driveToEnd(world);

    expect(out.ended, JSON.stringify(out)).toBe(true);
    // job_queue.error_message after each retried failure: the real code, never the refusal.
    expect(out.failureCodes.length).toBe(MAX_ATTEMPTS - 1);
    expect(out.failureCodes.every((failure) => failure === code)).toBe(true);
    expect(out.dlqCodes).toEqual([code]);
    // Exactly one placeholder, carrying the same real code (it is what HR and Mission Control read).
    expect(out.placeholderCodes).toEqual([code]);
    expect(world.db.tables.assessments![0]!.raw.r1).toMatchObject({ outcome: 'scoring_failed', valid: false, code });
    // The premise of the defect: the breaker really opened and refused calls on the way. This is
    // not a test of a breakerless mock.
    expect(out.trace).toContain(R1_BREAKER_REFUSAL_CODE);
    // Those refusals were DEFERRED (free), not counted as attempts.
    expect(out.events.failed).toBe(MAX_ATTEMPTS);
    // Never the secrets or the provider text.
    const everything = JSON.stringify([out, world.db.tables]);
    expect(everything).not.toContain('sk-test-key-must-never-appear');
    expect(everything).not.toContain('provider text');
  }, 60_000);

  it('a rate limit keeps the long deferral cap and still ends in bounded time and calls', async () => {
    const world = await makeWorld({ kind: 'status', status: 429 });
    const out = await driveToEnd(world);
    expect(out.ended).toBe(true);
    // The cap is used: a 429 costs nothing, so it is retried across all of it...
    expect(out.calls).toBeGreaterThanOrEqual(R1_PROVIDER_DEFER_MAX_COUNT);
    // ...and then one real probe per remaining attempt, no more.
    expect(out.calls).toBeLessThanOrEqual(R1_PROVIDER_DEFER_MAX_COUNT + 1 + MAX_ATTEMPTS);
    // About 30 deferrals of 65 s plus five probes 70 s apart; well under two hours.
    expect(out.elapsedMin).toBeLessThan(120);
  }, 60_000);

  it('a timeout, the one BILLED failure, gets a small budget instead of 31 calls of 300 s', async () => {
    const world = await makeWorld({ kind: 'timeout' });
    const out = await driveToEnd(world);
    expect(out.ended).toBe(true);
    // R1_TIMEOUT_DEFER_MAX_COUNT deferrals, then the five attempts the job is allowed. (Before
    // the bound this was 31 calls and 190 minutes of billed reasoning.)
    expect(out.calls).toBeLessThanOrEqual(R1_TIMEOUT_DEFER_MAX_COUNT + MAX_ATTEMPTS);
    expect(out.elapsedMin).toBeLessThan(75);
    expect(out.events.deferred).toBeGreaterThanOrEqual(R1_TIMEOUT_DEFER_MAX_COUNT);
  }, 60_000);

  it.each([
    ['402', 402, 'deepseek_insufficient_balance'],
    ['401', 401, 'deepseek_auth'],
  ])('%s is not an outage: five quick attempts, no deferral, then the real code', async (_name, status, code) => {
    const world = await makeWorld({ kind: 'status', status });
    const out = await driveToEnd(world);
    expect(out.ended).toBe(true);
    expect(out.dlqCodes).toEqual([code]);
    expect(out.placeholderCodes).toEqual([code]);
    expect(out.events.deferred ?? 0).toBe(0);
    expect(out.calls).toBe(MAX_ATTEMPTS);
  }, 60_000);

  it('recovers: an outage that clears before the cap scores the job, with no placeholder and no DLQ', async () => {
    const world = await makeWorld({ kind: 'recovers', after: 12 });
    const out = await driveToEnd(world);
    expect(out.ended).toBe(true);
    expect(out.status).toBe('completed');
    expect(out.dlqCodes).toEqual([]);
    // One scored row, no placeholder at any point, and not one counted failure.
    expect(world.db.tables.assessments).toHaveLength(1);
    expect(world.db.tables.assessments![0]!.raw.r1.outcome).toBe('scored');
    expect(out.events.failed ?? 0).toBe(0);
  }, 60_000);
});

describe('a deferral that cannot be committed on the FINAL attempt still leaves HR a placeholder', () => {
  /** A queue whose defer write misbehaves exactly as `behaviour` says; everything else is real. */
  const flakyDefer = (behaviour: 'throws' | 'not_owned') => (queue: Queue): Queue =>
    new Proxy(queue, {
      get(target, prop) {
        if (prop === 'deferClaim') {
          return async () => {
            if (behaviour === 'throws') throw new Error('db down');
            return 'not_owned';
          };
        }
        const value = (target as never)[prop];
        return typeof value === 'function' ? (value as () => unknown).bind(target) : value;
      },
    });

  /** A database that rejects every insert into `assessments` (the placeholder write). */
  const rejectingPlaceholderWrites = (client: FakeDb['client']): FakeDb['client'] => ({
    ...client,
    from: (table: string) => {
      const query = client.from(table);
      if (table !== 'assessments') return query;
      return new Proxy(query, {
        get(target, prop) {
          if (prop === 'insert') return () => { throw new Error('db down'); };
          return target[prop];
        },
      });
    },
  });

  async function oneClaim(world: World): Promise<void> {
    await world.runtime.runner.tick();
    await settle(world);
    await world.runtime.runner.stop();
  }

  it.each(['throws', 'not_owned'] as const)(
    'defer write %s on the last attempt: the placeholder is written, then the lease expiry dead-letters the job',
    async (behaviour) => {
      const world = await makeWorld({ kind: 'status', status: 429 }, {
        maxAttempts: 1,
        wrapQueue: flakyDefer(behaviour),
      });
      await oneClaim(world);

      // The deferral did not land, so HR must not be left with nothing when the job dies.
      expect(world.db.tables.assessments).toHaveLength(1);
      expect(world.db.tables.assessments![0]!.raw.r1).toMatchObject({
        outcome: 'scoring_failed', valid: false, code: 'deepseek_rate_limited',
      });
      expect(world.db.rpcCalls.map((call) => call.fn)).toEqual(['r1_attach_assessment', 'r1_apply_status_effect']);

      // And the job really is lost to the lease expiry (the path the reviewers described).
      world.advance(601_000);
      const reclaimed = await world.queue.reclaimExpired({ limit: 10 });
      expect(reclaimed.deadLettered).toHaveLength(1);
      expect((await world.queue.getDlqJobs()).map((job) => job.errorMessage)).toEqual([
        'lease_expired_attempts_exhausted',
      ]);
    },
  );

  it('the fallback carries the real code of a timeout too', async () => {
    const world = await makeWorld({ kind: 'timeout' }, { maxAttempts: 1, wrapQueue: flakyDefer('throws') });
    await oneClaim(world);
    expect(world.db.tables.assessments).toHaveLength(1);
    expect(world.db.tables.assessments![0]!.raw.r1.code).toBe('deepseek_timeout');
  });

  it('a defer write that fails on an EARLIER attempt writes nothing (the job is retried)', async () => {
    const world = await makeWorld({ kind: 'status', status: 429 }, { maxAttempts: 5, wrapQueue: flakyDefer('throws') });
    await oneClaim(world);
    expect(world.db.tables.assessments).toHaveLength(0);
    expect(world.db.rpcCalls).toHaveLength(0);
  });

  it('a defer that DOES land on the last attempt still writes nothing: the job is alive', async () => {
    const world = await makeWorld({ kind: 'status', status: 429 }, { maxAttempts: 1 });
    await oneClaim(world);
    expect(world.db.tables.assessments).toHaveLength(0);
    expect(await world.queue.getDlqJobs()).toHaveLength(0);
    expect(await world.queue.getById(world.jobId)).toMatchObject({ status: 'delayed', attempts: 0 });
  });

  it('is best effort: when the placeholder write fails too, nothing escapes the runner', async () => {
    const world = await makeWorld({ kind: 'status', status: 429 }, {
      maxAttempts: 1,
      wrapQueue: flakyDefer('throws'),
      wrapClient: rejectingPlaceholderWrites,
    });
    await oneClaim(world);
    expect(world.db.tables.assessments).toHaveLength(0);
    // The runner reported the failed defer and carried on; the job waits for its lease to expire
    // exactly as it did before the fallback existed.
    expect(world.runtime.snapshot().jobEvents.poll_error).toBe(1);
    expect(await world.queue.getById(world.jobId)).toMatchObject({ status: 'active' });
  });

  it('writes nothing when the session already has an assessment row (a stored row is the truth)', async () => {
    const world = await makeWorld({ kind: 'status', status: 429 }, { maxAttempts: 1, wrapQueue: flakyDefer('throws') });
    // A placeholder from an earlier claim of this job (for example a replayed one) already exists.
    world.db.tables.assessments!.push({
      id: 'earlier', session_id: SESSION_ID, schema_version: 2, revision: 1, recommendation: null,
      overall_score: null, raw: { r1: { outcome: 'scoring_failed', code: 'deepseek_auth' } },
    });
    // The attempt reads it, treats it as a placeholder to supersede, fails on the provider, and
    // (final attempt, deferral not committed) the fallback finds the stored row and adds nothing.
    await oneClaim(world);
    expect(world.db.tables.assessments).toHaveLength(1);
    expect(world.db.tables.assessments![0]!.id).toBe('earlier');
    // And it did not re-drive the round RPCs either.
    expect(world.db.rpcCalls).toHaveLength(0);
  });
});
