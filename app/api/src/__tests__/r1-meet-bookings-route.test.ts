/**
 * M034 S05: GET /api/interview-rounds/meet-bookings and GET /api/interview-rounds/meet-bookings/{id},
 * the HR read of R1-over-Meet bookings (dark).
 *
 * What this pins:
 *  - who may read: viewer and above; an inactive account is refused (403 access_denied, recorded)
 *    before any read; an interviewer sees only bookings whose candidate they own, through the
 *    `candidates!inner(owner_id)` join and an owner filter, and another owner's booking is a 404;
 *  - dark: while Meet is off the list is 200 `{ meet_enabled: false, bookings: [], next_cursor: null }`
 *    and the detail 404, with zero database calls (also through the default router and the real
 *    environment switch);
 *  - the query: exactly status/from/to/limit/cursor, each producing exactly the expected builder call,
 *    and every malformed value a 400 `invalid_query`; the keyset cursor round-trips, appears only when
 *    a further row came back, and is refused unless it is exactly one this route wrote;
 *  - PII: the double answers FULL rows (Meet URL, ticket fields, Ashby ids, Recall bot, session,
 *    profile, an embedded candidate) and every answer still carries exactly the eleven fields and none
 *    of those values;
 *  - (M035 S02) `source`, the eleventh field: `ashby` or `public_page` as stored, anything else a 503;
 *    a public-page row (no Ashby schedule ids) reads like any other;
 *  - a read failure or a drifted row is a 503, never a partial page;
 *  - the closed status list equals migration 0142's CHECK list, the reason and source lists equal
 *    0143's (its reasons are 0142's in order, then two), all equal the spec's enums, and every body
 *    validates against the spec's inline schema.
 */

import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import express, { type NextFunction, type Request, type Response } from 'express';
import request from 'supertest';

const mocks = vi.hoisted(() => ({ from: vi.fn(), rpc: vi.fn() }));
vi.mock('../lib/supabase.js', () => ({ supabase: { from: mocks.from, rpc: mocks.rpc } }));

import { getAuditSink, setAuditSink, type AuditSink } from '../lib/audit.js';
import {
  R1_MEET_BOOKING_FIELDS,
  R1_MEET_BOOKING_REASONS,
  R1_MEET_BOOKING_SOURCES,
  R1_MEET_BOOKING_STATUSES,
  R1_MEET_BOOKINGS_OWNER_SELECT,
  R1_MEET_BOOKINGS_SELECT,
  decodeR1MeetBookingsCursor,
  encodeR1MeetBookingsCursor,
  parseR1MeetBookingsQuery,
} from '../lib/r1/meet/bookings-read.js';
import { resetR1MeetConfigReport } from '../lib/r1/meet/config.js';
import { createR1MeetBookingsRouter, r1MeetBookingsRouter } from '../routes/r1-meet-bookings.js';
import { r1Router } from '../routes/r1.js';
import { r1RecordingStaffRouter } from '../routes/r1-recording.js';
import { r1HrRouter } from '../routes/r1-hr.js';
import { parseYamlDocument, validateSchema, type YMap } from './support/openapi-schema.js';

type Row = Record<string, unknown>;
type Role = 'admin' | 'interviewer' | 'viewer';

const here = path.dirname(fileURLToPath(import.meta.url));
const SPEC = parseYamlDocument(readFileSync(path.resolve(here, '../../openapi/openapi.yaml'), 'utf8'));
const MIGRATION = readFileSync(path.resolve(here, '../../../supabase/migrations/0142_r1_meet_bookings.sql'), 'utf8')
  .replace(/\r\n/g, '\n');
/** M035 S01: the source column and the swapped reason CHECK. */
const MIGRATION_0143 = readFileSync(path.resolve(here, '../../../supabase/migrations/0143_r1_meet_public_bookings.sql'), 'utf8')
  .replace(/\r\n/g, '\n');

const LIST = '/api/interview-rounds/meet-bookings';
const OWNER = '40000000-0000-4000-8000-000000000001';
const OTHER_OWNER = '50000000-0000-4000-8000-000000000001';
const pad = (i: number): string => String(i).padStart(12, '0');
const bookingId = (i: number): string => `60000000-0000-4000-8000-${pad(i)}`;
const candidateId = (i: number): string => `10000000-0000-4000-8000-${pad(i)}`;
const roundId = (i: number): string => `20000000-0000-4000-8000-${pad(i)}`;
/** A booking id with hex letters, so its upper-case spelling differs. */
const LETTERED = 'abcdef01-0000-4000-8000-0000000000ef';
/** Slot i starts i hours after 2026-11-25T04:30Z (10:00 IST). */
const slotStart = (i: number): string => new Date(Date.UTC(2026, 10, 25, 4, 30) + i * 3_600_000).toISOString();

/** Values that must never leave: one per withheld column, all distinct and searchable in a body. */
const WITHHELD = {
  meet_url: 'https://meet.google.com/abc-defg-hij',
  ticket_digest: 'd'.repeat(64),
  ashby_application_id: '70000000-0000-4000-8000-0000000000a1',
  ashby_schedule_id: '70000000-0000-4000-8000-0000000000a2',
  ashby_interview_event_id: '70000000-0000-4000-8000-0000000000a3',
  ashby_scheduled_by_user_id: '70000000-0000-4000-8000-0000000000a4',
  recall_bot_id: '70000000-0000-4000-8000-0000000000a5',
  session_id: '70000000-0000-4000-8000-0000000000a6',
  ticket_not_before: '2031-01-01T00:00:00.000Z',
  ticket_expires_at: '2031-01-02T00:00:00.000Z',
  ticket_claimed_at: '2031-01-03T00:00:00.000Z',
  objective_profile: 'r1_dex_sales',
} as const;

