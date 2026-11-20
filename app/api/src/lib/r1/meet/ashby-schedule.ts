/**
 * lib/r1/meet/ashby-schedule.ts — the Ashby interview-schedule parser and the Dex event selector
 * (M034 S01).
 *
 * Source of truth (D-M034-11): HR schedules the R1 interview IN ASHBY with the Ashby user
 * "Dex (AI Interviewer)" as an interviewer; Ashby creates the Google Meet and sends the webhooks
 * `interviewScheduleCreate` / `interviewScheduleUpdate`. Their `data.interviewSchedule` is parsed
 * here into a closed, PII-minimal shape, and `selectR1MeetDexEvents` decides, per interview event,
 * whether a Dex bot belongs in that call. There is no other booking source (no third-party booking
 * page, no Google Calendar sync, no Recall calendar integration).
 *
 * PII-minimal (R18 / R28): the result keeps ids, times, the schedule status and the CANONICAL
 * Google Meet URL only. Every name, the location, the feedback link, `extraData`, the interview
 * and interviewer-pool objects, interviewer emails and roles, and any meeting link that is not a
 * Google Meet link (it may carry a passcode) are dropped. The one exception is the scheduler's
 * email: it is attached as a NON-ENUMERABLE property (`scheduledByEmail`), so JSON, spread,
 * `Object.keys` and the fingerprint never see it. It exists only so the runtime (S06) can map the
 * Ashby scheduler to one of our staff users; read it by name, never log or store it.
 *
 * Ids (R24): every Ashby id kept must be a UUID (case-insensitive) and is kept VERBATIM (our Ashby
 * application links store the external id verbatim behind a case-sensitive unique). Only the Dex
 * membership test compares lower-cased. Times are strict ISO-8601 with `Z` or `+hh:mm` and are
 * returned as canonical `toISOString()` instants.
 *
 * Dex membership fails closed (PR #433 review F3): `dex_absent` is destructive, so it is only ever
 * decided from interviewer data that is present and readable. A missing or non-UUID Dex user id
 * refuses the parse (`invalid_dex_user_id`); an event with neither `interviewers` nor the deprecated
 * `interviewerUserIds` is `malformed_event`; and Dex counts as an interviewer when EITHER list names
 * him (an empty `interviewers` never hides him in the deprecated list).
 *
 * One bad event does not hide the rest (review F5): an event that breaks a per-event rule but whose
 * readable interviewer data proves Dex is NOT on it is skipped (counted in
 * `skippedNonDexEventCount`). Any other event-level refusal still refuses the whole schedule, but
 * the failure then carries the schedule's `identity` (id, status, updatedAt), so a cancellation
 * still reaches the runtime.
 *
 * Contracts handed to later slices:
 *  - S03 routes these two actions BEFORE the generic Ashby extractor (which finds no id in a
 *    schedule payload and would answer 400), using `parseR1MeetAshbyScheduleWebhook` and
 *    `r1MeetAshbyScheduleDedupKey(schedule, receivedAtMs)` (Ashby sends no delivery id for these
 *    actions) for receipts.
 *  - S06 acts on `selectR1MeetDexEvents` (precedence: `dex_absent`, `cancelled`, `in_past`,
 *    `not_scheduled`, `no_attester`, `no_meet_link`, `eligible`; review F2):
 *     - destructive for an existing booking, even with a bot in the call: `cancelled`, `dex_absent`,
 *       the event no longer in the schedule, and a REFUSED schedule whose `identity.status` is
 *       `Cancelled` (every booking of `identity.scheduleId`);
 *     - `in_past` (the slot has started, or the clock is unusable) holds, so a status flip to
 *       `WaitingOnFeedback` / `Complete`, or a dropped link, during or after the call never ends a
 *       live interview;
 *     - `not_scheduled`, `no_attester` and `no_meet_link` are only ever decided for a FUTURE slot:
 *       S06 unschedules a bot that has not been dispatched yet (keeping the booking, so a later
 *       update can re-arm it) and holds one already dispatched for the join window;
 *     - any other refused schedule holds (changes nothing);
 *     - S06 ignores a payload whose `latestUpdatedAt` is older than the booking's stored one
 *       (out-of-order delivery); when it is null S06 cannot tell, applies payloads in receipt order
 *       and compares each with the stored booking, so a re-processed duplicate is a no-op.
 *  - `R1_MEET_DEX_EVENT_DECISIONS` is the contract for the booking reason CHECK (S02).
 *
 * Pure: reads no environment, performs no I/O, reads no clock (the selector takes `nowMs`) and does
 * not log. It does not import the Ashby integration: the live Ashby path is untouched until S03.
 * Nothing here throws on any input.
 */
