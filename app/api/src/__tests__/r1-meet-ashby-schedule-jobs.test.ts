/**
 * M034 S03 T2: the Ashby interview-schedule job planner and ingest (`lib/r1/meet/ashby-schedule-jobs.ts`).
 *
 * - The forwarding table (S03 plan R9 (a)-(f)), every S01 selector decision, no settled grace for
 *   Dex-less Updates (fix round S03-R2), and the identity (refused but Cancelled) job.
 * - Schedule-scope jobs carry no application, stage or scheduler id (fix round S03-R3).
 * - The payload keys and their exact order (R10), the dedupe key shapes and lengths (R12), the
 *   worst-case payload size under the RPC's 4096-byte cap, and PII minimisation (no email, name or
 *   dropped fixture value anywhere; the module source never names the scheduler's email property).
 * - Ingest outcomes with the T1 in-memory receipt port (R13): sequential, stop at the first failure.
 *
 * Deterministic: synthetic fixtures from `support/ashby-schedule-fixture.ts` and injected clocks.
 * The fixture slot starts 2026-12-01T10:30Z.
 */
import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  R1_MEET_ASHBY_JOB_SCOPES,
  R1_MEET_ASHBY_SCHEDULE_PAYLOAD_KEYS,
  ingestR1MeetAshbySchedule,
  planR1MeetAshbyScheduleJobs,
  type R1MeetAshbyScheduleJob,
  type R1MeetAshbySchedulePlan,
  type R1MeetAshbySchedulePlanOptions,
} from '../lib/r1/meet/ashby-schedule-jobs.js';
import {
  R1_MEET_ASHBY_MAX_EVENTS,
  R1_MEET_ASHBY_MAX_INTERVIEWERS,
  R1_MEET_DEX_EVENT_DECISIONS,
  parseR1MeetAshbyScheduleWebhook,
  r1MeetAshbyScheduleDedupKey,
  type R1MeetAshbySchedule,
} from '../lib/r1/meet/ashby-schedule.js';
import type { R1MeetReceiptAnswer, R1MeetReceiptPort, R1MeetReceiptRequest } from '../lib/r1/meet/receipts.js';
import {
  FIXTURE_APPLICATION_ID,
  FIXTURE_CANDIDATE_ID,
  FIXTURE_DEX_USER_ID,
  FIXTURE_DROPPED_VALUES,
  FIXTURE_END_TIME,
  FIXTURE_EVENT_ID,
  FIXTURE_EVENT_UPDATED_AT,
  FIXTURE_HR_USER_ID,
  FIXTURE_INTERVIEW_ID,
  FIXTURE_MEET_URL,
  FIXTURE_OTHER_INTERVIEWER_ID,
  FIXTURE_SCHEDULE_ID,
  FIXTURE_SCHEDULE_UPDATED_AT,
  FIXTURE_STAGE_ID,
  FIXTURE_START_TIME,
  makeAshbyInterviewEvent,
  makeAshbyInterviewSchedule,
  makeAshbyScheduleWebhookBody,
  type AshbyInterviewEventOptions,
  type AshbyInterviewScheduleOptions,
} from './support/ashby-schedule-fixture.js';
import { createR1MeetReceiptsFake, jsonbTextByteLength } from './support/r1-meet-receipts-fake.js';

// ── Helpers ─────────────────────────────────────────────────────────────────

const here = path.dirname(fileURLToPath(import.meta.url));
const MODULE_SOURCE = path.resolve(here, '../lib/r1/meet/ashby-schedule-jobs.ts');

const CREATE = 'interviewScheduleCreate';
const UPDATE = 'interviewScheduleUpdate';

/** Six days before the fixture slot (the slot is in the future). */
const NOW_MS = Date.parse('2026-11-25T04:00:00.000Z');
/** The receipt clock: deliberately distinct from `NOW_MS`, so each field proves which clock it reads. */
const RECEIVED_MS = Date.parse('2026-11-25T04:00:00.250Z');
const RECEIVED_ISO = new Date(RECEIVED_MS).toISOString();
const FIXTURE_END_MS = Date.parse(FIXTURE_END_TIME);
const MINUTE_MS = 60_000;

const PAYLOAD_KEYS = [
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
];

const DEDUPE_PREFIX = ['ashby', 'schedule'].join('-') + ':';
const DEDUPE_CHARSET = /^[A-Za-z0-9_.:-]+$/;

/** A synthetic UUID for index `n` (distinct from every fixture id). */
function uuidFor(n: number): string {
  return `aaaaaaaa-0000-4000-8000-${n.toString(16).padStart(12, '0')}`;
}

