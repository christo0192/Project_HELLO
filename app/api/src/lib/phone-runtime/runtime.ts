/**
 * lib/phone-runtime/runtime.ts — the composition root for the phone lane.
 *
 * ── WITH THE SHIPPED DEFAULTS THIS CONSTRUCTS NOTHING ─────────────────
 * `PHONE_SCREENING_ENABLED` and `PHONE_RUNTIME_ENABLED` are both `false`, so
 * `createPhoneRuntime` returns `null`: no runner, no scheduler, no timer, no
 * database poll, no SDK object and no provider call. That is the whole safety
 * claim of this phase, and it is a property of construction rather than of a
 * branch somewhere inside a loop.
 *
 * ── THE LOOPS, AND WHY EACH ONE IS LOAD-BEARING ───────────────────────
 * The set is deliberately open: `scheduler.loops` is a plain array and
 * `loopIntervalsMs` is derived from it, so a new loop is one entry plus one
 * cadence knob. No count is written down here or anywhere in the package;
 * the only place the CURRENT set is pinned is `LOOP_NAMES` in
 * `phone-runtime-loops.test.ts`, which is one edit.
 *   phone-dial       drains the durable `phone.dial` intent that
 *                    `admit_phone_attempt` records inside the admitting
 *                    transaction. It does not dial — see `dial-handler.ts` for
 *                    the reasoning, which is the most surprising decision here.
 *   phone-due        offers due engagements to admission. The only loop that
 *                    can cause a call, and the only one gated on the halt.
 *   phone-reclaim    reclaims expired ATTEMPT leases — the fleet-slot lease,
 *                    not the queue lease. NOT optional: 0042 says outright
 *                    that "the 10-slot cap's correctness depends on P5
 *                    heartbeating", and a lapsed lease otherwise holds one of
 *                    ten slots against every other candidate until a human
 *                    notices. It charges no budget, because a dead worker is
 *                    our failure and not the candidate's attempt.
 *   phone-maintain   expires overdue appointments. A cheap local UPDATE.
 *   phone-reconcile  P3's dropped-webhook sweep, which reads LiveKit room
 *                    state for every live attempt. It has its OWN knob
 *                    because it is a different job at a different cost, and
 *                    because a knob that moves nothing is worse than an
 *                    absent one — see the note at the loop itself.
 *
 * ── THE TWO SWEEPERS MUST NOT OVERLAP ─────────────────────────────────
 * `reclaim_phone_attempt_leases` handles EXPIRED leases and charges nothing.
 * `runPhoneReconciliation` handles STILL-HELD leases and posts outcomes that
 * DO charge. Blurring them spends a candidate's anti-harassment budget on our
 * own crash. Both are driven here; neither is given the other's rows, because
 * each selects its own and the selection predicates are disjoint by design.
 *
 * ── THE HALT FAILS CLOSED, DELIBERATELY UNLIKE RECORDING ──────────────
 * `lib/recording/halt.ts` fails OPEN and documents why. This lane inverts it:
 * an unreadable `phone_control` row refuses admission, because the thing on
 * the other side of the gate is a telephone call to a person. The
 * `shouldClaim` passed to the queue runner therefore fails CLOSED — an
 * explicit halt, an absent control singleton and an unreadable one all stop
 * claiming — and a process that has never successfully read the control row
 * claims nothing at all. That is NOT the recording pattern, and the
 * difference is the point.
 */

import { randomUUID } from 'node:crypto';
import type { SupabaseClient } from '@supabase/supabase-js';
import { Queue } from '../queue/index.js';
import { PgAdapter } from '../queue/pg-adapter.js';
import { createQueueRunner, type QueueRunnerHandle } from '../queue/runner.js';
import {
  createLoopScheduler,
  queueRunnerTick,
  type LoopSchedulerHandle,
  type SchedulerLoopConfig,
} from '../scheduler.js';
import { createLogger } from '../logger.js';
import { supabase } from '../supabase.js';
import { createSession, transitionSession } from '../session-lifecycle.js';
import {
  createPhoneReadStore,
  createPhoneStores,
  isPhoneRuntimeActive,
  loadPhoneScreeningConfig,
  type PhoneScreeningConfig,
  type PhoneStores,
} from '../phone-screening/index.js';
import {
  dialPhoneAttempt,
  loadPhoneDialConfig,
  phoneRoomName,
  resolvePhoneSipClient,
  type PhoneDialConfig,
} from '../../integrations/livekit-phone-dial/index.js';
import {
  loadLiveKitPhoneConfig,
  runPhoneReconciliation,
  createDuePhoneAttemptReader,
  createDefaultLiveKitRoomReader,
} from '../../integrations/livekit-phone/index.js';
import { env } from '../env.js';
import {
  PHONE_DIAL_QUEUE,
  PHONE_ASSESSMENT_QUEUE,
  phoneAssessmentDedupKey,
  describePhoneRuntimeConfig,
  loadPhoneRuntimeConfig,
  type PhoneRuntimeConfig,
} from './config.js';
import { createPhoneDialHandler, type PhoneDialJobOutcome } from './dial-handler.js';
import { createPhoneAssessmentHandler } from './assessment-handler.js';
import {
  createPhoneRuntimeReader,
  PHONE_SESSION_MODE,
  RESUMABLE_SESSION_STATUSES,
  type PhoneRuntimeReader,
} from './read.js';
import { createPhoneRoomClients } from './livekit-clients.js';
import {
  runPhoneDuePass,
  type PhoneDueResult,
  type PhoneSessionPort,
} from './due-loop.js';

export interface PhoneRuntimeOptions {
  readonly config?: PhoneScreeningConfig;
  readonly runtimeConfig?: PhoneRuntimeConfig;
  readonly dialConfig?: PhoneDialConfig;
  readonly client?: SupabaseClient;
  readonly queue?: Queue;
  readonly owner?: string;
  readonly reader?: PhoneRuntimeReader;
  readonly stores?: PhoneStores;
  readonly scheduler?: { readonly random?: () => number };
}