import { createHash } from 'node:crypto';
import { normalizeGoogleMeetUrl } from '../../../integrations/google-meet/url.js';

// ── Contract constants ──────────────────────────────────────────────────────

/** The Ashby webhook actions that carry an interview schedule. Frozen. */
export const R1_MEET_ASHBY_SCHEDULE_ACTIONS = Object.freeze([
  'interviewScheduleCreate',
  'interviewScheduleUpdate',
] as const);

export type R1MeetAshbyScheduleAction = (typeof R1_MEET_ASHBY_SCHEDULE_ACTIONS)[number];

export function isR1MeetAshbyScheduleAction(value: unknown): value is R1MeetAshbyScheduleAction {
  return typeof value === 'string' && (R1_MEET_ASHBY_SCHEDULE_ACTIONS as readonly string[]).includes(value);
}

/**
 * Ashby's `InterviewScheduleStatus` values (checked 2026-11-20), kept verbatim. Ashby's own
 * `Unknown`, and any other string, parse as `'unknown'`. Frozen.
 */
export const ASHBY_INTERVIEW_SCHEDULE_STATUSES = Object.freeze([
  'NeedsScheduling',
  'SchedulingRequested',
  'WaitingOnCandidateBooking',
  'WaitingOnCandidateAvailability',
  'CandidateAvailabilitySubmitted',
  'Scheduled',
  'WaitingOnFeedback',
  'Complete',
  'Cancelled',
  'OnHold',
] as const);

export type R1MeetAshbyScheduleStatus = (typeof ASHBY_INTERVIEW_SCHEDULE_STATUSES)[number] | 'unknown';

/** At most this many interview events per schedule. */
export const R1_MEET_ASHBY_MAX_EVENTS = 20;
/** At most this many interviewers per event. */
export const R1_MEET_ASHBY_MAX_INTERVIEWERS = 50;
/** An event longer than this is malformed. */
export const R1_MEET_ASHBY_MAX_EVENT_DURATION_MS = 24 * 3600 * 1000;

/**
 * The per-event decisions of `selectR1MeetDexEvents`, in precedence order (the first that applies
 * wins). `in_past` precedes the three decisions S06 may act on before the call (review F2), so those
 * are only ever decided for a future slot. The booking reason CHECK (M034 S02) must accept every
 * value. Frozen.
 */
export const R1_MEET_DEX_EVENT_DECISIONS = Object.freeze([
  'dex_absent',
  'cancelled',
  'in_past',
  'not_scheduled',
  'no_attester',
  'no_meet_link',
  'eligible',
] as const);

export type R1MeetDexEventDecision = (typeof R1_MEET_DEX_EVENT_DECISIONS)[number];

/** Why `parseR1MeetAshbySchedule` refused a schedule (closed set). Frozen. */
export const R1_MEET_ASHBY_SCHEDULE_PARSE_FAILURES = Object.freeze([
  'invalid_dex_user_id',
  'not_object',
  'malformed_schedule',
  'malformed_status',
  'malformed_scheduled_by',
  'malformed_events',
  'too_many_events',
  'malformed_event',
  'duplicate_event_id',
] as const);

export type R1MeetAshbyScheduleParseFailure = (typeof R1_MEET_ASHBY_SCHEDULE_PARSE_FAILURES)[number];

/** Why `parseR1MeetAshbyScheduleWebhook` refused a webhook body (closed set). */
export type R1MeetAshbyScheduleWebhookFailure =
  | 'not_object'
  | 'unsupported_action'
  | 'missing_schedule'
  | R1MeetAshbyScheduleParseFailure;

// ── Parsed shapes ───────────────────────────────────────────────────────────

/** `google_meet`: a Google Meet link (kept canonical); `other`: any other link (dropped); `none`. */
export type R1MeetAshbyMeetingLinkKind = 'google_meet' | 'other' | 'none';

