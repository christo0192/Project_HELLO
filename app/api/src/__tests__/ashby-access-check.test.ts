/**
 * ashby-access-check.test.ts — M031 S1: which Ashby permissions does HELLO's
 * key hold for the business-impact page? (plan section 3, checks 10 and 11)
 *
 *   targets (enabled jobs + newest imported application)
 *   ─► REAL AshbyClient over a scripted fake tenant (no network)
 *   ─► per-permission ok / missing_permission / error / not_tried + counts
 *
 * The fake tenant answers in the shapes Ashby documents (API 2026-01-01):
 * jobInterviewPlan.info `{ jobId, interviewPlanId, stages[] }` with type and
 * plan order; listHistory rows `{ id, stageId, title, enteredStageAt,
 * leftStageAt, stageNumber, actorId }` with no type; a missing permission as
 * HTTP 403 OR HTTP 200 `{ success: false, errorInfo: { code:
 * 'missing_endpoint_permission' } }` (pinned in
 * ashby-recommendation-tag-contract.test.ts). Every id and name is synthetic.
 */
import { describe, expect, it, vi } from 'vitest';
import { createAshbyClient, type AshbyTransportRequest, type AshbyTransportResponse } from '../integrations/ashby/client.js';
import {
  ACCESS_CHECK_READ_OPERATIONS,
  assertAccessCheckReadOnly,
  classifyAccessError,
  createAshbyAccessCheckSource,
  runAccessCheck,
  type AccessCheckReader,
  type AccessCheckTargets,
} from '../integrations/ashby/access-check.js';
import { AshbyError } from '../integrations/ashby/errors.js';
import { ASHBY_OPERATIONS } from '../integrations/ashby/types.js';

// ── Synthetic tenant ────────────────────────────────────────────────────────

const JOB_A = 'job-a-0001';
const JOB_B = 'job-b-0002';
const PLAN = 'plan-0001';
const APP_IMPORTED = 'app-imported-0001';
const APP_HIRED = 'app-hired-0001';
const APP_ARCHIVED = 'app-archived-0001';
const CANDIDATE_ID = 'cand-0001';
const CANDIDATE_NAME = 'Synthetic Person';
const STAFF_ID = 'staff-user-0001';

const STAGES = [
  { id: 'st-lead', title: 'New Lead', type: 'Lead', orderInInterviewPlan: 0 },
  { id: 'st-christy', title: 'Hello Christy', type: 'PreInterviewScreen', orderInInterviewPlan: 1 },
  { id: 'st-r1', title: 'R1', type: 'Active', orderInInterviewPlan: 2, interviewStageGroupId: 'grp-r' },
  { id: 'st-r2', title: 'R2', type: 'Active', orderInInterviewPlan: 3, interviewStageGroupId: 'grp-r' },
  { id: 'st-offer', title: 'Offer', type: 'Offer', orderInInterviewPlan: 4 },
  { id: 'st-archived', title: 'Archived', type: 'Archived', orderInInterviewPlan: 5 },
  { id: 'st-hired', title: 'Hired', type: 'Hired', orderInInterviewPlan: 6 },
].map((s) => ({ ...s, interviewPlanId: PLAN }));

const plan = (jobId: string) => ({ jobId, interviewPlanId: PLAN, stages: STAGES });

function application(id: string, status: string) {
  return {
    id,
    status,
    createdAt: '2026-10-01T00:00:00.000Z',
    job: { id: JOB_A, title: 'Synthetic Engineer' },
    candidate: { id: CANDIDATE_ID, name: CANDIDATE_NAME, primaryEmailAddress: { value: 'synthetic@example.invalid' } },
    currentInterviewStage: { id: 'st-christy', title: 'Hello Christy', type: 'PreInterviewScreen', orderInInterviewPlan: 1 },
  };
}

/** A history row as documented: stage id and title, no type. */
function row(n: number, stageId: string, left = true) {
  return {
    id: `hist-${stageId}-${n}`,
    stageId,
    title: STAGES.find((s) => s.id === stageId)?.title ?? 'Old stage',
    enteredStageAt: `2026-10-0${n}T00:00:00.000Z`,
    ...(left ? { leftStageAt: `2026-10-0${n + 1}T00:00:00.000Z` } : {}),
    stageNumber: n,
    actorId: STAFF_ID,
    allowedActions: ['delete', 'set_entered_at'],
  };
}

