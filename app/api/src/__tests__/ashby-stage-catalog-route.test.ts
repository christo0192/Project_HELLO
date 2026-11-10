/**
 * The Ashby stage catalogue routes (M031 S2), under
 * /api/integrations/ashby/mission-control:
 *
 *   GET   /stage-catalog            the enabled mappings' plan stages, in plan order
 *   POST  /stage-catalog/refresh    read each enabled job's plan, upsert, never delete
 *   PATCH /stage-catalog/:stageId   { milestone } from the allowed set, or null to clear
 *
 * Admin only, every one. Each writes one audit row: counts for the list and the
 * refresh, the stage and the from/to labels for a label change. No candidate
 * data anywhere, and no staff id in the catalogue (the audit row has the actor).
 *
 * Zero network: the Ashby reader and the catalogue store are injected.
 */
import { describe, expect, it, vi } from 'vitest';
import express, { type NextFunction, type Request, type Response } from 'express';
import request from 'supertest';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';
import { createAshbyMissionControlRouter, type AshbyMissionControlDeps } from '../routes/ashby-mission-control.js';
import { getAuditSink, setAuditSink, type AuditEntry } from '../lib/audit.js';
import { AshbyError } from '../integrations/ashby/errors.js';
import {
  STAGE_MILESTONES,
  type MilestoneSource,
  type StageCatalogStore,
  type StageCatalogTargets,
  type StageCatalogUpsert,
  type StageMilestone,
  type StoredStage,
} from '../integrations/ashby/stage-catalog.js';
import { parseYamlDocument, validateNamed } from './support/openapi-schema.js';
import { LIVE_STAGES } from './support/ashby-live-stages.js';

const SPEC = parseYamlDocument(readFileSync(resolve(dirname(fileURLToPath(import.meta.url)), '../../openapi/openapi.yaml'), 'utf8'));

const ADMIN_ID = '44444444-4444-4444-8444-444444444444';
const PLAN = 'plan-shared-0001';
const CHRISTY = 'stage-05-christy';
const TARGETS: StageCatalogTargets = { enabledMappings: 3, jobIds: ['job-a', 'job-b', 'job-c'], christyStageIds: [CHRISTY], truncated: false };

function planPayload() {
  return {
    interviewPlanId: PLAN,
    hiringTeam: [{ email: 'recruiter@example.com' }],
    stages: LIVE_STAGES.map((s, i) => ({ id: s.id, title: s.title, type: s.type, orderInInterviewPlan: i, interviewPlanId: PLAN })),
  };
}

function fakeReader() {
  return { jobInterviewPlanInfo: vi.fn(async () => ({ results: planPayload() as never })) };
}

/** An audit row a 0138 function writes in the same transaction as its change. */
interface TxAudit {
  actorId: string;
  target: string;
  metadata: Record<string, unknown>;
}

/**
 * An in-memory catalogue: the 0138 refresh rules and the label function. Like
 * the two functions, each write and its audit row land together or not at all:
 * `auditFails` stands for an audit insert Postgres refuses, which rolls back
 * the change with it.
 */
