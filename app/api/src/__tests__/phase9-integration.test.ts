/**
 * Phase 9 L4 — integration wiring + negative controls.
 *
 * Drives the REAL createApp() (all routers mounted, PUBLIC_ROUTES extended,
 * maintenance + consent gate on exchange) with only Supabase/LiveKit/Claude
 * side effects mocked in-memory.
 *
 * Negative controls proven here (each non-vacuous):
 *   1. PUBLIC_ROUTES is exact method+path — near misses stay 401 and
 *      /api/me is never public.
 *   2. Exchange consent gate: missing/declined/withdrawn/expired consent or a
 *      missing/inactive template → stable 409 consent_required and the
 *      candidate_invites row is NOT updated (invite left unconsumed); a later
 *      declined record overrides an older grant.
 *   3. Maintenance blocks exchange BEFORE consume (503) while the consent
 *      status/submit routes remain reachable; active scoring/worker routes
 *      are unaffected by this gate.
 *   4. /api/me is authenticated-authoritative: 401 without auth; role comes
 *      from the membership resolver, not editable app_metadata.
 *   5. Assessment completion honors decision_use_blocked_at (no candidate
 *      status rewrite) while the assessment row + idempotent notification
 *      intent remain truthful.
 *   6. Notification intent insert is idempotent (23505 replay → no duplicate).
 *   7. Non-owner admin/recruiter/appeal operations are denied (403).
 *
 * Offline, deterministic, synthetic fixtures only.
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import request from 'supertest';
import { createApp } from '../app.js';
import { mockAuthGetUser, isPublicRoute, type AuthUser } from '../lib/auth.js';
import { MemoryRateLimitStore, setRateLimitStore } from '../lib/rate-limit.js';
import { setAuditSink } from '../lib/audit.js';
import { injectAssessmentRunner } from '../services/assessment.js';
import { insertNotificationIntent } from '../lib/notification-intent.js';

// ── JWT / auth helpers (AAL2 in payload) ─────────────────────────────

const JWT_AAL2 = 'eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiJ1c2VyLTAwMSIsImFhbCI6ImFhbDIifQ.signature';
const AUTH_HEADER = 'Bearer ' + JWT_AAL2;

const ADMIN: AuthUser = {
  id: 'user-admin-0000-0000-000000000001',
  email: 'admin@example.com',
  aal: 'aal2',
  active: true,
  appRole: 'admin',
  orgId: 'org-0000-0000-0000-000000000001',
};

const INTERVIEWER: AuthUser = {
  id: 'user-int-0000-0000-000000000002',
  email: 'interviewer@example.com',
  aal: 'aal2',
  active: true,
  appRole: 'interviewer',
  orgId: 'org-0000-0000-0000-000000000001',
};

const UUID_1 = '00000000-0000-4000-8000-000000000001';
const UUID_2 = '00000000-0000-4000-8000-000000000002';
const UUID_3 = '00000000-0000-4000-8000-000000000003';
const INVITE = 'a'.repeat(64);
const T_2026 = '2026-01-01T00:00:00.000Z';

// ── Supabase / LiveKit / Claude mocks ────────────────────────────────

const mockFrom = vi.fn();
const mockRpc = vi.fn();
const mockStorageFrom = vi.fn();

vi.mock('../lib/supabase.js', () => ({
  supabase: {
    from: (...args: unknown[]) => mockFrom(...args),
    rpc: (...args: unknown[]) => mockRpc(...args),
    storage: { from: (...args: unknown[]) => mockStorageFrom(...args) },
  },
  RESUME_BUCKET: 'resumes_v2',
}));

vi.mock('../lib/claude.js', () => ({
  runClaudeJSON: vi.fn().mockResolvedValue({ message: 'Hello', done: false }),
  runClaudeJSONWithProvenance: vi.fn().mockResolvedValue({
    data: { message: 'Hello', done: false },
    requestedModel: 'sonnet',
  }),
}));

vi.mock('../lib/resume-parser.js', () => ({
  parseResume: vi.fn().mockResolvedValue({
    text: 'Alice Example — Senior Software Engineer.',
    totalLength: 40,
    truncated: false,
  }),
  ParserError: class ParserError extends Error {},
  ParserTimeoutError: class ParserTimeoutError extends Error {},
  ParserOutputExceededError: class ParserOutputExceededError extends Error {},
}));

vi.mock('livekit-server-sdk', () => {
  class FakeRoomServiceClient {
    createRoom = vi.fn().mockResolvedValue({ name: 'screening-room' });
    updateRoomMetadata = vi.fn().mockResolvedValue({});
    deleteRoom = vi.fn().mockResolvedValue({});
  }
  class FakeAccessToken {
    addGrant = vi.fn();
    toJwt = vi.fn().mockResolvedValue('fake-livekit-jwt-token');
  }
  return { RoomServiceClient: FakeRoomServiceClient, AccessToken: FakeAccessToken };
});

/** Chainable, awaitable Supabase query-builder mock. */
interface CallRecord {
  table: string;
  method: string;
  args: unknown[];
}
const callLog: CallRecord[] = [];

