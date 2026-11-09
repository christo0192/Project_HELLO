/**
 * GET /api/integrations/ashby/mission-control/access-check — M031 S1.
 *
 * Admin only. Read-only. Answers per-permission states, counts and stage
 * types; never an application, candidate, job, plan, stage or actor id, and
 * never a name or title. One audit row per request, counts only.
 *
 * Zero network: the Ashby reader and HELLO's target source are injected.
 */
import { describe, it, expect, vi } from 'vitest';
import express, { type Request, type Response, type NextFunction } from 'express';
import request from 'supertest';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';
import { createAshbyMissionControlRouter, type AshbyMissionControlDeps } from '../routes/ashby-mission-control.js';
import { setAuditSink, getAuditSink, type AuditEntry } from '../lib/audit.js';
import { ACCESS_ERROR_CODES, ACCESS_STATES, type AccessCheckTargets } from '../integrations/ashby/access-check.js';
import { AshbyError } from '../integrations/ashby/errors.js';
import { parseYamlDocument, validateNamed } from './support/openapi-schema.js';

const SPEC = parseYamlDocument(readFileSync(resolve(dirname(fileURLToPath(import.meta.url)), '../../openapi/openapi.yaml'), 'utf8'));

const JOB_A = 'job-a-0001';
const JOB_B = 'job-b-0002';
const PLAN = 'plan-0001';
const APP_IMPORTED = 'app-imported-0001';
const APP_HIRED = 'app-hired-0001';
const APP_ARCHIVED = 'app-archived-0001';
const CANDIDATE_ID = 'cand-0001';
const CANDIDATE_NAME = 'Synthetic Person';
const STAFF_ID = 'staff-user-0001';
const MAPPING_ID = '33333333-3333-4333-8333-333333333333';

const STAGE_TYPES = ['Lead', 'PreInterviewScreen', 'Active', 'Offer', 'Archived', 'Hired'];
const STAGES = [
  { id: 'st-lead', title: 'New Lead', type: 'Lead', orderInInterviewPlan: 0, interviewPlanId: PLAN },
  { id: 'st-christy', title: 'Hello Christy', type: 'PreInterviewScreen', orderInInterviewPlan: 1, interviewPlanId: PLAN },
  { id: 'st-r1', title: 'R1', type: 'Active', orderInInterviewPlan: 2, interviewPlanId: PLAN },
  { id: 'st-offer', title: 'Offer', type: 'Offer', orderInInterviewPlan: 3, interviewPlanId: PLAN },
  { id: 'st-archived', title: 'Archived', type: 'Archived', orderInInterviewPlan: 4, interviewPlanId: PLAN },
  { id: 'st-hired', title: 'Hired', type: 'Hired', orderInInterviewPlan: 5, interviewPlanId: PLAN },
];
const hist = (stageId: string, n: number) => ({ id: `hist-${n}`, stageId, title: 'Hello Christy', enteredStageAt: '2026-10-01T00:00:00Z', actorId: STAFF_ID });
const application = (id: string, status: string) => ({
  id, status, candidate: { id: CANDIDATE_ID, name: CANDIDATE_NAME }, job: { id: JOB_A, title: 'Synthetic Engineer' },
});

const TARGETS: AccessCheckTargets = {
  enabledMappings: 2,
  jobIds: [JOB_A, JOB_B],
  truncated: false,
  imported: { applicationId: APP_IMPORTED, jobId: JOB_A },
};

const SECRETS = [
  JOB_A, JOB_B, PLAN, APP_IMPORTED, APP_HIRED, APP_ARCHIVED, CANDIDATE_ID, CANDIDATE_NAME, STAFF_ID, MAPPING_ID,
  'st-', 'hist-', 'Hello Christy', 'Synthetic Engineer',
];

