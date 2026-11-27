/**
 * M034 S06 T1: the database port of the `r1-meet` runtime (lib/r1/meet/runtime-store.ts).
 *
 * Pinned here, with a recording query double:
 *  - every read's exact table, columns, filters, order and limit (never `ticket_digest`, never
 *    `candidate_id`), and the JSON-path filters of the participant events (also as the URL the real
 *    client builds, because a recording double accepts any spelling);
 *  - rows and answers are parsed field by field: a DB error, a rejected call or a malformed row is
 *    `r1_meet_db_error`, an unknown RPC answer is `r1_meet_rpc_unexpected`, and the message is that
 *    code and nothing else;
 *  - the Ashby delivery order (numeric stamps, `r` stamps, the `:cancelled`, `:schedule` and event
 *    suffixes, receipt order when Ashby sent no updatedAt) and the IST day of the bot cap;
 *  - the RPC arguments are the parameters migration 0142 declares, and every status of every catalog
 *    comment is a known answer that parses, so a drift fails here and not as PGRST202 in production;
 *  - (M035 S02) the booking `source` and the two members of the booking union: an Ashby row has all
 *    three Ashby schedule ids, a public-page row none, a mixed row is `r1_meet_db_error`, and the reads
 *    by an Ashby event or schedule id answer Ashby bookings only.
 */

import { describe, expect, expectTypeOf, it } from 'vitest';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createClient } from '@supabase/supabase-js';
import type { supabase } from '../lib/supabase.js';
import { R1_MEET_BOOKING_SOURCES, R1_MEET_BOOKING_STATUSES } from '../lib/r1/meet/bookings-read.js';
import { R1MeetJobError } from '../lib/r1/meet/jobs.js';
import {
  R1_MEET_BOOKING_COLUMNS,
  R1_MEET_CANCEL_REASONS,
  R1_MEET_CAP_REASONS,
  R1_MEET_CAP_STATUSES,
  R1_MEET_DISPATCHED_STATUSES,
  R1_MEET_DRAINABLE_STATUSES,
  R1_MEET_LIVE_STATUSES,
  R1_MEET_ROUND_EXPIRY_GRACE_SEC,
  R1_MEET_RPC_ANSWERS,
  R1_MEET_SESSION_STATUSES,
  R1_MEET_TERMINAL_STATUSES,
  R1_MEET_UNDISPATCHED_STATUSES,
  createR1MeetStore,
  r1MeetIstDay,
  type R1MeetAshbyBooking,
  type R1MeetBooking,
  type R1MeetPublicBooking,
  type R1MeetRpcName,
  type R1MeetStore,
} from '../lib/r1/meet/runtime-store.js';

// ── The recording double ─────────────────────────────────────────────────────

type Answer = { data: unknown; error: unknown; count?: number | null };
type Call = [op: string, ...args: unknown[]];

const CHAIN = ['select', 'update', 'eq', 'neq', 'in', 'not', 'lt', 'lte', 'gt', 'gte', 'like', 'order', 'limit'] as const;

/** Records every builder call and answers `answer` (an Error rejects; 'throw' throws at the first call). */
function fakeDb(answer: Answer | Error | 'throw' = { data: null, error: null }) {
  const calls: Call[] = [];
  const settle = async (): Promise<Answer> => {
    if (answer instanceof Error) throw answer;
    return answer as Answer;
  };
  const builder: Record<string, unknown> = {
    maybeSingle: () => {
      calls.push(['maybeSingle']);
      return settle();
    },
    then: (resolve: (value: Answer) => unknown, reject: (reason: unknown) => unknown) => settle().then(resolve, reject),
  };
  for (const op of CHAIN) {
    builder[op] = (...args: unknown[]) => {
      calls.push([op, ...args]);
      return builder;
    };
  }
  const db = {
    from: (table: string) => {
      if (answer === 'throw') throw new Error('driver detail that must not leak');
      calls.push(['from', table]);
      return builder;
    },
    rpc: (name: string, args: unknown) => {
      if (answer === 'throw') throw new Error('driver detail that must not leak');
      calls.push(['rpc', name, args]);
      return settle();
    },
  };
  return { store: createR1MeetStore(db as unknown as typeof supabase), calls };
}

const rows = (data: unknown): Answer => ({ data, error: null });

async function expectCode(promise: Promise<unknown>, code: string, label?: string): Promise<void> {
  const error = await promise.then(
    (value) => {
      throw new Error(`expected ${code}, got ${JSON.stringify(value)} (${label ?? ''})`);
    },
    (reason: unknown) => reason,
  );
  expect(error, label).toBeInstanceOf(R1MeetJobError);
  expect((error as R1MeetJobError).code, label).toBe(code);
  expect((error as Error).message, label).toBe(code);
}

// ── Fixtures ─────────────────────────────────────────────────────────────────

const id = (n: string): string => `7f000000-0000-4000-8000-0000000000${n}`;
const BOOKING = id('d1');
const EVENT = id('a1');
const SCHEDULE = id('b1');
const APPLICATION = id('b2');
const STAGE = id('b3');
const INTERVIEW = id('b4');
const SCHEDULER = id('b5');
const ROUND = id('d2');
const BOT = id('d3');
const SESSION = id('d4');
const RECEIPT = id('c1');
const CANDIDATE = id('c2');
const USER = id('c3');
const MEET_URL = 'https://meet.google.com/abc-defg-hij';
const NOW = '2030-01-01T10:00:00.000Z';

const row = (over: Record<string, unknown> = {}): Record<string, unknown> => ({
  id: BOOKING,
  ashby_interview_event_id: EVENT,
  ashby_schedule_id: SCHEDULE,
  ashby_application_id: APPLICATION,
  ashby_interview_stage_id: STAGE,
  ashby_interview_id: INTERVIEW,
  ashby_scheduled_by_user_id: SCHEDULER,
  ashby_updated_at: '2030-01-01T09:00:00+00:00',
  round_id: ROUND,
  objective_profile: 'r1_dex_sales',
  status: 'bot_scheduled',
  reason: 'eligible',
  version: 1,
  key_attempt: 0,
  meet_url: MEET_URL,
  start_at: '2030-01-02T10:00:00+00:00',
  end_at: '2030-01-02T10:45:00+00:00',
  recall_bot_id: BOT,
  ticket_not_before: null,
  ticket_expires_at: null,
  ticket_claimed_at: null,
  ticket_arms: 0,
  session_id: null,
  created_at: '2030-01-01T09:00:01.5+00:00',
  updated_at: '2030-01-01T09:00:02.123456+00:00',
  source: 'ashby',
  ...over,
});

/** A public-page row as 0143's public create RPC writes it: no Ashby schedule, stage or interview. */
const publicRow = (over: Record<string, unknown> = {}): Record<string, unknown> =>
  row({
    source: 'public_page',
    ashby_interview_event_id: null,
    ashby_schedule_id: null,
    ashby_scheduled_by_user_id: null,
    ashby_interview_stage_id: null,
    ashby_interview_id: null,
    ashby_updated_at: null,
    ...over,
  });

const BOOKING_PARSED = {
  id: BOOKING,
  eventId: EVENT,
  scheduleId: SCHEDULE,
  applicationId: APPLICATION,
  interviewStageId: STAGE,
  interviewId: INTERVIEW,
  scheduledByUserId: SCHEDULER,
  ashbyUpdatedAt: '2030-01-01T09:00:00.000Z',
  roundId: ROUND,
  objectiveProfile: 'r1_dex_sales',
  status: 'bot_scheduled',
  reason: 'eligible',
  version: 1,
  keyAttempt: 0,
  meetUrl: MEET_URL,
  startAt: '2030-01-02T10:00:00.000Z',
  endAt: '2030-01-02T10:45:00.000Z',
  recallBotId: BOT,
  ticketNotBefore: null,
  ticketExpiresAt: null,
  ticketClaimedAt: null,
  ticketArms: 0,
  sessionId: null,
  createdAt: '2030-01-01T09:00:01.500Z',
  updatedAt: '2030-01-01T09:00:02.123Z',
  source: 'ashby',
};

const PUBLIC_PARSED = {
  ...BOOKING_PARSED,
  eventId: null,
  scheduleId: null,
  scheduledByUserId: null,
  interviewStageId: null,
  interviewId: null,
  ashbyUpdatedAt: null,
  source: 'public_page',
};

const COLUMNS =
  'id, ashby_interview_event_id, ashby_schedule_id, ashby_application_id, ashby_interview_stage_id, '
  + 'ashby_interview_id, ashby_scheduled_by_user_id, ashby_updated_at, round_id, objective_profile, status, '
  + 'reason, version, key_attempt, meet_url, start_at, end_at, recall_bot_id, ticket_not_before, '
  + 'ticket_expires_at, ticket_claimed_at, ticket_arms, session_id, created_at, updated_at, source';

const LIVE = ['pending', 'unmatched_application', 'unmapped_scheduler', 'blocked', 'bot_scheduled', 'bot_joining', 'human_present', 'in_call'];
const TERMINAL = ['completed', 'cancelled', 'failed', 'drained'];

// ── Migration 0142 ───────────────────────────────────────────────────────────

const here = path.dirname(fileURLToPath(import.meta.url));
const migrations = path.resolve(here, '../../../supabase/migrations');
const raw = readFileSync(path.join(migrations, '0142_r1_meet_bookings.sql'), 'utf8').replace(/\r\n/g, '\n');
/** Comments stripped, whitespace collapsed. */
const sql = raw.replace(/^\s*--.*$/gm, '').replace(/\s+/g, ' ');

// ── Migration 0143 (M035 S01): the source column and its CHECK ─────────────────

const raw0143 = readFileSync(path.join(migrations, '0143_r1_meet_public_bookings.sql'), 'utf8').replace(/\r\n/g, '\n');
/** Comments stripped, whitespace collapsed (as `sql` above). */
const sql0143 = raw0143.replace(/^\s*--.*$/gm, '').replace(/\s+/g, ' ');
/** Every column 0143 adds to the bookings table, in order. */
const added0143 = [...sql0143.matchAll(/alter table screening_v2\.r1_meet_bookings add column if not exists ([a-z_]+) /g)].map(
  (m) => m[1]!,
);
/**
 * The column bound by `chk_r1_meet_bookings_source` (the rule `parseBooking`'s source reader enforces),
 * its default and its closed list, parsed from its `add column` statement.
 */
const SOURCE_0143 = /add column if not exists ([a-z_]+) text not null default '([a-z_]+)' constraint chk_r1_meet_bookings_source check \(([a-z_]+) in \(([^)]*)\)\);/.exec(
  sql0143,
);

function functionText(name: string): string {
  const start = sql.indexOf(`create or replace function screening_v2.${name}(`);
  expect(start, name).toBeGreaterThan(-1);
  return sql.slice(start, sql.indexOf('$$;', start));
}

