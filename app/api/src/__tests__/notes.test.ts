/**
 * Phase 9 L3 — /api/notes (invariant 2).
 * Append-only recruiter notes (bounded body, interviewer ownership/admin,
 * viewer read-only) + candidate status transitions (explicit allowlist +
 * CAS + audit, fail closed while decision_use_blocked_at is set, never
 * accepts unknown statuses).
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import request from 'supertest';
import express from 'express';
import { createRequireAuth, mockAuthGetUser, type AuthUser } from '../lib/auth.js';
import { viewerReadOnly } from '../lib/rbac.js';
import { notesRouter } from '../routes/notes.js';
import { finalErrorHandler } from '../lib/validation.js';

vi.mock('../lib/supabase.js', () => ({
  supabase: { from: vi.fn(), rpc: vi.fn() },
  RESUME_BUCKET: 'resumes_v2',
}));

const JWT_AAL2 = 'eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiJ1c2VyLTAwMSIsImFhbCI6ImFhbDIifQ.signature';
const CANDIDATE_ID = '00000000-0000-4000-8000-000000000001';
const OTHER_CANDIDATE_ID = '00000000-0000-4000-8000-000000000002';
const RECRUITER_ID = '00000000-0000-4000-8000-0000000000ff';
const OTHER_RECRUITER_ID = '00000000-0000-4000-8000-0000000000ee';

/** Records insert/update payloads so tests can assert on DB writes. */
let inserted: any[] = [];
let updated: any[] = [];

function chainable(value: any): any {
  const fn = function () { return chainable(value); };
  fn.then = (resolve: (v: any) => any) => Promise.resolve(value).then(resolve);
  fn.catch = (reject: (e: unknown) => unknown) => Promise.resolve(value).catch(reject);
  fn.eq = () => chainable(value);
  fn.order = () => chainable(value);
  fn.limit = () => chainable(value);
  fn.range = () => chainable(value);
  fn.select = () => chainable(value);
  fn.maybeSingle = () => chainable(value);
  fn.single = () => chainable(value);
  fn.is = () => chainable(value);
  fn.in = () => chainable(value);
  fn.insert = (...args: any[]) => { inserted.push(args); return chainable(value); };
  fn.update = (...args: any[]) => { updated.push(args); return chainable(value); };
  fn.gt = () => chainable(value);
  return fn;
}

function makeUser(role: AuthUser['appRole'], overrides: Partial<AuthUser> = {}): AuthUser {
  return {
    id: RECRUITER_ID,
    email: 'recruiter@example.com',
    aal: 'aal2',
    active: true,
    appRole: role,
    orgId: null,
    ...overrides,
  };
}

let mockFrom: any;

beforeEach(async () => {
  const mod = await import('../lib/supabase.js');
  mockFrom = (mod.supabase as any).from;
  mockFrom.mockReset();
  inserted = [];
  updated = [];
});

afterEach(() => {
  vi.restoreAllMocks();
});

function makeApp(user: AuthUser) {
  const app = express();
  app.use(express.json());
  app.use(createRequireAuth({ getUser: mockAuthGetUser(user, JWT_AAL2) }));
  app.use(viewerReadOnly);
  app.use('/api/notes', notesRouter);
  app.use(finalErrorHandler);
  return app;
}

const AUTH = { Authorization: `Bearer ${JWT_AAL2}` };
const NOTE_ROW = {
  id: '00000000-0000-4000-8000-0000000000a1',
  candidate_id: CANDIDATE_ID,
  author_id: RECRUITER_ID,
  note: 'Strong communication, follows up well.',
  created_at: '2025-01-01T00:00:00.000Z',
};

describe('notes — auth/role boundary', () => {
  it('401 without auth', async () => {
    const res = await request(makeApp(makeUser('admin'))).get(`/api/notes?candidate_id=${CANDIDATE_ID}`);
    expect(res.status).toBe(401);
  });

  it('viewer can READ notes (viewer read-only, not denied)', async () => {
    mockFrom
      .mockReturnValueOnce(chainable({ data: { owner_id: null }, error: null }))
      .mockReturnValueOnce(chainable({ data: [NOTE_ROW], error: null }));
    const res = await request(makeApp(makeUser('viewer', { aal: 'aal1' })))
      .get(`/api/notes?candidate_id=${CANDIDATE_ID}`)
      .set(AUTH);
    expect(res.status).toBe(200);
    expect(res.body.notes).toHaveLength(1);
    expect(res.body.notes[0].note).toBe(NOTE_ROW.note);
  });

  it('viewer mutation denied (POST → 403)', async () => {
    const res = await request(makeApp(makeUser('viewer', { aal: 'aal1' })))
      .post('/api/notes')
      .set(AUTH)
      .send({ candidate_id: CANDIDATE_ID, note: 'should not write' });
    expect(res.status).toBe(403);
    expect(mockFrom).not.toHaveBeenCalledWith('recruiter_notes');
  });
});

