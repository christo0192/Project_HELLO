/**
 * M031 S4: the webhook nudge. A candidateStageChange signal for an application
 * HELLO imported marks its progress row due now, so the progress worker reads
 * it on its next pass instead of at the cadence (6 h for a recent one).
 *
 *   signal ─► processAshbySignal ─► nudgeProgress (before the pre-filter)
 *                                       └─► nudge_ashby_application_progress (0141)
 *
 * What these tests pin:
 *   1. the nudge runs for a stage change with an application id, BEFORE the
 *      stage pre-filter (so the skip path still nudges), never for another
 *      action, a signal with no application, or an explicit backlog import;
 *   2. the import path's decisions, receipt marks, provider reads and the order
 *      of every other step are IDENTICAL with no nudge, a nudge that works, one
 *      that throws, one that rejects and one that stalls;
 *   3. a failing nudge never fails, retries or delays the signal beyond its
 *      bound: the guarded nudge times out, backs off and only logs a code;
 *   4. with ASHBY_PROGRESS_ENABLED off nothing is called, so nothing is written;
 *   5. the store makes ONE call (the 0141 function) and maps its answer.
 *
 * What the 0141 function writes (due now, created if missing, never later,
 * erased links skipped) runs on real Postgres in
 * app/supabase/tests/policy_tests.sql, section "0141".
 */
import { afterEach, describe, expect, it, vi } from 'vitest';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  processAshbySignal,
  runClaimedAshbySignal,
  ASHBY_SIGNAL_QUEUE,
  ASHBY_IMPORT_QUEUE,
  CANDIDATE_DELETE_ACTION,
  type SignalWorkerDeps,
  type SignalResult,
  type LeasedSignalQueue,
} from '../integrations/ashby/signal-worker.js';
import { buildAshbyHandlers } from '../integrations/ashby/runtime-workers.js';
import { stageDedupId, extractWebhookSignal, CANDIDATE_STAGE_CHANGE_ACTION } from '../integrations/ashby/extractors.js';
import {
  createProgressNudge,
  createProgressNudgeStore,
  PROGRESS_NUDGE_RPC,
  PROGRESS_NUDGE_STATUSES,
  PROGRESS_NUDGE_TIMEOUT_MS,
  PROGRESS_NUDGE_FAILURE_BACKOFF_MS,
  type ProgressNudgeStore,
} from '../integrations/ashby/progress-nudge.js';
import type { AshbySignalPayload } from '../integrations/ashby/ports.js';
import type { AshbyResult, OpaqueRecord } from '../integrations/ashby/types.js';

const APP = 'app_nudge_1';
const JOB = 'job_nudge_1';
const AI_STAGE = 'stage_ai';
const R1_STAGE = 'stage_r1';
const ACTIVATED = '2026-01-01T00:00:00.000Z';

afterEach(() => {
  vi.restoreAllMocks();
});

// ── A fully traced signal world ──────────────────────────────────────────────

type Variant = 'none' | 'ok' | 'throws' | 'rejects' | 'stalls';
const VARIANTS: Variant[] = ['none', 'ok', 'throws', 'rejects', 'stalls'];

interface Scenario {
  name: string;
  /** The decision this signal has always reached: pinned, not just compared. */
  decision: SignalResult['decision'];
  /** Whether the nudge may run for it. */
  nudged: boolean;
  payload: AshbySignalPayload;
  world: {
    stageId?: string;
    noJob?: boolean;
    mapping?: 'enabled' | 'paused';
    enteredAt?: string;
    snapshotAuthorized?: boolean;
    explicitAuthorized?: boolean;
    selfEcho?: boolean;
    prefilter?: boolean;
  };
}

function stagePayload(stageId: string, over: Partial<AshbySignalPayload> = {}): AshbySignalPayload {
  return {
    provider: 'ashby',
    action: CANDIDATE_STAGE_CHANGE_ACTION,
    webhookActionId: stageDedupId(APP, stageId),
    externalApplicationId: APP,
    ...over,
  };
}