/** The declared parameters of an RPC, in order. */
function sqlParams(name: string): Array<{ name: string; type: string; defaultSql: string | null }> {
  const text = functionText(name);
  return text
    .slice(text.indexOf('(') + 1, text.indexOf(') returns jsonb'))
    .split(',')
    .map((part) => part.trim())
    .filter(Boolean)
    .map((part) => {
      const match = /^(p_\w+) (\w+)(?: default (.+))?$/.exec(part);
      expect(match, part).not.toBeNull();
      return { name: match![1]!, type: match![2]!, defaultSql: match![3] ?? null };
    });
}

/** The answers the catalog comment of an RPC lists (`Answers a (+x) | b | c (...). ...`). */
function catalogAnswers(name: string): string[] {
  // The text is adjacent string literals, which may hold a semicolon themselves.
  const statement = new RegExp(String.raw`comment on function screening_v2\.${name}\([^)]*\) is ((?:'(?:[^']|'')*' ?)+);`).exec(sql);
  expect(statement, name).not.toBeNull();
  const text = [...statement![1]!.matchAll(/'((?:[^']|'')*)'/g)].map((m) => m[1]!).join('');
  expect(text.split('Answers '), name).toHaveLength(2);
  const list = text.slice(text.indexOf('Answers ') + 'Answers '.length);
  return list
    .split('|')
    .map((part) => /^\s*([a-z_]+)/.exec(part)?.[1] ?? `unreadable: ${part}`);
}

/** Every status word an RPC body can answer. */
function bodyAnswers(name: string): string[] {
  const body = functionText(name);
  return [
    ...new Set([
      ...[...body.matchAll(/'status', '([a-z_]+)'/g)].map((m) => m[1]!),
      ...[...body.matchAll(/v_answer := '([a-z_]+)'/g)].map((m) => m[1]!),
      ...[...body.matchAll(/v_result := '([a-z_]+)'/g)].map((m) => m[1]!),
      ...[...body.matchAll(/v_status := '(unmatched_application|unmapped_scheduler|blocked)'/g)].map((m) => m[1]!),
    ]),
  ];
}

