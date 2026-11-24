/**
 * lib/r1/meet/ashby-schedule-jobs.ts — turns a verified Ashby `interviewScheduleCreate` /
 * `interviewScheduleUpdate` webhook body into the `ashby_schedule` jobs of the `r1-meet` queue, and
 * records them through the receipt port (M034 S03, dark).
 *
 * The route (`routes/ashby-webhook.ts`, S03 T4) calls `ingestR1MeetAshbySchedule` only when R1 over
 * Google Meet is on; with the flag off the two actions keep today's generic path. The body is parsed
 * with the S01 parser (`parseR1MeetAshbyScheduleWebhook`) and every Dex event is decided with the S01
 * selector (`selectR1MeetDexEvents`), both used as-is.
 *
 * The forwarding table (S03 plan R9). Let D = the parsed events whose interviewers include Dex.
 *  (a) D not empty → one `event` job per Dex event, in `schedule.events` order, with `decision` = the
 *      selector's decision.
 *  (b) D empty, Create → no job: 200 `r1_meet_no_dex_event` (a new schedule has no booking).
 *  (c) D empty, Update, status `Cancelled` → one `schedule` job, decision `cancelled`.
 *  (d) D empty, Update, otherwise → one `schedule` job, decision `dex_absent`, always. There is NO
 *      "long settled" exception (fix round S03-R2): an Update carries only the events that are still in
 *      the schedule, so when HR deletes a future Dex event from a schedule whose remaining events are
 *      in the past, this job is the only signal S06 gets (`event_removed`). A removed event's time is
 *      not in the payload, so no rule over the remaining events can prove that no bot belongs to the
 *      schedule. The price is one cheap job per Dex-less Update (S06 finds no live booking and ignores
 *      it).
 *  (e) Parse refused, `identity.status === 'Cancelled'` → one `schedule` job, decision `cancelled`,
 *      with every field null except the schedule id and its `updatedAt`.
 *  (f) Any other refusal → 400 with the S01 reason (closed set) and no RPC.
 *
 * Why non-Dex Updates are forwarded (this widens "non-Dex events are skipped" on purpose): removing
 * Dex is destructive (S01: `cancelled`, `dex_absent` and an event no longer in the schedule cancel an
 * existing booking, even with a bot in the call). If S03 dropped every non-Dex delivery, an HR edit
 * that swaps Dex for a human, or moves the schedule back to NeedsScheduling, would leave the bot
 * scheduled, and it would join and record a human-only interview (privacy and cost). S03 cannot read
 * bookings without a second RPC, and a read-then-skip races with S06 creating the booking, so
 * Updates are forwarded conservatively and only the provably irrelevant delivery is dropped: a Create
 * without Dex. Because such a job may concern a human-only interview, a `schedule` job carries no
 * candidate-linked or Confidential id (fix round S03-R3, data minimisation): S06 reconciles by
 * `ashby_schedule_id` alone (0142 indexes bookings on it), so the application, stage and scheduler
 * ids are null there, exactly as on an identity job.
 *
 * Dedupe keys (S03 plan R12; `base` = `r1MeetAshbyScheduleDedupKey(schedule, receivedAtMs)`, one key
 * per DELIVERY, so a suffix keeps "one receipt and job per Dex event" and retries convergent):
 *  - event job: `${base}:${eventId lower-cased}`;
 *  - schedule job: `${base}:schedule`;
 *  - identity job (e): `ashby-schedule:<scheduleId>:<stamp>:cancelled`, with `stamp` = the epoch ms of
 *    `identity.updatedAt` when present, else `r<trunc(receivedAtMs)>` for an epoch ms in 0..8.64e15,
 *    else `r0`.
 * Every key is at most 123 characters of `[A-Za-z0-9_.:-]` and starts `ashby-schedule:` (the 0142
 * key, space and length CHECKs).
 *
 * The payload (contract §2 plus the S03 amendment in §9), in this exact key order: `kind`, `scope`,
 * `ashby_interview_event_id`, `ashby_schedule_id`, `ashby_application_id`, `ashby_interview_stage_id`,
 * `ashby_interview_id`, `ashby_scheduled_by_user_id`, `ashby_updated_at` (= `latestUpdatedAt`, the S01
 * ordering key; `identity.updatedAt` for an identity job), `decision`, `start_at`, `end_at`,
 * `meet_url` (canonical Google Meet URL or null), `received_at` (the receiver clock as an ISO
 * instant; null only for an unusable clock), `ashby_schedule_event_ids` (every parsed event, verbatim,
 * in schedule order) and `ashby_dex_event_ids` (the D subset). A schedule job has the five event
 * fields null, and also the application, stage and scheduler ids (S03-R3); an identity job also has
 * both lists null.
 *
 * The S06 reconcile rule (S03 plan R11): when S06 processes any non-stale `ashby_schedule` job of
 * schedule X, it cancels every live booking of X whose event id (compared lower-cased) is not in
 * `ashby_dex_event_ids`: reason `dex_absent` when the event is still in `ashby_schedule_event_ids`,
 * `event_removed` otherwise. A `schedule` job means no event of X has Dex (reason `cancelled` for the
 * decision `cancelled`); a job with null lists (an identity job) cancels every live booking of X with
 * reason `cancelled`.
 *
 * PII: ids, times, the schedule decision and the canonical Meet URL only. This module never reads the
 * scheduler's email (the parser's non-enumerable property), any name, the location or the other
 * dropped fields; only the scheduler's Ashby user id travels.
 *
 * Ingest (S03 plan R13): the planned jobs are recorded ONE AT A TIME, in plan order, through the
 * `R1MeetReceiptPort` (source `ashby`, `bookingId` null, the receipt clock = `receivedAtMs`, the same
 * instant as `received_at`), stopping at the first failure: a throw → 500 `receipt_persist_failed`; a
 * refusal → 500 `receipt_rejected` (the closed refusal is returned for the log line); no durable work
 * → 500 `enqueue_incomplete`; otherwise 200 `r1_meet_accepted` (any receipt inserted) or
 * `r1_meet_duplicate`. One RPC per job: usually 1, at most `R1_MEET_ASHBY_MAX_EVENTS`. This is the
 * one documented exception to "at most one RPC per accepted webhook" (critic C8): the brief asks for
 * one receipt and job per Dex event, and the 0142 `r1_meet_record_receipt` records exactly one
 * receipt per call; a batch form would need a new migration. The jobs of one delivery are therefore
 * not atomic: after a failure on job k, the redelivery converges on the same keys when the payload
 * carries an `updatedAt`, and otherwise repeats jobs 1..k-1 under new `r<receivedAtMs>` keys, which
 * is the S01 F4 price S06 already tolerates (bookings are unique per event id, and every payload is
 * compared with the stored booking).
 *
 * The planner is pure (no environment, no I/O, no logging; the clocks are arguments), never throws
 * and returns deep-frozen results. Nothing here registers a queue handler (S06).
 */
