/**
 * ashby/scheduler.ts — the only owner of recurring Ashby work.
 *
 * The API process has never run a recurring task (the sole `setInterval` in
 * non-test source is a benchmark's RSS sampler). This adds four independent,
 * jittered, single-flight loops:
 *
 *   signal      — claim `ashby.signal` / `ashby.import` / `ashby.ingestion`
 *                 jobs through the generic leased queue runner
 *   operation   — claim `invite_delivery` operations (and ONLY those)
 *   reconcile   — the dropped-webhook safety net, itself DB-single-flighted
 *   reclaim     — return expired-lease queue jobs to pending / DLQ
 *
 * DESIGN CHOICES
 *  - Self-rescheduling `setTimeout`, never `setInterval`: a slow tick can never
 *    stack on itself, and the next delay is computed from the outcome.
 *  - Every timer is jittered so N machines de-synchronise instead of forming a
 *    thundering herd. Correctness across machines comes from the DB leases, not
 *    from assuming how many processes exist — `auto_start_machines` means that
 *    number is not ours to assume.
 *  - Every timer is `.unref()`d so a scheduler alone never holds the process up.
 *  - A throwing tick is caught, counted, and backed off — it never kills a loop.
 *  - `stop()` is idempotent, clears pending timers, and awaits in-flight ticks.
 *
 * Nothing here is constructed when the runtime gates are closed: `index.ts`
 * only builds a scheduler if `createAshbyRuntime` returned non-null.
 */

import { createQueueRunner, nextPollDelayMs, type QueueRunnerHandle, type QueueHandler } from '../../lib/queue/runner.js';
import { counter, gauge } from '../../lib/metrics.js';

export interface SchedulerLoopConfig {
  /** Base delay between ticks (ms). Already clamped by the runtime config. */
  intervalMs: number;
  /**
   * Optional per-tick override of the base delay. A loop whose work has two
   * cadences — reconciliation ticks every 15 minutes at rest, but every few
   * seconds while a multi-run page-anchored sweep is in flight — returns the
   * one that applies right now. Values are clamped by the caller's own config
   * bounds; a non-finite or non-positive return falls back to `intervalMs`.
   */
  intervalMsFor?: () => number;
  /** Run one tick. Resolves true when it did useful work (shortens backoff). */
  tick: () => Promise<boolean>;
  /** Stable loop name for metrics/health. Never a secret. */
  name: string;
}

export interface AshbySchedulerOptions {
  loops: SchedulerLoopConfig[];
  /** Injectable timer seam so tests use fake timers, never real sleeps. */
  setTimer?: (fn: () => void, ms: number) => { unref?: () => void };
  clearTimer?: (handle: unknown) => void;
  /** Injectable jitter in [0,1). */
  random?: () => number;
  /** Injectable clock (ms). */
  now?: () => number;
  onEvent?: (event: { loop: string; kind: 'tick' | 'error' | 'started' | 'stopped'; code?: string }) => void;
}

export interface SchedulerLoopHealth {
  name: string;
  running: boolean;
  /** ISO time of the last completed tick, or null if none yet. */
  lastTickAt: string | null;
  ticks: number;
  errors: number;
  consecutiveErrors: number;
}

export interface AshbySchedulerHandle {
  start(): void;
  stop(): Promise<void>;
  running(): boolean;
  /** Truthful health derived from real tick bookkeeping, not from "imported". */
  health(): { running: boolean; loops: SchedulerLoopHealth[] };
}

/**
 * Build the scheduler. Nothing is armed until `start()`.
 */
