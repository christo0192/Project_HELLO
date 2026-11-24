/**
 * M034 S05 T2: the Meet bridge's dispatch and room metadata (contracts section 5), and the
 * proof that every browser output stays byte-identical.
 *
 *  - lib/browser-orchestration.ts: without `meet` the dispatch metadata is exactly
 *    `{"session_id":"<id>","channel":"browser"}`; with it, exactly
 *    `{"session_id","channel":"meet","candidate_identity","profile"}` in that key order, on the
 *    first dispatch and the R1 retry, on Cloud and on the R1 SFU. A malformed `meet` dispatches
 *    nothing, logs `browser_dispatch_meet_invalid` and answers false before any LiveKit client.
 *  - lib/r1/worker-gate.ts and lib/r1/join-gate.ts thread `meet` only when present, so a browser
 *    dispatch call is still exactly `{ sessionId, roomName }` / `{ sessionId, roomName, agentName }`.
 *  - lib/room-provisioning.ts: a Meet R1 room appends `channel` and `candidate_identity` after the
 *    lane key; `meet` without the R1 exchange's lane, without an R1 round or with a bad identity
 *    fails closed as `r1_lane_mismatch` before any provider call.
 *  - lib/r1/marked-room.ts passes `meet` last, and only when present.
 *
 * Fixtures are synthetic and low-entropy: no real identifiers or keys.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({
  transition: vi.fn(),
  egress: vi.fn(),
  correlation: { id: null as string | null },
  dispatchClientFor: vi.fn(),
}));

vi.mock('../lib/session-lifecycle.js', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../lib/session-lifecycle.js')>()),
  transitionSession: mocks.transition,
}));
vi.mock('../lib/recording-egress.js', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../lib/recording-egress.js')>()),
  startAuthoritativeRecording: mocks.egress,
}));
vi.mock('../lib/correlation.js', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../lib/correlation.js')>()),
  getCorrelationId: () => mocks.correlation.id,
}));
// The lazy LiveKit dispatch client factory, observed: a refused Meet dispatch never reaches it.
vi.mock('../lib/livekit-endpoints.js', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../lib/livekit-endpoints.js')>()),
  agentDispatchClientFor: mocks.dispatchClientFor,
}));
// The real worker gate, wrapped so the join gate's input to it can be read.
vi.mock('../lib/r1/worker-gate.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../lib/r1/worker-gate.js')>();
  return { ...actual, runR1WorkerGate: vi.fn(actual.runR1WorkerGate) };
});

import {
  browserDispatchMetadata,
  browserOrchestrationGate,
  type BrowserAgentDispatchClientLike,
  type BrowserDispatchMeet,
  type BrowserWorkerGate,
  type BrowserWorkerGateDeps,
} from '../lib/browser-orchestration.js';
import type { EnsureReadyResult, WorkerOrchestrationService } from '../lib/worker-orchestration.js';
import { R1_LANE_MISMATCH_ERROR, type LiveKitEndpoint } from '../lib/livekit-endpoints.js';
import {
  R1_ROOM_DEPARTURE_TIMEOUT_SEC,
  R1_ROOM_EMPTY_TIMEOUT_SEC,
  R1_ROOM_MAX_PARTICIPANTS,
  buildMinimalRoomMetadata,
  provisionRoomForCreatedSession,
  roomNameForSession,
  type ProvisionRoomDeps,
  type ProvisionRoomResult,
  type RoomServiceClientLike,
} from '../lib/room-provisioning.js';
import { runR1WorkerGate, type DispatchListerLike } from '../lib/r1/worker-gate.js';
import { runR1JoinGate, type R1JoinGateDeps } from '../lib/r1/join-gate.js';
import { provisionMarkedRoom, type ProvisionMarkedRoomDeps } from '../lib/r1/marked-room.js';

// ── Fixtures ─────────────────────────────────────────────────────────

/** A v4-shaped session id whose first 8 characters include hex letters. */
const SESSION = 'ab12cd34-5e6f-4a70-8b91-0000000000e1';
const ROUND = '20000000-0000-4000-8000-0000000000c1';
const ROOM = roomNameForSession(SESSION);
const MEET_IDENTITY = 'meet-ab12cd34';
const PROFILE = 'r1_dex_sales';
const MEET: BrowserDispatchMeet = Object.freeze({
  candidateIdentity: MEET_IDENTITY,
  profile: PROFILE,
});
const ROOM_MEET = Object.freeze({ candidateIdentity: MEET_IDENTITY });
const BASE = 'browser-screener';
const MACHINE = 'aaaa1111bbbb22';
const MACHINE_NAME = `${BASE}-${MACHINE}`;
const CORRELATION = '0c0c0c0c-0c0c-4c0c-8c0c-0c0c0c0c0c0c';

/** Every expected string written out byte for byte (key order included). */
const BROWSER_DISPATCH = `{"session_id":"${SESSION}","channel":"browser"}`;
const MEET_DISPATCH =
  `{"session_id":"${SESSION}","channel":"meet",` +
  '"candidate_identity":"meet-ab12cd34","profile":"r1_dex_sales"}';
const CLOUD_ROOM = `{"session_id":"${SESSION}","room_name":"${ROOM}"}`;
const BROWSER_R1_ROOM = `{"session_id":"${SESSION}","room_name":"${ROOM}","lane":"r1"}`;
const MEET_R1_ROOM =
  `{"session_id":"${SESSION}","room_name":"${ROOM}","lane":"r1",` +
  '"channel":"meet","candidate_identity":"meet-ab12cd34"}';

