/**
 * PR B — the on-demand Fly worker orchestration SERVICE
 * (`createWorkerOrchestrationService`) and the reaper runtime gate.
 *
 * The two invariants under test (design §2.1):
 *   I1  ensureReadyWorker returns 'ready' ONLY after observing a ready/busy
 *       lease. Every failure exit is non-ready.
 *   I2  Every failure exit after a claim tears the machine down (stop + release
 *       + reset), and reapWorkers stops any non-stopped machine with no live
 *       room.
 *
 * All seams are fakes — no network, no DB, no timers.
 */

import { describe, it, expect, vi } from 'vitest';
import {
  createWorkerOrchestrationService,
  type RpcCaller,
  type WorkerOrchestrationDeps,
} from '../lib/worker-orchestration.js';
import { createWorkerOrchestrationRuntime } from '../lib/worker-orchestration-runtime.js';
import { FlyMachinesError } from '../lib/fly-machines.js';

const APP = 'project-hello-phone-voice';
const SESSION = '99999999-8888-4777-8666-555555555555';
const MACHINE = 'd891234abcd567';

/** A fake Fly client recording calls; each verb resolvable/rejectable per test. */
function fakeFly(overrides: Partial<Record<'startMachine' | 'stopMachine' | 'waitForState', () => Promise<unknown>>> = {}) {
  const calls: string[] = [];
  return {
    calls,
    client: {
      async startMachine(app: string, id: string) {
        calls.push(`start:${app}:${id}`);
        return overrides.startMachine ? overrides.startMachine() : {};
      },
      async stopMachine(app: string, id: string) {
        calls.push(`stop:${app}:${id}`);
        return overrides.stopMachine ? overrides.stopMachine() : {};
      },
      async waitForState(app: string, id: string, state: string) {
        calls.push(`wait:${app}:${id}:${state}`);
        return overrides.waitForState ? overrides.waitForState() : {};
      },
      // Unused by the service; present to satisfy the type at call sites.
      async listMachines() { return []; },
      async getMachine(_app: string, id: string) { return { id, state: 'stopped', raw: {} } as never; },
    } as never,
  };
}

/** An RPC caller that returns scripted envelopes per name, recording calls. */
function fakeRpc(script: Record<string, { data?: unknown; error?: { message?: string } | null }[]>): {
  rpc: RpcCaller;
  calls: Array<{ name: string; args: Record<string, unknown> }>;
} {
  const calls: Array<{ name: string; args: Record<string, unknown> }> = [];
  const cursors: Record<string, number> = {};
  const rpc: RpcCaller = async (name, args) => {
    calls.push({ name, args });
    const seq = script[name];
    if (!seq || seq.length === 0) return { data: { status: 'ok' }, error: null };
    const i = Math.min(cursors[name] ?? 0, seq.length - 1);
    cursors[name] = (cursors[name] ?? 0) + 1;
    const entry = seq[i];
    return { data: entry.data ?? { status: 'ok' }, error: entry.error ?? null };
  };
  return { rpc, calls };
}

function baseDeps(over: Partial<WorkerOrchestrationDeps> = {}): WorkerOrchestrationDeps {
  const fly = fakeFly();
  const { rpc } = fakeRpc({});
  return {
    enabled: true,
    rpc,
    fly: fly.client,
    readLeaseState: async () => 'ready',
    roomIsLive: async () => false,
    now: () => 1_000,
    sleep: async () => {},
    ...over,
  };
}

