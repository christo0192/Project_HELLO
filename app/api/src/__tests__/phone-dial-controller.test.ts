/**
 * P5 — `dialPhoneAttempt`, and the one sentence the whole controller exists to
 * make true:
 *
 *   NOTHING REACHES A CARRIER UNTIL EVERY GATE HAS PASSED.
 *
 * Every refusal below therefore asserts TWO independent witnesses:
 *
 *   * `providerContacted === false` — the flag the caller reads; and
 *   * the SIP fake was never called — the thing that actually happened.
 *
 * Both, deliberately. An assertion that only read the flag keeps passing when
 * the flag is computed rather than observed; an assertion that only watched the
 * spy keeps passing when the flag starts lying to the caller deciding whether a
 * refusal is chargeable. Either one can rot on its own; together they cannot.
 *
 * The lease block is the centre of this file. `waitUntilAnswered` makes the
 * originate BLOCK for up to `originateTimeoutSeconds`, and an originate that
 * outlives its lease races `reclaim_phone_attempt_leases` — two calls on one
 * fleet slot, with the reclaimer having already rewound the engagement, and no
 * second observer (P3's sweep leaves HELD leases alone). So the lease must be
 * PROVEN to outlive the worst case, and "we asked for enough" is tested apart
 * from "we have enough".
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';

// `provisionPhoneRoom` calls `requireLiveKitConfigured` directly — it is not an
// injectable seam — so the ONLY way to exercise the `not_configured` branch is
// to mock that one import. Nothing else in the module graph is replaced, and no
// phone env var is touched anywhere in this file.
const livekit = vi.hoisted(() => ({ configured: true }));
vi.mock('../lib/room-provisioning.js', () => ({
  requireLiveKitConfigured: (): void => {
    if (!livekit.configured) throw new Error('LIVEKIT_URL ... must be set');
  },
}));

import {
  LEASE_MARGIN_SECONDS,
  dialPhoneAttempt,
  type PhoneDialDeps,
} from '../integrations/livekit-phone-dial/dial.js';
import { loadPhoneDialConfig } from '../integrations/livekit-phone-dial/config.js';
import { wrapDialableNumber } from '../integrations/livekit-phone-dial/dialable-number.js';
import {
  createSyntheticSipClient,
  phoneParticipantIdentity,
  type PhoneSipClient,
} from '../integrations/livekit-phone-dial/sip.js';
import type {
  PhoneRoomServiceClientLike,
} from '../integrations/livekit-phone-dial/phone-room.js';
import { loadPhoneScreeningConfig } from '../lib/phone-screening/config.js';
import type { ConsentReader, ConsentRecordSnapshot } from '../lib/phone-screening/consent.js';
import type {
  AdmitPhoneAttemptResult,
  HeartbeatPhoneAttemptResult,
  PhoneStores,
} from '../lib/phone-screening/ports.js';

const ENGAGEMENT = '11111111-2222-4333-8444-555555555555';
const CANDIDATE = '22222222-2222-4222-8222-222222222222';
const SESSION = '33333333-3333-4333-8333-333333333333';
const ATTEMPT = 'aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee';
const EPOCH = 7;
const LEASE_OWNER = 'dialer-a';

/** 15:00 IST — inside the restored 09:00–21:00 window. */
const NOW = new Date('2026-09-07T09:30:00.000Z');
/** 01:30 IST — outside the restored window. */
const NIGHT = new Date('2026-09-07T20:00:00.000Z');

const NUMBER = wrapDialableNumber('+919876543210');
const DIGEST = NUMBER.digest;
const OTHER_DIGEST = 'f'.repeat(64);

const ALL_SIX = ['ai_interview', 'recording', 'purpose', 'data_processing', 'retention', 'rights'];
const GRANTED: ConsentRecordSnapshot = { status: 'granted', consents: ALL_SIX, expiresAt: null };

const DIAL_CONFIG = loadPhoneDialConfig({
  PHONE_SIP_TRUNK_ID: 'trunk-main',
  PHONE_AGENT_NAME: 'phone-worker',
} as NodeJS.ProcessEnv);

const NO_TRUNK_CONFIG = loadPhoneDialConfig({
  PHONE_AGENT_NAME: 'phone-worker',
} as NodeJS.ProcessEnv);

/**
 * The worst-case originate plus the margin — the number the lease must cover.
 * Derived from the two exported constants rather than written out, so a change
 * to either moves the test with the code instead of silently past it.
 */
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

/** An ISO instant `seconds` after `NOW`. */
function after(seconds: number): string {
  return new Date(NOW.getTime() + seconds * 1000).toISOString();
}

function admitOk(over: Partial<AdmitPhoneAttemptResult> = {}): AdmitPhoneAttemptResult {
  return {
    status: 'ok',
    attemptId: ATTEMPT,
    epoch: EPOCH,
    leaseToken: 'lease-token-1',
    // Comfortably long by default, so tests that are not about the lease do
    // not accidentally depend on the heartbeat.
    leaseExpiresAt: after(REQUIRED + 60),
    ...over,
  };
}

/** A shared call-order log, so ORDER is asserted rather than assumed. */
let order: string[];

beforeEach(() => {
  order = [];
  livekit.configured = true;
});

interface Harness {
  deps: PhoneDialDeps;
  admit: ReturnType<typeof vi.fn>;
  heartbeat: ReturnType<typeof vi.fn>;
  originate: ReturnType<typeof vi.fn>;
  createRoom: ReturnType<typeof vi.fn>;
  updateRoomMetadata: ReturnType<typeof vi.fn>;
  dispatch: ReturnType<typeof vi.fn>;
  ensureReadyWorker: ReturnType<typeof vi.fn>;
  releaseWorker: ReturnType<typeof vi.fn>;
}

