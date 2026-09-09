/**
 * Phase 4 — the admin RESCORE route: POST /api/assess/:sessionId/rescore.
 *
 * The route is a thin, admin-gated shell over `runAssessment(sessionId, {
 * rescore: { requestId } })`. These tests pin its own responsibilities:
 *   * admin-only (requireRole('admin')) and authenticated;
 *   * a required, UUID `rescore_request_id` body (missing/blank/non-uuid/extra
 *     keys → flat 400) — the service never runs on a malformed request;
 *   * the request id is forwarded verbatim into the rescore option;
 *   * ERR_SESSION_NOT_COMPLETED → 409 session_not_completed;
 *   * ERR_RESCORE_NO_SCORECARD → 409 rescore_requires_active_scorecard.
 *
 * The runner is injected, so no Supabase/LLM boundary is touched.
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import request from 'supertest';
import express from 'express';
import { createRequireAuth, mockAuthGetUser, type AuthUser } from '../lib/auth.js';
import { assessRouter } from '../routes/assess.js';
import { finalErrorHandler } from '../lib/validation.js';
import { setAuditSink } from '../lib/audit.js';
import {
  injectAssessmentRunner,
  ERR_SESSION_NOT_COMPLETED,
  ERR_RESCORE_NO_SCORECARD,
  ERR_RESCORE_REVISION_CONFLICT,
} from '../services/assessment.js';

// services/assessment loads supabase + the LLM runner at import; the injected
// runner means neither is ever called, but the modules must import cleanly.
vi.mock('../lib/supabase.js', () => ({
  supabase: { from: vi.fn(), rpc: vi.fn() },
  RESUME_BUCKET: 'resumes_v2',
}));
vi.mock('../lib/claude.js', () => ({ runClaudeJSONWithProvenance: vi.fn() }));

const JWT_AAL2 = 'eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiJ1c2VyLTAwMSIsImFhbCI6ImFhbDIifQ.signature';
const USER_ID = '00000000-0000-4000-8000-0000000000ff';
const SESSION_ID = '00000000-0000-4000-8000-000000000001';
const REQ_ID = '11111111-2222-4333-8444-555555555555';
const AUTH = { Authorization: `Bearer ${JWT_AAL2}` };

let runnerSpy: ReturnType<typeof vi.fn>;
let auditSpy: ReturnType<typeof vi.fn>;

function makeUser(role: AuthUser['appRole']): AuthUser {
  return {
    id: USER_ID,
    email: 'user@example.com',
    aal: 'aal2',
    active: true,
    appRole: role,
    orgId: null,
  };
}

function makeApp(user: AuthUser | null) {
  const app = express();
  app.use(express.json());
  if (user) {
    app.use(createRequireAuth({ getUser: mockAuthGetUser(user, JWT_AAL2) }));
  }
  app.use('/api/assess', assessRouter);
  app.use(finalErrorHandler);
  return app;
}

beforeEach(() => {
  runnerSpy = vi.fn(async () => ({ id: 'resc-1', summary: 'rescored' }));
  injectAssessmentRunner(runnerSpy as never);
  auditSpy = vi.fn(async () => {});
  setAuditSink(auditSpy as never);
});

afterEach(() => {
  injectAssessmentRunner(null);
  vi.restoreAllMocks();
});

// ═══════════════════════════════════════════════════════════════════════
describe('auth + RBAC gate', () => {
  it('401 without authentication', async () => {
    // No requireAuth mounted → the router has no authUser; requireRole 403s,
    // but with no auth middleware at all the request still must not score.
    const res = await request(makeApp(null))
      .post(`/api/assess/${SESSION_ID}/rescore`)
      .send({ rescore_request_id: REQ_ID });
    expect([401, 403]).toContain(res.status);
    expect(runnerSpy).not.toHaveBeenCalled();
  });

  it('403 for a viewer', async () => {
    const res = await request(makeApp(makeUser('viewer')))
      .post(`/api/assess/${SESSION_ID}/rescore`)
      .set(AUTH)
      .send({ rescore_request_id: REQ_ID });
    expect(res.status).toBe(403);
    expect(runnerSpy).not.toHaveBeenCalled();
  });

  it('403 for an interviewer (scoring is admin-only)', async () => {
    const res = await request(makeApp(makeUser('interviewer')))
      .post(`/api/assess/${SESSION_ID}/rescore`)
      .set(AUTH)
      .send({ rescore_request_id: REQ_ID });
    expect(res.status).toBe(403);
    expect(runnerSpy).not.toHaveBeenCalled();
  });
});

// ═══════════════════════════════════════════════════════════════════════
describe('body validation — a required UUID request id', () => {
  const cases: Array<[string, Record<string, unknown>]> = [
    ['missing request id', {}],
    ['blank request id', { rescore_request_id: '' }],
    ['non-uuid request id', { rescore_request_id: 'not-a-uuid' }],
    ['extra keys (strict)', { rescore_request_id: REQ_ID, extra: 1 }],
  ];
  for (const [label, body] of cases) {
    it(`400 for ${label}, and the runner is never called`, async () => {
      const res = await request(makeApp(makeUser('admin')))
        .post(`/api/assess/${SESSION_ID}/rescore`)
        .set(AUTH)
        .send(body);
      expect(res.status).toBe(400);
      expect(res.body.error.type).toBe('invalid_request');
      expect(runnerSpy).not.toHaveBeenCalled();
    });
  }
});

// ═══════════════════════════════════════════════════════════════════════
describe('happy path', () => {
  it('forwards the request id into the rescore option and returns the assessment', async () => {
    const res = await request(makeApp(makeUser('admin')))
      .post(`/api/assess/${SESSION_ID}/rescore`)
      .set(AUTH)
      .send({ rescore_request_id: REQ_ID });
    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({ id: 'resc-1' });
    expect(runnerSpy).toHaveBeenCalledWith(SESSION_ID, { rescore: { requestId: REQ_ID } });
    // The privileged mutation is audited.
    expect(auditSpy).toHaveBeenCalledOnce();
  });

  it('a fail-closed audit failure surfaces as a 500', async () => {
    auditSpy.mockRejectedValueOnce(new Error('sink down'));
    const res = await request(makeApp(makeUser('admin')))
      .post(`/api/assess/${SESSION_ID}/rescore`)
      .set(AUTH)
      .send({ rescore_request_id: REQ_ID });
    expect(res.status).toBe(500);
  });
});

// ═══════════════════════════════════════════════════════════════════════
describe('service error mapping', () => {
  it('ERR_SESSION_NOT_COMPLETED → 409 session_not_completed', async () => {
    runnerSpy.mockRejectedValueOnce(new Error(ERR_SESSION_NOT_COMPLETED));
    const res = await request(makeApp(makeUser('admin')))
      .post(`/api/assess/${SESSION_ID}/rescore`)
      .set(AUTH)
      .send({ rescore_request_id: REQ_ID });
    expect(res.status).toBe(409);
    expect(res.body.error.type).toBe('session_not_completed');
  });

  it('ERR_RESCORE_NO_SCORECARD → 409 rescore_requires_active_scorecard', async () => {
    runnerSpy.mockRejectedValueOnce(new Error(ERR_RESCORE_NO_SCORECARD));
    const res = await request(makeApp(makeUser('admin')))
      .post(`/api/assess/${SESSION_ID}/rescore`)
      .set(AUTH)
      .send({ rescore_request_id: REQ_ID });
    expect(res.status).toBe(409);
    expect(res.body.error.type).toBe('rescore_requires_active_scorecard');
  });

  it('ERR_RESCORE_REVISION_CONFLICT → 409 rescore_revision_conflict (retryable, not 500)', async () => {
    // FIX 6: the exhausted revision-race retry must map to a retryable 409, not
    // fall through to the global 500 handler.
    runnerSpy.mockRejectedValueOnce(new Error(ERR_RESCORE_REVISION_CONFLICT));
    const res = await request(makeApp(makeUser('admin')))
      .post(`/api/assess/${SESSION_ID}/rescore`)
      .set(AUTH)
      .send({ rescore_request_id: REQ_ID });
    expect(res.status).toBe(409);
    expect(res.body.error.type).toBe('rescore_revision_conflict');
  });
});
