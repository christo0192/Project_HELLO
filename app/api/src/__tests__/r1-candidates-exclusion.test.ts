/**
 * An R1 interview round's assessment is NOT a candidate's phone "latest assessment" (plan 8.1
 * M3): the candidate list and the summary aggregate drop assessments whose session carries
 * `interview_round_id`. The SQL half is the v_funnel_candidate asmt CTE (0122). Supabase is
 * mocked with a capturing chain, like candidates-summary.test.ts.
 *
 * The lookup of R1 session ids FAILS CLOSED: if it errors, or cannot be completed, both routes
 * answer 503 rather than reduce an unfiltered set (which would present an R1 recommendation as
 * the candidate's latest phone assessment).
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';
import request from 'supertest';
import { createApp } from '../app.js';
import { mockAuthGetUser, type AuthUser } from '../lib/auth.js';

const JWT = 'eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiJ1c2VyLTAwMSIsImFhbCI6ImFhbDIifQ.signature';
const AUTH = 'Bearer ' + JWT;
const admin: AuthUser = {
  id: 'user-admin-0000-0000-000000000001',
  email: 'admin@example.com',
  aal: 'aal2',
  active: true,
  appRole: 'admin',
  orgId: 'org-0000-0000-0000-000000000001',
};

const mockFrom = vi.fn();
const fromTables: string[] = [];
const notCalls: Array<{ table: string; column: string; op: unknown; value: unknown }> = [];
const rangeCalls: Array<{ table: string; from: unknown; to: unknown }> = [];
const queryCounts: Record<string, number> = {};

vi.mock('../lib/supabase.js', () => ({
  supabase: { from: (...a: unknown[]) => mockFrom(...a) },
  RESUME_BUCKET: 'resumes_v2',
}));

function chain(table: string, value: unknown): Record<string, unknown> {
  const c: Record<string, unknown> = {};
  const methods = ['select', 'insert', 'update', 'upsert', 'delete', 'neq', 'gt', 'gte', 'lt', 'lte', 'is', 'order', 'limit', 'single', 'maybeSingle', 'eq', 'in'];
  for (const m of methods) c[m] = () => chain(table, value);
  c.not = (column: string, op: unknown, v: unknown) => {
    notCalls.push({ table, column, op, value: v });
    return chain(table, value);
  };
  c.range = (from: unknown, to: unknown) => {
    rangeCalls.push({ table, from, to });
    return chain(table, value);
  };
  c.then = (resolve: (v: unknown) => unknown) => Promise.resolve(value).then(resolve);
  c.catch = (reject: (e: unknown) => unknown) => Promise.resolve(value).catch(reject);
  return c;
}

/** A table's value may be a function of how many queries it has seen (a paged lookup). */
function configure(config: Record<string, unknown>): void {
  mockFrom.mockImplementation((table: string) => {
    fromTables.push(table);
    queryCounts[table] = (queryCounts[table] ?? 0) + 1;
    const value = config[table];
    const resolved = typeof value === 'function'
      ? (value as (n: number) => unknown)(queryCounts[table] as number)
      : value;
    return chain(table, resolved ?? { data: null, error: null });
  });
}

const app = () => createApp({
  nodeEnv: 'test',
  webOrigin: 'http://localhost:5173',
  authDeps: { getUser: mockAuthGetUser(admin, JWT) },
  auditSinkOverride: async () => {},
});
const ok = (data: unknown) => ({ data, error: null });

const candidate = (id: string) => ({
  id, name: id, email: null, phone_e164: null, phone_valid: false, skills: [], experience_years: null,
  status: 'screened', role_id: null, created_at: '2026-02-01T00:00:00Z', decision_use_blocked_at: null,
});

beforeEach(() => {
  vi.clearAllMocks();
  fromTables.length = 0;
  notCalls.length = 0;
  rangeCalls.length = 0;
  for (const key of Object.keys(queryCounts)) delete queryCounts[key];
});