function harness(opts: {
  config?: ReturnType<typeof screeningConfig>;
  dialConfig?: typeof DIAL_CONFIG;
  admit?: AdmitPhoneAttemptResult;
  heartbeat?: HeartbeatPhoneAttemptResult;
  consent?: ConsentRecordSnapshot | null | Error;
  roomFails?: boolean;
  sip?: PhoneSipClient;
  originate?: () => Promise<never> | Promise<unknown>;
  /**
   * When set, the worker orchestration gate is injected. `undefined` (default)
   * leaves it OUT of deps ⇒ the dial path is byte-identical to today. A string
   * is the ready machine id; the other statuses defer.
   */
  worker?:
    | { status: 'ready'; machineId: string }
    | { status: 'no_capacity' }
    | { status: 'timeout' }
    | { status: 'error'; code: string }
    | { status: 'disabled' };
} = {}): Harness {
  const admit = vi.fn(async () => {
    order.push('admit');
    return (opts.admit ?? admitOk()) as never;
  });
  const heartbeat = vi.fn(async () => {
    order.push('heartbeat');
    return (opts.heartbeat ?? { status: 'ok', leaseExpiresAt: after(REQUIRED + 5) }) as never;
  });

  const unreachable = async (): Promise<never> => {
    // The controller must not reach for a capability it does not need; a
    // silently no-op fake would hide it if it did.
    throw new Error('phone_store_method_not_expected');
  };
  const stores = {
    admitAttempt: admit,
    heartbeatAttempt: heartbeat,
    // The dial controller uses the TOKEN-fenced door (it holds the token it
    // was just handed). The epoch-fenced one is the worker's, and reaching for
    // it from here would be a bug, so it throws.
    heartbeatAttemptByEpoch: unreachable,
    sweepDayRolled: unreachable,
    sweepStrandedSessions: unreachable,
    claimSweep: unreachable,
    reclaimAttemptLeases: unreachable,
    applyEvent: unreachable,
    scheduleAppointment: unreachable,
    cancelAppointment: unreachable,
    expireAppointments: unreachable,
    setHalt: unreachable,
    clearHalt: unreachable,
    backlog: unreachable,
    attachAttemptRecording: unreachable,
    finalizeAttemptRecording: unreachable,
    listEngagementRecordings: unreachable,
    clearAttemptRecordings: unreachable,
  } as unknown as PhoneStores;

  const consentReader: ConsentReader = {
    async latestConsentRecord() {
      if (opts.consent instanceof Error) throw opts.consent;
      return opts.consent === undefined ? GRANTED : opts.consent;
    },
    async activeConsentTemplate() {
      return { requiredConsents: ALL_SIX };
    },
  };

  const createRoom = vi.fn(async () => {
    order.push('room');
    if (opts.roomFails) throw new Error('provider said no');
    return undefined;
  });
  const updateRoomMetadata = vi.fn(async () => {
    if (opts.roomFails) throw new Error('provider said no again');
    return undefined;
  });
  const dispatch = vi.fn(async () => undefined);

  const originate = vi.fn(async () => {
    order.push('originate');
    if (opts.originate) return (await opts.originate()) as never;
    return {
      participantIdentity: phoneParticipantIdentity(ATTEMPT),
      sipCallId: 'SC_provider_1',
      synthetic: false,
    } as never;
  });

  const sip: PhoneSipClient = opts.sip ?? { mode: 'live', createSipParticipant: originate };

  const ensureReadyWorker = vi.fn(async () => {
    order.push('ensureReadyWorker');
    return (opts.worker ?? { status: 'ready', machineId: 'm-1' }) as never;
  });
  const releaseWorker = vi.fn(async () => {
    order.push('releaseWorker');
    return undefined;
  });

  const deps: PhoneDialDeps = {
    config: opts.config ?? screeningConfig(),
    dialConfig: opts.dialConfig ?? DIAL_CONFIG,
    stores,
    admission: { consentReader },
    sip,
    room: {
      rooms: { createRoom, updateRoomMetadata } as unknown as PhoneRoomServiceClientLike,
      dispatch: { createDispatch: dispatch },
    },
    leaseOwner: LEASE_OWNER,
    // The gate is injected ONLY when a `worker` outcome is requested. Absent by
    // default ⇒ the byte-identical path.
    ...(opts.worker === undefined
      ? {}
      : {
          workerGate: {
            app: 'project-hello-phone-voice',
            ensureReadyWorker,
            releaseWorker,
          },
        }),
  };

  return {
    deps, admit, heartbeat, originate, createRoom, updateRoomMetadata, dispatch,
    ensureReadyWorker, releaseWorker,
  };
}

function run(h: Harness, now: Date = NOW) {
  return dialPhoneAttempt(
    {
      engagementId: ENGAGEMENT,
      candidateId: CANDIDATE,
      sessionId: SESSION,
      kind: 'initial',
      number: NUMBER,
      now,
    },
    h.deps,
  );
}

/**
 * The two witnesses, always asserted together. `providerContacted` is the flag
 * a caller reads; the spy is what actually happened. Either can rot alone.
 */
function expectNoNetwork(res: { providerContacted: boolean }, h: Harness): void {
  expect(res.providerContacted).toBe(false);
  expect(h.originate).not.toHaveBeenCalled();
}

// ═══════════════════════════════════════════════════════════════════════
// GATE 1 — the two flags, and the trunk.
// ═══════════════════════════════════════════════════════════════════════