const HISTORY: Record<string, unknown[]> = {
  [APP_IMPORTED]: [row(1, 'st-lead'), row(2, 'st-christy', false)],
  [APP_HIRED]: [row(1, 'st-christy'), row(2, 'st-r1'), row(3, 'st-r2'), row(4, 'st-offer'), row(5, 'st-hired', false)],
  // One row from a stage that is no longer on the job's plan.
  [APP_ARCHIVED]: [row(1, 'st-christy'), row(2, 'st-r1'), row(3, 'st-gone-from-plan'), row(4, 'st-archived', false)],
};

function json(status: number, body: unknown): AshbyTransportResponse {
  const text = JSON.stringify(body);
  return { status, ok: status >= 200 && status < 300, headers: { get: () => null }, text: async () => text };
}
const success = (results: unknown, extra: Record<string, unknown> = {}) => json(200, { success: true, results, ...extra });
const MISSING_200 = () => json(200, { success: false, errorInfo: { code: 'missing_endpoint_permission', message: 'no', requestId: 'r' } });
const MISSING_403 = () => json(403, { success: false, errorInfo: { code: 'missing_endpoint_permission' } });

type Route = (body: Record<string, unknown>, req: AshbyTransportRequest) => AshbyTransportResponse | Promise<AshbyTransportResponse>;
type Routes = Record<string, Route>;

const TENANT: Routes = {
  '/jobInterviewPlan.info': (body) => success(plan(String(body.jobId))),
  '/interviewStage.list': () => success(STAGES),
  '/application.info': () => success(application(APP_IMPORTED, 'Active')),
  '/application.listHistory': (body) => success(HISTORY[String(body.applicationId)] ?? [], { moreDataAvailable: false }),
  '/application.list': (body) => {
    if (body.status === 'Hired') return success([application(APP_HIRED, 'Hired')], { moreDataAvailable: true, nextCursor: 'c1' });
    if (body.status === 'Archived') return success([application(APP_ARCHIVED, 'Archived')], { moreDataAvailable: true, nextCursor: 'c2' });
    return success([]);
  },
};

function tenant(overrides: Routes = {}, clientOptions: Record<string, unknown> = {}) {
  const routes = { ...TENANT, ...overrides };
  const requests: Array<{ path: string; body: Record<string, unknown> }> = [];
  const client = createAshbyClient({
    apiKey: 'SYNTHETIC_KEY',
    maxAttempts: 1,
    random: () => 0.5,
    sleep: async () => {},
    ...clientOptions,
    transport: async (req) => {
      const path = new URL(req.url).pathname;
      const body = JSON.parse(req.body) as Record<string, unknown>;
      requests.push({ path, body });
      const route = routes[path];
      if (!route) throw new Error(`unexpected call to ${path}`);
      return route(body, req);
    },
  });
  return { client, requests };
}

const TARGETS: AccessCheckTargets = {
  enabledMappings: 2,
  jobIds: [JOB_A, JOB_B],
  truncated: false,
  imported: { applicationId: APP_IMPORTED, jobId: JOB_A },
};

const SECRETS = [
  JOB_A, JOB_B, PLAN, APP_IMPORTED, APP_HIRED, APP_ARCHIVED, CANDIDATE_ID, CANDIDATE_NAME, STAFF_ID,
  'synthetic@example.invalid', 'st-', 'hist-', 'grp-r', 'Hello Christy', 'Synthetic Engineer', 'SYNTHETIC_KEY',
];

const OK = { state: 'ok', error: null };

// ── The documented happy path ───────────────────────────────────────────────