function fakeReader() {
  return {
    jobInterviewPlanInfo: vi.fn(async (jobId: string) => ({ results: { jobId, interviewPlanId: PLAN, stages: STAGES } })),
    interviewStageList: vi.fn(async () => ({ results: STAGES })),
    applicationInfo: vi.fn(async () => ({ results: application(APP_IMPORTED, 'Active') })),
    applicationListHistory: vi.fn(async (p: { applicationId: string }) => ({
      results: p.applicationId === APP_HIRED
        ? [hist('st-christy', 1), hist('st-r1', 2), hist('st-offer', 3), hist('st-hired', 4)]
        : [hist('st-christy', 1), hist('st-archived', 2)],
      moreDataAvailable: false,
    })),
    applicationList: vi.fn(async (p: { status?: string }) => ({
      results: [application(p.status === 'Hired' ? APP_HIRED : APP_ARCHIVED, String(p.status))],
      moreDataAvailable: false,
    })),
  };
}

function fakeSource(targets: AccessCheckTargets = TARGETS) {
  return { readTargets: vi.fn(async () => targets) };
}

function appWith(role: string | null, deps: AshbyMissionControlDeps, before?: express.RequestHandler) {
  const app = express();
  app.use(express.json());
  if (before) app.use(before);
  app.use((req: Request, _res: Response, next: NextFunction) => {
    if (role) (req as unknown as { authUser: unknown }).authUser = { id: MAPPING_ID, appRole: role };
    next();
  });
  // The store is never touched by this route; an empty stand-in proves it.
  app.use('/mc', createAshbyMissionControlRouter({ store: {} as never, ...deps }));
  return app;
}

async function withAudits<T>(fn: (entries: AuditEntry[]) => Promise<T>): Promise<T> {
  const entries: AuditEntry[] = [];
  const previous = getAuditSink();
  setAuditSink(async (entry) => { entries.push(entry); });
  try { return await fn(entries); } finally { setAuditSink(previous); }
}

/** Every leaf of a JSON value as a dotted path, arrays as `[]`. */
function leafPaths(value: unknown, path = ''): string[] {
  if (Array.isArray(value)) return value.flatMap((v) => leafPaths(v, `${path}[]`));
  if (value !== null && typeof value === 'object') {
    return Object.entries(value as Record<string, unknown>).flatMap(([k, v]) => leafPaths(v, path ? `${path}.${k}` : k));
  }
  return [path];
}

function allowedPaths(): Set<string> {
  const out = new Set<string>(['ok', 'deadlineHit', 'mappings.enabled', 'mappings.jobsChecked', 'mappings.truncated']);
  for (const p of ['candidatesRead', 'jobsRead', 'interviewsRead']) {
    for (const f of ['state', 'error']) out.add(`permissions.${p}.${f}`);
  }
  for (const o of ['applicationInfo', 'applicationListHistory', 'applicationList', 'jobInterviewPlanInfo', 'interviewStageList']) {
    for (const f of ['state', 'error', 'calls', 'ok', 'missingPermission', 'failed']) out.add(`operations.${o}.${f}`);
  }
  for (const s of ['imported', 'hired', 'archived']) {
    for (const f of ['state', 'error', 'found', 'history']) out.add(`samples.${s}.${f}`);
    for (const f of ['rows', 'matched', 'unmatched', 'truncated']) out.add(`samples.${s}.history.${f}`);
    out.add(`samples.${s}.history.stageTypes`);
    out.add(`samples.${s}.history.stageTypes[].type`);
    out.add(`samples.${s}.history.stageTypes[].count`);
  }
  return out;
}

describe('GET /access-check — admin only', () => {
  it.each(['interviewer', 'viewer'])('%s gets 403 and no Ashby or database read happens', async (role) => {
    const reader = fakeReader();
    const source = fakeSource();
    const res = await request(appWith(role, { accessCheckReader: reader as never, accessCheckSource: source }))
      .get('/mc/access-check');
    expect(res.status).toBe(403);
    expect(source.readTargets).not.toHaveBeenCalled();
    expect(reader.jobInterviewPlanInfo).not.toHaveBeenCalled();
  });

  it('an unauthenticated request gets 403', async () => {
    const res = await request(appWith(null, { accessCheckReader: fakeReader() as never, accessCheckSource: fakeSource() }))
      .get('/mc/access-check');
    expect(res.status).toBe(403);
  });

  it('an admin gets 200 with every permission state', async () => {
    const res = await request(appWith('admin', { accessCheckReader: fakeReader() as never, accessCheckSource: fakeSource() }))
      .get('/mc/access-check');
    expect(res.status).toBe(200);
    expect(res.body.ok).toBe(true);
    expect(res.body.permissions).toEqual({
      candidatesRead: { state: 'ok', error: null },
      jobsRead: { state: 'ok', error: null },
      interviewsRead: { state: 'ok', error: null },
    });
    expect(res.body.samples.hired).toEqual({
      state: 'ok', error: null, found: true,
      history: {
        rows: 4, matched: 4, unmatched: 0, truncated: false,
        stageTypes: [
          { type: 'PreInterviewScreen', count: 1 }, { type: 'Active', count: 1 },
          { type: 'Offer', count: 1 }, { type: 'Hired', count: 1 },
        ],
      },
    });
  });
});

