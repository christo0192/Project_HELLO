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
 * WIRED into `index.ts` startup (gated on `env.workerOrchestration`, stopped on
 * shutdown, mirroring the recording runtime). With the shipped flag off,
 * construction returns null and nothing is started.
 *
 * It runs TWO loops: a PROMPT terminal-release pass (fast cadence — returns a
 * finished call's pool slot in seconds by releasing every machine whose bound
 * session is already terminal) and the REAPER (slower — the correctness
 * backstop that stops any machine whose LiveKit room is dead past the grace
 * window, catching anything the prompt path missed).
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
// NOTE: browser-orchestration.ts imports BROWSER_FLY_APP from THIS module, so
// this is an import cycle. It is benign: both modules only read the other's
// bindings inside function bodies (never at module evaluation), so whichever
// module loads first, every binding is initialised before it is called.
import { createBrowserWorkerOrchestrationService } from './browser-orchestration.js';

/** The two Fly apps the reaper sweeps. Independent pools, independent caps. */
export const PHONE_FLY_APP = 'project-hello-phone-voice';
export const BROWSER_FLY_APP = 'project-hello-voice';

/** Reaper cadence (ms). §2.5 says every ~1–2 min; 90s sits in that band. */
const DEFAULT_REAP_INTERVAL_MS = 90_000;

/**
 * Prompt-release cadence (ms). Runs FASTER than the reaper because it is the
 * cost-optimisation path: a call that just ended should return its pool slot in
 * seconds, not one 90s reaper window. It only touches sessions already TERMINAL
 * (a bounded, cheap indexed read + one release each), so a tight cadence is
 * safe. The reaper stays the correctness backstop for anything this misses.
 */
const DEFAULT_TERMINAL_RELEASE_INTERVAL_MS = 15_000;

export interface WorkerOrchestrationRuntimeOptions {
  /**
   * Injected service applied to EVERY app (tests use a fake). When set it wins
   * over `services` and over the per-app production defaults, so a single fake
   * still observes both apps exactly as before M009.
   */
  service?: WorkerOrchestrationService;
  /**
   * M009 E2: per-app services keyed by Fly app name. Defaults to
   * `{ [PHONE_FLY_APP]: phone service (room 'phone-<id>'), [BROWSER_FLY_APP]:
   * browser service (room 'screening-<id>') }`. An app in `apps` with no entry
   * here is SKIPPED (logged), never swept with another pipeline's room naming.
   */
  services?: Readonly<Record<string, WorkerOrchestrationService>>;
  /** The Fly apps to sweep. Defaults to [phone, browser]. */
  apps?: readonly string[];
  /** Reap loop interval (ms). Defaults to 90s. */
  reapIntervalMs?: number;
  /** Prompt terminal-release loop interval (ms). Defaults to 15s. */
  terminalReleaseIntervalMs?: number;
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
  // ── ONE ORCHESTRATION SERVICE PER APP (M009 E2) ─────────────────────────
  // The reaper proves a claimed machine's work is live by asking LiveKit about
  // the session's ROOM, and the room name is pipeline-specific: phone rooms are
  // 'phone-<sessionId>', browser rooms 'screening-<sessionId>'. This used to
  // build ONE phone-named service and sweep BOTH apps with it, so a browser
  // lease was probed at 'phone-<browserSessionId>' — a room that never exists.
  // not_found is (correctly) read as dead, so a LIVE browser interview's
  // machine was eligible to be stopped. Each app now gets the service built
  // with its own room scheme. The reap rules themselves (list_* RPCs,
  // not_found-is-dead, grace, orphan sweep) are unchanged; only WHICH room is
  // asked about changes, and only for the browser app.
  //
  // `options.service` (a test fake) still overrides every app, so pre-M009
  // callers keep their exact behaviour. The defaults are built only when no
  // override covers them, so a test that injects services never constructs the
  // production clients.
  const services: Readonly<Record<string, WorkerOrchestrationService>> =
    options.service !== undefined
      ? {}
      : options.services ?? {
          [PHONE_FLY_APP]: createDefaultWorkerOrchestrationService(),
          [BROWSER_FLY_APP]: createBrowserWorkerOrchestrationService(),
        };
  const serviceFor = (app: string): WorkerOrchestrationService | null =>
    options.service ??
    (Object.prototype.hasOwnProperty.call(services, app) ? services[app] : null);
  const apps = options.apps ?? [PHONE_FLY_APP, BROWSER_FLY_APP];
  const reapIntervalMs = options.reapIntervalMs ?? DEFAULT_REAP_INTERVAL_MS;
  const terminalReleaseIntervalMs =
    options.terminalReleaseIntervalMs ?? DEFAULT_TERMINAL_RELEASE_INTERVAL_MS;

  const reapOnce = async (): Promise<boolean> => {
    let stopped = 0;
    for (const app of apps) {
      const service = serviceFor(app);
      if (service === null) {
        // Fail closed: an app with no service of its own is not swept at all,
        // rather than swept with another pipeline's room naming (which would
        // read every live room as not_found → dead → stop).
        logger.warn('unknown_event', {
          error_category: 'worker_orchestration_no_service_for_app',
        });
        continue;
      }
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

  // The prompt-release pass (§2 I2, cost path): release every machine whose
  // bound session is already terminal, for BOTH apps. It is the primary
  // terminal-release path — the reaper's LiveKit-liveness sweep is the backstop
  // for anything it cannot reach (a deleted session row, a room the terminal
  // write raced). Failing for one app never stops the other or the loop.
  const releaseTerminalOnce = async (): Promise<boolean> => {
    let released = 0;
    for (const app of apps) {
      const service = serviceFor(app);
      if (service === null) {
        logger.warn('unknown_event', {
          error_category: 'worker_orchestration_no_service_for_app',
        });
        continue;
      }
      try {
        const result = await service.releaseTerminalSessions({ app });
        released += result.released;
      } catch {
        logger.warn('unknown_event', {
          error_category: 'worker_orchestration_terminal_release_error',
        });
      }
    }
    return released > 0;
  };

  const scheduler = createLoopScheduler({
    ...(options.scheduler ?? {}),
    metricPrefix: 'worker_orch',
    loops: [
      {
        name: 'worker-orchestration-terminal-release',
        intervalMs: terminalReleaseIntervalMs,
        tick: releaseTerminalOnce,
      },
      {
        name: 'worker-orchestration-reap',
        intervalMs: reapIntervalMs,
        tick: reapOnce,
      },
    ],
  });

  return {
    scheduler,
    loopIntervalsMs: {
      'worker-orchestration-terminal-release': terminalReleaseIntervalMs,
      'worker-orchestration-reap': reapIntervalMs,
    },
    async tickAll(): Promise<void> {
      // Release first, then reap: a terminal session released this tick should
      // not also be reaped this tick (the release already stopped it).
      await releaseTerminalOnce();
      await reapOnce();
    },
    async stop(): Promise<void> {
      await scheduler.stop();
    },
  };
}
