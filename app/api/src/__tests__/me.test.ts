/**
 * Phase 9 L2 — GET /api/me (invariant 7).
 * Requires existing recruiter auth (NOT public). Returns the current
 * validated JWT email + authoritative membership role/active.
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import request from 'supertest';
import express from 'express';
import { createRequireAuth, mockAuthGetUser, type AuthUser } from '../lib/auth.js';
import { viewerReadOnly } from '../lib/rbac.js';
import { meRouter } from '../routes/me.js';

vi.mock('../lib/supabase.js', () => ({
  supabase: { from: vi.fn(), rpc: vi.fn() },
  RESUME_BUCKET: 'resumes_v2',
}));

const JWT_AAL2 = 'eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiJ1c2VyLTAwMSIsImFhbCI6ImFhbDIifQ.signature';

function makeApp(user: AuthUser, token: string = JWT_AAL2) {
  const app = express();
  app.use(express.json());
  app.use(createRequireAuth({ getUser: mockAuthGetUser(user, token) }));
  app.use(viewerReadOnly);
  app.use('/api/me', meRouter);
  return app;
}

function makeUser(overrides: Partial<AuthUser> = {}): AuthUser {
  return {
    id: 'user-admin-0000-0000-000000000001',
    email: 'admin@example.com',
    aal: 'aal2',
    active: true,
    appRole: 'admin',
    orgId: null,
    ...overrides,
  };
}

beforeEach(() => {
  vi.restoreAllMocks();
});

afterEach(() => {
  vi.restoreAllMocks();
});

describe('GET /api/me', () => {
  it('is NOT public — 401 without auth', async () => {
    const app = makeApp(makeUser());
    const res = await request(app).get('/api/me');
    expect(res.status).toBe(401);
    expect(res.body.error.type).toBe('authentication_error');
  });

  it('returns userId + validated JWT email + authoritative membership role/active for admin', async () => {
    const app = makeApp(makeUser());
    const res = await request(app).get('/api/me').set('Authorization', `Bearer ${JWT_AAL2}`);
    expect(res.status).toBe(200);
    expect(res.body).toEqual({
      userId: 'user-admin-0000-0000-000000000001',
      email: 'admin@example.com',
      role: 'admin',
      active: true,
    });
  });

  it('returns interviewer role from the membership resolver', async () => {
    const app = makeApp(makeUser({ id: 'user-int-0000-0000-000000000002', email: 'int@example.com', appRole: 'interviewer' }));
    const res = await request(app).get('/api/me').set('Authorization', `Bearer ${JWT_AAL2}`);
    expect(res.status).toBe(200);
    expect(res.body.role).toBe('interviewer');
    expect(res.body.email).toBe('int@example.com');
  });

  it('returns viewer role for viewers (any active recruiter)', async () => {
    const app = makeApp(makeUser({ id: 'user-view-0000-0000-000000000003', email: 'viewer@example.com', appRole: 'viewer', aal: 'aal1' }));
    const res = await request(app).get('/api/me').set('Authorization', `Bearer ${JWT_AAL2}`);
    expect(res.status).toBe(200);
    expect(res.body.role).toBe('viewer');
    expect(res.body.active).toBe(true);
  });

  it('does not leak membership of other users or PII beyond the caller', async () => {
    const app = makeApp(makeUser());
    const res = await request(app).get('/api/me').set('Authorization', `Bearer ${JWT_AAL2}`);
    expect(JSON.stringify(res.body)).not.toContain('phone');
    expect(JSON.stringify(res.body)).not.toContain('memberships');
  });
});