const SCENARIOS: Scenario[] = [
  { name: 'another action is ignored', decision: 'ignored_action', nudged: false,
    payload: { ...stagePayload(AI_STAGE), action: 'applicationUpdate' }, world: {} },
  { name: 'candidateDelete stays gated', decision: 'capability_disabled', nudged: false,
    payload: { ...stagePayload(AI_STAGE), action: CANDIDATE_DELETE_ACTION }, world: {} },
  { name: 'a stage change with no application', decision: 'skipped_no_application', nudged: false,
    payload: { ...stagePayload(AI_STAGE), externalApplicationId: undefined }, world: {} },
  { name: 'the pre-filter skips an unmapped stage', decision: 'stage_not_of_interest', nudged: true,
    payload: stagePayload(R1_STAGE), world: { prefilter: true, stageId: R1_STAGE } },
  { name: 'Ashby names no job', decision: 'mapping_inactive', nudged: true,
    payload: stagePayload(AI_STAGE), world: { noJob: true } },
  { name: 'the mapping is paused', decision: 'mapping_inactive', nudged: true,
    payload: stagePayload(AI_STAGE), world: { mapping: 'paused' } },
  { name: 'a recruiter moved it on to R1', decision: 'stage_not_ai', nudged: true,
    payload: stagePayload(R1_STAGE), world: { stageId: R1_STAGE } },
  { name: 'the pre-filter is on and it moved to R1, hinted as the Christy stage', decision: 'stage_not_ai', nudged: true,
    payload: stagePayload(AI_STAGE), world: { prefilter: true, stageId: R1_STAGE } },
  { name: 'it entered the Christy stage before the mapping went live', decision: 'mapping_inactive', nudged: true,
    payload: stagePayload(AI_STAGE), world: { enteredAt: '2025-12-01T00:00:00.000Z' } },
  { name: 'our own write-back echoed', decision: 'self_echo', nudged: true,
    payload: stagePayload(AI_STAGE), world: { selfEcho: true } },
  { name: 'it entered the Christy stage after the mapping went live', decision: 'import_eligible', nudged: true,
    payload: stagePayload(AI_STAGE), world: {} },
  { name: 'a confirmed snapshot authorizes it', decision: 'import_eligible', nudged: true,
    payload: stagePayload(AI_STAGE), world: { snapshotAuthorized: true, enteredAt: '2025-12-01T00:00:00.000Z' } },
  { name: 'the pre-filter is on and the stage is mapped', decision: 'import_eligible', nudged: true,
    payload: stagePayload(AI_STAGE), world: { prefilter: true } },
  { name: 'an explicit backlog import (not a webhook)', decision: 'import_eligible', nudged: false,
    payload: stagePayload(AI_STAGE, { source: 'explicit_backlog', explicitImportRunId: 'run_1' }),
    world: { explicitAuthorized: true, enteredAt: '2025-12-01T00:00:00.000Z' } },
];

