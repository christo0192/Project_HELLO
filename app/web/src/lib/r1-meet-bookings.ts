/**
 * The Meet bookings client (M034 S10, dark): `GET /api/interview-rounds/meet-bookings` as
 * app/api/src/lib/r1/meet/bookings-read.ts answers it, the words the page says about a booking and
 * what its address means. Pure: no React, no DOM, no clock. The request itself is
 * `api.listR1MeetBookings`.
 *
 * Invariants:
 *   - The server decides whether Meet is on. While it is off the answer is `meet_enabled: false`,
 *     and that always reads as an empty page here, whatever came with it.
 *   - A row is copied field by field, exactly the ten fields of the contract. A field the API should
 *     never send (a Meet URL, a bot id, an attester) cannot reach the page through this file.
 *   - A body that is not in the contract shape is refused whole as `r1_meet_bookings_malformed`.
 *     A status or reason this file does not know is not malformed: an API ahead of this page keeps
 *     its row, in words that never print the code (D-S10-10).
 *   - Every day and time is India time, named at each conversion (`ist-datetime`), never the host's.
 *
 * `r1-meet-bookings.test.ts` compares the two vocabularies and the ten fields with openapi.yaml, so
 * a change on the API side goes red there.
 */

import type { TagTone } from '../components/design/Tag';
import { ApiError } from './api-client';
import { NOT_AVAILABLE, formatDateTime } from './datetime';
import {
  IST_TIME_ZONE,
  addIstDays,
  formatIstDayLabel,
  formatIstTime,
  formatIstTimeRange,
  isIstDate,
  istDateOf,
  istDayStartUtcIso,
} from './ist-datetime';
import type { IstDate } from './ist-datetime';
import { R1_MEET_BOOKING_STATUSES } from './r1-meet-bookings-types';
import type {
  R1MeetBooking,
  R1MeetBookingReason,
  R1MeetBookingStatus,
  R1MeetBookingsBody,
  R1MeetBookingsQuery,
} from './r1-meet-bookings-types';

// The wire shapes live in a module with no runtime import, so the e2e harness can type its fixture
// against them; every caller keeps reading them from here.
export { R1_MEET_BOOKING_REASONS, R1_MEET_BOOKING_STATUSES } from './r1-meet-bookings-types';
export type {
  R1MeetBooking,
  R1MeetBookingReason,
  R1MeetBookingStatus,
  R1MeetBookingsBody,
  R1MeetBookingsQuery,
} from './r1-meet-bookings-types';

export const R1_MEET_BOOKINGS_PATH = '/api/interview-rounds/meet-bookings';

/** The read's path. The API refuses any parameter it does not know, so nothing else is ever sent. */
export function r1MeetBookingsPath(query: R1MeetBookingsQuery = {}): string {
  const params = new URLSearchParams();
  if (query.status) params.set('status', query.status);
  if (query.from) params.set('from', query.from);
  if (query.to) params.set('to', query.to);
  if (query.cursor) params.set('cursor', query.cursor);
  const search = params.toString();
  return search ? `${R1_MEET_BOOKINGS_PATH}?${search}` : R1_MEET_BOOKINGS_PATH;
}

/* ── The strict reader ────────────────────────────────────────────── */

const MALFORMED = 'r1_meet_bookings_malformed';

function malformed(): never {
  throw new ApiError(MALFORMED, 200, MALFORMED);
}

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
/** With its zone: `Date.parse` alone would read a zoneless time in the viewer's own zone. */
const ZONED_INSTANT = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}(?::\d{2}(?:\.\d{1,9})?)?(?:Z|[+-]\d{2}:\d{2})$/;

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === 'object' && value !== null && !Array.isArray(value);
const isText = (value: unknown): value is string => typeof value === 'string' && value !== '';
const isUuid = (value: unknown): value is string => typeof value === 'string' && UUID.test(value);
const isUuidOrNull = (value: unknown): value is string | null => value === null || isUuid(value);
const isInstant = (value: unknown): value is string =>
  typeof value === 'string' && ZONED_INSTANT.test(value) && !Number.isNaN(Date.parse(value));
const isWholeNumber = (value: unknown): value is number => Number.isSafeInteger(value) && (value as number) >= 0;

