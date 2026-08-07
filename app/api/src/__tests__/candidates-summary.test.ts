/**
 * GET /api/candidates/summary + list enrichment.
 *
 * Verifies the aggregate assessment metrics contract (average score,
 * deterministic recommendation distribution, nullable average), decision-use
 * suppression, interviewer owner-scoping, and the per-candidate latest
 * recommendation/score enrichment that powers the dashboard drill-downs.
 *
 * Supabase is mocked with a capturing chain so `.in`/`.eq` scoping can be
 * asserted (the DB itself is exercised by supabase-ci, not here).
 */
import { describe, it, expect, beforeEach, vi } from 'vitest';
import request from 'supertest';
import { createApp } from '../app.js';
import { mockAuthGetUser, type AuthUser } from '../lib/auth.js';

const JWT = 'eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiJ1c2VyLTAwMSIsImFhbCI6ImFhbDIifQ.signature';
const AUTH = 'Bearer ' + JWT;

const admin: AuthUser = {
  id: 'user-admin-0000-0000-000000000001',
  email: 'admin@example.com',
  aal: 'aal2',
  active: true,
  appRole: 'admin',
  orgId: 'org-0000-0000-0000-000000000001',
};
const interviewer: AuthUser = { ...admin, id: 'user-int-0000-0000-000000000002', appRole: 'interviewer' };

// ── Capturing Supabase mock ──────────────────────────────────────────
const mockFrom = vi.fn();
const eqCalls: Array<{ table: string; column: string; value: unknown }> = [];
const inCalls: Array<{ table: string; column: string; values: unknown }> = [];

vi.mock('../lib/supabase.js', () => ({
  supabase: { from: (...a: unknown[]) => mockFrom(...a) },
  RESUME_BUCKET: 'resumes_v2',
}));

function chain(table: string, value: unknown): Record<string, unknown> {
  const c: Record<string, unknown> = {};
  const methods = ['select', 'insert', 'update', 'upsert', 'delete', 'neq', 'gt', 'gte', 'lt', 'lte', 'is', 'not', 'order', 'limit', 'range', 'single', 'maybeSingle'];
  for (const m of methods) c[m] = () => chain(table, value);
  c.eq = (column: string, v: unknown) => { eqCalls.push({ table, column, value: v }); return chain(table, value); };
  c.in = (column: string, values: unknown) => { inCalls.push({ table, column, values }); return chain(table, value); };
  c.then = (resolve: (v: unknown) => unknown) => Promise.resolve(value).then(resolve);
  c.catch = (reject: (e: unknown) => unknown) => Promise.resolve(value).catch(reject);
  return c;
}

function configure(config: Record<string, unknown>): void {
  mockFrom.mockImplementation((table: string) =>
    chain(table, config[table] ?? { data: null, error: null }),
  );
}

function appFor(user: AuthUser) {
  return createApp({
    nodeEnv: 'test',
    webOrigin: 'http://localhost:5173',
    authDeps: { getUser: mockAuthGetUser(user, JWT) },
    auditSinkOverride: async () => {},
  });
}

const ok = (data: unknown) => ({ data, error: null });

beforeEach(() => {
  vi.clearAllMocks();
  eqCalls.length = 0;
  inCalls.length = 0;
});

