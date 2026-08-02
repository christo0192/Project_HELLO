/**
 * Phase 9 L2 — start-path gating (invariant 10/11).
 *
 * POST /api/screening/start and POST /api/livekit/start are gated by the
 * fail-closed maintenance guard AND — when quota enforcement is configured
 * (at least one enabled quota_policy) — require a bounded Idempotency-Key,
 * reserve before create, commit after success, release on failure. When no
 * quota policy is enabled (the default) legacy start behavior is preserved.
 * Active-turn/completion paths are NOT gated.
 *
 * Negative controls:
 *   - missing Idempotency-Key when enforced → 400
 *   - quota_exceeded → 409 with remaining caps
 *   - duplicate committed key → 409 idempotency_replay (no double-reserve)
 *   - failed session creation → reservation RELEASED
 *   - maintenance on / DB-read failure → 503 for new starts (non-admin)
 *   - active completion path (turn) remains unblocked by the guard
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import request from 'supertest';
import express from 'express';
import { createRequireAuth, mockAuthGetUser, type AuthUser } from '../lib/auth.js';
import { viewerReadOnly } from '../lib/rbac.js';
import { screeningRouter } from '../routes/screening.js';
import { livekitRouter } from '../routes/livekit.js';
import { finalErrorHandler } from '../lib/validation.js';

// ── Module mocks ────────────────────────────────────────────────────

vi.mock('../lib/supabase.js', () => ({
  supabase: { from: vi.fn(), rpc: vi.fn() },
  RESUME_BUCKET: 'resumes_v2',
}));

vi.mock('../lib/claude.js', () => ({
  runClaudeJSON: vi.fn().mockResolvedValue({ message: 'Hello', done: false }),
  runClaudeJSONWithProvenance: vi.fn().mockResolvedValue({
    data: { message: 'Hello', done: false },
    requestedModel: 'haiku',
  }),
}));

vi.mock('livekit-server-sdk', () => {
  class FakeRoomServiceClient {
    createRoom = vi.fn().mockResolvedValue({ name: 'screening-room' });
    updateRoomMetadata = vi.fn().mockResolvedValue({});
    deleteRoom = vi.fn().mockResolvedValue({});
  }
  return { RoomServiceClient: FakeRoomServiceClient };
});

// ── Constants / fixtures ────────────────────────────────────────────

const JWT_AAL2 = 'eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiJ1c2VyLTAwMSIsImFhbCI6ImFhbDIifQ.signature';
const AUTH_HEADER = `Bearer ${JWT_AAL2}`;
const UUID_1 = '00000000-0000-4000-8000-000000000001';
const UUID_2 = '00000000-0000-4000-8000-000000000002';
const RES_ID = '00000000-0000-4000-8000-0000000000aa';
const IDEM = 'start-request-0001';

const mockCandidate = {
  id: UUID_2,
  name: 'Alice Example',
  role_id: UUID_1,
  owner_id: null,
  skills: ['TypeScript'],
  parsed: { summary: 'x' },
};

const mockRole = {
  id: UUID_1,
  title: 'Software Engineer',
  jd: 'Build things',
  required_skills: ['TypeScript'],
  screening_template: [],
};

const mockSession = {
  id: UUID_1,
  status: 'created',
  candidate_id: UUID_2,
  role_id: UUID_1,
};

function chainable(value: any): any {
  const fn = function () { return chainable(value); };
  fn.then = (resolve: (v: any) => any) => Promise.resolve(value).then(resolve);
  fn.catch = (reject: (e: unknown) => unknown) => Promise.resolve(value).catch(reject);
  fn.eq = () => chainable(value);
  fn.order = () => chainable(value);
  fn.limit = () => chainable(value);
  fn.select = () => chainable(value);
  fn.insert = () => chainable(value);
  fn.update = () => chainable(value);
  fn.maybeSingle = () => chainable(value);
  fn.single = () => chainable(value);
  fn.is = () => chainable(value);
  return fn;
}

let mockFrom: any;
let mockRpc: any;

beforeEach(async () => {
  const mod = await import('../lib/supabase.js');
  mockFrom = (mod.supabase as any).from;
  mockRpc = (mod.supabase as any).rpc;
  mockFrom.mockReset();
  mockRpc.mockReset();
  mockRpc.mockResolvedValue({ data: null, error: null });
});

afterEach(() => {
  vi.restoreAllMocks();
});

function makeUser(role: AuthUser['appRole']): AuthUser {
  return {
    id: 'user-admin-0000-0000-000000000001',
    email: 'admin@example.com',
    aal: 'aal2',
    active: true,
    appRole: role,
    orgId: null,
  };
}

/** Per-table counter config: value or fn(n) with n = 0-based call index. */
function configureTables(config: Record<string, unknown | ((n: number) => unknown)>): void {
  const counters: Record<string, number> = {};
  mockFrom.mockImplementation((table: string) => {
    const entry = config[table];
    if (entry === undefined) return chainable({ data: null, error: null });
    const n = counters[table] ?? 0;
    counters[table] = n + 1;
    const value = typeof entry === 'function' ? (entry as (c: number) => unknown)(n) : entry;
    return chainable(value);
  });
}

