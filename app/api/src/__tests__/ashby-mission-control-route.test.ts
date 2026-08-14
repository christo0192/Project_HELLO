/**
 * Ashby Mission Control route — authz matrix, validation, and action mapping.
 *
 * Reads require interviewer+; actions require admin; a viewer/candidate/
 * unauthenticated caller fails closed (403). Sanitized projections only; the
 * race-safe audited RPCs are exercised via an injected store.
 */

import { describe, it, expect } from 'vitest';
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
