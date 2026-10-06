import { describe, expect, it, vi } from 'vitest';
import express from 'express';
import request from 'supertest';

const mocks = vi.hoisted(() => ({ from: vi.fn() }));
vi.mock('../lib/supabase.js', () => ({ supabase: { from: mocks.from } }));

import { createAshbyMissionControlRouter } from '../routes/ashby-mission-control.js';

const ROLE = '10000000-0000-4000-8000-000000000001';

describe('Ashby R1 role mapping guard', () => {
  it('returns the stable 400 before calling the mapping store', async () => {
    const upsertMapping = vi.fn();
    const roleInterviewKind = vi.fn(async () => ({ interviewKind: 'sales_r1' }));
    const app = express();
    app.use(express.json());
    app.use((req, _res, next) => { (req as any).authUser = { id: ROLE, appRole: 'admin' }; next(); });
    app.use('/mc', createAshbyMissionControlRouter({ store: { roleInterviewKind, upsertMapping } as never }));
    const response = await request(app).post('/mc/mappings').send({ external_job_id: 'job_r1', role_id: ROLE });
    expect(response.status).toBe(400);
    expect(response.body).toEqual({ ok: false, error: 'r1_role_not_mappable' });
    expect(roleInterviewKind).toHaveBeenCalledWith(ROLE);
    expect(mocks.from).not.toHaveBeenCalled();
    expect(upsertMapping).not.toHaveBeenCalled();
  });

  it.each([
    ['a missing role', async () => null],
    ['a role lookup failure', async () => { throw new Error('read failed'); }],
  ])('returns invalid_role_id for %s', async (_caseName, roleInterviewKind) => {
    const upsertMapping = vi.fn();
    const app = express();
    app.use(express.json());
    app.use((req, _res, next) => { (req as any).authUser = { id: ROLE, appRole: 'admin' }; next(); });
    app.use('/mc', createAshbyMissionControlRouter({ store: { roleInterviewKind, upsertMapping } as never }));

    const response = await request(app).post('/mc/mappings').send({ external_job_id: 'job_r1', role_id: ROLE });

    expect(response.status).toBe(400);
    expect(response.body).toEqual({ ok: false, error: 'invalid_role_id' });
    expect(upsertMapping).not.toHaveBeenCalled();
    expect(mocks.from).not.toHaveBeenCalled();
  });
});