/** Default legacy (quota-unconfigured, maintenance off) table config. */
function defaultLegacyTables(): Record<string, unknown | ((n: number) => unknown)> {
  return {
    system_config: { data: null, error: null }, // maintenance off
    quota_policies: { data: [], error: null }, // enforcement off
    candidates: (n: number) =>
      n === 0
        ? { data: mockCandidate, error: null }
        : { data: null, error: null }, // status update best-effort
    roles: { data: mockRole, error: null },
    call_sessions: (n: number) =>
      n === 0
        ? { data: mockSession, error: null }
        : { data: [{ id: mockSession.id }], error: null }, // CAS update
    transcript_turns: { data: null, error: null },
  };
}

function makeApp(user: AuthUser) {
  const app = express();
  app.use(express.json());
  app.use(createRequireAuth({ getUser: mockAuthGetUser(user, JWT_AAL2) }));
  app.use(viewerReadOnly);
  app.use('/api/screening', screeningRouter);
  app.use('/api/livekit', livekitRouter);
  app.use(finalErrorHandler);
  return app;
}

// ═══════════════════════════════════════════════════════════════════
// Legacy behavior (quota NOT configured → no key required)
// ═══════════════════════════════════════════════════════════════════

describe('start paths — legacy behavior when quota is not configured', () => {
  it('screening start → 201 without Idempotency-Key (quota disabled by default)', async () => {
    configureTables(defaultLegacyTables());
    const app = makeApp(makeUser('admin'));
    const res = await request(app)
      .post('/api/screening/start')
      .set('Authorization', AUTH_HEADER)
      .send({ candidate_id: UUID_2 });
    expect(res.status).toBe(201);
    expect(res.body.session_id).toBeDefined();
    expect(res.body.done).toBe(false);
    expect(mockRpc).not.toHaveBeenCalled();
  });

  it('livekit start → 201 without Idempotency-Key (quota disabled by default)', async () => {
    configureTables({
      system_config: { data: null, error: null },
      quota_policies: { data: [], error: null },
      candidates: (n: number) =>
        n === 0 ? { data: { ...mockCandidate, owner_id: null }, error: null } : { data: null, error: null },
      call_sessions: (n: number) =>
        n === 0
          ? { data: mockSession, error: null }
          : { data: [{ id: mockSession.id }], error: null },
    });
    const app = makeApp(makeUser('admin'));
    const res = await request(app)
      .post('/api/livekit/start')
      .set('Authorization', AUTH_HEADER)
      .send({ candidate_id: UUID_2 });
    expect(res.status).toBe(201);
    expect(res.body.session_id).toBeDefined();
    expect(res.body.room_name).toBe(`screening-${UUID_1}`);
    expect(mockRpc).not.toHaveBeenCalled();
  });
});

// ═══════════════════════════════════════════════════════════════════
// Quota enforcement: key required + reserve/commit/release
// ═══════════════════════════════════════════════════════════════════

