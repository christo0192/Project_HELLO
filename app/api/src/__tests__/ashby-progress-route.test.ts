/**
 * The Ashby progress worker's admin routes (M031 S3), under
 * /api/integrations/ashby/mission-control:
 *
 *   GET  /progress/status     the switch, coverage, counts by status and code, stale rows, runs
 *   POST /progress/backfill   { dryRun: true } counts only; { dryRun: false } every link due
 *
 * Admin only. The routes read and write HELLO's tables only (through the 0139
 * functions, here an injected store) and never call Ashby: no reader is even
 * reachable from them. Each request writes one audit row with counts only; the
 * backfill's own audit row is written by start_ashby_progress_backfill in its
 * transaction. Responses carry no link, application, candidate or run id.
 */
import { describe, expect, it, vi } from 'vitest';
import express, { type NextFunction, type Request, type Response } from 'express';
import request from 'supertest';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';
import { createAshbyMissionControlRouter, type AshbyMissionControlDeps } from '../routes/ashby-mission-control.js';
import { getAuditSink, setAuditSink, type AuditEntry } from '../lib/audit.js';
import type { BackfillStart, ProgressOverview, ProgressStore } from '../integrations/ashby/progress-worker.js';
import { parseYamlDocument, validateNamed } from './support/openapi-schema.js';

const SPEC = parseYamlDocument(readFileSync(resolve(dirname(fileURLToPath(import.meta.url)), '../../openapi/openapi.yaml'), 'utf8'));
const ADMIN_ID = '44444444-4444-4444-8444-444444444444';

/** Every gate of the Ashby runtime open; the progress switch as given. */
function env(progress: boolean | undefined): NodeJS.ProcessEnv {
  return {
    ASHBY_INTEGRATION_ENABLED: 'true',
    ASHBY_WEBHOOK_SECRET: 'synthetic-webhook-secret-0001',
    ASHBY_RUNTIME_ENABLED: 'true',
    ASHBY_API_KEY: 'synthetic-api-key-000000001',
    ...(progress === undefined ? {} : { ASHBY_PROGRESS_ENABLED: String(progress) }),
  };
}

function overview(over: Partial<ProgressOverview> = {}): ProgressOverview {
  return {
    links: 415, linksExcluded: 2, progressRows: 415, checked: 412, neverChecked: 3, dueNow: 4, gone: 1, stale: 3,
    byStatus: { Active: 300, Hired: 6, Archived: 106, Lead: 0, unknown: 3 },
    byError: [{ code: 'missing_endpoint_permission', count: 2 }],
    intervals: { total: 1300, open: 300, gone: 4 },
    historyStages: 1,
    openBackfill: null,
    lastSweep: { mode: 'sweep', startedAt: '2026-11-10T13:55:00.000Z', finishedAt: '2026-11-10T13:55:20.000Z', checked: 1, changed: 0, deferred: 0, scannerPaused: 5, errors: [] },
    recentRuns: [
      { mode: 'sweep', startedAt: '2026-11-10T13:55:00.000Z', finishedAt: '2026-11-10T13:55:20.000Z', checked: 1, changed: 0, deferred: 0, scannerPaused: 5, errors: [] },
      { mode: 'sweep', startedAt: '2026-11-10T13:50:00.000Z', finishedAt: '2026-11-10T13:50:45.000Z', checked: 8, changed: 2, deferred: 2, scannerPaused: 0, errors: [] },
      { mode: 'backfill', startedAt: '2026-11-09T10:00:00.000Z', finishedAt: '2026-11-09T12:00:00.000Z', checked: 415, changed: 300, deferred: 3, scannerPaused: 0, errors: [{ code: 'timeout', count: 1 }] },
    ],
    scannerPause: { skippedPasses: 5, lastAt: '2026-11-10T13:55:00.000Z' },
    ...over,
  };
}

