/**
 * The Ashby interview-schedule parser and the Dex event selector (M034 S01 T6): the exact parsed
 * shape, PII minimisation (the scheduler's email only as a non-enumerable property), the webhook
 * envelope, statuses, ids, events, meeting links, interviewers, the fingerprint / dedupe key, the
 * selector's precedence and the never-throws guarantee.
 *
 * Deterministic: synthetic fixtures from `support/ashby-schedule-fixture.ts`; the selector gets an
 * explicit clock.
 */
import { describe, expect, it } from 'vitest';
import {
  ASHBY_INTERVIEW_SCHEDULE_STATUSES,
  R1_MEET_ASHBY_MAX_EVENTS,
  R1_MEET_ASHBY_MAX_EVENT_DURATION_MS,
  R1_MEET_ASHBY_MAX_INTERVIEWERS,
  R1_MEET_ASHBY_SCHEDULE_ACTIONS,
  R1_MEET_ASHBY_SCHEDULE_PARSE_FAILURES,
  R1_MEET_DEX_EVENT_DECISIONS,
  isR1MeetAshbyScheduleAction,
  parseR1MeetAshbySchedule,
  parseR1MeetAshbyScheduleWebhook,
  r1MeetAshbyScheduleDedupKey,
  r1MeetAshbyScheduleFingerprint,
  r1MeetEligibleDexEvents,
  selectR1MeetDexEvents,
  type R1MeetAshbySchedule,
  type R1MeetAshbyScheduleParseFailure,
} from '../lib/r1/meet/ashby-schedule.js';
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
  FIXTURE_SCHEDULE_CREATED_AT,
  FIXTURE_SCHEDULE_ID,
  FIXTURE_SCHEDULE_UPDATED_AT,
  FIXTURE_STAGE_ID,
  FIXTURE_START_TIME,
  makeAshbyInterviewEvent,
  makeAshbyInterviewSchedule,
  makeAshbyScheduleWebhookBody,
  makeAshbyScheduleWebhookRaw,
  makeAshbyUser,
  type AshbyInterviewEventOptions,
  type AshbyInterviewScheduleOptions,
} from './support/ashby-schedule-fixture.js';

// ── Helpers ─────────────────────────────────────────────────────────────────

const OPTIONS = { dexUserId: FIXTURE_DEX_USER_ID } as const;
/** Ten days before the fixture slot. */
const NOW_MS = Date.parse('2026-11-21T10:00:00.000Z');

/** A synthetic UUID for index `n` (distinct from every fixture id). */
function uuidFor(n: number): string {
  return `aaaaaaaa-0000-4000-8000-${n.toString(16).padStart(12, '0')}`;
}

function parseOk(raw: unknown, options: { dexUserId: string | null } = OPTIONS): R1MeetAshbySchedule {
  const result = parseR1MeetAshbySchedule(raw, options);
  if (!result.ok) throw new Error(`expected ok, got ${result.reason}`);
  return result.schedule;
}

function parseReason(raw: unknown, options: { dexUserId: string | null } = OPTIONS): R1MeetAshbyScheduleParseFailure {
  const result = parseR1MeetAshbySchedule(raw, options);
  if (result.ok) throw new Error('expected a failure');
  return result.reason;
}

function schedule(options: AshbyInterviewScheduleOptions = {}): Record<string, unknown> {
  return makeAshbyInterviewSchedule(options);
}

/** A schedule with one event built from `eventOptions`. */
function withEvent(eventOptions: Parameters<typeof makeAshbyInterviewEvent>[0]): Record<string, unknown> {
  return schedule({ interviewEvents: [makeAshbyInterviewEvent(eventOptions)] });
}

/** Every string (keys and values) reachable from `value`. */
function allStrings(value: unknown, out: string[] = []): string[] {
  if (typeof value === 'string') out.push(value);
  else if (Array.isArray(value)) for (const item of value) allStrings(item, out);
  else if (value !== null && typeof value === 'object') {
    for (const [key, item] of Object.entries(value)) {
      out.push(key);
      allStrings(item, out);
    }
  }
  return out;
}

/** Every string VALUE reachable from `value` (keys excluded). */
function allValues(value: unknown, out: string[] = []): string[] {
  if (typeof value === 'string') out.push(value);
  else if (Array.isArray(value)) for (const item of value) allValues(item, out);
  else if (value !== null && typeof value === 'object') for (const item of Object.values(value)) allValues(item, out);
  return out;
}

function isDeepFrozen(value: unknown): boolean {
  if (value === null || typeof value !== 'object') return true;
  if (!Object.isFrozen(value)) return false;
  return Object.values(value).every((child) => isDeepFrozen(child));
}

/** The same JSON value with every object's keys in reverse order. */
function reverseKeys(value: unknown): unknown {
  if (Array.isArray(value)) return value.map((item) => reverseKeys(item));
  if (value !== null && typeof value === 'object') {
    return Object.fromEntries(Object.entries(value).reverse().map(([key, item]) => [key, reverseKeys(item)]));
  }
  return value;
}

const EXPECTED_EVENT = {
  eventId: FIXTURE_EVENT_ID,
  interviewId: FIXTURE_INTERVIEW_ID,
  startTime: FIXTURE_START_TIME,
  endTime: FIXTURE_END_TIME,
  updatedAt: FIXTURE_EVENT_UPDATED_AT,
  meetUrl: FIXTURE_MEET_URL,
  meetingLinkKind: 'google_meet',
  // Input order is Dex, then the other interviewer; output is sorted.
  interviewerUserIds: [FIXTURE_OTHER_INTERVIEWER_ID, FIXTURE_DEX_USER_ID],
  dexIsInterviewer: true,
};

const EXPECTED_SCHEDULE = {
  scheduleId: FIXTURE_SCHEDULE_ID,
  applicationId: FIXTURE_APPLICATION_ID,
  interviewStageId: FIXTURE_STAGE_ID,
  ashbyCandidateId: null,
  status: 'Scheduled',
  scheduledByUserId: FIXTURE_HR_USER_ID,
  createdAt: FIXTURE_SCHEDULE_CREATED_AT,
  updatedAt: FIXTURE_SCHEDULE_UPDATED_AT,
  latestUpdatedAt: FIXTURE_EVENT_UPDATED_AT,
  events: [EXPECTED_EVENT],
};

// ── Constants ───────────────────────────────────────────────────────────────

