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

// ── Browser (§2.3b B-i): the MACHINE-level, session-less readiness ping ──
const BROWSER_APP = 'project-hello-voice';
const machineBody = { app: BROWSER_APP, machine_id: MACHINE };

describe('POST /internal/voice-worker/ready-machine', () => {
  it('marks ready via the session-less RPC (no session_id/epoch sent)', async () => {
    let seen: { name: string; args: Record<string, unknown> } | null = null;
    const rpc: VoiceWorkerRpcCaller = async (name, args) => {
      seen = { name, args };
      return { data: { status: 'ready', machine_id: MACHINE, epoch: 7 }, error: null };
    };
    const res = await request(appWith(rpc))
      .post('/internal/voice-worker/ready-machine')
      .set('authorization', `Bearer ${SECRET}`)
      .send(machineBody);
    expect(res.status).toBe(200);
    expect(res.body).toEqual({ ok: true, status: 'ready' });
    expect(seen!.name).toBe('mark_voice_worker_ready_machine');
    // Only app + machine + now — NEVER a session id or epoch.
    expect(seen!.args).toMatchObject({ p_app: BROWSER_APP, p_machine_id: MACHINE });
    expect(seen!.args).not.toHaveProperty('p_session_id');
    expect(seen!.args).not.toHaveProperty('p_epoch');
  });

  it('stale on no claim: ok:false status:stale', async () => {
    const rpc: VoiceWorkerRpcCaller = async () => ({ data: { status: 'stale' }, error: null });
    const res = await request(appWith(rpc))
      .post('/internal/voice-worker/ready-machine')
      .set('authorization', `Bearer ${SECRET}`)
      .send(machineBody);
    expect(res.status).toBe(200);
    expect(res.body).toEqual({ ok: false, status: 'stale' });
  });

  it('404 when disabled, having done NO database work', async () => {
    let called = false;
    const rpc: VoiceWorkerRpcCaller = async () => { called = true; return { data: {}, error: null }; };
    const res = await request(appWith(rpc, false))
      .post('/internal/voice-worker/ready-machine')
      .set('authorization', `Bearer ${SECRET}`)
      .send(machineBody);
    expect(res.status).toBe(404);
    expect(called).toBe(false);
  });

  it('auth required: no bearer → 401', async () => {
    const rpc: VoiceWorkerRpcCaller = async () => ({ data: { status: 'ready' }, error: null });
    const res = await request(appWith(rpc))
      .post('/internal/voice-worker/ready-machine')
      .send(machineBody);
    expect(res.status).toBe(401);
  });

  it('rejects a body carrying a session_id (strict schema) → 400', async () => {
    const rpc: VoiceWorkerRpcCaller = async () => ({ data: { status: 'ready' }, error: null });
    const res = await request(appWith(rpc))
      .post('/internal/voice-worker/ready-machine')
      .set('authorization', `Bearer ${SECRET}`)
      .send({ ...machineBody, session_id: SESSION, epoch: 1 });
    expect(res.status).toBe(400);
  });

  it('driver error → sanitized 500', async () => {
    const rpc: VoiceWorkerRpcCaller = async () => ({ data: null, error: { message: 'boom' } });
    const res = await request(appWith(rpc))
      .post('/internal/voice-worker/ready-machine')
      .set('authorization', `Bearer ${SECRET}`)
      .send(machineBody);
    expect(res.status).toBe(500);
    expect(res.body).toEqual({ ok: false, error: 'voice_worker_ready_error' });
  });
});

// ── M009 E2: the optional per-machine `agent_name` on /ready-machine ──
const PHONE_MACHINE = 'd895472c499e38';
const PHONE_AGENT = `phone-screener-${PHONE_MACHINE}`;
const phoneMachineBody = { app: APP, machine_id: PHONE_MACHINE };

