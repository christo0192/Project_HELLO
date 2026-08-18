/**
 * Ashby reconciliation ADMISSION — the tenant-wide signal-storm guard.
 *
 * Production evidence this suite pins down: the first runtime reconciliation
 * pass, against a tenant whose only mapping was PAUSED, created exactly 2,000
 * pending `ashby.signal` jobs and zero links, operations, or imports.
 * `runReconciliation` recorded a receipt and enqueued a signal for EVERY
 * application it observed, and the mapping/stage gate only ran later, inside
 * the worker — after a tenant-wide fan-out had already been durably queued.
 *
 * The contract proven here:
 *   1. Paused / absent mappings ⇒ ZERO receipts, ZERO jobs, ZERO
 *      `application.info` reads, even across thousands of applications.
 *   2. One enabled mapping admits ONLY the exact (job, AI stage) pair; other
 *      stages, other jobs, and rows missing either id are skipped.
 *   3. Admission happens BEFORE receipt persistence and enqueueing.
 *   4. The mapping index costs ONE bounded load per run and is never reused
 *      across runs, so a pause or a stage edit lands on the very next pass.
 *   5. The worker's authoritative `application.info` re-read is unchanged —
 *      admission narrows what gets queued, it never becomes the authority.
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import {
  runReconciliation,
  admitApplication,
  buildEnabledStageIndex,
  DEFAULT_MAX_ENABLED_MAPPINGS,
  DEFAULT_MAX_ENQUEUE_PER_RUN,
  UNCLASSIFIED_RESYNC_REASON,
  type ApplicationLister,
} from '../integrations/ashby/reconciliation.js';
import { processAshbySignal } from '../integrations/ashby/signal-worker.js';
import {
  publishReconcilePass,
  snapshotReconcilePass,
  clearReconcilePassRegistration,
} from '../integrations/ashby/runtime-health.js';
import { ingestWebhook } from '../integrations/ashby/ingress.js';
import { stageDedupId, CANDIDATE_STAGE_CHANGE_ACTION } from '../integrations/ashby/extractors.js';
import type {
  CheckpointStore, ReceiptStore, ReceiptOutcome, SyncCheckpoint,
  EnabledMappingLoader, EnabledMappingRow,
} from '../integrations/ashby/ports.js';
import type { AshbyResult, OpaqueRecord } from '../integrations/ashby/types.js';

const JOB = 'job_enabled';
const AI = 'stage_ai';

// ── Fakes ───────────────────────────────────────────────────────────────────

/** Transactional-outbox fake: dedups receipts and keeps one live job per key. */
class FakeReceipts implements ReceiptStore {
  seen = new Set<string>();
  liveJobs = new Set<string>();
  writes = 0;
  async record(input: {
    webhookActionId: string;
    action: string;
    enqueue?: { dedupKey: string };
  }): Promise<ReceiptOutcome> {
    this.writes += 1;
    const key = `${input.action}:${input.webhookActionId}`;
    const fresh = !this.seen.has(key);
    if (fresh) this.seen.add(key);
    let enqueued = false;
    if (input.enqueue && !this.liveJobs.has(input.enqueue.dedupKey)) {
      this.liveJobs.add(input.enqueue.dedupKey);
      enqueued = true;
    }
    return { status: fresh ? 'inserted' : 'duplicate', id: key, enqueued, workPending: true };
  }
}

class FakeCheckpoints implements CheckpointStore {
  current: SyncCheckpoint | null;
  advances: Array<{ syncToken: string | null; resyncEpoch?: number | null }> = [];
  resyncs: string[] = [];
  constructor(initial: SyncCheckpoint | null = null) { this.current = initial; }
  async get(): Promise<SyncCheckpoint | null> { return this.current; }
  async advance(input: { syncToken: string | null; resyncEpoch?: number | null }): Promise<void> {
    this.advances.push({ syncToken: input.syncToken, resyncEpoch: input.resyncEpoch });
  }
  async requireFullResync(_key: string, reason: string): Promise<void> { this.resyncs.push(reason); }
}