/** A full booking row, as a careless select would return it: every column, plus withheld values. */
function bookingRow(i: number, over: Row = {}): Row {
  return {
    id: bookingId(i),
    ashby_interview_event_id: WITHHELD.ashby_interview_event_id,
    ashby_schedule_id: WITHHELD.ashby_schedule_id,
    ashby_application_id: WITHHELD.ashby_application_id,
    ashby_interview_stage_id: null,
    ashby_interview_id: null,
    ashby_scheduled_by_user_id: WITHHELD.ashby_scheduled_by_user_id,
    ashby_updated_at: '2026-11-24T09:00:00+00:00',
    candidate_id: candidateId(i),
    round_id: roundId(i),
    objective_profile: WITHHELD.objective_profile,
    status: 'bot_scheduled',
    reason: 'eligible',
    version: 2,
    key_attempt: 0,
    meet_url: WITHHELD.meet_url,
    start_at: slotStart(i),
    end_at: new Date(Date.parse(slotStart(i)) + 30 * 60_000).toISOString(),
    recall_bot_id: WITHHELD.recall_bot_id,
    ticket_digest: WITHHELD.ticket_digest,
    ticket_not_before: WITHHELD.ticket_not_before,
    ticket_expires_at: WITHHELD.ticket_expires_at,
    ticket_claimed_at: WITHHELD.ticket_claimed_at,
    ticket_arms: 1,
    session_id: WITHHELD.session_id,
    // PostgREST prints a timestamptz with its offset and microseconds.
    created_at: '2026-11-24T09:00:00.123456+00:00',
    updated_at: '2026-11-24T09:30:00.654321+00:00',
    source: 'ashby',
    ...over,
  };
}

/**
 * A public-page booking row (M035, 0143): no Ashby schedule, event or scheduler id, but the matched
 * application, plus the 0143 columns the read must never select or answer.
 */
const PUBLIC_WITHHELD = {
  google_calendar_event_id: 'c'.repeat(32),
  manage_token_digest: 'e'.repeat(64),
  public_request_id: '70000000-0000-4000-8000-0000000000a7',
} as const;

function publicOver(over: Row = {}): Row {
  return {
    source: 'public_page',
    ashby_interview_event_id: null,
    ashby_schedule_id: null,
    ashby_scheduled_by_user_id: null,
    ashby_updated_at: null,
    calendar_state: 'invited',
    invite_sent_at: '2026-11-24T09:00:05+00:00',
    move_count: 0,
    ...PUBLIC_WITHHELD,
    ...over,
  };
}

// ── A recording query double that really filters, orders and limits ────────────────

type Op = [string, ...unknown[]];
interface Call {
  table: string;
  ops: Op[];
}

interface Db {
  bookings: Row[];
  /** candidate id -> owner id (null = unowned). */
  owners: Map<string, string | null>;
  calls: Call[];
  failWith: 'error' | 'throw' | null;
}

const db: Db = { bookings: [], owners: new Map(), calls: [], failWith: null };

function resetDb(): void {
  db.bookings = [];
  db.owners = new Map();
  db.calls = [];
  db.failWith = null;
}

function addBooking(i: number, over: Row = {}, owner: string | null = OWNER): Row {
  const row = bookingRow(i, over);
  db.bookings.push(row);
  if (typeof row.candidate_id === 'string') db.owners.set(row.candidate_id, owner);
  return row;
}

const KEYSET = /^start_at\.gt\.([^,]+),and\(start_at\.eq\.([^,]+),id\.gt\.([^)]+)\)$/;

function queryDouble(table: string) {
  const call: Call = { table, ops: [] };
  db.calls.push(call);
  if (db.failWith === 'throw') throw new Error('connection reset');
  const filters: Array<(row: Row) => boolean> = [];
  let embed = false;
  let limit: number | null = null;
  const rows = (): Row[] => {
    const base = db.bookings.map((row) => {
      if (!embed) return { ...row };
      const owner = typeof row.candidate_id === 'string' ? db.owners.get(row.candidate_id) : undefined;
      // An inner join: no candidate row, no booking row.
      return owner === undefined ? null : { ...row, candidates: { owner_id: owner, name: 'Embedded Candidate Name' } };
    }).filter((row): row is Row => row !== null);
    const matched = base.filter((row) => filters.every((f) => f(row)))
      .sort((a, b) => Date.parse(String(a.start_at)) - Date.parse(String(b.start_at)) || String(a.id).localeCompare(String(b.id)));
    return limit === null ? matched : matched.slice(0, limit);
  };
  const answer = () => (db.failWith === 'error'
    ? { data: null, error: { message: 'relation unavailable' } }
    : { data: rows(), error: null });
  const q = {
    select: (columns: string) => {
      call.ops.push(['select', columns]);
      embed = columns.includes('candidates!inner(owner_id)');
      return q;
    },
    eq: (column: string, value: unknown) => {
      call.ops.push(['eq', column, value]);
      if (column === 'candidates.owner_id') filters.push((row) => (row.candidates as Row | undefined)?.owner_id === value);
      else filters.push((row) => row[column] === value);
      return q;
    },
    gte: (column: string, value: string) => {
      call.ops.push(['gte', column, value]);
      filters.push((row) => Date.parse(String(row[column])) >= Date.parse(value));
      return q;
    },
    lt: (column: string, value: string) => {
      call.ops.push(['lt', column, value]);
      filters.push((row) => Date.parse(String(row[column])) < Date.parse(value));
      return q;
    },
    or: (filter: string) => {
      call.ops.push(['or', filter]);
      const m = KEYSET.exec(filter);
      if (!m || m[1] !== m[2]) throw new Error(`unexpected or filter ${filter}`);
      const at = Date.parse(m[1]!);
      const id = m[3]!;
      filters.push((row) => {
        const start = Date.parse(String(row.start_at));
        return start > at || (start === at && String(row.id) > id);
      });
      return q;
    },
    order: (column: string, options: unknown) => {
      call.ops.push(['order', column, options]);
      return q;
    },
    limit: (n: number) => {
      call.ops.push(['limit', n]);
      limit = n;
      return q;
    },
    maybeSingle: async () => {
      call.ops.push(['maybeSingle']);
      const result = answer();
      if (result.error) return result;
      const found = result.data;
      if (found.length > 1) return { data: null, error: { message: 'multiple rows' } };
      return { data: found[0] ?? null, error: null };
    },
    then: (resolve: (value: unknown) => unknown, reject: (reason: unknown) => unknown) =>
      Promise.resolve(answer()).then(resolve, reject),
  };
  return q;
}

