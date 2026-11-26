/**
 * R1-over-Meet: the Recall create-bot request for one booking, built from its objective profile.
 *
 * Booking source (D-M034-11): HR schedules the interview in Ashby with "Dex (AI Interviewer)" as an
 * interviewer, Ashby creates the Google Meet, and the Ashby interview-schedule webhooks
 * (`ashby-schedule.ts`) become a booking row. The caller is the Meet runtime (M034 S06): for each
 * eligible Dex event it passes the booking and the settings it got from the Meet config; this module
 * only turns them into the exact `POST /api/v1/bot/` body and the Idempotency-Key, and refuses
 * anything malformed with a fixed reason, before any network call.
 *
 * A booking the candidate made on the public R1 booking page (M035, source `public_page`) has no Ashby
 * event: its body is built the same way, and its Idempotency-Key lives in its own space,
 * `r1-meet-pb-<booking id>-v<version>-k<keyAttempt>` (`r1MeetPublicCreateBotIdempotencyKey`), next to
 * the Ashby `r1-meet-<event id>-v<version>-k<keyAttempt>`. `r1MeetBookingIdempotencyKey` picks by source.
 *
 * Pure: no environment, no I/O, no clock and no logging.
 *
 * The body (S01 plan section 4) asks Recall for as little as possible:
 *  - the canonical Meet link, the bot's display name and `join_at` = slot start minus the join lead
 *    (S01 plan R32: the profile's `botJoinLeadSec`, 120 s for Dex, unless the caller passes a
 *    `joinLeadSec` override of 0..900 s). The builder has no clock: the caller decides whether
 *    `join_at` is at least `RECALL_SCHEDULED_BOT_MIN_LEAD_MS` away (a scheduled bot, which never gets
 *    507) or not (an ad-hoc bot, which may get 507 and is retried by the durable queue);
 *  - the `web_4_core` Google Meet variant and the profile's automatic-leave timers;
 *  - explicit bot detection from the profile (M035 S09): the participant-name heuristic activates
 *    only after the longest stay the other timers allow, so a candidate whose Meet name contains
 *    "assistant", "recorder" or "notetaker" never makes the bot leave; the no-speech heuristic keeps
 *    Recall's default timers. `silence_detection` is not sent (its default cannot fire before the
 *    in-call-recording cap);
 *  - a minimal recording config: no transcript, no video, no meeting metadata; only participant
 *    join/leave events, pushed to our real-time webhook and kept for the profile's retention hours.
 *    It is the server-side "a human is in the call" signal;
 *  - the profile's disclosure (Dex is an AI interviewer and the call is recorded), posted to
 *    everyone in the chat and pinned when the bot joins, and re-sent to everyone (host included)
 *    each time a participant joins, so a candidate who joins after the bot sees it even when the
 *    Workspace's continuous chat hides the pin (M035 S09). It is a notice only: consent was attested
 *    by HR when they scheduled the Dex interview in Ashby (consent mode `hr_attested_ashby`);
 *  - `output_media` (our bridge page as the bot's camera) only when a page URL is given, and only
 *    ever of kind `webpage`; without it the caller can arm the camera mid-call instead;
 *  - `google_meet` (signed-in bot) only when a login group is configured; the default guest bot
 *    sends none;
 *  - `metadata` = our booking row id and the profile id only: no name, email or other personal data.
 */

import { normalizeGoogleMeetUrl } from '../../../integrations/google-meet/url.js';
import { isRecallIsoDateTime } from '../../../integrations/recall/client.js';
import type {
  RecallCreateBotRequest,
  RecallGoogleMeetVariant,
  RecallRealtimeEvent,
} from '../../../integrations/recall/types.js';
import { getR1MeetProfile } from './profiles.js';

/** The Google Meet bot machine size R1 uses. */
export const R1_MEET_RECALL_VARIANT: RecallGoogleMeetVariant = 'web_4_core';