import {
  isR1MeetAshbyScheduleAction,
  parseR1MeetAshbyScheduleWebhook,
  r1MeetAshbyScheduleDedupKey,
  selectR1MeetDexEvents,
  type R1MeetAshbySchedule,
  type R1MeetAshbyScheduleAction,
  type R1MeetAshbyScheduleEvent,
  type R1MeetAshbyScheduleIdentity,
  type R1MeetAshbyScheduleWebhookFailure,
  type R1MeetDexEventDecision,
} from './ashby-schedule.js';
import type { R1MeetReceiptAnswer, R1MeetReceiptPort, R1MeetReceiptRefusal } from './receipts.js';

// ── Contract constants ──────────────────────────────────────────────────────

/** `event`: one Dex interview event; `schedule`: the whole schedule (no event has Dex). Frozen. */
export const R1_MEET_ASHBY_JOB_SCOPES = Object.freeze(['event', 'schedule'] as const);

export type R1MeetAshbyJobScope = (typeof R1_MEET_ASHBY_JOB_SCOPES)[number];

/** The `ashby_schedule` payload keys, in their exact order (S03 plan R10). Frozen. */
export const R1_MEET_ASHBY_SCHEDULE_PAYLOAD_KEYS = Object.freeze([
  'kind',
  'scope',
  'ashby_interview_event_id',
  'ashby_schedule_id',
  'ashby_application_id',
  'ashby_interview_stage_id',
  'ashby_interview_id',
  'ashby_scheduled_by_user_id',
  'ashby_updated_at',
  'decision',
  'start_at',
  'end_at',
  'meet_url',
  'received_at',
  'ashby_schedule_event_ids',
  'ashby_dex_event_ids',
] as const);

