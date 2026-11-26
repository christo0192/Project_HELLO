/**
 * The database port of the `r1-meet` runtime (M034 S06, dark): every read and write the Meet handlers
 * make, as narrow methods over `screening_v2.r1_meet_bookings`, its receipts and the 0142 RPCs.
 *
 * WHY A PORT. The handlers decide from closed, parsed values and never from raw rows or jsonb, so a
 * drifted column or answer stops the job instead of steering a bot. Two codes, and nothing else, are
 * thrown (`R1MeetJobError`: the code is the whole message):
 *   r1_meet_db_error        the database refused or failed, or a row is not what 0142 allows;
 *   r1_meet_rpc_unexpected  an RPC answered a status or a shape this build does not know.
 * Both fail the job under its lease: bounded retries, then the dead-letter queue. A missing row is
 * never an error: single reads answer null.
 *
 * WHAT IS NEVER READ. `ticket_digest` (the exchange owns it, S05) and `candidate_id` (no decision here
 * needs it). Nothing here logs, and no row value, id or driver text is put in an error.
 *
 * WHAT IS NORMALISED. `uuid` columns come back lower-cased; the Ashby ids of `text` columns verbatim
 * (they are matched exactly against the application links); every instant as `toISOString()`. The
 * instants are lossless here: each one was written from a millisecond `p_now` or Ashby time, so a
 * booking's slot compares with a job's slot as plain strings, and replaying the stored slot into the
 * create RPC never reads as a moved one.
 *
 * TWO SOURCES (M035). A booking is `ashby` (HR scheduled it in Ashby with Dex) or `public_page` (the
 * candidate booked it on the public R1 booking page). `R1MeetBooking` is a union on `source`: the three
 * Ashby schedule ids (event, schedule, scheduler) are all set for `ashby` and all null for `public_page`,
 * exactly 0143's `chk_r1_meet_bookings_source_ids`, and a row that mixes them fails `r1_meet_db_error`.
 * The reads by an Ashby event or schedule id answer the Ashby member only. Readers narrow on `source`;
 * nothing casts past the null.
 *
 * COMPARE AND SET. State changes only through the RPCs (under the booking row lock, 0142); the one
 * direct write is the receipt, guarded by its own outcome. Two jobs of one booking may run at once.
 *
 * THE RPC VOCABULARY is pinned to migration 0142 by `r1-meet-runtime-store.test.ts`: the argument
 * names and every status of the catalog comments.
 *
 * The client is an argument (type-only import of `lib/supabase`): loading this module reads no
 * environment and performs no I/O.
 */

import { normalizeGoogleMeetUrl } from '../../../integrations/google-meet/url.js';
import type { supabase } from '../../supabase.js';
import {
  R1_MEET_BOOKING_REASONS,
  R1_MEET_BOOKING_SOURCES,
  R1_MEET_BOOKING_STATUSES,
  type R1MeetBookingReason,
  type R1MeetBookingSource,
  type R1MeetBookingStatus,
} from './bookings-read.js';
import {
  R1MeetJobError,
  R1_MEET_DB_ERROR,
  R1_MEET_MAX_TICKET_ARMS,
  R1_MEET_MAX_VERSION,
  R1_MEET_QUEUE,
  R1_MEET_RECALL_PARTICIPANT_EVENTS,
  R1_MEET_RPC_UNEXPECTED,
} from './jobs.js';
import { parseR1MeetInstant } from './ticket.js';

type Db = typeof supabase;

// ── The status machine, by what a bot of that status can be ──────────────────

/** No bot, or one Recall has not dispatched yet. Frozen. */
export const R1_MEET_UNDISPATCHED_STATUSES = Object.freeze([
  'pending',
  'unmatched_application',
  'unmapped_scheduler',
  'blocked',
  'bot_scheduled',
] as const satisfies readonly R1MeetBookingStatus[]);
/** The bot is in, or on its way into, the call. Frozen. */
export const R1_MEET_DISPATCHED_STATUSES = Object.freeze([
  'bot_joining',
  'human_present',
  'in_call',
] as const satisfies readonly R1MeetBookingStatus[]);
export const R1_MEET_LIVE_STATUSES: readonly R1MeetBookingStatus[] = Object.freeze([
  ...R1_MEET_UNDISPATCHED_STATUSES,
  ...R1_MEET_DISPATCHED_STATUSES,
]);
/** History; `recall_bot_id` stays until its release is confirmed (an owed release). Frozen. */
export const R1_MEET_TERMINAL_STATUSES = Object.freeze([
  'completed',
  'cancelled',
  'failed',
  'drained',
] as const satisfies readonly R1MeetBookingStatus[]);
/** What the drain acts on: the bookings that hold a bot, or are about to get one. Frozen. */
export const R1_MEET_DRAINABLE_STATUSES = Object.freeze([
  'pending',
  'bot_scheduled',
  'bot_joining',
  'human_present',
  'in_call',
] as const satisfies readonly R1MeetBookingStatus[]);

/**
 * The bookings that used a bot (D-S06-16): the status and the reason families that only follow an
 * attached bot. `failed` alone is not enough: `in_past`, `bot_create_failed` and `round_expired` never
 * had one, and a cancelled booking's bot was removed. Frozen.
 */
export const R1_MEET_CAP_STATUSES = Object.freeze([
  'bot_scheduled',
  'bot_joining',
  'human_present',
  'in_call',
  'completed',
  'failed',
] as const satisfies readonly R1MeetBookingStatus[]);
export const R1_MEET_CAP_REASONS = Object.freeze([
  'eligible',
  'attempt_settled',
  'bot_fatal',
  'no_show',
  'admission_refused',
  'multiple_humans',
] as const satisfies readonly R1MeetBookingReason[]);

/** 0142's own default of `p_expiry_grace_sec`, sent explicitly so a change of it is a change here. */
export const R1_MEET_ROUND_EXPIRY_GRACE_SEC = 7200;

const KEY_ATTEMPT_MAX = 20;
const LIVE_BY_SCHEDULE_LIMIT = 100;
const RECEIPT_WINDOW = 100;
const PARTICIPANT_EVENT_LIMIT = 500;

// ── Shapes ──────────────────────────────────────────────────────────────────

/** Exactly what a booking read selects. Never `ticket_digest`, never `candidate_id`. */
export const R1_MEET_BOOKING_COLUMNS =
  'id, ashby_interview_event_id, ashby_schedule_id, ashby_application_id, ashby_interview_stage_id, '
  + 'ashby_interview_id, ashby_scheduled_by_user_id, ashby_updated_at, round_id, objective_profile, status, '
  + 'reason, version, key_attempt, meet_url, start_at, end_at, recall_bot_id, ticket_not_before, '
  + 'ticket_expires_at, ticket_claimed_at, ticket_arms, session_id, created_at, updated_at, source';

/**
 * What every booking carries, whichever way it was booked. `applicationId` is always the matched Ashby
 * application (a public booking keeps it too, so Dex's card lands on the right application).
 */