export function createAshbyScheduler(options: AshbySchedulerOptions): AshbySchedulerHandle {
  const setTimer = options.setTimer ?? ((fn, ms) => setTimeout(fn, ms));
  const clearTimer = options.clearTimer ?? ((h) => clearTimeout(h as ReturnType<typeof setTimeout>));
  const random = options.random ?? Math.random;
  const now = options.now ?? Date.now;

  let started = false;
  let stopping = false;
  const timers = new Map<string, unknown>();
  const inFlight = new Set<Promise<void>>();
  const state = new Map<string, SchedulerLoopHealth>();
  const idle = new Map<string, number>();

  for (const loop of options.loops) {
    state.set(loop.name, {
      name: loop.name, running: false, lastTickAt: null,
      ticks: 0, errors: 0, consecutiveErrors: 0,
    });
    idle.set(loop.name, 0);
  }

  const emit = (loop: string, kind: 'tick' | 'error' | 'started' | 'stopped', code?: string): void => {
    if (!options.onEvent) return;
    try { options.onEvent({ loop, kind, code }); } catch { /* observers never break the loop */ }
  };

  function schedule(loop: SchedulerLoopConfig, delayMs: number): void {
    if (stopping) return;
    const handle = setTimer(() => {
      // Single-flight: the next tick is only scheduled after this one settles,
      // so a slow tick can never overlap itself.
      const p = runTick(loop).finally(() => { inFlight.delete(p); });
      inFlight.add(p);
    }, delayMs);
    if (handle && typeof handle.unref === 'function') handle.unref();
    timers.set(loop.name, handle);
  }

  async function runTick(loop: SchedulerLoopConfig): Promise<void> {
    if (stopping) return;
    const s = state.get(loop.name)!;
    let didWork = false;
    try {
      didWork = await loop.tick();
      s.consecutiveErrors = 0;
      counter('ashby_scheduler_tick', 1, { loop: loop.name });
    } catch {
      // Sanitized: the error message is deliberately not captured or logged —
      // it can carry provider text. The counters are the signal.
      s.errors += 1;
      s.consecutiveErrors += 1;
      counter('ashby_scheduler_tick_error', 1, { loop: loop.name });
      emit(loop.name, 'error');
    } finally {
      s.ticks += 1;
      s.lastTickAt = new Date(now()).toISOString();
      emit(loop.name, 'tick');
    }

    // Back off when idle or erroring; return to the base cadence on real work.
    const idleCount = didWork && s.consecutiveErrors === 0
      ? 0
      : Math.min((idle.get(loop.name) ?? 0) + 1, 10);
    idle.set(loop.name, idleCount);
    const dynamic = loop.intervalMsFor?.();
    const base = typeof dynamic === 'number' && Number.isFinite(dynamic) && dynamic > 0
      ? dynamic
      : loop.intervalMs;
    const delay = nextPollDelayMs(base, idleCount, random);
    schedule(loop, delay);
  }

  return {
    start(): void {
      if (started) return;
      started = true;
      stopping = false;
      for (const loop of options.loops) {
        const s = state.get(loop.name)!;
        s.running = true;
        // Stagger the first tick so the loops (and multiple machines) do not
        // all fire together on boot.
        schedule(loop, Math.max(1, Math.round(loop.intervalMs * random())));
        emit(loop.name, 'started');
      }
      gauge('ashby_scheduler_running', 1);
    },
    async stop(): Promise<void> {
      if (!started || stopping) {
        stopping = true;
        // Still drain: stop() must be safe to call twice and must not resolve
        // while a tick is in flight.
        while (inFlight.size > 0) await Promise.allSettled([...inFlight]);
        return;
      }
      stopping = true;
      for (const [name, handle] of timers) {
        clearTimer(handle);
        const s = state.get(name);
        if (s) s.running = false;
        emit(name, 'stopped');
      }
      timers.clear();
      while (inFlight.size > 0) {
        await Promise.allSettled([...inFlight]);
      }
      started = false;
      gauge('ashby_scheduler_running', 0);
    },
    running: () => started && !stopping,
    health: () => ({
      running: started && !stopping,
      loops: [...state.values()].map((s) => ({ ...s })),
    }),
  };
}

/**
 * Adapt a {@link QueueRunnerHandle} into a scheduler tick. Returns true when
 * the pass processed at least one job so the loop keeps the fast cadence.
 */
export function queueRunnerTick(runner: QueueRunnerHandle): () => Promise<boolean> {
  return async () => (await runner.tick()) > 0;
}

export type { QueueRunnerHandle, QueueHandler };
export { createQueueRunner };
