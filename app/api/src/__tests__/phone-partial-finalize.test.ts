/**
 * 0072 — server-side partial-finalize on a non-terminal-ending phone call.
 *
 * The owner's hard requirement is that on EVERY non-terminal-ending phone
 * session (candidate hangup, network drop, worker crash) BOTH the MP3 and the
 * scorecard ALWAYS come through, guaranteed INDEPENDENTLY. This suite proves
 * the TS half of that:
 *
 *   1. The `phone-partial-finalize` loop selects ended-but-not-terminal
 *      sessions past the SHORT reconnect grace and, for each, enqueues PARTIAL
 *      scoring carrying `partial:true` + coverage + disconnect_reason.
 *   2. The transition to `completed` (which fires the 0038 MP3 promotion) is
 *      driven inside the RPC; the enqueue happens INDEPENDENTLY of whether the
 *      transition landed on this pass (a session reported `transitioned:false`
 *      is still enqueued).
 *   3. A session still within grace is never returned, so it is never touched.
 *   4. The enqueue is idempotent — every enqueue carries the session-scoped
 *      dedup key, so a re-run cannot double-enqueue.
 *   5. The scorer plumbing (`createPhoneAssessmentHandler`) forwards the
 *      partial fields into `runAssessment`, and a clean-hangup job (no partial
 *      fields) scores as a COMPLETE screening.
 *
 * The RPC itself (selection predicate, the in-transaction transition that fires
 * the 0038 trigger) is exercised by the SQL assertion pair under
 * app/supabase/tests/, which needs a live Postgres. Here the store is a fake
 * whose returned sessions stand in for the RPC's selection.
 */

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { createPhoneRuntime, type PhoneRuntimeHandle } from '../lib/phone-runtime/runtime.js';
import {
  clearPhoneRuntimeRegistration,
  clearPhoneRuntimeStartFailure,
} from '../lib/phone-runtime/health.js';
import { loadPhoneScreeningConfig } from '../lib/phone-screening/index.js';
import type { PhoneScreeningConfig } from '../lib/phone-screening/index.js';
import type { PhoneStores, PhonePartialFinalizeSession } from '../lib/phone-screening/ports.js';
import type { PhoneRuntimeConfig } from '../lib/phone-runtime/config.js';
import { phoneAssessmentDedupKey } from '../lib/phone-runtime/config.js';
import { createPhoneAssessmentHandler } from '../lib/phone-runtime/assessment-handler.js';
import type { Queue } from '../lib/queue/index.js';

const SESSION_A = '11111111-1111-4111-a111-111111111111';
const SESSION_B = '22222222-2222-4222-a222-222222222222';
const ATTEMPT_A = 'aaaaaaaa-aaaa-4aaa-aaaa-aaaaaaaaaaaa';
const ATTEMPT_B = 'bbbbbbbb-bbbb-4bbb-bbbb-bbbbbbbbbbbb';

interface EnqueueCall {
  readonly name: string;
  readonly payload: unknown;
  readonly options: { dedupKey?: string; maxAttempts?: number } | undefined;
}

function screeningConfig(): PhoneScreeningConfig {
  return {
    ...loadPhoneScreeningConfig({} as NodeJS.ProcessEnv),
    screeningEnabled: true,
    runtimeEnabled: true,
    dialMode: 'synthetic',
  };
}

function runtimeConfig(over: Partial<PhoneRuntimeConfig> = {}): PhoneRuntimeConfig {
  return {
    dueMs: 60_000,
    reclaimMs: 60_000,
    reconcileMs: 60_000,
    // Fast expire so the partial-finalize loop (on the EXPIRE cadence) runs.
    expireMs: 1_000,
    dueLimit: 3,
    reclaimLimit: 25,
    jobLeaseSeconds: 60,
    partialFinalizeGraceSec: 180,
    ...over,
  };
}

/**
 * A store whose only meaningful method is `finalizePartialSessions`. Every
 * OTHER method the runtime's loops reach is stubbed to a harmless `ok`, so the
 * scheduler can run without any loop throwing. `claimSweep` grants every claim
 * (single test replica), so the sweep always runs.
 */