/** Every seam records itself, in order, so a reordering shows up as a diff. */
function tracedDeps(s: Scenario, trace: string[]): SignalWorkerDeps {
  const w = s.world;
  const stageId = w.stageId ?? AI_STAGE;
  return {
    client: {
      async applicationInfo<T = OpaqueRecord>(id: string): Promise<AshbyResult<T>> {
        trace.push(`read:${id}`);
        const results = w.noJob
          ? { id: APP, currentInterviewStage: { id: stageId } }
          : { id: APP, job: { id: JOB }, currentInterviewStage: { id: stageId } };
        return { results } as unknown as AshbyResult<T>;
      },
    },
    mappings: {
      async resolveByJobId(jobId: string) {
        trace.push(`resolve:${jobId}`);
        return w.mapping === 'paused'
          ? { status: 'paused' as const }
          : { status: 'enabled' as const, aiScreeningStageId: AI_STAGE, activationAt: ACTIVATED, activationEpoch: 1, configVersion: 1 };
      },
    },
    receipts: {
      record: async () => ({ status: 'inserted', id: 'r', enqueued: false, workPending: false }),
      markStatus: async (i) => { trace.push(`mark:${i.status}`); },
    },
    candidateDeleteEnabled: false,
    enforceActivationFence: true,
    history: {
      async applicationListHistory<T = OpaqueRecord[]>(): Promise<AshbyResult<T>> {
        trace.push('history');
        return {
          results: [{ stageId: AI_STAGE, enteredStageAt: w.enteredAt ?? '2026-02-01T00:00:00.000Z', leftStageAt: null }],
          moreDataAvailable: false,
        } as unknown as AshbyResult<T>;
      },
    },
    isSnapshotApplicationAuthorized: async () => { trace.push('snapshot'); return w.snapshotAuthorized === true; },
    isExplicitImportAuthorized: async () => { trace.push('explicit'); return w.explicitAuthorized === true; },
    isSelfEcho: async () => { trace.push('echo'); return w.selfEcho === true; },
    ...(w.prefilter
      ? { isStageOfInterest: async (id: string) => { trace.push(`interest:${id}`); return id === AI_STAGE; } }
      : {}),
    onStageHintObserved: (i) => { trace.push(`hint:${i.hintedStageId}->${i.authoritativeStageId}`); },
    onImportEligible: async (i) => { trace.push(`import:${i.applicationId}:${i.stageId}:${i.source ?? '-'}`); },
  };
}

function nudgeFor(variant: Variant, trace: string[]): SignalWorkerDeps['nudgeProgress'] {
  switch (variant) {
    case 'none': return undefined;
    case 'ok': return async ({ applicationId }) => { trace.push(`nudge:${applicationId}`); return 'marked'; };
    case 'throws': return ({ applicationId }) => { trace.push(`nudge:${applicationId}`); throw new Error('nudge_down'); };
    case 'rejects': return async ({ applicationId }) => { trace.push(`nudge:${applicationId}`); throw new Error('nudge_down'); };
    case 'stalls': {
      // The production guard around a store call that never answers.
      const guarded = createProgressNudge({
        store: { nudge: () => new Promise(() => { /* never settles */ }) },
        timeoutMs: 5,
      });
      return async (input) => { trace.push(`nudge:${input.applicationId}`); return guarded(input); };
    }
  }
}

async function run(s: Scenario, variant: Variant): Promise<{ result: SignalResult; trace: string[] }> {
  const trace: string[] = [];
  const nudge = nudgeFor(variant, trace);
  const deps = { ...tracedDeps(s, trace), ...(nudge ? { nudgeProgress: nudge } : {}) };
  const result = await processAshbySignal(s.payload, deps);
  return { result, trace };
}