/** The only real-time events R1 asks Recall for. */
export const R1_MEET_REALTIME_EVENTS: readonly RecallRealtimeEvent[] = Object.freeze([
  'participant_events.join',
  'participant_events.leave',
] as const);

export interface R1MeetBotBooking {
  /** The booking row id: a lowercase UUID. */
  readonly bookingId: string;
  /** The Meet link from the booking; normalised to `https://meet.google.com/<code>`. */
  readonly meetingUrl: string;
  /** The booked slot's start: a valid Date or a strict ISO 8601 date-time with an offset. */
  readonly slotStart: Date | string;
}

export interface R1MeetBotSettings {
  /** Where Recall pushes participant events: https, no credentials, no fragment. */
  readonly realtimeWebhookUrl: string;
  /** Overrides the profile's display name; null = the profile's name. */
  readonly botNameOverride: string | null;
  /** Recall Google login group for a signed-in bot; null = the bot joins signed out. */
  readonly googleLoginGroupId: string | null;
  /** Our bridge page as the bot's camera; absent or null = no output media at creation. */
  readonly outputMediaUrl?: string | null;
  /**
   * Seconds before the slot start the bot joins: an integer 0..900. Absent or null = the profile's
   * `botJoinLeadSec` (S01 plan R32).
   */
  readonly joinLeadSec?: number | null;
}

/** The longest join lead the builder accepts, in seconds. */
export const R1_MEET_MAX_JOIN_LEAD_SEC = 900;

/** Every reason the builder refuses a booking, in the order the checks run. Frozen. */
export const R1_MEET_CREATE_BOT_FAILURES = Object.freeze([
  'unknown_profile',
  'invalid_booking_id',
  'invalid_meeting_url',
  'invalid_join_lead',
  'invalid_slot_start',
  'invalid_realtime_url',
  'invalid_output_media_url',
  'invalid_login_group_id',
  'invalid_bot_name',
] as const);

export type R1MeetCreateBotFailure = (typeof R1_MEET_CREATE_BOT_FAILURES)[number];

export type R1MeetCreateBotResult =
  | { readonly ok: true; readonly body: RecallCreateBotRequest; readonly joinAt: string }
  | { readonly ok: false; readonly reason: R1MeetCreateBotFailure };

const BOOKING_ID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
/** Ashby ids are UUIDs, delivered in either case (S01 plan R24). */
const ASHBY_EVENT_ID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
/** A public booking's own row id, accepted in either case and lower-cased into its key (M035). */
const PUBLIC_BOOKING_ID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const LOGIN_GROUP_ID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const PRINTABLE_ASCII = /^[\x21-\x7e]+$/;
const MAX_URL_LENGTH = 2048;
/** Recall's `bot_name` limit, and the Meet config's. */
const MAX_BOT_NAME_LENGTH = 100;
// Control, format (zero-width, bidi overrides), surrogate, private-use and line/paragraph separators:
// none of them belongs in a name shown to a candidate (same rule as the Meet config reader).
const NAME_FORBIDDEN = /[\p{Cc}\p{Cf}\p{Cs}\p{Co}\p{Zl}\p{Zp}]/u;
const SURROUNDING_SPACE = /^\s|\s$/u;

/** An https URL with a host, printable ASCII, at most 2048 characters, no userinfo. */
function isHttpsUrl(raw: unknown, allowFragment: boolean): raw is string {
  if (typeof raw !== 'string' || raw.length === 0 || raw.length > MAX_URL_LENGTH) return false;
  if (!PRINTABLE_ASCII.test(raw)) return false;
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    return false;
  }
  if (url.protocol !== 'https:' || url.hostname === '' || url.username !== '' || url.password !== '') return false;
  return allowFragment || (url.hash === '' && !raw.includes('#'));
}

function isBotName(raw: unknown): raw is string {
  return (
    typeof raw === 'string' &&
    raw.length > 0 &&
    raw.length <= MAX_BOT_NAME_LENGTH &&
    !NAME_FORBIDDEN.test(raw) &&
    !SURROUNDING_SPACE.test(raw)
  );
}

