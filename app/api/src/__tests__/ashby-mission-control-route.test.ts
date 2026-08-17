/**
 * Ashby Mission Control route — authz matrix, validation, and action mapping.
 *
 * Reads require interviewer+; actions require admin; a viewer/candidate/
 * unauthenticated caller fails closed (403). Sanitized projections only; the
 * race-safe audited RPCs are exercised via an injected store.
 */

import { describe, it, expect, vi } from 'vitest';
import express, { type Request, type Response, type NextFunction } from 'express';
import request from 'supertest';
import { createAshbyMissionControlRouter } from '../routes/ashby-mission-control.js';
import type { MissionControlStore } from '../integrations/ashby/workflow-stores.js';

const UUID = '11111111-1111-4111-8111-111111111111';

function fakeStore(over: Partial<MissionControlStore> = {}): MissionControlStore {
  return {
    listMappings: async () => [
      { id: UUID, externalJobId: 'job_1', status: 'drift', statusReason: 'stage_id_invalid', deliveryMode: 'both', hasAiStage: true, hasTaStage: false, label: null, updatedAt: '2026-08-13T00:00:00Z' },
    ],
    listWorkflows: async () => [
      { applicationLinkId: UUID, externalApplicationId: 'app_1', externalJobId: 'job_1', lifecycle: 'processing', terminalState: null, ingestionState: 'failed_review', operations: [{ id: 'op_1', type: 'stage_move', state: 'failed', errorCode: 'transient_x' }], updatedAt: '2026-08-13T00:00:00Z' },
    ],
    setMappingStatus: async () => ({ status: 'ok', mappingStatus: 'paused' }),
    cancelApplication: async () => ({ status: 'ok', cancelledOperations: 2, cancelledIngestion: 1 }),
    retryOperation: async () => ({ status: 'ok' }),
    upsertMapping: async () => ({ status: 'ok', id: UUID }),
    ...over,
  };
}

function appWith(role: string | null, store: MissionControlStore) {
  const app = express();
  app.use(express.json());
  app.use((req: Request, _res: Response, next: NextFunction) => {
    if (role) (req as unknown as { authUser: unknown }).authUser = { id: 'user_1', appRole: role };
    next();
  });
  app.use('/mc', createAshbyMissionControlRouter({ store }));
  return app;
}

describe('reads — interviewer+ only', () => {
  it('lists mappings + workflows for an interviewer (sanitized)', async () => {
    const app = appWith('interviewer', fakeStore());
    const m = await request(app).get('/mc/mappings');
    expect(m.status).toBe(200);
    expect(m.body.mappings[0]).not.toHaveProperty('email');
    expect(m.body.mappings[0].status).toBe('drift');
    const w = await request(app).get('/mc/workflows');
    expect(w.status).toBe(200);
    expect(w.body.workflows[0].ingestionState).toBe('failed_review');
    // No token/PII fields leak.
    expect(JSON.stringify(w.body)).not.toMatch(/token|email|phone|bearer/i);
  });

  it('fails closed for a viewer and for an unauthenticated caller', async () => {
    expect((await request(appWith('viewer', fakeStore())).get('/mc/mappings')).status).toBe(403);
    expect((await request(appWith(null, fakeStore())).get('/mc/mappings')).status).toBe(403);
  });
});

