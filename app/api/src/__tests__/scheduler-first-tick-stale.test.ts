/**
 * `scheduler_loop_stale` fired on a perfectly healthy scheduler.
 *
 * WHAT WENT WRONG. `start()` marks a loop `running` immediately and then
 * DELIBERATELY staggers its first tick by up to one whole interval, so the
 * loops (and multiple machines) do not all fire together on boot. But
 * `lastTickAt` is only set after the first COMPLETED tick, and the staleness
 * predicate anchored on `lastTickAt` alone — so between arming and that first
 * tick, `lastTickAt` was `null`, `Date.parse` gave `NaN`, and the loop was
 * classified `stale` with no grace at all.
 *
 * For `reconcile` (900 s default) that is up to ~15 minutes of false
 * `degraded` after every deploy and every cold start — and `fly.toml` has
 * `auto_stop_machines`, so the window re-opens routinely. A health channel
 * that is wrong after every restart is a health channel operators learn to
 * ignore, which is how a real degradation arriving in the same window gets
 * missed.
 *
 * WHAT MUST BE TRUE NOW. Liveness is measured from `lastTickAt ?? startedAt`.
 * A loop inside its window since being armed is NOT stale; one that never
 * ticks IS still caught, one window after start rather than instantly.
 *
 * `snapshotScheduler` had no unit test at all before this file — the route
 * tests inject `stale: true` as a literal, exercising `evaluateDegradation`
 * rather than the computation. That absence is part of why the defect
 * survived, so these four cases drive the REAL scheduler through the REAL
 * snapshot with an injected clock and injected timers: no wall-clock sleeps,
 * nothing flaky.
 */

import { describe, it, expect, afterEach } from 'vitest';
import { createLoopScheduler, loopStaleAnchorMs, isLoopStale } from '../lib/scheduler.js';
import {
  registerAshbyScheduler,
  clearAshbySchedulerRegistration,
  snapshotScheduler,
  evaluateDegradation,
  MIN_STALE_WINDOW_MS,
  STALE_TICK_MULTIPLIER,
} from '../integrations/ashby/runtime-health.js';

const T0 = Date.parse('2026-08-22T00:00:00.000Z');
const LOOP = 'reconcile';
/** The shipped `reconcile` cadence: the worst case for the stagger. */
const INTERVAL = 900_000;
const WINDOW = Math.max(MIN_STALE_WINDOW_MS, INTERVAL * STALE_TICK_MULTIPLIER);

/**
 * A scheduler whose clock and timers are fully injected. Timers are captured
 * rather than run, so the first tick happens only when the test says so —
 * which is exactly the state the defect lived in.
 */
function harness() {
  let nowMs = T0;
  const pending: Array<() => void> = [];
  const scheduler = createLoopScheduler({
    loops: [{ name: LOOP, intervalMs: INTERVAL, tick: async () => true }],
    now: () => nowMs,
    random: () => 0.99,                       // near-worst-case stagger
    setTimer: (fn: () => void) => { pending.push(fn); return { unref() {} }; },
    clearTimer: () => { pending.length = 0; },
  } as never);

  registerAshbyScheduler(scheduler as never, { [LOOP]: INTERVAL });

  return {
    scheduler,
    advance: (ms: number) => { nowMs += ms; },
    now: () => nowMs,
    /** Run the single armed timer, i.e. let the first tick actually happen. */
    runPendingTick: async () => {
      const fn = pending.shift();
      if (fn) fn();
      await new Promise((r) => setTimeout(r, 0));
    },
    loop: (at = nowMs) => snapshotScheduler(at).loops.find((l) => l.name === LOOP)!,
  };
}

afterEach(() => { clearAshbySchedulerRegistration(); });

describe('snapshotScheduler — staleness is measured from the first arming, not the first tick', () => {
  it('a loop armed but not yet ticked is NOT stale inside its window (the regression)', () => {
    const h = harness();
    h.scheduler.start();

    // Immediately after arming: the old predicate called this stale.
    expect(h.loop().running).toBe(true);
    expect(h.loop().lastTickAt).toBeNull();
    expect(h.loop().stale).toBe(false);

    // And still not stale most of the way through the window — which spans the
    // entire deliberate stagger.
    h.advance(WINDOW - 1);
    expect(h.loop().stale).toBe(false);
  });

  it('a loop that never ticks IS stale once the window passes', () => {
    const h = harness();
    h.scheduler.start();

    h.advance(WINDOW + 1);
    const l = h.loop();
    expect(l.lastTickAt).toBeNull();
    expect(l.stale).toBe(true);
  });

  it('a loop that has ticked recently is NOT stale', async () => {
    const h = harness();
    h.scheduler.start();
    h.advance(INTERVAL);
    await h.runPendingTick();

    const ticked = h.loop();
    expect(ticked.lastTickAt).not.toBeNull();
    expect(ticked.ticks).toBeGreaterThan(0);
    expect(ticked.stale).toBe(false);

    // ...and goes stale on the ordinary rule once its own window elapses.
    h.advance(WINDOW + 1);
    expect(h.loop().stale).toBe(true);
  });

  it('a stopped loop is never stale — it is stopped', async () => {
    const h = harness();
    h.scheduler.start();
    await h.scheduler.stop();

    h.advance(WINDOW * 10);
    const l = h.loop();
    expect(l.running).toBe(false);
    expect(l.stale).toBe(false);
  });
});

