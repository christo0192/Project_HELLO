/**
 * Ashby candidate-scoped review reads — /api/integrations/ashby/review/:id.
 *
 * Proves the security posture the scoped experience depends on:
 *   - the candidate/session are resolved SERVER-SIDE from the opaque link;
 *   - the existing interviewer ownership rule is re-applied (the link grants no
 *     new privilege) and an unowned link is INDISTINGUISHABLE from an unknown
 *     one — identical 404 status and body;
 *   - malformed ids are rejected before any database read;
 *   - unauthenticated callers get the middleware 401 contract;
 *   - only reads exist — no mutation, no token, no Ashby call.
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import request from 'supertest';
import express from 'express';
import { createRequireAuth, mockAuthGetUser, type AuthUser } from '../lib/auth.js';
import { ashbyReviewRouter } from '../routes/ashby-review.js';
import { finalErrorHandler } from '../lib/validation.js';

vi.mock('../lib/supabase.js', () => ({
  supabase: { from: vi.fn(), rpc: vi.fn() },
  RESUME_BUCKET: 'resumes_v2',
}));

const JWT = 'eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiJ1c2VyLTAwMSIsImFhbCI6ImFhbDIifQ.signature';
const AUTH = { Authorization: `Bearer ${JWT}` };

const RECRUITER_ID = '00000000-0000-4000-8000-0000000000ff';
const OTHER_RECRUITER_ID = '00000000-0000-4000-8000-0000000000ee';
const LINK_ID = '11111111-1111-4111-8111-111111111111';
const UNKNOWN_LINK_ID = '22222222-2222-4222-8222-222222222222';
const CANDIDATE_ID = '00000000-0000-4000-8000-000000000001';
const SESSION_ID = '00000000-0000-4000-8000-000000000002';

/** A thenable Supabase query-builder stub whose terminal value is fixed. */
function chainable(value: unknown): any {
  const fn: any = function () { return chainable(value); };
  fn.then = (resolve: (v: any) => any) => Promise.resolve(value).then(resolve);
  fn.catch = (reject: (e: unknown) => unknown) => Promise.resolve(value).catch(reject);
  for (const m of ['eq', 'order', 'limit', 'select', 'is', 'in']) fn[m] = () => chainable(value);
  fn.maybeSingle = () => chainable(value);
  fn.single = () => chainable(value);
  return fn;
}

let mockFrom: any;

/**
 * Table-driven Supabase fake. `ownerId` decides who owns the candidate; the
 * candidates lookup applies the interviewer `.eq('owner_id', …)` filter the
 * route relies on, so ownership denial is exercised the way production does it.
 */
function wireSupabase(opts: {
  link?: { candidate_id: string | null } | null;
  ownerId?: string;
  notes?: unknown[];
} = {}) {
  const link = opts.link === undefined ? { candidate_id: CANDIDATE_ID } : opts.link;
  const ownerId = opts.ownerId ?? RECRUITER_ID;
  const notes = opts.notes ?? [
    { id: 'n1', candidate_id: CANDIDATE_ID, author_id: RECRUITER_ID, note: 'looks strong', created_at: '2026-08-01T00:00:00Z' },
  ];

  mockFrom.mockImplementation((table: string) => {
    if (table === 'ashby_application_links') return chainable({ data: link, error: null });
    if (table === 'candidates') {
      // Emulate the owner filter: an interviewer who is not the owner matches
      // no row, exactly like the real query.
      const builder: any = {
        _ownerFiltered: false,
        select() { return this; },
        eq(column: string, value: unknown) {
          if (column === 'owner_id' && value !== ownerId) this._ownerFiltered = true;
          return this;
        },
        maybeSingle() {
          return Promise.resolve({ data: this._ownerFiltered ? null : { id: CANDIDATE_ID }, error: null });
        },
        single() {
          return Promise.resolve(
            this._ownerFiltered
              ? { data: null, error: { message: 'not found' } }
              : {
                  data: {
                    id: CANDIDATE_ID, name: 'Test Candidate', email: 'c@example.com',
                    owner_id: ownerId, status: 'screened', skills: [], phone_e164: null,
                    phone_valid: false, experience_years: 3, decision_use_blocked_at: null,
                  },
                  error: null,
                },
          );
        },
      };
      return builder;
    }
    if (table === 'call_sessions') {
      return chainable({ data: [{ id: SESSION_ID, candidate_id: CANDIDATE_ID, status: 'completed' }], error: null });
    }
    if (table === 'assessments') {
      return chainable({ data: [{ id: 'a1', candidate_id: CANDIDATE_ID, overall_score: 80 }], error: null });
    }
    if (table === 'recruiter_notes') return chainable({ data: notes, error: null });
    throw new Error(`unexpected table ${table}`);
  });
}

