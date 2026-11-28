/**
 * The `calendar_sync` job of the `r1-meet` runtime (M035 S05, dark; D-S05-1..12): keep Lexy's Google
 * Calendar event of one PUBLIC-PAGE booking in step with the booking. The event itself is created by
 * the public booking page (S06) with no attendee; this job adds the candidate (the invite), moves the
 * event, cancels it before its slot, and purges it after retention or a delete.
 *
 * WHO QUEUES IT. Migration 0143 only, never the TypeScript flows: the public create RPC (`invite`),
 * the public move RPC (`move`), the terminal trigger (`cancel`, whenever a public booking first ends
 * cancelled, failed or drained while its event exists) and the delete trigger (`purge`); the public
 * maintenance steps re-drive the same payloads (`r1MeetJobs.calendarSync`). Payload: the op and the
 * booking id, nothing else. An Ashby-scheduled booking never gets one (the triggers' WHEN clauses);
 * a job that names one is `ignored('ashby_booking')` after the one booking read.
 *
 * THE INVITE (D-S05-2), every step re-read on a re-run, so a re-run after success makes ONE read of
 * the event and no write (one Google write per state change):
 *   1  unwired               `deps.calendar` absent: throw `r1_meet_calendar_unwired` (a build bug).
 *   2  booking_gone | ashby_booking | booking_not_live (only `pending`, `blocked` and `bot_scheduled`:
 *      a dispatched or ended booking is never invited) | calendar_<state> (the event is already
 *      cancelled or purged): ignored, nothing else read.
 *   3  Google: `deps.calendar.google()` null (no usable Google settings for Lexy): the setup alert
 *      `google_unconfigured`, defer `google_unconfigured` 3600 s.
 *   4  the event (one GET). Gone (404/410, or `cancelled` on Lexy's calendar: someone deleted it,
 *      D-S05-5): the live booking -> `failed/invite_undeliverable` (alert `event_gone`, a held bot
 *      queued for release), `processed('event_gone')`. The terminal trigger then queues the cancel.
 *   5  it already lists an attendee: the invite was applied (a lost answer, or a crash before step 11;
 *      this job is the only writer of attendees). `created` -> `invited` only (`invite_confirmed`), or
 *      `ignored('already_invited')`: no token, no Ashby read, no write to Google.
 *   6  the deadline: 15 minutes before the slot with no attendee -> `failed/invite_undeliverable`
 *      (`invite_deadline`), `processed('invite_undeliverable')`, no write to Google.
 *   7  the manage key (the worker secret): absent or short -> the setup alert `manage_key_missing`,
 *      defer `manage_key_missing` 3600 s. Never a send without a stored digest.
 *   8  the interviewer's name: the booking's objective profile (`botDisplayName`); an unknown profile
 *      alerts `r1_meet_profile_unknown` and throws `r1_meet_calendar_profile_unknown`.
 *   9  the on-file email (D-S05-3), never a typed value: the Ashby candidate id from the application
 *      link, else from `application.info`; then `candidate.info` and `resolveR1PublicOnFileEmail` with
 *      `candidates.email` as the fallback. An answer with no candidate id, or no usable primary
 *      address, uses `candidates.email`. Ashby unreachable (any failure, or no usable key): before
 *      30 minutes ahead of the slot defer `ashby_unavailable` 120 s; from then on `candidates.email`
 *      alone, with the alert `r1_meet_public_ashby_unavailable` (`invite_fallback`). No address at all:
 *      `failed/invite_undeliverable` (`no_email`), `processed('invite_undeliverable')`.
 *  10  a fresh manage token (32 random bytes) and the description with its link are built in memory,
 *      then ONLY its digest is stored (`r1_meet_public_set_manage_digest`; `booking_terminal` or
 *      `booking_gone` ends the job ignored, with no send), BEFORE the send.
 *  11  the send: the event gets exactly the on-file attendee and the description, `sendUpdates=all`
 *      (Google mails the invite from Lexy's calendar). A 404/410 is step 4's `event_gone`.
 *  12  `created|invited -> invited` (`invite_sent_at` set once by the RPC): `processed('invited')`, or
 *      `invited_state_conflict` / `invited_booking_gone` when the row moved meanwhile (as for step 5).
 *  13  calendar mode only (D-S05-12): the event's Meet link must still be the booking's; a different
 *      or missing one alerts `r1_meet_public_meet_link_changed` (`invite`) and changes nothing else.
 *
 * THE MOVE (D-S05-4), always converging on the CURRENT booking row (a late `move:1` job after a
 * second move sends the newest slot, and the `move:2` job then finds it done):
 *   booking_gone | ashby_booking | booking_terminal | slot_over (the slot has ended) | calendar_<state>
 *   (the event is cancelled or purged): ignored, no Google call. No Google settings: as the invite.
 *   One GET. Gone: as the invite's step 4 for an undispatched booking (`failed/invite_undeliverable`,
 *   alert `event_gone`); a dispatched one is never cut, the job just ends `processed('event_gone')`.
 *   The event already has the booking's start and end (compared in milliseconds): `already_moved`,
 *   no token and no write. Else the manage key and the name as the invite, a fresh token whose digest
 *   is stored first, then ONE send of the new start, end and description (with the new link),
 *   `sendUpdates=all`, and NEVER the attendees (Google keeps them). Then the calendar-mode Meet link
 *   check (`move`) and `processed('moved')`. Both ends repair a `created` state to `invited` when the
 *   event lists an attendee (an invite whose answer was lost).
 *
 * THE CANCEL (D-S05-6), shared with the drain (`cancelR1MeetPublicCalendarEvent`): only a TERMINAL
 * public booking whose event still exists (`created` or `invited`) and whose slot has not started.
 * A live booking's event is never deleted (`booking_live`); after the start there is no Google call
 * (`after_start`: the retention purge removes the event later). The delete sends `sendUpdates=all`
 * for `created` AND `invited` (a deliberate deviation from contracts section 5, recorded in section
 * 9: with no attendee Google mails nobody, and an attendee whose invite answer was lost still hears
 * of the cancel), then `created|invited -> cancelled`. A 404/410 counts as deleted (`cancelled_gone`).
 *
 * THE PURGE (D-S05-7): the event id is derived from the job's booking id (the row may be gone after a
 * delete). A row that is still there: Ashby, live or already `purged` is ignored; a terminal one whose
 * slot is still ahead is deleted with `sendUpdates=all` (the candidate hears of it), anything else
 * with `none`; then `created|invited|cancelled -> purged`. No row: one delete with `none` and no
 * database write (a re-run repeats it, answered 404/410: nothing is left to remember it).
 *
 * GOOGLE FAILURES (D-S05-8), one alert per run at most: `quota`, `unavailable`, `timeout` and
 * `malformed_response` defer `google_quota` / `google_unavailable` for the hint (5..300 s, 30 s with
 * none); `auth_revoked` (Lexy's refresh token died) alerts `r1_meet_public_google_auth_failed` (the
 * Google call) and defers `google_auth_revoked` 3600 s; `setup_forbidden` and `unauthorized` alert
 * `r1_meet_public_setup_error` and defer `google_setup` 3600 s; every deferral stays within
 * `canDeferR1MeetJob`, past it the closed code `r1_meet_calendar_google_<code>` is thrown (attempts,
 * then the dead-letter queue). `invalid_request` and `already_exists` throw
 * `r1_meet_calendar_google_invalid_request`. The token source answers a dead grant from its 60 s
 * refusal window without a request, so nothing here loops.
 *
 * LOGS AND PII (contracts section 8). Closed words, a Google operation and an HTTP status only. The
 * manage token lives in memory and in the event description only: never logged, stored, queued or put
 * in an error. The on-file email lives in memory and in the event's attendee only. Alerts are `error`
 * lines.
 *
 * Loading this module performs no I/O: every port arrives in `R1MeetFlowDeps.calendar`.
 */

