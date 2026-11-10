/**
 * The business-impact API (M031 S5): GET /api/impact/summary, GET
 * /api/impact/candidates, and the admin's per-mapping switch.
 *
 * Zero network: the 0140 functions are behind an injected store. The numbers
 * themselves are proven on real Postgres by app/supabase/tests/
 * ashby_impact_assert.sql; here the store answers what Postgres really answered
 * on that fixture (fixtures/impact-postgres.json, captured from PGlite running
 * every migration), so the shaper is tested on genuine output, and an
 * in-memory store applies the candidate page's rule (D-M031-5) so the route's
 * scoping can be checked end to end.
 *
 * Pins: role gating (interviewer and up; admin for the switch) with the
 * contract's 403 body; every query parameter validated (400 invalid_filter)
 * before the database is asked; 503 impact_unavailable on any failure or any
 * answer the contract cannot carry; one audit row per call with the filter and
 * counts only, fail-closed for the list; the visibility rule, the hidden count
 * and no hidden id anywhere in a response; the contract's fields, exactly.
 */
import { afterEach, describe, expect, it, vi } from 'vitest';
import express, { type NextFunction, type Request, type Response } from 'express';
import request from 'supertest';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';
import { createImpactRouter } from '../routes/impact.js';
import { getAuditSink, recordAudit, setAuditSink, type AuditEntry } from '../lib/audit.js';
import { hasRoleAtLeast } from '../lib/rbac.js';
import { candidateScope } from '../lib/candidate-scope.js';
import {
  IMPACT_STEPS,
  impactProgressEnabled,
  type ImpactCandidatesInput,
  type ImpactRpcAnswer,
  type ImpactStore,
} from '../lib/impact.js';
import { parseYamlDocument, validateNamed } from './support/openapi-schema.js';
import { CONTRACT_CANDIDATES_EXAMPLE, CONTRACT_SUMMARY_EXAMPLE, fieldDiff } from './support/impact-contract.js';

const HERE = dirname(fileURLToPath(import.meta.url));
const SPEC = parseYamlDocument(readFileSync(resolve(HERE, '../../openapi/openapi.yaml'), 'utf8'));
const PG = JSON.parse(readFileSync(resolve(HERE, 'fixtures/impact-postgres.json'), 'utf8')) as Record<string, ImpactRpcAnswer>;

const ADMIN = '44444444-4444-4444-8444-444444444444';
const INTERVIEWER = '55555555-5555-4555-8555-555555555555';
const OTHER = '66666666-6666-4666-8666-666666666666';
const MAPPING = '7a7a7a7a-7a7a-4a7a-8a7a-7a7a7a7a7a7a';
const NOW = new Date('2026-11-10T06:30:00.000Z');

const clone = <T>(v: T): T => JSON.parse(JSON.stringify(v)) as T;

function pgStore(overrides: Partial<ImpactStore> = {}) {
  const store = {
    summary: vi.fn(async () => clone(PG.summaryOn)),
    candidates: vi.fn(async () => clone(PG.candidatesAllHired)),
    mappingSettings: vi.fn(async () => clone(PG.mappingSettings)),
    setExclusion: vi.fn(async () => clone(PG.setExclusion)),
    ...overrides,
  } satisfies ImpactStore;
  return store;
}

function appWith(role: string | null, store: ImpactStore, opts: { userId?: string; progress?: boolean } = {}) {
  const app = express();
  app.use(express.json());
  app.use((req: Request, _res: Response, next: NextFunction) => {
    if (role) (req as unknown as { authUser: unknown }).authUser = { id: opts.userId ?? ADMIN, appRole: role };
    next();
  });
  app.use('/api/impact', createImpactRouter({ store, progressEnabled: () => opts.progress ?? true, now: () => NOW }));
  return app;
}

let restoreSink: (() => void) | null = null;
function captureAudits(fail = false): AuditEntry[] {
  const entries: AuditEntry[] = [];
  const previous = getAuditSink();
  setAuditSink(async (entry) => {
    if (fail) throw new Error('sink down');
    entries.push(entry);
  });
  restoreSink = () => setAuditSink(previous);
  return entries;
}
afterEach(() => {
  restoreSink?.();
  restoreSink = null;
  vi.restoreAllMocks();
});

// ── Role gating ──────────────────────────────────────────────────────────