/** The join lead in seconds: the profile default when absent or null, else an integer 0..900. */
function joinLeadSeconds(raw: unknown, profileDefault: number): number | null {
  if (raw === undefined || raw === null) return profileDefault;
  if (typeof raw !== 'number' || !Number.isInteger(raw) || raw < 0 || raw > R1_MEET_MAX_JOIN_LEAD_SEC) return null;
  return raw;
}

/** Epoch ms of the slot start, or null when it is not a valid Date or strict ISO date-time. */
function slotStartMs(raw: unknown): number | null {
  if (raw instanceof Date) {
    const ms = raw.getTime();
    return Number.isFinite(ms) ? ms : null;
  }
  if (!isRecallIsoDateTime(raw)) return null;
  const ms = Date.parse(raw);
  return Number.isFinite(ms) ? ms : null;
}

/** `toISOString()` of `ms` when it is a four-digit-year instant Recall accepts, else null. */
function isoInstant(ms: number): string | null {
  const date = new Date(ms);
  if (!Number.isFinite(date.getTime())) return null;
  const iso = date.toISOString();
  return isRecallIsoDateTime(iso) ? iso : null;
}

function deepFreeze<T>(value: T): T {
  if (typeof value === 'object' && value !== null && !Object.isFrozen(value)) {
    for (const child of Object.values(value)) deepFreeze(child);
    Object.freeze(value);
  }
  return value;
}

/**
 * The Recall create-bot body for `booking` under objective profile `profileId`, or a fixed failure
 * reason. Checks run in the order of `R1_MEET_CREATE_BOT_FAILURES`; nothing is echoed back on failure.
 */
export function buildR1MeetCreateBotRequest(
  profileId: string,
  booking: R1MeetBotBooking,
  settings: R1MeetBotSettings,
): R1MeetCreateBotResult {
  const profile = getR1MeetProfile(profileId);
  if (!profile) return { ok: false, reason: 'unknown_profile' };
  if (typeof booking !== 'object' || booking === null) return { ok: false, reason: 'invalid_booking_id' };
  if (typeof booking.bookingId !== 'string' || !BOOKING_ID_RE.test(booking.bookingId)) {
    return { ok: false, reason: 'invalid_booking_id' };
  }
  const meetingUrl = normalizeGoogleMeetUrl(booking.meetingUrl);
  if (meetingUrl === null) return { ok: false, reason: 'invalid_meeting_url' };
  const settingsIsObject = typeof settings === 'object' && settings !== null;
  const joinLeadSec = joinLeadSeconds(settingsIsObject ? settings.joinLeadSec : undefined, profile.botJoinLeadSec);
  if (joinLeadSec === null) return { ok: false, reason: 'invalid_join_lead' };
  const slotMs = slotStartMs(booking.slotStart);
  const joinAt = slotMs === null ? null : isoInstant(slotMs - joinLeadSec * 1000);
  if (joinAt === null) return { ok: false, reason: 'invalid_slot_start' };

  if (!settingsIsObject) return { ok: false, reason: 'invalid_realtime_url' };
  if (!isHttpsUrl(settings.realtimeWebhookUrl, false)) return { ok: false, reason: 'invalid_realtime_url' };
  const outputMediaUrl = settings.outputMediaUrl ?? null;
  if (outputMediaUrl !== null && !isHttpsUrl(outputMediaUrl, true)) {
    return { ok: false, reason: 'invalid_output_media_url' };
  }
  const loginGroupId = settings.googleLoginGroupId ?? null;
  if (loginGroupId !== null && (typeof loginGroupId !== 'string' || !LOGIN_GROUP_ID_RE.test(loginGroupId))) {
    return { ok: false, reason: 'invalid_login_group_id' };
  }
  const botName = settings.botNameOverride ?? profile.botDisplayName;
  if (!isBotName(botName)) return { ok: false, reason: 'invalid_bot_name' };

  const leave = profile.automaticLeave;
  const detection = leave.botDetection;
  const body: RecallCreateBotRequest = {
    meeting_url: meetingUrl,
    bot_name: botName,
    join_at: joinAt,
    variant: { google_meet: R1_MEET_RECALL_VARIANT },
    ...(outputMediaUrl !== null
      ? { output_media: { camera: { kind: 'webpage' as const, config: { url: outputMediaUrl } } } }
      : {}),
    automatic_leave: {
      waiting_room_timeout: leave.waitingRoomTimeoutSec,
      noone_joined_timeout: leave.nooneJoinedTimeoutSec,
      everyone_left_timeout: { timeout: leave.everyoneLeftTimeoutSec },
      in_call_not_recording_timeout: leave.inCallNotRecordingTimeoutSec,
      in_call_recording_timeout: leave.inCallRecordingTimeoutSec,
      bot_detection: {
        using_participant_events: {
          timeout: detection.participantEvents.timeoutSec,
          activate_after: detection.participantEvents.activateAfterSec,
        },
        using_participant_names: {
          matches: [...detection.participantNames.matches],
          timeout: detection.participantNames.timeoutSec,
          activate_after: detection.participantNames.activateAfterSec,
        },
      },
    },
    recording_config: {
      transcript: null,
      video_mixed_mp4: null,
      meeting_metadata: null,
      participant_events: {},
      start_recording_on: 'participant_join',
      retention: { type: 'timed', hours: profile.participantMetadataRetentionHours },
      realtime_endpoints: [
        { type: 'webhook', url: settings.realtimeWebhookUrl, events: [...R1_MEET_REALTIME_EVENTS] },
      ],
    },
    chat: {
      on_bot_join: { send_to: 'everyone', message: profile.disclosureChatMessage, pin: true },
      on_participant_join: { message: profile.disclosureChatMessage, exclude_host: false },
    },
    ...(loginGroupId !== null ? { google_meet: { google_login_group_id: loginGroupId.toLowerCase() } } : {}),
    metadata: { booking_id: booking.bookingId, profile: profile.id },
  };
  return { ok: true, body: deepFreeze(body), joinAt };
}

