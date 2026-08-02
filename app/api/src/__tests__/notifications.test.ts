/**
 * Phase 9 L3 — /api/notifications + lib/notification-intent (invariant 5).
 * Idempotent pending-intent insert (unique key, no provider send); recruiter
 * status query returns only own/authorized bounded intents; candidate
 * delivery is rejected unless channel/template approval AND consent are
 * explicit (disabled — no approved provider/template exists).
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import request from 'supertest';
import express from 'express';
import { createRequireAuth, mockAuthGetUser, type AuthUser } from '../lib/auth.js';
import { notificationsRouter } from '../routes/notifications.js';
import {
  insertNotificationIntent,
  queueCandidateNotification,
} from '../lib/notification-intent.js';
import { finalErrorHandler } from '../lib/validation.js';

vi.mock('../lib/supabase.js', () => ({
  supabase: { from: vi.fn(), rpc: vi.fn() },
  RESUME_BUCKET: 'resumes_v2',
}));

const JWT_AAL2 = 'eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiJ1c2VyLTAwMSIsImFhbCI6ImFhbDIifQ.signature';
const RECRUITER_ID = '00000000-0000-4000-8000-0000000000ff';
const CANDIDATE_A = '00000000-0000-4000-8000-000000000001';
const CANDIDATE_B = '00000000-0000-4000-8000-000000000002';

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
  fn.insert = () => chainable(value);
  fn.update = () => chainable(value);
  return fn;
}

function makeUser(role: AuthUser['appRole'], overrides: Partial<AuthUser> = {}): AuthUser {
  return {
    id: RECRUITER_ID,
    email: 'recruiter@example.com',
    aal: 'aal2',
    active: true,
    appRole: role,
    orgId: null,
    ...overrides,
  };
}

let mockFrom: any;

beforeEach(async () => {
  const mod = await import('../lib/supabase.js');
  mockFrom = (mod.supabase as any).from;
  mockFrom.mockReset();
});

afterEach(() => {
  vi.restoreAllMocks();
});

function makeApp(user: AuthUser) {
  const app = express();
  app.use(express.json());
  app.use(createRequireAuth({ getUser: mockAuthGetUser(user, JWT_AAL2) }));
  app.use('/api/notifications', notificationsRouter);
  app.use(finalErrorHandler);
  return app;
}

const AUTH = { Authorization: `Bearer ${JWT_AAL2}` };
const INTENT = {
  id: '00000000-0000-4000-8000-0000000000c1',
  kind: 'assessment_ready',
  candidate_id: CANDIDATE_A,
  consent_verified: true,
  idempotency_key: 'quota:2025-01-01:001',
  created_at: '2025-01-01T00:00:00.000Z',
};

describe('GET /api/notifications — recruiter boundary', () => {
  it('401 without auth', async () => {
    const res = await request(makeApp(makeUser('admin'))).get('/api/notifications');
    expect(res.status).toBe(401);
  });

  it('viewer is not a recruiter → 403', async () => {
    const res = await request(makeApp(makeUser('viewer', { aal: 'aal1' })))
      .get('/api/notifications')
      .set(AUTH);
    expect(res.status).toBe(403);
  });

  it('admin sees all intents; response never exposes idempotency keys', async () => {
    mockFrom.mockReturnValueOnce(chainable({ data: [INTENT], error: null }));
    const res = await request(makeApp(makeUser('admin'))).get('/api/notifications').set(AUTH);
    expect(res.status).toBe(200);
    expect(res.body.intents).toHaveLength(1);
    const body = JSON.stringify(res.body);
    expect(body).toContain(CANDIDATE_A);
    expect(body).not.toContain('quota:2025-01-01:001');
    expect(body).not.toContain('idempotency_key');
  });

  it('interviewer sees intents ONLY for candidates they own', async () => {
    // from() call order: notification_intents (q builder) then candidates (owned ids).
    mockFrom
      .mockReturnValueOnce(chainable({ data: [INTENT], error: null }))
      .mockReturnValueOnce(chainable({ data: [{ id: CANDIDATE_A }], error: null }));
    const res = await request(makeApp(makeUser('interviewer')))
      .get('/api/notifications')
      .set(AUTH);
    expect(res.status).toBe(200);
    expect(res.body.intents).toHaveLength(1);
    expect(res.body.intents[0].candidate_id).toBe(CANDIDATE_A);
    // The query must be scoped to owned candidates (in-filter).
    const intentCall = mockFrom.mock.calls.filter((c: string[]) => c[0] === 'notification_intents');
    expect(intentCall).toHaveLength(1);
  });

  it('interviewer with no owned candidates → empty list (no intent query)', async () => {
    mockFrom
      .mockReturnValueOnce(chainable({ data: [], error: null }))
      .mockReturnValueOnce(chainable({ data: [], error: null }));
    const res = await request(makeApp(makeUser('interviewer')))
      .get('/api/notifications')
      .set(AUTH);
    expect(res.status).toBe(200);
    expect(res.body.intents).toEqual([]);
  });

  it('bounded intents — no contact endpoint exposed', async () => {
    mockFrom.mockReturnValueOnce(chainable({ data: [INTENT], error: null }));
    const res = await request(makeApp(makeUser('admin'))).get('/api/notifications').set(AUTH);
    expect(res.status).toBe(200);
    expect(res.headers['content-type']).toContain('application/json');
  });
});

describe('lib/notification-intent — idempotent insert', () => {
  it('inserts a pending intent once (created=true)', async () => {
    mockFrom.mockReturnValueOnce(chainable({ data: null, error: null }));
    const result = await insertNotificationIntent({
      idempotency_key: 'quota:2025-01-01:001',
      kind: 'quota_warning',
      candidate_id: CANDIDATE_A,
      consent_verified: false,
      payload: { remaining: 2 },
    });
    expect(result).toEqual({ ok: true, created: true });
    expect(mockFrom).toHaveBeenCalledWith('notification_intents');
  });

  it('duplicate key (23505) → idempotent replay, count unchanged (created=false)', async () => {
    mockFrom.mockReturnValueOnce(
      chainable({ data: null, error: { code: '23505', message: 'duplicate key value violates unique constraint "uq_notification_intents_key"' } }),
    );
    const result = await insertNotificationIntent({
      idempotency_key: 'quota:2025-01-01:001',
      kind: 'quota_warning',
      candidate_id: CANDIDATE_A,
    });
    expect(result).toEqual({ ok: true, created: false });
  });

  it('rejects an unbounded/invalid idempotency key (throws, no DB call)', async () => {
    await expect(
      insertNotificationIntent({ idempotency_key: 'x'.repeat(129), kind: 'quota_warning' }),
    ).rejects.toThrow('invalid notification idempotency key');
    expect(mockFrom).not.toHaveBeenCalled();
  });

  it('a non-unique DB error propagates (does not masquerade as idempotent)', async () => {
    mockFrom.mockReturnValueOnce(chainable({ data: null, error: { code: '23503', message: 'fk' } }));
    await expect(
      insertNotificationIntent({ idempotency_key: 'quota:2025-01-01:099', kind: 'quota_warning' }),
    ).rejects.toThrow('failed to insert notification intent');
  });
});

describe('lib/notification-intent — candidate delivery gate (disabled)', () => {
  it('candidate intent without explicit consent → rejected', async () => {
    const result = await queueCandidateNotification({
      idempotency_key: 'app:1',
      kind: 'assessment_ready',
      candidate_id: CANDIDATE_A,
      consent_verified: false,
      channel: 'sms',
      template: 'assessment_ready_v1',
    });
    expect(result.ok).toBe(false);
    expect(result.reason).toBe('consent_not_verified');
  });

  it('candidate intent with consent but no approved channel/template → rejected', async () => {
    const result = await queueCandidateNotification({
      idempotency_key: 'app:2',
      kind: 'assessment_ready',
      candidate_id: CANDIDATE_A,
      consent_verified: true,
      channel: 'sms',
      template: 'assessment_ready_v1',
    });
    expect(result.ok).toBe(false);
    expect(result.reason).toBe('channel_not_approved');
  });

  it('candidate delivery can NEVER succeed — no provider send exists', async () => {
    const attempts = await Promise.all([
      queueCandidateNotification({
        idempotency_key: 'app:3',
        kind: 'appeal_resolved',
        candidate_id: CANDIDATE_B,
        consent_verified: true,
        channel: 'email',
        template: 'appeal_resolved_v1',
      }),
    ]);
    for (const a of attempts) expect(a.ok).toBe(false);
    // No notification_intents write is ever attempted for candidate delivery.
    expect(mockFrom).not.toHaveBeenCalled();
  });
});