function memoryStore(targets: StageCatalogTargets = TARGETS, options: { auditFails?: boolean } = {}) {
  const rows = new Map<string, StoredStage>();
  const audits: TxAudit[] = [];
  const store = {
    readTargets: vi.fn(async () => targets),
    writeStages: vi.fn(async (stages: StageCatalogUpsert[], actorId: string) => {
      if (options.auditFails) throw new Error('ashby_stage_catalog_write_error');
      let inserted = 0;
      let updated = 0;
      let defaulted = 0;
      let redefaulted = 0;
      for (const s of stages) {
        const had = rows.get(s.stageId);
        if (had) {
          updated += 1;
          const admin = had.milestoneSource === 'admin';
          if (!admin && had.milestone !== s.defaultMilestone) {
            if (had.milestone === null) defaulted += 1;
            else redefaulted += 1;
          }
          rows.set(s.stageId, {
            ...had, title: s.title ?? had.title, stageType: s.stageType ?? had.stageType, orderInPlan: s.orderInPlan ?? had.orderInPlan,
            inPlan: true, milestone: admin ? had.milestone : s.defaultMilestone, milestoneSource: admin ? 'admin' : s.defaultMilestone ? 'default' : null,
          });
        } else {
          inserted += 1;
          if (s.defaultMilestone) defaulted += 1;
          rows.set(s.stageId, {
            stageId: s.stageId, interviewPlanId: s.interviewPlanId, title: s.title, stageType: s.stageType, orderInPlan: s.orderInPlan,
            stageGroupId: s.stageGroupId, source: 'plan', inPlan: true, milestone: s.defaultMilestone, milestoneSource: s.defaultMilestone ? 'default' : null,
          });
        }
      }
      // A plan this write names no longer lists these stages: kept, marked.
      const plans = new Set(stages.map((s) => s.interviewPlanId).filter((id): id is string => id !== null));
      const written = new Set(stages.map((s) => s.stageId));
      let leftPlan = 0;
      for (const [id, row] of rows) {
        if (row.inPlan && row.interviewPlanId !== null && plans.has(row.interviewPlanId) && !written.has(id)) {
          rows.set(id, { ...row, inPlan: false });
          leftPlan += 1;
        }
      }
      audits.push({
        actorId,
        target: 'refresh',
        metadata: { resource: 'ashby_stage_catalog_refresh', stages: stages.length, inserted, updated, defaulted, redefaulted, left_plan: leftPlan },
      });
      return { inserted, updated, defaulted, redefaulted, leftPlan };
    }),
    listForEnabledPlans: vi.fn(async () => ({
      enabledMappings: targets.enabledMappings,
      unreadMappings: rows.has(CHRISTY) ? 0 : targets.enabledMappings,
      truncated: false,
      // Live stages in plan order, then those no longer in the plan.
      stages: [...rows.values()].sort((a, b) => Number(b.inPlan) - Number(a.inPlan) || (a.orderInPlan ?? 99) - (b.orderInPlan ?? 99)),
    })),
    readStage: vi.fn(async (id: string) => rows.get(id) ?? null),
    setMilestone: vi.fn(async (id: string, milestone: StageMilestone | null, source: MilestoneSource | null, actorId: string) => {
      const had = rows.get(id);
      if (!had) return null;
      if (options.auditFails) throw new Error('ashby_stage_catalog_label_error');
      const next: StoredStage = { ...had, milestone, milestoneSource: milestone === null ? null : source };
      rows.set(id, next);
      audits.push({
        actorId,
        target: id,
        metadata: {
          resource: 'ashby_stage_catalog', stage_id: id, milestone_from: had.milestone, milestone_source_from: had.milestoneSource,
          milestone_to: next.milestone, milestone_source: next.milestoneSource,
        },
      });
      return { from: had.milestone, stage: next };
    }),
  } satisfies StageCatalogStore;
  return { store, rows, audits, failAudits: () => { options.auditFails = true; } };
}

/** A store already refreshed once from the live plan. */
async function refreshedStore(options: { auditFails?: boolean } = {}) {
  const mem = memoryStore(TARGETS);
  const app = appWith('admin', { stageCatalog: mem.store, stageCatalogReader: fakeReader() as never });
  await request(app).post('/mc/stage-catalog/refresh');
  // From here on, the store's in-transaction audit insert is refused.
  if (options.auditFails) mem.failAudits();
  return mem;
}

function appWith(role: string | null, deps: AshbyMissionControlDeps, before?: express.RequestHandler, userId: string | null = ADMIN_ID) {
  const app = express();
  app.use(express.json());
  if (before) app.use(before);
  app.use((req: Request, _res: Response, next: NextFunction) => {
    if (role) (req as unknown as { authUser: unknown }).authUser = { id: userId, appRole: role };
    next();
  });
  app.use('/mc', createAshbyMissionControlRouter({ store: {} as never, ...deps }));
  return app;
}

async function withAudits<T>(fn: (entries: AuditEntry[]) => Promise<T>): Promise<T> {
  const entries: AuditEntry[] = [];
  const previous = getAuditSink();
  setAuditSink(async (entry) => { entries.push(entry); });
  try { return await fn(entries); } finally { setAuditSink(previous); }
}

