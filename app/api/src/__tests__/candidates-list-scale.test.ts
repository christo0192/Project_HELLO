/**
 * GET /api/candidates and /api/candidates/summary at workspace scale.
 *
 * Production, 2026-11-04 (M026): once the workspace passed about 390
 * candidates, both routes lost every recommendation and score and took
 * 17-22 s. Reproduced inside the production API machine:
 *
 *   - Each route read assessments (and the list, Ashby links) with ONE
 *     `.in('candidate_id', ids)` over every candidate. At 39 URL characters
 *     per id, 400 ids is a ~16 KB GET.
 *   - The response repeats that URL in a header, and Node's fetch (undici)
 *     rejects responses whose headers pass 16 KiB:
 *     `TypeError: fetch failed ... HeadersOverflowError (UND_ERR_HEADERS_OVERFLOW)`.
 *     353 ids passed; 400, 450, 500 and the real 529 failed; 100-id batches passed.
 *   - postgrest-js retries a failed GET three times (1 s, 2 s, 4 s: ~8 s per read)
 *     and the routes discarded `error`, so the failure read as "no assessments".
 *
 * PostgREST also caps any response at 1000 rows (`max_rows`), silently, so a
 * read of every candidate must page past it.
 *
 * The mock below is a small query engine with both real limits built in: an
 * `.in()` over more than OVERFLOW_AT values fails exactly as undici does, and
 * no response carries more than ROW_CAP rows. Every query is recorded, and a
 * test can fail chosen queries, act between page reads, or shuffle rows that
 * the requested order leaves tied.
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
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
const interviewer: AuthUser = { ...admin, id: 'user-int-0000-0000-000000000002', appRole: 'interviewer' };

const ROLE_A = '10000000-0000-4000-8000-00000000000a';
const ROLE_B = '10000000-0000-4000-8000-00000000000b';

/** Measured in production: 353 ids passed, 400 failed. */
const OVERFLOW_AT = 390;
/** PostgREST `max_rows` (app/supabase/config.toml). */
const ROW_CAP = 1000;

type Row = Record<string, unknown>;
interface Query { table: string; eqs: Array<[string, unknown]>; inValues: unknown[] | null; range: [number, number] | null }

const db: Record<string, Row[]> = {};
const queries: Query[] = [];
let failWhen: ((q: Query) => boolean) | null = null;
let throwWhen: ((q: Query) => boolean) | null = null;
let beforeExecute: ((q: Query) => void) | null = null;
let scrambleTies = false;
let seedCounter = 0;
/** When > 0, every read resolves after this many ms, so concurrency can be observed. */
let delayMs = 0;
const inFlight: Record<string, number> = {};
const peak: Record<string, number> = {};

const OVERFLOW_ERROR = {
  message: 'TypeError: fetch failed',
  details: 'TypeError: fetch failed Caused by: HeadersOverflowError: Headers Overflow Error (UND_ERR_HEADERS_OVERFLOW)',
  hint: '',
  code: '',
};

vi.mock('../lib/supabase.js', () => ({
  supabase: { from: (table: string) => query(table) },
  RESUME_BUCKET: 'resumes_v2',
}));

/** A small deterministic PRNG, so a scrambled run is reproducible. */
function prng(seed: number): () => number {
  let s = seed >>> 0;
  return () => { s = (s * 1664525 + 1013904223) >>> 0; return s / 2 ** 32; };
}

