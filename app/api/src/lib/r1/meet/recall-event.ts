/**
 * lib/r1/meet/recall-event.ts — turns a verified Recall.ai webhook body into the `recall_event` job
 * of the `r1-meet` queue (M034 S03, dark).
 *
 * Two Recall sources, one router mounted pre-auth at `R1_MEET_RECALL_MOUNT_PATH` (S03 plan R1):
 *  - `status` = `POST /api/integrations/recall/webhook`: the dashboard (Svix) endpoint, one per
 *    region, for every bot of the workspace. It accepts the nine `bot.*` status events in
 *    `R1_MEET_RECALL_STATUS_EVENTS` (`docs_bot-status-change-events.md`).
 *  - `realtime` = `POST /api/integrations/recall/realtime`: the per-bot real-time endpoint that the
 *    S01 bot builder writes into every bot's `recording_config.realtime_endpoints`
 *    (`R1_MEET_RECALL_REALTIME_PATH`). It accepts exactly `R1_MEET_REALTIME_EVENTS`
 *    (participant join and leave).
 * Both are signed with the SAME workspace verification secret (`RECALL_WEBHOOK_SECRET`; accounts
 * created on or after 2025-12-15), verified over the raw bytes by
 * `integrations/recall/webhook-verify.ts` BEFORE this module ever sees the parsed body.
 *
 * Results (never throws; any throw, including a throwing getter, is `malformed_event`):
 *  - an event the endpoint does not accept (a breakout event, `recording.*`, `transcript.*`, any
 *    unknown string, or an event posted to the other endpoint) is `ignored_event`: no Meet meaning,
 *    so the receiver answers 200 `ignored` with no receipt;
 *  - a body that is not an object, an `event` that is not a string, or an ACCEPTED event without a
 *    UUID `data.bot.id` is `malformed_event` (the receiver answers 400, so Svix keeps retrying for a
 *    day while a schema drift is fixed);
 *  - otherwise `ok` with a frozen payload in the exact contract §2 key order:
 *    `{ kind: 'recall_event', event_type, recall_bot_id, booking_id, occurred_at, sub_code, participant }`.
 *    Malformed inner fields become null rather than a rejection (the delivery is signed and its bot
 *    id is good):
 *     - `recall_bot_id`: `data.bot.id`, lower-cased;
 *     - `booking_id`: `data.bot.metadata.booking_id` only when it is a UUID string, lower-cased;
 *     - `occurred_at`: the canonical `toISOString()` of `data.data.updated_at` (status events) or
 *       `data.data.timestamp.absolute` (participant events), checked with `isRecallIsoDateTime`; a
 *       fraction beyond milliseconds is truncated;
 *     - `sub_code`: `data.data.sub_code` when it matches `^[A-Za-z0-9_.:-]{1,128}$` (status events
 *       only; always null for participant events);
 *     - `participant`: null for status events; for participant events always `{ id, is_host, is_bot }`
 *       with `id` a non-negative safe integer or null and the two flags a boolean or null. Recall
 *       documents NO `is_bot` field (`docs_real-time-event-payloads.md`): it stays null unless Recall
 *       ever sends a boolean.
 *
 * Dropped, never read (data-classification "Job payloads"): the participant's name, email,
 * platform and `extra_data`, and the `realtime_endpoint`, `recording` and `participant_events`
 * artifacts. Only the fields above are accessed.
 *
 * Pure: no environment, no I/O, no clock, no logging.
 */
import { isRecallIsoDateTime } from '../../../integrations/recall/client.js';
import type { RecallRealtimeEvent } from '../../../integrations/recall/types.js';
import { R1_MEET_RECALL_REALTIME_PATH } from './config.js';
import { R1_MEET_REALTIME_EVENTS } from './recall-bot.js';

// ── Contract constants ──────────────────────────────────────────────────────

/** Where the Recall router is mounted (pre-auth). */
export const R1_MEET_RECALL_MOUNT_PATH = '/api/integrations/recall';

/** The router-relative path of each Recall endpoint. Frozen. */
export const R1_MEET_RECALL_SUBPATHS = Object.freeze({
  status: '/webhook',
  realtime: '/realtime',
} as const);

