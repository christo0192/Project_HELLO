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
 */

import { describe, it, expect, vi } from 'vitest';
const agentDispatchCtor = vi.hoisted(() => vi.fn());

vi.mock('livekit-server-sdk', () => {
  class AgentDispatchClient {
    constructor(...args: unknown[]) {
      agentDispatchCtor(...args);
    }
    async createDispatch(): Promise<void> {}
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
    process.env.BROWSER_LIVEKIT_TARGET = 'r1';
    process.env.R1_LIVEKIT_URL = 'wss://r1.example.test';
    process.env.R1_LIVEKIT_API_KEY = 'r1-key';
    process.env.R1_LIVEKIT_API_SECRET = 'r1-secret';
    try {
      const gate = browserOrchestrationGate({
        enabled: true,
        agentName: 'browser-screener',
        service: fakeService({ status: 'ready', machineId: 'm1' }),
      })!;
      await expect(gate.dispatch({ sessionId: 'sess-1', roomName: 'screening-sess-1' })).resolves.toBe(true);
      expect(agentDispatchCtor).toHaveBeenLastCalledWith(
        'wss://r1.example.test', 'r1-key', 'r1-secret',
      );
    } finally {
      delete process.env.BROWSER_LIVEKIT_TARGET;
      delete process.env.R1_LIVEKIT_URL;
      delete process.env.R1_LIVEKIT_API_KEY;
      delete process.env.R1_LIVEKIT_API_SECRET;
    }
  });

  it('rejects an absent or mismatched durable lease host on R1 before dispatch, and releases the claim', async () => {
    process.env.BROWSER_LIVEKIT_TARGET = 'r1';
    process.env.R1_LIVEKIT_URL = 'wss://r1.example.test:7880';
    try {
      const service = fakeService({ status: 'ready', machineId: 'm1', livekitHost: null });
      const gate = browserOrchestrationGate({
        enabled: true,
        agentName: 'browser-screener',
        service,
        dispatchClient: { createDispatch: vi.fn() },
      })!;
      await expect(gate.ensureReadyWorker({ sessionId: 'sess-1' })).resolves.toEqual({ status: 'timeout' });
      expect(service.releaseCalls).toEqual([
        { app: BROWSER_FLY_APP, machineId: 'm1', sessionId: 'sess-1' },
      ]);
      const mismatched = fakeService({
        status: 'ready', machineId: 'm1', livekitHost: 'wrong.example.test',
      });
      const mismatchGate = browserOrchestrationGate({
        enabled: true,
        agentName: 'browser-screener',
        service: mismatched,
        dispatchClient: { createDispatch: vi.fn() },
      })!;
      await expect(mismatchGate.ensureReadyWorker({ sessionId: 'sess-1' })).resolves.toEqual({ status: 'timeout' });
      expect(mismatched.releaseCalls).toEqual([
        { app: BROWSER_FLY_APP, machineId: 'm1', sessionId: 'sess-1' },
      ]);
    } finally {
      delete process.env.BROWSER_LIVEKIT_TARGET;
      delete process.env.R1_LIVEKIT_URL;
    }
  });

  it('accepts an absent host for Cloud rollout compatibility', async () => {
    const gate = browserOrchestrationGate({
      enabled: true,
      agentName: 'browser-screener',
      service: fakeService({ status: 'ready', machineId: 'm1' }),
      dispatchClient: { createDispatch: vi.fn() },
    })!;
    await expect(gate.ensureReadyWorker({ sessionId: 'sess-1' })).resolves.toMatchObject({
      status: 'ready', machineId: 'm1',
    });
  });

  it('accepts only the exact durable lease host for R1', async () => {
    process.env.BROWSER_LIVEKIT_TARGET = 'r1';
    process.env.R1_LIVEKIT_URL = 'wss://r1.example.test:7880';
    try {
      const gate = browserOrchestrationGate({
        enabled: true,
        agentName: 'browser-screener',
        service: fakeService({ status: 'ready', machineId: 'm1', livekitHost: 'r1.example.test' }),
        dispatchClient: { createDispatch: vi.fn() },
      })!;
      await expect(gate.ensureReadyWorker({ sessionId: 'sess-1' })).resolves.toMatchObject({
        status: 'ready', machineId: 'm1', livekitHost: 'r1.example.test',
      });
    } finally {
      delete process.env.BROWSER_LIVEKIT_TARGET;
      delete process.env.R1_LIVEKIT_URL;
    }
  });

  it('deletes one known job-less dispatch and retries it once with no wall-clock sleep', async () => {
    let clock = 0;
    const createDispatch = vi.fn().mockResolvedValueOnce({ id: 'first' }).mockResolvedValueOnce({ id: 'retry' });
    const deleteDispatch = vi.fn().mockResolvedValue(undefined);
    const listDispatch = vi.fn(async () => [
      { id: createDispatch.mock.calls.length === 1 ? 'first' : 'retry', state: { jobs: [] } },
    ]);
    const gate = browserOrchestrationGate({
      enabled: true,
      agentName: 'browser-screener',
      service: fakeService({ status: 'ready', machineId: 'm1' }),
      dispatchClient: { createDispatch, deleteDispatch, listDispatch },
      dispatchVerifyMs: 1,
      dispatchPollMs: 1,
      now: () => clock,
      sleep: async (ms) => { clock += ms; },
    })!;
    await expect(gate.dispatch({ sessionId: 'sess-1', roomName: 'screening-sess-1' })).resolves.toBe(false);
    expect(deleteDispatch).toHaveBeenCalledTimes(1);
    expect(createDispatch).toHaveBeenCalledTimes(2);
  });

  it('never re-dispatches once the dispatch owns a job', async () => {
    const createDispatch = vi.fn().mockResolvedValue({ id: 'assigned' });
    const deleteDispatch = vi.fn();
    const gate = browserOrchestrationGate({
      enabled: true,
      agentName: 'browser-screener',
      service: fakeService({ status: 'ready', machineId: 'm1' }),
      dispatchClient: {
        createDispatch,
        deleteDispatch,
        listDispatch: vi.fn().mockResolvedValue([{ id: 'assigned', state: { jobs: [{}] } }]),
      },
      dispatchVerifyMs: 1,
    })!;
    await expect(gate.dispatch({ sessionId: 'sess-1', roomName: 'screening-sess-1' })).resolves.toBe(true);
    expect(createDispatch).toHaveBeenCalledTimes(1);
    expect(deleteDispatch).not.toHaveBeenCalled();
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