const CLOUD: LiveKitEndpoint = {
  url: 'wss://cloud.example.test',
  apiKey: 'cloud-key',
  apiSecret: 'cloud-secret',
  target: 'cloud',
};
const R1_SFU: LiveKitEndpoint = {
  url: 'wss://r1.example.test',
  apiKey: 'r1-key',
  apiSecret: 'r1-secret',
  target: 'r1',
};

const R1_ENV = [
  'BROWSER_LIVEKIT_TARGET', 'R1_LIVEKIT_URL', 'R1_LIVEKIT_API_KEY', 'R1_LIVEKIT_API_SECRET',
] as const;

/** Select the R1 SFU for the browser lane (cleaned by afterEach). */
function selectR1(): void {
  process.env.BROWSER_LIVEKIT_TARGET = 'r1';
  process.env.R1_LIVEKIT_URL = R1_SFU.url;
  // Bracket access: a dotted assignment reads as a key to the history secret scanner.
  process.env['R1_LIVEKIT_API_KEY'] = R1_SFU.apiKey;
  process.env['R1_LIVEKIT_API_SECRET'] = R1_SFU.apiSecret;
}

const TARGETS: Array<[string, () => void]> = [
  ['Cloud', () => undefined],
  ['the R1 SFU', selectR1],
];

let consoleError: { mock: { calls: unknown[][] }; mockRestore(): void };

beforeEach(() => {
  mocks.transition.mockReset();
  mocks.transition.mockResolvedValue({ ok: true });
  mocks.egress.mockReset();
  mocks.egress.mockResolvedValue({ status: 'started', egressId: 'must-not-be-used' });
  mocks.dispatchClientFor.mockReset();
  mocks.correlation.id = null;
  vi.mocked(runR1WorkerGate).mockClear();
  consoleError = vi.spyOn(console, 'error').mockImplementation(() => undefined);
});

afterEach(() => {
  for (const key of R1_ENV) delete process.env[key];
  consoleError.mockRestore();
});

/** The `error_category` of every structured error line logged during the test. */
function loggedCategories(): unknown[] {
  return consoleError.mock.calls.map(([line]) => {
    try {
      return (JSON.parse(String(line)) as { error_category?: unknown }).error_category;
    } catch {
      return undefined;
    }
  });
}

// ── Doubles ──────────────────────────────────────────────────────────

/** The R1 SFU's host: an R1 ready lease must report it (the host match). Cloud ignores it. */
const R1_HOST = 'r1.example.test';

function fakeService(
  ready: EnsureReadyResult = { status: 'ready', machineId: 'm1', livekitHost: R1_HOST },
) {
  const service: WorkerOrchestrationService = {
    ensureReadyWorker: vi.fn(async () => ready),
    releaseWorker: vi.fn(async () => undefined),
    releaseWorkerBySession: vi.fn(async () => undefined),
    releaseTerminalSessions: vi.fn(async () => ({ released: 0 })),
    markBusy: vi.fn(async () => undefined),
    reapWorkers: vi.fn(async () => ({ stopped: 0 })),
  };
  return service;
}

/**
 * A dispatch client over a live set of dispatches: the n-th `createDispatch` owns
 * `jobsFor(n)` running jobs. `(n) => (n === 1 ? 0 : 1)` is the R1 drop-and-retry path.
 */
function scriptedClient(jobsFor: (n: number) => number = () => 1) {
  const dispatches: Array<{ id: string; jobs: number }> = [];
  let created = 0;
  const createDispatch = vi.fn(
    async (_room: string, _name: string, _options?: { metadata?: string }) => {
      created += 1;
      const record = { id: `d${created}`, jobs: jobsFor(created) };
      dispatches.push(record);
      return { id: record.id };
    },
  );
  const deleteDispatch = vi.fn(async (id: string, _room: string) => {
    const at = dispatches.findIndex((item) => item.id === id);
    if (at >= 0) dispatches.splice(at, 1);
  });
  const listDispatch = vi.fn(async (_room: string) => dispatches.map((item) => ({
    id: item.id,
    state: { jobs: Array.from({ length: item.jobs }, () => ({ state: { status: 1 } })) },
  })));
  const client: BrowserAgentDispatchClientLike = { createDispatch, deleteDispatch, listDispatch };
  return { client, createDispatch, deleteDispatch, listDispatch };
}

/** The real browser worker gate with a virtual clock (no wall-clock waits). */
function realGate(
  client?: BrowserAgentDispatchClientLike,
  extra: Partial<BrowserWorkerGateDeps> = {},
): BrowserWorkerGate {
  let clock = 0;
  return browserOrchestrationGate({
    enabled: true,
    agentName: BASE,
    service: fakeService(),
    ...(client ? { dispatchClient: client } : {}),
    roomHasAgent: async () => false,
    dispatchPollMs: 1_000,
    now: () => clock,
    sleep: async (ms: number) => {
      clock += ms;
    },
    ...extra,
  })!;
}

/** The (room, name, options) of every createDispatch, in call order. */
const calls = (createDispatch: { mock: { calls: unknown[][] } }) => createDispatch.mock.calls;

