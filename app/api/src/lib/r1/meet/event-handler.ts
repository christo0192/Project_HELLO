/**
 * The call side of the `r1-meet` runtime (M034 S06, dark): what a Recall bot's real-time events do to
 * its booking, the human-present arm, the multi-human policy, the end of an attempt and the bridge
 * recovery check. Four job definitions: `recall_event`, `attempt_ended`, `bridge_check` and
 * `multi_human_check` (D-S06-22..29), plus pure functions: `decideBridgeCheck`, `countHumans`, and
 * (M035 S09) `r1MeetBotAlertFor` and `r1MeetPreCallVerdict` with the three frozen sub-code lists.
 *
 * WHICH BOOKING (D-S06-22). The event's `booking_id` (from the bot's metadata) first, else the booking
 * that holds the bot. The event acts only when that booking's CURRENT bot is the event's bot. A bot
 * with no booking and no `booking_id` is not ours (the workspace may hold manual test bots): it is
 * ignored and never touched.
 *
 * STRAY BOTS (D-S06-23): an event of one of OUR bots (it names a booking) that is not that booking's
 * current bot. A terminal event (`call_ended`, `done`, `fatal`) needs nothing. While the booking is
 * `pending` an attach may still be in flight, so the job waits 30 s, at most 20 times. After that, or
 * for any other status, or when the booking is gone: alert `r1_meet_stray_bot`, rotate the booking's
 * Idempotency-Key first when it is still `pending` (otherwise the next create would be answered from
 * Recall's one-hour cache with this very bot), and queue a `bot_release` of it. That job never
 * removes a bot a live booking holds, so a stray attached in the meantime survives. A LIVE event of a
 * TERMINAL booking's own bot (an owed release) also queues its `bot_release`.
 *
 * STATUS MAPPING (D-S06-24, M035 S09 D-S09-3/4), on the current bot of a live booking:
 *   joining_call, in_waiting_room, in_call_not_recording, recording_permission_*
 *                                  bot_scheduled -> bot_joining; anything else: no change. A FRESH
 *                                  run of `in_waiting_room` also alerts `r1_meet_bot_waiting_room`
 *                                  at once, before the status step (the meeting is not OPEN, or
 *                                  nobody admitted Dex: HR must fix it before more candidates are
 *                                  stranded); once per run, never on a re-run;
 *   in_call_recording, or a participant join that is not a bot
 *                                  a human is present (below);
 *   call_ended, done, fatal        bot_scheduled | bot_joining -> failed/bot_fatal for `bot.fatal` or
 *                                  a FATAL sub-code (below). Otherwise the bot is read ONCE before
 *                                  the move (`r1MeetPreCallVerdict`): a `fatal` status, a fatal
 *                                  sub-code, or NO `in_call_*` status anywhere in its history (a bot
 *                                  that never got into the call cannot have seen a candidate stay
 *                                  away) -> failed/bot_fatal; else failed/no_show. Svix does not order
 *                                  deliveries and Recall follows `fatal` with `done`, so the event
 *                                  alone would race. A Recall failure of that read defers the job
 *                                  BEFORE the move (the booking stays live); 404 keeps the event's
 *                                  own reason and the release is `gone`.
 *                                  human_present -> failed/bot_fatal; in_call without a session ->
 *                                  failed/admission_refused; in_call WITH a session: no move, the
 *                                  attempt's own outcome decides (`attempt_ended`).
 * FATAL SUB-CODES (frozen, exported): M034's six (waiting-room timeouts, kicks, `meeting_not_started`,
 * a recording-permission timeout), then the guest bot's refusals at the door (blocked, knocking
 * disabled, a meeting that needs a signed-in user, one restricted to the host's organisation), then
 * the signed-in bot's sign-in failures. Sub-codes are not an enum (Recall adds them at will): an
 * unknown one is simply not fatal.
 * ALERTS of a refused bot: when THIS job's move of a `bot_scheduled` / `bot_joining` booking to
 * `failed` wins and a sub-code of the admission list (`r1_meet_bot_admission_blocked`) or of the
 * sign-in list (`r1_meet_bot_sign_in_failed`) is known (the event's, else the oldest in the history
 * read above), one error line names that sub-code as `error_type`. A move lost to another job never
 * alerts, so a booking alerts once. `bot_fatal` without a listed sub-code alerts nothing new.
 * A terminal event whose sub-code is `bot_received_leave_call` is usually OUR leave (outcome,
 * multi-human, give-up, cancel, drain), whose job marks the booking itself: it waits once, 60 s,
 * before it maps (and before any Recall read). After a terminal move the bot is released at Recall:
 * when the read before the move already says the call ended (the common case) nothing else is sent;
 * otherwise one GET and whatever the bot's state allows (a leave). Then `set_bot('release')`. A run
 * that dies in between replays through the terminal branch, which finishes the owed release.
 *
 * HUMAN PRESENT (D-S06-25). The compare-and-set `-> human_present` elects ONE winner among the jobs
 * of the two signals (and their duplicates). The winner, or a RE-RUN of a job (a crash or a deferral
 * may have stopped it after the move or after the arm), arms when the ticket is unclaimed and either
 * was never armed or the booking has been untouched for 20 s (an arm a moment ago is someone's live
 * page). `armBridge` (arm.ts) does the rest: one GET, mint, `r1_meet_arm_ticket`, the bridge check,
 * output_media. With `R1_MEET_ARM_AT_CREATE` a ticket armed at create is never armed again (the bot
 * already shows its page); its bridge check is queued here, so a page that never claims is still
 * recovered. An unarmed one falls back to the normal arm.
 *
 * MULTIPLE HUMANS (D-S06-28, critic C4). Humans present = distinct participant ids with more joins
 * than leaves, not marked `is_bot`, counted from the durable `recall_event` rows of THIS bot (ids
 * only: no name is ever read). On Google Meet a rejoin is a NEW id, and HR may still be admitting
 * the candidate, so two humans only queue one `multi_human_check` 120 s later; if there are still
 * more than one then, policy `end` alerts `r1_meet_multiple_humans`, leaves at Recall FIRST, then
 * marks `failed/multiple_humans` and the release; policy `observe` (THE DEFAULT, PR #444 review
 * S06-R3) only logs, until the live spike settles whether Recall reports the bot's own join, whether
 * HR must stay to admit the candidate, and notetaker bots.
 *
 * ATTEMPT ENDED (D-S06-29, PR #444 review S06-R1). Only when the booking still holds that session.
 * The attempt's settlement decides, never the bot: a COUNTED attempt leaves at Recall, then
 * `in_call -> completed/attempt_settled`, then `set_bot('release')`. An attempt that did NOT count (a
 * provider error, a forced shutdown, a bridge that never got in, a session that lapsed before the
 * worker joined) is recovered as the browser flow would let the candidate restart: while the round
 * can admit an attempt (a start left, nothing counted to the limit), the claim window is open, an arm
 * is left and a human is still in the call, the bridge is RE-ARMED (S05: the next claim admits a new
 * attempt, one of the 3 starts, and re-binds). Otherwise the call ends as `failed/no_show` (nobody
 * left in the call) or `failed/bot_fatal` (Dex could not continue), never as a completed interview. An
 * attempt not settled yet waits for the worker's outcome, bounded. Nothing of this runs in the voice
 * worker (critic C5).
 *
 * BRIDGE RECOVERY (D-S06-27). `decideBridgeCheck` is a pure table over the booking, its session and
 * the clock; the handler turns its answer into a re-check (a deferral, at most 10), a re-arm (a new
 * ticket and a new page, so a burned or never-claimed ticket recovers), or, once 5 arms are spent, a
 * give-up: alert `r1_meet_bridge_gave_up`, leave, `failed/admission_refused` from `in_call`,
 * `failed/bot_fatal` otherwise, release. A claimed ticket whose session ended is handed to
 * `attempt_ended` at once; an unclaimed one (a re-arm after that end) is watched like any other.
 *
 * HOT WINDOW (D-S06-3). Every processed event or check of a live booking hints the runtime lane to
 * stay fast for 5 minutes, and a booking in `bot_joining` until 15 minutes after its start: the next
 * webhook of a call must not wait for an idle backoff.
 *
 * RETRY POINTS (plan 2.5): Recall first, the database second, a fresh read at the start of every
 * run, so a run killed after any step replays into the same end state.
 *
 * LOGS: alerts and warnings only (`R1_MEET_ALERTS`, closed words). Never an id, a name, an email, a
 * Meet URL, a page URL, a ticket or a digest. Loading this module performs no I/O: everything arrives
 * in `R1MeetFlowDeps`.
 */

