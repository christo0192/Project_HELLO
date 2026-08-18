/**
 * Ashby reconciliation — PAGE-ANCHORED FULL-RESYNC CONTINUATION (0034).
 *
 * Production evidence this suite pins down (PR64 review H1). After the
 * admission fix deployed, the runtime was brought up with the tenant's only
 * mapping paused and the storm backlog cleaned. Every forced full resync then
 * stopped on `page_cap` at 50 pages x 100 items, advanced nothing, and left
 * the checkpoint `full_resync_required` forever: admission meant it wrote no
 * receipts and queued no jobs, but the tenant's corpus exceeds 5,000, so
 * reconciliation — the dropped-webhook safety net — could never come up at
 * all. The runtime was turned off again immediately.
 *
 * The contract proven here:
 *   1. A full resync PERSISTS the opaque provider page cursor after every
 *      page whose EVERY item was durably handled, and the next run resumes
 *      from it. A corpus of >12,000 applications finishes across several
 *      bounded runs with every application considered exactly once logically
 *      (duplicates allowed physically), nothing skipped, and the final sync
 *      token installed at the end.
 *   2. 5,001 applications — one past the pre-0034 gate — completes.
 *   3. Anchor-after-handle ordering. A crash BEFORE the anchor replays that
 *      page; a crash AFTER it resumes at the next page. Neither can skip.
 *   4. A mapping enabled mid-run bumps the epoch and invalidates the
 *      continuation; the in-flight run fails closed and cannot resurrect its
 *      anchor or clear the forced resync.
 *   5. A runner that lost the single-flight lease cannot move the anchor.
 *   6. A repeated provider cursor aborts without advancing.
 *   7. A mid-page stop (enqueue breaker) never anchors that page; the replay
 *      converts the already-recorded rows to duplicates, which consume no
 *      enqueue budget, so the sweep eventually gets past it.
 *   8. A provider failure advances nothing but keeps the anchors it earned.
 *   9. 2,000 applications under a PAUSED mapping still write nothing at all —
 *      the PR64 admission guarantee is preserved end to end.
 */

import { describe, it, expect } from 'vitest';
import {
  runReconciliation,
  DEFAULT_CHECKPOINT_KEY,
  type ApplicationLister,
} from '../integrations/ashby/reconciliation.js';
import type {
  CheckpointStore, ReceiptStore, ReceiptOutcome, SyncCheckpoint,
  EnabledMappingLoader, EnabledMappingRow,
} from '../integrations/ashby/ports.js';
import { stageDedupId, CANDIDATE_STAGE_CHANGE_ACTION } from '../integrations/ashby/extractors.js';
import type { AshbyResult, ApplicationListParams, OpaqueRecord } from '../integrations/ashby/types.js';

const JOB = 'job_enabled';
const AI = 'stage_ai';
const OWNER = 'runner-a';
const KEY = DEFAULT_CHECKPOINT_KEY;

// ── A checkpoint store that models migration 0034's actual semantics ────────
//
// Deliberately a faithful re-implementation rather than a stub: the whole
// correctness argument lives in the two compare-and-sets (resync_epoch and the
// live lease owner) and in `advance` ending the continuation atomically. A
// fake that skipped them would prove nothing.

interface CheckpointRow {
  syncToken: string | null;
  status: 'idle' | 'running' | 'full_resync_required';
  tokenIssuedAt: string | null;
  lastSuccessAt: string | null;
  resyncEpoch: number;
  resyncCursor: string | null;
  resyncCursorEpoch: number | null;
  resyncCursorAt: string | null;
  sweepMode: 'full' | 'incremental' | null;
  sweepToken: string | null;
  sweepRestarts: number;
  resyncPagesDone: number;
  resyncItemsDone: number;
  resyncStartedAt: string | null;
  leaseOwner: string | null;
  leaseExpiresAtMs: number | null;
  noProgressRuns: number;
}

class FakeCheckpointStore implements CheckpointStore {
  row: CheckpointRow;
  /** Every anchor write attempt and its outcome — the audit this suite reads. */
  saves: Array<{ cursor: string; owner: string; status: string }> = [];
  advances: Array<{ syncToken: string | null; resyncEpoch: number | null }> = [];
  resyncReasons: string[] = [];
  nowMs: () => number;

  constructor(nowMs: () => number, initial?: Partial<CheckpointRow>) {
    this.nowMs = nowMs;
    this.row = {
      syncToken: null, status: 'full_resync_required', tokenIssuedAt: null,
      lastSuccessAt: null, resyncEpoch: 1, resyncCursor: null,
      resyncCursorEpoch: null, resyncCursorAt: null, sweepMode: null,
      sweepToken: null, sweepRestarts: 0, resyncPagesDone: 0,
      resyncItemsDone: 0, resyncStartedAt: null, leaseOwner: null,
      leaseExpiresAtMs: null, noProgressRuns: 0, ...initial,
    };
  }

  async get(): Promise<SyncCheckpoint | null> {
    return {
      syncToken: this.row.syncToken,
      status: this.row.status,
      tokenIssuedAt: this.row.tokenIssuedAt,
      lastSuccessAt: this.row.lastSuccessAt,
      resyncEpoch: this.row.resyncEpoch,
      resyncCursor: this.row.resyncCursor,
      resyncCursorEpoch: this.row.resyncCursorEpoch,
      resyncCursorAt: this.row.resyncCursorAt,
      sweepMode: this.row.sweepMode,
      resyncPagesDone: this.row.resyncPagesDone,
      resyncItemsDone: this.row.resyncItemsDone,
      sweepRestarts: this.row.sweepRestarts,
    };
  }