describe('GET /api/candidates: R1 assessments are not the latest assessment', () => {
  it('keeps the older phone assessment when a newer R1 assessment exists', async () => {
    configure({
      candidates: ok([candidate('c1')]),
      assessments: ok([
        { candidate_id: 'c1', session_id: 'r1-session', overall_score: 90, recommendation: 'advance', created_at: '2026-03-01T00:00:00Z' },
        { candidate_id: 'c1', session_id: 'phone-session', overall_score: 30, recommendation: 'reject', created_at: '2026-02-01T00:00:00Z' },
      ]),
      call_sessions: ok([{ id: 'r1-session' }]),
    });
    const res = await request(app()).get('/api/candidates').set('Authorization', AUTH);
    expect(res.status).toBe(200);
    expect(res.body[0].latest_recommendation).toBe('reject');
    expect(res.body[0].latest_score).toBe(30);
    // The R1 sessions were found with the interview_round_id IS NOT NULL predicate.
    expect(notCalls).toContainEqual({ table: 'call_sessions', column: 'interview_round_id', op: 'is', value: null });
  });

  it('leaves an R1-only candidate with no phone latest assessment', async () => {
    configure({
      candidates: ok([candidate('c2')]),
      assessments: ok([
        { candidate_id: 'c2', session_id: 'r1-session', overall_score: 90, recommendation: 'advance', created_at: '2026-03-01T00:00:00Z' },
      ]),
      call_sessions: ok([{ id: 'r1-session' }]),
    });
    const res = await request(app()).get('/api/candidates').set('Authorization', AUTH);
    expect(res.body[0].latest_recommendation).toBeNull();
    expect(res.body[0].latest_score).toBeNull();
  });

  it('is unchanged when no R1 session exists (today\'s behaviour)', async () => {
    const rows = [
      { candidate_id: 'c3', session_id: 'phone-session', overall_score: 55, recommendation: 'hold', created_at: '2026-03-01T00:00:00Z' },
    ];
    configure({ candidates: ok([candidate('c3')]), assessments: ok(rows), call_sessions: ok([]) });
    const res = await request(app()).get('/api/candidates').set('Authorization', AUTH);
    expect(res.status).toBe(200);
    expect(res.body[0].latest_recommendation).toBe('hold');
  });

  it('answers 503, never an unfiltered list, when the R1 session lookup fails', async () => {
    const rows = [
      { candidate_id: 'c3', session_id: 'r1-session', overall_score: 90, recommendation: 'advance', created_at: '2026-03-01T00:00:00Z' },
    ];
    for (const lookup of [
      { data: null, error: { message: 'down' } },
      { data: [{ id: 'r1-session' }], error: { message: 'partial result with an error' } },
    ]) {
      configure({ candidates: ok([candidate('c3')]), assessments: ok(rows), call_sessions: lookup });
      const res = await request(app()).get('/api/candidates').set('Authorization', AUTH);
      expect(res.status, JSON.stringify(lookup)).toBe(503);
      expect(res.body).toEqual({ error: 'service_unavailable' });
      // Nothing about the R1 recommendation leaked into the body.
      expect(JSON.stringify(res.body)).not.toContain('advance');
    }
  });

  it('reads the R1 session ids in bounded, ordered pages and excludes a session found on a later page', async () => {
    const page = (n: number) => (n === 1
      ? ok(Array.from({ length: 1000 }, (_, i) => ({ id: `other-${i}` })))
      : ok([{ id: 'r1-late' }]));
    configure({
      candidates: ok([candidate('c5')]),
      assessments: ok([
        { candidate_id: 'c5', session_id: 'r1-late', overall_score: 90, recommendation: 'advance', created_at: '2026-03-01T00:00:00Z' },
        { candidate_id: 'c5', session_id: 'phone-session', overall_score: 30, recommendation: 'reject', created_at: '2026-02-01T00:00:00Z' },
      ]),
      call_sessions: page,
    });
    const res = await request(app()).get('/api/candidates').set('Authorization', AUTH);
    expect(res.status).toBe(200);
    expect(res.body[0].latest_recommendation).toBe('reject');
    expect(rangeCalls).toEqual([
      { table: 'call_sessions', from: 0, to: 999 },
      { table: 'call_sessions', from: 1000, to: 1999 },
    ]);
  });

  it('fails closed (503) when the R1 sessions exceed the lookup bound: the set would be incomplete', async () => {
    configure({
      candidates: ok([candidate('c6')]),
      assessments: ok([
        { candidate_id: 'c6', session_id: 'r1-x', overall_score: 90, recommendation: 'advance', created_at: '2026-03-01T00:00:00Z' },
      ]),
      call_sessions: () => ok(Array.from({ length: 1000 }, (_, i) => ({ id: `s-${Math.random()}-${i}` }))),
    });
    const res = await request(app()).get('/api/candidates').set('Authorization', AUTH);
    expect(res.status).toBe(503);
    expect(rangeCalls).toHaveLength(50);
  });

  it('does not query call_sessions when there are no assessments', async () => {
    configure({ candidates: ok([candidate('c4')]), assessments: ok([]) });
    await request(app()).get('/api/candidates').set('Authorization', AUTH);
    expect(fromTables).not.toContain('call_sessions');
  });
});

