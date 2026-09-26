import { describe, expect, it, vi } from 'vitest';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';
import {
  admitStageAfterActivation,
  runReconciliation,
  historyAdmitter,
  type ApplicationHistoryLister,
} from '../integrations/ashby/reconciliation.js';
import { processAshbySignal } from '../integrations/ashby/signal-worker.js';
import { runImport } from '../integrations/ashby/orchestration.js';
import { CANDIDATE_STAGE_CHANGE_ACTION } from '../integrations/ashby/extractors.js';
import type { AshbyResult, OpaqueRecord } from '../integrations/ashby/types.js';
import type { CheckpointStore, EnabledMappingLoader, ReceiptOutcome, ReceiptStore, SyncCheckpoint } from '../integrations/ashby/ports.js';

const APP = 'app_A';
const JOB = 'job_A';
const STAGE = 'stage_ai';
const ACTIVATED = '2026-09-25T00:00:00.000Z';
// THE CLOCK IS PINNED. `admitStageAfterActivation` compares `enteredStageAt`
// against `nowMs()` (default `Date.now`) and rejects a future entry, so a
// fixture dated "tomorrow" stops being in the future tomorrow: this file's
// future-entry assertion was written on 2026-09-26 with `2026-09-27` and would
// have gone red at 00:00Z on the 27th, on main, with no code change. Every
// direct call below therefore passes this clock; the dates above and below are
// read relative to it, not to the wall.
const NOW_MS = Date.parse('2026-09-26T12:00:00.000Z');
const CLOCK = () => NOW_MS;

function history(rows: OpaqueRecord[], moreDataAvailable = false, nextCursor?: string): ApplicationHistoryLister {
  return { applicationListHistory: (async <T = OpaqueRecord[]>(_params: { applicationId: string; cursor?: string; limit?: number }) => ({ results: rows as unknown as T, moreDataAvailable, nextCursor }) as AshbyResult<T>) };
}

describe('Ashby timestamp admission', () => {
  it('admits only the active mapped stage entry at/after activation', async () => {
    const old = await admitStageAfterActivation(history([
      { stageId: STAGE, enteredStageAt: '2026-09-24T23:59:59Z', leftStageAt: null },
    ]), { applicationId: APP, stageId: STAGE, activationAt: ACTIVATED, nowMs: CLOCK });
    expect(old).toBe('not_after_activation');

    const fresh = await admitStageAfterActivation(history([
      { stageId: 'stage_other', enteredStageAt: '2026-09-24T00:00:00Z', leftStageAt: '2026-09-25T01:00:00Z' },
      { stageId: STAGE, enteredStageAt: '2026-09-25T01:00:00Z', leftStageAt: null },
    ]), { applicationId: APP, stageId: STAGE, activationAt: ACTIVATED, nowMs: CLOCK });
    expect(fresh).toBe('admit');
  });

  it('paginates and treats provider failure or malformed time as retryable', async () => {
    const reader: ApplicationHistoryLister = {
      applicationListHistory: vi.fn()
        .mockResolvedValueOnce({ results: [{ stageId: 'stage_other', enteredStageAt: '2026-09-24T00:00:00Z', leftStageAt: '2026-09-24T01:00:00Z' }], moreDataAvailable: true, nextCursor: 'next' })
        .mockResolvedValueOnce({ results: [{ stageId: STAGE, enteredStageAt: '2026-09-25T00:01:00Z', leftStageAt: null }], moreDataAvailable: false }),
    };
    await expect(admitStageAfterActivation(reader, { applicationId: APP, stageId: STAGE, activationAt: ACTIVATED, nowMs: CLOCK })).resolves.toBe('admit');
    await expect(admitStageAfterActivation(history([{ stageId: STAGE, enteredStageAt: 'not-a-time', leftStageAt: null }]), { applicationId: APP, stageId: STAGE, activationAt: ACTIVATED, nowMs: CLOCK })).rejects.toThrow('entry_time_invalid');
    await expect(admitStageAfterActivation({ applicationListHistory: async () => { throw new Error('provider_down'); } }, { applicationId: APP, stageId: STAGE, activationAt: ACTIVATED, nowMs: CLOCK })).rejects.toThrow('provider_down');
  });
});

class Checkpoints implements CheckpointStore {
  async get(): Promise<SyncCheckpoint | null> { return null; }
  async advance(): Promise<void> {}
  async requireFullResync(): Promise<void> {}
}

class Receipts implements ReceiptStore {
  writes = 0;
  async record(): Promise<ReceiptOutcome> {
    this.writes += 1;
    return { status: 'inserted', id: 'receipt', enqueued: true, workPending: true };
  }
}