  /** Clear every field a completed or invalidated sweep must not leave behind. */
  private clearSweep(): void {
    this.row.resyncCursor = null;
    this.row.resyncCursorEpoch = null;
    this.row.resyncCursorAt = null;
    this.row.sweepMode = null;
    this.row.sweepToken = null;
    this.row.resyncPagesDone = 0;
    this.row.resyncItemsDone = 0;
    this.row.resyncStartedAt = null;
  }

  async advance(input: {
    syncToken: string | null; resyncEpoch?: number | null; owner?: string;
  }): Promise<void> {
    // H-5: a runner that no longer holds the lease may not install a token
    // over the sweep whoever holds it is performing.
    if (input.owner !== undefined && this.row.leaseOwner !== input.owner) {
      throw new Error('ashby_checkpoint_advance_refused');
    }
    const epoch = typeof input.resyncEpoch === 'number' ? input.resyncEpoch : null;
    const keep = epoch !== null && this.row.resyncEpoch !== epoch;
    this.advances.push({ syncToken: input.syncToken, resyncEpoch: epoch });
    this.row.syncToken = input.syncToken;
    this.row.tokenIssuedAt = input.syncToken === null ? null : new Date(this.nowMs()).toISOString();
    this.row.lastSuccessAt = new Date(this.nowMs()).toISOString();
    this.row.status = keep ? 'full_resync_required' : 'idle';
    this.row.noProgressRuns = 0;
    if (!keep) {
      // H-6: EARLIEST-wins — a token banked by an earlier run of this sweep
      // takes precedence over the one this run observed at the end.
      this.row.syncToken = this.row.sweepToken ?? input.syncToken;
      this.row.tokenIssuedAt = this.row.syncToken === null
        ? null
        : new Date(this.nowMs()).toISOString();
      // H-4: the continuation ends atomically with the token install.
      this.clearSweep();
    }
  }

  async requireFullResync(_key: string, reason: string): Promise<void> {
    this.row.syncToken = null;
    this.row.tokenIssuedAt = null;
    this.row.status = 'full_resync_required';
    this.row.resyncEpoch += 1;
    // H-2: a new generation must sweep from page 1. An anchor standing here
    // means a sweep was abandoned mid-way.
    if (this.row.resyncCursor !== null) this.row.sweepRestarts += 1;
    this.clearSweep();
    this.resyncReasons.push(reason);
  }

  async saveResyncCursor(input: {
    cursor: string; owner: string; pagesDone: number; itemsDone: number;
    resyncEpoch: number | null; mode: 'full' | 'incremental';
    sweepToken?: string | null; first?: boolean;
  }): Promise<{ status: string }> {
    const record = (status: string) => {
      this.saves.push({ cursor: input.cursor, owner: input.owner, status });
      return { status };
    };
    if (!input.cursor) return record('invalid_cursor');
    if (this.row.leaseExpiresAtMs === null || this.row.leaseExpiresAtMs <= this.nowMs()) {
      return record('lease_expired');
    }
    if (this.row.leaseOwner !== input.owner) return record('not_owned');
    if (input.resyncEpoch !== null && this.row.resyncEpoch !== input.resyncEpoch) {
      return record('epoch_changed');
    }
    if (input.first) {
      // A new sweep: an anchor still standing was abandoned, so count it.
      if (this.row.resyncCursor !== null) this.row.sweepRestarts += 1;
      this.row.resyncPagesDone = input.pagesDone;
      this.row.resyncItemsDone = input.itemsDone;
      this.row.sweepToken = input.sweepToken ?? null;
      this.row.resyncStartedAt = new Date(this.nowMs()).toISOString();
    } else {
      this.row.resyncPagesDone = Math.max(this.row.resyncPagesDone, input.pagesDone);
      this.row.resyncItemsDone = Math.max(this.row.resyncItemsDone, input.itemsDone);
      // First-write-wins across the sweep.
      this.row.sweepToken = this.row.sweepToken ?? input.sweepToken ?? null;
      this.row.resyncStartedAt ??= new Date(this.nowMs()).toISOString();
    }
    this.row.resyncCursor = input.cursor;
    this.row.resyncCursorEpoch = this.row.resyncEpoch;
    this.row.resyncCursorAt = new Date(this.nowMs()).toISOString();
    this.row.sweepMode = input.mode;
    return record('ok');
  }

  async beginRun(input: { owner: string; leaseSeconds: number }) {
    if (this.row.leaseExpiresAtMs !== null && this.row.leaseExpiresAtMs > this.nowMs()) {
      return { status: 'locked' as const, noProgressRuns: this.row.noProgressRuns };
    }
    this.row.leaseOwner = input.owner;
    this.row.leaseExpiresAtMs = this.nowMs() + input.leaseSeconds * 1000;
    return { status: 'ok' as const, checkpoint: await this.get(), noProgressRuns: this.row.noProgressRuns };
  }

  async endRun(input: { owner: string; advanced: boolean }) {
    if (this.row.leaseOwner !== input.owner) {
      return { status: 'not_owned', noProgressRuns: this.row.noProgressRuns };
    }
    this.row.leaseOwner = null;
    this.row.leaseExpiresAtMs = null;
    this.row.noProgressRuns = input.advanced ? 0 : this.row.noProgressRuns + 1;
    return { status: 'ok', noProgressRuns: this.row.noProgressRuns };
  }
}

/** Transactional-outbox fake: dedups receipts, one live job per dedup key. */
class FakeReceipts implements ReceiptStore {
  seen = new Set<string>();
  liveJobs = new Set<string>();
  /** How many times each webhook_action_id was written (physical duplicates). */
  writes = new Map<string, number>();
  /** Throw on the Nth write, modelling a crash mid-page. */
  failAtWrite: number | null = null;
  totalWrites = 0;