describe('the R1 session lookup can never escape as an unhandled rejection', () => {
  // supabase-js reports failures as `{ error }`, but a client fault (a missing builder method,
  // a rejected transport promise) can still throw. Express 4 does not catch a rejection from
  // an async handler, so the lookup converts EVERY failure to null: the routes answer 503
  // (fail closed: an unknown R1 set must not become an unfiltered phone list) and the request
  // does not hang. Failure logs carry a fixed category and an enumerated type only.
  const r1Row = { candidate_id: 'c-leak', session_id: 'r1-session', overall_score: 90, recommendation: 'advance', created_at: '2026-03-01T00:00:00Z' };
  const SECRET = 'driver-detail postgres://u:p@10.0.0.5/db user@example.com';

  type CallSessionsStub = () => unknown;
  const throwsOnNot: CallSessionsStub = () => ({
    select: () => ({ not: () => { throw new TypeError(SECRET); } }),
  });
  const rejectsOnRange: CallSessionsStub = () => {
    const c: Record<string, unknown> = {};
    for (const m of ['select', 'not', 'order']) c[m] = () => c;
    c.range = () => Promise.reject(new Error(SECRET));
    return c;
  };

  function configureWithCallSessions(config: Record<string, unknown>, callSessions: CallSessionsStub): void {
    configure(config);
    const base = mockFrom.getMockImplementation() as (table: string) => unknown;
    mockFrom.mockImplementation((table: string) => (table === 'call_sessions' ? callSessions() : base(table)));
  }

  /** Runs `fn` while recording unhandled rejections and the lines logged at error level. */
  async function observed<T>(fn: () => Promise<T>): Promise<{ result: T; unhandled: unknown[]; logged: string[] }> {
    const unhandled: unknown[] = [];
    const onUnhandled = (reason: unknown) => { unhandled.push(reason); };
    const errorSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
    process.on('unhandledRejection', onUnhandled);
    try {
      const result = await fn();
      // An escaped rejection surfaces on a later turn of the event loop.
      await new Promise((resolve) => setImmediate(resolve));
      const logged = errorSpy.mock.calls.map((call) => String(call[0]));
      return { result, unhandled, logged };
    } finally {
      process.off('unhandledRejection', onUnhandled);
      errorSpy.mockRestore();
    }
  }

  const lookupLogs = (logged: string[]) => logged.filter((line) => line.includes('r1_session_exclusion_lookup'));

  it.each([
    ['a builder method that throws', throwsOnNot],
    ['a transport promise that rejects', rejectsOnRange],
  ] as const)('GET /api/candidates answers 503 and logs a sanitised line for %s', async (_name, stub) => {
    configureWithCallSessions({ candidates: ok([candidate('c-leak')]), assessments: ok([r1Row]) }, stub);
    const { result: res, unhandled, logged } = await observed(
      () => request(app()).get('/api/candidates').set('Authorization', AUTH).timeout(2000),
    );
    expect(unhandled).toEqual([]);
    expect(res.status).toBe(503);
    expect(res.body).toEqual({ error: 'service_unavailable' });
    // Nothing from the R1 row or the thrown value reached the response.
    expect(JSON.stringify(res.body)).not.toMatch(/advance|driver-detail|10\.0\.0\.5|example\.com/);

    const lines = lookupLogs(logged);
    expect(lines).toHaveLength(1);
    const entry = JSON.parse(lines[0] as string) as Record<string, unknown>;
    expect(entry).toMatchObject({
      level: 'error',
      component: 'candidates',
      event: 'db_error',
      error_category: 'r1_session_exclusion_lookup',
      error_type: 'lookup_threw',
    });
    // The thrown message, the connection string, the e-mail, the candidate and session ids are never logged.
    expect(lines[0]).not.toMatch(/driver-detail|postgres:|10\.0\.0\.5|user@example\.com|c-leak|r1-session/);
  });

  it('GET /api/candidates/summary answers 503 when the lookup throws', async () => {
    configureWithCallSessions(
      { candidates: ok([{ id: 'c1', decision_use_blocked_at: null }]), assessments: ok([r1Row]) },
      throwsOnNot,
    );
    const { result: res, unhandled } = await observed(
      () => request(app()).get('/api/candidates/summary').set('Authorization', AUTH).timeout(2000),
    );
    expect(unhandled).toEqual([]);
    expect(res.status).toBe(503);
    expect(res.body).toEqual({ error: 'service_unavailable' });
  });

  it('logs query_failed (an error result) and page_bound_exceeded (an incomplete set) with the same fixed category', async () => {
    configure({ candidates: ok([candidate('c3')]), assessments: ok([r1Row]), call_sessions: { data: null, error: { message: SECRET } } });
    const failed = await observed(() => request(app()).get('/api/candidates').set('Authorization', AUTH));
    expect(failed.result.status).toBe(503);
    const failedLines = lookupLogs(failed.logged);
    expect(failedLines).toHaveLength(1);
    expect(JSON.parse(failedLines[0] as string)).toMatchObject({ event: 'db_error', error_type: 'query_failed' });
    expect(failedLines[0]).not.toMatch(/driver-detail|postgres:|10\.0\.0\.5|user@example\.com/);

    configure({
      candidates: ok([candidate('c3')]),
      assessments: ok([r1Row]),
      call_sessions: () => ok(Array.from({ length: 1000 }, (_, i) => ({ id: `s-${i}` }))),
    });
    const bounded = await observed(() => request(app()).get('/api/candidates').set('Authorization', AUTH));
    expect(bounded.result.status).toBe(503);
    const boundedLines = lookupLogs(bounded.logged);
    expect(boundedLines).toHaveLength(1);
    expect(JSON.parse(boundedLines[0] as string)).toMatchObject({ event: 'db_error', error_type: 'page_bound_exceeded' });
  });

  it('logs nothing when the lookup succeeds', async () => {
    configure({ candidates: ok([candidate('c3')]), assessments: ok([r1Row]), call_sessions: ok([{ id: 'r1-session' }]) });
    const { result: res, logged } = await observed(() => request(app()).get('/api/candidates').set('Authorization', AUTH));
    expect(res.status).toBe(200);
    expect(lookupLogs(logged)).toEqual([]);
  });
});

