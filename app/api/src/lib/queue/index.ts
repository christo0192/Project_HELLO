/**
 * L1 queue (REL-01/04): pg-boss-compatible queue abstraction.
 *
 * Public API:
 *   const queue = new Queue(adapter);
 *   const job = await queue.enqueue('send-email', { to, subject });
 *   const next = await queue.dequeue('send-email');
 *   await queue.complete(next);
 *   await queue.fail(next, new Error('permanent failure'));
 *
 * Retry/backoff+jitter:
 *   On fail, if attempts < maxAttempts, the job is re-scheduled with
 *   exponential backoff + full jitter.  If maxAttempts exhausted, the
 *   job is moved to the Dead Letter Queue (DLQ).
 *
 * Idempotency:
 *   Enqueue with the same dedupKey while a pending/active/delayed job
 *   exists returns the existing job (no duplicate).
 *
 * DLQ / Replay:
 *   Exhausted-retry jobs land in the DLQ.  replay() moves them back to
 *   pending status for re-processing.
 */

import type { IQueueAdapter, QueueJob, EnqueueOptions, DequeueOptions } from './types.js';
import { computeBackoffMs } from './types.js';

export interface QueueOptions {
  /** Base backoff delay in ms (default: 1000). */
  backoffBaseMs?: number;
  /** Maximum backoff delay in ms (default: 60_000). */
  backoffMaxMs?: number;
  /** Default max attempts (default: 3). */
  defaultMaxAttempts?: number;
  /** Override wall-clock source for deterministic tests. */
  clock?: () => string;
}

export class Queue {
  private adapter: IQueueAdapter;
  private backoffBaseMs: number;
  private backoffMaxMs: number;
  private defaultMaxAttempts: number;
  private clock: () => string;

  constructor(adapter: IQueueAdapter, options: QueueOptions = {}) {
    this.adapter = adapter;
    this.backoffBaseMs = options.backoffBaseMs ?? 1000;
    this.backoffMaxMs = options.backoffMaxMs ?? 60_000;
    this.defaultMaxAttempts = options.defaultMaxAttempts ?? 3;
    this.clock = options.clock ?? (() => new Date().toISOString());
  }

  /**
   * Enqueue a new job.
   *
   * If `dedupKey` is provided and a job with the same key exists in a
   * non-terminal state (pending / active / delayed), the existing job
   * is returned instead of creating a duplicate.
   */
  async enqueue<T = unknown>(
    name: string,
    payload: T,
    options: EnqueueOptions = {},
  ): Promise<QueueJob<T>> {
    const now = this.clock();
    const scheduledAt = options.scheduledAt
      ? (typeof options.scheduledAt === 'string' ? options.scheduledAt : options.scheduledAt.toISOString())
      : now;

    const job = await this.adapter.enqueue({
      name,
      payload,
      dedupKey: options.dedupKey,
      attempts: 0,
      maxAttempts: options.maxAttempts ?? this.defaultMaxAttempts,
      priority: options.priority ?? 0,
      scheduledAt,
    });

    return job as QueueJob<T>;
  }

  /**
   * Dequeue the next available job(s) for processing.
   *
   * Returns null when no jobs are available.  Dequeued jobs are marked
   * as 'active' and have their attempt counter incremented.
   */
  async dequeue<T = unknown>(
    name: string,
    options: DequeueOptions = {},
  ): Promise<QueueJob<T> | null> {
    const batchSize = options.batchSize ?? 1;
    const jobs = await this.adapter.dequeue(name, batchSize);
    if (jobs.length === 0) return null;
    return jobs[0] as QueueJob<T>;
  }

  /**
   * Dequeue a batch of jobs.
   */
  async dequeueBatch<T = unknown>(
    name: string,
    batchSize: number = 5,
  ): Promise<QueueJob<T>[]> {
    const jobs = await this.adapter.dequeue(name, batchSize);
    return jobs as QueueJob<T>[];
  }

  /**
   * Mark a job as successfully completed.
   */
  async complete<T>(job: QueueJob<T>): Promise<void> {
    await this.adapter.complete(job.id);
  }

  /**
   * Mark a job as failed.
   *
   * If the job has remaining retry attempts, it is re-scheduled with
   * exponential backoff + full jitter.  If all attempts are exhausted,
   * the job is moved to the Dead Letter Queue.
   *
   * Returns the DLQ job if moved to DLQ, or the re-scheduled job
   * if scheduled for retry, or undefined if already terminal.
   */
  async fail<T>(
    job: QueueJob<T>,
    error: Error | string,
  ): Promise<QueueJob | undefined> {
    const errorMessage = typeof error === 'string' ? error : error.message;

    // Re-fetch the latest status to handle stale job references.
    const fresh = await this.adapter.getById(job.id);
    if (!fresh || fresh.status === 'completed' || fresh.status === 'failed') {
      return undefined; // already terminal, no-op
    }

    // Check if retries remain.
    if (fresh.attempts < fresh.maxAttempts) {
      // Schedule retry with backoff+jitter.
      const delayMs = computeBackoffMs(
        fresh.attempts - 1, // use zero-based attempt index
        this.backoffBaseMs,
        this.backoffMaxMs,
      );
      const scheduledAt = new Date(Date.parse(this.clock()) + delayMs).toISOString();

      await this.adapter.fail(job.id, errorMessage);
      await this.adapter.scheduleRetry(job.id, scheduledAt);

      const updated = await this.adapter.getById(job.id);
      return updated ?? undefined;
    } else {
      // Exhausted retries → move to DLQ.
      const dlqJob = await this.adapter.moveToDlq(job.id, errorMessage);
      return dlqJob;
    }
  }

  /**
   * Replay a DLQ job back to pending status.
   *
   * Returns the replayed job with a new ID and reset attempt counter.
   */
  async replay(jobId: string): Promise<QueueJob> {
    return this.adapter.replay(jobId);
  }

  /**
   * List all jobs currently in the DLQ.
   */
  async getDlqJobs(): Promise<QueueJob[]> {
    return this.adapter.getDlqJobs();
  }

  /**
   * Get a job by ID (from main queue or DLQ).
   */
  async getById(jobId: string): Promise<QueueJob | null> {
    return this.adapter.getById(jobId);
  }
}