/** A mutable enabled-mapping loader that counts loads (one per run expected). */
class FakeMappings implements EnabledMappingLoader {
  rows: EnabledMappingRow[];
  truncated = false;
  calls = 0;
  lastLimit = 0;
  constructor(rows: EnabledMappingRow[] = []) { this.rows = rows; }
  async listEnabled(limit: number): Promise<{ rows: EnabledMappingRow[]; truncated: boolean }> {
    this.calls += 1;
    this.lastLimit = limit;
    return { rows: this.rows, truncated: this.truncated };
  }
}

function scriptedLister(pages: Array<Partial<AshbyResult<OpaqueRecord[]>>>): ApplicationLister {
  let i = 0;
  return {
    async applicationList<T = OpaqueRecord[]>(): Promise<AshbyResult<T>> {
      const p = pages[Math.min(i, pages.length - 1)];
      i += 1;
      return {
        results: (p.results ?? []) as unknown as T,
        moreDataAvailable: p.moreDataAvailable ?? false,
        nextCursor: p.nextCursor,
        syncToken: p.syncToken,
      };
    },
  };
}

/** A full application.list row. Omit ids to model an ambiguous provider row. */
function row(id: string, opts: { jobId?: string; stageId?: string } = {}): OpaqueRecord {
  const application: Record<string, unknown> = { id };
  if (opts.jobId !== undefined) application.job = { id: opts.jobId };
  if (opts.stageId !== undefined) application.currentInterviewStage = { id: opts.stageId };
  return { application };
}

// ── 1. The storm: 2,000 applications, no enabled mapping ────────────────────

describe('admission — paused / absent mappings create no work at all', () => {
  /** The production shape: 2,000 mixed applications across many jobs. */
  function stormPage(): OpaqueRecord[] {
    const out: OpaqueRecord[] = [];
    for (let i = 0; i < 2_000; i++) {
      const jobId = `job_${i % 40}`;
      const stageId = i % 3 === 0 ? AI : `stage_other_${i % 7}`;
      out.push(row(`app_${i}`, { jobId, stageId }));
    }
    return out;
  }

  it('2,000 applications with the tenant\'s only mapping PAUSED ⇒ zero receipts, zero jobs', async () => {
    const receipts = new FakeReceipts();
    const checkpoints = new FakeCheckpoints(null);
    // A paused mapping is simply absent from the enabled-mapping load.
    const mappings = new FakeMappings([]);
    const res = await runReconciliation({
      client: scriptedLister([{ results: stormPage(), moreDataAvailable: false, syncToken: 'tok' }]),
      checkpoints, receipts, mappings, caps: { maxItems: 5_000 },
    });

    expect(res.observed).toBe(2_000);
    expect(res.admitted).toBe(0);
    expect(res.skipped.noEnabledMapping).toBe(2_000);
    // The regression, stated as bluntly as production stated it.
    expect(receipts.writes).toBe(0);
    expect(receipts.seen.size).toBe(0);
    expect(receipts.liveJobs.size).toBe(0);
    expect(res.recovered).toBe(0);
    expect(res.duplicates).toBe(0);
    expect(res.enqueued).toBe(0);
    // A pass that admitted nothing is still a COMPLETE pass: the cursor
    // advances, so the stream stays healthy rather than replaying forever.
    expect(res.stop).toBe('drained');
    expect(res.advanced).toBe(true);
  });

  it('the same 2,000 applications with NO mappings at all ⇒ zero receipts, zero jobs', async () => {
    const receipts = new FakeReceipts();
    const res = await runReconciliation({
      client: scriptedLister([{ results: stormPage(), moreDataAvailable: false, syncToken: 'tok' }]),
      checkpoints: new FakeCheckpoints(null),
      receipts,
      mappings: new FakeMappings([]),
      caps: { maxItems: 5_000 },
    });
    expect(res.admitted).toBe(0);
    expect(receipts.writes).toBe(0);
    expect(res.mappingsLoaded).toBe(0);
  });

  it('costs ONE bounded mapping load per run — not one lookup per application', async () => {
    const mappings = new FakeMappings([]);
    await runReconciliation({
      client: scriptedLister([
        { results: stormPage(), moreDataAvailable: true, nextCursor: 'c1' },
        { results: stormPage(), moreDataAvailable: false, syncToken: 'tok' },
      ]),
      checkpoints: new FakeCheckpoints(null),
      receipts: new FakeReceipts(),
      mappings,
      caps: { maxItems: 5_000 },
    });
    expect(mappings.calls).toBe(1);
    expect(mappings.lastLimit).toBe(DEFAULT_MAX_ENABLED_MAPPINGS);
  });
});