describe('every permission granted', () => {
  it('reports ok for each permission, with per-operation call counts', async () => {
    const t = tenant();
    const r = await runAccessCheck(t.client, TARGETS);
    expect(r.permissions).toEqual({ candidatesRead: OK, jobsRead: OK, interviewsRead: OK });
    expect(r.operations).toEqual({
      applicationInfo: { ...OK, calls: 1, ok: 1, missingPermission: 0, failed: 0 },
      // imported + hired + archived
      applicationListHistory: { ...OK, calls: 3, ok: 3, missingPermission: 0, failed: 0 },
      // Hired, then Archived: each found on the first job.
      applicationList: { ...OK, calls: 2, ok: 2, missingPermission: 0, failed: 0 },
      jobInterviewPlanInfo: { ...OK, calls: 2, ok: 2, missingPermission: 0, failed: 0 },
      // Both jobs share one plan: one stage list.
      interviewStageList: { ...OK, calls: 1, ok: 1, missingPermission: 0, failed: 0 },
    });
    expect(r.mappings).toEqual({ enabled: 2, jobsChecked: 2, truncated: false });
    expect(r.deadlineHit).toBe(false);
  });

  it('counts the stage types in a hired and an archived history by matching stage ids to the job plan', async () => {
    const r = await runAccessCheck(tenant().client, TARGETS);
    expect(r.samples.hired).toEqual({
      ...OK,
      found: true,
      history: {
        rows: 5, matched: 5, unmatched: 0, truncated: false,
        // In plan order of each type's first stage.
        stageTypes: [
          { type: 'PreInterviewScreen', count: 1 },
          { type: 'Active', count: 2 },
          { type: 'Offer', count: 1 },
          { type: 'Hired', count: 1 },
        ],
      },
    });
    expect(r.samples.archived).toEqual({
      ...OK,
      found: true,
      history: {
        rows: 4, matched: 3, unmatched: 1, truncated: false,
        stageTypes: [
          { type: 'PreInterviewScreen', count: 1 },
          { type: 'Active', count: 1 },
          { type: 'Archived', count: 1 },
        ],
      },
    });
    expect(r.samples.imported).toEqual({
      ...OK,
      found: true,
      history: {
        rows: 2, matched: 2, unmatched: 0, truncated: false,
        stageTypes: [{ type: 'Lead', count: 1 }, { type: 'PreInterviewScreen', count: 1 }],
      },
    });
  });

  it('sends exactly the documented read bodies, and only reads', async () => {
    const t = tenant();
    await runAccessCheck(t.client, TARGETS);
    const byPath = (p: string) => t.requests.filter((q) => q.path === p).map((q) => q.body);
    expect(byPath('/jobInterviewPlan.info')).toEqual([{ jobId: JOB_A }, { jobId: JOB_B }]);
    expect(byPath('/interviewStage.list')).toEqual([{ interviewPlanId: PLAN }]);
    expect(byPath('/application.info')).toEqual([{ applicationId: APP_IMPORTED }]);
    expect(byPath('/application.list')).toEqual([
      { jobId: JOB_A, status: 'Hired', limit: 1 },
      { jobId: JOB_A, status: 'Archived', limit: 1 },
    ]);
    expect(byPath('/application.listHistory')).toEqual([
      { applicationId: APP_IMPORTED, limit: 100 },
      { applicationId: APP_HIRED, limit: 100 },
      { applicationId: APP_ARCHIVED, limit: 100 },
    ]);
    const allowed = new Set(ACCESS_CHECK_READ_OPERATIONS.map((op) => ASHBY_OPERATIONS[op].path));
    for (const q of t.requests) {
      expect(allowed.has(q.path), q.path).toBe(true);
    }
  });

  it('returns no id, name, title or actor: only states, counts and stage types', async () => {
    const r = await runAccessCheck(tenant().client, TARGETS);
    const text = JSON.stringify(r);
    for (const secret of SECRETS) expect(text, secret).not.toContain(secret);
  });

  it('looks on the next job when the first has no hired application', async () => {
    const t = tenant({
      '/application.list': (body) => {
        if (body.status === 'Hired' && body.jobId === JOB_B) return success([application(APP_HIRED, 'Hired')]);
        return success([]);
      },
    });
    const r = await runAccessCheck(t.client, TARGETS);
    expect(t.requests.filter((q) => q.path === '/application.list').map((q) => [q.body.jobId, q.body.status])).toEqual([
      [JOB_A, 'Hired'], [JOB_B, 'Hired'], [JOB_A, 'Archived'], [JOB_B, 'Archived'],
    ]);
    expect(r.samples.hired).toMatchObject({ state: 'ok', found: true, history: { matched: 5 } });
    expect(r.samples.archived).toEqual({ ...OK, found: false, history: null });
  });
});

// ── Missing permissions, both documented shapes ─────────────────────────────