function makeStores(opts: {
  onFinalize: (input: { graceSeconds?: number; limit?: number }) => {
    status: 'ok';
    finalized: number;
    sessions: PhonePartialFinalizeSession[];
  };
}): PhoneStores {
  return {
    async backlog() {
      return { status: 'ok', admission: { controlPresent: true, halted: false, haltReason: null } };
    },
    async reclaimAttemptLeases() { return { status: 'ok', reclaimed: 0 }; },
    async expireAppointments() { return { status: 'ok', expired: 0 }; },
    async claimSweep() { return { status: 'ok' as const }; },
    async sweepDayRolled() {
      return { status: 'ok' as const, examined: 0, rolled: 0, skipped: 0 };
    },
    async sweepStrandedSessions() {
      return { status: 'ok' as const, examined: 0, completed: 0, failed: 0, skipped: 0 };
    },
    async sweepStrandedRecordings() {
      return { status: 'ok' as const, examined: 0, finalized: 0, skipped: 0 };
    },
    async finalizePartialSessions(input: { limit?: number; graceSeconds?: number; now: Date }) {
      const r = opts.onFinalize(input);
      return { status: r.status, examined: r.sessions.length, finalized: r.finalized, skipped: 0, sessions: r.sessions };
    },
  } as unknown as PhoneStores;
}

function makeReader() {
  return {
    async listDueEngagements() { return []; },
    async listDialableNumbers() { return new Map(); },
    async findReusableSession() { return null; },
    async countLiveEngagements() { return 1; },
    async engagementOwningSession() { return null; },
    async readSessionForReuse() { return null; },
    consent: {
      async latestConsentRecord() { return null; },
      async activeConsentTemplate() { return null; },
    },
  } as never;
}

/** A queue that records every enqueue; never claims a job. */
function makeQueue(calls: EnqueueCall[]): Queue {
  return {
    async enqueue(name: string, payload: unknown, options?: { dedupKey?: string; maxAttempts?: number }) {
      calls.push({ name, payload, options });
      return { id: 'job', name, payload } as never;
    },
    async claim() { return null; },
    async completeClaim() { return true; },
    async failClaim() { return 'failed'; },
    async heartbeat() { return true; },
    async deferClaim() { return 'deferred'; },
  } as unknown as Queue;
}

const live: PhoneRuntimeHandle[] = [];

function buildRuntime(opts: {
  stores: PhoneStores;
  queue: Queue;
  config?: Partial<PhoneRuntimeConfig>;
}): PhoneRuntimeHandle {
  const handle = createPhoneRuntime({
    config: screeningConfig(),
    runtimeConfig: runtimeConfig(opts.config),
    client: {} as never,
    queue: opts.queue,
    stores: opts.stores,
    reader: makeReader(),
    owner: 'phone-partial-test',
    scheduler: { random: () => 0.5 },
  });
  expect(handle).not.toBeNull();
  live.push(handle!);
  return handle!;
}

async function drainMicrotasks(pred: () => boolean, turns = 500): Promise<void> {
  for (let i = 0; i < turns && !pred(); i++) await Promise.resolve();
}

beforeEach(() => {
  vi.useFakeTimers();
  vi.setSystemTime(new Date('2026-08-24T06:00:00.000Z'));
});

afterEach(async () => {
  clearPhoneRuntimeRegistration();
  clearPhoneRuntimeStartFailure();
  while (live.length > 0) {
    const h = live.pop()!;
    await h.stop();
  }
  vi.useRealTimers();
});

function partialSession(over: Partial<PhonePartialFinalizeSession> = {}): PhonePartialFinalizeSession {
  return {
    sessionId: SESSION_A,
    attemptId: ATTEMPT_A,
    covered: 3,
    total: 5,
    disconnectReason: 'candidate_hangup',
    transitioned: true,
    assessmentPresent: false,
    recordingPresent: false,
    ...over,
  };
}