interface R1MeetBookingBase {
  readonly id: string;
  readonly applicationId: string;
  readonly interviewStageId: string | null;
  readonly interviewId: string | null;
  readonly ashbyUpdatedAt: string | null;
  readonly roundId: string | null;
  readonly objectiveProfile: string;
  readonly status: R1MeetBookingStatus;
  readonly reason: R1MeetBookingReason;
  /** The bot generation and its Idempotency-Key attempt. */
  readonly version: number;
  readonly keyAttempt: number;
  /** A meeting access link. Confidential: never logged, never in a payload S06 writes. */
  readonly meetUrl: string;
  readonly startAt: string;
  readonly endAt: string;
  readonly recallBotId: string | null;
  readonly ticketNotBefore: string | null;
  readonly ticketExpiresAt: string | null;
  readonly ticketClaimedAt: string | null;
  readonly ticketArms: number;
  readonly sessionId: string | null;
  readonly createdAt: string;
  readonly updatedAt: string;
}

/** A slot HR scheduled in Ashby with Dex (M034): the three Ashby schedule ids are always set. */
export interface R1MeetAshbyBooking extends R1MeetBookingBase {
  readonly source: 'ashby';
  readonly eventId: string;
  readonly scheduleId: string;
  /** The consent attester (D-M034-11). Confidential. */
  readonly scheduledByUserId: string;
}

/**
 * A slot the candidate booked on the public R1 booking page (M035): there is no Ashby schedule, so the
 * three schedule ids are always null (0143's `chk_r1_meet_bookings_source_ids`).
 */
export interface R1MeetPublicBooking extends R1MeetBookingBase {
  readonly source: 'public_page';
  readonly eventId: null;
  readonly scheduleId: null;
  readonly scheduledByUserId: null;
}

/** One booking as the runtime reads it: narrow on `source` before reading an Ashby schedule id. */
export type R1MeetBooking = R1MeetAshbyBooking | R1MeetPublicBooking;

/** `chk_call_sessions_status` (0006). Frozen. */
export const R1_MEET_SESSION_STATUSES = Object.freeze([
  'created',
  'waiting',
  'in_progress',
  'completed',
  'failed',
  'cancelled',
  'expired',
] as const);
export type R1MeetSessionStatus = (typeof R1_MEET_SESSION_STATUSES)[number];

/** One participant join or leave of a bot's call. No name, email or platform exists in the payload. */
export interface R1MeetParticipantEventRow {
  readonly type: 'join' | 'leave';
  readonly participantId: number | null;
  readonly isBot: boolean | null;
  readonly occurredAt: string | null;
}

export type R1MeetReceiptFinal = 'processed' | 'ignored' | 'failed';

/** The settlement of one R1 attempt (`interview_round_attempts`, keyed by its session; 0115, 0126). */
export interface R1MeetAttemptSettlement {
  /** The worker's outcome (`r1_settle_attempt`), or null while the attempt is not settled yet. */
  readonly outcome: string | null;
  /** The attempt counts toward the round's result (a full interview, or a role-play the candidate left). */
  readonly counted: boolean;
}

/**
 * Whether a round can admit one more attempt, by `r1_admit_attempt`'s own refusals: `complete` = its
 * counted attempts are all used (the round's result is settled), `closed` = not live by 0142's
 * definition (Meet, invited or in progress, not lapsed) or its 3 starts are used, else `startable`.
 */
export type R1MeetRoundStart = 'startable' | 'complete' | 'closed';

/** `chk interview_rounds.starts_used <= 3` (0115): a round admits at most this many starts. */
export const R1_MEET_ROUND_MAX_STARTS = 3;

interface InvalidRequest {
  readonly status: 'invalid_request';
  readonly field: string;
}
interface BookingTerminal {
  readonly status: 'booking_terminal';
  readonly bookingId: string;
  readonly bookingStatus: R1MeetBookingStatus;
  readonly reason: R1MeetBookingReason;
}

export interface R1MeetCreateRoundInput {
  readonly eventId: string;
  readonly scheduleId: string;
  readonly applicationId: string;
  readonly interviewStageId: string | null;
  readonly interviewId: string | null;
  readonly scheduledByUserId: string;
  readonly attestedAt: string;
  readonly ashbyUpdatedAt: string | null;
  readonly meetUrl: string;
  readonly startAt: string;
  readonly endAt: string;
  /** Our staff user, or null (the RPC then records `unmapped_scheduler`). */
  readonly createdBy: string | null;
  readonly objectiveProfile: string;
  readonly nowIso: string;
}

export type R1MeetCreateAnswer =
  | {
      readonly status: 'created' | 'relinked';
      readonly bookingId: string;
      readonly roundId: string;
      readonly version: number;
      readonly keyAttempt: number;
      readonly roundExpiresAt: string;
      readonly objectiveProfile: string;
      /** The booking got a new generation on a new round (a re-bind or a revival). */
      readonly rebound: boolean;
    }
  | {
      readonly status: 'exists';
      readonly bookingId: string;
      readonly roundId: string;
      readonly bookingStatus: R1MeetBookingStatus;
      readonly reason: R1MeetBookingReason;
      readonly version: number;
      readonly keyAttempt: number;
      readonly roundExpiresAt: string | null;
      readonly roundLive: boolean;
      readonly objectiveProfile: string;
    }
  | BookingTerminal
  | { readonly status: 'stale_update'; readonly bookingId: string }
  | {
      readonly status: 'bot_attached';
      readonly bookingId: string;
      readonly bookingStatus: R1MeetBookingStatus;
      readonly version: number;
      readonly keyAttempt: number;
    }
  | { readonly status: 'version_exhausted'; readonly bookingId: string; readonly version: number }
  | {
      readonly status: 'unmatched_application' | 'unmapped_scheduler' | 'blocked';
      readonly bookingId: string;
      readonly reason: R1MeetBookingReason;
      /** Set exactly for `slot_too_far`: when the slot comes within reach. */
      readonly retryAfter: string | null;
      readonly rebound: boolean;
    }
  | { readonly status: 'in_past'; readonly bookingId: string | null }
  | InvalidRequest;

export interface R1MeetRescheduleInput {
  readonly bookingId: string;
  readonly expectedVersion: number;
  readonly startAt: string;
  readonly endAt: string;
  readonly meetUrl: string;
  readonly ashbyUpdatedAt: string | null;
  readonly nowIso: string;
}

export type R1MeetRescheduleAnswer =
  | {
      readonly status: 'ok';
      readonly bookingId: string;
      readonly version: number;
      readonly keyAttempt: number;
      readonly roundExpiresAt: string;
    }
  | {
      readonly status: 'version_conflict' | 'bot_attached';
      readonly bookingId: string;
      readonly version: number;
      readonly keyAttempt: number;
    }
  | BookingTerminal
  | {
      readonly status: 'no_round';
      readonly bookingId: string;
      readonly bookingStatus: R1MeetBookingStatus;
      readonly reason: R1MeetBookingReason;
    }
  | {
      readonly status: 'booking_dispatched' | 'not_allowed';
      readonly bookingId: string;
      readonly bookingStatus: R1MeetBookingStatus;
    }
  | { readonly status: 'stale_update' | 'in_past'; readonly bookingId: string }
  | { readonly status: 'slot_too_far'; readonly bookingId: string; readonly retryAfter: string }
  | { readonly status: 'version_exhausted'; readonly bookingId: string; readonly version: number }
  | { readonly status: 'round_not_live'; readonly bookingId: string; readonly roundId: string }
  | { readonly status: 'not_found' }
  | InvalidRequest;