/**
 * The Idempotency-Key for creating the bot of one Ashby interview event (S01 plan R7, revised by the
 * PR #433 review F1): `r1-meet-<ashbyEventId lower-cased>-v<version>-k<keyAttempt>`.
 *
 * Recall caches the response of a keyed create under key + method + path for an hour, errors
 * included (400 and 500), and replays it to every request with the same key. So the key must change
 * whenever the runtime (S06) starts a NEW create, and must stay the same when it retries the SAME one:
 *  - `version` is the booking row's version: S06 bumps it whenever it deletes a bot and creates a new
 *    one (a reschedule or a new Meet link), so the cache never hands back the deleted bot;
 *  - `keyAttempt` (stored on the booking, starting at 0) is bumped whenever `createBot` throws a
 *    `RecallError` with `rotateIdempotencyKey: true` (a cached 4xx/5xx), so a transient 500, or a 400
 *    from a setting the operator then fixed, is not replayed for an hour;
 *  - neither changes on a network failure, a timeout, 429, 507, a 409 `idempotency_in_progress` or a
 *    502/503/504: that create may still finish, or may already have made the bot, and the same key
 *    is what returns it.
 * A 500 that Recall sent AFTER creating a bot could leave a second bot once the key rotates; both
 * carry `metadata.booking_id`, so S06 deletes any bot that is not the booking's current one.
 *
 * The result always satisfies `RECALL_IDEMPOTENCY_KEY_RE` (at most 80 characters). Throws a
 * `TypeError` with a fixed message (never echoing the input) on a non-UUID event id, or on a version
 * or key attempt that is not a non-negative safe integer, checked in that order.
 * A public-page booking has no Ashby event: its key is `r1MeetPublicCreateBotIdempotencyKey` (M035).
 */