// ── 2. Exact (job, stage) admission ─────────────────────────────────────────

describe('admission — one enabled mapping admits only the exact job + stage', () => {
  const mixed = [
    row('app_hit_1', { jobId: JOB, stageId: AI }),          // admit
    row('app_hit_2', { jobId: JOB, stageId: AI }),          // admit
    row('app_other_stage', { jobId: JOB, stageId: 'stage_ta' }),   // skip
    row('app_other_job', { jobId: 'job_paused', stageId: AI }),    // skip
    row('app_no_job', { stageId: AI }),                     // skip
    row('app_no_stage', { jobId: JOB }),                    // skip
    { application: {} } as OpaqueRecord,                    // skip (no app id)
  ];

  it('admits exactly the matching pair and skips everything else with reasons', async () => {
    const receipts = new FakeReceipts();
    const res = await runReconciliation({
      client: scriptedLister([{ results: mixed, moreDataAvailable: false, syncToken: 'tok' }]),
      checkpoints: new FakeCheckpoints(null),
      receipts,
      mappings: new FakeMappings([{ externalJobId: JOB, aiScreeningStageId: AI }]),
    });

    expect(res.observed).toBe(7);
    // 2 exact matches + 2 fail-open unclassified rows (no_job, no_stage).
    expect(res.admitted).toBe(4);
    expect(res.unclassified).toBe(2);
    expect(res.skipped).toEqual({
      noApplicationId: 1,
      noEnabledMapping: 1,    // job_paused
      stageNotAi: 1,          // stage_ta on the mapped job
      ambiguousMapping: 0,
    });
    // The counters are internally consistent — no row is double-counted or lost.
    const skips = Object.values(res.skipped).reduce((a, b) => a + b, 0);
    expect(res.admitted + skips).toBe(res.observed);

    // The two exact matches carry the SAME stage-centric identity the webhook
    // uses; the unclassified pair is admitted for the worker to adjudicate.
    expect(receipts.writes).toBe(4);
    expect(receipts.seen).toContain(
      `${CANDIDATE_STAGE_CHANGE_ACTION}:${stageDedupId('app_hit_1', AI)}`);
    expect(receipts.seen).toContain(
      `${CANDIDATE_STAGE_CHANGE_ACTION}:${stageDedupId('app_hit_2', AI)}`);
    expect(receipts.liveJobs.size).toBe(4);
  });

  it('refuses to guess when the index holds conflicting stages for one job', async () => {
    const receipts = new FakeReceipts();
    const res = await runReconciliation({
      client: scriptedLister([{
        results: [row('a', { jobId: JOB, stageId: AI }), row('b', { jobId: JOB, stageId: 'other' })],
        moreDataAvailable: false, syncToken: 'tok',
      }]),
      checkpoints: new FakeCheckpoints(null),
      receipts,
      mappings: new FakeMappings([
        { externalJobId: JOB, aiScreeningStageId: AI },
        { externalJobId: JOB, aiScreeningStageId: 'stage_conflict' },
      ]),
    });
    expect(res.admitted).toBe(0);
    expect(res.skipped.ambiguousMapping).toBe(2);
    expect(receipts.writes).toBe(0);
  });

  it('reports a truncated mapping index instead of silently under-admitting', async () => {
    const mappings = new FakeMappings([{ externalJobId: JOB, aiScreeningStageId: AI }]);
    mappings.truncated = true;
    const res = await runReconciliation({
      client: scriptedLister([{ results: [row('a', { jobId: JOB, stageId: AI })], moreDataAvailable: false }]),
      checkpoints: new FakeCheckpoints(null),
      receipts: new FakeReceipts(),
      mappings,
    });
    expect(res.mappingIndexTruncated).toBe(true);
    expect(res.admitted).toBe(1);
  });
});

// ── 3. Admission runs BEFORE persistence ────────────────────────────────────

