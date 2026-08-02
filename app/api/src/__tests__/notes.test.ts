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
