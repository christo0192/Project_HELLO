/**
 * M034 S05 T1: the booking store of the Meet bridge exchange (lib/r1/meet/bridge-store.ts).
 *
 * Pinned here, with a recording query double:
 *  - the read-only peek selects exactly the eight columns its decisions need (never the digest,
 *    the Meet URL, an Ashby or Recall column) and filters by `ticket_digest` only;
 *  - `r1_meet_claim_ticket` and `r1_meet_bind_session` are called with exactly
 *    `{ p_ticket_digest, p_now }` and `{ p_booking_id, p_session_id, p_now }`;
 *  - every closed refusal maps, an ok answer is parsed (ids lower-cased), and anything else (a DB
 *    error, a rejected call, an unknown status, a malformed row or binding) is `error`, never a
 *    false "unknown" or "ok";
 *  - the refusal lists, the claimable statuses, the parameter names, the answer keys and the
 *    peeked columns are the ones migration 0142 really has (read from the SQL), so a drift fails
 *    here instead of as PGRST202 or a 503 in production.
 */

import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import type { supabase } from '../lib/supabase.js';
import {
  R1_MEET_BIND_REFUSALS,
  R1_MEET_CLAIMABLE_STATUSES,
  R1_MEET_CLAIM_REFUSALS,
  R1_MEET_TICKET_PEEK_COLUMNS,
  bindR1MeetSession,
  claimR1MeetTicket,
  peekR1MeetTicket,
} from '../lib/r1/meet/bridge-store.js';

type Answer = { data: unknown; error: unknown };
interface Call {
  op: 'from' | 'select' | 'eq' | 'maybeSingle' | 'rpc';
  args: unknown[];
}

/** A query double that records every builder call and answers from `answers` (an Error rejects). */
function fakeDb(answers: { read?: Answer | Error; rpc?: Answer | Error } = {}) {
  const calls: Call[] = [];
  const settle = async (answer: Answer | Error | undefined): Promise<Answer> => {
    if (answer instanceof Error) throw answer;
    return answer ?? { data: null, error: null };
  };
  const builder = {
    select: (...args: unknown[]) => {
      calls.push({ op: 'select', args });
      return builder;
    },
    eq: (...args: unknown[]) => {
      calls.push({ op: 'eq', args });
      return builder;
    },
    maybeSingle: () => {
      calls.push({ op: 'maybeSingle', args: [] });
      return settle(answers.read);
    },
  };
  const db = {
    from: (...args: unknown[]) => {
      calls.push({ op: 'from', args });
      return builder;
    },
    rpc: (...args: unknown[]) => {
      calls.push({ op: 'rpc', args });
      return settle(answers.rpc);
    },
  };
  return { db: db as unknown as typeof supabase, calls };
}

const DIGEST = 'ab'.repeat(32);
const NOW_ISO = '2030-01-01T10:00:00.000Z';
const BOOKING = '40000000-0000-4000-8000-0000000000b1';
const ROUND = '20000000-0000-4000-8000-0000000000a1';
const CANDIDATE = '10000000-0000-4000-8000-0000000000c1';
const SESSION = '30000000-0000-4000-8000-0000000000e1';
const EXACT_PEEK_COLUMNS =
  'id, status, round_id, session_id, objective_profile, ticket_not_before, ticket_expires_at, ticket_claimed_at';

function peekRow(over: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    id: BOOKING,
    status: 'human_present',
    round_id: ROUND,
    session_id: null,
    objective_profile: 'r1_dex_sales',
    ticket_not_before: '2030-01-01T09:55:00+00:00',
    ticket_expires_at: '2030-01-01T10:55:00+00:00',
    ticket_claimed_at: null,
    ...over,
  };
}

function claimOk(over: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    status: 'ok',
    booking_id: BOOKING,
    round_id: ROUND,
    candidate_id: CANDIDATE,
    objective_profile: 'r1_dex_sales',
    ashby_interview_event_id: '50000000-0000-4000-8000-0000000000d1',
    session_id: null,
    start_at: '2030-01-01T10:00:00+00:00',
    end_at: '2030-01-01T10:40:00+00:00',
    ...over,
  };
}

