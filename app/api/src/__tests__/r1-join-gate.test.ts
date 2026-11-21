/**
 * M034 S04: the exchange's worker gate step, extracted from the R1 candidate router into
 * lib/r1/join-gate.ts.
 *
 * `sharedNameDispatchSafe` (the M019 interlock) and `r1WorkerGateMissing` (fence 7) must behave
 * exactly as the router closures did: the same short-circuits, the same one `call_sessions` read,
 * the same log lines through the caller's logger. `runR1JoinGate` must ask the interlock first and
 * only then resolve the worker gate and run `runR1WorkerGate`, failing closed on the R1 SFU.
 */

import { describe, expect, it, vi } from 'vitest';
import type { BrowserWorkerGate } from '../lib/browser-orchestration.js';
import { cloudLiveKitEndpoint, type LiveKitEndpoint } from '../lib/livekit-endpoints.js';
import type { DispatchLike } from '../lib/r1/worker-gate.js';
import {
  r1WorkerGateMissing,
  runR1JoinGate,
  sharedNameDispatchSafe,
  type R1JoinGateDeps,
} from '../lib/r1/join-gate.js';
import { createFakeDb, type Row } from './support/r1-candidate-fake-db.js';

const SESSION = '30000000-0000-4000-8000-0000000000e1';
const OTHER = '30000000-0000-4000-8000-0000000000e2';
const OTHER_2 = '30000000-0000-4000-8000-0000000000e3';
const ROUND = '20000000-0000-4000-8000-0000000000c1';
const ROOM = `screening-${SESSION}`;
const NOW = Date.parse('2030-01-01T00:00:00.000Z');
const clock = () => NOW;

/** A synthetic R1 SFU endpoint. Low-entropy fixture so the history secret scanner never flags it. */
const R1_ENDPOINT: LiveKitEndpoint = {
  url: 'wss://r1.example.invalid',
  apiKey: 'r1-test-key',
  apiSecret: 'r1-test-secret-' + 's'.repeat(24),
  target: 'r1',
};

// ── Gate and dispatch doubles (as in r1-worker-gate.test.ts) ─────────

function gateWith(over: Partial<Record<keyof BrowserWorkerGate, unknown>> = {}) {
  return {
    app: 'project-hello-voice',
    agentName: 'browser-screener',
    ensureReadyWorker: vi.fn(async () => ({
      status: 'ready', machineId: 'm1', epoch: 1, agentName: 'browser-screener',
    })),
    dispatch: vi.fn(async () => true),
    releaseWorker: vi.fn(async () => undefined),
    ...over,
  } as unknown as BrowserWorkerGate & {
    ensureReadyWorker: ReturnType<typeof vi.fn>;
    dispatch: ReturnType<typeof vi.fn>;
    releaseWorker: ReturnType<typeof vi.fn>;
  };
}

/** LiveKit's `createdAt` for a dispatch made `ageMs` before NOW, in epoch nanoseconds. */
const created = (ageMs: number): bigint => BigInt(NOW - ageMs) * 1_000_000n;

const running = (id = 'AD_run'): DispatchLike => ({
  id,
  agentName: 'browser-screener',
  state: { jobs: [{ id: 'AJ_1' }], createdAt: created(60_000) },
});

const jobless = (ageMs: number, id = 'AD_jobless'): DispatchLike => ({
  id,
  agentName: 'browser-screener',
  state: { jobs: [], createdAt: created(ageMs) },
});

function lister(items: DispatchLike[] = []) {
  return {
    listDispatch: vi.fn(async () => [...items]),
    deleteDispatch: vi.fn(async (id: string) => {
      const at = items.findIndex((item) => item.id === id);
      if (at >= 0) items.splice(at, 1);
    }),
  };
}

// ── DB doubles ───────────────────────────────────────────────────────

const liveSession = (id: string, status: string, interviewRoundId: string | null = ROUND): Row => ({
  id, status, interview_round_id: interviewRoundId,
});

function fakeDb(rows: Row[] = [], failures?: Record<string, { message: string }>) {
  return createFakeDb({ tables: { call_sessions: rows }, ...(failures ? { failures } : {}) });
}

/** Records every builder call and settles the awaited query with `outcome` (an Error rejects). */
function recordingDb(outcome: { data: unknown; error: unknown } | Error) {
  const calls: unknown[][] = [];
  const builder: Record<string, unknown> = {};
  for (const method of ['select', 'not', 'in', 'neq', 'limit']) {
    builder[method] = (...args: unknown[]) => {
      calls.push([method, ...args]);
      return builder;
    };
  }
  builder.then = (resolve: (value: unknown) => unknown, reject: (reason: unknown) => unknown) =>
    (outcome instanceof Error ? Promise.reject(outcome) : Promise.resolve(outcome)).then(resolve, reject);
  const db = {
    from: (table: string) => {
      calls.push(['from', table]);
      return builder;
    },
  };
  return { db, calls };
}

