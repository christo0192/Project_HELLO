/**
 * Reconciliation — single-flight lease and no-progress visibility (0032).
 *
 * Two findings the activation exposed:
 *  - `ashby_sync_checkpoints.status` had a 'running' value that
 *    `runReconciliation` never set or checked, so two schedulers (or a slow run
 *    overlapping the next tick) could both page the provider and both advance
 *    the cursor. Nothing scheduled reconciliation before, so it was latent.
 *  - a full resync larger than `item_cap` stops at the cap, never advances, and
 *    silently replays the same prefix forever. Correct but invisible.
 *
 * The chosen strategy (documented in the runbook) is (c) from the acceptance
 * matrix: keep the bounded caps and make a non-advancing run OBSERVABLE via a
 * durable consecutive-no-progress counter, rather than advancing a cursor past
 * unprocessed work.
 *
 * Zero network, zero DB: the lister, receipts and checkpoint store are fakes.
 */

import { describe, it, expect, vi } from 'vitest';
import { runReconciliation, DEFAULT_CHECKPOINT_KEY } from '../integrations/ashby/reconciliation.js';
import type { CheckpointStore, ReceiptStore, SyncCheckpoint } from '../integrations/ashby/ports.js';

/** An in-memory checkpoint store with a real single-flight lease. */
function checkpointStore(initial: Partial<SyncCheckpoint> = {}) {
  const state: SyncCheckpoint = {
    syncToken: null, status: 'idle', tokenIssuedAt: null, lastSuccessAt: null, ...initial,
  };
  let leaseOwner: string | null = null;
  let noProgressRuns = 0;
  const advances: Array<{ syncToken: string | null; items: number }> = [];

  const store: CheckpointStore = {
    async get() { return state; },
    async advance(input) {
      advances.push({ syncToken: input.syncToken, items: input.items });
      state.syncToken = input.syncToken;
      state.lastSuccessAt = '2026-08-17T00:00:00.000Z';
      noProgressRuns = 0;
    },
    async requireFullResync() { state.status = 'full_resync_required'; state.syncToken = null; },
    async beginRun({ owner }) {
      if (leaseOwner !== null) return { status: 'locked', noProgressRuns };
      leaseOwner = owner;
      return { status: 'ok', checkpoint: { ...state }, noProgressRuns };
    },
    async endRun({ owner, advanced }) {
      if (leaseOwner !== owner) return { status: 'not_owned', noProgressRuns };
      leaseOwner = null;
      if (!advanced) noProgressRuns += 1;
      return { status: 'ok', noProgressRuns };
    },
  };
  return {
    store,
    advances,
    heldBy: () => leaseOwner,
    noProgress: () => noProgressRuns,
  };
}

function receipts(): ReceiptStore {
  return {
    async record() { return { status: 'inserted', id: 'r', enqueued: true, workPending: true }; },
  };
}

/** A lister producing `pages` pages of `perPage` synthetic applications. */
function lister(pages: number, perPage: number) {
  let call = 0;
  const calls: number[] = [];
  return {
    calls,
    client: {
      applicationList: async () => {
        const page = call++;
        calls.push(page);
        return {
          results: Array.from({ length: perPage }, (_, i) => ({
            id: `app_${page}_${i}`,
            currentInterviewStage: { id: 'stage_ai' },
          })),
          moreDataAvailable: page < pages - 1,
          nextCursor: page < pages - 1 ? `cursor_${page + 1}` : undefined,
          syncToken: `token_${page}`,
        } as never;
      },
    },
  };
}

