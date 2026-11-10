/**
 * Scale guard (M026 root cause 1, fix point 2): the next unbatched read fails
 * here, in CI, and not in production.
 *
 * On 2026-11-04 the workspace passed about 390 candidates and the candidate
 * list and summary lost every score: one `.in()` over every candidate id built
 * a ~16 KB URL, Node's fetch (undici) rejected the echoed header
 * (UND_ERR_HEADERS_OVERFLOW), and the routes read the error as "no data".
 * PostgREST also cuts any response at 1000 rows without an error. Every check
 * the project ran used 26 candidates, so nothing saw either limit.
 *
 * This suite drives every route that reads over a list growing with the
 * workspace, against a workspace of 1,200 and of 5,000 candidates with
 * related rows in proportion (support/scale-workspace.ts), as admin and as
 * interviewer where the scope differs. The supabase double
 * (support/scale-db.ts) fails any `.in()` over ID_BATCH_SIZE (100) values
 * exactly as undici does, and truncates every response at 1000 rows.
 *
 * Each route must answer correctly with complete data, or fail closed with an
 * explicit error. Never silently partial: `expectNoSilentLimit` fails a test
 * whose route sent an oversized `.in()`, had a response cut by the row cap, or
 * stopped its own read at exactly the row cap with more rows left, even when
 * the route itself answered 200. A route that bounds a list on purpose answers
 * with a `truncated` flag, and its test asserts the flag.
 *
 * Every GET route of the app is either driven here (DRIVEN_ROUTES) or named
 * with the reason it is not (NOT_DRIVEN), and the suite ends by walking the
 * app's router stack: a new GET route fails CI until someone decides which.
 *
 * A read in a POST handler, a background loop or a route named in NOT_DRIVEN is
 * out of the walker's reach. So the suite also scans the API's source: an `.in()`
 * over a variable list fails CI unless it is a batch, or is named in
 * BOUNDED_LISTS with the reason it stays small.
 */
import { readdirSync, readFileSync } from 'node:fs';
import { dirname, join, relative, sep } from 'node:path';
import { fileURLToPath } from 'node:url';
import ts from 'typescript';
import { describe, it, expect, beforeAll, beforeEach, afterEach, vi } from 'vitest';
import express, { type Express } from 'express';
import request from 'supertest';
import { createApp } from '../app.js';
import { mockAuthGetUser, type AuthUser } from '../lib/auth.js';
import { ID_BATCH_CONCURRENCY, ID_BATCH_SIZE, POSTGREST_MAX_ROWS } from '../lib/id-batches.js';
import { scaleDb as engine, UNDICI_OVERFLOW_ERROR, type RecordedQuery, type Row } from './support/scale-db.js';
import {
  CALENDAR_FROM, CALENDAR_TO, FAILURES_FROM, FUNNEL_FROM, FUNNEL_TO, SCALE_ADMIN_ID, SCALE_INTERVIEWER_ID,
  scaleIds, scaleIso, seedScaleRounds, seedScaleWorkspace, type ScaleRounds, type ScaleWorkspace,
} from './support/scale-workspace.js';

vi.mock('../lib/supabase.js', async () => {
  const { scaleDb } = await import('./support/scale-db.js');
  return { supabase: scaleDb.client, RESUME_BUCKET: 'resumes_v2' };
});

const JWT = 'eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiJ1c2VyLTAwMSIsImFhbCI6ImFhbDIifQ.signature';

const admin: AuthUser = {
  id: SCALE_ADMIN_ID, email: 'admin@example.com', aal: 'aal2', active: true, appRole: 'admin',
  orgId: 'org-0000-0000-0000-000000000001',
};
const interviewer: AuthUser = { ...admin, id: SCALE_INTERVIEWER_ID, email: 'interviewer@example.com', appRole: 'interviewer' };

const SIZES = [1200, 5000] as const;

/**
 * Explicit limits, so a busy CI runner cannot turn the guard flaky: vitest's
 * defaults are 5 s a test and 10 s a hook, and the 5,000-candidate cases work
 * through about 40k rows. A route that really hangs still fails, at the request
 * limit, which sits below the test limit so it reports as what it is.
 */
const TEST_TIMEOUT_MS = 60_000;
const HOOK_TIMEOUT_MS = 60_000;
const REQUEST_TIMEOUT_MS = 45_000;

function appFor(user: AuthUser) {
  return createApp({
    nodeEnv: 'test',
    webOrigin: 'http://localhost:5173',
    authDeps: { getUser: mockAuthGetUser(user, JWT) },
    auditSinkOverride: async () => {},
  });
}

/** Every path this suite really requested, for the inventory at the end. */
const requested = new Set<string>();

const get = (path: string, user: AuthUser) => {
  requested.add(path.split('?')[0]);
  return request(appFor(user)).get(path).set('Authorization', `Bearer ${JWT}`).timeout(REQUEST_TIMEOUT_MS);
};

const label = (q: RecordedQuery): string =>
  `${q.table}: ${q.inValues ? `in(${q.inValues.length} values)` : 'no in()'}, matched ${q.matched}, returned ${q.returned}`;

/**
 * The guard: no read went past the id batch size, none was cut by the row cap,
 * none stopped itself at the row cap with rows left, the double modelled every
 * call. `reportsCut` names the tables whose route states such a stop in its own
 * answer; the test must assert that flag.
 */
function expectNoSilentLimit(reportsCut: readonly string[] = []): void {
  expect(engine.unsupported, 'builder methods the test double does not model').toEqual([]);
  expect(engine.overflows().map(label), `reads over more than ${ID_BATCH_SIZE} ids (undici refuses past ~390)`).toEqual([]);
  expect(engine.truncations().map(label), `reads cut at ${POSTGREST_MAX_ROWS} rows with no error`).toEqual([]);
  expect(
    engine.selfCaps().filter((q) => !reportsCut.includes(q.table)).map(label),
    `reads that stop at exactly ${POSTGREST_MAX_ROWS} rows with more matched and no next page`,
  ).toEqual([]);
}

beforeEach(() => {
  engine.reset({ overflowAt: ID_BATCH_SIZE });
  // Rows a read's ORDER BY leaves tied come back in a different order per read,
  // as Postgres may answer them, so a paged read with no total order skips and
  // repeats rows here too.
  engine.scrambleTies = true;
  vi.stubEnv('PHONE_SCREENING_ENABLED', 'true');
  vi.spyOn(console, 'error').mockImplementation(() => {});
  vi.spyOn(console, 'warn').mockImplementation(() => {});
}, HOOK_TIMEOUT_MS);

afterEach(() => {
  vi.unstubAllEnvs();
  vi.restoreAllMocks();
}, HOOK_TIMEOUT_MS);

/** The slice of a PostgREST builder the guard's self-checks call. */
interface Chain extends PromiseLike<{ data: unknown; error: unknown }> {
  select(columns: string): Chain;
  in(column: string, values: unknown[]): Chain;
  [method: string]: unknown;
}
const from = (table: string): Chain => engine.client.from(table) as Chain;

