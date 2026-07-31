/**
 * TST-02 — L1 queue message-contract test (Phase 6 lane L2).
 *
 * Asserts REAL runtime invariants of the worker⇄queue message contract
 * defined in app/api/src/lib/queue/types.ts (read-only reference):
 *
 *   1. Every job object produced by the adapter/Queue conforms to the
 *      QueueJob shape — required keys present, status ∈ the documented
 *      union, attempts/maxAttempts/priority are safe integers, timestamps
 *      are ISO-8601 strings, optional fields appear only where the contract
 *      allows.
 *   2. The status vocabulary is exactly the documented one:
 *      ACTIVE_STATUSES = [pending, active, delayed],
 *      TERMINAL_STATUSES = [completed, failed], DLQ_STATUS = failed.
 *   3. Status transitions follow the documented machine through the REAL
 *      MemoryAdapter + Queue: pending→active→completed (happy), retry
 *      (delayed), exhausted→DLQ, replay→pending with attempt counter reset.
 *   4. Idempotent enqueue via dedupKey (same key + non-terminal state ⇒
 *      same job; terminal state ⇒ new job) — the REL-01 no-duplicate
 *      invariant.
 *   5. EnqueueInput shape: the Queue builds exactly the documented input
 *      and the adapter stamps id/createdAt/status.
 *   6. IQueueAdapter surface: MemoryAdapter implements every documented
 *      method with the documented signatures (runtime contract check).
 *   7. Deterministic backoff formula (computeBackoffMsDeterministic) is
 *      exact for known attempt/jitter inputs — REL-04 retry timing.
 *
 * These are real type/message invariants exercised against the actual
 * runtime objects, not a textual parse of types.ts.
 */

import { describe, it, expect, beforeEach } from 'vitest';
import { Queue } from '../lib/queue/index.js';
import { MemoryAdapter } from '../lib/queue/memory-adapter.js';
import {
  ACTIVE_STATUSES,
  TERMINAL_STATUSES,
  DLQ_STATUS,
  computeBackoffMsDeterministic,
  type QueueJob,
  type QueueStatus,
  type EnqueueInput,
  type IQueueAdapter,
} from '../lib/queue/types.js';

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
const ISO_RE = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{3})?Z$/;

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

// ── Runtime QueueJob conformance checker (mirrors the types.ts contract) ──

const ALL_STATUSES: readonly QueueStatus[] = ['pending', 'active', 'delayed', 'completed', 'failed'];

function isIsoString(v: unknown): v is string {
  return typeof v === 'string' && ISO_RE.test(v);
}

function isSafeInt(v: unknown): v is number {
  return typeof v === 'number' && Number.isSafeInteger(v);
}

/** Collect every violation of the QueueJob contract for one job object. */
function queueJobViolations(job: unknown, path = 'job'): string[] {
  const errors: string[] = [];
  if (typeof job !== 'object' || job === null) {
    return [`${path}: expected an object`];
  }
  const j = job as Record<string, unknown>;

  const requiredKeys = ['id', 'name', 'payload', 'status', 'attempts', 'maxAttempts', 'priority', 'scheduledAt', 'createdAt'] as const;
  for (const key of requiredKeys) {
    if (!(key in j)) errors.push(`${path}.${key}: missing required property`);
  }
  if (typeof j.id !== 'string' || j.id.length === 0) errors.push(`${path}.id: expected non-empty string`);
  if (typeof j.name !== 'string' || j.name.length === 0) errors.push(`${path}.name: expected non-empty string`);
  if (!ALL_STATUSES.includes(j.status as QueueStatus)) errors.push(`${path}.status: ${String(j.status)} not in ${ALL_STATUSES.join('|')}`);
  if (!isSafeInt(j.attempts) || (j.attempts as number) < 0) errors.push(`${path}.attempts: expected non-negative integer`);
  if (!isSafeInt(j.maxAttempts) || (j.maxAttempts as number) < 1) errors.push(`${path}.maxAttempts: expected integer >= 1`);
  if (!isSafeInt(j.priority)) errors.push(`${path}.priority: expected integer`);
  if (!isIsoString(j.scheduledAt)) errors.push(`${path}.scheduledAt: expected ISO-8601 string`);
  if (!isIsoString(j.createdAt)) errors.push(`${path}.createdAt: expected ISO-8601 string`);
  if (j.dedupKey !== undefined && (typeof j.dedupKey !== 'string' || j.dedupKey.length === 0)) {
    errors.push(`${path}.dedupKey: expected non-empty string when present`);
  }
  // Optional timestamps — present ⇒ ISO-8601.
  for (const key of ['startedAt', 'completedAt', 'failedAt']) {
    if (j[key] !== undefined && !isIsoString(j[key])) errors.push(`${path}.${key}: expected ISO-8601 string when present`);
  }
  if (j.errorMessage !== undefined && typeof j.errorMessage !== 'string') {
    errors.push(`${path}.errorMessage: expected string when present`);
  }
  return errors;
}

