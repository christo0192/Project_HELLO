/**
 * L1 queue (REL-01/04): Deterministic in-memory adapter for tests.
 *
 * Implements IQueueAdapter with Postgres-compatible lock-free dequeue
 * semantics using a predictable clock and no randomness.
 *
 * Semantics:
 *  - enqueue: idempotent via dedupKey (existing pending/active/delayed job
 *    is returned instead of creating a duplicate).
 *  - dequeue: returns up to batchSize jobs ordered by priority DESC then
 *    scheduledAt ASC, for the given queue name, that are pending or delayed
 *    with scheduledAt <= now.  Marks them 'active'.
 *  - complete, fail, scheduleRetry: mutate in-place.
 *  - moveToDlq: moves job to DLQ store.
 *  - replay: moves DLQ job back as new pending job.
 */

import type {
  IQueueAdapter,
  ILeasedQueueAdapter,
  QueueJob,
  QueueStatus,
  EnqueueInput,
  DeferOutcome,
  FailOutcome,
  LeaseMutationOutcome,
  ReclaimResult,
} from './types.js';
import {
  ACTIVE_STATUSES,
  MAX_VISIBILITY_SECONDS,
  clampDeferSeconds,
  isValidDeferReason,
} from './types.js';

/** A concrete job row for the in-memory store. */
interface JobRow {
  id: string;
  name: string;
  payload: unknown;
  status: QueueStatus;
  dedupKey: string | undefined;
  attempts: number;
  maxAttempts: number;
  priority: number;
  scheduledAt: string;
  startedAt: string | undefined;
  completedAt: string | undefined;
  failedAt: string | undefined;
  errorMessage: string | undefined;
  createdAt: string;
  leaseToken: string | undefined;
  leaseOwner: string | undefined;
  leaseExpiresAt: string | undefined;
  leaseDeadlineAt: string | undefined;
  deferReason: string | undefined;
  deferredAt: string | undefined;
  deferCount: number;
}

let NEXT_ID = 1;
let NEXT_LEASE = 1;

function nextId(): string {
  return `mem-job-${String(NEXT_ID++).padStart(8, '0')}`;
}

/**
 * Deterministic lease-token generator for tests. Production leases use
 * gen_random_uuid() in Postgres (genuinely unguessable); the in-memory
 * adapter uses a monotonic opaque counter so unit tests stay deterministic
 * while still proving compare-and-set against a distinct token value.
 */
function nextLeaseToken(): string {
  return `mem-lease-${String(NEXT_LEASE++).padStart(8, '0')}`;
}

/** Add `seconds` to an ISO instant, returning a new ISO string. */
function addSeconds(iso: string, seconds: number): string {
  return new Date(Date.parse(iso) + seconds * 1000).toISOString();
}

/** Earlier of two ISO instants. */
function minIso(a: string, b: string): string {
  return Date.parse(a) <= Date.parse(b) ? a : b;
}

/** Clear all lease/visibility fields on a row in place. */
function clearLease(row: JobRow): void {
  row.leaseToken = undefined;
  row.leaseOwner = undefined;
  row.leaseExpiresAt = undefined;
  row.leaseDeadlineAt = undefined;
}

/** Clear the deferral marker on a row in place (any non-deferral outcome). */
function clearDefer(row: JobRow): void {
  row.deferReason = undefined;
  row.deferredAt = undefined;
}

export interface MemoryAdapterDeps {
  clock?: () => string;
}

export class MemoryAdapter implements ILeasedQueueAdapter {
  private jobs: Map<string, JobRow> = new Map();
  private dlq: Map<string, JobRow> = new Map();
  private dedupIndex: Map<string, string> = new Map(); // dedupKey → jobId
  private clock: () => string;

  constructor(deps: MemoryAdapterDeps = {}) {
    this.clock = deps.clock ?? (() => new Date().toISOString());
  }

  /** Reset all state — call between tests. */
  reset(): void {
    this.jobs.clear();
    this.dlq.clear();
    this.dedupIndex.clear();
  }