describe('contract constants', () => {
  it('lists the two schedule actions, frozen, with a matching guard', () => {
    expect(R1_MEET_ASHBY_SCHEDULE_ACTIONS).toEqual(['interviewScheduleCreate', 'interviewScheduleUpdate']);
    expect(Object.isFrozen(R1_MEET_ASHBY_SCHEDULE_ACTIONS)).toBe(true);
    expect(isR1MeetAshbyScheduleAction('interviewScheduleCreate')).toBe(true);
    expect(isR1MeetAshbyScheduleAction('interviewScheduleUpdate')).toBe(true);
    for (const other of ['ping', 'applicationUpdate', 'InterviewScheduleCreate', 'interviewScheduleDelete', '', null, 1, {}]) {
      expect(isR1MeetAshbyScheduleAction(other), String(other)).toBe(false);
    }
  });

  it("lists Ashby's ten known schedule statuses, frozen", () => {
    expect(ASHBY_INTERVIEW_SCHEDULE_STATUSES).toEqual([
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
    ]);
    expect(Object.isFrozen(ASHBY_INTERVIEW_SCHEDULE_STATUSES)).toBe(true);
  });

  it('pins the bounds', () => {
    expect(R1_MEET_ASHBY_MAX_EVENTS).toBe(20);
    expect(R1_MEET_ASHBY_MAX_INTERVIEWERS).toBe(50);
    expect(R1_MEET_ASHBY_MAX_EVENT_DURATION_MS).toBe(24 * 3600 * 1000);
  });

  it('pins the Dex decisions in precedence order (the S02 booking reason contract), frozen', () => {
    expect(R1_MEET_DEX_EVENT_DECISIONS).toEqual([
      'dex_absent',
      'cancelled',
      'not_scheduled',
      'no_attester',
      'no_meet_link',
      'in_past',
      'eligible',
    ]);
    expect(Object.isFrozen(R1_MEET_DEX_EVENT_DECISIONS)).toBe(true);
  });

  it('pins the closed parse failure reasons, frozen', () => {
    expect(R1_MEET_ASHBY_SCHEDULE_PARSE_FAILURES).toEqual([
      'not_object',
      'malformed_schedule',
      'malformed_status',
      'malformed_scheduled_by',
      'malformed_events',
      'too_many_events',
      'malformed_event',
      'duplicate_event_id',
    ]);
    expect(Object.isFrozen(R1_MEET_ASHBY_SCHEDULE_PARSE_FAILURES)).toBe(true);
  });
});

// ── Exact parse ─────────────────────────────────────────────────────────────

describe('parseR1MeetAshbySchedule: the full fixture', () => {
  it('parses to the exact closed shape', () => {
    const parsed = parseOk(schedule());
    expect(parsed).toStrictEqual(EXPECTED_SCHEDULE);
    expect(Object.keys(parsed)).toEqual([
      'scheduleId',
      'applicationId',
      'interviewStageId',
      'ashbyCandidateId',
      'status',
      'scheduledByUserId',
      'createdAt',
      'updatedAt',
      'latestUpdatedAt',
      'events',
    ]);
    expect(Object.keys(parsed.events[0]!)).toEqual([
      'eventId',
      'interviewId',
      'startTime',
      'endTime',
      'updatedAt',
      'meetUrl',
      'meetingLinkKind',
      'interviewerUserIds',
      'dexIsInterviewer',
    ]);
  });

  it('is deep-frozen, and so is the result', () => {
    const result = parseR1MeetAshbySchedule(schedule(), OPTIONS);
    expect(Object.isFrozen(result)).toBe(true);
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(isDeepFrozen(result.schedule)).toBe(true);
    expect(Object.isFrozen(result.schedule.events)).toBe(true);
    expect(Object.isFrozen(result.schedule.events[0]!.interviewerUserIds)).toBe(true);
    expect(() => {
      (result.schedule as { status: string }).status = 'Cancelled';
    }).toThrow(TypeError);
  });

  it('does not keep a reference to the input', () => {
    const raw = schedule();
    const parsed = parseOk(raw);
    (raw.interviewEvents as Array<Record<string, unknown>>)[0]!.startTime = '2030-01-01T00:00:00.000Z';
    raw.status = 'Cancelled';
    expect(parsed.events[0]!.startTime).toBe(FIXTURE_START_TIME);
    expect(parsed.status).toBe('Scheduled');
  });
});

// ── PII ─────────────────────────────────────────────────────────────────────

describe('PII minimisation', () => {
  it('keeps no name, email, role, location, feedback link, extra data, interview title or authuser', () => {
    const parsed = parseOk(schedule());
    const json = JSON.stringify(parsed);
    for (const forbidden of [
      'interviewer@example.invalid',
      'recruiter@example.invalid',
      '@',
      'Example',
      'Recruiter',
      '"Interviewer"',
      'Limited Access',
      'Organization Admin',
      FIXTURE_DROPPED_VALUES.location,
      FIXTURE_DROPPED_VALUES.feedbackLinkPrefix,
      FIXTURE_DROPPED_VALUES.extraDataValue,
      FIXTURE_DROPPED_VALUES.calendarEventId,
      FIXTURE_DROPPED_VALUES.interviewTitle,
      FIXTURE_DROPPED_VALUES.poolTitle,
      'authuser',
      'interviewerPool',
      'extraData',
      'feedbackLink',
      'location',
    ]) {
      expect(json, forbidden).not.toContain(forbidden);
    }
    for (const value of allValues(parsed)) {
      expect(value).not.toMatch(/Example|Interviewer|Recruiter|@/);
    }
  });

  it('carries the scheduler email only as a non-enumerable property, read by name', () => {
    const parsed = parseOk(schedule());
    expect(parsed.scheduledByEmail).toBe('recruiter@example.invalid');
    expect(Object.keys(parsed)).not.toContain('scheduledByEmail');
    expect('scheduledByEmail' in { ...parsed }).toBe(false);
    expect(JSON.stringify(parsed)).not.toContain('scheduledByEmail');
    expect(allStrings(parsed)).not.toContain('scheduledByEmail');
    const descriptor = Object.getOwnPropertyDescriptor(parsed, 'scheduledByEmail');
    expect(descriptor).toMatchObject({ enumerable: false, writable: false, configurable: false });
  });

  it('normalises an upper-case or padded scheduler email', () => {
    const scheduledBy = makeAshbyUser({ id: FIXTURE_HR_USER_ID, email: '  Recruiter@Example.INVALID \t' });
    expect(parseOk(schedule({ scheduledBy })).scheduledByEmail).toBe('recruiter@example.invalid');
  });

  it.each([
    ['no @', 'recruiter.example.invalid'],
    ['two @', 'a@b@example.invalid'],
    ['empty local part', '@example.invalid'],
    ['empty domain', 'recruiter@'],
    ['inner space', 're cruiter@example.invalid'],
    ['control character', 'recruiter\u0007@example.invalid'],
    ['format character', 'recruiter​@example.invalid'],
    ['too long', `${'r'.repeat(250)}@example.invalid`],
    ['empty', ''],
    ['a number', 42],
    ['null', null],
  ])('maps an invalid scheduler email (%s) to null and keeps the user id', (_label, email) => {
    const scheduledBy = makeAshbyUser({ id: FIXTURE_HR_USER_ID, email });
    const parsed = parseOk(schedule({ scheduledBy }));
    expect(parsed.scheduledByEmail).toBeNull();
    expect(parsed.scheduledByUserId).toBe(FIXTURE_HR_USER_ID);
  });

  it('maps a missing scheduler email to null', () => {
    const scheduledBy = makeAshbyUser({ id: FIXTURE_HR_USER_ID });
    delete scheduledBy.email;
    expect(parseOk(schedule({ scheduledBy })).scheduledByEmail).toBeNull();
  });

  it('accepts a 254-character email', () => {
    const email = `${'r'.repeat(254 - '@example.invalid'.length)}@example.invalid`;
    expect(email).toHaveLength(254);
    const scheduledBy = makeAshbyUser({ id: FIXTURE_HR_USER_ID, email });
    expect(parseOk(schedule({ scheduledBy })).scheduledByEmail).toBe(email);
  });
});