/** The bot-status (dashboard) endpoint. */
export const R1_MEET_RECALL_STATUS_PATH = '/api/integrations/recall/webhook';

/** The per-bot real-time endpoint; the S01 bot builder writes this exact path into every bot. */
export { R1_MEET_RECALL_REALTIME_PATH };

/** The bot status events with a Meet meaning, in Recall's lifecycle order (S03 plan R4). Frozen. */
export const R1_MEET_RECALL_STATUS_EVENTS = Object.freeze([
  'bot.joining_call',
  'bot.in_waiting_room',
  'bot.in_call_not_recording',
  'bot.recording_permission_allowed',
  'bot.recording_permission_denied',
  'bot.in_call_recording',
  'bot.call_ended',
  'bot.done',
  'bot.fatal',
] as const);

export type R1MeetRecallStatusEvent = (typeof R1_MEET_RECALL_STATUS_EVENTS)[number];
export type R1MeetRecallEventType = R1MeetRecallStatusEvent | RecallRealtimeEvent;
export type R1MeetRecallEndpoint = keyof typeof R1_MEET_RECALL_SUBPATHS;

/** Every reason `buildR1MeetRecallEventJob` declines a body. Frozen. */
export const R1_MEET_RECALL_EVENT_FAILURES = Object.freeze(['ignored_event', 'malformed_event'] as const);

export type R1MeetRecallEventFailure = (typeof R1_MEET_RECALL_EVENT_FAILURES)[number];

/** A participant of a real-time participant event: no name, email, platform or extra data. */
export type R1MeetRecallParticipant = {
  readonly id: number | null;
  readonly is_host: boolean | null;
  readonly is_bot: boolean | null;
};

/** The `recall_event` job payload (contract §2), in this exact key order. */
export type R1MeetRecallEventPayload = {
  readonly kind: 'recall_event';
  readonly event_type: R1MeetRecallEventType;
  readonly recall_bot_id: string;
  readonly booking_id: string | null;
  readonly occurred_at: string | null;
  readonly sub_code: string | null;
  readonly participant: R1MeetRecallParticipant | null;
};

export type R1MeetRecallEventJob =
  | {
      readonly ok: true;
      /** The receipt's event type (= `payload.event_type`). */
      readonly eventType: R1MeetRecallEventType;
      /** The receipt's booking id (= `payload.booking_id`). */
      readonly bookingId: string | null;
      readonly payload: R1MeetRecallEventPayload;
    }
  | { readonly ok: false; readonly reason: R1MeetRecallEventFailure };

const NO_EVENTS: readonly string[] = Object.freeze([]);

/**
 * The events each endpoint accepts; anything else is `ignored_event`. An unknown endpoint accepts
 * nothing. Frozen.
 */
export function r1MeetRecallEventsFor(endpoint: R1MeetRecallEndpoint): readonly string[] {
  if (endpoint === 'status') return R1_MEET_RECALL_STATUS_EVENTS;
  if (endpoint === 'realtime') return R1_MEET_REALTIME_EVENTS;
  return NO_EVENTS;
}

// ── Small validators ────────────────────────────────────────────────────────

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const SUB_CODE_RE = /^[A-Za-z0-9_.:-]{1,128}$/;

/** The components of a date-time `isRecallIsoDateTime` already accepted. */
const ISO_PARTS_RE =
  /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2}):(\d{2})(?:\.(\d{1,9}))?(?:Z|([+-])(\d{2}):(\d{2}))$/;
/** What `toISOString()` gives for a four-digit-year instant. */
const CANONICAL_ISO_RE = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/;

const IGNORED: R1MeetRecallEventJob = Object.freeze({ ok: false as const, reason: 'ignored_event' as const });
const MALFORMED: R1MeetRecallEventJob = Object.freeze({ ok: false as const, reason: 'malformed_event' as const });

function isPlainObject(value: unknown): value is Record<string, unknown> {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return false;
  const proto = Object.getPrototypeOf(value) as unknown;
  return proto === Object.prototype || proto === null;
}

function lowerUuid(value: unknown): string | null {
  return typeof value === 'string' && UUID_RE.test(value) ? value.toLowerCase() : null;
}

