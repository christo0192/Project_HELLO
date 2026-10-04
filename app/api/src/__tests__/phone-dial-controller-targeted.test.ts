/**
 * M009 E2 — `dialPhoneAttempt`'s TARGETED (per-machine) dispatch.
 *
 * Every phone worker used to register one shared LiveKit name, so a session's
 * job could land on ANY idle phone machine while every stop path judged a
 * machine by the session on its lease — and stopped machines mid-interview.
 * The fix binds the dispatch to the leased machine's reported name, and then
 * refuses to ring a candidate until that machine's agent is provably IN the
 * room. Both halves are high-risk: a wrong branch either dials a candidate
 * into dead air, or stops originating altogether. So this file pins:
 *
 *   (a) gate absent ⇒ shared name, no participant polling, markBusy as before;
 *   (b) ready + no reported name ⇒ shared name, attempt-epoch markBusy;
 *   (c) ready + verified per-machine name ⇒ per-machine dispatch, join poll
 *       sees a NEW agent, THEN the originate, and markBusy gets the LEASE epoch;
 *   (d) join timeout ⇒ no originate, worker released, infra-deferred exactly
 *       like a gate timeout (abandon, worker_not_ready);
 *   (e) an adopted room's pre-existing agent does NOT satisfy the barrier;
 *   (f) name/machine mismatch ⇒ worker_not_ready, no room provisioned;
 *   (g) the synthetic rehearsal path is unchanged.
 *
 * As in phone-dial-controller.test.ts, "no call" is always asserted by TWO
 * witnesses: `providerContacted === false` and the originate spy.
 *
 * Fixture machine ids are synthetic Fly-shaped ids; no candidate data appears.
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';

const livekit = vi.hoisted(() => ({ configured: true }));
vi.mock('../lib/room-provisioning.js', () => ({
  requireLiveKitConfigured: (): void => {
    if (!livekit.configured) throw new Error('LIVEKIT_URL ... must be set');
  },
}));

import {
  LEASE_MARGIN_SECONDS,
  PHONE_AGENT_JOIN_MAX_CONSECUTIVE_ERRORS,
  PHONE_AGENT_JOIN_POLL_MS,
  PHONE_AGENT_NAME_ATTRIBUTE,
  PHONE_WORKER_GATE_CEILING_SEC,
  PHONE_WORKER_READY_CEILING_SEC,
  PHONE_WORKER_START_WAIT_CEILING_SEC,
  classifyAgentNameAttr,
  classifyListingError,
  dialPhoneAttempt,
  newAgentJoinObservation,
  phoneAgentJoinObservationCode,
  type PhoneAgentJoinClock,
  type PhoneDialDeps,
} from '../integrations/livekit-phone-dial/dial.js';
import { loadPhoneDialConfig } from '../integrations/livekit-phone-dial/config.js';
import { createLogger } from '../lib/logger.js';
import { wrapDialableNumber } from '../integrations/livekit-phone-dial/dialable-number.js';
import {
  createSyntheticSipClient,
  phoneParticipantIdentity,
  type PhoneSipClient,
} from '../integrations/livekit-phone-dial/sip.js';
import {
  phoneRoomName,
  type PhoneRoomParticipantLike,
  type PhoneRoomServiceClientLike,
} from '../integrations/livekit-phone-dial/phone-room.js';
import { loadPhoneScreeningConfig } from '../lib/phone-screening/config.js';
import type { ConsentReader, ConsentRecordSnapshot } from '../lib/phone-screening/consent.js';
import type { AdmitPhoneAttemptResult, PhoneStores } from '../lib/phone-screening/ports.js';

const ENGAGEMENT = '11111111-2222-4333-8444-555555555555';
const CANDIDATE = '22222222-2222-4222-8222-222222222222';
const SESSION = '33333333-3333-4333-8333-333333333333';
const ATTEMPT = 'aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee';
/** The ATTEMPT epoch admission mints (0/1 in production). */
const ATTEMPT_EPOCH = 1;
/** The LEASE epoch the ready read returned (prev+1 per claim; 2-35 in production). */
const LEASE_EPOCH = 23;
const APP = 'project-hello-phone-voice';
const ROOM = phoneRoomName(SESSION);

const BASE = 'phone-screener';
const MACHINE = 'd895472c499e38';
const OTHER_MACHINE = '7812736a540d58';
const PER_MACHINE = `${BASE}-${MACHINE}`;

const NOW = new Date('2026-09-14T09:30:00.000Z');
const NUMBER = wrapDialableNumber('+919876543210');
const DIGEST = NUMBER.digest;
const ALL_SIX = ['ai_interview', 'recording', 'purpose', 'data_processing', 'retention', 'rights'];
const GRANTED: ConsentRecordSnapshot = { status: 'granted', consents: ALL_SIX, expiresAt: null };

const DIAL_CONFIG = loadPhoneDialConfig({
  PHONE_SIP_TRUNK_ID: 'trunk-main',
  PHONE_AGENT_NAME: BASE,
} as NodeJS.ProcessEnv);
const REQUIRED = DIAL_CONFIG.originateTimeoutSeconds + LEASE_MARGIN_SECONDS;

function screeningConfig(over: Record<string, string> = {}) {
  return loadPhoneScreeningConfig({
    PHONE_SCREENING_ENABLED: 'true',
    PHONE_RUNTIME_ENABLED: 'true',
    PHONE_DIAL_MODE: 'live',
    PHONE_DIAL_ALLOWLIST: DIGEST,
    ...over,
  } as NodeJS.ProcessEnv);
}

function after(seconds: number): string {
  return new Date(NOW.getTime() + seconds * 1000).toISOString();
}

/** A not_found exactly as livekit-server-sdk's TwirpError carries it. */
function notFound(): Error {
  return Object.assign(new Error('requested room does not exist'), { status: 404, code: 'not_found' });
}

/** An agent participant registered under `name`. */
function agent(identity: string, name: string): PhoneRoomParticipantLike {
  return { identity, kind: 4, attributes: { [PHONE_AGENT_NAME_ATTRIBUTE]: name } };
}

