/**
 * livekit-phone-dial/dial.ts — the dial controller: every gate that must hold
 * BEFORE a carrier is reached, in the order they must hold.
 *
 * ── THE ONE INVARIANT ─────────────────────────────────────────────────
 * Nothing in this file may reach the network until every gate below has
 * passed. Each refusal returns a stable code and performs NO provider call.
 * The gates are, in order:
 *
 *   1. RUNTIME       — master switch AND runtime switch (`0042`'s two flags).
 *   2. ADMISSION     — `admit_phone_attempt`, which holds the advisory lock
 *                      and re-checks, under it, the halt switch, the IST
 *                      window, consent, suppression, the per-IST-day index,
 *                      the fleet cap and the number's validity. This code does
 *                      not re-implement any of them; re-implementing a gate is
 *                      how the two copies come to disagree.
 *   3. ROOM          — a room must exist to originate into.
 *   4. LEASE         — the concurrency lease must be proven to OUTLIVE the
 *                      longest possible originate. See below; this is the
 *                      gate that is easiest to leave out and worst to lose.
 *
 * Only then is the SIP client asked to originate — and even then, the client
 * is the SYNTHETIC one unless `isLiveDialPermitted` holds. There is no
 * configuration in which `synthetic` reaches the SDK, because the synthetic
 * client contains no SDK reference at all (see `sip.ts`).
 *
 * ── WHY THE LEASE GATE IS NOT OPTIONAL ────────────────────────────────
 * `waitUntilAnswered: true` makes the originate BLOCK. The SDK's default
 * `timeout` in that mode is 60 s — once exactly the default
 * `PHONE_LEASE_SECONDS`, and still well within the reach of a lease an
 * operator is free to set as low as 5 s. So an originate can outlive the lease
 * that reserves its fleet slot — and when it does, `reclaim_phone_attempt_leases` abandons
 * the attempt while its dial is still in flight. Two calls then hold one slot,
 * and the reclaimer has already restored the engagement to its prior state, so
 * the answer that eventually arrives lands on a row that has moved on.
 *
 * Worse, nothing else notices: P3's reconciliation sweep deliberately leaves
 * HELD leases alone (an expired lease belongs entirely to the reclaimer), so
 * there is no second observer to catch it.
 *
 * The gate is therefore: extend the lease so it outlives the worst-case
 * originate, and if the extension CANNOT be obtained — `lease_lost`, an
 * unreachable database, anything — REFUSE BEFORE THE SDK. A dial we cannot
 * account for is worse than a dial we did not place.
 */

import {
  admitPhoneEngagement,
  PHONE_OPENING_GATE_SECONDS,
  isPhoneRuntimeActive,
  type PhoneAdmissionDeps,
  type PhoneAdmissionRequest,
  type PhoneAttemptKind,
  type PhoneScreeningConfig,
  type PhoneStores,
} from '../../lib/phone-screening/index.js';
import type { DialableNumber } from './dialable-number.js';
import type { PhoneOriginateResult, PhoneSipClient } from './sip.js';
import { provisionPhoneRoom, type ProvisionPhoneRoomDeps } from './phone-room.js';
import { isPhoneTransportReady, type PhoneDialConfig } from './config.js';

/**
 * Safety margin between the worst-case originate and the lease. Not a round
 * number for its own sake: it absorbs the round trip of the originate call
 * itself plus the clock skew between this process and Postgres, both of which
 * sit BETWEEN the moment we check the lease and the moment the reclaimer would
 * act on it.
 */
export const LEASE_MARGIN_SECONDS = 15;

export const PHONE_DIAL_REFUSALS = [
  'runtime_disabled',
  'admission_deferred',
  'admission_refused',
  'transport_not_configured',
  'timeouts_misordered',
  'lease_too_short_for_gate',
  'room_unavailable',
  'lease_too_short',
  'originate_failed',
] as const;

export type PhoneDialRefusal = (typeof PHONE_DIAL_REFUSALS)[number];

export interface PhoneDialResult {
  readonly status: 'dialing' | 'refused';
  readonly refusal?: PhoneDialRefusal;
  /** The stable sub-code from admission, when admission is what refused. */
  readonly detail?: string;
  readonly attemptId?: string;
  readonly roomName?: string;
  readonly participantIdentity?: string;
  readonly sipCallId?: string;
  readonly epoch?: number;
  /** `true` when the SYNTHETIC client served the originate. Never inferred. */
  readonly synthetic?: boolean;
  /** Whether the SDK was reached. Asserted directly by the structural tests. */
  readonly providerContacted: boolean;
}

