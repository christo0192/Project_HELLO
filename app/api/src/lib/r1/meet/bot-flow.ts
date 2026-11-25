/**
 * Creating a booking's Recall bot (M034 S06, dark): `ensureBot`, the daily bot cap, the
 * Idempotency-Key rotation and the attach with its compensation (D-S06-13..16).
 *
 * ORDER, each step only after the one before (D-S06-13):
 *   1. a FRESH read of the booking; only `pending` creates (anything else already has, or must not
 *      have, a bot). The Idempotency-Key comes from this read's `version` and `key_attempt`: the read
 *      follows the last RPC that changed them, so the key is never older than the generation (S02
 *      section 10: never a value read before the last RPC);
 *   2. the round is live (one read). Not live: `pending -> failed/round_expired`, no Recall call;
 *   3. the late limit `min(end_at, start_at + 15 min)`: past it a bot would join an interview that is
 *      over or nearly so: `failed/bot_create_failed` + alert, no Recall call;
 *   4. the daily bot cap (D-S06-16), counted by the IST day of `start_at`: the bookings OF THAT DAY,
 *      other than this one, that used a bot. At the cap: `rotate_key` (`retireR1MeetCreateKey`), then
 *      `pending -> blocked/bot_cap_reached` + alert `r1_meet_bot_cap_reached`, no Recall call
 *      (maintenance re-drives it when the count drops or the cap is raised). Two creates racing for the
 *      last slot can overshoot by one: the count is a read, not a lock (stated in the PR);
 *   5. the S01 builder's body. When its `join_at` is less than 5 s ahead the same body is sent WITHOUT
 *      it (D-S06-15: Recall reads an absent join_at as "join now"; a past one is undocumented);
 *   6. `createBot` under `r1-meet-<event>-v<version>-k<key_attempt>`;
 *   7. `set_bot('attach')` with the same two counters.
 *
 * FAILURES OF THE CREATE (KNOWLEDGE 2026-11-21: Recall caches a keyed 4xx/5xx answer for an hour):
 *  - `rotateIdempotencyKey` (and ONLY then): `set_bot('rotate_key')` FIRST, before any deferral or
 *    failure is decided, so the next try cannot be answered from the cache. `key_attempts_exhausted`
 *    (20) fails the booking `bot_create_failed` + alert;
 *  - network, timeout, 409 in progress, 429, 507, 502/503/504 keep the key: the create may have
 *    happened, and the same key is what returns that bot instead of making a second one;
 *  - then: retriable -> defer; 401/402/403 -> alert and defer (`r1MeetRecallFailure`); any other 4xx
 *    (a 400 body Recall refuses) -> `failed/bot_create_failed` + alert; anything else throws.
 *
 * ATTACH REFUSALS (D-S06-14). `ok` and `duplicate` continue. The bot exists at Recall whatever the
 * database says next, so a bot we made must never be left to join and bill: `version_conflict`,
 * `not_allowed`, `bot_conflict`, `in_past`, `round_not_live` and `not_found` enqueue a `bot_release`
 * of it BEFORE anything else is decided (`in_past` then fails the booking `in_past`, `round_not_live`
 * fails it `round_expired`). `bot_in_use` (the bot belongs to another booking) alerts and is never
 * released: releasing it would end someone else's interview. Every S06 path that moves a booking out
 * of `pending` without a new generation (the cap here, `unschedule` in schedule-handler.ts) retires
 * the key first, so a released orphan can never come back from Recall's cache (S06-R2).
 *
 * A crash anywhere replays safely: before the create, nothing happened; between the create and the
 * attach, the same key returns the same bot from Recall's cache (one bot, not two); after the attach,
 * the booking is no longer `pending` and the re-run does nothing.
 */

