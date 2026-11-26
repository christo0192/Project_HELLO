/**
 * The HR read of R1-over-Meet bookings (M034 S05, dark): what `GET /api/interview-rounds/meet-bookings`
 * and `GET /api/interview-rounds/meet-bookings/{id}` answer (the route is routes/r1-meet-bookings.ts;
 * S10 builds the page on it). The route answers before any of this runs while Meet is off.
 *
 * WHO SEES WHAT. The rule of the R1 video (`../recording/access.ts`), applied as a filter on the read
 * like the R1 queue (`../queue.ts`), so a page only ever holds what this person may see:
 *
 *   admin, viewer   every booking, including one whose Ashby application matched no candidate
 *   interviewer     only a booking whose candidate they own: `candidates!inner(owner_id)` plus an
 *                   owner filter, so a booking with no candidate is never theirs
 *   inactive user   nobody (refused before any read, as `requireAuth` also does)
 *
 * WHAT LEAVES. Exactly the eleven fields of `R1_MEET_BOOKING_FIELDS`: no Meet URL, no ticket field, no
 * Ashby id, no attester, no Recall bot id, no session and no profile. The eleventh, `source` (M035),
 * says where the booking came from (`ashby` or `public_page`); nothing else of 0143 is read (never the
 * calendar, manage or request columns). Every column is named in the select, and every row is
 * projected field by field, so a column added to the table (or an embed) can never reach a response.
 * Timestamps come back as `toISOString()` instants.
 *
 * A row that is not what migrations 0142 and 0143 allow (an id that is not a uuid, a status, reason or
 * source outside the closed lists, an unparseable instant, a version that is not a whole number) fails
 * the read as `unavailable`: the route answers 503 and never a page that silently drops a booking.
 *
 * ORDER AND PAGES. By `start_at` ascending, then `id`: a total order. One read of `limit + 1` rows
 * per page; the extra row only says that there is a next page, whose keyset cursor is the last row
 * returned. The cursor is base64url JSON `{ s, i }`: `s` must be the canonical `toISOString()` of an
 * instant and `i` a lower-case uuid, because that text is put into a PostgREST filter (the rule of
 * the phone attempt history cursor in `routes/candidates.ts`). A booking's `start_at` is written
 * from Ashby's startTime as a canonical `toISOString()` (`./ashby-schedule.ts`), so it has at most
 * millisecond precision and the cursor round-trips it exactly.
 *
 * The client is an argument (type-only import of `lib/supabase`): loading this module reads no
 * environment and performs no I/O. Nothing here logs, and no row value is put in an error.
 */

import type { supabase } from '../../supabase.js';
import { type R1StaffActor, seesEveryCandidate } from '../recording/access.js';
import { parseR1MeetInstant } from './ticket.js';

type Db = typeof supabase;

/** The booking statuses, in the order of 0142's `chk_r1_meet_bookings_status`. Frozen. */
export const R1_MEET_BOOKING_STATUSES = Object.freeze([
  'pending',
  'unmatched_application',
  'unmapped_scheduler',
  'blocked',
  'bot_scheduled',
  'bot_joining',
  'human_present',
  'in_call',
  'completed',
  'cancelled',
  'failed',
  'drained',
] as const);
export type R1MeetBookingStatus = (typeof R1_MEET_BOOKING_STATUSES)[number];

/**
 * Where a booking came from, in the order of 0143's `chk_r1_meet_bookings_source` (M035): `ashby` is a
 * slot HR scheduled in Ashby with Dex (M034), `public_page` one the candidate booked on the public R1
 * booking page. Frozen.
 */
export const R1_MEET_BOOKING_SOURCES = Object.freeze(['ashby', 'public_page'] as const);
export type R1MeetBookingSource = (typeof R1_MEET_BOOKING_SOURCES)[number];

/**
 * The booking reasons, in the order of 0143's `chk_r1_meet_bookings_reason` (M035): the 32 of 0142 in
 * 0142's order, then the two of the public booking page, `candidate_cancelled` (a `cancelled` reason:
 * the candidate cancelled with the link in their invite) and `invite_undeliverable` (a `failed`
 * reason: Dex's calendar invite could not be sent). Frozen.
 */