const fakeDb = { from: (table: string) => queryDouble(table), rpc: () => { throw new Error('no rpc expected'); } };

// ── The app ──────────────────────────────────────────────────────────────────

interface AppOptions {
  role?: Role | null;
  id?: string;
  active?: boolean;
  meetActive?: () => boolean;
}

let meetOn = true;

function appFor(options: AppOptions = {}) {
  const { role = 'admin', id = OWNER, active = true } = options;
  const app = express();
  if (role !== null) {
    app.use((req: Request, _res: Response, next: NextFunction) => {
      (req as unknown as { authUser: unknown }).authUser = { id, appRole: role, active };
      next();
    });
  }
  app.use('/api', createR1MeetBookingsRouter({ db: fakeDb as never, meetActive: options.meetActive ?? (() => meetOn) }));
  app.use((_err: unknown, _req: Request, res: Response, _next: NextFunction) => {
    res.status(500).json({ error: 'internal' });
  });
  return app;
}

const list = (query = '', options: AppOptions = {}) => request(appFor(options)).get(`${LIST}${query}`);
const detail = (id: string, options: AppOptions = {}) => request(appFor(options)).get(`${LIST}/${id}`);

const ids = (body: { bookings: Row[] }): unknown[] => body.bookings.map((b) => b.id);
const ops = (): Op[] => {
  expect(db.calls).toHaveLength(1);
  expect(db.calls[0]!.table).toBe('r1_meet_bookings');
  return db.calls[0]!.ops;
};

// ── The spec ─────────────────────────────────────────────────────────────────

function operation(route: string): YMap {
  return ((SPEC.paths as YMap)[route] as YMap).get as YMap;
}
function okSchema(route: string): unknown {
  const responses = operation(route).responses as YMap;
  return (((responses['200'] as YMap).content as YMap)['application/json'] as YMap).schema;
}
const LIST_SCHEMA = okSchema(LIST);
const DETAIL_SCHEMA = okSchema(`${LIST}/{id}`);

function expectListBody(body: unknown): void {
  expect(validateSchema(body, LIST_SCHEMA, SPEC)).toEqual([]);
  for (const booking of (body as { bookings: Row[] }).bookings) {
    expect(Object.keys(booking)).toEqual([...R1_MEET_BOOKING_FIELDS]);
  }
}

function expectNoWithheldValue(text: string): void {
  for (const [column, value] of Object.entries(WITHHELD)) {
    // The profile id is also a word the spec uses; only the column name would give it away here.
    if (column === 'objective_profile') {
      expect(text, column).not.toContain('objective_profile');
      continue;
    }
    expect(text, column).not.toContain(value);
  }
  for (const [column, value] of Object.entries(PUBLIC_WITHHELD)) {
    expect(text, column).not.toContain(value);
  }
  // `ashby` is also a value of `source` (M035): only that exact pair may carry the word.
  const scrubbed = text.replace(/"source":"(?:ashby|public_page)"/g, '"source":""');
  const words = ['meet_url', 'ticket', 'ashby', 'recall', 'session', 'owner_id', 'candidates', 'Embedded Candidate Name'];
  // The 0143 column names (the reason `invite_undeliverable` is a value, so `invite_sent` only).
  for (const word of [...words, 'calendar', 'invite_sent', 'manage_token', 'public_request', 'move_count']) {
    expect(scrubbed, word).not.toContain(word);
  }
}

const audits: unknown[] = [];
let originalSink: AuditSink;

beforeEach(() => {
  resetDb();
  meetOn = true;
  audits.length = 0;
  originalSink = getAuditSink();
  setAuditSink(async (event) => {
    audits.push(event);
  });
  mocks.from.mockReset();
  mocks.rpc.mockReset();
  mocks.from.mockImplementation(() => {
    throw new Error('the default client must not be read');
  });
});

afterEach(() => {
  setAuditSink(originalSink);
  vi.unstubAllEnvs();
  vi.restoreAllMocks();
});

// ── Roles ────────────────────────────────────────────────────────────────────

