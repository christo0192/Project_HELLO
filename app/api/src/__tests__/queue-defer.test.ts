/**
 * Lease-safe queue DEFERRAL (0037) and the ingestion admission gate.
 *
 * The defect these cover: the queue had exactly two post-claim outcomes,
 * complete and fail, so "the prerequisite is not met yet" could only be said
 * by failing — which charges an attempt and, five attempts later (roughly 30
 * seconds with this backoff), dead-letters work that was never faulty. A cold
 * ClamAV boot is minutes.
 *
 * Everything here drives the REAL `Queue` over the in-memory adapter, which is
 * a behavioural twin of the Postgres RPCs. No DB, no network, no timers.
 */

import { describe, it, expect, vi } from 'vitest';
import { Queue } from '../lib/queue/index.js';
import { MemoryAdapter } from '../lib/queue/memory-adapter.js';
import { createQueueRunner, type QueueHandler } from '../lib/queue/runner.js';
import { clampDeferSeconds, isValidDeferReason } from '../lib/queue/types.js';

async function until(pred: () => boolean, turns = 500): Promise<void> {
  for (let i = 0; i < turns && !pred(); i++) await Promise.resolve();
}

function makeQueue(nowIso = '2026-08-19T00:00:00.000Z'): { queue: Queue; setNow: (iso: string) => void; now: () => string } {
  let current = nowIso;
  const clock = (): string => current;
  const queue = new Queue(new MemoryAdapter({ clock }), { clock });
  return { queue, setNow: (iso) => { current = iso; }, now: clock };
}

const plus = (iso: string, sec: number): string =>
  new Date(Date.parse(iso) + sec * 1000).toISOString();

