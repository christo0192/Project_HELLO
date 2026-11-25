/**
 * M034 S06 T1: the `r1-meet` job contract (lib/r1/meet/jobs.ts). M034 S09 T1 adds the twelfth kind,
 * `scorecard_feedback`.
 *
 * Pinned here:
 *  - the queue name, the twelve kinds, the attempts and the dedup keys, with the ones migration 0142
 *    hard-codes read from the SQL;
 *  - the payloads the S03 receivers write, spelled out literally in S03's key order (S03 is not in this
 *    branch, so nothing of it is imported), plus `receipt_id` and `source` as `r1_meet_record_receipt`
 *    adds them;
 *  - every known field of every kind is checked, unknown keys are ignored, and anything that is not a
 *    plain object of that kind is refused without a throw;
 *  - the two rules that keep an `event` job from cancelling the booking it creates;
 *  - the deferral bound, the job facts and the error that is only ever a code.
 */

import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { R1_MEET_ASHBY_MAX_EVENTS, R1_MEET_DEX_EVENT_DECISIONS } from '../lib/r1/meet/ashby-schedule.js';
import { R1_MEET_BOOKING_REASONS } from '../lib/r1/meet/bookings-read.js';
import { R1_MEET_REALTIME_EVENTS } from '../lib/r1/meet/recall-bot.js';
import {
  R1MeetJobError,
  R1_MEET_DB_ERROR,
  R1_MEET_DEFER_MAX_COUNT,
  R1_MEET_DEFER_MAX_MS,
  R1_MEET_JOB_KINDS,
  R1_MEET_JOB_MAX_ATTEMPTS,
  R1_MEET_JOB_PARSERS,
  R1_MEET_MALFORMED_PAYLOAD,
  R1_MEET_MAX_TICKET_ARMS,
  R1_MEET_MAX_VERSION,
  R1_MEET_QUEUE,
  R1_MEET_RECALL_BOT_EVENTS,
  R1_MEET_RECALL_PARTICIPANT_EVENTS,
  R1_MEET_RERUN_MAX_N,
  R1_MEET_RERUN_REASONS,
  R1_MEET_RPC_UNEXPECTED,
  R1_MEET_SCHEDULE_SCOPE_DECISIONS,
  R1_MEET_UNKNOWN_KIND,
  canDeferR1MeetJob,
  parseAshbyScheduleJob,
  parseDrainJob,
  parseRecallEventJob,
  parseScorecardFeedbackJob,
  r1MeetDedupKeys,
  r1MeetDefer,
  r1MeetIgnored,
  r1MeetJobMeta,
  r1MeetJobs,
  r1MeetPayloadKind,
  r1MeetProcessed,
  r1MeetReceiptId,
  type R1MeetJobKind,
} from '../lib/r1/meet/jobs.js';
import { isValidDeferReason } from '../lib/queue/types.js';
import { sanitizeErrorCode } from '../lib/queue/runner.js';

type Payload = Record<string, unknown>;

const id = (n: string): string => `7f000000-0000-4000-8000-0000000000${n}`;
const EVENT = id('a1');
const EVENT_2 = id('a2');
const SCHEDULE = id('b1');
const APPLICATION = id('b2');
const STAGE = id('b3');
const INTERVIEW = id('b4');
const SCHEDULER = id('b5');
const RECEIPT = id('c1');
const BOT = id('d1');
const BOOKING = id('d2');
const ROUND = id('d3');
const SESSION = id('d4');
const ASSESSMENT = id('d5');
const MEET_URL = 'https://meet.google.com/abc-defg-hij';