describe('who may read', () => {
  it('refuses a request with no staff user (requireRole), before any read', async () => {
    addBooking(1);
    for (const res of [await list('', { role: null }), await detail(bookingId(1), { role: null })]) {
      expect(res.status).toBe(403);
      expect(res.body).toEqual({ error: { type: 'authorization_error', message: 'Insufficient permissions' } });
    }
    expect(db.calls).toEqual([]);
  });

  it.each(['admin', 'viewer', 'interviewer'] as const)('lets an active %s read', async (role) => {
    addBooking(1);
    const res = await list('', { role });
    expect(res.status).toBe(200);
    expect(ids(res.body)).toEqual([bookingId(1)]);
    expect(res.headers['cache-control']).toBe('no-store');
    expectListBody(res.body);
    const one = await detail(bookingId(1), { role });
    expect(one.status).toBe(200);
    expect(one.body.id).toBe(bookingId(1));
  });

  it.each(['admin', 'viewer', 'interviewer'] as const)('refuses an inactive %s with 403 access_denied, recorded, and no read', async (role) => {
    addBooking(1);
    for (const meet of [true, false]) {
      meetOn = meet;
      const res = await list('', { role, active: false });
      expect(res.status).toBe(403);
      expect(res.body).toEqual({ error: 'access_denied' });
      expect(res.headers['cache-control']).toBe('no-store');
      const one = await detail(bookingId(1), { role, active: false });
      expect(one.status).toBe(403);
      expect(one.body).toEqual({ error: 'access_denied' });
    }
    expect(db.calls).toEqual([]);
    expect(audits).toHaveLength(4);
    for (const event of audits) {
      expect(event).toMatchObject({ event: 'rbac.access_denied', statusCode: 403, metadata: { reason: 'r1_meet_bookings_access_denied' } });
    }
  });

  it('reads everything for admin and viewer, without the candidate join', async () => {
    addBooking(1);
    addBooking(2, {}, OTHER_OWNER);
    // An Ashby application that matched no candidate: no candidate, no round.
    addBooking(3, { candidate_id: null, round_id: null, status: 'unmatched_application', reason: 'application_unknown', recall_bot_id: null });
    for (const role of ['admin', 'viewer'] as const) {
      db.calls = [];
      const res = await list('', { role });
      expect(ids(res.body)).toEqual([bookingId(1), bookingId(2), bookingId(3)]);
      expect(res.body.bookings[2]).toMatchObject({ candidate_id: null, round_id: null, status: 'unmatched_application' });
      expectListBody(res.body);
      expect(ops()[0]).toEqual(['select', R1_MEET_BOOKINGS_SELECT]);
      expect(ops().some(([op]) => op === 'eq')).toBe(false);
      expect(R1_MEET_BOOKINGS_SELECT).not.toContain('candidates');
    }
  });

  it('scopes an interviewer to the candidates they own, through the inner join and an owner filter', async () => {
    addBooking(1);
    addBooking(2, {}, OTHER_OWNER);
    addBooking(3, { candidate_id: null, round_id: null, status: 'unmatched_application', reason: 'application_unknown', recall_bot_id: null });
    addBooking(4, {}, null);
    addBooking(5);
    const res = await list('', { role: 'interviewer' });
    expect(res.status).toBe(200);
    expect(ids(res.body)).toEqual([bookingId(1), bookingId(5)]);
    expectListBody(res.body);
    expect(ops()).toEqual([
      ['select', R1_MEET_BOOKINGS_OWNER_SELECT],
      ['eq', 'candidates.owner_id', OWNER],
      ['order', 'start_at', { ascending: true }],
      ['order', 'id', { ascending: true }],
      ['limit', 51],
    ]);
    expect(R1_MEET_BOOKINGS_OWNER_SELECT).toBe(`${R1_MEET_BOOKINGS_SELECT},candidates!inner(owner_id)`);
  });

  it("answers 404 to an interviewer for another owner's booking, an unowned one and an unmatched one", async () => {
    addBooking(1);
    addBooking(2, {}, OTHER_OWNER);
    addBooking(3, { candidate_id: null, round_id: null, status: 'unmatched_application', reason: 'application_unknown', recall_bot_id: null });
    addBooking(4, {}, null);
    expect((await detail(bookingId(1), { role: 'interviewer' })).status).toBe(200);
    for (const i of [2, 3, 4]) {
      db.calls = [];
      const res = await detail(bookingId(i), { role: 'interviewer' });
      expect(res.status, String(i)).toBe(404);
      expect(res.body).toEqual({ error: 'not_found' });
      expect(ops()).toEqual([
        ['select', R1_MEET_BOOKINGS_OWNER_SELECT],
        ['eq', 'candidates.owner_id', OWNER],
        ['eq', 'id', bookingId(i)],
        ['maybeSingle'],
      ]);
      // The admin sees it.
      expect((await detail(bookingId(i), { role: 'admin' })).status).toBe(200);
    }
  });
});

// ── Dark ─────────────────────────────────────────────────────────────────────

describe('dark: Meet off', () => {
  it('answers the empty list and a 404 detail with zero database calls', async () => {
    meetOn = false;
    addBooking(1);
    for (const role of ['admin', 'viewer', 'interviewer'] as const) {
      const res = await list('?status=in_call&limit=5', { role });
      expect(res.status).toBe(200);
      expect(res.body).toStrictEqual({ meet_enabled: false, bookings: [], next_cursor: null });
      expect(res.headers['cache-control']).toBe('no-store');
      expectListBody(res.body);
      const one = await detail(bookingId(1), { role });
      expect(one.status).toBe(404);
      expect(one.body).toEqual({ error: 'not_found' });
      expect(one.headers['cache-control']).toBe('no-store');
    }
    expect(db.calls).toEqual([]);
  });

  it('still refuses a malformed query or id while dark (no read either way)', async () => {
    meetOn = false;
    expect((await list('?limit=0')).body).toEqual({ error: 'invalid_query' });
    expect((await detail('not-a-uuid')).body).toEqual({ error: 'invalid_id' });
    expect(db.calls).toEqual([]);
  });

  it('the default router reads the real switches: with R1_MEET_ENABLED unset, nothing is read from the default client', async () => {
    resetR1MeetConfigReport();
    vi.stubEnv('R1_ENABLED', 'true');
    vi.stubEnv('R1_MEET_ENABLED', '');
    const app = express();
    app.use((req: Request, _res: Response, next: NextFunction) => {
      (req as unknown as { authUser: unknown }).authUser = { id: OWNER, appRole: 'admin', active: true };
      next();
    });
    app.use('/api', r1MeetBookingsRouter);
    const res = await request(app).get(LIST);
    expect(res.status).toBe(200);
    expect(res.body).toStrictEqual({ meet_enabled: false, bookings: [], next_cursor: null });
    expect((await request(app).get(`${LIST}/${bookingId(1)}`)).status).toBe(404);
    // R1 itself off: Meet is off whatever its own flag says.
    vi.stubEnv('R1_ENABLED', 'false');
    vi.stubEnv('R1_MEET_ENABLED', 'true');
    expect((await request(app).get(LIST)).body).toStrictEqual({ meet_enabled: false, bookings: [], next_cursor: null });
    expect(mocks.from).not.toHaveBeenCalled();
    expect(mocks.rpc).not.toHaveBeenCalled();
  });

  it('is not shadowed by the staff R1 routers mounted before it in app.ts (same order)', async () => {
    const app = express();
    app.use((req: Request, _res: Response, next: NextFunction) => {
      (req as unknown as { authUser: unknown }).authUser = { id: OWNER, appRole: 'viewer', active: true };
      next();
    });
    app.use('/api', r1Router);
    app.use('/api', r1RecordingStaffRouter);
    app.use('/api', r1HrRouter);
    app.use('/api', createR1MeetBookingsRouter({ db: fakeDb as never, meetActive: () => false }));
    const res = await request(app).get(LIST);
    expect(res.status).toBe(200);
    expect(res.body).toStrictEqual({ meet_enabled: false, bookings: [], next_cursor: null });
    const one = await request(app).get(`${LIST}/${bookingId(1)}`);
    expect(one.status).toBe(404);
    expect(one.body).toEqual({ error: 'not_found' });
    expect(one.headers['cache-control']).toBe('no-store');
    expect(mocks.from).not.toHaveBeenCalled();
    expect(db.calls).toEqual([]);
  });

  it('reads the switch per request, not at construction', async () => {
    addBooking(1);
    const app = appFor();
    meetOn = false;
    expect((await request(app).get(LIST)).body.meet_enabled).toBe(false);
    meetOn = true;
    const on = await request(app).get(LIST);
    expect(on.body.meet_enabled).toBe(true);
    expect(ids(on.body)).toEqual([bookingId(1)]);
  });
});

