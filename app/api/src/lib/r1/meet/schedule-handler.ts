/**
 * The booking side of the `r1-meet` runtime (M034 S06, dark): what an Ashby interview-schedule job
 * does to a booking and its Recall bot, the delayed re-runs, and the two cleanup kinds the 0142
 * triggers queue. Five job definitions: `ashby_schedule`, `booking_rerun`, `ensure_bot`,
 * `bot_release` and `round_cancelled` (plan sections 2.4 and 2.5, D-S06-7..10 and 17..21).
 *
 * ORDERING (D-S06-7). Retries reorder jobs, so before it acts an `ashby_schedule` job asks the
 * receipts whether a NEWER delivery of the same schedule exists; if so it is dropped (`superseded`):
 * every delivery carries the whole schedule, so the newer one decides. The RPCs' own `stale_update`
 * is the second line, and the reconcile skips a booking whose stored `ashby_updated_at` is newer.
 *
 * ELIGIBLE (plan 2.4). The create RPC first, always: it is the one place that knows whether the event
 * has a booking, and it answers `exists` without writing when it has. Then:
 *   created / relinked (rebound or not)  -> `ensureBot` (bot-flow.ts);
 *   exists, same slot                    -> pending: `ensureBot`; blocked: reschedule (same slot),
 *                                           then `ensureBot`; holding a bot: nothing (`unchanged`);
 *   exists, moved                        -> the new start must be in the future BEFORE any Recall
 *                                           call; a dispatched bot HOLDS (D-S06-19); else Recall
 *                                           release -> set_bot('replace') -> reschedule with the
 *                                           version replace answered -> create -> attach. Never a
 *                                           PATCH (D-S06-10): 0142 refuses to reschedule while a
 *                                           bot is attached, so a patched bot could not be recorded;
 *   blocked / unmatched / unmapped       -> stored by the RPC; a bounded delayed re-run for the
 *                                           reasons that can clear by themselves (D-S06-18);
 *   bot_attached                         -> the booking is being revived or re-bound while it
 *                                           still holds a bot: release it, then ask again.
 * A reschedule to a slot more than 14 days out (`slot_too_far`) writes nothing, and a delayed job may
 * never carry a Meet URL, so the booking is failed (`round_expired`) and the create RPC replayed with
 * the new slot: 0142 revives a failed, bot-less booking into `blocked/slot_too_far` with the slot and
 * link stored, and the re-run at `retry_after` carries the booking id only (D-S06-17).
 *
 * HOLDING (D-S06-19). A bot already sent to its call is never pulled by a schedule job. A MOVE
 * defers 300 s, within the shared deferral bound, so that once the old call has ended (the booking
 * is then `failed`) the same job revives the booking on the new slot. `not_scheduled`,
 * `no_attester` and `no_meet_link` answer `held_dispatched`; `in_past` always holds (S01: a status
 * flip or a dropped link during or after the call never ends a live interview).
 *
 * CANCEL (D-S06-20): Recall first (one GET, then DELETE or leave_call), then the cancel RPC, then
 * set_bot('release'). If Recall stays unreachable past the deferral bound, the booking is cancelled
 * anyway and keeps its bot as an OWED release (alert `r1_meet_release_owed`; maintenance retries):
 * an outage must not keep a cancelled interview live in our database for ever.
 *
 * RECONCILE (D-S06-21, S03 R11) runs after the main action, even when the main action deferred or
 * threw, and the worst outcome is answered at the end (a throw, then a deferral, then work done).
 *
 * RETRY POINTS (plan 2.5): every destructive path acts at Recall first and marks the database
 * second, and re-reads the booking at its start, so a run killed after any step replays into the
 * same end state with one live bot at most.
 *
 * PUBLIC-PAGE BOOKINGS (M035). A booking the candidate made on the public R1 booking page (source
 * `public_page`) has no Ashby schedule: no event, schedule or scheduler id. The Ashby paths refuse it:
 * a `booking_rerun` of one answers `ignored('public_booking')` before the reason check and before any
 * RPC (the public booking RPC never parks a booking, so no re-run is ever owed to one), and the create
 * RPC's stored-delivery replay (`sourceFromBooking`) takes an Ashby booking only, so the Ashby create
 * RPC can never be called with a public one. The three places that act on a booking id the Ashby
 * create RPC answered (`existing`, `detachForReplay`, the `in_past` answer) refuse a public booking the
 * same way: unreachable by the 0142 event-id lookup, defence in depth. The event and schedule reads
 * (`unschedule`, the reconcile) only ever see Ashby bookings (the store says so). `ensure_bot`,
 * `bot_release` and `round_cancelled` act on both sources alike.
 *
 * LOGS: alerts only (`R1_MEET_ALERTS`), closed words. Never an id, a name, an email, a Meet URL.
 * Loading this module performs no I/O: everything arrives in `R1MeetFlowDeps`.
 */