describe('admission ordering', () => {
  it('never touches the receipt store for a skipped row', async () => {
    const record = vi.fn();
    const res = await runReconciliation({
      client: scriptedLister([{
        results: [
          row('a', { jobId: 'job_paused', stageId: AI }),
          row('b', { jobId: JOB, stageId: 'stage_other' }),
        ],
        moreDataAvailable: false,
      }]),
      checkpoints: new FakeCheckpoints(null),
      receipts: { record } as unknown as ReceiptStore,
      mappings: new FakeMappings([{ externalJobId: JOB, aiScreeningStageId: AI }]),
    });
    expect(res.admitted).toBe(0);
    expect(record).not.toHaveBeenCalled();
  });
});

// ── 4. Freshness: never cached across runs or status changes ────────────────

describe('admission — mapping state is re-read every run', () => {
  it('honours an enable, then a pause, then a stage repoint on consecutive runs', async () => {
    const receipts = new FakeReceipts();
    const mappings = new FakeMappings([]);
    const page = [row('app_1', { jobId: JOB, stageId: AI }), row('app_2', { jobId: JOB, stageId: 'stage_v2' })];
    const deps = () => ({
      client: scriptedLister([{ results: page, moreDataAvailable: false, syncToken: 'tok' }]),
      checkpoints: new FakeCheckpoints(null),
      receipts,
      mappings,
    });

    // Run 1 — mapping paused: nothing admitted.
    expect((await runReconciliation(deps())).admitted).toBe(0);

    // Run 2 — mapping enabled at AI: app_1 admitted.
    mappings.rows = [{ externalJobId: JOB, aiScreeningStageId: AI }];
    const r2 = await runReconciliation(deps());
    expect(r2.admitted).toBe(1);
    expect(receipts.liveJobs.size).toBe(1);

    // Run 3 — mapping paused again: no NEW work, even though app_1 still sits
    // at the AI stage. The index is rebuilt, never reused.
    mappings.rows = [];
    const r3 = await runReconciliation(deps());
    expect(r3.admitted).toBe(0);
    expect(receipts.liveJobs.size).toBe(1);

    // Run 4 — mapping re-enabled at a DIFFERENT stage: only app_2 admitted now.
    mappings.rows = [{ externalJobId: JOB, aiScreeningStageId: 'stage_v2' }];
    const r4 = await runReconciliation(deps());
    expect(r4.admitted).toBe(1);
    expect(receipts.liveJobs.size).toBe(2);
    expect(mappings.calls).toBe(4); // exactly one load per run
  });

  it('hands the observed resync epoch back to advance (mid-run enable guard)', async () => {
    const checkpoints = new FakeCheckpoints({
      syncToken: 'tok', status: 'idle',
      tokenIssuedAt: new Date().toISOString(), lastSuccessAt: null, resyncEpoch: 7,
    });
    await runReconciliation({
      client: scriptedLister([{ results: [], moreDataAvailable: false, syncToken: 'tok2' }]),
      checkpoints,
      receipts: new FakeReceipts(),
      mappings: new FakeMappings([]),
    });
    expect(checkpoints.advances).toEqual([{ syncToken: 'tok2', resyncEpoch: 7 }]);
  });

  it('a forced resync (mapping just enabled) makes the run a FULL sweep', async () => {
    const checkpoints = new FakeCheckpoints({
      syncToken: 'tok', status: 'full_resync_required',
      tokenIssuedAt: new Date().toISOString(), lastSuccessAt: null, resyncEpoch: 3,
    });
    const receipts = new FakeReceipts();
    const res = await runReconciliation({
      client: scriptedLister([{
        results: [row('app_backlog', { jobId: JOB, stageId: AI })],
        moreDataAvailable: false, syncToken: 'tok2',
      }]),
      checkpoints, receipts,
      mappings: new FakeMappings([{ externalJobId: JOB, aiScreeningStageId: AI }]),
    });
    // The application that was parked at the trigger stage while the mapping
    // was paused is reconsidered — the whole point of forcing the resync.
    expect(res.mode).toBe('full');
    expect(res.admitted).toBe(1);
    expect(receipts.liveJobs.size).toBe(1);
  });
});

// ── 5. Convergence and the unchanged authoritative re-read ──────────────────

