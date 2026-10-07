/**
 * The dedicated R1 queue runtime (plan 6.7): off by default, its own handler set, a fail-closed
 * `r1_settings.enabled` claim gate, the final-attempt/DLQ behaviour, and the status loop. The
 * structural half pins that the phone runtime's handler set is untouched (fence 3).
 */
import { describe, expect, it, vi } from 'vitest';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { Queue } from '../lib/queue/index.js';
import { MemoryAdapter } from '../lib/queue/memory-adapter.js';
import {
  R1_ASSESSMENT_QUEUE,
  R1_PROVIDER_DEFER_MAX_MS,
  R1_PROVIDER_DEFER_REASON,
  R1_PROVIDER_DEFER_SECONDS,
  createR1AssessmentHandler,
} from '../lib/r1/assessment-handler.js';
import { R1_BREAKER_COOLDOWN_MS } from '../lib/r1/deepseek-runner.js';
import { BusinessError, ProviderError } from '../lib/provider-resilience.js';
import { ScorecardValidationError } from '../lib/scorecards/domain.js';
import { R1_RUNTIME_BOUNDS, R1_RUNTIME_QUEUES, createR1Runtime } from '../lib/r1/runtime.js';
import { getR1Config } from '../lib/r1/config.js';
import { DeepseekError } from '../lib/deepseek.js';
import { R1_METRICS } from '../lib/r1/rubric.js';
import {
  SESSION_ID,
  ROUND_ID,
  baseTables,
  createFakeDb,
  happyRpc,
  type Tables,
} from './support/r1-fake-db.js';
import { cleanLogRows, interviewRows, modelAnswer } from './support/r1-scorer.js';
import type { QueueJob } from '../lib/queue/types.js';

const here = path.dirname(fileURLToPath(import.meta.url));
const src = path.resolve(here, '..');
const rows = interviewRows();

const allScores = (score: number) => Object.fromEntries(R1_METRICS.map((metric) => [metric.key, score]));

function tablesWithInterview(): Tables {
  const tables = baseTables();
  tables.transcript_turns = rows.map((row) => ({ ...row, session_id: SESSION_ID, is_gate: false }));
  tables.r1_admin_log = cleanLogRows().map((row) => ({ ...row, session_id: SESSION_ID, round_id: ROUND_ID }));
  return tables;
}

function makeQueue() {
  const clock = (): string => '2026-10-06T10:00:00.000Z';
  return new Queue(new MemoryAdapter({ clock }), { clock });
}

const ENABLED = { enabled: true, status: 'enabled' as const };

describe('construction gate', () => {
  it('constructs nothing unless R1_ENABLED is exactly "true"', () => {
    expect(createR1Runtime({ config: { enabled: false, status: 'disabled' } })).toBeNull();
    expect(createR1Runtime({ config: { enabled: false, status: 'invalid', reason: 'x' } })).toBeNull();
    // The shipped default (no R1_ENABLED in the test environment) is off.
    expect(getR1Config({}).enabled).toBe(false);
    expect(createR1Runtime({ config: getR1Config({}) })).toBeNull();
    expect(createR1Runtime({ config: getR1Config({ R1_ENABLED: 'yes' }) })).toBeNull();
  });

  it('builds a runtime that claims only r1.assessment and arms no timer until started', () => {
    const db = createFakeDb(baseTables());
    const runtime = createR1Runtime({ config: ENABLED, client: db.client as never, queue: makeQueue() })!;
    expect(runtime).not.toBeNull();
    expect([...runtime.queues]).toEqual(['r1.assessment']);
    expect(R1_RUNTIME_QUEUES).toEqual(['r1.assessment']);
    expect(runtime.scheduler.running()).toBe(false);
    expect(Object.keys(runtime.loopIntervalsMs)).toEqual(['r1-assessment', 'r1-status']);
    expect(db.fromCalls).toEqual([]);
  });
});

