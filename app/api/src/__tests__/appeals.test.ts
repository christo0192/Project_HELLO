/**
 * Phase 9 L3 — /api/appeals (invariants 3/4).
 * Grant issuance: interviewer+/admin + ownership, explicit bounded expiry,
 * plaintext returned once, SHA-256 digest only. Candidate submission:
 * inline grant validation, server-built minimized snapshot (no
 * transcript/contact), atomic create_appeal RPC; replay fails stable.
 * Review: recruiter ownership/admin, legal CAS only via review_appeal RPC;
 * API never accepts assessment_snapshot/"created" evidence mutations; review
 * events are append-only (DB contract + no mutating routes).
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import request from 'supertest';
import express from 'express';
import { readFileSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { createRequireAuth, mockAuthGetUser, type AuthUser } from '../lib/auth.js';
import { appealsRouter } from '../routes/appeals.js';
import { finalErrorHandler } from '../lib/validation.js';

vi.mock('../lib/supabase.js', () => ({
  supabase: { from: vi.fn(), rpc: vi.fn() },
  RESUME_BUCKET: 'resumes_v2',
}));

const JWT_AAL2 = 'eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiJ1c2VyLTAwMSIsImFhbCI6ImFhbDIifQ.signature';
const RECRUITER_ID = '00000000-0000-4000-8000-0000000000ff';
const OTHER_RECRUITER_ID = '00000000-0000-4000-8000-0000000000ee';
const CANDIDATE_ID = '00000000-0000-4000-8000-000000000001';
const SESSION_ID = '00000000-0000-4000-8000-000000000002';
const ASSESSMENT_ID = '00000000-0000-4000-8000-000000000003';
const APPEAL_ID = '00000000-0000-4000-8000-000000000004';
const GRANT_TOKEN = 'b'.repeat(64);
const GRANT_DIGEST = createHash('sha256').update(GRANT_TOKEN, 'utf-8').digest('hex');

let inserted: any[] = [];
let mockFrom: any;
let mockRpc: any;

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
  fn.update = () => chainable(value);
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

beforeEach(async () => {
  const mod = await import('../lib/supabase.js');
  mockFrom = (mod.supabase as any).from;
  mockRpc = (mod.supabase as any).rpc;
  mockFrom.mockReset();
  mockRpc.mockReset();
  inserted = [];
});

afterEach(() => {
  vi.restoreAllMocks();
});

function makeAuthApp(user: AuthUser) {
  const app = express();
  app.use(express.json());
  app.use(createRequireAuth({ getUser: mockAuthGetUser(user, JWT_AAL2) }));
  app.use('/api/appeals', appealsRouter);
  app.use(finalErrorHandler);
  return app;
}

/** Public mount (POST /api/appeals is in PUBLIC_ROUTES — L4 wires it). */
function makePublicApp() {
  const app = express();
  app.use(express.json());
  app.use('/api/appeals', appealsRouter);
  app.use(finalErrorHandler);
  return app;
}

const AUTH = { Authorization: `Bearer ${JWT_AAL2}` };

const OWNED_CANDIDATE = { data: { owner_id: RECRUITER_ID }, error: null };
const OTHERS_CANDIDATE = { data: { owner_id: OTHER_RECRUITER_ID }, error: null };
const SESSION_ROW = { data: { candidate_id: CANDIDATE_ID }, error: null };
const ASSESSMENT_ROW = {
  data: {
    id: ASSESSMENT_ID,
    english: { band: 'B2', grammar: 7, vocabulary: 8, fluency: 7, coherence: 8 },
    tone: { clarity: 8, confidence: 7, professionalism: 9 },
    communication: { score: 7.5 },
    motivation: { score: 8 },
    role_fit: { score: 6 },
    overall_score: 76,
    recommendation: 'advance',
  },
  error: null,
};
const ACTIVE_GRANT = {
  data: {
    id: '00000000-0000-4000-8000-000000000005',
    candidate_id: CANDIDATE_ID,
    session_id: SESSION_ID,
    expires_at: '2999-01-01T00:00:00.000Z',
    consumed_at: null,
    revoked_at: null,
  },
  error: null,
};