function readBooking(row: unknown): R1MeetBooking {
  if (!isRecord(row)) malformed();
  const { id, candidate_id, round_id, status, reason, start_at, end_at, created_at, updated_at, version } = row;
  if (!isUuid(id) || !isUuidOrNull(candidate_id) || !isUuidOrNull(round_id)) malformed();
  if (!isText(status) || !isText(reason)) malformed();
  if (!isInstant(start_at) || !isInstant(end_at) || !isInstant(created_at) || !isInstant(updated_at)) malformed();
  if (!isWholeNumber(version)) malformed();
  return { id, candidate_id, round_id, status, reason, start_at, end_at, created_at, updated_at, version };
}

/**
 * The page, or `r1_meet_bookings_malformed`. One bad row refuses the page: the API never sends a page
 * that silently drops a booking, and this does not make one. The off answer is decided on the frame
 * alone, so a row that came with it is not even read.
 */
export function readR1MeetBookings(body: unknown): R1MeetBookingsBody {
  if (!isRecord(body)) malformed();
  const { meet_enabled, bookings, next_cursor } = body;
  if (typeof meet_enabled !== 'boolean' || !Array.isArray(bookings)) malformed();
  if (next_cursor !== null && !isText(next_cursor)) malformed();
  if (!meet_enabled) return { meet_enabled: false, bookings: [], next_cursor: null };
  return { meet_enabled: true, bookings: (bookings as unknown[]).map(readBooking), next_cursor };
}

/* ── The words ────────────────────────────────────────────────────── */

export interface MeetBookingTerm {
  label: string;
  tone: TagTone;
}

const STATUS_TERM: Readonly<Record<R1MeetBookingStatus, MeetBookingTerm>> = {
  pending: { label: 'Booked', tone: 'moving' },
  unmatched_application: { label: 'No matching candidate', tone: 'unresolved' },
  unmapped_scheduler: { label: 'Scheduler not matched', tone: 'unresolved' },
  blocked: { label: 'Blocked', tone: 'unresolved' },
  bot_scheduled: { label: 'Dex scheduled', tone: 'moving' },
  bot_joining: { label: 'Dex joining', tone: 'moving' },
  human_present: { label: 'Someone has joined', tone: 'moving' },
  in_call: { label: 'Interview in progress', tone: 'moving' },
  completed: { label: 'Completed', tone: 'ready' },
  cancelled: { label: 'Cancelled', tone: 'closed' },
  // Nobody on our side failed (a no-show, a second person): unfinished, as on every other screen.
  failed: { label: 'Not completed', tone: 'unresolved' },
  drained: { label: 'Stopped', tone: 'closed' },
};

/** The two ways a booking fails that are a fault on our side, so the only ones that say Failed. */
const OUR_FAULT: ReadonlySet<string> = new Set<R1MeetBookingReason>(['bot_create_failed', 'bot_fatal']);
const FAILED_TERM: MeetBookingTerm = { label: 'Failed', tone: 'negative' };
const UNKNOWN_TERM: MeetBookingTerm = { label: 'Not recognised', tone: 'neutral' };

const isMeetStatus = (value: unknown): value is R1MeetBookingStatus =>
  typeof value === 'string' && Object.hasOwn(STATUS_TERM, value);

/** A booking's status word and its family. An unknown status has no meaning, and its code stays off the page. */
export function meetBookingTerm(status: string, reason?: string): MeetBookingTerm {
  if (!isMeetStatus(status)) return UNKNOWN_TERM;
  if (status === 'failed' && reason !== undefined && OUR_FAULT.has(reason)) return FAILED_TERM;
  return STATUS_TERM[status];
}