describe('actions — admin only', () => {
  it('rejects an interviewer from mutating', async () => {
    expect((await request(appWith('interviewer', fakeStore())).post(`/mc/mappings/${UUID}/pause`)).status).toBe(403);
    expect((await request(appWith('interviewer', fakeStore())).post(`/mc/workflows/${UUID}/cancel`).send({ terminal_state: 'withdrawn' })).status).toBe(403);
  });

  it('admin can pause, resume, cancel, retry', async () => {
    const app = appWith('admin', fakeStore());
    expect((await request(app).post(`/mc/mappings/${UUID}/pause`)).status).toBe(200);
    const cancel = await request(app).post(`/mc/workflows/${UUID}/cancel`).send({ terminal_state: 'withdrawn', reason: 'candidate withdrew' });
    expect(cancel.status).toBe(200);
    expect(cancel.body.cancelled_operations).toBe(2);
    expect((await request(app).post(`/mc/operations/${UUID}/retry`)).status).toBe(200);
  });

  it('maps RPC gate statuses to 404/409', async () => {
    const notFound = appWith('admin', fakeStore({ setMappingStatus: async () => ({ status: 'not_found' }) }));
    expect((await request(notFound).post(`/mc/mappings/${UUID}/resume`)).status).toBe(404);
    const incomplete = appWith('admin', fakeStore({ setMappingStatus: async () => ({ status: 'incomplete_cannot_enable' }) }));
    expect((await request(incomplete).post(`/mc/mappings/${UUID}/resume`)).status).toBe(409);
    const alreadyTerminal = appWith('admin', fakeStore({ cancelApplication: async () => ({ status: 'already_terminal' }) }));
    expect((await request(alreadyTerminal).post(`/mc/workflows/${UUID}/cancel`).send({ terminal_state: 'deleted' })).status).toBe(409);
  });

  it('validates ids and terminal_state', async () => {
    const app = appWith('admin', fakeStore());
    expect((await request(app).post('/mc/mappings/not-a-uuid/pause')).status).toBe(400);
    expect((await request(app).post(`/mc/workflows/${UUID}/cancel`).send({ terminal_state: 'bogus' })).status).toBe(400);
  });
});

// ═══════════════════════════════════════════════════════════════════════
// Runtime activation surfaces (health · mapping provisioning · stage probe)
// ═══════════════════════════════════════════════════════════════════════

const SENTINEL_APIKEY = 'SENTINEL_APIKEY_aaaaaaaaaaaaaaaaaaaa';
const SENTINEL_SECRET = 'SENTINEL_SECRET_bbbbbbbbbbbbbbbbbbbb';

/** Fully-on synthetic env; never real credentials. */
function activeEnv(over: Record<string, string> = {}): NodeJS.ProcessEnv {
  return {
    ASHBY_INTEGRATION_ENABLED: 'true',
    ASHBY_WEBHOOK_SECRET: SENTINEL_SECRET,
    ASHBY_RUNTIME_ENABLED: 'true',
    ASHBY_API_KEY: SENTINEL_APIKEY,
    ASHBY_RESUME_HOSTS: 'files.ashby.example',
    ...over,
  } as NodeJS.ProcessEnv;
}

function appWithDeps(role: string | null, deps: Parameters<typeof createAshbyMissionControlRouter>[0]) {
  const app = express();
  app.use(express.json());
  app.use((req: Request, _res: Response, next: NextFunction) => {
    if (role) (req as unknown as { authUser: unknown }).authUser = { id: UUID, appRole: role };
    next();
  });
  app.use('/mc', createAshbyMissionControlRouter(deps));
  return app;
}

describe('GET /health — truthful and sanitized', () => {
  it('reports booleans/counts only and leaks no secret material', async () => {
    const app = appWithDeps('interviewer', {
      store: fakeStore(), probeReader: null, configSource: activeEnv(),
    });
    const res = await request(app).get('/mc/health');
    expect(res.status).toBe(200);

    const body = JSON.stringify(res.body);
    expect(body).not.toContain(SENTINEL_APIKEY);
    expect(body).not.toContain(SENTINEL_SECRET);
    expect(body).not.toContain('SENTINEL_');
    // The presigned host is tenant-identifying: the COUNT is reported, not the host.
    expect(body).not.toContain('files.ashby.example');
    expect(res.body.runtime.resumeAllowlistCount).toBe(1);
    expect(res.body.runtime.resumeAllowlistEnabled).toBe(true);
    expect(res.body.integration).toEqual({ enabled: true, webhookSecretConfigured: true, active: true });
    expect(res.body.runtime.apiKeyConfigured).toBe(true);
  });

  it('reports all-false with the shipped defaults', async () => {
    const app = appWithDeps('interviewer', {
      store: fakeStore(), probeReader: null, configSource: {} as NodeJS.ProcessEnv,
    });
    const res = await request(app).get('/mc/health');
    expect(res.body.integration.active).toBe(false);
    expect(res.body.runtime.runtimeEnabled).toBe(false);
    expect(res.body.runtime.apiKeyConfigured).toBe(false);
    expect(res.body.runtime.resumeAllowlistEnabled).toBe(false);
    expect(res.body.runtime.active).toBe(false);
  });

  it('makes no live-connectivity claim it has not verified', async () => {
    const app = appWithDeps('interviewer', {
      store: fakeStore(), probeReader: null, configSource: activeEnv(),
    });
    const res = await request(app).get('/mc/health');
    // Nothing in this handler contacts Ashby, so "ok" would be a lie.
    expect(res.body.provider).toBe('unknown');
  });

  it('is interviewer-gated', async () => {
    const deps = { store: fakeStore(), probeReader: null, configSource: activeEnv() };
    expect((await request(appWithDeps('viewer', deps)).get('/mc/health')).status).toBe(403);
    expect((await request(appWithDeps(null, deps)).get('/mc/health')).status).toBe(403);
  });
});