describe('processAshbySignal: the import path is identical with and without the nudge', () => {
  for (const s of SCENARIOS) {
    it(`${s.name}: ${s.decision}, whatever the nudge does`, async () => {
      const base = await run(s, 'none');
      // Pinned: the decision this signal reached before S4.
      expect(base.result.decision).toBe(s.decision);
      expect(base.trace.some((t) => t.startsWith('nudge:'))).toBe(false);

      for (const variant of VARIANTS.slice(1)) {
        const got = await run(s, variant);
        // Same decision, same ids, same receipt mark, same reads, same order.
        expect(got.result, variant).toEqual(base.result);
        expect(got.trace.filter((t) => !t.startsWith('nudge:')), variant).toEqual(base.trace);
        if (s.nudged) {
          // Exactly once, for this application, and FIRST: before the
          // pre-filter, the provider read and every decision.
          expect(got.trace.filter((t) => t.startsWith('nudge:')), variant).toEqual([`nudge:${APP}`]);
          expect(got.trace[0], variant).toBe(`nudge:${APP}`);
        } else {
          expect(got.trace.some((t) => t.startsWith('nudge:')), variant).toBe(false);
        }
      }
    });
  }

  it('the pre-filter skip still nudges, and still spends no provider read', async () => {
    const s = SCENARIOS.find((x) => x.decision === 'stage_not_of_interest')!;
    const got = await run(s, 'ok');
    expect(got.trace).toEqual([`nudge:${APP}`, `interest:${R1_STAGE}`]);
    expect(got.result).toEqual({ decision: 'stage_not_of_interest', applicationId: APP, stageId: R1_STAGE });
  });

  it('a nudge that throws never reaches the leased runner: the job commits, nothing is failed or retried', async () => {
    const s = SCENARIOS.find((x) => x.decision === 'stage_not_ai')!;
    const failed: unknown[] = [];
    const queue: LeasedSignalQueue = {
      async claim<T>() {
        return { id: 'job_1', name: ASHBY_SIGNAL_QUEUE, payload: s.payload as unknown as T, leaseToken: 'lease_1', attempts: 1 } as never;
      },
      async completeClaim() { return true; },
      async failClaim(_id, _lease, err) { failed.push(err); return 'retry' as never; },
    };
    const trace: string[] = [];
    const out = await runClaimedAshbySignal(queue, {
      ...tracedDeps(s, trace),
      nudgeProgress: () => { throw new Error('nudge_down'); },
    });
    expect(out).toMatchObject({ claimed: true, committed: true, staleLease: false, result: { decision: 'stage_not_ai' } });
    expect(failed).toEqual([]);
  });

  it('a nudge is asked about the payload application only, never a value read from Ashby', async () => {
    const asked: string[] = [];
    await processAshbySignal(stagePayload(R1_STAGE), {
      ...tracedDeps(SCENARIOS[6]!, []),
      nudgeProgress: async ({ applicationId }) => { asked.push(applicationId); },
    });
    expect(asked).toEqual([APP]);
  });
});

// ── The guarded nudge ────────────────────────────────────────────────────────

function fakeStore(answer: () => Promise<Awaited<ReturnType<ProgressNudgeStore['nudge']>>>) {
  const calls: Array<{ applicationId: string; nowIso: string }> = [];
  const store: ProgressNudgeStore = {
    nudge: (applicationId, nowIso) => { calls.push({ applicationId, nowIso }); return answer(); },
  };
  return { store, calls };
}