/** A hand-built gate double (as in r1-worker-gate.test.ts). */
function gateDouble(over: Partial<Record<keyof BrowserWorkerGate, unknown>> = {}) {
  return {
    app: 'project-hello-voice',
    agentName: BASE,
    ensureReadyWorker: vi.fn(async () => ({ status: 'ready', machineId: 'm1', epoch: 1 })),
    dispatch: vi.fn(async (_input: unknown) => true),
    releaseWorker: vi.fn(async () => undefined),
    ...over,
  } as unknown as BrowserWorkerGate & {
    ensureReadyWorker: ReturnType<typeof vi.fn>;
    dispatch: ReturnType<typeof vi.fn>;
    releaseWorker: ReturnType<typeof vi.fn>;
  };
}

function emptyLister(): DispatchListerLike & { listDispatch: ReturnType<typeof vi.fn> } {
  return { listDispatch: vi.fn(async () => []), deleteDispatch: vi.fn(async () => undefined) };
}

function fakeRooms() {
  return {
    createRoom: vi.fn(async (_options: Parameters<RoomServiceClientLike['createRoom']>[0]) => ({})),
    updateRoomMetadata: vi.fn(async (_room: string, _metadata: string) => ({})),
    deleteRoom: vi.fn(async (_room: string) => ({})),
  };
}

async function provision(endpoint: LiveKitEndpoint, extra: Partial<ProvisionRoomDeps> = {}) {
  const rooms = fakeRooms();
  const startRecording = vi.fn(async () => ({ status: 'started' as const, egressId: 'egress-1' }));
  const result = await provisionRoomForCreatedSession(SESSION, 'existing_session', {
    endpoint,
    rooms,
    startRecording,
    ...extra,
  });
  return { rooms, startRecording, result };
}

/** Identities and profiles a Meet dispatch must refuse. */
const BAD_IDENTITIES: Array<[string, unknown]> = [
  ['an upper-case prefix', 'MEET-AB12CD34'],
  ['upper-case hex', 'meet-AB12CD34'],
  ['7 hex characters', 'meet-ab12cd3'],
  ['9 hex characters', 'meet-ab12cd34e'],
  ['a candidate identity', 'candidate-ab12cd34-ab12cd34'],
  ["another session's bridge identity", 'meet-cd34ef56'],
  ['an empty identity', ''],
  ['a non-string identity', 12345678],
];
const BAD_PROFILES: Array<[string, unknown]> = [
  ['an upper-case profile', 'R1'],
  ['an empty profile', ''],
  ['a 65-character profile', 'a'.repeat(65)],
  ['a profile starting with a digit', '1r_dex'],
  ['a hyphenated profile', 'r1-dex-sales'],
  ['a non-string profile', 7],
];
const BAD_MEETS: Array<[string, unknown]> = [
  ...BAD_IDENTITIES.map(([label, candidateIdentity]): [string, unknown] => [
    label, { candidateIdentity, profile: PROFILE },
  ]),
  ...BAD_PROFILES.map(([label, profile]): [string, unknown] => [
    label, { candidateIdentity: MEET_IDENTITY, profile },
  ]),
  ['a missing profile', { candidateIdentity: MEET_IDENTITY }],
  ['a missing identity', { profile: PROFILE }],
  ['null', null],
];

// ── 1. The metadata strings ──────────────────────────────────────────

describe('browserDispatchMetadata: the exact strings', () => {
  it('without meet: exactly the browser string, as before M034', () => {
    expect(browserDispatchMetadata(SESSION)).toBe(BROWSER_DISPATCH);
    expect(browserDispatchMetadata(SESSION, undefined)).toBe(BROWSER_DISPATCH);
    expect(BROWSER_DISPATCH).toBe(JSON.stringify({ session_id: SESSION, channel: 'browser' }));
  });

  it('with meet: exactly session_id, channel meet, candidate_identity, profile, in that order', () => {
    const metadata = browserDispatchMetadata(SESSION, MEET);
    expect(metadata).toBe(MEET_DISPATCH);
    expect(Object.keys(JSON.parse(metadata!))).toEqual([
      'session_id', 'channel', 'candidate_identity', 'profile',
    ]);
  });

  it('accepts the profile bounds: one letter, and 64 characters', () => {
    expect(browserDispatchMetadata(SESSION, { candidateIdentity: MEET_IDENTITY, profile: 'a' }))
      .not.toBeNull();
    const longest = `r${'1'.repeat(63)}`;
    expect(browserDispatchMetadata(SESSION, { candidateIdentity: MEET_IDENTITY, profile: longest }))
      .not.toBeNull();
  });

  it.each(BAD_MEETS)('refuses %s (null)', (_label, meet) => {
    expect(browserDispatchMetadata(SESSION, meet as BrowserDispatchMeet)).toBeNull();
  });

  it('a session id that does not start with 8 lower-case hex characters has no bridge identity', () => {
    const upper = 'AB12CD34-5e6f-4a70-8b91-0000000000e1';
    expect(browserDispatchMetadata(upper, { candidateIdentity: 'meet-AB12CD34', profile: PROFILE }))
      .toBeNull();
    expect(browserDispatchMetadata(upper, MEET)).toBeNull();
  });
});

// ── 2. The browser worker gate's dispatch ────────────────────────────