import { isRecallError } from '../../../integrations/recall/errors.js';
import type { RecallBot, RecallBotStatusChange } from '../../../integrations/recall/types.js';
import { R1_MEET_BRIDGE_CHECK_DELAY_SEC, armBridge } from './arm.js';
import type { R1MeetBookingReason, R1MeetBookingStatus } from './bookings-read.js';
import {
  R1MeetJobError,
  R1_MEET_MAX_TICKET_ARMS,
  R1_MEET_RPC_UNEXPECTED,
  canDeferR1MeetJob,
  parseAttemptEndedJob,
  parseBridgeCheckJob,
  parseMultiHumanCheckJob,
  parseRecallEventJob,
  r1MeetDefer,
  r1MeetIgnored,
  r1MeetJobs,
  r1MeetProcessed,
  type R1MeetAttemptEndedJob,
  type R1MeetBridgeCheckJob,
  type R1MeetJobMeta,
  type R1MeetJobResult,
  type R1MeetMultiHumanCheckJob,
  type R1MeetRecallEventJob,
} from './jobs.js';
import {
  R1_MEET_ALERTS,
  R1_MEET_RECALL_UNAVAILABLE,
  R1_MEET_RELEASE_RETRY_SECONDS,
  r1MeetBotEnded,
  r1MeetRecallFailure,
  releaseRecallBot,
  type R1MeetFlowDeps,
  type R1MeetJobDefinition,
  type R1MeetReleaseOutcome,
} from './recall-actions.js';
import {
  R1_MEET_DISPATCHED_STATUSES,
  R1_MEET_TERMINAL_STATUSES,
  type R1MeetBooking,
  type R1MeetParticipantEventRow,
  type R1MeetSessionStatus,
} from './runtime-store.js';
import { R1_MEET_CONFLICT } from './schedule-handler.js';
import { R1_MEET_TICKET_TAIL_SEC } from './ticket.js';

// ── Knobs ───────────────────────────────────────────────────────────────────

const SECOND_MS = 1000;
const MINUTE_MS = 60 * SECOND_MS;

/** A live event or check keeps the runtime lane fast this long (D-S06-3). */
export const R1_MEET_HOT_EVENT_MS = 5 * MINUTE_MS;
/** A booking in `bot_joining` keeps it fast until this long after the slot starts. */
export const R1_MEET_HOT_JOINING_TAIL_MS = 15 * MINUTE_MS;
/** An event of a bot a `pending` booking may be about to attach waits this long, at most this often. */
export const R1_MEET_STRAY_DEFER_SEC = 30;
export const R1_MEET_STRAY_MAX_DEFERS = 20;
/** Our own leave_call: the job that sent it marks the booking; the event waits once, this long. */
export const R1_MEET_OWN_LEAVE_DEFER_SEC = 60;
export const R1_MEET_OWN_LEAVE_SUB_CODE = 'bot_received_leave_call';
/** A re-run re-arms an armed, unclaimed ticket only when nobody touched the booking this long. */
export const R1_MEET_REARM_UNTOUCHED_MS = 20 * SECOND_MS;
/** Two humans are checked again this much later (a rejoin is a new id; HR may be admitting). */
export const R1_MEET_MULTI_HUMAN_CHECK_DELAY_SEC = 120;
/** decideBridgeCheck: the page's own retries stop at 180 s, so an unclaimed ticket waits 200 s. */
export const R1_MEET_BRIDGE_UNCLAIMED_SEC = 200;
/** A claim with no session: the 202-then-resume handshake takes seconds, never 45. */
export const R1_MEET_BRIDGE_NO_SESSION_SEC = 45;
/** A claim whose session is still `created` / `waiting`: the worker gate's own bound, plus margin. */
export const R1_MEET_BRIDGE_NOT_STARTED_SEC = 200;
/** A bridge check re-checks (defers) at most this many times. */
export const R1_MEET_BRIDGE_MAX_RECHECKS = 10;
/** A compare-and-set lost to a concurrent job is retried this many times in one run. */
export const R1_MEET_EVENT_MAX_PASSES = 3;
/** An attempt not settled yet waits this long for the worker's outcome, at most this many times. */
export const R1_MEET_OUTCOME_WAIT_SEC = 30;
export const R1_MEET_OUTCOME_WAIT_MAX = 4;
/** A re-arm after a session ended is its bridge check's until that check could have re-armed it. */
export const R1_MEET_REARM_WATCH_MS = (R1_MEET_BRIDGE_CHECK_DELAY_SEC + R1_MEET_BRIDGE_UNCLAIMED_SEC) * SECOND_MS;

/**
 * The refusals at the door (M035 S09 D-S09-2): the bot never got into the meeting. The first four
 * arrive on `call_ended` (a waiting-room timeout, Recall's or Meet's; a kick from the waiting room; a
 * meeting that had not started); the last four are the guest bot's refusals on `fatal` (blocked by
 * the meeting's settings, knocking disabled, a meeting that needs a signed-in user, one restricted to
 * the host's organisation). Alert `r1_meet_bot_admission_blocked`. Every entry is a logger safe
 * identifier (it is logged as `error_type`). Frozen.
 */