describe('the guard itself', () => {
  it('refuses an .in() over the batch size exactly as undici does, and records it', async () => {
    engine.tables.candidates = Array.from({ length: ID_BATCH_SIZE + 1 }, (_, i) => ({ id: scaleIds.candidate(i) }));
    const ids = engine.tables.candidates.map((r) => r.id);
    expect(await from('candidates').select('id').in('id', ids)).toMatchObject({ data: null, error: UNDICI_OVERFLOW_ERROR });
    const within = await from('candidates').select('id').in('id', ids.slice(0, ID_BATCH_SIZE));
    expect(within.data).toHaveLength(ID_BATCH_SIZE);
    expect(engine.overflows()).toHaveLength(1);
  });

  it('cuts a long response at 1000 rows with no error, and records the cut', async () => {
    engine.tables.candidates = Array.from({ length: POSTGREST_MAX_ROWS + 1 }, (_, i) => ({ id: scaleIds.candidate(i) }));
    const res = await from('candidates').select('id');
    expect(res.error).toBeNull();
    expect(res.data).toHaveLength(POSTGREST_MAX_ROWS);
    expect(engine.truncations()).toHaveLength(1);
  });

  it('records a builder method it does not model instead of ignoring it', () => {
    const q = from('candidates').select('id');
    expect(() => (q.textSearch as () => void)()).toThrow(/not modelled/);
    expect(engine.unsupported).toEqual(['candidates.textSearch']);
  });

  it('answers each page of an unordered read in its own order, so paging one skips and repeats rows', async () => {
    engine.tables.candidates = Array.from({ length: POSTGREST_MAX_ROWS * 2 }, (_, i) => ({ id: scaleIds.candidate(i) }));
    const readBoth = async (order: boolean): Promise<Set<unknown>> => {
      const seen = new Set<unknown>();
      for (const first of [0, POSTGREST_MAX_ROWS]) {
        const q = from('candidates').select('id');
        const paged = (order ? (q.order as (c: string) => Chain)('id') : q).range as (a: number, b: number) => PromiseLike<{ data: Row[] }>;
        for (const row of (await paged(first, first + POSTGREST_MAX_ROWS - 1)).data) seen.add(row.id);
      }
      return seen;
    };
    expect((await readBoth(false)).size).toBeLessThan(POSTGREST_MAX_ROWS * 2);
    expect((await readBoth(true)).size).toBe(POSTGREST_MAX_ROWS * 2);
  });

  describe('a read that stops itself at the row cap', () => {
    const page = (first: number) => (from('candidates').select('id').range as (a: number, b: number) => PromiseLike<unknown>)(first, first + POSTGREST_MAX_ROWS - 1);

    beforeEach(() => {
      engine.tables.candidates = Array.from({ length: POSTGREST_MAX_ROWS * 2 + 5 }, (_, i) => ({ id: scaleIds.candidate(i) }));
    });

    it('is recorded for .limit(1000), which the row cap itself never cuts', async () => {
      await (from('candidates').select('id').limit as (n: number) => PromiseLike<unknown>)(POSTGREST_MAX_ROWS);
      expect(engine.truncations()).toEqual([]);
      expect(engine.selfCaps()).toHaveLength(1);
    });

    it('is recorded for one .range(0, 999) that never reads the next page', async () => {
      await page(0);
      expect(engine.truncations()).toEqual([]);
      expect(engine.selfCaps()).toHaveLength(1);
    });

    it('is recorded when paging stops early, naming the last page read', async () => {
      await page(0);
      await page(POSTGREST_MAX_ROWS);
      expect(engine.selfCaps().map((q) => q.range)).toEqual([[POSTGREST_MAX_ROWS, POSTGREST_MAX_ROWS * 2 - 1]]);
    });

    it('is not recorded for a read paged to its short last page', async () => {
      for (const first of [0, POSTGREST_MAX_ROWS, POSTGREST_MAX_ROWS * 2]) await page(first);
      expect(engine.selfCaps()).toEqual([]);
    });

    it('is not recorded when the page holds everything that matched', async () => {
      engine.tables.candidates.length = POSTGREST_MAX_ROWS;
      await (from('candidates').select('id').limit as (n: number) => PromiseLike<unknown>)(POSTGREST_MAX_ROWS);
      expect(engine.selfCaps()).toEqual([]);
    });
  });
});