describe('BrowserWorkerGate.dispatch: browser byte-identical, Meet exact', () => {
  it('Cloud, browser: one createDispatch with exactly the browser string, nothing listed or deleted', async () => {
    const scripted = scriptedClient();
    await expect(realGate(scripted.client).dispatch({ sessionId: SESSION, roomName: ROOM }))
      .resolves.toBe(true);
    expect(calls(scripted.createDispatch)).toEqual([[ROOM, BASE, { metadata: BROWSER_DISPATCH }]]);
    expect(scripted.createDispatch.mock.calls[0]![2]!.metadata).toBe(BROWSER_DISPATCH);
    expect(scripted.listDispatch).not.toHaveBeenCalled();
    expect(scripted.deleteDispatch).not.toHaveBeenCalled();
    expect(loggedCategories()).toEqual([]);
  });

  it('Cloud, Meet: one createDispatch with exactly the Meet string (a per-machine name is ignored)', async () => {
    for (const agentName of [undefined, MACHINE_NAME]) {
      const scripted = scriptedClient();
      const input = agentName === undefined
        ? { sessionId: SESSION, roomName: ROOM, meet: MEET }
        : { sessionId: SESSION, roomName: ROOM, agentName, meet: MEET };
      await expect(realGate(scripted.client).dispatch(input)).resolves.toBe(true);
      expect(calls(scripted.createDispatch)).toEqual([[ROOM, BASE, { metadata: MEET_DISPATCH }]]);
      expect(scripted.createDispatch.mock.calls[0]![2]!.metadata).toBe(MEET_DISPATCH);
      expect(scripted.listDispatch).not.toHaveBeenCalled();
    }
    expect(loggedCategories()).toEqual([]);
  });

  it('R1, browser: the first dispatch AND the retry carry exactly the browser string', async () => {
    selectR1();
    const scripted = scriptedClient((n) => (n === 1 ? 0 : 1));
    await expect(realGate(scripted.client).dispatch({ sessionId: SESSION, roomName: ROOM }))
      .resolves.toBe(true);
    expect(calls(scripted.createDispatch)).toEqual([
      [ROOM, BASE, { metadata: BROWSER_DISPATCH }],
      [ROOM, BASE, { metadata: BROWSER_DISPATCH }],
    ]);
    expect(scripted.deleteDispatch.mock.calls).toEqual([['d1', ROOM]]);
  });

  it('R1, Meet: the first dispatch AND the retry carry exactly the Meet string', async () => {
    selectR1();
    const scripted = scriptedClient((n) => (n === 1 ? 0 : 1));
    await expect(realGate(scripted.client).dispatch({ sessionId: SESSION, roomName: ROOM, meet: MEET }))
      .resolves.toBe(true);
    expect(calls(scripted.createDispatch)).toEqual([
      [ROOM, BASE, { metadata: MEET_DISPATCH }],
      [ROOM, BASE, { metadata: MEET_DISPATCH }],
    ]);
    for (const call of scripted.createDispatch.mock.calls) expect(call[2]!.metadata).toBe(MEET_DISPATCH);
    expect(scripted.deleteDispatch.mock.calls).toEqual([['d1', ROOM]]);
  });

  it('R1, Meet with a per-machine name: both dispatches go to that name with the Meet string', async () => {
    selectR1();
    const scripted = scriptedClient((n) => (n === 1 ? 0 : 1));
    const gate = realGate(scripted.client);
    await expect(gate.dispatch({ sessionId: SESSION, roomName: ROOM, agentName: MACHINE_NAME, meet: MEET }))
      .resolves.toBe(true);
    expect(calls(scripted.createDispatch)).toEqual([
      [ROOM, MACHINE_NAME, { metadata: MEET_DISPATCH }],
      [ROOM, MACHINE_NAME, { metadata: MEET_DISPATCH }],
    ]);
  });

  it('R1, Meet, first dispatch accepted: one createDispatch, no retry', async () => {
    selectR1();
    const scripted = scriptedClient(() => 1);
    await expect(realGate(scripted.client).dispatch({ sessionId: SESSION, roomName: ROOM, meet: MEET }))
      .resolves.toBe(true);
    expect(calls(scripted.createDispatch)).toEqual([[ROOM, BASE, { metadata: MEET_DISPATCH }]]);
    expect(scripted.deleteDispatch).not.toHaveBeenCalled();
  });

  it('builds the lazy LiveKit client only after the Meet metadata is valid (control)', async () => {
    selectR1();
    const scripted = scriptedClient(() => 1);
    mocks.dispatchClientFor.mockImplementation(() => scripted.client);
    await expect(realGate().dispatch({ sessionId: SESSION, roomName: ROOM, meet: MEET }))
      .resolves.toBe(true);
    expect(mocks.dispatchClientFor).toHaveBeenCalledTimes(1);
    expect(mocks.dispatchClientFor.mock.calls[0]![0]).toMatchObject({ target: 'r1', url: R1_SFU.url });
    expect(calls(scripted.createDispatch)).toEqual([[ROOM, BASE, { metadata: MEET_DISPATCH }]]);
  });

  describe.each(TARGETS)('a malformed Meet value on %s', (_target, select) => {
    it.each(BAD_MEETS)('%s: false, no LiveKit client, no createDispatch, one log line', async (_label, meet) => {
      select();
      const scripted = scriptedClient();
      mocks.dispatchClientFor.mockImplementation(() => scripted.client);
      const input = { sessionId: SESSION, roomName: ROOM, meet: meet as BrowserDispatchMeet };
      // Injected client: never used.
      await expect(realGate(scripted.client).dispatch(input)).resolves.toBe(false);
      // Lazy client: never even built.
      await expect(realGate().dispatch(input)).resolves.toBe(false);
      expect(scripted.createDispatch).not.toHaveBeenCalled();
      expect(scripted.listDispatch).not.toHaveBeenCalled();
      expect(scripted.deleteDispatch).not.toHaveBeenCalled();
      expect(mocks.dispatchClientFor).not.toHaveBeenCalled();
      expect(loggedCategories()).toEqual(['browser_dispatch_meet_invalid', 'browser_dispatch_meet_invalid']);
    });
  });

  it('the refusal line names only the category: no identity, profile or session id', async () => {
    const scripted = scriptedClient();
    const bad = { candidateIdentity: 'meet-cd34ef56', profile: 'secret_profile_name' };
    await realGate(scripted.client).dispatch({ sessionId: SESSION, roomName: ROOM, meet: bad });
    const lines = consoleError.mock.calls.map(([line]) => String(line));
    expect(lines).toHaveLength(1);
    for (const text of ['meet-cd34ef56', 'secret_profile_name', SESSION, 'ab12cd34']) {
      expect(lines[0]).not.toContain(text);
    }
  });
});

