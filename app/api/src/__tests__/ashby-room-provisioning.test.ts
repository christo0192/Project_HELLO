/**
 * Lane B — JIT LiveKit room/egress provisioning for Ashby-materialized
 * sessions.
 *
 * Live canary blocker being closed: `materializeCandidate` creates exactly one
 * call_session in `created` with a NULL external_call_id. No route provisioned
 * a room for that EXISTING session, so `/api/livekit/exchange` — which only
 * accepts waiting/in_progress with a non-null external_call_id — rejected every
 * Ashby invite as unexchangeable.
 *
 * Proven here (each non-vacuous — the negative controls assert on the recorded
 * provider calls and on the candidate_invites UPDATE count):
 *   1. A valid exchange against a `created` session provisions EXACTLY ONE
 *      room and ONE authoritative egress, CASes created → waiting with
 *      external_call_id, and only then consumes the invite and mints the
 *      grant/JWT.
 *   2. Duplicate/concurrent exchange: the loser of the created → waiting CAS
 *      adopts the winner's identical room, never deletes it, and never starts a
 *      second egress. Exactly one request consumes the invite.
 *   3. Room create error → updateRoomMetadata fallback; both failing → 503,
 *      invite unconsumed, no grant/JWT.
 *   4. Egress failure → 503, invite unconsumed, and NO room deletion — an
 *      `existing_session` provider failure never deletes a room (B-1).
 *   5. created → waiting CAS lost to a terminal/foreign transition → stable 404,
 *      invite unconsumed, winner's room NOT deleted.
 *   6. Retry after a provider failure succeeds and still consumes exactly once.
 *   7. Non-Ashby existing `waiting` session: unchanged path, ZERO provider
 *      provisioning calls.
 *   8. Consent failure → no provider call at all and no consume.
 *   9. Terminal (failed/completed/cancelled/expired) session → stable 404, no
 *      provider call.
 *  10. Recording integrity: a session whose egress did not start never yields a
 *      grant token or a LiveKit JWT.
 *  11. B-1 regression (review blocker): a failing exchange interleaved with a
 *      SUCCEEDING concurrent exchange never deletes the winner's room and never
 *      detaches the winner's egress. The stateful harness deliberately serves a
 *      stale pre-winner snapshot to any ownership-probe read, so the old
 *      read-then-delete `reapUnownedRoom` would delete the winner's room here
 *      and fail the test.
 *
 * Offline, deterministic, synthetic fixtures only.
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';
import request from 'supertest';
import { createApp } from '../app.js';
import { MemoryRateLimitStore, setRateLimitStore } from '../lib/rate-limit.js';
import { setAuditSink } from '../lib/audit.js';

// ── Provider (LiveKit) mocks ─────────────────────────────────────────

const createRoom = vi.fn();
const updateRoomMetadata = vi.fn();
const deleteRoom = vi.fn();
const addGrant = vi.fn();
const toJwt = vi.fn();

vi.mock('livekit-server-sdk', () => {
  class FakeRoomServiceClient {
    createRoom = (...a: unknown[]) => createRoom(...a);
    updateRoomMetadata = (...a: unknown[]) => updateRoomMetadata(...a);
    deleteRoom = (...a: unknown[]) => deleteRoom(...a);
  }
  class FakeAccessToken {
    addGrant = (...a: unknown[]) => addGrant(...a);
    toJwt = (...a: unknown[]) => toJwt(...a);
  }
  return { RoomServiceClient: FakeRoomServiceClient, AccessToken: FakeAccessToken };
});

// The authoritative-egress module owns the enabled/required/browser-fallback
// policy; this suite injects its outcome so both the "started" and the
// "provider failed" branches are exercised without S3/env coupling.
const startAuthoritativeRecording = vi.fn();
vi.mock('../lib/recording-egress.js', () => ({
  startAuthoritativeRecording: (...a: unknown[]) => startAuthoritativeRecording(...a),
  finalizeAuthoritativeRecording: vi.fn().mockResolvedValue('pending'),
  authoritativeRecordingEnabled: () => true,
  egressObjectKey: (id: string) => `${id}-egress.ogg`,
  safeEgressStartedAtMs: () => null,
  validateEpochMsAnchor: () => null,
  MAX_EPOCH_MS_ANCHOR: 4_102_444_800_000,
}));

// ── Supabase mock ────────────────────────────────────────────────────

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
    'order', 'limit', 'range', 'single', 'maybeSingle',
  ];
  for (const m of methods) {
    c[m] = (...args: unknown[]) => {
      callLog.push({ table, method: m, args });
      return chain(value, table);
    };
  }
  c.then = (resolve: (v: unknown) => unknown) => Promise.resolve(value).then(resolve);
  c.catch = (reject: (e: unknown) => unknown) => Promise.resolve(value).catch(reject);
  return c;
}

function callsFor(table: string, method?: string): CallRecord[] {
  const recs = callLog.filter((r) => r.table === table);
  return method ? recs.filter((r) => r.method === method) : recs;
}

function configureTables(
  config: Record<string, unknown | ((callIndex: number) => unknown)>,
): void {
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

// ── Fixtures ─────────────────────────────────────────────────────────

const SESSION_ID = '00000000-0000-4000-8000-000000000001';
const CANDIDATE_ID = '00000000-0000-4000-8000-000000000002';
const INVITE_ID = '00000000-0000-4000-8000-000000000003';
const INVITE_TOKEN = 'a'.repeat(64);
const ROOM = `screening-${SESSION_ID}`;
const EGRESS_ID = 'EG_synthetic_0001';

const REQUIRED = ['ai_interview', 'recording', 'purpose', 'data_processing', 'retention', 'rights'];

const ACTIVE_INVITE = {
  id: INVITE_ID,
  candidate_id: CANDIDATE_ID,
  session_id: SESSION_ID,
  expires_at: '2999-01-01T00:00:00.000Z',
  consumed_at: null,
  revoked_at: null,
};

const GRANTED_CONSENT = ok({ status: 'granted', consents: REQUIRED, expires_at: null });
const ACTIVE_TEMPLATE = ok({ version: '1.0', required_consents: REQUIRED });

/**
 * Per-`from('call_sessions')` values, in call order. For a `created` session:
 *   [0] route step-2 session lookup (select)
 *   [1] EITHER the created → waiting CAS (update, on the success path)
 *       OR the reap probe (select, when provisioning aborted before the CAS)
 *   [2] the adopt re-read (select), only after a lost CAS
 * The egress module's own existing-egress probe is mocked out in this suite,
 * so it does not consume an index.
 */