  async enqueue(
    job: EnqueueInput,
  ): Promise<QueueJob> {
    const now = this.clock();

    // Idempotency: dedupKey collision on active jobs returns existing.
    if (job.dedupKey) {
      const existingId = this.dedupIndex.get(job.dedupKey);
      if (existingId) {
        const existing = this.jobs.get(existingId);
        if (existing && ACTIVE_STATUSES.includes(existing.status)) {
          return this.rowToJob(existing);
        }
        // If the existing job is completed/failed, allow re-enqueue.
        // Remove from dedupIndex if terminal.
        if (existing && (existing.status === 'completed' || existing.status === 'failed')) {
          this.dedupIndex.delete(job.dedupKey);
        }
      }
    }

    const id = nextId();
    const row: JobRow = {
      id,
      name: job.name,
      payload: job.payload,
      status: 'pending',
      dedupKey: job.dedupKey,
      attempts: job.attempts,
      maxAttempts: job.maxAttempts,
      priority: job.priority,
      scheduledAt: job.scheduledAt,
      startedAt: undefined,
      completedAt: undefined,
      failedAt: undefined,
      errorMessage: undefined,
      createdAt: now,
      leaseToken: undefined,
      leaseOwner: undefined,
      leaseExpiresAt: undefined,
      leaseDeadlineAt: undefined,
      deferReason: undefined,
      deferredAt: undefined,
      deferCount: 0,
    };

    this.jobs.set(id, row);
    if (row.dedupKey) {
      this.dedupIndex.set(row.dedupKey, id);
    }

    return this.rowToJob(row);
  }

  async dequeue(queueName: string, batchSize: number = 1): Promise<QueueJob[]> {
    const now = this.clock();

    // Find eligible jobs: pending/delayed, name matches, scheduledAt <= now.
    // Order by priority DESC, scheduledAt ASC.
    const eligible: JobRow[] = [];
    for (const row of this.jobs.values()) {
      if (row.status === 'completed' || row.status === 'failed' || row.status === 'active') continue;
      if (row.name !== queueName) continue;
      if (row.scheduledAt > now) continue;
      eligible.push(row);
    }

    eligible.sort((a, b) => {
      // Higher priority first
      if (b.priority !== a.priority) return b.priority - a.priority;
      // Earlier scheduledAt first
      return a.scheduledAt.localeCompare(b.scheduledAt);
    });

    const batch = eligible.slice(0, batchSize);
    const now2 = this.clock(); // re-read for deterministic multi-step tests

    for (const row of batch) {
      row.status = 'active';
      row.startedAt = now2;
      row.attempts += 1;
    }

    return batch.map(r => this.rowToJob(r));
  }

  async complete(jobId: string): Promise<void> {
    const row = this.jobs.get(jobId);
    if (!row) throw new Error(`Job ${jobId} not found`);
    const now = this.clock();
    row.status = 'completed';
    row.completedAt = now;
  }

  async fail(jobId: string, errorMessage: string): Promise<void> {
    const row = this.jobs.get(jobId);
    if (!row) throw new Error(`Job ${jobId} not found`);
    const now = this.clock();
    row.status = 'failed';
    row.failedAt = now;
    row.errorMessage = errorMessage;
  }

  async scheduleRetry(jobId: string, scheduledAt: string): Promise<void> {
    const row = this.jobs.get(jobId);
    if (!row) throw new Error(`Job ${jobId} not found`);
    row.status = 'delayed';
    row.scheduledAt = scheduledAt;
  }

  async moveToDlq(jobId: string, errorMessage: string): Promise<QueueJob> {
    const row = this.jobs.get(jobId);
    if (!row) throw new Error(`Job ${jobId} not found`);

    const now = this.clock();
    row.status = 'failed';
    row.failedAt = now;
    row.errorMessage = errorMessage;

    // Remove from main store, copy to DLQ.
    this.jobs.delete(jobId);
    const dlqRow: JobRow = { ...row, status: 'failed', failedAt: now };
    this.dlq.set(jobId, dlqRow);

    if (row.dedupKey) {
      this.dedupIndex.delete(row.dedupKey);
    }

    return this.rowToJob(dlqRow);
  }

  async replay(jobId: string): Promise<QueueJob> {
    const dlqRow = this.dlq.get(jobId);
    if (!dlqRow) throw new Error(`DLQ job ${jobId} not found`);

    this.dlq.delete(jobId);

    const now = this.clock();
    const newRow: JobRow = {
      id: nextId(),
      name: dlqRow.name,
      payload: dlqRow.payload,
      status: 'pending',
      dedupKey: undefined, // new dedup cycle
      attempts: 0,
      maxAttempts: dlqRow.maxAttempts,
      priority: dlqRow.priority,
      scheduledAt: now,
      startedAt: undefined,
      completedAt: undefined,
      failedAt: undefined,
      errorMessage: undefined,
      createdAt: now,
      leaseToken: undefined,
      leaseOwner: undefined,
      leaseExpiresAt: undefined,
      leaseDeadlineAt: undefined,
      deferReason: undefined,
      deferredAt: undefined,
      deferCount: 0,
    };

    this.jobs.set(newRow.id, newRow);
    return this.rowToJob(newRow);
  }

  async getById(jobId: string): Promise<QueueJob | null> {
    const row = this.jobs.get(jobId) ?? this.dlq.get(jobId) ?? null;
    return row ? this.rowToJob(row) : null;
  }

