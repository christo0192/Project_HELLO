/**
 * M009 E2 — the scheduled reaper / terminal-release runtime builds ONE
 * orchestration service PER Fly app, each with its own LiveKit room naming:
 *
 *   phone   (project-hello-phone-voice) → 'phone-<sessionId>'
 *   browser (project-hello-voice)       → 'screening-<sessionId>'
 *
 * Before M009 the runtime built a single phone-named service and swept both
 * apps with it, so a browser lease was probed at 'phone-<browserSessionId>' —
 * a room that never exists — and not_found-is-dead made a LIVE browser
 * interview's machine stoppable.
 *
 * These tests drive the runtime's PRODUCTION default wiring (no `service`
 * override). `createDefaultWorkerOrchestrationService` is replaced by a factory
 * that builds the REAL `createWorkerOrchestrationService` over fake seams and
 * forwards the `roomNameForSession` override exactly as production does, so the
 * browser factory (`createBrowserWorkerOrchestrationService`, which calls it
 * with the screening scheme) is exercised unmodified. No network, no DB, no
 * real timers. Session ids are synthetic constants (no PII).
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';

const h = vi.hoisted(() => ({
  /** Room names the reaper asked LiveKit about, in order. */
  probes: [] as string[],
  /** Rooms that currently have participants. Anything else is not_found. */
  liveRooms: new Set<string>(),
  /** Fly verbs issued, as 'stop:<app>:<machine>'. */
  fly: [] as string[],
  /** list_reapable_voice_workers rows per app. */
  reapable: {} as Record<string, Array<Record<string, unknown>>>,
  /** list_terminal_session_leases rows per app. */
  terminal: {} as Record<string, Array<Record<string, unknown>>>,
  /** The roomNameForSession override each default-factory call received. */
  factoryOverrides: [] as Array<string | null>,
}));

vi.mock('../lib/worker-orchestration.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../lib/worker-orchestration.js')>();
  const createDefaultWorkerOrchestrationService = (
    overrides: { roomNameForSession?: (sessionId: string) => string } = {},
  ) => {
    h.factoryOverrides.push(
      overrides.roomNameForSession ? overrides.roomNameForSession('x') : null,
    );
    return actual.createWorkerOrchestrationService({
      enabled: true,
      rpc: async (name, args) => {
        const app = String(args.p_app);
        if (name === 'list_reapable_voice_workers') {
          return { data: h.reapable[app] ?? [], error: null };
        }
        if (name === 'list_terminal_session_leases') {
          return { data: h.terminal[app] ?? [], error: null };
        }
        if (name === 'list_orphaned_voice_worker_leases') {
          return { data: [], error: null };
        }
        if (name === 'release_voice_worker_by_session') {
          const row = (h.terminal[app] ?? []).find(
            (r) => r.claimed_session_id === args.p_session_id,
          );
          return {
            data: { status: 'draining', machine_id: row?.machine_id },
            error: null,
          };
        }
        return { data: { status: 'ok' }, error: null };
      },
      fly: {
        async stopMachine(app: string, id: string) {
          h.fly.push(`stop:${app}:${id}`);
          return {};
        },
        async startMachine() { return {}; },
        async waitForState() { return {}; },
        async listMachines() { return []; },
        async getMachine(_app: string, id: string) { return { id, state: 'stopped', raw: {} }; },
      } as never,
      readLeaseState: async () => ({ state: null, claimedSessionId: null, epoch: null }),
      roomIsLive: async (roomName: string) => {
        h.probes.push(roomName);
        if (h.liveRooms.has(roomName)) return true;
        // The shape LiveKit's RoomServiceClient rejects with for a missing room.
        throw Object.assign(new Error('requested room does not exist'), { code: 'not_found' });
      },
      now: () => 1_000,
      sleep: async () => {},
      ...(overrides.roomNameForSession
        ? { roomNameForSession: overrides.roomNameForSession }
        : {}),
    });
  };
  return { ...actual, createDefaultWorkerOrchestrationService };
});

import {
  createWorkerOrchestrationRuntime,
  PHONE_FLY_APP,
  BROWSER_FLY_APP,
} from '../lib/worker-orchestration-runtime.js';
import type { WorkerOrchestrationService } from '../lib/worker-orchestration.js';

const PHONE_SESSION = '11111111-2222-4333-8444-555555555555';
const BROWSER_SESSION = '66666666-7777-4888-8999-aaaaaaaaaaaa';
const PHONE_MACHINE = 'd891234abcd567';
const BROWSER_MACHINE = 'e7812736a540d5';

const noTimers = { setTimer: () => ({ unref: () => {} }), clearTimer: () => {} };

function reapRow(machineId: string, sessionId: string) {
  return { machine_id: machineId, claimed_session_id: sessionId, state: 'busy' };
}

beforeEach(() => {
  h.probes.length = 0;
  h.liveRooms.clear();
  h.fly.length = 0;
  h.reapable = {};
  h.terminal = {};
  h.factoryOverrides.length = 0;
});