// ── Filters and pages ────────────────────────────────────────────────────────

describe('filters', () => {
  it('reads with no filter in start_at then id order, limit + 1', async () => {
    addBooking(3);
    addBooking(1);
    // Same slot as booking 1, larger id: after it.
    addBooking(9, { start_at: slotStart(1) });
    addBooking(2);
    const res = await list();
    expect(res.status).toBe(200);
    expect(res.body.meet_enabled).toBe(true);
    expect(ids(res.body)).toEqual([bookingId(1), bookingId(9), bookingId(2), bookingId(3)]);
    expect(res.body.next_cursor).toBeNull();
    expect(ops()).toEqual([
      ['select', R1_MEET_BOOKINGS_SELECT],
      ['order', 'start_at', { ascending: true }],
      ['order', 'id', { ascending: true }],
      ['limit', 51],
    ]);
  });

  it('turns status, from, to, limit and cursor into exactly the expected builder calls', async () => {
    const cursor = encodeR1MeetBookingsCursor({ startAt: slotStart(1), id: bookingId(1) });
    const from = encodeURIComponent('2026-11-25T10:00:00+05:30');
    const to = encodeURIComponent('2026-11-26T00:00:00Z');
    const res = await list(`?status=in_call&from=${from}&to=${to}&limit=10&cursor=${cursor}`);
    expect(res.status).toBe(200);
    expect(ops()).toEqual([
      ['select', R1_MEET_BOOKINGS_SELECT],
      ['eq', 'status', 'in_call'],
      ['gte', 'start_at', '2026-11-25T04:30:00.000Z'],
      ['lt', 'start_at', '2026-11-26T00:00:00.000Z'],
      ['or', `start_at.gt.${slotStart(1)},and(start_at.eq.${slotStart(1)},id.gt.${bookingId(1)})`],
      ['order', 'start_at', { ascending: true }],
      ['order', 'id', { ascending: true }],
      ['limit', 11],
    ]);
  });

  it('really filters by status and by the [from, to) window', async () => {
    addBooking(0, { status: 'in_call' });
    addBooking(1, { status: 'bot_scheduled' });
    addBooking(2, { status: 'in_call' });
    addBooking(3, { status: 'cancelled', reason: 'cancelled' });
    expect(ids((await list('?status=in_call')).body)).toEqual([bookingId(0), bookingId(2)]);
    // from inclusive, to exclusive.
    expect(ids((await list(`?from=${slotStart(1)}&to=${slotStart(3)}`)).body)).toEqual([bookingId(1), bookingId(2)]);
  });

  it.each([
    ['an unknown parameter', '?view=all'],
    ['a search', '?q=Name'],
    ['an unknown status', '?status=bogus'],
    ['an empty status', '?status='],
    ['a repeated status', '?status=in_call&status=failed'],
    ['a nested parameter', '?status[x]=in_call'],
    ['a date with no time', '?from=2026-11-25'],
    ['an instant with no zone', '?from=2026-11-25T10:00:00'],
    ['an unparseable to', '?to=tomorrow'],
    ['from equal to to', `?from=${slotStart(1)}&to=${slotStart(1)}`],
    ['from after to', `?from=${slotStart(2)}&to=${slotStart(1)}`],
    ['limit 0', '?limit=0'],
    ['limit 101', '?limit=101'],
    ['limit 1e2', '?limit=1e2'],
    ['limit 01', '?limit=01'],
    ['limit -1', '?limit=-1'],
    ['an empty limit', '?limit='],
    ['an empty cursor', '?cursor='],
    ['a cursor of junk', '?cursor=!!!'],
  ])('refuses %s with 400 invalid_query and no read', async (_name, query) => {
    addBooking(1);
    const res = await list(query);
    expect(res.status).toBe(400);
    expect(res.body).toEqual({ error: 'invalid_query' });
    expect(res.headers['cache-control']).toBe('no-store');
    expect(db.calls).toEqual([]);
  });

  it('takes limit 1 and limit 100', async () => {
    addBooking(1);
    expect((await list('?limit=1')).status).toBe(200);
    expect((await list('?limit=100')).status).toBe(200);
    expect(db.calls.map((call) => call.ops.at(-1))).toEqual([['limit', 2], ['limit', 101]]);
  });
});