// ── Scheduled by ────────────────────────────────────────────────────────────

describe('scheduledBy', () => {
  it('absent or null gives no scheduler and no email', () => {
    const missing = schedule();
    delete missing.scheduledBy;
    for (const raw of [missing, schedule({ scheduledBy: null })]) {
      const parsed = parseOk(raw);
      expect(parsed.scheduledByUserId).toBeNull();
      expect(parsed.scheduledByEmail).toBeNull();
    }
  });

  it('keeps an upper-case scheduler id verbatim', () => {
    const id = FIXTURE_HR_USER_ID.toUpperCase();
    expect(parseOk(schedule({ scheduledBy: makeAshbyUser({ id }) })).scheduledByUserId).toBe(id);
  });

  it.each([
    ['a string', FIXTURE_HR_USER_ID],
    ['an array', [makeAshbyUser({ id: FIXTURE_HR_USER_ID })]],
    ['an object without id', { firstName: 'Example' }],
    ['a non-UUID id', { id: 'user-1' }],
    ['a numeric id', { id: 7 }],
    ['a boolean', true],
  ])('refuses scheduledBy as %s', (_label, scheduledBy) => {
    expect(parseReason(schedule({ scheduledBy }))).toBe('malformed_scheduled_by');
  });
});

// ── Webhook envelope ────────────────────────────────────────────────────────

describe('parseR1MeetAshbyScheduleWebhook', () => {
  it('parses a create body', () => {
    const result = parseR1MeetAshbyScheduleWebhook(makeAshbyScheduleWebhookBody('interviewScheduleCreate'), OPTIONS);
    expect(result).toStrictEqual({ ok: true, action: 'interviewScheduleCreate', schedule: EXPECTED_SCHEDULE });
    expect(Object.isFrozen(result)).toBe(true);
  });

  it("parses an update body and keeps its candidateId as ashbyCandidateId", () => {
    const body = makeAshbyScheduleWebhookBody('interviewScheduleUpdate', schedule(), { candidateId: FIXTURE_CANDIDATE_ID });
    const result = parseR1MeetAshbyScheduleWebhook(body, OPTIONS);
    expect(result).toStrictEqual({
      ok: true,
      action: 'interviewScheduleUpdate',
      schedule: { ...EXPECTED_SCHEDULE, ashbyCandidateId: FIXTURE_CANDIDATE_ID },
    });
  });

  it('parses the raw JSON text exactly like the body object', () => {
    const raw = makeAshbyScheduleWebhookRaw('interviewScheduleUpdate', schedule(), { candidateId: FIXTURE_CANDIDATE_ID });
    expect(typeof raw).toBe('string');
    const fromRaw = parseR1MeetAshbyScheduleWebhook(JSON.parse(raw) as unknown, OPTIONS);
    const fromBody = parseR1MeetAshbyScheduleWebhook(
      makeAshbyScheduleWebhookBody('interviewScheduleUpdate', schedule(), { candidateId: FIXTURE_CANDIDATE_ID }),
      OPTIONS,
    );
    expect(fromRaw).toStrictEqual(fromBody);
  });

  it.each([
    ['ping', { action: 'ping', data: {} }],
    ['applicationUpdate', makeAshbyScheduleWebhookBody('applicationUpdate')],
    ['a missing action', { data: { interviewSchedule: schedule() } }],
    ['a numeric action', { action: 1, data: { interviewSchedule: schedule() } }],
    ['a differently cased action', makeAshbyScheduleWebhookBody('InterviewScheduleCreate')],
  ])('refuses %s as unsupported_action', (_label, body) => {
    expect(parseR1MeetAshbyScheduleWebhook(body, OPTIONS)).toStrictEqual({ ok: false, reason: 'unsupported_action' });
  });

  it.each([
    ['missing data', { action: 'interviewScheduleCreate' }],
    ['null data', { action: 'interviewScheduleCreate', data: null }],
    ['array data', { action: 'interviewScheduleCreate', data: [] }],
    ['missing interviewSchedule', { action: 'interviewScheduleCreate', data: {} }],
    ['null interviewSchedule', { action: 'interviewScheduleCreate', data: { interviewSchedule: null } }],
    ['string interviewSchedule', { action: 'interviewScheduleCreate', data: { interviewSchedule: 'x' } }],
    ['array interviewSchedule', { action: 'interviewScheduleCreate', data: { interviewSchedule: [schedule()] } }],
  ])('refuses %s as missing_schedule', (_label, body) => {
    expect(parseR1MeetAshbyScheduleWebhook(body, OPTIONS)).toStrictEqual({ ok: false, reason: 'missing_schedule' });
  });

  it.each([
    ['an array', [makeAshbyScheduleWebhookBody('interviewScheduleCreate')]],
    ['a string', makeAshbyScheduleWebhookRaw('interviewScheduleCreate')],
    ['null', null],
    ['undefined', undefined],
    ['a number', 7],
  ])('refuses %s body as not_object', (_label, body) => {
    expect(parseR1MeetAshbyScheduleWebhook(body, OPTIONS)).toStrictEqual({ ok: false, reason: 'not_object' });
  });

  it('passes the schedule parse reason through', () => {
    const body = makeAshbyScheduleWebhookBody('interviewScheduleUpdate', schedule({ status: 3 }));
    const result = parseR1MeetAshbyScheduleWebhook(body, OPTIONS);
    expect(result).toStrictEqual({ ok: false, reason: 'malformed_status' });
    expect(Object.isFrozen(result)).toBe(true);
  });
});

// ── Status ──────────────────────────────────────────────────────────────────

describe('status', () => {
  it.each(ASHBY_INTERVIEW_SCHEDULE_STATUSES.map((status) => [status]))('keeps %s verbatim', (status) => {
    expect(parseOk(schedule({ status })).status).toBe(status);
  });

  it.each([['Unknown'], ['Rescheduled'], ['scheduled'], ['SCHEDULED'], [' Scheduled'], ['']])(
    'maps %j to unknown',
    (status) => {
      expect(parseOk(schedule({ status })).status).toBe('unknown');
    },
  );

  it('refuses a missing or non-string status', () => {
    const missing = schedule();
    delete missing.status;
    expect(parseReason(missing)).toBe('malformed_status');
    for (const status of [1, null, true, ['Scheduled'], { value: 'Scheduled' }]) {
      expect(parseReason(schedule({ status })), JSON.stringify(status)).toBe('malformed_status');
    }
  });
});

// ── Ids ─────────────────────────────────────────────────────────────────────