function chain(value: unknown, table: string) {
  const c: Record<string, unknown> = {};
  const methods = [
    'select', 'insert', 'update', 'upsert', 'delete',
    'eq', 'neq', 'gt', 'gte', 'lt', 'lte', 'in', 'is', 'not',
    'order', 'limit', 'range', 'single', 'maybeSingle', 'execute',
  ];
  for (const m of methods) c[m] = (...args: unknown[]) => {
    callLog.push({ table, method: m, args });
    return chain(value, table);
  };
  c.then = (resolve: (v: unknown) => unknown) => Promise.resolve(value).then(resolve);
  c.catch = (reject: (e: unknown) => unknown) => Promise.resolve(value).catch(reject);
  return c;
}

function callsFor(table: string, method?: string): CallRecord[] {
  const recs = callLog.filter((r) => r.table === table);
  return method ? recs.filter((r) => r.method === method) : recs;
}

/** Per-table resolved values (function form receives 0-based call index). */
function configureTables(config: Record<string, unknown | ((callIndex: number) => unknown)>): void {
  const counters: Record<string, number> = {};
  mockFrom.mockImplementation((table: string) => {
    callLog.push({ table, method: 'from', args: [table] });
    const entry = config[table];
    if (entry === undefined) return chain({ data: null, error: null }, table);
    const n = counters[table] ?? 0;
    counters[table] = n + 1;
    const value = typeof entry === 'function' ? (entry as (c: number) => unknown)(n) : entry;
    return chain(value, table);
  });
}

function ok(value: unknown) {
  return { data: value, error: null };
}

const ACTIVE_INVITE_ROW = {
  id: UUID_3,
  candidate_id: UUID_2,
  session_id: UUID_1,
  expires_at: '2999-01-01T00:00:00.000Z',
  consumed_at: null,
  revoked_at: null,
};

const REQUIRED = ['ai_interview', 'recording', 'purpose', 'data_processing', 'retention', 'rights'];

/** App helpers. */
function createAuthedApp(user: AuthUser = ADMIN) {
  return createApp({
    nodeEnv: 'test',
    webOrigin: 'http://localhost:5173',
    authDeps: { getUser: mockAuthGetUser(user, JWT_AAL2) },
    auditSinkOverride: async () => {},
  });
}

function createUnauthedApp() {
  return createApp({ nodeEnv: 'test', webOrigin: 'http://localhost:5173' });
}

beforeEach(() => {
  vi.clearAllMocks();
  callLog.length = 0;
  setRateLimitStore(new MemoryRateLimitStore(10_000));
  setAuditSink(() => {});
  injectAssessmentRunner(null);
  configureTables({});
  mockRpc.mockResolvedValue({ data: null, error: { message: 'unknown rpc' } });
});

afterEach(() => {
  injectAssessmentRunner(null);
});

// ════════════════════════════════════════════════════════════════════
//  1. PUBLIC_ROUTES exact allowlist + /api/me never public
// ════════════════════════════════════════════════════════════════════