type Listing = ReadonlyArray<PhoneRoomParticipantLike> | Error;

let order: string[];
beforeEach(() => {
  order = [];
  livekit.configured = true;
});

interface Harness {
  deps: PhoneDialDeps;
  clock: PhoneAgentJoinClock & { slept: number[]; t: number };
  originate: ReturnType<typeof vi.fn>;
  heartbeat: ReturnType<typeof vi.fn>;
  createRoom: ReturnType<typeof vi.fn>;
  updateRoomMetadata: ReturnType<typeof vi.fn>;
  dispatch: ReturnType<typeof vi.fn>;
  listParticipants: ReturnType<typeof vi.fn>;
  ensureReadyWorker: ReturnType<typeof vi.fn>;
  releaseWorker: ReturnType<typeof vi.fn>;
  markBusy: ReturnType<typeof vi.fn>;
  abandonAttemptInfra: ReturnType<typeof vi.fn>;
}

function harness(opts: {
  config?: ReturnType<typeof screeningConfig>;
  dialConfig?: typeof DIAL_CONFIG;
  /** undefined ⇒ NO workerGate dep at all (the byte-identical default path). */
  worker?: Record<string, unknown>;
  /**
   * The room listings, in call order (the FIRST is the pre-dispatch snapshot
   * on a targeted dial). Past the end, the last entry repeats.
   */
  listings?: Listing[];
  /** Omit `listParticipants` from the room client entirely. */
  noListParticipants?: boolean;
  roomExists?: boolean;
  dispatchFails?: boolean;
  sip?: PhoneSipClient;
  /** How long (ms, on the fake clock) the worker gate takes to answer. */
  gateTakesMs?: number;
} = {}): Harness {
  const admit = vi.fn(async () => {
    order.push('admit');
    const ok: AdmitPhoneAttemptResult = {
      status: 'ok',
      attemptId: ATTEMPT,
      epoch: ATTEMPT_EPOCH,
      leaseToken: 'lease-token-1',
      leaseExpiresAt: after(REQUIRED + 60),
    };
    return ok as never;
  });
  // Renews relative to the `now` it is GIVEN, exactly as 0042 does
  // (lease_expires_at = p_now + lease), so a test can see which instant the
  // controller measured from.
  const heartbeat = vi.fn(async (input: { now: Date }) => {
    order.push('heartbeat');
    return {
      status: 'ok',
      leaseExpiresAt: new Date(input.now.getTime() + (REQUIRED + 5) * 1000).toISOString(),
    } as never;
  });
  const abandonAttemptInfra = vi.fn(async () => {
    order.push('abandonAttemptInfra');
    return { status: 'abandoned', restored: true };
  });
  const unreachable = async (): Promise<never> => {
    throw new Error('phone_store_method_not_expected');
  };
  const stores = {
    admitAttempt: admit,
    heartbeatAttempt: heartbeat,
    abandonAttemptInfra,
    heartbeatAttemptByEpoch: unreachable,
    reclaimAttemptLeases: unreachable,
    applyEvent: unreachable,
  } as unknown as PhoneStores;

  const consentReader: ConsentReader = {
    async latestConsentRecord() {
      return GRANTED;
    },
    async activeConsentTemplate() {
      return { requiredConsents: ALL_SIX };
    },
  };

  const createRoom = vi.fn(async () => {
    order.push('room');
    if (opts.roomExists) throw new Error('room already exists');
    return undefined;
  });
  const updateRoomMetadata = vi.fn(async () => undefined);
  const dispatch = vi.fn(async () => {
    order.push('dispatch');
    if (opts.dispatchFails) throw new Error('dispatch said no');
    return undefined;
  });
  const listings = opts.listings ?? [notFound(), []];
  const listParticipants = vi.fn(async () => {
    const i = listParticipants.mock.calls.length - 1;
    order.push(i === 0 ? 'snapshot' : 'poll');
    const next = listings[Math.min(i, listings.length - 1)];
    if (next instanceof Error) throw next;
    return next;
  });

  const originate = vi.fn(async () => {
    order.push('originate');
    return {
      participantIdentity: phoneParticipantIdentity(ATTEMPT),
      sipCallId: 'SC_provider_1',
      synthetic: false,
    } as never;
  });
  const sip: PhoneSipClient = opts.sip ?? { mode: 'live', createSipParticipant: originate };

  const ensureReadyWorker = vi.fn(async () => {
    order.push('ensureReadyWorker');
    // A slow cold boot: the Fly start wait + ready poll spend real time.
    if (opts.gateTakesMs !== undefined) clock.t += opts.gateTakesMs;
    return (opts.worker ?? { status: 'ready', machineId: MACHINE }) as never;
  });
  const releaseWorker = vi.fn(async () => {
    order.push('releaseWorker');
  });
  const markBusy = vi.fn(async () => {
    order.push('markBusy');
  });

  // A fake clock: `sleep` advances `now` by exactly what was asked, so the
  // barrier's budget is observable as the sum of its sleeps.
  const clock = {
    t: 1_000_000,
    slept: [] as number[],
    now(): number {
      return clock.t;
    },
    async sleep(ms: number): Promise<void> {
      clock.slept.push(ms);
      clock.t += ms;
    },
  };

  const rooms = (opts.noListParticipants
    ? { createRoom, updateRoomMetadata }
    : { createRoom, updateRoomMetadata, listParticipants }) as unknown as PhoneRoomServiceClientLike;

  const deps: PhoneDialDeps = {
    config: opts.config ?? screeningConfig(),
    dialConfig: opts.dialConfig ?? DIAL_CONFIG,
    stores,
    admission: { consentReader },
    sip,
    room: { rooms, dispatch: { createDispatch: dispatch } },
    leaseOwner: 'dialer-a',
    agentJoinClock: clock,
    ...(opts.worker === undefined
      ? {}
      : { workerGate: { app: APP, ensureReadyWorker, releaseWorker, markBusy } }),
  };

  return {
    deps, clock, originate, heartbeat, createRoom, updateRoomMetadata, dispatch,
    listParticipants, ensureReadyWorker, releaseWorker, markBusy, abandonAttemptInfra,
  };
}

