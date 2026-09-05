/**
 * POST /api/candidates/:id/phone-test-gate — the 0081 owner-test path for an
 * EXISTING engagement.
 *
 * The bug this covers: the route minted a FRESH rescreen cycle before arming
 * the gate, so a candidate who already had a live `scheduled` cycle (a due
 * appointment) was refused with `active_cycle` and never reached the gate. The
 * fix resolves the candidate's current non-terminal engagement first and, when
 * it is gate-armable (`eligible` or `scheduled`), arms the exclusive gate on
 * THAT existing cycle directly — no `request_phone_rescreen`, no new cycle.
 *
 * These are HTTP-level tests against the real `candidatesRouter` with an
 * injected admin `authUser`. The supabase client is fully mocked: every `.from`
 * read and every `.rpc` call is a sequenced fake, so a test can assert both the
 * HTTP result AND that `request_phone_rescreen` was or was not invoked. No
 * network, no database.
 *
 * The arm gate's own contract (halt requirement, expiry bounds, idempotency,
 * candidate match, the scheduled/due predicate) is exercised at the SQL level
 * in phone-test-gate-migration.test.ts; here we only prove the route routes to
 * the right RPC and maps the arm status matrix — including the new
 * `test_gate_appointment_not_due` refusal — onto the HTTP contract.
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import request from 'supertest';
import express from 'express';
import { candidatesRouter } from '../routes/candidates.js';
import { finalErrorHandler } from '../lib/validation.js';
import { getAuditSink, setAuditSink, type AuditEntry } from '../lib/audit.js';

vi.mock('../lib/supabase.js', () => ({
  supabase: { from: vi.fn(), rpc: vi.fn() },
  RESUME_BUCKET: 'resumes_v2',
}));

const ADMIN_ID = '66666666-6666-4666-8666-666666666666';
const CANDIDATE_ID = '0cd4b8e0-0000-4000-8000-000000000001';
const ENGAGEMENT_ID = '22222222-2222-4222-8222-222222222222';
const ENGAGEMENT_ID_2 = '33333333-3333-4333-8333-333333333333';
const LINK_A = 'aaaaaaaa-0000-4000-8000-000000000001';
const LINK_B = 'bbbbbbbb-0000-4000-8000-000000000002';
const REQUEST_ID = 'owner-test-2026-09-05-001';

/** A thenable chain: `.from(...).select(...).eq(...)....maybeSingle()` all
 *  resolve to the same terminal `value`, matching the postgrest builder. */
function chainable(value: unknown): any {
  const fn: any = function () { return chainable(value); };
  fn.then = (resolve: (v: unknown) => unknown) => Promise.resolve(value).then(resolve);
  fn.catch = (reject: (e: unknown) => unknown) => Promise.resolve(value).catch(reject);
  for (const m of ['select', 'eq', 'is', 'in', 'order', 'limit', 'maybeSingle', 'single', 'gt', 'gte', 'lt', 'lte', 'neq']) {
    fn[m] = () => chainable(value);
  }
  return fn;
}

let mockFrom: any;
let mockRpc: any;
let originalSink: ReturnType<typeof getAuditSink>;
let audited: AuditEntry[];

beforeEach(async () => {
  process.env.PHONE_SCREENING_ENABLED = 'true';
  const mod = await import('../lib/supabase.js');
  mockFrom = (mod.supabase as any).from;
  mockRpc = (mod.supabase as any).rpc;
  mockFrom.mockReset();
  mockRpc.mockReset();
  originalSink = getAuditSink();
  audited = [];
  setAuditSink((entry) => { audited.push(entry); });
});

afterEach(() => {
  setAuditSink(originalSink);
  delete process.env.PHONE_SCREENING_ENABLED;
  vi.restoreAllMocks();
});

function makeApp() {
  const app = express();
  app.use(express.json());
  app.use((req, _res, next) => {
    (req as unknown as { authUser: unknown }).authUser = { id: ADMIN_ID, appRole: 'admin' };
    next();
  });
  app.use('/api/candidates', candidatesRouter);
  app.use(finalErrorHandler);
  return app;
}

/** The name of every RPC the route invoked, in call order. */
function rpcNames(): string[] {
  return mockRpc.mock.calls.map((c: unknown[]) => c[0] as string);
}