describe('createProgressNudge: bounded, backs off, never throws', () => {
  it('hands the store the application and the clock, and answers its status', async () => {
    const { store, calls } = fakeStore(async () => ({ status: 'marked' }));
    const nudge = createProgressNudge({ store, nowMs: () => Date.parse('2026-11-10T10:00:00.000Z') });
    await expect(nudge({ applicationId: APP })).resolves.toBe('marked');
    expect(calls).toEqual([{ applicationId: APP, nowIso: '2026-11-10T10:00:00.000Z' }]);
  });

  it('answers every status the 0141 function names', async () => {
    for (const status of PROGRESS_NUDGE_STATUSES) {
      const { store } = fakeStore(async () => ({ status }));
      await expect(createProgressNudge({ store })({ applicationId: APP })).resolves.toBe(status);
    }
    expect([...PROGRESS_NUDGE_STATUSES].sort()).toEqual(['already_due', 'created', 'marked', 'not_covered', 'not_imported']);
  });

  it('sends nothing for an application id the link table could not hold', async () => {
    const { store, calls } = fakeStore(async () => ({ status: 'marked' }));
    const nudge = createProgressNudge({ store });
    for (const bad of ['', 'x'.repeat(257), undefined, null, 42]) {
      await expect(nudge({ applicationId: bad as unknown as string })).resolves.toBe('invalid_application');
    }
    expect(calls).toEqual([]);
    await expect(nudge({ applicationId: 'x'.repeat(256) })).resolves.toBe('marked');
  });

  it('a store that throws answers `error`, reports it, then backs off before asking again', async () => {
    let now = 1_000_000;
    let fail = true;
    const failures: string[] = [];
    const { store, calls } = fakeStore(async () => { if (fail) throw new Error('db_down'); return { status: 'marked' }; });
    const nudge = createProgressNudge({ store, nowMs: () => now, failureBackoffMs: 30_000, onFailure: (c) => failures.push(c) });
    await expect(nudge({ applicationId: APP })).resolves.toBe('error');
    fail = false;
    // Inside the backoff: no call at all, so a storm cannot pile onto a sick database.
    await expect(nudge({ applicationId: APP })).resolves.toBe('backoff');
    now += 29_999;
    await expect(nudge({ applicationId: APP })).resolves.toBe('backoff');
    expect(calls).toHaveLength(1);
    now += 2;
    await expect(nudge({ applicationId: APP })).resolves.toBe('marked');
    expect(calls).toHaveLength(2);
    expect(failures).toEqual(['error']);
  });

  it('a store that never answers is cut off at the bound (a real timer), reported and backed off', async () => {
    const failures: string[] = [];
    const { store, calls } = fakeStore(() => new Promise(() => { /* never settles */ }));
    const nudge = createProgressNudge({ store, timeoutMs: 10, onFailure: (c) => failures.push(c) });
    const started = Date.now();
    await expect(nudge({ applicationId: APP })).resolves.toBe('timeout');
    expect(Date.now() - started).toBeLessThan(2_000);
    await expect(nudge({ applicationId: APP })).resolves.toBe('backoff');
    expect(calls).toHaveLength(1);
    expect(failures).toEqual(['timeout']);
  });

  it('a refusal is reported but is about that one call: no backoff', async () => {
    const failures: string[] = [];
    const { store, calls } = fakeStore(async () => ({ status: 'refused', code: 'invalid_request' }));
    const nudge = createProgressNudge({ store, onFailure: (c) => failures.push(c) });
    await expect(nudge({ applicationId: APP })).resolves.toBe('refused');
    await expect(nudge({ applicationId: APP })).resolves.toBe('refused');
    expect(calls).toHaveLength(2);
    expect(failures).toEqual(['refused', 'refused']);
  });

  it('a throwing failure reporter cannot break the nudge, and a synchronous store throw is caught', async () => {
    const store: ProgressNudgeStore = { nudge: () => { throw new Error('sync_boom'); } };
    const nudge = createProgressNudge({ store, onFailure: () => { throw new Error('logger_down'); } });
    await expect(nudge({ applicationId: APP })).resolves.toBe('error');
  });

  it('pins its defaults: a short bound and a backoff long enough to matter', () => {
    // A bound that is too long parks a signal slot on a sick database; a zero
    // one would always lose to a real round trip and disable the nudge.
    expect(PROGRESS_NUDGE_TIMEOUT_MS).toBeGreaterThanOrEqual(500);
    expect(PROGRESS_NUDGE_TIMEOUT_MS).toBeLessThanOrEqual(3_000);
    expect(PROGRESS_NUDGE_FAILURE_BACKOFF_MS).toBeGreaterThanOrEqual(5_000);
    expect(PROGRESS_NUDGE_FAILURE_BACKOFF_MS).toBeLessThanOrEqual(300_000);
  });
});

// ── The store: one call to the 0141 function ────────────────────────────────

function rpcClient(answer: { data: unknown; error: unknown }) {
  const calls: Array<{ name: string; args: unknown }> = [];
  const client = {
    rpc: vi.fn(async (name: string, args: unknown) => { calls.push({ name, args }); return answer; }),
    from: vi.fn(() => { throw new Error('the nudge must not touch a table directly'); }),
  };
  return { client, calls };
}