describe('GET /api/notes', () => {
  it('interviewer can read notes for an owned candidate', async () => {
    mockFrom
      .mockReturnValueOnce(chainable({ data: { owner_id: RECRUITER_ID }, error: null }))
      .mockReturnValueOnce(chainable({ data: [NOTE_ROW], error: null }));
    const res = await request(makeApp(makeUser('interviewer')))
      .get(`/api/notes?candidate_id=${CANDIDATE_ID}`)
      .set(AUTH);
    expect(res.status).toBe(200);
    expect(res.body.notes).toHaveLength(1);
  });

  it('non-owner interviewer denied (403)', async () => {
    mockFrom.mockReturnValueOnce(chainable({ data: { owner_id: OTHER_RECRUITER_ID }, error: null }));
    const res = await request(makeApp(makeUser('interviewer')))
      .get(`/api/notes?candidate_id=${CANDIDATE_ID}`)
      .set(AUTH);
    expect(res.status).toBe(403);
    expect(mockFrom).not.toHaveBeenCalledWith('recruiter_notes');
  });

  it('unknown candidate → 404', async () => {
    mockFrom.mockReturnValueOnce(chainable({ data: null, error: null }));
    const res = await request(makeApp(makeUser('interviewer')))
      .get(`/api/notes?candidate_id=${CANDIDATE_ID}`)
      .set(AUTH);
    expect(res.status).toBe(404);
    expect(res.body.error).toBe('candidate_not_found');
  });

  it('admin sees all candidates regardless of owner', async () => {
    mockFrom
      .mockReturnValueOnce(chainable({ data: { owner_id: OTHER_RECRUITER_ID }, error: null }))
      .mockReturnValueOnce(chainable({ data: [NOTE_ROW], error: null }));
    const res = await request(makeApp(makeUser('admin')))
      .get(`/api/notes?candidate_id=${CANDIDATE_ID}`)
      .set(AUTH);
    expect(res.status).toBe(200);
  });

  it('400 for missing/unknown candidate_id query', async () => {
    const res = await request(makeApp(makeUser('admin'))).get('/api/notes').set(AUTH);
    expect(res.status).toBe(400);
  });

  describe('a long list', () => {
    type Stored = Record<string, string | null>;
    /** The order, the bound and the pages as the database applies them: a later `.order` only breaks a tie. */
    function ordered(rows: Stored[]) {
      const orders: Array<[string, boolean]> = [];
      let bound = rows.length;
      const compare = (a: Stored, b: Stored) => {
        for (const [column, ascending] of orders) {
          const gap = String(a[column]).localeCompare(String(b[column]));
          if (gap !== 0) return ascending ? gap : -gap;
        }
        return 0;
      };
      const answer = () => [...rows].sort(compare).slice(0, bound);
      const query: any = {
        select: () => query,
        eq: () => query,
        order: (column: string, { ascending }: { ascending: boolean }) => { orders.push([column, ascending]); return query; },
        limit: (count: number) => { bound = count; return query; },
        range: (from: number, to: number) => Promise.resolve({ data: answer().slice(from, to + 1), error: null }),
        then: (resolve: (v: unknown) => unknown) => Promise.resolve({ data: answer(), error: null }).then(resolve),
      };
      return query;
    }
    const notes = (count: number) => Array.from({ length: count }, (_, index) => ({
      ...NOTE_ROW, id: `note-${String(index).padStart(4, '0')}`, created_at: new Date(Date.UTC(2026, 0, 1, 0, index)).toISOString(),
    }));
    /** Each read gets a fresh query, as the real client does. */
    const read = async (rows: Stored[], query = '') => {
      mockFrom.mockImplementation((name: string) => (name === 'candidates' ? chainable({ data: { owner_id: null }, error: null }) : ordered(rows)));
      return request(makeApp(makeUser('admin'))).get(`/api/notes?candidate_id=${CANDIDATE_ID}${query}`).set(AUTH);
    };

    it('keeps a note with no round on the list, however many moment notes follow it', async () => {
      const onTheCandidate = notes(5).map((note) => ({ ...note, round_id: null }));
      const atAMoment = notes(105).slice(5).map((note) => ({ ...note, round_id: '00000000-0000-4000-8000-0000000000b1' }));
      const res = await read([...onTheCandidate, ...atAMoment]);
      expect(res.body.notes).toHaveLength(105);
      expect(res.body.notes.slice(0, 5).map((note: { id: string }) => note.id)).toEqual(onTheCandidate.map((note) => note.id));
      expect(res.body.notes.at(-1).id).toBe('note-0104');
    });

    it('hands them back oldest first, as the page prints them', async () => {
      const res = await read(notes(130));
      const ids = res.body.notes.map((note: { id: string }) => note.id);
      expect(ids[0]).toBe('note-0000');
      expect(ids).toEqual([...ids].sort());
    });

    it('reads past the row cap: the list is never cut short', async () => {
      const res = await read(notes(1203));
      expect(res.body.notes).toHaveLength(1203);
      expect(res.body.notes.at(-1).id).toBe('note-1202');
    });

    it('fails rather than answer part of the list', async () => {
      mockFrom.mockImplementation((name: string) => (name === 'candidates' ? chainable({ data: { owner_id: null }, error: null }) : table([], new Error('read failed'))));
      const res = await request(makeApp(makeUser('admin'))).get(`/api/notes?candidate_id=${CANDIDATE_ID}`).set(AUTH);
      expect(res.status).toBe(500);
      expect(res.body.notes).toBeUndefined();
    });

    it('takes the newest of a limit, still oldest first', async () => {
      const res = await read(notes(10), '&limit=2');
      expect(res.body.notes.map((note: { id: string }) => note.id)).toEqual(['note-0008', 'note-0009']);
    });

    it('still takes a limit of the old bound', async () => {
      const res = await read(notes(130), '&limit=100');
      expect(res.body.notes).toHaveLength(100);
      expect(res.body.notes.at(-1).id).toBe('note-0129');
    });

    it('cuts two notes of one instant the same way every time, by id', async () => {
      const at = '2026-01-01T00:00:00.000Z';
      const rows = [{ ...NOTE_ROW, id: 'note-a', created_at: at }, { ...NOTE_ROW, id: 'note-b', created_at: at }];
      const res = await read(rows, '&limit=1');
      expect(res.body.notes.map((note: { id: string }) => note.id)).toEqual(['note-b']);
    });
  });
});