export const R1_MEET_ADMISSION_SUB_CODES = Object.freeze([
  'call_ended_by_platform_waiting_room_timeout',
  'timeout_exceeded_waiting_room',
  'bot_kicked_from_waiting_room',
  'meeting_not_started',
  'google_meet_bot_blocked',
  'google_meet_knocking_disabled',
  'google_meet_sign_in_missing_login_credentials',
  'google_meet_organisation_restricted',
] as const);

/**
 * The signed-in bot's sign-in failures (M035 S09 D-S09-2; only with a Recall Login Group, never the
 * default guest bot): Google or the SSO provider did not let Recall sign Dex in. All arrive on
 * `fatal`. Alert `r1_meet_bot_sign_in_failed`. Disjoint from the admission list. Frozen.
 */
export const R1_MEET_SIGN_IN_SUB_CODES = Object.freeze([
  'google_meet_sso_sign_in_failed',
  'google_meet_sign_in_failed',
  'sso_not_configured',
  'google_meet_login_not_available',
  'google_meet_sign_in_captcha_failed',
  'google_meet_sign_in_missing_recovery_credentials',
  'google_meet_sso_sign_in_missing_login_credentials',
  'google_meet_sso_sign_in_missing_totp_secret',
  'sso_login_account_disabled',
  'sso_login_invalid_recipient',
] as const);

/**
 * The sub-codes of a terminal event that make it a BOT failure (`bot_fatal`), never a candidate
 * no-show: M034's six in their order (D-S06-24: a waiting-room timeout, a kick, a meeting that had not
 * started, a recording-permission timeout), then the admission refusals not already among them, then
 * the sign-in failures (20). Both alert lists are inside it. Any other sub-code, known or not, is not
 * fatal by itself. Frozen.
 */
export const R1_MEET_FATAL_SUB_CODES = Object.freeze([
  'call_ended_by_platform_waiting_room_timeout',
  'timeout_exceeded_waiting_room',
  'bot_kicked_from_call',
  'bot_kicked_from_waiting_room',
  'meeting_not_started',
  'timeout_exceeded_recording_permission_denied',
  'google_meet_bot_blocked',
  'google_meet_knocking_disabled',
  'google_meet_sign_in_missing_login_credentials',
  'google_meet_organisation_restricted',
  ...R1_MEET_SIGN_IN_SUB_CODES,
] as const);

const FATAL_SUB_CODES: ReadonlySet<string> = new Set(R1_MEET_FATAL_SUB_CODES);
const ADMISSION_SUB_CODES: ReadonlySet<string> = new Set(R1_MEET_ADMISSION_SUB_CODES);
const SIGN_IN_SUB_CODES: ReadonlySet<string> = new Set(R1_MEET_SIGN_IN_SUB_CODES);
/** The statuses a bot inside the call reports (Recall's bot status codes). */
const IN_CALL_CODES: ReadonlySet<string> = new Set(['in_call_not_recording', 'in_call_recording']);
/** The statuses whose terminal event may be a no-show: no human was seen yet. */
const PRE_HUMAN: ReadonlySet<R1MeetBookingStatus> = new Set<R1MeetBookingStatus>(['bot_scheduled', 'bot_joining']);
const JOINING_EVENTS: ReadonlySet<string> = new Set([
  'bot.joining_call',
  'bot.in_waiting_room',
  'bot.in_call_not_recording',
  'bot.recording_permission_allowed',
  'bot.recording_permission_denied',
]);
const ENDED_EVENTS: ReadonlySet<string> = new Set(['bot.call_ended', 'bot.done', 'bot.fatal']);
const TERMINAL: ReadonlySet<R1MeetBookingStatus> = new Set(R1_MEET_TERMINAL_STATUSES);
const DISPATCHED: ReadonlySet<R1MeetBookingStatus> = new Set(R1_MEET_DISPATCHED_STATUSES);
/** The statuses that hold a bot (0142 bot binding) and take a ticket (0142 §16). */
const HOLDS_BOT: ReadonlySet<R1MeetBookingStatus> = new Set<R1MeetBookingStatus>(['bot_scheduled', ...R1_MEET_DISPATCHED_STATUSES]);
const ENDED_SESSIONS: ReadonlySet<R1MeetSessionStatus> = new Set<R1MeetSessionStatus>(['completed', 'failed', 'cancelled', 'expired']);

type Meta = Pick<R1MeetJobMeta, 'deferCount' | 'deferredAt'>;

/** A step that lost a compare-and-set and wants a fresh read. */
const AGAIN = Symbol('again');
type Step = R1MeetJobResult | typeof AGAIN;

const toIso = (ms: number): string => new Date(ms).toISOString();

function unexpected(): never {
  throw new R1MeetJobError(R1_MEET_RPC_UNEXPECTED);
}

// ── Pure: humans present, and the bridge check table ────────────────────────

/**
 * Distinct participants with more joins than leaves (D-S06-28). An id that any row marks as a bot is
 * not counted, nor is a null id. A rejoin on Google Meet is a new id, so it counts once: the old id
 * left. The rows carry ids only; nothing here can read a name.
 */
export function countHumans(
  events: readonly Pick<R1MeetParticipantEventRow, 'type' | 'participantId' | 'isBot'>[],
): number {
  const bots = new Set<number>();
  for (const event of events) if (event.participantId !== null && event.isBot === true) bots.add(event.participantId);
  const net = new Map<number, number>();
  for (const event of events) {
    if (event.participantId === null || bots.has(event.participantId)) continue;
    net.set(event.participantId, (net.get(event.participantId) ?? 0) + (event.type === 'join' ? 1 : -1));
  }
  let humans = 0;
  for (const count of net.values()) if (count > 0) humans += 1;
  return humans;
}

// ── Pure: a bot that was refused or never got in (M035 S09) ─────────────────

/**
 * The alert word of a refused bot's sub-code (D-S09-4): `r1_meet_bot_admission_blocked` for the
 * admission list, `r1_meet_bot_sign_in_failed` for the sign-in list, null for anything else
 * (another fatal sub-code, an unknown one, none).
 */
export function r1MeetBotAlertFor(
  subCode: string | null,
): typeof R1_MEET_ALERTS.botAdmissionBlocked | typeof R1_MEET_ALERTS.botSignInFailed | null {
  if (subCode === null) return null;
  if (ADMISSION_SUB_CODES.has(subCode)) return R1_MEET_ALERTS.botAdmissionBlocked;
  if (SIGN_IN_SUB_CODES.has(subCode)) return R1_MEET_ALERTS.botSignInFailed;
  return null;
}