export interface PhoneRuntimeSnapshot {
  readonly lastDue: PhoneDueResult | null;
  readonly dialJobOutcomes: Readonly<Record<string, number>>;
  readonly lastReclaimed: number | null;
  readonly lastExpired: number | null;
  readonly lastReconciled: number | null;
  /** 0045. Engagements rolled onto a new IST day by the last day-roll pass. */
  readonly lastRolled: number | null;
  /** 0045. Stranded engagements resolved — completed plus truthfully failed. */
  readonly lastStranded: number | null;
  /**
   * 0071 / X5b. Sessions driven terminal by the last stranded-recording pass
   * so a crashed call's recording could finalize. Distinct from lastStranded.
   */
  readonly lastRecStranded: number | null;
  /**
   * 0072. Sessions the last partial-finalize pass drove `in_progress ->
   * completed` (candidate hangup / network drop / worker crash), each of which
   * fired the MP3 promotion and had partial scoring enqueued. Distinct from
   * lastRecStranded: this selects on the session being ENDED, drives to
   * `completed` (not `expired`), and enqueues a scorecard.
   */
  readonly lastPartialFinalized: number | null;
  /**
   * Sweeps whose LAST run answered with a non-`ok` RPC status, by name.
   *
   * Separate from the counts on purpose. A count of `0` means the sweep ran
   * and found nothing; a `null` count with a flag here means it did not run.
   * Collapsing the two would let a sweep that has silently stopped report as
   * a healthy idle one.
   */
  readonly sweepNotOk: Readonly<Record<string, boolean>>;
}

export interface PhoneRuntimeHandle {
  /**
   * The cadence knobs this process actually resolved, as integers.
   *
   * Carried on the handle rather than re-read at the health surface because
   * the values that matter to an operator are the ones this process CLAMPED
   * and is running with, not whatever the environment says now. A knob edited
   * after boot does not take effect until a restart, and a surface that read
   * the environment would report the edit as though it had.
   */
  readonly config: Readonly<Record<string, number>>;
  readonly scheduler: LoopSchedulerHandle;
  readonly runner: QueueRunnerHandle;
  readonly queue: Queue;
  readonly loopIntervalsMs: Readonly<Record<string, number>>;
  snapshot(): PhoneRuntimeSnapshot;
  tickAll(): Promise<void>;
  stop(): Promise<void>;
}

/**
 * The session port. Adopts a reusable phone session, else mints one and moves
 * it to `waiting` carrying its deterministic room name — the exact shape
 * `start_phone_assessment` verifies before it will bind anything.
 */
/**
 * The two writes this package performs, injectable.
 *
 * They were module-level imports, which made `createPhoneSessionPort` — the
 * ONLY function in `lib/phone-runtime/` that writes to a table — untestable,
 * and it went untested. Deleting the `transitionSession` call left every one
 * of the package's tests green while the shipped runtime would have handed
 * `dialPhoneAttempt` a session with no `external_call_id`, placed the call to
 * a real person, and had `start_phone_assessment` refuse it
 * `session_binding_mismatch`: the person picks up and the screening cannot
 * start. A seam is the difference between that and a red test.
 */
export interface PhoneSessionWriter {
  createSession: typeof createSession;
  transitionSession: typeof transitionSession;
}

export function createPhoneSessionPort(
  reader: PhoneRuntimeReader,
  writer: PhoneSessionWriter = { createSession, transitionSession },
): PhoneSessionPort {
  return {
    async ensureSession(input): Promise<string | null> {
      // ── The session already named on the engagement ──────────────────
      // VERIFIED, not trusted. This path used to return the column outright
      // while the adoption path below status-filtered and checked the room
      // name — so the two disagreed about what a usable session is, and the
      // disagreement was not academic: an engagement sitting in `reconnecting`
      // whose session had gone terminal would be handed that dead session,
      // dialled, answered by a real person, and then refused by
      // `start_phone_assessment` with `session_not_active`. A call that could
      // never have gone anywhere, charged against a reconnect budget that is
      // spent AT THE GRANT.
      if (input.existingSessionId !== null) {
        const existing = await reader.readSessionForReuse({
          sessionId: input.existingSessionId,
        });
        if (existing === null || !existing.roomVerified) return null;
        if (!(RESUMABLE_SESSION_STATUSES as readonly string[]).includes(existing.status)) {
          return null;
        }
        return input.existingSessionId;
      }

      // ── Adoption, scoped to THIS engagement ──────────────────────────
      // `call_sessions` carries no engagement column, so the candidate is the
      // only key available for the lookup — and the candidate is NOT unique
      // per engagement. `uq_phone_engagements_application` keys an engagement
      // to an application link and `idx_phone_engagements_candidate` is
      // deliberately not unique, so one person applying to two roles has two
      // engagements with two independent no-answer budgets and two
      // independent IST-day slots. Adopting by candidate alone would hand
      // both the same session: two SIP legs into one room, and
      // `start_phone_assessment` binding one session to two engagements, so
      // only one of them could ever complete.
      //
      // The guard is the ownership check. A session some OTHER engagement has
      // already bound is not adoptable; this engagement mints its own.
      // Adoption is allowed only where it is UNAMBIGUOUS. Two guards, and the
      // first is the one that matters: `engagementOwningSession` can only see
      // a session some engagement has already BOUND, and the dangerous
      // session is usually unbound — engagement A dials, nobody answers, A
      // leaves an adoptable `waiting` session that nothing owns, and
      // engagement B adopts it. So a candidate with more than one live
      // engagement adopts nothing and mints its own session. An extra row is
      // the cheap direction; two SIP legs in one room is not.
      const liveEngagements = await reader.countLiveEngagements({
        candidateId: input.candidateId,
      });
      if (liveEngagements <= 1) {
        const adopted = await reader.findReusableSession({ candidateId: input.candidateId });
        if (adopted !== null) {
          const owner = await reader.engagementOwningSession({ sessionId: adopted });
          if (owner === null || owner === input.engagementId) return adopted;
        }
      }

      const created = await writer.createSession({
        candidate_id: input.candidateId,
        role_id: input.roleId,
        mode: PHONE_SESSION_MODE,
        provider: 'livekit',
      });
      if (created.error !== null || created.data === null) return null;

      const sessionId = created.data.id as string;
      // `created` -> `waiting` AND the room name in one CAS. A session without
      // `external_call_id` set to its own room can never start an assessment,
      // so leaving it half-provisioned would be worse than not creating it.
      const moved = await writer.transitionSession(
        sessionId,
        'created',
        'waiting',
        undefined,
        { external_call_id: phoneRoomName(sessionId) },
      );
      return moved.ok ? sessionId : null;
    },
  };
}

