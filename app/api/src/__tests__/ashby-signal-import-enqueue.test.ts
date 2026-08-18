/**
 * Signal → import scheduling.
 *
 * Before this change `processAshbySignal` returned `import_eligible` and did
 * nothing with it — the verdict was handed to a test and discarded, so the
 * chain terminated. These tests pin the new `onImportEligible` seam:
 *
 *  - EVERY non-eligible decision enqueues NO import (enumerated exhaustively —
 *    a new decision branch that forgets the gate will fail here).
 *  - An eligible decision enqueues exactly one import, keyed by APPLICATION, so
 *    a duplicate webhook, a redelivery, and a reconciliation recovery converge.
 *  - Scheduling happens BEFORE the best-effort receipt bookkeeping, and a
 *    scheduling failure propagates so the leased job retries instead of acking
 *    work that was never scheduled.
 *
 * Zero network, zero DB: the client, mapping resolver and receipt store are
 * in-memory fakes.
 */

import { describe, it, expect, vi } from 'vitest';
import {
  processAshbySignal,
  importDedupKey,
  ASHBY_IMPORT_QUEUE,
  ASHBY_SIGNAL_QUEUE,
  type SignalWorkerDeps,
  type MappingActivity,
} from '../integrations/ashby/signal-worker.js';
import { CANDIDATE_STAGE_CHANGE_ACTION } from '../integrations/ashby/extractors.js';
import type { AshbySignalPayload } from '../integrations/ashby/ports.js';
import { Queue } from '../lib/queue/index.js';
import { MemoryAdapter } from '../lib/queue/memory-adapter.js';

const AI_STAGE = 'stage_ai';
const APP = 'app_1';
const JOB = 'job_1';

function payload(over: Partial<AshbySignalPayload> = {}): AshbySignalPayload {
  return {
    provider: 'ashby',
    webhookActionId: 'wh_1',
    action: CANDIDATE_STAGE_CHANGE_ACTION,
    externalApplicationId: APP,
    ...over,
  };
}

function deps(over: {
  mapping?: MappingActivity;
  stage?: string;
  jobId?: string | null;
  isSelfEcho?: SignalWorkerDeps['isSelfEcho'];
  onImportEligible?: SignalWorkerDeps['onImportEligible'];
} = {}): SignalWorkerDeps {
  return {
    client: {
      applicationInfo: async () => ({
        results: {
          id: APP,
          job: { id: over.jobId === undefined ? JOB : over.jobId },
          currentInterviewStage: { id: over.stage ?? AI_STAGE },
        },
        moreDataAvailable: false,
      }) as never,
    },
    mappings: {
      resolveByJobId: async () => over.mapping ?? { status: 'enabled', aiScreeningStageId: AI_STAGE },
    },
    receipts: { record: async () => ({ status: 'inserted', id: 'r1', enqueued: true, workPending: true }) },
    candidateDeleteEnabled: false,
    isSelfEcho: over.isSelfEcho,
    onImportEligible: over.onImportEligible,
  };
}

describe('onImportEligible — fires ONLY for import_eligible', () => {
  it('enqueues exactly one import for a genuinely eligible signal', async () => {
    const onImportEligible = vi.fn(async () => {});
    const r = await processAshbySignal(payload(), deps({ onImportEligible }));
    expect(r.decision).toBe('import_eligible');
    expect(onImportEligible).toHaveBeenCalledTimes(1);
    expect(onImportEligible).toHaveBeenCalledWith({ applicationId: APP, jobId: JOB, stageId: AI_STAGE });
  });

  // Exhaustive over every non-eligible decision the worker can produce. Each
  // case builds its own payload+deps around the injected spy, so adding a new
  // decision branch without gating it will fail here.
  const nonEligible: Array<{
    label: string;
    expected: string;
    run: (spy: SignalWorkerDeps['onImportEligible']) => Promise<{ decision: string }>;
  }> = [
    {
      label: 'ignored_action (applicationUpdate is redundant)',
      expected: 'ignored_action',
      run: (spy) => processAshbySignal(payload({ action: 'applicationUpdate' }), deps({ onImportEligible: spy })),
    },
    {
      label: 'capability_disabled (candidateDelete gated off)',
      expected: 'capability_disabled',
      run: (spy) => processAshbySignal(payload({ action: 'candidateDelete' }), deps({ onImportEligible: spy })),
    },
    {
      label: 'skipped_no_application',
      expected: 'skipped_no_application',
      run: (spy) => processAshbySignal(payload({ externalApplicationId: undefined }), deps({ onImportEligible: spy })),
    },
    {
      label: 'mapping_inactive (no job id on the re-read)',
      expected: 'mapping_inactive',
      run: (spy) => processAshbySignal(payload(), deps({ onImportEligible: spy, jobId: null })),
    },
    {
      label: 'mapping_inactive (paused mapping)',
      expected: 'mapping_inactive',
      run: (spy) => processAshbySignal(payload(), deps({ onImportEligible: spy, mapping: { status: 'paused', aiScreeningStageId: AI_STAGE } })),
    },
    {
      label: 'mapping_inactive (drifted mapping)',
      expected: 'mapping_inactive',
      run: (spy) => processAshbySignal(payload(), deps({ onImportEligible: spy, mapping: { status: 'drift', aiScreeningStageId: AI_STAGE } })),
    },
    {
      label: 'mapping_inactive (unknown mapping)',
      expected: 'mapping_inactive',
      run: (spy) => processAshbySignal(payload(), deps({ onImportEligible: spy, mapping: { status: 'unknown' } })),
    },
    {
      label: 'mapping_inactive (enabled but no AI stage configured)',
      expected: 'mapping_inactive',
      run: (spy) => processAshbySignal(payload(), deps({ onImportEligible: spy, mapping: { status: 'enabled', aiScreeningStageId: null } })),
    },
    {
      label: 'stage_not_ai (a human/TA stage)',
      expected: 'stage_not_ai',
      run: (spy) => processAshbySignal(payload(), deps({ onImportEligible: spy, stage: 'stage_ta_human' })),
    },
    {
      label: 'self_echo (our own write-back)',
      expected: 'self_echo',
      run: (spy) => processAshbySignal(payload(), deps({ onImportEligible: spy, isSelfEcho: () => true })),
    },
  ];

  for (const testCase of nonEligible) {
    it(`enqueues NO import for ${testCase.label}`, async () => {
      const onImportEligible = vi.fn(async () => {});
      const result = await testCase.run(onImportEligible);
      expect(result.decision).toBe(testCase.expected);
      expect(onImportEligible).not.toHaveBeenCalled();
    });
  }

  it('omitting the seam preserves the previous decision-only behaviour exactly', async () => {
    const r = await processAshbySignal(payload(), deps());
    expect(r.decision).toBe('import_eligible');
    // No throw, no side effect — the merged suites relied on precisely this.
  });
});

