/**
 * PR-L: retirement of the legacy browser screening entry points.
 *
 * With LEGACY_BROWSER_SCREENING_ENABLED=false, POST /api/livekit/start, /invite,
 * /preflight and /exchange answer 410 `browser_screening_retired` BEFORE any
 * validation, database read, quota reservation or provider call. Everything an
 * already-started legacy session needs to finish (worker-context, /complete,
 * the recording routes) stays open: that is the drain. Enabled (the default) the
 * routes behave exactly as before.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import express from 'express';
import request from 'supertest';

const mocks = vi.hoisted(() => ({
  from: vi.fn(),
  rpc: vi.fn(),
  roomCreate: vi.fn(),
  roomDelete: vi.fn(),
  provision: vi.fn(),
  createSession: vi.fn(),
  transition: vi.fn(),
  quotaEnabled: vi.fn(),
  reserveQuota: vi.fn(),
  createGrant: vi.fn(),
  validateGrant: vi.fn(),
  validateInvite: vi.fn(),
  resolveWorkerContext: vi.fn(),
  finalize: vi.fn(),
  runAssessment: vi.fn(),
  inviteMaybeSingle: vi.fn(),
  inviteSingle: vi.fn(),
  inviteUpdate: vi.fn(),
}));

vi.mock('../lib/supabase.js', () => ({
  supabase: { from: mocks.from, rpc: mocks.rpc },
  RESUME_BUCKET: 'resumes_v2',
}));
vi.mock('livekit-server-sdk', () => {
  class AccessToken {
    addGrant(): void {}
    async toJwt(): Promise<string> { return 'jwt-token'; }
  }
  class RoomServiceClient {
    async createRoom(...args: unknown[]): Promise<void> { await mocks.roomCreate(...args); }
    async deleteRoom(...args: unknown[]): Promise<void> { await mocks.roomDelete(...args); }
  }
  return { AccessToken, RoomServiceClient, TrackSource: { MICROPHONE: 1 } };
});
vi.mock('../lib/room-provisioning.js', () => ({
  provisionRoomForCreatedSession: mocks.provision,
  requireLiveKitConfigured: vi.fn(),
}));
vi.mock('../lib/session-lifecycle.js', () => ({
  createSession: mocks.createSession,
  transitionSession: mocks.transition,
}));
vi.mock('../lib/quota.js', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../lib/quota.js')>()),
  quotaEnforcementEnabled: mocks.quotaEnabled,
  reserveQuota: mocks.reserveQuota,
}));
vi.mock('../lib/candidate-access.js', () => ({
  createGrant: mocks.createGrant,
  validateGrant: mocks.validateGrant,
}));
vi.mock('../lib/invite-validation.js', () => ({
  validateInvite: mocks.validateInvite,
  STABLE_INVITE_ERROR: 'invite_token_invalid_or_expired',
}));
vi.mock('../lib/worker-context.js', () => ({
  resolveWorkerContext: mocks.resolveWorkerContext,
  ERR_DB_FAILED: 'ERR_DB_FAILED',
}));
vi.mock('../lib/recording-egress.js', () => ({
  finalizeAuthoritativeRecording: mocks.finalize,
  recordRecordingFinalizeDeferral: vi.fn(async () => undefined),
}));
vi.mock('../services/assessment.js', () => ({ runAssessment: mocks.runAssessment }));
vi.mock('../lib/maintenance.js', () => ({
  readMaintenanceState: vi.fn().mockResolvedValue({ ok: true, enabled: false }),
  maintenanceBlockedBody: () => ({ error: 'maintenance' }),
  createMaintenanceMiddleware: () => (_req: unknown, _res: unknown, next: () => void) => next(),
}));

import { invitesRouter } from '../routes/invites.js';
import { livekitRouter } from '../routes/livekit.js';
import { finalErrorHandler } from '../lib/validation.js';

const ENV_KEY = 'LEGACY_BROWSER_SCREENING_ENABLED';
const ORIGINAL_FLAG = process.env[ENV_KEY];
const WORKER_SECRET = 'w'.repeat(32);
const ORIGINAL_WORKER_SECRET = process.env.WORKER_CONTEXT_SECRET;

const CANDIDATE = '10000000-0000-4000-8000-000000000001';
const SESSION = '30000000-0000-4000-8000-000000000001';
const ROOM = `screening-${SESSION}`;
const TOKEN = 'b'.repeat(64);
const GRANT = 'c'.repeat(64);
const MINUTE = 60_000;

const GONE_BODY = { error: 'browser_screening_retired' };

function retire(): void {
  process.env[ENV_KEY] = 'false';
}

function app(role: 'admin' | 'interviewer' = 'interviewer'): express.Express {
  const a = express();
  a.use(express.json());
  a.use((req, _res, next) => {
    (req as unknown as { authUser: unknown }).authUser = { id: 'recruiter-1', appRole: role };
    next();
  });
  a.use('/api/livekit', invitesRouter);
  a.use('/api/livekit', livekitRouter);
  a.use(finalErrorHandler);
  return a;
}

function inviteRow(consumedAgoMs: number | null, over: Record<string, unknown> = {}) {
  return {
    id: 'invite-1',
    candidate_id: CANDIDATE,
    session_id: SESSION,
    expires_at: new Date(Date.now() + 60 * MINUTE).toISOString(),
    consumed_at: consumedAgoMs === null ? null : new Date(Date.now() - consumedAgoMs).toISOString(),
    revoked_at: null,
    ...over,
  };
}

/** select().eq().single() resolving to one canned row. */
function selectSingle(row: Record<string, unknown> | null) {
  return { select: () => ({ eq: () => ({ single: async () => ({ data: row, error: null }) }) }) };
}

