/**
 * lib/worker-orchestration-runtime.ts — the scheduled reaper for on-demand Fly
 * worker orchestration (cost & scale plan §2.5). SCAFFOLDING ONLY, OFF BY
 * DEFAULT.
 *
 * The reaper is the cost-safety backstop for invariant #2 ("never leave a
 * machine `started` without an active session"). This runtime arms a single
 * jittered loop that periodically calls `reapWorkers` for BOTH Fly apps (phone
 * and browser). It is constructed ONLY when `env.workerOrchestration` is true —
 * exactly like `createRecordingRuntime` is gated on the recording flag — so a
 * deploy of this build starts NO timer unless an operator turns the flag on.
 * With the shipped default (`WORKER_ORCHESTRATION=false`) this returns null:
 * no scheduler, no timer, no Fly call, no DB poll.
 *
 * This module is NOT wired into `index.ts` in this change — the plan sequences
 * runtime activation as a later step. It exists so the wiring is a one-line
 * addition when that step lands, and so the gating is testable now.
 */

import {
  createLoopScheduler,
  type LoopSchedulerHandle,
} from './scheduler.js';
import { createLogger } from './logger.js';
import { env } from './env.js';
import {
  createDefaultWorkerOrchestrationService,
  type WorkerOrchestrationService,
} from './worker-orchestration.js';

/** The two Fly apps the reaper sweeps. Independent pools, independent caps. */
export const PHONE_FLY_APP = 'project-hello-phone-voice';
export const BROWSER_FLY_APP = 'project-hello-voice';

/** Reaper cadence (ms). §2.5 says every ~1–2 min; 90s sits in that band. */
const DEFAULT_REAP_INTERVAL_MS = 90_000;

export interface WorkerOrchestrationRuntimeOptions {
  /** Injected service (tests use a fake). Production builds the default. */
  service?: WorkerOrchestrationService;
  /** The Fly apps to sweep. Defaults to [phone, browser]. */
  apps?: readonly string[];
  /** Reap loop interval (ms). Defaults to 90s. */
  reapIntervalMs?: number;
  /** Test seams for the scheduler's timers/jitter/clock. */
  scheduler?: {
    setTimer?: (fn: () => void, ms: number) => { unref?: () => void };
    clearTimer?: (handle: unknown) => void;
    random?: () => number;
    now?: () => number;
  };
  /** Master-gate override. Defaults to `env.workerOrchestration`. */
  enabled?: boolean;
}

export interface WorkerOrchestrationRuntimeHandle {
  scheduler: LoopSchedulerHandle;
  loopIntervalsMs: Record<string, number>;
  /** Drive one reap pass for every app (tests; never used in production). */
  tickAll(): Promise<void>;
  stop(): Promise<void>;
}

/**
 * Build the reaper runtime, or return null when the gate is closed.
 *
 * With the shipped default `WORKER_ORCHESTRATION=false`, nothing is
 * constructed: no scheduler, no timer, no service, no Fly/DB call.
 */
export function createWorkerOrchestrationRuntime(
  options: WorkerOrchestrationRuntimeOptions = {},
): WorkerOrchestrationRuntimeHandle | null {
  const enabled = options.enabled ?? env.workerOrchestration;
  if (!enabled) return null;

  const logger = createLogger('worker-orchestration-runtime');
  const service = options.service ?? createDefaultWorkerOrchestrationService();
  const apps = options.apps ?? [PHONE_FLY_APP, BROWSER_FLY_APP];
  const reapIntervalMs = options.reapIntervalMs ?? DEFAULT_REAP_INTERVAL_MS;

  const reapOnce = async (): Promise<boolean> => {
    let stopped = 0;
    for (const app of apps) {
      try {
        const result = await service.reapWorkers({ app });
        stopped += result.stopped;
      } catch {
        // A sweep failure for one app must not stop the other or the loop.
        logger.warn('unknown_event', {
          error_category: 'worker_orchestration_reap_error',
        });
      }
    }
    // Return true (fast cadence) only when a sweep actually stopped a machine.
    return stopped > 0;
  };

  const scheduler = createLoopScheduler({
    ...(options.scheduler ?? {}),
    metricPrefix: 'worker_orch',
    loops: [
      {
        name: 'worker-orchestration-reap',
        intervalMs: reapIntervalMs,
        tick: reapOnce,
      },
    ],
  });

  return {
    scheduler,
    loopIntervalsMs: { 'worker-orchestration-reap': reapIntervalMs },
    async tickAll(): Promise<void> {
      await reapOnce();
    },
    async stop(): Promise<void> {
      await scheduler.stop();
    },
  };
}
