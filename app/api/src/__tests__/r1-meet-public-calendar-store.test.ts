/**
 * M035 S05 T1: the database port of Lexy's calendar for public bookings
 * (lib/r1/meet/public/calendar-store.ts).
 *
 * Pinned here, over the in-memory 0142/0143 port (support/r1-meet-fake-db.ts) wrapped in a recording
 * proxy, and over a hand-rolled client for the malformed cases:
 *  - every read's exact table, columns, filters, order and limit; never `manage_token_digest`,
 *    `public_request_id`, `ticket_*`, `recall_bot_id` or `session_id`;
 *  - every list answers public rows only and respects each predicate edge, oldest slot first;
 *  - a row 0143 would refuse is `r1_meet_db_error` (source, status, reason, calendar state, event id,
 *    the public-column rule, a zoneless instant, a Meet link that is not canonical, the move count);
 *  - the three RPC wrappers send exactly the 0143 parameter names and read every catalog answer;
 *    `invalid_request`, an unknown status or a wrong shape is `r1_meet_rpc_unexpected`;
 *    `R1_MEET_PUBLIC_CALENDAR_RPC_ANSWERS` is the 0143 catalog comments, in order;
 *  - the link and email reads answer null for a missing row; any failure is the bare code, and the
 *    email never reaches an error message.
 * Synthetic ids only; the one email is an `@example.test` sentinel; no network.
 */

import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import type { supabase } from '../lib/supabase.js';
import { R1MeetJobError, R1_MEET_DB_ERROR, R1_MEET_RPC_UNEXPECTED } from '../lib/r1/meet/jobs.js';
import { R1_MEET_BOOKING_COLUMNS } from '../lib/r1/meet/runtime-store.js';
import {
  R1_MEET_CALENDAR_BOOKING_COLUMNS,
  R1_MEET_CALENDAR_STATES,
  R1_MEET_PUBLIC_CALENDAR_RPC_ANSWERS,
  createR1MeetCalendarStore,
  type R1MeetCalendarBooking,
  type R1MeetCalendarStore,
  type R1MeetPublicCalendarRpcName,
} from '../lib/r1/meet/public/calendar-store.js';
import { FAKE_STATUS_REASONS, type FakeAnswer, type R1MeetFakeDb, type Row } from './support/r1-meet-fake-db.js';
import { createR1MeetHarness, fixtureId, type R1MeetHarness } from './support/r1-meet-harness.js';

// ── Migration 0143 ───────────────────────────────────────────────────────────

const here = path.dirname(fileURLToPath(import.meta.url));
const raw0143 = readFileSync(path.resolve(here, '../../../supabase/migrations/0143_r1_meet_public_bookings.sql'), 'utf8').replace(/\r\n/g, '\n');
const sql0143 = raw0143.replace(/^\s*--.*$/gm, '').replace(/\s+/g, ' ');

function catalogAnswers(name: string): string[] {
  const statement = new RegExp(String.raw`comment on function screening_v2\.${name}\([^)]*\) is ((?:'(?:[^']|'')*' ?)+);`).exec(sql0143);
  expect(statement, name).not.toBeNull();
  const text = [...statement![1]!.matchAll(/'((?:[^']|'')*)'/g)].map((m) => m[1]!).join('');
  const list = text.slice(text.indexOf('Answers ') + 'Answers '.length);
  return list.split('|').map((part) => /^\s*([a-z_]+)/.exec(part)?.[1] ?? `unreadable: ${part}`);
}

/** The parameter names of one 0143 function, in order. */
function parameters(name: string): string[] {
  const start = raw0143.indexOf(`create or replace function screening_v2.${name}(\n`);
  expect(start, name).toBeGreaterThan(-1);
  const list = raw0143.slice(start, raw0143.indexOf('\n)\n', start));
  return [...list.matchAll(/^ {2}(p_[a-z_]+) /gm)].map((m) => m[1]!);
}

// ── Fixtures ─────────────────────────────────────────────────────────────────

const NOW = '2030-01-01T10:00:00.000Z';
const NOW_MS = Date.parse(NOW);
const MIN = 60_000;
const DAY = 24 * 60 * MIN;
const at = (offsetMs: number): string => new Date(NOW_MS + offsetMs).toISOString();
const BOT_STATUSES = ['bot_scheduled', 'bot_joining', 'human_present', 'in_call'];
/** 64-hex fixtures, built at run time. */
const A_DIGEST = 'a'.repeat(64);
const KEY_DIGEST = (fill: string): string => fill.repeat(64);
/** The one email of this file: a sentinel that must never reach an error message. */
const EMAIL_SENTINEL = ['sentinel', 'example.test'].join('@');

type Call = [op: string, ...args: unknown[]];

/** The fake's client behind a proxy that records every builder call (and still runs it). */
function recording(db: R1MeetFakeDb): { store: R1MeetCalendarStore; calls: Call[] } {
  const calls: Call[] = [];
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const inner = db.client as any;
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const wrap = (builder: any): any =>
    new Proxy(builder, {
      get(target, prop, receiver) {
        const value = Reflect.get(target, prop, receiver) as unknown;
        if (typeof prop !== 'string' || typeof value !== 'function') return value;
        if (prop === 'then') return value.bind(target);
        return (...args: unknown[]) => {
          calls.push([prop, ...structuredClone(args)]);
          const out = (value as (...a: unknown[]) => unknown).apply(target, args);
          return out === target ? wrap(target) : out;
        };
      },
    });
  const client = {
    from(table: string) {
      calls.push(['from', table]);
      return wrap(inner.from(table));
    },
    rpc(name: string, args: Record<string, unknown>) {
      calls.push(['rpc', name, structuredClone(args)]);
      return inner.rpc(name, args);
    },
  };
  return { store: createR1MeetCalendarStore(client as unknown as typeof supabase), calls };
}

interface World {
  readonly h: R1MeetHarness;
  readonly store: R1MeetCalendarStore;
  readonly calls: Call[];
}

function world(): World {
  const h = createR1MeetHarness();
  return { h, ...recording(h.db) };
}

