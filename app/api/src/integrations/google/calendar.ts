/**
 * google/calendar.ts — Dex's primary Google Calendar, the events of the R1 public booking link
 * (M035 S03, contract §7.1 and §8).
 *
 * OUTBOUND BOUNDARY, DARK. Nothing builds this at runtime yet; `createR1MeetGoogle` (client.ts)
 * does, and S05/S06 call that only when the public booking configuration is `on`. It reads NO
 * environment.
 *
 * What it guarantees (S03 plan R5, R7, R16):
 * - Only `calendars/primary` of the token's user (Dex), so Dex is always the organizer. The event id
 *   is the booking UUID without dashes (32 lowercase hex, pinned by the 0143 CHECK), which makes an
 *   insert idempotent: a replay answers `already_exists`.
 * - Insert sends `conferenceDataVersion=1&sendUpdates=none`, NO `attendees` key and never a
 *   `displayName` (the candidate is added later by `patchEvent`, with the on-file email only),
 *   `guestsCanInviteOthers/Modify/SeeOtherGuests = false`, reminders off and only
 *   `extendedProperties.private.hello_booking_id`. Calendar mode asks Google for a Meet
 *   (`conferenceData.createRequest`, type `hangoutsMeet`); space mode puts the canonical link of a
 *   space made through the Meet API into `location` instead.
 * - Patch sends only the fields given (Google replaces arrays wholesale, so `attendees` is sent ONLY
 *   when an attendee is given, as exactly one `{email}`), with `conferenceDataVersion=1` so the
 *   conference is kept, and `sendUpdates` = `all` or `none`. Delete sends `sendUpdates` too.
 * - Every input is validated BEFORE a token is minted: a refused call makes ZERO transport calls of
 *   any kind (no token request either) and throws `GoogleError('invalid_request')`.
 * - The parsed event is closed: id (must equal the requested one), status, organizer email, the
 *   canonical Meet link, the conference status and code, start, end and at most ten attendee
 *   emails. Summary, description, names, extended properties and entry points are dropped.
 * - One attempt per call (plus the single re-mint on a 401, `sendAuthorizedGoogleRequest`), a
 *   deadline, a body cap and one metadata-only log record per call. The event id, the Meet link,
 *   emails and the description never reach a log record or an error.
 */

import { GOOGLE_MEET_CODE_RE, normalizeGoogleMeetUrl } from '../google-meet/url.js';
import { GoogleError, type GoogleOperation } from './errors.js';
import {
  GOOGLE_CALENDAR_EVENTS_URL,
  emitGoogleLog,
  sendAuthorizedGoogleRequest,
  type GoogleAccessTokenProvider,
  type GoogleClientLogger,
  type GoogleSendOptions,
  type GoogleSendResult,
  type GoogleTransport,
} from './http.js';

// ── Public shapes (contract §7.1) ───────────────────────────────────────────

export interface GoogleCalendarEvent {
  id: string;
  status: string;
  organizerEmail: string | null;
  hangoutLink: string | null;
  conferenceStatus: 'pending' | 'success' | 'failure' | null;
  conferenceId: string | null;
  startAt: string | null;
  endAt: string | null;
  attendeeEmails: readonly string[];
}

export interface GoogleCalendarEventInsert {
  /** The booking UUID without dashes: 32 lowercase hex. */
  id: string;
  summary: string;
  description: string;
  startAt: string;
  endAt: string;
  /** The conference create request id (calendar mode): `^[A-Za-z0-9-]{1,64}$`. */
  requestId: string;
  /** The booking UUID (lowercase, with dashes). */
  bookingId: string;
  /** true = calendar mode (Google makes the Meet); false = space mode (`location` holds it). */
  withConference: boolean;
  /** null in calendar mode; the canonical Meet URL in space mode. */
  location: string | null;
}

export interface GoogleCalendarEventPatch {
  startAt?: string;
  endAt?: string;
  attendeeEmail?: string;
  description?: string;
}

export type GoogleCalendarSendUpdates = 'all' | 'none';

