/**
 * Ashby signal worker — TERMINAL vs CONDITIONAL verdicts (review finding B2).
 *
 * `record_ashby_event_receipt` treats a `processed | ignored | failed` receipt
 * as "durable work is done" and refuses to re-drive. The receipt identity is
 * stage-centric (`stage:<application>:<stage>`), so a terminal status
 * permanently poisons that exact application-at-stage: no future signal for it
 * can ever be enqueued again.
 *
 * That is correct only where the "no" is PERMANENT. It was being applied to two
 * verdicts a human can reverse tomorrow — `mapping_inactive` (enable the
 * mapping) and `stage_not_ai` (move the candidate into the AI stage) — which is
 * what made "enable a mapping after the runtime has run" silently and
 * permanently blind: no error, no DLQ, no failed operation, just candidates
 * that are never screened.
 */

import { describe, it, expect } from 'vitest';
import {
  processAshbySignal,
  CANDIDATE_DELETE_ACTION,
  type SignalWorkerDeps,
} from '../integrations/ashby/signal-worker.js';
import { runReconciliation, type ApplicationLister } from '../integrations/ashby/reconciliation.js';
import { stageDedupId, CANDIDATE_STAGE_CHANGE_ACTION } from '../integrations/ashby/extractors.js';
import type {
  ReceiptStore, ReceiptOutcome, AshbySignalPayload,
  EnabledMappingLoader, EnabledMappingRow, CheckpointStore, SyncCheckpoint,
} from '../integrations/ashby/ports.js';
import type { AshbyResult, OpaqueRecord } from '../integrations/ashby/types.js';

const APP = 'app_1';
const JOB = 'job_1';
const AI = 'stage_ai';

/** Receipt store mirroring the 0030 RPC's terminal short-circuit exactly. */
class Outbox implements ReceiptStore {
  rows = new Map<string, { status: string }>();
  liveJobs = new Set<string>();
  enqueues = 0;
  async record(input: {
    webhookActionId: string;
    action: string;
    enqueue?: { dedupKey: string };
  }): Promise<ReceiptOutcome> {
    const key = `${input.action}:${input.webhookActionId}`;
    const existing = this.rows.get(key);
    const fresh = !existing;
    if (fresh) this.rows.set(key, { status: 'received' });
    const status = this.rows.get(key)!.status;

    let enqueued = false;
    let workPending = false;
    if (input.enqueue) {
      if (status === 'processed' || status === 'ignored' || status === 'failed') {
        // The 0030 short-circuit: terminal ⇒ "durable work is done", no re-drive.
        workPending = true;
      } else if (this.liveJobs.has(input.enqueue.dedupKey)) {
        workPending = true;
      } else {
        this.liveJobs.add(input.enqueue.dedupKey);
        this.enqueues += 1;
        enqueued = true;
        workPending = true;
      }
    }
    return { status: fresh ? 'inserted' : 'duplicate', id: key, enqueued, workPending };
  }
  async markStatus(input: { webhookActionId: string; action: string; status: string }): Promise<void> {
    const key = `${input.action}:${input.webhookActionId}`;
    const row = this.rows.get(key);
    if (row) row.status = input.status;
  }
  statusOf(webhookActionId: string, action = CANDIDATE_STAGE_CHANGE_ACTION): string | undefined {
    return this.rows.get(`${action}:${webhookActionId}`)?.status;
  }
  /** Simulate the worker completing the job (the queue row is gone). */
  drain(): void { this.liveJobs.clear(); }
}

function payload(over: Partial<AshbySignalPayload> = {}): AshbySignalPayload {
  return {
    provider: 'ashby',
    action: CANDIDATE_STAGE_CHANGE_ACTION,
    webhookActionId: stageDedupId(APP, AI),
    externalApplicationId: APP,
    ...over,
  };
}

/** `null` omits the field entirely (passing `undefined` would hit the default). */
function infoReturning(stageId: string | null, jobId: string | null = JOB) {
  const application: Record<string, unknown> = { id: APP };
  if (jobId !== null) application.job = { id: jobId };
  if (stageId !== null) application.currentInterviewStage = { id: stageId };
  return { applicationInfo: async () => ({ results: { application } }) as never };
}

function deps(over: Partial<SignalWorkerDeps> & { receipts: Outbox }): SignalWorkerDeps {
  return {
    client: infoReturning(AI),
    mappings: { resolveByJobId: async () => ({ status: 'enabled', aiScreeningStageId: AI }) },
    ...over,
  };
}

// ── Conditional verdicts must NOT terminalise ───────────────────────────────

