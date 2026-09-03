/**
 * PR B — the readiness endpoint POST /internal/voice-worker/ready
 * (`createVoiceWorkerRouter`).
 *
 * Properties under test:
 *   - marks ready: forwards the RPC's `ready` verdict as ok:true.
 *   - stale on mismatch: a `stale` RPC verdict is ok:false status:stale.
 *   - 404 when disabled (WORKER_ORCHESTRATION off): no DB work.
 *   - auth required: same WORKER_CONTEXT_SECRET bearer as the phone-worker surface.
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import express from 'express';
import request from 'supertest';
import { createVoiceWorkerRouter, type VoiceWorkerRpcCaller } from '../routes/voice-worker.js';

const SECRET = 'voice-worker-secret-0123456789abcdefghij';
const APP = 'project-hello-phone-voice';
const MACHINE = 'd891234abcd567';
const SESSION = '99999999-8888-4777-8666-555555555555';

let savedSecret: string | undefined;
beforeEach(() => {
  savedSecret = process.env.WORKER_CONTEXT_SECRET;
  process.env.WORKER_CONTEXT_SECRET = SECRET;
});
afterEach(() => {
  if (savedSecret === undefined) delete process.env.WORKER_CONTEXT_SECRET;
  else process.env.WORKER_CONTEXT_SECRET = savedSecret;
});

function appWith(rpc: VoiceWorkerRpcCaller, enabled = true) {
  const app = express();
  app.use('/internal/voice-worker', express.json(), createVoiceWorkerRouter({ enabled, rpc }));
  return app;
}

const body = { app: APP, machine_id: MACHINE, session_id: SESSION, epoch: 3 };

describe('POST /internal/voice-worker/ready', () => {
  it('marks ready: forwards the RPC ready verdict as ok:true', async () => {
    let seen: { name: string; args: Record<string, unknown> } | null = null;
    const rpc: VoiceWorkerRpcCaller = async (name, args) => {
      seen = { name, args };
      return { data: { status: 'ready', machine_id: MACHINE, epoch: 3 }, error: null };
    };
    const res = await request(appWith(rpc))
      .post('/internal/voice-worker/ready')
      .set('authorization', `Bearer ${SECRET}`)
      .send(body);
    expect(res.status).toBe(200);
    expect(res.body).toEqual({ ok: true, status: 'ready' });
    expect(seen!.name).toBe('mark_voice_worker_ready');
    expect(seen!.args).toMatchObject({
      p_app: APP, p_machine_id: MACHINE, p_session_id: SESSION, p_epoch: 3,
    });
  });

  it('stale on mismatch: a stale RPC verdict is ok:false status:stale', async () => {
    const rpc: VoiceWorkerRpcCaller = async () => ({ data: { status: 'stale' }, error: null });
    const res = await request(appWith(rpc))
      .post('/internal/voice-worker/ready')
      .set('authorization', `Bearer ${SECRET}`)
      .send(body);
    expect(res.status).toBe(200);
    expect(res.body).toEqual({ ok: false, status: 'stale' });
  });

  it('404 when disabled, having done NO database work', async () => {
    let called = false;
    const rpc: VoiceWorkerRpcCaller = async () => { called = true; return { data: {}, error: null }; };
    const res = await request(appWith(rpc, false))
      .post('/internal/voice-worker/ready')
      .set('authorization', `Bearer ${SECRET}`)
      .send(body);
    expect(res.status).toBe(404);
    expect(called).toBe(false);
  });

  it('auth required: no bearer → 401', async () => {
    const rpc: VoiceWorkerRpcCaller = async () => ({ data: { status: 'ready' }, error: null });
    const res = await request(appWith(rpc))
      .post('/internal/voice-worker/ready')
      .send(body);
    expect(res.status).toBe(401);
  });

  it('auth required: wrong bearer → 403', async () => {
    const rpc: VoiceWorkerRpcCaller = async () => ({ data: { status: 'ready' }, error: null });
    const res = await request(appWith(rpc))
      .post('/internal/voice-worker/ready')
      .set('authorization', 'Bearer wrong-secret-wrong-secret-wrong-secret')
      .send(body);
    expect(res.status).toBe(403);
  });

  it('invalid body → 400', async () => {
    const rpc: VoiceWorkerRpcCaller = async () => ({ data: { status: 'ready' }, error: null });
    const res = await request(appWith(rpc))
      .post('/internal/voice-worker/ready')
      .set('authorization', `Bearer ${SECRET}`)
      .send({ app: APP }); // missing fields
    expect(res.status).toBe(400);
  });

  it('driver error → sanitized 500', async () => {
    const rpc: VoiceWorkerRpcCaller = async () => ({ data: null, error: { message: 'boom row 5' } });
    const res = await request(appWith(rpc))
      .post('/internal/voice-worker/ready')
      .set('authorization', `Bearer ${SECRET}`)
      .send(body);
    expect(res.status).toBe(500);
    expect(res.body).toEqual({ ok: false, error: 'voice_worker_ready_error' });
  });
});