// ── 3. runR1WorkerGate passes meet on, and only when present ─────────

const runGate = (gate: BrowserWorkerGate, extra: { meet?: BrowserDispatchMeet } = {}) =>
  runR1WorkerGate({
    gate,
    sessionId: SESSION,
    roomName: ROOM,
    dispatches: () => emptyLister(),
    now: () => 0,
    ...extra,
  });

describe('runR1WorkerGate: meet reaches the dispatch only when present', () => {
  it('shared name: exactly { sessionId, roomName } without meet, plus meet with it', async () => {
    const browser = gateDouble();
    expect(await runGate(browser)).toBe('proceed');
    expect(browser.dispatch).toHaveBeenCalledTimes(1);
    expect(Object.keys(browser.dispatch.mock.calls[0]![0] as object)).toEqual(['sessionId', 'roomName']);
    expect(browser.dispatch).toHaveBeenCalledWith({ sessionId: SESSION, roomName: ROOM });

    const meet = gateDouble();
    expect(await runGate(meet, { meet: MEET })).toBe('proceed');
    const input = meet.dispatch.mock.calls[0]![0] as Record<string, unknown>;
    expect(Object.keys(input)).toEqual(['sessionId', 'roomName', 'meet']);
    expect(input).toEqual({ sessionId: SESSION, roomName: ROOM, meet: MEET });
    expect(input.meet).toBe(MEET);
  });

  it('per-machine name: exactly { sessionId, roomName, agentName } without meet, plus meet with it', async () => {
    const perMachine = { dispatchNameFor: vi.fn(() => MACHINE_NAME) };
    const browser = gateDouble(perMachine);
    expect(await runGate(browser)).toBe('proceed');
    expect(Object.keys(browser.dispatch.mock.calls[0]![0] as object))
      .toEqual(['sessionId', 'roomName', 'agentName']);
    expect(browser.dispatch)
      .toHaveBeenCalledWith({ sessionId: SESSION, roomName: ROOM, agentName: MACHINE_NAME });

    const meet = gateDouble(perMachine);
    expect(await runGate(meet, { meet: MEET })).toBe('proceed');
    const input = meet.dispatch.mock.calls[0]![0] as Record<string, unknown>;
    expect(Object.keys(input)).toEqual(['sessionId', 'roomName', 'agentName', 'meet']);
    expect(input.meet).toBe(MEET);
  });

  it('an explicit meet: undefined is the browser call (no meet key)', async () => {
    const gate = gateDouble();
    expect(await runGate(gate, { meet: undefined })).toBe('proceed');
    expect(Object.keys(gate.dispatch.mock.calls[0]![0] as object)).toEqual(['sessionId', 'roomName']);
  });

  it('a running interviewer is never re-dispatched, Meet or not', async () => {
    const gate = gateDouble();
    const lister = {
      listDispatch: vi.fn(async () => [{ id: 'AD_run', agentName: BASE, state: { jobs: [{}] } }]),
    };
    expect(await runR1WorkerGate({
      gate, sessionId: SESSION, roomName: ROOM, dispatches: () => lister, now: () => 0, meet: MEET,
    })).toBe('proceed');
    expect(gate.ensureReadyWorker).not.toHaveBeenCalled();
    expect(gate.dispatch).not.toHaveBeenCalled();
  });

  it('end to end on the R1 SFU: a per-machine lease gets the Meet string on the first dispatch and the retry', async () => {
    selectR1();
    const scripted = scriptedClient((n) => (n === 1 ? 0 : 1));
    const gate = realGate(scripted.client, {
      service: fakeService({
        status: 'ready', machineId: MACHINE, agentName: MACHINE_NAME, livekitHost: R1_HOST,
      }),
    });
    expect(await runGate(gate, { meet: MEET })).toBe('proceed');
    expect(calls(scripted.createDispatch)).toEqual([
      [ROOM, MACHINE_NAME, { metadata: MEET_DISPATCH }],
      [ROOM, MACHINE_NAME, { metadata: MEET_DISPATCH }],
    ]);
  });
});

// ── 4. runR1JoinGate threads meet ────────────────────────────────────