describe('P5 dial — the runtime flags refuse before anything else happens', () => {
  const off: { label: string; env: Record<string, string> }[] = [
    { label: 'the master switch is off', env: { PHONE_SCREENING_ENABLED: 'false' } },
    { label: 'the runtime switch is off', env: { PHONE_RUNTIME_ENABLED: 'false' } },
    { label: 'both switches are off', env: { PHONE_SCREENING_ENABLED: 'false', PHONE_RUNTIME_ENABLED: 'false' } },
  ];

  for (const c of off) {
    it(`refuses with runtime_disabled when ${c.label}`, async () => {
      const h = harness({ config: screeningConfig(c.env) });
      const res = await run(h);

      expect(res.status).toBe('refused');
      expect(res.refusal).toBe('runtime_disabled');
      expectNoNetwork(res, h);
      // Not even admission is asked: a disabled deployment claims no slot.
      expect(h.admit).not.toHaveBeenCalled();
      expect(order).toEqual([]);
    });
  }

  it('refuses with transport_not_configured when no trunk is set, however armed the flags are', async () => {
    // Arming the dialer and configuring a trunk are TWO decisions and neither
    // implies the other. This case is what proves the second gate is not
    // folded into the first.
    const h = harness({ dialConfig: NO_TRUNK_CONFIG });
    const res = await run(h);

    expect(res.status).toBe('refused');
    expect(res.refusal).toBe('transport_not_configured');
    expectNoNetwork(res, h);
    expect(h.admit).not.toHaveBeenCalled();
  });
});

// ═══════════════════════════════════════════════════════════════════════
// GATE 2 — admission. Deferrals carry a code; refusals carry the DB status.
// ═══════════════════════════════════════════════════════════════════════

describe('P5 dial — a deferral is a wait, and it carries the deferral code', () => {
  it('defers with dial_mode_off when the dial mode is off', async () => {
    const h = harness({ config: screeningConfig({ PHONE_DIAL_MODE: 'off' }) });
    const res = await run(h);

    expect(res.status).toBe('refused');
    expect(res.refusal).toBe('admission_deferred');
    expect(res.detail).toBe('dial_mode_off');
    expectNoNetwork(res, h);
    // A pre-claim deferral writes NOTHING: no attempt row, no budget move.
    expect(h.admit).not.toHaveBeenCalled();
  });

  it('defers with dial_not_allowlisted when live mode meets an unlisted digest', async () => {
    const h = harness({ config: screeningConfig({ PHONE_DIAL_ALLOWLIST: OTHER_DIGEST }) });
    const res = await run(h);

    expect(res.refusal).toBe('admission_deferred');
    expect(res.detail).toBe('dial_not_allowlisted');
    expectNoNetwork(res, h);
    expect(h.admit).not.toHaveBeenCalled();
  });

  it('defers with window_closed_defer at 01:30 IST — and never with the outcome_class name', async () => {
    const h = harness();
    const res = await run(h, NIGHT);

    expect(res.refusal).toBe('admission_deferred');
    expect(res.detail).toBe('window_closed_defer');
    // `window_closed` is one of the eleven closed outcome classes and a
    // deferral is not a call; the two vocabularies stay disjoint.
    expect(res.detail).not.toBe('window_closed');
    expectNoNetwork(res, h);
    expect(h.admit).not.toHaveBeenCalled();
  });

  const consentCases: { label: string; consent: ConsentRecordSnapshot | null | Error }[] = [
    { label: 'there is no consent record at all', consent: null },
    { label: 'the latest record is withdrawn', consent: { status: 'withdrawn', consents: ALL_SIX, expiresAt: null } },
    { label: 'the record has expired', consent: { status: 'granted', consents: ALL_SIX, expiresAt: new Date(NOW.getTime() - 1000) } },
    { label: 'the consent read itself throws', consent: new Error('db down') },
  ];

  for (const c of consentCases) {
    it(`defers with consent_preflight_refused when ${c.label}`, async () => {
      const h = harness({ consent: c.consent });
      const res = await run(h);

      expect(res.refusal).toBe('admission_deferred');
      expect(res.detail).toBe('consent_preflight_refused');
      expectNoNetwork(res, h);
      expect(h.admit).not.toHaveBeenCalled();
    });
  }
});

describe('P5 dial — a database refusal is surfaced verbatim', () => {
  const refusals = [
    'at_capacity',
    'suppressed',
    'daily_attempt_exists',
    'halted',
    'phone_invalid',
    'engagement_terminal',
    'no_answer_budget_exhausted',
    'window_closed',
    'unknown_status',
  ] as const;

  for (const status of refusals) {
    it(`refuses with admission_refused carrying ${status}, untranslated`, async () => {
      const h = harness({ admit: { status } as AdmitPhoneAttemptResult });
      const res = await run(h);

      expect(res.status).toBe('refused');
      expect(res.refusal).toBe('admission_refused');
      // VERBATIM. A locally substituted code would tell an operator the wrong
      // thing about which layer said no.
      expect(res.detail).toBe(status);
      expectNoNetwork(res, h);
      // Admission WAS asked — this refusal came from the lock, not from here.
      expect(h.admit).toHaveBeenCalledTimes(1);
      expect(h.createRoom).not.toHaveBeenCalled();
      expect(h.heartbeat).not.toHaveBeenCalled();
    });
  }

  it('prefers the refusal constraint over a wrapper status that masks it', async () => {
    // The 0063 test-gate wrapper answers `halted` for EVERY refusal it
    // carries, with the real answer in `constraint`. Counting the wrapper
    // status made the health surface report the kill switch while the live
    // refusal (2026-08-28) was `daily_attempt_exists`.
    const h = harness({
      admit: {
        status: 'halted',
        detail: { constraint: 'daily_attempt_exists' },
      } as AdmitPhoneAttemptResult,
    });
    const res = await run(h);
    expect(res.status).toBe('refused');
    expect(res.refusal).toBe('admission_refused');
    expect(res.detail).toBe('daily_attempt_exists');
    expectNoNetwork(res, h);
  });

  it('refuses an `ok` that carries no addressable attempt', async () => {
    // Nothing downstream could fence, heartbeat or reconcile such a dial, so
    // it is refused BEFORE the SDK rather than placed blind.
    for (const partial of [
      { status: 'ok', epoch: EPOCH, leaseToken: 't', leaseExpiresAt: after(600) },
      { status: 'ok', attemptId: ATTEMPT, leaseToken: 't', leaseExpiresAt: after(600) },
    ] as AdmitPhoneAttemptResult[]) {
      const h = harness({ admit: partial });
      const res = await run(h);
      expect(res.refusal).toBe('admission_refused');
      expect(res.detail).toBe('ok_without_attempt');
      expectNoNetwork(res, h);
      expect(h.createRoom).not.toHaveBeenCalled();
    }
  });

  it('passes the lease owner and the injected instant straight through to the RPC', async () => {
    const h = harness();
    await run(h);
    expect(h.admit.mock.calls[0][0]).toEqual({
      engagementId: ENGAGEMENT,
      kind: 'initial',
      leaseOwner: LEASE_OWNER,
      leaseSeconds: h.deps.config.leaseSeconds,
      now: NOW,
    });
  });
});

