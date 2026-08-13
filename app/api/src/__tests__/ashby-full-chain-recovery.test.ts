/**
 * Ashby full-chain recovery regression (PR C restack, integrating PR B's F1/F2
 * transactional-outbox repair).
 *
 * Proves the co-primary "no lost candidates / reconciliation recovers dropped
 * webhooks" guarantee END-TO-END across the repaired webhook + reconciliation
 * outbox (PR B) and PR C's import/orchestration: a dropped-then-recovered signal
 * AND an enqueue-failed-then-redelivered signal each reach **exactly one**
 * import / workflow link / seeded ingestion / invite set — NOT merely a receipt.
 *
 * A faithful in-memory model of the 0030 transactional outbox (`record` inserts
 * receipt + signal job in one unit, re-drives a missing enqueue on a duplicate,
 * reports `workPending`) is composed with `ingestWebhook`, `runReconciliation`,
 * the `processAshbySignal` worker decision, and C's `runImport`. No real
 * network/DB/provider.
 */

import { describe, it, expect } from 'vitest';
import { ingestWebhook } from '../integrations/ashby/ingress.js';
import { runReconciliation } from '../integrations/ashby/reconciliation.js';
import { processAshbySignal, buildSignalEnqueueSpec, signalDedupKey } from '../integrations/ashby/signal-worker.js';
import { CANDIDATE_STAGE_CHANGE_ACTION, stageDedupId } from '../integrations/ashby/extractors.js';
import { runImport, type WorkflowStores, type ExistingLinkRow, type EnqueueResult, type ResolvedMapping } from '../integrations/ashby/orchestration.js';
import type { ReceiptStore, AshbySignalPayload } from '../integrations/ashby/ports.js';
import type { AshbyResult } from '../integrations/ashby/types.js';

const AI = 'stage_ai';
const APP = 'app_1';
const JOB = 'job_1';
const appObj = { id: APP, job: { id: JOB }, currentInterviewStage: { id: AI } };
const appInfo = { application: appObj };

/** In-memory model of the 0030 transactional outbox (receipt + signal job). */
class Outbox implements ReceiptStore {
  receipts = new Map<string, { id: string; status: string }>();
  jobs = new Map<string, AshbySignalPayload>();
  /** Number of upcoming enqueue writes to fail atomically (whole tx rolls back). */
  failEnqueueTimes = 0;
  enqueuedTotal = 0;
  private n = 0;
  private key(action: string, wid: string) { return `${action}:${wid}`; }
  private terminal(status: string) { return status === 'processed' || status === 'ignored' || status === 'failed'; }

  async record(input: { webhookActionId: string; action: string; metadata?: unknown; enqueue?: { dedupKey: string; payload: AshbySignalPayload } }) {
    // Atomic: an enqueue-write failure rolls back the receipt too (nothing persists).
    if (input.enqueue && this.failEnqueueTimes > 0) {
      this.failEnqueueTimes -= 1;
      throw new Error('outbox_tx_failed');
    }
    const k = this.key(input.action, input.webhookActionId);
    const existing = this.receipts.get(k);
    let status: 'inserted' | 'duplicate';
    let id: string;
    if (!existing) {
      id = `rcpt_${++this.n}`;
      this.receipts.set(k, { id, status: 'received' });
      status = 'inserted';
    } else {
      id = existing.id;
      status = 'duplicate';
    }
    let enqueued = false;
    if (input.enqueue) {
      const rec = this.receipts.get(k)!;
      const hasLiveJob = this.jobs.has(input.enqueue.dedupKey);
      if (!hasLiveJob && !this.terminal(rec.status)) {
        this.jobs.set(input.enqueue.dedupKey, input.enqueue.payload);
        enqueued = true;
        this.enqueuedTotal += 1;
      }
    }
    const rec = this.receipts.get(k)!;
    const workPending = input.enqueue ? (this.jobs.has(input.enqueue.dedupKey) || this.terminal(rec.status)) : true;
    return { status, id, enqueued, workPending };
  }

  async markStatus(input: { webhookActionId: string; action: string; status: 'processing' | 'processed' | 'failed' | 'ignored' }) {
    const rec = this.receipts.get(this.key(input.action, input.webhookActionId));
    if (rec) rec.status = input.status;
  }

  /** Simulate a worker crash: the claimed job vanishes but the receipt is NOT terminal. */
  loseJob(dedupKey: string) { this.jobs.delete(dedupKey); }
}

/** In-memory C workflow store — dedups links by external application id. */
class WStore implements WorkflowStores {
  links = new Map<string, ExistingLinkRow>();
  ingestionSeeds = 0;
  inviteOps = 0;
  private n = 0;
  async findLinkByApplicationId(appId: string) { return this.links.get(appId) ?? null; }
  async createLink(input: { externalApplicationId: string }) {
    const id = `link_${++this.n}`;
    this.links.set(input.externalApplicationId, { id, externalApplicationId: input.externalApplicationId, terminalState: null });
    return { id };
  }
  async advanceIngestion(_l: string, s: string) { if (s === 'queued') this.ingestionSeeds += 1; return { status: 'ok', state: s }; }
  async enqueueOperation(input: { operationType: string }): Promise<EnqueueResult> { if (input.operationType === 'invite_delivery') this.inviteOps += 1; return { status: 'inserted', id: `op_${++this.n}` }; }
  async completeOperation() { return 'ok' as const; }
  async failOperation() { return { outcome: 'retry' as const }; }
}

