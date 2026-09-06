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
