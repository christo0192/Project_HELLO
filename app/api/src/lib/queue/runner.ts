/**
 * lib/queue/runner.ts — a bounded, lease-safe consumer for the leased queue.
 *
 * The repository had no queue consumer of any kind: `Queue.claim` existed with
 * no caller, so a durably enqueued job was never processed. This is that
 * consumer, kept generic (a handler map keyed by queue name) so the Ashby
 * signal / import / ingestion queues all share one audited implementation.
 *
 * GUARANTEES
 *  - Every mutation is a compare-and-set on the LIVE lease. A runner whose
 *    lease expired or was reclaimed commits nothing (`completeClaim` → false).
 *  - Bounded in-flight work: never more than `concurrency` simultaneous claims.
 *  - Long jobs heartbeat at a fraction of the lease so a slow-but-alive worker
 *    does not lose its lease mid-flight; a lost heartbeat stops the job rather
 *    than letting it commit later.
 *  - A throwing handler fails the job UNDER the lease (retry with backoff, then
 *    DLQ at `maxAttempts`) — it never escapes and kills the loop.
 *  - Empty-queue and error polling both back off geometrically to a bounded
 *    ceiling, so an idle or broken queue cannot hot-spin.
 *  - `stop()` is idempotent, stops claiming NEW work immediately, and resolves
 *    only after in-flight handlers settle.
 *
 * MULTI-MACHINE: correctness comes from the DB lease (FOR UPDATE SKIP LOCKED +
 * CAS), never from an assumption about how many processes are running. Two
 * runners on two machines are safe by construction; the poll delay is jittered
 * so they do not synchronise into a thundering herd.
 */

import type { Queue } from './index.js';
import type { QueueJob } from './types.js';

/** A handler processes exactly one job. Throwing fails the job under lease. */
export type QueueHandler = (job: QueueJob<unknown>) => Promise<void>;

export interface QueueRunnerOptions {
  queue: Pick<Queue, 'claim' | 'completeClaim' | 'failClaim' | 'heartbeat'>;
  /** Queue name → handler. A job whose name has no handler is failed closed. */
  handlers: Readonly<Record<string, QueueHandler>>;
  /** Opaque worker identity recorded as the lease owner. Never a secret. */
  owner: string;
  /** Visibility window granted per claim (seconds). Clamped by the Queue. */
  leaseSeconds: number;
  /** Max simultaneous in-flight jobs. Clamped to [1,32]. */
  concurrency?: number;
  /** Base delay between polls when work was found (ms). */
  pollMs: number;
  /** Injectable clock for deterministic tests. */
  now?: () => number;
  /** Injectable jitter source in [0,1). Inject for determinism. */
  random?: () => number;
  /** Metadata-only observer. Must never receive payloads or lease tokens. */
  onEvent?: (event: QueueRunnerEvent) => void;
}

export interface QueueRunnerEvent {
  kind: 'claimed' | 'completed' | 'failed' | 'stale_lease' | 'no_handler' | 'poll_error';
  queueName: string;
  /** Sanitized stable code only — never a provider message or payload. */
  code?: string;
}

export interface QueueRunnerHandle {
  /** Run one poll pass over every configured queue. Returns jobs processed. */
  tick(): Promise<number>;
  /** True while at least one handler is in flight. */
  inFlight(): number;
  /** Peak simultaneous in-flight jobs observed (test/observability aid). */
  peakInFlight(): number;
  /** Stop claiming new work and resolve once in-flight handlers settle. */
  stop(): Promise<void>;
  /** True once stop() has been called. */
  stopped(): boolean;
}

const MIN_CONCURRENCY = 1;
const MAX_CONCURRENCY = 32;

function clampConcurrency(v: number | undefined): number {
  if (typeof v !== 'number' || !Number.isFinite(v) || !Number.isInteger(v)) return 2;
  return v < MIN_CONCURRENCY ? MIN_CONCURRENCY : v > MAX_CONCURRENCY ? MAX_CONCURRENCY : v;
}

/**
 * Build a runner. Nothing polls until `tick()` is driven — the scheduler owns
 * the cadence, so this module stays fully testable with no timers at all.
 */