describe('admission preserves recovery, idempotence, and the worker authority', () => {
  it('a duplicate webhook after an admitted recovery still converges to one job', async () => {
    const receipts = new FakeReceipts();
    await runReconciliation({
      client: scriptedLister([{ results: [row('app_c', { jobId: JOB, stageId: AI })], moreDataAvailable: false }]),
      checkpoints: new FakeCheckpoints(null),
      receipts,
      mappings: new FakeMappings([{ externalJobId: JOB, aiScreeningStageId: AI }]),
    });
    expect(receipts.liveJobs.size).toBe(1);

    for (let i = 0; i < 3; i++) {
      const out = await ingestWebhook(
        { action: CANDIDATE_STAGE_CHANGE_ACTION, data: { application: { id: 'app_c', job: { id: JOB }, currentInterviewStage: { id: AI } } } },
        { receipts },
      );
      expect(out).toMatchObject({ kind: 'duplicate' });
    }
    expect(receipts.liveJobs.size).toBe(1);
  });

  it('reconciliation issues NO application.info calls — the worker still owns that read', async () => {
    const applicationInfo = vi.fn();
    await runReconciliation({
      client: {
        applicationList: async () => ({
          results: [row('a', { jobId: JOB, stageId: AI })] as unknown as OpaqueRecord[],
          moreDataAvailable: false,
        }),
        // A lister that ALSO exposes info: reconciliation must never call it.
        applicationInfo,
      } as unknown as ApplicationLister,
      checkpoints: new FakeCheckpoints(null),
      receipts: new FakeReceipts(),
      mappings: new FakeMappings([{ externalJobId: JOB, aiScreeningStageId: AI }]),
    });
    expect(applicationInfo).not.toHaveBeenCalled();
  });

  it('the worker re-reads application.info and rejects an admitted-but-stale row', async () => {
    // Admission saw the AI stage, but a human moved the candidate on before the
    // signal was processed. The authoritative re-read must still decline.
    const result = await processAshbySignal(
      { provider: 'ashby', action: CANDIDATE_STAGE_CHANGE_ACTION, webhookActionId: stageDedupId('a', AI), externalApplicationId: 'a' },
      {
        client: {
          applicationInfo: async () => ({
            results: { application: { id: 'a', job: { id: JOB }, currentInterviewStage: { id: 'stage_human' } } },
          }) as never,
        },
        mappings: { resolveByJobId: async () => ({ status: 'enabled', aiScreeningStageId: AI }) },
      },
    );
    expect(result.decision).toBe('stage_not_ai');
  });

  it('the worker still declines when the mapping paused between admission and processing', async () => {
    const result = await processAshbySignal(
      { provider: 'ashby', action: CANDIDATE_STAGE_CHANGE_ACTION, webhookActionId: stageDedupId('a', AI), externalApplicationId: 'a' },
      {
        client: {
          applicationInfo: async () => ({
            results: { application: { id: 'a', job: { id: JOB }, currentInterviewStage: { id: AI } } },
          }) as never,
        },
        mappings: { resolveByJobId: async () => ({ status: 'paused', aiScreeningStageId: AI }) },
      },
    );
    expect(result.decision).toBe('mapping_inactive');
  });
});

// ── 6. Bounds preserved under admission ─────────────────────────────────────

describe('admission does not weaken the run bounds', () => {
  const bulk = Array.from({ length: 300 }, (_, i) => row(`app_${i}`, { jobId: JOB, stageId: AI }));

  it('counts SKIPPED rows against the item cap (paging stays bounded)', async () => {
    const res = await runReconciliation({
      client: scriptedLister([{ results: bulk, moreDataAvailable: false }]),
      checkpoints: new FakeCheckpoints(null),
      receipts: new FakeReceipts(),
      mappings: new FakeMappings([]),      // admits nothing
      caps: { maxItems: 100 },
    });
    expect(res.observed).toBe(100);
    expect(res.stop).toBe('item_cap');
    expect(res.advanced).toBe(false);
  });

  it('stops on the page cap regardless of how much was admitted', async () => {
    const res = await runReconciliation({
      client: scriptedLister([
        { results: bulk, moreDataAvailable: true, nextCursor: 'c1' },
        { results: bulk, moreDataAvailable: true, nextCursor: 'c2' },
      ]),
      checkpoints: new FakeCheckpoints(null),
      receipts: new FakeReceipts(),
      mappings: new FakeMappings([{ externalJobId: JOB, aiScreeningStageId: AI }]),
      caps: { maxPages: 1, maxItems: 5_000, maxEnqueuePerRun: 2_000 },
    });
    expect(res.pages).toBe(1);
    expect(res.stop).toBe('page_cap');
    expect(res.advanced).toBe(false);
  });

  it('stops on the deadline regardless of admission', async () => {
    let t = 0;
    const res = await runReconciliation({
      client: scriptedLister([
        { results: bulk, moreDataAvailable: true, nextCursor: 'c1' },
        { results: bulk, moreDataAvailable: true, nextCursor: 'c2' },
      ]),
      checkpoints: new FakeCheckpoints(null),
      receipts: new FakeReceipts(),
      mappings: new FakeMappings([{ externalJobId: JOB, aiScreeningStageId: AI }]),
      caps: { deadlineMs: 1_000, maxItems: 5_000, maxEnqueuePerRun: 2_000 },
      nowMs: () => { t += 2_000; return t; },
    });
    expect(res.stop).toBe('deadline');
    expect(res.advanced).toBe(false);
  });
});