import { isRecallError } from '../../../integrations/recall/errors.js';
import type { R1MeetBookingReason, R1MeetBookingStatus } from './bookings-read.js';
import { ensureBot, r1MeetCapReached, retireR1MeetCreateKey } from './bot-flow.js';
import {
  R1MeetJobError,
  R1_MEET_RERUN_MAX_N,
  R1_MEET_RERUN_REASONS,
  R1_MEET_RPC_UNEXPECTED,
  canDeferR1MeetJob,
  parseAshbyScheduleJob,
  parseBookingRerunJob,
  parseBotReleaseJob,
  parseEnsureBotJob,
  parseRoundCancelledJob,
  r1MeetDefer,
  r1MeetIgnored,
  r1MeetJobs,
  r1MeetProcessed,
  type R1MeetAshbyEventJob,
  type R1MeetAshbyScheduleJob,
  type R1MeetBookingRerunJob,
  type R1MeetBotReleaseJob,
  type R1MeetEnsureBotJob,
  type R1MeetJobMeta,
  type R1MeetJobResult,
  type R1MeetRerunReason,
  type R1MeetRoundCancelledJob,
} from './jobs.js';
import { R1_MEET_DEFAULT_PROFILE_ID } from './profiles.js';
import {
  R1_MEET_ALERTS,
  R1_MEET_RECALL_UNAVAILABLE,
  R1_MEET_RELEASE_RETRY_SECONDS,
  r1MeetRecallFailure,
  r1MeetRecallRejected,
  releaseRecallBot,
  type R1MeetFlowDeps,
  type R1MeetJobDefinition,
  type R1MeetReleaseMode,
  type R1MeetReleaseOutcome,
} from './recall-actions.js';
import {
  R1_MEET_DISPATCHED_STATUSES,
  R1_MEET_LIVE_STATUSES,
  R1_MEET_TERMINAL_STATUSES,
  type R1MeetAshbyBooking,
  type R1MeetBooking,
  type R1MeetCancelReason,
  type R1MeetCreateAnswer,
  type R1MeetCreateRoundInput,
} from './runtime-store.js';

// ── Knobs ───────────────────────────────────────────────────────────────────

const MINUTE_MS = 60_000;

/** A move that meets a dispatched bot waits this long, then looks again (D-S06-19). */
export const R1_MEET_HOLD_DEFER_SEC = 300;
/** A create/reschedule conflict is retried this many times within one run, then the job fails. */
export const R1_MEET_SCHEDULE_MAX_PASSES = 3;
/** The re-run ladder of the reasons that can clear by themselves (D-S06-18): +10 min, +60 min, +6 h. */
export const R1_MEET_RERUN_LADDER_MS: readonly number[] = Object.freeze([10 * MINUTE_MS, 60 * MINUTE_MS, 360 * MINUTE_MS]);
/** No re-run is planned later than this before the slot starts. */
export const R1_MEET_RERUN_LEAD_MS = 15 * MINUTE_MS;

/** The closed codes a schedule job may throw (besides the store's and the Recall rule's). */
export const R1_MEET_CONFLICT = 'r1_meet_conflict';
export const R1_MEET_INVALID_REQUEST = 'r1_meet_invalid_request';
export const R1_MEET_HELD_DISPATCHED = 'r1_meet_held_dispatched';
export const R1_MEET_RELEASE_UNSTARTED = 'r1_meet_release_unstarted';

const TERMINAL: ReadonlySet<R1MeetBookingStatus> = new Set(R1_MEET_TERMINAL_STATUSES);
const DISPATCHED: ReadonlySet<R1MeetBookingStatus> = new Set(R1_MEET_DISPATCHED_STATUSES);
const LIVE: ReadonlySet<R1MeetBookingStatus> = new Set(R1_MEET_LIVE_STATUSES);
/** The re-run reasons that follow the ladder; `slot_too_far` follows `retry_after` instead. */
const LADDER_REASONS: ReadonlySet<R1MeetBookingReason> = new Set(
  R1_MEET_RERUN_REASONS.filter((reason) => reason !== 'slot_too_far'),
);

type Meta = Pick<R1MeetJobMeta, 'deferCount' | 'deferredAt'>;

/** A step that wants the create RPC asked again (a conflict, a replay, a revival). */
const AGAIN = Symbol('again');
type Step = R1MeetJobResult | typeof AGAIN;

const toIso = (ms: number): string => new Date(ms).toISOString();

function unexpected(): never {
  throw new R1MeetJobError(R1_MEET_RPC_UNEXPECTED);
}

function isRerunReason(reason: R1MeetBookingReason): reason is R1MeetRerunReason {
  return (R1_MEET_RERUN_REASONS as readonly string[]).includes(reason);
}

// ── The outcome of several steps ─────────────────────────────────────────────

const RANK = { ignored: 0, processed: 1, defer: 2 } as const;
const rankOf = (result: R1MeetJobResult): number => (result.outcome === 'defer' ? RANK.defer : RANK[result.receipt]);

/**
 * The worst of several outcomes: a deferral over work done over nothing done. Of two deferrals the
 * shorter wins (the step that can go sooner decides; the other simply defers again), of equals the
 * first. Null entries (a step that did not run) are skipped; all null answers null.
 */
export function worstR1MeetResult(results: readonly (R1MeetJobResult | null)[]): R1MeetJobResult | null {
  let worst: R1MeetJobResult | null = null;
  for (const result of results) {
    if (result === null) continue;
    if (
      worst === null
      || rankOf(result) > rankOf(worst)
      || (result.outcome === 'defer' && worst.outcome === 'defer' && result.delaySeconds < worst.delaySeconds)
    ) {
      worst = result;
    }
  }
  return worst;
}

// ── Small shared steps ──────────────────────────────────────────────────────

/** D-S06-19: a move waits for the dispatched bot's call to end, within the deferral bound. */
function holdMove(meta: Meta, nowMs: number): R1MeetJobResult {
  if (!canDeferR1MeetJob(meta, nowMs)) throw new R1MeetJobError(R1_MEET_HELD_DISPATCHED);
  return r1MeetDefer('held_dispatched', R1_MEET_HOLD_DEFER_SEC);
}

