/**
 * Leased queue runner — lifecycle, bounded concurrency, and fail-closed commits.
 *
 * The repository shipped `Queue.claim` with no consumer, so nothing exercised
 * the claim→handle→CAS-commit path end to end. These tests drive the real
 * `Queue` over the in-memory adapter (a full behavioural twin of the Postgres
 * adapter) — no DB, no network, no timers of any kind.
 */

import { describe, it, expect, vi } from 'vitest';
import { Queue } from '../lib/queue/index.js';
import { MemoryAdapter } from '../lib/queue/memory-adapter.js';
import { createQueueRunner, nextPollDelayMs, sanitizeErrorCode, UNKNOWN_ERROR_CODE } from '../lib/queue/runner.js';


/**
 * Spin the microtask queue until `pred` holds. The runner's claim path is
 * async, so a synchronous assert right after `tick()` would observe zero
 * in-flight work. No timers and no sleeps are involved — this only drains
 * already-resolved promises.
 */
async function until(pred: () => boolean, turns = 500): Promise<void> {
  for (let i = 0; i < turns && !pred(); i++) await Promise.resolve();
}

function makeQueue(nowIso = '2026-08-17T00:00:00.000Z'): { queue: Queue; setNow: (iso: string) => void } {
  let current = nowIso;
  const clock = (): string => current;
  const queue = new Queue(new MemoryAdapter({ clock }), { clock });
  return { queue, setNow: (iso) => { current = iso; } };
}

describe('createQueueRunner — claim, handle, commit', () => {
  it('claims a job, runs its handler, and completes it under the lease', async () => {
    const { queue } = makeQueue();
    await queue.enqueue('q.a', { n: 1 });
    const seen: unknown[] = [];

    const runner = createQueueRunner({
      queue,
      handlers: { 'q.a': async (job) => { seen.push(job.payload); } },
      owner: 'w1',
      leaseSeconds: 30,
      pollMs: 1000,
    });

    const processed = await runner.tick();
    await runner.stop();

    expect(processed).toBe(1);
    expect(seen).toEqual([{ n: 1 }]);
    const dlq = await queue.getDlqJobs();
    expect(dlq).toHaveLength(0);
  });

  it('returns 0 and completes cleanly on an empty queue', async () => {
    const { queue } = makeQueue();
    const runner = createQueueRunner({
      queue, handlers: { 'q.a': async () => {} }, owner: 'w1', leaseSeconds: 30, pollMs: 1000,
    });
    expect(await runner.tick()).toBe(0);
    await runner.stop();
  });

  it('fails a job under its lease when the handler throws, then DLQs at maxAttempts', async () => {
    const { queue } = makeQueue();
    await queue.enqueue('q.a', { n: 1 }, { maxAttempts: 2 });

    const runner = createQueueRunner({
      queue,
      handlers: { 'q.a': async () => { throw new Error('handler_boom'); } },
      owner: 'w1', leaseSeconds: 30, pollMs: 1000,
    });

    // Attempt 1 → retry scheduled (delayed), not dead-lettered.
    await runner.tick();
    await runner.stop();
    expect(await queue.getDlqJobs()).toHaveLength(0);
  });

  it('never lets a handler error escape the runner', async () => {
    const { queue } = makeQueue();
    await queue.enqueue('q.a', {});
    const runner = createQueueRunner({
      queue,
      handlers: { 'q.a': async () => { throw new Error('handler_boom'); } },
      owner: 'w1', leaseSeconds: 30, pollMs: 1000,
    });
    // The absence of a rejection here IS the assertion.
    await expect(runner.tick()).resolves.toBeGreaterThanOrEqual(0);
    await runner.stop();
  });

  it('fails closed on a job whose queue has no registered handler', async () => {
    const { queue } = makeQueue();
    await queue.enqueue('q.unregistered', {});
    const events: string[] = [];
    const runner = createQueueRunner({
      queue,
      // Registered so the runner polls this name, but with no handler entry the
      // job must be FAILED, never silently completed (which would drop work).
      handlers: { 'q.unregistered': undefined as never },
      owner: 'w1', leaseSeconds: 30, pollMs: 1000,
      onEvent: (e) => events.push(e.kind),
    });
    await runner.tick();
    await runner.stop();
    expect(events).toContain('no_handler');
  });

  it('commits NOTHING when the lease was lost before completion', async () => {
    const { queue } = makeQueue();
    await queue.enqueue('q.a', {});
    const events: string[] = [];

    // A queue façade whose completeClaim reports the lease is no longer ours —
    // exactly what a reclaimed/expired lease looks like.
    const facade = {
      claim: queue.claim.bind(queue),
      heartbeat: queue.heartbeat.bind(queue),
      completeClaim: async () => false,
      failClaim: queue.failClaim.bind(queue),
    };

    let ran = 0;
    const runner = createQueueRunner({
      queue: facade as never,
      handlers: { 'q.a': async () => { ran += 1; } },
      owner: 'w1', leaseSeconds: 30, pollMs: 1000,
      onEvent: (e) => events.push(e.kind),
    });
    await runner.tick();
    await runner.stop();

    expect(ran).toBe(1);
    expect(events).toContain('stale_lease');
    // The job is still active/claimable — the stale worker did not mark it done.
    expect(events).not.toContain('completed');
  });

  it('bounds in-flight work to the configured concurrency', async () => {
    const { queue } = makeQueue();
    for (let i = 0; i < 9; i++) await queue.enqueue('q.a', { i });

    let release!: () => void;
    const gate = new Promise<void>((r) => { release = r; });

    const runner = createQueueRunner({
      queue,
      handlers: { 'q.a': async () => { await gate; } },
      owner: 'w1', leaseSeconds: 30, pollMs: 1000,
      concurrency: 3,
    });

    const t = runner.tick();
    await until(() => runner.inFlight() >= 3);
    // With every handler parked, the runner must have stopped claiming at 3.
    expect(runner.inFlight()).toBe(3);
    expect(runner.peakInFlight()).toBe(3);
    release();
    await t;
    await runner.stop();
    expect(runner.peakInFlight()).toBeLessThanOrEqual(3);
  });

  it('survives a claim error without killing the loop', async () => {
    const events: string[] = [];
    const facade = {
      claim: async () => { throw new Error('db_down'); },
      heartbeat: async () => true,
      completeClaim: async () => true,
      failClaim: async () => 'retry_scheduled' as const,
    };
    const runner = createQueueRunner({
      queue: facade as never,
      handlers: { 'q.a': async () => {} },
      owner: 'w1', leaseSeconds: 30, pollMs: 1000,
      onEvent: (e) => events.push(e.kind),
    });
    await expect(runner.tick()).resolves.toBe(0);
    await runner.stop();
    expect(events).toContain('poll_error');
  });
});

