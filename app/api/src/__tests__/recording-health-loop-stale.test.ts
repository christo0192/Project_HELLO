/**
 * The recording health surface is the SECOND consumer of the shared scheduler,
 * and it had drifted from the first in two ways.
 *
 * 1. LEAK. Adding `startedAt` to `SchedulerLoopHealth` changes what BOTH
 *    consumers receive. The Ashby projection destructures it out; this one
 *    built its view with `{ ...loop, stale }`, which spreads the whole object.
 *    TypeScript does not catch that — excess-property checking does not apply
 *    to spread properties — so an undeclared `startedAt` reached a shipped
 *    operator payload whose view type never declared it.
 *
 * 2. TWO RULES, ONE SCHEDULER. This surface still computed staleness from
 *    `lastTickAt` alone, i.e. the exact never-ticked-is-stale defect the Ashby
 *    side was being fixed for. The recording runtime arms FOUR staggered loops,
 *    so all four were falsely stale during their first-tick window.
 *
 * Both now go through the one shared predicate, so the two surfaces cannot
 * answer differently again. These tests pin the documented key set (the leak)
 * and the four staleness cases plus the restart path (the rule).
 */

import { describe, it, expect, afterEach } from 'vitest';
import { createLoopScheduler } from '../lib/scheduler.js';
import {
  registerRecordingRuntime,
  clearRecordingRuntimeRegistration,
  snapshotRecordingWorker,
} from '../lib/recording/health.js';
import {
  MIN_STALE_WINDOW_MS,
  STALE_TICK_MULTIPLIER,
} from '../integrations/ashby/runtime-health.js';

const T0 = Date.parse('2026-08-22T00:00:00.000Z');
const LOOP = 'recording-sweep';
const INTERVAL = 300_000;
const WINDOW = Math.max(MIN_STALE_WINDOW_MS, INTERVAL * STALE_TICK_MULTIPLIER);

/** Real scheduler, injected clock and injected timers — nothing wall-clock. */
function harness() {
  let nowMs = T0;
  const pending: Array<() => void> = [];
  const scheduler = createLoopScheduler({
    loops: [{ name: LOOP, intervalMs: INTERVAL, tick: async () => true }],
    now: () => nowMs,
    random: () => 0.99,
    setTimer: (fn: () => void) => { pending.push(fn); return { unref() {} }; },
    clearTimer: () => { pending.length = 0; },
  } as never);

  // Only the two fields `snapshotRecordingWorker` reads.
  registerRecordingRuntime({
    scheduler,
    loopIntervalsMs: { [LOOP]: INTERVAL },
  } as never);

  return {
    scheduler,
    advance: (ms: number) => { nowMs += ms; },
    runPendingTick: async () => {
      const fn = pending.shift();
      if (fn) fn();
      await new Promise((r) => setTimeout(r, 0));
    },
    loop: () => snapshotRecordingWorker(nowMs).loops.find((l) => l.name === LOOP)!,
  };
}

afterEach(() => { clearRecordingRuntimeRegistration(); });

// ═══════════════════════════════════════════════════════════════════════
// 1. The leak — the documented response keys, and nothing else
// ═══════════════════════════════════════════════════════════════════════

describe('recording worker health — the payload carries exactly its documented keys', () => {
  it('does not leak the scheduler\'s internal `startedAt`', () => {
    const h = harness();
    h.scheduler.start();

    expect(Object.keys(h.loop()).sort()).toEqual([
      'consecutiveErrors', 'errors', 'lastTickAt', 'name', 'running', 'stale', 'ticks',
    ]);
    // Serialized too — a key present but undefined would still be a change.
    expect(JSON.stringify(h.loop())).not.toContain('startedAt');
    expect('startedAt' in h.loop()).toBe(false);
  });

  it('reports nothing at all when this process has no recording runtime', () => {
    clearRecordingRuntimeRegistration();
    expect(snapshotRecordingWorker(T0)).toEqual({ enabled: false, running: false, loops: [] });
  });
});

// ═══════════════════════════════════════════════════════════════════════
// 2. The rule — identical to the Ashby surface, because it is the same one
// ═══════════════════════════════════════════════════════════════════════

describe('recording worker health — first-tick grace', () => {
  it('a loop armed but not yet ticked is NOT stale inside its window', () => {
    const h = harness();
    h.scheduler.start();

    expect(h.loop().running).toBe(true);
    expect(h.loop().lastTickAt).toBeNull();
    expect(h.loop().stale).toBe(false);

    h.advance(WINDOW - 1);
    expect(h.loop().stale).toBe(false);
  });

  it('a loop that never ticks IS stale once the window passes', () => {
    const h = harness();
    h.scheduler.start();
    h.advance(WINDOW + 1);
    expect(h.loop().stale).toBe(true);
  });

  it('a loop that has ticked recently is NOT stale, and goes stale afterwards', async () => {
    const h = harness();
    h.scheduler.start();
    h.advance(INTERVAL);
    await h.runPendingTick();

    expect(h.loop().lastTickAt).not.toBeNull();
    expect(h.loop().stale).toBe(false);

    h.advance(WINDOW + 1);
    expect(h.loop().stale).toBe(true);
  });

  it('a stopped loop is never stale — it is stopped', async () => {
    const h = harness();
    h.scheduler.start();
    await h.scheduler.stop();

    h.advance(WINDOW * 10);
    expect(h.loop().running).toBe(false);
    expect(h.loop().stale).toBe(false);
  });

  it('a restart re-arms even when the loop TICKED before the stop', async () => {
    const h = harness();
    h.scheduler.start();
    h.advance(INTERVAL);
    await h.runPendingTick();
    const tickedAt = h.loop().lastTickAt;
    expect(tickedAt).not.toBeNull();

    h.advance(WINDOW + 1);
    expect(h.loop().stale).toBe(true);

    await h.scheduler.stop();
    h.scheduler.start();
    expect(h.loop().lastTickAt).toBe(tickedAt);   // `stop()` leaves it behind
    expect(h.loop().stale).toBe(false);           // the re-arm still wins
  });
});