function sessionsSequence(values: unknown[]) {
  return (n: number) => values[Math.min(n, values.length - 1)];
}

function exchangeApp(config: Record<string, unknown | ((n: number) => unknown)>) {
  configureTables({
    system_config: ok(null), // maintenance off
    consent_records: GRANTED_CONSENT,
    consent_templates: ACTIVE_TEMPLATE,
    candidate_access_grants: ok(null),
    ...config,
  });
  return createApp({ nodeEnv: 'test', webOrigin: 'http://localhost:5173' });
}

function exchange(app: ReturnType<typeof createApp>) {
  return request(app).post('/api/livekit/exchange').send({ token: INVITE_TOKEN });
}

/** Invite reads succeed; the consume CAS returns `consumed`. */
function invites(consumed: boolean) {
  return (n: number) => (n === 0 ? ok(ACTIVE_INVITE) : ok(consumed ? [{ id: INVITE_ID }] : []));
}

beforeEach(() => {
  vi.clearAllMocks();
  callLog.length = 0;
  setRateLimitStore(new MemoryRateLimitStore(10_000));
  setAuditSink(() => {});
  mockRpc.mockResolvedValue({ data: null, error: { message: 'unknown rpc' } });
  mockStorageFrom.mockReturnValue({
    createSignedUrl: vi.fn().mockResolvedValue({ data: { signedUrl: 'https://x/y' }, error: null }),
  });
  createRoom.mockResolvedValue({ name: ROOM });
  updateRoomMetadata.mockResolvedValue({});
  deleteRoom.mockResolvedValue({});
  addGrant.mockReturnValue(undefined);
  toJwt.mockResolvedValue('synthetic-livekit-jwt');
  startAuthoritativeRecording.mockResolvedValue({ status: 'started', egressId: EGRESS_ID });
});

// ════════════════════════════════════════════════════════════════════
//  1. Happy path — exactly one room, one egress, waiting, then consume
// ════════════════════════════════════════════════════════════════════

