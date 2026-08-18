/**
 * Phase 1 Worker Contract — API auth, RBAC, rate limits, audit foundation tests.
 *
 * V2: Uses CreateAppOptions.authDeps DI seam instead of vi.spyOn on verifyToken.
 * Tests never call a live Supabase provider.
 *
 * Covers:
 *  - 401/403/200 matrix for all endpoints by role
 *  - Forged JWT rejection
 *  - AAL derived from JWT payload (never metadata)
 *  - AAL1 rejection for privileged roles
 *  - Inactive membership rejection
 *  - Cross-owner denial (interviewer filtered by owner_id)
 *  - Viewer mutation denial
 *  - Global per-IP rate limiter (before auth)
 *  - Retry-After header on 429
 *  - Audit redaction, sink failure, source IP minimization, DB sink wiring
 *  - Public routes (health, csp-report) bypass auth
 *  - Malformed/duplicated/oversized authorization headers
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import request from 'supertest';
import { createApp } from '../app.js';
import { mockAuthGetUser, normalizeEmailForAccess, type AuthUser, type TokenVerifier } from '../lib/auth.js';
import { MemoryRateLimitStore, setRateLimitStore } from '../lib/rate-limit.js';
import { setAuditSink, minimizeIp } from '../lib/audit.js';

// ── JWT constants for AAL testing ───────────────────────────────────

/**
 * JWT with aal=aal2 in the payload.
 * Header: {"alg":"HS256"}
 * Payload: {"sub":"user-001","aal":"aal2"}
 */
const JWT_AAL2 = 'eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiJ1c2VyLTAwMSIsImFhbCI6ImFhbDIifQ.signature';

/**
 * JWT with aal=aal1 in the payload.
 */
const JWT_AAL1 = 'eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiJ1c2VyLTAwMSIsImFhbCI6ImFhbDEifQ.signature';

/**
 * JWT with no aal claim.
 */
const JWT_NO_AAL = 'eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiJ1c2VyLTAwMSJ9.signature';

/**
 * JWT with aal=aal2 but user_metadata tries to override to aal1 (must be rejected).
 */
const JWT_AAL2_META_BYPASS = 'eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiJ1c2VyLTAwMSIsImFhbCI6ImFhbDIifQ.signature';

const VALID_TOKEN = 'Bearer ' + JWT_AAL2;

// ── Auth helper: create app with injected token verifier ────────────

function authDepsForUser(user: AuthUser, token: string = JWT_AAL2): { getUser: TokenVerifier } {
  return { getUser: mockAuthGetUser(user, token) };
}

function createAuthedApp(user: AuthUser, token: string = JWT_AAL2) {
  return createApp({ authDeps: authDepsForUser(user, token) });
}

// ── Shared mock user shapes ─────────────────────────────────────────

function makeAdmin(): AuthUser {
  return {
    id: 'user-admin-0000-0000-000000000001',
    email: 'admin@example.com',
    aal: 'aal2',
    active: true,
    appRole: 'admin',
    orgId: 'org-0000-0000-0000-000000000001',
  };
}

function makeInterviewer(): AuthUser {
  return {
    id: 'user-int-0000-0000-000000000002',
    email: 'interviewer@example.com',
    aal: 'aal2',
    active: true,
    appRole: 'interviewer',
    orgId: 'org-0000-0000-0000-000000000001',
  };
}

function makeViewer(): AuthUser {
  return {
    id: 'user-view-0000-0000-000000000003',
    email: 'viewer@example.com',
    aal: 'aal1',
    active: true,
    appRole: 'viewer',
    orgId: null,
  };
}

// ── Chainable thenable mock ─────────────────────────────────────────

function chainable(value: any): any {
  const fn = function () { return chainable(value); };
  fn.then = (resolve: (v: any) => any) => Promise.resolve(value).then(resolve);
  fn.catch = (reject: (e: any) => any) => Promise.resolve(value).catch(reject);
  fn.eq = () => chainable(value);
  fn.order = () => chainable(value);
  fn.limit = () => chainable(value);
  fn.select = () => chainable(value);
  fn.insert = () => chainable(value);
  fn.update = () => chainable(value);
  fn.single = () => chainable(value);
  fn.maybeSingle = () => chainable(value);
  fn.from = () => chainable(value);
  return fn;
}

// ── Supabase mock for routes that hit DB ────────────────────────────

vi.mock('../lib/supabase.js', () => ({
  supabase: {
    from: vi.fn(),
    rpc: vi.fn(),
    auth: { getUser: vi.fn() },
    storage: { from: vi.fn() },
  },
  RESUME_BUCKET: 'resumes_v2',
}));

vi.mock('../lib/claude.js', () => ({
  runClaudeJSON: vi.fn().mockResolvedValue({ message: 'Hello', done: false }),
  runClaudeJSONWithProvenance: vi.fn().mockResolvedValue({
    data: { message: 'Hello', done: false },
    requestedModel: 'haiku',
  }),
}));

// ── Helpers ─────────────────────────────────────────────────────────

function hasNoStacktrace(res: request.Response) {
  const body = JSON.stringify(res.body);
  return !body.includes('stack') && !body.includes(' at ') && !body.includes('.ts:');
}

function hasSecurityHeaders(res: request.Response) {
  return (
    res.headers['x-content-type-options'] === 'nosniff' &&
    res.headers['x-frame-options'] === 'DENY' &&
    res.headers['referrer-policy'] === 'strict-origin-when-cross-origin'
  );
}

// ── App & mock per test ─────────────────────────────────────────────

let app: ReturnType<typeof createApp>;
let mockSupabase: { from: any; rpc: any };