/** Escape a string for use inside a RegExp built from parts. */
function escapeRe(text: string): string {
  return text.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

function options(overrides: Partial<R1MeetAshbySchedulePlanOptions> = {}): R1MeetAshbySchedulePlanOptions {
  return { dexUserId: FIXTURE_DEX_USER_ID, receivedAtMs: RECEIVED_MS, nowMs: NOW_MS, ...overrides };
}

function plan(body: unknown, overrides: Partial<R1MeetAshbySchedulePlanOptions> = {}): R1MeetAshbySchedulePlan {
  return planR1MeetAshbyScheduleJobs(body, options(overrides));
}

function jobsOf(result: R1MeetAshbySchedulePlan): readonly R1MeetAshbyScheduleJob[] {
  if (result.kind !== 'jobs') throw new Error(`expected jobs, got ${result.kind}`);
  expect(result.jobs.length).toBeGreaterThan(0);
  return result.jobs;
}

function onlyJob(result: R1MeetAshbySchedulePlan): R1MeetAshbyScheduleJob {
  const jobs = jobsOf(result);
  expect(jobs).toHaveLength(1);
  return jobs[0]!;
}

function body(
  action: string,
  scheduleOptions: AshbyInterviewScheduleOptions = {},
  extra: { candidateId?: string } = {},
): Record<string, unknown> {
  return makeAshbyScheduleWebhookBody(action, makeAshbyInterviewSchedule(scheduleOptions), extra);
}

/** A webhook body with one event built from `eventOptions`. */
function withEvent(
  action: string,
  eventOptions: AshbyInterviewEventOptions,
  scheduleOptions: AshbyInterviewScheduleOptions = {},
): Record<string, unknown> {
  return body(action, { ...scheduleOptions, interviewEvents: [makeAshbyInterviewEvent(eventOptions)] });
}

function parsedSchedule(webhookBody: unknown): R1MeetAshbySchedule {
  const result = parseR1MeetAshbyScheduleWebhook(webhookBody, { dexUserId: FIXTURE_DEX_USER_ID });
  if (!result.ok) throw new Error(`expected a parsed schedule, got ${result.reason}`);
  return result.schedule;
}

function isDeepFrozen(value: unknown): boolean {
  if (value === null || typeof value !== 'object') return true;
  if (!Object.isFrozen(value)) return false;
  return Object.values(value).every((child) => isDeepFrozen(child));
}

function expectKeyShape(key: string): void {
  expect(key.length).toBeLessThanOrEqual(123);
  expect(key.length).toBeLessThanOrEqual(256);
  expect(key).toMatch(DEDUPE_CHARSET);
  expect(key.startsWith(DEDUPE_PREFIX)).toBe(true);
}

/** The expected payload of the default fixture's event job; `overrides` replaces fields. */
function expectedEventPayload(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    kind: 'ashby_schedule',
    scope: 'event',
    ashby_interview_event_id: FIXTURE_EVENT_ID,
    ashby_schedule_id: FIXTURE_SCHEDULE_ID,
    ashby_application_id: FIXTURE_APPLICATION_ID,
    ashby_interview_stage_id: FIXTURE_STAGE_ID,
    ashby_interview_id: FIXTURE_INTERVIEW_ID,
    ashby_scheduled_by_user_id: FIXTURE_HR_USER_ID,
    ashby_updated_at: FIXTURE_EVENT_UPDATED_AT,
    decision: 'eligible',
    start_at: FIXTURE_START_TIME,
    end_at: FIXTURE_END_TIME,
    meet_url: FIXTURE_MEET_URL,
    received_at: RECEIVED_ISO,
    ashby_schedule_event_ids: [FIXTURE_EVENT_ID],
    ashby_dex_event_ids: [FIXTURE_EVENT_ID],
    ...overrides,
  };
}

/**
 * The expected payload of a schedule-scope job of the fixture schedule: no event fields, and no
 * application, stage or scheduler id (S03-R3: such a job may concern a human-only interview).
 */
function expectedSchedulePayload(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return expectedEventPayload({
    scope: 'schedule',
    ashby_interview_event_id: null,
    ashby_application_id: null,
    ashby_interview_stage_id: null,
    ashby_interview_id: null,
    ashby_scheduled_by_user_id: null,
    start_at: null,
    end_at: null,
    meet_url: null,
    ...overrides,
  });
}

/** An event with only a non-Dex interviewer. */
function nonDexEvent(eventOptions: AshbyInterviewEventOptions = {}): Record<string, unknown> {
  return makeAshbyInterviewEvent({ interviewerIds: [FIXTURE_OTHER_INTERVIEWER_ID], ...eventOptions });
}

/** A body whose parse is refused for an event-level reason (no interviewer data), with `status`. */
function refusedWithIdentity(
  action: string,
  status: string,
  scheduleOptions: AshbyInterviewScheduleOptions = {},
): Record<string, unknown> {
  return withEvent(action, { interviewers: null, interviewerUserIds: null }, { ...scheduleOptions, status });
}

const INSERTED_NO_WORK: R1MeetReceiptAnswer = Object.freeze({
  status: 'inserted' as const,
  id: '5e000000-0000-4000-8000-0000000000f1',
  outcome: 'recorded' as const,
  enqueued: false,
  workPending: false,
  bookingLinked: false,
});

// ── Contract constants ──────────────────────────────────────────────────────

describe('contract constants', () => {
  it('pins the scopes and the payload key order', () => {
    expect(R1_MEET_ASHBY_JOB_SCOPES).toEqual(['event', 'schedule']);
    expect(Object.isFrozen(R1_MEET_ASHBY_JOB_SCOPES)).toBe(true);
    expect(R1_MEET_ASHBY_SCHEDULE_PAYLOAD_KEYS).toEqual(PAYLOAD_KEYS);
    expect(Object.isFrozen(R1_MEET_ASHBY_SCHEDULE_PAYLOAD_KEYS)).toBe(true);
  });
});

// ── (a) Dex events ──────────────────────────────────────────────────────────