const throwingDb = {
  from: () => {
    throw new Error('db_down');
  },
};

function deps(over: Partial<R1JoinGateDeps> = {}) {
  const list = lister();
  return {
    db: fakeDb() as never,
    now: clock,
    resolveGate: vi.fn((): BrowserWorkerGate | null => gateWith()),
    dispatches: vi.fn((_endpoint: LiveKitEndpoint) => list),
    requireMachineAgentName: vi.fn(() => false),
    log: { error: vi.fn() },
    ...over,
  };
}

const logged = (category: string) => ['unknown_event', { error_category: category }];

// ── sharedNameDispatchSafe (the M019 interlock) ──────────────────────

describe('sharedNameDispatchSafe', () => {
  it('1. Cloud skips the interlock: true, the flag is not read, the DB is not touched, no log', async () => {
    const db = fakeDb([liveSession(OTHER, 'waiting')]);
    const d = deps({ db: db as never });
    expect(await sharedNameDispatchSafe(cloudLiveKitEndpoint(), SESSION, d)).toBe(true);
    expect(d.requireMachineAgentName).not.toHaveBeenCalled();
    expect([...db.touched]).toEqual([]);
    expect(d.log.error).not.toHaveBeenCalled();
  });

  it('2. R1 with per-machine names required skips the read: true, the DB is not touched, no log', async () => {
    const db = fakeDb([liveSession(OTHER, 'waiting')]);
    const d = deps({ db: db as never, requireMachineAgentName: vi.fn(() => true) });
    expect(await sharedNameDispatchSafe(R1_ENDPOINT, SESSION, d)).toBe(true);
    expect(d.requireMachineAgentName).toHaveBeenCalledTimes(1);
    expect([...db.touched]).toEqual([]);
    expect(d.log.error).not.toHaveBeenCalled();
  });

  it('3. R1 with the flag off and no OTHER live R1 session is true, after one call_sessions read', async () => {
    const db = fakeDb([
      liveSession(OTHER, 'completed'), // not live
      liveSession(OTHER_2, 'waiting', null), // live, but not an R1 round session
      liveSession(SESSION, 'waiting'), // this very session
    ]);
    const d = deps({ db: db as never });
    expect(await sharedNameDispatchSafe(R1_ENDPOINT, SESSION, d)).toBe(true);
    expect([...db.touched]).toEqual(['call_sessions']);
    expect(d.log.error).not.toHaveBeenCalled();
    // An empty table is the same answer.
    expect(await sharedNameDispatchSafe(R1_ENDPOINT, SESSION, deps({ db: fakeDb() as never }))).toBe(true);
  });

  it('3b. reads with exactly the router\'s builder chain, in order', async () => {
    const { db, calls } = recordingDb({ data: [], error: null });
    expect(await sharedNameDispatchSafe(R1_ENDPOINT, SESSION, deps({ db: db as never }))).toBe(true);
    expect(calls).toEqual([
      ['from', 'call_sessions'],
      ['select', 'id'],
      ['not', 'interview_round_id', 'is', null],
      ['in', 'status', ['created', 'waiting', 'in_progress']],
      ['neq', 'id', SESSION],
      ['limit', 1],
    ]);
  });

  it.each(['created', 'waiting', 'in_progress'])(
    '4. another live R1 session (%s) is false and logs r1_concurrency_needs_machine_names once',
    async (status) => {
      const d = deps({ db: fakeDb([liveSession(OTHER, status)]) as never });
      expect(await sharedNameDispatchSafe(R1_ENDPOINT, SESSION, d)).toBe(false);
      expect(d.log.error).toHaveBeenCalledTimes(1);
      expect(d.log.error).toHaveBeenCalledWith(...logged('r1_concurrency_needs_machine_names'));
    },
  );

  it('4b. an answer without a row list and without an error is false, logged as needing machine names (as before)', async () => {
    const { db } = recordingDb({ data: null, error: null });
    const d = deps({ db: db as never });
    expect(await sharedNameDispatchSafe(R1_ENDPOINT, SESSION, d)).toBe(false);
    expect(d.log.error).toHaveBeenCalledTimes(1);
    expect(d.log.error).toHaveBeenCalledWith(...logged('r1_concurrency_needs_machine_names'));
  });

  it('5. a read error is false and logs r1_live_count_unreadable once', async () => {
    const d = deps({ db: fakeDb([], { call_sessions: { message: 'boom' } }) as never });
    expect(await sharedNameDispatchSafe(R1_ENDPOINT, SESSION, d)).toBe(false);
    expect(d.log.error).toHaveBeenCalledTimes(1);
    expect(d.log.error).toHaveBeenCalledWith(...logged('r1_live_count_unreadable'));
  });

  it.each([
    ['from throws', throwingDb],
    ['the query rejects', recordingDb(new Error('socket_closed')).db],
  ])('6. a db where %s is false and logs r1_live_count_unreadable once', async (_name, db) => {
    const d = deps({ db: db as never });
    expect(await sharedNameDispatchSafe(R1_ENDPOINT, SESSION, d)).toBe(false);
    expect(d.log.error).toHaveBeenCalledTimes(1);
    expect(d.log.error).toHaveBeenCalledWith(...logged('r1_live_count_unreadable'));
  });
});