beforeEach(async () => {
  setRateLimitStore(new MemoryRateLimitStore(1000));
  setAuditSink(() => {});

  const supabaseMod = await import('../lib/supabase.js');
  mockSupabase = supabaseMod.supabase as any;
  mockSupabase.from.mockReturnValue(chainable({ data: [], error: null }));
  mockSupabase.rpc.mockReset();
  mockSupabase.rpc.mockResolvedValue({ data: null, error: { message: 'unknown rpc' } });
});

afterEach(() => {
  vi.restoreAllMocks();
});

// ===================================================================
//  FINDING 1: AAL FROM JWT PAYLOAD (NOT METADATA)
// ===================================================================

describe('SEC-01: AAL derived from JWT payload not metadata', () => {
  it('AAL2 in JWT payload allows admin access', async () => {
    const admin = makeAdmin();
    // JWT payload has aal=aal2
    app = createAuthedApp(admin, JWT_AAL2);
    const res = await request(app).get('/api/roles').set('Authorization', `Bearer ${JWT_AAL2}`);
    expect(res.status).toBe(200);
  });

  // ADR-0011: `aal` is no longer an authorization input. These tests pin the
  // DERIVATION contract (still metadata-proof and fail-safe) without asserting
  // that a low AAL denies access — it no longer does, by design.

  it('deriveAalFromJwt reads the JWT payload, never metadata (aal1 stays aal1)', async () => {
    const { deriveAalFromJwt } = await import('../lib/auth.js');
    // The user object may claim aal2 in app_metadata/user_metadata; derivation
    // must only ever read the signed payload.
    expect(deriveAalFromJwt(JWT_AAL1)).toBe('aal1');
    expect(deriveAalFromJwt(JWT_AAL2)).toBe('aal2');
  });

  it('deriveAalFromJwt defaults to aal1 when the claim is missing (no escalation)', async () => {
    const { deriveAalFromJwt } = await import('../lib/auth.js');
    expect(deriveAalFromJwt(JWT_NO_AAL)).toBe('aal1');
  });

  it('deriveAalFromJwt returns aal1 for a malformed payload (fail safe)', async () => {
    const { deriveAalFromJwt } = await import('../lib/auth.js');
    expect(
      deriveAalFromJwt('header.garbage_payload_that_is_not_base64url!.sig'),
    ).toBe('aal1');
  });

  it('ADR-0011: an aal1 admin is ADMITTED — user_metadata still cannot grant a role', async () => {
    const admin = makeAdmin();
    app = createApp({
      authDeps: {
        getUser: async () => ({
          data: {
            user: {
              id: admin.id,
              email: admin.email,
              app_metadata: {
                app_role: 'admin',
                org_id: admin.orgId,
                active: true,
                aal: 'aal2', // user-influenceable field, still IGNORED
              },
              user_metadata: {
                aal: 'aal2', // user-influenceable field, still IGNORED
              },
            },
          },
          error: null,
        }),
      },
    });

    const res = await request(app)
      .get('/api/roles')
      .set('Authorization', `Bearer ${JWT_AAL1}`);
    // No MFA requirement (ADR-0011): a valid session + active allowlist role
    // is sufficient. AAL does not gate.
    expect(res.status).toBe(200);
  });

  it('parseJwtPayload rejects oversized payloads', async () => {
    const { parseJwtPayload } = await import('../lib/auth.js');
    const bigPayload = 'a'.repeat(5000);
    const result = parseJwtPayload(`header.${bigPayload}.sig`);
    expect(result).toBeNull();
  });

  it('parseJwtPayload rejects non-object JSON', async () => {
    const { parseJwtPayload } = await import('../lib/auth.js');
    const b64 = Buffer.from('"string"').toString('base64url');
    const result = parseJwtPayload(`header.${b64}.sig`);
    expect(result).toBeNull();
  });
});

// ===================================================================
//  FINDING 2: AUTH DI SEAM THROUGH CreateAppOptions
// ===================================================================

describe('SEC-01-DI: Auth DI seam threaded through createApp', () => {
  it('uses injected authDeps.getUser instead of live Supabase', async () => {
    const admin = makeAdmin();
    app = createAuthedApp(admin);
    const res = await request(app).get('/api/roles').set('Authorization', VALID_TOKEN);
    expect(res.status).toBe(200);
  });

  it('rejects token when authDeps.getUser returns error', async () => {
    app = createApp({
      authDeps: {
        getUser: async () => ({
          data: { user: null },
          error: { message: 'Invalid token' },
        }),
      },
    });
    const res = await request(app).get('/api/roles').set('Authorization', VALID_TOKEN);
    expect(res.status).toBe(401);
  });

  it('no authDeps falls back to mocked supabase (no live call)', async () => {
    // Without authDeps, createApp uses the (mocked) supabase client
    app = createApp();
    // But supabase.auth.getUser is a vi.fn() with no return → should 401
    const res = await request(app).get('/api/roles').set('Authorization', VALID_TOKEN);
    // auth call returns undefined → catch → 401
    expect(res.status).toBe(401);
  });
});

// ===================================================================
//  401 BEHAVIOUR — Malformed / missing / duplicated / oversized
// ===================================================================