describe('admin only', () => {
  it.each(['interviewer', 'viewer'])('%s is refused every stage-catalog route, and nothing is read or written', async (role) => {
    const { store } = memoryStore();
    const reader = fakeReader();
    const app = appWith(role, { stageCatalog: store, stageCatalogReader: reader as never });
    expect((await request(app).get('/mc/stage-catalog')).status).toBe(403);
    expect((await request(app).post('/mc/stage-catalog/refresh')).status).toBe(403);
    expect((await request(app).patch(`/mc/stage-catalog/${CHRISTY}`).send({ milestone: 'r1' })).status).toBe(403);
    expect(reader.jobInterviewPlanInfo).not.toHaveBeenCalled();
    for (const fn of Object.values(store)) expect(fn).not.toHaveBeenCalled();
  });

  it('an unauthenticated request is refused', async () => {
    const { store } = memoryStore();
    const app = appWith(null, { stageCatalog: store, stageCatalogReader: fakeReader() as never });
    expect((await request(app).get('/mc/stage-catalog')).status).toBe(403);
    expect((await request(app).post('/mc/stage-catalog/refresh')).status).toBe(403);
    expect((await request(app).patch(`/mc/stage-catalog/${CHRISTY}`).send({ milestone: 'r1' })).status).toBe(403);
  });
});