describe.each(SIZES)('a workspace of %i candidates', { timeout: TEST_TIMEOUT_MS }, (n) => {
  let ws: ScaleWorkspace;
  // Built once for the block. Each case gets its own copy after the top-level
  // beforeEach's engine.reset(), so nothing one case does reaches the next.
  let snapshot: Record<string, Row[]>;
  beforeAll(() => {
    snapshot = {};
    ws = seedScaleWorkspace(snapshot, n);
  }, HOOK_TIMEOUT_MS);
  beforeEach(() => {
    Object.assign(engine.tables, structuredClone(snapshot));
  }, HOOK_TIMEOUT_MS);

  describe('GET /api/candidates', () => {
    it('as admin: every candidate, with every score, resume state and dial count', async () => {
      const res = await get('/api/candidates', admin);
      expect(res.status).toBe(200);
      const body = res.body as Row[];
      expect(body).toHaveLength(n);
      expect(new Set(body.map((c) => c.id)).size).toBe(n);
      const scored = body.filter((c) => c.latest_score != null);
      expect(scored).toHaveLength(ws.latest.size);
      for (const c of scored) {
        const want = ws.latest.get(c.id as string)!;
        expect({ score: c.latest_score, recommendation: c.latest_recommendation }).toEqual(want);
      }
      expect(body.every((c) => c.resume_review === 'ready' && c.intake_type === 'resume_parsing')).toBe(true);
      expect(body.every((c) => c.ashby_job_status === 'enabled')).toBe(true);
      expect(body.every((c) => c.dial_count === 1)).toBe(true);
      expectNoSilentLimit();
    });

    it('as interviewer: exactly the candidates they own, complete', async () => {
      const res = await get('/api/candidates', interviewer);
      expect(res.status).toBe(200);
      const body = res.body as Row[];
      expect(body).toHaveLength(ws.owned.size);
      expect(body.every((c) => ws.owned.has(c.id as string))).toBe(true);
      const ownedScored = [...ws.latest.keys()].filter((id) => ws.owned.has(id));
      expect(body.filter((c) => c.latest_score != null)).toHaveLength(ownedScored.length);
      expect(body.every((c) => c.dial_count === 1 && c.resume_review === 'ready')).toBe(true);
      expectNoSilentLimit();
    });
  });

  describe('GET /api/candidates/summary', () => {
    const expected = (ids: string[]) => {
      const dist = { advance: 0, hold: 0, reject: 0 } as Record<string, number>;
      let sum = 0;
      for (const id of ids) { const l = ws.latest.get(id)!; dist[l.recommendation] += 1; sum += l.score; }
      return { assessed_count: ids.length, average_score: Math.round((sum / ids.length) * 10) / 10, recommendation_distribution: dist };
    };

    it('as admin: counts every assessed candidate', async () => {
      const res = await get('/api/candidates/summary', admin);
      expect(res.status).toBe(200);
      expect(res.body).toEqual(expected([...ws.latest.keys()]));
      expectNoSilentLimit();
    });

    it('as interviewer: counts every assessed candidate they own', async () => {
      const res = await get('/api/candidates/summary', interviewer);
      expect(res.status).toBe(200);
      expect(res.body).toEqual(expected([...ws.latest.keys()].filter((id) => ws.owned.has(id))));
      expectNoSilentLimit();
    });
  });

  describe('GET /api/notifications', () => {
    it('as admin: the newest 100 intents of the workspace, newest first', async () => {
      const res = await get('/api/notifications', admin);
      expect(res.status).toBe(200);
      expect((res.body.intents as Row[]).map((i) => i.id)).toEqual(ws.intentsNewestFirst.slice(0, 100).map((i) => i.id));
      expectNoSilentLimit();
    });

    it('as interviewer: the newest 100 intents across EVERY candidate they own, newest first', async () => {
      const res = await get('/api/notifications', interviewer);
      expect(res.status).toBe(200);
      const want = ws.intentsNewestFirst.filter((i) => ws.owned.has(i.candidate_id)).slice(0, 100);
      expect((res.body.intents as Row[]).map((i) => i.id)).toEqual(want.map((i) => i.id));
      expectNoSilentLimit();
    });

    it('as interviewer: fails the request, never a partial list, when one batch of intents fails', async () => {
      const oldest = scaleIds.candidate(0);
      engine.failWhen = (q) => q.table === 'notification_intents' && (q.inValues ?? []).includes(oldest);
      const res = await get('/api/notifications', interviewer);
      expect(res.status).toBeGreaterThanOrEqual(500);
      expect(res.body.intents).toBeUndefined();
    });

    it('as interviewer: starts no new batch once one has failed', async () => {
      engine.failWhen = (q) => q.table === 'notification_intents';
      const res = await get('/api/notifications', interviewer);
      expect(res.status).toBeGreaterThanOrEqual(500);
      // In production each failed batch costs about 8 s of postgrest-js retries.
      expect(ws.owned.size).toBeGreaterThan(ID_BATCH_SIZE * ID_BATCH_CONCURRENCY);
      expect(engine.queries.filter((q) => q.table === 'notification_intents').length).toBeLessThanOrEqual(ID_BATCH_CONCURRENCY);
    });
  });

  describe('GET /api/admin/sessions', () => {
    it('one page, most recently updated first, and it says more sessions exist', async () => {
      const res = await get('/api/admin/sessions', admin);
      expect(res.status).toBe(200);
      const rows = res.body.sessions as Row[];
      expect(rows).toHaveLength(100);
      expect(res.body.truncated).toBe(true);
      expect(new Set(rows.map((s) => s.id)).size).toBe(100);
      expect(rows[0].id).toBe(scaleIds.session(n - 1));
      expectNoSilentLimit();
    });

    it('a status filter pages the same way, and an empty answer is not called cut', async () => {
      const completed = await get('/api/admin/sessions?status=completed', admin);
      expect(completed.status).toBe(200);
      expect(completed.body.sessions).toHaveLength(100);
      expect(completed.body.truncated).toBe(true);
      expect((completed.body.sessions as Row[]).every((s) => s.status === 'completed')).toBe(true);
      const cancelled = await get('/api/admin/sessions?status=cancelled', admin);
      expect(cancelled.body).toEqual({ sessions: [], truncated: false });
      expectNoSilentLimit();
    });
  });

  describe('GET the funnel summary over a year', () => {
    const query = `?from=${FUNNEL_FROM}&to=${FUNNEL_TO}`;

    it.each([
      ['/api/funnel/summary', 'interviewer'],
      ['/api/admin/funnel/summary', 'admin'],
    ] as const)('%s as %s: totals over every rollup row in the window', async (path, who) => {
      const res = await get(`${path}${query}`, who === 'admin' ? admin : interviewer);
      expect(res.status).toBe(200);
      expect(res.body.totals.entered_parse).toBe(n);
      expect(res.body.totals.candidates_total).toBe(n);
      expect(res.body.series).toHaveLength(Math.min(n, 365));
      expect(res.body.meta.hr_tracking_configured).toBe(true);
      expectNoSilentLimit();
    });

    it('a rollup refresh committing between two page reads moves no total', async () => {
      // Each row its own count, so a row read twice and a row never read cannot cancel out.
      const rows = engine.tables.funnel_stage_daily;
      let want = 0;
      rows.forEach((r, k) => { r.entered_parse = k + 1; want += k + 1; });
      let refreshes = 0;
      engine.beforeExecute = (q) => {
        if (q.table !== 'funnel_stage_daily' || !q.range || q.range[0] === 0) return;
        // refresh_funnel_rollup deletes and reinserts: the same rows, all with new ids.
        refreshes += 1;
        rows.forEach((r, k) => { r.id = scaleIds.rollup(1_000_000 * refreshes + rows.length - k); });
      };
      const res = await get(`/api/funnel/summary${query}`, interviewer);
      expect(res.status).toBe(200);
      expect(refreshes, 'the summary read past one page').toBeGreaterThan(0);
      expect(res.body.totals.entered_parse).toBe(want);
      expectNoSilentLimit();
    });
  });

  describe('GET /api/admin/funnel/failures', () => {
    it('counts every failure in the window, or says plainly that it counted only the newest 1000', async () => {
      const res = await get(`/api/admin/funnel/failures?from=${FAILURES_FROM}&to=${FUNNEL_TO}`, admin);
      expect(res.status).toBe(200);
      const counted = (res.body.groups as Array<{ count: number }>).reduce((a, g) => a + g.count, 0);
      if (ws.failures >= POSTGREST_MAX_ROWS) {
        expect(res.body.truncated).toBe(true);
        expect(counted).toBe(POSTGREST_MAX_ROWS);
      } else {
        expect(res.body.truncated).toBe(false);
        expect(counted).toBe(ws.failures);
      }
      // The route stops its own read at 1000 and reports it in `truncated`, asserted above.
      expectNoSilentLimit(['v_funnel_failures']);
    });
  });

  describe('GET Ashby Mission Control lists: one page, and a stated cut', () => {
    // The page calls /workflows with no limit, so 50 is what an operator sees.
    it.each([
      ['as the page asks, with no limit', '', 50],
      ['at the largest page', '?limit=200', 200],
    ])('workflows %s: the newest rows, each with its session status and evidence hold, and truncated', async (_how, query, size) => {
      const res = await get(`/api/integrations/ashby/mission-control/workflows${query}`, interviewer);
      expect(res.status).toBe(200);
      const rows = res.body.workflows as Row[];
      expect(rows).toHaveLength(size);
      expect(res.body.truncated).toBe(true);
      expect(rows[0].applicationLinkId).toBe(scaleIds.link(n - 1));
      for (const row of rows) {
        const i = Number(String(row.applicationLinkId).slice(-12));
        expect(row.sessionStatus, `link ${i}`).toBe(i % 3 === 0 ? 'completed' : 'expired');
        expect(row.heldForEvidence, `link ${i}`).toBe(ws.heldForEvidence(i));
      }
      expectNoSilentLimit();
    });

    it('workflows when one batch of session statuses fails: only that batch is unknown, and the list stands', async () => {
      engine.failWhen = (q) => q.table === 'call_sessions' && (q.inValues ?? []).includes(scaleIds.session(n - 1));
      const res = await get('/api/integrations/ashby/mission-control/workflows?limit=200', interviewer);
      expect(res.status).toBe(200);
      const rows = res.body.workflows as Row[];
      expect(rows).toHaveLength(200);
      rows.forEach((row, at) => {
        const i = Number(String(row.applicationLinkId).slice(-12));
        expect(row.sessionId, `link ${i}`).toBe(scaleIds.session(i));
        expect(row.sessionStatus, `link ${i}`).toBe(at < ID_BATCH_SIZE ? null : i % 3 === 0 ? 'completed' : 'expired');
        expect(row.heldForEvidence, `link ${i}`).toBe(ws.heldForEvidence(i));
      });
      expectNoSilentLimit();
    });

    it('mappings at the default page: cut, and it says so', async () => {
      const res = await get('/api/integrations/ashby/mission-control/mappings', interviewer);
      expect(res.status).toBe(200);
      expect(res.body.mappings).toHaveLength(50);
      expect(res.body.truncated).toBe(true);
      expect(new Set(res.body.mappedJobIds as string[]).size).toBe(ws.mappings);
      expectNoSilentLimit();
    });

    it('mappings as the page asks, at the largest page: every live one, or a stated cut naming every mapped job', async () => {
      const res = await get('/api/integrations/ashby/mission-control/mappings?limit=200', interviewer);
      expect(res.status).toBe(200);
      expect(res.body.mappings).toHaveLength(Math.min(ws.mappings, 200));
      expect(res.body.truncated).toBe(ws.mappings > 200);
      if (ws.mappings > 200) {
        expect(new Set(res.body.mappedJobIds as string[])).toEqual(new Set(Array.from({ length: ws.mappings }, (_, m) => `job_${m}`)));
      } else {
        expect(res.body).not.toHaveProperty('mappedJobIds');
      }
      expectNoSilentLimit();
    });

    it('a cut mapping list names every live job past the row cap too, and no deleted one', async () => {
      const table = engine.tables.ashby_job_mappings;
      for (let m = ws.mappings; m < POSTGREST_MAX_ROWS + 5; m += 1) {
        table.push({ ...table[0], id: scaleIds.mapping(m), external_job_id: `job_${m}` });
      }
      table.push({ ...table[0], id: scaleIds.mapping(999_999), external_job_id: 'job_deleted', archived_at: scaleIso(0) });
      const res = await get('/api/integrations/ashby/mission-control/mappings?limit=200', interviewer);
      expect(res.status).toBe(200);
      expect(new Set(res.body.mappedJobIds as string[]).size).toBe(POSTGREST_MAX_ROWS + 5);
      expect(res.body.mappedJobIds).not.toContain('job_deleted');
      expectNoSilentLimit();
    });

    it('fails the cut mapping list, never one that offers a mapped job as free, when the job read fails', async () => {
      engine.failWhen = (q) => q.table === 'ashby_job_mappings' && q.range !== null;
      const res = await get('/api/integrations/ashby/mission-control/mappings', interviewer);
      expect(res.status).toBe(500);
      expect(res.body).toEqual({ ok: false, error: 'mission_control_read_error' });
    });
  });

  describe('GET /api/interview-rounds', () => {
    const PAGE = 50;
    let rounds: ScaleRounds;

    beforeEach(() => {
      rounds = seedScaleRounds(engine.tables, n);
    }, HOOK_TIMEOUT_MS);

    /** The rounds an interviewer owns: their candidates are the even ones. */
    const ownedOnly = (ids: readonly string[]): string[] => ids.filter((id) => Number(id.slice(-12)) % 2 === 0);

    /** Every page of a view, in order. */
    async function walk(query: string, user: AuthUser): Promise<{ ids: string[]; total: number }> {
      const ids: string[] = [];
      let total = 0;
      for (let page = 1; ; page += 1) {
        const res = await get(`/api/interview-rounds?${query}&page_size=${PAGE}&page=${page}`, user);
        expect(res.status).toBe(200);
        total = res.body.total as number;
        const rows = res.body.rounds as Row[];
        ids.push(...rows.map((row) => row.id as string));
        if (page * PAGE >= total) return { ids, total };
      }
    }

    it('as admin: the first page of To review is the oldest, with its true total, and every row complete', async () => {
      const res = await get('/api/interview-rounds', admin);
      expect(res.status).toBe(200);
      expect(res.body.total).toBe(rounds.toReview.length);
      const rows = res.body.rounds as Array<Row & { attempts: Row[] }>;
      expect(rows.map((row) => row.id)).toEqual(rounds.toReview.slice(0, 25));
      expect(rows.every((row) => row.attempts.length === 1 && (row.attempts[0].recording as Row).state === 'ready')).toBe(true);
      expectNoSilentLimit();
    });

    it('as admin: every view counts every round, past the row cap', async () => {
      expect(rounds.all.length).toBeGreaterThan(POSTGREST_MAX_ROWS);
      for (const [view, ids] of [['in-progress', rounds.inProgress], ['reviewed', rounds.reviewed], ['all', rounds.all]] as const) {
        const res = await get(`/api/interview-rounds?view=${view}`, admin);
        expect(res.status).toBe(200);
        expect(res.body.total, view).toBe(ids.length);
      }
      expectNoSilentLimit();
    });

    it('as interviewer: walks every page of exactly the rounds they own, each once, in order', async () => {
      const want = ownedOnly(rounds.toReview);
      const { ids, total } = await walk('view=to-review', interviewer);
      expect(total).toBe(want.length);
      expect(ids).toEqual(want);
      expectNoSilentLimit();
    });

    it('as admin: paging from the newest never skips or repeats a round, however ties are answered', async () => {
      const { ids, total } = await walk('view=reviewed', admin);
      expect(total).toBe(rounds.reviewed.length);
      expect(ids).toEqual([...rounds.reviewed].reverse());
      expectNoSilentLimit();
    });

    describe('searched by name, which goes in a body and in no URL', () => {
      const search = (q: string, query: string, user: AuthUser) => request(appFor(user))
        .post(`/api/interview-rounds/search${query}`)
        .set('Authorization', `Bearer ${JWT}`)
        .timeout(REQUEST_TIMEOUT_MS)
        .send({ q });

      it('finds the last round its read of the view reaches, past the row cap', async () => {
        // Newest first, so the oldest round is the last row of the last page.
        const res = await search('Candidate 0', '?view=all', admin);
        expect(res.status).toBe(200);
        expect(res.body.total).toBe(1);
        expect((res.body.rounds as Row[]).map((row) => row.id)).toEqual([rounds.all[0]]);
        expect(engine.queries.filter((q) => q.table === 'interview_rounds').length).toBe(Math.floor(rounds.all.length / POSTGREST_MAX_ROWS) + 1);
        expectNoSilentLimit();
      });

      it('as interviewer: counts and pages exactly the rounds they own', async () => {
        const want = ownedOnly(rounds.toReview);
        const first = await search('Candidate', `?page_size=${PAGE}`, interviewer);
        expect(first.body.total).toBe(want.length);
        expect((first.body.rounds as Row[]).map((row) => row.id)).toEqual(want.slice(0, PAGE));
        const second = await search('Candidate', `?page_size=${PAGE}&page=2`, interviewer);
        expect((second.body.rounds as Row[]).map((row) => row.id)).toEqual(want.slice(PAGE, PAGE * 2));
        expectNoSilentLimit();
      });

      it('as viewer: reads through the real app, whose guard refuses any other POST', async () => {
        const viewer: AuthUser = { ...admin, appRole: 'viewer' };
        expect((await search('Candidate 0', '?view=all', viewer)).status).toBe(200);
        const write = await request(appFor(viewer)).post(`/api/interview-rounds/${rounds.all[0]}/cancel`).set('Authorization', `Bearer ${JWT}`).send({});
        expect(write.status).toBe(403);
      });

      it('counts a round once when another is sent between two reads of the view', async () => {
        let sent = false;
        engine.beforeExecute = (q) => {
          if (sent || q.table !== 'interview_rounds' || q.range?.[0] !== POSTGREST_MAX_ROWS) return;
          sent = true;
          const table = engine.tables.interview_rounds;
          table.push({ ...table[0], id: scaleIds.round(999_999), created_at: '2099-01-01T00:00:00.000Z' });
        };
        const res = await search('Candidate', '?view=all', admin);
        expect(sent, 'the read went past one page').toBe(true);
        expect(res.body.total).toBe(rounds.all.length);
        expectNoSilentLimit();
      });

      it('fails, never a partial search, when a later read of the view fails', async () => {
        engine.failWhen = (q) => q.table === 'interview_rounds' && q.range?.[0] === POSTGREST_MAX_ROWS;
        const res = await search('Candidate', '?view=all', admin);
        expect(res.status).toBe(503);
        expect(res.body).toEqual({ error: 'service_unavailable' });
      });
    });

    it('costs the same few reads for any page, never one per round', async () => {
      const res = await get('/api/interview-rounds?view=all&page_size=50', admin);
      expect(res.status).toBe(200);
      expect(res.body.rounds).toHaveLength(50);
      const reads = engine.queries.map((q) => q.table).sort();
      expect(reads).toEqual(['call_sessions', 'interview_round_attempts', 'interview_round_consents', 'interview_round_recordings', 'interview_rounds']);
      expectNoSilentLimit();
    });

    it.each(['interview_round_attempts', 'interview_round_recordings', 'call_sessions', 'interview_round_consents'])(
      'fails the page, never a partial row, when %s fails',
      async (table) => {
        engine.failWhen = (q) => q.table === table;
        const res = await get('/api/interview-rounds', admin);
        expect(res.status).toBe(503);
        expect(res.body).toEqual({ error: 'service_unavailable' });
      },
    );
  });

  describe('GET /api/phone/calendar (30 days)', () => {
    it('every appointment shown carries its engagement and candidate, and a cut list says so', async () => {
      const res = await get(`/api/phone/calendar?from=${CALENDAR_FROM}&to=${CALENDAR_TO}`, interviewer);
      expect(res.status).toBe(200);
      const shown = Math.min(ws.appointments, 200);
      expect(res.body.count).toBe(shown);
      expect(res.body.truncated).toBe(ws.appointments > 200);
      for (const a of res.body.appointments as Array<Row & { candidate: Row | null }>) {
        const i = Number(String(a.id).slice(-12));
        expect(a.engagement_state, `appointment ${i}`).toBe('completed');
        expect(a.candidate?.id, `appointment ${i}`).toBe(scaleIds.candidate(i));
      }
      expectNoSilentLimit();
    });

    it.each(['phone_engagements', 'candidates'])('fails the request, never a partial calendar, when one batch of %s fails', async (table) => {
      let batches = 0;
      engine.failWhen = (q) => q.table === table && (batches += 1) === 2;
      const res = await get(`/api/phone/calendar?from=${CALENDAR_FROM}&to=${CALENDAR_TO}`, interviewer);
      expect(batches, 'the calendar read this table in at least two batches').toBeGreaterThanOrEqual(2);
      expect(res.status).toBe(500);
      expect(res.body).toEqual({ ok: false, error: 'phone_read_error' });
    });
  });
});