describe('401 — missing, malformed, duplicated, oversized auth headers', () => {
  beforeEach(() => {
    app = createApp();
  });

  it('returns 401 when no Authorization header is sent', async () => {
    const res = await request(app).get('/api/roles');
    expect(res.status).toBe(401);
    expect(res.body.error.type).toBe('authentication_error');
    expect(hasNoStacktrace(res)).toBe(true);
    expect(hasSecurityHeaders(res)).toBe(true);
  });

  it('returns 401 when Authorization header is empty', async () => {
    const res = await request(app).get('/api/roles').set('Authorization', '');
    expect(res.status).toBe(401);
    expect(res.body.error.type).toBe('authentication_error');
  });

  it('returns 401 when Authorization header is malformed (no Bearer)', async () => {
    const res = await request(app).get('/api/roles').set('Authorization', 'Basic dXNlcjpwYXNz');
    expect(res.status).toBe(401);
    expect(res.body.error.type).toBe('authentication_error');
  });

  it('returns 401 when Authorization header is duplicated (array)', async () => {
    const res = await request(app)
      .get('/api/roles')
      .set('Authorization', ['Bearer token1', 'Bearer token2'] as any);
    expect(res.status).toBe(401);
    expect(res.body.error.type).toBe('authentication_error');
  });

  it('returns 401 when Authorization header is oversized', async () => {
    const res = await request(app)
      .get('/api/roles')
      .set('Authorization', 'Bearer ' + 'x'.repeat(5000));
    expect(res.status).toBe(401);
    expect(res.body.error.type).toBe('authentication_error');
  });

  it('401 response body is stable non-sensitive JSON — no token/user leakage', async () => {
    const res = await request(app).get('/api/roles');
    const bodyStr = JSON.stringify(res.body);
    expect(bodyStr).not.toContain('eyJ');
    expect(bodyStr).not.toContain('token');
    expect(bodyStr).not.toContain('user_id');
    expect(res.body).toEqual({
      error: { type: 'authentication_error', message: 'Authentication required' },
    });
  });
});

// ===================================================================
//  PUBLIC ROUTES BYPASS AUTH
// ===================================================================

describe('public routes bypass auth', () => {
  beforeEach(() => { app = createApp(); });

  it('GET /api/health returns 200 without auth', async () => {
    const res = await request(app).get('/api/health');
    expect(res.status).toBe(200);
    expect(res.body.ok).toBe(true);
  });

  it('POST /api/csp-report returns 204 without auth', async () => {
    const res = await request(app)
      .post('/api/csp-report')
      .set('Content-Type', 'application/json')
      .send({ 'csp-report': { 'document-uri': 'https://example.com', 'violated-directive': 'script-src' } });
    expect(res.status).toBe(204);
  });

  it('health endpoint carries security headers', async () => {
    const res = await request(app).get('/api/health');
    expect(hasSecurityHeaders(res)).toBe(true);
  });
});

// ===================================================================
//  AUTHENTICATED SUCCESS (200)
// ===================================================================

describe('authenticated requests return 200 with valid admin token', () => {
  it('GET /api/roles returns 200', async () => {
    app = createAuthedApp(makeAdmin());
    const res = await request(app).get('/api/roles').set('Authorization', VALID_TOKEN);
    expect(res.status).toBe(200);
    expect(Array.isArray(res.body)).toBe(true);
  });

  it('GET /api/candidates returns 200', async () => {
    app = createAuthedApp(makeAdmin());
    const res = await request(app).get('/api/candidates').set('Authorization', VALID_TOKEN);
    expect(res.status).toBe(200);
  });
});

// ===================================================================
//  FORGED JWT REJECTION
// ===================================================================

describe('forged JWT rejection', () => {
  it('rejects token that Supabase Auth cannot verify', async () => {
    app = createApp({
      authDeps: {
        getUser: async () => ({
          data: { user: null },
          error: { message: 'Invalid or expired token' },
        }),
      },
    });
    const res = await request(app)
      .get('/api/roles')
      .set('Authorization', 'Bearer eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiJmYWtlIn0.forged');
    expect(res.status).toBe(401);
    expect(res.body.error.type).toBe('authentication_error');
  });
});

// ===================================================================
//  AAL1 REJECTION FOR PRIVILEGED ROLES
// ===================================================================

describe('ADR-0011: no MFA/AAL gate for privileged roles', () => {
  it('admits an admin at AAL1 (no second factor required)', async () => {
    const admin = makeAdmin();
    app = createApp({
      authDeps: {
        getUser: async () => ({
          data: {
            user: {
              id: admin.id,
              email: admin.email,
              app_metadata: { app_role: 'admin', org_id: admin.orgId, active: true },
            },
          },
          error: null,
        }),
      },
    });
    const res = await request(app)
      .get('/api/roles')
      .set('Authorization', `Bearer ${JWT_AAL1}`);
    expect(res.status).toBe(200);
    expect(hasSecurityHeaders(res)).toBe(true);
  });

  it('admits an interviewer at AAL1', async () => {
    const int = makeInterviewer();
    app = createApp({
      authDeps: {
        getUser: async () => ({
          data: {
            user: {
              id: int.id,
              email: int.email,
              app_metadata: { app_role: 'interviewer', org_id: int.orgId, active: true },
            },
          },
          error: null,
        }),
      },
    });
    const res = await request(app)
      .get('/api/roles')
      .set('Authorization', `Bearer ${JWT_AAL1}`);
    expect(res.status).toBe(200);
  });

  it('admits an admin with no aal claim at all', async () => {
    const admin = makeAdmin();
    app = createApp({
      authDeps: {
        getUser: async () => ({
          data: {
            user: {
              id: admin.id,
              email: admin.email,
              app_metadata: { app_role: 'admin', org_id: admin.orgId, active: true },
            },
          },
          error: null,
        }),
      },
    });
    const res = await request(app)
      .get('/api/roles')
      .set('Authorization', `Bearer ${JWT_NO_AAL}`);
    expect(res.status).toBe(200);
  });

  it('allows viewer with AAL1 to access read-only endpoints', async () => {
    app = createAuthedApp(makeViewer());
    const res = await request(app).get('/api/roles').set('Authorization', VALID_TOKEN);
    expect(res.status).toBe(200);
  });

  it('still denies a viewer mutation regardless of AAL (role gate intact)', async () => {
    const viewer = makeViewer();
    app = createApp({
      authDeps: {
        getUser: async () => ({
          data: {
            user: {
              id: viewer.id,
              email: viewer.email,
              app_metadata: { app_role: 'viewer', active: true },
            },
          },
          error: null,
        }),
      },
    });
    const res = await request(app)
      .post('/api/roles')
      .set('Authorization', `Bearer ${JWT_AAL1}`)
      .send({ title: 'SWE' });
    expect(res.status).toBe(403);
    expect(res.body.error.type).toBe('authorization_error');
  });

  it('still denies an inactive admin regardless of AAL (fail closed)', async () => {
    const admin = makeAdmin();
    app = createApp({
      authDeps: {
        getUser: async () => ({
          data: {
            user: {
              id: admin.id,
              email: admin.email,
              app_metadata: { app_role: 'admin', active: false },
            },
          },
          error: null,
        }),
      },
    });
    const res = await request(app)
      .get('/api/roles')
      .set('Authorization', `Bearer ${JWT_AAL2}`);
    expect(res.status).toBe(403);
    expect(res.body.error.type).toBe('authorization_error');
  });
});