describe('what is selected', () => {
  it('reads every booking column of 0142 except ticket_digest and candidate_id, then the source of 0143', () => {
    expect(R1_MEET_BOOKING_COLUMNS).toBe(COLUMNS);
    const start = sql.indexOf('create table if not exists screening_v2.r1_meet_bookings (');
    const table = sql.slice(start, sql.indexOf('constraint uq_r1_meet_bookings_event', start));
    const declared = [...table.matchAll(/[(,] ([a-z_]+) (?:uuid|text|timestamptz|integer)\b/g)].map((m) => m[1]!);
    expect(declared).toHaveLength(27);
    // 0143 (M035 S01) adds seven columns; the runtime reads exactly one of them, the column of
    // `chk_r1_meet_bookings_source`, appended last (contracts 3.1). The calendar, request and manage
    // columns are never selected here (S05 reads them itself).
    expect(SOURCE_0143, 'chk_r1_meet_bookings_source').not.toBeNull();
    const [, sourceColumn, , checkedColumn] = SOURCE_0143!;
    expect(checkedColumn, 'the CHECK reads its own column').toBe(sourceColumn);
    expect(added0143).toHaveLength(7);
    expect(added0143).toContain(sourceColumn);
    for (const name of declared) expect(added0143, name).not.toContain(name);
    expect(COLUMNS.split(', ')).toEqual([
      ...declared.filter((name) => name !== 'ticket_digest' && name !== 'candidate_id'),
      sourceColumn,
    ]);
    for (const name of added0143.filter((n) => n !== sourceColumn)) expect(COLUMNS.split(', '), name).not.toContain(name);
  });

  it('partitions the twelve statuses of 0142', () => {
    expect([...R1_MEET_LIVE_STATUSES]).toEqual(LIVE);
    expect([...R1_MEET_TERMINAL_STATUSES]).toEqual(TERMINAL);
    expect([...R1_MEET_UNDISPATCHED_STATUSES, ...R1_MEET_DISPATCHED_STATUSES, ...R1_MEET_TERMINAL_STATUSES].sort()).toEqual(
      [...R1_MEET_BOOKING_STATUSES].sort(),
    );
    expect([...R1_MEET_DISPATCHED_STATUSES]).toEqual(['bot_joining', 'human_present', 'in_call']);
    expect([...R1_MEET_DRAINABLE_STATUSES]).toEqual(['pending', 'bot_scheduled', 'bot_joining', 'human_present', 'in_call']);
    for (const list of [R1_MEET_LIVE_STATUSES, R1_MEET_TERMINAL_STATUSES, R1_MEET_DRAINABLE_STATUSES, R1_MEET_CAP_STATUSES, R1_MEET_CAP_REASONS, R1_MEET_RPC_ANSWERS]) {
      expect(Object.isFrozen(list)).toBe(true);
    }
    // The terminal set is the one 0142's owed-release index is built on.
    expect(sql).toContain(`where recall_bot_id is not null and status in (${TERMINAL.map((s) => `'${s}'`).join(', ')});`);
  });
});

describe('single booking reads', () => {
  const cases: Array<[string, (store: R1MeetStore) => Promise<unknown>, Call[]]> = [
    ['getBooking', (store) => store.getBooking(BOOKING), [['eq', 'id', BOOKING]]],
    ['getBookingByEvent', (store) => store.getBookingByEvent(EVENT), [['eq', 'ashby_interview_event_id', EVENT]]],
    ['getBookingByBot', (store) => store.getBookingByBot(BOT), [['eq', 'recall_bot_id', BOT]]],
    [
      'getBookingBySession',
      (store) => store.getBookingBySession(SESSION),
      [['eq', 'session_id', SESSION], ['order', 'updated_at', { ascending: false }], ['limit', 1]],
    ],
  ];

  it.each(cases)('%s: the exact query, the parsed booking, and null for no row', async (_name, read, filters) => {
    const { store, calls } = fakeDb(rows(row()));
    expect(await read(store)).toEqual(BOOKING_PARSED);
    expect(calls).toEqual([['from', 'r1_meet_bookings'], ['select', COLUMNS], ...filters, ['maybeSingle']]);
    expect(await read(fakeDb(rows(null)).store)).toBeNull();
    expect(await read(fakeDb(rows(undefined)).store)).toBeNull();
  });

  it.each(cases)('%s: a DB error, a rejected call or a throwing client is r1_meet_db_error', async (_name, read) => {
    await expectCode(read(fakeDb({ data: null, error: { message: 'secret driver text' } }).store), 'r1_meet_db_error');
    await expectCode(read(fakeDb({ data: row(), error: { message: 'secret driver text' } }).store), 'r1_meet_db_error');
    await expectCode(read(fakeDb(new Error('socket hang up')).store), 'r1_meet_db_error');
    await expectCode(read(fakeDb('throw').store), 'r1_meet_db_error');
  });

  it('is frozen, lower-cases the uuid columns and keeps the Ashby text ids verbatim', async () => {
    const booking = await fakeDb(
      rows(
        row({
          id: BOOKING.toUpperCase(),
          ashby_interview_event_id: EVENT.toUpperCase(),
          round_id: ROUND.toUpperCase(),
          recall_bot_id: BOT.toUpperCase(),
          session_id: SESSION.toUpperCase(),
          ashby_schedule_id: SCHEDULE.toUpperCase(),
          ashby_application_id: APPLICATION.toUpperCase(),
          ashby_scheduled_by_user_id: SCHEDULER.toUpperCase(),
        }),
      ),
    ).store.getBooking(BOOKING);
    expect(booking).toMatchObject({
      id: BOOKING,
      eventId: EVENT,
      roundId: ROUND,
      recallBotId: BOT,
      sessionId: SESSION,
      scheduleId: SCHEDULE.toUpperCase(),
      applicationId: APPLICATION.toUpperCase(),
      scheduledByUserId: SCHEDULER.toUpperCase(),
    });
    expect(Object.isFrozen(booking)).toBe(true);
  });

  it('reads a round-less booking and an armed, claimed ticket', async () => {
    const bare = await fakeDb(
      rows(row({ status: 'unmatched_application', reason: 'application_unknown', round_id: null, recall_bot_id: null, ashby_updated_at: null, ashby_interview_stage_id: null, ashby_interview_id: null })),
    ).store.getBooking(BOOKING);
    expect(bare).toMatchObject({ roundId: null, recallBotId: null, ashbyUpdatedAt: null, interviewStageId: null, interviewId: null });
    const armed = await fakeDb(
      rows(row({ status: 'in_call', ticket_not_before: '2030-01-02T09:55:00Z', ticket_expires_at: '2030-01-02T11:00:00Z', ticket_claimed_at: '2030-01-02T10:00:30Z', ticket_arms: 2, session_id: SESSION })),
    ).store.getBooking(BOOKING);
    expect(armed).toMatchObject({
      ticketNotBefore: '2030-01-02T09:55:00.000Z',
      ticketExpiresAt: '2030-01-02T11:00:00.000Z',
      ticketClaimedAt: '2030-01-02T10:00:30.000Z',
      ticketArms: 2,
      sessionId: SESSION,
    });
  });

  it('refuses every column that is absent or not what 0142 allows', async () => {
    const bad: Record<string, unknown[]> = {
      id: [null, 'x', 7],
      ashby_interview_event_id: [null, 'x'],
      ashby_schedule_id: [null, 'x'],
      ashby_application_id: [null, ''],
      ashby_interview_stage_id: ['x', 7],
      ashby_interview_id: ['x', {}],
      ashby_scheduled_by_user_id: [null, 'x'],
      ashby_updated_at: ['soon', '2030-01-01T09:00:00'],
      round_id: ['x', 7],
      objective_profile: [null, '', 7],
      status: [null, 'scheduled', 7],
      reason: [null, 'because', 7],
      version: [null, -1, 51, 1.5, '1'],
      key_attempt: [null, -1, 21, '0'],
      meet_url: [null, '', `${MEET_URL}?x=1`, 'https://zoom.example.test/j/1'],
      start_at: [null, 'soon', '2030-01-02T10:00:00'],
      end_at: [null, 'soon'],
      recall_bot_id: ['x', 7],
      ticket_not_before: ['soon'],
      ticket_expires_at: ['soon'],
      ticket_claimed_at: ['soon'],
      ticket_arms: [null, -1, 6, '0'],
      session_id: ['x'],
      created_at: [null, 'soon'],
      updated_at: [null, 'soon'],
      source: [null, '', 'ASHBY', 'public', 7],
    };
    expect(Object.keys(bad)).toEqual(COLUMNS.split(', '));
    for (const [key, values] of Object.entries(bad)) {
      for (const value of [...values, undefined]) {
        await expectCode(fakeDb(rows(row({ [key]: value }))).store.getBooking(BOOKING), 'r1_meet_db_error', `${key} = ${String(value)}`);
      }
    }
    for (const data of ['row', 7, [row()], true]) {
      await expectCode(fakeDb(rows(data)).store.getBooking(BOOKING), 'r1_meet_db_error', String(data));
    }
  });
});

describe('list reads', () => {
  const asc = { ascending: true };
  const cases: Array<[string, (store: R1MeetStore) => Promise<unknown>, Call[]]> = [
    [
      'listLiveBySchedule',
      (store) => store.listLiveBySchedule(SCHEDULE),
      [['eq', 'ashby_schedule_id', SCHEDULE], ['in', 'status', LIVE], ['order', 'start_at', asc], ['limit', 100]],
    ],
    [
      'listOwedReleases',
      (store) => store.listOwedReleases(20),
      [['not', 'recall_bot_id', 'is', null], ['in', 'status', TERMINAL], ['order', 'updated_at', asc], ['limit', 20]],
    ],
    [
      'listOverdue',
      (store) => store.listOverdue(NOW, 50),
      [['in', 'status', LIVE], ['lt', 'end_at', NOW], ['order', 'end_at', asc], ['limit', 50]],
    ],
    ['listInCall', (store) => store.listInCall(50), [['eq', 'status', 'in_call'], ['order', 'start_at', asc], ['limit', 50]]],
    [
      'listStuckPending',
      (store) => store.listStuckPending({ untouchedSince: '2030-01-01T09:50:00.000Z', startAfter: NOW, limit: 30 }),
      [
        ['eq', 'status', 'pending'],
        ['lt', 'updated_at', '2030-01-01T09:50:00.000Z'],
        ['gt', 'start_at', NOW],
        ['order', 'start_at', asc],
        ['limit', 30],
      ],
    ],
    [
      'listCapBlocked',
      (store) => store.listCapBlocked({ startAfter: NOW, limit: 25 }),
      [['eq', 'status', 'blocked'], ['eq', 'reason', 'bot_cap_reached'], ['gt', 'start_at', NOW], ['order', 'start_at', asc], ['limit', 25]],
    ],
    [
      'listDrainable (the operator: however recently touched)',
      (store) => store.listDrainable({ untouchedSince: null, limit: 10 }),
      [['in', 'status', ['pending', 'bot_scheduled', 'bot_joining', 'human_present', 'in_call']], ['order', 'start_at', asc], ['limit', 10]],
    ],
    [
      'listDrainable (the backstop: untouched only)',
      (store) => store.listDrainable({ untouchedSince: '2030-01-01T09:55:00.000Z', limit: 10 }),
      [
        ['in', 'status', ['pending', 'bot_scheduled', 'bot_joining', 'human_present', 'in_call']],
        ['lt', 'updated_at', '2030-01-01T09:55:00.000Z'],
        ['order', 'start_at', asc],
        ['limit', 10],
      ],
    ],
  ];

  it.each(cases)('%s: the exact query and the parsed rows', async (_name, read, filters) => {
    const { store, calls } = fakeDb(rows([row(), row({ id: id('d9') })]));
    const list = (await read(store)) as unknown[];
    expect(list).toEqual([BOOKING_PARSED, { ...BOOKING_PARSED, id: id('d9') }]);
    expect(Object.isFrozen(list)).toBe(true);
    expect(calls).toEqual([['from', 'r1_meet_bookings'], ['select', COLUMNS], ...filters]);
    expect(await read(fakeDb(rows([])).store)).toEqual([]);
  });

  it.each(cases)('%s: one malformed row, no list or an error fails the read (never a silent drop)', async (_name, read) => {
    await expectCode(read(fakeDb(rows([row(), row({ status: 'scheduled' })])).store), 'r1_meet_db_error');
    await expectCode(read(fakeDb(rows(null)).store), 'r1_meet_db_error');
    await expectCode(read(fakeDb(rows(row())).store), 'r1_meet_db_error');
    await expectCode(read(fakeDb({ data: [], error: { message: 'x' } }).store), 'r1_meet_db_error');
    await expectCode(read(fakeDb(new Error('socket')).store), 'r1_meet_db_error');
    await expectCode(read(fakeDb('throw').store), 'r1_meet_db_error');
  });
});

describe('two sources (M035 S02): the Ashby and the public-page booking', () => {
  const IDS = ['ashby_interview_event_id', 'ashby_schedule_id', 'ashby_scheduled_by_user_id'] as const;
  const SET: Record<(typeof IDS)[number], string> = {
    ashby_interview_event_id: EVENT,
    ashby_schedule_id: SCHEDULE,
    ashby_scheduled_by_user_id: SCHEDULER,
  };

  it("the closed list of sources is 0143's, frozen; a row written before 0143 reads as the first", () => {
    expect(SOURCE_0143, 'chk_r1_meet_bookings_source').not.toBeNull();
    const [, , defaultValue, , list] = SOURCE_0143!;
    const values = [...list!.matchAll(/'([^']*)'/g)].map((m) => m[1]!);
    expect(values).toHaveLength(2);
    expect([...R1_MEET_BOOKING_SOURCES]).toEqual(values);
    expect(defaultValue).toBe(R1_MEET_BOOKING_SOURCES[0]);
    expect(Object.isFrozen(R1_MEET_BOOKING_SOURCES)).toBe(true);
  });

  it("an Ashby row parses to today's booking plus source ashby, in today's key order", async () => {
    const booking = await fakeDb(rows(row())).store.getBooking(BOOKING);
    expect(booking).toEqual(BOOKING_PARSED);
    expect(Object.keys(booking!)).toEqual(Object.keys(BOOKING_PARSED));
    if (booking === null || booking.source !== 'ashby') throw new Error('expected an Ashby booking');
    expectTypeOf(booking).toEqualTypeOf<R1MeetAshbyBooking>();
  });

  it('a public-page row parses to the public member: the three schedule ids null, frozen, the same keys', async () => {
    const booking = await fakeDb(rows(publicRow())).store.getBooking(BOOKING);
    expect(booking).toEqual(PUBLIC_PARSED);
    expect(Object.keys(booking!)).toEqual(Object.keys(BOOKING_PARSED));
    expect(Object.isFrozen(booking)).toBe(true);
    if (booking === null || booking.source !== 'public_page') throw new Error('expected a public booking');
    expectTypeOf(booking).toEqualTypeOf<R1MeetPublicBooking>();
    expect([booking.eventId, booking.scheduleId, booking.scheduledByUserId]).toEqual([null, null, null]);
    // The matched application stays: Dex's card lands on it.
    expect(booking.applicationId).toBe(APPLICATION);
  });

  it('a public row keeps what 0143 does not constrain: stage, interview and the Ashby updatedAt', async () => {
    const booking = await fakeDb(
      rows(publicRow({ ashby_interview_stage_id: STAGE, ashby_interview_id: INTERVIEW, ashby_updated_at: '2030-01-01T09:00:00+00:00' })),
    ).store.getBooking(BOOKING);
    expect(booking).toEqual({
      ...PUBLIC_PARSED,
      interviewStageId: STAGE,
      interviewId: INTERVIEW,
      ashbyUpdatedAt: '2030-01-01T09:00:00.000Z',
    });
  });

  it.each(IDS)('a mixed row fails r1_meet_db_error: an Ashby row without %s, a public row with it', async (key) => {
    await expectCode(fakeDb(rows(row({ [key]: null }))).store.getBooking(BOOKING), 'r1_meet_db_error', `ashby, ${key} null`);
    await expectCode(fakeDb(rows(publicRow({ [key]: SET[key] }))).store.getBooking(BOOKING), 'r1_meet_db_error', `public, ${key} set`);
    // In a list too: one mixed row fails the whole read, never a silent drop.
    await expectCode(fakeDb(rows([row(), publicRow({ [key]: SET[key] })])).store.listOwedReleases(20), 'r1_meet_db_error');
    await expectCode(fakeDb(rows([publicRow(), row({ [key]: null })])).store.listOverdue(NOW, 50), 'r1_meet_db_error');
  });

  it('a public row with all three Ashby ids, or an Ashby row with none, is mixed too', async () => {
    await expectCode(fakeDb(rows(publicRow(SET))).store.getBooking(BOOKING), 'r1_meet_db_error');
    await expectCode(
      fakeDb(rows(row({ ashby_interview_event_id: null, ashby_schedule_id: null, ashby_scheduled_by_user_id: null }))).store.getBooking(BOOKING),
      'r1_meet_db_error',
    );
  });

  it('the reads by an Ashby event or schedule id answer the Ashby member only; a public row there fails', async () => {
    expectTypeOf<Awaited<ReturnType<R1MeetStore['getBookingByEvent']>>>().toEqualTypeOf<R1MeetAshbyBooking | null>();
    expectTypeOf<Awaited<ReturnType<R1MeetStore['listLiveBySchedule']>>>().toEqualTypeOf<readonly R1MeetAshbyBooking[]>();
    expectTypeOf<Awaited<ReturnType<R1MeetStore['getBooking']>>>().toEqualTypeOf<R1MeetBooking | null>();
    expect(await fakeDb(rows(row())).store.getBookingByEvent(EVENT)).toEqual(BOOKING_PARSED);
    expect(await fakeDb(rows([row()])).store.listLiveBySchedule(SCHEDULE)).toEqual([BOOKING_PARSED]);
    await expectCode(fakeDb(rows(publicRow())).store.getBookingByEvent(EVENT), 'r1_meet_db_error');
    await expectCode(fakeDb(rows([publicRow()])).store.listLiveBySchedule(SCHEDULE), 'r1_meet_db_error');
    await expectCode(fakeDb(rows([row(), publicRow({ id: id('d9') })])).store.listLiveBySchedule(SCHEDULE), 'r1_meet_db_error');
    // No row is still no row.
    expect(await fakeDb(rows(null)).store.getBookingByEvent(EVENT)).toBeNull();
  });

  const singles: Array<[string, (store: R1MeetStore) => Promise<unknown>]> = [
    ['getBooking', (store) => store.getBooking(BOOKING)],
    ['getBookingByBot', (store) => store.getBookingByBot(BOT)],
    ['getBookingBySession', (store) => store.getBookingBySession(SESSION)],
  ];
  it.each(singles)('%s parses a public row', async (_name, read) => {
    expect(await read(fakeDb(rows(publicRow())).store)).toEqual(PUBLIC_PARSED);
  });

  const lists: Array<[string, (store: R1MeetStore) => Promise<unknown>]> = [
    ['listOwedReleases', (store) => store.listOwedReleases(20)],
    ['listOverdue', (store) => store.listOverdue(NOW, 50)],
    ['listInCall', (store) => store.listInCall(50)],
    ['listStuckPending', (store) => store.listStuckPending({ untouchedSince: NOW, startAfter: NOW, limit: 30 })],
    ['listCapBlocked', (store) => store.listCapBlocked({ startAfter: NOW, limit: 25 })],
    ['listDrainable', (store) => store.listDrainable({ untouchedSince: null, limit: 10 })],
  ];
  it.each(lists)('%s parses an Ashby and a public row side by side', async (_name, read) => {
    const list = await read(fakeDb(rows([row(), publicRow({ id: id('d9') })])).store);
    expect(list).toEqual([BOOKING_PARSED, { ...PUBLIC_PARSED, id: id('d9') }]);
    expect(Object.isFrozen(list)).toBe(true);
  });

  it.each([
    ['cancelled', 'candidate_cancelled'],
    ['failed', 'invite_undeliverable'],
  ])('the reason reader takes the 0143 pair %s/%s on either source', async (status, reason) => {
    for (const r of [row({ status, reason, recall_bot_id: null }), publicRow({ status, reason, recall_bot_id: null })]) {
      const booking = await fakeDb(rows(r)).store.getBooking(BOOKING);
      expect(booking).toMatchObject({ status, reason, recallBotId: null });
      expect(Object.isFrozen(booking)).toBe(true);
    }
    // In a list read too (the owed-release sweep reads terminal rows).
    expect(await fakeDb(rows([publicRow({ status, reason })])).store.listOwedReleases(20)).toEqual([
      { ...PUBLIC_PARSED, status, reason },
    ]);
  });
});

describe('newerAshbyDelivery: the order of Ashby deliveries', () => {
  const PREFIX = `ashby-schedule:${SCHEDULE}:`;
  const HEX = '0123456789abcdef';
  const at = (iso: string): number => Date.parse(iso);
  const T9 = at('2030-01-01T09:00:00.000Z');
  const receipt = (stamp: string, suffix: string, receivedAt = '2030-01-01T09:00:02+00:00') => ({
    dedupe_key: `${PREFIX}${stamp}${suffix}`,
    received_at: receivedAt,
  });
  const job = (over: Partial<{ scheduleId: string; ashbyUpdatedAt: string | null; receivedAt: string | null }> = {}) => ({
    scheduleId: SCHEDULE,
    ashbyUpdatedAt: '2030-01-01T09:00:00.000Z' as string | null,
    receivedAt: '2030-01-01T09:00:02.000Z' as string | null,
    ...over,
  });
  const newer = (data: unknown[], over = {}) => fakeDb(rows(data)).store.newerAshbyDelivery(job(over));

  it('reads the newest 100 Ashby receipts of this schedule, two columns', async () => {
    const { store, calls } = fakeDb(rows([]));
    expect(await store.newerAshbyDelivery(job())).toBe(false);
    expect(calls).toEqual([
      ['from', 'r1_meet_receipts'],
      ['select', 'dedupe_key, received_at'],
      ['eq', 'source', 'ashby'],
      ['like', 'dedupe_key', `${PREFIX}%`],
      ['order', 'received_at', { ascending: false }],
      ['limit', 100],
    ]);
  });

  it('a numeric stamp greater than the job\'s updatedAt is newer, whatever the suffix', async () => {
    for (const suffix of [`:${HEX}:${EVENT}`, `:${HEX}:schedule`, ':cancelled', `:${HEX}`, '']) {
      expect(await newer([receipt(String(T9 + 1), suffix)]), suffix).toBe(true);
      // Its own delivery (the same stamp), whatever event it is about, and an older one are not newer.
      expect(await newer([receipt(String(T9), suffix)]), suffix).toBe(false);
      expect(await newer([receipt(String(T9 - 1), suffix)]), suffix).toBe(false);
    }
    expect(await newer([receipt(String(T9 - 5), ':cancelled'), receipt(String(T9), `:${HEX}:${EVENT}`), receipt(String(T9 + 60_000), ':cancelled')])).toBe(true);
  });

  it('compares numbers, not text', async () => {
    const older = job({ ashbyUpdatedAt: new Date(999).toISOString() });
    expect(await fakeDb(rows([receipt('1000', ':cancelled')])).store.newerAshbyDelivery(older)).toBe(true);
    const later = job({ ashbyUpdatedAt: new Date(1000).toISOString() });
    expect(await fakeDb(rows([receipt('999', ':cancelled')])).store.newerAshbyDelivery(later)).toBe(false);
  });

  it('a receipt-time stamp never outranks an Ashby updatedAt, nor does an unreadable one', async () => {
    const late = '2030-01-01T23:00:00+00:00';
    for (const stamp of [`r${T9 + 60_000}`, 'r0', '', 'x', `${T9 + 1}x`, '99999999999999999', '-1', '1e15']) {
      expect(await newer([receipt(stamp, ':cancelled', late)]), stamp).toBe(false);
    }
  });

  it('without an updatedAt the receipt order decides, for every kind of stamp', async () => {
    const own = { ashbyUpdatedAt: null, receivedAt: '2030-01-01T09:00:02.000Z' };
    const stamps = [`r${T9 + 2000}`, String(T9), String(T9 + 9e9)];
    for (const stamp of stamps) {
      expect(await newer([receipt(stamp, ':cancelled', '2030-01-01T09:00:02.001+00:00')], own), stamp).toBe(true);
      // The job's own receipt carries exactly its received_at.
      expect(await newer([receipt(stamp, `:${HEX}:${EVENT}`, '2030-01-01T09:00:02+00:00')], own), stamp).toBe(false);
      expect(await newer([receipt(stamp, ':cancelled', '2030-01-01T09:00:01.999+00:00')], own), stamp).toBe(false);
    }
    // No clock at all: nothing is ever newer.
    expect(await newer([receipt('r1', ':cancelled', '2030-01-01T23:00:00+00:00')], { ashbyUpdatedAt: null, receivedAt: null })).toBe(false);
  });

  it('keeps the schedule id verbatim and refuses to build a pattern from anything else', async () => {
    const upper = SCHEDULE.toUpperCase();
    const { store, calls } = fakeDb(rows([{ dedupe_key: `ashby-schedule:${upper}:${T9 + 1}:cancelled`, received_at: NOW }]));
    expect(await store.newerAshbyDelivery(job({ scheduleId: upper }))).toBe(true);
    expect(calls).toContainEqual(['like', 'dedupe_key', `ashby-schedule:${upper}:%`]);
    for (const bad of ['%', '', 'a%', `${SCHEDULE}%`, '_'.repeat(36)]) {
      const refused = fakeDb(rows([]));
      await expectCode(refused.store.newerAshbyDelivery(job({ scheduleId: bad })), 'r1_meet_db_error', bad);
      expect(refused.calls).toEqual([]);
    }
  });

  it('refuses a malformed row, an error or no list', async () => {
    for (const bad of [
      { dedupe_key: null, received_at: NOW },
      { dedupe_key: '', received_at: NOW },
      { dedupe_key: `ashby-schedule:${id('b9')}:1:cancelled`, received_at: NOW },
      { dedupe_key: `${PREFIX}1:cancelled`, received_at: null },
      { dedupe_key: `${PREFIX}1:cancelled`, received_at: 'soon' },
      { dedupe_key: `${PREFIX}1:cancelled` },
      'row',
    ]) {
      await expectCode(newer([bad]), 'r1_meet_db_error', JSON.stringify(bad));
    }
    await expectCode(fakeDb(rows(null)).store.newerAshbyDelivery(job()), 'r1_meet_db_error');
    await expectCode(fakeDb({ data: null, error: { message: 'x' } }).store.newerAshbyDelivery(job()), 'r1_meet_db_error');
  });
});

describe('the IST day of the bot cap', () => {
  it('is 18:30Z to 18:30Z, half open', () => {
    const day1 = { from: '2029-12-31T18:30:00.000Z', to: '2030-01-01T18:30:00.000Z' };
    const day2 = { from: '2030-01-01T18:30:00.000Z', to: '2030-01-02T18:30:00.000Z' };
    expect(r1MeetIstDay('2029-12-31T18:30:00.000Z')).toEqual(day1);
    expect(r1MeetIstDay('2030-01-01T00:00:00.000Z')).toEqual(day1);
    expect(r1MeetIstDay('2030-01-01T10:00:00.000Z')).toEqual(day1);
    expect(r1MeetIstDay('2030-01-01T18:29:59.999Z')).toEqual(day1);
    expect(r1MeetIstDay('2030-01-01T18:30:00.000Z')).toEqual(day2);
    // Midnight to midnight as India reads the clock.
    expect(r1MeetIstDay('2030-01-02T00:00:00+05:30')).toEqual(day2);
    expect(r1MeetIstDay('2030-01-02T23:59:59.999+05:30')).toEqual(day2);
    // Around a leap day, and before 1970.
    expect(r1MeetIstDay('2028-02-29T18:30:00Z')).toEqual({ from: '2028-02-29T18:30:00.000Z', to: '2028-03-01T18:30:00.000Z' });
    expect(r1MeetIstDay('1969-12-31T18:29:59.999Z')).toEqual({ from: '1969-12-30T18:30:00.000Z', to: '1969-12-31T18:30:00.000Z' });
    expect(Object.isFrozen(r1MeetIstDay(NOW))).toBe(true);
    for (const bad of ['', 'today', '2030-01-01', '2030-01-01T10:00:00']) expect(r1MeetIstDay(bad), bad).toBeNull();
  });

  it('counts the bookings that used a bot in that window, without this one and without reading rows', async () => {
    const window = r1MeetIstDay('2030-01-02T10:00:00.000Z')!;
    const { store, calls } = fakeDb({ data: null, error: null, count: 7 });
    expect(await store.countBotsInDay({ ...window, excludeId: BOOKING })).toBe(7);
    expect(calls).toEqual([
      ['from', 'r1_meet_bookings'],
      ['select', 'id', { count: 'exact', head: true }],
      ['gte', 'start_at', '2030-01-01T18:30:00.000Z'],
      ['lt', 'start_at', '2030-01-02T18:30:00.000Z'],
      ['in', 'status', ['bot_scheduled', 'bot_joining', 'human_present', 'in_call', 'completed', 'failed']],
      ['in', 'reason', ['eligible', 'attempt_settled', 'bot_fatal', 'no_show', 'admission_refused', 'multiple_humans']],
      ['neq', 'id', BOOKING],
    ]);
    expect(await fakeDb({ data: null, error: null, count: 0 }).store.countBotsInDay({ ...window, excludeId: BOOKING })).toBe(0);
  });

  it('counts exactly the status and reason pairs that follow an attached bot (0142, and 0143 adds none)', () => {
    const countedOf = (pairing: string): string[] => {
      const families = [...pairing.matchAll(/status in \(([^)]*)\) and reason in \(([^)]*)\)/g)].map((m) => ({
        statuses: [...m[1]!.matchAll(/'(\w+)'/g)].map((s) => s[1]!),
        reasons: [...m[2]!.matchAll(/'(\w+)'/g)].map((s) => s[1]!),
      }));
      expect(families).toHaveLength(8);
      return families.flatMap(({ statuses, reasons }) =>
        statuses.filter((s) => (R1_MEET_CAP_STATUSES as readonly string[]).includes(s)).flatMap((s) =>
          reasons.filter((r) => (R1_MEET_CAP_REASONS as readonly string[]).includes(r)).map((r) => `${s}/${r}`),
        ),
      ).sort();
    };
    const counted = countedOf(/constraint chk_r1_meet_bookings_status_reason check \((.*?)\), constraint/.exec(sql)![1]!);
    // 0143 swaps the pairing CHECK (M035 S01): its two new pairs are not bot-day pairs.
    const swapped = /add constraint chk_r1_meet_bookings_status_reason check \((.*?)\) not valid;/.exec(sql0143);
    expect(swapped, '0143 chk_r1_meet_bookings_status_reason').not.toBeNull();
    expect(countedOf(swapped![1]!)).toEqual(counted);
    expect(counted).toEqual([
      'bot_joining/eligible',
      'bot_scheduled/eligible',
      'completed/attempt_settled',
      'failed/admission_refused',
      'failed/bot_fatal',
      'failed/multiple_humans',
      'failed/no_show',
      'human_present/eligible',
      'in_call/eligible',
    ]);
  });

  it('fails closed without a count: no answer is not zero bots', async () => {
    const query = { from: NOW, to: NOW, excludeId: BOOKING };
    for (const count of [null, undefined, -1, 1.5, '3' as unknown as number, Number.NaN]) {
      await expectCode(fakeDb({ data: null, error: null, count }).store.countBotsInDay(query), 'r1_meet_db_error', String(count));
    }
    await expectCode(fakeDb({ data: null, error: { message: 'x' }, count: 3 }).store.countBotsInDay(query), 'r1_meet_db_error');
    await expectCode(fakeDb(new Error('socket')).store.countBotsInDay(query), 'r1_meet_db_error');
  });
});