// ── r1WorkerGateMissing (fence 7) ────────────────────────────────────

describe('r1WorkerGateMissing', () => {
  it('7. Cloud is never missing a gate: false, the gate is not resolved, no log', () => {
    const d = deps({ resolveGate: vi.fn(() => null) });
    expect(r1WorkerGateMissing(cloudLiveKitEndpoint(), d)).toBe(false);
    expect(d.resolveGate).not.toHaveBeenCalled();
    expect(d.log.error).not.toHaveBeenCalled();
  });

  it('8. R1 with a gate is false, no log', () => {
    const d = deps();
    expect(r1WorkerGateMissing(R1_ENDPOINT, d)).toBe(false);
    expect(d.resolveGate).toHaveBeenCalledTimes(1);
    expect(d.log.error).not.toHaveBeenCalled();
  });

  it('9. R1 with no gate is true and logs r1_worker_gate_missing once', () => {
    const d = deps({ resolveGate: vi.fn(() => null) });
    expect(r1WorkerGateMissing(R1_ENDPOINT, d)).toBe(true);
    expect(d.log.error).toHaveBeenCalledTimes(1);
    expect(d.log.error).toHaveBeenCalledWith(...logged('r1_worker_gate_missing'));
  });

  it('10. R1 with a gate that cannot be built is true and logs r1_worker_gate_missing once', () => {
    const d = deps({
      resolveGate: vi.fn((): BrowserWorkerGate | null => {
        throw new Error('gate_unbuildable');
      }),
    });
    expect(r1WorkerGateMissing(R1_ENDPOINT, d)).toBe(true);
    expect(d.log.error).toHaveBeenCalledTimes(1);
    expect(d.log.error).toHaveBeenCalledWith(...logged('r1_worker_gate_missing'));
  });
});

// ── runR1JoinGate (interlock, then runR1WorkerGate) ──────────────────

const INPUT_R1 = { endpoint: R1_ENDPOINT, sessionId: SESSION, roomName: ROOM };

