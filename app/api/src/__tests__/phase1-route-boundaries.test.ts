import { describe, expect, it } from 'vitest';
import request from 'supertest';
import { createApp } from '../app.js';

const app = createApp({ nodeEnv: 'test', webOrigin: 'http://localhost:5173' });

describe('Phase 1 public/protected route boundaries', () => {
  it('keeps recruiter resources protected', async () => {
    const response = await request(app).get('/api/roles');
    expect(response.status).toBe(401);
    expect(response.body.error.type).toBe('authentication_error');
  });

  it('mounts candidate invite exchange publicly but validates its token', async () => {
    const response = await request(app)
      .post('/api/livekit/exchange')
      .send({ token: 'not-a-valid-invite' });
    expect(response.status).toBe(400);
    expect(response.body.error.type).toBe('validation_error');
  });

  it('does not expose recruiter invite issuance publicly', async () => {
    const response = await request(app)
      .post('/api/livekit/invite')
      .send({
        candidate_id: '00000000-0000-4000-8000-000000000001',
        session_id: '00000000-0000-4000-8000-000000000002',
      });
    expect(response.status).toBe(401);
  });

  it('worker context fails closed without its separate credential', async () => {
    const previous = process.env.WORKER_CONTEXT_SECRET;
    delete process.env.WORKER_CONTEXT_SECRET;
    try {
      const response = await request(app)
        .post('/api/livekit/worker-context')
        .send({
          session_id: '00000000-0000-4000-8000-000000000001',
          room_name: 'screening-00000000-0000-4000-8000-000000000001',
        });
      expect(response.status).toBe(503);
      expect(response.body.error).toBe('worker_auth_not_configured');
    } finally {
      if (previous === undefined) delete process.env.WORKER_CONTEXT_SECRET;
      else process.env.WORKER_CONTEXT_SECRET = previous;
    }
  });
});