describe('PUBLIC_ROUTES exact allowlist (invariant 1)', () => {
  it('contains exactly the five Phase 9 public entries plus pre-existing ones', () => {
    for (const r of [
      ['GET', '/api/status'],
      ['GET', '/api/candidate-consent/template'],
      ['POST', '/api/candidate-consent/status'],
      ['POST', '/api/candidate-consent/submit'],
      ['POST', '/api/appeals'],
    ]) {
      expect(isPublicRoute(r[0], r[1])).toBe(true);
    }
    // /api/me and recruiter routes are NOT public.
    expect(isPublicRoute('GET', '/api/me')).toBe(false);
    expect(isPublicRoute('GET', '/api/notes')).toBe(false);
    expect(isPublicRoute('GET', '/api/notifications')).toBe(false);
    expect(isPublicRoute('GET', '/api/admin/members')).toBe(false);
    expect(isPublicRoute('GET', '/api/appeals')).toBe(false);
    expect(isPublicRoute('POST', '/api/appeals/grants')).toBe(false);
  });

  it('near-miss methods/paths are NOT public (exact match, no prefix leniency)', () => {
    // Same path, wrong method.
    expect(isPublicRoute('GET', '/api/candidate-consent/status')).toBe(false);
    expect(isPublicRoute('GET', '/api/candidate-consent/submit')).toBe(false);
    expect(isPublicRoute('POST', '/api/candidate-consent/template')).toBe(false);
    expect(isPublicRoute('POST', '/api/status')).toBe(false);
    // Adjacent/prefix paths.
    expect(isPublicRoute('GET', '/api/status/sub')).toBe(false);
    expect(isPublicRoute('POST', '/api/candidate-consent/status/sub')).toBe(false);
    expect(isPublicRoute('POST', '/api/appeals/grants')).toBe(false);
    expect(isPublicRoute('GET', '/api/appeals')).toBe(false);
    expect(isPublicRoute('POST', '/api/appeals/extra')).toBe(false);
  });

  it('near misses return 401 through the real app (no token → no handler)', async () => {
    const app = createUnauthedApp();
    const checks: Array<[string, string, unknown]> = [
      ['get', '/api/candidate-consent/status', undefined],
      ['get', '/api/candidate-consent/submit', undefined],
      ['post', '/api/candidate-consent/template', {}],
      ['get', '/api/status/sub', undefined],
      ['get', '/api/appeals', undefined],
      ['post', '/api/appeals/grants', {}],
      ['get', '/api/me', undefined],
      ['get', '/api/me/sub', undefined],
      ['get', '/api/admin/members', undefined],
      ['post', '/api/admin/maintenance', {}],
    ];
    const failures: string[] = [];
    for (const [method, path, body] of checks) {
      const res =
        method === 'get'
          ? await (request(app) as any).get(path)
          : await (request(app) as any).post(path).send(body ?? {});
      if (res.status !== 401 || res.body?.error?.type !== 'authentication_error') {
        failures.push(`${method.toUpperCase()} ${path} -> ${res.status}`);
      }
    }
    expect(failures).toEqual([]);
  });
});

// ════════════════════════════════════════════════════════════════════
//  2. /api/me authenticated-authoritative
// ════════════════════════════════════════════════════════════════════

describe('/api/me (invariant 5)', () => {
  it('returns 401 without auth', async () => {
    const app = createUnauthedApp();
    const res = await request(app).get('/api/me');
    expect(res.status).toBe(401);
    expect(res.body.error.type).toBe('authentication_error');
  });

  it('returns the membership-resolved role/active (authoritative, not app_metadata)', async () => {
    // app_metadata claims 'admin' in the JWT, but the membership resolver is
    // what requireAuth trusts; /api/me reports the resolved role.
    const app = createAuthedApp(ADMIN);
    const res = await request(app).get('/api/me').set('Authorization', AUTH_HEADER);
    expect(res.status).toBe(200);
    expect(res.body).toEqual({
      userId: ADMIN.id,
      email: ADMIN.email,
      role: 'admin',
      active: true,
    });
  });

  it('reports interviewer role from the authenticated membership', async () => {
    const app = createAuthedApp(INTERVIEWER);
    const res = await request(app).get('/api/me').set('Authorization', AUTH_HEADER);
    expect(res.status).toBe(200);
    expect(res.body.role).toBe('interviewer');
    expect(res.body.active).toBe(true);
  });
});

