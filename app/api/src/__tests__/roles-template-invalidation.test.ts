/**
 * PUT /api/roles/:id — editing the template retires the candidate sets built
 * around it.
 *
 * A per-candidate set (`0103`) is the recruiter's template with the two
 * résumé-driven compartments rewritten, so it EMBEDS the fixed questions as
 * they stood when it was built. Leaving it in place after an edit keeps
 * calling candidates with the wording the recruiter just changed, invisibly,
 * for everyone already in the queue.
 *
 * WHY THIS FILE EXISTS RATHER THAN AN ASSERTION ADDED ELSEWHERE. The
 * invalidation is deliberately wrapped in `try/catch` — a stale candidate set
 * must never fail a save the operator just made. That swallow also swallows
 * PGRST205, so a misspelled table name here would be COMPLETELY SILENT: the
 * save would succeed, the tests would pass, and every candidate in the queue
 * would keep the old questions for ever. This repository has already shipped
 * a route asking for a table called `sessions` that has never existed.
 *
 * So the mock refuses an unknown relation AND the test asserts the call was
 * actually made. Either half alone proves nothing.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import request from 'supertest';
import express from 'express';
import { createRequireAuth, mockAuthGetUser, type AuthUser } from '../lib/auth.js';
import { finalErrorHandler } from '../lib/validation.js';

vi.mock('../lib/supabase.js', () => ({
  supabase: { from: vi.fn(), rpc: vi.fn() },
  RESUME_BUCKET: 'resumes_v2',
}));
vi.mock('../lib/audit.js', () => ({ recordAudit: vi.fn().mockResolvedValue(undefined) }));

const { rolesRouter } = await import('../routes/roles.js');
const { supabase } = await import('../lib/supabase.js');

const JWT = 'eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiJ1c2VyLTAwMSIsImFhbCI6ImFhbDIifQ.signature';
const AUTH = { Authorization: `Bearer ${JWT}` };
const ROLE = '11111111-1111-4111-8111-111111111111';
const OWNER = '00000000-0000-4000-8000-0000000000ff';

/** Every relation this route is allowed to touch. */
const KNOWN_TABLES = ['roles', 'candidate_screening_questions'];

interface Call {
  table: string;
  op: 'select' | 'update' | 'delete';
  filters: Array<[string, unknown]>;
  negations: Array<[string, unknown]>;
}
let calls: Call[];

const TEMPLATE = [
  { id: 'q1', question: 'Tell me about yourself?', weight: 1, category: 'introduction' },
  { id: 'q2', question: 'What does your day look like?', weight: 1, category: 'profile_relevance' },
];

// eslint-disable-next-line @typescript-eslint/no-explicit-any
function chain(table: string): any {
  if (!KNOWN_TABLES.includes(table)) {
    throw new Error(
      `PGRST205: relation "screening_v2.${table}" does not exist — ` +
        'the route asked for a table this schema has never had',
    );
  }
  const call: Call = { table, op: 'select', filters: [], negations: [] };
  calls.push(call);
  const row = { id: ROLE, title: 'Inside Sales Advisor', screening_template: TEMPLATE };
  const api = {
    update: () => { call.op = 'update'; return api; },
    delete: () => { call.op = 'delete'; return api; },
    select: () => api,
    eq: (c: string, v: unknown) => { call.filters.push([c, v]); return api; },
    neq: (c: string, v: unknown) => { call.negations.push([c, v]); return api; },
    single: () => Promise.resolve({ data: row, error: null }),
    then: (resolve: (r: { error: null }) => void) => resolve({ error: null }),
  };
  return api;
}

function app() {
  // `admin`, so the update is not additionally owner-scoped — this file is
  // about the invalidation, and ownership is covered by the delete-route tests.
  const user: AuthUser = {
    id: OWNER, email: 'r@example.com', aal: 'aal2', active: true,
    appRole: 'admin', orgId: null,
  };
  const a = express();
  a.use(express.json());
  a.use(createRequireAuth({ getUser: mockAuthGetUser(user, JWT) }));
  a.use('/api/roles', rolesRouter);
  a.use(finalErrorHandler);
  return a;
}

beforeEach(() => {
  calls = [];
  (supabase.from as ReturnType<typeof vi.fn>).mockImplementation(chain);
});

describe('editing a role template', () => {
  it('RETIRES the candidate sets that no longer match it', async () => {
    const res = await request(app())
      .put(`/api/roles/${ROLE}`)
      .set(AUTH)
      .send({ screening_template: TEMPLATE });

    expect(res.status).toBe(200);
    const purge = calls.find((c) => c.table === 'candidate_screening_questions');
    expect(purge, 'the route never touched candidate_screening_questions').toBeDefined();
    expect(purge?.op).toBe('delete');
    // SCOPED TO THIS ROLE, and to sets built around a DIFFERENT template — so
    // a set that already matches the saved template survives, and no other
    // role's candidates are touched.
    expect(purge?.filters).toEqual([['role_id', ROLE]]);
    expect(purge?.negations).toHaveLength(1);
    expect(purge?.negations[0][0]).toBe('template_hash');
    expect(typeof purge?.negations[0][1]).toBe('string');
    expect(purge?.negations[0][1] as string).toMatch(/^fnv1a32:[0-9a-f]{8}:2$/);
  });

  it('LEAVES THEM ALONE when the edit did not touch the template', async () => {
    // Renaming a role or fixing a typo in its JD must not throw away a
    // provider call per candidate.
    const res = await request(app())
      .put(`/api/roles/${ROLE}`)
      .set(AUTH)
      .send({ title: 'Senior Inside Sales Advisor' });

    expect(res.status).toBe(200);
    expect(calls.some((c) => c.table === 'candidate_screening_questions')).toBe(false);
  });

  it('still saves when the purge itself fails', async () => {
    // A stale candidate set is not worth failing a save over: the row it would
    // have deleted is replaced on its own fingerprint check at regeneration.
    (supabase.from as ReturnType<typeof vi.fn>).mockImplementation((table: string) => {
      if (table === 'candidate_screening_questions') throw new Error('database is down');
      return chain(table);
    });
    const res = await request(app())
      .put(`/api/roles/${ROLE}`)
      .set(AUTH)
      .send({ screening_template: TEMPLATE });
    expect(res.status).toBe(200);
  });
});