/** leave_call said `cannot_command_unstarted_bot`: the bot is between dispatch and its call. */
function retryRelease(meta: Meta, nowMs: number): R1MeetJobResult {
  if (!canDeferR1MeetJob(meta, nowMs)) throw new R1MeetJobError(R1_MEET_RELEASE_UNSTARTED);
  return r1MeetDefer(R1_MEET_RECALL_UNAVAILABLE, R1_MEET_RELEASE_RETRY_SECONDS);
}

/** Release a bot at Recall (one GET first), or the job outcome of a Recall failure (D-S06-12). */
async function release(
  deps: R1MeetFlowDeps,
  botId: string,
  mode: R1MeetReleaseMode,
  meta: Meta,
): Promise<{ readonly outcome: R1MeetReleaseOutcome } | { readonly result: R1MeetJobResult }> {
  let outcome: R1MeetReleaseOutcome;
  try {
    outcome = await releaseRecallBot(deps.recall, botId, mode);
  } catch (error) {
    return { result: r1MeetRecallFailure(error, { meta, nowMs: deps.now(), log: deps.log }) };
  }
  if (outcome === 'retry') return { result: retryRelease(meta, deps.now()) };
  return { outcome };
}

/**
 * Mark a terminal booking's bot released. Anything but `ok`/`duplicate` leaves it an owed release
 * for maintenance (a terminal booking's counters only move with this call, so that is rare).
 */
async function markReleased(
  deps: R1MeetFlowDeps,
  booking: Pick<R1MeetBooking, 'id' | 'version' | 'keyAttempt'>,
): Promise<boolean> {
  const answer = await deps.store.setBot({
    bookingId: booking.id,
    action: 'release',
    expectedVersion: booking.version,
    expectedKeyAttempt: booking.keyAttempt,
    nowIso: toIso(deps.now()),
  });
  if (answer.status === 'invalid_action' || answer.status === 'invalid_request') unexpected();
  return answer.status === 'ok' || answer.status === 'duplicate';
}

/** `<current> -> failed/<reason>`; a booking someone else moved on is theirs. */
async function failBooking(
  deps: R1MeetFlowDeps,
  booking: Pick<R1MeetBooking, 'id' | 'status'>,
  reason: 'in_past' | 'bot_create_failed',
): Promise<R1MeetJobResult> {
  const answer = await deps.store.transition({
    bookingId: booking.id,
    from: booking.status,
    to: 'failed',
    reason,
    nowIso: toIso(deps.now()),
  });
  if (answer.status === 'ok') return r1MeetProcessed(reason);
  if (answer.status === 'status_conflict') return r1MeetIgnored('status_conflict');
  if (answer.status === 'not_found') return r1MeetIgnored('booking_gone');
  return unexpected();
}

/** 50 bot generations spent: the booking can never take another bot. */
async function generationExhausted(deps: R1MeetFlowDeps, booking: R1MeetBooking): Promise<R1MeetJobResult> {
  deps.log.error({ error_category: R1_MEET_ALERTS.generationExhausted });
  const failed = await failBooking(deps, booking, 'bot_create_failed');
  // A bot_scheduled booking reaches here after its bot was released at Recall: record that.
  if (failed.outcome === 'done' && failed.receipt === 'processed' && booking.recallBotId !== null) {
    await markReleased(deps, booking);
  }
  return failed.outcome === 'done' && failed.receipt === 'processed' ? r1MeetProcessed('generation_exhausted') : failed;
}

// ── The create RPC and what follows it (plan 2.4) ────────────────────────────

/** The create RPC's input without its clock: from a job (a delivery) or from a booking (a re-run). */
type CreateSource = Omit<R1MeetCreateRoundInput, 'nowIso'>;

async function resolveCreatedBy(deps: R1MeetFlowDeps, ashbyUserId: string): Promise<string | null> {
  return deps.resolveCreatedBy === undefined ? deps.config.serviceUserId : deps.resolveCreatedBy(ashbyUserId);
}

/** D-S06-9: when HR attested (scheduled with Dex), never later than now (the RPC refuses the future). */
function attestedAt(stamp: string | null, nowMs: number): string {
  const ms = stamp === null ? Number.NaN : Date.parse(stamp);
  return toIso(Number.isFinite(ms) ? Math.min(ms, nowMs) : nowMs);
}

async function sourceFromJob(
  deps: R1MeetFlowDeps,
  job: Extract<R1MeetAshbyEventJob, { decision: 'eligible' }>,
): Promise<CreateSource> {
  return {
    eventId: job.eventId,
    scheduleId: job.scheduleId,
    applicationId: job.applicationId,
    interviewStageId: job.interviewStageId,
    interviewId: job.interviewId,
    scheduledByUserId: job.scheduledByUserId,
    attestedAt: attestedAt(job.ashbyUpdatedAt ?? job.receivedAt, deps.now()),
    ashbyUpdatedAt: job.ashbyUpdatedAt,
    meetUrl: job.meetUrl,
    startAt: job.startAt,
    endAt: job.endAt,
    createdBy: await resolveCreatedBy(deps, job.scheduledByUserId),
    objectiveProfile: R1_MEET_DEFAULT_PROFILE_ID,
  };
}

/**
 * A re-run replays the delivery the booking stored; it never carries the Meet URL itself. Only an Ashby
 * booking has a stored delivery: a public-page booking never reaches the Ashby create RPC (M035).
 */