describe('the keyset cursor', () => {
  it('pages through every booking once, in order, and says when there is no next page', async () => {
    for (const i of [4, 0, 2, 1, 3]) addBooking(i);
    // Two in the same slot as booking 2, told apart by id.
    addBooking(7, { start_at: slotStart(2) });
    addBooking(8, { start_at: slotStart(2) });
    const expected = [0, 1, 2, 7, 8, 3, 4].map(bookingId);

    const seen: unknown[] = [];
    let cursor: string | null = null;
    const pages: number[] = [];
    do {
      const res: request.Response = await list(`?limit=2${cursor ? `&cursor=${cursor}` : ''}`);
      expect(res.status).toBe(200);
      expectListBody(res.body);
      seen.push(...ids(res.body));
      pages.push(res.body.bookings.length);
      cursor = res.body.next_cursor;
      if (cursor !== null) {
        // The cursor is the last row of the page.
        const last = res.body.bookings.at(-1);
        expect(decodeR1MeetBookingsCursor(cursor)).toEqual({ startAt: last.start_at, id: last.id });
      }
    } while (cursor !== null && pages.length < 10);
    expect(seen).toEqual(expected);
    expect(pages).toEqual([2, 2, 2, 1]);
  });

  it('gives a next_cursor only when limit + 1 rows came back', async () => {
    for (const i of [0, 1, 2, 3]) addBooking(i);
    const first = await list('?limit=2');
    expect(first.body.next_cursor).toEqual(expect.any(String));
    const second = await list(`?limit=2&cursor=${first.body.next_cursor}`);
    // Exactly two rows were left: no third page.
    expect(ids(second.body)).toEqual([bookingId(2), bookingId(3)]);
    expect(second.body.next_cursor).toBeNull();
    const all = await list('?limit=4');
    expect(all.body.bookings).toHaveLength(4);
    expect(all.body.next_cursor).toBeNull();
  });

  const b64 = (value: unknown): string => Buffer.from(JSON.stringify(value), 'utf8').toString('base64url');

  it.each([
    ['a non-canonical instant', b64({ s: '2026-11-25T04:30:00Z', i: bookingId(1) })],
    ['an offset instant', b64({ s: '2026-11-25T10:00:00.000+05:30', i: bookingId(1) })],
    ['an upper-case id', b64({ s: slotStart(1), i: LETTERED.toUpperCase() })],
    ['a filter smuggled into the instant', b64({ s: `${slotStart(1)},id.gt.0`, i: bookingId(1) })],
    ['a filter smuggled into the id', b64({ s: slotStart(1), i: `${bookingId(1)})` })],
    ['keys in the other order', b64({ i: bookingId(1), s: slotStart(1) })],
    ['an extra key', b64({ s: slotStart(1), i: bookingId(1), x: 1 })],
    ['a missing key', b64({ s: slotStart(1) })],
    ['an array', b64([slotStart(1), bookingId(1)])],
    ['a number for the id', b64({ s: slotStart(1), i: 7 })],
    ['base64 padding', `${encodeR1MeetBookingsCursor({ startAt: slotStart(1), id: bookingId(1) })}=`],
    ['a standard-base64 character', `+${encodeR1MeetBookingsCursor({ startAt: slotStart(1), id: bookingId(1) }).slice(1)}`],
    ['not JSON', Buffer.from('{"s":', 'utf8').toString('base64url')],
    ['an over-long cursor', 'A'.repeat(300)],
  ])('refuses a cursor with %s', async (_name, cursor) => {
    expect(decodeR1MeetBookingsCursor(cursor)).toBeNull();
    const res = await list(`?cursor=${encodeURIComponent(cursor)}`);
    expect(res.status).toBe(400);
    expect(res.body).toEqual({ error: 'invalid_query' });
    expect(db.calls).toEqual([]);
  });

  it('accepts exactly the cursor it wrote', () => {
    const written = encodeR1MeetBookingsCursor({ startAt: slotStart(1), id: LETTERED });
    expect(decodeR1MeetBookingsCursor(written)).toEqual({ startAt: slotStart(1), id: LETTERED });
    expect(written).toMatch(/^[A-Za-z0-9_-]+$/);
    // The control for the upper-case case above: only the case differs.
    expect(decodeR1MeetBookingsCursor(b64({ s: slotStart(1), i: LETTERED }))).not.toBeNull();
  });

  it('parses a whole query into canonical values', () => {
    expect(parseR1MeetBookingsQuery({})).toEqual({ status: null, from: null, to: null, limit: 50, cursor: null });
    expect(parseR1MeetBookingsQuery({ from: '2026-11-25T10:00:00.5+05:30', limit: '7' })).toEqual({
      status: null,
      from: '2026-11-25T04:30:00.500Z',
      to: null,
      limit: 7,
      cursor: null,
    });
    expect(parseR1MeetBookingsQuery(null)).toBeNull();
    expect(parseR1MeetBookingsQuery([])).toBeNull();
  });
});

// ── What leaves ──────────────────────────────────────────────────────────────