describe('who may call', () => {
  it.each([
    ['viewer', '/api/impact/summary'],
    ['viewer', '/api/impact/candidates?step=called'],
    ['interviewer', '/api/impact/exclusions'],
    ['viewer', '/api/impact/exclusions'],
  ])('%s is refused %s with the contract body, and nothing is read', async (role, path) => {
    const store = pgStore();
    const res = await request(appWith(role, store)).get(path);
    expect(res.status).toBe(403);
    expect(res.body).toEqual({ ok: false, error: 'forbidden' });
    expect(validateNamed(res.body, 'ImpactError', SPEC)).toEqual([]);
    for (const fn of Object.values(store)) expect(fn).not.toHaveBeenCalled();
  });

  it('an unauthenticated request is refused', async () => {
    const store = pgStore();
    for (const path of ['/api/impact/summary', '/api/impact/candidates?step=called', '/api/impact/exclusions']) {
      expect((await request(appWith(null, store)).get(path)).status).toBe(403);
    }
    expect((await request(appWith(null, store)).put(`/api/impact/exclusions/${MAPPING}`).send({ excluded: true })).status).toBe(403);
    expect((await request(appWith('interviewer', store)).put(`/api/impact/exclusions/${MAPPING}`).send({ excluded: true })).status).toBe(403);
    for (const fn of Object.values(store)) expect(fn).not.toHaveBeenCalled();
  });

  it.each(['interviewer', 'admin'])('%s reads the summary and the list', async (role) => {
    const store = pgStore();
    expect((await request(appWith(role, store, { userId: INTERVIEWER })).get('/api/impact/summary')).status).toBe(200);
    expect((await request(appWith(role, store, { userId: INTERVIEWER })).get('/api/impact/candidates?step=hired')).status).toBe(200);
  });
});

// ── GET /summary ─────────────────────────────────────────────────────────