/** A booking of `source` at `status`, its slot starting `startMs` from now (45 min), on its own round. */
function seed(h: R1MeetHarness, source: 'public_page' | 'ashby', status: string, startMs: number, over: Record<string, unknown> = {}): Row {
  const round = h.db.addRound();
  const row = {
    round_id: round.id,
    status,
    reason: FAKE_STATUS_REASONS[status]![0]!,
    recall_bot_id: BOT_STATUSES.includes(status) ? fixtureId() : null,
    start_at: at(startMs),
    end_at: at(startMs + 45 * MIN),
    ...over,
  };
  return source === 'public_page' ? h.db.seedPublicBooking(row) : h.db.seedBooking(row);
}

const ids = (list: readonly R1MeetCalendarBooking[]): string[] => list.map((b) => b.id);

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
  expect((error as Error).message, label).not.toContain(EMAIL_SENTINEL);
}

// ── A hand-rolled client for answers the fake never gives ────────────────────

type Answer = { data: unknown; error: unknown };
const CHAIN = ['select', 'eq', 'neq', 'in', 'not', 'lt', 'lte', 'gt', 'gte', 'order', 'limit'] as const;

/** Records every builder call and answers `answer` (an Error rejects; 'throw' throws at the first call). */
function scripted(answer: Answer | Error | 'throw') {
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
      if (answer === 'throw') throw new Error(`driver detail ${EMAIL_SENTINEL}`);
      calls.push(['from', table]);
      return builder;
    },
    rpc: (name: string, args: unknown) => {
      if (answer === 'throw') throw new Error(`driver detail ${EMAIL_SENTINEL}`);
      calls.push(['rpc', name, args]);
      return settle();
    },
  };
  return { store: createR1MeetCalendarStore(db as unknown as typeof supabase), calls };
}

const data = (value: unknown): Answer => ({ data: value, error: null });

const ID = '7f000000-0000-4000-8000-0000000000d1';
const ROUND = '7f000000-0000-4000-8000-0000000000d2';
const CANDIDATE = '7f000000-0000-4000-8000-0000000000c2';
const APPLICATION = '7F000000-0000-4000-8000-0000000000B2';
const MEET = 'https://meet.google.com/abc-defg-hij';

/** A valid public row as PostgREST answers it (`+00:00` instants). */
const row = (over: Record<string, unknown> = {}): Record<string, unknown> => ({
  id: ID,
  source: 'public_page',
  status: 'pending',
  reason: 'eligible',
  round_id: ROUND,
  candidate_id: CANDIDATE,
  ashby_application_id: APPLICATION,
  objective_profile: 'r1_dex_sales',
  meet_url: MEET,
  start_at: '2030-01-02T10:00:00+00:00',
  end_at: '2030-01-02T10:45:00+00:00',
  google_calendar_event_id: ID.replace(/-/g, ''),
  calendar_state: 'created',
  move_count: 0,
  invite_sent_at: null,
  created_at: '2030-01-01T09:00:00+00:00',
  updated_at: '2030-01-01T09:30:00+00:00',
  ...over,
});

/** The Ashby twin: every public column null or 0. */
const ashbyRow = (over: Record<string, unknown> = {}): Record<string, unknown> =>
  row({ source: 'ashby', google_calendar_event_id: null, calendar_state: null, move_count: 0, invite_sent_at: null, ...over });

// ── The vocabulary ───────────────────────────────────────────────────────────

describe('calendar-store: the vocabulary is 0143', () => {
  it('R1_MEET_PUBLIC_CALENDAR_RPC_ANSWERS is each RPC\'s catalog comment, in order; frozen', () => {
    for (const [name, answers] of Object.entries(R1_MEET_PUBLIC_CALENDAR_RPC_ANSWERS)) {
      expect([...answers], name).toEqual(catalogAnswers(name));
      expect(Object.isFrozen(answers), name).toBe(true);
    }
    expect(Object.keys(R1_MEET_PUBLIC_CALENDAR_RPC_ANSWERS)).toEqual([
      'r1_meet_public_set_manage_digest',
      'r1_meet_public_set_calendar_state',
      'r1_meet_public_throttle_prune',
    ]);
    expect(Object.isFrozen(R1_MEET_PUBLIC_CALENDAR_RPC_ANSWERS)).toBe(true);
  });

  it('the calendar states are chk_r1_meet_bookings_calendar_state', () => {
    const list = /constraint chk_r1_meet_bookings_calendar_state check \(calendar_state is null or calendar_state in \(([^)]*)\)\)/.exec(sql0143);
    expect([...list![1]!.matchAll(/'([a-z_]+)'/g)].map((m) => m[1])).toEqual([...R1_MEET_CALENDAR_STATES]);
    expect(Object.isFrozen(R1_MEET_CALENDAR_STATES)).toBe(true);
  });

  it('the columns: real ones, never a digest, a request id, a ticket, the bot or the session', () => {
    const columns = R1_MEET_CALENDAR_BOOKING_COLUMNS.split(',').map((c) => c.trim());
    expect(columns).toEqual([
      'id', 'source', 'status', 'reason', 'round_id', 'candidate_id', 'ashby_application_id', 'objective_profile', 'meet_url',
      'start_at', 'end_at', 'google_calendar_event_id', 'calendar_state', 'move_count', 'invite_sent_at', 'created_at', 'updated_at',
    ]);
    const known = new Set([...R1_MEET_BOOKING_COLUMNS.split(',').map((c) => c.trim()), 'candidate_id']);
    for (const column of columns.filter((c) => !known.has(c))) {
      expect(sql0143, column).toContain(`add column if not exists ${column} `);
    }
    for (const banned of ['manage_token_digest', 'public_request_id', 'ticket_', 'recall_bot_id', 'session_id']) {
      expect(R1_MEET_CALENDAR_BOOKING_COLUMNS, banned).not.toContain(banned);
    }
  });
});

// ── Reads over the fake ──────────────────────────────────────────────────────