describe('GET /access-check — what the body may hold', () => {
  it('carries no application, candidate, job, plan, stage or actor id, and no name or title', async () => {
    const res = await request(appWith('admin', { accessCheckReader: fakeReader() as never, accessCheckSource: fakeSource() }))
      .get('/mc/access-check');
    const text = JSON.stringify(res.body);
    for (const secret of SECRETS) expect(text, secret).not.toContain(secret);
  });

  it('has no field outside the allowed set', async () => {
    const res = await request(appWith('admin', { accessCheckReader: fakeReader() as never, accessCheckSource: fakeSource() }))
      .get('/mc/access-check');
    const allowed = allowedPaths();
    const seen = leafPaths(res.body);
    expect(seen.length).toBeGreaterThan(40);
    for (const p of seen) expect(allowed.has(p), `unexpected field ${p}`).toBe(true);
  });

  it('every string is a state, a coarse code or a stage type; every number is a count', async () => {
    const res = await request(appWith('admin', { accessCheckReader: fakeReader() as never, accessCheckSource: fakeSource() }))
      .get('/mc/access-check');
    const vocabulary = new Set<string>([...ACCESS_STATES, ...ACCESS_ERROR_CODES, ...STAGE_TYPES]);
    const visit = (v: unknown): void => {
      if (Array.isArray(v)) { v.forEach(visit); return; }
      if (v !== null && typeof v === 'object') { Object.values(v).forEach(visit); return; }
      if (typeof v === 'string') expect(vocabulary.has(v), `unexpected string ${v}`).toBe(true);
      if (typeof v === 'number') expect(Number.isInteger(v) && v >= 0, `unexpected number ${v}`).toBe(true);
    };
    visit(res.body);
  });

  it('matches the documented schema, which refuses an undocumented field', async () => {
    const res = await request(appWith('admin', { accessCheckReader: fakeReader() as never, accessCheckSource: fakeSource() }))
      .get('/mc/access-check');
    expect(validateNamed(res.body, 'AshbyAccessCheckResponse', SPEC)).toEqual([]);
    const leaking = { ...res.body, samples: { ...res.body.samples, hired: { ...res.body.samples.hired, applicationId: APP_HIRED } } };
    expect(validateNamed(leaking, 'AshbyAccessCheckResponse', SPEC)).not.toEqual([]);
    const badState = { ...res.body, permissions: { ...res.body.permissions, jobsRead: { state: 'maybe', error: null } } };
    expect(validateNamed(badState, 'AshbyAccessCheckResponse', SPEC)).not.toEqual([]);
  });

  it('a body with missing permissions and empty samples also matches the schema', async () => {
    const reader = fakeReader();
    reader.interviewStageList.mockRejectedValue(new AshbyError('http_client_error', { httpStatus: 403 }));
    reader.applicationList.mockRejectedValue(new AshbyError('retry_exhausted', { code: 'timeout' }));
    const res = await request(appWith('admin', {
      accessCheckReader: reader as never,
      accessCheckSource: fakeSource({ enabledMappings: 1, jobIds: [JOB_A], truncated: true, imported: null }),
    })).get('/mc/access-check');
    expect(res.status).toBe(200);
    expect(res.body.permissions.interviewsRead).toEqual({ state: 'missing_permission', error: null });
    expect(res.body.samples.imported).toEqual({ state: 'not_tried', error: null, found: false, history: null });
    expect(res.body.samples.hired).toEqual({ state: 'error', error: 'timeout', found: null, history: null });
    expect(validateNamed(res.body, 'AshbyAccessCheckResponse', SPEC)).toEqual([]);
  });
});

