/**
 * Phase 9 L2 — /api/admin/* (invariant 7/8).
 * Admin boundary at the router; members list returns opaque user_id/role/
 * active ONLY (no email, no auth.users join); membership mutation is the
 * atomic last-admin-safe RPC; maintenance toggle and session override are
 * bounded CAS RPCs with stable errors.
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import request from 'supertest';
import express from 'express';
import { createRequireAuth, mockAuthGetUser, type AuthUser } from '../lib/auth.js';
import { viewerReadOnly } from '../lib/rbac.js';
import { adminRouter } from '../routes/admin.js';
import { finalErrorHandler } from '../lib/validation.js';

vi.mock('../lib/supabase.js', () => ({
  supabase: { from: vi.fn(), rpc: vi.fn() },
  RESUME_BUCKET: 'resumes_v2',
}));

const JWT_AAL2 = 'eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiJ1c2VyLTAwMSIsImFhbCI6ImFhbDIifQ.signature';
const UUID_1 = '00000000-0000-4000-8000-000000000001';

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
  fn.range = () => chainable(value);
  return fn;
}

function makeUser(role: AuthUser['appRole'], overrides: Partial<AuthUser> = {}): AuthUser {
  return {
    id: '00000000-0000-4000-8000-0000000000ff',
    email: 'admin@example.com',
    aal: 'aal2',
    active: true,
    appRole: role,
    orgId: null,
    ...overrides,
  };
}

let mockFrom: any;
let mockRpc: any;

beforeEach(async () => {
  const mod = await import('../lib/supabase.js');
  mockFrom = (mod.supabase as any).from;
  mockRpc = (mod.supabase as any).rpc;
  mockFrom.mockReset();
  mockRpc.mockReset();
});

afterEach(() => {
  vi.restoreAllMocks();
});

function makeApp(user: AuthUser, token: string = JWT_AAL2) {
  const app = express();
  app.use(express.json());
  app.use(createRequireAuth({ getUser: mockAuthGetUser(user, token) }));
  app.use(viewerReadOnly);
  app.use('/api/admin', adminRouter);
  app.use(finalErrorHandler);
  return app;
}

const AUTH = { Authorization: `Bearer ${JWT_AAL2}` };

describe('admin boundary', () => {
  it('401 without auth', async () => {
    const res = await request(makeApp(makeUser('admin'))).get('/api/admin/members');
    expect(res.status).toBe(401);
  });

  it('403 for non-admin (interviewer)', async () => {
    const res = await request(makeApp(makeUser('interviewer')))
      .get('/api/admin/members')
      .set(AUTH);
    expect(res.status).toBe(403);
  });

  it('403 for viewer', async () => {
    const res = await request(makeApp(makeUser('viewer', { aal: 'aal1' })))
      .get('/api/admin/members')
      .set(AUTH);
    expect(res.status).toBe(403);
  });
});

describe('GET /api/admin/members', () => {
  it('returns opaque user_id/role/active only — no email, no auth.users join', async () => {
    mockFrom.mockReturnValue(
      chainable({
        data: [
          { user_id: UUID_1, role: 'admin', active: true, email: 'secret@example.com', created_at: 'x' },
          { user_id: '00000000-0000-4000-8000-000000000002', role: 'viewer', active: false },
        ],
        error: null,
      }),
    );
    const res = await request(makeApp(makeUser('admin'))).get('/api/admin/members').set(AUTH);
    expect(res.status).toBe(200);
    expect(res.body).toEqual([
      { user_id: UUID_1, role: 'admin', active: true },
      { user_id: '00000000-0000-4000-8000-000000000002', role: 'viewer', active: false },
    ]);
    expect(JSON.stringify(res.body)).not.toContain('email');
    expect(mockFrom).toHaveBeenCalledWith('recruiter_memberships');
  });

  it('returns empty list on no rows', async () => {
    mockFrom.mockReturnValue(chainable({ data: [], error: null }));
    const res = await request(makeApp(makeUser('admin'))).get('/api/admin/members').set(AUTH);
    expect(res.status).toBe(200);
    expect(res.body).toEqual([]);
  });
});

describe('PATCH /api/admin/members/:userId', () => {
  it('delegates to update_membership RPC and returns ok', async () => {
    mockRpc.mockResolvedValue({ data: { status: 'ok' }, error: null });
    const res = await request(makeApp(makeUser('admin')))
      .patch(`/api/admin/members/${UUID_1}`)
      .set(AUTH)
      .send({ role: 'interviewer' });
    expect(res.status).toBe(200);
    expect(res.body).toEqual({ ok: true });
    expect(mockRpc).toHaveBeenCalledWith('update_membership', {
      p_user_id: UUID_1,
      p_role: 'interviewer',
      p_active: null,
      p_actor_id: '00000000-0000-4000-8000-0000000000ff',
    });
  });

  it('rejects last_active_admin with stable 409', async () => {
    mockRpc.mockResolvedValue({ data: { status: 'last_active_admin' }, error: null });
    const res = await request(makeApp(makeUser('admin')))
      .patch(`/api/admin/members/${UUID_1}`)
      .set(AUTH)
      .send({ active: false });
    expect(res.status).toBe(409);
    expect(res.body.error).toBe('last_active_admin');
  });

  it('rejects self-modification with stable 409', async () => {
    mockRpc.mockResolvedValue({ data: { status: 'self_modification_denied' }, error: null });
    const res = await request(makeApp(makeUser('admin')))
      .patch('/api/admin/members/00000000-0000-4000-8000-0000000000ff')
      .set(AUTH)
      .send({ active: false });
    expect(res.status).toBe(409);
    expect(res.body.error).toBe('self_modification_denied');
  });

  it('404 member_not_found', async () => {
    mockRpc.mockResolvedValue({ data: { status: 'not_found' }, error: null });
    const res = await request(makeApp(makeUser('admin')))
      .patch(`/api/admin/members/${UUID_1}`)
      .set(AUTH)
      .send({ active: true });
    expect(res.status).toBe(404);
  });

  it('400 when body has neither role nor active', async () => {
    const res = await request(makeApp(makeUser('admin')))
      .patch(`/api/admin/members/${UUID_1}`)
      .set(AUTH)
      .send({});
    expect(res.status).toBe(400);
    expect(mockRpc).not.toHaveBeenCalled();
  });

  it('400 invalid role value', async () => {
    const res = await request(makeApp(makeUser('admin')))
      .patch(`/api/admin/members/${UUID_1}`)
      .set(AUTH)
      .send({ role: 'superuser' });
    expect(res.status).toBe(400);
  });

  it('400 non-UUID member path param', async () => {
    const res = await request(makeApp(makeUser('admin')))
      .patch('/api/admin/members/not-a-uuid')
      .set(AUTH)
      .send({ active: true });
    expect(res.status).toBe(400);
  });
});

describe('POST /api/admin/maintenance', () => {
  it('toggles maintenance on via toggle_maintenance RPC', async () => {
    mockRpc.mockResolvedValue({ data: { status: 'ok', enabled: true }, error: null });
    const res = await request(makeApp(makeUser('admin')))
      .post('/api/admin/maintenance')
      .set(AUTH)
      .send({ enabled: true, reason: 'upgrade' });
    expect(res.status).toBe(200);
    expect(res.body).toEqual({ ok: true, enabled: true });
    expect(mockRpc).toHaveBeenCalledWith('toggle_maintenance', {
      p_enabled: true,
      p_reason: 'upgrade',
      p_actor_id: '00000000-0000-4000-8000-0000000000ff',
    });
  });

  it('400 invalid_reason from the RPC', async () => {
    mockRpc.mockResolvedValue({ data: { status: 'invalid_reason' }, error: null });
    const res = await request(makeApp(makeUser('admin')))
      .post('/api/admin/maintenance')
      .set(AUTH)
      .send({ enabled: true, reason: 'x' });
    expect(res.status).toBe(400);
    expect(res.body.error).toBe('invalid_reason');
  });

  it('400 when reason is missing (bounded schema)', async () => {
    const res = await request(makeApp(makeUser('admin')))
      .post('/api/admin/maintenance')
      .set(AUTH)
      .send({ enabled: true });
    expect(res.status).toBe(400);
  });
});

describe('POST /api/admin/sessions/:sessionId/override', () => {
  it('overrides with CAS and returns prior status', async () => {
    mockRpc.mockResolvedValue({ data: { status: 'ok', prior_status: 'created' }, error: null });
    const res = await request(makeApp(makeUser('admin')))
      .post(`/api/admin/sessions/${UUID_1}/override`)
      .set(AUTH)
      .send({ target_status: 'cancelled', reason: 'duplicate booking' });
    expect(res.status).toBe(200);
    expect(res.body).toEqual({ ok: true, prior_status: 'created' });
    expect(mockRpc).toHaveBeenCalledWith('override_admin_session', {
      p_session_id: UUID_1,
      p_target_status: 'cancelled',
      p_reason: 'duplicate booking',
      p_actor_id: '00000000-0000-4000-8000-0000000000ff',
    });
  });

  it('409 resurrection_denied (negative control: no state resurrection)', async () => {
    mockRpc.mockResolvedValue({ data: { status: 'resurrection_denied' }, error: null });
    const res = await request(makeApp(makeUser('admin')))
      .post(`/api/admin/sessions/${UUID_1}/override`)
      .set(AUTH)
      .send({ target_status: 'in_progress', reason: 'revive' });
    expect(res.status).toBe(409);
    expect(res.body.error).toBe('resurrection_denied');
  });

  it('409 deleted_denied', async () => {
    mockRpc.mockResolvedValue({ data: { status: 'deleted_denied' }, error: null });
    const res = await request(makeApp(makeUser('admin')))
      .post(`/api/admin/sessions/${UUID_1}/override`)
      .set(AUTH)
      .send({ target_status: 'waiting', reason: 'restore' });
    expect(res.status).toBe(409);
  });

  it('404 session_not_found', async () => {
    mockRpc.mockResolvedValue({ data: { status: 'session_not_found' }, error: null });
    const res = await request(makeApp(makeUser('admin')))
      .post(`/api/admin/sessions/${UUID_1}/override`)
      .set(AUTH)
      .send({ target_status: 'cancelled', reason: 'x' });
    expect(res.status).toBe(404);
  });

  it('400 invalid_target / invalid_reason are bounded', async () => {
    const app = makeApp(makeUser('admin'));
    const badTarget = await request(app)
      .post(`/api/admin/sessions/${UUID_1}/override`)
      .set(AUTH)
      .send({ target_status: 'exploded', reason: 'x' });
    expect(badTarget.status).toBe(400);

    const badReason = await request(app)
      .post(`/api/admin/sessions/${UUID_1}/override`)
      .set(AUTH)
      .send({ target_status: 'cancelled', reason: '' });
    expect(badReason.status).toBe(400);
  });
});

// ════════════════════════════════════════════════════════════════════
//  Phase 9 review repair — GET /api/admin/audit (OPS-01)
// ════════════════════════════════════════════════════════════════════

describe('GET /api/admin/audit (OPS-01)', () => {
  it('returns allowlisted/minimized fields ONLY — redaction by construction', async () => {
    mockFrom.mockReturnValue(
      chainable({
        data: [
          {
            id: UUID_1,
            action: 'admin_maintenance_toggle',
            actor_type: 'recruiter',
            actor_id: '00000000-0000-4000-8000-0000000000ff',
            target_type: 'system',
            target_id: 'maintenance',
            result: 'success',
            created_at: '2026-01-01T00:00:00.000Z',
            metadata: { reason: 'upgrade', secret: 'x' },
            source_ip: '10.0.0.5',
            correlation_id: '00000000-0000-4000-8000-0000000000aa',
            contact_email: 'leak@example.com',
            transcript_text: 'secret transcript',
            token_digest: 'abcd',
          },
        ],
        error: null,
      }),
    );
    const res = await request(makeApp(makeUser('admin'))).get('/api/admin/audit').set(AUTH);
    expect(res.status).toBe(200);
    expect(res.body.audit).toHaveLength(1);
    expect(res.body.audit[0]).toEqual({
      id: UUID_1,
      action: 'admin_maintenance_toggle',
      actor_type: 'recruiter',
      actor_id: '00000000-0000-4000-8000-0000000000ff',
      target_type: 'system',
      target_id: 'maintenance',
      result: 'success',
      created_at: '2026-01-01T00:00:00.000Z',
    });
    // Never return metadata / source_ip / correlation ids / contact / token.
    const body = JSON.stringify(res.body);
    expect(body).not.toContain('metadata');
    expect(body).not.toContain('source_ip');
    expect(body).not.toContain('correlation');
    expect(body).not.toContain('leak@example.com');
    expect(body).not.toContain('transcript');
    expect(body).not.toContain('token_digest');
    expect(body).not.toContain('secret');
  });

  it('non-admin → 403', async () => {
    const res = await request(makeApp(makeUser('interviewer'))).get('/api/admin/audit').set(AUTH);
    expect(res.status).toBe(403);
  });

  it('limit is bounded (max 100) and offset is bounded', async () => {
    const app = makeApp(makeUser('admin'));
    const over = await request(app).get('/api/admin/audit?limit=1000').set(AUTH);
    expect(over.status).toBe(400);
    const zero = await request(app).get('/api/admin/audit?limit=0').set(AUTH);
    expect(zero.status).toBe(400);
    const deep = await request(app).get('/api/admin/audit?offset=100000').set(AUTH);
    expect(deep.status).toBe(400);
    const badType = await request(app).get('/api/admin/audit?limit=abc').set(AUTH);
    expect(badType.status).toBe(400);
    // Defaults apply when omitted.
    mockFrom.mockReturnValue(chainable({ data: [], error: null }));
    const ok = await request(app).get('/api/admin/audit').set(AUTH);
    expect(ok.status).toBe(200);
  });
});

// ════════════════════════════════════════════════════════════════════
//  Phase 9 review repair — GET /api/admin/sessions (OPS-01)
// ════════════════════════════════════════════════════════════════════

describe('GET /api/admin/sessions (OPS-01)', () => {
  it('returns strictly minimized session fields (no candidate PII/transcript/recording)', async () => {
    mockFrom.mockReturnValue(
      chainable({
        data: [
          {
            id: UUID_1,
            candidate_id: '00000000-0000-4000-8000-0000000000bb',
            role_id: null,
            status: 'in_progress',
            created_at: '2026-01-01T00:00:00.000Z',
            started_at: '2026-01-01T00:00:01.000Z',
            ended_at: null,
            candidate_name: 'Leak Name',
            email: 'leak@example.com',
            phone_e164: '+919999999999',
            recording_object_key: '2026/01/secret.mp4',
            model: 'haiku',
            provider: 'anthropic',
            raw_error: 'boom',
          },
        ],
        error: null,
      }),
    );
    const res = await request(makeApp(makeUser('admin'))).get('/api/admin/sessions').set(AUTH);
    expect(res.status).toBe(200);
    expect(res.body.sessions).toHaveLength(1);
    expect(res.body.sessions[0]).toEqual({
      id: UUID_1,
      candidate_id: '00000000-0000-4000-8000-0000000000bb',
      role_id: null,
      status: 'in_progress',
      created_at: '2026-01-01T00:00:00.000Z',
      started_at: '2026-01-01T00:00:01.000Z',
      ended_at: null,
    });
    const body = JSON.stringify(res.body);
    expect(body).not.toContain('Leak Name');
    expect(body).not.toContain('leak@example.com');
    expect(body).not.toContain('+919999999999');
    expect(body).not.toContain('recording');
    expect(body).not.toContain('haiku');
    expect(body).not.toContain('anthropic');
    expect(body).not.toContain('boom');
  });

  it('applies the strict status filter', async () => {
    mockFrom.mockReturnValue(chainable({ data: [], error: null }));
    await request(makeApp(makeUser('admin'))).get('/api/admin/sessions?status=completed').set(AUTH);
    expect(mockFrom).toHaveBeenCalledWith('call_sessions');
  });

  it('rejects an unknown status filter (bounded enum)', async () => {
    const res = await request(makeApp(makeUser('admin')))
      .get('/api/admin/sessions?status=exploded')
      .set(AUTH);
    expect(res.status).toBe(400);
  });

  it('rejects unbounded pagination', async () => {
    const app = makeApp(makeUser('admin'));
    expect((await request(app).get('/api/admin/sessions?limit=0').set(AUTH)).status).toBe(400);
    expect((await request(app).get('/api/admin/sessions?limit=1000').set(AUTH)).status).toBe(400);
    expect((await request(app).get('/api/admin/sessions?offset=999999').set(AUTH)).status).toBe(400);
  });

  it('non-admin → 403', async () => {
    const res = await request(makeApp(makeUser('viewer', { aal: 'aal1' })))
      .get('/api/admin/sessions')
      .set(AUTH);
    expect(res.status).toBe(403);
  });
});

// ════════════════════════════════════════════════════════════════════
//  Phase 9 review repair — quota policy administration (OPS-05)
// ════════════════════════════════════════════════════════════════════

describe('GET /api/admin/quotas (OPS-05)', () => {
  it('lists policy fields only — no price/currency/usage', async () => {
    mockFrom.mockReturnValue(
      chainable({
        data: [
          {
            id: UUID_1,
            scope: 'global',
            scope_id: null,
            mode: 'simulation',
            max_sessions: 10,
            max_cost_units: null,
            cost_units_per_session: 5,
            warning_percentage: null,
            period_days: 1,
            enabled: false,
            created_at: '2026-01-01T00:00:00.000Z',
            updated_at: '2026-01-01T00:00:00.000Z',
            price_usd: 0.99,
            currency: 'USD',
          },
        ],
        error: null,
      }),
    );
    const res = await request(makeApp(makeUser('admin'))).get('/api/admin/quotas').set(AUTH);
    expect(res.status).toBe(200);
    expect(res.body.policies).toHaveLength(1);
    const body = JSON.stringify(res.body);
    expect(body).not.toContain('price');
    expect(body).not.toContain('currency');
    expect(body).not.toContain('sessions_used');
  });

  it('non-admin → 403', async () => {
    const res = await request(makeApp(makeUser('interviewer'))).get('/api/admin/quotas').set(AUTH);
    expect(res.status).toBe(403);
  });
});

describe('POST /api/admin/quotas (OPS-05)', () => {
  it('creates via upsert_quota_policy RPC with actor derived from auth', async () => {
    mockRpc.mockResolvedValue({ data: { status: 'ok', id: UUID_1, created: true }, error: null });
    const res = await request(makeApp(makeUser('admin')))
      .post('/api/admin/quotas')
      .set(AUTH)
      .send({
        scope: 'global',
        max_sessions: 50,
        max_cost_units: 1000,
        cost_units_per_session: 8,
        warning_percentage: 80,
        enabled: true,
      });
    expect(res.status).toBe(201);
    expect(res.body).toEqual({ ok: true, id: UUID_1, created: true });
    expect(mockRpc).toHaveBeenCalledWith('upsert_quota_policy', {
      p_policy_id: null,
      p_scope: 'global',
      p_scope_id: null,
      p_mode: 'simulation',
      p_max_sessions: 50,
      p_max_cost_units: 1000,
      p_cost_units_per_session: 8,
      p_warning_percentage: 80,
      p_period_days: 1,
      p_enabled: true,
      p_actor_id: '00000000-0000-4000-8000-0000000000ff',
    });
  });

  it('rejects a client-supplied actor id (schema is strict — never accepted)', async () => {
    const res = await request(makeApp(makeUser('admin')))
      .post('/api/admin/quotas')
      .set(AUTH)
      .send({ scope: 'global', actor_id: '00000000-0000-4000-8000-0000000000aa' });
    expect(res.status).toBe(400); // unknown key rejected by .strict()
    expect(mockRpc).not.toHaveBeenCalled();
  });

  it('rejects negative/zero/unbounded limits', async () => {
    const app = makeApp(makeUser('admin'));
    const base = { scope: 'global' };
    const bad = [
      { ...base, max_sessions: 0 },
      { ...base, max_sessions: -1 },
      { ...base, max_cost_units: 0 },
      { ...base, cost_units_per_session: -5 },
      { ...base, warning_percentage: 0 },
      { ...base, warning_percentage: 101 },
      { ...base, period_days: 0 },
      { ...base, period_days: 366 },
      { ...base, max_sessions: 9999999999999 },
      { scope: 'candidate' }, // missing scope_id → coherence failure
      { scope: 'global', scope_id: UUID_1 }, // global must not carry scope_id
    ];
    for (const body of bad) {
      const res = await request(app).post('/api/admin/quotas').set(AUTH).send(body);
      expect(res.status, JSON.stringify(body)).toBe(400);
    }
    expect(mockRpc).not.toHaveBeenCalled();
  });

  it('maps RPC stable statuses to 400', async () => {
    for (const status of ['invalid_scope', 'invalid_mode', 'invalid_max_sessions', 'invalid_warning_percentage', 'invalid_period_days', 'actor_required']) {
      mockRpc.mockResolvedValue({ data: { status }, error: null });
      const res = await request(makeApp(makeUser('admin')))
        .post('/api/admin/quotas')
        .set(AUTH)
        .send({ scope: 'global', enabled: false });
      expect(res.status).toBe(400);
      expect(res.body.error).toBe(status);
    }
  });

  it('non-admin → 403', async () => {
    const res = await request(makeApp(makeUser('viewer', { aal: 'aal1' })))
      .post('/api/admin/quotas')
      .set(AUTH)
      .send({ scope: 'global' });
    expect(res.status).toBe(403);
  });
});

describe('PATCH /api/admin/quotas/:id (OPS-05)', () => {
  it('updates via the RPC and returns 200', async () => {
    mockRpc.mockResolvedValue({ data: { status: 'ok', id: UUID_1, created: false }, error: null });
    const res = await request(makeApp(makeUser('admin')))
      .patch(`/api/admin/quotas/${UUID_1}`)
      .set(AUTH)
      .send({ scope: 'global', enabled: true, max_sessions: 100 });
    expect(res.status).toBe(200);
    expect(res.body).toEqual({ ok: true, id: UUID_1 });
    expect(mockRpc).toHaveBeenCalledWith('upsert_quota_policy', expect.objectContaining({ p_policy_id: UUID_1 }));
  });

  it('404 policy_not_found when the RPC reports not_found (no row created)', async () => {
    mockRpc.mockResolvedValue({ data: { status: 'not_found' }, error: null });
    const res = await request(makeApp(makeUser('admin')))
      .patch(`/api/admin/quotas/${UUID_1}`)
      .set(AUTH)
      .send({ scope: 'global' });
    expect(res.status).toBe(404);
    expect(res.body.error).toBe('policy_not_found');
  });

  it('400 non-UUID policy id', async () => {
    const res = await request(makeApp(makeUser('admin')))
      .patch('/api/admin/quotas/not-a-uuid')
      .set(AUTH)
      .send({ scope: 'global' });
    expect(res.status).toBe(400);
  });

  it('nullable warning_percentage is accepted (null → no warning)', async () => {
    mockRpc.mockResolvedValue({ data: { status: 'ok', id: UUID_1, created: false }, error: null });
    const res = await request(makeApp(makeUser('admin')))
      .patch(`/api/admin/quotas/${UUID_1}`)
      .set(AUTH)
      .send({ scope: 'candidate', scope_id: '00000000-0000-4000-8000-0000000000bb', warning_percentage: null, enabled: false });
    expect(res.status).toBe(200);
    expect(mockRpc).toHaveBeenCalledWith('upsert_quota_policy', expect.objectContaining({ p_warning_percentage: null }));
  });

  it('non-admin → 403', async () => {
    const res = await request(makeApp(makeUser('interviewer')))
      .patch(`/api/admin/quotas/${UUID_1}`)
      .set(AUTH)
      .send({ scope: 'global' });
    expect(res.status).toBe(403);
  });
});