describe('calendar-store: getBooking, linkCandidateId and candidateEmail', () => {
  it('getBooking: exactly its columns by id; a public row parses with its calendar fields, an Ashby row with nulls, a missing row is null', async () => {
    const w = world();
    const pub = seed(w.h, 'public_page', 'pending', DAY, { created_at: at(-MIN) });
    const booking = await w.store.getBooking(pub.id);
    expect(w.calls).toEqual([['from', 'r1_meet_bookings'], ['select', R1_MEET_CALENDAR_BOOKING_COLUMNS], ['eq', 'id', pub.id], ['maybeSingle']]);
    expect(booking).toEqual({
      id: pub.id,
      source: 'public_page',
      status: 'pending',
      reason: 'eligible',
      roundId: pub.round_id,
      candidateId: pub.candidate_id,
      applicationId: pub.ashby_application_id,
      objectiveProfile: 'r1_dex_sales',
      meetUrl: pub.meet_url,
      startAt: at(DAY),
      endAt: at(DAY + 45 * MIN),
      eventId: pub.id.replace(/-/g, ''),
      calendarState: 'created',
      moveCount: 0,
      inviteSentAt: null,
      createdAt: at(-MIN),
      updatedAt: NOW,
    });
    expect(Object.isFrozen(booking)).toBe(true);

    const ashby = seed(w.h, 'ashby', 'pending', DAY);
    expect(await w.store.getBooking(ashby.id)).toMatchObject({ source: 'ashby', eventId: null, calendarState: null, moveCount: 0, inviteSentAt: null });
    expect(await w.store.getBooking(fixtureId())).toBeNull();

    const invited = seed(w.h, 'public_page', 'failed', -DAY, { calendar_state: 'invited', invite_sent_at: at(-2 * DAY), move_count: 3 });
    expect(await w.store.getBooking(invited.id)).toMatchObject({ calendarState: 'invited', inviteSentAt: at(-2 * DAY), moveCount: 3, status: 'failed', reason: 'in_past' });
  });

  it('linkCandidateId: the Ashby link of the application, its external_candidate_id when well-formed, else null', async () => {
    const w = world();
    const pb = w.h.createPublicBooking();
    // No external_candidate_id on the link yet (linkApplication never sets it).
    expect(await w.store.linkCandidateId(pb.applicationId)).toBeNull();
    expect(w.calls).toEqual([
      ['from', 'ashby_application_links'],
      ['select', 'external_candidate_id'],
      ['eq', 'provider', 'ashby'],
      ['eq', 'external_application_id', pb.applicationId],
      ['maybeSingle'],
    ]);
    const ashbyCandidate = fixtureId();
    w.h.db.linkAshbyCandidate(pb.applicationId, ashbyCandidate);
    expect(await w.store.linkCandidateId(pb.applicationId)).toBe(ashbyCandidate);
    for (const [label, value, expected] of [
      ['256 characters', 'a'.repeat(256), 'a'.repeat(256)],
      ['257 characters', 'a'.repeat(257), null],
      ['a space', 'ab cd', null],
      ['a quote', "ab'cd", null],
      ['empty', '', null],
      ['null', null, null],
    ] as const) {
      w.h.db.linkAshbyCandidate(pb.applicationId, value);
      expect(await w.store.linkCandidateId(pb.applicationId), label).toBe(expected);
    }
    // Another provider's link of the same application id is not Ashby's; no link at all is null.
    const other = fixtureId();
    w.h.db.tables.ashby_application_links.push({ provider: 'other', external_application_id: other, candidate_id: null, terminal_state: null, external_candidate_id: fixtureId() });
    expect(await w.store.linkCandidateId(other)).toBeNull();
    expect(await w.store.linkCandidateId(fixtureId())).toBeNull();
  });

  it('candidateEmail: candidates.email as stored, null for a missing row or a null email', async () => {
    const w = world();
    const candidate = w.h.db.seedCandidate({ email: EMAIL_SENTINEL });
    expect(await w.store.candidateEmail(candidate.id)).toBe(EMAIL_SENTINEL);
    expect(w.calls).toEqual([['from', 'candidates'], ['select', 'email'], ['eq', 'id', candidate.id], ['maybeSingle']]);
    // As stored: normalising is resolveR1PublicOnFileEmail's job.
    const padded = w.h.db.seedCandidate({ email: `  ${EMAIL_SENTINEL.toUpperCase()} ` });
    expect(await w.store.candidateEmail(padded.id)).toBe(`  ${EMAIL_SENTINEL.toUpperCase()} `);
    expect(await w.store.candidateEmail(w.h.db.seedCandidate({ email: null }).id)).toBeNull();
    expect(await w.store.candidateEmail(fixtureId())).toBeNull();
  });
});