/**
 * The canonical `toISOString()` instant of a strict ISO-8601 date-time, or null. Built from the
 * components (a fraction beyond milliseconds is truncated, never rounded), so engine leniency never
 * widens it; an instant outside four-digit years is null.
 */
function canonicalInstant(value: unknown): string | null {
  if (!isRecallIsoDateTime(value)) return null;
  const m = ISO_PARTS_RE.exec(value);
  if (!m) return null;
  const millis = m[7] === undefined ? 0 : Number(m[7].slice(0, 3).padEnd(3, '0'));
  const date = new Date(0);
  date.setUTCFullYear(Number(m[1]), Number(m[2]) - 1, Number(m[3]));
  date.setUTCHours(Number(m[4]), Number(m[5]), Number(m[6]), millis);
  let ms = date.getTime();
  if (m[8] !== undefined) {
    const offsetMs = (Number(m[9]) * 60 + Number(m[10])) * 60_000;
    ms = m[8] === '+' ? ms - offsetMs : ms + offsetMs;
  }
  if (!Number.isFinite(ms)) return null;
  const iso = new Date(ms).toISOString();
  return CANONICAL_ISO_RE.test(iso) ? iso : null;
}

function participantOf(raw: unknown): R1MeetRecallParticipant {
  if (!isPlainObject(raw)) return Object.freeze({ id: null, is_host: null, is_bot: null });
  // Only these three fields are read: never the name, email, platform or extra data.
  const id = raw.id;
  const isHost = raw.is_host;
  const isBot = raw.is_bot;
  return Object.freeze({
    id: typeof id === 'number' && Number.isSafeInteger(id) && id >= 0 ? id + 0 : null,
    is_host: typeof isHost === 'boolean' ? isHost : null,
    is_bot: typeof isBot === 'boolean' ? isBot : null,
  });
}

// ── Builder ─────────────────────────────────────────────────────────────────

/**
 * The `recall_event` job for a verified Recall body received on `endpoint`, or why there is none.
 * Pure and frozen; never throws.
 */
export function buildR1MeetRecallEventJob(body: unknown, endpoint: R1MeetRecallEndpoint): R1MeetRecallEventJob {
  try {
    if (!isPlainObject(body)) return MALFORMED;
    const event = body.event;
    if (typeof event !== 'string') return MALFORMED;
    if (!r1MeetRecallEventsFor(endpoint).includes(event)) return IGNORED;
    const eventType = event as R1MeetRecallEventType;
    const participantEvent = (R1_MEET_REALTIME_EVENTS as readonly string[]).includes(event);

    const data = body.data;
    if (!isPlainObject(data)) return MALFORMED;
    const bot = data.bot;
    if (!isPlainObject(bot)) return MALFORMED;
    const recallBotId = lowerUuid(bot.id);
    if (recallBotId === null) return MALFORMED;

    const metadata = bot.metadata;
    const bookingId = isPlainObject(metadata) ? lowerUuid(metadata.booking_id) : null;

    const inner = isPlainObject(data.data) ? data.data : null;
    let occurredAt: string | null = null;
    let subCode: string | null = null;
    let participant: R1MeetRecallParticipant | null = null;
    if (participantEvent) {
      const timestamp = inner === null ? undefined : inner.timestamp;
      occurredAt = isPlainObject(timestamp) ? canonicalInstant(timestamp.absolute) : null;
      participant = participantOf(inner === null ? undefined : inner.participant);
    } else if (inner !== null) {
      occurredAt = canonicalInstant(inner.updated_at);
      const rawSubCode = inner.sub_code;
      subCode = typeof rawSubCode === 'string' && SUB_CODE_RE.test(rawSubCode) ? rawSubCode : null;
    }

    const payload: R1MeetRecallEventPayload = Object.freeze({
      kind: 'recall_event' as const,
      event_type: eventType,
      recall_bot_id: recallBotId,
      booking_id: bookingId,
      occurred_at: occurredAt,
      sub_code: subCode,
      participant,
    });
    return Object.freeze({ ok: true as const, eventType, bookingId, payload });
  } catch {
    return MALFORMED;
  }
}
