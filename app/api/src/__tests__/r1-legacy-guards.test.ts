import { beforeEach, describe, expect, it, vi } from 'vitest';
import express from 'express';
import request from 'supertest';

const mocks = vi.hoisted(() => ({ from: vi.fn(), runner: vi.fn() }));
vi.mock('../lib/supabase.js', () => ({
  supabase: { from: mocks.from, rpc: vi.fn() },
  RESUME_BUCKET: 'resumes_v2',
}));
vi.mock('../services/assessment.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../services/assessment.js')>();
  return { ...actual, runAssessment: mocks.runner };
});

import { livekitRouter } from '../routes/livekit.js';
import { assessRouter, workerAssessRouter } from '../routes/assess.js';

const SESSION = '30000000-0000-4000-8000-000000000001';
const SECRET = 'r'.repeat(32);

function r1SessionQuery(round: string | null) {
  const q: any = {
    select: () => q, eq: () => q,
    maybeSingle: async () => ({ data: round ? { interview_round_id: round } : { interview_round_id: null }, error: null }),
  };
  return q;
}

describe('legacy paths fence R1 sessions', () => {
  beforeEach(() => {
    process.env.WORKER_CONTEXT_SECRET = SECRET;
    mocks.from.mockImplementation(() => r1SessionQuery('round-r1'));
    mocks.runner.mockReset();
    mocks.runner.mockRejectedValue(new Error('r1_session'));
  });

  it('preserves legacy authentication responses before the R1 fence', async () => {
    const app = express();
    app.use(express.json());
    app.use('/api/livekit', livekitRouter);
    const complete = await request(app).post(`/api/livekit/${SESSION}/complete`);
    expect(complete.status).toBe(403);
    expect(complete.body).toEqual({ error: 'access_denied' });
    expect(mocks.from).not.toHaveBeenCalled();
    const upload = await request(app).post(`/api/livekit/${SESSION}/recording`)
      .attach('file', Buffer.from('not inspected because R1 is fenced'), 'recording.webm');
    expect(upload.status).toBe(401);
    expect(upload.body).toEqual({ error: 'authentication_required' });
    expect(mocks.from).not.toHaveBeenCalled();
  });

  it('maps R1 scorer fences to 409 for recruiter and worker callers', async () => {
    const app = express();
    app.use(express.json());
    app.use((req, _res, next) => { (req as any).authUser = { id: 'admin', appRole: 'admin' }; next(); });
    app.use('/api/assess', assessRouter);
    app.use('/api/internal/assess', workerAssessRouter);
    const recruiter = await request(app).post(`/api/assess/${SESSION}`);
    expect(recruiter.status).toBe(409);
    expect(recruiter.body).toEqual({ error: 'r1_session' });
    const worker = await request(app).post(`/api/internal/assess/${SESSION}`).set('authorization', `Bearer ${SECRET}`);
    expect(worker.status).toBe(409);
    expect(worker.body).toEqual({ error: 'r1_session' });
  });

  it('does not turn an ordinary phone/legacy result into r1_session', async () => {
    mocks.from.mockImplementation(() => r1SessionQuery(null));
    mocks.runner.mockResolvedValue({ id: 'legacy-assessment' });
    const app = express();
    app.use(express.json());
    app.use((req, _res, next) => { (req as any).authUser = { id: 'admin', appRole: 'admin' }; next(); });
    app.use('/api/assess', assessRouter);
    const response = await request(app).post(`/api/assess/${SESSION}`);
    expect(response.status).toBe(200);
    expect(response.body).toEqual({ id: 'legacy-assessment' });
  });
});