const reader = { applicationInfo: (async () => ({ results: appInfo, moreDataAvailable: false })) as <T>(id: string) => Promise<AshbyResult<T>> };
const mapping: ResolvedMapping = { id: 'map_1', status: 'enabled', aiScreeningStageId: AI, deliveryMode: 'both' };
const signalDeps = (outbox: Outbox) => ({
  client: reader,
  mappings: { resolveByJobId: async () => ({ status: 'enabled' as const, aiScreeningStageId: AI }) },
  receipts: outbox,
});
const importDeps = (store: WStore) => ({
  gates: { enabled: true, email: { providerApproved: false, domainVerified: false } },
  client: reader,
  stores: store,
  resolveMapping: async () => mapping,
});

/** Drain every live signal job through the worker + C import (claim → decide → import). */
async function drainSignals(outbox: Outbox, store: WStore): Promise<number> {
  let imports = 0;
  for (const [dedupKey, payload] of [...outbox.jobs.entries()]) {
    const decision = await processAshbySignal(payload, signalDeps(outbox)); // worker marks the receipt terminal
    outbox.jobs.delete(dedupKey); // job consumed
    if (decision.decision === 'import_eligible') {
      await runImport(payload.externalApplicationId as string, importDeps(store));
      imports += 1;
    }
  }
  return imports;
}

function assertExactlyOne(store: WStore) {
  expect(store.links.size).toBe(1); // exactly one workflow/import identity
  expect(store.ingestionSeeds).toBe(1); // ingestion seeded once
  expect(store.inviteOps).toBe(2); // both channels, once (not doubled)
}

describe('reconciliation dropped-webhook recovery → exactly one import', () => {
  it('recovers a dropped webhook INTO PROCESSING (enqueues), and a later real webhook converges to one import', async () => {
    const outbox = new Outbox();
    const store = new WStore();

    // Webhook was dropped: no receipt, no job. Reconciliation observes the app.
    const recon = await runReconciliation({
      client: { applicationList: (async () => ({ results: [appObj], moreDataAvailable: false })) as never },
      checkpoints: { get: async () => null, advance: async () => {}, requireFullResync: async () => {} },
      receipts: outbox,
    });
    expect(recon.recovered).toBe(1);
    expect(recon.enqueued).toBe(1); // recovery reached PROCESSING, not receipt-only

    expect(await drainSignals(outbox, store)).toBe(1); // one import
    assertExactlyOne(store);

    // The real webhook finally arrives for the same application-at-stage.
    const dedupId = stageDedupId(APP, AI);
    const wh = await ingestWebhook(
      { action: CANDIDATE_STAGE_CHANGE_ACTION, data: { application: { id: APP, currentInterviewStage: { id: AI }, job: { id: JOB } } } },
      { receipts: outbox },
    );
    expect(wh.httpStatus).toBe(200);
    expect(wh.enqueued).toBe(false); // terminal receipt → no re-enqueue
    expect(signalDedupKey(CANDIDATE_STAGE_CHANGE_ACTION, dedupId)).toBeTruthy();

    expect(await drainSignals(outbox, store)).toBe(0); // no second import
    assertExactlyOne(store); // still exactly one
  });
});

describe('webhook enqueue-failure/redelivery → exactly one import', () => {
  it('a failed atomic outbox write yields a retryable 500; redelivery imports exactly once', async () => {
    const outbox = new Outbox();
    const store = new WStore();
    outbox.failEnqueueTimes = 1; // first stage-change record throws (tx rolls back)

    const parsed = { action: CANDIDATE_STAGE_CHANGE_ACTION, data: { application: { id: APP, currentInterviewStage: { id: AI }, job: { id: JOB } } } };

    const first = await ingestWebhook(parsed, { receipts: outbox });
    expect(first.httpStatus).toBe(500); // durability failure → Ashby retries
    expect(outbox.receipts.size).toBe(0); // nothing persisted (atomic)

    const redelivery = await ingestWebhook(parsed, { receipts: outbox });
    expect(redelivery.httpStatus).toBe(200);
    expect(redelivery.enqueued).toBe(true);

    expect(await drainSignals(outbox, store)).toBe(1);
    assertExactlyOne(store);

    // A further Ashby retry after processing must not create a second import.
    const retry = await ingestWebhook(parsed, { receipts: outbox });
    expect(retry.httpStatus).toBe(200);
    expect(retry.enqueued).toBe(false);
    expect(await drainSignals(outbox, store)).toBe(0);
    assertExactlyOne(store);
  });

  it('a lost signal job (worker crash) is re-driven by redelivery to exactly one import', async () => {
    const outbox = new Outbox();
    const store = new WStore();
    const parsed = { action: CANDIDATE_STAGE_CHANGE_ACTION, data: { application: { id: APP, currentInterviewStage: { id: AI }, job: { id: JOB } } } };

    const first = await ingestWebhook(parsed, { receipts: outbox });
    expect(first.httpStatus).toBe(200);
    expect(first.enqueued).toBe(true);

    // Worker crashes: the claimed job vanishes, but the receipt is NOT terminal.
    const dedup = signalDedupKey(CANDIDATE_STAGE_CHANGE_ACTION, stageDedupId(APP, AI));
    outbox.loseJob(dedup);
    expect(outbox.jobs.size).toBe(0);

    // Redelivery re-drives the missing enqueue (duplicate receipt, not terminal).
    const redelivery = await ingestWebhook(parsed, { receipts: outbox });
    expect(redelivery.httpStatus).toBe(200);
    expect(redelivery.enqueued).toBe(true); // re-driven
    expect(redelivery.code).toBe('duplicate_redriven');

    expect(await drainSignals(outbox, store)).toBe(1);
    assertExactlyOne(store);
    expect(outbox.enqueuedTotal).toBe(2); // original + one re-drive, never more
  });
});