function query(table: string): Record<string, unknown> {
  const q: Query = { table, eqs: [], inValues: null, range: null };
  const filters: Array<(r: Row) => boolean> = [];
  const orders: Array<{ column: string; ascending: boolean }> = [];
  const c: Record<string, unknown> = {};
  const self = () => c;
  for (const m of ['select', 'limit', 'neq', 'gt', 'gte', 'lt', 'lte', 'single', 'maybeSingle']) c[m] = self;
  c.eq = (column: string, value: unknown) => { q.eqs.push([column, value]); filters.push((r) => r[column] === value); return c; };
  c.is = (column: string, value: unknown) => { filters.push((r) => (value === null ? r[column] == null : r[column] === value)); return c; };
  c.not = (column: string, op: string, value: unknown) => {
    if (op === 'is' && value === null) filters.push((r) => r[column] != null);
    return c;
  };
  c.in = (column: string, values: unknown[]) => {
    q.inValues = values;
    const set = new Set(values);
    filters.push((r) => set.has(r[column]));
    return c;
  };
  c.order = (column: string, opts?: { ascending?: boolean }) => { orders.push({ column, ascending: opts?.ascending !== false }); return c; };
  c.range = (from: number, to: number) => { q.range = [from, to]; return c; };
  const execute = () => {
    queries.push(q);
    if (throwWhen?.(q)) throw new Error('driver-detail postgres://10.0.0.5 user@example.com');
    beforeExecute?.(q);
    if ((q.inValues?.length ?? 0) > OVERFLOW_AT) return { data: null, error: OVERFLOW_ERROR, status: 0 };
    if (failWhen?.(q)) return { data: null, error: { message: 'boom', details: '', hint: '', code: 'XX000' }, status: 500 };
    let rows = (db[table] ?? []).filter((r) => filters.every((f) => f(r)));
    if (scrambleTies) {
      const rand = prng(++seedCounter);
      rows = rows.map((r) => [rand(), r] as const).sort((a, b) => a[0] - b[0]).map(([, r]) => r);
    }
    rows = [...rows].sort((a, b) => {
      for (const o of orders) {
        const x = String(a[o.column] ?? '');
        const y = String(b[o.column] ?? '');
        if (x !== y) return (x < y ? -1 : 1) * (o.ascending ? 1 : -1);
      }
      return 0;
    });
    if (q.range) rows = rows.slice(q.range[0], q.range[1] + 1);
    return { data: rows.slice(0, ROW_CAP), error: null, status: 200 };
  };
  c.then = (resolve: (v: unknown) => unknown, reject?: (e: unknown) => unknown) => {
    if (delayMs > 0) {
      inFlight[table] = (inFlight[table] ?? 0) + 1;
      peak[table] = Math.max(peak[table] ?? 0, inFlight[table]);
      return new Promise((r) => setTimeout(r, delayMs))
        .then(() => execute())
        .finally(() => { inFlight[table] -= 1; })
        .then(resolve, reject);
    }
    try {
      return Promise.resolve(execute()).then(resolve, reject);
    } catch (error) {
      return Promise.reject(error).then(resolve, reject);
    }
  };
  return c;
}

function appFor(user: AuthUser) {
  return createApp({
    nodeEnv: 'test',
    webOrigin: 'http://localhost:5173',
    authDeps: { getUser: mockAuthGetUser(user, JWT) },
    auditSinkOverride: async () => {},
  });
}

const cid = (i: number) => `00000000-0000-4000-8000-${String(i).padStart(12, '0')}`;
const aid = (i: number, k = 0) => `a0000000-0000-4000-8000-${String(i * 1000 + k).padStart(12, '0')}`;
const iso = (i: number) => new Date(Date.UTC(2026, 9, 1) + i * 60_000).toISOString();
const REC = ['advance', 'hold', 'reject'] as const;

interface SeedOptions {
  owner?: (i: number) => string;
  role?: (i: number) => string | null;
  sameCreatedAt?: boolean;
}

/**
 * n candidates, newest last by index. Every 7th has an assessment; the
 * recommendation cycles advance, hold, reject; scores are 40 + (i % 50).
 * Every candidate has one Ashby link whose ingestion is `ready`.
 */
function seed(n: number, opts: SeedOptions = {}): { assessed: number[] } {
  db.candidates = [];
  db.assessments = [];
  db.ashby_application_links = [];
  const assessed: number[] = [];
  for (let i = 0; i < n; i += 1) {
    db.candidates.push({
      id: cid(i), name: `Candidate ${i}`, email: null, phone_e164: null, phone_valid: false,
      skills: [], experience_years: null, status: 'screened', role_id: opts.role?.(i) ?? null,
      created_at: opts.sameCreatedAt ? iso(0) : iso(i), decision_use_blocked_at: null, resume_id: null,
      owner_id: opts.owner?.(i) ?? admin.id,
    });
    db.ashby_application_links.push({
      provider: 'ashby', candidate_id: cid(i), updated_at: iso(i), job_mapping_id: null,
      intake_type: 'resume_parsing', ashby_resume_ingestions: [{ state: 'ready' }],
    });
    if (i % 7 === 0) {
      assessed.push(i);
      db.assessments.push({
        id: aid(i), candidate_id: cid(i), session_id: null, overall_score: 40 + (i % 50),
        recommendation: REC[assessed.length % 3], created_at: iso(i + 1),
      });
    }
  }
  return { assessed };
}

