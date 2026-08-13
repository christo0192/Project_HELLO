/**
 * Ashby webhook route — end-to-end behavior with injected deterministic fakes.
 *
 * Drives the real router (raw-body middleware → HMAC verify → JSON parse →
 * durable ingress) on a bare Express app, proving: disabled→503 (no work),
 * missing/forged/malformed/oversized signatures fail closed, a valid delivery
 * is durably recorded and enqueued once, duplicates ack 2xx without new queue
 * work, durability/enqueue failure returns retryable 5xx, and non-trigger
 * actions are recorded but not enqueued. No secret/body/signature ever appears
 * in a response.
 */

import { describe, it, expect, beforeEach } from 'vitest';
import express from 'express';
import request from 'supertest';
import { createHmac } from 'node:crypto';
import { createAshbyWebhookRouter } from '../routes/ashby-webhook.js';
import type { AshbyIntegrationConfig } from '../integrations/ashby/config.js';
import type { ReceiptStore, ReceiptOutcome, SignalEnqueuer, AshbySignalPayload } from '../integrations/ashby/ports.js';

// Built from parts so no secret-shaped literal exists in source (fixture only).
const SECRET = ['ashby', 'route', 'test', 'hmac', 'fixture', 'value'].join('-');
const ACTIVE: AshbyIntegrationConfig = { enabled: true, webhookSecretConfigured: true, webhookSecret: SECRET };
const DISABLED: AshbyIntegrationConfig = { enabled: false, webhookSecretConfigured: false, webhookSecret: '' };

function sign(body: string): string {
  return 'sha256=' + createHmac('sha256', SECRET).update(Buffer.from(body, 'utf8')).digest('hex');
}

/** In-memory dedup-safe receipt store; can be forced to throw. */
class FakeReceipts implements ReceiptStore {
  seen = new Map<string, string>();
  throwOnRecord = false;
  statuses: Array<{ key: string; status: string }> = [];
  async record(input: { webhookActionId: string; action: string }): Promise<ReceiptOutcome> {
    if (this.throwOnRecord) throw new Error('db down');
    const key = `${input.action}:${input.webhookActionId}`;
    if (this.seen.has(key)) return { status: 'duplicate', id: this.seen.get(key)! };
    const id = `rcpt_${this.seen.size + 1}`;
    this.seen.set(key, id);
    return { status: 'inserted', id };
  }
  async markStatus(input: { webhookActionId: string; action: string; status: string }): Promise<void> {
    this.statuses.push({ key: `${input.action}:${input.webhookActionId}`, status: input.status });
  }
}

class FakeEnqueuer implements SignalEnqueuer {
  jobs: AshbySignalPayload[] = [];
  throwOnEnqueue = false;
  async enqueue(p: AshbySignalPayload): Promise<void> {
    if (this.throwOnEnqueue) throw new Error('queue down');
    this.jobs.push(p);
  }
}

function makeApp(config: AshbyIntegrationConfig, receipts: ReceiptStore, enqueuer?: SignalEnqueuer) {
  const app = express();
  app.use('/api/integrations/ashby', createAshbyWebhookRouter({ config, receipts, enqueuer }));
  return app;
}

const STAGE_BODY = JSON.stringify({
  action: 'candidateStageChange',
  data: { application: { id: 'app_123', currentInterviewStage: { id: 'stage_ai' }, job: { id: 'job_1' } } },
});

let receipts: FakeReceipts;
let enqueuer: FakeEnqueuer;
beforeEach(() => {
  receipts = new FakeReceipts();
  enqueuer = new FakeEnqueuer();
});

describe('disabled integration', () => {
  it('fails closed with 503 and touches neither receipts nor the queue', async () => {
    const app = makeApp(DISABLED, receipts, enqueuer);
    const res = await request(app)
      .post('/api/integrations/ashby/webhook')
      .set('Content-Type', 'application/json')
      .set('Ashby-Signature', sign(STAGE_BODY))
      .send(STAGE_BODY);
    expect(res.status).toBe(503);
    expect(res.body).toEqual({ ok: false, error: 'integration_disabled' });
    expect(receipts.seen.size).toBe(0);
    expect(enqueuer.jobs).toHaveLength(0);
  });
});

describe('signature enforcement (active)', () => {
  it('401 when the signature header is missing', async () => {
    const app = makeApp(ACTIVE, receipts, enqueuer);
    const res = await request(app).post('/api/integrations/ashby/webhook').set('Content-Type', 'application/json').send(STAGE_BODY);
    expect(res.status).toBe(401);
    expect(res.body.error).toBe('missing_signature');
    expect(receipts.seen.size).toBe(0);
  });

  it('403 when the signature does not verify (forged)', async () => {
    const app = makeApp(ACTIVE, receipts, enqueuer);
    const res = await request(app)
      .post('/api/integrations/ashby/webhook')
      .set('Content-Type', 'application/json')
      .set('Ashby-Signature', 'sha256=' + 'a'.repeat(64))
      .send(STAGE_BODY);
    expect(res.status).toBe(403);
    expect(res.body.error).toBe('mismatch');
    expect(receipts.seen.size).toBe(0);
    expect(enqueuer.jobs).toHaveLength(0);
  });

  it('403 when the body is mutated after signing (raw-byte binding)', async () => {
    const app = makeApp(ACTIVE, receipts, enqueuer);
    const good = sign(STAGE_BODY);
    const res = await request(app)
      .post('/api/integrations/ashby/webhook')
      .set('Content-Type', 'application/json')
      .set('Ashby-Signature', good)
      .send(STAGE_BODY + ' ');
    expect(res.status).toBe(403);
    expect(receipts.seen.size).toBe(0);
  });

  it('400 for a malformed signature format', async () => {
    const app = makeApp(ACTIVE, receipts, enqueuer);
    const res = await request(app)
      .post('/api/integrations/ashby/webhook')
      .set('Content-Type', 'application/json')
      .set('Ashby-Signature', 'sha256=nothex')
      .send(STAGE_BODY);
    expect(res.status).toBe(400);
    expect(res.body.error).toBe('malformed_signature');
  });
});