/** Migration 0142, comments stripped and whitespace collapsed. */
const here = path.dirname(fileURLToPath(import.meta.url));
const sql = readFileSync(path.resolve(here, '../../../supabase/migrations/0142_r1_meet_bookings.sql'), 'utf8')
  .replace(/\r\n/g, '\n')
  .replace(/^\s*--.*$/gm, '')
  .replace(/\s+/g, ' ');

function functionText(name: string): string {
  const start = sql.indexOf(`create or replace function screening_v2.${name}(`);
  expect(start, name).toBeGreaterThan(-1);
  const end = sql.indexOf('$$;', start);
  expect(end, name).toBeGreaterThan(start);
  return sql.slice(start, end);
}

/** Every `'status', '<value>'` an RPC body can answer, in order of first appearance. */
function answeredStatuses(body: string): string[] {
  return [...new Set([...body.matchAll(/'status', '([a-z_]+)'/g)].map((m) => m[1]!))];
}

describe('peekR1MeetTicket: a read-only look-up by digest', () => {
  it('selects exactly the eight decision columns, filtered by ticket_digest, one row at most', async () => {
    const { db, calls } = fakeDb({ read: { data: peekRow(), error: null } });
    await peekR1MeetTicket(db, DIGEST);
    expect(calls).toEqual([
      { op: 'from', args: ['r1_meet_bookings'] },
      { op: 'select', args: [EXACT_PEEK_COLUMNS] },
      { op: 'eq', args: ['ticket_digest', DIGEST] },
      { op: 'maybeSingle', args: [] },
    ]);
    expect(R1_MEET_TICKET_PEEK_COLUMNS).toBe(EXACT_PEEK_COLUMNS);
    expect(EXACT_PEEK_COLUMNS).not.toMatch(/ticket_digest|meet_url|ashby|recall|attest|start_at|end_at|candidate/);
  });

  it('parses a found booking: ids lower-cased, the window and the claim as epoch ms', async () => {
    const { db } = fakeDb({
      read: { data: peekRow({ id: BOOKING.toUpperCase(), session_id: SESSION.toUpperCase(), ticket_claimed_at: '2030-01-01T10:01:00.123456+00:00' }), error: null },
    });
    expect(await peekR1MeetTicket(db, DIGEST)).toEqual({
      kind: 'found',
      booking: {
        id: BOOKING,
        status: 'human_present',
        roundId: ROUND,
        sessionId: SESSION,
        objectiveProfile: 'r1_dex_sales',
        ticketNotBeforeMs: Date.parse('2030-01-01T09:55:00Z'),
        ticketExpiresAtMs: Date.parse('2030-01-01T10:55:00Z'),
        ticketClaimedAtMs: Date.parse('2030-01-01T10:01:00.123Z'),
      },
    });
    const unclaimed = await peekR1MeetTicket(fakeDb({ read: { data: peekRow(), error: null } }).db, DIGEST);
    expect(unclaimed).toMatchObject({ kind: 'found', booking: { sessionId: null, ticketClaimedAtMs: null } });
  });

  it('answers unknown when no booking holds the digest', async () => {
    expect(await peekR1MeetTicket(fakeDb({ read: { data: null, error: null } }).db, DIGEST)).toEqual({ kind: 'unknown' });
  });

  it('answers unknown for a digest that is not 64 lowercase hex, without a query', async () => {
    for (const bad of ['', 'AB'.repeat(32), 'ab'.repeat(31), 'ab'.repeat(33), 'zz'.repeat(32), undefined, 42]) {
      const { db, calls } = fakeDb({ read: { data: peekRow(), error: null } });
      expect(await peekR1MeetTicket(db, bad as string)).toEqual({ kind: 'unknown' });
      expect(calls).toEqual([]);
    }
  });

  it('answers error for a DB error or a rejected call (never unknown)', async () => {
    expect(await peekR1MeetTicket(fakeDb({ read: { data: null, error: { message: 'down' } } }).db, DIGEST)).toEqual({ kind: 'error' });
    expect(await peekR1MeetTicket(fakeDb({ read: new Error('socket') }).db, DIGEST)).toEqual({ kind: 'error' });
  });

  it('answers error for a row whose fields are not the expected types', async () => {
    const malformed: Array<Record<string, unknown>> = [
      { id: 'booking' },
      { id: null },
      { round_id: null },
      { round_id: 'round' },
      { session_id: 'session' },
      { session_id: undefined },
      { status: '' },
      { status: 7 },
      { objective_profile: '' },
      { objective_profile: null },
      { ticket_not_before: null },
      { ticket_not_before: 'nope' },
      { ticket_expires_at: '2030-01-01T10:55:00' },
      { ticket_claimed_at: 'nope' },
      { ticket_claimed_at: undefined },
    ];
    for (const over of malformed) {
      const { db } = fakeDb({ read: { data: peekRow(over), error: null } });
      expect(await peekR1MeetTicket(db, DIGEST), JSON.stringify(over)).toEqual({ kind: 'error' });
    }
    for (const data of [[peekRow()], 'row', 42]) {
      expect(await peekR1MeetTicket(fakeDb({ read: { data, error: null } }).db, DIGEST)).toEqual({ kind: 'error' });
    }
  });
});