/** What a bot's own status history says about a call that ended before any human was seen. */
export interface R1MeetPreCallVerdict {
  /** The BOT failed (`bot_fatal`), so this was never a candidate no-show. */
  readonly botFailed: boolean;
  /** The oldest sub-code of either alert list in the history, or null. */
  readonly alertSubCode: string | null;
}

/**
 * D-S09-3, pure. The bot FAILED when its history (oldest first) holds a `fatal` status, a fatal
 * sub-code, or NO `in_call_not_recording` / `in_call_recording` status at all: a bot that never got
 * into the call cannot have seen a candidate stay away, whatever sub-code Recall gave (one it adds
 * later included). Otherwise it was in the call and nobody came: a no-show.
 */
export function r1MeetPreCallVerdict(
  changes: readonly Pick<RecallBotStatusChange, 'code' | 'subCode'>[],
): R1MeetPreCallVerdict {
  let inCall = false;
  let fatal = false;
  let alertSubCode: string | null = null;
  for (const change of changes) {
    if (IN_CALL_CODES.has(change.code)) inCall = true;
    if (change.code === 'fatal') fatal = true;
    if (change.subCode !== null && FATAL_SUB_CODES.has(change.subCode)) fatal = true;
    if (alertSubCode === null && r1MeetBotAlertFor(change.subCode) !== null) alertSubCode = change.subCode;
  }
  return Object.freeze({ botFailed: fatal || !inCall, alertSubCode });
}

/** What `decideBridgeCheck` reads. */
export interface R1MeetBridgeCheckFacts {
  readonly booking: Pick<
    R1MeetBooking,
    'status' | 'version' | 'recallBotId' | 'ticketArms' | 'ticketNotBefore' | 'ticketClaimedAt' | 'sessionId' | 'endAt'
  > | null;
  /** The arm this check is about. */
  readonly check: Pick<R1MeetBridgeCheckJob, 'version' | 'arm'>;
  /** The bound session's status; null when the booking has no session or its row is gone. */
  readonly sessionStatus: R1MeetSessionStatus | null;
  /** When the arm was made (the check job is queued right after it). */
  readonly armedAtMs: number;
  readonly nowMs: number;
}

export type R1MeetBridgeDecision =
  | { readonly action: 'done'; readonly code: string }
  | { readonly action: 'recheck'; readonly code: string; readonly delaySeconds: number }
  | { readonly action: 'rearm'; readonly code: string }
  | { readonly action: 'give_up'; readonly code: string };

const done = (code: string): R1MeetBridgeDecision => Object.freeze({ action: 'done' as const, code });

/**
 * The bridge recovery table (D-S06-27), first match wins:
 *   no booking                                      done booking_gone
 *   another bot generation                          done generation_changed
 *   another arm (a newer one has its own check)     done superseded
 *   no bot to show a page (terminal, pending, ...)  done booking_not_live
 *   a fresh ticket could no longer open a window    done window_closed
 *   the bound session is `in_progress`              done session_in_progress
 *   the bound session ended, the ticket claimed     done session_ended (the handler queues that
 *                                                   session's `attempt_ended`, which decides)
 *   claimed, the session `created` / `waiting`      rearm after 200 s from the claim, else recheck
 *   claimed, no session                             rearm after 45 s from the claim, else recheck
 *   unclaimed (whatever the bound session says:     rearm after 200 s from the arm (or the window's
 *   a re-arm after an ended session included)       opening, if later), else recheck
 *   a rearm with 5 arms spent                       give_up arms_exhausted
 * A recheck's delay lands exactly on its threshold (at least 1 s). A clock value that is not a number
 * counts as "now": never as "long ago", which would re-arm at once.
 */
export function decideBridgeCheck(facts: R1MeetBridgeCheckFacts): R1MeetBridgeDecision {
  const { booking, check, sessionStatus, nowMs } = facts;
  if (booking === null) return done('booking_gone');
  if (booking.version !== check.version) return done('generation_changed');
  if (booking.ticketArms !== check.arm) return done('superseded');
  if (!HOLDS_BOT.has(booking.status) || booking.recallBotId === null) return done('booking_not_live');
  if (nowMs >= Date.parse(booking.endAt) + R1_MEET_TICKET_TAIL_SEC * SECOND_MS) return done('window_closed');
  const session = booking.sessionId === null ? null : sessionStatus;
  if (session === 'in_progress') return done('session_in_progress');
  // The ticket that started that session: its outcome decides (`attempt_ended`, which the handler
  // queues). An UNCLAIMED ticket is a re-arm after the end, watched like any other (S06-R1).
  if (session !== null && ENDED_SESSIONS.has(session) && booking.ticketClaimedAt !== null) return done('session_ended');

  let code: string;
  let sinceMs: number;
  let waitSec: number;
  if (booking.ticketClaimedAt !== null) {
    sinceMs = Date.parse(booking.ticketClaimedAt);
    if (session !== null) {
      code = 'session_not_started';
      waitSec = R1_MEET_BRIDGE_NOT_STARTED_SEC;
    } else {
      code = 'claimed_no_session';
      waitSec = R1_MEET_BRIDGE_NO_SESSION_SEC;
    }
  } else {
    const armedAtMs = Number.isFinite(facts.armedAtMs) ? facts.armedAtMs : nowMs;
    const opensMs = booking.ticketNotBefore === null ? armedAtMs : Date.parse(booking.ticketNotBefore);
    sinceMs = Math.max(armedAtMs, Number.isFinite(opensMs) ? opensMs : armedAtMs);
    code = 'unclaimed';
    waitSec = R1_MEET_BRIDGE_UNCLAIMED_SEC;
  }
  if (!Number.isFinite(sinceMs)) sinceMs = nowMs;
  const remainingMs = waitSec * SECOND_MS - (nowMs - sinceMs);
  if (remainingMs > 0) {
    return Object.freeze({ action: 'recheck' as const, code, delaySeconds: Math.max(1, Math.ceil(remainingMs / SECOND_MS)) });
  }
  if (booking.ticketArms >= R1_MEET_MAX_TICKET_ARMS) return Object.freeze({ action: 'give_up' as const, code: 'arms_exhausted' });
  return Object.freeze({ action: 'rearm' as const, code });
}

// ── Small shared steps ──────────────────────────────────────────────────────

function hotFor(deps: R1MeetFlowDeps, booking: Pick<R1MeetBooking, 'status' | 'startAt'>): void {
  if (deps.hotUntil === undefined) return;
  deps.hotUntil(deps.now() + R1_MEET_HOT_EVENT_MS);
  if (booking.status === 'bot_joining') hotJoining(deps, booking);
}

function hotJoining(deps: R1MeetFlowDeps, booking: Pick<R1MeetBooking, 'startAt'>): void {
  deps.hotUntil?.(Date.parse(booking.startAt) + R1_MEET_HOT_JOINING_TAIL_MS);
}

