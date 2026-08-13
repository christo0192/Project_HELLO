/**
 * L1 queue (REL-01/04): Postgres-backed queue adapter.
 *
 * Uses the supabase client and the screening_v2.job_queue /
 * screening_v2.job_dlq tables (created by migration 0009_queue.sql).
 *
 * Enqueue idempotency is enforced by a partial unique index on dedup_key
 * WHERE status IN ('pending', 'active', 'delayed').  A completed/failed
 * job with the same dedup_key does NOT block a new enqueue.
 *
 * Lock-free dequeue uses a single UPDATE … RETURNING pattern:
 *   UPDATE job_queue SET status='active', started_at=now(), attempts=attempts+1
 *   WHERE id = (
 *     SELECT id FROM job_queue
 *     WHERE name = $1 AND status IN ('pending','delayed') AND scheduled_at <= now()
 *     ORDER BY priority DESC, scheduled_at ASC
 *     LIMIT 1
 *     FOR UPDATE SKIP LOCKED
 *   )
 *   RETURNING *;
 *
 * This avoids row-level lock contention without a separate SELECT transaction.
 */

import type {
  IQueueAdapter,
  ILeasedQueueAdapter,
  QueueJob,
  EnqueueInput,
  FailOutcome,
  LeaseMutationOutcome,
  ReclaimResult,
} from './types.js';
import { clampLeaseSeconds } from './types.js';
import type { SupabaseClient } from '@supabase/supabase-js';

export const ERR_ENQUEUE_FAILED = 'ERR_ENQUEUE_FAILED';
export const ERR_JOB_NOT_FOUND = 'ERR_JOB_NOT_FOUND';
export const ERR_DLQ_FAILED = 'ERR_DLQ_FAILED';
export const ERR_REPLAY_FAILED = 'ERR_REPLAY_FAILED';
export const ERR_CLAIM_FAILED = 'ERR_CLAIM_FAILED';
export const ERR_HEARTBEAT_FAILED = 'ERR_HEARTBEAT_FAILED';
export const ERR_COMPLETE_FAILED = 'ERR_COMPLETE_FAILED';
export const ERR_FAIL_FAILED = 'ERR_FAIL_FAILED';
export const ERR_RECLAIM_FAILED = 'ERR_RECLAIM_FAILED';

/** Minimum viable row shape from Supabase JSON responses. */
interface JobRow {
  id: string;
  name: string;
  payload: Record<string, unknown>;
  status: string;
  dedup_key: string | null;
  attempts: number;
  max_attempts: number;
  priority: number;
  scheduled_at: string;
  started_at: string | null;
  completed_at: string | null;
  failed_at: string | null;
  error_message: string | null;
  created_at: string;
  lease_token: string | null;
  lease_owner: string | null;
  lease_expires_at: string | null;
  lease_deadline_at: string | null;
}

interface DlqRow {
  id: string;
  name: string;
  payload: Record<string, unknown>;
  dedup_key: string | null;
  attempts: number;
  max_attempts: number;
  error_message: string | null;
  failed_at: string;
  moved_at: string;
  replay_count: number;
}

function rowToJob(row: JobRow): QueueJob {
  return {
    id: row.id,
    name: row.name,
    payload: row.payload,
    status: row.status as QueueJob['status'],
    dedupKey: row.dedup_key ?? undefined,
    attempts: row.attempts,
    maxAttempts: row.max_attempts,
    priority: row.priority,
    scheduledAt: row.scheduled_at,
    startedAt: row.started_at ?? undefined,
    completedAt: row.completed_at ?? undefined,
    failedAt: row.failed_at ?? undefined,
    errorMessage: row.error_message ?? undefined,
    createdAt: row.created_at,
    leaseToken: row.lease_token ?? undefined,
    leaseOwner: row.lease_owner ?? undefined,
    leaseExpiresAt: row.lease_expires_at ?? undefined,
    leaseDeadlineAt: row.lease_deadline_at ?? undefined,
  };
}

/** PostgREST returns set-returning RPCs as an array; take the first row. */
function firstRow<R>(data: unknown): R | null {
  if (Array.isArray(data)) return (data[0] as R) ?? null;
  if (data && typeof data === 'object') return data as R;
  return null;
}

function dlqRowToJob(row: DlqRow): QueueJob {
  return {
    id: row.id,
    name: row.name,
    payload: row.payload,
    status: 'failed',
    dedupKey: row.dedup_key ?? undefined,
    attempts: row.attempts,
    maxAttempts: row.max_attempts,
    priority: 0,
    scheduledAt: row.failed_at,
    failedAt: row.failed_at,
    errorMessage: row.error_message ?? undefined,
    createdAt: row.moved_at,
  };
}

export class PgAdapter implements ILeasedQueueAdapter {
  private supabase: SupabaseClient;
  private schema: string;

