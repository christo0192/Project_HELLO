/**
 * M035 S11 T3: the database side of the "Dex R1: Booked" tag lane (`lib/r1/meet/ashby-booked-tag-store.ts`),
 * the REAL store over the in-memory tables of `support/r1-meet-ashby-tag-fake.ts` (and, for shapes the
 * tables cannot produce, a client that answers one fixed value).
 *
 * Pinned here:
 *  - the exact query of each of the four reads (table, the column string byte for byte, filters,
 *    orders, limit, how it settles), and that the booking columns never name our candidate id, the
 *    Meet URL, the ticket, or a calendar, manage, request, move or invite column;
 *  - `booking`: lower-cased id, verbatim Ashby application id, `toISOString()` instants; a missing
 *    row is null; every drifted row, DB error, rejected call and throwing builder is
 *    `r1_meet_db_error` and the message is that code alone;
 *  - `applicationLink`, `candidateApplications` (0 / 1 / 25 rows, the 26th an overflow with no ids,
 *    another candidate's links never seen) and `newestPublicBooking` (created_at, then id, both
 *    descending; Ashby rows and other applications never answered);
 *  - schema pins: every booking column but `source` is a 0142 column; `source` is 0143's (contracts
 *    §3.1; 0143 is on main since S01, #450, so the pin no longer has a dark branch) and 0142 has none;
 *    the two link columns are 0029's.
 */

