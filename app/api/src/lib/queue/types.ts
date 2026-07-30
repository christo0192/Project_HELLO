/**
 * L1 queue (REL-01/04): Types and interfaces for pg-boss-compatible queue
 * abstraction.
 *
 * DESIGN:
 *  - IQueueAdapter is the seam: MemoryAdapter for tests, PgAdapter for prod.
 *  - QueueJob holds typed payload, status, retry/backoff metadata.
 *  - dedupKey enables idempotent enqueue: a pending/active/delayed job with
 *    the same key returns the existing job instead of creating a duplicate.
 *  - Exhausted retries move to DLQ; replay moves back to pending status.
 */

export type QueueStatus = 'pending' | 'active' | 'completed' | 'failed' | 'delayed';

/** All non-terminal statuses that can be worked on. */
export const ACTIVE_STATUSES: readonly QueueStatus[] = ['pending', 'active', 'delayed'];

/** Terminal statuses — no further processing. */
export const TERMINAL_STATUSES: readonly QueueStatus[] = ['completed', 'failed'];

/** SQL-level DLQ status — used only for DLQ rows. */
export const DLQ_STATUS: QueueStatus = 'failed';

export interface QueueJob<T = unknown> {
  id: string;
  name: string;
  payload: T;
  status: QueueStatus;
  dedupKey?: string;
  attempts: number;
  maxAttempts: number;
  priority: number;
  scheduledAt: string;   // ISO-8601 UTC
  startedAt?: string;
  completedAt?: string;
  failedAt?: string;
  errorMessage?: string;
  createdAt: string;
}

export interface EnqueueOptions {
  /** Optional deduplication key — same key + pending/active/delayed = no-op. */
  dedupKey?: string;
  /** Max retry attempts before moving to DLQ (default: 3). */
  maxAttempts?: number;
  /** Priority (higher = dequeued first, default: 0). */
  priority?: number;
  /** Schedule for future delivery (default: now). */
  scheduledAt?: string | Date;
}

export interface DequeueOptions {
  /** Max jobs to dequeue at once (default: 1). */
  batchSize?: number;
}

/**
 * Queue adapter seam.
 *
 * Implementations must provide deterministic Postgres-compatible semantics:
 *  - enqueue is idempotent via dedupKey
 *  - dequeue returns the next eligible job(s) ordered by priority, scheduledAt
 *  - complete/fail update job status atomically
 *  - moveToDlq transfers the job to a dead-letter store
 *  - replay moves a DLQ job back to pending status
 */
/** Input shape for adapter.enqueue — no id/createdAt/status (adapter sets those). */
export type EnqueueInput = Omit<QueueJob, 'id' | 'createdAt' | 'status'> & { status?: QueueStatus };

export interface IQueueAdapter {
  /** Insert a new job. Returns the created job. */
  enqueue(job: EnqueueInput): Promise<QueueJob>;

  /** Claim the next eligible batch of jobs for processing. */
  dequeue(queueName: string, batchSize?: number): Promise<QueueJob[]>;

  /** Mark job as completed. */
  complete(jobId: string): Promise<void>;

  /** Mark job as failed with an error message. */
  fail(jobId: string, errorMessage: string): Promise<void>;

  /** Schedule a job for retry at a future time. */
  scheduleRetry(jobId: string, scheduledAt: string): Promise<void>;

  /** Move job to DLQ after exhausting retries. Returns the DLQ entry. */
  moveToDlq(jobId: string, errorMessage: string): Promise<QueueJob>;

  /** Replay a DLQ job back to pending status. Returns the replayed job. */
  replay(jobId: string): Promise<QueueJob>;

  /** Get job by ID. */
  getById(jobId: string): Promise<QueueJob | null>;

  /** List all DLQ jobs. */
  getDlqJobs(): Promise<QueueJob[]>;
}

/**
 * Compute exponential backoff delay with full jitter (ms).
 *
 * Formula: min(baseMs * 2^attempt, maxMs) * (0.5 + Math.random() * 0.5)
 */
export function computeBackoffMs(
  attempt: number,
  baseMs: number = 1000,
  maxMs: number = 60_000,
): number {
  const exponential = Math.min(baseMs * Math.pow(2, attempt), maxMs);
  const jitter = 0.5 + Math.random() * 0.5;
  return Math.round(exponential * jitter);
}

/**
 * Deterministic backoff (for tests). Same formula but with seeded jitter
 * coefficient provided as `jitterCoeff` (0.5 … 1.0).
 */
export function computeBackoffMsDeterministic(
  attempt: number,
  jitterCoeff: number,
  baseMs: number = 1000,
  maxMs: number = 60_000,
): number {
  const exponential = Math.min(baseMs * Math.pow(2, attempt), maxMs);
  return Math.round(exponential * jitterCoeff);
}
