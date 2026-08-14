/**
 * Ashby signal worker — signal-as-truth-source-of-record semantics.
 *
 * The worker re-reads authoritative application.info and validates against the
 * active mapping's CURRENT AI stage before deciding. Proves: eligible only when
 * the current stage IS the mapping's AI stage on an ENABLED mapping; human/TA/
 * other stage → no import; paused/drift/unknown mapping → no import;
 * self-generated echo → no-op; applicationUpdate → ignored; candidateDelete →
 * capability-gated. The leased runner commits ONLY under the live lease — a
 * stale/reclaimed lease cannot commit.
 */

import { describe, it, expect } from 'vitest';
import {
  processAshbySignal,
  runClaimedAshbySignal,
  ASHBY_SIGNAL_QUEUE,
  type SignalWorkerDeps,
  type MappingResolver,
  type MappingActivity,
  type LeasedSignalQueue,
} from '../integrations/ashby/signal-worker.js';
import type { ApplicationInfoReader } from '../integrations/ashby/signal-worker.js';
import type { AshbyResult, OpaqueRecord } from '../integrations/ashby/types.js';
import type { AshbySignalPayload } from '../integrations/ashby/ports.js';
import type { QueueJob, FailOutcome } from '../lib/queue/types.js';

function reader(app: OpaqueRecord): ApplicationInfoReader {
  return {
    async applicationInfo<T = OpaqueRecord>(): Promise<AshbyResult<T>> {
      return { results: app as unknown as T, moreDataAvailable: false };
    },
  };
}
function mapping(activity: MappingActivity): MappingResolver {
  return { async resolveByJobId(): Promise<MappingActivity> { return activity; } };
}
function appInfo(jobId: string, stageId: string, id = 'app_1'): OpaqueRecord {
  return { application: { id, job: { id: jobId }, currentInterviewStage: { id: stageId } } };
}
const STAGE_SIGNAL: AshbySignalPayload = {
  provider: 'ashby', action: 'candidateStageChange', webhookActionId: 'stage:app_1:stage_ai', externalApplicationId: 'app_1',
};

describe('processAshbySignal decisions', () => {
  it('import_eligible when current stage IS the enabled mapping AI stage', async () => {
    const deps: SignalWorkerDeps = {
      client: reader(appInfo('job_1', 'stage_ai')),
      mappings: mapping({ status: 'enabled', aiScreeningStageId: 'stage_ai' }),
    };
    const res = await processAshbySignal(STAGE_SIGNAL, deps);
    expect(res.decision).toBe('import_eligible');
    expect(res).toMatchObject({ applicationId: 'app_1', jobId: 'job_1', stageId: 'stage_ai' });
  });

  it('stage_not_ai when the current stage is a human/TA stage (no import)', async () => {
    const deps: SignalWorkerDeps = {
      client: reader(appInfo('job_1', 'stage_ta')),
      mappings: mapping({ status: 'enabled', aiScreeningStageId: 'stage_ai' }),
    };
    expect((await processAshbySignal(STAGE_SIGNAL, deps)).decision).toBe('stage_not_ai');
  });

  it('mapping_inactive when the mapping is paused / drift / unknown', async () => {
    for (const status of ['paused', 'drift', 'unknown'] as const) {
      const deps: SignalWorkerDeps = {
        client: reader(appInfo('job_1', 'stage_ai')),
        mappings: mapping({ status, aiScreeningStageId: 'stage_ai' }),
      };
      expect((await processAshbySignal(STAGE_SIGNAL, deps)).decision).toBe('mapping_inactive');
    }
  });

  it('self_echo when the stage change was our own write-back', async () => {
    const deps: SignalWorkerDeps = {
      client: reader(appInfo('job_1', 'stage_ai')),
      mappings: mapping({ status: 'enabled', aiScreeningStageId: 'stage_ai' }),
      isSelfEcho: () => true,
    };
    expect((await processAshbySignal(STAGE_SIGNAL, deps)).decision).toBe('self_echo');
  });

  it('ignored_action for applicationUpdate (redundant with stage change)', async () => {
    const deps: SignalWorkerDeps = {
      client: reader(appInfo('job_1', 'stage_ai')),
      mappings: mapping({ status: 'enabled', aiScreeningStageId: 'stage_ai' }),
    };
    const res = await processAshbySignal({ ...STAGE_SIGNAL, action: 'applicationUpdate' }, deps);
    expect(res.decision).toBe('ignored_action');
  });

  it('capability_disabled for candidateDelete while the capability is gated off', async () => {
    const deps: SignalWorkerDeps = {
      client: reader(appInfo('job_1', 'stage_ai')),
      mappings: mapping({ status: 'enabled', aiScreeningStageId: 'stage_ai' }),
    };
    const res = await processAshbySignal({ ...STAGE_SIGNAL, action: 'candidateDelete' }, deps);
    expect(res.decision).toBe('capability_disabled');
  });

  it('skipped_no_application when the signal carries no application id', async () => {
    const deps: SignalWorkerDeps = {
      client: reader(appInfo('job_1', 'stage_ai')),
      mappings: mapping({ status: 'enabled', aiScreeningStageId: 'stage_ai' }),
    };
    const res = await processAshbySignal({ ...STAGE_SIGNAL, externalApplicationId: undefined }, deps);
    expect(res.decision).toBe('skipped_no_application');
  });

  it('re-reads authoritative state and ignores the payload-claimed stage', async () => {
    // The signal claims stage_ai, but application.info says the app is actually
    // at a human stage now — the worker trusts application.info (no import).
    const deps: SignalWorkerDeps = {
      client: reader(appInfo('job_1', 'stage_human')),
      mappings: mapping({ status: 'enabled', aiScreeningStageId: 'stage_ai' }),
    };
    expect((await processAshbySignal(STAGE_SIGNAL, deps)).decision).toBe('stage_not_ai');
  });
});