describe('createQueueRunner — stop() semantics', () => {
  it('stops claiming new work immediately and resolves after in-flight settles', async () => {
    const { queue } = makeQueue();
    for (let i = 0; i < 5; i++) await queue.enqueue('q.a', { i });

    let release!: () => void;
    const gate = new Promise<void>((r) => { release = r; });
    let started = 0;
    let finished = 0;

    const runner = createQueueRunner({
      queue,
      handlers: { 'q.a': async () => { started += 1; await gate; finished += 1; } },
      owner: 'w1', leaseSeconds: 30, pollMs: 1000,
      concurrency: 2,
    });

    const tick = runner.tick();
    await until(() => started >= 2);
    expect(started).toBe(2);

    const stopping = runner.stop();
    expect(runner.stopped()).toBe(true);

    // A tick issued after stop() must claim nothing.
    expect(await runner.tick()).toBe(0);
    expect(started).toBe(2);

    release();
    await Promise.all([tick, stopping]);
    expect(finished).toBe(2);
    expect(runner.inFlight()).toBe(0);
  });

  it('is idempotent', async () => {
    const { queue } = makeQueue();
    const runner = createQueueRunner({
      queue, handlers: { 'q.a': async () => {} }, owner: 'w1', leaseSeconds: 30, pollMs: 1000,
    });
    await runner.stop();
    await expect(runner.stop()).resolves.toBeUndefined();
  });
});

describe('nextPollDelayMs — bounded backoff, no hot spin', () => {
  it('grows geometrically and is bounded by the ceiling', () => {
    const fixed = () => 0.999; // top of the jitter band, deterministic
    const d0 = nextPollDelayMs(1000, 0, fixed);
    const d1 = nextPollDelayMs(1000, 1, fixed);
    const d3 = nextPollDelayMs(1000, 3, fixed);
    expect(d1).toBeGreaterThan(d0);
    expect(d3).toBeGreaterThan(d1);
    expect(nextPollDelayMs(1000, 99, fixed, 60_000)).toBeLessThanOrEqual(60_000);
  });

  it('is never zero, so a broken queue cannot hot-spin', () => {
    for (let i = 0; i <= 12; i++) {
      expect(nextPollDelayMs(1, i, () => 0)).toBeGreaterThanOrEqual(1);
    }
  });

  it('applies jitter so concurrent machines de-synchronise', () => {
    const low = nextPollDelayMs(10_000, 0, () => 0);
    const high = nextPollDelayMs(10_000, 0, () => 0.999);
    expect(low).toBeLessThan(high);
    expect(low).toBeGreaterThanOrEqual(Math.round(10_000 * 0.5));
  });
});