// ═══════════════════════════════════════════════════════════════════════
// The allowlist — owned by admission, deliberately not duplicated here.
// ═══════════════════════════════════════════════════════════════════════

describe('the allowlist is ADMISSION\'s gate, and is not repeated here', () => {
  it('LIVE mode with a non-matching digest is refused by ADMISSION, before any dial', async () => {
    // The protection is unchanged; only its OWNER is. `admitPhoneEngagement`
    // defers with `dial_not_allowlisted`, so the refusal happens before an
    // attempt is even admitted — earlier and stronger than a second copy in
    // this file could manage.
    const h = harness({
      config: screeningConfig({
        PHONE_DIAL_MODE: 'live',
        PHONE_DIAL_ALLOWLIST: 'f'.repeat(64),
      }),
    });
    const res = await run(h);

    expect(res.status).toBe('refused');
    expect(res.refusal).toBe('admission_deferred');
    expect(res.detail).toBe('dial_not_allowlisted');
    expectNoNetwork(res, h);
    expect(h.createRoom).not.toHaveBeenCalled();
    expect(h.heartbeat).not.toHaveBeenCalled();
  });

  it('SYNTHETIC mode reaches the fake seam, because a fake calls nobody', async () => {
    // The regression this pins. An earlier draft of `dial.ts` tested
    // `isDialAllowedForDigest` unconditionally — and that helper is false for
    // EVERY non-live mode by construction, so it refused every synthetic dial
    // before it could reach the fake seam. That made a synthetic rehearsal
    // exercise nothing, and made "synthetic cannot reach the SDK" vacuously
    // true because synthetic could not reach ANYTHING.
    const h = harness({
      config: screeningConfig({ PHONE_DIAL_MODE: 'synthetic' }),
      // The REAL synthetic client, so this proves the controller reaches the
      // seam the resolver would hand it — not a live-shaped double.
      sip: createSyntheticSipClient(),
    });
    const res = await run(h);

    expect(res.status).toBe('dialing');
    expect(res.refusal).toBeUndefined();
    // Both halves asserted: "reached nothing" would satisfy the second alone.
    expect(res.participantIdentity).toBe(`phone-${ATTEMPT}`);
    expect(res.providerContacted).toBe(false);
    expect(res.synthetic).toBe(true);
  });
});

// ═══════════════════════════════════════════════════════════════════════
// GATE 4 — a room to originate into.
// ═══════════════════════════════════════════════════════════════════════

describe('P5 dial — no room, no dial', () => {
  it('refuses with room_unavailable when LiveKit is not configured', async () => {
    livekit.configured = false;
    const h = harness();
    const res = await run(h);

    expect(res.refusal).toBe('room_unavailable');
    expect(res.detail).toBe('livekit_not_configured');
    expect(res.attemptId).toBe(ATTEMPT);
    expectNoNetwork(res, h);
    expect(h.heartbeat).not.toHaveBeenCalled();
  });

  it('refuses with room_unavailable when the provider fails to create OR adopt the room', async () => {
    const h = harness({ roomFails: true });
    const res = await run(h);

    expect(res.refusal).toBe('room_unavailable');
    expect(res.detail).toBe('room_create_error');
    expectNoNetwork(res, h);
    // Both paths were tried — create, then the reconnect's metadata converge.
    expect(h.createRoom).toHaveBeenCalledTimes(1);
    expect(h.updateRoomMetadata).toHaveBeenCalledTimes(1);
    expect(h.heartbeat).not.toHaveBeenCalled();
  });
});

// ═══════════════════════════════════════════════════════════════════════
// GATE 5 — THE LEASE. The gate that is easiest to leave out and worst to lose.
// ═══════════════════════════════════════════════════════════════════════

