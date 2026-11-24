/**
 * M034 S06 T5: the `r1-meet` dispatcher (lib/r1/meet/dispatcher.ts), the one queue handler of the Meet
 * runtime, driven directly and through the REAL queue runner over a `MemoryAdapter` queue.
 *
 * Pinned (D-S06-4..6, D-S06-33):
 *  - the registry holds every kind of the job contract once; a duplicate definition throws at
 *    construction, and an added kind is dispatched (the S09 seam);
 *  - an unknown kind and a malformed payload throw their closed codes, alert, and dead-letter under
 *    that code; a throw that is not an `R1MeetJobError` becomes `r1_meet_unexpected_error`;
 *  - a receipt ends `processed` / `ignored` when the job is done, `failed` only on the FINAL attempt of
 *    a throwing job, and is never touched by a deferral; a failed receipt update never fails the job;
 *  - a deferral passes through; Meet turned off mid-flight defers before anything is read;
 *  - one closed log line per job, never an id.
 */

import { describe, expect, it, vi } from 'vitest';
import { Queue } from '../lib/queue/index.js';
import { MemoryAdapter } from '../lib/queue/memory-adapter.js';
import { createQueueRunner } from '../lib/queue/runner.js';
import type { QueueJob } from '../lib/queue/types.js';
import {
  R1_MEET_DEFINITIONS,
  R1_MEET_INACTIVE,
  R1_MEET_INACTIVE_DEFER_SEC,
  R1_MEET_UNEXPECTED_ERROR,
  createR1MeetDispatcher,
} from '../lib/r1/meet/dispatcher.js';
import {
  R1MeetJobError,
  R1_MEET_JOB_KINDS,
  R1_MEET_QUEUE,
  r1MeetDefer,
  r1MeetIgnored,
  r1MeetProcessed,
  type R1MeetJobMeta,
  type R1MeetJobResult,
} from '../lib/r1/meet/jobs.js';
import type { R1MeetFlowDeps, R1MeetJobDefinition } from '../lib/r1/meet/recall-actions.js';
import { HARNESS_NOW, createR1MeetHarness, fixtureId, type R1MeetHarness } from './support/r1-meet-harness.js';

interface TestJob {
  readonly kind: 'test_kind';
  readonly n: number;
}

/** A definition of a kind the contract does not have (what S09 adds). */
function testDefinition(
  run: (deps: R1MeetFlowDeps, job: TestJob, meta: R1MeetJobMeta) => Promise<R1MeetJobResult>,
): R1MeetJobDefinition<TestJob> {
  return {
    kind: 'test_kind',
    parse: (payload) => {
      const value = payload as { kind?: unknown; n?: unknown } | null;
      return value !== null && typeof value === 'object' && value.kind === 'test_kind' && typeof value.n === 'number'
        ? { kind: 'test_kind', n: value.n }
        : null;
    },
    run,
  };
}

function jobOf(payload: unknown, over: Partial<QueueJob<unknown>> = {}): QueueJob<unknown> {
  return {
    id: 'job-1',
    name: R1_MEET_QUEUE,
    payload,
    status: 'active',
    attempts: 1,
    maxAttempts: 5,
    priority: 0,
    scheduledAt: HARNESS_NOW,
    createdAt: HARNESS_NOW,
    deferCount: 0,
    ...over,
  };
}

/** A receipt row as `r1_meet_record_receipt` leaves it: `enqueued`, not yet final. */
function seedReceipt(h: R1MeetHarness): string {
  const id = fixtureId();
  h.db.tables.r1_meet_receipts.push({
    id,
    source: 'recall',
    dedupe_key: `recall:${id}`,
    event_type: 'bot.joining_call',
    booking_id: null,
    outcome: 'enqueued',
    received_at: HARNESS_NOW,
    processed_at: null,
  });
  return id;
}

const receiptOutcome = (h: R1MeetHarness, id: string): unknown =>
  h.db.tables.r1_meet_receipts.find((row) => row.id === id)?.outcome;

const jobLines = (h: R1MeetHarness) => h.logs.filter((line) => line.meta.error_category === 'r1_meet_job');

function world(definitions?: readonly R1MeetJobDefinition[]) {
  const h = createR1MeetHarness();
  let active = true;
  const flowDeps = vi.fn(() => h.deps);
  const dispatcher = createR1MeetDispatcher({
    ...(definitions === undefined ? {} : { definitions }),
    flowDeps,
    active: () => active,
  });
  return {
    h,
    dispatcher,
    flowDeps,
    setActive: (value: boolean) => {
      active = value;
    },
  };
}