describe('JIT provisioning on a created (Ashby-materialized) session', () => {
  it('provisions exactly one room and one egress, moves to waiting, then consumes', async () => {
    const app = exchangeApp({
      candidate_invites: invites(true),
      call_sessions: sessionsSequence([
        ok({ id: SESSION_ID, external_call_id: null, status: 'created' }),
        ok([{ id: SESSION_ID }]), // created → waiting CAS wins
      ]),
    });

    const res = await exchange(app);

    expect(res.status).toBe(200);
    expect(res.body.room_name).toBe(ROOM);
    expect(res.body.session_id).toBe(SESSION_ID);
    expect(res.body.grant_token).toBeTruthy();
    expect(res.body.livekit_token).toBe('synthetic-livekit-jwt');

    // Exactly one room and one egress.
    expect(createRoom).toHaveBeenCalledTimes(1);
    expect(updateRoomMetadata).not.toHaveBeenCalled();
    expect(startAuthoritativeRecording).toHaveBeenCalledTimes(1);
    expect(startAuthoritativeRecording).toHaveBeenCalledWith(ROOM, SESSION_ID);
    expect(deleteRoom).not.toHaveBeenCalled();

    // Ordering: room → egress → created→waiting CAS → invite consume.
    // vi.fn invocationCallOrder is a single global counter, so these are
    // directly comparable across the provider and Supabase mocks.
    const consumeOrder = mockFrom.mock.calls
      .map((c, i) => ({ table: c[0], order: mockFrom.mock.invocationCallOrder[i] }))
      .filter((c) => c.table === 'candidate_invites')
      .map((c) => c.order);
    expect(createRoom.mock.invocationCallOrder[0])
      .toBeLessThan(startAuthoritativeRecording.mock.invocationCallOrder[0]);
    expect(startAuthoritativeRecording.mock.invocationCallOrder[0])
      .toBeLessThan(consumeOrder[consumeOrder.length - 1]);
    expect(toJwt.mock.invocationCallOrder[0])
      .toBeGreaterThan(consumeOrder[consumeOrder.length - 1]);

    // created → waiting CAS carried external_call_id.
    const casUpdate = callsFor('call_sessions', 'update')[0];
    expect(casUpdate?.args[0]).toMatchObject({
      status: 'waiting',
      external_call_id: ROOM,
    });

    // Invite consumed exactly once, AFTER provisioning.
    expect(callsFor('candidate_invites', 'update')).toHaveLength(1);
  });

  it('room metadata carries no candidate PII', async () => {
    const app = exchangeApp({
      candidate_invites: invites(true),
      call_sessions: sessionsSequence([
        ok({ id: SESSION_ID, external_call_id: null, status: 'created' }),
        ok([{ id: SESSION_ID }]),
      ]),
    });
    await exchange(app);

    const arg = createRoom.mock.calls[0][0] as { metadata: string };
    const parsed = JSON.parse(arg.metadata) as Record<string, unknown>;
    expect(Object.keys(parsed).sort()).toEqual(['correlation_id', 'room_name', 'session_id']);
    expect(arg.metadata).not.toContain(CANDIDATE_ID);
    expect(arg.metadata).not.toContain(INVITE_TOKEN);
  });

  it('the minted LiveKit grant is one room, join-only, no admin', async () => {
    const app = exchangeApp({
      candidate_invites: invites(true),
      call_sessions: sessionsSequence([
        ok({ id: SESSION_ID, external_call_id: null, status: 'created' }),
        ok([{ id: SESSION_ID }]),
      ]),
    });
    await exchange(app);

    expect(addGrant).toHaveBeenCalledTimes(1);
    const grant = addGrant.mock.calls[0][0] as Record<string, unknown>;
    expect(grant.room).toBe(ROOM);
    expect(grant.roomJoin).toBe(true);
    expect(grant.roomAdmin).toBeUndefined();
    expect(grant.roomCreate).toBeUndefined();
  });
});

// ════════════════════════════════════════════════════════════════════
//  2. Concurrency / idempotence
// ════════════════════════════════════════════════════════════════════