export interface R1MeetAshbyScheduleEvent {
  readonly eventId: string;
  readonly interviewId: string;
  /** Canonical ISO instant. */
  readonly startTime: string;
  /** Canonical ISO instant, after `startTime`, at most 24 h later. */
  readonly endTime: string;
  readonly updatedAt: string | null;
  /** The canonical `https://meet.google.com/<code>`, or null when the event has no Meet link. */
  readonly meetUrl: string | null;
  readonly meetingLinkKind: R1MeetAshbyMeetingLinkKind;
  /** Verbatim Ashby user ids, de-duplicated case-insensitively and sorted. */
  readonly interviewerUserIds: readonly string[];
  /** The configured Dex Ashby user is one of this event's interviewers. */
  readonly dexIsInterviewer: boolean;
}

export interface R1MeetAshbySchedule {
  readonly scheduleId: string;
  readonly applicationId: string;
  readonly interviewStageId: string;
  /** `candidateId` (sent on update payloads), else null. */
  readonly ashbyCandidateId: string | null;
  readonly status: R1MeetAshbyScheduleStatus;
  /** The Ashby user who scheduled the interview (the consent attester), or null. */
  readonly scheduledByUserId: string | null;
  /**
   * NON-ENUMERABLE (R28): the scheduler's email, trimmed and lower-cased, or null. Only for mapping
   * the scheduler to one of our users. Absent from JSON, spread, `Object.keys` and the fingerprint.
   */
  readonly scheduledByEmail: string | null;
  readonly createdAt: string | null;
  readonly updatedAt: string | null;
  /** The latest of the schedule's and its events' `updatedAt`, or null. */
  readonly latestUpdatedAt: string | null;
  /** Sorted by `startTime`, then `eventId`. */
  readonly events: readonly R1MeetAshbyScheduleEvent[];
  /** Malformed events whose readable interviewer data proves Dex is not on them (review F5). */
  readonly skippedNonDexEventCount: number;
}

export interface R1MeetAshbyScheduleParseOptions {
  /**
   * The Ashby user id of "Dex (AI Interviewer)": a UUID. Null, or anything else, refuses the parse
   * (`invalid_dex_user_id`) rather than reading every event as Dex-absent (review F3).
   */
  readonly dexUserId: string | null;
}

/**
 * The schedule-level fields of a schedule refused for an EVENT-level reason (review F5), so the
 * runtime can still act on a cancellation. Absent when the schedule's own fields did not parse.
 */
export interface R1MeetAshbyScheduleIdentity {
  readonly scheduleId: string;
  readonly status: R1MeetAshbyScheduleStatus;
  readonly updatedAt: string | null;
}

export type R1MeetAshbyScheduleParseResult =
  | { readonly ok: true; readonly schedule: R1MeetAshbySchedule }
  | {
    readonly ok: false;
    readonly reason: R1MeetAshbyScheduleParseFailure;
    readonly identity?: R1MeetAshbyScheduleIdentity;
  };

export type R1MeetAshbyScheduleWebhookResult =
  | { readonly ok: true; readonly action: R1MeetAshbyScheduleAction; readonly schedule: R1MeetAshbySchedule }
  | {
    readonly ok: false;
    readonly reason: R1MeetAshbyScheduleWebhookFailure;
    readonly identity?: R1MeetAshbyScheduleIdentity;
  };

export interface R1MeetDexEventSelection {
  readonly eventId: string;
  readonly interviewId: string;
  readonly decision: R1MeetDexEventDecision;
  readonly startTime: string;
  readonly endTime: string;
  readonly meetUrl: string | null;
}

// ── Small validators ────────────────────────────────────────────────────────

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/** Strict ISO-8601 date-time with a `Z` or `+hh:mm` offset; seconds and fraction optional. */
const ISO_DATE_TIME_RE =
  /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2})(?::(\d{2})(?:\.(\d{1,9}))?)?(Z|([+-])(\d{2}):(\d{2}))$/;

/** What `toISOString()` gives for a four-digit-year instant. */
const CANONICAL_ISO_RE = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/;

const MAX_EMAIL_LENGTH = 254;
const EMAIL_FORBIDDEN_CHARS = /[\s\p{Cc}\p{Cf}\p{Cs}\p{Co}\p{Zl}\p{Zp}]/u;

const KNOWN_STATUSES: ReadonlySet<string> = new Set(ASHBY_INTERVIEW_SCHEDULE_STATUSES);