describe('participantEvents: the durable join and leave jobs of one bot', () => {
  const event = (over: Record<string, unknown> = {}) => ({
    receipt_id: RECEIPT,
    event_type: 'participant_events.join',
    occurred_at: '2030-01-02T10:00:01.25+00:00',
    participant: { id: 100, is_host: true, is_bot: null },
    ...over,
  });

  it('filters the r1-meet jobs by JSON path, newest first, and selects only the ids it needs', async () => {
    const { store, calls } = fakeDb(rows([event()]));
    expect(await store.participantEvents(BOT)).toEqual([
      { type: 'join', participantId: 100, isBot: null, occurredAt: '2030-01-02T10:00:01.250Z' },
    ]);
    expect(calls).toEqual([
      ['from', 'job_queue'],
      [
        'select',
        'receipt_id:payload->>receipt_id, event_type:payload->>event_type, '
        + 'occurred_at:payload->>occurred_at, participant:payload->participant',
      ],
      ['eq', 'name', 'r1-meet'],
      ['eq', 'payload->>kind', 'recall_event'],
      ['eq', 'payload->>recall_bot_id', BOT],
      ['in', 'payload->>event_type', ['participant_events.join', 'participant_events.leave']],
      ['order', 'created_at', { ascending: false }],
      ['limit', 500],
    ]);
  });

  it('parses joins and leaves, null facts and a declared bot; the host flag and any name are not read', async () => {
    const events = await fakeDb(
      rows([
        event({ receipt_id: id('c5'), event_type: 'participant_events.leave', occurred_at: null }),
        event({ receipt_id: id('c6'), participant: { id: null, is_host: null, is_bot: true, name: 'ignored' } }),
        event({ receipt_id: null, participant: { id: 0, is_host: false, is_bot: false } }),
      ]),
    ).store.participantEvents(BOT);
    expect(events).toEqual([
      { type: 'leave', participantId: 100, isBot: null, occurredAt: null },
      { type: 'join', participantId: null, isBot: true, occurredAt: '2030-01-02T10:00:01.250Z' },
      { type: 'join', participantId: 0, isBot: false, occurredAt: '2030-01-02T10:00:01.250Z' },
    ]);
    expect(JSON.stringify(events)).not.toContain('ignored');
    expect(Object.isFrozen(events)).toBe(true);
  });

  it('counts a receipt once, however many jobs carried it', async () => {
    const leave = event({ receipt_id: id('c7'), event_type: 'participant_events.leave' });
    const events = await fakeDb(rows([leave, event(), event({ receipt_id: RECEIPT.toUpperCase() }), leave])).store.participantEvents(BOT);
    expect(events.map((e) => e.type)).toEqual(['leave', 'join']);
    // Without a receipt id nothing can be matched, so nothing is dropped.
    const loose = await fakeDb(rows([event({ receipt_id: null }), event({ receipt_id: null })])).store.participantEvents(BOT);
    expect(loose).toHaveLength(2);
  });

  it('refuses a malformed row, an error or no list', async () => {
    for (const bad of [
      event({ receipt_id: 'x' }),
      event({ receipt_id: undefined }),
      event({ event_type: 'bot.done' }),
      event({ event_type: null }),
      event({ occurred_at: 'soon' }),
      event({ participant: null }),
      event({ participant: [] }),
      event({ participant: { id: 1 } }),
      event({ participant: { id: '1', is_bot: null } }),
      event({ participant: { id: -1, is_bot: null } }),
      event({ participant: { id: 1, is_bot: 'no' } }),
      'row',
    ]) {
      await expectCode(fakeDb(rows([bad])).store.participantEvents(BOT), 'r1_meet_db_error', JSON.stringify(bad));
    }
    await expectCode(fakeDb(rows(null)).store.participantEvents(BOT), 'r1_meet_db_error');
    await expectCode(fakeDb({ data: [], error: { message: 'x' } }).store.participantEvents(BOT), 'r1_meet_db_error');
  });
});