describe('POST /api/notes', () => {
  it('interviewer (owner) appends a note → 201', async () => {
    mockFrom
      .mockReturnValueOnce(chainable({ data: { owner_id: RECRUITER_ID }, error: null }))
      .mockReturnValueOnce(chainable({ data: NOTE_ROW, error: null }));
    const res = await request(makeApp(makeUser('interviewer')))
      .post('/api/notes')
      .set(AUTH)
      .send({ candidate_id: CANDIDATE_ID, note: 'Needs second round.' });
    expect(res.status).toBe(201);
    expect(res.body.note).toBe(NOTE_ROW.note);
    const insertCall = mockFrom.mock.calls.find((c: string[]) => c[0] === 'recruiter_notes');
    expect(insertCall).toBeTruthy();
  });

  it('non-owner interviewer denied (403) — no insert attempted', async () => {
    mockFrom.mockReturnValueOnce(chainable({ data: { owner_id: OTHER_RECRUITER_ID }, error: null }));
    const res = await request(makeApp(makeUser('interviewer')))
      .post('/api/notes')
      .set(AUTH)
      .send({ candidate_id: CANDIDATE_ID, note: 'sneak' });
    expect(res.status).toBe(403);
    expect(mockFrom).not.toHaveBeenCalledWith('recruiter_notes');
  });

  it('empty note rejected (400)', async () => {
    const res = await request(makeApp(makeUser('interviewer')))
      .post('/api/notes')
      .set(AUTH)
      .send({ candidate_id: CANDIDATE_ID, note: '   ' });
    expect(res.status).toBe(400);
  });

  it('note longer than 4000 chars rejected (400)', async () => {
    const res = await request(makeApp(makeUser('interviewer')))
      .post('/api/notes')
      .set(AUTH)
      .send({ candidate_id: CANDIDATE_ID, note: 'x'.repeat(4001) });
    expect(res.status).toBe(400);
  });

  it('unknown candidate → 404', async () => {
    mockFrom.mockReturnValueOnce(chainable({ data: null, error: null }));
    const res = await request(makeApp(makeUser('interviewer')))
      .post('/api/notes')
      .set(AUTH)
      .send({ candidate_id: CANDIDATE_ID, note: 'hi' });
    expect(res.status).toBe(404);
  });
});