function run(h: Harness) {
  return dialPhoneAttempt(
    {
      engagementId: ENGAGEMENT,
      candidateId: CANDIDATE,
      sessionId: SESSION,
      kind: 'initial',
      number: NUMBER,
      now: NOW,
    },
    h.deps,
  );
}

function expectNoNetwork(res: { providerContacted: boolean }, h: Harness): void {
  expect(res.providerContacted).toBe(false);
  expect(h.originate).not.toHaveBeenCalled();
}

/** The worker_not_ready infra deferral, exactly as a gate timeout returns it. */
function expectInfraDeferral(
  res: Awaited<ReturnType<typeof run>>,
  h: Harness,
  detail: string,
): void {
  expect(res.status).toBe('refused');
  expect(res.refusal).toBe('worker_not_ready');
  expect(res.detail).toBe(detail);
  expect(res.attemptId).toBe(ATTEMPT);
  expect(res.roomName).toBeUndefined();
  expectNoNetwork(res, h);
  // Same accounting as a gate timeout: abandoned NOW, charged nothing.
  expect(h.abandonAttemptInfra).toHaveBeenCalledTimes(1);
  expect(h.abandonAttemptInfra).toHaveBeenCalledWith(
    expect.objectContaining({ attemptId: ATTEMPT }),
  );
  // The worker we claimed is handed back; nothing is marked busy.
  expect(h.releaseWorker).toHaveBeenCalledTimes(1);
  expect(h.releaseWorker).toHaveBeenCalledWith({ app: APP, machineId: MACHINE, sessionId: SESSION });
  expect(h.markBusy).not.toHaveBeenCalled();
  // No lease extension for a dial that will not be placed.
  expect(h.heartbeat).not.toHaveBeenCalled();
}

const TARGETED_READY = {
  status: 'ready',
  machineId: MACHINE,
  epoch: LEASE_EPOCH,
  agentName: PER_MACHINE,
};

// ═══════════════════════════════════════════════════════════════════════
// (a) / (b) — the UNTARGETED paths are byte-identical to before.
// ═══════════════════════════════════════════════════════════════════════

describe('M009 E2 — the untargeted (shared-name) paths are unchanged', () => {
  it('(a) gate ABSENT: dispatches the shared name, never lists the room, never marks busy', async () => {
    const h = harness({});
    const res = await run(h);

    expect(res.status).toBe('dialing');
    expect(h.dispatch).toHaveBeenCalledTimes(1);
    expect(h.dispatch.mock.calls[0]?.[0]).toBe(ROOM);
    expect(h.dispatch.mock.calls[0]?.[1]).toBe(BASE);
    expect(h.listParticipants).not.toHaveBeenCalled();
    expect(h.clock.slept).toEqual([]);
    expect(h.ensureReadyWorker).not.toHaveBeenCalled();
    expect(h.markBusy).not.toHaveBeenCalled();
    expect(h.originate).toHaveBeenCalledTimes(1);
  });

  it('(a) gate `disabled`: same as absent — shared name, no polling, no busy', async () => {
    const h = harness({ worker: { status: 'disabled' } });
    const res = await run(h);

    expect(res.status).toBe('dialing');
    expect(h.dispatch.mock.calls[0]?.[1]).toBe(BASE);
    expect(h.listParticipants).not.toHaveBeenCalled();
    expect(h.markBusy).not.toHaveBeenCalled();
  });

  for (const [label, worker] of [
    ['agentName null', { status: 'ready', machineId: MACHINE, epoch: LEASE_EPOCH, agentName: null }],
    ['agentName absent (a pre-M009 gate)', { status: 'ready', machineId: MACHINE }],
  ] as const) {
    it(`(b) ready + ${label}: shared name, no polling, markBusy with the ATTEMPT epoch as before`, async () => {
      const h = harness({ worker });
      const res = await run(h);

      expect(res.status).toBe('dialing');
      expect(res.machineId).toBe(MACHINE);
      expect(h.dispatch.mock.calls[0]?.[1]).toBe(BASE);
      expect(h.listParticipants).not.toHaveBeenCalled();
      expect(h.clock.slept).toEqual([]);
      // Deliberately unchanged — see the markBusy comment in dial.ts.
      expect(h.markBusy).toHaveBeenCalledTimes(1);
      expect(h.markBusy).toHaveBeenCalledWith({
        app: APP,
        machineId: MACHINE,
        sessionId: SESSION,
        epoch: ATTEMPT_EPOCH,
      });
      expect(h.releaseWorker).not.toHaveBeenCalled();
      expect(h.abandonAttemptInfra).not.toHaveBeenCalled();
    });
  }
});

// ═══════════════════════════════════════════════════════════════════════
// (c) — the targeted happy path.
// ═══════════════════════════════════════════════════════════════════════

