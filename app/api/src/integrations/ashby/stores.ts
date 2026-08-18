/**
 * ashby/stores.ts — production Supabase-backed adapters for the webhook +
 * reconciliation ports. Every call uses the service-role client (RLS-bypassing,
 * server-only) against the 0029/0030 tables and RPCs. Errors THROW so the
 * webhook route returns a retryable 5xx and reconciliation aborts without
 * advancing the checkpoint.
 *
 * SECURITY: opaque ids and sanitized status codes only cross this boundary. The
 * webhook secret, raw body, signature, sync tokens, and contact/resume data are
 * never read, stored, logged, or returned here.
 */

import type { SupabaseClient } from '@supabase/supabase-js';
import { Queue } from '../../lib/queue/index.js';
import { PgAdapter } from '../../lib/queue/pg-adapter.js';
import type {
  ReceiptStore,
  ReceiptOutcome,
  CheckpointStore,
  SyncCheckpoint,
  EnabledMappingLoader,
  EnabledMappingRow,
} from './ports.js';
import type { MappingResolver, MappingActivity } from './signal-worker.js';

/**
 * Transactional-outbox receipt store backed by record_ashby_event_receipt.
 * When an enqueue spec is supplied, the receipt and the signal job are written
 * in one server-side transaction (atomic outbox); duplicates re-drive.
 */
export function createReceiptStore(client: SupabaseClient): ReceiptStore {
  return {
    async record(input): Promise<ReceiptOutcome> {
      const enqueue = input.enqueue;
      const { data, error } = await client.rpc('record_ashby_event_receipt', {
        p_webhook_action_id: input.webhookActionId,
        p_action: input.action,
        p_metadata: input.metadata ?? null,
        p_enqueue: enqueue !== undefined,
        p_queue_name: enqueue?.queueName ?? null,
        p_dedup_key: enqueue?.dedupKey ?? null,
        p_payload: enqueue?.payload ?? null,
        p_max_attempts: enqueue?.maxAttempts ?? 5,
      });
      if (error) throw new Error('ashby_receipt_rpc_error');
      const row = data as
        | { status?: string; id?: string; enqueued?: boolean; work_pending?: boolean }
        | null;
      const status = row?.status;
      const id = row?.id;
      if ((status === 'inserted' || status === 'duplicate') && typeof id === 'string') {
        return {
          status,
          id,
          enqueued: row?.enqueued === true,
          workPending: row?.work_pending === true,
        };
      }
      throw new Error('ashby_receipt_unexpected_status');
    },
    async markStatus(input): Promise<void> {
      const patch: Record<string, unknown> = { status: input.status };
      if (input.status === 'processed') patch.processed_at = new Date().toISOString();
      const { error } = await client
        .from('ashby_event_receipts')
        .update(patch)
        .eq('provider', 'ashby')
        .eq('webhook_action_id', input.webhookActionId)
        .eq('action', input.action);
      if (error) throw new Error('ashby_receipt_status_error');
    },
  };
}