describe('POST /mappings — always paused, never enables', () => {
  const valid = {
    external_job_id: 'job_1',
    role_id: UUID,
    delivery_mode: 'manual',
    ai_screening_stage_id: 'stage_ai',
    ta_screening_stage_id: 'stage_ta',
  };

  it('creates a mapping and forces status=paused', async () => {
    const seen: unknown[] = [];
    const store = fakeStore({
      upsertMapping: async (input) => { seen.push(input); return { status: 'ok', id: UUID }; },
    });
    const res = await request(appWithDeps('admin', { store, probeReader: null })).post('/mc/mappings').send(valid);
    expect(res.status).toBe(201);
    expect(res.body.status).toBe('paused');
    // The route never forwards a caller-supplied status.
    expect(JSON.stringify(seen)).not.toContain('enabled');
  });

  it('ignores a caller attempt to enable through this surface', async () => {
    const seen: Array<Record<string, unknown>> = [];
    const store = fakeStore({
      upsertMapping: async (input) => { seen.push(input as never); return { status: 'ok', id: UUID }; },
    });
    const res = await request(appWithDeps('admin', { store, probeReader: null }))
      .post('/mc/mappings').send({ ...valid, status: 'enabled' });
    expect(res.status).toBe(201);
    expect(res.body.status).toBe('paused');
    expect(seen[0]).not.toHaveProperty('status');
  });

  it('is admin-only', async () => {
    const deps = { store: fakeStore(), probeReader: null };
    expect((await request(appWithDeps('interviewer', deps)).post('/mc/mappings').send(valid)).status).toBe(403);
    expect((await request(appWithDeps(null, deps)).post('/mc/mappings').send(valid)).status).toBe(403);
  });

  it('rejects malformed input without touching the store', async () => {
    let called = 0;
    const store = fakeStore({ upsertMapping: async () => { called += 1; return { status: 'ok' }; } });
    const app = appWithDeps('admin', { store, probeReader: null });

    const bad: Array<[string, Record<string, unknown>]> = [
      ['invalid_external_job_id', { ...valid, external_job_id: 'has space' }],
      ['invalid_role_id', { ...valid, role_id: 'not-a-uuid' }],
      ['invalid_delivery_mode', { ...valid, delivery_mode: 'carrier_pigeon' }],
      ['invalid_invite_ttl_hours', { ...valid, invite_ttl_hours: 48 }],
      ['invalid_stage_id', { ...valid, ai_screening_stage_id: 'bad id with spaces' }],
      ['invalid_mapping_id', { ...valid, id: 'nope' }],
      ['invalid_label', { ...valid, label: 'x'.repeat(200) }],
    ];
    for (const [expected, body] of bad) {
      const res = await request(app).post('/mc/mappings').send(body);
      expect(res.status, expected).toBe(400);
      expect(res.body.error, JSON.stringify(body)).toBe(expected);
    }
    expect(called).toBe(0);
  });

  it('accepts the fixed 24-hour TTL when stated explicitly', async () => {
    const store = fakeStore({ upsertMapping: async () => ({ status: 'ok', id: UUID }) });
    const res = await request(appWithDeps('admin', { store, probeReader: null }))
      .post('/mc/mappings').send({ ...valid, invite_ttl_hours: 24 });
    expect(res.status).toBe(201);
  });
});