describe('claimR1MeetTicket: r1_meet_claim_ticket', () => {
  it('sends exactly { p_ticket_digest, p_now } to r1_meet_claim_ticket', async () => {
    const { db, calls } = fakeDb({ rpc: { data: claimOk(), error: null } });
    await claimR1MeetTicket(db, DIGEST, NOW_ISO);
    expect(calls).toEqual([{ op: 'rpc', args: ['r1_meet_claim_ticket', { p_ticket_digest: DIGEST, p_now: NOW_ISO }] }]);
    expect(Object.keys(calls[0]!.args[1] as object)).toEqual(['p_ticket_digest', 'p_now']);
  });

  it('parses the ok binding (ids lower-cased, the slot as printed), with or without a bound session', async () => {
    const upper = claimOk({ booking_id: BOOKING.toUpperCase(), candidate_id: CANDIDATE.toUpperCase() });
    expect(await claimR1MeetTicket(fakeDb({ rpc: { data: upper, error: null } }).db, DIGEST, NOW_ISO)).toEqual({
      kind: 'ok',
      binding: {
        bookingId: BOOKING,
        roundId: ROUND,
        candidateId: CANDIDATE,
        objectiveProfile: 'r1_dex_sales',
        sessionId: null,
        startAt: '2030-01-01T10:00:00+00:00',
        endAt: '2030-01-01T10:40:00+00:00',
      },
    });
    const rearmed = await claimR1MeetTicket(fakeDb({ rpc: { data: claimOk({ session_id: SESSION }), error: null } }).db, DIGEST, NOW_ISO);
    expect(rearmed).toMatchObject({ kind: 'ok', binding: { sessionId: SESSION } });
    // The binding never carries the Ashby event id, a digest or a link.
    expect(Object.keys((rearmed as { binding: object }).binding).sort()).toEqual(
      ['bookingId', 'candidateId', 'endAt', 'objectiveProfile', 'roundId', 'sessionId', 'startAt'],
    );
  });

  it('maps every closed refusal of 0142 §17', async () => {
    expect([...R1_MEET_CLAIM_REFUSALS]).toEqual([
      'invalid_ticket',
      'invalid_request',
      'ticket_unknown',
      'ticket_already_claimed',
      'booking_not_claimable',
      'ticket_not_yet_valid',
      'ticket_expired',
      'round_not_live',
    ]);
    for (const reason of R1_MEET_CLAIM_REFUSALS) {
      const data = { status: reason, booking_id: BOOKING, booking_status: 'cancelled', round_id: ROUND, field: 'now' };
      expect(await claimR1MeetTicket(fakeDb({ rpc: { data, error: null } }).db, DIGEST, NOW_ISO)).toEqual({ kind: 'refused', reason });
    }
  });

  it('answers error for a malformed ok binding', async () => {
    const malformed: Array<Record<string, unknown>> = [
      { booking_id: undefined },
      { booking_id: 'booking' },
      { round_id: null },
      { candidate_id: null },
      { objective_profile: '' },
      { objective_profile: 3 },
      { session_id: 'session' },
      { session_id: undefined },
      { start_at: '2030-01-01T10:00:00' },
      { start_at: null },
      { end_at: undefined },
      { end_at: 'later' },
    ];
    for (const over of malformed) {
      const { db } = fakeDb({ rpc: { data: claimOk(over), error: null } });
      expect(await claimR1MeetTicket(db, DIGEST, NOW_ISO), JSON.stringify(over)).toEqual({ kind: 'error' });
    }
  });

  it('answers error for an unknown status, a non-object answer, an RPC error or a rejected call', async () => {
    const answers: Array<Answer | Error> = [
      { data: { status: 'claimed' }, error: null },
      { data: { status: 'OK' }, error: null },
      { data: { status: 1 }, error: null },
      { data: {}, error: null },
      { data: null, error: null },
      { data: [claimOk()], error: null },
      { data: 'ok', error: null },
      { data: claimOk(), error: { message: 'PGRST202' } },
      new Error('socket'),
    ];
    for (const rpc of answers) {
      expect(await claimR1MeetTicket(fakeDb({ rpc }).db, DIGEST, NOW_ISO)).toEqual({ kind: 'error' });
    }
  });

  it('refuses a malformed digest (invalid_ticket) or clock (invalid_request) without a round trip', async () => {
    for (const bad of ['', 'AB'.repeat(32), 'ab'.repeat(31), undefined]) {
      const { db, calls } = fakeDb({ rpc: { data: claimOk(), error: null } });
      expect(await claimR1MeetTicket(db, bad as string, NOW_ISO)).toEqual({ kind: 'refused', reason: 'invalid_ticket' });
      expect(calls).toEqual([]);
    }
    for (const bad of ['', 'now', '2030-01-01T10:00:00', undefined]) {
      const { db, calls } = fakeDb({ rpc: { data: claimOk(), error: null } });
      expect(await claimR1MeetTicket(db, DIGEST, bad as string)).toEqual({ kind: 'refused', reason: 'invalid_request' });
      expect(calls).toEqual([]);
    }
  });
});