export const R1_MEET_BOOKING_REASONS = Object.freeze([
  'dex_absent',
  'cancelled',
  'in_past',
  'not_scheduled',
  'no_attester',
  'no_meet_link',
  'eligible',
  'application_unknown',
  'application_terminal',
  'scheduler_unmapped',
  'created_by_unknown',
  'disabled',
  'paused',
  'candidate_ineligible',
  'role_not_configured',
  'round_active',
  'phone_engagement_active',
  'phone_assessment_pending',
  'capacity_exhausted',
  'consent_template_unavailable',
  'slot_too_far',
  'bot_cap_reached',
  'bot_create_failed',
  'bot_fatal',
  'event_removed',
  'round_cancelled',
  'round_expired',
  'no_show',
  'admission_refused',
  'multiple_humans',
  'attempt_settled',
  'flag_off',
  'candidate_cancelled',
  'invite_undeliverable',
] as const);
export type R1MeetBookingReason = (typeof R1_MEET_BOOKING_REASONS)[number];

export const R1_MEET_BOOKINGS_DEFAULT_LIMIT = 50;
export const R1_MEET_BOOKINGS_MAX_LIMIT = 100;

/**
 * Every field a booking answer carries, in answer order, and the only columns the read selects.
 * `source` (0143, M035) is the eleventh and last.
 */
export const R1_MEET_BOOKING_FIELDS = Object.freeze([
  'id',
  'candidate_id',
  'round_id',
  'status',
  'reason',
  'start_at',
  'end_at',
  'created_at',
  'updated_at',
  'version',
  'source',
] as const);

/** What an admin or a viewer selects (pinned by `r1-meet-bookings-route.test.ts`). */
export const R1_MEET_BOOKINGS_SELECT = R1_MEET_BOOKING_FIELDS.join(',');
/** What an interviewer selects: the same columns, inner-joined to the candidate they must own. */
export const R1_MEET_BOOKINGS_OWNER_SELECT = `${R1_MEET_BOOKINGS_SELECT},candidates!inner(owner_id)`;

/** One booking as the HR read answers it. */
export interface R1MeetBookingView {
  readonly id: string;
  readonly candidate_id: string | null;
  readonly round_id: string | null;
  readonly status: R1MeetBookingStatus;
  readonly reason: R1MeetBookingReason;
  readonly start_at: string;
  readonly end_at: string;
  readonly created_at: string;
  readonly updated_at: string;
  readonly version: number;
  /** Where the booking came from: HR's Ashby schedule or the public R1 booking page (M035). */
  readonly source: R1MeetBookingSource;
}

/** A keyset position: the last booking of the previous page. */
export interface R1MeetBookingsCursor {
  /** Its `start_at`, as a canonical `toISOString()`. */
  readonly startAt: string;
  /** Its id, lower-case. */
  readonly id: string;
}

export interface R1MeetBookingsQuery {
  readonly status: R1MeetBookingStatus | null;
  /** `start_at >= from`, canonical ISO, or null. */
  readonly from: string | null;
  /** `start_at < to` (exclusive), canonical ISO, or null. */
  readonly to: string | null;
  readonly limit: number;
  readonly cursor: R1MeetBookingsCursor | null;
}

export type R1MeetBookingsResult =
  | { readonly kind: 'ok'; readonly bookings: readonly R1MeetBookingView[]; readonly nextCursor: string | null }
  | { readonly kind: 'forbidden' }
  | { readonly kind: 'unavailable' };

export type R1MeetBookingResult =
  | { readonly kind: 'ok'; readonly booking: R1MeetBookingView }
  | { readonly kind: 'not_found' }
  | { readonly kind: 'forbidden' }
  | { readonly kind: 'unavailable' };

const FORBIDDEN = Object.freeze({ kind: 'forbidden' as const });
const UNAVAILABLE = Object.freeze({ kind: 'unavailable' as const });
const NOT_FOUND = Object.freeze({ kind: 'not_found' as const });

const STATUSES: ReadonlySet<string> = new Set(R1_MEET_BOOKING_STATUSES);
const REASONS: ReadonlySet<string> = new Set(R1_MEET_BOOKING_REASONS);
const SOURCES: ReadonlySet<string> = new Set(R1_MEET_BOOKING_SOURCES);
const QUERY_KEYS: ReadonlySet<string> = new Set(['status', 'from', 'to', 'limit', 'cursor']);

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const LOWER_UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
const LIMIT = /^[1-9][0-9]{0,2}$/;
const BASE64URL = /^[A-Za-z0-9_-]+$/;
/** A cursor this module wrote is about 110 characters; anything far longer is not one. */
const CURSOR_MAX_LENGTH = 256;