describe('conditional verdicts leave the receipt non-terminal', () => {
  it('mapping_inactive (paused mapping) leaves the receipt at received', async () => {
    const receipts = new Outbox();
    await receipts.record({ webhookActionId: stageDedupId(APP, AI), action: CANDIDATE_STAGE_CHANGE_ACTION });
    const r = await processAshbySignal(payload(), deps({
      receipts,
      mappings: { resolveByJobId: async () => ({ status: 'paused', aiScreeningStageId: AI }) },
    }));
    expect(r.decision).toBe('mapping_inactive');
    expect(receipts.statusOf(stageDedupId(APP, AI))).toBe('received');
  });

  it('mapping_inactive (unresolvable job) leaves the receipt at received', async () => {
    const receipts = new Outbox();
    await receipts.record({ webhookActionId: stageDedupId(APP, AI), action: CANDIDATE_STAGE_CHANGE_ACTION });
    const r = await processAshbySignal(payload(), deps({ receipts, client: infoReturning(AI, null) }));
    expect(r.decision).toBe('mapping_inactive');
    expect(receipts.statusOf(stageDedupId(APP, AI))).toBe('received');
  });

  it('stage_not_ai leaves the receipt at received', async () => {
    const receipts = new Outbox();
    await receipts.record({ webhookActionId: stageDedupId(APP, AI), action: CANDIDATE_STAGE_CHANGE_ACTION });
    const r = await processAshbySignal(payload(), deps({ receipts, client: infoReturning('stage_human') }));
    expect(r.decision).toBe('stage_not_ai');
    expect(receipts.statusOf(stageDedupId(APP, AI))).toBe('received');
  });
});

// ── Permanent verdicts must STILL terminalise ───────────────────────────────

describe('permanent verdicts still terminalise', () => {
  it('ignored_action → ignored', async () => {
    const receipts = new Outbox();
    const p = payload({ action: 'applicationUpdate', webhookActionId: 'other_1' });
    await receipts.record({ webhookActionId: 'other_1', action: 'applicationUpdate' });
    const r = await processAshbySignal(p, deps({ receipts }));
    expect(r.decision).toBe('ignored_action');
    expect(receipts.statusOf('other_1', 'applicationUpdate')).toBe('ignored');
  });

  it('capability_disabled → ignored', async () => {
    const receipts = new Outbox();
    const p = payload({ action: CANDIDATE_DELETE_ACTION, webhookActionId: 'del_1' });
    await receipts.record({ webhookActionId: 'del_1', action: CANDIDATE_DELETE_ACTION });
    const r = await processAshbySignal(p, deps({ receipts }));
    expect(r.decision).toBe('capability_disabled');
    expect(receipts.statusOf('del_1', CANDIDATE_DELETE_ACTION)).toBe('ignored');
  });

  it('self_echo → ignored', async () => {
    const receipts = new Outbox();
    await receipts.record({ webhookActionId: stageDedupId(APP, AI), action: CANDIDATE_STAGE_CHANGE_ACTION });
    const r = await processAshbySignal(payload(), deps({ receipts, isSelfEcho: () => true }));
    expect(r.decision).toBe('self_echo');
    expect(receipts.statusOf(stageDedupId(APP, AI))).toBe('ignored');
  });

  it('import_eligible → processed', async () => {
    const receipts = new Outbox();
    await receipts.record({ webhookActionId: stageDedupId(APP, AI), action: CANDIDATE_STAGE_CHANGE_ACTION });
    const r = await processAshbySignal(payload(), deps({ receipts }));
    expect(r.decision).toBe('import_eligible');
    expect(receipts.statusOf(stageDedupId(APP, AI))).toBe('processed');
  });
});

// ── The B2 end-to-end regression ────────────────────────────────────────────

class Checkpoints implements CheckpointStore {
  current: SyncCheckpoint | null = null;
  async get(): Promise<SyncCheckpoint | null> { return this.current; }
  async advance(input: { syncToken: string | null }): Promise<void> {
    this.current = {
      syncToken: input.syncToken, status: 'idle',
      tokenIssuedAt: new Date().toISOString(), lastSuccessAt: new Date().toISOString(),
      resyncEpoch: this.current?.resyncEpoch ?? 0,
    };
  }
  /** What migration 0033 now does in the same transaction as enabling. */
  async requireFullResync(_key: string, reason: string): Promise<void> {
    this.current = {
      syncToken: null, status: 'full_resync_required', tokenIssuedAt: null,
      lastSuccessAt: this.current?.lastSuccessAt ?? null,
      resyncEpoch: (this.current?.resyncEpoch ?? 0) + 1,
    };
    this.lastReason = reason;
  }
  lastReason: string | null = null;
}

function mappingLoader(rows: EnabledMappingRow[]): EnabledMappingLoader {
  return { async listEnabled() { return { rows, truncated: false }; } };
}