import type { RecallCreateBotRequest } from '../../../integrations/recall/types.js';
import { isRecallError } from '../../../integrations/recall/errors.js';
import type { RecallBot } from '../../../integrations/recall/types.js';
import { armR1MeetCreateTicket, deriveR1MeetCreateTicket } from './arm.js';
import {
  R1MeetJobError,
  R1_MEET_DB_ERROR,
  R1_MEET_RPC_UNEXPECTED,
  r1MeetIgnored,
  r1MeetJobs,
  r1MeetProcessed,
  type R1MeetJobMeta,
  type R1MeetJobResult,
} from './jobs.js';
import { getR1MeetProfile } from './profiles.js';
import {
  R1_MEET_ALERTS,
  r1MeetRecallFailure,
  r1MeetRecallRejected,
  type R1MeetFlowDeps,
} from './recall-actions.js';
import { buildR1MeetCreateBotRequest, r1MeetCreateBotIdempotencyKey } from './recall-bot.js';
import {
  r1MeetIstDay,
  type R1MeetBooking,
  type R1MeetTransitionAnswer,
} from './runtime-store.js';
import { r1MeetBridgePageUrl, type MintedR1MeetTicket } from './ticket.js';

/** No bot is created once the slot is this far in (or the slot has ended, whichever is first). */
export const R1_MEET_LATE_CREATE_LIMIT_MS = 15 * 60 * 1000;
/** A `join_at` closer than this is dropped from the body: the bot joins at once. */
export const R1_MEET_MIN_JOIN_AT_LEAD_MS = 5_000;

const toIso = (ms: number): string => new Date(ms).toISOString();

/** The same body without `join_at`, for a bot that must join now. */
function joinNow(body: RecallCreateBotRequest): RecallCreateBotRequest {
  const { join_at: _joinAt, ...rest } = body;
  return rest;
}

/** A transition someone else won, or a booking that disappeared: the other writer decided. */
function settledElsewhere(answer: Exclude<R1MeetTransitionAnswer, { status: 'ok' }>): R1MeetJobResult {
  if (answer.status === 'status_conflict') return r1MeetIgnored('status_conflict');
  if (answer.status === 'not_found') return r1MeetIgnored('booking_gone');
  // invalid_transition / invalid_request: this code asked for a move 0142 does not have.
  throw new R1MeetJobError(R1_MEET_RPC_UNEXPECTED);
}

/** `pending -> failed/<reason>`. */
async function failPending(
  deps: R1MeetFlowDeps,
  booking: R1MeetBooking,
  reason: 'round_expired' | 'bot_create_failed' | 'in_past',
): Promise<R1MeetJobResult> {
  const answer = await deps.store.transition({
    bookingId: booking.id,
    from: 'pending',
    to: 'failed',
    reason,
    nowIso: toIso(deps.now()),
  });
  return answer.status === 'ok' ? r1MeetProcessed(reason) : settledElsewhere(answer);
}

/**
 * Retire a `pending` booking's Idempotency-Key BEFORE the booking leaves `pending` with its counters
 * unchanged (a schedule update blocks it, or the daily cap does): PR #444 review S06-R2. A create of
 * another run may be in flight under that key; its attach is then refused and its bot released. Had
 * the key stayed, a booking that came back to `pending` within the hour (the same slot keeps both
 * counters) would be answered from Recall's cache with that DELETED bot, attach it, and never get a
 * call. `rotated` = the move may go on; `moved` = the booking changed meanwhile (re-read it);
 * `exhausted` = 20 key attempts are spent (the caller fails the booking `bot_create_failed`).
 */
export async function retireR1MeetCreateKey(
  deps: Pick<R1MeetFlowDeps, 'store' | 'now'>,
  booking: Pick<R1MeetBooking, 'id' | 'version' | 'keyAttempt'>,
): Promise<'rotated' | 'moved' | 'exhausted'> {
  const answer = await deps.store.setBot({
    bookingId: booking.id,
    action: 'rotate_key',
    expectedVersion: booking.version,
    expectedKeyAttempt: booking.keyAttempt,
    nowIso: toIso(deps.now()),
  });
  switch (answer.status) {
    case 'ok':
      return 'rotated';
    case 'key_attempts_exhausted':
      return 'exhausted';
    case 'version_conflict':
    case 'not_allowed':
    case 'not_found':
      return 'moved';
    default:
      throw new R1MeetJobError(R1_MEET_RPC_UNEXPECTED);
  }
}