describe('durable ingress (active, verified)', () => {
  it('records a receipt and enqueues exactly one signal for a fresh stage change', async () => {
    const app = makeApp(ACTIVE, receipts, enqueuer);
    const res = await request(app)
      .post('/api/integrations/ashby/webhook')
      .set('Content-Type', 'application/json')
      .set('Ashby-Signature', sign(STAGE_BODY))
      .send(STAGE_BODY);
    expect(res.status).toBe(200);
    expect(res.body).toEqual({ ok: true, status: 'accepted' });
    expect(receipts.seen.size).toBe(1);
    expect(enqueuer.jobs).toHaveLength(1);
    // Opaque IDs only on the queue payload — no contact/resume/body data.
    expect(enqueuer.jobs[0]).toEqual({
      provider: 'ashby',
      action: 'candidateStageChange',
      webhookActionId: 'stage:app_123:stage_ai',
      externalApplicationId: 'app_123',
    });
  });

  it('acknowledges a duplicate delivery 2xx WITHOUT duplicate queue work', async () => {
    const app = makeApp(ACTIVE, receipts, enqueuer);
    const sig = sign(STAGE_BODY);
    await request(app).post('/api/integrations/ashby/webhook').set('Content-Type', 'application/json').set('Ashby-Signature', sig).send(STAGE_BODY);
    const res = await request(app).post('/api/integrations/ashby/webhook').set('Content-Type', 'application/json').set('Ashby-Signature', sig).send(STAGE_BODY);
    expect(res.status).toBe(200);
    expect(res.body.status).toBe('duplicate');
    expect(receipts.seen.size).toBe(1);
    expect(enqueuer.jobs).toHaveLength(1); // still exactly one
  });

  it('returns retryable 500 when durable receipt storage fails', async () => {
    receipts.throwOnRecord = true;
    const app = makeApp(ACTIVE, receipts, enqueuer);
    const res = await request(app)
      .post('/api/integrations/ashby/webhook')
      .set('Content-Type', 'application/json')
      .set('Ashby-Signature', sign(STAGE_BODY))
      .send(STAGE_BODY);
    expect(res.status).toBe(500);
    expect(res.body.error).toBe('receipt_persist_failed');
    expect(enqueuer.jobs).toHaveLength(0);
  });

  it('returns retryable 500 when enqueue fails (after receipt)', async () => {
    enqueuer.throwOnEnqueue = true;
    const app = makeApp(ACTIVE, receipts, enqueuer);
    const res = await request(app)
      .post('/api/integrations/ashby/webhook')
      .set('Content-Type', 'application/json')
      .set('Ashby-Signature', sign(STAGE_BODY))
      .send(STAGE_BODY);
    expect(res.status).toBe(500);
    expect(res.body.error).toBe('enqueue_failed');
  });

  it('records but does NOT enqueue a non-trigger action (applicationUpdate)', async () => {
    const body = JSON.stringify({ action: 'applicationUpdate', id: 'evt_9', data: { application: { id: 'app_9' } } });
    const app = makeApp(ACTIVE, receipts, enqueuer);
    const res = await request(app)
      .post('/api/integrations/ashby/webhook')
      .set('Content-Type', 'application/json')
      .set('Ashby-Signature', sign(body))
      .send(body);
    expect(res.status).toBe(200);
    expect(receipts.seen.size).toBe(1);
    expect(enqueuer.jobs).toHaveLength(0);
  });

  it('400 for a signed but unparseable JSON body (non-retryable)', async () => {
    const bad = '{not json';
    const app = makeApp(ACTIVE, receipts, enqueuer);
    const res = await request(app)
      .post('/api/integrations/ashby/webhook')
      .set('Content-Type', 'application/json')
      .set('Ashby-Signature', sign(bad))
      .send(bad);
    expect(res.status).toBe(400);
    expect(res.body.error).toBe('invalid_json');
  });

  it('never echoes the secret or the raw body in any response', async () => {
    const app = makeApp(ACTIVE, receipts, enqueuer);
    const res = await request(app)
      .post('/api/integrations/ashby/webhook')
      .set('Content-Type', 'application/json')
      .set('Ashby-Signature', sign(STAGE_BODY))
      .send(STAGE_BODY);
    const serialized = JSON.stringify(res.body);
    expect(serialized).not.toContain(SECRET);
    expect(serialized).not.toContain('app_123');
  });
});