describe('calendar-store: the five lists, public rows only, every predicate edge', () => {
  it('listInviteOwed: created, pending/blocked/bot_scheduled, created before the grace, slot after the deadline; by slot start', async () => {
    const w = world();
    const { h } = w;
    const q = { createdBefore: at(-2 * MIN), startAfter: at(15 * MIN), limit: 20 };
    const old = { created_at: at(-3 * MIN) };
    const pending = seed(h, 'public_page', 'pending', 60 * MIN, old);
    const blocked = seed(h, 'public_page', 'blocked', 61 * MIN, old);
    const scheduled = seed(h, 'public_page', 'bot_scheduled', 62 * MIN, old);
    const edges = seed(h, 'public_page', 'pending', 15 * MIN + 1, { created_at: at(-2 * MIN - 1) });
    seed(h, 'ashby', 'pending', 60 * MIN, old);
    for (const state of ['invited', 'cancelled', 'purged']) seed(h, 'public_page', 'pending', 60 * MIN, { ...old, calendar_state: state });
    for (const status of ['bot_joining', 'human_present', 'in_call', 'completed', 'cancelled', 'failed', 'drained']) seed(h, 'public_page', status, 60 * MIN, old);
    seed(h, 'public_page', 'pending', 15 * MIN, old); // the slot starts exactly at the deadline
    seed(h, 'public_page', 'pending', 60 * MIN, { created_at: at(-2 * MIN) }); // made exactly at the grace

    w.calls.length = 0;
    expect(ids(await w.store.listInviteOwed(q))).toEqual([edges.id, pending.id, blocked.id, scheduled.id]);
    expect(w.calls).toEqual([
      ['from', 'r1_meet_bookings'],
      ['select', R1_MEET_CALENDAR_BOOKING_COLUMNS],
      ['eq', 'source', 'public_page'],
      ['eq', 'calendar_state', 'created'],
      ['in', 'status', ['pending', 'blocked', 'bot_scheduled']],
      ['lt', 'created_at', q.createdBefore],
      ['gt', 'start_at', q.startAfter],
      ['order', 'start_at', { ascending: true }],
      ['limit', 20],
    ]);
    expect(ids(await w.store.listInviteOwed({ ...q, limit: 2 }))).toEqual([edges.id, pending.id]);
  });

  it('listInviteDeadline: created, pending/blocked/bot_scheduled, slot at or before the deadline; by slot start', async () => {
    const w = world();
    const { h } = w;
    const q = { startBefore: at(15 * MIN), limit: 20 };
    const atEdge = seed(h, 'public_page', 'pending', 15 * MIN);
    const past = seed(h, 'public_page', 'blocked', -60 * MIN);
    const scheduled = seed(h, 'public_page', 'bot_scheduled', 5 * MIN);
    seed(h, 'public_page', 'pending', 15 * MIN + 1);
    seed(h, 'ashby', 'pending', 5 * MIN);
    for (const state of ['invited', 'cancelled', 'purged']) seed(h, 'public_page', 'pending', 5 * MIN, { calendar_state: state });
    for (const status of ['bot_joining', 'human_present', 'in_call', 'completed', 'cancelled', 'failed', 'drained']) seed(h, 'public_page', status, 5 * MIN);

    w.calls.length = 0;
    expect(ids(await w.store.listInviteDeadline(q))).toEqual([past.id, scheduled.id, atEdge.id]);
    expect(w.calls).toEqual([
      ['from', 'r1_meet_bookings'],
      ['select', R1_MEET_CALENDAR_BOOKING_COLUMNS],
      ['eq', 'source', 'public_page'],
      ['eq', 'calendar_state', 'created'],
      ['in', 'status', ['pending', 'blocked', 'bot_scheduled']],
      ['lte', 'start_at', q.startBefore],
      ['order', 'start_at', { ascending: true }],
      ['limit', 20],
    ]);
    expect(ids(await w.store.listInviteDeadline({ ...q, limit: 1 }))).toEqual([past.id]);
  });

  it('listCalendarDrift: cancelled/failed/drained with the event there, future slot, settled; by slot start', async () => {
    const w = world();
    const { h } = w;
    const q = { startAfter: NOW, updatedBefore: at(-10 * MIN), limit: 20 };
    const settled = { updated_at: at(-11 * MIN) };
    const cancelled = seed(h, 'public_page', 'cancelled', 60 * MIN, settled);
    const failed = seed(h, 'public_page', 'failed', 30 * MIN, { ...settled, calendar_state: 'invited' });
    const drained = seed(h, 'public_page', 'drained', 1, { updated_at: at(-10 * MIN - 1) });
    seed(h, 'public_page', 'completed', 60 * MIN, settled);
    for (const status of ['pending', 'blocked', 'bot_scheduled', 'bot_joining', 'in_call']) seed(h, 'public_page', status, 60 * MIN, settled);
    for (const state of ['cancelled', 'purged']) seed(h, 'public_page', 'cancelled', 60 * MIN, { ...settled, calendar_state: state });
    seed(h, 'public_page', 'cancelled', 0, settled); // the slot starts exactly now
    seed(h, 'public_page', 'cancelled', 60 * MIN, { updated_at: at(-10 * MIN) }); // touched exactly at the settle edge
    seed(h, 'ashby', 'cancelled', 60 * MIN, settled);

    w.calls.length = 0;
    expect(ids(await w.store.listCalendarDrift(q))).toEqual([drained.id, failed.id, cancelled.id]);
    expect(w.calls).toEqual([
      ['from', 'r1_meet_bookings'],
      ['select', R1_MEET_CALENDAR_BOOKING_COLUMNS],
      ['eq', 'source', 'public_page'],
      ['in', 'status', ['cancelled', 'failed', 'drained']],
      ['in', 'calendar_state', ['created', 'invited']],
      ['gt', 'start_at', q.startAfter],
      ['lt', 'updated_at', q.updatedBefore],
      ['order', 'start_at', { ascending: true }],
      ['limit', 20],
    ]);
    expect(ids(await w.store.listCalendarDrift({ ...q, limit: 2 }))).toEqual([drained.id, failed.id]);
  });

  it('listRetention: every terminal status with the event there, slot ended before the cutoff; by slot end', async () => {
    const w = world();
    const { h } = w;
    const q = { endBefore: at(-30 * DAY), limit: 20 };
    const endingAt = (endMs: number) => endMs - 45 * MIN;
    const cancelled = seed(h, 'public_page', 'cancelled', endingAt(-40 * DAY), { calendar_state: 'invited' });
    const drained = seed(h, 'public_page', 'drained', endingAt(-35 * DAY));
    const completed = seed(h, 'public_page', 'completed', endingAt(-31 * DAY));
    const failed = seed(h, 'public_page', 'failed', endingAt(-30 * DAY - 1), { calendar_state: 'invited' });
    seed(h, 'public_page', 'failed', endingAt(-30 * DAY)); // ended exactly at the cutoff
    for (const state of ['cancelled', 'purged']) seed(h, 'public_page', 'cancelled', endingAt(-40 * DAY), { calendar_state: state });
    for (const status of ['pending', 'blocked', 'bot_scheduled', 'in_call']) seed(h, 'public_page', status, endingAt(-40 * DAY));
    seed(h, 'ashby', 'completed', endingAt(-40 * DAY));

    w.calls.length = 0;
    expect(ids(await w.store.listRetention(q))).toEqual([cancelled.id, drained.id, completed.id, failed.id]);
    expect(w.calls).toEqual([
      ['from', 'r1_meet_bookings'],
      ['select', R1_MEET_CALENDAR_BOOKING_COLUMNS],
      ['eq', 'source', 'public_page'],
      ['in', 'status', ['completed', 'cancelled', 'failed', 'drained']],
      ['in', 'calendar_state', ['created', 'invited']],
      ['lt', 'end_at', q.endBefore],
      ['order', 'end_at', { ascending: true }],
      ['limit', 20],
    ]);
    expect(ids(await w.store.listRetention({ ...q, limit: 3 }))).toEqual([cancelled.id, drained.id, completed.id]);
  });

  it('listRecheck: pending/blocked/bot_scheduled, slot start in [from, to), any calendar state; by slot start', async () => {
    const w = world();
    const { h } = w;
    const q = { startFrom: at(105 * MIN), startTo: at(120 * MIN), limit: 20 };
    const from = seed(h, 'public_page', 'pending', 105 * MIN);
    const mid = seed(h, 'public_page', 'blocked', 110 * MIN, { calendar_state: 'invited' });
    const last = seed(h, 'public_page', 'bot_scheduled', 120 * MIN - 1, { calendar_state: 'cancelled' });
    seed(h, 'public_page', 'pending', 120 * MIN); // exactly at the end: half-open
    seed(h, 'public_page', 'pending', 105 * MIN - 1);
    for (const status of ['bot_joining', 'human_present', 'in_call', 'completed', 'cancelled', 'failed', 'drained']) seed(h, 'public_page', status, 110 * MIN);
    seed(h, 'ashby', 'pending', 110 * MIN);

    w.calls.length = 0;
    expect(ids(await w.store.listRecheck(q))).toEqual([from.id, mid.id, last.id]);
    expect(w.calls).toEqual([
      ['from', 'r1_meet_bookings'],
      ['select', R1_MEET_CALENDAR_BOOKING_COLUMNS],
      ['eq', 'source', 'public_page'],
      ['in', 'status', ['pending', 'blocked', 'bot_scheduled']],
      ['gte', 'start_at', q.startFrom],
      ['lt', 'start_at', q.startTo],
      ['order', 'start_at', { ascending: true }],
      ['limit', 20],
    ]);
    expect(ids(await w.store.listRecheck({ ...q, limit: 1 }))).toEqual([from.id]);
  });

  it('no read ever selects a digest, a request id, a ticket, the bot or the session', async () => {
    const w = world();
    const pb = w.h.createPublicBooking();
    await w.store.getBooking(pb.bookingId);
    await w.store.linkCandidateId(pb.applicationId);
    await w.store.candidateEmail(pb.candidateId);
    await w.store.listInviteOwed({ createdBefore: NOW, startAfter: NOW, limit: 20 });
    await w.store.listInviteDeadline({ startBefore: NOW, limit: 20 });
    await w.store.listCalendarDrift({ startAfter: NOW, updatedBefore: NOW, limit: 20 });
    await w.store.listRetention({ endBefore: NOW, limit: 20 });
    await w.store.listRecheck({ startFrom: NOW, startTo: NOW, limit: 20 });
    const selects = w.calls.filter(([op]) => op === 'select').map(([, columns]) => String(columns));
    expect(selects).toHaveLength(8);
    for (const columns of selects) {
      for (const banned of ['manage_token_digest', 'public_request_id', 'ticket_', 'recall_bot_id', 'session_id', '*']) {
        expect(columns, banned).not.toContain(banned);
      }
    }
  });
});