describe('claim gate (r1_settings.enabled, cached, fail closed)', () => {
  async function enqueueScoring(queue: Queue, options: { maxAttempts?: number } = {}) {
    await queue.enqueue(R1_ASSESSMENT_QUEUE, { session_id: SESSION_ID }, options);
  }

  it('does not claim while R1 is disabled in settings and claims once it is enabled', async () => {
    const tables = tablesWithInterview();
    tables.r1_settings![0]!.enabled = false;
    const db = createFakeDb(tables);
    const queue = makeQueue();
    await enqueueScoring(queue);
    const infer = vi.fn(async () => modelAnswer(rows, allScores(3)));
    let nowMs = Date.parse('2026-10-06T10:00:00Z');
    const runtime = createR1Runtime({
      config: ENABLED, client: db.client as never, queue, infer, now: () => new Date(nowMs),
    })!;

    await runtime.tickAll();
    expect(infer).not.toHaveBeenCalled();
    expect(db.tables.assessments).toHaveLength(0);

    // The verdict is cached for 5 s: flipping the switch is not seen immediately...
    tables.r1_settings![0]!.enabled = true;
    nowMs += R1_RUNTIME_BOUNDS.enabledCacheMs - 1;
    await runtime.tickAll();
    expect(infer).not.toHaveBeenCalled();
    // ...but is after the cache window.
    nowMs += 2;
    await runtime.tickAll();
    await runtime.runner.stop();
    expect(infer).toHaveBeenCalledTimes(3);
    expect(db.tables.assessments).toHaveLength(1);
    expect(db.tables.assessments![0]!.recommendation).toBe('advance');
    expect(runtime.snapshot().jobEvents.completed).toBe(1);
    expect(await queue.getDlqJobs()).toHaveLength(0);
  });

  it('fails closed when the settings row cannot be read', async () => {
    const db = createFakeDb(tablesWithInterview());
    const queue = makeQueue();
    await enqueueScoring(queue);
    const failing = {
      ...db.client,
      from: (table: string) => {
        if (table === 'r1_settings') throw new Error('connection refused');
        return db.client.from(table);
      },
    };
    const infer = vi.fn(async () => modelAnswer(rows, allScores(3)));
    const runtime = createR1Runtime({ config: ENABLED, client: failing as never, queue, infer })!;
    await runtime.tickAll();
    await runtime.runner.stop();
    expect(infer).not.toHaveBeenCalled();
    expect(db.tables.assessments).toHaveLength(0);
    expect(runtime.snapshot().jobEvents.not_admitted).toBeGreaterThanOrEqual(1);
  });

  it('never claims a phone queue job: it is not one of its queues', async () => {
    const db = createFakeDb(tablesWithInterview());
    const queue = makeQueue();
    await queue.enqueue('phone.assessment', { session_id: SESSION_ID, attempt_id: SESSION_ID });
    await queue.enqueue('phone.dial', { engagement_id: SESSION_ID });
    const infer = vi.fn(async () => modelAnswer(rows, allScores(3)));
    const runtime = createR1Runtime({ config: ENABLED, client: db.client as never, queue, infer })!;
    await runtime.tickAll();
    await runtime.runner.stop();
    expect(infer).not.toHaveBeenCalled();
    expect(runtime.snapshot().jobEvents.claimed ?? 0).toBe(0);
    // Both phone jobs are still claimable by the phone runtime.
    expect(await queue.claim('phone.assessment', { leaseSeconds: 30, owner: 'phone' })).not.toBeNull();
    expect(await queue.claim('phone.dial', { leaseSeconds: 30, owner: 'phone' })).not.toBeNull();
  });

  it('retries a failing job and dead-letters it with a sanitized code, recording the placeholder first', async () => {
    const db = createFakeDb(tablesWithInterview(), happyRpc());
    const queue = makeQueue();
    await enqueueScoring(queue, { maxAttempts: 1 });
    // Not a provider outage (those defer): an oversized answer cannot be fixed by waiting.
    const infer = vi.fn(async () => { throw new DeepseekError('output_limit'); });
    const runtime = createR1Runtime({ config: ENABLED, client: db.client as never, queue, infer })!;
    await runtime.tickAll();
    await runtime.runner.stop();

    const dlq = await queue.getDlqJobs();
    expect(dlq).toHaveLength(1);
    expect(dlq[0]!.name).toBe('r1.assessment');
    expect(dlq[0]!.errorMessage).toBe('deepseek_output_limit');
    // The final attempt left HR a human_review record before dead-lettering.
    expect(db.tables.assessments).toHaveLength(1);
    expect(db.tables.assessments![0]!.raw.r1.outcome).toBe('scoring_failed');
    expect(runtime.snapshot().jobEvents.failed).toBe(1);
  });
});