describe('M009 E2 — a verified per-machine name binds the dispatch and gates the ring', () => {
  it('(c) dispatches the per-machine name, waits for a NEW agent, THEN originates; markBusy gets the LEASE epoch', async () => {
    const h = harness({
      worker: TARGETED_READY,
      // snapshot: room not created yet; poll 1: empty; poll 2: our agent.
      listings: [notFound(), [], [agent('AJ_new', PER_MACHINE)]],
    });
    const res = await run(h);

    expect(res.status).toBe('dialing');
    expect(res.providerContacted).toBe(true);
    expect(res.machineId).toBe(MACHINE);
    // The dispatch is bound to the leased machine.
    expect(h.dispatch).toHaveBeenCalledTimes(1);
    expect(h.dispatch.mock.calls[0]?.[0]).toBe(ROOM);
    expect(h.dispatch.mock.calls[0]?.[1]).toBe(PER_MACHINE);
    // Snapshot BEFORE the room/dispatch; polls AFTER; ring only after the join.
    expect(order.indexOf('snapshot')).toBeLessThan(order.indexOf('room'));
    expect(order.indexOf('dispatch')).toBeLessThan(order.indexOf('poll'));
    expect(order.lastIndexOf('poll')).toBeLessThan(order.indexOf('originate'));
    expect(h.listParticipants).toHaveBeenCalledTimes(3);
    for (const call of h.listParticipants.mock.calls) expect(call[0]).toBe(ROOM);
    // One poll interval was slept between the two polls.
    expect(h.clock.slept).toEqual([PHONE_AGENT_JOIN_POLL_MS]);
    // The LEASE epoch — the token mark_voice_worker_busy actually compares.
    expect(h.markBusy).toHaveBeenCalledTimes(1);
    expect(h.markBusy).toHaveBeenCalledWith({
      app: APP,
      machineId: MACHINE,
      sessionId: SESSION,
      epoch: LEASE_EPOCH,
    });
    expect(order.indexOf('originate')).toBeLessThan(order.indexOf('markBusy'));
    // The attempt itself still carries the ATTEMPT epoch.
    expect(res.epoch).toBe(ATTEMPT_EPOCH);
    expect(h.releaseWorker).not.toHaveBeenCalled();
    expect(h.abandonAttemptInfra).not.toHaveBeenCalled();
  });

  it('a not_found while polling is "not yet", never "joined" — it keeps waiting', async () => {
    const h = harness({
      worker: TARGETED_READY,
      listings: [notFound(), notFound(), notFound(), [agent('AJ_new', PER_MACHINE)]],
    });
    const res = await run(h);
    expect(res.status).toBe('dialing');
    expect(h.listParticipants).toHaveBeenCalledTimes(4);
  });

  it('a targeted gate WITHOUT a lease epoch originates but marks nothing busy (never guesses a token)', async () => {
    const h = harness({
      worker: { status: 'ready', machineId: MACHINE, agentName: PER_MACHINE },
      listings: [[], [agent('AJ_new', PER_MACHINE)]],
    });
    const res = await run(h);
    expect(res.status).toBe('dialing');
    expect(h.markBusy).not.toHaveBeenCalled();
  });
});

// ═══════════════════════════════════════════════════════════════════════
// (d) / (e) — the barrier refuses anything short of a proven NEW join.
// ═══════════════════════════════════════════════════════════════════════