describe('POST /stage-catalog/refresh', () => {
  it('reads each enabled job, writes the 18 stages with their defaults, and answers counts', async () => {
    const { store, rows } = memoryStore();
    const reader = fakeReader();
    const res = await request(appWith('admin', { stageCatalog: store, stageCatalogReader: reader as never })).post('/mc/stage-catalog/refresh');
    expect(res.status).toBe(200);
    expect(res.body).toEqual({
      ok: true,
      refresh: {
        mappings: { enabled: 3, truncated: false },
        jobs: { attempted: 3, read: 3, failed: 0, notTried: 0 },
        failures: [],
        stages: { seen: 18, inserted: 18, updated: 0, defaulted: 10, redefaulted: 0, leftPlan: 0 },
        deadlineHit: false,
      },
    });
    expect(validateNamed(res.body, 'AshbyStageCatalogRefreshResponse', SPEC)).toEqual([]);
    expect(rows.size).toBe(18);
    expect(rows.get('stage-09-r1')).toMatchObject({ milestone: 'r1', milestoneSource: 'default' });
  });

  it('is idempotent: a second refresh inserts and defaults nothing', async () => {
    const { store } = memoryStore();
    const app = appWith('admin', { stageCatalog: store, stageCatalogReader: fakeReader() as never });
    await request(app).post('/mc/stage-catalog/refresh');
    const again = await request(app).post('/mc/stage-catalog/refresh');
    expect(again.status).toBe(200);
    expect(again.body.refresh.stages).toEqual({ seen: 18, inserted: 0, updated: 18, defaulted: 0, redefaulted: 0, leftPlan: 0 });
  });

  it("a Christy stage the mappings stop naming loses christy on the next refresh, and the new one takes it (S2-2)", async () => {
    const targets: StageCatalogTargets = { ...TARGETS, christyStageIds: [CHRISTY] };
    const { store, rows } = memoryStore(targets);
    const app = appWith('admin', { stageCatalog: store, stageCatalogReader: fakeReader() as never });
    await request(app).post('/mc/stage-catalog/refresh');
    targets.christyStageIds = ['stage-06-ta'];
    const res = await request(app).post('/mc/stage-catalog/refresh');
    expect(res.status).toBe(200);
    expect(res.body.refresh.stages).toEqual({ seen: 18, inserted: 0, updated: 18, defaulted: 1, redefaulted: 1, leftPlan: 0 });
    expect(validateNamed(res.body, 'AshbyStageCatalogRefreshResponse', SPEC)).toEqual([]);
    expect(rows.get(CHRISTY)).toMatchObject({ milestone: null, milestoneSource: null });
    expect(rows.get('stage-06-ta')).toMatchObject({ milestone: 'christy', milestoneSource: 'default' });
  });

  it('writes one audit row with counts only: no stage, job or plan id, and no title', async () => {
    await withAudits(async (entries) => {
      const { store } = memoryStore();
      const res = await request(appWith('admin', { stageCatalog: store, stageCatalogReader: fakeReader() as never })).post('/mc/stage-catalog/refresh');
      expect(res.status).toBe(200);
      expect(entries).toHaveLength(1);
      expect(entries[0].event).toBe('resource.update');
      expect(entries[0].metadata).toEqual({
        resource: 'ashby_stage_catalog_refresh',
        mappings_enabled: 3,
        jobs_attempted: 3,
        jobs_read: 3,
        jobs_failed: 0,
        jobs_not_tried: 0,
        stages_seen: 18,
        inserted: 18,
        updated: 0,
        defaulted: 10,
        redefaulted: 0,
        left_plan: 0,
        deadline_hit: false,
      });
      const text = JSON.stringify(entries[0].metadata);
      for (const secret of ['job-', 'stage-', PLAN, 'Hello Christy', 'example.com']) expect(text).not.toContain(secret);
    });
  });

  it('a refused job is counted by code, and the body still matches the schema', async () => {
    const reader = fakeReader();
    reader.jobInterviewPlanInfo.mockRejectedValueOnce(
      new AshbyError('http_client_error', { httpStatus: 403, endpointCodes: ['missing_endpoint_permission'] }),
    );
    const { store } = memoryStore();
    const res = await request(appWith('admin', { stageCatalog: store, stageCatalogReader: reader as never })).post('/mc/stage-catalog/refresh');
    expect(res.status).toBe(200);
    expect(res.body.refresh.jobs).toEqual({ attempted: 3, read: 2, failed: 1, notTried: 0 });
    expect(res.body.refresh.failures).toEqual([{ code: 'missing_permission', count: 1 }]);
    expect(validateNamed(res.body, 'AshbyStageCatalogRefreshResponse', SPEC)).toEqual([]);
  });

  it('answers 503 when the integration is disabled, before any read', async () => {
    const { store } = memoryStore();
    const res = await request(appWith('admin', { stageCatalog: store, probeReader: null })).post('/mc/stage-catalog/refresh');
    expect(res.status).toBe(503);
    expect(res.body).toEqual({ ok: false, error: 'integration_disabled' });
    expect(store.readTargets).not.toHaveBeenCalled();
  });

  it("answers 500 when HELLO's mappings cannot be read, and calls Ashby for nothing", async () => {
    const { store } = memoryStore();
    store.readTargets.mockRejectedValue(new Error('ashby_stage_catalog_mappings_error: detail'));
    const reader = fakeReader();
    await withAudits(async (entries) => {
      const res = await request(appWith('admin', { stageCatalog: store, stageCatalogReader: reader as never })).post('/mc/stage-catalog/refresh');
      expect(res.status).toBe(500);
      expect(res.body).toEqual({ ok: false, error: 'mission_control_read_error' });
      expect(reader.jobInterviewPlanInfo).not.toHaveBeenCalled();
      expect(entries).toHaveLength(0);
    });
  });

  it('answers 500 when the catalogue cannot be written, never echoing why', async () => {
    const { store } = memoryStore();
    store.writeStages.mockRejectedValue(new Error('ashby_stage_catalog_write_error: secret'));
    const res = await request(appWith('admin', { stageCatalog: store, stageCatalogReader: fakeReader() as never })).post('/mc/stage-catalog/refresh');
    expect(res.status).toBe(500);
    expect(res.body).toEqual({ ok: false, error: 'mission_control_action_error' });
  });

  it('two refreshes at once share one run; a later one runs again', async () => {
    const { store } = memoryStore();
    const reader = fakeReader();
    let release!: () => void;
    const gate = new Promise<void>((r) => { release = r; });
    reader.jobInterviewPlanInfo.mockImplementation(async () => { await gate; return { results: planPayload() as never }; });
    let arrived = 0;
    const countArrivals: express.RequestHandler = (req, _res, next) => {
      if (req.path === '/mc/stage-catalog/refresh' && ++arrived === 2) setImmediate(release);
      next();
    };
    await withAudits(async (entries) => {
      const app = appWith('admin', { stageCatalog: store, stageCatalogReader: reader as never }, countArrivals);
      const [a, b] = await Promise.all([request(app).post('/mc/stage-catalog/refresh'), request(app).post('/mc/stage-catalog/refresh')]);
      expect([a.status, b.status]).toEqual([200, 200]);
      expect(a.body).toEqual(b.body);
      expect(store.readTargets).toHaveBeenCalledTimes(1);
      expect(reader.jobInterviewPlanInfo).toHaveBeenCalledTimes(3);
      expect(entries).toHaveLength(2);
      await request(app).post('/mc/stage-catalog/refresh');
      expect(store.readTargets).toHaveBeenCalledTimes(2);
    });
  });
});