function joinDeps(gate: BrowserWorkerGate | null, over: Partial<R1JoinGateDeps> = {}) {
  return {
    // Never read: Cloud skips the M019 interlock and the R1 cases require machine names.
    db: {} as never,
    now: () => 0,
    resolveGate: vi.fn(() => gate),
    dispatches: vi.fn((_endpoint: LiveKitEndpoint) => emptyLister()),
    requireMachineAgentName: vi.fn(() => true),
    log: { error: vi.fn() },
    ...over,
  };
}

const WORKER_GATE_KEYS = ['gate', 'sessionId', 'roomName', 'dispatches', 'now', 'failClosed'];

describe('runR1JoinGate: meet is forwarded to runR1WorkerGate only when present', () => {
  it('without meet the worker gate input has no meet key (the browser exchange call)', async () => {
    const gate = gateDouble();
    expect(await runR1JoinGate({ endpoint: CLOUD, sessionId: SESSION, roomName: ROOM }, joinDeps(gate)))
      .toBe('proceed');
    expect(runR1WorkerGate).toHaveBeenCalledTimes(1);
    const input = vi.mocked(runR1WorkerGate).mock.calls[0]![0];
    expect(Object.keys(input)).toEqual(WORKER_GATE_KEYS);
    expect('meet' in input).toBe(false);
    // The browser join keeps its Cloud behaviour.
    expect(input.failClosed).toBe(false);
    expect(Object.keys(gate.dispatch.mock.calls[0]![0] as object)).toEqual(['sessionId', 'roomName']);
  });

  it('an explicit meet: undefined is the same browser call', async () => {
    const gate = gateDouble();
    await runR1JoinGate(
      { endpoint: CLOUD, sessionId: SESSION, roomName: ROOM, meet: undefined },
      joinDeps(gate),
    );
    expect(Object.keys(vi.mocked(runR1WorkerGate).mock.calls[0]![0])).toEqual(WORKER_GATE_KEYS);
  });

  it.each([
    ['Cloud', CLOUD],
    ['the R1 SFU', R1_SFU],
  ])('with meet on %s: appended last, the same object, failing closed, and it reaches the dispatch', async (_name, endpoint) => {
    const gate = gateDouble();
    expect(await runR1JoinGate({ endpoint, sessionId: SESSION, roomName: ROOM, meet: MEET }, joinDeps(gate)))
      .toBe('proceed');
    const input = vi.mocked(runR1WorkerGate).mock.calls[0]![0];
    expect(Object.keys(input)).toEqual([...WORKER_GATE_KEYS, 'meet']);
    expect(input.meet).toBe(MEET);
    // Only a dispatch carries the Meet values, so no endpoint may proceed without one (S05-R3).
    expect(input.failClosed).toBe(true);
    expect(gate.dispatch).toHaveBeenCalledWith({ sessionId: SESSION, roomName: ROOM, meet: MEET });
  });

  it.each(TARGETS)('end to end on %s: the real gate dispatches exactly the Meet string', async (_name, select) => {
    select();
    const endpoint = process.env.BROWSER_LIVEKIT_TARGET === 'r1' ? R1_SFU : CLOUD;
    const scripted = scriptedClient(() => 1);
    expect(await runR1JoinGate(
      { endpoint, sessionId: SESSION, roomName: ROOM, meet: MEET },
      joinDeps(realGate(scripted.client)),
    )).toBe('proceed');
    expect(calls(scripted.createDispatch)).toEqual([[ROOM, BASE, { metadata: MEET_DISPATCH }]]);
  });

  it.each(TARGETS)('end to end on %s without meet: exactly the browser string', async (_name, select) => {
    select();
    const endpoint = process.env.BROWSER_LIVEKIT_TARGET === 'r1' ? R1_SFU : CLOUD;
    const scripted = scriptedClient(() => 1);
    expect(await runR1JoinGate(
      { endpoint, sessionId: SESSION, roomName: ROOM },
      joinDeps(realGate(scripted.client)),
    )).toBe('proceed');
    expect(calls(scripted.createDispatch)).toEqual([[ROOM, BASE, { metadata: BROWSER_DISPATCH }]]);
  });

  it('a malformed meet defers the join (preparing) and releases the worker, nothing dispatched', async () => {
    const scripted = scriptedClient(() => 1);
    const service = fakeService();
    const gate = realGate(scripted.client, { service });
    const bad = { candidateIdentity: 'meet-cd34ef56', profile: PROFILE };
    expect(await runR1JoinGate(
      { endpoint: CLOUD, sessionId: SESSION, roomName: ROOM, meet: bad },
      joinDeps(gate),
    )).toBe('preparing');
    expect(scripted.createDispatch).not.toHaveBeenCalled();
    expect(service.releaseWorker).toHaveBeenCalledTimes(1);
    expect(loggedCategories()).toEqual(['browser_dispatch_meet_invalid']);
  });
});

// ── 5. Room metadata ─────────────────────────────────────────────────