describe('GET /jobs/:externalJobId/stages — read-only probe', () => {
  it('returns sanitized stages for an admin', async () => {
    const probeReader = {
      jobInterviewPlanInfo: async () => ({
        results: { interviewStages: [{ id: 'stage_ai', title: 'Bot Screening', candidateEmail: 'leak@example.invalid' }] },
      }),
    };
    const res = await request(appWithDeps('admin', { store: fakeStore(), probeReader: probeReader as never }))
      .get('/mc/jobs/job_1/stages');
    expect(res.status).toBe(200);
    expect(res.body.stages).toEqual([{ id: 'stage_ai', title: 'Bot Screening' }]);
    expect(JSON.stringify(res.body)).not.toContain('leak@example.invalid');
  });

  it('answers 503 when the runtime gates are closed — no client, no call', async () => {
    const res = await request(appWithDeps('admin', { store: fakeStore(), probeReader: null }))
      .get('/mc/jobs/job_1/stages');
    expect(res.status).toBe(503);
    expect(res.body.error).toBe('integration_disabled');
  });

  it('is admin-only', async () => {
    const deps = { store: fakeStore(), probeReader: null };
    expect((await request(appWithDeps('interviewer', deps)).get('/mc/jobs/job_1/stages')).status).toBe(403);
    expect((await request(appWithDeps(null, deps)).get('/mc/jobs/job_1/stages')).status).toBe(403);
  });

  it('rejects a malformed job id before any provider call', async () => {
    const jobInterviewPlanInfo = vi.fn();
    const res = await request(appWithDeps('admin', { store: fakeStore(), probeReader: { jobInterviewPlanInfo } as never }))
      .get('/mc/jobs/has%20space/stages');
    expect(res.status).toBe(400);
    expect(jobInterviewPlanInfo).not.toHaveBeenCalled();
  });

  it('reports a tenant failure as a sanitized capability error and enables nothing', async () => {
    const probeReader = {
      jobInterviewPlanInfo: async () => { throw new Error('403 Forbidden: tenant xyz lacks scope'); },
    };
    const res = await request(appWithDeps('admin', { store: fakeStore(), probeReader: probeReader as never }))
      .get('/mc/jobs/job_1/stages');
    expect(res.status).toBe(502);
    expect(res.body.error).toBe('probe_unavailable');
    expect(JSON.stringify(res.body)).not.toContain('tenant xyz');
  });
});

describe('retry — audited RPC statuses map to HTTP', () => {
  it('refuses to resurrect an operation on a terminal application', async () => {
    const store = fakeStore({ retryOperation: async () => ({ status: 'blocked_terminal' }) });
    const res = await request(appWithDeps('admin', { store, probeReader: null })).post(`/mc/operations/${UUID}/retry`);
    expect(res.status).toBe(409);
    expect(res.body.error).toBe('blocked_terminal');
  });

  it('refuses once the attempt ceiling is reached', async () => {
    const store = fakeStore({ retryOperation: async () => ({ status: 'retry_exhausted' }) });
    const res = await request(appWithDeps('admin', { store, probeReader: null })).post(`/mc/operations/${UUID}/retry`);
    expect(res.status).toBe(409);
    expect(res.body.error).toBe('retry_exhausted');
  });

  it('passes the acting admin through so the RPC can audit it', async () => {
    const actors: string[] = [];
    const store = fakeStore({ retryOperation: async (_id, actorId) => { actors.push(actorId); return { status: 'ok' }; } });
    await request(appWithDeps('admin', { store, probeReader: null })).post(`/mc/operations/${UUID}/retry`);
    expect(actors).toEqual([UUID]);
  });
});