describe('the status loop', () => {
  it('closes due pending rejects through the RPC, only while R1 is enabled', async () => {
    const tables = tablesWithInterview();
    const db = createFakeDb(tables, (fn) => (fn === 'r1_apply_due_pending_rejects' ? { data: 2 } : { data: { status: 'ok' } }));
    const now = new Date('2026-10-07T10:00:00Z');
    const runtime = createR1Runtime({ config: ENABLED, client: db.client as never, queue: makeQueue(), now: () => now })!;
    await runtime.tickAll();
    await runtime.runner.stop();
    const sweep = db.rpcCalls.filter((call) => call.fn === 'r1_apply_due_pending_rejects');
    expect(sweep).toHaveLength(1);
    expect(sweep[0]!.args).toEqual({ p_now: now.toISOString(), p_limit: R1_RUNTIME_BOUNDS.pendingRejectBatch });
    expect(runtime.snapshot()).toMatchObject({ lastStatusApplied: 2, statusLoopErrors: 0 });

    const off = baseTables();
    off.r1_settings![0]!.enabled = false;
    const offDb = createFakeDb(off);
    const offRuntime = createR1Runtime({ config: ENABLED, client: offDb.client as never, queue: makeQueue() })!;
    await offRuntime.tickAll();
    await offRuntime.runner.stop();
    expect(offDb.rpcCalls).toHaveLength(0);
  });

  it('counts an RPC error or throw without crashing the loop', async () => {
    const errDb = createFakeDb(baseTables(), () => ({ error: { message: 'down' } }));
    const errRuntime = createR1Runtime({ config: ENABLED, client: errDb.client as never, queue: makeQueue() })!;
    await errRuntime.tickAll();
    await errRuntime.runner.stop();
    expect(errRuntime.snapshot().statusLoopErrors).toBe(1);

    const base = createFakeDb(baseTables());
    const throwing = { ...base.client, rpc: async () => { throw new Error('boom'); } };
    const throwRuntime = createR1Runtime({ config: ENABLED, client: throwing as never, queue: makeQueue() })!;
    await throwRuntime.tickAll();
    await throwRuntime.runner.stop();
    expect(throwRuntime.snapshot().statusLoopErrors).toBe(1);
  });

  it('starts and stops its scheduler cleanly', async () => {
    const db = createFakeDb(baseTables());
    const timers: Array<() => void> = [];
    const runtime = createR1Runtime({
      config: ENABLED,
      client: db.client as never,
      queue: makeQueue(),
      scheduler: {
        random: () => 0.5,
        setTimer: (fn) => { timers.push(fn); return {}; },
        clearTimer: () => undefined,
      },
    })!;
    runtime.scheduler.start();
    expect(runtime.scheduler.running()).toBe(true);
    expect(timers).toHaveLength(2);
    await runtime.stop();
    expect(runtime.scheduler.running()).toBe(false);
    expect(runtime.runner.stopped()).toBe(true);
  });
});