class ParseFailure {
  constructor(
    readonly reason: R1MeetAshbyScheduleParseFailure,
    readonly identity?: R1MeetAshbyScheduleIdentity,
  ) {}
}

function fail(reason: R1MeetAshbyScheduleParseFailure): never {
  throw new ParseFailure(reason);
}

function isUuid(value: unknown): value is string {
  return typeof value === 'string' && UUID_RE.test(value);
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return false;
  const proto = Object.getPrototypeOf(value) as unknown;
  return proto === Object.prototype || proto === null;
}

/**
 * The canonical `toISOString()` of a strict ISO-8601 date-time, or null. Every component is range
 * checked (no Feb 30, no hour 24, no offset beyond 23:59); a fraction beyond milliseconds is
 * truncated. Built from the components, not `Date.parse`, so engine leniency never widens it.
 */
function canonicalInstant(value: unknown): string | null {
  if (typeof value !== 'string') return null;
  const m = ISO_DATE_TIME_RE.exec(value);
  if (!m) return null;
  const year = Number(m[1]);
  const month = Number(m[2]);
  const day = Number(m[3]);
  const hour = Number(m[4]);
  const minute = Number(m[5]);
  const second = m[6] === undefined ? 0 : Number(m[6]);
  const millis = m[7] === undefined ? 0 : Number(m[7].slice(0, 3).padEnd(3, '0'));
  if (month < 1 || month > 12 || day < 1 || day > 31) return null;
  if (hour > 23 || minute > 59 || second > 59) return null;
  let offsetMinutes = 0;
  if (m[8] !== 'Z') {
    const offsetHours = Number(m[10]);
    const offsetMins = Number(m[11]);
    if (offsetHours > 23 || offsetMins > 59) return null;
    offsetMinutes = (m[9] === '-' ? -1 : 1) * (offsetHours * 60 + offsetMins);
  }
  // setUTCFullYear (not Date.UTC, which maps years 0..99 to 1900..1999), then reject a day that
  // rolled over into the next month.
  const date = new Date(0);
  date.setUTCFullYear(year, month - 1, day);
  if (date.getUTCFullYear() !== year || date.getUTCMonth() !== month - 1 || date.getUTCDate() !== day) {
    return null;
  }
  date.setUTCHours(hour, minute, second, millis);
  const ms = date.getTime() - offsetMinutes * 60_000;
  if (!Number.isFinite(ms)) return null;
  const iso = new Date(ms).toISOString();
  return CANONICAL_ISO_RE.test(iso) ? iso : null;
}

/** An optional instant: absent/null → null; a valid instant → canonical; anything else → failure. */
function optionalInstant(value: unknown, reason: R1MeetAshbyScheduleParseFailure): string | null {
  if (value === undefined || value === null) return null;
  return canonicalInstant(value) ?? fail(reason);
}

/** R28: trimmed, lower-cased, ≤ 254 chars, exactly one `@` with text on both sides, else null. */
function normalizeEmail(value: unknown): string | null {
  if (typeof value !== 'string') return null;
  const email = value.trim().toLowerCase();
  if (email.length === 0 || email.length > MAX_EMAIL_LENGTH) return null;
  if (EMAIL_FORBIDDEN_CHARS.test(email)) return null;
  const at = email.indexOf('@');
  if (at <= 0 || at !== email.lastIndexOf('@') || at === email.length - 1) return null;
  return email;
}

/** De-duplicate case-insensitively (the smallest spelling wins, so input order never matters), then sort. */
function canonicalIds(ids: readonly string[]): string[] {
  const byLower = new Map<string, string>();
  for (const id of ids) {
    const lower = id.toLowerCase();
    const seen = byLower.get(lower);
    if (seen === undefined || id < seen) byLower.set(lower, id);
  }
  return [...byLower.keys()].sort().map((lower) => byLower.get(lower)!);
}

function compareEvents(a: R1MeetAshbyScheduleEvent, b: R1MeetAshbyScheduleEvent): number {
  if (a.startTime !== b.startTime) return a.startTime < b.startTime ? -1 : 1;
  const left = a.eventId.toLowerCase();
  const right = b.eventId.toLowerCase();
  if (left !== right) return left < right ? -1 : 1;
  return a.eventId < b.eventId ? -1 : a.eventId > b.eventId ? 1 : 0;
}