describe('deferClaim — attempt refund and non-failure semantics', () => {
  it('refunds exactly the attempt the claim charged', async () => {
    const { queue } = makeQueue();
    const job = await queue.enqueue('q.def', { n: 1 }, { maxAttempts: 5 });

    const claimed = await queue.claim('q.def', { leaseSeconds: 30, owner: 'w1' });
    expect(claimed!.attempts).toBe(1);

    const outcome = await queue.deferClaim(claimed!.id, claimed!.leaseToken!, 'scanner_signatures_missing', 60);
    expect(outcome).toBe('deferred');

    const after = await queue.getById(job.id);
    // Net zero: the claim charged one, the deferral gave it back.
    expect(after!.attempts).toBe(0);
    expect(after!.status).toBe('delayed');
    // A deferral is not a failure and must leave no failure evidence behind.
    expect(after!.errorMessage).toBeUndefined();
    expect(after!.failedAt).toBeUndefined();
    expect(after!.leaseToken).toBeUndefined();
    expect(after!.deferReason).toBe('scanner_signatures_missing');
    expect(after!.deferCount).toBe(1);
  });

  it('120 cold polls consume zero net attempts, produce no DLQ entry, and never fail the job', async () => {
    const { queue, setNow, now } = makeQueue();
    const job = await queue.enqueue('q.def', { n: 1 }, { maxAttempts: 5 });

    for (let i = 0; i < 120; i++) {
      const claimed = await queue.claim('q.def', { leaseSeconds: 30, owner: 'w1' });
      expect(claimed).not.toBeNull();
      const outcome = await queue.deferClaim(claimed!.id, claimed!.leaseToken!, 'scanner_signatures_missing', 45);
      expect(outcome).toBe('deferred');
      // Advance past the scheduled delay so the next poll is eligible.
      setNow(plus(now(), 46));
    }

    const after = await queue.getById(job.id);
    expect(after!.attempts).toBe(0);
    expect(after!.status).toBe('delayed');
    expect(after!.deferCount).toBe(120);
    expect(await queue.getDlqJobs()).toHaveLength(0);
  });

  it('cannot dead-letter: a maxAttempts:1 job survives repeated deferral', async () => {
    const { queue, setNow, now } = makeQueue();
    const job = await queue.enqueue('q.def', { n: 1 }, { maxAttempts: 1 });
    for (let i = 0; i < 10; i++) {
      const c = await queue.claim('q.def', { leaseSeconds: 30 });
      await queue.deferClaim(c!.id, c!.leaseToken!, 'scanner_busy', 10);
      setNow(plus(now(), 11));
    }
    const after = await queue.getById(job.id);
    expect(after!.status).toBe('delayed');
    expect(await queue.getDlqJobs()).toHaveLength(0);
  });

  it('keeps the ORIGINAL wait start while the reason repeats, and resets when it changes', async () => {
    const { queue, setNow, now } = makeQueue();
    await queue.enqueue('q.def', { n: 1 });

    const first = await queue.claim('q.def', { leaseSeconds: 30 });
    const startedAt = now();
    await queue.deferClaim(first!.id, first!.leaseToken!, 'scanner_signatures_missing', 10);

    setNow(plus(now(), 600));
    const second = await queue.claim('q.def', { leaseSeconds: 30 });
    await queue.deferClaim(second!.id, second!.leaseToken!, 'scanner_signatures_missing', 10);
    let row = await queue.getById(first!.id);
    // Ten minutes of waiting reported as ten minutes, not as the last poll.
    expect(row!.deferredAt).toBe(startedAt);

    setNow(plus(now(), 60));
    const third = await queue.claim('q.def', { leaseSeconds: 30 });
    const changedAt = now();
    await queue.deferClaim(third!.id, third!.leaseToken!, 'scanner_busy', 10);
    row = await queue.getById(first!.id);
    expect(row!.deferredAt).toBe(changedAt);
  });

  it('is not re-claimable before its scheduled instant', async () => {
    const { queue, setNow, now } = makeQueue();
    await queue.enqueue('q.def', { n: 1 });
    const c = await queue.claim('q.def', { leaseSeconds: 30 });
    await queue.deferClaim(c!.id, c!.leaseToken!, 'scanner_busy', 300);

    setNow(plus(now(), 299));
    expect(await queue.claim('q.def', { leaseSeconds: 30 })).toBeNull();
    setNow(plus(now(), 2));
    expect(await queue.claim('q.def', { leaseSeconds: 30 })).not.toBeNull();
  });

  it('fails closed on a stale, mismatched, or expired lease and mutates nothing', async () => {
    const { queue, setNow, now } = makeQueue();
    const job = await queue.enqueue('q.def', { n: 1 });
    const c = await queue.claim('q.def', { leaseSeconds: 30, owner: 'w1' });

    expect(await queue.deferClaim(c!.id, '00000000-0000-4000-8000-000000000000', 'scanner_busy', 60))
      .toBe('not_owned');
    let row = await queue.getById(job.id);
    expect(row!.status).toBe('active');
    expect(row!.attempts).toBe(1);

    // Expired lease: the holder no longer owns the job.
    setNow(plus(now(), 31));
    expect(await queue.deferClaim(c!.id, c!.leaseToken!, 'scanner_busy', 60)).toBe('not_owned');
    row = await queue.getById(job.id);
    expect(row!.status).toBe('active');
    expect(row!.deferReason).toBeUndefined();
  });

  it('rejects a reason outside the sanitized allowlist without a round trip', async () => {
    const { queue } = makeQueue();
    await queue.enqueue('q.def', { n: 1 });
    const c = await queue.claim('q.def', { leaseSeconds: 30 });
    for (const bad of ['Scanner Busy', 'provider said: no such file /tmp/x', 'x'.repeat(65), '']) {
      expect(await queue.deferClaim(c!.id, c!.leaseToken!, bad, 60)).toBe('invalid_reason');
    }
    const row = await queue.getById(c!.id);
    expect(row!.status).toBe('active');
    expect(row!.deferReason).toBeUndefined();
  });

  it('clamps the delay into [1, 3600] seconds', () => {
    expect(clampDeferSeconds(0)).toBe(1);
    expect(clampDeferSeconds(-99)).toBe(1);
    expect(clampDeferSeconds(10_000)).toBe(3600);
    expect(clampDeferSeconds(undefined)).toBe(60);
    expect(clampDeferSeconds(Number.NaN)).toBe(60);
    expect(isValidDeferReason('scanner_signatures_missing')).toBe(true);
    expect(isValidDeferReason('SCANNER')).toBe(false);
  });

  it('a failing retry clears the deferral marker, so a retry is never counted as a wait', async () => {
    const { queue, setNow, now } = makeQueue();
    await queue.enqueue('q.def', { n: 1 }, { maxAttempts: 5 });
    const first = await queue.claim('q.def', { leaseSeconds: 30 });
    await queue.deferClaim(first!.id, first!.leaseToken!, 'scanner_busy', 5);

    setNow(plus(now(), 6));
    const second = await queue.claim('q.def', { leaseSeconds: 30 });
    await queue.failClaim(second!.id, second!.leaseToken!, 'genuine_fault');
    const row = await queue.getById(first!.id);
    expect(row!.status).toBe('delayed');
    expect(row!.deferReason).toBeUndefined();
    expect(row!.errorMessage).toBe('genuine_fault');
  });

  it('a completed job clears the deferral marker', async () => {
    const { queue, setNow, now } = makeQueue();
    await queue.enqueue('q.def', { n: 1 });
    const first = await queue.claim('q.def', { leaseSeconds: 30 });
    await queue.deferClaim(first!.id, first!.leaseToken!, 'scanner_busy', 5);
    setNow(plus(now(), 6));
    const second = await queue.claim('q.def', { leaseSeconds: 30 });
    await queue.completeClaim(second!.id, second!.leaseToken!);
    const row = await queue.getById(first!.id);
    expect(row!.status).toBe('completed');
    expect(row!.deferReason).toBeUndefined();
  });

  it('a defer and a concurrent reclaim cannot both win (H-3)', async () => {
    const { queue, setNow, now } = makeQueue();
    // maxAttempts 1 so the reclaim path would DEAD-LETTER if it won.
    const job = await queue.enqueue('q.def', { n: 1 }, { maxAttempts: 1 });
    const c = await queue.claim('q.def', { leaseSeconds: 30, owner: 'w1' });

    // The deferral lands while the lease is still live; the reclaim sweep runs
    // after expiry. Exactly one of them can have applied.
    expect(await queue.deferClaim(c!.id, c!.leaseToken!, 'scanner_busy', 600)).toBe('deferred');
    setNow(plus(now(), 31));
    const reclaimed = await queue.reclaimExpired({ limit: 10 });
    expect(reclaimed.deadLettered).toEqual([]);
    expect(reclaimed.requeued).toEqual([]);
    const row = await queue.getById(job.id);
    expect(row!.status).toBe('delayed');
    expect(await queue.getDlqJobs()).toHaveLength(0);
  });
});