/** The `ashby_schedule` job payload, in the exact key order of `R1_MEET_ASHBY_SCHEDULE_PAYLOAD_KEYS`. */
export type R1MeetAshbyScheduleJobPayload = {
  readonly kind: 'ashby_schedule';
  readonly scope: R1MeetAshbyJobScope;
  readonly ashby_interview_event_id: string | null;
  readonly ashby_schedule_id: string;
  readonly ashby_application_id: string | null;
  readonly ashby_interview_stage_id: string | null;
  readonly ashby_interview_id: string | null;
  readonly ashby_scheduled_by_user_id: string | null;
  readonly ashby_updated_at: string | null;
  readonly decision: R1MeetDexEventDecision;
  readonly start_at: string | null;
  readonly end_at: string | null;
  readonly meet_url: string | null;
  readonly received_at: string | null;
  readonly ashby_schedule_event_ids: readonly string[] | null;
  readonly ashby_dex_event_ids: readonly string[] | null;
};

/** One receipt and its `r1-meet` job. */
export type R1MeetAshbyScheduleJob = {
  readonly dedupeKey: string;
  /** The receipt's event type: the webhook action. */
  readonly eventType: R1MeetAshbyScheduleAction;
  readonly payload: R1MeetAshbyScheduleJobPayload;
};

export type R1MeetAshbySchedulePlan =
  | { readonly kind: 'jobs'; /** Never empty. */ readonly jobs: readonly R1MeetAshbyScheduleJob[] }
  | { readonly kind: 'skip'; readonly reason: 'no_dex_event' }
  | { readonly kind: 'refused'; readonly reason: R1MeetAshbyScheduleWebhookFailure };

export interface R1MeetAshbySchedulePlanOptions {
  /** The configured Ashby user id of "Dex (AI Interviewer)" (a UUID). */
  readonly dexUserId: string;
  /** When the receiver got the webhook (epoch ms): the dedupe stamp fallback and `received_at`. */
  readonly receivedAtMs: number;
  /** The decision clock (epoch ms): the S01 selector. */
  readonly nowMs: number;
}

export interface R1MeetAshbyScheduleIngestDeps extends R1MeetAshbySchedulePlanOptions {
  readonly receipts: R1MeetReceiptPort;
}

/** Every code `ingestR1MeetAshbySchedule` answers (each matches the logger's `error_type` charset). */
export type R1MeetAshbyScheduleIngestCode =
  | 'r1_meet_accepted'
  | 'r1_meet_duplicate'
  | 'r1_meet_no_dex_event'
  | 'receipt_persist_failed'
  | 'receipt_rejected'
  | 'enqueue_incomplete'
  | 'internal_error'
  | R1MeetAshbyScheduleWebhookFailure;

export type R1MeetAshbyScheduleIngestResult = {
  readonly httpStatus: 200 | 400 | 500;
  readonly code: R1MeetAshbyScheduleIngestCode;
  /** Only with `receipt_rejected`: the RPC's closed refusal, for the log line. */
  readonly refusal?: R1MeetReceiptRefusal;
};

// ── Small helpers ───────────────────────────────────────────────────────────

/** Largest epoch ms a `Date` can hold. */
const MAX_EPOCH_MS = 8.64e15;
/** What `toISOString()` gives for a four-digit-year instant. */
const CANONICAL_ISO_RE = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/;
const DEDUPE_PREFIX = 'ashby-schedule:';

const SKIP: R1MeetAshbySchedulePlan = Object.freeze({ kind: 'skip' as const, reason: 'no_dex_event' as const });

function refused(reason: R1MeetAshbyScheduleWebhookFailure): R1MeetAshbySchedulePlan {
  return Object.freeze({ kind: 'refused' as const, reason });
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return false;
  const proto = Object.getPrototypeOf(value) as unknown;
  return proto === Object.prototype || proto === null;
}

function deepFreeze<T>(value: T): T {
  if (typeof value === 'object' && value !== null && !Object.isFrozen(value)) {
    for (const child of Object.values(value)) deepFreeze(child);
    Object.freeze(value);
  }
  return value;
}

function isEpochMs(value: unknown): value is number {
  return typeof value === 'number' && Number.isFinite(value) && value >= 0 && value <= MAX_EPOCH_MS;
}

/** The receiver clock as a canonical ISO instant, or null for an unusable clock. */
function receivedAtIso(receivedAtMs: unknown): string | null {
  if (!isEpochMs(receivedAtMs)) return null;
  const iso = new Date(Math.trunc(receivedAtMs)).toISOString();
  return CANONICAL_ISO_RE.test(iso) ? iso : null;
}