describe('(a) one event job per Dex event', () => {
  it('Create with the default fixture: one eligible event job with the exact payload and key', () => {
    const webhookBody = body(CREATE);
    const result = plan(webhookBody);
    const job = onlyJob(result);
    expect(job.eventType).toBe(CREATE);
    expect(Object.keys(job.payload)).toEqual(PAYLOAD_KEYS);
    expect(job.payload).toEqual(expectedEventPayload());
    // The Meet link arrives with `?authuser=0`; the payload keeps the canonical URL only.
    expect(job.payload.meet_url).toBe(FIXTURE_MEET_URL);
    expect(job.dedupeKey).toBe(
      `${r1MeetAshbyScheduleDedupKey(parsedSchedule(webhookBody), RECEIVED_MS)}:${FIXTURE_EVENT_ID.toLowerCase()}`,
    );
    expectKeyShape(job.dedupeKey);
    expect(isDeepFrozen(result)).toBe(true);
  });

  it('an Update with a candidate id gives the same payload (the candidate id never travels)', () => {
    const job = onlyJob(plan(body(UPDATE, {}, { candidateId: FIXTURE_CANDIDATE_ID })));
    expect(job.eventType).toBe(UPDATE);
    expect(job.payload).toEqual(expectedEventPayload());
    expect(JSON.stringify(job)).not.toContain(FIXTURE_CANDIDATE_ID);
  });

  it('two Dex events plus one non-Dex, in reverse start order: two jobs in start order with shared lists', () => {
    // Mixed case on purpose: ids stay verbatim in the payload and are lower-cased in the key suffix.
    const first = uuidFor(1).toUpperCase();
    const middle = uuidFor(2);
    const last = uuidFor(3);
    const webhookBody = body(UPDATE, {
      interviewEvents: [
        makeAshbyInterviewEvent({ id: last, startTime: '2026-12-03T10:30:00.000Z', endTime: '2026-12-03T11:15:00.000Z' }),
        nonDexEvent({ id: middle, startTime: '2026-12-02T10:30:00.000Z', endTime: '2026-12-02T11:15:00.000Z' }),
        makeAshbyInterviewEvent({ id: first, startTime: '2026-12-01T10:30:00.000Z', endTime: '2026-12-01T11:15:00.000Z' }),
      ],
    });
    const jobs = jobsOf(plan(webhookBody));
    expect(jobs).toHaveLength(2);
    expect(jobs.map((job) => job.payload.ashby_interview_event_id)).toEqual([first, last]);
    expect(jobs.map((job) => job.payload.start_at)).toEqual(['2026-12-01T10:30:00.000Z', '2026-12-03T10:30:00.000Z']);
    const base = r1MeetAshbyScheduleDedupKey(parsedSchedule(webhookBody), RECEIVED_MS);
    expect(jobs.map((job) => job.dedupeKey)).toEqual([`${base}:${first.toLowerCase()}`, `${base}:${last}`]);
    expect(new Set(jobs.map((job) => job.dedupeKey)).size).toBe(2);
    for (const job of jobs) {
      expect(job.eventType).toBe(UPDATE);
      expect(job.payload.scope).toBe('event');
      expect(job.payload.decision).toBe('eligible');
      expect(job.payload.ashby_schedule_event_ids).toEqual([first, middle, last]);
      expect(job.payload.ashby_dex_event_ids).toEqual([first, last]);
      expectKeyShape(job.dedupeKey);
    }
  });

  it('decision cancelled: status Cancelled with Dex is an event job, not a schedule job', () => {
    const job = onlyJob(plan(body(UPDATE, { status: 'Cancelled' })));
    expect(job.payload).toEqual(expectedEventPayload({ decision: 'cancelled' }));
  });

  it('decision in_past: the clock is after the start (no settled grace for Dex events)', () => {
    const atStart = plan(body(UPDATE), { nowMs: Date.parse(FIXTURE_START_TIME) });
    expect(onlyJob(atStart).payload.decision).toBe('in_past');
    const longAfter = plan(body(UPDATE), { nowMs: FIXTURE_END_MS + 30 * 24 * 60 * MINUTE_MS });
    expect(onlyJob(longAfter).payload).toEqual(expectedEventPayload({ decision: 'in_past' }));
  });

  it('decision in_past for an unusable decision clock; received_at still follows the receipt clock', () => {
    const job = onlyJob(plan(body(CREATE), { nowMs: Number.NaN }));
    expect(job.payload.decision).toBe('in_past');
    expect(job.payload.received_at).toBe(RECEIVED_ISO);
  });

  it('decision not_scheduled: status OnHold, future slot', () => {
    const job = onlyJob(plan(body(UPDATE, { status: 'OnHold' })));
    expect(job.payload).toEqual(expectedEventPayload({ decision: 'not_scheduled' }));
  });

  it('decision no_attester: scheduledBy null', () => {
    const job = onlyJob(plan(body(CREATE, { scheduledBy: null })));
    expect(job.payload).toEqual(expectedEventPayload({ decision: 'no_attester', ashby_scheduled_by_user_id: null }));
  });

  it('decision no_meet_link: no link, and a non-Meet link (dropped)', () => {
    const noLink = onlyJob(plan(withEvent(CREATE, { meetingLink: null })));
    expect(noLink.payload).toEqual(expectedEventPayload({ decision: 'no_meet_link', meet_url: null }));
    const zoomLink = 'https://zoom.us/j/1234567890';
    const other = onlyJob(plan(withEvent(CREATE, { meetingLink: zoomLink })));
    expect(other.payload).toEqual(expectedEventPayload({ decision: 'no_meet_link', meet_url: null }));
    expect(JSON.stringify(other)).not.toContain('zoom');
  });

  it('every decision of an event job comes from the S01 set and never says dex_absent', () => {
    const bodies = [
      body(CREATE),
      body(UPDATE, { status: 'Cancelled' }),
      body(UPDATE, { status: 'OnHold' }),
      body(CREATE, { scheduledBy: null }),
      withEvent(CREATE, { meetingLink: null }),
    ];
    for (const webhookBody of bodies) {
      for (const job of jobsOf(plan(webhookBody))) {
        expect(R1_MEET_DEX_EVENT_DECISIONS).toContain(job.payload.decision);
        expect(job.payload.decision).not.toBe('dex_absent');
        expect(job.payload.scope).toBe('event');
      }
    }
  });
});

// ── (b)-(d) no Dex event ────────────────────────────────────────────────────

describe('(b) Create with no Dex event: skip', () => {
  it('a Create whose only event has no Dex', () => {
    expect(plan(withEvent(CREATE, { interviewerIds: [FIXTURE_OTHER_INTERVIEWER_ID] }))).toEqual({
      kind: 'skip',
      reason: 'no_dex_event',
    });
  });

  it('a Create with zero events, and a cancelled Create with no Dex', () => {
    expect(plan(body(CREATE, { interviewEvents: [] })).kind).toBe('skip');
    expect(plan(withEvent(CREATE, { interviewerIds: [FIXTURE_OTHER_INTERVIEWER_ID] }, { status: 'Cancelled' })).kind).toBe(
      'skip',
    );
  });

  it('the skip result is frozen', () => {
    const result = plan(body(CREATE, { interviewEvents: [] }));
    expect(isDeepFrozen(result)).toBe(true);
  });
});

