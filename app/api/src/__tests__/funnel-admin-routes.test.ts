/**
 * PR2 admin funnel routes — /api/admin/funnel/{summary,failures,candidates,refresh}.
 *
 * Pins: (1) the admin boundary (a viewer is refused 403), (2) the summary
 * aggregates the stored rollup into totals + derived conversions, (3) failures
 * groups the taxonomy, (4) candidates paginates the drill-down, (5) refresh
 * calls the advisory-locked RPC. Supabase + auth are injected; no real DB.
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import request from 'supertest';
import { createApp } from '../app.js';
import { mockAuthGetUser, type AuthUser, type TokenVerifier } from '../lib/auth.js';
import { MemoryRateLimitStore, setRateLimitStore } from '../lib/rate-limit.js';
import { setAuditSink } from '../lib/audit.js';

const JWT = 'eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiJ1c2VyLTAwMSIsImFhbCI6ImFhbDIifQ.signature';

function authDepsForUser(user: AuthUser): { getUser: TokenVerifier } {
  return { getUser: mockAuthGetUser(user, JWT) };
}
function makeAdmin(): AuthUser {
  return { id: 'user-admin-0000-0000-000000000001', email: 'admin@example.com', aal: 'aal2', active: true, appRole: 'admin', orgId: 'org-1' };
}
function makeViewer(): AuthUser {
  return { id: 'user-view-0000-0000-000000000003', email: 'viewer@example.com', aal: 'aal1', active: true, appRole: 'viewer', orgId: null };
}

/** Chainable thenable covering select/gte/lte/eq/order/limit/range. */
function chainable(value: unknown): any {
  const fn: any = () => chainable(value);
  fn.then = (resolve: (v: unknown) => unknown) => Promise.resolve(value).then(resolve);
  fn.catch = (reject: (e: unknown) => unknown) => Promise.resolve(value).catch(reject);
  for (const m of ['select', 'eq', 'gte', 'lte', 'order', 'limit', 'range', 'from']) fn[m] = () => chainable(value);
  return fn;
}

vi.mock('../lib/supabase.js', () => ({
  supabase: { from: vi.fn(), rpc: vi.fn(), auth: { getUser: vi.fn() }, storage: { from: vi.fn() } },
  RESUME_BUCKET: 'resumes_v2',
}));

let mockSupabase: { from: any; rpc: any };

beforeEach(async () => {
  setRateLimitStore(new MemoryRateLimitStore(1000));
  setAuditSink(() => {});
  const mod = await import('../lib/supabase.js');
  mockSupabase = mod.supabase as any;
  mockSupabase.from.mockReset();
  mockSupabase.rpc.mockReset();
});

afterEach(() => vi.restoreAllMocks());

function adminApp() { return createApp({ authDeps: authDepsForUser(makeAdmin()) }); }
function viewerApp() { return createApp({ authDeps: authDepsForUser(makeViewer()) }); }
const auth = (r: request.Test) => r.set('Authorization', `Bearer ${JWT}`);

describe('admin funnel routes', () => {
  it('refuses a non-admin (403) at the router boundary', async () => {
    mockSupabase.from.mockReturnValue(chainable({ data: [], error: null }));
    const res = await auth(request(viewerApp()).get('/api/admin/funnel/summary'));
    expect(res.status).toBe(403);
  });

  it('summary sums the rollup and derives conversions', async () => {
    mockSupabase.from.mockReturnValue(chainable({
      data: [
        { cohort_day: '2026-09-01', role_id: 'r1', entered_parse: 10, parsed_ok: 8, needs_review: 1, parse_failed: 1, dialed: 6, connected: 4, consent_passed: 3, consent_dropped: 1, answered_ge1: 3, scored: 2, qualified: 1, on_hold: 1, disqualified: 0, human_review: 0, reached_reference_check: 1, attempts_total: 9, connects_total: 4, total_call_seconds: 600, median_ttfc_sec: 12, p95_ttfc_sec: 30, refreshed_at: '2026-09-01T10:00:00Z' },
        { cohort_day: '2026-09-02', role_id: 'r1', entered_parse: 2, parsed_ok: 2, needs_review: 0, parse_failed: 0, dialed: 2, connected: 2, consent_passed: 1, consent_dropped: 0, answered_ge1: 1, scored: 0, qualified: 0, on_hold: 0, disqualified: 0, human_review: 0, reached_reference_check: 0, attempts_total: 3, connects_total: 2, total_call_seconds: 120, median_ttfc_sec: 8, p95_ttfc_sec: 20, refreshed_at: '2026-09-02T10:00:00Z' },
      ],
      error: null,
    }));
    const res = await auth(request(adminApp()).get('/api/admin/funnel/summary'));
    expect(res.status).toBe(200);
    expect(res.body.totals.parsed_ok).toBe(10);
    expect(res.body.totals.dialed).toBe(8);
    expect(res.body.totals.total_call_seconds).toBe(720);
    // dial_to_connect = connected(6) / dialed(8) = 0.75
    expect(res.body.conversions.dial_to_connect).toBeCloseTo(0.75, 5);
    expect(res.body.series).toHaveLength(2);
    expect(res.body.refreshed_at).toBe('2026-09-02T10:00:00Z');
  });

  it('failures groups the taxonomy by {stage, code}', async () => {
    mockSupabase.from.mockReturnValue(chainable({
      data: [
        { stage: 'resume_parse', code: 'parse_bad_output', entity_id: 'a', occurred_at: '2026-09-02T00:00:00Z' },
        { stage: 'resume_parse', code: 'parse_bad_output', entity_id: 'b', occurred_at: '2026-09-01T00:00:00Z' },
        { stage: 'dial', code: 'provider_error', entity_id: 'c', occurred_at: '2026-09-01T00:00:00Z' },
      ],
      error: null,
    }));
    const res = await auth(request(adminApp()).get('/api/admin/funnel/failures'));
    expect(res.status).toBe(200);
    expect(res.body.groups[0]).toEqual({ stage: 'resume_parse', code: 'parse_bad_output', count: 2 });
    expect(res.body.recent).toHaveLength(3);
    // below the fetch cap → counts are exact, not truncated
    expect(res.body.truncated).toBe(false);
    expect(res.body.range).toHaveProperty('from');
  });

  it('candidates returns the paginated drill-down', async () => {
    mockSupabase.from.mockReturnValue(chainable({
      data: [{ candidate_id: 'c1', furthest_stage: 'reference_check', drop_reason: null, reached_reference_check: true }],
      error: null,
    }));
    const res = await auth(request(adminApp()).get('/api/admin/funnel/candidates?furthest_stage=reference_check'));
    expect(res.status).toBe(200);
    expect(res.body.candidates).toHaveLength(1);
    expect(res.body.candidates[0].candidate_id).toBe('c1');
  });

  it('refresh calls the advisory-locked RPC and returns its result', async () => {
    mockSupabase.rpc.mockResolvedValue({ data: { status: 'ok', rows: 5 }, error: null });
    const res = await auth(request(adminApp()).post('/api/admin/funnel/refresh').send({ window_days: 14 }));
    expect(res.status).toBe(200);
    expect(res.body).toEqual({ ok: true, result: { status: 'ok', rows: 5 } });
    expect(mockSupabase.rpc).toHaveBeenCalledWith('refresh_funnel_rollup', { p_window_days: 14 });
  });
});