describe('GET /access-check — audit and failures', () => {
  it('writes one audit row, counts only', async () => {
    await withAudits(async (entries) => {
      const res = await request(appWith('admin', { accessCheckReader: fakeReader() as never, accessCheckSource: fakeSource() }))
        .get('/mc/access-check');
      expect(res.status).toBe(200);
      expect(entries).toHaveLength(1);
      expect(entries[0].event).toBe('resource.read');
      expect(entries[0].metadata).toEqual({
        resource: 'ashby_access_check',
        permissions_ok: 3,
        permissions_missing: 0,
        permissions_error: 0,
        permissions_not_tried: 0,
        jobs_checked: 2,
        provider_calls: 9,
        deadline_hit: false,
      });
      const text = JSON.stringify(entries[0]);
      for (const secret of SECRETS.filter((s) => s !== MAPPING_ID)) expect(text, secret).not.toContain(secret);
    });
  });

  it('answers 503 when the integration is disabled, before any read', async () => {
    const source = fakeSource();
    const res = await request(appWith('admin', { probeReader: null, accessCheckSource: source })).get('/mc/access-check');
    expect(res.status).toBe(503);
    expect(res.body).toEqual({ ok: false, error: 'integration_disabled' });
    expect(source.readTargets).not.toHaveBeenCalled();
  });

  it('answers 500 when HELLO\'s own tables cannot be read, and calls Ashby for nothing', async () => {
    const reader = fakeReader();
    const source = { readTargets: vi.fn(async () => { throw new Error('ashby_access_check_mappings_error: secret detail'); }) };
    await withAudits(async (entries) => {
      const res = await request(appWith('admin', { accessCheckReader: reader as never, accessCheckSource: source }))
        .get('/mc/access-check');
      expect(res.status).toBe(500);
      expect(res.body).toEqual({ ok: false, error: 'mission_control_read_error' });
      expect(reader.jobInterviewPlanInfo).not.toHaveBeenCalled();
      expect(entries).toHaveLength(0);
    });
  });

  it('answers 502 if the check itself cannot run, never echoing why', async () => {
    const poisoned = { ...TARGETS, get jobIds(): string[] { throw new Error('tenant xyz detail'); } };
    const res = await request(appWith('admin', { accessCheckReader: fakeReader() as never, accessCheckSource: fakeSource(poisoned) }))
      .get('/mc/access-check');
    expect(res.status).toBe(502);
    expect(res.body).toEqual({ ok: false, error: 'probe_unavailable' });
  });
});

describe('GET /access-check — one run shared by concurrent requests', () => {
  it('two requests at once share one check; a later request runs a new one', async () => {
    const reader = fakeReader();
    const source = fakeSource();
    let release!: () => void;
    const gate = new Promise<void>((r) => { release = r; });
    reader.jobInterviewPlanInfo.mockImplementation(async (jobId: string) => {
      await gate;
      return { results: { jobId, interviewPlanId: PLAN, stages: STAGES } };
    });
    let arrived = 0;
    const countArrivals: express.RequestHandler = (req, _res, next) => {
      if (req.path === '/mc/access-check' && ++arrived === 2) setImmediate(release);
      next();
    };
    await withAudits(async (entries) => {
      const app = appWith('admin', { accessCheckReader: reader as never, accessCheckSource: source }, countArrivals);
      const [a, b] = await Promise.all([request(app).get('/mc/access-check'), request(app).get('/mc/access-check')]);
      expect([a.status, b.status]).toEqual([200, 200]);
      expect(a.body).toEqual(b.body);
      expect(source.readTargets).toHaveBeenCalledTimes(1);
      expect(reader.jobInterviewPlanInfo).toHaveBeenCalledTimes(2);
      // Still one audit row per request.
      expect(entries).toHaveLength(2);

      await request(app).get('/mc/access-check');
      expect(source.readTargets).toHaveBeenCalledTimes(2);
    });
  });
});