describe('(c) Update, no Dex, Cancelled: one schedule job, cancelled', () => {
  it('a cancelled Update whose event has no Dex', () => {
    const webhookBody = withEvent(UPDATE, { interviewerIds: [FIXTURE_OTHER_INTERVIEWER_ID] }, { status: 'Cancelled' });
    const job = onlyJob(plan(webhookBody));
    expect(job.eventType).toBe(UPDATE);
    expect(Object.keys(job.payload)).toEqual(PAYLOAD_KEYS);
    expect(job.payload).toEqual(
      expectedSchedulePayload({ decision: 'cancelled', ashby_dex_event_ids: [] }),
    );
    expect(job.dedupeKey).toBe(`${r1MeetAshbyScheduleDedupKey(parsedSchedule(webhookBody), RECEIVED_MS)}:schedule`);
    expect(job.dedupeKey.endsWith(':schedule')).toBe(true);
    expectKeyShape(job.dedupeKey);
  });

  it('a cancelled Update with zero events', () => {
    const webhookBody = body(UPDATE, { status: 'Cancelled', interviewEvents: [] });
    const job = onlyJob(plan(webhookBody));
    expect(job.payload).toEqual(
      expectedSchedulePayload({
        decision: 'cancelled',
        ashby_updated_at: FIXTURE_SCHEDULE_UPDATED_AT,
        ashby_schedule_event_ids: [],
        ashby_dex_event_ids: [],
      }),
    );
    expect(job.dedupeKey).toBe(`${r1MeetAshbyScheduleDedupKey(parsedSchedule(webhookBody), RECEIVED_MS)}:schedule`);
  });

  it('a cancelled Update whose every event ended long ago still gives a job (no grace for cancellations)', () => {
    const webhookBody = withEvent(UPDATE, { interviewerIds: [FIXTURE_OTHER_INTERVIEWER_ID] }, { status: 'Cancelled' });
    const job = onlyJob(plan(webhookBody, { nowMs: FIXTURE_END_MS + 7 * 24 * 60 * MINUTE_MS }));
    expect(job.payload.decision).toBe('cancelled');
  });
});

describe('(d) Update, no Dex, otherwise: always one schedule job, dex_absent', () => {
  const dexRemoved = (scheduleOptions: AshbyInterviewScheduleOptions = {}) =>
    withEvent(UPDATE, { interviewerIds: [FIXTURE_OTHER_INTERVIEWER_ID] }, scheduleOptions);

  it('Dex removed from a future event', () => {
    const webhookBody = dexRemoved();
    const job = onlyJob(plan(webhookBody));
    expect(job.payload).toEqual(expectedSchedulePayload({ decision: 'dex_absent', ashby_dex_event_ids: [] }));
    expect(job.payload.ashby_schedule_event_ids).toEqual([FIXTURE_EVENT_ID]);
    expect(job.dedupeKey).toBe(`${r1MeetAshbyScheduleDedupKey(parsedSchedule(webhookBody), RECEIVED_MS)}:schedule`);
  });

  it('zero events and status NeedsScheduling', () => {
    const job = onlyJob(plan(body(UPDATE, { status: 'NeedsScheduling', interviewEvents: [] })));
    expect(job.payload).toEqual(
      expectedSchedulePayload({
        decision: 'dex_absent',
        ashby_updated_at: FIXTURE_SCHEDULE_UPDATED_AT,
        ashby_schedule_event_ids: [],
        ashby_dex_event_ids: [],
      }),
    );
  });

  it('S03-R2: a future Dex event deleted from a schedule whose remaining events are past still gives a job', () => {
    // E1 (human interviewers) ended yesterday; E2 (Dex, tomorrow, maybe with a booking and a Recall
    // bot) was deleted in Ashby, so the Update carries only E1. Only this job tells S06 that E2 is
    // gone (`event_removed`): a removed event's time is not in the payload, so no "settled" rule can
    // prove that no future bot belongs to the schedule.
    const nowMs = FIXTURE_END_MS + 24 * 60 * MINUTE_MS;
    const webhookBody = dexRemoved();
    const job = onlyJob(plan(webhookBody, { nowMs }));
    expect(job.payload).toEqual(expectedSchedulePayload({ decision: 'dex_absent', ashby_dex_event_ids: [] }));
    expect(job.payload.ashby_schedule_event_ids).toEqual([FIXTURE_EVENT_ID]);
    expect(job.dedupeKey).toBe(`${r1MeetAshbyScheduleDedupKey(parsedSchedule(webhookBody), RECEIVED_MS)}:schedule`);
  });

  it('no settled grace at any distance after the end: 59, 60, 61 minutes and 30 days all give the job', () => {
    for (const minutes of [59, 60, 61, 30 * 24 * 60]) {
      expect(onlyJob(plan(dexRemoved(), { nowMs: FIXTURE_END_MS + minutes * MINUTE_MS })).payload.decision, String(minutes)).toBe(
        'dex_absent',
      );
    }
  });

  it('a mix of past and recent events keeps the job', () => {
    const webhookBody = body(UPDATE, {
      interviewEvents: [
        nonDexEvent({ id: uuidFor(11) }),
        nonDexEvent({ id: uuidFor(12), startTime: '2026-12-01T12:00:00.000Z', endTime: '2026-12-01T12:45:00.000Z' }),
      ],
    });
    const nowMs = Date.parse('2026-12-01T13:00:00.000Z'); // 105 min after the first end, 15 after the second
    expect(onlyJob(plan(webhookBody, { nowMs })).payload.ashby_schedule_event_ids).toEqual([uuidFor(11), uuidFor(12)]);
  });

  it('a skipped (malformed, provably non-Dex) event is absent from the lists, and the job is still made', () => {
    const webhookBody = body(UPDATE, {
      interviewEvents: [nonDexEvent(), nonDexEvent({ id: uuidFor(13), startTime: 'not-a-time' })],
    });
    expect(parsedSchedule(webhookBody).skippedNonDexEventCount).toBe(1);
    const job = onlyJob(plan(webhookBody, { nowMs: FIXTURE_END_MS + 61 * MINUTE_MS }));
    expect(job.payload.decision).toBe('dex_absent');
    // The skipped event is not in the list: S06 treats any booking of it as `event_removed`.
    expect(job.payload.ashby_schedule_event_ids).toEqual([FIXTURE_EVENT_ID]);
  });

  it('an unusable decision clock still gives the job', () => {
    expect(onlyJob(plan(dexRemoved(), { nowMs: Number.NaN })).payload.decision).toBe('dex_absent');
    expect(onlyJob(plan(dexRemoved(), { nowMs: Number.POSITIVE_INFINITY })).payload.decision).toBe('dex_absent');
  });
});