describe('the partial-finalize tick delivers the scorecard on a disconnect', () => {
  it('a stranded-disconnected session is enqueued for PARTIAL scoring', async () => {
    const enqueues: EnqueueCall[] = [];
    const stores = makeStores({
      onFinalize: () => ({ status: 'ok', finalized: 1, sessions: [partialSession()] }),
    });
    const runtime = buildRuntime({ stores, queue: makeQueue(enqueues) });
    runtime.scheduler.start();
    await vi.advanceTimersByTimeAsync(1_000);
    await drainMicrotasks(() => enqueues.length > 0);

    expect(enqueues).toHaveLength(1);
    expect(enqueues[0].name).toBe('phone.assessment');
    expect(enqueues[0].payload).toEqual({
      session_id: SESSION_A,
      attempt_id: ATTEMPT_A,
      partial: true,
      covered: 3,
      total: 5,
      disconnect_reason: 'candidate_hangup',
    });
    // The session-scoped dedup key is what makes the enqueue idempotent.
    expect(enqueues[0].options?.dedupKey).toBe(phoneAssessmentDedupKey(SESSION_A));
    expect(enqueues[0].options?.maxAttempts).toBe(5);
    // The snapshot reports the finalize count for the health surface.
    expect(runtime.snapshot().lastPartialFinalized).toBe(1);
  });

  it('the configured grace is passed to the selector (must be far below 0071 7200s)', async () => {
    const seen: number[] = [];
    const stores = makeStores({
      onFinalize: (input) => {
        if (typeof input.graceSeconds === 'number') seen.push(input.graceSeconds);
        return { status: 'ok', finalized: 0, sessions: [] };
      },
    });
    const runtime = buildRuntime({ stores, queue: makeQueue([]), config: { partialFinalizeGraceSec: 120 } });
    runtime.scheduler.start();
    await vi.advanceTimersByTimeAsync(1_000);
    await drainMicrotasks(() => seen.length > 0);

    expect(seen[0]).toBe(120);
    expect(seen[0]).toBeLessThan(7_200);
  });

  it('a session within grace is not returned, so nothing is enqueued', async () => {
    // The selector returns no rows for a session still inside the reconnect
    // grace. The loop must then enqueue nothing and touch nothing.
    const enqueues: EnqueueCall[] = [];
    const stores = makeStores({
      onFinalize: () => ({ status: 'ok', finalized: 0, sessions: [] }),
    });
    const runtime = buildRuntime({ stores, queue: makeQueue(enqueues) });
    runtime.scheduler.start();
    await vi.advanceTimersByTimeAsync(1_000);
    await drainMicrotasks(() => false, 50);

    expect(enqueues).toHaveLength(0);
    expect(runtime.snapshot().lastPartialFinalized).toBe(0);
  });

  it('scoring is enqueued even when the transition did NOT land this pass (independence)', async () => {
    // The RPC reports a selected session whose transition was skipped this pass
    // (already terminal, or lost the row lock). The MP3 promotion is the RPC's
    // job; the scorecard is THIS loop's job, and it must still enqueue so the
    // two guarantees hold independently.
    const enqueues: EnqueueCall[] = [];
    const stores = makeStores({
      onFinalize: () => ({
        status: 'ok',
        finalized: 0,
        sessions: [partialSession({ transitioned: false, disconnectReason: 'disconnected' })],
      }),
    });
    const runtime = buildRuntime({ stores, queue: makeQueue(enqueues) });
    runtime.scheduler.start();
    await vi.advanceTimersByTimeAsync(1_000);
    await drainMicrotasks(() => enqueues.length > 0);

    expect(enqueues).toHaveLength(1);
    expect((enqueues[0].payload as { partial: boolean }).partial).toBe(true);
    expect((enqueues[0].payload as { disconnect_reason: string }).disconnect_reason).toBe('disconnected');
  });

  it('one session enqueue failing never denies another its scorecard', async () => {
    // Two selected sessions; the queue throws on the FIRST. The loop must still
    // enqueue the second — a per-session try/catch, not an all-or-nothing pass.
    const seen: string[] = [];
    let first = true;
    const queue = {
      async enqueue(name: string, payload: unknown, options?: { dedupKey?: string }) {
        if (first) { first = false; throw new Error('enqueue_boom'); }
        seen.push((payload as { session_id: string }).session_id);
        return { id: 'job', name, payload, options } as never;
      },
      async claim() { return null; },
      async completeClaim() { return true; },
      async failClaim() { return 'failed'; },
      async heartbeat() { return true; },
      async deferClaim() { return 'deferred'; },
    } as unknown as Queue;
    const stores = makeStores({
      onFinalize: () => ({
        status: 'ok',
        finalized: 2,
        sessions: [
          partialSession({ sessionId: SESSION_A, attemptId: ATTEMPT_A }),
          partialSession({ sessionId: SESSION_B, attemptId: ATTEMPT_B }),
        ],
      }),
    });
    const runtime = buildRuntime({ stores, queue });
    runtime.scheduler.start();
    await vi.advanceTimersByTimeAsync(1_000);
    await drainMicrotasks(() => seen.length > 0);

    // The second session was still enqueued despite the first throwing.
    expect(seen).toContain(SESSION_B);
  });

  it('re-running does not double-enqueue: every enqueue carries the same dedup key', async () => {
    // The loop is idempotent per session — the queue dedup key deduplicates.
    // Two passes over the same still-selected session both enqueue under the
    // SAME key, so the durable queue admits exactly one.
    const enqueues: EnqueueCall[] = [];
    const stores = makeStores({
      onFinalize: () => ({
        status: 'ok',
        finalized: 1,
        // Second pass: the session already has an assessment; still returned so
        // the loop is safe to re-run, and the dedup key keeps it a no-op.
        sessions: [partialSession({ assessmentPresent: true })],
      }),
    });
    const runtime = buildRuntime({ stores, queue: makeQueue(enqueues) });
    runtime.scheduler.start();
    // Two expire ticks.
    await vi.advanceTimersByTimeAsync(2_100);
    await drainMicrotasks(() => enqueues.length >= 2);

    expect(enqueues.length).toBeGreaterThanOrEqual(1);
    for (const call of enqueues) {
      expect(call.options?.dedupKey).toBe(phoneAssessmentDedupKey(SESSION_A));
    }
  });
});