describe('what leaves', () => {
  it('projects exactly the eleven fields from full rows, whatever the database answers', async () => {
    addBooking(1);
    addBooking(2, { status: 'completed', reason: 'attempt_settled' });
    addBooking(3, publicOver());
    for (const role of ['admin', 'viewer', 'interviewer'] as const) {
      const res = await list('', { role });
      expect(res.status).toBe(200);
      expectListBody(res.body);
      expectNoWithheldValue(res.text);
      const one = await detail(bookingId(1), { role });
      expect(one.status).toBe(200);
      expect(Object.keys(one.body)).toEqual([...R1_MEET_BOOKING_FIELDS]);
      expect(validateSchema(one.body, DETAIL_SCHEMA, SPEC)).toEqual([]);
      expectNoWithheldValue(one.text);
    }
  });

  it('answers canonical instants and the stored values, unchanged otherwise', async () => {
    addBooking(1, { version: 7, status: 'failed', reason: 'no_show' });
    const res = await detail(bookingId(1));
    expect(res.body).toStrictEqual({
      id: bookingId(1),
      candidate_id: candidateId(1),
      round_id: roundId(1),
      status: 'failed',
      reason: 'no_show',
      start_at: slotStart(1),
      end_at: new Date(Date.parse(slotStart(1)) + 30 * 60_000).toISOString(),
      created_at: '2026-11-24T09:00:00.123Z',
      updated_at: '2026-11-24T09:30:00.654Z',
      version: 7,
      source: 'ashby',
    });
  });

  it('answers a public-page booking (M035) with source public_page and nothing of its 0143 columns', async () => {
    addBooking(1);
    addBooking(2, publicOver({ status: 'cancelled', reason: 'candidate_cancelled', recall_bot_id: null }));
    addBooking(3, publicOver({ status: 'failed', reason: 'invite_undeliverable', recall_bot_id: null, calendar_state: 'created', invite_sent_at: null }));
    for (const role of ['admin', 'viewer', 'interviewer'] as const) {
      const res = await list('', { role });
      expect(res.status).toBe(200);
      expectListBody(res.body);
      expectNoWithheldValue(res.text);
      expect(res.body.bookings.map((b: Row) => [b.id, b.source, b.status, b.reason])).toEqual([
        [bookingId(1), 'ashby', 'bot_scheduled', 'eligible'],
        [bookingId(2), 'public_page', 'cancelled', 'candidate_cancelled'],
        [bookingId(3), 'public_page', 'failed', 'invite_undeliverable'],
      ]);
    }
    const one = await detail(bookingId(2));
    expect(one.status).toBe(200);
    expect(one.body).toStrictEqual({
      id: bookingId(2),
      candidate_id: candidateId(2),
      round_id: roundId(2),
      status: 'cancelled',
      reason: 'candidate_cancelled',
      start_at: slotStart(2),
      end_at: new Date(Date.parse(slotStart(2)) + 30 * 60_000).toISOString(),
      created_at: '2026-11-24T09:00:00.123Z',
      updated_at: '2026-11-24T09:30:00.654Z',
      version: 2,
      source: 'public_page',
    });
    expect(Object.keys(one.body)).toEqual([...R1_MEET_BOOKING_FIELDS]);
    expect(validateSchema(one.body, DETAIL_SCHEMA, SPEC)).toEqual([]);
    expectNoWithheldValue(one.text);
  });

  it('canonicalises an upper-case id before reading, and refuses a malformed one with 400 invalid_id', async () => {
    addBooking(1, { id: LETTERED });
    const res = await detail(LETTERED.toUpperCase());
    expect(res.status).toBe(200);
    expect(res.body.id).toBe(LETTERED);
    expect(ops()).toContainEqual(['eq', 'id', LETTERED]);
    for (const bad of ['not-a-uuid', `${bookingId(1)}x`, '1']) {
      db.calls = [];
      const refused = await detail(bad);
      expect(refused.status, bad).toBe(400);
      expect(refused.body).toEqual({ error: 'invalid_id' });
      expect(db.calls).toEqual([]);
    }
  });

  it('answers 404 not_found for a booking that does not exist', async () => {
    addBooking(1);
    const res = await detail(bookingId(2));
    expect(res.status).toBe(404);
    expect(res.body).toEqual({ error: 'not_found' });
  });
});

describe('failures', () => {
  it.each(['error', 'throw'] as const)('a database %s is a 503 service_unavailable, never a page', async (failWith) => {
    addBooking(1);
    db.failWith = failWith;
    const res = await list();
    expect(res.status).toBe(503);
    expect(res.body).toEqual({ error: 'service_unavailable' });
    expect(res.headers['cache-control']).toBe('no-store');
    const one = await detail(bookingId(1));
    expect(one.status).toBe(503);
    expect(one.body).toEqual({ error: 'service_unavailable' });
  });

  it.each([
    ['a status outside the twelve', { status: 'archived' }],
    ['a reason outside the thirty-four', { reason: 'other' }],
    ['a null source', { source: null }],
    ['a missing source', { source: undefined }],
    ['a source outside the two', { source: 'csv' }],
    ['an upper-case source', { source: 'ASHBY' }],
    ['a source that is not a string', { source: 1 }],
    ['a malformed id', { id: 'booking-1' }],
    ['a malformed candidate id', { candidate_id: 'c-1' }],
    ['an unparseable start', { start_at: 'soon' }],
    ['a zoneless end', { end_at: '2026-11-25T10:00:00' }],
    ['a missing updated_at', { updated_at: undefined }],
    ['a fractional version', { version: 1.5 }],
    ['a string version', { version: '2' }],
  ])('a row with %s fails the read with 503 (never dropped silently)', async (_name, over) => {
    addBooking(1);
    addBooking(2, over as Row);
    const res = await list();
    expect(res.status).toBe(503);
    expect(res.body).toEqual({ error: 'service_unavailable' });
    // The detail reads by id, so a row whose id is malformed is simply not that booking.
    if (!('id' in over)) expect((await detail(bookingId(2))).status).toBe(503);
  });
});

// ── The closed lists ─────────────────────────────────────────────────────────

