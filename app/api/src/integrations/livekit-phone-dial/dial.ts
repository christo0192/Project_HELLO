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
// The ONE delay primitive in this directory, and deliberately the PROMISE form:
// it is awaited inside the agent-join barrier's bounded poll, so it can never
// outlive the dial that awaits it. That is the property §5 of
// phone-dial-structural.test.ts protects ("a timer would be a dial that
// outlives the request"); a detached `setTimeout(` callback is still banned.
import { setTimeout as delayMs } from 'node:timers/promises';
import type { DialableNumber } from './dialable-number.js';
import type { PhoneOriginateResult, PhoneSipClient } from './sip.js';
import {
  phoneRoomName,
  provisionPhoneRoom,
  type PhoneRoomParticipantLike,
  type PhoneRoomServiceClientLike,
  type ProvisionPhoneRoomDeps,
} from './phone-room.js';
import {
  effectivePhoneAgentJoinTimeoutSec,
  isPhoneTransportReady,
  type PhoneDialConfig,
} from './config.js';
import { isReportedAgentNameFor } from './agent-name.js';

/**
 * Safety margin between the worst-case originate and the lease. Not a round
 * number for its own sake: it absorbs the round trip of the originate call
 * itself plus the clock skew between this process and Postgres, both of which
 * sit BETWEEN the moment we check the lease and the moment the reclaimer would
 * act on it.
 */
export const LEASE_MARGIN_SECONDS = 15;

/**
 * M009 E2: how often the agent-join barrier re-reads room membership. Half a
 * second keeps a warm worker's join (typically 1-3 s after dispatch) from
 * costing the candidate a noticeable extra pause before the ring, while
 * bounding the barrier to ~2 LiveKit reads a second for at most the join
 * timeout.
 */
export const PHONE_AGENT_JOIN_POLL_MS = 500;

/**
 * The longest the worker-ready gate's READY POLL can run: the orchestration
 * service clamps every `readyTimeoutSec` to at most 120 s
 * (`MAX_READY_TIMEOUT_MS` in worker-orchestration.ts). A copy, not an import —
 * that module pulls env and Fly wiring into this one — kept equal to the
 * source by worker-orchestration-default-lease-reader.test.ts.
 */
export const PHONE_WORKER_READY_CEILING_SEC = 120;

/**
 * The Fly start wait the gate spends BEFORE its ready poll even starts
 * (`DEFAULT_START_WAIT_SEC` in worker-orchestration.ts, the value the
 * production service uses). Same copy-plus-parity-test arrangement as above.
 */
export const PHONE_WORKER_START_WAIT_CEILING_SEC = 60;

/**
 * The worst case the whole worker gate can spend before the join barrier
 * starts: the start wait, THEN the ready poll (the poll's deadline is taken
 * only after `started`). The barrier sizes its own budget against this
 * CEILING rather than against whatever the runtime happened to pass, because
 * the controller cannot see those values and the ceiling is the worst case
 * the admission lease has to survive. An earlier draft clamped against the
 * ready ceiling alone and so under-counted a slow cold boot by a minute.
 */
export const PHONE_WORKER_GATE_CEILING_SEC =
  PHONE_WORKER_START_WAIT_CEILING_SEC + PHONE_WORKER_READY_CEILING_SEC;

/**
 * How many CONSECUTIVE non-`not_found` LiveKit listing failures the join
 * barrier (and its pre-dispatch snapshot) tolerates before it gives up as
 * `'unreadable'`. One 429/5xx/transport blip during a dial burst must not cost
 * a freshly booted machine and a 5-minute infra backoff; a LiveKit that keeps
 * failing still defers well inside the join budget (3 reads, 500 ms apart).
 */
export const PHONE_AGENT_JOIN_MAX_CONSECUTIVE_ERRORS = 3;

/**
 * The participant attribute the LiveKit Agents SDK stamps on every agent it
 * joins to a room, carrying the worker's REGISTERED agent name.
 *
 * NOTE THE DOT. livekit-agents 1.6.4 (the pinned worker SDK) defines
 * `ATTRIBUTE_AGENT_NAME = "lk.agent.name"` in `livekit/agents/types.py` and
 * sets it in `worker.py` on job accept (`participant_attributes[...] =
 * self._agent_name`); its own `wait_for_agent` matches on the same key. The
 * similar-looking `lk.agent_name` exists only as a TELEMETRY span attribute in
 * that SDK and is never set on a participant — matching on it would make every
 * targeted dial time out and defer. Re-verify this key whenever the worker's
 * livekit-agents pin moves.
 */
export const PHONE_AGENT_NAME_ATTRIBUTE = 'lk.agent.name';

/**
 * `ParticipantInfo_Kind.AGENT` in @livekit/protocol. The SDK hands it back as
 * the enum's number; the JSON spelling is accepted too so a client that
 * serialises enums by name cannot silently turn every join into a timeout.
 */
const PARTICIPANT_KIND_AGENT = 4;

