/**
 * ADR-0011 regression suite — single-factor auth with server-side allowlist
 * authorization.
 *
 * Pins the invariant that replaced the AAL2/MFA gates:
 *
 *   Access requires ALL of
 *     1. a valid Supabase session (verified, never merely decoded);
 *     2. a Supabase-verified email;
 *     3. an ACTIVE entry in the server-held allowlist, resolved on EVERY
 *        request;
 *     4. the role held in that server-held entry.
 *
 *   Access requires NO second factor. `aal` is not an authorization input.
 *
 * Explicitly proves authorization is NOT derived from client claims,
 * app_metadata/user_metadata, or email domain alone.
 *
 * All fixtures are synthetic — no real user or allowlist data.
 */

import { describe, it, expect } from 'vitest';
import request from 'supertest';
import express from 'express';
// Static imports: the helper below is called once per test, and re-importing
// these dynamically each time made the first test in the file pay the whole
// module-graph cost and time out under full-suite load.
import {
  createRequireAuth,
  mockAuthGetUser,
  normalizeEmailForAccess,
  defaultAccessResolver,
  deriveAalFromJwt,
  type AccessResolver,
  type AuthUser,
  type TokenVerifier,
} from '../lib/auth.js';
import { requireRole } from '../lib/rbac.js';
import { finalErrorHandler } from '../lib/validation.js';

// ── Synthetic JWTs (unsigned; the verifier is always injected) ────────

/** Payload: {"sub":"user-001","aal":"aal2"} */
const JWT_AAL2 =
  'eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiJ1c2VyLTAwMSIsImFhbCI6ImFhbDIifQ.signature';
/** Payload: {"sub":"user-001","aal":"aal1"} — ordinary single-factor sign-in */
const JWT_AAL1 =
  'eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiJ1c2VyLTAwMSIsImFhbCI6ImFhbDEifQ.signature';
/** Payload: {"sub":"user-001"} — no aal claim at all */
const JWT_NO_AAL = 'eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiJ1c2VyLTAwMSJ9.signature';

const AAL1_BEARER = `Bearer ${JWT_AAL1}`;

// ── Synthetic users ──────────────────────────────────────────────────

const SYNTHETIC_USER_ID = 'user-0000-0000-0000-000000000001';
const SYNTHETIC_EMAIL = 'synthetic.user@interviewkickstart.com';

type Role = 'admin' | 'interviewer' | 'viewer';

function syntheticAuthUser(appRole: Role, aal = 'aal1'): AuthUser {
  return {
    id: SYNTHETIC_USER_ID,
    email: SYNTHETIC_EMAIL,
    aal,
    active: true,
    appRole,
    orgId: null,
    emailVerified: true,
  };
}

/**
 * Minimal app exercising the real requireAuth middleware with an injected
 * verifier and allowlist resolver. `GET /api/whoami` echoes the SERVER-HELD
 * role so tests can prove the role came from the resolver, not the client.
 */
function createGateApp(opts: {
  resolveAccess?: AccessResolver;
  getUser?: TokenVerifier;
  user?: AuthUser;
  token?: string;
}) {
  const user = opts.user ?? syntheticAuthUser('admin');
  const token = opts.token ?? JWT_AAL1;

  const app = express();
  app.use(express.json());
  app.use(
    createRequireAuth({
      getUser: opts.getUser ?? mockAuthGetUser(user, token),
      resolveAccess: opts.resolveAccess,
    }),
  );
  app.get('/api/whoami', (req: any, res: any) =>
    res.json({ role: req.authUser?.appRole, aal: req.authUser?.aal }),
  );
  app.post('/api/admin-only', requireRole('admin'), (_req: any, res: any) =>
    res.json({ ok: true }),
  );
  app.post('/api/interviewer-only', requireRole('interviewer'), (_req: any, res: any) =>
    res.json({ ok: true }),
  );
  app.use(finalErrorHandler);
  return app;
}

const ALLOW = (role: Role): AccessResolver =>
  async () => ({ ok: true, role, active: true });
const DENY: AccessResolver = async () => ({
  ok: false,
  status: 403,
});

// ═════════════════════════════════════════════════════════════════════
//  1. Ordinary single-factor sign-in is ADMITTED
// ═════════════════════════════════════════════════════════════════════