describe('a missing permission', () => {
  it('HTTP 403 on interviewStage.list: Interviews read is missing, the rest still ok', async () => {
    const r = await runAccessCheck(tenant({ '/interviewStage.list': MISSING_403 }).client, TARGETS);
    expect(r.permissions.interviewsRead).toEqual({ state: 'missing_permission', error: null });
    expect(r.operations.interviewStageList).toMatchObject({ state: 'missing_permission', calls: 1, missingPermission: 1 });
    expect(r.permissions.jobsRead).toEqual(OK);
    expect(r.permissions.candidatesRead).toEqual(OK);
  });

  it('HTTP 200 success:false missing_endpoint_permission on listHistory: Candidates read is missing', async () => {
    const r = await runAccessCheck(tenant({ '/application.listHistory': MISSING_200 }).client, TARGETS);
    expect(r.permissions.candidatesRead).toEqual({ state: 'missing_permission', error: null });
    expect(r.operations.applicationListHistory).toMatchObject({ state: 'missing_permission', calls: 3, missingPermission: 3, ok: 0 });
    // application.info still answered: the operation view keeps them apart.
    expect(r.operations.applicationInfo).toMatchObject({ state: 'ok', ok: 1 });
    expect(r.samples.hired).toEqual({ state: 'missing_permission', error: null, found: true, history: null });
    expect(r.samples.imported).toEqual({ state: 'missing_permission', error: null, found: true, history: null });
  });

  it('HTTP 403 on application.list: the samples cannot be looked for', async () => {
    const r = await runAccessCheck(tenant({ '/application.list': MISSING_403 }).client, TARGETS);
    expect(r.permissions.candidatesRead.state).toBe('missing_permission');
    expect(r.samples.hired).toEqual({ state: 'missing_permission', error: null, found: null, history: null });
    expect(r.samples.archived).toEqual({ state: 'missing_permission', error: null, found: null, history: null });
    // The imported sample does not depend on application.list.
    expect(r.samples.imported.state).toBe('ok');
  });

  it('HTTP 403 on jobInterviewPlan.info: Jobs read is missing, the stage list is not tried, history is not matched', async () => {
    const t = tenant({ '/jobInterviewPlan.info': MISSING_403 });
    const r = await runAccessCheck(t.client, TARGETS);
    expect(r.permissions.jobsRead).toEqual({ state: 'missing_permission', error: null });
    expect(r.operations.jobInterviewPlanInfo).toMatchObject({ calls: 2, missingPermission: 2 });
    // No plan id was read, so there is no plan to list: not tried, and no call made.
    expect(r.permissions.interviewsRead).toEqual({ state: 'not_tried', error: null });
    expect(t.requests.some((q) => q.path === '/interviewStage.list')).toBe(false);
    expect(r.samples.hired.history).toEqual({ rows: 5, matched: null, unmatched: null, truncated: false, stageTypes: [] });
  });

  it('a missing endpoint on one call outranks an ok on another for the same permission', async () => {
    const r = await runAccessCheck(tenant({ '/application.info': MISSING_200 }).client, TARGETS);
    expect(r.operations.applicationListHistory.state).toBe('ok');
    expect(r.permissions.candidatesRead).toEqual({ state: 'missing_permission', error: null });
  });

  it('HTTP 403 naming the code in the `errors` string list is also a missing permission', async () => {
    const missing = () => json(403, { success: false, errors: ['missing_endpoint_permission'] });
    const r = await runAccessCheck(tenant({ '/interviewStage.list': missing }).client, TARGETS);
    expect(r.permissions.interviewsRead).toEqual({ state: 'missing_permission', error: null });
  });
});

// ── A 403 WITHOUT missing_endpoint_permission: the key itself was refused ───
//
// Ashby: "When the provided key is wrong or deactivated, the API will respond
// with a 403 status code"; a missing module is a 403 "and an error of
// missing_endpoint_permission". Only the code tells them apart.

describe('a 403 that does not name missing_endpoint_permission', () => {
  const REJECTED_KEY = () => ({
    status: 403, ok: false, headers: { get: () => null }, text: async () => 'Forbidden: this API key is deactivated',
  });

  it('a wrong or deactivated key (403 on every call) reads as forbidden, never as missing modules', async () => {
    const routes = Object.fromEntries(Object.keys(TENANT).map((p) => [p, REJECTED_KEY])) as Routes;
    const r = await runAccessCheck(tenant(routes).client, TARGETS);
    expect(r.permissions.candidatesRead).toEqual({ state: 'error', error: 'forbidden' });
    expect(r.permissions.jobsRead).toEqual({ state: 'error', error: 'forbidden' });
    // No plan was read, so there is no plan to list.
    expect(r.permissions.interviewsRead).toEqual({ state: 'not_tried', error: null });
    for (const op of Object.values(r.operations)) expect(op.missingPermission).toBe(0);
    expect(r.operations.jobInterviewPlanInfo).toMatchObject({ state: 'error', error: 'forbidden', calls: 2, failed: 2 });
    expect(JSON.stringify(r)).not.toContain('deactivated');
  });

  it('a 403 with some other code is forbidden too', async () => {
    const other = () => json(403, { success: false, errorInfo: { code: 'invalid_api_key', message: 'no' } });
    const r = await runAccessCheck(tenant({ '/interviewStage.list': other }).client, TARGETS);
    expect(r.permissions.interviewsRead).toEqual({ state: 'error', error: 'forbidden' });
    expect(r.permissions.jobsRead).toEqual(OK);
  });
});