// ── 7. The pure admission primitives ────────────────────────────────────────

describe('buildEnabledStageIndex / admitApplication', () => {
  it('drops rows missing either id and marks conflicts ambiguous', () => {
    const index = buildEnabledStageIndex([
      { externalJobId: 'j1', aiScreeningStageId: 's1' },
      { externalJobId: 'j2', aiScreeningStageId: '' },
      { externalJobId: '', aiScreeningStageId: 's3' },
      { externalJobId: 'j4', aiScreeningStageId: 's4' },
      { externalJobId: 'j4', aiScreeningStageId: 's4' },   // identical → fine
      { externalJobId: 'j5', aiScreeningStageId: 's5' },
      { externalJobId: 'j5', aiScreeningStageId: 's5b' },  // conflict
    ]);
    expect(index.get('j1')).toBe('s1');
    expect(index.has('j2')).toBe(false);
    expect(index.has('')).toBe(false);
    expect(index.get('j4')).toBe('s4');
    expect(index.get('j5')).toBeNull();
  });

  it('returns one concrete reason per declined row', () => {
    const index = buildEnabledStageIndex([
      { externalJobId: 'j1', aiScreeningStageId: 's1' },
      { externalJobId: 'jx', aiScreeningStageId: 'a' },
      { externalJobId: 'jx', aiScreeningStageId: 'b' },
    ]);
    expect(admitApplication({}, index)).toEqual({ admit: false, reason: 'noApplicationId' });
    // Unreadable job/stage fails OPEN — the worker adjudicates authoritatively.
    expect(admitApplication({ applicationId: 'a' }, index))
      .toEqual({ admit: true, classified: false, applicationId: 'a', stageId: undefined });
    expect(admitApplication({ applicationId: 'a', jobId: 'j1' }, index))
      .toEqual({ admit: true, classified: false, applicationId: 'a', stageId: undefined });
    expect(admitApplication({ applicationId: 'a', jobId: 'nope', currentStageId: 's1' }, index))
      .toEqual({ admit: false, reason: 'noEnabledMapping' });
    expect(admitApplication({ applicationId: 'a', jobId: 'j1', currentStageId: 'other' }, index))
      .toEqual({ admit: false, reason: 'stageNotAi' });
    expect(admitApplication({ applicationId: 'a', jobId: 'jx', currentStageId: 'a' }, index))
      .toEqual({ admit: false, reason: 'ambiguousMapping' });
    expect(admitApplication({ applicationId: 'a', jobId: 'j1', currentStageId: 's1' }, index))
      .toEqual({ admit: true, classified: true, applicationId: 'a', jobId: 'j1', stageId: 's1' });
  });
});

// ── 8. Circuit breaker + schema-drift abort (review §3.4, §3.1) ─────────────

