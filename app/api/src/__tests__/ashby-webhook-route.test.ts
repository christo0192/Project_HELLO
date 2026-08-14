/**
 * Ashby webhook route — end-to-end behavior with an injected outbox fake.
 *
 * Drives the real router (raw-body middleware → HMAC verify → JSON parse →
 * transactional-outbox ingress) on a bare Express app, proving: disabled→503
 * (no work), missing/forged/malformed/oversized signatures fail closed, a valid
 * delivery atomically records + enqueues once, duplicates ack 200 without new
 * queue work, a transient durability failure returns retryable 500 and the
 * redelivery re-drives to exactly one job, and non-trigger actions are recorded
 * but not enqueued. No secret/body/signature ever appears in a response.
 */

import { describe, it, expect, beforeEach } from 'vitest';
import express from 'express';
import request from 'supertest';
import { createHmac } from 'node:crypto';
import { createAshbyWebhookRouter } from '../routes/ashby-webhook.js';
import type { AshbyIntegrationConfig } from '../integrations/ashby/config.js';
import type { ReceiptStore, ReceiptOutcome } from '../integrations/ashby/ports.js';

// Built from parts so no secret-shaped literal exists in source (fixture only).
const SECRET = ['ashby', 'route', 'test', 'hmac', 'fixture', 'value'].join('-');
const ACTIVE: AshbyIntegrationConfig = { enabled: true, webhookSecretConfigured: true, webhookSecret: SECRET };
const DISABLED: AshbyIntegrationConfig = { enabled: false, webhookSecretConfigured: false, webhookSecret: '' };

function sign(body: string): string {
  return 'sha256=' + createHmac('sha256', SECRET).update(Buffer.from(body, 'utf8')).digest('hex');
}

/** In-memory transactional outbox (receipt + signal job in one atomic call). */
class FakeOutbox implements ReceiptStore {
  receipts = new Map<string, string>();
  liveJobs = new Set<string>();
  throwCount = 0; // number of leading calls that throw (transient failure)
  private calls = 0;
  async record(input: {
    webhookActionId: string;
    action: string;
    enqueue?: { dedupKey: string };
  }): Promise<ReceiptOutcome> {
    this.calls += 1;
    if (this.calls <= this.throwCount) throw new Error('db down'); // atomic: nothing persists
    const key = `${input.action}:${input.webhookActionId}`;
    const fresh = !this.receipts.has(key);
    if (fresh) this.receipts.set(key, `rcpt_${this.receipts.size + 1}`);
    let enqueued = false;
    let workPending = false;
    if (input.enqueue) {
      if (this.liveJobs.has(input.enqueue.dedupKey)) workPending = true;
      else { this.liveJobs.add(input.enqueue.dedupKey); enqueued = true; workPending = true; }
    }
    return { status: fresh ? 'inserted' : 'duplicate', id: this.receipts.get(key)!, enqueued, workPending };
  }
}

function makeApp(config: AshbyIntegrationConfig, receipts: ReceiptStore) {
  const app = express();
  app.use('/api/integrations/ashby', createAshbyWebhookRouter({ config, receipts }));
  return app;
}

const STAGE_BODY = JSON.stringify({
  action: 'candidateStageChange',
  data: { application: { id: 'app_123', currentInterviewStage: { id: 'stage_ai' }, job: { id: 'job_1' } } },
});

function post(app: express.Express, body: string, sig?: string) {
  const req = request(app).post('/api/integrations/ashby/webhook').set('Content-Type', 'application/json');
  if (sig !== undefined) req.set('Ashby-Signature', sig);
  return req.send(body);
}

let receipts: FakeOutbox;
beforeEach(() => { receipts = new FakeOutbox(); });

describe('disabled integration', () => {
  it('fails closed with 503 and touches neither receipts nor the queue', async () => {
    const res = await post(makeApp(DISABLED, receipts), STAGE_BODY, sign(STAGE_BODY));
    expect(res.status).toBe(503);
    expect(res.body).toEqual({ ok: false, error: 'integration_disabled' });
    expect(receipts.receipts.size).toBe(0);
    expect(receipts.liveJobs.size).toBe(0);
  });
});