export interface PhoneDialRequest {
  readonly engagementId: string;
  readonly candidateId: string;
  readonly sessionId: string;
  readonly kind: PhoneAttemptKind;
  /** Read from the candidate row by the caller; self-redacting. */
  readonly number: DialableNumber;
  readonly now: Date;
  /** 0063. Present only for the exclusive candidate test gate. */
  readonly testGateId?: string;
}

export interface PhoneDialDeps {
  readonly config: PhoneScreeningConfig;
  /** TRANSPORT config, separate from the domain flags. Both must permit. */
  readonly dialConfig: PhoneDialConfig;
  readonly stores: PhoneStores;
  readonly admission: Omit<PhoneAdmissionDeps, 'stores' | 'config'>;
  readonly sip: PhoneSipClient;
  readonly room: ProvisionPhoneRoomDeps;
  /** LiveKit credentials, only to decide "is a room even possible". */
  readonly leaseOwner: string;
}

/**
 * Place one outbound dial, or refuse and touch nothing.
 *
 * Returns `providerContacted` explicitly rather than leaving it to be inferred
 * from the shape of the result. Several of the mandated tests assert "no
 * network happened", and an assertion that infers absence from a missing field
 * passes just as happily when the field was dropped by a refactor.
 */
export async function dialPhoneAttempt(
  request: PhoneDialRequest,
  deps: PhoneDialDeps,
): Promise<PhoneDialResult> {
  const { config, dialConfig } = deps;

  // ── Gate 1: the two flags ───────────────────────────────────────────
  if (!isPhoneRuntimeActive(config)) {
    return { status: 'refused', refusal: 'runtime_disabled', providerContacted: false };
  }

  // ── Gate 1a: the two time bounds must be ORDERED ────────────────────
  // The originate must outlast the ring. If it does not, the SDK call gives up
  // while the carrier is still ringing: the controller reports
  // `originate_failed`, the lease (sized off the originate bound) lapses, the
  // reclaimer restores the engagement — and the leg can STILL be answered,
  // landing a real person in a room whose dial we have written off. That is the
  // failure the lease gate exists to prevent, reintroduced through the other
  // knob, so the two are related here rather than left to two independent
  // defaults staying in the right order forever.
  if (config.ringTimeoutSeconds >= dialConfig.originateTimeoutSeconds) {
    return { status: 'refused', refusal: 'timeouts_misordered', providerContacted: false };
  }

  // ── Gate 1a-bis: the lease must cover the OPENING GATE ──────────────
  // The lease is extended once, pre-originate, and then NOBODY heartbeats
  // until the agent's first beat — which happens only after the line has
  // rung, somebody has answered, the disclosure has been delivered and
  // answered, and an AWAITED LiveKit egress call has returned. A lease that
  // does not span all of that lapses under a live conversation: the first
  // beat answers `lease_lost`, the agent hangs up on a candidate who has
  // just consented, and because the engagement is `in_call` by then the
  // room close charges a reconnect and the next leg carries the same risk.
  //
  // Asserted HERE rather than left to the default, for the same reason
  // `timeouts_misordered` above is: this lane has now twice shipped a bound
  // that lived only in a paragraph, and twice had it missed. A default is a
  // suggestion; a refusal is a bound.
  //
  // It refuses rather than silently extending, because a lease long enough
  // to be safe is a deployment decision — quietly stretching it would hold
  // fleet slots an operator never budgeted for.
  if (config.leaseSeconds < config.ringTimeoutSeconds + PHONE_OPENING_GATE_SECONDS) {
    return { status: 'refused', refusal: 'lease_too_short_for_gate', providerContacted: false };
  }

  // ── Gate 1b: somewhere to send it ───────────────────────────────────
  // Independent of the flags on purpose. Arming the dialer and configuring a
  // trunk are TWO decisions, and neither is allowed to imply the other; an
  // armed dialer with no trunk is misconfigured, not permitted.
  if (!isPhoneTransportReady(dialConfig)) {
    return { status: 'refused', refusal: 'transport_not_configured', providerContacted: false };
  }

  // ── Gate 2: admission ───────────────────────────────────────────────
  // Halt, window, consent, suppression, per-day index, fleet cap and number
  // validity are ALL decided here, inside the advisory lock, by 0042. This
  // controller deliberately re-checks none of them.
  const admissionRequest: PhoneAdmissionRequest = {
    engagementId: request.engagementId,
    candidateId: request.candidateId,
    kind: request.kind,
    phoneDigest: request.number.digest,
    leaseOwner: deps.leaseOwner,
    leaseSeconds: config.leaseSeconds,
    now: request.now,
    runtimeReady: true,
  };
  const admitted = await admitPhoneEngagement(
    {
      ...deps.admission,
      stores: deps.stores,
      config,
      admitAttempt: request.testGateId === undefined
        ? undefined
        : async (input) => {
          if (!deps.stores.admitTestAttempt) return { status: 'halted' };
          return deps.stores.admitTestAttempt({ ...input, testGateId: request.testGateId! });
        },
    },
    admissionRequest,
  );
  if (admitted.decision === 'deferred') {
    return {
      status: 'refused',
      refusal: 'admission_deferred',
      detail: admitted.code,
      providerContacted: false,
    };
  }
  if (admitted.decision !== 'admitted') {
    // The test-gate wrapper collapses its guard refusals AND the inner
    // admission's refusal to `status: 'halted'` with the real answer in
    // `constraint`. Counting the wrapper status made the health surface
    // report the KILL SWITCH while the actual refusal was, live on
    // 2026-08-28, `daily_attempt_exists` — a 40-minute misdirection. Prefer
    // the constraint; `phoneRefusalCountKey` still closes the vocabulary, so
    // an unrecognised constraint collapses to `:unknown`, never leaks.
    const constraint = admitted.result?.detail?.constraint;
    return {
      status: 'refused',
      refusal: 'admission_refused',
      detail: typeof constraint === 'string' ? constraint : admitted.status,
      providerContacted: false,
    };
  }

  const { attemptId, epoch, leaseToken, leaseExpiresAt } = admitted.result;
  if (attemptId === undefined || epoch === undefined) {
    // Admission answered `ok` without the identifiers that make the attempt
    // addressable. Nothing downstream can fence, heartbeat or reconcile such a
    // dial, so it is refused BEFORE the SDK rather than placed blind.
    return { status: 'refused', refusal: 'admission_refused', detail: 'ok_without_attempt', providerContacted: false };
  }

  // ── The allowlist gate is ADMISSION'S, and deliberately not repeated ─
  // `admitPhoneEngagement` already defers with `dial_not_allowlisted` when the
  // mode is `live` and the digest is absent or not on the list — and it gets
  // the subtlety right that a first draft of this file got wrong: the gate
  // applies to `live` ONLY, because `synthetic` reaches no carrier and an
  // allowlist there would block the very rehearsal it exists to permit.
  //
  // A second copy here would be UNREACHABLE: admission runs first, reads the
  // same digest from the same field, and refuses before control returns. An
  // unreachable branch reads as a safety net and is not one — the same reason
  // 0042 declines to write a "charged but no state change" branch. So the rule
  // lives in exactly one place, where it is reachable and tested.
  // ── Gate 4: a room to originate into ────────────────────────────────
  // The room is created BEFORE the dial and starts NO egress. A reconnect
  // adopts the existing room, keeping one session and one transcript.
  const room = await provisionPhoneRoom(
    { sessionId: request.sessionId, attemptId, epoch, agentName: dialConfig.agentName },
    deps.room,
  );
  if (room.status === 'not_configured' || room.status === 'provider_failed') {
    return {
      status: 'refused',
      refusal: 'room_unavailable',
      detail: room.reason,
      attemptId,
      providerContacted: false,
    };
  }

  // ── Gate 5: the lease must outlive the originate ────────────────────
  const required = dialConfig.originateTimeoutSeconds + LEASE_MARGIN_SECONDS;
  if (!(await leaseOutlivesOriginate(
    { attemptId, leaseToken, leaseExpiresAt, required, now: request.now },
    deps,
  ))) {
    return {
      status: 'refused',
      refusal: 'lease_too_short',
      attemptId,
      providerContacted: false,
    };
  }

  // ── Originate ───────────────────────────────────────────────────────
  // ── BOUNCE MODE: dial the Plivo voice-app endpoint, not the candidate ──
  // The candidate number has ALREADY passed every admission/allowlist gate
  // above (admission reads `request.number.digest`); bounce changes only what
  // LiveKit dials. LiveKit dials the bounce ENDPOINT down the bounce TRUNK; the
  // endpoint answers instantly (satisfying LiveKit's outbound-SIP answer
  // timers, which never register a real answer on this Plivo trunk), and
  // Plivo's app then dials the candidate — resolved server-side from the
  // correlation attempt id carried on the `x-hello-attempt` attribute — and
  // bridges. Off, this is byte-identical: the direct trunk, the candidate
  // number, no correlation attribute.
  const bounce = dialConfig.bounceMode;
  let originated: PhoneOriginateResult;
  try {
    originated = await deps.sip.createSipParticipant({
      trunkId: bounce ? dialConfig.bounceTrunkId : dialConfig.sipTrunkId,
      target: bounce
        ? { kind: 'bounce', bounceUser: dialConfig.bounceSipUser }
        : { kind: 'number', number: request.number },
      roomName: room.roomName,
      attemptId,
      epoch,
      originateTimeoutSeconds: dialConfig.originateTimeoutSeconds,
      // The RING timeout is a DOMAIN bound (it decides when a call becomes a
      // no-answer, which charges a candidate's budget), so it stays in
      // phone-screening. The other two are transport.
      ringTimeoutSeconds: config.ringTimeoutSeconds,
      maxCallSeconds: dialConfig.maxCallSeconds,
    });
  } catch {
    // The provider WAS contacted. Say so — a caller deciding whether this is
    // chargeable, and an operator reading the outcome, both need the
    // difference between "we refused" and "we tried and it failed". The error
    // itself is discarded: a provider message may quote the dialled number.
    return {
      status: 'refused',
      refusal: 'originate_failed',
      attemptId,
      roomName: room.roomName,
      providerContacted: true,
    };
  }

  return {
    status: 'dialing',
    attemptId,
    epoch,
    roomName: room.roomName,
    participantIdentity: originated.participantIdentity,
    sipCallId: originated.sipCallId,
    synthetic: originated.synthetic,
    // The synthetic client is not the provider. A synthetic rehearsal that
    // reported `providerContacted: true` would make the "synthetic places no
    // call" assertion unfalsifiable.
    providerContacted: !originated.synthetic,
  };
}