describe('the handler', () => {
  const job = (payload: unknown, attempts: number, maxAttempts: number): QueueJob<unknown> => ({
    id: 'job-1', name: R1_ASSESSMENT_QUEUE, payload, status: 'active', attempts, maxAttempts,
    priority: 0, scheduledAt: '2026-10-06T10:00:00Z', createdAt: '2026-10-06T10:00:00Z',
  });

  it('rejects a malformed payload with a stable code', async () => {
    const handler = createR1AssessmentHandler({ run: vi.fn() });
    for (const payload of [null, {}, { session_id: 'not-a-uuid' }, { session_id: 5 }, 'x']) {
      await expect(handler(job(payload, 1, 5))).rejects.toThrow('malformed_r1_assessment_payload');
    }
  });

  it('flags only the last claim as the final attempt', async () => {
    const run = vi.fn(async () => ({}) as never);
    const handler = createR1AssessmentHandler({ run });
    await handler(job({ session_id: SESSION_ID }, 4, 5));
    await handler(job({ session_id: SESSION_ID }, 5, 5));
    await handler(job({ session_id: SESSION_ID }, 1, 1));
    expect(run.mock.calls.map((call) => (call as unknown[])[1])).toEqual([
      expect.objectContaining({ finalAttempt: false }),
      expect.objectContaining({ finalAttempt: true }),
      expect.objectContaining({ finalAttempt: true }),
    ]);
  });

  it('completes (does not retry or dead-letter) a job whose consent was withdrawn after it was queued', async () => {
    const onResult = vi.fn();
    const run = vi.fn(async () => { throw new Error('r1_consent_withdrawn'); });
    const handler = createR1AssessmentHandler({ run, onResult });
    await expect(handler(job({ session_id: SESSION_ID }, 5, 5))).resolves.toBeUndefined();
    expect(onResult).not.toHaveBeenCalled();
    // Any other failure still takes the retry/DLQ path.
    const other = createR1AssessmentHandler({ run: async () => { throw new Error('r1_consent_read_error'); } });
    await expect(other(job({ session_id: SESSION_ID }, 1, 5))).rejects.toThrow('r1_consent_read_error');
  });

  it('reports each result to the observer', async () => {
    const onResult = vi.fn();
    const result = { sessionId: SESSION_ID } as never;
    const handler = createR1AssessmentHandler({ run: async () => result, onResult });
    await handler(job({ session_id: SESSION_ID }, 1, 5));
    expect(onResult).toHaveBeenCalledWith(result);
  });
});