describe('POST /api/appeals/grants — boundary', () => {
  it('401 without auth', async () => {
    const res = await request(makeAuthApp(makeUser('admin')))
      .post('/api/appeals/grants')
      .send({ candidate_id: CANDIDATE_ID, session_id: SESSION_ID, expires_in_hours: 24 });
    expect(res.status).toBe(401);
  });

  it('viewer → 403', async () => {
    const res = await request(makeAuthApp(makeUser('viewer', { aal: 'aal1' })))
      .post('/api/appeals/grants')
      .set(AUTH)
      .send({ candidate_id: CANDIDATE_ID, session_id: SESSION_ID, expires_in_hours: 24 });
    expect(res.status).toBe(403);
  });

  it('interviewer non-owner → 403, no grant persisted', async () => {
    mockFrom.mockReturnValueOnce(chainable(OTHERS_CANDIDATE));
    const res = await request(makeAuthApp(makeUser('interviewer')))
      .post('/api/appeals/grants')
      .set(AUTH)
      .send({ candidate_id: CANDIDATE_ID, session_id: SESSION_ID, expires_in_hours: 24 });
    expect(res.status).toBe(403);
    expect(inserted).toHaveLength(0);
  });

  it('candidate missing → 404', async () => {
    mockFrom.mockReturnValueOnce(chainable({ data: null, error: null }));
    const res = await request(makeAuthApp(makeUser('interviewer')))
      .post('/api/appeals/grants')
      .set(AUTH)
      .send({ candidate_id: CANDIDATE_ID, session_id: SESSION_ID, expires_in_hours: 24 });
    expect(res.status).toBe(404);
  });

  it('session missing → 404', async () => {
    mockFrom
      .mockReturnValueOnce(chainable(OWNED_CANDIDATE))
      .mockReturnValueOnce(chainable({ data: null, error: null }));
    const res = await request(makeAuthApp(makeUser('interviewer')))
      .post('/api/appeals/grants')
      .set(AUTH)
      .send({ candidate_id: CANDIDATE_ID, session_id: SESSION_ID, expires_in_hours: 24 });
    expect(res.status).toBe(404);
    expect(res.body.error).toBe('session_not_found');
  });

  it('wrong candidate-session binding → 400', async () => {
    mockFrom
      .mockReturnValueOnce(chainable(OWNED_CANDIDATE))
      .mockReturnValueOnce(chainable({ data: { candidate_id: '00000000-0000-4000-8000-0000000000aa' }, error: null }));
    const res = await request(makeAuthApp(makeUser('interviewer')))
      .post('/api/appeals/grants')
      .set(AUTH)
      .send({ candidate_id: CANDIDATE_ID, session_id: SESSION_ID, expires_in_hours: 24 });
    expect(res.status).toBe(400);
    expect(res.body.error).toBe('candidate_session_mismatch');
  });

  it('missing expires_in_hours → 400 (no hidden policy default)', async () => {
    const res = await request(makeAuthApp(makeUser('interviewer')))
      .post('/api/appeals/grants')
      .set(AUTH)
      .send({ candidate_id: CANDIDATE_ID, session_id: SESSION_ID });
    expect(res.status).toBe(400);
  });

  it('bounded expiry: 0 and 73 hours rejected (400)', async () => {
    const app = makeAuthApp(makeUser('interviewer'));
    const tooShort = await request(app)
      .post('/api/appeals/grants')
      .set(AUTH)
      .send({ candidate_id: CANDIDATE_ID, session_id: SESSION_ID, expires_in_hours: 0 });
    expect(tooShort.status).toBe(400);
    const tooLong = await request(app)
      .post('/api/appeals/grants')
      .set(AUTH)
      .send({ candidate_id: CANDIDATE_ID, session_id: SESSION_ID, expires_in_hours: 73 });
    expect(tooLong.status).toBe(400);
  });
});

