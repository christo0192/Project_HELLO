/**
 * PR B (browser, §2.3b B-i) — the browser worker gate `browserOrchestrationGate`.
 *
 * Properties under test:
 *   - OFF by default (workerOrchestration false) ⇒ gate is null ⇒ the exchange
 *     flow never consults it and is byte-identical to today.
 *   - ON but browserAgentName empty ⇒ still null (naming + dispatch are paired;
 *     no half-change that stops auto-dispatch without adding dispatch).
 *   - ON + a MALFORMED name ⇒ null (names_agree negative: never dispatch to a
 *     name that cannot match a registration) — falls back to today's behaviour.
 *   - ON + a valid name ⇒ gate built; ensureReadyWorker uses pipeline 'browser'
 *     and the BROWSER app; dispatch createDispatches the exact configured name.
 *
 * PR-LK-liveness (R1) — everything new is gated on BROWSER_LIVEKIT_TARGET=r1:
 *   - CLOUD (default target) is byte-identical to origin/main: the ready verdict
 *     is returned untouched (no host match), and dispatch is ONE createDispatch
 *     with no listDispatch / deleteDispatch.
 *   - R1: exact durable host match; dispatch-drop verification, retirement and a
 *     single retry that can never put a second agent in the room.
 */

import { describe, it, expect, vi, afterEach } from 'vitest';
const agentDispatchCtor = vi.hoisted(() => vi.fn());

vi.mock('livekit-server-sdk', () => {
  class AgentDispatchClient {
    constructor(...args: unknown[]) {
      agentDispatchCtor(...args);
    }
    // Like the real client: createDispatch returns the dispatch (with its id), and
    // listDispatch reports it owning a running job, so the R1 verification passes.
    async createDispatch(): Promise<{ id: string }> {
      return { id: 'mock-dispatch' };
    }
    async listDispatch(): Promise<unknown[]> {
      return [{ id: 'mock-dispatch', state: { jobs: [{ state: { status: 1 } }] } }];
    }
    async deleteDispatch(): Promise<void> {}
  }
  return {
    AgentDispatchClient,
    AccessToken: class {},
    RoomServiceClient: class {},
  };
});
import {
  browserOrchestrationGate,
  type BrowserAgentDispatchClientLike,
  type BrowserWorkerGateDeps,
} from '../lib/browser-orchestration.js';
import { BROWSER_FLY_APP } from '../lib/worker-orchestration-runtime.js';
import type { WorkerOrchestrationService, EnsureReadyResult } from '../lib/worker-orchestration.js';

function fakeService(ensure: EnsureReadyResult): WorkerOrchestrationService & {
  ensureCalls: Array<{ app: string; pipeline: string; sessionId: string }>;
  releaseCalls: Array<{ app: string; machineId: string; sessionId: string }>;
} {
  const ensureCalls: Array<{ app: string; pipeline: string; sessionId: string }> = [];
  const releaseCalls: Array<{ app: string; machineId: string; sessionId: string }> = [];
  return {
    ensureCalls,
    releaseCalls,
    async ensureReadyWorker(input) {
      ensureCalls.push({ app: input.app, pipeline: input.pipeline, sessionId: input.sessionId });
      return ensure;
    },
    async releaseWorker(input) {
      releaseCalls.push(input);
    },
    async releaseWorkerBySession() {
      /* not exercised by the browser gate tests */
    },
    async releaseTerminalSessions() {
      return { released: 0 };
    },
    async markBusy() {
      /* not exercised by the browser gate tests */
    },
    async reapWorkers() {
      return { stopped: 0 };
    },
  };
}

const R1_ENV = [
  'BROWSER_LIVEKIT_TARGET', 'R1_LIVEKIT_URL', 'R1_LIVEKIT_API_KEY', 'R1_LIVEKIT_API_SECRET',
  'BROWSER_DISPATCH_VERIFY_SEC',
] as const;

/** Select the R1 endpoint for the duration of one test (cleaned by afterEach). */
function selectR1(url = 'wss://r1.example.test:7880'): void {
  process.env.BROWSER_LIVEKIT_TARGET = 'r1';
  process.env.R1_LIVEKIT_URL = url;
  process.env.R1_LIVEKIT_API_KEY = 'r1-key';
  process.env.R1_LIVEKIT_API_SECRET = 'r1-secret';
}

afterEach(() => {
  for (const key of R1_ENV) delete process.env[key];
});

const ROOM = 'screening-sess-1';
const SESSION = 'sess-1';

/** A virtual clock: sleeping advances time, so no test waits wall-clock. */
function clockSeams() {
  let clock = 0;
  return {
    now: () => clock,
    sleep: async (ms: number) => { clock += ms; },
    elapsed: () => clock,
  };
}

/**
 * `jobStatus` is the protocol `JobStatus` of every job on the dispatch (0 pending,
 * 1 running, 2 success, 3 failed, or the JSON name); absent means a job with no
 * `status`. `jobEndedAt` is the protocol `JobState.ended_at` of every job (int64
 * as a bigint, number or string); absent means the server never stamped one.
 * `deletedAt` is the dispatch tombstone.
 */
interface Dispatch {
  id: string;
  jobs: number;
  jobStatus?: number | string;
  jobEndedAt?: bigint | number | string;
  deletedAt?: bigint | number | string;
}