/** S03 `R1_MEET_ASHBY_SCHEDULE_PAYLOAD_KEYS`, written out. */
const ASHBY_KEYS = [
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
const RECALL_KEYS = ['kind', 'event_type', 'recall_bot_id', 'booking_id', 'occurred_at', 'sub_code', 'participant'];

/** S03's event job (R9a), plus what `r1_meet_record_receipt` adds. */
const eventJob = (over: Payload = {}): Payload => ({
  kind: 'ashby_schedule',
  scope: 'event',
  ashby_interview_event_id: EVENT,
  ashby_schedule_id: SCHEDULE,
  ashby_application_id: APPLICATION,
  ashby_interview_stage_id: STAGE,
  ashby_interview_id: INTERVIEW,
  ashby_scheduled_by_user_id: SCHEDULER,
  ashby_updated_at: '2030-01-01T09:00:00.000Z',
  decision: 'eligible',
  start_at: '2030-01-02T10:00:00.000Z',
  end_at: '2030-01-02T10:45:00.000Z',
  meet_url: MEET_URL,
  received_at: '2030-01-01T09:00:02.500Z',
  ashby_schedule_event_ids: [EVENT, EVENT_2],
  ashby_dex_event_ids: [EVENT],
  receipt_id: RECEIPT,
  source: 'ashby',
  ...over,
});

/** S03's schedule job (R9 c/d after the fix round: no candidate-linked id). */
const scheduleJob = (over: Payload = {}): Payload => ({
  kind: 'ashby_schedule',
  scope: 'schedule',
  ashby_interview_event_id: null,
  ashby_schedule_id: SCHEDULE,
  ashby_application_id: null,
  ashby_interview_stage_id: null,
  ashby_interview_id: null,
  ashby_scheduled_by_user_id: null,
  ashby_updated_at: '2030-01-01T09:00:00.000Z',
  decision: 'dex_absent',
  start_at: null,
  end_at: null,
  meet_url: null,
  received_at: '2030-01-01T09:00:02.500Z',
  ashby_schedule_event_ids: [EVENT_2],
  ashby_dex_event_ids: [],
  receipt_id: RECEIPT,
  source: 'ashby',
  ...over,
});

/** S03's identity job (R9e): the schedule was cancelled and its events were unreadable. */
const identityJob = (over: Payload = {}): Payload => ({
  kind: 'ashby_schedule',
  scope: 'schedule',
  ashby_interview_event_id: null,
  ashby_schedule_id: SCHEDULE,
  ashby_application_id: null,
  ashby_interview_stage_id: null,
  ashby_interview_id: null,
  ashby_scheduled_by_user_id: null,
  ashby_updated_at: null,
  decision: 'cancelled',
  start_at: null,
  end_at: null,
  meet_url: null,
  received_at: '2030-01-01T09:00:02.500Z',
  ashby_schedule_event_ids: null,
  ashby_dex_event_ids: null,
  receipt_id: RECEIPT,
  source: 'ashby',
  ...over,
});

/** S03's bot status event. */
const botEvent = (over: Payload = {}): Payload => ({
  kind: 'recall_event',
  event_type: 'bot.call_ended',
  recall_bot_id: BOT,
  booking_id: BOOKING,
  occurred_at: '2030-01-02T10:00:01.234Z',
  sub_code: 'timeout_exceeded_everyone_left',
  participant: null,
  receipt_id: RECEIPT,
  source: 'recall',
  ...over,
});

/** S03's participant event: no name, no email. */
const participantEvent = (over: Payload = {}): Payload => ({
  kind: 'recall_event',
  event_type: 'participant_events.join',
  recall_bot_id: BOT,
  booking_id: null,
  occurred_at: null,
  sub_code: null,
  participant: { id: 100, is_host: true, is_bot: null },
  receipt_id: RECEIPT,
  source: 'recall',
  ...over,
});

const without = (payload: Payload, key: string): Payload => {
  const copy = { ...payload };
  delete copy[key];
  return copy;
};

const NOT_UUIDS: unknown[] = [null, '', 'abc', EVENT.slice(0, -1), `${EVENT}0`, `{${EVENT}}`, EVENT.replace(/-/g, ''), ` ${EVENT}`, 7, {}, [EVENT], true];
const NOT_UUIDS_OR_NULL = NOT_UUIDS.filter((value) => value !== null);
const NOT_INSTANTS: unknown[] = ['', 'soon', '2030-01-01', '2030-01-01T10:00:00', '2030-13-01T10:00:00Z', 1893456000000, {}, true];

const here = path.dirname(fileURLToPath(import.meta.url));
const sql = readFileSync(path.resolve(here, '../../../supabase/migrations/0142_r1_meet_bookings.sql'), 'utf8')
  .replace(/\r\n/g, '\n')
  .replace(/^\s*--.*$/gm, '')
  .replace(/\s+/g, ' ');

describe('the r1-meet queue contract', () => {
  it('has one queue, twelve kinds and one parser per kind', () => {
    expect(R1_MEET_QUEUE).toBe('r1-meet');
    expect([...R1_MEET_JOB_KINDS]).toEqual([
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
    ]);
    expect(Object.keys(R1_MEET_JOB_PARSERS)).toEqual([...R1_MEET_JOB_KINDS]);
    expect(Object.keys(R1_MEET_JOB_MAX_ATTEMPTS)).toEqual([...R1_MEET_JOB_KINDS]);
    for (const frozen of [R1_MEET_JOB_KINDS, R1_MEET_JOB_PARSERS, R1_MEET_JOB_MAX_ATTEMPTS, R1_MEET_RERUN_REASONS, r1MeetDedupKeys, r1MeetJobs]) {
      expect(Object.isFrozen(frozen)).toBe(true);
    }
    // The kinds fit the rule of r1_meet_record_receipt.
    for (const kind of R1_MEET_JOB_KINDS) expect(r1MeetPayloadKind({ kind })).toBe(kind);
  });

  it('agrees with migration 0142 on the queue name, the trigger keys and kinds, and the attempts', () => {
    expect(R1_MEET_JOB_MAX_ATTEMPTS).toEqual({
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
      scorecard_feedback: 5,
    });
    expect(sql).toContain(
      "values ('r1-meet', jsonb_build_object('kind', 'bot_release', 'recall_bot_id', old.recall_bot_id, 'booking_id', old.id), "
      + "'r1-meet:bot-release:' || old.recall_bot_id::text, 10)",
    );
    expect(sql).toContain(
      "select 'r1-meet', jsonb_build_object('kind', 'round_cancelled', 'booking_id', b.id, 'round_id', new.id), "
      + "'r1-meet:round-cancelled:' || b.id::text, 10",
    );
    // r1_meet_record_receipt: five attempts, and the two keys it adds to every S03 payload (and to the
    // S09 scorecard_feedback payload, which it also writes: hence its five attempts).
    expect(sql).toContain(
      "('r1-meet', p_payload || jsonb_build_object('receipt_id', v_id, 'source', p_source), "
      + "'pending', 'r1-meet:receipt:' || v_id::text, 0, 5, 0,",
    );
    expect(sql).toContain(`check (version between 0 and ${R1_MEET_MAX_VERSION})`);
    expect(sql).toContain(`check (ticket_arms between 0 and ${R1_MEET_MAX_TICKET_ARMS})`);
  });

  it('uses the S01 event and decision vocabulary', () => {
    expect([...R1_MEET_RECALL_PARTICIPANT_EVENTS]).toEqual([...R1_MEET_REALTIME_EVENTS]);
    expect(R1_MEET_RECALL_BOT_EVENTS).toHaveLength(9);
    for (const decision of R1_MEET_SCHEDULE_SCOPE_DECISIONS) expect(R1_MEET_DEX_EVENT_DECISIONS).toContain(decision);
    for (const reason of R1_MEET_RERUN_REASONS) expect(R1_MEET_BOOKING_REASONS).toContain(reason);
  });
});

describe('ashby_schedule, scope event', () => {
  it('accepts the exact S03 payload, in S03 key order plus receipt_id and source', () => {
    expect(Object.keys(eventJob())).toEqual([...ASHBY_KEYS, 'receipt_id', 'source']);
    const job = parseAshbyScheduleJob(eventJob());
    expect(job).toEqual({
      kind: 'ashby_schedule',
      scope: 'event',
      eventId: EVENT,
      scheduleId: SCHEDULE,
      applicationId: APPLICATION,
      interviewStageId: STAGE,
      interviewId: INTERVIEW,
      scheduledByUserId: SCHEDULER,
      ashbyUpdatedAt: '2030-01-01T09:00:00.000Z',
      decision: 'eligible',
      startAt: '2030-01-02T10:00:00.000Z',
      endAt: '2030-01-02T10:45:00.000Z',
      meetUrl: MEET_URL,
      receivedAt: '2030-01-01T09:00:02.500Z',
      scheduleEventIds: [EVENT, EVENT_2],
      dexEventIds: [EVENT],
    });
    expect(Object.isFrozen(job)).toBe(true);
    expect(Object.isFrozen((job as { dexEventIds: unknown }).dexEventIds)).toBe(true);
  });

  it('survives a JSON round trip (as the queue stores it)', () => {
    expect(parseAshbyScheduleJob(JSON.parse(JSON.stringify(eventJob())))).toEqual(parseAshbyScheduleJob(eventJob()));
  });

  it('lower-cases the event ids, keeps the Ashby text ids verbatim, and makes instants canonical', () => {
    const job = parseAshbyScheduleJob(
      eventJob({
        ashby_interview_event_id: EVENT.toUpperCase(),
        ashby_schedule_id: SCHEDULE.toUpperCase(),
        ashby_application_id: APPLICATION.toUpperCase(),
        ashby_interview_stage_id: STAGE.toUpperCase(),
        ashby_interview_id: INTERVIEW.toUpperCase(),
        ashby_scheduled_by_user_id: SCHEDULER.toUpperCase(),
        ashby_schedule_event_ids: [EVENT.toUpperCase(), EVENT_2.toUpperCase()],
        ashby_dex_event_ids: [EVENT.toUpperCase()],
        ashby_updated_at: '2030-01-01T14:30:00+05:30',
        start_at: '2030-01-02T15:30:00+05:30',
        received_at: '2030-01-01T09:00:02.500123+00:00',
      }),
    );
    expect(job).toMatchObject({
      eventId: EVENT,
      scheduleId: SCHEDULE.toUpperCase(),
      applicationId: APPLICATION.toUpperCase(),
      interviewStageId: STAGE.toUpperCase(),
      interviewId: INTERVIEW.toUpperCase(),
      scheduledByUserId: SCHEDULER.toUpperCase(),
      scheduleEventIds: [EVENT, EVENT_2],
      dexEventIds: [EVENT],
      ashbyUpdatedAt: '2030-01-01T09:00:00.000Z',
      startAt: '2030-01-02T10:00:00.000Z',
      receivedAt: '2030-01-01T09:00:02.500Z',
    });
  });

  it('accepts every S01 decision; only eligible needs the Meet URL and the scheduler', () => {
    for (const decision of R1_MEET_DEX_EVENT_DECISIONS) {
      const bare = eventJob({ decision, meet_url: null, ashby_scheduled_by_user_id: null });
      const job = parseAshbyScheduleJob(bare);
      if (decision === 'eligible') expect(job, decision).toBeNull();
      else expect(job, decision).toMatchObject({ decision, meetUrl: null, scheduledByUserId: null });
      expect(parseAshbyScheduleJob(eventJob({ decision })), decision).toMatchObject({ decision, meetUrl: MEET_URL });
    }
    expect(parseAshbyScheduleJob(eventJob({ meet_url: null }))).toBeNull();
    expect(parseAshbyScheduleJob(eventJob({ ashby_scheduled_by_user_id: null }))).toBeNull();
  });

  it('accepts the fields S03 may leave null', () => {
    const job = parseAshbyScheduleJob(
      eventJob({ ashby_interview_stage_id: null, ashby_interview_id: null, ashby_updated_at: null, received_at: null }),
    );
    expect(job).toMatchObject({ interviewStageId: null, interviewId: null, ashbyUpdatedAt: null, receivedAt: null });
  });

  const malformed: Record<string, unknown[]> = {
    kind: [null, 'ashby', 'recall_event', 7],
    scope: [null, 'booking', 'EVENT', 7],
    ashby_interview_event_id: NOT_UUIDS,
    ashby_schedule_id: NOT_UUIDS,
    ashby_application_id: NOT_UUIDS,
    ashby_interview_stage_id: NOT_UUIDS_OR_NULL,
    ashby_interview_id: NOT_UUIDS_OR_NULL,
    ashby_scheduled_by_user_id: NOT_UUIDS_OR_NULL,
    ashby_updated_at: NOT_INSTANTS,
    decision: [null, 'Eligible', 'attach', 'multiple_humans', 7],
    start_at: [null, ...NOT_INSTANTS, '2030-01-02T10:45:00.000Z', '2030-01-02T11:00:00.000Z'],
    end_at: [null, ...NOT_INSTANTS, '2030-01-02T10:00:00.000Z', '2030-01-02T09:00:00.000Z'],
    meet_url: [
      null,
      '',
      `${MEET_URL}/`,
      `${MEET_URL}?authuser=0`,
      'https://MEET.google.com/abc-defg-hij',
      'http://meet.google.com/abc-defg-hij',
      'https://meet.google.com.evil.test/abc-defg-hij',
      'https://zoom.example.test/j/1',
      7,
    ],
    received_at: NOT_INSTANTS,
    ashby_schedule_event_ids: [null, 'x', {}, [null], ['x'], [EVENT, 7], Array.from({ length: R1_MEET_ASHBY_MAX_EVENTS + 1 }, () => EVENT)],
    ashby_dex_event_ids: [null, 'x', {}, [], [EVENT_2], [EVENT, 'x'], Array.from({ length: R1_MEET_ASHBY_MAX_EVENTS + 1 }, () => EVENT)],
  };

  it.each(ASHBY_KEYS)('refuses a malformed or absent %s', (key) => {
    expect(malformed[key], key).toBeDefined();
    for (const bad of malformed[key]!) {
      expect(parseAshbyScheduleJob(eventJob({ [key]: bad })), `${key} = ${JSON.stringify(bad)}`).toBeNull();
    }
    expect(parseAshbyScheduleJob(without(eventJob(), key)), `${key} absent`).toBeNull();
  });

  it('takes twenty ids, and a Meet URL that is canonical whatever the decision', () => {
    const ids = [EVENT, ...Array.from({ length: R1_MEET_ASHBY_MAX_EVENTS - 1 }, () => EVENT_2)];
    expect(parseAshbyScheduleJob(eventJob({ ashby_schedule_event_ids: ids, ashby_dex_event_ids: ids }))).not.toBeNull();
    expect(parseAshbyScheduleJob(eventJob({ decision: 'in_past', meet_url: `${MEET_URL}/` }))).toBeNull();
  });

  it('refuses a job that would cancel its own booking: no lists, or itself outside its Dex list', () => {
    expect(parseAshbyScheduleJob(eventJob({ ashby_schedule_event_ids: null, ashby_dex_event_ids: null }))).toBeNull();
    for (const decision of R1_MEET_DEX_EVENT_DECISIONS) {
      const job = parseAshbyScheduleJob(eventJob({ decision, ashby_dex_event_ids: [EVENT_2] }));
      if (decision === 'dex_absent') expect(job, decision).not.toBeNull();
      else expect(job, decision).toBeNull();
    }
  });
});

describe('ashby_schedule, scope schedule', () => {
  it('accepts the exact S03 schedule payload and carries no candidate-linked id', () => {
    expect(Object.keys(scheduleJob())).toEqual([...ASHBY_KEYS, 'receipt_id', 'source']);
    const job = parseAshbyScheduleJob(scheduleJob());
    expect(job).toEqual({
      kind: 'ashby_schedule',
      scope: 'schedule',
      scheduleId: SCHEDULE,
      ashbyUpdatedAt: '2030-01-01T09:00:00.000Z',
      receivedAt: '2030-01-01T09:00:02.500Z',
      decision: 'dex_absent',
      scheduleEventIds: [EVENT_2],
      dexEventIds: [],
    });
    expect(Object.isFrozen(job)).toBe(true);
    // Well-formed ids there are tolerated and dropped; malformed ones are a malformed job.
    const withIds = scheduleJob({ ashby_application_id: APPLICATION, ashby_interview_stage_id: STAGE, ashby_scheduled_by_user_id: SCHEDULER });
    expect(parseAshbyScheduleJob(withIds)).toEqual(job);
    for (const key of ['ashby_application_id', 'ashby_interview_stage_id', 'ashby_scheduled_by_user_id']) {
      expect(parseAshbyScheduleJob(scheduleJob({ [key]: 'x' })), key).toBeNull();
    }
  });

  it('accepts the exact S03 identity payload (null lists, possibly no updatedAt)', () => {
    expect(Object.keys(identityJob())).toEqual([...ASHBY_KEYS, 'receipt_id', 'source']);
    expect(parseAshbyScheduleJob(identityJob())).toEqual({
      kind: 'ashby_schedule',
      scope: 'schedule',
      scheduleId: SCHEDULE,
      ashbyUpdatedAt: null,
      receivedAt: '2030-01-01T09:00:02.500Z',
      decision: 'cancelled',
      scheduleEventIds: null,
      dexEventIds: null,
    });
  });

  it('allows only cancelled and dex_absent', () => {
    for (const decision of R1_MEET_DEX_EVENT_DECISIONS) {
      const ok = decision === 'cancelled' || decision === 'dex_absent';
      expect(parseAshbyScheduleJob(scheduleJob({ decision })) !== null, decision).toBe(ok);
    }
    expect(parseAshbyScheduleJob(scheduleJob({ decision: null }))).toBeNull();
  });

  it('refuses a value in an event field, and one list without the other', () => {
    const values: Payload = {
      ashby_interview_event_id: EVENT,
      ashby_interview_id: INTERVIEW,
      start_at: '2030-01-02T10:00:00.000Z',
      end_at: '2030-01-02T10:45:00.000Z',
      meet_url: MEET_URL,
    };
    for (const [key, value] of Object.entries(values)) {
      expect(parseAshbyScheduleJob(scheduleJob({ [key]: value })), key).toBeNull();
    }
    expect(parseAshbyScheduleJob(scheduleJob({ ashby_schedule_event_ids: null }))).toBeNull();
    expect(parseAshbyScheduleJob(scheduleJob({ ashby_dex_event_ids: null }))).toBeNull();
  });

  it.each(ASHBY_KEYS)('refuses an absent %s', (key) => {
    expect(parseAshbyScheduleJob(without(scheduleJob(), key))).toBeNull();
    expect(parseAshbyScheduleJob(without(identityJob(), key))).toBeNull();
  });

  it('refuses malformed values in the fields it reads', () => {
    for (const bad of NOT_UUIDS) expect(parseAshbyScheduleJob(scheduleJob({ ashby_schedule_id: bad })), String(bad)).toBeNull();
    for (const bad of NOT_INSTANTS) {
      expect(parseAshbyScheduleJob(scheduleJob({ ashby_updated_at: bad })), String(bad)).toBeNull();
      expect(parseAshbyScheduleJob(scheduleJob({ received_at: bad })), String(bad)).toBeNull();
    }
    for (const bad of ['x', {}, [null], ['x']]) {
      expect(parseAshbyScheduleJob(scheduleJob({ ashby_schedule_event_ids: bad })), JSON.stringify(bad)).toBeNull();
      expect(parseAshbyScheduleJob(scheduleJob({ ashby_dex_event_ids: bad })), JSON.stringify(bad)).toBeNull();
    }
  });
});

describe('recall_event', () => {
  it('accepts the exact S03 bot payload', () => {
    expect(Object.keys(botEvent())).toEqual([...RECALL_KEYS, 'receipt_id', 'source']);
    const job = parseRecallEventJob(botEvent());
    expect(job).toEqual({
      kind: 'recall_event',
      eventType: 'bot.call_ended',
      recallBotId: BOT,
      bookingId: BOOKING,
      occurredAt: '2030-01-02T10:00:01.234Z',
      subCode: 'timeout_exceeded_everyone_left',
      participant: null,
    });
    expect(Object.isFrozen(job)).toBe(true);
  });

  it('accepts the exact S03 participant payload', () => {
    expect(Object.keys(participantEvent())).toEqual([...RECALL_KEYS, 'receipt_id', 'source']);
    const job = parseRecallEventJob(participantEvent());
    expect(job).toEqual({
      kind: 'recall_event',
      eventType: 'participant_events.join',
      recallBotId: BOT,
      bookingId: null,
      occurredAt: null,
      subCode: null,
      participant: { id: 100, isHost: true, isBot: null },
    });
    expect(Object.isFrozen((job as { participant: unknown }).participant)).toBe(true);
    for (const person of [
      { id: null, is_host: null, is_bot: null },
      { id: 0, is_host: false, is_bot: true },
      // A name would be ignored, never read.
      { id: 7, is_host: null, is_bot: false, name: 'ignored' },
    ]) {
      expect(parseRecallEventJob(participantEvent({ participant: person }))).toMatchObject({
        participant: { id: person.id, isHost: person.is_host, isBot: person.is_bot },
      });
    }
    expect(JSON.stringify(parseRecallEventJob(participantEvent({ participant: { id: 7, is_host: null, is_bot: null, name: 'ignored' } })))).not.toContain('ignored');
  });

  it('accepts every bot event and both participant events, and nothing else', () => {
    for (const type of R1_MEET_RECALL_BOT_EVENTS) {
      expect(parseRecallEventJob(botEvent({ event_type: type })), type).toMatchObject({ eventType: type, participant: null });
      expect(parseRecallEventJob(participantEvent({ event_type: type })), `${type} with a participant`).toBeNull();
    }
    for (const type of R1_MEET_RECALL_PARTICIPANT_EVENTS) {
      expect(parseRecallEventJob(participantEvent({ event_type: type })), type).toMatchObject({ eventType: type });
      expect(parseRecallEventJob(botEvent({ event_type: type })), `${type} without a participant`).toBeNull();
    }
    for (const type of [null, '', 'bot.unknown', 'bot.breakout_room_entered', 'participant_events.update', 'BOT.DONE', 7]) {
      expect(parseRecallEventJob(botEvent({ event_type: type })), String(type)).toBeNull();
    }
  });

  it('lower-cases the ids, keeps an unknown sub-code, and canonicalises the instant', () => {
    expect(
      parseRecallEventJob(botEvent({ recall_bot_id: BOT.toUpperCase(), booking_id: BOOKING.toUpperCase(), sub_code: 'brand.new:code-1', occurred_at: '2030-01-02T15:30:01.2+05:30' })),
    ).toMatchObject({ recallBotId: BOT, bookingId: BOOKING, subCode: 'brand.new:code-1', occurredAt: '2030-01-02T10:00:01.200Z' });
  });

  const malformed: Record<string, unknown[]> = {
    kind: [null, 'bot', 'ashby_schedule'],
    event_type: [null, 'bot.nope'],
    recall_bot_id: NOT_UUIDS,
    booking_id: NOT_UUIDS_OR_NULL,
    occurred_at: NOT_INSTANTS,
    sub_code: ['', 'has space', 'x'.repeat(129), 7, {}],
    participant: [{}, { id: 1, is_host: null, is_bot: null }, 'x', []],
  };
  it.each(RECALL_KEYS)('refuses a malformed or absent %s', (key) => {
    for (const bad of malformed[key]!) {
      expect(parseRecallEventJob(botEvent({ [key]: bad })), `${key} = ${JSON.stringify(bad)}`).toBeNull();
    }
    expect(parseRecallEventJob(without(botEvent(), key)), `${key} absent`).toBeNull();
    expect(parseRecallEventJob(without(participantEvent(), key)), `${key} absent`).toBeNull();
  });

  it('refuses a malformed participant', () => {
    for (const bad of [
      null,
      [],
      'x',
      {},
      { id: 1, is_host: null },
      { id: 1, is_bot: null },
      { is_host: null, is_bot: null },
      { id: -1, is_host: null, is_bot: null },
      { id: 1.5, is_host: null, is_bot: null },
      { id: '1', is_host: null, is_bot: null },
      { id: 1, is_host: 'yes', is_bot: null },
      { id: 1, is_host: null, is_bot: 0 },
    ]) {
      expect(parseRecallEventJob(participantEvent({ participant: bad })), JSON.stringify(bad)).toBeNull();
    }
  });
});

/** The kinds written by the 0142 triggers, S06 or an operator: one valid payload and its parsed form. */
const SIMPLE: Array<{ kind: R1MeetJobKind; payload: Payload; parsed: Payload; bad: Record<string, unknown[]> }> = [
  {
    kind: 'bot_release',
    payload: { kind: 'bot_release', recall_bot_id: BOT, booking_id: BOOKING },
    parsed: { kind: 'bot_release', recallBotId: BOT, bookingId: BOOKING },
    bad: { recall_bot_id: NOT_UUIDS, booking_id: NOT_UUIDS },
  },
  {
    kind: 'round_cancelled',
    payload: { kind: 'round_cancelled', booking_id: BOOKING, round_id: ROUND },
    parsed: { kind: 'round_cancelled', bookingId: BOOKING, roundId: ROUND },
    bad: { booking_id: NOT_UUIDS, round_id: NOT_UUIDS },
  },
  {
    kind: 'booking_rerun',
    payload: { kind: 'booking_rerun', booking_id: BOOKING, reason: 'slot_too_far', n: 0 },
    parsed: { kind: 'booking_rerun', bookingId: BOOKING, reason: 'slot_too_far', n: 0 },
    bad: { booking_id: NOT_UUIDS, reason: [null, 'eligible', 'bot_cap_reached', 7], n: [null, -1, 1.5, '0', R1_MEET_RERUN_MAX_N + 1] },
  },
  {
    kind: 'ensure_bot',
    payload: { kind: 'ensure_bot', booking_id: BOOKING },
    parsed: { kind: 'ensure_bot', bookingId: BOOKING },
    bad: { booking_id: NOT_UUIDS },
  },
  {
    kind: 'attempt_ended',
    payload: { kind: 'attempt_ended', booking_id: BOOKING, session_id: SESSION },
    parsed: { kind: 'attempt_ended', bookingId: BOOKING, sessionId: SESSION },
    bad: { booking_id: NOT_UUIDS, session_id: NOT_UUIDS },
  },
  {
    kind: 'bridge_check',
    payload: { kind: 'bridge_check', booking_id: BOOKING, version: 3, arm: 2 },
    parsed: { kind: 'bridge_check', bookingId: BOOKING, version: 3, arm: 2 },
    bad: {
      booking_id: NOT_UUIDS,
      version: [null, -1, R1_MEET_MAX_VERSION + 1, 0.5, '3'],
      arm: [null, 0, R1_MEET_MAX_TICKET_ARMS + 1, 1.5, '2'],
    },
  },
  {
    kind: 'multi_human_check',
    payload: { kind: 'multi_human_check', booking_id: BOOKING, version: 0 },
    parsed: { kind: 'multi_human_check', bookingId: BOOKING, version: 0 },
    bad: { booking_id: NOT_UUIDS, version: [null, -1, R1_MEET_MAX_VERSION + 1, '0'] },
  },
  {
    kind: 'maintenance',
    payload: { kind: 'maintenance', bucket: 2103840 },
    parsed: { kind: 'maintenance', bucket: 2103840 },
    bad: { bucket: [null, -1, 1.5, '1', Number.NaN] },
  },
  {
    kind: 'drain',
    payload: { kind: 'drain' },
    parsed: { kind: 'drain', force: false },
    bad: { force: [null, 'true', 1, {}] },
  },
  {
    kind: 'scorecard_feedback',
    payload: { kind: 'scorecard_feedback', booking_id: BOOKING, assessment_id: ASSESSMENT },
    parsed: { kind: 'scorecard_feedback', bookingId: BOOKING, assessmentId: ASSESSMENT },
    bad: { booking_id: NOT_UUIDS, assessment_id: NOT_UUIDS },
  },
];

describe('the kinds of the triggers, S06 and the operator', () => {
  it.each(SIMPLE)('$kind: parses its payload, ignores extra keys, upper case and key order', ({ kind, payload, parsed }) => {
    const parse = R1_MEET_JOB_PARSERS[kind];
    expect(parse(payload)).toEqual(parsed);
    expect(Object.isFrozen(parse(payload))).toBe(true);
    expect(parse({ ...payload, receipt_id: RECEIPT, source: 'ashby', meet_url: MEET_URL, candidate_name: 'ignored' })).toEqual(parsed);
    expect(parse(Object.fromEntries(Object.entries(payload).reverse()))).toEqual(parsed);
    const upper = Object.fromEntries(
      Object.entries(payload).map(([key, value]) => [key, key.endsWith('_id') ? String(value).toUpperCase() : value]),
    );
    expect(parse(upper)).toEqual(parsed);
  });

  it.each(SIMPLE)('$kind: refuses every malformed or absent field', ({ kind, payload, bad }) => {
    const parse = R1_MEET_JOB_PARSERS[kind];
    for (const [key, values] of Object.entries(bad)) {
      for (const value of values) {
        expect(parse({ ...payload, [key]: value }), `${key} = ${JSON.stringify(value)}`).toBeNull();
      }
      if (key !== 'force') expect(parse(without(payload, key)), `${key} absent`).toBeNull();
    }
    expect(parse(without(payload, 'kind'))).toBeNull();
  });

  it('takes the boundaries', () => {
    const accept = (kind: R1MeetJobKind, payload: Payload): void => {
      expect(R1_MEET_JOB_PARSERS[kind]({ kind, ...payload }), JSON.stringify(payload)).not.toBeNull();
    };
    accept('bridge_check', { booking_id: BOOKING, version: R1_MEET_MAX_VERSION, arm: R1_MEET_MAX_TICKET_ARMS });
    accept('bridge_check', { booking_id: BOOKING, version: 0, arm: 1 });
    accept('maintenance', { bucket: 0 });
    for (const reason of R1_MEET_RERUN_REASONS) accept('booking_rerun', { booking_id: BOOKING, reason, n: R1_MEET_RERUN_MAX_N });
    expect(parseDrainJob({ kind: 'drain', force: true })).toEqual({ kind: 'drain', force: true });
    expect(parseDrainJob({ kind: 'drain', force: false })).toEqual({ kind: 'drain', force: false });
  });
});

const VALID_BY_KIND: Record<R1MeetJobKind, Payload> = {
  ashby_schedule: eventJob(),
  recall_event: botEvent(),
  ...Object.fromEntries(SIMPLE.map(({ kind, payload }) => [kind, payload])),
} as Record<R1MeetJobKind, Payload>;

describe('every parser', () => {
  it.each([...R1_MEET_JOB_KINDS])('%s: refuses non-objects, other kinds and hostile objects without a throw', (kind) => {
    const parse = R1_MEET_JOB_PARSERS[kind] as (payload: unknown) => unknown;
    expect(parse(VALID_BY_KIND[kind])).not.toBeNull();
    class Boxed {
      readonly kind = kind;
    }
    for (const payload of [null, undefined, '', 'x', JSON.stringify(VALID_BY_KIND[kind]), 0, 1, true, [], [VALID_BY_KIND[kind]], new Date(), new Map(), new Boxed(), () => VALID_BY_KIND[kind], {}]) {
      expect(parse(payload), String(payload)).toBeNull();
    }
    for (const other of R1_MEET_JOB_KINDS) {
      if (other !== kind) expect(parse({ ...VALID_BY_KIND[kind], kind: other }), other).toBeNull();
    }
    const throwing = new Proxy({ ...VALID_BY_KIND[kind] }, {
      get() {
        throw new Error('boom');
      },
    });
    expect(() => parse(throwing)).not.toThrow();
    expect(parse(throwing)).toBeNull();
  });

  it.each([...R1_MEET_JOB_KINDS])('%s: ignores unknown keys', (kind) => {
    const parse = R1_MEET_JOB_PARSERS[kind] as (payload: unknown) => unknown;
    expect(parse({ ...VALID_BY_KIND[kind], next_version_key: { anything: ['at', 'all'] } })).toEqual(parse(VALID_BY_KIND[kind]));
  });
});

describe('r1MeetPayloadKind and r1MeetReceiptId', () => {
  it('reads the kind, known or not (the dispatcher decides)', () => {
    expect(r1MeetPayloadKind({ kind: 'scorecard_feedback' })).toBe('scorecard_feedback');
    for (const payload of [null, undefined, 'drain', [], {}, { kind: null }, { kind: 7 }, { kind: '' }, { kind: 'Drain' }, { kind: 'has space' }, { kind: 'x'.repeat(41) }]) {
      expect(r1MeetPayloadKind(payload), JSON.stringify(payload)).toBeNull();
    }
    const throwing = new Proxy({}, { get: () => { throw new Error('boom'); }, getPrototypeOf: () => Object.prototype });
    expect(r1MeetPayloadKind(throwing)).toBeNull();
    expect(r1MeetReceiptId(throwing)).toBeNull();
  });

  it('reads the receipt id of any payload, even one that does not parse', () => {
    expect(r1MeetReceiptId(eventJob())).toBe(RECEIPT);
    expect(r1MeetReceiptId({ receipt_id: RECEIPT.toUpperCase() })).toBe(RECEIPT);
    expect(r1MeetReceiptId({ kind: 'nope', receipt_id: RECEIPT })).toBe(RECEIPT);
    for (const payload of [null, undefined, 'x', [], {}, { receipt_id: null }, { receipt_id: 'x' }, { receipt_id: 7 }]) {
      expect(r1MeetReceiptId(payload), JSON.stringify(payload)).toBeNull();
    }
  });
});

describe('dedup keys and the jobs S06 writes', () => {
  it('pins every key (ids lower-cased, as the 0142 triggers print a uuid)', () => {
    expect(r1MeetDedupKeys.botRelease(BOT.toUpperCase())).toBe(`r1-meet:bot-release:${BOT}`);
    expect(r1MeetDedupKeys.roundCancelled(BOOKING.toUpperCase())).toBe(`r1-meet:round-cancelled:${BOOKING}`);
    expect(r1MeetDedupKeys.rerun(BOOKING.toUpperCase(), 1893456000000.9)).toBe(`r1-meet:rerun:${BOOKING}:1893456000000`);
    expect(r1MeetDedupKeys.ensureBot(BOOKING.toUpperCase())).toBe(`r1-meet:ensure-bot:${BOOKING}`);
    expect(r1MeetDedupKeys.attemptEnded(SESSION.toUpperCase())).toBe(`r1-meet:attempt-ended:${SESSION}`);
    expect(r1MeetDedupKeys.bridgeCheck(BOOKING.toUpperCase(), 3, 2)).toBe(`r1-meet:bridge-check:${BOOKING}:v3:a2`);
    expect(r1MeetDedupKeys.multiHuman(BOOKING.toUpperCase(), 3)).toBe(`r1-meet:multi-human:${BOOKING}:v3`);
    expect(r1MeetDedupKeys.maintenance(2103840)).toBe('r1-meet:maintenance:2103840');
    expect(r1MeetDedupKeys.drain()).toBe('r1-meet:drain');
    expect(r1MeetDedupKeys.scorecardFeedback(BOOKING.toUpperCase(), ASSESSMENT.toUpperCase())).toBe(
      `r1-meet:scorecard-feedback:${BOOKING}:${ASSESSMENT}`,
    );
  });

  it('builds payloads that parse back, with the key and the attempts of their kind', () => {
    const at = Date.parse('2030-01-02T10:00:00Z');
    const specs = [
      [r1MeetJobs.botRelease(BOT, BOOKING), { recallBotId: BOT, bookingId: BOOKING }, `r1-meet:bot-release:${BOT}`],
      [r1MeetJobs.bookingRerun(BOOKING, 'paused', 2, at), { bookingId: BOOKING, reason: 'paused', n: 2 }, `r1-meet:rerun:${BOOKING}:${at}`],
      [r1MeetJobs.ensureBot(BOOKING), { bookingId: BOOKING }, `r1-meet:ensure-bot:${BOOKING}`],
      [r1MeetJobs.attemptEnded(BOOKING, SESSION), { bookingId: BOOKING, sessionId: SESSION }, `r1-meet:attempt-ended:${SESSION}`],
      [r1MeetJobs.bridgeCheck(BOOKING, 4, 1), { bookingId: BOOKING, version: 4, arm: 1 }, `r1-meet:bridge-check:${BOOKING}:v4:a1`],
      [r1MeetJobs.multiHumanCheck(BOOKING, 4), { bookingId: BOOKING, version: 4 }, `r1-meet:multi-human:${BOOKING}:v4`],
      [r1MeetJobs.maintenance(12), { bucket: 12 }, 'r1-meet:maintenance:12'],
      [
        r1MeetJobs.scorecardFeedback(BOOKING, ASSESSMENT),
        { bookingId: BOOKING, assessmentId: ASSESSMENT },
        `r1-meet:scorecard-feedback:${BOOKING}:${ASSESSMENT}`,
      ],
    ] as const;
    for (const [spec, parsed, key] of specs) {
      const kind = spec.payload.kind;
      expect(R1_MEET_JOB_PARSERS[kind](spec.payload), kind).toEqual({ kind, ...parsed });
      expect(spec.dedupKey, kind).toBe(key);
      expect(spec.maxAttempts, kind).toBe(R1_MEET_JOB_MAX_ATTEMPTS[kind]);
      expect(Object.isFrozen(spec) && Object.isFrozen(spec.payload), kind).toBe(true);
      // Ids, counters and closed words only: no URL, no address, no free text.
      for (const value of Object.values(spec.payload)) expect(String(value), kind).toMatch(/^[a-z0-9_-]+$/);
    }
  });
});

describe('scorecard_feedback (M034 S09)', () => {
  /** What `r1_meet_record_receipt` enqueues for the S09 trigger: the payload plus receipt_id and source. */
  const receiptJob = (over: Payload = {}): Payload => ({
    kind: 'scorecard_feedback',
    booking_id: BOOKING,
    assessment_id: ASSESSMENT,
    receipt_id: RECEIPT,
    source: 'ashby',
    ...over,
  });

  it('parses the receipt job: ids lower-cased, receipt_id and source ignored, frozen', () => {
    const job = parseScorecardFeedbackJob(receiptJob({ booking_id: BOOKING.toUpperCase(), assessment_id: ASSESSMENT.toUpperCase() }));
    expect(job).toStrictEqual({ kind: 'scorecard_feedback', bookingId: BOOKING, assessmentId: ASSESSMENT });
    expect(Object.isFrozen(job)).toBe(true);
    expect(Object.keys(job!)).toEqual(['kind', 'bookingId', 'assessmentId']);
    // The receipt keys are never read: any value (or none) parses to the same job.
    expect(parseScorecardFeedbackJob(receiptJob({ receipt_id: 'not-a-uuid', source: 7 }))).toEqual(job);
    expect(parseScorecardFeedbackJob(without(without(receiptJob(), 'receipt_id'), 'source'))).toEqual(job);
    expect(R1_MEET_JOB_PARSERS.scorecard_feedback).toBe(parseScorecardFeedbackJob);
  });

  it('round-trips r1MeetJobs.scorecardFeedback, through JSON as the queue stores it', () => {
    const spec = r1MeetJobs.scorecardFeedback(BOOKING.toUpperCase(), ASSESSMENT.toUpperCase());
    expect(Object.keys(spec.payload)).toEqual(['kind', 'booking_id', 'assessment_id']);
    expect(parseScorecardFeedbackJob(JSON.parse(JSON.stringify(spec.payload)))).toStrictEqual({
      kind: 'scorecard_feedback',
      bookingId: BOOKING,
      assessmentId: ASSESSMENT,
    });
    expect(spec.dedupKey).toBe(`r1-meet:scorecard-feedback:${BOOKING}:${ASSESSMENT}`);
    expect(spec.maxAttempts).toBe(5);
    expect(R1_MEET_JOB_MAX_ATTEMPTS.scorecard_feedback).toBe(5);
    expect(Object.isFrozen(spec) && Object.isFrozen(spec.payload)).toBe(true);
  });

  it('refuses a missing, non-UUID or numeric id, and every other kind', () => {
    for (const key of ['booking_id', 'assessment_id']) {
      expect(parseScorecardFeedbackJob(without(receiptJob(), key)), `${key} absent`).toBeNull();
      for (const value of [null, '', 'not-a-uuid', 7, 7.5, BOOKING.replace(/-/g, ''), ` ${BOOKING}`, [BOOKING], {}]) {
        expect(parseScorecardFeedbackJob(receiptJob({ [key]: value })), `${key} = ${JSON.stringify(value)}`).toBeNull();
      }
    }
    for (const other of R1_MEET_JOB_KINDS) {
      if (other !== 'scorecard_feedback') expect(parseScorecardFeedbackJob(receiptJob({ kind: other })), other).toBeNull();
    }
    for (const kind of ['scorecard-feedback', 'Scorecard_feedback', 'scorecard_feedback ', null]) {
      expect(parseScorecardFeedbackJob(receiptJob({ kind })), String(kind)).toBeNull();
    }
    // A scorecard_feedback payload is not a job of any other kind either.
    for (const other of R1_MEET_JOB_KINDS) {
      if (other === 'scorecard_feedback') continue;
      expect((R1_MEET_JOB_PARSERS[other] as (payload: unknown) => unknown)(receiptJob()), other).toBeNull();
    }
  });

  it('keeps its dedup key apart from every other key family', () => {
    const key = r1MeetDedupKeys.scorecardFeedback(BOOKING, ASSESSMENT);
    expect(key).toMatch(/^r1-meet:scorecard-feedback:[0-9a-f-]{36}:[0-9a-f-]{36}$/);
    expect(key).toHaveLength('r1-meet:scorecard-feedback:'.length + 36 + 1 + 36);
    for (const other of [
      r1MeetDedupKeys.ensureBot(BOOKING),
      r1MeetDedupKeys.attemptEnded(BOOKING),
      r1MeetDedupKeys.roundCancelled(BOOKING),
      `r1-meet:receipt:${RECEIPT}`,
    ]) {
      expect(key.startsWith(other.slice(0, other.lastIndexOf(':') + 1))).toBe(false);
    }
    // One key per (booking, assessment): a new assessment of the same booking is a new job.
    expect(r1MeetDedupKeys.scorecardFeedback(BOOKING, SESSION)).not.toBe(key);
    expect(r1MeetDedupKeys.scorecardFeedback(ROUND, ASSESSMENT)).not.toBe(key);
  });
});

describe('job facts, results and errors', () => {
  const base = { attempts: 1, maxAttempts: 5, createdAt: '2030-01-01T00:00:00.000Z' };

  it('derives the facts from the queue row', () => {
    expect(r1MeetJobMeta(base)).toEqual({
      attempts: 1,
      maxAttempts: 5,
      deferCount: 0,
      deferredAt: null,
      createdAt: '2030-01-01T00:00:00.000Z',
      isRerun: false,
      finalAttempt: false,
      lastDeferReason: null,
      lastError: null,
    });
    expect(r1MeetJobMeta({ ...base, attempts: 2 })).toMatchObject({ isRerun: true, finalAttempt: false });
    // A deferral refunds the attempt, so a re-run after one is seen through the count.
    expect(r1MeetJobMeta({ ...base, deferCount: 1, deferredAt: '2030-01-01T00:01:00.000Z' })).toMatchObject({
      isRerun: true,
      deferCount: 1,
      deferredAt: '2030-01-01T00:01:00.000Z',
    });
    expect(r1MeetJobMeta({ ...base, attempts: 4 }).finalAttempt).toBe(false);
    expect(r1MeetJobMeta({ ...base, attempts: 5 }).finalAttempt).toBe(true);
    expect(r1MeetJobMeta({ ...base, attempts: 6 }).finalAttempt).toBe(true);
    expect(Object.isFrozen(r1MeetJobMeta(base))).toBe(true);
  });

  it("carries the previous run's deferral reason and thrown code as the queue keeps them (S09-R2)", () => {
    expect(r1MeetJobMeta({ ...base, deferCount: 1, deferReason: 'booking_not_settled' })).toMatchObject({
      lastDeferReason: 'booking_not_settled',
      lastError: null,
    });
    expect(r1MeetJobMeta({ ...base, attempts: 2, errorMessage: 'r1_meet_feedback_ashby_unavailable' })).toMatchObject({
      lastDeferReason: null,
      lastError: 'r1_meet_feedback_ashby_unavailable',
    });
    // Only the closed code shape of 0037 is kept; anything else (driver text, a value) reads as null.
    for (const odd of ['', 'Has Spaces', 'x'.repeat(65), 'ÜBER', 'a\nb']) {
      expect(r1MeetJobMeta({ ...base, deferReason: odd, errorMessage: odd }), JSON.stringify(odd)).toMatchObject({
        lastDeferReason: null,
        lastError: null,
      });
    }
  });

  it('allows a deferral under 30 of them and under an hour of one streak', () => {
    expect([R1_MEET_DEFER_MAX_COUNT, R1_MEET_DEFER_MAX_MS]).toEqual([30, 3_600_000]);
    const now = Date.parse('2030-01-01T12:00:00.000Z');
    const streak = (ms: number): string => new Date(now - ms).toISOString();
    expect(canDeferR1MeetJob({ deferCount: 0, deferredAt: null }, now)).toBe(true);
    expect(canDeferR1MeetJob({ deferCount: 29, deferredAt: streak(3_599_999) }, now)).toBe(true);
    expect(canDeferR1MeetJob({ deferCount: 30, deferredAt: streak(0) }, now)).toBe(false);
    expect(canDeferR1MeetJob({ deferCount: 30, deferredAt: null }, now)).toBe(false);
    expect(canDeferR1MeetJob({ deferCount: 1, deferredAt: streak(3_600_000) }, now)).toBe(false);
    expect(canDeferR1MeetJob({ deferCount: 1, deferredAt: streak(86_400_000) }, now)).toBe(false);
    // An unreadable streak start leaves the count as the bound.
    expect(canDeferR1MeetJob({ deferCount: 1, deferredAt: 'nope' }, now)).toBe(true);
  });

  it('answers frozen results', () => {
    expect(r1MeetProcessed('created')).toEqual({ outcome: 'done', receipt: 'processed', code: 'created' });
    expect(r1MeetIgnored('superseded')).toEqual({ outcome: 'done', receipt: 'ignored', code: 'superseded' });
    expect(r1MeetDefer('r1_meet_recall_unavailable', 60)).toEqual({ outcome: 'defer', code: 'r1_meet_recall_unavailable', delaySeconds: 60 });
    for (const result of [r1MeetProcessed('x'), r1MeetIgnored('x'), r1MeetDefer('x', 1)]) expect(Object.isFrozen(result)).toBe(true);
  });

  it('throws one closed code, which the queue keeps as it is', () => {
    for (const code of [R1_MEET_MALFORMED_PAYLOAD, R1_MEET_UNKNOWN_KIND, R1_MEET_DB_ERROR, R1_MEET_RPC_UNEXPECTED]) {
      const error = new R1MeetJobError(code);
      expect(error).toBeInstanceOf(Error);
      expect([error.code, error.message, error.name]).toEqual([code, code, 'R1MeetJobError']);
      expect(sanitizeErrorCode(error)).toBe(code);
      expect(isValidDeferReason(code)).toBe(true);
    }
  });
});