describe('single-flight lease', () => {
  it('acquires and releases the lease around a run', async () => {
    const cp = checkpointStore();
    const l = lister(1, 2);
    const r = await runReconciliation({
      client: l.client, checkpoints: cp.store, receipts: receipts(), owner: 'sched-1',
    });
    expect(r.stop).toBe('drained');
    expect(r.advanced).toBe(true);
    expect(cp.heldBy()).toBeNull();
  });

  it('a second concurrent run is LOCKED and does no provider work', async () => {
    const cp = checkpointStore();
    const l = lister(1, 2);

    // Hold the lease by starting a run that parks inside the first page fetch.
    let release!: () => void;
    const gate = new Promise<void>((r) => { release = r; });
    const slowClient = {
      applicationList: vi.fn(async () => {
        await gate;
        return { results: [], moreDataAvailable: false } as never;
      }),
    };

    const first = runReconciliation({
      client: slowClient, checkpoints: cp.store, receipts: receipts(), owner: 'sched-1',
    });
    // Let the lease be taken.
    for (let i = 0; i < 20; i++) await Promise.resolve();
    expect(cp.heldBy()).toBe('sched-1');

    const second = await runReconciliation({
      client: l.client, checkpoints: cp.store, receipts: receipts(), owner: 'sched-2',
    });

    expect(second.stop).toBe('locked');
    expect(second.advanced).toBe(false);
    expect(second.pages).toBe(0);
    // The blocked runner must not have paged the provider at all.
    expect(l.calls).toEqual([]);

    release();
    await first;
    expect(cp.heldBy()).toBeNull();
  });

  it('only ONE of two overlapping runs advances the checkpoint', async () => {
    const cp = checkpointStore();
    const a = lister(1, 1);
    const b = lister(1, 1);
    const [ra, rb] = await Promise.all([
      runReconciliation({ client: a.client, checkpoints: cp.store, receipts: receipts(), owner: 'A' }),
      runReconciliation({ client: b.client, checkpoints: cp.store, receipts: receipts(), owner: 'B' }),
    ]);
    const advanced = [ra, rb].filter((r) => r.advanced);
    const locked = [ra, rb].filter((r) => r.stop === 'locked');
    expect(advanced).toHaveLength(1);
    expect(locked).toHaveLength(1);
    expect(cp.advances).toHaveLength(1);
  });

  it('releases the lease even when the run throws', async () => {
    const cp = checkpointStore();
    const boom = { applicationList: async () => { throw new Error('provider_down'); } };
    await expect(runReconciliation({
      client: boom, checkpoints: cp.store, receipts: receipts(), owner: 'sched-1',
    })).rejects.toThrow('provider_down');
    // A stranded lease would wedge the stream until its deadline.
    expect(cp.heldBy()).toBeNull();
    expect(cp.noProgress()).toBe(1);
  });

  it('runs unguarded (exactly as before) when the store offers no lease seam', async () => {
    // The optional seam keeps every pre-existing pure-domain test valid.
    const minimal: CheckpointStore = {
      async get() { return null; },
      async advance() {},
      async requireFullResync() {},
    };
    const l = lister(1, 1);
    const r = await runReconciliation({ client: l.client, checkpoints: minimal, receipts: receipts() });
    expect(r.stop).toBe('drained');
    expect(r.advanced).toBe(true);
  });
});

describe('no-progress visibility', () => {
  it('increments the durable counter for each consecutive non-advancing run', async () => {
    const cp = checkpointStore();
    // itemCap smaller than one page ⇒ every run stops at item_cap and cannot advance.
    for (let i = 1; i <= 3; i++) {
      const l = lister(3, 10);
      const r = await runReconciliation({
        client: l.client, checkpoints: cp.store, receipts: receipts(), owner: 'sched-1',
        caps: { maxItems: 5 },
      });
      expect(r.stop).toBe('item_cap');
      expect(r.advanced).toBe(false);
      expect(cp.noProgress(), `after run ${i}`).toBe(i);
    }
    // Three silent replays of the same prefix are now an operator-visible signal.
    expect(cp.noProgress()).toBeGreaterThanOrEqual(3);
    expect(cp.advances).toHaveLength(0);
  });

  it('resets the counter as soon as a run drains and advances', async () => {
    const cp = checkpointStore();
    const capped = lister(3, 10);
    await runReconciliation({
      client: capped.client, checkpoints: cp.store, receipts: receipts(), owner: 's',
      caps: { maxItems: 5 },
    });
    expect(cp.noProgress()).toBe(1);

    const drained = lister(1, 2);
    const r = await runReconciliation({
      client: drained.client, checkpoints: cp.store, receipts: receipts(), owner: 's',
    });
    expect(r.advanced).toBe(true);
    expect(cp.noProgress()).toBe(0);
  });

  it('never advances the cursor past unprocessed work', async () => {
    const cp = checkpointStore();
    const l = lister(5, 10);
    const r = await runReconciliation({
      client: l.client, checkpoints: cp.store, receipts: receipts(), owner: 's',
      caps: { maxPages: 2 },
    });
    expect(r.stop).toBe('page_cap');
    expect(r.advanced).toBe(false);
    // The chosen strategy is bounded caps + visibility, NOT advancing a partial
    // cursor, which would skip applications permanently.
    expect(cp.advances).toEqual([]);
  });
});

describe('checkpoint key', () => {
  it('uses the documented default stream key', () => {
    expect(DEFAULT_CHECKPOINT_KEY).toBe('application.list');
  });
});