function isPlainObject(value: unknown): value is Record<string, unknown> {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return false;
  const proto = Object.getPrototypeOf(value) as unknown;
  return proto === Object.prototype || proto === null;
}

/** The canonical `toISOString()` of a zoned ISO 8601 instant, or null. */
function canonicalInstant(value: unknown): string | null {
  const ms = parseR1MeetInstant(value);
  if (ms === null) return null;
  try {
    return new Date(ms).toISOString();
  } catch {
    return null;
  }
}

function uuidOrNull(value: unknown): string | null | undefined {
  if (value === null) return null;
  return typeof value === 'string' && UUID.test(value) ? value.toLowerCase() : undefined;
}

/** The cursor that resumes after `last`. */
export function encodeR1MeetBookingsCursor(last: R1MeetBookingsCursor): string {
  return Buffer.from(JSON.stringify({ s: last.startAt, i: last.id }), 'utf8').toString('base64url');
}

/**
 * The cursor `value` names, or null when it is not EXACTLY one this module writes: base64url with no
 * padding, JSON `{ s, i }` in that order and nothing else, `s` a canonical instant and `i` a lower-case
 * uuid. Re-encoding must give back the same text, so no other spelling of a position is accepted.
 */
export function decodeR1MeetBookingsCursor(value: unknown): R1MeetBookingsCursor | null {
  if (typeof value !== 'string' || value.length === 0 || value.length > CURSOR_MAX_LENGTH) return null;
  if (!BASE64URL.test(value)) return null;
  let parsed: unknown;
  try {
    parsed = JSON.parse(Buffer.from(value, 'base64url').toString('utf8'));
  } catch {
    return null;
  }
  if (!isPlainObject(parsed)) return null;
  const { s, i } = parsed;
  if (typeof s !== 'string' || typeof i !== 'string' || !LOWER_UUID.test(i)) return null;
  if (canonicalInstant(s) !== s) return null;
  const cursor = Object.freeze({ startAt: s, id: i });
  return encodeR1MeetBookingsCursor(cursor) === value ? cursor : null;
}

/**
 * The list query, or null when any part of it is not one this route takes: a parameter other than
 * `status`, `from`, `to`, `limit` and `cursor`; a repeated or nested parameter; a status outside the
 * twelve; a `from` or `to` that is not an ISO 8601 instant with its zone (normalised to
 * `toISOString()`), or `from` not before `to`; a limit outside 1 to 100 or not written as a plain
 * whole number; a cursor this module did not write.
 */
export function parseR1MeetBookingsQuery(query: unknown): R1MeetBookingsQuery | null {
  if (typeof query !== 'object' || query === null || Array.isArray(query)) return null;
  const params = query as Record<string, unknown>;
  for (const key of Object.keys(params)) if (!QUERY_KEYS.has(key)) return null;
  for (const key of QUERY_KEYS) {
    if (params[key] !== undefined && typeof params[key] !== 'string') return null;
  }
  const { status: rawStatus, from: rawFrom, to: rawTo, limit: rawLimit, cursor: rawCursor } = params;

  let status: R1MeetBookingStatus | null = null;
  if (rawStatus !== undefined) {
    if (!STATUSES.has(rawStatus as string)) return null;
    status = rawStatus as R1MeetBookingStatus;
  }
  const from = rawFrom === undefined ? null : canonicalInstant(rawFrom);
  if (rawFrom !== undefined && from === null) return null;
  const to = rawTo === undefined ? null : canonicalInstant(rawTo);
  if (rawTo !== undefined && to === null) return null;
  if (from !== null && to !== null && Date.parse(from) >= Date.parse(to)) return null;

  let limit = R1_MEET_BOOKINGS_DEFAULT_LIMIT;
  if (rawLimit !== undefined) {
    if (!LIMIT.test(rawLimit as string)) return null;
    limit = Number(rawLimit);
    if (limit > R1_MEET_BOOKINGS_MAX_LIMIT) return null;
  }
  const cursor = rawCursor === undefined ? null : decodeR1MeetBookingsCursor(rawCursor);
  if (rawCursor !== undefined && cursor === null) return null;

  return Object.freeze({ status, from, to, limit, cursor });
}