describe('concurrent exchange on the same created session', () => {
  it('the CAS loser adopts the winner\'s room: no second egress, no room delete', async () => {
    // Room already exists (winner created it) → createRoom throws, metadata
    // converges. The egress module short-circuits on the linked id. The
    // created → waiting CAS returns zero rows (winner already moved it), and
    // the adopt re-read shows the winner's identical room.
    createRoom.mockRejectedValueOnce(new Error('room already exists'));
    startAuthoritativeRecording.mockResolvedValue({ status: 'started', egressId: EGRESS_ID });

    const app = exchangeApp({
      candidate_invites: invites(true),
      call_sessions: sessionsSequence([
        ok({ id: SESSION_ID, external_call_id: null, status: 'created' }),
        ok([]), // CAS lost
        ok({ status: 'waiting', external_call_id: ROOM }), // adopt re-read
      ]),
    });

    const res = await exchange(app);

    expect(res.status).toBe(200);
    expect(res.body.room_name).toBe(ROOM);
    expect(updateRoomMetadata).toHaveBeenCalledTimes(1);
    expect(startAuthoritativeRecording).toHaveBeenCalledTimes(1);
    // The winner's room is never deleted by the loser.
    expect(deleteRoom).not.toHaveBeenCalled();
  });

  it('only one of two concurrent exchanges consumes the invite', async () => {
    // Second request loses the invite consume CAS (zero rows) → stable 404 and
    // no grant/JWT, even though it adopted the same room.
    const app = exchangeApp({
      candidate_invites: invites(false), // consume CAS returns zero rows
      call_sessions: sessionsSequence([
        ok({ id: SESSION_ID, external_call_id: null, status: 'created' }),
        ok([]),
        ok({ status: 'waiting', external_call_id: ROOM }),
      ]),
    });

    const res = await exchange(app);

    expect(res.status).toBe(404);
    expect(res.body.error).toBe('invite_token_invalid_or_expired');
    expect(res.body.grant_token).toBeUndefined();
    expect(res.body.livekit_token).toBeUndefined();
    expect(toJwt).not.toHaveBeenCalled();
    expect(deleteRoom).not.toHaveBeenCalled();
  });

  it('a lost CAS to a TERMINAL session is a stable 404 and never deletes the room', async () => {
    const app = exchangeApp({
      candidate_invites: invites(true),
      call_sessions: sessionsSequence([
        ok({ id: SESSION_ID, external_call_id: null, status: 'created' }),
        ok([]), // CAS lost
        ok({ status: 'failed', external_call_id: null }), // adopt re-read: not joinable
      ]),
    });

    const res = await exchange(app);

    expect(res.status).toBe(404);
    expect(res.body.error).toBe('invite_token_invalid_or_expired');
    expect(deleteRoom).not.toHaveBeenCalled();
    // Invite left unconsumed.
    expect(callsFor('candidate_invites', 'update')).toHaveLength(0);
  });
});

// ════════════════════════════════════════════════════════════════════
//  3. Provider failures — fail closed, invite stays reusable
// ════════════════════════════════════════════════════════════════════