// ── Other failures: a coarse code, never a guess ────────────────────────────

describe('a call that fails for another reason', () => {
  it('a timeout reports error: timeout', async () => {
    const hang: Route = (_body, req) => new Promise((_, reject) => {
      req.signal.addEventListener('abort', () => {
        const e = new Error('aborted');
        e.name = 'AbortError';
        reject(e);
      });
    });
    const r = await runAccessCheck(tenant({ '/interviewStage.list': hang }, { timeoutMs: 20 }).client, TARGETS);
    expect(r.permissions.interviewsRead).toEqual({ state: 'error', error: 'timeout' });
    expect(r.operations.interviewStageList).toMatchObject({ state: 'error', error: 'timeout', calls: 1, failed: 1 });
  });

  it.each([
    [503, 'server_error'],
    [429, 'rate_limited'],
    [401, 'unauthorized'],
    [403, 'forbidden'],
    [404, 'not_found'],
    [400, 'client_error'],
  ] as const)('HTTP %i reports error: %s', async (status, code) => {
    const r = await runAccessCheck(tenant({ '/interviewStage.list': () => json(status, {}) }).client, TARGETS);
    expect(r.permissions.interviewsRead).toEqual({ state: 'error', error: code });
  });

  it('an ordinary success:false refusal is a logical failure, not a missing permission', async () => {
    const refused = () => json(200, { success: false, errors: [{ message: 'Synthetic Person not found', parameter: 'applicationId' }] });
    const r = await runAccessCheck(tenant({ '/application.info': refused }).client, TARGETS);
    expect(r.operations.applicationInfo).toMatchObject({ state: 'error', error: 'logical_failure' });
    // Other Candidates-read calls answered, so the permission itself is proven.
    expect(r.permissions.candidatesRead).toEqual(OK);
    expect(JSON.stringify(r)).not.toContain('Synthetic Person');
  });

  it('an unparseable body is malformed_response', async () => {
    const r = await runAccessCheck(tenant({
      '/interviewStage.list': () => ({ status: 200, ok: true, headers: { get: () => null }, text: async () => '<html>' }),
    }).client, TARGETS);
    expect(r.permissions.interviewsRead).toEqual({ state: 'error', error: 'malformed_response' });
  });

  it('an error that is not an AshbyError is unknown, and its text never travels', async () => {
    const reader = readerFrom({ interviewStageList: async () => { throw new Error('tenant xyz exploded'); } });
    const r = await runAccessCheck(reader, TARGETS);
    expect(r.permissions.interviewsRead).toEqual({ state: 'error', error: 'unknown' });
    expect(JSON.stringify(r)).not.toContain('tenant xyz');
  });

  it('a status filter Ashby did not honour is reported, and that application is not read', async () => {
    const t = tenant({ '/application.list': () => success([application(APP_HIRED, 'Active')]) });
    const r = await runAccessCheck(t.client, TARGETS);
    expect(r.samples.hired).toEqual({ state: 'error', error: 'status_unconfirmed', found: null, history: null });
    expect(t.requests.filter((q) => q.path === '/application.listHistory').map((q) => q.body.applicationId))
      .toEqual([APP_IMPORTED]);
  });
});

// ── Empty data and nothing to try ───────────────────────────────────────────

