/**
 * The database port of Lexy's calendar for public bookings (M035 S05, dark): the reads and the three
 * 0143 RPCs the `calendar_sync` job, the public maintenance steps and the drain's calendar cancel make.
 *
 * WHAT IT READS.
 *  - `r1_meet_bookings`, exactly `R1_MEET_CALENDAR_BOOKING_COLUMNS`: one booking by id, and five lists,
 *    each filtered to `source = 'public_page'`, ordered (slot start ascending; retention by slot end)
 *    and limited, through `idx_r1_meet_bookings_status_start` (0142) by their `status in (...)` and
 *    `start_at` filters. NEVER `manage_token_digest`, `public_request_id`, `ticket_*`,
 *    `recall_bot_id` or `session_id`.
 *  - `ashby_application_links.external_candidate_id` of one Ashby application (the Ashby candidate id
 *    the invite's `candidate.info` reads), or null.
 *  - `candidates.email` of one candidate, as stored (normalised later by `resolveR1PublicOnFileEmail`):
 *    PII, held in memory by the caller only.
 *
 * WHAT IT WRITES, only through the 0143 RPCs (service role, under the booking row lock), with
 * exactly the 0143 parameter names:
 *  - `r1_meet_public_set_manage_digest(p_booking_id, p_digest, p_now)`: the manage token's digest
 *    (never the token);
 *  - `r1_meet_public_set_calendar_state(p_booking_id, p_from, p_to, p_now)`: compare-and-set of the
 *    event's state;
 *  - `r1_meet_public_throttle_prune(p_older_than_sec, p_limit, p_now)`: the throttle retention.
 *
 * STRICT. A row is read field by field: a column 0143 would refuse (an unknown source, status, reason
 * or calendar state, an event id that is not the booking id without dashes, a public row without a
 * calendar state, an Ashby row with a public column, a zoneless instant, a Meet link that is not
 * canonical, a move count outside 0..10) is drift. Two codes, and nothing else, are thrown
 * (`R1MeetJobError`: the code is the whole message):
 *   r1_meet_db_error        the database refused or failed, the builder threw, or a row is drift;
 *   r1_meet_rpc_unexpected  an RPC answered `invalid_request` (a bug here), a status outside its
 *                           0143 catalog comment, or a shape that status does not have.
 * A missing row is never an error: the single reads answer null. No value (id, email, digest, Meet
 * link) is ever put in an error, and nothing here logs.
 *
 * The client is an argument (type-only import of `lib/supabase`): loading this module reads no
 * environment and performs no I/O.
 */

import { normalizeGoogleMeetUrl } from '../../../../integrations/google-meet/url.js';
import type { supabase } from '../../../supabase.js';
import {
  R1_MEET_BOOKING_REASONS,
  R1_MEET_BOOKING_SOURCES,
  R1_MEET_BOOKING_STATUSES,
  type R1MeetBookingReason,
  type R1MeetBookingSource,
  type R1MeetBookingStatus,
} from '../bookings-read.js';
import { R1MeetJobError, R1_MEET_DB_ERROR, R1_MEET_RPC_UNEXPECTED } from '../jobs.js';
import { parseR1MeetInstant } from '../ticket.js';

type Db = typeof supabase;

// ── Vocabulary ──────────────────────────────────────────────────────────────

/** `chk_r1_meet_bookings_calendar_state` (0143 §1). Frozen. */
export const R1_MEET_CALENDAR_STATES = Object.freeze(['created', 'invited', 'cancelled', 'purged'] as const);
export type R1MeetCalendarState = (typeof R1_MEET_CALENDAR_STATES)[number];

/** Exactly these columns; never manage_token_digest, public_request_id, ticket_*, recall_bot_id, session_id. */
export const R1_MEET_CALENDAR_BOOKING_COLUMNS =
  'id, source, status, reason, round_id, candidate_id, ashby_application_id, objective_profile, meet_url, '
  + 'start_at, end_at, google_calendar_event_id, calendar_state, move_count, invite_sent_at, created_at, updated_at';

/** The three RPCs of this port (0143 §16, §21, §23). */
export type R1MeetPublicCalendarRpcName =
  | 'r1_meet_public_set_manage_digest'
  | 'r1_meet_public_set_calendar_state'
  | 'r1_meet_public_throttle_prune';