  async getDlqJobs(): Promise<QueueJob[]> {
    return [...this.dlq.values()].map(r => this.rowToJob(r));
  }

  // ═══════════════════════════════════════════════════════════════════
  // Lease-safe claim path (0028) — parity with the Postgres RPCs.
  // ═══════════════════════════════════════════════════════════════════

  /**
   * Atomically claim the next eligible job (pending/delayed, scheduledAt<=now)
   * ordered by priority DESC, scheduledAt ASC. Grants a fresh unguessable
   * lease token, an owner, a bounded lease window, and an absolute visibility
   * deadline. Increments attempts (a claim is a delivery). Returns null when
   * nothing is eligible. Single-threaded execution models FOR UPDATE SKIP
   * LOCKED: a second concurrent claim sees the job already active and skips it.
   */
  async claim(
    queueName: string,
    nowIso: string,
    leaseSeconds: number,
    owner?: string,
  ): Promise<QueueJob | null> {
    const eligible: JobRow[] = [];
    for (const row of this.jobs.values()) {
      if (row.name !== queueName) continue;
      if (row.status !== 'pending' && row.status !== 'delayed') continue;
      if (row.scheduledAt > nowIso) continue;
      eligible.push(row);
    }
    if (eligible.length === 0) return null;

    eligible.sort((a, b) => {
      if (b.priority !== a.priority) return b.priority - a.priority;
      return a.scheduledAt.localeCompare(b.scheduledAt);
    });

    const row = eligible[0];
    row.status = 'active';
    row.startedAt = nowIso;
    row.attempts += 1;
    row.leaseToken = nextLeaseToken();
    row.leaseOwner = owner;
    row.leaseExpiresAt = addSeconds(nowIso, leaseSeconds);
    row.leaseDeadlineAt = addSeconds(nowIso, MAX_VISIBILITY_SECONDS);
    return this.rowToJob(row);
  }

  /** True iff `row` is currently held by a live (unexpired) matching lease. */
  private holdsLiveLease(row: JobRow, leaseToken: string, nowIso: string): boolean {
    return (
      row.status === 'active' &&
      row.leaseToken !== undefined &&
      row.leaseToken === leaseToken &&
      row.leaseExpiresAt !== undefined &&
      row.leaseExpiresAt > nowIso
    );
  }

  async heartbeat(
    jobId: string,
    leaseToken: string,
    nowIso: string,
    leaseSeconds: number,
  ): Promise<LeaseMutationOutcome> {
    const row = this.jobs.get(jobId);
    if (!row || !this.holdsLiveLease(row, leaseToken, nowIso)) return 'not_owned';
    // Extend, but never beyond the absolute visibility deadline.
    const requested = addSeconds(nowIso, leaseSeconds);
    row.leaseExpiresAt = row.leaseDeadlineAt
      ? minIso(requested, row.leaseDeadlineAt)
      : requested;
    return 'ok';
  }

  async completeLeased(
    jobId: string,
    leaseToken: string,
    nowIso: string,
  ): Promise<LeaseMutationOutcome> {
    const row = this.jobs.get(jobId);
    if (!row || !this.holdsLiveLease(row, leaseToken, nowIso)) return 'not_owned';
    row.status = 'completed';
    row.completedAt = nowIso;
    clearLease(row);
    clearDefer(row);
    if (row.dedupKey) this.dedupIndex.delete(row.dedupKey);
    return 'ok';
  }

  async failLeased(
    jobId: string,
    leaseToken: string,
    nowIso: string,
    errorMessage: string,
    retryAtIso: string,
  ): Promise<FailOutcome> {
    const row = this.jobs.get(jobId);
    if (!row || !this.holdsLiveLease(row, leaseToken, nowIso)) return 'not_owned';

    if (row.attempts < row.maxAttempts) {
      // Retry: clear lease ownership and schedule a future delivery.
      row.status = 'delayed';
      row.scheduledAt = retryAtIso;
      row.errorMessage = errorMessage;
      clearLease(row);
      // A retry is not a wait: drop the deferral marker so a failing job is
      // never counted as one blocked on a prerequisite.
      clearDefer(row);
      return 'retry_scheduled';
    }
    // Exhausted: move to the DLQ in one step (no insert-then-delete gap).
    this.dlqMove(row, nowIso, errorMessage);
    return 'dead_lettered';
  }