describe('the registry (D-S06-4)', () => {
  it('holds every kind of the job contract exactly once, frozen', () => {
    // M034 S09 T1 adds `scorecard_feedback` to the job contract; S09 T3 registers its definition and
    // removes this exemption.
    const contractKinds = [...R1_MEET_JOB_KINDS].filter((kind) => kind !== 'scorecard_feedback').sort();
    expect([...R1_MEET_DEFINITIONS.map((definition) => definition.kind)].sort()).toEqual(contractKinds);
    expect(Object.isFrozen(R1_MEET_DEFINITIONS)).toBe(true);
    const { dispatcher } = world();
    expect([...dispatcher.kinds].sort()).toEqual(contractKinds);
    expect(Object.isFrozen(dispatcher.kinds)).toBe(true);
  });

  it('refuses a duplicate definition at construction (the one-definition seam)', () => {
    const duplicate = { ...R1_MEET_DEFINITIONS[0]! };
    expect(() => createR1MeetDispatcher({ definitions: [...R1_MEET_DEFINITIONS, duplicate], flowDeps: () => {
      throw new Error('unused');
    }, active: () => true })).toThrow('r1_meet_duplicate_kind');
  });

  it('refuses a kind outside the receipt rule', () => {
    const bad = { ...testDefinition(async () => r1MeetProcessed('x')), kind: 'Bad-Kind' };
    expect(() => createR1MeetDispatcher({ definitions: [bad as R1MeetJobDefinition], flowDeps: () => {
      throw new Error('unused');
    }, active: () => true })).toThrow('r1_meet_invalid_kind');
  });

  it('dispatches an added kind with its parsed job and the job facts (S09 adds one definition, nothing else)', async () => {
    const run = vi.fn(async (_deps: R1MeetFlowDeps, job: TestJob, _meta: R1MeetJobMeta) => r1MeetProcessed(`seen_${job.n}`));
    const { h, dispatcher } = world([...R1_MEET_DEFINITIONS, testDefinition(run) as R1MeetJobDefinition]);
    await expect(dispatcher.handle(jobOf({ kind: 'test_kind', n: 7, extra: 'ignored' }, { attempts: 2 }))).resolves.toBeUndefined();
    expect(run).toHaveBeenCalledTimes(1);
    const [deps, job, meta] = run.mock.calls[0]!;
    expect(deps).toBe(h.deps);
    expect(job).toEqual({ kind: 'test_kind', n: 7 });
    expect(meta).toMatchObject({ attempts: 2, maxAttempts: 5, isRerun: true, finalAttempt: false, createdAt: HARNESS_NOW });
    expect(jobLines(h).map((line) => line.meta.error_type)).toEqual(['test_kind:seen_7']);
  });
});