describe('createProgressNudgeStore', () => {
  it('makes exactly one call, to nudge_ashby_application_progress, with the id and the time', async () => {
    const { client, calls } = rpcClient({ data: { status: 'created' }, error: null });
    const store = createProgressNudgeStore(client as never);
    await expect(store.nudge(APP, '2026-11-10T10:00:00.000Z')).resolves.toEqual({ status: 'created' });
    expect(PROGRESS_NUDGE_RPC).toBe('nudge_ashby_application_progress');
    expect(calls).toEqual([{ name: PROGRESS_NUDGE_RPC, args: { p_external_application_id: APP, p_now: '2026-11-10T10:00:00.000Z' } }]);
    expect(client.from).not.toHaveBeenCalled();
  });

  it('a status it does not know is a refusal under a sanitized code; an error throws', async () => {
    const odd = createProgressNudgeStore(rpcClient({ data: { status: 'invalid_request' }, error: null }).client as never);
    await expect(odd.nudge(APP, 'n')).resolves.toEqual({ status: 'refused', code: 'invalid_request' });
    const junk = createProgressNudgeStore(rpcClient({ data: { status: 'Bad Value <x>' }, error: null }).client as never);
    await expect(junk.nudge(APP, 'n')).resolves.toEqual({ status: 'refused', code: 'unknown' });
    const none = createProgressNudgeStore(rpcClient({ data: null, error: null }).client as never);
    await expect(none.nudge(APP, 'n')).resolves.toEqual({ status: 'refused', code: 'unknown' });
    const broken = createProgressNudgeStore(rpcClient({ data: null, error: { message: 'function does not exist' } }).client as never);
    await expect(broken.nudge(APP, 'n')).rejects.toThrow('ashby_progress_nudge_error');
  });
});

// ── The handler map: wired once, only with the switch on ─────────────────────

function stubRuntime(opts: {
  progressEnabled?: boolean;
  store?: ProgressNudgeStore;
  stageId?: string;
  reads?: { n: number };
  enqueued?: Array<{ queue: string; payload: unknown }>;
}) {
  const reads = opts.reads ?? { n: 0 };
  return {
    client: {
      async applicationInfo() {
        reads.n += 1;
        return { ok: true, results: { id: APP, job: { id: JOB }, currentInterviewStage: { id: opts.stageId ?? AI_STAGE } } };
      },
      async applicationListHistory() {
        return { results: [{ stageId: AI_STAGE, enteredStageAt: '2026-02-01T00:00:00.000Z', leftStageAt: null }], moreDataAvailable: false };
      },
    },
    mappings: {
      resolveByJobId: async () => ({ status: 'enabled', aiScreeningStageId: AI_STAGE, activationAt: ACTIVATED }),
    },
    receipts: { markStatus: async () => {} },
    enabledMappings: {
      async listEnabled() { return { rows: [{ externalJobId: JOB, aiScreeningStageId: AI_STAGE }], truncated: false }; },
    },
    isSnapshotApplicationAuthorized: async () => false,
    isExplicitImportAuthorized: async () => true,
    queue: { enqueue: async (queue: string, payload: unknown) => { opts.enqueued?.push({ queue, payload }); } },
    ...(opts.store ? { progressNudge: opts.store } : {}),
    runtimeConfig: opts.progressEnabled === undefined ? {} : { progress: { enabled: opts.progressEnabled } },
  } as unknown as Parameters<typeof buildAshbyHandlers>[0];
}

function signalJob(payload: AshbySignalPayload) {
  return { id: 'job_1', name: ASHBY_SIGNAL_QUEUE, payload, attempts: 1, leaseToken: 't' } as unknown as Parameters<ReturnType<typeof buildAshbyHandlers>[string]>[0];
}

