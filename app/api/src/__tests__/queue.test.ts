/**
 * L1 queue (REL-01/04): Focused tests for Queue + MemoryAdapter.
 *
 * Verifies:
 *  1. Basic enqueue/dequeue/complete lifecycle
 *  2. Idempotent enqueue via dedupKey (duplicate delivery → no duplicate)
 *  3. Retry/backoff+jitter computed correctly (deterministic)
 *  4. Exhausted retries → DLQ (no lost job)
 *  5. DLQ replay moves job back to pending
 *  6. Priority ordering
 *  7. Scheduled/delayed jobs respect future time
 *  8. No lost jobs (strict accounting on fail paths)
 *
 * Uses MemoryAdapter with a deterministic clock so all timing is predictable.
 */

import { describe, it, expect, beforeEach } from 'vitest';
import { Queue } from '../lib/queue/index.js';
import { MemoryAdapter } from '../lib/queue/memory-adapter.js';
import { computeBackoffMsDeterministic } from '../lib/queue/types.js';

// ── Deterministic clock ───────────────────────────────────────────────

let fakeNow: string;
function setFakeNow(iso: string) { fakeNow = iso; }
function tick(ms: number) {
  const d = new Date(fakeNow);
  d.setTime(d.getTime() + ms);
  fakeNow = d.toISOString();
}
const clock = () => fakeNow;
const FIXED_START = '2026-01-01T00:00:00.000Z';

// ── Helpers ───────────────────────────────────────────────────────────

function createQueue(options?: { backoffBaseMs?: number; backoffMaxMs?: number; defaultMaxAttempts?: number }) {
  setFakeNow(FIXED_START);
  const adapter = new MemoryAdapter({ clock });
  const queue = new Queue(adapter, {
    backoffBaseMs: options?.backoffBaseMs ?? 1000,
    backoffMaxMs: options?.backoffMaxMs ?? 60_000,
    defaultMaxAttempts: options?.defaultMaxAttempts ?? 3,
    clock,
  });
  return { adapter, queue };
}

// ── Tests ─────────────────────────────────────────────────────────────

