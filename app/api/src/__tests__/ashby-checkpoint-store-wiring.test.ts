/**
 * ashby/stores.ts — checkpoint store WIRING.
 *
 * The domain suites drive `runReconciliation` against fakes, which proves the
 * algorithm but not that the production adapter calls the right RPC with the
 * parameter names migration 0034 actually declares. A rename on either side
 * would leave every domain test green and silently disable page anchoring in
 * production — the exact failure mode this file exists to catch.
 */

import { describe, it, expect } from 'vitest';
import type { SupabaseClient } from '@supabase/supabase-js';
import { createCheckpointStore } from '../integrations/ashby/stores.js';

/** The parameter names declared by 0034's save_ashby_resync_cursor. */
const SAVE_RPC_PARAMS = [
  'p_checkpoint_key', 'p_cursor', 'p_owner', 'p_pages_done', 'p_items_done',
  'p_resync_epoch', 'p_mode', 'p_sweep_token', 'p_first',
] as const;

type RpcCall = { fn: string; args: Record<string, unknown> };

function fakeClient(opts: {
  rpcResult?: unknown;
  rpcError?: unknown;
  row?: Record<string, unknown> | null;
  selectError?: unknown;
}) {
  const calls: RpcCall[] = [];
  let selectedColumns = '';
  const client = {
    rpc(fn: string, args: Record<string, unknown>) {
      calls.push({ fn, args });
      return Promise.resolve({ data: opts.rpcResult ?? null, error: opts.rpcError ?? null });
    },
    from() {
      const builder = {
        select(cols: string) { selectedColumns = cols; return builder; },
        eq() { return builder; },
        maybeSingle() {
          return Promise.resolve({ data: opts.row ?? null, error: opts.selectError ?? null });
        },
      };
      return builder;
    },
  } as unknown as SupabaseClient;
  return { client, calls, columns: () => selectedColumns };
}