describe('empty data', () => {
  it('no enabled mapping: every permission is not tried and Ashby is never called', async () => {
    const t = tenant();
    const r = await runAccessCheck(t.client, { enabledMappings: 0, jobIds: [], truncated: false, imported: null });
    expect(t.requests).toEqual([]);
    for (const p of Object.values(r.permissions)) expect(p).toEqual({ state: 'not_tried', error: null });
    for (const op of Object.values(r.operations)) expect(op).toMatchObject({ state: 'not_tried', calls: 0 });
    expect(r.samples.imported).toEqual({ state: 'not_tried', error: null, found: false, history: null });
    expect(r.samples.hired).toEqual({ state: 'not_tried', error: null, found: null, history: null });
    expect(r.mappings).toEqual({ enabled: 0, jobsChecked: 0, truncated: false });
  });

  it('no imported application: application.info and its history are not tried', async () => {
    const t = tenant();
    const r = await runAccessCheck(t.client, { ...TARGETS, imported: null });
    expect(r.operations.applicationInfo).toMatchObject({ state: 'not_tried', calls: 0 });
    expect(r.samples.imported).toEqual({ state: 'not_tried', error: null, found: false, history: null });
    expect(t.requests.some((q) => q.path === '/application.info')).toBe(false);
  });

  it('an empty plan, an empty list and an empty history are answers, not failures', async () => {
    const t = tenant({
      '/jobInterviewPlan.info': () => success({}),
      '/application.list': () => success([]),
      '/application.listHistory': () => success([]),
    });
    const r = await runAccessCheck(t.client, TARGETS);
    expect(r.permissions.jobsRead).toEqual(OK);
    // An empty plan names no plan id: nothing to list.
    expect(r.permissions.interviewsRead).toEqual({ state: 'not_tried', error: null });
    expect(r.samples.hired).toEqual({ ...OK, found: false, history: null });
    expect(r.samples.imported).toEqual({
      ...OK, found: true, history: { rows: 0, matched: 0, unmatched: 0, truncated: false, stageTypes: [] },
    });
  });

  it('a history page with more data says truncated', async () => {
    const t = tenant({
      '/application.listHistory': () => success([row(1, 'st-christy')], { moreDataAvailable: true, nextCursor: 'more' }),
    });
    const r = await runAccessCheck(t.client, TARGETS);
    expect(r.samples.imported.history?.truncated).toBe(true);
  });
});

// ── Bounds and the deadline ─────────────────────────────────────────────────

/** A fake reader whose every method succeeds with documented-looking data unless overridden. */
function readerFrom(over: Partial<Record<keyof AccessCheckReader, (...args: never[]) => Promise<unknown>>> = {}) {
  const base = {
    jobInterviewPlanInfo: vi.fn(async (jobId: string) => ({ results: plan(jobId) })),
    interviewStageList: vi.fn(async () => ({ results: STAGES })),
    applicationInfo: vi.fn(async () => ({ results: application(APP_IMPORTED, 'Active') })),
    applicationListHistory: vi.fn(async (p: { applicationId: string }) => ({ results: HISTORY[p.applicationId] ?? [], moreDataAvailable: false })),
    applicationList: vi.fn(async (p: { status?: string }) => ({
      results: p.status === 'Hired' ? [application(APP_HIRED, 'Hired')] : [application(APP_ARCHIVED, 'Archived')],
      moreDataAvailable: false,
    })),
  };
  return { ...base, ...over } as unknown as AccessCheckReader & typeof base;
}

describe('bounds', () => {
  it('reads at most five jobs\' plans and says the list was cut', async () => {
    const reader = readerFrom();
    const jobIds = Array.from({ length: 7 }, (_, i) => `job-${i}`);
    const r = await runAccessCheck(reader, { enabledMappings: 7, jobIds, truncated: false, imported: null });
    expect(reader.jobInterviewPlanInfo).toHaveBeenCalledTimes(5);
    expect(r.mappings).toEqual({ enabled: 7, jobsChecked: 5, truncated: true });
  });

  it('carries the source\'s own truncation through', async () => {
    const r = await runAccessCheck(readerFrom(), { ...TARGETS, truncated: true });
    expect(r.mappings.truncated).toBe(true);
  });

  it('ignores a job id that is not opaque-id shaped, and a repeated one', async () => {
    const reader = readerFrom();
    await runAccessCheck(reader, { enabledMappings: 3, jobIds: [JOB_A, 'has space', JOB_A], truncated: false, imported: null });
    expect(reader.jobInterviewPlanInfo).toHaveBeenCalledTimes(1);
  });
});