describe('P5 dial — the lease must be PROVEN to outlive the originate', () => {
  it('does not heartbeat at all when the admitted lease already covers the worst case', async () => {
    // Exactly `required` — the boundary, asserted so a `>` that should be `>=`
    // is caught rather than absorbed by a comfortable margin.
    const h = harness({ admit: admitOk({ leaseExpiresAt: after(REQUIRED) }) });
    const res = await run(h);

    expect(res.status).toBe('dialing');
    expect(h.heartbeat).not.toHaveBeenCalled();
    expect(h.originate).toHaveBeenCalledTimes(1);
  });

  it('extends a short lease, asking for at least the worst case, and then dials', async () => {
    const h = harness({
      admit: admitOk({ leaseExpiresAt: after(REQUIRED - 1) }),
      heartbeat: { status: 'ok', leaseExpiresAt: after(REQUIRED + 30) },
    });
    const res = await run(h);

    expect(h.heartbeat).toHaveBeenCalledTimes(1);
    const asked = h.heartbeat.mock.calls[0][0] as { leaseSeconds: number; attemptId: string; leaseToken: string; now: Date };
    expect(asked.leaseSeconds).toBeGreaterThanOrEqual(REQUIRED);
    expect(asked.attemptId).toBe(ATTEMPT);
    expect(asked.leaseToken).toBe('lease-token-1');
    expect(asked.now).toBe(NOW);
    // The lease is sized to the WORK, not to the configured default.
    expect(asked.leaseSeconds).toBeGreaterThanOrEqual(h.deps.config.leaseSeconds);

    expect(res.status).toBe('dialing');
    expect(res.providerContacted).toBe(true);
    expect(order).toEqual(['admit', 'room', 'heartbeat', 'originate']);
  });

  it('refuses with lease_too_short and NEVER calls the SDK when the heartbeat reports lease_lost', async () => {
    const h = harness({
      admit: admitOk({ leaseExpiresAt: after(5) }),
      heartbeat: { status: 'lease_lost' },
    });
    const res = await run(h);

    expect(res.status).toBe('refused');
    expect(res.refusal).toBe('lease_too_short');
    expect(res.attemptId).toBe(ATTEMPT);
    expectNoNetwork(res, h);
    // A dial we cannot account for is worse than a dial we did not place.
    expect(h.heartbeat).toHaveBeenCalledTimes(1);
  });

  it('refuses when the heartbeat says ok but the lease it GRANTED is still too short', async () => {
    // "We asked for enough" is not the same claim as "we have enough". 0042
    // clamps a lease request at 900 s, so a long-enough ASK can come back
    // short — and the only honest check is against what the DATABASE returned.
    const h = harness({
      admit: admitOk({ leaseExpiresAt: after(1) }),
      heartbeat: { status: 'ok', leaseExpiresAt: after(REQUIRED - 1) },
    });
    const res = await run(h);

    expect(res.refusal).toBe('lease_too_short');
    expectNoNetwork(res, h);
    expect(h.heartbeat).toHaveBeenCalledTimes(1);
  });

  it('refuses when there is no lease token to heartbeat with, without even trying', async () => {
    // An unprovable lease is treated exactly like a lost one.
    const h = harness({ admit: admitOk({ leaseToken: undefined, leaseExpiresAt: after(1) }) });
    const res = await run(h);

    expect(res.refusal).toBe('lease_too_short');
    expectNoNetwork(res, h);
    expect(h.heartbeat).not.toHaveBeenCalled();
  });

  const unprovable: { label: string; heartbeat: HeartbeatPhoneAttemptResult }[] = [
    { label: 'absent', heartbeat: { status: 'ok' } },
    { label: 'unparseable', heartbeat: { status: 'ok', leaseExpiresAt: 'whenever' } },
    { label: 'empty', heartbeat: { status: 'ok', leaseExpiresAt: '' } },
  ];

  for (const c of unprovable) {
    it(`refuses when the renewed expiry is ${c.label} — unprovable is not proven`, async () => {
      const h = harness({
        admit: admitOk({ leaseExpiresAt: undefined }),
        heartbeat: c.heartbeat,
      });
      const res = await run(h);

      expect(res.refusal).toBe('lease_too_short');
      expectNoNetwork(res, h);
    });
  }

  it('treats an unparseable ADMITTED expiry as unprovable and goes to the heartbeat', async () => {
    // The admitted value cannot be read, so nothing about the slot is known;
    // the controller must extend rather than assume, and it must still refuse
    // if the extension does not answer with something readable.
    const short = harness({
      admit: admitOk({ leaseExpiresAt: 'not-a-date' }),
      heartbeat: { status: 'ok' },
    });
    const refused = await run(short);
    expect(refused.refusal).toBe('lease_too_short');
    expect(short.heartbeat).toHaveBeenCalledTimes(1);
    expectNoNetwork(refused, short);

    const good = harness({
      admit: admitOk({ leaseExpiresAt: 'not-a-date' }),
      heartbeat: { status: 'ok', leaseExpiresAt: after(REQUIRED + 10) },
    });
    const dialing = await run(good);
    expect(dialing.status).toBe('dialing');
    expect(good.heartbeat).toHaveBeenCalledTimes(1);
  });

  it('refuses when the heartbeat answers unknown_status', async () => {
    const h = harness({
      admit: admitOk({ leaseExpiresAt: after(1) }),
      heartbeat: { status: 'unknown_status' } as HeartbeatPhoneAttemptResult,
    });
    const res = await run(h);
    expect(res.refusal).toBe('lease_too_short');
    expectNoNetwork(res, h);
  });
});

// ═══════════════════════════════════════════════════════════════════════
// THE DIAL ITSELF.
// ═══════════════════════════════════════════════════════════════════════