describe('Queue lifecycle', () => {
  beforeEach(() => {
    setFakeNow(FIXED_START);
  });

  // ── 1. Basic enqueue / dequeue / complete ─────────────────────────

  it('enqueue creates a pending job', async () => {
    const { queue } = createQueue();
    const job = await queue.enqueue('test-queue', { x: 1 });

    expect(job.id).toBeTruthy();
    expect(job.name).toBe('test-queue');
    expect(job.payload).toEqual({ x: 1 });
    expect(job.status).toBe('pending');
    expect(job.attempts).toBe(0);
    expect(job.maxAttempts).toBe(3);
  });

  it('dequeue returns null when queue is empty', async () => {
    const { queue } = createQueue();
    const result = await queue.dequeue('test-queue');
    expect(result).toBeNull();
  });

  it('enqueue → dequeue → complete succeeds', async () => {
    const { queue } = createQueue();

    const job = await queue.enqueue('test-queue', { x: 1 });
    const dequeued = await queue.dequeue('test-queue');

    expect(dequeued).not.toBeNull();
    expect(dequeued!.id).toBe(job.id);
    expect(dequeued!.status).toBe('active');
    expect(dequeued!.attempts).toBe(1);

    await queue.complete(dequeued!);

    const completed = await queue.getById(dequeued!.id);
    expect(completed).not.toBeNull();
    expect(completed!.status).toBe('completed');
    expect(completed!.completedAt).toBeTruthy();
  });

  it('dequeue respects FIFO order among same-priority jobs', async () => {
    const { queue } = createQueue();

    const j1 = await queue.enqueue('fifo-queue', { seq: 1 });
    tick(10);
    const j2 = await queue.enqueue('fifo-queue', { seq: 2 });
    tick(10);
    const j3 = await queue.enqueue('fifo-queue', { seq: 3 });

    const d1 = await queue.dequeue('fifo-queue');
    const d2 = await queue.dequeue('fifo-queue');
    const d3 = await queue.dequeue('fifo-queue');

    expect(d1!.id).toBe(j1.id);
    expect(d2!.id).toBe(j2.id);
    expect(d3!.id).toBe(j3.id);
  });

  // ── 2. Idempotent enqueue (dedupKey) ───────────────────────────────

  it('duplicate dedupKey returns existing pending job', async () => {
    const { queue } = createQueue();

    const j1 = await queue.enqueue('dedup-queue', { val: 1 }, { dedupKey: 'key-1' });
    const j2 = await queue.enqueue('dedup-queue', { val: 2 }, { dedupKey: 'key-1' });

    // Same ID returned; payload from first enqueue.
    expect(j2.id).toBe(j1.id);
    expect(j2.payload).toEqual({ val: 1 });
  });

  it('same dedupKey on completed job creates a new job', async () => {
    const { queue } = createQueue();

    const j1 = await queue.enqueue('dedup-queue', { val: 1 }, { dedupKey: 'key-2' });
    const d1 = await queue.dequeue('dedup-queue');
    await queue.complete(d1!);

    // Enqueue again with same key — should get a new job since the first is completed.
    const j2 = await queue.enqueue('dedup-queue', { val: 2 }, { dedupKey: 'key-2' });
    expect(j2.id).not.toBe(j1.id);
    expect(j2.payload).toEqual({ val: 2 });
  });

  it('same dedupKey on DLQ (failed) job creates a new job', async () => {
    const { adapter, queue } = createQueue({ defaultMaxAttempts: 1 });

    const j1 = await queue.enqueue('dedup-queue', { val: 1 }, { dedupKey: 'key-3' });
    const d1 = await queue.dequeue('dedup-queue');
    await queue.fail(d1!, 'oops');

    const j2 = await queue.enqueue('dedup-queue', { val: 2 }, { dedupKey: 'key-3' });
    expect(j2.id).not.toBe(j1.id);
    expect(j2.payload).toEqual({ val: 2 });
  });

  // ── 3. Retry / backoff + jitter ───────────────────────────────────

  it('backoff with deterministic jitter produces expected delay', () => {
    // attempt=0, jitterCoeff=0.75 → baseMs=1000, exp=1000*2^0=1000, delay=1000*0.75=750
    const d0 = computeBackoffMsDeterministic(0, 0.75);
    expect(d0).toBe(750);

    // attempt=1, jitterCoeff=0.5 → baseMs=1000, exp=1000*2^1=2000, delay=2000*0.5=1000
    const d1 = computeBackoffMsDeterministic(1, 0.5);
    expect(d1).toBe(1000);

    // attempt=2, jitterCoeff=1.0 → baseMs=1000, exp=1000*2^2=4000, delay=4000*1.0=4000
    const d2 = computeBackoffMsDeterministic(2, 1.0);
    expect(d2).toBe(4000);

    // attempt=5, jitterCoeff=0.5 → baseMs=1000, exp=1000*2^5=32000, delay=32000*0.5=16000
    const d5 = computeBackoffMsDeterministic(5, 0.5);
    expect(d5).toBe(16000);

    // Cap at maxMs (60_000 default)
    const dCap = computeBackoffMsDeterministic(10, 1.0, 1000, 60_000);
    expect(dCap).toBe(60_000);
  });

  it('fail schedules retry with backoff when attempts < maxAttempts', async () => {
    const { adapter, queue } = createQueue({ backoffBaseMs: 1000, backoffMaxMs: 60_000 });

    const job = await queue.enqueue('retry-queue', {});
    const dequeued = await queue.dequeue('retry-queue');

    // After dequeue, attempts = 1. maxAttempts = 3, so we have 2 retries left.
    expect(dequeued!.attempts).toBe(1);

    const result = await queue.fail(dequeued!, 'transient error');

    // Should be scheduled for retry (not moved to DLQ).
    expect(result).toBeTruthy();
    expect(result!.status).toBe('delayed');

    // Scheduled time should be in the future (base*2^(attempt-1) = 1000*2^0 = 1000ms with jitter)
    const scheduled = new Date(result!.scheduledAt).getTime();
    const now = new Date(fakeNow).getTime();
    expect(scheduled).toBeGreaterThanOrEqual(now + 500); // at least 50% of 1000ms
    expect(scheduled).toBeLessThanOrEqual(now + 1000);  // at most 100% of 1000ms
  });

  // ── 4. Exhausted retries → DLQ ─────────────────────────────────────

  it('exhausted retries move job to DLQ', async () => {
    const { adapter, queue } = createQueue({ defaultMaxAttempts: 1 });

    const job = await queue.enqueue('dlq-queue', {});
    const dequeued = await queue.dequeue('dlq-queue');
    // after dequeue, attempts=1, maxAttempts=1 → no retries left

    const result = await queue.fail(dequeued!, 'fatal error');

    // Should be moved to DLQ.
    expect(result).toBeTruthy();
    expect(result!.status).toBe('failed');
    expect(result!.errorMessage).toBe('fatal error');

    // Job should not be in main queue anymore.
    const byId = await queue.getById(dequeued!.id);
    expect(byId).toBeTruthy();
    expect(byId!.status).toBe('failed');

    // DLQ should contain exactly this job.
    const dlqJobs = await queue.getDlqJobs();
    expect(dlqJobs).toHaveLength(1);
    expect(dlqJobs[0].id).toBe(dequeued!.id);
    expect(dlqJobs[0].errorMessage).toBe('fatal error');
  });

  it('exhausted retries after multiple failures', async () => {
    const { adapter, queue } = createQueue({ defaultMaxAttempts: 3, backoffBaseMs: 100 });

    const job = await queue.enqueue('multi-dlq', {});

    // Fail attempt 1 → retry
    let d = await queue.dequeue('multi-dlq');
    await queue.fail(d!, 'fail 1');
    expect((await queue.getById(d!.id))!.status).toBe('delayed');

    tick(200);

    // Fail attempt 2 → retry
    d = await queue.dequeue('multi-dlq');
    expect(d!.attempts).toBe(2);
    await queue.fail(d!, 'fail 2');
    expect((await queue.getById(d!.id))!.status).toBe('delayed');

    tick(400);

    // Fail attempt 3 → DLQ (maxAttempts = 3, so last attempt exhausted)
    d = await queue.dequeue('multi-dlq');
    expect(d!.attempts).toBe(3);
    await queue.fail(d!, 'fail 3');

    const dlqJobs = await queue.getDlqJobs();
    expect(dlqJobs).toHaveLength(1);
    expect(dlqJobs[0].errorMessage).toBe('fail 3');
  });

  // ── 5. DLQ replay ──────────────────────────────────────────────────

  it('replay moves DLQ job back to pending with new ID and reset counter', async () => {
    const { adapter, queue } = createQueue({ defaultMaxAttempts: 1 });

    const job = await queue.enqueue('replay-queue', { important: true });
    const dequeued = await queue.dequeue('replay-queue');
    await queue.fail(dequeued!, 'needs replay');

    // Replay the DLQ job.
    const replayed = await queue.replay(dequeued!.id);

    // New job should be pending with new ID.
    expect(replayed.id).not.toBe(dequeued!.id);
    expect(replayed.status).toBe('pending');
    expect(replayed.attempts).toBe(0);
    expect(replayed.payload).toEqual({ important: true });

    // Can dequeue and complete the replayed job.
    const d2 = await queue.dequeue('replay-queue');
    expect(d2!.id).toBe(replayed.id);
    await queue.complete(d2!);

    expect((await queue.getById(replayed.id))!.status).toBe('completed');
  });

  // ── 6. Priority ordering ───────────────────────────────────────────

  it('dequeue respects priority order (higher first)', async () => {
    const { queue } = createQueue();

    const jLow  = await queue.enqueue('prio-queue', { p: 0 },  { priority: 0 });
    tick(10);
    const jHigh = await queue.enqueue('prio-queue', { p: 10 }, { priority: 10 });

    // Higher priority dequeued first despite being enqueued later.
    const first = await queue.dequeue('prio-queue');
    expect(first!.id).toBe(jHigh.id);

    const second = await queue.dequeue('prio-queue');
    expect(second!.id).toBe(jLow.id);
  });

  // ── 7. Scheduled / delayed jobs ────────────────────────────────────

  it('dequeue skips future-scheduled jobs', async () => {
    const { queue } = createQueue();

    const futureDate = new Date(Date.parse(FIXED_START) + 10_000).toISOString();
    await queue.enqueue('future-queue', { immediate: false }, { scheduledAt: futureDate });

    // Now should return null since the job is scheduled in the future.
    const result = await queue.dequeue('future-queue');
    expect(result).toBeNull();

    // Advance time past the scheduled time.
    tick(10_000);

    const after = await queue.dequeue('future-queue');
    expect(after).not.toBeNull();
    expect(after!.name).toBe('future-queue');
  });

  // ── 8. No lost jobs (strict accounting) ────────────────────────────

  it('fail without retries or DLQ does not lose the job', async () => {
    const { adapter, queue } = createQueue({ defaultMaxAttempts: 1 });

    const job = await queue.enqueue('no-loss', {});
    const d = await queue.dequeue('no-loss');

    await queue.fail(d!, 'gone');

    // Job should be in DLQ, not silently dropped.
    const dlqJobs = await queue.getDlqJobs();
    expect(dlqJobs).toHaveLength(1);

    // The job should still be findable via getById.
    const found = await queue.getById(d!.id);
    expect(found).not.toBeNull();
    expect(found!.status).toBe('failed');
  });

  it('cannot lose a job by calling fail on an already-terminal job', async () => {
    const { adapter, queue } = createQueue({ defaultMaxAttempts: 1 });

    const job = await queue.enqueue('double-fail', {});
    const d = await queue.dequeue('double-fail');

    // First fail → DLQ.
    await queue.fail(d!, 'first fail');
    expect((await queue.getDlqJobs())).toHaveLength(1);

    // Second fail → no-op (already terminal).
    const result = await queue.fail(d!, 'second fail');
    expect(result).toBeUndefined();
    expect((await queue.getDlqJobs())).toHaveLength(1); // still 1, not duplicated
  });

  it('batch dequeue returns up to batchSize jobs', async () => {
    const { queue } = createQueue();

    for (let i = 0; i < 5; i++) {
      await queue.enqueue('batch-queue', { idx: i });
    }

    const batch = await queue.dequeueBatch('batch-queue', 3);
    expect(batch).toHaveLength(3);

    const remaining = await queue.dequeueBatch('batch-queue', 3);
    expect(remaining).toHaveLength(2);
  });

  it('exhausted retries + DLQ + replay cycle preserves payload fidelity', async () => {
    const { adapter, queue } = createQueue({ defaultMaxAttempts: 2, backoffBaseMs: 100 });

    const originalPayload = { userId: 'u-42', action: 'process', meta: { version: 2 } };
    const job = await queue.enqueue('fidelity-queue', originalPayload, { dedupKey: 'fidelity-1' });
    expect(job.payload).toEqual(originalPayload);

    // Fail attempt 1 → retry (delayed).
    let d = await queue.dequeue('fidelity-queue');
    await queue.fail(d!, 'temp error');
    tick(200);

    // Fail attempt 2 → DLQ.
    d = await queue.dequeue('fidelity-queue');
    await queue.fail(d!, 'final error');

    // Check DLQ has the payload.
    const dlqJobs = await queue.getDlqJobs();
    expect(dlqJobs).toHaveLength(1);
    expect(dlqJobs[0].payload).toEqual(originalPayload);

    // Replay.
    const replayed = await queue.replay(dlqJobs[0].id);
    expect(replayed.payload).toEqual(originalPayload);

    // Complete it.
    const d2 = await queue.dequeue('fidelity-queue');
    expect(d2!.payload).toEqual(originalPayload);
    await queue.complete(d2!);
  });
});