/** Reconciliation checkpoint store backed by the 0030 cursor table + RPCs. */
export function createCheckpointStore(client: SupabaseClient): CheckpointStore {
  return {
    async get(checkpointKey): Promise<SyncCheckpoint | null> {
      const { data, error } = await client
        .from('ashby_sync_checkpoints')
        .select('sync_token, status, token_issued_at, last_success_at, resync_epoch, resync_cursor, resync_cursor_epoch, resync_cursor_at, sweep_mode, sweep_restarts, sweep_enqueued, sweep_halted_at, sweep_halt_reason, resync_pages_done, resync_items_done')
        .eq('provider', 'ashby')
        .eq('checkpoint_key', checkpointKey)
        .maybeSingle();
      if (error) throw new Error('ashby_checkpoint_read_error');
      if (!data) return null;
      const row = data as {
        sync_token: string | null;
        status: string;
        token_issued_at: string | null;
        last_success_at: string | null;
        resync_epoch: number | null;
        resync_cursor: string | null;
        resync_cursor_epoch: number | null;
        resync_cursor_at: string | null;
        sweep_mode: string | null;
        resync_pages_done: number | null;
        resync_items_done: number | null;
        sweep_restarts: number | null;
        sweep_enqueued: number | null;
        sweep_halted_at: string | null;
        sweep_halt_reason: string | null;
      };
      const status: SyncCheckpoint['status'] =
        row.status === 'running' || row.status === 'full_resync_required' ? row.status : 'idle';
      return {
        syncToken: row.sync_token,
        status,
        tokenIssuedAt: row.token_issued_at,
        lastSuccessAt: row.last_success_at,
        resyncEpoch: typeof row.resync_epoch === 'number' ? row.resync_epoch : 0,
        // Opaque page anchor (0034) — stays inside the service-role boundary.
        resyncCursor: typeof row.resync_cursor === 'string' && row.resync_cursor
          ? row.resync_cursor
          : null,
        resyncCursorEpoch: typeof row.resync_cursor_epoch === 'number'
          ? row.resync_cursor_epoch
          : null,
        resyncCursorAt: row.resync_cursor_at ?? null,
        sweepMode: row.sweep_mode === 'full' || row.sweep_mode === 'incremental'
          ? row.sweep_mode
          : null,
        resyncPagesDone: typeof row.resync_pages_done === 'number' ? row.resync_pages_done : 0,
        resyncItemsDone: typeof row.resync_items_done === 'number' ? row.resync_items_done : 0,
        sweepRestarts: typeof row.sweep_restarts === 'number' ? row.sweep_restarts : 0,
        sweepEnqueued: typeof row.sweep_enqueued === 'number' ? row.sweep_enqueued : 0,
        sweepHaltedAt: row.sweep_halted_at ?? null,
        sweepHaltReason: row.sweep_halt_reason ?? null,
      };
    },
    async advance(input): Promise<void> {
      const { data, error } = await client.rpc('advance_ashby_sync_checkpoint', {
        p_checkpoint_key: input.checkpointKey,
        p_sync_token: input.syncToken,
        p_pages: input.pages,
        p_items: input.items,
        p_full: input.full,
        // 0033 compare-and-set: when a mapping was enabled DURING this run the
        // stored epoch has moved on, and the RPC keeps `full_resync_required`
        // set instead of letting this run's completion clear it.
        p_resync_epoch: typeof input.resyncEpoch === 'number' ? input.resyncEpoch : null,
        // 0034 lease guard: refuse to install a token over another runner's
        // in-flight sweep.
        p_owner: typeof input.owner === 'string' && input.owner ? input.owner : null,
      });
      if (error) throw new Error('ashby_checkpoint_advance_error');
      // A REFUSED advance (not_owned, invalid_*) must be loud. Swallowing the
      // status would report a cursor as installed when nothing was written.
      const status = (data as Record<string, unknown> | null)?.status;
      if (status !== 'ok') throw new Error('ashby_checkpoint_advance_refused');
    },
    async requireFullResync(checkpointKey, reason): Promise<void> {
      const { error } = await client.rpc('mark_ashby_sync_full_resync', {
        p_checkpoint_key: checkpointKey,
        p_reason: reason,
      });
      if (error) throw new Error('ashby_checkpoint_resync_error');
    },
    async saveResyncCursor(input) {
      // 0034 page anchor. The RPC compare-and-sets BOTH the observed epoch and
      // the live lease owner and writes nothing on a mismatch, returning a
      // sanitized status the caller fails closed on. A transport error is
      // surfaced as its own non-`ok` status rather than thrown, so a failed
      // anchor stops the sweep cleanly instead of unwinding it as a crash.
      const { data, error } = await client.rpc('save_ashby_resync_cursor', {
        p_checkpoint_key: input.checkpointKey,
        p_cursor: input.cursor,
        p_owner: input.owner,
        p_pages_done: input.pagesDone,
        p_items_done: input.itemsDone,
        p_resync_epoch: typeof input.resyncEpoch === 'number' ? input.resyncEpoch : null,
        p_mode: input.mode,
        // Banked first-write-wins by the RPC; passing it every time is safe.
        p_sweep_token: typeof input.sweepToken === 'string' && input.sweepToken
          ? input.sweepToken
          : null,
        p_first: input.first === true,
        p_enqueued: typeof input.enqueued === 'number' ? input.enqueued : 0,
      });
      if (error) return { status: 'save_error' };
      const row = data as Record<string, unknown> | null;
      return { status: typeof row?.status === 'string' ? row.status : 'error' };
    },
    async haltSweep(input) {
      // Halting is the compensating control for the page-aligned breaker, so a
      // failure here must be visible rather than swallowed into a silent
      // "budget ignored". The caller stops the run either way.
      const { data, error } = await client.rpc('halt_ashby_sync_sweep', {
        p_checkpoint_key: input.checkpointKey,
        p_owner: input.owner,
        p_reason: input.reason,
      });
      if (error) return { status: 'halt_error' };
      const row = data as Record<string, unknown> | null;
      return { status: typeof row?.status === 'string' ? row.status : 'error' };
    },
    async beginRun(input) {
      const { data, error } = await client.rpc('begin_ashby_sync_run', {
        p_checkpoint_key: input.checkpointKey,
        p_owner: input.owner,
        p_lease_seconds: input.leaseSeconds,
      });
      if (error) throw new Error('ashby_sync_begin_error');
      const row = data as Record<string, unknown> | null;
      const status = typeof row?.status === 'string' ? row.status : 'error';
      if (status !== 'ok') return { status, noProgressRuns: 0 };
      const cpStatus = row?.checkpoint_status;
      const checkpoint: SyncCheckpoint = {
        syncToken: (row?.sync_token as string | null) ?? null,
        status:
          cpStatus === 'running' || cpStatus === 'full_resync_required'
            ? (cpStatus as SyncCheckpoint['status'])
            : 'idle',
        tokenIssuedAt: (row?.token_issued_at as string | null) ?? null,
        lastSuccessAt: (row?.last_success_at as string | null) ?? null,
        resyncEpoch: typeof row?.resync_epoch === 'number' ? row.resync_epoch : 0,
        resyncCursor: typeof row?.resync_cursor === 'string' && row.resync_cursor
          ? (row.resync_cursor as string)
          : null,
        resyncCursorEpoch: typeof row?.resync_cursor_epoch === 'number'
          ? row.resync_cursor_epoch
          : null,
        resyncCursorAt: (row?.resync_cursor_at as string | null) ?? null,
        sweepMode: row?.sweep_mode === 'full' || row?.sweep_mode === 'incremental'
          ? row.sweep_mode
          : null,
        resyncPagesDone: typeof row?.resync_pages_done === 'number' ? row.resync_pages_done : 0,
        resyncItemsDone: typeof row?.resync_items_done === 'number' ? row.resync_items_done : 0,
        sweepRestarts: typeof row?.sweep_restarts === 'number' ? row.sweep_restarts : 0,
        sweepEnqueued: typeof row?.sweep_enqueued === 'number' ? row.sweep_enqueued : 0,
        sweepHaltedAt: (row?.sweep_halted_at as string | null) ?? null,
        sweepHaltReason: (row?.sweep_halt_reason as string | null) ?? null,
      };
      return {
        status: 'ok',
        checkpoint,
        noProgressRuns: typeof row?.no_progress_runs === 'number' ? row.no_progress_runs : 0,
      };
    },
    async endRun(input) {
      const { data, error } = await client.rpc('end_ashby_sync_run', {
        p_checkpoint_key: input.checkpointKey,
        p_owner: input.owner,
        p_advanced: input.advanced,
      });
      if (error) throw new Error('ashby_sync_end_error');
      const row = data as Record<string, unknown> | null;
      return {
        status: typeof row?.status === 'string' ? row.status : 'error',
        noProgressRuns: typeof row?.no_progress_runs === 'number' ? row.no_progress_runs : 0,
      };
    },
  };
}