describe('sessionStatus and roundLive', () => {
  it('reads one call session; null when it is gone', async () => {
    const { store, calls } = fakeDb(rows({ id: SESSION, status: 'in_progress' }));
    expect(await store.sessionStatus(SESSION)).toBe('in_progress');
    expect(calls).toEqual([['from', 'call_sessions'], ['select', 'id, status'], ['eq', 'id', SESSION], ['maybeSingle']]);
    expect(await fakeDb(rows(null)).store.sessionStatus(SESSION)).toBeNull();
    for (const status of R1_MEET_SESSION_STATUSES) {
      expect(await fakeDb(rows({ id: SESSION, status })).store.sessionStatus(SESSION)).toBe(status);
    }
    for (const status of [null, 'ended', 7, undefined]) {
      await expectCode(fakeDb(rows({ id: SESSION, status })).store.sessionStatus(SESSION), 'r1_meet_db_error', String(status));
    }
    await expectCode(fakeDb({ data: null, error: { message: 'x' } }).store.sessionStatus(SESSION), 'r1_meet_db_error');
  });

  it('knows exactly the session statuses of 0006', () => {
    const lifecycle = readFileSync(path.join(migrations, '0006_session_lifecycle.sql'), 'utf8').replace(/\s+/g, ' ');
    const check = /add constraint chk_call_sessions_status check \( status in \(([^)]*)\)/.exec(lifecycle)![1]!;
    expect([...check.matchAll(/'(\w+)'/g)].map((m) => m[1])).toEqual([...R1_MEET_SESSION_STATUSES]);
  });

  it('a round is live as 0142 says: Meet, invited or in progress, not lapsed', async () => {
    const nowMs = Date.parse(NOW);
    const round = (over: Record<string, unknown> = {}) => ({ id: ROUND, channel: 'meet', status: 'invited', expires_at: '2030-01-01T10:00:00.001+00:00', ...over });
    const live = (over: Record<string, unknown> = {}) => fakeDb(rows(round(over))).store.roundLive(ROUND, nowMs);
    const { store, calls } = fakeDb(rows(round()));
    expect(await store.roundLive(ROUND, nowMs)).toBe(true);
    expect(calls).toEqual([['from', 'interview_rounds'], ['select', 'id, channel, status, expires_at'], ['eq', 'id', ROUND], ['maybeSingle']]);
    expect(await live({ status: 'in_progress' })).toBe(true);
    expect(await live({ expires_at: NOW })).toBe(false);
    expect(await live({ expires_at: '2030-01-01T09:59:59+00:00' })).toBe(false);
    expect(await live({ channel: 'browser' })).toBe(false);
    for (const status of ['completed', 'cancelled', 'expired', 'draft']) expect(await live({ status }), status).toBe(false);
    expect(await fakeDb(rows(null)).store.roundLive(ROUND, nowMs)).toBe(false);
    for (const bad of [{ channel: null }, { status: '' }, { expires_at: null }, { expires_at: 'soon' }, { status: undefined }]) {
      await expectCode(live(bad), 'r1_meet_db_error', JSON.stringify(bad));
    }
    await expectCode(fakeDb({ data: null, error: { message: 'x' } }).store.roundLive(ROUND, nowMs), 'r1_meet_db_error');
    expect(sql).toContain("v_round.channel <> 'meet' or v_round.status not in ('invited', 'in_progress') or v_round.expires_at <= p_now");
  });
});

