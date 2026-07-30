/**
 * MIG-06: Test suite for GET /api/recordings/:sessionId/download.
 *
 * Covers:
 * - route absent from PUBLIC_ROUTES (bearer auth applies)
 * - unauthenticated 401
 * - inactive membership 403 (auth middleware)
 * - admin / viewer read-all (reach handler; 200 on real object, 404 otherwise)
 * - interviewer owns → 200; interviewer non-owner → 403
 * - malformed session id 400
 * - missing object key 404
 * - signing failure → redacted stable 500
 * - rate-limit headers present (per-endpoint strict limiter mounted)
 * - response returns a signed URL that is never persisted (no DB write)
 * - candidate grant POST /api/livekit/grant/recording behavior unchanged
 *
 * Supabase is mocked (repo convention) so the route never touches a live DB.
 */

import { describe, expect, it, beforeEach } from 'vitest';
import request from 'supertest';
import { createApp } from '../app.js';
import { isPublicRoute, PUBLIC_ROUTES } from '../lib/auth.js';
import { setRateLimitStore, MemoryRateLimitStore } from '../lib/rate-limit.js';
import { vi } from 'vitest';

// ── Supabase mock (chainable query builder + storage) ────────────────

const mockFrom = vi.fn();
const mockCreateSignedUrl = vi.fn();
vi.mock('../lib/supabase.js', () => ({
  supabase: {
    from: (...args: unknown[]) => mockFrom(...args),
    storage: {
      from: (..._args: unknown[]) => ({
        createSignedUrl: (...a: unknown[]) => mockCreateSignedUrl(...a),
      }),
    },
  },
  RESUME_BUCKET: 'resumes_v2',
}));

/** Chainable Supabase query-builder mock that resolves to `value`. */
function chain(value: unknown) {
  const c: Record<string, unknown> = {};
  const methods = ['select', 'insert', 'update', 'delete', 'eq', 'single', 'maybeSingle', 'order', 'limit'];
  for (const m of methods) {
    c[m] = (..._args: unknown[]) => chain(value);
  }
  c.then = (resolve: (v: unknown) => unknown) => Promise.resolve(value).then(resolve);
  c.catch = (reject: (e: unknown) => unknown) => Promise.resolve(value).catch(reject);
  return c;
}

// ── Fixtures ──────────────────────────────────────────────────────────

const VALID_SESSION = '00000000-0000-4000-8000-000000000001';
const OBJECT_KEY = 'sessions/00000000-0000-4000-8000-000000000001/recording.mp4';
const SIGNED_URL = 'https://storage.example.invalid/signed/recording.mp4?token=x';

// JWT-shaped token whose payload decodes to {"sub":"user-001","aal":"aal2"}.
// The auth middleware (extractBearerToken + deriveAalFromJwt) requires a
// real JWT shape (>= 16 chars, contains dots) and reads AAL from the payload,
// so a placeholder like "mock-token" is rejected at 401 before the DI seam.
const JWT_AAL2 =
  'eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiJ1c2VyLTAwMSIsImFhbCI6ImFhbDIifQ.signature';
const AUTH_HEADER = `Bearer ${JWT_AAL2}`;

/** authDeps that resolve a given app role + active flag with an AAL2 JWT. */
function authAs(role: 'admin' | 'interviewer' | 'viewer', userId: string, active = true) {
  return {
    getUser: async () => ({
      data: {
        user: {
          id: userId,
          email: `${role}@test.invalid`,
          app_metadata: { app_role: role, org_id: null, active: true },
        },
      },
      error: null,
    }),
    resolveMembership: async () => ({ role, active }),
  };
}

function createTestApp(authDeps?: any) {
  return createApp({
    nodeEnv: 'test',
    webOrigin: 'http://localhost:5173',
    authDeps,
    auditSinkOverride: async () => {}, // silent audit
  });
}