/**
 * A scriptable dispatch client over a live set of dispatches. `createDispatch`
 * mints ids `d1`, `d2`, ...; `onCreate` decides the new dispatch's job count;
 * `deleteDispatch` removes it from the set (or leaves it when `keepOnDelete`, or
 * tombstones it with `deletedAt` when `tombstoneOnDelete`); `jobStatus` is given
 * to every job a created dispatch owns.
 */
function scriptedClient(options: {
  onCreate?: (n: number) => number;
  keepOnDelete?: boolean;
  tombstoneOnDelete?: boolean;
  jobStatus?: number | string;
  jobEndedAt?: bigint | number | string;
} = {}) {
  const dispatches: Dispatch[] = [];
  let created = 0;
  const createDispatch = vi.fn(async () => {
    created += 1;
    const record: Dispatch = {
      id: `d${created}`,
      jobs: options.onCreate?.(created) ?? 0,
      jobStatus: options.jobStatus,
      jobEndedAt: options.jobEndedAt,
    };
    dispatches.push(record);
    return { id: record.id };
  });
  const deleteDispatch = vi.fn(async (id: string) => {
    if (options.keepOnDelete) return;
    const at = dispatches.findIndex((item) => item.id === id);
    if (at < 0) return;
    if (options.tombstoneOnDelete) {
      dispatches[at].deletedAt = 1_700_000_000_000n;
      return;
    }
    dispatches.splice(at, 1);
  });
  const listDispatch = vi.fn(async () => dispatches.map((item) => ({
    id: item.id,
    state: {
      jobs: Array.from({ length: item.jobs }, () => (
        item.jobStatus === undefined && item.jobEndedAt === undefined
          ? {}
          : {
              state: {
                ...(item.jobStatus === undefined ? {} : { status: item.jobStatus }),
                ...(item.jobEndedAt === undefined ? {} : { endedAt: item.jobEndedAt }),
              },
            }
      )),
      ...(item.deletedAt === undefined ? {} : { deletedAt: item.deletedAt }),
    },
  })));
  const client: BrowserAgentDispatchClientLike = { createDispatch, deleteDispatch, listDispatch };
  return { client, createDispatch, deleteDispatch, listDispatch, dispatches };
}

interface EndedAtCase {
  label: string;
  status: number | string | undefined;
  endedAt: bigint | number | string | undefined;
  live: boolean;
}

/** A server-stamped end time (int64 ns): the protocol `JobState.ended_at`. */
const ENDED_AT = 1_700_000_000_000n;

function endedCase(
  label: string,
  status: EndedAtCase['status'],
  endedAt: EndedAtCase['endedAt'],
  live: boolean,
): EndedAtCase {
  return { label, status, endedAt, live };
}

function gateWith(
  client: BrowserAgentDispatchClientLike,
  extra: Partial<BrowserWorkerGateDeps> = {},
) {
  const seams = clockSeams();
  const gate = browserOrchestrationGate({
    enabled: true,
    agentName: 'browser-screener',
    service: fakeService({ status: 'ready', machineId: 'm1' }),
    dispatchClient: client,
    roomHasAgent: async () => false,
    dispatchPollMs: 1_000,
    now: seams.now,
    sleep: seams.sleep,
    ...extra,
  })!;
  return { gate, seams };
}