describe('GET /api/candidates/summary', () => {
  it('computes average score + deterministic recommendation distribution', async () => {
    configure({
      candidates: ok([
        { id: 'c1', decision_use_blocked_at: null },
        { id: 'c2', decision_use_blocked_at: null },
      ]),
      assessments: ok([
        { candidate_id: 'c1', overall_score: 80, recommendation: 'advance', created_at: '2026-02-01T00:00:00Z' },
        { candidate_id: 'c1', overall_score: 10, recommendation: 'reject', created_at: '2026-01-01T00:00:00Z' }, // older → ignored
        { candidate_id: 'c2', overall_score: 40, recommendation: 'reject', created_at: '2026-02-01T00:00:00Z' },
      ]),
    });
    const res = await request(appFor(admin)).get('/api/candidates/summary').set('Authorization', AUTH);
    expect(res.status).toBe(200);
    expect(res.body).toEqual({
      assessed_count: 2,
      average_score: 60, // (80 + 40) / 2
      recommendation_distribution: { advance: 1, hold: 0, reject: 1 },
    });
  });

  it('returns a null average and zeroed distribution when nothing is assessed', async () => {
    configure({
      candidates: ok([{ id: 'c1', decision_use_blocked_at: null }]),
      assessments: ok([]),
    });
    const res = await request(appFor(admin)).get('/api/candidates/summary').set('Authorization', AUTH);
    expect(res.status).toBe(200);
    expect(res.body.average_score).toBeNull();
    expect(res.body.assessed_count).toBe(0);
    expect(res.body.recommendation_distribution).toEqual({ advance: 0, hold: 0, reject: 0 });
  });

  it('excludes decision-use-blocked candidates from the aggregate (suppression)', async () => {
    configure({
      candidates: ok([
        { id: 'c1', decision_use_blocked_at: null },
        { id: 'cB', decision_use_blocked_at: '2026-01-02T00:00:00Z' },
      ]),
      // The DB would return only eligible rows; the handler must never ask for cB.
      assessments: ok([
        { candidate_id: 'c1', overall_score: 70, recommendation: 'hold', created_at: '2026-02-01T00:00:00Z' },
      ]),
    });
    const res = await request(appFor(admin)).get('/api/candidates/summary').set('Authorization', AUTH);
    expect(res.status).toBe(200);
    expect(res.body.assessed_count).toBe(1);
    expect(res.body.recommendation_distribution).toEqual({ advance: 0, hold: 1, reject: 0 });
    const assessmentIn = inCalls.find((c) => c.table === 'assessments');
    expect(assessmentIn?.values).toEqual(['c1']); // blocked cB never queried
  });

  it('scopes to owned candidates for interviewers', async () => {
    configure({ candidates: ok([]), assessments: ok([]) });
    await request(appFor(interviewer)).get('/api/candidates/summary').set('Authorization', AUTH);
    expect(
      eqCalls.some((c) => c.table === 'candidates' && c.column === 'owner_id' && c.value === interviewer.id),
    ).toBe(true);
  });
});

describe('GET /api/candidates (enrichment + suppression)', () => {
  it('attaches the latest recommendation + score per candidate', async () => {
    configure({
      candidates: ok([
        { id: 'c1', name: 'A', email: null, phone_e164: null, phone_valid: false, skills: [], experience_years: null, status: 'screened', role_id: null, created_at: '2026-02-01T00:00:00Z', decision_use_blocked_at: null },
      ]),
      assessments: ok([
        { candidate_id: 'c1', overall_score: 82, recommendation: 'advance', created_at: '2026-02-02T00:00:00Z' },
      ]),
    });
    const res = await request(appFor(admin)).get('/api/candidates').set('Authorization', AUTH);
    expect(res.status).toBe(200);
    expect(res.body[0].latest_recommendation).toBe('advance');
    expect(res.body[0].latest_score).toBe(82);
    // Internal block field is not leaked in the list output.
    expect(res.body[0]).not.toHaveProperty('decision_use_blocked_at');
  });

  it('suppresses the recommendation/score for decision-use-blocked candidates', async () => {
    configure({
      candidates: ok([
        { id: 'cB', name: 'B', email: null, phone_e164: null, phone_valid: false, skills: [], experience_years: null, status: 'screened', role_id: null, created_at: '2026-02-01T00:00:00Z', decision_use_blocked_at: '2026-02-03T00:00:00Z' },
      ]),
      assessments: ok([
        { candidate_id: 'cB', overall_score: 90, recommendation: 'advance', created_at: '2026-02-02T00:00:00Z' },
      ]),
    });
    const res = await request(appFor(admin)).get('/api/candidates').set('Authorization', AUTH);
    expect(res.status).toBe(200);
    expect(res.body[0].latest_recommendation).toBeNull();
    expect(res.body[0].latest_score).toBeNull();
  });
});