describe('ids', () => {
  it.each<[string, unknown]>([
    ['id', 'schedule-1'],
    ['id', ''],
    ['id', 12],
    ['id', `${FIXTURE_SCHEDULE_ID} `],
    ['id', `{${FIXTURE_SCHEDULE_ID}}`],
    ['applicationId', 'app-1'],
    ['applicationId', null],
    ['applicationId', FIXTURE_APPLICATION_ID.replace(/-/g, '')],
    ['interviewStageId', 'stage-1'],
    ['interviewStageId', undefined],
  ])('refuses %s = %j', (field, value) => {
    const raw = schedule();
    if (value === undefined) delete raw[field];
    else raw[field] = value;
    expect(parseReason(raw)).toBe('malformed_schedule');
  });

  it('accepts upper-case UUIDs and keeps them verbatim', () => {
    const raw = schedule({
      id: FIXTURE_SCHEDULE_ID.toUpperCase(),
      applicationId: FIXTURE_APPLICATION_ID.toUpperCase(),
      interviewStageId: FIXTURE_STAGE_ID.toUpperCase(),
      interviewEvents: [
        makeAshbyInterviewEvent({ id: FIXTURE_EVENT_ID.toUpperCase(), interviewId: FIXTURE_INTERVIEW_ID.toUpperCase() }),
      ],
    });
    const parsed = parseOk(raw);
    expect(parsed.scheduleId).toBe(FIXTURE_SCHEDULE_ID.toUpperCase());
    expect(parsed.applicationId).toBe(FIXTURE_APPLICATION_ID.toUpperCase());
    expect(parsed.interviewStageId).toBe(FIXTURE_STAGE_ID.toUpperCase());
    expect(parsed.events[0]!.eventId).toBe(FIXTURE_EVENT_ID.toUpperCase());
    expect(parsed.events[0]!.interviewId).toBe(FIXTURE_INTERVIEW_ID.toUpperCase());
  });

  it('keeps a candidateId verbatim, maps null to null and refuses anything else', () => {
    const upper = FIXTURE_CANDIDATE_ID.toUpperCase();
    expect(parseOk({ ...schedule(), candidateId: upper }).ashbyCandidateId).toBe(upper);
    expect(parseOk({ ...schedule(), candidateId: null }).ashbyCandidateId).toBeNull();
    for (const candidateId of ['candidate-1', '', 5, {}]) {
      expect(parseReason({ ...schedule(), candidateId }), JSON.stringify(candidateId)).toBe('malformed_schedule');
    }
  });
});

// ── Schedule times ──────────────────────────────────────────────────────────

describe('schedule createdAt / updatedAt', () => {
  it('canonicalises offsets and maps absent or null to null', () => {
    const parsed = parseOk(schedule({ createdAt: '2026-11-20T14:29:00+05:30', updatedAt: null }));
    expect(parsed.createdAt).toBe(FIXTURE_SCHEDULE_CREATED_AT);
    expect(parsed.updatedAt).toBeNull();
    const missing = schedule();
    delete missing.createdAt;
    expect(parseOk(missing).createdAt).toBeNull();
  });

  it.each([['yesterday'], ['2026-11-20'], ['2026-11-20T09:00:00'], [1763629200000], [{}]])(
    'refuses a malformed schedule time %j',
    (value) => {
      expect(parseReason(schedule({ updatedAt: value }))).toBe('malformed_schedule');
      expect(parseReason(schedule({ createdAt: value }))).toBe('malformed_schedule');
    },
  );
});

// ── Events ──────────────────────────────────────────────────────────────────

describe('interview events', () => {
  it('absent or null events give an empty list', () => {
    const missing = schedule();
    delete missing.interviewEvents;
    expect(parseOk(missing).events).toEqual([]);
    expect(parseOk(schedule({ interviewEvents: null })).events).toEqual([]);
    expect(parseOk(schedule({ interviewEvents: [] })).events).toEqual([]);
  });

  it.each([['an object', { 0: makeAshbyInterviewEvent() }], ['a string', 'events'], ['a number', 1]])(
    'refuses interviewEvents as %s',
    (_label, interviewEvents) => {
      expect(parseReason(schedule({ interviewEvents }))).toBe('malformed_events');
    },
  );

  it('accepts 20 events and refuses 21', () => {
    const events = (count: number) =>
      Array.from({ length: count }, (_, i) =>
        makeAshbyInterviewEvent({ id: uuidFor(i + 1), startTime: `2026-12-01T10:${String(i).padStart(2, '0')}:00Z` }),
      );
    expect(parseOk(schedule({ interviewEvents: events(20) })).events).toHaveLength(20);
    expect(parseReason(schedule({ interviewEvents: events(21) }))).toBe('too_many_events');
  });

  it.each([
    ['a non-object event', 'event'],
    ['a null event', null],
    ['an array event', [makeAshbyInterviewEvent()]],
  ])('refuses %s', (_label, event) => {
    expect(parseReason(schedule({ interviewEvents: [event] }))).toBe('malformed_event');
  });

  it.each<[string, AshbyInterviewEventOptions]>([
    ['a non-UUID event id', { id: 'event-1' }],
    ['a non-UUID interview id', { interviewId: 'interview-1' }],
    ['a missing start', { startTime: null }],
    ['a malformed start', { startTime: '2026-12-01 10:30:00Z' }],
    ['a start without an offset', { startTime: '2026-12-01T10:30:00' }],
    ['a numeric start', { startTime: Date.parse(FIXTURE_START_TIME) }],
    ['Feb 30', { startTime: '2026-02-30T10:30:00Z', endTime: '2026-02-30T11:00:00Z' }],
    ['hour 24', { startTime: '2026-12-01T24:00:00Z' }],
    ['minute 60', { startTime: '2026-12-01T10:60:00Z' }],
    ['second 60', { startTime: '2026-12-01T10:30:60Z' }],
    ['an offset of 24 h', { startTime: '2026-12-01T10:30:00+24:00' }],
    ['an offset without a colon', { startTime: '2026-12-01T16:00:00+0530' }],
    ['a missing end', { endTime: null }],
    ['a malformed end', { endTime: 'later' }],
    ['end equal to start', { endTime: FIXTURE_START_TIME }],
    ['end before start', { endTime: '2026-12-01T10:00:00Z' }],
    ['a 25-hour event', { endTime: '2026-12-02T11:30:00Z' }],
    ['24 h + 1 ms', { endTime: '2026-12-02T10:30:00.001Z' }],
    ['a malformed updatedAt', { updatedAt: 'soon' }],
  ])('refuses an event with %s', (_label, eventOptions) => {
    const raw = withEvent(eventOptions);
    if ((eventOptions as Record<string, unknown>).startTime === null) {
      delete (raw.interviewEvents as Array<Record<string, unknown>>)[0]!.startTime;
    }
    expect(parseReason(raw)).toBe('malformed_event');
  });

  it('accepts exactly 24 hours', () => {
    expect(parseOk(withEvent({ endTime: '2026-12-02T10:30:00Z' })).events[0]!.endTime).toBe('2026-12-02T10:30:00.000Z');
  });

  it('maps an absent or null event updatedAt to null', () => {
    expect(parseOk(withEvent({ updatedAt: null })).events[0]!.updatedAt).toBeNull();
  });

  it('canonicalises offsets, short forms and long fractions to toISOString', () => {
    const parsed = parseOk(
      withEvent({ startTime: '2026-12-01T16:00:00+05:30', endTime: '2026-12-01T06:15-05:00', updatedAt: '2026-11-20T09:00:05.123456789Z' }),
    );
    expect(parsed.events[0]!.startTime).toBe(FIXTURE_START_TIME);
    expect(parsed.events[0]!.endTime).toBe(FIXTURE_END_TIME);
    expect(parsed.events[0]!.updatedAt).toBe('2026-11-20T09:00:05.123Z');
  });

  it('refuses duplicate event ids, including ids that differ only in case', () => {
    const twice = [makeAshbyInterviewEvent(), makeAshbyInterviewEvent({ startTime: '2026-12-02T10:30:00Z', endTime: '2026-12-02T11:00:00Z' })];
    expect(parseReason(schedule({ interviewEvents: twice }))).toBe('duplicate_event_id');
    const cased = [
      makeAshbyInterviewEvent(),
      makeAshbyInterviewEvent({ id: FIXTURE_EVENT_ID.toUpperCase(), startTime: '2026-12-02T10:30:00Z', endTime: '2026-12-02T11:00:00Z' }),
    ];
    expect(parseReason(schedule({ interviewEvents: cased }))).toBe('duplicate_event_id');
  });

  it('sorts events by start time, then by event id', () => {
    const late = makeAshbyInterviewEvent({ id: uuidFor(1), startTime: '2026-12-03T10:30:00Z', endTime: '2026-12-03T11:00:00Z' });
    const sameStartB = makeAshbyInterviewEvent({ id: uuidFor(0xb) });
    const sameStartA = makeAshbyInterviewEvent({ id: uuidFor(0xa) });
    const early = makeAshbyInterviewEvent({ id: uuidFor(9), startTime: '2026-12-01T16:00:00+05:30' });
    // `early` starts at 10:30Z too (16:00+05:30), so the three 10:30Z events sort by id.
    const parsed = parseOk(schedule({ interviewEvents: [late, sameStartB, early, sameStartA] }));
    expect(parsed.events.map((event) => event.eventId)).toEqual([uuidFor(9), uuidFor(0xa), uuidFor(0xb), uuidFor(1)]);
  });

  it('ignores unknown fields on the schedule and its events', () => {
    const raw = schedule();
    raw.somethingNew = { nested: 'value' };
    (raw.interviewEvents as Array<Record<string, unknown>>)[0]!.anotherNewField = ['x'];
    expect(parseOk(raw)).toStrictEqual(EXPECTED_SCHEDULE);
  });
});

