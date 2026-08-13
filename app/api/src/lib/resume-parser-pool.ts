/**
 * resume-parser-pool.ts — Bounded in-process scheduler for resume parsing.
 *
 * Replaces unbounded one-child-process-per-call behavior with a bounded pool
 * that controls how many isolated child parsers run concurrently and admits
 * only a bounded queue of waiters. Over-capacity submissions fail fast with a
 * stable sanitized {@link ParserOverloadError}; there is no unbounded memory
 * growth. Each submission's capacity permit is released EXACTLY ONCE under every
 * success/failure/timeout/crash/abort path.
 *
 * This is the foundation for later bulk/async ingestion. The existing
 * synchronous resume route continues to call `parseResume` directly (one
 * document per request, already bounded by HTTP concurrency/rate limits); it is
 * intentionally NOT re-wired here.
 *
 * Instrumentation is metadata-only — counts, depths, and durations. No resume
 * text, contact fields, file bytes, or child output ever passes through a pool
 * event.
 */

import {
  parseResume,
  ParserOverloadError,
  type ParserConfig,
  type ParserResult,
} from './resume-parser.js';

export type ParseFn = (buf: Buffer, mime: string, config?: ParserConfig) => Promise<ParserResult>;

export interface ResumeParserPoolOptions {
  /** Max concurrent child parsers. Default 2, clamped to [1, 8]. */
  maxConcurrency?: number;
  /** Max waiting submissions beyond the running set. Default 50, clamped to [0, 500]. */
  maxQueueDepth?: number;
  /** Injectable single-doc parser (defaults to parseResume). */
  parse?: ParseFn;
  /** Metadata-only lifecycle hook. */
  onEvent?: (event: PoolEvent) => void;
}

export type PoolEventKind = 'submitted' | 'started' | 'completed' | 'failed' | 'rejected';

export interface PoolEvent {
  kind: PoolEventKind;
  active: number;
  queued: number;
  /** Wall-clock ms the task spent queued before starting (started only). */
  queueWaitMs?: number;
  /** Wall-clock ms the task spent executing (completed/failed only). */
  execMs?: number;
}

export interface PoolStats {
  active: number;
  queued: number;
  submitted: number;
  completed: number;
  failed: number;
  rejected: number;
  peakConcurrency: number;
  peakQueueDepth: number;
}

export interface ResumeParserPool {
  /** Submit one document. Rejects fast with ParserOverloadError when full. */
  submit(buf: Buffer, mime: string, config?: ParserConfig): Promise<ParserResult>;
  /** Current snapshot of pool counters. */
  stats(): PoolStats;
  /** Resolve once no work is active or queued. */
  drain(): Promise<void>;
}

const DEFAULT_MAX_CONCURRENCY = 2;
const MAX_CONCURRENCY_CAP = 8;
const DEFAULT_MAX_QUEUE_DEPTH = 50;
const MAX_QUEUE_DEPTH_CAP = 500;

function clampInt(v: number | undefined, def: number, min: number, max: number): number {
  if (typeof v !== 'number' || !Number.isFinite(v) || !Number.isInteger(v)) return def;
  if (v < min) return min;
  if (v > max) return max;
  return v;
}

interface PendingTask {
  buf: Buffer;
  mime: string;
  config?: ParserConfig;
  resolve: (r: ParserResult) => void;
  reject: (e: unknown) => void;
  enqueuedAt: number;
}

export function createResumeParserPool(options: ResumeParserPoolOptions = {}): ResumeParserPool {
  const maxConcurrency = clampInt(options.maxConcurrency, DEFAULT_MAX_CONCURRENCY, 1, MAX_CONCURRENCY_CAP);
  const maxQueueDepth = clampInt(options.maxQueueDepth, DEFAULT_MAX_QUEUE_DEPTH, 0, MAX_QUEUE_DEPTH_CAP);
  const parse = options.parse ?? parseResume;
  const onEvent = options.onEvent;

  const queue: PendingTask[] = [];
  const drainWaiters: Array<() => void> = [];
  let active = 0;
  const counters = { submitted: 0, completed: 0, failed: 0, rejected: 0, peakConcurrency: 0, peakQueueDepth: 0 };

  const emit = (kind: PoolEventKind, extra?: { queueWaitMs?: number; execMs?: number }): void => {
    if (!onEvent) return;
    try {
      onEvent({ kind, active, queued: queue.length, ...extra });
    } catch { /* hooks must never break scheduling */ }
  };

  const flushDrainIfIdle = (): void => {
    if (active === 0 && queue.length === 0 && drainWaiters.length > 0) {
      const waiters = drainWaiters.splice(0, drainWaiters.length);
      for (const w of waiters) w();
    }
  };

  const run = (task: PendingTask): void => {
    active += 1;
    if (active > counters.peakConcurrency) counters.peakConcurrency = active;
    const startedAt = Date.now();
    emit('started', { queueWaitMs: startedAt - task.enqueuedAt });

    let released = false;
    const release = (): void => {
      if (released) return; // release EXACTLY ONCE
      released = true;
      active -= 1;
      pump();
      flushDrainIfIdle();
    };

    // Invoke parse defensively: a synchronous throw must not skip release.
    let promise: Promise<ParserResult>;
    try {
      promise = parse(task.buf, task.mime, task.config);
    } catch (err) {
      promise = Promise.reject(err);
    }
    promise.then(
      (result) => {
        counters.completed += 1;
        emit('completed', { execMs: Date.now() - startedAt });
        release();
        task.resolve(result);
      },
      (err) => {
        counters.failed += 1;
        emit('failed', { execMs: Date.now() - startedAt });
        release();
        task.reject(err);
      },
    );
  };

  const pump = (): void => {
    while (active < maxConcurrency && queue.length > 0) {
      const next = queue.shift() as PendingTask;
      run(next);
    }
  };

  return {
    submit(buf: Buffer, mime: string, config?: ParserConfig): Promise<ParserResult> {
      counters.submitted += 1;
      emit('submitted');
      // Full = all workers busy AND the bounded queue is at capacity.
      if (active >= maxConcurrency && queue.length >= maxQueueDepth) {
        counters.rejected += 1;
        emit('rejected');
        return Promise.reject(new ParserOverloadError());
      }
      return new Promise<ParserResult>((resolve, reject) => {
        const task: PendingTask = { buf, mime, config, resolve, reject, enqueuedAt: Date.now() };
        if (active < maxConcurrency) {
          run(task);
        } else {
          queue.push(task);
          if (queue.length > counters.peakQueueDepth) counters.peakQueueDepth = queue.length;
        }
      });
    },
    stats(): PoolStats {
      return {
        active,
        queued: queue.length,
        submitted: counters.submitted,
        completed: counters.completed,
        failed: counters.failed,
        rejected: counters.rejected,
        peakConcurrency: counters.peakConcurrency,
        peakQueueDepth: counters.peakQueueDepth,
      };
    },
    drain(): Promise<void> {
      if (active === 0 && queue.length === 0) return Promise.resolve();
      return new Promise<void>((resolve) => { drainWaiters.push(resolve); });
    },
  };
}