describe('GET /api/candidates/summary: R1 assessments do not move the aggregate', () => {
  it('answers 503, never an unfiltered aggregate, when the R1 session lookup fails', async () => {
    configure({
      candidates: ok([{ id: 'c1', decision_use_blocked_at: null }]),
      assessments: ok([
        { candidate_id: 'c1', session_id: 'r1-a', overall_score: 100, recommendation: 'advance', created_at: '2026-03-01T00:00:00Z' },
      ]),
      call_sessions: { data: null, error: { message: 'down' } },
    });
    const res = await request(app()).get('/api/candidates/summary').set('Authorization', AUTH);
    expect(res.status).toBe(503);
    expect(res.body).toEqual({ error: 'service_unavailable' });
  });

  it('counts only phone assessments in the average and distribution', async () => {
    configure({
      candidates: ok([
        { id: 'c1', decision_use_blocked_at: null },
        { id: 'c2', decision_use_blocked_at: null },
      ]),
      assessments: ok([
        { candidate_id: 'c1', session_id: 'r1-a', overall_score: 100, recommendation: 'advance', created_at: '2026-03-01T00:00:00Z' },
        { candidate_id: 'c1', session_id: 'p-a', overall_score: 40, recommendation: 'reject', created_at: '2026-02-01T00:00:00Z' },
        { candidate_id: 'c2', session_id: 'r1-b', overall_score: 100, recommendation: 'advance', created_at: '2026-03-01T00:00:00Z' },
      ]),
      call_sessions: ok([{ id: 'r1-a' }, { id: 'r1-b' }]),
    });
    const res = await request(app()).get('/api/candidates/summary').set('Authorization', AUTH);
    expect(res.status).toBe(200);
    expect(res.body).toEqual({
      assessed_count: 1,
      average_score: 40,
      recommendation_distribution: { advance: 0, hold: 0, reject: 1 },
    });
  });
});