import type { AshbyClient } from '../../../integrations/ashby/client.js';
import { extractApplicationInfo } from '../../../integrations/ashby/extractors.js';
import type {
  GoogleCalendarClient,
  GoogleCalendarEvent,
  GoogleCalendarSendUpdates,
} from '../../../integrations/google/calendar.js';
import { isGoogleError, type GoogleOperation } from '../../../integrations/google/errors.js';
import type { GoogleClientLogger } from '../../../integrations/google/http.js';
import { normalizeGoogleMeetUrl } from '../../../integrations/google-meet/url.js';
import type { R1MeetBookingStatus } from './bookings-read.js';
import type { R1MeetPublicConfig } from './config.js';
import {
  R1MeetJobError,
  R1_MEET_MALFORMED_PAYLOAD,
  R1_MEET_RPC_UNEXPECTED,
  canDeferR1MeetJob,
  parseCalendarSyncJob,
  r1MeetDefer,
  r1MeetIgnored,
  r1MeetJobs,
  r1MeetProcessed,
  type R1MeetCalendarSyncJob,
  type R1MeetJobMeta,
  type R1MeetJobResult,
} from './jobs.js';
import { getR1MeetProfile } from './profiles.js';
import type {
  R1MeetCalendarBooking,
  R1MeetCalendarState,
  R1MeetCalendarStore,
  R1MeetSetCalendarStateAnswer,
} from './public/calendar-store.js';
import { buildR1MeetPublicInviteDescription } from './public/invite-copy.js';
import { R1_MEET_MANAGE_DOMAIN, mintR1MeetManageToken, r1MeetPublicManageLink } from './public/manage-token.js';
import { resolveR1PublicOnFileEmail } from './public/match.js';
import {
  R1_MEET_ALERTS,
  type R1MeetFlowDeps,
  type R1MeetJobDefinition,
  type R1MeetLog,
  type R1MeetLogMeta,
} from './recall-actions.js';
import { R1_MEET_TERMINAL_STATUSES } from './runtime-store.js';
import { r1MeetDerivedKey } from './ticket.js';

// ── Vocabulary ──────────────────────────────────────────────────────────────

/** The alerts of Lexy's calendar (error lines). Not part of `R1_MEET_ALERTS`, which S06/S11 own. Frozen. */
export const R1_MEET_PUBLIC_CALENDAR_ALERTS = Object.freeze({
  /** `error_type`: `no_email` | `event_gone` | `invite_deadline`. */
  inviteUndeliverable: 'r1_meet_public_invite_undeliverable',
  /** `error_type`: `queued_<n>` | `drain:<code>`. */
  calendarDrift: 'r1_meet_public_calendar_drift',
  /** `error_type`: `invite` | `move`. */
  meetLinkChanged: 'r1_meet_public_meet_link_changed',
  /** `error_type`: the Google call (`calendar.get`, `calendar.patch`, `calendar.delete`). */
  googleAuthFailed: 'r1_meet_public_google_auth_failed',
  /** `error_type`: `google_setup_forbidden` | `google_unauthorized` | `google_unconfigured` | `manage_key_missing`. */
  setupError: 'r1_meet_public_setup_error',
  /** `error_type`: `invite_fallback`. */
  ashbyUnavailable: 'r1_meet_public_ashby_unavailable',
} as const);

const MINUTE_MS = 60_000;

/** The bounds of the job. Frozen. */
export const R1_MEET_CALENDAR_SYNC = Object.freeze({
  /** No attendee this close to the slot: the invite is undeliverable. */
  inviteDeadlineMs: 15 * MINUTE_MS,
  /** From this close to the slot an unreachable Ashby no longer delays the invite. */
  ashbyFallbackMs: 30 * MINUTE_MS,
  ashbyDeferSec: 120,
  googleDeferDefaultSec: 30,
  googleDeferMinSec: 5,
  googleDeferMaxSec: 300,
  /** An operator must act (a dead grant, a refused setup, a missing setting): wait an hour. */
  setupDeferSec: 3600,
});