/** The closed answers of the three RPCs, in their 0143 catalog-comment order (pinned). Frozen. */
export const R1_MEET_PUBLIC_CALENDAR_RPC_ANSWERS: Readonly<Record<R1MeetPublicCalendarRpcName, readonly string[]>> =
  Object.freeze({
    r1_meet_public_set_manage_digest: Object.freeze(['ok', 'not_found', 'not_public', 'booking_terminal', 'invalid_request']),
    r1_meet_public_set_calendar_state: Object.freeze(['ok', 'state_conflict', 'not_found', 'not_public', 'invalid_request']),
    r1_meet_public_throttle_prune: Object.freeze(['ok', 'invalid_request']),
  });

/** The live statuses no bot is dispatched in yet: what an invite, a deadline or a re-check acts on. */
const UNDISPATCHED_LIVE = Object.freeze(['pending', 'blocked', 'bot_scheduled'] as const);
/** The ends of a public booking that leave its event owed a cancel (0143 §3). */
const ENDED_UNUSED = Object.freeze(['cancelled', 'failed', 'drained'] as const);
/** Every terminal status. */
const TERMINAL = Object.freeze(['completed', 'cancelled', 'failed', 'drained'] as const);
/** The calendar states in which the event still exists on Lexy's calendar. */
const EVENT_EXISTS = Object.freeze(['created', 'invited'] as const);
/** The states an invite time may sit beside (`chk_r1_meet_bookings_public_columns`). */
const INVITED_OR_AFTER: readonly R1MeetCalendarState[] = Object.freeze(['invited', 'cancelled', 'purged']);

const MAX_MOVE_COUNT = 10;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const EVENT_ID = /^[0-9a-f]{32}$/;
const ASHBY_CANDIDATE_ID = /^[0-9A-Za-z-]{1,256}$/;

// ── Shapes ──────────────────────────────────────────────────────────────────

/** One booking as the calendar reads it. */
export interface R1MeetCalendarBooking {
  /** Lower-case uuid. */
  readonly id: string;
  readonly source: R1MeetBookingSource;
  readonly status: R1MeetBookingStatus;
  readonly reason: R1MeetBookingReason;
  readonly roundId: string | null;
  readonly candidateId: string | null;
  /** The matched Ashby application, verbatim. */
  readonly applicationId: string;
  readonly objectiveProfile: string;
  /** Canonical (`normalizeGoogleMeetUrl(meetUrl) === meetUrl`). Confidential: never logged. */
  readonly meetUrl: string;
  /** `toISOString()`. */
  readonly startAt: string;
  readonly endAt: string;
  /** 32 lower-case hex = the id without dashes (a public row), or null (an Ashby row). */
  readonly eventId: string | null;
  /** Non-null for a public row, null for an Ashby one. */
  readonly calendarState: R1MeetCalendarState | null;
  /** 0..10. */
  readonly moveCount: number;
  readonly inviteSentAt: string | null;
  readonly createdAt: string;
  readonly updatedAt: string;
}

export type R1MeetSetManageDigestAnswer = 'ok' | 'not_found' | 'not_public' | 'booking_terminal';

export type R1MeetSetCalendarStateAnswer =
  | { readonly status: 'ok'; readonly calendarState: R1MeetCalendarState }
  | { readonly status: 'state_conflict'; readonly current: R1MeetCalendarState | null }
  | { readonly status: 'not_found' }
  | { readonly status: 'not_public' };