describe('the closed lists', () => {
  /** Whole-line comments removed, whitespace collapsed (the parse of r1-meet-bookings-migration.test.ts). */
  const strip = (text: string): string => text.replace(/^\s*--.*$/gm, '').replace(/\s+/g, ' ').trim();
  const code = strip(MIGRATION);
  const code0143 = strip(MIGRATION_0143);
  const inList = (constraint: string, column: string, text = code): string[] => {
    const m = new RegExp(`constraint ${constraint} check \\( ?${column} in \\(([^)]*)\\) ?\\)`).exec(text);
    expect(m, constraint).not.toBeNull();
    return [...m![1]!.matchAll(/'([^']*)'/g)].map((match) => match[1]!);
  };

  it('the twelve statuses are 0142 CHECK lists; the thirty-four reasons are 0143 CHECK lists (0142 first, in order)', () => {
    expect([...R1_MEET_BOOKING_STATUSES]).toEqual(inList('chk_r1_meet_bookings_status', 'status'));
    const reasons0142 = inList('chk_r1_meet_bookings_reason', 'reason');
    const reasons0143 = inList('chk_r1_meet_bookings_reason', 'reason', code0143);
    expect(reasons0142).toHaveLength(32);
    expect(reasons0143).toHaveLength(34);
    // 0143 (M035 S01) swaps the CHECK: 0142's 32 in 0142's order, then its own two.
    expect(reasons0143.slice(0, 32)).toEqual(reasons0142);
    for (const reason of reasons0143.slice(32)) expect(reasons0142, reason).not.toContain(reason);
    expect([...R1_MEET_BOOKING_REASONS]).toEqual(reasons0143);
    expect(R1_MEET_BOOKING_STATUSES).toHaveLength(12);
    expect(R1_MEET_BOOKING_REASONS).toHaveLength(34);
    expect(new Set(R1_MEET_BOOKING_REASONS).size).toBe(34);
    expect(Object.isFrozen(R1_MEET_BOOKING_STATUSES)).toBe(true);
    expect(Object.isFrozen(R1_MEET_BOOKING_REASONS)).toBe(true);
  });

  it('the two sources are the 0143 CHECK list, frozen; source is the eleventh and last field', () => {
    expect([...R1_MEET_BOOKING_SOURCES]).toEqual(inList('chk_r1_meet_bookings_source', 'source', code0143));
    expect(R1_MEET_BOOKING_SOURCES).toHaveLength(2);
    expect(Object.isFrozen(R1_MEET_BOOKING_SOURCES)).toBe(true);
    expect(Object.isFrozen(R1_MEET_BOOKING_FIELDS)).toBe(true);
    expect([...R1_MEET_BOOKING_FIELDS]).toEqual([
      'id', 'candidate_id', 'round_id', 'status', 'reason', 'start_at', 'end_at', 'created_at', 'updated_at', 'version', 'source',
    ]);
    expect(R1_MEET_BOOKINGS_SELECT).toBe('id,candidate_id,round_id,status,reason,start_at,end_at,created_at,updated_at,version,source');
    expect(R1_MEET_BOOKINGS_OWNER_SELECT).toBe(
      'id,candidate_id,round_id,status,reason,start_at,end_at,created_at,updated_at,version,source,candidates!inner(owner_id)',
    );
  });

  it('the spec documents the same enums, the eleven fields and the query parameters', () => {
    const item = ((LIST_SCHEMA as YMap).properties as YMap).bookings as YMap;
    for (const schema of [item.items as YMap, DETAIL_SCHEMA as YMap]) {
      const props = schema.properties as YMap;
      expect(schema.required).toEqual([...R1_MEET_BOOKING_FIELDS]);
      expect(Object.keys(props)).toEqual([...R1_MEET_BOOKING_FIELDS]);
      expect(Object.keys(props)).toHaveLength(11);
      expect(schema.additionalProperties).toBe(false);
      expect((props.status as YMap).enum).toEqual([...R1_MEET_BOOKING_STATUSES]);
      expect((props.reason as YMap).enum).toEqual([...R1_MEET_BOOKING_REASONS]);
      expect((props.reason as YMap).enum).toHaveLength(34);
      expect((props.source as YMap).type).toBe('string');
      expect((props.source as YMap).enum).toEqual([...R1_MEET_BOOKING_SOURCES]);
      expect((props.source as YMap).nullable).toBeUndefined();
      expect((props.candidate_id as YMap).nullable).toBe(true);
      expect((props.round_id as YMap).nullable).toBe(true);
    }
    // The list description names every field it carries, source included.
    expect(String(operation(LIST).description)).toContain(
      'Each booking carries exactly id, candidate_id, round_id, status, reason, start_at, end_at, created_at, updated_at, version and source (ashby or public_page)',
    );
    const params = operation(LIST).parameters as YMap[];
    expect(params.map((p) => p.name)).toEqual(['status', 'from', 'to', 'limit', 'cursor']);
    expect(((params[0]!.schema as YMap).enum)).toEqual([...R1_MEET_BOOKING_STATUSES]);
    expect(params[3]!.schema).toMatchObject({ minimum: 1, maximum: 100, default: 50 });
    expect(operation(LIST).operationId).toBe('listR1MeetBookings');
    expect(operation(`${LIST}/{id}`).operationId).toBe('getR1MeetBooking');
    // Staff routes: the default bearer security, never public.
    expect(operation(LIST).security).toBeUndefined();
    expect(operation(`${LIST}/{id}`).security).toBeUndefined();
  });

  it('CONTROL: the spec validator refuses an extra field and a status outside the enum', () => {
    const body = { meet_enabled: true, bookings: [{ ...bookingProjection(), meet_url: WITHHELD.meet_url }], next_cursor: null };
    expect(validateSchema(body, LIST_SCHEMA, SPEC).join('\n')).toMatch(/meet_url: undocumented property/);
    const wrongStatus = { meet_enabled: true, bookings: [{ ...bookingProjection(), status: 'archived' }], next_cursor: null };
    expect(validateSchema(wrongStatus, LIST_SCHEMA, SPEC).join('\n')).toMatch(/not in enum/);
    // The source: a word outside the two, and a booking without it.
    const wrongSource = { ...bookingProjection(), source: 'csv' };
    expect(validateSchema(wrongSource, DETAIL_SCHEMA, SPEC).join('\n')).toMatch(/source: value "csv" not in enum/);
    const { source: _source, ...noSource } = bookingProjection();
    expect(validateSchema(noSource, DETAIL_SCHEMA, SPEC).join('\n')).toMatch(/source: missing required property/);
    expect(validateSchema({ ...bookingProjection(), source: 'public_page' }, DETAIL_SCHEMA, SPEC)).toEqual([]);
  });
});

function bookingProjection(): Row {
  return {
    id: bookingId(1),
    candidate_id: candidateId(1),
    round_id: roundId(1),
    status: 'bot_scheduled',
    reason: 'eligible',
    start_at: slotStart(1),
    end_at: slotStart(2),
    created_at: slotStart(0),
    updated_at: slotStart(0),
    version: 0,
    source: 'ashby',
  };
}