describe('GET the funnel summary when HR tracking was observed on one late mapping only', { timeout: TEST_TIMEOUT_MS }, () => {
  const summary = () => get(`/api/funnel/summary?from=${FUNNEL_FROM}&to=${FUNNEL_TO}`, interviewer);
  let ws: ScaleWorkspace;

  beforeEach(() => {
    ws = seedScaleWorkspace(engine.tables, 5000);
    for (const link of engine.tables.ashby_application_links) {
      link.stage_synced_at = null;
      link.external_stage_id = null;
    }
  });

  it('finds it past the 200th mapping, so the dashboard never says "Not tracked yet" over live tracking', async () => {
    const late = 230;
    expect(ws.mappings).toBeGreaterThan(late);
    const link = engine.tables.ashby_application_links.find((l) => l.job_mapping_id === scaleIds.mapping(late))!;
    link.stage_synced_at = scaleIso(late);
    link.external_stage_id = `stage_ref_${late}`;
    const res = await summary();
    expect(res.status).toBe(200);
    expect(res.body.meta.hr_tracking_configured).toBe(true);
    expectNoSilentLimit();
  });

  it('answers false only after asking about every mapping', async () => {
    const res = await summary();
    expect(res.status).toBe(200);
    expect(res.body.meta.hr_tracking_configured).toBe(false);
    const asked = engine.queries
      .filter((q) => q.table === 'ashby_application_links')
      .flatMap((q) => q.inValues ?? []);
    expect(new Set(asked).size).toBe(ws.mappings);
    expectNoSilentLimit();
  });
});