function deepFreeze<T>(value: T): T {
  if (typeof value === 'object' && value !== null && !Object.isFrozen(value)) {
    for (const child of Object.values(value)) deepFreeze(child);
    Object.freeze(value);
  }
  return value;
}

// ── Parsing ─────────────────────────────────────────────────────────────────

function parseMeetingLink(value: unknown): { meetUrl: string | null; kind: R1MeetAshbyMeetingLinkKind } {
  if (value === undefined || value === null) return { meetUrl: null, kind: 'none' };
  if (typeof value !== 'string') fail('malformed_event');
  if (value.trim().length === 0) return { meetUrl: null, kind: 'none' };
  const meetUrl = normalizeGoogleMeetUrl(value);
  return meetUrl === null ? { meetUrl: null, kind: 'other' } : { meetUrl, kind: 'google_meet' };
}

/** A bounded array or a failure. */
function boundedArray(value: unknown, max: number): readonly unknown[] {
  if (!Array.isArray(value) || value.length > max) fail('malformed_event');
  return Array.from(value as readonly unknown[]);
}

/**
 * Interviewer ids: the UNION of `interviewers[].id` and the deprecated `interviewerUserIds`, each
 * read when present (review F3: an empty `interviewers` must not hide Dex named in the deprecated
 * list). Entries must be objects (resp. strings); entries without a UUID are skipped. With neither
 * list present Dex membership is unknown, which is `malformed_event`, never "Dex absent".
 */
function parseInterviewerIds(rawInterviewers: unknown, rawLegacyIds: unknown): string[] {
  const hasInterviewers = rawInterviewers !== undefined && rawInterviewers !== null;
  const hasLegacyIds = rawLegacyIds !== undefined && rawLegacyIds !== null;
  if (!hasInterviewers && !hasLegacyIds) fail('malformed_event');
  const ids: string[] = [];
  if (hasInterviewers) {
    for (const entry of boundedArray(rawInterviewers, R1_MEET_ASHBY_MAX_INTERVIEWERS)) {
      if (!isPlainObject(entry)) fail('malformed_event');
      const id = entry.id;
      if (isUuid(id)) ids.push(id);
    }
  }
  if (hasLegacyIds) {
    for (const entry of boundedArray(rawLegacyIds, R1_MEET_ASHBY_MAX_INTERVIEWERS)) {
      if (typeof entry !== 'string') fail('malformed_event');
      if (isUuid(entry)) ids.push(entry);
    }
  }
  return canonicalIds(ids);
}

function hasDex(interviewerUserIds: readonly string[], dexLower: string): boolean {
  return interviewerUserIds.some((id) => id.toLowerCase() === dexLower);
}

/**
 * True only when `raw` is an object whose interviewer data is present and readable and does not
 * name Dex (review F5). Unknown membership is false. A throwing getter propagates.
 */
function isProvablyNotDexEvent(raw: unknown, dexLower: string): boolean {
  if (!isPlainObject(raw)) return false;
  try {
    return !hasDex(parseInterviewerIds(raw.interviewers, raw.interviewerUserIds), dexLower);
  } catch (error) {
    if (error instanceof ParseFailure) return false;
    throw error;
  }
}

function parseEvent(raw: unknown, dexLower: string): R1MeetAshbyScheduleEvent {
  if (!isPlainObject(raw)) fail('malformed_event');
  const eventId = raw.id;
  const interviewId = raw.interviewId;
  if (!isUuid(eventId) || !isUuid(interviewId)) fail('malformed_event');
  const startTime = canonicalInstant(raw.startTime) ?? fail('malformed_event');
  const endTime = canonicalInstant(raw.endTime) ?? fail('malformed_event');
  const durationMs = Date.parse(endTime) - Date.parse(startTime);
  if (!(durationMs > 0) || durationMs > R1_MEET_ASHBY_MAX_EVENT_DURATION_MS) fail('malformed_event');
  const updatedAt = optionalInstant(raw.updatedAt, 'malformed_event');
  const link = parseMeetingLink(raw.meetingLink);
  const interviewerUserIds = parseInterviewerIds(raw.interviewers, raw.interviewerUserIds);
  const dexIsInterviewer = hasDex(interviewerUserIds, dexLower);
  return {
    eventId,
    interviewId,
    startTime,
    endTime,
    updatedAt,
    meetUrl: link.meetUrl,
    meetingLinkKind: link.kind,
    interviewerUserIds,
    dexIsInterviewer,
  };
}