export interface R1MeetCalendarStore {
  getBooking(id: string): Promise<R1MeetCalendarBooking | null>;
  /**
   * `ashby_application_links` (provider 'ashby', external_application_id = applicationId): its
   * external_candidate_id, or null (no row, null, or not ^[0-9A-Za-z-]{1,256}$).
   */
  linkCandidateId(applicationId: string): Promise<string | null>;
  /** candidates.email as stored (normalised later by resolveR1PublicOnFileEmail), or null. PII: memory only. */
  candidateEmail(candidateId: string): Promise<string | null>;
  setManageDigest(i: { readonly bookingId: string; readonly digest: string; readonly nowIso: string }): Promise<R1MeetSetManageDigestAnswer>;
  setCalendarState(i: {
    readonly bookingId: string;
    readonly from: readonly R1MeetCalendarState[];
    readonly to: 'invited' | 'cancelled' | 'purged';
    readonly nowIso: string;
  }): Promise<R1MeetSetCalendarStateAnswer>;
  /** Answers how many throttle rows were deleted. */
  throttlePrune(i: { readonly olderThanSec: number; readonly limit: number; readonly nowIso: string }): Promise<number>;
  /** Live and undispatched, `created`, made before `createdBefore`, slot start after `startAfter`. */
  listInviteOwed(q: { readonly createdBefore: string; readonly startAfter: string; readonly limit: number }): Promise<readonly R1MeetCalendarBooking[]>;
  /** Live and undispatched, `created`, slot start at or before `startBefore`. */
  listInviteDeadline(q: { readonly startBefore: string; readonly limit: number }): Promise<readonly R1MeetCalendarBooking[]>;
  /** Cancelled, failed or drained with the event still there, slot start after `startAfter`, untouched since `updatedBefore`. */
  listCalendarDrift(q: { readonly startAfter: string; readonly updatedBefore: string; readonly limit: number }): Promise<readonly R1MeetCalendarBooking[]>;
  /** Terminal with the event still there, slot end before `endBefore`. */
  listRetention(q: { readonly endBefore: string; readonly limit: number }): Promise<readonly R1MeetCalendarBooking[]>;
  /** Live and undispatched, slot start in [startFrom, startTo). */
  listRecheck(q: { readonly startFrom: string; readonly startTo: string; readonly limit: number }): Promise<readonly R1MeetCalendarBooking[]>;
}

// ── Reading rows and answers ────────────────────────────────────────────────

function isPlainObject(value: unknown): value is Record<string, unknown> {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return false;
  const proto = Object.getPrototypeOf(value) as unknown;
  return proto === Object.prototype || proto === null;
}

function hasExactKeys(row: Record<string, unknown>, keys: readonly string[]): boolean {
  const own = Object.keys(row);
  return own.length === keys.length && keys.every((name) => Object.prototype.hasOwnProperty.call(row, name));
}

/** Reads one row (or one RPC answer) field by field; anything unexpected throws its one code. */
class FieldReader {
  readonly data: Record<string, unknown>;

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

  readonly eventId = (key: string): string => {
    const value = this.data[key];
    return typeof value === 'string' && EVENT_ID.test(value) ? value : this.fail();
  };

  readonly calendarState = (key: string): R1MeetCalendarState => this.oneOf(key, R1_MEET_CALENDAR_STATES);

  int(key: string, min: number, max: number): number {
    const value = this.data[key];
    return typeof value === 'number' && Number.isSafeInteger(value) && value >= min && value <= max ? value : this.fail();
  }

  oneOf<T extends string>(key: string, allowed: readonly T[]): T {
    return allowed.find((candidate) => candidate === this.data[key]) ?? this.fail();
  }
}

/** One booking row, read strictly (0143's CHECKs on the public columns included). */
function parseBooking(row: unknown): R1MeetCalendarBooking {
  const read = new FieldReader(row, R1_MEET_DB_ERROR);
  const id = read.uuid('id');
  const source = read.oneOf('source', R1_MEET_BOOKING_SOURCES);
  const meetUrl = read.text('meet_url');
  if (normalizeGoogleMeetUrl(meetUrl) !== meetUrl) read.fail();
  const eventId = read.orNull('google_calendar_event_id', read.eventId);
  const calendarState = read.orNull('calendar_state', read.calendarState);
  const moveCount = read.int('move_count', 0, MAX_MOVE_COUNT);
  const inviteSentAt = read.orNull('invite_sent_at', read.instant);
  // chk_r1_meet_bookings_calendar_event_id and chk_r1_meet_bookings_public_columns (0143 §1).
  if (eventId !== null && eventId !== id.replace(/-/g, '')) read.fail();
  if (source === 'public_page') {
    if (eventId === null || calendarState === null || (inviteSentAt !== null && !INVITED_OR_AFTER.includes(calendarState))) {
      read.fail();
    }
  } else if (eventId !== null || calendarState !== null || inviteSentAt !== null || moveCount !== 0) {
    read.fail();
  }
  return Object.freeze({
    id,
    source,
    status: read.oneOf('status', R1_MEET_BOOKING_STATUSES),
    reason: read.oneOf('reason', R1_MEET_BOOKING_REASONS),
    roundId: read.orNull('round_id', read.uuid),
    candidateId: read.orNull('candidate_id', read.uuid),
    applicationId: read.verbatimUuid('ashby_application_id'),
    objectiveProfile: read.text('objective_profile'),
    meetUrl,
    startAt: read.instant('start_at'),
    endAt: read.instant('end_at'),
    eventId,
    calendarState,
    moveCount,
    inviteSentAt,
    createdAt: read.instant('created_at'),
    updatedAt: read.instant('updated_at'),
  });
}