describe('POST /api/appeals/grants — issuance', () => {
  it('returns plaintext once; persists ONLY the SHA-256 digest', async () => {
    mockFrom
      .mockReturnValueOnce(chainable(OWNED_CANDIDATE))
      .mockReturnValueOnce(chainable(SESSION_ROW))
      .mockReturnValueOnce(chainable({ data: null, error: null }));
    const res = await request(makeAuthApp(makeUser('interviewer')))
      .post('/api/appeals/grants')
      .set(AUTH)
      .send({ candidate_id: CANDIDATE_ID, session_id: SESSION_ID, expires_in_hours: 24 });
    expect(res.status).toBe(201);
    const token = res.body.appeal_grant_token as string;
    expect(token).toMatch(/^[a-f0-9]{64}$/);
    expect(res.body.expires_at).toBeTruthy();

    const grantInsert = inserted.find((a) => JSON.stringify(a).includes('token_digest'));
    expect(grantInsert).toBeTruthy();
    const payload = JSON.stringify(grantInsert);
    const digest = createHash('sha256').update(token, 'utf-8').digest('hex');
    expect(payload).toContain(digest);
    // Plaintext token is NEVER persisted (only its digest).
    expect(payload).not.toContain(token);
    expect(mockFrom).toHaveBeenCalledWith('appeal_grants');
  });

  it('admin can issue for any candidate', async () => {
    mockFrom
      .mockReturnValueOnce(chainable(OTHERS_CANDIDATE))
      .mockReturnValueOnce(chainable(SESSION_ROW))
      .mockReturnValueOnce(chainable({ data: null, error: null }));
    const res = await request(makeAuthApp(makeUser('admin')))
      .post('/api/appeals/grants')
      .set(AUTH)
      .send({ candidate_id: CANDIDATE_ID, session_id: SESSION_ID, expires_in_hours: 12 });
    expect(res.status).toBe(201);
  });
});