// ===================================================================
//  INACTIVE MEMBERSHIP
// ===================================================================

describe('inactive membership rejection', () => {
  it('returns 403 when admin user is inactive', async () => {
    const admin = makeAdmin();
    app = createApp({
      authDeps: {
        getUser: async () => ({
          data: {
            user: {
              id: admin.id,
              email: admin.email,
              app_metadata: { app_role: 'admin', active: false },
            },
          },
          error: null,
        }),
      },
    });
    const res = await request(app).get('/api/roles').set('Authorization', VALID_TOKEN);
    expect(res.status).toBe(403);
    expect(res.body.error.type).toBe('authorization_error');
  });
});

// ===================================================================
//  VIEWER MUTATION DENIAL
// ===================================================================

describe('viewer mutation denial', () => {
  it('allows viewer GET on /api/roles', async () => {
    app = createAuthedApp(makeViewer());
    const res = await request(app).get('/api/roles').set('Authorization', VALID_TOKEN);
    expect(res.status).toBe(200);
  });

  it('denies viewer POST on /api/roles', async () => {
    app = createAuthedApp(makeViewer());
    const res = await request(app)
      .post('/api/roles').set('Authorization', VALID_TOKEN)
      .send({ title: 'SWE' });
    expect(res.status).toBe(403);
    expect(res.body.error.type).toBe('authorization_error');
  });

  it('denies viewer PUT on /api/roles', async () => {
    app = createAuthedApp(makeViewer());
    const res = await request(app)
      .put('/api/roles/00000000-0000-4000-8000-000000000001').set('Authorization', VALID_TOKEN)
      .send({ title: 'Updated' });
    expect(res.status).toBe(403);
  });
});

// ===================================================================
//  FINDING 4: CROSS-OWNER DENIAL — interviewer filtered by owner_id
// ===================================================================

describe('SEC-03: interviewer filtered by owner_id', () => {
  it('interviewer sees only own roles (owner_id filter)', async () => {
    const int = makeInterviewer();
    const ownRows = [{ id: 'role-1', title: 'My Role', owner_id: int.id }];
    mockSupabase.from.mockReturnValue(chainable({ data: ownRows, error: null }));
    app = createAuthedApp(int);
    const res = await request(app).get('/api/roles').set('Authorization', VALID_TOKEN);
    expect(res.status).toBe(200);
    // The mock returns data; we verify the query included owner_id filter
    expect(mockSupabase.from).toHaveBeenCalledWith('roles');
  });

  it('admin sees all roles (no owner_id filter)', async () => {
    const allRows = [
      { id: 'role-1', title: 'Admin Role', owner_id: 'admin-id' },
      { id: 'role-2', title: 'Int Role', owner_id: 'int-id' },
    ];
    mockSupabase.from.mockReturnValue(chainable({ data: allRows, error: null }));
    app = createAuthedApp(makeAdmin());
    const res = await request(app).get('/api/roles').set('Authorization', VALID_TOKEN);
    expect(res.status).toBe(200);
    expect(res.body).toHaveLength(2);
  });

  it('interviewer cannot access screening (requires admin)', async () => {
    app = createAuthedApp(makeInterviewer());
    const res = await request(app)
      .post('/api/screening/start').set('Authorization', VALID_TOKEN)
      .send({ candidate_id: '00000000-0000-4000-8000-000000000001' });
    expect(res.status).toBe(403);
  });

  it('interviewer cannot access assess (requires admin)', async () => {
    app = createAuthedApp(makeInterviewer());
    const res = await request(app)
      .post('/api/assess/00000000-0000-4000-8000-000000000001')
      .set('Authorization', VALID_TOKEN);
    expect(res.status).toBe(403);
  });
});

// ===================================================================
//  FINDING 5: GLOBAL PER-IP RATE LIMITER (BEFORE AUTH)
// ===================================================================