describe('attemptSettlement and roundStart (PR #444 review S06-R1)', () => {
  it('reads the attempt of one session by its primary key; null when it has none', async () => {
    const { store, calls } = fakeDb(rows({ session_id: SESSION, outcome: 'provider_error', counted: false }));
    expect(await store.attemptSettlement(SESSION)).toEqual({ outcome: 'provider_error', counted: false });
    expect(calls).toEqual([
      ['from', 'interview_round_attempts'],
      ['select', 'session_id, outcome, counted'],
      ['eq', 'session_id', SESSION],
      ['maybeSingle'],
    ]);
    expect(await fakeDb(rows(null)).store.attemptSettlement(SESSION)).toBeNull();
    // Not settled yet, settled and counted, and an outcome word this build does not know.
    expect(await fakeDb(rows({ session_id: SESSION, outcome: null, counted: false })).store.attemptSettlement(SESSION)).toEqual({
      outcome: null,
      counted: false,
    });
    expect(await fakeDb(rows({ session_id: SESSION, outcome: 'complete', counted: true })).store.attemptSettlement(SESSION)).toEqual({
      outcome: 'complete',
      counted: true,
    });
    expect(await fakeDb(rows({ session_id: SESSION, outcome: 'newer_word', counted: false })).store.attemptSettlement(SESSION)).toEqual({
      outcome: 'newer_word',
      counted: false,
    });
    for (const bad of [{ counted: null }, { counted: 'yes' }, { outcome: '' }, { outcome: 7 }, { counted: undefined }]) {
      const answer = rows({ session_id: SESSION, outcome: 'complete', counted: true, ...bad });
      await expectCode(fakeDb(answer).store.attemptSettlement(SESSION), 'r1_meet_db_error', JSON.stringify(bad));
    }
    await expectCode(fakeDb({ data: null, error: { message: 'x' } }).store.attemptSettlement(SESSION), 'r1_meet_db_error');
  });

  it('a round is startable while live with a start and an attempt left; complete when its attempts are counted', async () => {
    const nowMs = Date.parse(NOW);
    const round = (over: Record<string, unknown> = {}) => ({
      id: ROUND,
      channel: 'meet',
      status: 'in_progress',
      expires_at: '2030-01-02T10:00:00+00:00',
      starts_used: 1,
      attempts_counted: 0,
      attempts_allowed: 2,
      ...over,
    });
    const start = (over: Record<string, unknown> = {}) => fakeDb(rows(round(over))).store.roundStart(ROUND, nowMs);
    const { store, calls } = fakeDb(rows(round()));
    expect(await store.roundStart(ROUND, nowMs)).toBe('startable');
    expect(calls).toEqual([
      ['from', 'interview_rounds'],
      ['select', 'id, channel, status, expires_at, starts_used, attempts_counted, attempts_allowed'],
      ['eq', 'id', ROUND],
      ['maybeSingle'],
    ]);
    expect(await start({ status: 'invited', starts_used: 0 })).toBe('startable');
    expect(await start({ starts_used: 2, attempts_counted: 1 })).toBe('startable');
    expect(await start({ starts_used: 3 })).toBe('closed');
    expect(await start({ expires_at: NOW })).toBe('closed');
    expect(await start({ channel: 'browser' })).toBe('closed');
    for (const status of ['completed', 'cancelled', 'expired']) expect(await start({ status }), status).toBe('closed');
    // Counted attempts all used: settled, whatever else the round says (0120 completes it).
    expect(await start({ attempts_counted: 2, status: 'completed' })).toBe('complete');
    expect(await start({ attempts_counted: 1, attempts_allowed: 1, starts_used: 3 })).toBe('complete');
    expect(await fakeDb(rows(null)).store.roundStart(ROUND, nowMs)).toBe('closed');
    for (const bad of [{ starts_used: 4 }, { starts_used: -1 }, { attempts_allowed: 0 }, { attempts_counted: null }, { channel: null }, { expires_at: 'soon' }]) {
      await expectCode(start(bad), 'r1_meet_db_error', JSON.stringify(bad));
    }
    await expectCode(fakeDb({ data: null, error: { message: 'x' } }).store.roundStart(ROUND, nowMs), 'r1_meet_db_error');
  });
});

describe('finishReceipt: compare and set on the outcome', () => {
  it('moves an open receipt to its final outcome, once', async () => {
    for (const outcome of ['processed', 'ignored', 'failed'] as const) {
      const { store, calls } = fakeDb(rows([{ id: RECEIPT }]));
      expect(await store.finishReceipt(RECEIPT, outcome, NOW)).toBe(true);
      expect(calls).toEqual([
        ['from', 'r1_meet_receipts'],
        ['update', { outcome, processed_at: NOW }],
        ['eq', 'id', RECEIPT],
        ['in', 'outcome', ['recorded', 'enqueued']],
        ['select', 'id'],
      ]);
    }
    expect(await fakeDb(rows([])).store.finishReceipt(RECEIPT, 'processed', NOW)).toBe(false);
    await expectCode(fakeDb(rows(null)).store.finishReceipt(RECEIPT, 'processed', NOW), 'r1_meet_db_error');
    await expectCode(fakeDb({ data: null, error: { message: 'x' } }).store.finishReceipt(RECEIPT, 'processed', NOW), 'r1_meet_db_error');
    // 0142: processed_at is set exactly while the outcome is final.
    expect(sql).toContain("(processed_at is null) = (outcome in ('recorded', 'enqueued'))");
  });
});

// ── The RPCs ─────────────────────────────────────────────────────────────────

const CREATE_INPUT = {
  eventId: EVENT,
  scheduleId: SCHEDULE,
  applicationId: APPLICATION,
  interviewStageId: STAGE,
  interviewId: null,
  scheduledByUserId: SCHEDULER,
  attestedAt: '2030-01-01T09:00:00.000Z',
  ashbyUpdatedAt: '2030-01-01T09:00:00.000Z',
  meetUrl: MEET_URL,
  startAt: '2030-01-02T10:00:00.000Z',
  endAt: '2030-01-02T10:45:00.000Z',
  createdBy: USER,
  objectiveProfile: 'r1_dex_sales',
  nowIso: NOW,
};
const RESCHEDULE_INPUT = {
  bookingId: BOOKING,
  expectedVersion: 2,
  startAt: '2030-01-02T11:00:00.000Z',
  endAt: '2030-01-02T11:45:00.000Z',
  meetUrl: MEET_URL,
  ashbyUpdatedAt: null,
  nowIso: NOW,
};
const TERMINAL_ANSWER = { booking_id: BOOKING, booking_status: 'failed', reason: 'no_show' };
const COUNTERS = { version: 2, key_attempt: 1 };

/**
 * Per RPC: how it is called, the arguments sent, and one answer per status with EXACTLY the keys the
 * parser needs (each is removed and broken in turn below) beside the parsed form.
 */