/** Release a bot at Recall (one GET first), or the job outcome of a Recall failure (D-S06-12). */
async function release(
  deps: R1MeetFlowDeps,
  botId: string,
  meta: Meta,
): Promise<{ readonly outcome: R1MeetReleaseOutcome } | { readonly result: R1MeetJobResult }> {
  let outcome: R1MeetReleaseOutcome;
  try {
    outcome = await releaseRecallBot(deps.recall, botId, 'any');
  } catch (error) {
    return { result: r1MeetRecallFailure(error, { meta, nowMs: deps.now(), log: deps.log }) };
  }
  if (outcome === 'retry') {
    // leave_call said `cannot_command_unstarted_bot`: between dispatch and the call. Wait and ask again.
    if (!canDeferR1MeetJob(meta, deps.now())) throw new R1MeetJobError('r1_meet_release_unstarted');
    return { result: r1MeetDefer(R1_MEET_RECALL_UNAVAILABLE, R1_MEET_RELEASE_RETRY_SECONDS) };
  }
  return { outcome };
}

/**
 * Record a terminal booking's bot as released. Anything but `ok`/`duplicate` leaves it an owed release
 * for maintenance (`listOwedReleases`).
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

/** A terminal booking still holds its bot: release it at Recall, then record it (an owed release). */
async function settleOwedRelease(deps: R1MeetFlowDeps, booking: R1MeetBooking, meta: Meta): Promise<R1MeetJobResult> {
  const released = await release(deps, booking.recallBotId!, meta);
  if ('result' in released) return released.result;
  const marked = await markReleased(deps, booking);
  return r1MeetProcessed(marked ? `released_${released.outcome}` : 'released_unmarked');
}

/** Where a booking goes when this job ends its call; null = this job does not move that status. */
type EndTarget = (status: R1MeetBookingStatus) => { readonly to: 'failed' | 'completed'; readonly reason: R1MeetBookingReason } | null;

/**
 * End a live booking's call: leave at Recall FIRST, then the status move, then `set_bot('release')`
 * (plan 2.5: a run killed after the leave replays, the GET says ended, and the move happens). A move
 * lost to a concurrent job is retried on a fresh read while this job still applies; if the booking
 * ended meanwhile, the release of the bot this job removed is recorded.
 */
async function endCall(
  deps: R1MeetFlowDeps,
  booking: R1MeetBooking,
  target: EndTarget,
  meta: Meta,
  code: string,
): Promise<R1MeetJobResult> {
  const botId = booking.recallBotId;
  if (botId === null) return r1MeetIgnored('no_bot');
  const released = await release(deps, botId, meta);
  if ('result' in released) return released.result;

  let current = booking;
  for (let pass = 0; pass < R1_MEET_EVENT_MAX_PASSES; pass += 1) {
    const move = target(current.status);
    if (move === null) return r1MeetIgnored('status_conflict');
    const answer = await deps.store.transition({
      bookingId: current.id,
      from: current.status,
      to: move.to,
      reason: move.reason,
      nowIso: toIso(deps.now()),
    });
    if (answer.status === 'ok') {
      await markReleased(deps, current);
      return r1MeetProcessed(code);
    }
    if (answer.status === 'not_found') return r1MeetIgnored('booking_gone');
    if (answer.status !== 'status_conflict') return unexpected();
    const fresh = await deps.store.getBooking(current.id);
    if (fresh === null) return r1MeetIgnored('booking_gone');
    if (fresh.recallBotId !== botId) return r1MeetIgnored('status_conflict');
    if (TERMINAL.has(fresh.status)) {
      // Someone else ended it first; the bot is gone at Recall either way, so record that.
      await markReleased(deps, fresh);
      return r1MeetIgnored('status_conflict');
    }
    current = fresh;
  }
  throw new R1MeetJobError(R1_MEET_CONFLICT);
}

// ── recall_event ────────────────────────────────────────────────────────────

type EventClass = 'joining' | 'human' | 'ended' | 'bot_participant' | 'participant_left';

function classify(job: R1MeetRecallEventJob): EventClass {
  if (job.eventType === 'participant_events.join') return job.participant.isBot === true ? 'bot_participant' : 'human';
  if (job.eventType === 'participant_events.leave') return 'participant_left';
  if (job.eventType === 'bot.in_call_recording') return 'human';
  if (ENDED_EVENTS.has(job.eventType)) return 'ended';
  if (JOINING_EVENTS.has(job.eventType)) return 'joining';
  // The parser admits only the eleven events above; a twelfth is a programming error.
  return unexpected();
}

type Match =
  | { readonly kind: 'current'; readonly booking: R1MeetBooking }
  | { readonly kind: 'stray'; readonly booking: R1MeetBooking | null; readonly bookingId: string }
  | { readonly kind: 'unknown' };

/** D-S06-22: the named booking first, else the booking that holds the bot. */
async function matchBooking(deps: R1MeetFlowDeps, job: R1MeetRecallEventJob): Promise<Match> {
  let booking = job.bookingId === null ? null : await deps.store.getBooking(job.bookingId);
  booking ??= await deps.store.getBookingByBot(job.recallBotId);
  if (booking !== null && booking.recallBotId === job.recallBotId) return { kind: 'current', booking };
  if (job.bookingId === null) return { kind: 'unknown' };
  return { kind: 'stray', booking, bookingId: job.bookingId };
}

/** D-S06-23 (see the header). */
async function strayBot(
  deps: R1MeetFlowDeps,
  job: R1MeetRecallEventJob,
  match: Extract<Match, { kind: 'stray' }>,
  meta: Meta,
): Promise<R1MeetJobResult> {
  if (ENDED_EVENTS.has(job.eventType)) return r1MeetIgnored('stray_ended');
  const booking = match.booking;
  if (booking !== null && booking.status === 'pending') {
    if (meta.deferCount < R1_MEET_STRAY_MAX_DEFERS && canDeferR1MeetJob(meta, deps.now())) {
      // The create may have returned and its attach not yet run: give it time.
      return r1MeetDefer('stray_pending', R1_MEET_STRAY_DEFER_SEC);
    }
    const rotated = await deps.store.setBot({
      bookingId: booking.id,
      action: 'rotate_key',
      expectedVersion: booking.version,
      expectedKeyAttempt: booking.keyAttempt,
      nowIso: toIso(deps.now()),
    });
    // Any other answer means the booking moved on (attached, exhausted): the release job checks the holder.
    if (rotated.status === 'invalid_action' || rotated.status === 'invalid_request') unexpected();
  }
  deps.log.error({
    error_category: R1_MEET_ALERTS.strayBot,
    error_type: booking === null ? 'booking_gone' : booking.status,
  });
  await deps.enqueue(r1MeetJobs.botRelease(job.recallBotId, match.bookingId));
  return r1MeetProcessed('stray_bot');
}

