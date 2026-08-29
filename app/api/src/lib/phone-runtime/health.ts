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

/**
 * Whether `createPhoneRuntime` THREW in this process.
 *
 * ── OFF AND BROKEN MUST NOT LOOK THE SAME ────────────────────────────
 * `index.ts` builds the phone runtime in its own try/catch, and a throw there
 * logs `phone_runtime_start_failed` and leaves `phoneRuntime = null`. ARMING
 * it — `scheduler.start()` then `registerPhoneRuntime` — is guarded too, by
 * `armPhoneRuntime` below, because a runtime that constructs and then fails
 * to arm is just as broken and was just as invisible. The view
 * then reported `enabled: false` with no degrade reason — which is exactly
 * right for the shipped default, where both switches are off and most machines
 * will never construct a runtime, and exactly WRONG on a fleet where the flags
 * ARE on: a replica whose runtime failed to construct reported precisely what
 * a deliberately-disabled replica reports. Health truth is the surface's most
 * important question and that was a false negative on it.
 *
 * So the failure is recorded, and it is a SEPARATE fact from registration:
 * clearing the registration at shutdown does not un-break a construction that
 * threw, and a construction that threw is not undone by another lane starting.
 * A successful registration DOES clear it, because a registered runtime is
 * proof that construction succeeded.
 */
let startFailed = false;

export function registerPhoneRuntime(runtime: PhoneRuntimeHandle): void {
  registered = runtime;
  // A live handle is direct evidence that construction succeeded.
  startFailed = false;
}

export function clearPhoneRuntimeRegistration(): void {
  registered = null;
}

/**
 * Record that starting the phone runtime FAILED in this process — whether it
 * was construction or arming that threw. Called from the composition root,
 * beside the sanitized log line, and nowhere else in production.
 */
export function recordPhoneRuntimeStartFailure(): void {
  startFailed = true;
}

/**
 * ARM the phone runtime: start its scheduler, then publish it to this view.
 *
 * ── WHY THIS IS A FUNCTION AND NOT TWO LINES IN `index.ts` ────────────
 * It used to be two lines in `index.ts`, inside the `server.listen` callback,
 * with no try/catch and no failure record — while CONSTRUCTION three lines
 * earlier had both. That is the M-9 false negative left half-open. If
 * `scheduler.start()` throws (a metric-name collision from the derived loop
 * set, a timer failure), `registerPhoneRuntime` never runs, `startFailed`
 * stays false, and the view reports `enabled: false, start_failed: false` with
 * no degrade reason — indistinguishable from a machine where an operator
 * deliberately left both switches off, on a fleet where the flags are ON. The
 * throw also escapes the listen callback, where nothing catches it.
 *
 * It lives HERE rather than in the composition root because it is the same
 * fact `recordPhoneRuntimeStartFailure` and `registerPhoneRuntime` are about,
 * and because a composition root cannot be unit-tested: `index.ts` opens a
 * socket on import. An arming that can only be proved by grepping the file
 * that performs it is an arming with no test at all — which is exactly what
 * the previous revision had, and it was proved vacuous.
 *
 * ORDER IS LOAD-BEARING: `start()` first, `registerPhoneRuntime` second. A
 * handle published before its scheduler is armed would be reported `enabled`
 * with every loop `running: false`, which reads as a stopped runtime rather
 * than as one that never started.
 *
 * Returns whether the runtime is now armed, so the caller can log. NEVER
 * throws: no lane may prevent the API from serving HTTP.
 */
export function armPhoneRuntime(runtime: PhoneRuntimeHandle): boolean {
  try {
    runtime.scheduler.start();
    registerPhoneRuntime(runtime);
    return true;
  } catch {
    // Nothing partially-armed stays published. `registerPhoneRuntime` is the
    // ONLY writer of `registered`, so on the `start()` throw there is nothing
    // to clear — but a throw from the registration itself must not leave a
    // half-published handle behind, and clearing is free.
    registered = null;
    recordPhoneRuntimeStartFailure();
    return false;
  }
}

/** Clear the recorded construction failure. Test hygiene; never production. */
export function clearPhoneRuntimeStartFailure(): void {
  startFailed = false;
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
  /** 0045. Rolled onto a new IST day by the last day-roll pass. */
  last_rolled: number | null;
  /** 0045. Stranded engagements resolved by the last pass. */
  last_stranded: number | null;
  /** 0071 / X5b. Crashed sessions terminalized so their recordings finalize. */
  last_rec_stranded: number | null;
  /**
   * Names of the sweeps whose last run did NOT answer `ok`. Codes only.
   * Empty is the healthy state; a count of `0` on a sweep NOT named here
   * means "ran, nothing to do", which is a different fact.
   */
  sweeps_not_ok: string[];
  /**
   * Whether STARTING the phone runtime failed in this process —
   * construction or arming. Both are guarded and both record here; an
   * earlier revision guarded only construction, so a scheduler that threw on
   * `start()` reported exactly what a deliberately-disabled replica reports.
   *
   * The one field that distinguishes `enabled: false` because nobody armed
   * the lane from `enabled: false` because arming it failed. A boolean, so it
   * carries nothing about WHY — the reason is in the sanitized startup log,
   * and a health surface is not where a configuration error gets rendered.
   */
  start_failed: boolean;
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
      last_rolled: null,
      last_stranded: null,
      last_rec_stranded: null,
      sweeps_not_ok: [],
      // The ONLY difference between "off" and "broken" on this surface.
      start_failed: startFailed,
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
    last_rolled: snapshot.lastRolled,
    last_stranded: snapshot.lastStranded,
    // 0071 / X5b: crashed sessions terminalized so their recordings finalize.
    last_rec_stranded: snapshot.lastRecStranded,
    sweeps_not_ok: Object.entries(snapshot.sweepNotOk)
      .filter(([, notOk]) => notOk)
      .map(([name]) => name)
      .sort(),
    // A registered runtime constructed successfully by definition.
    start_failed: false,
  };
}

/**
 * Degradation reasons contributed by the PROCESS-LOCAL view.
 *
 * A process with no runtime contributes nothing — that is not a fault, it is
 * the shipped default and the normal state of every machine that is not
 * running the loops. The one exception is a runtime that FAILED to construct:
 * that is a fault, it is invisible in `enabled`, and `start_failed` is the
 * boolean that separates the two.
 */
export function phoneRuntimeDegradeReasons(view_: PhoneRuntimeView): string[] {
  if (!view_.enabled) {
    // A DISABLED process contributes nothing — with one exception. A runtime
    // that threw on construction is not "off", it is broken, and the two were
    // indistinguishable here. The deliberate-disable case stays reason-free,
    // because it is the shipped default and marking every healthy deployment
    // degraded would make the surface useless.
    return view_.start_failed ? ['phone_runtime_start_failed'] : [];
  }
  const reasons: string[] = [];
  if (!view_.running) reasons.push('phone_runtime_stopped');
  if (view_.loops.some((l) => l.stale)) reasons.push('phone_loop_stale');
  if (view_.loops.some((l) => l.consecutiveErrors > 0)) reasons.push('phone_loop_erroring');
  if (view_.last_due?.status === 'halted') reasons.push('phone_due_halted');
  // A sweep that answered non-`ok` is a DEGRADATION, not a quiet zero. Without
  // this the surface reported `status: ok` with `last_reclaimed: 0` while
  // expired attempt leases piled up holding fleet slots.
  if (view_.sweeps_not_ok.length > 0) reasons.push('phone_sweep_not_ok');
  return reasons;
}
