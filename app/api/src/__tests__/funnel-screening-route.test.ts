/**
 * GET /api/funnel/summary — the recruiter-facing twin of the admin funnel
 * summary, served from the SAME implementation at a lower privilege.
 *
 * This route had no route-level test at all. Its entire safety rests on two
 * lines in `routes/funnel.ts`, and neither was pinned:
 *
 *   requireRole('interviewer')   delete it and every authenticated VIEWER can
 *                                read screening metrics — the global middleware
 *                                is viewer-read-only, so it permits this GET,
 *                                and this gate is the only thing standing there.
 *                                Its admin twin has exactly this test.
 *
 *   omitTimings: true            delete it and per-day latency percentiles reach
 *                                every interviewer. Under a role filter the
 *                                rollup grain is unique per day, so on a day
 *                                that role saw one candidate those ARE that
 *                                individual's time-to-first-connect.
 *
 * Neither failure produces an error, a log line, or a visible change. The only
 * thing that can catch them is a test that asks.
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
const admin = (): AuthUser => ({ id: 'user-admin-0000-0000-000000000001', email: 'a@e.com', aal: 'aal2', active: true, appRole: 'admin', orgId: 'org-1' });
const interviewer = (): AuthUser => ({ id: 'user-intv-0000-0000-000000000002', email: 'i@e.com', aal: 'aal2', active: true, appRole: 'interviewer', orgId: 'org-1' });
const viewer = (): AuthUser => ({ id: 'user-view-0000-0000-000000000003', email: 'v@e.com', aal: 'aal1', active: true, appRole: 'viewer', orgId: null });

/** Same shape as the admin suite's, including `.not` — see the note there. */
function chainable(value: unknown): any {
  const fn: any = () => chainable(value);
  fn.then = (resolve: (v: unknown) => unknown) => Promise.resolve(value).then(resolve);
  fn.catch = (reject: (e: unknown) => unknown) => Promise.resolve(value).catch(reject);
  for (const m of ['select', 'eq', 'gte', 'lte', 'not', 'order', 'limit', 'range', 'from']) fn[m] = () => chainable(value);
  return fn;
}

vi.mock('../lib/supabase.js', () => ({
  supabase: { from: vi.fn(), rpc: vi.fn(), auth: { getUser: vi.fn() }, storage: { from: vi.fn() } },
  RESUME_BUCKET: 'resumes_v2',
}));

let mockSupabase: { from: any; rpc: any };

/** One rollup row with the timing percentiles populated. */
const ROW = {
  cohort_day: '2026-09-16', role_id: 'r1',
  entered_parse: 4, parsed_ok: 4, needs_review: 0, parse_failed: 0,
  dialed: 3, connected: 2, consent_passed: 2, consent_dropped: 0, answered_ge1: 2,
  scored: 2, qualified: 1, on_hold: 0, disqualified: 1, human_review: 0,
  reached_reference_check: 0, attempts_total: 5, connects_total: 2, total_call_seconds: 300,
  hr_qualified: 0, hr_disqualified: 0, hr_awaiting: 2, hr_unknown: 0, candidates_total: 4,
  median_ttfc_sec: 12, p95_ttfc_sec: 30, refreshed_at: '2026-09-16T06:00:00Z',
};

beforeEach(async () => {
  setRateLimitStore(new MemoryRateLimitStore(1000));
  setAuditSink(() => {});
  const mod = await import('../lib/supabase.js');
  mockSupabase = mod.supabase as any;
  mockSupabase.from.mockReset();
  mockSupabase.rpc.mockReset();
  mockSupabase.from.mockReturnValue(chainable({ data: [ROW], error: null }));
});

afterEach(() => vi.restoreAllMocks());

const app = (u: AuthUser) => createApp({ authDeps: authDepsForUser(u) });
const auth = (r: request.Test) => r.set('Authorization', `Bearer ${JWT}`);

