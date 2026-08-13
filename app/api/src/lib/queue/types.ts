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
  // ── Lease/visibility fields (0028) — populated only on the lease-safe
  //    claim path. An unclaimed job has all four undefined. These are opaque
  //    operational values; leaseToken is an unguessable owner secret and MUST
  //    NEVER be logged. ──
  /** Unguessable owner token for the current active claim (uuid). */
  leaseToken?: string;
  /** Opaque worker identity that holds the current claim. */
  leaseOwner?: string;
  /** When the current lease expires and the job becomes reclaimable. */
  leaseExpiresAt?: string;
  /** Absolute maximum visibility deadline; heartbeats cannot extend past it. */
  leaseDeadlineAt?: string;
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

// ═══════════════════════════════════════════════════════════════════════
// Lease-safe claim model (0028 — Ashby queue hardening, plan Step 2)
// ═══════════════════════════════════════════════════════════════════════
//
// A worker CLAIMS a job instead of a fire-and-forget dequeue. The claim
// grants an unguessable lease token, an owner, and a bounded visibility
// window (leaseExpiresAt). Every subsequent worker mutation (heartbeat,
// complete, fail/retry/DLQ) is a compare-and-set on (job id + active status
// + matching live lease token). A stale worker whose lease expired or whose
// token no longer matches fails closed. Expired active jobs are reclaimable:
// requeued while attempts remain, dead-lettered once attempts are exhausted,
// so reclaim never bypasses maxAttempts and no job is silently lost.

/** Default visibility window granted by a single claim (seconds). */
export const DEFAULT_LEASE_SECONDS = 30;
/** Minimum lease window; claim/heartbeat inputs are clamped up to this. */
export const MIN_LEASE_SECONDS = 1;
/** Maximum window a single claim/heartbeat may grant (seconds). */
export const MAX_LEASE_SECONDS = 900;
/** Absolute maximum total visibility a job may hold across heartbeats. */
export const MAX_VISIBILITY_SECONDS = 3600;

/** Clamp a requested lease window into [MIN_LEASE_SECONDS, MAX_LEASE_SECONDS]. */
export function clampLeaseSeconds(seconds: number | undefined): number {
  const s = typeof seconds === 'number' && Number.isFinite(seconds)
    ? Math.floor(seconds)
    : DEFAULT_LEASE_SECONDS;
  if (s < MIN_LEASE_SECONDS) return MIN_LEASE_SECONDS;
  if (s > MAX_LEASE_SECONDS) return MAX_LEASE_SECONDS;
  return s;
}

/** Options for a lease-safe claim. */
export interface ClaimOptions {
  /** Requested visibility window in seconds (clamped). */
  leaseSeconds?: number;
  /** Opaque worker identity recorded as the lease owner. */
  owner?: string;
}

/** Outcome of a lease-guarded fail. */
export type FailOutcome = 'retry_scheduled' | 'dead_lettered' | 'not_owned';

/** Outcome of a lease-guarded complete/heartbeat. */
export type LeaseMutationOutcome = 'ok' | 'not_owned';

/** Per-job outcome of an expired-lease reclaim sweep. */
export type ReclaimOutcome = 'requeued' | 'dead_lettered';

/** Result of reclaiming expired active jobs. */
export interface ReclaimResult {
  /** Job ids returned to `pending` (attempts still remaining). */
  requeued: string[];
  /** Job ids moved to the DLQ (attempts exhausted). */
  deadLettered: string[];
}

/**
 * Lease-safe extension of the queue seam.
 *
 * Implementations MUST provide atomic Postgres-compatible semantics:
 *  - claim uses FOR UPDATE SKIP LOCKED so exactly one worker wins a job.
 *  - heartbeat/complete/fail are compare-and-set on the live lease token and
 *    are no-ops (returning 'not_owned') for a stale/mismatched/expired lease.
 *  - reclaimExpired requeues or dead-letters expired active jobs without ever
 *    bypassing maxAttempts.
 *  - moveToDlq and replay are single server-side transactions with no
 *    insert-then-delete client gap; concurrent replay yields exactly one job.
 */
export interface ILeasedQueueAdapter extends IQueueAdapter {
  /** Atomically claim the next eligible job, granting a bounded lease. */
  claim(queueName: string, nowIso: string, leaseSeconds: number, owner?: string): Promise<QueueJob | null>;

  /** Extend a live matching lease, bounded by the absolute visibility deadline. */
  heartbeat(jobId: string, leaseToken: string, nowIso: string, leaseSeconds: number): Promise<LeaseMutationOutcome>;

  /** Complete a job iff the caller holds the live matching lease; clears lease fields. */
  completeLeased(jobId: string, leaseToken: string, nowIso: string): Promise<LeaseMutationOutcome>;

  /**
   * Fail a job under the live matching lease. Retries (clearing the lease and
   * scheduling `retryAtIso`) while attempts remain, else moves to the DLQ in a
   * single transaction.
   */
  failLeased(jobId: string, leaseToken: string, nowIso: string, errorMessage: string, retryAtIso: string): Promise<FailOutcome>;

  /** Reclaim expired active jobs: requeue while attempts remain, else DLQ. */
  reclaimExpired(nowIso: string, limit?: number): Promise<ReclaimResult>;

  /** Transactionally replay a DLQ job as one new pending job; null if already consumed. */
  replayDlq(dlqId: string, nowIso: string): Promise<QueueJob | null>;
}