describe('GET Mission Control workflows when an evidence read reaches the row cap', { timeout: TEST_TIMEOUT_MS }, () => {
  it('reports every hold as unreadable (null), never as "not held", and keeps the list', async () => {
    seedScaleWorkspace(engine.tables, 1200);
    // Link 1199 is on the newest page and parked; give its session 1000 rescores.
    for (let k = 0; k < POSTGREST_MAX_ROWS; k += 1) {
      engine.tables.assessments.push({
        id: `ac000000-0000-4000-8000-${String(k).padStart(12, '0')}`, candidate_id: scaleIds.candidate(1199),
        session_id: scaleIds.session(1199), overall_score: 50, recommendation: 'hold', evidence_grade: 'decision',
        created_at: scaleIso(1199, k), source: 'phone',
      });
    }
    const res = await get('/api/integrations/ashby/mission-control/workflows?limit=200', interviewer);
    expect(res.status).toBe(200);
    const rows = res.body.workflows as Row[];
    expect(rows).toHaveLength(200);
    for (const row of rows) {
      const i = Number(String(row.applicationLinkId).slice(-12));
      // Only parked links are examined; a link that is not parked is not held.
      expect(row.heldForEvidence, `link ${i}`).toBe(i % 4 === 0 ? false : null);
      expect(typeof row.sessionStatus, `link ${i}`).toBe('string');
    }
    expect(engine.overflows()).toEqual([]);
  });
});