const RPCS: {
  [K in R1MeetRpcName]: {
    call: (store: R1MeetStore) => Promise<unknown>;
    args: Record<string, unknown>;
    answers: Record<string, [answer: Record<string, unknown>, parsed: Record<string, unknown>]>;
  };
} = {
  r1_meet_create_round_from_ashby: {
    call: (store) => store.createRound(CREATE_INPUT),
    args: {
      p_ashby_interview_event_id: EVENT,
      p_ashby_schedule_id: SCHEDULE,
      p_ashby_application_id: APPLICATION,
      p_ashby_interview_stage_id: STAGE,
      p_ashby_interview_id: null,
      p_ashby_scheduled_by_user_id: SCHEDULER,
      p_attested_at: '2030-01-01T09:00:00.000Z',
      p_ashby_updated_at: '2030-01-01T09:00:00.000Z',
      p_meet_url: MEET_URL,
      p_start_at: '2030-01-02T10:00:00.000Z',
      p_end_at: '2030-01-02T10:45:00.000Z',
      p_created_by: USER,
      p_objective_profile: 'r1_dex_sales',
      p_expiry_grace_sec: 7200,
      p_now: NOW,
    },
    answers: {
      created: [
        { booking_id: BOOKING, round_id: ROUND, ...COUNTERS, round_expires_at: '2030-01-02T12:45:00+00:00', objective_profile: 'r1_dex_sales' },
        { bookingId: BOOKING, roundId: ROUND, version: 2, keyAttempt: 1, roundExpiresAt: '2030-01-02T12:45:00.000Z', objectiveProfile: 'r1_dex_sales', rebound: false },
      ],
      relinked: [
        { booking_id: BOOKING, round_id: ROUND, ...COUNTERS, round_expires_at: '2030-01-02T12:45:00+00:00', objective_profile: 'r1_dex_sales' },
        { bookingId: BOOKING, roundId: ROUND, version: 2, keyAttempt: 1, roundExpiresAt: '2030-01-02T12:45:00.000Z', objectiveProfile: 'r1_dex_sales', rebound: false },
      ],
      exists: [
        {
          booking_id: BOOKING,
          round_id: ROUND,
          booking_status: 'bot_scheduled',
          reason: 'eligible',
          ...COUNTERS,
          round_expires_at: '2030-01-02T12:45:00+00:00',
          round_live: true,
          objective_profile: 'r1_dex_sales',
        },
        {
          bookingId: BOOKING,
          roundId: ROUND,
          bookingStatus: 'bot_scheduled',
          reason: 'eligible',
          version: 2,
          keyAttempt: 1,
          roundExpiresAt: '2030-01-02T12:45:00.000Z',
          roundLive: true,
          objectiveProfile: 'r1_dex_sales',
        },
      ],
      booking_terminal: [TERMINAL_ANSWER, { bookingId: BOOKING, bookingStatus: 'failed', reason: 'no_show' }],
      stale_update: [{ booking_id: BOOKING }, { bookingId: BOOKING }],
      bot_attached: [{ booking_id: BOOKING, booking_status: 'failed', ...COUNTERS }, { bookingId: BOOKING, bookingStatus: 'failed', version: 2, keyAttempt: 1 }],
      version_exhausted: [{ booking_id: BOOKING, version: 50 }, { bookingId: BOOKING, version: 50 }],
      unmatched_application: [
        { booking_id: BOOKING, reason: 'application_unknown' },
        { bookingId: BOOKING, reason: 'application_unknown', retryAfter: null, rebound: false },
      ],
      unmapped_scheduler: [
        { booking_id: BOOKING, reason: 'scheduler_unmapped' },
        { bookingId: BOOKING, reason: 'scheduler_unmapped', retryAfter: null, rebound: false },
      ],
      blocked: [
        { booking_id: BOOKING, reason: 'slot_too_far', retry_after: '2030-01-05T10:00:00+00:00' },
        { bookingId: BOOKING, reason: 'slot_too_far', retryAfter: '2030-01-05T10:00:00.000Z', rebound: false },
      ],
      in_past: [{}, { bookingId: null }],
      invalid_request: [{ field: 'attester' }, { field: 'attester' }],
    },
  },
  r1_meet_reschedule_booking: {
    call: (store) => store.reschedule(RESCHEDULE_INPUT),
    args: {
      p_booking_id: BOOKING,
      p_expected_version: 2,
      p_start_at: '2030-01-02T11:00:00.000Z',
      p_end_at: '2030-01-02T11:45:00.000Z',
      p_meet_url: MEET_URL,
      p_ashby_updated_at: null,
      p_expiry_grace_sec: 7200,
      p_now: NOW,
    },
    answers: {
      ok: [
        { booking_id: BOOKING, ...COUNTERS, round_expires_at: '2030-01-02T13:45:00+00:00' },
        { bookingId: BOOKING, version: 2, keyAttempt: 1, roundExpiresAt: '2030-01-02T13:45:00.000Z' },
      ],
      invalid_request: [{ field: 'slot' }, { field: 'slot' }],
      not_found: [{}, {}],
      booking_terminal: [TERMINAL_ANSWER, { bookingId: BOOKING, bookingStatus: 'failed', reason: 'no_show' }],
      version_conflict: [{ booking_id: BOOKING, ...COUNTERS }, { bookingId: BOOKING, version: 2, keyAttempt: 1 }],
      stale_update: [{ booking_id: BOOKING }, { bookingId: BOOKING }],
      booking_dispatched: [{ booking_id: BOOKING, booking_status: 'in_call' }, { bookingId: BOOKING, bookingStatus: 'in_call' }],
      bot_attached: [{ booking_id: BOOKING, ...COUNTERS }, { bookingId: BOOKING, version: 2, keyAttempt: 1 }],
      no_round: [
        { booking_id: BOOKING, booking_status: 'blocked', reason: 'paused' },
        { bookingId: BOOKING, bookingStatus: 'blocked', reason: 'paused' },
      ],
      not_allowed: [{ booking_id: BOOKING, booking_status: 'bot_scheduled' }, { bookingId: BOOKING, bookingStatus: 'bot_scheduled' }],
      in_past: [{ booking_id: BOOKING }, { bookingId: BOOKING }],
      slot_too_far: [{ booking_id: BOOKING, retry_after: '2030-01-05T10:00:00+00:00' }, { bookingId: BOOKING, retryAfter: '2030-01-05T10:00:00.000Z' }],
      version_exhausted: [{ booking_id: BOOKING, version: 50 }, { bookingId: BOOKING, version: 50 }],
      round_not_live: [{ booking_id: BOOKING, round_id: ROUND }, { bookingId: BOOKING, roundId: ROUND }],
    },
  },
  r1_meet_cancel_booking: {
    call: (store) => store.cancel({ bookingId: BOOKING, reason: 'dex_absent', nowIso: NOW }),
    args: { p_booking_id: BOOKING, p_reason: 'dex_absent', p_now: NOW },
    answers: {
      ok: [
        { booking_id: BOOKING, previous_status: 'in_call', recall_bot_id: BOT, bot_dispatched: true },
        { bookingId: BOOKING, previousStatus: 'in_call', recallBotId: BOT, botDispatched: true },
      ],
      already_cancelled: [
        { booking_id: BOOKING, reason: 'cancelled', recall_bot_id: BOT },
        { bookingId: BOOKING, reason: 'cancelled', recallBotId: BOT },
      ],
      booking_terminal: [TERMINAL_ANSWER, { bookingId: BOOKING, bookingStatus: 'failed', reason: 'no_show' }],
      not_found: [{}, {}],
      invalid_reason: [{}, {}],
      invalid_request: [{ field: 'now' }, { field: 'now' }],
    },
  },
  r1_meet_set_bot: {
    call: (store) =>
      store.setBot({ bookingId: BOOKING, action: 'attach', expectedVersion: 2, expectedKeyAttempt: 1, recallBotId: BOT, nowIso: NOW }),
    args: {
      p_booking_id: BOOKING,
      p_action: 'attach',
      p_expected_version: 2,
      p_expected_key_attempt: 1,
      p_recall_bot_id: BOT,
      p_now: NOW,
    },
    answers: {
      ...Object.fromEntries(
        ['ok', 'duplicate', 'bot_conflict', 'bot_in_use', 'not_allowed', 'in_past', 'round_not_live', 'key_attempts_exhausted', 'version_exhausted', 'version_conflict'].map(
          (status) => [
            status,
            [
              { booking_id: BOOKING, ...COUNTERS, booking_status: 'pending' },
              { bookingId: BOOKING, version: 2, keyAttempt: 1, bookingStatus: 'pending' },
            ] as [Record<string, unknown>, Record<string, unknown>],
          ],
        ),
      ),
      not_found: [{}, {}],
      invalid_action: [{}, {}],
      invalid_request: [{ field: 'recall_bot_id' }, { field: 'recall_bot_id' }],
    },
  },
  r1_meet_transition_booking: {
    call: (store) => store.transition({ bookingId: BOOKING, from: 'bot_joining', to: 'human_present', reason: 'eligible', nowIso: NOW }),
    args: {
      p_booking_id: BOOKING,
      p_from_status: 'bot_joining',
      p_to_status: 'human_present',
      p_reason: 'eligible',
      p_now: NOW,
    },
    answers: {
      ok: [
        { booking_id: BOOKING, previous_status: 'bot_joining', recall_bot_id: BOT },
        { bookingId: BOOKING, previousStatus: 'bot_joining', recallBotId: BOT },
      ],
      status_conflict: [{ booking_id: BOOKING, current: 'in_call' }, { bookingId: BOOKING, current: 'in_call' }],
      invalid_transition: [{ booking_id: BOOKING }, { bookingId: BOOKING }],
      not_found: [{}, {}],
      invalid_request: [{ field: 'now' }, { field: 'now' }],
    },
  },
  r1_meet_arm_ticket: {
    call: (store) =>
      store.armTicket({
        bookingId: BOOKING,
        ticketDigest: 'ab'.repeat(32),
        notBefore: '2030-01-02T09:55:00.000Z',
        expiresAt: '2030-01-02T11:00:00.000Z',
        nowIso: NOW,
      }),
    args: {
      p_booking_id: BOOKING,
      p_ticket_digest: 'ab'.repeat(32),
      p_not_before: '2030-01-02T09:55:00.000Z',
      p_expires_at: '2030-01-02T11:00:00.000Z',
      p_now: NOW,
    },
    answers: {
      ok: [
        { booking_id: BOOKING, not_before: '2030-01-02T09:55:00+00:00', expires_at: '2030-01-02T11:00:00+00:00', ticket_arms: 1 },
        { bookingId: BOOKING, notBefore: '2030-01-02T09:55:00.000Z', expiresAt: '2030-01-02T11:00:00.000Z', ticketArms: 1 },
      ],
      duplicate: [
        { booking_id: BOOKING, not_before: '2030-01-02T09:55:00+00:00', expires_at: '2030-01-02T11:00:00+00:00', ticket_arms: 1 },
        { bookingId: BOOKING, notBefore: '2030-01-02T09:55:00.000Z', expiresAt: '2030-01-02T11:00:00.000Z', ticketArms: 1 },
      ],
      invalid_ticket: [{}, {}],
      invalid_window: [{}, {}],
      not_found: [{}, {}],
      not_armable: [{ booking_id: BOOKING, booking_status: 'pending' }, { bookingId: BOOKING, bookingStatus: 'pending' }],
      digest_in_use: [{ booking_id: BOOKING }, { bookingId: BOOKING }],
      ticket_arms_exhausted: [{ booking_id: BOOKING, ticket_arms: 5 }, { bookingId: BOOKING, ticketArms: 5 }],
      invalid_request: [{ field: 'now' }, { field: 'now' }],
    },
  },
  r1_meet_prune_receipts: {
    call: (store) => store.pruneReceipts({ olderThan: '2029-12-02T10:00:00.000Z', limit: 500, nowIso: NOW }),
    args: { p_older_than: '2029-12-02T10:00:00.000Z', p_limit: 500, p_now: NOW },
    answers: {
      ok: [{ deleted: 12 }, { deleted: 12 }],
      retention_too_short: [{}, {}],
      invalid_request: [{ field: 'limit' }, { field: 'limit' }],
    },
  },
  r1_meet_prune_bookings: {
    call: (store) => store.pruneBookings({ olderThan: '2029-12-02T10:00:00.000Z', limit: 500, nowIso: NOW }),
    args: { p_older_than: '2029-12-02T10:00:00.000Z', p_limit: 500, p_now: NOW },
    answers: {
      ok: [{ deleted: 0 }, { deleted: 0 }],
      retention_too_short: [{}, {}],
      invalid_request: [{ field: 'older_than' }, { field: 'older_than' }],
    },
  },
};
const RPC_NAMES = Object.keys(RPCS) as R1MeetRpcName[];

describe('the RPC contract with migration 0142', () => {
  it('wraps exactly the eight RPCs S06 calls', () => {
    expect(Object.keys(R1_MEET_RPC_ANSWERS).sort()).toEqual([...RPC_NAMES].sort());
    expect(RPC_NAMES).toHaveLength(8);
  });

  it.each(RPC_NAMES)('%s: sends exactly the declared parameters, in order', async (name) => {
    const [firstStatus, [answer]] = Object.entries(RPCS[name].answers)[0]!;
    const { store, calls } = fakeDb(rows({ status: firstStatus, ...answer }));
    await RPCS[name].call(store);
    expect(calls).toEqual([['rpc', name, RPCS[name].args]]);
    const sent = Object.keys(calls[0]![2] as object);
    expect(sent).toEqual(sqlParams(name).map((param) => param.name));
  });

  it('sends the grace 0142 defaults to, and the S01 profile', () => {
    for (const name of ['r1_meet_create_round_from_ashby', 'r1_meet_reschedule_booking'] as const) {
      const grace = sqlParams(name).find((param) => param.name === 'p_expiry_grace_sec')!;
      expect(grace.defaultSql).toBe(String(R1_MEET_ROUND_EXPIRY_GRACE_SEC));
    }
    expect(sqlParams('r1_meet_create_round_from_ashby').find((p) => p.name === 'p_objective_profile')!.defaultSql).toBe("'r1_dex_sales'");
  });

  it.each(RPC_NAMES)('%s: every status of its catalog comment is a known answer, and none is missing', (name) => {
    expect(catalogAnswers(name)).toEqual([...R1_MEET_RPC_ANSWERS[name]]);
    expect(Object.keys(RPCS[name].answers).sort()).toEqual([...R1_MEET_RPC_ANSWERS[name]].sort());
  });

  it.each(RPC_NAMES)('%s: every status its body writes is a known answer', (name) => {
    const written = bodyAnswers(name);
    expect(written.length).toBeGreaterThan(2);
    expect(written.filter((status) => !(R1_MEET_RPC_ANSWERS[name] as readonly string[]).includes(status))).toEqual([]);
  });

  it.each(RPC_NAMES)('%s: parses every answer, and reads nothing it does not need', async (name) => {
    for (const [status, [answer, parsed]] of Object.entries(RPCS[name].answers)) {
      const extra = { candidate_id: CANDIDATE, from_status: 'pending', to_status: null, anything: { nested: true } };
      const result = await RPCS[name].call(fakeDb(rows({ status, ...extra, ...answer })).store);
      expect(result, status).toEqual({ status, ...parsed });
      expect(Object.isFrozen(result), status).toBe(true);
      expect(JSON.stringify(result), status).not.toContain(CANDIDATE);
    }
  });

  it.each(RPC_NAMES)('%s: an answer without a needed key, or with a broken one, is r1_meet_rpc_unexpected', async (name) => {
    for (const [status, [answer]] of Object.entries(RPCS[name].answers)) {
      for (const key of Object.keys(answer)) {
        const dropped: Record<string, unknown> = { status, ...answer };
        delete dropped[key];
        await expectCode(RPCS[name].call(fakeDb(rows(dropped)).store), 'r1_meet_rpc_unexpected', `${status} without ${key}`);
        for (const broken of [{}, '', -1]) {
          await expectCode(
            RPCS[name].call(fakeDb(rows({ status, ...answer, [key]: broken })).store),
            'r1_meet_rpc_unexpected',
            `${status} with ${key} = ${JSON.stringify(broken)}`,
          );
        }
      }
    }
  });

  it.each(RPC_NAMES)('%s: an unknown status, a non-object or a missing status is r1_meet_rpc_unexpected', async (name) => {
    const unknown = [{ status: 'brand_new' }, { status: 'OK' }, { status: null }, { status: 1 }, {}, null, undefined, 'ok', [{ status: 'ok' }], 7];
    for (const data of unknown) {
      await expectCode(RPCS[name].call(fakeDb(rows(data)).store), 'r1_meet_rpc_unexpected', JSON.stringify(data));
    }
  });

  it.each(RPC_NAMES)('%s: a DB error, a rejected call or a throwing client is r1_meet_db_error', async (name) => {
    const first = Object.entries(RPCS[name].answers)[0]!;
    await expectCode(RPCS[name].call(fakeDb({ data: { status: first[0], ...first[1][0] }, error: { code: '23514', message: 'secret' } }).store), 'r1_meet_db_error');
    await expectCode(RPCS[name].call(fakeDb(new Error('socket')).store), 'r1_meet_db_error');
    await expectCode(RPCS[name].call(fakeDb('throw').store), 'r1_meet_db_error');
  });
});