// ── The RPCs over the fake ───────────────────────────────────────────────────

describe('calendar-store: the three RPCs over the 0143 port', () => {
  it('setManageDigest sends exactly the 0143 parameters and reads every answer; invalid_request is rpc_unexpected', async () => {
    const w = world();
    const { h } = w;
    expect(parameters('r1_meet_public_set_manage_digest')).toEqual(['p_booking_id', 'p_digest', 'p_now']);
    const pub = seed(h, 'public_page', 'pending', DAY);
    w.calls.length = 0;
    expect(await w.store.setManageDigest({ bookingId: pub.id, digest: A_DIGEST, nowIso: NOW })).toBe('ok');
    expect(w.calls).toEqual([['rpc', 'r1_meet_public_set_manage_digest', { p_booking_id: pub.id, p_digest: A_DIGEST, p_now: NOW }]]);
    expect(h.db.booking(pub.id)!.manage_token_digest).toBe(A_DIGEST);
    expect(await w.store.setManageDigest({ bookingId: fixtureId(), digest: A_DIGEST, nowIso: NOW })).toBe('not_found');
    expect(await w.store.setManageDigest({ bookingId: seed(h, 'ashby', 'pending', DAY).id, digest: A_DIGEST, nowIso: NOW })).toBe('not_public');
    expect(await w.store.setManageDigest({ bookingId: seed(h, 'public_page', 'cancelled', DAY).id, digest: A_DIGEST, nowIso: NOW })).toBe('booking_terminal');
    await expectCode(w.store.setManageDigest({ bookingId: pub.id, digest: 'not-a-digest', nowIso: NOW }), R1_MEET_RPC_UNEXPECTED, 'invalid digest');
    // Another booking's digest is the unique index: a database refusal.
    await expectCode(w.store.setManageDigest({ bookingId: seed(h, 'public_page', 'pending', DAY).id, digest: A_DIGEST, nowIso: NOW }), R1_MEET_DB_ERROR, '23505');
  });

  it('setCalendarState sends exactly the 0143 parameters (p_from a copy) and reads every answer', async () => {
    const w = world();
    const { h } = w;
    expect(parameters('r1_meet_public_set_calendar_state')).toEqual(['p_booking_id', 'p_from', 'p_to', 'p_now']);
    const pub = seed(h, 'public_page', 'pending', DAY);
    const from = Object.freeze(['created'] as const);
    w.calls.length = 0;
    expect(await w.store.setCalendarState({ bookingId: pub.id, from, to: 'invited', nowIso: NOW })).toEqual({ status: 'ok', calendarState: 'invited' });
    expect(w.calls).toEqual([['rpc', 'r1_meet_public_set_calendar_state', { p_booking_id: pub.id, p_from: ['created'], p_to: 'invited', p_now: NOW }]]);
    expect(h.db.booking(pub.id)).toMatchObject({ calendar_state: 'invited', invite_sent_at: NOW });
    const conflict = await w.store.setCalendarState({ bookingId: pub.id, from: ['created'], to: 'invited', nowIso: NOW });
    expect(conflict).toEqual({ status: 'state_conflict', current: 'invited' });
    expect(Object.isFrozen(conflict)).toBe(true);
    expect(await w.store.setCalendarState({ bookingId: pub.id, from: ['created', 'invited'], to: 'cancelled', nowIso: NOW })).toEqual({ status: 'ok', calendarState: 'cancelled' });
    expect(await w.store.setCalendarState({ bookingId: pub.id, from: ['created', 'invited', 'cancelled'], to: 'purged', nowIso: NOW })).toEqual({ status: 'ok', calendarState: 'purged' });
    expect(await w.store.setCalendarState({ bookingId: fixtureId(), from: ['created'], to: 'invited', nowIso: NOW })).toEqual({ status: 'not_found' });
    expect(await w.store.setCalendarState({ bookingId: seed(h, 'ashby', 'pending', DAY).id, from: ['created'], to: 'invited', nowIso: NOW })).toEqual({ status: 'not_public' });
    // A `from` the RPC refuses (purged is never a source of invited) is a bug here: rpc_unexpected.
    await expectCode(w.store.setCalendarState({ bookingId: pub.id, from: ['purged'], to: 'invited', nowIso: NOW }), R1_MEET_RPC_UNEXPECTED, 'invalid from');
  });

  it('throttlePrune sends exactly the 0143 parameters and answers the deleted count', async () => {
    const w = world();
    const { h } = w;
    expect(parameters('r1_meet_public_throttle_prune')).toEqual(['p_older_than_sec', 'p_limit', 'p_now']);
    for (const [fill, offset] of [['1', -5 * DAY], ['2', -4 * DAY], ['3', -3 * DAY], ['4', -DAY]] as const) {
      h.db.seedThrottle({ key_digest: KEY_DIGEST(fill), bucket_start: at(offset), hits: 2 });
    }
    w.calls.length = 0;
    expect(await w.store.throttlePrune({ olderThanSec: 172800, limit: 2, nowIso: NOW })).toBe(2);
    expect(w.calls).toEqual([['rpc', 'r1_meet_public_throttle_prune', { p_older_than_sec: 172800, p_limit: 2, p_now: NOW }]]);
    expect(await w.store.throttlePrune({ olderThanSec: 172800, limit: 5000, nowIso: NOW })).toBe(1);
    expect(await w.store.throttlePrune({ olderThanSec: 172800, limit: 5000, nowIso: NOW })).toBe(0);
    expect(h.db.tables.r1_meet_public_throttle.map((t) => String(t.key_digest)[0])).toEqual(['4']);
    await expectCode(w.store.throttlePrune({ olderThanSec: 60, limit: 5000, nowIso: NOW }), R1_MEET_RPC_UNEXPECTED, 'too young');
  });
});

