/**
 * livekit-phone/reconciliation.ts — bounded recovery for a DROPPED webhook.
 *
 * ── THE FAILURE THIS EXISTS FOR ───────────────────────────────────────
 * A phone attempt is admitted, the SIP leg comes up, the call ends — and the
 * `participant_left` webhook never arrives. The attempt stays live and holds
 * one of the ten fleet slots for the remainder of its lease.
 *
 * This is NOT the "engagement stranded forever" failure: 0042's
 * `reclaim_phone_attempt_leases` already restores the engagement from
 * `dialing`/`in_call` back to `prior_engagement_state` once the lease lapses,
 * and its comment says so explicitly. What reclaim CANNOT do is decide the
 * OUTCOME — it abandons the attempt with `outcome_class = null`, because a
 * lapsed lease means our worker died and it has no idea what happened on the
 * call. This sweep exists for the OTHER case: the worker is alive and holding
 * its lease, and only the webhook was lost. Then LiveKit still knows, so we
 * ask it, and we can post a truthful outcome instead of an abandonment.
 *
 * ── THE TWO SWEEPERS MUST NOT OVERLAP ─────────────────────────────────
 * That distinction is load-bearing, not descriptive. Reclaim charges NO
 * budget; the outcomes this sweep posts DO charge (`no_answer`, `reconnect`).
 * If this sweep touched an attempt whose lease had already expired, a crash
 * of OURS would spend a candidate's anti-harassment budget — three of them
 * would drive an engagement to `abandoned_no_answer` for our own downtime.
 * So the due-attempt reader requires the lease to still be HELD, and expired
 * leases are left entirely to the reclaimer.
 *
 * ── WHAT IT MAY DO, BY CONSTRUCTION ───────────────────────────────────
 * It reads room membership through a read-only port and posts ONE 0042 event
 * per recovered attempt through the same audited RPC the webhook uses. It
 * cannot dial, originate, transfer, mutate a room or remove a participant —
 * neither port exposes such a method. It never reads a phone number: the only
 * participant field it looks at is the `phone-<attempt uuid>` identity.
 *
 * ── WHY IT IS SAFE TO RUN TWICE ───────────────────────────────────────
 * Every post carries a DETERMINISTIC `provider_event_id` —
 * `recon:<attempt>:<event>:<epoch>` — so a second sweep reaching the same
 * conclusion collides on `uq_phone_call_events_provider` and reads back the
 * FIRST verdict instead of writing a second row. The epoch is in the id AND
 * passed as the fencing token, so a sweep that races a new conversation is
 * recorded as `stale_epoch` rather than applied to the wrong call.
 *
 * ── WHY THE AGE FLOOR IS DERIVED, NOT CONFIGURED ──────────────────────
 * Concluding "the leg never came up" before the ring timeout has elapsed would
 * manufacture a no-answer for a call that is still ringing. So the floor is
 * derived from `PHONE_RING_TIMEOUT_SECONDS` — the same knob that bounds the
 * ring — rather than from an independent number that could drift below it.
 *
 * Disabled ⇒ this function reads nothing and returns a zero-work result.
 */

import type { PhoneStores } from '../../lib/phone-screening/index.js';
import { isPhoneWebhookActive, type LiveKitPhoneConfig } from './config.js';
import {
  classifyApplyResult,
  phoneIngressHealth,
  type PhoneIngressHealth,
  type PhoneIngressOutcome,
} from './ingress.js';
import type { DuePhoneAttempt, DuePhoneAttemptReader, LiveKitRoomReader } from './ports.js';

/** Hard bounds. A caller may narrow these; it cannot widen them. */
export const PHONE_RECONCILE_BOUNDS = {
  /** Attempts examined per sweep. */
  limit: { def: 25, min: 1, max: 50 },
  /** Multiplier applied to the ring timeout to derive the minimum age. */
  ringTimeoutMultiplier: 2,
  /** Absolute floor on the minimum age, whatever the ring timeout says. */
  minAgeSeconds: { min: 60, max: 900 },
  /** How far back a sweep will look. Older attempts are the reclaimer's. */
  lookbackSeconds: { def: 21600, min: 900, max: 86400 },
} as const;

function clamp(value: number | undefined, bounds: { def?: number; min: number; max: number }): number {
  const fallback = bounds.def ?? bounds.min;
  if (typeof value !== 'number' || !Number.isFinite(value)) return fallback;
  return Math.min(bounds.max, Math.max(bounds.min, Math.trunc(value)));
}

/**
 * The minimum age an attempt must reach before this sweep will draw any
 * conclusion from LiveKit's silence.
 */
export function reconcileMinAgeSeconds(ringTimeoutSeconds: number): number {
  const derived = ringTimeoutSeconds * PHONE_RECONCILE_BOUNDS.ringTimeoutMultiplier;
  return clamp(derived, PHONE_RECONCILE_BOUNDS.minAgeSeconds);
}