/** What a `calendar_sync` job throws when the runtime built no calendar ports (a build bug). */
export const R1_MEET_CALENDAR_UNWIRED = 'r1_meet_calendar_unwired';

/** Lexy's calendar as one job sees it: the three event calls and the Meet mode they were built for. */
export interface R1MeetCalendarGoogle {
  readonly calendar: Pick<GoogleCalendarClient, 'getEvent' | 'patchEvent' | 'deleteEvent'>;
  readonly meetMode: 'calendar' | 'space';
}

/** The two Ashby reads of the on-file email. This job never writes to Ashby. */
export type R1MeetCalendarAshby = Pick<AshbyClient, 'candidateInfo' | 'applicationInfo'>;

/** The ports of the calendar job (`R1MeetFlowDeps.calendar`). Production builds them in `runtime.ts`. */
export interface R1MeetCalendarDeps {
  readonly store: R1MeetCalendarStore;
  /** Asked per job (D-S05-1): the public settings when `on`, else the drain's; null without either. */
  readonly google: () => R1MeetCalendarGoogle | null;
  /** Asked per job: the Ashby read port, or null when no usable Ashby key is configured. */
  readonly ashby: () => R1MeetCalendarAshby | null;
  /** `getR1MeetPublicConfig()`, asked per call (the maintenance knobs). */
  readonly publicConfig: () => R1MeetPublicConfig;
}

/** The live statuses no bot is dispatched in yet: the only ones an invite is sent for. */
const UNDISPATCHED_LIVE: ReadonlySet<R1MeetBookingStatus> = new Set<R1MeetBookingStatus>(['pending', 'blocked', 'bot_scheduled']);
/** The calendar states in which the event still exists on Lexy's calendar. */
const EVENT_EXISTS: readonly R1MeetCalendarState[] = Object.freeze(['created', 'invited']);
/** The ends of a booking: its event is never moved, and only these have their event cancelled. */
const TERMINAL: ReadonlySet<R1MeetBookingStatus> = new Set<R1MeetBookingStatus>(R1_MEET_TERMINAL_STATUSES);
/** The calendar states a purge may leave (`v_allowed` of `r1_meet_public_set_calendar_state`, 0143). */
const PURGEABLE: readonly R1MeetCalendarState[] = Object.freeze(['created', 'invited', 'cancelled']);

const ASHBY_UNAVAILABLE = 'r1_meet_calendar_ashby_unavailable';
const MANAGE_KEY_MISSING = 'r1_meet_calendar_manage_key_missing';
const PROFILE_UNKNOWN = 'r1_meet_calendar_profile_unknown';
const COPY_INVALID = 'r1_meet_calendar_copy_invalid';
const MINT_FAILED = 'r1_meet_calendar_mint_failed';
const GOOGLE_UNCONFIGURED = 'r1_meet_calendar_google_unconfigured';

/** The calendar calls this job makes (the auth alert names the one that failed). */
type R1MeetCalendarCall = Extract<GoogleOperation, 'calendar.get' | 'calendar.patch' | 'calendar.delete'>;

const toIso = (ms: number): string => new Date(ms).toISOString();

/** Lexy's event of a booking: its id without dashes, lower-case (the 0143 CHECK). */
export function r1MeetCalendarEventId(bookingId: string): string {
  return bookingId.toLowerCase().replace(/-/g, '');
}

// ── The shared core ─────────────────────────────────────────────────────────

/** The calendar ports, or the closed code of a build that wired none. */
function requireCalendar(deps: R1MeetFlowDeps): R1MeetCalendarDeps {
  const calendar = deps.calendar;
  if (calendar === undefined || calendar === null) throw new R1MeetJobError(R1_MEET_CALENDAR_UNWIRED);
  return calendar;
}

function alert(log: R1MeetLog, category: string, errorType: string, httpStatus: number | null = null): void {
  const meta: R1MeetLogMeta =
    typeof httpStatus === 'number' ? { error_category: category, error_type: errorType, http_status: httpStatus } : { error_category: category, error_type: errorType };
  log.error(meta);
}

/** A wait within the job's deferral bound; past it, the closed code is thrown (attempts, then the DLQ). */
function deferOrThrow(
  meta: Pick<R1MeetJobMeta, 'deferCount' | 'deferredAt'>,
  nowMs: number,
  code: string,
  seconds: number,
  thrown: string,
): R1MeetJobResult {
  if (!canDeferR1MeetJob(meta, nowMs)) throw new R1MeetJobError(thrown);
  return r1MeetDefer(code, seconds);
}

/** Google's own hint in whole seconds, clamped to 5..300; 30 when it gave none. */
function hintedDelaySeconds(retryAfterMs: number | null): number {
  const bounds = R1_MEET_CALENDAR_SYNC;
  if (retryAfterMs === null || !Number.isFinite(retryAfterMs)) return bounds.googleDeferDefaultSec;
  return Math.min(bounds.googleDeferMaxSec, Math.max(bounds.googleDeferMinSec, Math.ceil(retryAfterMs / 1000)));
}

interface GoogleFailureContext {
  readonly meta: Pick<R1MeetJobMeta, 'deferCount' | 'deferredAt'>;
  readonly nowMs: number;
  readonly log: R1MeetLog;
  /** The calendar call that failed: the auth alert's `error_type`. */
  readonly call: R1MeetCalendarCall;
}

/**
 * The job outcome of a Google failure (D-S05-8; shaped like `r1MeetRecallFailure`): a deferral within
 * the bound, or a throw of one closed code. Anything that is not a `GoogleError` (a database failure,
 * a bug) is rethrown unchanged. A 404/410 is the caller's to read first (an event that is gone).
 */
