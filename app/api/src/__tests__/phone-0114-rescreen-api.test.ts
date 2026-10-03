/**
 * 0114 §7 (C6) — the API side of the request_phone_rescreen drift fix.
 *
 * request_phone_rescreen now runs ensure_ashby_phone_engagement for the new
 * child and returns its verdict as `prerequisite_status`. The API:
 *   * maps it in the store adapter (`prerequisiteStatus`), keeping an absent
 *     key (pre-0114 database) distinguishable from a present null (a replay
 *     that evaluated nothing);
 *   * pins it as a load-bearing result key in rpc-contract.ts;
 *   * echoes it in the 202 body of POST /candidates/:id/phone-rescreens;
 *   * on the owner test gate's FRESH path, answers 409
 *     `phone_test_gate_prereqs_unmet` {status, engagement_id, cycle_number}
 *     and does NOT arm when the child is not eligible/scheduled_next_window.
 *
 * HTTP tests run against the real candidatesRouter with a mocked supabase
 * client (no network, no database), mirroring
 * phone-owner-test-gate-scheduled.test.ts.
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import request from 'supertest';
import express from 'express';
import type { SupabaseClient } from '@supabase/supabase-js';
import { candidatesRouter } from '../routes/candidates.js';
import { finalErrorHandler } from '../lib/validation.js';
import { getAuditSink, setAuditSink, type AuditEntry } from '../lib/audit.js';
import { createPhoneStores } from '../lib/phone-screening/stores.js';
import { PHONE_RPC_RESULT_KEYS } from '../lib/phone-screening/rpc-contract.js';
import { functionBody } from './support/phone-migration.js';

vi.mock('../lib/supabase.js', () => ({
  supabase: { from: vi.fn(), rpc: vi.fn() },
  RESUME_BUCKET: 'resumes_v2',
}));

const ADMIN_ID = '66666666-6666-4666-8666-666666666666';
const CANDIDATE_ID = '0cd4b8e0-0000-4000-8000-000000000001';
const ENGAGEMENT_ID = '22222222-2222-4222-8222-222222222222';
const REQUEST_ID = 'owner-test-2026-10-03-001';
const NOW = new Date('2026-10-03T08:30:00.000Z');

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

function rpcNames(): string[] {
  return mockRpc.mock.calls.map((c: unknown[]) => c[0] as string);
}

const armOk = {
  data: { status: 'ok', gate_id: 'g1', candidate_id: CANDIDATE_ID, engagement_id: ENGAGEMENT_ID, expires_at: '2026-10-03T08:40:00.000Z' },
  error: null,
};

// ─── rpc-contract + store ────────────────────────────────────────────────

describe('prerequisite_status is a pinned result key and is mapped by the store', () => {
  it('rpc-contract pins prerequisite_status and the newest request_phone_rescreen body emits it', () => {
    expect(PHONE_RPC_RESULT_KEYS.request_phone_rescreen).toContain('prerequisite_status');
    const body = functionBody('request_phone_rescreen');
    // Both the fresh answer and the replay answer carry it.
    expect([...body.matchAll(/'prerequisite_status'/g)].length).toBeGreaterThanOrEqual(2);
    // …and the value comes from ensure, not from a literal.
    expect(body).toContain('ensure_ashby_phone_engagement');
  });

  function fakeClient(answer: unknown): SupabaseClient {
    return {
      rpc: () => Promise.resolve({ data: answer, error: null }),
      from() { throw new Error('phone stores must never reach a table directly'); },
    } as unknown as SupabaseClient;
  }
  const input = {
    candidateId: 'c1', reason: 'technical_issue', requestId: 'r1',
    source: 'hr_manual' as const, actorId: 'actor-1', now: NOW,
  };

  it('maps a present string', async () => {
    const r = await createPhoneStores(fakeClient({
      status: 'ok', engagement_id: 'e2', cycle_number: 2, predecessor_engagement_id: 'e1',
      prerequisite_status: 'consent_not_granted',
    })).requestRescreen(input);
    expect(r).toEqual({
      status: 'ok', engagementId: 'e2', cycleNumber: 2, predecessorEngagementId: 'e1',
      requestId: undefined, prerequisiteStatus: 'consent_not_granted',
    });
  });

  it('a present null (a replay that evaluated nothing) stays null', async () => {
    const r = await createPhoneStores(fakeClient({
      status: 'already_requested', engagement_id: 'e2', cycle_number: 2, request_id: 'r1',
      prerequisite_status: null,
    })).requestRescreen(input);
    expect(r.prerequisiteStatus).toBeNull();
    expect('prerequisiteStatus' in r).toBe(true);
  });

  it('an absent key (pre-0114 database) is undefined, not null', async () => {
    const r = await createPhoneStores(fakeClient({
      status: 'ok', engagement_id: 'e2', cycle_number: 2,
    })).requestRescreen(input);
    expect(r.prerequisiteStatus).toBeUndefined();
  });

  it('a non-string value is null, never coerced', async () => {
    const r = await createPhoneStores(fakeClient({
      status: 'ok', engagement_id: 'e2', prerequisite_status: 42,
    })).requestRescreen(input);
    expect(r.prerequisiteStatus).toBeNull();
  });
});

// ─── POST /:id/phone-rescreens ───────────────────────────────────────────

describe('POST /candidates/:id/phone-rescreens echoes prerequisite_status', () => {
  function candidateFound() {
    mockFrom.mockReturnValueOnce(chainable({ data: { id: CANDIDATE_ID, owner_id: ADMIN_ID }, error: null }));
  }
  const send = () => request(makeApp())
    .post(`/api/candidates/${CANDIDATE_ID}/phone-rescreens`)
    .send({ request_id: REQUEST_ID, reason: 'technical_issue' });

  it('202 carries the evaluator verdict', async () => {
    candidateFound();
    mockRpc.mockResolvedValueOnce({
      data: { status: 'ok', engagement_id: ENGAGEMENT_ID, cycle_number: 2, prerequisite_status: 'eligible' },
      error: null,
    });
    const res = await send();
    expect(res.status).toBe(202);
    expect(res.body).toEqual({ ok: true, status: 'ok', cycle_number: 2, prerequisite_status: 'eligible' });
    expect(rpcNames()).toEqual(['request_phone_rescreen']);
  });

  it('202 carries a still-pending reason verbatim (the cycle exists, it just is not dialable yet)', async () => {
    candidateFound();
    mockRpc.mockResolvedValueOnce({
      data: { status: 'ok', engagement_id: ENGAGEMENT_ID, cycle_number: 2, prerequisite_status: 'mapping_not_enabled' },
      error: null,
    });
    const res = await send();
    expect(res.status).toBe(202);
    expect(res.body.prerequisite_status).toBe('mapping_not_enabled');
  });

  it('a pure-read replay echoes null', async () => {
    candidateFound();
    mockRpc.mockResolvedValueOnce({
      data: { status: 'already_requested', engagement_id: ENGAGEMENT_ID, cycle_number: 2, request_id: REQUEST_ID, prerequisite_status: null },
      error: null,
    });
    const res = await send();
    expect(res.status).toBe(202);
    expect(res.body).toEqual({ ok: true, status: 'already_requested', cycle_number: 2, prerequisite_status: null });
  });

  it('a pre-0114 answer with no key echoes null (additive, never breaks the 202)', async () => {
    candidateFound();
    mockRpc.mockResolvedValueOnce({ data: { status: 'ok', engagement_id: ENGAGEMENT_ID, cycle_number: 2 }, error: null });
    const res = await send();
    expect(res.status).toBe(202);
    expect(res.body.prerequisite_status).toBeNull();
  });

  it('refusals are unchanged: 409 phone_rescreen_refused with no prerequisite key', async () => {
    candidateFound();
    mockRpc.mockResolvedValueOnce({ data: { status: 'cycle_limit_reached' }, error: null });
    const res = await send();
    expect(res.status).toBe(409);
    expect(res.body).toEqual({ ok: false, error: 'phone_rescreen_refused', status: 'cycle_limit_reached' });
  });

  it('an RPC error (e.g. rescreen_evaluator_target_mismatch rolled back) is a retry-safe 503', async () => {
    candidateFound();
    mockRpc.mockResolvedValueOnce({ data: null, error: { message: 'rescreen_evaluator_target_mismatch', code: '22000' } });
    const res = await send();
    expect(res.status).toBe(503);
    expect(res.body).toEqual({ ok: false, error: 'phone_rescreen_unavailable' });
  });
});

// ─── POST /:id/phone-test-gate fresh path ────────────────────────────────

describe('owner test gate fresh path refuses to arm a child whose prerequisites are unmet', () => {
  const send = () => request(makeApp())
    .post(`/api/candidates/${CANDIDATE_ID}/phone-test-gate`)
    .send({ request_id: REQUEST_ID });

  function noLiveEngagement() {
    mockFrom.mockReturnValueOnce(chainable({ data: [], error: null }));
  }

  for (const armable of ['eligible', 'scheduled_next_window']) {
    it(`prerequisite_status=${armable} arms (202)`, async () => {
      noLiveEngagement();
      mockRpc.mockResolvedValueOnce({
        data: { status: 'ok', engagement_id: ENGAGEMENT_ID, cycle_number: 2, prerequisite_status: armable },
        error: null,
      });
      mockRpc.mockResolvedValueOnce(armOk);
      const res = await send();
      expect(res.status).toBe(202);
      expect(res.body).toEqual({ ok: true, status: 'armed', engagement_id: ENGAGEMENT_ID, cycle_number: 2 });
      expect(rpcNames()).toEqual(['request_phone_rescreen', 'arm_phone_test_gate']);
    });
  }

  for (const unmet of [
    'consent_not_granted', 'consent_evidence_missing', 'mapping_not_enabled',
    'ingestion_not_ready', 'phone_invalid', 'duplicate_application',
  ]) {
    it(`prerequisite_status=${unmet} → 409 phone_test_gate_prereqs_unmet, arm NOT called`, async () => {
      noLiveEngagement();
      mockRpc.mockResolvedValueOnce({
        data: { status: 'ok', engagement_id: ENGAGEMENT_ID, cycle_number: 2, predecessor_engagement_id: 'p', prerequisite_status: unmet },
        error: null,
      });
      const res = await send();
      expect(res.status).toBe(409);
      expect(res.body).toEqual({
        ok: false,
        error: 'phone_test_gate_prereqs_unmet',
        status: unmet,
        engagement_id: ENGAGEMENT_ID,
        cycle_number: 2,
      });
      // The pause bypass was never armed on a child that cannot be dialled.
      expect(rpcNames()).toEqual(['request_phone_rescreen']);
      expect(audited.some((e) => JSON.stringify(e.metadata ?? {}).includes('phone_test_gate'))).toBe(false);
    });
  }

  it('a same-request replay that self-healed to eligible arms', async () => {
    noLiveEngagement();
    mockRpc.mockResolvedValueOnce({
      data: { status: 'already_requested', engagement_id: ENGAGEMENT_ID, cycle_number: 2, request_id: REQUEST_ID, prerequisite_status: 'eligible' },
      error: null,
    });
    mockRpc.mockResolvedValueOnce(armOk);
    const res = await send();
    expect(res.status).toBe(202);
    expect(rpcNames()).toEqual(['request_phone_rescreen', 'arm_phone_test_gate']);
  });

  it('a same-request replay still unmet is refused with the real reason', async () => {
    noLiveEngagement();
    mockRpc.mockResolvedValueOnce({
      data: { status: 'already_requested', engagement_id: ENGAGEMENT_ID, cycle_number: 3, request_id: REQUEST_ID, prerequisite_status: 'consent_expired' },
      error: null,
    });
    const res = await send();
    expect(res.status).toBe(409);
    expect(res.body).toMatchObject({ error: 'phone_test_gate_prereqs_unmet', status: 'consent_expired', cycle_number: 3 });
    expect(rpcNames()).toEqual(['request_phone_rescreen']);
  });

  it('a null status (pure-read replay) or a pre-0114 answer falls through to the arm, which decides', async () => {
    for (const data of [
      { status: 'already_requested', engagement_id: ENGAGEMENT_ID, cycle_number: 2, prerequisite_status: null },
      { status: 'ok', engagement_id: ENGAGEMENT_ID, cycle_number: 2 },
    ]) {
      mockFrom.mockReset();
      mockRpc.mockReset();
      noLiveEngagement();
      mockRpc.mockResolvedValueOnce({ data, error: null });
      mockRpc.mockResolvedValueOnce({ data: { status: 'test_gate_not_armable', state: 'pending_prereqs' }, error: null });
      const res = await send();
      expect(res.status).toBe(409);
      expect(res.body).toEqual({ ok: false, error: 'phone_test_gate_refused', status: 'test_gate_not_armable' });
      expect(rpcNames()).toEqual(['request_phone_rescreen', 'arm_phone_test_gate']);
    }
  });

  it('the unmet refusal never leaks anything but stable codes and opaque ids', async () => {
    noLiveEngagement();
    mockRpc.mockResolvedValueOnce({
      data: { status: 'ok', engagement_id: ENGAGEMENT_ID, cycle_number: 2, prerequisite_status: 'phone_invalid', phone_e164: '+919999999999' },
      error: null,
    });
    const res = await send();
    expect(res.status).toBe(409);
    expect(Object.keys(res.body).sort()).toEqual(['cycle_number', 'engagement_id', 'error', 'ok', 'status']);
    expect(JSON.stringify(res.body)).not.toContain('+91');
  });

  it('a rescreen refusal on the fresh path is unchanged (409 phone_rescreen_refused)', async () => {
    noLiveEngagement();
    mockRpc.mockResolvedValueOnce({ data: { status: 'consent_not_granted' }, error: null });
    const res = await send();
    expect(res.status).toBe(409);
    expect(res.body).toEqual({ ok: false, error: 'phone_rescreen_refused', status: 'consent_not_granted' });
    expect(rpcNames()).toEqual(['request_phone_rescreen']);
  });
});