function listOf(items: OpaqueRecord[]): ApplicationLister {
  return {
    async applicationList<T = OpaqueRecord[]>(): Promise<AshbyResult<T>> {
      return { results: items as unknown as T, moreDataAvailable: false, syncToken: 'tok' };
    },
  };
}

describe('B2 regression: enable-after-storm recovers the parked candidate', () => {
  it('paused → observed → enabled → forced resync → EXACTLY ONE import', async () => {
    const receipts = new Outbox();
    const checkpoints = new Checkpoints();
    const corpus = [{ application: { id: APP, job: { id: JOB }, currentInterviewStage: { id: AI } } }];
    let enabled: EnabledMappingRow[] = [];
    let mappingStatus: 'paused' | 'enabled' = 'paused';

    const reconcile = () => runReconciliation({
      client: listOf(corpus),
      checkpoints,
      receipts,
      mappings: mappingLoader(enabled),
    });

    // Drain whatever reconciliation queued, through the real worker decision.
    const drainSignals = async (): Promise<string[]> => {
      const decisions: string[] = [];
      for (const key of [...receipts.liveJobs]) {
        void key;
        const r = await processAshbySignal(payload(), {
          client: infoReturning(AI),
          mappings: {
            async resolveByJobId() {
              return { status: mappingStatus, aiScreeningStageId: AI };
            },
          },
          receipts,
        });
        decisions.push(r.decision);
      }
      receipts.drain();   // the worker completed the queue jobs
      return decisions;
    };

    // ── 1. Runtime runs with the mapping PAUSED.
    const first = await reconcile();
    expect(first.admitted).toBe(0);
    expect(receipts.enqueues).toBe(0);   // the storm cannot happen at all now
    expect(receipts.rows.size).toBe(0);
    expect(await drainSignals()).toEqual([]);

    // ── 2. The recruiter enables the mapping. Migration 0033 forces the
    //       full resync in the same transaction as the status flip.
    enabled = [{ externalJobId: JOB, aiScreeningStageId: AI }];
    mappingStatus = 'enabled';
    await checkpoints.requireFullResync('application.list', 'mapping_enabled');
    expect(checkpoints.current?.status).toBe('full_resync_required');

    // ── 3. The next pass is a FULL sweep and admits the parked application.
    const second = await reconcile();
    expect(second.mode).toBe('full');
    expect(second.admitted).toBe(1);
    expect(receipts.enqueues).toBe(1);

    // ── 4. The worker imports it — exactly once.
    expect(await drainSignals()).toEqual(['import_eligible']);
    expect(receipts.statusOf(stageDedupId(APP, AI))).toBe('processed');

    // ── 5. A further pass creates no duplicate work.
    const third = await reconcile();
    expect(third.admitted).toBe(1);
    expect(receipts.enqueues).toBe(1);   // terminal `processed` ⇒ no re-drive
  });

  it('a race-losing pass stays recoverable: pause mid-flight, then re-enable', async () => {
    const receipts = new Outbox();
    const checkpoints = new Checkpoints();
    const corpus = [{ application: { id: APP, job: { id: JOB }, currentInterviewStage: { id: AI } } }];
    const enabled = [{ externalJobId: JOB, aiScreeningStageId: AI }];

    // Admitted while enabled…
    const r1 = await runReconciliation({
      client: listOf(corpus), checkpoints, receipts, mappings: mappingLoader(enabled),
    });
    expect(r1.admitted).toBe(1);
    expect(receipts.enqueues).toBe(1);

    // …but the mapping is paused before the worker gets to it.
    const decision = await processAshbySignal(payload(), {
      client: infoReturning(AI),
      mappings: { resolveByJobId: async () => ({ status: 'paused', aiScreeningStageId: AI }) },
      receipts,
    });
    expect(decision.decision).toBe('mapping_inactive');
    receipts.drain();
    // The load-bearing assertion: NOT terminal, so the application is not lost.
    expect(receipts.statusOf(stageDedupId(APP, AI))).toBe('received');

    // Re-enabled → forced resync → the same application is re-driven and imported.
    await checkpoints.requireFullResync('application.list', 'mapping_enabled');
    const r2 = await runReconciliation({
      client: listOf(corpus), checkpoints, receipts, mappings: mappingLoader(enabled),
    });
    expect(r2.admitted).toBe(1);
    expect(receipts.enqueues).toBe(2);   // re-driven, because the receipt stayed open

    const final = await processAshbySignal(payload(), {
      client: infoReturning(AI),
      mappings: { resolveByJobId: async () => ({ status: 'enabled', aiScreeningStageId: AI }) },
      receipts,
    });
    expect(final.decision).toBe('import_eligible');
    expect(receipts.statusOf(stageDedupId(APP, AI))).toBe('processed');
  });
});