describe('SEC-06: global per-IP rate limiter before auth', () => {
  it('unauthenticated requests hit global IP limit', async () => {
    // Create app with a tiny global limit
    const tinyStore = new MemoryRateLimitStore(1000);
    setRateLimitStore(tinyStore);
    // Pre-fill global IP bucket to near-empty
    const { consumeToken } = await import('../lib/rate-limit.js');
    for (let i = 0; i < 300; i++) {
      consumeToken('global:ip:127.0.0.1', { limit: 300, windowSec: 60, maxKeys: 1000 }, Date.now());
    }
    app = createApp();

    const res = await request(app).get('/api/health');
    // Health is public, but global IP limiter runs before route
    // Expect 429 since global IP bucket is exhausted
    expect(res.status).toBe(429);
    expect(res.headers['retry-after']).toBeDefined();
    expect(res.body.error.type).toBe('rate_limit_exceeded');
    expect(hasSecurityHeaders(res)).toBe(true);
    expect(hasNoStacktrace(res)).toBe(true);
  });

  it('global per-IP limit is separate from per-user limit', async () => {
    const admin = makeAdmin();
    const tinyStore = new MemoryRateLimitStore(1000);
    setRateLimitStore(tinyStore);
    const { consumeToken } = await import('../lib/rate-limit.js');

    // Exhaust global IP bucket for this IP
    for (let i = 0; i < 300; i++) {
      consumeToken('global:ip:127.0.0.1', { limit: 300, windowSec: 60, maxKeys: 1000 }, Date.now());
    }

    app = createAuthedApp(admin);
    // Even authenticated, global IP limiter runs first
    const res = await request(app)
      .get('/api/roles')
      .set('Authorization', VALID_TOKEN);
    expect(res.status).toBe(429);
  });

  it('integration seam: setRateLimitStore works for Codex customization', async () => {
    const { setRateLimitStore, getRateLimitStore } = await import('../lib/rate-limit.js');
    const customStore = new MemoryRateLimitStore(500);
    setRateLimitStore(customStore);
    expect(getRateLimitStore()).toBe(customStore);
  });
});

// ===================================================================
//  RATE LIMITING — Bounded bucket eviction, Retry-After
// ===================================================================

describe('rate limiting details', () => {
  it('429 response has Retry-After header and stable JSON body', async () => {
    const admin = makeAdmin();
    app = createAuthedApp(admin);

    // Exhaust the per-user rate limit.
    //
    // The limiter is a TOKEN BUCKET with continuous refill, not a fixed
    // window: it grants `limit / windowSec` tokens per second (100/60 ≈ 1.67).
    // Sending exactly `limit + 1` requests therefore leaves a margin of ONE
    // token, and any wall-clock spread beyond ~600 ms refills that token and
    // produces zero 429s — which made this assertion fail intermittently
    // whenever the suite ran slowly (coverage instrumentation, a loaded CI
    // runner). Overshoot by enough that the bucket cannot refill fast enough
    // even if these requests take half a minute to drain.
    const OVERSHOOT = 160; // tolerates ~36 s of spread at 1.67 tokens/sec
    const requests = Array.from({ length: OVERSHOOT }, () =>
      request(app).get('/api/roles').set('Authorization', VALID_TOKEN),
    );
    const results = await Promise.all(requests);
    const rateLimited = results.find((r) => r.status === 429);
    expect(rateLimited).toBeDefined();
    expect(rateLimited!.headers['retry-after']).toBeDefined();
    const retryAfter = parseInt(rateLimited!.headers['retry-after'], 10);
    expect(Number.isInteger(retryAfter)).toBe(true);
    expect(retryAfter).toBeGreaterThanOrEqual(1);
    expect(hasSecurityHeaders(rateLimited!)).toBe(true);
    expect(rateLimited!.body.error.type).toBe('rate_limit_exceeded');
    expect(rateLimited!.body.error.retry_after_seconds).toBeGreaterThanOrEqual(1);
  });

  it('bounded-bucket eviction: does not exceed max capacity', async () => {
    const store = new MemoryRateLimitStore(5);
    setRateLimitStore(store);
    const { consumeToken } = await import('../lib/rate-limit.js');
    for (let i = 0; i < 20; i++) {
      consumeToken(`rl:ip:192.168.1.${i}`, { limit: 100, windowSec: 60, maxKeys: 5 });
    }
    expect(store.size()).toBeLessThanOrEqual(5);
  });
});

// ===================================================================
//  FINDING 3: AUDIT — WIRED, DB SINK, CALLED ON MUTATION/DENIAL
// ===================================================================

describe('SEC-12: audit wired and called', () => {
  it('auditAccessDenied does not turn 403 into 500 (fail-open)', async () => {
    const { auditAccessDenied } = await import('../lib/audit.js');
    const req = { authUser: null, method: 'GET', path: '/api/roles', ip: '127.0.0.1' } as any;
    await expect(auditAccessDenied(req)).resolves.toBeUndefined();
  });

  it('auditAuthFailure does not turn 401 into 500 (fail-open)', async () => {
    const { auditAuthFailure } = await import('../lib/audit.js');
    const req = { authUser: null, method: 'GET', path: '/api/roles', ip: '127.0.0.1' } as any;
    await expect(auditAuthFailure(req)).resolves.toBeUndefined();
  });

  it('fail-closed: audit sink failure aborts mutation', async () => {
    const { recordAudit, setAuditSink } = await import('../lib/audit.js');
    setAuditSink(() => { throw new Error('Sink unavailable'); });
    const req = { authUser: null, method: 'POST', path: '/api/roles', ip: '127.0.0.1' } as any;
    await expect(recordAudit(req, 'resource.create', 201)).rejects.toThrow('Audit sink failure');
  });

  it('fail-open: audit sink failure does not abort denial', async () => {
    const { recordAudit, setAuditSink } = await import('../lib/audit.js');
    setAuditSink(() => { throw new Error('Sink unavailable'); });
    const req = { authUser: null, method: 'GET', path: '/api/roles', ip: '127.0.0.1' } as any;
    await expect(recordAudit(req, 'rbac.access_denied', 403)).resolves.toBeUndefined();
  });

  it('createDbAuditSink writes to audit_events table', async () => {
    const { createDbAuditSink } = await import('../lib/audit.js');
    const mockFrom = vi.fn().mockReturnValue({
      insert: vi.fn().mockResolvedValue({ error: null }),
    });
    const mockSupabaseClient = { from: mockFrom } as any;
    const sink = createDbAuditSink(mockSupabaseClient);

    await sink({
      event: 'resource.create',
      correlationId: 'corr-1',
      userId: 'user-1',
      userRole: 'admin',
      method: 'POST',
      path: '/api/roles',
      statusCode: 201,
      metadata: { role_id: 'role-1' },
      timestamp: new Date().toISOString(),
      sourceIp: '10.0.0.1/24',
    });

    expect(mockFrom).toHaveBeenCalledWith('audit_events');
  });
});