describe('GET /api/recordings/:sessionId/download', () => {
  beforeEach(() => {
    setRateLimitStore(new MemoryRateLimitStore(100_000));
    mockFrom.mockReset();
    mockCreateSignedUrl.mockReset();
    // Default: no session row found; signing not configured.
    mockFrom.mockImplementation(() => chain({ data: null, error: null }));
    mockCreateSignedUrl.mockResolvedValue({ data: null, error: { message: 'no' } });
  });

  // ── Route not public ──────────────────────────────────────────────
  it('is not in PUBLIC_ROUTES', () => {
    const found = PUBLIC_ROUTES.some(
      (r) => r.method === 'GET' && r.path.startsWith('/api/recordings'),
    );
    expect(found).toBe(false);
  });

  it('is not identified as public by isPublicRoute', () => {
    expect(isPublicRoute('GET', '/api/recordings/0000/download')).toBe(false);
  });

  // ── Unauthenticated 401 ───────────────────────────────────────────
  it('returns 401 when no auth token is provided', async () => {
    const app = createTestApp();
    const res = await request(app).get(`/api/recordings/${VALID_SESSION}/download`);
    expect(res.status).toBe(401);
    expect(res.body.error.type).toBe('authentication_error');
  });

  // ── Inactive membership 403 (auth middleware) ─────────────────────
  it('returns 403 when membership is inactive', async () => {
    const app = createTestApp(authAs('admin', 'admin-1', false));
    const res = await request(app)
      .get(`/api/recordings/${VALID_SESSION}/download`)
      .set('Authorization', AUTH_HEADER);
    expect(res.status).toBe(403);
  });

  // ── Interviewer non-owner 403 ─────────────────────────────────────
  it('returns 403 when interviewer does not own the session', async () => {
    mockFrom.mockImplementation(() =>
      chain({ data: { owner_id: 'someone-else', recording_object_key: OBJECT_KEY }, error: null }),
    );
    const app = createTestApp(authAs('interviewer', 'interviewer-1'));
    const res = await request(app)
      .get(`/api/recordings/${VALID_SESSION}/download`)
      .set('Authorization', AUTH_HEADER);
    expect(res.status).toBe(403);
  });

  // ── Interviewer owner 200 ─────────────────────────────────────────
  it('returns a signed URL when interviewer owns the session', async () => {
    mockFrom.mockImplementation(() =>
      chain({ data: { owner_id: 'interviewer-1', recording_object_key: OBJECT_KEY }, error: null }),
    );
    mockCreateSignedUrl.mockResolvedValue({ data: { signedUrl: SIGNED_URL }, error: null });
    const app = createTestApp(authAs('interviewer', 'interviewer-1'));
    const res = await request(app)
      .get(`/api/recordings/${VALID_SESSION}/download`)
      .set('Authorization', AUTH_HEADER);
    expect(res.status).toBe(200);
    expect(res.body.url).toBe(SIGNED_URL);
  });

  // ── Viewer read-all 200 (regression: viewer must not be denied) ───
  // The Phase-1 policy (0007 "scoped recruiter read call_sessions") grants
  // admin/viewer read-all. A 403 here would mean the viewer was wrongly denied.
  it('allows an active viewer to read any session (200)', async () => {
    mockFrom.mockImplementation(() =>
      chain({ data: { owner_id: 'someone-else', recording_object_key: OBJECT_KEY }, error: null }),
    );
    mockCreateSignedUrl.mockResolvedValue({ data: { signedUrl: SIGNED_URL }, error: null });
    const app = createTestApp(authAs('viewer', 'viewer-1'));
    const res = await request(app)
      .get(`/api/recordings/${VALID_SESSION}/download`)
      .set('Authorization', AUTH_HEADER);
    expect(res.status).toBe(200);
    expect(res.status).not.toBe(403);
    expect(res.body.url).toBe(SIGNED_URL);
  });

  // ── Admin read-all 200; never persists the URL ────────────────────
  it('returns a signed URL for admin and never writes it back to the DB', async () => {
    mockFrom.mockImplementation(() =>
      chain({ data: { owner_id: 'someone-else', recording_object_key: OBJECT_KEY }, error: null }),
    );
    mockCreateSignedUrl.mockResolvedValue({ data: { signedUrl: SIGNED_URL }, error: null });
    const app = createTestApp(authAs('admin', 'admin-1'));
    const res = await request(app)
      .get(`/api/recordings/${VALID_SESSION}/download`)
      .set('Authorization', AUTH_HEADER);
    expect(res.status).toBe(200);
    expect(res.body.url).toBe(SIGNED_URL);
    // The signed URL must be minted on-demand, not read from a durable column.
    expect(mockCreateSignedUrl).toHaveBeenCalledWith(OBJECT_KEY, expect.any(Number));
    // Only the call_sessions SELECT should touch the DB — no insert/update.
    for (const call of mockFrom.mock.calls) {
      expect(call[0]).toBe('call_sessions');
    }
  });

  // ── Malformed session ID 400 ──────────────────────────────────────
  it('returns 400 for malformed session ID', async () => {
    const app = createTestApp(authAs('admin', 'admin-1'));
    const res = await request(app)
      .get('/api/recordings/not-a-uuid/download')
      .set('Authorization', AUTH_HEADER);
    expect(res.status).toBe(400);
    expect(res.body.error.type).toBe('validation_error');
  });

  // ── Missing object key 404 ────────────────────────────────────────
  it('returns 404 when session has no recording_object_key', async () => {
    mockFrom.mockImplementation(() =>
      chain({ data: { owner_id: 'admin-1', recording_object_key: null }, error: null }),
    );
    const app = createTestApp(authAs('admin', 'admin-1'));
    const res = await request(app)
      .get(`/api/recordings/${VALID_SESSION}/download`)
      .set('Authorization', AUTH_HEADER);
    expect(res.status).toBe(404);
  });

  // ── Signing failure → redacted stable 500 ─────────────────────────
  it('returns a redacted 500 when signing fails', async () => {
    mockFrom.mockImplementation(() =>
      chain({ data: { owner_id: 'admin-1', recording_object_key: OBJECT_KEY }, error: null }),
    );
    mockCreateSignedUrl.mockResolvedValue({ data: null, error: { message: 'boom secret detail' } });
    const app = createTestApp(authAs('admin', 'admin-1'));
    const res = await request(app)
      .get(`/api/recordings/${VALID_SESSION}/download`)
      .set('Authorization', AUTH_HEADER);
    expect(res.status).toBe(500);
    // Error is stable and never echoes the signing failure detail.
    expect(JSON.stringify(res.body)).not.toContain('boom secret detail');
  });

  // ── Rate-limit headers present (per-endpoint strict limiter) ───────
  it('exposes rate-limit headers on the recordings endpoint', async () => {
    const app = createTestApp(authAs('admin', 'admin-1'));
    const res = await request(app)
      .get(`/api/recordings/${VALID_SESSION}/download`)
      .set('Authorization', AUTH_HEADER);
    expect(res.headers['x-ratelimit-limit']).toBeDefined();
    expect(res.headers['x-ratelimit-remaining']).toBeDefined();
  });

  // ── Candidate grant path is separate and NOT intercepted by WS-D ──
  it('does not let the recruiter recordings route intercept the candidate grant path', async () => {
    const app = createTestApp();
    const res = await request(app)
      .post('/api/livekit/grant/recording')
      .send({ grant_token: 'a'.repeat(64), session_id: VALID_SESSION });
    // NOTE (pre-existing, out of Phase-2 scope): in livekit.ts the route
    // `POST /:sessionId/recording` is registered BEFORE `POST /grant/recording`,
    // so "grant" is captured as :sessionId and rejected by that route's UUID
    // param validation with 400. This shadowing exists on main (livekit.ts is
    // unchanged by Phase 2) and is documented as a follow-up finding — WS-D
    // did not introduce or alter it. What this test guards is that mounting the
    // new /api/recordings router did NOT change this behavior: the request is
    // still handled by the livekit stack, not by the recruiter download route.
    expect(res.status).toBe(400);
    expect(res.body.error.type).toBe('validation_error');
  });
});