describe('one deadline for the whole check', () => {
  it('passes the same deadline to every call', async () => {
    const reader = readerFrom();
    const start = Date.now();
    await runAccessCheck(reader, TARGETS);
    const deadlines = [
      ...reader.jobInterviewPlanInfo.mock.calls.map((c) => (c as unknown[])[2] as { deadlineAt: number }),
      ...reader.interviewStageList.mock.calls.map((c) => (c as unknown[])[0] as { deadlineAt: number }),
      ...reader.applicationList.mock.calls.map((c) => (c as unknown[])[0] as { deadlineAt: number }),
    ].map((o) => o.deadlineAt);
    expect(new Set(deadlines).size).toBe(1);
    expect(deadlines[0]).toBeGreaterThan(start);
    expect(deadlines[0]).toBeLessThanOrEqual(start + 25_000 + 1_000);
  });

  it('calls left when the deadline runs out are not tried, flagged deadline, and never made', async () => {
    const reader = readerFrom();
    let t = Date.now();
    // The clock jumps past the deadline once the two plan reads are done.
    reader.jobInterviewPlanInfo.mockImplementation(async (jobId: string) => {
      if (jobId === JOB_B) t += 60_000;
      return { results: plan(jobId) };
    });
    const r = await runAccessCheck(reader, TARGETS, { now: () => t });
    expect(r.deadlineHit).toBe(true);
    expect(r.permissions.jobsRead).toEqual(OK);
    expect(r.permissions.interviewsRead).toEqual({ state: 'not_tried', error: 'deadline' });
    expect(r.permissions.candidatesRead).toEqual({ state: 'not_tried', error: 'deadline' });
    expect(r.samples.hired).toEqual({ state: 'not_tried', error: 'deadline', found: null, history: null });
    expect(r.samples.imported).toEqual({ state: 'not_tried', error: 'deadline', found: true, history: null });
    expect(reader.interviewStageList).not.toHaveBeenCalled();
    expect(reader.applicationInfo).not.toHaveBeenCalled();
    expect(reader.applicationList).not.toHaveBeenCalled();
  });
});

// ── Read-only by construction ───────────────────────────────────────────────

describe('read-only by construction', () => {
  it('its operation allowlist holds reads only', () => {
    for (const op of ACCESS_CHECK_READ_OPERATIONS) {
      expect(ASHBY_OPERATIONS[op].mutation, op).toBe(false);
      expect(() => assertAccessCheckReadOnly(op)).not.toThrow();
    }
  });

  it('refuses every mutating operation, and reads it has no business making', () => {
    const mutating = Object.entries(ASHBY_OPERATIONS).filter(([, s]) => s.mutation).map(([name]) => name);
    expect(mutating.length).toBeGreaterThanOrEqual(3);
    for (const op of [...mutating, 'candidate.info', 'file.info', 'applicationFeedback.list', 'made.up']) {
      expect(() => assertAccessCheckReadOnly(op), op).toThrow('ashby_access_check_operation_not_allowed');
    }
  });
});

describe('classifyAccessError', () => {
  const err = (category: ConstructorParameters<typeof AshbyError>[0], init: ConstructorParameters<typeof AshbyError>[1] = {}) =>
    new AshbyError(category, init);

  it.each([
    [err('http_client_error', { httpStatus: 403, endpointCodes: ['missing_endpoint_permission'] }), { state: 'missing_permission', error: null }],
    // A bare 403 is a wrong or deactivated key as often as a missing module.
    [err('http_client_error', { httpStatus: 403 }), { state: 'error', error: 'forbidden' }],
    [err('http_client_error', { httpStatus: 403, endpointCodes: ['invalid_api_key'] }), { state: 'error', error: 'forbidden' }],
    // The code means a missing module only on the two documented answers.
    [err('http_client_error', { httpStatus: 404, endpointCodes: ['missing_endpoint_permission'] }), { state: 'error', error: 'not_found' }],
    [err('logical_failure', { httpStatus: 200, endpointCodes: ['missing_endpoint_permission'] }), { state: 'missing_permission', error: null }],
    [err('logical_failure', { httpStatus: 200, endpointCodes: ['MISSING_ENDPOINT_PERMISSION'] }), { state: 'missing_permission', error: null }],
    [err('http_client_error', { httpStatus: 401 }), { state: 'error', error: 'unauthorized' }],
    [err('retry_exhausted', { code: 'http_server_error', httpStatus: 502 }), { state: 'error', error: 'server_error' }],
    [err('retry_exhausted', { code: 'rate_limited', httpStatus: 429 }), { state: 'error', error: 'rate_limited' }],
    [err('retry_exhausted', { code: 'timeout' }), { state: 'error', error: 'timeout' }],
    [err('retry_exhausted', { code: 'network' }), { state: 'error', error: 'network' }],
    [err('timeout', { code: 'deadline_exceeded' }), { state: 'error', error: 'timeout' }],
    [err('output_limit'), { state: 'error', error: 'output_limit' }],
    [err('invalid_request', { code: 'invalid_id' }), { state: 'error', error: 'invalid_request' }],
    ['not an error', { state: 'error', error: 'unknown' }],
  ] as const)('%#', (input, expected) => {
    expect(classifyAccessError(input)).toEqual(expected);
  });
});