describe('GET /api/impact/summary', () => {
  it('answers exactly the contract, from what Postgres answered, and validates against the OpenAPI schema', async () => {
    const store = pgStore();
    const res = await request(appWith('interviewer', store, { userId: INTERVIEWER })).get('/api/impact/summary?from=2026-09-01&to=2026-11-10');
    expect(res.status).toBe(200);
    expect(fieldDiff(res.body, CONTRACT_SUMMARY_EXAMPLE)).toEqual([]);
    expect(validateNamed(res.body, 'ImpactSummaryResponse', SPEC)).toEqual([]);
    expect(res.body.ok).toBe(true);
    expect(res.body.pipeline.map((p: { step: string }) => p.step)).toEqual([...IMPACT_STEPS]);
    // Postgres's `+00:00` is the contract's ISO `...Z`.
    expect(res.body.meta.generatedAt).toBe('2026-11-10T06:30:00.000Z');
    expect(res.body.meta.lastPassAt).toBe('2026-11-10T05:00:00.000Z');
    expect(res.body.meta).toMatchObject({ coverage: { checked: 15, total: 22 }, staleRows: 1, minTimingN: 5, progressEnabled: true });
    expect(res.body.pipeline[2].sub).toEqual({ label: 'Call answered', reached: 15 });
    expect(res.body.timings[0]).toEqual({ key: 'entry_to_first_call', label: 'Christy stage to first call', medianDays: 0.35, p90Days: 0.6, n: 16 });
  });

  it('passes the window, the job, the progress flag and the clock to the database', async () => {
    const store = pgStore();
    await request(appWith('admin', store, { progress: false })).get(`/api/impact/summary?from=2026-09-01&to=2026-11-10&job=${MAPPING}`);
    expect(store.summary).toHaveBeenCalledWith({ from: '2026-09-01', to: '2026-11-10', job: MAPPING }, false, NOW);
    await request(appWith('admin', store)).get('/api/impact/summary');
    expect(store.summary).toHaveBeenLastCalledWith({ from: null, to: null, job: null }, true, NOW);
  });

  it('with progress off every Ashby-side figure stays null, as the database sent it', async () => {
    const store = pgStore({ summary: vi.fn(async () => clone(PG.summaryOff)) });
    const res = await request(appWith('admin', store, { progress: false })).get('/api/impact/summary');
    expect(res.status).toBe(200);
    expect(res.body.meta.progressEnabled).toBe(false);
    for (const step of res.body.pipeline.slice(4)) {
      expect(step).toMatchObject({ reached: null, ofPrevious: null, ofCameIn: null, stillHere: null, droppedHere: null });
    }
    expect(res.body.verdictOutcomes.rows.every((r: { cells: Record<string, unknown> }) => Object.values(r.cells).every((c) => c === null))).toBe(true);
    expect(res.body.leaves).toEqual([]);
    expect(validateNamed(res.body, 'ImpactSummaryResponse', SPEC)).toEqual([]);
  });

  it.each([
    'from=2026-02-30',
    'from=2026-9-1',
    'to=yesterday',
    'from=2026-11-10&to=2026-11-01',
    'job=not-a-uuid',
    'from=2026-09-01&from=2026-09-02',
    'week=12',
    'job[x]=1',
  ])('refuses %s with invalid_filter before asking the database', async (query) => {
    const store = pgStore();
    const res = await request(appWith('admin', store)).get(`/api/impact/summary?${query}`);
    expect(res.status).toBe(400);
    expect(res.body).toEqual({ ok: false, error: 'invalid_filter' });
    expect(store.summary).not.toHaveBeenCalled();
  });

  it.each(['invalid_filter', 'unknown_job'])('a database refusal (%s) is the caller\'s 400', async (status) => {
    const store = pgStore({ summary: vi.fn(async () => ({ status })) });
    const res = await request(appWith('admin', store)).get(`/api/impact/summary?job=${MAPPING}`);
    expect(res.status).toBe(400);
    expect(res.body).toEqual({ ok: false, error: 'invalid_filter' });
  });

  it('a database failure is 503 impact_unavailable, sanitized', async () => {
    vi.spyOn(console, 'error').mockImplementation(() => {});
    const store = pgStore({ summary: vi.fn(async () => { throw new Error('relation "screening_v2.secret" does not exist'); }) });
    const res = await request(appWith('admin', store)).get('/api/impact/summary');
    expect(res.status).toBe(503);
    expect(res.body).toEqual({ ok: false, error: 'impact_unavailable' });
    expect(JSON.stringify(res.body)).not.toContain('secret');
  });

  const broken: Array<[string, (s: Record<string, any>) => void]> = [
    ['a share over 100%', (s) => { s.pipeline[1].ofPrevious = 1.2; }],
    ['a step counting more than the one before', (s) => { s.pipeline[3].reached = 13; }],
    ['steps out of order', (s) => { [s.pipeline[0], s.pipeline[1]] = [s.pipeline[1], s.pipeline[0]]; }],
    ['a missing meta field', (s) => { delete s.meta.coverage; }],
    ['a negative count', (s) => { s.verdictOutcomes.rows[0].total = -1; }],
    ['six top reasons', (s) => { s.leaves[0].topReasons = Array.from({ length: 6 }, (_, i) => ({ text: `r${i}`, count: 1 })); }],
    ['an unknown verdict', (s) => { s.verdictOutcomes.rows[0].verdict = 'great'; }],
    ['a timestamp that is not one', (s) => { s.meta.generatedAt = 'soon'; }],
  ];
  it.each(broken)('refuses %s from the database (503), never draws it', async (_name, breakIt) => {
    vi.spyOn(console, 'error').mockImplementation(() => {});
    const answer = clone(PG.summaryOn) as Record<string, any>;
    breakIt(answer.summary);
    const res = await request(appWith('admin', pgStore({ summary: vi.fn(async () => answer) }))).get('/api/impact/summary');
    expect(res.status).toBe(503);
    expect(res.body).toEqual({ ok: false, error: 'impact_unavailable' });
  });

  it('drops anything the contract does not name, and withholds a time under n 5 whatever the database sent', async () => {
    const answer = clone(PG.summaryOn) as Record<string, any>;
    answer.summary.debug = { sql: 'select 1' };
    answer.summary.meta.workerHost = 'machine-1';
    answer.summary.pipeline[0].names = ['Someone'];
    answer.summary.timings[6] = { ...answer.summary.timings[6], medianDays: 3, p90Days: 4 };
    const res = await request(appWith('admin', pgStore({ summary: vi.fn(async () => answer) }))).get('/api/impact/summary');
    expect(res.status).toBe(200);
    expect(fieldDiff(res.body, CONTRACT_SUMMARY_EXAMPLE)).toEqual([]);
    expect(JSON.stringify(res.body)).not.toMatch(/debug|workerHost|Someone/);
    expect(res.body.timings[6]).toMatchObject({ key: 'offer_to_hired', n: 1, medianDays: null, p90Days: null });
  });

  it('writes one audit row with the filter and counts only', async () => {
    const entries = captureAudits();
    const res = await request(appWith('interviewer', pgStore(), { userId: INTERVIEWER }))
      .get(`/api/impact/summary?from=2026-09-01&to=2026-11-10&job=${MAPPING}`);
    expect(res.status).toBe(200);
    expect(entries).toHaveLength(1);
    expect(entries[0]).toMatchObject({ event: 'resource.read', userId: INTERVIEWER, userRole: 'interviewer' });
    expect(entries[0].metadata).toEqual({
      resource: 'impact_summary', job_mapping_id: MAPPING, from: '2026-09-01', to: '2026-11-10',
      progress_enabled: true, came_in: 22, coverage_checked: 15, coverage_total: 22,
    });
  });

  it('an audit sink that fails does not hide aggregates (fail-open: no personal data)', async () => {
    vi.spyOn(console, 'error').mockImplementation(() => {});
    captureAudits(true);
    expect((await request(appWith('admin', pgStore())).get('/api/impact/summary')).status).toBe(200);
  });
});