/** The reasons `r1_meet_cancel_booking` accepts. Frozen. */
export const R1_MEET_CANCEL_REASONS = Object.freeze([
  'cancelled',
  'dex_absent',
  'event_removed',
  'round_cancelled',
] as const satisfies readonly R1MeetBookingReason[]);
export type R1MeetCancelReason = (typeof R1_MEET_CANCEL_REASONS)[number];

export type R1MeetCancelAnswer =
  | {
      readonly status: 'ok';
      readonly bookingId: string;
      readonly previousStatus: R1MeetBookingStatus;
      readonly recallBotId: string | null;
      readonly botDispatched: boolean;
    }
  | {
      readonly status: 'already_cancelled';
      readonly bookingId: string;
      readonly reason: R1MeetBookingReason;
      readonly recallBotId: string | null;
    }
  | BookingTerminal
  | { readonly status: 'not_found' | 'invalid_reason' }
  | InvalidRequest;

export type R1MeetSetBotInput = {
  readonly bookingId: string;
  /** Both counters as the caller last read them: the RPC compares both. */
  readonly expectedVersion: number;
  readonly expectedKeyAttempt: number;
  readonly nowIso: string;
} & (
  | { readonly action: 'attach'; readonly recallBotId: string }
  | { readonly action: 'rotate_key' | 'replace' | 'release' }
);

const SET_BOT_STATE_ANSWERS = Object.freeze([
  'ok',
  'duplicate',
  'bot_conflict',
  'bot_in_use',
  'not_allowed',
  'in_past',
  'round_not_live',
  'key_attempts_exhausted',
  'version_exhausted',
  'version_conflict',
] as const);

export type R1MeetSetBotAnswer =
  | {
      readonly status: (typeof SET_BOT_STATE_ANSWERS)[number];
      readonly bookingId: string;
      /** The booking as the RPC left it. */
      readonly version: number;
      readonly keyAttempt: number;
      readonly bookingStatus: R1MeetBookingStatus;
    }
  | { readonly status: 'not_found' | 'invalid_action' }
  | InvalidRequest;

export interface R1MeetTransitionInput {
  readonly bookingId: string;
  readonly from: R1MeetBookingStatus;
  readonly to: R1MeetBookingStatus;
  readonly reason: R1MeetBookingReason;
  readonly nowIso: string;
}

export type R1MeetTransitionAnswer =
  | {
      readonly status: 'ok';
      readonly bookingId: string;
      readonly previousStatus: R1MeetBookingStatus;
      readonly recallBotId: string | null;
    }
  | { readonly status: 'status_conflict'; readonly bookingId: string; readonly current: R1MeetBookingStatus }
  | { readonly status: 'invalid_transition'; readonly bookingId: string }
  | { readonly status: 'not_found' }
  | InvalidRequest;

export interface R1MeetArmInput {
  readonly bookingId: string;
  /** The digest only (lib/r1/meet/ticket.ts): the plaintext never comes near the database. */
  readonly ticketDigest: string;
  readonly notBefore: string;
  readonly expiresAt: string;
  readonly nowIso: string;
}

export type R1MeetArmAnswer =
  | {
      readonly status: 'ok' | 'duplicate';
      readonly bookingId: string;
      readonly notBefore: string;
      readonly expiresAt: string;
      readonly ticketArms: number;
    }
  | { readonly status: 'ticket_arms_exhausted'; readonly bookingId: string; readonly ticketArms: number }
  | { readonly status: 'not_armable'; readonly bookingId: string; readonly bookingStatus: R1MeetBookingStatus }
  | { readonly status: 'digest_in_use'; readonly bookingId: string }
  | { readonly status: 'invalid_ticket' | 'invalid_window' | 'not_found' }
  | InvalidRequest;

export interface R1MeetPruneInput {
  readonly olderThan: string;
  readonly limit: number;
  readonly nowIso: string;
}

export type R1MeetPruneAnswer =
  | { readonly status: 'ok'; readonly deleted: number }
  | { readonly status: 'retention_too_short' }
  | InvalidRequest;

/** The closed answers of each RPC, in the order of its 0142 catalog comment. Deep-frozen. */
export const R1_MEET_RPC_ANSWERS = Object.freeze({
  r1_meet_create_round_from_ashby: Object.freeze([
    'created',
    'relinked',
    'exists',
    'booking_terminal',
    'stale_update',
    'bot_attached',
    'version_exhausted',
    'unmatched_application',
    'unmapped_scheduler',
    'blocked',
    'in_past',
    'invalid_request',
  ] as const satisfies readonly R1MeetCreateAnswer['status'][]),
  r1_meet_reschedule_booking: Object.freeze([
    'ok',
    'invalid_request',
    'not_found',
    'booking_terminal',
    'version_conflict',
    'stale_update',
    'booking_dispatched',
    'bot_attached',
    'no_round',
    'not_allowed',
    'in_past',
    'slot_too_far',
    'version_exhausted',
    'round_not_live',
  ] as const satisfies readonly R1MeetRescheduleAnswer['status'][]),
  r1_meet_cancel_booking: Object.freeze([
    'ok',
    'already_cancelled',
    'booking_terminal',
    'not_found',
    'invalid_reason',
    'invalid_request',
  ] as const satisfies readonly R1MeetCancelAnswer['status'][]),
  r1_meet_set_bot: Object.freeze([
    ...SET_BOT_STATE_ANSWERS,
    'not_found',
    'invalid_action',
    'invalid_request',
  ] as const satisfies readonly R1MeetSetBotAnswer['status'][]),
  r1_meet_transition_booking: Object.freeze([
    'ok',
    'status_conflict',
    'invalid_transition',
    'not_found',
    'invalid_request',
  ] as const satisfies readonly R1MeetTransitionAnswer['status'][]),
  r1_meet_arm_ticket: Object.freeze([
    'ok',
    'duplicate',
    'invalid_ticket',
    'invalid_window',
    'not_found',
    'not_armable',
    'digest_in_use',
    'ticket_arms_exhausted',
    'invalid_request',
  ] as const satisfies readonly R1MeetArmAnswer['status'][]),
  r1_meet_prune_receipts: Object.freeze([
    'ok',
    'retention_too_short',
    'invalid_request',
  ] as const satisfies readonly R1MeetPruneAnswer['status'][]),
  r1_meet_prune_bookings: Object.freeze([
    'ok',
    'retention_too_short',
    'invalid_request',
  ] as const satisfies readonly R1MeetPruneAnswer['status'][]),
});
export type R1MeetRpcName = keyof typeof R1_MEET_RPC_ANSWERS;