describe('start paths — quota enforcement (enabled policy)', () => {
  function enforcedTables(): Record<string, unknown | ((n: number) => unknown)> {
    return {
      ...defaultLegacyTables(),
      quota_policies: { data: [{ id: 'policy-1' }], error: null }, // enforcement ON
    };
  }

  it('screening start requires a bounded Idempotency-Key → 400 when missing', async () => {
    configureTables(enforcedTables());
    const res = await request(makeApp(makeUser('admin')))
      .post('/api/screening/start')
      .set('Authorization', AUTH_HEADER)
      .send({ candidate_id: UUID_2 });
    expect(res.status).toBe(400);
    expect(res.body.error.message).toContain('Idempotency-Key');
    expect(mockRpc).not.toHaveBeenCalled();
  });

  it('screening start requires a bounded Idempotency-Key → 400 when malformed', async () => {
    configureTables(enforcedTables());
    const res = await request(makeApp(makeUser('admin')))
      .post('/api/screening/start')
      .set('Authorization', AUTH_HEADER)
      .set('Idempotency-Key', 'bad key!')
      .send({ candidate_id: UUID_2 });
    expect(res.status).toBe(400);
  });

  it('livekit start requires a bounded Idempotency-Key → 400 when missing', async () => {
    configureTables(enforcedTables());
    const res = await request(makeApp(makeUser('admin')))
      .post('/api/livekit/start')
      .set('Authorization', AUTH_HEADER)
      .send({ candidate_id: UUID_2 });
    expect(res.status).toBe(400);
  });

  it('screening: reserve → create → COMMIT on success (201)', async () => {
    configureTables(enforcedTables());
    mockRpc.mockImplementation((name: string) => {
      if (name === 'check_and_reserve_quota') {
        return Promise.resolve({
          data: { status: 'ok', allowed: true, reservation_id: RES_ID, remaining_sessions: 3, remaining_cost_units: 5, warning_reached: false },
          error: null,
        });
      }
      if (name === 'commit_quota_reservation') {
        return Promise.resolve({ data: { status: 'committed' }, error: null });
      }
      return Promise.resolve({ data: { status: 'released' }, error: null });
    });
    const res = await request(makeApp(makeUser('admin')))
      .post('/api/screening/start')
      .set('Authorization', AUTH_HEADER)
      .set('Idempotency-Key', IDEM)
      .send({ candidate_id: UUID_2 });
    expect(res.status).toBe(201);
    expect(mockRpc).toHaveBeenCalledWith('check_and_reserve_quota', {
      p_requester_id: 'user-admin-0000-0000-000000000001',
      p_mode: 'simulation',
      p_idempotency_key: IDEM,
    });
    expect(mockRpc).toHaveBeenCalledWith('commit_quota_reservation', { p_reservation_id: RES_ID });
    expect(mockRpc).not.toHaveBeenCalledWith('release_quota_reservation', expect.anything());
  });

  it('screening: failed session creation → reservation RELEASED (compensation)', async () => {
    configureTables({
      ...enforcedTables(),
      call_sessions: { data: null, error: { message: 'insert failed' } },
    });
    mockRpc.mockImplementation((name: string) => {
      if (name === 'check_and_reserve_quota') {
        return Promise.resolve({
          data: { status: 'ok', allowed: true, reservation_id: RES_ID, remaining_sessions: 3, remaining_cost_units: 5, warning_reached: false },
          error: null,
        });
      }
      if (name === 'release_quota_reservation') {
        return Promise.resolve({ data: { status: 'released' }, error: null });
      }
      return Promise.resolve({ data: { status: 'committed' }, error: null });
    });
    const res = await request(makeApp(makeUser('admin')))
      .post('/api/screening/start')
      .set('Authorization', AUTH_HEADER)
      .set('Idempotency-Key', IDEM)
      .send({ candidate_id: UUID_2 });
    expect(res.status).toBe(500);
    expect(mockRpc).toHaveBeenCalledWith('release_quota_reservation', { p_reservation_id: RES_ID });
    expect(mockRpc).not.toHaveBeenCalledWith('commit_quota_reservation', expect.anything());
  });

  it('screening: quota_exceeded → 409 with remaining caps (count cap)', async () => {
    configureTables(enforcedTables());
    mockRpc.mockResolvedValue({
      data: { status: 'quota_exceeded', allowed: false, remaining_sessions: 0, remaining_cost_units: 4 },
      error: null,
    });
    const res = await request(makeApp(makeUser('admin')))
      .post('/api/screening/start')
      .set('Authorization', AUTH_HEADER)
      .set('Idempotency-Key', IDEM)
      .send({ candidate_id: UUID_2 });
    expect(res.status).toBe(409);
    expect(res.body.error).toBe('quota_exceeded');
    expect(res.body.remaining_sessions).toBe(0);
    expect(res.body.remaining_cost_units).toBe(4);
    expect(mockRpc).not.toHaveBeenCalledWith('commit_quota_reservation', expect.anything());
  });

  it('screening: cost cap denial also maps to 409 (cost cap)', async () => {
    configureTables(enforcedTables());
    mockRpc.mockResolvedValue({
      data: { status: 'quota_exceeded', allowed: false, remaining_sessions: 2, remaining_cost_units: 0 },
      error: null,
    });
    const res = await request(makeApp(makeUser('admin')))
      .post('/api/screening/start')
      .set('Authorization', AUTH_HEADER)
      .set('Idempotency-Key', IDEM)
      .send({ candidate_id: UUID_2 });
    expect(res.status).toBe(409);
    expect(res.body.remaining_cost_units).toBe(0);
  });

  it('screening: duplicate committed key → 409 idempotency_replay (never double-reserves)', async () => {
    configureTables(enforcedTables());
    mockRpc.mockResolvedValue({
      data: { status: 'duplicate', allowed: true, reservation_id: RES_ID, reservation_status: 'committed' },
      error: null,
    });
    const res = await request(makeApp(makeUser('admin')))
      .post('/api/screening/start')
      .set('Authorization', AUTH_HEADER)
      .set('Idempotency-Key', IDEM)
      .send({ candidate_id: UUID_2 });
    expect(res.status).toBe(409);
    expect(res.body.error).toBe('idempotency_replay');
    // No second reservation attempt beyond the idempotent RPC.
    expect(mockRpc).toHaveBeenCalledTimes(1);
  });

  it('screening: duplicate reserved key → 409 request_in_flight', async () => {
    configureTables(enforcedTables());
    mockRpc.mockResolvedValue({
      data: { status: 'duplicate', allowed: true, reservation_id: RES_ID, reservation_status: 'reserved' },
      error: null,
    });
    const res = await request(makeApp(makeUser('admin')))
      .post('/api/screening/start')
      .set('Authorization', AUTH_HEADER)
      .set('Idempotency-Key', IDEM)
      .send({ candidate_id: UUID_2 });
    expect(res.status).toBe(409);
    expect(res.body.error).toBe('request_in_flight');
  });

  it('screening: no_policy under enforcement → 503 quota_not_configured', async () => {
    configureTables(enforcedTables());
    mockRpc.mockResolvedValue({ data: { status: 'no_policy', allowed: false }, error: null });
    const res = await request(makeApp(makeUser('admin')))
      .post('/api/screening/start')
      .set('Authorization', AUTH_HEADER)
      .set('Idempotency-Key', IDEM)
      .send({ candidate_id: UUID_2 });
    expect(res.status).toBe(503);
    expect(res.body.error).toBe('quota_not_configured');
  });

  it('screening: RPC error → 503 quota_service_error (fail closed)', async () => {
    configureTables(enforcedTables());
    mockRpc.mockResolvedValue({ data: null, error: { message: 'rpc down' } });
    const res = await request(makeApp(makeUser('admin')))
      .post('/api/screening/start')
      .set('Authorization', AUTH_HEADER)
      .set('Idempotency-Key', IDEM)
      .send({ candidate_id: UUID_2 });
    expect(res.status).toBe(503);
    expect(res.body.error).toBe('quota_service_error');
  });

  it('livekit: reserve → create → COMMIT on success (201)', async () => {
    configureTables({
      system_config: { data: null, error: null },
      quota_policies: { data: [{ id: 'policy-1' }], error: null },
      candidates: (n: number) =>
        n === 0 ? { data: { ...mockCandidate, owner_id: null }, error: null } : { data: null, error: null },
      call_sessions: (n: number) =>
        n === 0
          ? { data: mockSession, error: null }
          : { data: [{ id: mockSession.id }], error: null },
    });
    mockRpc.mockImplementation((name: string) => {
      if (name === 'check_and_reserve_quota') {
        return Promise.resolve({
          data: { status: 'ok', allowed: true, reservation_id: RES_ID, remaining_sessions: 3, remaining_cost_units: 5, warning_reached: false },
          error: null,
        });
      }
      if (name === 'commit_quota_reservation') {
        return Promise.resolve({ data: { status: 'committed' }, error: null });
      }
      return Promise.resolve({ data: { status: 'released' }, error: null });
    });
    const res = await request(makeApp(makeUser('admin')))
      .post('/api/livekit/start')
      .set('Authorization', AUTH_HEADER)
      .set('Idempotency-Key', IDEM)
      .send({ candidate_id: UUID_2 });
    expect(res.status).toBe(201);
    expect(mockRpc).toHaveBeenCalledWith('check_and_reserve_quota', {
      p_requester_id: 'user-admin-0000-0000-000000000001',
      p_mode: 'live',
      p_idempotency_key: IDEM,
    });
    expect(mockRpc).toHaveBeenCalledWith('commit_quota_reservation', { p_reservation_id: RES_ID });
  });

  it('livekit: mid-flow ownership conflict → 409 AND reservation RELEASED', async () => {
    configureTables({
      system_config: { data: null, error: null },
      quota_policies: { data: [{ id: 'policy-1' }], error: null },
      candidates: (n: number) =>
        n === 0
          ? { data: { ...mockCandidate, owner_id: null }, error: null }
          : { data: null, error: null }, // claim fails → 409
      call_sessions: (n: number) =>
        n === 0 ? { data: mockSession, error: null } : { data: [{ id: mockSession.id }], error: null },
    });
    mockRpc.mockImplementation((name: string) => {
      if (name === 'check_and_reserve_quota') {
        return Promise.resolve({
          data: { status: 'ok', allowed: true, reservation_id: RES_ID, remaining_sessions: 3, remaining_cost_units: 5, warning_reached: false },
          error: null,
        });
      }
      if (name === 'release_quota_reservation') {
        return Promise.resolve({ data: { status: 'released' }, error: null });
      }
      return Promise.resolve({ data: { status: 'committed' }, error: null });
    });
    const res = await request(makeApp(makeUser('interviewer')))
      .post('/api/livekit/start')
      .set('Authorization', AUTH_HEADER)
      .set('Idempotency-Key', IDEM)
      .send({ candidate_id: UUID_2 });
    expect(res.status).toBe(409);
    expect(res.body.error).toBe('candidate_ownership_conflict');
    expect(mockRpc).toHaveBeenCalledWith('release_quota_reservation', { p_reservation_id: RES_ID });
    expect(mockRpc).not.toHaveBeenCalledWith('commit_quota_reservation', expect.anything());
  });
});