  /**
   * Parity with the 0037 `defer_job` RPC: CAS on the live lease, return to
   * `delayed` behind a clamped delay, and REFUND the attempt the claim
   * charged. Never fails, never dead-letters, never writes error text — a job
   * that could not start has no error to report.
   */
  async deferLeased(
    jobId: string,
    leaseToken: string,
    nowIso: string,
    reasonCode: string,
    delaySeconds: number,
  ): Promise<DeferOutcome> {
    if (!isValidDeferReason(reasonCode)) return 'invalid_reason';
    const row = this.jobs.get(jobId);
    if (!row || !this.holdsLiveLease(row, leaseToken, nowIso)) return 'not_owned';

    const delay = clampDeferSeconds(delaySeconds);
    row.status = 'delayed';
    row.scheduledAt = addSeconds(nowIso, delay);
    row.attempts = Math.max(0, row.attempts - 1);
    row.errorMessage = undefined;
    row.startedAt = undefined;
    // Keep the ORIGINAL wait start while the same reason repeats, so a job
    // deferred 120 times over an hour reports an hour of waiting.
    row.deferredAt = row.deferReason === reasonCode && row.deferredAt !== undefined
      ? row.deferredAt
      : nowIso;
    row.deferReason = reasonCode;
    row.deferCount += 1;
    clearLease(row);
    return 'deferred';
  }

  async reclaimExpired(nowIso: string, limit: number = 100): Promise<ReclaimResult> {
    const result: ReclaimResult = { requeued: [], deadLettered: [] };
    const expired: JobRow[] = [];
    for (const row of this.jobs.values()) {
      if (row.status !== 'active') continue;
      if (row.leaseExpiresAt === undefined || row.leaseExpiresAt > nowIso) continue;
      expired.push(row);
    }
    // Deterministic order: oldest expiry first.
    expired.sort((a, b) => (a.leaseExpiresAt as string).localeCompare(b.leaseExpiresAt as string));

    for (const row of expired.slice(0, limit)) {
      if (row.attempts < row.maxAttempts) {
        // Return to the pool; a fresh claim will grant a new lease + attempt.
        row.status = 'pending';
        row.scheduledAt = nowIso;
        clearLease(row);
        result.requeued.push(row.id);
      } else {
        // Attempts exhausted — dead-letter deterministically (never bypass max).
        const id = row.id;
        this.dlqMove(row, nowIso, 'lease_expired_attempts_exhausted');
        result.deadLettered.push(id);
      }
    }
    return result;
  }

  async replayDlq(dlqId: string, nowIso: string): Promise<QueueJob | null> {
    const dlqRow = this.dlq.get(dlqId);
    // Concurrent replay: the first caller removes the row; the second sees
    // nothing and returns null, so exactly one pending replacement is created.
    if (!dlqRow) return null;
    this.dlq.delete(dlqId);

    const newRow: JobRow = {
      id: nextId(),
      name: dlqRow.name,
      payload: dlqRow.payload,
      status: 'pending',
      dedupKey: undefined, // new dedup cycle
      attempts: 0,
      maxAttempts: dlqRow.maxAttempts,
      priority: dlqRow.priority,
      scheduledAt: nowIso,
      startedAt: undefined,
      completedAt: undefined,
      failedAt: undefined,
      errorMessage: undefined,
      createdAt: nowIso,
      leaseToken: undefined,
      leaseOwner: undefined,
      leaseExpiresAt: undefined,
      leaseDeadlineAt: undefined,
      deferReason: undefined,
      deferredAt: undefined,
      deferCount: 0,
    };
    this.jobs.set(newRow.id, newRow);
    return this.rowToJob(newRow);
  }

  /** Shared DLQ move: remove from the live store, copy to the DLQ store. */
  private dlqMove(row: JobRow, nowIso: string, errorMessage: string): void {
    row.status = 'failed';
    row.failedAt = nowIso;
    row.errorMessage = errorMessage;
    clearLease(row);
    this.jobs.delete(row.id);
    if (row.dedupKey) this.dedupIndex.delete(row.dedupKey);
    this.dlq.set(row.id, { ...row });
  }

  private rowToJob(row: JobRow): QueueJob {
    return {
      id: row.id,
      name: row.name,
      payload: row.payload as Record<string, unknown>,
      status: row.status,
      dedupKey: row.dedupKey,
      attempts: row.attempts,
      maxAttempts: row.maxAttempts,
      priority: row.priority,
      scheduledAt: row.scheduledAt,
      startedAt: row.startedAt,
      completedAt: row.completedAt,
      failedAt: row.failedAt,
      errorMessage: row.errorMessage,
      createdAt: row.createdAt,
      leaseToken: row.leaseToken,
      leaseOwner: row.leaseOwner,
      leaseExpiresAt: row.leaseExpiresAt,
      leaseDeadlineAt: row.leaseDeadlineAt,
      deferReason: row.deferReason,
      deferredAt: row.deferredAt,
      deferCount: row.deferCount,
    };
  }
}