function googleFailure(error: unknown, context: GoogleFailureContext): R1MeetJobResult {
  if (!isGoogleError(error)) throw error;
  const thrown = `r1_meet_calendar_google_${error.code}`;
  const wait = (code: string, seconds: number): R1MeetJobResult => deferOrThrow(context.meta, context.nowMs, code, seconds, thrown);
  switch (error.code) {
    case 'quota':
      return wait('google_quota', hintedDelaySeconds(error.retryAfterMs));
    case 'unavailable':
    case 'timeout':
    case 'malformed_response':
      return wait('google_unavailable', hintedDelaySeconds(error.retryAfterMs));
    case 'auth_revoked':
      // Lexy's refresh token (or the delegation) is dead: an operator must re-grant it.
      alert(context.log, R1_MEET_PUBLIC_CALENDAR_ALERTS.googleAuthFailed, context.call, error.httpStatus);
      return wait('google_auth_revoked', R1_MEET_CALENDAR_SYNC.setupDeferSec);
    case 'setup_forbidden':
    case 'unauthorized':
      alert(context.log, R1_MEET_PUBLIC_CALENDAR_ALERTS.setupError, `google_${error.code}`, error.httpStatus);
      return wait('google_setup', R1_MEET_CALENDAR_SYNC.setupDeferSec);
    case 'invalid_request':
    case 'already_exists':
      // A request this job should never build: bounded attempts, then the dead-letter queue.
      throw new R1MeetJobError('r1_meet_calendar_google_invalid_request');
    default:
      throw new R1MeetJobError(thrown);
  }
}

/** Lexy's Google settings are missing or unusable: the setup alert, then an hour's wait. */
function googleUnconfigured(deps: R1MeetFlowDeps, meta: R1MeetJobMeta): R1MeetJobResult {
  alert(deps.log, R1_MEET_PUBLIC_CALENDAR_ALERTS.setupError, 'google_unconfigured');
  return deferOrThrow(meta, deps.now(), 'google_unconfigured', R1_MEET_CALENDAR_SYNC.setupDeferSec, GOOGLE_UNCONFIGURED);
}

/** `deps.calendar.google()`; a throw counts as no settings. */
function googleOf(calendar: R1MeetCalendarDeps): R1MeetCalendarGoogle | null {
  try {
    return calendar.google() ?? null;
  } catch {
    return null;
  }
}

/** `deps.calendar.ashby()`; a throw counts as no usable key. */
function ashbyOf(calendar: R1MeetCalendarDeps): R1MeetCalendarAshby | null {
  try {
    return calendar.ashby() ?? null;
  } catch {
    return null;
  }
}

/** The event is gone from Lexy's calendar: not found, or cancelled there. */
function eventGone(event: GoogleCalendarEvent | null): boolean {
  return event === null || event.status === 'cancelled';
}

/**
 * A live, undispatched public booking whose invite cannot be delivered (no on-file email, its event
 * gone, or the deadline passed with no attendee) -> `failed/invite_undeliverable`, one alert, and a
 * held bot queued for release (the `maintenance.ts` overdue pattern). The terminal trigger (0143) then
 * queues the calendar cancel and the Ashby tag removal. Answers false when the booking moved meanwhile
 * (`status_conflict`) or is gone: nothing was written then.
 */
export async function failR1MeetPublicInvite(
  deps: Pick<R1MeetFlowDeps, 'store' | 'enqueue' | 'now' | 'log'>,
  booking: Pick<R1MeetCalendarBooking, 'id' | 'status'>,
  why: 'no_email' | 'event_gone' | 'invite_deadline',
): Promise<boolean> {
  const answer = await deps.store.transition({
    bookingId: booking.id,
    from: booking.status,
    to: 'failed',
    reason: 'invite_undeliverable',
    nowIso: toIso(deps.now()),
  });
  if (answer.status === 'status_conflict' || answer.status === 'not_found') return false;
  if (answer.status !== 'ok') throw new R1MeetJobError(R1_MEET_RPC_UNEXPECTED);
  // The move is made: alert before anything else can fail (maintenance re-drives an owed release).
  alert(deps.log, R1_MEET_PUBLIC_CALENDAR_ALERTS.inviteUndeliverable, why);
  if (answer.recallBotId !== null) await deps.enqueue(r1MeetJobs.botRelease(answer.recallBotId, booking.id));
  return true;
}

function asObject(value: unknown): Record<string, unknown> | null {
  return typeof value === 'object' && value !== null && !Array.isArray(value) ? (value as Record<string, unknown>) : null;
}

/** What Ashby says about the person of the booking's application. */
type AshbyPerson =
  | { readonly kind: 'results'; readonly results: unknown }
  | { readonly kind: 'no_person' }
  | { readonly kind: 'unreachable' };

/**
 * The `candidate.info` results of the application's person: the Ashby candidate id of our application
 * link, else the one `application.info` names. A database failure propagates (`r1_meet_db_error`); ANY
 * Ashby failure, or no usable Ashby port, is `unreachable`. Reads only.
 */
async function readAshbyPerson(calendar: R1MeetCalendarDeps, booking: R1MeetCalendarBooking): Promise<AshbyPerson> {
  const ashby = ashbyOf(calendar);
  if (ashby === null) return { kind: 'unreachable' };
  let ashbyCandidateId = await calendar.store.linkCandidateId(booking.applicationId);
  try {
    if (ashbyCandidateId === null) {
      const application = await ashby.applicationInfo(booking.applicationId);
      ashbyCandidateId = extractApplicationInfo(asObject(application)?.results).candidateId ?? null;
      // Ashby answered and names no person: there is no Ashby address, so the local one is used.
      if (ashbyCandidateId === null) return { kind: 'no_person' };
    }
    const person = await ashby.candidateInfo(ashbyCandidateId);
    return { kind: 'results', results: asObject(person)?.results };
  } catch {
    // Never read the error: whatever Ashby said, no part of it reaches a log or the result.
    return { kind: 'unreachable' };
  }
}

/** The on-file address, the end of the invite, or a wait for Ashby. */
type OnFileEmail =
  | { readonly kind: 'email'; readonly email: string }
  | { readonly kind: 'none' }
  | { readonly kind: 'wait'; readonly result: R1MeetJobResult };