/** A store double: the backfill opens once and answers already_running while open. */
function memoryStore(options: { failOverview?: boolean; failStart?: boolean } = {}) {
  let open: { startedAt: string; remaining: number } | null = null;
  const starts: Array<{ actorId: string; nowIso: string }> = [];
  const store = {
    scannerBusy: vi.fn(async () => false),
    claimDue: vi.fn(async () => ({ seeded: 0, backfillOpen: false, backfillStartedAt: null, claimed: [] })),
    knownStages: vi.fn(async () => new Map()),
    christyStageIds: vi.fn(async () => []),
    record: vi.fn(async () => ({ status: 'ok' as const, changed: false })),
    recordRun: vi.fn(async () => ({ backfillFinished: false })),
    overview: vi.fn(async () => {
      if (options.failOverview) throw new Error('ashby_progress_overview_error');
      return overview({ openBackfill: open });
    }),
    startBackfill: vi.fn(async (actorId: string, nowIso: string): Promise<BackfillStart> => {
      if (options.failStart) throw new Error('ashby_progress_backfill_error');
      starts.push({ actorId, nowIso });
      if (open) return { state: 'already_running', startedAt: open.startedAt, links: 0, seeded: 0, marked: 0 };
      open = { startedAt: nowIso, remaining: 415 };
      return { state: 'started', startedAt: nowIso, links: 415, seeded: 3, marked: 415 };
    }),
  } satisfies ProgressStore;
  return { store, starts };
}

/** Any Ashby reader the router could reach: none may be called. */
function readers() {
  const fail = vi.fn(async () => { throw new Error('no Ashby call is allowed here'); });
  return {
    probeReader: { jobInterviewPlanInfo: fail } as never,
    accessCheckReader: { applicationInfo: fail, applicationListHistory: fail, applicationList: fail, jobInterviewPlanInfo: fail, interviewStageList: fail } as never,
    stageCatalogReader: { jobInterviewPlanInfo: fail } as never,
    fail,
  };
}

function appWith(role: string | null, deps: AshbyMissionControlDeps, userId: string | null = ADMIN_ID) {
  const app = express();
  app.use(express.json());
  app.use((req: Request, _res: Response, next: NextFunction) => {
    if (role) (req as unknown as { authUser: unknown }).authUser = { id: userId, appRole: role };
    next();
  });
  app.use('/mc', createAshbyMissionControlRouter({ store: {} as never, now: () => Date.parse('2026-11-10T14:00:00.000Z'), ...deps }));
  return app;
}

async function withAudits<T>(fn: (entries: AuditEntry[]) => Promise<T>): Promise<T> {
  const entries: AuditEntry[] = [];
  const previous = getAuditSink();
  setAuditSink(async (entry) => { entries.push(entry); });
  try { return await fn(entries); } finally { setAuditSink(previous); }
}

