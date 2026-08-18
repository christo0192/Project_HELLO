/**
 * Ashby ingress + extractors + config — unit coverage for the pure layers,
 * including the transactional-outbox re-drive (F2) semantics.
 */

import { describe, it, expect } from 'vitest';
import {
  extractWebhookSignal,
  extractApplicationInfo,
  stageDedupId,
} from '../integrations/ashby/extractors.js';
import { ingestWebhook } from '../integrations/ashby/ingress.js';
import { loadAshbyConfig, isAshbyWebhookActive, describeAshbyConfig } from '../integrations/ashby/config.js';
import type { ReceiptStore, ReceiptOutcome } from '../integrations/ashby/ports.js';

/**
 * Fake that faithfully models the 0030 transactional outbox: receipts dedup on
 * (action, webhookActionId); a live-job set keyed by dedupKey; a per-receipt
 * terminal-status map. `record` with an enqueue spec re-drives a missing job
 * unless durable work already exists (a live job, or a terminal receipt).
 */
class FakeOutbox implements ReceiptStore {
  receipts = new Map<string, string>();
  liveJobs = new Set<string>();
  terminal = new Set<string>(); // receipt keys the worker has finished
  throwOnRecord = false;
  forceNoWork = false; // simulate an outbox that could not establish work
  async record(input: {
    webhookActionId: string;
    action: string;
    metadata?: Record<string, unknown> | null;
    enqueue?: { queueName: string; dedupKey: string; payload: unknown };
  }): Promise<ReceiptOutcome> {
    if (this.throwOnRecord) throw new Error('db down');
    const key = `${input.action}:${input.webhookActionId}`;
    const fresh = !this.receipts.has(key);
    if (fresh) this.receipts.set(key, `rcpt_${this.receipts.size + 1}`);
    const id = this.receipts.get(key)!;

    let enqueued = false;
    let workPending = false;
    if (input.enqueue) {
      if (this.forceNoWork) return { status: fresh ? 'inserted' : 'duplicate', id, enqueued: false, workPending: false };
      const dk = input.enqueue.dedupKey;
      if (this.terminal.has(key)) workPending = true;
      else if (this.liveJobs.has(dk)) workPending = true;
      else { this.liveJobs.add(dk); enqueued = true; workPending = true; }
    }
    return { status: fresh ? 'inserted' : 'duplicate', id, enqueued, workPending };
  }
}

const STAGE_BODY = { action: 'candidateStageChange', data: { application: { id: 'a', currentInterviewStage: { id: 's' } } } };

describe('extractWebhookSignal', () => {
  it('uses a stage-centric dedup id for candidateStageChange', () => {
    const r = extractWebhookSignal({ action: 'candidateStageChange', data: { application: { id: 'app_1', currentInterviewStage: { id: 's1' } } } });
    expect(r).toEqual({ ok: true, signal: expect.objectContaining({ webhookActionId: 'stage:app_1:s1', action: 'candidateStageChange', externalApplicationId: 'app_1', externalStageId: 's1' }) });
  });
  it('prefers an explicit provider id for non-stage actions', () => {
    const r = extractWebhookSignal({ action: 'applicationUpdate', id: 'evt_7', data: { application: { id: 'app_1' } } });
    expect(r.ok && r.signal.webhookActionId).toBe('evt_7');
  });
  it('falls back to a deterministic composite when no explicit id (non-stage)', () => {
    const r = extractWebhookSignal({ action: 'applicationUpdate', data: { application: { id: 'app_9' } } });
    expect(r.ok && r.signal.webhookActionId).toBe('derived:applicationUpdate:app_9');
  });
  it('fails closed on non-object, missing action, or unresolvable id', () => {
    expect(extractWebhookSignal('x')).toEqual({ ok: false, reason: 'not_object' });
    expect(extractWebhookSignal({ data: {} })).toEqual({ ok: false, reason: 'missing_action' });
    expect(extractWebhookSignal({ action: 'applicationUpdate' })).toEqual({ ok: false, reason: 'unresolvable_id' });
  });
  it('rejects control chars (raw-NUL escaped, not a literal NUL byte)', () => {
    expect(extractWebhookSignal({ action: 'a b' })).toEqual({ ok: false, reason: 'missing_action' });
  });
});

describe('extractApplicationInfo', () => {
  it('reads id/job/stage from a nested application', () => {
    expect(extractApplicationInfo({ application: { id: 'a', job: { id: 'j' }, currentInterviewStage: { id: 's' } } }))
      .toEqual({ applicationId: 'a', jobId: 'j', currentStageId: 's' });
  });
  it('returns {} for a non-object', () => {
    expect(extractApplicationInfo(null)).toEqual({});
  });
});

describe('stageDedupId', () => {
  it('is deterministic and stage-centric', () => {
    expect(stageDedupId('app', 'stg')).toBe('stage:app:stg');
    expect(stageDedupId('app', undefined)).toBe('stage:app:nostage');
  });
});