describe('ADR-0011: allowlisted ordinary sign-in is admitted with the correct role', () => {
  it('admits an allowlisted admin signing in at aal1 (no second factor)', async () => {
    const app = await createGateApp({ resolveAccess: ALLOW('admin') });
    const res = await request(app).get('/api/whoami').set('Authorization', AAL1_BEARER);
    expect(res.status).toBe(200);
    expect(res.body.role).toBe('admin');
  });

  it('admits with no aal claim present at all', async () => {
    const app = await createGateApp({
      resolveAccess: ALLOW('interviewer'),
      user: syntheticAuthUser('interviewer'),
      token: JWT_NO_AAL,
    });
    const res = await request(app)
      .get('/api/whoami')
      .set('Authorization', `Bearer ${JWT_NO_AAL}`);
    expect(res.status).toBe(200);
    expect(res.body.role).toBe('interviewer');
  });

  it('takes the role from the SERVER-HELD allowlist, not the client token', async () => {
    // Client-side user object claims admin; the allowlist resolver says viewer.
    // The server-held role must win.
    const app = await createGateApp({
      resolveAccess: ALLOW('viewer'),
      user: syntheticAuthUser('admin'),
    });
    const res = await request(app).get('/api/whoami').set('Authorization', AAL1_BEARER);
    expect(res.status).toBe(200);
    expect(res.body.role).toBe('viewer');
  });
});

// ═════════════════════════════════════════════════════════════════════
//  2. Unlisted / inactive / revoked are DENIED — fail closed
// ═════════════════════════════════════════════════════════════════════

describe('ADR-0011: allowlist denials fail closed with a uniform 403', () => {
  it('denies a user with no allowlist entry', async () => {
    const app = await createGateApp({ resolveAccess: DENY });
    const res = await request(app).get('/api/whoami').set('Authorization', AAL1_BEARER);
    expect(res.status).toBe(403);
    expect(res.body.error.type).toBe('authorization_error');
  });

  it('denies a user whose allowlist entry is inactive/revoked', async () => {
    const app = await createGateApp({
      resolveAccess: async () => ({ ok: true, role: 'admin', active: false }),
    });
    const res = await request(app).get('/api/whoami').set('Authorization', AAL1_BEARER);
    expect(res.status).toBe(403);
  });

  it('denies when the resolver throws (never 500, never silently grants)', async () => {
    const app = await createGateApp({
      resolveAccess: async () => {
        throw new Error('resolver exploded');
      },
    });
    const res = await request(app).get('/api/whoami').set('Authorization', AAL1_BEARER);
    expect(res.status).toBe(403);
  });

  it('emits an identical generic body for every denial reason (no enumeration)', async () => {
    const unlisted = await createGateApp({ resolveAccess: DENY });
    const inactive = await createGateApp({
      resolveAccess: async () => ({ ok: true, role: 'admin', active: false }),
    });
    const a = await request(unlisted).get('/api/whoami').set('Authorization', AAL1_BEARER);
    const b = await request(inactive).get('/api/whoami').set('Authorization', AAL1_BEARER);
    expect(a.body).toEqual(b.body);
    expect(a.body).toEqual({
      error: { type: 'authorization_error', message: 'Insufficient permissions' },
    });
    // Never leaks the address or the domain.
    expect(JSON.stringify(a.body)).not.toContain('interviewkickstart');
    expect(JSON.stringify(a.body)).not.toContain('synthetic.user');
  });
});

// ═════════════════════════════════════════════════════════════════════
//  3. Stale sessions fail closed
// ═════════════════════════════════════════════════════════════════════

describe('ADR-0011: a stale session fails closed', () => {
  it('denies a still-valid unexpired JWT once the allowlist entry is revoked', async () => {
    // The token verifies fine and the user object claims active admin at aal2
    // — exactly the "stale session" shape. Revocation must still win.
    const app = await createGateApp({
      resolveAccess: DENY,
      user: syntheticAuthUser('admin', 'aal2'),
      token: JWT_AAL2,
    });
    const res = await request(app)
      .get('/api/whoami')
      .set('Authorization', `Bearer ${JWT_AAL2}`);
    expect(res.status).toBe(403);
  });

  it('re-resolves the allowlist on EVERY request, not once per session', async () => {
    let calls = 0;
    const app = await createGateApp({
      resolveAccess: async () => {
        calls += 1;
        // Allowed on the first call, revoked from the second onward.
        return calls === 1
          ? { ok: true, role: 'admin', active: true }
          : { ok: false, status: 403 };
      },
    });
    const first = await request(app).get('/api/whoami').set('Authorization', AAL1_BEARER);
    const second = await request(app).get('/api/whoami').set('Authorization', AAL1_BEARER);
    expect(first.status).toBe(200);
    expect(second.status).toBe(403);
    expect(calls).toBe(2);
  });
});

// ═════════════════════════════════════════════════════════════════════
//  4. Role gates remain enforced
// ═════════════════════════════════════════════════════════════════════

