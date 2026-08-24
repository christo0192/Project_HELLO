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
 * the other side of the gate is a telephone call to a person. `shouldClaim`
 * here is therefore NOT the recording pattern, and the difference is the point.
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
import { createPhoneRuntimeReader, PHONE_SESSION_MODE, type PhoneRuntimeReader } from './read.js';
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
export function createPhoneSessionPort(reader: PhoneRuntimeReader): PhoneSessionPort {
  return {
    async ensureSession(input): Promise<string | null> {
      if (input.existingSessionId !== null) return input.existingSessionId;

      const adopted = await reader.findReusableSession({ candidateId: input.candidateId });
      if (adopted !== null) return adopted;

      const created = await createSession({
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
      const moved = await transitionSession(
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

  const credentials = {
    url: env.livekitUrl,
    apiKey: env.livekitApiKey,
    apiSecret: env.livekitApiSecret,
  };
  const roomClients = createPhoneRoomClients(credentials, dialConfig.agentName);

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
          lastReclaimed = result.reclaimed ?? 0;
          return (result.reclaimed ?? 0) > 0;
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
          lastExpired = expired.expired ?? 0;
          return (expired.expired ?? 0) > 0;
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
