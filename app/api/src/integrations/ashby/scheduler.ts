/**
 * ashby/scheduler.ts — compatibility re-export.
 *
 * The scheduler primitive moved to `lib/scheduler.ts` when a SECOND subsystem
 * (authoritative-recording finalization) needed it. That subsystem must keep
 * converging while the Ashby runtime is paused, so it cannot reach its
 * scheduler through an Ashby import path.
 *
 * This file is deliberately a thin alias rather than a deletion: it keeps the
 * diff reviewable and leaves `ashby-scheduler.test.ts`, `runtime-workers.ts`,
 * and `runtime-health.ts` importing exactly what they imported before. The
 * Ashby default `metricPrefix` is `ashby`, so the emitted metric names are
 * unchanged for this caller.
 */

import { createLoopScheduler, type LoopSchedulerOptions, type LoopSchedulerHandle } from '../../lib/scheduler.js';

export type {
  SchedulerLoopConfig,
  SchedulerLoopHealth,
  QueueRunnerHandle,
  QueueHandler,
} from '../../lib/scheduler.js';
export { queueRunnerTick, createQueueRunner } from '../../lib/scheduler.js';

/** @deprecated Use `createLoopScheduler` from `lib/scheduler.js`. */
export type AshbySchedulerOptions = LoopSchedulerOptions;
/** @deprecated Use `LoopSchedulerHandle` from `lib/scheduler.js`. */
export type AshbySchedulerHandle = LoopSchedulerHandle;

/** @deprecated Use `createLoopScheduler` from `lib/scheduler.js`. */
export const createAshbyScheduler = createLoopScheduler;
export { createLoopScheduler };