/**
 * True iff the concurrency lease is proven to outlive the worst-case
 * originate, extending it if necessary.
 *
 * A heartbeat that FAILS returns false rather than throwing, because the
 * caller's response to both is identical and must be: refuse before the SDK.
 */
async function leaseOutlivesOriginate(
  input: {
    attemptId: string;
    leaseToken: string | undefined;
    leaseExpiresAt: string | undefined;
    required: number;
    now: Date;
  },
  deps: PhoneDialDeps,
): Promise<boolean> {
  // No token means we cannot renew and cannot prove anything about the slot.
  // Fail closed: an unprovable lease is treated exactly like a lost one.
  if (input.leaseToken === undefined) return false;

  const remaining = remainingLeaseSeconds(input.leaseExpiresAt, input.now);
  if (remaining !== undefined && remaining >= input.required) return true;

  // Ask for a lease long enough to cover the originate, clamped by 0042 to
  // [5, 900]. `required` can exceed `config.leaseSeconds`, and that is the
  // point: the lease is sized to the WORK, not to a default.
  const heartbeat = await deps.stores.heartbeatAttempt({
    attemptId: input.attemptId,
    leaseToken: input.leaseToken,
    leaseSeconds: Math.max(input.required, deps.config.leaseSeconds),
    now: input.now,
  });
  if (heartbeat.status !== 'ok') return false;

  // Re-verify against the value the DATABASE returned rather than assuming we
  // got what we asked for. 0042 clamps to 900 s, so a `required` beyond that
  // would silently come back short — and "we asked for enough" is not the same
  // claim as "we have enough".
  const renewed = remainingLeaseSeconds(heartbeat.leaseExpiresAt, input.now);
  return renewed !== undefined && renewed >= input.required;
}

/** Seconds of lease left, or `undefined` when the value is unusable. */
function remainingLeaseSeconds(expiresAt: string | undefined, now: Date): number | undefined {
  if (typeof expiresAt !== 'string') return undefined;
  const expiry = Date.parse(expiresAt);
  if (Number.isNaN(expiry)) return undefined;
  return (expiry - now.getTime()) / 1000;
}