describe('provider outages defer instead of dead-lettering', () => {
  const job = (overrides: Partial<QueueJob<unknown>> = {}): QueueJob<unknown> => ({
    id: 'job-1', name: R1_ASSESSMENT_QUEUE, payload: { session_id: SESSION_ID }, status: 'active',
    attempts: 5, maxAttempts: 5, priority: 0, scheduledAt: '2026-10-06T10:00:00Z',
    createdAt: '2026-10-06T10:00:00Z', ...overrides,
  });
  const failingWith = (error: Error) => createR1AssessmentHandler({
    run: async () => { throw error; },
    now: () => Date.parse('2026-10-06T12:00:00Z'),
  });

  it('defers for at least the breaker cooldown, with the sanitized reason', async () => {
    expect(R1_PROVIDER_DEFER_SECONDS).toBeGreaterThanOrEqual(R1_BREAKER_COOLDOWN_MS / 1000);
    expect(R1_PROVIDER_DEFER_REASON).toMatch(/^[a-z0-9_.:-]{1,64}$/);
    for (const code of ['deepseek_timeout', 'deepseek_connection', 'provider_circuit_open']) {
      await expect(failingWith(new Error(code))(job())).resolves.toEqual({
        outcome: 'defer',
        reasonCode: R1_PROVIDER_DEFER_REASON,
        delaySeconds: R1_PROVIDER_DEFER_SECONDS,
      });
    }
  });

  it('defers on the codes the service really produces for a provider outage', async () => {
    const { r1ErrorCode } = await import('../services/r1-assessment.js');
    for (const error of [new DeepseekError('timeout'), new DeepseekError('connection'), new ProviderError('circuit_open')]) {
      const handler = failingWith(new Error(r1ErrorCode(error), { cause: error }));
      await expect(handler(job())).resolves.toMatchObject({ outcome: 'defer' });
    }
  });

  it('does NOT defer a failure waiting cannot fix: it still throws and takes the retry/DLQ path', async () => {
    const failures = [
      new DeepseekError('output_limit'),
      new DeepseekError('missing_api_key'),
      new BusinessError(),
      new ScorecardValidationError('x', 'scorecard_invalid:result_count'),
      new Error('r1_attach_failed'),
      new Error('r1_session_not_completed'),
    ];
    const { r1ErrorCode } = await import('../services/r1-assessment.js');
    for (const error of failures) {
      const handler = failingWith(new Error(r1ErrorCode(error), { cause: error }));
      await expect(handler(job())).rejects.toThrow();
    }
  });

  it('stops deferring once the streak is older than the budget (the failure then counts)', async () => {
    const now = Date.parse('2026-10-06T12:00:00Z');
    const handler = failingWith(new Error('deepseek_timeout'));
    const within = new Date(now - R1_PROVIDER_DEFER_MAX_MS + 60_000).toISOString();
    const beyond = new Date(now - R1_PROVIDER_DEFER_MAX_MS - 1).toISOString();
    await expect(handler(job({ deferredAt: within }))).resolves.toMatchObject({ outcome: 'defer' });
    await expect(handler(job({ deferredAt: beyond }))).rejects.toThrow('deepseek_timeout');
  });

  it('through the real runtime: the job returns to delayed with its attempt refunded, no DLQ row', async () => {
    const db = createFakeDb(tablesWithInterview(), happyRpc());
    const queue = makeQueue();
    const queued = await queue.enqueue(R1_ASSESSMENT_QUEUE, { session_id: SESSION_ID }, { maxAttempts: 5 });
    const infer = vi.fn(async () => { throw new DeepseekError('timeout'); });
    const runtime = createR1Runtime({ config: ENABLED, client: db.client as never, queue, infer })!;
    await runtime.tickAll();
    await runtime.runner.stop();

    const after = await queue.getById(queued.id);
    expect(after).toMatchObject({ status: 'delayed', attempts: 0, deferReason: R1_PROVIDER_DEFER_REASON });
    expect(Date.parse(after!.scheduledAt) - Date.parse('2026-10-06T10:00:00.000Z'))
      .toBeGreaterThanOrEqual(R1_BREAKER_COOLDOWN_MS);
    expect(await queue.getDlqJobs()).toHaveLength(0);
    expect(runtime.snapshot().jobEvents.deferred).toBe(1);
    expect(runtime.snapshot().jobEvents.failed ?? 0).toBe(0);
    // A non-final attempt records nothing: HR simply has no assessment yet.
    expect(db.tables.assessments).toHaveLength(0);
  });

  it('on the last attempt HR still gets the placeholder, and the job waits instead of dead-lettering', async () => {
    const db = createFakeDb(tablesWithInterview(), happyRpc());
    const queue = makeQueue();
    const queued = await queue.enqueue(R1_ASSESSMENT_QUEUE, { session_id: SESSION_ID }, { maxAttempts: 1 });
    const infer = vi.fn(async () => { throw new DeepseekError('timeout'); });
    const runtime = createR1Runtime({ config: ENABLED, client: db.client as never, queue, infer })!;
    await runtime.tickAll();
    await runtime.runner.stop();
    expect(await queue.getDlqJobs()).toHaveLength(0);
    expect((await queue.getById(queued.id))!.status).toBe('delayed');
    expect(db.tables.assessments).toHaveLength(1);
    expect(db.tables.assessments![0]!.raw.r1).toMatchObject({ outcome: 'scoring_failed', code: 'deepseek_timeout' });
  });

  it('an open R1 breaker defers the job within the breaker cooldown instead of burning attempts', async () => {
    const db = createFakeDb(tablesWithInterview(), happyRpc());
    const queue = makeQueue();
    const queued = await queue.enqueue(R1_ASSESSMENT_QUEUE, { session_id: SESSION_ID }, { maxAttempts: 5 });
    const infer = vi.fn(async () => { throw new ProviderError('circuit_open'); });
    const runtime = createR1Runtime({ config: ENABLED, client: db.client as never, queue, infer })!;
    await runtime.tickAll();
    await runtime.runner.stop();
    expect(await queue.getDlqJobs()).toHaveLength(0);
    expect(await queue.getById(queued.id)).toMatchObject({ status: 'delayed', attempts: 0 });
  });
});