// ── (e) refused, but Cancelled ──────────────────────────────────────────────

describe('(e) a refused parse whose identity is Cancelled: one schedule job, cancelled, with nulls', () => {
  const expectedIdentityPayload = (overrides: Record<string, unknown> = {}) => ({
    kind: 'ashby_schedule',
    scope: 'schedule',
    ashby_interview_event_id: null,
    ashby_schedule_id: FIXTURE_SCHEDULE_ID,
    ashby_application_id: null,
    ashby_interview_stage_id: null,
    ashby_interview_id: null,
    ashby_scheduled_by_user_id: null,
    ashby_updated_at: FIXTURE_SCHEDULE_UPDATED_AT,
    decision: 'cancelled',
    start_at: null,
    end_at: null,
    meet_url: null,
    received_at: RECEIVED_ISO,
    ashby_schedule_event_ids: null,
    ashby_dex_event_ids: null,
    ...overrides,
  });

  it('an event without interviewer data in a cancelled Update', () => {
    const webhookBody = refusedWithIdentity(UPDATE, 'Cancelled');
    const parsed = parseR1MeetAshbyScheduleWebhook(webhookBody, { dexUserId: FIXTURE_DEX_USER_ID });
    expect(parsed.ok).toBe(false);
    const result = plan(webhookBody);
    const job = onlyJob(result);
    expect(job.eventType).toBe(UPDATE);
    expect(Object.keys(job.payload)).toEqual(PAYLOAD_KEYS);
    expect(job.payload).toEqual(expectedIdentityPayload());
    const stamp = String(Date.parse(FIXTURE_SCHEDULE_UPDATED_AT));
    expect(job.dedupeKey).toMatch(
      new RegExp(`^${escapeRe(DEDUPE_PREFIX)}${escapeRe(FIXTURE_SCHEDULE_ID)}:${stamp}:cancelled$`),
    );
    expectKeyShape(job.dedupeKey);
    expect(isDeepFrozen(result)).toBe(true);
  });

  it('the event type is the body action (a Create too)', () => {
    expect(onlyJob(plan(refusedWithIdentity(CREATE, 'Cancelled'))).eventType).toBe(CREATE);
  });

  it('a null updatedAt: the key uses r<receivedAtMs> (truncated); NaN or negative clocks use r0', () => {
    const webhookBody = refusedWithIdentity(UPDATE, 'Cancelled', { updatedAt: null });
    const job = onlyJob(plan(webhookBody));
    expect(job.payload.ashby_updated_at).toBeNull();
    expect(job.dedupeKey).toMatch(
      new RegExp(`^${escapeRe(DEDUPE_PREFIX)}${escapeRe(FIXTURE_SCHEDULE_ID)}:r${RECEIVED_MS}:cancelled$`),
    );

    const fractional = onlyJob(plan(webhookBody, { receivedAtMs: RECEIVED_MS + 0.75 }));
    expect(fractional.dedupeKey).toBe(job.dedupeKey);
    expect(fractional.payload.received_at).toBe(RECEIVED_ISO);

    for (const receivedAtMs of [Number.NaN, -1, Number.POSITIVE_INFINITY]) {
      const unusable = onlyJob(plan(webhookBody, { receivedAtMs }));
      expect(unusable.dedupeKey).toMatch(
        new RegExp(`^${escapeRe(DEDUPE_PREFIX)}${escapeRe(FIXTURE_SCHEDULE_ID)}:r0:cancelled$`),
      );
      expect(unusable.payload.received_at).toBeNull();
    }
  });

  it('the schedule id stays verbatim (upper-case input)', () => {
    const upperId = FIXTURE_SCHEDULE_ID.toUpperCase();
    const job = onlyJob(plan(refusedWithIdentity(UPDATE, 'Cancelled', { id: upperId })));
    expect(job.payload.ashby_schedule_id).toBe(upperId);
    expect(job.dedupeKey.startsWith(`${DEDUPE_PREFIX}${upperId}:`)).toBe(true);
  });
});

// ── (f) refusals ────────────────────────────────────────────────────────────

describe('(f) any other refusal', () => {
  it('a refused parse whose identity is not Cancelled', () => {
    expect(plan(refusedWithIdentity(UPDATE, 'Scheduled'))).toEqual({ kind: 'refused', reason: 'malformed_event' });
    expect(plan(refusedWithIdentity(UPDATE, 'OnHold'))).toEqual({ kind: 'refused', reason: 'malformed_event' });
  });

  it('schedule-level and envelope refusals', () => {
    expect(plan(body(UPDATE, { applicationId: 'not-a-uuid' }))).toEqual({ kind: 'refused', reason: 'malformed_schedule' });
    expect(plan({ action: UPDATE, data: {} })).toEqual({ kind: 'refused', reason: 'missing_schedule' });
    expect(plan({ action: UPDATE })).toEqual({ kind: 'refused', reason: 'missing_schedule' });
    for (const notObject of [null, undefined, 'x', 42, [], [body(CREATE)]]) {
      expect(plan(notObject)).toEqual({ kind: 'refused', reason: 'not_object' });
    }
  });

  it('a schedule-level refusal of a cancelled schedule carries no identity, so it is refused too', () => {
    expect(plan(body(UPDATE, { status: 'Cancelled', applicationId: 'not-a-uuid' }))).toEqual({
      kind: 'refused',
      reason: 'malformed_schedule',
    });
  });

  it('an action other than the two schedule actions', () => {
    for (const action of ['ping', 'candidateStageChange', 'applicationUpdate', 'interviewScheduleDelete', 42, undefined]) {
      expect(plan({ ...body(CREATE), action })).toEqual({ kind: 'refused', reason: 'unsupported_action' });
    }
  });

  it('an invalid Dex user id option, even for a cancelled schedule (never a destructive job)', () => {
    for (const dexUserId of ['not-a-uuid', '', null, undefined]) {
      const overrides = { dexUserId } as unknown as Partial<R1MeetAshbySchedulePlanOptions>;
      expect(plan(body(CREATE), overrides)).toEqual({ kind: 'refused', reason: 'invalid_dex_user_id' });
      expect(plan(refusedWithIdentity(UPDATE, 'Cancelled'), overrides)).toEqual({
        kind: 'refused',
        reason: 'invalid_dex_user_id',
      });
    }
  });

  it('never throws: a throwing getter in the body or the options is a closed refusal', () => {
    const trap = new Proxy(
      {},
      {
        get() {
          throw new Error('trap');
        },
      },
    );
    const throwingAction = { ...body(CREATE) };
    Object.defineProperty(throwingAction, 'action', {
      enumerable: true,
      get() {
        throw new Error('trap');
      },
    });
    expect(plan(throwingAction)).toEqual({ kind: 'refused', reason: 'malformed_schedule' });
    expect(planR1MeetAshbyScheduleJobs(body(CREATE), trap as R1MeetAshbySchedulePlanOptions)).toEqual({
      kind: 'refused',
      reason: 'malformed_schedule',
    });
    expect(planR1MeetAshbyScheduleJobs(body(CREATE), null as unknown as R1MeetAshbySchedulePlanOptions)).toEqual({
      kind: 'refused',
      reason: 'malformed_schedule',
    });
  });

  it('refusals are frozen', () => {
    expect(isDeepFrozen(plan(refusedWithIdentity(UPDATE, 'Scheduled')))).toBe(true);
    expect(isDeepFrozen(plan(null))).toBe(true);
  });
});