// ── Meeting links ───────────────────────────────────────────────────────────

describe('meeting links', () => {
  it('canonicalises a Google Meet link (drops ?authuser=0, folds the code)', () => {
    expect(parseOk(withEvent({ meetingLink: 'https://meet.google.com/ABC-DEFG-HIJ?authuser=0#x' })).events[0]).toMatchObject({
      meetUrl: FIXTURE_MEET_URL,
      meetingLinkKind: 'google_meet',
    });
  });

  it('drops any other link (it may carry a passcode) as kind other', () => {
    const zoom = 'https://example.zoom.us/j/1234567890?pwd=examplepasscode';
    for (const link of [zoom, 'https://meet.google.com.evil.test/abc-defg-hij', 'http://meet.google.com/abc-defg-hij', 'tel:+15555550100']) {
      const parsed = parseOk(withEvent({ meetingLink: link }));
      expect(parsed.events[0], link).toMatchObject({ meetUrl: null, meetingLinkKind: 'other' });
      expect(JSON.stringify(parsed)).not.toContain(link);
    }
    expect(JSON.stringify(parseOk(withEvent({ meetingLink: zoom })))).not.toMatch(/zoom|pwd|passcode/);
  });

  it('maps a null, absent or blank link to kind none', () => {
    const missing = withEvent({});
    delete (missing.interviewEvents as Array<Record<string, unknown>>)[0]!.meetingLink;
    for (const raw of [withEvent({ meetingLink: null }), missing, withEvent({ meetingLink: '' }), withEvent({ meetingLink: '  ' })]) {
      expect(parseOk(raw).events[0]).toMatchObject({ meetUrl: null, meetingLinkKind: 'none' });
    }
  });

  it.each([[42], [{ url: FIXTURE_MEET_URL }], [[FIXTURE_MEET_URL]], [true]])('refuses a meeting link of %j', (meetingLink) => {
    expect(parseReason(withEvent({ meetingLink }))).toBe('malformed_event');
  });
});

// ── Interviewers ────────────────────────────────────────────────────────────