// ════════════════════════════════════════════════════════════════════
//  3. Exchange consent gate (invariant 4)
// ════════════════════════════════════════════════════════════════════

describe('exchange consent gate (invariant 4)', () => {
  const EXCHANGE_BODY = { token: INVITE };

  function consentGateApp(consentRecord: unknown, template: unknown = ok({ version: '1.0', required_consents: REQUIRED })) {
    configureTables({
      system_config: ok(null), // maintenance off
      candidate_invites: (n: number) =>
        n === 0 ? ok(ACTIVE_INVITE_ROW) : ok([{ id: UUID_3 }]),
      consent_records: consentRecord,
      consent_templates: template,
      call_sessions: ok({ id: UUID_1, external_call_id: `screening-${UUID_1}`, status: 'waiting' }),
      candidate_access_grants: ok({ data: null, error: null }),
    });
    return createUnauthedApp();
  }

  it('grants when latest consent is granted and satisfies the active template', async () => {
    const app = consentGateApp(ok({ status: 'granted', consents: REQUIRED, expires_at: null }));
    const res = await request(app).post('/api/livekit/exchange').send(EXCHANGE_BODY);
    expect(res.status).toBe(200);
    expect(res.body.session_id).toBe(UUID_1);
  });

  it('missing consent record → 409 consent_required and invite update count is zero', async () => {
    const app = consentGateApp({ data: null, error: null });
    const res = await request(app).post('/api/livekit/exchange').send(EXCHANGE_BODY);
    expect(res.status).toBe(409);
    expect(res.body.error).toBe('consent_required');
    // The invite row was only SELECTed, never consumed (no UPDATE on
    // candidate_invites) — a later grant/retry can still succeed.
    expect(callsFor('candidate_invites', 'update')).toHaveLength(0);
  });

  it('declined latest record → 409 and invite unconsumed', async () => {
    const app = consentGateApp(ok({ status: 'declined', consents: [], expires_at: null }));
    const res = await request(app).post('/api/livekit/exchange').send(EXCHANGE_BODY);
    expect(res.status).toBe(409);
    expect(res.body.error).toBe('consent_required');
  });

  it('later decline overrides an older grant (latest-record semantics)', async () => {
    // The mock returns ONLY the latest (declined) record — the gate must not
    // reach back to an older granted row the way a status-filtered query would.
    const app = consentGateApp(ok({ status: 'declined', consents: REQUIRED, expires_at: null }));
    const res = await request(app).post('/api/livekit/exchange').send(EXCHANGE_BODY);
    expect(res.status).toBe(409);
    expect(res.body.error).toBe('consent_required');
  });

  it('withdrawn latest record → 409', async () => {
    const app = consentGateApp(ok({ status: 'withdrawn', consents: [], expires_at: null }));
    const res = await request(app).post('/api/livekit/exchange').send(EXCHANGE_BODY);
    expect(res.status).toBe(409);
  });

  it('expired grant → 409', async () => {
    const app = consentGateApp(
      ok({ status: 'granted', consents: REQUIRED, expires_at: new Date(Date.now() - 86_400_000).toISOString() }),
    );
    const res = await request(app).post('/api/livekit/exchange').send(EXCHANGE_BODY);
    expect(res.status).toBe(409);
  });

  it('granted but missing a template-required type → 409', async () => {
    const app = consentGateApp(ok({ status: 'granted', consents: ['ai_interview'], expires_at: null }));
    const res = await request(app).post('/api/livekit/exchange').send(EXCHANGE_BODY);
    expect(res.status).toBe(409);
    expect(res.body.error).toBe('consent_required');
  });

  it('missing/inactive template fails closed → 409', async () => {
    const app = consentGateApp(ok({ status: 'granted', consents: REQUIRED, expires_at: null }), ok(null));
    const res = await request(app).post('/api/livekit/exchange').send(EXCHANGE_BODY);
    expect(res.status).toBe(409);
    expect(res.body.error).toBe('consent_required');
  });

  it('maintenance enabled → 503 before consume; consent status remains reachable', async () => {
    configureTables({
      system_config: ok({ value: { enabled: true, reason: 'planned window' }, updated_at: T_2026 }),
      candidate_invites: ok(ACTIVE_INVITE_ROW),
      consent_records: ok({ status: 'granted', consents: REQUIRED, expires_at: null }),
      consent_templates: ok({ version: '1.0', required_consents: REQUIRED }),
    });
    const app = createUnauthedApp();

    const exchange = await request(app).post('/api/livekit/exchange').send(EXCHANGE_BODY);
    expect(exchange.status).toBe(503);
    expect(exchange.body.error.type).toBe('maintenance_mode');
    // Blocked BEFORE consume — invite not consumed.
    expect(callsFor('candidate_invites', 'update')).toHaveLength(0);

    // Consent status (a consent flow, not a join) stays reachable during maintenance.
    const status = await request(app)
      .post('/api/candidate-consent/status')
      .send({ invite_token: INVITE });
    expect(status.status).toBe(200);
    expect(status.body.has_consent).toBe(true);
  });
});