/** A read that honours `.eq()`: the scoping tests must show which rows a filter really lets through. */
function table(rows: Array<Record<string, unknown>>, readError: unknown = null) {
  const filters: Array<[string, unknown]> = [];
  const hits = () => rows.filter((row) => filters.every(([column, value]) => row[column] === value));
  const answer = (data: unknown) => Promise.resolve(readError ? { data: null, error: readError } : { data, error: null });
  const query: any = {
    select: () => query,
    eq: (column: string, value: unknown) => { filters.push([column, value]); return query; },
    order: () => query,
    limit: () => query,
    range: (from: number, to: number) => answer(hits().slice(from, to + 1)),
    maybeSingle: () => answer(hits()[0] ?? null),
    then: (resolve: (v: unknown) => unknown) => answer(hits()).then(resolve),
  };
  return query;
}

const ROUND_ID = '00000000-0000-4000-8000-0000000000b1';
const OTHER_ROUND_ID = '00000000-0000-4000-8000-0000000000b2';
const SESSION_ID = '00000000-0000-4000-8000-0000000000c1';
const OTHER_SESSION_ID = '00000000-0000-4000-8000-0000000000c2';

describe('notes tied to a moment', () => {
  const ROUND_ROW = { id: ROUND_ID, candidate_id: CANDIDATE_ID };
  const OTHER_ROUND_ROW = { id: OTHER_ROUND_ID, candidate_id: OTHER_CANDIDATE_ID };
  const ATTEMPT_ROW = { round_id: ROUND_ID, session_id: SESSION_ID };
  const OTHER_ATTEMPT_ROW = { round_id: OTHER_ROUND_ID, session_id: OTHER_SESSION_ID };
  const ANCHOR = { round_id: ROUND_ID, session_id: SESSION_ID, media_ms: 462_000 };

  /** Each read gets a fresh query, as the real client does; `recruiter_notes` is what the insert answers. */
  function world(over: Record<string, () => unknown> = {}, owner: string | null = RECRUITER_ID) {
    const tables: Record<string, () => unknown> = {
      candidates: () => table([{ id: CANDIDATE_ID, owner_id: owner }]),
      interview_rounds: () => table([ROUND_ROW, OTHER_ROUND_ROW]),
      interview_round_attempts: () => table([ATTEMPT_ROW, OTHER_ATTEMPT_ROW]),
      recruiter_notes: () => chainable({ data: { ...NOTE_ROW, ...ANCHOR }, error: null }),
      ...over,
    };
    mockFrom.mockImplementation((name: string) => tables[name]());
  }

  const post = (user: AuthUser, body: Record<string, unknown>) =>
    request(makeApp(user)).post('/api/notes').set(AUTH).send({ candidate_id: CANDIDATE_ID, note: 'Handled the price well.', ...body });

  describe('POST /api/notes', () => {
    it('stores the round, the attempt and the time with the note, and answers them', async () => {
      world();
      const res = await post(makeUser('interviewer'), ANCHOR);
      expect(res.status).toBe(201);
      expect(res.body).toMatchObject(ANCHOR);
      expect(inserted[0][0]).toMatchObject({ ...ANCHOR, candidate_id: CANDIDATE_ID, author_id: RECRUITER_ID });
    });

    it('takes a note at the very start: zero is a time', async () => {
      world();
      expect((await post(makeUser('admin'), { ...ANCHOR, media_ms: 0 })).status).toBe(201);
      expect(inserted[0][0].media_ms).toBe(0);
    });

    it('takes a note on a round or an attempt with no time', async () => {
      world();
      expect((await post(makeUser('admin'), { round_id: ROUND_ID })).status).toBe(201);
      expect((await post(makeUser('admin'), { round_id: ROUND_ID, session_id: SESSION_ID })).status).toBe(201);
      expect(inserted.map(([row]) => row.media_ms)).toEqual([null, null]);
    });

    it('leaves a candidate note as it always was, and reads no round for it', async () => {
      world();
      expect((await post(makeUser('admin'), {})).status).toBe(201);
      expect(inserted[0][0]).toMatchObject({ round_id: null, session_id: null, media_ms: null });
      expect(mockFrom).not.toHaveBeenCalledWith('interview_rounds');
      expect(mockFrom).not.toHaveBeenCalledWith('interview_round_attempts');
    });

    it.each([
      ['a negative time', { ...ANCHOR, media_ms: -1 }],
      ['a time that is not whole', { ...ANCHOR, media_ms: 1.5 }],
      ['a time as a string', { ...ANCHOR, media_ms: '462000' }],
      ['a time past a day', { ...ANCHOR, media_ms: 86_400_001 }],
      ['a time with no attempt', { round_id: ROUND_ID, media_ms: 5 }],
      ['a time with nothing else', { media_ms: 5 }],
      ['an attempt with no round', { session_id: SESSION_ID }],
      ['a round that is not an id', { round_id: 'round-1' }],
      ['an attempt that is not an id', { round_id: ROUND_ID, session_id: 'session-1' }],
      ['a field the route does not know', { ...ANCHOR, author_id: OTHER_RECRUITER_ID }],
    ])('refuses %s (400), and writes nothing', async (_name, body) => {
      world();
      const res = await post(makeUser('admin'), body);
      expect(res.status).toBe(400);
      expect(inserted).toEqual([]);
    });

    it('refuses a round of another candidate (400), and writes nothing', async () => {
      world();
      const res = await post(makeUser('admin'), { round_id: OTHER_ROUND_ID, session_id: OTHER_SESSION_ID, media_ms: 5 });
      expect(res.status).toBe(400);
      expect(res.body.error).toBe('invalid_note_anchor');
      expect(inserted).toEqual([]);
    });

    it('refuses an attempt of another round (400), and writes nothing', async () => {
      world();
      const res = await post(makeUser('admin'), { round_id: ROUND_ID, session_id: OTHER_SESSION_ID, media_ms: 5 });
      expect(res.status).toBe(400);
      expect(res.body.error).toBe('invalid_note_anchor');
      expect(inserted).toEqual([]);
    });

    it('answers a round that does not exist exactly as it answers someone else\'s', async () => {
      world();
      const missing = await post(makeUser('admin'), { round_id: '00000000-0000-4000-8000-0000000000b9' });
      const theirs = await post(makeUser('admin'), { round_id: OTHER_ROUND_ID });
      expect(missing.status).toBe(theirs.status);
      expect(missing.body).toEqual(theirs.body);
    });

    it('checks who is asking before it looks at any round', async () => {
      world({}, OTHER_RECRUITER_ID);
      const res = await post(makeUser('interviewer'), ANCHOR);
      expect(res.status).toBe(403);
      expect(mockFrom).not.toHaveBeenCalledWith('interview_rounds');
      expect(inserted).toEqual([]);
    });

    it('keeps a viewer out', async () => {
      world();
      const res = await post(makeUser('viewer', { aal: 'aal1' }), ANCHOR);
      expect(res.status).toBe(403);
      expect(mockFrom).not.toHaveBeenCalled();
    });

    it.each(['interview_rounds', 'interview_round_attempts'])('fails, and writes nothing, when %s cannot be read', async (name) => {
      world({ [name]: () => table([], new Error('read failed')) });
      const res = await post(makeUser('admin'), ANCHOR);
      expect(res.status).toBe(500);
      expect(inserted).toEqual([]);
    });
  });

  describe('GET /api/notes', () => {
    it('hands back the moment with each note, and null on a note that has none', async () => {
      const selects: string[] = [];
      const notes = () => {
        const query = table([{ ...NOTE_ROW, candidate_id: CANDIDATE_ID, round_id: null, session_id: null, media_ms: null }]);
        const select = query.select;
        query.select = (columns: string) => { selects.push(columns); return select(); };
        return query;
      };
      world({ recruiter_notes: notes });
      const res = await request(makeApp(makeUser('admin'))).get(`/api/notes?candidate_id=${CANDIDATE_ID}`).set(AUTH);
      expect(res.status).toBe(200);
      expect(res.body.notes[0]).toMatchObject({ round_id: null, session_id: null, media_ms: null });
      expect(selects[0]).toMatch(/\bround_id\b.*\bsession_id\b.*\bmedia_ms\b/);
    });
  });

  describe('GET /api/notes/rounds/:roundId', () => {
    const OTHER_ROUND_NOTE = { ...NOTE_ROW, id: 'note-other-round', candidate_id: CANDIDATE_ID, round_id: OTHER_ROUND_ID };
    const CANDIDATE_NOTE = { ...NOTE_ROW, id: 'note-candidate', candidate_id: CANDIDATE_ID, round_id: null };
    const THIS_ROUND_NOTE = { ...NOTE_ROW, ...ANCHOR, candidate_id: CANDIDATE_ID };
    const stored = () => table([THIS_ROUND_NOTE, OTHER_ROUND_NOTE, CANDIDATE_NOTE]);
    const read = (user: AuthUser, id = ROUND_ID) => request(makeApp(user)).get(`/api/notes/rounds/${id}`).set(AUTH);

    it('401 without auth', async () => {
      expect((await request(makeApp(makeUser('admin'))).get(`/api/notes/rounds/${ROUND_ID}`)).status).toBe(401);
    });

    it('answers this round\'s notes and no others', async () => {
      world({ recruiter_notes: stored });
      const res = await read(makeUser('admin'));
      expect(res.status).toBe(200);
      expect(res.body.notes).toEqual([THIS_ROUND_NOTE]);
    });

    it('reads by the candidate as well as the round: the scope and the index in one', async () => {
      const eqs: Array<[string, unknown]> = [];
      const notes = () => {
        const query = stored();
        const eq = query.eq;
        query.eq = (column: string, value: unknown) => { eqs.push([column, value]); return eq(column, value); };
        return query;
      };
      world({ recruiter_notes: notes });
      await read(makeUser('admin'));
      expect(eqs).toEqual(expect.arrayContaining([['candidate_id', CANDIDATE_ID], ['round_id', ROUND_ID]]));
    });

    it('lets a viewer read', async () => {
      world({ recruiter_notes: stored });
      expect((await read(makeUser('viewer', { aal: 'aal1' }))).status).toBe(200);
    });

    it('lets the interviewer who owns the candidate read', async () => {
      world({ recruiter_notes: stored });
      expect((await read(makeUser('interviewer'))).status).toBe(200);
    });

    it('keeps out an interviewer who does not own the candidate', async () => {
      world({ recruiter_notes: stored }, OTHER_RECRUITER_ID);
      const res = await read(makeUser('interviewer'));
      expect(res.status).toBe(403);
      expect(mockFrom).not.toHaveBeenCalledWith('recruiter_notes');
    });

    it('tells an interviewer nothing about a round that does not exist', async () => {
      world({}, OTHER_RECRUITER_ID);
      const missing = await read(makeUser('interviewer'), '00000000-0000-4000-8000-0000000000b9');
      const theirs = await read(makeUser('interviewer'));
      expect(missing.status).toBe(403);
      expect(missing.body).toEqual(theirs.body);
    });

    it('says 404 to someone who sees every candidate', async () => {
      world();
      const res = await read(makeUser('admin'), '00000000-0000-4000-8000-0000000000b9');
      expect(res.status).toBe(404);
      expect(res.body.error).toBe('round_not_found');
    });

    it('400 for an id that is not one', async () => {
      world();
      expect((await read(makeUser('admin'), 'round-1')).status).toBe(400);
    });

    it('reads past the row cap: a long note list is never cut short', async () => {
      const rows = Array.from({ length: 1203 }, (_, index) => ({ ...THIS_ROUND_NOTE, id: `note-${index}` }));
      world({ recruiter_notes: () => table(rows) });
      const res = await read(makeUser('admin'));
      expect(res.status).toBe(200);
      expect(res.body.notes).toHaveLength(1203);
    });

    it('fails rather than answer part of the list', async () => {
      world({ recruiter_notes: () => table([], new Error('read failed')) });
      const res = await read(makeUser('admin'));
      expect(res.status).toBe(500);
      expect(res.body.notes).toBeUndefined();
    });

    it('fails when the round cannot be read, and never says it does not exist', async () => {
      world({ interview_rounds: () => table([], new Error('read failed')) });
      expect((await read(makeUser('admin'))).status).toBe(500);
    });

    it('is never cached', async () => {
      world({ recruiter_notes: stored });
      expect((await read(makeUser('admin'))).headers['cache-control']).toBe('no-store');
    });
  });
});