/** A recording RPC fake with a scripted answer per RPC name. */
function scriptedRpc(
  answers: Record<string, { data: unknown; error: { message?: string } | null }>,
): { rpc: VoiceWorkerRpcCaller; calls: Array<{ name: string; args: Record<string, unknown> }> } {
  const calls: Array<{ name: string; args: Record<string, unknown> }> = [];
  const rpc: VoiceWorkerRpcCaller = async (name, args) => {
    calls.push({ name, args });
    return answers[name] ?? { data: { status: 'ready' }, error: null };
  };
  return { rpc, calls };
}

describe('POST /internal/voice-worker/ready-machine — agent_name (M009 E2)', () => {
  it('legacy body (no agent_name) → mark_ready ONLY, no name RPC, byte-identical args', async () => {
    const { rpc, calls } = scriptedRpc({});
    const res = await request(appWith(rpc))
      .post('/internal/voice-worker/ready-machine')
      .set('authorization', `Bearer ${SECRET}`)
      .send(phoneMachineBody);
    expect(res.status).toBe(200);
    expect(res.body).toEqual({ ok: true, status: 'ready' });
    expect(calls.map((c) => c.name)).toEqual(['mark_voice_worker_ready_machine']);
    expect(Object.keys(calls[0].args).sort()).toEqual(['p_app', 'p_machine_id', 'p_now']);
  });

  it('valid agent_name → set_voice_worker_agent_name THEN mark_ready, in that order', async () => {
    const { rpc, calls } = scriptedRpc({
      set_voice_worker_agent_name: { data: { status: 'ok', updated: 1 }, error: null },
    });
    const res = await request(appWith(rpc))
      .post('/internal/voice-worker/ready-machine')
      .set('authorization', `Bearer ${SECRET}`)
      .send({ ...phoneMachineBody, agent_name: PHONE_AGENT });
    expect(res.status).toBe(200);
    expect(res.body).toEqual({ ok: true, status: 'ready' });
    expect(calls.map((c) => c.name)).toEqual([
      'set_voice_worker_agent_name',
      'mark_voice_worker_ready_machine',
    ]);
    expect(calls[0].args).toMatchObject({
      p_app: APP, p_machine_id: PHONE_MACHINE, p_agent_name: PHONE_AGENT,
    });
    // The mark_ready call is unchanged by the name: no name leaks into it.
    expect(calls[1].args).not.toHaveProperty('p_agent_name');
  });

  it.each([
    ['driver error', { data: null, error: { message: 'boom row 5' } }],
    ['invalid_request', { data: { status: 'invalid_request' }, error: null }],
    ['unrecognised envelope', { data: 'ok', error: null }],
  ])('set_name %s → 500 and mark_ready is NEVER called', async (_label, answer) => {
    const { rpc, calls } = scriptedRpc({ set_voice_worker_agent_name: answer });
    const res = await request(appWith(rpc))
      .post('/internal/voice-worker/ready-machine')
      .set('authorization', `Bearer ${SECRET}`)
      .send({ ...phoneMachineBody, agent_name: PHONE_AGENT });
    expect(res.status).toBe(500);
    // Sanitized: never the driver message, never the name.
    expect(res.body).toEqual({ ok: false, error: 'voice_worker_ready_error' });
    expect(calls.map((c) => c.name)).toEqual(['set_voice_worker_agent_name']);
  });

  it('set_name stale (lease already busy/draining) → 200 ok:false status:stale, mark_ready NEVER called', async () => {
    // A targeted dial marks the lease busy; the SDK's replacement idle process
    // then re-posts this ping from prewarm. That is benign and must not be a
    // 5xx on every call — it gets the legacy non-ready answer instead.
    const { rpc, calls } = scriptedRpc({
      set_voice_worker_agent_name: { data: { status: 'stale' }, error: null },
    });
    const res = await request(appWith(rpc))
      .post('/internal/voice-worker/ready-machine')
      .set('authorization', `Bearer ${SECRET}`)
      .send({ ...phoneMachineBody, agent_name: PHONE_AGENT });
    expect(res.status).toBe(200);
    expect(res.body).toEqual({ ok: false, status: 'stale' });
    expect(calls.map((c) => c.name)).toEqual(['set_voice_worker_agent_name']);
  });

  it('set_name RPC that THROWS → 500 and mark_ready is NEVER called', async () => {
    const calls: string[] = [];
    const rpc: VoiceWorkerRpcCaller = async (name) => {
      calls.push(name);
      if (name === 'set_voice_worker_agent_name') throw new Error('network');
      return { data: { status: 'ready' }, error: null };
    };
    const res = await request(appWith(rpc))
      .post('/internal/voice-worker/ready-machine')
      .set('authorization', `Bearer ${SECRET}`)
      .send({ ...phoneMachineBody, agent_name: PHONE_AGENT });
    expect(res.status).toBe(500);
    expect(calls).toEqual(['set_voice_worker_agent_name']);
  });

  it.each([
    ['empty', ''],
    ['no hyphen at all', 'phonescreener'],
    ['uppercase suffix', 'phone-screener-D895472C499E38'],
    ['short suffix', 'phone-screener-abc'],
    ['33-char suffix', `phone-screener-${'a'.repeat(33)}`],
    ['dot in base', 'phone.screener-d895472c499e38'],
    ['65-char base', `${'b'.repeat(65)}-d895472c499e38`],
    ['non-string', 42],
  ])('bad agent_name (%s) → 400 with NO database work', async (_label, agentName) => {
    const { rpc, calls } = scriptedRpc({});
    const res = await request(appWith(rpc))
      .post('/internal/voice-worker/ready-machine')
      .set('authorization', `Bearer ${SECRET}`)
      .send({ ...phoneMachineBody, agent_name: agentName });
    expect(res.status).toBe(400);
    expect(res.body).toEqual({ ok: false, error: 'invalid_request' });
    expect(calls).toEqual([]);
  });

  it('an unknown extra field is still 400 (strict), even alongside a valid agent_name', async () => {
    const { rpc, calls } = scriptedRpc({});
    const res = await request(appWith(rpc))
      .post('/internal/voice-worker/ready-machine')
      .set('authorization', `Bearer ${SECRET}`)
      .send({ ...phoneMachineBody, agent_name: PHONE_AGENT, machine_epoch: 3 });
    expect(res.status).toBe(400);
    expect(calls).toEqual([]);
  });

  it('auth: no bearer → 401, wrong bearer → 403, both with NO database work', async () => {
    const { rpc, calls } = scriptedRpc({});
    const named = { ...phoneMachineBody, agent_name: PHONE_AGENT };
    const none = await request(appWith(rpc))
      .post('/internal/voice-worker/ready-machine')
      .send(named);
    expect(none.status).toBe(401);
    const wrong = await request(appWith(rpc))
      .post('/internal/voice-worker/ready-machine')
      .set('authorization', 'Bearer wrong-secret-wrong-secret-wrong-secret')
      .send(named);
    expect(wrong.status).toBe(403);
    expect(calls).toEqual([]);
  });

  it('404 when orchestration is disabled, with NO database work (name present)', async () => {
    const { rpc, calls } = scriptedRpc({});
    const res = await request(appWith(rpc, false))
      .post('/internal/voice-worker/ready-machine')
      .set('authorization', `Bearer ${SECRET}`)
      .send({ ...phoneMachineBody, agent_name: PHONE_AGENT });
    expect(res.status).toBe(404);
    expect(calls).toEqual([]);
  });

  it('name recorded but mark_ready stale → ok:false status:stale (no new 500 path)', async () => {
    const { rpc, calls } = scriptedRpc({
      set_voice_worker_agent_name: { data: { status: 'ok', updated: 1 }, error: null },
      mark_voice_worker_ready_machine: { data: { status: 'stale' }, error: null },
    });
    const res = await request(appWith(rpc))
      .post('/internal/voice-worker/ready-machine')
      .set('authorization', `Bearer ${SECRET}`)
      .send({ ...phoneMachineBody, agent_name: PHONE_AGENT });
    expect(res.status).toBe(200);
    expect(res.body).toEqual({ ok: false, status: 'stale' });
    expect(calls.map((c) => c.name)).toEqual([
      'set_voice_worker_agent_name',
      'mark_voice_worker_ready_machine',
    ]);
  });
});