describe('ensureReadyWorker', () => {
  it('happy path: claim → start → wait → ready', async () => {
    const fly = fakeFly();
    const { rpc, calls } = fakeRpc({
      claim_voice_worker: [{ data: { status: 'claimed', machine_id: MACHINE, epoch: 7 } }],
    });
    // Lease not ready on the first read, ready on the second — proves the poll.
    let reads = 0;
    const svc = createWorkerOrchestrationService(baseDeps({
      fly: fly.client,
      rpc,
      readLeaseState: async () => {
        reads += 1;
        return reads >= 2 ? 'ready' : 'starting';
      },
    }));
    const r = await svc.ensureReadyWorker({ app: APP, pipeline: 'phone', sessionId: SESSION });
    expect(r).toEqual({ status: 'ready', machineId: MACHINE });
    expect(fly.calls).toContain(`start:${APP}:${MACHINE}`);
    expect(fly.calls).toContain(`wait:${APP}:${MACHINE}:started`);
    // Never cleaned up on the happy path.
    expect(fly.calls).not.toContain(`stop:${APP}:${MACHINE}`);
    expect(calls.some((c) => c.name === 'release_voice_worker')).toBe(false);
  });

  it('no_capacity: returns immediately, never starts a machine', async () => {
    const fly = fakeFly();
    const { rpc } = fakeRpc({ claim_voice_worker: [{ data: { status: 'no_capacity' } }] });
    const svc = createWorkerOrchestrationService(baseDeps({ fly: fly.client, rpc }));
    const r = await svc.ensureReadyWorker({ app: APP, pipeline: 'phone', sessionId: SESSION });
    expect(r).toEqual({ status: 'no_capacity' });
    expect(fly.calls).toEqual([]); // no start, no stop
  });

  it('ready-timeout: cleans up (stop+release+reset), returns timeout, NEVER ready', async () => {
    const fly = fakeFly();
    const { rpc, calls } = fakeRpc({
      claim_voice_worker: [{ data: { status: 'claimed', machine_id: MACHINE, epoch: 1 } }],
    });
    // A monotonically advancing clock so the wall-clock deadline is reached.
    let t = 0;
    const svc = createWorkerOrchestrationService(baseDeps({
      fly: fly.client,
      rpc,
      readLeaseState: async () => 'starting', // never becomes ready
      now: () => (t += 5_000),
      sleep: async () => {},
    }));
    const r = await svc.ensureReadyWorker({
      app: APP, pipeline: 'phone', sessionId: SESSION, readyTimeoutSec: 5,
    });
    expect(r).toEqual({ status: 'timeout' });
    // I2: the started machine was cleaned up.
    expect(fly.calls).toContain(`stop:${APP}:${MACHINE}`);
    const names = calls.map((c) => c.name);
    expect(names).toContain('release_voice_worker');
    expect(names).toContain('reset_voice_worker');
  });

  it('fly-start error: cleans up and returns error (never ready)', async () => {
    const fly = fakeFly({
      startMachine: async () => { throw new FlyMachinesError('server', { operation: 'startMachine' }); },
    });
    const { rpc, calls } = fakeRpc({
      claim_voice_worker: [{ data: { status: 'claimed', machine_id: MACHINE, epoch: 1 } }],
    });
    const svc = createWorkerOrchestrationService(baseDeps({ fly: fly.client, rpc }));
    const r = await svc.ensureReadyWorker({ app: APP, pipeline: 'phone', sessionId: SESSION });
    expect(r.status).toBe('error');
    // I2: cleanup ran even though start threw.
    expect(fly.calls).toContain(`stop:${APP}:${MACHINE}`);
    expect(calls.map((c) => c.name)).toContain('reset_voice_worker');
  });

  it('fly-start TIMEOUT maps to timeout status and cleans up', async () => {
    const fly = fakeFly({
      waitForState: async () => { throw new FlyMachinesError('timeout', { operation: 'waitForState' }); },
    });
    const { rpc } = fakeRpc({
      claim_voice_worker: [{ data: { status: 'claimed', machine_id: MACHINE, epoch: 1 } }],
    });
    const svc = createWorkerOrchestrationService(baseDeps({ fly: fly.client, rpc }));
    const r = await svc.ensureReadyWorker({ app: APP, pipeline: 'phone', sessionId: SESSION });
    expect(r).toEqual({ status: 'timeout' });
    expect(fly.calls).toContain(`stop:${APP}:${MACHINE}`);
  });
});

describe('releaseWorker', () => {
  it('release → stop → reset, in order', async () => {
    const order: string[] = [];
    const rpc: RpcCaller = async (name) => { order.push(name); return { data: { status: 'ok' }, error: null }; };
    const fly = {
      async startMachine() { return {}; },
      async stopMachine() { order.push('stop'); return {}; },
      async waitForState() { return {}; },
      async listMachines() { return []; },
      async getMachine() { return {} as never; },
    } as never;
    const svc = createWorkerOrchestrationService(baseDeps({ fly, rpc }));
    await svc.releaseWorker({ app: APP, machineId: MACHINE, sessionId: SESSION });
    expect(order).toEqual(['release_voice_worker', 'stop', 'reset_voice_worker']);
  });

  it('fail-open on a fly stop error: still resets', async () => {
    const names: string[] = [];
    const rpc: RpcCaller = async (name) => { names.push(name); return { data: { status: 'ok' }, error: null }; };
    const fly = fakeFly({
      stopMachine: async () => { throw new FlyMachinesError('server', { operation: 'stopMachine' }); },
    });
    const svc = createWorkerOrchestrationService(baseDeps({ fly: fly.client, rpc }));
    await expect(
      svc.releaseWorker({ app: APP, machineId: MACHINE, sessionId: SESSION }),
    ).resolves.toBeUndefined();
    expect(names).toContain('reset_voice_worker'); // reset ran despite the stop error
  });
});