/** Is the cap reached for the IST day of this booking's slot? A count the store cannot give fails closed. */
export async function r1MeetCapReached(
  deps: Pick<R1MeetFlowDeps, 'store' | 'config'>,
  booking: Pick<R1MeetBooking, 'id' | 'startAt'>,
): Promise<boolean> {
  const day = r1MeetIstDay(booking.startAt);
  if (day === null) throw new R1MeetJobError(R1_MEET_DB_ERROR);
  const used = await deps.store.countBotsInDay({ from: day.from, to: day.to, excludeId: booking.id });
  return used >= deps.config.dailyBotCap;
}

/**
 * Create and attach the bot of a `pending` booking (see the header). Safe to call twice at once:
 * both creates share one key, so Recall makes one bot, and the second attach answers `duplicate`.
 */
export async function ensureBot(
  deps: R1MeetFlowDeps,
  bookingId: string,
  meta: Pick<R1MeetJobMeta, 'deferCount' | 'deferredAt'>,
): Promise<R1MeetJobResult> {
  const booking = await deps.store.getBooking(bookingId);
  if (booking === null) return r1MeetIgnored('booking_gone');
  if (booking.status !== 'pending') return r1MeetIgnored('not_pending');

  if (booking.roundId === null || !(await deps.store.roundLive(booking.roundId, deps.now()))) {
    return failPending(deps, booking, 'round_expired');
  }

  const nowMs = deps.now();
  const startMs = Date.parse(booking.startAt);
  const lateLimitMs = Math.min(Date.parse(booking.endAt), startMs + R1_MEET_LATE_CREATE_LIMIT_MS);
  if (nowMs >= lateLimitMs) {
    deps.log.error({ error_category: R1_MEET_ALERTS.botCreateFailed, error_type: 'too_late' });
    return failPending(deps, booking, 'bot_create_failed');
  }

  if (await r1MeetCapReached(deps, booking)) {
    // A concurrent run may have created under this key: retire it before the booking leaves pending.
    const retired = await retireR1MeetCreateKey(deps, booking);
    if (retired === 'moved') return r1MeetIgnored('status_conflict');
    if (retired === 'exhausted') {
      deps.log.error({ error_category: R1_MEET_ALERTS.botCreateFailed, error_type: 'key_attempts_exhausted' });
      return failPending(deps, booking, 'bot_create_failed');
    }
    const answer = await deps.store.transition({
      bookingId: booking.id,
      from: 'pending',
      to: 'blocked',
      reason: 'bot_cap_reached',
      nowIso: toIso(deps.now()),
    });
    if (answer.status !== 'ok') return settledElsewhere(answer);
    deps.log.error({ error_category: R1_MEET_ALERTS.botCapReached });
    return r1MeetProcessed('bot_cap_reached');
  }

  const profile = getR1MeetProfile(booking.objectiveProfile);
  if (profile === null) {
    deps.log.error({ error_category: R1_MEET_ALERTS.profileUnknown });
    throw new R1MeetJobError(R1_MEET_ALERTS.profileUnknown);
  }

  // At-create mode: the page goes into the body, with the ticket derived from this generation.
  let createTicket: MintedR1MeetTicket | null = null;
  let outputMediaUrl: string | null = null;
  if (deps.config.armAtCreate) {
    createTicket = deriveR1MeetCreateTicket(deps, booking, profile.botJoinLeadSec, nowMs);
    outputMediaUrl = createTicket === null ? null : r1MeetBridgePageUrl(deps.config.bridgePageUrl, createTicket.ticket);
    if (outputMediaUrl === null) createTicket = null;
  }

  const built = buildR1MeetCreateBotRequest(
    profile.id,
    { bookingId: booking.id, meetingUrl: booking.meetUrl, slotStart: booking.startAt },
    {
      realtimeWebhookUrl: deps.config.recallRealtimeWebhookUrl,
      botNameOverride: deps.config.botNameOverride,
      googleLoginGroupId: deps.config.recall.googleLoginGroupId,
      outputMediaUrl,
    },
  );
  if (!built.ok) {
    // A booking 0142 accepted cannot fail the builder; the configuration can (and would for all).
    deps.log.error({ error_category: R1_MEET_ALERTS.botCreateFailed, error_type: built.reason });
    throw new R1MeetJobError('r1_meet_bot_body_invalid');
  }
  const body = Date.parse(built.joinAt) - nowMs >= R1_MEET_MIN_JOIN_AT_LEAD_MS ? built.body : joinNow(built.body);
  const idempotencyKey = r1MeetCreateBotIdempotencyKey(booking.eventId, booking.version, booking.keyAttempt);

  let bot: RecallBot;
  try {
    bot = await deps.recall.createBot(body, { idempotencyKey });
  } catch (error) {
    return createFailed(deps, booking, error, meta);
  }
  return attach(deps, booking, bot.id, createTicket);
}