export interface R1MeetStore {
  getBooking(id: string): Promise<R1MeetBooking | null>;
  /** Only an Ashby booking has an event id (0143): any other row here fails `r1_meet_db_error`. */
  getBookingByEvent(eventId: string): Promise<R1MeetAshbyBooking | null>;
  getBookingByBot(recallBotId: string): Promise<R1MeetBooking | null>;
  /** The booking most recently touched, should a restart ever have bound one session twice. */
  getBookingBySession(sessionId: string): Promise<R1MeetBooking | null>;
  /** Only an Ashby booking has a schedule id (0143): any other row here fails `r1_meet_db_error`. */
  listLiveBySchedule(scheduleId: string): Promise<readonly R1MeetAshbyBooking[]>;
  /** Terminal bookings whose bot is not confirmed released, longest owed first. */
  listOwedReleases(limit: number): Promise<readonly R1MeetBooking[]>;
  /** Live bookings whose slot ended before `endBefore`. */
  listOverdue(endBefore: string, limit: number): Promise<readonly R1MeetBooking[]>;
  listInCall(limit: number): Promise<readonly R1MeetBooking[]>;
  listStuckPending(query: {
    readonly untouchedSince: string;
    readonly startAfter: string;
    readonly limit: number;
  }): Promise<readonly R1MeetBooking[]>;
  listCapBlocked(query: { readonly startAfter: string; readonly limit: number }): Promise<readonly R1MeetBooking[]>;
  /** `untouchedSince` null = however recently it changed (the operator's drain). */
  listDrainable(query: {
    readonly untouchedSince: string | null;
    readonly limit: number;
  }): Promise<readonly R1MeetBooking[]>;
  /** Do the receipts hold a newer delivery of this job's schedule (D-S06-7)? */
  newerAshbyDelivery(job: {
    readonly scheduleId: string;
    readonly ashbyUpdatedAt: string | null;
    readonly receivedAt: string | null;
  }): Promise<boolean>;
  /** The bookings, other than `excludeId`, that used a bot in the slot window `[from, to)`. */
  countBotsInDay(query: { readonly from: string; readonly to: string; readonly excludeId: string }): Promise<number>;
  /** The participant events of one bot, newest first, each receipt once. */
  participantEvents(recallBotId: string): Promise<readonly R1MeetParticipantEventRow[]>;
  sessionStatus(sessionId: string): Promise<R1MeetSessionStatus | null>;
  /** 0142's definition: an invited or in-progress Meet round that has not lapsed. */
  roundLive(roundId: string, nowMs: number): Promise<boolean>;
  /** The attempt of one session (its primary key), or null when the session has none. */
  attemptSettlement(sessionId: string): Promise<R1MeetAttemptSettlement | null>;
  /** Can the round admit one more attempt? A round that is gone is `closed`. */
  roundStart(roundId: string, nowMs: number): Promise<R1MeetRoundStart>;
  /** False when the receipt was already final, or is gone. */
  finishReceipt(id: string, outcome: R1MeetReceiptFinal, nowIso: string): Promise<boolean>;

  createRound(input: R1MeetCreateRoundInput): Promise<R1MeetCreateAnswer>;
  reschedule(input: R1MeetRescheduleInput): Promise<R1MeetRescheduleAnswer>;
  cancel(input: {
    readonly bookingId: string;
    readonly reason: R1MeetCancelReason;
    readonly nowIso: string;
  }): Promise<R1MeetCancelAnswer>;
  setBot(input: R1MeetSetBotInput): Promise<R1MeetSetBotAnswer>;
  transition(input: R1MeetTransitionInput): Promise<R1MeetTransitionAnswer>;
  armTicket(input: R1MeetArmInput): Promise<R1MeetArmAnswer>;
  pruneReceipts(input: R1MeetPruneInput): Promise<R1MeetPruneAnswer>;
  pruneBookings(input: R1MeetPruneInput): Promise<R1MeetPruneAnswer>;
}

// ── The IST day of the daily cap ─────────────────────────────────────────────

const DAY_MS = 24 * 60 * 60 * 1000;
/** India has one zone and no daylight saving: UTC+5:30, so an IST day is 18:30Z to 18:30Z. */
const IST_OFFSET_MS = (5 * 60 + 30) * 60 * 1000;

/** The half-open UTC window `[from, to)` of the IST day that `startAt` falls in, or null for no instant. */
export function r1MeetIstDay(startAt: string): { readonly from: string; readonly to: string } | null {
  const ms = parseR1MeetInstant(startAt);
  if (ms === null) return null;
  const from = Math.floor((ms + IST_OFFSET_MS) / DAY_MS) * DAY_MS - IST_OFFSET_MS;
  return Object.freeze({ from: new Date(from).toISOString(), to: new Date(from + DAY_MS).toISOString() });
}

// ── Reading rows and answers ────────────────────────────────────────────────

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const FIELD = /^[a-z_]{1,40}$/;

function isPlainObject(value: unknown): value is Record<string, unknown> {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return false;
  const proto = Object.getPrototypeOf(value) as unknown;
  return proto === Object.prototype || proto === null;
}

/** Reads one row (or one RPC answer) field by field; anything unexpected throws its one code. */
class FieldReader {
  private readonly data: Record<string, unknown>;

  constructor(data: unknown, private readonly code: string) {
    if (!isPlainObject(data)) throw new R1MeetJobError(code);
    this.data = data;
  }

  fail(): never {
    throw new R1MeetJobError(this.code);
  }

  /** Only null is null: an absent key is drift (the column was selected, the RPC builds the key). */
  orNull<T>(key: string, read: (key: string) => T): T | null {
    return this.data[key] === null ? null : read(key);
  }

  has(key: string): boolean {
    return this.data[key] !== undefined;
  }

  readonly verbatimUuid = (key: string): string => {
    const value = this.data[key];
    return typeof value === 'string' && UUID.test(value) ? value : this.fail();
  };

  readonly uuid = (key: string): string => this.verbatimUuid(key).toLowerCase();

  readonly text = (key: string): string => {
    const value = this.data[key];
    return typeof value === 'string' && value.length > 0 ? value : this.fail();
  };

  readonly instant = (key: string): string => {
    const ms = parseR1MeetInstant(this.data[key]);
    return ms === null ? this.fail() : new Date(ms).toISOString();
  };

  readonly bool = (key: string): boolean => {
    const value = this.data[key];
    return typeof value === 'boolean' ? value : this.fail();
  };

  int(key: string, min: number, max: number): number {
    const value = this.data[key];
    return typeof value === 'number' && Number.isSafeInteger(value) && value >= min && value <= max ? value : this.fail();
  }

  oneOf<T extends string>(key: string, allowed: readonly T[]): T {
    return allowed.find((candidate) => candidate === this.data[key]) ?? this.fail();
  }

  readonly status = (key: string): R1MeetBookingStatus => this.oneOf(key, R1_MEET_BOOKING_STATUSES);
  readonly reason = (key: string): R1MeetBookingReason => this.oneOf(key, R1_MEET_BOOKING_REASONS);
  readonly source = (key: string): R1MeetBookingSource => this.oneOf(key, R1_MEET_BOOKING_SOURCES);
  readonly version = (key: string): number => this.int(key, 0, R1_MEET_MAX_VERSION);
  readonly keyAttempt = (key: string): number => this.int(key, 0, KEY_ATTEMPT_MAX);
  readonly ticketArms = (key: string): number => this.int(key, 0, R1_MEET_MAX_TICKET_ARMS);

  /** `rebound: true`, or no key at all. */
  rebound(): boolean {
    if (!this.has('rebound')) return false;
    return this.bool('rebound') ? true : this.fail();
  }
}