describe('P5 dial — the happy path, and what it propagates', () => {
  it('reports dialing and carries the identity, epoch, room and call id outward', async () => {
    const h = harness();
    const res = await run(h);

    expect(res.status).toBe('dialing');
    expect(res.refusal).toBeUndefined();
    expect(res.attemptId).toBe(ATTEMPT);
    expect(res.epoch).toBe(EPOCH);
    expect(res.roomName).toBe(`phone-${SESSION}`);
    expect(res.participantIdentity).toBe(`phone-${ATTEMPT}`);
    expect(res.sipCallId).toBe('SC_provider_1');
    // The LIVE client is the provider, and the flag says so.
    expect(res.providerContacted).toBe(true);
    expect(res.synthetic).toBe(false);
    expect(order).toEqual(['admit', 'room', 'originate']);
  });

  it('hands the originate the trunk, the room, the fencing epoch and all three bounds', async () => {
    const h = harness();
    await run(h);

    expect(h.originate).toHaveBeenCalledTimes(1);
    const req = h.originate.mock.calls[0][0] as Record<string, unknown>;
    expect(req.trunkId).toBe('trunk-main');
    expect(req.roomName).toBe(`phone-${SESSION}`);
    expect(req.attemptId).toBe(ATTEMPT);
    expect(req.epoch).toBe(EPOCH);
    // The RING bound is a DOMAIN value; the other two are transport.
    expect(req.ringTimeoutSeconds).toBe(h.deps.config.ringTimeoutSeconds);
    expect(req.originateTimeoutSeconds).toBe(DIAL_CONFIG.originateTimeoutSeconds);
    expect(req.maxCallSeconds).toBe(DIAL_CONFIG.maxCallSeconds);
    // Bounce OFF (the default): the target is the candidate number, and it
    // crosses as the self-redacting wrapper, never as digits.
    const target = req.target as { kind: string; number?: unknown };
    expect(target.kind).toBe('number');
    expect(target.number).toBe(NUMBER);
    expect(String(target.number)).toBe('[redacted]');
  });

  it('BOUNCE MODE — targets the bounce trunk and endpoint user, not the candidate number', async () => {
    // Admission still reads the candidate number's digest (proven by the admit
    // assertions elsewhere); bounce changes ONLY what the SDK dials.
    const bounceConfig = loadPhoneDialConfig({
      PHONE_BOUNCE_MODE: 'true',
      PHONE_BOUNCE_TRUNK_ID: 'bounce-trunk',
      PHONE_BOUNCE_SIP_USER: 'hello_bounce',
      PHONE_AGENT_NAME: 'phone-worker',
    } as NodeJS.ProcessEnv);
    const h = harness({ dialConfig: bounceConfig });
    await run(h);

    expect(h.originate).toHaveBeenCalledTimes(1);
    const req = h.originate.mock.calls[0][0] as Record<string, unknown>;
    // The bounce trunk, not the direct one.
    expect(req.trunkId).toBe('bounce-trunk');
    const target = req.target as { kind: string; bounceUser?: string };
    expect(target.kind).toBe('bounce');
    expect(target.bounceUser).toBe('hello_bounce');
    // No candidate number crosses on the bounce path.
    expect(JSON.stringify(target)).not.toContain('number');
  });

  it('reports providerContacted FALSE for the synthetic client, which is not the provider', async () => {
    // A synthetic rehearsal that claimed `providerContacted: true` would make
    // "synthetic places no call" unfalsifiable everywhere else in the suite.
    const h = harness({ sip: createSyntheticSipClient() });
    const res = await run(h);

    expect(res.status).toBe('dialing');
    expect(res.synthetic).toBe(true);
    expect(res.providerContacted).toBe(false);
    expect(res.participantIdentity).toBe(`phone-${ATTEMPT}`);
    // The synthetic client simulates no provider, so there is no call id.
    expect(res.sipCallId).toBeUndefined();
  });

  it('reports originate_failed with providerContacted TRUE, and leaks no provider text', async () => {
    const secret = 'carrier rejected +919876543210 on trunk-main';
    const h = harness({
      originate: async () => {
        throw new Error(secret);
      },
    });
    const res = await run(h);

    expect(res.status).toBe('refused');
    expect(res.refusal).toBe('originate_failed');
    // We TRIED. A caller deciding whether this is chargeable needs the
    // difference between "we refused" and "we tried and it failed".
    expect(res.providerContacted).toBe(true);
    expect(res.attemptId).toBe(ATTEMPT);
    expect(res.roomName).toBe(`phone-${SESSION}`);
    // The provider's message is discarded whole — it may quote the number.
    const rendered = JSON.stringify(res);
    expect(rendered).not.toContain(secret);
    expect(rendered).not.toContain('carrier rejected');
    expect(rendered).not.toContain('9876543210');
  });
});


// ═══════════════════════════════════════════════════════════════════════
// H-2 — the originate must outlast the ring.
//
// If the SDK call gives up while the carrier is still ringing, the controller
// reports `originate_failed`, the lease (sized off the ORIGINATE bound) lapses,
// and the reclaimer restores the engagement — while the leg can STILL be
// answered, landing a real person in a room whose dial we wrote off. That is
// the failure the lease gate exists to prevent, reintroduced through the other
// knob, so the two bounds are related in code rather than left to two
// independent defaults staying ordered forever.
// ═══════════════════════════════════════════════════════════════════════