function parseStatus(value: unknown): R1MeetAshbyScheduleStatus {
  if (typeof value !== 'string') fail('malformed_status');
  return KNOWN_STATUSES.has(value) ? (value as R1MeetAshbyScheduleStatus) : 'unknown';
}

function parseScheduledBy(value: unknown): { userId: string | null; email: string | null } {
  if (value === undefined || value === null) return { userId: null, email: null };
  if (!isPlainObject(value)) fail('malformed_scheduled_by');
  const userId = value.id;
  if (!isUuid(userId)) fail('malformed_scheduled_by');
  return { userId, email: normalizeEmail(value.email) };
}

function latestOf(instants: ReadonlyArray<string | null>): string | null {
  let latest: string | null = null;
  for (const instant of instants) {
    if (instant !== null && (latest === null || instant > latest)) latest = instant;
  }
  return latest;
}

/** The lower-cased Dex user id, or `invalid_dex_user_id` (review F3: never "Dex matches no one"). */
function dexLowerOf(options: unknown): string {
  const dexUserId = isPlainObject(options) ? options.dexUserId : undefined;
  if (!isUuid(dexUserId)) fail('invalid_dex_user_id');
  return dexUserId.toLowerCase();
}

/** The events (sorted), and how many provably non-Dex malformed events were skipped (review F5). */
function parseEvents(rawEvents: unknown, dexLower: string): { events: R1MeetAshbyScheduleEvent[]; skipped: number } {
  if (rawEvents === undefined || rawEvents === null) return { events: [], skipped: 0 };
  if (!Array.isArray(rawEvents)) fail('malformed_events');
  const list = Array.from(rawEvents as readonly unknown[]);
  if (list.length > R1_MEET_ASHBY_MAX_EVENTS) fail('too_many_events');
  const events: R1MeetAshbyScheduleEvent[] = [];
  const seen = new Set<string>();
  let skipped = 0;
  for (const entry of list) {
    let event: R1MeetAshbyScheduleEvent;
    try {
      event = parseEvent(entry, dexLower);
    } catch (error) {
      if (error instanceof ParseFailure && isProvablyNotDexEvent(entry, dexLower)) {
        skipped += 1;
        continue;
      }
      throw error;
    }
    const key = event.eventId.toLowerCase();
    if (seen.has(key)) fail('duplicate_event_id');
    seen.add(key);
    events.push(event);
  }
  return { events: events.sort(compareEvents), skipped };
}

function buildSchedule(raw: unknown, options: unknown): R1MeetAshbySchedule {
  const dexLower = dexLowerOf(options);
  if (!isPlainObject(raw)) fail('not_object');

  const scheduleId = raw.id;
  const applicationId = raw.applicationId;
  const interviewStageId = raw.interviewStageId;
  if (!isUuid(scheduleId) || !isUuid(applicationId) || !isUuid(interviewStageId)) fail('malformed_schedule');

  const rawCandidateId = raw.candidateId;
  let ashbyCandidateId: string | null = null;
  if (rawCandidateId !== undefined && rawCandidateId !== null) {
    if (!isUuid(rawCandidateId)) fail('malformed_schedule');
    ashbyCandidateId = rawCandidateId;
  }

  const status = parseStatus(raw.status);
  const scheduledBy = parseScheduledBy(raw.scheduledBy);
  const createdAt = optionalInstant(raw.createdAt, 'malformed_schedule');
  const updatedAt = optionalInstant(raw.updatedAt, 'malformed_schedule');

  let parsedEvents: { events: R1MeetAshbyScheduleEvent[]; skipped: number };
  try {
    parsedEvents = parseEvents(raw.interviewEvents, dexLower);
  } catch (error) {
    // Review F5: an event-level refusal still tells the runtime which schedule it was and its status.
    if (error instanceof ParseFailure) throw new ParseFailure(error.reason, { scheduleId, status, updatedAt });
    throw error;
  }
  const { events, skipped } = parsedEvents;

  // The email is added below as a non-enumerable property (R28), so it is not in this literal.
  const schedule: Omit<R1MeetAshbySchedule, 'scheduledByEmail'> = {
    scheduleId,
    applicationId,
    interviewStageId,
    ashbyCandidateId,
    status,
    scheduledByUserId: scheduledBy.userId,
    createdAt,
    updatedAt,
    latestUpdatedAt: latestOf([updatedAt, ...events.map((event) => event.updatedAt)]),
    events,
    skippedNonDexEventCount: skipped,
  };
  Object.defineProperty(schedule, 'scheduledByEmail', {
    value: scheduledBy.email,
    enumerable: false,
    writable: false,
    configurable: false,
  });
  return deepFreeze(schedule as R1MeetAshbySchedule);
}