import { readFileSync, readdirSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import {
  R1_MEET_BOOKED_TAG_BOOKING_COLUMNS,
  R1_MEET_BOOKED_TAG_MAX_APPLICATIONS,
  createR1MeetBookedTagStore,
  type R1MeetBookedTagStore,
} from '../lib/r1/meet/ashby-booked-tag-store.js';
import { R1_MEET_BOOKING_STATUSES } from '../lib/r1/meet/bookings-read.js';
import { R1MeetJobError, R1_MEET_DB_ERROR } from '../lib/r1/meet/jobs.js';
import type { supabase } from '../lib/supabase.js';
import { createBookedTagTables, type BookedTagRow, type BookedTagTables } from './support/r1-meet-ashby-tag-fake.js';
import { HARNESS_NOW, MEET_URL, fixtureId } from './support/r1-meet-harness.js';

// ── Helpers ──────────────────────────────────────────────────────────────────

function world(): { tables: BookedTagTables; store: R1MeetBookedTagStore } {
  const tables = createBookedTagTables();
  return { tables, store: createR1MeetBookedTagStore(tables.client) };
}

async function expectDbError(promise: Promise<unknown>, label?: string): Promise<void> {
  const error = await promise.then(
    () => null,
    (reason: unknown) => reason,
  );
  expect(error, label).toBeInstanceOf(R1MeetJobError);
  expect((error as R1MeetJobError).code, label).toBe(R1_MEET_DB_ERROR);
  expect((error as Error).message, label).toBe(R1_MEET_DB_ERROR);
}

/** A client whose every query answers `answer`: the shapes the in-memory tables never produce. */
function answering(answer: unknown): R1MeetBookedTagStore {
  const builder: Record<string, unknown> = {};
  for (const op of ['select', 'eq', 'in', 'order', 'limit']) builder[op] = () => builder;
  builder.maybeSingle = async () => answer;
  builder.then = (resolve: (value: unknown) => unknown, reject: (reason: unknown) => unknown) =>
    Promise.resolve(answer).then(resolve, reject);
  return createR1MeetBookedTagStore({ from: () => builder } as unknown as typeof supabase);
}

/** Ids outside the fixture counter's range, so a test can order them on purpose. */
const ORDERED_LOW = '7f000000-0000-4000-8000-0000ee0000a1';
const ORDERED_HIGH = '7f000000-0000-4000-8000-0000ee0000a2';

const BOOKING_KEYS = ['id', 'source', 'status', 'applicationId', 'startAt', 'updatedAt', 'createdAt'];
const SELECTED = R1_MEET_BOOKED_TAG_BOOKING_COLUMNS.split(',').map((column) => column.trim());

// ── The four queries ─────────────────────────────────────────────────────────

describe('the booked-tag store: the exact queries', () => {
  it('selects exactly seven booking columns, none of them a contact, link, ticket or calendar column', () => {
    expect(R1_MEET_BOOKED_TAG_BOOKING_COLUMNS).toBe('id, source, status, ashby_application_id, start_at, updated_at, created_at');
    expect(SELECTED).toEqual(['id', 'source', 'status', 'ashby_application_id', 'start_at', 'updated_at', 'created_at']);
    for (const word of ['candidate_id', 'meet_url', 'ticket', 'calendar', 'manage', 'request', 'move_count', 'invite']) {
      expect(R1_MEET_BOOKED_TAG_BOOKING_COLUMNS, word).not.toContain(word);
    }
    expect(R1_MEET_BOOKED_TAG_MAX_APPLICATIONS).toBe(25);
  });

  it('booking: one maybeSingle read of r1_meet_bookings by id', async () => {
    const { tables, store } = world();
    const id = fixtureId();
    await store.booking(id);
    expect(tables.calls).toEqual([
      {
        table: 'r1_meet_bookings',
        columns: R1_MEET_BOOKED_TAG_BOOKING_COLUMNS,
        filters: [{ op: 'eq', column: 'id', value: id }],
        orders: [],
        limit: null,
        terminal: 'maybeSingle',
      },
    ]);
  });

  it('applicationLink: one maybeSingle read of the ashby link by its application id, two columns', async () => {
    const { tables, store } = world();
    const applicationId = fixtureId();
    await store.applicationLink(applicationId);
    expect(tables.calls).toEqual([
      {
        table: 'ashby_application_links',
        columns: 'external_application_id, external_candidate_id',
        filters: [
          { op: 'eq', column: 'provider', value: 'ashby' },
          { op: 'eq', column: 'external_application_id', value: applicationId },
        ],
        orders: [],
        limit: null,
        terminal: 'maybeSingle',
      },
    ]);
  });

  it('candidateApplications: one list read by the Ashby candidate id, ordered, at most 26 rows', async () => {
    const { tables, store } = world();
    const candidateId = fixtureId();
    await store.candidateApplications(candidateId);
    expect(tables.calls).toEqual([
      {
        table: 'ashby_application_links',
        columns: 'external_application_id',
        filters: [
          { op: 'eq', column: 'provider', value: 'ashby' },
          { op: 'eq', column: 'external_candidate_id', value: candidateId },
        ],
        orders: [{ column: 'external_application_id', ascending: true }],
        limit: R1_MEET_BOOKED_TAG_MAX_APPLICATIONS + 1,
        terminal: 'then',
      },
    ]);
  });

  it('newestPublicBooking: one list read of public rows of the application, newest first, one row', async () => {
    const { tables, store } = world();
    const applicationId = fixtureId();
    await store.newestPublicBooking(applicationId);
    expect(tables.calls).toEqual([
      {
        table: 'r1_meet_bookings',
        columns: R1_MEET_BOOKED_TAG_BOOKING_COLUMNS,
        filters: [
          { op: 'eq', column: 'source', value: 'public_page' },
          { op: 'eq', column: 'ashby_application_id', value: applicationId },
        ],
        orders: [
          { column: 'created_at', ascending: false },
          { column: 'id', ascending: false },
        ],
        limit: 1,
        terminal: 'then',
      },
    ]);
  });

  it('answers frozen values that carry nothing beyond the selected columns', async () => {
    const { tables, store } = world();
    expect(Object.isFrozen(store)).toBe(true);
    const applicationId = fixtureId();
    const candidateId = fixtureId();
    const row = tables.publicBooking({ applicationId });
    tables.link({ applicationId, candidateId });
    const booking = await store.booking(row.id as string);
    const newest = await store.newestPublicBooking(applicationId);
    const link = await store.applicationLink(applicationId);
    const applications = await store.candidateApplications(candidateId);
    for (const value of [booking, newest, link, applications, applications.applicationIds]) {
      expect(Object.isFrozen(value)).toBe(true);
    }
    expect(Object.keys(booking!)).toEqual(BOOKING_KEYS);
    expect(Object.keys(newest!)).toEqual(BOOKING_KEYS);
    expect(Object.keys(link!)).toEqual(['externalCandidateId']);
    expect(Object.keys(applications)).toEqual(['applicationIds', 'overflow']);
    // The row's other columns (our candidate id, round, Meet URL, ticket, calendar, manage) never come back.
    const text = JSON.stringify([booking, newest, link, applications]);
    for (const column of ['candidate_id', 'round_id', 'public_request_id', 'ticket_digest', 'manage_token_digest', 'google_calendar_event_id']) {
      expect(text, column).not.toContain(String(row[column]));
    }
    expect(text).not.toContain(MEET_URL);
  });
});

// ── booking ──────────────────────────────────────────────────────────────────

describe('booking', () => {
  it('maps and normalises: lower-cased id, verbatim application id, ISO instants', async () => {
    const { tables, store } = world();
    const id = fixtureId().toUpperCase();
    const applicationId = fixtureId().toUpperCase();
    tables.publicBooking({
      id,
      applicationId,
      status: 'bot_scheduled',
      startAt: '2030-01-02T15:30:00+05:30',
      updatedAt: '2030-01-01T10:00:00.123456+00:00',
      createdAt: '2030-01-01T09:00:00Z',
    });
    expect(await store.booking(id)).toStrictEqual({
      id: id.toLowerCase(),
      source: 'public_page',
      status: 'bot_scheduled',
      applicationId,
      startAt: '2030-01-02T10:00:00.000Z',
      updatedAt: '2030-01-01T10:00:00.123Z',
      createdAt: '2030-01-01T09:00:00.000Z',
    });
  });

  it('reads every status of 0142 and both sources (the job, not the store, ignores Ashby rows)', async () => {
    const { tables, store } = world();
    for (const status of R1_MEET_BOOKING_STATUSES) {
      for (const source of ['public_page', 'ashby'] as const) {
        const row = tables.publicBooking({ applicationId: fixtureId(), status, source });
        const booking = await store.booking(row.id as string);
        expect(booking?.status, status).toBe(status);
        expect(booking?.source, status).toBe(source);
      }
    }
  });

  it('a 256-character Ashby application id is read verbatim', async () => {
    const { tables, store } = world();
    const applicationId = 'a'.repeat(256);
    const row = tables.publicBooking({ applicationId });
    expect((await store.booking(row.id as string))?.applicationId).toBe(applicationId);
  });

  it('a missing booking is null, never an error', async () => {
    const { tables, store } = world();
    tables.publicBooking({ applicationId: fixtureId() });
    expect(await store.booking(fixtureId())).toBeNull();
  });

  const DRIFT: ReadonlyArray<readonly [string, (row: BookedTagRow) => void]> = [
    ['unknown source', (row) => (row.source = 'calendar')],
    ['source in another case', (row) => (row.source = 'PUBLIC_PAGE')],
    ['null source', (row) => (row.source = null)],
    ['unknown status', (row) => (row.status = 'live')],
    ['status in another case', (row) => (row.status = 'Completed')],
    ['null status', (row) => (row.status = null)],
    ['zoneless start', (row) => (row.start_at = '2030-01-02T10:00:00')],
    ['garbage start', (row) => (row.start_at = 'soon')],
    ['numeric start', (row) => (row.start_at = 1893456000000)],
    ['impossible start', (row) => (row.start_at = '2030-13-01T10:00:00Z')],
    ['null updated_at', (row) => (row.updated_at = null)],
    ['date-only created_at', (row) => (row.created_at = '2030-01-01')],
    ['empty application id', (row) => (row.ashby_application_id = '')],
    ['257-character application id', (row) => (row.ashby_application_id = 'a'.repeat(257))],
    ['null application id', (row) => (row.ashby_application_id = null)],
    ['numeric application id', (row) => (row.ashby_application_id = 7)],
  ];

  it.each(DRIFT)('a drifted row (%s) is r1_meet_db_error', async (_label, drift) => {
    const { tables, store } = world();
    const row = tables.publicBooking({ applicationId: fixtureId() });
    drift(row);
    await expectDbError(store.booking(row.id as string));
  });

  it.each(SELECTED)('a selected column absent from the answer (%s) is r1_meet_db_error', async (column) => {
    const { tables, store } = world();
    const row = tables.publicBooking({ applicationId: fixtureId() });
    if (column === 'id') {
      // The id is the filter: answer a row without it through a fixed client.
      const answer = { ...row };
      delete answer.id;
      await expectDbError(answering({ data: answer, error: null }).booking(row.id as string));
      return;
    }
    delete row[column];
    await expectDbError(store.booking(row.id as string), column);
  });

  it('a non-UUID id or a row of another id is r1_meet_db_error', async () => {
    const { tables, store } = world();
    const row = tables.publicBooking({ applicationId: fixtureId(), id: 'not-a-uuid' });
    await expectDbError(store.booking(row.id as string));
    const other = tables.publicBooking({ applicationId: fixtureId() });
    await expectDbError(answering({ data: { ...other, id: fixtureId() }, error: null }).booking(other.id as string));
  });

  it('a DB error, a rejected call and a throwing builder are r1_meet_db_error, and nothing of the driver leaks', async () => {
    for (const failure of ['error', 'reject', 'throw'] as const) {
      const { tables, store } = world();
      const row = tables.publicBooking({ applicationId: fixtureId() });
      tables.failNext('r1_meet_bookings', failure);
      await expectDbError(store.booking(row.id as string), failure);
      // The failure was one query; the next read of the same row works.
      expect((await store.booking(row.id as string))?.id, failure).toBe(row.id);
    }
  });

  it('answers that are not a row are r1_meet_db_error', async () => {
    const id = fixtureId();
    for (const answer of [null, undefined, 'answer', { data: 'row', error: null }, { data: [{}], error: null }, { data: null, error: { message: 'x' } }]) {
      await expectDbError(answering(answer).booking(id), JSON.stringify(answer) ?? 'undefined');
    }
    // A row with a prototype other than Object (not a plain JSON row).
    await expectDbError(answering({ data: new Date(), error: null }).booking(id));
  });
});

// ── applicationLink ──────────────────────────────────────────────────────────

describe('applicationLink', () => {
  it('no link is null (a link of another application is not this one)', async () => {
    const { tables, store } = world();
    tables.link({ applicationId: fixtureId(), candidateId: fixtureId() });
    expect(await store.applicationLink(fixtureId())).toBeNull();
  });

  it('a link never bound to an Ashby candidate answers externalCandidateId null', async () => {
    const { tables, store } = world();
    const applicationId = fixtureId();
    tables.link({ applicationId, candidateId: null });
    expect(await store.applicationLink(applicationId)).toStrictEqual({ externalCandidateId: null });
  });

  it('the Ashby candidate id is verbatim, and the application id is matched verbatim', async () => {
    const { tables, store } = world();
    const applicationId = fixtureId().toUpperCase();
    const candidateId = `${fixtureId().toUpperCase()}-Verbatim`;
    tables.link({ applicationId, candidateId });
    expect(await store.applicationLink(applicationId)).toStrictEqual({ externalCandidateId: candidateId });
    // Another spelling of the id is another Ashby id.
    expect(await store.applicationLink(applicationId.toLowerCase())).toBeNull();
  });

  it('a drifted link, two links, a DB error and a link of another application are r1_meet_db_error', async () => {
    for (const bad of ['', 'c'.repeat(257), 42, true]) {
      const { tables, store } = world();
      const applicationId = fixtureId();
      tables.link({ applicationId, candidateId: null }).external_candidate_id = bad;
      await expectDbError(store.applicationLink(applicationId), String(bad));
    }
    {
      const { tables, store } = world();
      const applicationId = fixtureId();
      delete tables.link({ applicationId, candidateId: fixtureId() }).external_candidate_id;
      await expectDbError(store.applicationLink(applicationId), 'absent');
    }
    {
      const { tables, store } = world();
      const applicationId = fixtureId();
      tables.link({ applicationId, candidateId: fixtureId() });
      tables.link({ applicationId, candidateId: fixtureId() });
      await expectDbError(store.applicationLink(applicationId), 'two links');
    }
    for (const failure of ['error', 'reject', 'throw'] as const) {
      const { tables, store } = world();
      const applicationId = fixtureId();
      tables.link({ applicationId, candidateId: fixtureId() });
      tables.failNext('ashby_application_links', failure);
      await expectDbError(store.applicationLink(applicationId), failure);
    }
    const asked = fixtureId();
    await expectDbError(
      answering({ data: { external_application_id: fixtureId(), external_candidate_id: fixtureId() }, error: null }).applicationLink(asked),
      'another application',
    );
  });
});

// ── candidateApplications ────────────────────────────────────────────────────

describe('candidateApplications', () => {
  function linked(tables: BookedTagTables, candidateId: string, count: number): string[] {
    const ids = Array.from({ length: count }, () => fixtureId());
    // Seeded newest-first so the read's own order is what sorts them.
    for (const applicationId of [...ids].reverse()) tables.link({ applicationId, candidateId });
    return ids.sort();
  }

  it.each([0, 1, R1_MEET_BOOKED_TAG_MAX_APPLICATIONS])('%i links answer their ids, ordered, no overflow', async (count) => {
    const { tables, store } = world();
    const candidateId = fixtureId();
    const ids = linked(tables, candidateId, count);
    const answer = await store.candidateApplications(candidateId);
    expect(answer).toStrictEqual({ applicationIds: ids, overflow: false });
    expect(answer.applicationIds).toHaveLength(count);
  });

  it('a 26th link is an overflow with no ids', async () => {
    const { tables, store } = world();
    const candidateId = fixtureId();
    linked(tables, candidateId, R1_MEET_BOOKED_TAG_MAX_APPLICATIONS + 1);
    expect(await store.candidateApplications(candidateId)).toStrictEqual({ applicationIds: [], overflow: true });
  });

  it('links of another candidate, or of none, never appear; a repeated id appears once', async () => {
    const { tables, store } = world();
    const candidateId = fixtureId();
    const mine = linked(tables, candidateId, 2);
    linked(tables, fixtureId(), 3);
    tables.link({ applicationId: fixtureId(), candidateId: null });
    tables.link({ applicationId: fixtureId(), candidateId: candidateId.toUpperCase() });
    // The in-memory table has no unique index; the store still answers each id once.
    tables.link({ applicationId: mine[0]!, candidateId });
    expect(await store.candidateApplications(candidateId)).toStrictEqual({ applicationIds: mine, overflow: false });
  });

  it('a drifted id, an answer that is not a list and a DB error are r1_meet_db_error', async () => {
    for (const bad of ['', 'a'.repeat(257), null, 9]) {
      const { tables, store } = world();
      const candidateId = fixtureId();
      linked(tables, candidateId, 1);
      tables.link({ applicationId: fixtureId(), candidateId }).external_application_id = bad;
      await expectDbError(store.candidateApplications(candidateId), String(bad));
    }
    for (const failure of ['error', 'reject', 'throw'] as const) {
      const { tables, store } = world();
      const candidateId = fixtureId();
      linked(tables, candidateId, 1);
      tables.failNext('ashby_application_links', failure);
      await expectDbError(store.candidateApplications(candidateId), failure);
    }
    for (const answer of [{ data: null, error: null }, { data: { external_application_id: 'x' }, error: null }, { data: ['x'], error: null }]) {
      await expectDbError(answering(answer).candidateApplications(fixtureId()), JSON.stringify(answer));
    }
  });
});

// ── newestPublicBooking ──────────────────────────────────────────────────────

describe('newestPublicBooking', () => {
  const at = (minutes: number) => new Date(Date.parse(HARNESS_NOW) + minutes * 60_000).toISOString();

  it('picks the newest public booking of the application by created_at', async () => {
    const { tables, store } = world();
    const applicationId = fixtureId();
    const middle = tables.publicBooking({ applicationId, status: 'cancelled', createdAt: at(10) });
    const newest = tables.publicBooking({ applicationId, status: 'pending', createdAt: at(20) });
    tables.publicBooking({ applicationId, status: 'failed', createdAt: at(0) });
    const answer = await store.newestPublicBooking(applicationId);
    expect(answer?.id).toBe(newest.id);
    expect(answer?.status).toBe('pending');
    expect(answer?.id).not.toBe(middle.id);
  });

  it('orders by the instant, not the spelling of the timestamp', async () => {
    const { tables, store } = world();
    const applicationId = fixtureId();
    // 10:30 IST is 05:00 UTC, earlier than 06:00Z although it sorts later as text.
    tables.publicBooking({ applicationId, createdAt: '2030-01-01T10:30:00+05:30' });
    const later = tables.publicBooking({ applicationId, createdAt: '2030-01-01T06:00:00Z' });
    expect((await store.newestPublicBooking(applicationId))?.id).toBe(later.id);
  });

  it('breaks a created_at tie by the greater id', async () => {
    for (const order of [[ORDERED_LOW, ORDERED_HIGH], [ORDERED_HIGH, ORDERED_LOW]]) {
      const { tables, store } = world();
      const applicationId = fixtureId();
      for (const id of order) tables.publicBooking({ id, applicationId, createdAt: at(5) });
      expect((await store.newestPublicBooking(applicationId))?.id, order.join(' then ')).toBe(ORDERED_HIGH);
    }
  });

  it('ignores Ashby-scheduled rows and other applications', async () => {
    const { tables, store } = world();
    const applicationId = fixtureId();
    const own = tables.publicBooking({ applicationId, status: 'completed', createdAt: at(1) });
    tables.publicBooking({ applicationId, status: 'pending', createdAt: at(30), source: 'ashby' });
    tables.publicBooking({ applicationId: fixtureId(), status: 'pending', createdAt: at(40) });
    const answer = await store.newestPublicBooking(applicationId);
    expect(answer).toStrictEqual({
      id: own.id,
      source: 'public_page',
      status: 'completed',
      applicationId,
      startAt: own.start_at,
      updatedAt: HARNESS_NOW,
      createdAt: at(1),
    });
  });

  it('no public booking of the application is null', async () => {
    const { tables, store } = world();
    const applicationId = fixtureId();
    tables.publicBooking({ applicationId, source: 'ashby' });
    tables.publicBooking({ applicationId: fixtureId() });
    expect(await store.newestPublicBooking(applicationId)).toBeNull();
  });

  it('a drifted row, a DB error, two rows, an Ashby row or another application answered are r1_meet_db_error', async () => {
    {
      const { tables, store } = world();
      const applicationId = fixtureId();
      tables.publicBooking({ applicationId }).start_at = 'soon';
      await expectDbError(store.newestPublicBooking(applicationId), 'drift');
    }
    for (const failure of ['error', 'reject', 'throw'] as const) {
      const { tables, store } = world();
      const applicationId = fixtureId();
      tables.publicBooking({ applicationId });
      tables.failNext('r1_meet_bookings', failure);
      await expectDbError(store.newestPublicBooking(applicationId), failure);
    }
    const { tables } = world();
    const applicationId = fixtureId();
    const row = tables.publicBooking({ applicationId });
    const pick = (value: BookedTagRow) => Object.fromEntries(SELECTED.map((column) => [column, value[column]]));
    const answers: Array<readonly [string, unknown]> = [
      ['two rows', { data: [pick(row), pick({ ...row, id: fixtureId() })], error: null }],
      ['an Ashby row', { data: [pick({ ...row, source: 'ashby' })], error: null }],
      ['another application', { data: [pick({ ...row, ashby_application_id: fixtureId() })], error: null }],
      ['not a list', { data: pick(row), error: null }],
    ];
    for (const [label, answer] of answers) {
      await expectDbError(answering(answer).newestPublicBooking(applicationId), label);
    }
    // The same row answered alone is read.
    expect((await answering({ data: [pick(row)], error: null }).newestPublicBooking(applicationId))?.id).toBe(row.id);
  });
});

// ── Schema pins ──────────────────────────────────────────────────────────────

describe('the columns exist in the migrations', () => {
  const here = path.dirname(fileURLToPath(import.meta.url));
  const MIGRATIONS = path.resolve(here, '../../../supabase/migrations');
  const sqlOf = (name: string): string =>
    readFileSync(path.join(MIGRATIONS, name), 'utf8')
      .replace(/\r\n/g, '\n')
      .replace(/--[^\n]*/g, '')
      .replace(/\s+/g, ' ');
  /** The `create table` statement of one table, whitespace-collapsed. */
  const createTable = (sql: string, table: string): string => {
    const start = sql.indexOf(`create table if not exists screening_v2.${table} (`);
    expect(start, table).toBeGreaterThanOrEqual(0);
    const end = sql.indexOf(' );', start);
    expect(end, table).toBeGreaterThan(start);
    return sql.slice(start, end + 3);
  };
  /** `column type` as a column definition (after `(` or `,`, ended by a space, a comma or `)`). */
  const declares = (statement: string, column: string, type: string): boolean =>
    new RegExp(`[(,] ${column} ${type}(?=[ ,)])`).test(statement);

  const bookings0142 = createTable(sqlOf('0142_r1_meet_bookings.sql'), 'r1_meet_bookings');
  const PUBLIC_MIGRATION = '0143_r1_meet_public_bookings.sql';

  it('every selected booking column but source is declared on r1_meet_bookings in 0142', () => {
    const types: Record<string, string> = {
      id: 'uuid primary key',
      status: 'text not null',
      ashby_application_id: 'text not null',
      start_at: 'timestamptz not null',
      updated_at: 'timestamptz not null',
      created_at: 'timestamptz not null',
    };
    expect(Object.keys(types).sort()).toEqual(SELECTED.filter((column) => column !== 'source').sort());
    for (const [column, type] of Object.entries(types)) expect(declares(bookings0142, column, type), column).toBe(true);
  });

  it('the status list the store accepts is the 0142 status CHECK', () => {
    const check = /constraint chk_r1_meet_bookings_status check \(status in \(([^)]*)\)\)/.exec(bookings0142);
    expect(check).not.toBeNull();
    const listed = check![1]!.split(',').map((value) => value.trim().replace(/^'|'$/g, ''));
    expect(listed).toEqual([...R1_MEET_BOOKING_STATUSES]);
  });

  // S01's 0143 is on main (#450), so this pin no longer has its dark branch (0143 absent, 0142 with no
  // source): it now requires the 0143 column outright.
  it('source is the 0143 column of contracts 3.1, and 0142 has none', () => {
    expect(readdirSync(MIGRATIONS)).toContain(PUBLIC_MIGRATION);
    const sql = sqlOf(PUBLIC_MIGRATION);
    expect(sql).toContain("add column if not exists source text not null default 'ashby'");
    expect(sql).toMatch(/source in \(\s*'ashby'\s*,\s*'public_page'\s*\)/);
    // The application id stays NOT NULL on every row (contracts 3.1): the store requires one.
    expect(sql).not.toMatch(/alter column ashby_application_id drop not null/);
    expect(declares(bookings0142, 'source', 'text')).toBe(false);
  });

  it('the two link columns, the provider and the unique application key are 0029 columns', () => {
    const links = createTable(sqlOf('0029_ashby_integration.sql'), 'ashby_application_links');
    expect(declares(links, 'provider', "text not null default 'ashby'")).toBe(true);
    expect(declares(links, 'external_application_id', 'text not null')).toBe(true);
    expect(declares(links, 'external_candidate_id', 'text')).toBe(true);
    expect(links).toContain('constraint uq_ashby_application_links_app unique (provider, external_application_id)');
    expect(links).toContain('check (length(external_application_id) between 1 and 256)');
    expect(links).toContain('check (external_candidate_id is null or length(external_candidate_id) between 1 and 256)');
  });
});