describe('GET /stage-catalog', () => {
  it('lists the plan in order with type, order, milestone and who set it, and matches the schema', async () => {
    const { store } = await refreshedStore();
    await withAudits(async (entries) => {
      const res = await request(appWith('admin', { stageCatalog: store })).get('/mc/stage-catalog');
      expect(res.status).toBe(200);
      expect(res.body.ok).toBe(true);
      expect(res.body.enabledMappings).toBe(3);
      expect(res.body.unreadMappings).toBe(0);
      expect(res.body.truncated).toBe(false);
      expect(res.body.stages.map((s: { title: string }) => s.title)).toEqual(LIVE_STAGES.map((s) => s.title));
      expect(res.body.stages[8]).toEqual({ id: 'stage-09-r1', title: 'R1', type: 'Active', order: 8, milestone: 'r1', milestoneSource: 'default', inPlan: true });
      expect(res.body.stages[6]).toEqual({ id: 'stage-07-hm', title: 'HM Review', type: 'Active', order: 6, milestone: null, milestoneSource: null, inPlan: true });
      expect(validateNamed(res.body, 'AshbyStageCatalogResponse', SPEC)).toEqual([]);
      expect(entries).toHaveLength(1);
      expect(entries[0].event).toBe('resource.list');
      expect(entries[0].metadata).toEqual({ resource: 'ashby_stage_catalog', count: 18, unread_mappings: 0, truncated: false });
    });
  });

  it('a stage Ashby removed is listed after the live ones, marked, with its label (S2-4)', async () => {
    const { store, rows } = await refreshedStore();
    const reader = { jobInterviewPlanInfo: vi.fn(async () => {
      const payload = planPayload();
      payload.stages = payload.stages.map((s) => (s.id === 'stage-13-r5' ? { ...s, id: 'stage-13b-panel', title: 'Panel' } : s));
      return { results: payload as never };
    }) };
    const app = appWith('admin', { stageCatalog: store, stageCatalogReader: reader as never });
    const refresh = await request(app).post('/mc/stage-catalog/refresh');
    expect(refresh.body.refresh.stages).toMatchObject({ inserted: 1, leftPlan: 1 });
    expect(validateNamed(refresh.body, 'AshbyStageCatalogRefreshResponse', SPEC)).toEqual([]);
    const res = await request(app).get('/mc/stage-catalog');
    expect(res.status).toBe(200);
    expect(res.body.stages).toHaveLength(19);
    expect(res.body.stages.slice(0, 18).every((s: { inPlan: boolean }) => s.inPlan)).toBe(true);
    expect(res.body.stages[18]).toEqual({ id: 'stage-13-r5', title: 'R5', type: 'Active', order: 12, milestone: 'r5', milestoneSource: 'default', inPlan: false });
    expect(rows.get('stage-13b-panel')).toMatchObject({ inPlan: true });
    expect(validateNamed(res.body, 'AshbyStageCatalogResponse', SPEC)).toEqual([]);
  });

  it('makes no Ashby call, even with the integration disabled', async () => {
    const { store } = await refreshedStore();
    const res = await request(appWith('admin', { stageCatalog: store, probeReader: null })).get('/mc/stage-catalog');
    expect(res.status).toBe(200);
    expect(res.body.stages).toHaveLength(18);
  });

  it('an unread catalogue is an empty list that says how many live mappings wait for a refresh', async () => {
    const { store } = memoryStore();
    const res = await request(appWith('admin', { stageCatalog: store })).get('/mc/stage-catalog');
    expect(res.status).toBe(200);
    expect(res.body).toEqual({ ok: true, stages: [], enabledMappings: 3, unreadMappings: 3, truncated: false });
    expect(validateNamed(res.body, 'AshbyStageCatalogResponse', SPEC)).toEqual([]);
  });

  it('the schema refuses an undocumented field or milestone', async () => {
    const { store } = await refreshedStore();
    const res = await request(appWith('admin', { stageCatalog: store })).get('/mc/stage-catalog');
    const leaking = { ...res.body, stages: [{ ...res.body.stages[0], actorId: 'staff-1' }] };
    expect(validateNamed(leaking, 'AshbyStageCatalogResponse', SPEC)).not.toEqual([]);
    const badMilestone = { ...res.body, stages: [{ ...res.body.stages[0], milestone: 'r6' }] };
    expect(validateNamed(badMilestone, 'AshbyStageCatalogResponse', SPEC)).not.toEqual([]);
  });

  it('answers 500 when the catalogue cannot be read', async () => {
    const { store } = memoryStore();
    store.listForEnabledPlans.mockRejectedValue(new Error('ashby_stage_catalog_read_error'));
    const res = await request(appWith('admin', { stageCatalog: store })).get('/mc/stage-catalog');
    expect(res.status).toBe(500);
    expect(res.body).toEqual({ ok: false, error: 'mission_control_read_error' });
  });
});