describe('reapWorkers', () => {
  const A = 'aaaa1111';
  const B = 'bbbb2222';
  const SESS_A = '11111111-1111-4111-8111-111111111111';
  const SESS_B = '22222222-2222-4222-8222-222222222222';

  it('stops a candidate whose room is NOT live; SPARES one whose room IS live; resets after stop', async () => {
    const fly = fakeFly();
    const { rpc, calls } = fakeRpc({
      list_reapable_voice_workers: [{
        data: [
          { machine_id: A, claimed_session_id: SESS_A, state: 'busy' }, // room dead → reap
          { machine_id: B, claimed_session_id: SESS_B, state: 'busy' }, // room live → spare
        ],
      }],
    });
    const svc = createWorkerOrchestrationService(baseDeps({
      fly: fly.client,
      rpc,
      roomNameForSession: (s) => `room-${s}`,
      roomIsLive: async (room) => room === `room-${SESS_B}`, // only B is live
    }));
    const r = await svc.reapWorkers({ app: APP });
    expect(r.stopped).toBe(1);
    expect(fly.calls).toContain(`stop:${APP}:${A}`);
    expect(fly.calls).not.toContain(`stop:${APP}:${B}`); // spared
    // reset ran for the stopped one only.
    const resets = calls.filter((c) => c.name === 'reset_voice_worker');
    expect(resets).toHaveLength(1);
    expect(resets[0].args.p_machine_id).toBe(A);
  });

  it('reaps a candidate with NO claim (leaked started machine)', async () => {
    const fly = fakeFly();
    const { rpc } = fakeRpc({
      list_reapable_voice_workers: [{
        data: [{ machine_id: A, claimed_session_id: null, state: 'starting' }],
      }],
    });
    const roomIsLive = vi.fn(async () => true);
    const svc = createWorkerOrchestrationService(baseDeps({ fly: fly.client, rpc, roomIsLive }));
    const r = await svc.reapWorkers({ app: APP });
    expect(r.stopped).toBe(1);
    expect(fly.calls).toContain(`stop:${APP}:${A}`);
    expect(roomIsLive).not.toHaveBeenCalled(); // no claim → no room check
  });

  it('SPARES a candidate whose room-liveness check THROWS (unknown ≠ dead)', async () => {
    const fly = fakeFly();
    const { rpc } = fakeRpc({
      list_reapable_voice_workers: [{
        data: [{ machine_id: A, claimed_session_id: SESS_A, state: 'busy' }],
      }],
    });
    const svc = createWorkerOrchestrationService(baseDeps({
      fly: fly.client,
      rpc,
      roomIsLive: async () => { throw new Error('livekit down'); },
    }));
    const r = await svc.reapWorkers({ app: APP });
    expect(r.stopped).toBe(0);
    expect(fly.calls).not.toContain(`stop:${APP}:${A}`);
  });
});

describe('disabled flag no-ops every entry point', () => {
  it('ensureReadyWorker → disabled, releaseWorker → noop, reapWorkers → disabled; NO Fly/DB calls', async () => {
    const fly = fakeFly();
    const rpcCalls: string[] = [];
    const rpc: RpcCaller = async (name) => { rpcCalls.push(name); return { data: {}, error: null }; };
    const svc = createWorkerOrchestrationService(baseDeps({ enabled: false, fly: fly.client, rpc }));

    expect(await svc.ensureReadyWorker({ app: APP, pipeline: 'phone', sessionId: SESSION }))
      .toEqual({ status: 'disabled' });
    await svc.releaseWorker({ app: APP, machineId: MACHINE, sessionId: SESSION });
    expect(await svc.reapWorkers({ app: APP })).toEqual({ stopped: 0, disabled: true });

    expect(fly.calls).toEqual([]);
    expect(rpcCalls).toEqual([]);
  });
});

describe('reaper runtime gate', () => {
  it('returns null when the flag is off (no scheduler constructed)', () => {
    expect(createWorkerOrchestrationRuntime({ enabled: false })).toBeNull();
  });

  it('constructs a scheduler when enabled, and reaps both apps on tickAll', async () => {
    const reaped: string[] = [];
    const runtime = createWorkerOrchestrationRuntime({
      enabled: true,
      service: {
        ensureReadyWorker: async () => ({ status: 'disabled' }),
        releaseWorker: async () => {},
        reapWorkers: async ({ app }) => { reaped.push(app); return { stopped: 0 }; },
      },
      apps: ['app-phone', 'app-browser'],
      // Never arm real timers in the test.
      scheduler: { setTimer: () => ({ unref: () => {} }), clearTimer: () => {} },
    });
    expect(runtime).not.toBeNull();
    await runtime!.tickAll();
    expect(reaped).toEqual(['app-phone', 'app-browser']);
    await runtime!.stop();
  });
});