describe('the repair does not weaken the signal it exists to preserve', () => {
  it('a restart re-arms even when the loop TICKED before the stop', async () => {
    // The case a nullish `lastTickAt ?? startedAt` anchor gets wrong, and the
    // reason this test lets a tick land first: `stop()` does not clear
    // `lastTickAt`, so after a restart the loop still holds its pre-stop tick.
    // Anchoring on that stale value reports the freshly re-armed loop stale
    // for exactly the window this grace exists to give it.
    const h = harness();
    h.scheduler.start();
    h.advance(INTERVAL);
    await h.runPendingTick();
    const tickedAt = h.loop().lastTickAt;
    expect(tickedAt).not.toBeNull();            // a real tick really happened

    // Let that tick age well past the window, so the OLD anchor is stale...
    h.advance(WINDOW + 1);
    expect(h.loop().stale).toBe(true);

    // ...then stop and restart. The pre-stop tick is still on the row.
    await h.scheduler.stop();
    h.scheduler.start();
    expect(h.loop().lastTickAt).toBe(tickedAt);  // inherited, as `stop()` leaves it
    expect(h.loop().stale).toBe(false);          // but the re-arm wins

    // ...and the restarted loop can still go stale on its own merits.
    h.advance(WINDOW + 1);
    expect(h.loop().stale).toBe(true);
  });

  it('a restart with NO prior tick also re-arms', async () => {
    const h = harness();
    h.scheduler.start();
    h.advance(WINDOW + 1);
    expect(h.loop().stale).toBe(true);          // never ticked, genuinely dead

    await h.scheduler.stop();
    h.scheduler.start();
    expect(h.loop().lastTickAt).toBeNull();
    expect(h.loop().stale).toBe(false);
  });

  it('feeds `scheduler_loop_stale` exactly as before — no reason vocabulary change', () => {
    const h = harness();
    h.scheduler.start();

    // Every other signal is zeroed, so the scheduler is the ONLY thing that can
    // put a reason in the verdict. That makes both assertions exact rather than
    // "contains among others".
    const quietBacklog = {
      queuePending: 0, dlqDepth: 0, oldestPendingAgeSec: null,
      operationsPending: 0, operationsFailed: 0, operationsAwaitingDelivery: 0,
      writebackPending: 0, operationsBlockedPrerequisite: 0,
      operationsBlockedFailedIngestion: 0, operationsFailedPrerequisite: 0,
      ingestionStuckQueued: 0, ingestionStuckFetching: 0, ingestionFailedParse: 0,
      scannerDeferredJobs: 0, scannerDeferredOldestAgeSec: null,
      reconcileNoProgressRuns: 0, reconcileLastSuccessAt: null,
    };
    const verdict = (at: number) => evaluateDegradation({
      active: true,
      scheduler: snapshotScheduler(at),
      backlog: quietBacklog,
    });

    expect(verdict(h.now()).reasons).toEqual([]);

    h.advance(WINDOW + 1);
    expect(verdict(h.now()).reasons).toEqual(['scheduler_loop_stale']);
  });
});

describe('loopStaleAnchorMs — the anchor is a maximum, not a fallback', () => {
  const A = '2026-08-22T00:00:00.000Z';
  const B = '2026-08-22T01:00:00.000Z';

  it('takes the more recent of the two, whichever it is', () => {
    expect(loopStaleAnchorMs({ lastTickAt: A, startedAt: B })).toBe(Date.parse(B));
    expect(loopStaleAnchorMs({ lastTickAt: B, startedAt: A })).toBe(Date.parse(B));
  });

  it('uses whichever anchor exists when only one does', () => {
    expect(loopStaleAnchorMs({ lastTickAt: A, startedAt: null })).toBe(Date.parse(A));
    expect(loopStaleAnchorMs({ lastTickAt: null, startedAt: A })).toBe(Date.parse(A));
  });

  it('discards an unparseable timestamp instead of poisoning the comparison', () => {
    expect(loopStaleAnchorMs({ lastTickAt: 'not-a-date', startedAt: A })).toBe(Date.parse(A));
    expect(Number.isNaN(loopStaleAnchorMs({ lastTickAt: 'x', startedAt: 'y' }))).toBe(true);
  });

  it('is NaN when neither anchor is usable — callers must read that as stale', () => {
    expect(Number.isNaN(loopStaleAnchorMs({ lastTickAt: null, startedAt: null }))).toBe(true);
    expect(isLoopStale({ lastTickAt: null, startedAt: null },
      { running: true, nowMs: Date.parse(A), windowMs: 1_000 })).toBe(true);
    // ...but a stopped loop is still never stale.
    expect(isLoopStale({ lastTickAt: null, startedAt: null },
      { running: false, nowMs: Date.parse(A), windowMs: 1_000 })).toBe(false);
  });
});

describe('the sanitized health payload is unchanged', () => {
  it('exposes exactly the documented loop fields — `startedAt` stays internal', () => {
    const h = harness();
    h.scheduler.start();

    // OpenAPI pins: [name, running, lastTickAt, ticks, errors, consecutiveErrors, stale]
    expect(Object.keys(h.loop()).sort()).toEqual([
      'consecutiveErrors', 'errors', 'lastTickAt', 'name', 'running', 'stale', 'ticks',
    ]);
    expect(JSON.stringify(h.loop())).not.toContain('startedAt');
  });

  it('reports nothing at all when this process has no scheduler', () => {
    clearAshbySchedulerRegistration();
    const snap = snapshotScheduler(T0);
    expect(snap).toEqual({ registeredInThisProcess: false, running: false, loops: [] });
  });
});