describe('browserOrchestrationGate — the naming+dispatch pairing gate', () => {
  it('is null when orchestration is OFF (byte-identical to today)', () => {
    expect(browserOrchestrationGate({ enabled: false, agentName: 'browser-screener' })).toBeNull();
  });

  it('is null when orchestration is ON but the browser worker is not named', () => {
    // On but no name ⇒ the worker is still unnamed + auto-dispatching; the gate
    // must NOT dispatch (that would be the half-change that stops auto-dispatch
    // without adding explicit dispatch).
    expect(browserOrchestrationGate({ enabled: true, agentName: '' })).toBeNull();
    expect(browserOrchestrationGate({ enabled: true, agentName: '   ' })).toBeNull();
  });

  it('is null (loud fallback) when the configured name is malformed — names_agree', () => {
    // A name that cannot match a worker registration must never be dispatched to.
    expect(browserOrchestrationGate({ enabled: true, agentName: 'bad name with spaces' })).toBeNull();
    expect(browserOrchestrationGate({ enabled: true, agentName: 'x'.repeat(65) })).toBeNull();
  });

  it('builds a gate when ON + a valid name; ensureReadyWorker uses pipeline browser + the browser app', async () => {
    const service = fakeService({ status: 'ready', machineId: 'm1' });
    const gate = browserOrchestrationGate({
      enabled: true,
      agentName: 'browser-screener',
      service,
      dispatchClient: { createDispatch: vi.fn().mockResolvedValue(undefined) },
    });
    expect(gate).not.toBeNull();
    expect(gate!.app).toBe(BROWSER_FLY_APP);
    expect(gate!.agentName).toBe('browser-screener');

    const ready = await gate!.ensureReadyWorker({ sessionId: 'sess-1' });
    expect(ready).toEqual({ status: 'ready', machineId: 'm1' });
    expect(service.ensureCalls).toEqual([
      { app: BROWSER_FLY_APP, pipeline: 'browser', sessionId: 'sess-1' },
    ]);
  });

  it('dispatch createDispatches the EXACT configured name into the room; true on success', async () => {
    const createDispatch = vi.fn().mockResolvedValue(undefined);
    const dispatchClient: BrowserAgentDispatchClientLike = { createDispatch };
    const gate = browserOrchestrationGate({
      enabled: true,
      agentName: 'browser-screener',
      service: fakeService({ status: 'ready', machineId: 'm1' }),
      dispatchClient,
    })!;
    const ok = await gate.dispatch({ sessionId: 'sess-1', roomName: 'screening-sess-1' });
    expect(ok).toBe(true);
    expect(createDispatch).toHaveBeenCalledTimes(1);
    const [roomName, name] = createDispatch.mock.calls[0];
    expect(roomName).toBe('screening-sess-1');
    expect(name).toBe('browser-screener'); // names_agree: dispatch to the exact name
    expect(createDispatch.mock.calls[0][2]).toEqual({
      metadata: JSON.stringify({ session_id: 'sess-1', channel: 'browser' }),
    });
  });

  it('dispatch returns false (never throws) when createDispatch fails — no agent-less token', async () => {
    const dispatchClient: BrowserAgentDispatchClientLike = {
      createDispatch: vi.fn().mockRejectedValue(new Error('livekit down')),
    };
    const gate = browserOrchestrationGate({
      enabled: true,
      agentName: 'browser-screener',
      service: fakeService({ status: 'ready', machineId: 'm1' }),
      dispatchClient,
    })!;
    const ok = await gate.dispatch({ sessionId: 'sess-1', roomName: 'screening-sess-1' });
    expect(ok).toBe(false);
  });

  it('dispatches through the selected R1 endpoint', async () => {
    selectR1('wss://r1.example.test');
    const gate = browserOrchestrationGate({
      enabled: true,
      agentName: 'browser-screener',
      service: fakeService({ status: 'ready', machineId: 'm1' }),
    })!;
    await expect(
      gate.dispatch({ sessionId: 'sess-1', roomName: 'screening-sess-1' }),
    ).resolves.toBe(true);
    expect(agentDispatchCtor).toHaveBeenLastCalledWith(
      'wss://r1.example.test', 'r1-key', 'r1-secret',
    );
  });

  it('releaseWorker delegates to the service (fail-open, never throws)', async () => {
    const service = fakeService({ status: 'ready', machineId: 'm1' });
    const gate = browserOrchestrationGate({
      enabled: true,
      agentName: 'browser-screener',
      service,
      dispatchClient: { createDispatch: vi.fn() },
    })!;
    await gate.releaseWorker({ machineId: 'm1', sessionId: 'sess-1' });
    expect(service.releaseCalls).toEqual([
      { app: BROWSER_FLY_APP, machineId: 'm1', sessionId: 'sess-1' },
    ]);
  });
});

describe('Cloud target — byte-identical to origin/main (the live lane)', () => {
  it.each([
    ['absent host', { status: 'ready', machineId: 'm1' }],
    ['null host', { status: 'ready', machineId: 'm1', livekitHost: null }],
    [
      'a host that differs from the Cloud URL',
      { status: 'ready', machineId: 'm1', livekitHost: 'wrong.example.test' },
    ],
    ['a host equal to nothing', { status: 'ready', machineId: 'm1', livekitHost: '' }],
  ] as Array<[string, EnsureReadyResult]>)(
    'returns the ready verdict untouched and never releases (%s)', async (_label, verdict) => {
      const service = fakeService(verdict);
      const gate = browserOrchestrationGate({
        enabled: true,
        agentName: 'browser-screener',
        service,
        dispatchClient: { createDispatch: vi.fn() },
      })!;
      await expect(gate.ensureReadyWorker({ sessionId: SESSION })).resolves.toBe(verdict);
      expect(service.releaseCalls).toEqual([]);
    },
  );

  it('passes every non-ready verdict through, on Cloud and on R1', async () => {
    for (const target of ['cloud', 'r1'] as const) {
      if (target === 'r1') selectR1();
      for (const verdict of [
        { status: 'no_capacity' }, { status: 'timeout' }, { status: 'disabled' },
        { status: 'error', code: 'fly_down' },
      ] as EnsureReadyResult[]) {
        const gate = browserOrchestrationGate({
          enabled: true,
          agentName: 'browser-screener',
          service: fakeService(verdict),
          dispatchClient: { createDispatch: vi.fn() },
        })!;
        await expect(gate.ensureReadyWorker({ sessionId: SESSION })).resolves.toBe(verdict);
      }
    }
  });

  it('dispatch is one createDispatch: no listDispatch, deleteDispatch or sleep', async () => {
    // A client that would trigger the whole R1 safeguard if it ran: the dispatch
    // never owns a job.
    const scripted = scriptedClient();
    const sleep = vi.fn(async () => undefined);
    const roomHasAgent = vi.fn(async () => false);
    const { gate } = gateWith(scripted.client, { sleep, roomHasAgent });
    await expect(gate.dispatch({ sessionId: SESSION, roomName: ROOM })).resolves.toBe(true);
    expect(scripted.createDispatch).toHaveBeenCalledTimes(1);
    expect(scripted.listDispatch).not.toHaveBeenCalled();
    expect(scripted.deleteDispatch).not.toHaveBeenCalled();
    expect(roomHasAgent).not.toHaveBeenCalled();
    expect(sleep).not.toHaveBeenCalled();
  });

  it('a Cloud target selected explicitly by any non-r1 value behaves identically', async () => {
    process.env.BROWSER_LIVEKIT_TARGET = 'R1';
    const scripted = scriptedClient();
    const { gate } = gateWith(scripted.client);
    await expect(gate.dispatch({ sessionId: SESSION, roomName: ROOM })).resolves.toBe(true);
    expect(scripted.listDispatch).not.toHaveBeenCalled();
  });

  it('createDispatch failure still returns false on Cloud', async () => {
    const { gate } = gateWith({ createDispatch: vi.fn().mockRejectedValue(new Error('down')) });
    await expect(gate.dispatch({ sessionId: SESSION, roomName: ROOM })).resolves.toBe(false);
  });
});