describe('provider failures during JIT provisioning', () => {
  function failingApp(extra: Record<string, unknown | ((n: number) => unknown)> = {}) {
    return exchangeApp({
      candidate_invites: invites(true),
      // Provisioning aborts before the CAS, and `existing_session` mode makes
      // no further call_sessions read on the failure path.
      call_sessions: ok({ id: SESSION_ID, external_call_id: null, status: 'created' }),
      ...extra,
    });
  }

  it('createRoom AND updateRoomMetadata both failing → 503, invite unconsumed, no token', async () => {
    createRoom.mockRejectedValueOnce(new Error('livekit down'));
    updateRoomMetadata.mockRejectedValueOnce(new Error('livekit down'));

    const res = await exchange(failingApp());

    expect(res.status).toBe(503);
    expect(res.body.error).toBe('screening_room_unavailable');
    expect(callsFor('candidate_invites', 'update')).toHaveLength(0);
    expect(startAuthoritativeRecording).not.toHaveBeenCalled();
    expect(toJwt).not.toHaveBeenCalled();
  });

  it('authoritative egress failure → 503, invite unconsumed, and NO room deletion', async () => {
    startAuthoritativeRecording.mockRejectedValueOnce(new Error('egress storage unreachable'));

    const res = await exchange(failingApp());

    expect(res.status).toBe(503);
    expect(res.body.error).toBe('screening_room_unavailable');
    expect(callsFor('candidate_invites', 'update')).toHaveLength(0);
    expect(toJwt).not.toHaveBeenCalled();
    // B-1: "nobody owns this room" is not decidable from outside a
    // transaction, so this mode never deletes. The empty room expires on its
    // own and a retry converges on it.
    expect(deleteRoom).not.toHaveBeenCalled();
  });

  it('an egress that reports started WITHOUT an id is treated as a failure', async () => {
    startAuthoritativeRecording.mockResolvedValueOnce({ status: 'started' });

    const res = await exchange(failingApp());

    expect(res.status).toBe(503);
    expect(callsFor('candidate_invites', 'update')).toHaveLength(0);
    expect(toJwt).not.toHaveBeenCalled();
  });

  it.each([
    ['room create + metadata update both fail', () => {
      createRoom.mockRejectedValueOnce(new Error('down'));
      updateRoomMetadata.mockRejectedValueOnce(new Error('down'));
    }],
    ['egress start throws', () => {
      startAuthoritativeRecording.mockRejectedValueOnce(new Error('transient'));
    }],
    ['egress reports started without an id', () => {
      startAuthoritativeRecording.mockResolvedValueOnce({ status: 'started' });
    }],
  ])('existing_session never deletes a room — %s', async (_label, arrange) => {
    arrange();

    const res = await exchange(failingApp());

    expect(res.status).toBe(503);
    expect(deleteRoom).not.toHaveBeenCalled();
  });

  it('the session is NOT terminated by a provider failure — a retry succeeds', async () => {
    startAuthoritativeRecording.mockRejectedValueOnce(new Error('transient'));
    const app = failingApp();

    const first = await exchange(app);
    expect(first.status).toBe(503);
    // No terminal transition was attempted on the candidate's session.
    const updates = callsFor('call_sessions', 'update');
    expect(updates.some((u) => (u.args[0] as { status?: string })?.status === 'failed')).toBe(false);

    // Retry on a fresh app with the same still-`created` row.
    callLog.length = 0;
    vi.clearAllMocks();
    createRoom.mockResolvedValue({ name: ROOM });
    toJwt.mockResolvedValue('synthetic-livekit-jwt');
    startAuthoritativeRecording.mockResolvedValue({ status: 'started', egressId: EGRESS_ID });

    const retryApp = exchangeApp({
      candidate_invites: invites(true),
      call_sessions: sessionsSequence([
        ok({ id: SESSION_ID, external_call_id: null, status: 'created' }),
        ok([{ id: SESSION_ID }]),
      ]),
    });
    const second = await exchange(retryApp);
    expect(second.status).toBe(200);
    expect(callsFor('candidate_invites', 'update')).toHaveLength(1);
  });
});

// ════════════════════════════════════════════════════════════════════
//  4. Negative controls — no provisioning where none is due
// ════════════════════════════════════════════════════════════════════

describe('paths that must never provision', () => {
  it('an existing waiting session (recruiter /start path) makes ZERO provider calls', async () => {
    const app = exchangeApp({
      candidate_invites: invites(true),
      call_sessions: ok({ id: SESSION_ID, external_call_id: ROOM, status: 'waiting' }),
    });

    const res = await exchange(app);

    expect(res.status).toBe(200);
    expect(res.body.room_name).toBe(ROOM);
    expect(createRoom).not.toHaveBeenCalled();
    expect(updateRoomMetadata).not.toHaveBeenCalled();
    expect(startAuthoritativeRecording).not.toHaveBeenCalled();
    expect(deleteRoom).not.toHaveBeenCalled();
    expect(callsFor('call_sessions', 'update')).toHaveLength(0);
  });

  it('a failed consent gate makes ZERO provider calls and never consumes', async () => {
    const app = exchangeApp({
      candidate_invites: invites(true),
      consent_records: ok({ status: 'declined', consents: [], expires_at: null }),
      call_sessions: ok({ id: SESSION_ID, external_call_id: null, status: 'created' }),
    });

    const res = await exchange(app);

    expect(res.status).toBe(409);
    expect(res.body.error).toBe('consent_required');
    expect(createRoom).not.toHaveBeenCalled();
    expect(startAuthoritativeRecording).not.toHaveBeenCalled();
    expect(callsFor('candidate_invites', 'update')).toHaveLength(0);
  });

  it('maintenance mode blocks BEFORE any provider call', async () => {
    const app = exchangeApp({
      candidate_invites: invites(true),
      system_config: ok({ value: { enabled: true, reason: 'window' }, updated_at: '2026-01-01T00:00:00.000Z' }),
      call_sessions: ok({ id: SESSION_ID, external_call_id: null, status: 'created' }),
    });

    const res = await exchange(app);

    expect(res.status).toBe(503);
    expect(res.body.error.type).toBe('maintenance_mode');
    expect(createRoom).not.toHaveBeenCalled();
    expect(callsFor('candidate_invites', 'update')).toHaveLength(0);
  });

  it.each(['failed', 'completed', 'cancelled', 'expired'])(
    'a %s session is rejected with a stable 404 and no provider call',
    async (status) => {
      const app = exchangeApp({
        candidate_invites: invites(true),
        call_sessions: ok({ id: SESSION_ID, external_call_id: null, status }),
      });

      const res = await exchange(app);

      expect(res.status).toBe(404);
      expect(res.body.error).toBe('invite_token_invalid_or_expired');
      expect(createRoom).not.toHaveBeenCalled();
      expect(startAuthoritativeRecording).not.toHaveBeenCalled();
      expect(callsFor('candidate_invites', 'update')).toHaveLength(0);
    },
  );

  it('an expired invite never reaches provisioning', async () => {
    const app = exchangeApp({
      candidate_invites: ok({ ...ACTIVE_INVITE, expires_at: '2000-01-01T00:00:00.000Z' }),
      call_sessions: ok({ id: SESSION_ID, external_call_id: null, status: 'created' }),
    });

    const res = await exchange(app);

    expect(res.status).toBe(404);
    expect(createRoom).not.toHaveBeenCalled();
  });
});