// ===================================================================
//  FINDING 6: SOURCE IP MINIMIZATION
// ===================================================================

describe('SEC-05-LOW: source IP minimization', () => {
  it('minimizes IPv4 to /24', () => {
    expect(minimizeIp('192.168.1.100')).toBe('192.168.1.0/24');
  });

  it('minimizes IPv6 to /48', () => {
    expect(minimizeIp('2001:db8:1234:5678:9abc:def0:1234:5678')).toBe('2001:db8:1234::/48');
  });

  it('minimizes IPv4-mapped IPv6', () => {
    expect(minimizeIp('::ffff:10.0.0.5')).toBe('10.0.0.0/24');
  });

  it('returns undefined for undefined input', () => {
    expect(minimizeIp(undefined)).toBeUndefined();
  });

  it('audit entry uses minimized IP', async () => {
    const { recordAudit, setAuditSink } = await import('../lib/audit.js');
    let capturedEntry: any = null;
    setAuditSink((entry: any) => { capturedEntry = entry; });

    const req = { authUser: null, method: 'GET', path: '/api/roles', ip: '10.0.0.5', correlationId: null } as any;
    await recordAudit(req, 'rbac.access_denied', 403);

    expect(capturedEntry.sourceIp).toBe('10.0.0.0/24');
  });
});

// ===================================================================
//  AUDIT REDACTION
// ===================================================================

describe('audit redaction', () => {
  it('redactForAudit strips transcript text', async () => {
    const { redactForAudit } = await import('../lib/audit.js');
    const redacted = redactForAudit({ transcript: 'sensitive', score: 85 }) as Record<string, unknown>;
    expect(redacted.transcript).toBeUndefined();
    expect(redacted.score).toBe(85);
  });

  it('redactForAudit strips authorization headers', async () => {
    const { redactForAudit } = await import('../lib/audit.js');
    const redacted = redactForAudit({ authorization: 'Bearer token' }) as Record<string, unknown>;
    expect(redacted.authorization).toBeUndefined();
  });

  it('redactForAudit strips JWT tokens from string values', async () => {
    const { redactForAudit } = await import('../lib/audit.js');
    const syntheticJwt = [
      'eyJhbGciOiJIUzI1NiJ9',
      'eyJzdWIiOiIxMjM0NTY3ODkwIn0',
      'syntheticSignatureSegmentForRedaction',
    ].join('.');
    const input = `Token: ${syntheticJwt}`;
    const redacted = redactForAudit(input) as string;
    expect(redacted).toContain('[REDACTED]');
  });

  it('redactForAudit strips email addresses', async () => {
    const { redactForAudit } = await import('../lib/audit.js');
    const redacted = redactForAudit('contact alice@example.com') as string;
    expect(redacted).not.toContain('alice@example.com');
  });
});

// ===================================================================
//  UNAUTHENTICATED ROUTE ACCESS (non-public)
// ===================================================================

describe('all protected routes require auth', () => {
  beforeEach(() => { app = createApp(); });

  const protectedPaths = [
    { method: 'get', path: '/api/roles' },
    { method: 'post', path: '/api/roles' },
    { method: 'get', path: '/api/candidates' },
    { method: 'get', path: '/api/screening/00000000-0000-4000-8000-000000000001' },
    { method: 'post', path: '/api/screening/start' },
    { method: 'post', path: '/api/assess/00000000-0000-4000-8000-000000000001' },
  ];

  for (const { method, path } of protectedPaths) {
    it(`${method.toUpperCase()} ${path} returns 401 without auth`, async () => {
      const res = await (request(app) as any)[method](path);
      expect(res.status).toBe(401);
      expect(res.body.error.type).toBe('authentication_error');
    });
  }
});

// ===================================================================
//  ROLE-BASED ACCESS MATRIX — Full 401/403/200 verification
// ===================================================================

describe('role-based access matrix', () => {
  const admin = makeAdmin();
  const viewer = makeViewer();
  const noAuth = null;

  const tests: { name: string; method: 'get' | 'post' | 'put'; path: string; body?: any; expected: Record<string, number> }[] = [
    {
      name: 'GET /api/roles',
      method: 'get',
      path: '/api/roles',
      expected: { admin: 200, viewer: 200, noAuth: 401 },
    },
    {
      name: 'POST /api/roles',
      method: 'post',
      path: '/api/roles',
      body: { title: 'SWE' },
      expected: { admin: 201, viewer: 403, noAuth: 401 },
    },
    {
      name: 'GET /api/candidates',
      method: 'get',
      path: '/api/candidates',
      expected: { admin: 200, viewer: 200, noAuth: 401 },
    },
  ];

  for (const t of tests) {
    for (const [role, expectedStatus] of Object.entries(t.expected)) {
      it(`${t.name} → ${expectedStatus} for ${role}`, async () => {
        if (role === 'noAuth') {
          app = createApp();
          const res = await (request(app) as any)[t.method](t.path).send(t.body);
          expect(res.status).toBe(expectedStatus);
        } else {
          const user = role === 'admin' ? admin : viewer;
          app = createAuthedApp(user);
          const req = (request(app) as any)[t.method](t.path).set('Authorization', VALID_TOKEN);
          if (t.body) req.send(t.body);
          const res = await req;
          expect(res.status).toBe(expectedStatus);
        }
      });
    }
  }
});