/**
 * The invite's one attendee (D-S05-3): Ashby's `primaryEmailAddress` of a fresh `candidate.info`,
 * else `candidates.email` (both normalised by `resolveR1PublicOnFileEmail`), never a typed value.
 * Ashby unreachable: a wait (`ashby_unavailable`, 120 s, bounded) until 30 minutes before the slot,
 * then the local address alone with the `invite_fallback` alert. The address is held in memory only.
 */
async function resolveOnFileEmail(
  deps: R1MeetFlowDeps,
  calendar: R1MeetCalendarDeps,
  booking: R1MeetCalendarBooking,
  meta: R1MeetJobMeta,
): Promise<OnFileEmail> {
  const local = async (): Promise<string | null> =>
    booking.candidateId === null ? null : resolveR1PublicOnFileEmail(null, await calendar.store.candidateEmail(booking.candidateId));
  const found = (email: string | null): OnFileEmail => (email === null ? { kind: 'none' } : { kind: 'email', email });

  const person = await readAshbyPerson(calendar, booking);
  if (person.kind !== 'unreachable') {
    const fromAshby = person.kind === 'results' ? resolveR1PublicOnFileEmail(person.results, null) : null;
    return found(fromAshby ?? (await local()));
  }
  const nowMs = deps.now();
  if (nowMs < Date.parse(booking.startAt) - R1_MEET_CALENDAR_SYNC.ashbyFallbackMs) {
    return {
      kind: 'wait',
      result: deferOrThrow(meta, nowMs, 'ashby_unavailable', R1_MEET_CALENDAR_SYNC.ashbyDeferSec, ASHBY_UNAVAILABLE),
    };
  }
  alert(deps.log, R1_MEET_PUBLIC_CALENDAR_ALERTS.ashbyUnavailable, 'invite_fallback');
  return found(await local());
}

/**
 * The Google client's metadata records as `r1_meet_google_ok` (info) / `r1_meet_google_failed` (warn)
 * lines: `error_type` the operation, or `<operation>:<code>`, and the HTTP status. Never an id, a URL,
 * an email or a body (the client's records hold none).
 */
export function r1MeetGoogleClientLogger(log: R1MeetLog): GoogleClientLogger {
  return Object.freeze({
    event(record: Parameters<GoogleClientLogger['event']>[0]) {
      const meta: R1MeetLogMeta = {
        error_category: record.outcome === 'success' ? 'r1_meet_google_ok' : 'r1_meet_google_failed',
        error_type: record.code === undefined ? record.operation : `${record.operation}:${record.code}`,
        ...(record.httpStatus === undefined ? {} : { http_status: record.httpStatus }),
      };
      if (record.outcome === 'success') log.info(meta);
      else log.warn(meta);
    },
  });
}

// ── The manage link and the words (the invite and the move) ─────────────────

/** No manage key (the worker secret): never a send without a stored digest. The setup alert, an hour's wait. */
function manageKeyMissing(deps: R1MeetFlowDeps, meta: R1MeetJobMeta): R1MeetJobResult | null {
  if (r1MeetDerivedKey(R1_MEET_MANAGE_DOMAIN, deps.ticketSource) !== null) return null;
  alert(deps.log, R1_MEET_PUBLIC_CALENDAR_ALERTS.setupError, 'manage_key_missing');
  return deferOrThrow(meta, deps.now(), 'manage_key_missing', R1_MEET_CALENDAR_SYNC.setupDeferSec, MANAGE_KEY_MISSING);
}

/** Who the invite says the interviewer is: the booking's objective profile. Unknown: an alert and a throw. */
function interviewerName(deps: R1MeetFlowDeps, booking: R1MeetCalendarBooking): string {
  const profile = getR1MeetProfile(booking.objectiveProfile);
  if (profile === null) {
    deps.log.error({ error_category: R1_MEET_ALERTS.profileUnknown });
    throw new R1MeetJobError(PROFILE_UNKNOWN);
  }
  return profile.botDisplayName;
}

/** The description to send, or the end of the job when the row refused the new digest. */
type FreshManageLink =
  | { readonly kind: 'ready'; readonly description: string }
  | { readonly kind: 'refused'; readonly result: R1MeetJobResult };

/**
 * A fresh manage token (32 random bytes) and the description with its link, built in memory; then ONLY
 * the token's digest is stored (`r1_meet_public_set_manage_digest`), BEFORE any send. The token leaves
 * this function inside the description only: never a log line, a row, a job or an error. A refusal
 * (`booking_terminal`, `not_found`, `not_public`) ends the job ignored, with no send.
 */
async function storeFreshManageLink(
  deps: R1MeetFlowDeps,
  store: R1MeetCalendarStore,
  booking: R1MeetCalendarBooking,
  name: string,
): Promise<FreshManageLink> {
  const minted = mintR1MeetManageToken({
    ...(deps.random === undefined ? {} : { random: deps.random }),
    ...(deps.ticketSource === undefined ? {} : { source: deps.ticketSource }),
  });
  if (minted === null) throw new R1MeetJobError(MINT_FAILED);
  const manageLink = r1MeetPublicManageLink(deps.config.bridgePageUrl, minted.token);
  const description = manageLink === null ? null : buildR1MeetPublicInviteDescription({ interviewerName: name, manageLink });
  if (description === null) throw new R1MeetJobError(COPY_INVALID);
  const stored = await store.setManageDigest({ bookingId: booking.id, digest: minted.digest, nowIso: toIso(deps.now()) });
  switch (stored) {
    case 'ok':
      return { kind: 'ready', description };
    case 'booking_terminal':
      return { kind: 'refused', result: r1MeetIgnored('booking_terminal') };
    case 'not_found':
      return { kind: 'refused', result: r1MeetIgnored('booking_gone') };
    default:
      return { kind: 'refused', result: r1MeetIgnored('not_public') };
  }
}

