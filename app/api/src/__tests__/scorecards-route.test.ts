/**
 * Phase 2 — /api/scorecards HTTP API.
 *
 * Covers the global metric LIBRARY (admin-only CRUD + admin gate) and each
 * ROLE's scorecard (active-version GET, immutable new-version PUT with the
 * weight-redistribution math, owner RBAC) plus the redistribute preview.
 *
 * The Supabase service-role client and the auth token verifier are mocked; no
 * network or real database is touched. The DB CHECK/trigger invariants live in
 * migration 0088 and are exercised there — here we assert the route's own
 * ordering, RBAC, domain delegation, and error mapping.
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import request from 'supertest';
import express from 'express';
import { createRequireAuth, mockAuthGetUser, type AuthUser } from '../lib/auth.js';
import { viewerReadOnly } from '../lib/rbac.js';
import { scorecardsRouter } from '../routes/scorecards.js';
import { finalErrorHandler } from '../lib/validation.js';
import { setAuditSink } from '../lib/audit.js';
import { redistributeWeights } from '../lib/scorecards/domain.js';

vi.mock('../lib/supabase.js', () => ({
  supabase: { from: vi.fn(), rpc: vi.fn() },
  RESUME_BUCKET: 'resumes_v2',
}));

const JWT_AAL2 = 'eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiJ1c2VyLTAwMSIsImFhbCI6ImFhbDIifQ.signature';
const OWNER_ID = '00000000-0000-4000-8000-0000000000ff';
const OTHER_ID = '00000000-0000-4000-8000-0000000000ee';
const ROLE_ID = '00000000-0000-4000-8000-000000000010';
const VERSION_ID = '00000000-0000-4000-8000-000000000020';
const LIB_A = '00000000-0000-4000-8000-0000000000a1';
const LIB_B = '00000000-0000-4000-8000-0000000000a2';
const METRIC_ID = '00000000-0000-4000-8000-0000000000b1';
const HASH = 'a'.repeat(64);

const RUBRIC = {
  '1': 'No relevant evidence.',
  '2': 'Limited evidence.',
  '3': 'Adequate evidence.',
  '4': 'Strong evidence.',
  '5': 'Exceptional evidence.',
};

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
  return fn;
}

function makeUser(role: AuthUser['appRole'], overrides: Partial<AuthUser> = {}): AuthUser {
  return {
    id: OWNER_ID,
    email: 'user@example.com',
    aal: 'aal2',
    active: true,
    appRole: role,
    orgId: null,
    ...overrides,
  };
}

let mockFrom: any;
let auditSpy: any;

beforeEach(async () => {
  const mod = await import('../lib/supabase.js');
  mockFrom = (mod.supabase as any).from;
  mockFrom.mockReset();
  inserted = [];
  updated = [];
  auditSpy = vi.fn(async () => {});
  setAuditSink(auditSpy);
});

afterEach(() => {
  vi.restoreAllMocks();
});

function makeApp(user: AuthUser) {
  const app = express();
  app.use(express.json());
  app.use(createRequireAuth({ getUser: mockAuthGetUser(user, JWT_AAL2) }));
  app.use(viewerReadOnly);
  app.use('/api/scorecards', scorecardsRouter);
  app.use(finalErrorHandler);
  return app;
}

const AUTH = { Authorization: `Bearer ${JWT_AAL2}` };

const LIB_ROW = (id: string, key: string, overrides: Record<string, unknown> = {}) => ({
  id,
  key,
  name: key.replace(/_/g, ' '),
  description: null,
  default_instruction: `Assess ${key}. Do not infer missing evidence.`,
  rubric: RUBRIC,
  archived_at: null,
  version: 1,
  ...overrides,
});

// ═══════════════════════════════════════════════════════════════════════
// Metric library — admin gate + CRUD
// ═══════════════════════════════════════════════════════════════════════

describe('metric library — admin gate', () => {
  it('401 without auth', async () => {
    const res = await request(makeApp(makeUser('admin'))).get('/api/scorecards/metrics');
    expect(res.status).toBe(401);
  });

  it('viewer cannot list the library (admin-only) → 403', async () => {
    const res = await request(makeApp(makeUser('viewer', { aal: 'aal1' })))
      .get('/api/scorecards/metrics')
      .set(AUTH);
    expect(res.status).toBe(403);
    expect(mockFrom).not.toHaveBeenCalled();
  });

  it('interviewer cannot create a metric (admin-only) → 403', async () => {
    const res = await request(makeApp(makeUser('interviewer')))
      .post('/api/scorecards/metrics')
      .set(AUTH)
      .send({ name: 'Ownership', default_instruction: 'Assess ownership.', rubric: RUBRIC });
    expect(res.status).toBe(403);
    expect(mockFrom).not.toHaveBeenCalled();
  });
});

describe('GET /api/scorecards/metrics', () => {
  it('admin lists non-archived metrics', async () => {
    mockFrom.mockReturnValueOnce(chainable({ data: [LIB_ROW(LIB_A, 'communication')], error: null }));
    const res = await request(makeApp(makeUser('admin'))).get('/api/scorecards/metrics').set(AUTH);
    expect(res.status).toBe(200);
    expect(res.body).toHaveLength(1);
    expect(res.body[0].key).toBe('communication');
    expect(mockFrom).toHaveBeenCalledWith('scorecard_metric_library');
  });
});

describe('POST /api/scorecards/metrics', () => {
  it('admin creates a metric; key derived from name; audited → 201', async () => {
    const created = LIB_ROW(METRIC_ID, 'night_shift_fit', { name: 'Night shift fit' });
    mockFrom.mockReturnValueOnce(chainable({ data: created, error: null }));
    const res = await request(makeApp(makeUser('admin')))
      .post('/api/scorecards/metrics')
      .set(AUTH)
      .send({ name: 'Night shift fit', default_instruction: 'Assess availability for nights.', rubric: RUBRIC });
    expect(res.status).toBe(201);
    expect(res.body.id).toBe(METRIC_ID);
    // key was derived from the name and passed to insert
    const insertPayload = inserted[0][0];
    expect(insertPayload.key).toBe('night_shift_fit');
    expect(insertPayload.version).toBe(1);
    expect(auditSpy).toHaveBeenCalledTimes(1);
  });

  it('duplicate key → 409 conflict', async () => {
    mockFrom.mockReturnValueOnce(chainable({ data: null, error: { code: '23505', message: 'dup' } }));
    const res = await request(makeApp(makeUser('admin')))
      .post('/api/scorecards/metrics')
      .set(AUTH)
      .send({ key: 'communication', name: 'Communication', default_instruction: 'Assess clarity.', rubric: RUBRIC });
    expect(res.status).toBe(409);
    expect(res.body.error.type).toBe('conflict');
  });

  it('rubric missing a level rejected by schema → 400', async () => {
    const badRubric = { '1': 'a', '2': 'b', '3': 'c', '4': 'd' };
    const res = await request(makeApp(makeUser('admin')))
      .post('/api/scorecards/metrics')
      .set(AUTH)
      .send({ name: 'Broken', default_instruction: 'x', rubric: badRubric });
    expect(res.status).toBe(400);
    expect(mockFrom).not.toHaveBeenCalled();
  });
});

describe('PATCH /api/scorecards/metrics/:id', () => {
  it('admin edits fields and bumps version → 200', async () => {
    mockFrom
      .mockReturnValueOnce(chainable({ data: { id: METRIC_ID, version: 3 }, error: null }))
      .mockReturnValueOnce(chainable({ data: LIB_ROW(METRIC_ID, 'communication', { version: 4 }), error: null }));
    const res = await request(makeApp(makeUser('admin')))
      .patch(`/api/scorecards/metrics/${METRIC_ID}`)
      .set(AUTH)
      .send({ name: 'Communication (v2)' });
    expect(res.status).toBe(200);
    // version bumped from 3 → 4 in the update payload
    const updatePayload = updated[0][0];
    expect(updatePayload.version).toBe(4);
    expect(updatePayload.name).toBe('Communication (v2)');
    expect(auditSpy).toHaveBeenCalledTimes(1);
  });

  it('unknown metric → 404', async () => {
    mockFrom.mockReturnValueOnce(chainable({ data: null, error: null }));
    const res = await request(makeApp(makeUser('admin')))
      .patch(`/api/scorecards/metrics/${METRIC_ID}`)
      .set(AUTH)
      .send({ name: 'x' });
    expect(res.status).toBe(404);
    expect(res.body.error).toBe('metric_not_found');
  });
});

describe('POST /api/scorecards/metrics/:id/archive', () => {
  it('admin archives a metric → 200 with archived_at', async () => {
    mockFrom.mockReturnValueOnce(
      chainable({ data: LIB_ROW(METRIC_ID, 'stability', { archived_at: '2026-09-09T00:00:00.000Z' }), error: null }),
    );
    const res = await request(makeApp(makeUser('admin')))
      .post(`/api/scorecards/metrics/${METRIC_ID}/archive`)
      .set(AUTH);
    expect(res.status).toBe(200);
    expect(res.body.archived_at).toBeTruthy();
    expect(updated[0][0].archived_at).toBeTruthy();
    expect(auditSpy).toHaveBeenCalledTimes(1);
  });
});

// ═══════════════════════════════════════════════════════════════════════
// Role scorecard — GET active version
// ═══════════════════════════════════════════════════════════════════════

describe('GET /api/scorecards/roles/:roleId/scorecard', () => {
  it('returns the active version + metrics (owner interviewer)', async () => {
    mockFrom
      // loadRoleWithAccess
      .mockReturnValueOnce(chainable({ data: { id: ROLE_ID, owner_id: OWNER_ID, active_scorecard_version_id: VERSION_ID }, error: null }))
      // loadActiveRoleScorecard: roles → active id
      .mockReturnValueOnce(chainable({ data: { active_scorecard_version_id: VERSION_ID }, error: null }))
      // versions row
      .mockReturnValueOnce(chainable({ data: { id: VERSION_ID, role_id: ROLE_ID, version: 2, configuration_hash: HASH }, error: null }))
      // version metrics
      .mockReturnValueOnce(chainable({
        data: [{
          id: METRIC_ID, library_metric_id: LIB_A, metric_key: 'communication', name: 'Communication',
          instruction: 'Assess clarity.', rubric: RUBRIC, weight_bps: 10000, display_order: 0,
        }],
        error: null,
      }));
    const res = await request(makeApp(makeUser('interviewer'))).get(`/api/scorecards/roles/${ROLE_ID}/scorecard`).set(AUTH);
    expect(res.status).toBe(200);
    expect(res.body.scorecard.version).toBe(2);
    expect(res.body.scorecard.metrics).toHaveLength(1);
    expect(res.body.scorecard.metrics[0].key).toBe('communication');
  });

  it('role with no active scorecard → 200 { scorecard: null }', async () => {
    mockFrom.mockReturnValueOnce(chainable({ data: { id: ROLE_ID, owner_id: OWNER_ID, active_scorecard_version_id: null }, error: null }));
    const res = await request(makeApp(makeUser('interviewer'))).get(`/api/scorecards/roles/${ROLE_ID}/scorecard`).set(AUTH);
    expect(res.status).toBe(200);
    expect(res.body.scorecard).toBeNull();
  });

  it('unknown role → 404', async () => {
    mockFrom.mockReturnValueOnce(chainable({ data: null, error: null }));
    const res = await request(makeApp(makeUser('interviewer'))).get(`/api/scorecards/roles/${ROLE_ID}/scorecard`).set(AUTH);
    expect(res.status).toBe(404);
    expect(res.body.error).toBe('role_not_found');
  });

  it('non-owner interviewer → 403', async () => {
    mockFrom.mockReturnValueOnce(chainable({ data: { id: ROLE_ID, owner_id: OTHER_ID, active_scorecard_version_id: VERSION_ID }, error: null }));
    const res = await request(makeApp(makeUser('interviewer'))).get(`/api/scorecards/roles/${ROLE_ID}/scorecard`).set(AUTH);
    expect(res.status).toBe(403);
  });

  it('FIX 8 — a viewer can no longer read a role scorecard (now owner-scoped) → 403, no DB read', async () => {
    // The GET used to require only `viewer`, exposing a role's internal per-metric
    // config to any viewer. It is now interviewer-gated, so requireRole blocks a
    // viewer before the handler ever touches the database.
    const res = await request(makeApp(makeUser('viewer', { aal: 'aal1' })))
      .get(`/api/scorecards/roles/${ROLE_ID}/scorecard`)
      .set(AUTH);
    expect(res.status).toBe(403);
    expect(mockFrom).not.toHaveBeenCalled();
  });

  it('FIX 8 — an admin still reads any role scorecard (not owner-scoped)', async () => {
    // requireRole('interviewer') admits admin, and loadRoleWithAccess owner-scopes
    // only interviewers — so an admin reads a role it does not own.
    mockFrom.mockReturnValueOnce(chainable({ data: { id: ROLE_ID, owner_id: OTHER_ID, active_scorecard_version_id: null }, error: null }));
    const res = await request(makeApp(makeUser('admin')))
      .get(`/api/scorecards/roles/${ROLE_ID}/scorecard`)
      .set(AUTH);
    expect(res.status).toBe(200);
    expect(res.body.scorecard).toBeNull();
  });
});

// ═══════════════════════════════════════════════════════════════════════
// Role scorecard — PUT creates a NEW immutable version
// ═══════════════════════════════════════════════════════════════════════

describe('PUT /api/scorecards/roles/:roleId/scorecard', () => {
  const OWNED = { data: { id: ROLE_ID, owner_id: OWNER_ID, active_scorecard_version_id: VERSION_ID }, error: null };

  it('creates a new version, inserts metrics as one set, repoints active → 201', async () => {
    mockFrom
      .mockReturnValueOnce(chainable(OWNED)) // loadRoleWithAccess
      .mockReturnValueOnce(chainable({ data: [LIB_ROW(LIB_A, 'communication'), LIB_ROW(LIB_B, 'stability')], error: null })) // library resolve
      .mockReturnValueOnce(chainable({ data: { version: 1 }, error: null })) // max version → next = 2
      .mockReturnValueOnce(chainable({ error: null })) // version insert
      .mockReturnValueOnce(chainable({ error: null })) // metrics bulk insert
      .mockReturnValueOnce(chainable({ data: { id: ROLE_ID }, error: null })); // pointer update

    const res = await request(makeApp(makeUser('interviewer')))
      .put(`/api/scorecards/roles/${ROLE_ID}/scorecard`)
      .set(AUTH)
      .send({
        metrics: [
          { libraryMetricId: LIB_A, weightBps: 5000 },
          { libraryMetricId: LIB_B, weightBps: 5000 },
        ],
      });

    expect(res.status).toBe(201);
    expect(res.body.scorecard.version).toBe(2);
    expect(res.body.scorecard.metrics).toHaveLength(2);

    // Ordering: version row inserted before metrics; metrics inserted as a
    // SINGLE bulk statement (one array) so the AFTER-row weight trigger sees
    // the full set; roles pointer repointed last.
    const fromCalls = mockFrom.mock.calls.map((c: string[]) => c[0]);
    expect(fromCalls).toEqual([
      'roles', 'scorecard_metric_library', 'role_scorecard_versions',
      'role_scorecard_versions', 'role_scorecard_version_metrics', 'roles',
    ]);
    const metricInsertArg = inserted.find((a) => Array.isArray(a[0]))?.[0];
    expect(metricInsertArg).toHaveLength(2);
    expect(metricInsertArg.every((r: any) => r.scorecard_version_id === metricInsertArg[0].scorecard_version_id)).toBe(true);
    // pointer repointed to the SAME new version id
    const pointerUpdate = updated.find((a) => a[0].active_scorecard_version_id)?.[0];
    expect(pointerUpdate.active_scorecard_version_id).toBe(metricInsertArg[0].scorecard_version_id);
    expect(auditSpy).toHaveBeenCalledTimes(1);
  });

  it('weights not summing to 10000 rejected by domain → 400, no version written', async () => {
    mockFrom
      .mockReturnValueOnce(chainable(OWNED))
      .mockReturnValueOnce(chainable({ data: [LIB_ROW(LIB_A, 'communication'), LIB_ROW(LIB_B, 'stability')], error: null }));
    const res = await request(makeApp(makeUser('interviewer')))
      .put(`/api/scorecards/roles/${ROLE_ID}/scorecard`)
      .set(AUTH)
      .send({
        metrics: [
          { libraryMetricId: LIB_A, weightBps: 5000 },
          { libraryMetricId: LIB_B, weightBps: 4000 },
        ],
      });
    expect(res.status).toBe(400);
    expect(res.body.error.type).toBe('validation_error');
    expect(mockFrom).not.toHaveBeenCalledWith('role_scorecard_versions');
  });

  it('the weight trigger error (23514) is mapped to 400', async () => {
    mockFrom
      .mockReturnValueOnce(chainable(OWNED))
      .mockReturnValueOnce(chainable({ data: [LIB_ROW(LIB_A, 'communication'), LIB_ROW(LIB_B, 'stability')], error: null }))
      .mockReturnValueOnce(chainable({ data: null, error: null })) // no prior version → next = 1
      .mockReturnValueOnce(chainable({ error: null })) // version insert ok
      .mockReturnValueOnce(chainable({ error: { code: '23514', message: 'weights' } })); // metrics insert trips trigger
    const res = await request(makeApp(makeUser('interviewer')))
      .put(`/api/scorecards/roles/${ROLE_ID}/scorecard`)
      .set(AUTH)
      .send({
        metrics: [
          { libraryMetricId: LIB_A, weightBps: 5000 },
          { libraryMetricId: LIB_B, weightBps: 5000 },
        ],
      });
    expect(res.status).toBe(400);
    expect(res.body.error.type).toBe('validation_error');
  });

  it('unknown library metric → 400', async () => {
    mockFrom
      .mockReturnValueOnce(chainable(OWNED))
      .mockReturnValueOnce(chainable({ data: [LIB_ROW(LIB_A, 'communication')], error: null })); // LIB_B missing
    const res = await request(makeApp(makeUser('interviewer')))
      .put(`/api/scorecards/roles/${ROLE_ID}/scorecard`)
      .set(AUTH)
      .send({
        metrics: [
          { libraryMetricId: LIB_A, weightBps: 5000 },
          { libraryMetricId: LIB_B, weightBps: 5000 },
        ],
      });
    expect(res.status).toBe(400);
    expect(res.body.error.message).toContain('unknown library metric');
  });

  it('non-owner interviewer rejected → 403, no library read', async () => {
    mockFrom.mockReturnValueOnce(chainable({ data: { id: ROLE_ID, owner_id: OTHER_ID, active_scorecard_version_id: VERSION_ID }, error: null }));
    const res = await request(makeApp(makeUser('interviewer')))
      .put(`/api/scorecards/roles/${ROLE_ID}/scorecard`)
      .set(AUTH)
      .send({ metrics: [{ libraryMetricId: LIB_A, weightBps: 10000 }] });
    expect(res.status).toBe(403);
    expect(mockFrom).not.toHaveBeenCalledWith('scorecard_metric_library');
  });
});

// ═══════════════════════════════════════════════════════════════════════
// Redistribute preview — exact domain math, no DB write
// ═══════════════════════════════════════════════════════════════════════

describe('POST /api/scorecards/roles/:roleId/scorecard/redistribute', () => {
  const metric = (id: string, libId: string, key: string, weightBps: number, displayOrder: number) => ({
    id,
    libraryMetricId: libId,
    key,
    name: key,
    instruction: `Assess ${key}.`,
    rubric: RUBRIC,
    weightBps,
    displayOrder,
  });

  it('returns exactly the domain redistributeWeights output', async () => {
    mockFrom.mockReturnValueOnce(chainable({ data: { id: ROLE_ID, owner_id: OWNER_ID, active_scorecard_version_id: VERSION_ID }, error: null }));
    const M0 = '00000000-0000-4000-8000-0000000000c1';
    const M1 = '00000000-0000-4000-8000-0000000000c2';
    const M2 = '00000000-0000-4000-8000-0000000000c3';
    const metrics = [
      metric(M0, LIB_A, 'communication', 4000, 0),
      metric(M1, LIB_B, 'stability', 3000, 1),
      metric(M2, METRIC_ID, 'ownership', 3000, 2),
    ];
    const expected = JSON.parse(JSON.stringify(redistributeWeights(metrics as any, M0, 6000)));

    const res = await request(makeApp(makeUser('interviewer')))
      .post(`/api/scorecards/roles/${ROLE_ID}/scorecard/redistribute`)
      .set(AUTH)
      .send({ metrics, editedMetricId: M0, newWeightBps: 6000 });

    expect(res.status).toBe(200);
    expect(res.body.metrics).toEqual(expected);
    // sanity: pinned metric took the new weight and total is still 10000
    const total = res.body.metrics.reduce((s: number, m: any) => s + m.weightBps, 0);
    expect(total).toBe(10000);
    expect(res.body.metrics.find((m: any) => m.id === M0).weightBps).toBe(6000);
  });
});