// ── GET /candidates: validation ──────────────────────────────────────────

describe('GET /api/impact/candidates: the filter', () => {
  it.each([
    [''],
    ['step=called&verdict=select&outcome=r1'],
    ['step=called&leaveStageId=stage-1'],
    ['verdict=select'],
    ['outcome=r1'],
    ['verdict=great&outcome=r1'],
    ['verdict=select&outcome=r9'],
    ['step=nope'],
    ['step=hired&dropped=true'],
    ['verdict=select&outcome=r1&dropped=true'],
    ['leaveStageId=stage-1&reachedOnly=true'],
    ['step=called&dropped=true&reachedOnly=true'],
    ['step=called&reachedOnly=false'],
    ['step=called&dropped=yes'],
    ['leaveStageId=bad%20id!'],
    [`leaveStageId=${'a'.repeat(257)}`],
    ['step=called&page=0'],
    ['step=called&page=-1'],
    ['step=called&page=1.5'],
    ['step=called&pageSize=0'],
    ['step=called&pageSize=101'],
    ['step=called&pageSize=ten'],
    ['step=called&from=2026-11-10&to=2026-11-01'],
    ['step=called&job=x'],
    ['step=called&step=hired'],
    ['step=called&sort=name'],
  ])('refuses "%s" with invalid_filter before asking the database', async (query) => {
    const store = pgStore();
    const res = await request(appWith('admin', store)).get(`/api/impact/candidates?${query}`);
    expect(res.status).toBe(400);
    expect(res.body).toEqual({ ok: false, error: 'invalid_filter' });
    expect(store.candidates).not.toHaveBeenCalled();
  });

  it('passes each selector, the window, paging and the flag to the database', async () => {
    const store = pgStore();
    const app = appWith('admin', store, { progress: false });
    await request(app).get(`/api/impact/candidates?step=decided&dropped=true&from=2026-09-01&to=2026-11-10&job=${MAPPING}&page=3&pageSize=20`);
    expect(store.candidates).toHaveBeenLastCalledWith({
      from: '2026-09-01', to: '2026-11-10', job: MAPPING,
      target: { kind: 'step', step: 'decided', dropped: true }, scope: { kind: 'all' }, page: 3, pageSize: 20,
    }, false, NOW);
    await request(app).get('/api/impact/candidates?step=scored&reachedOnly=true');
    expect(store.candidates).toHaveBeenLastCalledWith(expect.objectContaining({
      target: { kind: 'step', step: 'scored', dropped: false }, page: 1, pageSize: 50,
    }), false, NOW);
    await request(app).get('/api/impact/candidates?verdict=held&outcome=still_christy');
    expect(store.candidates).toHaveBeenLastCalledWith(expect.objectContaining({
      target: { kind: 'verdict', verdict: 'held', outcome: 'still_christy' },
    }), false, NOW);
    await request(app).get('/api/impact/candidates?leaveStageId=stage-05-christy');
    expect(store.candidates).toHaveBeenLastCalledWith(expect.objectContaining({
      target: { kind: 'leave', stageId: 'stage-05-christy' },
    }), false, NOW);
  });

  it.each(['invalid_filter', 'unknown_job'])('a database refusal (%s) is the caller\'s 400', async (status) => {
    const store = pgStore({ candidates: vi.fn(async () => ({ status })) });
    expect((await request(appWith('admin', store)).get('/api/impact/candidates?step=called')).body).toEqual({ ok: false, error: 'invalid_filter' });
  });

  it('a database failure, or a scope the database refuses, is 503', async () => {
    vi.spyOn(console, 'error').mockImplementation(() => {});
    for (const answer of [async () => { throw new Error('boom'); }, async () => ({ status: 'invalid_scope' })]) {
      const res = await request(appWith('admin', pgStore({ candidates: vi.fn(answer) }))).get('/api/impact/candidates?step=called');
      expect(res.status).toBe(503);
      expect(res.body).toEqual({ ok: false, error: 'impact_unavailable' });
    }
  });
});