/** Calendar mode only (D-S05-12): the sent event's Meet link must still be the booking's. Alerts only. */
function checkMeetLink(
  log: R1MeetLog,
  google: R1MeetCalendarGoogle,
  sent: GoogleCalendarEvent,
  booking: R1MeetCalendarBooking,
  op: 'invite' | 'move',
): void {
  // In space mode the event carries no Meet link of its own (`location` holds the space's).
  if (google.meetMode === 'calendar' && normalizeGoogleMeetUrl(sent.hangoutLink) !== booking.meetUrl) {
    alert(log, R1_MEET_PUBLIC_CALENDAR_ALERTS.meetLinkChanged, op);
  }
}

// ── The invite ──────────────────────────────────────────────────────────────

/** Ends an invite whose booking became undeliverable: the code of the job either way. */
async function undeliverable(
  deps: R1MeetFlowDeps,
  booking: R1MeetCalendarBooking,
  why: 'no_email' | 'event_gone' | 'invite_deadline',
): Promise<R1MeetJobResult> {
  await failR1MeetPublicInvite(deps, booking, why);
  return r1MeetProcessed(why === 'event_gone' ? 'event_gone' : 'invite_undeliverable');
}

/**
 * The job's code once the invite is on Google: `onOk`, or the word for a row that moved meanwhile (a
 * cancel job then finds the event and deletes it with `sendUpdates=all`; a deleted row has its purge).
 */
function invitedState(answer: R1MeetSetCalendarStateAnswer, onOk: 'invited' | 'invite_confirmed'): R1MeetJobResult {
  switch (answer.status) {
    case 'ok':
      return r1MeetProcessed(onOk);
    case 'state_conflict':
      return r1MeetProcessed('invited_state_conflict');
    case 'not_found':
      return r1MeetProcessed('invited_booking_gone');
    default:
      // A row never changes its source: the store or the database is not what this build expects.
      throw new R1MeetJobError(R1_MEET_RPC_UNEXPECTED);
  }
}

async function runInvite(
  deps: R1MeetFlowDeps,
  calendar: R1MeetCalendarDeps,
  bookingId: string,
  meta: R1MeetJobMeta,
): Promise<R1MeetJobResult> {
  const store = calendar.store;

  // 2. The booking: public, live and undispatched, its event still there.
  const booking = await store.getBooking(bookingId);
  if (booking === null) return r1MeetIgnored('booking_gone');
  if (booking.source !== 'public_page') return r1MeetIgnored('ashby_booking');
  if (!UNDISPATCHED_LIVE.has(booking.status)) return r1MeetIgnored('booking_not_live');
  const state = booking.calendarState;
  if (state === null || !EVENT_EXISTS.includes(state)) return r1MeetIgnored(`calendar_${state ?? 'none'}`);

  // 3. Lexy's calendar.
  const google = googleOf(calendar);
  if (google === null) return googleUnconfigured(deps, meta);
  const eventId = r1MeetCalendarEventId(booking.id);

  // 4. The event, as Google has it now.
  let event: GoogleCalendarEvent | null;
  try {
    event = await google.calendar.getEvent(eventId);
  } catch (error) {
    return googleFailure(error, { meta, nowMs: deps.now(), log: deps.log, call: 'calendar.get' });
  }
  if (eventGone(event)) return undeliverable(deps, booking, 'event_gone');

  // 5. Already applied: only the state may be behind.
  if (event !== null && event.attendeeEmails.length > 0) {
    if (state === 'invited') return r1MeetIgnored('already_invited');
    return invitedState(
      await store.setCalendarState({ bookingId: booking.id, from: EVENT_EXISTS, to: 'invited', nowIso: toIso(deps.now()) }),
      'invite_confirmed',
    );
  }

  // 6. Too late to invite anyone.
  if (deps.now() >= Date.parse(booking.startAt) - R1_MEET_CALENDAR_SYNC.inviteDeadlineMs) {
    return undeliverable(deps, booking, 'invite_deadline');
  }

  // 7. The manage key: never a send without a stored digest.
  const keyMissing = manageKeyMissing(deps, meta);
  if (keyMissing !== null) return keyMissing;

  // 8. Who the invite says the interviewer is.
  const name = interviewerName(deps, booking);

  // 9. The on-file email.
  const onFile = await resolveOnFileEmail(deps, calendar, booking, meta);
  if (onFile.kind === 'wait') return onFile.result;
  if (onFile.kind === 'none') return undeliverable(deps, booking, 'no_email');

  // 10. A fresh manage token and the words, in memory; then its digest, BEFORE the send.
  const link = await storeFreshManageLink(deps, store, booking, name);
  if (link.kind === 'refused') return link.result;

  // 11. The send: exactly the on-file attendee and the description; Google mails the invite.
  let sent: GoogleCalendarEvent;
  try {
    sent = await google.calendar.patchEvent(eventId, { attendeeEmail: onFile.email, description: link.description }, 'all');
  } catch (error) {
    if (isGoogleError(error) && error.code === 'not_found') return undeliverable(deps, booking, 'event_gone');
    return googleFailure(error, { meta, nowMs: deps.now(), log: deps.log, call: 'calendar.patch' });
  }

  // 12. The state.
  const moved = await store.setCalendarState({ bookingId: booking.id, from: EVENT_EXISTS, to: 'invited', nowIso: toIso(deps.now()) });
  // 13. The Meet link, in calendar mode.
  checkMeetLink(deps.log, google, sent, booking, 'invite');
  return invitedState(moved, 'invited');
}

// ── The move ────────────────────────────────────────────────────────────────

/** The event already holds the booking's slot: compared in milliseconds (Google may answer in IST). */
function sameSlot(event: GoogleCalendarEvent, booking: R1MeetCalendarBooking): boolean {
  return (
    event.startAt !== null &&
    event.endAt !== null &&
    Date.parse(event.startAt) === Date.parse(booking.startAt) &&
    Date.parse(event.endAt) === Date.parse(booking.endAt)
  );
}