describe('buildAshbyHandlers: the nudge is wired with the switch on, and only then', () => {
  it('ASHBY_PROGRESS_ENABLED on: a stage change nudges its application, once', async () => {
    const { store, calls } = fakeStore(async () => ({ status: 'marked' }));
    const handlers = buildAshbyHandlers(stubRuntime({ progressEnabled: true, store, stageId: R1_STAGE }));
    await handlers[ASHBY_SIGNAL_QUEUE]!(signalJob(stagePayload(R1_STAGE)));
    expect(calls.map((c) => c.applicationId)).toEqual([APP]);
    expect(Number.isFinite(Date.parse(calls[0]!.nowIso))).toBe(true);
  });

  it('ASHBY_PROGRESS_ENABLED off, absent or overridden off: nothing is called, so nothing is written', async () => {
    for (const runtime of [
      stubRuntime({ progressEnabled: false, store: fakeStore(async () => ({ status: 'marked' })).store }),
      stubRuntime({ store: fakeStore(async () => ({ status: 'marked' })).store }),
    ]) {
      const spy = vi.spyOn((runtime as unknown as { progressNudge: ProgressNudgeStore }).progressNudge, 'nudge');
      const handlers = buildAshbyHandlers(runtime);
      await handlers[ASHBY_SIGNAL_QUEUE]!(signalJob(stagePayload(R1_STAGE)));
      expect(spy).not.toHaveBeenCalled();
    }
    const { store, calls } = fakeStore(async () => ({ status: 'marked' }));
    const handlers = buildAshbyHandlers(stubRuntime({ progressEnabled: true, store }), { progressEnabled: false });
    await handlers[ASHBY_SIGNAL_QUEUE]!(signalJob(stagePayload(R1_STAGE)));
    expect(calls).toEqual([]);
  });

  it('a runtime with the switch on but no store wires nothing and still decides', async () => {
    const reads = { n: 0 };
    const handlers = buildAshbyHandlers(stubRuntime({ progressEnabled: true, reads, stageId: R1_STAGE }));
    await expect(handlers[ASHBY_SIGNAL_QUEUE]!(signalJob(stagePayload(R1_STAGE)))).resolves.toBeUndefined();
    expect(reads.n).toBe(1);
  });

  it('the pre-filter on still nudges, and its skip still costs no provider read', async () => {
    const reads = { n: 0 };
    const { store, calls } = fakeStore(async () => ({ status: 'marked' }));
    const handlers = buildAshbyHandlers(
      stubRuntime({ progressEnabled: true, store, reads, stageId: R1_STAGE }),
      { stagePrefilterEnabled: true },
    );
    await handlers[ASHBY_SIGNAL_QUEUE]!(signalJob(stagePayload(R1_STAGE)));
    expect(calls.map((c) => c.applicationId)).toEqual([APP]);
    expect(reads.n).toBe(0);
  });

  it('a failing nudge store never fails the job: the import is still scheduled and a code is logged', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    const enqueued: Array<{ queue: string; payload: unknown }> = [];
    const { store } = fakeStore(async () => { throw new Error('function screening_v2.nudge_x does not exist'); });
    const handlers = buildAshbyHandlers(stubRuntime({ progressEnabled: true, store, enqueued }));
    await expect(handlers[ASHBY_SIGNAL_QUEUE]!(signalJob(stagePayload(AI_STAGE)))).resolves.toBeUndefined();
    expect(enqueued.map((e) => e.queue)).toEqual([ASHBY_IMPORT_QUEUE]);
    const lines = warn.mock.calls.map((c) => String(c[0]));
    const nudgeLines = lines.filter((l) => l.includes('ashby_progress_nudge'));
    expect(nudgeLines).toHaveLength(1);
    const parsed = JSON.parse(nudgeLines[0]!) as Record<string, unknown>;
    expect(parsed).toMatchObject({ level: 'warn', error_category: 'ashby_progress_nudge', error_type: 'error' });
    // A code only: never the application id, never the database's message.
    expect(nudgeLines[0]).not.toContain(APP);
    expect(nudgeLines[0]).not.toContain('does not exist');
    expect(nudgeLines[0]).not.toContain('screening_v2');
  });

  it('is built once per handler map: one failure backs off the next job too', async () => {
    vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    const { store, calls } = fakeStore(async () => { throw new Error('db_down'); });
    const handlers = buildAshbyHandlers(stubRuntime({ progressEnabled: true, store, stageId: R1_STAGE }));
    await handlers[ASHBY_SIGNAL_QUEUE]!(signalJob(stagePayload(R1_STAGE)));
    await handlers[ASHBY_SIGNAL_QUEUE]!(signalJob(stagePayload(R1_STAGE)));
    expect(calls).toHaveLength(1);
  });

  it('an explicit backlog import is not a webhook and is not nudged', async () => {
    const { store, calls } = fakeStore(async () => ({ status: 'marked' }));
    const handlers = buildAshbyHandlers(stubRuntime({ progressEnabled: true, store }));
    await handlers[ASHBY_SIGNAL_QUEUE]!(signalJob(stagePayload(AI_STAGE, { source: 'explicit_backlog', explicitImportRunId: 'run_1' })));
    expect(calls).toEqual([]);
  });

  it('a test may inject the nudge itself', async () => {
    const asked: string[] = [];
    const handlers = buildAshbyHandlers(stubRuntime({ progressEnabled: true, stageId: R1_STAGE }), {
      progressNudge: async ({ applicationId }) => { asked.push(applicationId); return 'marked'; },
    });
    await handlers[ASHBY_SIGNAL_QUEUE]!(signalJob(stagePayload(R1_STAGE)));
    expect(asked).toEqual([APP]);
  });
});