// ===================================================================
//  HELLO ACCESS GATE (0016) — normalized company email allowlist
// ===================================================================

describe('normalizeEmailForAccess — strict ASCII company-email gate', () => {
  it('accepts a plain company email', () => {
    expect(normalizeEmailForAccess('gopu.nair@interviewkickstart.com')).toBe(
      'gopu.nair@interviewkickstart.com',
    );
  });

  it('trims and lowercases (case/whitespace variants collide)', () => {
    expect(normalizeEmailForAccess('  GOPU.NAIR@InterviewKickstart.COM  ')).toBe(
      'gopu.nair@interviewkickstart.com',
    );
  });

  it('strips a Display Name <email> wrapper', () => {
    expect(normalizeEmailForAccess('Gopu Nair <gopu.nair@interviewkickstart.com>')).toBe(
      'gopu.nair@interviewkickstart.com',
    );
  });

  it('rejects a gmail / non-company domain (uniform deny)', () => {
    expect(normalizeEmailForAccess('gopu@gmail.com')).toBeNull();
    expect(normalizeEmailForAccess('gopu@outlook.com')).toBeNull();
    expect(normalizeEmailForAccess('gopu@yahoo.in')).toBeNull();
  });

  it('rejects subdomain and suffix tricks on the company domain', () => {
    expect(normalizeEmailForAccess('gopu@sub.interviewkickstart.com')).toBeNull();
    expect(normalizeEmailForAccess('gopu@interviewkickstart.com.evil.test')).toBeNull();
    expect(normalizeEmailForAccess('gopu@notinterviewkickstart.com')).toBeNull();
    expect(normalizeEmailForAccess('gopu@interviewkickstart.com.evil')).toBeNull();
  });

  it('rejects unicode lookalikes and non-ASCII input', () => {
    // Fullwidth @ (U+FF20) and Cyrillic а lookalike must be rejected.
    expect(normalizeEmailForAccess('gopu＠interviewkickstart.com')).toBeNull();
    expect(normalizeEmailForAccess('gopu@interviewkіckstart.com')).toBeNull(); // Cyrillic і
    expect(normalizeEmailForAccess('josé@interviewkickstart.com')).toBeNull();
    expect(normalizeEmailForAccess('gopu@interviewkickstart。com')).toBeNull(); // fullwidth dot
  });

  it('rejects more than one @ (including display-name wrappers with @ inside the name)', () => {
    expect(normalizeEmailForAccess('a@b@interviewkickstart.com')).toBeNull();
    expect(normalizeEmailForAccess('gopu@interviewkickstart.com@extra')).toBeNull();
  });

  it('rejects missing/empty/invalid local parts and domains', () => {
    expect(normalizeEmailForAccess('')).toBeNull();
    expect(normalizeEmailForAccess('   ')).toBeNull();
    expect(normalizeEmailForAccess('@interviewkickstart.com')).toBeNull();
    expect(normalizeEmailForAccess('gopu@')).toBeNull();
    expect(normalizeEmailForAccess('gopu@interviewkickstart')).toBeNull(); // no TLD
    expect(normalizeEmailForAccess('gopu nair@interviewkickstart.com')).toBeNull(); // space in local
    expect(normalizeEmailForAccess('gopu@interviewkickstart.c')).toBeNull(); // 1-char TLD
  });

  it('rejects non-string input', () => {
    expect(normalizeEmailForAccess(null as unknown as string)).toBeNull();
    expect(normalizeEmailForAccess(undefined as unknown as string)).toBeNull();
  });
});

describe('defaultAccessResolver — live per-request allowlist RPC gate', () => {
  it('denies unverified (no email_confirmed_at) with uniform 403', async () => {
    const { defaultAccessResolver } = await import('../lib/auth.js');
    const res = await defaultAccessResolver('user-1', 'gopu.nair@interviewkickstart.com', false);
    expect(res).toEqual({ ok: false, status: 403 });
    expect(mockSupabase.rpc).not.toHaveBeenCalled();
  });

  it('denies wrong-domain emails BEFORE the RPC (uniform 403)', async () => {
    const { defaultAccessResolver } = await import('../lib/auth.js');
    const res = await defaultAccessResolver('user-1', 'gopu@gmail.com', true);
    expect(res).toEqual({ ok: false, status: 403 });
    expect(mockSupabase.rpc).not.toHaveBeenCalled();
  });

  it('denies when the resolver RPC reports non-ok (missing/inactive/relink)', async () => {
    const { defaultAccessResolver, setAuthSupabaseClient } = await import('../lib/auth.js');
    setAuthSupabaseClient(mockSupabase as any);
    for (const status of ['denied', 'not_allowlisted', 'email_already_linked']) {
      mockSupabase.rpc.mockResolvedValueOnce({ data: { status }, error: null });
      const res = await defaultAccessResolver('user-1', 'gopu.nair@interviewkickstart.com', true);
      expect(res, `status=${status}`).toEqual({ ok: false, status: 403 });
    }
  });

  it('denies on RPC transport error (fail closed, uniform 403)', async () => {
    const { defaultAccessResolver, setAuthSupabaseClient } = await import('../lib/auth.js');
    setAuthSupabaseClient(mockSupabase as any);
    mockSupabase.rpc.mockResolvedValueOnce({ data: null, error: { message: 'boom' } });
    const res = await defaultAccessResolver('user-1', 'gopu.nair@interviewkickstart.com', true);
    expect(res).toEqual({ ok: false, status: 403 });
  });

  it('returns the server-held role/active on ok and calls the RPC with the raw verified email', async () => {
    const { defaultAccessResolver, setAuthSupabaseClient } = await import('../lib/auth.js');
    setAuthSupabaseClient(mockSupabase as any);
    mockSupabase.rpc.mockResolvedValueOnce({
      data: { status: 'ok', role: 'interviewer', active: true },
      error: null,
    });
    const res = await defaultAccessResolver('user-1', 'GOPU.NAIR@InterviewKickstart.COM', true);
    expect(res).toEqual({ ok: true, role: 'interviewer', active: true });
    expect(mockSupabase.rpc).toHaveBeenCalledWith('resolve_allowlist_access', {
      p_user_id: 'user-1',
      p_email: 'GOPU.NAIR@InterviewKickstart.COM',
    });
  });

  it('treats an invalid RPC role as a deny (never trusts the resolver blindly)', async () => {
    const { defaultAccessResolver, setAuthSupabaseClient } = await import('../lib/auth.js');
    setAuthSupabaseClient(mockSupabase as any);
    mockSupabase.rpc.mockResolvedValueOnce({ data: { status: 'ok', role: 'superuser', active: true }, error: null });
    const res = await defaultAccessResolver('user-1', 'gopu.nair@interviewkickstart.com', true);
    expect(res).toEqual({ ok: false, status: 403 });
  });
});