const REASON_TEXT: Readonly<Record<R1MeetBookingReason, string | null>> = {
  dex_absent: 'Dex is no longer an interviewer in Ashby.',
  cancelled: 'Cancelled in Ashby.',
  in_past: 'The slot had already started.',
  not_scheduled: 'Ashby does not show this interview as scheduled.',
  no_attester: 'Ashby does not say who scheduled this interview.',
  no_meet_link: 'Ashby has no Google Meet link for this interview.',
  // Nothing is in the way, so there is nothing to say.
  eligible: null,
  application_unknown: 'The Ashby application is not linked to a candidate in HELLO yet.',
  application_terminal: 'The Ashby application has ended.',
  scheduler_unmapped: 'The person who scheduled it in Ashby has no HELLO account.',
  created_by_unknown: 'The HELLO account for this booking could not be found.',
  disabled: 'R1 is switched off.',
  paused: 'R1 is paused.',
  candidate_ineligible: 'This candidate is not eligible for R1.',
  role_not_configured: 'The Sales Program Advisor role has not been set up yet.',
  round_active: 'The candidate already has an R1 round open.',
  phone_engagement_active: 'A phone screening is in progress or scheduled for this candidate.',
  phone_assessment_pending: 'The candidate’s phone screening is still being scored.',
  capacity_exhausted: 'This month’s R1 allowance is used up.',
  consent_template_unavailable: 'No active R1 notice is available.',
  slot_too_far: 'The slot is too far ahead to set up yet.',
  bot_cap_reached: 'The daily limit of Meet interviews was reached for that day.',
  bot_create_failed: 'The meeting bot could not be set up.',
  bot_fatal: 'The meeting bot stopped with an error.',
  event_removed: 'The interview was removed in Ashby.',
  round_cancelled: 'The R1 round was cancelled in HELLO.',
  round_expired: 'The R1 round expired first.',
  no_show: 'No one joined the meeting in time.',
  admission_refused: 'R1 did not let the interview start.',
  multiple_humans: 'More than one person was in the meeting.',
  attempt_settled: 'The interview has ended.',
  flag_off: 'Google Meet interviews were turned off.',
};

/** Why a booking is where it is, or null when there is nothing to say. Never the reason's code. */
export function meetBookingReasonText(reason: string): string | null {
  return Object.hasOwn(REASON_TEXT, reason)
    ? REASON_TEXT[reason as R1MeetBookingReason]
    : 'This page does not know the reason.';
}

/** The status filter. `failed` covers both of its words, so its option says both. */
export const R1_MEET_STATUS_OPTIONS: ReadonlyArray<{ value: R1MeetBookingStatus | ''; label: string }> = [
  { value: '', label: 'Any status' },
  ...R1_MEET_BOOKING_STATUSES.map((value) => ({
    value,
    label: value === 'failed' ? 'Not completed or failed' : STATUS_TERM[value].label,
  })),
];

/* ── The times ────────────────────────────────────────────────────── */

export interface MeetBookingSlot {
  day: string;
  time: string;
  /**
   * Both, for a link's own name, with the range said with "to": a screen reader announces an en dash as a
   * pause or not at all, which would turn the slot into two bare times (as `formatIstBandLabel` says).
   */
  text: string;
}

/** `Tue 24 Nov 2026`: the year too, since a booking can be months away on either side. */
function dayWithYear(date: IstDate | null): string {
  const label = formatIstDayLabel(date ?? '');
  return isIstDate(date) ? `${label} ${date.slice(0, 4)}` : label;
}

/** A booking's slot in India time. A slot that crosses midnight there names the day it ends on. */
export function meetBookingSlot(startIso: string, endIso: string): MeetBookingSlot {
  const startDate = istDateOf(startIso);
  const endDate = istDateOf(endIso);
  const day = dayWithYear(startDate);
  const crossesMidnight = startDate !== null && endDate !== null && startDate !== endDate;
  const time = crossesMidnight
    ? `${formatIstTime(startIso)} to ${dayWithYear(endDate)}, ${formatIstTime(endIso)}`
    : formatIstTimeRange(startIso, endIso);
  // `formatIstTimeRange` joins its two times with its one en dash; the eye keeps it, the name says "to".
  const spoken = crossesMidnight ? time : time.replace('–', ' to ');
  return { day, time, text: `${day}, ${spoken}` };
}

const STAMP: Intl.DateTimeFormatOptions = {
  year: 'numeric',
  month: 'short',
  day: 'numeric',
  hour: 'numeric',
  minute: '2-digit',
  timeZone: IST_TIME_ZONE,
};