// ── A limit the nudge cannot see past, recorded where it will be read ───────
//
// A move back into a stage whose receipt is already concluded makes no signal
// job, so processAshbySignal (and with it the nudge) never runs. In practice
// that is an imported application moved back into its Christy stage. Freshness
// only: the cadence still reads it, and no import decision changes.

describe('a move back into a stage whose receipt is concluded: no signal, so no nudge', () => {
  const repo = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../../..');
  const flat = (rel: string) => readFileSync(path.join(repo, rel), 'utf8').replace(/\s+/g, ' ');

  it('the premise: every entry of an application into a stage is one receipt, and 0030 re-drives none already concluded', () => {
    const delivery = (id: string, updatedAt: string) => extractWebhookSignal({
      id,
      action: CANDIDATE_STAGE_CHANGE_ACTION,
      data: { application: { id: APP, job: { id: JOB }, currentInterviewStage: { id: AI_STAGE }, updatedAt } },
    });
    const first = delivery('delivery_1', '2026-11-01T00:00:00.000Z');
    const back = delivery('delivery_2', '2026-11-08T00:00:00.000Z');
    if (!first.ok || !back.ok) throw new Error('both deliveries must extract');
    expect(first.signal.webhookActionId).toBe(stageDedupId(APP, AI_STAGE));
    expect(back.signal.webhookActionId).toBe(first.signal.webhookActionId);
    expect(flat('app/supabase/migrations/0030_ashby_webhook_reconciliation.sql'))
      .toContain("if v_status in ('processed', 'ignored', 'failed') then -- Worker already reached a terminal decision");
  });

  it('the runbook (section 8) and the nudge header both name it', () => {
    const runbook = flat('docs/runbooks/ashby-progress-worker.md');
    const limits = runbook.slice(runbook.indexOf('## 8. Limits, recorded honestly'));
    expect(limits).toContain('A move back into a stage whose receipt is already concluded is not nudged');
    expect(limits).toContain('`record_ashby_event_receipt` (0030)');
    expect(limits).toContain('moved back into its Christy stage');
    expect(limits).toContain('shows within the cadence');
    const header = flat('app/api/src/integrations/ashby/progress-nudge.ts');
    expect(header.slice(0, header.indexOf('import type'))).toContain('A MOVE BACK INTO A CONCLUDED STAGE');
  });
});