describe('GET /api/export/:candidateId/csv for a candidate with a long history', { timeout: TEST_TIMEOUT_MS }, () => {
  // Fifteen screening sessions of 80 turns: 1,200 transcript rows, past the row cap.
  const SESSIONS = 15;
  const TURNS = 80;
  const candidate = scaleIds.candidate(7);
  // Another owner's candidate, whose rows sit in the same tables.
  const someoneElse = scaleIds.candidate(8);
  const theirSessions = [900, 901, 902].map((s) => scaleIds.session(s));
  const theirAssessments = [900, 901, 902].map((s) => scaleIds.assessment(s));

  beforeEach(() => {
    engine.tables.candidates = [
      { id: candidate, owner_id: SCALE_INTERVIEWER_ID, status: 'screened' },
      { id: someoneElse, owner_id: SCALE_ADMIN_ID, status: 'screened' },
    ];
    engine.tables.assessments = [];
    engine.tables.call_sessions = [];
    engine.tables.transcript_turns = [];
    for (let s = 0; s < SESSIONS; s += 1) {
      const session = scaleIds.session(s);
      engine.tables.call_sessions.push({ id: session, candidate_id: candidate, created_at: scaleIso(s) });
      engine.tables.assessments.push({
        id: scaleIds.assessment(s), candidate_id: candidate, session_id: session, overall_score: 50 + s,
        recommendation: 'hold', created_at: scaleIso(s, 30), schema_version: 1,
      });
      // Stored newest turn first, so storage order cannot stand in for the read's ORDER BY.
      for (let k = TURNS - 1; k >= 0; k -= 1) {
        engine.tables.transcript_turns.push({
          session_id: session, turn_index: k, speaker: k % 2 === 0 ? 'bot' : 'candidate', text: `s${s} t${k}`, created_at: scaleIso(s, k),
        });
      }
    }
    theirSessions.forEach((session, s) => {
      engine.tables.call_sessions.push({ id: session, candidate_id: someoneElse, created_at: scaleIso(s) });
      engine.tables.assessments.push({
        id: theirAssessments[s], candidate_id: someoneElse, session_id: session, overall_score: 11,
        recommendation: 'reject', created_at: scaleIso(s, 30), schema_version: 1,
      });
      engine.tables.transcript_turns.push({ session_id: session, turn_index: 0, speaker: 'candidate', text: `their turn ${s}`, created_at: scaleIso(s) });
    });
  });

  const rowsOf = (csv: string, type: string) => csv.split('\r\n').filter((l) => l.startsWith(`${type},`));

  it.each([['admin', admin], ['the owning interviewer', interviewer]] as const)('as %s: nothing of any other candidate', async (_who, user) => {
    const res = await get(`/api/export/${candidate}/csv`, user);
    expect(res.status).toBe(200);
    expect(rowsOf(res.text, 'scorecard')).toHaveLength(SESSIONS);
    expect(rowsOf(res.text, 'transcript')).toHaveLength(SESSIONS * TURNS);
    for (const foreign of [someoneElse, ...theirSessions, ...theirAssessments, 'their turn']) {
      expect(res.text).not.toContain(foreign);
    }
  });

  it.each([['admin', admin], ['the owning interviewer', interviewer]] as const)('as %s: every scorecard and every transcript turn, in order', async (_who, user) => {
    const res = await get(`/api/export/${candidate}/csv`, user);
    expect(res.status).toBe(200);
    expect(rowsOf(res.text, 'scorecard')).toHaveLength(SESSIONS);
    const turns = rowsOf(res.text, 'transcript');
    expect(turns).toHaveLength(SESSIONS * TURNS);
    // Session order, then turn order: the first session's turns 0..79 come first.
    expect(turns[0]).toContain('s0 t0');
    expect(turns[TURNS - 1]).toContain(`s0 t${TURNS - 1}`);
    expect(turns.at(-1)).toContain(`s${SESSIONS - 1} t${TURNS - 1}`);
    expectNoSilentLimit();
  });

  it('orders the transcript by session created_at, not session uuid, across id batches, with the id breaking a tie', async () => {
    // Two id batches of sessions. A higher uuid is an OLDER session, so uuid
    // order is the reverse of created_at order; sessions 0 and 1 share a created_at.
    const count = ID_BATCH_SIZE + 20;
    engine.tables.call_sessions = [];
    engine.tables.transcript_turns = [];
    for (let s = 0; s < count; s += 1) {
      const session = scaleIds.session(s);
      engine.tables.call_sessions.push({ id: session, candidate_id: candidate, created_at: scaleIso(count - Math.max(s, 1)) });
      for (let k = 1; k >= 0; k -= 1) {
        engine.tables.transcript_turns.push({ session_id: session, turn_index: k, speaker: 'bot', text: `s${s} t${k}`, created_at: scaleIso(s, k) });
      }
    }

    const res = await get(`/api/export/${candidate}/csv`, admin);
    expect(res.status).toBe(200);
    const sessionAndTurn = rowsOf(res.text, 'transcript').map((line) => {
      const cells = line.split(',');
      return `${cells[3]} turn ${cells[5]}`;
    });
    const oldestFirst = [...Array.from({ length: count - 2 }, (_, i) => count - 1 - i), 0, 1];
    expect(sessionAndTurn).toEqual(oldestFirst.flatMap((s) => [`${scaleIds.session(s)} turn 0`, `${scaleIds.session(s)} turn 1`]));
    expectNoSilentLimit();
  });

  it('fails the export, rather than sending a CSV without its transcript, when a transcript read fails', async () => {
    engine.failWhen = (q) => q.table === 'transcript_turns';
    const res = await get(`/api/export/${candidate}/csv`, admin);
    expect(res.status).toBeGreaterThanOrEqual(500);
    expect(res.text).not.toContain('scorecard,');
  });

  it('fails the export, rather than sending scorecards with no transcript, when the session read fails', async () => {
    engine.failWhen = (q) => q.table === 'call_sessions';
    const res = await get(`/api/export/${candidate}/csv`, admin);
    expect(res.status).toBeGreaterThanOrEqual(500);
    expect(res.text).not.toContain('scorecard,');
  });

  it('fails the export when the scorecard read fails', async () => {
    engine.failWhen = (q) => q.table === 'assessments';
    const res = await get(`/api/export/${candidate}/csv`, admin);
    expect(res.status).toBeGreaterThanOrEqual(500);
  });
});

// ── The inventory: a new GET route cannot skip the guard unnoticed ────────────

/** Routes above, each of which reads over a list that grows with the workspace. */
const DRIVEN_ROUTES = [
  '/api/admin/funnel/failures',
  '/api/admin/funnel/summary',
  '/api/admin/sessions',
  '/api/candidates',
  '/api/candidates/summary',
  '/api/export/:candidateId/csv',
  '/api/funnel/summary',
  '/api/integrations/ashby/mission-control/mappings',
  '/api/integrations/ashby/mission-control/workflows',
  '/api/interview-rounds',
  '/api/notifications',
  '/api/phone/calendar',
];

const ONE_CANDIDATE = "bounded by one candidate's history, not the workspace";
const ONE_RECORD = 'reads one record, or one configuration singleton, by key';
const CLIENT_PAGED = "each request is one explicit .range() page at the client's offset";
const COUNTS_ONLY = 'head counts and one-row lookups, over constant lists of states and queue names';
const NO_DB_LIST = 'no read that grows with the workspace';
const STAFF_SIZED = 'grows with staff or configuration, not candidates';
const ASHBY_READ = 'a live Ashby read, walked and bounded by the probe; no database list';

/**
 * Every other GET route, and why this suite does not drive it. Add a route here
 * only with a reason that holds at 5,000 candidates: if it reads over a list
 * that grows with the workspace, drive it above instead.
 */