// ── Malformed rows and answers (a hand-rolled client) ────────────────────────

describe('calendar-store: a row 0143 would refuse is r1_meet_db_error', () => {
  it('a valid row normalises: lower-case ids, the application verbatim, instants as toISOString', async () => {
    const upper = ID.toUpperCase();
    const { store } = scripted(data(row({ id: upper, google_calendar_event_id: ID.replace(/-/g, ''), round_id: ROUND.toUpperCase() })));
    expect(await store.getBooking(ID)).toMatchObject({
      id: ID,
      roundId: ROUND,
      applicationId: APPLICATION,
      startAt: '2030-01-02T10:00:00.000Z',
      createdAt: '2030-01-01T09:00:00.000Z',
    });
    const { store: ashby } = scripted(data(ashbyRow({ round_id: null, candidate_id: null })));
    expect(await ashby.getBooking(ID)).toMatchObject({ source: 'ashby', roundId: null, candidateId: null, eventId: null, calendarState: null });
  });

  const drift: Array<[string, Record<string, unknown>]> = [
    ['an unknown source', row({ source: 'csv' })],
    ['no source', row({ source: undefined })],
    ['an unknown status', row({ status: 'booked' })],
    ['an unknown reason', row({ reason: 'gone' })],
    ['an unknown calendar state', row({ calendar_state: 'sent' })],
    ['a public row without a calendar state', row({ calendar_state: null })],
    ['a public row without an event id', row({ google_calendar_event_id: null })],
    ['an event id that is not the booking id', row({ google_calendar_event_id: 'f'.repeat(32) })],
    ['an upper-case event id', row({ google_calendar_event_id: ID.replace(/-/g, '').toUpperCase() })],
    ['an event id with dashes', row({ google_calendar_event_id: ID })],
    ['an invite time on a created row', row({ invite_sent_at: '2030-01-01T09:10:00+00:00' })],
    ['an Ashby row with an event id', ashbyRow({ google_calendar_event_id: ID.replace(/-/g, '') })],
    ['an Ashby row with a calendar state', ashbyRow({ calendar_state: 'created' })],
    ['an Ashby row with an invite time', ashbyRow({ invite_sent_at: '2030-01-01T09:10:00+00:00' })],
    ['an Ashby row with a move', ashbyRow({ move_count: 1 })],
    ['a zoneless slot start', row({ start_at: '2030-01-02T10:00:00' })],
    ['a zoneless created_at', row({ created_at: '2030-01-01 09:00:00' })],
    ['a zoneless invite time', row({ calendar_state: 'invited', invite_sent_at: '2030-01-01T09:10:00' })],
    ['an unreadable slot end', row({ end_at: 'tomorrow' })],
    ['a Meet link that is not canonical (case)', row({ meet_url: 'https://meet.google.com/ABC-defg-hij' })],
    ['a Meet link that is not canonical (query)', row({ meet_url: `${MEET}?authuser=0` })],
    ['a Meet link without a scheme', row({ meet_url: 'meet.google.com/abc-defg-hij' })],
    ['an empty Meet link', row({ meet_url: '' })],
    ['a move count above 10', row({ move_count: 11 })],
    ['a negative move count', row({ move_count: -1 })],
    ['a fractional move count', row({ move_count: 1.5 })],
    ['a move count as text', row({ move_count: '1' })],
    ['an id that is not a uuid', row({ id: 'booking-1' })],
    ['a round id that is not a uuid', row({ round_id: 'x' })],
    ['a candidate id that is not a uuid', row({ candidate_id: 'x' })],
    ['an application id that is not a uuid', row({ ashby_application_id: 'app-1' })],
    ['an empty objective profile', row({ objective_profile: '' })],
    ['a missing column (absent, not null)', (() => {
      const { invite_sent_at: _drop, ...rest } = row();
      return rest;
    })()],
  ];
  for (const [label, value] of drift) {
    it(label, async () => {
      await expectCode(scripted(data(value)).store.getBooking(ID), R1_MEET_DB_ERROR, label);
    });
  }

  it('the valid twin of every drift case parses (the cases are minimal)', async () => {
    await expect(scripted(data(row({ calendar_state: 'invited', invite_sent_at: '2030-01-01T09:10:00+00:00', move_count: 10 }))).store.getBooking(ID))
      .resolves.toMatchObject({ calendarState: 'invited', inviteSentAt: '2030-01-01T09:10:00.000Z', moveCount: 10 });
  });

  it('not an object, an array for a single read, or a non-array for a list', async () => {
    for (const value of ['row', 1, true, [row()]]) {
      await expectCode(scripted(data(value)).store.getBooking(ID), R1_MEET_DB_ERROR, JSON.stringify(value));
    }
    for (const value of [row(), 'rows', null]) {
      await expectCode(scripted(data(value)).store.listRecheck({ startFrom: NOW, startTo: NOW, limit: 20 }), R1_MEET_DB_ERROR, JSON.stringify(value));
    }
  });

  it('a public-only list that answers an Ashby row is drift', async () => {
    const lists: Array<(s: R1MeetCalendarStore) => Promise<unknown>> = [
      (s) => s.listInviteOwed({ createdBefore: NOW, startAfter: NOW, limit: 20 }),
      (s) => s.listInviteDeadline({ startBefore: NOW, limit: 20 }),
      (s) => s.listCalendarDrift({ startAfter: NOW, updatedBefore: NOW, limit: 20 }),
      (s) => s.listRetention({ endBefore: NOW, limit: 20 }),
      (s) => s.listRecheck({ startFrom: NOW, startTo: NOW, limit: 20 }),
    ];
    for (const list of lists) {
      await expect(list(scripted(data([row()])).store)).resolves.toHaveLength(1);
      await expectCode(list(scripted(data([row(), ashbyRow()])).store), R1_MEET_DB_ERROR, String(list));
    }
  });

  it('linkCandidateId and candidateEmail: a missing row is null; a non-object row or a non-string email is drift', async () => {
    expect(await scripted(data(null)).store.linkCandidateId(APPLICATION)).toBeNull();
    expect(await scripted(data({ external_candidate_id: 42 })).store.linkCandidateId(APPLICATION)).toBeNull();
    await expectCode(scripted(data('x')).store.linkCandidateId(APPLICATION), R1_MEET_DB_ERROR, 'link string');
    expect(await scripted(data(null)).store.candidateEmail(CANDIDATE)).toBeNull();
    expect(await scripted(data({ email: null })).store.candidateEmail(CANDIDATE)).toBeNull();
    await expectCode(scripted(data({ email: [EMAIL_SENTINEL] })).store.candidateEmail(CANDIDATE), R1_MEET_DB_ERROR, 'email array');
    await expectCode(scripted(data([{ email: EMAIL_SENTINEL }])).store.candidateEmail(CANDIDATE), R1_MEET_DB_ERROR, 'email rows');
  });
});