const expectedRec = (assessed: number[], i: number) => REC[(assessed.indexOf(i) + 1) % 3];

/** Runs `fn` while recording unhandled rejections and the lines logged at error level. */
async function observed<T>(fn: () => Promise<T>): Promise<{ result: T; unhandled: unknown[]; logged: string[] }> {
  const unhandled: unknown[] = [];
  const onUnhandled = (reason: unknown) => { unhandled.push(reason); };
  const errorSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
  process.on('unhandledRejection', onUnhandled);
  try {
    const result = await fn();
    await new Promise((resolve) => setImmediate(resolve));
    return { result, unhandled, logged: errorSpy.mock.calls.map((call) => String(call[0])) };
  } finally {
    process.off('unhandledRejection', onUnhandled);
    errorSpy.mockRestore();
  }
}

const get = (path: string, user: AuthUser = admin) => request(appFor(user)).get(path).set('Authorization', AUTH).timeout(5000);

beforeEach(() => {
  for (const k of Object.keys(db)) delete db[k];
  queries.length = 0;
  failWhen = null;
  throwWhen = null;
  beforeExecute = null;
  scrambleTies = false;
  seedCounter = 0;
  delayMs = 0;
  for (const k of Object.keys(inFlight)) delete inFlight[k];
  for (const k of Object.keys(peak)) delete peak[k];
});

afterEach(() => {
  vi.unstubAllEnvs();
});

