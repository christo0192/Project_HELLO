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
import {
  boundedCount,
  createPhoneRuntime,
  type PhoneRuntimeHandle,
} from '../lib/phone-runtime/runtime.js';
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
import { sanitizeErrorCode } from '../lib/queue/runner.js';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

const SESSION_A = '11111111-1111-4111-a111-111111111111';
const SESSION_B = '22222222-2222-4222-a222-222222222222';
const ATTEMPT_A = 'aaaaaaaa-aaaa-4aaa-aaaa-aaaaaaaaaaaa';
const ATTEMPT_B = 'bbbbbbbb-bbbb-4bbb-bbbb-bbbbbbbbbbbb';
const SESSION_C = '33333333-3333-4333-a333-333333333333';
const ATTEMPT_C = 'cccccccc-cccc-4ccc-accc-cccccccccccc';
const ENGAGEMENT_A = 'eeeeeeee-eeee-4eee-aeee-eeeeeeeeeeee';

interface EnqueueCall {
  readonly name: string;
  readonly payload: unknown;
  readonly options: { dedupKey?: string; maxAttempts?: number } | undefined;
}

/** Every `apply_phone_event` the tick posts, in order. */
interface EventCall {
  readonly eventType: string;
  readonly engagementId: string | null | undefined;
  readonly attemptId: string | null | undefined;
  readonly providerEventId: string | null | undefined;
  readonly source: string;
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
  /** 0095 — collects every engagement event the tick posts. */
  events?: EventCall[];
  /** 0095 — make `applyEvent` throw, to pin the best-effort contract. */
  applyEventThrows?: boolean;
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
    async sweepSameDayRetry() {
      return { status: 'ok' as const, examined: 0, released: 0, skipped: 0 };
    },
    async applyEvent(input: {
      source: string;
      eventType: string;
      engagementId?: string | null;
      attemptId?: string | null;
      providerEventId?: string | null;
    }) {
      if (opts.applyEventThrows) throw new Error('apply_event_boom');
      opts.events?.push({
        eventType: input.eventType,
        engagementId: input.engagementId,
        attemptId: input.attemptId,
        providerEventId: input.providerEventId,
        source: input.source,
      });
      return { status: 'applied' as const, applied: true };
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
    engagementId: ENGAGEMENT_A,
    // The DEFAULT is a call that really was screened — `neverStarted` is the
    // exception, and every pre-0095 test in this file asserts the behaviour
    // that must survive it unchanged.
    neverStarted: false,
    covered: 3,
    total: 5,
    disconnectReason: 'candidate_hangup',
    transitioned: true,
    assessmentPresent: false,
    recordingPresent: false,
    // 0113 (E4): the default is an ordinary partial, not a callback leg.
    callbackBooked: false,
    // 0114 (C2): the default is a leg the suppression function lets score.
    scoreSuppressed: false,
    suppressReason: null,
    ...over,
  };
}