export const PHONE_DIAL_REFUSALS = [
  'runtime_disabled',
  'admission_deferred',
  'admission_refused',
  'transport_not_configured',
  'timeouts_misordered',
  'lease_too_short_for_gate',
  'room_unavailable',
  'lease_too_short',
  // On-demand orchestration (phone-cost-and-scale-plan §2.3): when the worker
  // orchestration gate is armed and no ready worker could be confirmed for this
  // session, the dial is DEFERRED, never placed. Distinct on its own (no
  // detail), exactly like `runtime_disabled` — the candidate is not dialled
  // into a room that has no worker to answer. It is inert (never returned) when
  // no `workerGate` dep is injected, which is the default.
  'worker_not_ready',
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
  /**
   * The on-demand Fly machine this dial was gated onto, when the worker
   * orchestration gate was armed and confirmed a ready worker. Present ONLY on
   * a `dialing` result that passed the gate; `undefined` otherwise (gate off,
   * or the dial was refused). Surfaced so a terminal handler can `releaseWorker`
   * the exact machine; the reaper is the backstop if that release is missed.
   */
  readonly machineId?: string;
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

/**
 * The on-demand worker gate — the narrow slice of the worker-orchestration
 * service the dial controller needs (phone-cost-and-scale-plan §2.3).
 *
 * ADDITIVE AND OPTIONAL. When this dep is ABSENT (the default, and every path
 * with `env.workerOrchestration=false`), the controller does not consult it at
 * all and the dial path is byte-identical to today: no claim, no Fly call, no
 * new refusal. When it is present, the gate runs after the room/dispatch and
 * before the originate, and a non-`ready` verdict DEFERS the dial (never
 * dials).
 *
 * `ensureReadyWorker` mirrors the service method, narrowed to the one shape the
 * controller passes; `releaseWorker` is best-effort teardown of a claim that
 * was made for a dial this controller then refused before placing it. Both are
 * kept as a bundle so the controller can never claim a worker it has no way to
 * release.
 */
export interface PhoneWorkerReadyGate {
  ensureReadyWorker(input: {
    app: string;
    pipeline: 'phone';
    sessionId: string;
    epoch: number;
    /**
     * Wall-clock budget (seconds) for the machine to reach `ready`. The runtime
     * passes `env.phoneWorkerReadyTimeoutSec` (default 120 — the service ceiling,
     * raised from 75 so a first cold boot after a deploy/secret-change does not
     * defer and burn the one-shot owner-test gate) so a slow-booting worker is
     * not deferred prematurely; the service clamps it to [30, 300].
     */
    readyTimeoutSec?: number;
  }): Promise<
    | {
        status: 'ready';
        machineId: string;
        /**
         * M009 E2: the LEASE epoch from the read that proved ready — the token
         * `markBusy` must send on a targeted dispatch. Optional only for
         * hand-built gates that predate it; a targeted dispatch without one
         * must not guess.
         */
        epoch?: number;
        /**
         * M009 E2: the per-machine agent name the worker reported, or null /
         * absent when it reported none (dispatch the shared name, as today).
         */
        agentName?: string | null;
      }
    | { status: 'no_capacity' }
    | { status: 'timeout' }
    | { status: 'error'; code: string }
    | { status: 'disabled' }
  >;
  releaseWorker(input: { app: string; machineId: string; sessionId: string }): Promise<void>;
  /**
   * Mark the gated machine `busy` once the dial reports success. Best-effort:
   * a failure never changes the dial result — the lease is already `ready`,
   * which the reaper spares while the LiveKit room is live. Gives the reaper a
   * second liveness signal beyond room-liveness.
   */
  markBusy?(input: {
    app: string;
    machineId: string;
    sessionId: string;
    epoch: number;
  }): Promise<void>;
  /** The Fly app the phone worker pool lives in. */
  readonly app: string;
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
  /**
   * The on-demand worker gate. ABSENT by default ⇒ the dial path is exactly as
   * today (no gate, no new refusal). Present ONLY when `env.workerOrchestration`
   * is on and the runtime wires it — see `runtime.ts`.
   */
  readonly workerGate?: PhoneWorkerReadyGate;
  /**
   * M009 E2: the clock the agent-join barrier polls on, and the clock the
   * post-gate lease checks measure elapsed time on. Test seam only —
   * production omits it and gets the wall clock plus an awaited delay. Only a
   * targeted (per-machine) dispatch ever SLEEPS on it; every path reads
   * `now()` to tell how long the dial has been running.
   */
  readonly agentJoinClock?: PhoneAgentJoinClock;
  /**
   * M010 diagnostic sink for the targeted (per-machine) path. Receives ONE
   * closed-vocabulary code per targeted dial that reaches the pre-dispatch
   * snapshot (see `phoneAgentJoinObservationCode`), the seconds that stage
   * took, and the leased Fly machine id as a correlator to the worker's own
   * logs. Never a room name, identity, number or attribute value. Must be
   * synchronous; it is called fail-open and a throwing (or rejecting) sink
   * never changes the dial.
   */
  readonly onAgentJoinObservation?: (code: string, elapsedSec: number, machineId: string) => void;
}

/** The wall-clock seam the agent-join barrier polls on. */
export interface PhoneAgentJoinClock {
  /** Milliseconds since the epoch. */
  now(): number;
  /** Resolve after `ms`. Awaited — never a detached timer. */
  sleep(ms: number): Promise<void>;
}

const WALL_CLOCK: PhoneAgentJoinClock = {
  now: () => Date.now(),
  sleep: async (ms) => {
    await delayMs(ms);
  },
};

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

  // ── WHAT TIME IT IS *NOW*, not when this dial started ───────────────
  // `request.now` is taken fresh per dial (due-loop.ts), i.e. BEFORE
  // admission — and the worker gate (Fly start wait + ready poll) plus the
  // join barrier can then spend minutes before Gate 5. Measuring the lease
  // against that instant over-reports what is left (a slow cold boot read
  // ~240 s remaining with ~40 s actually left), so Gate 5 skipped the renewal
  // and the reclaimer could take the attempt back mid-ring. Worse,
  // `heartbeat_phone_attempt` uses `p_now` both for its "still live?" test and
  // as the base of the new expiry, so a stale `p_now` would renew a lapsed
  // lease AND renew it short.
  //
  // So every post-admission lease decision uses `request.now` ADVANCED by the
  // time this dial has actually spent, measured on the clock seam (the wall
  // clock in production). Staying in `request.now`'s frame — rather than
  // reading the wall clock outright — keeps one time base for admission and
  // everything after it, and keeps the controller deterministic under a
  // caller-supplied `now`.
  const clock = deps.agentJoinClock ?? WALL_CLOCK;
  const dialStartedMs = clock.now();
  const currentNow = (): Date =>
    new Date(request.now.getTime() + Math.max(0, clock.now() - dialStartedMs));

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
  // ── Gate 4-bis: a READY on-demand worker (only when the gate is armed) ─
  // phone-cost-and-scale-plan §2.3 + design §2.3 PR-B "dispatch ordering vs
  // cold start". With on-demand orchestration on, the phone worker pool is
  // scaled to zero, so before we DISPATCH into a room — and long before a
  // carrier is reached — we must have a machine STARTED, REGISTERED and
  // confirmed READY. This gate runs READY-BEFORE-DISPATCH, mirroring the
  // browser path (invites.ts Step 2c): the phone worker posts a session-LESS
  // MACHINE-level ready at prewarm (on LiveKit registration, BEFORE any job),
  // and `ensureReadyWorker` (claim → start → wait for the lease to read
  // `ready`) returns 'ready' only after it has READ that state. Only THEN does
  // `provisionPhoneRoom` create the room and dispatch to the now-registered
  // worker, so the dispatch can never be lost to a machine that was still cold.
  //
  // Any non-`ready` verdict DEFERS the dial — NO room, NO dispatch, NO
  // originate, no fabricated dialed state. The candidate is never dialled into
  // a room with no worker. The claim `ensureReadyWorker` made for the failing
  // verdicts already cleans itself up inside the service (invariant I2), so
  // there is nothing to release on `no_capacity`/`timeout`/`error`. On a
  // `ready` verdict the machine id is carried out so a terminal handler can
  // release it (reaper backstops).
  //
  // ABSENT gate ⇒ this whole block is skipped and the path is byte-identical
  // to today (room-then-originate, no claim, no Fly call). `disabled` (the
  // service's own flag-off answer) is treated exactly like an absent gate:
  // proceed exactly as before.
  let gatedMachineId: string | undefined;

  // ── M009 E2: WHICH AGENT THIS DIAL DISPATCHES TO ─────────────────────
  // The shared name (`dialConfig.agentName`) unless the gated machine's worker
  // REPORTED its own per-machine name for this claim, in which case the dial is
  // bound to that one machine. Every phone worker used to register the shared
  // name, so LiveKit handed a session's job to ANY idle worker — not the
  // machine leased for it — and every stop path (reaper, terminal-release,
  // cleanup), which judges a machine by the session on its lease, then stopped
  // machines that were running somebody else's interview. A targeted dispatch
  // makes the lease's session the session the machine actually runs.
  //
  // The API never INVENTS a per-machine name: a lease with no reported name
  // dispatches the shared name, byte-identical to before (and that is every
  // dial while the worker flag PHONE_PER_MACHINE_AGENT_NAME is off).
  let targetAgent = dialConfig.agentName;
  /** The LEASE epoch from the read that proved ready — markBusy's token when targeted. */
  let leaseEpoch: number | undefined;

  // Best-effort release of the worker we gated onto, for every refusal path
  // after a `ready` verdict (agent-name mismatch, join barrier, room
  // unavailable, lease too short, originate failed). A claim we made and then
  // declined to use must not sit `busy`/`ready`; the reaper would stop it
  // within one grace window, but releasing promptly returns the pool slot now.
  // Declared BEFORE the gate's own refusal branches because the M009 name check
  // can refuse a `ready` verdict. Fail-open: a release failure never changes
  // the refusal we return. A no-op when no machine was gated (gate off /
  // `disabled`).
  const releaseGatedWorker = async (): Promise<void> => {
    if (gatedMachineId === undefined || deps.workerGate === undefined) return;
    try {
      await deps.workerGate.releaseWorker({
        app: deps.workerGate.app,
        machineId: gatedMachineId,
        sessionId: request.sessionId,
      });
    } catch {
      /* fail-open: the reaper backstops */
    }
  };

  // The ONE infra deferral every pre-originate "no usable worker" path returns:
  // the gate's own no_capacity/timeout/error AND the M009 targeted-dispatch
  // refusals (name mismatch, agent never joined). Sharing it is the point —
  // a targeted dispatch that fails must consume the per-IST-day attempt cap
  // EXACTLY as a gate timeout always has (abandoned now, charged nothing,
  // same-day redialable), so `reclaim_phone_attempt_leases` never sees it and
  // the E3 reclaim redial hold never applies to it.
  //
  // ── Gap 5: SAME-IST-DAY RETRYABILITY ────────────────────────────────
  // Admission has ALREADY committed this attempt and charged the per-IST-day
  // index (that happens inside `admit_phone_attempt`, before this gate). A
  // pre-originate infra defer reached NO carrier, so leaving the attempt
  // `admitted` would wedge the engagement at `daily_attempt_exists` until
  // IST midnight for a hiccup the candidate never experienced. So we abandon
  // it NOW (transition #30, charges nothing) and — via the 0083 narrowed
  // index — free the same engagement to redial the same IST day. Best-effort
  // and fail-open: if the abandon RPC is absent (legacy fake) or fails, the
  // lease-reclaim sweep still recovers the attempt (same-day-retryable under
  // the same narrowed index), just not as promptly.
  //
  // `detail` is a closed, PII-free code: the gate's status, or one of the
  // `agent_*` codes below. No room name is reported, as on the gate path —
  // for the join-barrier refusals a room may exist, but it holds no SIP leg
  // and drains on its own empty timeout.
  const deferWorkerNotReady = async (detail: string): Promise<PhoneDialResult> => {
    if (deps.stores.abandonAttemptInfra) {
      try {
        // P3: pass the configured backoff so the restore also pushes
        // next_eligible_at forward — a persistently-broken pool defers once
        // per window, not once per due tick. The RPC clamps [60,3600] again.
        await deps.stores.abandonAttemptInfra({
          attemptId,
          backoffSeconds: config.infraDeferBackoffSeconds,
          // The backoff runs from when the defer HAPPENED, not from when the
          // pass began, possibly minutes earlier.
          now: currentNow(),
        });
      } catch {
        /* fail-open: reclaim sweep backstops the abandonment */
      }
    }
    return {
      status: 'refused',
      refusal: 'worker_not_ready',
      detail,
      attemptId,
      providerContacted: false,
    };
  };

  if (deps.workerGate !== undefined) {
    const gate = await deps.workerGate.ensureReadyWorker({
      app: deps.workerGate.app,
      pipeline: 'phone',
      sessionId: request.sessionId,
      epoch,
      // Gap 4: the runtime supplies env.phoneWorkerReadyTimeoutSec; the service
      // clamps and defaults it. Undefined here (a hand-built gate) uses the
      // service default.
    });
    if (gate.status === 'ready') {
      gatedMachineId = gate.machineId;
      const reported = gate.agentName ?? null;
      if (reported !== null) {
        // A reported name is trusted ONLY if it is exactly `<shared>-<this
        // lease's machine id>`. Anything else (a name for another machine, a
        // different base, a malformed value) is NOT downgraded to the shared
        // name: a worker that registered a per-machine name is not listening
        // on the shared one, so dispatching the shared name would put the job
        // on whichever OTHER worker LiveKit picks — the defect this exists to
        // remove. Defer instead, before any room exists.
        if (!isReportedAgentNameFor(dialConfig.agentName, gate.machineId, reported)) {
          await releaseGatedWorker();
          return deferWorkerNotReady('agent_name_mismatch');
        }
        targetAgent = reported;
        leaseEpoch = gate.epoch;
      }
    } else if (gate.status !== 'disabled') {
      // no_capacity | timeout | error — defer, and touch no carrier. No room
      // was provisioned (we gate BEFORE the dispatch), so there is no room name
      // to report and no dispatch to undo. The service released any machine it
      // could PROVE it still held for this attempt, so we do not release here.
      // (It stops nothing it cannot prove — a claim that moved on belongs to
      // whoever holds it now, and the reaper is the backstop for the rest.)
      return deferWorkerNotReady(gate.status);
    }
    // status === 'disabled' falls through: the service's flag is off, so the
    // gate is inert and the dial proceeds exactly as it does with no gate.
  }

  // True only when a per-machine name was reported AND verified above. Every
  // M009 behaviour below (snapshot, join barrier, lease-epoch markBusy) hangs
  // off this one flag, so the untargeted path is the pre-M009 path verbatim.
  const targeted = targetAgent !== dialConfig.agentName;

  // ── M009 E2: snapshot the agents ALREADY in the room ────────────────
  // Taken BEFORE the dispatch, so the join barrier below can tell the agent
  // THIS dispatch produced from one that was already there. A reconnect adopts
  // the session's existing room, and that room can still hold the previous
  // attempt's agent — possibly from this very machine, under this very name.
  // Counting it as "joined" would originate a SIP leg on the strength of an
  // agent that is about to leave. A room that does not exist yet (the normal
  // first dial) is an empty snapshot. Any other read failure means the join
  // cannot be proven later either, so it defers now, before a room or dispatch
  // is created.
  // M010: one diagnostic line per targeted dial, reported fail-open. The
  // sink is optional; nothing here can change what the dial does.
  const targetedStartedMs = targeted ? clock.now() : 0;
  const reportTargeted = (stage: PhoneAgentJoinStage, obs: PhoneAgentJoinObservation): void => {
    if (!deps.onAgentJoinObservation) return;
    try {
      const pending = deps.onAgentJoinObservation(
        phoneAgentJoinObservationCode(stage, obs),
        Math.max(0, (clock.now() - targetedStartedMs) / 1000),
        gatedMachineId ?? '',
      ) as unknown;
      if (pending !== null && typeof pending === 'object'
        && typeof (pending as { catch?: unknown }).catch === 'function') {
        (pending as Promise<unknown>).catch(() => undefined);
      }
    } catch {
      /* diagnostics must never change the dial */
    }
  };
  const snapshotObservation = newAgentJoinObservation();

  let agentsBefore: ReadonlySet<string> = new Set<string>();
  if (targeted) {
    const snapshot = await readAgentIdentities(
      deps.room.rooms,
      phoneRoomName(request.sessionId),
      clock,
      snapshotObservation,
    );
    if (snapshot === 'unreadable') {
      reportTargeted('su', snapshotObservation);
      await releaseGatedWorker();
      return deferWorkerNotReady('agent_join_unverifiable');
    }
    agentsBefore = snapshot;
    snapshotObservation.snapshotAgents = snapshot.size;
  }

  // ── Gate 4: a room to originate into ────────────────────────────────
  // The room is created BEFORE the dial and starts NO egress. A reconnect
  // adopts the existing room, keeping one session and one transcript. Created
  // AFTER the worker-ready gate above (when armed) so the explicit dispatch
  // lands on a worker already registered with LiveKit — never on a machine that
  // is still cold. When the gate is absent (the default), this is exactly the
  // first thing that happens after admission, byte-identical to today.
  const room = await provisionPhoneRoom(
    { sessionId: request.sessionId, attemptId, epoch, agentName: targetAgent },
    deps.room,
  );
  if (room.status === 'not_configured' || room.status === 'provider_failed') {
    // A room failure after we already claimed a worker (gate armed + ready)
    // must release that claim — it will otherwise sit `ready`/`busy` until the
    // reaper. Fail-open, as every release on this path is.
    await releaseGatedWorker();
    return {
      status: 'refused',
      refusal: 'room_unavailable',
      detail: room.reason,
      attemptId,
      providerContacted: false,
    };
  }

  // ── Gate 4-ter (M009 E2): the TARGETED agent must be IN the room ─────
  // Before a single ring. "Ready" is a MACHINE-level fact posted at prewarm,
  // which can land before the worker finishes registering its name with
  // LiveKit, and a same-session redial can land on a machine still at full
  // load from the previous leg. A targeted dispatch has exactly ONE worker
  // that can take it, so if that worker does not show up the room stays
  // empty — and a candidate dialled into it hears dead air. So the barrier
  // waits, bounded, for a NEW agent participant (identity not in the snapshot)
  // carrying the targeted name, and on anything short of that it defers
  // through the same infra deferral as a gate timeout, after the same cleanup
  // as a room failure (release the claim; the room itself holds no SIP leg and
  // drains on its empty timeout). It NEVER originates on this path.
  //
  // The untargeted (shared-name) path skips this entirely: no listing, no
  // wait — byte-identical to before.
  if (targeted) {
    // A dispatch that never happened (failed, or no dispatch client) cannot
    // produce an agent. Waiting out the join timeout for it would only burn
    // lease; defer now. (The untargeted path keeps its historical behaviour
    // for this case and is deliberately not changed here.)
    if (!room.dispatched) {
      reportTargeted('nd', snapshotObservation);
      await releaseGatedWorker();
      return deferWorkerNotReady('agent_dispatch_failed');
    }
    const joinTimeoutSec = effectivePhoneAgentJoinTimeoutSec({
      configuredSec: dialConfig.agentJoinTimeoutSec,
      originateLeaseSec: config.leaseSeconds,
      // Start wait + ready poll, not the ready poll alone (see the constant).
      workerReadyTimeoutSec: PHONE_WORKER_GATE_CEILING_SEC,
    }).seconds;
    const joinObservation = newAgentJoinObservation();
    joinObservation.snapshotAgents = agentsBefore.size;
    const joined = await awaitTargetedAgentJoin({
      rooms: deps.room.rooms,
      roomName: room.roomName,
      targetAgent,
      sharedAgentName: dialConfig.agentName,
      agentsBefore,
      timeoutMs: joinTimeoutSec * 1000,
      clock,
      observation: joinObservation,
    });
    reportTargeted(
      joined === 'joined' ? 'j' : joined === 'timeout' ? 't' : 'u',
      joinObservation,
    );
    if (joined !== 'joined') {
      await releaseGatedWorker();
      return deferWorkerNotReady(
        joined === 'timeout' ? 'agent_join_timeout' : 'agent_join_unverifiable',
      );
    }
  }

  // ── Gate 5: the lease must outlive the originate ────────────────────
  // Measured at the CURRENT instant (see `currentNow`): after a slow gate and
  // join the lease may be far shorter than `request.now` suggests, and this is
  // the last point at which it can be renewed — or found already lapsed
  // (`lease_lost` ⇒ refuse) — before a carrier is reached.
  const required = dialConfig.originateTimeoutSeconds + LEASE_MARGIN_SECONDS;
  if (!(await leaseOutlivesOriginate(
    { attemptId, leaseToken, leaseExpiresAt, required, now: currentNow() },
    deps,
  ))) {
    await releaseGatedWorker();
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
  // correlation attempt id carried on the `xhelloattempt` attribute — and
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
    await releaseGatedWorker();
    return {
      status: 'refused',
      refusal: 'originate_failed',
      attemptId,
      roomName: room.roomName,
      providerContacted: true,
    };
  }

  // Gap 3: the dial is placed — mark the lease `busy` so the reaper has a
  // second liveness signal (a lease past grace still reading `ready`, never
  // `busy`, is a machine that was claimed but whose call never went live).
  // Best-effort: a failure here never changes the dialing result — the lease is
  // already `ready`, which the reaper spares while the LiveKit room is live. A
  // synthetic rehearsal still marks busy: the lease bookkeeping is about the
  // machine's claim, not about whether a real carrier was reached.
  //
  // ── M009 E2: WHICH EPOCH ─────────────────────────────────────────────
  // `mark_voice_worker_busy` CASes on the LEASE epoch (prev+1 per claim,
  // 0079). The ATTEMPT epoch sent below on the untargeted path can never equal
  // it, so that call has always been a no-op and the lease has stayed `ready`.
  //
  // TARGETED: send the lease epoch, so the lease really reaches `busy`. Now
  // that the job is bound to this machine, `busy` is TRUE.
  //
  // UNTARGETED: deliberately UNCHANGED (still the attempt epoch, still a
  // no-op). On the shared-name fleet the job may be running on a DIFFERENT
  // machine; a working `busy` would stop this lease's prewarm heartbeat
  // refreshes and make the reaper act on it EARLIER — more wrongful stops, not
  // fewer. A targeted dispatch that somehow lacks a lease epoch sends nothing
  // rather than guessing a token.
  const busyEpoch = targeted ? leaseEpoch : epoch;
  if (
    gatedMachineId !== undefined
    && deps.workerGate?.markBusy !== undefined
    && busyEpoch !== undefined
  ) {
    try {
      await deps.workerGate.markBusy({
        app: deps.workerGate.app,
        machineId: gatedMachineId,
        sessionId: request.sessionId,
        epoch: busyEpoch,
      });
    } catch {
      /* best-effort: the lease is already ready, which the reaper spares */
    }
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
    // Carried ONLY when the worker gate was armed and confirmed ready. A
    // terminal handler releases this exact machine; the reaper is the backstop.
    machineId: gatedMachineId,
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

/**
 * True iff LiveKit's rejection says the ROOM does not exist. Mirrors the
 * reaper's classifier in worker-orchestration.ts (not imported: that module
 * pulls env and Fly wiring into this one). A Twirp `not_found`, an HTTP 404,
 * or the server's literal "requested room does not exist".
 */
function isRoomNotFound(err: unknown): boolean {
  if (err === null || typeof err !== 'object') return false;
  const e = err as { code?: unknown; status?: unknown; statusCode?: unknown; message?: unknown };
  if (typeof e.code === 'string' && e.code.toLowerCase() === 'not_found') return true;
  if (e.status === 404 || e.statusCode === 404) return true;
  return typeof e.message === 'string' && /requested room does not exist/i.test(e.message);
}

/** An AGENT-kind participant. A SIP or standard participant never matches. */
function isAgentParticipant(p: PhoneRoomParticipantLike | null | undefined): boolean {
  return p !== null
    && typeof p === 'object'
    && (p.kind === PARTICIPANT_KIND_AGENT || p.kind === 'AGENT');
}

/**
 * One listing of a room, TAGGED so the barrier's answer and its diagnostics
 * come from the same classification and cannot drift apart. `listRoomOnce`
 * below is the only caller that turns this into a barrier answer.
 */
type RoomListing =
  | { readonly kind: 'ok'; readonly participants: ReadonlyArray<PhoneRoomParticipantLike> }
  | { readonly kind: 'not_found' }
  | { readonly kind: 'failed'; readonly errorClass: PhoneListingErrorClass }
  | { readonly kind: 'unsupported' };

async function listRoomTagged(
  rooms: PhoneRoomServiceClientLike,
  roomName: string,
): Promise<RoomListing> {
  if (typeof rooms.listParticipants !== 'function') return { kind: 'unsupported' };
  try {
    const listed = await rooms.listParticipants(roomName);
    return Array.isArray(listed)
      ? { kind: 'ok', participants: listed }
      : { kind: 'failed', errorClass: 'na' };
  } catch (err) {
    if (isRoomNotFound(err)) return { kind: 'not_found' };
    let errorClass: PhoneListingErrorClass = 'ot';
    try {
      errorClass = classifyListingError(err);
    } catch {
      /* diagnostics only: an unreadable error is still just 'failed' */
    }
    return { kind: 'failed', errorClass };
  }
}

/**
 * List the room once. `not_found` is an EMPTY room (a room that does not exist
 * holds nobody). A client with no `listParticipants` is `'unsupported'` — a
 * STRUCTURAL inability no retry will cure. Every other failure, and a
 * non-array answer, is `'failed'`: possibly transient, and never guessed into
 * "empty". When an observation is given, the outcome is also counted there;
 * counting is fail-open and never changes the answer.
 */
async function listRoomOnce(
  rooms: PhoneRoomServiceClientLike,
  roomName: string,
  obs?: PhoneAgentJoinObservation,
): Promise<ReadonlyArray<PhoneRoomParticipantLike> | 'failed' | 'unsupported'> {
  const listed = await listRoomTagged(rooms, roomName);
  if (obs !== undefined) {
    try {
      recordListing(obs, listed);
    } catch {
      /* diagnostics only */
    }
  }
  switch (listed.kind) {
    case 'unsupported': return 'unsupported';
    case 'failed': return 'failed';
    case 'not_found': return [];
    case 'ok': return listed.participants;
  }
}

/**
 * The identities of the AGENT participants currently in `roomName` — the
 * pre-dispatch snapshot of the join barrier. Only agent identities are kept;
 * no attribute of any participant is read here.
 *
 * A failed listing is retried, one poll interval apart, up to
 * `PHONE_AGENT_JOIN_MAX_CONSECUTIVE_ERRORS` reads in all: the machine is
 * already booted and claimed by now, and one LiveKit blip should not throw it
 * away. Only a client that cannot list at all, or a LiveKit that keeps
 * failing, is `'unreadable'`.
 */
async function readAgentIdentities(
  rooms: PhoneRoomServiceClientLike,
  roomName: string,
  clock: PhoneAgentJoinClock,
  obs?: PhoneAgentJoinObservation,
): Promise<ReadonlySet<string> | 'unreadable'> {
  let listed = await listRoomOnce(rooms, roomName, obs);
  for (
    let tries = 1;
    listed === 'failed' && tries < PHONE_AGENT_JOIN_MAX_CONSECUTIVE_ERRORS;
    tries += 1
  ) {
    await clock.sleep(PHONE_AGENT_JOIN_POLL_MS);
    listed = await listRoomOnce(rooms, roomName, obs);
  }
  if (listed === 'failed' || listed === 'unsupported') return 'unreadable';
  const out = new Set<string>();
  for (const p of listed) {
    if (isAgentParticipant(p) && typeof p.identity === 'string') out.add(p.identity);
  }
  return out;
}

/**
 * Poll until an agent participant that was NOT in `agentsBefore` appears
 * carrying `targetAgent` as its registered name, or the budget runs out.
 *
 * All three conditions are required, and each closes a distinct false
 * positive: AGENT kind (the SIP leg or any other participant is not a worker),
 * a NEW identity (a previous attempt's agent still in an adopted room), and
 * the EXACT targeted name (an agent from another worker pool or another
 * machine). The join decision reads the attribute only from agent-kind
 * participants; M010's diagnostics also classify (never log) it for others.
 *
 * `not_found` while polling is read as "not joined yet" (the room is being
 * created / propagated), never as joined. Any other listing failure is ALSO
 * "not seen yet" — never "joined" — and polling continues: one 429/5xx during
 * a burst must not cost a booted machine and a 5-minute backoff. The wait
 * gives up as `'unreadable'` only when failures become persistent
 * (`PHONE_AGENT_JOIN_MAX_CONSECUTIVE_ERRORS` in a row), when the client cannot
 * list at all, or when the budget ran out WITHOUT A SINGLE successful listing
 * (a join that was never observable cannot be proven, and an unproven join
 * must not be dialled into). A budget that ran out after at least one good
 * listing is a plain `'timeout'`. Always performs at least one listing, and
 * one final listing at the deadline, so a join that landed during the last
 * sleep is not missed.
 */
async function awaitTargetedAgentJoin(input: {
  rooms: PhoneRoomServiceClientLike;
  roomName: string;
  targetAgent: string;
  /** The shared base name, used only to classify a mismatch for diagnostics. */
  sharedAgentName: string;
  agentsBefore: ReadonlySet<string>;
  timeoutMs: number;
  clock: PhoneAgentJoinClock;
  observation: PhoneAgentJoinObservation;
}): Promise<'joined' | 'timeout' | 'unreadable'> {
  const deadline = input.clock.now() + input.timeoutMs;
  let consecutiveFailures = 0;
  let anyListingSucceeded = false;
  for (;;) {
    const listed = await listRoomOnce(input.rooms, input.roomName, input.observation);
    if (listed === 'unsupported') return 'unreadable';
    if (listed === 'failed') {
      consecutiveFailures += 1;
      if (consecutiveFailures >= PHONE_AGENT_JOIN_MAX_CONSECUTIVE_ERRORS) return 'unreadable';
    } else {
      consecutiveFailures = 0;
      anyListingSucceeded = true;
    }
    if (listed !== 'failed') {
      try {
        observeParticipants(input.observation, listed, input);
      } catch {
        /* diagnostics only */
      }
    }
    for (const p of listed === 'failed' ? [] : listed) {
      if (
        isAgentParticipant(p)
        && typeof p.identity === 'string'
        && !input.agentsBefore.has(p.identity)
        && p.attributes?.[PHONE_AGENT_NAME_ATTRIBUTE] === input.targetAgent
      ) {
        return 'joined';
      }
    }
    const remaining = deadline - input.clock.now();
    if (!(remaining > 0)) return anyListingSucceeded ? 'timeout' : 'unreadable';
    await input.clock.sleep(Math.min(PHONE_AGENT_JOIN_POLL_MS, remaining));
  }
}

// ── M010: WHAT THE JOIN BARRIER SAW ──────────────────────────────────
// Production deferred every targeted dial while the worker was visibly
// connected to the room, and nothing recorded WHY the barrier did not count
// it. These counters fold into ONE closed-vocabulary code per targeted dial
// that defers or joins: no room name, no identity, no attribute value and no
// number ever leaves this module. Tokens are one or two characters so the
// worst case stays inside the logger's 64-character identifier rule.

/**
 * How a participant's `lk.agent.name` compared with the target. One letter:
 * `n` none seen, `e` no attributes at all, `a` attributes but not this key,
 * `o` other value, `s` the shared base name, `m` another machine's name,
 * `y` the target. Never carries the value.
 */
export type PhoneAgentNameAttrStatus = 'n' | 'e' | 'a' | 'o' | 's' | 'm' | 'y';

/** Ranked so the most informative status seen during the wait is kept. */
const NAME_ATTR_RANK: Record<PhoneAgentNameAttrStatus, number> = {
  n: 0, e: 1, a: 2, o: 3, s: 4, m: 5, y: 6,
};

/**
 * A listing failure's class, from a closed set: `pd` permission_denied / 403,
 * `ua` unauthenticated / 401, `un` unavailable / 503, `de` deadline_exceeded /
 * 504, `in` internal / other 5xx, `rl` resource_exhausted / 429, `na` a
 * non-array answer, `ot` anything else.
 */
export type PhoneListingErrorClass = 'pd' | 'ua' | 'un' | 'de' | 'in' | 'rl' | 'na' | 'ot';

const TWIRP_ERROR_CLASSES: Readonly<Record<string, PhoneListingErrorClass>> = {
  permission_denied: 'pd',
  unauthenticated: 'ua',
  unavailable: 'un',
  deadline_exceeded: 'de',
  internal: 'in',
  resource_exhausted: 'rl',
};

/** Classify a listing error without reading or keeping its message. */
export function classifyListingError(err: unknown): PhoneListingErrorClass {
  if (err === null || typeof err !== 'object') return 'ot';
  const e = err as { code?: unknown; status?: unknown; statusCode?: unknown };
  if (typeof e.code === 'string') {
    const key = e.code.toLowerCase();
    // Own keys only: a code such as `constructor` must not resolve to an
    // inherited member and smuggle a non-vocabulary string into the line.
    if (Object.hasOwn(TWIRP_ERROR_CLASSES, key)) return TWIRP_ERROR_CLASSES[key]!;
  }
  const status = typeof e.status === 'number' ? e.status : e.statusCode;
  if (typeof status === 'number') {
    if (status === 401) return 'ua';
    if (status === 403) return 'pd';
    if (status === 429) return 'rl';
    if (status === 503) return 'un';
    if (status === 504) return 'de';
    if (status >= 500 && status <= 599) return 'in';
  }
  return 'ot';
}

export interface PhoneAgentJoinObservation {
  listingsOk: number;
  listingsNotFound: number;
  listingsFailed: number;
  /** The FIRST failure's class (the most telling); undefined while none failed. */
  firstErrorClass: PhoneListingErrorClass | undefined;
  /** A not_found AFTER a good listing: the room vanished mid-wait. */
  notFoundAfterOk: boolean;
  /** Agent identities already in the room before the dispatch. */
  snapshotAgents: number;
  maxParticipants: number;
  maxNewAgents: number;
  /** Distinct participant kinds seen, as safe tokens (at most 3 kept). */
  kinds: Set<string>;
  /** Best name status among NEW agent-kind participants. */
  agentName: PhoneAgentNameAttrStatus;
  /** Best name status among NEW non-agent participants (a worker of the wrong kind?). */
  otherName: PhoneAgentNameAttrStatus;
  /** Best name status among agents ALREADY present before the dispatch. */
  priorName: PhoneAgentNameAttrStatus;
  /** NEW agent-kind participants in the most recent good listing (joined then left?). */
  lastNewAgents: number;
}

export function newAgentJoinObservation(): PhoneAgentJoinObservation {
  return {
    listingsOk: 0,
    listingsNotFound: 0,
    listingsFailed: 0,
    firstErrorClass: undefined,
    notFoundAfterOk: false,
    snapshotAgents: 0,
    maxParticipants: 0,
    maxNewAgents: 0,
    kinds: new Set<string>(),
    agentName: 'n',
    otherName: 'n',
    priorName: 'n',
    lastNewAgents: 0,
  };
}

function recordListing(obs: PhoneAgentJoinObservation, listed: RoomListing): void {
  switch (listed.kind) {
    case 'ok':
      obs.listingsOk += 1;
      return;
    case 'not_found':
      obs.listingsNotFound += 1;
      if (obs.listingsOk > 0) obs.notFoundAfterOk = true;
      return;
    case 'failed':
      obs.listingsFailed += 1;
      if (obs.firstErrorClass === undefined) obs.firstErrorClass = listed.errorClass;
      return;
    case 'unsupported':
      return;
  }
}

/** LiveKit's ParticipantInfo.Kind names, for a client that serialises by name. */
const KIND_NAME_TOKENS: Readonly<Record<string, string>> = {
  STANDARD: '0', INGRESS: '1', EGRESS: '2', SIP: '3', AGENT: '4',
};

/** A participant kind as one safe token: a small enum number, `u` absent, `x` other. */
function kindToken(kind: unknown): string {
  if (typeof kind === 'number' && Number.isInteger(kind) && kind >= 0 && kind <= 15) {
    return String(kind);
  }
  // Exact spelling only, as `isAgentParticipant` accepts only exact 'AGENT':
  // a `k.4` must mean the barrier would have accepted the kind.
  if (typeof kind === 'string') {
    return Object.hasOwn(KIND_NAME_TOKENS, kind) ? KIND_NAME_TOKENS[kind]! : 'x';
  }
  return kind === undefined ? 'u' : 'x';
}

/**
 * Classify a participant's name attribute against the target, from its
 * attribute map. Never returns the value or any key.
 */
export function classifyAgentNameAttr(
  attributes: unknown,
  targetAgent: string,
  sharedAgentName: string,
): PhoneAgentNameAttrStatus {
  if (attributes === null || typeof attributes !== 'object') return 'e';
  if (Object.keys(attributes).length === 0) return 'e';
  const value = (attributes as Record<string, unknown>)[PHONE_AGENT_NAME_ATTRIBUTE];
  if (typeof value !== 'string' || value === '') return 'a';
  if (value === targetAgent) return 'y';
  if (value === sharedAgentName) return 's';
  if (sharedAgentName !== '' && value.startsWith(`${sharedAgentName}-`)) return 'm';
  return 'o';
}

function better(
  current: PhoneAgentNameAttrStatus,
  seen: PhoneAgentNameAttrStatus,
): PhoneAgentNameAttrStatus {
  return NAME_ATTR_RANK[seen] > NAME_ATTR_RANK[current] ? seen : current;
}

function observeParticipants(
  obs: PhoneAgentJoinObservation,
  participants: ReadonlyArray<PhoneRoomParticipantLike>,
  input: { targetAgent: string; sharedAgentName: string; agentsBefore: ReadonlySet<string> },
): void {
  obs.maxParticipants = Math.max(obs.maxParticipants, participants.length);
  let newAgents = 0;
  for (const p of participants) {
    if (p === null || typeof p !== 'object') continue;
    if (obs.kinds.size < 3) obs.kinds.add(kindToken(p.kind));
    const status = classifyAgentNameAttr(p.attributes, input.targetAgent, input.sharedAgentName);
    if (typeof p.identity === 'string' && input.agentsBefore.has(p.identity)) {
      obs.priorName = better(obs.priorName, status);
      continue;
    }
    if (isAgentParticipant(p)) {
      newAgents += 1;
      obs.agentName = better(obs.agentName, status);
    } else {
      obs.otherName = better(obs.otherName, status);
    }
  }
  obs.maxNewAgents = Math.max(obs.maxNewAgents, newAgents);
  obs.lastNewAgents = newAgents;
}

/**
 * Where the targeted path stopped: `j` joined, `t` timed out after good
 * listings, `u` barrier could not read the room, `su` the pre-dispatch
 * snapshot could not read the room, `nd` the dispatch failed.
 */
export type PhoneAgentJoinStage = 'j' | 't' | 'u' | 'su' | 'nd';

/**
 * One code per targeted dial that reaches the snapshot, at most 64 characters
 * (the logger's identifier cap), e.g.
 * `o.t:l.40.0.0:e.0:f.0:s.0:p.1:a.1:z.1:k.4:n.a:x.n:b.n`:
 * `o` stage; `l` listings ok.not_found.failed (each clamped to 99); `e` the
 * first failure's class (`0` none); `f` 1 if the room vanished after a good
 * listing; `s` agents already present before the dispatch; `p` most
 * participants in one listing; `a` most NEW agent-kind participants; `z` new
 * agent-kind participants in the LAST good listing (`a.1:z.0` = joined, then
 * left); these four clamped to 9; `k` up to three distinct kinds; `n` best name
 * status of a new agent (`o.t` with `n.y` means the matching agent had no
 * string identity); `x` best name status of a new NON-agent participant; `b`
 * best name status of an agent already present before the dispatch.
 */
export function phoneAgentJoinObservationCode(
  stage: PhoneAgentJoinStage,
  obs: PhoneAgentJoinObservation,
): string {
  const clamp = (n: number, max: number): string =>
    String(Math.min(max, Math.max(0, Math.floor(n))));
  const kinds = [...obs.kinds].sort().join('.') || 'none';
  return [
    `o.${stage}`,
    `l.${clamp(obs.listingsOk, 99)}.${clamp(obs.listingsNotFound, 99)}.${clamp(obs.listingsFailed, 99)}`,
    `e.${obs.firstErrorClass ?? '0'}`,
    `f.${obs.notFoundAfterOk ? '1' : '0'}`,
    `s.${clamp(obs.snapshotAgents, 9)}`,
    `p.${clamp(obs.maxParticipants, 9)}`,
    `a.${clamp(obs.maxNewAgents, 9)}`,
    `z.${clamp(obs.lastNewAgents, 9)}`,
    `k.${kinds}`,
    `n.${obs.agentName}`,
    `x.${obs.otherName}`,
    `b.${obs.priorName}`,
  ].join(':');
}

/** Seconds of lease left, or `undefined` when the value is unusable. */
function remainingLeaseSeconds(expiresAt: string | undefined, now: Date): number | undefined {
  if (typeof expiresAt !== 'string') return undefined;
  const expiry = Date.parse(expiresAt);
  if (Number.isNaN(expiry)) return undefined;
  return (expiry - now.getTime()) / 1000;
}