// ── Leased runner ────────────────────────────────────────────────────────────

function job(payload: Record<string, unknown>, leaseToken = 'lease_1'): QueueJob {
  return {
    id: 'job_1', name: ASHBY_SIGNAL_QUEUE, payload, status: 'active', attempts: 1, maxAttempts: 5,
    priority: 0, scheduledAt: '2026-08-13T00:00:00.000Z', createdAt: '2026-08-13T00:00:00.000Z', leaseToken,
  };
}

class FakeQueue implements LeasedSignalQueue {
  constructor(private next: QueueJob | null, private completeResult = true) {}
  claimed: string[] = [];
  failed: Array<{ id: string; token: string }> = [];
  async claim<T = unknown>(): Promise<QueueJob<T> | null> {
    const j = this.next; this.next = null; return j as QueueJob<T> | null;
  }
  async completeClaim(jobId: string, token: string): Promise<boolean> {
    this.claimed.push(`${jobId}:${token}`); return this.completeResult;
  }
  async failClaim(jobId: string, token: string): Promise<FailOutcome> {
    this.failed.push({ id: jobId, token }); return 'retry_scheduled';
  }
}

const eligibleDeps: SignalWorkerDeps = {
  client: reader(appInfo('job_1', 'stage_ai')),
  mappings: mapping({ status: 'enabled', aiScreeningStageId: 'stage_ai' }),
};

describe('runClaimedAshbySignal (lease-guarded)', () => {
  it('claimed:false when the queue is empty', async () => {
    const res = await runClaimedAshbySignal(new FakeQueue(null), eligibleDeps);
    expect(res).toEqual({ claimed: false });
  });

  it('processes and commits under a live lease', async () => {
    const q = new FakeQueue(job({ provider: 'ashby', action: 'candidateStageChange', webhookActionId: 'stage:app_1:stage_ai', externalApplicationId: 'app_1' }), true);
    const res = await runClaimedAshbySignal(q, eligibleDeps);
    expect(res).toMatchObject({ claimed: true, committed: true, staleLease: false });
    expect((res as { result?: { decision: string } }).result?.decision).toBe('import_eligible');
    expect(q.claimed).toEqual(['job_1:lease_1']);
  });

  it('a STALE/reclaimed lease cannot commit (completeClaim=false)', async () => {
    const q = new FakeQueue(job({ provider: 'ashby', action: 'candidateStageChange', webhookActionId: 'stage:app_1:stage_ai', externalApplicationId: 'app_1' }), false);
    const res = await runClaimedAshbySignal(q, eligibleDeps);
    expect(res).toMatchObject({ claimed: true, committed: false, staleLease: true });
  });

  it('fails a malformed payload under the lease', async () => {
    const q = new FakeQueue(job({ nonsense: true }));
    const res = await runClaimedAshbySignal(q, eligibleDeps);
    expect(res).toMatchObject({ claimed: true, committed: false });
    expect(q.failed).toHaveLength(1);
  });
});