async function joining(deps: R1MeetFlowDeps, booking: R1MeetBooking): Promise<Step> {
  if (booking.status !== 'bot_scheduled') return r1MeetIgnored('no_change');
  const answer = await deps.store.transition({
    bookingId: booking.id,
    from: 'bot_scheduled',
    to: 'bot_joining',
    reason: 'eligible',
    nowIso: toIso(deps.now()),
  });
  if (answer.status === 'status_conflict') return AGAIN;
  if (answer.status === 'not_found') return r1MeetIgnored('booking_gone');
  if (answer.status !== 'ok') return unexpected();
  hotJoining(deps, booking);
  return r1MeetProcessed('bot_joining');
}

/** Two or more humans: one check 120 s later (dedup per bot generation). */
async function queueHumanCheck(deps: R1MeetFlowDeps, job: R1MeetRecallEventJob, booking: R1MeetBooking): Promise<void> {
  const humans = countHumans(await deps.store.participantEvents(job.recallBotId));
  if (humans <= 1) return;
  await deps.enqueue(r1MeetJobs.multiHumanCheck(booking.id, booking.version), {
    scheduledAt: toIso(deps.now() + R1_MEET_MULTI_HUMAN_CHECK_DELAY_SEC * SECOND_MS),
  });
}

/** D-S06-25 (see the header). */
async function humanPresent(
  deps: R1MeetFlowDeps,
  job: R1MeetRecallEventJob,
  booking: R1MeetBooking,
  meta: R1MeetJobMeta,
): Promise<Step> {
  let winner = false;
  if (booking.status === 'bot_scheduled' || booking.status === 'bot_joining') {
    const answer = await deps.store.transition({
      bookingId: booking.id,
      from: booking.status,
      to: 'human_present',
      reason: 'eligible',
      nowIso: toIso(deps.now()),
    });
    if (answer.status === 'status_conflict') return AGAIN;
    if (answer.status === 'not_found') return r1MeetIgnored('booking_gone');
    if (answer.status !== 'ok') return unexpected();
    winner = true;
  }
  // Counted BEFORE the arm: a failed read throws before anything is armed, and the re-run arms.
  if (job.eventType === 'participant_events.join') await queueHumanCheck(deps, job, booking);
  // The page already claimed a ticket (in_call): the bridge check of that arm watches it.
  if (booking.status === 'in_call') return r1MeetIgnored('in_call');

  const arrived = winner ? r1MeetProcessed('human_present') : r1MeetIgnored('already_present');
  // A fresh duplicate signal never arms: the winner did, or will on its re-run.
  if (!winner && !meta.isRerun) return arrived;
  if (booking.ticketClaimedAt !== null) return arrived;
  if (booking.ticketNotBefore !== null) {
    if (deps.config.armAtCreate) {
      // The bot already shows the page of the create-time ticket: watch it instead of replacing it.
      if (booking.ticketArms >= 1) {
        await deps.enqueue(r1MeetJobs.bridgeCheck(booking.id, booking.version, booking.ticketArms), {
          scheduledAt: toIso(deps.now() + R1_MEET_BRIDGE_CHECK_DELAY_SEC * SECOND_MS),
        });
      }
      return arrived;
    }
    // Armed a moment ago: that is a live page being loaded, not a crashed run.
    if (deps.now() - Date.parse(booking.updatedAt) < R1_MEET_REARM_UNTOUCHED_MS) return arrived;
  }
  return armBridge(deps, booking, meta);
}

/** D-S06-24, terminal events: the failed reason of a live booking, or null for no move. */
function endedReason(job: R1MeetRecallEventJob, booking: R1MeetBooking): R1MeetBookingReason | null {
  switch (booking.status) {
    case 'bot_scheduled':
    case 'bot_joining':
      return job.eventType === 'bot.fatal' || (job.subCode !== null && FATAL_SUB_CODES.has(job.subCode))
        ? 'bot_fatal'
        : 'no_show';
    case 'human_present':
      return 'bot_fatal';
    case 'in_call':
      // With a session the attempt is running (or settling): its own outcome decides.
      return booking.sessionId === null ? 'admission_refused' : null;
    default:
      return null;
  }
}

async function ended(
  deps: R1MeetFlowDeps,
  job: R1MeetRecallEventJob,
  booking: R1MeetBooking,
  meta: Meta,
): Promise<Step> {
  const eventReason = endedReason(job, booking);
  if (eventReason === null) return r1MeetIgnored('attempt_decides');
  if (job.subCode === R1_MEET_OWN_LEAVE_SUB_CODE && meta.deferCount === 0 && canDeferR1MeetJob(meta, deps.now())) {
    // Probably our own leave: let the job that sent it mark the booking first.
    return r1MeetDefer('own_leave', R1_MEET_OWN_LEAVE_DEFER_SEC);
  }
  const botId = booking.recallBotId!;
  const preHuman = PRE_HUMAN.has(booking.status);
  let reason: R1MeetBookingReason = eventReason;
  // D-S09-4(a): the event's own sub-code first, else the oldest listed one in the history read below.
  let alertSubCode = preHuman && r1MeetBotAlertFor(job.subCode) !== null ? job.subCode : null;
  // What the read before the move already settled about the release; null = ask Recall after it.
  let releasedAs: 'gone' | 'ended' | null = null;
  if (preHuman && eventReason === 'no_show') {
    // D-S09-3: the event alone says no-show. Recall first, the database second: read the bot ONCE.
    let bot: RecallBot | null = null;
    try {
      bot = await deps.recall.getBot(botId);
    } catch (error) {
      // Nothing is guessed: the booking stays live and the job defers (or throws) before the move.
      if (!(isRecallError(error) && error.category === 'not_found')) {
        return r1MeetRecallFailure(error, { meta, nowMs: deps.now(), log: deps.log });
      }
      // Recall no longer knows the bot: the event's own reason, and nothing is left to release.
      releasedAs = 'gone';
    }
    if (bot !== null) {
      const verdict = r1MeetPreCallVerdict(bot.statusChanges);
      if (verdict.botFailed) reason = 'bot_fatal';
      alertSubCode ??= verdict.alertSubCode;
      if (r1MeetBotEnded(bot)) releasedAs = 'ended';
    }
  }
  const answer = await deps.store.transition({
    bookingId: booking.id,
    from: booking.status,
    to: 'failed',
    reason,
    nowIso: toIso(deps.now()),
  });
  if (answer.status === 'status_conflict') return AGAIN;
  if (answer.status === 'not_found') return r1MeetIgnored('booking_gone');
  if (answer.status !== 'ok') return unexpected();
  // THIS job's move won (a lost one returned above): one alert per booking, never on a no-show.
  const alert = reason === 'bot_fatal' ? r1MeetBotAlertFor(alertSubCode) : null;
  if (alert !== null) deps.log.error({ error_category: alert, error_type: alertSubCode! });
  if (releasedAs === null) {
    // The bot is usually over, so the GET says ended and nothing else is sent; a re-run settles a
    // lost mark.
    const released = await release(deps, botId, meta);
    if ('result' in released) return released.result;
  }
  await markReleased(deps, booking);
  return r1MeetProcessed(`failed_${reason}`);
}