describe('createQueueRunner — typed defer outcome', () => {
  it('routes a defer directive to deferClaim, never to failClaim', async () => {
    const { queue } = makeQueue();
    await queue.enqueue('q.a', { n: 1 }, { maxAttempts: 5 });
    const failSpy = vi.spyOn(queue, 'failClaim');
    const events: string[] = [];

    const handler: QueueHandler = async () => ({
      outcome: 'defer', reasonCode: 'scanner_signatures_missing', delaySeconds: 45,
    });
    const runner = createQueueRunner({
      queue, handlers: { 'q.a': handler }, owner: 'w1', leaseSeconds: 30, pollMs: 10,
      onEvent: (e) => events.push(`${e.kind}:${e.code ?? ''}`),
    });

    await runner.tick();
    await until(() => runner.inFlight() === 0);
    await runner.stop();

    expect(failSpy).not.toHaveBeenCalled();
    expect(events).toContain('deferred:scanner_signatures_missing');
    const rows = await queue.claim('q.a', { leaseSeconds: 30 });
    // Still delayed behind its delay, and its attempt was refunded.
    expect(rows).toBeNull();
  });

  it('degrades an unusable reason code to a fixed one rather than dropping the deferral', async () => {
    const { queue } = makeQueue();
    await queue.enqueue('q.a', { n: 1 });
    const events: string[] = [];
    const runner = createQueueRunner({
      queue,
      handlers: { 'q.a': async () => ({ outcome: 'defer' as const, reasonCode: 'NOT A CODE' }) },
      owner: 'w1', leaseSeconds: 30, pollMs: 10,
      onEvent: (e) => events.push(`${e.kind}:${e.code ?? ''}`),
    });
    await runner.tick();
    await until(() => runner.inFlight() === 0);
    await runner.stop();
    expect(events).toContain('deferred:prerequisite_not_ready');
  });

  it('a handler returning void still completes, unchanged', async () => {
    const { queue } = makeQueue();
    const job = await queue.enqueue('q.a', { n: 1 });
    const runner = createQueueRunner({
      queue, handlers: { 'q.a': async () => { /* void */ } },
      owner: 'w1', leaseSeconds: 30, pollMs: 10,
    });
    await runner.tick();
    await until(() => runner.inFlight() === 0);
    await runner.stop();
    expect((await queue.getById(job.id))!.status).toBe('completed');
  });

  it('a throwing deferClaim never escapes the runner and commits nothing', async () => {
    const { queue } = makeQueue();
    const job = await queue.enqueue('q.a', { n: 1 });
    vi.spyOn(queue, 'deferClaim').mockRejectedValue(new Error('db_down'));
    const events: string[] = [];
    const runner = createQueueRunner({
      queue,
      handlers: { 'q.a': async () => ({ outcome: 'defer' as const, reasonCode: 'scanner_busy' }) },
      owner: 'w1', leaseSeconds: 30, pollMs: 10,
      onEvent: (e) => events.push(`${e.kind}:${e.code ?? ''}`),
    });
    await expect(runner.tick()).resolves.toBeGreaterThan(0);
    await until(() => runner.inFlight() === 0);
    await runner.stop();
    expect(events).toContain('poll_error:defer_error');
    // Nothing was committed: the lease simply expires and reclaim requeues it.
    expect((await queue.getById(job.id))!.status).toBe('active');
    vi.restoreAllMocks();
  });
});