describe('runR1JoinGate', () => {
  it('11. a failed interlock is preparing before the worker gate is resolved or a dispatch client built', async () => {
    const d = deps({ db: fakeDb([liveSession(OTHER, 'in_progress')]) as never });
    expect(await runR1JoinGate(INPUT_R1, d)).toBe('preparing');
    expect(d.resolveGate).not.toHaveBeenCalled();
    expect(d.dispatches).not.toHaveBeenCalled();
    expect(d.log.error).toHaveBeenCalledTimes(1);
    expect(d.log.error).toHaveBeenCalledWith(...logged('r1_concurrency_needs_machine_names'));

    // Unreadable is the same, and a gate that would throw is never reached.
    const unreadable = deps({
      db: throwingDb as never,
      resolveGate: vi.fn((): BrowserWorkerGate | null => {
        throw new Error('gate_unbuildable');
      }),
    });
    expect(await runR1JoinGate(INPUT_R1, unreadable)).toBe('preparing');
    expect(unreadable.resolveGate).not.toHaveBeenCalled();
    expect(unreadable.dispatches).not.toHaveBeenCalled();
  });

  it('12. no worker gate proceeds on Cloud and defers on the R1 SFU (failClosed)', async () => {
    const cloud = deps({ resolveGate: vi.fn(() => null) });
    expect(await runR1JoinGate({ ...INPUT_R1, endpoint: cloudLiveKitEndpoint() }, cloud)).toBe('proceed');
    expect(cloud.resolveGate).toHaveBeenCalledTimes(1);
    expect(cloud.dispatches).not.toHaveBeenCalled();

    const r1 = deps({ resolveGate: vi.fn(() => null), requireMachineAgentName: vi.fn(() => true) });
    expect(await runR1JoinGate(INPUT_R1, r1)).toBe('preparing');
    expect(r1.resolveGate).toHaveBeenCalledTimes(1);
    expect(r1.dispatches).not.toHaveBeenCalled();
  });

  it('12b. the service\'s disabled answer proceeds on Cloud and defers on the R1 SFU (failClosed)', async () => {
    const disabled = () => gateWith({ ensureReadyWorker: vi.fn(async () => ({ status: 'disabled' })) });
    const cloudGate = disabled();
    expect(await runR1JoinGate(
      { ...INPUT_R1, endpoint: cloudLiveKitEndpoint() },
      deps({ resolveGate: vi.fn(() => cloudGate) }),
    )).toBe('proceed');
    expect(cloudGate.dispatch).not.toHaveBeenCalled();

    const r1Gate = disabled();
    expect(await runR1JoinGate(INPUT_R1, deps({ resolveGate: vi.fn(() => r1Gate) }))).toBe('preparing');
    expect(r1Gate.dispatch).not.toHaveBeenCalled();
  });

  it.each([
    ['Cloud', cloudLiveKitEndpoint()],
    ['the R1 SFU', R1_ENDPOINT],
  ])('13. a running dispatch on %s proceeds without readying a worker; the factory gets the endpoint', async (_name, endpoint) => {
    const gate = gateWith();
    const list = lister([running()]);
    const d = deps({ resolveGate: vi.fn(() => gate), dispatches: vi.fn(() => list) });
    expect(await runR1JoinGate({ ...INPUT_R1, endpoint }, d)).toBe('proceed');
    expect(d.dispatches).toHaveBeenCalledTimes(1);
    expect(d.dispatches).toHaveBeenCalledWith(endpoint);
    expect(list.listDispatch).toHaveBeenCalledWith(ROOM);
    expect(gate.ensureReadyWorker).not.toHaveBeenCalled();
    expect(gate.dispatch).not.toHaveBeenCalled();
  });

  it('14. no dispatch yet: readies a worker, then dispatches it into the room, and proceeds', async () => {
    const gate = gateWith();
    const db = fakeDb([liveSession(SESSION, 'waiting')]);
    const d = deps({ db: db as never, resolveGate: vi.fn(() => gate) });
    expect(await runR1JoinGate(INPUT_R1, d)).toBe('proceed');
    // The interlock read ran (R1, flag off) and passed.
    expect([...db.touched]).toEqual(['call_sessions']);
    expect(gate.ensureReadyWorker).toHaveBeenCalledWith({ sessionId: SESSION });
    expect(gate.dispatch).toHaveBeenCalledTimes(1);
    expect(gate.dispatch).toHaveBeenCalledWith({ sessionId: SESSION, roomName: ROOM });
    expect(gate.ensureReadyWorker.mock.invocationCallOrder[0])
      .toBeLessThan(gate.dispatch.mock.invocationCallOrder[0]!);
    expect(d.log.error).not.toHaveBeenCalled();
  });

  it('15. deps.now is the clock: a job-less dispatch 5 s old waits, the same one 30 s old is replaced', async () => {
    // The dispatch was made at NOW (age 0 by NOW); only deps.now moves.
    const young = gateWith();
    const youngList = lister([jobless(0)]);
    expect(await runR1JoinGate(INPUT_R1, deps({
      now: () => NOW + 5_000,
      resolveGate: vi.fn(() => young),
      dispatches: vi.fn(() => youngList),
    }))).toBe('preparing');
    expect(young.ensureReadyWorker).not.toHaveBeenCalled();
    expect(youngList.deleteDispatch).not.toHaveBeenCalled();

    const stale = gateWith();
    const staleList = lister([jobless(0)]);
    expect(await runR1JoinGate(INPUT_R1, deps({
      now: () => NOW + 30_000,
      resolveGate: vi.fn(() => stale),
      dispatches: vi.fn(() => staleList),
    }))).toBe('proceed');
    expect(staleList.deleteDispatch).toHaveBeenCalledWith('AD_jobless', ROOM);
    expect(stale.dispatch).toHaveBeenCalledWith({ sessionId: SESSION, roomName: ROOM });
  });

  it('16. a worker gate that throws while being resolved rejects the join gate (unguarded, as before)', async () => {
    const boom = new Error('gate_unbuildable');
    const d = deps({
      requireMachineAgentName: vi.fn(() => true),
      resolveGate: vi.fn((): BrowserWorkerGate | null => {
        throw boom;
      }),
    });
    await expect(runR1JoinGate(INPUT_R1, d)).rejects.toBe(boom);
    expect(d.dispatches).not.toHaveBeenCalled();
    expect(d.log.error).not.toHaveBeenCalled();
  });
});