describe('calendar-store: every RPC answer outside its catalog shape is r1_meet_rpc_unexpected', () => {
  const ARGS = { bookingId: ID, digest: A_DIGEST, nowIso: NOW };
  const STATE = { bookingId: ID, from: ['created'] as const, to: 'invited' as const, nowIso: NOW };
  const PRUNE = { olderThanSec: 172800, limit: 5, nowIso: NOW };

  it('setManageDigest reads its four decisions, exactly `{status}`', async () => {
    for (const answer of ['ok', 'not_found', 'not_public', 'booking_terminal'] as const) {
      const { store, calls } = scripted(data({ status: answer }));
      expect(await store.setManageDigest(ARGS), answer).toBe(answer);
      expect(calls).toEqual([['rpc', 'r1_meet_public_set_manage_digest', { p_booking_id: ID, p_digest: A_DIGEST, p_now: NOW }]]);
    }
    const bad: unknown[] = [
      { status: 'invalid_request', field: 'digest' },
      { status: 'replayed' },
      { status: 'ok', booking_id: ID },
      { status: 'not_found', current: null },
      { status: 'OK' },
      {},
      null,
      'ok',
      [{ status: 'ok' }],
    ];
    for (const value of bad) await expectCode(scripted(data(value)).store.setManageDigest(ARGS), R1_MEET_RPC_UNEXPECTED, JSON.stringify(value));
  });

  it('setCalendarState reads ok (its own `to` only), state_conflict (+current, null included), not_found and not_public', async () => {
    expect(await scripted(data({ status: 'ok', calendar_state: 'invited' })).store.setCalendarState(STATE)).toEqual({ status: 'ok', calendarState: 'invited' });
    for (const current of [...R1_MEET_CALENDAR_STATES, null]) {
      expect(await scripted(data({ status: 'state_conflict', current })).store.setCalendarState(STATE), String(current)).toEqual({ status: 'state_conflict', current });
    }
    expect(await scripted(data({ status: 'not_found' })).store.setCalendarState(STATE)).toEqual({ status: 'not_found' });
    expect(await scripted(data({ status: 'not_public' })).store.setCalendarState(STATE)).toEqual({ status: 'not_public' });
    const bad: unknown[] = [
      { status: 'invalid_request', field: 'from' },
      { status: 'ok', calendar_state: 'cancelled' },
      { status: 'ok', calendar_state: 'sent' },
      { status: 'ok' },
      { status: 'ok', calendar_state: 'invited', invite_sent_at: NOW },
      { status: 'state_conflict' },
      { status: 'state_conflict', current: 'sent' },
      { status: 'not_found', current: 'created' },
      { status: 'booking_terminal' },
      null,
    ];
    for (const value of bad) await expectCode(scripted(data(value)).store.setCalendarState(STATE), R1_MEET_RPC_UNEXPECTED, JSON.stringify(value));
  });

  it('throttlePrune reads ok (+deleted, 0..limit)', async () => {
    expect(await scripted(data({ status: 'ok', deleted: 0 })).store.throttlePrune(PRUNE)).toBe(0);
    expect(await scripted(data({ status: 'ok', deleted: 5 })).store.throttlePrune(PRUNE)).toBe(5);
    const bad: unknown[] = [
      { status: 'invalid_request', field: 'limit' },
      { status: 'ok', deleted: 6 },
      { status: 'ok', deleted: -1 },
      { status: 'ok', deleted: 1.5 },
      { status: 'ok', deleted: '1' },
      { status: 'ok' },
      { status: 'ok', deleted: 1, over: [] },
      { status: 'retention_too_short' },
      null,
    ];
    for (const value of bad) await expectCode(scripted(data(value)).store.throttlePrune(PRUNE), R1_MEET_RPC_UNEXPECTED, JSON.stringify(value));
  });
});