/**
 * The `didWork` answer of a loop whose INTERVAL IS A CORRECTNESS BOUND rather
 * than a preference.
 *
 * ── WHY NOT `intervalMsFor`, WHICH IS THE OBVIOUS SEAM ────────────────
 * `SchedulerLoopConfig.intervalMsFor` exists and is real, but it was read
 * before it was relied on, and it does NOT do this job. It replaces the BASE
 * handed to `nextPollDelayMs(base, idle, random)`; the idle exponent is then
 * applied to whatever it returned, so a loop that must not drift cannot be
 * pinned by it without re-deriving the scheduler's own idle bookkeeping out
 * here — a second copy of a rule that lives one module away, which is the
 * pattern this package spends most of its comments avoiding.
 *
 * `didWork` is the input the scheduler ACTUALLY consults when it decides
 * whether to back off, so that is the input these two loops answer. It means
 * "hold the base cadence", and the delay becomes
 * `nextPollDelayMs(base, 0, random)` = `base · [0.5, 1.0)` — bounded ABOVE by
 * the loop's own configured interval, which is the property both bounds below
 * are stated in terms of and `phone-runtime-loops.test.ts` measures.
 *
 * ── IT IS RETURNED ONLY BY A TICK THAT ACTUALLY SUCCEEDED ────────────
 * A throwing tick never reaches this value at all: `didWork` stays false and
 * the scheduler backs off as before. But a throw is NOT the only way a pass
 * fails. `runPhoneDuePass` answers `status: 'halted'` without throwing when
 * the `phone_control` singleton is missing or unreadable, and every sweep RPC
 * can answer a non-`ok` status without throwing. An earlier revision returned
 * this constant unconditionally, and the comment here claimed only throws
 * mattered — so with the control row absent the due loop re-ran the halt and
 * backlog reads every ~7.5-15 s, on every replica, for the whole length of an
 * incident, instead of backing off to the 60 s ceiling.
 *
 * So every site below pairs it with `false` on the failing branch. The
 * reconnect-priority intent of M-2/M-4 is untouched, because that intent is
 * about a SUCCESSFUL pass that found nothing to do — `status: 'ok'` with
 * `dialing: 0`, `reclaimed: 0` — which still holds the base cadence.
 */
const HOLD_BASE_CADENCE = true;

/**
 * The `didWork` answer of a tick that did NOT succeed: let the scheduler back
 * off. Named so the two branches read as a pair at every site rather than as
 * a bare boolean whose polarity has to be re-derived.
 */
const ALLOW_IDLE_BACKOFF = false;

