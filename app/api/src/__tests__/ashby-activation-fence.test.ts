import { describe, expect, it, vi } from 'vitest';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';
import {
  admitStageAfterActivation,
  runReconciliation,
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

function history(rows: OpaqueRecord[], moreDataAvailable = false, nextCursor?: string): ApplicationHistoryLister {
  return { applicationListHistory: (async <T = OpaqueRecord[]>(_params: { applicationId: string; cursor?: string; limit?: number }) => ({ results: rows as unknown as T, moreDataAvailable, nextCursor }) as AshbyResult<T>) };
}

describe('Ashby timestamp admission', () => {
  it('admits only the active mapped stage entry at/after activation', async () => {
    const old = await admitStageAfterActivation(history([
      { stageId: STAGE, enteredStageAt: '2026-09-24T23:59:59Z', leftStageAt: null },
    ]), { applicationId: APP, stageId: STAGE, activationAt: ACTIVATED });
    expect(old).toBe('not_after_activation');

    const fresh = await admitStageAfterActivation(history([
      { stageId: 'stage_other', enteredStageAt: '2026-09-24T00:00:00Z', leftStageAt: '2026-09-25T01:00:00Z' },
      { stageId: STAGE, enteredStageAt: '2026-09-25T01:00:00Z', leftStageAt: null },
    ]), { applicationId: APP, stageId: STAGE, activationAt: ACTIVATED });
    expect(fresh).toBe('admit');
  });

  it('paginates and treats provider failure or malformed time as retryable', async () => {
    const reader: ApplicationHistoryLister = {
      applicationListHistory: vi.fn()
        .mockResolvedValueOnce({ results: [{ stageId: 'stage_other', enteredStageAt: '2026-09-24T00:00:00Z', leftStageAt: '2026-09-24T01:00:00Z' }], moreDataAvailable: true, nextCursor: 'next' })
        .mockResolvedValueOnce({ results: [{ stageId: STAGE, enteredStageAt: '2026-09-25T00:01:00Z', leftStageAt: null }], moreDataAvailable: false }),
    };
    await expect(admitStageAfterActivation(reader, { applicationId: APP, stageId: STAGE, activationAt: ACTIVATED })).resolves.toBe('admit');
    await expect(admitStageAfterActivation(history([{ stageId: STAGE, enteredStageAt: 'not-a-time', leftStageAt: null }]), { applicationId: APP, stageId: STAGE, activationAt: ACTIVATED })).rejects.toThrow('entry_time_invalid');
    await expect(admitStageAfterActivation({ applicationListHistory: async () => { throw new Error('provider_down'); } }, { applicationId: APP, stageId: STAGE, activationAt: ACTIVATED })).rejects.toThrow('provider_down');
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
  const old = await runReconciliation({ client, history: client, mappings, checkpoints: new Checkpoints(), receipts });
  expect(old.admitted).toBe(0);
  expect(receipts.writes).toBe(0);

  client.applicationListHistory = async <T = OpaqueRecord[]>() => ({ results: [{ stageId: STAGE, enteredStageAt: '2026-09-26T00:00:01Z', leftStageAt: null }] as unknown as T, moreDataAvailable: false }) as AshbyResult<T>;
  const fresh = await runReconciliation({ client, history: client, mappings, checkpoints: new Checkpoints(), receipts });
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

it('rejects future and conflicting open history, while requiring complete pagination evidence', async () => {
  await expect(admitStageAfterActivation(history([
    { stageId: STAGE, enteredStageAt: '2026-09-27T00:00:00Z', leftStageAt: null },
  ]), { applicationId: APP, stageId: STAGE, activationAt: ACTIVATED })).rejects.toThrow('entry_time_invalid');
  await expect(admitStageAfterActivation(history([
    { stageId: STAGE, enteredStageAt: '2026-09-24T00:00:00Z', leftStageAt: null },
    { stageId: STAGE, enteredStageAt: '2026-09-25T01:00:00Z', leftStageAt: null },
  ]), { applicationId: APP, stageId: STAGE, activationAt: ACTIVATED })).rejects.toThrow('ambiguous');
  await expect(admitStageAfterActivation(history([
    { stageId: STAGE, enteredStageAt: '2026-09-24T00:00:00Z' },
  ]), { applicationId: APP, stageId: STAGE, activationAt: ACTIVATED })).rejects.toThrow('exit_time_missing');
});

it('migration contains the activation and snapshot-scope guards', () => {
  const migration = readFileSync(resolve(dirname(fileURLToPath(import.meta.url)), '../../../supabase/migrations/0106_ashby_activation_fence_and_snapshot_import.sql'), 'utf8');
  expect(migration).toContain('activation_at');
  expect(migration).toContain("m.config_version <> r.config_version");
  expect(migration).toContain("x->>'applicationId'=p_application_id");
  expect(migration).toContain("x->>'jobId'=p_job_id");
  expect(migration).toContain("x->>'stageId'=p_stage_id");
});