describe('interviewers', () => {
  it('reads interviewers[].id and ignores the deprecated list when interviewers is present', () => {
    const raw = withEvent({
      interviewers: [makeAshbyUser({ id: FIXTURE_OTHER_INTERVIEWER_ID })],
      interviewerUserIds: [FIXTURE_DEX_USER_ID],
    });
    const event = parseOk(raw).events[0]!;
    expect(event.interviewerUserIds).toEqual([FIXTURE_OTHER_INTERVIEWER_ID]);
    expect(event.dexIsInterviewer).toBe(false);
  });

  it('an empty interviewers list is authoritative (no fallback)', () => {
    const event = parseOk(withEvent({ interviewers: [], interviewerUserIds: [FIXTURE_DEX_USER_ID] })).events[0]!;
    expect(event.interviewerUserIds).toEqual([]);
    expect(event.dexIsInterviewer).toBe(false);
  });

  it('falls back to interviewerUserIds only when interviewers is absent or null', () => {
    const absent = withEvent({ interviewerUserIds: [FIXTURE_DEX_USER_ID] });
    delete (absent.interviewEvents as Array<Record<string, unknown>>)[0]!.interviewers;
    for (const raw of [absent, withEvent({ interviewers: null, interviewerUserIds: [FIXTURE_DEX_USER_ID] })]) {
      const event = parseOk(raw).events[0]!;
      expect(event.interviewerUserIds).toEqual([FIXTURE_DEX_USER_ID]);
      expect(event.dexIsInterviewer).toBe(true);
    }
  });

  it('gives no interviewers when both lists are absent', () => {
    const raw = withEvent({});
    const event = (raw.interviewEvents as Array<Record<string, unknown>>)[0]!;
    delete event.interviewers;
    delete event.interviewerUserIds;
    expect(parseOk(raw).events[0]).toMatchObject({ interviewerUserIds: [], dexIsInterviewer: false });
  });

  it('skips entries without a UUID id', () => {
    const interviewers = [{ id: 'user-1' }, { firstName: 'Example' }, { id: 5 }, makeAshbyUser({ id: FIXTURE_DEX_USER_ID })];
    expect(parseOk(withEvent({ interviewers })).events[0]!.interviewerUserIds).toEqual([FIXTURE_DEX_USER_ID]);
    const legacy = withEvent({ interviewers: null, interviewerUserIds: ['user-1', '', FIXTURE_DEX_USER_ID] });
    expect(parseOk(legacy).events[0]!.interviewerUserIds).toEqual([FIXTURE_DEX_USER_ID]);
  });

  it.each<[string, AshbyInterviewEventOptions]>([
    ['a non-array interviewers', { interviewers: { id: FIXTURE_DEX_USER_ID } }],
    ['a string interviewers', { interviewers: FIXTURE_DEX_USER_ID }],
    ['a non-object interviewer entry', { interviewers: [FIXTURE_DEX_USER_ID] }],
    ['a null interviewer entry', { interviewers: [null] }],
    ['a non-array legacy list', { interviewers: null, interviewerUserIds: FIXTURE_DEX_USER_ID }],
    ['a non-string legacy entry', { interviewers: null, interviewerUserIds: [7] }],
  ])('refuses %s', (_label, eventOptions) => {
    expect(parseReason(withEvent(eventOptions))).toBe('malformed_event');
  });

  it('accepts 50 interviewers and refuses 51 (either list)', () => {
    const ids = (count: number) => Array.from({ length: count }, (_, i) => uuidFor(100 + i));
    expect(parseOk(withEvent({ interviewerIds: ids(50) })).events[0]!.interviewerUserIds).toHaveLength(50);
    expect(parseReason(withEvent({ interviewerIds: ids(51) }))).toBe('malformed_event');
    expect(parseReason(withEvent({ interviewers: null, interviewerUserIds: ids(51) }))).toBe('malformed_event');
  });

  it('de-duplicates case-insensitively and sorts, whatever the input order', () => {
    const forward = withEvent({ interviewerIds: [FIXTURE_DEX_USER_ID, FIXTURE_OTHER_INTERVIEWER_ID, FIXTURE_DEX_USER_ID.toUpperCase()] });
    const backward = withEvent({ interviewerIds: [FIXTURE_DEX_USER_ID.toUpperCase(), FIXTURE_DEX_USER_ID, FIXTURE_OTHER_INTERVIEWER_ID] });
    const a = parseOk(forward).events[0]!.interviewerUserIds;
    const b = parseOk(backward).events[0]!.interviewerUserIds;
    expect(a).toHaveLength(2);
    expect(a).toEqual(b);
    expect(a[0]).toBe(FIXTURE_OTHER_INTERVIEWER_ID);
    expect(a[1]!.toLowerCase()).toBe(FIXTURE_DEX_USER_ID);
  });

  it('matches Dex case-insensitively on both sides', () => {
    expect(parseOk(schedule(), { dexUserId: FIXTURE_DEX_USER_ID.toUpperCase() }).events[0]!.dexIsInterviewer).toBe(true);
    const upperInterviewer = withEvent({ interviewerIds: [FIXTURE_DEX_USER_ID.toUpperCase()] });
    const event = parseOk(upperInterviewer).events[0]!;
    expect(event.dexIsInterviewer).toBe(true);
    expect(event.interviewerUserIds).toEqual([FIXTURE_DEX_USER_ID.toUpperCase()]);
  });

  it.each([[null], ['not-a-uuid'], [''], [FIXTURE_OTHER_INTERVIEWER_ID.slice(0, 35)]])(
    'a Dex id of %j matches no one',
    (dexUserId) => {
      const raw = schedule({ interviewEvents: [makeAshbyInterviewEvent(), makeAshbyInterviewEvent({ id: uuidFor(2), interviewerIds: ['not-a-uuid'] })] });
      for (const event of parseOk(raw, { dexUserId }).events) expect(event.dexIsInterviewer).toBe(false);
    },
  );

  it('treats missing or broken options as no Dex id', () => {
    for (const options of [undefined, null, {}, { dexUserId: 7 }, [FIXTURE_DEX_USER_ID]]) {
      const result = parseR1MeetAshbySchedule(schedule(), options as never);
      expect(result.ok, JSON.stringify(options)).toBe(true);
      if (result.ok) expect(result.schedule.events[0]!.dexIsInterviewer).toBe(false);
    }
  });
});

// ── latestUpdatedAt ─────────────────────────────────────────────────────────

describe('latestUpdatedAt', () => {
  it('is the latest of the schedule and its events', () => {
    expect(parseOk(schedule()).latestUpdatedAt).toBe(FIXTURE_EVENT_UPDATED_AT);
    expect(parseOk(schedule({ updatedAt: '2026-11-20T10:00:00Z' })).latestUpdatedAt).toBe('2026-11-20T10:00:00.000Z');
    const two = schedule({
      updatedAt: null,
      interviewEvents: [
        makeAshbyInterviewEvent({ updatedAt: '2026-11-20T09:30:00+05:30' }),
        makeAshbyInterviewEvent({ id: uuidFor(3), updatedAt: '2026-11-20T05:00:00Z', startTime: '2026-12-02T10:30:00Z', endTime: '2026-12-02T11:00:00Z' }),
      ],
    });
    // 09:30+05:30 is 04:00Z, earlier than 05:00Z: comparing the raw strings would pick the wrong one.
    expect(parseOk(two).latestUpdatedAt).toBe('2026-11-20T05:00:00.000Z');
  });

  it('is null when nothing carries updatedAt', () => {
    expect(parseOk(schedule({ updatedAt: null, interviewEvents: [makeAshbyInterviewEvent({ updatedAt: null })] })).latestUpdatedAt).toBeNull();
  });
});

// ── Fingerprint and dedupe key ──────────────────────────────────────────────