describe('closed failures (D-S06-5)', () => {
  it('an unknown kind throws r1_meet_unknown_kind and alerts; the log never echoes the unknown text', async () => {
    const { h, dispatcher } = world();
    for (const payload of [{ kind: 'scorecard_feedback' }, { kind: 'Not A Kind' }, null, 'text', [1], {}]) {
      h.logs.length = 0;
      const error = await dispatcher.handle(jobOf(payload)).catch((thrown: unknown) => thrown);
      expect(error).toBeInstanceOf(R1MeetJobError);
      expect((error as R1MeetJobError).message).toBe('r1_meet_unknown_kind');
      expect(h.alerts()).toEqual(['r1_meet_unknown_kind']);
      expect(jobLines(h).map((line) => line.meta.error_type)).toEqual(['unknown:r1_meet_unknown_kind']);
    }
    expect(JSON.stringify(h.logs)).not.toContain('scorecard_feedback');
  });

  it('a malformed payload of a known kind throws r1_meet_malformed_payload and alerts', async () => {
    const { h, dispatcher } = world();
    const error = await dispatcher.handle(jobOf({ kind: 'ensure_bot', booking_id: 'not-a-uuid' })).catch((thrown: unknown) => thrown);
    expect((error as Error).message).toBe('r1_meet_malformed_payload');
    expect(h.logs.filter((line) => line.level === 'error').map((line) => line.meta)).toEqual([
      { error_category: 'r1_meet_malformed_payload', error_type: 'ensure_bot' },
    ]);
    expect(h.db.calls).toEqual([]);
  });

  it('a throw that is not an R1MeetJobError becomes r1_meet_unexpected_error (no driver or vendor text)', async () => {
    const { h, dispatcher } = world([
      testDefinition(async () => {
        throw new Error('connection to db.internal at 10.0.0.1 refused for someone@example.test');
      }) as R1MeetJobDefinition,
    ]);
    const error = await dispatcher.handle(jobOf({ kind: 'test_kind', n: 1 })).catch((thrown: unknown) => thrown);
    expect(error).toBeInstanceOf(R1MeetJobError);
    expect((error as Error).message).toBe(R1_MEET_UNEXPECTED_ERROR);
    expect(JSON.stringify(h.logs)).not.toMatch(/10\.0\.0\.1|example\.test|db\.internal/);
  });

  it('through the real runner, an unknown kind and a malformed payload dead-letter under their codes', async () => {
    const h = createR1MeetHarness();
    const clock = (): string => HARNESS_NOW;
    const queue = new Queue(new MemoryAdapter({ clock }), { clock });
    const dispatcher = createR1MeetDispatcher({ flowDeps: () => h.deps, active: () => true });
    const runner = createQueueRunner({
      queue,
      handlers: { [R1_MEET_QUEUE]: (job) => dispatcher.handle(job) },
      owner: 'test-meet',
      leaseSeconds: 60,
      concurrency: 2,
      pollMs: 5000,
    });
    await queue.enqueue(R1_MEET_QUEUE, { kind: 'from_the_future' }, { maxAttempts: 1 });
    await queue.enqueue(R1_MEET_QUEUE, { kind: 'bot_release', recall_bot_id: 'nope', booking_id: fixtureId() }, { maxAttempts: 1 });
    await runner.tick();
    await runner.stop();
    const dead = await queue.getDlqJobs();
    expect(dead.map((job) => job.errorMessage).sort()).toEqual(['r1_meet_malformed_payload', 'r1_meet_unknown_kind']);
    // Final attempt: both also raise the job-failed alert.
    expect(h.alerts().filter((alert) => alert === 'r1_meet_job_failed')).toHaveLength(2);
  });
});

describe('receipts (D-S06-6)', () => {
  it('a done job ends its receipt processed or ignored, by compare-and-set', async () => {
    let answer: R1MeetJobResult = r1MeetProcessed('done_here');
    const { h, dispatcher } = world([testDefinition(async () => answer) as R1MeetJobDefinition]);
    const processed = seedReceipt(h);
    await dispatcher.handle(jobOf({ kind: 'test_kind', n: 1, receipt_id: processed.toUpperCase() }));
    expect(receiptOutcome(h, processed)).toBe('processed');

    answer = r1MeetIgnored('nothing_to_do');
    const ignored = seedReceipt(h);
    await dispatcher.handle(jobOf({ kind: 'test_kind', n: 1, receipt_id: ignored }));
    expect(receiptOutcome(h, ignored)).toBe('ignored');
    const row = h.db.tables.r1_meet_receipts.find((receipt) => receipt.id === ignored)!;
    expect(row.processed_at).toBe(HARNESS_NOW);

    // Already final: a replay changes nothing.
    answer = r1MeetProcessed('again');
    await dispatcher.handle(jobOf({ kind: 'test_kind', n: 1, receipt_id: ignored }));
    expect(receiptOutcome(h, ignored)).toBe('ignored');
  });

  it('a throwing job fails its receipt only on the final attempt (and alerts r1_meet_job_failed then)', async () => {
    const { h, dispatcher } = world([
      testDefinition(async () => {
        throw new R1MeetJobError('r1_meet_conflict');
      }) as R1MeetJobDefinition,
    ]);
    const receipt = seedReceipt(h);
    await expect(dispatcher.handle(jobOf({ kind: 'test_kind', n: 1, receipt_id: receipt }, { attempts: 4, maxAttempts: 5 })))
      .rejects.toThrow('r1_meet_conflict');
    expect(receiptOutcome(h, receipt)).toBe('enqueued');
    expect(h.alerts()).toEqual([]);

    await expect(dispatcher.handle(jobOf({ kind: 'test_kind', n: 1, receipt_id: receipt }, { attempts: 5, maxAttempts: 5 })))
      .rejects.toThrow('r1_meet_conflict');
    expect(receiptOutcome(h, receipt)).toBe('failed');
    expect(h.logs.filter((line) => line.level === 'error').map((line) => line.meta)).toEqual([
      { error_category: 'r1_meet_job_failed', error_type: 'test_kind:r1_meet_conflict' },
    ]);
  });

  it('a malformed payload with a receipt fails the receipt on its final attempt', async () => {
    const { h, dispatcher } = world();
    const receipt = seedReceipt(h);
    await expect(dispatcher.handle(jobOf({ kind: 'recall_event', receipt_id: receipt }, { attempts: 5, maxAttempts: 5 })))
      .rejects.toThrow('r1_meet_malformed_payload');
    expect(receiptOutcome(h, receipt)).toBe('failed');
  });

  it('a deferral passes through and leaves the receipt alone', async () => {
    const { h, dispatcher } = world([testDefinition(async () => r1MeetDefer('waiting_here', 42)) as R1MeetJobDefinition]);
    const receipt = seedReceipt(h);
    await expect(dispatcher.handle(jobOf({ kind: 'test_kind', n: 1, receipt_id: receipt }))).resolves.toEqual({
      outcome: 'defer',
      reasonCode: 'waiting_here',
      delaySeconds: 42,
    });
    expect(receiptOutcome(h, receipt)).toBe('enqueued');
    expect(jobLines(h).map((line) => line.meta.error_type)).toEqual(['test_kind:waiting_here']);
  });

  it('a receipt update that fails warns and never fails the job', async () => {
    const { h, dispatcher } = world([testDefinition(async () => r1MeetProcessed('ok_here')) as R1MeetJobDefinition]);
    const receipt = seedReceipt(h);
    h.db.failNext('r1_meet_receipts');
    await expect(dispatcher.handle(jobOf({ kind: 'test_kind', n: 1, receipt_id: receipt }))).resolves.toBeUndefined();
    expect(receiptOutcome(h, receipt)).toBe('enqueued');
    expect(h.logs.filter((line) => line.level === 'warn').map((line) => line.meta.error_category)).toEqual([
      'r1_meet_receipt_finish_failed',
    ]);
  });

  it('a job without a receipt id touches no receipt', async () => {
    const { h, dispatcher } = world([testDefinition(async () => r1MeetProcessed('ok_here')) as R1MeetJobDefinition]);
    await dispatcher.handle(jobOf({ kind: 'test_kind', n: 1, receipt_id: 'not-a-uuid' }));
    expect(h.db.calls).toEqual([]);
  });
});