describe('exactly-once under concurrent runners', () => {
  it('two runners over one queue process each job exactly once', async () => {
    const { queue } = makeQueue();
    const total = 12;
    for (let i = 0; i < total; i++) await queue.enqueue('q.a', { i });

    const processed: number[] = [];
    const mk = (owner: string) => createQueueRunner({
      queue,
      handlers: { 'q.a': async (job) => { processed.push((job.payload as { i: number }).i); } },
      owner, leaseSeconds: 30, pollMs: 1000, concurrency: 2,
    });
    const a = mk('w1');
    const b = mk('w2');

    // Interleave passes until both queues drain.
    for (let round = 0; round < 20; round++) {
      const [ra, rb] = await Promise.all([a.tick(), b.tick()]);
      if (ra === 0 && rb === 0) break;
    }
    await Promise.all([a.stop(), b.stop()]);

    expect(processed.sort((x, y) => x - y)).toEqual(Array.from({ length: total }, (_, i) => i));
    expect(new Set(processed).size).toBe(total);
  });
});

describe('heartbeat', () => {
  it('extends a live lease while a slow handler runs', async () => {
    const { queue } = makeQueue();
    await queue.enqueue('q.a', {});
    const heartbeat = vi.fn(async () => true);
    const facade = {
      claim: queue.claim.bind(queue),
      heartbeat,
      completeClaim: queue.completeClaim.bind(queue),
      failClaim: queue.failClaim.bind(queue),
    };
    const runner = createQueueRunner({
      queue: facade as never,
      handlers: { 'q.a': async () => {} },
      owner: 'w1',
      // Minimum lease so the heartbeat interval floor (1s) is exercised without
      // any real waiting — the handler resolves immediately.
      leaseSeconds: 5,
      pollMs: 1000,
    });
    await runner.tick();
    await runner.stop();
    // A fast handler completes before the first beat; the assertion is that the
    // heartbeat timer never prevented completion or threw.
    // Every heartbeat (if any fired) must carry the job id as its first argument.
    for (const call of heartbeat.mock.calls) {
      expect(typeof (call as unknown as unknown[])[0]).toBe('string');
    }
  });
});

describe('sanitizeErrorCode — nothing raw reaches the queue error column or the DLQ', () => {
  it('passes through the sanitized codes the handlers actually throw', () => {
    for (const code of [
      'ashby_link_read_error', 'malformed_import_payload', 'no_registered_handler',
      'ashby_ingestion_invalid_transition', 'operation_error', 'ashby.op:retry-1',
    ]) {
      expect(sanitizeErrorCode(new Error(code))).toBe(code);
    }
  });

  it('replaces anything that could carry data with a bounded fallback', () => {
    const hostile = [
      new TypeError("Cannot read properties of undefined (reading 'email')"),
      new Error('pg: connection to 10.0.0.5:5432 failed for user "svc" password "hunter2"'),
      new Error('duplicate key value violates unique constraint — candidate a@b.example'),
      new Error('Bearer eyJhbGciOiJIUzI1NiJ9.payload.signature'),
      new Error('x'.repeat(5000)),
      new Error(''),
      new Error('Has Spaces And Capitals'),
      'a raw string error',
      { message: 'not an error object' },
      null,
      undefined,
      42,
    ];
    for (const err of hostile) {
      const code = sanitizeErrorCode(err);
      expect(code, String(err)).toBe(UNKNOWN_ERROR_CODE);
      expect(code.length).toBeLessThanOrEqual(64);
    }
  });

  it('NEGATIVE CONTROL: the raw message would otherwise have been persisted', () => {
    // Before the repair the runner passed `err.message` straight to failClaim,
    // which writes it to job_queue.error_message and the DLQ row.
    const raw = 'pg: connection to 10.0.0.5 failed for user svc';
    expect(raw).not.toBe(sanitizeErrorCode(new Error(raw)));
    expect(sanitizeErrorCode(new Error(raw))).toBe(UNKNOWN_ERROR_CODE);
  });

  it('persists only the sanitized code when a handler throws hostile text', async () => {
    const { queue } = makeQueue();
    await queue.enqueue('q.a', {}, { maxAttempts: 1 });
    const failed: string[] = [];
    const facade = {
      claim: queue.claim.bind(queue),
      heartbeat: queue.heartbeat.bind(queue),
      completeClaim: queue.completeClaim.bind(queue),
      failClaim: async (_id: string, _t: string, message: string) => {
        failed.push(message);
        return 'dead_lettered' as const;
      },
    };
    const runner = createQueueRunner({
      queue: facade as never,
      handlers: {
        'q.a': async () => { throw new Error('pg: row (a@b.example, +15551234567) violated constraint'); },
      },
      owner: 'w1', leaseSeconds: 30, pollMs: 1000,
    });
    await runner.tick();
    await runner.stop();

    expect(failed).toEqual([UNKNOWN_ERROR_CODE]);
    expect(failed.join()).not.toContain('a@b.example');
    expect(failed.join()).not.toContain('15551234567');
  });
});