describe('per-run enqueue circuit breaker', () => {
  it('stops at maxEnqueuePerRun without advancing the checkpoint', async () => {
    const receipts = new FakeReceipts();
    const checkpoints = new FakeCheckpoints(null);
    const many = Array.from({ length: 500 }, (_, i) => row(`app_${i}`, { jobId: JOB, stageId: AI }));
    const res = await runReconciliation({
      client: scriptedLister([{ results: many, moreDataAvailable: false, syncToken: 'tok' }]),
      checkpoints, receipts,
      mappings: new FakeMappings([{ externalJobId: JOB, aiScreeningStageId: AI }]),
      caps: { maxItems: 5_000, maxEnqueuePerRun: 25 },
    });
    expect(res.stop).toBe('enqueue_cap');
    expect(res.enqueued).toBe(25);
    // The cap is a true ceiling on durable work, not an after-the-fact report.
    expect(receipts.liveJobs.size).toBe(25);
    expect(res.advanced).toBe(false);
    expect(checkpoints.advances).toHaveLength(0);
  });

  it('defaults to a small breaker so an admission bug cannot flood the queue', async () => {
    const receipts = new FakeReceipts();
    const many = Array.from({ length: 2_000 }, (_, i) => row(`app_${i}`, { jobId: JOB, stageId: AI }));
    const res = await runReconciliation({
      client: scriptedLister([{ results: many, moreDataAvailable: false }]),
      checkpoints: new FakeCheckpoints(null),
      receipts,
      mappings: new FakeMappings([{ externalJobId: JOB, aiScreeningStageId: AI }]),
      caps: { maxItems: 5_000 },
    });
    expect(res.stop).toBe('enqueue_cap');
    expect(res.enqueued).toBe(DEFAULT_MAX_ENQUEUE_PER_RUN);
    expect(res.advanced).toBe(false);
  });
});

describe('unclassifiable rows fail OPEN but bounded', () => {
  /** Rows carrying an application id only — the provider list shape drifted. */
  const drifted = Array.from({ length: 200 }, (_, i) => row(`app_${i}`));

  it('admits a small number of unclassified rows rather than dropping real work', async () => {
    const receipts = new FakeReceipts();
    const res = await runReconciliation({
      client: scriptedLister([{ results: drifted.slice(0, 5), moreDataAvailable: false, syncToken: 'tok' }]),
      checkpoints: new FakeCheckpoints(null),
      receipts,
      mappings: new FakeMappings([{ externalJobId: JOB, aiScreeningStageId: AI }]),
    });
    expect(res.unclassified).toBe(5);
    expect(res.admitted).toBe(5);
    expect(receipts.liveJobs.size).toBe(5);
    expect(res.stop).toBe('drained');
  });

  it('aborts without advancing and flags the stream when drift exceeds the bound', async () => {
    const checkpoints = new FakeCheckpoints(null);
    const res = await runReconciliation({
      client: scriptedLister([{ results: drifted, moreDataAvailable: false, syncToken: 'tok' }]),
      checkpoints,
      receipts: new FakeReceipts(),
      mappings: new FakeMappings([{ externalJobId: JOB, aiScreeningStageId: AI }]),
      caps: { maxItems: 5_000, maxUnclassified: 10, maxEnqueuePerRun: 2_000 },
    });
    expect(res.stop).toBe('unclassified_cap');
    expect(res.advanced).toBe(false);
    expect(checkpoints.advances).toHaveLength(0);
    // Loud: the stream is flagged with a sanitized reason for the operator.
    expect(checkpoints.resyncs).toEqual([UNCLASSIFIED_RESYNC_REASON]);
  });

  it('a well-formed corpus never trips the drift abort', async () => {
    const res = await runReconciliation({
      client: scriptedLister([{
        results: Array.from({ length: 300 }, (_, i) => row(`app_${i}`, { jobId: 'job_paused', stageId: AI })),
        moreDataAvailable: false, syncToken: 'tok',
      }]),
      checkpoints: new FakeCheckpoints(null),
      receipts: new FakeReceipts(),
      mappings: new FakeMappings([]),
      caps: { maxItems: 5_000 },
    });
    expect(res.unclassified).toBe(0);
    expect(res.stop).toBe('drained');
    expect(res.advanced).toBe(true);
  });
});

// ── 9. Counter accounting is exact and stated ───────────────────────────────