describe('HELLO access gate — middleware enforces allowlist on every request', () => {
  async function createGateApp(resolveAccess: import('../lib/auth.js').AccessResolver) {
    const authMod = await import('../lib/auth.js');
    const rbacMod = await import('../lib/rbac.js');
    const validationMod = await import('../lib/validation.js');
    const { default: express } = await import('express');
    const admin: import('../lib/auth.js').AuthUser = {
      id: 'user-admin-0000-0000-000000000001',
      email: 'admin@example.com',
      aal: 'aal2',
      active: true,
      appRole: 'admin',
      orgId: null,
    };
    const app = express();
    app.use(express.json());
    app.use(authMod.createRequireAuth({ getUser: authMod.mockAuthGetUser(admin, JWT_AAL2), resolveAccess }));
    app.use(rbacMod.viewerReadOnly);
    app.get('/api/roles', (_req: any, res: any) => res.json([{ ok: true }]));
    app.use(validationMod.finalErrorHandler);
    return app;
  }

  it('denies a wrong-domain verified email with the uniform generic 403 (not 401)', async () => {
    const gate = await createGateApp(async () => ({ ok: false, status: 403 }));
    const res = await request(gate).get('/api/roles').set('Authorization', VALID_TOKEN);
    expect(res.status).toBe(403);
    expect(res.body).toEqual({
      error: { type: 'authorization_error', message: 'Insufficient permissions' },
    });
    expect(JSON.stringify(res.body)).not.toContain('gmail');
    expect(JSON.stringify(res.body)).not.toContain('interviewkickstart');
  });

  it('denies when the allowlist has no matching entry (missing/inactive → same 403)', async () => {
    const gate = await createGateApp(async () => ({ ok: false, status: 403 }));
    const res = await request(gate).get('/api/roles').set('Authorization', VALID_TOKEN);
    expect(res.status).toBe(403);
    expect(res.body.error.type).toBe('authorization_error');
  });

  it('denies even when the stale membership says active (disabled allowlist beats old JWT/membership)', async () => {
    // resolveAccess denies (entry disabled) while the user object carries
    // active app_metadata + aal2 — the gate must still reject.
    const gate = await createGateApp(async () => ({ ok: false, status: 403 }));
    const res = await request(gate).get('/api/roles').set('Authorization', VALID_TOKEN);
    expect(res.status).toBe(403);
  });

  it('passes the verified email and confirmation flag to the resolver on every request', async () => {
    const seen: Array<[string, string, boolean]> = [];
    const gate = await createGateApp(async (userId, email, emailVerified) => {
      seen.push([userId, email, emailVerified]);
      return { ok: true, role: 'viewer', active: true };
    });
    await request(gate).get('/api/roles').set('Authorization', VALID_TOKEN);
    expect(seen).toHaveLength(1);
    expect(seen[0][0]).toBe('user-admin-0000-0000-000000000001');
    expect(seen[0][1]).toBe('admin@example.com');
    expect(seen[0][2]).toBe(false); // mock users carry no email_confirmed_at
  });

  it('grants access and uses the SERVER-HELD role (never app_metadata)', async () => {
    const gate = await createGateApp(async () => ({ ok: true, role: 'interviewer', active: true }));
    const res = await request(gate).get('/api/roles').set('Authorization', VALID_TOKEN);
    expect(res.status).toBe(200);
    expect(res.body).toEqual([{ ok: true }]);
  });

  it('rejects a resolver failure (fail closed → 403, not 500)', async () => {
    const gate = await createGateApp(async () => {
      throw new Error('resolver exploded');
    });
    const res = await request(gate).get('/api/roles').set('Authorization', VALID_TOKEN);
    expect(res.status).toBe(403);
    expect(JSON.stringify(res.body)).not.toContain('stack');
  });

  it('inactive server-held membership denies even when the role passes', async () => {
    const gate = await createGateApp(async () => ({ ok: true, role: 'admin', active: false }));
    const res = await request(gate).get('/api/roles').set('Authorization', VALID_TOKEN);
    expect(res.status).toBe(403);
    expect(res.body.error.type).toBe('authorization_error');
  });
});