it('reconciliation creates zero work for a pre-enable sitter and processes a post-enable entry', async () => {
  const receipts = new Receipts();
  const mappings: EnabledMappingLoader = {
    async listEnabled() {
      return { truncated: false, rows: [{ externalJobId: JOB, aiScreeningStageId: STAGE, activationAt: ACTIVATED, activationEpoch: 2, configVersion: 4 }] };
    },
  };
  const rows = [{ application: { id: APP, job: { id: JOB }, currentInterviewStage: { id: STAGE } } }];
  const client = {
    applicationList: async <T = OpaqueRecord[]>() => ({ results: rows as unknown as T, moreDataAvailable: false }) as AshbyResult<T>,
    applicationListHistory: async <T = OpaqueRecord[]>() => ({ results: [{ stageId: STAGE, enteredStageAt: '2026-09-24T23:59:59Z', leftStageAt: null }] as unknown as T, moreDataAvailable: false }) as AshbyResult<T>,
  };
  const old = await runReconciliation({ client, admitByHistory: historyAdmitter(client), mappings, checkpoints: new Checkpoints(), receipts });
  expect(old.admitted).toBe(0);
  expect(receipts.writes).toBe(0);

  client.applicationListHistory = async <T = OpaqueRecord[]>() => ({ results: [{ stageId: STAGE, enteredStageAt: '2026-09-26T00:00:01Z', leftStageAt: null }] as unknown as T, moreDataAvailable: false }) as AshbyResult<T>;
  const fresh = await runReconciliation({ client, admitByHistory: historyAdmitter(client), mappings, checkpoints: new Checkpoints(), receipts });
  expect(fresh.admitted).toBe(1);
  expect(receipts.writes).toBe(1);
});

function signalDeps(over: { applicationId?: string; authorized?: boolean; enteredStageAt?: string } = {}) {
  const applicationId = over.applicationId ?? APP;
  return {
    client: { applicationInfo: async <T = OpaqueRecord>() => ({ results: { id: applicationId, job: { id: JOB }, currentInterviewStage: { id: STAGE } } as unknown as T, moreDataAvailable: false }) as AshbyResult<T> },
    mappings: { resolveByJobId: async () => ({ status: 'enabled' as const, aiScreeningStageId: STAGE, activationAt: ACTIVATED, activationEpoch: 2, configVersion: 4 }) },
    enforceActivationFence: true,
    history: history([{ stageId: STAGE, enteredStageAt: over.enteredStageAt ?? '2026-09-26T00:00:00Z', leftStageAt: null }]),
    isExplicitImportAuthorized: async ({ applicationId: id }: { applicationId: string }) => over.authorized === true && id === applicationId,
    onImportEligible: vi.fn(async () => {}),
  };
}

it('fences stale signal jobs and cannot authorize application B with application A snapshot', async () => {
  const stale = await processAshbySignal({ provider: 'ashby', action: CANDIDATE_STAGE_CHANGE_ACTION, webhookActionId: 'stage:app_A:stage_ai', externalApplicationId: APP }, signalDeps({ enteredStageAt: '2026-09-24T00:00:00Z' }), { createdAt: '2026-09-26T00:00:00Z' });
  expect(stale.decision).toBe('mapping_inactive');
  const fresh = await processAshbySignal({ provider: 'ashby', action: CANDIDATE_STAGE_CHANGE_ACTION, webhookActionId: 'stage:app_A:stage_ai', externalApplicationId: APP }, signalDeps(), { createdAt: '2026-09-26T00:00:00Z' });
  expect(fresh.decision).toBe('import_eligible');
  const wrongSnapshot = await processAshbySignal({ provider: 'ashby', action: CANDIDATE_STAGE_CHANGE_ACTION, webhookActionId: 'stage:app_B:stage_ai', externalApplicationId: 'app_B', source: 'explicit_backlog', explicitImportRunId: 'run_A' }, signalDeps({ applicationId: 'app_B', authorized: false, enteredStageAt: '2026-09-24T00:00:00Z' }), { createdAt: '2026-09-24T00:00:00Z' });
  expect(wrongSnapshot.decision).toBe('mapping_inactive');
});