/** Table-aware Supabase double for the exchange handler. */
function wireExchangeDb(invite: Record<string, unknown> | null, error: unknown = null): void {
  mocks.inviteMaybeSingle.mockResolvedValue({ data: invite, error });
  mocks.inviteSingle.mockResolvedValue({ data: invite, error });
  mocks.from.mockImplementation((table: string) => {
    if (table === 'candidate_invites') {
      return {
        select: () => ({
          eq: () => ({ maybeSingle: mocks.inviteMaybeSingle, single: mocks.inviteSingle }),
        }),
        update: mocks.inviteUpdate,
      };
    }
    if (table === 'consent_records') {
      const row = { status: 'granted', consents: ['recording'], expires_at: null };
      return {
        select: () => ({
          eq: () => ({
            order: () => ({
              limit: () => ({ maybeSingle: async () => ({ data: row, error: null }) }),
            }),
          }),
        }),
      };
    }
    if (table === 'consent_templates') {
      const row = { required_consents: ['recording'] };
      return {
        select: () => ({
          eq: () => ({
            order: () => ({
              limit: () => ({ maybeSingle: async () => ({ data: row, error: null }) }),
            }),
          }),
        }),
      };
    }
    if (table === 'call_sessions') {
      const row = { id: SESSION, external_call_id: ROOM, status: 'in_progress' };
      return selectSingle(row);
    }
    return selectSingle(null);
  });
}

let warnSpy: ReturnType<typeof vi.spyOn>;
let errorSpy: ReturnType<typeof vi.spyOn>;

beforeEach(() => {
  vi.clearAllMocks();
  warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
  errorSpy = vi.spyOn(console, 'error').mockImplementation(() => undefined);
  mocks.quotaEnabled.mockResolvedValue({ ok: true, enabled: false });
  mocks.createGrant.mockResolvedValue({
    grantToken: GRANT,
    expiresAt: new Date('2030-01-01T00:00:00Z'),
  });
  process.env.WORKER_CONTEXT_SECRET = WORKER_SECRET;
  delete process.env[ENV_KEY];
});

afterEach(() => {
  if (ORIGINAL_FLAG === undefined) delete process.env[ENV_KEY];
  else process.env[ENV_KEY] = ORIGINAL_FLAG;
  if (ORIGINAL_WORKER_SECRET === undefined) delete process.env.WORKER_CONTEXT_SECRET;
  else process.env.WORKER_CONTEXT_SECRET = ORIGINAL_WORKER_SECRET;
  // Restore only the console spies: restoreAllMocks would also wipe the
  // implementations of the module-mock factories above.
  warnSpy.mockRestore();
  errorSpy.mockRestore();
});