describe('fingerprint and dedupe key', () => {
  const twoEvents = () => [
    makeAshbyInterviewEvent(),
    makeAshbyInterviewEvent({ id: uuidFor(4), interviewId: uuidFor(5), startTime: '2026-12-02T10:30:00Z', endTime: '2026-12-02T11:00:00Z' }),
  ];
  const fingerprintOf = (raw: unknown) => r1MeetAshbyScheduleFingerprint(parseOk(raw));
  const keyOf = (raw: unknown) => r1MeetAshbyScheduleDedupKey(parseOk(raw));

  it('is a SHA-256 hex digest and the key has the documented shape', () => {
    const parsed = parseOk(schedule());
    expect(r1MeetAshbyScheduleFingerprint(parsed)).toMatch(/^[0-9a-f]{64}$/);
    const key = r1MeetAshbyScheduleDedupKey(parsed);
    expect(key).toBe(
      `ashby-schedule:${FIXTURE_SCHEDULE_ID}:${Date.parse(FIXTURE_EVENT_UPDATED_AT)}:${r1MeetAshbyScheduleFingerprint(parsed).slice(0, 16)}`,
    );
    expect(key).toMatch(/^[A-Za-z0-9_.:-]{1,256}$/);
    expect(key.length).toBeLessThanOrEqual(256);
  });

  it('uses 0 when nothing carries updatedAt', () => {
    const raw = schedule({ updatedAt: null, interviewEvents: [makeAshbyInterviewEvent({ updatedAt: null })] });
    expect(keyOf(raw)).toMatch(new RegExp(`^ashby-schedule:${FIXTURE_SCHEDULE_ID}:0:[0-9a-f]{16}$`));
  });

  it('is identical for retries, key-order shuffles, event-order shuffles and added unknown fields', () => {
    const base = schedule({ interviewEvents: twoEvents() });
    const reference = fingerprintOf(base);
    expect(fingerprintOf(schedule({ interviewEvents: twoEvents() }))).toBe(reference);
    expect(fingerprintOf(reverseKeys(base))).toBe(reference);
    expect(fingerprintOf(schedule({ interviewEvents: twoEvents().reverse() }))).toBe(reference);
    const extra = schedule({ interviewEvents: twoEvents() });
    extra.newField = 'x';
    (extra.interviewEvents as Array<Record<string, unknown>>)[1]!.anotherField = { y: 1 };
    expect(fingerprintOf(extra)).toBe(reference);
    expect(keyOf(reverseKeys(base))).toBe(keyOf(base));
  });

  it('ignores dropped fields and the scheduler email', () => {
    const reference = fingerprintOf(schedule());
    const renamed = schedule({
      scheduledBy: makeAshbyUser({ id: FIXTURE_HR_USER_ID, email: 'someone.else@example.invalid', firstName: 'Other', lastName: 'Person' }),
    });
    expect(fingerprintOf(renamed)).toBe(reference);
    expect(keyOf(renamed)).toBe(keyOf(schedule()));
    const moved = schedule();
    (moved.interviewEvents as Array<Record<string, unknown>>)[0]!.location = 'Example Office, Floor 9';
    expect(fingerprintOf(moved)).toBe(reference);
    // ?authuser differences canonicalise to the same Meet URL.
    expect(fingerprintOf(withEvent({ meetingLink: `${FIXTURE_MEET_URL}?authuser=1` }))).toBe(reference);
  });

  it.each([
    ['start time', () => withEvent({ startTime: '2026-12-01T11:00:00Z', endTime: '2026-12-01T11:45:00Z' })],
    ['meet link', () => withEvent({ meetingLink: 'https://meet.google.com/xyz-wxyz-xyz' })],
    ['meet link removed', () => withEvent({ meetingLink: null })],
    ['status', () => schedule({ status: 'Cancelled' })],
    ['interviewers', () => withEvent({ interviewerIds: [FIXTURE_OTHER_INTERVIEWER_ID] })],
    ['scheduledBy id', () => schedule({ scheduledBy: makeAshbyUser({ id: uuidFor(77), email: 'recruiter@example.invalid' }) })],
    ['scheduledBy removed', () => schedule({ scheduledBy: null })],
    ['an extra event', () => schedule({ interviewEvents: twoEvents() })],
    ['candidate id', () => ({ ...schedule(), candidateId: FIXTURE_CANDIDATE_ID })],
  ])('changes when the %s changes', (_label, build) => {
    expect(fingerprintOf(build())).not.toBe(fingerprintOf(schedule()));
    expect(keyOf(build())).not.toBe(keyOf(schedule()));
  });

  it('keeps A -> B -> A distinct while Ashby bumps updatedAt, and converges on retries', () => {
    const a1 = schedule({ updatedAt: '2026-11-20T10:00:00Z', interviewEvents: [makeAshbyInterviewEvent({ updatedAt: null })] });
    const b = schedule({
      updatedAt: '2026-11-20T10:05:00Z',
      interviewEvents: [makeAshbyInterviewEvent({ updatedAt: null, startTime: '2026-12-01T12:00:00Z', endTime: '2026-12-01T12:45:00Z' })],
    });
    const a2 = schedule({ updatedAt: '2026-11-20T10:10:00Z', interviewEvents: [makeAshbyInterviewEvent({ updatedAt: null })] });
    const keys = [keyOf(a1), keyOf(b), keyOf(a2)];
    expect(new Set(keys).size).toBe(3);
    expect(keyOf(reverseKeys(a1))).toBe(keys[0]);
    expect(keyOf(a2)).toBe(keys[2]);
  });

  it('never includes the email or any name in the key', () => {
    const key = keyOf(schedule());
    expect(key).not.toMatch(/@|example|recruiter/i);
  });
});

// ── Selector ────────────────────────────────────────────────────────────────