describe('bindR1MeetSession: r1_meet_bind_session', () => {
  it('sends exactly { p_booking_id, p_session_id, p_now } to r1_meet_bind_session', async () => {
    const { db, calls } = fakeDb({ rpc: { data: { status: 'ok', booking_id: BOOKING, session_id: SESSION, previous_session_id: null }, error: null } });
    await bindR1MeetSession(db, BOOKING, SESSION, NOW_ISO);
    expect(calls).toEqual([
      { op: 'rpc', args: ['r1_meet_bind_session', { p_booking_id: BOOKING, p_session_id: SESSION, p_now: NOW_ISO }] },
    ]);
    expect(Object.keys(calls[0]!.args[1] as object)).toEqual(['p_booking_id', 'p_session_id', 'p_now']);
  });

  it('maps ok (with the previous session), duplicate and every closed refusal of 0142 §15', async () => {
    const bind = (data: unknown) => bindR1MeetSession(fakeDb({ rpc: { data, error: null } }).db, BOOKING, SESSION, NOW_ISO);
    expect(await bind({ status: 'ok', booking_id: BOOKING, session_id: SESSION, previous_session_id: null })).toEqual({
      kind: 'ok',
      previousSessionId: null,
    });
    const previous = '30000000-0000-4000-8000-0000000000e0';
    expect(await bind({ status: 'ok', booking_id: BOOKING, session_id: SESSION, previous_session_id: previous.toUpperCase() })).toEqual({
      kind: 'ok',
      previousSessionId: previous,
    });
    expect(await bind({ status: 'duplicate', booking_id: BOOKING, session_id: SESSION })).toEqual({ kind: 'duplicate' });
    expect([...R1_MEET_BIND_REFUSALS]).toEqual(['not_found', 'invalid_request', 'not_in_call', 'session_mismatch']);
    for (const reason of R1_MEET_BIND_REFUSALS) {
      expect(await bind({ status: reason, booking_id: BOOKING, booking_status: 'failed', field: 'now' })).toEqual({ kind: 'refused', reason });
    }
  });

  it('answers error for a malformed ok, an unknown status, an RPC error or a rejected call', async () => {
    const answers: Array<Answer | Error> = [
      { data: { status: 'ok', previous_session_id: 'session' }, error: null },
      { data: { status: 'ok' }, error: null },
      { data: { status: 'bound' }, error: null },
      { data: null, error: null },
      { data: [{ status: 'ok', previous_session_id: null }], error: null },
      { data: { status: 'ok', previous_session_id: null }, error: { message: 'down' } },
      new Error('socket'),
    ];
    for (const rpc of answers) {
      expect(await bindR1MeetSession(fakeDb({ rpc }).db, BOOKING, SESSION, NOW_ISO)).toEqual({ kind: 'error' });
    }
  });

  it('sends lower-cased ids, and refuses ids that are not UUIDs or a malformed clock without a round trip', async () => {
    const { db, calls } = fakeDb({ rpc: { data: { status: 'duplicate' }, error: null } });
    await bindR1MeetSession(db, BOOKING.toUpperCase(), SESSION.toUpperCase(), NOW_ISO);
    expect(calls[0]!.args[1]).toEqual({ p_booking_id: BOOKING, p_session_id: SESSION, p_now: NOW_ISO });
    for (const [booking, session, now] of [
      ['booking', SESSION, NOW_ISO],
      [BOOKING, '', NOW_ISO],
      [BOOKING, SESSION, 'now'],
      [BOOKING, SESSION, '2030-01-01T10:00:00'],
    ]) {
      const fake = fakeDb({ rpc: { data: { status: 'ok', previous_session_id: null }, error: null } });
      expect(await bindR1MeetSession(fake.db, booking!, session!, now!)).toEqual({ kind: 'refused', reason: 'invalid_request' });
      expect(fake.calls).toEqual([]);
    }
  });
});