async function sourceFromBooking(deps: R1MeetFlowDeps, booking: R1MeetAshbyBooking): Promise<CreateSource> {
  return {
    eventId: booking.eventId,
    scheduleId: booking.scheduleId,
    applicationId: booking.applicationId,
    interviewStageId: booking.interviewStageId,
    interviewId: booking.interviewId,
    scheduledByUserId: booking.scheduledByUserId,
    attestedAt: attestedAt(booking.ashbyUpdatedAt ?? booking.createdAt, deps.now()),
    ashbyUpdatedAt: booking.ashbyUpdatedAt,
    meetUrl: booking.meetUrl,
    startAt: booking.startAt,
    endAt: booking.endAt,
    createdBy: await resolveCreatedBy(deps, booking.scheduledByUserId),
    objectiveProfile: booking.objectiveProfile,
  };
}

/**
 * Book the event: the create RPC, then whatever its answer asks for. A conflict, a replay or a
 * revival asks the RPC again, at most `R1_MEET_SCHEDULE_MAX_PASSES` times.
 * `nextRerunN` is the ladder step a re-run planned by this run gets (0 from a delivery).
 */
async function bookFromAshby(
  deps: R1MeetFlowDeps,
  source: CreateSource,
  meta: Meta,
  nextRerunN: number,
): Promise<R1MeetJobResult> {
  for (let pass = 0; pass < R1_MEET_SCHEDULE_MAX_PASSES; pass += 1) {
    const answer = await deps.store.createRound({ ...source, nowIso: toIso(deps.now()) });
    const step = await afterCreate(deps, source, answer, meta, nextRerunN);
    if (step !== AGAIN) return step;
  }
  throw new R1MeetJobError(R1_MEET_CONFLICT);
}

async function afterCreate(
  deps: R1MeetFlowDeps,
  source: CreateSource,
  answer: R1MeetCreateAnswer,
  meta: Meta,
  nextRerunN: number,
): Promise<Step> {
  switch (answer.status) {
    case 'created':
    case 'relinked':
      return ensureBot(deps, answer.bookingId, meta);
    case 'exists':
      return existing(deps, source, answer.bookingId, answer.roundLive, meta);
    case 'bot_attached':
      return detachForReplay(deps, answer.bookingId, meta);
    case 'booking_terminal':
    case 'stale_update':
      return r1MeetIgnored(answer.status);
    case 'version_exhausted':
      deps.log.error({ error_category: R1_MEET_ALERTS.generationExhausted });
      return r1MeetIgnored('generation_exhausted');
    case 'unmatched_application':
    case 'unmapped_scheduler':
    case 'blocked':
      return park(deps, answer.bookingId, answer.reason, answer.retryAfter, source, nextRerunN);
    case 'in_past': {
      if (answer.bookingId === null) return r1MeetIgnored('in_past');
      // A booking that never got its bot and whose slot has started: it never will.
      const booking = await deps.store.getBooking(answer.bookingId);
      if (booking === null) return r1MeetIgnored('booking_gone');
      // The Ashby create RPC answers Ashby bookings only; a public one is never acted on here (M035).
      if (booking.source !== 'ashby') return r1MeetIgnored('public_booking');
      if (!LIVE.has(booking.status)) return r1MeetIgnored('booking_terminal');
      return failBooking(deps, booking, 'in_past');
    }
    case 'invalid_request':
      throw new R1MeetJobError(R1_MEET_INVALID_REQUEST);
  }
}

/** The event already has a booking with a round: compare its slot with the delivery's (plan 2.4 step 2). */
async function existing(
  deps: R1MeetFlowDeps,
  source: CreateSource,
  bookingId: string,
  roundLive: boolean,
  meta: Meta,
): Promise<Step> {
  const booking = await deps.store.getBooking(bookingId);
  if (booking === null) return r1MeetIgnored('booking_gone');
  // The Ashby create RPC answers Ashby bookings only; a public one is never acted on here (M035).
  if (booking.source !== 'ashby') return r1MeetIgnored('public_booking');
  if (TERMINAL.has(booking.status)) return r1MeetIgnored('booking_terminal');
  const moved =
    booking.startAt !== source.startAt || booking.endAt !== source.endAt || booking.meetUrl !== source.meetUrl;
  // Before any Recall call: a slot that has started is never moved to.
  if (moved && Date.parse(source.startAt) <= deps.now()) return r1MeetIgnored('in_past');
  if (DISPATCHED.has(booking.status)) return moved ? holdMove(meta, deps.now()) : r1MeetIgnored('unchanged');
  if (!roundLive) return r1MeetIgnored('round_not_live');

  if (!moved) {
    if (booking.status === 'pending') return ensureBot(deps, booking.id, meta);
    if (booking.status === 'blocked') return reschedule(deps, source, booking, booking.version, 'blocked', meta);
    return r1MeetIgnored('unchanged');
  }

  let expectedVersion = booking.version;
  let status: R1MeetBookingStatus = booking.status;
  if (booking.status === 'bot_scheduled' && booking.recallBotId !== null) {
    const released = await release(deps, booking.recallBotId, 'undispatched_only', meta);
    if ('result' in released) return released.result;
    if (released.outcome === 'dispatched') return holdMove(meta, deps.now());
    const replaced = await deps.store.setBot({
      bookingId: booking.id,
      action: 'replace',
      expectedVersion: booking.version,
      expectedKeyAttempt: booking.keyAttempt,
      nowIso: toIso(deps.now()),
    });
    switch (replaced.status) {
      case 'ok':
        expectedVersion = replaced.version;
        status = 'pending';
        break;
      case 'version_conflict':
      case 'not_allowed':
        return AGAIN;
      case 'version_exhausted':
        return generationExhausted(deps, booking);
      case 'not_found':
        return r1MeetIgnored('booking_gone');
      default:
        return unexpected();
    }
  }
  if (status !== 'pending' && status !== 'blocked') return r1MeetIgnored('unchanged');
  return reschedule(deps, source, booking, expectedVersion, status, meta);
}