  constructor(supabase: SupabaseClient, schema: string = 'screening_v2') {
    this.supabase = supabase;
    this.schema = schema;
  }

  async enqueue(
    job: EnqueueInput,
  ): Promise<QueueJob> {
    const now = new Date().toISOString();
    const scheduledAt = job.scheduledAt || now;

    const payload = {
      name: job.name,
      payload: job.payload,
      dedup_key: job.dedupKey ?? null,
      attempts: job.attempts,
      max_attempts: job.maxAttempts,
      priority: job.priority,
      scheduled_at: scheduledAt,
      status: 'pending',
      created_at: now,
    };

    const { data, error } = await this.supabase
      .from('job_queue')
      .insert(payload)
      .select()
      .single();

    if (error) {
      // Pg code 23505 = unique violation on dedup_key partial index.
      if (error.code === '23505') {
        // Fetch the existing job and return it.
        const existing = await this.getByDedupKey(job.name, job.dedupKey!);
        if (existing) return existing;
      }
      throw Object.assign(new Error(ERR_ENQUEUE_FAILED), { cause: error });
    }

    return rowToJob(data as unknown as JobRow);
  }

  async dequeue(queueName: string, batchSize: number = 1): Promise<QueueJob[]> {
    // We use a subquery with FOR UPDATE SKIP LOCKED via raw SQL through
    // the supabase rpc call, or we simulate it with multiple single-row
    // dequeues.  For simplicity in the adapter seam, we do a single-row
    // UPDATE … RETURNING pattern via the Supabase JS client.
    //
    // Supabase doesn't expose UPDATE … FROM (subquery) directly, so we
    // use a stored procedure or batch loop.  Here we use a loop up to
    // batchSize; in production use an RPC.
    const results: QueueJob[] = [];
    for (let i = 0; i < batchSize; i++) {
      const job = await this.dequeueSingle(queueName);
      if (!job) break;
      results.push(job);
    }
    return results;
  }

  private async dequeueSingle(queueName: string): Promise<QueueJob | null> {
    const now = new Date().toISOString();

    // Use an RPC call (created in migration) for atomic dequeue.
    const { data, error } = await this.supabase.rpc('dequeue_job', {
      p_queue_name: queueName,
      p_now: now,
    });

    if (error) throw error;
    if (!data) return null;

    return rowToJob(data as unknown as JobRow);
  }

  async complete(jobId: string): Promise<void> {
    const now = new Date().toISOString();
    const { error } = await this.supabase
      .from('job_queue')
      .update({ status: 'completed', completed_at: now })
      .eq('id', jobId);

    if (error) throw error;
  }

  async fail(jobId: string, errorMessage: string): Promise<void> {
    const now = new Date().toISOString();
    const { error } = await this.supabase
      .from('job_queue')
      .update({
        status: 'failed',
        failed_at: now,
        error_message: errorMessage,
      })
      .eq('id', jobId);

    if (error) throw error;
  }

  async scheduleRetry(jobId: string, scheduledAt: string): Promise<void> {
    const { error } = await this.supabase
      .from('job_queue')
      .update({ status: 'delayed', scheduled_at: scheduledAt })
      .eq('id', jobId);

    if (error) throw error;
  }

  async moveToDlq(jobId: string, errorMessage: string): Promise<QueueJob> {
    // Single server-side transaction (lock queue row, insert DLQ, delete queue
    // row) — no insert-then-delete client gap that could leave both/neither
    // record on a crash.
    const now = new Date().toISOString();
    const { data, error } = await this.supabase.rpc('dlq_job', {
      p_job_id: jobId,
      p_now: now,
      p_error: errorMessage,
    });
    if (error) throw Object.assign(new Error(ERR_DLQ_FAILED), { cause: error });
    const row = firstRow<DlqRow>(data);
    if (!row) throw new Error(ERR_JOB_NOT_FOUND);
    return dlqRowToJob(row);
  }

  async replay(jobId: string): Promise<QueueJob> {
    // Transactional replay: lock the DLQ row, insert one pending job, delete
    // the DLQ row — all in one RPC so concurrent replay cannot duplicate.
    const now = new Date().toISOString();
    const { data, error } = await this.supabase.rpc('replay_dlq_job', {
      p_dlq_id: jobId,
      p_now: now,
    });
    if (error) throw Object.assign(new Error(ERR_REPLAY_FAILED), { cause: error });
    const row = firstRow<JobRow>(data);
    if (!row) throw new Error(ERR_JOB_NOT_FOUND);
    return rowToJob(row);
  }

  // ═══════════════════════════════════════════════════════════════════
  // Lease-safe claim path (0028) — every mutation is a server-side
  // compare-and-set on the live lease token via a SECURITY-guarded RPC.
  // Errors are sanitized stable codes; payloads and lease tokens are never
  // logged.
  // ═══════════════════════════════════════════════════════════════════