describe('M009 E2 — the agent-join barrier never dials into a room without the targeted agent', () => {
  it('(d) TIMEOUT: no originate, worker released, infra-deferred like a gate timeout', async () => {
    const h = harness({ worker: TARGETED_READY, listings: [notFound(), []] });
    const res = await run(h);

    expectInfraDeferral(res, h, 'agent_join_timeout');
    // The room WAS provisioned and dispatched (that is what the barrier waits on)…
    expect(h.createRoom).toHaveBeenCalledTimes(1);
    expect(h.dispatch).toHaveBeenCalledTimes(1);
    // …and the wait was bounded by the configured join timeout (default 20 s,
    // well inside the default 240 s lease after the 120 s ready ceiling).
    const slept = h.clock.slept.reduce((a, b) => a + b, 0);
    expect(slept).toBe(20_000);
    expect(Math.max(...h.clock.slept)).toBeLessThanOrEqual(PHONE_AGENT_JOIN_POLL_MS);
    expect(order.indexOf('releaseWorker')).toBeLessThan(order.indexOf('abandonAttemptInfra'));
  });

  it('(d) the join wait is CLAMPED so start-wait + ready-ceiling + join never outlives the admission lease', async () => {
    // lease 220 s − (60 s start wait + 120 s ready ceiling) − 5 s margin = 35 s,
    // below the 60 s asked for. (Clamping against the ready ceiling alone would
    // have allowed the full 60 s and overrun the lease on a slow cold boot.)
    expect(PHONE_WORKER_GATE_CEILING_SEC).toBe(
      PHONE_WORKER_START_WAIT_CEILING_SEC + PHONE_WORKER_READY_CEILING_SEC,
    );
    const h = harness({
      worker: TARGETED_READY,
      config: screeningConfig({ PHONE_LEASE_SECONDS: '220' }),
      dialConfig: loadPhoneDialConfig({
        PHONE_SIP_TRUNK_ID: 'trunk-main',
        PHONE_AGENT_NAME: BASE,
        PHONE_AGENT_JOIN_TIMEOUT_SEC: '60',
      } as NodeJS.ProcessEnv),
      listings: [[], []],
    });
    const res = await run(h);
    expect(res.refusal).toBe('worker_not_ready');
    expect(h.clock.slept.reduce((a, b) => a + b, 0)).toBe(35_000);
  });

  it('a SINGLE transient listing error mid-wait is "not seen yet": it keeps polling and still dials', async () => {
    const h = harness({
      worker: TARGETED_READY,
      listings: [notFound(), [], new Error('livekit 429'), [agent('AJ_new', PER_MACHINE)]],
    });
    const res = await run(h);
    expect(res.status).toBe('dialing');
    expect(h.originate).toHaveBeenCalledTimes(1);
    expect(h.releaseWorker).not.toHaveBeenCalled();
    expect(h.abandonAttemptInfra).not.toHaveBeenCalled();
  });

  it('an error never counts as a join, and errors that do not repeat back-to-back never give up', async () => {
    const boom = new Error('livekit 503');
    const h = harness({
      worker: TARGETED_READY,
      // snapshot, then error/empty alternating — never PHONE_AGENT_JOIN_MAX_CONSECUTIVE_ERRORS in a row.
      listings: [[], boom, boom, [], boom, boom, [], [agent('AJ_new', PER_MACHINE)]],
    });
    const res = await run(h);
    expect(res.status).toBe('dialing');
    expect(h.listParticipants).toHaveBeenCalledTimes(8);
  });

  it(`(d) PERSISTENT listing errors (${PHONE_AGENT_JOIN_MAX_CONSECUTIVE_ERRORS} in a row) stop the wait and defer (an unprovable join is no join)`, async () => {
    const h = harness({
      worker: TARGETED_READY,
      listings: [notFound(), [], new Error('livekit 503')],
    });
    const res = await run(h);
    expectInfraDeferral(res, h, 'agent_join_unverifiable');
    // snapshot + one good poll + the consecutive failures.
    expect(h.listParticipants).toHaveBeenCalledTimes(2 + PHONE_AGENT_JOIN_MAX_CONSECUTIVE_ERRORS);
    // Well inside the join budget — a broken LiveKit does not burn 20 s.
    expect(h.clock.slept.reduce((a, b) => a + b, 0)).toBe(
      PHONE_AGENT_JOIN_POLL_MS * PHONE_AGENT_JOIN_MAX_CONSECUTIVE_ERRORS,
    );
  });

  it('(d) a pre-dispatch snapshot that cannot be read (persistently) defers BEFORE any room or dispatch', async () => {
    const h = harness({ worker: TARGETED_READY, listings: [new Error('livekit 503')] });
    const res = await run(h);
    expectInfraDeferral(res, h, 'agent_join_unverifiable');
    expect(h.listParticipants).toHaveBeenCalledTimes(PHONE_AGENT_JOIN_MAX_CONSECUTIVE_ERRORS);
    expect(h.createRoom).not.toHaveBeenCalled();
    expect(h.dispatch).not.toHaveBeenCalled();
  });

  it('a pre-dispatch snapshot that fails ONCE is retried, and the dial proceeds', async () => {
    const h = harness({
      worker: TARGETED_READY,
      listings: [new Error('livekit 429'), notFound(), [agent('AJ_new', PER_MACHINE)]],
    });
    const res = await run(h);
    expect(res.status).toBe('dialing');
    expect(order.indexOf('room')).toBeGreaterThan(-1);
    expect(h.originate).toHaveBeenCalledTimes(1);
  });

  it('(d) a room client with no listParticipants cannot prove a join: defers, provisions nothing', async () => {
    const h = harness({ worker: TARGETED_READY, noListParticipants: true });
    const res = await run(h);
    expectInfraDeferral(res, h, 'agent_join_unverifiable');
    expect(h.createRoom).not.toHaveBeenCalled();
  });

  it('(d) a FAILED targeted dispatch defers at once instead of waiting out the join timeout', async () => {
    const h = harness({ worker: TARGETED_READY, dispatchFails: true });
    const res = await run(h);
    expectInfraDeferral(res, h, 'agent_dispatch_failed');
    expect(h.clock.slept).toEqual([]);
    // Only the snapshot was read.
    expect(h.listParticipants).toHaveBeenCalledTimes(1);
  });

  it('(e) an ADOPTED room whose old agent (same name) is still there does NOT satisfy the barrier', async () => {
    const old = agent('AJ_old', PER_MACHINE);
    const h = harness({
      worker: TARGETED_READY,
      roomExists: true,
      listings: [[old], [old]],
    });
    const res = await run(h);

    // The room was adopted, not created…
    expect(h.updateRoomMetadata).toHaveBeenCalledTimes(1);
    // …and the agent that was already there is not this dispatch's agent.
    expectInfraDeferral(res, h, 'agent_join_timeout');
  });

  it('(e) in the same adopted room, a NEW agent identity alongside the old one DOES satisfy it', async () => {
    const old = agent('AJ_old', PER_MACHINE);
    const h = harness({
      worker: TARGETED_READY,
      roomExists: true,
      listings: [[old], [old], [old, agent('AJ_new', PER_MACHINE)]],
    });
    const res = await run(h);
    expect(res.status).toBe('dialing');
    expect(h.originate).toHaveBeenCalledTimes(1);
  });

  for (const [label, participant] of [
    ['a new agent of ANOTHER machine', agent('AJ_other', `${BASE}-${OTHER_MACHINE}`)],
    ['a new agent under the SHARED name', agent('AJ_shared', BASE)],
    ['a SIP participant carrying the targeted name', { identity: 'SIP_x', kind: 3, attributes: { [PHONE_AGENT_NAME_ATTRIBUTE]: PER_MACHINE } }],
    ['an agent with the name under the WRONG attribute key', { identity: 'AJ_key', kind: 4, attributes: { 'lk.agent_name': PER_MACHINE } }],
    ['an agent with no identity', { kind: 4, attributes: { [PHONE_AGENT_NAME_ATTRIBUTE]: PER_MACHINE } }],
  ] as const) {
    it(`(e) ${label} does not satisfy the barrier`, async () => {
      const h = harness({ worker: TARGETED_READY, listings: [[], [participant]] });
      const res = await run(h);
      expectInfraDeferral(res, h, 'agent_join_timeout');
    });
  }

  it('accepts the enum NAME spelling of the agent kind as well as its number', async () => {
    const h = harness({
      worker: TARGETED_READY,
      listings: [[], [{ identity: 'AJ_new', kind: 'AGENT', attributes: { [PHONE_AGENT_NAME_ATTRIBUTE]: PER_MACHINE } }]],
    });
    const res = await run(h);
    expect(res.status).toBe('dialing');
  });
});

// ═══════════════════════════════════════════════════════════════════════
// (f) — a reported name that does not belong to the leased machine.
// ═══════════════════════════════════════════════════════════════════════

describe('M009 E2 — a reported name is trusted only if it is exactly <shared>-<leased machine>', () => {
  for (const [label, reported] of [
    ['another machine\'s name', `${BASE}-${OTHER_MACHINE}`],
    ['a different base', `browser-screener-${MACHINE}`],
    ['the bare shared name', BASE],
    ['an empty string', ''],
  ] as const) {
    it(`(f) ${label}: worker_not_ready, no room, no dispatch, no polling — never downgraded to the shared name`, async () => {
      const h = harness({
        worker: { status: 'ready', machineId: MACHINE, epoch: LEASE_EPOCH, agentName: reported },
      });
      const res = await run(h);

      expectInfraDeferral(res, h, 'agent_name_mismatch');
      expect(h.createRoom).not.toHaveBeenCalled();
      expect(h.dispatch).not.toHaveBeenCalled();
      expect(h.listParticipants).not.toHaveBeenCalled();
    });
  }
});