/** Every `phone_partial_finalize:*` category the runtime logged to stdout. */
function partialFinalizeCategories(spy: { mock: { calls: unknown[][] } }): string[] {
  const out: string[] = [];
  for (const [chunk] of spy.mock.calls) {
    const line = String(chunk);
    const m = /"error_category":"(phone_partial_finalize:[^"]*)"/.exec(line);
    if (m) out.push(m[1]);
  }
  return out;
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

  // ─────────────────────────────────────────────────────────────────────
  // 0095 / issue #286 — a call that never reached a question
  // ─────────────────────────────────────────────────────────────────────
  //
  // The RPC now REPORTS `never_started` (no non-gate transcript turn from the
  // candidate). Nothing branches on it, and these tests exist to keep it that
  // way.
  //
  // A draft skipped the scoring enqueue for such sessions and drove them to a
  // different terminal status. Three adversarial reviews and the repo's own
  // `phone_partial_finalize_assert.sql` all rejected it: the sweep re-selects a
  // session until an assessment row exists, so skipping the enqueue made those
  // rows permanent residents of a 25-row oldest-first window and starved real
  // partial screenings out of it; and the crash-partial pair IS admitted by the
  // scoring gate, so a class that was scored silently stopped being scored.

  it('a never-started session is STILL enqueued for scoring', async () => {
    const enqueues: EnqueueCall[] = [];
    const stores = makeStores({
      onFinalize: () => ({
        status: 'ok',
        finalized: 1,
        sessions: [partialSession({ neverStarted: true, covered: 0 })],
      }),
    });
    const runtime = buildRuntime({ stores, queue: makeQueue(enqueues) });
    runtime.scheduler.start();
    await vi.advanceTimersByTimeAsync(1_000);
    await drainMicrotasks(() => enqueues.length > 0);

    // The enqueue is what lets the session LEAVE the sweep's selection set:
    // the RPC re-selects it until an assessment row exists. Withholding it
    // does not merely skip a scorecard, it wedges the sweep.
    expect(enqueues).toHaveLength(1);
    expect(enqueues[0].payload).toMatchObject({
      session_id: SESSION_A,
      partial: true,
    });
  });

  it('never-started and normal sessions are treated IDENTICALLY by the tick', async () => {
    // The strongest form of "nothing branches on it": drive both shapes and
    // assert the tick cannot tell them apart. A future `if (s.neverStarted)`
    // anywhere in this loop body fails here.
    const neverStarted: EnqueueCall[] = [];
    const normal: EnqueueCall[] = [];

    const runOne = async (flag: boolean, sink: EnqueueCall[]) => {
      const stores = makeStores({
        onFinalize: () => ({
          status: 'ok',
          finalized: 1,
          sessions: [partialSession({ neverStarted: flag })],
        }),
      });
      const runtime = buildRuntime({ stores, queue: makeQueue(sink) });
      runtime.scheduler.start();
      await vi.advanceTimersByTimeAsync(1_000);
      await drainMicrotasks(() => sink.length > 0);
    };

    await runOne(true, neverStarted);
    await runOne(false, normal);

    // Length is not asserted: the first runtime keeps ticking on its 1s
    // cadence while the second runs, so both sinks accumulate. What matters is
    // that BOTH produced an enqueue and the FIRST of each is identical.
    expect(neverStarted.length).toBeGreaterThan(0);
    expect(normal.length).toBeGreaterThan(0);
    expect(neverStarted[0].payload).toEqual(normal[0].payload);
    expect(neverStarted[0].options?.dedupKey).toEqual(normal[0].options?.dedupKey);
  });

  it('the tick posts NO engagement event — the release path was removed', async () => {
    // Edge #31 and `screening.not_started` are gone. The engagement is
    // permanently bound to its session (`start_phone_assessment` is the only
    // writer of `phone_engagements.session_id` in 95 migrations and nothing
    // clears it), so a release could never produce a screenable redial — it
    // only handed the engagement to the stranded sweep, which terminally
    // failed it.
    const events: EventCall[] = [];
    const enqueues: EnqueueCall[] = [];
    const stores = makeStores({
      onFinalize: () => ({
        status: 'ok',
        finalized: 1,
        sessions: [partialSession({ neverStarted: true })],
      }),
      events,
    });
    const runtime = buildRuntime({ stores, queue: makeQueue(enqueues) });
    runtime.scheduler.start();
    await vi.advanceTimersByTimeAsync(1_000);
    // Wait on the ENQUEUE, so the absence below is asserted against a tick
    // that demonstrably reached the end of its loop body.
    await drainMicrotasks(() => enqueues.length > 0);

    expect(events).toHaveLength(0);
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

  it('REPAIR A: a WORKER-CRASH residue (expired/grace_timeout, transitioned=false) is enqueued for scoring', async () => {
    // 0071's reclaim already drove the crashed session terminal
    // (expired/grace_timeout) and finalized its MP3, but never enqueued scoring.
    // 0072 now ALSO selects that residue and returns it with transitioned=false
    // and disconnect_reason='worker_crash'; the tick must still enqueue its
    // scorecard — otherwise a crashed call gets an MP3 and no scorecard.
    const enqueues: EnqueueCall[] = [];
    const stores = makeStores({
      onFinalize: () => ({
        status: 'ok',
        // The RPC transitions nothing on this pass (the session was already
        // terminal), so finalized=0 — but the session is still RETURNED.
        finalized: 0,
        sessions: [
          partialSession({
            transitioned: false,
            disconnectReason: 'worker_crash',
            recordingPresent: true, // MP3 already finalized by reclaim.
          }),
        ],
      }),
    });
    const runtime = buildRuntime({ stores, queue: makeQueue(enqueues) });
    runtime.scheduler.start();
    await vi.advanceTimersByTimeAsync(1_000);
    await drainMicrotasks(() => enqueues.length > 0);

    expect(enqueues).toHaveLength(1);
    expect(enqueues[0].name).toBe('phone.assessment');
    expect((enqueues[0].payload as { partial: boolean }).partial).toBe(true);
    expect((enqueues[0].payload as { disconnect_reason: string }).disconnect_reason).toBe('worker_crash');
    expect(enqueues[0].options?.dedupKey).toBe(phoneAssessmentDedupKey(SESSION_A));
  });

  it('0115 §4: an unobserved_disconnect is enqueued like any partial and logged as its own error_type', async () => {
    // The RPC now reports a reclaimed leg WITH teardown evidence as
    // `unobserved_disconnect` instead of `worker_crash`. The tick forwards the
    // token verbatim (the grade decides what it means) and the log line keeps
    // the two countable apart.
    const write = vi.spyOn(process.stdout, 'write').mockImplementation(() => true);
    try {
      const enqueues: EnqueueCall[] = [];
      const stores = makeStores({
        onFinalize: () => ({
          status: 'ok',
          finalized: 1,
          sessions: [partialSession({ disconnectReason: 'unobserved_disconnect', covered: 0, neverStarted: true })],
        }),
      });
      const runtime = buildRuntime({ stores, queue: makeQueue(enqueues) });
      runtime.scheduler.start();
      await vi.advanceTimersByTimeAsync(1_000);
      await drainMicrotasks(() => enqueues.length > 0 && partialFinalizeCategories(write).length > 0);

      expect(enqueues).toHaveLength(1);
      expect(enqueues[0].payload).toEqual({
        session_id: SESSION_A,
        attempt_id: ATTEMPT_A,
        partial: true,
        covered: 0,
        total: 5,
        disconnect_reason: 'unobserved_disconnect',
      });
      const types: string[] = [];
      for (const [chunk] of write.mock.calls) {
        const line = String(chunk);
        if (!line.includes('"error_category":"phone_partial_finalize:')) continue;
        const m = /"error_type":"([^"]*)"/.exec(line);
        if (m) types.push(m[1]);
      }
      expect(types[0]).toBe('unobserved_disconnect');
    } finally {
      write.mockRestore();
    }
  });

  it('REPAIR A: a session that already carries an assessment is NOT re-selected, so nothing is enqueued', async () => {
    // The RPC self-terminates on the `not exists (phone assessment)` guard: once
    // the scorecard has landed the session is never returned again. The tick can
    // only enqueue what the RPC returns, so an empty selection enqueues nothing.
    const enqueues: EnqueueCall[] = [];
    const stores = makeStores({
      onFinalize: () => ({ status: 'ok', finalized: 0, sessions: [] }),
    });
    const runtime = buildRuntime({ stores, queue: makeQueue(enqueues) });
    runtime.scheduler.start();
    await vi.advanceTimersByTimeAsync(1_000);
    await drainMicrotasks(() => false, 50);

    expect(enqueues).toHaveLength(0);
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

  // ─────────────────────────────────────────────────────────────────────
  // 0113 (E4) — a leg that ended in a CONFIRMED callback is not a screening
  // ─────────────────────────────────────────────────────────────────────
  //
  // The RPC reports `callback_booked` by an exact
  // `phone_appointments.confirmed_from_attempt_id` match. Such a leg is still
  // finalized (MP3 kept) but must never be queued for scoring: scoring it
  // published a provisional reject to Ashby and terminated an engagement that
  // had to stay `scheduled` for the callback slot.

  it('E4: a callbackBooked session is NOT enqueued and is logged with cb.1', async () => {
    const write = vi.spyOn(process.stdout, 'write').mockImplementation(() => true);
    try {
      const enqueues: EnqueueCall[] = [];
      let passes = 0;
      const stores = makeStores({
        onFinalize: () => {
          passes += 1;
          return {
            status: 'ok',
            finalized: 1,
            sessions: [partialSession({ callbackBooked: true, covered: 2 })],
          };
        },
      });
      const runtime = buildRuntime({ stores, queue: makeQueue(enqueues) });
      runtime.scheduler.start();
      await vi.advanceTimersByTimeAsync(1_000);
      await drainMicrotasks(() => partialFinalizeCategories(write).length > 0);

      expect(passes).toBeGreaterThan(0);
      expect(enqueues).toHaveLength(0);
      const cats = partialFinalizeCategories(write);
      expect(cats.length).toBeGreaterThan(0);
      expect(cats[0]).toBe('phone_partial_finalize:c2:t5:mp3.0:sc.0:ns.0:cb.1:ss.0');
      // The finalize count is still reported: the RPC DID finalize the leg.
      expect(runtime.snapshot().lastPartialFinalized).toBe(1);
    } finally {
      write.mockRestore();
    }
  });

  it('E4: callbackBooked=false and neverStarted=true are still enqueued (cb.0)', async () => {
    const write = vi.spyOn(process.stdout, 'write').mockImplementation(() => true);
    try {
      const enqueues: EnqueueCall[] = [];
      const stores = makeStores({
        onFinalize: () => ({
          status: 'ok',
          finalized: 3,
          sessions: [
            partialSession({ sessionId: SESSION_A, attemptId: ATTEMPT_A, callbackBooked: false }),
            partialSession({
              sessionId: SESSION_B, attemptId: ATTEMPT_B, neverStarted: true, covered: 0,
            }),
            partialSession({
              sessionId: SESSION_C, attemptId: ATTEMPT_C, callbackBooked: true,
            }),
          ],
        }),
      });
      const runtime = buildRuntime({ stores, queue: makeQueue(enqueues) });
      runtime.scheduler.start();
      await vi.advanceTimersByTimeAsync(1_000);
      await drainMicrotasks(
        () => enqueues.length >= 2 && partialFinalizeCategories(write).length >= 3,
      );

      const firstPass = enqueues.slice(0, 2)
        .map((e) => (e.payload as { session_id: string }).session_id);
      expect(firstPass).toEqual([SESSION_A, SESSION_B]);
      // The callback leg never reaches the queue, on any pass.
      expect(enqueues.some((e) => (e.payload as { session_id: string }).session_id === SESSION_C))
        .toBe(false);
      const cats = partialFinalizeCategories(write).slice(0, 3);
      expect(cats[0].endsWith(':ns.0:cb.0:ss.0')).toBe(true);
      expect(cats[1].endsWith(':ns.1:cb.0:ss.0')).toBe(true);
      expect(cats[2].endsWith(':ns.0:cb.1:ss.0')).toBe(true);
    } finally {
      write.mockRestore();
    }
  });

  it('E4: one enqueue failure does not abort the loop, with a callback leg in the batch', async () => {
    const seen: string[] = [];
    let first = true;
    const queue = {
      async enqueue(name: string, payload: unknown) {
        if (first) { first = false; throw new Error('enqueue_boom'); }
        seen.push((payload as { session_id: string }).session_id);
        return { id: 'job', name, payload } as never;
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
        finalized: 3,
        sessions: [
          partialSession({ sessionId: SESSION_A, attemptId: ATTEMPT_A }),
          partialSession({ sessionId: SESSION_C, attemptId: ATTEMPT_C, callbackBooked: true }),
          partialSession({ sessionId: SESSION_B, attemptId: ATTEMPT_B }),
        ],
      }),
    });
    const runtime = buildRuntime({ stores, queue });
    runtime.scheduler.start();
    await vi.advanceTimersByTimeAsync(1_000);
    await drainMicrotasks(() => seen.length > 0);

    expect(seen).toContain(SESSION_B);
    expect(seen).not.toContain(SESSION_C);
  });

  it('E4: the worst-case composite tag stays a valid SAFE_IDENT (<= 64 chars)', () => {
    // Mirrors the runtime's template; pins the bound the cb suffix must keep.
    const worst = 'phone_partial_finalize:c-1:t-1:mp3.1:sc.1:ns.1:cb.1';
    expect(worst.length).toBeLessThanOrEqual(64);
    expect(/^[a-zA-Z0-9_:.-]{1,64}$/.test(worst)).toBe(true);
  });

  // ─────────────────────────────────────────────────────────────────────
  // 0114 (C2) — every score-suppressed leg is finalized but never queued
  // ─────────────────────────────────────────────────────────────────────

  it.each(['callback_booked', 'callback_deferred', 'worker_aborted'] as const)(
    'C2: a scoreSuppressed (%s) session is NOT enqueued and is logged with ss.1',
    async (reason) => {
      const write = vi.spyOn(process.stdout, 'write').mockImplementation(() => true);
      try {
        const enqueues: EnqueueCall[] = [];
        const stores = makeStores({
          onFinalize: () => ({
            status: 'ok',
            finalized: 1,
            sessions: [partialSession({
              covered: 2,
              callbackBooked: reason === 'callback_booked',
              scoreSuppressed: true,
              suppressReason: reason,
            })],
          }),
        });
        const runtime = buildRuntime({ stores, queue: makeQueue(enqueues) });
        runtime.scheduler.start();
        await vi.advanceTimersByTimeAsync(1_000);
        await drainMicrotasks(() => partialFinalizeCategories(write).length > 0);

        expect(enqueues).toHaveLength(0);
        const cats = partialFinalizeCategories(write);
        const cb = reason === 'callback_booked' ? 1 : 0;
        expect(cats[0]).toBe(`phone_partial_finalize:c2:t5:mp3.0:sc.0:ns.0:cb.${cb}:ss.1`);
        // The reason itself never reaches the log line: the tag stays bounded.
        expect(cats[0]).not.toContain(reason);
        // The RPC DID finalize the leg (the MP3 is kept); only scoring is withheld.
        expect(runtime.snapshot().lastPartialFinalized).toBe(1);
      } finally {
        write.mockRestore();
      }
    },
  );

  it('C2: suppressed and ordinary legs in one batch — only the ordinary one is queued', async () => {
    const enqueues: EnqueueCall[] = [];
    const stores = makeStores({
      onFinalize: () => ({
        status: 'ok',
        finalized: 3,
        sessions: [
          partialSession({ sessionId: SESSION_A, attemptId: ATTEMPT_A }),
          partialSession({
            sessionId: SESSION_C, attemptId: ATTEMPT_C,
            scoreSuppressed: true, suppressReason: 'worker_aborted',
          }),
          partialSession({
            sessionId: SESSION_B, attemptId: ATTEMPT_B,
            scoreSuppressed: true, suppressReason: 'callback_deferred',
          }),
        ],
      }),
    });
    const runtime = buildRuntime({ stores, queue: makeQueue(enqueues) });
    runtime.scheduler.start();
    await vi.advanceTimersByTimeAsync(1_000);
    await drainMicrotasks(() => enqueues.length > 0);

    const queued = new Set(enqueues.map((e) => (e.payload as { session_id: string }).session_id));
    expect(queued).toEqual(new Set([SESSION_A]));
  });

  it('C2: a suppressed flag with NO reason still skips — the boolean governs', async () => {
    const enqueues: EnqueueCall[] = [];
    let passes = 0;
    const stores = makeStores({
      onFinalize: () => {
        passes += 1;
        return {
          status: 'ok',
          finalized: 1,
          sessions: [partialSession({ scoreSuppressed: true, suppressReason: null })],
        };
      },
    });
    const runtime = buildRuntime({ stores, queue: makeQueue(enqueues) });
    runtime.scheduler.start();
    await vi.advanceTimersByTimeAsync(1_000);
    await drainMicrotasks(() => passes > 0);
    expect(passes).toBeGreaterThan(0);
    expect(enqueues).toHaveLength(0);
  });

  it('C2: the worst-case composite tag stays a valid SAFE_IDENT (<= 64 chars)', () => {
    // Coverage is clamped to [-1, 999] by boundedCount, so this IS the worst case.
    const worst = 'phone_partial_finalize:c999:t999:mp3.1:sc.1:ns.1:cb.1:ss.1';
    expect(worst.length).toBeLessThanOrEqual(64);
    expect(/^[a-zA-Z0-9_:.-]{1,64}$/.test(worst)).toBe(true);
    expect(boundedCount(null)).toBe(-1);
    expect(boundedCount(-5)).toBe(-1);
    expect(boundedCount(Number.NaN)).toBe(-1);
    expect(boundedCount(3)).toBe(3);
    expect(boundedCount(2.7)).toBe(2);
    expect(boundedCount(123_456)).toBe(999);
  });

  it('C2: a huge coverage figure cannot push the tag past the logger cap', async () => {
    const write = vi.spyOn(process.stdout, 'write').mockImplementation(() => true);
    try {
      const stores = makeStores({
        onFinalize: () => ({
          status: 'ok',
          finalized: 1,
          sessions: [partialSession({
            covered: 1_000_000, total: 2_000_000,
            recordingPresent: true, assessmentPresent: true, neverStarted: true,
            callbackBooked: true, scoreSuppressed: true, suppressReason: 'callback_booked',
          })],
        }),
      });
      const runtime = buildRuntime({ stores, queue: makeQueue([]) });
      runtime.scheduler.start();
      await vi.advanceTimersByTimeAsync(1_000);
      await drainMicrotasks(() => partialFinalizeCategories(write).length > 0);
      expect(partialFinalizeCategories(write)[0])
        .toBe('phone_partial_finalize:c999:t999:mp3.1:sc.1:ns.1:cb.1:ss.1');
    } finally {
      write.mockRestore();
    }
  });
});