// ── GET /candidates: visibility (D-M031-5) ───────────────────────────────

/**
 * An in-memory impact_candidates: the applications behind one figure, then the
 * candidate page's rule, exactly as 0140 applies it. Each fixture row carries
 * fields the contract forbids, to prove the route never passes them on.
 */
interface FixtureApp {
  candidateId: string | null;
  ownerId: string | null;
  name: string | null;
  email: string | null;
  phone: string | null;
  externalApplicationId: string;
}
const FIXTURE: FixtureApp[] = [
  { candidateId: 'aaaaaaa1-0000-4000-8000-000000000001', ownerId: INTERVIEWER, name: 'Own One', email: 'own1@example.test', phone: '+919999000001', externalApplicationId: 'app-own-1' },
  { candidateId: 'aaaaaaa1-0000-4000-8000-000000000002', ownerId: INTERVIEWER, name: 'Own Two', email: 'own2@example.test', phone: '+919999000002', externalApplicationId: 'app-own-2' },
  { candidateId: 'bbbbbbb2-0000-4000-8000-000000000003', ownerId: OTHER, name: 'Other Three', email: 'o3@example.test', phone: '+919999000003', externalApplicationId: 'app-other-3' },
  { candidateId: 'bbbbbbb2-0000-4000-8000-000000000004', ownerId: OTHER, name: 'Other Four', email: 'o4@example.test', phone: '+919999000004', externalApplicationId: 'app-other-4' },
  { candidateId: 'ccccccc3-0000-4000-8000-000000000005', ownerId: null, name: 'Unowned Five', email: null, phone: null, externalApplicationId: 'app-unowned-5' },
  { candidateId: null, ownerId: null, name: null, email: null, phone: null, externalApplicationId: 'app-stuck-6' },
];

function scopedStore(): ImpactStore & { candidates: ReturnType<typeof vi.fn> } {
  return pgStore({
    candidates: vi.fn(async (input: ImpactCandidatesInput) => {
      const visible = FIXTURE.filter((a) => input.scope.kind === 'all'
        || (a.candidateId !== null && a.ownerId === input.scope.ownerId));
      const start = (input.page - 1) * input.pageSize;
      return {
        status: 'ok',
        total: visible.length,
        hidden: FIXTURE.length - visible.length,
        page: input.page,
        pageSize: input.pageSize,
        rows: visible.slice(start, start + input.pageSize).map((a) => ({
          candidateId: a.candidateId, name: a.name, roleTitle: 'Sales Program Advisor',
          verdict: 'select', score: 72, provisional: false,
          currentStageTitle: 'R2', currentMilestone: 'r2', status: 'Active',
          enteredChristyAt: '2026-10-20T05:00:00+00:00', lastMoveAt: '2026-11-03T09:30:00+00:00',
          // Never to be sent:
          email: a.email, phone: a.phone, externalApplicationId: a.externalApplicationId, ownerId: a.ownerId,
          archiveReasonText: 'typed note about the candidate',
        })),
      };
    }),
  }) as never;
}

