/**
 * The `r1-meet` job contract (M034 S06, dark; S09 and M035 S05/S11 add kinds): the
 * one queue name, the fourteen job kinds, a strict parser per kind, the dedup keys and attempts, and
 * the small shared vocabulary of the handlers (job facts, results, errors, the deferral bound). Nothing
 * here registers a queue, reads an environment variable or performs I/O.
 *
 * WHY ONE QUEUE WITH A `kind` (critic C8): every queue name costs one claim RPC per tick per machine,
 * even when idle, so all Meet work shares `r1-meet` and is told apart by its payload.
 *
 * WHO WRITES THE JOBS
 *  - `ashby_schedule` and `recall_event`: the webhook receivers (S03), through
 *    `r1_meet_record_receipt`, which adds `receipt_id` and `source` to the payload.
 *  - `bot_release` and `round_cancelled`: the 0142 triggers (and S06 for `bot_release`). The keys
 *    below are the trigger's own, so the two producers collapse on one live job.
 *  - `booking_rerun`, `ensure_bot`, `attempt_ended`, `bridge_check`, `multi_human_check` and
 *    `maintenance`: S06 itself, always through `r1MeetJobs`, so a payload and its key have one source.
 *  - `drain`: an operator's SQL insert (docs/runbooks/r1-operations.md).
 *  - `scorecard_feedback` (S09): the scorecard-ready trigger and the maintenance re-drive, through
 *    `r1_meet_record_receipt` (one receipt per booking and assessment, so `receipt_id` and `source`
 *    are added as for S03), or an operator's manual re-post, built by `r1MeetJobs.scorecardFeedback`.
 *    Its payload is ids only: `booking_id` and `assessment_id`.
 *  - `calendar_sync` (M035 S05, public-page bookings only): migration 0143 writes every one of them,
 *    with the keys and attempts below: the public create RPC (`invite`), the public move RPC (`move`,
 *    keyed by the move count after the move), the terminal trigger (`cancel`) and the delete trigger
 *    (`purge`); S05's public maintenance re-drives `invite`, `cancel` and `purge` through
 *    `r1MeetJobs.calendarSync`. Its payload is `{kind, op, booking_id}`: an op word and an id, never
 *    an email, a token or a Meet link.
 *  - `ashby_booked_tag` (M035 S11): migration 0143's public create RPC (`op: 'add'`) and its
 *    terminal-status trigger (`op: 'remove'`); `r1MeetJobs.ashbyBookedTag` builds the same payload for
 *    tests and an operator's re-drive. Ids and a closed op only; the handler treats `op` as a hint and
 *    converges from the database.
 *
 * PARSING. A payload is untrusted: it crossed a webhook, a trigger or an operator's keyboard. Each
 * parser reads the KNOWN keys of its kind and refuses (null) the whole job when any of them is absent
 * or is not exactly what the contract says: types, UUIDs, zoned instants, closed lists, the canonical
 * Meet URL. Unknown keys are ignored and never read, so an old worker survives a new producer. The
 * parsers never throw; the dispatcher turns a refusal into `r1_meet_malformed_payload`, which is
 * retried within its bound and then dead-lettered (a closed failure).
 *
 * What comes out is normalised so that the handlers compare plain strings: event, booking, bot,
 * round, session and assessment ids lower-cased (they are `uuid` columns), instants as `toISOString()`. The Ashby
 * schedule, application, stage, interview and scheduler ids stay VERBATIM: they are `text` columns
 * matched exactly (the application link table, 0142 §4 step 4).
 *
 * TWO RULES THAT GUARD THE RECONCILE. After its own action an `ashby_schedule` job cancels every live
 * booking of the schedule that its two id lists do not protect (D-S06-21). So an `event` job must carry
 * both lists, and (unless it says Dex is absent) must be in its own Dex list: without that, the job
 * would create a booking and cancel it in the same run. S03 builds no such job.
 *
 * PII: ids, kinds, times and closed words only. Only an `ashby_schedule` payload, which S06 never
 * writes, holds the Meet URL. No name, email, ticket or digest has a key here.
 */

import { normalizeGoogleMeetUrl } from '../../../integrations/google-meet/url.js';
import type { QueueJob } from '../../queue/types.js';
import {
  R1_MEET_ASHBY_MAX_EVENTS,
  R1_MEET_DEX_EVENT_DECISIONS,
  type R1MeetDexEventDecision,
} from './ashby-schedule.js';
import type { R1MeetBookingReason } from './bookings-read.js';
import { parseR1MeetInstant } from './ticket.js';

// ── The queue and its kinds ─────────────────────────────────────────────────

/** The ONE queue of R1 over Meet (0142 hard-codes the same name). */
export const R1_MEET_QUEUE = 'r1-meet' as const;

/**
 * Every job kind this build handles, frozen. Contracts section 5 fixes the appended order:
 * `scorecard_feedback`, then M035 S05 `calendar_sync`, then S11 `ashby_booked_tag` last.
 */