export interface GoogleCalendarClient {
  insertEvent(e: GoogleCalendarEventInsert): Promise<GoogleCalendarEvent>;
  /** null on 404 / 410. */
  getEvent(id: string): Promise<GoogleCalendarEvent | null>;
  patchEvent(id: string, p: GoogleCalendarEventPatch, sendUpdates: GoogleCalendarSendUpdates): Promise<GoogleCalendarEvent>;
  /** 404 / 410 = `'gone'`. */
  deleteEvent(id: string, sendUpdates: GoogleCalendarSendUpdates): Promise<'deleted' | 'gone'>;
}

export interface GoogleCalendarClientOptions {
  /** Dex's token source (`createR1MeetGoogle` shares one with the Meet client). */
  tokenSource: GoogleAccessTokenProvider;
  /** Test seam: fully replaces the network. */
  transport?: GoogleTransport;
  /** Metadata-only logger: one record per public call. */
  logger?: GoogleClientLogger;
  /** Per-request deadline (default 10 s, clamped 1..30 s). */
  timeoutMs?: number;
  /** Response cap (default 512 KiB, clamped 1 KiB..4 MiB). */
  maxResponseBytes?: number;
}

// ── Rules (R7) ──────────────────────────────────────────────────────────────

/** Every event is in IST: the booking page and the invite speak India time. */
export const GOOGLE_CALENDAR_TIME_ZONE = 'Asia/Kolkata';
export const GOOGLE_CALENDAR_SUMMARY_MAX_LENGTH = 200;
export const GOOGLE_CALENDAR_DESCRIPTION_MAX_LENGTH = 4096;
/** An event lasts more than zero and at most 24 hours. */
export const GOOGLE_CALENDAR_MAX_EVENT_MS = 24 * 60 * 60 * 1000;
/** At most this many attendee emails are kept when an event is parsed. */
export const GOOGLE_CALENDAR_MAX_PARSED_ATTENDEES = 10;

/** The event id of a booking: its UUID without dashes. */
export const GOOGLE_CALENDAR_EVENT_ID_RE = /^[0-9a-f]{32}$/;
const BOOKING_UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
const REQUEST_ID_RE = /^[A-Za-z0-9-]{1,64}$/;
const EVENT_STATUS_RE = /^[a-z_]{1,32}$/;
const ISO_DATE_TIME_RE =
  /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2}):(\d{2})(?:\.\d{1,9})?(?:Z|([+-])(\d{2}):(\d{2}))$/;