describe('counter accounting', () => {
  it('observed === admitted + sum(skipped) on every non-aborted run', async () => {
    const mixed = [
      row('a', { jobId: JOB, stageId: AI }),                 // admit
      row('b', { jobId: JOB, stageId: 'other' }),            // stageNotAi
      row('c', { jobId: 'nope', stageId: AI }),              // noEnabledMapping
      row('d'),                                              // unclassified (admit)
      { application: {} } as OpaqueRecord,                    // noApplicationId
    ];
    const res = await runReconciliation({
      client: scriptedLister([{ results: mixed, moreDataAvailable: false, syncToken: 't' }]),
      checkpoints: new FakeCheckpoints(null),
      receipts: new FakeReceipts(),
      mappings: new FakeMappings([{ externalJobId: JOB, aiScreeningStageId: AI }]),
    });
    const skips = Object.values(res.skipped).reduce((a, b) => a + b, 0);
    expect(res.stop).toBe('drained');
    expect(res.admitted + skips).toBe(res.observed);
    expect(res.admitted).toBe(2);       // exact match + unclassified
    expect(res.unclassified).toBe(1);
  });

  it('on an aborted run the tripping row is observed but neither admitted nor skipped', async () => {
    const drifted = Array.from({ length: 20 }, (_, i) => row(`app_${i}`));
    const res = await runReconciliation({
      client: scriptedLister([{ results: drifted, moreDataAvailable: false }]),
      checkpoints: new FakeCheckpoints(null),
      receipts: new FakeReceipts(),
      mappings: new FakeMappings([]),
      caps: { maxUnclassified: 5 },
    });
    const skips = Object.values(res.skipped).reduce((a, b) => a + b, 0);
    expect(res.stop).toBe('unclassified_cap');
    // 5 admitted fail-open, the 6th tripped the bound and stopped the run.
    expect(res.admitted).toBe(5);
    expect(res.unclassified).toBe(6);
    expect(res.observed).toBe(6);
    expect(res.admitted + skips).toBe(res.observed - 1);
    expect(res.advanced).toBe(false);   // the tripping row is reconsidered next pass
  });
});

// ── 10. The counts reach a real consumer (review M-1) ───────────────────────

describe('reconcile-pass publication to the health registry', () => {
  beforeEach(() => { clearReconcilePassRegistration(); });
  afterEach(() => { clearReconcilePassRegistration(); });

  it('publishes a sanitized, self-consistent pass that the health route can read', () => {
    expect(snapshotReconcilePass()).toBeNull();
    publishReconcilePass({
      stop: 'drained', mode: 'full',
      observed: 2_000, admitted: 0,
      skipped: { noApplicationId: 0, noEnabledMapping: 2_000, stageNotAi: 0, ambiguousMapping: 0 },
      unclassified: 0, enabledMappings: 0, mappingIndexTruncated: false,
      recovered: 0, duplicates: 0, enqueued: 0, advanced: true,
    }, '2026-08-18T00:00:00.000Z');

    const view = snapshotReconcilePass();
    expect(view).not.toBeNull();
    // The exact re-activation gate: paused tenant ⇒ nothing admitted or queued.
    expect(view?.admitted).toBe(0);
    expect(view?.enqueued).toBe(0);
    expect(view?.observed).toBe(2_000);
    expect(view?.observedAt).toBe('2026-08-18T00:00:00.000Z');
  });

  it('bounds every published field defensively — no unexpected value can reach the surface', () => {
    publishReconcilePass({
      // Hostile input the caller should never produce, but must not propagate.
      stop: 'drained; DROP TABLE', mode: 'FULL-mode',
      observed: -5, admitted: Number.NaN,
      skipped: { noApplicationId: -1, noEnabledMapping: 1.9, stageNotAi: Infinity, ambiguousMapping: 3 },
      unclassified: -0.5, enabledMappings: Number.NaN, mappingIndexTruncated: 'yes' as unknown as boolean,
      recovered: -2, duplicates: 4, enqueued: -9, advanced: 1 as unknown as boolean,
    }, '2026-08-18T00:00:00.000Z');

    const view = snapshotReconcilePass();
    expect(view?.stop).toBe('unknown');            // not a safe code ⇒ 'unknown'
    expect(view?.mode).toBe('unknown');
    expect(view?.observed).toBe(0);                // negatives floor to 0
    expect(view?.admitted).toBe(0);                // NaN floors to 0
    expect(view?.skipped.noEnabledMapping).toBe(1); // truncated, not rounded
    expect(view?.skipped.stageNotAi).toBe(0);      // Infinity floors to 0
    expect(view?.skipped.ambiguousMapping).toBe(3);
    expect(view?.enqueued).toBe(0);
    // Non-boolean truthiness is never accepted as true.
    expect(view?.mappingIndexTruncated).toBe(false);
    expect(view?.advanced).toBe(false);
  });
});