// ════════════════════════════════════════════════════════════════════
//  4b. B-1 regression — a failing exchange must not damage a winner
// ════════════════════════════════════════════════════════════════════

function deferred<T = void>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((r) => {
    resolve = r;
  });
  return { promise, resolve };
}

/**
 * Stateful `call_sessions` + `candidate_invites` doubles.
 *
 * Unlike the scripted per-call sequences above, BOTH concurrent requests read
 * and write the SAME mutable rows, so an interleaving that happens between two
 * awaits is expressible — which is exactly what the scripted model could not
 * do, and exactly where B-1 lived.
 *
 * `onOwnershipProbe` fires when something issues the read-then-delete
 * ownership probe that `reapUnownedRoom` used to perform (a `call_sessions`
 * select whose column list includes `recording_egress_id`). The harness serves
 * that probe a STALE pre-winner snapshot and only then lets the winner publish
 * — reproducing the exact straddle in which the old code deleted a live room.
 */
function statefulTables(
  sessionRow: Record<string, unknown>,
  inviteRow: Record<string, unknown>,
  hooks: { onOwnershipProbe?: () => Record<string, unknown> } = {},
) {
  mockFrom.mockImplementation((table: string) => {
    callLog.push({ table, method: 'from', args: [table] });

    if (table === 'call_sessions') {
      return {
        select: (cols: string) => {
          callLog.push({ table, method: 'select', args: [cols] });
          const isOwnershipProbe = typeof cols === 'string' && cols.includes('recording_egress_id');
          const snapshot = isOwnershipProbe && hooks.onOwnershipProbe
            ? hooks.onOwnershipProbe()
            : { ...sessionRow };
          const q: Record<string, unknown> = {
            eq: () => q,
            single: async () => ({ data: snapshot, error: null }),
          };
          return q;
        },
        update: (updates: Record<string, unknown>) => {
          const conds: Record<string, unknown> = {};
          const q: Record<string, unknown> = {
            eq: (col: string, val: unknown) => {
              conds[col] = val;
              return q;
            },
            select: async () => {
              callLog.push({ table, method: 'update', args: [updates] });
              // Compare-and-set on `status` when the caller supplied one.
              if (conds.status !== undefined && sessionRow.status !== conds.status) {
                return { data: [], error: null };
              }
              Object.assign(sessionRow, updates);
              return { data: [{ id: sessionRow.id }], error: null };
            },
          };
          return q;
        },
      };
    }

    if (table === 'candidate_invites') {
      return {
        select: () => {
          const q: Record<string, unknown> = {
            eq: () => q,
            single: async () => ({ data: { ...inviteRow }, error: null }),
          };
          return q;
        },
        update: (updates: Record<string, unknown>) => {
          const q: Record<string, unknown> = {
            eq: () => q,
            is: () => q,
            gt: () => q,
            select: async () => {
              callLog.push({ table, method: 'update', args: [updates] });
              // One-time consume: only the first caller sees a row back.
              if (inviteRow.consumed_at !== null) return { data: [], error: null };
              Object.assign(inviteRow, updates);
              return { data: [{ id: inviteRow.id }], error: null };
            },
          };
          return q;
        },
      };
    }

    const fixed: Record<string, unknown> = {
      system_config: ok(null),
      consent_records: GRANTED_CONSENT,
      consent_templates: ACTIVE_TEMPLATE,
      candidate_access_grants: ok(null),
    };
    return chain(fixed[table] ?? { data: null, error: null }, table);
  });
}