// ═══════════════════════════════════════════════════════════════════
// Maintenance gating (invariant 10)
// ═══════════════════════════════════════════════════════════════════

describe('start paths — maintenance gate (fail closed)', () => {
  it('livekit start is blocked for non-admin when maintenance is on → 503', async () => {
    configureTables({
      system_config: { data: { value: { enabled: true, reason: 'upgrade' }, updated_at: 'x' }, error: null },
      quota_policies: { data: [], error: null },
    });
    const res = await request(makeApp(makeUser('interviewer')))
      .post('/api/livekit/start')
      .set('Authorization', AUTH_HEADER)
      .send({ candidate_id: UUID_2 });
    expect(res.status).toBe(503);
    expect(res.body.error.type).toBe('maintenance_mode');
    expect(mockRpc).not.toHaveBeenCalled();
  });

  it('screening start is blocked when maintenance is on AND DB read fails closed', async () => {
    // DB-read failure for system_config → fail closed (503) even for admin.
    configureTables({
      system_config: { data: null, error: { message: 'db down' } },
      quota_policies: { data: [], error: null },
    });
    const res = await request(makeApp(makeUser('admin')))
      .post('/api/screening/start')
      .set('Authorization', AUTH_HEADER)
      .send({ candidate_id: UUID_2 });
    expect(res.status).toBe(503);
    expect(res.body.error.type).toBe('maintenance_mode');
  });

  it('maintenance does not block the ACTIVE completion path (turn route)', async () => {
    configureTables({
      system_config: { data: { value: { enabled: true, reason: 'upgrade' }, updated_at: 'x' }, error: null },
      call_sessions: { data: { id: UUID_1, candidate_id: UUID_2, status: 'in_progress' }, error: null },
      candidates: { data: mockCandidate, error: null },
      roles: { data: mockRole, error: null },
      transcript_turns: (n: number) => (n === 0 ? { data: [], error: null } : { data: null, error: null }),
    });
    const { runClaudeJSON } = await import('../lib/claude.js');
    vi.mocked(runClaudeJSON).mockResolvedValue({ message: 'Hello', done: false });
    const res = await request(makeApp(makeUser('admin')))
      .post(`/api/screening/${UUID_1}/turn`)
      .set('Authorization', AUTH_HEADER)
      .send({ text: 'I have React experience.' });
    expect(res.status).toBe(200);
    expect(res.body.done).toBe(false);
  });
});