/** The S01 receipt-time stamp: `r<trunc(receivedAtMs)>`, or `r0` for an unusable clock. */
function receivedStamp(receivedAtMs: unknown): string {
  return `r${isEpochMs(receivedAtMs) ? Math.trunc(receivedAtMs) : 0}`;
}

/** The identity job's key (R12): the `updatedAt` epoch ms when present, else the receipt-time stamp. */
function identityDedupeKey(identity: R1MeetAshbyScheduleIdentity, receivedAtMs: unknown): string {
  const updatedMs = identity.updatedAt === null ? Number.NaN : Date.parse(identity.updatedAt);
  const stamp = Number.isFinite(updatedMs) ? String(updatedMs) : receivedStamp(receivedAtMs);
  return `${DEDUPE_PREFIX}${identity.scheduleId}:${stamp}:cancelled`;
}

// ── Planner ─────────────────────────────────────────────────────────────────

function planParsed(
  action: R1MeetAshbyScheduleAction,
  schedule: R1MeetAshbySchedule,
  receivedAtMs: unknown,
  nowMs: number,
): R1MeetAshbySchedulePlan {
  const events: readonly R1MeetAshbyScheduleEvent[] = Array.from(schedule.events);
  const dexEvents = events.filter((event) => event.dexIsInterviewer === true);
  const scheduleEventIds = events.map((event) => event.eventId);
  const dexEventIds = dexEvents.map((event) => event.eventId);
  const base = r1MeetAshbyScheduleDedupKey(schedule, receivedAtMs as number);
  const receivedAt = receivedAtIso(receivedAtMs);

  const payloadFor = (
    scope: R1MeetAshbyJobScope,
    event: R1MeetAshbyScheduleEvent | null,
    decision: R1MeetDexEventDecision,
  ): R1MeetAshbyScheduleJobPayload => ({
    kind: 'ashby_schedule',
    scope,
    ashby_interview_event_id: event === null ? null : event.eventId,
    ashby_schedule_id: schedule.scheduleId,
    // S03-R3: a `schedule` job (no Dex event) carries no candidate-linked or Confidential id.
    ashby_application_id: scope === 'event' ? schedule.applicationId : null,
    ashby_interview_stage_id: scope === 'event' ? schedule.interviewStageId : null,
    ashby_interview_id: event === null ? null : event.interviewId,
    ashby_scheduled_by_user_id: scope === 'event' ? schedule.scheduledByUserId : null,
    ashby_updated_at: schedule.latestUpdatedAt,
    decision,
    start_at: event === null ? null : event.startTime,
    end_at: event === null ? null : event.endTime,
    meet_url: event === null ? null : event.meetUrl,
    received_at: receivedAt,
    ashby_schedule_event_ids: [...scheduleEventIds],
    ashby_dex_event_ids: [...dexEventIds],
  });

  // (a) One event job per Dex event, with the selector's decision.
  if (dexEvents.length > 0) {
    const selections = selectR1MeetDexEvents(schedule, nowMs);
    const jobs = dexEvents.map((event): R1MeetAshbyScheduleJob => {
      const selection = selections.find((candidate) => candidate.eventId === event.eventId);
      if (selection === undefined) throw new Error('r1_meet_selection_missing');
      return {
        dedupeKey: `${base}:${event.eventId.toLowerCase()}`,
        eventType: action,
        payload: payloadFor('event', event, selection.decision),
      };
    });
    return deepFreeze({ kind: 'jobs' as const, jobs });
  }

  // (b) A new schedule without Dex has no booking.
  if (action === 'interviewScheduleCreate') return SKIP;

  // (c) A cancelled Dex-less Update still cancels whatever booking the schedule had.
  if (schedule.status === 'Cancelled') {
    return deepFreeze({
      kind: 'jobs' as const,
      jobs: [{ dedupeKey: `${base}:schedule`, eventType: action, payload: payloadFor('schedule', null, 'cancelled') }],
    });
  }

  // (d) Dex removed (or never there, or his event deleted): always forwarded (S03-R2).
  return deepFreeze({
    kind: 'jobs' as const,
    jobs: [{ dedupeKey: `${base}:schedule`, eventType: action, payload: payloadFor('schedule', null, 'dex_absent') }],
  });
}