describe('GET /api/impact/candidates: who is listed', () => {
  it('the candidate page\'s rule: an interviewer owns, every other role opens all', () => {
    expect(candidateScope({ id: INTERVIEWER, appRole: 'interviewer' })).toEqual({ kind: 'owner', ownerId: INTERVIEWER });
    expect(candidateScope({ id: ADMIN, appRole: 'admin' })).toEqual({ kind: 'all' });
    expect(candidateScope({ id: ADMIN, appRole: 'viewer' })).toEqual({ kind: 'all' });
    expect(candidateScope(undefined)).toEqual({ kind: 'all' });
  });

  it('GET /api/candidates/:id applies that same function (one rule, not two copies)', () => {
    const source = readFileSync(resolve(HERE, '../routes/candidates.ts'), 'utf8');
    const detail = source.slice(source.indexOf("candidatesRouter.get('/:id',"), source.indexOf('const { data: candidate, error } = await q.single();'));
    expect(detail).toContain('const scope = candidateScope(req.authUser);');
    expect(detail).toContain("if (scope.kind === 'owner') {\n    q = q.eq('owner_id', scope.ownerId);");
    expect(detail).not.toContain("appRole === 'interviewer'");
  });

  it('an interviewer gets only their own candidates, the rest counted as hidden, and no hidden id anywhere', async () => {
    const store = scopedStore();
    const res = await request(appWith('interviewer', store, { userId: INTERVIEWER })).get('/api/impact/candidates?step=came_in');
    expect(res.status).toBe(200);
    expect(store.candidates).toHaveBeenCalledWith(expect.objectContaining({ scope: { kind: 'owner', ownerId: INTERVIEWER } }), true, NOW);
    expect(res.body.total).toBe(2);
    expect(res.body.hidden).toBe(4);
    expect(res.body.rows.map((r: { candidateId: string }) => r.candidateId)).toEqual([FIXTURE[0].candidateId, FIXTURE[1].candidateId]);
    const raw = JSON.stringify(res.body);
    for (const hidden of FIXTURE.slice(2)) {
      if (hidden.candidateId) expect(raw).not.toContain(hidden.candidateId);
      if (hidden.name) expect(raw).not.toContain(hidden.name);
      expect(raw).not.toContain(hidden.externalApplicationId);
    }
    expect(validateNamed(res.body, 'ImpactCandidatesResponse', SPEC)).toEqual([]);
  });

  it('an admin gets every application, the one with no candidate record included', async () => {
    const store = scopedStore();
    const res = await request(appWith('admin', store)).get('/api/impact/candidates?step=came_in');
    expect(res.status).toBe(200);
    expect(store.candidates).toHaveBeenCalledWith(expect.objectContaining({ scope: { kind: 'all' } }), true, NOW);
    expect(res.body).toMatchObject({ total: 6, hidden: 0 });
    expect(res.body.rows).toHaveLength(6);
    expect(res.body.rows[5]).toMatchObject({ candidateId: null, name: null });
    expect(validateNamed(res.body, 'ImpactCandidatesResponse', SPEC)).toEqual([]);
  });

  it('a row with no candidate record never reaches an interviewer, even if the database sent one (503)', async () => {
    vi.spyOn(console, 'error').mockImplementation(() => {});
    const store = pgStore({
      candidates: vi.fn(async () => ({ ...clone(PG.candidatesAllCameIn), rows: [{ ...clone((PG.candidatesAllHired.rows as unknown[])[0] as object), candidateId: null, name: null }] })),
    });
    const res = await request(appWith('interviewer', store, { userId: INTERVIEWER })).get('/api/impact/candidates?step=came_in');
    expect(res.status).toBe(503);
    expect(res.body).toEqual({ ok: false, error: 'impact_unavailable' });
  });

  it('a row carries the contract\'s eleven fields and nothing else: no email, phone, Ashby id or free text', async () => {
    const res = await request(appWith('admin', scopedStore())).get('/api/impact/candidates?step=came_in');
    expect(fieldDiff(res.body, CONTRACT_CANDIDATES_EXAMPLE)).toEqual([]);
    for (const row of res.body.rows) {
      expect(Object.keys(row).sort()).toEqual(Object.keys(CONTRACT_CANDIDATES_EXAMPLE.rows[0]).sort());
    }
    const raw = JSON.stringify(res.body);
    expect(raw).not.toMatch(/@example\.test|\+91999|app-own|app-other|app-stuck|typed note|ownerId|externalApplicationId/);
    expect(res.body.rows[0].enteredChristyAt).toBe('2026-10-20T05:00:00.000Z');
  });

  it('pages: the page and size the caller asked for, the totals unchanged', async () => {
    const res = await request(appWith('admin', scopedStore())).get('/api/impact/candidates?step=came_in&page=2&pageSize=4');
    expect(res.body).toMatchObject({ total: 6, hidden: 0, page: 2, pageSize: 4 });
    expect(res.body.rows).toHaveLength(2);
  });

  it('answers what Postgres answered for an interviewer: their 9, 13 hidden', async () => {
    const store = pgStore({ candidates: vi.fn(async () => clone(PG.candidatesOwnerCameIn)) });
    const res = await request(appWith('interviewer', store, { userId: INTERVIEWER })).get('/api/impact/candidates?step=came_in');
    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({ total: 9, hidden: 13, page: 1, pageSize: 50 });
    expect(res.body.rows.every((r: { candidateId: string | null }) => r.candidateId !== null)).toBe(true);
    expect(fieldDiff(res.body, CONTRACT_CANDIDATES_EXAMPLE)).toEqual([]);
    expect(validateNamed(res.body, 'ImpactCandidatesResponse', SPEC)).toEqual([]);
  });

  it('answers what Postgres answered for an admin, the stuck import included', async () => {
    const store = pgStore({ candidates: vi.fn(async () => clone(PG.candidatesAllCameIn)) });
    const res = await request(appWith('admin', store)).get('/api/impact/candidates?step=came_in&pageSize=5');
    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({ total: 22, hidden: 0, pageSize: 5 });
    expect(validateNamed(res.body, 'ImpactCandidatesResponse', SPEC)).toEqual([]);
  });
});