describe('RPC details', () => {
  it('create: rebound only when the RPC says so; retry_after exactly for slot_too_far', async () => {
    const create = (data: Record<string, unknown>) => fakeDb(rows(data)).store.createRound(CREATE_INPUT);
    const created = { status: 'created', ...RPCS.r1_meet_create_round_from_ashby.answers.created![0] };
    expect(await create({ ...created, rebound: true })).toMatchObject({ status: 'created', rebound: true });
    for (const rebound of [false, 'true', 1, null]) await expectCode(create({ ...created, rebound }), 'r1_meet_rpc_unexpected', String(rebound));
    const blocked = (over: Record<string, unknown>) => create({ status: 'blocked', booking_id: BOOKING, ...over });
    expect(await blocked({ reason: 'paused', rebound: true })).toEqual({ status: 'blocked', bookingId: BOOKING, reason: 'paused', retryAfter: null, rebound: true });
    await expectCode(blocked({ reason: 'slot_too_far' }), 'r1_meet_rpc_unexpected');
    await expectCode(blocked({ reason: 'paused', retry_after: '2030-01-05T10:00:00+00:00' }), 'r1_meet_rpc_unexpected');
  });

  it('create: in_past with and without a booking, exists with an unreadable round expiry', async () => {
    const create = (data: Record<string, unknown>) => fakeDb(rows(data)).store.createRound(CREATE_INPUT);
    expect(await create({ status: 'in_past', booking_id: BOOKING })).toEqual({ status: 'in_past', bookingId: BOOKING });
    await expectCode(create({ status: 'in_past', booking_id: 'x' }), 'r1_meet_rpc_unexpected');
    const exists = { status: 'exists', ...RPCS.r1_meet_create_round_from_ashby.answers.exists![0] };
    expect(await create({ ...exists, round_expires_at: null, round_live: false })).toMatchObject({ roundExpiresAt: null, roundLive: false });
  });

  it('create and reschedule: a null createdBy and null Ashby ids travel as null', async () => {
    const { store, calls } = fakeDb(rows({ status: 'unmapped_scheduler', booking_id: BOOKING, reason: 'scheduler_unmapped' }));
    await store.createRound({ ...CREATE_INPUT, createdBy: null, interviewStageId: null, ashbyUpdatedAt: null });
    expect(calls[0]![2]).toMatchObject({ p_created_by: null, p_ashby_interview_stage_id: null, p_ashby_updated_at: null });
  });

  it('cancel: accepts exactly the reasons of 0142, and a booking without a bot', async () => {
    const list = /p_reason not in \(([^)]*)\)/.exec(functionText('r1_meet_cancel_booking'))![1]!;
    expect([...list.matchAll(/'(\w+)'/g)].map((m) => m[1])).toEqual([...R1_MEET_CANCEL_REASONS]);
    const cancel = (data: unknown) => fakeDb(rows(data)).store.cancel({ bookingId: BOOKING, reason: 'cancelled', nowIso: NOW });
    expect(await cancel({ status: 'ok', booking_id: BOOKING, previous_status: 'pending', recall_bot_id: null, bot_dispatched: false })).toEqual({
      status: 'ok',
      bookingId: BOOKING,
      previousStatus: 'pending',
      recallBotId: null,
      botDispatched: false,
    });
    expect(await cancel({ status: 'already_cancelled', booking_id: BOOKING, reason: 'dex_absent', recall_bot_id: null })).toMatchObject({ recallBotId: null });
  });

  it('set_bot: only attach sends a bot id', async () => {
    for (const action of ['rotate_key', 'replace', 'release'] as const) {
      const { store, calls } = fakeDb(rows({ status: 'ok', booking_id: BOOKING, ...COUNTERS, booking_status: 'pending' }));
      await store.setBot({ bookingId: BOOKING, action, expectedVersion: 2, expectedKeyAttempt: 1, nowIso: NOW });
      expect(calls[0]![2], action).toEqual({
        p_booking_id: BOOKING,
        p_action: action,
        p_expected_version: 2,
        p_expected_key_attempt: 1,
        p_recall_bot_id: null,
        p_now: NOW,
      });
    }
    const actions = /p_action not in \(([^)]*)\)/.exec(functionText('r1_meet_set_bot'))![1]!;
    expect([...actions.matchAll(/'(\w+)'/g)].map((m) => m[1])).toEqual(['attach', 'rotate_key', 'replace', 'release']);
  });

  it('transition: a terminal booking may hold no bot', async () => {
    const result = await fakeDb(rows({ status: 'ok', booking_id: BOOKING, previous_status: 'pending', recall_bot_id: null })).store.transition({
      bookingId: BOOKING,
      from: 'pending',
      to: 'failed',
      reason: 'round_expired',
      nowIso: NOW,
    });
    expect(result).toEqual({ status: 'ok', bookingId: BOOKING, previousStatus: 'pending', recallBotId: null });
  });

  it('a failed arm never puts the digest in the error', async () => {
    const digest = 'cd'.repeat(32);
    const input = { bookingId: BOOKING, ticketDigest: digest, notBefore: NOW, expiresAt: NOW, nowIso: NOW };
    for (const answer of [{ data: null, error: { message: digest } }, { data: { status: digest }, error: null }, new Error(digest)] as const) {
      const error = await fakeDb(answer).store.armTicket(input).then(() => null, (reason: unknown) => reason);
      expect(error).toBeInstanceOf(R1MeetJobError);
      expect(`${String(error)} ${JSON.stringify(error)} ${(error as Error).stack ?? ''}`).not.toContain(digest);
      expect((error as Error).cause).toBeUndefined();
    }
  });
});

describe('through the real client (no network: fetch is a stub)', () => {
  /** The requests a store makes, as the PostgREST URL and its decoded query. */
  function realStore(body: string, headers: Record<string, string> = {}) {
    const requests: Array<{ method: string; table: string; query: Record<string, string> }> = [];
    const client = createClient('https://db.example.test', 'k'.repeat(40), {
      auth: { persistSession: false, autoRefreshToken: false },
      db: { schema: 'screening_v2' },
      global: {
        fetch: async (input: unknown, init?: { method?: string }) => {
          const url = new URL(String(input));
          requests.push({ method: init?.method ?? 'GET', table: url.pathname.split('/').pop()!, query: Object.fromEntries(url.searchParams) });
          return new Response(init?.method === 'HEAD' ? null : body, { status: 200, headers: { 'content-type': 'application/json', ...headers } });
        },
      },
    });
    return { store: createR1MeetStore(client as unknown as typeof supabase), requests };
  }

  it('writes the JSON paths of the participant events as PostgREST reads them', async () => {
    const { store, requests } = realStore(
      JSON.stringify([{ receipt_id: RECEIPT, event_type: 'participant_events.leave', occurred_at: null, participant: { id: 3, is_host: null, is_bot: null } }]),
    );
    expect(await store.participantEvents(BOT)).toEqual([{ type: 'leave', participantId: 3, isBot: null, occurredAt: null }]);
    expect(requests).toEqual([
      {
        method: 'GET',
        table: 'job_queue',
        query: {
          select: 'receipt_id:payload->>receipt_id,event_type:payload->>event_type,occurred_at:payload->>occurred_at,participant:payload->participant',
          name: 'eq.r1-meet',
          'payload->>kind': 'eq.recall_event',
          'payload->>recall_bot_id': `eq.${BOT}`,
          'payload->>event_type': 'in.(participant_events.join,participant_events.leave)',
          order: 'created_at.desc',
          limit: '500',
        },
      },
    ]);
  });

  it('writes the owed releases, the delivery read and the cap count as PostgREST reads them', async () => {
    const owed = realStore(JSON.stringify([row({ status: 'cancelled', reason: 'cancelled' })]));
    expect(await owed.store.listOwedReleases(20)).toHaveLength(1);
    expect(owed.requests[0]!.query).toEqual({
      select: COLUMNS.replaceAll(' ', ''),
      recall_bot_id: 'not.is.null',
      status: 'in.(completed,cancelled,failed,drained)',
      order: 'updated_at.asc',
      limit: '20',
    });
    const delivery = realStore('[]');
    expect(await delivery.store.newerAshbyDelivery({ scheduleId: SCHEDULE, ashbyUpdatedAt: NOW, receivedAt: null })).toBe(false);
    expect(delivery.requests[0]!.query).toEqual({
      select: 'dedupe_key,received_at',
      source: 'eq.ashby',
      dedupe_key: `like.ashby-schedule:${SCHEDULE}:%`,
      order: 'received_at.desc',
      limit: '100',
    });
    const cap = realStore('', { 'content-range': '*/4' });
    expect(await cap.store.countBotsInDay({ ...r1MeetIstDay(NOW)!, excludeId: BOOKING })).toBe(4);
    expect(cap.requests).toHaveLength(1);
    expect(cap.requests[0]).toMatchObject({ method: 'HEAD', table: 'r1_meet_bookings', query: { id: `neq.${BOOKING}` } });
  });
});

describe('the port itself', () => {
  it('is frozen and makes no call until a method runs', () => {
    const { store, calls } = fakeDb();
    expect(Object.isFrozen(store)).toBe(true);
    expect(calls).toEqual([]);
    expect(Object.keys(store).sort()).toEqual([
      'armTicket',
      'attemptSettlement',
      'cancel',
      'countBotsInDay',
      'createRound',
      'finishReceipt',
      'getBooking',
      'getBookingByBot',
      'getBookingByEvent',
      'getBookingBySession',
      'listCapBlocked',
      'listDrainable',
      'listInCall',
      'listLiveBySchedule',
      'listOverdue',
      'listOwedReleases',
      'listStuckPending',
      'newerAshbyDelivery',
      'participantEvents',
      'pruneBookings',
      'pruneReceipts',
      'reschedule',
      'roundLive',
      'roundStart',
      'sessionStatus',
      'setBot',
      'transition',
    ]);
  });

  it('never names the digest or the candidate in a read', () => {
    const source = readFileSync(path.resolve(here, '../lib/r1/meet/runtime-store.ts'), 'utf8').replace(/\/\*[\s\S]*?\*\//g, '');
    expect(source).not.toMatch(/candidate_id/);
    // The one mention is the RPC parameter that stores it.
    expect([...source.matchAll(/ticket_digest/g)]).toHaveLength(1);
    expect(source).toContain('p_ticket_digest: input.ticketDigest');
    expect(source).toMatch(/import type \{ supabase \} from '\.\.\/\.\.\/supabase\.js';/);
  });
});