/** The create failed: rotate the key when Recall cached the answer, then decide (see the header). */
async function createFailed(
  deps: R1MeetFlowDeps,
  booking: R1MeetBooking,
  error: unknown,
  meta: Pick<R1MeetJobMeta, 'deferCount' | 'deferredAt'>,
): Promise<R1MeetJobResult> {
  if (!isRecallError(error)) throw error;
  if (error.rotateIdempotencyKey) {
    const rotated = await deps.store.setBot({
      bookingId: booking.id,
      action: 'rotate_key',
      expectedVersion: booking.version,
      expectedKeyAttempt: booking.keyAttempt,
      nowIso: toIso(deps.now()),
    });
    if (rotated.status === 'key_attempts_exhausted') {
      deps.log.error({ error_category: R1_MEET_ALERTS.botCreateFailed, error_type: 'key_attempts_exhausted' });
      return failPending(deps, booking, 'bot_create_failed');
    }
    if (rotated.status === 'invalid_action' || rotated.status === 'invalid_request') {
      throw new R1MeetJobError(R1_MEET_RPC_UNEXPECTED);
    }
    // Another run moved the booking on (it rotated, attached or replaced first): it owns the next step.
    if (rotated.status !== 'ok') return r1MeetIgnored(`rotate_${rotated.status}`);
  }
  if (error.retriable || r1MeetRecallRejected(error)) {
    return r1MeetRecallFailure(error, { meta, nowMs: deps.now(), log: deps.log });
  }
  if (error.httpStatus !== null && error.httpStatus >= 400 && error.httpStatus <= 499) {
    deps.log.error({
      error_category: R1_MEET_ALERTS.botCreateFailed,
      error_type: error.category,
      http_status: error.httpStatus,
    });
    return failPending(deps, booking, 'bot_create_failed');
  }
  return r1MeetRecallFailure(error, { meta, nowMs: deps.now(), log: deps.log });
}

/** Record the bot on the booking; release it when the booking cannot take it (D-S06-14). */
async function attach(
  deps: R1MeetFlowDeps,
  booking: R1MeetBooking,
  botId: string,
  createTicket: MintedR1MeetTicket | null,
): Promise<R1MeetJobResult> {
  const answer = await deps.store.setBot({
    bookingId: booking.id,
    action: 'attach',
    recallBotId: botId,
    expectedVersion: booking.version,
    expectedKeyAttempt: booking.keyAttempt,
    nowIso: toIso(deps.now()),
  });
  switch (answer.status) {
    case 'ok':
    case 'duplicate':
      if (createTicket !== null) await armR1MeetCreateTicket(deps, booking.id, createTicket, toIso(deps.now()));
      return r1MeetProcessed('bot_scheduled');
    case 'bot_in_use':
      deps.log.error({ error_category: R1_MEET_ALERTS.botInUse });
      return r1MeetIgnored('attach_bot_in_use');
    case 'version_conflict':
    case 'not_allowed':
    case 'bot_conflict':
    case 'in_past':
    case 'round_not_live':
    case 'not_found':
      // An orphan: ours, at Recall, on no booking. Its release is queued before anything else.
      await deps.enqueue(r1MeetJobs.botRelease(botId, booking.id));
      if (answer.status === 'in_past') return failPending(deps, booking, 'in_past');
      if (answer.status === 'round_not_live') return failPending(deps, booking, 'round_expired');
      return r1MeetIgnored(`attach_${answer.status}`);
    default:
      throw new R1MeetJobError(R1_MEET_RPC_UNEXPECTED);
  }
}