describe('the ring bound must fit INSIDE the originate bound', () => {
  it('the shipped DEFAULTS are correctly ordered', () => {
    const screening = screeningConfig({});
    const dial = loadPhoneDialConfig({});
    expect(screening.ringTimeoutSeconds).toBeLessThan(dial.originateTimeoutSeconds);
  });

  for (const [ring, originate, label] of [
    ['90', '60', 'ring longer than originate'],
    ['60', '60', 'ring EQUAL to originate'],
  ] as const) {
    it(`refuses before the SDK when ${label}`, async () => {
      const h = harness({
        config: screeningConfig({ PHONE_RING_TIMEOUT_SECONDS: ring }),
        dialConfig: loadPhoneDialConfig({
          PHONE_SIP_TRUNK_ID: 'trunk-1',
          PHONE_ORIGINATE_TIMEOUT_SECONDS: originate,
        }),
      });
      const res = await run(h);

      expect(res.status).toBe('refused');
      expect(res.refusal).toBe('timeouts_misordered');
      expectNoNetwork(res, h);
      // Refused BEFORE admission, so no attempt is burned on a misconfiguration.
      expect(h.admit).not.toHaveBeenCalled();
    });
  }

  it('CONTROL — a correctly ordered pair reaches the seam', async () => {
    const h = harness({
      config: screeningConfig({ PHONE_RING_TIMEOUT_SECONDS: '20' }),
      dialConfig: loadPhoneDialConfig({
        PHONE_SIP_TRUNK_ID: 'trunk-1',
        PHONE_ORIGINATE_TIMEOUT_SECONDS: '60',
      }),
    });
    const res = await run(h);
    expect(res.status).toBe('dialing');
  });
});

// ═══════════════════════════════════════════════════════════════════════
//  R-1 — the lease must cover the stretch nobody heartbeats
// ═══════════════════════════════════════════════════════════════════════

describe('a lease that cannot span ring + opening gate is REFUSED, not stretched', () => {
  // The lease is extended once, pre-originate, and then nobody beats until
  // the agent's first heartbeat — which happens only after the line has rung,
  // somebody has answered, the disclosure has been delivered AND answered,
  // and an awaited LiveKit egress call has returned. A lease that does not
  // span all of that lapses under a live conversation: the first beat says
  // `lease_lost` and the agent hangs up on a candidate who has just
  // consented. Because the engagement is `in_call` by then, the room close
  // charges a reconnect and the next leg carries the same risk.

  for (const [lease, ring, label] of [
    ['60', '45', 'the OLD shipped default — 60 against a 45s ring'],
    ['104', '45', 'one second under the relation'],
    ['5', '5', 'both at their floor'],
  ] as const) {
    it(`refuses before the SDK: ${label}`, async () => {
      const h = harness({
        config: screeningConfig({
          PHONE_LEASE_SECONDS: lease,
          PHONE_RING_TIMEOUT_SECONDS: ring,
        }),
        dialConfig: loadPhoneDialConfig({
          PHONE_SIP_TRUNK_ID: 'trunk-1',
          PHONE_ORIGINATE_TIMEOUT_SECONDS: '60',
        }),
      });
      const res = await run(h);

      expect(res.status).toBe('refused');
      expect(res.refusal).toBe('lease_too_short_for_gate');
      expectNoNetwork(res, h);
      // Refused BEFORE admission: a misconfiguration must not burn an
      // attempt, a fleet slot or a day of the candidate's budget.
      expect(h.admit).not.toHaveBeenCalled();
    });
  }

  it('exactly AT the relation is admitted — the bound is >=, not >', async () => {
    const h = harness({
      config: screeningConfig({
        PHONE_LEASE_SECONDS: '105',
        PHONE_RING_TIMEOUT_SECONDS: '45',
      }),
      dialConfig: loadPhoneDialConfig({
        PHONE_SIP_TRUNK_ID: 'trunk-1',
        PHONE_ORIGINATE_TIMEOUT_SECONDS: '60',
      }),
    });
    const res = await run(h);
    expect(res.refusal).not.toBe('lease_too_short_for_gate');
  });

  it('CONTROL — the SHIPPED defaults satisfy the relation and reach the seam', async () => {
    // This is the assertion that makes the three refusals above mean
    // something: without it they are satisfied by a gate that refuses every
    // configuration, which would take the whole lane down rather than
    // protecting anybody.
    const h = harness({
      config: screeningConfig({}),
      dialConfig: loadPhoneDialConfig({
        PHONE_SIP_TRUNK_ID: 'trunk-1',
        PHONE_ORIGINATE_TIMEOUT_SECONDS: '60',
      }),
    });
    const res = await run(h);
    expect(res.refusal).not.toBe('lease_too_short_for_gate');
    expect(h.admit).toHaveBeenCalled();
  });
});

// ═══════════════════════════════════════════════════════════════════════
// GATE 4-bis — the on-demand worker gate (phone-cost-and-scale-plan §2.3).
//
// Three properties, each a mandated invariant:
//   * BYTE-IDENTICAL when no gate is injected — the default path.
//   * PROCEEDS on `ready` (and on the service's own `disabled`), BEFORE
//     the room/dispatch and before the originate; carries the machine id.
//   * DEFERS (worker_not_ready, NO carrier, NO room/dispatch) on
//     no_capacity / timeout / error, and releases nothing (the service
//     cleaned up its own claim).
//   * a claim made then declined AFTER the gate (lease too short / originate
//     failed) is RELEASED, best-effort.
// ═══════════════════════════════════════════════════════════════════════