describe('POST /api/appeals — public candidate submission', () => {
  const submitBody = (overrides: Record<string, unknown> = {}) => ({
    appeal_grant_token: GRANT_TOKEN,
    category: 'scoring',
    description: 'My score seems inconsistent with my answers.',
    ...overrides,
  });

  it('401 is NOT required (public route); grant-authenticated', async () => {
    mockFrom
      .mockReturnValueOnce(chainable(ACTIVE_GRANT))
      .mockReturnValueOnce(chainable(ASSESSMENT_ROW));
    mockRpc.mockResolvedValue({ data: { status: 'ok', appeal_id: APPEAL_ID }, error: null });
    const res = await request(makePublicApp()).post('/api/appeals').send(submitBody());
    expect(res.status).toBe(201);
    expect(res.body).toEqual({ ok: true, appeal_id: APPEAL_ID });
  });

  it('invalid grant token → stable 404 (no RPC call)', async () => {
    mockFrom.mockReturnValueOnce(chainable({ data: null, error: null }));
    const res = await request(makePublicApp()).post('/api/appeals').send(submitBody());
    expect(res.status).toBe(404);
    expect(res.body.error).toBe('appeal_grant_invalid_or_expired');
    expect(mockRpc).not.toHaveBeenCalled();
  });

  it('expired/revoked/consumed grants → stable 404', async () => {
    const variants = [
      { ...ACTIVE_GRANT.data, expires_at: '2000-01-01T00:00:00.000Z' },
      { ...ACTIVE_GRANT.data, revoked_at: '2025-01-01T00:00:00.000Z' },
      { ...ACTIVE_GRANT.data, consumed_at: '2025-01-01T00:00:00.000Z' },
    ];
    for (const variant of variants) {
      mockFrom.mockReturnValueOnce(chainable({ data: variant, error: null }));
      const res = await request(makePublicApp()).post('/api/appeals').send(submitBody());
      expect(res.status).toBe(404);
      expect(res.body.error).toBe('appeal_grant_invalid_or_expired');
      mockFrom.mockReset();
    }
  });

  it('replay → atomic RPC reports grant_consumed → stable 409', async () => {
    mockFrom
      .mockReturnValueOnce(chainable(ACTIVE_GRANT))
      .mockReturnValueOnce(chainable(ASSESSMENT_ROW));
    mockRpc.mockResolvedValue({ data: { status: 'grant_consumed' }, error: null });
    const res = await request(makePublicApp()).post('/api/appeals').send(submitBody());
    expect(res.status).toBe(409);
    expect(res.body.error).toBe('appeal_grant_consumed');
  });

  it('grant_mismatch from the RPC → 409 (defense in depth)', async () => {
    mockFrom
      .mockReturnValueOnce(chainable(ACTIVE_GRANT))
      .mockReturnValueOnce(chainable(ASSESSMENT_ROW));
    mockRpc.mockResolvedValue({ data: { status: 'grant_mismatch' }, error: null });
    const res = await request(makePublicApp()).post('/api/appeals').send(submitBody());
    expect(res.status).toBe(409);
    expect(res.body.error).toBe('appeal_grant_mismatch');
  });

  it('no assessment for the session → 409, RPC not called', async () => {
    mockFrom
      .mockReturnValueOnce(chainable(ACTIVE_GRANT))
      .mockReturnValueOnce(chainable({ data: null, error: null }));
    const res = await request(makePublicApp()).post('/api/appeals').send(submitBody());
    expect(res.status).toBe(409);
    expect(res.body.error).toBe('no_assessment_for_appeal');
    expect(mockRpc).not.toHaveBeenCalled();
  });

  it('client-supplied assessment_snapshot is rejected (strict schema, 400)', async () => {
    const res = await request(makePublicApp())
      .post('/api/appeals')
      .send({ ...submitBody(), assessment_snapshot: { scores: { english: 1 } } });
    expect(res.status).toBe(400);
    expect(mockRpc).not.toHaveBeenCalled();
  });

  it('snapshot is server-built and MINIMIZED — IDs/hash/scores only, no transcript/contact', async () => {
    mockFrom
      .mockReturnValueOnce(chainable(ACTIVE_GRANT))
      .mockReturnValueOnce(chainable(ASSESSMENT_ROW));
    mockRpc.mockResolvedValue({ data: { status: 'ok', appeal_id: APPEAL_ID }, error: null });
    const res = await request(makePublicApp()).post('/api/appeals').send(submitBody());
    expect(res.status).toBe(201);

    expect(mockRpc).toHaveBeenCalledWith('create_appeal', expect.objectContaining({
      p_candidate_id: CANDIDATE_ID,
      p_session_id: SESSION_ID,
      p_assessment_id: ASSESSMENT_ID,
      p_grant_digest: GRANT_DIGEST,
      p_category: 'scoring',
    }));
    const rpcArg = mockRpc.mock.calls[0][1];
    const snapshot = rpcArg.p_assessment_snapshot as Record<string, unknown>;
    expect(Object.keys(snapshot).sort()).toEqual(['assessment_id', 'scores', 'version_hash']);
    const scores = snapshot.scores as Record<string, unknown>;
    expect(Object.keys(scores).sort()).toEqual([
      'communication', 'english', 'motivation', 'overall_score', 'recommendation', 'role_fit', 'tone',
    ]);
    const serialized = JSON.stringify(snapshot);
    expect(serialized).not.toMatch(/transcript|resume|email|phone|contact|raw/i);
    expect(serialized).toContain('"recommendation":"advance"');
  });
});