/** When a booking was made or last changed, in India time. One shared formatter, as it runs per row. */
export function meetBookingStamp(iso: string): string {
  const text = formatDateTime(iso, STAMP);
  return text === NOT_AVAILABLE ? text : `${text} IST`;
}

/* ── The address ──────────────────────────────────────────────────── */

/** What the page is showing. Days are India days, and To includes its own day. */
export interface MeetFilters {
  status: R1MeetBookingStatus | null;
  from: IstDate | null;
  to: IstDate | null;
}

/**
 * The days a filter may hold. The end matters: the day after 9999-12-31 is not a `YYYY-MM-DD` day, so
 * the API's exclusive `to` could not be made from it.
 */
export const MEET_FILTER_FIRST_DATE: IstDate = '2020-01-01';
export const MEET_FILTER_LAST_DATE: IstDate = '2099-12-31';

export function isMeetFilterDate(value: unknown): value is IstDate {
  return isIstDate(value) && value >= MEET_FILTER_FIRST_DATE && value <= MEET_FILTER_LAST_DATE;
}

/**
 * The filters an address names. No `from` is today (the API sorts the earliest slot first, so without
 * it the page would open on the oldest history) and an empty one is no lower bound. No `from` with a
 * `to` before today is no lower bound as well: a From nobody chose never refuses a To somebody did, so
 * "To = yesterday" lists everything up to yesterday. Anything this page cannot read is read as absent,
 * never as an error.
 */
export function meetFiltersFrom(params: URLSearchParams, today: IstDate): MeetFilters {
  const status = params.get('status');
  const from = params.get('from');
  const rawTo = params.get('to');
  const to = isMeetFilterDate(rawTo) ? rawTo : null;
  const implicitFrom = to !== null && to < today ? null : today;
  return {
    status: isMeetStatus(status) ? status : null,
    from: from === '' ? null : isMeetFilterDate(from) ? from : implicitFrom,
    to,
  };
}

/** Whether an address names the page as it opens: every status, from today on. */
export function meetFiltersAreDefault(params: URLSearchParams): boolean {
  const from = params.get('from');
  return (
    !isMeetStatus(params.get('status')) && from !== '' && !isMeetFilterDate(from) && !isMeetFilterDate(params.get('to'))
  );
}

/** Why these filters cannot be asked for, or null. The page makes no request while there is a reason. */
export function meetDateError(filters: MeetFilters): string | null {
  const { from, to } = filters;
  return from !== null && to !== null && to < from ? 'The To date is before the From date.' : null;
}

/** The request for these filters. The API's `to` is exclusive, so the To day ends where the next begins. */
export function meetBookingsQuery(filters: MeetFilters, cursor: string | null = null): R1MeetBookingsQuery {
  return {
    status: filters.status,
    from: filters.from === null ? null : istDayStartUtcIso(filters.from),
    to: filters.to === null ? null : istDayStartUtcIso(addIstDays(filters.to, 1)),
    cursor,
  };
}

/**
 * The API's one order: the slot's start, then the id. Postgres compares a uuid as its bytes, which is the
 * order of its lower-case hex. Every row passed the reader, so its start is a readable instant.
 */
function bySlot(left: R1MeetBooking, right: R1MeetBooking): number {
  const apart = Date.parse(left.start_at) - Date.parse(right.start_at);
  if (apart !== 0 && !Number.isNaN(apart)) return apart;
  const a = left.id.toLowerCase();
  const b = right.id.toLowerCase();
  return a < b ? -1 : a > b ? 1 : 0;
}

/**
 * One more page after what is shown, earliest first as the count line says. A booking rescheduled
 * between two reads can come back on a later page: the copy just read is the newer one and replaces the
 * old one, so no booking shows twice, and it goes where its new slot falls. A booking moved to before the
 * pages already read is on no later page, so it keeps the slot it was read with until the list is read
 * again (a keyset page cannot know of it).
 */
export function mergeMeetBookings(
  shown: readonly R1MeetBooking[],
  next: readonly R1MeetBooking[],
): R1MeetBooking[] {
  const byId = new Map(shown.map((booking) => [booking.id, booking]));
  for (const booking of next) byId.set(booking.id, booking);
  return [...byId.values()].sort(bySlot);
}
