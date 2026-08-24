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
 * ── FOUR LOOPS, AND WHY EACH ONE IS LOAD-BEARING ──────────────────────
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

import type { SupabaseClient } from '@supabase/supabase-js';
import { Queue } from '../queue/index.js';
import { PgAdapter } from '../queue/pg-adapter.js';
import { createQueueRunner, type QueueRunnerHandle } from '../queue/runner.js';
import { createLoopScheduler, queueRunnerTick, type LoopSchedulerHandle } from '../scheduler.js';
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
  describePhoneRuntimeConfig,
  loadPhoneRuntimeConfig,
  type PhoneRuntimeConfig,
} from './config.js';
import { createPhoneDialHandler, type PhoneDialJobOutcome } from './dial-handler.js';
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
  const owner = options.owner ?? `phone-${process.pid}`;
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
  const sweepNotOk: Record<string, boolean> = { reclaim: false, expire: false };

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
  const admitsClaims = async (): Promise<boolean> => {
    const nowMs = Date.now();
    if (haltCheckedAtMs !== 0 && nowMs - haltCheckedAtMs < HALT_CACHE_MS) return haltAdmits;
    haltCheckedAtMs = nowMs;
    try {
      const backlog = await stores.backlog({ now: new Date() });
      // The SAME three-shape test the due pass applies: an explicit halt, an
      // absent control singleton, and (via the catch) an unreadable one all
      // mean stop. Written as an equality against `false`/`true` rather than
      // a negation so an `undefined` field cannot read as permission.
      haltAdmits = backlog.admission?.halted === false
        && backlog.admission?.controlPresent === true;
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

  const scheduler = createLoopScheduler({
    ...(options.scheduler ?? {}),
    metricPrefix: 'phone',
    loops: [
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
                  return result.refusal === undefined
                    ? { status: result.status }
                    : { status: result.status, refusal: result.refusal };
                },
              },
            },
            { now, limit: runtimeConfig.dueLimit },
          );
          lastDue = result;
          return result.dialing > 0;
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
          return (lastReclaimed ?? 0) > 0;
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
        name: 'phone-reconcile',
        intervalMs: runtimeConfig.reconcileMs,
        tick: async () => {
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
          lastReconciled = reconciled.posted;
          return reconciled.posted > 0;
        },
      },
    ],
  });

  return {
    config: describePhoneRuntimeConfig(runtimeConfig),
    scheduler,
    runner,
    queue,
    loopIntervalsMs: {
      'phone-dial': runtimeConfig.dueMs,
      'phone-due': runtimeConfig.dueMs,
      'phone-reclaim': runtimeConfig.reclaimMs,
      'phone-maintain': runtimeConfig.expireMs,
      'phone-reconcile': runtimeConfig.reconcileMs,
    },
    snapshot: () => ({
      lastDue,
      dialJobOutcomes: { ...dialJobOutcomes },
      lastReclaimed,
      lastExpired,
      lastReconciled,
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