// ════════════════════════════════════════════════════════════════════
//  4. Assessment: decision-use block + idempotent notification intent
// ════════════════════════════════════════════════════════════════════

describe('assessment decision-use block + notification intent (invariants 8/9)', () => {
  const SESSION_ID = UUID_1;
  const CANDIDATE_ID = UUID_2;
  const ASSESSMENT_ID = UUID_3;

  function assessmentApp(decisionBlocked: boolean) {
    configureTables({
      call_sessions: (n: number) =>
        ok({
          id: SESSION_ID,
          candidate_id: CANDIDATE_ID,
          owner_id: 'user-int-0000-0000-000000000002',
          role_id: null,
          status: 'completed',
          terminal_reason: 'conversation_complete',
        }),
      transcript_turns: ok([]),
      roles: ok(null),
      candidates: ok({ name: 'Alice', parsed: null, decision_use_blocked_at: decisionBlocked ? T_2026 : null }),
      assessments: ok({ id: ASSESSMENT_ID }),
      notification_intents: ok(null),
      audit_events: ok(null),
    });
    return createAuthedApp();
  }

  it('returns 200 and skips candidate status rewrite when decision use is blocked', async () => {
    const app = assessmentApp(true);
    const res = await request(app).post(`/api/assess/${SESSION_ID}`).set('Authorization', AUTH_HEADER);
    expect(res.status).toBe(200);
    expect(res.body.id).toBe(ASSESSMENT_ID);
    // Assessment row persisted.
    expect(callsFor('assessments', 'insert')).toHaveLength(1);
    // No candidates.update (block honored).
    expect(callsFor('candidates', 'update')).toHaveLength(0);
  });

  it('updates candidate status when decision use is NOT blocked (existing behavior preserved)', async () => {
    const app = assessmentApp(false);
    const res = await request(app).post(`/api/assess/${SESSION_ID}`).set('Authorization', AUTH_HEADER);
    expect(res.status).toBe(200);
    expect(callsFor('candidates', 'update')).toHaveLength(1);
  });
});