/**
 * Attempt states that mean the SIP leg had NOT yet been answered.
 *
 * `dialing` is an ENGAGEMENT state and it outlives the answer: 0042's #14
 * ("join is not answer") moves the ATTEMPT to `answered_unclassified` and the
 * engagement nowhere, and `classify.human` moves the attempt to `human`, again
 * with no engagement change. So the engagement state alone cannot tell an
 * unanswered call from an answered one.
 */
const PRE_ANSWER_ATTEMPT_STATES: ReadonlySet<string> = new Set(['admitted', 'ringing']);

/**
 * The event a missing participant implies — decided from BOTH the engagement
 * state and the attempt state.
 *
 * Only two engagement states have a legal edge in 0042, and each has exactly
 * one. Every other case returns null and the attempt is left alone: inventing
 * an edge 0042 would refuse produces an `unexpected_event` row and a
 * misleading audit trail, and inventing the WRONG one is worse than that.
 *
 * The `dialing` case is gated on the attempt being pre-answer. Reporting
 * `sip.originate_timeout` for an attempt already sitting in
 * `answered_unclassified` or `human` would record a demonstrably ANSWERED call
 * as `no_answer` and charge the anti-harassment budget for it — the candidate
 * would then be re-dialled the next IST day on the strength of a call they had
 * actually picked up.
 *
 * An ANSWERED `dialing` attempt (`answered_unclassified` / `human`) whose
 * participant is gone is reported as what it is — the participant left — and
 * 0114 decides (M009 PR-C, C1). This sweep cannot see whether the leg was a
 * CONTINUATION of a consented, live, planned session (a reconnect leg whose
 * `consent.resumed` was not recorded); the ledger can. For such a leg 0114's
 * drop-race branch charges the reconnect a consented candidate is owed (#19,
 * #21 budget exhausted, #20 window closed). For any other answered leg 0114
 * records this `reconciliation` post as `unexpected_event` and changes
 * nothing, so a pre-consent drop keeps today's path (the worker's own
 * departure post, else reclaim, charging nobody). Without this mapping the
 * drop-race branch had no production producer: the webhook is not delivered in
 * production, and the worker posts no drop after consent (R4). `machine` keeps
 * null: a classified machine has no conversation to continue.
 */
const ANSWERED_ATTEMPT_STATES: ReadonlySet<string> = new Set(['answered_unclassified', 'human']);

export function recoveredEventType(
  engagementState: string,
  attemptState: string,
): string | null {
  if (engagementState === 'in_call') return 'sip.participant_left';
  if (engagementState === 'dialing' && PRE_ANSWER_ATTEMPT_STATES.has(attemptState)) {
    return 'sip.originate_timeout';
  }
  if (engagementState === 'dialing' && ANSWERED_ATTEMPT_STATES.has(attemptState)) {
    return 'sip.participant_left';
  }
  return null;
}

/** The deterministic id that makes a repeated sweep a no-op. */
export function reconcileProviderEventId(
  attemptId: string,
  eventType: string,
  epoch: number,
): string {
  return `recon:${attemptId}:${eventType}:${epoch}`;
}

/**
 * M013 S02 (T04): the room a due attempt's leg lives in.
 *
 * The attempt's own `room_name` wins. A RECONNECT leg was historically
 * admitted with `room_name` NULL although it joins the session's room
 * (9f60523d leg 2: answered, dropped, and invisible to this sweep, so the
 * lease reclaim ended it ~6 minutes later with no outcome). 0118 now stamps
 * `room_name` whenever `session_id` is bound; this fallback covers a row the
 * stamp has not reached. It applies ONLY to a BOUND attempt: an unbound
 * attempt never reached a session room and stays `no_room`.
 *
 * The name mirrors `phoneRoomName` (livekit-phone-dial/phone-room.ts), which
 * is not imported: that module pulls room provisioning — and with it a static
 * LiveKit SDK import plus the env and Supabase client — into this module's
 * graph, which the P3 structural suite forbids. A test pins the two equal.
 */
export function reconcileRoomName(
  attempt: Pick<DuePhoneAttempt, 'roomName' | 'sessionId'>,
): string | null {
  if (attempt.roomName !== null && attempt.roomName.length > 0) return attempt.roomName;
  const sessionId = attempt.sessionId;
  if (typeof sessionId === 'string' && sessionId.length > 0) return `phone-${sessionId}`;
  return null;
}

/**
 * True iff LiveKit's rejection says the ROOM does not exist: a Twirp
 * `not_found`, an HTTP 404, or the server's literal "requested room does not
 * exist". Mirrors `isRoomNotFound` in livekit-phone-dial/dial.ts (not
 * imported, for the module-graph reason above); a test pins them equal.
 */
export function isReconcileRoomNotFound(err: unknown): boolean {
  if (err === null || typeof err !== 'object') return false;
  const e = err as { code?: unknown; status?: unknown; statusCode?: unknown; message?: unknown };
  if (typeof e.code === 'string' && e.code.toLowerCase() === 'not_found') return true;
  if (e.status === 404 || e.statusCode === 404) return true;
  return typeof e.message === 'string' && /requested room does not exist/i.test(e.message);
}