/** A row of a public-only list: anything but a public booking is drift. */
function parsePublicBooking(row: unknown): R1MeetCalendarBooking {
  const booking = parseBooking(row);
  if (booking.source !== 'public_page') throw dbError();
  return booking;
}

// Each answer reader lists its RPC's catalog answers WITHOUT `invalid_request`: that answer means this
// port sent a bad argument (a bug, never a decision), so it is `r1_meet_rpc_unexpected` like any
// status outside the catalog.

function parseSetManageDigestAnswer(data: unknown): R1MeetSetManageDigestAnswer {
  const read = new FieldReader(data, R1_MEET_RPC_UNEXPECTED);
  const status = read.oneOf('status', ['ok', 'not_found', 'not_public', 'booking_terminal'] as const);
  if (!hasExactKeys(read.data, ['status'])) read.fail();
  return status;
}

function parseSetCalendarStateAnswer(data: unknown, to: R1MeetCalendarState): R1MeetSetCalendarStateAnswer {
  const read = new FieldReader(data, R1_MEET_RPC_UNEXPECTED);
  const status = read.oneOf('status', ['ok', 'state_conflict', 'not_found', 'not_public'] as const);
  switch (status) {
    case 'ok': {
      if (!hasExactKeys(read.data, ['status', 'calendar_state'])) read.fail();
      const calendarState = read.calendarState('calendar_state');
      if (calendarState !== to) read.fail();
      return Object.freeze({ status, calendarState });
    }
    case 'state_conflict':
      if (!hasExactKeys(read.data, ['status', 'current'])) read.fail();
      return Object.freeze({ status, current: read.orNull('current', read.calendarState) });
    case 'not_found':
    case 'not_public':
      if (!hasExactKeys(read.data, ['status'])) read.fail();
      return Object.freeze({ status });
  }
}

function parseThrottlePruneAnswer(data: unknown, limit: number): number {
  const read = new FieldReader(data, R1_MEET_RPC_UNEXPECTED);
  read.oneOf('status', ['ok'] as const);
  if (!hasExactKeys(read.data, ['status', 'deleted'])) read.fail();
  const deleted = read.int('deleted', 0, Number.MAX_SAFE_INTEGER);
  if (deleted > limit) read.fail();
  return deleted;
}

// ── The store ───────────────────────────────────────────────────────────────

interface DbAnswer {
  readonly data: unknown;
  readonly error: unknown;
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
  if (answer === null || typeof answer !== 'object' || answer.error) throw dbError();
  return answer;
}

function rowsOf(answer: DbAnswer): readonly unknown[] {
  if (!Array.isArray(answer.data)) throw dbError();
  return answer.data as unknown[];
}

function rowOf(answer: DbAnswer): unknown {
  return answer.data === null || answer.data === undefined ? null : answer.data;
}

function publicBookingsOf(answer: DbAnswer): readonly R1MeetCalendarBooking[] {
  return Object.freeze(rowsOf(answer).map(parsePublicBooking));
}