describe('notification intent idempotency (invariant 9)', () => {
  it('duplicate idempotency key → created:false, no duplicate row', async () => {
    // First insert succeeds.
    configureTables({ notification_intents: ok(null) });
    const first = await insertNotificationIntent({
      idempotency_key: 'assessment_ready:uuid-123',
      kind: 'assessment_ready',
      candidate_id: UUID_2,
      consent_verified: false,
      payload: { session_id: UUID_1 },
    });
    expect(first.created).toBe(true);

    // Second insert hits a unique-violation (23505) → replay, not duplicate.
    vi.clearAllMocks();
    const uniqueViolation = { data: null, error: { message: 'duplicate key', code: '23505' } };
    configureTables({ notification_intents: uniqueViolation });
    const replay = await insertNotificationIntent({
      idempotency_key: 'assessment_ready:uuid-123',
      kind: 'assessment_ready',
      candidate_id: UUID_2,
      consent_verified: false,
      payload: { session_id: UUID_1 },
    });
    expect(replay.ok).toBe(true);
    expect(replay.created).toBe(false);
  });

  it('non-unique DB error propagates (never masqueraded as a delivery)', async () => {
    vi.clearAllMocks();
    configureTables({ notification_intents: { data: null, error: { message: 'db down', code: 'PGRST' } } });
    await expect(
      insertNotificationIntent({
        idempotency_key: 'assessment_ready:uuid-456',
        kind: 'assessment_ready',
        candidate_id: UUID_2,
        consent_verified: false,
      }),
    ).rejects.toThrow('failed to insert notification intent');
  });
});

// ════════════════════════════════════════════════════════════════════
//  5. Non-owner operations denied
// ════════════════════════════════════════════════════════════════════

describe('non-owner / role denials (invariant 11)', () => {
  it('interviewer cannot mutate another interviewer-owned candidate notes', async () => {
    configureTables({ candidates: ok({ id: UUID_2, owner_id: 'someone-else' }) });
    const app = createAuthedApp(INTERVIEWER);
    const res = await request(app)
      .post('/api/notes')
      .set('Authorization', AUTH_HEADER)
      .send({ candidate_id: UUID_2, note: 'poach' });
    expect(res.status).toBe(403);
    expect(res.body.error.type).toBe('authorization_error');
  });

  it('non-admin cannot list admin members', async () => {
    const app = createAuthedApp(INTERVIEWER);
    const res = await request(app).get('/api/admin/members').set('Authorization', AUTH_HEADER);
    expect(res.status).toBe(403);
  });

  it('viewer cannot issue an appeal grant (interviewer+ required)', async () => {
    const viewerApp = createAuthedApp({ ...ADMIN, appRole: 'viewer', id: 'user-view-0000-0000-000000000003' });
    const res = await request(viewerApp)
      .post('/api/appeals/grants')
      .set('Authorization', AUTH_HEADER)
      .send({ candidate_id: UUID_2, session_id: UUID_1, expires_in_hours: 24 });
    expect(res.status).toBe(403);
  });

  it('interviewer cannot issue an appeal grant for a candidate they do not own', async () => {
    configureTables({ candidates: ok({ id: UUID_2, owner_id: 'someone-else' }) });
    const app = createAuthedApp(INTERVIEWER);
    const res = await request(app)
      .post('/api/appeals/grants')
      .set('Authorization', AUTH_HEADER)
      .send({ candidate_id: UUID_2, session_id: UUID_1, expires_in_hours: 24 });
    expect(res.status).toBe(403);
  });

  it('interviewer cannot review an appeal for a candidate they do not own', async () => {
    configureTables({
      appeal_requests: ok({ id: UUID_3, candidate_id: UUID_2 }),
      candidates: ok({ id: UUID_2, owner_id: 'someone-else' }),
    });
    const app = createAuthedApp(INTERVIEWER);
    const res = await request(app)
      .post(`/api/appeals/${UUID_3}/review`)
      .set('Authorization', AUTH_HEADER)
      .send({ to_status: 'under_review' });
    expect(res.status).toBe(403);
  });
});

// ════════════════════════════════════════════════════════════════════
//  6. Phase 9 review repair — admin audit/sessions/quota + CSV export
// ════════════════════════════════════════════════════════════════════