describe('retired: POST /api/livekit/start', () => {
  it('answers 410 browser_screening_retired with no-store', async () => {
    retire();
    const res = await request(app()).post('/api/livekit/start').send({ candidate_id: CANDIDATE });
    expect(res.status).toBe(410);
    expect(res.body).toEqual(GONE_BODY);
    expect(res.headers['cache-control']).toContain('no-store');
  });

  it('answers 410 even for an invalid body (the route is gone, not mis-called)', async () => {
    retire();
    const res = await request(app()).post('/api/livekit/start').send({});
    expect(res.status).toBe(410);
    expect(res.body.error).toBe('browser_screening_retired');
  });

  it('creates nothing: no DB read, no quota, no session, no room', async () => {
    retire();
    await request(app('admin')).post('/api/livekit/start').send({ candidate_id: CANDIDATE });
    expect(mocks.from).not.toHaveBeenCalled();
    expect(mocks.quotaEnabled).not.toHaveBeenCalled();
    expect(mocks.reserveQuota).not.toHaveBeenCalled();
    expect(mocks.createSession).not.toHaveBeenCalled();
    expect(mocks.provision).not.toHaveBeenCalled();
  });

  it('is enabled by default: the unchanged handler validates and runs', async () => {
    const invalid = await request(app()).post('/api/livekit/start').send({});
    expect(invalid.status).toBe(400);

    mocks.from.mockImplementation(() => ({
      select: () => ({
        eq: () => ({ single: async () => ({ data: null, error: { message: 'missing' } }) }),
      }),
    }));
    const res = await request(app()).post('/api/livekit/start').send({ candidate_id: CANDIDATE });
    expect(res.status).not.toBe(410);
    expect(mocks.quotaEnabled).toHaveBeenCalledOnce();
  });

  it('is enabled for an explicit "true"', async () => {
    process.env[ENV_KEY] = 'true';
    const res = await request(app()).post('/api/livekit/start').send({});
    expect(res.status).toBe(400);
  });

  it('fails closed (410) for a malformed flag value', async () => {
    process.env[ENV_KEY] = 'definitely';
    const res = await request(app()).post('/api/livekit/start').send({ candidate_id: CANDIDATE });
    expect(res.status).toBe(410);
    expect(res.body.error).toBe('browser_screening_retired');
  });
});

describe('retired: POST /api/livekit/invite', () => {
  const body = { candidate_id: CANDIDATE, session_id: SESSION };

  it('answers 410 and mints/persists no invite', async () => {
    retire();
    const res = await request(app()).post('/api/livekit/invite').send(body);
    expect(res.status).toBe(410);
    expect(res.body).toEqual(GONE_BODY);
    expect(mocks.from).not.toHaveBeenCalled();
  });

  it('is enabled by default: the unchanged handler looks the session up', async () => {
    mocks.from.mockImplementation(() => ({
      select: () => ({
        eq: () => ({ single: async () => ({ data: null, error: { message: 'missing' } }) }),
      }),
    }));
    const res = await request(app()).post('/api/livekit/invite').send(body);
    expect(res.status).toBe(404);
    expect(res.body).toEqual({ error: 'session_not_found' });
    expect(mocks.from).toHaveBeenCalledWith('call_sessions');
  });
});

describe('retired: POST /api/livekit/preflight', () => {
  it('answers 410 and creates no diagnostic room, for valid and invalid bodies', async () => {
    retire();
    const valid = await request(app()).post('/api/livekit/preflight').send({ invite_token: TOKEN });
    const invalid = await request(app()).post('/api/livekit/preflight').send({});
    expect(valid.status).toBe(410);
    expect(valid.body).toEqual(GONE_BODY);
    expect(invalid.status).toBe(410);
    expect(mocks.validateInvite).not.toHaveBeenCalled();
    expect(mocks.roomCreate).not.toHaveBeenCalled();
    expect(mocks.from).not.toHaveBeenCalled();
  });

  it('is enabled by default: the unchanged handler validates the invite', async () => {
    mocks.validateInvite.mockResolvedValue({ ok: false, code: 'invite_invalid' });
    const res = await request(app()).post('/api/livekit/preflight').send({ invite_token: TOKEN });
    expect(res.status).toBe(404);
    expect(res.body).toEqual({ error: 'invite_token_invalid_or_expired' });
    expect(mocks.validateInvite).toHaveBeenCalledOnce();
  });
});