describe('calendar-store: every failure is the one bare code, and the email never reaches it', () => {
  const calls: Array<[string, (s: R1MeetCalendarStore) => Promise<unknown>]> = [
    ['getBooking', (s) => s.getBooking(ID)],
    ['linkCandidateId', (s) => s.linkCandidateId(APPLICATION)],
    ['candidateEmail', (s) => s.candidateEmail(CANDIDATE)],
    ['setManageDigest', (s) => s.setManageDigest({ bookingId: ID, digest: A_DIGEST, nowIso: NOW })],
    ['setCalendarState', (s) => s.setCalendarState({ bookingId: ID, from: ['created'], to: 'invited', nowIso: NOW })],
    ['throttlePrune', (s) => s.throttlePrune({ olderThanSec: 172800, limit: 5, nowIso: NOW })],
    ['listInviteOwed', (s) => s.listInviteOwed({ createdBefore: NOW, startAfter: NOW, limit: 20 })],
    ['listInviteDeadline', (s) => s.listInviteDeadline({ startBefore: NOW, limit: 20 })],
    ['listCalendarDrift', (s) => s.listCalendarDrift({ startAfter: NOW, updatedBefore: NOW, limit: 20 })],
    ['listRetention', (s) => s.listRetention({ endBefore: NOW, limit: 20 })],
    ['listRecheck', (s) => s.listRecheck({ startFrom: NOW, startTo: NOW, limit: 20 })],
  ];
  for (const [label, run] of calls) {
    it(`${label}: a database error, a rejected call and a throwing builder`, async () => {
      await expectCode(run(scripted({ data: null, error: { message: `boom ${EMAIL_SENTINEL}` } }).store), R1_MEET_DB_ERROR, 'error');
      await expectCode(run(scripted(new Error(`rejected ${EMAIL_SENTINEL}`)).store), R1_MEET_DB_ERROR, 'rejected');
      await expectCode(run(scripted('throw').store), R1_MEET_DB_ERROR, 'throw');
    });
  }

  it('over the fake: failNext on each table and RPC is r1_meet_db_error, and the next call works', async () => {
    const w = world();
    const pb = w.h.createPublicBooking();
    const candidate = w.h.db.seedCandidate({ id: pb.candidateId, email: EMAIL_SENTINEL });
    const targets: Array<[string, () => Promise<unknown>]> = [
      ['r1_meet_bookings', () => w.store.getBooking(pb.bookingId)],
      ['r1_meet_bookings', () => w.store.listRecheck({ startFrom: NOW, startTo: at(2 * DAY), limit: 20 })],
      ['ashby_application_links', () => w.store.linkCandidateId(pb.applicationId)],
      ['candidates', () => w.store.candidateEmail(candidate.id)],
      ['r1_meet_public_set_manage_digest', () => w.store.setManageDigest({ bookingId: pb.bookingId, digest: A_DIGEST, nowIso: NOW })],
      ['r1_meet_public_set_calendar_state', () => w.store.setCalendarState({ bookingId: pb.bookingId, from: ['created', 'invited'], to: 'invited', nowIso: NOW })],
      ['r1_meet_public_throttle_prune', () => w.store.throttlePrune({ olderThanSec: 172800, limit: 5, nowIso: NOW })],
    ];
    for (const [target, run] of targets) {
      w.h.db.failNext(target);
      await expectCode(run(), R1_MEET_DB_ERROR, target);
      await expect(run(), target).resolves.toBeDefined();
    }
    expect(await w.store.candidateEmail(candidate.id)).toBe(EMAIL_SENTINEL);
  });

  it('the store module: no process.env, no log, no fence-(g) name; RPC names only from the closed type', () => {
    const source = readFileSync(path.resolve(here, '../lib/r1/meet/public/calendar-store.ts'), 'utf8');
    expect(source).not.toMatch(/process\.env/);
    expect(source).not.toMatch(/console\.|logger|\.warn\(|\.error\(/);
    expect(source).not.toMatch(/createR1MeetGoogle|setR1MeetGoogleTestSeams|resetR1MeetGoogleCache/);
    const names: R1MeetPublicCalendarRpcName[] = ['r1_meet_public_set_manage_digest', 'r1_meet_public_set_calendar_state', 'r1_meet_public_throttle_prune'];
    for (const name of names) expect(source).toContain(`'${name}'`);
    const fake = (answer: FakeAnswer): FakeAnswer => answer;
    expect(fake({ data: null, error: null }).data).toBeNull();
  });
});