export const R1_MEET_JOB_KINDS = Object.freeze([
  'ashby_schedule',
  'recall_event',
  'bot_release',
  'round_cancelled',
  'booking_rerun',
  'ensure_bot',
  'attempt_ended',
  'bridge_check',
  'multi_human_check',
  'maintenance',
  'drain',
  'scorecard_feedback',
  'calendar_sync',
  'ashby_booked_tag',
] as const);
export type R1MeetJobKind = (typeof R1_MEET_JOB_KINDS)[number];

/**
 * Attempts per kind. The first two are fixed by `r1_meet_record_receipt` (0142 §18), the next two by
 * the 0142 triggers (whose `bot_release` S06 also writes), `drain` by the runbook's SQL,
 * `scorecard_feedback` again by `r1_meet_record_receipt` (0142:1818), which writes it, and
 * `calendar_sync` by migration 0143. Frozen.
 */
export const R1_MEET_JOB_MAX_ATTEMPTS: Readonly<Record<R1MeetJobKind, number>> = Object.freeze({
  ashby_schedule: 5,
  recall_event: 5,
  bot_release: 10,
  round_cancelled: 10,
  booking_rerun: 10,
  ensure_bot: 10,
  attempt_ended: 10,
  bridge_check: 10,
  multi_human_check: 10,
  maintenance: 3,
  drain: 10,
  // Fixed by r1_meet_record_receipt (0142:1818): the job it inserts always has max_attempts 5.
  scorecard_feedback: 5,
  // Fixed by 0143: the create and move RPCs and both triggers insert 10.
  calendar_sync: 10,
  // Fixed by 0143: the create RPC and the terminal trigger insert 10.
  ashby_booked_tag: 10,
});