function parseBooking(row: unknown): R1MeetBooking {
  const read = new FieldReader(row, R1_MEET_DB_ERROR);
  const meetUrl = read.text('meet_url');
  if (normalizeGoogleMeetUrl(meetUrl) !== meetUrl) read.fail();
  const source = read.source('source');
  const id = read.uuid('id');
  const eventId = read.orNull('ashby_interview_event_id', read.uuid);
  const scheduleId = read.orNull('ashby_schedule_id', read.verbatimUuid);
  const applicationId = read.verbatimUuid('ashby_application_id');
  const interviewStageId = read.orNull('ashby_interview_stage_id', read.verbatimUuid);
  const interviewId = read.orNull('ashby_interview_id', read.verbatimUuid);
  const scheduledByUserId = read.orNull('ashby_scheduled_by_user_id', read.verbatimUuid);
  const rest = {
    ashbyUpdatedAt: read.orNull('ashby_updated_at', read.instant),
    roundId: read.orNull('round_id', read.uuid),
    objectiveProfile: read.text('objective_profile'),
    status: read.status('status'),
    reason: read.reason('reason'),
    version: read.version('version'),
    keyAttempt: read.keyAttempt('key_attempt'),
    meetUrl,
    startAt: read.instant('start_at'),
    endAt: read.instant('end_at'),
    recallBotId: read.orNull('recall_bot_id', read.uuid),
    ticketNotBefore: read.orNull('ticket_not_before', read.instant),
    ticketExpiresAt: read.orNull('ticket_expires_at', read.instant),
    ticketClaimedAt: read.orNull('ticket_claimed_at', read.instant),
    ticketArms: read.ticketArms('ticket_arms'),
    sessionId: read.orNull('session_id', read.uuid),
    createdAt: read.instant('created_at'),
    updatedAt: read.instant('updated_at'),
  };
  // The three Ashby schedule ids follow the source exactly (0143's chk_r1_meet_bookings_source_ids):
  // all set for an Ashby booking, all null for a public one. A mixed row is drift.
  if (source === 'ashby') {
    if (eventId === null || scheduleId === null || scheduledByUserId === null) return read.fail();
    return Object.freeze({
      id,
      eventId,
      scheduleId,
      applicationId,
      interviewStageId,
      interviewId,
      scheduledByUserId,
      ...rest,
      source,
    });
  }
  if (eventId !== null || scheduleId !== null || scheduledByUserId !== null) return read.fail();
  return Object.freeze({
    id,
    eventId,
    scheduleId,
    applicationId,
    interviewStageId,
    interviewId,
    scheduledByUserId,
    ...rest,
    source,
  });
}

/** An Ashby booking, or `r1_meet_db_error` for any other: a read by an Ashby schedule id (0143). */
function ashbyBooking(booking: R1MeetBooking): R1MeetAshbyBooking {
  if (booking.source !== 'ashby') throw dbError();
  return booking;
}

function parseParticipantRow(row: unknown): { receiptId: string | null; event: R1MeetParticipantEventRow } {
  const read = new FieldReader(row, R1_MEET_DB_ERROR);
  const type = read.oneOf('event_type', R1_MEET_RECALL_PARTICIPANT_EVENTS);
  const person = new FieldReader(isPlainObject(row) ? row.participant : null, R1_MEET_DB_ERROR);
  return {
    receiptId: read.orNull('receipt_id', read.uuid),
    event: Object.freeze({
      type: type === 'participant_events.join' ? ('join' as const) : ('leave' as const),
      participantId: person.orNull('id', (key) => person.int(key, 0, Number.MAX_SAFE_INTEGER)),
      isBot: person.orNull('is_bot', person.bool),
      occurredAt: read.orNull('occurred_at', read.instant),
    }),
  };
}

// ── The RPC answers ─────────────────────────────────────────────────────────

function invalidRequest(read: FieldReader): InvalidRequest {
  const field = read.text('field');
  return Object.freeze({ status: 'invalid_request' as const, field: FIELD.test(field) ? field : read.fail() });
}

function bookingTerminal(read: FieldReader): BookingTerminal {
  return Object.freeze({
    status: 'booking_terminal' as const,
    bookingId: read.uuid('booking_id'),
    bookingStatus: read.status('booking_status'),
    reason: read.reason('reason'),
  });
}

function parseCreateAnswer(data: unknown): R1MeetCreateAnswer {
  const read = new FieldReader(data, R1_MEET_RPC_UNEXPECTED);
  const status = read.oneOf('status', R1_MEET_RPC_ANSWERS.r1_meet_create_round_from_ashby);
  switch (status) {
    case 'created':
    case 'relinked':
      return Object.freeze({
        status,
        bookingId: read.uuid('booking_id'),
        roundId: read.uuid('round_id'),
        version: read.version('version'),
        keyAttempt: read.keyAttempt('key_attempt'),
        roundExpiresAt: read.instant('round_expires_at'),
        objectiveProfile: read.text('objective_profile'),
        rebound: read.rebound(),
      });
    case 'exists':
      return Object.freeze({
        status,
        bookingId: read.uuid('booking_id'),
        roundId: read.uuid('round_id'),
        bookingStatus: read.status('booking_status'),
        reason: read.reason('reason'),
        version: read.version('version'),
        keyAttempt: read.keyAttempt('key_attempt'),
        roundExpiresAt: read.orNull('round_expires_at', read.instant),
        roundLive: read.bool('round_live'),
        objectiveProfile: read.text('objective_profile'),
      });
    case 'booking_terminal':
      return bookingTerminal(read);
    case 'stale_update':
      return Object.freeze({ status, bookingId: read.uuid('booking_id') });
    case 'bot_attached':
      return Object.freeze({
        status,
        bookingId: read.uuid('booking_id'),
        bookingStatus: read.status('booking_status'),
        version: read.version('version'),
        keyAttempt: read.keyAttempt('key_attempt'),
      });
    case 'version_exhausted':
      return Object.freeze({ status, bookingId: read.uuid('booking_id'), version: read.version('version') });
    case 'unmatched_application':
    case 'unmapped_scheduler':
    case 'blocked': {
      const reason = read.reason('reason');
      // The RPC adds `retry_after` for slot_too_far and for nothing else; a re-run needs it.
      const tooFar = reason === 'slot_too_far';
      if (read.has('retry_after') !== tooFar) read.fail();
      return Object.freeze({
        status,
        bookingId: read.uuid('booking_id'),
        reason,
        retryAfter: tooFar ? read.instant('retry_after') : null,
        rebound: read.rebound(),
      });
    }
    case 'in_past':
      return Object.freeze({ status, bookingId: read.has('booking_id') ? read.uuid('booking_id') : null });
    case 'invalid_request':
      return invalidRequest(read);
  }
}