async function currentBotEvent(
  deps: R1MeetFlowDeps,
  job: R1MeetRecallEventJob,
  booking: R1MeetBooking,
  meta: R1MeetJobMeta,
): Promise<Step> {
  const kind = classify(job);
  if (TERMINAL.has(booking.status)) {
    // An owed release: a terminal event finishes it here; a live one gets its own release job.
    if (kind === 'ended') return settleOwedRelease(deps, booking, meta);
    await deps.enqueue(r1MeetJobs.botRelease(job.recallBotId, booking.id));
    return r1MeetProcessed('release_queued');
  }
  // 0142's bot binding: only these statuses hold a bot. Anything else is not a call.
  if (!HOLDS_BOT.has(booking.status)) return r1MeetIgnored('not_dispatchable');
  hotFor(deps, booking);
  switch (kind) {
    case 'joining':
      return joining(deps, booking);
    case 'human':
      return humanPresent(deps, job, booking, meta);
    case 'ended':
      return ended(deps, job, booking, meta);
    case 'bot_participant':
      return r1MeetIgnored('bot_participant');
    case 'participant_left':
      return r1MeetIgnored('participant_left');
  }
}

/** `recall_event` (S03): one bot status change or participant event (D-S06-22..25, 28). */
export const r1MeetRecallEventDefinition: R1MeetJobDefinition<R1MeetRecallEventJob> = Object.freeze({
  kind: 'recall_event',
  parse: parseRecallEventJob,
  async run(deps: R1MeetFlowDeps, job: R1MeetRecallEventJob, meta: R1MeetJobMeta): Promise<R1MeetJobResult> {
    // D-S09-4(b): at most one waiting-room alert per run, whatever the compare-and-set retries do.
    let waitingRoomAlerted = false;
    for (let pass = 0; pass < R1_MEET_EVENT_MAX_PASSES; pass += 1) {
      const match = await matchBooking(deps, job);
      // Not one of ours: never touched (no Recall call, no job).
      if (match.kind === 'unknown') return r1MeetIgnored('unknown_bot');
      if (match.kind === 'stray') return strayBot(deps, job, match, meta);
      if (
        !waitingRoomAlerted
        && job.eventType === 'bot.in_waiting_room'
        && !meta.isRerun
        && HOLDS_BOT.has(match.booking.status)
      ) {
        // The live booking's own bot is held at the door: the meeting is not OPEN (or nobody admits
        // Dex). Receipts de-duplicate redeliveries, so a fresh run is one Recall status change.
        waitingRoomAlerted = true;
        deps.log.error({ error_category: R1_MEET_ALERTS.botWaitingRoom });
      }
      const step = await currentBotEvent(deps, job, match.booking, meta);
      if (step !== AGAIN) return step;
    }
    throw new R1MeetJobError(R1_MEET_CONFLICT);
  },
});

// ── attempt_ended ───────────────────────────────────────────────────────────

const COMPLETE: EndTarget = (status) => (status === 'in_call' ? { to: 'completed', reason: 'attempt_settled' } : null);
/** An attempt that did not count and cannot be retried in this call: a failure HR can act on. */
const UNCOUNTED = (reason: 'no_show' | 'bot_fatal'): EndTarget => (status) =>
  status === 'in_call' ? { to: 'failed', reason } : null;

/**
 * Recovery of an attempt that did not count (D-S06-29, PR #444 review S06-R1, the S05 and S07
 * hand-offs): one more arm while the round can admit an attempt, the claim window is open, an arm is
 * left and a human is still in the call. Each line is checked in this order; the first that fails ends
 * the call with the reason it names.
 */
async function recoverOrEnd(
  deps: R1MeetFlowDeps,
  booking: R1MeetBooking,
  meta: R1MeetJobMeta,
): Promise<R1MeetJobResult> {
  const nowMs = deps.now();
  const round = booking.roundId === null ? 'closed' : await deps.store.roundStart(booking.roundId, nowMs);
  // Its counted attempts are all used (an earlier attempt counted): the round's result is settled.
  if (round === 'complete') return endCall(deps, booking, COMPLETE, meta, 'completed');
  // Nobody left to interview: a new attempt would only spend one of the candidate's starts.
  const humans = countHumans(await deps.store.participantEvents(booking.recallBotId!));
  if (humans === 0) return endCall(deps, booking, UNCOUNTED('no_show'), meta, 'failed_no_show');
  if (
    round === 'closed'
    || booking.ticketArms >= R1_MEET_MAX_TICKET_ARMS
    || nowMs >= Date.parse(booking.endAt) + R1_MEET_TICKET_TAIL_SEC * SECOND_MS
  ) {
    return endCall(deps, booking, UNCOUNTED('bot_fatal'), meta, 'failed_bot_fatal');
  }
  if (booking.ticketClaimedAt === null && booking.ticketNotBefore !== null) {
    // A re-arm after this session's end is already out (another job's, or this job's earlier run):
    // its bridge check watches it. A re-run replaces it only once nobody touched it for 20 s, as at
    // human-present; a fresh job leaves it to its check for that check's whole horizon.
    const untouchedMs = nowMs - Date.parse(booking.updatedAt);
    if (untouchedMs < (meta.isRerun ? R1_MEET_REARM_UNTOUCHED_MS : R1_MEET_REARM_WATCH_MS)) {
      return r1MeetIgnored('rearm_pending');
    }
  }
  hotFor(deps, booking);
  const armed = await armBridge(deps, booking, meta);
  if (armed.outcome === 'defer') return armed;
  if (armed.receipt === 'processed') return r1MeetProcessed('rearmed');
  // The bot is no longer in the call, or no page could be armed or shown: end it.
  const left = armed.code === 'bot_gone' || armed.code === 'bot_ended';
  return left
    ? endCall(deps, booking, UNCOUNTED('no_show'), meta, 'failed_no_show')
    : endCall(deps, booking, UNCOUNTED('bot_fatal'), meta, 'failed_bot_fatal');
}

/**
 * `attempt_ended` (the attempt-outcome route, the bridge check, maintenance): the attempt of the
 * booking's bound session is over (D-S06-29). A COUNTED attempt ends the call: leave, then
 * `completed/attempt_settled`, then the release. One that did NOT count is recovered when the call can
 * take another attempt (`recoverOrEnd`), else the call ends as `failed/no_show` (nobody left) or
 * `failed/bot_fatal`. An attempt not settled yet waits for the worker's outcome (30 s, at most 4
 * times); then a `completed` session ends the call as completed, a live one is left alone, and an
 * ended one counts as not counted.
 */