describe('ADR-0011: role gates remain enforced without any AAL involvement', () => {
  it('denies a viewer on an admin-only route at aal1', async () => {
    const app = await createGateApp({
      resolveAccess: ALLOW('viewer'),
      user: syntheticAuthUser('viewer'),
    });
    const res = await request(app).post('/api/admin-only').set('Authorization', AAL1_BEARER);
    expect(res.status).toBe(403);
  });

  it('denies an interviewer on an admin-only route at aal1', async () => {
    const app = await createGateApp({
      resolveAccess: ALLOW('interviewer'),
      user: syntheticAuthUser('interviewer'),
    });
    const res = await request(app).post('/api/admin-only').set('Authorization', AAL1_BEARER);
    expect(res.status).toBe(403);
  });

  it('admits an admin on an admin-only route at aal1', async () => {
    const app = await createGateApp({ resolveAccess: ALLOW('admin') });
    const res = await request(app).post('/api/admin-only').set('Authorization', AAL1_BEARER);
    expect(res.status).toBe(200);
  });

  it('admits an admin on an interviewer-gated route (role ranking intact)', async () => {
    const app = await createGateApp({ resolveAccess: ALLOW('admin') });
    const res = await request(app)
      .post('/api/interviewer-only')
      .set('Authorization', AAL1_BEARER);
    expect(res.status).toBe(200);
  });
});

// ═════════════════════════════════════════════════════════════════════
//  5. Token / JWT validation remains
// ═════════════════════════════════════════════════════════════════════

describe('ADR-0011: token validation is unchanged', () => {
  it('rejects a missing Authorization header with 401', async () => {
    const app = await createGateApp({ resolveAccess: ALLOW('admin') });
    const res = await request(app).get('/api/whoami');
    expect(res.status).toBe(401);
  });

  it('rejects a malformed Authorization header with 401', async () => {
    const app = await createGateApp({ resolveAccess: ALLOW('admin') });
    const res = await request(app).get('/api/whoami').set('Authorization', 'NotBearer xyz');
    expect(res.status).toBe(401);
  });

  it('rejects a token the provider rejects with 401 (never merely decoded)', async () => {
    const app = await createGateApp({
      resolveAccess: ALLOW('admin'),
      getUser: async () => ({ data: { user: null }, error: { message: 'invalid token' } }),
    });
    const res = await request(app).get('/api/whoami').set('Authorization', AAL1_BEARER);
    expect(res.status).toBe(401);
  });

  it('rejects with 401 — not 403 — when verification throws', async () => {
    const app = await createGateApp({
      resolveAccess: ALLOW('admin'),
      getUser: async () => {
        throw new Error('provider down');
      },
    });
    const res = await request(app).get('/api/whoami').set('Authorization', AAL1_BEARER);
    expect(res.status).toBe(401);
  });
});

// ═════════════════════════════════════════════════════════════════════
//  6. Email domain alone is never sufficient
// ═════════════════════════════════════════════════════════════════════

describe('ADR-0011: domain match alone never authorizes', () => {
  it('denies an exact-company-domain email that has no active allowlist entry', async () => {
    const app = await createGateApp({ resolveAccess: DENY });
    const res = await request(app).get('/api/whoami').set('Authorization', AAL1_BEARER);
    // SYNTHETIC_EMAIL is on the exact company domain, yet still denied.
    expect(SYNTHETIC_EMAIL.endsWith('@interviewkickstart.com')).toBe(true);
    expect(res.status).toBe(403);
  });

  it('normalizeEmailForAccess still rejects near-miss domains', async () => {
    expect(normalizeEmailForAccess('a@interviewkickstart.com.evil.test')).toBeNull();
    expect(normalizeEmailForAccess('a@sub.interviewkickstart.com')).toBeNull();
    expect(normalizeEmailForAccess('a@gmail.com')).toBeNull();
    expect(normalizeEmailForAccess('ok@interviewkickstart.com')).toBe(
      'ok@interviewkickstart.com',
    );
  });

  it('passes the verified-email flag through to the resolver on every request', async () => {
    const seen: Array<[string, string, boolean]> = [];
    const app = await createGateApp({
      resolveAccess: async (userId, email, emailVerified) => {
        seen.push([userId, email, emailVerified]);
        return { ok: true, role: 'viewer', active: true };
      },
    });
    await request(app).get('/api/whoami').set('Authorization', AAL1_BEARER);
    expect(seen).toHaveLength(1);
    expect(seen[0][0]).toBe(SYNTHETIC_USER_ID);
    expect(seen[0][1]).toBe(SYNTHETIC_EMAIL);
    // Mock users carry no email_confirmed_at, so the flag arrives false — the
    // point is that the middleware forwards it rather than assuming true.
    expect(seen[0][2]).toBe(false);
  });

  it('defaultAccessResolver denies an UNVERIFIED email before any DB call', async () => {
    // emailVerified=false must short-circuit to 403 without touching the
    // Supabase client (which is unset in this test process).
    await expect(
      defaultAccessResolver(SYNTHETIC_USER_ID, SYNTHETIC_EMAIL, false),
    ).resolves.toEqual({ ok: false, status: 403 });
  });

  it('defaultAccessResolver denies a non-company domain before any DB call', async () => {
    await expect(
      defaultAccessResolver(SYNTHETIC_USER_ID, 'someone@gmail.com', true),
    ).resolves.toEqual({ ok: false, status: 403 });
  });
});