describe('R1 target — durable host match', () => {
  it('rejects an absent or mismatched lease host before dispatch, releases the claim', async () => {
    selectR1();
    const cases: EnsureReadyResult[] = [
      { status: 'ready', machineId: 'm1', livekitHost: null },
      { status: 'ready', machineId: 'm1' }, // reader did not select the column
      { status: 'ready', machineId: 'm1', livekitHost: 'wrong.example.test' },
    ];
    for (const verdict of cases) {
      const service = fakeService(verdict);
      const gate = browserOrchestrationGate({
        enabled: true,
        agentName: 'browser-screener',
        service,
        dispatchClient: { createDispatch: vi.fn() },
      })!;
      await expect(gate.ensureReadyWorker({ sessionId: SESSION })).resolves.toEqual({
        status: 'timeout',
      });
      expect(service.releaseCalls).toEqual([
        { app: BROWSER_FLY_APP, machineId: 'm1', sessionId: SESSION },
      ]);
    }
  });

  it('accepts only the exact durable lease host (case-insensitive URL, port ignored)', async () => {
    selectR1('wss://R1.Example.Test:7880/path');
    const verdict: EnsureReadyResult = {
      status: 'ready',
      machineId: 'm1',
      livekitHost: 'r1.example.test',
    };
    const service = fakeService(verdict);
    const gate = browserOrchestrationGate({
      enabled: true,
      agentName: 'browser-screener',
      service,
      dispatchClient: { createDispatch: vi.fn() },
    })!;
    await expect(gate.ensureReadyWorker({ sessionId: SESSION })).resolves.toBe(verdict);
    expect(service.releaseCalls).toEqual([]);
  });

  it('fails closed when the R1 URL has no hostname, even for a null report', async () => {
    for (const url of ['', 'not a url']) {
      selectR1(url);
      const service = fakeService({ status: 'ready', machineId: 'm1', livekitHost: null });
      const gate = browserOrchestrationGate({
        enabled: true,
        agentName: 'browser-screener',
        service,
        dispatchClient: { createDispatch: vi.fn() },
      })!;
      await expect(gate.ensureReadyWorker({ sessionId: SESSION })).resolves.toEqual({
        status: 'timeout',
      });
      expect(service.releaseCalls).toHaveLength(1);
    }
  });

  it('a failing release never throws out of the host mismatch path', async () => {
    selectR1();
    const service = fakeService({
      status: 'ready',
      machineId: 'm1',
      livekitHost: 'wrong.example.test',
    });
    service.releaseWorker = async () => { throw new Error('fly down'); };
    const gate = browserOrchestrationGate({
      enabled: true,
      agentName: 'browser-screener',
      service,
      dispatchClient: { createDispatch: vi.fn() },
    })!;
    await expect(gate.ensureReadyWorker({ sessionId: SESSION })).resolves.toEqual({
      status: 'timeout',
    });
  });
});