/** One row as the answer carries it, or null when it is not what 0142 and 0143 allow. */
function projectBooking(row: unknown): R1MeetBookingView | null {
  if (!isPlainObject(row)) return null;
  const id = uuidOrNull(row.id);
  const candidateId = uuidOrNull(row.candidate_id);
  const roundId = uuidOrNull(row.round_id);
  const startAt = canonicalInstant(row.start_at);
  const endAt = canonicalInstant(row.end_at);
  const createdAt = canonicalInstant(row.created_at);
  const updatedAt = canonicalInstant(row.updated_at);
  const { status, reason, version, source } = row;
  if (
    typeof id !== 'string'
    || candidateId === undefined
    || roundId === undefined
    || typeof status !== 'string'
    || !STATUSES.has(status)
    || typeof reason !== 'string'
    || !REASONS.has(reason)
    || startAt === null
    || endAt === null
    || createdAt === null
    || updatedAt === null
    || typeof version !== 'number'
    || !Number.isSafeInteger(version)
    || version < 0
    || typeof source !== 'string'
    || !SOURCES.has(source)
  ) {
    return null;
  }
  return Object.freeze({
    id,
    candidate_id: candidateId,
    round_id: roundId,
    status: status as R1MeetBookingStatus,
    reason: reason as R1MeetBookingReason,
    start_at: startAt,
    end_at: endAt,
    created_at: createdAt,
    updated_at: updatedAt,
    version,
    source: source as R1MeetBookingSource,
  });
}

/** Admin, viewer or interviewer, and active: the only actors this read serves. */
function mayRead(actor: R1StaffActor): boolean {
  return actor.active === true && (seesEveryCandidate(actor) || actor.appRole === 'interviewer');
}

/** The bookings table, filtered to what `actor` may see (the R1 video rule). */
function scopedRead(db: Db, actor: R1StaffActor) {
  if (seesEveryCandidate(actor)) return db.from('r1_meet_bookings').select(R1_MEET_BOOKINGS_SELECT);
  return db
    .from('r1_meet_bookings')
    .select(R1_MEET_BOOKINGS_OWNER_SELECT)
    .eq('candidates.owner_id', actor.id);
}

/** One page of the bookings `actor` may see. Never rejects. */
export async function readR1MeetBookings(
  db: Db,
  actor: R1StaffActor,
  query: R1MeetBookingsQuery,
): Promise<R1MeetBookingsResult> {
  if (!mayRead(actor)) return FORBIDDEN;
  try {
    let read = scopedRead(db, actor);
    if (query.status !== null) read = read.eq('status', query.status);
    if (query.from !== null) read = read.gte('start_at', query.from);
    if (query.to !== null) read = read.lt('start_at', query.to);
    if (query.cursor !== null) {
      // Canonical instant and lower-case uuid only (decodeR1MeetBookingsCursor): safe in a filter.
      const { startAt, id } = query.cursor;
      read = read.or(`start_at.gt.${startAt},and(start_at.eq.${startAt},id.gt.${id})`);
    }
    const { data, error } = await read
      .order('start_at', { ascending: true })
      .order('id', { ascending: true })
      .limit(query.limit + 1);
    if (error || !Array.isArray(data)) return UNAVAILABLE;
    const bookings: R1MeetBookingView[] = [];
    for (const row of (data as unknown[]).slice(0, query.limit)) {
      const booking = projectBooking(row);
      if (booking === null) return UNAVAILABLE;
      bookings.push(booking);
    }
    const last = bookings[bookings.length - 1];
    const nextCursor = data.length > query.limit && last !== undefined
      ? encodeR1MeetBookingsCursor({ startAt: last.start_at, id: last.id })
      : null;
    return Object.freeze({ kind: 'ok' as const, bookings: Object.freeze(bookings), nextCursor });
  } catch {
    return UNAVAILABLE;
  }
}

/**
 * One booking, if `actor` may see it. `not_found` both when it does not exist and when it is not
 * theirs, so an interviewer learns nothing about another owner's bookings. Never rejects.
 */
export async function readR1MeetBooking(db: Db, actor: R1StaffActor, id: string): Promise<R1MeetBookingResult> {
  if (!mayRead(actor)) return FORBIDDEN;
  const bookingId = uuidOrNull(id);
  if (typeof bookingId !== 'string') return NOT_FOUND;
  try {
    const { data, error } = await scopedRead(db, actor).eq('id', bookingId).maybeSingle();
    if (error) return UNAVAILABLE;
    if (data === null || data === undefined) return NOT_FOUND;
    const booking = projectBooking(data);
    return booking === null ? UNAVAILABLE : Object.freeze({ kind: 'ok' as const, booking });
  } catch {
    return UNAVAILABLE;
  }
}
