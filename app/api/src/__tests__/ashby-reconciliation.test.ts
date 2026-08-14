/**
 * Ashby reconciliation — incremental sync, dropped-signal recovery, and
 * checkpoint safety.
 *
 * Proves: the 14-day token expiry / forced-resync logic; that reconciliation
 * recovers a dropped webhook by recording the SAME stage receipt the webhook
 * would have (converging with existing receipts, no duplicates); and that the
 * opaque checkpoint token is advanced ONLY after a fully drained, successful
 * run — never on a page/item cap, a deadline, or a mid-run failure.
 */

import { describe, it, expect } from 'vitest';
import {
  runReconciliation,
  resolveSyncMode,
  SYNC_TOKEN_MAX_AGE_MS,
  type ApplicationLister,
} from '../integrations/ashby/reconciliation.js';
import { ingestWebhook } from '../integrations/ashby/ingress.js';
import type { CheckpointStore, ReceiptStore, ReceiptOutcome, SyncCheckpoint } from '../integrations/ashby/ports.js';
import type { AshbyResult, OpaqueRecord } from '../integrations/ashby/types.js';

/**
 * Transactional-outbox fake: dedups receipts on (action, id) and ensures one
 * live signal job per enqueue dedupKey (so reconciliation and the webhook
 * converge to exactly one scheduled import).
 */
class FakeReceipts implements ReceiptStore {
  seen = new Set<string>();
  liveJobs = new Set<string>();
  async record(input: {
    webhookActionId: string;
    action: string;
    enqueue?: { dedupKey: string };
  }): Promise<ReceiptOutcome> {
    const key = `${input.action}:${input.webhookActionId}`;
    const fresh = !this.seen.has(key);
    if (fresh) this.seen.add(key);
    let enqueued = false;
    let workPending = false;
    if (input.enqueue) {
      if (this.liveJobs.has(input.enqueue.dedupKey)) workPending = true;
      else { this.liveJobs.add(input.enqueue.dedupKey); enqueued = true; workPending = true; }
    }
    return { status: fresh ? 'inserted' : 'duplicate', id: key, enqueued, workPending };
  }
}

class FakeCheckpoints implements CheckpointStore {
  current: SyncCheckpoint | null;
  advances: Array<{ syncToken: string | null; pages: number; items: number; full: boolean }> = [];
  resyncs: string[] = [];
  constructor(initial: SyncCheckpoint | null = null) { this.current = initial; }
  async get(): Promise<SyncCheckpoint | null> { return this.current; }
  async advance(input: { checkpointKey: string; syncToken: string | null; pages: number; items: number; full: boolean }): Promise<void> {
    this.advances.push({ syncToken: input.syncToken, pages: input.pages, items: input.items, full: input.full });
  }
  async requireFullResync(_key: string, reason: string): Promise<void> { this.resyncs.push(reason); }
}

/** A scripted lister returning fixed pages. */
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

function app(id: string, stageId: string): OpaqueRecord {
  return { application: { id, currentInterviewStage: { id: stageId } } };
}

describe('resolveSyncMode (14-day expiry + forced resync)', () => {
  const now = Date.parse('2026-08-13T00:00:00.000Z');
  it('forces full sync with no checkpoint or a null token', () => {
    expect(resolveSyncMode(null, now).mode).toBe('full');
    expect(resolveSyncMode({ syncToken: null, status: 'idle', tokenIssuedAt: null }, now).mode).toBe('full');
  });
  it('forces full sync when the stream is flagged full_resync_required', () => {
    expect(resolveSyncMode({ syncToken: 'tok', status: 'full_resync_required', tokenIssuedAt: new Date(now).toISOString() }, now).mode).toBe('full');
  });
  it('forces full sync when the token is older than 14 days', () => {
    const issued = new Date(now - SYNC_TOKEN_MAX_AGE_MS - 1000).toISOString();
    expect(resolveSyncMode({ syncToken: 'tok', status: 'idle', tokenIssuedAt: issued }, now).mode).toBe('full');
  });
  it('uses the token incrementally when fresh', () => {
    const issued = new Date(now - 1000).toISOString();
    expect(resolveSyncMode({ syncToken: 'tok', status: 'idle', tokenIssuedAt: issued }, now)).toEqual({ mode: 'incremental', syncToken: 'tok' });
  });
});