/** The reschedule RPC and what its answer asks for (plan 2.4 step 3). */
async function reschedule(
  deps: R1MeetFlowDeps,
  source: CreateSource,
  booking: R1MeetBooking,
  expectedVersion: number,
  status: 'pending' | 'blocked',
  meta: Meta,
): Promise<Step> {
  const answer = await deps.store.reschedule({
    bookingId: booking.id,
    expectedVersion,
    startAt: source.startAt,
    endAt: source.endAt,
    meetUrl: source.meetUrl,
    ashbyUpdatedAt: source.ashbyUpdatedAt,
    nowIso: toIso(deps.now()),
  });
  switch (answer.status) {
    case 'ok':
      return ensureBot(deps, booking.id, meta);
    case 'bot_attached':
    case 'version_conflict':
    case 'no_round':
    case 'round_not_live':
      // Read again: the create RPC re-binds a lapsed round and answers the current binding.
      return AGAIN;
    case 'slot_too_far': {
      // D-S06-17: fail it, so that the create replay revives it as blocked/slot_too_far with the new
      // slot stored (the reschedule wrote nothing, and a re-run may not carry the URL).
      const failed = await deps.store.transition({
        bookingId: booking.id,
        from: status,
        to: 'failed',
        reason: 'round_expired',
        nowIso: toIso(deps.now()),
      });
      if (failed.status === 'ok' || failed.status === 'status_conflict') return AGAIN;
      if (failed.status === 'not_found') return r1MeetIgnored('booking_gone');
      return unexpected();
    }
    case 'booking_dispatched':
      return holdMove(meta, deps.now());
    case 'version_exhausted':
      return generationExhausted(deps, { ...booking, status, recallBotId: null });
    case 'in_past':
    case 'stale_update':
    case 'booking_terminal':
    case 'not_found':
    case 'not_allowed':
      return r1MeetIgnored(answer.status);
    case 'invalid_request':
      throw new R1MeetJobError(R1_MEET_INVALID_REQUEST);
  }
}

/**
 * The create RPC is reviving (a failed booking) or re-binding (a lapsed round) a booking that still
 * holds a bot: release it first (plan 2.4 step 4), then ask again.
 */
async function detachForReplay(deps: R1MeetFlowDeps, bookingId: string, meta: Meta): Promise<Step> {
  const booking = await deps.store.getBooking(bookingId);
  if (booking === null) return r1MeetIgnored('booking_gone');
  // The Ashby create RPC answers Ashby bookings only; a public one is never acted on here (M035).
  if (booking.source !== 'ashby') return r1MeetIgnored('public_booking');
  if (booking.recallBotId === null) return AGAIN;
  const failed = booking.status === 'failed';
  if (!failed && TERMINAL.has(booking.status)) return r1MeetIgnored('booking_terminal');
  if (DISPATCHED.has(booking.status)) return holdMove(meta, deps.now());
  const released = await release(deps, booking.recallBotId, failed ? 'any' : 'undispatched_only', meta);
  if ('result' in released) return released.result;
  if (released.outcome === 'dispatched') return holdMove(meta, deps.now());
  if (failed) {
    await markReleased(deps, booking);
    return AGAIN;
  }
  const replaced = await deps.store.setBot({
    bookingId: booking.id,
    action: 'replace',
    expectedVersion: booking.version,
    expectedKeyAttempt: booking.keyAttempt,
    nowIso: toIso(deps.now()),
  });
  switch (replaced.status) {
    case 'ok':
    case 'version_conflict':
    case 'not_allowed':
      return AGAIN;
    case 'version_exhausted':
      return generationExhausted(deps, booking);
    case 'not_found':
      return r1MeetIgnored('booking_gone');
    default:
      return unexpected();
  }
}

/**
 * The RPC stored the booking as blocked, unmatched or unmapped. Plan a delayed re-run for the reasons
 * that can clear by themselves (D-S06-18): `slot_too_far` at `retry_after`; the ladder reasons at
 * +10 min, +60 min, +6 h, never later than 15 minutes before the slot. Ids only in the payload.
 */
async function park(
  deps: R1MeetFlowDeps,
  bookingId: string,
  reason: R1MeetBookingReason,
  retryAfter: string | null,
  source: CreateSource,
  nextRerunN: number,
): Promise<R1MeetJobResult> {
  if (isRerunReason(reason)) {
    let atMs: number | null = null;
    if (reason === 'slot_too_far') {
      if (retryAfter !== null && nextRerunN <= R1_MEET_RERUN_MAX_N) atMs = Date.parse(retryAfter);
    } else if (LADDER_REASONS.has(reason) && nextRerunN < R1_MEET_RERUN_LADDER_MS.length) {
      const nowMs = deps.now();
      const at = Math.min(nowMs + R1_MEET_RERUN_LADDER_MS[nextRerunN]!, Date.parse(source.startAt) - R1_MEET_RERUN_LEAD_MS);
      if (at > nowMs) atMs = at;
    }
    if (atMs !== null && Number.isFinite(atMs)) {
      await deps.enqueue(r1MeetJobs.bookingRerun(bookingId, reason, nextRerunN, atMs), { scheduledAt: toIso(atMs) });
    }
  }
  return r1MeetProcessed(reason);
}

// ── Cancel (D-S06-20) ───────────────────────────────────────────────────────