/** The Recall events a `recall_event` job may carry: nine bot statuses and two participant events. Frozen. */
export const R1_MEET_RECALL_BOT_EVENTS = Object.freeze([
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
export const R1_MEET_RECALL_PARTICIPANT_EVENTS = Object.freeze([
  'participant_events.join',
  'participant_events.leave',
] as const);
export type R1MeetRecallBotEvent = (typeof R1_MEET_RECALL_BOT_EVENTS)[number];
export type R1MeetRecallParticipantEvent = (typeof R1_MEET_RECALL_PARTICIPANT_EVENTS)[number];

/** The decisions a `schedule` job may carry: no event of that schedule has Dex any more. Frozen. */
export const R1_MEET_SCHEDULE_SCOPE_DECISIONS = Object.freeze(['cancelled', 'dex_absent'] as const);
export type R1MeetScheduleScopeDecision = (typeof R1_MEET_SCHEDULE_SCOPE_DECISIONS)[number];

/**
 * The four operations of a `calendar_sync` job on Lexy's calendar event of a public booking (M035 S05):
 * send the invite, move the event, cancel it before its slot, purge it after retention or a delete.
 * Frozen.
 */
export const R1_MEET_CALENDAR_OPS = Object.freeze(['invite', 'move', 'cancel', 'purge'] as const);
export type R1MeetCalendarOp = (typeof R1_MEET_CALENDAR_OPS)[number];
/** `chk_r1_meet_bookings_move_count` (0143): a move job's counter is the count after its move. */
export const R1_MEET_MAX_MOVE_COUNT = 10;
/** What an `ashby_booked_tag` job asks for (M035 S11): a hint only, the handler converges. Frozen. */
export const R1_MEET_ASHBY_TAG_OPS = Object.freeze(['add', 'remove'] as const);
export type R1MeetAshbyTagOp = (typeof R1_MEET_ASHBY_TAG_OPS)[number];

/** The booking reasons a delayed re-run may be about (D-S06-18). Frozen. */
export const R1_MEET_RERUN_REASONS = Object.freeze([
  'slot_too_far',
  'application_unknown',
  'capacity_exhausted',
  'paused',
  'disabled',
  'round_active',
  'phone_engagement_active',
  'phone_assessment_pending',
] as const satisfies readonly R1MeetBookingReason[]);
export type R1MeetRerunReason = (typeof R1_MEET_RERUN_REASONS)[number];
/** A re-run counter beyond this is not one S06 wrote. */
export const R1_MEET_RERUN_MAX_N = 100;

/** 0142 `chk_r1_meet_bookings_version` and `chk_r1_meet_bookings_ticket_arms`. */
export const R1_MEET_MAX_VERSION = 50;
export const R1_MEET_MAX_TICKET_ARMS = 5;

// ── Parsed jobs ─────────────────────────────────────────────────────────────

interface R1MeetAshbyEventBase {
  readonly kind: 'ashby_schedule';
  readonly scope: 'event';
  /** Lower-cased. */
  readonly eventId: string;
  readonly scheduleId: string;
  readonly applicationId: string;
  readonly interviewStageId: string | null;
  readonly interviewId: string | null;
  /** The S01 ordering key, or null when Ashby sent no `updatedAt` (then receipt order counts). */
  readonly ashbyUpdatedAt: string | null;
  readonly receivedAt: string | null;
  readonly startAt: string;
  readonly endAt: string;
  /** Every event of the schedule, lower-cased, and the subset with Dex. Reconcile only. */
  readonly scheduleEventIds: readonly string[];
  readonly dexEventIds: readonly string[];
}

/** One Dex interview event. `eligible` always has its Meet URL and its scheduler (the attester). */
export type R1MeetAshbyEventJob = R1MeetAshbyEventBase &
  (
    | { readonly decision: 'eligible'; readonly meetUrl: string; readonly scheduledByUserId: string }
    | {
        readonly decision: Exclude<R1MeetDexEventDecision, 'eligible'>;
        readonly meetUrl: string | null;
        readonly scheduledByUserId: string | null;
      }
  );

/**
 * The whole schedule: no event of it has Dex. It carries no candidate-linked id (S03 fix round), so
 * none is read here even if one is sent. Null lists = an identity job (the schedule was cancelled and
 * its events were unreadable).
 */
export interface R1MeetAshbyWholeScheduleJob {
  readonly kind: 'ashby_schedule';
  readonly scope: 'schedule';
  readonly scheduleId: string;
  readonly ashbyUpdatedAt: string | null;
  readonly receivedAt: string | null;
  readonly decision: R1MeetScheduleScopeDecision;
  readonly scheduleEventIds: readonly string[] | null;
  readonly dexEventIds: readonly string[] | null;
}

export type R1MeetAshbyScheduleJob = R1MeetAshbyEventJob | R1MeetAshbyWholeScheduleJob;

/**
 * A participant of a real-time event. `isBot` is true when Recall itself says bot, or when the receiver
 * found that the display name is this bot's own (M035 S09; the name is never kept); null when neither
 * is known, the usual value for a person.
 */
export interface R1MeetParticipant {
  readonly id: number | null;
  readonly isHost: boolean | null;
  readonly isBot: boolean | null;
}

interface R1MeetRecallEventBase {
  readonly kind: 'recall_event';
  readonly recallBotId: string;
  readonly bookingId: string | null;
  readonly occurredAt: string | null;
  readonly subCode: string | null;
}

export type R1MeetRecallEventJob = R1MeetRecallEventBase &
  (
    | { readonly eventType: R1MeetRecallBotEvent; readonly participant: null }
    | { readonly eventType: R1MeetRecallParticipantEvent; readonly participant: R1MeetParticipant }
  );

export interface R1MeetBotReleaseJob {
  readonly kind: 'bot_release';
  readonly recallBotId: string;
  readonly bookingId: string;
}
export interface R1MeetRoundCancelledJob {
  readonly kind: 'round_cancelled';
  readonly bookingId: string;
  readonly roundId: string;
}
export interface R1MeetBookingRerunJob {
  readonly kind: 'booking_rerun';
  readonly bookingId: string;
  readonly reason: R1MeetRerunReason;
  readonly n: number;
}
export interface R1MeetEnsureBotJob {
  readonly kind: 'ensure_bot';
  readonly bookingId: string;
}
export interface R1MeetAttemptEndedJob {
  readonly kind: 'attempt_ended';
  readonly bookingId: string;
  readonly sessionId: string;
}
export interface R1MeetBridgeCheckJob {
  readonly kind: 'bridge_check';
  readonly bookingId: string;
  /** The bot generation and the arm (`ticket_arms` after it) this check is about. */
  readonly version: number;
  readonly arm: number;
}
export interface R1MeetMultiHumanCheckJob {
  readonly kind: 'multi_human_check';
  readonly bookingId: string;
  readonly version: number;
}
export interface R1MeetMaintenanceJob {
  readonly kind: 'maintenance';
  readonly bucket: number;
}
export interface R1MeetDrainJob {
  readonly kind: 'drain';
  /** Also drain a booking whose bound session is still live. */
  readonly force: boolean;
}
/** Post Dex's scorecard of this assessment to Ashby as the booking's interview feedback (S09). */
export interface R1MeetScorecardFeedbackJob {
  readonly kind: 'scorecard_feedback';
  /** Lower-cased. */
  readonly bookingId: string;
  /** Lower-cased. */
  readonly assessmentId: string;
}
/** Keep Lexy's calendar event of one public booking in step with it (M035 S05). */
export interface R1MeetCalendarSyncJob {
  readonly kind: 'calendar_sync';
  readonly op: R1MeetCalendarOp;
  readonly bookingId: string;
}

/** Converge the "Lexy R1: Booked" tag of this public booking's Ashby candidate (M035 S11). */
export interface R1MeetAshbyBookedTagJob {
  readonly kind: 'ashby_booked_tag';
  /** A hint: the handler computes the wanted state from the database. */
  readonly op: R1MeetAshbyTagOp;
  /** Lower-cased. */
  readonly bookingId: string;
}

export interface R1MeetJobByKind {
  readonly ashby_schedule: R1MeetAshbyScheduleJob;
  readonly recall_event: R1MeetRecallEventJob;
  readonly bot_release: R1MeetBotReleaseJob;
  readonly round_cancelled: R1MeetRoundCancelledJob;
  readonly booking_rerun: R1MeetBookingRerunJob;
  readonly ensure_bot: R1MeetEnsureBotJob;
  readonly attempt_ended: R1MeetAttemptEndedJob;
  readonly bridge_check: R1MeetBridgeCheckJob;
  readonly multi_human_check: R1MeetMultiHumanCheckJob;
  readonly maintenance: R1MeetMaintenanceJob;
  readonly drain: R1MeetDrainJob;
  readonly scorecard_feedback: R1MeetScorecardFeedbackJob;
  readonly calendar_sync: R1MeetCalendarSyncJob;
  readonly ashby_booked_tag: R1MeetAshbyBookedTagJob;
}

/** A parser of one kind: the frozen job, or null for anything else. Never throws. */
export type R1MeetJobParser<T> = (payload: unknown) => T | null;

// ── Field readers: each returns the value or refuses the whole job ───────────

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
/** The rule of `r1_meet_record_receipt` for `payload.kind`. */
const KIND = /^[a-z][a-z0-9_]{0,39}$/;
/** S03's sub-code rule. Never an enum: Recall adds sub-codes at will. */
const SUB_CODE = /^[A-Za-z0-9_.:-]{1,128}$/;

/** Caught by `parserOf`, which answers null: no text of it ever leaves this module. */
function refuse(): never {
  throw new Error('refused');
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return false;
  const proto = Object.getPrototypeOf(value) as unknown;
  return proto === Object.prototype || proto === null;
}

/** An Ashby id kept as sent: the DB columns are `text` and matched exactly. */
function verbatimUuid(value: unknown): string {
  return typeof value === 'string' && UUID.test(value) ? value : refuse();
}

/** An id of a `uuid` column, lower-cased. */
function uuid(value: unknown): string {
  return verbatimUuid(value).toLowerCase();
}

/** Only null is null: an ABSENT key is a malformed job, because every producer writes every key. */
function orNull<T>(value: unknown, readValue: (value: unknown) => T): T | null {
  return value === null ? null : readValue(value);
}

/** A zoned instant, as `toISOString()`. */
function instant(value: unknown): string {
  const ms = parseR1MeetInstant(value);
  return ms === null ? refuse() : new Date(ms).toISOString();
}

function integer(value: unknown, min: number, max: number): number {
  return typeof value === 'number' && Number.isSafeInteger(value) && value >= min && value <= max ? value : refuse();
}

function boolean(value: unknown): boolean {
  return typeof value === 'boolean' ? value : refuse();
}

function oneOf<T extends string>(value: unknown, allowed: readonly T[]): T {
  return allowed.find((candidate) => candidate === value) ?? refuse();
}

function canonicalMeetUrl(value: unknown): string {
  return typeof value === 'string' && normalizeGoogleMeetUrl(value) === value ? value : refuse();
}

function eventIdList(value: unknown): readonly string[] {
  if (!Array.isArray(value) || value.length > R1_MEET_ASHBY_MAX_EVENTS) return refuse();
  return Array.from(value as readonly unknown[], uuid);
}

function subCode(value: unknown): string {
  return typeof value === 'string' && SUB_CODE.test(value) ? value : refuse();
}

function participant(value: unknown): R1MeetParticipant {
  if (!isPlainObject(value)) return refuse();
  return {
    id: orNull(value.id, (id) => integer(id, 0, Number.MAX_SAFE_INTEGER)),
    isHost: orNull(value.is_host, boolean),
    isBot: orNull(value.is_bot, boolean),
  };
}

function deepFreeze<T>(value: T): T {
  if (typeof value === 'object' && value !== null && !Object.isFrozen(value)) {
    for (const child of Object.values(value)) deepFreeze(child);
    Object.freeze(value);
  }
  return value;
}

/** A parser that refuses (null) anything but a plain object of `kind` that `read` accepts. */
function parserOf<K extends R1MeetJobKind>(
  kind: K,
  read: (fields: Record<string, unknown>) => R1MeetJobByKind[K],
): R1MeetJobParser<R1MeetJobByKind[K]> {
  return (payload) => {
    try {
      if (!isPlainObject(payload) || payload.kind !== kind) return null;
      return deepFreeze(read(payload));
    } catch {
      // A refusal, or a throwing getter: not a job either way.
      return null;
    }
  };
}

// ── One parser per kind ─────────────────────────────────────────────────────

function readEventScope(fields: Record<string, unknown>): R1MeetAshbyEventJob {
  const eventId = uuid(fields.ashby_interview_event_id);
  const decision = oneOf(fields.decision, R1_MEET_DEX_EVENT_DECISIONS);
  const startAt = instant(fields.start_at);
  const endAt = instant(fields.end_at);
  if (Date.parse(endAt) <= Date.parse(startAt)) refuse();
  const meetUrl = orNull(fields.meet_url, canonicalMeetUrl);
  const scheduledByUserId = orNull(fields.ashby_scheduled_by_user_id, verbatimUuid);
  const scheduleEventIds = eventIdList(fields.ashby_schedule_event_ids);
  const dexEventIds = eventIdList(fields.ashby_dex_event_ids);
  // See the header: a job outside its own Dex list would cancel what it just created.
  if (decision !== 'dex_absent' && !dexEventIds.includes(eventId)) refuse();
  const base: R1MeetAshbyEventBase = {
    kind: 'ashby_schedule',
    scope: 'event',
    eventId,
    scheduleId: verbatimUuid(fields.ashby_schedule_id),
    applicationId: verbatimUuid(fields.ashby_application_id),
    interviewStageId: orNull(fields.ashby_interview_stage_id, verbatimUuid),
    interviewId: orNull(fields.ashby_interview_id, verbatimUuid),
    ashbyUpdatedAt: orNull(fields.ashby_updated_at, instant),
    receivedAt: orNull(fields.received_at, instant),
    startAt,
    endAt,
    scheduleEventIds,
    dexEventIds,
  };
  if (decision !== 'eligible') return { ...base, decision, meetUrl, scheduledByUserId };
  if (meetUrl === null || scheduledByUserId === null) return refuse();
  return { ...base, decision, meetUrl, scheduledByUserId };
}

function readScheduleScope(fields: Record<string, unknown>): R1MeetAshbyWholeScheduleJob {
  // The event's own fields have no meaning here, so a value in one is a contradictory job.
  for (const key of ['ashby_interview_event_id', 'ashby_interview_id', 'start_at', 'end_at', 'meet_url']) {
    if (fields[key] !== null) refuse();
  }
  // Checked, then dropped: a schedule job may concern a human-only interview (S03 data minimisation).
  for (const key of ['ashby_application_id', 'ashby_interview_stage_id', 'ashby_scheduled_by_user_id']) {
    orNull(fields[key], verbatimUuid);
  }
  const scheduleEventIds = orNull(fields.ashby_schedule_event_ids, eventIdList);
  const dexEventIds = orNull(fields.ashby_dex_event_ids, eventIdList);
  if ((scheduleEventIds === null) !== (dexEventIds === null)) refuse();
  return {
    kind: 'ashby_schedule',
    scope: 'schedule',
    scheduleId: verbatimUuid(fields.ashby_schedule_id),
    ashbyUpdatedAt: orNull(fields.ashby_updated_at, instant),
    receivedAt: orNull(fields.received_at, instant),
    decision: oneOf(fields.decision, R1_MEET_SCHEDULE_SCOPE_DECISIONS),
    scheduleEventIds,
    dexEventIds,
  };
}

export const parseAshbyScheduleJob = parserOf('ashby_schedule', (fields) =>
  oneOf(fields.scope, ['event', 'schedule'] as const) === 'event' ? readEventScope(fields) : readScheduleScope(fields),
);

export const parseRecallEventJob = parserOf('recall_event', (fields) => {
  const base: R1MeetRecallEventBase = {
    kind: 'recall_event',
    recallBotId: uuid(fields.recall_bot_id),
    bookingId: orNull(fields.booking_id, uuid),
    occurredAt: orNull(fields.occurred_at, instant),
    subCode: orNull(fields.sub_code, subCode),
  };
  const participantEvent = R1_MEET_RECALL_PARTICIPANT_EVENTS.find((event) => event === fields.event_type);
  if (participantEvent !== undefined) {
    return { ...base, eventType: participantEvent, participant: participant(fields.participant) };
  }
  if (fields.participant !== null) refuse();
  return { ...base, eventType: oneOf(fields.event_type, R1_MEET_RECALL_BOT_EVENTS), participant: null };
});

export const parseBotReleaseJob = parserOf('bot_release', (fields) => ({
  kind: 'bot_release',
  recallBotId: uuid(fields.recall_bot_id),
  bookingId: uuid(fields.booking_id),
}));

export const parseRoundCancelledJob = parserOf('round_cancelled', (fields) => ({
  kind: 'round_cancelled',
  bookingId: uuid(fields.booking_id),
  roundId: uuid(fields.round_id),
}));

export const parseBookingRerunJob = parserOf('booking_rerun', (fields) => ({
  kind: 'booking_rerun',
  bookingId: uuid(fields.booking_id),
  reason: oneOf(fields.reason, R1_MEET_RERUN_REASONS),
  n: integer(fields.n, 0, R1_MEET_RERUN_MAX_N),
}));

export const parseEnsureBotJob = parserOf('ensure_bot', (fields) => ({
  kind: 'ensure_bot',
  bookingId: uuid(fields.booking_id),
}));

export const parseAttemptEndedJob = parserOf('attempt_ended', (fields) => ({
  kind: 'attempt_ended',
  bookingId: uuid(fields.booking_id),
  sessionId: uuid(fields.session_id),
}));

export const parseBridgeCheckJob = parserOf('bridge_check', (fields) => ({
  kind: 'bridge_check',
  bookingId: uuid(fields.booking_id),
  version: integer(fields.version, 0, R1_MEET_MAX_VERSION),
  arm: integer(fields.arm, 1, R1_MEET_MAX_TICKET_ARMS),
}));

export const parseMultiHumanCheckJob = parserOf('multi_human_check', (fields) => ({
  kind: 'multi_human_check',
  bookingId: uuid(fields.booking_id),
  version: integer(fields.version, 0, R1_MEET_MAX_VERSION),
}));

export const parseMaintenanceJob = parserOf('maintenance', (fields) => ({
  kind: 'maintenance',
  bucket: integer(fields.bucket, 0, Number.MAX_SAFE_INTEGER),
}));

/** `force` is the one optional key: the runbook's plain drain is `{"kind":"drain"}`. */
export const parseDrainJob = parserOf('drain', (fields) => ({
  kind: 'drain',
  force: fields.force === undefined ? false : boolean(fields.force),
}));

/** Ids only. The `receipt_id` and `source` that `r1_meet_record_receipt` adds are not read here. */
export const parseScorecardFeedbackJob = parserOf('scorecard_feedback', (fields) => ({
  kind: 'scorecard_feedback',
  bookingId: uuid(fields.booking_id),
  assessmentId: uuid(fields.assessment_id),
}));

/**
 * The op (exactly one of the four lower-case words) and the booking id. The move count is in the dedup
 * key only, never in the payload (0143), so nothing else is read.
 */
export const parseCalendarSyncJob = parserOf('calendar_sync', (fields) => ({
  kind: 'calendar_sync',
  op: oneOf(fields.op, R1_MEET_CALENDAR_OPS),
  bookingId: uuid(fields.booking_id),
}));

/** Ids and a closed op only (M035 S11): `op` is exactly `add` or `remove`, case-sensitive. */
export const parseAshbyBookedTagJob = parserOf('ashby_booked_tag', (fields) => ({
  kind: 'ashby_booked_tag',
  op: oneOf(fields.op, R1_MEET_ASHBY_TAG_OPS),
  bookingId: uuid(fields.booking_id),
}));

/** Every parser, by kind. Frozen. */
export const R1_MEET_JOB_PARSERS: { readonly [K in R1MeetJobKind]: R1MeetJobParser<R1MeetJobByKind[K]> } =
  Object.freeze({
    ashby_schedule: parseAshbyScheduleJob,
    recall_event: parseRecallEventJob,
    bot_release: parseBotReleaseJob,
    round_cancelled: parseRoundCancelledJob,
    booking_rerun: parseBookingRerunJob,
    ensure_bot: parseEnsureBotJob,
    attempt_ended: parseAttemptEndedJob,
    bridge_check: parseBridgeCheckJob,
    multi_human_check: parseMultiHumanCheckJob,
    maintenance: parseMaintenanceJob,
    drain: parseDrainJob,
    scorecard_feedback: parseScorecardFeedbackJob,
    calendar_sync: parseCalendarSyncJob,
    ashby_booked_tag: parseAshbyBookedTagJob,
  });

/** The `kind` a payload names (it need not be one this build knows), or null. Never throws. */
export function r1MeetPayloadKind(payload: unknown): string | null {
  try {
    if (!isPlainObject(payload)) return null;
    const kind = payload.kind;
    return typeof kind === 'string' && KIND.test(kind) ? kind : null;
  } catch {
    return null;
  }
}

/**
 * The receipt a job must finish (`r1_meet_record_receipt` put it there), or null. Read apart from the
 * parsers, so that a job that fails to parse can still mark its receipt failed. Never throws.
 */
export function r1MeetReceiptId(payload: unknown): string | null {
  try {
    if (!isPlainObject(payload)) return null;
    const id = payload.receipt_id;
    return typeof id === 'string' && UUID.test(id) ? id.toLowerCase() : null;
  } catch {
    return null;
  }
}

// ── Dedup keys and the jobs S06 writes ──────────────────────────────────────

/**
 * The dedup keys. `uq_job_queue_dedup_active` (0009) is partial over LIVE jobs, so a key only stops a
 * second job while the first is pending, active or delayed. Ids are lower-cased because the 0142
 * triggers write `uuid::text`. Frozen.
 */
export const r1MeetDedupKeys = Object.freeze({
  botRelease: (recallBotId: string): string => `r1-meet:bot-release:${recallBotId.toLowerCase()}`,
  roundCancelled: (bookingId: string): string => `r1-meet:round-cancelled:${bookingId.toLowerCase()}`,
  rerun: (bookingId: string, atMs: number): string => `r1-meet:rerun:${bookingId.toLowerCase()}:${Math.trunc(atMs)}`,
  ensureBot: (bookingId: string): string => `r1-meet:ensure-bot:${bookingId.toLowerCase()}`,
  attemptEnded: (sessionId: string): string => `r1-meet:attempt-ended:${sessionId.toLowerCase()}`,
  bridgeCheck: (bookingId: string, version: number, arm: number): string =>
    `r1-meet:bridge-check:${bookingId.toLowerCase()}:v${version}:a${arm}`,
  multiHuman: (bookingId: string, version: number): string =>
    `r1-meet:multi-human:${bookingId.toLowerCase()}:v${version}`,
  maintenance: (bucket: number): string => `r1-meet:maintenance:${bucket}`,
  drain: (): string => 'r1-meet:drain',
  /** A manual re-post (S09). The trigger's own jobs carry the receipt's key, `r1-meet:receipt:<id>`. */
  scorecardFeedback: (bookingId: string, assessmentId: string): string =>
    `r1-meet:scorecard-feedback:${bookingId.toLowerCase()}:${assessmentId.toLowerCase()}`,
  /**
   * M035 S05: the keys 0143 prints, `'r1-meet:calendar:' || id::text || ':<op>'`, and for a move
   * `':move:' || move_count::text` (the count after that move), so every move is its own job.
   */
  calendarSync: (bookingId: string, op: R1MeetCalendarOp, moveCount?: number): string =>
    `r1-meet:calendar:${bookingId.toLowerCase()}:${op}${op === 'move' ? `:${String(moveCount)}` : ''}`,
  /** M035 S11: one live job per booking and op; 0143 prints the same key from `uuid::text`. */
  ashbyBookedTag: (bookingId: string, op: R1MeetAshbyTagOp): string =>
    `r1-meet:ashby-tag:${bookingId.toLowerCase()}:${op}`,
});

/** What to hand the queue for one job: ids, kinds, counters and times only. */
export interface R1MeetJobSpec {
  readonly payload: Readonly<Record<string, string | number>> & { readonly kind: R1MeetJobKind };
  readonly dedupKey: string;
  readonly maxAttempts: number;
}

function spec(payload: R1MeetJobSpec['payload'], dedupKey: string): R1MeetJobSpec {
  return Object.freeze({
    payload: Object.freeze(payload),
    dedupKey,
    maxAttempts: R1_MEET_JOB_MAX_ATTEMPTS[payload.kind],
  });
}

/** The jobs S06 enqueues itself. Each payload parses back through its own parser. Frozen. */
export const r1MeetJobs = Object.freeze({
  botRelease: (recallBotId: string, bookingId: string): R1MeetJobSpec =>
    spec(
      { kind: 'bot_release', recall_bot_id: recallBotId, booking_id: bookingId },
      r1MeetDedupKeys.botRelease(recallBotId),
    ),
  /** `atMs`: when it is scheduled to run; part of the key, so each planned re-run is its own job. */
  bookingRerun: (bookingId: string, reason: R1MeetRerunReason, n: number, atMs: number): R1MeetJobSpec =>
    spec({ kind: 'booking_rerun', booking_id: bookingId, reason, n }, r1MeetDedupKeys.rerun(bookingId, atMs)),
  ensureBot: (bookingId: string): R1MeetJobSpec =>
    spec({ kind: 'ensure_bot', booking_id: bookingId }, r1MeetDedupKeys.ensureBot(bookingId)),
  attemptEnded: (bookingId: string, sessionId: string): R1MeetJobSpec =>
    spec(
      { kind: 'attempt_ended', booking_id: bookingId, session_id: sessionId },
      r1MeetDedupKeys.attemptEnded(sessionId),
    ),
  bridgeCheck: (bookingId: string, version: number, arm: number): R1MeetJobSpec =>
    spec(
      { kind: 'bridge_check', booking_id: bookingId, version, arm },
      r1MeetDedupKeys.bridgeCheck(bookingId, version, arm),
    ),
  multiHumanCheck: (bookingId: string, version: number): R1MeetJobSpec =>
    spec(
      { kind: 'multi_human_check', booking_id: bookingId, version },
      r1MeetDedupKeys.multiHuman(bookingId, version),
    ),
  maintenance: (bucket: number): R1MeetJobSpec =>
    spec({ kind: 'maintenance', bucket }, r1MeetDedupKeys.maintenance(bucket)),
  /** S09: the operator's manual re-post (runbook) and tests. Ids only. */
  scorecardFeedback: (bookingId: string, assessmentId: string): R1MeetJobSpec =>
    spec(
      { kind: 'scorecard_feedback', booking_id: bookingId, assessment_id: assessmentId },
      r1MeetDedupKeys.scorecardFeedback(bookingId, assessmentId),
    ),
  /**
   * M035 S05: the job 0143 writes, in 0143's `jsonb_build_object` key order (kind, op, booking_id), for
   * the public maintenance re-drives and tests. A `move` needs its move count (a safe integer 1..10,
   * the count after the move); any other op takes none. A wrong count is a `TypeError`: a caller bug.
   */
  calendarSync: (op: R1MeetCalendarOp, bookingId: string, moveCount?: number): R1MeetJobSpec => {
    if (op === 'move') {
      if (
        typeof moveCount !== 'number'
        || !Number.isSafeInteger(moveCount)
        || moveCount < 1
        || moveCount > R1_MEET_MAX_MOVE_COUNT
      ) {
        throw new TypeError('r1_meet_calendar_move_count');
      }
    } else if (moveCount !== undefined) {
      throw new TypeError('r1_meet_calendar_move_count');
    }
    return spec(
      { kind: 'calendar_sync', op, booking_id: bookingId },
      r1MeetDedupKeys.calendarSync(bookingId, op, moveCount),
    );
  },
  /** M035 S11: tests and an operator's re-drive. The key order is 0143's `jsonb_build_object`. */
  ashbyBookedTag: (op: R1MeetAshbyTagOp, bookingId: string): R1MeetJobSpec =>
    spec({ kind: 'ashby_booked_tag', op, booking_id: bookingId }, r1MeetDedupKeys.ashbyBookedTag(bookingId, op)),
});

// ── Job facts, results, errors and the deferral bound ───────────────────────

/** The facts of the claimed job a handler may act on. Never the lease token, the dedup key or the id. */
export interface R1MeetJobMeta {
  /** Including this run: a claim is a delivery (0028). A deferral refunds its attempt (0037). */
  readonly attempts: number;
  readonly maxAttempts: number;
  readonly deferCount: number;
  /** Start of the current deferral streak, or null. */
  readonly deferredAt: string | null;
  readonly createdAt: string;
  /** An earlier run of this same job may have done part of its work. */
  readonly isRerun: boolean;
  /** A throw now dead-letters the job (`fail_job`: attempts >= max_attempts). */
  readonly finalAttempt: boolean;
  /**
   * The reason code of the deferral that ended the PREVIOUS run, or null. The queue keeps
   * `defer_reason` from `defer_job` until the next non-deferral outcome (`complete_job` and
   * `fail_job` clear it, a claim does not: 0037). S09.
   */
  readonly lastDeferReason: string | null;
  /**
   * The closed code the PREVIOUS run threw, or null. The queue keeps `error_message` from `fail_job`
   * until the next deferral (`defer_job` clears it, a claim does not: 0028, 0037). S09.
   */
  readonly lastError: string | null;
}

/** The shape a queue reason or error code has (0037 `chk_job_queue_defer_reason`); anything else is null. */
const QUEUE_CODE = /^[a-z0-9_.:-]{1,64}$/;

function queueCode(value: unknown): string | null {
  return typeof value === 'string' && QUEUE_CODE.test(value) ? value : null;
}

export function r1MeetJobMeta(
  job: Pick<
    QueueJob<unknown>,
    'attempts' | 'maxAttempts' | 'deferCount' | 'deferredAt' | 'createdAt' | 'deferReason' | 'errorMessage'
  >,
): R1MeetJobMeta {
  const deferCount = typeof job.deferCount === 'number' ? job.deferCount : 0;
  return Object.freeze({
    attempts: job.attempts,
    maxAttempts: job.maxAttempts,
    deferCount,
    deferredAt: job.deferredAt ?? null,
    createdAt: job.createdAt,
    isRerun: job.attempts > 1 || deferCount > 0,
    finalAttempt: job.attempts >= job.maxAttempts,
    lastDeferReason: queueCode(job.deferReason),
    lastError: queueCode(job.errorMessage),
  });
}

/**
 * What a handler answers. `done` ends the job (and its receipt as `receipt` says); `defer` waits and
 * refunds the attempt, so it must stay within `canDeferR1MeetJob`. Codes are closed lower-case words:
 * they reach a log line and, for a deferral, `job_queue.defer_reason`.
 */
export type R1MeetJobResult =
  | { readonly outcome: 'done'; readonly receipt: 'processed' | 'ignored'; readonly code: string }
  | { readonly outcome: 'defer'; readonly code: string; readonly delaySeconds: number };

export const r1MeetProcessed = (code: string): R1MeetJobResult =>
  Object.freeze({ outcome: 'done' as const, receipt: 'processed' as const, code });
export const r1MeetIgnored = (code: string): R1MeetJobResult =>
  Object.freeze({ outcome: 'done' as const, receipt: 'ignored' as const, code });
export const r1MeetDefer = (code: string, delaySeconds: number): R1MeetJobResult =>
  Object.freeze({ outcome: 'defer' as const, code, delaySeconds });

export const R1_MEET_MALFORMED_PAYLOAD = 'r1_meet_malformed_payload';
export const R1_MEET_UNKNOWN_KIND = 'r1_meet_unknown_kind';
export const R1_MEET_DB_ERROR = 'r1_meet_db_error';
export const R1_MEET_RPC_UNEXPECTED = 'r1_meet_rpc_unexpected';

/**
 * A failed job, as one closed code. The message IS the code and nothing else: the queue runner
 * persists it (`sanitizeErrorCode`), so no id, URL, driver text or vendor body may ever be in it.
 */
export class R1MeetJobError extends Error {
  readonly code: string;

  constructor(code: string) {
    super(code);
    this.name = 'R1MeetJobError';
    this.code = code;
  }
}

/** The bound of a transient wait (the numbers of the recording lane, `../recording/handlers.ts`). */
export const R1_MEET_DEFER_MAX_COUNT = 30;
export const R1_MEET_DEFER_MAX_MS = 60 * 60 * 1000;

/** May this job still be deferred? Both bounds come from the job's own columns. */
export function canDeferR1MeetJob(meta: Pick<R1MeetJobMeta, 'deferCount' | 'deferredAt'>, nowMs: number): boolean {
  if (meta.deferCount >= R1_MEET_DEFER_MAX_COUNT) return false;
  const since = meta.deferredAt === null ? Number.NaN : Date.parse(meta.deferredAt);
  return !Number.isFinite(since) || nowMs - since < R1_MEET_DEFER_MAX_MS;
}
