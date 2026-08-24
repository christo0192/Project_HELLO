/**
 * lib/phone-runtime/health.ts — the truthful liveness view of THIS process's
 * phone loops.
 *
 * ── WHAT THIS IS NOT ──────────────────────────────────────────────────
 * It is not a backlog. `/api/phone/health` already reads the durable backlog
 * from the database via `phone_backlog`, and that is the multi-machine signal:
 * "this process has no runtime" is not evidence that the fleet has none. This
 * module reports only what a process can honestly know about itself — whether
 * its own loops are armed and ticking — and the route composes the two.
 *
 * ── A STALE LOOP IS MEASURED FROM THE LATER ANCHOR ────────────────────
 * `start()` staggers a loop's first tick by up to one whole interval, so
 * between arming and that first tick a perfectly healthy loop has no
 * `lastTickAt` at all. Liveness is therefore measured from the MOST RECENT of
 * `lastTickAt` and `startedAt`, which is what `isLoopStale` does. Reusing the
 * shared predicate rather than re-deriving it here is deliberate: a second
 * copy of a staleness rule is a second thing to get wrong on a restart.
 *
 * DISCLOSURE BOUNDARY: booleans, bounded integers, ISO timestamps and stable
 * codes. No engagement id, attempt id, session id, candidate field, phone
 * number, digest, room name or provider payload ever appears here.
 */

import { isLoopStale, type SchedulerLoopHealth } from '../scheduler.js';
import type { PhoneRuntimeHandle } from './runtime.js';

/** Missed intervals before a loop is called `stale`. */
export const STALE_TICK_MULTIPLIER = 3;
/** Absolute floor for the staleness window, so a fast poll is not flappy. */
export const MIN_STALE_WINDOW_MS = 30_000;

// ── Process-local runtime registry ───────────────────────────────────────────

let registered: PhoneRuntimeHandle | null = null;

export function registerPhoneRuntime(runtime: PhoneRuntimeHandle): void {
  registered = runtime;
}

export function clearPhoneRuntimeRegistration(): void {
  registered = null;
}

export interface PhoneLoopHealthView {
  name: string;
  running: boolean;
  lastTickAt: string | null;
  ticks: number;
  errors: number;
  consecutiveErrors: number;
  stale: boolean;
}

export interface PhoneRuntimeView {
  /** Whether THIS process has a started runtime. Never a fleet-wide claim. */
  enabled: boolean;
  running: boolean;
  loops: PhoneLoopHealthView[];
  /**
   * The last due pass's counts. Aggregates only — how many were examined,
   * offered and dialled, and which stable skip and refusal codes were seen.
   * Never which engagement, and never why a particular candidate was skipped.
   */
  last_due: {
    status: string;
    examined: number;
    offered: number;
    dialing: number;
    skipped: Record<string, number>;
    refusals: Record<string, number>;
  } | null;
  /**
   * The cadence knobs THIS process resolved and clamped at boot, as integers.
   * Publishable by construction: no identifier, credential, digest or
   * candidate-derived value can appear here.
   */
  config: Record<string, number>;
  /** `phone.dial` job outcomes since this process started. */
  dial_jobs: Record<string, number>;
  last_reclaimed: number | null;
  last_expired: number | null;
  last_reconciled: number | null;
}

function view(
  loop: SchedulerLoopHealth,
  intervalMs: number | undefined,
  now: number,
): PhoneLoopHealthView {
  return {
    name: loop.name,
    running: loop.running,
    lastTickAt: loop.lastTickAt,
    ticks: loop.ticks,
    errors: loop.errors,
    consecutiveErrors: loop.consecutiveErrors,
    stale: isLoopStale(loop, {
      running: loop.running,
      nowMs: now,
      // Three missed intervals, floored so a fast poll is not flappy.
      windowMs: Math.max(MIN_STALE_WINDOW_MS, (intervalMs ?? 0) * STALE_TICK_MULTIPLIER),
    }),
  };
}

/**
 * The process-local view, or the disabled shape when no runtime is registered.
 *
 * `enabled: false` means THIS PROCESS has no runtime — nothing more. The route
 * must not render it as "the phone lane is off", because another machine may
 * be running the loops and the durable backlog is where that question is
 * answered.
 */
export function phoneRuntimeView(now: Date = new Date()): PhoneRuntimeView {
  const runtime = registered;
  if (runtime === null) {
    return {
      enabled: false,
      running: false,
      loops: [],
      last_due: null,
      config: {},
      dial_jobs: {},
      last_reclaimed: null,
      last_expired: null,
      last_reconciled: null,
    };
  }

  const health = runtime.scheduler.health();
  const snapshot = runtime.snapshot();
  const at = now.getTime();

  return {
    enabled: true,
    running: health.running,
    loops: health.loops.map((loop) =>
      view(loop, runtime.loopIntervalsMs[loop.name], at),
    ),
    last_due: snapshot.lastDue === null
      ? null
      : {
        status: snapshot.lastDue.status,
        examined: snapshot.lastDue.examined,
        offered: snapshot.lastDue.offered,
        dialing: snapshot.lastDue.dialing,
        skipped: { ...snapshot.lastDue.skipped },
        refusals: { ...snapshot.lastDue.refusals },
      },
    config: { ...runtime.config },
    dial_jobs: { ...snapshot.dialJobOutcomes },
    last_reclaimed: snapshot.lastReclaimed,
    last_expired: snapshot.lastExpired,
    last_reconciled: snapshot.lastReconciled,
  };
}

/**
 * Degradation reasons contributed by the PROCESS-LOCAL view.
 *
 * A process with no runtime contributes nothing — that is not a fault, it is
 * the shipped default and the normal state of every machine that is not
 * running the loops.
 */
export function phoneRuntimeDegradeReasons(view_: PhoneRuntimeView): string[] {
  if (!view_.enabled) return [];
  const reasons: string[] = [];
  if (!view_.running) reasons.push('phone_runtime_stopped');
  if (view_.loops.some((l) => l.stale)) reasons.push('phone_loop_stale');
  if (view_.loops.some((l) => l.consecutiveErrors > 0)) reasons.push('phone_loop_erroring');
  if (view_.last_due?.status === 'halted') reasons.push('phone_due_halted');
  return reasons;
}