/**
 * Release for a cancel: like `release` (mode `any`), except that a Recall failure that may no longer
 * wait (the deferral bound is spent, or it is not a transient one) answers `owed` instead of failing
 * the job: the booking is cancelled anyway and maintenance retries the release.
 */
async function releaseForCancel(
  deps: R1MeetFlowDeps,
  botId: string,
  meta: Meta,
): Promise<{ readonly result: R1MeetJobResult } | { readonly owed: string | null }> {
  try {
    const outcome = await releaseRecallBot(deps.recall, botId, 'any');
    if (outcome !== 'retry') return { owed: null };
    if (canDeferR1MeetJob(meta, deps.now())) {
      return { result: r1MeetDefer(R1_MEET_RECALL_UNAVAILABLE, R1_MEET_RELEASE_RETRY_SECONDS) };
    }
    return { owed: 'leave:unstarted' };
  } catch (error) {
    if (!isRecallError(error)) throw error;
    if ((error.retriable || r1MeetRecallRejected(error)) && canDeferR1MeetJob(meta, deps.now())) {
      return { result: r1MeetRecallFailure(error, { meta, nowMs: deps.now(), log: deps.log }) };
    }
    return { owed: `${error.operation}:${error.category}` };
  }
}

/** A terminal booking that still holds its bot: release it at Recall, then record that. */
async function settleOwedRelease(deps: R1MeetFlowDeps, booking: R1MeetBooking, meta: Meta): Promise<R1MeetJobResult> {
  const released = await release(deps, booking.recallBotId!, 'any', meta);
  if ('result' in released) return released.result;
  const marked = await markReleased(deps, booking);
  return r1MeetProcessed(marked ? `released_${released.outcome}` : 'released_unmarked');
}

/** Recall release, then the cancel RPC, then set_bot('release'). Re-reads the booking first. */
async function cancelFlow(
  deps: R1MeetFlowDeps,
  bookingId: string,
  reason: R1MeetCancelReason,
  meta: Meta,
): Promise<R1MeetJobResult> {
  const booking = await deps.store.getBooking(bookingId);
  if (booking === null) return r1MeetIgnored('booking_gone');
  if (booking.status === 'cancelled') {
    // A run that died after the cancel RPC: finish its release.
    return booking.recallBotId === null ? r1MeetIgnored('already_cancelled') : settleOwedRelease(deps, booking, meta);
  }
  if (TERMINAL.has(booking.status)) return r1MeetIgnored('booking_terminal');

  let owed: string | null = null;
  if (booking.recallBotId !== null) {
    const released = await releaseForCancel(deps, booking.recallBotId, meta);
    if ('result' in released) return released.result;
    owed = released.owed;
  }

  const answer = await deps.store.cancel({ bookingId: booking.id, reason, nowIso: toIso(deps.now()) });
  let heldBot: string | null;
  switch (answer.status) {
    case 'ok':
    case 'already_cancelled':
      heldBot = answer.recallBotId;
      break;
    case 'booking_terminal':
      return r1MeetIgnored('booking_terminal');
    case 'not_found':
      return r1MeetIgnored('booking_gone');
    default:
      return unexpected();
  }
  if (heldBot === null) return r1MeetProcessed('cancelled');
  if (heldBot !== booking.recallBotId) {
    // A bot attached after the read: not the one released above. Its own release job handles it.
    await deps.enqueue(r1MeetJobs.botRelease(heldBot, booking.id));
    return r1MeetProcessed('cancelled');
  }
  if (owed !== null) {
    deps.log.error({ error_category: R1_MEET_ALERTS.releaseOwed, error_type: owed });
    return r1MeetProcessed('cancelled_release_owed');
  }
  await markReleased(deps, booking);
  return r1MeetProcessed('cancelled');
}

// ── Unschedule (not_scheduled, no_attester, no_meet_link) ────────────────────

type UnscheduleDecision = 'not_scheduled' | 'no_attester' | 'no_meet_link';

/**
 * A future event that should not have a bot right now (S01): release an UNDISPATCHED bot, replace it,
 * and block the booking with the decision as its reason, keeping it so that a later update re-arms
 * it. A dispatched bot holds. Order: GET -> DELETE | replace | transition blocked. A booking that was
 * `pending` retires its Idempotency-Key first (`rotate_key`, S06-R2): a create in flight under it
 * would otherwise be replayed, deleted bot and all, when the booking comes back to the same slot.
 */