export function r1MeetCreateBotIdempotencyKey(ashbyEventId: string, version: number, keyAttempt: number): string {
  if (typeof ashbyEventId !== 'string' || !ASHBY_EVENT_ID_RE.test(ashbyEventId)) {
    throw new TypeError('r1_meet_idempotency_invalid_event_id');
  }
  if (typeof version !== 'number' || !Number.isSafeInteger(version) || version < 0) {
    throw new TypeError('r1_meet_idempotency_invalid_version');
  }
  if (typeof keyAttempt !== 'number' || !Number.isSafeInteger(keyAttempt) || keyAttempt < 0) {
    throw new TypeError('r1_meet_idempotency_invalid_key_attempt');
  }
  return `r1-meet-${ashbyEventId.toLowerCase()}-v${version}-k${keyAttempt}`;
}

/**
 * The Idempotency-Key for creating the bot of one public-page booking (M035; there is no Ashby event):
 * `r1-meet-pb-<booking id lower-cased>-v<version>-k<keyAttempt>`. `version` and `keyAttempt` change
 * exactly as for an Ashby booking (see `r1MeetCreateBotIdempotencyKey`). The space is disjoint from the
 * Ashby one: the ninth character of an Ashby key is a hex digit, of a public key the `p` of `pb-`.
 *
 * The result always satisfies `RECALL_IDEMPOTENCY_KEY_RE` (at most 83 characters). Throws a
 * `TypeError` with a fixed message (never echoing the input) on a non-UUID booking id, or on a version
 * or key attempt that is not a non-negative safe integer, checked in that order.
 */
export function r1MeetPublicCreateBotIdempotencyKey(bookingId: string, version: number, keyAttempt: number): string {
  if (typeof bookingId !== 'string' || !PUBLIC_BOOKING_ID_RE.test(bookingId)) {
    throw new TypeError('r1_meet_idempotency_invalid_booking_id');
  }
  if (typeof version !== 'number' || !Number.isSafeInteger(version) || version < 0) {
    throw new TypeError('r1_meet_idempotency_invalid_version');
  }
  if (typeof keyAttempt !== 'number' || !Number.isSafeInteger(keyAttempt) || keyAttempt < 0) {
    throw new TypeError('r1_meet_idempotency_invalid_key_attempt');
  }
  return `r1-meet-pb-${bookingId.toLowerCase()}-v${version}-k${keyAttempt}`;
}

/**
 * What the key picker reads of a booking. Structural on purpose: this module stays pure and imports
 * nothing from the runtime store, whose `R1MeetBooking` union satisfies it.
 */
export type R1MeetBotKeyBooking =
  | {
      readonly source: 'ashby';
      readonly eventId: string;
      readonly id: string;
      readonly version: number;
      readonly keyAttempt: number;
    }
  | {
      readonly source: 'public_page';
      readonly eventId: null;
      readonly id: string;
      readonly version: number;
      readonly keyAttempt: number;
    };

/**
 * The create Idempotency-Key of `booking`, by its source: an Ashby booking keys on its Ashby event id
 * (`r1MeetCreateBotIdempotencyKey`, unchanged), a public-page booking on its own row id
 * (`r1MeetPublicCreateBotIdempotencyKey`). Any other source throws
 * `TypeError('r1_meet_idempotency_invalid_source')`; the two key functions throw their own fixed messages.
 */
export function r1MeetBookingIdempotencyKey(booking: R1MeetBotKeyBooking): string {
  if (typeof booking !== 'object' || booking === null) throw new TypeError('r1_meet_idempotency_invalid_source');
  if (booking.source === 'ashby') {
    return r1MeetCreateBotIdempotencyKey(booking.eventId, booking.version, booking.keyAttempt);
  }
  if (booking.source === 'public_page') {
    return r1MeetPublicCreateBotIdempotencyKey(booking.id, booking.version, booking.keyAttempt);
  }
  throw new TypeError('r1_meet_idempotency_invalid_source');
}