const UUID_RE = /[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/i;

describe('admin only', () => {
  it.each(['interviewer', 'viewer', 'recruiter'])('%s is refused both routes, and nothing is read or written', async (role) => {
    const { store } = memoryStore();
    const app = appWith(role, { progress: store, configSource: env(true) });
    expect((await request(app).get('/mc/progress/status')).status).toBe(403);
    expect((await request(app).post('/mc/progress/backfill').send({ dryRun: true })).status).toBe(403);
    expect((await request(app).post('/mc/progress/backfill').send({ dryRun: false })).status).toBe(403);
    for (const fn of Object.values(store)) expect(fn).not.toHaveBeenCalled();
  });

  it('an unauthenticated request is refused', async () => {
    const { store } = memoryStore();
    const app = appWith(null, { progress: store, configSource: env(true) });
    expect((await request(app).get('/mc/progress/status')).status).toBe(403);
    expect((await request(app).post('/mc/progress/backfill').send({ dryRun: false })).status).toBe(403);
    expect(store.startBackfill).not.toHaveBeenCalled();
  });
});

describe('GET /progress/status', () => {
  it('answers the switch, coverage, counts by status and code, stale rows and runs, as documented', async () => {
    const { store } = memoryStore();
    const r = readers();
    const res = await request(appWith('admin', { progress: store, configSource: env(true), ...r })).get('/mc/progress/status');
    expect(res.status).toBe(200);
    expect(validateNamed(res.body, 'AshbyProgressStatusResponse', SPEC)).toEqual([]);
    expect(res.body.worker).toEqual({
      enabled: true, runtimeActive: true, running: true, batchSize: 10, passDeadlineMs: 45_000, minCallIntervalMs: 500,
      cadenceHours: { activeRecent: 6, active: 24, terminal: 168, terminalOld: 720, historyMaxAge: 168 },
    });
    expect(res.body.coverage).toEqual({ links: 415, checked: 412, neverChecked: 3, excluded: 2 });
    expect(res.body.due).toEqual({ now: 4, stale: 3, gone: 1, staleAfterHours: 24 });
    expect(res.body.byError).toEqual([{ code: 'missing_endpoint_permission', count: 2 }]);
    expect(res.body.lastPass).toMatchObject({ mode: 'sweep', checked: 1, changed: 0, scannerPaused: 5 });
    expect(res.body.recentRuns).toHaveLength(3);
    // Rows handed back unread and passes the scanner skipped show, apart from the failures (S3-1, S3-3).
    expect(res.body.recentRuns[1]).toMatchObject({ deferred: 2, errors: [] });
    expect(res.body.scannerPause).toEqual({ skippedPasses: 5, lastAt: '2026-11-10T13:55:00.000Z' });
    expect(JSON.stringify(res.body)).not.toMatch(UUID_RE);
    expect(r.fail).not.toHaveBeenCalled();
    expect(store.overview).toHaveBeenCalledWith('2026-11-10T14:00:00.000Z', 86_400);
  });

  it('reports the worker off when the switch is off, or the Ashby runtime is', async () => {
    const { store } = memoryStore();
    const off = await request(appWith('admin', { progress: store, configSource: env(undefined) })).get('/mc/progress/status');
    expect(off.body.worker).toMatchObject({ enabled: false, runtimeActive: true, running: false });
    const noRuntime = await request(appWith('admin', { progress: store, configSource: { ASHBY_PROGRESS_ENABLED: 'true' } })).get('/mc/progress/status');
    expect(noRuntime.body.worker).toMatchObject({ enabled: true, runtimeActive: false, running: false });
    expect(validateNamed(noRuntime.body, 'AshbyProgressStatusResponse', SPEC)).toEqual([]);
  });

  it('writes one audit row, counts only', async () => {
    await withAudits(async (entries) => {
      const { store } = memoryStore();
      await request(appWith('admin', { progress: store, configSource: env(true) })).get('/mc/progress/status');
      expect(entries).toHaveLength(1);
      expect(entries[0].event).toBe('resource.read');
      expect(entries[0].metadata).toEqual({ resource: 'ashby_progress_status', links: 415, checked: 412, stale: 3, worker_enabled: true });
    });
  });

  it('a store failure answers 500, sanitized', async () => {
    const { store } = memoryStore({ failOverview: true });
    const res = await request(appWith('admin', { progress: store, configSource: env(true) })).get('/mc/progress/status');
    expect(res.status).toBe(500);
    expect(res.body).toEqual({ ok: false, error: 'mission_control_read_error' });
  });
});

describe('POST /progress/backfill', () => {
  it('a dry run answers counts only and changes nothing', async () => {
    await withAudits(async (entries) => {
      const { store } = memoryStore();
      const r = readers();
      const res = await request(appWith('admin', { progress: store, configSource: env(true), ...r })).post('/mc/progress/backfill').send({ dryRun: true });
      expect(res.status).toBe(200);
      expect(validateNamed(res.body, 'AshbyProgressBackfillResponse', SPEC)).toEqual([]);
      // A backfill re-reads every history: two calls an application, one for
      // the application Ashby no longer has (application.info answers 404 again).
      expect(res.body).toMatchObject({
        ok: true, dryRun: true, links: 415, alreadyChecked: 412, neverChecked: 3, toCheck: 415,
        expectedCalls: 829, estimatedMinutes: 7, requestsPerSecond: 2, openBackfill: null,
      });
      expect(res.body.state).toBeUndefined();
      expect(store.startBackfill).not.toHaveBeenCalled();
      expect(store.claimDue).not.toHaveBeenCalled();
      expect(r.fail).not.toHaveBeenCalled();
      expect(entries).toHaveLength(1);
      expect(entries[0].metadata).toEqual({
        resource: 'ashby_progress_backfill_preview', links: 415, already_checked: 412, to_check: 415, expected_calls: 829, worker_enabled: true,
      });
    });
  });

  it('a run marks every link due through the one function, under the admin, and answers what it marked', async () => {
    await withAudits(async (entries) => {
      const { store, starts } = memoryStore();
      const r = readers();
      const res = await request(appWith('admin', { progress: store, configSource: env(true), ...r })).post('/mc/progress/backfill').send({ dryRun: false });
      expect(res.status).toBe(200);
      expect(validateNamed(res.body, 'AshbyProgressBackfillResponse', SPEC)).toEqual([]);
      expect(res.body).toMatchObject({
        ok: true, dryRun: false, state: 'started', startedAt: '2026-11-10T14:00:00.000Z',
        links: 415, toCheck: 415, seeded: 3, marked: 415, remaining: 415, expectedCalls: 829, estimatedMinutes: 7,
      });
      expect(starts).toEqual([{ actorId: ADMIN_ID, nowIso: '2026-11-10T14:00:00.000Z' }]);
      expect(r.fail).not.toHaveBeenCalled();
      expect(JSON.stringify(res.body)).not.toMatch(UUID_RE);
      expect(entries.map((e) => [e.event, e.metadata])).toEqual([
        ['resource.update', { resource: 'ashby_progress_backfill', state: 'started', links: 415, seeded: 3, marked: 415 }],
      ]);
    });
  });

  it('is idempotent: a second run while one is open changes nothing and says so', async () => {
    const { store } = memoryStore();
    const app = appWith('admin', { progress: store, configSource: env(true) });
    await request(app).post('/mc/progress/backfill').send({ dryRun: false });
    const again = await request(app).post('/mc/progress/backfill').send({ dryRun: false });
    expect(again.status).toBe(200);
    expect(again.body).toMatchObject({ state: 'already_running', seeded: 0, marked: 0, remaining: 415, startedAt: '2026-11-10T14:00:00.000Z' });
    expect(validateNamed(again.body, 'AshbyProgressBackfillResponse', SPEC)).toEqual([]);
    const preview = await request(app).post('/mc/progress/backfill').send({ dryRun: true });
    expect(preview.body.openBackfill).toEqual({ startedAt: '2026-11-10T14:00:00.000Z', remaining: 415 });
  });

  it.each([
    ['the switch is off', env(false)],
    ['the switch is unset', env(undefined)],
    ['the Ashby runtime is off', { ASHBY_PROGRESS_ENABLED: 'true' }],
  ])('with the worker off (%s) nothing is marked and it says the worker is off', async (_name, source) => {
    const { store } = memoryStore();
    const res = await request(appWith('admin', { progress: store, configSource: source as NodeJS.ProcessEnv })).post('/mc/progress/backfill').send({ dryRun: false });
    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({ ok: true, dryRun: false, state: 'worker_disabled', seeded: 0, marked: 0, startedAt: null, links: 415 });
    expect(res.body.worker.running).toBe(false);
    expect(validateNamed(res.body, 'AshbyProgressBackfillResponse', SPEC)).toEqual([]);
    expect(store.startBackfill).not.toHaveBeenCalled();
    // The dry run still answers, and says the same.
    const preview = await request(appWith('admin', { progress: store, configSource: source as NodeJS.ProcessEnv })).post('/mc/progress/backfill').send({ dryRun: true });
    expect(preview.body).toMatchObject({ dryRun: true, links: 415, toCheck: 415 });
    expect(preview.body.worker.running).toBe(false);
  });

  it.each([
    [{}],
    [{ dryRun: 'true' }],
    [{ dryRun: true, extra: 1 }],
    [{ dry_run: true }],
    [[true]],
  ])('refuses %j with 400, before any read', async (body) => {
    const { store } = memoryStore();
    const res = await request(appWith('admin', { progress: store, configSource: env(true) })).post('/mc/progress/backfill').send(body as object);
    expect(res.status).toBe(400);
    expect(res.body).toEqual({ ok: false, error: 'invalid_backfill_request' });
    expect(store.overview).not.toHaveBeenCalled();
    expect(store.startBackfill).not.toHaveBeenCalled();
  });

  it('an admin with no id is refused', async () => {
    const { store } = memoryStore();
    const res = await request(appWith('admin', { progress: store, configSource: env(true) }, null)).post('/mc/progress/backfill').send({ dryRun: false });
    expect(res.status).toBe(403);
    expect(store.startBackfill).not.toHaveBeenCalled();
  });

  it('a failed start answers 500 and says nothing of why', async () => {
    const { store } = memoryStore({ failStart: true });
    const res = await request(appWith('admin', { progress: store, configSource: env(true) })).post('/mc/progress/backfill').send({ dryRun: false });
    expect(res.status).toBe(500);
    expect(res.body).toEqual({ ok: false, error: 'mission_control_action_error' });
  });

  it('an audit sink that throws after the backfill opened does not turn it into a failure', async () => {
    const previous = getAuditSink();
    setAuditSink(async () => { throw new Error('sink down'); });
    try {
      const { store } = memoryStore();
      const res = await request(appWith('admin', { progress: store, configSource: env(true) })).post('/mc/progress/backfill').send({ dryRun: false });
      expect(res.status).toBe(200);
      expect(res.body.state).toBe('started');
    } finally {
      setAuditSink(previous);
    }
  });
});