describe('GET /api/funnel/summary', () => {
  it('refuses a viewer (403)', async () => {
    const res = await auth(request(app(viewer())).get('/api/funnel/summary'));
    expect(res.status).toBe(403);
  });

  it('refuses an unauthenticated caller (401)', async () => {
    const res = await request(app(interviewer())).get('/api/funnel/summary');
    expect(res.status).toBe(401);
  });

  it('serves an interviewer', async () => {
    const res = await auth(request(app(interviewer())).get('/api/funnel/summary'));
    expect(res.status).toBe(200);
    expect(res.body.totals.dialed).toBe(3);
  });

  it('serves an admin too — this is not an interviewer-ONLY route', async () => {
    const res = await auth(request(app(admin())).get('/api/funnel/summary'));
    expect(res.status).toBe(200);
  });

  it('strips the per-day latency percentiles', async () => {
    // The one deliberate difference from the admin twin. With a role filter the
    // grain is one row per day, so on a single-candidate day these are one
    // person's call timings.
    const res = await auth(request(app(interviewer())).get('/api/funnel/summary'));
    expect(res.status).toBe(200);
    expect(res.body.series).toHaveLength(1);
    expect(res.body.series[0]).not.toHaveProperty('median_ttfc_sec');
    expect(res.body.series[0]).not.toHaveProperty('p95_ttfc_sec');
    // …while the counts a dashboard needs are still there, so a mutation that
    // returned an empty series would not pass this by accident.
    expect(res.body.series[0]).toMatchObject({ cohort_day: '2026-09-16', dialed: 3 });
  });

  it('the ADMIN twin still carries them — the two routes differ only here', async () => {
    const res = await auth(request(app(admin())).get('/api/admin/funnel/summary'));
    expect(res.status).toBe(200);
    expect(res.body.series[0]).toMatchObject({ median_ttfc_sec: 12, p95_ttfc_sec: 30 });
  });

  it('agrees with the admin route on every figure it reports', async () => {
    // The stated reason lib/funnel/summary.ts exists is that "the KPI card and
    // the admin page disagree" is a defect nobody reports and everybody stops
    // trusting the dashboard over. A shared module makes drift unlikely; this
    // makes it detected — the first divergence will be a field added to one
    // route's res.json wrapper.
    const mine = await auth(request(app(interviewer())).get('/api/funnel/summary'));
    const theirs = await auth(request(app(admin())).get('/api/admin/funnel/summary'));

    expect(mine.body.totals).toEqual(theirs.body.totals);
    expect(mine.body.conversions).toEqual(theirs.body.conversions);
    expect(mine.body.range).toEqual(theirs.body.range);
    expect(mine.body.meta).toEqual(theirs.body.meta);

    const { median_ttfc_sec: _m, p95_ttfc_sec: _p, ...adminDay } = theirs.body.series[0];
    expect(mine.body.series[0]).toEqual(adminDay);
  });

  it('reports the meta facts the dashboard refuses to infer', async () => {
    const res = await auth(request(app(interviewer())).get('/api/funnel/summary'));
    expect(res.body.meta).toMatchObject({
      schema_current: true,
      refresh_window_days: expect.any(Number),
      hr_tracking_configured: expect.any(Boolean),
      rollup_freshness_known: expect.any(Boolean),
    });
  });

  it('rejects a non-uuid role filter (400)', async () => {
    const res = await auth(
      request(app(interviewer())).get('/api/funnel/summary?role_id=not-a-uuid'),
    );
    expect(res.status).toBe(400);
  });

  it('rejects a malformed date (400)', async () => {
    const res = await auth(request(app(interviewer())).get('/api/funnel/summary?from=16-09-2026'));
    expect(res.status).toBe(400);
  });

  it('turns a read failure into a sanitized 500, not a leaked driver error', async () => {
    mockSupabase.from.mockReturnValue(
      chainable({ data: null, error: { code: '42501', message: 'permission denied for relation funnel_stage_daily' } }),
    );
    const res = await auth(request(app(interviewer())).get('/api/funnel/summary'));
    expect(res.status).toBe(500);
    expect(JSON.stringify(res.body)).not.toContain('permission denied');
  });
});