describe('GET /api/candidates at workspace scale', () => {
  it('keeps every recommendation and score with 529 candidates (the production count)', async () => {
    const { assessed } = seed(529);
    const res = await get('/api/candidates');
    expect(res.status).toBe(200);
    expect(res.body).toHaveLength(529);
    const withRec = (res.body as Row[]).filter((c) => c.latest_recommendation != null);
    expect(withRec).toHaveLength(assessed.length);
    const last = assessed.at(-1)!;
    expect((res.body as Row[]).find((c) => c.id === cid(last))).toMatchObject({
      latest_score: 40 + (last % 50),
      latest_recommendation: expectedRec(assessed, last),
    });
  });

  it('never sends more than 100 ids in one read, phone progress included', async () => {
    vi.stubEnv('PHONE_SCREENING_ENABLED', 'true');
    seed(529);
    await get('/api/candidates');
    const inReads = queries.filter((q) => q.inValues);
    expect(inReads.some((q) => q.table === 'phone_engagements')).toBe(true);
    expect(Math.max(...inReads.map((q) => q.inValues!.length))).toBeLessThanOrEqual(100);
  });

  it('keeps the Ashby resume state for candidates beyond the first few hundred', async () => {
    seed(529);
    const res = await get('/api/candidates');
    expect((res.body as Row[]).find((c) => c.id === cid(0))).toMatchObject({ resume_review: 'ready', intake_type: 'resume_parsing' });
  });

  it('returns every candidate past the 1000-row cap, with their scores and links, newest first', async () => {
    const { assessed } = seed(1250);
    const res = await get('/api/candidates');
    expect(res.status).toBe(200);
    const body = res.body as Row[];
    expect(body).toHaveLength(1250);
    expect(new Set(body.map((c) => c.id)).size).toBe(1250);
    expect(body[0].id).toBe(cid(1249));
    expect(body.filter((c) => c.latest_recommendation != null)).toHaveLength(assessed.length);
    // cid(0) is on the second page of candidates and in the last id batch.
    expect(body.at(-1)).toMatchObject({
      id: cid(0), latest_recommendation: expectedRec(assessed, 0), latest_score: 40,
      resume_review: 'ready', intake_type: 'resume_parsing',
    });
  });

  it('pages in a total order: ties on created_at are broken by id, with no overlap or gap', async () => {
    seed(1250, { sameCreatedAt: true });
    scrambleTies = true;
    const res = await get('/api/candidates');
    const ids = (res.body as Row[]).map((c) => c.id as string);
    expect(ids).toHaveLength(1250);
    expect(new Set(ids).size).toBe(1250);
    expect(ids).toEqual([...ids].sort());
  });

  it('does not repeat a candidate created between two page reads', async () => {
    seed(1500);
    beforeExecute = (q) => {
      if (q.table === 'candidates' && q.range?.[0] === 1000) {
        db.candidates!.push({ ...db.candidates![0], id: cid(9999), name: 'New arrival', created_at: iso(99_999) });
        beforeExecute = null;
      }
    };
    const res = await get('/api/candidates');
    const ids = (res.body as Row[]).map((c) => c.id);
    expect(new Set(ids).size).toBe(ids.length);
    expect(ids).toHaveLength(1500);
  });

  it('applies the interviewer scope to every page of candidates', async () => {
    const own = new Set<string>();
    seed(2500, { owner: (i) => { const o = i % 2 === 0 ? interviewer.id : admin.id; if (o === interviewer.id) own.add(cid(i)); return o; } });
    const res = await get('/api/candidates', interviewer);
    expect(res.status).toBe(200);
    expect(res.body).toHaveLength(own.size);
    expect((res.body as Row[]).every((c) => own.has(c.id as string))).toBe(true);
    const pages = queries.filter((q) => q.table === 'candidates' && q.range);
    expect(pages.length).toBeGreaterThan(1);
    expect(pages.every((q) => q.eqs.some(([k, v]) => k === 'owner_id' && v === interviewer.id))).toBe(true);
  });

  it('applies the role filter to every page of candidates', async () => {
    seed(2500, { role: (i) => (i % 2 === 0 ? ROLE_A : ROLE_B) });
    const res = await get(`/api/candidates?role_id=${ROLE_A}`);
    expect(res.status).toBe(200);
    expect(res.body).toHaveLength(1250);
    expect((res.body as Row[]).every((c) => c.role_id === ROLE_A)).toBe(true);
    const pages = queries.filter((q) => q.table === 'candidates' && q.range);
    expect(pages.length).toBeGreaterThan(1);
    expect(pages.every((q) => q.eqs.some(([k, v]) => k === 'role_id' && v === ROLE_A))).toBe(true);
  });

  it('reads a batch with more than 1000 assessment rows in full, newest first', async () => {
    seed(100);
    db.assessments = [];
    for (let i = 0; i < 100; i += 1) {
      // Twelve rounds per candidate: 1200 rows in one batch. The newest is pushed FIRST,
      // so storage order cannot rescue a read that lost its ORDER BY.
      for (let k = 11; k >= 0; k -= 1) {
        db.assessments.push({ id: aid(i, k), candidate_id: cid(i), session_id: null, overall_score: k === 11 ? 90 : 10, recommendation: k === 11 ? 'advance' : 'reject', created_at: iso(i * 20 + k) });
      }
    }
    db.assessments.reverse();
    const res = await get('/api/candidates');
    expect(res.status).toBe(200);
    expect((res.body as Row[]).every((c) => c.latest_recommendation === 'advance' && c.latest_score === 90)).toBe(true);
  });

  it('keeps the newest assessment when older rows for the same candidates come FIRST in storage', async () => {
    const { assessed } = seed(529);
    // Older rows ahead of the newer ones: only the read's ORDER BY can pick the newest.
    for (const i of assessed) db.assessments!.unshift({ id: aid(i, 1), candidate_id: cid(i), session_id: null, overall_score: 5, recommendation: 'reject', created_at: iso(i) });
    const res = await get('/api/candidates');
    const scored = (res.body as Row[]).filter((c) => c.latest_score != null);
    expect(scored).toHaveLength(assessed.length);
    expect(scored.every((c) => c.latest_score !== 5)).toBe(true);
  });

  it('answers 503 and logs a sanitised line when one assessments batch of six fails', async () => {
    seed(529);
    failWhen = (q) => q.table === 'assessments' && (q.inValues ?? []).includes(cid(250));
    const { result: res, unhandled, logged } = await observed(() => get('/api/candidates'));
    expect(unhandled).toEqual([]);
    expect(res.status).toBe(503);
    expect(res.body).toEqual({ error: 'service_unavailable' });
    const lines = logged.filter((l) => l.includes('candidate_assessments_read'));
    expect(lines).toHaveLength(1);
    expect(JSON.parse(lines[0] as string)).toMatchObject({ level: 'error', component: 'candidates', event: 'db_error', error_category: 'candidate_assessments_read', error_type: 'query_failed' });
    expect(lines[0]).not.toMatch(/00000000-0000-4000-8000|Candidate \d/);
  });

  it('stops starting new assessments batches after the first failure', async () => {
    seed(1250); // 13 batches, 4 at a time
    failWhen = (q) => q.table === 'assessments';
    const res = await get('/api/candidates');
    expect(res.status).toBe(503);
    expect(queries.filter((q) => q.table === 'assessments').length).toBeLessThanOrEqual(4);
  });

  it('answers 503 (never a hang) when the assessments builder throws, and logs only a category', async () => {
    seed(50);
    throwWhen = (q) => q.table === 'assessments';
    const { result: res, unhandled, logged } = await observed(() => get('/api/candidates'));
    expect(unhandled).toEqual([]);
    expect(res.status).toBe(503);
    const lines = logged.filter((l) => l.includes('candidate_assessments_read'));
    expect(lines).toHaveLength(1);
    expect(JSON.parse(lines[0] as string)).toMatchObject({ error_category: 'candidate_assessments_read', error_type: 'query_failed' });
    expect(logged.join('\n')).not.toMatch(/driver-detail|postgres:|10\.0\.0\.5|user@example\.com/);
  });

  it('keeps every batched read on the list at most 4 in flight, phone progress included', async () => {
    vi.stubEnv('PHONE_SCREENING_ENABLED', 'true');
    seed(1250);
    delayMs = 3;
    const res = await get('/api/candidates');
    expect(res.status).toBe(200);
    expect(peak.assessments).toBeLessThanOrEqual(4);
    expect(peak.ashby_application_links).toBeLessThanOrEqual(4);
    expect(peak.phone_engagements).toBeLessThanOrEqual(4);
    expect(peak.phone_engagements).toBeGreaterThan(1);
  });

  it('stops the additive reads at their first failed batch, and still answers 200', async () => {
    vi.stubEnv('PHONE_SCREENING_ENABLED', 'true');
    seed(1250); // 13 batches each
    delayMs = 2;
    failWhen = (q) => q.table === 'ashby_application_links' || q.table === 'phone_engagements';
    const res = await get('/api/candidates');
    expect(res.status).toBe(200);
    expect(queries.filter((q) => q.table === 'ashby_application_links').length).toBeLessThanOrEqual(4);
    expect(queries.filter((q) => q.table === 'phone_engagements').length).toBeLessThanOrEqual(4);
    const body = res.body as Row[];
    expect(body).toHaveLength(1250);
    // Unread phone progress is unknown (null), never a confident 0.
    expect(body.every((c) => c.dial_count === null)).toBe(true);
    expect(body.every((c) => c.resume_review === null)).toBe(true);
  });

  it('answers 503 when a batch passes the page bound rather than returning it truncated', async () => {
    seed(1);
    db.assessments = Array.from({ length: 10_001 }, (_, k) => ({ id: aid(0, k), candidate_id: cid(0), session_id: null, overall_score: 50, recommendation: 'hold', created_at: iso(k) }));
    const { result: res, logged } = await observed(() => get('/api/candidates'));
    expect(res.status).toBe(503);
    expect(logged.some((l) => l.includes('"error_type":"page_bound"'))).toBe(true);
  });

  it('keeps the other batches\' Ashby state when one links batch fails, and drops what it cannot stand behind', async () => {
    seed(529);
    db.candidates![0].resume_id = 'resume-0';
    failWhen = (q) => q.table === 'ashby_application_links' && (q.inValues ?? []).includes(cid(0));
    const res = await get('/api/candidates');
    expect(res.status).toBe(200);
    const body = res.body as Row[];
    // cid(0)'s batch failed: no resume state, and no intake guessed from resume_id.
    expect(body.find((c) => c.id === cid(0))).toMatchObject({ resume_review: null, intake_type: null });
    // Another batch still reports its candidates.
    expect(body.find((c) => c.id === cid(300))).toMatchObject({ resume_review: 'ready', intake_type: 'resume_parsing' });
    // The job status is omitted, not guessed, when the links read was incomplete.
    expect(body.every((c) => !('ashby_job_status' in c))).toBe(true);
  });

  it('fails the request, never returns a partial list, when a later candidates page fails', async () => {
    seed(1250);
    failWhen = (q) => q.table === 'candidates' && (q.range?.[0] ?? 0) >= 1000;
    const res = await get('/api/candidates');
    expect(res.status).toBeGreaterThanOrEqual(500);
    expect(Array.isArray(res.body)).toBe(false);
  });

  it('fails the request (never hangs) when the candidates builder throws', async () => {
    seed(10);
    throwWhen = (q) => q.table === 'candidates';
    const { result: res, unhandled } = await observed(() => get('/api/candidates'));
    expect(unhandled).toEqual([]);
    expect(res.status).toBeGreaterThanOrEqual(500);
  });
});