async function unschedule(
  deps: R1MeetFlowDeps,
  eventId: string,
  decision: UnscheduleDecision,
  meta: Meta,
): Promise<R1MeetJobResult> {
  for (let pass = 0; pass < R1_MEET_SCHEDULE_MAX_PASSES; pass += 1) {
    const booking = await deps.store.getBookingByEvent(eventId);
    if (booking === null) return r1MeetIgnored('no_booking');
    if (TERMINAL.has(booking.status)) return r1MeetIgnored('booking_terminal');
    if (DISPATCHED.has(booking.status)) return r1MeetIgnored('held_dispatched');

    let from: R1MeetBookingStatus = booking.status;
    if (booking.status === 'bot_scheduled' && booking.recallBotId !== null) {
      const released = await release(deps, booking.recallBotId, 'undispatched_only', meta);
      if ('result' in released) return released.result;
      if (released.outcome === 'dispatched') return r1MeetIgnored('held_dispatched');
      const replaced = await deps.store.setBot({
        bookingId: booking.id,
        action: 'replace',
        expectedVersion: booking.version,
        expectedKeyAttempt: booking.keyAttempt,
        nowIso: toIso(deps.now()),
      });
      if (replaced.status === 'version_conflict' || replaced.status === 'not_allowed') continue;
      if (replaced.status === 'version_exhausted') return generationExhausted(deps, booking);
      if (replaced.status === 'not_found') return r1MeetIgnored('booking_gone');
      if (replaced.status !== 'ok') return unexpected();
      from = 'pending';
    }
    if (from !== 'pending' && from !== 'blocked') return r1MeetIgnored('no_bot');
    if (from === 'blocked' && booking.reason === decision) return r1MeetIgnored('unchanged');
    if (booking.status === 'pending') {
      // A create may be in flight under this key (S06-R2): retire it before the booking leaves
      // pending, so its bot, released when the attach is refused, can never be replayed later.
      const retired = await retireR1MeetCreateKey(deps, booking);
      if (retired === 'moved') continue;
      if (retired === 'exhausted') {
        deps.log.error({ error_category: R1_MEET_ALERTS.botCreateFailed, error_type: 'key_attempts_exhausted' });
        return failBooking(deps, booking, 'bot_create_failed');
      }
    }

    const blocked = await deps.store.transition({
      bookingId: booking.id,
      from,
      to: 'blocked',
      reason: decision,
      nowIso: toIso(deps.now()),
    });
    if (blocked.status === 'ok') return r1MeetProcessed(decision);
    if (blocked.status === 'status_conflict') continue;
    if (blocked.status === 'not_found') return r1MeetIgnored('booking_gone');
    return unexpected();
  }
  throw new R1MeetJobError(R1_MEET_CONFLICT);
}

// ── Reconcile (D-S06-21, S03 R11) ────────────────────────────────────────────

/** Why a live booking of the schedule must go, or null when the job's lists protect it. */
function reconcileReason(job: R1MeetAshbyScheduleJob, eventId: string): R1MeetCancelReason | null {
  // An identity job (the schedule was cancelled and its events were unreadable).
  if (job.dexEventIds === null || job.scheduleEventIds === null) return 'cancelled';
  // A booking whose event still has Dex is its own event job's business.
  if (job.dexEventIds.includes(eventId)) return null;
  if (job.scope === 'schedule' && job.decision === 'cancelled') return 'cancelled';
  return job.scheduleEventIds.includes(eventId) ? 'dex_absent' : 'event_removed';
}

async function reconcile(
  deps: R1MeetFlowDeps,
  job: R1MeetAshbyScheduleJob,
  meta: Meta,
): Promise<R1MeetJobResult | null> {
  const bookings = await deps.store.listLiveBySchedule(job.scheduleId);
  const jobUpdatedMs = job.ashbyUpdatedAt === null ? null : Date.parse(job.ashbyUpdatedAt);
  const results: R1MeetJobResult[] = [];
  let failure: { readonly error: unknown } | null = null;
  for (const booking of bookings) {
    const reason = reconcileReason(job, booking.eventId);
    if (reason === null) continue;
    // A newer delivery already touched this booking: it knows better than this one.
    if (jobUpdatedMs !== null && booking.ashbyUpdatedAt !== null && Date.parse(booking.ashbyUpdatedAt) > jobUpdatedMs) {
      continue;
    }
    try {
      results.push(await cancelFlow(deps, booking.id, reason, meta));
    } catch (error) {
      // One booking's failure does not spare the others; it is rethrown once they are done.
      failure ??= { error };
    }
  }
  if (failure !== null) throw failure.error;
  const worst = worstR1MeetResult(results);
  if (worst === null) return null;
  return worst.outcome === 'done' && worst.receipt === 'processed' ? r1MeetProcessed('reconciled') : worst;
}

// ── The job definitions ─────────────────────────────────────────────────────

async function eventAction(deps: R1MeetFlowDeps, job: R1MeetAshbyEventJob, meta: Meta): Promise<R1MeetJobResult> {
  switch (job.decision) {
    case 'eligible':
      return bookFromAshby(deps, await sourceFromJob(deps, job), meta, 0);
    case 'cancelled':
    case 'dex_absent': {
      const booking = await deps.store.getBookingByEvent(job.eventId);
      return booking === null ? r1MeetIgnored('no_booking') : cancelFlow(deps, booking.id, job.decision, meta);
    }
    case 'in_past':
      // The slot has started: a schedule change now never ends a live interview (S01).
      return r1MeetIgnored('held_in_past');
    case 'not_scheduled':
    case 'no_attester':
    case 'no_meet_link':
      return unschedule(deps, job.eventId, job.decision, meta);
  }
}

/** `ashby_schedule` (S03): the delivery's decision for one Dex event, or for the whole schedule. */
export const r1MeetAshbyScheduleDefinition: R1MeetJobDefinition<R1MeetAshbyScheduleJob> = Object.freeze({
  kind: 'ashby_schedule',
  parse: parseAshbyScheduleJob,
  async run(deps: R1MeetFlowDeps, job: R1MeetAshbyScheduleJob, meta: R1MeetJobMeta): Promise<R1MeetJobResult> {
    if (await deps.store.newerAshbyDelivery(job)) return r1MeetIgnored('superseded');
    let main: R1MeetJobResult | null = null;
    let failure: { readonly error: unknown } | null = null;
    if (job.scope === 'event') {
      try {
        main = await eventAction(deps, job, meta);
      } catch (error) {
        failure = { error };
      }
    }
    let reconciled: R1MeetJobResult | null = null;
    try {
      reconciled = await reconcile(deps, job, meta);
    } catch (error) {
      failure ??= { error };
    }
    if (failure !== null) throw failure.error;
    return worstR1MeetResult([main, reconciled]) ?? r1MeetIgnored('nothing_to_reconcile');
  },
});