describe('runReconciliation — recovery + checkpoint safety', () => {
  it('recovers dropped signals and advances the checkpoint after a drained run', async () => {
    const receipts = new FakeReceipts();
    // Pre-seed one application as already covered by a prior webhook receipt.
    await receipts.record({ webhookActionId: 'stage:app_1:stage_ai', action: 'candidateStageChange' });
    const checkpoints = new FakeCheckpoints(null);
    const lister = scriptedLister([
      { results: [app('app_1', 'stage_ai'), app('app_2', 'stage_ai')], moreDataAvailable: false, syncToken: 'sync_final' },
    ]);
    const res = await runReconciliation({ client: lister, checkpoints, receipts });
    expect(res.mode).toBe('full');
    expect(res.stop).toBe('drained');
    expect(res.items).toBe(2);
    expect(res.recovered).toBe(1);  // app_2 recovered
    expect(res.duplicates).toBe(1); // app_1 already had a receipt
    // F1: recovery enqueues import work — app_2 (new) AND app_1 (receipt-only
    // strand re-driven), so both now have a live signal job.
    expect(res.enqueued).toBe(2);
    expect(receipts.liveJobs.size).toBe(2);
    expect(res.advanced).toBe(true);
    expect(checkpoints.advances).toHaveLength(1);
    expect(checkpoints.advances[0]).toMatchObject({ syncToken: 'sync_final', full: true });
  });

  it('F1: recovery enqueues import work; a later webhook converges to exactly one job', async () => {
    const receipts = new FakeReceipts();
    const checkpoints = new FakeCheckpoints(null);
    const lister = scriptedLister([
      { results: [app('app_x', 'stage_ai')], moreDataAvailable: false, syncToken: 't' },
    ]);
    const res = await runReconciliation({ client: lister, checkpoints, receipts });
    expect(res.recovered).toBe(1);
    expect(res.enqueued).toBe(1);
    expect(receipts.liveJobs.size).toBe(1);
    // A subsequent real webhook for the same application-at-stage converges: no
    // second import is scheduled (deterministic dedup key).
    const out = await ingestWebhook(
      { action: 'candidateStageChange', data: { application: { id: 'app_x', currentInterviewStage: { id: 'stage_ai' } } } },
      { receipts },
    );
    expect(out).toMatchObject({ kind: 'duplicate', enqueued: false });
    expect(receipts.liveJobs.size).toBe(1);
  });

  it('pages through multiple pages and advances only once, when drained', async () => {
    const receipts = new FakeReceipts();
    const checkpoints = new FakeCheckpoints(null);
    const lister = scriptedLister([
      { results: [app('a', 's1')], moreDataAvailable: true, nextCursor: 'c1' },
      { results: [app('b', 's1')], moreDataAvailable: true, nextCursor: 'c2' },
      { results: [app('c', 's1')], moreDataAvailable: false, syncToken: 'final' },
    ]);
    const res = await runReconciliation({ client: lister, checkpoints, receipts });
    expect(res.pages).toBe(3);
    expect(res.recovered).toBe(3);
    expect(res.advanced).toBe(true);
    expect(checkpoints.advances).toHaveLength(1);
  });

  it('does NOT advance the checkpoint when a page cap stops the run (partial)', async () => {
    const receipts = new FakeReceipts();
    const checkpoints = new FakeCheckpoints(null);
    const lister = scriptedLister([
      { results: [app('a', 's1')], moreDataAvailable: true, nextCursor: 'c1' },
      { results: [app('b', 's1')], moreDataAvailable: true, nextCursor: 'c2' },
    ]);
    const res = await runReconciliation({ client: lister, checkpoints, receipts, caps: { maxPages: 1 } });
    expect(res.stop).toBe('page_cap');
    expect(res.advanced).toBe(false);
    expect(checkpoints.advances).toHaveLength(0);
  });

  it('does NOT advance the checkpoint when an item cap stops the run', async () => {
    const receipts = new FakeReceipts();
    const checkpoints = new FakeCheckpoints(null);
    const lister = scriptedLister([
      { results: [app('a', 's1'), app('b', 's1'), app('c', 's1')], moreDataAvailable: false },
    ]);
    const res = await runReconciliation({ client: lister, checkpoints, receipts, caps: { maxItems: 2 } });
    expect(res.stop).toBe('item_cap');
    expect(res.advanced).toBe(false);
  });

  it('aborts (throws) and does NOT advance on a provider cursor loop', async () => {
    const receipts = new FakeReceipts();
    const checkpoints = new FakeCheckpoints(null);
    // Both pages return the SAME nextCursor → loop.
    const lister = scriptedLister([
      { results: [app('a', 's1')], moreDataAvailable: true, nextCursor: 'loop' },
      { results: [app('b', 's1')], moreDataAvailable: true, nextCursor: 'loop' },
    ]);
    await expect(runReconciliation({ client: lister, checkpoints, receipts })).rejects.toThrow(/cursor_loop/);
    expect(checkpoints.advances).toHaveLength(0);
  });

  it('does NOT advance when a mid-run page fetch fails (partial failure)', async () => {
    const receipts = new FakeReceipts();
    const checkpoints = new FakeCheckpoints(null);
    let calls = 0;
    const lister: ApplicationLister = {
      async applicationList<T = OpaqueRecord[]>(): Promise<AshbyResult<T>> {
        calls += 1;
        if (calls === 1) {
          return { results: [app('a', 's1')] as unknown as T, moreDataAvailable: true, nextCursor: 'c1' };
        }
        throw new Error('provider 500');
      },
    };
    await expect(runReconciliation({ client: lister, checkpoints, receipts })).rejects.toThrow('provider 500');
    expect(checkpoints.advances).toHaveLength(0);
  });

  it('stops on the deadline without advancing', async () => {
    const receipts = new FakeReceipts();
    const checkpoints = new FakeCheckpoints(null);
    let t = 0;
    const nowMs = () => { t += 2000; return t; }; // each read advances 2s
    const lister = scriptedLister([
      { results: [app('a', 's1')], moreDataAvailable: true, nextCursor: 'c1' },
      { results: [app('b', 's1')], moreDataAvailable: true, nextCursor: 'c2' },
    ]);
    const res = await runReconciliation({ client: lister, checkpoints, receipts, caps: { deadlineMs: 1000 }, nowMs });
    expect(res.stop).toBe('deadline');
    expect(res.advanced).toBe(false);
  });
});
