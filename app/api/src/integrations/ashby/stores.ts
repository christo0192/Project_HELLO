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
        .select('sync_token, status, token_issued_at, last_success_at')
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
      };
      const status: SyncCheckpoint['status'] =
        row.status === 'running' || row.status === 'full_resync_required' ? row.status : 'idle';
      return {
        syncToken: row.sync_token,
        status,
        tokenIssuedAt: row.token_issued_at,
        lastSuccessAt: row.last_success_at,
      };
    },
    async advance(input): Promise<void> {
      const { error } = await client.rpc('advance_ashby_sync_checkpoint', {
        p_checkpoint_key: input.checkpointKey,
        p_sync_token: input.syncToken,
        p_pages: input.pages,
        p_items: input.items,
        p_full: input.full,
      });
      if (error) throw new Error('ashby_checkpoint_advance_error');
    },
    async requireFullResync(checkpointKey, reason): Promise<void> {
      const { error } = await client.rpc('mark_ashby_sync_full_resync', {
        p_checkpoint_key: checkpointKey,
        p_reason: reason,
      });
      if (error) throw new Error('ashby_checkpoint_resync_error');
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

/** Build the leased signal Queue bound to the service-role client (worker side). */
export function createAshbySignalQueue(client: SupabaseClient): Queue {
  return new Queue(new PgAdapter(client));
}