describe('selectR1MeetDexEvents', () => {
  const decisionOf = (raw: unknown, nowMs = NOW_MS) => {
    const selections = selectR1MeetDexEvents(parseOk(raw), nowMs);
    expect(selections).toHaveLength(1);
    return selections[0]!.decision;
  };
  const noDex = { interviewerIds: [FIXTURE_OTHER_INTERVIEWER_ID] };
  const startMs = Date.parse(FIXTURE_START_TIME);

  it.each([
    ['the fixture', () => schedule(), 'eligible'],
    ['Dex not an interviewer', () => withEvent(noDex), 'dex_absent'],
    ['status Cancelled', () => schedule({ status: 'Cancelled' }), 'cancelled'],
    ['status WaitingOnFeedback', () => schedule({ status: 'WaitingOnFeedback' }), 'not_scheduled'],
    ['status Complete', () => schedule({ status: 'Complete' }), 'not_scheduled'],
    ['status Unknown', () => schedule({ status: 'Unknown' }), 'not_scheduled'],
    ['no scheduler', () => schedule({ scheduledBy: null }), 'no_attester'],
    ['no meeting link', () => withEvent({ meetingLink: null }), 'no_meet_link'],
    ['a Zoom link', () => withEvent({ meetingLink: 'https://example.zoom.us/j/1234567890' }), 'no_meet_link'],
    // Two conditions at once: the earlier decision wins.
    ['Cancelled + Dex absent', () => schedule({ status: 'Cancelled', interviewEvents: [makeAshbyInterviewEvent(noDex)] }), 'dex_absent'],
    ['Cancelled + no Meet link', () => schedule({ status: 'Cancelled', interviewEvents: [makeAshbyInterviewEvent({ meetingLink: null })] }), 'cancelled'],
    ['Cancelled + no scheduler', () => schedule({ status: 'Cancelled', scheduledBy: null }), 'cancelled'],
    ['OnHold + no scheduler', () => schedule({ status: 'OnHold', scheduledBy: null }), 'not_scheduled'],
    ['no scheduler + no Meet link', () => schedule({ scheduledBy: null, interviewEvents: [makeAshbyInterviewEvent({ meetingLink: null })] }), 'no_attester'],
    ['no Meet link + in the past', () => withEvent({ meetingLink: null, startTime: '2026-11-01T10:30:00Z', endTime: '2026-11-01T11:00:00Z' }), 'no_meet_link'],
    ['in the past', () => withEvent({ startTime: '2026-11-01T10:30:00Z', endTime: '2026-11-01T11:00:00Z' }), 'in_past'],
  ] as const)('%s -> %s', (_label, build, expected) => {
    expect(decisionOf(build())).toBe(expected);
  });

  it('a start equal to now is in_past; one millisecond before is eligible', () => {
    expect(decisionOf(schedule(), startMs)).toBe('in_past');
    expect(decisionOf(schedule(), startMs - 1)).toBe('eligible');
  });

  it.each([[Number.NaN], [Number.POSITIVE_INFINITY], [Number.NEGATIVE_INFINITY], ['now' as unknown as number]])(
    'a broken clock (%s) makes every Dex event in_past',
    (nowMs) => {
      const raw = schedule({
        interviewEvents: [
          makeAshbyInterviewEvent(),
          makeAshbyInterviewEvent({ id: uuidFor(6), startTime: '2026-12-02T10:30:00Z', endTime: '2026-12-02T11:00:00Z' }),
          makeAshbyInterviewEvent({ id: uuidFor(7), startTime: '2026-12-03T10:30:00Z', endTime: '2026-12-03T11:00:00Z', ...noDex }),
        ],
      });
      expect(selectR1MeetDexEvents(parseOk(raw), nowMs).map((s) => s.decision)).toEqual(['in_past', 'in_past', 'dex_absent']);
    },
  );

  it('gives one decision per event in event order, with the event fields', () => {
    const nonDex = makeAshbyInterviewEvent({
      id: uuidFor(8),
      interviewId: uuidFor(9),
      startTime: '2026-12-01T12:00:00Z',
      endTime: '2026-12-01T12:30:00Z',
      meetingLink: 'https://meet.google.com/xyz-wxyz-xyz',
      ...noDex,
    });
    const parsed = parseOk(schedule({ interviewEvents: [nonDex, makeAshbyInterviewEvent()] }));
    const selections = selectR1MeetDexEvents(parsed, NOW_MS);
    expect(selections).toStrictEqual([
      {
        eventId: FIXTURE_EVENT_ID,
        interviewId: FIXTURE_INTERVIEW_ID,
        decision: 'eligible',
        startTime: FIXTURE_START_TIME,
        endTime: FIXTURE_END_TIME,
        meetUrl: FIXTURE_MEET_URL,
      },
      {
        eventId: uuidFor(8),
        interviewId: uuidFor(9),
        decision: 'dex_absent',
        startTime: '2026-12-01T12:00:00.000Z',
        endTime: '2026-12-01T12:30:00.000Z',
        meetUrl: 'https://meet.google.com/xyz-wxyz-xyz',
      },
    ]);
    expect(isDeepFrozen(selections)).toBe(true);
    expect(Object.isFrozen(selections)).toBe(true);

    const eligible = r1MeetEligibleDexEvents(selections);
    expect(eligible).toStrictEqual([selections[0]]);
    expect(Object.isFrozen(eligible)).toBe(true);
    expect(r1MeetEligibleDexEvents(selectR1MeetDexEvents(parseOk(schedule({ status: 'Cancelled' })), NOW_MS))).toEqual([]);
  });

  it('an empty schedule gives no decisions', () => {
    expect(selectR1MeetDexEvents(parseOk(schedule({ interviewEvents: [] })), NOW_MS)).toEqual([]);
  });

  it('every decision it can return is in the contract list', () => {
    const seen = new Set<string>();
    for (const status of [...ASHBY_INTERVIEW_SCHEDULE_STATUSES, 'Unknown']) {
      for (const scheduledBy of [undefined, null]) {
        for (const meetingLink of [undefined, null]) {
          for (const interviewerIds of [undefined, [FIXTURE_OTHER_INTERVIEWER_ID]]) {
            for (const nowMs of [NOW_MS, startMs]) {
              const raw = schedule({ status, scheduledBy, interviewEvents: [makeAshbyInterviewEvent({ meetingLink, interviewerIds })] });
              for (const selection of selectR1MeetDexEvents(parseOk(raw), nowMs)) seen.add(selection.decision);
            }
          }
        }
      }
    }
    expect([...seen].sort()).toEqual([...R1_MEET_DEX_EVENT_DECISIONS].sort());
  });

  it('never throws on an unreadable schedule', () => {
    expect(selectR1MeetDexEvents(null as never, NOW_MS)).toEqual([]);
    expect(selectR1MeetDexEvents({} as never, NOW_MS)).toEqual([]);
    const hostile = new Proxy({}, { get: () => { throw new Error('boom'); } });
    expect(selectR1MeetDexEvents(hostile as never, NOW_MS)).toEqual([]);
  });
});

// ── Never throws ────────────────────────────────────────────────────────────

describe('never throws', () => {
  const throwingProxy = (target: object) =>
    new Proxy(target, {
      get: () => {
        throw new Error('boom');
      },
    });

  it('a Proxy that throws on property access is malformed_schedule', () => {
    expect(parseR1MeetAshbySchedule(throwingProxy({}), OPTIONS)).toStrictEqual({ ok: false, reason: 'malformed_schedule' });
    expect(parseR1MeetAshbyScheduleWebhook(throwingProxy({}), OPTIONS)).toStrictEqual({ ok: false, reason: 'malformed_schedule' });
  });

  it('a throwing getter anywhere is malformed_schedule', () => {
    const onStatus = schedule();
    Object.defineProperty(onStatus, 'status', { enumerable: true, get: () => { throw new Error('boom'); } });
    expect(parseReason(onStatus)).toBe('malformed_schedule');

    const inEvent = schedule();
    Object.defineProperty((inEvent.interviewEvents as object[])[0]!, 'meetingLink', {
      enumerable: true,
      get: () => {
        throw new Error('boom');
      },
    });
    expect(parseReason(inEvent)).toBe('malformed_schedule');

    const options = {};
    Object.defineProperty(options, 'dexUserId', { get: () => { throw new Error('boom'); } });
    expect(parseReason(schedule(), options as never)).toBe('malformed_schedule');

    const body = makeAshbyScheduleWebhookBody('interviewScheduleCreate');
    Object.defineProperty(body, 'data', { get: () => { throw new Error('boom'); } });
    expect(parseR1MeetAshbyScheduleWebhook(body, OPTIONS)).toStrictEqual({ ok: false, reason: 'malformed_schedule' });
  });

  it('a revoked Proxy is refused, not thrown', () => {
    const { proxy, revoke } = Proxy.revocable({}, {});
    revoke();
    expect(parseR1MeetAshbySchedule(proxy, OPTIONS).ok).toBe(false);
    expect(parseR1MeetAshbyScheduleWebhook(proxy, OPTIONS).ok).toBe(false);
  });

  it.each([
    ['undefined', undefined],
    ['null', null],
    ['a string', 'schedule'],
    ['a number', 0],
    ['an array', [schedule()]],
    ['a Date', new Date(0)],
    ['a class instance', new (class Schedule {})()],
    ['an object with a custom prototype', Object.create({ id: FIXTURE_SCHEDULE_ID }) as object],
  ])('refuses %s as not_object', (_label, raw) => {
    expect(parseR1MeetAshbySchedule(raw, OPTIONS)).toStrictEqual({ ok: false, reason: 'not_object' });
  });

  it('accepts a null-prototype object', () => {
    const raw = Object.assign(Object.create(null) as Record<string, unknown>, schedule());
    expect(parseOk(raw)).toStrictEqual(EXPECTED_SCHEDULE);
  });
});