/**
 * A Supabase-client double that records every `apply_phone_event` rpc call and
 * answers `from(...).select(...).eq(...).maybeSingle()` for the two lookups the
 * partial completion path performs: the attempt's engagement id and whether a
 * phone assessment row exists. `engagementId`/`assessmentExists` are configurable
 * per test; `rpcResult` lets a test force a not-applied status.
 */
function makeAssessmentClient(opts: {
  engagementId?: string | null;
  assessmentExists?: boolean;
  rpcResult?: { data: unknown; error: unknown };
  /**
   * 0113 (E4) — the callback-leg guard's `phone_appointments` read. `row`
   * answers a matching confirmed_from_attempt_id; `error` fails the read.
   * Absent: no appointment (an ordinary job).
   */
  callbackAppointment?: 'row' | 'error';
  /**
   * 0114 (C2) — the `phone_attempt_score_suppression` answer. Absent: null
   * (the leg may be scored). `{ error }` fails the RPC.
   */
  suppression?: string | null | { error: unknown };
}): {
  client: unknown;
  /** Every `apply_phone_event` call. The suppression read is kept apart. */
  rpcCalls: Array<Record<string, unknown>>;
  /** Every `phone_attempt_score_suppression` call's arguments, in order. */
  suppressionCalls: Array<Record<string, unknown>>;
  /** Every `phone_appointments` filter the guard applied, as [column, value]. */
  appointmentFilters: Array<[string, unknown]>;
} {
  const rpcCalls: Array<Record<string, unknown>> = [];
  const suppressionCalls: Array<Record<string, unknown>> = [];
  const appointmentFilters: Array<[string, unknown]> = [];
  const client = {
    async rpc(name: string, args: Record<string, unknown>) {
      if (name === 'phone_attempt_score_suppression') {
        suppressionCalls.push(args);
        const answer = opts.suppression;
        if (answer !== null && typeof answer === 'object') {
          return { data: null, error: answer.error };
        }
        return { data: answer ?? null, error: null };
      }
      if (name !== 'apply_phone_event') {
        return { data: null, error: { message: `unexpected rpc ${name}` } };
      }
      rpcCalls.push(args);
      return opts.rpcResult ?? { data: { status: 'applied' }, error: null };
    },
    from(table: string) {
      const builder = {
        select() { return builder; },
        eq(column: string, value: unknown) {
          if (table === 'phone_appointments') appointmentFilters.push([column, value]);
          return builder;
        },
        async maybeSingle() {
          if (table === 'phone_appointments') {
            if (opts.callbackAppointment === 'error') {
              return { data: null, error: { message: 'boom' } };
            }
            return opts.callbackAppointment === 'row'
              ? { data: { id: 'appt-1' }, error: null }
              : { data: null, error: null };
          }
          if (table === 'phone_call_attempts') {
            return opts.engagementId === undefined
              ? { data: null, error: null }
              : { data: { engagement_id: opts.engagementId }, error: null };
          }
          if (table === 'assessments') {
            return { data: opts.assessmentExists ? { id: 'a1' } : null, error: null };
          }
          return { data: null, error: null };
        },
      };
      return builder;
    },
  };
  return { client, rpcCalls, suppressionCalls, appointmentFilters };
}