const armOk = { data: { status: 'ok', gate_id: 'g1', candidate_id: CANDIDATE_ID, engagement_id: ENGAGEMENT_ID, expires_at: '2026-09-05T00:10:00.000Z' }, error: null };

describe('existing engagement is armed in place — no fresh rescreen cycle', () => {
  it('a `scheduled` engagement with a due appointment arms (202) and never calls request_phone_rescreen', async () => {
    // Exactly one non-terminal engagement, scheduled.
    mockFrom.mockReturnValueOnce(chainable({
      data: [{ id: ENGAGEMENT_ID, state: 'scheduled', application_link_id: LINK_A, cycle_number: 2 }],
      error: null,
    }));
    // Only arm_phone_test_gate is called; it succeeds (the SQL side already
    // verified the appointment is due).
    mockRpc.mockResolvedValueOnce(armOk);

    const res = await request(makeApp())
      .post(`/api/candidates/${CANDIDATE_ID}/phone-test-gate`)
      .send({ request_id: REQUEST_ID });

    expect(res.status).toBe(202);
    expect(res.body).toEqual({
      ok: true, status: 'armed', engagement_id: ENGAGEMENT_ID, cycle_number: 2,
    });
    // The whole point: the rescreen RPC was NOT invoked, so no new cycle.
    expect(rpcNames()).toEqual(['arm_phone_test_gate']);
    expect(rpcNames()).not.toContain('request_phone_rescreen');
    // Armed on the EXISTING engagement id and the operator's request key.
    const args = mockRpc.mock.calls[0][1] as Record<string, unknown>;
    expect(args.p_engagement_id).toBe(ENGAGEMENT_ID);
    expect(args.p_candidate_id).toBe(CANDIDATE_ID);
    expect(args.p_request_id).toBe(REQUEST_ID);
    expect(args.p_actor_id).toBe(ADMIN_ID);
    // Audited as a gate arm.
    expect(audited.some((e) => JSON.stringify(e.metadata).includes('phone_test_gate'))).toBe(true);
  });

  it('an `eligible` engagement is armed directly, also skipping the rescreen', async () => {
    mockFrom.mockReturnValueOnce(chainable({
      data: [{ id: ENGAGEMENT_ID, state: 'eligible', application_link_id: LINK_A, cycle_number: 5 }],
      error: null,
    }));
    mockRpc.mockResolvedValueOnce(armOk);

    const res = await request(makeApp())
      .post(`/api/candidates/${CANDIDATE_ID}/phone-test-gate`)
      .send({ request_id: REQUEST_ID });

    expect(res.status).toBe(202);
    expect(res.body).toMatchObject({ ok: true, status: 'armed', engagement_id: ENGAGEMENT_ID, cycle_number: 5 });
    expect(rpcNames()).toEqual(['arm_phone_test_gate']);
  });

  it('a `scheduled` engagement whose slot is not due surfaces test_gate_appointment_not_due (409)', async () => {
    mockFrom.mockReturnValueOnce(chainable({
      data: [{ id: ENGAGEMENT_ID, state: 'scheduled', application_link_id: LINK_A, cycle_number: 2 }],
      error: null,
    }));
    // The SQL side refuses because the live appointment is future/expired.
    mockRpc.mockResolvedValueOnce({ data: { status: 'test_gate_appointment_not_due', state: 'scheduled' }, error: null });

    const res = await request(makeApp())
      .post(`/api/candidates/${CANDIDATE_ID}/phone-test-gate`)
      .send({ request_id: REQUEST_ID });

    expect(res.status).toBe(409);
    expect(res.body).toEqual({
      ok: false, error: 'phone_test_gate_refused', status: 'test_gate_appointment_not_due',
    });
    // Still no rescreen cycle was minted on the refusal path.
    expect(rpcNames()).toEqual(['arm_phone_test_gate']);
  });

  it('already_armed on the existing engagement is idempotent success (202)', async () => {
    mockFrom.mockReturnValueOnce(chainable({
      data: [{ id: ENGAGEMENT_ID, state: 'scheduled', application_link_id: LINK_A, cycle_number: 2 }],
      error: null,
    }));
    mockRpc.mockResolvedValueOnce({ data: { status: 'already_armed', gate_id: 'g1', engagement_id: ENGAGEMENT_ID }, error: null });

    const res = await request(makeApp())
      .post(`/api/candidates/${CANDIDATE_ID}/phone-test-gate`)
      .send({ request_id: REQUEST_ID });

    expect(res.status).toBe(202);
    expect(res.body.status).toBe('armed');
    expect(rpcNames()).toEqual(['arm_phone_test_gate']);
  });
});