// ═══════════════════════════════════════════════════════════════════════
// (g) — the synthetic rehearsal path.
// ═══════════════════════════════════════════════════════════════════════

describe('M009 E2 — the synthetic rehearsal path is unchanged', () => {
  it('(g) synthetic, no gate: shared-name dispatch, no polling, synthetic result', async () => {
    const h = harness({
      config: screeningConfig({ PHONE_DIAL_MODE: 'synthetic' }),
      sip: createSyntheticSipClient(),
    });
    const res = await run(h);

    expect(res.status).toBe('dialing');
    expect(res.synthetic).toBe(true);
    expect(res.providerContacted).toBe(false);
    expect(res.participantIdentity).toBe(`phone-${ATTEMPT}`);
    expect(h.dispatch.mock.calls[0]?.[1]).toBe(BASE);
    expect(h.listParticipants).not.toHaveBeenCalled();
    expect(h.clock.slept).toEqual([]);
  });

  it('(g) synthetic + untargeted ready gate: unchanged (attempt-epoch markBusy, no polling)', async () => {
    const h = harness({
      config: screeningConfig({ PHONE_DIAL_MODE: 'synthetic' }),
      sip: createSyntheticSipClient(),
      worker: { status: 'ready', machineId: MACHINE },
    });
    const res = await run(h);

    expect(res.status).toBe('dialing');
    expect(res.synthetic).toBe(true);
    expect(h.listParticipants).not.toHaveBeenCalled();
    expect(h.markBusy).toHaveBeenCalledWith(expect.objectContaining({ epoch: ATTEMPT_EPOCH }));
  });
});

// ═══════════════════════════════════════════════════════════════════════
// Gate 5 measures the lease at the CURRENT instant, not at `request.now`.
// ═══════════════════════════════════════════════════════════════════════

describe('M009 — Gate 5 measures the lease at the current instant, not the stale request.now', () => {
  // Admission hands back a lease expiring REQUIRED + 60 s after NOW. A worker
  // gate that spends 200 s (a slow cold boot) leaves far less than REQUIRED.
  const SLOW_GATE_MS = 200_000;

  it('a slow targeted gate + join: the lease is RENEWED, from the current instant, before the ring', async () => {
    const h = harness({
      worker: TARGETED_READY,
      gateTakesMs: SLOW_GATE_MS,
      listings: [notFound(), [], [agent('AJ_new', PER_MACHINE)]],
    });
    const res = await run(h);

    expect(res.status).toBe('dialing');
    expect(h.heartbeat).toHaveBeenCalledTimes(1);
    const hb = h.heartbeat.mock.calls[0]?.[0] as { now: Date };
    // NOW + the gate + the one poll interval the join slept.
    expect(hb.now.getTime()).toBe(NOW.getTime() + SLOW_GATE_MS + PHONE_AGENT_JOIN_POLL_MS);
    expect(order.indexOf('heartbeat')).toBeLessThan(order.indexOf('originate'));
  });

  it('the untargeted path is covered too: a slow gate renews before the ring', async () => {
    const h = harness({
      worker: { status: 'ready', machineId: MACHINE },
      gateTakesMs: SLOW_GATE_MS,
    });
    const res = await run(h);
    expect(res.status).toBe('dialing');
    expect(h.heartbeat).toHaveBeenCalledTimes(1);
    expect((h.heartbeat.mock.calls[0]?.[0] as { now: Date }).now.getTime())
      .toBe(NOW.getTime() + SLOW_GATE_MS);
  });

  it('a lease the database reports LOST at the current instant refuses before any carrier', async () => {
    const h = harness({
      worker: TARGETED_READY,
      gateTakesMs: SLOW_GATE_MS,
      listings: [notFound(), [agent('AJ_new', PER_MACHINE)]],
    });
    h.heartbeat.mockImplementationOnce(async () => {
      order.push('heartbeat');
      return { status: 'lease_lost' } as never;
    });
    const res = await run(h);
    expect(res.status).toBe('refused');
    expect(res.refusal).toBe('lease_too_short');
    expectNoNetwork(res, h);
    expect(h.releaseWorker).toHaveBeenCalledTimes(1);
  });

  it('a fast gate does not renew (the lease still covers the originate)', async () => {
    const h = harness({
      worker: TARGETED_READY,
      listings: [notFound(), [agent('AJ_new', PER_MACHINE)]],
    });
    const res = await run(h);
    expect(res.status).toBe('dialing');
    expect(h.heartbeat).not.toHaveBeenCalled();
  });

  it('an infra deferral after a slow gate stamps the abandon with the CURRENT instant', async () => {
    const h = harness({
      worker: TARGETED_READY,
      gateTakesMs: SLOW_GATE_MS,
      listings: [notFound(), []],
    });
    const res = await run(h);
    expectInfraDeferral(res, h, 'agent_join_timeout');
    const abandon = h.abandonAttemptInfra.mock.calls[0]?.[0] as unknown as { now: Date };
    expect(abandon.now.getTime()).toBe(NOW.getTime() + SLOW_GATE_MS + 20_000);
  });
});

// ═══════════════════════════════════════════════════════════════════════
// M010 — the targeted path says WHAT it saw, in a closed vocabulary.
// Production deferred every targeted dial while the worker was connected to
// the room, and no line recorded why. One code per targeted dial, no values.
// ═══════════════════════════════════════════════════════════════════════