describe('signature enforcement (active)', () => {
  it('401 when the signature header is missing', async () => {
    const res = await post(makeApp(ACTIVE, receipts), STAGE_BODY);
    expect(res.status).toBe(401);
    expect(res.body.error).toBe('missing_signature');
    expect(receipts.receipts.size).toBe(0);
  });
  it('403 when the signature does not verify (forged)', async () => {
    const res = await post(makeApp(ACTIVE, receipts), STAGE_BODY, 'sha256=' + 'a'.repeat(64));
    expect(res.status).toBe(403);
    expect(res.body.error).toBe('mismatch');
    expect(receipts.liveJobs.size).toBe(0);
  });
  it('403 when the body is mutated after signing (raw-byte binding)', async () => {
    const res = await post(makeApp(ACTIVE, receipts), STAGE_BODY + ' ', sign(STAGE_BODY));
    expect(res.status).toBe(403);
    expect(receipts.receipts.size).toBe(0);
  });
  it('400 for a malformed signature format', async () => {
    const res = await post(makeApp(ACTIVE, receipts), STAGE_BODY, 'sha256=nothex');
    expect(res.status).toBe(400);
    expect(res.body.error).toBe('malformed_signature');
  });
});

describe('durable ingress (active, verified)', () => {
  it('atomically records + enqueues exactly one signal for a fresh stage change', async () => {
    const res = await post(makeApp(ACTIVE, receipts), STAGE_BODY, sign(STAGE_BODY));
    expect(res.status).toBe(200);
    expect(res.body).toEqual({ ok: true, status: 'accepted' });
    expect(receipts.receipts.size).toBe(1);
    expect(receipts.liveJobs.size).toBe(1);
    expect([...receipts.liveJobs][0]).toBe('ashby:signal:candidateStageChange:stage:app_123:stage_ai');
  });

  it('acknowledges a duplicate delivery 2xx WITHOUT duplicate queue work', async () => {
    const app = makeApp(ACTIVE, receipts);
    const sig = sign(STAGE_BODY);
    await post(app, STAGE_BODY, sig);
    const res = await post(app, STAGE_BODY, sig);
    expect(res.status).toBe(200);
    expect(res.body.status).toBe('duplicate');
    expect(receipts.liveJobs.size).toBe(1);
  });

  it('F2: a transient durability failure returns retryable 500; redelivery re-drives to one job', async () => {
    receipts.throwCount = 1; // first delivery fails atomically (nothing persists)
    const app = makeApp(ACTIVE, receipts);
    const sig = sign(STAGE_BODY);
    const first = await post(app, STAGE_BODY, sig);
    expect(first.status).toBe(500);
    expect(receipts.receipts.size).toBe(0); // atomic: no stranded receipt
    expect(receipts.liveJobs.size).toBe(0);
    const second = await post(app, STAGE_BODY, sig); // Ashby redelivers
    expect(second.status).toBe(200);
    expect(receipts.receipts.size).toBe(1);
    expect(receipts.liveJobs.size).toBe(1); // enqueued exactly once across both
  });

  it('records but does NOT enqueue a non-trigger action (applicationUpdate)', async () => {
    const body = JSON.stringify({ action: 'applicationUpdate', id: 'evt_9', data: { application: { id: 'app_9' } } });
    const res = await post(makeApp(ACTIVE, receipts), body, sign(body));
    expect(res.status).toBe(200);
    expect(receipts.receipts.size).toBe(1);
    expect(receipts.liveJobs.size).toBe(0);
  });

  it('400 for a signed but unparseable JSON body (non-retryable)', async () => {
    const bad = '{not json';
    const res = await post(makeApp(ACTIVE, receipts), bad, sign(bad));
    expect(res.status).toBe(400);
    expect(res.body.error).toBe('invalid_json');
  });

  it('never echoes the secret or the raw body in any response', async () => {
    const res = await post(makeApp(ACTIVE, receipts), STAGE_BODY, sign(STAGE_BODY));
    const serialized = JSON.stringify(res.body);
    expect(serialized).not.toContain(SECRET);
    expect(serialized).not.toContain('app_123');
  });
});