// ── Keys, size and PII ──────────────────────────────────────────────────────

/** A webhook body with `count` Dex events, each with `interviewers` interviewers (Dex first). */
function manyDexEventsBody(count: number, interviewers: number, scheduleOptions: AshbyInterviewScheduleOptions = {}) {
  const others = Array.from({ length: interviewers - 1 }, (_, i) => uuidFor(1000 + i));
  const events = Array.from({ length: count }, (_, i) => {
    const start = Date.parse(FIXTURE_START_TIME) + i * 24 * 60 * MINUTE_MS;
    return makeAshbyInterviewEvent({
      id: uuidFor(100 + i),
      interviewId: uuidFor(200 + i),
      startTime: new Date(start).toISOString(),
      endTime: new Date(start + 45 * MINUTE_MS).toISOString(),
      interviewerIds: [FIXTURE_DEX_USER_ID, ...others],
    });
  });
  return body(UPDATE, { ...scheduleOptions, interviewEvents: events });
}

/** One plan per forwarding-table row and the key-length extremes. */
function representativePlans(): R1MeetAshbySchedulePlan[] {
  const noStamps = (eventOptions: AshbyInterviewEventOptions = {}) =>
    withEvent(UPDATE, { updatedAt: null, ...eventOptions }, { updatedAt: null });
  return [
    plan(body(CREATE)),
    plan(body(UPDATE, { status: 'Cancelled' })),
    plan(withEvent(UPDATE, { interviewerIds: [FIXTURE_OTHER_INTERVIEWER_ID] }, { status: 'Cancelled' })),
    plan(withEvent(UPDATE, { interviewerIds: [FIXTURE_OTHER_INTERVIEWER_ID] })),
    plan(body(UPDATE, { status: 'NeedsScheduling', interviewEvents: [] })),
    plan(refusedWithIdentity(UPDATE, 'Cancelled')),
    plan(refusedWithIdentity(UPDATE, 'Cancelled', { updatedAt: null })),
    plan(manyDexEventsBody(R1_MEET_ASHBY_MAX_EVENTS, 2)),
    // The longest stamps: `r<8.64e15>` (17 chars) on event, schedule and identity keys.
    plan(noStamps(), { receivedAtMs: 8.64e15 }),
    plan(noStamps({ interviewerIds: [FIXTURE_OTHER_INTERVIEWER_ID] }), { receivedAtMs: 8.64e15 }),
    plan(refusedWithIdentity(UPDATE, 'Cancelled', { updatedAt: null }), { receivedAtMs: 8.64e15 }),
    // A negative epoch stamp (year 0001).
    plan(withEvent(UPDATE, { updatedAt: '0001-01-01T00:00:00.000Z' }, { updatedAt: '0001-01-01T00:00:00.000Z' })),
  ];
}

describe('dedupe keys, payload size and PII', () => {
  it('every key is at most 123 characters of the RPC charset and starts ashby-schedule:', () => {
    const keys = representativePlans().flatMap((result) => jobsOf(result).map((job) => job.dedupeKey));
    expect(keys.length).toBeGreaterThan(20);
    for (const key of keys) expectKeyShape(key);
    // The event-key bound is reached exactly: 15 + 36 + 1 + 17 + 1 + 16 + 1 + 36.
    expect(Math.max(...keys.map((key) => key.length))).toBe(123);
    expect(new Set(keys).size).toBe(keys.length);
  });

  it('the worst case (20 Dex events, 50 interviewers each) stays far below the 4096-byte cap', async () => {
    const webhookBody = manyDexEventsBody(R1_MEET_ASHBY_MAX_EVENTS, R1_MEET_ASHBY_MAX_INTERVIEWERS);
    const jobs = jobsOf(plan(webhookBody));
    expect(jobs).toHaveLength(R1_MEET_ASHBY_MAX_EVENTS);
    for (const job of jobs) {
      expect(job.payload.ashby_schedule_event_ids).toHaveLength(R1_MEET_ASHBY_MAX_EVENTS);
      expect(job.payload.ashby_dex_event_ids).toHaveLength(R1_MEET_ASHBY_MAX_EVENTS);
      expect(Buffer.byteLength(JSON.stringify(job.payload), 'utf8')).toBeLessThan(3000);
      expect(jsonbTextByteLength(job.payload)).toBeLessThanOrEqual(4096);
    }

    const fake = createR1MeetReceiptsFake();
    for (const job of jobs) {
      const answer = await fake.record({
        source: 'ashby',
        dedupeKey: job.dedupeKey,
        eventType: job.eventType,
        bookingId: null,
        payload: job.payload,
        nowMs: RECEIVED_MS,
      });
      expect(answer.status).toBe('inserted');
    }
    expect(fake.jobs()).toHaveLength(R1_MEET_ASHBY_MAX_EVENTS);
  });

  it('no email, name or dropped fixture value anywhere in the plan output', () => {
    const serialized = JSON.stringify([
      ...representativePlans(),
      plan(body(UPDATE, {}, { candidateId: FIXTURE_CANDIDATE_ID })),
      plan(manyDexEventsBody(3, R1_MEET_ASHBY_MAX_INTERVIEWERS)),
    ]);
    expect(serialized).not.toContain('@');
    expect(serialized).not.toContain('example.invalid');
    for (const name of ['Example', 'Recruiter', 'Interviewer']) expect(serialized).not.toContain(name);
    for (const value of Object.values(FIXTURE_DROPPED_VALUES)) expect(serialized).not.toContain(value);
    expect(serialized).not.toContain('authuser');
  });

  it('the module source never names the scheduler email property', () => {
    const source = readFileSync(MODULE_SOURCE, 'utf8');
    expect(source).not.toContain('scheduled' + 'ByEmail');
    expect(source).not.toMatch(/lib\/supabase|process\.env/);
  });
});