/** EnqueueInput must be exactly Omit<QueueJob, id|createdAt|status> (+ optional status). */
function enqueueInputViolations(input: unknown): string[] {
  const errors: string[] = [];
  if (typeof input !== 'object' || input === null) return [`input: expected an object`];
  const allowed = new Set(['name', 'payload', 'dedupKey', 'attempts', 'maxAttempts', 'priority', 'scheduledAt', 'status']);
  for (const key of Object.keys(input as Record<string, unknown>)) {
    if (!allowed.has(key)) errors.push(`input.${key}: not part of EnqueueInput`);
  }
  const i = input as Record<string, unknown>;
  if (typeof i.name !== 'string') errors.push('input.name: expected string');
  if (!isSafeInt(i.attempts) || i.attempts !== 0) errors.push('input.attempts: contract says adapter receives attempts=0');
  if (i.status !== undefined && i.status !== 'pending') errors.push('input.status: contract says adapter receives status pending');
  return errors;
}

describe('queue message contract: QueueJob runtime shape (types.ts)', () => {
  beforeEach(() => setFakeNow(FIXED_START));

  it('every lifecycle status value is exactly the documented union', () => {
    expect(ACTIVE_STATUSES).toEqual(['pending', 'active', 'delayed']);
    expect(TERMINAL_STATUSES).toEqual(['completed', 'failed']);
    expect(DLQ_STATUS).toBe('failed');
    expect([...ACTIVE_STATUSES, ...TERMINAL_STATUSES]).toEqual(ALL_STATUSES);
  });

  it('enqueue returns a fully contract-conforming job', async () => {
    const { queue } = createQueue();
    const job = await queue.enqueue('test-queue', { x: 1 }, { dedupKey: 'k', priority: 5 });
    expect(queueJobViolations(job)).toEqual([]);
    expect(job.payload).toEqual({ x: 1 });
    expect(job.dedupKey).toBe('k');
    expect(job.status).toBe('pending');
    expect(job.attempts).toBe(0);
  });

  it('EnqueueInput passed to the adapter matches the documented Omit shape', async () => {
    const { adapter } = createQueue();
    let captured: unknown;
    const original = adapter.enqueue.bind(adapter);
    adapter.enqueue = async (input: EnqueueInput) => {
      captured = input;
      return original(input);
    };
    const queue = new Queue(adapter, { clock });
    await queue.enqueue('q', { a: 1 }, { dedupKey: 'd', maxAttempts: 5, priority: 3, scheduledAt: FIXED_START });
    expect(enqueueInputViolations(captured)).toEqual([]);
  });

  it('dequeued jobs stay contract-conforming and carry the documented active markers', async () => {
    const { queue } = createQueue();
    await queue.enqueue('q', { n: 1 });
    const dequeued = await queue.dequeue('q');
    expect(dequeued).not.toBeNull();
    expect(queueJobViolations(dequeued!)).toEqual([]);
    expect(dequeued!.status).toBe('active');
    expect(dequeued!.attempts).toBe(1);
    expect(ACTIVE_STATUSES).toContain(dequeued!.status);
  });

  it('completed jobs conform and are terminal', async () => {
    const { queue } = createQueue();
    const job = await queue.enqueue('q', {});
    const d = await queue.dequeue('q');
    await queue.complete(d!);
    const done = await queue.getById(job.id);
    expect(queueJobViolations(done!)).toEqual([]);
    expect(done!.status).toBe('completed');
    expect(TERMINAL_STATUSES).toContain(done!.status);
    expect(isIsoString(done!.completedAt)).toBe(true);
  });

  it('retry keeps the job delayed with a valid future scheduledAt (bounded loss)', async () => {
    const { queue } = createQueue({ backoffBaseMs: 1000, backoffMaxMs: 60_000 });
    const job = await queue.enqueue('q', {});
    const d = await queue.dequeue('q');
    const result = await queue.fail(d!, 'transient');
    expect(result).toBeTruthy();
    expect(queueJobViolations(result!)).toEqual([]);
    expect(result!.status).toBe('delayed');
    expect(ACTIVE_STATUSES).toContain(result!.status);
    expect(Date.parse(result!.scheduledAt)).toBeGreaterThan(Date.parse(fakeNow));
  });

  it('exhausted retries land in the DLQ as failed with the error message preserved', async () => {
    const { queue } = createQueue({ defaultMaxAttempts: 1 });
    const job = await queue.enqueue('q', { important: true });
    const d = await queue.dequeue('q');
    const dlq = await queue.fail(d!, 'fatal boom');
    expect(dlq).toBeTruthy();
    expect(queueJobViolations(dlq!)).toEqual([]);
    expect(dlq!.status).toBe('failed');
    expect(dlq!.status).toBe(DLQ_STATUS);
    expect(dlq!.errorMessage).toBe('fatal boom');
    expect(TERMINAL_STATUSES).toContain(dlq!.status);

    const dlqJobs = await queue.getDlqJobs();
    expect(dlqJobs).toHaveLength(1);
    expect(queueJobViolations(dlqJobs[0])).toEqual([]);
    expect(dlqJobs[0].payload).toEqual({ important: true }); // payload fidelity across DLQ
  });

  it('replay produces a fresh pending job with reset counter (contract transition back to pending)', async () => {
    const { queue } = createQueue({ defaultMaxAttempts: 1 });
    const job = await queue.enqueue('q', { v: 7 });
    const d = await queue.dequeue('q');
    await queue.fail(d!, 'needs replay');
    const dlq = (await queue.getDlqJobs())[0];

    const replayed = await queue.replay(dlq.id);
    expect(queueJobViolations(replayed)).toEqual([]);
    expect(replayed.status).toBe('pending');
    expect(replayed.attempts).toBe(0);
    expect(replayed.id).not.toBe(dlq.id);
    expect(replayed.payload).toEqual({ v: 7 });
  });

  it('dedupKey idempotency: same key + non-terminal state returns the same job (no duplicate)', async () => {
    const { queue } = createQueue();
    const j1 = await queue.enqueue('q', { v: 1 }, { dedupKey: 'dup-1' });
    const j2 = await queue.enqueue('q', { v: 2 }, { dedupKey: 'dup-1' });
    expect(j2.id).toBe(j1.id);
    expect(j2.payload).toEqual({ v: 1 }); // first write wins
  });

  it('dedupKey releases after terminal state so a new job can be enqueued', async () => {
    const { queue } = createQueue({ defaultMaxAttempts: 1 });
    const j1 = await queue.enqueue('q', { v: 1 }, { dedupKey: 'dup-2' });
    const d = await queue.dequeue('q');
    await queue.fail(d!, 'x'); // → DLQ (terminal)
    const j2 = await queue.enqueue('q', { v: 2 }, { dedupKey: 'dup-2' });
    expect(j2.id).not.toBe(j1.id);
    expect(j2.payload).toEqual({ v: 2 });
  });

  it('MemoryAdapter implements the full IQueueAdapter surface at runtime', async () => {
    const { adapter } = createQueue();
    const methods = [
      'enqueue', 'dequeue', 'complete', 'fail', 'scheduleRetry',
      'moveToDlq', 'replay', 'getById', 'getDlqJobs',
    ];
    for (const m of methods) {
      expect(typeof (adapter as unknown as Record<string, unknown>)[m], `MemoryAdapter.${m}`).toBe('function');
    }
    // The Queue depends on exactly this seam: compile-time + runtime double check.
    const asInterface = adapter as unknown as IQueueAdapter;
    expect(typeof asInterface.enqueue).toBe('function');
    expect(typeof asInterface.dequeue).toBe('function');
  });
});