describe('createCheckpointStore — 0034 continuation wiring', () => {
  it('calls save_ashby_resync_cursor with exactly the migration parameter names', async () => {
    const { client, calls } = fakeClient({ rpcResult: { status: 'ok' } });
    const store = createCheckpointStore(client);
    const res = await store.saveResyncCursor!({
      checkpointKey: 'application.list',
      cursor: 'opaque-cursor',
      owner: 'runner-a',
      pagesDone: 7,
      itemsDone: 700,
      resyncEpoch: 3,
      mode: 'full',
      sweepToken: 'opaque-token',
      first: false,
    });
    expect(res.status).toBe('ok');
    expect(calls).toHaveLength(1);
    expect(calls[0].fn).toBe('save_ashby_resync_cursor');
    expect(Object.keys(calls[0].args).sort()).toEqual([...SAVE_RPC_PARAMS].sort());
    expect(calls[0].args).toMatchObject({
      p_checkpoint_key: 'application.list',
      p_cursor: 'opaque-cursor',
      p_owner: 'runner-a',
      p_pages_done: 7,
      p_items_done: 700,
      p_resync_epoch: 3,
      p_mode: 'full',
      p_sweep_token: 'opaque-token',
      p_first: false,
    });
  });

  it('passes a null epoch through rather than inventing one', async () => {
    // A null epoch means "no compare-and-set" — coercing it to 0 would make
    // every anchor look like it belonged to generation zero.
    const { client, calls } = fakeClient({ rpcResult: { status: 'ok' } });
    await createCheckpointStore(client).saveResyncCursor!({
      checkpointKey: 'application.list', cursor: 'c', owner: 'o',
      pagesDone: 0, itemsDone: 0, resyncEpoch: null, mode: 'full',
    });
    expect(calls[0].args.p_resync_epoch).toBeNull();
  });

  it('surfaces a refusal as a status instead of throwing', async () => {
    // The caller fails closed on any non-ok status. Throwing here would unwind
    // the run as a crash and lose the truthful stop code.
    for (const status of ['epoch_changed', 'not_owned', 'lease_expired', 'invalid_cursor']) {
      const { client } = fakeClient({ rpcResult: { status } });
      await expect(createCheckpointStore(client).saveResyncCursor!({
        checkpointKey: 'application.list', cursor: 'c', owner: 'o',
        pagesDone: 1, itemsDone: 1, resyncEpoch: 1, mode: 'full',
      })).resolves.toEqual({ status });
    }
  });

  it('turns a transport error into a non-ok status, never a silent ok', async () => {
    const { client } = fakeClient({ rpcError: { message: 'boom' } });
    const res = await createCheckpointStore(client).saveResyncCursor!({
      checkpointKey: 'application.list', cursor: 'c', owner: 'o',
      pagesDone: 1, itemsDone: 1, resyncEpoch: 1, mode: 'full',
    });
    expect(res.status).not.toBe('ok');
  });

  it('reads the continuation columns back and normalises them', async () => {
    const { client, columns } = fakeClient({
      row: {
        sync_token: null, status: 'full_resync_required', token_issued_at: null,
        last_success_at: null, resync_epoch: 4, resync_cursor: 'opaque-cursor',
        resync_pages_done: 12, resync_items_done: 1_200,
      },
    });
    const cp = await createCheckpointStore(client).get('application.list');
    for (const col of ['resync_cursor', 'resync_pages_done', 'resync_items_done', 'resync_epoch']) {
      expect(columns()).toContain(col);
    }
    expect(cp).toMatchObject({
      resyncCursor: 'opaque-cursor', resyncPagesDone: 12, resyncItemsDone: 1_200, resyncEpoch: 4,
    });
  });

  it('treats an empty stored cursor as "no continuation"', async () => {
    // An empty string would be a falsy cursor the run might hand to the
    // provider verbatim; it must read as null, i.e. start from page 1.
    const { client } = fakeClient({
      row: {
        sync_token: null, status: 'full_resync_required', token_issued_at: null,
        last_success_at: null, resync_epoch: 1, resync_cursor: '',
        resync_pages_done: null, resync_items_done: null,
      },
    });
    const cp = await createCheckpointStore(client).get('application.list');
    expect(cp?.resyncCursor).toBeNull();
    expect(cp?.resyncPagesDone).toBe(0);
  });

  it('exposes the continuation returned by begin_ashby_sync_run', async () => {
    const { client } = fakeClient({
      rpcResult: {
        status: 'ok', sync_token: null, checkpoint_status: 'full_resync_required',
        token_issued_at: null, last_success_at: null, no_progress_runs: 2,
        resync_epoch: 5, resync_cursor: 'opaque-cursor', resync_pages_done: 3,
        resync_items_done: 300,
      },
    });
    const begun = await createCheckpointStore(client).beginRun!({
      checkpointKey: 'application.list', owner: 'runner-a', leaseSeconds: 300,
    });
    expect(begun.status).toBe('ok');
    expect(begun.checkpoint).toMatchObject({
      resyncCursor: 'opaque-cursor', resyncPagesDone: 3, resyncItemsDone: 300, resyncEpoch: 5,
    });
  });

  it('forwards the epoch AND lease guards on advance', async () => {
    const { client, calls } = fakeClient({ rpcResult: { status: 'ok' } });
    await createCheckpointStore(client).advance({
      checkpointKey: 'application.list', syncToken: 'tok', pages: 1, items: 1,
      full: true, resyncEpoch: 9, owner: 'runner-a',
    });
    expect(calls[0].fn).toBe('advance_ashby_sync_checkpoint');
    expect(calls[0].args.p_resync_epoch).toBe(9);
    expect(calls[0].args.p_owner).toBe('runner-a');
  });

  it('throws when the RPC REFUSES the advance', async () => {
    // A refused advance wrote nothing. Reporting success would tell the run it
    // installed a token it does not have — and, with a continuation in play,
    // would hide that another runner still owns the sweep.
    for (const status of ['not_owned', 'invalid_sync_token', 'invalid_checkpoint_key']) {
      const { client } = fakeClient({ rpcResult: { status } });
      await expect(createCheckpointStore(client).advance({
        checkpointKey: 'application.list', syncToken: 'tok', pages: 1, items: 1,
        full: true, resyncEpoch: 1, owner: 'runner-a',
      })).rejects.toThrow(/advance_refused/);
    }
  });

  it('omits the lease assertion when no owner is supplied', async () => {
    const { client, calls } = fakeClient({ rpcResult: { status: 'ok' } });
    await createCheckpointStore(client).advance({
      checkpointKey: 'application.list', syncToken: 'tok', pages: 1, items: 1, full: false,
    });
    expect(calls[0].args.p_owner).toBeNull();
  });
});