describe('P5 dial — the on-demand worker gate', () => {
  it('is INERT when no gate is injected: no ensure/release, dial proceeds as today', async () => {
    const h = harness({}); // opts.worker undefined ⇒ no workerGate dep at all
    const res = await run(h);

    expect(res.status).toBe('dialing');
    expect(res.providerContacted).toBe(true);
    expect(res.machineId).toBeUndefined();
    // The gate is never consulted, and the originate happened.
    expect(h.ensureReadyWorker).not.toHaveBeenCalled();
    expect(h.releaseWorker).not.toHaveBeenCalled();
    expect(h.originate).toHaveBeenCalledTimes(1);
  });

  it('proceeds on READY: gate runs BEFORE the room/dispatch and BEFORE the originate; machine id is carried', async () => {
    const h = harness({ worker: { status: 'ready', machineId: 'm-42' } });
    const res = await run(h);

    expect(res.status).toBe('dialing');
    expect(res.providerContacted).toBe(true);
    expect(res.machineId).toBe('m-42');
    expect(h.ensureReadyWorker).toHaveBeenCalledTimes(1);
    // Ordering (design §2.3 PR-B — READY-BEFORE-DISPATCH): the gate precedes
    // the room/dispatch, which precedes the originate. The dispatch must land
    // on an already-registered worker (never a still-cold machine), and the
    // candidate is never dialled before a ready worker exists.
    expect(order.indexOf('ensureReadyWorker')).toBeLessThan(order.indexOf('room'));
    expect(order.indexOf('room')).toBeLessThan(order.indexOf('originate'));
    expect(h.releaseWorker).not.toHaveBeenCalled();
  });

  it('passes the SESSION id and epoch, and the phone app + pipeline, to the gate', async () => {
    const h = harness({ worker: { status: 'ready', machineId: 'm-1' } });
    await run(h);
    expect(h.ensureReadyWorker).toHaveBeenCalledWith({
      app: 'project-hello-phone-voice',
      pipeline: 'phone',
      sessionId: SESSION,
      epoch: EPOCH,
    });
  });

  for (const outcome of [
    { status: 'no_capacity' as const },
    { status: 'timeout' as const },
    { status: 'error' as const, code: 'fly_5xx' },
  ]) {
    it(`DEFERS with worker_not_ready on ${outcome.status}, provisions no room and reaches no carrier`, async () => {
      const h = harness({ worker: outcome });
      const res = await run(h);

      expect(res.status).toBe('refused');
      expect(res.refusal).toBe('worker_not_ready');
      expect(res.detail).toBe(outcome.status);
      // Two witnesses of "no call": the flag and the spy.
      expectNoNetwork(res, h);
      // READY-BEFORE-DISPATCH: the gate defers BEFORE the room, so no room is
      // created and no agent is dispatched — nothing to undo.
      expect(h.createRoom).not.toHaveBeenCalled();
      expect(h.dispatch).not.toHaveBeenCalled();
      // No room name is reported, because none was provisioned.
      expect(res.roomName).toBeUndefined();
      // The service already released its own claim on a failing verdict, so the
      // controller does NOT double-release.
      expect(h.releaseWorker).not.toHaveBeenCalled();
    });
  }

  it('treats the service `disabled` verdict as a passthrough — dial proceeds, no machine id', async () => {
    const h = harness({ worker: { status: 'disabled' } });
    const res = await run(h);

    expect(res.status).toBe('dialing');
    expect(res.providerContacted).toBe(true);
    expect(res.machineId).toBeUndefined();
    expect(h.originate).toHaveBeenCalledTimes(1);
    expect(h.releaseWorker).not.toHaveBeenCalled();
  });

  it('RELEASES the gated worker when the lease is then too short to dial', async () => {
    // A ready worker was claimed, but the lease gate below it refuses. The
    // claim must not sit busy — release it (best-effort), and place no call.
    const h = harness({
      worker: { status: 'ready', machineId: 'm-7' },
      admit: admitOk({ leaseExpiresAt: after(1), leaseToken: undefined }),
    });
    const res = await run(h);

    expect(res.status).toBe('refused');
    expect(res.refusal).toBe('lease_too_short');
    expectNoNetwork(res, h);
    expect(h.ensureReadyWorker).toHaveBeenCalledTimes(1);
    expect(h.releaseWorker).toHaveBeenCalledWith({
      app: 'project-hello-phone-voice',
      machineId: 'm-7',
      sessionId: SESSION,
    });
  });

  it('RELEASES the gated worker when the originate then fails', async () => {
    const h = harness({
      worker: { status: 'ready', machineId: 'm-9' },
      originate: async () => { throw new Error('provider exploded'); },
    });
    const res = await run(h);

    expect(res.status).toBe('refused');
    expect(res.refusal).toBe('originate_failed');
    expect(res.providerContacted).toBe(true); // the SDK WAS reached
    expect(h.releaseWorker).toHaveBeenCalledWith({
      app: 'project-hello-phone-voice',
      machineId: 'm-9',
      sessionId: SESSION,
    });
  });

  it('a release failure does not change the refusal (fail-open)', async () => {
    const h = harness({
      worker: { status: 'ready', machineId: 'm-x' },
      originate: async () => { throw new Error('provider exploded'); },
    });
    h.releaseWorker.mockRejectedValueOnce(new Error('release blew up'));
    const res = await run(h);

    expect(res.status).toBe('refused');
    expect(res.refusal).toBe('originate_failed');
  });

  it('RELEASES the gated worker when the room then fails to provision', async () => {
    // The gate runs BEFORE the room now (READY-BEFORE-DISPATCH), so a room
    // failure is the earliest point that can strand a claimed-and-ready worker.
    // It must be released, and no carrier reached.
    const h = harness({
      worker: { status: 'ready', machineId: 'm-room' },
      roomFails: true,
    });
    const res = await run(h);

    expect(res.status).toBe('refused');
    expect(res.refusal).toBe('room_unavailable');
    expectNoNetwork(res, h);
    expect(h.ensureReadyWorker).toHaveBeenCalledTimes(1);
    // The gate ran before the room: ensureReadyWorker precedes the room attempt.
    expect(order.indexOf('ensureReadyWorker')).toBeLessThan(order.indexOf('room'));
    expect(h.releaseWorker).toHaveBeenCalledWith({
      app: 'project-hello-phone-voice',
      machineId: 'm-room',
      sessionId: SESSION,
    });
  });
});