  async claim(
    queueName: string,
    nowIso: string,
    leaseSeconds: number,
    owner?: string,
  ): Promise<QueueJob | null> {
    const { data, error } = await this.supabase.rpc('claim_job', {
      p_queue_name: queueName,
      p_now: nowIso,
      p_lease_seconds: clampLeaseSeconds(leaseSeconds),
      p_owner: owner ?? null,
    });
    if (error) throw Object.assign(new Error(ERR_CLAIM_FAILED), { cause: error });
    const row = firstRow<JobRow>(data);
    return row ? rowToJob(row) : null;
  }

  async heartbeat(
    jobId: string,
    leaseToken: string,
    nowIso: string,
    leaseSeconds: number,
  ): Promise<LeaseMutationOutcome> {
    const { data, error } = await this.supabase.rpc('heartbeat_job', {
      p_job_id: jobId,
      p_lease_token: leaseToken,
      p_now: nowIso,
      p_lease_seconds: clampLeaseSeconds(leaseSeconds),
    });
    if (error) throw Object.assign(new Error(ERR_HEARTBEAT_FAILED), { cause: error });
    return firstRow<JobRow>(data) ? 'ok' : 'not_owned';
  }

  async completeLeased(
    jobId: string,
    leaseToken: string,
    nowIso: string,
  ): Promise<LeaseMutationOutcome> {
    const { data, error } = await this.supabase.rpc('complete_job', {
      p_job_id: jobId,
      p_lease_token: leaseToken,
      p_now: nowIso,
    });
    if (error) throw Object.assign(new Error(ERR_COMPLETE_FAILED), { cause: error });
    return data === true ? 'ok' : 'not_owned';
  }

  async failLeased(
    jobId: string,
    leaseToken: string,
    nowIso: string,
    errorMessage: string,
    retryAtIso: string,
  ): Promise<FailOutcome> {
    const { data, error } = await this.supabase.rpc('fail_job', {
      p_job_id: jobId,
      p_lease_token: leaseToken,
      p_now: nowIso,
      p_error: errorMessage,
      p_retry_at: retryAtIso,
    });
    if (error) throw Object.assign(new Error(ERR_FAIL_FAILED), { cause: error });
    const outcome = String(data);
    if (outcome === 'retry_scheduled' || outcome === 'dead_lettered') return outcome;
    return 'not_owned';
  }

  async reclaimExpired(nowIso: string, limit: number = 100): Promise<ReclaimResult> {
    const { data, error } = await this.supabase.rpc('reclaim_expired_jobs', {
      p_now: nowIso,
      p_limit: limit,
    });
    if (error) throw Object.assign(new Error(ERR_RECLAIM_FAILED), { cause: error });
    const rows = (Array.isArray(data) ? data : []) as Array<{ job_id: string; outcome: string }>;
    const result: ReclaimResult = { requeued: [], deadLettered: [] };
    for (const r of rows) {
      if (r.outcome === 'dead_lettered') result.deadLettered.push(r.job_id);
      else if (r.outcome === 'requeued') result.requeued.push(r.job_id);
    }
    return result;
  }

  async replayDlq(dlqId: string, nowIso: string): Promise<QueueJob | null> {
    const { data, error } = await this.supabase.rpc('replay_dlq_job', {
      p_dlq_id: dlqId,
      p_now: nowIso,
    });
    if (error) throw Object.assign(new Error(ERR_REPLAY_FAILED), { cause: error });
    const row = firstRow<JobRow>(data);
    return row ? rowToJob(row) : null;
  }

  async getById(jobId: string): Promise<QueueJob | null> {
    // Check main queue first.
    const { data } = await this.supabase
      .from('job_queue')
      .select('*')
      .eq('id', jobId)
      .maybeSingle();

    if (data) return rowToJob(data as unknown as JobRow);

    // Check DLQ.
    const { data: dlqData } = await this.supabase
      .from('job_dlq')
      .select('*')
      .eq('id', jobId)
      .maybeSingle();

    if (dlqData) return dlqRowToJob(dlqData as unknown as DlqRow);

    return null;
  }

  async getDlqJobs(): Promise<QueueJob[]> {
    const { data, error } = await this.supabase
      .from('job_dlq')
      .select('*')
      .order('moved_at', { ascending: false });

    if (error) throw error;
    return (data ?? []).map(r => dlqRowToJob(r as unknown as DlqRow));
  }

  private async getByDedupKey(queueName: string, dedupKey: string): Promise<QueueJob | null> {
    const { data } = await this.supabase
      .from('job_queue')
      .select('*')
      .eq('name', queueName)
      .eq('dedup_key', dedupKey)
      .in('status', ['pending', 'active', 'delayed'])
      .maybeSingle();

    return data ? rowToJob(data as unknown as JobRow) : null;
  }
}