function parseRescheduleAnswer(data: unknown): R1MeetRescheduleAnswer {
  const read = new FieldReader(data, R1_MEET_RPC_UNEXPECTED);
  const status = read.oneOf('status', R1_MEET_RPC_ANSWERS.r1_meet_reschedule_booking);
  switch (status) {
    case 'ok':
      return Object.freeze({
        status,
        bookingId: read.uuid('booking_id'),
        version: read.version('version'),
        keyAttempt: read.keyAttempt('key_attempt'),
        roundExpiresAt: read.instant('round_expires_at'),
      });
    case 'version_conflict':
    case 'bot_attached':
      return Object.freeze({
        status,
        bookingId: read.uuid('booking_id'),
        version: read.version('version'),
        keyAttempt: read.keyAttempt('key_attempt'),
      });
    case 'booking_terminal':
      return bookingTerminal(read);
    case 'no_round':
      return Object.freeze({
        status,
        bookingId: read.uuid('booking_id'),
        bookingStatus: read.status('booking_status'),
        reason: read.reason('reason'),
      });
    case 'booking_dispatched':
    case 'not_allowed':
      return Object.freeze({
        status,
        bookingId: read.uuid('booking_id'),
        bookingStatus: read.status('booking_status'),
      });
    case 'stale_update':
    case 'in_past':
      return Object.freeze({ status, bookingId: read.uuid('booking_id') });
    case 'slot_too_far':
      return Object.freeze({ status, bookingId: read.uuid('booking_id'), retryAfter: read.instant('retry_after') });
    case 'version_exhausted':
      return Object.freeze({ status, bookingId: read.uuid('booking_id'), version: read.version('version') });
    case 'round_not_live':
      return Object.freeze({ status, bookingId: read.uuid('booking_id'), roundId: read.uuid('round_id') });
    case 'not_found':
      return Object.freeze({ status });
    case 'invalid_request':
      return invalidRequest(read);
  }
}

function parseCancelAnswer(data: unknown): R1MeetCancelAnswer {
  const read = new FieldReader(data, R1_MEET_RPC_UNEXPECTED);
  const status = read.oneOf('status', R1_MEET_RPC_ANSWERS.r1_meet_cancel_booking);
  switch (status) {
    case 'ok':
      return Object.freeze({
        status,
        bookingId: read.uuid('booking_id'),
        previousStatus: read.status('previous_status'),
        recallBotId: read.orNull('recall_bot_id', read.uuid),
        botDispatched: read.bool('bot_dispatched'),
      });
    case 'already_cancelled':
      return Object.freeze({
        status,
        bookingId: read.uuid('booking_id'),
        reason: read.reason('reason'),
        recallBotId: read.orNull('recall_bot_id', read.uuid),
      });
    case 'booking_terminal':
      return bookingTerminal(read);
    case 'not_found':
    case 'invalid_reason':
      return Object.freeze({ status });
    case 'invalid_request':
      return invalidRequest(read);
  }
}

function parseSetBotAnswer(data: unknown): R1MeetSetBotAnswer {
  const read = new FieldReader(data, R1_MEET_RPC_UNEXPECTED);
  const status = read.oneOf('status', R1_MEET_RPC_ANSWERS.r1_meet_set_bot);
  switch (status) {
    case 'not_found':
    case 'invalid_action':
      return Object.freeze({ status });
    case 'invalid_request':
      return invalidRequest(read);
    default:
      return Object.freeze({
        status,
        bookingId: read.uuid('booking_id'),
        version: read.version('version'),
        keyAttempt: read.keyAttempt('key_attempt'),
        bookingStatus: read.status('booking_status'),
      });
  }
}

function parseTransitionAnswer(data: unknown): R1MeetTransitionAnswer {
  const read = new FieldReader(data, R1_MEET_RPC_UNEXPECTED);
  const status = read.oneOf('status', R1_MEET_RPC_ANSWERS.r1_meet_transition_booking);
  switch (status) {
    case 'ok':
      return Object.freeze({
        status,
        bookingId: read.uuid('booking_id'),
        previousStatus: read.status('previous_status'),
        recallBotId: read.orNull('recall_bot_id', read.uuid),
      });
    case 'status_conflict':
      return Object.freeze({ status, bookingId: read.uuid('booking_id'), current: read.status('current') });
    case 'invalid_transition':
      return Object.freeze({ status, bookingId: read.uuid('booking_id') });
    case 'not_found':
      return Object.freeze({ status });
    case 'invalid_request':
      return invalidRequest(read);
  }
}

function parseArmAnswer(data: unknown): R1MeetArmAnswer {
  const read = new FieldReader(data, R1_MEET_RPC_UNEXPECTED);
  const status = read.oneOf('status', R1_MEET_RPC_ANSWERS.r1_meet_arm_ticket);
  switch (status) {
    case 'ok':
    case 'duplicate':
      return Object.freeze({
        status,
        bookingId: read.uuid('booking_id'),
        notBefore: read.instant('not_before'),
        expiresAt: read.instant('expires_at'),
        ticketArms: read.ticketArms('ticket_arms'),
      });
    case 'ticket_arms_exhausted':
      return Object.freeze({ status, bookingId: read.uuid('booking_id'), ticketArms: read.ticketArms('ticket_arms') });
    case 'not_armable':
      return Object.freeze({ status, bookingId: read.uuid('booking_id'), bookingStatus: read.status('booking_status') });
    case 'digest_in_use':
      return Object.freeze({ status, bookingId: read.uuid('booking_id') });
    case 'invalid_ticket':
    case 'invalid_window':
    case 'not_found':
      return Object.freeze({ status });
    case 'invalid_request':
      return invalidRequest(read);
  }
}

function parsePruneAnswer(
  data: unknown,
  answers: readonly R1MeetPruneAnswer['status'][],
): R1MeetPruneAnswer {
  const read = new FieldReader(data, R1_MEET_RPC_UNEXPECTED);
  const status = read.oneOf('status', answers);
  switch (status) {
    case 'ok':
      return Object.freeze({ status, deleted: read.int('deleted', 0, Number.MAX_SAFE_INTEGER) });
    case 'retention_too_short':
      return Object.freeze({ status });
    case 'invalid_request':
      return invalidRequest(read);
  }
}

// ── The delivery order of Ashby webhooks ─────────────────────────────────────

/** S03's stamps: the epoch ms of Ashby's `updatedAt`, or `r<epoch ms>` of the receipt when it sent none. */
const UPDATED_STAMP = /^[0-9]{1,16}$/;

/** The epoch ms of Ashby's `updatedAt` in `ashby-schedule:<schedule>:<stamp>[:...]`, or null. */
function updatedStamp(dedupeKey: string, prefix: string): number | null {
  const stamp = dedupeKey.slice(prefix.length).split(':', 1)[0] ?? '';
  return UPDATED_STAMP.test(stamp) ? Number(stamp) : null;
}

// ── The store ───────────────────────────────────────────────────────────────

interface DbAnswer {
  readonly data: unknown;
  readonly error: unknown;
  readonly count?: number | null;
}

function dbError(): R1MeetJobError {
  return new R1MeetJobError(R1_MEET_DB_ERROR);
}

/** Run one query; a DB error, a rejected call or a builder that throws is the same one code. */
async function run(query: () => PromiseLike<DbAnswer>): Promise<DbAnswer> {
  let answer: DbAnswer;
  try {
    answer = await query();
  } catch {
    throw dbError();
  }
  if (answer.error) throw dbError();
  return answer;
}

function rowsOf(answer: DbAnswer): readonly unknown[] {
  if (!Array.isArray(answer.data)) throw dbError();
  return answer.data as unknown[];
}

function rowOf(answer: DbAnswer): unknown {
  return answer.data === null || answer.data === undefined ? null : answer.data;
}

function bookingOf(answer: DbAnswer): R1MeetBooking | null {
  const row = rowOf(answer);
  return row === null ? null : parseBooking(row);
}