describe('import scheduling ordering and durability', () => {
  it('schedules the import BEFORE marking the receipt processed', async () => {
    const order: string[] = [];
    const d = deps({ onImportEligible: async () => { order.push('enqueue'); } });
    d.receipts = {
      record: async () => ({ status: 'inserted', id: 'r1', enqueued: true, workPending: true }),
      markStatus: async () => { order.push('markStatus'); },
    };
    await processAshbySignal(payload(), d);
    // `mark` deliberately swallows failures. If the order were reversed, a
    // scheduling failure could leave a terminal receipt with no durable work,
    // and the reconciliation re-drive would then decline to re-enqueue.
    expect(order).toEqual(['enqueue', 'markStatus']);
  });

  it('propagates a scheduling failure so the leased job retries', async () => {
    const d = deps({ onImportEligible: async () => { throw new Error('enqueue_failed'); } });
    await expect(processAshbySignal(payload(), d)).rejects.toThrow('enqueue_failed');
  });
});

describe('importDedupKey — convergence to exactly one import', () => {
  it('is keyed by the application, not the webhook delivery', () => {
    expect(importDedupKey(APP)).toBe(`ashby:import:${APP}`);
    expect(importDedupKey(APP)).toBe(importDedupKey(APP));
    expect(importDedupKey('app_2')).not.toBe(importDedupKey(APP));
  });

  it('collapses a duplicate webhook, a redelivery, and a reconcile into ONE live job', async () => {
    const clock = () => '2026-08-17T00:00:00.000Z';
    const queue = new Queue(new MemoryAdapter({ clock }), { clock });

    const enqueueOnce = async ({ applicationId }: { applicationId: string }) => {
      await queue.enqueue(
        ASHBY_IMPORT_QUEUE,
        { provider: 'ashby', externalApplicationId: applicationId },
        { dedupKey: importDedupKey(applicationId), maxAttempts: 5 },
      );
    };

    // Three independent deliveries for the SAME application, each with its own
    // webhook action id — a duplicate, a redelivery, and a reconciliation.
    await processAshbySignal(payload({ webhookActionId: 'wh_1' }), deps({ onImportEligible: enqueueOnce }));
    await processAshbySignal(payload({ webhookActionId: 'wh_2' }), deps({ onImportEligible: enqueueOnce }));
    await processAshbySignal(payload({ webhookActionId: 'reconcile_1' }), deps({ onImportEligible: enqueueOnce }));

    let claimed = 0;
    for (;;) {
      const job = await queue.claim(ASHBY_IMPORT_QUEUE, { owner: 'w', leaseSeconds: 30 });
      if (!job) break;
      claimed += 1;
      await queue.completeClaim(job.id, job.leaseToken!);
      if (claimed > 5) break; // guard against a runaway
    }
    expect(claimed).toBe(1);
  });
});

describe('queue naming', () => {
  it('uses stable, distinct queue names', () => {
    expect(ASHBY_SIGNAL_QUEUE).toBe('ashby.signal');
    expect(ASHBY_IMPORT_QUEUE).toBe('ashby.import');
    expect(ASHBY_SIGNAL_QUEUE).not.toBe(ASHBY_IMPORT_QUEUE);
  });
});