describe('the scorer plumbing forwards the partial fields', () => {
  it('a partial job scores with partial:true + coverage + disconnect_reason', async () => {
    const seen: Array<{ sessionId: string; options: unknown }> = [];
    const client = {
      async rpc() { return { data: { status: 'applied' }, error: null }; },
    } as never;
    const handler = createPhoneAssessmentHandler({
      client,
      score: async (sessionId, options) => { seen.push({ sessionId, options }); },
    });
    await handler({
      payload: {
        session_id: SESSION_A,
        attempt_id: ATTEMPT_A,
        partial: true,
        covered: 3,
        total: 5,
        disconnect_reason: 'candidate_hangup',
      },
    } as never);

    expect(seen).toHaveLength(1);
    expect(seen[0].sessionId).toBe(SESSION_A);
    expect(seen[0].options).toEqual({
      source: 'phone',
      partial: true,
      covered: 3,
      total: 5,
      disconnectReason: 'candidate_hangup',
    });
  });

  it('a clean-hangup job (no partial fields) scores as a COMPLETE screening', async () => {
    const seen: Array<{ options: unknown }> = [];
    const client = {
      async rpc() { return { data: { status: 'applied' }, error: null }; },
    } as never;
    const handler = createPhoneAssessmentHandler({
      client,
      score: async (_sessionId, options) => { seen.push({ options }); },
    });
    await handler({
      payload: { session_id: SESSION_A, attempt_id: ATTEMPT_A },
    } as never);

    expect(seen).toHaveLength(1);
    expect(seen[0].options).toEqual({
      source: 'phone',
      partial: false,
      covered: null,
      total: null,
      disconnectReason: undefined,
    });
  });
});