describe('R1 target — dispatch-drop safeguard (never two agents)', () => {
  it('never re-dispatches once the dispatch owns a job', async () => {
    selectR1();
    const scripted = scriptedClient({ onCreate: () => 1 });
    const { gate } = gateWith(scripted.client);
    await expect(gate.dispatch({ sessionId: SESSION, roomName: ROOM })).resolves.toBe(true);
    expect(scripted.createDispatch).toHaveBeenCalledTimes(1);
    expect(scripted.deleteDispatch).not.toHaveBeenCalled();
  });

  it('treats a job on ANY dispatch in the room as an existing agent', async () => {
    selectR1();
    const scripted = scriptedClient();
    scripted.dispatches.push({ id: 'earlier-exchange', jobs: 1 });
    const { gate } = gateWith(scripted.client);
    await expect(gate.dispatch({ sessionId: SESSION, roomName: ROOM })).resolves.toBe(true);
    expect(scripted.deleteDispatch).not.toHaveBeenCalled();
    expect(scripted.createDispatch).toHaveBeenCalledTimes(1);
  });

  it('a slow-but-alive dispatch inside the window is accepted, never deleted', async () => {
    selectR1();
    const scripted = scriptedClient();
    const { gate, seams } = gateWith(scripted.client);
    // The worker takes the job 7 s in: above the old 8 s clamp's comfort zone,
    // inside the 10 s window.
    scripted.listDispatch.mockImplementation(async () => [
      { id: 'd1', state: { jobs: seams.elapsed() >= 7_000 ? [{}] : [] } },
    ]);
    await expect(gate.dispatch({ sessionId: SESSION, roomName: ROOM })).resolves.toBe(true);
    expect(scripted.deleteDispatch).not.toHaveBeenCalled();
    expect(scripted.createDispatch).toHaveBeenCalledTimes(1);
  });

  it('deletes a dropped dispatch, proves the room clear, retries once, and succeeds', async () => {
    selectR1();
    const scripted = scriptedClient({ onCreate: (n) => (n === 1 ? 0 : 1) });
    const roomHasAgent = vi.fn(async () => false);
    const { gate } = gateWith(scripted.client, { roomHasAgent });
    await expect(gate.dispatch({ sessionId: SESSION, roomName: ROOM })).resolves.toBe(true);
    expect(scripted.deleteDispatch.mock.calls).toEqual([['d1', ROOM]]);
    expect(scripted.createDispatch).toHaveBeenCalledTimes(2);
    expect(roomHasAgent).toHaveBeenCalledWith(ROOM);
    // the delete (and its proof) strictly precede the second dispatch
    expect(scripted.deleteDispatch.mock.invocationCallOrder[0])
      .toBeLessThan(scripted.createDispatch.mock.invocationCallOrder[1]);
    expect(roomHasAgent.mock.invocationCallOrder[0])
      .toBeLessThan(scripted.createDispatch.mock.invocationCallOrder[1]);
  });

  it('the FINAL dropped verdict deletes the retry dispatch too, then returns false', async () => {
    selectR1();
    const scripted = scriptedClient();
    const { gate } = gateWith(scripted.client);
    await expect(gate.dispatch({ sessionId: SESSION, roomName: ROOM })).resolves.toBe(false);
    expect(scripted.createDispatch).toHaveBeenCalledTimes(2);
    expect(scripted.deleteDispatch.mock.calls).toEqual([['d1', ROOM], ['d2', ROOM]]);
    expect(scripted.dispatches).toEqual([]); // nothing left that could still win a job
  });

  it('a failing delete of the final retry still returns false, never throws', async () => {
    selectR1();
    const scripted = scriptedClient();
    scripted.deleteDispatch
      .mockImplementationOnce(async () => { scripted.dispatches.splice(0, 1); })
      .mockRejectedValueOnce(new Error('livekit down'));
    const { gate } = gateWith(scripted.client);
    await expect(gate.dispatch({ sessionId: SESSION, roomName: ROOM })).resolves.toBe(false);
    expect(scripted.createDispatch).toHaveBeenCalledTimes(2);
  });

  it('never re-dispatches while an agent participant is already in the room', async () => {
    selectR1();
    const scripted = scriptedClient();
    const { gate } = gateWith(scripted.client, { roomHasAgent: async () => true });
    await expect(gate.dispatch({ sessionId: SESSION, roomName: ROOM })).resolves.toBe(true);
    expect(scripted.createDispatch).toHaveBeenCalledTimes(1);
    expect(scripted.deleteDispatch).toHaveBeenCalledTimes(1);
  });

  it('never re-dispatches when a job appears while the first is being retired', async () => {
    selectR1();
    const scripted = scriptedClient();
    // The late job lands exactly as the dropped dispatch is deleted.
    scripted.deleteDispatch.mockImplementationOnce(async () => {
      scripted.dispatches.splice(0, 1, { id: 'late-winner', jobs: 1 });
    });
    const { gate } = gateWith(scripted.client);
    await expect(gate.dispatch({ sessionId: SESSION, roomName: ROOM })).resolves.toBe(true);
    expect(scripted.createDispatch).toHaveBeenCalledTimes(1);
  });

  it('no re-dispatch while the deleted dispatch is still listed (unproven → false)', async () => {
    selectR1();
    const scripted = scriptedClient({ keepOnDelete: true });
    const { gate } = gateWith(scripted.client);
    await expect(gate.dispatch({ sessionId: SESSION, roomName: ROOM })).resolves.toBe(false);
    expect(scripted.createDispatch).toHaveBeenCalledTimes(1);
    expect(scripted.deleteDispatch).toHaveBeenCalledTimes(1);
  });

  it('does not re-dispatch when the agent-presence check fails (unproven → false)', async () => {
    selectR1();
    const scripted = scriptedClient();
    const { gate } = gateWith(scripted.client, {
      roomHasAgent: async () => { throw new Error('rooms unavailable'); },
    });
    await expect(gate.dispatch({ sessionId: SESSION, roomName: ROOM })).resolves.toBe(false);
    expect(scripted.createDispatch).toHaveBeenCalledTimes(1);
  });

  it('does not re-dispatch when listDispatch fails while retiring (unproven → false)', async () => {
    selectR1();
    const scripted = scriptedClient();
    const { gate } = gateWith(scripted.client);
    scripted.deleteDispatch.mockImplementationOnce(async () => {
      scripted.listDispatch.mockRejectedValue(new Error('list down'));
    });
    await expect(gate.dispatch({ sessionId: SESSION, roomName: ROOM })).resolves.toBe(false);
    expect(scripted.createDispatch).toHaveBeenCalledTimes(1);
  });

  it('a deleteDispatch that throws returns false and never creates a second dispatch', async () => {
    selectR1();
    const scripted = scriptedClient();
    scripted.deleteDispatch.mockRejectedValue(new Error('delete down'));
    const { gate } = gateWith(scripted.client);
    await expect(gate.dispatch({ sessionId: SESSION, roomName: ROOM })).resolves.toBe(false);
    expect(scripted.createDispatch).toHaveBeenCalledTimes(1);
  });

  it('FAIL CLOSED: a client that cannot identify or list its dispatch mints no token', async () => {
    selectR1();
    // No dispatch id: nothing to watch and nothing to delete.
    const noId = scriptedClient();
    noId.createDispatch.mockResolvedValue(undefined as never);
    await expect(gateWith(noId.client).gate.dispatch({ sessionId: SESSION, roomName: ROOM }))
      .resolves.toBe(false);
    expect(noId.listDispatch).not.toHaveBeenCalled();
    expect(noId.deleteDispatch).not.toHaveBeenCalled();
    expect(noId.createDispatch).toHaveBeenCalledTimes(1);

    // No listDispatch: acceptance cannot be verified at all.
    const noList = {
      createDispatch: vi.fn().mockResolvedValue({ id: 'd1' }),
      deleteDispatch: vi.fn().mockResolvedValue(undefined),
    };
    await expect(gateWith(noList).gate.dispatch({ sessionId: SESSION, roomName: ROOM }))
      .resolves.toBe(false);
    expect(noList.createDispatch).toHaveBeenCalledTimes(1);
  });

  it('FAIL CLOSED: an unretirable dropped dispatch mints no token, adds no second', async () => {
    selectR1();
    const noDelete = scriptedClient();
    const client: BrowserAgentDispatchClientLike = {
      createDispatch: noDelete.createDispatch,
      listDispatch: noDelete.listDispatch,
    };
    await expect(gateWith(client).gate.dispatch({ sessionId: SESSION, roomName: ROOM }))
      .resolves.toBe(false);
    expect(noDelete.createDispatch).toHaveBeenCalledTimes(1);
  });

  it('FAIL CLOSED: a list failure mints no token, never re-dispatches, discards it', async () => {
    selectR1();
    const failing = scriptedClient();
    failing.listDispatch.mockRejectedValue(new Error('list down'));
    await expect(gateWith(failing.client).gate.dispatch({ sessionId: SESSION, roomName: ROOM }))
      .resolves.toBe(false);
    expect(failing.createDispatch).toHaveBeenCalledTimes(1);
    expect(failing.deleteDispatch.mock.calls).toEqual([['d1', ROOM]]);
  });

  it('FAIL CLOSED: a vanished dispatch mints no token and is never re-dispatched', async () => {
    selectR1();
    const vanished = scriptedClient();
    vanished.listDispatch.mockResolvedValue([]);
    await expect(gateWith(vanished.client).gate.dispatch({ sessionId: SESSION, roomName: ROOM }))
      .resolves.toBe(false);
    expect(vanished.createDispatch).toHaveBeenCalledTimes(1);
  });

  it('FAIL CLOSED: an unverifiable RETRY mints no token and the retry is discarded', async () => {
    selectR1();
    const scripted = scriptedClient();
    // d1 drops and is retired cleanly; then the room's listing fails for the retry.
    scripted.createDispatch.mockImplementationOnce(async () => {
      scripted.dispatches.push({ id: 'd1', jobs: 0 });
      return { id: 'd1' };
    });
    scripted.createDispatch.mockImplementationOnce(async () => {
      scripted.listDispatch.mockRejectedValue(new Error('list down'));
      return { id: 'd2' };
    });
    const { gate } = gateWith(scripted.client);
    await expect(gate.dispatch({ sessionId: SESSION, roomName: ROOM })).resolves.toBe(false);
    expect(scripted.createDispatch).toHaveBeenCalledTimes(2);
    expect(scripted.deleteDispatch.mock.calls).toEqual([['d1', ROOM], ['d2', ROOM]]);
  });

  it('a failing discard of an unverifiable dispatch answers false, never throws', async () => {
    selectR1();
    const scripted = scriptedClient();
    scripted.listDispatch.mockRejectedValue(new Error('list down'));
    scripted.deleteDispatch.mockRejectedValue(new Error('delete down'));
    await expect(gateWith(scripted.client).gate.dispatch({ sessionId: SESSION, roomName: ROOM }))
      .resolves.toBe(false);
    expect(scripted.createDispatch).toHaveBeenCalledTimes(1);
  });

  it('an ASSIGNED dispatch is the only way to a true on R1 (control)', async () => {
    selectR1();
    const scripted = scriptedClient({ onCreate: () => 1, jobStatus: 1 });
    await expect(gateWith(scripted.client).gate.dispatch({ sessionId: SESSION, roomName: ROOM }))
      .resolves.toBe(true);
    expect(scripted.deleteDispatch).not.toHaveBeenCalled();
  });

  it.each([
    ['JS_PENDING (0)', 0, true],
    ['JS_RUNNING (1)', 1, true],
    ['JS_SUCCESS (2)', 2, false],
    ['JS_FAILED (3)', 3, false],
    ['the JSON name JS_RUNNING', 'JS_RUNNING', true],
    ['the JSON name JS_SUCCESS', 'JS_SUCCESS', false],
    ['the JSON name JS_FAILED', 'JS_FAILED', false],
    ['an unrecognised status', 99, true],
  ] as Array<[string, number | string, boolean]>)(
    'a job in %s: counts as an agent = %s', async (_label, status, live) => {
      selectR1();
      // The dispatch owns exactly one job in that status.
      const scripted = scriptedClient({ onCreate: () => 1, jobStatus: status });
      const { gate } = gateWith(scripted.client);
      await expect(gate.dispatch({ sessionId: SESSION, roomName: ROOM })).resolves.toBe(live);
      // Live: accepted at once, nothing deleted. Finished: job-less (dropped), so
      // the first dispatch is retired and the retry (also finished) is dropped too.
      expect(scripted.createDispatch).toHaveBeenCalledTimes(live ? 1 : 2);
      expect(scripted.deleteDispatch).toHaveBeenCalledTimes(live ? 0 : 2);
    },
  );

  it('a finished job from an earlier exchange does not make a dispatch look accepted', async () => {
    selectR1();
    const scripted = scriptedClient({ onCreate: (n) => (n === 1 ? 0 : 1), jobStatus: 1 });
    scripted.dispatches.push({ id: 'earlier-exchange', jobs: 1, jobStatus: 2 });
    const { gate } = gateWith(scripted.client);
    await expect(gate.dispatch({ sessionId: SESSION, roomName: ROOM })).resolves.toBe(true);
    // Had the dead job counted, d1 would have been "assigned" with no delete.
    expect(scripted.deleteDispatch.mock.calls).toEqual([['d1', ROOM]]);
    expect(scripted.createDispatch).toHaveBeenCalledTimes(2);
  });

  it.each<EndedAtCase>([
    endedCase('JS_RUNNING with a bigint endedAt', 1, ENDED_AT, false),
    endedCase('JS_RUNNING with a number endedAt', 1, Number(ENDED_AT), false),
    endedCase('JS_RUNNING with a numeric-string endedAt', 1, '1700000000000', false),
    endedCase('the JSON name JS_RUNNING with endedAt', 'JS_RUNNING', ENDED_AT, false),
    endedCase('JS_PENDING with endedAt', 0, ENDED_AT, false),
    endedCase('no status at all, endedAt set', undefined, ENDED_AT, false),
    endedCase('JS_RUNNING with a zero bigint endedAt', 1, 0n, true),
    endedCase('JS_RUNNING with a zero number endedAt', 1, 0, true),
    endedCase('JS_RUNNING with a zero-string endedAt', 1, '0', true),
    endedCase('JS_RUNNING with an empty-string endedAt', 1, '', true),
    endedCase('JS_RUNNING with a garbage endedAt', 1, 'soon', true),
    endedCase('JS_RUNNING with a fractional endedAt', 1, 1.5, true),
    endedCase('JS_RUNNING with no endedAt at all (the control)', 1, undefined, true),
    endedCase('no state at all (proto3 default JS_PENDING)', undefined, undefined, true),
  ])(
    'a job in $label: counts as an agent = $live', async ({ status, endedAt, live }) => {
      selectR1();
      const scripted = scriptedClient({
        onCreate: () => 1,
        jobStatus: status,
        jobEndedAt: endedAt,
      });
      const { gate } = gateWith(scripted.client);
      await expect(gate.dispatch({ sessionId: SESSION, roomName: ROOM })).resolves.toBe(live);
      // Live: accepted at once. Over (a set endedAt is proof): job-less, so the
      // first dispatch is retired and the retry (also over) is dropped too.
      expect(scripted.createDispatch).toHaveBeenCalledTimes(live ? 1 : 2);
      expect(scripted.deleteDispatch).toHaveBeenCalledTimes(live ? 0 : 2);
    },
  );

  it('an orphaned job stamped as ended does not make the next dispatch look accepted', async () => {
    selectR1();
    // The earlier exchange abandoned its dispatch, the machine was stopped, and the
    // server kept the orphaned job at JS_RUNNING but stamped state.endedAt.
    const scripted = scriptedClient({ onCreate: (n) => (n === 1 ? 0 : 1), jobStatus: 1 });
    scripted.dispatches.push({
      id: 'orphan',
      jobs: 1,
      jobStatus: 1,
      jobEndedAt: ENDED_AT,
    });
    const { gate } = gateWith(scripted.client);
    await expect(gate.dispatch({ sessionId: SESSION, roomName: ROOM })).resolves.toBe(true);
    // Had the orphan counted, d1 would have been "assigned" with no delete.
    expect(scripted.deleteDispatch.mock.calls).toEqual([['d1', ROOM]]);
    expect(scripted.createDispatch).toHaveBeenCalledTimes(2);
  });

  it('PINNED RESIDUAL: an orphan still JS_RUNNING with no endedAt keeps counting', async () => {
    selectR1();
    // Whether OSS ever leaves a stopped machine's job like this is the open S0-F3
    // observation (runbook, "S0-F3 dispatch-matrix rerun"). Until that evidence
    // exists the any-dispatch rule must not relax: a live-looking job may be a real
    // agent, and a second one is worse.
    const scripted = scriptedClient();
    scripted.dispatches.push({ id: 'orphan', jobs: 1, jobStatus: 1 });
    const { gate } = gateWith(scripted.client);
    await expect(gate.dispatch({ sessionId: SESSION, roomName: ROOM })).resolves.toBe(true);
    expect(scripted.deleteDispatch).not.toHaveBeenCalled();
    expect(scripted.createDispatch).toHaveBeenCalledTimes(1);
  });

  it('a tombstoning server still lets a retired dispatch be proven gone', async () => {
    selectR1();
    const scripted = scriptedClient({
      onCreate: (n) => (n === 1 ? 0 : 1),
      tombstoneOnDelete: true,
      jobStatus: 1,
    });
    const { gate } = gateWith(scripted.client);
    await expect(gate.dispatch({ sessionId: SESSION, roomName: ROOM })).resolves.toBe(true);
    expect(scripted.deleteDispatch.mock.calls).toEqual([['d1', ROOM]]);
    expect(scripted.createDispatch).toHaveBeenCalledTimes(2);
  });

  it.each([
    ['a bigint timestamp', 1_700_000_000_000n, true],
    ['a number timestamp', 1_700_000_000_000, true],
    ['a numeric string timestamp', '1700000000000', true],
    ['a zero bigint', 0n, false],
    ['a zero number', 0, false],
    ['a zero string', '0', false],
    ['an empty string', '', false],
    ['garbage', 'x', false],
    ['an absent value', undefined, false],
  ] as Array<[string, bigint | number | string | undefined, boolean]>)(
    'deletedAt as %s: tombstone = %s', async (_label, deletedAt, tombstone) => {
      selectR1();
      const scripted = scriptedClient();
      const seams = clockSeams();
      scripted.listDispatch.mockImplementation(async () => [
        {
          id: 'd1',
          state: { jobs: [], ...(deletedAt === undefined ? {} : { deletedAt }) },
        },
      ]);
      const gate = browserOrchestrationGate({
        enabled: true,
        agentName: 'browser-screener',
        service: fakeService({ status: 'ready', machineId: 'm1' }),
        dispatchClient: scripted.client,
        roomHasAgent: async () => false,
        dispatchPollMs: 1_000,
        now: seams.now,
        sleep: seams.sleep,
      })!;
      await expect(gate.dispatch({ sessionId: SESSION, roomName: ROOM })).resolves.toBe(false);
      expect(scripted.createDispatch).toHaveBeenCalledTimes(1);
      if (tombstone) {
        // Not listed => unverifiable at once: no window was waited out.
        expect(seams.elapsed()).toBe(0);
      } else {
        // Still listed and job-less: the whole 10 s window passes (a real drop),
        // then the retire proof (3 s) cannot see it leave => unproven.
        expect(seams.elapsed()).toBe(13_000);
      }
      // Either way exactly one delete: the discard, or the retire attempt.
      expect(scripted.deleteDispatch).toHaveBeenCalledTimes(1);
    },
  );

  it.each([
    ['unset', undefined, 10_000],
    ['5', '5', 5_000],
    ['" 7.5 " is trimmed', ' 7.5 ', 7_500],
    ['0.2 clamps up to the 1 s floor', '0.2', 1_000],
    ['99 clamps down to 15 s', '99', 15_000],
    ['garbage falls back to 10 s', 'soon', 10_000],
    ['blank falls back to 10 s, never the 1 s floor', '', 10_000],
    ['whitespace falls back to 10 s', '   ', 10_000],
    ['0 is no usable window: 10 s', '0', 10_000],
    ['negative falls back to 10 s', '-5', 10_000],
    ['negative zero falls back to 10 s', '-0', 10_000],
    ['Infinity falls back to 10 s', 'Infinity', 10_000],
  ] as Array<[string, string | undefined, number]>)(
    'verification window BROWSER_DISPATCH_VERIFY_SEC %s', async (_label, value, expectedMs) => {
      selectR1();
      if (value !== undefined) process.env.BROWSER_DISPATCH_VERIFY_SEC = value;
      const scripted = scriptedClient();
      const seams = clockSeams();
      let droppedAt = -1;
      scripted.deleteDispatch.mockImplementationOnce(async (id: string) => {
        droppedAt = seams.elapsed();
        const at = scripted.dispatches.findIndex((item) => item.id === id);
        scripted.dispatches.splice(at, 1);
      });
      const gate = browserOrchestrationGate({
        enabled: true,
        agentName: 'browser-screener',
        service: fakeService({ status: 'ready', machineId: 'm1' }),
        dispatchClient: scripted.client,
        roomHasAgent: async () => false,
        dispatchPollMs: 1_000,
        now: seams.now,
        sleep: seams.sleep,
      })!;
      await gate.dispatch({ sessionId: SESSION, roomName: ROOM });
      expect(droppedAt).toBe(expectedMs);
    },
  );

  it('polls on real timers and the real clock when no sleep or now is injected', async () => {
    selectR1();
    vi.useFakeTimers();
    try {
      const scripted = scriptedClient();
      const gate = browserOrchestrationGate({
        enabled: true,
        agentName: 'browser-screener',
        service: fakeService({ status: 'ready', machineId: 'm1' }),
        dispatchClient: scripted.client,
        roomHasAgent: async () => false,
        dispatchVerifyMs: 3_000,
        dispatchPollMs: 1_000,
      })!;
      const startedAt = Date.now();
      const settled = gate.dispatch({ sessionId: SESSION, roomName: ROOM });
      await vi.advanceTimersByTimeAsync(60_000);
      await expect(settled).resolves.toBe(false);
      // Two 3 s windows (the dispatch and its retry), each polled once a second:
      // only a sleep that really waits on the timer can have walked the clock.
      expect(scripted.listDispatch.mock.calls.length).toBeGreaterThanOrEqual(8);
      expect(vi.getTimerCount()).toBe(0);
      expect(Date.now() - startedAt).toBe(60_000);
    } finally {
      vi.useRealTimers();
    }
  });

  it('lazy RoomService agent check (none injected) fails closed if it cannot run', async () => {
    selectR1();
    // The mocked SDK's RoomServiceClient has no listParticipants, so the default
    // check rejects: the retry must be blocked, not allowed.
    const scripted = scriptedClient();
    const seams = clockSeams();
    const gate = browserOrchestrationGate({
      enabled: true,
      agentName: 'browser-screener',
      service: fakeService({ status: 'ready', machineId: 'm1' }),
      dispatchClient: scripted.client,
      dispatchPollMs: 1_000,
      now: seams.now,
      sleep: seams.sleep,
    })!;
    await expect(gate.dispatch({ sessionId: SESSION, roomName: ROOM })).resolves.toBe(false);
    expect(scripted.createDispatch).toHaveBeenCalledTimes(1);
  });
});