describe('the store matches migration 0142', () => {
  it('r1_meet_claim_ticket: signature, claimable statuses, refusals and the ok binding keys', () => {
    const body = functionText('r1_meet_claim_ticket');
    expect(body).toContain('r1_meet_claim_ticket( p_ticket_digest text, p_now timestamptz default now() )');
    const claimable = [...R1_MEET_CLAIMABLE_STATUSES].map((s) => `'${s}'`).join(', ');
    expect(body).toContain(`v_booking.status not in (${claimable})`);
    expect(answeredStatuses(body)).toEqual([...R1_MEET_CLAIM_REFUSALS, 'ok']);
    for (const key of ['booking_id', 'round_id', 'candidate_id', 'objective_profile', 'session_id', 'start_at', 'end_at']) {
      expect(body, key).toContain(`'${key}', v_booking.${key === 'booking_id' ? 'id' : key}`);
    }
  });

  it('r1_meet_bind_session: signature, refusals, duplicate and the previous session key', () => {
    const body = functionText('r1_meet_bind_session');
    expect(body).toContain('r1_meet_bind_session( p_booking_id uuid, p_session_id uuid, p_now timestamptz default now() )');
    const statuses = answeredStatuses(body);
    expect(statuses.filter((s) => s !== 'ok' && s !== 'duplicate').sort()).toEqual([...R1_MEET_BIND_REFUSALS].sort());
    expect(statuses).toContain('duplicate');
    expect(statuses).toContain('ok');
    expect(body).toContain("'previous_session_id', v_booking.session_id");
  });

  it('every peeked column exists on r1_meet_bookings, and the arm RPC accepts the same claimable statuses', () => {
    const table = sql.slice(
      sql.indexOf('create table if not exists screening_v2.r1_meet_bookings ('),
      sql.indexOf('create unique index if not exists uq_r1_meet_bookings_live_round'),
    );
    expect(table.length).toBeGreaterThan(100);
    for (const column of EXACT_PEEK_COLUMNS.split(', ')) {
      expect(table, column).toMatch(new RegExp(`[(,] ${column} (?:uuid|text|timestamptz)`));
    }
    const claimable = [...R1_MEET_CLAIMABLE_STATUSES].map((s) => `'${s}'`).join(', ');
    expect(functionText('r1_meet_arm_ticket')).toContain(`v_booking.status not in (${claimable})`);
  });
});