/**
 * `booking_rerun` (S06): replay the create RPC from the booking's stored delivery (D-S06-18). A
 * public-page booking has none and is never parked by its RPC: refused before any RPC (M035).
 */
export const r1MeetBookingRerunDefinition: R1MeetJobDefinition<R1MeetBookingRerunJob> = Object.freeze({
  kind: 'booking_rerun',
  parse: parseBookingRerunJob,
  async run(deps: R1MeetFlowDeps, job: R1MeetBookingRerunJob, meta: R1MeetJobMeta): Promise<R1MeetJobResult> {
    const booking = await deps.store.getBooking(job.bookingId);
    if (booking === null) return r1MeetIgnored('booking_gone');
    if (booking.source !== 'ashby') return r1MeetIgnored('public_booking');
    // Something else (a delivery, HR) changed the booking since: this re-run is about nothing.
    if (booking.reason !== job.reason) return r1MeetIgnored('reason_changed');
    if (Date.parse(booking.startAt) <= deps.now()) return r1MeetIgnored('in_past');
    return bookFromAshby(deps, await sourceFromBooking(deps, booking), meta, job.n + 1);
  },
});

/** `ensure_bot` (maintenance): a stuck `pending` booking, or one the daily cap blocked. */
export const r1MeetEnsureBotDefinition: R1MeetJobDefinition<R1MeetEnsureBotJob> = Object.freeze({
  kind: 'ensure_bot',
  parse: parseEnsureBotJob,
  async run(deps: R1MeetFlowDeps, job: R1MeetEnsureBotJob, meta: R1MeetJobMeta): Promise<R1MeetJobResult> {
    const booking = await deps.store.getBooking(job.bookingId);
    if (booking === null) return r1MeetIgnored('booking_gone');
    if (booking.status === 'pending') return ensureBot(deps, booking.id, meta);
    if (booking.status !== 'blocked' || booking.reason !== 'bot_cap_reached') return r1MeetIgnored('not_pending');
    if (Date.parse(booking.startAt) <= deps.now()) return r1MeetIgnored('in_past');
    // Still at the cap: leave it blocked without a second alert (maintenance asks again later).
    if (await r1MeetCapReached(deps, booking)) return r1MeetIgnored('bot_cap_reached');
    const answer = await deps.store.reschedule({
      bookingId: booking.id,
      expectedVersion: booking.version,
      startAt: booking.startAt,
      endAt: booking.endAt,
      meetUrl: booking.meetUrl,
      ashbyUpdatedAt: booking.ashbyUpdatedAt,
      nowIso: toIso(deps.now()),
    });
    if (answer.status === 'ok') return ensureBot(deps, booking.id, meta);
    if (answer.status === 'invalid_request') throw new R1MeetJobError(R1_MEET_INVALID_REQUEST);
    return r1MeetIgnored(`reschedule_${answer.status}`);
  },
});

/**
 * `bot_release` (0142 delete trigger, an orphaned create, a stray bot): remove the bot at Recall.
 * Never one a LIVE booking holds (that booking owns its bot's lifecycle); a terminal holder gets
 * its release recorded.
 */
export const r1MeetBotReleaseDefinition: R1MeetJobDefinition<R1MeetBotReleaseJob> = Object.freeze({
  kind: 'bot_release',
  parse: parseBotReleaseJob,
  async run(deps: R1MeetFlowDeps, job: R1MeetBotReleaseJob, meta: R1MeetJobMeta): Promise<R1MeetJobResult> {
    const holder = await deps.store.getBookingByBot(job.recallBotId);
    if (holder !== null && LIVE.has(holder.status)) return r1MeetIgnored('in_use');
    if (holder !== null) return settleOwedRelease(deps, holder, meta);
    const released = await release(deps, job.recallBotId, 'any', meta);
    if ('result' in released) return released.result;
    return r1MeetProcessed(`released_${released.outcome}`);
  },
});

/** `round_cancelled` (0142 trigger): HR cancelled the booking's Meet round in the app. */
export const r1MeetRoundCancelledDefinition: R1MeetJobDefinition<R1MeetRoundCancelledJob> = Object.freeze({
  kind: 'round_cancelled',
  parse: parseRoundCancelledJob,
  async run(deps: R1MeetFlowDeps, job: R1MeetRoundCancelledJob, meta: R1MeetJobMeta): Promise<R1MeetJobResult> {
    const booking = await deps.store.getBooking(job.bookingId);
    if (booking === null) return r1MeetIgnored('booking_gone');
    if (TERMINAL.has(booking.status)) {
      return booking.recallBotId === null ? r1MeetIgnored('booking_terminal') : settleOwedRelease(deps, booking, meta);
    }
    // Re-bound to another round since the trigger fired: that round was not cancelled.
    if (booking.roundId !== job.roundId) return r1MeetIgnored('round_rebound');
    return cancelFlow(deps, booking.id, 'round_cancelled', meta);
  },
});

/** The five definitions of this file, for the dispatcher. Frozen. */
export const R1_MEET_SCHEDULE_DEFINITIONS: readonly R1MeetJobDefinition[] = Object.freeze([
  r1MeetAshbyScheduleDefinition,
  r1MeetBookingRerunDefinition,
  r1MeetEnsureBotDefinition,
  r1MeetBotReleaseDefinition,
  r1MeetRoundCancelledDefinition,
] as R1MeetJobDefinition[]);