describe('GET /api/impact/candidates: the audit row', () => {
  it('one row per call: who (the actor), the filter and the counts, never a name or a candidate id', async () => {
    const entries = captureAudits();
    const res = await request(appWith('interviewer', scopedStore(), { userId: INTERVIEWER }))
      .get(`/api/impact/candidates?verdict=select&outcome=r1&from=2026-09-01&to=2026-11-10&job=${MAPPING}`);
    expect(res.status).toBe(200);
    expect(entries).toHaveLength(1);
    expect(entries[0]).toMatchObject({ event: 'resource.list', userId: INTERVIEWER, userRole: 'interviewer' });
    expect(entries[0].metadata).toEqual({
      resource: 'impact_candidates', job_mapping_id: MAPPING, from: '2026-09-01', to: '2026-11-10',
      verdict: 'select', outcome: 'r1', scope: 'owner', page: 1, page_size: 50, total: 2, hidden: 4, returned: 2,
    });
    const raw = JSON.stringify(entries[0]);
    for (const a of FIXTURE) {
      if (a.name) expect(raw).not.toContain(a.name);
      if (a.candidateId) expect(raw).not.toContain(a.candidateId);
    }
  });

  it('a step and a leave are recorded as filters too', async () => {
    const entries = captureAudits();
    await request(appWith('admin', scopedStore())).get('/api/impact/candidates?step=decided&dropped=true');
    await request(appWith('admin', scopedStore())).get('/api/impact/candidates?leaveStageId=stage-05-christy');
    expect(entries[0].metadata).toMatchObject({ resource: 'impact_candidates', step: 'decided', dropped: true, scope: 'all' });
    expect(entries[1].metadata).toMatchObject({ resource: 'impact_candidates', leave_stage_id: 'stage-05-christy', scope: 'all' });
  });

  it('fail-closed: if the audit row cannot be written, no name is sent (503)', async () => {
    vi.spyOn(console, 'error').mockImplementation(() => {});
    captureAudits(true);
    const res = await request(appWith('admin', scopedStore())).get('/api/impact/candidates?step=came_in');
    expect(res.status).toBe(503);
    expect(res.body).toEqual({ ok: false, error: 'impact_unavailable' });
    expect(JSON.stringify(res.body)).not.toContain('Own One');
  });
});

// ── The switch (admin) ───────────────────────────────────────────────────