describe('PATCH /stage-catalog/:stageId', () => {
  it.each([...STAGE_MILESTONES])('an admin can label a stage %s, and it reads as set by an admin', async (milestone) => {
    const { store, rows } = await refreshedStore();
    const res = await request(appWith('admin', { stageCatalog: store })).patch('/mc/stage-catalog/stage-07-hm').send({ milestone });
    expect(res.status).toBe(200);
    expect(res.body).toEqual({
      ok: true,
      stage: { id: 'stage-07-hm', title: 'HM Review', type: 'Active', order: 6, milestone, milestoneSource: 'admin', inPlan: true },
    });
    expect(validateNamed(res.body, 'AshbyStageMilestoneUpdateResponse', SPEC)).toEqual([]);
    expect(rows.get('stage-07-hm')).toMatchObject({ milestone, milestoneSource: 'admin' });
  });

  it('an admin label survives the next refresh', async () => {
    const { store, rows } = await refreshedStore();
    const app = appWith('admin', { stageCatalog: store, stageCatalogReader: fakeReader() as never });
    await request(app).patch('/mc/stage-catalog/stage-09-r1').send({ milestone: 'r2' });
    await request(app).post('/mc/stage-catalog/refresh');
    expect(rows.get('stage-09-r1')).toMatchObject({ milestone: 'r2', milestoneSource: 'admin' });
  });

  it('null clears the label and returns the stage to its default', async () => {
    const { store } = await refreshedStore();
    const app = appWith('admin', { stageCatalog: store });
    await request(app).patch('/mc/stage-catalog/stage-16-offer').send({ milestone: 'other' });
    const res = await request(app).patch('/mc/stage-catalog/stage-16-offer').send({ milestone: null });
    expect(res.status).toBe(200);
    expect(res.body.stage).toMatchObject({ milestone: 'offer', milestoneSource: 'default' });
  });

  it('null on a stage with no default leaves it unlabelled', async () => {
    const { store } = await refreshedStore();
    const app = appWith('admin', { stageCatalog: store });
    await request(app).patch('/mc/stage-catalog/stage-07-hm').send({ milestone: 'r1' });
    const res = await request(app).patch('/mc/stage-catalog/stage-07-hm').send({ milestone: null });
    expect(res.status).toBe(200);
    expect(res.body.stage).toMatchObject({ milestone: null, milestoneSource: null });
    expect(validateNamed(res.body, 'AshbyStageMilestoneUpdateResponse', SPEC)).toEqual([]);
  });

  it("null on the mapping's Christy stage returns it to christy", async () => {
    const { store } = await refreshedStore();
    const app = appWith('admin', { stageCatalog: store });
    await request(app).patch(`/mc/stage-catalog/${CHRISTY}`).send({ milestone: 'other' });
    const res = await request(app).patch(`/mc/stage-catalog/${CHRISTY}`).send({ milestone: null });
    expect(res.body.stage).toMatchObject({ milestone: 'christy', milestoneSource: 'default' });
  });

  it.each([
    ['R1', { milestone: 'R1' }],
    ['r6', { milestone: 'r6' }],
    ['an empty string', { milestone: '' }],
    ['a number', { milestone: 1 }],
    ['an array', { milestone: ['r1'] }],
    ['no milestone key', {}],
    ['an extra key', { milestone: 'r1', milestoneSource: 'default' }],
  ])('refuses %s with 400 and writes nothing', async (_name, body) => {
    const { store } = await refreshedStore();
    store.setMilestone.mockClear();
    const res = await request(appWith('admin', { stageCatalog: store })).patch('/mc/stage-catalog/stage-07-hm').send(body);
    expect(res.status).toBe(400);
    expect(res.body).toEqual({ ok: false, error: 'invalid_milestone' });
    expect(store.setMilestone).not.toHaveBeenCalled();
  });

  it('refuses a stage id that is not identifier-shaped', async () => {
    const { store } = await refreshedStore();
    const res = await request(appWith('admin', { stageCatalog: store })).patch('/mc/stage-catalog/has%20space').send({ milestone: 'r1' });
    expect(res.status).toBe(400);
    expect(res.body).toEqual({ ok: false, error: 'invalid_stage_id' });
  });

  it('answers 404 for a stage the catalogue does not hold', async () => {
    const { store } = await refreshedStore();
    const res = await request(appWith('admin', { stageCatalog: store })).patch('/mc/stage-catalog/stage-99-unknown').send({ milestone: 'r1' });
    expect(res.status).toBe(404);
    expect(res.body).toEqual({ ok: false, error: 'not_found' });
  });

  it('audits the stage, the label before and after, and who set it as a kind; the actor is the audit row\'s own', async () => {
    const { store } = await refreshedStore();
    await withAudits(async (entries) => {
      const res = await request(appWith('admin', { stageCatalog: store })).patch('/mc/stage-catalog/stage-09-r1').send({ milestone: 'r2' });
      expect(res.status).toBe(200);
      expect(entries).toHaveLength(1);
      expect(entries[0].event).toBe('resource.update');
      expect(entries[0].userId).toBe(ADMIN_ID);
      expect(entries[0].metadata).toEqual({
        resource: 'ashby_stage_catalog',
        stage_id: 'stage-09-r1',
        milestone_from: 'r1',
        milestone_to: 'r2',
        milestone_source: 'admin',
      });
    });
  });

  it('answers 500 when the label cannot be written', async () => {
    const { store } = await refreshedStore();
    store.setMilestone.mockRejectedValue(new Error('ashby_stage_catalog_label_error'));
    const res = await request(appWith('admin', { stageCatalog: store })).patch('/mc/stage-catalog/stage-07-hm').send({ milestone: 'r1' });
    expect(res.status).toBe(500);
    expect(res.body).toEqual({ ok: false, error: 'mission_control_action_error' });
  });
});