describe('structural fences (plan 9, fence 3)', () => {
  const read = (relative: string) => readFileSync(path.join(src, relative), 'utf8').replace(/\r\n/g, '\n');

  it('the phone runtime handler set is exactly {phone.dial, phone.assessment}', () => {
    const runtime = read('lib/phone-runtime/runtime.ts');
    const start = runtime.indexOf('handlers: {');
    expect(start).toBeGreaterThan(0);
    const block = runtime.slice(start, runtime.indexOf('owner,', start));
    expect([...block.matchAll(/\[([A-Z_]+)\]\s*:/g)].map((match) => match[1])).toEqual([
      'PHONE_DIAL_QUEUE',
      'PHONE_ASSESSMENT_QUEUE',
    ]);
    const config = read('lib/phone-runtime/config.ts');
    expect(config).toMatch(/PHONE_DIAL_QUEUE\s*=\s*'phone\.dial'/);
    expect(config).toMatch(/PHONE_ASSESSMENT_QUEUE\s*=\s*'phone\.assessment'/);
  });

  it('no phone, recording or funnel runtime mentions R1 or registers an r1.* queue', () => {
    for (const file of [
      'lib/phone-runtime/runtime.ts',
      'lib/phone-runtime/assessment-handler.ts',
      'lib/phone-runtime/config.ts',
      'lib/recording/runtime.ts',
      'lib/funnel/runtime.ts',
    ]) {
      const text = read(file);
      expect(text, file).not.toMatch(/lib\/r1|\.\/r1\/|\.\.\/r1\/|r1\.assessment|r1\.recording|r1\.sweep|createR1Runtime/);
    }
  });

  it('the R1 runtime registers exactly one handler and never a phone queue name', () => {
    const runtime = read('lib/r1/runtime.ts');
    const start = runtime.indexOf('handlers: {');
    const block = runtime.slice(start, runtime.indexOf('owner,', start));
    expect([...block.matchAll(/\[([A-Za-z0-9_]+)\]\s*:/g)].map((match) => match[1])).toEqual(['R1_ASSESSMENT_QUEUE']);
    // Code only: the header comment names the phone handlers to explain what R1 must not join.
    const code = runtime.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '');
    expect(code).not.toMatch(/phone\.|PHONE_|phone-runtime/);
    expect(R1_ASSESSMENT_QUEUE).toBe('r1.assessment');
  });

  it('index.ts builds the R1 runtime in its own try/catch, additive and independent', () => {
    const index = read('index.ts');
    expect(index).toMatch(/let r1Runtime: R1RuntimeHandle \| null = null;\ntry \{\n  r1Runtime = createR1Runtime\(\);\n\} catch \{/);
    expect(index).toContain("error_category: 'r1_runtime_start_failed'");
    expect(index).toContain('r1Runtime.scheduler.start();');
    expect(index).toContain('await r1Runtime.stop();');
  });

  it('the 0116 trigger enqueues the queue name the handler is registered for', () => {
    const migration = readFileSync(path.resolve(here, '../../../supabase/migrations/0116_r1_shared_session_fields.sql'), 'utf8');
    expect(migration).toContain(`'${R1_ASSESSMENT_QUEUE}'`);
    expect(migration).toContain("max_attempts");
  });
});