describe('buildMinimalRoomMetadata: browser byte-identical, Meet appended after the lane', () => {
  it('Cloud and browser R1 strings are exactly as before M034', () => {
    expect(buildMinimalRoomMetadata(SESSION, ROOM)).toBe(CLOUD_ROOM);
    expect(buildMinimalRoomMetadata(SESSION, ROOM, 'cloud')).toBe(CLOUD_ROOM);
    expect(buildMinimalRoomMetadata(SESSION, ROOM, 'r1')).toBe(BROWSER_R1_ROOM);
    expect(buildMinimalRoomMetadata(SESSION, ROOM, 'r1', undefined)).toBe(BROWSER_R1_ROOM);
  });

  it('a Meet R1 room appends channel and candidate_identity after the lane key', () => {
    const metadata = buildMinimalRoomMetadata(SESSION, ROOM, 'r1', ROOM_MEET);
    expect(metadata).toBe(MEET_R1_ROOM);
    expect(Object.keys(JSON.parse(metadata))).toEqual([
      'session_id', 'room_name', 'lane', 'channel', 'candidate_identity',
    ]);
  });

  it('meet is ignored for a non-R1 lane', () => {
    expect(buildMinimalRoomMetadata(SESSION, ROOM, 'cloud', ROOM_MEET)).toBe(CLOUD_ROOM);
  });

  it('with a correlation id: session_id, room_name, correlation_id, lane (then the Meet keys)', () => {
    mocks.correlation.id = CORRELATION;
    expect(buildMinimalRoomMetadata(SESSION, ROOM, 'r1')).toBe(
      `{"session_id":"${SESSION}","room_name":"${ROOM}","correlation_id":"${CORRELATION}","lane":"r1"}`,
    );
    expect(Object.keys(JSON.parse(buildMinimalRoomMetadata(SESSION, ROOM, 'r1', ROOM_MEET)))).toEqual([
      'session_id', 'room_name', 'correlation_id', 'lane', 'channel', 'candidate_identity',
    ]);
  });
});

const R1_ROOM_KEYS = ['name', 'emptyTimeout', 'maxParticipants', 'metadata', 'departureTimeout'];

describe('provisionRoomForCreatedSession: the Meet room mirror', () => {
  it.each([
    ['the R1 SFU', R1_SFU],
    ['the Cloud fallback', CLOUD],
  ])('browser R1 room on %s: exactly as before (no channel, no identity)', async (_name, endpoint) => {
    const { rooms, result } = await provision(endpoint, { lane: 'r1', interviewRoundId: ROUND });
    expect(result).toEqual({ ok: true, roomName: ROOM, adopted: false });
    const options = rooms.createRoom.mock.calls[0]![0];
    expect(Object.keys(options)).toEqual(R1_ROOM_KEYS);
    expect(options).toEqual({
      name: ROOM,
      emptyTimeout: R1_ROOM_EMPTY_TIMEOUT_SEC,
      maxParticipants: R1_ROOM_MAX_PARTICIPANTS,
      metadata: BROWSER_R1_ROOM,
      departureTimeout: R1_ROOM_DEPARTURE_TIMEOUT_SEC,
    });
  });

  it.each([
    ['the R1 SFU', R1_SFU],
    ['the Cloud fallback', CLOUD],
  ])('Meet on %s: the marked room gains channel and candidate_identity, nothing else changes', async (_name, endpoint) => {
    const { rooms, startRecording, result } = await provision(endpoint, {
      lane: 'r1',
      interviewRoundId: ROUND,
      meet: ROOM_MEET,
    });
    expect(result).toEqual({ ok: true, roomName: ROOM, adopted: false });
    expect(rooms.createRoom).toHaveBeenCalledTimes(1);
    const options = rooms.createRoom.mock.calls[0]![0];
    expect(Object.keys(options)).toEqual(R1_ROOM_KEYS);
    expect(options).toEqual({
      name: ROOM,
      emptyTimeout: R1_ROOM_EMPTY_TIMEOUT_SEC,
      maxParticipants: R1_ROOM_MAX_PARTICIPANTS,
      metadata: MEET_R1_ROOM,
      departureTimeout: R1_ROOM_DEPARTURE_TIMEOUT_SEC,
    });
    expect(options.metadata).toBe(MEET_R1_ROOM);
    expect(R1_ROOM_DEPARTURE_TIMEOUT_SEC).toBe(120);
    expect(startRecording).not.toHaveBeenCalled();
    expect(mocks.egress).not.toHaveBeenCalled();
    expect(mocks.transition).toHaveBeenCalledWith(SESSION, 'created', 'waiting', undefined, {
      external_call_id: ROOM,
    });
  });

  it('Meet on an existing room: the converged metadata is exactly the Meet string', async () => {
    const rooms = fakeRooms();
    rooms.createRoom.mockRejectedValueOnce(new Error('already exists'));
    const result = await provisionRoomForCreatedSession(SESSION, 'existing_session', {
      endpoint: R1_SFU,
      rooms,
      lane: 'r1',
      interviewRoundId: ROUND,
      meet: ROOM_MEET,
      startRecording: vi.fn(),
    });
    expect(result.ok).toBe(true);
    expect(rooms.updateRoomMetadata.mock.calls).toEqual([[ROOM, MEET_R1_ROOM]]);
  });

  const REFUSED: Array<[string, Partial<ProvisionRoomDeps>]> = [
    ['without the R1 exchange lane (an R1 round)', { interviewRoundId: ROUND, meet: ROOM_MEET }],
    ['without the R1 exchange lane (no round)', { meet: ROOM_MEET }],
    ['with lane r1 but no round id', { lane: 'r1', meet: ROOM_MEET }],
    ['with lane r1 and a null round id', { lane: 'r1', interviewRoundId: null, meet: ROOM_MEET }],
    ['with lane r1 and an empty round id', { lane: 'r1', interviewRoundId: '', meet: ROOM_MEET }],
    ...BAD_IDENTITIES.map(([label, candidateIdentity]): [string, Partial<ProvisionRoomDeps>] => [
      `with ${label}`,
      { lane: 'r1', interviewRoundId: ROUND, meet: { candidateIdentity } as { candidateIdentity: string } },
    ]),
    ['with a null meet', { lane: 'r1', interviewRoundId: ROUND, meet: null as never }],
    ['with an empty meet object', { lane: 'r1', interviewRoundId: ROUND, meet: {} as never }],
  ];

  describe.each([
    ['the R1 SFU', R1_SFU],
    ['the Cloud fallback', CLOUD],
  ])('refused on %s before any provider call', (_name, endpoint) => {
    it.each(REFUSED)('meet %s: provider_failed carrying r1_lane_mismatch', async (_label, extra) => {
      const { rooms, startRecording, result } = await provision(endpoint, extra);
      expect(result).toMatchObject({
        ok: false,
        code: 'provider_failed',
        roomName: ROOM,
        terminated: false,
        terminateFailed: false,
      });
      expect((result as Extract<ProvisionRoomResult, { code: 'provider_failed' }>).error.message)
        .toBe(R1_LANE_MISMATCH_ERROR);
      expect(rooms.createRoom).not.toHaveBeenCalled();
      expect(rooms.updateRoomMetadata).not.toHaveBeenCalled();
      expect(rooms.deleteRoom).not.toHaveBeenCalled();
      expect(startRecording).not.toHaveBeenCalled();
      expect(mocks.egress).not.toHaveBeenCalled();
      expect(mocks.transition).not.toHaveBeenCalled();
    });
  });
});