describe('worker-orchestration runtime — one service per app (M009 E2)', () => {
  it('builds the phone service with the default (phone) naming and the browser service with screening naming', () => {
    const runtime = createWorkerOrchestrationRuntime({ enabled: true, scheduler: noTimers });
    expect(runtime).not.toBeNull();
    // Exactly two services: the phone one takes no room override (defaults to
    // phoneRoomName), the browser one injects 'screening-<id>'.
    expect(h.factoryOverrides).toEqual([null, 'screening-x']);
  });

  it('the phone reap probes phone-<id> and the browser reap probes screening-<id>', async () => {
    h.reapable[PHONE_FLY_APP] = [reapRow(PHONE_MACHINE, PHONE_SESSION)];
    h.reapable[BROWSER_FLY_APP] = [reapRow(BROWSER_MACHINE, BROWSER_SESSION)];
    h.liveRooms.add(`phone-${PHONE_SESSION}`);
    h.liveRooms.add(`screening-${BROWSER_SESSION}`);

    const runtime = createWorkerOrchestrationRuntime({ enabled: true, scheduler: noTimers });
    await runtime!.tickAll();

    expect(h.probes).toEqual([`phone-${PHONE_SESSION}`, `screening-${BROWSER_SESSION}`]);
    // The pre-M009 bug shape: a browser session probed under the phone prefix.
    expect(h.probes).not.toContain(`phone-${BROWSER_SESSION}`);
    // Both rooms are live, so nothing is stopped.
    expect(h.fly).toEqual([]);
    await runtime!.stop();
  });

  it('a browser lease whose screening room is LIVE is NOT stopped', async () => {
    h.reapable[BROWSER_FLY_APP] = [reapRow(BROWSER_MACHINE, BROWSER_SESSION)];
    h.liveRooms.add(`screening-${BROWSER_SESSION}`);

    const runtime = createWorkerOrchestrationRuntime({ enabled: true, scheduler: noTimers });
    await runtime!.tickAll();

    expect(h.probes).toEqual([`screening-${BROWSER_SESSION}`]);
    expect(h.fly).toEqual([]);
    await runtime!.stop();
  });

  it('a browser lease whose screening room is not_found IS stopped (not_found-is-dead unchanged)', async () => {
    h.reapable[BROWSER_FLY_APP] = [reapRow(BROWSER_MACHINE, BROWSER_SESSION)];

    const runtime = createWorkerOrchestrationRuntime({ enabled: true, scheduler: noTimers });
    await runtime!.tickAll();

    expect(h.probes).toEqual([`screening-${BROWSER_SESSION}`]);
    expect(h.fly).toEqual([`stop:${BROWSER_FLY_APP}:${BROWSER_MACHINE}`]);
    await runtime!.stop();
  });

  it('a phone lease whose phone room is not_found is still stopped (phone behaviour unchanged)', async () => {
    h.reapable[PHONE_FLY_APP] = [reapRow(PHONE_MACHINE, PHONE_SESSION)];

    const runtime = createWorkerOrchestrationRuntime({ enabled: true, scheduler: noTimers });
    await runtime!.tickAll();

    expect(h.probes).toEqual([`phone-${PHONE_SESSION}`]);
    expect(h.fly).toEqual([`stop:${PHONE_FLY_APP}:${PHONE_MACHINE}`]);
    await runtime!.stop();
  });

  it('terminal-release drains each app through its own service', async () => {
    h.terminal[PHONE_FLY_APP] = [{ claimed_session_id: PHONE_SESSION, machine_id: PHONE_MACHINE }];
    h.terminal[BROWSER_FLY_APP] = [{ claimed_session_id: BROWSER_SESSION, machine_id: BROWSER_MACHINE }];

    const runtime = createWorkerOrchestrationRuntime({ enabled: true, scheduler: noTimers });
    await runtime!.tickAll();

    expect(h.fly).toEqual([
      `stop:${PHONE_FLY_APP}:${PHONE_MACHINE}`,
      `stop:${BROWSER_FLY_APP}:${BROWSER_MACHINE}`,
    ]);
    // Terminal-release never asks LiveKit; the reap pass found nothing to probe.
    expect(h.probes).toEqual([]);
    await runtime!.stop();
  });

  it('an options.service override applies to BOTH apps and builds no default services', async () => {
    const seen: string[] = [];
    const fake: WorkerOrchestrationService = {
      ensureReadyWorker: async () => ({ status: 'disabled' }),
      releaseWorker: async () => {},
      releaseWorkerBySession: async () => {},
      releaseTerminalSessions: async ({ app }) => { seen.push(`release:${app}`); return { released: 0 }; },
      markBusy: async () => {},
      reapWorkers: async ({ app }) => { seen.push(`reap:${app}`); return { stopped: 0 }; },
    };
    const runtime = createWorkerOrchestrationRuntime({
      enabled: true,
      service: fake,
      scheduler: noTimers,
    });
    await runtime!.tickAll();

    expect(seen).toEqual([
      `release:${PHONE_FLY_APP}`,
      `release:${BROWSER_FLY_APP}`,
      `reap:${PHONE_FLY_APP}`,
      `reap:${BROWSER_FLY_APP}`,
    ]);
    expect(h.factoryOverrides).toEqual([]);
    await runtime!.stop();
  });

  it('options.services routes each app to its own injected service; an app with none is skipped', async () => {
    const seen: string[] = [];
    const mk = (tag: string): WorkerOrchestrationService => ({
      ensureReadyWorker: async () => ({ status: 'disabled' }),
      releaseWorker: async () => {},
      releaseWorkerBySession: async () => {},
      releaseTerminalSessions: async ({ app }) => { seen.push(`${tag}:release:${app}`); return { released: 0 }; },
      markBusy: async () => {},
      reapWorkers: async ({ app }) => { seen.push(`${tag}:reap:${app}`); return { stopped: 0 }; },
    });
    const runtime = createWorkerOrchestrationRuntime({
      enabled: true,
      services: { 'app-phone': mk('P'), 'app-browser': mk('B') },
      apps: ['app-phone', 'app-browser', 'app-unknown'],
      scheduler: noTimers,
    });
    await runtime!.tickAll();

    expect(seen).toEqual([
      'P:release:app-phone',
      'B:release:app-browser',
      'P:reap:app-phone',
      'B:reap:app-browser',
    ]);
    // No production defaults were constructed alongside injected services.
    expect(h.factoryOverrides).toEqual([]);
    await runtime!.stop();
  });
});