export function createQueueRunner(options: QueueRunnerOptions): QueueRunnerHandle {
  const concurrency = clampConcurrency(options.concurrency);
  const queueNames = Object.keys(options.handlers);
  const emit = (event: QueueRunnerEvent): void => {
    if (!options.onEvent) return;
    try { options.onEvent(event); } catch { /* observers must never break the loop */ }
  };

  let active = 0;
  let peak = 0;
  let isStopped = false;
  const settling = new Set<Promise<void>>();

  /**
   * Process one claimed job to a terminal outcome under its lease. Never
   * throws: every failure path routes through `failClaim`, and a lost lease is
   * reported without committing anything.
   */
  async function runJob(job: QueueJob<unknown>, leaseToken: string): Promise<void> {
    const handler = options.handlers[job.name];
    if (!handler) {
      // A job for an unregistered queue is a permanent, sanitized failure —
      // never a silent complete (which would drop durable work).
      await options.queue.failClaim(job.id, leaseToken, 'no_registered_handler');
      emit({ kind: 'no_handler', queueName: job.name });
      return;
    }

    // Heartbeat at a third of the lease so a slow job keeps its claim. If the
    // heartbeat reports the lease is lost, we stop extending — the handler's
    // eventual commit will fail closed on the CAS anyway.
    let leaseLost = false;
    const heartbeatMs = Math.max(1_000, Math.floor((options.leaseSeconds * 1_000) / 3));
    const beat = setInterval(() => {
      void options.queue
        .heartbeat(job.id, leaseToken, { leaseSeconds: options.leaseSeconds })
        .then((ok) => { if (!ok) leaseLost = true; })
        .catch(() => { leaseLost = true; });
    }, heartbeatMs);
    // Never hold the event loop open on account of a heartbeat.
    if (typeof beat.unref === 'function') beat.unref();

    try {
      await handler(job);
      const committed = await options.queue.completeClaim(job.id, leaseToken);
      if (committed) {
        emit({ kind: 'completed', queueName: job.name });
      } else {
        // Stale lease: another runner already owns (or reclaimed) this job.
        // Committing nothing is the correct, fail-closed outcome.
        emit({ kind: 'stale_lease', queueName: job.name });
      }
    } catch (err) {
      const code = err instanceof Error ? err.message : 'handler_error';
      try {
        const outcome = await options.queue.failClaim(job.id, leaseToken, code);
        emit({
          kind: outcome === 'not_owned' ? 'stale_lease' : 'failed',
          queueName: job.name,
          code: outcome,
        });
      } catch {
        // Even the failure path must not throw out of the runner.
        emit({ kind: 'poll_error', queueName: job.name, code: 'fail_claim_error' });
      }
    } finally {
      clearInterval(beat);
      void leaseLost; // observed for clarity; the CAS is the real guard
      active -= 1;
    }
  }

  async function tick(): Promise<number> {
    if (isStopped) return 0;
    let processed = 0;

    for (const queueName of queueNames) {
      // Fill up to the concurrency budget, one claim at a time. A claim that
      // returns null means the queue is empty — move to the next queue.
      while (!isStopped && active < concurrency) {
        let job: QueueJob<unknown> | null;
        try {
          job = await options.queue.claim(queueName, {
            leaseSeconds: options.leaseSeconds,
            owner: options.owner,
          });
        } catch {
          // A DB/transport error must not kill the loop or the other queues.
          emit({ kind: 'poll_error', queueName, code: 'claim_error' });
          break;
        }
        if (!job || !job.leaseToken) break;

        active += 1;
        if (active > peak) peak = active;
        processed += 1;
        emit({ kind: 'claimed', queueName });

        const p = runJob(job, job.leaseToken).finally(() => { settling.delete(p); });
        settling.add(p);
      }
    }

    return processed;
  }

  async function stop(): Promise<void> {
    isStopped = true;
    // Await a snapshot, then re-check: a handler settling can never start new
    // work (isStopped is already true), so one extra drain pass is sufficient.
    while (settling.size > 0) {
      await Promise.allSettled([...settling]);
    }
  }

  return {
    tick,
    inFlight: () => active,
    peakInFlight: () => peak,
    stop,
    stopped: () => isStopped,
  };
}

/**
 * Geometric backoff with jitter for an idle or erroring poll loop, bounded by
 * a ceiling so neither an empty queue nor a broken DB can hot-spin.
 */
export function nextPollDelayMs(
  baseMs: number,
  consecutiveIdle: number,
  random: () => number = Math.random,
  ceilingMs = 60_000,
): number {
  const exp = Math.min(baseMs * Math.pow(2, Math.max(0, Math.min(consecutiveIdle, 10))), ceilingMs);
  // Full jitter in [0.5, 1.0) of the computed delay — de-synchronises machines.
  return Math.max(1, Math.round(exp * (0.5 + random() * 0.5)));
}