describe('every catalogue write is audited in its own transaction (S2-3)', () => {
  /** A request-level audit sink that refuses every row, as a failing database would. */
  async function withFailingSink<T>(fn: () => Promise<T>): Promise<T> {
    const previous = getAuditSink();
    setAuditSink(async () => { throw new Error('audit sink down'); });
    try { return await fn(); } finally { setAuditSink(previous); }
  }

  it("a label change hands the admin to the store, whose one write holds the change and its audit row", async () => {
    const { store, audits } = await refreshedStore();
    const res = await request(appWith('admin', { stageCatalog: store })).patch('/mc/stage-catalog/stage-09-r1').send({ milestone: 'r2' });
    expect(res.status).toBe(200);
    expect(store.setMilestone).toHaveBeenCalledWith('stage-09-r1', 'r2', 'admin', ADMIN_ID);
    expect(audits.filter((a) => a.target === 'stage-09-r1')).toEqual([{
      actorId: ADMIN_ID,
      target: 'stage-09-r1',
      metadata: {
        resource: 'ashby_stage_catalog', stage_id: 'stage-09-r1', milestone_from: 'r1', milestone_source_from: 'default',
        milestone_to: 'r2', milestone_source: 'admin',
      },
    }]);
  });

  it('a refresh hands the admin to the store with the stages it read', async () => {
    const { store, audits } = memoryStore();
    const res = await request(appWith('admin', { stageCatalog: store, stageCatalogReader: fakeReader() as never })).post('/mc/stage-catalog/refresh');
    expect(res.status).toBe(200);
    expect(store.writeStages).toHaveBeenCalledWith(expect.any(Array), ADMIN_ID);
    expect(audits).toEqual([{
      actorId: ADMIN_ID,
      target: 'refresh',
      metadata: { resource: 'ashby_stage_catalog_refresh', stages: 18, inserted: 18, updated: 0, defaulted: 10, redefaulted: 0, left_plan: 0 },
    }]);
  });

  it('with the request-level audit sink failing, a saved label is answered as saved, and its own audit row exists', async () => {
    const { store, rows, audits } = await refreshedStore();
    const res = await withFailingSink(() => request(appWith('admin', { stageCatalog: store })).patch('/mc/stage-catalog/stage-07-hm').send({ milestone: 'r1' }));
    // Before S2-3 this answered 500 while the label stayed saved with no audit row.
    expect(res.status).toBe(200);
    expect(res.body.stage).toMatchObject({ id: 'stage-07-hm', milestone: 'r1', milestoneSource: 'admin' });
    expect(rows.get('stage-07-hm')).toMatchObject({ milestone: 'r1', milestoneSource: 'admin' });
    expect(audits.filter((a) => a.target === 'stage-07-hm')).toHaveLength(1);
  });

  it('with the request-level audit sink failing, a refresh is answered with what it wrote, and its own audit row exists', async () => {
    const { store, rows, audits } = memoryStore();
    const res = await withFailingSink(() =>
      request(appWith('admin', { stageCatalog: store, stageCatalogReader: fakeReader() as never })).post('/mc/stage-catalog/refresh'));
    expect(res.status).toBe(200);
    expect(res.body.refresh.stages).toMatchObject({ seen: 18, inserted: 18 });
    expect(rows.size).toBe(18);
    expect(audits.filter((a) => a.target === 'refresh')).toHaveLength(1);
  });

  it("when the store's audit insert fails, the label is not written and the answer says it failed", async () => {
    const { store, rows, audits } = await refreshedStore({ auditFails: true });
    const before = structuredClone(rows.get('stage-07-hm'));
    await withAudits(async (entries) => {
      const res = await request(appWith('admin', { stageCatalog: store })).patch('/mc/stage-catalog/stage-07-hm').send({ milestone: 'r1' });
      expect(res.status).toBe(500);
      expect(res.body).toEqual({ ok: false, error: 'mission_control_action_error' });
      expect(entries).toHaveLength(0);
    });
    expect(rows.get('stage-07-hm')).toEqual(before);
    expect(audits.filter((a) => a.target === 'stage-07-hm')).toHaveLength(0);
  });

  it("when the store's audit insert fails, a refresh writes nothing and says so", async () => {
    const { store, rows, audits } = memoryStore(TARGETS, { auditFails: true });
    const res = await request(appWith('admin', { stageCatalog: store, stageCatalogReader: fakeReader() as never })).post('/mc/stage-catalog/refresh');
    expect(res.status).toBe(500);
    expect(res.body).toEqual({ ok: false, error: 'mission_control_action_error' });
    expect(rows.size).toBe(0);
    expect(audits).toHaveLength(0);
  });

  it('a request that carries no admin id is refused before anything is read or written', async () => {
    const { store } = memoryStore();
    const reader = fakeReader();
    const app = appWith('admin', { stageCatalog: store, stageCatalogReader: reader as never }, undefined, null);
    expect((await request(app).post('/mc/stage-catalog/refresh')).status).toBe(403);
    expect((await request(app).patch(`/mc/stage-catalog/${CHRISTY}`).send({ milestone: 'r1' })).status).toBe(403);
    expect(reader.jobInterviewPlanInfo).not.toHaveBeenCalled();
    for (const fn of Object.values(store)) expect(fn).not.toHaveBeenCalled();
  });
});