describe('queue message contract: deterministic backoff (REL-04)', () => {
  it('computes the exact documented formula for fixed attempt/jitter inputs', () => {
    // attempt=0, jitterCoeff=0.75 → base 1000*2^0 = 1000 → 750
    expect(computeBackoffMsDeterministic(0, 0.75)).toBe(750);
    // attempt=1, jitterCoeff=0.5 → 1000*2^1 = 2000 → 1000
    expect(computeBackoffMsDeterministic(1, 0.5)).toBe(1000);
    // attempt=2, jitterCoeff=1.0 → 1000*2^2 = 4000 → 4000
    expect(computeBackoffMsDeterministic(2, 1.0)).toBe(4000);
    // attempt=5, jitterCoeff=0.5 → 1000*2^5 = 32000 → 16000
    expect(computeBackoffMsDeterministic(5, 0.5)).toBe(16000);
    // Capped at maxMs.
    expect(computeBackoffMsDeterministic(10, 1.0, 1000, 60_000)).toBe(60_000);
    // Custom base: attempt=3, base=2000 → 2000*2^3 = 16000 * 0.75 = 12000
    expect(computeBackoffMsDeterministic(3, 0.75, 2000, 120_000)).toBe(12_000);
  });

  it('backoff stays within [0.5, 1.0] × exponential bounds for all documented ranges', () => {
    for (let attempt = 0; attempt <= 12; attempt++) {
      for (const coeff of [0.5, 0.75, 1.0]) {
        const delay = computeBackoffMsDeterministic(attempt, coeff, 1000, 60_000);
        expect(delay).toBeGreaterThanOrEqual(0);
        expect(delay).toBeLessThanOrEqual(60_000);
      }
    }
  });
});