function bookingsOf(answer: DbAnswer): readonly R1MeetBooking[] {
  return Object.freeze(rowsOf(answer).map(parseBooking));
}

function ashbyBookingOf(answer: DbAnswer): R1MeetAshbyBooking | null {
  const booking = bookingOf(answer);
  return booking === null ? null : ashbyBooking(booking);
}

function ashbyBookingsOf(answer: DbAnswer): readonly R1MeetAshbyBooking[] {
  return Object.freeze(rowsOf(answer).map((row) => ashbyBooking(parseBooking(row))));
}

/** The store over the service-role client. */
export function createR1MeetStore(db: Db): R1MeetStore {
  const bookings = () => db.from('r1_meet_bookings').select(R1_MEET_BOOKING_COLUMNS);

  const rpc = async (name: R1MeetRpcName, args: Record<string, unknown>): Promise<unknown> =>
    (await run(() => db.rpc(name, args))).data;

  return Object.freeze({
    async getBooking(id: string) {
      return bookingOf(await run(() => bookings().eq('id', id).maybeSingle()));
    },

    async getBookingByEvent(eventId: string) {
      return ashbyBookingOf(await run(() => bookings().eq('ashby_interview_event_id', eventId).maybeSingle()));
    },

    async getBookingByBot(recallBotId: string) {
      return bookingOf(await run(() => bookings().eq('recall_bot_id', recallBotId).maybeSingle()));
    },

    async getBookingBySession(sessionId: string) {
      // session_id is indexed, not unique: one row is asked for, never assumed.
      return bookingOf(
        await run(() =>
          bookings().eq('session_id', sessionId).order('updated_at', { ascending: false }).limit(1).maybeSingle(),
        ),
      );
    },

    async listLiveBySchedule(scheduleId: string) {
      return ashbyBookingsOf(
        await run(() =>
          bookings()
            .eq('ashby_schedule_id', scheduleId)
            .in('status', [...R1_MEET_LIVE_STATUSES])
            .order('start_at', { ascending: true })
            .limit(LIVE_BY_SCHEDULE_LIMIT),
        ),
      );
    },

    async listOwedReleases(limit: number) {
      // The predicate of idx_r1_meet_bookings_owed_release.
      return bookingsOf(
        await run(() =>
          bookings()
            .not('recall_bot_id', 'is', null)
            .in('status', [...R1_MEET_TERMINAL_STATUSES])
            .order('updated_at', { ascending: true })
            .limit(limit),
        ),
      );
    },

    async listOverdue(endBefore: string, limit: number) {
      return bookingsOf(
        await run(() =>
          bookings()
            .in('status', [...R1_MEET_LIVE_STATUSES])
            .lt('end_at', endBefore)
            .order('end_at', { ascending: true })
            .limit(limit),
        ),
      );
    },

    async listInCall(limit: number) {
      return bookingsOf(
        await run(() => bookings().eq('status', 'in_call').order('start_at', { ascending: true }).limit(limit)),
      );
    },

    async listStuckPending(query: { readonly untouchedSince: string; readonly startAfter: string; readonly limit: number }) {
      return bookingsOf(
        await run(() =>
          bookings()
            .eq('status', 'pending')
            .lt('updated_at', query.untouchedSince)
            .gt('start_at', query.startAfter)
            .order('start_at', { ascending: true })
            .limit(query.limit),
        ),
      );
    },

    async listCapBlocked(query: { readonly startAfter: string; readonly limit: number }) {
      return bookingsOf(
        await run(() =>
          bookings()
            .eq('status', 'blocked')
            .eq('reason', 'bot_cap_reached')
            .gt('start_at', query.startAfter)
            .order('start_at', { ascending: true })
            .limit(query.limit),
        ),
      );
    },

    async listDrainable(query: { readonly untouchedSince: string | null; readonly limit: number }) {
      return bookingsOf(
        await run(() => {
          const live = bookings().in('status', [...R1_MEET_DRAINABLE_STATUSES]);
          const scoped = query.untouchedSince === null ? live : live.lt('updated_at', query.untouchedSince);
          return scoped.order('start_at', { ascending: true }).limit(query.limit);
        }),
      );
    },

    async newerAshbyDelivery(job: {
      readonly scheduleId: string;
      readonly ashbyUpdatedAt: string | null;
      readonly receivedAt: string | null;
    }) {
      // The id goes into a LIKE pattern, so it must hold no wildcard: UUID only.
      if (!UUID.test(job.scheduleId)) throw dbError();
      const prefix = `ashby-schedule:${job.scheduleId}:`;
      const rows = rowsOf(
        await run(() =>
          db
            .from('r1_meet_receipts')
            .select('dedupe_key, received_at')
            .eq('source', 'ashby')
            .like('dedupe_key', `${prefix}%`)
            .order('received_at', { ascending: false })
            .limit(RECEIPT_WINDOW),
        ),
      ).map((row) => {
        const read = new FieldReader(row, R1_MEET_DB_ERROR);
        const dedupeKey = read.text('dedupe_key');
        if (!dedupeKey.startsWith(prefix)) read.fail();
        return { dedupeKey, receivedMs: Date.parse(read.instant('received_at')) };
      });
      const ownUpdatedMs = parseR1MeetInstant(job.ashbyUpdatedAt);
      if (ownUpdatedMs !== null) {
        // A receipt-time stamp (`r...`) is another clock: it never outranks an Ashby updatedAt.
        return rows.some((row) => {
          const stamp = updatedStamp(row.dedupeKey, prefix);
          return stamp !== null && stamp > ownUpdatedMs;
        });
      }
      // Ashby sent no updatedAt: receipt order is all there is, and without it nothing is newer.
      const ownReceivedMs = parseR1MeetInstant(job.receivedAt);
      return ownReceivedMs !== null && rows.some((row) => row.receivedMs > ownReceivedMs);
    },

    async countBotsInDay(query: { readonly from: string; readonly to: string; readonly excludeId: string }) {
      const { count } = await run(() =>
        db
          .from('r1_meet_bookings')
          .select('id', { count: 'exact', head: true })
          .gte('start_at', query.from)
          .lt('start_at', query.to)
          .in('status', [...R1_MEET_CAP_STATUSES])
          .in('reason', [...R1_MEET_CAP_REASONS])
          .neq('id', query.excludeId),
      );
      // No count is not zero: the cap is a cost cap, so it fails closed.
      if (typeof count !== 'number' || !Number.isSafeInteger(count) || count < 0) throw dbError();
      return count;
    },

    async participantEvents(recallBotId: string) {
      const rows = rowsOf(
        await run(() =>
          db
            .from('job_queue')
            .select(
              'receipt_id:payload->>receipt_id, event_type:payload->>event_type, '
              + 'occurred_at:payload->>occurred_at, participant:payload->participant',
            )
            .eq('name', R1_MEET_QUEUE)
            .eq('payload->>kind', 'recall_event')
            .eq('payload->>recall_bot_id', recallBotId)
            .in('payload->>event_type', [...R1_MEET_RECALL_PARTICIPANT_EVENTS])
            .order('created_at', { ascending: false })
            .limit(PARTICIPANT_EVENT_LIMIT),
        ),
      ).map(parseParticipantRow);
      // A re-driven receipt may have had two jobs; its one event must not count twice.
      const seen = new Set<string>();
      const events: R1MeetParticipantEventRow[] = [];
      for (const { receiptId, event } of rows) {
        if (receiptId !== null) {
          if (seen.has(receiptId)) continue;
          seen.add(receiptId);
        }
        events.push(event);
      }
      return Object.freeze(events);
    },

    async sessionStatus(sessionId: string) {
      const row = rowOf(
        await run(() => db.from('call_sessions').select('id, status').eq('id', sessionId).maybeSingle()),
      );
      return row === null ? null : new FieldReader(row, R1_MEET_DB_ERROR).oneOf('status', R1_MEET_SESSION_STATUSES);
    },

    async roundLive(roundId: string, nowMs: number) {
      const row = rowOf(
        await run(() =>
          db.from('interview_rounds').select('id, channel, status, expires_at').eq('id', roundId).maybeSingle(),
        ),
      );
      if (row === null) return false;
      const read = new FieldReader(row, R1_MEET_DB_ERROR);
      const status = read.text('status');
      return (
        read.text('channel') === 'meet'
        && (status === 'invited' || status === 'in_progress')
        && Date.parse(read.instant('expires_at')) > nowMs
      );
    },

    async attemptSettlement(sessionId: string) {
      const row = rowOf(
        await run(() =>
          db.from('interview_round_attempts').select('session_id, outcome, counted').eq('session_id', sessionId).maybeSingle(),
        ),
      );
      if (row === null) return null;
      const read = new FieldReader(row, R1_MEET_DB_ERROR);
      // The outcome is read as text, not as a closed list: only `counted` decides, so a newer
      // outcome word can never turn a settled attempt into a database error.
      return Object.freeze({ outcome: read.orNull('outcome', read.text), counted: read.bool('counted') });
    },

    async roundStart(roundId: string, nowMs: number) {
      const row = rowOf(
        await run(() =>
          db
            .from('interview_rounds')
            .select('id, channel, status, expires_at, starts_used, attempts_counted, attempts_allowed')
            .eq('id', roundId)
            .maybeSingle(),
        ),
      );
      if (row === null) return 'closed' as const;
      const read = new FieldReader(row, R1_MEET_DB_ERROR);
      const status = read.text('status');
      const channel = read.text('channel');
      const expiresMs = Date.parse(read.instant('expires_at'));
      const startsUsed = read.int('starts_used', 0, R1_MEET_ROUND_MAX_STARTS);
      const attemptsCounted = read.int('attempts_counted', 0, Number.MAX_SAFE_INTEGER);
      const attemptsAllowed = read.int('attempts_allowed', 1, Number.MAX_SAFE_INTEGER);
      // Checked first: a round whose counted attempts are all used is settled, whatever else it says.
      if (attemptsCounted >= attemptsAllowed) return 'complete' as const;
      const live = channel === 'meet' && (status === 'invited' || status === 'in_progress') && expiresMs > nowMs;
      return live && startsUsed < R1_MEET_ROUND_MAX_STARTS ? ('startable' as const) : ('closed' as const);
    },

    async finishReceipt(id: string, outcome: R1MeetReceiptFinal, nowIso: string) {
      const updated = rowsOf(
        await run(() =>
          db
            .from('r1_meet_receipts')
            .update({ outcome, processed_at: nowIso })
            .eq('id', id)
            .in('outcome', ['recorded', 'enqueued'])
            .select('id'),
        ),
      );
      return updated.length > 0;
    },

    async createRound(input: R1MeetCreateRoundInput) {
      return parseCreateAnswer(
        await rpc('r1_meet_create_round_from_ashby', {
          p_ashby_interview_event_id: input.eventId,
          p_ashby_schedule_id: input.scheduleId,
          p_ashby_application_id: input.applicationId,
          p_ashby_interview_stage_id: input.interviewStageId,
          p_ashby_interview_id: input.interviewId,
          p_ashby_scheduled_by_user_id: input.scheduledByUserId,
          p_attested_at: input.attestedAt,
          p_ashby_updated_at: input.ashbyUpdatedAt,
          p_meet_url: input.meetUrl,
          p_start_at: input.startAt,
          p_end_at: input.endAt,
          p_created_by: input.createdBy,
          p_objective_profile: input.objectiveProfile,
          p_expiry_grace_sec: R1_MEET_ROUND_EXPIRY_GRACE_SEC,
          p_now: input.nowIso,
        }),
      );
    },

    async reschedule(input: R1MeetRescheduleInput) {
      return parseRescheduleAnswer(
        await rpc('r1_meet_reschedule_booking', {
          p_booking_id: input.bookingId,
          p_expected_version: input.expectedVersion,
          p_start_at: input.startAt,
          p_end_at: input.endAt,
          p_meet_url: input.meetUrl,
          p_ashby_updated_at: input.ashbyUpdatedAt,
          p_expiry_grace_sec: R1_MEET_ROUND_EXPIRY_GRACE_SEC,
          p_now: input.nowIso,
        }),
      );
    },

    async cancel(input: { readonly bookingId: string; readonly reason: R1MeetCancelReason; readonly nowIso: string }) {
      return parseCancelAnswer(
        await rpc('r1_meet_cancel_booking', {
          p_booking_id: input.bookingId,
          p_reason: input.reason,
          p_now: input.nowIso,
        }),
      );
    },

    async setBot(input: R1MeetSetBotInput) {
      return parseSetBotAnswer(
        await rpc('r1_meet_set_bot', {
          p_booking_id: input.bookingId,
          p_action: input.action,
          p_expected_version: input.expectedVersion,
          p_expected_key_attempt: input.expectedKeyAttempt,
          // Read by attach only.
          p_recall_bot_id: input.action === 'attach' ? input.recallBotId : null,
          p_now: input.nowIso,
        }),
      );
    },

    async transition(input: R1MeetTransitionInput) {
      return parseTransitionAnswer(
        await rpc('r1_meet_transition_booking', {
          p_booking_id: input.bookingId,
          p_from_status: input.from,
          p_to_status: input.to,
          p_reason: input.reason,
          p_now: input.nowIso,
        }),
      );
    },

    async armTicket(input: R1MeetArmInput) {
      return parseArmAnswer(
        await rpc('r1_meet_arm_ticket', {
          p_booking_id: input.bookingId,
          p_ticket_digest: input.ticketDigest,
          p_not_before: input.notBefore,
          p_expires_at: input.expiresAt,
          p_now: input.nowIso,
        }),
      );
    },

    async pruneReceipts(input: R1MeetPruneInput) {
      return parsePruneAnswer(
        await rpc('r1_meet_prune_receipts', {
          p_older_than: input.olderThan,
          p_limit: input.limit,
          p_now: input.nowIso,
        }),
        R1_MEET_RPC_ANSWERS.r1_meet_prune_receipts,
      );
    },

    async pruneBookings(input: R1MeetPruneInput) {
      return parsePruneAnswer(
        await rpc('r1_meet_prune_bookings', {
          p_older_than: input.olderThan,
          p_limit: input.limit,
          p_now: input.nowIso,
        }),
        R1_MEET_RPC_ANSWERS.r1_meet_prune_bookings,
      );
    },
  });
}
