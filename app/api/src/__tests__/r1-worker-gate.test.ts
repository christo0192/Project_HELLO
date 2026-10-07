import { describe, expect, it, vi } from 'vitest';
import type { BrowserWorkerGate } from '../lib/browser-orchestration.js';
import {
  JOBLESS_DISPATCH_GRACE_MS,
  epochMs,
  runR1WorkerGate,
  serialize,
  type DispatchLike,
} from '../lib/r1/worker-gate.js';

const SESSION = '30000000-0000-4000-8000-0000000000e1';
const ROOM = `screening-${SESSION}`;
const NOW = Date.parse('2030-01-01T00:00:00.000Z');
const clock = () => NOW;

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

/** LiveKit's `createdAt` for a dispatch made `ageMs` ago, in epoch nanoseconds. */
const created = (ageMs: number): bigint => BigInt(NOW - ageMs) * 1_000_000n;

const running = (id = 'AD_run', over: Partial<DispatchLike> = {}): DispatchLike => ({
  id,
  agentName: 'browser-screener',
  state: { jobs: [{ id: 'AJ_1' }], createdAt: created(60_000) },
  ...over,
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

const run = (gate: BrowserWorkerGate | null, list: ReturnType<typeof lister>) =>
  runR1WorkerGate({
    gate, sessionId: SESSION, roomName: ROOM, dispatches: () => list, now: clock,
  });

describe('R1 worker gate', () => {
  it('proceeds with no gate (orchestration off) and touches nothing', async () => {
    const dispatches = vi.fn();
    expect(await runR1WorkerGate({
      gate: null, sessionId: SESSION, roomName: ROOM, dispatches,
    })).toBe('proceed');
    expect(dispatches).not.toHaveBeenCalled();
  });

  it('proceeds without dispatching when the service answers disabled', async () => {
    const gate = gateWith({ ensureReadyWorker: vi.fn(async () => ({ status: 'disabled' })) });
    expect(await run(gate, lister())).toBe('proceed');
    expect(gate.dispatch).not.toHaveBeenCalled();
  });

  it.each(['no_capacity', 'timeout', 'error'])('defers on %s, no dispatch', async (status) => {
    const gate = gateWith({ ensureReadyWorker: vi.fn(async () => ({ status })) });
    const list = lister();
    expect(await run(gate, list)).toBe('preparing');
    expect(gate.dispatch).not.toHaveBeenCalled();
    expect(gate.releaseWorker).not.toHaveBeenCalled();
    expect(list.deleteDispatch).not.toHaveBeenCalled();
  });

  it('dispatches once when the room has no dispatch for the agent yet', async () => {
    const gate = gateWith();
    const list = lister([{ agentName: 'some-other-agent', id: 'AD_other' }]);
    expect(await run(gate, list)).toBe('proceed');
    expect(list.listDispatch).toHaveBeenCalledWith(ROOM);
    expect(gate.dispatch).toHaveBeenCalledWith({ sessionId: SESSION, roomName: ROOM });
    // Another agent's dispatch is never ours to delete.
    expect(list.deleteDispatch).not.toHaveBeenCalled();
  });

  it('defers instead of guessing when the dispatch list cannot be read', async () => {
    const gate = gateWith();
    expect(await runR1WorkerGate({
      gate,
      sessionId: SESSION,
      roomName: ROOM,
      dispatches: () => ({ listDispatch: async () => { throw new Error('boom'); } }),
      now: clock,
    })).toBe('preparing');
    expect(gate.ensureReadyWorker).not.toHaveBeenCalled();
    expect(gate.dispatch).not.toHaveBeenCalled();
  });

  it('releases the claimed worker and defers when the dispatch fails', async () => {
    const gate = gateWith({ dispatch: vi.fn(async () => false) });
    expect(await run(gate, lister())).toBe('preparing');
    expect(gate.releaseWorker).toHaveBeenCalledWith({ machineId: 'm1', sessionId: SESSION });
  });

  it('serializes simultaneous calls for one session so only one dispatches', async () => {
    const listed: DispatchLike[] = [];
    const gate = gateWith({
      dispatch: vi.fn(async () => {
        await new Promise((resolve) => setTimeout(resolve, 5));
        listed.push(running());
        return true;
      }),
    });
    const list = lister(listed);
    const verdicts = await Promise.all([run(gate, list), run(gate, list)]);
    expect(verdicts).toEqual(['proceed', 'proceed']);
    expect(gate.dispatch).toHaveBeenCalledTimes(1);
    expect(gate.ensureReadyWorker).toHaveBeenCalledTimes(1);
  });

  it('does not serialize different sessions against each other', async () => {
    const order: string[] = [];
    const slow = serialize('a', async () => {
      await new Promise((resolve) => setTimeout(resolve, 20));
      order.push('a');
    });
    const fast = serialize('b', async () => {
      order.push('b');
    });
    await Promise.all([slow, fast]);
    expect(order).toEqual(['b', 'a']);
  });

  it('keeps the queue healthy after a failing call', async () => {
    const failing = serialize('c', async () => {
      throw new Error('first');
    });
    await expect(failing).rejects.toThrow('first');
    await expect(serialize('c', async () => 'second')).resolves.toBe('second');
  });
});

describe('R1 worker gate: a running interviewer is never re-gated (rejoin, refresh)', () => {
  it('dispatches nothing and never touches the worker pool while a job runs', async () => {
    const gate = gateWith();
    const list = lister([running()]);
    expect(await run(gate, list)).toBe('proceed');
    // ensureReadyWorker would re-claim the machine and call startMachine on a
    // machine that is hosting a live interview.
    expect(gate.ensureReadyWorker).not.toHaveBeenCalled();
    expect(gate.dispatch).not.toHaveBeenCalled();
    expect(gate.releaseWorker).not.toHaveBeenCalled();
    expect(list.deleteDispatch).not.toHaveBeenCalled();
  });

  it('keeps proceeding on every rejoin: one worker readied and one dispatch in total', async () => {
    const live: DispatchLike[] = [];
    const gate = gateWith({
      dispatch: vi.fn(async () => {
        live.push(running());
        return true;
      }),
    });
    const list = lister(live);
    for (let rejoin = 0; rejoin < 4; rejoin += 1) {
      expect(await run(gate, list)).toBe('proceed');
    }
    expect(gate.ensureReadyWorker).toHaveBeenCalledTimes(1);
    expect(gate.dispatch).toHaveBeenCalledTimes(1);
  });

  it('a failing worker start on a re-gate can never release the live claim', async () => {
    // The real service answers `error` when startMachine fails on a machine that
    // is already running; the gate must never ask in the first place.
    const gate = gateWith({ ensureReadyWorker: vi.fn(async () => ({ status: 'error' })) });
    expect(await run(gate, lister([running()]))).toBe('proceed');
    expect(gate.ensureReadyWorker).not.toHaveBeenCalled();
    expect(gate.releaseWorker).not.toHaveBeenCalled();
  });

  it('still proceeds on a running dispatch when the service flag is off', async () => {
    const gate = gateWith({ ensureReadyWorker: vi.fn(async () => ({ status: 'disabled' })) });
    expect(await run(gate, lister([running()]))).toBe('proceed');
  });
});

describe('R1 worker gate: a dispatch only counts when a worker took the job', () => {
  it('defers on a young job-less dispatch: another exchange is mid-dispatch', async () => {
    const gate = gateWith();
    const list = lister([jobless(2_000)]);
    expect(await run(gate, list)).toBe('preparing');
    expect(gate.ensureReadyWorker).not.toHaveBeenCalled();
    expect(gate.dispatch).not.toHaveBeenCalled();
    expect(gate.releaseWorker).not.toHaveBeenCalled();
    expect(list.deleteDispatch).not.toHaveBeenCalled();
  });

  it('treats the grace window as inclusive at its edge and stale just past it', async () => {
    const edge = lister([jobless(JOBLESS_DISPATCH_GRACE_MS)]);
    expect(await run(gateWith(), edge)).toBe('preparing');
    expect(edge.deleteDispatch).not.toHaveBeenCalled();

    const past = lister([jobless(JOBLESS_DISPATCH_GRACE_MS + 1)]);
    const gate = gateWith();
    expect(await run(gate, past)).toBe('proceed');
    expect(past.deleteDispatch).toHaveBeenCalledTimes(1);
  });

  it('replaces a stale job-less dispatch: ready, delete, then dispatch afresh', async () => {
    const gate = gateWith();
    const list = lister([jobless(60_000, 'AD_stale')]);
    expect(await run(gate, list)).toBe('proceed');
    expect(list.deleteDispatch).toHaveBeenCalledWith('AD_stale', ROOM);
    expect(gate.dispatch).toHaveBeenCalledTimes(1);
    const order = (fn: { mock: { invocationCallOrder: number[] } }) =>
      fn.mock.invocationCallOrder[0]!;
    expect(order(gate.ensureReadyWorker)).toBeLessThan(order(list.deleteDispatch));
    expect(order(list.deleteDispatch)).toBeLessThan(order(gate.dispatch));
  });

  it('never proceeds on a stale job-less dispatch alone (agent-less room)', async () => {
    // The old gate saw "agentName matches" and answered proceed with no dispatch.
    const gate = gateWith({ dispatch: vi.fn(async () => false) });
    expect(await run(gate, lister([jobless(60_000)]))).toBe('preparing');
    expect(gate.releaseWorker).toHaveBeenCalledWith({ machineId: 'm1', sessionId: SESSION });
  });

  it('leaves a stale record alone while no worker could be readied', async () => {
    const gate = gateWith({ ensureReadyWorker: vi.fn(async () => ({ status: 'no_capacity' })) });
    const list = lister([jobless(60_000)]);
    expect(await run(gate, list)).toBe('preparing');
    expect(list.deleteDispatch).not.toHaveBeenCalled();
    expect(gate.dispatch).not.toHaveBeenCalled();
  });

  it('treats a dispatch of unknown age as stale rather than in flight forever', async () => {
    const gate = gateWith();
    const noAge = lister([{ id: 'AD_x', agentName: 'browser-screener', state: { jobs: [] } }]);
    expect(await run(gate, noAge)).toBe('proceed');
    expect(noAge.deleteDispatch).toHaveBeenCalledWith('AD_x', ROOM);
    expect(gate.dispatch).toHaveBeenCalledTimes(1);
  });

  it('still dispatches when the lister cannot delete, or deleting fails', async () => {
    const items = [jobless(60_000)];
    const withoutDelete = { listDispatch: vi.fn(async () => [...items]) };
    const gate = gateWith();
    expect(await runR1WorkerGate({
      gate, sessionId: SESSION, roomName: ROOM, dispatches: () => withoutDelete, now: clock,
    })).toBe('proceed');

    const failing = {
      listDispatch: vi.fn(async () => [...items]),
      deleteDispatch: vi.fn(async () => { throw new Error('gone'); }),
    };
    const second = gateWith();
    expect(await runR1WorkerGate({
      gate: second, sessionId: SESSION, roomName: ROOM, dispatches: () => failing, now: clock,
    })).toBe('proceed');
    expect(second.dispatch).toHaveBeenCalledTimes(1);
  });

  it('clears the job-less record a failed dispatch left behind', async () => {
    const items: DispatchLike[] = [];
    const gate = gateWith({
      dispatch: vi.fn(async () => {
        items.push(jobless(1_000, 'AD_dropped'));
        return false;
      }),
    });
    const list = lister(items);
    expect(await run(gate, list)).toBe('preparing');
    expect(gate.releaseWorker).toHaveBeenCalledTimes(1);
    expect(list.deleteDispatch).toHaveBeenCalledWith('AD_dropped', ROOM);
    expect(items).toEqual([]);
  });

  it('survives a failing clean-up after a failed dispatch', async () => {
    const gate = gateWith({ dispatch: vi.fn(async () => false) });
    let calls = 0;
    const list = {
      listDispatch: vi.fn(async () => {
        calls += 1;
        if (calls > 1) throw new Error('livekit down');
        return [];
      }),
    };
    expect(await runR1WorkerGate({
      gate, sessionId: SESSION, roomName: ROOM, dispatches: () => list, now: clock,
    })).toBe('preparing');
    expect(gate.releaseWorker).toHaveBeenCalledTimes(1);
  });

  it('prefers a running dispatch over any stale sibling', async () => {
    const gate = gateWith();
    const list = lister([jobless(60_000, 'AD_old'), running('AD_live')]);
    expect(await run(gate, list)).toBe('proceed');
    expect(gate.ensureReadyWorker).not.toHaveBeenCalled();
    expect(list.deleteDispatch).not.toHaveBeenCalled();
  });
});

describe('epochMs', () => {
  const T = NOW;

  it.each([
    ['nanoseconds (bigint)', BigInt(T) * 1_000_000n],
    ['nanoseconds (number)', T * 1_000_000],
    ['microseconds', T * 1_000],
    ['milliseconds', T],
    ['seconds', T / 1000],
    ['a numeric string', String(T)],
  ])('normalizes %s to epoch milliseconds', (_label, value) => {
    expect(epochMs(value as bigint | number | string)).toBe(T);
  });

  it.each([undefined, 0, -5, Number.NaN, 'soon', ''])('rejects %s', (value) => {
    expect(epochMs(value as number | string | undefined)).toBeNull();
  });
});
