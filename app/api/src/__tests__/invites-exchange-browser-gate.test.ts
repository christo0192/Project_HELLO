/**
 * PR B (browser, §2.3b B-i) — the READY-BEFORE-DISPATCH gate in POST
 * /api/livekit/exchange.
 *
 * Proves, via the mounted invitesRouter with an injected browser gate:
 *   - OFF (gate null): the exchange mints the join token exactly as today — no
 *     ensureReadyWorker, no dispatch. Byte-identical.
 *   - ON + ready → dispatch → token: ensureReadyWorker runs FIRST, then
 *     createDispatch, then the token is returned (200).
 *   - ON + NOT ready (timeout/no_capacity/error): 202 {status:'preparing'} and
 *     NO token, and the one-time invite is NOT consumed (retry stays valid).
 *   - ON + ready but dispatch FAILS: 202 preparing, worker released, no token.
 *
 * The gate is injected via `__setBrowserGateResolverForTest`, so this test needs
 * no Fly/LiveKit; the session is pre-provisioned (`waiting`) so the room path is
 * a no-op and the test focuses on the gate ordering.
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import express from 'express';
import request from 'supertest';

// ── Collaborator mocks ────────────────────────────────────────────────
const consumeUpdate = vi.fn();
const mockFrom = vi.fn();

vi.mock('../lib/supabase.js', () => ({
  supabase: { from: (...a: unknown[]) => mockFrom(...a) },
}));
vi.mock('../lib/env.js', () => ({
  env: { livekitUrl: 'wss://lk.example', livekitApiKey: 'k', livekitApiSecret: 's' },
}));
vi.mock('../lib/correlation.js', () => ({ getCorrelationId: () => null }));
vi.mock('../lib/invite-validation.js', () => ({
  validateInvite: vi.fn(),
  STABLE_INVITE_ERROR: 'invite_token_invalid_or_expired',
}));
vi.mock('../lib/maintenance.js', () => ({
  readMaintenanceState: vi.fn().mockResolvedValue({ ok: true, enabled: false }),
  maintenanceBlockedBody: () => ({ error: 'maintenance' }),
}));
vi.mock('../lib/candidate-access.js', () => ({
  createGrant: vi.fn().mockResolvedValue({
    grantToken: 'a'.repeat(64),
    expiresAt: new Date('2030-01-01T00:00:00Z'),
  }),
}));
vi.mock('../lib/room-provisioning.js', () => ({
  provisionRoomForCreatedSession: vi.fn(),
  requireLiveKitConfigured: vi.fn(),
}));
vi.mock('livekit-server-sdk', () => {
  const AccessToken = vi.fn() as unknown as { prototype: Record<string, unknown> };
  (AccessToken as any).prototype.addGrant = vi.fn();
  (AccessToken as any).prototype.toJwt = vi.fn().mockResolvedValue('jwt-token');
  return { AccessToken, RoomServiceClient: vi.fn(), TrackSource: { MICROPHONE: 1 } };
});
vi.mock('../lib/validation.js', () => ({
  validateBody: () => (_req: unknown, _res: unknown, next: () => void) => next(),
}));

const SESSION = '00000000-0000-4000-8000-000000000001';
const CANDIDATE = '00000000-0000-4000-8000-000000000002';
const ROOM = `screening-${SESSION}`;
const TOKEN = 'b'.repeat(64);

let setGate: (r: () => unknown) => void;
let invitesRouter: express.Router;
let validateInvite: ReturnType<typeof vi.fn>;

beforeEach(async () => {
  vi.clearAllMocks();
  const inv = await import('../lib/invite-validation.js');
  validateInvite = inv.validateInvite as ReturnType<typeof vi.fn>;
  validateInvite.mockResolvedValue({ ok: true, invite: { candidate_id: CANDIDATE } });

  // Supabase: invite row → active; consent gate reads → granted; session →
  // already provisioned (waiting, external_call_id set); consume CAS → success.
  consumeUpdate.mockReturnValue({
    eq: () => ({ is: () => ({ is: () => ({ gt: () => ({ select: () => Promise.resolve({ data: [{ id: 'iv1' }], error: null }) }) }) }) }),
  });
  mockFrom.mockImplementation((table: string) => {
    if (table === 'candidate_invites') {
      return {
        select: () => ({
          eq: () => ({
            single: () => Promise.resolve({
              data: {
                id: 'iv1', candidate_id: CANDIDATE, session_id: SESSION,
                expires_at: new Date(Date.now() + 3600_000).toISOString(),
                consumed_at: null, revoked_at: null,
              },
              error: null,
            }),
          }),
        }),
        update: (...a: unknown[]) => consumeUpdate(...a),
      };
    }
    if (table === 'consent_records') {
      return { select: () => ({ eq: () => ({ order: () => ({ limit: () => ({ maybeSingle: () => Promise.resolve({ data: { status: 'granted', consents: ['recording'], expires_at: null }, error: null }) }) }) }) }) };
    }
    if (table === 'consent_templates') {
      return { select: () => ({ eq: () => ({ order: () => ({ limit: () => ({ maybeSingle: () => Promise.resolve({ data: { required_consents: ['recording'] }, error: null }) }) }) }) }) };
    }
    if (table === 'call_sessions') {
      return { select: () => ({ eq: () => ({ single: () => Promise.resolve({ data: { id: SESSION, external_call_id: ROOM, status: 'waiting' }, error: null }) }) }) };
    }
    return { select: () => ({ eq: () => ({ single: () => Promise.resolve({ data: null, error: null }) }) }) };
  });

  const mod = await import('../routes/invites.js');
  invitesRouter = mod.invitesRouter;
  setGate = mod.__setBrowserGateResolverForTest as unknown as (r: () => unknown) => void;
});

afterEach(() => {
  // Reset the resolver to the real (env-gated) default so tests don't leak.
  setGate(() => null);
});

function appWithGate(gate: unknown) {
  setGate(() => gate);
  const app = express();
  app.use('/api/livekit', express.json(), invitesRouter);
  return app;
}

function exchange(app: express.Express) {
  return request(app).post('/api/livekit/exchange').send({ token: TOKEN });
}

describe('exchange browser gate — OFF is byte-identical', () => {
  it('mints the join token with no gate consulted', async () => {
    const res = await exchange(appWithGate(null));
    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({ session_id: SESSION, room_name: ROOM, livekit_token: 'jwt-token' });
    // Invite WAS consumed on the happy path.
    expect(consumeUpdate).toHaveBeenCalledTimes(1);
  });
});

describe('exchange browser gate — ON', () => {
  it('ready → dispatch → token, in that order', async () => {
    const calls: string[] = [];
    const gate = {
      app: 'project-hello-voice', agentName: 'browser-screener',
      ensureReadyWorker: vi.fn(async () => { calls.push('ready'); return { status: 'ready', machineId: 'm1' }; }),
      dispatch: vi.fn(async () => { calls.push('dispatch'); return true; }),
      releaseWorker: vi.fn(async () => undefined),
    };
    const res = await exchange(appWithGate(gate));
    expect(res.status).toBe(200);
    expect(res.body.livekit_token).toBe('jwt-token');
    expect(gate.ensureReadyWorker).toHaveBeenCalledWith({ sessionId: SESSION });
    expect(gate.dispatch).toHaveBeenCalledWith({ sessionId: SESSION, roomName: ROOM });
    expect(calls).toEqual(['ready', 'dispatch']); // ready BEFORE dispatch
    expect(consumeUpdate).toHaveBeenCalledTimes(1);
  });

  it('not ready (timeout) → 202 preparing, NO token, invite NOT consumed', async () => {
    const gate = {
      app: 'project-hello-voice', agentName: 'browser-screener',
      ensureReadyWorker: vi.fn(async () => ({ status: 'timeout' })),
      dispatch: vi.fn(),
      releaseWorker: vi.fn(),
    };
    const res = await exchange(appWithGate(gate));
    expect(res.status).toBe(202);
    expect(res.body).toEqual({ status: 'preparing' });
    expect(res.body.livekit_token).toBeUndefined();
    expect(gate.dispatch).not.toHaveBeenCalled();
    // Invite stays reusable — never consumed on a preparing defer.
    expect(consumeUpdate).not.toHaveBeenCalled();
  });

  it('no_capacity → 202 preparing, no dispatch, invite unconsumed', async () => {
    const gate = {
      app: 'project-hello-voice', agentName: 'browser-screener',
      ensureReadyWorker: vi.fn(async () => ({ status: 'no_capacity' })),
      dispatch: vi.fn(), releaseWorker: vi.fn(),
    };
    const res = await exchange(appWithGate(gate));
    expect(res.status).toBe(202);
    expect(res.body).toEqual({ status: 'preparing' });
    expect(consumeUpdate).not.toHaveBeenCalled();
  });

  it('ready but dispatch FAILS → 202 preparing, worker released, no token, unconsumed', async () => {
    const gate = {
      app: 'project-hello-voice', agentName: 'browser-screener',
      ensureReadyWorker: vi.fn(async () => ({ status: 'ready', machineId: 'm1' })),
      dispatch: vi.fn(async () => false),
      releaseWorker: vi.fn(async () => undefined),
    };
    const res = await exchange(appWithGate(gate));
    expect(res.status).toBe(202);
    expect(res.body).toEqual({ status: 'preparing' });
    expect(gate.releaseWorker).toHaveBeenCalledWith({ machineId: 'm1', sessionId: SESSION });
    expect(consumeUpdate).not.toHaveBeenCalled();
  });

  it('disabled verdict falls through to the token path (service flag off)', async () => {
    const gate = {
      app: 'project-hello-voice', agentName: 'browser-screener',
      ensureReadyWorker: vi.fn(async () => ({ status: 'disabled' })),
      dispatch: vi.fn(), releaseWorker: vi.fn(),
    };
    const res = await exchange(appWithGate(gate));
    expect(res.status).toBe(200);
    expect(res.body.livekit_token).toBe('jwt-token');
    expect(gate.dispatch).not.toHaveBeenCalled();
    expect(consumeUpdate).toHaveBeenCalledTimes(1);
  });
});