describe('createQueueRunner — admission gate (shouldClaim)', () => {
  it('never calls claim for a queue it does not admit', async () => {
    const { queue } = makeQueue();
    await queue.enqueue('q.gated', { n: 1 });
    const claimSpy = vi.spyOn(queue, 'claim');
    const handler = vi.fn(async () => { /* never runs */ });
    const events: string[] = [];

    const runner = createQueueRunner({
      queue, handlers: { 'q.gated': handler }, owner: 'w1', leaseSeconds: 30, pollMs: 10,
      shouldClaim: (name) => name !== 'q.gated',
      onEvent: (e) => events.push(`${e.kind}:${e.queueName}`),
    });
    await runner.tick();
    await runner.stop();

    // The POINT is the absence of the call, not the outcome.
    expect(claimSpy).not.toHaveBeenCalled();
    expect(handler).not.toHaveBeenCalled();
    expect(events).toContain('not_admitted:q.gated');
    // The job is untouched: still pending, zero attempts, claimable elsewhere.
    const rows = await queue.claim('q.gated', { leaseSeconds: 30, owner: 'other-machine' });
    expect(rows!.attempts).toBe(1);
    vi.restoreAllMocks();
  });

  it('a held queue does not stop the other queues in the same runner draining', async () => {
    const { queue } = makeQueue();
    await queue.enqueue('q.gated', { n: 1 });
    const open = await queue.enqueue('q.open', { n: 2 });

    const runner = createQueueRunner({
      queue,
      handlers: { 'q.gated': async () => { /* never */ }, 'q.open': async () => { /* ok */ } },
      owner: 'w1', leaseSeconds: 30, pollMs: 10,
      shouldClaim: (name) => name !== 'q.gated',
    });
    await runner.tick();
    await until(() => runner.inFlight() === 0);
    await runner.stop();
    expect((await queue.getById(open.id))!.status).toBe('completed');
  });

  it('a gate that throws is read as "do not claim", never as permission', async () => {
    const { queue } = makeQueue();
    await queue.enqueue('q.gated', { n: 1 });
    const claimSpy = vi.spyOn(queue, 'claim');
    const runner = createQueueRunner({
      queue, handlers: { 'q.gated': async () => { /* never */ } },
      owner: 'w1', leaseSeconds: 30, pollMs: 10,
      shouldClaim: () => { throw new Error('probe_exploded'); },
    });
    await expect(runner.tick()).resolves.toBe(0);
    await runner.stop();
    expect(claimSpy).not.toHaveBeenCalled();
    vi.restoreAllMocks();
  });
});