const NOT_DRIVEN: Record<string, string> = {
  '/api/admin/allowlist': STAFF_SIZED,
  '/api/admin/audit': CLIENT_PAGED,
  '/api/admin/funnel/candidates': CLIENT_PAGED,
  '/api/admin/members': STAFF_SIZED,
  '/api/admin/quotas': STAFF_SIZED,
  '/api/admin/r1/recording-health': COUNTS_ONLY,
  '/api/admin/r1/settings': ONE_RECORD,
  '/api/admin/r1/usage': ONE_RECORD,
  '/api/appeals': ONE_CANDIDATE,
  '/api/candidate-consent/template': ONE_RECORD,
  '/api/candidates/:id': ONE_CANDIDATE,
  '/api/candidates/:id/ashby-workflow': ONE_CANDIDATE,
  '/api/candidates/:id/interview-rounds': ONE_CANDIDATE,
  '/api/candidates/:id/phone-attempts': ONE_CANDIDATE,
  '/api/candidates/:id/phone-cycles': ONE_CANDIDATE,
  '/api/consent/:candidateId/status': ONE_CANDIDATE,
  '/api/consent/templates': STAFF_SIZED,
  // With include_export: one data subject. lib/dsar.ts reads transcript_turns by
  // a column that table does not have (0001_init.sql): a defect of its own, not of scale.
  '/api/dsar/:dsarId': ONE_CANDIDATE,
  '/api/dsar/candidate/:candidateId': ONE_CANDIDATE,
  '/api/dsar/legal-holds/:holdId': ONE_RECORD,
  '/api/dsar/legal-holds/check': ONE_RECORD,
  '/api/health': NO_DB_LIST,
  '/api/integrations/ashby/mission-control/access-check':
    'at most 51 enabled mappings and one link, then at most 24 live Ashby reads under one deadline (5 job plans, 5 stage lists, one history page per application)',
  '/api/integrations/ashby/mission-control/health': COUNTS_ONLY,
  '/api/integrations/ashby/mission-control/jobs': ASHBY_READ,
  '/api/integrations/ashby/mission-control/jobs/:externalJobId/feedback-form': ASHBY_READ,
  '/api/integrations/ashby/mission-control/jobs/:externalJobId/stages': ASHBY_READ,
  '/api/integrations/ashby/mission-control/mappings/:id/scorecard-binding': ONE_RECORD,
  '/api/integrations/ashby/review/:applicationLinkId': ONE_CANDIDATE,
  '/api/integrations/ashby/review/:applicationLinkId/notes': ONE_CANDIDATE,
  '/api/integrations/ashby/review/:applicationLinkId/workflow': ONE_CANDIDATE,
  '/api/internal/phone/attempt/:attemptId/answered': ONE_RECORD,
  '/api/interview-rounds/:id/recording': ONE_RECORD,
  '/api/interview-rounds/:id/review': "one round and one candidate's sessions: each read is keyed by the round or a session, and the transcript and the log page past the row cap",
  '/api/interview-rounds/availability': ONE_RECORD,
  '/api/me': ONE_RECORD,
  '/api/notes': ONE_CANDIDATE,
  '/api/notes/rounds/:roundId': "one round of one candidate: read through that candidate's index, and paged past the row cap",
  '/api/phone/calendar/slots': 'one IST day, capped at 400 live appointments with an explicit occupancy_truncated flag, and no id-list read',
  '/api/phone/engagements/:id': ONE_RECORD,
  '/api/phone/health': COUNTS_ONLY,
  '/api/phone/suppressions/:candidateId': ONE_CANDIDATE,
  '/api/recordings/:sessionId/download': ONE_RECORD,
  '/api/recordings/attempts/:attemptId/download': ONE_RECORD,
  '/api/recordings/health': COUNTS_ONLY,
  '/api/roles': 'grows with roles, not candidates, and reads its mappings in batches of 100',
  '/api/roles/:id': ONE_RECORD,
  '/api/roles/draft': ONE_RECORD,
  '/api/roles/draft/:id': ONE_RECORD,
  '/api/scorecards/metrics': STAFF_SIZED,
  '/api/scorecards/roles/:roleId/scorecard': ONE_RECORD,
  '/api/screening/:id': ONE_RECORD,
  '/api/status': NO_DB_LIST,
};

interface RouterLayer {
  name: string;
  route?: { path: unknown; methods: Record<string, boolean | undefined> };
  handle: { stack?: RouterLayer[] };
  regexp: RegExp & { fast_slash?: boolean };
}

/** The path an Express 4 `app.use('/x', router)` was mounted at, from its compiled regexp. */
function mountPathOf(layer: RouterLayer): string {
  if (layer.regexp.fast_slash) return '';
  const mount = layer.regexp.source
    .replace(String.raw`\/?(?=\/|$)`, '')
    .replace(/^\^/, '')
    .split(String.raw`\/`)
    .join('/');
  // A mount holding a parameter or a pattern would be misread, so refuse it.
  if (!/^[/\w-]+$/.test(mount)) throw new Error(`cannot read a mount path from ${String(layer.regexp)}`);
  return mount;
}

/** Every GET path `app` mounts, at any depth, without a trailing slash. */
function mountedGetRoutes(app: Express): string[] {
  const router = (app as unknown as { _router?: { stack: RouterLayer[] } })._router;
  // Express 4 keeps this private. A major upgrade fails here, loudly, not by finding no routes.
  if (!router) throw new Error('app._router is gone: teach mountedGetRoutes the new router stack');
  const walk = (stack: RouterLayer[], prefix: string): string[] => stack.flatMap((layer) => {
    if (layer.route) return layer.route.methods.get ? [`${prefix}${String(layer.route.path)}`.replace(/\/$/, '')] : [];
    if (layer.name === 'router' && layer.handle.stack) return walk(layer.handle.stack, prefix + mountPathOf(layer));
    return [];
  });
  return [...new Set(walk(router.stack, ''))].sort();
}

describe('the inventory of GET routes', () => {
  const classified = new Set([...DRIVEN_ROUTES, ...Object.keys(NOT_DRIVEN)]);

  it('finds a route added to any mounted router, and only GET routes', () => {
    const nested = express.Router();
    nested.get('/digest', (_req, res) => { res.end(); });
    nested.post('/digest', (_req, res) => { res.end(); });
    const app = express();
    app.use('/api/candidates', nested);
    app.get('/api/top', (_req, res) => { res.end(); });
    expect(mountedGetRoutes(app)).toEqual(['/api/candidates/digest', '/api/top']);
  });

  it('classifies every GET route the app mounts', () => {
    const mounted = mountedGetRoutes(appFor(admin));
    expect(mounted.length).toBeGreaterThan(DRIVEN_ROUTES.length);
    expect(
      mounted.filter((route) => !classified.has(route)),
      'a new GET route: drive it in this suite if it reads over a list that grows with the workspace, or add it to NOT_DRIVEN with the reason',
    ).toEqual([]);
  });

  it('lists no route the app no longer mounts', () => {
    const mounted = new Set(mountedGetRoutes(appFor(admin)));
    expect([...classified].filter((route) => !mounted.has(route))).toEqual([]);
  });

  it('never lists a route as both driven and not driven', () => {
    expect(DRIVEN_ROUTES.filter((route) => route in NOT_DRIVEN)).toEqual([]);
  });

  // Runs last, so it sees what the cases above really requested. Skipped by a
  // `-t` filter that selects only the inventory, which requests nothing.
  it('really drives every route it calls driven', () => {
    if (requested.size === 0) return;
    const undriven = DRIVEN_ROUTES.filter((route) => {
      const pattern = new RegExp(`^${route.replace(/:\w+/g, '[^/]+')}$`);
      return ![...requested].some((path) => pattern.test(path));
    });
    expect(undriven).toEqual([]);
  });
});

// ── The source scan: what the router walk cannot see ──────────────────────────

const UPPER_CASE_CONSTANT = /^[A-Z][A-Z0-9_]*$/;

const unwrapped = (node: ts.Expression): ts.Expression =>
  ts.isAsExpression(node) || ts.isParenthesizedExpression(node) ? unwrapped(node.expression) : node;

/** `ids.slice(at, at + 100)`, or the same with a named batch size: never past ID_BATCH_SIZE. */
function isBatchSlice(node: ts.CallExpression, file: ts.SourceFile): boolean {
  if (!ts.isPropertyAccessExpression(node.expression) || node.expression.name.text !== 'slice') return false;
  const [start, end] = node.arguments;
  if (!start || !end || !ts.isBinaryExpression(end) || end.operatorToken.kind !== ts.SyntaxKind.PlusToken) return false;
  if (end.left.getText(file) !== start.getText(file)) return false;
  if (ts.isNumericLiteral(end.right)) return Number(end.right.text) <= ID_BATCH_SIZE;
  return ts.isIdentifier(end.right) && UPPER_CASE_CONSTANT.test(end.right.text);
}