/** Control, format (bidi, zero-width), surrogate and line/paragraph separator characters. */
const UNSAFE_TEXT_RE = /[\p{Cc}\p{Cf}\p{Cs}\p{Zl}\p{Zp}]/u;
/** The same, but a newline is allowed (the description is plain multi-line text). */
const UNSAFE_MULTILINE_TEXT_RE = /(?!\n)[\p{Cc}\p{Cf}\p{Cs}\p{Zl}\p{Zp}]/u;
const MAX_EMAIL_LENGTH = 254;
const EMAIL_FORBIDDEN_RE = /[\s<>(),;:"\\\p{Cc}\p{Cf}\p{Cs}\p{Zl}\p{Zp}]/u;
/** How many attendee entries of a response are looked at. */
const MAX_ATTENDEE_ENTRIES = 50;

const PATCH_KEYS: ReadonlySet<string> = new Set(['startAt', 'endAt', 'attendeeEmail', 'description']);
const INSERT_KEYS: readonly string[] = Object.freeze([
  'id',
  'summary',
  'description',
  'startAt',
  'endAt',
  'requestId',
  'bookingId',
  'withConference',
  'location',
]);

/**
 * Strict ISO 8601 date-time with a `Z` or `±hh:mm` offset and a real calendar date (Date.parse
 * alone would accept 30 February). Local to this module on purpose (no import from the Recall
 * client): the same shape as its `isRecallIsoDateTime`.
 */
export function isGoogleIsoDateTime(raw: unknown): raw is string {
  if (typeof raw !== 'string' || raw.length > 64) return false;
  const match = ISO_DATE_TIME_RE.exec(raw);
  if (!match) return false;
  const [, y, mo, d, h, mi, s, , oh, om] = match;
  const year = Number(y);
  const month = Number(mo);
  const day = Number(d);
  if (month < 1 || month > 12 || day < 1) return false;
  const daysInMonth = new Date(Date.UTC(year, month, 0)).getUTCDate();
  if (day > daysInMonth) return false;
  if (Number(h) > 23 || Number(mi) > 59 || Number(s) > 59) return false;
  if (oh !== undefined && (Number(oh) > 23 || Number(om) > 59)) return false;
  return Number.isFinite(Date.parse(raw));
}

/** One email address: at most 254 characters, exactly one `@`, a dotted domain, no whitespace or list punctuation. */
function isEmailAddress(raw: unknown): raw is string {
  if (typeof raw !== 'string' || raw.length < 3 || raw.length > MAX_EMAIL_LENGTH) return false;
  if (EMAIL_FORBIDDEN_RE.test(raw)) return false;
  const parts = raw.split('@');
  if (parts.length !== 2) return false;
  const [local, domain] = parts as [string, string];
  if (local.length === 0 || domain.length < 3) return false;
  const dot = domain.indexOf('.');
  return dot > 0 && !domain.endsWith('.');
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function isSummary(raw: unknown): raw is string {
  return (
    typeof raw === 'string' &&
    raw.length >= 1 &&
    raw.length <= GOOGLE_CALENDAR_SUMMARY_MAX_LENGTH &&
    raw.trim() !== '' &&
    !UNSAFE_TEXT_RE.test(raw)
  );
}

function isDescription(raw: unknown): raw is string {
  return (
    typeof raw === 'string' &&
    raw.length <= GOOGLE_CALENDAR_DESCRIPTION_MAX_LENGTH &&
    !UNSAFE_MULTILINE_TEXT_RE.test(raw)
  );
}

/** Both strict ISO, end after start, at most 24 hours apart. */
function isTimeRange(startAt: unknown, endAt: unknown): boolean {
  if (!isGoogleIsoDateTime(startAt) || !isGoogleIsoDateTime(endAt)) return false;
  const span = Date.parse(endAt) - Date.parse(startAt);
  return span > 0 && span <= GOOGLE_CALENDAR_MAX_EVENT_MS;
}

function isSendUpdates(raw: unknown): raw is GoogleCalendarSendUpdates {
  return raw === 'all' || raw === 'none';
}

const timed = (dateTime: string) => ({ dateTime, timeZone: GOOGLE_CALENDAR_TIME_ZONE });

// ── Parse (closed) ──────────────────────────────────────────────────────────

function parseEmail(raw: unknown): string | null {
  return isEmailAddress(raw) ? raw.toLowerCase() : null;
}

function parseConferenceStatus(conference: unknown): GoogleCalendarEvent['conferenceStatus'] {
  if (!isPlainObject(conference) || !isPlainObject(conference.createRequest)) return null;
  const status = conference.createRequest.status;
  if (!isPlainObject(status)) return null;
  const code = status.statusCode;
  return code === 'pending' || code === 'success' || code === 'failure' ? code : null;
}

function parseAttendees(raw: unknown): readonly string[] {
  const out: string[] = [];
  if (Array.isArray(raw)) {
    for (const entry of raw.slice(0, MAX_ATTENDEE_ENTRIES)) {
      if (out.length >= GOOGLE_CALENDAR_MAX_PARSED_ATTENDEES) break;
      if (!isPlainObject(entry)) continue;
      const email = parseEmail(entry.email);
      if (email !== null && !out.includes(email)) out.push(email);
    }
  }
  return Object.freeze(out);
}

/**
 * The closed event of contract §7.1 from a 2xx body. The id must equal `expectedId` and the status
 * must be a plain word, else `malformed_response`; every other field is null (or empty) when it is
 * missing or not well formed.
 */
function parseEvent(operation: GoogleOperation, expectedId: string, result: GoogleSendResult): GoogleCalendarEvent {
  const malformed = () => new GoogleError('malformed_response', { operation, httpStatus: result.status });
  const json = result.json;
  if (!isPlainObject(json)) throw malformed();
  if (json.id !== expectedId) throw malformed();
  if (typeof json.status !== 'string' || !EVENT_STATUS_RE.test(json.status)) throw malformed();
  const organizer = isPlainObject(json.organizer) ? json.organizer : {};
  const conference = isPlainObject(json.conferenceData) ? json.conferenceData : null;
  const conferenceId = conference !== null ? conference.conferenceId : undefined;
  const start = isPlainObject(json.start) ? json.start.dateTime : undefined;
  const end = isPlainObject(json.end) ? json.end.dateTime : undefined;
  return Object.freeze({
    id: expectedId,
    status: json.status,
    organizerEmail: parseEmail(organizer.email),
    hangoutLink: normalizeGoogleMeetUrl(json.hangoutLink),
    conferenceStatus: parseConferenceStatus(conference),
    conferenceId: typeof conferenceId === 'string' && GOOGLE_MEET_CODE_RE.test(conferenceId) ? conferenceId : null,
    startAt: isGoogleIsoDateTime(start) ? start : null,
    endAt: isGoogleIsoDateTime(end) ? end : null,
    attendeeEmails: parseAttendees(json.attendees),
  });
}

// ── Client ──────────────────────────────────────────────────────────────────

class GoogleCalendarHttpClient implements GoogleCalendarClient {
  readonly #tokens: GoogleAccessTokenProvider;
  readonly #send: GoogleSendOptions;

  constructor(o: GoogleCalendarClientOptions) {
    const refuse = () => new GoogleError('invalid_request');
    if (!isPlainObject(o)) throw refuse();
    const tokens = o.tokenSource;
    if (
      typeof tokens !== 'object' ||
      tokens === null ||
      typeof tokens.accessToken !== 'function' ||
      typeof tokens.invalidate !== 'function'
    ) {
      throw refuse();
    }
    if (o.transport !== undefined && typeof o.transport !== 'function') throw refuse();
    if (o.logger !== undefined && (o.logger === null || typeof o.logger.event !== 'function')) throw refuse();
    this.#tokens = tokens;
    const send: GoogleSendOptions = {};
    if (o.transport !== undefined) send.transport = o.transport;
    if (o.logger !== undefined) send.logger = o.logger;
    if (o.timeoutMs !== undefined) send.timeoutMs = o.timeoutMs;
    if (o.maxResponseBytes !== undefined) send.maxResponseBytes = o.maxResponseBytes;
    this.#send = send;
  }

  /** Refused before any token or network: one failure record, zero calls of any kind. */
  #refuse(operation: GoogleOperation): Promise<never> {
    const refusal = new GoogleError('invalid_request', { operation });
    emitGoogleLog(this.#send.logger, { operation, startedAt: Date.now(), error: refusal });
    return Promise.reject(refusal);
  }

  async insertEvent(e: GoogleCalendarEventInsert): Promise<GoogleCalendarEvent> {
    const operation: GoogleOperation = 'calendar.insert';
    if (!isPlainObject(e)) return this.#refuse(operation);
    if (Object.keys(e).some((key) => !INSERT_KEYS.includes(key))) return this.#refuse(operation);
    const { id, summary, description, startAt, endAt, requestId, bookingId, withConference, location } = e;
    if (typeof bookingId !== 'string' || !BOOKING_UUID_RE.test(bookingId)) return this.#refuse(operation);
    if (typeof id !== 'string' || !GOOGLE_CALENDAR_EVENT_ID_RE.test(id) || id !== bookingId.replace(/-/g, '')) {
      return this.#refuse(operation);
    }
    if (typeof requestId !== 'string' || !REQUEST_ID_RE.test(requestId)) return this.#refuse(operation);
    if (!isSummary(summary) || !isDescription(description)) return this.#refuse(operation);
    if (!isTimeRange(startAt, endAt)) return this.#refuse(operation);
    if (typeof withConference !== 'boolean') return this.#refuse(operation);
    if (withConference) {
      if (location !== null) return this.#refuse(operation);
    } else if (typeof location !== 'string' || normalizeGoogleMeetUrl(location) !== location) {
      return this.#refuse(operation);
    }

    const body: Record<string, unknown> = {
      id,
      summary,
      description,
      start: timed(startAt),
      end: timed(endAt),
    };
    if (withConference) {
      body.conferenceData = { createRequest: { requestId, conferenceSolutionKey: { type: 'hangoutsMeet' } } };
    } else {
      body.location = location;
    }
    body.guestsCanInviteOthers = false;
    body.guestsCanModify = false;
    body.guestsCanSeeOtherGuests = false;
    body.reminders = { useDefault: false, overrides: [] };
    body.extendedProperties = { private: { hello_booking_id: bookingId } };

    return sendAuthorizedGoogleRequest(
      {
        operation,
        method: 'POST',
        url: `${GOOGLE_CALENDAR_EVENTS_URL}?conferenceDataVersion=1&sendUpdates=none`,
        body: JSON.stringify(body),
      },
      this.#tokens,
      this.#send,
      { parse: (result) => parseEvent(operation, id, result) },
    );
  }

  async getEvent(id: string): Promise<GoogleCalendarEvent | null> {
    const operation: GoogleOperation = 'calendar.get';
    if (typeof id !== 'string' || !GOOGLE_CALENDAR_EVENT_ID_RE.test(id)) return this.#refuse(operation);
    return sendAuthorizedGoogleRequest<GoogleCalendarEvent | null>(
      { operation, method: 'GET', url: `${GOOGLE_CALENDAR_EVENTS_URL}/${id}` },
      this.#tokens,
      this.#send,
      { parse: (result) => parseEvent(operation, id, result), onNotFound: () => null },
    );
  }

  async patchEvent(
    id: string,
    p: GoogleCalendarEventPatch,
    sendUpdates: GoogleCalendarSendUpdates,
  ): Promise<GoogleCalendarEvent> {
    const operation: GoogleOperation = 'calendar.patch';
    if (typeof id !== 'string' || !GOOGLE_CALENDAR_EVENT_ID_RE.test(id)) return this.#refuse(operation);
    if (!isSendUpdates(sendUpdates) || !isPlainObject(p)) return this.#refuse(operation);
    if (Object.keys(p).some((key) => !PATCH_KEYS.has(key))) return this.#refuse(operation);
    const { startAt, endAt, attendeeEmail, description } = p;

    const body: Record<string, unknown> = {};
    if (startAt !== undefined || endAt !== undefined) {
      // Both or neither: a lone start or end could put the end before the start.
      if (!isTimeRange(startAt, endAt)) return this.#refuse(operation);
      body.start = timed(startAt as string);
      body.end = timed(endAt as string);
    }
    if (attendeeEmail !== undefined) {
      if (!isEmailAddress(attendeeEmail)) return this.#refuse(operation);
      // Google replaces the whole array: exactly one attendee, the on-file email, no name.
      body.attendees = [{ email: attendeeEmail }];
    }
    if (description !== undefined) {
      if (!isDescription(description)) return this.#refuse(operation);
      body.description = description;
    }
    if (Object.keys(body).length === 0) return this.#refuse(operation);

    return sendAuthorizedGoogleRequest(
      {
        operation,
        method: 'PATCH',
        url: `${GOOGLE_CALENDAR_EVENTS_URL}/${id}?conferenceDataVersion=1&sendUpdates=${sendUpdates}`,
        body: JSON.stringify(body),
      },
      this.#tokens,
      this.#send,
      { parse: (result) => parseEvent(operation, id, result) },
    );
  }

  async deleteEvent(id: string, sendUpdates: GoogleCalendarSendUpdates): Promise<'deleted' | 'gone'> {
    const operation: GoogleOperation = 'calendar.delete';
    if (typeof id !== 'string' || !GOOGLE_CALENDAR_EVENT_ID_RE.test(id)) return this.#refuse(operation);
    if (!isSendUpdates(sendUpdates)) return this.#refuse(operation);
    return sendAuthorizedGoogleRequest<'deleted' | 'gone'>(
      { operation, method: 'DELETE', url: `${GOOGLE_CALENDAR_EVENTS_URL}/${id}?sendUpdates=${sendUpdates}` },
      this.#tokens,
      this.#send,
      { parse: () => 'deleted', onNotFound: () => 'gone' },
    );
  }
}

/**
 * The Calendar client for Dex's primary calendar. Throws `GoogleError('invalid_request')`
 * synchronously, with zero network, when the token source or a seam is not usable.
 */
export function createGoogleCalendarClient(o: GoogleCalendarClientOptions): GoogleCalendarClient {
  return new GoogleCalendarHttpClient(o);
}