// ── Ingest ──────────────────────────────────────────────────────────────────

function ingest(webhookBody: unknown, receipts: R1MeetReceiptPort, overrides: Partial<R1MeetAshbySchedulePlanOptions> = {}) {
  return ingestR1MeetAshbySchedule(webhookBody, { ...options(overrides), receipts });
}

function twoDexEventsBody(): Record<string, unknown> {
  return body(UPDATE, {
    interviewEvents: [
      makeAshbyInterviewEvent({ id: uuidFor(21) }),
      makeAshbyInterviewEvent({ id: uuidFor(22), startTime: '2026-12-02T10:30:00.000Z', endTime: '2026-12-02T11:15:00.000Z' }),
    ],
  });
}

/** A port that delegates to `inner` but rejects call number `failAt` (1-based) like a failed RPC. */
function failingOnCall(inner: R1MeetReceiptPort, failAt: number): R1MeetReceiptPort & { calls: R1MeetReceiptRequest[] } {
  const calls: R1MeetReceiptRequest[] = [];
  return {
    calls,
    record(request) {
      calls.push(request);
      if (calls.length === failAt) return Promise.reject(new Error('r1_meet_receipt_rpc_error'));
      return inner.record(request);
    },
  };
}

describe('ingestR1MeetAshbySchedule', () => {
  it('accepted, then the same delivery is a duplicate with one job', async () => {
    const fake = createR1MeetReceiptsFake();
    const webhookBody = body(CREATE);
    expect(await ingest(webhookBody, fake)).toEqual({ httpStatus: 200, code: 'r1_meet_accepted' });
    expect(fake.jobs()).toHaveLength(1);
    expect(await ingest(webhookBody, fake)).toEqual({ httpStatus: 200, code: 'r1_meet_duplicate' });
    expect(fake.jobs()).toHaveLength(1);

    const [job] = jobsOf(plan(webhookBody));
    expect(fake.calls).toHaveLength(2);
    for (const call of fake.calls) {
      expect(call).toEqual({
        source: 'ashby',
        dedupeKey: job!.dedupeKey,
        eventType: CREATE,
        bookingId: null,
        payload: job!.payload,
        // The receipt clock is the receive instant, the same instant as `received_at`.
        nowMs: RECEIVED_MS,
      });
    }
    const queued = fake.jobs()[0]!;
    expect(queued.dedupeKey).toBe(job!.dedupeKey);
    expect(queued.payload).toEqual({ ...expectedEventPayload(), receipt_id: queued.payload.receipt_id, source: 'ashby' });
  });

  it('a 2-event delivery whose 2nd record throws is 500; the retry is 200 with exactly 2 jobs', async () => {
    const fake = createR1MeetReceiptsFake();
    const webhookBody = twoDexEventsBody();
    const flaky = failingOnCall(fake, 2);
    expect(await ingest(webhookBody, flaky)).toEqual({ httpStatus: 500, code: 'receipt_persist_failed' });
    expect(flaky.calls).toHaveLength(2);
    expect(fake.jobs()).toHaveLength(1);

    expect(await ingest(webhookBody, fake)).toEqual({ httpStatus: 200, code: 'r1_meet_accepted' });
    expect(fake.jobs()).toHaveLength(2);
    expect(fake.jobs().map((job) => job.payload.ashby_interview_event_id)).toEqual([uuidFor(21), uuidFor(22)]);
    // A full redelivery is now a duplicate.
    expect(await ingest(webhookBody, fake)).toEqual({ httpStatus: 200, code: 'r1_meet_duplicate' });
    expect(fake.jobs()).toHaveLength(2);
  });

  it('stops at the first failure: a throw on the first record makes no second call', async () => {
    const fake = createR1MeetReceiptsFake();
    const flaky = failingOnCall(fake, 1);
    expect(await ingest(twoDexEventsBody(), flaky)).toEqual({ httpStatus: 500, code: 'receipt_persist_failed' });
    expect(flaky.calls).toHaveLength(1);
    expect(fake.jobs()).toHaveLength(0);
  });

  it('a forced refusal is 500 receipt_rejected with the closed refusal, and stops', async () => {
    const fake = createR1MeetReceiptsFake();
    fake.answerNext({ status: 'refused', reason: 'payload_too_large' });
    expect(await ingest(twoDexEventsBody(), fake)).toEqual({
      httpStatus: 500,
      code: 'receipt_rejected',
      refusal: 'payload_too_large',
    });
    expect(fake.calls).toHaveLength(1);
    expect(fake.jobs()).toHaveLength(0);
  });

  it('workPending false is 500 enqueue_incomplete', async () => {
    const fake = createR1MeetReceiptsFake();
    fake.answerNext(INSERTED_NO_WORK);
    expect(await ingest(body(CREATE), fake)).toEqual({ httpStatus: 500, code: 'enqueue_incomplete' });
    expect(fake.calls).toHaveLength(1);
  });

  it('skip (a Dex-less Create) is 200 r1_meet_no_dex_event with no call', async () => {
    const fake = createR1MeetReceiptsFake();
    expect(await ingest(withEvent(CREATE, { interviewerIds: [FIXTURE_OTHER_INTERVIEWER_ID] }), fake)).toEqual({
      httpStatus: 200,
      code: 'r1_meet_no_dex_event',
    });
    expect(fake.calls).toHaveLength(0);
  });

  it('S03-R2: a Dex-less Update of a long-past schedule is recorded (one schedule job), not skipped', async () => {
    const fake = createR1MeetReceiptsFake();
    const pastOnly = withEvent(UPDATE, { interviewerIds: [FIXTURE_OTHER_INTERVIEWER_ID] });
    expect(await ingest(pastOnly, fake, { nowMs: FIXTURE_END_MS + 61 * MINUTE_MS })).toEqual({
      httpStatus: 200,
      code: 'r1_meet_accepted',
    });
    expect(fake.calls).toHaveLength(1);
    expect(fake.jobs().map((job) => [job.payload.scope, job.payload.decision])).toEqual([['schedule', 'dex_absent']]);
  });

  it('S03-R3: schedule-scope jobs store no application, stage or scheduler id anywhere', async () => {
    const fake = createR1MeetReceiptsFake();
    const dexRemoved = withEvent(UPDATE, { interviewerIds: [FIXTURE_OTHER_INTERVIEWER_ID] });
    const cancelled = withEvent(UPDATE, { interviewerIds: [FIXTURE_OTHER_INTERVIEWER_ID] }, { status: 'Cancelled' });
    expect(await ingest(dexRemoved, fake)).toEqual({ httpStatus: 200, code: 'r1_meet_accepted' });
    expect(await ingest(cancelled, fake)).toEqual({ httpStatus: 200, code: 'r1_meet_accepted' });
    expect(fake.jobs().map((job) => job.payload.scope)).toEqual(['schedule', 'schedule']);
    for (const job of fake.jobs()) {
      expect(job.payload.ashby_application_id).toBeNull();
      expect(job.payload.ashby_interview_stage_id).toBeNull();
      expect(job.payload.ashby_scheduled_by_user_id).toBeNull();
      expect(job.payload.ashby_schedule_id).toBe(FIXTURE_SCHEDULE_ID);
    }
    const serialized = JSON.stringify([fake.calls, fake.jobs(), fake.receipts()]);
    for (const id of [FIXTURE_APPLICATION_ID, FIXTURE_STAGE_ID, FIXTURE_HR_USER_ID]) expect(serialized).not.toContain(id);
  });

  it('refused is 400 with the S01 reason and no call', async () => {
    const fake = createR1MeetReceiptsFake();
    expect(await ingest(refusedWithIdentity(UPDATE, 'Scheduled'), fake)).toEqual({
      httpStatus: 400,
      code: 'malformed_event',
    });
    expect(await ingest({ action: 'ping' }, fake)).toEqual({ httpStatus: 400, code: 'unsupported_action' });
    expect(await ingest(null, fake)).toEqual({ httpStatus: 400, code: 'not_object' });
    expect(fake.calls).toHaveLength(0);
  });

  it('schedule and identity jobs record with source ashby, a null booking and the action as event type', async () => {
    const fake = createR1MeetReceiptsFake();
    const dexRemoved = withEvent(UPDATE, { interviewerIds: [FIXTURE_OTHER_INTERVIEWER_ID] });
    expect(await ingest(dexRemoved, fake)).toEqual({ httpStatus: 200, code: 'r1_meet_accepted' });
    expect(await ingest(refusedWithIdentity(CREATE, 'Cancelled'), fake)).toEqual({
      httpStatus: 200,
      code: 'r1_meet_accepted',
    });
    expect(await ingest(twoDexEventsBody(), fake)).toEqual({ httpStatus: 200, code: 'r1_meet_accepted' });
    expect(fake.calls.map((call) => call.eventType)).toEqual([UPDATE, CREATE, UPDATE, UPDATE]);
    for (const call of fake.calls) {
      expect(call.source).toBe('ashby');
      expect(call.bookingId).toBeNull();
      expect(call.nowMs).toBe(RECEIVED_MS);
    }
    expect(fake.jobs().map((job) => [job.payload.scope, job.payload.decision])).toEqual([
      ['schedule', 'dex_absent'],
      ['schedule', 'cancelled'],
      ['event', 'eligible'],
      ['event', 'eligible'],
    ]);
    const serialized = JSON.stringify([fake.calls, fake.jobs(), fake.receipts()]);
    expect(serialized).not.toContain('@');
    expect(serialized).not.toContain('example.invalid');
    for (const name of ['Example', 'Recruiter', 'Interviewer']) expect(serialized).not.toContain(name);
    for (const value of Object.values(FIXTURE_DROPPED_VALUES)) expect(serialized).not.toContain(value);
  });

  it('a synchronous throw from the port is receipt_persist_failed; a garbage answer is internal_error', async () => {
    const throwing: R1MeetReceiptPort = {
      record() {
        throw new Error('sync');
      },
    };
    expect(await ingest(body(CREATE), throwing)).toEqual({ httpStatus: 500, code: 'receipt_persist_failed' });
    const garbage: R1MeetReceiptPort = { record: async () => undefined as unknown as R1MeetReceiptAnswer };
    expect(await ingest(body(CREATE), garbage)).toEqual({ httpStatus: 500, code: 'internal_error' });
    const unknownStatus: R1MeetReceiptPort = {
      record: async () => ({ status: 'queued' }) as unknown as R1MeetReceiptAnswer,
    };
    expect(await ingest(body(CREATE), unknownStatus)).toEqual({ httpStatus: 500, code: 'internal_error' });
  });

  it('an unusable receipt clock fails the store guard: a retryable 500, no receipt', async () => {
    const fake = createR1MeetReceiptsFake();
    expect(await ingest(body(CREATE), fake, { receivedAtMs: Number.NaN })).toEqual({
      httpStatus: 500,
      code: 'receipt_persist_failed',
    });
    expect(fake.receipts()).toHaveLength(0);
  });

  it('results are frozen', async () => {
    const fake = createR1MeetReceiptsFake();
    expect(Object.isFrozen(await ingest(body(CREATE), fake))).toBe(true);
    expect(Object.isFrozen(await ingest(null, fake))).toBe(true);
  });
});