/** The calendar store over the service-role client. */
export function createR1MeetCalendarStore(db: Db): R1MeetCalendarStore {
  const bookings = () => db.from('r1_meet_bookings').select(R1_MEET_CALENDAR_BOOKING_COLUMNS);
  const publicBookings = () => bookings().eq('source', 'public_page');

  const rpc = async (name: R1MeetPublicCalendarRpcName, args: Record<string, unknown>): Promise<unknown> =>
    (await run(() => db.rpc(name, args))).data;

  return Object.freeze({
    async getBooking(id: string) {
      const row = rowOf(await run(() => bookings().eq('id', id).maybeSingle()));
      return row === null ? null : parseBooking(row);
    },

    async linkCandidateId(applicationId: string) {
      const row = rowOf(
        await run(() =>
          db
            .from('ashby_application_links')
            .select('external_candidate_id')
            .eq('provider', 'ashby')
            .eq('external_application_id', applicationId)
            .maybeSingle(),
        ),
      );
      if (row === null) return null;
      if (!isPlainObject(row)) throw dbError();
      const value = row.external_candidate_id;
      return typeof value === 'string' && ASHBY_CANDIDATE_ID.test(value) ? value : null;
    },

    async candidateEmail(candidateId: string) {
      const row = rowOf(await run(() => db.from('candidates').select('email').eq('id', candidateId).maybeSingle()));
      if (row === null) return null;
      if (!isPlainObject(row)) throw dbError();
      const value = row.email;
      if (value === null || value === undefined) return null;
      if (typeof value !== 'string') throw dbError();
      return value;
    },

    async setManageDigest(i: { readonly bookingId: string; readonly digest: string; readonly nowIso: string }) {
      return parseSetManageDigestAnswer(
        await rpc('r1_meet_public_set_manage_digest', { p_booking_id: i.bookingId, p_digest: i.digest, p_now: i.nowIso }),
      );
    },

    async setCalendarState(i: {
      readonly bookingId: string;
      readonly from: readonly R1MeetCalendarState[];
      readonly to: 'invited' | 'cancelled' | 'purged';
      readonly nowIso: string;
    }) {
      return parseSetCalendarStateAnswer(
        await rpc('r1_meet_public_set_calendar_state', {
          p_booking_id: i.bookingId,
          p_from: [...i.from],
          p_to: i.to,
          p_now: i.nowIso,
        }),
        i.to,
      );
    },

    async throttlePrune(i: { readonly olderThanSec: number; readonly limit: number; readonly nowIso: string }) {
      return parseThrottlePruneAnswer(
        await rpc('r1_meet_public_throttle_prune', { p_older_than_sec: i.olderThanSec, p_limit: i.limit, p_now: i.nowIso }),
        i.limit,
      );
    },

    async listInviteOwed(q: { readonly createdBefore: string; readonly startAfter: string; readonly limit: number }) {
      return publicBookingsOf(
        await run(() =>
          publicBookings()
            .eq('calendar_state', 'created')
            .in('status', [...UNDISPATCHED_LIVE])
            .lt('created_at', q.createdBefore)
            .gt('start_at', q.startAfter)
            .order('start_at', { ascending: true })
            .limit(q.limit),
        ),
      );
    },

    async listInviteDeadline(q: { readonly startBefore: string; readonly limit: number }) {
      return publicBookingsOf(
        await run(() =>
          publicBookings()
            .eq('calendar_state', 'created')
            .in('status', [...UNDISPATCHED_LIVE])
            .lte('start_at', q.startBefore)
            .order('start_at', { ascending: true })
            .limit(q.limit),
        ),
      );
    },

    async listCalendarDrift(q: { readonly startAfter: string; readonly updatedBefore: string; readonly limit: number }) {
      return publicBookingsOf(
        await run(() =>
          publicBookings()
            .in('status', [...ENDED_UNUSED])
            .in('calendar_state', [...EVENT_EXISTS])
            .gt('start_at', q.startAfter)
            .lt('updated_at', q.updatedBefore)
            .order('start_at', { ascending: true })
            .limit(q.limit),
        ),
      );
    },

    async listRetention(q: { readonly endBefore: string; readonly limit: number }) {
      return publicBookingsOf(
        await run(() =>
          publicBookings()
            .in('status', [...TERMINAL])
            .in('calendar_state', [...EVENT_EXISTS])
            .lt('end_at', q.endBefore)
            .order('end_at', { ascending: true })
            .limit(q.limit),
        ),
      );
    },

    async listRecheck(q: { readonly startFrom: string; readonly startTo: string; readonly limit: number }) {
      return publicBookingsOf(
        await run(() =>
          publicBookings()
            .in('status', [...UNDISPATCHED_LIVE])
            .gte('start_at', q.startFrom)
            .lt('start_at', q.startTo)
            .order('start_at', { ascending: true })
            .limit(q.limit),
        ),
      );
    },
  });
}