describe('POST /api/appeals/:appealId/review', () => {
  const reviewBody = (overrides: Record<string, unknown> = {}) => ({
    to_status: 'granted',
    notes: 'Evidence supports the appeal.',
    ...overrides,
  });

  it('401 without auth', async () => {
    const res = await request(makeAuthApp(makeUser('admin')))
      .post(`/api/appeals/${APPEAL_ID}/review`)
      .send(reviewBody());
    expect(res.status).toBe(401);
  });

  it('viewer → 403', async () => {
    const res = await request(makeAuthApp(makeUser('viewer', { aal: 'aal1' })))
      .post(`/api/appeals/${APPEAL_ID}/review`)
      .set(AUTH)
      .send(reviewBody());
    expect(res.status).toBe(403);
  });

  it('interviewer non-owner → 403', async () => {
    mockFrom
      .mockReturnValueOnce(chainable({ data: { candidate_id: CANDIDATE_ID }, error: null }))
      .mockReturnValueOnce(chainable(OTHERS_CANDIDATE));
    const res = await request(makeAuthApp(makeUser('interviewer')))
      .post(`/api/appeals/${APPEAL_ID}/review`)
      .set(AUTH)
      .send(reviewBody());
    expect(res.status).toBe(403);
    expect(mockRpc).not.toHaveBeenCalled();
  });

  it('appeal not found → 404', async () => {
    mockFrom.mockReturnValueOnce(chainable({ data: null, error: null }));
    const res = await request(makeAuthApp(makeUser('interviewer')))
      .post(`/api/appeals/${APPEAL_ID}/review`)
      .set(AUTH)
      .send(reviewBody());
    expect(res.status).toBe(404);
    expect(mockRpc).not.toHaveBeenCalled();
  });

  it('owner interviewer reviews via the atomic RPC → 200', async () => {
    mockFrom
      .mockReturnValueOnce(chainable({ data: { candidate_id: CANDIDATE_ID }, error: null }))
      .mockReturnValueOnce(chainable(OWNED_CANDIDATE));
    mockRpc.mockResolvedValue({ data: { status: 'ok' }, error: null });
    const res = await request(makeAuthApp(makeUser('interviewer')))
      .post(`/api/appeals/${APPEAL_ID}/review`)
      .set(AUTH)
      .send(reviewBody());
    expect(res.status).toBe(200);
    expect(res.body).toEqual({ ok: true });
    expect(mockRpc).toHaveBeenCalledWith('review_appeal', {
      p_appeal_id: APPEAL_ID,
      p_reviewer_id: RECRUITER_ID,
      p_to_status: 'granted',
      p_notes: 'Evidence supports the appeal.',
      p_evidence: null,
    });
  });

  it('concurrent review: already_final → 409 (only one CAS wins)', async () => {
    mockFrom
      .mockReturnValueOnce(chainable({ data: { candidate_id: CANDIDATE_ID }, error: null }))
      .mockReturnValueOnce(chainable(OWNED_CANDIDATE));
    mockRpc.mockResolvedValue({ data: { status: 'already_final' }, error: null });
    const res = await request(makeAuthApp(makeUser('interviewer')))
      .post(`/api/appeals/${APPEAL_ID}/review`)
      .set(AUTH)
      .send(reviewBody());
    expect(res.status).toBe(409);
    expect(res.body.error).toBe('appeal_already_final');
  });

  it('illegal transition → 400 invalid_transition', async () => {
    mockFrom
      .mockReturnValueOnce(chainable({ data: { candidate_id: CANDIDATE_ID }, error: null }))
      .mockReturnValueOnce(chainable(OWNED_CANDIDATE));
    mockRpc.mockResolvedValue({ data: { status: 'invalid_transition' }, error: null });
    const res = await request(makeAuthApp(makeUser('interviewer')))
      .post(`/api/appeals/${APPEAL_ID}/review`)
      .set(AUTH)
      .send(reviewBody());
    expect(res.status).toBe(400);
    expect(res.body.error).toBe('invalid_transition');
  });

  it('non-legal target status rejected by schema (400)', async () => {
    const res = await request(makeAuthApp(makeUser('interviewer')))
      .post(`/api/appeals/${APPEAL_ID}/review`)
      .set(AUTH)
      .send({ ...reviewBody(), to_status: 'open' });
    expect(res.status).toBe(400);
  });

  it('API never accepts assessment_snapshot or created-evidence mutations (strict, 400)', async () => {
    const withSnapshot = await request(makeAuthApp(makeUser('interviewer')))
      .post(`/api/appeals/${APPEAL_ID}/review`)
      .set(AUTH)
      .send({ ...reviewBody(), assessment_snapshot: { scores: {} } });
    expect(withSnapshot.status).toBe(400);

    const withCreated = await request(makeAuthApp(makeUser('interviewer')))
      .post(`/api/appeals/${APPEAL_ID}/review`)
      .set(AUTH)
      .send({ ...reviewBody(), created_at: '2025-01-01T00:00:00Z' });
    expect(withCreated.status).toBe(400);
    expect(mockRpc).not.toHaveBeenCalled();
  });

  it('admin reviews without ownership constraint', async () => {
    mockFrom.mockReturnValueOnce(chainable({ data: { candidate_id: CANDIDATE_ID }, error: null }));
    mockRpc.mockResolvedValue({ data: { status: 'ok' }, error: null });
    const res = await request(makeAuthApp(makeUser('admin')))
      .post(`/api/appeals/${APPEAL_ID}/review`)
      .set(AUTH)
      .send({ to_status: 'denied', notes: 'Not supported.' });
    expect(res.status).toBe(200);
  });
});