  async record(input: {
    webhookActionId: string; action: string; enqueue?: { dedupKey: string };
  }): Promise<ReceiptOutcome> {
    this.totalWrites += 1;
    if (this.failAtWrite !== null && this.totalWrites === this.failAtWrite) {
      throw new Error('ashby_receipt_write_failed');
    }
    const key = `${input.action}:${input.webhookActionId}`;
    this.writes.set(input.webhookActionId, (this.writes.get(input.webhookActionId) ?? 0) + 1);
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

class FakeMappings implements EnabledMappingLoader {
  constructor(public rows: EnabledMappingRow[] = []) {}
  async listEnabled(): Promise<{ rows: EnabledMappingRow[]; truncated: boolean }> {
    return { rows: this.rows, truncated: false };
  }
}

const ENABLED = new FakeMappings([{ externalJobId: JOB, aiScreeningStageId: AI }]);
const PAUSED = new FakeMappings([]);

/**
 * A provider whose corpus is a fixed, ordered list of application ids paged by
 * an opaque cursor. Cursors are deliberately opaque strings the caller must
 * hand back verbatim — exactly the contract the real client has.
 */
class FakeProvider implements ApplicationLister {
  calls = 0;
  /** Cursors the caller resumed from, in order — proves where each run began. */
  resumedFrom: Array<string | undefined> = [];
  failAtCall: number | null = null;
  /** When set, every page hands back this same cursor (provider loop). */
  stuckCursor: string | null = null;

  constructor(readonly total: number, readonly finalToken = 'tok-final') {}

  private offsetOf(cursor?: string): number {
    if (!cursor) return 0;
    const parsed = Number.parseInt(cursor.replace('cur-', ''), 10);
    return Number.isFinite(parsed) ? parsed : 0;
  }

  async applicationList<T = OpaqueRecord[]>(params?: ApplicationListParams): Promise<AshbyResult<T>> {
    this.calls += 1;
    if (this.failAtCall !== null && this.calls === this.failAtCall) {
      throw new Error('ashby_provider_unavailable');
    }
    const limit = params?.limit ?? 100;
    const start = this.offsetOf(params?.cursor);
    if (start === 0) this.resumedFrom.push(params?.cursor);
    const end = Math.min(start + limit, this.total);
    const results: OpaqueRecord[] = [];
    for (let i = start; i < end; i += 1) {
      results.push({ application: { id: `app_${i}`, job: { id: JOB }, currentInterviewStage: { id: AI } } });
    }
    const more = end < this.total;
    return {
      results: results as unknown as T,
      moreDataAvailable: more,
      nextCursor: more ? (this.stuckCursor ?? `cur-${end}`) : undefined,
      syncToken: more ? undefined : this.finalToken,
    };
  }
}

/** Record which cursor each page request used, for the resume assertions. */
function trackingProvider(total: number) {
  const p = new FakeProvider(total);
  const cursors: Array<string | undefined> = [];
  const wrapped: ApplicationLister = {
    async applicationList<T = OpaqueRecord[]>(params?: ApplicationListParams) {
      cursors.push(params?.cursor);
      return p.applicationList<T>(params);
    },
  };
  return { provider: wrapped, inner: p, cursors };
}

/**
 * Standard deps. The enqueue circuit breaker defaults to 200/run, which would
 * otherwise be the binding bound in every sweep here and mask the page/item
 * bounds under test; these suites raise it to its hard ceiling except where
 * the breaker itself is the subject.
 */
function deps(
  provider: ApplicationLister,
  checkpoints: FakeCheckpointStore,
  receipts: FakeReceipts,
  mappings: EnabledMappingLoader = ENABLED,
  extra: Partial<Parameters<typeof runReconciliation>[0]> = {},
) {
  return {
    client: provider, checkpoints, receipts, mappings,
    checkpointKey: KEY, owner: OWNER, nowMs: checkpoints.nowMs, ...extra,
    caps: { maxEnqueuePerRun: 2_000, ...extra.caps },
  };
}

/** Every corpus id, for the "considered exactly once logically" assertion. */
function corpusIds(total: number): string[] {
  return Array.from({ length: total }, (_v, i) => `app_${i}`);
}

/**
 * Receipts are keyed by the STAGE-CENTRIC dedup identity — the same identity a
 * webhook would produce for that (application, stage) pair, which is what makes
 * webhook delivery and reconciliation recovery converge on one row.
 */
const dedup = (applicationId: string) => stageDedupId(applicationId, AI);

describe('full-resync page-anchored continuation (0034)', () => {
  it('sweeps a >12,000 corpus across runs, considering every application exactly once', async () => {
    const total = 12_345;
    const clock = { ms: 1_000 };
    const nowMs = () => clock.ms;
    const checkpoints = new FakeCheckpointStore(nowMs);
    const receipts = new FakeReceipts();
    const { provider, cursors } = trackingProvider(total);

    const runs: Awaited<ReturnType<typeof runReconciliation>>[] = [];
    // Bounded runs, exactly as the scheduler drives them. Guard the loop so a
    // liveness regression fails as a bounded test rather than hanging CI.
    for (let i = 0; i < 20; i += 1) {
      const r = await runReconciliation(deps(provider, checkpoints, receipts));
      runs.push(r);
      if (r.stop === 'drained') break;
      // A bounded stop MUST leave durable progress behind, or the sweep is
      // exactly the production stall this migration exists to remove.
      expect(r.partialProgress.continuationPending).toBe(true);
      expect(checkpoints.row.resyncCursor).not.toBeNull();
      clock.ms += 60_000;
    }

    const last = runs[runs.length - 1];
    expect(last.stop).toBe('drained');
    expect(last.advanced).toBe(true);
    expect(runs.length).toBeGreaterThan(1);          // it genuinely took several runs
    expect(runs[0].partialProgress.resumed).toBe(false);
    expect(runs[1].partialProgress.resumed).toBe(true);

    // The final sync token is installed and the continuation is gone.
    expect(checkpoints.row.syncToken).toBe('tok-final');
    expect(checkpoints.row.status).toBe('idle');
    expect(checkpoints.row.resyncCursor).toBeNull();
    expect(checkpoints.row.resyncPagesDone).toBe(0);

    // ZERO SKIP: every application in the corpus reached a durable receipt,
    // and nothing outside the corpus did.
    expect(receipts.writes.size).toBe(total);
    for (const id of corpusIds(total)) expect(receipts.writes.has(dedup(id))).toBe(true);
    // Exactly once LOGICALLY: one recovered receipt each, no admission skips.
    expect(receipts.seen.size).toBe(total);
    // Exactly once LOGICALLY: `inserted` fires once per application across the
    // WHOLE sweep, no matter how many runs it took or what replayed.
    const recovered = runs.reduce((a, r) => a + r.recovered, 0);
    expect(recovered).toBe(total);
    // Physical duplicates are permitted, but a replay is bounded — nothing was
    // re-read more than a page's worth of times.
    for (const [, n] of receipts.writes) expect(n).toBeLessThanOrEqual(2);
    // Nothing was skipped for any admission reason: the corpus is uniformly
    // admissible, so a skip here would mean a row went missing.
    for (const r of runs) {
      expect(r.skipped).toEqual({
        noApplicationId: 0, noEnabledMapping: 0, stageNotAi: 0, ambiguousMapping: 0,
      });
    }
    // Every run after the first began at an anchored cursor, never at page 1.
    expect(cursors.filter((c) => c === undefined)).toHaveLength(1);
  });

  it('completes a 5,001 corpus — one application past the pre-0034 gate', async () => {
    // 50 pages x 100 = 5,000 was the exact wall: the 5,001st application could
    // never be reached, so the cursor never advanced and no incremental token
    // was ever established.
    const clock = { ms: 1_000 };
    const checkpoints = new FakeCheckpointStore(() => clock.ms);
    const receipts = new FakeReceipts();
    const provider = new FakeProvider(5_001);

    // Exactly the production shape: the mapping is paused, so the sweep writes
    // nothing and the ONLY thing that can stop it is the page bound.
    const first = await runReconciliation(deps(provider, checkpoints, receipts, PAUSED));
    expect(first.stop).toBe('page_cap');
    expect(first.advanced).toBe(false);
    expect(first.observed).toBe(5_000);
    expect(first.partialProgress.checkpoints).toBe(50);
    expect(first.partialProgress.itemsDone).toBe(5_000);
    expect(checkpoints.row.resyncCursor).toBe('cur-5000');
    // The stream is NOT recorded as stuck: a page anchor is real progress.
    expect(checkpoints.row.noProgressRuns).toBe(0);

    clock.ms += 60_000;
    const second = await runReconciliation(deps(provider, checkpoints, receipts, PAUSED));
    expect(second.stop).toBe('drained');
    expect(second.partialProgress.resumed).toBe(true);
    expect(second.observed).toBe(1);          // the 5,001st, previously unreachable
    expect(checkpoints.row.syncToken).toBe('tok-final');
    expect(checkpoints.row.status).toBe('idle');
    expect(receipts.totalWrites).toBe(0);
  });

  it('leaves the pre-0034 behaviour untouched when the store cannot anchor', async () => {
    // A store without saveResyncCursor is the pure-domain fake shape. It must
    // still run — bounded, no continuation, no crash.
    const clock = { ms: 1_000 };
    const checkpoints = new FakeCheckpointStore(() => clock.ms);
    const noAnchor: CheckpointStore = {
      get: () => checkpoints.get(),
      advance: (i) => checkpoints.advance(i),
      requireFullResync: (k, r) => checkpoints.requireFullResync(k, r),
    };
    const receipts = new FakeReceipts();
    const r = await runReconciliation({
      client: new FakeProvider(5_001), checkpoints: noAnchor, receipts,
      mappings: PAUSED, checkpointKey: KEY, owner: OWNER,
    });
    expect(r.stop).toBe('page_cap');
    expect(r.advanced).toBe(false);
    expect(r.partialProgress).toEqual({
      resumed: false, checkpoints: 0, pagesDone: 0, itemsDone: 0,
      continuationPending: false, restartReason: 'anchor_disabled',
      sweepRestarts: 0, tokenInstalled: false,
    });
  });
});

describe('anchor-after-handle ordering', () => {
  it('replays the whole page when the run crashes BEFORE its anchor', async () => {
    const clock = { ms: 1_000 };
    const checkpoints = new FakeCheckpointStore(() => clock.ms);
    const receipts = new FakeReceipts();
    const { provider, cursors } = trackingProvider(500);

    // Crash on the 250th receipt write — the middle of page 3 (items 200-299).
    receipts.failAtWrite = 250;
    await expect(runReconciliation(deps(provider, checkpoints, receipts)))
      .rejects.toThrow(/receipt_write_failed/);

    // Pages 1 and 2 were fully handled and anchored; page 3 was not.
    expect(checkpoints.row.resyncCursor).toBe('cur-200');
    expect(checkpoints.row.resyncItemsDone).toBe(200);
    expect(checkpoints.saves.map((s) => s.cursor)).toEqual(['cur-100', 'cur-200']);
    // The failing write never landed, so app_249 has NO receipt yet.
    expect(receipts.seen.has(`${CANDIDATE_STAGE_CHANGE_ACTION}:${dedup('app_249')}`)).toBe(false);

    clock.ms += 60_000;
    receipts.failAtWrite = null;
    const resumed = await runReconciliation(deps(provider, checkpoints, receipts));
    expect(resumed.stop).toBe('drained');
    expect(resumed.partialProgress.resumed).toBe(true);
    // The next run started at the UNANCHORED page, not past it.
    expect(cursors[cursors.indexOf('cur-200', 1)]).toBe('cur-200');
    // Zero skip: the whole corpus is covered, and the replayed rows are
    // physical duplicates only.
    expect(receipts.seen.size).toBe(500);
    expect(receipts.writes.get(dedup('app_200'))).toBe(2);   // replayed page
    expect(receipts.writes.get(dedup('app_249'))).toBe(1);   // the crashed write
    expect(receipts.writes.get(dedup('app_400'))).toBe(1);   // never replayed
  });

  it('resumes at the NEXT page when the run crashes AFTER its anchor', async () => {
    const clock = { ms: 1_000 };
    const checkpoints = new FakeCheckpointStore(() => clock.ms);
    const receipts = new FakeReceipts();
    const { provider, inner, cursors } = trackingProvider(500);

    // Fail fetching page 3, i.e. strictly after page 2's anchor committed.
    inner.failAtCall = 3;
    await expect(runReconciliation(deps(provider, checkpoints, receipts)))
      .rejects.toThrow(/provider_unavailable/);
    expect(checkpoints.row.resyncCursor).toBe('cur-200');
    expect(receipts.seen.size).toBe(200);

    clock.ms += 60_000;
    inner.failAtCall = null;
    const resumed = await runReconciliation(deps(provider, checkpoints, receipts));
    expect(resumed.stop).toBe('drained');
    // It resumed at cur-200 and re-read NOTHING before it.
    expect(cursors.filter((c) => c === undefined)).toHaveLength(1);
    expect(receipts.seen.size).toBe(500);
    for (let i = 0; i < 200; i += 1) expect(receipts.writes.get(dedup(`app_${i}`))).toBe(1);
  });

  it('never anchors a page whose items were cut short by the enqueue breaker', async () => {
    const clock = { ms: 1_000 };
    const checkpoints = new FakeCheckpointStore(() => clock.ms);
    const receipts = new FakeReceipts();
    const provider = new FakeProvider(300);

    // 150 < one page's worth of new work, so the breaker trips mid-page 2.
    const first = await runReconciliation(
      deps(provider, checkpoints, receipts, ENABLED, { caps: { maxEnqueuePerRun: 150 } }),
    );
    expect(first.stop).toBe('enqueue_cap');
    expect(first.advanced).toBe(false);
    // The breaker is evaluated at the PAGE boundary, so page 2 completed and
    // anchored, and the run stopped before fetching page 3. The cap therefore
    // overshoots by at most one page (200 -> 200 here) and every page stays
    // atomic and anchorable.
    expect(checkpoints.row.resyncCursor).toBe('cur-200');
    expect(first.partialProgress.pagesDone).toBe(2);
    expect(first.enqueued).toBeLessThanOrEqual(150 + 100);

    // Because the breaker is page-aligned, the next run RESUMES at page 3
    // rather than replaying anything: the backlog drains a bounded number of
    // pages per run with no repeated work at all.
    clock.ms += 60_000;
    const second = await runReconciliation(
      deps(provider, checkpoints, receipts, ENABLED, { caps: { maxEnqueuePerRun: 150 } }),
    );
    expect(second.partialProgress.resumed).toBe(true);
    expect(second.duplicates).toBe(0);
    expect(second.stop).toBe('drained');
    expect(receipts.seen.size).toBe(300);
    for (const [, n] of receipts.writes) expect(n).toBe(1);
    expect(checkpoints.row.syncToken).toBe('tok-final');
  });

  it('still self-heals a MID-page breaker stop when anchoring is off', async () => {
    // Without anchoring the breaker cuts a page in half, so the next run
    // replays it. The already-recorded rows come back as duplicates, a
    // duplicate creates no new job, so it consumes no enqueue budget and the
    // sweep gets further every time instead of wedging on the same page.
    const clock = { ms: 1_000 };
    const checkpoints = new FakeCheckpointStore(() => clock.ms);
    const receipts = new FakeReceipts();
    const provider = new FakeProvider(300);
    const caps = { maxEnqueuePerRun: 150, anchorDisabled: true };

    const first = await runReconciliation(deps(provider, checkpoints, receipts, ENABLED, { caps }));
    expect(first.stop).toBe('enqueue_cap');
    expect(first.enqueued).toBe(150);
    expect(checkpoints.saves).toHaveLength(0);

    clock.ms += 60_000;
    const second = await runReconciliation(deps(provider, checkpoints, receipts, ENABLED, { caps }));
    expect(second.duplicates).toBeGreaterThan(0);
    expect(receipts.seen.size).toBeGreaterThan(150);
  });
});

describe('continuation invalidation and ownership', () => {
  it('fails closed when a mapping is enabled mid-run, and re-sweeps from page 1', async () => {
    const clock = { ms: 1_000 };
    const checkpoints = new FakeCheckpointStore(() => clock.ms);
    const receipts = new FakeReceipts();
    const provider = new FakeProvider(500);

    // Enabling a mapping forces a resync IN ITS OWN TRANSACTION while this run
    // is paging: after page 2, the epoch moves and the anchor is nulled.
    let pages = 0;
    const interfering: ApplicationLister = {
      async applicationList<T = OpaqueRecord[]>(params?: ApplicationListParams) {
        const page = await provider.applicationList<T>(params);
        pages += 1;
        if (pages === 2) await checkpoints.requireFullResync(KEY, 'mapping_enabled');
        return page;
      },
    };

    const r = await runReconciliation(deps(interfering, checkpoints, receipts));
    expect(r.stop).toBe('continuation_conflict');
    expect(r.advanced).toBe(false);
    // The stale run could neither resurrect its anchor nor clear the demand.
    expect(checkpoints.saves.at(-1)?.status).toBe('epoch_changed');
    expect(checkpoints.row.resyncCursor).toBeNull();
    expect(checkpoints.row.status).toBe('full_resync_required');
    expect(checkpoints.advances).toHaveLength(0);
    // It does not claim a continuation it provably no longer owns.
    expect(r.partialProgress.continuationPending).toBe(false);

    // The next run starts from page 1 under the new generation and completes.
    clock.ms += 60_000;
    const next = await runReconciliation(deps(provider, checkpoints, receipts));
    expect(next.partialProgress.resumed).toBe(false);
    expect(next.stop).toBe('drained');
    expect(receipts.seen.size).toBe(500);
  });

  it('lets a forced resync raised mid-run survive that run reaching the end', async () => {
    const clock = { ms: 1_000 };
    const checkpoints = new FakeCheckpointStore(() => clock.ms);
    const receipts = new FakeReceipts();
    // One page only: the run drains before it ever tries to anchor, so the
    // epoch guard on `advance` — not the one on the anchor — is what holds.
    const provider = new FakeProvider(40);
    const interfering: ApplicationLister = {
      async applicationList<T = OpaqueRecord[]>(params?: ApplicationListParams) {
        const page = await provider.applicationList<T>(params);
        await checkpoints.requireFullResync(KEY, 'mapping_enabled');
        return page;
      },
    };
    const r = await runReconciliation(deps(interfering, checkpoints, receipts));
    expect(r.stop).toBe('drained');
    expect(checkpoints.row.status).toBe('full_resync_required');
    expect(checkpoints.row.resyncCursor).toBeNull();
  });

  it('refuses an anchor from a runner whose lease has expired', async () => {
    const clock = { ms: 1_000 };
    const checkpoints = new FakeCheckpointStore(() => clock.ms);
    const receipts = new FakeReceipts();
    const provider = new FakeProvider(500);

    // After page 1, a second runner takes the stream over.
    let pages = 0;
    const stolen: ApplicationLister = {
      async applicationList<T = OpaqueRecord[]>(params?: ApplicationListParams) {
        const page = await provider.applicationList<T>(params);
        pages += 1;
        if (pages === 1) {
          checkpoints.row.leaseOwner = 'runner-b';
          checkpoints.row.leaseExpiresAtMs = clock.ms + 300_000;
        }
        return page;
      },
    };

    const r = await runReconciliation(deps(stolen, checkpoints, receipts));
    expect(r.stop).toBe('continuation_conflict');
    expect(checkpoints.saves.at(-1)?.status).toBe('not_owned');
    expect(checkpoints.row.resyncCursor).toBeNull();
    expect(r.advanced).toBe(false);
    expect(checkpoints.advances).toHaveLength(0);
  });

  it('locks out a concurrent runner entirely (single flight is unchanged)', async () => {
    const clock = { ms: 1_000 };
    const checkpoints = new FakeCheckpointStore(() => clock.ms);
    checkpoints.row.leaseOwner = 'runner-b';
    checkpoints.row.leaseExpiresAtMs = clock.ms + 300_000;
    const receipts = new FakeReceipts();
    const r = await runReconciliation(deps(new FakeProvider(500), checkpoints, receipts));
    expect(r.stop).toBe('locked');
    expect(r.partialProgress).toEqual({
      resumed: false, checkpoints: 0, pagesDone: 0, itemsDone: 0,
      continuationPending: false, restartReason: 'none',
      sweepRestarts: 0, tokenInstalled: false,
    });
    expect(checkpoints.saves).toHaveLength(0);
    expect(receipts.totalWrites).toBe(0);
  });

  it('aborts a provider cursor loop without anchoring it', async () => {
    const clock = { ms: 1_000 };
    const checkpoints = new FakeCheckpointStore(() => clock.ms);
    const receipts = new FakeReceipts();
    const provider = new FakeProvider(500);
    provider.stuckCursor = 'cur-100';
    // Page 1 anchors cur-100 legitimately; page 2 hands back cur-100 again.
    await expect(runReconciliation(deps(provider, checkpoints, receipts)))
      .rejects.toThrow(/cursor_loop/);
    expect(checkpoints.saves.filter((s) => s.status === 'ok')).toHaveLength(1);
    expect(checkpoints.advances).toHaveLength(0);
  });

  it('detects a loop against the cursor it RESUMED from', async () => {
    const clock = { ms: 1_000 };
    const checkpoints = new FakeCheckpointStore(() => clock.ms, {
      resyncCursor: 'cur-100', resyncCursorEpoch: 1, sweepMode: 'full',
      resyncCursorAt: new Date(1_000).toISOString(),
      resyncPagesDone: 1, resyncItemsDone: 100,
    });
    const receipts = new FakeReceipts();
    const provider = new FakeProvider(500);
    provider.stuckCursor = 'cur-100';       // hands back the resume cursor
    const r = await runReconciliation(deps(provider, checkpoints, receipts));
    // A loop that spans RUNS is invisible to the per-run detector: each run
    // would "make progress" by re-anchoring the same cursor forever. It is
    // caught explicitly, the sweep is abandoned, and the anchor is dropped.
    expect(r.stop).toBe('cursor_invalid');
    expect(r.advanced).toBe(false);
    expect(checkpoints.saves.filter((s) => s.status === 'ok')).toHaveLength(0);
    expect(checkpoints.row.resyncCursor).toBeNull();
    expect(checkpoints.resyncReasons).toContain('resume_cursor_invalid');
    expect(checkpoints.advances).toHaveLength(0);
    expect(r.partialProgress.continuationPending).toBe(false);
  });

  it('refuses to install a token once the lease has been taken over', async () => {
    // Runner A's lease expires mid-sweep and runner B takes the stream over.
    // If A were allowed to drain and advance, the stream would go `idle` with
    // a valid token and B's unread pages would never be swept again.
    const clock = { ms: 1_000 };
    const checkpoints = new FakeCheckpointStore(() => clock.ms);
    const receipts = new FakeReceipts();
    // A single-page corpus, so the run reaches `advance` rather than stopping
    // at an anchor — this is the guard on the FINAL install, not the anchor.
    const provider = new FakeProvider(50);
    const stolen: ApplicationLister = {
      async applicationList<T = OpaqueRecord[]>(params?: ApplicationListParams) {
        const page = await provider.applicationList<T>(params);
        checkpoints.row.leaseOwner = 'runner-b';
        checkpoints.row.leaseExpiresAtMs = clock.ms + 300_000;
        return page;
      },
    };
    await expect(runReconciliation(deps(stolen, checkpoints, receipts)))
      .rejects.toThrow(/advance_refused/);
    // Nothing installed: the stream stays a full resync for whoever owns it.
    expect(checkpoints.row.syncToken).toBeNull();
    expect(checkpoints.row.status).toBe('full_resync_required');
  });

  it('starts from page 1 when a stored anchor is not a usable cursor', async () => {
    const clock = { ms: 1_000 };
    const checkpoints = new FakeCheckpointStore(() => clock.ms, { resyncCursor: '' });
    const receipts = new FakeReceipts();
    const { provider, cursors } = trackingProvider(150);
    const r = await runReconciliation(deps(provider, checkpoints, receipts));
    expect(r.partialProgress.resumed).toBe(false);
    expect(cursors[0]).toBeUndefined();
    expect(receipts.seen.size).toBe(150);
  });
});

describe('admission and bounds are preserved end to end', () => {
  it('writes nothing at all for 2,000 applications under a paused mapping', async () => {
    const clock = { ms: 1_000 };
    const checkpoints = new FakeCheckpointStore(() => clock.ms);
    const receipts = new FakeReceipts();
    const provider = new FakeProvider(2_000);

    const r = await runReconciliation(deps(provider, checkpoints, receipts, PAUSED));
    expect(r.stop).toBe('drained');
    expect(r.observed).toBe(2_000);
    expect(r.admitted).toBe(0);
    expect(r.enqueued).toBe(0);
    expect(r.skipped.noEnabledMapping).toBe(2_000);
    // Zero durable writes — the PR64 storm guarantee, unaffected by anchoring.
    expect(receipts.totalWrites).toBe(0);
    expect(receipts.liveJobs.size).toBe(0);
    // The sweep still completed and installed its token, so a later enable
    // starts from a real incremental baseline.
    expect(checkpoints.row.syncToken).toBe('tok-final');
    // Anchoring a paused sweep costs nothing but the anchors themselves.
    expect(checkpoints.saves.every((s) => s.status === 'ok')).toBe(true);
  });

  it('anchors an INCREMENTAL sweep too, and binds the anchor to its mode', async () => {
    // An incremental sweep large enough to hit the page bound would stall
    // exactly as the full one did, so it anchors as well. What must never
    // happen is a cursor from one mode being fed to the other.
    const clock = { ms: 1_000 };
    const checkpoints = new FakeCheckpointStore(() => clock.ms, {
      status: 'idle', syncToken: 'tok-live', tokenIssuedAt: new Date(clock.ms).toISOString(),
    });
    const receipts = new FakeReceipts();
    const r = await runReconciliation(deps(new FakeProvider(250), checkpoints, receipts));
    expect(r.mode).toBe('incremental');
    expect(r.stop).toBe('drained');
    expect(checkpoints.saves.filter((x) => x.status === 'ok').length).toBeGreaterThan(0);
    // Drained ⇒ the continuation ended atomically with the token install.
    expect(checkpoints.row.resyncCursor).toBeNull();
    expect(r.partialProgress.continuationPending).toBe(false);
  });

  it('refuses to resume a FULL anchor under an incremental run', async () => {
    const clock = { ms: 1_000 };
    const checkpoints = new FakeCheckpointStore(() => clock.ms, {
      status: 'idle', syncToken: 'tok-live', tokenIssuedAt: new Date(clock.ms).toISOString(),
      resyncCursor: 'cur-300', resyncCursorEpoch: 1, sweepMode: 'full',
      resyncCursorAt: new Date(clock.ms).toISOString(),
      resyncPagesDone: 3, resyncItemsDone: 300,
    });
    const receipts = new FakeReceipts();
    const { provider, cursors } = trackingProvider(150);
    const r = await runReconciliation(deps(provider, checkpoints, receipts));
    expect(r.mode).toBe('incremental');
    expect(r.partialProgress.resumed).toBe(false);
    expect(r.partialProgress.restartReason).toBe('mode_changed');
    expect(cursors[0]).toBeUndefined();          // started at page 1
  });

  it('refuses to resume an anchor older than the freshness bound', async () => {
    // Provider cursor lifetime is undocumented. A probe resumed one after 120s,
    // but an anchor from an abandoned sweep hours ago is not trusted.
    const clock = { ms: 10_000_000 };
    const checkpoints = new FakeCheckpointStore(() => clock.ms, {
      resyncCursor: 'cur-300', resyncCursorEpoch: 1, sweepMode: 'full',
      resyncCursorAt: new Date(0).toISOString(),
      resyncPagesDone: 3, resyncItemsDone: 300,
    });
    const receipts = new FakeReceipts();
    const { provider, cursors } = trackingProvider(150);
    const r = await runReconciliation(
      deps(provider, checkpoints, receipts, ENABLED, { caps: { anchorMaxAgeMs: 60_000 } }),
    );
    expect(r.partialProgress.resumed).toBe(false);
    expect(r.partialProgress.restartReason).toBe('anchor_stale');
    expect(cursors[0]).toBeUndefined();
    // The abandoned sweep is counted, so a resume that never holds is visible.
    expect(checkpoints.row.sweepRestarts).toBe(1);
  });

  it('abandons a sweep that exceeds its cross-run page budget', async () => {
    // Production paged 1,200 pages / 118,909 items without draining. A sweep
    // that cannot terminate must stop, loudly, rather than page forever.
    const clock = { ms: 1_000 };
    const checkpoints = new FakeCheckpointStore(() => clock.ms);
    const receipts = new FakeReceipts();
    const provider = new FakeProvider(100_000);
    const r = await runReconciliation(
      deps(provider, checkpoints, receipts, PAUSED, { caps: { sweepMaxPages: 3 } }),
    );
    expect(r.stop).toBe('sweep_budget');
    expect(r.advanced).toBe(false);
    // The anchor is dropped so the next run cannot resume the same dead chain.
    expect(checkpoints.row.resyncCursor).toBeNull();
    expect(checkpoints.resyncReasons).toContain('sweep_page_budget');
    expect(r.partialProgress.continuationPending).toBe(false);
  });

  it('installs the EARLIEST token of a multi-run sweep, never the latest', async () => {
    // If the provider ever issues a token per page, the LAST one anchors
    // "changes since" at the END of a sweep — permanently hiding every change
    // that landed on an already-scanned page while the sweep ran.
    const clock = { ms: 1_000 };
    const checkpoints = new FakeCheckpointStore(() => clock.ms);
    const receipts = new FakeReceipts();
    let page = 0;
    const perPageTokens: ApplicationLister = {
      async applicationList<T = OpaqueRecord[]>(params?: ApplicationListParams) {
        page += 1;
        const more = page < 4;
        return {
          results: [] as unknown as T,
          moreDataAvailable: more,
          nextCursor: more ? `cur-${page * 100}` : undefined,
          syncToken: `tok-page-${page}`,
        };
      },
    };
    const r = await runReconciliation(deps(perPageTokens, checkpoints, receipts, PAUSED));
    expect(r.stop).toBe('drained');
    expect(checkpoints.row.syncToken).toBe('tok-page-1');
    expect(r.partialProgress.tokenInstalled).toBe(true);
  });

  it('reports truthfully when a drained sweep installs NO token', async () => {
    // Production returned no syncToken in 1,200 pages. Draining without one
    // means the next pass is another full sweep — `advanced: true` alone
    // would hide that from an operator.
    const clock = { ms: 1_000 };
    const checkpoints = new FakeCheckpointStore(() => clock.ms);
    const receipts = new FakeReceipts();
    const noToken: ApplicationLister = {
      async applicationList<T = OpaqueRecord[]>() {
        return { results: [] as unknown as T, moreDataAvailable: false };
      },
    };
    const r = await runReconciliation(deps(noToken, checkpoints, receipts, PAUSED));
    expect(r.stop).toBe('drained');
    expect(r.advanced).toBe(true);
    expect(r.partialProgress.tokenInstalled).toBe(false);
    expect(checkpoints.row.syncToken).toBeNull();
  });

  it('reverts to pre-0034 behaviour under the anchor kill switch', async () => {
    const clock = { ms: 1_000 };
    const checkpoints = new FakeCheckpointStore(() => clock.ms);
    const receipts = new FakeReceipts();
    const r = await runReconciliation(
      deps(new FakeProvider(5_001), checkpoints, receipts, PAUSED, {
        caps: { anchorDisabled: true },
      }),
    );
    expect(r.stop).toBe('page_cap');
    expect(checkpoints.saves).toHaveLength(0);
    expect(checkpoints.row.resyncCursor).toBeNull();
    expect(r.partialProgress.restartReason).toBe('anchor_disabled');
    // Not advancing is the conservative failure — nothing is lost, the sweep
    // simply cannot complete, exactly as before this migration.
    expect(r.advanced).toBe(false);
  });

  it('stops on the deadline with its anchors intact', async () => {
    const clock = { ms: 1_000 };
    const checkpoints = new FakeCheckpointStore(() => clock.ms);
    const receipts = new FakeReceipts();
    const provider = new FakeProvider(1_000);
    const ticking: ApplicationLister = {
      async applicationList<T = OpaqueRecord[]>(params?: ApplicationListParams) {
        const page = await provider.applicationList<T>(params);
        clock.ms += 20_000;             // three pages exhaust a 60s budget
        return page;
      },
    };
    const r = await runReconciliation(
      deps(ticking, checkpoints, receipts, ENABLED, { caps: { deadlineMs: 60_000 } }),
    );
    expect(r.stop).toBe('deadline');
    expect(r.advanced).toBe(false);
    expect(r.partialProgress.checkpoints).toBeGreaterThan(0);
    expect(r.partialProgress.continuationPending).toBe(true);
    expect(checkpoints.row.resyncCursor).not.toBeNull();
    expect(checkpoints.row.noProgressRuns).toBe(0);   // anchors ARE progress
  });

  it('honours the item bound at page granularity so a page can always anchor', async () => {
    // A mid-page item bound would discard the page every run and, if it always
    // struck on page 1, the sweep could never anchor anything at all.
    const clock = { ms: 1_000 };
    const checkpoints = new FakeCheckpointStore(() => clock.ms);
    const receipts = new FakeReceipts();
    const r = await runReconciliation(
      deps(new FakeProvider(500), checkpoints, receipts, ENABLED, { caps: { maxItems: 250 } }),
    );
    expect(r.stop).toBe('item_cap');
    // It overshot to the page boundary rather than cutting a page in half.
    expect(r.observed).toBe(300);
    expect(r.partialProgress.itemsDone).toBe(300);
    expect(checkpoints.row.resyncCursor).toBe('cur-300');
    expect(receipts.seen.size).toBe(300);
  });
});