describe('POST /api/notes/:candidateId/status', () => {
  const CANDIDATE_ROW = (status: string, blocked: string | null) => ({
    data: { owner_id: RECRUITER_ID, status, decision_use_blocked_at: blocked },
    error: null,
  });

  it('legal transition screened → advanced → 200 + audit row', async () => {
    mockFrom
      .mockReturnValueOnce(chainable(CANDIDATE_ROW('screened', null)))
      .mockReturnValueOnce(chainable({ data: [{ id: CANDIDATE_ID }], error: null }))
      .mockReturnValueOnce(chainable({ data: null, error: null }));
    const res = await request(makeApp(makeUser('interviewer')))
      .post(`/api/notes/${CANDIDATE_ID}/status`)
      .set(AUTH)
      .send({ status: 'advanced' });
    expect(res.status).toBe(200);
    expect(res.body).toEqual({ ok: true, from: 'screened', to: 'advanced' });
    expect(mockFrom).toHaveBeenCalledWith('audit_events');
    const auditPayload = inserted.find((a) =>
      JSON.stringify(a).includes('candidate_status_changed'),
    );
    expect(auditPayload).toBeTruthy();
    expect(JSON.stringify(auditPayload)).toContain('screened');
    expect(JSON.stringify(auditPayload)).toContain('advanced');
  });

  it('illegal transition new → rejected rejected (400)', async () => {
    mockFrom.mockReturnValueOnce(chainable(CANDIDATE_ROW('new', null)));
    const res = await request(makeApp(makeUser('interviewer')))
      .post(`/api/notes/${CANDIDATE_ID}/status`)
      .set(AUTH)
      .send({ status: 'rejected' });
    expect(res.status).toBe(400);
    expect(res.body.error).toBe('invalid_status_transition');
    expect(mockFrom).not.toHaveBeenCalledWith('audit_events');
  });

  it('unknown/unknown statuses fail closed — consent_declined is terminal', async () => {
    mockFrom.mockReturnValueOnce(chainable(CANDIDATE_ROW('consent_declined', null)));
    const res = await request(makeApp(makeUser('interviewer')))
      .post(`/api/notes/${CANDIDATE_ID}/status`)
      .set(AUTH)
      .send({ status: 'screened' });
    expect(res.status).toBe(400);
    expect(res.body.error).toBe('invalid_status_transition');
  });

  it('fail closed while decision_use_blocked_at is set (409)', async () => {
    mockFrom.mockReturnValueOnce(chainable(CANDIDATE_ROW('screened', '2025-02-01T00:00:00.000Z')));
    const res = await request(makeApp(makeUser('interviewer')))
      .post(`/api/notes/${CANDIDATE_ID}/status`)
      .set(AUTH)
      .send({ status: 'advanced' });
    expect(res.status).toBe(409);
    expect(res.body.error).toBe('decision_use_blocked');
    expect(mockFrom).not.toHaveBeenCalledWith('audit_events');
  });

  it('CAS conflict (0 rows updated) → 409 status_conflict', async () => {
    mockFrom
      .mockReturnValueOnce(chainable(CANDIDATE_ROW('screened', null)))
      .mockReturnValueOnce(chainable({ data: [], error: null }));
    const res = await request(makeApp(makeUser('interviewer')))
      .post(`/api/notes/${CANDIDATE_ID}/status`)
      .set(AUTH)
      .send({ status: 'advanced' });
    expect(res.status).toBe(409);
    expect(res.body.error).toBe('status_conflict');
  });

  it('non-owner interviewer denied (403)', async () => {
    mockFrom.mockReturnValueOnce(
      chainable({ data: { owner_id: OTHER_RECRUITER_ID, status: 'screened', decision_use_blocked_at: null }, error: null }),
    );
    const res = await request(makeApp(makeUser('interviewer')))
      .post(`/api/notes/${CANDIDATE_ID}/status`)
      .set(AUTH)
      .send({ status: 'advanced' });
    expect(res.status).toBe(403);
  });

  it('unknown status target rejected by schema (400)', async () => {
    const res = await request(makeApp(makeUser('interviewer')))
      .post(`/api/notes/${CANDIDATE_ID}/status`)
      .set(AUTH)
      .send({ status: 'hired' });
    expect(res.status).toBe(400);
  });

  it('400 non-UUID path param', async () => {
    const res = await request(makeApp(makeUser('interviewer')))
      .post('/api/notes/not-a-uuid/status')
      .set(AUTH)
      .send({ status: 'advanced' });
    expect(res.status).toBe(400);
  });
});