describe('GET /api/appeals?candidate_id=', () => {
  it('owner interviewer lists appeals (200)', async () => {
    mockFrom
      .mockReturnValueOnce(chainable(OWNED_CANDIDATE))
      .mockReturnValueOnce(chainable({ data: [{ id: APPEAL_ID, status: 'open' }], error: null }));
    const res = await request(makeAuthApp(makeUser('interviewer')))
      .get(`/api/appeals?candidate_id=${CANDIDATE_ID}`)
      .set(AUTH);
    expect(res.status).toBe(200);
    expect(res.body.appeals).toHaveLength(1);
  });

  it('non-owner interviewer → 403', async () => {
    mockFrom.mockReturnValueOnce(chainable(OTHERS_CANDIDATE));
    const res = await request(makeAuthApp(makeUser('interviewer')))
      .get(`/api/appeals?candidate_id=${CANDIDATE_ID}`)
      .set(AUTH);
    expect(res.status).toBe(403);
  });

  it('viewer read-only can list (200)', async () => {
    mockFrom.mockReturnValueOnce(chainable({ data: [], error: null }));
    const res = await request(makeAuthApp(makeUser('viewer', { aal: 'aal1' })))
      .get(`/api/appeals?candidate_id=${CANDIDATE_ID}`)
      .set(AUTH);
    expect(res.status).toBe(200);
  });
});

describe('DB contract / static immutability (invariant 4)', () => {
  it('migration 0015 defines the append-only appeal_review_events guard + triggers', () => {
    const migrationPath = new URL('../../../supabase/migrations/0015_phase9_operations.sql', import.meta.url);
    const sql = readFileSync(migrationPath, 'utf-8');
    expect(sql).toContain('prevent_appeal_review_mutation');
    expect(sql).toContain('trg_appeal_review_prevent_update');
    expect(sql).toContain('trg_appeal_review_prevent_delete');
    expect(sql).toContain('appeal_review_events is append-only');
    // Snapshot bound: score/version/hash references only — no transcripts.
    expect(sql).toContain('chk_appeal_requests_snapshot_size');
  });

  it('lib/appeal-grant.ts never touches candidate_access_grants (consistency #3)', () => {
    const libPath = new URL('../lib/appeal-grant.ts', import.meta.url);
    const source = readFileSync(libPath, 'utf-8');
    // No DB access to candidate_access_grants anywhere in this lib.
    expect(source).not.toContain(".from('candidate_access_grants')");
    expect(source).toContain(".from('appeal_grants')");
    expect(source).toContain('token_digest');
  });

  it('the appeals router exposes NO update/delete/patch routes (review events immutable)', () => {
    const methods = appealsRouter.stack
      .filter((layer: any) => layer.route?.methods)
      .flatMap((layer: any) => Object.keys(layer.route.methods));
    expect(methods).not.toContain('patch');
    expect(methods).not.toContain('delete');
    expect(methods).not.toContain('put');
  });
});