export const r1MeetAttemptEndedDefinition: R1MeetJobDefinition<R1MeetAttemptEndedJob> = Object.freeze({
  kind: 'attempt_ended',
  parse: parseAttemptEndedJob,
  async run(deps: R1MeetFlowDeps, job: R1MeetAttemptEndedJob, meta: R1MeetJobMeta): Promise<R1MeetJobResult> {
    const booking = await deps.store.getBooking(job.bookingId);
    if (booking === null) return r1MeetIgnored('booking_gone');
    // A later session of the round (a restart) re-bound the booking: this outcome is not its call's.
    if (booking.sessionId !== job.sessionId) return r1MeetIgnored('other_session');
    if (TERMINAL.has(booking.status)) {
      // A run that died after the move: finish the release.
      return booking.recallBotId === null ? r1MeetIgnored('booking_terminal') : settleOwedRelease(deps, booking, meta);
    }
    if (booking.status !== 'in_call') return r1MeetIgnored('not_in_call');

    const settlement = await deps.store.attemptSettlement(job.sessionId);
    if (settlement !== null && settlement.counted) return endCall(deps, booking, COMPLETE, meta, 'completed');
    if (settlement === null || settlement.outcome === null) {
      // Not settled: the worker's outcome is on its way (its route queues this same job, which the
      // dedup key collapses into this one). Wait for it, bounded.
      if (meta.deferCount < R1_MEET_OUTCOME_WAIT_MAX && canDeferR1MeetJob(meta, deps.now())) {
        return r1MeetDefer('outcome_pending', R1_MEET_OUTCOME_WAIT_SEC);
      }
      const session = await deps.store.sessionStatus(job.sessionId);
      // The interview ran to its end; only the report of it is missing.
      if (session === 'completed') return endCall(deps, booking, COMPLETE, meta, 'completed');
      // Still running: its own outcome will queue this job again.
      if (session !== null && !ENDED_SESSIONS.has(session)) return r1MeetIgnored('session_live');
    }
    return recoverOrEnd(deps, booking, meta);
  },
});

// ── multi_human_check ───────────────────────────────────────────────────────

const MULTIPLE_HUMANS: EndTarget = (status) => (DISPATCHED.has(status) ? { to: 'failed', reason: 'multiple_humans' } : null);

/** `multi_human_check` (S06): still more than one human 120 s after the join (D-S06-28). */
export const r1MeetMultiHumanCheckDefinition: R1MeetJobDefinition<R1MeetMultiHumanCheckJob> = Object.freeze({
  kind: 'multi_human_check',
  parse: parseMultiHumanCheckJob,
  async run(deps: R1MeetFlowDeps, job: R1MeetMultiHumanCheckJob, meta: R1MeetJobMeta): Promise<R1MeetJobResult> {
    const booking = await deps.store.getBooking(job.bookingId);
    if (booking === null) return r1MeetIgnored('booking_gone');
    if (booking.version !== job.version) return r1MeetIgnored('generation_changed');
    if (TERMINAL.has(booking.status)) {
      return booking.recallBotId === null ? r1MeetIgnored('booking_terminal') : settleOwedRelease(deps, booking, meta);
    }
    if (!DISPATCHED.has(booking.status) || booking.recallBotId === null) return r1MeetIgnored('not_in_call');
    hotFor(deps, booking);
    const humans = countHumans(await deps.store.participantEvents(booking.recallBotId));
    if (humans <= 1) return r1MeetIgnored('one_human');
    if (deps.config.multiHumanPolicy === 'observe') {
      deps.log.warn({ error_category: 'r1_meet_multi_human_observed' });
      return r1MeetIgnored('observed');
    }
    deps.log.error({ error_category: R1_MEET_ALERTS.multipleHumans });
    return endCall(deps, booking, MULTIPLE_HUMANS, meta, 'multiple_humans');
  },
});

// ── bridge_check ────────────────────────────────────────────────────────────

const GIVE_UP: EndTarget = (status) => {
  if (status === 'in_call') return { to: 'failed', reason: 'admission_refused' };
  return HOLDS_BOT.has(status) ? { to: 'failed', reason: 'bot_fatal' } : null;
};

/** `bridge_check` (S06, 45 s after each arm): recover a page that never got into the call (D-S06-27). */
export const r1MeetBridgeCheckDefinition: R1MeetJobDefinition<R1MeetBridgeCheckJob> = Object.freeze({
  kind: 'bridge_check',
  parse: parseBridgeCheckJob,
  async run(deps: R1MeetFlowDeps, job: R1MeetBridgeCheckJob, meta: R1MeetJobMeta): Promise<R1MeetJobResult> {
    const booking = await deps.store.getBooking(job.bookingId);
    if (booking !== null && booking.version === job.version && TERMINAL.has(booking.status) && booking.recallBotId !== null) {
      // A give-up that died after its move: finish the release.
      return settleOwedRelease(deps, booking, meta);
    }
    const sessionStatus = booking?.sessionId ? await deps.store.sessionStatus(booking.sessionId) : null;
    const nowMs = deps.now();
    const decision = decideBridgeCheck({
      booking,
      check: job,
      sessionStatus,
      armedAtMs: Date.parse(meta.createdAt),
      nowMs,
    });
    if (booking !== null && HOLDS_BOT.has(booking.status)) hotFor(deps, booking);
    switch (decision.action) {
      case 'done':
        if (decision.code === 'session_ended' && booking !== null && booking.sessionId !== null) {
          // A session that ended before it ran may have no outcome on its way (no worker joined):
          // hand it to `attempt_ended` now, not at the next maintenance bucket. Deduplicated per
          // session, so the outcome route's own job is the same one.
          await deps.enqueue(r1MeetJobs.attemptEnded(booking.id, booking.sessionId));
        }
        return r1MeetIgnored(decision.code);
      case 'recheck':
        if (meta.deferCount >= R1_MEET_BRIDGE_MAX_RECHECKS || !canDeferR1MeetJob(meta, nowMs)) {
          return r1MeetIgnored('recheck_limit');
        }
        return r1MeetDefer('bridge_recheck', decision.delaySeconds);
      case 'rearm':
        return armBridge(deps, booking!, meta);
      case 'give_up':
        deps.log.error({ error_category: R1_MEET_ALERTS.bridgeGaveUp, error_type: decision.code });
        return endCall(deps, booking!, GIVE_UP, meta, 'bridge_gave_up');
    }
  },
});

/** The four definitions of this file, for the dispatcher. Frozen. */
export const R1_MEET_EVENT_DEFINITIONS: readonly R1MeetJobDefinition[] = Object.freeze([
  r1MeetRecallEventDefinition,
  r1MeetAttemptEndedDefinition,
  r1MeetBridgeCheckDefinition,
  r1MeetMultiHumanCheckDefinition,
] as R1MeetJobDefinition[]);