it('fences an already queued import before materialization and permits a confirmed snapshot after epoch', async () => {
  const calls: string[] = [];
  const stores = {
    findLinkByApplicationId: async () => null,
    createLink: async () => { calls.push('link'); return { id: 'link_A' }; },
    advanceIngestion: async () => { calls.push('ingestion'); return { status: 'ok' }; },
    enqueueOperation: async () => { calls.push('invite'); return { status: 'inserted', id: 'op_A' }; },
  };
  const client = {
    applicationInfo: async <T = OpaqueRecord>() => ({ results: { id: APP, job: { id: JOB }, currentInterviewStage: { id: STAGE } } as unknown as T, moreDataAvailable: false }) as AshbyResult<T>,
  };
  const mapping = { id: 'map_A', status: 'enabled' as const, aiScreeningStageId: STAGE, activationAt: ACTIVATED, activationEpoch: 3, configVersion: 9, deliveryMode: 'manual' as const };
  const denied = await runImport(APP, {
    gates: { enabled: true, email: { providerApproved: false, domainVerified: false } }, client, stores: stores as never,
    resolveMapping: async () => mapping, admitIntake: async () => false,
    materializeShell: async () => { calls.push('materialize'); return { status: 'created', candidateId: 'cand_A' }; },
  });
  expect(denied.status).toBe('skipped');
  expect(calls).toEqual([]);

  const confirmed = await runImport(APP, {
    gates: { enabled: true, email: { providerApproved: false, domainVerified: false } }, client, stores: stores as never,
    resolveMapping: async () => mapping, admitIntake: async () => true,
    materializeShell: async () => { calls.push('materialize'); return { status: 'created', candidateId: 'cand_A' }; },
  });
  expect(confirmed.status).toBe('imported');
  expect(calls).toEqual(['link', 'ingestion', 'materialize', 'invite']);
});

// ── THE FENCE MUST NOT BE ABLE TO TAKE THE TENANT DOWN WITH IT ──────
// The history call used to sit inline in the page loop with no try/catch, so
// ONE application the provider could not answer for — a 5xx, a rate limit, or
// a permanently ambiguous history because the candidate moved between the list
// read and the history read — propagated out of `runReconciliation`, failed
// the tick, and left the cursor unadvanced. The next tick replayed the same
// page and hit the same row. One candidate could stop the whole tenant's
// dropped-webhook safety net, indefinitely.
it('skips the application the fence cannot answer for, and keeps sweeping', async () => {
  const receipts = new Receipts();
  const rows = [
    { application: { id: 'app_poison', job: { id: JOB }, currentInterviewStage: { id: STAGE } } },
    { application: { id: 'app_good', job: { id: JOB }, currentInterviewStage: { id: STAGE } } },
  ];
  const client = {
    applicationList: async <T = OpaqueRecord[]>() => ({ results: rows as unknown as T, moreDataAvailable: false }) as AshbyResult<T>,
  };
  const mappings: EnabledMappingLoader = {
    async listEnabled() {
      return { truncated: false, rows: [{ externalJobId: JOB, aiScreeningStageId: STAGE, activationAt: ACTIVATED, activationEpoch: 2, configVersion: 4 }] };
    },
  };

  const res = await runReconciliation({
    client,
    mappings,
    checkpoints: new Checkpoints(),
    receipts,
    admitByHistory: async ({ applicationId }) => {
      if (applicationId === 'app_poison') throw new Error('ashby_history_ambiguous');
      return 'admit';
    },
  });

  // The run COMPLETED, the unanswerable row is counted and NOT admitted, and
  // the good one still produced exactly its own work.
  expect(res.admitted).toBe(1);
  expect(res.skipped.historyUnavailable).toBe(1);
  expect(receipts.writes).toBe(1);
});

// ── A TRANSIENT FENCE FAILURE MUST NOT SKIP ANYONE ──────────────────
// The first cut of this repair caught every fence error and carried on. That
// looks safe — nobody is dialled — but `pageHandled` is what makes a page
// ANCHORABLE, so a provider 5xx advanced the cursor past an application whose
// webhook may have been dropped. Reconciliation is the ONLY mechanism that
// recovers a dropped webhook, so "skipped once, never reconsidered" is silent
// permanent loss. A retryable failure must leave the page unanchored.
class RecordingCheckpoints implements CheckpointStore {
  advances = 0;
  async get(): Promise<SyncCheckpoint | null> { return null; }
  async advance(): Promise<void> { this.advances += 1; }
  async requireFullResync(): Promise<void> {}
}

it('a RETRYABLE fence failure stops the run and advances nothing', async () => {
  const receipts = new Receipts();
  const checkpoints = new RecordingCheckpoints();
  const rows = [
    { application: { id: 'app_a', job: { id: JOB }, currentInterviewStage: { id: STAGE } } },
  ];
  const client = {
    applicationList: async <T = OpaqueRecord[]>() => ({
      results: rows as unknown as T, moreDataAvailable: false, syncToken: 'tok',
    }) as AshbyResult<T>,
  };
  const mappings: EnabledMappingLoader = {
    async listEnabled() {
      return { truncated: false, rows: [{ externalJobId: JOB, aiScreeningStageId: STAGE, activationAt: ACTIVATED, activationEpoch: 2, configVersion: 4 }] };
    },
  };

  const res = await runReconciliation({
    client,
    mappings,
    checkpoints,
    receipts,
    // A transport failure: asking again later may well succeed.
    admitByHistory: async () => { throw new Error('provider_unavailable'); },
  });

  expect(res.stop).toBe('history_unavailable');
  expect(res.admitted).toBe(0);
  expect(res.skipped.historyUnavailable).toBe(1);
  // THE ASSERTION THAT MATTERS: nothing was advanced, so the next tick sees
  // this application again.
  expect(res.advanced).toBe(false);
  expect(checkpoints.advances).toBe(0);
  expect(receipts.writes).toBe(0);
});