describe('retired: POST /api/livekit/exchange', () => {
  it.each([
    ['an unknown token', null, null],
    ['a never-consumed invite', inviteRow(null), null],
    ['an invite consumed beyond the grace window', inviteRow(10 * MINUTE), null],
    ['a revoked invite', inviteRow(MINUTE, { revoked_at: new Date().toISOString() }), null],
  ])('answers 410 for %s and mints no grant', async (_name, invite, error) => {
    retire();
    wireExchangeDb(invite, error);
    const res = await request(app()).post('/api/livekit/exchange').send({ token: TOKEN });
    expect(res.status).toBe(410);
    expect(res.body).toEqual(GONE_BODY);
    expect(mocks.createGrant).not.toHaveBeenCalled();
    expect(mocks.inviteUpdate).not.toHaveBeenCalled();
    expect(mocks.inviteSingle).not.toHaveBeenCalled();
  });

  it('answers 410 when the drain lookup itself fails (retirement fails closed)', async () => {
    retire();
    wireExchangeDb(null, { message: 'db down' });
    const res = await request(app()).post('/api/livekit/exchange').send({ token: TOKEN });
    expect(res.status).toBe(410);
    expect(mocks.createGrant).not.toHaveBeenCalled();
  });

  it('answers 410 for a malformed token without any database read', async () => {
    retire();
    wireExchangeDb(inviteRow(MINUTE));
    const res = await request(app()).post('/api/livekit/exchange').send({ token: 'not-hex' });
    expect(res.status).toBe(410);
    expect(mocks.from).not.toHaveBeenCalled();
  });

  it('answers 410 for a missing body without any database read', async () => {
    retire();
    wireExchangeDb(inviteRow(MINUTE));
    const res = await request(app()).post('/api/livekit/exchange').send({});
    expect(res.status).toBe(410);
    expect(mocks.from).not.toHaveBeenCalled();
  });

  it('DRAIN: re-issues the join for an invite consumed moments ago', async () => {
    retire();
    wireExchangeDb(inviteRow(MINUTE));
    const res = await request(app()).post('/api/livekit/exchange').send({ token: TOKEN });
    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({
      grant_token: GRANT,
      room_name: ROOM,
      session_id: SESSION,
      livekit_token: 'jwt-token',
    });
    // The existing same-bearer grace path: the invite is NOT consumed again.
    expect(mocks.inviteUpdate).not.toHaveBeenCalled();
    expect(mocks.createGrant).toHaveBeenCalledOnce();
    expect(mocks.provision).not.toHaveBeenCalled();
  });

  it('DRAIN does not bypass the handler: an already-ended session is refused', async () => {
    retire();
    wireExchangeDb(inviteRow(MINUTE));
    const base = mocks.from.getMockImplementation()!;
    mocks.from.mockImplementation((table: string) => table === 'call_sessions'
      ? {
        select: () => ({
          eq: () => ({
            single: async () => ({
              data: { id: SESSION, external_call_id: ROOM, status: 'completed' },
              error: null,
            }),
          }),
        }),
      }
      : base(table));
    const res = await request(app()).post('/api/livekit/exchange').send({ token: TOKEN });
    expect(res.status).toBe(404);
    expect(res.body).toEqual({ error: 'invite_token_invalid_or_expired' });
    expect(mocks.createGrant).not.toHaveBeenCalled();
  });

  it('is enabled by default and performs NO extra drain read', async () => {
    wireExchangeDb(null);
    const res = await request(app()).post('/api/livekit/exchange').send({ token: TOKEN });
    expect(res.status).toBe(404);
    expect(res.body).toEqual({ error: 'invite_token_invalid_or_expired' });
    expect(mocks.inviteMaybeSingle).not.toHaveBeenCalled();
    expect(mocks.inviteSingle).toHaveBeenCalledOnce();
  });

  it('is enabled by default: a fresh invite is consumed and exchanged as before', async () => {
    wireExchangeDb(inviteRow(null));
    const consumed = { data: [{ id: 'invite-1' }], error: null };
    mocks.inviteUpdate.mockReturnValue({
      eq: () => ({
        is: () => ({ is: () => ({ gt: () => ({ select: async () => consumed }) }) }),
      }),
    });
    const res = await request(app()).post('/api/livekit/exchange').send({ token: TOKEN });
    expect(res.status).toBe(200);
    expect(res.body.grant_token).toBe(GRANT);
    expect(mocks.inviteUpdate).toHaveBeenCalledOnce();
  });
});