/**
 * Parse an Ashby `interviewSchedule` object (the `data.interviewSchedule` of the two webhook
 * actions). Unknown fields are ignored; the result is deep-frozen. Never throws: any failure,
 * including a throwing getter, is a closed reason. A refusal for an event-level reason carries the
 * schedule's `identity` (review F5); every other refusal is exactly `{ ok: false, reason }`.
 */
export function parseR1MeetAshbySchedule(
  raw: unknown,
  options: R1MeetAshbyScheduleParseOptions,
): R1MeetAshbyScheduleParseResult {
  try {
    return Object.freeze({ ok: true as const, schedule: buildSchedule(raw, options) });
  } catch (error) {
    if (!(error instanceof ParseFailure)) return Object.freeze({ ok: false as const, reason: 'malformed_schedule' as const });
    if (error.identity === undefined) return Object.freeze({ ok: false as const, reason: error.reason });
    return deepFreeze({ ok: false as const, reason: error.reason, identity: { ...error.identity } });
  }
}

/**
 * Parse an Ashby webhook body `{ action, data: { interviewSchedule } }` for the two schedule
 * actions. Any other action (including `ping`) is `unsupported_action`. Never throws.
 */
export function parseR1MeetAshbyScheduleWebhook(
  body: unknown,
  options: R1MeetAshbyScheduleParseOptions,
): R1MeetAshbyScheduleWebhookResult {
  try {
    if (!isPlainObject(body)) return Object.freeze({ ok: false as const, reason: 'not_object' as const });
    const action = body.action;
    if (!isR1MeetAshbyScheduleAction(action)) {
      return Object.freeze({ ok: false as const, reason: 'unsupported_action' as const });
    }
    const data = body.data;
    const raw = isPlainObject(data) ? data.interviewSchedule : undefined;
    if (!isPlainObject(raw)) return Object.freeze({ ok: false as const, reason: 'missing_schedule' as const });
    const parsed = parseR1MeetAshbySchedule(raw, options);
    if (!parsed.ok) return parsed;
    return Object.freeze({ ok: true as const, action, schedule: parsed.schedule });
  } catch {
    return Object.freeze({ ok: false as const, reason: 'malformed_schedule' as const });
  }
}

// ── Fingerprint and dedupe key (R27) ────────────────────────────────────────

/** The enumerable projection in a fixed key order, events and interviewer ids re-canonicalised. */
function fingerprintProjection(schedule: R1MeetAshbySchedule): unknown {
  const events = [...schedule.events].sort(compareEvents).map((event) => ({
    eventId: event.eventId,
    interviewId: event.interviewId,
    startTime: event.startTime,
    endTime: event.endTime,
    updatedAt: event.updatedAt,
    meetUrl: event.meetUrl,
    meetingLinkKind: event.meetingLinkKind,
    interviewerUserIds: canonicalIds(event.interviewerUserIds),
    dexIsInterviewer: event.dexIsInterviewer,
  }));
  return {
    scheduleId: schedule.scheduleId,
    applicationId: schedule.applicationId,
    interviewStageId: schedule.interviewStageId,
    ashbyCandidateId: schedule.ashbyCandidateId,
    status: schedule.status,
    scheduledByUserId: schedule.scheduledByUserId,
    createdAt: schedule.createdAt,
    updatedAt: schedule.updatedAt,
    latestUpdatedAt: schedule.latestUpdatedAt,
    events,
    skippedNonDexEventCount: schedule.skippedNonDexEventCount,
  };
}

/**
 * SHA-256 hex of the canonical JSON of the parsed schedule's enumerable projection. The scheduler's
 * email never contributes; key order, event order and unknown input fields do not matter.
 */
export function r1MeetAshbyScheduleFingerprint(schedule: R1MeetAshbySchedule): string {
  return createHash('sha256').update(JSON.stringify(fingerprintProjection(schedule)), 'utf8').digest('hex');
}