function makeUser(appRole: AuthUser['appRole'], id = RECRUITER_ID): AuthUser {
  return { id, email: 'recruiter@example.com', aal: 'aal2', active: true, appRole, orgId: null };
}

function makeApp(user: AuthUser | null) {
  const app = express();
  app.use(express.json());
  if (user) app.use(createRequireAuth({ getUser: mockAuthGetUser(user, JWT) }));
  app.use('/api/integrations/ashby/review', ashbyReviewRouter);
  app.use(finalErrorHandler);
  return app;
}

beforeEach(async () => {
  const mod = await import('../lib/supabase.js');
  mockFrom = (mod.supabase as any).from;
  mockFrom.mockReset();
  wireSupabase();
});

afterEach(() => vi.restoreAllMocks());

describe('GET /api/integrations/ashby/review/:applicationLinkId', () => {
  it('returns the linked candidate Overview + Review payload for the owner', async () => {
    const res = await request(makeApp(makeUser('interviewer'))).get(`/api/integrations/ashby/review/${LINK_ID}`).set(AUTH);
    expect(res.status).toBe(200);
    expect(res.body.candidate.id).toBe(CANDIDATE_ID);
    expect(res.body.sessions).toHaveLength(1);
    expect(res.body.assessments).toHaveLength(1);
  });

  it('serves admin and viewer (existing role model, unchanged)', async () => {
    for (const role of ['admin', 'viewer'] as const) {
      const res = await request(makeApp(makeUser(role))).get(`/api/integrations/ashby/review/${LINK_ID}`).set(AUTH);
      expect(res.status, role).toBe(200);
    }
  });

  it('never accepts a candidate id in place of the link id (link lookup is authoritative)', async () => {
    wireSupabase({ link: null });
    const res = await request(makeApp(makeUser('admin'))).get(`/api/integrations/ashby/review/${CANDIDATE_ID}`).set(AUTH);
    expect(res.status).toBe(404);
  });

  it('401s without a bearer token', async () => {
    const res = await request(makeApp(makeUser('admin'))).get(`/api/integrations/ashby/review/${LINK_ID}`);
    expect(res.status).toBe(401);
    expect(res.body.error.type).toBe('authentication_error');
  });

  it('403s a caller with no resolved role', async () => {
    const app = express();
    app.use(express.json());
    app.use('/api/integrations/ashby/review', ashbyReviewRouter);
    app.use(finalErrorHandler);
    const res = await request(app).get(`/api/integrations/ashby/review/${LINK_ID}`);
    expect(res.status).toBe(403);
  });
});

describe('indistinguishable failures', () => {
  it('unknown, unlinked, unowned and malformed all return the identical 404 body', async () => {
    const bodies: unknown[] = [];

    wireSupabase({ link: null }); // unknown link
    const unknown = await request(makeApp(makeUser('admin'))).get(`/api/integrations/ashby/review/${UNKNOWN_LINK_ID}`).set(AUTH);
    bodies.push(unknown.body);

    wireSupabase({ link: { candidate_id: null } }); // link exists, no candidate yet
    const unlinked = await request(makeApp(makeUser('admin'))).get(`/api/integrations/ashby/review/${LINK_ID}`).set(AUTH);
    bodies.push(unlinked.body);

    wireSupabase({ ownerId: OTHER_RECRUITER_ID }); // owned by someone else
    const unowned = await request(makeApp(makeUser('interviewer'))).get(`/api/integrations/ashby/review/${LINK_ID}`).set(AUTH);
    bodies.push(unowned.body);

    wireSupabase();
    const malformed = await request(makeApp(makeUser('admin'))).get('/api/integrations/ashby/review/not-a-uuid').set(AUTH);
    bodies.push(malformed.body);

    for (const res of [unknown, unlinked, unowned, malformed]) expect(res.status).toBe(404);
    expect(bodies.every((b) => JSON.stringify(b) === JSON.stringify(bodies[0]))).toBe(true);
    // The 404 body carries no candidate identifier or PII.
    expect(JSON.stringify(bodies[0])).not.toMatch(/email|phone|name|candidate_id|token/i);
  });

  it('rejects a malformed id before touching the database', async () => {
    wireSupabase();
    const res = await request(makeApp(makeUser('admin'))).get('/api/integrations/ashby/review/..%2Fadmin').set(AUTH);
    expect(res.status).toBe(404);
    expect(mockFrom).not.toHaveBeenCalled();
  });

  it('an interviewer who does not own the candidate is denied like a stranger', async () => {
    wireSupabase({ ownerId: OTHER_RECRUITER_ID });
    const res = await request(makeApp(makeUser('interviewer'))).get(`/api/integrations/ashby/review/${LINK_ID}`).set(AUTH);
    expect(res.status).toBe(404);
    expect(JSON.stringify(res.body)).not.toContain(CANDIDATE_ID);
  });
});