/** Safe by its shape: a batch from chunkIds, a batch slice, or a list fixed in the code. */
function isBatchOrFixedList(value: ts.Expression, file: ts.SourceFile): boolean {
  const node = unwrapped(value);
  if (ts.isStringLiteralLike(node)) return true;
  if (ts.isIdentifier(node)) return node.text === 'chunk' || UPPER_CASE_CONSTANT.test(node.text);
  if (ts.isCallExpression(node)) return isBatchSlice(node, file);
  if (!ts.isArrayLiteralExpression(node)) return false;
  return node.elements.every((element) => (ts.isSpreadElement(element)
    ? isBatchOrFixedList(element.expression, file)
    : ts.isStringLiteralLike(element)));
}

/**
 * The value list of every PostgREST `in` filter in this source that is not safe
 * by its shape: `.in(column, values)`, `.filter(column, 'in', values)`,
 * `.not(column, 'in', values)` and `in.(${values})` in a filter string.
 * Parsed, not grepped, so a comment or a string cannot pass for a read, and a
 * read cannot hide across lines.
 */
function variableListReads(source: string): string[] {
  const file = ts.createSourceFile('source.ts', source, ts.ScriptTarget.Latest, true, ts.ScriptKind.TS);
  const found: string[] = [];
  const check = (values: ts.Expression | undefined): void => {
    if (values && !isBatchOrFixedList(values, file)) found.push(unwrapped(values).getText(file));
  };
  const visit = (node: ts.Node): void => {
    if (ts.isCallExpression(node) && ts.isPropertyAccessExpression(node.expression)) {
      const method = node.expression.name.text;
      const [, second, third] = node.arguments;
      if (method === 'in') check(second);
      else if ((method === 'filter' || method === 'not') && second && ts.isStringLiteralLike(second) && second.text === 'in') check(third);
    }
    if (ts.isTemplateExpression(node)) {
      let before = node.head.text;
      for (const span of node.templateSpans) {
        if (/\bin\.\($/.test(before)) check(span.expression);
        before = span.literal.text;
      }
    }
    ts.forEachChild(node, visit);
  };
  visit(file);
  return found.sort();
}

/**
 * Every read over a variable list that is not batched, and why that list stays
 * far under the ~390 ids where undici refuses it. `sites` is how many reads in
 * the file use that list, so a new read cannot slip in under an old name.
 *
 * Add a read here only with a reason that holds at 5,000 candidates. If its list
 * grows with the workspace, read it through chunkIds (lib/id-batches.ts) instead.
 */
const BOUNDED_LISTS: ReadonlyArray<{ file: string; values: string; sites: number; why: string }> = [
  { file: 'integrations/ashby/access-check.ts', values: '[...jobByMapping.keys()]', sites: 1, why: 'the enabled mappings the check read, at most MAPPING_READ_CAP (50) ids' },
  { file: 'integrations/ashby/runtime-health.ts', values: 'names', sites: 5, why: 'a copy of the constant ASHBY_QUEUE_NAMES' },
  { file: 'lib/attempt-consent-stage.ts', values: 'ids', sites: 2, why: "one candidate's call legs, and past the limit the read fails closed to unknown" },
  { file: 'lib/dsar.ts', values: 'sessionIds', sites: 1, why: "one data subject's sessions" },
  { file: 'lib/phone-runtime/read.ts', values: 'ids', sites: 1, why: 'one due pass, at most PHONE_RUNTIME_MAX_ROWS (200) candidates' },
  { file: 'lib/r1/recording/summary.ts', values: 'roundIds', sites: 3, why: "one candidate's R1 rounds" },
  { file: 'lib/r1/review.ts', values: 'otherSessions', sites: 1, why: "one round's attempts: a few starts, less the deciding one" },
  { file: 'lib/r1/review.ts', values: 'phoneSessionIds', sites: 1, why: "one candidate's phone sessions" },
  { file: 'lib/r1/review.ts', values: 'sessionIds', sites: 1, why: "one round's attempts: a few starts, so the log uses its session index" },
  { file: 'lib/recording/sweeper.ts', values: 'sessionIds', sites: 1, why: 'one pass, at most ATTEMPT_LINK_PASS_LIMIT (10) attempts' },
  { file: 'routes/candidates.ts', values: 'engagementIds', sites: 2, why: "one candidate's engagements: their rescreen cycles" },
  { file: 'routes/candidates.ts', values: 'ids', sites: 1, why: "one candidate's sessions" },
  { file: 'routes/candidates.ts', values: 'list', sites: 2, why: "one candidate's sessions, in a filter string" },
  { file: 'routes/candidates.ts', values: 'sessionIds', sites: 3, why: "one candidate's sessions, or the sessions of one page of their attempts" },
  { file: 'routes/scorecards.ts', values: 'libIds', sites: 1, why: 'one request body, at most SCORECARD_MAX_METRICS (20)' },
];

function apiSourceFiles(dir: string): string[] {
  return readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
    const path = join(dir, entry.name);
    if (entry.isDirectory()) return entry.name === '__tests__' ? [] : apiSourceFiles(path);
    return entry.name.endsWith('.ts') && !entry.name.endsWith('.test.ts') && !entry.name.endsWith('.d.ts') ? [path] : [];
  });
}

describe('the scan of the API source for reads over a variable list', { timeout: TEST_TIMEOUT_MS }, () => {
  it('finds them on any path and across lines, and passes batches and fixed lists', () => {
    const source = [
      "await db.from('t').select('id').in('candidate_id', allIds);",
      "const later = q",
      "  .in(",
      "    'id',",
      "    ownedIds as string[],",
      "  );",
      "await db.from('t').select('id').or(`a.in.(${list}),b.eq.1`);",
      "await db.from('t').select('id').not('x', 'in', excluded);",
      "await db.from('t').select('id').in('w', ids.slice(0, 5000)).in('v', ids.slice(at, at + 5000)).in('u', [...allIds]);",
      // None of these is a read over a variable list.
      "// .in('id', inAComment)",
      "const text = \".in('id', inAString)\";",
      "await db.from('t').select('id').in('id', chunk).in('status', ['a', 'b']).in('state', [...LIVE_STATES]);",
      "await db.from('t').select('id').in('kind', KINDS as never).in('y', ids.slice(at, at + 100)).in('z', ids.slice(at, at + BATCH));",
      "await db.from('t').select('id').not('x', 'in', '(a,b)').or(`a.eq.${value}`);",
    ].join('\n');
    expect(variableListReads(source)).toEqual([
      '[...allIds]', 'allIds', 'excluded', 'ids.slice(0, 5000)', 'ids.slice(at, at + 5000)', 'list', 'ownedIds',
    ]);
  });

  it('every one is a batch, a fixed list, or named in BOUNDED_LISTS, and nothing there has gone stale', () => {
    const root = join(dirname(fileURLToPath(import.meta.url)), '..');
    const sites: Record<string, number> = {};
    for (const path of apiSourceFiles(root)) {
      const name = relative(root, path).split(sep).join('/');
      for (const values of variableListReads(readFileSync(path, 'utf8'))) {
        const key = `${name}: ${values}`;
        sites[key] = (sites[key] ?? 0) + 1;
      }
    }
    const named = Object.fromEntries(BOUNDED_LISTS.map((b) => [`${b.file}: ${b.values}`, b.sites]));
    expect(sites, 'a new read over a variable list: read it through chunkIds (lib/id-batches.ts), or add it to BOUNDED_LISTS with the reason it stays small').toEqual(named);
  });
});