describe('ingestWebhook outcomes (transactional outbox)', () => {
  it('returns unrecognized 400 for an idless/actionless body', async () => {
    const out = await ingestWebhook({ nothing: true }, { receipts: new FakeOutbox() });
    expect(out).toMatchObject({ kind: 'unrecognized', httpStatus: 400 });
  });

  it('acks the official idless Ashby ping without persistence or queue work', async () => {
    const receipts = new FakeOutbox();
    const out = await ingestWebhook(
      { action: 'ping', data: { webhookActionType: 'ping' } },
      { receipts },
    );
    expect(out).toEqual({ kind: 'ignored_action', httpStatus: 200, code: 'ping', enqueued: false });
    expect(receipts.receipts.size).toBe(0);
    expect(receipts.liveJobs.size).toBe(0);
  });

  it.each([
    { action: 'ping' },
    { action: 'ping', data: {} },
    { action: 'ping', data: { webhookActionType: 'not-ping' } },
  ])('rejects malformed ping lookalikes: %j', async (body) => {
    const receipts = new FakeOutbox();
    const out = await ingestWebhook(body, { receipts });
    expect(out).toMatchObject({ kind: 'unrecognized', httpStatus: 400 });
    expect(receipts.receipts.size).toBe(0);
  });

  it('records + acks a non-trigger action WITHOUT enqueuing', async () => {
    const receipts = new FakeOutbox();
    const out = await ingestWebhook({ action: 'applicationUpdate', id: 'e1', data: { application: { id: 'a' } } }, { receipts });
    expect(out).toMatchObject({ kind: 'ignored_action', httpStatus: 200 });
    expect(receipts.liveJobs.size).toBe(0);
    expect(receipts.receipts.size).toBe(1);
  });

  it('atomically records + enqueues a fresh stage change once; duplicate re-checks with no new work', async () => {
    const receipts = new FakeOutbox();
    const first = await ingestWebhook(STAGE_BODY, { receipts });
    expect(first).toMatchObject({ kind: 'accepted', httpStatus: 200, enqueued: true });
    expect(receipts.liveJobs.size).toBe(1);
    const dup = await ingestWebhook(STAGE_BODY, { receipts });
    expect(dup).toMatchObject({ kind: 'duplicate', httpStatus: 200, enqueued: false });
    expect(receipts.liveJobs.size).toBe(1); // still exactly one
  });

  it('F2 re-drive: a duplicate whose job was lost re-enqueues exactly once', async () => {
    const receipts = new FakeOutbox();
    await ingestWebhook(STAGE_BODY, { receipts });
    expect(receipts.liveJobs.size).toBe(1);
    // Simulate the job being lost (e.g. DLQ'd) while the receipt persists and is
    // NOT terminal — the redelivery must re-drive the enqueue.
    receipts.liveJobs.clear();
    const redriven = await ingestWebhook(STAGE_BODY, { receipts });
    expect(redriven).toMatchObject({ kind: 'duplicate', code: 'duplicate_redriven', enqueued: true });
    expect(receipts.liveJobs.size).toBe(1);
  });

  it('does NOT re-enqueue once the worker has reached a terminal decision', async () => {
    const receipts = new FakeOutbox();
    await ingestWebhook(STAGE_BODY, { receipts });
    receipts.liveJobs.clear();
    receipts.terminal.add('candidateStageChange:stage:a:s'); // worker finished
    const out = await ingestWebhook(STAGE_BODY, { receipts });
    expect(out).toMatchObject({ kind: 'duplicate', enqueued: false });
    expect(receipts.liveJobs.size).toBe(0); // no re-enqueue of completed work
  });

  it('returns retryable 500 when durable work cannot be established (workPending=false)', async () => {
    const receipts = new FakeOutbox();
    receipts.forceNoWork = true;
    const out = await ingestWebhook(STAGE_BODY, { receipts });
    expect(out).toMatchObject({ kind: 'durability_error', httpStatus: 500, code: 'enqueue_incomplete' });
  });

  it('returns durability_error 500 when the receipt store throws', async () => {
    const receipts = new FakeOutbox();
    receipts.throwOnRecord = true;
    const out = await ingestWebhook(STAGE_BODY, { receipts });
    expect(out).toMatchObject({ kind: 'durability_error', httpStatus: 500 });
  });
});

describe('config gating', () => {
  it('is disabled by default and requires enabled + a usable secret', () => {
    expect(isAshbyWebhookActive(loadAshbyConfig({}))).toBe(false);
    expect(isAshbyWebhookActive(loadAshbyConfig({ ASHBY_INTEGRATION_ENABLED: 'true' } as NodeJS.ProcessEnv))).toBe(false);
    expect(isAshbyWebhookActive(loadAshbyConfig({ ASHBY_INTEGRATION_ENABLED: 'true', ASHBY_WEBHOOK_SECRET: 'replace_me' } as NodeJS.ProcessEnv))).toBe(false);
    expect(isAshbyWebhookActive(loadAshbyConfig({ ASHBY_INTEGRATION_ENABLED: 'true', ASHBY_WEBHOOK_SECRET: 'short' } as NodeJS.ProcessEnv))).toBe(false);
    expect(isAshbyWebhookActive(loadAshbyConfig({ ASHBY_INTEGRATION_ENABLED: 'true', ASHBY_WEBHOOK_SECRET: 'a-sufficiently-long-secret' } as NodeJS.ProcessEnv))).toBe(true);
  });
  it('describeAshbyConfig exposes only booleans (never the secret)', () => {
    const d = describeAshbyConfig(loadAshbyConfig({ ASHBY_INTEGRATION_ENABLED: 'true', ASHBY_WEBHOOK_SECRET: 'a-sufficiently-long-secret' } as NodeJS.ProcessEnv));
    expect(d).toEqual({ enabled: true, webhookSecretConfigured: true, active: true });
    expect(JSON.stringify(d)).not.toContain('secret');
  });
});