export function createPhoneRuntime(
  options: PhoneRuntimeOptions = {},
): PhoneRuntimeHandle | null {
  const config = options.config ?? loadPhoneScreeningConfig();
  // THE GATE. Both switches, and nothing below this line runs without them.
  if (!isPhoneRuntimeActive(config)) return null;

  const runtimeConfig = options.runtimeConfig ?? loadPhoneRuntimeConfig();
  const dialConfig = options.dialConfig ?? loadPhoneDialConfig();
  const logger = createLogger('phone-runtime');
  const client = options.client ?? (supabase as unknown as SupabaseClient);
  const queue = options.queue ?? new Queue(new PgAdapter(client), { defaultMaxAttempts: 5 });
  // ── THE OWNER MUST BE UNIQUE PER PROCESS, NOT PER PID ──────────────
  // `phone-${process.pid}` alone is `phone-1` in every container: the API is
  // PID 1 under Docker and Kubernetes. `claim_phone_sweep` renews when the
  // owner matches, so every replica would read its own owner back and every
  // replica would win — the claim table would buy exactly nothing in the
  // deployment shape it was written for.
  const owner = options.owner
    ?? `phone-${process.pid}-${randomUUID().slice(0, 8)}`;
  const stores = options.stores ?? createPhoneStores(client as never);
  const reader = options.reader ?? createPhoneRuntimeReader(client);
  const readStore = createPhoneReadStore(client as never);

  const dialJobOutcomes: Record<string, number> = {};
  let lastDue: PhoneDueResult | null = null;
  let lastReclaimed: number | null = null;
  let lastExpired: number | null = null;
  let lastReconciled: number | null = null;
  // Whether the LAST run of each sweep answered with a non-`ok` status. Kept
  // apart from the counts because "swept, nothing to do" and "the sweep did
  // not happen" must reach the health surface as different answers.
  const sweepNotOk: Record<string, boolean> = {
    reclaim: false, expire: false, reconcile: false, dayroll: false, stranded: false,
    recstrand: false, partialfin: false,
  };
  let lastRolled: number | null = null;
  let lastStranded: number | null = null;
  // 0071 / X5b: sessions driven terminal so a crashed call's recording could
  // finalize. Kept apart from `stranded` (0045), which resolves the opposite
  // shape — an engagement pointing at an already-terminal session.
  let lastRecStranded: number | null = null;
  // 0072: sessions partial-finalized (ended non-terminally, driven to
  // `completed`, MP3 promoted + partial scoring enqueued) by the last pass.
  let lastPartialFinalized: number | null = null;

  /**
   * The bounded leader CLAIM in front of a fleet-wide sweep.
   *
   * Every replica runs every loop. For the DUE pass that is now harmless —
   * admission is globally serialised and, since 0045, candidate-guarded, so a
   * second replica's dial is REFUSED rather than duplicated. For a sweep it is
   * merely wasteful, and the waste scales with the fleet.
   *
   * This is a claim, NOT an election: it can expire while its holder is still
   * working, and then two replicas sweep at once. That is acceptable only
   * because every sweep behind it is idempotent — the day roll dedups on an id
   * scoped by engagement AND IST date, the stranded resolution dedups per
   * session. It bounds duplication; it does not establish exclusivity, and
   * nothing downstream may assume it does.
   *
   * Fails CLOSED: a claim we could not read is not a claim we hold.
   */
  const claimed = async (sweep: string): Promise<'mine' | 'theirs' | 'broken'> => {
    try {
      const result = await stores.claimSweep({
        sweep,
        owner,
        // The TTL must outlive the pass it guards, or the claim lapses while
        // its holder works and the bound it exists to provide is gone.
        ttlSeconds: Math.max(5, Math.ceil((runtimeConfig.expireMs * 2) / 1000)),
        now: new Date(),
      });
      if (result.status === 'ok') return 'mine';
      // ── `held_by_other` AND "the claim does not work" ARE NOT THE SAME ──
      // Collapsing them into one `false` is how a missed grant on
      // `claim_phone_sweep` silently disables BOTH new loops on EVERY
      // replica for ever — `day.rolled` never posted, the no-answer ladder
      // still ending at attempt 1 — while `/api/phone/health` reports
      // `sweeps_not_ok: []` and `status: ok`. This commit already hit a
      // missed revoke/grant pair once, on a different function.
      //
      // `held_by_other` is the NORMAL answer every replica but one hears on
      // every tick and must stay silent. Anything else is a fault.
      return result.status === 'held_by_other' ? 'theirs' : 'broken';
    } catch {
      return 'broken';
    }
  };

  /**
   * Apply a claim verdict to the sweep's published state.
   *
   * Returns whether the sweep should run. The COUNT is nulled in both
   * non-running cases, because a replica that has stopped sweeping must not
   * keep publishing the number from the last pass it did run — a stale `4`
   * reads as a sweep that worked minutes ago rather than one that has not
   * run in days. Symmetrically, a `theirs` verdict CLEARS the fault flag, so
   * a replica cannot report `degraded` for ever after the problem is fixed.
   */
  const applyClaim = (sweep: string, verdict: 'mine' | 'theirs' | 'broken'): boolean => {
    if (verdict === 'mine') return true;
    sweepNotOk[sweep] = verdict === 'broken';
    if (sweep === 'dayroll') lastRolled = null;
    if (sweep === 'stranded') lastStranded = null;
    if (sweep === 'recstrand') lastRecStranded = null;
    if (sweep === 'partialfin') lastPartialFinalized = null;
    if (sweep === 'reconcile') lastReconciled = null;
    return false;
  };

  const credentials = {
    url: env.livekitUrl,
    apiKey: env.livekitApiKey,
    apiSecret: env.livekitApiSecret,
  };
  const roomClients = createPhoneRoomClients(credentials, dialConfig.agentName);

  // ── THE CLAIM GATE, CACHED AND FAIL-CLOSED ───────────────────────────
  // The header of this file promised a `shouldClaim` that inverts recording's
  // fail-OPEN halt, and for one commit it promised it without passing one.
  // That is the worst of both: a reader concludes the queue loop is
  // halt-gated, and it is not. The gate is real now.
  //
  // Cached, because `shouldClaim` is consulted on every poll and its contract
  // requires a cheap consult. Fail-CLOSED, because the thing on the other
  // side of this lane's gate is a telephone call to a person, and the cost of
  // pausing a queue whose handler is a no-op is nothing at all.
  let haltCheckedAtMs = 0;
  let haltAdmits = false;
  const HALT_CACHE_MS = 5_000;
  const admitsClaims = async (queueName: string): Promise<boolean> => {
    // Scoring is post-call durable work. It must continue while the phone
    // dialing halt is raised; only the queue that can originate a new call is
    // controlled by the phone halt.
    if (queueName !== PHONE_DIAL_QUEUE) return true;
    const nowMs = Date.now();
    if (haltCheckedAtMs !== 0 && nowMs - haltCheckedAtMs < HALT_CACHE_MS) return haltAdmits;
    haltCheckedAtMs = nowMs;
    try {
      const backlog = await stores.backlog({ now: new Date() });
      // phone.dial is a spent, originate-free queue record. It is safe to
      // drain while halted; only the due/admission path can contact a provider.
      // Still fail closed when the control singleton cannot be read.
      haltAdmits = backlog.admission?.controlPresent === true;
    } catch {
      haltAdmits = false;
    }
    return haltAdmits;
  };

  const runner = createQueueRunner({
    queue,
    handlers: {
      [PHONE_DIAL_QUEUE]: createPhoneDialHandler({
        onOutcome: (outcome: PhoneDialJobOutcome) => {
          dialJobOutcomes[outcome] = (dialJobOutcomes[outcome] ?? 0) + 1;
        },
      }),
      [PHONE_ASSESSMENT_QUEUE]: createPhoneAssessmentHandler({ client }),
    },
    owner,
    shouldClaim: admitsClaims,
    leaseSeconds: runtimeConfig.jobLeaseSeconds,
    concurrency: 1,
    pollMs: runtimeConfig.dueMs,
    onEvent: (e) => {
      // Metadata only: queue name and a sanitized kind. Never a payload, never
      // an attempt id, never anything derived from a candidate.
      logger.info('unknown_event', {
        error_category: `phone_queue_${e.kind}`,
        error_type: e.queueName,
      });
    },
  });

  const sessions = createPhoneSessionPort(reader);

  /**
   * THE LOOP SET, in one array.
   *
   * `loopIntervalsMs` below is DERIVED from it rather than written out a
   * second time. That is not tidiness: the reported cadence map and the armed
   * cadence were once two literals, and a loop welded to the wrong knob was
   * invisible to every name-level assertion. Deriving makes "the map says what
   * the scheduler was armed with" true by construction, and makes adding a
   * loop one entry rather than two edits that can disagree.
   */
  const loops: SchedulerLoopConfig[] = [
    {
      name: 'phone-dial',
      intervalMs: runtimeConfig.dueMs,
      tick: queueRunnerTick(runner),
    },
    {
      name: 'phone-due',
      intervalMs: runtimeConfig.dueMs,
      tick: async () => {
        const now = new Date();
        const result = await runPhoneDuePass(
          {
            config,
            reader,
            stores,
            sessions,
            liveAppointmentStart: async (engagementId: string) => {
              const appointment = await readStore.getLiveAppointmentForEngagement(engagementId);
              return appointment?.startsAt ?? null;
            },
            dialer: {
              dial: async (input) => {
                if (roomClients === null) {
                  // No room client means no room, and `provisionPhoneRoom`
                  // would answer `not_configured` anyway. Refusing here
                  // keeps the reason honest instead of laundering a missing
                  // credential into a provider failure.
                  return { status: 'refused', refusal: 'room_unavailable' };
                }
                // The ONLY selector. Live iff `isLiveDialPermitted` — which
                // already requires both switches, `dialMode === 'live'`, a
                // non-empty digest allowlist and a configured trunk. Every
                // other configuration yields the synthetic client, which
                // contains no SDK reference at all.
                const sip = resolvePhoneSipClient(config, dialConfig, credentials, {});
                const result = await dialPhoneAttempt(input, {
                  config,
                  dialConfig,
                  stores,
                  admission: { consentReader: reader.consent },
                  sip: sip.client,
                  room: roomClients,
                  leaseOwner: owner,
                });
                // `detail` is carried, not dropped. It is admission's
                // stable sub-code, and dropping it here is precisely how
                // eight distinct answers — `window_closed`, `at_capacity`,
                // `daily_attempt_exists`, `consent_missing`, `suppressed`,
                // `phone_invalid`, `halt_unreadable`,
                // `ingestion_not_ready` — used to arrive at the health
                // surface as one number. The due pass closes the vocabulary
                // before it counts it; see `phoneRefusalCountKey`.
                return result.refusal === undefined
                  ? { status: result.status }
                  : { status: result.status, refusal: result.refusal, detail: result.detail };
              },
            },
          },
          { now, limit: runtimeConfig.dueLimit },
        );
        lastDue = result;
        // ── TEMP DIAG (revert after diagnosis) ──────────────────────
        // Bounded, PII-free dial-decision telemetry for the owner test
        // gate that is not being originated. Emits only on interesting
        // ticks (a gate is present, or a skip/refusal occurred, or the
        // pass halted). The re-read of the gate is deliberate: it lets a
        // `halted` status be told apart from a missing gate. Only counts
        // and stable sub-codes are logged — never a number, name or id.
        try {
          const diagGate = reader.activeTestGate
            ? await reader.activeTestGate({ now })
            : null;
          // Sanitise each sub-code so a `:detail` cannot form the entropy /
          // token pattern the logger's value-defense drops (which silently
          // nulled the whole field last iteration). Non-alphanumerics collapse
          // to `_`, each code caps at 28 chars, and codes join with `-` — no
          // 30+ alphanumeric run, no colon, no path.
          const sanitizeCodes = (keys: string[]): string =>
            keys.map((raw) => raw.replace(/[^a-z0-9]+/gi, '_').slice(0, 28)).join('-')
            || 'none';
          const diagSkip = sanitizeCodes(Object.keys(result.skipped ?? {}));
          const diagRef = sanitizeCodes(Object.keys(result.refusals ?? {}));
          if (
            diagGate !== null
            || diagSkip !== 'none'
            || diagRef !== 'none'
            || result.status !== 'ok'
          ) {
            logger.info('unknown_event', {
              error_type: 'phone_due_diag',
              error_category: (
                `gate.${diagGate !== null ? 1 : 0}:st.${result.status}`
                + `:ex${result.examined}:of${result.offered}:di${result.dialing}`
                + `:skip.${diagSkip}:ref.${diagRef}`
              ).slice(0, 180),
            });
          }
        } catch {
          // Diagnostics must never affect the tick.
        }
        // ── M-4: THE RECONNECT BOUND IS THIS LOOP'S CADENCE ─────────
        // `return result.dialing > 0` let a pass that dialled nothing back
        // off toward the 60s ceiling. A dropped call becomes due
        // `reconnectBackoffSeconds` (120s) after the drop, so the pass that
        // would act on it then waited 120s PLUS up to a fully backed-off
        // due interval: the contract's "bounded reconnect approximately 120
        // seconds" was bounded by nothing the code stated. Held at the base
        // cadence the bound is `reconnectBackoffSeconds + dueMs`, which is
        // a number this file can state and a test can measure.
        //
        // THE ALTERNATIVE, AND WHY IT WAS NOT CHOSEN. The other repair on
        // offer was to return the base cadence only while some engagement
        // is `reconnecting`. It cannot work, because this loop learns that
        // a row is `reconnecting` only by RUNNING a pass — and the pass
        // that is late is the FIRST one after the drop, whose delay was
        // chosen by the previous pass, which saw nothing. The condition
        // becomes true exactly one pass after it would have helped. It also
        // costs a `PhoneDueResult` field that would exist only to feed a
        // scheduling decision, and reads as a bound while guaranteeing
        // none.
        //
        // The cost is one bounded `limit`-sized indexed read per `dueMs`
        // while the lane is idle. That is the cheapest read in the package
        // and the only one a person is waiting on.
        //
        // ── M-7: ONLY A PASS THAT SUCCEEDED HOLDS THE CADENCE ───────
        // `halted` and `disabled` are returned WITHOUT throwing, so an
        // unconditional hold pinned the base cadence through exactly the
        // incident it should have backed off for: with `phone_control`
        // missing, every pass answers `halted` and the loop re-ran the halt
        // and backlog reads every ~7.5-15 s on every replica, indefinitely.
        // A successful pass that dialled NOTHING still holds — that is the
        // reconnect bound above and it is unaffected.
        return result.status === 'ok' ? HOLD_BASE_CADENCE : ALLOW_IDLE_BACKOFF;
      },
    },
    {
      name: 'phone-reclaim',
      intervalMs: runtimeConfig.reclaimMs,
      tick: async () => {
        const result = await stores.reclaimAttemptLeases({
          limit: runtimeConfig.reclaimLimit,
          now: new Date(),
        });
        // The STATUS decides, not the count. `?? 0` alone would collapse
        // "the RPC did not answer with a count" into "nothing needed
        // doing" — and those are opposite operational facts. A sweep that
        // silently stopped running lets expired attempt leases accumulate,
        // each holding one of the ten fleet slots, until admission answers
        // `at_capacity` for every candidate: the exact failure 0042 says
        // this loop exists to prevent. `null` means we do not know.
        sweepNotOk.reclaim = result.status !== 'ok';
        lastReclaimed = result.status === 'ok' ? (result.reclaimed ?? 0) : null;
        // ── M-2: THE CADENCE IS THE CORRECTNESS BOUND ───────────────
        // `return (lastReclaimed ?? 0) > 0` was an idle signal, and the
        // steady state of this sweep is reclaiming nothing — so it settled
        // at the scheduler's 60s ceiling while `config.ts` claimed a 30s
        // sweep saw a lapsed lease within half a lease-lifetime. It did
        // not: a lapsed lease could go unreclaimed for a FULL
        // lease-lifetime. Held at the base cadence the claim is true again,
        // and it is asserted against the scheduler's observed interval
        // rather than against another config constant.
        //
        // M-7: gated on the STATUS, not returned outright. A sweep RPC that
        // answers a non-`ok` status does not throw, so an unconditional hold
        // kept a permanently broken sweep hammering the database at its base
        // cadence. `reclaimed: 0` under `status: 'ok'` is the idle steady
        // state this bound is about, and it still holds.
        return result.status === 'ok' ? HOLD_BASE_CADENCE : ALLOW_IDLE_BACKOFF;
      },
    },
    {
      name: 'phone-maintain',
      intervalMs: runtimeConfig.expireMs,
      tick: async () => {
        const expired = await stores.expireAppointments({
          limit: runtimeConfig.reclaimLimit,
          now: new Date(),
        });
        sweepNotOk.expire = expired.status !== 'ok';
        lastExpired = expired.status === 'ok' ? (expired.expired ?? 0) : null;
        return (lastExpired ?? 0) > 0;
      },
    },
    {
      // The dropped-webhook sweep, on its OWN loop and its own knob.
      //
      // It was briefly welded into `phone-maintain`, which made
      // `PHONE_RUNTIME_RECONCILE_MS` a knob that parsed, clamped, appeared
      // in `.env.example` and the environment schema — and changed nothing,
      // because the sweep ran at `expireMs`. A configuration value that
      // cannot move anything is worse than an absent one: an operator
      // turning it during an incident would believe they had acted.
      //
      // They are also genuinely different jobs. Expiring an appointment is
      // a cheap local UPDATE; reconciling reads LiveKit room state for
      // every live attempt, so it wants a slower cadence by default
      // (60s against 120s) and its own dial when a provider is flapping.
      name: 'phone-dayroll',
      intervalMs: runtimeConfig.expireMs,
      tick: async () => {
        // ── 0045: THE NO-ANSWER LADDER'S DAY BOUNDARY ────────────────
        // Transition #27 is the ONLY edge out of `awaiting_retry`, and
        // nothing in this repository had ever posted `day.rolled` — so the
        // FIRST unanswered call ended the ladder and the contract's "three
        // attempts on three distinct IST dates" was unreachable. This is
        // the driver 0042's header assigned to P5 and P5 did not ship.
        //
        // It runs on the EXPIRE cadence rather than a knob of its own: a
        // day boundary moves once a day, so anything under an hour is
        // already far more often than the thing it watches for.
        // M-7: a claim held by ANOTHER replica is a healthy answer and holds
        // the cadence, so this replica takes the claim over promptly when its
        // holder dies. A BROKEN claim is a persistent non-throwing failure —
        // a missed grant on `claim_phone_sweep` answers it on every tick for
        // ever — and must back off rather than hot-spin.
        const verdict = await claimed('dayroll');
        if (!applyClaim('dayroll', verdict)) {
          return verdict === 'theirs' ? HOLD_BASE_CADENCE : ALLOW_IDLE_BACKOFF;
        }
        const rolled = await stores.sweepDayRolled({
          limit: runtimeConfig.reclaimLimit,
          now: new Date(),
        });
        sweepNotOk.dayroll = rolled.status !== 'ok';
        lastRolled = rolled.status === 'ok' ? (rolled.rolled ?? 0) : null;
        return rolled.status === 'ok' ? HOLD_BASE_CADENCE : ALLOW_IDLE_BACKOFF;
      },
    },
    {
      name: 'phone-stranded',
      intervalMs: runtimeConfig.expireMs,
      tick: async () => {
        // ── 0045: ENGAGEMENTS POINTING AT AN ALREADY-ENDED SESSION ───
        // A screening that was conducted and SCORED, whose engagement was
        // moved out of `in_call` before the completion arrived, is
        // stranded: `ensureSession` finds a terminal session, refuses, and
        // the row is skipped `no_session` on every pass for ever. The
        // heartbeat removes the common cause; this removes the residue,
        // and it does so WITHOUT redialling anybody.
        // M-7: same pairing as the day roll — `theirs` holds, `broken` backs
        // off, and a sweep that answered a non-`ok` status backs off too.
        const verdict = await claimed('stranded');
        if (!applyClaim('stranded', verdict)) {
          return verdict === 'theirs' ? HOLD_BASE_CADENCE : ALLOW_IDLE_BACKOFF;
        }
        const resolved = await stores.sweepStrandedSessions({
          limit: runtimeConfig.reclaimLimit,
          now: new Date(),
        });
        sweepNotOk.stranded = resolved.status !== 'ok';
        lastStranded = resolved.status === 'ok'
          ? (resolved.completed ?? 0) + (resolved.failed ?? 0)
          : null;
        return resolved.status === 'ok' ? HOLD_BASE_CADENCE : ALLOW_IDLE_BACKOFF;
      },
    },
    {
      name: 'phone-recstrand',
      intervalMs: runtimeConfig.expireMs,
      tick: async () => {
        // ── 0071 / X5b: CRASHED SESSIONS WHOSE RECORDING NEVER FINALIZED ─
        // A worker crash posts no terminal session status, so a session sits
        // `in_progress` with a live egress and no object key and the 0038
        // finalize trigger — which fires only on a terminal transition —
        // never runs. `reclaim_phone_attempt_leases` (0071 §3) covers the
        // common case at lease loss; this is the backstop for anything it
        // cannot reach, and for legacy rows from before that shipped. It
        // drives such sessions to expired/grace_timeout so the trigger fires.
        // Idempotent (the terminal transition dedups on the 0038 job key) and
        // self-limiting (only the exact stuck shape, past a residency-derived
        // grace), so it rides the same bounded leader CLAIM as the other
        // sweeps. Runs on the EXPIRE cadence: the thing it watches for is a
        // dead call, which does not need sub-minute detection.
        // M-7: `theirs` holds, `broken`/non-`ok` backs off.
        const verdict = await claimed('recstrand');
        if (!applyClaim('recstrand', verdict)) {
          return verdict === 'theirs' ? HOLD_BASE_CADENCE : ALLOW_IDLE_BACKOFF;
        }
        const sweep = stores.sweepStrandedRecordings;
        if (typeof sweep !== 'function') {
          // A store double without the method: publish a truthful null rather
          // than a stale count, and idle-back-off.
          lastRecStranded = null;
          return ALLOW_IDLE_BACKOFF;
        }
        const resolved = await sweep({
          limit: runtimeConfig.reclaimLimit,
          now: new Date(),
        });
        sweepNotOk.recstrand = resolved.status !== 'ok';
        lastRecStranded = resolved.status === 'ok' ? (resolved.finalized ?? 0) : null;
        return resolved.status === 'ok' ? HOLD_BASE_CADENCE : ALLOW_IDLE_BACKOFF;
      },
    },
    {
      name: 'phone-partial-finalize',
      intervalMs: runtimeConfig.expireMs,
      tick: async () => {
        // ── 0072: DELIVER THE MP3 AND THE SCORECARD ON A DISCONNECT ─────
        // A candidate hangup / network drop / worker crash returns the voice
        // worker's non-terminal `disconnect` branch, leaving the session
        // `in_progress` forever. The 0038 trigger + 0071 sweep only fire on a
        // terminal status, and 0071 drives to `expired` after ~2h and NEVER
        // enqueues scoring — so today a disconnect produces neither MP3 nor
        // scorecard. This pass closes the gap with a SHORT reconnect grace
        // (default 180s, far below 0071's 7200s, so it wins the race).
        //
        // The RPC selects the ended-but-not-terminal sessions, drives each to
        // `completed`/`conversation_complete` (firing the MP3 promotion in its
        // own transaction), and RETURNS the coverage/attempt facts. This tick
        // then enqueues PARTIAL scoring per returned session — INDEPENDENTLY of
        // whether the transition landed on this pass, because a session whose
        // transition was skipped is still returned. The scorer reads
        // `transcript_turns` only; it never depends on the recording. So the two
        // guarantees hold separately: the MP3 comes from the trigger, the
        // scorecard from the queue, and neither blocks the other.
        //
        // Idempotent: re-running is safe (the transition is a no-op once
        // terminal, and the assessment dedup key makes a redundant enqueue a
        // no-op). Rides the same bounded leader CLAIM as the other sweeps, on
        // the EXPIRE cadence — a disconnect does not need sub-minute detection,
        // and the grace already dominates the latency.
        // M-7: `theirs` holds, `broken`/non-`ok` backs off.
        const verdict = await claimed('partialfin');
        if (!applyClaim('partialfin', verdict)) {
          return verdict === 'theirs' ? HOLD_BASE_CADENCE : ALLOW_IDLE_BACKOFF;
        }
        const finalize = stores.finalizePartialSessions;
        if (typeof finalize !== 'function') {
          // A store double without the method: publish a truthful null and
          // idle-back-off rather than throw on a tick no test happens to drive.
          lastPartialFinalized = null;
          return ALLOW_IDLE_BACKOFF;
        }
        const resolved = await finalize({
          limit: runtimeConfig.reclaimLimit,
          graceSeconds: runtimeConfig.partialFinalizeGraceSec,
          now: new Date(),
        });
        sweepNotOk.partialfin = resolved.status !== 'ok';
        if (resolved.status !== 'ok') {
          lastPartialFinalized = null;
          return ALLOW_IDLE_BACKOFF;
        }
        // Enqueue partial scoring for EVERY selected session, each in its own
        // try/catch so one enqueue failing never denies another session its
        // scorecard — and never denies the MP3, which the RPC already fired. An
        // enqueue that throws is retried on the next pass (the RPC re-selects
        // the same session until it carries an assessment).
        for (const s of resolved.sessions) {
          try {
            await queue.enqueue(
              PHONE_ASSESSMENT_QUEUE,
              {
                session_id: s.sessionId,
                attempt_id: s.attemptId,
                partial: true,
                covered: s.covered,
                total: s.total,
                disconnect_reason: s.disconnectReason,
              },
              { dedupKey: phoneAssessmentDedupKey(s.sessionId), maxAttempts: 5 },
            );
          } catch {
            // Best-effort: the next pass re-selects and re-enqueues. Do not let
            // one session's enqueue failure abort the loop for the others.
          }
          // Bounded, PII-free structured line. The logger allowlist carries
          // only `error_category`/`error_type` for this event, so coverage and
          // the two already-present signals are encoded into a single bounded,
          // SAFE_IDENT-shaped composite category (max 64 chars, no PII): e.g.
          // `phone_partial_finalize:c3:t5:mp3.1:sc.0`. `error_type` carries the
          // disconnect reason. No transcript, no candidate data, no session id.
          const cov = s.covered ?? -1;
          const tot = s.total ?? -1;
          logger.info('unknown_event', {
            error_category:
              `phone_partial_finalize:c${cov}:t${tot}` +
              `:mp3.${s.recordingPresent ? 1 : 0}:sc.${s.assessmentPresent ? 1 : 0}`,
            error_type: s.disconnectReason,
          });
        }
        lastPartialFinalized = resolved.finalized ?? 0;
        return HOLD_BASE_CADENCE;
      },
    },
    {
      name: 'phone-reconcile',
      intervalMs: runtimeConfig.reconcileMs,
      tick: async () => {
        // THE CLAIM BELONGS HERE MOST OF ALL. The migration names this loop
        // as the reason the claim table exists — it reads LiveKit room state
        // for every live attempt, so N replicas make N times the provider
        // calls — and for one commit it was the only sweep NOT behind it,
        // while two cheap local UPDATEs were.
        // M-7: `theirs` holds the cadence, `broken` backs off. The success
        // path below already answered on the count rather than outright.
        const verdict = await claimed('reconcile');
        if (!applyClaim('reconcile', verdict)) {
          return verdict === 'theirs' ? HOLD_BASE_CADENCE : ALLOW_IDLE_BACKOFF;
        }
        // Gated on the MASTER switch inside itself, not on the runtime
        // switch, because an operator who disarms the dialer mid-incident
        // must still be able to record events that TERMINATE in-flight
        // attempts.
        const reconciled = await runPhoneReconciliation(
          {
            config: loadLiveKitPhoneConfig(),
            attempts: createDuePhoneAttemptReader(client as never),
            rooms: createDefaultLiveKitRoomReader(
              credentials.url,
              credentials.apiKey,
              credentials.apiSecret,
            ),
            stores,
          },
          { now: new Date() },
        );
        // ── M-1: THE STATUS DECIDES HERE TOO ────────────────────────
        // `runPhoneReconciliation` answers `status: 'disabled'` with
        // `posted: 0` whenever `isPhoneWebhookActive` is false — the master
        // switch off, or LiveKit credentials unprovisioned. Reading the
        // count alone published `last_reconciled: 0` and no degrade reason
        // for a sweep that WAS NOT RUNNING, indistinguishable from "ran,
        // nothing to recover". It matters more here than for the other two
        // sweeps, because this sweep IS the dropped-webhook recovery: with
        // it silently off, an attempt whose webhook never arrives is
        // invisible until its lease lapses.
        //
        // AND `posted` COUNTS SUBMISSIONS, NOT LANDINGS. It is incremented
        // once per `applyEvent` CALL; the `outcomes` array carrying
        // `classifyApplyResult` — which is what says whether the ledger
        // `applied` or `ignored` the event — is discarded here. So
        // `last_reconciled` is "recovery events posted", never "recoveries
        // that landed", and an operator must not read it as the latter.
        sweepNotOk.reconcile = reconciled.status !== 'ok';
        lastReconciled = reconciled.status === 'ok' ? reconciled.posted : null;
        return (lastReconciled ?? 0) > 0;
      },
    },
  ];

  const scheduler = createLoopScheduler({
    ...(options.scheduler ?? {}),
    metricPrefix: 'phone',
    loops,
  });

  return {
    config: describePhoneRuntimeConfig(runtimeConfig),
    scheduler,
    runner,
    queue,
    loopIntervalsMs: Object.freeze(
      Object.fromEntries(loops.map((loop) => [loop.name, loop.intervalMs])),
    ),
    snapshot: () => ({
      lastDue,
      dialJobOutcomes: { ...dialJobOutcomes },
      lastReclaimed,
      lastExpired,
      lastReconciled,
      lastRolled,
      lastStranded,
      lastRecStranded,
      lastPartialFinalized,
      sweepNotOk: { ...sweepNotOk },
    }),
    async tickAll(): Promise<void> {
      await runner.tick();
    },
    async stop(): Promise<void> {
      await scheduler.stop();
      await runner.stop();
    },
  };
}