describe('retired: the drain keeps an already-started session able to finish', () => {
  it('serves worker-context, completes the session and still refuses new entry', async () => {
    retire();
    const a = app();

    // 1. The worker for the live session still gets its context.
    mocks.resolveWorkerContext.mockResolvedValue({ ok: true, context: { session_id: SESSION } });
    const context = await request(a)
      .post('/api/livekit/worker-context')
      .set('authorization', `Bearer ${WORKER_SECRET}`)
      .send({ session_id: SESSION, room_name: ROOM });
    expect(context.status).toBe(200);
    expect(context.body.ok).toBe(true);
    expect(mocks.resolveWorkerContext).toHaveBeenCalledWith(SESSION, ROOM);

    // 2. The candidate's grant-authenticated completion still works.
    mocks.validateGrant.mockResolvedValue({ ok: true, payload: { session_id: SESSION } });
    mocks.transition.mockResolvedValue({ ok: true, conflict: false });
    mocks.finalize.mockResolvedValue('pending');
    mocks.from.mockImplementation((table: string) => {
      if (table === 'call_sessions') {
        return {
          select: () => ({
            eq: () => ({
              single: async () => ({
                data: {
                  status: 'in_progress',
                  started_at: new Date().toISOString(),
                  interview_round_id: null,
                },
                error: null,
              }),
            }),
          }),
        };
      }
      return {
        select: () => ({
          eq: () => ({ limit: async () => ({ data: [{ id: 'turn-1' }], error: null }) }),
        }),
      };
    });
    const complete = await request(a)
      .post(`/api/livekit/${SESSION}/complete`)
      .set('x-grant-token', GRANT)
      .send({});
    expect(complete.status).toBe(202);
    expect(complete.body.status).toBe('completed');
    expect(mocks.transition).toHaveBeenCalledWith(
      SESSION, 'in_progress', 'completed', 'conversation_complete', expect.any(Object),
    );

    // 3. New legacy entry stays closed in the same breath.
    const start = await request(a).post('/api/livekit/start').send({ candidate_id: CANDIDATE });
    expect(start.status).toBe(410);
  });

  it('does not gate the recording routes (their own answers, never 410)', async () => {
    retire();
    const a = app();
    const grant = await request(a).post('/api/livekit/grant/recording').send({});
    expect(grant.status).toBe(400);
    const completeNoGrant = await request(a).post(`/api/livekit/${SESSION}/complete`).send({});
    expect(completeNoGrant.status).toBe(403);
    expect(completeNoGrant.body).toEqual({ error: 'access_denied' });
    const upload = await request(a)
      .post(`/api/livekit/${SESSION}/recording`)
      .attach('file', Buffer.from('x'), 'recording.webm');
    expect(upload.status).toBe(401);
    expect(upload.body).toEqual({ error: 'authentication_required' });
  });

  it('worker-context is not gated while the worker bearer is still required', async () => {
    retire();
    const res = await request(app()).post('/api/livekit/worker-context').send({});
    expect(res.status).toBe(401);
    expect(res.body).toEqual({ ok: false, error: 'authentication_required' });
  });
});