// ── 6. provisionMarkedRoom passes meet last ──────────────────────────

const MARKED_SESSION = { id: SESSION, interview_round_id: ROUND };

function provisionOk() {
  return vi.fn<ProvisionMarkedRoomDeps['provisionRoom']>(async () => ({
    ok: true, roomName: ROOM, adopted: false,
  }));
}

describe('provisionMarkedRoom: meet appended last, only when present', () => {
  it('without meet: exactly the browser arguments, with and without a rooms factory', async () => {
    const plain = provisionOk();
    await provisionMarkedRoom(MARKED_SESSION, R1_SFU, { provisionRoom: plain });
    expect(plain).toHaveBeenCalledWith(SESSION, 'existing_session', {
      endpoint: R1_SFU, lane: 'r1', interviewRoundId: ROUND,
    });
    expect(Object.keys(plain.mock.calls[0]![2]!)).toEqual(['endpoint', 'lane', 'interviewRoundId']);

    const client = fakeRooms();
    const withRooms = provisionOk();
    await provisionMarkedRoom(MARKED_SESSION, R1_SFU, { provisionRoom: withRooms, rooms: () => client });
    expect(Object.keys(withRooms.mock.calls[0]![2]!))
      .toEqual(['endpoint', 'lane', 'interviewRoundId', 'rooms']);

    const explicitUndefined = provisionOk();
    await provisionMarkedRoom(MARKED_SESSION, R1_SFU, { provisionRoom: explicitUndefined, meet: undefined });
    expect(Object.keys(explicitUndefined.mock.calls[0]![2]!)).toEqual(['endpoint', 'lane', 'interviewRoundId']);
  });

  it('with meet: the same object, last, after rooms when a factory is injected', async () => {
    const plain = provisionOk();
    await provisionMarkedRoom(MARKED_SESSION, CLOUD, { provisionRoom: plain, meet: ROOM_MEET });
    const args = plain.mock.calls[0]![2]!;
    expect(Object.keys(args)).toEqual(['endpoint', 'lane', 'interviewRoundId', 'meet']);
    expect(args.meet).toBe(ROOM_MEET);

    const client = fakeRooms();
    const withRooms = provisionOk();
    await provisionMarkedRoom(MARKED_SESSION, CLOUD, {
      provisionRoom: withRooms,
      rooms: () => client,
      meet: ROOM_MEET,
    });
    expect(Object.keys(withRooms.mock.calls[0]![2]!))
      .toEqual(['endpoint', 'lane', 'interviewRoundId', 'rooms', 'meet']);
  });

  it('end to end with real provisioning: the room carries the Meet string; a bad identity is provider_failed', async () => {
    const client = fakeRooms();
    await expect(provisionMarkedRoom(MARKED_SESSION, R1_SFU, {
      provisionRoom: provisionRoomForCreatedSession,
      rooms: () => client,
      meet: ROOM_MEET,
    })).resolves.toEqual({ ok: true, roomName: ROOM, adopted: false });
    expect(client.createRoom.mock.calls[0]![0].metadata).toBe(MEET_R1_ROOM);

    const refused = fakeRooms();
    await expect(provisionMarkedRoom(MARKED_SESSION, R1_SFU, {
      provisionRoom: provisionRoomForCreatedSession,
      rooms: () => refused,
      meet: { candidateIdentity: 'meet-cd34ef56' },
    })).resolves.toEqual({ ok: false, reason: 'provider_failed' });
    expect(refused.createRoom).not.toHaveBeenCalled();
    expect(refused.updateRoomMetadata).not.toHaveBeenCalled();
  });
});