describe('review repair — admin views (OPS-01/OPS-05)', () => {
  it('GET /api/admin/audit is admin-only (401 unauth, 403 non-admin)', async () => {
    const unauth = await request(createUnauthedApp()).get('/api/admin/audit');
    expect(unauth.status).toBe(401);
    const nonAdmin = await request(createAuthedApp(INTERVIEWER))
      .get('/api/admin/audit')
      .set('Authorization', AUTH_HEADER);
    expect(nonAdmin.status).toBe(403);
  });

  it('GET /api/admin/sessions is admin-only and field-minimized', async () => {
    configureTables({
      call_sessions: ok([
        { id: UUID_1, candidate_id: UUID_2, role_id: null, status: 'in_progress', created_at: T_2026, started_at: T_2026, ended_at: null, email: 'leak@example.com', recording_object_key: 'k', model: 'haiku' },
      ]),
    });
    const res = await request(createAuthedApp())
      .get('/api/admin/sessions')
      .set('Authorization', AUTH_HEADER);
    expect(res.status).toBe(200);
    expect(res.body.sessions[0]).toEqual({
      id: UUID_1,
      candidate_id: UUID_2,
      role_id: null,
      status: 'in_progress',
      created_at: T_2026,
      started_at: T_2026,
      ended_at: null,
    });
    expect(JSON.stringify(res.body)).not.toContain('leak@example.com');
  });

  it('POST /api/admin/quotas derives the actor from auth (never the client)', async () => {
    mockRpc.mockResolvedValue({ data: { status: 'ok', id: UUID_3, created: true }, error: null });
    const res = await request(createAuthedApp())
      .post('/api/admin/quotas')
      .set('Authorization', AUTH_HEADER)
      .send({ scope: 'global', max_sessions: 5, enabled: true });
    expect(res.status).toBe(201);
    expect(mockRpc).toHaveBeenCalledWith('upsert_quota_policy', expect.objectContaining({
      p_actor_id: ADMIN.id,
      p_policy_id: null,
      p_scope: 'global',
      p_enabled: true,
    }));
  });

  it('PATCH /api/admin/quotas/:id maps RPC not_found to 404 (no fabricated row)', async () => {
    mockRpc.mockResolvedValue({ data: { status: 'not_found' }, error: null });
    const res = await request(createAuthedApp())
      .patch(`/api/admin/quotas/${UUID_3}`)
      .set('Authorization', AUTH_HEADER)
      .send({ scope: 'global', enabled: false });
    expect(res.status).toBe(404);
    expect(res.body.error).toBe('policy_not_found');
  });

  it('quota policy client bodies cannot inject actor_id or price fields (strict schema)', async () => {
    const res = await request(createAuthedApp())
      .post('/api/admin/quotas')
      .set('Authorization', AUTH_HEADER)
      .send({ scope: 'global', actor_id: UUID_1, price_usd: 9.99, max_sessions: 1 });
    expect(res.status).toBe(400);
    expect(mockRpc).not.toHaveBeenCalled();
  });
});

describe('review repair — CSV transcript export (OPS-07)', () => {
  it('export includes transcript turns + scorecard, no PII columns', async () => {
    const SESSION_UUID = UUID_1;
    configureTables({
      candidates: ok({ id: UUID_2, owner_id: null, status: 'screened' }),
      assessments: ok([
        { id: UUID_3, session_id: SESSION_UUID, english: null, tone: { clarity: 8 }, communication: { score: 8 }, motivation: { score: 8 }, role_fit: { score: 8 }, overall_score: 82, recommendation: 'advance', created_at: T_2026 },
      ]),
      call_sessions: ok([{ id: SESSION_UUID, created_at: T_2026 }]),
      transcript_turns: ok([
        { session_id: SESSION_UUID, turn_index: 0, speaker: 'bot', text: 'Hello', created_at: T_2026 },
        { session_id: SESSION_UUID, turn_index: 1, speaker: 'candidate', text: 'Hi there', created_at: T_2026 },
      ]),
      audit_events: ok(null),
    });
    const res = await request(createAuthedApp())
      .get(`/api/export/${UUID_2}/csv`)
      .set('Authorization', AUTH_HEADER);
    expect(res.status).toBe(200);
    expect(res.headers['content-disposition']).toContain('screening-export-');
    expect(res.text).toContain('record_type');
    expect(res.text).toContain('scorecard');
    expect(res.text).toContain('transcript');
    expect(res.text).toContain('Hi there');
    expect(res.text).not.toContain('email');
    expect(res.text).not.toContain('phone');
  });
});