describe('B-1 regression: a failing exchange interleaved with a winning one', () => {
  it('never deletes the winner\'s room and never detaches the winner\'s egress', async () => {
    const sessionRow: Record<string, unknown> = {
      id: SESSION_ID,
      status: 'created',
      external_call_id: null,
      recording_egress_id: null,
    };
    const inviteRow: Record<string, unknown> = { ...ACTIVE_INVITE };

    // The pre-winner snapshot every ownership probe is served. If the
    // implementation still probes-then-deletes, it sees "created, no egress",
    // concludes the room is unowned, and deletes it AFTER B published.
    const staleSnapshot = { status: 'created', recording_egress_id: null };
    const bPublished = deferred();

    statefulTables(sessionRow, inviteRow, {
      onOwnershipProbe: () => {
        // Let the winner publish in the gap between the probe and the delete.
        bPublished.resolve();
        return staleSnapshot;
      },
    });
    const app = createApp({ nodeEnv: 'test', webOrigin: 'http://localhost:5173' });

    const liveRooms = new Set<string>();
    createRoom.mockImplementation(async (opts: { name: string }) => {
      if (liveRooms.has(opts.name)) throw new Error('room already exists');
      liveRooms.add(opts.name);
      return { name: opts.name };
    });
    updateRoomMetadata.mockResolvedValue({});
    deleteRoom.mockImplementation(async (name: string) => {
      liveRooms.delete(name);
      return {};
    });

    const aInsideProvisioning = deferred();
    const aMayFail = deferred();
    let egressCall = 0;

    startAuthoritativeRecording.mockImplementation(async () => {
      const n = egressCall++;
      if (n === 0) {
        // Request A: hold inside provisioning until B has fully published,
        // then fail. This puts A's failure handling strictly AFTER B's win.
        aInsideProvisioning.resolve();
        await aMayFail.promise;
        throw new Error('egress storage unreachable');
      }
      // Request B: links its egress and wins.
      sessionRow.recording_egress_id = EGRESS_ID;
      return { status: 'started', egressId: EGRESS_ID };
    });

    // `.then()` is what actually dispatches a supertest request — calling
    // `exchange(app)` alone builds it without sending.
    const aPromise = exchange(app).then((r) => r);
    await aInsideProvisioning.promise;

    // B runs to completion while A is still mid-provisioning.
    const bRes = await exchange(app);
    aMayFail.resolve();
    const aRes = await aPromise;
    // If an ownership probe ever ran, this is already resolved; otherwise the
    // race never existed. Either way the test does not hang.
    bPublished.resolve();

    // The winner joined.
    expect(bRes.status).toBe(200);
    expect(bRes.body.room_name).toBe(ROOM);
    expect(bRes.body.grant_token).toBeTruthy();
    expect(bRes.body.livekit_token).toBe('synthetic-livekit-jwt');

    // The loser failed closed, retryably.
    expect(aRes.status).toBe(503);
    expect(aRes.body.error).toBe('screening_room_unavailable');
    expect(aRes.body.grant_token).toBeUndefined();
    expect(aRes.body.livekit_token).toBeUndefined();

    // ── The blocker itself ──────────────────────────────────────────────
    // No room deletion at all, so the winner's room still exists...
    expect(deleteRoom).not.toHaveBeenCalled();
    expect(liveRooms.has(ROOM)).toBe(true);
    // ...its authoritative egress is still attached...
    expect(sessionRow.recording_egress_id).toBe(EGRESS_ID);
    // ...and the row the winner published is intact.
    expect(sessionRow.status).toBe('waiting');
    expect(sessionRow.external_call_id).toBe(ROOM);

    // Exactly one egress and exactly one consume across both requests.
    expect(egressCall).toBe(2); // both attempted; only B's succeeded
    expect(callsFor('candidate_invites', 'update')).toHaveLength(1);
    expect(inviteRow.consumed_at).not.toBeNull();
  });

  it('the harness is non-vacuous: an ownership probe would straddle the winner', async () => {
    // Guards the guard. If a future change reintroduces a read-then-delete
    // ownership probe on this path, `onOwnershipProbe` fires and this asserts
    // the straddle is real — i.e. the probe would have seen a stale snapshot
    // while the winner was already published.
    const sessionRow: Record<string, unknown> = {
      id: SESSION_ID,
      status: 'created',
      external_call_id: null,
      recording_egress_id: null,
    };
    const inviteRow: Record<string, unknown> = { ...ACTIVE_INVITE };
    let probes = 0;

    statefulTables(sessionRow, inviteRow, {
      onOwnershipProbe: () => {
        probes += 1;
        return { status: 'created', recording_egress_id: null };
      },
    });
    const app = createApp({ nodeEnv: 'test', webOrigin: 'http://localhost:5173' });
    startAuthoritativeRecording.mockRejectedValueOnce(new Error('transient'));

    const res = await exchange(app);

    expect(res.status).toBe(503);
    // The current implementation performs NO ownership probe — that is the
    // fix. Deleting this assertion is how you would notice the regression.
    expect(probes).toBe(0);
    expect(deleteRoom).not.toHaveBeenCalled();
  });
});