describe('GET /api/candidates/summary at workspace scale', () => {
  it('counts every assessed candidate with 529 candidates', async () => {
    const { assessed } = seed(529);
    const res = await get('/api/candidates/summary');
    expect(res.status).toBe(200);
    expect(res.body.assessed_count).toBe(assessed.length);
    const dist = res.body.recommendation_distribution as Record<string, number>;
    expect(dist.advance + dist.hold + dist.reject).toBe(assessed.length);
    const mean = assessed.reduce((a, i) => a + 40 + (i % 50), 0) / assessed.length;
    expect(res.body.average_score).toBe(Math.round(mean * 10) / 10);
  });

  it('never sends more than 100 candidate ids in one read', async () => {
    seed(529);
    await get('/api/candidates/summary');
    const reads = queries.filter((q) => q.inValues);
    expect(reads.length).toBeGreaterThan(0);
    expect(Math.max(...reads.map((q) => q.inValues!.length))).toBeLessThanOrEqual(100);
  });

  it('covers every candidate past the 1000-row cap, in a total order', async () => {
    const { assessed } = seed(1250);
    scrambleTies = true; // the summary pages by id alone: any unpinned order would overlap or skip
    const res = await get('/api/candidates/summary');
    expect(res.status).toBe(200);
    expect(res.body.assessed_count).toBe(assessed.length);
  });

  it('applies the interviewer scope to every page of candidates', async () => {
    const own = new Set<number>();
    const { assessed } = seed(2500, { owner: (i) => { if (i % 2 === 0) { own.add(i); return interviewer.id; } return admin.id; } });
    const res = await get('/api/candidates/summary', interviewer);
    expect(res.status).toBe(200);
    expect(res.body.assessed_count).toBe(assessed.filter((i) => own.has(i)).length);
    const pages = queries.filter((q) => q.table === 'candidates' && q.range);
    expect(pages.length).toBeGreaterThan(1);
    expect(pages.every((q) => q.eqs.some(([k, v]) => k === 'owner_id' && v === interviewer.id))).toBe(true);
  });

  it('answers 503 instead of "no assessments" when one assessments batch fails', async () => {
    seed(529);
    failWhen = (q) => q.table === 'assessments' && (q.inValues ?? []).includes(cid(400));
    const res = await get('/api/candidates/summary');
    expect(res.status).toBe(503);
    expect(res.body).toEqual({ error: 'service_unavailable' });
  });

  it('fails the request, never counts a partial set, when a later candidates page fails', async () => {
    seed(1250);
    failWhen = (q) => q.table === 'candidates' && (q.range?.[0] ?? 0) >= 1000;
    const res = await get('/api/candidates/summary');
    expect(res.status).toBeGreaterThanOrEqual(500);
    expect(res.body.assessed_count).toBeUndefined();
  });
});