/** Largest epoch ms a `Date` can hold. */
const MAX_EPOCH_MS = 8.64e15;

/**
 * The receipt dedupe id for an Ashby schedule webhook (Ashby sends no delivery id for these
 * actions), at most 256 characters of `[A-Za-z0-9_.:-]`:
 *  - `ashby-schedule:<scheduleId>:<latestUpdatedAt epoch ms>:<16 hex of the fingerprint>` while the
 *    payload carries an `updatedAt`. Identical retries converge, and a change that is later reverted
 *    (A→B→A) stays distinct because Ashby bumps `updatedAt`. `receivedAtMs` is ignored.
 *  - `ashby-schedule:<scheduleId>:r<receivedAtMs>:<16 hex>` when nothing carries `updatedAt`
 *    (review F4). Without a stamp A→B→A would collapse onto the first A's key and the revert would
 *    be dropped as a duplicate, so the receipt time (S03's clock, epoch ms, truncated) keeps every
 *    delivery distinct. The price: Ashby's own retries of such a delivery are processed again,
 *    which is harmless because S06 compares each payload with the stored booking. A receipt time
 *    that is not a finite epoch ms in range becomes `r0`.
 */
export function r1MeetAshbyScheduleDedupKey(schedule: R1MeetAshbySchedule, receivedAtMs: number): string {
  const latestMs = schedule.latestUpdatedAt === null ? Number.NaN : Date.parse(schedule.latestUpdatedAt);
  let stamp: string;
  if (Number.isFinite(latestMs)) {
    stamp = String(latestMs);
  } else {
    const received =
      typeof receivedAtMs === 'number' && Number.isFinite(receivedAtMs) && receivedAtMs >= 0 && receivedAtMs <= MAX_EPOCH_MS
        ? Math.trunc(receivedAtMs)
        : 0;
    stamp = `r${received}`;
  }
  const fingerprint = r1MeetAshbyScheduleFingerprint(schedule).slice(0, 16);
  return `ashby-schedule:${schedule.scheduleId}:${stamp}:${fingerprint}`;
}

// ── Dex event selector (R26) ────────────────────────────────────────────────

function decide(
  schedule: R1MeetAshbySchedule,
  event: R1MeetAshbyScheduleEvent,
  nowMs: number,
): R1MeetDexEventDecision {
  if (event.dexIsInterviewer !== true) return 'dex_absent';
  if (schedule.status === 'Cancelled') return 'cancelled';
  // Review F2: decided before the status, attester and link checks, so those three are only ever
  // reported for a future slot (S06 may unschedule an undispatched bot) and a change during or
  // after the call holds.
  const startMs = Date.parse(event.startTime);
  if (typeof nowMs !== 'number' || !Number.isFinite(nowMs) || !Number.isFinite(startMs) || startMs <= nowMs) {
    return 'in_past';
  }
  if (schedule.status !== 'Scheduled') return 'not_scheduled';
  if (typeof schedule.scheduledByUserId !== 'string') return 'no_attester';
  if (event.meetingLinkKind !== 'google_meet' || typeof event.meetUrl !== 'string') return 'no_meet_link';
  return 'eligible';
}

/**
 * One decision per event of `schedule` (same order as `schedule.events`); the first decision of
 * `R1_MEET_DEX_EVENT_DECISIONS` that applies wins. A non-finite `nowMs` makes every Dex event that
 * is not cancelled `in_past` (hold). Frozen; never throws (an unreadable schedule yields an empty
 * list).
 */
export function selectR1MeetDexEvents(
  schedule: R1MeetAshbySchedule,
  nowMs: number,
): readonly R1MeetDexEventSelection[] {
  try {
    const selections = Array.from(schedule.events).map((event) =>
      Object.freeze({
        eventId: event.eventId,
        interviewId: event.interviewId,
        decision: decide(schedule, event, nowMs),
        startTime: event.startTime,
        endTime: event.endTime,
        meetUrl: event.meetUrl,
      }),
    );
    return Object.freeze(selections);
  } catch {
    return Object.freeze([]);
  }
}

/** Only the `eligible` selections, in order. Frozen. */
export function r1MeetEligibleDexEvents(
  selections: readonly R1MeetDexEventSelection[],
): readonly R1MeetDexEventSelection[] {
  return Object.freeze(selections.filter((selection) => selection.decision === 'eligible'));
}