export type PhoneReconcileSkip =
  | 'no_room'
  | 'participant_present'
  | 'state_not_recoverable'
  | 'room_read_failed'
  // M013 S02: a PRE-ANSWER leg whose room LiveKit does not know. The room
  // may simply not exist yet (provisioning races the ring), so a missing
  // room is no evidence the call ended — say nothing.
  | 'room_not_found_pre_answer';

export interface PhoneReconcileResult {
  readonly status: 'disabled' | 'ok';
  readonly examined: number;
  readonly posted: number;
  readonly skipped: Readonly<Record<string, number>>;
  readonly outcomes: ReadonlyArray<PhoneIngressOutcome>;
}

export interface PhoneReconcileDeps {
  readonly config: LiveKitPhoneConfig;
  readonly attempts: DuePhoneAttemptReader;
  readonly rooms: LiveKitRoomReader;
  readonly stores: Pick<PhoneStores, 'applyEvent'>;
  readonly health?: PhoneIngressHealth;
}

export interface PhoneReconcileOptions {
  /** Injected instant. The sweep never reads the machine clock itself. */
  readonly now: Date;
  readonly limit?: number;
  readonly lookbackSeconds?: number;
}

const ZERO_WORK: PhoneReconcileResult = Object.freeze({
  status: 'disabled',
  examined: 0,
  posted: 0,
  skipped: Object.freeze({}),
  outcomes: Object.freeze([]),
});

/**
 * Run one bounded sweep. Never throws for a per-attempt failure: a room read
 * that fails is counted and skipped, so one unreachable room cannot abort the
 * sweep for every other attempt.
 */
export async function runPhoneReconciliation(
  deps: PhoneReconcileDeps,
  options: PhoneReconcileOptions,
): Promise<PhoneReconcileResult> {
  // Disabled or unconfigured: no read, no post, no network call.
  if (!isPhoneWebhookActive(deps.config)) return ZERO_WORK;

  const health = deps.health ?? phoneIngressHealth;
  const now = options.now;
  const limit = clamp(options.limit, PHONE_RECONCILE_BOUNDS.limit);
  const lookback = clamp(options.lookbackSeconds, PHONE_RECONCILE_BOUNDS.lookbackSeconds);
  const minAge = reconcileMinAgeSeconds(deps.config.phone.ringTimeoutSeconds);

  const due = await deps.attempts.listDueAttempts({
    admittedBefore: new Date(now.getTime() - minAge * 1000),
    admittedAfter: new Date(now.getTime() - lookback * 1000),
    // Still-held leases only — the reclaimer owns the expired ones.
    leaseHeldAt: now,
    limit,
  });

  const skipped: Record<string, number> = {};
  const outcomes: PhoneIngressOutcome[] = [];
  let posted = 0;
  const skip = (reason: PhoneReconcileSkip): void => {
    skipped[reason] = (skipped[reason] ?? 0) + 1;
  };

  // The reader is already bounded, but a reader that ignores `limit` must not
  // be able to widen the sweep — the slice is the enforcement.
  const examined = due.slice(0, limit);

  for (const attempt of examined) {
    const eventType = recoveredEventType(attempt.engagementState, attempt.attemptState);
    if (eventType === null) {
      skip('state_not_recoverable');
      continue;
    }
    const roomName = reconcileRoomName(attempt);
    if (roomName === null) {
      skip('no_room');
      continue;
    }

    let participants: ReadonlyArray<{ identity: string }>;
    try {
      participants = await deps.rooms.listParticipants(roomName);
    } catch (err) {
      if (!isReconcileRoomNotFound(err)) {
        // Unknown is not absent. Say nothing rather than manufacture an ending.
        skip('room_read_failed');
        continue;
      }
      // M013 S02: the room is GONE. For an ANSWERED leg that is proof the leg
      // ended (LiveKit deletes an emptied room after its empty timeout), so it
      // is treated exactly like "our participant is not in the room". For a
      // pre-answer leg it proves nothing — the room may not exist yet — so the
      // sweep stays silent rather than post a false `sip.originate_timeout`.
      if (eventType !== 'sip.participant_left') {
        skip('room_not_found_pre_answer');
        continue;
      }
      participants = [];
    }

    const stillPresent = participants.some((p) => p.identity === `phone-${attempt.attemptId}`);
    if (stillPresent) {
      skip('participant_present');
      continue;
    }

    const result = await deps.stores.applyEvent({
      source: 'reconciliation',
      eventType,
      attemptId: attempt.attemptId,
      providerEventId: reconcileProviderEventId(attempt.attemptId, eventType, attempt.epoch),
      epoch: attempt.epoch,
      metadata: { recon_event: eventType },
      now,
    });
    posted += 1;
    outcomes.push(classifyApplyResult(result, health));
  }

  return { status: 'ok', examined: examined.length, posted, skipped, outcomes };
}

export type { DuePhoneAttempt };