describe('M010 — the targeted path reports what the join barrier saw', () => {
  function observed(opts: Parameters<typeof harness>[0], sinkImpl?: () => unknown) {
    const h = harness(opts);
    const sink = vi.fn((code: string, elapsedSec: number, machineId: string) => {
      void code; void elapsedSec; void machineId;
      return sinkImpl?.();
    });
    const deps = { ...h.deps, onAgentJoinObservation: sink as PhoneDialDeps['onAgentJoinObservation'] };
    return { h: { ...h, deps }, sink };
  }
  const codeOf = (sink: ReturnType<typeof vi.fn>): string => String(sink.mock.calls[0]?.[0] ?? '');

  it('a join reports o.j with the per-machine name matched and the leased machine id', async () => {
    const { h, sink } = observed({
      worker: TARGETED_READY,
      listings: [notFound(), [], [agent('AJ_new', PER_MACHINE)]],
    });
    const res = await run(h);
    expect(res.status).toBe('dialing');
    expect(sink).toHaveBeenCalledTimes(1);
    expect(codeOf(sink)).toBe('o.j:l.2.0.0:e.0:f.0:s.0:p.1:a.1:k.4:n.y:x.n');
    expect(sink.mock.calls[0]?.[1]).toBe(PHONE_AGENT_JOIN_POLL_MS / 1000);
    expect(sink.mock.calls[0]?.[2]).toBe(MACHINE);
  });

  for (const [label, participant, n] of [
    ['an agent with NO attributes at all', { identity: 'AJ_new', kind: 4 }, 'e'],
    ['an agent with an EMPTY attribute map', { identity: 'AJ_new', kind: 4, attributes: {} }, 'e'],
    ['an agent whose name sits under another key', { identity: 'AJ_new', kind: 4, attributes: { 'lk.agent_name': PER_MACHINE } }, 'a'],
    ['an agent of ANOTHER machine', agent('AJ_other', `${BASE}-${OTHER_MACHINE}`), 'm'],
    ['an agent under the SHARED name', agent('AJ_shared', BASE), 's'],
    ['an agent under an unrelated name', agent('AJ_x', 'browser-screener'), 'o'],
  ] as const) {
    it(`a timeout with ${label} reports n.${n} and still defers exactly as before`, async () => {
      const { h, sink } = observed({ worker: TARGETED_READY, listings: [[], [participant]] });
      expectInfraDeferral(await run(h), h, 'agent_join_timeout');
      expect(codeOf(sink)).toMatch(
        new RegExp(String.raw`^o\.t:l\.\d+\.0\.0:e\.0:f\.0:s\.0:p\.1:a\.1:k\.4:n\.` + n + String.raw`:x\.n$`),
      );
      expect(sink.mock.calls[0]?.[1]).toBe(20);
    });
  }

  it('our worker joining as a STANDARD participant shows up in x, not n', async () => {
    const { h, sink } = observed({
      worker: TARGETED_READY,
      listings: [[], [{ identity: 'AJ_new', kind: 0, attributes: { [PHONE_AGENT_NAME_ATTRIBUTE]: PER_MACHINE } }]],
    });
    expectInfraDeferral(await run(h), h, 'agent_join_timeout');
    expect(codeOf(sink)).toMatch(/:a\.0:k\.0:n\.n:x\.y$/);
  });

  it('a SIP-only room reports kind 3 with no new agent', async () => {
    const { h, sink } = observed({
      worker: TARGETED_READY,
      listings: [[], [{ identity: 'SIP_x', kind: 3, attributes: {} }]],
    });
    expectInfraDeferral(await run(h), h, 'agent_join_timeout');
    expect(codeOf(sink)).toMatch(/:p\.1:a\.0:k\.3:n\.n:x\.e$/);
  });

  it('string kinds map to their enum numbers; anything else is x', async () => {
    const { h, sink } = observed({
      worker: TARGETED_READY,
      listings: [[], [
        { identity: 'P1', kind: 'STANDARD', attributes: {} },
        { identity: 'P2', kind: 'sip', attributes: {} },
        { identity: 'P3', kind: 'WEIRD', attributes: {} },
      ]],
    });
    expectInfraDeferral(await run(h), h, 'agent_join_timeout');
    expect(codeOf(sink)).toMatch(/:k\.0\.3\.x:/);
  });

  it('a room that never appears counts not_found listings separately', async () => {
    const { h, sink } = observed({ worker: TARGETED_READY, listings: [notFound()] });
    expectInfraDeferral(await run(h), h, 'agent_join_timeout');
    expect(codeOf(sink)).toMatch(/^o\.t:l\.0\.\d+\.0:e\.0:f\.0:s\.0:p\.0:a\.0:k\.none:n\.n:x\.n$/);
  });

  it('a room that VANISHES after a good listing sets f.1', async () => {
    const { h, sink } = observed({ worker: TARGETED_READY, listings: [notFound(), [], notFound()] });
    expectInfraDeferral(await run(h), h, 'agent_join_timeout');
    expect(codeOf(sink)).toMatch(/:f\.1:/);
  });

  for (const [label, err, cls] of [
    ['a Twirp permission_denied', Object.assign(new Error('no'), { code: 'permission_denied' }), 'pd'],
    ['an HTTP 401', Object.assign(new Error('no'), { status: 401 }), 'ua'],
    ['a Twirp unavailable', Object.assign(new Error('no'), { code: 'unavailable' }), 'un'],
    ['an HTTP 500', Object.assign(new Error('no'), { status: 500 }), 'in'],
    ['a plain error', new Error('livekit 503'), 'ot'],
  ] as const) {
    it(`persistent listing errors (${label}) report o.u with class ${cls}`, async () => {
      const { h, sink } = observed({ worker: TARGETED_READY, listings: [notFound(), [], err] });
      expectInfraDeferral(await run(h), h, 'agent_join_unverifiable');
      expect(codeOf(sink)).toBe(
        `o.u:l.1.0.${PHONE_AGENT_JOIN_MAX_CONSECUTIVE_ERRORS}:e.${cls}:f.0:s.0:p.0:a.0:k.none:n.n:x.n`,
      );
    });
  }

  it('an unreadable SNAPSHOT reports o.su before any room or dispatch', async () => {
    const { h, sink } = observed({
      worker: TARGETED_READY,
      listings: [Object.assign(new Error('no'), { code: 'unauthenticated' })],
    });
    expectInfraDeferral(await run(h), h, 'agent_join_unverifiable');
    expect(h.createRoom).not.toHaveBeenCalled();
    expect(codeOf(sink)).toBe(`o.su:l.0.0.${PHONE_AGENT_JOIN_MAX_CONSECUTIVE_ERRORS}:e.ua:f.0:s.0:p.0:a.0:k.none:n.n:x.n`);
  });

  it('a FAILED dispatch reports o.nd', async () => {
    const { h, sink } = observed({ worker: TARGETED_READY, listings: [notFound()], dispatchFails: true });
    expectInfraDeferral(await run(h), h, 'agent_dispatch_failed');
    expect(codeOf(sink)).toBe('o.nd:l.0.1.0:e.0:f.0:s.0:p.0:a.0:k.none:n.n:x.n');
  });

  it('agents already in an adopted room are counted in s and not as new', async () => {
    const old = agent('AJ_old', PER_MACHINE);
    const { h, sink } = observed({ worker: TARGETED_READY, listings: [[old], [old]] });
    expectInfraDeferral(await run(h), h, 'agent_join_timeout');
    expect(codeOf(sink)).toMatch(/:s\.1:p\.1:a\.0:k\.4:n\.n:x\.n$/);
  });

  it('a THROWING sink never changes the dial', async () => {
    const { h, sink } = observed(
      { worker: TARGETED_READY, listings: [notFound(), [agent('AJ_new', PER_MACHINE)]] },
      () => { throw new Error('sink broke'); },
    );
    const res = await run(h);
    expect(sink).toHaveBeenCalledTimes(1);
    expect(res.status).toBe('dialing');
    expect(h.originate).toHaveBeenCalledTimes(1);
  });

  it('a REJECTING (async) sink is swallowed, never an unhandled rejection', async () => {
    const unhandled = vi.fn();
    process.on('unhandledRejection', unhandled);
    try {
      const { h } = observed(
        { worker: TARGETED_READY, listings: [notFound(), [agent('AJ_new', PER_MACHINE)]] },
        () => Promise.reject(new Error('async sink broke')),
      );
      expect((await run(h)).status).toBe('dialing');
      await new Promise((r) => setTimeout(r, 0));
      expect(unhandled).not.toHaveBeenCalled();
    } finally {
      process.off('unhandledRejection', unhandled);
    }
  });

  it('the untargeted path never reports (no barrier ran)', async () => {
    const { h, sink } = observed({});
    expect((await run(h)).status).toBe('dialing');
    expect(sink).not.toHaveBeenCalled();
  });

  it('EVERY code survives the REAL logger unchanged, including the worst case', () => {
    const lines: string[] = [];
    const logger = createLogger('phone-runtime', { writer: (l) => lines.push(l) });
    const stages = ['j', 't', 'u', 'su', 'nd'] as const;
    const statuses = ['n', 'e', 'a', 'o', 's', 'm', 'y'] as const;
    const classes = [undefined, 'pd', 'ua', 'un', 'de', 'in', 'rl', 'na', 'ot'] as const;
    const codes: string[] = [];
    for (const stage of stages) {
      for (const n of statuses) {
        for (const cls of classes) {
          const obs = newAgentJoinObservation();
          obs.listingsOk = 1000; obs.listingsNotFound = 1000; obs.listingsFailed = 1000;
          obs.firstErrorClass = cls; obs.notFoundAfterOk = true;
          obs.snapshotAgents = 50; obs.maxParticipants = 50; obs.maxNewAgents = 50;
          for (const k of ['12', '13', '14', '15']) obs.kinds.add(k);
          obs.agentName = n; obs.otherName = n;
          codes.push(phoneAgentJoinObservationCode(stage, obs));
        }
      }
    }
    expect(Math.max(...codes.map((c) => c.length))).toBeLessThanOrEqual(64);
    for (const code of codes) {
      lines.length = 0;
      logger.info('unknown_event', {
        error_type: 'phone_agent_join_observed',
        error_category: code,
        duration_sec: 19.5,
        phase: MACHINE,
      });
      const parsed = JSON.parse(lines[0] ?? '{}') as Record<string, unknown>;
      expect(parsed.error_type).toBe('phone_agent_join_observed');
      expect(parsed.error_category).toBe(code);
      expect(parsed.duration_sec).toBe(19.5);
      expect(parsed.phase).toBe(MACHINE);
    }
  });

  it('classifies name attributes from the map without returning a value or key', () => {
    expect(classifyAgentNameAttr(undefined, PER_MACHINE, BASE)).toBe('e');
    expect(classifyAgentNameAttr({}, PER_MACHINE, BASE)).toBe('e');
    expect(classifyAgentNameAttr({ other: 'v' }, PER_MACHINE, BASE)).toBe('a');
    expect(classifyAgentNameAttr({ [PHONE_AGENT_NAME_ATTRIBUTE]: '' }, PER_MACHINE, BASE)).toBe('a');
    expect(classifyAgentNameAttr({ [PHONE_AGENT_NAME_ATTRIBUTE]: PER_MACHINE }, PER_MACHINE, BASE)).toBe('y');
    expect(classifyAgentNameAttr({ [PHONE_AGENT_NAME_ATTRIBUTE]: BASE }, PER_MACHINE, BASE)).toBe('s');
    expect(classifyAgentNameAttr({ [PHONE_AGENT_NAME_ATTRIBUTE]: `${BASE}-${OTHER_MACHINE}` }, PER_MACHINE, BASE)).toBe('m');
    expect(classifyAgentNameAttr({ [PHONE_AGENT_NAME_ATTRIBUTE]: 'x' }, PER_MACHINE, BASE)).toBe('o');
    expect(classifyAgentNameAttr({ [PHONE_AGENT_NAME_ATTRIBUTE]: `${BASE}-x` }, PER_MACHINE, '')).toBe('o');
  });

  it('classifies listing errors from code or status only', () => {
    expect(classifyListingError(Object.assign(new Error('x'), { code: 'DEADLINE_EXCEEDED' }))).toBe('de');
    expect(classifyListingError(Object.assign(new Error('x'), { statusCode: 429 }))).toBe('rl');
    expect(classifyListingError(Object.assign(new Error('x'), { status: 403 }))).toBe('pd');
    expect(classifyListingError(Object.assign(new Error('x'), { status: 504 }))).toBe('de');
    expect(classifyListingError('nope')).toBe('ot');
    expect(classifyListingError(null)).toBe('ot');
  });
});