/**
 * A `created` state whose event lists an attendee (an invite whose answer was lost; this job is the
 * only writer of attendees) -> `invited`. A row that moved meanwhile is left as it is.
 */
async function repairInvited(
  deps: R1MeetFlowDeps,
  store: R1MeetCalendarStore,
  booking: R1MeetCalendarBooking,
  event: GoogleCalendarEvent,
): Promise<void> {
  if (booking.calendarState !== 'created' || event.attendeeEmails.length === 0) return;
  const answer = await store.setCalendarState({ bookingId: booking.id, from: EVENT_EXISTS, to: 'invited', nowIso: toIso(deps.now()) });
  // A row never changes its source: the store or the database is not what this build expects.
  if (answer.status === 'not_public') throw new R1MeetJobError(R1_MEET_RPC_UNEXPECTED);
}

/**
 * The event of a move is gone from Lexy's calendar (D-S05-5): an undispatched booking can no longer be
 * reached (`failed/invite_undeliverable`, alert `event_gone`, a held bot queued for release); a
 * dispatched one is never cut. Never a retry: the job is done either way.
 */
async function moveEventGone(deps: R1MeetFlowDeps, booking: R1MeetCalendarBooking): Promise<R1MeetJobResult> {
  if (UNDISPATCHED_LIVE.has(booking.status)) await failR1MeetPublicInvite(deps, booking, 'event_gone');
  return r1MeetProcessed('event_gone');
}

async function runMove(
  deps: R1MeetFlowDeps,
  calendar: R1MeetCalendarDeps,
  bookingId: string,
  meta: R1MeetJobMeta,
): Promise<R1MeetJobResult> {
  const store = calendar.store;

  // The CURRENT row: a stale job converges on the newest slot.
  const booking = await store.getBooking(bookingId);
  if (booking === null) return r1MeetIgnored('booking_gone');
  if (booking.source !== 'public_page') return r1MeetIgnored('ashby_booking');
  if (TERMINAL.has(booking.status)) return r1MeetIgnored('booking_terminal');
  if (deps.now() >= Date.parse(booking.endAt)) return r1MeetIgnored('slot_over');
  const state = booking.calendarState;
  if (state === null || !EVENT_EXISTS.includes(state)) return r1MeetIgnored(`calendar_${state ?? 'none'}`);

  const google = googleOf(calendar);
  if (google === null) return googleUnconfigured(deps, meta);
  const eventId = r1MeetCalendarEventId(booking.id);

  let event: GoogleCalendarEvent | null;
  try {
    event = await google.calendar.getEvent(eventId);
  } catch (error) {
    return googleFailure(error, { meta, nowMs: deps.now(), log: deps.log, call: 'calendar.get' });
  }
  if (event === null || eventGone(event)) return moveEventGone(deps, booking);

  // Already on Google (a lost answer, or an earlier job of a later move): no token, no write.
  if (sameSlot(event, booking)) {
    await repairInvited(deps, store, booking, event);
    return r1MeetProcessed('already_moved');
  }

  const keyMissing = manageKeyMissing(deps, meta);
  if (keyMissing !== null) return keyMissing;
  const name = interviewerName(deps, booking);
  const link = await storeFreshManageLink(deps, store, booking, name);
  if (link.kind === 'refused') return link.result;

  // The send: the new slot and the description with the new link. NEVER the attendees: Google keeps them.
  let sent: GoogleCalendarEvent;
  try {
    sent = await google.calendar.patchEvent(
      eventId,
      { startAt: booking.startAt, endAt: booking.endAt, description: link.description },
      'all',
    );
  } catch (error) {
    if (isGoogleError(error) && error.code === 'not_found') return moveEventGone(deps, booking);
    return googleFailure(error, { meta, nowMs: deps.now(), log: deps.log, call: 'calendar.patch' });
  }
  checkMeetLink(deps.log, google, sent, booking, 'move');
  await repairInvited(deps, store, booking, sent);
  return r1MeetProcessed('moved');
}

// ── The cancel (shared with the drain) ──────────────────────────────────────

/** What one cancel of a booking's event did (`cancelled`, `cancelled_gone`) or why it did nothing. */
export type R1MeetCalendarCancelOutcome =
  | 'cancelled'
  | 'cancelled_gone'
  | 'after_start'
  | 'booking_live'
  | 'not_public'
  | 'not_owed'
  | 'booking_gone'
  | 'state_conflict';

/**
 * The cancel rule (D-S05-6), in this order: the booking (gone: `booking_gone`), public (else
 * `not_public`), terminal (else `booking_live`: a live booking's event is never deleted), its event
 * still there (`created`/`invited`, else `not_owed`), its slot still ahead (else `after_start`, with
 * no Google call). Only then are Lexy's Google settings asked for (none: `google_unconfigured`), the
 * event deleted with `sendUpdates=all` (a 404/410 counts as deleted) and the state set `cancelled`.
 * Throws a `GoogleError` (the delete) or an `R1MeetJobError` (the database).
 */
async function cancelEvent(
  store: R1MeetCalendarStore,
  google: () => R1MeetCalendarGoogle | null,
  bookingId: string,
  nowMs: number,
): Promise<R1MeetCalendarCancelOutcome | 'google_unconfigured'> {
  const booking = await store.getBooking(bookingId);
  if (booking === null) return 'booking_gone';
  if (booking.source !== 'public_page') return 'not_public';
  if (!TERMINAL.has(booking.status)) return 'booking_live';
  const state = booking.calendarState;
  if (state === null || !EVENT_EXISTS.includes(state)) return 'not_owed';
  if (nowMs >= Date.parse(booking.startAt)) return 'after_start';

  const settings = google();
  if (settings === null) return 'google_unconfigured';
  // `all` for `created` too: with no attendee Google mails nobody; with one whose invite answer was
  // lost, the candidate still hears of the cancel.
  const deleted = await settings.calendar.deleteEvent(r1MeetCalendarEventId(booking.id), 'all');
  const answer = await store.setCalendarState({ bookingId: booking.id, from: EVENT_EXISTS, to: 'cancelled', nowIso: toIso(nowMs) });
  switch (answer.status) {
    case 'ok':
      return deleted === 'deleted' ? 'cancelled' : 'cancelled_gone';
    case 'state_conflict':
      return 'state_conflict';
    case 'not_found':
      return 'booking_gone';
    default:
      // A row never changes its source: the store or the database is not what this build expects.
      throw new R1MeetJobError(R1_MEET_RPC_UNEXPECTED);
  }
}

