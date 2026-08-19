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

import type {
  IQueueAdapter,
  ILeasedQueueAdapter,
  QueueJob,
  EnqueueOptions,
  DequeueOptions,
  ClaimOptions,
  DeferOutcome,
  FailOutcome,
  ReclaimResult,
} from './types.js';
import {
  computeBackoffMs,
  clampLeaseSeconds,
  clampDeferSeconds,
  DEFAULT_DEFER_SECONDS,
} from './types.js';

/** Stable sanitized error code — adapter does not support the lease API. */
export const ERR_LEASE_UNSUPPORTED = 'ERR_LEASE_UNSUPPORTED';

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

  // ═══════════════════════════════════════════════════════════════════
  // Lease-safe claim API (0028 — Ashby queue hardening, plan Step 2)
  // ═══════════════════════════════════════════════════════════════════
  //
  // Ashby workers use this path exclusively. Each claim grants an
  // unguessable lease token bound to a bounded visibility window; every
  // mutation is a compare-and-set on the live lease, so a stale worker
  // whose lease expired or was reclaimed fails closed.

  /** Narrow the adapter to the leased seam or throw a stable sanitized error. */
  private leased(): ILeasedQueueAdapter {
    const a = this.adapter as Partial<ILeasedQueueAdapter>;
    if (typeof a.claim !== 'function' || typeof a.completeLeased !== 'function') {
      throw new Error(ERR_LEASE_UNSUPPORTED);
    }
    return this.adapter as ILeasedQueueAdapter;
  }

  /**
   * Atomically claim the next eligible job, granting a bounded lease.
   * Returns the claimed job (with `leaseToken` populated) or null.
   */
  async claim<T = unknown>(name: string, options: ClaimOptions = {}): Promise<QueueJob<T> | null> {
    const leaseSeconds = clampLeaseSeconds(options.leaseSeconds);
    const now = this.clock();
    const job = await this.leased().claim(name, now, leaseSeconds, options.owner);
    return (job as QueueJob<T> | null) ?? null;
  }

  /**
   * Extend a live matching lease. Bounded by the job's absolute visibility
   * deadline. Returns true when extended, false when the lease is lost
   * (expired, reclaimed, or token mismatch) — the worker must stop.
   */
  async heartbeat(jobId: string, leaseToken: string, options: { leaseSeconds?: number } = {}): Promise<boolean> {
    const leaseSeconds = clampLeaseSeconds(options.leaseSeconds);
    const outcome = await this.leased().heartbeat(jobId, leaseToken, this.clock(), leaseSeconds);
    return outcome === 'ok';
  }

  /**
   * Complete a job under the live matching lease. Returns true on success,
   * false when the caller no longer owns the lease. Clears lease fields.
   */
  async completeClaim(jobId: string, leaseToken: string): Promise<boolean> {
    const outcome = await this.leased().completeLeased(jobId, leaseToken, this.clock());
    return outcome === 'ok';
  }

  /**
   * Fail a job under the live matching lease. Retries with backoff+jitter
   * while attempts remain (clearing the lease and scheduling a delayed
   * re-delivery), else moves it to the DLQ in one server-side transaction.
   * Returns 'not_owned' for a stale/mismatched lease (fails closed).
   */
  async failClaim(jobId: string, leaseToken: string, error: Error | string): Promise<FailOutcome> {
    const errorMessage = typeof error === 'string' ? error : error.message;
    const now = this.clock();
    // Compute a retry instant from the current attempt count. The adapter
    // decides retry-vs-DLQ from attempts vs maxAttempts under the lease guard;
    // retryAt is ignored on the DLQ branch.
    const fresh = await this.adapter.getById(jobId);
    const attemptIndex = fresh ? Math.max(0, fresh.attempts - 1) : 0;
    const delayMs = computeBackoffMs(attemptIndex, this.backoffBaseMs, this.backoffMaxMs);
    const retryAt = new Date(Date.parse(now) + delayMs).toISOString();
    return this.leased().failLeased(jobId, leaseToken, now, errorMessage, retryAt);
  }

  /**
   * DEFER a job under the live matching lease: the work never started because
   * a prerequisite was not met, so the attempt the claim charged is refunded
   * and the job returns to `delayed` behind a clamped delay (1..3600s).
   *
   * This is a third outcome alongside complete and fail, not a flavour of
   * fail: it never dead-letters, never writes error text, and never raises
   * maxAttempts, so an unbounded wait costs an unbounded number of cheap polls
   * and exactly zero of the job's failure budget.
   *
   * Returns 'not_owned' for a stale/mismatched lease (fails closed) and
   * 'invalid_reason' for a reason code outside the sanitized allowlist.
   */
  async deferClaim(
    jobId: string,
    leaseToken: string,
    reasonCode: string,
    delaySeconds: number = DEFAULT_DEFER_SECONDS,
  ): Promise<DeferOutcome> {
    const leased = this.leased();
    if (typeof leased.deferLeased !== 'function') throw new Error(ERR_LEASE_UNSUPPORTED);
    return leased.deferLeased(
      jobId, leaseToken, this.clock(), reasonCode, clampDeferSeconds(delaySeconds),
    );
  }

  /**
   * Reclaim expired active jobs: requeue while attempts remain, else
   * dead-letter deterministically (never bypassing maxAttempts).
   */
  async reclaimExpired(options: { limit?: number } = {}): Promise<ReclaimResult> {
    return this.leased().reclaimExpired(this.clock(), options.limit);
  }

  /**
   * Transactionally replay a DLQ job as exactly one new pending job.
   * Returns the new job, or null when the DLQ entry was already consumed
   * (concurrent replay cannot duplicate).
   */
  async replayDlq(dlqId: string): Promise<QueueJob | null> {
    return this.leased().replayDlq(dlqId, this.clock());
  }
}