describe('the scorer plumbing forwards the partial fields', () => {
  it('a partial job scores with partial:true + coverage + disconnect_reason', async () => {
    const seen: Array<{ sessionId: string; options: unknown }> = [];
    const { client } = makeAssessmentClient({ engagementId: ENGAGEMENT_A });
    const handler = createPhoneAssessmentHandler({
      client: client as never,
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

  it('0115: an unobserved_disconnect job scores with that reason, verbatim', async () => {
    const seen: Array<{ options: unknown }> = [];
    const { client } = makeAssessmentClient({ engagementId: ENGAGEMENT_A });
    const handler = createPhoneAssessmentHandler({
      client: client as never,
      score: async (_sessionId, options) => { seen.push({ options }); },
    });
    await handler({
      payload: {
        session_id: SESSION_A, attempt_id: ATTEMPT_A,
        partial: true, covered: 0, total: 5,
        disconnect_reason: 'unobserved_disconnect',
      },
    } as never);
    expect(seen[0].options).toEqual({
      source: 'phone', partial: true, covered: 0, total: 5,
      disconnectReason: 'unobserved_disconnect',
    });
  });

  it('8/8 durable coverage is complete even when the recovery payload said partial', async () => {
    const seen: Array<{ options: unknown }> = [];
    const { client } = makeAssessmentClient({ engagementId: ENGAGEMENT_A });
    const handler = createPhoneAssessmentHandler({
      client: client as never,
      score: async (_sessionId, options) => { seen.push({ options }); },
    });
    await handler({
      payload: {
        session_id: SESSION_A, attempt_id: ATTEMPT_A,
        partial: true, covered: 8, total: 8,
        disconnect_reason: 'candidate_hangup',
      },
    } as never);
    expect(seen[0].options).toEqual({
      source: 'phone', partial: false, covered: 8, total: 8,
      disconnectReason: undefined,
    });
  });

  it('a clean-hangup job (no partial fields) scores as a COMPLETE screening', async () => {
    const seen: Array<{ options: unknown }> = [];
    const { client } = makeAssessmentClient({});
    const handler = createPhoneAssessmentHandler({
      client: client as never,
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

  it('REPAIR B: the PARTIAL completion posts the STRANDED shape (attempt_id null)', async () => {
    // The engagement after a hangup/crash is reconnecting/scheduled, never
    // in_call. An attempt-scoped post matches no branch there; the stranded post
    // (p_attempt_id null, p_engagement_id resolved) is the one that completes it.
    const { client, rpcCalls } = makeAssessmentClient({ engagementId: ENGAGEMENT_A });
    const handler = createPhoneAssessmentHandler({
      client: client as never,
      score: async () => {},
    });
    await handler({
      payload: {
        session_id: SESSION_A,
        attempt_id: ATTEMPT_A,
        partial: true,
        covered: 2,
        total: 3,
        disconnect_reason: 'worker_crash',
      },
    } as never);

    expect(rpcCalls).toHaveLength(1);
    expect(rpcCalls[0].p_event_type).toBe('assessment.completed');
    // The load-bearing assertion: the partial path posts NO attempt id and
    // names the engagement — the stranded shape.
    expect(rpcCalls[0].p_attempt_id).toBeNull();
    expect(rpcCalls[0].p_engagement_id).toBe(ENGAGEMENT_A);
  });

  it('REPAIR B: the CLEAN completion still posts the ATTEMPT shape (unchanged)', async () => {
    // The clean path (engagement still in_call) must keep posting attempt-scoped
    // so 0067's in_call completion branch ends the attempt in the same edge.
    const { client, rpcCalls } = makeAssessmentClient({});
    const handler = createPhoneAssessmentHandler({
      client: client as never,
      score: async () => {},
    });
    await handler({
      payload: { session_id: SESSION_A, attempt_id: ATTEMPT_A },
    } as never);

    expect(rpcCalls).toHaveLength(1);
    expect(rpcCalls[0].p_attempt_id).toBe(ATTEMPT_A);
    expect(rpcCalls[0].p_engagement_id).toBeNull();
  });

  it('REPAIR B: a not-applied completion does NOT throw when the scorecard already landed', async () => {
    // The scorecard is written before the completion posts. If the completion
    // cannot apply (e.g. a redelivery raced the engagement past the stranded
    // states) but a phone assessment row exists, the job must SUCCEED — DLQ'ing a
    // job whose scorecard already landed is the failure this repair removes.
    const { client } = makeAssessmentClient({
      engagementId: ENGAGEMENT_A,
      assessmentExists: true,
      rpcResult: { data: { status: 'unexpected_event' }, error: null },
    });
    const handler = createPhoneAssessmentHandler({
      client: client as never,
      score: async () => {},
    });
    await expect(
      handler({
        payload: {
          session_id: SESSION_A,
          attempt_id: ATTEMPT_A,
          partial: true,
          covered: 2,
          total: 3,
          disconnect_reason: 'worker_crash',
        },
      } as never),
    ).resolves.toBeUndefined();
  });

  it('REPAIR B: a not-applied completion STILL throws when nothing was scored', async () => {
    // The safety valve: a not-applied status with NO assessment row is a genuine
    // anomaly, so the job must still throw and let the bounded retry recover.
    const { client } = makeAssessmentClient({
      engagementId: ENGAGEMENT_A,
      assessmentExists: false,
      rpcResult: { data: { status: 'unexpected_event' }, error: null },
    });
    const handler = createPhoneAssessmentHandler({
      client: client as never,
      score: async () => {},
    });
    await expect(
      handler({
        payload: {
          session_id: SESSION_A,
          attempt_id: ATTEMPT_A,
          partial: true,
          covered: 2,
          total: 3,
          disconnect_reason: 'worker_crash',
        },
      } as never),
    ).rejects.toThrow('phone_assessment_completion_not_applied');
  });
});

describe('0113 (E4) — the handler never scores a confirmed-callback leg', () => {
  const partialPayload = {
    session_id: SESSION_A,
    attempt_id: ATTEMPT_A,
    partial: true,
    covered: 2,
    total: 5,
    disconnect_reason: 'candidate_hangup',
  };

  it('(a) a callback attempt: no score(), no apply_phone_event, and the job resolves', async () => {
    const scored: string[] = [];
    const { client, rpcCalls, appointmentFilters } = makeAssessmentClient({
      engagementId: ENGAGEMENT_A,
      callbackAppointment: 'row',
    });
    const handler = createPhoneAssessmentHandler({
      client: client as never,
      score: async (sessionId) => { scored.push(sessionId); },
    });
    await expect(handler({ payload: partialPayload } as never)).resolves.toBeUndefined();
    expect(scored).toHaveLength(0);
    expect(rpcCalls).toHaveLength(0);
    // EXACT attempt match — no engagement-level fallback, no status filter.
    expect(appointmentFilters).toEqual([['confirmed_from_attempt_id', ATTEMPT_A]]);
  });

  it('(b) an appointment read error throws phone_assessment_callback_check_failed, before scoring', async () => {
    const scored: string[] = [];
    const { client, rpcCalls } = makeAssessmentClient({
      engagementId: ENGAGEMENT_A,
      callbackAppointment: 'error',
    });
    const handler = createPhoneAssessmentHandler({
      client: client as never,
      score: async (sessionId) => { scored.push(sessionId); },
    });
    await expect(handler({ payload: partialPayload } as never))
      .rejects.toThrow('phone_assessment_callback_check_failed');
    expect(scored).toHaveLength(0);
    expect(rpcCalls).toHaveLength(0);
    // The code must survive the queue runner's sanitizer verbatim, or the
    // retry/DLQ row would read `unknown_error`.
    expect(sanitizeErrorCode(new Error('phone_assessment_callback_check_failed')))
      .toBe('phone_assessment_callback_check_failed');
  });

  it('(c) a non-callback partial still scores and posts the STRANDED shape', async () => {
    const scored: string[] = [];
    const { client, rpcCalls } = makeAssessmentClient({ engagementId: ENGAGEMENT_A });
    const handler = createPhoneAssessmentHandler({
      client: client as never,
      score: async (sessionId) => { scored.push(sessionId); },
    });
    await handler({ payload: partialPayload } as never);
    expect(scored).toEqual([SESSION_A]);
    expect(rpcCalls).toHaveLength(1);
    expect(rpcCalls[0].p_attempt_id).toBeNull();
    expect(rpcCalls[0].p_engagement_id).toBe(ENGAGEMENT_A);
  });

  it('(d) a clean job still scores and posts ATTEMPT-scoped', async () => {
    const scored: string[] = [];
    const { client, rpcCalls, appointmentFilters } = makeAssessmentClient({});
    const handler = createPhoneAssessmentHandler({
      client: client as never,
      score: async (sessionId) => { scored.push(sessionId); },
    });
    await handler({ payload: { session_id: SESSION_A, attempt_id: ATTEMPT_A } } as never);
    expect(scored).toEqual([SESSION_A]);
    expect(rpcCalls).toHaveLength(1);
    expect(rpcCalls[0].p_attempt_id).toBe(ATTEMPT_A);
    expect(rpcCalls[0].p_engagement_id).toBeNull();
    // The guard ran for the CLEAN job too — it keys on every job.
    expect(appointmentFilters).toEqual([['confirmed_from_attempt_id', ATTEMPT_A]]);
  });

  it('(e) a FULLY covered (partial=false) callback attempt is also skipped', async () => {
    // payloadPartial reports 5/5 coverage as partial=false, so a guard keyed on
    // `partial` would miss this leg. It keys on the attempt instead.
    const scored: string[] = [];
    const { client, rpcCalls } = makeAssessmentClient({
      engagementId: ENGAGEMENT_A,
      callbackAppointment: 'row',
    });
    const handler = createPhoneAssessmentHandler({
      client: client as never,
      score: async (sessionId) => { scored.push(sessionId); },
    });
    await handler({
      payload: { ...partialPayload, covered: 5, total: 5 },
    } as never);
    expect(scored).toHaveLength(0);
    expect(rpcCalls).toHaveLength(0);
  });

  it('a malformed payload still throws malformed BEFORE the guard reads anything', async () => {
    const { client, appointmentFilters } = makeAssessmentClient({ callbackAppointment: 'row' });
    const handler = createPhoneAssessmentHandler({ client: client as never, score: async () => {} });
    await expect(handler({ payload: { session_id: SESSION_A } } as never))
      .rejects.toThrow('malformed_phone_assessment_payload');
    expect(appointmentFilters).toHaveLength(0);
  });
});

describe('0114 (C2) — the handler never scores a score-suppressed leg', () => {
  const partialPayload = {
    session_id: SESSION_A,
    attempt_id: ATTEMPT_A,
    partial: true,
    covered: 2,
    total: 5,
    disconnect_reason: 'candidate_hangup',
  };

  it.each(['callback_booked', 'callback_deferred', 'worker_aborted'])(
    'a non-null suppression (%s): no score(), no apply_phone_event, and the job resolves',
    async (reason) => {
      const scored: string[] = [];
      const { client, rpcCalls, suppressionCalls } = makeAssessmentClient({
        engagementId: ENGAGEMENT_A,
        suppression: reason,
      });
      const handler = createPhoneAssessmentHandler({
        client: client as never,
        score: async (sessionId) => { scored.push(sessionId); },
      });
      await expect(handler({ payload: partialPayload } as never)).resolves.toBeUndefined();
      expect(scored).toHaveLength(0);
      expect(rpcCalls).toHaveLength(0);
      // Keyed on the job's ATTEMPT, by the RPC's declared parameter name.
      expect(suppressionCalls).toEqual([{ p_attempt_id: ATTEMPT_A }]);
    },
  );

  it('a CLEAN (non-partial) job is suppressed too — the check keys on every job', async () => {
    // A worker-declared abort on a fully-covered leg must not be scored either.
    const scored: string[] = [];
    const { client, rpcCalls } = makeAssessmentClient({ suppression: 'worker_aborted' });
    const handler = createPhoneAssessmentHandler({
      client: client as never,
      score: async (sessionId) => { scored.push(sessionId); },
    });
    await handler({ payload: { session_id: SESSION_A, attempt_id: ATTEMPT_A } } as never);
    expect(scored).toHaveLength(0);
    expect(rpcCalls).toHaveLength(0);
  });

  it('an unrecognised non-null answer is ALSO treated as suppressed (fail closed)', async () => {
    // A scorecard published to Ashby cannot be retracted, so a newer reason
    // this build does not know must not be read as "score it".
    const scored: string[] = [];
    const { client, rpcCalls } = makeAssessmentClient({ suppression: 'some_future_reason' });
    const handler = createPhoneAssessmentHandler({
      client: client as never,
      score: async (sessionId) => { scored.push(sessionId); },
    });
    await handler({ payload: partialPayload } as never);
    expect(scored).toHaveLength(0);
    expect(rpcCalls).toHaveLength(0);
  });

  it('an RPC error throws phone_assessment_suppression_check_failed, before scoring', async () => {
    const scored: string[] = [];
    const { client, rpcCalls } = makeAssessmentClient({
      engagementId: ENGAGEMENT_A,
      suppression: { error: { message: 'boom', code: 'PGRST202' } },
    });
    const handler = createPhoneAssessmentHandler({
      client: client as never,
      score: async (sessionId) => { scored.push(sessionId); },
    });
    await expect(handler({ payload: partialPayload } as never))
      .rejects.toThrow('phone_assessment_suppression_check_failed');
    expect(scored).toHaveLength(0);
    expect(rpcCalls).toHaveLength(0);
    // The code must survive the queue runner's sanitizer verbatim, or the
    // retry/DLQ row would read `unknown_error`.
    expect(sanitizeErrorCode(new Error('phone_assessment_suppression_check_failed')))
      .toBe('phone_assessment_suppression_check_failed');
  });

  it('a null answer scores and posts exactly as before', async () => {
    const scored: string[] = [];
    const { client, rpcCalls, suppressionCalls } = makeAssessmentClient({
      engagementId: ENGAGEMENT_A,
      suppression: null,
    });
    const handler = createPhoneAssessmentHandler({
      client: client as never,
      score: async (sessionId) => { scored.push(sessionId); },
    });
    await handler({ payload: partialPayload } as never);
    expect(suppressionCalls).toHaveLength(1);
    expect(scored).toEqual([SESSION_A]);
    expect(rpcCalls).toHaveLength(1);
    expect(rpcCalls[0].p_event_type).toBe('assessment.completed');
  });

  it('runs AFTER the E4 guard: a callback-appointment leg never reaches the RPC', async () => {
    const { client, suppressionCalls, appointmentFilters } = makeAssessmentClient({
      callbackAppointment: 'row',
      suppression: { error: { message: 'must not be called' } },
    });
    const handler = createPhoneAssessmentHandler({ client: client as never, score: async () => {} });
    await expect(handler({ payload: partialPayload } as never)).resolves.toBeUndefined();
    expect(appointmentFilters).toHaveLength(1);
    expect(suppressionCalls).toHaveLength(0);
  });

  it('runs BEFORE score(): the order is E4 guard, suppression, score, completion', async () => {
    const order: string[] = [];
    const base = makeAssessmentClient({ engagementId: ENGAGEMENT_A });
    const inner = base.client as {
      rpc: (n: string, a: Record<string, unknown>) => Promise<unknown>;
      from: (t: string) => unknown;
    };
    const client = {
      rpc(name: string, args: Record<string, unknown>) {
        order.push(`rpc:${name}`);
        return inner.rpc(name, args);
      },
      from(table: string) {
        order.push(`from:${table}`);
        return inner.from(table);
      },
    };
    const handler = createPhoneAssessmentHandler({
      client: client as never,
      score: async () => { order.push('score'); },
    });
    await handler({ payload: { session_id: SESSION_A, attempt_id: ATTEMPT_A } } as never);
    expect(order).toEqual([
      'from:phone_appointments',
      'rpc:phone_attempt_score_suppression',
      'score',
      'rpc:apply_phone_event',
    ]);
  });

  it('the handler source names the RPC and the error code exactly once, in order', () => {
    const src = readFileSync(
      fileURLToPath(new URL('../lib/phone-runtime/assessment-handler.ts', import.meta.url)),
      'utf8',
    );
    expect(src.match(/'phone_attempt_score_suppression'/g)).toHaveLength(1);
    expect(src.match(/'phone_assessment_suppression_check_failed'/g)).toHaveLength(1);
    // The suppression check sits between the E4 guard and the score() call.
    const e4 = src.indexOf("throw new Error('phone_assessment_callback_check_failed')");
    const ss = src.indexOf("'phone_attempt_score_suppression'");
    const sc = src.indexOf('await score(sessionId');
    expect(e4).toBeGreaterThan(-1);
    expect(ss).toBeGreaterThan(e4);
    expect(sc).toBeGreaterThan(ss);
  });
});
