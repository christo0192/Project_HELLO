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

import type { IQueueAdapter, QueueJob, QueueStatus, EnqueueInput } from './types.js';
import { ACTIVE_STATUSES } from './types.js';

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
}

let NEXT_ID = 1;

function nextId(): string {
  return `mem-job-${String(NEXT_ID++).padStart(8, '0')}`;
}

export interface MemoryAdapterDeps {
  clock?: () => string;
}

export class MemoryAdapter implements IQueueAdapter {
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
    };
  }
}