// ── The database side: reads only, enabled mappings only ────────────────────

/** A recording stand-in for the Supabase query builder. Reads only: no write method exists on it. */
function fakeDb(tables: Record<string, { data: unknown; error: unknown }>) {
  const calls: Array<{ table: string; ops: Array<[string, unknown[]]> }> = [];
  const client = {
    from(table: string) {
      const entry = { table, ops: [] as Array<[string, unknown[]]> };
      calls.push(entry);
      const builder: Record<string, unknown> = {};
      for (const m of ['select', 'eq', 'is', 'in', 'order', 'limit']) {
        builder[m] = (...args: unknown[]) => { entry.ops.push([m, args]); return builder; };
      }
      builder.then = (resolve: (v: unknown) => unknown, reject: (e: unknown) => unknown) =>
        Promise.resolve(tables[table] ?? { data: [], error: null }).then(resolve, reject);
      return builder;
    },
  };
  return { client, calls };
}

const M1 = '11111111-1111-4111-8111-111111111111';
const M2 = '22222222-2222-4222-8222-222222222222';

describe('createAshbyAccessCheckSource', () => {
  it('reads enabled, live mappings and the newest live link among them, and nothing else', async () => {
    const db = fakeDb({
      ashby_job_mappings: { data: [{ id: M1, external_job_id: JOB_A }, { id: M2, external_job_id: JOB_A }], error: null },
      ashby_application_links: { data: [{ external_application_id: APP_IMPORTED, job_mapping_id: M2 }], error: null },
    });
    const targets = await createAshbyAccessCheckSource(db.client as never).readTargets();
    expect(targets).toEqual({
      enabledMappings: 2,
      jobIds: [JOB_A],
      truncated: false,
      imported: { applicationId: APP_IMPORTED, jobId: JOB_A },
    });
    const [mappings, links] = db.calls;
    expect(mappings.table).toBe('ashby_job_mappings');
    expect(mappings.ops).toEqual(expect.arrayContaining([
      ['eq', ['provider', 'ashby']], ['eq', ['status', 'enabled']], ['is', ['archived_at', null]],
    ]));
    expect(links.table).toBe('ashby_application_links');
    expect(links.ops).toEqual(expect.arrayContaining([
      ['in', ['job_mapping_id', [M1, M2]]],
      ['is', ['terminal_state', null]],
      ['order', ['created_at', { ascending: false }]],
      ['limit', [1]],
    ]));
    expect(db.calls).toHaveLength(2);
  });

  it('no enabled mapping: no link read, nothing to try', async () => {
    const db = fakeDb({ ashby_job_mappings: { data: [], error: null } });
    const targets = await createAshbyAccessCheckSource(db.client as never).readTargets();
    expect(targets).toEqual({ enabledMappings: 0, jobIds: [], truncated: false, imported: null });
    expect(db.calls).toHaveLength(1);
  });

  it('drops rows whose ids are not well formed rather than calling Ashby with them', async () => {
    const db = fakeDb({
      ashby_job_mappings: { data: [{ id: M1, external_job_id: 'has space' }, { id: 'not-a-uuid', external_job_id: JOB_B }], error: null },
    });
    const targets = await createAshbyAccessCheckSource(db.client as never).readTargets();
    expect(targets.jobIds).toEqual([]);
    expect(targets.imported).toBeNull();
  });

  it('says so when there are more enabled mappings than it reads', async () => {
    const many = Array.from({ length: 51 }, (_, i) => ({
      id: `${String(i).padStart(8, '0')}-1111-4111-8111-111111111111`,
      external_job_id: `job-${i}`,
    }));
    const db = fakeDb({ ashby_job_mappings: { data: many, error: null }, ashby_application_links: { data: [], error: null } });
    const targets = await createAshbyAccessCheckSource(db.client as never).readTargets();
    expect(targets.enabledMappings).toBe(50);
    expect(targets.truncated).toBe(true);
  });

  it.each(['ashby_job_mappings', 'ashby_application_links'])('a read error on %s throws, with no detail', async (table) => {
    const db = fakeDb({
      ashby_job_mappings: table === 'ashby_job_mappings'
        ? { data: null, error: { message: 'secret detail' } }
        : { data: [{ id: M1, external_job_id: JOB_A }], error: null },
      ashby_application_links: { data: null, error: { message: 'secret detail' } },
    });
    await expect(createAshbyAccessCheckSource(db.client as never).readTargets()).rejects.toThrow(/^ashby_access_check_/);
  });
});