describe('GET …/:applicationLinkId/notes', () => {
  it('returns the linked candidate notes for the owner', async () => {
    const res = await request(makeApp(makeUser('interviewer'))).get(`/api/integrations/ashby/review/${LINK_ID}/notes`).set(AUTH);
    expect(res.status).toBe(200);
    expect(res.body.notes).toHaveLength(1);
  });

  it('applies the same ownership denial and the same 404', async () => {
    wireSupabase({ ownerId: OTHER_RECRUITER_ID });
    const res = await request(makeApp(makeUser('interviewer'))).get(`/api/integrations/ashby/review/${LINK_ID}/notes`).set(AUTH);
    expect(res.status).toBe(404);
    expect(res.body).toEqual({ error: 'application_link_not_found' });
  });

  it('exposes no write surface on the scoped prefix', async () => {
    const app = makeApp(makeUser('admin'));
    for (const call of [
      request(app).post(`/api/integrations/ashby/review/${LINK_ID}`).set(AUTH).send({}),
      request(app).post(`/api/integrations/ashby/review/${LINK_ID}/notes`).set(AUTH).send({ note: 'x' }),
      request(app).patch(`/api/integrations/ashby/review/${LINK_ID}`).set(AUTH).send({}),
    ]) {
      const res = await call;
      expect(res.status).toBe(404);
    }
  });
});

describe('database failures are distinguishable from denial', () => {
  /** Fail one table's read with a PostgREST/transport error, keep the rest. */
  function failTable(table: string) {
    const base = mockFrom.getMockImplementation();
    mockFrom.mockImplementation((t: string) => {
      if (t === table) return chainable({ data: null, error: { message: 'connection reset', code: '57P01' } });
      return base(t);
    });
  }

  it('answers a sanitized 500 — not the 404 — when the link lookup fails', async () => {
    failTable('ashby_application_links');
    const res = await request(makeApp(makeUser('interviewer'))).get(`/api/integrations/ashby/review/${LINK_ID}`).set(AUTH);
    expect(res.status).toBe(500);
    // Sanitized: the generic internal_error envelope, nothing about the link,
    // the candidate, the driver error or the SQL state.
    expect(res.body).toEqual({ error: { type: 'internal_error', message: 'Internal server error' } });
    const body = JSON.stringify(res.body);
    expect(body).not.toContain(CANDIDATE_ID);
    expect(body).not.toContain(LINK_ID);
    expect(body).not.toMatch(/connection reset|57P01|ashby_application_links/);
  });

  it('answers a sanitized 500 when the ownership lookup fails', async () => {
    failTable('candidates');
    const res = await request(makeApp(makeUser('interviewer'))).get(`/api/integrations/ashby/review/${LINK_ID}`).set(AUTH);
    expect(res.status).toBe(500);
    expect(res.body).toEqual({ error: { type: 'internal_error', message: 'Internal server error' } });
  });

  it('applies the same distinction on the notes route', async () => {
    failTable('ashby_application_links');
    const res = await request(makeApp(makeUser('interviewer'))).get(`/api/integrations/ashby/review/${LINK_ID}/notes`).set(AUTH);
    expect(res.status).toBe(500);
    expect(res.body).toEqual({ error: { type: 'internal_error', message: 'Internal server error' } });
  });

  it('a 500 is uncorrelated with existence: unknown and unowned links fail identically', async () => {
    failTable('ashby_application_links');
    const unknown = await request(makeApp(makeUser('interviewer'))).get(`/api/integrations/ashby/review/${UNKNOWN_LINK_ID}`).set(AUTH);
    expect(unknown.status).toBe(500);

    wireSupabase({ ownerId: OTHER_RECRUITER_ID });
    failTable('ashby_application_links');
    const unowned = await request(makeApp(makeUser('interviewer'))).get(`/api/integrations/ashby/review/${LINK_ID}`).set(AUTH);
    expect(unowned.status).toBe(500);
    expect(unowned.body).toEqual(unknown.body);
  });

  it('still returns the uniform 404 when the link simply does not exist', async () => {
    wireSupabase({ link: null });
    const res = await request(makeApp(makeUser('interviewer'))).get(`/api/integrations/ashby/review/${UNKNOWN_LINK_ID}`).set(AUTH);
    expect(res.status).toBe(404);
    expect(res.body).toEqual({ error: 'application_link_not_found' });
  });
});