it('a DETERMINATE fence failure is skipped, and the sweep still completes', async () => {
  const receipts = new Receipts();
  const checkpoints = new RecordingCheckpoints();
  const rows = [
    { application: { id: 'app_poison', job: { id: JOB }, currentInterviewStage: { id: STAGE } } },
    { application: { id: 'app_good', job: { id: JOB }, currentInterviewStage: { id: STAGE } } },
  ];
  const client = {
    applicationList: async <T = OpaqueRecord[]>() => ({
      results: rows as unknown as T, moreDataAvailable: false, syncToken: 'tok',
    }) as AshbyResult<T>,
  };
  const mappings: EnabledMappingLoader = {
    async listEnabled() {
      return { truncated: false, rows: [{ externalJobId: JOB, aiScreeningStageId: STAGE, activationAt: ACTIVATED, activationEpoch: 2, configVersion: 4 }] };
    },
  };

  const res = await runReconciliation({
    client,
    mappings,
    checkpoints,
    receipts,
    admitByHistory: async ({ applicationId }) => {
      // The provider ANSWERED; the answer is unusable. Asking again cannot
      // help, so this one row must not hold the stream forever.
      if (applicationId === 'app_poison') throw new Error('ashby_history_ambiguous');
      return 'admit';
    },
  });

  expect(res.stop).toBe('drained');
  expect(res.admitted).toBe(1);
  expect(res.skipped.historyUnavailable).toBe(1);
  expect(res.advanced).toBe(true);
  expect(receipts.writes).toBe(1);
});

it('a mapping with no activation instant admits nobody, and stops nothing', async () => {
  const receipts = new Receipts();
  const rows = [
    { application: { id: 'app_unstamped', job: { id: 'job_unstamped' }, currentInterviewStage: { id: STAGE } } },
    { application: { id: 'app_good', job: { id: JOB }, currentInterviewStage: { id: STAGE } } },
  ];
  const client = {
    applicationList: async <T = OpaqueRecord[]>() => ({ results: rows as unknown as T, moreDataAvailable: false }) as AshbyResult<T>,
  };
  // One enabled mapping carries no activation instant. That used to throw
  // `ashby_activation_guard_malformed` and abort the run for EVERY mapping,
  // while the other two admission paths always scoped it to one application.
  const mappings: EnabledMappingLoader = {
    async listEnabled() {
      return {
        truncated: false,
        rows: [
          { externalJobId: 'job_unstamped', aiScreeningStageId: STAGE },
          { externalJobId: JOB, aiScreeningStageId: STAGE, activationAt: ACTIVATED, activationEpoch: 2, configVersion: 4 },
        ],
      };
    },
  };

  const res = await runReconciliation({
    client,
    mappings,
    checkpoints: new Checkpoints(),
    receipts,
    admitByHistory: async () => 'admit',
  });

  expect(res.admitted).toBe(1);
  // Its OWN bucket: "this mapping has no activation instant" is a config
  // fault an operator fixes, and `ambiguousMapping` already means "two
  // mappings disagree about the stage". Collapsing them makes the one signal
  // that is published to the health surface unreadable.
  expect(res.skipped.activationUnknown).toBe(1);
  expect(res.skipped.ambiguousMapping).toBe(0);
  expect(receipts.writes).toBe(1);
});

it('rejects future and conflicting open history, while requiring complete pagination evidence', async () => {
  await expect(admitStageAfterActivation(history([
    { stageId: STAGE, enteredStageAt: '2026-09-27T00:00:00Z', leftStageAt: null },
  ]), { applicationId: APP, stageId: STAGE, activationAt: ACTIVATED, nowMs: CLOCK })).rejects.toThrow('entry_time_invalid');
  await expect(admitStageAfterActivation(history([
    { stageId: STAGE, enteredStageAt: '2026-09-24T00:00:00Z', leftStageAt: null },
    { stageId: STAGE, enteredStageAt: '2026-09-25T01:00:00Z', leftStageAt: null },
  ]), { applicationId: APP, stageId: STAGE, activationAt: ACTIVATED, nowMs: CLOCK })).rejects.toThrow('ambiguous');
  await expect(admitStageAfterActivation(history([
    { stageId: STAGE, enteredStageAt: '2026-09-24T00:00:00Z' },
  ]), { applicationId: APP, stageId: STAGE, activationAt: ACTIVATED, nowMs: CLOCK })).rejects.toThrow('exit_time_missing');
});
