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

import type { IQueueAdapter, QueueJob, EnqueueInput } from './types.js';
import type { SupabaseClient } from '@supabase/supabase-js';

export const ERR_ENQUEUE_FAILED = 'ERR_ENQUEUE_FAILED';
export const ERR_JOB_NOT_FOUND = 'ERR_JOB_NOT_FOUND';
export const ERR_DLQ_FAILED = 'ERR_DLQ_FAILED';
export const ERR_REPLAY_FAILED = 'ERR_REPLAY_FAILED';

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
  };
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

export class PgAdapter implements IQueueAdapter {
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
    const now = new Date().toISOString();

    // Fetch the job first.
    const { data: job, error: fetchError } = await this.supabase
      .from('job_queue')
      .select('*')
      .eq('id', jobId)
      .single();

    if (fetchError || !job) {
      throw Object.assign(new Error(ERR_JOB_NOT_FOUND), { cause: fetchError });
    }

    const row = job as unknown as JobRow;

    // Insert into DLQ.
    const dlqPayload = {
      id: row.id,
      name: row.name,
      payload: row.payload,
      dedup_key: row.dedup_key,
      attempts: row.attempts,
      max_attempts: row.max_attempts,
      error_message: errorMessage,
      failed_at: now,
      moved_at: now,
      replay_count: 0,
    };

    const { error: dlqError } = await this.supabase
      .from('job_dlq')
      .insert(dlqPayload);

    if (dlqError) {
      throw Object.assign(new Error(ERR_DLQ_FAILED), { cause: dlqError });
    }

    // Delete from main queue.
    const { error: delError } = await this.supabase
      .from('job_queue')
      .delete()
      .eq('id', jobId);

    if (delError) throw delError;

    return {
      id: row.id,
      name: row.name,
      payload: row.payload,
      status: 'failed',
      dedupKey: row.dedup_key ?? undefined,
      attempts: row.attempts,
      maxAttempts: row.max_attempts,
      priority: row.priority,
      scheduledAt: row.scheduled_at,
      failedAt: now,
      errorMessage: errorMessage,
      createdAt: now,
    };
  }

  async replay(jobId: string): Promise<QueueJob> {
    const now = new Date().toISOString();

    // Fetch from DLQ.
    const { data: dlqRow, error: fetchError } = await this.supabase
      .from('job_dlq')
      .select('*')
      .eq('id', jobId)
      .single();

    if (fetchError || !dlqRow) {
      throw Object.assign(new Error(ERR_JOB_NOT_FOUND), { cause: fetchError });
    }

    const row = dlqRow as unknown as DlqRow;

    // Re-insert into job_queue as a new pending job.
    const newJob = {
      name: row.name,
      payload: row.payload,
      dedup_key: null, // dedup counter reset on replay
      attempts: 0,
      max_attempts: row.max_attempts,
      priority: 0,
      scheduled_at: now,
      status: 'pending',
      created_at: now,
    };

    const { data: inserted, error: insertError } = await this.supabase
      .from('job_queue')
      .insert(newJob)
      .select()
      .single();

    if (insertError || !inserted) {
      throw Object.assign(new Error(ERR_REPLAY_FAILED), { cause: insertError });
    }

    // Delete from DLQ.
    await this.supabase
      .from('job_dlq')
      .delete()
      .eq('id', jobId);

    return rowToJob(inserted as unknown as JobRow);
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