// ════════════════════════════════════════════════════════════════════
//  5. Unit-level provisioner contract
// ════════════════════════════════════════════════════════════════════

describe('provisionRoomForCreatedSession (shared module)', () => {
  const roomsStub = () => ({
    createRoom: vi.fn().mockResolvedValue({}),
    updateRoomMetadata: vi.fn().mockResolvedValue({}),
    deleteRoom: vi.fn().mockResolvedValue({}),
  });

  it('derives a deterministic room name from the session id alone', async () => {
    const { roomNameForSession } = await import('../lib/room-provisioning.js');
    expect(roomNameForSession(SESSION_ID)).toBe(ROOM);
    expect(roomNameForSession(SESSION_ID)).toBe(roomNameForSession(SESSION_ID));
  });

  it('new_session mode terminates the row on a provider failure', async () => {
    const { provisionRoomForCreatedSession } = await import('../lib/room-provisioning.js');
    configureTables({
      call_sessions: (n: number) => (n === 0 ? ok([{ id: SESSION_ID }]) : ok([{ id: SESSION_ID }])),
    });
    const rooms = roomsStub();
    rooms.createRoom.mockRejectedValue(new Error('down'));
    rooms.updateRoomMetadata.mockRejectedValue(new Error('down'));

    const result = await provisionRoomForCreatedSession(SESSION_ID, 'new_session', {
      rooms,
      startRecording: startAuthoritativeRecording as never,
    });

    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.code).toBe('provider_failed');
      expect(result.code === 'provider_failed' && result.terminated).toBe(true);
    }
    expect(rooms.deleteRoom).toHaveBeenCalledWith(ROOM);
    const term = callsFor('call_sessions', 'update')[0];
    expect(term?.args[0]).toMatchObject({ status: 'failed', terminal_reason: 'room_create_error' });
  });

  it('existing_session mode never terminates the row on a provider failure', async () => {
    const { provisionRoomForCreatedSession } = await import('../lib/room-provisioning.js');
    configureTables({
      call_sessions: ok({ status: 'created', recording_egress_id: null }),
    });
    const rooms = roomsStub();
    rooms.createRoom.mockRejectedValue(new Error('down'));
    rooms.updateRoomMetadata.mockRejectedValue(new Error('down'));

    const result = await provisionRoomForCreatedSession(SESSION_ID, 'existing_session', {
      rooms,
      startRecording: startAuthoritativeRecording as never,
    });

    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.code).toBe('provider_failed');
    expect(callsFor('call_sessions', 'update')).toHaveLength(0);
  });

  it('new_session mode reaps the orphan room on a lost CAS', async () => {
    const { provisionRoomForCreatedSession } = await import('../lib/room-provisioning.js');
    configureTables({ call_sessions: ok([]) }); // CAS returns zero rows
    const rooms = roomsStub();

    const result = await provisionRoomForCreatedSession(SESSION_ID, 'new_session', {
      rooms,
      startRecording: startAuthoritativeRecording as never,
    });

    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.code).toBe('transition_conflict');
    expect(rooms.deleteRoom).toHaveBeenCalledWith(ROOM);
  });
});