/**
 * Cancel one public booking's event on Lexy's calendar under the cancel rule (D-S05-6; see
 * `cancelEvent`). The `calendar_sync` cancel op and the drain's inline cancel share it. Throws a
 * `GoogleError` when the delete fails and an `R1MeetJobError` when the database does: the caller
 * decides (the job defers or throws a closed code; the drain alerts and leaves it to `pub_drift`).
 */
export async function cancelR1MeetPublicCalendarEvent(
  calendar: Pick<R1MeetCalendarDeps, 'store'>,
  google: R1MeetCalendarGoogle,
  bookingId: string,
  nowMs: number,
): Promise<R1MeetCalendarCancelOutcome> {
  const outcome = await cancelEvent(calendar.store, () => google ?? null, bookingId, nowMs);
  // Only reachable when a caller hands in no settings at all.
  if (outcome === 'google_unconfigured') throw new R1MeetJobError(GOOGLE_UNCONFIGURED);
  return outcome;
}

/**
 * The cancel op: the shared rule, with Lexy's Google settings asked for only once a delete is owed (a
 * job that owes nothing ends ignored even without them).
 */
async function runCancel(
  deps: R1MeetFlowDeps,
  calendar: R1MeetCalendarDeps,
  bookingId: string,
  meta: R1MeetJobMeta,
): Promise<R1MeetJobResult> {
  let outcome: R1MeetCalendarCancelOutcome | 'google_unconfigured';
  try {
    outcome = await cancelEvent(calendar.store, () => googleOf(calendar), bookingId, deps.now());
  } catch (error) {
    return googleFailure(error, { meta, nowMs: deps.now(), log: deps.log, call: 'calendar.delete' });
  }
  if (outcome === 'google_unconfigured') return googleUnconfigured(deps, meta);
  return outcome === 'cancelled' || outcome === 'cancelled_gone' ? r1MeetProcessed(outcome) : r1MeetIgnored(outcome);
}

// ── The purge ───────────────────────────────────────────────────────────────

async function runPurge(
  deps: R1MeetFlowDeps,
  calendar: R1MeetCalendarDeps,
  bookingId: string,
  meta: R1MeetJobMeta,
): Promise<R1MeetJobResult> {
  const store = calendar.store;
  // Derived, never read: after a delete there is no row to read it from.
  const eventId = r1MeetCalendarEventId(bookingId);

  const booking = await store.getBooking(bookingId);
  let sendUpdates: GoogleCalendarSendUpdates = 'none';
  if (booking !== null) {
    if (booking.source !== 'public_page') return r1MeetIgnored('ashby_booking');
    if (!TERMINAL.has(booking.status)) return r1MeetIgnored('booking_live');
    if (booking.calendarState === 'purged') return r1MeetIgnored('already_purged');
    // A terminal booking whose slot is still ahead: the candidate is told.
    if (deps.now() < Date.parse(booking.startAt)) sendUpdates = 'all';
  }

  const google = googleOf(calendar);
  if (google === null) return googleUnconfigured(deps, meta);
  try {
    // `deleted` and `gone` (404/410) are both done.
    await google.calendar.deleteEvent(eventId, sendUpdates);
  } catch (error) {
    return googleFailure(error, { meta, nowMs: deps.now(), log: deps.log, call: 'calendar.delete' });
  }
  if (booking === null) return r1MeetProcessed('purged_no_row');

  const answer = await store.setCalendarState({ bookingId: booking.id, from: PURGEABLE, to: 'purged', nowIso: toIso(deps.now()) });
  switch (answer.status) {
    case 'ok':
      return r1MeetProcessed('purged');
    case 'state_conflict':
      return r1MeetProcessed('purged_state_conflict');
    case 'not_found':
      return r1MeetProcessed('purged_no_row');
    default:
      // A row never changes its source: the store or the database is not what this build expects.
      throw new R1MeetJobError(R1_MEET_RPC_UNEXPECTED);
  }
}

// ── The job ─────────────────────────────────────────────────────────────────

/** Run the job (see the header). Exported for tests; the dispatcher reaches it through the definition. */
export async function runR1MeetCalendarSync(
  deps: R1MeetFlowDeps,
  job: R1MeetCalendarSyncJob,
  meta: R1MeetJobMeta,
): Promise<R1MeetJobResult> {
  // 1. Wiring, before anything is read.
  const calendar = requireCalendar(deps);
  switch (job.op) {
    case 'invite':
      return runInvite(deps, calendar, job.bookingId, meta);
    case 'move':
      return runMove(deps, calendar, job.bookingId, meta);
    case 'cancel':
      return runCancel(deps, calendar, job.bookingId, meta);
    case 'purge':
      return runPurge(deps, calendar, job.bookingId, meta);
    default:
      // The parser admits the four ops only.
      throw new R1MeetJobError(R1_MEET_MALFORMED_PAYLOAD);
  }
}

/** `calendar_sync` (M035 S05): Lexy's calendar event of one public booking, in step with it. */
export const r1MeetCalendarSyncDefinition: R1MeetJobDefinition<R1MeetCalendarSyncJob> = Object.freeze({
  kind: 'calendar_sync',
  parse: parseCalendarSyncJob,
  run(deps: R1MeetFlowDeps, job: R1MeetCalendarSyncJob, meta: R1MeetJobMeta): Promise<R1MeetJobResult> {
    return runR1MeetCalendarSync(deps, job, meta);
  },
});