describe('Meet turned off mid-flight', () => {
  it('defers before anything is parsed, read or run', async () => {
    const run = vi.fn(async () => r1MeetProcessed('should_not_run'));
    const { h, dispatcher, setActive } = world([testDefinition(run) as R1MeetJobDefinition]);
    const receipt = seedReceipt(h);
    setActive(false);
    await expect(dispatcher.handle(jobOf({ kind: 'test_kind', n: 1, receipt_id: receipt }))).resolves.toEqual({
      outcome: 'defer',
      reasonCode: R1_MEET_INACTIVE,
      delaySeconds: R1_MEET_INACTIVE_DEFER_SEC,
    });
    expect(run).not.toHaveBeenCalled();
    expect(h.db.calls).toEqual([]);
    expect(h.requests).toEqual([]);
    expect(receiptOutcome(h, receipt)).toBe('enqueued');
  });

  it('a switch that throws counts as off', async () => {
    const h = createR1MeetHarness();
    const dispatcher = createR1MeetDispatcher({
      flowDeps: () => h.deps,
      active: () => {
        throw new Error('unreadable');
      },
    });
    await expect(dispatcher.handle(jobOf({ kind: 'maintenance', bucket: 1 }))).resolves.toMatchObject({
      outcome: 'defer',
      reasonCode: R1_MEET_INACTIVE,
    });
    expect(h.db.calls).toEqual([]);
  });
});

describe('logs (D-S06-33)', () => {
  it('writes exactly one closed info line per job, with no id in it', async () => {
    const { h, dispatcher } = world();
    const booking = fixtureId();
    // A real kind on a booking that does not exist: one read, one line.
    await dispatcher.handle(jobOf({ kind: 'ensure_bot', booking_id: booking }));
    expect(jobLines(h)).toEqual([{ level: 'info', meta: { error_category: 'r1_meet_job', error_type: 'ensure_bot:booking_gone' } }]);
    for (const line of h.logs) {
      expect(line.meta.error_type ?? '').toMatch(/^[a-z0-9_:]{1,64}$/);
      expect(JSON.stringify(line)).not.toContain(booking);
    }
  });
});