/** Resolve current mapping activity for an opaque external job id (0029). */
export function createMappingResolver(client: SupabaseClient): MappingResolver {
  return {
    async resolveByJobId(jobId): Promise<MappingActivity> {
      const { data, error } = await client
        .from('ashby_job_mappings')
        .select('status, ai_screening_stage_id')
        .eq('provider', 'ashby')
        .eq('external_job_id', jobId)
        .maybeSingle();
      if (error) throw new Error('ashby_mapping_read_error');
      if (!data) return { status: 'unknown' };
      const row = data as { status: string; ai_screening_stage_id: string | null };
      const status: MappingActivity['status'] =
        row.status === 'enabled' || row.status === 'paused' || row.status === 'drift'
          ? row.status
          : 'unknown';
      return { status, aiScreeningStageId: row.ai_screening_stage_id };
    },
  };
}

/**
 * One bounded read of the ENABLED mappings that carry an AI screening stage
 * (0029 partial index `idx_ashby_job_mappings_enabled`). Reconciliation calls
 * this exactly once per run to build its admission index — replacing what
 * would otherwise be one mapping lookup per observed application.
 *
 * Only the two opaque provider ids are selected: no role, owner, label, or any
 * other tenant-identifying column ever leaves the DB on this path. Rows are
 * ordered by `external_job_id` so a truncated read is deterministic rather
 * than an arbitrary slice that changes between runs.
 */
export function createEnabledMappingLoader(client: SupabaseClient): EnabledMappingLoader {
  return {
    async listEnabled(limit): Promise<{ rows: EnabledMappingRow[]; truncated: boolean }> {
      const bound = Math.max(1, Math.min(Math.trunc(limit), 10_000));
      const { data, error } = await client
        .from('ashby_job_mappings')
        .select('external_job_id, ai_screening_stage_id')
        .eq('provider', 'ashby')
        .eq('status', 'enabled')
        .not('ai_screening_stage_id', 'is', null)
        .order('external_job_id', { ascending: true })
        // Read ONE extra row purely to detect truncation without a count query.
        .limit(bound + 1);
      if (error) throw new Error('ashby_enabled_mappings_read_error');
      const all = Array.isArray(data) ? (data as Array<Record<string, unknown>>) : [];
      const truncated = all.length > bound;
      const rows: EnabledMappingRow[] = [];
      for (const r of all.slice(0, bound)) {
        const externalJobId = typeof r.external_job_id === 'string' ? r.external_job_id : '';
        const aiScreeningStageId =
          typeof r.ai_screening_stage_id === 'string' ? r.ai_screening_stage_id : '';
        if (!externalJobId || !aiScreeningStageId) continue;
        rows.push({ externalJobId, aiScreeningStageId });
      }
      return { rows, truncated };
    },
  };
}

/** Build the leased signal Queue bound to the service-role client (worker side). */
export function createAshbySignalQueue(client: SupabaseClient): Queue {
  return new Queue(new PgAdapter(client));
}