/** (e) The cancellation of a schedule the parser refused for an event-level reason. */
function planIdentity(
  action: R1MeetAshbyScheduleAction,
  identity: R1MeetAshbyScheduleIdentity,
  receivedAtMs: unknown,
): R1MeetAshbySchedulePlan {
  const payload: R1MeetAshbyScheduleJobPayload = {
    kind: 'ashby_schedule',
    scope: 'schedule',
    ashby_interview_event_id: null,
    ashby_schedule_id: identity.scheduleId,
    ashby_application_id: null,
    ashby_interview_stage_id: null,
    ashby_interview_id: null,
    ashby_scheduled_by_user_id: null,
    ashby_updated_at: identity.updatedAt,
    decision: 'cancelled',
    start_at: null,
    end_at: null,
    meet_url: null,
    received_at: receivedAtIso(receivedAtMs),
    ashby_schedule_event_ids: null,
    ashby_dex_event_ids: null,
  };
  return deepFreeze({
    kind: 'jobs' as const,
    jobs: [{ dedupeKey: identityDedupeKey(identity, receivedAtMs), eventType: action, payload }],
  });
}

/**
 * The `ashby_schedule` jobs for a verified Ashby webhook body (the forwarding table above), a skip,
 * or the S01 refusal. Any action other than the two schedule actions is `unsupported_action`. Pure,
 * deep-frozen; never throws (an unexpected throw, such as a throwing getter, is `malformed_schedule`).
 */
export function planR1MeetAshbyScheduleJobs(
  body: unknown,
  opts: R1MeetAshbySchedulePlanOptions,
): R1MeetAshbySchedulePlan {
  try {
    const dexUserId: unknown = opts.dexUserId;
    const receivedAtMs: unknown = opts.receivedAtMs;
    const nowMs: unknown = opts.nowMs;
    if (!isPlainObject(body)) return refused('not_object');
    const action: unknown = body.action;
    if (!isR1MeetAshbyScheduleAction(action)) return refused('unsupported_action');

    const parsed = parseR1MeetAshbyScheduleWebhook(body, { dexUserId: dexUserId as string });
    if (parsed.ok) return planParsed(parsed.action, parsed.schedule, receivedAtMs, nowMs as number);
    if (parsed.identity !== undefined && parsed.identity.status === 'Cancelled') {
      return planIdentity(action, parsed.identity, receivedAtMs);
    }
    return refused(parsed.reason);
  } catch {
    return refused('malformed_schedule');
  }
}

// ── Ingest ──────────────────────────────────────────────────────────────────

function result(
  httpStatus: R1MeetAshbyScheduleIngestResult['httpStatus'],
  code: R1MeetAshbyScheduleIngestCode,
  refusal?: R1MeetReceiptRefusal,
): R1MeetAshbyScheduleIngestResult {
  return Object.freeze(refusal === undefined ? { httpStatus, code } : { httpStatus, code, refusal });
}

/**
 * Plan, then record each job through `deps.receipts` in order, stopping at the first failure (see
 * the header for the code table). Never rejects: an unexpected failure outside the port call is 500
 * `internal_error`.
 */
export async function ingestR1MeetAshbySchedule(
  body: unknown,
  deps: R1MeetAshbyScheduleIngestDeps,
): Promise<R1MeetAshbyScheduleIngestResult> {
  try {
    const receivedAtMs = deps.receivedAtMs;
    const plan = planR1MeetAshbyScheduleJobs(body, {
      dexUserId: deps.dexUserId,
      receivedAtMs,
      nowMs: deps.nowMs,
    });
    if (plan.kind === 'refused') return result(400, plan.reason);
    if (plan.kind === 'skip') return result(200, 'r1_meet_no_dex_event');

    let inserted = false;
    for (const job of plan.jobs) {
      let answer: R1MeetReceiptAnswer;
      try {
        answer = await deps.receipts.record({
          source: 'ashby',
          dedupeKey: job.dedupeKey,
          eventType: job.eventType,
          bookingId: null,
          payload: job.payload,
          nowMs: receivedAtMs,
        });
      } catch {
        return result(500, 'receipt_persist_failed');
      }
      if (answer.status === 'refused') return result(500, 'receipt_rejected', answer.reason);
      if (answer.status !== 'inserted' && answer.status !== 'duplicate') return result(500, 'internal_error');
      if (answer.workPending !== true) return result(500, 'enqueue_incomplete');
      if (answer.status === 'inserted') inserted = true;
    }
    return result(200, inserted ? 'r1_meet_accepted' : 'r1_meet_duplicate');
  } catch {
    return result(500, 'internal_error');
  }
}