describe('fail-closed on an ambiguous or non-armable existing engagement', () => {
  it('TWO non-terminal engagements across two application_links → 409 ambiguous, arm NOT called', async () => {
    // cycle_number is unique only PER application_link, so a candidate can hold
    // several non-terminal engagements. The gate is a pause bypass, so this
    // must refuse rather than guess which application to arm.
    mockFrom.mockReturnValueOnce(chainable({
      data: [
        { id: ENGAGEMENT_ID, state: 'scheduled', application_link_id: LINK_A, cycle_number: 1 },
        { id: ENGAGEMENT_ID_2, state: 'eligible', application_link_id: LINK_B, cycle_number: 1 },
      ],
      error: null,
    }));

    const res = await request(makeApp())
      .post(`/api/candidates/${CANDIDATE_ID}/phone-test-gate`)
      .send({ request_id: REQUEST_ID });

    expect(res.status).toBe(409);
    expect(res.body).toMatchObject({
      ok: false, error: 'phone_test_gate_ambiguous_engagement', count: 2,
    });
    expect(res.body.states).toEqual(['scheduled', 'eligible']);
    // Neither RPC ran: the pause bypass was never armed on a guessed engagement.
    expect(rpcNames()).toEqual([]);
  });

  it('a single NON-armable engagement (in_call) → 409 not_armable, neither arm nor rescreen called', async () => {
    // A live but non-armable state must NOT fall through to request_phone_rescreen
    // (that would re-trigger the exact active_cycle bug this route fixes).
    mockFrom.mockReturnValueOnce(chainable({
      data: [{ id: ENGAGEMENT_ID, state: 'in_call', application_link_id: LINK_A, cycle_number: 3 }],
      error: null,
    }));

    const res = await request(makeApp())
      .post(`/api/candidates/${CANDIDATE_ID}/phone-test-gate`)
      .send({ request_id: REQUEST_ID });

    expect(res.status).toBe(409);
    expect(res.body).toMatchObject({
      ok: false, error: 'phone_test_gate_engagement_not_armable', state: 'in_call',
    });
    expect(rpcNames()).toEqual([]);
    expect(rpcNames()).not.toContain('request_phone_rescreen');
    expect(rpcNames()).not.toContain('arm_phone_test_gate');
  });
});

describe('no active engagement falls back to the original rescreen path', () => {
  it('when the candidate has no non-terminal engagement, request_phone_rescreen then arm are both called', async () => {
    // Zero non-terminal engagements.
    mockFrom.mockReturnValueOnce(chainable({ data: [], error: null }));
    // request_phone_rescreen mints a cycle and returns the new engagement id...
    mockRpc.mockResolvedValueOnce({ data: { status: 'ok', engagement_id: ENGAGEMENT_ID, cycle_number: 1 }, error: null });
    // ...then arm_phone_test_gate arms it.
    mockRpc.mockResolvedValueOnce(armOk);

    const res = await request(makeApp())
      .post(`/api/candidates/${CANDIDATE_ID}/phone-test-gate`)
      .send({ request_id: REQUEST_ID });

    expect(res.status).toBe(202);
    expect(res.body).toMatchObject({ ok: true, status: 'armed', engagement_id: ENGAGEMENT_ID, cycle_number: 1 });
    // Original two-step path preserved for a genuinely fresh candidate.
    expect(rpcNames()).toEqual(['request_phone_rescreen', 'arm_phone_test_gate']);
  });

  it('a rescreen refusal (active_cycle) on the fallback path is still a 409 phone_rescreen_refused', async () => {
    mockFrom.mockReturnValueOnce(chainable({ data: [], error: null }));
    mockRpc.mockResolvedValueOnce({ data: { status: 'active_cycle' }, error: null });

    const res = await request(makeApp())
      .post(`/api/candidates/${CANDIDATE_ID}/phone-test-gate`)
      .send({ request_id: REQUEST_ID });

    expect(res.status).toBe(409);
    expect(res.body).toEqual({ ok: false, error: 'phone_rescreen_refused', status: 'active_cycle' });
    // The gate was never armed because no engagement was resolved.
    expect(rpcNames()).toEqual(['request_phone_rescreen']);
  });
});