describe('the per-mapping switch', () => {
  it('GET /exclusions lists every mapping and whether it counts, one audit row with counts', async () => {
    const entries = captureAudits();
    const res = await request(appWith('admin', pgStore())).get('/api/impact/exclusions');
    expect(res.status).toBe(200);
    expect(validateNamed(res.body, 'ImpactExclusionsResponse', SPEC)).toEqual([]);
    expect(res.body.mappings.length).toBeGreaterThan(0);
    expect(entries).toHaveLength(1);
    expect(entries[0].metadata).toMatchObject({ resource: 'ashby_impact_exclusions', count: res.body.mappings.length, truncated: false });
  });

  it.each([true, false, null])('PUT excluded=%s writes through the 0140 function with the admin as actor', async (excluded) => {
    const store = pgStore();
    const res = await request(appWith('admin', store)).put(`/api/impact/exclusions/${MAPPING}`).send({ excluded });
    expect(res.status).toBe(200);
    expect(store.setExclusion).toHaveBeenCalledWith(MAPPING, excluded, ADMIN);
    expect(validateNamed(res.body, 'ImpactExclusionUpdateResponse', SPEC)).toEqual([]);
    expect(res.body).toMatchObject({ ok: true, mappingId: MAPPING, excluded, archived: false, inImpact: false });
  });

  it.each([
    [{}],
    [{ excluded: 'yes' }],
    [{ excluded: true, reason: 'test' }],
  ])('PUT refuses the body %j', async (body) => {
    const store = pgStore();
    const res = await request(appWith('admin', store)).put(`/api/impact/exclusions/${MAPPING}`).send(body);
    expect(res.status).toBe(400);
    expect(res.body).toEqual({ ok: false, error: 'invalid_filter' });
    expect(store.setExclusion).not.toHaveBeenCalled();
  });

  it('PUT refuses a mapping id that is not a uuid, and answers 404 for one that does not exist', async () => {
    const store = pgStore({ setExclusion: vi.fn(async () => ({ status: 'not_found' })) });
    expect((await request(appWith('admin', store)).put('/api/impact/exclusions/abc').send({ excluded: true })).status).toBe(400);
    const res = await request(appWith('admin', store)).put(`/api/impact/exclusions/${MAPPING}`).send({ excluded: true });
    expect(res.status).toBe(404);
    expect(res.body).toEqual({ ok: false, error: 'not_found' });
  });

  it('a switch the database could not write is 503; a saved one survives a failed request trail', async () => {
    vi.spyOn(console, 'error').mockImplementation(() => {});
    const failing = pgStore({ setExclusion: vi.fn(async () => { throw new Error('audit refused'); }) });
    expect((await request(appWith('admin', failing)).put(`/api/impact/exclusions/${MAPPING}`).send({ excluded: true })).status).toBe(503);
    captureAudits(true);
    expect((await request(appWith('admin', pgStore())).put(`/api/impact/exclusions/${MAPPING}`).send({ excluded: true })).status).toBe(200);
  });
});

describe('ASHBY_PROGRESS_ENABLED', () => {
  it('is on only for exactly true', () => {
    expect(impactProgressEnabled({ ASHBY_PROGRESS_ENABLED: 'true' })).toBe(true);
    for (const v of [undefined, '', 'false', 'TRUE', '1', 'yes']) expect(impactProgressEnabled({ ASHBY_PROGRESS_ENABLED: v })).toBe(false);
  });
});

describe('the two helpers this slice adds', () => {
  it("hasRoleAtLeast is requireRole's own comparison", () => {
    expect(hasRoleAtLeast('admin', 'interviewer')).toBe(true);
    expect(hasRoleAtLeast('interviewer', 'interviewer')).toBe(true);
    expect(hasRoleAtLeast('viewer', 'interviewer')).toBe(false);
    expect(hasRoleAtLeast('interviewer', 'admin')).toBe(false);
    expect(hasRoleAtLeast(undefined, 'viewer')).toBe(false);
    expect(hasRoleAtLeast('owner' as never, 'viewer')).toBe(false);
  });

  it('recordAudit failClosed makes one informational entry fail-closed, and can only tighten', async () => {
    vi.spyOn(console, 'error').mockImplementation(() => {});
    captureAudits(true);
    const req = { authUser: { id: ADMIN, appRole: 'admin' }, method: 'GET', baseUrl: '/api/impact', path: '/candidates', ip: '10.0.0.1', socket: {} } as never;
    await expect(recordAudit(req, 'resource.list', 200, { metadata: { resource: 'x' } })).resolves.toBeUndefined();
    await expect(recordAudit(req, 'resource.list', 200, { failClosed: true, metadata: { resource: 'x' } })).rejects.toThrow(/fail-closed/);
    await expect(recordAudit(req, 'resource.update', 200, { failClosed: false, metadata: { resource: 'x' } })).rejects.toThrow(/fail-closed/);
  });
});
